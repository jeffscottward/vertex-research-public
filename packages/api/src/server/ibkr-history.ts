// What: server-side IBKR history reads for the call sites that used Yahoo Finance (card
// vertex-yahoo-terms-decision, owner 2026-11-10: "Replace with IBKR history ... plus whatever else IBKR gives us").
// Why: one typed client for vertex-history 1.3.0 beyond the /charts surface: forex (CASH), indices (IND),
// dividend-adjusted daily bars (ADJUSTED_LAST), daily windows up to 30 Y and end-dated paging for intraday
// windows longer than one request. Same transport as marketData.bars (fetchHistoryDocument: bearer, GET,
// timeout, 2 MiB cap, no redirects); messages never carry the token or the URL.
// Read-only market data; nothing here touches orders, arming or the live engine.

import { z } from "zod";

import {
  HISTORY_SEC_TYPES,
  HISTORY_WHAT_TO_SHOW,
  type HistorySecType,
  type HistoryWhatToShow,
  historyDurationAllowed,
  MARKET_BAR_SIZES,
  MARKET_BARS_MAX,
  type MarketBar,
  MarketBarSchema,
  type MarketBarSize,
  MarketContractSchema,
} from "../contracts/market-data.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import {
  type FetchMarketBarsOptions,
  fetchHistoryDocument,
  MARKET_HISTORY_TIMEOUT_MS,
  MarketDataError,
} from "./market-data.ts";

export type HistoryBarsRequest = Readonly<{
  symbol: string;
  secType?: HistorySecType;
  exchange?: string;
  currency?: string;
  barSize: MarketBarSize;
  duration: string;
  whatToShow?: HistoryWhatToShow;
  useRTH?: boolean;
  contractMonth?: string;
  // IBKR's UTC form YYYYMMDD-HH:MM:SS; absent = now.
  endDateTime?: string;
}>;

const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const END_DATETIME_RE = /^\d{8}-\d{2}:\d{2}:\d{2}$/;
// vertex-history refuses end dates before 1990-01-01 (IBKR's history floor for this service).
const END_DATETIME_FLOOR_MS = Date.UTC(1990, 0, 1);
// US stock bar volume arrives in lots of 100 shares (ibapi 9.81; docs/vertex-rebuild/quantvps-status-endpoint.md).
export const STK_VOLUME_LOT = 100;

const HistoryUpstreamSchema = z
  .object({
    as_of: isoUtc.nullable(),
    bars: z.array(MarketBarSchema).max(MARKET_BARS_MAX),
    cache: z
      .object({
        age_seconds: z.number().int().nonnegative(),
        hit: z.boolean(),
        stale: z.boolean(),
        ttl_seconds: z.number().int().nonnegative(),
      })
      .strict(),
    client_id: z.literal(77),
    contract: MarketContractSchema,
    count: z.number().int().nonnegative(),
    fetched_at: isoUtc,
    request: z
      .object({
        barSize: z.enum(MARKET_BAR_SIZES),
        contractMonth: z.string().max(8).nullable(),
        currency: z.string().max(3),
        duration: z.string().max(8),
        endDateTime: z.string().regex(END_DATETIME_RE).optional(),
        exchange: z.string().max(16),
        secType: z.enum(HISTORY_SEC_TYPES),
        symbol: z.string().max(12),
        useRTH: z.boolean(),
        whatToShow: z.enum(HISTORY_WHAT_TO_SHOW),
      })
      .strict(),
    schema: z.literal("vertex-history-bars-v1"),
    source: z.literal("ibkr-gateway"),
  })
  .strict()
  .refine((document) => document.count === document.bars.length, {
    message: "count mismatch",
  });

type HistoryUpstream = z.infer<typeof HistoryUpstreamSchema>;

export type HistoryBars = Readonly<{
  request: HistoryUpstream["request"];
  contract: HistoryUpstream["contract"];
  // Ascending by `t` (epoch seconds; daily bars: 00:00 UTC of the trading date). `v` in shares or contracts:
  // IBKR reports US stock volume to this API version in lots of 100 (STK_VOLUME_LOT), scaled here so bars
  // merge with share-based sources (Yahoo) without a unit seam.
  bars: MarketBar[];
  fetchedAt: string;
  asOf: string | null;
  // True when the service answered with its stale copy (paced or backed off).
  stale: boolean;
}>;

