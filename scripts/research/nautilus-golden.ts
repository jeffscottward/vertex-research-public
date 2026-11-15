// Golden fixtures for the Python port of the instant backtest signals and costs.
// `bun run research:nautilus-golden` (scripts/research-nautilus-golden.ts) writes the output of
// buildGolden to services/research/tests/fixtures/nautilus_backtest/golden.json. The TypeScript
// code is the reference; the Python tests (test_nautilus_backtest_signals.py) compare against that
// file, and nautilus-golden.test.ts checks that the committed file still matches this code.
// The `definitionRefusals` section holds definitions that the schema refuses, each with the message
// that the Python normalize_definition must raise (test_definition_refusal_matches_typescript).
// Output is deterministic: no clock, no random source (a fixed LCG makes the synthetic bars).
// NaN values are written as null.

import { join } from "node:path";

import {
  affordableUnits,
  COST_PROFILE_PRESETS,
  type CostProfile,
  averageTrueRange as costAverageTrueRange,
  fillCosts,
  orderCharges,
} from "../../packages/api/src/backtest-costs.ts";
import {
  type BarColumns,
  InstantBacktestInputError,
  type InstantRule,
  type InstantRunResult,
  type InstantTrade,
  priorExtreme,
  rollingMean,
  runInstantBacktest,
  signalsFor,
  wilderRsi,
} from "../../packages/api/src/instant-backtest-engine.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
  type StrategyExprInput,
  StrategyExprSchema,
  type StrategyIndicatorExpr,
  type StrategyIntraday,
  type StrategyServerSupport,
  type StrategySessionIndicatorExpr,
  type StrategyTrendIndicatorExpr,
  serverStrategyRefusal,
} from "../../packages/api/src/strategy-dsl.ts";
import {
  averageDirectionalIndex,
  averageTrueRange,
  compileStrategy,
  evaluateStrategyExpression,
  exponentialMean,
  type IntradaySessions,
  intradayIndicatorSeries,
  intradaySessions,
  nyseHolidays,
  realizedVolatility,
  relativeStrength,
  relativeVolumeAtTime,
  rollingZScore,
  runStrategyDefinition,
  type SectorQuadrantSeries,
  type StrategySeriesContext,
  type StrategySeriesInput,
  StrategyUnsupportedError,
  sessionIndicatorSeries,
  volTargetLeverage,
} from "../../packages/api/src/strategy-dsl-compile.ts";

const BAR_COUNT = 500;

type Json = unknown;

const list = (values: ArrayLike<number>): (number | null)[] =>
  Array.from(values, (value) => (Number.isFinite(value) ? value : null));

const readCsv = (text: string, count: number): BarColumns => {
  const lines = text
    .trim()
    .split("\n")
    .slice(1, count + 1);
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  for (const line of lines) {
    const [date, open, high, low, close, , volume] = line.split(",");
    const [year, month, day] = (date as string).split("-").map(Number);
    columns.t.push(
      Date.UTC(year as number, (month as number) - 1, day as number)
    );
    columns.o.push(Number(open));
    columns.h.push(Number(high));
    columns.l.push(Number(low));
    columns.c.push(Number(close));
    columns.v.push(Number(volume));
  }
  return toBars(columns);
};

interface Columns {
  c: number[];
  h: number[];
  l: number[];
  o: number[];
  t: number[];
  v: number[];
}

const toBars = (columns: Columns): BarColumns => ({
  c: Float64Array.from(columns.c),
  h: Float64Array.from(columns.h),
  l: Float64Array.from(columns.l),
  o: Float64Array.from(columns.o),
  t: Float64Array.from(columns.t),
  v: Float64Array.from(columns.v),
});

const barsJson = (bars: BarColumns) => ({
  c: list(bars.c),
  h: list(bars.h),
  l: list(bars.l),
  o: list(bars.o),
  t: list(bars.t),
  v: list(bars.v as Float64Array),
});

/** Deterministic LCG in [0, 1). */
const randomFrom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

/** 5-minute bars, 13:30 to 20:00 UTC, over 12 weekdays around the March 2024 DST change. */
const intradayBars = (): BarColumns => {
  const random = randomFrom(7);
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  let price = 100;
  const start = Date.UTC(2024, 2, 4);
  for (let day = 0; day < 16; day += 1) {
    const dayStart = start + day * 86_400_000;
    const weekday = new Date(dayStart).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let minute = 13 * 60 + 30; minute < 20 * 60; minute += 5) {
      const open = price;
      const close = open * (1 + (random() - 0.5) * 0.004);
      const high = Math.max(open, close) * (1 + random() * 0.001);
      const low = Math.min(open, close) * (1 - random() * 0.001);
      columns.t.push(dayStart + minute * 60_000);
      columns.o.push(open);
      columns.h.push(high);
      columns.l.push(low);
      columns.c.push(close);
      columns.v?.push(Math.floor(1000 + random() * 9000));
      price = close;
    }
  }
  return toBars(columns);
};

/** Daily bars with a gap below a stop (bar 4) and a gap above a target (bar 9). */
const gapBars = (): BarColumns => {
  const rows: [number, number, number, number][] = [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [90, 92, 89, 91], // opens below a 5% stop
    [91, 92, 90, 91],
    [91, 92, 90, 91],
    [91, 92, 90, 91],
    [91, 92, 90, 91],
    [105, 106, 104, 105], // opens above a 10% target
    [105, 106, 104, 105],
    [105, 106, 104, 105],
  ];
  return dailyRows(rows);
};

/** Daily bars where one bar trades through both the stop and the target. */
const bothHitBars = (): BarColumns => {
  const rows: [number, number, number, number][] = [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 115, 90, 100], // low below the stop, high above the target
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 120, 99, 100], // high above the target only
    [100, 101, 99, 100],
  ];
  return dailyRows(rows);
};

const dailyRows = (rows: [number, number, number, number][]): BarColumns => {
  const start = Date.UTC(2024, 0, 2);
  return toBars({
    c: rows.map((row) => row[3]),
    h: rows.map((row) => row[1]),
    l: rows.map((row) => row[2]),
    o: rows.map((row) => row[0]),
    t: rows.map((_, index) => start + index * 86_400_000),
    v: rows.map(() => 1000),
  });
};

// Indicator timeframe "1d", breaksAbove/breaksBelow, oncePerLevel, entry.any, management and
// maxLeverage: LD34 (nested Donchian long-only breakout) as stated, on hourly bars.

const HOUR_MS = 3_600_000;

/**
 * Hourly bars around the clock from Sunday 21:00 to Friday 21:00 UTC (an FX week) over 400
 * calendar days: the session days (17:00 New York) cross both daylight saving changes, and more
 * than 260 of them make the 200-day levels active. The trend changes every 480 hours and every
 * open gaps a little from the previous close. Prices have 4 decimals.
 */
const hourlyBars = (): BarColumns => {
  const random = randomFrom(34);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  const start = Date.UTC(2023, 0, 1);
  let price = 100;
  let drift = 0;
  for (let hour = 0; hour < 400 * 24; hour += 1) {
    if (hour % 480 === 0) drift = (random() - 0.4) * 0.0008;
    const t = start + hour * HOUR_MS;
    const weekday = new Date(t).getUTCDay();
    const utcHour = new Date(t).getUTCHours();
    if (
      weekday === 6 ||
      (weekday === 5 && utcHour >= 21) ||
      (weekday === 0 && utcHour < 21)
    )
      continue;
    const open = round(price * (1 + (random() - 0.5) * 0.002));
    const close = round(open * (1 + drift + (random() - 0.5) * 0.008));
    columns.t.push(t);
    columns.o.push(open);
    columns.h.push(round(Math.max(open, close) * (1 + random() * 0.003)));
    columns.l.push(round(Math.min(open, close) * (1 - random() * 0.003)));
    columns.c.push(close);
    columns.v.push(Math.floor(100 + random() * 900));
    price = close;
  }
  return toBars(columns);
};

const breakoutLevel = (name: "highest" | "lowest", length: number) => ({
  left: { field: "close", type: "price" },
  oncePerLevel: true,
  op: "breaksAbove",
  right: {
    length,
    name,
    source: name === "highest" ? "high" : "low",
    timeframe: "1d",
    type: "indicator",
  },
});

/** LD34 as stated (docs/vertex-rebuild/strategy-definitions.md, "LD34 example"). */
const LD34: Json = {
  entry: {
    all: [],
    any: [
      ...[20, 50, 100, 200].map((length) => breakoutLevel("highest", length)),
      ...[20, 50, 100, 200].map((length) => breakoutLevel("lowest", length)),
    ],
  },
  management: {
    breakevenR: 2,
    trail: { activateR: 1, length: 14, multiple: 2 },
  },
  name: "LD34 nested Donchian long-only breakout",
  sizing: { maxLeverage: 20, mode: "riskPct", riskPct: 1 },
  stopLoss: { kind: "atr", length: 14, multiple: 2 },
  version: 1,
};

const daily = (name: string, length: number, extra: object = {}) => ({
  length,
  name,
  timeframe: "1d",
  type: "indicator",
  ...extra,
});

/**
 * Every daily indicator but rvol, offsets, entry.all with entry.any, crosses and breaks. The
 * thresholds let it enter (realizedVol is annualized percent, mostly 15 to 25 on these bars);
 * the rsi cross has no oncePerLevel because its level is a constant, which would allow one entry
 * in total.
 */
const MIXED_DAILY: Json = {
  entry: {
    all: [
      {
        left: daily("zscore", 20),
        op: ">",
        right: { type: "const", value: -2 },
      },
      { left: daily("adx", 14), op: ">", right: { type: "const", value: 10 } },
      {
        left: daily("realizedVol", 20),
        op: "<",
        right: { type: "const", value: 30 },
      },
      {
        left: daily("atr", 14, { offset: 5 }),
        op: ">",
        right: { type: "const", value: 0 },
      },
      {
        left: daily("sma", 10),
        op: ">=",
        right: daily("ema", 30, { offset: 24 }),
      },
    ],
    any: [
      {
        left: { field: "close", type: "price" },
        oncePerLevel: true,
        op: "breaksBelow",
        right: daily("lowest", 5, { source: "low" }),
      },
      {
        left: daily("rsi", 14),
        op: "crossesBelow",
        right: { type: "const", value: 45 },
      },
      {
        left: { field: "close", type: "price" },
        oncePerLevel: true,
        op: "crossesAbove",
        right: daily("highest", 10),
      },
    ],
  },
  exit: {
    any: [
      {
        left: { field: "close", type: "price" },
        op: "breaksBelow",
        right: daily("lowest", 10, { source: "low" }),
      },
    ],
  },
  management: { breakevenR: 1 },
  name: "Daily levels on hourly bars",
  stopLoss: { kind: "pct", pct: 2 },
  takeProfit: { kind: "pct", pct: 3 },
  version: 1,
};

const reelDefinitions: { id: string; definition: Json; symbol: string }[] = [
  { definition: LD34, id: "reel:ld34", symbol: "hourly" },
  { definition: LD34, id: "reel:ld34", symbol: "SPY" },
  { definition: MIXED_DAILY, id: "reel:mixedDaily", symbol: "hourly" },
];

// Intraday sessions: the `intraday` block, side "short", sessionReturn, noiseBand, vwap and
// volTarget sizing. GHLZ and ZAB are the reel study definitions
// (docs/specs/strategies/market-intraday-momentum.md) as written there.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** 2023 New York daylight saving time: from March 12 to November 5 (UTC dates). */
const EDT_FROM = Date.UTC(2023, 2, 12);
const EDT_TO = Date.UTC(2023, 10, 5);
/** NYSE 13:00 closes of 2023 inside the set. */
const EARLY_CLOSES: Readonly<Record<string, true>> = {
  "2023-07-03": true,
  "2023-11-24": true,
};
/** The day without its 09:55 bar, so its 10:00 price is missing. */
const MISSING_BAR_DAY = "2023-02-14";
const MISSING_BAR_MINUTE = 9 * 60 + 55;

/**
 * 5-minute bars on every NYSE trading day from 2023-01-03 to 2023-11-30 (New York time): three
 * pre-market bars from 09:15, the regular session 09:30 to 16:00 and two after-hours bars to
 * 16:10; on the 13:00 early closes the bars stop at 13:00. Both daylight saving changes are inside,
 * and MISSING_BAR_DAY lacks one bar. Each day opens with a gap and has its own drift; prices have
 * 2 decimals.
 */
const sessionBars = (): BarColumns => {
  const random = randomFrom(2018);
  const round = (value: number) => Math.round(value * 100) / 100;
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  let price = 400;
  for (
    let day = Date.UTC(2023, 0, 3);
    day <= Date.UTC(2023, 10, 30);
    day += DAY_MS
  ) {
    const weekday = new Date(day).getUTCDay();
    const holidays = nyseHolidays(new Date(day).getUTCFullYear());
    if (weekday === 0 || weekday === 6 || holidays.has(day / DAY_MS)) continue;
    const iso = new Date(day).toISOString().slice(0, 10);
    const behindUtc = day >= EDT_FROM && day < EDT_TO ? 4 : 5;
    const end = EARLY_CLOSES[iso] === true ? 13 * 60 : 16 * 60 + 10;
    price = round(price * (1 + (random() - 0.5) * 0.012));
    const drift = (random() - 0.5) * 0.0008;
    for (let minute = 9 * 60 + 15; minute < end; minute += 5) {
      const open = price;
      const close = round(open * (1 + drift + (random() - 0.5) * 0.003));
      const high = round(Math.max(open, close) * (1 + random() * 0.001));
      const low = round(Math.min(open, close) * (1 - random() * 0.001));
      const regular = minute >= 9 * 60 + 30 && minute < 16 * 60;
      const volume = Math.floor((regular ? 5000 : 500) * (1 + random()));
      price = close;
      if (iso === MISSING_BAR_DAY && minute === MISSING_BAR_MINUTE) continue;
      columns.t.push(day + (minute + behindUtc * 60) * MINUTE_MS);
      columns.o.push(open);
      columns.h.push(high);
      columns.l.push(low);
      columns.c.push(close);
      columns.v.push(volume);
    }
  }
  return toBars(columns);
};

/** Sessions of TREND_MINUTE_DAYS: [New York date, regular close minute after midnight, missing bar minutes]. */
const TREND_MINUTE_DAYS: readonly (readonly [
  string,
  number,
  readonly number[],
])[] = [
  ["2023-03-09", 16 * 60, [10 * 60 + 1]],
  ["2023-03-10", 16 * 60, []],
  ["2023-03-13", 16 * 60, []],
  ["2023-07-03", 13 * 60, []],
  ["2023-07-05", 16 * 60, []],
];

/**
 * 1-minute bars for the trend indicator and timeline cases: five sessions with five pre-market bars
 * from 09:25 and, on full days, five after-hours bars to 16:05; 2023-03-09 lacks its 10:01 bar,
 * 2023-03-13 is the first session after the March DST change and 2023-07-03 closes at 13:00 (no
 * after-hours bars). Prices have 2 decimals.
 */
