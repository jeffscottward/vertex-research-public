import type { TapePrint } from "./flow-trade-signing.ts";

// Check of the streamed tape against IBKR history (docs/vertex-rebuild/flow-pipeline.md, "Check
// against IBKR history"): per exchange second, the print count and the contracts of both sources.
// Pure. The collector fetches both answers and stores the result. Research only.

/** One history print: exchange second and size (the fields of MarketTradeTick that count). */
export type TapeAuditHistoryPrint = Readonly<{ t: number; s: number }>;

export type TapeAuditInput = Readonly<{
  /** The newest IBKR history prints, any order. */
  history: readonly TapeAuditHistoryPrint[];
  /** The prints of a tape read that starts at or before the first history second. */
  tape: readonly TapePrint[];
  /** Inclusive pairs [from, to] of covered exchange seconds of the tape read. */
  covered: readonly (readonly [number, number])[];
  /** The last second that the tape read holds (inclusive). */
  until: number;
}>;

/** The result of one check; the counts are sums over the compared seconds. */
export type TapeAuditResult = Readonly<{
  fromSecond: number;
  toSecond: number;
  comparedSeconds: number;
  matchedSeconds: number;
  historyTrades: number;
  historyContracts: number;
  tapeTrades: number;
  tapeContracts: number;
}>;

interface SecondCounts {
  trades: number;
  contracts: number;
}

const countBySecond = (
  prints: Iterable<readonly [number, number]>
): Map<number, SecondCounts> => {
  const counts = new Map<number, SecondCounts>();
  for (const [t, size] of prints) {
    const second = counts.get(t);
    if (second === undefined) counts.set(t, { contracts: size, trades: 1 });
    else {
      second.trades += 1;
      second.contracts += size;
    }
  }
  return counts;
};

const EMPTY: SecondCounts = { contracts: 0, trades: 0 };

/**
 * Compares the tape with IBKR history, second by second. A second is compared when it lies
 * strictly between the first and the last history second (the 1000-print cut can split the first
 * second, and the last second can still grow), is not after `until`, and is covered by the tape. A
 * compared second matches when the print count and the contracts are equal; a second without a
 * print in both sources matches. Null when no second is compared.
 */
export const compareTapeWithHistory = (
  input: TapeAuditInput
): TapeAuditResult | null => {
  if (input.history.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const { t } of input.history) {
    first = Math.min(first, t);
    last = Math.max(last, t);
  }
  const history = countBySecond(
    input.history.map(({ s, t }) => [t, s] as const)
  );
  const tape = countBySecond(input.tape.map(([t, , size]) => [t, size]));
  const result = {
    comparedSeconds: 0,
    fromSecond: 0,
    historyContracts: 0,
    historyTrades: 0,
    matchedSeconds: 0,
    tapeContracts: 0,
    tapeTrades: 0,
    toSecond: 0,
  };
  const end = Math.min(last - 1, input.until);
  for (let second = first + 1; second <= end; second += 1) {
    if (!input.covered.some(([from, to]) => from <= second && second <= to))
      continue;
    const fromHistory = history.get(second) ?? EMPTY;
    const fromTape = tape.get(second) ?? EMPTY;
    if (result.comparedSeconds === 0) result.fromSecond = second;
    result.toSecond = second;
    result.comparedSeconds += 1;
    if (
      fromHistory.trades === fromTape.trades &&
      fromHistory.contracts === fromTape.contracts
    )
      result.matchedSeconds += 1;
    result.historyTrades += fromHistory.trades;
    result.historyContracts += fromHistory.contracts;
    result.tapeTrades += fromTape.trades;
    result.tapeContracts += fromTape.contracts;
  }
  return result.comparedSeconds === 0 ? null : result;
};
