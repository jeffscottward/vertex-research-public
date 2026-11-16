// IBKR daily bars for the research-lens data jobs, with Yahoo filling the gaps (owner rule: IBKR
// first, Yahoo fills gaps, every Yahoo fetcher stays). This is the self-contained twin of
// packages/api/src/server/ibkr-history.ts and merged-bars.ts: the rig runs this folder from a
// `git archive` extract, so it cannot import them (see lens-io.ts) and validates by hand (no zod).
// Service: vertex-history `GET {VERTEX_HISTORY_URL}/bars`, bearer VERTEX_DEPLOY_STATUS_TOKEN, schema
// vertex-history-bars-v1 (docs/vertex-rebuild/quantvps-status-endpoint.md). It holds the only IB
// session and paces every caller together: at most 6 historical requests per 120 s, at least 10 s
// apart. The flow collector uses about 2 of them every 120 s, all day. A request waits up to 20 s
// there, then the service answers 429 (paced or busy, with retry_after_seconds) or a stale copy.
// Which symbols: IBKR reads only the job's own names (the `ibkrFirst` list: our names); the whole
// universe (about 3,000 symbols) does not fit the pacing, so Yahoo reads every other symbol.
// Pacing here (docs/vertex-rebuild/research-lenses.md "IBKR first"): one IBKR request at a time;
// IBKR_GAP_MS after each answer that the service fetched from IBKR (none after a cache hit); a paced,
// busy or stale answer waits and asks again, at most IBKR_PACED_TRIES times per symbol; a pacing
// violation, 401 or 403, or IBKR_MAX_FAILURES failures in a row end IBKR for the run; IBKR is asked
// only during the run budget (LENS_IBKR_BUDGET_MINUTES, default 75, 0 = off).
// Merge rule: IBKR bars when IBKR answers; Yahoo for the whole series when it fails or sends no bars;
// Yahoo only for the days before IBKR's oldest bar when IBKR starts later than the window needs.
// The two sources are never interleaved inside the IBKR range.
// Without VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN the jobs read Yahoo only, as before.
// Messages never carry the token or the URL. Read-only market data; no orders.

import { join } from "node:path";
import {
  dig,
  field,
  type LensIo,
  logLine,
  messageOf,
  writeAtomic,
} from "./lens-io.ts";

export type BarSource = "ibkr" | "yahoo";
/** The sources of one symbol's series: "mixed" is IBKR with older days from Yahoo. */
export type SeriesSource = BarSource | "mixed";
export type Sourced<T> = T & Readonly<{ source: BarSource }>;
export type SourceCounts = Readonly<Record<SeriesSource, number>>;

type Dated = Readonly<{ date: string }>;

/** One IBKR daily bar: adjusted close, volume in shares. */
export type HistoryBar = Readonly<{
  date: string;
  close: number;
  volume: number | null;
}>;

export type HistoryConfig = Readonly<{ url: string; token: string }>;

export const IBKR_MAX_FAILURES = 3;
/** Wait after an answer that the service fetched from IBKR: 3 of the service's 6 requests per 120 s. */
export const IBKR_GAP_MS = 40_000;
/** Answers "wait" (paced, busy, stale copy) per symbol before Yahoo serves it. */
export const IBKR_PACED_TRIES = 3;
/** Minutes of a run in which IBKR is asked (about 110 names at IBKR_GAP_MS). */
export const IBKR_BUDGET_MINUTES = 75;
export const IBKR_BUDGET_ENV = "LENS_IBKR_BUDGET_MINUTES";
// The units allow the default budget plus 15 minutes (TimeoutStartSec): the variable only lowers it.
const IBKR_BUDGET_MAX = IBKR_BUDGET_MINUTES;
/** A wait longer than the service's burst window is its back-off after a pacing violation: stop. */
const MAX_WAIT_SECONDS = 120;
// US stock volume arrives in lots of 100 shares (ibapi 9.81); Yahoo reports shares.
export const STK_VOLUME_LOT = 100;

