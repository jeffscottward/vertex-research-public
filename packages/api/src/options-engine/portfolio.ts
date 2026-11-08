/**
 * Runs an options strategy DSL definition on daily data, ported from
 * services/research/strategies/qc_ports/portfolio.py (run_definition without the Nautilus re-run;
 * research only). Same legs, policies, selection, join rule, slicing at `end`, trade order and ids
 * and SPY ledger calendar.
 *
 * Each (leg, symbol) pair is one run leg: leg 0 is the definition's own entry, exit, filters and
 * options, then `portfolio.legs` in order; run legs go leg by leg, symbol by symbol. Signals come
 * from compileStrategy on the symbol's daily bars, or on its month-end total-return bars with
 * `frame: "monthly"` (the series align on the symbol's daily dates). Policies (a signal at bar i
 * trades at the close of bar i + 1):
 * - roll: an entry at each month-end where the leg enters (and, with `select`, the member is
 *   selected); every spread closes at the next month-end.
 * - flat: one open spread per run leg; candidates are the cadence bars where the leg enters; the
 *   exit is the first later bar where a DSL exit condition holds.
 * - window: one spread per run of entry bars (read `shift` bars ahead), opened on the first bar
 *   and closed after the last.
 * A member joins at its first daily bar with an IV index value; signals before that bar or before
 * the run start are ignored. The ledger marks equity on the SPY dates from the run start.
 */
import type { BarColumns } from "../instant-backtest-engine.ts";
import {
  compileStrategy,
  evaluateStrategyExpression,
  type StrategySeriesContext,
  type StrategySeriesInput,
} from "../strategy-dsl-compile.ts";
import {
  resolveStrategySeries,
  STRATEGY_IV_INDEX,
  type StrategyDefinition,
  type StrategyExpr,
  strategySeriesRefs,
} from "../strategy-dsl.ts";
import {
  type Market,
  marketPricer,
  type OptionsSpec,
  type PricedTrade,
  parseOptions,
  type SignalEvent,
  validateMarket,
} from "./book.ts";
import { parseDay } from "./calendar.ts";
import { DEFAULT_CAPITAL, type LedgerResult, runLedger } from "./ledger.ts";
import { pySum } from "./libm.ts";
import { type RunStats, summarize } from "./metrics.ts";

const CALENDAR_SYMBOL = "SPY";
const DAY_MS = 86_400_000;
/** data.MAX_FILL_DAYS: an IV index or rate value carries for at most 5 bars. */
const MAX_FILL_DAYS = 5;
const ETF_SYMBOLS: ReadonlySet<string> = new Set([
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "GLD",
  "SLV",
  "USO",
]);
const BAR_COLUMNS = ["open", "high", "low", "adjClose"] as const;

type Column = readonly (number | null)[];

/** Series-store rows: series id -> dates and columns (open, high, low and adjClose for the ETF ids). */
export type OptionsDatasetRows = Readonly<
  Record<
    string,
    {
      dates: readonly string[];
      close: Column;
      open?: Column;
      high?: Column;
      low?: Column;
      adjClose?: Column;
    }
  >
>;

/** Daily bars of one ETF in date order (data.Bars); `close` is the traded (unadjusted) close. */
export interface OptionsBars {
  readonly symbol: string;
  readonly dates: readonly string[];
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly adjClose: readonly number[];
}

/**
 * Daily data a run reads (portfolio.Dataset): `bars` per ETF (data.load_bars rules), `series` the
 * DSL series context (every id's finite closes plus `<ETF>:TR`, the ETF's adjusted closes), and
 * `calendar` the SPY bar dates.
 */
