// Golden fixtures for the Python port of the instant backtest signals and costs.
// Run from the repo root:
//   bun scripts/research/nautilus-golden.ts
// It writes services/research/tests/fixtures/nautilus_backtest/golden.json. The TypeScript code is
// the reference; the Python tests (test_nautilus_backtest_signals.py) compare against this file.
// Output is deterministic: no clock, no random source (a fixed LCG makes the synthetic bars).
// NaN values are written as null.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  type SectorQuadrantSeries,
} from "../../packages/api/src/strategy-dsl-compile.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "../../packages/api/src/strategy-dsl.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(
  ROOT,
  "services/research/tests/fixtures/nautilus_backtest/golden.json"
);
const BAR_COUNT = 500;

type Json = unknown;

const list = (values: ArrayLike<number>): (number | null)[] =>
  Array.from(values, (value) => (Number.isFinite(value) ? value : null));

const readCsv = (file: string, count: number): BarColumns => {
  const lines = readFileSync(join(ROOT, "tests/fixtures/golden", file), "utf8")
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
    columns.v?.push(Number(volume));
  }
  return toBars(columns);
};

interface Columns {
  c: number[];
  h: number[];
  l: number[];
  o: number[];
  t: number[];
  v?: number[];
}

const toBars = (columns: Columns): BarColumns => ({
  c: Float64Array.from(columns.c),
  h: Float64Array.from(columns.h),
  l: Float64Array.from(columns.l),
  o: Float64Array.from(columns.o),
  t: Float64Array.from(columns.t),
  ...(columns.v === undefined ? {} : { v: Float64Array.from(columns.v) }),
});

const barsJson = (bars: BarColumns) => ({
  c: list(bars.c),
  h: list(bars.h),
  l: list(bars.l),
  o: list(bars.o),
  t: list(bars.t),
  ...(bars.v === undefined ? {} : { v: list(bars.v) }),
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

const intraday = intradayBars();
const datasets: Record<string, BarColumns> = {
  SPY: readCsv("SPY-1d.csv", BAR_COUNT),
  QQQ: readCsv("QQQ-1d.csv", BAR_COUNT),
  intraday,
  gap: gapBars(),
  bothHit: bothHitBars(),
};

// 1. Indicators.
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
const indicators: Json[] = [];
/** Indicator series use the first INDICATOR_BARS daily bars to keep the file small. */
const INDICATOR_BARS = 250;
const head = (bars: BarColumns, count: number): BarColumns => ({
  c: bars.c.slice(0, count),
  h: bars.h.slice(0, count),
  l: bars.l.slice(0, count),
  o: bars.o.slice(0, count),
  t: bars.t.slice(0, count),
  ...(bars.v === undefined ? {} : { v: bars.v.slice(0, count) }),
});
for (const symbol of ["SPY", "QQQ"]) {
  const bars = head(datasets[symbol] as BarColumns, INDICATOR_BARS);
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
}
// Intraday: rvol sessions and slots (with a DST change), plus ATR and ADX, over all bars.
{
  const bars = intraday;
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
}

// 2. Compiled DSL definitions.
const library = JSON.parse(
  readFileSync(
    join(ROOT, "research/backtests/quantjourney/library.json"),
    "utf8"
  )
) as { strategies: { id: string; granularity: string; dsl: Json | null }[] };
const libraryDefinitions = library.strategies
  .filter((strategy) => strategy.dsl !== null && strategy.granularity === "1d")
  .map((strategy) => ({
    definition: strategy.dsl,
    id: `library:${strategy.id}`,
  }));

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

const compiledJson = (definition: Json, bars: BarColumns) => {
  const parsed = StrategyDefinitionSchema.parse(definition);
  const compiled = compileStrategy(bars, parsed, sectorQuadrants);
  return {
    exits: Array.from(compiled.exits),
    signals: Array.from(compiled.signals),
    stopDistance:
      compiled.stopDistance === undefined ? null : list(compiled.stopDistance),
    targetDistance:
      compiled.targetDistance === undefined
        ? null
        : list(compiled.targetDistance),
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
      ...compiledJson(definition, datasets[symbol] as BarColumns),
    });
  }
}
for (const { id, definition, symbol } of extraDefinitions) {
  compiled.push({
    definition,
    id,
    symbol,
    ...compiledJson(definition, datasets[symbol] as BarColumns),
  });
}