const TOKEN_MIN = 32;
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];
// The service waits up to 20 s for its pacer, then asks IB; the tailnet proxy allows 45 s.
const TIMEOUT_MS = 45_000;
const MAX_BARS = 20_000;
const DAY_MS = 86_400_000;
// Weekends and holidays: a window's first bar can be this many days after its first calendar day.
const WINDOW_SLACK_DAYS = 5;
// The request echo of adjusted US stock daily bars; the volume lot above holds only for this echo.
const ADJUSTED_DAILY = {
  barSize: "1 day",
  currency: "USD",
  secType: "STK",
  useRTH: true,
  whatToShow: "ADJUSTED_LAST",
} as const;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The service address and token from the environment, as the server accepts them: both set, the
 * token at least 32 characters, the URL https (or http on a loopback host) without credentials.
 * Anything else is "not configured" (null).
 */
export const historyConfig = (env: LensIo["env"]): HistoryConfig | null => {
  const url = env["VERTEX_HISTORY_URL"]?.trim() ?? "";
  const token = env["VERTEX_DEPLOY_STATUS_TOKEN"]?.trim() ?? "";
  if (url === "" || token.length < TOKEN_MIN) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname));
  return allowed && parsed.username === "" && parsed.password === ""
    ? { token, url }
    : null;
};

/**
 * The IBKR stock symbol of a job ticker: class shares use a space (BRK.B, BRK-B, BRK/B -> "BRK B").
 * Null (Yahoo only) for anything that is not a US stock ticker here: indices (^GSPC), crypto pairs
 * (BTC-USD), futures (ES=F).
 */
export const ibkrSymbol = (symbol: string): string | null => {
  const upper = symbol.trim().toUpperCase();
  const classShare = /^([A-Z][A-Z0-9]{0,9})[.\-/ ]([A-Z])$/.exec(upper);
  if (classShare !== null) return `${classShare[1]} ${classShare[2]}`;
  return /^[A-Z][A-Z0-9]{0,11}$/.test(upper) ? upper : null;
};

/** The adjusted daily bars request: `symbol` in IBKR form, `duration` such as "7 M" or "1 Y". */
export const historyBarsUrl = (
  base: string,
  symbol: string,
  duration: string
): string =>
  `${base.replace(/\/+$/, "")}/bars?${new URLSearchParams({
    barSize: ADJUSTED_DAILY.barSize,
    currency: ADJUSTED_DAILY.currency,
    duration,
    secType: ADJUSTED_DAILY.secType,
    symbol,
    useRTH: "1",
    whatToShow: ADJUSTED_DAILY.whatToShow,
  }).toString()}`;

type RawBar = Readonly<{ t: number; c: number; v: number | null }>;

const isRawBar = (bar: unknown): bar is RawBar => {
  const volume = field(bar, "v");
  return (
    Number.isInteger(field(bar, "t")) &&
    Number.isFinite(field(bar, "c")) &&
    (volume === null || (Number.isFinite(volume) && (volume as number) >= 0))
  );
};

/** A vertex-history-bars-v1 answer: bars, whether the service served its cache, and its stale flag. */
export type ParsedHistory = Readonly<{
  bars: HistoryBar[];
  cached: boolean;
  stale: boolean;
}>;

/**
 * Bars of a vertex-history-bars-v1 document, ascending, volume in shares; bars without a positive
 * close are dropped. `cached` is the service's cache flag (no IB request was made); `stale` marks the
 * copy the service serves while it is paced or the gateway is down (it can lack the newest day).
 * Throws when the document is not the answer to this request (schema, source, request echo, count,
 * cache flags, bar fields).
 */
