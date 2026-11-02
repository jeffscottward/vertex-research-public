import { z } from "zod";

// Filter studies: frozen research tests whose summary is committed with the code
// (docs/specs/research/adx-filter.md). The summary JSON is written by
// services/research/strategies/filter_study_summary.py; this module validates it and maps it to
// display rows. Research only: a study result grants no trading authority.

const Ratio = z.number().nullable();
const Halves = z.tuple([Ratio, Ratio]);
const VariantMetrics = {
  cagr: z.number(),
  maxDrawdown: z.number(),
  sharpe: Ratio,
  sharpeHalves: Halves,
  trades: z.number().int().nonnegative(),
  tradesPerYear: z.number().nonnegative(),
};
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const FilterStudySchema = z
  .object({
    daily: z.object({
      costBpsPerSide: z.number(),
      trials: z.number().int().positive(),
      universe: z.array(z.string()).min(1),
      variants: z
        .array(
          z.object({
            ...VariantMetrics,
            deflatedProbability: Ratio,
            filter: z.enum(["none", "adx_above", "adx_below", "adx_falling"]),
            strategy: z.string(),
            verdict: z.string().nullable(),
          })
        )
        .min(1),
      window: z.object({
        days: z.number().int().positive(),
        end: DateText,
        secondHalfStart: DateText,
        start: DateText,
      }),
    }),
    id: z.string(),
    intraday: z.object({
      barMinutes: z.number().int().positive(),
      costBpsPerSide: z.number(),
      sensitivity: z.object({
        costBpsPerSide: z.number(),
        verdict: z.string(),
      }),
      spearman: z.object({ firstHalf: Ratio, secondHalf: Ratio }),
      symbol: z.string(),
      variants: z
        .array(
          z.object({
            ...VariantMetrics,
            filter: z.enum(["none", "rvol_above_1"]),
          })
        )
        .min(1),
      verdict: z.string(),
      window: z.object({
        end: DateText,
        secondHalfStart: DateText,
        sessions: z.number().int().positive(),
        start: DateText,
      }),
    }),
    ran: DateText,
    spec: z.string(),
  })
  .strict();

export type FilterStudy = z.infer<typeof FilterStudySchema>;

const STRATEGY_LABELS: Readonly<Record<string, string>> = {
  breakout_20: "20-day breakout",
  emt_daily: "EMT daily proxy",
  rsi2_dip: "RSI(2) dip",
  rsi14_dip: "RSI(14) dip",
  sma_cross_20_50: "SMA 20/50 cross",
};

type FilterId =
  | FilterStudy["daily"]["variants"][number]["filter"]
  | FilterStudy["intraday"]["variants"][number]["filter"];

const FILTER_LABELS: Readonly<Record<FilterId, string>> = {
  adx_above: "ADX(14) > 20",
  adx_below: "ADX(14) < 20",
  adx_falling: "ADX(14) falling over 5 bars",
  none: "No filter",
  rvol_above_1: "RVOL at time (20) > 1.0",
};

const DASH = "—";

const ratio = (value: number | null): string =>
  value === null ? DASH : value.toFixed(2);

// Values that round to zero show as 0.0%, never -0.0%.
const percent = (value: number): string =>
  `${(Math.abs(value) < 0.0005 ? 0 : value * 100).toFixed(1)}%`;

// caution: the filter met the keep rule, but the result is not significant after deflation or the
// filtered strategy still loses money in a half (or over the whole window).
export type VerdictTone = "baseline" | "keep" | "caution" | "drop";

type Metrics = Readonly<{
  sharpe: number | null;
  sharpeHalves: readonly [number | null, number | null];
  cagr: number;
  maxDrawdown: number;
  trades: number;
  tradesPerYear: number;
}>;

const losesSomewhere = (metrics: Metrics): boolean =>
  [metrics.sharpe, ...metrics.sharpeHalves].some(
    (value) => value === null || value <= 0
  );

export type StudyRow = Readonly<{
  key: string;
  strategy: string;
  filter: string;
  sharpe: string;
  firstHalf: string;
  secondHalf: string;
  cagr: string;
  maxDrawdown: string;
  trades: string;
  tradesPerYear: string;
  deflated: string;
  verdict: string;
  tone: VerdictTone;
}>;

