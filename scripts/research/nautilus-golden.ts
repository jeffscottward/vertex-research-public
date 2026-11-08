// Golden fixtures for the Python port of the instant backtest signals and costs.
// `bun run research:nautilus-golden` (scripts/research-nautilus-golden.ts) writes the output of
// buildGolden to services/research/tests/fixtures/nautilus_backtest/golden.json. The TypeScript
// code is the reference; the Python tests (test_nautilus_backtest_signals.py) compare against that
// file, and nautilus-golden.test.ts checks that the committed file still matches this code.
// Output is deterministic: no clock, no random source (a fixed LCG makes the synthetic bars).
// NaN values are written as null.

import { join } from "node:path";

import {
  affordableUnits,
  averageTrueRange as costAverageTrueRange,
  COST_PROFILE_PRESETS,
  type CostProfile,
  fillCosts,
  orderCharges,
} from "../../packages/api/src/backtest-costs.ts";
import {
  type BarColumns,
  type InstantRule,
  type InstantTrade,
  signalsFor,
  type InstantRunResult,
  priorExtreme,
  rollingMean,
  runInstantBacktest,
  wilderRsi,
} from "../../packages/api/src/instant-backtest-engine.ts";
import {
  averageDirectionalIndex,
  averageTrueRange,
  compileStrategy,
  exponentialMean,
  realizedVolatility,
  relativeStrength,
  relativeVolumeAtTime,
  rollingZScore,
  runStrategyDefinition,
  type CompiledStrategy,
  nyseHolidays,
  type SectorQuadrantSeries,
  type StrategySeriesContext,
  type StrategyUnsupportedError,
} from "../../packages/api/src/strategy-dsl-compile.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "../../packages/api/src/strategy-dsl.ts";

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
  "XLK:weekly": [
    { date: "2015-01-30", quadrant: "improving" },
    { date: "2015-03-06", quadrant: "leading" },
    { date: "2015-05-01", quadrant: "weakening" },
    { date: "2015-07-02", quadrant: "lagging" },
    { date: "2015-09-04", quadrant: "improving" },
    { date: "2016-01-08", quadrant: "leading" },
  ],
  "XLE:daily": [
    { date: "2024-03-05", quadrant: "leading" },
    { date: "2024-03-08", quadrant: "lagging" },
    { date: "2024-03-12", quadrant: "leading" },
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
    VIX: {
      ...record(weekdays, vix, (index) => index % 41 === 7),
      [weekdays[100] as string]: null,
    },
    VIX3M: record(weekdays, vix3m, (index) => index % 53 === 11),
    VXN: record(weekdays, walk(weekdays, 12, 20, 1.3, 0.04), () => false),
    // Gaps of 12 and 4 weekdays: the series filter carries a value at most 5 trading days.
    "CL=F": record(
      weekdays,
      walk(weekdays, 16, 60, 1.2, 0),
      (index) => (index >= 60 && index < 72) || (index >= 200 && index < 204)
    ),
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
  "custom-bps": customProfile({
    commission: {
      maxPerOrder: 7.5,
      maxPercentOfValue: null,
      minPerOrder: 0.5,
      perContract: 0,
      perShare: 0.004,
      percentOfValue: 0.05,
      premiumTiers: [],
    },
    fees: { ofCommission: 0.01, ofSaleValue: 0.0001, perUnit: 0.001 },
    slippage: { bps: 3, kind: "bps" },
    spreadBps: 5,
  }),
  "custom-atr": customProfile({
    slippage: { fraction: 0.1, kind: "atr", period: 14 },
    spreadBps: 2,
  }),
  "custom-option": customProfile({
    commission: {
      maxPerOrder: 40,
      maxPercentOfValue: 5,
      minPerOrder: 1,
      perContract: 0.7,
      perShare: 0,
      percentOfValue: 0.01,
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
  rule: Json;
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
  costs: { profile: CostProfile; capital: number } | null;
  sectorQuadrants: SectorQuadrantSeries | null;
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
const buildCompiled = (
  datasets: Record<string, BarColumns>,
  libraryDefinitions: readonly Readonly<{ definition: Json; id: string }>[],
  series: SeriesJson
): Json[] => {
  const compiledJson = (definition: Json, symbol: string) => {
    const parsed = StrategyDefinitionSchema.parse(definition);
    let compiled: CompiledStrategy;
    try {
      compiled = compileStrategy(
        datasets[symbol] as BarColumns,
        parsed,
        sectorQuadrants,
        { context: series as StrategySeriesContext, symbol }
      );
    } catch (error) {
      // A refusal is part of the contract: Python must refuse with the same code and message.
      const { code, message } = error as StrategyUnsupportedError;
      return { refused: { code, message } };
    }
    return {
      exits: Array.from(compiled.exits),
      signals: Array.from(compiled.signals),
      stopDistance:
        compiled.stopDistance === undefined
          ? null
          : list(compiled.stopDistance),
      targetDistance:
        compiled.targetDistance === undefined
          ? null
          : list(compiled.targetDistance),
      ...(compiled.options === undefined ? {} : { options: compiled.options }),
    };
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
  for (const { id, definition, symbol } of extraDefinitions) {
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

  return compiled;
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
          symbol,
          signals: Array.from(signalsFor(bars, tiny, bars.c.length)),
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
      spec.sectorQuadrants ?? undefined
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

/** 6. Server engine refusals: runStrategyDefinition (TS) and plan_run (Python) refuse alike. */
const buildEngineRefusals = (datasets: Record<string, BarColumns>): Json[] =>
  [
    ["qc:options:putCredit", "SPY"],
    ["qc:ivRank:min", "SPY"],
    ["qc:series:esTrend", "SPY"],
    ["qc:calendar:opexWeek", "intraday"],
    // Daily bars, but a known intraday timeframe: refused by the timeframe, not the spacing.
    ["qc:calendar:opexWeek", "SPY", "1m"],
  ].map(([id, symbol, timeframe]) => {
    const definition = qcDefinitions.find((entry) => entry.id === id)
      ?.definition as Json;
    try {
      runStrategyDefinition(
        datasets[symbol as string] as BarColumns,
        StrategyDefinitionSchema.parse(definition),
        10,
        undefined,
        sectorQuadrants,
        timeframe
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
      };
    }
  });

const buildGolden = (io: GoldenIo): string => {
  const csv = (file: string) =>
    io.readText(join("tests/fixtures/golden", file));
  const intraday = intradayBars();
  const datasets: Record<string, BarColumns> = {
    SPY: readCsv(csv("SPY-1d.csv"), BAR_COUNT),
    QQQ: readCsv(csv("QQQ-1d.csv"), BAR_COUNT),
    intraday,
    gap: gapBars(),
    bothHit: bothHitBars(),
    calendar: calendarBars(),
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
  const golden = {
    barCount: BAR_COUNT,
    bars: Object.fromEntries(
      Object.entries(datasets).map(([key, bars]) => [key, barsJson(bars)])
    ),
    compiled,
    costs,
    engine,
    fixedRules,
    indicators,
    engineRefusals,
    nyseHolidays: holidayDates(),
    sectorQuadrants,
    series,
  };

  return `${JSON.stringify(golden)}\n`;
};
