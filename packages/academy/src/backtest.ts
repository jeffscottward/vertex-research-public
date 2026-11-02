// What: Modeled options backtest for Academy strategies on daily closes. Option prices are MODELED with
// Black-Scholes from a volatility input (a supplied IV series such as VIX, or trailing realized
// volatility times ivMult). It is research only: no orders, no broker, no fills from real quotes.
import {
  blackScholes,
  CONTRACT_MULTIPLIER,
  DAYS_PER_YEAR,
  realizedVol,
} from "./math.ts";
import { payoffSummary } from "./position.ts";
import type { StructureId } from "./schema.ts";
import { resolveRules, STRUCTURE_DEFS, structureLegs } from "./structures.ts";

export const MIN_BACKTEST_BARS = 60;
const DAY_MS = 86_400_000;
const RATE = 0.04;
const WARMUP = 20;

export type BacktestBars = Readonly<{
  t: ArrayLike<number>;
  c: ArrayLike<number>;
  /** Optional implied volatility per bar as an annual fraction (for example VIX / 100). */
  iv?: ArrayLike<number>;
}>;

export type BacktestInput = Readonly<{
  bars: BacktestBars;
  structure: StructureId;
  rules: Readonly<Record<string, number>>;
  capital: number;
}>;

export type BacktestTrade = Readonly<{
  entryT: string;
  exitT: string;
  role: "position" | "cycle" | "core";
  legs: readonly string[];
  units: number;
  spotEntry: number;
  spotExit: number;
  /** Cash paid at entry (negative = credit received), before costs. */
  entryNet: number;
  /** Value at exit (negative = cost to close a short). */
  exitValue: number;
  costs: number;
  pnl: number;
  reason:
    | "profit-target"
    | "stop"
    | "exit-dte"
    | "expiry"
    | "core-roll"
    | "end";
}>;

export type BacktestStats = Readonly<{
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  trades: number;
  wins: number;
  avgPnl: number;
  profitFactor: number | null;
  exposure: number;
  finalEquity: number;
  benchmarkReturn: number;
}>;

export type BacktestResult = Readonly<{
  modeled: true;
  ivSource: "supplied" | "rv-model";
  assumptions: readonly string[];
  rules: Readonly<Record<string, number>>;
  equity: readonly Readonly<{ t: string; equity: number }>[];
  benchmark: readonly Readonly<{ t: string; equity: number }>[];
  drawdown: readonly Readonly<{ t: string; drawdown: number }>[];
  trades: readonly BacktestTrade[];
  stats: BacktestStats;
}>;

interface OpenLeg {
  role: "core" | "cycle";
  kind: "call" | "put" | "stock";
  side: "long" | "short";
  qty: number;
  strike: number;
  expiry: number;
  entry: number;
  label: string;
}

