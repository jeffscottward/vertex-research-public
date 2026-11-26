import type { FlowRepository } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { FlowSymbol } from "../contracts/flow.ts";
import type {
  GreekHeatmapOutput,
  GreekHeatmapParsedInput,
  OptionsAnalyticsOutput,
  OptionsAnalyticsParsedInput,
} from "../contracts/options-analytics.ts";
import { FLOW_INSTRUMENTS } from "../flow-features.ts";
import type { ApiContext } from "./context.ts";
import { optionsSessionRange } from "./flow-control.ts";
import { unreadOf } from "./flow-hedging-pressure.ts";
import {
  buildSourceFreshness,
  flowSessionDate,
  flowStaleSeconds,
} from "./flow-snapshot.ts";
import { buildGexContext, newYorkDate } from "./gex-context.ts";
import {
  buildGreekHeatmap,
  parseHeatMapCounts,
} from "./greek-heatmap-engine.ts";
import { requireOperator } from "./operator-access.ts";
import {
  exposure,
  ivSurface,
  pageProfileFlow,
  parseChain,
  parseFlow,
  parseOpenInterest,
  type StrikeProfileFlowInput,
  skew,
  strikeProfiles,
  summarizeFlow,
  termStructure,
  withProfileFlow,
} from "./options-analytics-engine.ts";
import {
  createQuantDataClient,
  type QuantDataClient,
  type QuantDataClientOptions,
  type QuantDataConfig,
  type QuantDataResult,
} from "./quantdata-client.ts";

// Read-only options analytics (optionsAnalytics.snapshot). Three QuantData requests per
// uncached call: term-structure (IV chain + spot), open-interest-by-strike and
// order-flow/consolidated. Each section reports its own status; one failed request does
// not hide the others. `context` (gex-context.ts) restates the caveats of the GEX number.
// For the option tickers the flow collector stores (flow_option_prints), the procedure reads
// the stored prints of the window for the strike profiles. Nothing here can place, change or
// cancel orders.

const CHAIN_TTL_MS = 300_000;
const FLOW_TTL_MS = 60_000;

const OPTIONS_ANALYTICS_NOTES = [
  "IV values are QuantData option-chain IVs; historical IV rank is not in the payload.",
  "Open interest is aggregated across expiries and can reflect the previous session.",
  "Estimated GEX = aggregate OI x Black-Scholes gamma (front-expiry IV), dollars per 1% move; assumes dealers long calls and short puts.",
  "Max pain uses aggregate OI and is a proxy, not expiry-specific.",
  "Research only. Do not choose contracts from this snapshot alone.",
] as const;

type Deps = Readonly<{ now: () => Date; client: QuantDataClient }>;

/** The order-flow window: `flowHours` up to `now` rounded down to the minute. */
export const flowWindow = (
  flowHours: number,
  now: Date
): Readonly<{ start: Date; end: Date }> => {
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return { end, start: new Date(end.getTime() - flowHours * 3_600_000) };
};

/**
 * The QuantData requests of one symbol. optionsAnalytics.snapshot and the options chain
 * (options-chain-quantdata.ts) both build them here, so the payloads, TTLs and cache keys are
 * the same: the two read one cached answer and spend the provider quota once.
 */
export const quantDataRequests = (
  client: QuantDataClient,
  symbol: string,
  flowHours: number,
  now: Date
) => {
  const filter = { filter: { ticker: symbol } };
  const { start, end } = flowWindow(flowHours, now);
  return {
    openInterest: () => client.request("openInterest", filter, CHAIN_TTL_MS),
    // Keyed by symbol and window (not the minute-rounded range): at most one flow call per
    // symbol and window every 60 s.
    orderFlow: () =>
      client.request(
        "orderFlow",
        {
          ...filter,
          timeRange: {
            endTime: end.toISOString(),
            startTime: start.toISOString(),
          },
        },
        FLOW_TTL_MS,
        `${symbol} ${flowHours}h`
      ),
    termStructure: () => client.request("termStructure", filter, CHAIN_TTL_MS),
  };
};

/** The underlying price of a term-structure answer; null when it failed or has none. */
export const quantDataStockPrice = (result: QuantDataResult): number | null => {
  const raw = result.ok ? result.body["stockPrice"] : undefined;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : null;
};

