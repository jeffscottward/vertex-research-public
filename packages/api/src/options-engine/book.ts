/**
 * Turns entry/exit signals into priced defined-risk vertical spreads, ported from
 * services/research/strategies/qc_ports/book.py with the same rules, order of operations and
 * messages (research only; see that file for the full rules).
 *
 * - An entry or exit signal at the close of bar i trades at the close of bar i + 1. Expiry,
 *   stale-iv, exitDte, profit-take, signal and end of data are checked in that order at each
 *   close after the entry close.
 * - Expiry: the monthly expiration whose calendar DTE is nearest dte.target among DTE >= dte.min.
 * - Strikes on the grid: the anchor leg at the |delta| nearest the target (debit: longDelta,
 *   credit: shortDelta), the other leg `width` further out of the money.
 * - Instrument value per contract, rounded to cents: debit = spread value * 100, credit =
 *   (width - spread value) * 100. Costs per contract and side rounded to cents; a closing cost
 *   is capped at the worst-case exit cost; expiry settles without costs.
 */
import {
  expirationsAfter,
  formatDay,
  parseDay,
  TradingCalendar,
} from "./calendar.ts";
import { pyRound, roundHalfEven } from "./libm.ts";
import {
  atmIv,
  bsDelta,
  bsPrice,
  DIVIDEND_YIELD,
  legCost,
  MULTIPLIER,
  type Right,
  SKEW,
  smileIv,
  strikeStep,
} from "./pricing.ts";

export type Structure =
  | "callDebitVertical"
  | "putDebitVertical"
  | "putCreditVertical"
  | "callCreditVertical";
type Kind = "debit" | "credit";
export type ExitReason =
  | "expiry"
  | "stale-iv"
  | "exitDte"
  | "profitTake"
  | "signal"
  | "end";

export const STRUCTURES: Readonly<Record<Structure, readonly [Right, Kind]>> = {
  callDebitVertical: ["call", "debit"],
  putDebitVertical: ["put", "debit"],
  putCreditVertical: ["put", "credit"],
  callCreditVertical: ["call", "credit"],
};
/** IV index per traded symbol (data.IV_INDEX). */
export const IV_INDEX: ReadonlyMap<string, string> = new Map([
  ["SPY", "VIX"],
  ["QQQ", "VXN"],
  ["DIA", "VXD"],
  ["IWM", "RVX"],
  ["GLD", "GVZ"],
  ["SLV", "VXSLV"],
  ["USO", "OVX"],
]);
export const MAX_LOSS_PCT_CAP = 2;
const DEFAULT_LONG_DELTA = 0.5;
const DEFAULT_SHORT_DELTA = 0.25;
const EXPIRY_SCAN_MONTHS = 15;
const DAYS_PER_YEAR = 365;
/** Strike search range around the spot in ATM standard deviations, and its minimum in grid steps. */
const STRIKE_SEARCH_SIGMAS = 4;
const STRIKE_SEARCH_MIN_STEPS = 20;
const OPTION_KEYS = new Set([
  "structure",
  "dte",
  "longDelta",
  "shortDelta",
  "widthSigma",
  "profitTakePct",
  "exitDte",
  "maxLossPct",
]);

/** What the book needs for one traded symbol, aligned to its bar dates (data.Market). */
export interface Market {
  readonly symbol: string;
  readonly dates: readonly string[];
  readonly close: readonly number[];
  /** IV index level in percent; null where the source has no value within the carry. */
  readonly ivIndex: readonly (number | null)[];
  /** Annual risk-free rate as a fraction; null where missing. */
  readonly rate: readonly (number | null)[];
}

export interface SignalEvent {
  readonly symbol: string;
  readonly entryIndex: number;
  readonly exitIndex?: number | null;
}

/** One spread, per contract. Prices, fees and max loss are $ per contract; marks are [date, value]. */
export interface PricedTrade {
  readonly tradeId: number;
  readonly symbol: string;
  readonly structure: Structure;
  readonly expiry: string;
  readonly longStrike: number;
  readonly shortStrike: number;
  readonly width: number;
  readonly entryIndex: number;
  readonly exitIndex: number;
  readonly entryDate: string;
  readonly exitDate: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly entryFee: number;
  readonly exitFee: number;
  readonly maxLoss: number;
  readonly maxLossPct: number;
  readonly premium: number;
  readonly exitReason: ExitReason;
  readonly marks: readonly (readonly [string, number])[];
  readonly staleDays: number;
}