const trendMinuteBars = (): BarColumns => {
  const random = randomFrom(2311);
  const round = (value: number) => Math.round(value * 100) / 100;
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  let price = 12_000;
  for (const [iso, close, missing] of TREND_MINUTE_DAYS) {
    const day = Date.parse(`${iso}T00:00:00Z`);
    const behindUtc = day >= EDT_FROM && day < EDT_TO ? 4 : 5;
    const end = close === 16 * 60 ? close + 5 : close;
    const drift = (random() - 0.5) * 0.0002;
    for (let minute = 9 * 60 + 25; minute < end; minute += 1) {
      const open = price;
      const next = round(open * (1 + drift + (random() - 0.5) * 0.002));
      const high = round(Math.max(open, next) * (1 + random() * 0.0005));
      const low = round(Math.min(open, next) * (1 - random() * 0.0005));
      const regular = minute >= 9 * 60 + 30 && minute < close;
      const volume = Math.floor((regular ? 2000 : 200) * (1 + random()));
      price = next;
      if (missing.includes(minute)) continue;
      columns.t.push(day + (minute + behindUtc * 60) * MINUTE_MS);
      columns.o.push(open);
      columns.h.push(high);
      columns.l.push(low);
      columns.c.push(next);
      columns.v.push(volume);
    }
  }
  return toBars(columns);
};

const NEW_YORK_SESSION = {
  close: "16:00",
  open: "09:30",
  timezone: "America/New_York",
};

/** sessionReturn(from, to) compared with 0. */
const returnSign = (from: string, to: string, op: ">" | "<") => ({
  left: { from, name: "sessionReturn", to, type: "indicator" },
  op,
  right: { type: "const", value: 0 },
});

/** GHLZ (Gao, Han, Li, Zhou 2018): at 15:30 trade the sign of the return to 10:00, flat at 16:00. */
const ghlz = (side: "long" | "short", extra: object = {}): Json => ({
  entry: {
    all: [returnSign("prevClose", "10:00", side === "long" ? ">" : "<")],
  },
  intraday: { ...NEW_YORK_SESSION, entryFrom: "15:30", entryTo: "15:30" },
  name: `GHLZ intraday momentum ${side}`,
  ...(side === "short" ? { side: "short" } : {}),
  sizing: { mode: "allIn" },
  stopLoss: { kind: "none" },
  version: 1,
  ...extra,
});

const noiseBand = (band: "upper" | "lower") => ({
  band,
  length: 14,
  name: "noiseBand",
  type: "indicator",
});
const closePrice = { field: "close", type: "price" };
const vwap = { name: "vwap", type: "indicator" };

/** ZAB (Zarattini, Aziz, Barbon 2024): noise-area breakout on a 30-minute grid, 2% vol target. */
const zab = (side: "long" | "short"): Json => {
  const band = noiseBand(side === "long" ? "upper" : "lower");
  const into = side === "long" ? ">" : "<";
  const back = side === "long" ? "<" : ">";
  return {
    entry: { all: [{ left: closePrice, op: into, right: band }] },
    exit: {
      any: [
        { left: closePrice, op: back, right: band },
        { left: closePrice, op: back, right: vwap },
      ],
    },
    intraday: {
      ...NEW_YORK_SESSION,
      decisionEvery: 30,
      entryFrom: "10:00",
      entryTo: "15:30",
    },
    name: `ZAB noise-area ${side}`,
    ...(side === "short" ? { side: "short" } : {}),
    sizing: { length: 14, maxLeverage: 4, mode: "volTarget", targetPct: 2 },
    stopLoss: { kind: "none" },
    version: 1,
  };
};

/** Chuk NQ noise band (session-open-momentum spec): entries on the 30-minute grid, exits every 5. */
const CHUK_INTRADAY: Record<string, unknown> = {
  ...NEW_YORK_SESSION,
  decisionEvery: 30,
  entryFrom: "10:00",
  entryTo: "15:30",
  exitEvery: 5,
};
const CHUK_LONG: Record<string, unknown> = {
  entry: {
    all: [
      { left: closePrice, op: ">", right: noiseBand("upper") },
      { left: closePrice, op: ">", right: vwap },
    ],
  },
  exit: {
    any: [
      { left: closePrice, op: "<", right: noiseBand("upper") },
      { left: closePrice, op: "<", right: vwap },
    ],
  },
  intraday: CHUK_INTRADAY,
  name: "Chuk noise band NQ long",
  sizing: { mode: "allIn" },
  stopLoss: { kind: "none" },
  version: 1,
};

/** GHLZ r1 + r12: also the 15:00 to 15:30 return must have the same sign. */
const GHLZ_R1_R12 = ghlz("long", {
  entry: {
    all: [
      returnSign("prevClose", "10:00", ">"),
      returnSign("15:00", "15:30", ">"),
    ],
  },
  name: "GHLZ r1 + r12 long",
});

/** Session indicators and options the study definitions leave out: open anchor, multiple, vwap. */
const SESSION_MIX: Json = {
  entry: {
    all: [
      {
        left: {
          from: "open",
          name: "sessionReturn",
          to: "11:00",
          type: "indicator",
        },
        op: ">",
        right: { type: "const", value: 0.001 },
      },
      { left: closePrice, op: "crossesAbove", right: vwap },
    ],
  },
  exit: {
    any: [
      {
        left: closePrice,
        op: "<",
        right: { ...noiseBand("lower"), length: 5, multiple: 0.5 },
      },
    ],
  },
  intraday: { ...NEW_YORK_SESSION, entryFrom: "11:00", entryTo: "14:00" },
  name: "Session mix",
  stopLoss: { kind: "pct", pct: 0.4 },
  takeProfit: { kind: "atr", length: 14, multiple: 3 },
  version: 1,
};

const intradayDefinitions: { id: string; definition: Json; symbol: string }[] =
  [
    { definition: ghlz("long"), id: "intraday:ghlz:long", symbol: "session" },
    { definition: ghlz("short"), id: "intraday:ghlz:short", symbol: "session" },
    { definition: GHLZ_R1_R12, id: "intraday:ghlz:r1r12", symbol: "session" },
    { definition: zab("long"), id: "intraday:zab:long", symbol: "session" },
    { definition: zab("short"), id: "intraday:zab:short", symbol: "session" },
    { definition: CHUK_LONG, id: "intraday:chuk:long", symbol: "session" },
    { definition: SESSION_MIX, id: "intraday:mix", symbol: "session" },
    // Daily bars: refused (STRATEGY_INTRADAY_DAILY_UNSUPPORTED).
    { definition: ghlz("long"), id: "intraday:ghlz:long", symbol: "SPY" },
    // Off the 5-minute bar grid: refused (STRATEGY_INTRADAY_GRID_MISALIGNED).
    {
      definition: {
        ...CHUK_LONG,
        intraday: { ...CHUK_INTRADAY, exitEvery: 7 },
      },
      id: "intraday:grid:exitEvery",
      symbol: "session",
    },
    {
      definition: ghlz("long", {
        intraday: { ...NEW_YORK_SESSION, entryFrom: "15:32", entryTo: "15:32" },
      }),
      id: "intraday:grid:entry",
      symbol: "session",
    },
    {
      definition: ghlz("long", {
        intraday: {
          ...NEW_YORK_SESSION,
          decisionEvery: 7,
          entryFrom: "15:30",
          entryTo: "15:30",
        },
      }),
      id: "intraday:grid:decisionEvery",
      symbol: "session",
    },
    {
      definition: ghlz("long", {
        entry: { all: [returnSign("prevClose", "10:03", ">")] },
      }),
      id: "intraday:grid:sessionReturn",
      symbol: "session",
    },
  ];

const SMA_CROSS: InstantRule = { fast: 10, kind: "smaCross", slow: 30 };
const BREAKOUT_TREND: InstantRule = {
  entryLookback: 20,
  exitLookback: 10,
  kind: "breakout",
  trendSma: 50,
};
const RSI_REVERSION: InstantRule = {
  kind: "rsiReversion",
  overbought: 70,
  oversold: 30,
  period: 14,
};

/** File access for buildGolden: `readText` reads a path relative to the repo root. */
export type GoldenIo = Readonly<{ readText: (path: string) => string }>;

export const GOLDEN_FIXTURE =
  "services/research/tests/fixtures/nautilus_backtest/golden.json";

/** Paths are relative to the repo root. */
export type GoldenCliIo = GoldenIo &
  Readonly<{
    writeText: (path: string, text: string) => void;
    stdout: Readonly<{ write: (text: string) => unknown }>;
  }>;

/** Writes golden.json and returns the process exit code. */
export const runGoldenCli = (io: GoldenCliIo): number => {
  io.writeText(GOLDEN_FIXTURE, buildGolden(io));
  io.stdout.write(`wrote ${GOLDEN_FIXTURE}\n`);
  return 0;
};

/** The first trade of a gap case must exit at bar 2 with `reason` at `price`. */
export const assertGapExit = (
  id: string,
  trade: InstantTrade | undefined,
  reason: string,
  price: number
): void => {
  if (
    trade?.exitIndex !== 2 ||
    trade.exitReason !== reason ||
    trade.exitPrice !== price
  )
    throw new Error(`${id}: unexpected first trade ${JSON.stringify(trade)}`);
};

/** Builds golden.json (text with a trailing newline). Deterministic. */
const sectorQuadrants: SectorQuadrantSeries = {
  "XLE:daily": [
    { date: "2024-03-05", quadrant: "leading" },
    { date: "2024-03-08", quadrant: "lagging" },
    { date: "2024-03-12", quadrant: "leading" },
  ],
  "XLK:weekly": [
    { date: "2015-01-30", quadrant: "improving" },
    { date: "2015-03-06", quadrant: "leading" },
    { date: "2015-05-01", quadrant: "weakening" },
    { date: "2015-07-02", quadrant: "lagging" },
    { date: "2015-09-04", quadrant: "improving" },
    { date: "2016-01-08", quadrant: "leading" },
  ],
};

const extraDefinitions: { id: string; definition: Json; symbol: string }[] = [
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 20, name: "ema", type: "indicator" },
            op: ">",
            right: { length: 20, name: "sma", offset: 3, type: "indicator" },
          },
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { field: "high", offset: 1, type: "price" },
          },
        ],
      },
      exit: {
        any: [
          {
            left: { length: 5, name: "ema", type: "indicator" },
            op: "crossesBelow",
            right: {
              length: 20,
              name: "ema",
              source: "high",
              type: "indicator",
            },
          },
        ],
      },
      name: "Offsets and crossesBelow",
      version: 1,
    },
    id: "extra:offsets",
    symbol: "SPY",
  },
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 20, name: "zscore", type: "indicator" },
            op: "<=",
            right: { type: "const", value: -1 },
          },
          {
            left: { length: 10, name: "realizedVol", type: "indicator" },
            op: ">=",
            right: { type: "const", value: 8 },
          },
          {
            left: { length: 14, name: "adx", type: "indicator" },
            op: ">",
            right: { type: "const", value: 15 },
          },
          {
            left: { length: 10, name: "rvol", type: "indicator" },
            op: ">",
            right: { type: "const", value: 0.8 },
          },
        ],
      },
      exit: {
        any: [
          {
            left: {
              length: 20,
              name: "zscore",
              source: "high",
              type: "indicator",
            },
            op: "crossesAbove",
            right: { type: "const", value: 1 },
          },
          {
            left: {
              length: 3,
              name: "lowest",
              offset: 2,
              source: "low",
              type: "indicator",
            },
            op: ">",
            right: { field: "close", type: "price" },
          },
        ],
      },
      name: "Statistics",
      stopLoss: { kind: "atr", length: 10, multiple: 1.5 },
      takeProfit: { kind: "pct", pct: 6 },
      version: 1,
    },
    id: "extra:stats",
    symbol: "QQQ",
  },
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 6, name: "ema", type: "indicator" },
            op: "crossesAbove",
            right: { length: 24, name: "sma", type: "indicator" },
          },
          {
            left: { length: 3, name: "rvol", type: "indicator" },
            op: ">",
            right: { type: "const", value: 0.9 },
          },
        ],
      },
      exit: {
        any: [
          {
            left: { length: 6, name: "ema", type: "indicator" },
            op: "<",
            right: { length: 24, name: "sma", type: "indicator" },
          },
        ],
      },
      name: "Session window",
      session: { endUtc: "19:00", startUtc: "14:00" },
      version: 1,
    },
    id: "extra:session",
    symbol: "intraday",
  },
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 6, name: "ema", type: "indicator" },
            op: ">",
            right: { length: 24, name: "sma", type: "indicator" },
          },
        ],
      },
      name: "Overnight session",
      session: { endUtc: "14:30", startUtc: "19:30" },
      version: 1,
    },
    id: "extra:sessionWrap",
    symbol: "intraday",
  },
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 10, name: "sma", type: "indicator" },
            op: ">",
            right: { length: 30, name: "sma", type: "indicator" },
          },
        ],
      },
      exit: {
        any: [
          {
            left: { length: 10, name: "sma", type: "indicator" },
            op: "<",
            right: { length: 30, name: "sma", type: "indicator" },
          },
        ],
      },
      filters: [
        {
          quadrants: ["leading", "improving"],
          sector: "XLK",
          type: "sectorQuadrant",
        },
      ],
      name: "Sector filter",
      version: 1,
    },
    id: "extra:sector",
    symbol: "SPY",
  },
  {
    definition: {
      entry: {
        all: [
          {
            left: { length: 6, name: "ema", type: "indicator" },
            op: ">",
            right: { length: 24, name: "sma", type: "indicator" },
          },
        ],
      },
      filters: [
        {
          quadrants: ["leading"],
          sector: "XLE",
          timeframe: "daily",
          type: "sectorQuadrant",
        },
      ],
      name: "Intraday sector filter",
      version: 1,
    },
    id: "extra:sectorIntraday",
    symbol: "intraday",
  },
];

/** YYYY-MM-DD dates from `from` to `to` inclusive (UTC): weekdays, plus Sundays when asked. */
const calendarDates = (
  from: string,
  to: string,
  sundays = false,
  holidays: readonly string[] = []
): string[] => {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    const date = new Date(t).toISOString().slice(0, 10);
    if (day === 6 || (day === 0 && !sundays) || holidays.includes(date))
      continue;
    dates.push(date);
  }
  return dates;
};

/**
 * Daily bars over spring 2019, starting mid-March, with the Good Friday holiday on the April
 * monthly expiration (19 April) and Memorial Day; the last bar is the day before a month end.
 */
const calendarBars = (): BarColumns => {
  const random = randomFrom(19);
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  let price = 280;
  for (const date of calendarDates("2019-03-06", "2019-05-30", false, [
    "2019-04-19",
    "2019-05-27",
  ])) {
    const open = price;
    const close = open * (1 + (random() - 0.5) * 0.02);
    columns.t.push(Date.parse(`${date}T00:00:00Z`));
    columns.o.push(open);
    columns.h.push(Math.max(open, close) * 1.002);
    columns.l.push(Math.min(open, close) * 0.998);
    columns.c.push(close);
    columns.v.push(1_000_000);
    price = close;
  }
  return toBars(columns);
};