export const buildOptionsAnalytics = async (
  input: OptionsAnalyticsParsedInput,
  deps: Deps
): Promise<OptionsAnalyticsOutput> => {
  const now = deps.now();
  // Expiry math follows the New York market day, not the UTC date.
  const today = newYorkDate(now);
  const { symbol, flowHours } = input;
  const requests = quantDataRequests(deps.client, symbol, flowHours, now);
  const chainResult = await requests.termStructure();
  const oiResult = await requests.openInterest();
  const flowResult = await requests.orderFlow();

  const spot = quantDataStockPrice(chainResult);
  const chain = chainResult.ok
    ? parseChain(chainResult.data, today)
    : { expired: 0, rows: [] };
  const oiRows = oiResult.ok ? parseOpenInterest(oiResult.data) : [];

  const term = termStructure(chain.rows, spot, today);
  const skewPoints = skew(chain.rows);
  const surface = ivSurface(chain.rows, spot, today);
  const volatilityOk =
    term.length > 0 || skewPoints.length > 0 || surface.rows.length > 0;
  const volatility: OptionsAnalyticsOutput["volatility"] = {
    message: chainResult.ok
      ? volatilityOk
        ? null
        : "QuantData returned no unexpired contracts with IV for this symbol."
      : chainResult.message,
    skew: skewPoints,
    status: chainResult.ok ? (volatilityOk ? "ok" : "empty") : "unavailable",
    surface,
    termStructure: term,
  };

  const estimate = exposure(oiRows, chain.rows, spot, today);
  const exposureData = estimate.section;
  const exposureSection: OptionsAnalyticsOutput["exposure"] = {
    ...exposureData,
    message: oiResult.ok
      ? exposureData.strikes.length === 0
        ? "QuantData returned no strike open interest for this symbol."
        : exposureData.totalGex === null
          ? "Open interest shown; GEX needs option-chain IV and a spot price."
          : null
      : oiResult.message,
    status: oiResult.ok
      ? exposureData.strikes.length === 0
        ? "empty"
        : "ok"
      : "unavailable",
  };

  const events = flowResult.ok ? parseFlow(flowResult.data, symbol) : [];
  const flowSummary = summarizeFlow(events);
  const flowPartial =
    flowResult.ok && Array.isArray(flowResult.body["nextSearchAfter"]);
  const morePages = flowPartial
    ? ` First provider page only (${events.length} trades).`
    : "";
  const flow: OptionsAnalyticsOutput["flow"] = {
    ...flowSummary,
    hours: flowHours,
    message: flowResult.ok
      ? events.length === 0
        ? `No QuantData option-flow trades in the last ${flowHours} h.`
        : morePages === ""
          ? null
          : morePages.trim()
      : flowResult.message,
    status: flowResult.ok
      ? events.length === 0
        ? "empty"
        : "ok"
      : "unavailable",
  };

  const results = [chainResult, oiResult, flowResult];
  const rateLimited = results.some(
    (result) => !result.ok && result.reason === "rate_limited"
  );
  // The longest wait: provider cooldown or any refusal (a local budget sets no cooldown).
  const wait = Math.max(
    deps.client.cooldownSeconds(),
    ...results.map((result) =>
      result.ok ? 0 : (result.retryAfterSeconds ?? 0)
    )
  );
  // The oldest fetch behind the GEX numbers (chain and OI); null when either is missing.
  const fetchTimes = [chainResult, oiResult].map((result) =>
    result.ok ? result.fetchedAt : undefined
  );
  const fetchedAt = fetchTimes.every(
    (time): time is number => time !== undefined
  )
    ? Math.min(...fetchTimes)
    : null;
  const context = buildGexContext({
    chain: chain.rows,
    events,
    fetchedAt,
    flowHours,
    flowOk: flowResult.ok,
    flowPartial,
    now,
    spot,
    strikes: estimate.strikes,
    term,
    totalGex: exposureSection.totalGex,
  });
  const notes: string[] = [...OPTIONS_ANALYTICS_NOTES];
  if (chain.expired > 0)
    notes.push(`Excluded ${chain.expired} expired expiries from the IV views.`);
  return {
    context,
    exposure: exposureSection,
    flow,
    notes,
    rateLimited,
    receivedAt: now.toISOString(),
    retryAfterSeconds: rateLimited ? Math.ceil(wait) : null,
    source: "quantdata",
    spot,
    strikeProfiles: strikeProfiles({
      flow: pageProfileFlow(events, today, flowPartial),
      maxPainStrike: exposureSection.maxPain,
      oiRows,
      spot,
    }),
    symbol,
    volatility,
  };
};

// A heat-map answer that cannot be used; null for a usable or a "no data" answer.
const heatMapFailure = (result: QuantDataResult): string | null => {
  // HTTP 422 is QuantData's "data-unavailable": an answer without rows, so the metric is empty.
  if (!result.ok) return result.httpStatus === 422 ? null : result.message;
  const kind = result.body["type"];
  if (kind !== undefined && kind !== "contract")
    return "QuantData heatMap: unexpected response type.";
  return null;
};