export interface Skip {
  readonly event: SignalEvent;
  readonly reason: string;
}

export interface Book {
  readonly trades: readonly PricedTrade[];
  readonly skipped: readonly Skip[];
}

export interface OptionsSpecFields {
  readonly structure: Structure;
  readonly dteTarget: number;
  readonly dteMin: number;
  readonly widthSigma: number;
  readonly maxLossPct: number;
  readonly longDelta?: number;
  readonly shortDelta?: number;
  readonly profitTakePct?: number | null;
  readonly exitDte?: number | null;
}

/** A validated DSL `options` block (book.OptionsSpec); the constructor itself does not validate. */
export class OptionsSpec {
  readonly structure: Structure;
  readonly dteTarget: number;
  readonly dteMin: number;
  readonly widthSigma: number;
  readonly maxLossPct: number;
  readonly longDelta: number;
  readonly shortDelta: number;
  readonly profitTakePct: number | null;
  readonly exitDte: number | null;

  constructor(fields: OptionsSpecFields) {
    this.structure = fields.structure;
    this.dteTarget = fields.dteTarget;
    this.dteMin = fields.dteMin;
    this.widthSigma = fields.widthSigma;
    this.maxLossPct = fields.maxLossPct;
    this.longDelta = fields.longDelta ?? DEFAULT_LONG_DELTA;
    this.shortDelta = fields.shortDelta ?? DEFAULT_SHORT_DELTA;
    this.profitTakePct = fields.profitTakePct ?? null;
    this.exitDte = fields.exitDte ?? null;
  }

  get right(): Right {
    return STRUCTURES[this.structure][0];
  }

  get kind(): Kind {
    return STRUCTURES[this.structure][1];
  }
}

/** Python's format(value, "g"): 6 significant digits, exponent form below 1e-4 or from 1e6. */
export const formatG = (value: number): string => {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Object.is(value, -0)) return "-0";
  const [digits, power] = value.toExponential(5).split("e") as [string, string];
  const exponent = Number(power);
  const trim = (text: string) =>
    text.includes(".") ? text.replace(/\.?0+$/u, "") : text;
  if (exponent < -4 || exponent >= 6)
    return `${trim(digits)}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  return trim(value.toFixed(5 - exponent));
};

const intIn = (
  block: Readonly<Record<string, unknown>>,
  key: string,
  low: number,
  high: number
): number => {
  const value = block[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !(low <= value && value <= high)
  )
    throw new Error(`${key} must be an integer in ${low}..${high}`);
  return value;
};

const numIn = (
  block: Readonly<Record<string, unknown>>,
  key: string,
  low: number,
  high: number,
  openLow = false
): number => {
  const value = block[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a number`);
  if (value > high || value < low || (openLow && value === low))
    throw new Error(
      `${key} must be in ${openLow ? "(" : "["}${formatG(low)}, ${formatG(high)}]`
    );
  return value;
};