export interface OptionsDataset {
  readonly bars: Readonly<Record<string, OptionsBars>>;
  readonly series: StrategySeriesContext;
  readonly calendar: readonly string[];
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const rowsView = (
  rows: OptionsDatasetRows
): {
  bars: Record<string, OptionsBars>;
  series: Record<string, Record<string, number>>;
} => {
  const series: Record<string, Record<string, number>> = {};
  const bars: Record<string, OptionsBars> = {};
  for (const [seriesId, row] of Object.entries(rows)) {
    const { dates } = row;
    const closes = row.close.map(finite);
    if (closes.length !== dates.length)
      throw new Error(`${seriesId}: close and dates differ in length`);
    const values: Record<string, number> = {};
    closes.forEach((close, index) => {
      if (close !== null) values[dates[index] as string] = close;
    });
    series[seriesId] = values;
    if (!ETF_SYMBOLS.has(seriesId)) continue;
    const columns = BAR_COLUMNS.map((key) => {
      const column = row[key];
      if (column === undefined || column.length < dates.length)
        throw new Error(`${seriesId}: ${key} misses dates`);
      return column.map(finite);
    });
    const kept = closes.flatMap((close, index) =>
      close !== null &&
      close > 0 &&
      columns.every((column) => column[index] !== null)
        ? [index]
        : []
    );
    const pick = (column: Column) =>
      kept.map((index) => column[index] as number);
    const bar: OptionsBars = {
      symbol: seriesId,
      dates: kept.map((index) => dates[index] as string),
      open: pick(columns[0] as Column),
      high: pick(columns[1] as Column),
      low: pick(columns[2] as Column),
      close: pick(closes),
      adjClose: pick(columns[3] as Column),
    };
    if (
      bar.dates.some(
        (day, index) => index > 0 && day <= (bar.dates[index - 1] as string)
      )
    )
      throw new Error(`${seriesId}: dates must be strictly increasing`);
    bars[seriesId] = bar;
  }
  return { bars, series };
};

const withTotalReturn = (
  bars: Readonly<Record<string, OptionsBars>>,
  series: Readonly<Record<string, Readonly<Record<string, number>>>>
): Record<string, Readonly<Record<string, number>>> => {
  const context: Record<string, Readonly<Record<string, number>>> = {
    ...series,
  };
  for (const [symbol, bar] of Object.entries(bars))
    context[`${symbol}:TR`] = Object.fromEntries(
      bar.dates.map((day, index) => [day, bar.adjClose[index] as number])
    );
  return context;
};

/** The DSL series context of store rows (portfolio.context_from_rows): closes plus `<ETF>:TR`. */
export const optionsContextFromRows = (
  rows: OptionsDatasetRows
): StrategySeriesContext => {
  const { bars, series } = rowsView(rows);
  return withTotalReturn(bars, series);
};

/** The run data of store rows (portfolio.dataset_from_rows); SPY bars give the market calendar. */
export const optionsDatasetFromRows = (
  rows: OptionsDatasetRows
): OptionsDataset => {
  const { bars, series } = rowsView(rows);
  const spy = bars[CALENDAR_SYMBOL];
  if (spy === undefined)
    throw new Error(`The market calendar needs ${CALENDAR_SYMBOL} bars`);
  return { bars, series: withTotalReturn(bars, series), calendar: spy.dates };
};

/** Every bar and series value dated on or before `end` (no limit when undefined). */
const sliceDataset = (
  data: OptionsDataset,
  end: string | undefined
): OptionsDataset => {
  if (end === undefined) return data;
  const bars: Record<string, OptionsBars> = {};
  for (const [symbol, bar] of Object.entries(data.bars)) {
    let size = 0;
    while (size < bar.dates.length && (bar.dates[size] as string) <= end)
      size += 1;
    bars[symbol] = {
      symbol,
      dates: bar.dates.slice(0, size),
      open: bar.open.slice(0, size),
      high: bar.high.slice(0, size),
      low: bar.low.slice(0, size),
      close: bar.close.slice(0, size),
      adjClose: bar.adjClose.slice(0, size),
    };
  }
  const series = Object.fromEntries(
    Object.entries(data.series).map(([seriesId, values]) => [
      seriesId,
      Object.fromEntries(Object.entries(values).filter(([day]) => day <= end)),
    ])
  );
  return {
    bars,
    series,
    calendar: (bars[CALENDAR_SYMBOL] as OptionsBars).dates,
  };
};

/** data.align: the series on each date, carrying the last value for at most `maxFill` later dates. */
export const alignSeries = (
  series: Readonly<Record<string, number>>,
  dates: readonly string[],
  maxFill: number
): (number | null)[] => {
  const keys = Object.keys(series).sort();
  const out: (number | null)[] = [];
  let cursor = 0;
  let last: number | null = null;
  let age = 0;
  for (const day of dates) {
    let fresh = false;
    while (cursor < keys.length && (keys[cursor] as string) <= day) {
      last = series[keys[cursor] as string] as number;
      fresh = true;
      cursor += 1;
    }
    if (fresh) age = 0;
    else if (last !== null) age += 1;
    out.push(last !== null && age <= maxFill ? last : null);
  }
  return out;
};

const seriesOf = (
  data: OptionsDataset,
  seriesId: string
): Readonly<Record<string, number>> => {
  const values = data.series[seriesId];
  if (values === undefined)
    throw new Error(`Series data is not available for ${seriesId}`);
  return values;
};

const barsOf = (data: OptionsDataset, symbol: string): OptionsBars => {
  const bar = data.bars[symbol];
  if (bar === undefined) throw new Error(`No bars for ${symbol}`);
  return bar;
};

/** The options book's view of one symbol (portfolio.market_of): IV index and IRX aligned to its bars. */
export const marketOf = (data: OptionsDataset, symbol: string): Market => {
  const indexId = STRATEGY_IV_INDEX[symbol];
  if (indexId === undefined) throw new Error(`No IV index for ${symbol}`);
  const bar = barsOf(data, symbol);
  const market: Market = {
    symbol,
    dates: bar.dates,
    close: bar.close,
    ivIndex: alignSeries(seriesOf(data, indexId), bar.dates, MAX_FILL_DAYS),
    rate: alignSeries(seriesOf(data, "IRX"), bar.dates, MAX_FILL_DAYS).map(
      (value) => (value === null ? null : value / 100)
    ),
  };
  validateMarket(market);
  return market;
};

/** Daily bars for compileStrategy: t = UTC midnight of each date in epoch ms. */
const dslBars = (
  dates: readonly string[],
  open: readonly number[],
  high: readonly number[],
  low: readonly number[],
  close: readonly number[]
): BarColumns => ({
  t: Float64Array.from(dates, (day) => parseDay(day) * DAY_MS),
  o: Float64Array.from(open),
  h: Float64Array.from(high),
  l: Float64Array.from(low),
  c: Float64Array.from(close),
});

/** Indices of the last date of each month; the month of the last date is not complete and is left out. */
export const monthEndIndices = (dates: readonly string[]): number[] => {
  const out: number[] = [];
  for (let index = 0; index < dates.length - 1; index++)
    if (
      (dates[index] as string).slice(0, 7) !==
      (dates[index + 1] as string).slice(0, 7)
    )
      out.push(index);
  return out;
};

/** [first, last] index of every run of true. */
export const windowSpans = (mask: readonly boolean[]): [number, number][] => {
  const spans: [number, number][] = [];
  let start: number | null = null;
  mask.forEach((value, index) => {
    if (value && start === null) start = index;
    else if (!value && start !== null) {
      spans.push([start, index - 1]);
      start = null;
    }
  });
  if (start !== null) spans.push([start, mask.length - 1]);
  return spans;
};

type Policy = "roll" | "flat" | "window";

/** One (leg, symbol) pair of a run; `definition` is a plain definition (no portfolio) shared by the leg's members. */
interface RunLeg {
  readonly order: number;
  readonly part: number;
  readonly symbol: string;
  readonly definition: StrategyDefinition;
  readonly spec: OptionsSpec;
  readonly policy: Policy;
  readonly cadence: "daily" | "monthEnd" | undefined;
  readonly frame: "daily" | "monthly";
  readonly shift: number;
}

type Portfolio = NonNullable<StrategyDefinition["portfolio"]>;

const portfolioOf = (
  definition: StrategyDefinition,
  symbol: string | undefined
): Portfolio => {
  if (definition.portfolio !== undefined) return definition.portfolio;
  if (symbol === undefined)
    throw new Error(
      "A definition without a portfolio block needs the run symbol"
    );
  return {
    symbols: [symbol as Portfolio["symbols"][number]],
    policy: "flat",
    cadence: "daily",
  };
};

/** The run legs of an options definition, leg by leg, symbol by symbol (portfolio.run_legs). */
const runLegs = (
  definition: StrategyDefinition,
  symbol: string | undefined
): RunLeg[] => {
  if (definition.options === undefined)
    throw new Error("The options runner needs an options block");
  const block = portfolioOf(definition, symbol);
  const parts = [
    {
      entry: definition.entry,
      exit: definition.exit,
      filters: definition.filters,
      options: definition.options,
    },
    ...(block.legs ?? []),
  ];
  const legs: RunLeg[] = [];
  parts.forEach((part, index) => {
    const legDefinition: StrategyDefinition = {
      name: definition.name,
      version: definition.version,
      entry: part.entry,
      exit: part.exit ?? { any: [] },
      ...(part.filters === undefined ? {} : { filters: part.filters }),
      options: part.options,
      sizing: { mode: "allIn" },
      stopLoss: { kind: "none" },
      takeProfit: { kind: "none" },
    };
    const spec = parseOptions(
      part.options as Readonly<Record<string, unknown>>
    );
    for (const member of block.symbols)
      legs.push({
        order: legs.length,
        part: index,
        symbol: member,
        definition: legDefinition,
        spec,
        policy: block.policy,
        cadence: block.cadence,
        frame: block.frame ?? "daily",
        shift: block.shift ?? 0,
      });
  });
  return legs;
};

/** The bars the leg compiles on, the series input, and the daily index of each frame bar (null = daily). */
const legFrame = (
  leg: RunLeg,
  data: OptionsDataset
): { bars: BarColumns; input: StrategySeriesInput; ends: number[] | null } => {
  const bar = barsOf(data, leg.symbol);
  if (leg.frame === "daily")
    return {
      bars: dslBars(bar.dates, bar.open, bar.high, bar.low, bar.close),
      input: { context: data.series, symbol: leg.symbol },
      ends: null,
    };
  const ends = monthEndIndices(bar.dates);
  const closes = ends.map((index) => bar.adjClose[index] as number);
  return {
    bars: dslBars(
      ends.map((index) => bar.dates[index] as string),
      closes,
      closes,
      closes,
      closes
    ),
    input: { context: data.series, symbol: leg.symbol, calendar: bar.dates },
    ends,
  };
};

const toDaily = <T>(
  values: ArrayLike<T>,
  ends: number[] | null,
  size: number,
  empty: T
): T[] => {
  if (ends === null) return Array.from(values);
  const out = new Array<T>(size).fill(empty);
  ends.forEach((index, position) => {
    out[index] = values[position] as T;
  });
  return out;
};

/** Entry and exit flags per daily bar of the leg's symbol (monthly frames map to their month-end bars). */
const legSignals = (
  leg: RunLeg,
  data: OptionsDataset
): { entries: boolean[]; exits: boolean[] } => {
  const { bars, input, ends } = legFrame(leg, data);
  const size = barsOf(data, leg.symbol).dates.length;
  const compiled = compileStrategy(bars, leg.definition, undefined, input);
  return {
    entries: toDaily(
      Array.from(compiled.signals, (value) => value === 1),
      ends,
      size,
      false
    ),
    exits: toDaily(
      Array.from(compiled.exits, (value) => value === 1),
      ends,
      size,
      false
    ),
  };
};

/** An expression per daily bar of the leg's symbol (NaN where not available or off the frame). */
const legValues = (
  leg: RunLeg,
  data: OptionsDataset,
  expr: StrategyExpr
): number[] => {
  const { bars, input, ends } = legFrame(leg, data);
  return toDaily(
    evaluateStrategyExpression(bars, expr, input),
    ends,
    barsOf(data, leg.symbol).dates.length,
    Number.NaN
  );
};

/** First bar with an IV index value (the bar count when there is none). */
const joinIndex = (market: Market): number => {
  const index = market.ivIndex.findIndex((value) => value !== null);
  return index < 0 ? market.dates.length : index;
};

/** For each index, the first later index where flags is true. */
const nextTrue = (flags: readonly boolean[]): (number | null)[] => {
  const out = new Array<number | null>(flags.length).fill(null);
  let following: number | null = null;
  for (let index = flags.length - 1; index >= 0; index--) {
    out[index] = following;
    if (flags[index]) following = index;
  }
  return out;
};

interface LegTrades {
  readonly trades: PricedTrade[];
  readonly skipped: number;
  readonly count: number;
}

/** Prices candidates in order, taking one only when the last spread has closed by its signal bar. */
const sequential = (
  candidates: readonly (readonly [number, number | null])[],
  leg: RunLeg,
  market: Market
): { trades: PricedTrade[]; skipped: number } => {
  const price = marketPricer(leg.spec, market);
  const trades: PricedTrade[] = [];
  let skipped = 0;
  let busy = -1;
  for (const [entry, exit] of candidates) {
    if (entry < busy) continue;
    const priced = price(
      { symbol: leg.symbol, entryIndex: entry, exitIndex: exit },
      1
    );
    if (typeof priced === "string") skipped += 1;
    else {
      trades.push(priced);
      busy = priced.exitIndex;
    }
  }
  return { trades, skipped };
};

/**
 * Per run leg order: the month-end dates where the member is selected. On each month-end date,
 * among the members of the same leg whose entry holds and whose score (and tie-break, when given)
 * is available: highest score first, then highest tie-break, then the portfolio symbol order; the
 * first `top` are selected.
 */
const selection = (
  legs: readonly RunLeg[],
  data: OptionsDataset,
  select: NonNullable<Portfolio["select"]>,
  entries: ReadonlyMap<number, readonly boolean[]>
): Map<number, Set<string>> => {
  const chosen = new Map(legs.map((leg) => [leg.order, new Set<string>()]));
  const groups = new Map<number, RunLeg[]>();
  for (const leg of legs)
    groups.set(leg.part, [...(groups.get(leg.part) ?? []), leg]);
  for (const members of groups.values()) {
    const ranked = new Map<
      string,
      { key: readonly [number, number, number]; order: number }[]
    >();
    members.forEach((leg, rank) => {
      const { dates } = barsOf(data, leg.symbol);
      const scores = legValues(leg, data, select.score);
      const ties =
        select.tieBreak === undefined
          ? null
          : legValues(leg, data, select.tieBreak);
      for (const index of monthEndIndices(dates)) {
        const score = scores[index] as number;
        const tie = ties === null ? 0 : (ties[index] as number);
        if (
          !(entries.get(leg.order) as readonly boolean[])[index] ||
          Number.isNaN(score) ||
          Number.isNaN(tie)
        )
          continue;
        const day = dates[index] as string;
        ranked.set(day, [
          ...(ranked.get(day) ?? []),
          { key: [-score, -tie, rank], order: leg.order },
        ]);
      }
    });
    for (const [day, items] of ranked) {
      const sorted = [...items].sort(
        (a, b) =>
          a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]
      );
      for (const { order } of sorted.slice(0, select.top))
        (chosen.get(order) as Set<string>).add(day);
    }
  }
  return chosen;
};