export const parseHistoryBars = (
  document: unknown,
  symbol: string,
  duration: string
): ParsedHistory => {
  const request = field(document, "request");
  const bars = field(document, "bars");
  const stale = dig(document, "cache", "stale");
  const cached = dig(document, "cache", "hit");
  if (
    field(document, "schema") !== "vertex-history-bars-v1" ||
    field(document, "source") !== "ibkr-gateway" ||
    typeof stale !== "boolean" ||
    typeof cached !== "boolean" ||
    Object.entries({ ...ADJUSTED_DAILY, duration, symbol }).some(
      ([key, value]) => field(request, key) !== value
    ) ||
    !Array.isArray(bars) ||
    bars.length > MAX_BARS ||
    field(document, "count") !== bars.length ||
    !bars.every(isRawBar)
  )
    throw new Error("IBKR history response failed validation");
  return {
    bars: bars
      .filter((bar) => bar.c > 0)
      .sort((a, b) => a.t - b.t)
      .map((bar) => ({
        close: bar.c,
        date: isoDay(bar.t * 1000),
        volume: bar.v === null ? null : bar.v * STK_VOLUME_LOT,
      })),
    cached,
    stale,
  };
};

/**
 * One classified answer. bars: use them. wait: the service is paced or busy (or sent its stale
 * copy); ask again after `seconds` (null: the reader's gap). stop: IBKR must not be asked again in
 * this run (pacing violation, token refused). fail: Yahoo serves this symbol.
 */
export type HistoryAnswer =
  | Readonly<{ kind: "bars"; bars: HistoryBar[]; cached: boolean }>
  | Readonly<{ kind: "wait"; seconds: number | null; message: string }>
  | Readonly<{ kind: "stop"; message: string }>
  | Readonly<{ kind: "fail"; message: string }>
  | Readonly<{ kind: "reject"; message: string }>;

const WAIT_ERRORS: readonly string[] = ["paced", "busy"];

// Status, the service's error kind and its retry time: no free text from the response.
const failure = async (
  response: Response,
  token: string
): Promise<HistoryAnswer> => {
  const body: unknown = await response.json().catch(() => null);
  const kind = field(body, "error");
  const known = typeof kind === "string" && /^[a-z_]{1,40}$/.test(kind);
  const named = known ? ` (${kind})` : "";
  const retry = Number(
    field(body, "retry_after_seconds") ?? response.headers.get("retry-after")
  );
  const seconds =
    response.status === 429 && Number.isFinite(retry) && retry > 0
      ? Math.ceil(retry)
      : null;
  const message = `IBKR history HTTP ${response.status}${named}${
    seconds === null ? "" : `, retry in ${seconds} s`
  }`.replaceAll(token, "[redacted]");
  if (response.status === 401 || response.status === 403)
    return { kind: "stop", message };
  // The service's answers about this symbol only (bad_request, no_contract). Any other status, a
  // proxy 404 included, is a failure and counts toward the stop.
  if (response.status === 400 || response.status === 422)
    return { kind: "reject", message };
  if (response.status !== 429) return { kind: "fail", message };
  if (
    known &&
    WAIT_ERRORS.includes(kind) &&
    (seconds === null || seconds <= MAX_WAIT_SECONDS)
  )
    return { kind: "wait", message, seconds };
  return { kind: "stop", message };
};

/**
 * One request for the adjusted daily bars of `symbol` (IBKR form). GET, bearer token, 45 s timeout,
 * redirects never followed, no retry here (the reader decides). Messages are safe to log.
 */
export const requestHistoryBars = async (
  io: Pick<LensIo, "fetch">,
  config: HistoryConfig,
  symbol: string,
  duration: string
): Promise<HistoryAnswer> => {
  let response: Response;
  try {
    response = await io.fetch(historyBarsUrl(config.url, symbol, duration), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
      },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // The runtime's message can name the URL: report the kind only.
    return {
      kind: "fail",
      message:
        field(error, "name") === "TimeoutError"
          ? "IBKR history request timed out"
          : "IBKR history request failed",
    };
  }
  if (response.status !== 200) return failure(response, config.token);
  const document: unknown = await response.json().catch(() => null);
  let parsed: ParsedHistory;
  try {
    parsed = parseHistoryBars(document, symbol, duration);
  } catch (error) {
    return { kind: "fail", message: messageOf(error) };
  }
  return parsed.stale
    ? {
        kind: "wait",
        message: "IBKR history answered with a stale copy (service paced)",
        seconds: null,
      }
    : { bars: parsed.bars, cached: parsed.cached, kind: "bars" };
};

