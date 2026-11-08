/**
 * Run statistics of the qc-ports options runner, ported from
 * services/research/strategies/qc_ports/metrics.py, with the deflated Sharpe of
 * services/research/backtesting/optimizer.py (deflated_sharpe_ratio, expected_max_sharpe) and
 * CPython's statistics.NormalDist cdf / inv_cdf (Wichura AS241), same operation order.
 *
 * - CAGR over calendar time between the first and the last run day.
 * - Sharpe: daily returns, rf 0, sample std, annualized by sqrt(252).
 * - Deflated Sharpe (Bailey and Lopez de Prado 2014) with the real number of trials; the trial
 *   variance is the caller's or the sampling variance of the Sharpe estimator; one trial gives
 *   the probabilistic Sharpe (benchmark 0); a non-positive radicand or a negative or non-finite
 *   trial variance gives null.
 * - Max drawdown, worst calendar month, trades, win rate (pnl > 0) and exposure.
 *
 * Python's x ** 2 is glibc pow(x, 2), which V8 computes as x * x (correctly rounded); the two
 * differ by one ulp on about 0.1% of inputs, so moments can differ in the last bit. ** 1.5, 3 and
 * 4 and the CAGR power go to the same glibc pow in both.
 */
import { parseDay } from "./calendar.ts";
import type { LedgerResult } from "./ledger.ts";
import { erf, log, pySum } from "./libm.ts";

export const TRADING_DAYS = 252;
const DAYS_PER_YEAR = 365.25;
const EULER_GAMMA = 0.577_215_664_901_532_9;

/** statistics.NormalDist().cdf(x). */
export const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

/** AS241 coefficients, highest power first (the literals of CPython's statistics.py). */
const CENTRAL_NUM = [
  2509.080_928_730_122_7, 33_430.575_583_588_13, 67_265.770_927_008_7,
  45_921.953_931_549_87, 13_731.693_765_509_46, 1971.590_950_306_551_3,
  133.141_667_891_784_38, 3.387_132_872_796_366_5,
];
const CENTRAL_DEN = [
  5226.495_278_852_854, 28_729.085_735_721_943, 39_307.895_800_092_71,
  21_213.794_301_586_597, 5394.196_021_424_751, 687.187_007_492_057_9,
  42.313_330_701_600_91, 1,
];
const NEAR_NUM = [
  0.000_774_545_014_278_341_4, 0.022_723_844_989_269_184,
  0.241_780_725_177_450_6, 1.270_458_252_452_368_4, 3.647_848_324_763_204_5,
  5.769_497_221_460_691, 4.630_337_846_156_546, 1.423_437_110_749_683_5,
];
const NEAR_DEN = [
  1.050_750_071_644_416_9e-9, 0.000_547_593_808_499_534_5,
  0.015_198_666_563_616_457, 0.148_103_976_427_480_08, 0.689_767_334_985_1,
  1.676_384_830_183_803_8, 2.053_191_626_637_759, 1,
];
const FAR_NUM = [
  2.010_334_399_292_288_1e-7, 2.711_555_568_743_487_6e-5,
  0.001_242_660_947_388_078_4, 0.026_532_189_526_576_124,
  0.296_560_571_828_504_87, 1.784_826_539_917_291_3, 5.463_784_911_164_114,
  6.657_904_643_501_103,
];
const FAR_DEN = [
  2.044_263_103_389_939_7e-15, 1.421_511_758_316_446e-7,
  1.846_318_317_510_054_8e-5, 0.000_786_869_131_145_613_3,
  0.014_875_361_290_850_615, 0.136_929_880_922_735_8, 0.599_832_206_555_888, 1,
];

/** (((c0 * r + c1) * r + c2) ... ) * r + cn, the evaluation order of the Python source. */
const horner = (coefficients: readonly number[], r: number): number => {
  let total = coefficients[0] as number;
  for (let index = 1; index < coefficients.length; index++)
    total = total * r + (coefficients[index] as number);
  return total;
};