/** Validates the DSL `options` block. maxLossPct above 2 is refused. */
export const parseOptions = (
  block: Readonly<Record<string, unknown>>
): OptionsSpec => {
  const unknown = Object.keys(block)
    .filter((key) => !OPTION_KEYS.has(key))
    .sort();
  if (unknown.length > 0)
    throw new Error(`Unknown options field: ${unknown.join(", ")}`);
  const structure = block["structure"];
  if (typeof structure !== "string" || !Object.hasOwn(STRUCTURES, structure))
    throw new Error(
      `structure must be one of ${Object.keys(STRUCTURES).join(", ")}`
    );
  const dteValue = block["dte"];
  if (
    typeof dteValue !== "object" ||
    dteValue === null ||
    Array.isArray(dteValue) ||
    Object.keys(dteValue).sort().join() !== "min,target"
  )
    throw new Error("dte must be {target, min}");
  const dte = dteValue as Readonly<Record<string, unknown>>;
  const maxLoss = block["maxLossPct"];
  if (typeof maxLoss === "number" && maxLoss > MAX_LOSS_PCT_CAP)
    throw new Error(
      `maxLossPct ${formatG(maxLoss)} refused: the cap is ${formatG(MAX_LOSS_PCT_CAP)}% of equity per trade`
    );
  const has = (key: string) => Object.hasOwn(block, key);
  return new OptionsSpec({
    structure: structure as Structure,
    dteTarget: intIn(dte, "target", 7, 400),
    dteMin: intIn(dte, "min", 1, 400),
    widthSigma: numIn(block, "widthSigma", 0.1, 3),
    maxLossPct: numIn(block, "maxLossPct", 0, MAX_LOSS_PCT_CAP, true),
    longDelta: has("longDelta")
      ? numIn(block, "longDelta", 0.05, 0.95)
      : DEFAULT_LONG_DELTA,
    shortDelta: has("shortDelta")
      ? numIn(block, "shortDelta", 0.05, 0.95)
      : DEFAULT_SHORT_DELTA,
    profitTakePct: has("profitTakePct")
      ? numIn(block, "profitTakePct", 1, 100)
      : null,
    exitDte: has("exitDte") ? intIn(block, "exitDte", 0, 400) : null,
  });
};

/** floor(maxLossPct% * equity / max loss per contract), capped by the cash for the entry (value + costs). */
export const contractsFor = (
  equity: number,
  cash: number,
  maxLossPct: number,
  maxLoss: number,
  unitCost: number
): number => {
  if (!(maxLossPct > 0 && maxLossPct <= MAX_LOSS_PCT_CAP))
    throw new Error(
      `maxLossPct ${formatG(maxLossPct)} refused: must be above 0 and at most ${formatG(MAX_LOSS_PCT_CAP)}`
    );
  if (![equity, cash, maxLoss, unitCost].every(Number.isFinite))
    throw new Error(
      "contracts_for needs finite equity, cash, max loss and unit cost"
    );
  if (!(maxLoss > 0 && equity > 0 && cash > 0)) return 0;
  let contracts = Math.floor(((maxLossPct / 100) * equity) / maxLoss);
  if (unitCost > 0)
    contracts = Math.min(contracts, Math.floor(cash / unitCost));
  return Math.max(0, contracts);
};

/** Monthly expiration (day number) with DTE >= minimum nearest the target DTE (ties -> earlier). */
export const chooseExpiry = (
  entry: number,
  target: number,
  minimum: number,
  calendar: TradingCalendar
): number | null => {
  const months =
    EXPIRY_SCAN_MONTHS + Math.floor(Math.max(target, minimum) / 30);
  let best: number | null = null;
  for (const expiry of expirationsAfter(entry, months, calendar)) {
    const dte = expiry - entry;
    if (dte < minimum) continue;
    if (
      best === null ||
      Math.abs(dte - target) < Math.abs(best - entry - target)
    )
      best = expiry;
  }
  return best;
};

/** Spot, time, rate, dividend yield, ATM IV and skew slope of one close (book._Pricing). */
interface Pricing {
  readonly spot: number;
  readonly t: number;
  readonly r: number;
  readonly q: number;
  readonly atm: number;
  readonly slope: number;
}

const ivAt = (pricing: Pricing, strike: number): number =>
  smileIv(pricing.atm, pricing.spot, strike, pricing.t, pricing.slope);

const priceAt = (pricing: Pricing, right: Right, strike: number): number =>
  bsPrice(
    right,
    pricing.spot,
    strike,
    pricing.t,
    pricing.r,
    pricing.q,
    ivAt(pricing, strike)
  );

const grid = (value: number, step: number): number =>
  pyRound(roundHalfEven(value / step) * step, 6);

