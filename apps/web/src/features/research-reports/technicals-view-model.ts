import type {
  ResearchReportPivot,
  ResearchReportTechnicals,
  ResearchReportTrendCheck,
} from "@darkfactory/api";

// Technicals tab of a research dossier (researchReports.technicals). Formats numbers only;
// every value comes from the server. Context markers, not signals.

export type TechnicalsRow = Readonly<{
  label: string;
  value: string;
  detail: string | null;
}>;
export type TechnicalsTone = "success" | "warning" | "neutral";
export type TrendCheckView = Readonly<{
  label: string;
  status: "pass" | "fail" | "unknown";
}>;
export type PivotRowView = Readonly<{
  date: string;
  kind: string;
  price: string;
  confirmedOn: string;
}>;
export type FibonacciRowView = Readonly<{
  ratio: string;
  price: string;
  mark: string | null;
}>;
export type VolumeBinView = Readonly<{
  range: string;
  volume: string;
  /** Width of the bar in percent of the largest bin (0-100). */
  width: number;
  mark: string | null;
}>;

export type TechnicalsView = Readonly<{
  revision: string;
  barsLine: string;
  check: Readonly<{ tone: TechnicalsTone; text: string }>;
  indicators: readonly TechnicalsRow[];
  trendChecks: readonly TrendCheckView[];
  weinstein: Readonly<{ stage: string; rows: readonly TechnicalsRow[] }> | null;
  pivots: Readonly<{
    rows: readonly TechnicalsRow[];
    items: readonly PivotRowView[];
    listLabel: string;
  }> | null;
  fibonacci: Readonly<{
    heading: string;
    rows: readonly FibonacciRowView[];
  }> | null;
  volumeProfile: Readonly<{
    rows: readonly TechnicalsRow[];
    bins: readonly VolumeBinView[];
  }> | null;
  warnings: readonly string[];
  methodNote: string;
}>;

const UNAVAILABLE = "Unavailable";
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/**
 * Price decimals from the report's own price level, so instruments that trade near 1 (FX-like
 * futures) or below 1 keep their levels and bins apart: 2 decimals from 10, 4 from 1, else 6.
 */
export const priceFormatFor = (reference: number | null): Intl.NumberFormat => {
  const level = Math.abs(reference ?? 100);
  const digits = level >= 10 ? 2 : level >= 1 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
};
const oneDecimal = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

const formatPrice = (
  prices: Intl.NumberFormat,
  value: number | null
): string => (value === null ? UNAVAILABLE : prices.format(value));
const signedPct = (value: number): string =>
  `${value > 0 ? "+" : ""}${percent.format(value)}%`;

const TREND_CHECK_LABELS: Readonly<
  Record<ResearchReportTrendCheck["key"], string>
> = {
  closeAboveSma20: "Close above SMA 20",
  closeAboveSma50: "Close above SMA 50",
  closeAboveSma150: "Close above SMA 150",
  closeAboveSma200: "Close above SMA 200",
  sma50AboveSma150: "SMA 50 above SMA 150",
  sma50AboveSma200: "SMA 50 above SMA 200",
  sma150AboveSma200: "SMA 150 above SMA 200",
  sma200Rising20Sessions: "SMA 200 rising over 20 sessions",
};

const CHECKED_FIELD_LABELS: Readonly<Record<string, string>> = {
  asOf: "as-of date",
  atr14: "ATR 14",
  latestClose: "close",
  rsi14: "RSI 14",
  sampleCount: "bar count",
  sma20: "SMA 20",
  sma50: "SMA 50",
  sma150: "SMA 150",
  sma200: "SMA 200",
};

const checkView = (data: ResearchReportTechnicals): TechnicalsView["check"] => {
  const { check, recomputed } = data;
  if (check.status === "unavailable" || recomputed === null)
    return {
      text: "Not checked: this revision has no stored daily bars or no stored bar count to compare.",
      tone: "neutral",
    };
  if (check.status === "mismatch")
    return {
      text: `Recomputed values differ from the stored values: ${check.mismatches
        .map((field) => CHECKED_FIELD_LABELS[field] ?? field)
        .join(", ")}.`,
      tone: "warning",
    };
  return {
    text: `Recomputed from ${grouped.format(recomputed.sampleCount)} stored daily bars: all 9 checked values equal the stored values.`,
    tone: "success",
  };
};

