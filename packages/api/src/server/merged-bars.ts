// What: one rule for the API-server price call sites that read Yahoo chart bars (card
// vertex-yahoo-terms-decision): ask IBKR (vertex-history) first; when IBKR fails, is not configured or
// has no request slot left, the site's existing Yahoo read serves the whole series; when IBKR answers
// but starts later than the window the site needs (or a page walk stopped early), Yahoo fills only the
// bars older than IBKR's oldest bar. Yahoo never fills between or after IBKR bars, so one series never
// interleaves two bar grids. Every bar is tagged with its source.
// Why: Yahoo stays a fallback, not the primary source. IBKR US stock volume arrives in shares
// (ibkr-history.ts scales the lots of 100), the same unit as Yahoo, so a merged series has no
// volume seam.
// Pacing: vertex-history allows about 3 requests per minute, shared with /charts, /ticks and /news.
// Each isolate (the web app runs as Cloudflare Workers, so there can be several) starts at most
// IBKR_PACING.requests live history requests per IBKR_PACING.windowMs over all sites together; the
// service's own PACED (429) answer is the real limit and sends that symbol to Yahoo at once. A live
// request is never retried, so a view or tick never blocks for minutes. Only plain numbers are shared
// between requests (workerd forbids sharing promises).
// Freshness: the service answers from its cache (up to 300 s for intraday bars, 3600 s for daily
// bars) without marking it stale; `fromIbkr` receives the answer so a site can judge bars by
// `fetchedAt` (historyFetchedAt), and `maxAgeMs` turns an older copy into a Yahoo read.
// Used by: pick-lists.ts, research-lenses.ts, sector-rotation.ts, price-alerts.ts, signal-alerts.ts
// and scripts/sector-rotation-backtest/freeze.ts.

import type { MarketBar } from "../contracts/market-data.ts";
import { newYorkClock } from "../signal-alerts.ts";
import type { DeployStatusConfig } from "./deploy-status.ts";
import {
  fetchHistoryBars,
  fetchHistoryBarsPaged,
  type HistoryBars,
  type HistoryBarsRequest,
  type PagedHistoryBars,
  type PagedHistoryOptions,
} from "./ibkr-history.ts";
import { MarketDataError } from "./market-data.ts";

export type BarSource = "ibkr" | "yahoo";
export type Sourced<T> = T & Readonly<{ source: BarSource }>;

export type MergedBarsPlan<T> = Readonly<{
  /** Counts IBKR fallbacks per site (ibkrFallbacks). */
  site: string;
  config: DeployStatusConfig | null;
  /** The IBKR request; null when the symbol has no IBKR form here (Yahoo serves it). */
  request: HistoryBarsRequest | null;
  /** Why IBKR is not asked when request is null; default "No IBKR contract for this symbol". */
  noRequestReason?: string;
  /** Consecutive windows of request.duration, newest first (fetchHistoryBarsPaged); default 1. */
  pages?: number;
  /** IBKR transport options; `now` is also the pacing and freshness clock. */
  options?: PagedHistoryOptions;
  /**
   * Live (default): one pacing slot per page or Yahoo at once; no retries (paced or unavailable), so
   * the site reads Yahoo instead of waiting. Offline (a script or scheduled job that may wait): no
   * pacing slots, the transport's paced and unavailable retries.
   */
  offline?: boolean;
  /** A stale service copy counts as an IBKR failure (alerts need current bars). Default: used. */
  rejectStale?: boolean;
  /** A service copy fetched longer ago than this counts as an IBKR failure. Default: any age. */
  maxAgeMs?: number;
  /** On an IBKR failure return no bars instead of reading Yahoo (the caller decides). */
  ibkrOnly?: boolean;
  /** Sort key of the oldest bar the site needs; Yahoo fills when IBKR's oldest bar is later. */
  fillBefore?: string;
  /** One IBKR bar in the site's form; null drops it (a session still running, a forming bar). */
  fromIbkr: (bar: MarketBar, history: HistoryBars) => T | null;
  /** The site's existing Yahoo read of the whole window. Throws the site's error on failure. */
  yahoo: () => Promise<readonly T[]>;
  /** One key per bar that sorts by time: YYYY-MM-DD for daily bars, ISO time for intraday bars. */
  keyOf: (bar: T) => string;
}>;

export type MergedBars<T> = Readonly<{
  /** Ascending by keyOf, one bar per key. */
  bars: Sourced<T>[];
  /** The IBKR answer behind the "ibkr" bars; null when IBKR bars are not used. */
  history: PagedHistoryBars | null;
  /** Why IBKR bars are not used; null when they are. */
  ibkrError: string | null;
}>;

export const IBKR_PACING = Object.freeze({ requests: 2, windowMs: 60_000 });
export const IBKR_DEFERRED_REASON =
  "IBKR history request deferred for pacing; Yahoo served this series";