/** Priced trades, book skips and entry signals of one run leg. */
const legTrades = (
  leg: RunLeg,
  data: OptionsDataset,
  start: string,
  entries: readonly boolean[],
  exits: readonly boolean[],
  selected: ReadonlySet<string> | undefined
): LegTrades => {
  const market = marketOf(data, leg.symbol);
  const { dates } = market;
  const join = joinIndex(market);
  const live = (index: number) =>
    index >= join && (dates[index] as string) >= start;
  if (leg.policy === "roll") {
    const ends = monthEndIndices(dates);
    const events: SignalEvent[] = [];
    ends.forEach((index, position) => {
      if (
        entries[index] &&
        live(index) &&
        (selected === undefined || selected.has(dates[index] as string))
      )
        events.push({
          symbol: leg.symbol,
          entryIndex: index,
          exitIndex: ends[position + 1] ?? null,
        });
    });
    const price = marketPricer(leg.spec, market);
    const trades: PricedTrade[] = [];
    for (const event of events) {
      const priced = price(event, trades.length + 1);
      if (typeof priced !== "string") trades.push(priced);
    }
    return {
      trades,
      skipped: events.length - trades.length,
      count: events.length,
    };
  }
  if (leg.policy === "flat") {
    const bars =
      leg.cadence === "monthEnd"
        ? monthEndIndices(dates)
        : Array.from({ length: dates.length - 1 }, (_, index) => index);
    const following = leg.definition.exit.any.length > 0 ? nextTrue(exits) : [];
    const candidates = bars
      .filter((index) => entries[index] && live(index))
      .map((index) => [index, following[index] ?? null] as const);
    const { trades, skipped } = sequential(candidates, leg, market);
    return { trades, skipped, count: trades.length + skipped };
  }
  const mask = [
    ...entries.slice(leg.shift),
    ...new Array<boolean>(leg.shift).fill(false),
  ];
  const last = dates.length - 1;
  const candidates = windowSpans(mask).filter(
    ([first, end]) => first > 0 && live(first) && end + 1 <= last && end > first
  );
  const { trades, skipped } = sequential(candidates, leg, market);
  return { trades, skipped, count: candidates.length };
};

