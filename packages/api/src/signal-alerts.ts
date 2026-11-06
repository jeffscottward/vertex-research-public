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

/** OHLC bars from a Yahoo chart document, oldest first. Bars missing a price are dropped. */
export const barsFromYahooChart = (raw: unknown): SignalBarsResult => {
  const parsed = YahooOhlcChartSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: "Yahoo returned an unexpected document" };
  const result = parsed.data.chart.result?.[0];
  if (result === undefined)
    return { ok: false, reason: "Yahoo has no data for this symbol" };
  const quote = result.indicators.quote?.[0];
  const bars = (result.timestamp ?? []).flatMap((time, index) => {
    const open = quote?.open?.[index];
    const high = quote?.high?.[index];
    const low = quote?.low?.[index];
    const close = quote?.close?.[index];
    if (!(positive(open) && positive(high) && positive(low) && positive(close)))
      return [];
    return [{ close, high, low, open, start: new Date(time * 1000) }];
  });
  if (bars.length === 0)
    return { ok: false, reason: "Yahoo has no bars for this symbol" };
  bars.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { bars, ok: true };
};

/** A bar is closed once its full interval has passed. */
export const isBarClosed = (
  bar: SignalBar,
  timeframe: SignalAlertTimeframe,
  now: Date
): boolean =>
  bar.start.getTime() + SIGNAL_ALERT_TIMEFRAME_MS[timeframe] <= now.getTime();

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

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
      // The high/low of the first `minutes` of each New York session day, defined once complete.
      if (timeframe === "1d") return bars.map(() => null);
      const width = SIGNAL_ALERT_TIMEFRAME_MS[timeframe];
      const out: (number | null)[] = [];
      let day = "";
      let open = 0;
      let high = 0;
      let low = 0;
      for (const bar of bars) {
        const barDay = NEW_YORK_DAY.format(bar.start);
        const time = bar.start.getTime();
        if (barDay !== day) {
          day = barDay;
          open = time;
          high = bar.high;
          low = bar.low;
        }
        const end = open + source.minutes * 60_000;
        if (time + width <= end) {
          high = Math.max(high, bar.high);
          low = Math.min(low, bar.low);
          out.push(null);
        } else {
          out.push(source.side === "high" ? high : low);
        }
      }
      return out;
    }
  }
};

