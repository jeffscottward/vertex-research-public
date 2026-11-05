import type {
  AutopilotCampaignCreateInput,
  AutopilotCampaignOutput,
  AutopilotCandidateDetailOutput,
  AutopilotCandidateSummaryOutput,
  AutopilotGateOutput,
  BacktestRunSubmitInput,
  InstantBacktestSeries,
  SectorRotationQuadrant,
} from "@darkfactory/api";
import { SECTOR_ROTATION_QUADRANTS } from "@darkfactory/api";

import { readParam } from "./backtest-lab-query.ts";

// Autopilot view-model: pure formatting and request building for the Autopilot page. Research only.

export type AutopilotForm = Readonly<{
  name: string;
  seriesKey: string;
  populationSize: number;
  maxCandidates: number;
  maxCpuMinutes: number;
  tickSeconds: number;
  gatePerGeneration: number;
  costBps: number;
  seed: string;
  /** Sector ETF symbol for the optional weekly sector filter; "" means no filter. */
  filterSector: string;
  filterQuadrants: readonly SectorRotationQuadrant[];
}>;

export const DEFAULT_AUTOPILOT_FORM: AutopilotForm = {
  costBps: 5,
  filterQuadrants: ["leading", "improving"],
  filterSector: "",
  gatePerGeneration: 3,
  maxCandidates: 2000,
  maxCpuMinutes: 60,
  name: "",
  populationSize: 40,
  seed: "",
  seriesKey: "",
  tickSeconds: 20,
};

/** URL parameter that holds the selected campaign id. */
export const CAMPAIGN_PARAM = "campaign";

/** The row with the latest `dateOf`; ties keep the earlier row (the list is newest first). */
const latestBy = (
  campaigns: readonly AutopilotCampaignOutput[],
  dateOf: (campaign: AutopilotCampaignOutput) => Date
): AutopilotCampaignOutput | null =>
  campaigns.reduce<AutopilotCampaignOutput | null>(
    (best, row) =>
      best === null ||
      new Date(dateOf(row)).getTime() > new Date(dateOf(best)).getTime()
        ? row
        : best,
    null
  );

/** The campaign shown on open: the latest completed one, else the latest of any status. */
export const defaultCampaignId = (
  campaigns: readonly AutopilotCampaignOutput[]
): string | null => {
  const completed = latestBy(
    campaigns.filter((row) => row.status === "completed"),
    (row) => row.finishedAt ?? row.createdAt
  );
  return (completed ?? latestBy(campaigns, (row) => row.createdAt))?.id ?? null;
};

/** The listed campaign named in the `campaign` URL parameter, else the default one. */
export const campaignFromSearch = (
  search: string,
  campaigns: readonly AutopilotCampaignOutput[]
): string | null => {
  const requested = readParam(search, CAMPAIGN_PARAM);
  return (
    campaigns.find((row) => row.id === requested)?.id ??
    defaultCampaignId(campaigns)
  );
};

export const seriesKeyOf = (series: InstantBacktestSeries): string =>
  `${series.symbol}:${series.timeframe}`;

export const seriesLabel = (series: InstantBacktestSeries): string =>
  `${series.symbol} ${series.timeframe} (${series.barCount.toLocaleString("en-US")} bars)`;

type Built =
  | Readonly<{ ok: true; input: AutopilotCampaignCreateInput }>
  | Readonly<{ ok: false; message: string }>;