export interface OptionsRunOutcome {
  readonly result: LedgerResult;
  readonly priced: readonly PricedTrade[];
  readonly bookSkipped: number;
  readonly signals: Record<string, number>;
}

export interface OptionsRunOptions {
  /** First run day (YYYY-MM-DD): signals before it are ignored, the ledger starts there. */
  readonly start: string;
  /** Last data day included (inclusive; default: every bar). */
  readonly end?: string;
  readonly capital?: number;
  /** The run symbol of a definition without a portfolio block. */
  readonly symbol?: string;
}

/**
 * Runs an options definition (a parsed StrategyDefinition with an options block) from `start` to
 * `end` (portfolio.run_definition without the Nautilus re-run).
 */
export const runOptionsDefinition = (
  definition: StrategyDefinition,
  data: OptionsDataset,
  options: OptionsRunOptions
): OptionsRunOutcome => {
  const { start } = options;
  const sliced = sliceDataset(data, options.end);
  const legs = runLegs(definition, options.symbol);
  const flags = new Map(
    legs.map((leg) => [leg.order, legSignals(leg, sliced)])
  );
  const select = portfolioOf(definition, options.symbol).select;
  const selected =
    select === undefined
      ? undefined
      : selection(
          legs,
          sliced,
          select,
          new Map([...flags].map(([order, pair]) => [order, pair.entries]))
        );
  const collected: { entryDate: string; order: number; trade: PricedTrade }[] =
    [];
  let bookSkipped = 0;
  const signals: Record<string, number> = {};
  for (const leg of legs) {
    const { entries, exits } = flags.get(leg.order) as {
      entries: boolean[];
      exits: boolean[];
    };
    const { trades, skipped, count } = legTrades(
      leg,
      sliced,
      start,
      entries,
      exits,
      selected?.get(leg.order)
    );
    for (const trade of trades)
      collected.push({ entryDate: trade.entryDate, order: leg.order, trade });
    bookSkipped += skipped;
    signals[leg.symbol] = (signals[leg.symbol] ?? 0) + count;
  }
  // Python sorts by (entry date, leg order, entry index); one run leg never enters twice on a date.
  collected.sort(
    (a, b) =>
      Number(a.entryDate > b.entryDate) - Number(a.entryDate < b.entryDate) ||
      a.order - b.order
  );
  const priced = collected.map(({ trade }, index) => ({
    ...trade,
    tradeId: index + 1,
  }));
  const dates = sliced.calendar.filter((day) => day >= start);
  return {
    result: runLedger(priced, options.capital ?? DEFAULT_CAPITAL, dates),
    priced,
    bookSkipped,
    signals,
  };
};

