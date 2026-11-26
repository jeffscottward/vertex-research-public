import type {
  MarketRegimeOutput,
  RegimeBreadth90Pillar,
  RegimeCreditPillar,
  RegimeDealerGammaPillar,
  RegimeEtfRow,
  RegimeSummaryState,
  RegimeTrendPillar,
  RegimeVolatilityPillar,
} from "@darkfactory/api";

import type { MarketSourceStatus } from "../../components/portal/market-source-status.ts";

// Pure view model for the /markets regime section (marketRegime.get).
// Research context only; never emits trade signals or order actions.

export type RegimeBadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "info"
  | "destructive";

export interface RegimeBadge {
  readonly label: string;
  readonly tone: RegimeBadgeTone;
}

export interface RegimePillarCellView {
  readonly ageLabel: string | null;
  readonly asOf: string | null;
  readonly badge: RegimeBadge;
  readonly detail: string;
  readonly primary: string;
  readonly scopeLabel: "ETF" | "Market-wide";
  readonly secondary: string;
  readonly source: string;
  readonly stale: boolean;
}

export interface RegimeRowView {
  readonly breadth90: RegimePillarCellView;
  readonly credit: RegimePillarCellView;
  readonly dealerGamma: RegimePillarCellView;
  readonly hasStaleInputs: boolean;
  readonly mixedDrivers: readonly string[];
  readonly summary: RegimeBadge;
  readonly symbol: RegimeEtfRow["symbol"];
  readonly trend: RegimePillarCellView;
  readonly volatility: RegimePillarCellView;
}

const SUMMARY_BADGE: Readonly<Record<RegimeSummaryState, RegimeBadge>> = {
  incomplete: { label: "Incomplete", tone: "neutral" },
  mixed: { label: "Mixed", tone: "warning" },
  risk_off: { label: "Risk off", tone: "destructive" },
  risk_on: { label: "Risk on", tone: "success" },
};

const TREND_BADGE: Readonly<Record<RegimeTrendPillar["state"], RegimeBadge>> = {
  downtrend: { label: "Downtrend", tone: "destructive" },
  missing: { label: "No data", tone: "neutral" },
  mixed: { label: "Mixed", tone: "warning" },
  uptrend: { label: "Uptrend", tone: "success" },
};

const BREADTH_BADGE: Readonly<
  Record<RegimeBreadth90Pillar["state"], RegimeBadge>
> = {
  armed: { label: "Armed", tone: "warning" },
  fired: { label: "Fired", tone: "success" },
  forming: { label: "Forming", tone: "info" },
  idle: { label: "Idle", tone: "neutral" },
  missing: { label: "No data", tone: "neutral" },
};

const GAMMA_BADGE: Readonly<
  Record<RegimeDealerGammaPillar["state"], RegimeBadge>
> = {
  missing: { label: "No data", tone: "neutral" },
  negative: { label: "Negative", tone: "warning" },
  neutral: { label: "Neutral", tone: "neutral" },
  not_covered: { label: "No feed", tone: "neutral" },
  positive: { label: "Positive", tone: "success" },
};

const CREDIT_BADGE: Readonly<Record<RegimeCreditPillar["state"], RegimeBadge>> =
  {
    calm: { label: "Calm", tone: "success" },
    missing: { label: "No data", tone: "neutral" },
    stressed: { label: "Stressed", tone: "destructive" },
    widening: { label: "Widening", tone: "warning" },
  };

const VOL_BADGE: Readonly<
  Record<RegimeVolatilityPillar["state"], RegimeBadge>
> = {
  calm: { label: "Calm", tone: "success" },
  elevated: { label: "Elevated", tone: "warning" },
  extreme: { label: "Extreme", tone: "destructive" },
  missing: { label: "No data", tone: "neutral" },
};

const signedPct = (value: number | null): string =>
  value === null ? "missing" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

const signedBps = (value: number): string =>
  `${value > 0 ? "+" : ""}${value} bps`;