/** Builds the create request; the API checks the bounds again. */
export const toCampaignInput = (
  form: AutopilotForm,
  series: readonly InstantBacktestSeries[]
): Built => {
  const selected = series.find((item) => seriesKeyOf(item) === form.seriesKey);
  if (selected === undefined)
    return { message: "Choose a stored bar series.", ok: false };
  const seed = form.seed.trim();
  if (seed !== "" && !/^\d{1,9}$/u.test(seed))
    return { message: "The seed must be a whole number.", ok: false };
  if (form.filterSector !== "" && form.filterQuadrants.length === 0)
    return {
      message: "Choose at least one quadrant for the sector filter.",
      ok: false,
    };
  // Quadrants keep the fixed map order, whatever order they were checked in.
  const quadrants = SECTOR_ROTATION_QUADRANTS.filter((quadrant) =>
    form.filterQuadrants.includes(quadrant)
  );
  return {
    input: {
      budget: {
        gatePerGeneration: form.gatePerGeneration,
        maxCandidates: form.maxCandidates,
        maxCpuMinutes: form.maxCpuMinutes,
        populationSize: form.populationSize,
        tickSeconds: form.tickSeconds,
      },
      costBps: form.costBps,
      name:
        form.name.trim() === ""
          ? `${selected.symbol} ${selected.timeframe} campaign`
          : form.name.trim(),
      symbol: selected.symbol,
      timeframe: selected.timeframe,
      ...(seed === "" ? {} : { seed: Number(seed) }),
      ...(form.filterSector === ""
        ? {}
        : {
            filters: [
              {
                quadrants,
                sector: form.filterSector,
                timeframe: "weekly" as const,
                type: "sectorQuadrant" as const,
              },
            ],
          }),
    },
    ok: true,
  };
};

export const formatNumber = (value: number | null, digits = 2): string =>
  value === null ? "n/a" : value.toFixed(digits);

export const formatPercent = (value: number | null, digits = 1): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;

export const formatCpu = (ms: number): string =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(0)} s`
    : `${(ms / 60_000).toFixed(1)} min`;

export const CAMPAIGN_STATUS_LABELS: Readonly<
  Record<AutopilotCampaignOutput["status"], string>
> = {
  completed: "Completed",
  failed: "Failed",
  running: "Running",
  stopped: "Stopped",
};

export const CANDIDATE_STATUS_LABELS: Readonly<
  Record<AutopilotCandidateSummaryOutput["status"], string>
> = {
  evaluated: "In sample only",
  rejected: "Rejected",
  verified: "Verified",
};

export const ORIGIN_LABELS: Readonly<
  Record<AutopilotCandidateSummaryOutput["origin"], string>
> = {
  crossover: "Crossover",
  mutation: "Mutation",
  neighbour: "Neighbour",
  random: "Random",
};

/** "6 of 8 checks passed" for a gated candidate. */
export const checksSummary = (gate: AutopilotGateOutput | null): string => {
  if (gate === null) return "Not gated";
  const passed = gate.checks.filter((check) => check.passed).length;
  return `${passed} of ${gate.checks.length} checks passed`;
};

/** Budget use of a campaign as text, for example "120 of 2000 candidates". */
export const budgetSummary = (campaign: AutopilotCampaignOutput): string =>
  `${campaign.candidateCount.toLocaleString("en-US")} of ${campaign.config.budget.maxCandidates.toLocaleString("en-US")} candidates, ${formatCpu(campaign.cpuMs)} of ${campaign.config.budget.maxCpuMinutes} min CPU`;

export type CurveGeometry = Readonly<{ path: string; splitX: number | null }>;

/** SVG path of an equity curve and the x position of the in-sample / out-of-sample split. */
export const curveGeometry = (
  curve: AutopilotCandidateDetailOutput["curve"],
  splitT: string | null,
  width: number,
  height: number
): CurveGeometry => {
  if (curve.length < 2) return { path: "", splitX: null };
  const values = curve.map((point) => point.equity);
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const step = width / (curve.length - 1);
  const path = curve
    .map((point, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - ((point.equity - low) / span) * height).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  const splitIndex =
    splitT === null ? -1 : curve.findIndex((point) => point.t >= splitT);
  return { path, splitX: splitIndex < 0 ? null : splitIndex * step };
};

/** A full backtest run of the candidate's definition over the curve's date range. */
export const fullBacktestInput = (
  campaign: AutopilotCampaignOutput,
  detail: AutopilotCandidateDetailOutput
): BacktestRunSubmitInput | null => {
  const first = detail.curve[0];
  const last = detail.curve.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    costBps: campaign.config.costBps,
    from: first.t.slice(0, 10),
    rule: { definition: detail.definition, kind: "dsl" },
    symbol: campaign.symbol,
    timeframe: campaign.timeframe === "1m" ? "1m" : "1d",
    to: last.t.slice(0, 10),
  };
};
