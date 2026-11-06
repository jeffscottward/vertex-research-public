import { z } from "zod";

import type {
  SignalAlertCondition,
  SignalAlertFrequency,
  SignalAlertSource,
  SignalAlertTimeframe,
} from "./contracts/signal-alerts.ts";

// Pure signal alert logic (priceAlerts.signals.*): Yahoo OHLC bars, indicator lines, the condition
// evaluator, the run planner, the backfill count and the deterministic watch proposal parser. A
// signal alert compares two lines on one symbol's bars (price, a value, an SMA/EMA, the N-bar
// high/low before the bar, or the session opening range), so the built-in strategies (SMA cross,
// breakout) and agent-proposed watches are the same rule. Evaluation is arithmetic only: no model
// call runs in the tick loop. The network call lives in server/signal-alerts.ts. Research only.

/** Fixed notification text. Symbols, prices and conditions are never interpolated. */
export const SIGNAL_ALERT_NOTIFICATION = Object.freeze({
  body: "A signal alert or watch fired. Open Vertex to review it. This is not an instruction to trade.",
  title: "Vertex signal alert",
});

export const SIGNAL_ALERT_TIMEFRAME_MS: Readonly<
  Record<SignalAlertTimeframe, number>
> = Object.freeze({
  "1d": 24 * 60 * 60_000,
  "1h": 60 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
});

/** Yahoo history per timeframe: the longest window Yahoo serves for that interval (backfill depth). */
const YAHOO_RANGE: Readonly<Record<SignalAlertTimeframe, string>> =
  Object.freeze({
    "1d": "2y",
    "1h": "1y",
    "5m": "30d",
    "15m": "60d",
  });

/**
 * Futures roots the watch parser reads as continuous contracts (NQ -> NQ=F). Only roots that are not
 * also listed stock tickers: ES (Eversource), CL (Colgate), GC and SI stay stock symbols unless the
 * request writes the contract (ES=F).
 */
const WATCH_FUTURES_ROOTS: ReadonlySet<string> = new Set([
  "MES",
  "MNQ",
  "NQ",
  "RTY",
]);

/** Yahoo's symbol: contracts (NQ=F) as written; class shares use a dash (BRK.B -> BRK-B). */
export const yahooSymbolOf = (symbol: string): string =>
  symbol.endsWith("=F") ? symbol : symbol.replace(/[./]/gu, "-");

