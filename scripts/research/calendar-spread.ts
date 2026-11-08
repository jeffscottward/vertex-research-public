// Long calendar spread: payoff, Greeks and a MODELED backtest (research only). Nothing here creates,
// routes or simulates broker orders. Spec and pre-set pass rule: docs/specs/strategies/long-calendar-spread.md.
//
//   bun run research:calendar-spread -- backtest --data ~/Documents/reports/vertex-calendar-spread/data \
//     --out research/backtests/calendar-spread/results.md
//   bun run research:calendar-spread -- play --asof 2026-11-06 --spot 45.97 --strike 100 \
//     --near 2027-02-19 --far 2027-05-21 --near-iv 1.34 --far-iv 1.259 --debit 3.75
//
// The data directory is the output of research/backtests/calendar-spread/fetch_data.py (CSV, date,close).
// Option prices are Black-Scholes prices from an implied-volatility proxy (no option-chain history exists).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  blackScholes,
  type OptionRight,
} from "../../packages/api/src/options-chain-greeks.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const TRADING_DAYS = 252;
export const COMMISSION_PER_SHARE = 0.0065;
export const MIN_SLIPPAGE = 0.01;
export const TERM_LIMIT = 1.1;
export const PROFIT_MULTIPLE = 1.5;
export const MIN_CYCLES = 30;
export const MIN_T_STAT = 2;
export const RV_WINDOW = 60;
export const RV_FLOOR = 0.2;
export const STUDY_START = "2011-01-03";

export type LegInput = Readonly<{
  right: OptionRight;
  spot: number;
  strike: number;
  years: number;
  volatility: number;
  rate: number;
  dividendYield: number;
}>;

export const intrinsic = (
  right: OptionRight,
  spot: number,
  strike: number
): number =>
  right === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);

const priced = (input: LegInput) => {
  const result = blackScholes(input);
  if (result === null) throw new RangeError("option input outside the model");
  return result;
};

/** Model value of one option: intrinsic at or after expiry, else max(Black-Scholes, intrinsic). */
export const legValue = (input: LegInput): number => {
  const floor = intrinsic(input.right, input.spot, input.strike);
  if (input.years <= 0) return floor;
  return Math.max(priced(input).price, floor);
};

export type CalendarInput = Readonly<{
  right: OptionRight;
  spot: number;
  strike: number;
  nearYears: number;
  farYears: number;
  nearIv: number;
  farIv: number;
  rate: number;
  dividendYield: number;
}>;

const leg = (
  input: CalendarInput,
  years: number,
  volatility: number
): LegInput => ({
  right: input.right,
  spot: input.spot,
  strike: input.strike,
  years,
  volatility,
  rate: input.rate,
  dividendYield: input.dividendYield,
});

export type CalendarGreeks = Readonly<{
  price: number;
  delta: number;
  gamma: number;
  /** per calendar day */
  theta: number;
  /** per 1 volatility point on both legs */
  vega: number;
}>;

/** Net Black-Scholes price and Greeks per share: far leg (long) minus near leg (short). */
export const calendarGreeks = (input: CalendarInput): CalendarGreeks => {
  const far = priced(leg(input, input.farYears, input.farIv));
  const near = priced(leg(input, input.nearYears, input.nearIv));
  return {
    price: far.price - near.price,
    delta: far.delta - near.delta,
    gamma: far.gamma - near.gamma,
    theta: far.theta - near.theta,
    vega: far.vega - near.vega,
  };
};

/** Spread value per share at the near expiry: far leg at its implied volatility minus near intrinsic. */
export const valueAtNearExpiry = (input: CalendarInput, spot: number): number =>
  legValue(
    leg({ ...input, spot }, input.farYears - input.nearYears, input.farIv)
  ) - intrinsic(input.right, spot, input.strike);

export type PayoffSummary = Readonly<{
  peakSpot: number;
  maxValue: number;
  maxProfit: number;
  breakevens: readonly number[];
}>;