/** Human-readable elapsed age from seconds; null when age is unknown. */
export const formatRegimeAge = (ageSeconds: number | null): string | null => {
  if (ageSeconds === null) return null;
  if (ageSeconds < 60) return "<1m ago";
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 48 * 3600) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86_400)}d ago`;
};

export const summaryBadgeFor = (summary: RegimeSummaryState): RegimeBadge =>
  SUMMARY_BADGE[summary];

/** Maps a MarketRegimeOutput to the /markets page header source status. */
export const regimeSourceStatus = (
  data: MarketRegimeOutput
): MarketSourceStatus => {
  if (data.overall.missingPillarCount > 0) return "partial";
  if (data.overall.stalePillarCount > 0) return "stale";
  return "ready";
};

const scopeLabelFor = (scope: "etf" | "market_wide"): "ETF" | "Market-wide" =>
  scope === "etf" ? "ETF" : "Market-wide";

export const trendCellView = (
  pillar: RegimeTrendPillar
): RegimePillarCellView => ({
  ageLabel: formatRegimeAge(pillar.ageSeconds),
  asOf: pillar.asOf,
  badge: TREND_BADGE[pillar.state],
  detail: pillar.detail,
  primary: pillar.close === null ? "No price" : `$${pillar.close.toFixed(2)}`,
  scopeLabel: scopeLabelFor(pillar.scope),
  secondary:
    pillar.state === "missing"
      ? `${pillar.sessions} sessions`
      : `50d ${signedPct(pillar.pctVsSma50)} · 200d ${signedPct(pillar.pctVsSma200)}`,
  source: pillar.source,
  stale: pillar.stale,
});

export const breadthCellView = (
  pillar: RegimeBreadth90Pillar
): RegimePillarCellView => {
  const primary =
    pillar.latestUpPct === null
      ? (pillar.signalState ?? "No reading")
      : `${pillar.latestUpPct.toFixed(1)}% up-vol`;
  const secondary =
    pillar.armedOn === null
      ? pillar.latestKind === null
        ? "No recent session"
        : `${pillar.latestKind}${pillar.latestFinal === false ? " (intraday)" : ""}`
      : `Armed ${pillar.armedOn} (${pillar.sessionsLeft ?? 0} left)`;
  return {
    ageLabel: formatRegimeAge(pillar.ageSeconds),
    asOf: pillar.asOf,
    badge: BREADTH_BADGE[pillar.state],
    detail: pillar.detail,
    primary,
    scopeLabel: scopeLabelFor(pillar.scope),
    secondary,
    source: pillar.source,
    stale: pillar.stale,
  };
};

export const gammaCellView = (
  pillar: RegimeDealerGammaPillar
): RegimePillarCellView => {
  if (pillar.state === "not_covered") {
    return {
      ageLabel: null,
      asOf: null,
      badge: GAMMA_BADGE.not_covered,
      detail: pillar.detail,
      primary: "Not covered",
      scopeLabel: scopeLabelFor(pillar.scope),
      secondary: "SPY & QQQ only",
      source: pillar.source,
      stale: false,
    };
  }
  const primary =
    pillar.flip === null ? "No flip level" : `Flip ${pillar.flip.toFixed(2)}`;
  const spotPart =
    pillar.spot === null ? "No spot quote" : `Spot ${pillar.spot.toFixed(2)}`;
  const vsPart = pillar.spotVsFlip === null ? "" : ` (${pillar.spotVsFlip})`;
  return {
    ageLabel: formatRegimeAge(pillar.ageSeconds),
    asOf: pillar.asOf,
    badge: GAMMA_BADGE[pillar.state],
    detail: pillar.detail,
    primary,
    scopeLabel: scopeLabelFor(pillar.scope),
    secondary: `${spotPart}${vsPart}`,
    source: pillar.source,
    stale: pillar.stale,
  };
};

export const creditCellView = (
  pillar: RegimeCreditPillar
): RegimePillarCellView => {
  const primary =
    pillar.hyOas === null
      ? "No spread"
      : pillar.hyOasBps === null
        ? `${pillar.hyOas.toFixed(2)}%`
        : `${pillar.hyOas.toFixed(2)}% (${pillar.hyOasBps} bps)`;
  const parts: string[] = [];
  if (pillar.hyOasChange20dBps !== null) {
    parts.push(`20d ${signedBps(pillar.hyOasChange20dBps)}`);
  }
  if (pillar.igOas !== null) {
    parts.push(`IG ${pillar.igOas.toFixed(2)}%`);
  }
  return {
    ageLabel: formatRegimeAge(pillar.ageSeconds),
    asOf: pillar.asOf,
    badge: CREDIT_BADGE[pillar.state],
    detail: pillar.detail,
    primary,
    scopeLabel: scopeLabelFor(pillar.scope),
    secondary: parts.length > 0 ? parts.join(" · ") : "HY OAS",
    source: pillar.source,
    stale: pillar.stale,
  };
};

export const volatilityCellView = (
  pillar: RegimeVolatilityPillar
): RegimePillarCellView => {
  const primary =
    pillar.vix === null ? "No VIX" : `VIX ${pillar.vix.toFixed(2)}`;
  const parts: string[] = [];
  if (pillar.vixVix3m !== null) {
    parts.push(`${pillar.vixVix3m.toFixed(2)} ${pillar.termStructure}`);
  }
  if (pillar.etfVolIndex !== null && pillar.etfVolIndexId !== "VIX") {
    parts.push(`${pillar.etfVolIndexId} ${pillar.etfVolIndex.toFixed(1)}`);
  }
  return {
    ageLabel: formatRegimeAge(pillar.ageSeconds),
    asOf: pillar.asOf,
    badge: VOL_BADGE[pillar.state],
    detail: pillar.detail,
    primary,
    scopeLabel: scopeLabelFor(pillar.scope),
    secondary: parts.length > 0 ? parts.join(" · ") : "No term ratio",
    source: pillar.source,
    stale: pillar.stale,
  };
};

export const buildRegimeRowViews = (
  data: MarketRegimeOutput
): readonly RegimeRowView[] =>
  data.etfs.map((row) => ({
    breadth90: breadthCellView(row.breadth90),
    credit: creditCellView(row.credit),
    dealerGamma: gammaCellView(row.dealerGamma),
    hasStaleInputs: row.hasStaleInputs,
    mixedDrivers: row.mixedDrivers,
    summary: summaryBadgeFor(row.summary),
    symbol: row.symbol,
    trend: trendCellView(row.trend),
    volatility: volatilityCellView(row.volatility),
  }));
