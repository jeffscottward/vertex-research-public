// What: Golden fixture of the Academy modelled options backtest (packages/academy/src/backtest.ts) for the
// Python port and the NautilusTrader Academy engine (services/research/nautilus_backtest/academy/).
// TypeScript is the reference: every structure runs on fixed synthetic daily closes and the result
// (trades, per-bar equity, statistics) is written as JSON. Research only: no orders, no network.
//   bun run research:academy-golden
import {
  type BacktestResult,
  runOptionsBacktest,
} from "../../packages/academy/src/backtest.ts";
import { gaussian, mulberry32 } from "../../packages/academy/src/math.ts";
import type { StructureId } from "../../packages/academy/src/schema.ts";
import { STRUCTURE_DEFS } from "../../packages/academy/src/structures.ts";
import { academyEngineResult } from "../../packages/api/src/academy-engine-result.ts";
import type { InstantRunResult } from "../../packages/api/src/instant-backtest-engine.ts";

export const ACADEMY_GOLDEN_FIXTURE =
  "services/research/tests/fixtures/nautilus_backtest/academy-golden.json";

const DAY_MS = 86_400_000;
const TRADING_DAYS = 252;
const FRIDAY = 5;

export type GoldenSeries = Readonly<{
  t: number[];
  c: number[];
  /** Implied volatility per bar; null marks a missing value (NaN in the engine input). */
  iv?: (number | null)[];
}>;

type SeriesPlan = Readonly<{
  id: string;
  seed: number;
  bars: number;
  start: number;
  vol: number;
  drift: number;
  /** Bar index -> one-day return added on that bar (a gap). */
  shocks: Readonly<Record<number, number>>;
  iv: boolean;
}>;

const SERIES_PLANS: readonly SeriesPlan[] = [
  {
    bars: 420,
    drift: 0.08,
    id: "mid",
    iv: false,
    seed: 20_261_110,
    shocks: { 150: -0.06, 290: 0.05 },
    start: 100,
    vol: 0.22,
  },
  {
    bars: 380,
    drift: 0.1,
    id: "high",
    iv: true,
    seed: 77_001,
    shocks: { 120: -0.04, 121: -0.03, 300: 0.035 },
    start: 450,
    vol: 0.16,
  },
  {
    bars: 300,
    drift: -0.05,
    id: "low",
    iv: false,
    seed: 4242,
    shocks: { 90: -0.12, 200: 0.09 },
    start: 35,
    vol: 0.45,
  },
];

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** Weekday daily closes (UTC midnight bar times), a seeded lognormal walk with fixed gaps. */
export const buildSeries = (plan: SeriesPlan): GoldenSeries => {
  const random = mulberry32(plan.seed);
  const t: number[] = [];
  const c: number[] = [];
  const iv: (number | null)[] = [];
  let time = Date.UTC(2022, 0, 3);
  let price = plan.start;
  const dailyVol = plan.vol / Math.sqrt(TRADING_DAYS);
  const dailyDrift = plan.drift / TRADING_DAYS;
  for (let index = 0; index < plan.bars; index += 1) {
    const change = dailyDrift + dailyVol * gaussian(random);
    if (index > 0) price *= Math.exp(change) * (1 + (plan.shocks[index] ?? 0));
    t.push(time);
    c.push(round(price, 2));
    // A slow wave around the path volatility; every 37th value is missing (the engine then models it).
    iv.push(
      index % 37 === 11
        ? null
        : round(plan.vol * (1.05 + 0.25 * Math.sin(index / 17)), 4)
    );
    // The series starts on a Monday: after a Friday comes the next Monday.
    time += (new Date(time).getUTCDay() === FRIDAY ? 3 : 1) * DAY_MS;
  }
  return plan.iv ? { c, iv, t } : { c, t };
};

type CasePlan = Readonly<{
  id: string;
  series: string;
  /** Use only the first `bars` bars of the series. */
  bars?: number;
  structure: StructureId;
  rules: Readonly<Record<string, number>>;
  capital: number;
}>;

const CAPITAL: Readonly<Record<string, number>> = {
  high: 250_000,
  low: 50_000,
  mid: 100_000,
};

const VARIANTS: readonly CasePlan[] = [
  {
    capital: 100_000,
    id: "long_call:mid:tight",
    rules: { exitDte: 30, profitTakePct: 20, stopLossPct: 20 },
    series: "mid",
    structure: "long_call",
  },
  {
    capital: 2000,
    id: "iron_condor:high:too-small",
    rules: {},
    series: "high",
    structure: "iron_condor",
  },
  {
    capital: 100_000,
    id: "pmcc:mid:fast-roll",
    rules: { coreExitDte: 200, dte: 14 },
    series: "mid",
    structure: "pmcc",
  },
  {
    capital: 50_000,
    id: "short_strangle:low:costly",
    rules: { costPerContract: 1, riskPct: 20, slipCap: 0.5, slippagePct: 5 },
    series: "low",
    structure: "short_strangle",
  },
  {
    capital: 250_000,
    id: "covered_call:high:exit-dte",
    rules: { exitDte: 5 },
    series: "high",
    structure: "covered_call",
  },
  {
    capital: 100_000,
    id: "calendar_call:mid:short-cycle",
    rules: { coreDte: 90, coreExitDte: 20, dte: 10, exitDte: 2 },
    series: "mid",
    structure: "calendar_call",
  },
  {
    capital: 100_000,
    id: "synthetic_long:mid:risk-30",
    rules: { riskPct: 30 },
    series: "mid",
    structure: "synthetic_long",
  },
  {
    capital: 250_000,
    id: "synthetic_long:high:risk-40",
    rules: { riskPct: 40 },
    series: "high",
    structure: "synthetic_long",
  },
  {
    bars: 60,
    capital: 100_000,
    id: "long_call:mid:min-bars",
    rules: {},
    series: "mid",
    structure: "long_call",
  },
  {
    bars: 59,
    capital: 100_000,
    id: "error:too-few-bars",
    rules: {},
    series: "mid",
    structure: "long_call",
  },
  {
    capital: 100_000,
    id: "error:unknown-rule",
    rules: { coreDte: 90 },
    series: "mid",
    structure: "long_call",
  },
];