/**
 * The merge rule (pure). `ibkr` and `yahoo` ascend by date. With IBKR bars: every IBKR bar, and the
 * Yahoo bars older than IBKR's oldest bar before them (Yahoo never fills between or after IBKR
 * bars). Without IBKR bars: the Yahoo series.
 */
export const mergeBars = <T extends Dated>(
  ibkr: readonly T[],
  yahoo: readonly T[]
): Sourced<T>[] => {
  const oldest = ibkr[0];
  const filler =
    oldest === undefined
      ? yahoo
      : yahoo.filter((bar) => bar.date < oldest.date);
  return [
    ...filler.map((bar) => ({ ...bar, source: "yahoo" as const })),
    ...ibkr.map((bar) => ({ ...bar, source: "ibkr" as const })),
  ];
};

/** The latest day (YYYY-MM-DD) a complete window of `days` calendar days ending at `now` may start. */
export const fillBeforeDay = (now: Date, days: number): string =>
  isoDay(now.getTime() - (days - WINDOW_SLACK_DAYS) * DAY_MS);

export type MergedBarsPlan<T extends Dated> = Readonly<{
  /** The job's ticker (BRK.B); the IBKR and Yahoo forms are derived from it. */
  symbol: string;
  /** IBKR duration of the window the job needs: "7 M", "1 Y". */
  duration: string;
  /** Yahoo fills the older days when IBKR's oldest bar is later than this day (fillBeforeDay). */
  fillBefore: string;
  /** One IBKR bar in the job's form. */
  fromIbkr: (bar: HistoryBar) => T;
  /** The job's existing Yahoo read of the whole window, ascending. Throws the job's error. */
  yahoo: () => Promise<readonly T[]>;
}>;

export type HistoryReader = Readonly<{
  /** False: the environment has no usable service address and token; every read is Yahoo's. */
  configured: boolean;
  /**
   * IBKR first, Yahoo for the gaps (mergeBars). A Yahoo failure of a whole-series read is thrown;
   * a failed read of the older days keeps the IBKR bars.
   */
  load: <T extends Dated>(plan: MergedBarsPlan<T>) => Promise<Sourced<T>[]>;
}>;

/**
 * The IBKR run budget in minutes from LENS_IBKR_BUDGET_MINUTES: a whole number 0..75; unset or
 * empty is IBKR_BUDGET_MINUTES; anything else is null (not acceptable).
 */
export const ibkrBudgetMinutes = (env: LensIo["env"]): number | null => {
  const raw = env[IBKR_BUDGET_ENV]?.trim() ?? "";
  if (raw === "") return IBKR_BUDGET_MINUTES;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const minutes = Number(raw);
  return minutes <= IBKR_BUDGET_MAX ? minutes : null;
};

/**
 * The folder of the IBKR day cache inside the rotation matrix job's per-day cache folder (that job
 * deletes older days). Both jobs use it: a name the rotation matrix read today costs deep value no
 * IBKR request, and a second run of either job costs none either.
 */
export const IBKR_CACHE_DIR = "_ibkr-bars";

/**
 * The trading day of a run (YYYY-MM-DD, New York): the name of the per-day cache folders. A UTC date
 * would file an evening run's bars under the next day, and the next day's run would read them as
 * that day's bars.
 */
export const lensDay = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/New_York",
    year: "numeric",
  }).format(now);

// 16:15 New York: the day's close is final at the service by then.
const CLOSE_SETTLED_MINUTE = 16 * 60 + 15;

/**
 * True from 16:15 New York time to midnight. Only then does the day cache take IBKR bars: a run
 * before the close would store an unfinished or previous day's bar, and the evening runs would
 * reuse it.
 */
export const afterClose = (now: Date): boolean => {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).formatToParts(now);
  const part = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute") >= CLOSE_SETTLED_MINUTE;
};

/** The day-cache file of one IBKR request: "BRK B" + "1 Y" -> "BRK_B.1Y.json". */
export const cacheName = (symbol: string, duration: string): string =>
  `${symbol.replaceAll(" ", "_")}.${duration.replaceAll(" ", "")}.json`;