interface Book {
  legs: OpenLeg[];
  entryT: number;
  spotEntry: number;
  entryNet: Record<"core" | "cycle", number>;
  costs: Record<"core" | "cycle", number>;
  units: number;
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sign = (side: "long" | "short"): number => (side === "long" ? 1 : -1);
const multiplier = (kind: OpenLeg["kind"]): number =>
  kind === "stock" ? 100 : CONTRACT_MULTIPLIER;

const legValue = (
  leg: OpenLeg,
  spot: number,
  now: number,
  vol: number
): number => {
  if (leg.kind === "stock") return spot;
  const days = (leg.expiry - now) / DAY_MS;
  return blackScholes({
    kind: leg.kind,
    spot,
    strike: leg.strike,
    years: Math.max(days, 0) / DAYS_PER_YEAR,
    rate: RATE,
    vol,
  }).price;
};

const daysLeft = (leg: OpenLeg, now: number): number =>
  (leg.expiry - now) / DAY_MS;

export const runOptionsBacktest = (input: BacktestInput): BacktestResult => {
  const length = Math.min(input.bars.t.length, input.bars.c.length);
  if (length < MIN_BACKTEST_BARS)
    throw new Error(
      `the backtest needs at least ${MIN_BACKTEST_BARS} daily bars`
    );
  const definition = STRUCTURE_DEFS[input.structure];
  const rules = resolveRules(input.structure, input.rules);
  const supplied = input.bars.iv !== undefined;
  const closes = Array.from({ length }, (_, index) =>
    Number(input.bars.c[index])
  );
  const times = Array.from({ length }, (_, index) =>
    Number(input.bars.t[index])
  );
  // Same values as closes[index] / times[index]; every caller passes an index inside 0..length-1.
  const closeAt = (index: number): number => Number(input.bars.c[index]);
  const timeAt = (index: number): number => Number(input.bars.t[index]);
  // Options expire on a trading day: snap a nominal expiry (now + dte) that falls on a weekend or
  // holiday back to the last bar on or before it. Past the last bar the nominal date stays.
  const lastTime = timeAt(length - 1);
  const expiryFor = (now: number, nominal: number): number =>
    nominal >= lastTime
      ? nominal
      : times.reduce(
          (snapped, time) =>
            time > snapped && time <= nominal ? time : snapped,
          now
        );
  const volAt = (index: number): number => {
    const given = input.bars.iv?.[index];
    if (given !== undefined && Number.isFinite(given) && given > 0)
      return given;
    const rv = realizedVol(closes, index, Math.min(WARMUP, index)) ?? 0.2;
    return Math.min(Math.max(rv * rules.ivMult, 0.08), 2);
  };
  const cost = (leg: Pick<OpenLeg, "kind" | "qty">, price: number): number =>
    leg.kind === "stock"
      ? leg.qty * 100 * (0.005 + price * 0.0005)
      : leg.qty *
        (rules.costPerContract +
          CONTRACT_MULTIPLIER *
            Math.min(
              Math.max((price * rules.slippagePct) / 100, 0.01),
              rules.slipCap
            ));

  let cash = input.capital;
  let cycleT = 0;
  // Days on which one unit cost more than the risk budget (no position opened).
  let tooSmall = 0;
  let cycleSpot = 0;
  let book: Book | null = null;
  const trades: BacktestTrade[] = [];
  const equity: { t: string; equity: number }[] = [];
  const benchmark: { t: string; equity: number }[] = [];
  let exposed = 0;
  // The bar loop runs at least MIN_BACKTEST_BARS - WARMUP times, so both are always overwritten.
  let finalEquity = input.capital;
  let benchmarkFinal = input.capital;
  const firstIndex = WARMUP;
  const benchmarkShares = input.capital / closeAt(firstIndex);

  const markBook = (
    index: number,
    roles: readonly ("core" | "cycle")[]
  ): number => {
    if (book === null) return 0;
    const vol = volAt(index);
    return book.legs
      .filter((leg) => roles.includes(leg.role))
      .reduce(
        (sum, leg) =>
          sum +
          sign(leg.side) *
            leg.qty *
            multiplier(leg.kind) *
            legValue(leg, closeAt(index), timeAt(index), vol),
        0
      );
  };

  const openLegs = (
    index: number,
    roles: readonly ("core" | "cycle")[],
    units: number
  ): void => {
    const spot = closeAt(index);
    const now = timeAt(index);
    const priced = structureLegs(
      input.structure,
      rules,
      spot,
      volAt(index),
      RATE,
      roles
    );
    if (book === null)
      book = {
        legs: [],
        entryT: now,
        spotEntry: spot,
        entryNet: { core: 0, cycle: 0 },
        costs: { core: 0, cycle: 0 },
        units,
      };
    for (const leg of priced) {
      const role = leg.role;
      const open: OpenLeg = {
        role,
        kind: leg.kind,
        side: leg.side,
        qty: leg.qty * units,
        strike: leg.strike,
        expiry:
          leg.kind === "stock"
            ? Number.POSITIVE_INFINITY
            : expiryFor(now, now + leg.dte * DAY_MS),
        entry: leg.entry,
        label:
          leg.kind === "stock"
            ? `Long ${leg.qty * units * 100} shares`
            : `${leg.side === "long" ? "Long" : "Short"} ${leg.qty * units} ${leg.strike} ${leg.kind} ${iso(now + leg.dte * DAY_MS)}`,
      };
      const paid =
        sign(open.side) * open.qty * multiplier(open.kind) * open.entry;
      const fee = cost(open, open.entry);
      cash -= paid + fee;
      book.entryNet[role] += paid;
      book.costs[role] += fee;
      book.legs.push(open);
    }
  };

  const closeLegs = (
    current: Book,
    index: number,
    roles: readonly ("core" | "cycle")[],
    reason: BacktestTrade["reason"]
  ): void => {
    const spot = closeAt(index);
    const now = timeAt(index);
    const vol = volAt(index);
    for (const role of roles) {
      const legs = current.legs.filter((leg) => leg.role === role);
      if (legs.length === 0) continue;
      let value = 0;
      let fees = current.costs[role];
      for (const leg of legs) {
        const price = legValue(leg, spot, now, vol);
        const proceeds =
          sign(leg.side) * leg.qty * multiplier(leg.kind) * price;
        const fee =
          daysLeft(leg, now) <= 0 && leg.kind !== "stock"
            ? 0
            : cost(leg, price);
        cash += proceeds - fee;
        value += proceeds;
        fees += fee;
      }
      const roleLabel = definition.legs.some((rule) => rule.role === "core")
        ? role
        : "position";
      trades.push({
        entryT: iso(role === "cycle" && cycleT > 0 ? cycleT : current.entryT),
        exitT: iso(now),
        role: roleLabel,
        legs: legs.map((leg) => leg.label),
        units: current.units,
        spotEntry: role === "cycle" ? cycleSpot : current.spotEntry,
        spotExit: spot,
        entryNet: current.entryNet[role],
        exitValue: value,
        costs: fees,
        pnl: value - current.entryNet[role] - fees,
        reason,
      });
      current.legs = current.legs.filter((leg) => leg.role !== role);
      current.entryNet[role] = 0;
      current.costs[role] = 0;
    }
    if (current.legs.length === 0) book = null;
  };

  const hasCore = definition.legs.some((leg) => leg.role === "core");
  const sizeUnits = (index: number): number => {
    const spot = closeAt(index);
    const vol = volAt(index);
    const legs = structureLegs(input.structure, rules, spot, vol, RATE);
    const equityNow = cash;
    if (definition.usesShares) {
      const optionsCash = legs
        .filter((leg) => leg.kind !== "stock")
        .reduce(
          (sum, leg) =>
            sum + sign(leg.side) * leg.entry * CONTRACT_MULTIPLIER * leg.qty,
          0
        );
      return Math.floor(
        (equityNow * 0.98) / Math.max(spot * 100 + optionsCash, 1)
      );
    }
    if (input.structure === "cash_secured_put") {
      // cash_secured_put has exactly one (put) leg.
      const strike = Math.max(...legs.map((leg) => leg.strike));
      return Math.floor((equityNow * 0.98) / (strike * 100));
    }
    const summary = payoffSummary(legs, spot, RATE);
    const risk = (equityNow * rules.riskPct) / 100;
    // Floor the unit loss at 0.5% of the notional so that a near-zero-width structure cannot size huge.
    const unitLoss = Math.max(
      summary.maxLoss === null ? spot * 100 * 0.2 : -summary.maxLoss,
      spot * 100 * 0.005
    );
    const unitCash = Math.max(
      Math.abs(
        legs.reduce(
          (sum, leg) =>
            sum + sign(leg.side) * leg.entry * CONTRACT_MULTIPLIER * leg.qty,
          0
        )
      ),
      1
    );
    return Math.min(
      Math.floor(risk / unitLoss),
      Math.floor(equityNow / unitCash)
    );
  };

  for (let index = firstIndex; index < length; index += 1) {
    const now = timeAt(index);
    const spot = closeAt(index);
    const last = index === length - 1;
    if (book !== null) {
      const current: Book = book;
      const cycleLegs = current.legs.filter((leg) => leg.role === "cycle");
      const coreLegs = current.legs.filter(
        (leg) => leg.role === "core" && leg.kind !== "stock"
      );
      if (last) closeLegs(current, index, ["cycle", "core"], "end");
      else if (
        coreLegs.length > 0 &&
        // Only pmcc, deep_itm_call and calendar_call hold core options; all define coreExitDte.
        Math.min(...coreLegs.map((leg) => daysLeft(leg, now))) <=
          Number(rules["coreExitDte"])
      ) {
        closeLegs(current, index, ["cycle", "core"], "core-roll");
      } else if (cycleLegs.length > 0) {
        const entryNet = current.entryNet.cycle;
        const pnl = markBook(index, ["cycle"]) - entryNet;
        const basis = Math.abs(entryNet);
        const remaining = Math.min(
          ...cycleLegs.map((leg) => daysLeft(leg, now))
        );
        const target = (basis * rules.profitTakePct) / 100;
        const stop = (basis * rules.stopLossPct) / 100;
        if (remaining <= 0) closeLegs(current, index, ["cycle"], "expiry");
        else if (basis > 0 && pnl >= target)
          closeLegs(current, index, ["cycle"], "profit-target");
        else if (basis > 0 && pnl <= -stop)
          closeLegs(current, index, ["cycle"], "stop");
        else if (rules.exitDte > 0 && remaining <= rules.exitDte)
          closeLegs(current, index, ["cycle"], "exit-dte");
      }
      // Cycle closed but core still held: reopen the cycle legs on the next bar.
    } else if (!last && index + 1 < length && cash > 0) {
      const units = sizeUnits(index);
      if (units >= 1) {
        openLegs(index, ["core", "cycle"], units);
        cycleT = now;
        cycleSpot = spot;
      } else tooSmall += 1;
    }
    if (book !== null && !last) {
      const current: Book = book;
      const needsCycle =
        hasCore &&
        definition.legs.some((leg) => leg.role === "cycle") &&
        !current.legs.some((leg) => leg.role === "cycle");
      if (needsCycle && times[index] !== current.entryT) {
        openLegs(index, ["cycle"], current.units);
        cycleT = now;
        cycleSpot = spot;
      }
    }
    if (book !== null) exposed += 1;
    const value = cash + markBook(index, ["core", "cycle"]);
    equity.push({ t: iso(now), equity: value });
    benchmark.push({ t: iso(now), equity: benchmarkShares * spot });
    finalEquity = value;
    benchmarkFinal = benchmarkShares * spot;
  }

  let peak = Number.NEGATIVE_INFINITY;
  const drawdown = equity.map((point) => {
    peak = Math.max(peak, point.equity);
    return { t: point.t, drawdown: peak > 0 ? point.equity / peak - 1 : 0 };
  });
  const returns: number[] = [];
  let previous: number | null = null;
  for (const point of equity) {
    if (previous !== null)
      returns.push(point.equity / Math.max(previous, 1e-9) - 1);
    previous = point.equity;
  }
  const mean =
    returns.reduce((sum, value) => sum + value, 0) /
    Math.max(returns.length, 1);
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(returns.length - 1, 1);
  const years = Math.max(
    (timeAt(length - 1) - timeAt(firstIndex)) / (DAYS_PER_YEAR * DAY_MS),
    1 / DAYS_PER_YEAR
  );
  // With a core holding (stock, LEAPS), the hit rate counts the cycle trades; the core P&L is in equity.
  const hasCycle = definition.legs.some((leg) => leg.role === "cycle");
  const closed =
    hasCore && hasCycle
      ? trades.filter((trade) => trade.role === "cycle")
      : trades;
  const wins = closed.filter((trade) => trade.pnl > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = closed
    .filter((trade) => trade.pnl < 0)
    .reduce((sum, trade) => sum - trade.pnl, 0);
  return {
    modeled: true,
    ivSource: supplied ? "supplied" : "rv-model",
    rules,
    assumptions: [
      "Option prices are modeled with Black-Scholes on daily closes; they are not historical option quotes.",
      supplied
        ? "Implied volatility comes from the supplied series (for example VIX for SPY), flat across strikes."
        : `Implied volatility = trailing 20-day realized volatility x ${rules["ivMult"]}, floored at 8%, flat across strikes.`,
      `Costs: $${rules["costPerContract"]} per contract plus slippage of ${rules["slippagePct"]}% of premium per leg per side (min $0.01, max $${rules["slipCap"]} per share); stock 0.5 cent per share plus 5 bp.`,
      "Risk-free rate 4%. No dividends, no early assignment; short options settle at intrinsic value at expiry.",
      "Strikes are chosen by Black-Scholes delta and rounded to the listed increment.",
      ...(tooSmall > 0
        ? [
            `On ${tooSmall} day(s) one unit cost more than the risk budget (riskPct ${rules["riskPct"]}% of equity), so no position was opened. Raise riskPct or capital.`,
          ]
        : []),
    ],
    equity,
    benchmark,
    drawdown,
    trades,
    stats: {
      totalReturn: finalEquity / input.capital - 1,
      cagr: (finalEquity / input.capital) ** (1 / years) - 1,
      maxDrawdown: Math.min(0, ...drawdown.map((point) => point.drawdown)),
      sharpe: variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0,
      winRate: closed.length === 0 ? 0 : wins.length / closed.length,
      trades: closed.length,
      wins: wins.length,
      avgPnl:
        closed.length === 0
          ? 0
          : closed.reduce((sum, trade) => sum + trade.pnl, 0) / closed.length,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      exposure: exposed / Math.max(equity.length, 1),
      finalEquity,
      benchmarkReturn: benchmarkFinal / input.capital - 1,
    },
  };
};
