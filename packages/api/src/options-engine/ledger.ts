/**
 * Reference ledger of the qc-ports options runner, ported from
 * services/research/strategies/qc_ports/ledger.py (research only).
 *
 * Takes priced trades (book.ts, per contract) and the capital, sizes each trade at entry and
 * returns the daily equity and the trade records. Each day, in this order:
 * 1. exits: sell every open trade whose exit date is today at its exit value;
 *    cash += contracts * exit value - contracts * exit cost;
 * 2. sizing equity = cash + sum(contracts * today's mark) of the trades still open, in cents;
 * 3. entries, in trade-id order: contracts = contractsFor(sizing equity, cash left, maxLossPct,
 *    max loss, entry value + entry cost); a trade with 0 contracts is skipped (reason "size");
 * 4. equity = cash + sum(contracts * today's mark). A trade's mark on a day without a bar of its
 *    symbol is its last mark.
 * Cash and costs are booked in cents.
 */
import {
  contractsFor,
  type ExitReason,
  type PricedTrade,
  type Structure,
} from "./book.ts";
import { pyRound } from "./libm.ts";

export const DEFAULT_CAPITAL = 100_000;

/** The trade record of the ledger. Fees are the totals for all contracts. */
export interface TradeRecord {
  readonly id: number;
  readonly symbol: string;
  readonly structure: Structure;
  readonly expiry: string;
  readonly longStrike: number;
  readonly shortStrike: number;
  readonly entryDate: string;
  readonly exitDate: string;
  readonly contracts: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly entryFee: number;
  readonly exitFee: number;
  readonly pnl: number;
  readonly returnOnRisk: number;
  readonly exitReason: ExitReason;
}

export interface LedgerSkip {
  readonly id: number;
  readonly symbol: string;
  readonly entryDate: string;
  readonly reason: "size";
}

export interface LedgerResult {
  readonly dates: readonly string[];
  readonly equity: readonly number[];
  readonly openPositions: readonly number[];
  readonly trades: readonly TradeRecord[];
  readonly skipped: readonly LedgerSkip[];
  readonly capital: number;
  readonly engine: string;
}

/** The run days: `dates` (or the union of the mark dates) holding every mark date, sorted. */
export const timeline = (
  trades: readonly PricedTrade[],
  dates?: Iterable<string> | null
): string[] => {
  const marked = new Set(
    trades.flatMap((trade) => trade.marks.map(([day]) => day))
  );
  const days = [...new Set(dates ?? marked)].sort();
  const known = new Set(days);
  const missing = [...marked].filter((day) => !known.has(day)).sort();
  if (missing.length > 0)
    throw new Error(`Mark dates outside the run dates: ${missing[0]}`);
  if (new Set(trades.map((trade) => trade.tradeId)).size !== trades.length)
    throw new Error("Trade ids must be unique");
  return days;
};

const tradeRecord = (
  trade: PricedTrade,
  contracts: number,
  entryPrice: number,
  exitPrice: number,
  entryFee: number,
  exitFee: number
): TradeRecord => {
  const pnl = pyRound(
    contracts * (exitPrice - entryPrice) - entryFee - exitFee,
    2
  );
  return {
    id: trade.tradeId,
    symbol: trade.symbol,
    structure: trade.structure,
    expiry: trade.expiry,
    longStrike: trade.longStrike,
    shortStrike: trade.shortStrike,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    contracts,
    entryPrice,
    exitPrice,
    entryFee,
    exitFee,
    pnl,
    returnOnRisk: pnl / (contracts * trade.maxLoss),
    exitReason: trade.exitReason,
  };
};

interface Held {
  readonly trade: PricedTrade;
  readonly contracts: number;
  readonly entryFee: number;
}

export const runLedger = (
  trades: readonly PricedTrade[],
  capital: number = DEFAULT_CAPITAL,
  dates?: Iterable<string> | null
): LedgerResult => {
  if (!(capital > 0)) throw new Error("capital must be above 0");
  const days = timeline(trades, dates);
  const marks = new Map(
    trades.map((trade) => [trade.tradeId, new Map(trade.marks)])
  );
  const entering = new Map<string, PricedTrade[]>();
  for (const trade of [...trades].sort((a, b) => a.tradeId - b.tradeId)) {
    const list = entering.get(trade.entryDate) ?? [];
    list.push(trade);
    entering.set(trade.entryDate, list);
  }
  let cash = pyRound(capital, 2);
  // Insertion order matters: the open values are summed in entry order, as Python's dict.
  const held = new Map<number, Held>();
  const lastMark = new Map<number, number>();
  const equity: number[] = [];
  const openPositions: number[] = [];
  const records: TradeRecord[] = [];
  const skipped: LedgerSkip[] = [];

  const valueOpen = (day: string): number => {
    let total = 0;
    for (const [tradeId, { contracts }] of held) {
      const mark =
        (marks.get(tradeId) as Map<string, number>).get(day) ??
        (lastMark.get(tradeId) as number);
      lastMark.set(tradeId, mark);
      total += contracts * mark;
    }
    return total;
  };

  for (const day of days) {
    for (const [tradeId, { trade, contracts, entryFee }] of [...held].filter(
      ([, open]) => open.trade.exitDate === day
    )) {
      held.delete(tradeId);
      const exitFee = pyRound(contracts * trade.exitFee, 2);
      cash = pyRound(cash + contracts * trade.exitPrice - exitFee, 2);
      records.push(
        tradeRecord(
          trade,
          contracts,
          trade.entryPrice,
          trade.exitPrice,
          entryFee,
          exitFee
        )
      );
    }
    const sizing = pyRound(cash + valueOpen(day), 2);
    for (const trade of entering.get(day) ?? []) {
      const contracts = contractsFor(
        sizing,
        cash,
        trade.maxLossPct,
        trade.maxLoss,
        trade.entryPrice + trade.entryFee
      );
      if (contracts === 0) {
        skipped.push({
          id: trade.tradeId,
          symbol: trade.symbol,
          entryDate: day,
          reason: "size",
        });
        continue;
      }
      const entryFee = pyRound(contracts * trade.entryFee, 2);
      cash = pyRound(cash - contracts * trade.entryPrice - entryFee, 2);
      held.set(trade.tradeId, { trade, contracts, entryFee });
      lastMark.set(trade.tradeId, trade.entryPrice);
    }
    equity.push(cash + valueOpen(day));
    openPositions.push(held.size);
  }
  if (held.size > 0) throw new Error("Trades open after the last run day");
  records.sort(
    (a, b) =>
      Number(a.exitDate > b.exitDate) - Number(a.exitDate < b.exitDate) ||
      a.id - b.id
  );
  return {
    dates: days,
    equity,
    openPositions,
    trades: records,
    skipped,
    capital,
    engine: "qc-ports-ledger",
  };
};
