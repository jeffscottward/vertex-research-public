// Portfolio combination: several finished backtest runs share one deposit. Each slot receives
// deposit x weight and follows its run's equity ratio (equity / the run's initial capital). Money
// not given to a slot (1 - sum of weights) stays as cash. The time axis is the union of every
// slot's equity points; before its first point a slot is flat, after its last point it holds its
// final value. Pure functions; research only, no order path.

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Share of the points, at the end of the period, that form the recent window. */
const COMBO_RECENT_WINDOW_SHARE = 0.25;
/** Fewer recent returns than this gives the verdict "insufficient". */
const COMBO_MIN_RECENT_POINTS = 10;
/** Robust needs recent Sharpe >= this share of the full-period Sharpe (when that is positive). */
const COMBO_SHARPE_KEEP_RATIO = 0.5;
/** Robust needs the recent max drawdown <= this multiple of the full-period max drawdown. */
const COMBO_DRAWDOWN_GROWTH_LIMIT = 1.5;

export type ComboSlotInput = Readonly<{
  label: string;
  weight: number;
  initialCapital: number;
  equity: readonly Readonly<{ t: number; equity: number }>[];
}>;

export type ComboStats = Readonly<{
  cagr: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  totalReturn: number;
}>;

export type ComboVerdict = "robust" | "degrading" | "insufficient";

export type ComboSlotResult = Readonly<{
  label: string;
  weight: number;
  allocation: number;
  pnl: number;
  full: ComboStats;
  recent: ComboStats;
  verdict: ComboVerdict;
  verdictReason: string;
}>;

export type ComboResult = Readonly<{
  deposit: number;
  cash: number;
  points: readonly Readonly<{
    t: number;
    equity: number;
    drawdownPct: number;
  }>[];
  finalEquity: number;
  netProfit: number;
  stats: ComboStats;
  slots: readonly ComboSlotResult[];
  /** correlation[i][j]: Pearson correlation of per-point returns; null when a series is flat. */
  correlation: readonly (readonly (number | null)[])[];
  /** overlap[i][j]: share of points where slots i and j are both below their running peak. */
  drawdownOverlap: readonly (readonly number[])[];
  /** Share of points where two or more slots are below their running peak at the same time. */
  jointDrawdownShare: number;
  diversification: Readonly<{
    weightedSlotDrawdownPct: number;
    combinedDrawdownPct: number;
    /** Weighted average of slot volatilities divided by combined volatility; null when flat. */
    ratio: number | null;
    diversified: boolean;
  }>;
}>;

export class ComboInputError extends Error {}

/** Each slot's ratio (equity / initial capital) on the shared time axis, forward filled. */
export const alignRatios = (
  slots: readonly ComboSlotInput[]
): Readonly<{ times: number[]; ratios: number[][] }> => {
  const times = [
    ...new Set(slots.flatMap((slot) => slot.equity.map((point) => point.t))),
  ].sort((left, right) => left - right);
  const ratios = slots.map((slot) => {
    const sorted = [...slot.equity].sort((left, right) => left.t - right.t);
    const out: number[] = [];
    let index = 0;
    let current = 1;
    for (const t of times) {
      while (index < sorted.length && (sorted[index]?.t as number) <= t) {
        current = (sorted[index]?.equity as number) / slot.initialCapital;
        index += 1;
      }
      out.push(current);
    }
    return out;
  });
  return { ratios, times };
};

const returnsOf = (values: readonly number[]): number[] => {
  const out: number[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] as number;
    out.push(previous === 0 ? 0 : (values[index] as number) / previous - 1);
  }
  return out;
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const deviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
  );
};

const drawdownSeries = (values: readonly number[]): number[] => {
  let peak = Number.NEGATIVE_INFINITY;
  return values.map((value) => {
    peak = Math.max(peak, value);
    return peak > 0 ? (peak - value) / peak : 0;
  });
};