/** IBKR request timeout of views and ticks (the transport default is 30 s): Yahoo answers sooner. */
export const LIVE_HISTORY_TIMEOUT_MS = 15_000;

// Start times (ms) of the live IBKR history requests of this isolate in the current pacing window.
let started: number[] = [];

export type IbkrFallbacks = Readonly<
  Record<string, Readonly<{ count: number; lastReason: string }>>
>;
// Whole-series Yahoo reads per site since the isolate started, with the last IBKR reason.
let fallbacks: Record<string, { count: number; lastReason: string }> = {};

/** Whole-series Yahoo reads per site and the last reason IBKR was not used (diagnostics). */
export const ibkrFallbacks = (): IbkrFallbacks => structuredClone(fallbacks);

/** Forgets the requests of the pacing window and the fallback counts (tests). */
export const resetIbkrPacing = (): void => {
  started = [];
  fallbacks = {};
};

const takeSlots = (count: number, now: number): boolean => {
  started = started.filter((at) => now - at < IBKR_PACING.windowMs);
  if (started.length + count > IBKR_PACING.requests) return false;
  for (let slot = 0; slot < count; slot += 1) started.push(now);
  return true;
};

const countFallback = (site: string, reason: string): void => {
  const entry = fallbacks[site] ?? { count: 0, lastReason: reason };
  fallbacks[site] = { count: entry.count + 1, lastReason: reason };
};

const tag = <T>(bars: readonly T[], source: BarSource): Sourced<T>[] =>
  bars.map((bar) => ({ ...bar, source }));

/** When the service fetched these bars from IBKR. */
export const historyFetchedAt = (history: HistoryBars): Date =>
  new Date(history.fetchedAt);

type IbkrAnswer = Readonly<{ history: PagedHistoryBars | null; error: string }>;

const fetchIbkr = async <T>(
  plan: MergedBarsPlan<T>,
  config: DeployStatusConfig,
  request: HistoryBarsRequest,
  pages: number
): Promise<PagedHistoryBars> => {
  if (plan.offline === true)
    return fetchHistoryBarsPaged(config, request, pages, plan.options);
  if (pages === 1)
    return {
      ...(await fetchHistoryBars(config, request, plan.options)),
      complete: true,
    };
  return fetchHistoryBarsPaged(config, request, pages, {
    pacedRetries: 0,
    unavailableRetries: 0,
    ...plan.options,
  });
};

const askIbkr = async <T>(
  plan: MergedBarsPlan<T>,
  now: number
): Promise<IbkrAnswer> => {
  if (plan.request === null)
    return {
      error: plan.noRequestReason ?? "No IBKR contract for this symbol",
      history: null,
    };
  if (plan.config === null)
    return { error: "IBKR history not configured", history: null };
  const pages = plan.pages ?? 1;
  if (plan.offline !== true && !takeSlots(pages, now))
    return { error: IBKR_DEFERRED_REASON, history: null };
  let history: PagedHistoryBars;
  try {
    history = await fetchIbkr(plan, plan.config, plan.request, pages);
  } catch (error) {
    // MarketDataError messages are safe; anything else is reported generically.
    return {
      error:
        error instanceof MarketDataError
          ? error.message
          : "IBKR history request failed",
      history: null,
    };
  }
  if (history.stale && plan.rejectStale === true)
    return { error: "IBKR answered with a stale copy", history: null };
  const age = now - historyFetchedAt(history).getTime();
  if (plan.maxAgeMs !== undefined && age > plan.maxAgeMs)
    return { error: "IBKR answered with an old cached copy", history: null };
  return { error: "", history };
};

/**
 * IBKR first, Yahoo for the whole series when IBKR fails or sends no usable bars, and Yahoo for the
 * bars older than IBKR's oldest bar when that bar is later than plan.fillBefore or a page walk stopped
 * early (complete: false). A failed gap fill keeps the IBKR bars.
 */
export const loadMergedBars = async <T>(
  plan: MergedBarsPlan<T>
): Promise<MergedBars<T>> => {
  const now = (plan.options?.now ?? (() => new Date()))().getTime();
  const answer = await askIbkr(plan, now);
  const history = answer.history;
  const ibkr =
    history === null
      ? []
      : history.bars.flatMap((bar) => {
          const converted = plan.fromIbkr(bar, history);
          return converted === null ? [] : [converted];
        });
  const oldest = ibkr[0];
  if (history === null || oldest === undefined) {
    const reason = history === null ? answer.error : "IBKR returned no bars";
    countFallback(plan.site, reason);
    return {
      bars: plan.ibkrOnly === true ? [] : tag(await plan.yahoo(), "yahoo"),
      history: null,
      ibkrError: reason,
    };
  }
  const used = tag(ibkr, "ibkr");
  const first = plan.keyOf(oldest);
  const late = plan.fillBefore !== undefined && first > plan.fillBefore;
  if (history.complete && !late)
    return { bars: used, history, ibkrError: null };
  let filler: readonly T[];
  try {
    filler = await plan.yahoo();
  } catch {
    filler = [];
  }
  const older = filler.filter((bar) => plan.keyOf(bar) < first);
  return {
    bars: [...tag(older, "yahoo"), ...used],
    history,
    ibkrError: null,
  };
};