/** [long strike, short strike, width] on the grid, or null when the far leg would be <= 0. */
export const chooseStrikes = (
  right: Right,
  kind: Kind,
  spot: number,
  t: number,
  r: number,
  q: number,
  atm: number,
  slope: number,
  spec: OptionsSpec
): readonly [number, number, number] | null => {
  if (!(t > 0)) return null;
  const pricing: Pricing = { spot, t, r, q, atm, slope };
  const step = strikeStep(spot);
  const target = kind === "debit" ? spec.longDelta : spec.shortDelta;
  const reach = Math.max(
    STRIKE_SEARCH_SIGMAS * atm * Math.sqrt(t) * spot,
    STRIKE_SEARCH_MIN_STEPS * step
  );
  const low = Math.max(step, grid(spot - reach, step));
  const count = roundHalfEven((grid(spot + reach, step) - low) / step);
  // Key (|delta| distance to the target, distance to the spot, strike), compared as a tuple.
  let best: readonly [number, number, number] = [
    Number.POSITIVE_INFINITY,
    0,
    0,
  ];
  for (let n = 0; n <= count; n++) {
    const strike = pyRound(low + n * step, 6);
    const key = [
      Math.abs(
        Math.abs(bsDelta(right, spot, strike, t, r, q, ivAt(pricing, strike))) -
          target
      ),
      Math.abs(strike - spot),
      strike,
    ] as const;
    if (
      key[0] < best[0] ||
      (key[0] === best[0] &&
        (key[1] < best[1] || (key[1] === best[1] && key[2] < best[2])))
    )
      best = key;
  }
  const anchor = best[2];
  const width = Math.max(
    step,
    grid(spec.widthSigma * atm * Math.sqrt(t) * spot, step)
  );
  const other = pyRound(right === "call" ? anchor + width : anchor - width, 6);
  if (other <= 0) return null;
  return kind === "debit" ? [anchor, other, width] : [other, anchor, width];
};

/** $ per contract, rounded to cents: debit = (long - short) * 100, credit = (width - (short - long)) * 100. */
export const instrumentValue = (
  kind: Kind,
  longMid: number,
  shortMid: number,
  width: number
): number => {
  if (![longMid, shortMid, width].every(Number.isFinite))
    throw new Error("instrument value needs finite leg prices and width");
  const spread =
    kind === "debit" ? longMid - shortMid : width - (shortMid - longMid);
  return pyRound(Math.max(0, spread) * MULTIPLIER, 2);
};

const fee = (symbol: string, longMid: number, shortMid: number): number =>
  pyRound(legCost(symbol, longMid) + legCost(symbol, shortMid), 2);

/**
 * Most a closing trade costs per contract under the package-close model: both legs at
 * commission + the half-spread of a leg worth the spread width. The 2% loss bound relies on it.
 */
export const worstExitCost = (symbol: string, width: number): number =>
  pyRound(2 * legCost(symbol, width), 2);

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** data.Market.__post_init__: same-length columns, increasing dates, positive closes and IVs. */
export const validateMarket = (market: Market): void => {
  const size = market.dates.length;
  if (
    !(
      market.close.length === size &&
      market.ivIndex.length === size &&
      market.rate.length === size
    )
  )
    throw new Error("Market columns must have the same length");
  if (
    market.dates.some(
      (day, index) => index > 0 && day <= (market.dates[index - 1] as string)
    )
  )
    throw new Error("Market dates must be strictly increasing");
  if (!market.close.every((value) => isFiniteNumber(value) && value > 0))
    throw new Error("Market closes must be finite and above 0");
  if (
    !market.ivIndex.every(
      (value) => value === null || (isFiniteNumber(value) && value > 0)
    )
  )
    throw new Error(
      "Market IV index values must be None or finite and above 0"
    );
  if (
    !market.rate.every(
      (value) => value === null || (isFiniteNumber(value) && value >= 0)
    )
  )
    throw new Error("Market rates must be None or finite and not negative");
};

/** The event's exit signal index (null without one); throws on indexes outside the bars. */
const checkedExitIndex = (
  event: SignalEvent,
  market: Market
): number | null => {
  const last = market.dates.length - 1;
  if (
    !(
      Number.isInteger(event.entryIndex) &&
      event.entryIndex >= 0 &&
      event.entryIndex <= last
    )
  )
    throw new Error(
      `entry index ${event.entryIndex} outside the ${market.symbol} bars`
    );
  const exitIndex = event.exitIndex ?? null;
  if (exitIndex !== null && exitIndex <= event.entryIndex)
    throw new Error("exit signal must come after the entry signal");
  return exitIndex;
};

/**
 * Why the spread closes at this bar's close, or null to hold (book.py order: expiry, stale IV,
 * exitDte, profit take, the exit signal, the last bar).
 */