export const casePlans = (): CasePlan[] => [
  ...(Object.keys(STRUCTURE_DEFS) as StructureId[]).flatMap((structure) =>
    SERIES_PLANS.map((series) => ({
      capital: CAPITAL[series.id] as number,
      id: `${structure}:${series.id}`,
      rules: {},
      series: series.id,
      structure,
    }))
  ),
  ...VARIANTS,
];

const cut = (series: GoldenSeries, bars: number | undefined): GoldenSeries => {
  if (bars === undefined) return series;
  return {
    c: series.c.slice(0, bars),
    t: series.t.slice(0, bars),
    ...(series.iv === undefined ? {} : { iv: series.iv.slice(0, bars) }),
  };
};

/** The engine result shape of the dual run (packages/api/src/academy-engine-result.ts), compact. */
const engineJson = (
  result: BacktestResult,
  series: GoldenSeries,
  capital: number
) => {
  const closes = Float64Array.from(series.c);
  const mapped = academyEngineResult(
    result,
    {
      c: closes,
      h: closes,
      l: closes,
      o: closes,
      t: Float64Array.from(series.t),
    },
    capital
  );
  // Every fixture case keeps a positive equity (the mapping returns null otherwise).
  const { stats, trades } = mapped as InstantRunResult;
  return {
    stats,
    trades: trades.map((trade) => [
      trade.entryIndex,
      trade.exitIndex,
      trade.exitReason,
    ]),
  };
};

const resultJson = (
  result: BacktestResult,
  series: GoldenSeries,
  capital: number
) => {
  const indexOf = new Map(
    series.t.map((time, index) => [
      new Date(time).toISOString().slice(0, 10),
      index,
    ])
  );
  return {
    assumptions: result.assumptions,
    engine: engineJson(result, series, capital),
    equity: result.equity.map((point) => point.equity),
    // The engine marks at least 40 bars (60 bars minimum, 20 warm-up).
    firstIndex: indexOf.get((result.equity[0] as { t: string }).t),
    ivSource: result.ivSource,
    rules: result.rules,
    stats: result.stats,
    trades: result.trades.map((trade) => ({
      ...trade,
      entryIndex: indexOf.get(trade.entryT),
      exitIndex: indexOf.get(trade.exitT),
    })),
  };
};

export const runCase = (plan: CasePlan, series: GoldenSeries) => {
  const bars = cut(series, plan.bars);
  const head = {
    ...(plan.bars === undefined ? {} : { bars: plan.bars }),
    capital: plan.capital,
    id: plan.id,
    rules: plan.rules,
    series: plan.series,
    structure: plan.structure,
  };
  try {
    const result = runOptionsBacktest({
      bars: {
        c: bars.c,
        t: bars.t,
        ...(bars.iv === undefined
          ? {}
          : { iv: bars.iv.map((value) => value ?? Number.NaN) }),
      },
      capital: plan.capital,
      rules: plan.rules,
      structure: plan.structure,
    });
    return { ...head, result: resultJson(result, bars, plan.capital) };
  } catch (error) {
    return { ...head, error: (error as Error).message };
  }
};

/** Builds academy-golden.json (text with a trailing newline). Deterministic; one case per line. */
export const buildAcademyGolden = (): string => {
  const series = new Map(
    SERIES_PLANS.map((plan) => [plan.id, buildSeries(plan)])
  );
  const cases = casePlans().map((plan) =>
    runCase(plan, series.get(plan.series) as GoldenSeries)
  );
  const lines = [
    "{",
    `"note": ${JSON.stringify(
      "Written by scripts/research-academy-golden.ts from packages/academy/src/backtest.ts. Do not edit by hand."
    )},`,
    `"series": {`,
    [...series]
      .map(([id, value]) => `${JSON.stringify(id)}: ${JSON.stringify(value)}`)
      .join(",\n"),
    "},",
    `"cases": [`,
    cases.map((value) => JSON.stringify(value)).join(",\n"),
    "]",
    "}",
  ];
  return `${lines.join("\n")}\n`;
};

export type AcademyGoldenCliIo = Readonly<{
  stdout: { write: (line: string) => unknown };
  writeText: (path: string, text: string) => void;
}>;

export const runAcademyGoldenCli = (io: AcademyGoldenCliIo): number => {
  io.writeText(ACADEMY_GOLDEN_FIXTURE, buildAcademyGolden());
  io.stdout.write(`wrote ${ACADEMY_GOLDEN_FIXTURE}\n`);
  return 0;
};