const indicatorRows = (
  data: ResearchReportTechnicals,
  prices: Intl.NumberFormat
): TechnicalsRow[] => {
  const { stored } = data;
  const close = stored.latestClose;
  const atrPct =
    stored.atr14 !== null && close !== null && close > 0
      ? `${percent.format((100 * stored.atr14) / close)}% of the close`
      : null;
  const slope = stored.sma200Slope;
  const range = stored.range52Week;
  const high = stored.maximumObservedHigh;
  return [
    { detail: stored.asOf, label: "Close", value: formatPrice(prices, close) },
    {
      detail: "Wilder, 14 sessions",
      label: "RSI 14",
      value:
        stored.rsi14 === null ? UNAVAILABLE : oneDecimal.format(stored.rsi14),
    },
    {
      detail: atrPct,
      label: "ATR 14",
      value: formatPrice(prices, stored.atr14),
    },
    { detail: null, label: "SMA 20", value: formatPrice(prices, stored.sma20) },
    { detail: null, label: "SMA 50", value: formatPrice(prices, stored.sma50) },
    {
      detail: null,
      label: "SMA 150",
      value: formatPrice(prices, stored.sma150),
    },
    {
      detail: null,
      label: "SMA 200",
      value: formatPrice(prices, stored.sma200),
    },
    {
      detail:
        slope === null
          ? null
          : [
              slope.changePct === null ? null : signedPct(slope.changePct),
              slope.fromDate === null || slope.toDate === null
                ? null
                : `${slope.fromDate} to ${slope.toDate}`,
            ]
              .filter((part) => part !== null)
              .join(", ") || null,
      label: "SMA 200 change, 20 sessions",
      value: slope === null ? UNAVAILABLE : prices.format(slope.change),
    },
    {
      detail: range?.lowDate ?? null,
      label: "52-week low",
      value: formatPrice(prices, range?.low ?? null),
    },
    {
      detail: range?.highDate ?? null,
      label: "52-week high",
      value: formatPrice(prices, range?.high ?? null),
    },
    {
      detail:
        high === null
          ? null
          : [
              high.date,
              high.drawdownPct === null
                ? null
                : `close ${signedPct(high.drawdownPct)} from it`,
            ]
              .filter((part) => part !== null)
              .join(", ") || null,
      label: "Maximum observed high",
      value: formatPrice(prices, high?.price ?? null),
    },
  ];
};

const pivotText = (
  prices: Intl.NumberFormat,
  pivot: ResearchReportPivot | null,
  sessions: number
): string =>
  pivot === null
    ? `None in the last ${sessions} sessions`
    : `${prices.format(pivot.price)} (${pivot.date})`;

const pivotsView = (
  pivots: NonNullable<ResearchReportTechnicals["pivots"]>,
  prices: Intl.NumberFormat
): NonNullable<TechnicalsView["pivots"]> => ({
  items: [...pivots.items].reverse().map((pivot) => ({
    confirmedOn: pivot.confirmedOn,
    date: pivot.date,
    kind: pivot.kind === "support" ? "Support" : "Resistance",
    price: prices.format(pivot.price),
  })),
  listLabel: `All pivots of the last ${pivots.lookbackSessions} sessions (${pivots.items.length})`,
  rows: [
    {
      detail: "Newest swing low below the close",
      label: "Support pivot",
      value: pivotText(
        prices,
        pivots.candidateSupport,
        pivots.lookbackSessions
      ),
    },
    {
      detail: "Newest swing high above the close",
      label: "Resistance pivot",
      value: pivotText(
        prices,
        pivots.candidateResistance,
        pivots.lookbackSessions
      ),
    },
  ],
});

const fibonacciView = (
  fibonacci: NonNullable<ResearchReportTechnicals["fibonacci"]>,
  prices: Intl.NumberFormat
): NonNullable<TechnicalsView["fibonacci"]> => ({
  heading: `${fibonacci.direction === "up" ? "Up" : "Down"} swing over ${fibonacci.window} sessions: low ${prices.format(fibonacci.swingLow.price)} (${fibonacci.swingLow.date}), high ${prices.format(fibonacci.swingHigh.price)} (${fibonacci.swingHigh.date}).`,
  rows: fibonacci.levels.map((level) => ({
    mark:
      level.ratio === fibonacci.nearestBelow?.ratio
        ? "Nearest below the close"
        : level.ratio === fibonacci.nearestAbove?.ratio
          ? "Nearest above the close"
          : null,
    price: prices.format(level.price),
    ratio: `${oneDecimal.format(level.ratio * 100)}%`,
  })),
});