const exitReasonAt = (
  spec: OptionsSpec,
  at: Readonly<{
    bar: number;
    credit: number;
    daysLeft: number;
    entryPrice: number;
    exitSignal: number | null;
    last: number;
    staleIv: boolean;
    value: number;
    width: number;
  }>
): ExitReason | null => {
  if (at.daysLeft <= 0) return "expiry";
  if (at.staleIv) return "stale-iv";
  if (spec.exitDte !== null && at.daysLeft <= spec.exitDte) return "exitDte";
  if (
    spec.profitTakePct !== null &&
    (spec.kind === "debit"
      ? at.value >= at.entryPrice * (1 + spec.profitTakePct / 100)
      : at.width * MULTIPLIER - at.value <=
        (1 - spec.profitTakePct / 100) * at.credit)
  )
    return "profitTake";
  if (at.bar === at.exitSignal) return "signal";
  if (at.bar === at.last) return "end";
  return null;
};

/** A spread priced at its entry close (priceEvent), before the hold loop. */
type OpenSpread = Readonly<{
  credit: number;
  entry: number;
  entryFee: number;
  entryPrice: number;
  exitSignal: number | null;
  expiry: number;
  indexId: string;
  level: number;
  longStrike: number;
  premium: number;
  q: number;
  rate: number;
  shortStrike: number;
  slope: number;
  width: number;
  worstExit: number;
}>;

/** Prices the entry of an event at the close after its signal, or the reason it is skipped. */
const openSpread = (
  event: SignalEvent,
  market: Market,
  spec: OptionsSpec,
  calendar: TradingCalendar
): OpenSpread | string => {
  const last = market.dates.length - 1;
  const exitIndex = checkedExitIndex(event, market);
  const entry = event.entryIndex + 1;
  if (entry >= last) return "no bar to enter and exit";
  const level = market.ivIndex[entry] as number | null;
  const rate = market.rate[entry] as number | null;
  if (level === null) return "no IV";
  if (rate === null) return "no rate";
  const entryDay = parseDay(market.dates[entry] as string);
  const expiry = chooseExpiry(entryDay, spec.dteTarget, spec.dteMin, calendar);
  if (expiry === null) return "no expiry";
  const dte = expiry - entryDay;
  if (spec.exitDte !== null && dte <= spec.exitDte) return "exitDte at entry";
  const indexId = IV_INDEX.get(market.symbol);
  if (indexId === undefined)
    throw new Error(`No IV index for ${market.symbol}`);
  const q = DIVIDEND_YIELD.get(market.symbol) ?? 0;
  const slope = SKEW.get(market.symbol) as number;
  const { right, kind } = spec;
  const pricing: Pricing = {
    spot: market.close[entry] as number,
    t: dte / DAYS_PER_YEAR,
    r: rate,
    q,
    atm: atmIv(indexId, level),
    slope,
  };
  const strikes = chooseStrikes(
    right,
    kind,
    pricing.spot,
    pricing.t,
    rate,
    q,
    pricing.atm,
    slope,
    spec
  );
  if (strikes === null) return "no strikes";
  const [longStrike, shortStrike, width] = strikes;
  const longMid = priceAt(pricing, right, longStrike);
  const shortMid = priceAt(pricing, right, shortStrike);
  const entryPrice = instrumentValue(kind, longMid, shortMid, width);
  const credit = width * MULTIPLIER - entryPrice;
  if ((kind === "debit" ? entryPrice : credit) <= 0) return "no premium";
  return {
    credit,
    entry,
    entryFee: fee(market.symbol, longMid, shortMid),
    entryPrice,
    exitSignal: exitIndex === null ? null : exitIndex + 1,
    expiry,
    indexId,
    level,
    longStrike,
    premium: Math.abs(longMid - shortMid),
    q,
    rate,
    shortStrike,
    slope,
    width,
    worstExit: worstExitCost(market.symbol, width),
  };
};