/** Month-end bars (the last weekday of each month, October 2014 to December 2016). */
const monthlyBars = (): BarColumns => {
  const random = randomFrom(23);
  const columns: Columns = { c: [], h: [], l: [], o: [], t: [], v: [] };
  const weekdays = calendarDates("2014-10-01", "2016-12-31");
  let price = 190;
  weekdays.forEach((date, index) => {
    const next = weekdays[index + 1];
    if (next !== undefined && next.slice(0, 7) === date.slice(0, 7)) return;
    const open = price;
    const close = open * (1 + (random() - 0.48) * 0.08);
    columns.t.push(Date.parse(`${date}T00:00:00Z`));
    columns.o.push(open);
    columns.h.push(Math.max(open, close) * 1.01);
    columns.l.push(Math.min(open, close) * 0.99);
    columns.c.push(close);
    columns.v.push(20_000_000);
    price = close;
  });
  return toBars(columns);
};

/**
 * Trading calendars of StrategySeriesInput.calendar: every weekday (holidays included, so the carry
 * counts more dates than the bars have), and 2015 only (the 2016 SPY bars are missing from it).
 */
type CalendarName = "weekdays" | "weekdays2015";
const calendars = (): Record<CalendarName, string[]> => ({
  weekdays: calendarDates("2014-10-01", "2016-12-31"),
  weekdays2015: calendarDates("2015-01-01", "2015-12-31"),
});

type SeriesJson = Record<string, Record<string, number | null>>;

/**
 * Synthetic daily series for the series filters (random walks rounded to cents) over the daily,
 * calendar and intraday bar dates. VIX and VIX3M miss different dates and VIX has one null, so
 * the "on the bar date" filters skip bars; GC=F misses many dates and ES=F has Sundays, so the
 * series filter carries the latest earlier value.
 */
const seriesContext = (): SeriesJson => {
  const spans = (sundays: boolean) => [
    ...calendarDates("2014-10-01", "2016-12-31", sundays),
    ...calendarDates("2019-01-02", "2019-06-28", sundays),
    ...calendarDates("2024-01-02", "2024-03-29", sundays),
  ];
  const weekdays = spans(false);
  /** Random walk from `start`, pulled back toward it by `revert` per day, rounded to cents. */
  const walk = (
    dates: readonly string[],
    seed: number,
    start: number,
    step: number,
    revert: number
  ): number[] => {
    const random = randomFrom(seed);
    let value = start;
    return dates.map(() => {
      value = Math.max(
        start * 0.3,
        value + (random() - 0.5) * 2 * step + revert * (start - value)
      );
      return Math.round(value * 100) / 100;
    });
  };
  const record = (
    dates: readonly string[],
    values: readonly number[],
    skip: (index: number) => boolean
  ): Record<string, number | null> =>
    Object.fromEntries(
      dates.flatMap((date, index) =>
        skip(index) ? [] : [[date, values[index] as number]]
      )
    );
  const vix = walk(weekdays, 11, 16, 1.1, 0.04);
  const spread = randomFrom(21);
  const vix3m = vix.map(
    (value) => Math.round(value * (0.9 + spread() * 0.25) * 100) / 100
  );
  const withSundays = spans(true);
  return {
    // Gaps of 12 and 4 weekdays: the series filter carries a value at most 5 trading days.
    "CL=F": record(
      weekdays,
      walk(weekdays, 16, 60, 1.2, 0),
      (index) => (index >= 60 && index < 72) || (index >= 200 && index < 204)
    ),
    "ES=F": record(
      withSundays,
      walk(withSundays, 14, 2000, 18, 0),
      () => false
    ),
    "GC=F": record(
      weekdays,
      walk(weekdays, 15, 1200, 9, 0),
      (index) => index % 7 === 3
    ),
    SPY: record(weekdays, walk(weekdays, 13, 200, 1.6, 0), () => false),
    // Total-return close of SPY ($tr), missing every 11th weekday.
    "SPY:TR": record(
      weekdays,
      walk(weekdays, 17, 180, 1.4, 0),
      (index) => index % 11 === 5
    ),
    VIX: {
      ...record(weekdays, vix, (index) => index % 41 === 7),
      [weekdays[100] as string]: null,
    },
    VIX3M: record(weekdays, vix3m, (index) => index % 53 === 11),
    VXN: record(weekdays, walk(weekdays, 12, 20, 1.3, 0.04), () => false),
  };
};

const always = {
  left: { field: "close", type: "price" },
  op: ">",
  right: { type: "const", value: 0 },
};
const emaTrend = (op: string) => ({
  left: { field: "close", type: "price" },
  op,
  right: { length: 10, name: "ema", type: "indicator" },
});
const trendDefinition = (name: string, filters: Json[]): Json => ({
  entry: { all: [emaTrend(">")] },
  exit: { any: [emaTrend("<")] },
  filters,
  name,
  version: 1,
});
const maskDefinition = (name: string, filters: Json[]): Json => ({
  entry: { all: [always] },
  filters,
  name,
  version: 1,
});

/** Definitions with each series and calendar filter (and an options block), by symbol. */
const qcDefinitions: {
  id: string;
  definition: Json;
  symbols: readonly string[];
}[] = [
  {
    definition: trendDefinition("IV rank above 50", [
      { length: 60, min: 50, type: "ivRank" },
    ]),
    id: "qc:ivRank:min",
    symbols: ["SPY", "QQQ"],
  },
  {
    definition: maskDefinition("IV rank band", [
      { length: 20, max: 70, min: 10, type: "ivRank" },
    ]),
    id: "qc:ivRank:band",
    symbols: ["SPY", "QQQ"],
  },
  {
    definition: maskDefinition("IV rank default length", [
      { max: 40, type: "ivRank" },
    ]),
    id: "qc:ivRank:default",
    symbols: ["SPY"],
  },
  {
    definition: maskDefinition("Contango", [
      { maxRatio: 0.97, type: "vixTermStructure" },
    ]),
    id: "qc:vixTermStructure:max",
    symbols: ["SPY", "intraday"],
  },
  {
    definition: maskDefinition("Term band", [
      { maxRatio: 1.05, minRatio: 0.95, type: "vixTermStructure" },
    ]),
    id: "qc:vixTermStructure:band",
    symbols: ["QQQ"],
  },
  {
    definition: trendDefinition("Calm regime", [
      { maxTermRatio: 1, maxVix: 20, trendLength: 50, type: "volRegime" },
    ]),
    id: "qc:volRegime",
    symbols: ["SPY", "QQQ"],
  },
  {
    definition: maskDefinition("Calm regime default trend", [
      { maxTermRatio: 1.02, maxVix: 22, type: "volRegime" },
    ]),
    id: "qc:volRegime:default",
    symbols: ["SPY", "calendar"],
  },
  {
    definition: maskDefinition("Turn of month", [
      { fromDay: -2, toDay: 3, type: "calendarWindow", window: "turnOfMonth" },
    ]),
    id: "qc:calendar:turnOfMonth",
    symbols: ["SPY", "calendar", "intraday"],
  },
  {
    definition: maskDefinition("Opex week", [
      { type: "calendarWindow", window: "opexWeek" },
    ]),
    id: "qc:calendar:opexWeek",
    symbols: ["SPY", "calendar", "intraday"],
  },
  {
    definition: maskDefinition("Months", [
      { months: [1, 4, 11], type: "calendarWindow", window: "months" },
    ]),
    id: "qc:calendar:months",
    symbols: ["SPY", "calendar"],
  },
  {
    definition: maskDefinition("Futures trend", [
      {
        condition: {
          left: { field: "close", type: "price" },
          op: ">",
          right: { length: 20, name: "sma", type: "indicator" },
        },
        series: "ES=F",
        type: "series",
      },
    ]),
    id: "qc:series:esTrend",
    symbols: ["SPY", "calendar", "intraday"],
  },
  {
    definition: trendDefinition("Gold cross", [
      {
        condition: {
          left: { length: 5, name: "ema", type: "indicator" },
          op: "crossesAbove",
          right: { length: 20, name: "sma", offset: 2, type: "indicator" },
        },
        series: "GC=F",
        type: "series",
      },
    ]),
    id: "qc:series:goldCross",
    symbols: ["SPY", "QQQ"],
  },
  {
    definition: maskDefinition("Low VIX", [
      {
        condition: {
          left: { field: "close", type: "price" },
          op: "<",
          right: { type: "const", value: 17 },
        },
        series: "VIX",
        type: "series",
      },
    ]),
    id: "qc:series:lowVix",
    symbols: ["QQQ", "intraday"],
  },
  {
    definition: maskDefinition("Oil above 60, carried 5 days", [
      {
        condition: {
          left: { field: "close", type: "price" },
          op: ">",
          right: { type: "const", value: 60 },
        },
        series: "CL=F",
        type: "series",
      },
    ]),
    id: "qc:series:oilGap",
    symbols: ["SPY", "intraday"],
  },
  {
    definition: trendDefinition("Opex trend", [
      { type: "calendarWindow", window: "opexWeek" },
    ]),
    id: "qc:calendar:opexTrend",
    symbols: ["SPY", "QQQ", "calendar"],
  },
  {
    definition: {
      ...(trendDefinition("Put credit vertical", [
        { length: 60, min: 30, type: "ivRank" },
        { type: "calendarWindow", window: "opexWeek" },
        { maxRatio: 1, type: "vixTermStructure" },
        {
          quadrants: ["leading", "improving"],
          sector: "XLK",
          type: "sectorQuadrant",
        },
      ]) as object),
      options: {
        dte: { min: 21, target: 45 },
        exitDte: 7,
        maxLossPct: 2,
        profitTakePct: 50,
        shortDelta: 0.2,
        structure: "putCreditVertical",
        widthSigma: 0.5,
      },
    },
    id: "qc:options:putCredit",
    symbols: ["SPY"],
  },
  {
    definition: {
      ...(trendDefinition("Call debit vertical", [
        {
          fromDay: -1,
          toDay: 2,
          type: "calendarWindow",
          window: "turnOfMonth",
        },
      ]) as object),
      options: {
        dte: { min: 20, target: 30 },
        maxLossPct: 1,
        structure: "callDebitVertical",
        widthSigma: 1,
      },
    },
    id: "qc:options:callDebit",
    symbols: ["QQQ"],
  },
];

// Expression trees (strategy-dsl.ts StrategyExprSchema): one value per bar each.
const priceExpr = (
  field: "open" | "high" | "low" | "close",
  offset?: number
) => ({
  field,
  type: "price" as const,
  ...(offset === undefined ? {} : { offset }),
});
const constant = (value: number) => ({ type: "const" as const, value });
const indicator = (name: "sma" | "atr" | "ema", length: number) => ({
  length,
  name,
  type: "indicator" as const,
});
const seriesOf = (series: string, offset?: number): StrategyExprInput =>
  ({
    series,
    type: "series",
    ...(offset === undefined ? {} : { offset }),
  }) as StrategyExprInput;
const math = (
  op: "add" | "sub" | "mul" | "div",
  left: StrategyExprInput,
  right: StrategyExprInput
): StrategyExprInput => ({ left, op, right, type: "math" });
const change = (
  of: StrategyExprInput,
  length: number,
  offset?: number
): StrategyExprInput => ({
  length,
  of,
  type: "change",
  ...(offset === undefined ? {} : { offset }),
});

type ExprCase = Readonly<{
  calendar?: CalendarName;
  dataset: string;
  expr: StrategyExprInput;
  id: string;
  symbol?: string;
}>;

/** evaluateStrategyExpression (TS) and expression_values (Python) cases. */
const exprCases: readonly ExprCase[] = [
  { dataset: "SPY", expr: seriesOf("VIX"), id: "series:VIX" },
  { dataset: "SPY", expr: seriesOf("VIX", 3), id: "series:VIX:offset3" },
  { dataset: "SPY", expr: seriesOf("$tr"), id: "series:$tr", symbol: "SPY" },
  { dataset: "QQQ", expr: seriesOf("$iv"), id: "series:$iv", symbol: "QQQ" },
  {
    dataset: "SPY",
    expr: seriesOf("$future", 1),
    id: "series:$future:offset1",
    symbol: "SPY",
  },
  // Intraday bars read the values dated before the bar date; GC=F misses every 7th weekday.
  { dataset: "intraday", expr: seriesOf("GC=F"), id: "series:GC=F:intraday" },
  // CL=F has a 12-weekday gap: the carry ends after 5 dates.
  { dataset: "SPY", expr: seriesOf("CL=F"), id: "series:CL=F:gap" },
  {
    dataset: "SPY",
    expr: math(
      "div",
      math("sub", priceExpr("close"), indicator("sma", 20)),
      indicator("atr", 14)
    ),
    id: "math:nested",
  },
  {
    dataset: "SPY",
    expr: math("mul", seriesOf("VIX"), constant(0.01)),
    id: "math:mul:series",
  },
  {
    dataset: "SPY",
    expr: math(
      "add",
      priceExpr("open", 2),
      math("sub", priceExpr("high"), priceExpr("low"))
    ),
    id: "math:add:offset",
  },
  // Division by zero is not finite: NaN on every bar.
  {
    dataset: "SPY",
    expr: math(
      "div",
      priceExpr("close"),
      math("sub", priceExpr("close"), priceExpr("close"))
    ),
    id: "math:div:zero",
  },
  { dataset: "SPY", expr: change(priceExpr("close"), 5), id: "change:5" },
  {
    dataset: "SPY",
    expr: change(priceExpr("close"), 5, 2),
    id: "change:5:offset2",
  },
  { dataset: "SPY", expr: change(seriesOf("CL=F"), 3), id: "change:CL=F" },
  {
    dataset: "SPY",
    expr: change(math("sub", priceExpr("close"), priceExpr("close")), 1),
    id: "change:zero",
  },
  {
    dataset: "SPY",
    expr: { length: 20, of: priceExpr("close"), type: "returnStdev" },
    id: "returnStdev:20",
  },
  {
    dataset: "SPY",
    expr: { length: 5, of: seriesOf("GC=F"), type: "returnStdev" },
    id: "returnStdev:GC=F",
  },
  {
    dataset: "SPY",
    expr: {
      lag: 1,
      length: 20,
      type: "regression",
      x: change(seriesOf("$future"), 1),
      y: change(priceExpr("close"), 1),
    },
    id: "regression:lag1",
    symbol: "SPY",
  },
  // A flat x window has no slope: NaN.
  {
    dataset: "SPY",
    expr: {
      lag: 0,
      length: 10,
      type: "regression",
      x: constant(1),
      y: priceExpr("close"),
    },
    id: "regression:flat",
  },
  {
    dataset: "SPY",
    expr: {
      lag: 0,
      length: 30,
      type: "regression",
      x: indicator("ema", 10),
      y: priceExpr("close"),
    },
    id: "regression:lag0",
  },
  {
    dataset: "monthly",
    expr: {
      minCount: 1,
      monthsAhead: 1,
      of: change(priceExpr("close"), 1),
      type: "seasonal",
    },
    id: "seasonal:monthsAhead1",
  },
  {
    dataset: "SPY",
    expr: {
      minCount: 2,
      monthsAhead: 0,
      of: change(priceExpr("close"), 1),
      type: "seasonal",
    },
    id: "seasonal:daily",
  },
  // Monthly bars: without a calendar the carry counts month ends; with one it counts weekdays.
  { dataset: "monthly", expr: seriesOf("CL=F"), id: "calendar:none:CL=F" },
  {
    calendar: "weekdays",
    dataset: "monthly",
    expr: seriesOf("CL=F"),
    id: "calendar:weekdays:CL=F",
  },
  {
    calendar: "weekdays",
    dataset: "monthly",
    expr: seriesOf("$tr", 1),
    id: "calendar:weekdays:$tr",
    symbol: "SPY",
  },
  {
    calendar: "weekdays",
    dataset: "SPY",
    expr: seriesOf("GC=F"),
    id: "calendar:weekdays:daily",
  },
  // Input errors: Python raises InputError with the same message.
  { dataset: "monthly", expr: seriesOf("$iv"), id: "error:noSymbol" },
  {
    dataset: "SPY",
    expr: seriesOf("$future"),
    id: "error:unmapped",
    symbol: "XLK",
  },
  { dataset: "QQQ", expr: seriesOf("$tr"), id: "error:missing", symbol: "QQQ" },
  {
    calendar: "weekdays2015",
    dataset: "SPY",
    expr: seriesOf("VIX"),
    id: "error:calendar",
  },
];