/** statistics.NormalDist().inv_cdf(p): Wichura's AS241 rational approximations. */
export const normalInvCdf = (p: number): number => {
  if (!(p > 0 && p < 1))
    throw new Error("p must be in the range 0.0 < p < 1.0");
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180_625 - q * q;
    return (horner(CENTRAL_NUM, r) * q) / horner(CENTRAL_DEN, r);
  }
  const r = Math.sqrt(-log(q <= 0 ? p : 1 - p));
  const x =
    r <= 5
      ? horner(NEAR_NUM, r - 1.6) / horner(NEAR_DEN, r - 1.6)
      : horner(FAR_NUM, r - 5) / horner(FAR_DEN, r - 5);
  return q < 0 ? -x : x;
};

/** Expected maximum Sharpe of `nTrials` unskilled trials (False Strategy Theorem). */
export const expectedMaxSharpe = (
  nTrials: number,
  sharpeVariance: number
): number => {
  if (!(Number.isInteger(nTrials) && nTrials >= 2))
    throw new Error("Need at least two trials");
  if (!(sharpeVariance >= 0)) throw new Error("Sharpe variance must be >= 0");
  return (
    Math.sqrt(sharpeVariance) *
    ((1 - EULER_GAMMA) * normalInvCdf(1 - 1 / nTrials) +
      EULER_GAMMA * normalInvCdf(1 - 1 / (nTrials * Math.E)))
  );
};

export interface DeflatedSharpe {
  readonly sharpe: number;
  readonly nTrials: number;
  readonly sharpeVariance: number;
  readonly nObservations: number;
  readonly skew: number;
  readonly kurtosis: number;
  readonly expectedMaxSharpe: number;
  readonly z: number;
  readonly probability: number;
}

/**
 * Bailey and Lopez de Prado (2014) deflated Sharpe ratio (optimizer.deflated_sharpe_ratio). Sharpe
 * inputs are per observation; `kurtosis` is the raw (non-excess) kurtosis.
 */
export const deflatedSharpeRatio = (
  sharpe: number,
  nTrials: number,
  sharpeVariance: number,
  nObservations: number,
  skew = 0,
  kurtosis = 3
): DeflatedSharpe => {
  if (!(Number.isInteger(nObservations) && nObservations >= 2))
    throw new Error("Need at least two observations");
  if (![sharpe, sharpeVariance, skew, kurtosis].every(Number.isFinite))
    throw new Error("DSR inputs must be finite");
  const benchmark = expectedMaxSharpe(nTrials, sharpeVariance);
  const radicand = 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2;
  if (!(radicand > 0))
    throw new Error("Non-positive Sharpe standard error term");
  const z =
    ((sharpe - benchmark) * Math.sqrt(nObservations - 1)) / Math.sqrt(radicand);
  return {
    sharpe,
    nTrials,
    sharpeVariance,
    nObservations,
    skew,
    kurtosis,
    expectedMaxSharpe: benchmark,
    z,
    probability: normalCdf(z),
  };
};

export const maxDrawdown = (equity: readonly number[]): number => {
  let peak = equity[0] as number;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
};

/** [month, change] of the worst month-end equity over the previous month-end (the first over `start`). */
export const worstMonth = (
  dates: readonly string[],
  equity: readonly number[],
  start: number
): readonly [string, number] | null => {
  const monthEnd = new Map<string, number>();
  for (let index = 0; index < Math.min(dates.length, equity.length); index++)
    monthEnd.set((dates[index] as string).slice(0, 7), equity[index] as number);
  let worst: readonly [string, number] | null = null;
  let previous = start;
  for (const [month, value] of monthEnd) {
    const change = value / previous - 1;
    if (worst === null || change < worst[1]) worst = [month, change];
    previous = value;
  }
  return worst;
};

/** Mean, sample std, skew and raw (non-excess) kurtosis (population moments). */
export const moments = (
  returns: readonly number[]
): readonly [number, number, number, number] => {
  const n = returns.length;
  const mean = pySum(returns) / n;
  if (n < 2) return [mean, 0, 0, 3];
  const m2 = pySum(returns.map((x) => (x - mean) ** 2)) / n;
  const m3 = pySum(returns.map((x) => (x - mean) ** 3)) / n;
  const m4 = pySum(returns.map((x) => (x - mean) ** 4)) / n;
  const std = Math.sqrt((m2 * n) / (n - 1));
  if (m2 <= 0) return [mean, std, 0, 3];
  return [mean, std, m3 / m2 ** 1.5, m4 / m2 ** 2];
};