const CLOSE_LOCATION = {
  above: "Above the value area",
  below: "Below the value area",
  inside: "Inside the value area",
} as const;

const volumeProfileView = (
  profile: NonNullable<ResearchReportTechnicals["volumeProfile"]>,
  prices: Intl.NumberFormat
): NonNullable<TechnicalsView["volumeProfile"]> => {
  const largest = profile.poc.volume;
  return {
    bins: [...profile.bins].reverse().map((bin) => {
      const inside =
        bin.low >= profile.valueAreaLow && bin.high <= profile.valueAreaHigh;
      return {
        mark:
          bin.low === profile.poc.low ? "POC" : inside ? "Value area" : null,
        range: `${prices.format(bin.low)} to ${prices.format(bin.high)}`,
        volume: grouped.format(bin.volume),
        width: largest > 0 ? Math.round((100 * bin.volume) / largest) : 0,
      };
    }),
    rows: [
      {
        detail: `${grouped.format(profile.poc.volume)} shares or contracts`,
        label: "Point of control (POC)",
        value: `${prices.format(profile.poc.low)} to ${prices.format(profile.poc.high)}`,
      },
      {
        detail: `${oneDecimal.format(profile.valueAreaVolumePct)}% of the volume`,
        label: "Value area (VAL to VAH)",
        value: `${prices.format(profile.valueAreaLow)} to ${prices.format(profile.valueAreaHigh)}`,
      },
      {
        detail: null,
        label: "Close location",
        value: CLOSE_LOCATION[profile.closeLocation],
      },
      {
        detail: `${profile.startDate} to ${profile.endDate}`,
        label: "Window",
        value: `${profile.sessions} sessions, ${profile.bins.length} bins of ${prices.format(profile.binWidth)}`,
      },
    ],
  };
};

/** Formats one researchReports.technicals response for the Technicals tab. */
export const toTechnicalsViewModel = (
  data: ResearchReportTechnicals
): TechnicalsView => {
  const { bars, method, weinstein } = data;
  const prices = priceFormatFor(
    data.stored.latestClose ?? data.recomputed?.latestClose ?? null
  );
  return {
    barsLine:
      bars === null
        ? "No stored daily bars in this revision."
        : `${grouped.format(bars.count)} stored daily bars, ${bars.firstDate} to ${bars.lastDate}${bars.collectedAt === null ? "" : `; collected ${bars.collectedAt}`}.`,
    check: checkView(data),
    fibonacci:
      data.fibonacci === null ? null : fibonacciView(data.fibonacci, prices),
    indicators: indicatorRows(data, prices),
    methodNote: `Method version ${method.version}. Pivots: 2 bars on each side, last ${method.pivotLookbackSessions} sessions. Fibonacci: high and low of the last ${method.fibonacciWindowSessions} sessions. Weinstein stage: ${method.weinstein.smaWeeks}-week SMA, ${method.weinstein.slopeWeeks}-week slope, flat within ${method.weinstein.flatBandPct}%, last ${method.weinstein.historyWeeks} complete weeks. Volume profile: ${method.volumeProfile.sessions} sessions, ${method.volumeProfile.bins} bins, ${method.volumeProfile.valueAreaPct}% value area, daily-bar approximation. The Weinstein and volume-profile rules are model-reasoned defaults without an archive source. Context only, not signals.`,
    pivots: data.pivots === null ? null : pivotsView(data.pivots, prices),
    revision: data.dataRevision.slice(0, 12),
    trendChecks: data.stored.trendChecks.map((check) => ({
      label: TREND_CHECK_LABELS[check.key],
      status:
        check.passed === null ? "unknown" : check.passed ? "pass" : "fail",
    })),
    volumeProfile:
      data.volumeProfile === null
        ? null
        : volumeProfileView(data.volumeProfile, prices),
    warnings: data.warnings,
    weinstein:
      weinstein === null
        ? null
        : {
            rows: [
              {
                detail: `Week ending ${weinstein.weekEnding}`,
                label: "Weekly close",
                value: prices.format(weinstein.weeklyClose),
              },
              {
                detail: `${signedPct(weinstein.sma30ChangePct)} over ${method.weinstein.slopeWeeks} weeks`,
                label: "30-week SMA",
                value: prices.format(weinstein.sma30),
              },
              {
                detail: null,
                label: "Complete weeks",
                value: grouped.format(weinstein.completeWeeks),
              },
            ],
            stage: weinstein.label,
          },
  };
};