const exprCondition = (
  left: StrategyExprInput,
  op: string,
  right: StrategyExprInput
) => ({ left, op, right });

type ExprDefinition = Readonly<{
  calendar?: CalendarName;
  definition: Json;
  id: string;
  /** Dataset key (the bars). */
  symbol: string;
  /** Traded symbol of the series input, when it is not the dataset key. */
  seriesSymbol?: string;
}>;

/** Compiled definitions with expression trees, relative refs and calendars. */
const exprDefinitions: readonly ExprDefinition[] = [
  {
    definition: {
      entry: {
        all: [
          exprCondition(
            math(
              "div",
              math("sub", priceExpr("close"), indicator("sma", 20)),
              indicator("atr", 14)
            ),
            "crossesAbove",
            constant(0.5)
          ),
        ],
      },
      exit: {
        any: [
          exprCondition(
            math("sub", priceExpr("close"), indicator("sma", 20)),
            "<",
            constant(0)
          ),
        ],
      },
      name: "ATR-scaled distance",
      version: 1,
    },
    id: "expr:math",
    symbol: "SPY",
  },
  {
    definition: {
      entry: {
        all: [
          exprCondition(
            change(seriesOf("$tr"), 20),
            ">",
            change(seriesOf("$future"), 20)
          ),
        ],
      },
      exit: {
        any: [
          exprCondition(change(seriesOf("$tr"), 5, 1), "<", constant(-0.02)),
        ],
      },
      filters: [
        {
          condition: exprCondition(
            priceExpr("close"),
            "<",
            indicator("sma", 50)
          ),
          series: "$iv",
          type: "series",
        },
      ],
      name: "Total return beats the future, IV below trend",
      version: 1,
    },
    id: "expr:refs",
    symbol: "SPY",
  },
  {
    definition: {
      entry: {
        all: [
          exprCondition(change(priceExpr("close"), 1), "<", {
            lag: 1,
            length: 20,
            type: "regression",
            x: change(seriesOf("ES=F"), 1),
            y: change(priceExpr("close"), 1),
          }),
        ],
      },
      exit: {
        any: [
          exprCondition(
            { length: 20, of: priceExpr("close"), type: "returnStdev" },
            ">",
            constant(0.012)
          ),
        ],
      },
      name: "Regression on the lagged future",
      version: 1,
    },
    id: "expr:regression",
    symbol: "QQQ",
  },
  {
    definition: {
      entry: {
        all: [
          exprCondition(
            {
              minCount: 1,
              monthsAhead: 1,
              of: change(priceExpr("close"), 1),
              type: "seasonal",
            } as StrategyExprInput,
            ">",
            constant(0)
          ),
        ],
      },
      name: "Seasonal month ahead",
      version: 1,
    },
    id: "expr:seasonal",
    symbol: "monthly",
  },
  // Month-end bars: CL=F has a 12-weekday gap, carried 5 weekdays on the calendar but 5 month ends
  // without it.
  ...([undefined, "weekdays"] as const).map((calendar) => ({
    ...(calendar === undefined ? {} : { calendar }),
    definition: {
      entry: { all: [exprCondition(seriesOf("CL=F"), ">", constant(0))] },
      exit: {
        any: [
          exprCondition(
            {
              minCount: 1,
              monthsAhead: 1,
              of: change(priceExpr("close"), 1),
              type: "seasonal",
            } as StrategyExprInput,
            "<",
            constant(0)
          ),
        ],
      },
      name: "Oil quoted at the month end",
      version: 1,
    },
    id: `expr:calendar:${calendar ?? "none"}`,
    symbol: "monthly",
  })),
  {
    calendar: "weekdays",
    definition: {
      entry: {
        all: [exprCondition(seriesOf("$tr", 1), "<", seriesOf("$tr"))],
      },
      filters: [{ length: 20, max: 60, type: "ivRank" }],
      name: "Refs on month ends",
      version: 1,
    },
    id: "expr:refs:calendar",
    seriesSymbol: "SPY",
    symbol: "monthly",
  },
  {
    definition: {
      entry: { all: [exprCondition(seriesOf("$iv"), ">", constant(15))] },
      name: "IV ref of a symbol without an IV index",
      version: 1,
    },
    id: "expr:error:unmapped",
    symbol: "monthly",
  },
  {
    definition: {
      entry: { all: [always] },
      filters: [
        {
          condition: exprCondition(priceExpr("close"), ">", constant(0)),
          series: "$tr",
          type: "series",
        },
      ],
      name: "Missing total return",
      version: 1,
    },
    id: "expr:error:missing",
    symbol: "QQQ",
  },
  {
    calendar: "weekdays2015",
    definition: {
      entry: { all: [exprCondition(seriesOf("VIX"), "<", constant(20))] },
      name: "Calendar without the 2016 bars",
      version: 1,
    },
    id: "expr:error:calendar",
    symbol: "SPY",
  },
  {
    // The options runner gets the options and portfolio blocks back unchanged.
    definition: {
      entry: { all: [always] },
      name: "Roll portfolio",
      options: {
        dte: { min: 21, target: 30 },
        maxLossPct: 1,
        structure: "callDebitVertical",
        widthSigma: 0.5,
      },
      portfolio: {
        frame: "monthly",
        policy: "roll",
        select: {
          score: change(seriesOf("$tr"), 1),
          tieBreak: seriesOf("$iv"),
          top: 2,
        },
        symbols: ["SPY", "QQQ", "GLD"],
      },
      version: 1,
    },
    id: "expr:portfolio",
    symbol: "SPY",
  },
  {
    // Defaulted fields come back with their defaults: indicator source close (leg condition,
    // selection score), ivRank length and sectorQuadrant timeframe on a leg filter.
    definition: {
      entry: { all: [always] },
      name: "Portfolio defaults",
      options: {
        dte: { min: 21, target: 30 },
        maxLossPct: 1,
        structure: "callDebitVertical",
        widthSigma: 0.5,
      },
      portfolio: {
        legs: [
          {
            entry: {
              all: [
                exprCondition(priceExpr("close"), ">", indicator("sma", 5)),
              ],
            },
            filters: [
              { max: 40, type: "ivRank" },
              { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
            ],
            options: {
              dte: { min: 21, target: 30 },
              maxLossPct: 1,
              structure: "callDebitVertical",
              widthSigma: 0.5,
            },
          },
        ],
        policy: "roll",
        select: {
          score: math("sub", priceExpr("close"), indicator("ema", 3)),
          top: 1,
        },
        symbols: ["SPY", "QQQ"],
      },
      version: 1,
    },
    id: "expr:portfolioDefaults",
    symbol: "SPY",
  },
];

type RefusalCase = Readonly<{
  definition: Json;
  id: string;
  support?: StrategyServerSupport;
  timeframe?: string;
}>;

const OPTIONS_BLOCK = {
  dte: { min: 21, target: 45 },
  maxLossPct: 2,
  shortDelta: 0.2,
  structure: "putCreditVertical",
  widthSigma: 0.5,
};
const seriesEntry = {
  entry: { all: [exprCondition(seriesOf("$tr"), ">", indicator("sma", 20))] },
  name: "Series expression",
  version: 1,
};
const seriesRead = exprCondition(priceExpr("close"), "<", seriesOf("VIX"));
const calendarEntry = {
  entry: { all: [always] },
  filters: [{ type: "calendarWindow", window: "opexWeek" }],
  name: "Opex",
  version: 1,
};
const ivEntry = {
  ...seriesEntry,
  filters: [
    { length: 60, min: 30, type: "ivRank" },
    { type: "calendarWindow", window: "opexWeek" },
  ],
};

/** serverStrategyRefusal (TS) and server_refusal (Python) with the support flags. */
const refusalCases: readonly RefusalCase[] = [
  {
    definition: { ...seriesEntry, options: OPTIONS_BLOCK },
    id: "options:none",
  },
  {
    definition: { ...seriesEntry, options: OPTIONS_BLOCK },
    id: "options:series",
    support: { series: true },
  },
  {
    definition: { ...seriesEntry, options: OPTIONS_BLOCK },
    id: "options:intraday",
    support: { options: true, series: true },
    timeframe: "1h",
  },
  {
    definition: { ...seriesEntry, options: OPTIONS_BLOCK },
    id: "options:noSeries",
    support: { options: true },
    timeframe: "1d",
  },
  {
    definition: { ...seriesEntry, options: OPTIONS_BLOCK },
    id: "options:all",
    support: { options: true, series: true },
    timeframe: "1d",
  },
  { definition: seriesEntry, id: "expressions:none" },
  {
    // entry.any and exit.any read series too.
    definition: {
      ...calendarEntry,
      entry: { all: [always], any: [always, seriesRead] },
    },
    id: "expressions:entryAny",
  },
  {
    definition: { ...calendarEntry, exit: { any: [seriesRead] } },
    id: "expressions:exitAny",
  },
  {
    definition: {
      ...calendarEntry,
      options: OPTIONS_BLOCK,
      portfolio: {
        legs: [
          {
            entry: { all: [always] },
            exit: { any: [seriesRead] },
            options: OPTIONS_BLOCK,
          },
        ],
        policy: "roll",
        symbols: ["SPY"],
      },
    },
    id: "portfolio:legExitSeries",
    support: { options: true },
    timeframe: "1d",
  },
  {
    definition: seriesEntry,
    id: "expressions:series",
    support: { series: true },
  },
  { definition: ivEntry, id: "filters:none", support: { options: true } },
  {
    definition: ivEntry,
    id: "filters:series:intraday",
    support: { series: true },
    timeframe: "5m",
  },
  {
    definition: calendarEntry,
    id: "calendar:daily",
    timeframe: "1w",
  },
  {
    definition: {
      ...calendarEntry,
      options: OPTIONS_BLOCK,
      portfolio: {
        cadence: "daily",
        legs: [
          {
            entry: { all: [always] },
            filters: [
              {
                condition: exprCondition(priceExpr("close"), "<", constant(20)),
                series: "VIX",
                type: "series",
              },
            ],
            options: OPTIONS_BLOCK,
          },
        ],
        policy: "flat",
        symbols: ["SPY"],
      },
    },
    id: "portfolio:legSeries",
    support: { options: true },
  },
  {
    definition: {
      entry: { all: [always] },
      name: "Select",
      options: OPTIONS_BLOCK,
      portfolio: {
        policy: "roll",
        select: { score: change(seriesOf("$tr"), 3), top: 1 },
        symbols: ["SPY", "QQQ"],
      },
      version: 1,
    },
    id: "portfolio:select",
    support: { options: true },
  },
  {
    definition: {
      ...calendarEntry,
      options: OPTIONS_BLOCK,
      portfolio: { policy: "window", shift: 2, symbols: ["SPY"] },
    },
    id: "portfolio:shift",
    support: { options: true },
    timeframe: "1d",
  },
];

// 2d. Definition refusals.
/**
 * Definitions that StrategyDefinitionSchema refuses, for the Python normalize_definition. `python` is
 * the message Python raises when zod wrote the first TypeScript issue (a field error; see
 * definitionRefusalJson).
 */
type DefinitionRefusalCase = Readonly<{
  definition: Json;
  id: string;
  python?: string;
}>;

const plainDefinition = {
  entry: { all: [always] },
  name: "Refusal",
  version: 1,
};
const optionsDefinition = { ...plainDefinition, options: OPTIONS_BLOCK };
const conditionWithout = (key: "left" | "op" | "right") =>
  Object.fromEntries(Object.entries(always).filter(([name]) => name !== key));
const riskPctSizing = { mode: "riskPct", riskPct: 1 };
const volTargetSizing = {
  length: 20,
  maxLeverage: 2,
  mode: "volTarget",
  targetPct: 10,
};
const pctStop = { kind: "pct", pct: 5 };
const management = { breakevenR: 1 };
const rollPortfolio = { policy: "roll", symbols: ["SPY"] };
const monthlyPortfolio = { ...rollPortfolio, frame: "monthly" };
const shiftedPortfolio = { policy: "window", shift: 2, symbols: ["SPY"] };
const alwaysExit = { any: [always] };
const atrEntry = { all: [{ ...always, left: indicator("atr", 5) }] };
const nySession = {
  ...NEW_YORK_SESSION,
  entryFrom: "09:45",
  entryTo: "12:00",
};

/**
 * One field error each (card vertex-dsl-python-validator-field-guards): a value of the wrong type, a
 * value outside its range, an unknown key or a list that is not a list. The third item is the Python
 * message when zod writes the first TypeScript issue; without it, strategy-dsl.ts writes the message.
 */
const opexWeek = { type: "calendarWindow", window: "opexWeek" };
const leftOf = (left: Json) => ({ entry: { all: [{ ...always, left }] } });
const sectorFilter = (edit: Record<string, Json>) => ({
  filters: [
    {
      quadrants: ["leading"],
      sector: "XLK",
      type: "sectorQuadrant",
      ...edit,
    },
  ],
});
const legOf = (leg: Json) => ({
  options: OPTIONS_BLOCK,
  portfolio: { ...rollPortfolio, legs: [leg] },
});
const fieldRefusals: readonly (readonly [
  id: string,
  edit: Record<string, Json>,
  python?: string,
])[] = [
  ["version", { version: 2 }, "Unknown definition version: 2"],
  ["versionType", { version: true }, "Unknown definition version: True"],
  ["name", { name: " " }, "name must be a text of 1 to 120 characters"],
  ["nameType", { name: 5 }, "name must be a text of 1 to 120 characters"],
  [
    "nameLength",
    { name: "n".repeat(121) },
    "name must be a text of 1 to 120 characters",
  ],
  // JavaScript trim removes U+FEFF; zod counts the characters of a text as code points.
  [
    "nameTrim",
    { name: "\ufeff" },
    "name must be a text of 1 to 120 characters",
  ],
  [
    "nameCodePoints",
    { name: "😀".repeat(121) },
    "name must be a text of 1 to 120 characters",
  ],
  [
    "descriptionLength",
    { description: "d".repeat(2001) },
    "description must be a text of at most 2000 characters",
  ],
  [
    "description",
    { description: 5 },
    "description must be a text of at most 2000 characters",
  ],
  ["entryAll", { entry: { all: 5 } }, "entry.all must be a list"],
  [
    "entryAny",
    { entry: { all: [always], any: 5 } },
    "entry.any must be a list",
  ],
  ["exitAny", { exit: { any: true } }, "exit.any must be a list"],
  [
    "entryAllCount",
    { entry: { all: new Array(9).fill(always) } },
    "entry.all needs 0 to 8 conditions",
  ],
  ["filtersType", { filters: 5 }, "filters must be a list"],
  [
    "filtersCount",
    { filters: new Array(5).fill(opexWeek) },
    "A definition needs 0 to 4 filters",
  ],
  ["filterType", { filters: [5] }, "filter must be an object"],
  ["sizingMode", { sizing: {} }, "sizing needs mode"],
  [
    "riskPctType",
    { sizing: { mode: "riskPct", riskPct: "x" }, stopLoss: pctStop },
    "riskPct must be above 0 and at most 100",
  ],
  [
    "riskPctAbsent",
    { sizing: { mode: "riskPct" }, stopLoss: pctStop },
    "riskPct must be above 0 and at most 100",
  ],
  [
    "sessionKey",
    { session: { endUtc: "16:00", startUtc: "09:30", x: 1 } },
    "Unknown key in session: x",
  ],
  [
    "sessionTime",
    { session: { endUtc: "16:00", startUtc: "a" } },
    "session startUtc: Expected HH:MM (UTC)",
  ],
  ["sessionEqual", { session: { endUtc: "09:30", startUtc: "09:30" } }],
  [
    "stopLossKey",
    { stopLoss: { kind: "pct", pct: 5, x: 1 } },
    "Unknown key in stopLoss: x",
  ],
  [
    "stopLossNoneKey",
    { stopLoss: { kind: "none", pct: 5 } },
    "Unknown key in stopLoss: pct",
  ],
  [
    "stopLossPctAbsent",
    { stopLoss: { kind: "pct" } },
    "stopLoss pct must be above 0 and at most 99",
  ],
  [
    "stopLossPct",
    { stopLoss: { kind: "pct", pct: 100 } },
    "stopLoss pct must be above 0 and at most 99",
  ],
  [
    "stopLossLength",
    { stopLoss: { kind: "atr", length: 0, multiple: 2 } },
    "stopLoss length must be a whole number from 1 to 1000",
  ],
  [
    "stopLossMultiple",
    { stopLoss: { kind: "atr", length: 14, multiple: "x" } },
    "stopLoss multiple must be above 0 and at most 100",
  ],
  [
    "takeProfitPct",
    { takeProfit: { kind: "pct", pct: 0 } },
    "takeProfit pct must be above 0 and at most 99",
  ],
  ["expressionType", leftOf(5), "expression must be an object"],
  [
    "expressionChild",
    leftOf({ left: closePrice, op: "add", type: "math" }),
    "expression must be an object",
  ],
  ["expressionKind", leftOf({ type: [] }), "Unknown expression type: []"],
  [
    "constRange",
    leftOf({ type: "const", value: 1e13 }),
    "Constant value must be from -1e+12 to 1e+12",
  ],
  [
    "indicatorLength",
    leftOf({ length: 1001, name: "sma", type: "indicator" }),
    "sma length must be at most 1000",
  ],
  ["rvolLength", leftOf({ length: 101, name: "rvol", type: "indicator" })],
  ["zscoreLength", leftOf({ length: 1, name: "zscore", type: "indicator" })],
  [
    "filterKey",
    { filters: [{ min: 10, type: "ivRank", x: 1 }] },
    "Unknown key in ivRank filter: x",
  ],
  ["sector", sectorFilter({ sector: "XLZ" })],
  [
    "sectorType",
    sectorFilter({ sector: 5 }),
    "Unknown sector. Use a Select Sector SPDR symbol, for example XLK",
  ],
  [
    "quadrantsType",
    sectorFilter({ quadrants: "leading" }),
    "sectorQuadrant quadrants must be a list",
  ],
  [
    "quadrantsEmpty",
    sectorFilter({ quadrants: [] }),
    "sectorQuadrant needs at least one quadrant",
  ],
  ["quadrant", sectorFilter({ quadrants: ["up"] }), "Unknown quadrant: up"],
  ["quadrantsRepeat", sectorFilter({ quadrants: ["leading", "leading"] })],
  [
    "filterTimeframe",
    sectorFilter({ timeframe: "monthly" }),
    "Unknown filter timeframe: monthly",
  ],
  [
    "ivRankLength",
    { filters: [{ length: 19, min: 10, type: "ivRank" }] },
    "ivRank length must be a whole number from 20 to 1000",
  ],
  [
    "ivRankMin",
    { filters: [{ min: 101, type: "ivRank" }] },
    "ivRank min must be from 0 to 100",
  ],
  ["ivRankOrder", { filters: [{ max: 10, min: 90, type: "ivRank" }] }],
  [
    "vixRatio",
    { filters: [{ maxRatio: 11, type: "vixTermStructure" }] },
    "vixTermStructure maxRatio must be above 0 and at most 10",
  ],
  [
    "vixOrder",
    { filters: [{ maxRatio: 1, minRatio: 2, type: "vixTermStructure" }] },
  ],
  [
    "volRegimeVix",
    { filters: [{ maxTermRatio: 1, maxVix: 201, type: "volRegime" }] },
    "volRegime maxVix must be above 0 and at most 200",
  ],
  [
    "volRegimeRatioAbsent",
    { filters: [{ maxVix: 30, type: "volRegime" }] },
    "volRegime maxTermRatio must be above 0 and at most 10",
  ],
  [
    "volRegimeTrend",
    {
      filters: [
        { maxTermRatio: 1, maxVix: 30, trendLength: 0, type: "volRegime" },
      ],
    },
    "volRegime trendLength must be a whole number from 1 to 1000",
  ],
  [
    "turnOfMonthFromDay",
    { filters: [{ ...opexWeek, fromDay: 0, toDay: 3, window: "turnOfMonth" }] },
    "turnOfMonth fromDay must be a whole number from -10 to -1",
  ],
  [
    "turnOfMonthToDay",
    {
      filters: [{ ...opexWeek, fromDay: -1, toDay: 11, window: "turnOfMonth" }],
    },
    "turnOfMonth toDay must be a whole number from 1 to 10",
  ],
  [
    "calendarKey",
    { filters: [{ ...opexWeek, months: [1] }] },
    "Unknown key in opexWeek filter: months",
  ],
  [
    "monthsType",
    { filters: [{ ...opexWeek, months: 5, window: "months" }] },
    "calendarWindow months must be a list",
  ],
  [
    "monthsEmpty",
    { filters: [{ ...opexWeek, months: [], window: "months" }] },
    "calendarWindow months needs 1 to 12 months",
  ],
  [
    "month",
    { filters: [{ ...opexWeek, months: [13], window: "months" }] },
    "A calendarWindow month must be a whole number from 1 to 12",
  ],
  [
    "monthsRepeat",
    { filters: [{ ...opexWeek, months: [1, 1], window: "months" }] },
  ],
  [
    "seriesKey",
    { filters: [{ condition: always, series: "VIX", type: "series", x: 1 }] },
    "Unknown key in series filter: x",
  ],
  [
    "symbolsType",
    { options: OPTIONS_BLOCK, portfolio: { policy: "roll", symbols: "SPY" } },
    "portfolio symbols must be a list",
  ],
  [
    "legsType",
    { options: OPTIONS_BLOCK, portfolio: { ...rollPortfolio, legs: 5 } },
    "portfolio legs must be a list",
  ],
  ["legType", legOf(5), "portfolio leg must be an object"],
  [
    "legEntryType",
    legOf({ entry: 0, options: OPTIONS_BLOCK }),
    "portfolio leg entry must be an object",
  ],
  [
    "legEntryAll",
    legOf({ entry: { all: 5 }, options: OPTIONS_BLOCK }),
    "portfolio leg entry.all must be a list",
  ],
  [
    "legExitAny",
    legOf({
      entry: { all: [always] },
      exit: { any: 5 },
      options: OPTIONS_BLOCK,
    }),
    "portfolio leg exit.any must be a list",
  ],
  [
    "legFilters",
    legOf({ entry: { all: [always] }, filters: 5, options: OPTIONS_BLOCK }),
    "portfolio leg filters must be a list",
  ],
  [
    "selectScore",
    {
      options: OPTIONS_BLOCK,
      portfolio: { ...rollPortfolio, select: { top: 1 } },
    },
    "expression must be an object",
  ],
];
const nullFieldRefusals: typeof fieldRefusals = [
  [
    "ivRankLengthNull",
    { filters: [{ length: null, min: 10, type: "ivRank" }] },
    "ivRank length must be a whole number from 20 to 1000",
  ],
  [
    "volRegimeTrendNull",
    {
      filters: [
        { maxTermRatio: 1, maxVix: 30, trendLength: null, type: "volRegime" },
      ],
    },
    "volRegime trendLength must be a whole number from 1 to 1000",
  ],
  [
    "filterTimeframeNull",
    sectorFilter({ timeframe: null }),
    "Unknown filter timeframe: None",
  ],
  [
    "legExitAnyAbsent",
    legOf({ entry: { all: [always] }, exit: {}, options: OPTIONS_BLOCK }),
    "portfolio leg exit.any must be a list",
  ],
];
const fieldRefusalCases: readonly DefinitionRefusalCase[] = [
  ...fieldRefusals,
  ...nullFieldRefusals,
].map(([id, edit, python]) => ({
  definition: { ...plainDefinition, ...edit },
  id: `field:${id}`,
  ...(python === undefined ? {} : { python }),
}));

const definitionRefusalCases: readonly DefinitionRefusalCase[] = [
  // One cross-field check alone, in schema order.
  {
    definition: { ...plainDefinition, sizing: riskPctSizing },
    id: "riskPct:noStop",
  },
  {
    definition: { ...optionsDefinition, sizing: riskPctSizing },
    id: "options:riskPct",
  },
  {
    definition: { ...optionsDefinition, stopLoss: pctStop },
    id: "options:stopLoss",
  },
  { definition: { ...plainDefinition, management }, id: "management:noStop" },
  {
    definition: { ...optionsDefinition, management },
    id: "options:management",
  },
  {
    definition: { ...optionsDefinition, sizing: volTargetSizing },
    id: "options:volTarget",
  },
  {
    definition: { ...plainDefinition, portfolio: rollPortfolio },
    id: "portfolio:noOptions",
  },
  {
    definition: {
      ...plainDefinition,
      management,
      side: "short",
      stopLoss: pctStop,
    },
    id: "short:management",
  },
  {
    definition: {
      ...optionsDefinition,
      exit: alwaysExit,
      portfolio: shiftedPortfolio,
    },
    id: "shift:exit",
  },
  {
    definition: {
      ...optionsDefinition,
      entry: atrEntry,
      portfolio: monthlyPortfolio,
    },
    id: "monthly:atr",
  },
  { definition: { ...optionsDefinition, side: "short" }, id: "short:options" },
  {
    definition: { ...optionsDefinition, intraday: nySession },
    id: "intraday:options",
  },
  {
    definition: {
      ...plainDefinition,
      filters: [{ type: "calendarWindow", window: "opexWeek" }],
      intraday: nySession,
    },
    id: "intraday:calendarWindow",
  },
  {
    definition: {
      ...plainDefinition,
      entry: { all: [{ ...always, left: vwap }] },
    },
    id: "session:noIntraday",
  },
  // Several cross-field checks: the first one in schema order.
  {
    definition: { ...plainDefinition, management, sizing: riskPctSizing },
    id: "riskPct:noStop+management:noStop",
  },
  {
    definition: {
      ...optionsDefinition,
      sizing: riskPctSizing,
      stopLoss: pctStop,
    },
    id: "options:riskPct+options:stopLoss",
  },
  {
    definition: { ...optionsDefinition, management, stopLoss: pctStop },
    id: "options:stopLoss+options:management",
  },
  {
    definition: { ...plainDefinition, management, portfolio: rollPortfolio },
    id: "management:noStop+portfolio:noOptions",
  },
  {
    definition: {
      ...optionsDefinition,
      exit: alwaysExit,
      management,
      portfolio: shiftedPortfolio,
    },
    id: "options:management+shift:exit",
  },
  {
    definition: {
      ...optionsDefinition,
      exit: alwaysExit,
      portfolio: shiftedPortfolio,
      sizing: volTargetSizing,
    },
    id: "options:volTarget+shift:exit",
  },
  {
    definition: {
      ...optionsDefinition,
      entry: atrEntry,
      portfolio: monthlyPortfolio,
      sizing: volTargetSizing,
    },
    id: "options:volTarget+monthly:atr",
  },
  {
    definition: {
      ...plainDefinition,
      management,
      portfolio: rollPortfolio,
      side: "short",
      stopLoss: pctStop,
    },
    id: "portfolio:noOptions+short:management",
  },
  {
    definition: {
      ...optionsDefinition,
      exit: alwaysExit,
      portfolio: shiftedPortfolio,
      side: "short",
    },
    id: "shift:exit+short:options",
  },
  {
    definition: {
      ...optionsDefinition,
      entry: atrEntry,
      portfolio: monthlyPortfolio,
      side: "short",
    },
    id: "monthly:atr+short:options",
  },
  // A field error with a failed cross-field check: the field error.
  {
    definition: {
      ...plainDefinition,
      entry: { all: [] },
      sizing: riskPctSizing,
    },
    id: "field:entry+riskPct:noStop",
  },
  {
    definition: {
      ...optionsDefinition,
      intraday: { ...nySession, open: "17:00" },
      stopLoss: pctStop,
    },
    id: "field:intraday+options:stopLoss",
  },
  {
    definition: { ...plainDefinition, management: {} },
    id: "field:management+management:noStop",
  },
  {
    definition: { ...plainDefinition, options: 5, stopLoss: pctStop },
    id: "field:options+options:stopLoss",
    python: "options must be an object",
  },
  {
    definition: { ...plainDefinition, side: "sideways", sizing: riskPctSizing },
    id: "field:side+riskPct:noStop",
    python: "Unknown side: sideways",
  },
  {
    definition: {
      ...optionsDefinition,
      side: "sideways",
      sizing: riskPctSizing,
    },
    id: "field:side+options:riskPct",
    python: "Unknown side: sideways",
  },
  {
    definition: {
      ...optionsDefinition,
      portfolio: { ...rollPortfolio, bogus: 1 },
      stopLoss: pctStop,
    },
    id: "field:portfolioKey+options:stopLoss",
    python: "Unknown portfolio key: bogus",
  },
  {
    definition: {
      ...optionsDefinition,
      management: { trail: { activateR: 1, length: 0, multiple: 2 } },
      sizing: riskPctSizing,
    },
    id: "field:trailLength+options:riskPct",
    python: "management trail length must be a whole number from 1 to 1000",
  },
  {
    definition: { ...plainDefinition, management: { bogus: 1, breakevenR: 1 } },
    id: "field:managementKey+management:noStop",
    python: "Unknown key in management: bogus",
  },
  {
    definition: {
      ...plainDefinition,
      exit: { any: [{ ...always, op: "equals" }] },
      management,
    },
    id: "field:operator+management:noStop",
    python: "Unknown operator: equals",
  },
  {
    definition: { ...optionsDefinition, management, side: "sideways" },
    id: "field:side+options:management",
    python: "Unknown side: sideways",
  },
  {
    definition: {
      ...plainDefinition,
      portfolio: rollPortfolio,
      side: "sideways",
    },
    id: "field:side+portfolio:noOptions",
    python: "Unknown side: sideways",
  },
  {
    definition: {
      ...optionsDefinition,
      entry: atrEntry,
      portfolio: monthlyPortfolio,
      side: "sideways",
    },
    id: "field:side+monthly:atr",
    python: "Unknown side: sideways",
  },
  {
    definition: {
      ...optionsDefinition,
      entry: {
        all: [
          {
            ...always,
            left: {
              length: 10,
              multiple: 3,
              name: "supertrend",
              output: "direction",
              type: "indicator",
            },
          },
        ],
      },
      portfolio: monthlyPortfolio,
    },
    id: "monthly:supertrend",
  },
  // A block or a condition that is not an object, a session without its times and a condition
  // without a side or an operator. Each definition also has the error of the cross-field check
  // that its id names after "+"; Python must raise the field error, because it runs the field
  // checks first.
  {
    definition: { ...plainDefinition, entry: 5, sizing: riskPctSizing },
    id: "field:entryType+riskPct:noStop",
    python: "entry must be an object",
  },
  {
    definition: { ...plainDefinition, exit: 5, management },
    id: "field:exitType+management:noStop",
    python: "exit must be an object",
  },
  {
    definition: { ...plainDefinition, management: 5, sizing: riskPctSizing },
    id: "field:managementType+riskPct:noStop",
    python: "management must be an object",
  },
  {
    definition: { ...plainDefinition, session: 5, sizing: riskPctSizing },
    id: "field:sessionType+riskPct:noStop",
    python: "session must be an object",
  },
  {
    definition: { ...plainDefinition, session: {}, sizing: riskPctSizing },
    id: "field:sessionKeys+riskPct:noStop",
    python: "session needs startUtc and endUtc",
  },
  {
    definition: { ...plainDefinition, management, sizing: 5 },
    id: "field:sizingType+management:noStop",
    python: "sizing must be an object",
  },
  {
    definition: { ...optionsDefinition, sizing: riskPctSizing, stopLoss: 5 },
    id: "field:stopLossType+options:riskPct",
    python: "stopLoss must be an object",
  },
  {
    definition: { ...plainDefinition, management, takeProfit: 5 },
    id: "field:takeProfitType+management:noStop",
    python: "takeProfit must be an object",
  },
  {
    definition: { ...plainDefinition, exit: { any: [5] }, management },
    id: "field:conditionType+management:noStop",
    python: "condition must be an object",
  },
  {
    definition: {
      ...plainDefinition,
      entry: { all: [conditionWithout("left")] },
      management,
    },
    id: "field:conditionLeft+management:noStop",
    python: "condition needs left, op and right",
  },
  {
    definition: {
      ...plainDefinition,
      entry: { all: [always], any: [conditionWithout("op")] },
      management,
    },
    id: "field:conditionOp+management:noStop",
    python: "condition needs left, op and right",
  },
  {
    definition: {
      ...plainDefinition,
      exit: { any: [conditionWithout("right")] },
      management,
    },
    id: "field:conditionRight+management:noStop",
    python: "condition needs left, op and right",
  },
  ...fieldRefusalCases,
];

// 3. Fixed rules.
const RULES: { id: string; rule: InstantRule }[] = [
  { id: "smaCross-10-30", rule: SMA_CROSS },
  { id: "breakout-20-10-50", rule: BREAKOUT_TREND },
  {
    id: "breakout-20-10-0",
    rule: {
      entryLookback: 20,
      exitLookback: 10,
      kind: "breakout",
      trendSma: 0,
    },
  },
  { id: "rsiReversion-14-30-70", rule: RSI_REVERSION },
];

// 4. Costs.
const customProfile = (overrides: Partial<CostProfile>): CostProfile => ({
  ...COST_PROFILE_PRESETS.zero,
  id: "custom",
  label: "Custom",
  ...overrides,
});
const costProfiles: Record<string, CostProfile> = {
  ...COST_PROFILE_PRESETS,
  "custom-atr": customProfile({
    slippage: { fraction: 0.1, kind: "atr", period: 14 },
    spreadBps: 2,
  }),
  "custom-bps": customProfile({
    commission: {
      maxPercentOfValue: null,
      maxPerOrder: 7.5,
      minPerOrder: 0.5,
      perContract: 0,
      percentOfValue: 0.05,
      perShare: 0.004,
      premiumTiers: [],
    },
    fees: { ofCommission: 0.01, ofSaleValue: 0.0001, perUnit: 0.001 },
    slippage: { bps: 3, kind: "bps" },
    spreadBps: 5,
  }),
  "custom-option": customProfile({
    commission: {
      maxPercentOfValue: 5,
      maxPerOrder: 40,
      minPerOrder: 1,
      perContract: 0.7,
      percentOfValue: 0.01,
      perShare: 0,
      premiumTiers: [
        { belowPremium: 0.1, perContract: 0.3 },
        { belowPremium: 1, perContract: 0.55 },
      ],
    },
    fees: { ofCommission: 0.002, ofSaleValue: 0.000_020_6, perUnit: 0.03 },
    instrument: "option",
    multiplier: 100,
    slippage: { bps: 20, kind: "bps" },
    spreadBps: 150,
  }),
  // Spread and slippage larger than the price, so a sell scales them down.
  "custom-wide": customProfile({
    slippage: { fraction: 3, kind: "atr", period: 5 },
    spreadBps: 25_000,
  }),
};

interface Spec {
  costBps: number;
  costs: { profile: CostProfile; capital: number } | null;
  /** DSL rules only: the time exit (setup replay). */
  maxHoldBars?: number;
  rule: Json;
  sectorQuadrants: SectorQuadrantSeries | null;
  stopLossPct: number;
  takeProfitPct: number;
}

const LENGTHS = [2, 5, 14, 20, 50, 200];
const sourced: Record<
  string,
  (values: Float64Array, n: number) => Float64Array
> = {
  ema: exponentialMean,
  highest: (values, n) => priorExtreme(values, n, 1),
  lowest: (values, n) => priorExtreme(values, n, -1),
  realizedVol: realizedVolatility,
  rollingMean,
  rsi: relativeStrength,
  sma: rollingMean,
  wilderRsi,
  zscore: rollingZScore,
};

/** Indicator series use the first INDICATOR_BARS daily bars to keep the file small. */
const INDICATOR_BARS = 250;
const head = (bars: BarColumns, count: number): BarColumns => ({
  c: bars.c.slice(0, count),
  h: bars.h.slice(0, count),
  l: bars.l.slice(0, count),
  o: bars.o.slice(0, count),
  t: bars.t.slice(0, count),
  v: (bars.v as Float64Array).slice(0, count),
});

/** Indicator series of one daily symbol (the first INDICATOR_BARS bars). */
const dailyIndicators = (symbol: string, all: BarColumns): Json[] => {
  const indicators: Json[] = [];
  const bars = head(all, INDICATOR_BARS);
  for (const length of LENGTHS) {
    const sources =
      symbol === "SPY" && [5, 20, 50].includes(length)
        ? ["close", "high"]
        : ["close"];
    for (const source of sources) {
      const values = source === "close" ? bars.c : bars.h;
      for (const [name, fn] of Object.entries(sourced)) {
        indicators.push({
          bars: INDICATOR_BARS,
          length,
          name,
          source,
          symbol,
          values: list(fn(values, length)),
        });
      }
    }
    const whole: Record<string, Float64Array> = {
      adx: averageDirectionalIndex(bars, length),
      atr: averageTrueRange(bars, length),
      costAtr: costAverageTrueRange(bars.h, bars.l, bars.c, length),
      rvol: relativeVolumeAtTime(bars.t, bars.v as Float64Array, length),
    };
    for (const [name, values] of Object.entries(whole)) {
      indicators.push({
        bars: INDICATOR_BARS,
        length,
        name,
        symbol,
        values: list(values),
      });
    }
  }
  return indicators;
};

/** Intraday: rvol sessions and slots (with a DST change), plus ATR and ADX, over all bars. */
const intradayIndicators = (bars: BarColumns): Json[] => {
  const indicators: Json[] = [];
  for (const length of [1, 2, 5, 9]) {
    indicators.push({
      bars: bars.c.length,
      length,
      name: "rvol",
      symbol: "intraday",
      values: list(
        relativeVolumeAtTime(bars.t, bars.v as Float64Array, length)
      ),
    });
  }
  indicators.push(
    {
      bars: bars.c.length,
      length: 14,
      name: "atr",
      symbol: "intraday",
      values: list(averageTrueRange(bars, 14)),
    },
    {
      bars: bars.c.length,
      length: 14,
      name: "adx",
      symbol: "intraday",
      values: list(averageDirectionalIndex(bars, 14)),
    }
  );
  return indicators;
};

/** 1. Indicator series. */
const buildIndicators = (
  datasets: Record<string, BarColumns>,
  intraday: BarColumns
): Json[] => [
  ...dailyIndicators("SPY", datasets["SPY"] as BarColumns),
  ...dailyIndicators("QQQ", datasets["QQQ"] as BarColumns),
  ...intradayIndicators(intraday),
];

/** 2. Compiled DSL definitions. */
/** The series input of a case: the context, the traded symbol and the named calendar. */
const seriesInputOf = (
  series: SeriesJson,
  symbol: string | undefined,
  calendar: CalendarName | undefined
): StrategySeriesInput => ({
  context: series as StrategySeriesContext,
  ...(symbol === undefined ? {} : { symbol }),
  ...(calendar === undefined ? {} : { calendar: calendars()[calendar] }),
});

/**
 * Runs `build`. A refusal or an input error is part of the contract (Python refuses with the same
 * code and message, or raises the same message); any other error is a bug and is thrown again.
 */
export const orCaseError = <T>(
  build: () => T
): T | { error: string } | { refused: { code: string; message: string } } => {
  try {
    return build();
  } catch (error) {
    if (error instanceof StrategyUnsupportedError) {
      const { code, message } = error;
      return { refused: { code, message } };
    }
    if (error instanceof InstantBacktestInputError)
      return { error: error.message };
    throw error;
  }
};

/** JSON of a compiled strategy (Float64Array columns as lists). */
const compiledToJson = (compiled: ReturnType<typeof compileStrategy>) => ({
  exits: Array.from(compiled.exits),
  signals: Array.from(compiled.signals),
  stopDistance:
    compiled.stopDistance === undefined ? null : list(compiled.stopDistance),
  targetDistance:
    compiled.targetDistance === undefined
      ? null
      : list(compiled.targetDistance),
  ...(compiled.options === undefined ? {} : { options: compiled.options }),
  ...(compiled.portfolio === undefined
    ? {}
    : { portfolio: compiled.portfolio }),
  ...(compiled.management === undefined
    ? {}
    : {
        management: {
          ...compiled.management,
          ...(compiled.management.trail === undefined
            ? {}
            : {
                trail: {
                  ...compiled.management.trail,
                  atr: list(compiled.management.trail.atr),
                },
              }),
        },
      }),
  ...(compiled.closeAt === undefined
    ? {}
    : { closeAt: Array.from(compiled.closeAt) }),
  ...(compiled.leverage === undefined
    ? {}
    : { leverage: list(compiled.leverage) }),
});

const buildCompiled = (
  datasets: Record<string, BarColumns>,
  libraryDefinitions: readonly Readonly<{ definition: Json; id: string }>[],
  series: SeriesJson
): Json[] => {
  const compiledJson = (
    definition: Json,
    symbol: string,
    seriesSymbol = symbol,
    calendar?: CalendarName
  ) => {
    const parsed = StrategyDefinitionSchema.parse(definition);
    return orCaseError(() => {
      const compiled = compileStrategy(
        datasets[symbol] as BarColumns,
        parsed,
        sectorQuadrants,
        seriesInputOf(series, seriesSymbol, calendar)
      );
      return compiledToJson(compiled);
    });
  };

  const compiled: Json[] = [];
  const allDefinitions = [
    ...Object.entries(STRATEGY_TEMPLATES).map(([id, definition]) => ({
      definition,
      id: `template:${id}`,
    })),
    ...libraryDefinitions,
  ];
  for (const { id, definition } of allDefinitions) {
    for (const symbol of ["SPY", "QQQ"]) {
      compiled.push({
        definition,
        id,
        symbol,
        ...compiledJson(definition, symbol),
      });
    }
  }
  for (const { id, definition, symbol } of [
    ...extraDefinitions,
    ...reelDefinitions,
  ]) {
    compiled.push({
      definition,
      id,
      symbol,
      ...compiledJson(definition, symbol),
    });
  }
  for (const { id, definition, symbols } of qcDefinitions) {
    for (const symbol of symbols) {
      compiled.push({
        definition,
        id,
        symbol,
        ...compiledJson(definition, symbol),
      });
    }
  }
  for (const { id, definition, symbol } of intradayDefinitions) {
    compiled.push({
      definition,
      id,
      symbol,
      ...compiledJson(definition, symbol),
    });
  }
  for (const {
    calendar,
    definition,
    id,
    seriesSymbol,
    symbol,
  } of exprDefinitions) {
    compiled.push({
      ...(calendar === undefined ? {} : { calendar }),
      definition,
      id,
      ...(seriesSymbol === undefined ? {} : { seriesSymbol }),
      symbol,
      ...compiledJson(definition, symbol, seriesSymbol ?? symbol, calendar),
    });
  }

  return compiled;
};

/** 2b. Expression values (evaluateStrategyExpression / expression_values). */
const buildExpressions = (
  datasets: Record<string, BarColumns>,
  series: SeriesJson
): Json[] =>
  exprCases.map(({ calendar, dataset, expr, id, symbol }) => ({
    ...(calendar === undefined ? {} : { calendar }),
    dataset,
    expr,
    id,
    ...(symbol === undefined ? {} : { symbol }),
    ...orCaseError(() => ({
      values: list(
        evaluateStrategyExpression(
          datasets[dataset] as BarColumns,
          StrategyExprSchema.parse(expr),
          seriesInputOf(series, symbol, calendar)
        )
      ),
    })),
  }));

/** 2c. Server refusals with the support flags (serverStrategyRefusal / server_refusal). */
const buildServerRefusals = (): Json[] =>
  refusalCases.map(({ definition, id, support, timeframe }) => {
    const refusal = serverStrategyRefusal(
      StrategyDefinitionSchema.parse(definition),
      timeframe,
      support
    );
    return {
      definition,
      id,
      refusal: refusal ?? null,
      ...(support === undefined ? {} : { support }),
      ...(timeframe === undefined ? {} : { timeframe }),
    };
  });

/**
 * Number of top-level refinements of StrategyDefinitionSchema. Each one has a case in
 * definitionRefusalCases; buildDefinitionRefusals compares the count only.
 */
const DEFINITION_REFINEMENT_COUNT = 15;

/**
 * One definitionRefusals entry: the definition and the message that normalize_definition raises.
 * Without `python` that is the message of the first TypeScript issue, which must be one written
 * in strategy-dsl.ts (zod code "custom"). With `python`: zod wrote the first issue (a field
 * error); Python has its own text for it.
 */
export const definitionRefusalJson = ({
  definition,
  id,
  python,
}: DefinitionRefusalCase): Json => {
  const parsed = StrategyDefinitionSchema.safeParse(definition);
  if (parsed.success)
    throw new Error(`${id}: the schema accepts the definition`);
  const [first] = parsed.error.issues;
  const written = first?.code === "custom";
  if (python === undefined) {
    if (!written)
      throw new Error(
        `${id}: zod wrote the first issue; give the Python message`
      );
    return { definition, id, message: first.message };
  }
  if (written)
    throw new Error(
      `${id}: strategy-dsl.ts wrote the first issue; remove the Python message`
    );
  return { definition, id, message: python };
};

/**
 * Definitions with a value on each inclusive bound of a range (card
 * vertex-dsl-python-validator-field-guards). The schema must accept each one, and so must the Python
 * normalize_definition (test_a_value_on_the_bound_of_its_range_is_accepted). With the `field:*`
 * refusal cases just outside the bounds, a changed bound of the schema stops the generator.
 */
const filtersOf = (...filters: Json[]) => ({ ...plainDefinition, filters });
const definitionAcceptanceCases: readonly Readonly<{
  definition: Json;
  id: string;
}>[] = [
  {
    definition: { ...plainDefinition, stopLoss: { kind: "pct", pct: 99 } },
    id: "bound:stopLossPct",
  },
  {
    definition: {
      ...plainDefinition,
      stopLoss: { kind: "atr", length: 1000, multiple: 100 },
    },
    id: "bound:stopLossAtr",
  },
  {
    definition: {
      ...plainDefinition,
      sizing: { maxLeverage: 50, mode: "riskPct", riskPct: 100 },
      stopLoss: pctStop,
    },
    id: "bound:riskPct",
  },
  {
    definition: {
      ...plainDefinition,
      entry: {
        all: [
          { ...always, right: { type: "const", value: 1e12 } },
          { ...always, right: { type: "const", value: -1e12 } },
          { ...always, left: { length: 1000, name: "sma", type: "indicator" } },
          { ...always, left: { length: 100, name: "rvol", type: "indicator" } },
          { ...always, left: { length: 2, name: "zscore", type: "indicator" } },
        ],
      },
    },
    id: "bound:expressions",
  },
  {
    definition: {
      ...plainDefinition,
      entry: {
        all: new Array(8).fill(always),
        any: new Array(8).fill(always),
      },
      exit: { any: new Array(8).fill(always) },
    },
    id: "bound:conditionCounts",
  },
  {
    definition: {
      ...plainDefinition,
      session: { endUtc: "23:59", startUtc: "00:00" },
    },
    id: "bound:session",
  },
  {
    definition: {
      ...plainDefinition,
      description: "d".repeat(2000),
      name: "n".repeat(120),
    },
    id: "bound:textLengths",
  },
  // zod counts the characters of a text as code points, and JavaScript trim keeps U+001F.
  {
    definition: {
      ...plainDefinition,
      description: "😀".repeat(2000),
      name: "😀".repeat(120),
    },
    id: "bound:textCodePoints",
  },
  { definition: { ...plainDefinition, name: "\u001f" }, id: "bound:nameTrim" },
  {
    definition: filtersOf(
      { length: 20, max: 0, min: 0, type: "ivRank" },
      { length: 1000, max: 100, min: 100, type: "ivRank" },
      { maxRatio: 10, minRatio: 10, type: "vixTermStructure" },
      { maxTermRatio: 10, maxVix: 200, trendLength: 1000, type: "volRegime" }
    ),
    id: "bound:seriesFilters",
  },
  {
    definition: {
      ...filtersOf({
        maxTermRatio: 1,
        maxVix: 30,
        trendLength: 1,
        type: "volRegime",
      }),
      stopLoss: { kind: "atr", length: 1, multiple: 2 },
    },
    id: "bound:lowerLengths",
  },
  {
    definition: filtersOf(
      { ...opexWeek, fromDay: -10, toDay: 10, window: "turnOfMonth" },
      { ...opexWeek, fromDay: -1, toDay: 1, window: "turnOfMonth" },
      {
        ...opexWeek,
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        window: "months",
      },
      {
        quadrants: ["leading", "weakening", "lagging", "improving"],
        sector: "XLRE",
        timeframe: "daily",
        type: "sectorQuadrant",
      }
    ),
    id: "bound:calendarAndSectorFilters",
  },
];

/** One definitionAcceptances entry; throws when the schema refuses the definition. */
export const definitionAcceptanceJson = ({
  definition,
  id,
}: Readonly<{ definition: Json; id: string }>): Json => {
  if (!StrategyDefinitionSchema.safeParse(definition).success)
    throw new Error(`${id}: the schema refuses the definition`);
  return { definition, id };
};

/** 2d. Definition refusals (StrategyDefinitionSchema / normalize_definition). */
export const buildDefinitionRefusals = (
  refinements = StrategyDefinitionSchema._zod.def.checks?.length
): Json[] => {
  if (refinements !== DEFINITION_REFINEMENT_COUNT)
    throw new Error(
      `StrategyDefinitionSchema has ${refinements} refinements, not ${DEFINITION_REFINEMENT_COUNT}: add a definitionRefusalCases entry for each new one, port it to normalize_definition, then update DEFINITION_REFINEMENT_COUNT`
    );
  return definitionRefusalCases.map(definitionRefusalJson);
};

/** 3. Fixed-rule signals. */
const buildFixedRules = (datasets: Record<string, BarColumns>): Json[] => {
  const fixedRules: Json[] = [];
  for (const { id, rule } of RULES) {
    for (const symbol of ["SPY", "QQQ", "gap"]) {
      if (symbol === "gap" && rule.kind !== "smaCross") continue;
      const bars = datasets[symbol] as BarColumns;
      if (symbol === "gap") {
        const tiny = { fast: 2, kind: "smaCross", slow: 3 } as const;
        fixedRules.push({
          id: "smaCross-2-3",
          rule: tiny,
          signals: Array.from(signalsFor(bars, tiny, bars.c.length)),
          symbol,
        });
        continue;
      }
      fixedRules.push({
        id,
        rule,
        signals: Array.from(signalsFor(bars, rule, bars.c.length)),
        symbol,
      });
    }
  }
  return fixedRules;
};

const UNITS = [0, 1, 37.5, 1000, 250_000];
const PRICES = [0.04, 0.07, 0.5, 2, 101.37, 450.25];
const ATRS = [Number.NaN, 0.03, 2.5];

/** orderCharges and fillCosts samples of one profile, both sides. */
const chargeSamples = (profile: CostProfile) => {
  const charges: Json[] = [];
  const fills: Json[] = [];
  for (const side of ["buy", "sell"] as const) {
    for (const units of UNITS) {
      for (const price of PRICES) {
        const charge = orderCharges(profile, side, units, price);
        charges.push({ price, side, units, ...charge });
        for (const atr of ATRS) {
          fills.push({
            atr: Number.isFinite(atr) ? atr : null,
            // "price" below is the fill price; the reference price is "quote".
            quote: price,
            side,
            units,
            ...fillCosts(profile, side, units, price, atr),
          });
        }
      }
    }
  }
  return { charges, fills };
};

/** affordableUnits samples of one profile. */
const affordableSamples = (profile: CostProfile): Json[] => {
  const affordable: Json[] = [];
  for (const cash of [0, 0.3, 1, 1.7, 5000, 100_000]) {
    for (const fill of [0.05, 0.9, 101.37, 450.25]) {
      for (const scale of [1, 50_000, 100_000]) {
        affordable.push({
          cash,
          fill,
          scale,
          units: affordableUnits(profile, cash, fill, scale),
        });
      }
    }
  }
  return affordable;
};

/** 4. Cost samples. */
const buildCosts = (): Json[] =>
  Object.entries(costProfiles).map(([id, profile]) => {
    const { charges, fills } = chargeSamples(profile);
    return {
      affordable: affordableSamples(profile),
      charges,
      fills,
      id,
      profile,
    };
  });

/** 5. Engine cases. Adds the gap-case bars to `datasets`. */
const buildEngine = (
  datasets: Record<string, BarColumns>,
  libraryDefinitions: readonly Readonly<{ definition: Json; id: string }>[]
): Json[] => {
  const resultJson = (result: InstantRunResult) => ({
    equity: list(result.equity),
    stats: result.stats,
    trades: result.trades,
  });

  const engine: Json[] = [];
  const fixedCase = (id: string, symbol: string, spec: Spec) => {
    const bars = datasets[symbol] as BarColumns;
    const result = runInstantBacktest(bars, {
      costBps: spec.costBps,
      rule: spec.rule as InstantRule,
      stopLossPct: spec.stopLossPct,
      takeProfitPct: spec.takeProfitPct,
      ...(spec.costs === null ? {} : { costs: spec.costs }),
    });
    engine.push({ id, spec, symbol, ...resultJson(result) });
  };
  const dslCase = (id: string, symbol: string, spec: Spec) => {
    const bars = datasets[symbol] as BarColumns;
    const { definition: input } = spec.rule as { definition: Json };
    const definition = StrategyDefinitionSchema.parse(input);
    const result = runStrategyDefinition(
      bars,
      definition,
      spec.costBps,
      spec.costs ?? undefined,
      spec.sectorQuadrants ?? undefined,
      undefined,
      undefined,
      undefined,
      spec.maxHoldBars
    );
    engine.push({ id, spec, symbol, ...resultJson(result) });
  };
  const baseSpec = (rule: Json): Spec => ({
    costBps: 10,
    costs: null,
    rule,
    sectorQuadrants: null,
    stopLossPct: 0,
    takeProfitPct: 0,
  });

  fixedCase("smaCross-10-30", "SPY", baseSpec(SMA_CROSS));
  fixedCase("smaCross-10-30-stop-target", "SPY", {
    ...baseSpec(SMA_CROSS),
    stopLossPct: 5,
    takeProfitPct: 10,
  });
  fixedCase("smaCross-10-30-stop-target-qqq", "QQQ", {
    ...baseSpec(SMA_CROSS),
    stopLossPct: 3,
    takeProfitPct: 4,
  });
  fixedCase("breakout-ibkr-tiered", "SPY", {
    ...baseSpec(BREAKOUT_TREND),
    costs: {
      capital: 100_000,
      profile: COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"],
    },
  });
  fixedCase("rsiReversion-14-30-70", "QQQ", baseSpec(RSI_REVERSION));
  for (const { id, definition } of libraryDefinitions) {
    for (const symbol of ["SPY", "QQQ"]) {
      dslCase(`${id}:${symbol}`, symbol, baseSpec({ definition, kind: "dsl" }));
    }
  }
  for (const symbol of ["SPY", "QQQ"]) {
    dslCase(`template:atrExpansion:custom-atr:${symbol}`, symbol, {
      ...baseSpec({ definition: STRATEGY_TEMPLATES.atrExpansion, kind: "dsl" }),
      costs: {
        capital: 50_000,
        profile: costProfiles["custom-atr"] as CostProfile,
      },
    });
  }
  dslCase(
    "template:rsiReversion:SPY",
    "SPY",
    baseSpec({
      definition: STRATEGY_TEMPLATES.rsiReversion,
      kind: "dsl",
    })
  );
  // The setup replay time exit (switch plan step 5): ATR stop and target with maxHoldBars.
  for (const symbol of ["SPY", "QQQ"]) {
    dslCase(`template:atrExpansion:max-hold-7:${symbol}`, symbol, {
      ...baseSpec({ definition: STRATEGY_TEMPLATES.atrExpansion, kind: "dsl" }),
      costBps: 0,
      maxHoldBars: 7,
    });
  }
  dslCase("extra:sector:SPY", "SPY", {
    ...baseSpec({
      definition: extraDefinitions[4]?.definition,
      kind: "dsl",
    }),
    sectorQuadrants,
  });
  // Calendar filters run on the server engine; series filters and options blocks are refused.
  for (const [id, symbol] of [
    ["qc:calendar:opexTrend", "SPY"],
    ["qc:calendar:opexTrend", "QQQ"],
    ["qc:calendar:opexTrend", "calendar"],
    ["qc:calendar:turnOfMonth", "SPY"],
  ] as const) {
    dslCase(`${id}:${symbol}`, symbol, {
      ...baseSpec({
        definition: qcDefinitions.find((entry) => entry.id === id)?.definition,
        kind: "dsl",
      }),
      sectorQuadrants,
    });
  }
  const alwaysIn = (stopPct: number, targetPct: number): Json => ({
    entry: {
      all: [
        {
          left: { field: "close", type: "price" },
          op: ">",
          right: { type: "const", value: 0 },
        },
      ],
    },
    name: "Always in",
    stopLoss: { kind: "pct", pct: stopPct },
    takeProfit: { kind: "pct", pct: targetPct },
    version: 1,
  });
  dslCase(
    "synthetic:gap",
    "gap",
    baseSpec({ definition: alwaysIn(5, 10), kind: "dsl" })
  );
  dslCase(
    "synthetic:bothHit",
    "bothHit",
    baseSpec({
      definition: alwaysIn(5, 10),
      kind: "dsl",
    })
  );
  fixedCase("synthetic:gap-fixed", "gap", {
    ...baseSpec({ fast: 1, kind: "smaCross", slow: 2 }),
    stopLossPct: 5,
    takeProfitPct: 10,
  });

  // One-gap cases: entry fills at the open of bar 1 (100), so the stop is 95 and the target 110.
  // Bar 2 holds the gap. The generator checks the first trade's exit reason and price.
  const GAP_CASES: {
    id: string;
    bar: [number, number, number, number];
    reason: string;
    price: number;
  }[] = [
    // TS checks the stop first, even when the bar opens above the target.
    {
      bar: [112, 113, 90, 100],
      id: "synthetic:gapAboveTargetLowBelowStop",
      price: 95,
      reason: "stop",
    },
    {
      bar: [112, 113, 105, 108],
      id: "synthetic:gapAboveTarget",
      price: 112,
      reason: "target",
    },
    {
      bar: [92, 93, 91, 92],
      id: "synthetic:gapBelowStop",
      price: 92,
      reason: "stop",
    },
  ];
  for (const { id, bar, reason, price } of GAP_CASES) {
    const flat: [number, number, number, number] = [100, 101, 99, 100];
    datasets[id] = dailyRows([flat, flat, bar, flat, flat]);
    dslCase(id, id, baseSpec({ definition: alwaysIn(5, 10), kind: "dsl" }));
    const first = engine.at(-1) as { trades: InstantRunResult["trades"] };
    assertGapExit(id, first.trades[0], reason, price);
  }

  // LD34 on hourly and daily bars, with a cost profile, and a variant with breakeven and a target.
  dslCase(
    "reel:ld34:hourly",
    "hourly",
    baseSpec({ definition: LD34, kind: "dsl" })
  );
  dslCase("reel:ld34:hourly:ibkr", "hourly", {
    ...baseSpec({ definition: LD34, kind: "dsl" }),
    costs: {
      capital: 100_000,
      profile: COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"],
    },
  });
  dslCase("reel:ld34:SPY", "SPY", baseSpec({ definition: LD34, kind: "dsl" }));
  dslCase(
    "reel:mixedDaily:hourly",
    "hourly",
    baseSpec({ definition: MIXED_DAILY, kind: "dsl" })
  );

  // Intraday sessions: GHLZ and ZAB long and short, a short with a percent stop and target, and
  // ZAB short with a cost profile (both legs of a short pay charges).
  for (const { definition, id, symbol } of intradayDefinitions) {
    if (symbol === "session" && !id.startsWith("intraday:grid:"))
      dslCase(id, symbol, baseSpec({ definition, kind: "dsl" }));
  }
  dslCase(
    "intraday:ghlz:short:stop",
    "session",
    baseSpec({
      definition: ghlz("short", {
        stopLoss: { kind: "pct", pct: 0.2 },
        takeProfit: { kind: "pct", pct: 0.3 },
      }),
      kind: "dsl",
    })
  );
  dslCase("intraday:zab:short:ibkr", "session", {
    ...baseSpec({ definition: zab("short"), kind: "dsl" }),
    costs: {
      capital: 100_000,
      profile: COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"],
    },
  });

  return engine;
};

/**
 * NYSE holidays 1998 to 2035 (YYYY-MM-DD) with the special closures, the calendar the
 * calendarWindow filter uses.
 */
const holidayDates = (): string[] => {
  const dates: string[] = [];
  for (let year = 1998; year <= 2035; year += 1)
    for (const day of [...nyseHolidays(year)].sort((a, b) => a - b))
      dates.push(new Date(day * 86_400_000).toISOString().slice(0, 10));
  return dates;
};

/** Session indicator and volTarget series use the first SESSION_INDICATOR_BARS session bars. */
const SESSION_INDICATOR_BARS = 4500;

/** The New York sessions of intraday bars; throws for bars without two bars on one New York date. */
export const requireIntradaySessions = (
  bars: BarColumns,
  intraday: StrategyIntraday
): IntradaySessions => {
  const sessions = intradaySessions(bars, intraday);
  if (sessions === undefined) throw new Error("session bars must be intraday");
  return sessions;
};

/** 7. Session indicators and volTarget leverage (intraday bars, and daily bars for volTarget). */
const buildSessionIndicators = (
  datasets: Record<string, BarColumns>
): Json[] => {
  const bars = head(datasets["session"] as BarColumns, SESSION_INDICATOR_BARS);
  const intraday: StrategyIntraday = {
    ...NEW_YORK_SESSION,
    entryFrom: "10:00",
    entryTo: "15:30",
    timezone: "America/New_York",
  };
  const exprs: StrategySessionIndicatorExpr[] = [
    { name: "vwap", type: "indicator" },
    {
      from: "prevClose",
      name: "sessionReturn",
      to: "10:00",
      type: "indicator",
    },
    { from: "open", name: "sessionReturn", to: "11:00", type: "indicator" },
    { from: "15:00", name: "sessionReturn", to: "15:30", type: "indicator" },
    { band: "upper", length: 14, name: "noiseBand", type: "indicator" },
    {
      band: "lower",
      length: 5,
      multiple: 0.5,
      name: "noiseBand",
      type: "indicator",
    },
  ];
  const sizing = { length: 14, maxLeverage: 4, targetPct: 2 };
  const sessions = requireIntradaySessions(bars, intraday);
  return [
    ...exprs.map((expr) => ({
      bars: SESSION_INDICATOR_BARS,
      expr,
      intraday,
      symbol: "session",
      values: list(sessionIndicatorSeries(bars, intraday, expr)),
    })),
    {
      bars: SESSION_INDICATOR_BARS,
      intraday,
      sizing,
      symbol: "session",
      values: list(volTargetLeverage(bars, sizing, sessions)),
    },
    ...["session", "SPY"].map((symbol) => ({
      bars: symbol === "SPY" ? BAR_COUNT : SESSION_INDICATOR_BARS,
      intraday: null,
      sizing,
      symbol,
      values: list(
        volTargetLeverage(
          symbol === "SPY" ? (datasets["SPY"] as BarColumns) : bars,
          sizing
        )
      ),
    })),
  ];
};

type TrendExpr = StrategyIndicatorExpr | StrategyTrendIndicatorExpr;
const supertrendExpr = (
  multiple: number,
  output: "line" | "direction",
  extra: Partial<StrategyTrendIndicatorExpr> = {}
): TrendExpr =>
  ({
    length: 10,
    multiple,
    name: "supertrend",
    output,
    type: "indicator",
    ...extra,
  }) as TrendExpr;
const alphaTrendExpr = (
  momentum: "mfi" | "rsi",
  output: "line" | "direction",
  extra: Partial<StrategyTrendIndicatorExpr> = {}
): TrendExpr =>
  ({
    length: 14,
    momentum,
    multiple: 1,
    name: "alphaTrend",
    output,
    type: "indicator",
    ...extra,
  }) as TrendExpr;
const chandelierExpr = (
  output: "longStop" | "shortStop" | "direction",
  extra: Partial<StrategyTrendIndicatorExpr> = {}
): TrendExpr =>
  ({
    length: 22,
    multiple: 3,
    name: "chandelierExit",
    output,
    type: "indicator",
    ...extra,
  }) as TrendExpr;
const classicExpr = (
  name: StrategyIndicatorExpr["name"],
  length: number,
  source: StrategyIndicatorExpr["source"],
  timeframe: StrategyIndicatorExpr["timeframe"],
  offset = 0
): TrendExpr => ({
  length,
  name,
  offset,
  source,
  timeframe,
  type: "indicator",
});

/**
 * 8. Trend indicators (supertrend, alphaTrend, chandelierExit) and the 5m / 15m indicator
 * timeframes under an intraday block (intradayIndicatorSeries; offsets applied).
 * timeline-boundaries reads the bucket closes, highs and lows of the completed-bar timeline table
 * (docs/specs/strategies/trend-trio-design.md).
 */
const buildTrendIndicators = (datasets: Record<string, BarColumns>): Json[] => {
  const intraday: StrategyIntraday = {
    ...NEW_YORK_SESSION,
    entryFrom: "09:35",
    entryTo: "15:50",
    timezone: "America/New_York",
  };
  const minutes = datasets["trendMinutes"] as BarColumns;
  const cases: [string, string, TrendExpr[]][] = [
    [
      "supertrend-direction-5m",
      "trendMinutes",
      [supertrendExpr(3, "direction", { timeframe: "5m" })],
    ],
    [
      "supertrend-line-1m",
      "trendMinutes",
      [supertrendExpr(3, "line"), supertrendExpr(3, "line", { offset: 3 })],
    ],
    [
      "supertrend-two-multiples",
      "session",
      [
        supertrendExpr(1.5, "direction", { timeframe: "15m" }),
        supertrendExpr(3, "direction", { timeframe: "15m" }),
        supertrendExpr(3, "line", { offset: 1, timeframe: "15m" }),
        supertrendExpr(2, "direction", {
          length: 5,
          offset: 1,
          timeframe: "1d",
        }),
      ],
    ],
    [
      "alphatrend-mfi-15m",
      "trendMinutes",
      [
        alphaTrendExpr("mfi", "line", { timeframe: "15m" }),
        alphaTrendExpr("mfi", "direction", { timeframe: "15m" }),
      ],
    ],
    [
      "alphatrend-rsi-5m",
      "trendMinutes",
      [
        alphaTrendExpr("rsi", "line", { timeframe: "5m" }),
        alphaTrendExpr("rsi", "direction", { offset: 1, timeframe: "5m" }),
        alphaTrendExpr("rsi", "direction"),
      ],
    ],
    [
      "chandelier-direction-1m",
      "trendMinutes",
      [chandelierExpr("direction"), chandelierExpr("direction", { offset: 2 })],
    ],
    [
      "chandelier-stops-5m",
      "trendMinutes",
      [
        chandelierExpr("longStop", { timeframe: "5m" }),
        chandelierExpr("shortStop", { timeframe: "5m" }),
        chandelierExpr("direction", { timeframe: "5m" }),
      ],
    ],
    [
      "uma-offset-buckets-5m",
      "trendMinutes",
      [
        classicExpr("sma", 20, "close", "5m"),
        classicExpr("sma", 20, "close", "5m", 2),
        classicExpr("ema", 38, "close", "5m"),
        classicExpr("highest", 3, "high", "5m"),
        classicExpr("lowest", 3, "low", "15m", 1),
        classicExpr("atr", 5, "close", "15m"),
      ],
    ],
    [
      "timeline-boundaries",
      "trendMinutes",
      [
        classicExpr("sma", 1, "close", "5m"),
        classicExpr("sma", 1, "close", "15m"),
        classicExpr("highest", 1, "high", "5m"),
        classicExpr("lowest", 1, "low", "5m"),
      ],
    ],
  ];
  return cases.map(([id, symbol, exprs]) => {
    const bars =
      symbol === "session"
        ? head(datasets["session"] as BarColumns, SESSION_INDICATOR_BARS)
        : minutes;
    return {
      bars: bars.c.length,
      exprs,
      id,
      intraday,
      symbol,
      values: exprs.map((expr) =>
        list(intradayIndicatorSeries(bars, intraday, expr))
      ),
    };
  });
};

/** 6. Server engine refusals: runStrategyDefinition (TS) and plan_run (Python) refuse alike. */
const buildEngineRefusals = (datasets: Record<string, BarColumns>): Json[] =>
  [
    ["qc:options:putCredit", "SPY"],
    ["qc:ivRank:min", "SPY"],
    ["qc:series:esTrend", "SPY"],
    ["qc:calendar:opexWeek", "intraday"],
    // Daily bars, but a known intraday timeframe: refused by the timeframe, not the spacing.
    ["qc:calendar:opexWeek", "SPY", "1m"],
    // The equity engine refuses options whatever the support flags say.
    ["qc:options:putCredit", "SPY", "1d", { options: true, series: true }],
    // Series support: the next refusal is the calendar filter on an intraday timeframe.
    ["qc:calendar:opexTrend", "SPY", "5m", { series: true }],
  ].map(([id, symbol, timeframe, support]) => {
    const definition = qcDefinitions.find((entry) => entry.id === id)
      ?.definition as Json;
    try {
      runStrategyDefinition(
        datasets[symbol as string] as BarColumns,
        StrategyDefinitionSchema.parse(definition),
        10,
        undefined,
        sectorQuadrants,
        timeframe as string | undefined,
        support as StrategyServerSupport | undefined
      );
      return { id, ran: true };
    } catch (error) {
      const { code, message } = error as StrategyUnsupportedError;
      return {
        code,
        definition,
        id,
        message,
        symbol,
        ...(timeframe === undefined ? {} : { timeframe }),
        ...(support === undefined ? {} : { support }),
      };
    }
  });

const buildGolden = (io: GoldenIo): string => {
  const csv = (file: string) =>
    io.readText(join("tests/fixtures/golden", file));
  const intraday = intradayBars();
  const datasets: Record<string, BarColumns> = {
    bothHit: bothHitBars(),
    calendar: calendarBars(),
    gap: gapBars(),
    hourly: hourlyBars(),
    intraday,
    monthly: monthlyBars(),
    QQQ: readCsv(csv("QQQ-1d.csv"), BAR_COUNT),
    SPY: readCsv(csv("SPY-1d.csv"), BAR_COUNT),
    session: sessionBars(),
    trendMinutes: trendMinuteBars(),
  };

  // 2. Compiled DSL definitions.
  const library = JSON.parse(
    io.readText("research/backtests/quantjourney/library.json")
  ) as { strategies: { id: string; granularity: string; dsl: Json | null }[] };
  const libraryDefinitions = library.strategies
    .filter(
      (strategy) => strategy.dsl !== null && strategy.granularity === "1d"
    )
    .map((strategy) => ({
      definition: strategy.dsl,
      id: `library:${strategy.id}`,
    }));

  const series = seriesContext();
  const indicators = buildIndicators(datasets, intraday);
  const compiled = buildCompiled(datasets, libraryDefinitions, series);
  const fixedRules = buildFixedRules(datasets);
  const costs = buildCosts();
  // Runs last: the engine cases add the gap-case bars to `datasets`.
  const engine = buildEngine(datasets, libraryDefinitions);
  const engineRefusals = buildEngineRefusals(datasets);
  const expressions = buildExpressions(datasets, series);
  const serverRefusals = buildServerRefusals();
  const golden = {
    barCount: BAR_COUNT,
    bars: Object.fromEntries(
      Object.entries(datasets).map(([key, bars]) => [key, barsJson(bars)])
    ),
    calendars: calendars(),
    compiled,
    costs,
    definitionAcceptances: definitionAcceptanceCases.map(
      definitionAcceptanceJson
    ),
    definitionRefusals: buildDefinitionRefusals(),
    engine,
    engineRefusals,
    expressions,
    fixedRules,
    indicators,
    nyseHolidays: holidayDates(),
    sectorQuadrants,
    series,
    serverRefusals,
    sessionIndicators: buildSessionIndicators(datasets),
    trendIndicators: buildTrendIndicators(datasets),
  };

  return `${JSON.stringify(golden)}\n`;
};
