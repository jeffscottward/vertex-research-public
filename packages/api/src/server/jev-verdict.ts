import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  JEV_MAX_CALLS_PER_HOUR,
  JEV_MIN_INTERVAL_SECONDS,
  JEV_STALE_AFTER_SECONDS,
  type JevFailureCode,
  type JevVerdictOutput,
} from "../contracts/jev-verdict.ts";
import {
  MarketBarsInputSchema,
  type MarketBarsOutput,
} from "../contracts/market-data.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import {
  callJev,
  type JevClientOptions,
  type JevConfig,
} from "./jev-client.ts";
import {
  buildJevRequestBody,
  buildPublicFeatures,
  createJevVerdictStore,
  JEV_PUBLIC_FIELDS,
  type JevStoreLimits,
  type JevVerdictStore,
  parseJevReply,
  toJevVerdictOutput,
} from "./jev-verdict-engine.ts";
import { type FetchMarketBarsOptions, fetchMarketBars } from "./market-data.ts";
import { requireOperator } from "./operator-access.ts";

// Display-only JEV verdict (jevVerdict.get / jevVerdict.refresh, merge plan P5).
// refresh: 1 history request (1 Y daily bars, public prices) and at most 1 JEV call. A
// failure before the JEV call gives the reservation back and waits 60 s before the next try.
// Only allow-listed public price fields reach JEV. Nothing here can place, change or
// cancel orders; merge plan P6 (the order gate) reads this verdict separately.

const LIMITS: JevStoreLimits & { staleAfterMs: number } = {
  maxCallsPerHour: JEV_MAX_CALLS_PER_HOUR,
  failureCooldownMs: 60_000,
  maxEntries: 200,
  minIntervalMs: JEV_MIN_INTERVAL_SECONDS * 1000,
  staleAfterMs: JEV_STALE_AFTER_SECONDS * 1000,
};

export type JevVerdictDeps = Readonly<{
  jev: JevConfig;
  history: DeployStatusConfig;
  store: JevVerdictStore;
  now: () => Date;
  jevOptions?: JevClientOptions;
  barsOptions?: FetchMarketBarsOptions;
}>;

const FAILURE_TEXT: Readonly<Record<JevFailureCode, string>> = {
  INSUFFICIENT_DATA: "Not enough daily bars to describe this symbol",
  JEV_HTTP: "JEV request failed",
  JEV_INVALID: "JEV reply could not be read",
  JEV_TIMEOUT: "JEV request timed out",
  MARKET_DATA: "Daily bars could not be loaded",
};

export const refreshJevVerdict = async (
  symbol: string,
  deps: JevVerdictDeps
): Promise<JevVerdictOutput> => {
  const output = (refreshed: boolean, throttled: boolean) =>
    toJevVerdictOutput(symbol, deps.store, deps.now().getTime(), LIMITS, {
      configured: true,
      refreshed,
      throttled,
    });
  const failure = (code: JevFailureCode, detail = "") => ({
    at: deps.now().toISOString(),
    code,
    message: `${FAILURE_TEXT[code]}${detail}`,
  });
  // Before the JEV call: give the reservation back (short cooldown, no JEV budget used).
  const cancel = (code: JevFailureCode) => {
    deps.store.cancel(symbol, failure(code), deps.now().getTime());
    return output(false, false);
  };
  // After the JEV call: the call counts against both limits.
  const fail = (code: JevFailureCode, detail = "") => {
    deps.store.fail(symbol, failure(code, detail));
    return output(false, false);
  };
  const barsInput = MarketBarsInputSchema.parse({ symbol });
  // Reserve before loading bars, so one refresh per symbol runs at a time.
  if (!deps.store.tryStart(symbol, deps.now().getTime()).ok)
    return output(false, true);
  let bars: MarketBarsOutput;
  try {
    bars = await fetchMarketBars(deps.history, barsInput, deps.barsOptions);
  } catch {
    return cancel("MARKET_DATA");
  }
  const state = buildPublicFeatures(symbol, bars.bars, bars.asOf);
  if (state === null) return cancel("INSUFFICIENT_DATA");
  const result = await callJev(
    deps.jev,
    buildJevRequestBody(deps.jev.model, state),
    deps.jevOptions
  );
  if (!result.ok) {
    if (result.reason === "timeout") return fail("JEV_TIMEOUT");
    if (result.reason === "invalid") return fail("JEV_INVALID");
    return fail(
      "JEV_HTTP",
      result.status === null ? "" : ` (HTTP ${result.status})`
    );
  }
  const reply = parseJevReply(result.document);
  if (reply === null) return fail("JEV_INVALID");
  deps.store.succeed(symbol, {
    ...reply,
    dataAsOf: typeof state.as_of === "string" ? state.as_of : null,
    decidedAt: deps.now().toISOString(),
    sentFields: JEV_PUBLIC_FIELDS.filter((field) => field in state),
  });
  return output(true, false);
};

// One store per server process, shared by every request.
let store: JevVerdictStore = createJevVerdictStore(LIMITS);
const systemClock = (): Date => new Date();
let clock: () => Date = systemClock;
let jevOptions: JevClientOptions = {};
let barsOptions: FetchMarketBarsOptions = {};

export const setJevVerdictForTesting = (
  options: Readonly<{
    jev?: JevClientOptions;
    bars?: FetchMarketBarsOptions;
    now?: () => Date;
  }> = {}
): void => {
  store = createJevVerdictStore(LIMITS);
  clock = options.now ?? systemClock;
  jevOptions = options.jev ?? {};
  barsOptions = options.bars ?? {};
};

const api = implement(appContract).$context<ApiContext>();

const get = api.jevVerdict.get
  .use(requireOperator)
  .handler(({ context, input }) =>
    toJevVerdictOutput(input.symbol, store, clock().getTime(), LIMITS, {
      configured:
        (context.jev ?? null) !== null &&
        (context.marketHistory ?? null) !== null,
      refreshed: false,
      throttled: false,
    })
  );

const refresh = api.jevVerdict.refresh
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const jev = context.jev ?? null;
    const history = context.marketHistory ?? null;
    if (jev === null || history === null) throw errors.NOT_CONFIGURED();
    return await refreshJevVerdict(input.symbol, {
      barsOptions,
      history,
      jev,
      jevOptions,
      now: clock,
      store,
    });
  });

export const jevVerdictRouter = { get, refresh };