export type FilterStudyViewModel = Readonly<{
  dailyCaption: string;
  dailyRows: readonly StudyRow[];
  dailySummary: string;
  intradayCaption: string;
  intradayRows: readonly StudyRow[];
  intradaySummary: string;
  spec: string;
}>;

const toneOf = (verdict: string | null, metrics: Metrics): VerdictTone => {
  if (verdict === null) return "baseline";
  if (!verdict.startsWith("KEEP")) return "drop";
  return verdict === "KEEP" && !losesSomewhere(metrics) ? "keep" : "caution";
};

const row = (
  key: string,
  strategy: string,
  filter: FilterId,
  metrics: Metrics,
  deflated: number | null,
  verdict: string | null
): StudyRow => ({
  cagr: percent(metrics.cagr),
  deflated: ratio(deflated),
  filter: FILTER_LABELS[filter],
  firstHalf: ratio(metrics.sharpeHalves[0]),
  key,
  maxDrawdown: percent(metrics.maxDrawdown),
  secondHalf: ratio(metrics.sharpeHalves[1]),
  sharpe: ratio(metrics.sharpe),
  strategy,
  tone: toneOf(verdict, metrics),
  trades: metrics.trades.toLocaleString("en-US"),
  tradesPerYear: metrics.tradesPerYear.toFixed(1),
  verdict: verdict ?? "Baseline",
});

/** Validates an unknown summary and maps it to display rows. Throws when the summary is invalid. */
export const toFilterStudyViewModel = (
  value: unknown
): FilterStudyViewModel => {
  const study = FilterStudySchema.parse(value);
  const { daily, intraday } = study;
  const kept = daily.variants.filter((variant) =>
    variant.verdict?.startsWith("KEEP")
  ).length;
  const tested = daily.variants.filter(
    (variant) => variant.verdict !== null
  ).length;
  return {
    dailyCaption: `Daily bars ${daily.window.start} to ${daily.window.end} (${daily.window.days.toLocaleString("en-US")} trading days; second half from ${daily.window.secondHalfStart}). Equal-weight portfolio of ${daily.universe.length} symbols (${daily.universe.join(", ")}). ${daily.costBpsPerSide} bp per side. Deflated Sharpe over ${daily.trials} variants.`,
    dailyRows: daily.variants.map((variant) =>
      row(
        `${variant.strategy}:${variant.filter}`,
        STRATEGY_LABELS[variant.strategy] ?? variant.strategy,
        variant.filter,
        variant,
        variant.deflatedProbability,
        variant.verdict
      )
    ),
    dailySummary: `${kept} of ${tested} ADX filter variants met the keep rule (Sharpe higher in both halves and at least 30 trades per year).`,
    intradayCaption: `${intraday.symbol} ${intraday.barMinutes}-minute bars, ${intraday.window.start} to ${intraday.window.end} (${intraday.window.sessions.toLocaleString("en-US")} sessions; second half from ${intraday.window.secondHalfStart}). First-half-hour momentum, 10:00 open to the close. ${intraday.costBpsPerSide} bp per side.`,
    intradayRows: intraday.variants.map((variant) =>
      row(
        `rvol:${variant.filter}`,
        "First-half-hour momentum",
        variant.filter,
        variant,
        null,
        variant.filter === "none" ? null : intraday.verdict
      )
    ),
    intradaySummary: [
      `RVOL filter verdict: ${intraday.verdict} at ${intraday.costBpsPerSide} bp; ${intraday.sensitivity.verdict} at ${intraday.sensitivity.costBpsPerSide} bp.`,
      ...intraday.variants
        .filter(
          (variant) => variant.filter !== "none" && losesSomewhere(variant)
        )
        .map(
          (variant) =>
            `The filtered strategy still loses money (Sharpe ${ratio(variant.sharpeHalves[0])} and ${ratio(variant.sharpeHalves[1])} in the two halves), so the strategy itself does not work.`
        ),
      `Spearman correlation of RVOL with the absolute rest-of-day move: ${ratio(intraday.spearman.firstHalf)} (first half), ${ratio(intraday.spearman.secondHalf)} (second half).`,
    ].join(" "),
    spec: study.spec,
  };
};