/** Total return, CAGR, max drawdown and annualized Sharpe (risk-free 0) of a value series. */
export const seriesStats = (
  times: readonly number[],
  values: readonly number[]
): ComboStats => {
  const first = values[0] as number;
  const last = values.at(-1) as number;
  const totalReturn = first > 0 ? last / first - 1 : 0;
  const years =
    values.length > 1
      ? ((times.at(-1) as number) - (times[0] as number)) / YEAR_MS
      : 0;
  const growth =
    years > 0 && first > 0 && last > 0
      ? (last / first) ** (1 / years) - 1
      : null;
  const returns = returnsOf(values);
  const spread = deviation(returns);
  const sharpe =
    returns.length > 1 && spread > 0 && years > 0
      ? (mean(returns) / spread) * Math.sqrt(returns.length / years)
      : null;
  return {
    cagr: growth !== null && Number.isFinite(growth) ? growth : null,
    maxDrawdownPct: Math.max(0, ...drawdownSeries(values)),
    sharpe,
    totalReturn,
  };
};

export const pearson = (
  left: readonly number[],
  right: readonly number[]
): number | null => {
  if (left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let cross = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = (left[index] as number) - leftMean;
    const b = (right[index] as number) - rightMean;
    cross += a * b;
    leftSquares += a * a;
    rightSquares += b * b;
  }
  if (leftSquares <= 1e-24 || rightSquares <= 1e-24) return null;
  return Math.max(
    -1,
    Math.min(1, cross / Math.sqrt(leftSquares * rightSquares))
  );
};

/** Robust / degrading / insufficient from the recent window against the full period. */
export const verdictFor = (
  full: ComboStats,
  recent: ComboStats,
  recentPoints: number
): Readonly<{ verdict: ComboVerdict; reason: string }> => {
  if (recentPoints < COMBO_MIN_RECENT_POINTS)
    return {
      reason: `Fewer than ${COMBO_MIN_RECENT_POINTS} returns in the recent window`,
      verdict: "insufficient",
    };
  const reasons: string[] = [];
  if (full.sharpe !== null && full.sharpe > 0) {
    if (
      recent.sharpe === null ||
      recent.sharpe < full.sharpe * COMBO_SHARPE_KEEP_RATIO
    )
      reasons.push(
        `Recent Sharpe is below ${COMBO_SHARPE_KEEP_RATIO} x the full-period Sharpe`
      );
  } else if (recent.totalReturn < 0) {
    reasons.push(
      "Full-period Sharpe is not positive and the recent return is negative"
    );
  }
  const drawdownLimit = full.maxDrawdownPct * COMBO_DRAWDOWN_GROWTH_LIMIT;
  if (recent.maxDrawdownPct > drawdownLimit + 1e-12)
    reasons.push(
      `Recent max drawdown is above ${COMBO_DRAWDOWN_GROWTH_LIMIT} x the full-period max drawdown`
    );
  return reasons.length === 0
    ? {
        reason: "Recent window keeps the full-period profile",
        verdict: "robust",
      }
    : { reason: reasons.join("; "), verdict: "degrading" };
};