const isHistoryBar = (bar: unknown): bar is HistoryBar => {
  const volume = field(bar, "volume");
  const close = field(bar, "close");
  return (
    typeof field(bar, "date") === "string" &&
    typeof close === "number" &&
    close > 0 &&
    (volume === null || (typeof volume === "number" && volume >= 0))
  );
};

/** Bars a run stored today for this request; null when there is no usable file. */
export const readCachedBars = async (
  fs: LensIo["fs"],
  file: string
): Promise<HistoryBar[] | null> => {
  if (!fs.exists(file)) return null;
  try {
    const bars: unknown = JSON.parse(await fs.readFile(file));
    return Array.isArray(bars) && bars.length > 0 && bars.every(isHistoryBar)
      ? bars
      : null;
  } catch {
    return null;
  }
};

const yahooOnly: HistoryReader = {
  configured: false,
  load: async (plan) => mergeBars([], await plan.yahoo()),
};

/**
 * One reader per run: it holds the request queue, the next allowed request time, the count of
 * failures in a row and the run budget. `ibkrFirst` lists the job's tickers that IBKR may serve (our
 * names); every other ticker is Yahoo's. The job loads those tickers first, so IBKR asks for them in
 * the job's order.
 */
export const createHistoryReader = (
  io: Pick<LensIo, "env" | "fetch" | "fs" | "now" | "sleep" | "stderr">,
  ibkrFirst: Iterable<string> = [],
  cacheDir: string | null = null
): HistoryReader => {
  const config = historyConfig(io.env);
  if (config === null) {
    if (io.env["VERTEX_HISTORY_URL"] && io.env["VERTEX_DEPLOY_STATUS_TOKEN"])
      logLine(
        io,
        "IBKR history not used: VERTEX_HISTORY_URL must be https (or http on 127.0.0.1, localhost or [::1]) without credentials, and VERTEX_DEPLOY_STATUS_TOKEN at least 32 characters; Yahoo only"
      );
    return yahooOnly;
  }
  const budget = ibkrBudgetMinutes(io.env);
  if (budget === null || budget === 0) {
    logLine(
      io,
      budget === 0
        ? `IBKR history off: ${IBKR_BUDGET_ENV} is 0; Yahoo only`
        : `IBKR history not used: ${IBKR_BUDGET_ENV} must be a whole number of minutes from 0 to ${IBKR_BUDGET_MAX}; Yahoo only`
    );
    return yahooOnly;
  }
  const allowed = new Set(
    [...ibkrFirst].map((symbol) => symbol.trim().toUpperCase())
  );
  let queue: Promise<unknown> = Promise.resolve();
  let failures = 0;
  let stopped = false;
  let deadline: number | null = null;
  let nextAt = 0;
  const clock = (): number => io.now().getTime();

  const stop = (reason: string): readonly HistoryBar[] => {
    stopped = true;
    logLine(
      io,
      `IBKR history: ${reason}; not asked again in this run, Yahoo serves the remaining symbols`
    );
    return [];
  };

  const failed = (label: string, message: string): readonly HistoryBar[] => {
    failures += 1;
    logLine(io, `${label}: ${message}; Yahoo serves this symbol`);
    return failures >= IBKR_MAX_FAILURES
      ? stop(`${IBKR_MAX_FAILURES} failures in a row`)
      : [];
  };

  // Sleeps until the next request may go; false when the run budget ends first.
  const nextTurn = async (end: number): Promise<boolean> => {
    const wait = Math.max(0, nextAt - clock());
    if (clock() + wait >= end) return false;
    if (wait > 0) await io.sleep(wait);
    return true;
  };

  // What one answer means for the symbol: bars, [] (Yahoo serves it) or null (ask again).
  const settle = (
    label: string,
    answer: HistoryAnswer,
    waits: number
  ): readonly HistoryBar[] | null => {
    if (answer.kind === "bars") {
      if (answer.bars.length > 0) failures = 0;
      nextAt = answer.cached ? 0 : clock() + IBKR_GAP_MS;
      return answer.bars;
    }
    if (answer.kind === "stop") return stop(`${label}: ${answer.message}`);
    // A failed request may have reached IB: the gap applies to it as well.
    nextAt =
      clock() +
      (answer.kind === "wait" && answer.seconds !== null
        ? answer.seconds * 1000
        : IBKR_GAP_MS);
    if (answer.kind === "fail") return failed(label, answer.message);
    if (answer.kind === "reject") {
      logLine(io, `${label}: ${answer.message}; Yahoo serves this symbol`);
      return [];
    }
    return waits >= IBKR_PACED_TRIES
      ? failed(label, `${answer.message}; ${IBKR_PACED_TRIES} answers to wait`)
      : null;
  };

  // Never rejects, so the queue keeps running. No bars: Yahoo serves the symbol.
  const ask = async (
    label: string,
    symbol: string,
    duration: string
  ): Promise<readonly HistoryBar[]> => {
    if (stopped) return [];
    deadline ??= clock() + budget * 60_000;
    for (let waits = 1; ; waits += 1) {
      if (!(await nextTurn(deadline)))
        return stop(`run budget of ${budget} min used`);
      const settled = settle(
        label,
        await requestHistoryBars(io, config, symbol, duration),
        waits
      );
      if (settled !== null) return settled;
    }
  };

  // Today's cached bars, else one queued request (stored in the day cache after the close).
  const ibkrBars = async (
    label: string,
    symbol: string,
    duration: string
  ): Promise<readonly HistoryBar[]> => {
    const file =
      cacheDir === null ? null : join(cacheDir, cacheName(symbol, duration));
    const cached = file === null ? null : await readCachedBars(io.fs, file);
    if (cached !== null) return cached;
    // One request at a time, in the order the job asked.
    const turn = queue.then(() => ask(label, symbol, duration));
    queue = turn;
    const answer = await turn;
    // The bars are used even when the day cache cannot be written.
    if (file !== null && answer.length > 0 && afterClose(io.now()))
      await writeAtomic(io.fs, file, JSON.stringify(answer)).catch(() =>
        logLine(io, `${label}: IBKR day cache not written`)
      );
    return answer;
  };

  return {
    configured: true,
    load: async (plan) => {
      const symbol = allowed.has(plan.symbol.trim().toUpperCase())
        ? ibkrSymbol(plan.symbol)
        : null;
      let answer: readonly HistoryBar[] = [];
      if (symbol !== null)
        answer = await ibkrBars(plan.symbol, symbol, plan.duration);
      const ibkr = answer.map((bar) => plan.fromIbkr(bar));
      const oldest = ibkr[0];
      if (oldest === undefined) return mergeBars(ibkr, await plan.yahoo());
      if (oldest.date <= plan.fillBefore) return mergeBars(ibkr, []);
      // A failed read of the older days keeps the IBKR bars.
      return mergeBars(ibkr, await plan.yahoo().catch(() => []));
    },
  };
};