/**
 * Strike-by-expiry Greek exposure heatmap (optionsAnalytics.greekHeatmap).
 * Reuses the cached term-structure request and adds two QuantData heat-map calls
 * (NET_OPEN_INTEREST and NET_VOLUME). Research only.
 * Budget: the portal asks for the heatmap after the snapshot answered, so an uncached symbol
 * costs 3 snapshot starts + 2 heat-map starts = 5, inside FLOW_QUANTDATA_CALLER_RESERVE (6).
 */
export const buildOptionsGreekHeatmap = async (
  input: GreekHeatmapParsedInput,
  deps: Deps
): Promise<GreekHeatmapOutput> => {
  const now = deps.now();
  const today = newYorkDate(now);
  const { symbol } = input;
  const filter = { filter: { ticker: symbol } };
  const chainResult = await deps.client.request(
    "termStructure",
    filter,
    CHAIN_TTL_MS
  );
  const spot = quantDataStockPrice(chainResult);
  const chainRows = chainResult.ok
    ? parseChain(chainResult.data, today).rows
    : [];
  const needsHeatMap =
    chainResult.ok && spot !== null && spot > 0 && chainRows.length > 0;
  const oiResult = needsHeatMap
    ? await deps.client.request(
        "heatMap",
        { ...filter, dataMode: "NET_OPEN_INTEREST" },
        CHAIN_TTL_MS
      )
    : null;
  const volumeResult = needsHeatMap
    ? await deps.client.request(
        "heatMap",
        { ...filter, dataMode: "NET_VOLUME" },
        FLOW_TTL_MS
      )
    : null;

  const results = [chainResult, oiResult, volumeResult].filter(
    (result): result is QuantDataResult => result !== null
  );
  const rateLimited = results.some(
    (result) => !result.ok && result.reason === "rate_limited"
  );
  const wait = Math.max(
    deps.client.cooldownSeconds(),
    ...results.map((result) =>
      result.ok ? 0 : (result.retryAfterSeconds ?? 0)
    )
  );
  const oiFailure = oiResult === null ? null : heatMapFailure(oiResult);
  const volumeFailure =
    volumeResult === null ? null : heatMapFailure(volumeResult);

  return buildGreekHeatmap({
    chainFailure: chainResult.ok ? null : chainResult.message,
    chainRows,
    oiCounts:
      oiResult?.ok && oiFailure === null
        ? parseHeatMapCounts(oiResult.data, today)
        : [],
    oiFailure,
    rateLimited,
    receivedAt: now.toISOString(),
    retryAfterSeconds: rateLimited ? Math.ceil(wait) : null,
    spot,
    symbol,
    today,
    volumeCounts:
      volumeResult?.ok && volumeFailure === null
        ? parseHeatMapCounts(volumeResult.data, today)
        : [],
    volumeFailure,
  });
};

/** The flow instrument whose collector stores the option prints of `ticker`; null when none does. */
export const storedPrintsSymbol = (ticker: string): FlowSymbol | null =>
  Object.values(FLOW_INSTRUMENTS).find(
    (instrument) =>
      instrument.optionsTicker === ticker &&
      instrument.sources.includes("options")
  )?.symbol ?? null;

/**
 * True when the collector's options source covers the window up to its end: it runs now
 * (fresh), or, outside the session, its last good run reached the close of the newest options
 * session that overlaps the window (an outage late in a session leaves no gap row until the next
 * session). A window with no session in it needs no run.
 */
const collectorCaughtUp = (
  freshness: Readonly<{ state: string; lastOkAt: string | null }>,
  symbol: FlowSymbol,
  start: Date,
  end: Date
): boolean => {
  if (freshness.state === "fresh") return true;
  if (freshness.state !== "closed") return false;
  const close = optionsSessionRange(flowSessionDate(end)).to.getTime();
  if (close <= start.getTime()) return true;
  return (
    freshness.lastOkAt !== null &&
    Date.parse(freshness.lastOkAt) >=
      close - flowStaleSeconds("options", symbol) * 1000
  );
};

/**
 * Profile flow from every stored print of the window (flow_option_prints), with the same print
 * filter as the page (strike above 0 and expiry from `today` on; the table holds no negative
 * premium). Complete when no recorded collector gap overlaps the window and the collector caught
 * up to the window's end (`collectorCaughtUp`).
 */