/**
 * Largest share of equity at risk in open spreads at a day's close: sum of contracts * max loss per
 * contract of the trades open after that day's exits and entries, over that day's equity.
 */
export const maxOpenRisk = (
  result: LedgerResult,
  priced: readonly PricedTrade[]
): number => {
  const maxLoss = new Map(
    priced.map((trade) => [trade.tradeId, trade.maxLoss])
  );
  const spans = result.trades.map(
    (record) =>
      [
        record.entryDate,
        record.exitDate,
        record.contracts * (maxLoss.get(record.id) as number),
      ] as const
  );
  let worst = 0;
  result.dates.forEach((day, index) => {
    const equity = result.equity[index] as number;
    const risk = pySum(
      spans
        .filter(([entry, exit]) => entry <= day && day < exit)
        .map(([, , amount]) => amount)
    );
    if (risk !== 0 && equity > 0) worst = Math.max(worst, risk / equity);
  });
  return worst;
};

export interface OptionsRunMetrics extends RunStats {
  readonly maxOpenRisk: number;
  readonly staleIvExits: number;
}

/** summarize plus the book skips, the largest open risk and the stale-IV exits (portfolio.run_metrics). */
export const optionsRunMetrics = (
  outcome: OptionsRunOutcome,
  nTrials = 1,
  sharpeVariance?: number
): OptionsRunMetrics => {
  const stats = summarize(outcome.result, nTrials, sharpeVariance ?? null);
  return {
    ...stats,
    skipped: stats.skipped + outcome.bookSkipped,
    maxOpenRisk: maxOpenRisk(outcome.result, outcome.priced),
    staleIvExits: outcome.result.trades.filter(
      (trade) => trade.exitReason === "stale-iv"
    ).length,
  };
};

/**
 * Every series id a run of `definition` reads: per symbol its ETF row, its IV index, IRX and SPY,
 * then every series ref of the definition resolved per symbol (`<ETF>:TR` is built from the ETF row).
 */
export const optionsDefinitionSeriesIds = (
  definition: StrategyDefinition,
  symbol?: string
): string[] => {
  const symbols = portfolioOf(definition, symbol).symbols;
  const ids: string[] = [];
  for (const member of symbols) {
    const indexId = STRATEGY_IV_INDEX[member];
    ids.push(
      member,
      ...(indexId === undefined ? [] : [indexId]),
      "IRX",
      CALENDAR_SYMBOL
    );
  }
  const refs = strategySeriesRefs(definition);
  for (const member of symbols)
    for (const ref of refs) {
      const id = resolveStrategySeries(ref, member);
      if (id !== undefined) ids.push(id.endsWith(":TR") ? id.slice(0, -3) : id);
    }
  return [...new Set(ids)];
};