const priceEvent = (
  event: SignalEvent,
  market: Market,
  spec: OptionsSpec,
  calendar: TradingCalendar,
  tradeId: number
): PricedTrade | string => {
  const open = openSpread(event, market, spec, calendar);
  if (typeof open === "string") return open;
  const { entry, entryPrice, expiry, indexId, longStrike, q, shortStrike } =
    open;
  const { slope, width } = open;
  const { right, kind } = spec;
  const last = market.dates.length - 1;
  let { level, rate } = open;
  const marks: (readonly [string, number])[] = [
    [market.dates[entry] as string, entryPrice],
  ];
  let stale = 0;
  // The last bar always exits ("end" at the latest), so the loop returns.
  for (let bar = entry + 1; ; bar++) {
    const date = market.dates[bar] as string;
    const barLevel = market.ivIndex[bar] as number | null;
    const barRate = market.rate[bar] as number | null;
    level = barLevel ?? level;
    rate = barRate ?? rate;
    stale += barLevel === null || barRate === null ? 1 : 0;
    const daysLeft = expiry - parseDay(date);
    const pricing: Pricing = {
      spot: market.close[bar] as number,
      t: Math.max(0, daysLeft) / DAYS_PER_YEAR,
      r: rate,
      q,
      atm: atmIv(indexId, level),
      slope,
    };
    const longMid = priceAt(pricing, right, longStrike);
    const shortMid = priceAt(pricing, right, shortStrike);
    const value = instrumentValue(kind, longMid, shortMid, width);
    marks.push([date, value]);
    const reason = exitReasonAt(spec, {
      bar,
      credit: open.credit,
      daysLeft,
      entryPrice,
      exitSignal: open.exitSignal,
      last,
      staleIv: barLevel === null,
      value,
      width,
    });
    if (reason === null) continue;
    return {
      tradeId,
      symbol: market.symbol,
      structure: spec.structure,
      expiry: formatDay(expiry),
      longStrike,
      shortStrike,
      width,
      entryIndex: entry,
      exitIndex: bar,
      entryDate: market.dates[entry] as string,
      exitDate: date,
      entryPrice,
      exitPrice: value,
      entryFee: open.entryFee,
      exitFee:
        reason === "expiry"
          ? 0
          : Math.min(fee(market.symbol, longMid, shortMid), open.worstExit),
      maxLoss: pyRound(entryPrice + open.entryFee + open.worstExit, 2),
      maxLossPct: spec.maxLossPct,
      premium: open.premium,
      exitReason: reason,
      marks,
      staleDays: stale,
    };
  }
};

export type EventInput =
  | SignalEvent
  | readonly [string, number, (number | null)?];
export type OptionsInput = OptionsSpec | Readonly<Record<string, unknown>>;

/** Prices every event. Trade ids follow the event order (accepted events only). */
export const buildBook = (
  events: Iterable<EventInput>,
  options: OptionsInput,
  markets: Readonly<Record<string, Market>>
): Book => {
  const spec = options instanceof OptionsSpec ? options : parseOptions(options);
  const calendars = new Map<string, TradingCalendar>();
  const trades: PricedTrade[] = [];
  const skipped: Skip[] = [];
  for (const item of events) {
    const event: SignalEvent = Array.isArray(item)
      ? { symbol: item[0], entryIndex: item[1], exitIndex: item[2] ?? null }
      : (item as SignalEvent);
    const market = Object.hasOwn(markets, event.symbol)
      ? markets[event.symbol]
      : undefined;
    if (market === undefined)
      throw new Error(`No market data for ${event.symbol}`);
    let calendar = calendars.get(event.symbol);
    if (calendar === undefined) {
      validateMarket(market);
      calendar = new TradingCalendar(market.dates);
      calendars.set(event.symbol, calendar);
    }
    const priced = priceEvent(event, market, spec, calendar, trades.length + 1);
    if (typeof priced === "string") skipped.push({ event, reason: priced });
    else trades.push(priced);
  }
  return { trades, skipped };
};

/**
 * build_book of one validated market and one parsed spec, event by event: `price(event, tradeId)`
 * gives the PricedTrade or the skip reason. The portfolio policies price many single events of
 * one market; this keeps the market check and the trading calendar out of the loop.
 */
export const marketPricer = (
  spec: OptionsSpec,
  market: Market
): ((event: SignalEvent, tradeId: number) => PricedTrade | string) => {
  validateMarket(market);
  const calendar = new TradingCalendar(market.dates);
  return (event, tradeId) => priceEvent(event, market, spec, calendar, tradeId);
};