export const combinePortfolio = (
  deposit: number,
  slots: readonly ComboSlotInput[]
): ComboResult => {
  if (slots.length === 0) throw new ComboInputError("Select at least one run");
  const weightSum = slots.reduce((sum, slot) => sum + slot.weight, 0);
  if (weightSum > 1 + 1e-9)
    throw new ComboInputError("Weights must not add up to more than 1");
  for (const slot of slots)
    if (slot.equity.length < 2)
      throw new ComboInputError(
        `Run ${slot.label} has fewer than 2 equity points`
      );
  const { times, ratios } = alignRatios(slots);
  const allocations = slots.map((slot) => deposit * slot.weight);
  const cash = deposit - allocations.reduce((sum, value) => sum + value, 0);
  const values = times.map(
    (_, index) =>
      cash +
      ratios.reduce(
        (sum, series, slot) =>
          sum + (allocations[slot] as number) * (series[index] as number),
        0
      )
  );
  const combinedDrawdown = drawdownSeries(values);
  const slotDrawdowns = ratios.map(drawdownSeries);
  const slotReturns = ratios.map(returnsOf);
  // Slot statistics and verdicts use the run's own equity points, so other slots' dates do not
  // dilute them.
  const slotResults = slots.map((slot, index) => {
    const own = [...slot.equity].sort((left, right) => left.t - right.t);
    const ownTimes = own.map((point) => point.t);
    const ownRatios = own.map((point) => point.equity / slot.initialCapital);
    const recentStart = Math.max(
      0,
      Math.floor(own.length * (1 - COMBO_RECENT_WINDOW_SHARE)) - 1
    );
    const full = seriesStats(ownTimes, ownRatios);
    const recentValues = ownRatios.slice(recentStart);
    const recent = seriesStats(ownTimes.slice(recentStart), recentValues);
    const { verdict, reason } = verdictFor(
      full,
      recent,
      recentValues.length - 1
    );
    const allocation = allocations[index] as number;
    return {
      allocation,
      full,
      label: slot.label,
      pnl: allocation * ((ownRatios.at(-1) as number) - 1),
      recent,
      verdict,
      verdictReason: reason,
      weight: slot.weight,
    };
  });
  const inDrawdown = slotDrawdowns.map((series) =>
    series.map((value) => value > 1e-12)
  );
  // Pairwise measures use only the dates both runs cover; flat fill-ins outside a run's own dates
  // would pull correlation toward 0.
  const spans = slots.map((slot) => {
    const own = slot.equity.map((point) => point.t);
    return [
      times.indexOf(Math.min(...own)),
      times.indexOf(Math.max(...own)),
    ] as const;
  });
  const pairSpan = (left: number, right: number) => ({
    end: Math.min(spans[left]?.[1] as number, spans[right]?.[1] as number),
    start: Math.max(spans[left]?.[0] as number, spans[right]?.[0] as number),
  });
  const overlap = inDrawdown.map((left, leftIndex) =>
    inDrawdown.map((right, rightIndex) => {
      const { start, end } = pairSpan(leftIndex, rightIndex);
      if (end < start) return 0;
      let both = 0;
      for (let index = start; index <= end; index += 1)
        if (left[index] && right[index]) both += 1;
      return both / (end - start + 1);
    })
  );
  const joint =
    times.filter(
      (_, index) => inDrawdown.filter((series) => series[index]).length >= 2
    ).length / times.length;
  const correlation = slotReturns.map((left, leftIndex) =>
    slotReturns.map((right, rightIndex) => {
      const { start, end } = pairSpan(leftIndex, rightIndex);
      // Return k runs from point k to point k + 1.
      return pearson(left.slice(start, end), right.slice(start, end));
    })
  );
  const stats = seriesStats(times, values);
  // The diversification check compares like with like: the invested part only (cash removed).
  const investedValues = values.map((value) => value - cash);
  const investedDrawdownPct = Math.max(0, ...drawdownSeries(investedValues));
  const invested = weightSum > 0 ? weightSum : 1;
  const weightedSlotDrawdownPct =
    slotResults.reduce(
      (sum, slot) => sum + slot.weight * slot.full.maxDrawdownPct,
      0
    ) / invested;
  const combinedVolatility = deviation(returnsOf(investedValues));
  const weightedVolatility =
    slotReturns.reduce(
      (sum, series, index) =>
        sum + (slots[index]?.weight as number) * deviation(series),
      0
    ) / invested;
  const ratio =
    combinedVolatility > 1e-15 ? weightedVolatility / combinedVolatility : null;
  const finalEquity = values.at(-1) as number;
  return {
    cash,
    correlation,
    deposit,
    diversification: {
      combinedDrawdownPct: investedDrawdownPct,
      diversified:
        slots.length > 1 &&
        ratio !== null &&
        ratio > 1 + 1e-9 &&
        investedDrawdownPct <= weightedSlotDrawdownPct + 1e-12,
      ratio,
      weightedSlotDrawdownPct,
    },
    drawdownOverlap: overlap,
    finalEquity,
    jointDrawdownShare: joint,
    netProfit: finalEquity - deposit,
    points: times.map((t, index) => ({
      drawdownPct: combinedDrawdown[index] as number,
      equity: values[index] as number,
      t,
    })),
    slots: slotResults,
    stats,
  };
};
