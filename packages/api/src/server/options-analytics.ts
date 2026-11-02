import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  OptionsAnalyticsOutput,
  OptionsAnalyticsParsedInput,
} from "../contracts/options-analytics.ts";
import type { ApiContext } from "./context.ts";
import {
  exposure,
  ivSurface,
  parseChain,
  parseFlow,
  parseOpenInterest,
  skew,
  summarizeFlow,
  termStructure,
} from "./options-analytics-engine.ts";
import { requireOperator } from "./operator-access.ts";
import {
  createQuantDataClient,
  type QuantDataClient,
  type QuantDataClientOptions,
  type QuantDataConfig,
} from "./quantdata-client.ts";

// Read-only options analytics (optionsAnalytics.snapshot). Three QuantData requests per
// uncached call: term-structure (IV chain + spot), open-interest-by-strike and
// order-flow/consolidated. Each section reports its own status; one failed request does
// not hide the others. Nothing here can place, change or cancel orders.

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

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

export const buildOptionsAnalytics = async (
  input: OptionsAnalyticsParsedInput,
  deps: Deps
): Promise<OptionsAnalyticsOutput> => {
  const now = deps.now();
  const today = isoDay(now);
  const { symbol, flowHours } = input;
  const filter = { filter: { ticker: symbol } };
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const start = new Date(end.getTime() - flowHours * 3_600_000);
  const chainResult = await deps.client.request(
    "termStructure",
    filter,
    CHAIN_TTL_MS
  );
  const oiResult = await deps.client.request(
    "openInterest",
    filter,
    CHAIN_TTL_MS
  );
  const flowResult = await deps.client.request(
    "orderFlow",
    {
      ...filter,
      timeRange: { endTime: end.toISOString(), startTime: start.toISOString() },
    },
    FLOW_TTL_MS
  );

  const spotRaw = chainResult.ok ? chainResult.body["stockPrice"] : undefined;
  const spot =
    typeof spotRaw === "number" && Number.isFinite(spotRaw) && spotRaw > 0
      ? spotRaw
      : null;
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

  const exposureData = exposure(oiRows, chain.rows, spot, today);
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
  const morePages =
    flowResult.ok && Array.isArray(flowResult.body["nextSearchAfter"])
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
  const cooldown = deps.client.cooldownSeconds();
  const notes: string[] = [...OPTIONS_ANALYTICS_NOTES];
  if (chain.expired > 0)
    notes.push(`Excluded ${chain.expired} expired expiries from the IV views.`);
  return {
    exposure: exposureSection,
    flow,
    notes,
    rateLimited,
    receivedAt: now.toISOString(),
    retryAfterSeconds: rateLimited ? Math.ceil(cooldown) : null,
    source: "quantdata",
    spot,
    symbol,
    volatility,
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

const clientFor = (config: QuantDataConfig): QuantDataClient => {
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

const api = implement(appContract).$context<ApiContext>();

const snapshot = api.optionsAnalytics.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const config = context.quantData ?? null;
    if (config === null) throw errors.NOT_CONFIGURED();
    return await buildOptionsAnalytics(input, {
      client: clientFor(config),
      now: clock,
    });
  });

export const optionsAnalyticsRouter = { snapshot };