/** Yahoo chart URL for one symbol and timeframe, regular session only. */
export const signalAlertChartUrl = (
  symbol: string,
  timeframe: SignalAlertTimeframe
): string =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbolOf(symbol))}?range=${YAHOO_RANGE[timeframe]}&interval=${timeframe === "1h" ? "60m" : timeframe}`;

const nullableNumbers = z.array(z.number().nullable()).optional();

const YahooOhlcChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          indicators: z.object({
            quote: z
              .array(
                z.object({
                  close: nullableNumbers,
                  high: nullableNumbers,
                  low: nullableNumbers,
                  open: nullableNumbers,
                })
              )
              .optional(),
          }),
          timestamp: z.array(z.number()).optional(),
        })
      )
      .nullable(),
  }),
});

export type SignalBar = Readonly<{
  start: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}>;

export type SignalBarsResult =
  | Readonly<{ ok: true; bars: readonly SignalBar[] }>
  | Readonly<{ ok: false; reason: string }>;

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

/** New York calendar day and minute of the day (the US equity session clock). */
export const newYorkClock = (
  date: Date
): Readonly<{ day: string; minute: number }> => {
  const parts = Object.fromEntries(
    NEW_YORK_CLOCK.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    day: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    minute: Number(parts["hour"]) * 60 + Number(parts["minute"]),
  };
};

/** 09:30 and 16:00 New York: the regular US equity session. */
const SESSION_OPEN_MINUTE = 9 * 60 + 30;
const SESSION_CLOSE_MINUTE = 16 * 60;

/**
 * OHLC bars from a Yahoo chart document, oldest first. Bars missing a price are dropped. A row that
 * falls inside the previous bar's interval (Yahoo's live row stamped with the last trade time, or a
 * second daily row on the same New York day) is merged into that bar, so a forming bar keeps one
 * stable start.
 */
export const barsFromYahooChart = (
  raw: unknown,
  timeframe: SignalAlertTimeframe
): SignalBarsResult => {
  const parsed = YahooOhlcChartSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: "Yahoo returned an unexpected document" };
  const result = parsed.data.chart.result?.[0];
  if (result === undefined)
    return { ok: false, reason: "Yahoo has no data for this symbol" };
  const quote = result.indicators.quote?.[0];
  const rows = (result.timestamp ?? []).flatMap((time, index) => {
    const open = quote?.open?.[index];
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    const close = quote?.close?.[index];
    if (!(positive(open) && positive(high) && positive(low) && positive(close)))
      return [];
    return [{ close, high, low, open, start: new Date(time * 1000) }];
  });
  rows.sort((left, right) => left.start.getTime() - right.start.getTime());
  const width = SIGNAL_ALERT_TIMEFRAME_MS[timeframe];
  const bars: SignalBar[] = [];
  for (const row of rows) {
    const previous = bars.at(-1);
    const sameBar =
      previous !== undefined &&
      (timeframe === "1d"
        ? newYorkClock(previous.start).day === newYorkClock(row.start).day
        : row.start.getTime() < previous.start.getTime() + width);
    if (previous === undefined || !sameBar) {
      bars.push(row);
      continue;
    }
    bars[bars.length - 1] = {
      close: row.close,
      high: Math.max(previous.high, row.high),
      low: Math.min(previous.low, row.low),
      open: previous.open,
      start: previous.start,
    };
  }
  if (bars.length === 0)
    return { ok: false, reason: "Yahoo has no bars for this symbol" };
  return { bars, ok: true };
};

/** Futures contracts (NQ=F) trade around the clock; everything else follows the regular session. */
export const isRegularSession = (symbol: string): boolean =>
  !symbol.endsWith("=F");

/**
 * When a bar closes: the earliest of its full interval, the next bar's start and, for
 * regular-session symbols, 16:00 New York on its day (a daily stock bar closes at the close, not 24
 * hours after the open; the 15:30 hourly bar closes at 16:00).
 */
export const barCloseTime = (
  bars: readonly SignalBar[],
  index: number,
  timeframe: SignalAlertTimeframe,
  regularSession: boolean
): number => {
  const bar = bars[index];
  if (bar === undefined) return Number.POSITIVE_INFINITY;
  const start = bar.start.getTime();
  const minute = newYorkClock(bar.start).minute;
  const sessionClose =
    regularSession && minute < SESSION_CLOSE_MINUTE
      ? start + (SESSION_CLOSE_MINUTE - minute) * 60_000
      : Number.POSITIVE_INFINITY;
  return Math.min(
    start + SIGNAL_ALERT_TIMEFRAME_MS[timeframe],
    bars[index + 1]?.start.getTime() ?? Number.POSITIVE_INFINITY,
    sessionClose
  );
};

/** Which bars are closed at `now` (see barCloseTime). */
export const closedBars = (
  bars: readonly SignalBar[],
  timeframe: SignalAlertTimeframe,
  now: Date,
  regularSession: boolean
): boolean[] =>
  bars.map(
    (_, index) =>
      barCloseTime(bars, index, timeframe, regularSession) <= now.getTime()
  );

/** One value per bar for a source line; null where the line is not defined yet. */
export const sourceLine = (
  source: SignalAlertSource,
  bars: readonly SignalBar[],
  timeframe: SignalAlertTimeframe
): (number | null)[] => {
  switch (source.type) {
    case "price":
      return bars.map((bar) => bar[source.field]);
    case "value":
      return bars.map(() => Number(source.value));
    case "sma": {
      let sum = 0;
      return bars.map((bar, index) => {
        sum += bar.close;
        const old = bars[index - source.period];
        if (old !== undefined) sum -= old.close;
        return index + 1 >= source.period ? sum / source.period : null;
      });
    }
    case "ema": {
      // Seeded with the SMA of the first `period` closes, then the usual recursive EMA.
      const alpha = 2 / (source.period + 1);
      let value = 0;
      return bars.map((bar, index) => {
        if (index < source.period) {
          value += bar.close / source.period;
          return index + 1 === source.period ? value : null;
        }
        value = alpha * bar.close + (1 - alpha) * value;
        return value;
      });
    }
    case "highest":
    case "lowest":
      // The N bars before this one, so "close crosses above the 20-bar high" is a breakout.
      return bars.map((_, index) => {
        if (index < source.period) return null;
        const window = bars.slice(index - source.period, index);
        return source.type === "highest"
          ? Math.max(...window.map((bar) => bar.high))
          : Math.min(...window.map((bar) => bar.low));
      });
    case "opening-range": {
      // The high/low of the bars from 09:30 New York through the first `minutes`, defined once that
      // window is complete; bars before 09:30 (futures overnight) never count. Daily bars have none.
      const width = SIGNAL_ALERT_TIMEFRAME_MS[timeframe] / 60_000;
      const end = SESSION_OPEN_MINUTE + source.minutes;
      let day = "";
      let high: number | null = null;
      let low: number | null = null;
      return bars.map((bar) => {
        if (timeframe === "1d") return null;
        const clock = newYorkClock(bar.start);
        if (clock.day !== day) {
          day = clock.day;
          high = null;
          low = null;
        }
        if (clock.minute < SESSION_OPEN_MINUTE) return null;
        if (clock.minute + width <= end) {
          high = Math.max(high ?? bar.high, bar.high);
          low = Math.min(low ?? bar.low, bar.low);
          return null;
        }
        return source.side === "high" ? high : low;
      });
    }
  }
};

/**
 * Whether the condition holds on each bar (false where a line is undefined). A crossing needs both
 * lines on the bar before, except the bar right after an opening range completes: the last range
 * bar closed inside the range, so that bar is compared with the range itself.
 */
export const conditionSeries = (
  condition: SignalAlertCondition,
  bars: readonly SignalBar[],
  timeframe: SignalAlertTimeframe
): boolean[] => {
  const left = sourceLine(condition.left, bars, timeframe);
  const right = sourceLine(condition.right, bars, timeframe);
  const rangeStart = condition.right.type === "opening-range";
  return bars.map((_, index) => {
    const l = left[index];
    const r = right[index];
    if (l === null || l === undefined || r === null || r === undefined)
      return false;
    if (condition.operator === "above") return l > r;
    if (condition.operator === "below") return l < r;
    const pl = left[index - 1];
    const pr = right[index - 1] ?? (rangeStart ? r : null);
    if (pl === null || pl === undefined || pr === null) return false;
    const up = pl <= pr && l > r;
    const down = pl >= pr && l < r;
    if (condition.operator === "crosses-above") return up;
    if (condition.operator === "crosses-below") return down;
    return up || down;
  });
};

export type SignalAlertBackfill = Readonly<{
  /** Times the rule would have fired on closed bars in the window. */
  count: number;
  /** Closed bars evaluated. */
  bars: number;
  /** Calendar days the window spans. */
  days: number;
  from: Date | null;
  to: Date | null;
  /** The most recent fires, newest first (at most 5). */
  recent: Date[];
}>;

/**
 * Backfill: how often the rule would have fired over the closed history. "once" counts every bar the
 * condition held, as LuxAlgo does ("would have fired N times"), because the live rule rings once.
 */
export const backfillSignalAlert = (
  condition: SignalAlertCondition,
  bars: readonly SignalBar[],
  timeframe: SignalAlertTimeframe,
  now: Date,
  regularSession: boolean
): SignalAlertBackfill => {
  const closedFlags = closedBars(bars, timeframe, now, regularSession);
  const closed = bars.filter((_, index) => closedFlags[index]);
  const series = conditionSeries(condition, closed, timeframe);
  const fires = closed.filter((_, index) => series[index]);
  const from = closed[0]?.start ?? null;
  const to = closed.at(-1)?.start ?? null;
  const days =
    from === null || to === null
      ? 0
      : Math.max(
          1,
          Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60_000))
        );
  return {
    bars: closed.length,
    count: fires.length,
    days,
    from,
    recent: fires
      .slice(-5)
      .reverse()
      .map((bar) => bar.start),
    to,
  };
};

export type SignalAlertCursor = Readonly<{
  /** When the rule became active (created active, or a proposed watch started). */
  activeSince: Date;
  /** Start of the newest closed bar already evaluated; null before the first run. */
  lastBarAt: Date | null;
  /** Start of the bar that last fired; a bar fires at most once. */
  lastFiredBarAt: Date | null;
}>;

export type SignalAlertFire = Readonly<{ barAt: Date; price: number }>;

export type SignalAlertEvaluation = Readonly<{
  fires: SignalAlertFire[];
  /** New lastBarAt: the newest closed bar seen (unchanged when there is none). */
  lastBarAt: Date | null;
  /** "once" rules are done after their first fire. */
  done: boolean;
}>;

/** At most this many fires per rule per run (a long gap between runs never floods the owner). */
export const SIGNAL_ALERT_MAX_FIRES_PER_RUN = 3;
/** A closed bar older than this many bar widths moves the cursor but never fires (stale after a gap). */
export const SIGNAL_ALERT_STALE_BARS = 2;

/**
 * Evaluates one rule on fresh bars. Closed bars after the cursor are evaluated; the forming bar is
 * evaluated too unless the rule fires per bar close. A bar that closed before the rule was active
 * never fires (nor a forming bar that began more than one bar width before), and neither does a
 * closed bar that closed more than two bar widths ago (after a gap the cursor just moves past it).
 */
export const evaluateSignalAlert = (
  rule: Readonly<{
    condition: SignalAlertCondition;
    frequency: SignalAlertFrequency;
    timeframe: SignalAlertTimeframe;
    regularSession: boolean;
  }>,
  cursor: SignalAlertCursor,
  bars: readonly SignalBar[],
  now: Date
): SignalAlertEvaluation => {
  const width = SIGNAL_ALERT_TIMEFRAME_MS[rule.timeframe];
  const series = conditionSeries(rule.condition, bars, rule.timeframe);
  const activeSince = cursor.activeSince.getTime();
  const after = cursor.lastBarAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const firedAt = cursor.lastFiredBarAt?.getTime() ?? null;
  const staleBefore = now.getTime() - SIGNAL_ALERT_STALE_BARS * width;
  let lastBarAt = cursor.lastBarAt;
  const fires: SignalAlertFire[] = [];
  bars.forEach((bar, index) => {
    const time = bar.start.getTime();
    const close = barCloseTime(
      bars,
      index,
      rule.timeframe,
      rule.regularSession
    );
    const closed = close <= now.getTime();
    if (closed && (lastBarAt === null || time > lastBarAt.getTime()))
      lastBarAt = bar.start;
    if (!series[index] || time === firedAt) return;
    if (closed) {
      // Closed before the rule was active, already evaluated, or stale after a gap.
      if (close <= activeSince || time <= after || close < staleBefore) return;
    } else if (rule.frequency === "per-bar-close" || time < activeSince - width)
      return;
    fires.push({ barAt: bar.start, price: bar.close });
  });
  const limited =
    rule.frequency === "once"
      ? fires.slice(0, 1)
      : fires.slice(-SIGNAL_ALERT_MAX_FIRES_PER_RUN);
  return {
    done: rule.frequency === "once" && limited.length > 0,
    fires: limited,
    lastBarAt,
  };
};

export type SignalAlertSeriesPlan<Rule> = Readonly<{
  symbol: string;
  timeframe: SignalAlertTimeframe;
  rules: Rule[];
}>;

/** Groups rules by symbol and timeframe, keeping at most `maxSeries` distinct series per run. */
export const planSignalAlertRun = <
  Rule extends Readonly<{ symbol: string; timeframe: SignalAlertTimeframe }>,
>(
  rules: readonly Rule[],
  maxSeries: number
): Readonly<{
  series: Map<string, SignalAlertSeriesPlan<Rule>>;
  deferred: Rule[];
}> => {
  const series = new Map<string, SignalAlertSeriesPlan<Rule>>();
  const deferred: Rule[] = [];
  for (const rule of rules) {
    const key = `${rule.symbol}|${rule.timeframe}`;
    const group = series.get(key);
    if (group !== undefined) group.rules.push(rule);
    else if (series.size < maxSeries)
      series.set(key, {
        rules: [rule],
        symbol: rule.symbol,
        timeframe: rule.timeframe,
      });
    else deferred.push(rule);
  }
  return { deferred, series };
};

const describeSource = (source: SignalAlertSource): string => {
  switch (source.type) {
    case "price":
      return source.field;
    case "value":
      return source.value;
    case "sma":
    case "ema":
      return `${source.type.toUpperCase()}(${source.period})`;
    case "highest":
      return `${source.period}-bar high`;
    case "lowest":
      return `${source.period}-bar low`;
    case "opening-range":
      return `${source.minutes}m opening range ${source.side}`;
  }
};

/** Readable condition, e.g. "close crosses above SMA(50)". */
export const describeSignalCondition = (
  condition: SignalAlertCondition
): string =>
  `${describeSource(condition.left)} ${condition.operator.replace("-", " ")} ${describeSource(condition.right)}`;

export type SignalWatchProposal = Readonly<{
  symbol: string;
  timeframe: SignalAlertTimeframe;
  frequency: SignalAlertFrequency;
  condition: SignalAlertCondition;
  /** The sentence Quant shows on the proposal card. */
  summary: string;
}>;

export type SignalWatchParse =
  | Readonly<{ ok: true; proposal: SignalWatchProposal }>
  | Readonly<{ ok: false; reason: string }>;

const TIMEFRAME_WORDS: ReadonlyArray<readonly [RegExp, SignalAlertTimeframe]> =
  [
    [/\b(5|five)[ -]?(m|min|minute)s?\b/u, "5m"],
    [/\b(15|fifteen)[ -]?(m|min|minute)s?\b/u, "15m"],
    [/\b(1|one)[ -]?(h|hr|hour)s?\b|\bhourly\b/u, "1h"],
    [/\b(1|one)[ -]?(d|day)\b|\bdaily\b/u, "1d"],
  ];

/** Filler words that may sit between "watch" and the symbol ("watch for the SPY ..."). */
const FILLER = "(?:(?:for|the|out|on|me|over)\\s+)*";
const SYMBOL_AFTER_WATCH = new RegExp(
  `\\bwatch\\s+${FILLER}\\$?([A-Za-z][A-Za-z0-9.=-]{0,9})\\b`,
  "iu"
);
const STOP_WORDS: ReadonlySet<string> = new Set([
  "A",
  "ALERTS",
  "AND",
  "IF",
  "IT",
  "ME",
  "MY",
  "OPENING",
  "PRICE",
  "WHEN",
]);

/** A number with optional thousands separators: "21,500.25" -> "21500.25". */
const LEVEL =
  /(?:above|over|below|under)\s+\$?(\d{1,3}(?:,\d{3})+|\d{1,9})(\.\d{1,4})?/u;

/**
 * Turns a plain-language watch request into a proposed rule, deterministically (no model call):
 * "Watch NQ and wake me when a 15m bar closes above the opening range". Supported targets: a number,
 * the opening range, an N SMA/EMA (or moving average) and the N-bar high/low. It refuses rather than
 * guesses: no symbol, both or neither of above/below, or a "day" average on an intraday timeframe.
 */
export const parseWatchRequest = (text: string): SignalWatchParse => {
  const raw = text.trim().slice(0, 500);
  const lower = raw.toLowerCase();
  // The word after "watch", else a $TICKER, else "on TICKER"; keywords are never symbols.
  const written = [
    SYMBOL_AFTER_WATCH.exec(raw)?.[1],
    /\$([A-Za-z][A-Za-z0-9.-]{0,9})\b/u.exec(raw)?.[1],
    /\bon\s+\$?([A-Z][A-Z0-9.=-]{0,9})\b/u.exec(raw)?.[1],
  ]
    .map((candidate) => candidate?.toUpperCase())
    .find(
      (candidate) =>
        candidate !== undefined &&
        !STOP_WORDS.has(candidate) &&
        /^[A-Z][A-Z0-9.-]{0,9}(?:[=]F)?$/u.test(candidate)
    );
  if (written === undefined)
    return {
      ok: false,
      reason: 'Name the symbol after "watch", e.g. "Watch NQ when ..."',
    };
  const symbol = WATCH_FUTURES_ROOTS.has(written) ? `${written}=F` : written;
  const timeframe =
    TIMEFRAME_WORDS.find(([pattern]) => pattern.test(lower))?.[1] ?? "15m";
  const ups = /\b(above|over)\b/u.test(lower);
  const downs = /\b(below|under)\b/u.test(lower);
  if (ups === downs)
    return {
      ok: false,
      reason: ups
        ? 'Say either "above" or "below", not both'
        : 'Say "above" or "below" the level to watch',
    };
  const direction = ups ? "above" : "below";
  const closes = /\bclos(e|es|ing)\b/u.test(lower);
  const crossing = closes || /\bcross(es|ing)?\b|\bbreaks?\b/u.test(lower);
  let right: SignalAlertSource | null = null;
  const ma =
    /\b(\d{1,3})[ -]?(period|bar|day)?[ -]?(sma|ema|ma|moving average)\b/u.exec(
      lower
    );
  const range = /\b(\d{1,3})[ -]?(bar|period|day)\s+(high|low)\b/u.exec(lower);
  if (timeframe !== "1d" && (ma?.[2] === "day" || range?.[2] === "day"))
    return {
      ok: false,
      reason: `A day average or range needs daily bars; say "daily" or use bars on ${timeframe}`,
    };
  const orMinutes =
    /\b(\d{1,3})[ -]?(?:m|min|minute)s?\s+opening range\b/u.exec(lower);
  const level = LEVEL.exec(lower);
  if (/\bopening range\b|\bor high\b|\bor low\b/u.test(lower)) {
    if (timeframe === "1d")
      return { ok: false, reason: "An opening range needs intraday bars" };
    if (timeframe === "1h" && symbol.endsWith("=F"))
      return {
        ok: false,
        reason:
          "Futures hourly bars start on the hour; use 5m or 15m bars for an opening range",
      };
    // Whole bars only: a 30-minute range on hourly bars becomes the first hour.
    const barMinutes = SIGNAL_ALERT_TIMEFRAME_MS[timeframe] / 60_000;
    const minutes = Number(orMinutes?.[1] ?? 30);
    right = {
      minutes: Math.min(
        240,
        Math.max(barMinutes, Math.ceil(minutes / barMinutes) * barMinutes)
      ),
      side: direction === "above" ? "high" : "low",
      type: "opening-range",
    };
  } else if (ma !== null) {
    right = {
      period: Math.min(500, Math.max(2, Number(ma[1]))),
      type: ma[3] === "ema" ? "ema" : "sma",
    };
  } else if (range !== null) {
    right = {
      period: Math.min(500, Math.max(2, Number(range[1]))),
      type: range[3] === "high" ? "highest" : "lowest",
    };
  } else if (level?.[1] !== undefined) {
    right = {
      type: "value",
      value: `${level[1].replaceAll(",", "")}${level[2] ?? ""}`,
    };
  }
  if (right === null)
    return {
      ok: false,
      reason:
        "Name the level: a price, the opening range, an N SMA/EMA or the N-bar high/low",
    };
  const operator = crossing
    ? direction === "above"
      ? "crosses-above"
      : "crosses-below"
    : direction;
  const condition: SignalAlertCondition = {
    left: { field: "close", type: "price" },
    operator,
    right,
  };
  const frequency: SignalAlertFrequency = closes ? "per-bar-close" : "once";
  return {
    ok: true,
    proposal: {
      condition,
      frequency,
      summary: `Watch ${symbol} on ${timeframe} bars: alert when ${describeSignalCondition(condition)}${closes ? " on bar close" : ""}.`,
      symbol,
      timeframe,
    },
  };
};