// 3. Fixed rules. The rule signal functions are private in TS, so load a temporary copy of the
// engine module that also exports them (same code, only an extra export line).
const engineSource = readFileSync(
  join(ROOT, "packages/api/src/instant-backtest-engine.ts"),
  "utf8"
).replace(
  '"./backtest-costs.ts"',
  JSON.stringify(join(ROOT, "packages/api/src/backtest-costs.ts"))
);
const engineCopy = join(tmpdir(), "vertex-nautilus-golden-engine.ts");
writeFileSync(
  engineCopy,
  `${engineSource}\nexport { breakoutSignals, rsiReversionSignals, smaCrossSignals };\n`
);
type SignalFn = (
  bars: BarColumns,
  rule: InstantRule,
  size: number
) => Int8Array;
const privateRules = (await import(engineCopy)) as Record<string, SignalFn>;
const ruleSignals = (bars: BarColumns, rule: InstantRule): Int8Array =>
  (privateRules[`${rule.kind}Signals`] as SignalFn)(bars, rule, bars.c.length);

const RULES: { id: string; rule: InstantRule }[] = [
  { id: "smaCross-10-30", rule: { fast: 10, kind: "smaCross", slow: 30 } },
  {
    id: "breakout-20-10-50",
    rule: {
      entryLookback: 20,
      exitLookback: 10,
      kind: "breakout",
      trendSma: 50,
    },
  },
  {
    id: "breakout-20-10-0",
    rule: {
      entryLookback: 20,
      exitLookback: 10,
      kind: "breakout",
      trendSma: 0,
    },
  },
  {
    id: "rsiReversion-14-30-70",
    rule: { kind: "rsiReversion", overbought: 70, oversold: 30, period: 14 },
  },
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

const UNITS = [0, 1, 37.5, 1000, 250_000];
const PRICES = [0.04, 0.07, 0.5, 2, 101.37, 450.25];
const ATRS = [Number.NaN, 0.03, 2.5];
const costs: Json[] = [];
for (const [id, profile] of Object.entries(costProfiles)) {
  const charges: Json[] = [];
  const fills: Json[] = [];
  const affordable: Json[] = [];
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
  costs.push({ affordable, charges, fills, id, profile });
}

// 5. Engine cases.
const resultJson = (result: InstantRunResult) => ({
  equity: list(result.equity),
  stats: result.stats,
  trades: result.trades,
});

interface Spec {
  rule: Json;
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
  costs: { profile: CostProfile; capital: number } | null;
  sectorQuadrants: SectorQuadrantSeries | null;
}

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
  const rule = spec.rule;
  if (rule === null || typeof rule !== "object" || !("definition" in rule))
    throw new Error(`${id}: a DSL case needs rule.definition`);
  const definition = StrategyDefinitionSchema.parse(rule.definition);
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
        signals: Array.from(ruleSignals(bars, tiny)),
      });
      continue;
    }
    fixedRules.push({
      id,
      rule,
      signals: Array.from(ruleSignals(bars, rule)),
      symbol,
    });
  }
}

fixedCase("smaCross-10-30", "SPY", baseSpec(RULES[0]?.rule));
fixedCase("smaCross-10-30-stop-target", "SPY", {
  ...baseSpec(RULES[0]?.rule),
  stopLossPct: 5,
  takeProfitPct: 10,
});
fixedCase("smaCross-10-30-stop-target-qqq", "QQQ", {
  ...baseSpec(RULES[0]?.rule),
  stopLossPct: 3,
  takeProfitPct: 4,
});
fixedCase("breakout-ibkr-tiered", "SPY", {
  ...baseSpec(RULES[1]?.rule),
  costs: {
    capital: 100_000,
    profile: COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"],
  },
});
fixedCase("rsiReversion-14-30-70", "QQQ", baseSpec(RULES[3]?.rule));
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
  const trade = first.trades[0];
  if (
    trade?.exitIndex !== 2 ||
    trade.exitReason !== reason ||
    trade.exitPrice !== price
  )
    throw new Error(`${id}: unexpected first trade ${JSON.stringify(trade)}`);
}

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
  sectorQuadrants,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(golden)}\n`);
console.log(`wrote ${OUT}`);