/** Whether the condition holds on each bar (false where a line is undefined). */
export const conditionSeries = (
  condition: SignalAlertCondition,
  bars: readonly SignalBar[],
  timeframe: SignalAlertTimeframe
): boolean[] => {
  const left = sourceLine(condition.left, bars, timeframe);
  const right = sourceLine(condition.right, bars, timeframe);
  return bars.map((_, index) => {
    const l = left[index];
    const r = right[index];
    if (l === null || l === undefined || r === null || r === undefined)
      return false;
    if (condition.operator === "above") return l > r;
    if (condition.operator === "below") return l < r;
    const pl = left[index - 1];
    const pr = right[index - 1];
    if (pl === null || pl === undefined || pr === null || pr === undefined)
      return false;
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
  now: Date
): SignalAlertBackfill => {
  const closed = bars.filter((bar) => isBarClosed(bar, timeframe, now));
  const series = conditionSeries(condition, closed, timeframe);
  const fires = closed.filter((_, index) => series[index] === true);
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
  createdAt: Date;
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

/**
 * Evaluates one rule on fresh bars. Closed bars after the cursor are evaluated; the forming bar is
 * evaluated too unless the rule fires per bar close. A bar that began before the rule existed (more
 * than one bar width earlier) never fires.
 */
export const evaluateSignalAlert = (
  rule: Readonly<{
    condition: SignalAlertCondition;
    frequency: SignalAlertFrequency;
    timeframe: SignalAlertTimeframe;
  }>,
  cursor: SignalAlertCursor,
  bars: readonly SignalBar[],
  now: Date
): SignalAlertEvaluation => {
  const width = SIGNAL_ALERT_TIMEFRAME_MS[rule.timeframe];
  const series = conditionSeries(rule.condition, bars, rule.timeframe);
  const floor = cursor.createdAt.getTime() - width;
  const after = cursor.lastBarAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const firedAt = cursor.lastFiredBarAt?.getTime() ?? null;
  let lastBarAt = cursor.lastBarAt;
  const fires: SignalAlertFire[] = [];
  bars.forEach((bar, index) => {
    const time = bar.start.getTime();
    const closed = isBarClosed(bar, rule.timeframe, now);
    if (closed && (lastBarAt === null || time > lastBarAt.getTime()))
      lastBarAt = bar.start;
    if (time < floor || series[index] !== true || time === firedAt) return;
    if (closed ? time <= after : rule.frequency === "per-bar-close") return;
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

const STOP_WORDS: ReadonlySet<string> = new Set([
  "A",
  "AND",
  "I",
  "ME",
  "THE",
  "WAKE",
  "WATCH",
  "WHEN",
]);

/**
 * Turns a plain-language watch request into a proposed rule, deterministically (no model call):
 * "Watch NQ and wake me when a 15m bar closes above the opening range". Supported targets: a number,
 * the opening range, an N SMA/EMA (or moving average) and the N-bar high/low.
 */
export const parseWatchRequest = (text: string): SignalWatchParse => {
  const raw = text.trim().slice(0, 500);
  const lower = raw.toLowerCase();
  const symbolMatch =
    /\bwatch\s+\$?([A-Za-z][A-Za-z0-9.=-]{0,9})\b/iu.exec(raw) ??
    /\$([A-Za-z][A-Za-z0-9.-]{0,9})\b/u.exec(raw);
  const written = symbolMatch?.[1]?.toUpperCase();
  if (
    written === undefined ||
    STOP_WORDS.has(written) ||
    !/^[A-Z][A-Z0-9.-]{0,9}(?:[=]F)?$/u.test(written)
  )
    return {
      ok: false,
      reason: 'Name the symbol after "watch", e.g. "Watch NQ when ..."',
    };
  const symbol = WATCH_FUTURES_ROOTS.has(written) ? `${written}=F` : written;
  const timeframe =
    TIMEFRAME_WORDS.find(([pattern]) => pattern.test(lower))?.[1] ?? "15m";
  const direction = /\b(above|over|up)\b/u.test(lower)
    ? "above"
    : /\b(below|under|down)\b/u.test(lower)
      ? "below"
      : null;
  if (direction === null)
    return { ok: false, reason: 'Say "above" or "below" the level to watch' };
  const closes = /\bclos(e|es|ing)\b/u.test(lower);
  const crossing = closes || /\bcross(es|ing)?\b|\bbreaks?\b/u.test(lower);
  let right: SignalAlertSource | null = null;
  const ma =
    /\b(\d{1,3})[ -]?(?:period|bar|day)?[ -]?(sma|ema|ma|moving average)\b/u.exec(
      lower
    );
  const range = /\b(\d{1,3})[ -]?(?:bar|period|day)\s+(high|low)\b/u.exec(
    lower
  );
  const orMinutes =
    /\b(\d{1,3})[ -]?(?:m|min|minute)s?\s+opening range\b/u.exec(lower);
  if (/\bopening range\b|\bor high\b|\bor low\b/u.test(lower)) {
    right = {
      minutes: Math.min(240, Math.max(5, Number(orMinutes?.[1] ?? 30))),
      side: direction === "above" ? "high" : "low",
      type: "opening-range",
    };
  } else if (ma !== null) {
    right = {
      period: Math.min(500, Math.max(2, Number(ma[1]))),
      type: ma[2] === "ema" ? "ema" : "sma",
    };
  } else if (range === null) {
    const level =
      /(?:above|over|below|under)\s+\$?(\d{1,7}(?:\.\d{1,4})?)/u.exec(lower);
    if (level?.[1] !== undefined) right = { type: "value", value: level[1] };
  } else {
    right = {
      period: Math.min(500, Math.max(2, Number(range[1]))),
      type: range[2] === "high" ? "highest" : "lowest",
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
