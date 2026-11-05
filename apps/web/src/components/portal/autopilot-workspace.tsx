"use client";

import {
  type ApiClient,
  type AutopilotCampaignCreateInput,
  type AutopilotCampaignDetailOutput,
  type AutopilotCampaignOutput,
  type AutopilotCandidateDetailOutput,
  type AutopilotCandidateSummaryOutput,
  type BacktestRun,
  type BacktestRunSubmitInput,
  createApiClient,
  type DeploymentLimitsOutput,
  type InstantBacktestSeries,
  SECTOR_ROTATION_QUADRANTS,
  SECTOR_ROTATION_SECTORS,
} from "@darkfactory/api";
import {
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { CircleCheck, CircleX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";

import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  type AutopilotForm,
  budgetSummary,
  CAMPAIGN_PARAM,
  CAMPAIGN_STATUS_LABELS,
  CANDIDATE_STATUS_LABELS,
  campaignFromSearch,
  checksSummary,
  curveGeometry,
  DEFAULT_AUTOPILOT_FORM,
  defaultCampaignId,
  formatCpu,
  formatNumber,
  formatPercent,
  fullBacktestInput,
  ORIGIN_LABELS,
  seriesKeyOf,
  seriesLabel,
  toCampaignInput,
} from "./autopilot-model.ts";
import { currentSearch, writeQuery } from "./backtest-lab-query.ts";
import {
  DEFAULT_UNIVERSE_CHOICE,
  firstSeriesKey,
  UniverseSelect,
  visibleSeries,
} from "./backtest-universe.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";
import { NumberField } from "./number-field.tsx";

// Autopilot: start and stop breeding campaigns, follow the live leaderboard, read a candidate's
// tearsheet, gate checklist and lineage, and hand a verified candidate to the existing PAPER
// deployment-request flow. Research only. The page has no live path: "Request live" shows the
// master-rule and approval checks, and they always block.

const REFRESH_MS = 5000;
const CURVE_WIDTH = 960;
const CURVE_HEIGHT = 220;
const buttonClass =
  "min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60";
const secondaryClass =
  "min-h-11 rounded-md border px-4 font-medium text-sm disabled:opacity-60";
const linkButtonClass = "min-h-11 text-left underline";
const QUADRANT_LABELS = {
  improving: "Improving",
  lagging: "Lagging",
  leading: "Leading",
  weakening: "Weakening",
} as const;

export interface AutopilotGateway {
  readonly candidate: (id: string) => Promise<AutopilotCandidateDetailOutput>;
  readonly create: (
    input: AutopilotCampaignCreateInput
  ) => Promise<AutopilotCampaignOutput>;
  readonly get: (id: string) => Promise<AutopilotCampaignDetailOutput>;
  readonly list: () => Promise<readonly AutopilotCampaignOutput[]>;
  readonly sendToPaper: (
    id: string,
    limits: DeploymentLimitsOutput
  ) => Promise<Readonly<{ id: string; status: string }>>;
  readonly series: () => Promise<readonly InstantBacktestSeries[]>;
  readonly setStatus: (
    id: string,
    action: "start" | "stop"
  ) => Promise<AutopilotCampaignOutput>;
  readonly submitBacktest: (
    input: BacktestRunSubmitInput
  ) => Promise<BacktestRun>;
  readonly tick: (id: string) => Promise<void>;
}

export const createAutopilotGateway = (
  client: ApiClient
): AutopilotGateway => ({
  candidate: (id) => client.autopilot.candidates.get({ id }),
  create: (input) => client.autopilot.campaigns.create(input),
  get: (id) => client.autopilot.campaigns.get({ id }),
  list: async () => (await client.autopilot.campaigns.list({})).campaigns,
  sendToPaper: async (id, limits) =>
    (await client.autopilot.candidates.sendToPaper({ id, limits })).request,
  series: async () => (await client.instantBacktest.series()).series,
  setStatus: (id, action) =>
    client.autopilot.campaigns.setStatus({ action, id }),
  submitBacktest: (input) => client.backtestRuns.submit(input),
  tick: async (id) => {
    await client.autopilot.campaigns.tick({ id });
  },
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserAutopilotGateway = (): AutopilotGateway => {
  const current = () =>
    createAutopilotGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
  return {
    candidate: (id) => current().candidate(id),
    create: (input) => current().create(input),
    get: (id) => current().get(id),
    list: () => current().list(),
    sendToPaper: (id, limits) => current().sendToPaper(id, limits),
    series: () => current().series(),
    setStatus: (id, action) => current().setStatus(id, action),
    submitBacktest: (input) => current().submitBacktest(input),
    tick: (id) => current().tick(id),
  };
};

const messageOf = (error: unknown): string =>
  describeMarketDataFailure(error).message;

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      series: readonly InstantBacktestSeries[];
      campaigns: readonly AutopilotCampaignOutput[];
    }>;

const STATUS_TONE = {
  completed: "info",
  failed: "warning",
  running: "success",
  stopped: "neutral",
} as const;
const CANDIDATE_TONE = {
  evaluated: "neutral",
  rejected: "warning",
  verified: "success",
} as const;

const CampaignForm = ({
  series,
  onCreate,
}: Readonly<{
  series: readonly InstantBacktestSeries[];
  onCreate: (input: AutopilotCampaignCreateInput) => Promise<void>;
}>) => {
  const [universe, setUniverse] = useState(DEFAULT_UNIVERSE_CHOICE);
  const [form, setForm] = useState<AutopilotForm>({
    ...DEFAULT_AUTOPILOT_FORM,
    seriesKey: firstSeriesKey(series, DEFAULT_UNIVERSE_CHOICE),
  });
  const visible = visibleSeries(series, universe);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const seriesId = useId();
  const seedId = useId();
  const sectorId = useId();
  const update = (patch: Partial<AutopilotForm>) =>
    setForm({ ...form, ...patch });
  const submit = async () => {
    const built = toCampaignInput(form, series);
    if (!built.ok) {
      setMessage(built.message);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onCreate(built.input);
      setMessage("Campaign started. The scheduler ticks it every minute.");
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="New campaign"
      className="grid gap-4 rounded-md border p-4"
    >
      <h2 className="font-semibold text-lg">New campaign</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid min-w-0 gap-1">
          <label className="font-medium text-sm" htmlFor={nameId}>
            Name
          </label>
          <input
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={nameId}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="SPY daily campaign"
            value={form.name}
          />
        </div>
        <UniverseSelect
          fallback={visible.fallback}
          onChange={(choice) => {
            setUniverse(choice);
            update({ seriesKey: firstSeriesKey(series, choice) });
          }}
          storedSymbols={series.map((item) => item.symbol)}
          value={universe}
        />
        <div className="grid min-w-0 gap-1">
          <label className="font-medium text-sm" htmlFor={seriesId}>
            Bar series
          </label>
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={seriesId}
            onChange={(event) => update({ seriesKey: event.target.value })}
            value={form.seriesKey}
          >
            {visible.series.map((item) => (
              <option key={seriesKeyOf(item)} value={seriesKeyOf(item)}>
                {seriesLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <NumberField
          label="Population per generation"
          onChange={(value) => update({ populationSize: value })}
          value={form.populationSize}
        />
        <NumberField
          label="Maximum candidates"
          onChange={(value) => update({ maxCandidates: value })}
          value={form.maxCandidates}
        />
        <NumberField
          label="CPU budget (minutes)"
          onChange={(value) => update({ maxCpuMinutes: value })}
          value={form.maxCpuMinutes}
        />
        <NumberField
          label="Tick slice (seconds)"
          onChange={(value) => update({ tickSeconds: value })}
          value={form.tickSeconds}
        />
        <NumberField
          label="Gated per generation"
          onChange={(value) => update({ gatePerGeneration: value })}
          value={form.gatePerGeneration}
        />
        <NumberField
          label="Cost (bps per side)"
          onChange={(value) => update({ costBps: value })}
          step={0.5}
          value={form.costBps}
        />
        <div className="grid min-w-0 gap-1">
          <label className="font-medium text-sm" htmlFor={seedId}>
            Seed (optional)
          </label>
          <input
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={seedId}
            inputMode="numeric"
            onChange={(event) => update({ seed: event.target.value })}
            value={form.seed}
          />
        </div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="font-medium text-sm">
          Sector filter (optional)
        </legend>
        <p className="text-muted-foreground text-sm">
          Candidates enter only while the sector is in a checked quadrant of the
          weekly sector rotation map.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-0 gap-1">
            <label className="font-medium text-sm" htmlFor={sectorId}>
              Sector
            </label>
            <select
              className="min-h-11 rounded-md border bg-background px-3 text-sm"
              id={sectorId}
              onChange={(event) => update({ filterSector: event.target.value })}
              value={form.filterSector}
            >
              <option value="">None</option>
              {SECTOR_ROTATION_SECTORS.map((sector) => (
                <option key={sector.symbol} value={sector.symbol}>
                  {sector.symbol} {sector.name}
                </option>
              ))}
            </select>
          </div>
          {form.filterSector === "" ? null : (
            <fieldset className="flex flex-wrap items-end gap-3">
              <legend className="sr-only">Quadrants</legend>
              {SECTOR_ROTATION_QUADRANTS.map((quadrant) => (
                <label
                  className="flex min-h-11 items-center gap-2 text-sm"
                  key={quadrant}
                >
                  <input
                    checked={form.filterQuadrants.includes(quadrant)}
                    className="size-5"
                    onChange={(event) =>
                      update({
                        filterQuadrants: event.target.checked
                          ? [...form.filterQuadrants, quadrant]
                          : form.filterQuadrants.filter(
                              (value) => value !== quadrant
                            ),
                      })
                    }
                    type="checkbox"
                  />
                  {QUADRANT_LABELS[quadrant]}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={buttonClass}
          disabled={busy}
          onClick={submit}
          type="button"
        >
          Start campaign
        </button>
        {message === null ? null : (
          <p className="text-sm" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
};

const CampaignTable = ({
  campaigns,
  selectedId,
  onSelect,
}: Readonly<{
  campaigns: readonly AutopilotCampaignOutput[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}>) => (
  <section aria-label="Campaigns" className="grid gap-2">
    <h2 className="font-semibold text-lg">Campaigns</h2>
    {campaigns.length === 0 ? (
      <p className="text-muted-foreground text-sm">No campaigns yet.</p>
    ) : (
      <div className="overflow-x-auto">
        <Table className="w-full text-sm" data-click-private="">
          <TableHeader>
            <TableRow className="text-left text-muted-foreground">
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Campaign
              </TableHead>
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Series
              </TableHead>
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Generation
              </TableHead>
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Candidates
              </TableHead>
              <TableHead className="py-2 pr-4 text-muted-foreground">
                Verified
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((campaign) => (
              <TableRow
                aria-selected={campaign.id === selectedId}
                className="border-t"
                key={campaign.id}
              >
                <TableCell className="whitespace-normal py-1 pr-4">
                  <button
                    className={linkButtonClass}
                    onClick={() => onSelect(campaign.id)}
                    type="button"
                  >
                    {campaign.name}
                  </button>
                </TableCell>
                <TableCell className="whitespace-normal py-1 pr-4">
                  {campaign.symbol} {campaign.timeframe}
                </TableCell>
                <TableCell className="whitespace-normal py-1 pr-4">
                  <StatusBadge status={STATUS_TONE[campaign.status]}>
                    {CAMPAIGN_STATUS_LABELS[campaign.status]}
                  </StatusBadge>
                </TableCell>
                <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
                  {campaign.generation}
                </TableCell>
                <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
                  {campaign.candidateCount}
                </TableCell>
                <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
                  {campaign.verifiedCount}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </section>
);

const CandidateTable = ({
  caption,
  rows,
  onSelect,
}: Readonly<{
  caption: string;
  rows: readonly AutopilotCandidateSummaryOutput[];
  onSelect: (id: string) => void;
}>) => (
  <div className="overflow-x-auto">
    <Table className="w-full text-sm">
      <TableCaption className="mt-0 caption-top py-2 text-left font-semibold text-base text-foreground">
        {caption}
      </TableCaption>
      <TableHeader>
        <TableRow className="text-left text-muted-foreground">
          <TableHead className="py-2 pr-4 text-muted-foreground">#</TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Candidate
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Origin
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Gen.
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Fitness (IS)
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Trades (IS)
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Sharpe (OOS)
          </TableHead>
          <TableHead className="py-2 pr-4 text-muted-foreground">
            Gate
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow className="border-t" key={row.id}>
            <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
              {index + 1}
            </TableCell>
            <TableCell className="max-w-md whitespace-normal py-1 pr-4">
              <button
                className={`${linkButtonClass} break-all`}
                onClick={() => onSelect(row.id)}
                type="button"
              >
                {row.label}
              </button>
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4">
              {ORIGIN_LABELS[row.origin]}
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
              {row.generation}
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
              {formatNumber(row.fitness)}
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
              {row.inSample.trades}
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4 tabular-nums">
              {formatNumber(row.oosSharpe)}
            </TableCell>
            <TableCell className="whitespace-normal py-1 pr-4">
              <StatusBadge status={CANDIDATE_TONE[row.status]}>
                {CANDIDATE_STATUS_LABELS[row.status]}
              </StatusBadge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

const GateChecklist = ({
  detail,
}: Readonly<{ detail: AutopilotCandidateDetailOutput }>) => {
  const gate = detail.candidate.gate;
  if (gate === null)
    return (
      <p className="text-muted-foreground text-sm">
        Not gated. Only the best bred candidates of each generation go through
        the gate.
      </p>
    );
  return (
    <ul aria-label="Gate checklist" className="grid gap-2">
      {gate.checks.map((check) => (
        <li className="flex gap-3 rounded-md border p-3" key={check.id}>
          {check.passed ? (
            <CircleCheck
              aria-hidden="true"
              className="size-5 shrink-0 text-success-foreground"
            />
          ) : (
            <CircleX
              aria-hidden="true"
              className="size-5 shrink-0 text-destructive"
            />
          )}
          <div className="grid gap-1 text-sm">
            <p className="font-medium">
              {check.label}: {check.passed ? "pass" : "fail"}
            </p>
            <p className="text-muted-foreground">
              Value {formatNumber(check.value, 3)}; needs {check.threshold}.
            </p>
            <p>{check.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
};

const LIMIT_DEFAULTS: DeploymentLimitsOutput = {
  dailyLossLimit: 500,
  maxOrderSize: 10,
  maxOrdersPerMinute: 2,
  maxPosition: 10,
};

const PaperHandoff = ({
  detail,
  gateway,
  onSent,
}: Readonly<{
  detail: AutopilotCandidateDetailOutput;
  gateway: AutopilotGateway;
  onSent: () => void;
}>) => {
  const [limits, setLimits] = useState<DeploymentLimitsOutput>(LIMIT_DEFAULTS);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const { candidate } = detail;
  const canSend =
    candidate.status === "verified" && candidate.deploymentRequestId === null;
  const send = async () => {
    setBusy(true);
    try {
      const request = await gateway.sendToPaper(candidate.id, limits);
      setMessage(
        `Paper deployment request ${request.id} is ${request.status}. It waits for the owner's approval on Deployments.`
      );
      onSent();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Hand-off" className="grid gap-3">
      <h3 className="font-semibold text-base">Hand-off</h3>
      {candidate.deploymentRequestId === null ? null : (
        <p className="text-sm">
          Paper request{" "}
          <Link className="underline" href="/deployments" prefetch={false}>
            {candidate.deploymentRequestId}
          </Link>{" "}
          exists. Nothing is armed until the owner approves it and Quant VPS
          operators arm it.
        </p>
      )}
      {canSend ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="Max order size"
            onChange={(value) => setLimits({ ...limits, maxOrderSize: value })}
            value={limits.maxOrderSize}
          />
          <NumberField
            label="Max position"
            onChange={(value) => setLimits({ ...limits, maxPosition: value })}
            value={limits.maxPosition}
          />
          <NumberField
            label="Max orders per minute"
            onChange={(value) =>
              setLimits({ ...limits, maxOrdersPerMinute: value })
            }
            value={limits.maxOrdersPerMinute}
          />
          <NumberField
            label="Daily loss limit (USD)"
            onChange={(value) =>
              setLimits({ ...limits, dailyLossLimit: value })
            }
            value={limits.dailyLossLimit}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          className={buttonClass}
          disabled={!canSend || busy}
          onClick={send}
          type="button"
        >
          Send to paper
        </button>
        <button
          aria-expanded={showLive}
          className={secondaryClass}
          onClick={() => setShowLive(!showLive)}
          type="button"
        >
          Request live
        </button>
      </div>
      {canSend || candidate.status === "verified" ? null : (
        <p className="text-muted-foreground text-sm">
          Only a verified candidate can go to paper.
        </p>
      )}
      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
      {showLive ? (
        <div
          aria-label="Live readiness"
          className="grid gap-2 rounded-md border p-3"
          role="region"
        >
          <p className="font-medium text-sm">
            Live readiness: not allowed. Autopilot never requests or arms live
            trading.
          </p>
          <ul className="grid gap-1 text-sm">
            {detail.liveReadiness.checks.map((check) => (
              <li key={check.id}>
                <span className="font-medium">
                  {check.label}: {check.status === "pass" ? "pass" : "conflict"}
                  .
                </span>{" "}
                {check.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};

const Tearsheet = ({
  campaign,
  detail,
  gateway,
  onSelect,
  onChanged,
}: Readonly<{
  campaign: AutopilotCampaignOutput;
  detail: AutopilotCandidateDetailOutput;
  gateway: AutopilotGateway;
  onSelect: (id: string) => void;
  onChanged: () => void;
}>) => {
  const [run, setRun] = useState<string | null>(null);
  const { candidate } = detail;
  const gate = candidate.gate;
  const geometry = curveGeometry(
    detail.curve,
    gate?.splitT ?? null,
    CURVE_WIDTH,
    CURVE_HEIGHT
  );
  const backtest = fullBacktestInput(campaign, detail);
  const submit = async (input: BacktestRunSubmitInput) => {
    try {
      const queued = await gateway.submitBacktest(input);
      setRun(queued.id);
    } catch (error) {
      setRun(`failed: ${messageOf(error)}`);
    }
  };
  const metrics = [
    ["Fitness (in sample)", formatNumber(candidate.fitness)],
    ["Sharpe (in sample)", formatNumber(candidate.inSample.sharpe)],
    ["Return (in sample)", formatPercent(candidate.inSample.totalReturn)],
    ["Max drawdown (in sample)", formatPercent(candidate.inSample.maxDrawdown)],
    ["Trades (in sample)", String(candidate.inSample.trades)],
    ["Sharpe (out of sample)", formatNumber(gate?.oos.sharpe ?? null)],
    ["Return (out of sample)", formatPercent(gate?.oos.totalReturn ?? null)],
    [
      "Max drawdown (out of sample)",
      formatPercent(gate?.oos.maxDrawdown ?? null),
    ],
    [
      "Deflated Sharpe probability",
      formatNumber(gate?.deflatedSharpe?.probability ?? null, 3),
    ],
    ["Trials on the series", String(gate?.deflatedSharpe?.trials ?? "n/a")],
    [
      "Monte Carlo P(profit)",
      formatNumber(gate?.monteCarlo?.probabilityOfProfit ?? null),
    ],
  ] as const;
  return (
    <section
      aria-label="Candidate tearsheet"
      className="grid gap-4 rounded-md border p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="break-all font-semibold text-lg">{candidate.label}</h2>
        <StatusBadge status={CANDIDATE_TONE[candidate.status]}>
          {CANDIDATE_STATUS_LABELS[candidate.status]}
        </StatusBadge>
      </div>
      <p className="text-muted-foreground text-sm">
        {ORIGIN_LABELS[candidate.origin]} in generation {candidate.generation}.{" "}
        {checksSummary(gate)}.
      </p>
      {geometry.path === "" ? null : (
        <svg
          aria-label="Equity curve; the line marks the start of the out-of-sample period"
          className="h-auto w-full rounded-md border bg-background"
          role="img"
          viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
        >
          <path
            d={geometry.path}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.5}
          />
          {geometry.splitX === null ? null : (
            <line
              stroke="var(--vx-gold)"
              strokeDasharray="4 4"
              x1={geometry.splitX}
              x2={geometry.splitX}
              y1={0}
              y2={CURVE_HEIGHT}
            />
          )}
        </svg>
      )}
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(([label, value]) => (
          <div className="flex justify-between gap-4 border-b py-1" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="font-semibold text-base">Gate checklist</h3>
      <GateChecklist detail={detail} />
      <section aria-label="Lineage" className="grid gap-2 text-sm">
        <h3 className="font-semibold text-base">Lineage</h3>
        <p>
          Parents:{" "}
          {detail.parents.length === 0
            ? "none (random genome)"
            : detail.parents.map((parent) => (
                <button
                  className={`${linkButtonClass} mr-3 break-all`}
                  key={parent.id}
                  onClick={() => onSelect(parent.id)}
                  type="button"
                >
                  {parent.label}
                </button>
              ))}
        </p>
        <p>
          Children:{" "}
          {detail.children.length === 0
            ? "none yet"
            : detail.children.map((child) => (
                <button
                  className={`${linkButtonClass} mr-3 break-all`}
                  key={child.id}
                  onClick={() => onSelect(child.id)}
                  type="button"
                >
                  {child.label} ({ORIGIN_LABELS[child.origin]})
                </button>
              ))}
        </p>
      </section>
      <details>
        <summary className="min-h-11 cursor-pointer content-center font-medium text-sm">
          Strategy definition (JSON)
        </summary>
        <pre className="overflow-x-auto rounded-md border p-3 text-xs">
          {JSON.stringify(detail.definition, null, 2)}
        </pre>
      </details>
      {detail.nautilus === null ? null : (
        <details>
          <summary className="min-h-11 cursor-pointer content-center font-medium text-sm">
            Nautilus paper config ({detail.nautilus.format})
          </summary>
          <p className="py-2 text-muted-foreground text-sm">
            {detail.nautilus.note}
          </p>
          <pre className="overflow-x-auto rounded-md border p-3 text-xs">
            {JSON.stringify(detail.nautilus, null, 2)}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {backtest === null ? null : (
          <button
            className={secondaryClass}
            onClick={() => void submit(backtest)}
            type="button"
          >
            Run full backtest
          </button>
        )}
        {run === null ? null : run.startsWith("failed: ") ? (
          <p className="text-sm" role="status">
            {run.slice(8)}
          </p>
        ) : (
          <Link
            className="text-sm underline"
            href={`/backtest-runs?run=${run}`}
            prefetch={false}
          >
            Open backtest run {run}
          </Link>
        )}
      </div>
      <PaperHandoff detail={detail} gateway={gateway} onSent={onChanged} />
    </section>
  );
};

const CampaignDetail = ({
  detail,
  gateway,
  onChanged,
  onSelectCandidate,
}: Readonly<{
  detail: AutopilotCampaignDetailOutput;
  gateway: AutopilotGateway;
  onChanged: () => Promise<void>;
  onSelectCandidate: (id: string) => void;
}>) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { campaign } = detail;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await onChanged();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const rows = [
    ["Status", CAMPAIGN_STATUS_LABELS[campaign.status]],
    ["Generation", String(campaign.generation)],
    ["Budget", budgetSummary(campaign)],
    ["Gated", String(campaign.gatedCount)],
    ["Verified", String(campaign.verifiedCount)],
    ["Trials on the series (all campaigns)", String(detail.seriesTrials)],
    ["Best fitness (in sample)", formatNumber(campaign.bestFitness)],
    ["Cost", `${campaign.config.costBps} bps per side`],
    ["CPU used", formatCpu(campaign.cpuMs)],
  ] as const;
  return (
    <section aria-label="Campaign" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-lg">{campaign.name}</h2>
        <StatusBadge status={STATUS_TONE[campaign.status]}>
          {CAMPAIGN_STATUS_LABELS[campaign.status]}
        </StatusBadge>
      </div>
      {campaign.note === null ? null : (
        <p className="text-sm">{campaign.note}</p>
      )}
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div className="flex justify-between gap-4 border-b py-1" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-3">
        {campaign.status === "running" ? (
          <>
            <button
              className={secondaryClass}
              disabled={busy}
              onClick={() => act(() => gateway.setStatus(campaign.id, "stop"))}
              type="button"
            >
              Stop campaign
            </button>
            <button
              className={secondaryClass}
              disabled={busy}
              onClick={() => act(() => gateway.tick(campaign.id))}
              type="button"
            >
              Run one tick now
            </button>
          </>
        ) : null}
        {campaign.status === "stopped" ? (
          <button
            className={secondaryClass}
            disabled={busy}
            onClick={() => act(() => gateway.setStatus(campaign.id, "start"))}
            type="button"
          >
            Start campaign
          </button>
        ) : null}
      </div>
      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
      <CandidateTable
        caption="Leaderboard (best in-sample fitness)"
        onSelect={onSelectCandidate}
        rows={detail.leaderboard}
      />
      <CandidateTable
        caption="Gated candidates (verified first, then the latest rejections)"
        onSelect={onSelectCandidate}
        rows={detail.gated}
      />
    </section>
  );
};

export const AutopilotWorkspace = ({
  gateway,
}: Readonly<{ gateway?: AutopilotGateway }>) => {
  const [api] = useState(() => gateway ?? createBrowserAutopilotGateway());
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutopilotCampaignDetailOutput | null>(
    null
  );
  const [candidate, setCandidate] =
    useState<AutopilotCandidateDetailOutput | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);

  // `search` is read once on open; later reloads keep the current selection.
  const reload = useCallback(
    async (search = "") => {
      try {
        const [series, campaigns] = await Promise.all([
          api.series(),
          api.list(),
        ]);
        setLoad({ campaigns, series, type: "ready" });
        setSelected(
          (current) => current ?? campaignFromSearch(search, campaigns)
        );
      } catch (error) {
        setLoad(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : { message: messageOf(error), type: "error" }
        );
      }
    },
    [api]
  );

  const refreshDetail = useCallback(async () => {
    if (selected === null) return;
    try {
      setDetail(await api.get(selected));
    } catch (error) {
      setCandidateError(messageOf(error));
    }
  }, [api, selected]);

  useEffect(() => {
    void reload(currentSearch());
  }, [reload]);
  // The selection lives in the address bar; the default campaign keeps a clean URL.
  useEffect(() => {
    if (load.type !== "ready") return;
    writeQuery(
      { [CAMPAIGN_PARAM]: selected },
      { [CAMPAIGN_PARAM]: defaultCampaignId(load.campaigns) }
    );
  }, [load, selected]);
  useEffect(() => {
    void refreshDetail();
  }, [refreshDetail]);
  useEffect(() => {
    if (detail?.campaign.status !== "running") return;
    const timer = setInterval(() => void refreshDetail(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [detail?.campaign.status, refreshDetail]);

  const selectCandidate = async (id: string) => {
    setCandidateError(null);
    try {
      setCandidate(await api.candidate(id));
    } catch (error) {
      setCandidateError(messageOf(error));
    }
  };

  if (load.type === "loading")
    return <p className="text-muted-foreground text-sm">Loading Autopilot…</p>;
  if (load.type === "forbidden")
    return <OperatorAccessRequired feature="autopilot" />;
  if (load.type === "error")
    return (
      <p className="text-sm" role="alert">
        {load.message}
      </p>
    );
  return (
    <div className="grid gap-8">
      <p className="max-w-3xl text-muted-foreground text-sm">
        Research only. Every candidate counts as a trial for the deflated Sharpe
        ratio. Autopilot never arms or requests live trading.{" "}
        <Link className="underline" href="/optimizations" prefetch={false}>
          Optimizations
        </Link>
      </p>
      <CampaignForm
        onCreate={async (input) => {
          const created = await api.create(input);
          setSelected(created.id);
          await reload();
        }}
        series={load.series}
      />
      <CampaignTable
        campaigns={load.campaigns}
        onSelect={(id) => {
          setSelected(id);
          setCandidate(null);
        }}
        selectedId={selected}
      />
      {candidateError === null ? null : (
        <p className="text-sm" role="alert">
          {candidateError}
        </p>
      )}
      {detail === null ? null : (
        <CampaignDetail
          detail={detail}
          gateway={api}
          onChanged={async () => {
            await refreshDetail();
            await reload();
          }}
          onSelectCandidate={(id) => void selectCandidate(id)}
        />
      )}
      {candidate === null || detail === null ? null : (
        <Tearsheet
          campaign={detail.campaign}
          detail={candidate}
          gateway={api}
          onChanged={() => void selectCandidate(candidate.candidate.id)}
          onSelect={(id) => void selectCandidate(id)}
        />
      )}
    </div>
  );
};