/** Which sources one series uses; null for an empty series. */
export const seriesSource = (
  bars: readonly Readonly<{ source: BarSource }>[]
): SeriesSource | null => {
  const first = bars[0];
  if (first === undefined) return null;
  return bars.every((bar) => bar.source === first.source)
    ? first.source
    : "mixed";
};

/** Series per source; empty series (null) are not counted. */
export const sourceCounts = (
  series: readonly (SeriesSource | null)[]
): SourceCounts => {
  const counts = { ibkr: 0, mixed: 0, yahoo: 0 };
  for (const source of series) if (source !== null) counts[source] += 1;
  return counts;
};

/**
 * The provenance text of a job's bars. `labels.yahoo` (the text before IBKR) when IBKR is not
 * configured and no series holds IBKR bars; else `labels.merged` and the count of names per source.
 * At most 300 characters (the lens contracts) for labels up to 150 characters.
 */
export const sourceLabel = (
  labels: Readonly<{ yahoo: string; merged: string }>,
  counts: SourceCounts,
  configured: boolean
): string =>
  configured || counts.ibkr + counts.mixed > 0
    ? `${labels.merged}; names: ${counts.ibkr} IBKR, ${counts.mixed} IBKR with older days from Yahoo, ${counts.yahoo} Yahoo`
    : labels.yahoo;