export interface DeflatedStats {
  readonly deflatedSharpe: number | null;
  readonly expectedMaxSharpe: number | null;
  readonly sharpeVariance: number | null;
}

/** metrics._deflated: the deflated Sharpe fields of the summary. */
export const deflatedStats = (
  sharpe: number,
  nTrials: number,
  variance: number | null,
  n: number,
  skew: number,
  kurt: number
): DeflatedStats => {
  const radicand = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe ** 2;
  const trialVariance = variance ?? (n >= 2 ? radicand / (n - 1) : null);
  // The Sharpe standard error needs a positive radicand and a finite, non-negative trial variance.
  if (
    n < 2 ||
    !(Number.isFinite(radicand) && radicand > 0) ||
    trialVariance === null ||
    !(Number.isFinite(trialVariance) && trialVariance >= 0)
  )
    return {
      deflatedSharpe: null,
      expectedMaxSharpe: null,
      sharpeVariance: trialVariance,
    };
  if (nTrials >= 2) {
    const result = deflatedSharpeRatio(
      sharpe,
      nTrials,
      trialVariance,
      n,
      skew,
      kurt
    );
    return {
      deflatedSharpe: result.probability,
      expectedMaxSharpe: result.expectedMaxSharpe,
      sharpeVariance: trialVariance,
    };
  }
  const z = (sharpe * Math.sqrt(n - 1)) / Math.sqrt(radicand);
  return {
    deflatedSharpe: normalCdf(z),
    expectedMaxSharpe: 0,
    sharpeVariance: trialVariance,
  };
};

export interface RunStats extends DeflatedStats {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly finalEquity: number;
  readonly totalReturn: number;
  readonly cagr: number | null;
  readonly sharpe: number | null;
  readonly nTrials: number;
  readonly maxDrawdown: number;
  readonly worstMonth: string;
  readonly worstMonthReturn: number;
  readonly trades: number;
  readonly winRate: number | null;
  readonly exposure: number;
  readonly skipped: number;
}

/** Statistics of one run. `nTrials` = configurations tried in the search that produced it. */
export const summarize = (
  result: LedgerResult,
  nTrials: number,
  sharpeVariance: number | null = null
): RunStats => {
  if (!(Number.isInteger(nTrials) && nTrials >= 1))
    throw new Error("n_trials must be an integer >= 1");
  const { dates, equity } = result;
  if (equity.length < 2) throw new Error("Need at least two run days");
  const first = dates[0] as string;
  const lastDay = dates.at(-1) as string;
  const finalEquity = equity.at(-1) as number;
  const years = (parseDay(lastDay) - parseDay(first)) / DAYS_PER_YEAR;
  const returns = equity
    .slice(1)
    .map((value, index) => value / (equity[index] as number) - 1);
  const wins = result.trades.filter((trade) => trade.pnl > 0).length;
  const [month, monthReturn] = worstMonth(
    dates,
    equity,
    result.capital
  ) as readonly [string, number];
  const [mean, std, skew, kurt] = moments(returns);
  const sharpe = std > 0 ? mean / std : null;
  return {
    start: first,
    end: lastDay,
    days: dates.length,
    finalEquity,
    totalReturn: finalEquity / result.capital - 1,
    cagr:
      years > 0 && finalEquity > 0
        ? (finalEquity / result.capital) ** (1 / years) - 1
        : null,
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(TRADING_DAYS),
    ...(sharpe === null
      ? { deflatedSharpe: null, expectedMaxSharpe: null, sharpeVariance: null }
      : deflatedStats(
          sharpe,
          nTrials,
          sharpeVariance,
          returns.length,
          skew,
          kurt
        )),
    nTrials,
    maxDrawdown: maxDrawdown([result.capital, ...equity]),
    worstMonth: month,
    worstMonthReturn: monthReturn,
    trades: result.trades.length,
    winRate: result.trades.length > 0 ? wins / result.trades.length : null,
    exposure:
      result.openPositions.filter((count) => count > 0).length / dates.length,
    skipped: result.skipped.length,
  };
};
