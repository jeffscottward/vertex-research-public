/**
 * Options engine: the TypeScript port of the qc-ports options runner
 * (services/research/strategies/qc_ports: options.py, book.py, ledger.py, metrics.py), research
 * only. services/research/tests/fixtures/qc_ports/options_golden.json (written by
 * services/research/tests/qc_ports_golden.py) pins the port to the Python reference.
 */
import type { PricedTrade } from "./book.ts";
import { DEFAULT_CAPITAL, type LedgerResult, runLedger } from "./ledger.ts";
import { type RunStats, summarize } from "./metrics.ts";

export type { Market, PricedTrade } from "./book.ts";
/** buildOptionsBook(events, options, markets): prices every signal event into a vertical spread or a skip. */
// biome-ignore lint/performance/noBarrelFile: the options engine entrypoint the server engine and the worker result check import.
export { buildBook as buildOptionsBook } from "./book.ts";
export type { LedgerResult } from "./ledger.ts";
export type { RunStats } from "./metrics.ts";
export {
  type OptionsDatasetRows,
  optionsDatasetFromRows,
  optionsRunMetrics,
  runOptionsDefinition,
} from "./portfolio.ts";

export interface LedgerOptions {
  /** Starting cash in $ (default 100,000). */
  readonly capital?: number;
  /** Run days (default: the union of the trades' mark dates); must hold every mark date. */
  readonly dates?: Iterable<string> | null;
}

/** Sizes the trades at entry against the equity and books the daily equity in cents. */
export const runOptionsLedger = (
  trades: readonly PricedTrade[],
  options: LedgerOptions = {}
): LedgerResult =>
  runLedger(trades, options.capital ?? DEFAULT_CAPITAL, options.dates);

export interface SummaryOptions {
  /** Configurations tried in the search that produced the run (1 = probabilistic Sharpe). */
  readonly nTrials: number;
  /** Variance of the per-observation Sharpe ratios over the trials (default: sampling variance). */
  readonly trialVariance?: number | null;
}

/** Return, drawdown, Sharpe and deflated Sharpe of one ledger run. */
export const summarizeOptionsRun = (
  result: LedgerResult,
  options: SummaryOptions
): RunStats =>
  summarize(result, options.nTrials, options.trialVariance ?? null);