/** Payoff at the near expiry on a spot grid (0.2x to 3x strike), with peak and break-even prices. */
export const payoffAtNearExpiry = (
  input: CalendarInput,
  debit: number,
  steps = 2800
): PayoffSummary => {
  const low = input.strike * 0.2;
  const step = (input.strike * 3 - low) / steps;
  let peakSpot = low;
  let maxValue = Number.NEGATIVE_INFINITY;
  const breakevens: number[] = [];
  let previousSpot = low;
  let previousPnl = valueAtNearExpiry(input, low) - debit;
  for (let index = 0; index <= steps; index += 1) {
    const spot = low + step * index;
    const value = valueAtNearExpiry(input, spot);
    if (value > maxValue) {
      maxValue = value;
      peakSpot = spot;
    }
    const pnl = value - debit;
    if (index > 0 && Math.sign(pnl) !== Math.sign(previousPnl)) {
      breakevens.push(
        previousSpot +
          ((spot - previousSpot) * -previousPnl) / (pnl - previousPnl)
      );
    }
    previousSpot = spot;
    previousPnl = pnl;
  }
  return { peakSpot, maxValue, maxProfit: maxValue - debit, breakevens };
};

/** Strike whose call delta equals `target` (bisection; delta falls as the strike rises). */
export const strikeForCallDelta = (
  input: Omit<LegInput, "strike" | "right">,
  target: number
): number => {
  let low = input.spot * 0.05;
  let high = input.spot * 20;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    const { delta } = priced({ ...input, right: "call", strike: middle });
    if (delta > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
};

/** Cost per share for one leg on one side: commission plus slippage max(0.01, s x price). */
export const legCost = (price: number, slippage: number): number =>
  COMMISSION_PER_SHARE + Math.max(MIN_SLIPPAGE, slippage * price);

/** 30-day and 93-day implied volatility, interpolated linearly in total variance, flat outside. */
export const termStructureIv = (
  iv30: number,
  iv93: number,
  days: number
): number => {
  if (days <= 30) return iv30;
  if (days >= 93) return iv93;
  const variance =
    iv30 * iv30 * 30 +
    ((iv93 * iv93 * 93 - iv30 * iv30 * 30) * (days - 30)) / 63;
  return Math.sqrt(variance / days);
};

/** Annualized sd of daily log returns over the `window` returns ending at `end`. */
export const realizedVol = (
  closes: readonly number[],
  end: number,
  window: number
): number => {
  const returns: number[] = [];
  for (let index = end - window + 1; index <= end; index += 1)
    returns.push(Math.log(at(closes, index) / at(closes, index - 1)));
  const average = returns.reduce((sum, value) => sum + value, 0) / window;
  const variance =
    returns.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (window - 1);
  return Math.sqrt(variance * TRADING_DAYS);
};

export type Market = Readonly<{
  symbol: string;
  dates: readonly string[];
  spot: readonly number[];
  rate: readonly number[];
  dividendYield: number;
  slippage: number;
  ivSource: string;
  iv: (index: number, days: number) => number;
}>;

export type Config = Readonly<{
  id: "A" | "B" | "C";
  label: string;
  nearDays: number;
  /** null = at the money; else the near-leg call delta of the strike. */
  delta: number | null;
}>;

export const CONFIGS: readonly Config[] = [
  { id: "A", label: "30/60 days, at the money", nearDays: 30, delta: null },
  {
    id: "B",
    label: "100/200 days, at the money (reel)",
    nearDays: 100,
    delta: null,
  },
  {
    id: "C",
    label: "100/200 days, 0.30-delta strike (reel, bullish)",
    nearDays: 100,
    delta: 0.3,
  },
];

export type Cycle = Readonly<{
  entryDate: string;
  exitDate: string;
  reason: "target" | "expiry";
  strike: number;
  debit: number;
  ret: number;
  callRet: number;
  daysHeld: number;
}>;

export type Simulation = Readonly<{
  cycles: readonly Cycle[];
  skippedDays: number;
}>;

const dayNumber = (date: string): number =>
  Date.parse(`${date}T00:00:00Z`) / DAY_MS;

const netReturn = (
  entry: number,
  entryCost: number,
  exit: number,
  exitCost: number
): number => (exit - exitCost - entry - entryCost) / (entry + entryCost);

/** One spread at a time from `start` (index) to the end of the data; rules in the spec. */
export const simulate = (
  market: Market,
  config: Config,
  start: number
): Simulation => {
  const { dates, spot, rate, dividendYield, slippage } = market;
  const days = dates.map(dayNumber);
  const cycles: Cycle[] = [];
  let skippedDays = 0;
  let index = start;
  while (index < dates.length) {
    const today = at(days, index);
    const nearIndex = days.findIndex((day) => day >= today + config.nearDays);
    if (nearIndex < 0) break;
    const nearDay = at(days, nearIndex);
    const farDay = nearDay + config.nearDays;
    const nearIv = market.iv(index, nearDay - today);
    const farIv = market.iv(index, farDay - today);
    const base = {
      spot: at(spot, index),
      rate: at(rate, index),
      dividendYield,
      right: "call" as const,
    };
    const strike =
      config.delta === null
        ? base.spot
        : strikeForCallDelta(
            {
              ...base,
              years: (nearDay - today) / DAYS_PER_YEAR,
              volatility: nearIv,
            },
            config.delta
          );
    // Both legs at the close of day i; at the near expiry legValue returns the near leg's intrinsic value.
    const value = (i: number): { near: number; far: number } => {
      const day = at(days, i);
      const marketAt = {
        ...base,
        spot: at(spot, i),
        rate: at(rate, i),
        strike,
      };
      return {
        near: legValue({
          ...marketAt,
          years: (nearDay - day) / DAYS_PER_YEAR,
          volatility: market.iv(i, nearDay - day),
        }),
        far: legValue({
          ...marketAt,
          years: (farDay - day) / DAYS_PER_YEAR,
          volatility: market.iv(i, farDay - day),
        }),
      };
    };
    const entry = value(index);
    const debit = entry.far - entry.near;
    if (farIv > TERM_LIMIT * nearIv || debit <= 0) {
      skippedDays += 1;
      index += 1;
      continue;
    }
    let exitIndex = nearIndex;
    for (let step = index + 1; step < nearIndex; step += 1) {
      const mark = value(step);
      if (mark.far - mark.near >= PROFIT_MULTIPLE * debit) {
        exitIndex = step;
        break;
      }
    }
    const exit = value(exitIndex);
    cycles.push({
      entryDate: at(dates, index),
      exitDate: at(dates, exitIndex),
      reason: exitIndex === nearIndex ? "expiry" : "target",
      strike,
      debit,
      ret: netReturn(
        debit,
        legCost(entry.near, slippage) + legCost(entry.far, slippage),
        exit.far - exit.near,
        legCost(exit.near, slippage) + legCost(exit.far, slippage)
      ),
      callRet: netReturn(
        entry.near,
        legCost(entry.near, slippage),
        exit.near,
        legCost(exit.near, slippage)
      ),
      daysHeld: at(days, exitIndex) - today,
    });
    index = exitIndex + 1;
  }
  return { cycles, skippedDays };
};

export type Stats = Readonly<{
  n: number;
  mean: number;
  sd: number;
  t: number;
  sharpe: number;
  winRate: number;
  worst: number;
  best: number;
}>;

export const stats = (values: readonly number[]): Stats => {
  const n = values.length;
  if (n === 0)
    return {
      n,
      mean: 0,
      sd: 0,
      t: 0,
      sharpe: 0,
      winRate: 0,
      worst: 0,
      best: 0,
    };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const sd =
    n > 1
      ? Math.sqrt(
          values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
        )
      : 0;
  return {
    n,
    mean,
    sd,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    sharpe: sd > 0 ? mean / sd : 0,
    winRate: values.filter((value) => value > 0).length / n,
    worst: Math.min(...values),
    best: Math.max(...values),
  };
};

export type PassCheck = Readonly<{
  calendar: Stats;
  call: Stats;
  firstHalf: Stats;
  secondHalf: Stats;
  enoughCycles: boolean;
  significant: boolean;
  bothHalves: boolean;
  beatsCall: boolean;
  pass: boolean;
}>;

/** The four checks of the pre-set pass rule for one config on one underlying. */
export const passRule = (cycles: readonly Cycle[]): PassCheck => {
  const returns = cycles.map((cycle) => cycle.ret);
  const half = Math.floor(returns.length / 2);
  const calendar = stats(returns);
  const call = stats(cycles.map((cycle) => cycle.callRet));
  const firstHalf = stats(returns.slice(0, half));
  const secondHalf = stats(returns.slice(half));
  const enoughCycles = calendar.n >= MIN_CYCLES;
  const significant = calendar.mean > 0 && calendar.t >= MIN_T_STAT;
  const bothHalves = firstHalf.mean > 0 && secondHalf.mean > 0;
  const beatsCall = calendar.sharpe > call.sharpe;
  return {
    calendar,
    call,
    firstHalf,
    secondHalf,
    enoughCycles,
    significant,
    bothHalves,
    beatsCall,
    pass: enoughCycles && significant && bothHalves && beatsCall,
  };
};

/** Strategy verdict: one config passes on at least 3 of 4 underlyings, including SPY or QQQ. */
export const strategyVerdict = (
  passes: ReadonlyMap<string, readonly string[]>
): { pass: boolean; configs: readonly string[] } => {
  const configs = [...passes.entries()]
    .filter(
      ([, symbols]) =>
        symbols.length >= 3 &&
        symbols.some((symbol) => symbol === "SPY" || symbol === "QQQ")
    )
    .map(([config]) => config);
  return { pass: configs.length > 0, configs };
};

/** CSV `date,close` into a date-to-close map; the header and blank lines are skipped. */
export const parseCloses = (text: string): Map<string, number> => {
  const closes = new Map<string, number>();
  for (const line of text.split("\n").slice(1)) {
    const [date, close] = line.trim().split(",");
    if (!date || close === undefined) continue;
    const value = Number(close);
    if (!Number.isFinite(value)) throw new Error(`bad close on ${date}`);
    closes.set(date, value);
  }
  return closes;
};

/** Values of `series` on `dates`, carrying the last known value forward; throws before the first value. */
export const alignForward = (
  dates: readonly string[],
  series: ReadonlyMap<string, number>,
  name: string
): number[] => {
  const known = [...series.keys()].sort();
  const out: number[] = [];
  let cursor = 0;
  let last: number | undefined;
  for (const date of dates) {
    while (cursor < known.length && at(known, cursor) <= date) {
      last = series.get(at(known, cursor));
      cursor += 1;
    }
    if (last === undefined)
      throw new Error(`${name} has no value on or before ${date}`);
    out.push(last);
  }
  return out;
};

export type Underlying = Readonly<{
  symbol: string;
  dividendYield: number;
  slippage: number;
  ivSource: "VIX+VIX3M" | "VXN" | "RV60";
}>;

export const UNDERLYINGS: readonly Underlying[] = [
  {
    symbol: "SPY",
    dividendYield: 0.015,
    slippage: 0.01,
    ivSource: "VIX+VIX3M",
  },
  { symbol: "QQQ", dividendYield: 0.007, slippage: 0.01, ivSource: "VXN" },
  { symbol: "TQQQ", dividendYield: 0, slippage: 0.03, ivSource: "RV60" },
  { symbol: "SOXL", dividendYield: 0, slippage: 0.03, ivSource: "RV60" },
];

/** Market for one underlying from the fetched CSV texts (name -> text). Index 0 = first study day. */
export const buildMarket = (
  underlying: Underlying,
  csv: ReadonlyMap<string, string>,
  start = STUDY_START
): Market => {
  const read = (name: string): Map<string, number> => {
    const text = csv.get(name);
    if (text === undefined) throw new Error(`missing ${name}.csv`);
    return parseCloses(text);
  };
  const closes = read(underlying.symbol);
  const allDates = [...closes.keys()].sort();
  const offset = allDates.findIndex((date) => date >= start);
  if (offset < RV_WINDOW)
    throw new Error(
      `${underlying.symbol} needs ${RV_WINDOW} closes before ${start}`
    );
  const allSpot = allDates.map((date) => closes.get(date) ?? 0);
  const dates = allDates.slice(offset);
  const rate = alignForward(dates, read("IRX"), "IRX").map(
    (value) => value / 100
  );
  let iv: (index: number, days: number) => number;
  if (underlying.ivSource === "VIX+VIX3M") {
    const iv30 = alignForward(dates, read("VIX"), "VIX");
    const iv93 = alignForward(dates, read("VIX3M"), "VIX3M");
    iv = (index, days) =>
      termStructureIv(at(iv30, index) / 100, at(iv93, index) / 100, days);
  } else if (underlying.ivSource === "VXN") {
    const flat = alignForward(dates, read("VXN"), "VXN");
    iv = (index) => at(flat, index) / 100;
  } else {
    const rv = dates.map((_, index) =>
      Math.max(RV_FLOOR, realizedVol(allSpot, index + offset, RV_WINDOW))
    );
    iv = (index) => at(rv, index);
  }
  return {
    symbol: underlying.symbol,
    dates,
    spot: allSpot.slice(offset),
    rate,
    dividendYield: underlying.dividendYield,
    slippage: underlying.slippage,
    ivSource: underlying.ivSource,
    iv,
  };
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number): string => value.toFixed(2);
const yesNo = (ok: boolean): string => (ok ? "yes" : "no");

export type StudyRow = Readonly<{
  config: Config;
  market: Market;
  simulation: Simulation;
  check: PassCheck;
}>;

export const runStudy = (markets: readonly Market[]): StudyRow[] =>
  CONFIGS.flatMap((config) =>
    markets.map((market) => {
      const simulation = simulate(market, config, 0);
      return { config, market, simulation, check: passRule(simulation.cycles) };
    })
  );

/** Markdown report of the study, with the verdict under the pre-set rule. */
export const renderResults = (
  rows: readonly StudyRow[],
  runDate: string
): string => {
  const passes = new Map<string, string[]>();
  for (const row of rows) {
    const list = passes.get(row.config.id) ?? [];
    if (row.check.pass) list.push(row.market.symbol);
    passes.set(row.config.id, list);
  }
  const verdict = strategyVerdict(passes);
  const first = rows[0];
  const window = first
    ? `${at(first.market.dates, 0)} to ${at(first.market.dates, first.market.dates.length - 1)}`
    : "no data";
  const lines = [
    "# Long calendar spread: modeled backtest results",
    "",
    `Generated by \`bun run research:calendar-spread -- backtest\` on ${runDate}. Spec and pass rule (fixed before this run): \`docs/specs/strategies/long-calendar-spread.md\`.`,
    "",
    `MODELED: Black-Scholes prices from implied-volatility proxies, not option quotes. Window ${window}. Returns are per cycle on the debit, after costs.`,
    "",
    `## Verdict: ${verdict.pass ? `PASS (configs ${verdict.configs.join(", ")})` : "FAIL"}`,
    "",
    "Rule: a config passes on an underlying when it has at least 30 cycles, a mean above 0 with t >= 2, a mean above 0 in both halves and a higher per-cycle Sharpe than the naked call (B9). The strategy passes when one config passes on at least 3 of 4 underlyings, including SPY or QQQ.",
    "",
    "|Config|Underlying|IV proxy|Cycles|Mean|t|Win rate|Worst|Best|Halves (1st / 2nd)|Sharpe calendar / call|At target|Avg days|Skipped days|>=30|t>=2|Halves|Beats call|Pass|",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const { config, market, simulation, check } of rows) {
    const { calendar } = check;
    const targets = simulation.cycles.filter(
      (cycle) => cycle.reason === "target"
    ).length;
    const held =
      simulation.cycles.reduce((sum, cycle) => sum + cycle.daysHeld, 0) /
      Math.max(1, simulation.cycles.length);
    lines.push(
      `|${config.id}: ${config.label}|${market.symbol}|${market.ivSource}|${calendar.n}|${pct(calendar.mean)}|${num(calendar.t)}|${pct(calendar.winRate)}|${pct(calendar.worst)}|${pct(calendar.best)}|${pct(check.firstHalf.mean)} / ${pct(check.secondHalf.mean)}|${num(calendar.sharpe)} / ${num(check.call.sharpe)}|${targets}|${held.toFixed(0)}|${simulation.skippedDays}|${yesNo(check.enoughCycles)}|${yesNo(check.significant)}|${yesNo(check.bothHalves)}|${yesNo(check.beatsCall)}|**${check.pass ? "PASS" : "fail"}**|`
    );
  }
  lines.push("");
  return lines.join("\n");
};

export type PlayInput = Readonly<{
  asof: string;
  spot: number;
  strike: number;
  near: string;
  far: string;
  nearIv: number;
  farIv: number;
  rate: number;
  dividendYield: number;
  debit: number;
  right: OptionRight;
}>;

/** Text summary of one concrete calendar: Greeks, peak, break-evens at the near expiry. */
export const describePlay = (play: PlayInput): string => {
  const input: CalendarInput = {
    right: play.right,
    spot: play.spot,
    strike: play.strike,
    nearYears: (dayNumber(play.near) - dayNumber(play.asof)) / DAYS_PER_YEAR,
    farYears: (dayNumber(play.far) - dayNumber(play.asof)) / DAYS_PER_YEAR,
    nearIv: play.nearIv,
    farIv: play.farIv,
    rate: play.rate,
    dividendYield: play.dividendYield,
  };
  const greeks = calendarGreeks(input);
  const payoff = payoffAtNearExpiry(input, play.debit);
  const atSpot = valueAtNearExpiry(input, play.spot) - play.debit;
  const usd = (value: number): string => `USD ${(value * 100).toFixed(0)}`;
  return [
    `Calendar ${play.right} ${play.strike}: short ${play.near}, long ${play.far}, as of ${play.asof}, spot ${play.spot}`,
    `Model price ${usd(greeks.price)} per spread; debit used ${usd(play.debit)} = maximum loss`,
    `Greeks per spread: delta ${(greeks.delta * 100).toFixed(1)}, gamma ${(greeks.gamma * 100).toFixed(2)}, theta ${(greeks.theta * 100).toFixed(2)}/day, vega ${(greeks.vega * 100).toFixed(2)}/vol pt`,
    `At the near expiry (far IV unchanged): peak at spot ${payoff.peakSpot.toFixed(2)}, maximum profit ${usd(payoff.maxProfit)}; break-evens ${payoff.breakevens.map((value) => value.toFixed(2)).join(" and ")}`,
    `If spot is unchanged at the near expiry: P&L ${usd(atSpot)}`,
  ].join("\n");
};

export type CliIo = Readonly<{
  stdout: { write: (text: string) => unknown };
  stderr: { write: (text: string) => unknown };
  now: () => Date;
}>;

const option = (args: readonly string[], name: string): string => {
  const position = args.indexOf(`--${name}`);
  const value = position >= 0 ? args[position + 1] : undefined;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
};

const numberOption = (
  args: readonly string[],
  name: string,
  fallback?: number
): number => {
  if (fallback !== undefined && !args.includes(`--${name}`)) return fallback;
  const value = Number(option(args, name));
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
};

const USAGE =
  "usage: research:calendar-spread backtest --data DIR --out FILE | play --asof D --spot S --strike K --near D --far D --near-iv V --far-iv V --debit X [--rate R] [--dividend Q] [--right call|put]\n";

export const runCalendarSpreadCli = async (
  args: readonly string[],
  io: CliIo
): Promise<number> => {
  try {
    const [command, ...rest] = args;
    if (command === "backtest") {
      const data = option(rest, "data");
      const names = [
        "SPY",
        "QQQ",
        "TQQQ",
        "SOXL",
        "VIX",
        "VIX3M",
        "VXN",
        "IRX",
      ];
      const csv = new Map<string, string>();
      for (const name of names)
        csv.set(name, await readFile(join(data, `${name}.csv`), "utf8"));
      const markets = UNDERLYINGS.map((underlying) =>
        buildMarket(underlying, csv)
      );
      const report = renderResults(
        runStudy(markets),
        io.now().toISOString().slice(0, 10)
      );
      await writeFile(option(rest, "out"), report, "utf8");
      io.stdout.write(report);
      return 0;
    }
    if (command === "play") {
      const right = rest.includes("--right") ? option(rest, "right") : "call";
      if (right !== "call" && right !== "put")
        throw new Error("--right must be call or put");
      io.stdout.write(
        `${describePlay({
          asof: option(rest, "asof"),
          spot: numberOption(rest, "spot"),
          strike: numberOption(rest, "strike"),
          near: option(rest, "near"),
          far: option(rest, "far"),
          nearIv: numberOption(rest, "near-iv"),
          farIv: numberOption(rest, "far-iv"),
          rate: numberOption(rest, "rate", 0.04),
          dividendYield: numberOption(rest, "dividend", 0),
          debit: numberOption(rest, "debit"),
          right,
        })}\n`
      );
      return 0;
    }
    io.stderr.write(USAGE);
    return 2;
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