/** IBKR's UTC end-date form for `date`. */
export const historyEndDateTime = (date: Date): string => {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 19)}`;
};

// The request rules of vertex-history 1.3.0: [broken when true, message].
const HISTORY_RULES: ReadonlyArray<
  readonly [
    (
      request: Required<Pick<HistoryBarsRequest, "secType" | "whatToShow">> &
        HistoryBarsRequest
    ) => boolean,
    string,
  ]
> = [
  [
    (r) => !historyDurationAllowed(r.barSize, r.duration),
    "Duration is not allowed for this bar size",
  ],
  [
    (r) => r.endDateTime !== undefined && !END_DATETIME_RE.test(r.endDateTime),
    "endDateTime must be YYYYMMDD-HH:MM:SS (UTC)",
  ],
  [
    (r) =>
      r.secType !== "STK" && r.secType !== "CASH" && r.exchange === undefined,
    "Futures and indices need an exchange",
  ],
  [
    (r) => r.secType === "CONTFUT" && r.endDateTime !== undefined,
    "CONTFUT takes no endDateTime",
  ],
  [
    (r) =>
      r.whatToShow === "ADJUSTED_LAST" &&
      (r.secType !== "STK" || r.barSize !== "1 day"),
    "ADJUSTED_LAST is for STK 1 day bars only",
  ],
  [
    (r) => r.whatToShow === "ADJUSTED_LAST" && r.endDateTime !== undefined,
    "ADJUSTED_LAST takes no endDateTime",
  ],
  [
    (r) => r.whatToShow === "BID_ASK" && r.secType !== "STK",
    "BID_ASK is for STK only",
  ],
  [
    (r) => r.secType === "IND" && r.whatToShow !== "TRADES",
    "IND offers TRADES only",
  ],
];

/** Throws MarketDataError BAD_REQUEST when the request breaks a vertex-history rule; no network call. */
export const checkHistoryBarsRequest = (request: HistoryBarsRequest): void => {
  const normalized = {
    ...request,
    secType: request.secType ?? "STK",
    whatToShow: request.whatToShow ?? "TRADES",
  };
  for (const [broken, message] of HISTORY_RULES) {
    if (broken(normalized)) throw new MarketDataError("BAD_REQUEST", message);
  }
};

export const buildHistoryBarsUrl = (
  base: string,
  request: HistoryBarsRequest
): string => {
  const secType = request.secType ?? "STK";
  const params = new URLSearchParams({
    barSize: request.barSize,
    currency: (request.currency ?? "USD").toUpperCase(),
    duration: request.duration,
    secType,
    symbol: request.symbol.toUpperCase(),
    useRTH: (request.useRTH ?? true) ? "1" : "0",
    whatToShow: request.whatToShow ?? "TRADES",
  });
  // Without an exchange the service picks its default (SMART for STK, IDEALPRO for CASH).
  if (request.exchange !== undefined)
    params.set("exchange", request.exchange.toUpperCase());
  if (request.contractMonth !== undefined)
    params.set("contractMonth", request.contractMonth);
  if (request.endDateTime !== undefined)
    params.set("endDateTime", request.endDateTime);
  return `${base.replace(/\/+$/, "")}/bars?${params.toString()}`;
};

/** One vertex-history bars request. Throws MarketDataError (safe message) on any failure. */
export const fetchHistoryBars = async (
  config: DeployStatusConfig | null,
  request: HistoryBarsRequest,
  options: FetchMarketBarsOptions = {}
): Promise<HistoryBars> => {
  checkHistoryBarsRequest(request);
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildHistoryBarsUrl(base, request),
    MARKET_HISTORY_TIMEOUT_MS,
    options
  );
  const parsed = HistoryUpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "History response failed schema validation"
    );
  const document = parsed.data;
  const lot =
    document.request.secType === "STK" && document.request.currency === "USD"
      ? STK_VOLUME_LOT
      : 1;
  return {
    asOf: document.as_of,
    bars: document.bars
      .map((bar) =>
        bar.v === null || lot === 1 ? bar : { ...bar, v: bar.v * lot }
      )
      .sort((a, b) => a.t - b.t),
    contract: document.contract,
    fetchedAt: document.fetched_at,
    request: document.request,
    stale: document.cache.stale,
  };
};

export type PagedHistoryOptions = FetchMarketBarsOptions &
  Readonly<{
    // Sleep before retrying a paced (429) page; default: real timers.
    sleep?: (ms: number) => Promise<void>;
    // Retries of one paced page (the service allows about 3 requests per minute).
    pacedRetries?: number;
    pacedWaitMs?: number;
  }>;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// One page; a paced (429) answer is retried after a wait, any other failure is thrown.
const fetchPacedPage = async (
  config: DeployStatusConfig | null,
  request: HistoryBarsRequest,
  options: PagedHistoryOptions
): Promise<HistoryBars> => {
  const retries = options.pacedRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchHistoryBars(config, request, options);
    } catch (error) {
      const paced = error instanceof MarketDataError && error.code === "PACED";
      if (!paced || attempt >= retries) throw error;
      await (options.sleep ?? realSleep)(options.pacedWaitMs ?? 25_000);
    }
  }
};

/**
 * Up to `pages` consecutive windows of `request.duration`, newest first, each ending one second before the
 * previous window's first bar; merged ascending without duplicates. Stops early on an empty window or at the
 * service's 1990 floor. CONTFUT and ADJUSTED_LAST take no end date, so they allow one page only.
 */
export const fetchHistoryBarsPaged = async (
  config: DeployStatusConfig | null,
  request: HistoryBarsRequest,
  pages: number,
  options: PagedHistoryOptions = {}
): Promise<HistoryBars> => {
  const undated =
    request.secType === "CONTFUT" || request.whatToShow === "ADJUSTED_LAST";
  if (
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 40 ||
    (undated && pages > 1)
  )
    throw new MarketDataError(
      "BAD_REQUEST",
      "pages: 1 to 40, and 1 for CONTFUT or ADJUSTED_LAST"
    );
  const byTime = new Map<number, MarketBar>();
  const newest = await fetchPacedPage(config, request, options);
  let result = newest;
  let stale = newest.stale;
  for (let page = 1; ; page += 1) {
    for (const bar of result.bars) {
      if (!byTime.has(bar.t)) byTime.set(bar.t, bar);
    }
    const first = result.bars[0];
    const nextEndMs = first === undefined ? 0 : (first.t - 1) * 1000;
    if (page >= pages || nextEndMs < END_DATETIME_FLOOR_MS) break;
    result = await fetchPacedPage(
      config,
      { ...request, endDateTime: historyEndDateTime(new Date(nextEndMs)) },
      options
    );
    stale ||= result.stale;
  }
  return {
    ...newest,
    bars: [...byTime.values()].sort((a, b) => a.t - b.t),
    stale,
  };
};

// /news (vertex-history 1.3.0): newest IBKR headlines for one stock from the account's API news providers.
const HistoryNewsUpstreamSchema = z
  .object({
    schema: z.literal("vertex-history-news-v1"),
    source: z.literal("ibkr-gateway"),
    client_id: z.literal(77),
    request: z
      .object({
        symbol: z.string().max(12),
        secType: z.literal("STK"),
        exchange: z.string().max(16),
        currency: z.string().max(3),
        count: z.number().int().min(1).max(50),
      })
      .strict(),
    contract: MarketContractSchema,
    providers: z
      .array(
        z
          .object({
            code: z.string().max(16),
            name: z.string().max(80).nullable(),
          })
          .strict()
      )
      .max(100),
    items: z
      .array(
        z
          .object({
            t: z.number().int(),
            time: isoUtc,
            provider: z.string().max(16).nullable(),
            articleId: z.string().max(64).nullable(),
            headline: z.string().min(1).max(500),
          })
          .strict()
      )
      .max(50),
    count: z.number().int().nonnegative(),
    fetchedAt: isoUtc,
    cache: z
      .object({
        hit: z.boolean(),
        ageSeconds: z.number().int().nonnegative(),
        ttlSeconds: z.number().int().nonnegative(),
        stale: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine((document) => document.count === document.items.length, {
    message: "count mismatch",
  });

export type HistoryNews = Readonly<{
  providers: z.infer<typeof HistoryNewsUpstreamSchema>["providers"];
  // Newest first.
  items: z.infer<typeof HistoryNewsUpstreamSchema>["items"];
  fetchedAt: string;
  stale: boolean;
}>;

/** Newest IBKR headlines (1 to 50) for one US stock. Throws MarketDataError (safe message) on failure. */
export const fetchHistoryNews = async (
  config: DeployStatusConfig | null,
  symbol: string,
  count: number,
  options: FetchMarketBarsOptions = {}
): Promise<HistoryNews> => {
  if (!Number.isInteger(count) || count < 1 || count > 50)
    throw new MarketDataError("BAD_REQUEST", "count: 1 to 50");
  const raw = await fetchHistoryDocument(
    config,
    (base) =>
      `${base.replace(/\/+$/, "")}/news?${new URLSearchParams({
        symbol: symbol.toUpperCase(),
        count: String(count),
      }).toString()}`,
    MARKET_HISTORY_TIMEOUT_MS,
    options
  );
  const parsed = HistoryNewsUpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "News response failed schema validation"
    );
  return {
    providers: parsed.data.providers,
    items: parsed.data.items,
    fetchedAt: parsed.data.fetchedAt,
    stale: parsed.data.cache.stale,
  };
};