/** A site's Yahoo failure result, thrown through loadMergedBars and returned by settle. */
export class FallbackFailure<R> extends Error {
  readonly result: R;
  constructor(reason: string, result: R) {
    super(reason);
    this.result = result;
  }
}

export type UnexpectedFailure = Readonly<{
  ok: false;
  reason: string;
  unknown: false;
}>;

/** Runs a merged read: a FallbackFailure becomes its result, anything else a generic failure. */
export const settle = async <R>(
  run: () => Promise<R>
): Promise<R | UnexpectedFailure> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FallbackFailure) return error.result as R;
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "request failed",
      unknown: false,
    };
  }
};

/** IBKR daily durations of the Yahoo ranges the call sites read. */
export const DAILY_HISTORY_DURATION = Object.freeze({
  "1y": "1 Y",
  "2y": "2 Y",
  "5y": "5 Y",
  "10y": "10 Y",
});

/** The trading date of an IBKR daily bar (`t` is 00:00 UTC of that date). */
export const historyDate = (t: number): string =>
  new Date(t * 1000).toISOString().slice(0, 10);

// Weekends and holidays: a window's first bar can be this many days after its first calendar day.
const WINDOW_SLACK_DAYS = 5;
const DAY_MS = 86_400_000;

/** The latest time a complete window of `days` calendar days ending at `now` may start. */
export const windowFillBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - (days - WINDOW_SLACK_DAYS) * DAY_MS);

/** The instant of `minute` (minutes after midnight) on New York calendar day `day` (YYYY-MM-DD). */
export const newYorkTime = (day: string, minute: number): Date => {
  // New York is 4 or 5 hours behind UTC; start from 5 and correct by the clock difference.
  const guess = Date.parse(`${day}T00:00:00Z`) + (minute + 300) * 60_000;
  const clock = newYorkClock(new Date(guess));
  const shift =
    clock.day === day ? clock.minute - minute : clock.minute + 1440 - minute;
  return new Date(guess - shift * 60_000);
};

const SESSION_OPEN_MINUTE = 9 * 60 + 30;
/** 16:00 New York: the US regular session close. */
export const SESSION_CLOSE_MINUTE = 16 * 60;

/** 09:30 New York on the New York calendar day of `now` (the US regular session open). */
export const sessionOpen = (now: Date): Date =>
  newYorkTime(newYorkClock(now).day, SESSION_OPEN_MINUTE);

/** True while the US regular session of `day` has not closed at `at` (its daily bar is live). */
export const sessionRunning = (day: string, at: Date): boolean => {
  const clock = newYorkClock(at);
  return clock.day === day && clock.minute < SESSION_CLOSE_MINUTE;
};

// Continuous futures the sites read from Yahoo (ROOT=F), by IBKR exchange.
const FUTURES_EXCHANGE: ReadonlyMap<string, string> = new Map([
  ...["ES", "MES", "NQ", "MNQ", "RTY", "M2K"].map((root) => [root, "CME"]),
  ...["YM", "MYM", "ZB", "ZN", "ZF", "ZT", "ZC", "ZS", "ZW"].map((root) => [
    root,
    "CBOT",
  ]),
  ...["CL", "MCL", "NG", "RB", "HO"].map((root) => [root, "NYMEX"]),
  ...["GC", "MGC", "SI", "HG"].map((root) => [root, "COMEX"]),
] as [string, string][]);

export type HistoryInstrument = Readonly<
  Pick<HistoryBarsRequest, "symbol" | "secType" | "exchange">
>;

/**
 * The IBKR instrument of a site symbol: ROOT=F is the continuous future (CONTFUT, latest window
 * only), plain tickers are US stocks. Null (Yahoo only): unknown futures roots, indices (^GSPC),
 * crypto pairs (BTC-USD) and class shares (BRK.B).
 */
export const historyInstrument = (symbol: string): HistoryInstrument | null => {
  const upper = symbol.toUpperCase();
  const root = /^([A-Z0-9]{1,4})=F$/u.exec(upper)?.[1];
  if (root !== undefined) {
    const exchange = FUTURES_EXCHANGE.get(root);
    return exchange === undefined
      ? null
      : { exchange, secType: "CONTFUT", symbol: root };
  }
  return /^[A-Z][A-Z0-9]{0,11}$/u.test(upper)
    ? { secType: "STK", symbol: upper }
    : null;
};