export const storedProfileFlow = async (
  repository: Pick<
    FlowRepository,
    "readOptionStrikeTotals" | "optionGaps" | "latestSamples"
  >,
  query: Readonly<{
    symbol: FlowSymbol;
    start: Date;
    end: Date;
    today: string;
    now: Date;
  }>
): Promise<StrikeProfileFlowInput> => {
  const { symbol, start, end, today, now } = query;
  const [totals, gaps, samples] = await Promise.all([
    repository.readOptionStrikeTotals({
      from: start,
      minExpiry: today,
      symbol,
      to: end,
    }),
    repository.optionGaps(symbol),
    repository.latestSamples(symbol, ["options"]),
  ]);
  const freshness = buildSourceFreshness(
    { ...samples, now, symbol },
    "options"
  );
  const oldest = Math.min(...totals.map((row) => row.oldestAt.getTime()));
  const newest = Math.max(...totals.map((row) => row.newestAt.getTime()));
  return {
    complete:
      unreadOf(gaps, start, end) === null &&
      collectorCaughtUp(freshness, symbol, start, end),
    groups: totals.map((row) => ({
      contracts: row.contracts,
      premium: row.premium,
      right: row.right,
      sentiment: row.sentiment,
      strike: row.strike,
      trades: row.trades,
    })),
    newestTradeAt: totals.length === 0 ? null : new Date(newest).toISOString(),
    oldestTradeAt: totals.length === 0 ? null : new Date(oldest).toISOString(),
    source: "stored_prints",
  };
};

// One client per configuration so the rate limit, cooldown and cache are shared by requests.
let cachedClient: { config: QuantDataConfig; client: QuantDataClient } | null =
  null;
let clientOptions: QuantDataClientOptions = {};
const systemClock = (): Date => new Date();
let clock: () => Date = systemClock;

export const setOptionsAnalyticsForTesting = (
  options: QuantDataClientOptions,
  now?: () => Date
): void => {
  clientOptions = options;
  cachedClient = null;
  clock = now ?? systemClock;
};

/** One shared client per configuration (rate limit, cooldown and cache), also used by flow.collect. */
export const quantDataClientFor = (
  config: QuantDataConfig
): QuantDataClient => {
  if (
    cachedClient === null ||
    cachedClient.config.apiKey !== config.apiKey ||
    cachedClient.config.baseUrl !== config.baseUrl
  )
    cachedClient = {
      client: createQuantDataClient(config, clientOptions),
      config,
    };
  return cachedClient.client;
};

// The stored-prints read of the strike profiles failed. Reporting never fails the request.
const reportStoredReadFailure = async (
  context: ApiContext,
  symbol: string
): Promise<void> => {
  if (context.semanticEvents === undefined) return;
  try {
    await context.semanticEvents.emit({
      action: "snapshot",
      attributes: { step: "strike_profiles_stored_read", symbol },
      correlation: {
        procedure: "optionsAnalytics.snapshot",
        requestId: context.requestId,
      },
      entityType: "options-analytics",
      errorCategory: "storage-error",
      eventId: crypto.randomUUID(),
      name: "vertex.optionsAnalytics.strikeProfilesStoredRead",
      occurredAt: new Date().toISOString(),
      outcome: "failure",
      source: "api",
    });
  } catch {
    // Reporting never fails the request.
  }
};

const api = implement(appContract).$context<ApiContext>();

const snapshot = api.optionsAnalytics.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const config = context.quantData ?? null;
    if (config === null) throw errors.NOT_CONFIGURED();
    const now = clock();
    const output = await buildOptionsAnalytics(input, {
      client: quantDataClientFor(config),
      now: () => now,
    });
    const symbol = storedPrintsSymbol(input.symbol);
    const repository = context.repositories.flow;
    if (symbol === null || repository === undefined) return output;
    try {
      const flow = await storedProfileFlow(repository, {
        ...flowWindow(input.flowHours, now),
        now,
        symbol,
        today: newYorkDate(now),
      });
      return {
        ...output,
        strikeProfiles: withProfileFlow(output.strikeProfiles.strikes, flow),
      };
    } catch {
      // The profiles keep the page prints; their coverage line names that source.
      await reportStoredReadFailure(context, input.symbol);
      return output;
    }
  });
const greekHeatmap = api.optionsAnalytics.greekHeatmap
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const config = context.quantData ?? null;
    if (config === null) throw errors.NOT_CONFIGURED();
    return await buildOptionsGreekHeatmap(input, {
      client: quantDataClientFor(config),
      now: clock,
    });
  });

export const optionsAnalyticsRouter = { greekHeatmap, snapshot };
