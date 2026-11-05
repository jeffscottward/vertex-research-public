"use client";

import type {
  OptimizationGetOutput,
  OptimizationRunOutput,
} from "@darkfactory/api";
import {
  Button,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { InfoGlyph, formatTimestamp } from "./agent-ops-client.tsx";
import {
  METHOD_LABELS,
  OPTIMIZATION_TAB_LABELS,
  STOP_REASON_LABELS,
  TRIAL_ROWS_SHOWN,
  VALIDATION_LABELS,
  availableTabs,
  finiteRange,
  formatBinRange,
  formatMarkets,
  formatMetricMap,
  formatParamValue,
  formatProbability,
  formatScore,
  heatClass,
  paramsJson,
  sortTrials,
  tabKeyTarget,
  type OptimizationTab,
  type TrialOrder,
  type TrialStatusFilter,
} from "./optimizations-model.ts";

type Run = OptimizationRunOutput;
type Params = Run["trials"][number]["params"];
type OosReport = NonNullable<NonNullable<Run["oos"]>["selected"]>;
type Diagnostics = NonNullable<Run["diagnostics"]>;

// TableCell defaults to whitespace-nowrap; text cells (params, metrics, reasons) wrap as before.
const cell = "py-1 pr-3 whitespace-normal";
const headCell = "py-1 pr-3 font-normal";
// TableHead sets text-foreground on the cell, so column headers restate the muted colour.
const columnHeadCell = `${headCell} text-muted-foreground`;
const numCell = "py-1 pr-3 text-right font-mono";
const selectClass =
  "h-11 rounded-sm border border-border-strong bg-surface px-2 text-sm";

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-muted-foreground text-xs">{children}</p>
);

const SectionTitle = ({
  id,
  children,
  help,
}: {
  readonly id: string;
  readonly children: ReactNode;
  readonly help?: string;
}) => (
  <h3 className="font-medium text-sm" id={id}>
    {children}
    {help === undefined ? null : <InfoGlyph text={help} />}
  </h3>
);

const Stat = ({
  label,
  value,
  help,
}: {
  readonly label: string;
  readonly value: string;
  readonly help?: string;
}) => (
  <div
    className="min-w-0 rounded-md border border-border px-3 py-2"
    data-stat={label}
  >
    <dt className="truncate text-muted-foreground text-xs">
      {label}
      {help === undefined ? null : <InfoGlyph text={help} />}
    </dt>
    <dd className="break-words font-mono text-sm">{value}</dd>
  </div>
);

const paramNames = (
  rows: readonly Readonly<{ params: Params }>[]
): string[] => {
  const names = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row.params)) names.add(name);
  }
  return [...names].sort();
};

const formatParams = (params: Params | null): string => {
  return params === null
    ? "—"
    : Object.entries(params)
        .map(([key, value]) => `${key}=${formatParamValue(value)}`)
        .join(", ") || "—";
};

const validationParamsText = (
  params: Readonly<Record<string, number | boolean | undefined>>
): string => {
  return (
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ") || "—"
  );
};

const objectiveText = (run: Run): string => {
  return run.objectives
    .map(
      (objective) =>
        `${objective.metric} (${objective.direction === "maximize" ? "max" : "min"})`
    )
    .join(", ");
};

// ---------------------------------------------------------------------------
// Overview

const CopyJson = ({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}) => {
  const [status, setStatus] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      return setStatus("Copied");
    } catch {
      return setStatus("Copy failed; select the text instead");
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-label={label}
          onClick={() => void copy()}
          type="button"
          variant="secondary"
        >
          Copy JSON
        </Button>
        <span
          aria-live="polite"
          className="text-muted-foreground text-xs"
          role="status"
        >
          {status ?? ""}
        </span>
      </div>
      <pre
        className="max-h-64 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs"
        data-best-json=""
      >
        {text}
      </pre>
    </div>
  );
};

const BestParams = ({ run }: { readonly run: Run }) => {
  const best = run.best;
  return (
    <section aria-labelledby="optimization-best-heading" className="space-y-2">
      <SectionTitle
        help="Parameters of the selected trial as recorded. Walk-forward runs report the last fold's choice."
        id="optimization-best-heading"
      >
        Best parameters
      </SectionTitle>
      {best === null ? (
        <Empty>
          {run.method === "pareto"
            ? "Pareto runs report a front instead of one best trial."
            : "No successful trial."}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-x-auto">
            <Table className="w-full text-xs" data-best-params="">
              <TableCaption className="sr-only">Best parameters</TableCaption>
              <TableHeader>
                <TableRow className="border-border border-b text-left text-muted-foreground">
                  <TableHead className={columnHeadCell} scope="col">
                    Parameter
                  </TableHead>
                  <TableHead className={columnHeadCell} scope="col">
                    Value
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(best.params).map(([key, value]) => {
                  return (
                    <TableRow className="border-border border-b" key={key}>
                      <TableHead
                        className={`${headCell} font-mono`}
                        scope="row"
                      >
                        {key}
                      </TableHead>
                      <TableCell className={`${cell} font-mono`}>
                        {formatParamValue(value)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <CopyJson
            label="Copy best parameters as JSON"
            text={paramsJson(best.params)}
          />
        </div>
      )}
    </section>
  );
};

const OosRow = ({
  label,
  report,
}: {
  readonly label: string;
  readonly report: OosReport;
}) => (
  <TableRow className="border-border border-b" data-oos-row={label}>
    <TableHead className={headCell} scope="row">
      {label}
    </TableHead>
    <TableCell className={numCell}>{report.trialIndex}</TableCell>
    <TableCell className={`${cell} font-mono`}>
      {formatParams(report.params)}
    </TableCell>
    <TableCell className={numCell}>
      {formatScore(report.inSampleScore)}
    </TableCell>
    <TableCell className={numCell}>{formatScore(report.score)}</TableCell>
    <TableCell className={numCell}>{formatScore(report.degradation)}</TableCell>
    <TableCell className={cell}>
      {report.status}
      {report.reason === undefined ? "" : ` · ${report.reason}`}
    </TableCell>
  </TableRow>
);

const OosHead = () => (
  <TableHeader>
    <TableRow className="border-border border-b text-left text-muted-foreground">
      <TableHead className={columnHeadCell} scope="col">
        Row
      </TableHead>
      <TableHead
        className={`${headCell} text-right text-muted-foreground`}
        scope="col"
      >
        Trial
      </TableHead>
      <TableHead className={columnHeadCell} scope="col">
        Params
      </TableHead>
      <TableHead
        className={`${headCell} text-right text-muted-foreground`}
        scope="col"
      >
        IS score
      </TableHead>
      <TableHead
        className={`${headCell} text-right text-muted-foreground`}
        scope="col"
      >
        OOS score
      </TableHead>
      <TableHead
        className={`${headCell} text-right text-muted-foreground`}
        scope="col"
      >
        Degradation
        <InfoGlyph text="OOS score minus IS score, oriented so negative means worse out of sample." />
      </TableHead>
      <TableHead className={columnHeadCell} scope="col">
        Status
      </TableHead>
    </TableRow>
  </TableHeader>
);

const windowText = (
  window: Readonly<{ start: number; end: number }> | undefined
): string => {
  return window === undefined ? "—" : `[${window.start}, ${window.end})`;
};

const OosReportSection = ({ run }: { readonly run: Run }) => {
  const oos = run.oos;
  return (
    <section aria-labelledby="optimization-oos-heading" className="space-y-2">
      <SectionTitle
        help="Out-of-sample evaluation as recorded: IS/OOS re-runs the top in-sample trials on the held-out window; walk-forward stitches each fold's out-of-sample metrics."
        id="optimization-oos-heading"
      >
        Out-of-sample report
      </SectionTitle>
      {oos === null ? (
        <Empty>
          No out-of-sample report (
          {VALIDATION_LABELS[run.validation.mode] ?? run.validation.mode}{" "}
          validation).
        </Empty>
      ) : oos.mode === "is_oos" ? (
        <>
          <p className="font-mono text-xs" data-oos-windows="">
            IS {windowText(oos.inSample)} · OOS {windowText(oos.outOfSample)}{" "}
            bars
            {oos.reason === null || oos.reason === undefined
              ? ""
              : ` · ${oos.reason}`}
          </p>
          {(oos.topK ?? []).length === 0 &&
          (oos.selected === null || oos.selected === undefined) ? (
            <Empty>No out-of-sample rows.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table className="w-full min-w-[40rem] text-xs" data-oos-table="">
                <TableCaption className="sr-only">
                  Out-of-sample results
                </TableCaption>
                <OosHead />
                <TableBody>
                  {oos.selected === null ||
                  oos.selected === undefined ? null : (
                    <OosRow label="Selected" report={oos.selected} />
                  )}
                  {(oos.topK ?? []).map((report, index) => {
                    return (
                      <OosRow
                        key={`${report.trialIndex}-${index}`}
                        label={`Top ${index + 1}`}
                        report={report}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-xs" data-stitched-score="">
            <span className="text-muted-foreground">Stitched OOS score</span>
            <span className="ml-2 font-mono">
              {formatScore(oos.stitchedScore)}
            </span>
            {(oos.droppedMarkets ?? []).length === 0 ? null : (
              <span className="ml-2 text-muted-foreground">
                dropped: {(oos.droppedMarkets ?? []).join(", ")}
              </span>
            )}
            {oos.reason === null || oos.reason === undefined ? null : (
              <span className="ml-2 text-muted-foreground">{oos.reason}</span>
            )}
          </p>
          {Object.keys(oos.stitchedMetrics ?? {}).length === 0 ? (
            <Empty>No stitched metrics.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table className="w-full text-xs" data-stitched-table="">
                <TableCaption className="sr-only">
                  Stitched out-of-sample metrics by market
                </TableCaption>
                <TableHeader>
                  <TableRow className="border-border border-b text-left text-muted-foreground">
                    <TableHead className={columnHeadCell} scope="col">
                      Market
                    </TableHead>
                    <TableHead className={columnHeadCell} scope="col">
                      Metrics
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(oos.stitchedMetrics ?? {}).map(
                    ([market, metrics]) => {
                      return (
                        <TableRow
                          className="border-border border-b"
                          key={market}
                        >
                          <TableHead className={headCell} scope="row">
                            {market}
                          </TableHead>
                          <TableCell className={`${cell} font-mono`}>
                            {formatMetricMap(metrics, 12)}
                          </TableCell>
                        </TableRow>
                      );
                    }
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export const DSR_HELP =
  "Deflated Sharpe ratio (Bailey and López de Prado 2014): probability that the best trial's Sharpe exceeds the expected maximum Sharpe of this many unskilled trials, adjusted for skew and kurtosis. Higher is better.";
export const PBO_HELP =
  "Probability of backtest overfitting (CSCV, Bailey et al. 2017): share of half-sample splits where the in-sample best trial ranks at or below the median out of sample. Lower is better.";

const DiagnosticsBlock = ({
  diagnostics,
  idPrefix,
}: {
  readonly diagnostics: Diagnostics | null;
  readonly idPrefix: string;
}) => {
  if (diagnostics === null) return <Empty>No diagnostics recorded.</Empty>;
  const dsr = diagnostics.deflatedSharpe;
  const pbo = diagnostics.pbo;
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-diagnostics={idPrefix}>
      <div className="space-y-1">
        <SectionTitle help={DSR_HELP} id={`${idPrefix}-dsr`}>
          Deflated Sharpe
        </SectionTitle>
        {dsr === null ? (
          <Empty>
            {diagnostics.deflatedSharpeReason ?? "No reason recorded."}
          </Empty>
        ) : (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat
              label="Probability"
              value={formatProbability(dsr.probability)}
            />
            <Stat
              help="Best trial's Sharpe per observation (not annualized)."
              label="Sharpe"
              value={formatScore(dsr.sharpe)}
            />
            <Stat
              help="Expected maximum Sharpe of N unskilled trials with the observed Sharpe variance."
              label="Expected max"
              value={formatScore(dsr.expectedMaxSharpe)}
            />
            <Stat label="z" value={formatScore(dsr.z)} />
            <Stat
              help="Distinct successful trials counted."
              label="Trials"
              value={String(dsr.nTrials)}
            />
            <Stat label="Observations" value={String(dsr.nObservations)} />
          </dl>
        )}
      </div>
      <div className="space-y-1">
        <SectionTitle help={PBO_HELP} id={`${idPrefix}-pbo`}>
          PBO
        </SectionTitle>
        {pbo === null ? (
          <Empty>{diagnostics.pboReason ?? "No reason recorded."}</Empty>
        ) : (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="PBO" value={formatProbability(pbo.pbo)} />
            <Stat label="Trials" value={String(pbo.nTrials)} />
            <Stat label="Partitions" value={String(pbo.nPartitions)} />
            <Stat label="Combinations" value={String(pbo.nCombinations)} />
            <Stat label="Periods used" value={String(pbo.nPeriodsUsed)} />
            <Stat label="Metric" value={pbo.metric} />
          </dl>
        )}
      </div>
    </div>
  );
};

const MarketRanking = ({ run }: { readonly run: Run }) => {
  if (run.marketRanking.length === 0) return null;
  return (
    <section
      aria-labelledby="optimization-markets-heading"
      className="space-y-2"
    >
      <SectionTitle
        help="Market-only mode: default parameters run once per market, ranked by the objective."
        id="optimization-markets-heading"
      >
        Market ranking
      </SectionTitle>
      <div className="overflow-x-auto">
        <Table className="w-full text-xs" data-market-ranking="">
          <TableCaption className="sr-only">Market ranking</TableCaption>
          <TableHeader>
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Rank
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Market
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                {run.objectives[0]?.metric ?? "Value"}
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Status
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.marketRanking.map((row) => {
              return (
                <TableRow className="border-border border-b" key={row.market}>
                  <TableCell className={numCell}>{row.rank ?? "—"}</TableCell>
                  <TableHead className={headCell} scope="row">
                    {row.market}
                  </TableHead>
                  <TableCell className={numCell}>
                    {formatScore(row.value)}
                  </TableCell>
                  <TableCell className={cell}>
                    {row.status}
                    {row.reason === undefined ? "" : ` · ${row.reason}`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
};

const OverviewPanel = ({
  detail,
}: {
  readonly detail: OptimizationGetOutput;
}) => {
  const { optimization: run, task } = detail;
  const { analytics } = run;
  return (
    <>
      <dl
        aria-label="Run summary"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      >
        <Stat
          help={`Robust score across markets (mean minus a dispersion penalty). Direction: ${analytics.direction}.`}
          label="Best score"
          value={formatScore(run.best?.score)}
        />
        <Stat
          label={run.objectives.length > 1 ? "Objectives" : "Objective"}
          value={objectiveText(run)}
        />
        <Stat label="Seed" value={run.seed === null ? "—" : String(run.seed)} />
        <Stat
          label="Stop reason"
          value={STOP_REASON_LABELS[run.stopReason] ?? run.stopReason}
        />
        <Stat
          help="Stored trial rows of the total the optimizer ran, and how many succeeded."
          label="Trials"
          value={`${analytics.trials.stored} / ${run.trialCount} · ${analytics.trials.ok} ok`}
        />
        <Stat
          label="Validation"
          value={VALIDATION_LABELS[run.validation.mode] ?? run.validation.mode}
        />
      </dl>
      <BestParams run={run} />
      <OosReportSection run={run} />
      <section
        aria-labelledby="optimization-diagnostics-heading"
        className="space-y-2"
      >
        <SectionTitle
          help="Overfitting diagnostics computed by the optimizer and recorded with the run. Walk-forward runs report them per fold; the run-level deflated Sharpe counts the trials of every fold."
          id="optimization-diagnostics-heading"
        >
          Diagnostics
        </SectionTitle>
        <DiagnosticsBlock diagnostics={run.diagnostics} idPrefix="run" />
      </section>
      <MarketRanking run={run} />
      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs"
        data-click-private=""
      >
        <dt className="text-muted-foreground">Task</dt>
        <dd>
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-2"
            href={`/agents?task=${encodeURIComponent(run.taskId)}`}
          >
            {task?.title ?? run.taskId}
          </a>
          {task === null ? null : (
            <span className="text-muted-foreground">
              {" "}
              · {task.status} · {task.agent}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Strategy</dt>
        <dd>
          {run.strategyId === null ? (
            "—"
          ) : (
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-2"
              href={`/library?id=${encodeURIComponent(run.strategyId)}`}
            >
              {run.strategyName ?? run.strategyId}
            </a>
          )}
        </dd>
        <dt className="text-muted-foreground">Markets</dt>
        <dd className="break-words font-mono">{run.markets.join(", ")}</dd>
        <dt className="text-muted-foreground">Validation params</dt>
        <dd className="break-words font-mono">
          {validationParamsText(run.validation.params)}
        </dd>
        {run.notes === null ? null : (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{run.notes}</dd>
          </>
        )}
      </dl>
    </>
  );
};

// ---------------------------------------------------------------------------
// Trials

const ORDER_CYCLE: Readonly<Record<TrialOrder, TrialOrder>> = Object.freeze({
  best: "worst",
  worst: "index",
  index: "best",
});
const ORDER_LABELS: Readonly<Record<TrialOrder, string>> = Object.freeze({
  best: "best first",
  worst: "worst first",
  index: "by trial number",
});

const TrialsPanel = ({ run }: { readonly run: Run }) => {
  const [order, setOrder] = useState<TrialOrder>("best");
  const [status, setStatus] = useState<TrialStatusFilter>("all");
  const names = useMemo(() => paramNames(run.trials), [run.trials]);
  const rows = useMemo(
    () => sortTrials(run.trials, run.analytics.direction, order, status),
    [run.trials, run.analytics.direction, order, status]
  );
  const shown = rows.slice(0, TRIAL_ROWS_SHOWN);
  const walkForward = run.validation.mode === "walk_forward";
  const ariaSort =
    order === "index"
      ? "none"
      : (order === "best") === (run.analytics.direction === "maximize")
        ? "descending"
        : "ascending";
  return (
    <section
      aria-labelledby="optimization-trials-heading"
      className="space-y-2"
    >
      <SectionTitle
        help={`Trials as recorded. Score is the robust objective (${run.analytics.direction}); Pareto runs list objective values instead.`}
        id="optimization-trials-heading"
      >
        Trials
      </SectionTitle>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Status</span>
          <select
            aria-label="Trial status filter"
            className={selectClass}
            onChange={(event) =>
              setStatus(event.target.value as TrialStatusFilter)
            }
            value={status}
          >
            <option value="all">All</option>
            <option value="ok">OK</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <p className="text-muted-foreground text-xs" data-trial-count="">
          {rows.length > TRIAL_ROWS_SHOWN
            ? `First ${TRIAL_ROWS_SHOWN} of ${rows.length} trials`
            : `${rows.length} trials`}
          {run.trialCount > run.trials.length
            ? ` · ${run.trials.length} of ${run.trialCount} stored`
            : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <Empty>No trials match.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[40rem] text-xs" data-trials-table="">
            <TableCaption className="sr-only">
              Optimizer trials, {ORDER_LABELS[order]}
            </TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground">
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  #
                </TableHead>
                <TableHead
                  aria-sort={ariaSort}
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  <button
                    aria-label={`Sort by score, now ${ORDER_LABELS[order]}`}
                    className="min-h-11 px-1 underline-offset-2 hover:underline"
                    data-sort-score=""
                    onClick={() => setOrder(ORDER_CYCLE[order])}
                    type="button"
                  >
                    Score ({ORDER_LABELS[order]})
                  </button>
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Status
                </TableHead>
                {walkForward ? (
                  <TableHead
                    className={`${headCell} text-right text-muted-foreground`}
                    scope="col"
                  >
                    Fold
                  </TableHead>
                ) : null}
                {names.map((name) => {
                  return (
                    <TableHead
                      className={`${headCell} font-mono text-muted-foreground`}
                      key={name}
                      scope="col"
                    >
                      {name}
                    </TableHead>
                  );
                })}
                <TableHead className={columnHeadCell} scope="col">
                  Metrics
                </TableHead>
                <TableHead className={columnHeadCell} scope="col">
                  Reason
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((trial) => {
                return (
                  <TableRow
                    className="border-border border-b font-mono"
                    data-trial-index={trial.index}
                    key={trial.index}
                  >
                    <TableCell className={numCell}>{trial.index}</TableCell>
                    <TableCell className={numCell}>
                      {formatScore(trial.score)}
                    </TableCell>
                    <TableCell className={cell}>{trial.status}</TableCell>
                    {walkForward ? (
                      <TableCell className={numCell}>
                        {trial.fold ?? "—"}
                      </TableCell>
                    ) : null}
                    {names.map((name) => {
                      return (
                        <TableCell className={cell} key={name}>
                          {formatParamValue(trial.params[name])}
                        </TableCell>
                      );
                    })}
                    <TableCell className={cell}>
                      {trial.metrics === undefined
                        ? "—"
                        : formatMetricMap(trial.metrics)}
                    </TableCell>
                    <TableCell className={`${cell} font-sans`}>
                      {trial.reason ?? ""}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Importance and profiles

const IMPORTANCE_HELP =
  "Variance of the mean score across each parameter's values (numeric parameters with more than 10 distinct values are grouped into 10 equal-width bins), normalized to sum to 100%. Derived by the server from the stored trials.";

const ImportancePanel = ({ run }: { readonly run: Run }) => {
  const rows = run.analytics.importance;
  return (
    <section
      aria-labelledby="optimization-importance-heading"
      className="space-y-2"
    >
      <SectionTitle help={IMPORTANCE_HELP} id="optimization-importance-heading">
        Parameter importance
      </SectionTitle>
      <p className="text-muted-foreground text-xs" data-score-source="">
        Score: {run.analytics.scoreSource} · {run.analytics.trials.scored}{" "}
        scored trials
      </p>
      {rows.length === 0 ? (
        <Empty>No parameters.</Empty>
      ) : (
        <ol
          aria-label="Parameter importance"
          className="space-y-2"
          data-importance-list=""
        >
          {rows.map((row) => {
            return (
              <li
                className="grid grid-cols-[minmax(6rem,12rem)_1fr_auto] items-center gap-3 text-xs"
                data-importance={row.name}
                key={row.name}
              >
                <span className="break-all font-mono">{row.name}</span>
                <span aria-hidden="true" className="h-3 rounded-sm bg-muted">
                  <span
                    className="block h-3 rounded-sm bg-primary/70"
                    style={{ width: `${(row.importance * 100).toFixed(1)}%` }}
                  />
                </span>
                <span className="font-mono">
                  {(row.importance * 100).toFixed(1)}% · {row.kind} ·{" "}
                  {row.groups} groups
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

const ProfileTable = ({
  profile,
  direction,
}: {
  readonly profile: Run["analytics"]["profiles"][number];
  readonly direction: "maximize" | "minimize";
}) => {
  const range = finiteRange(profile.bins.map((bin) => bin.meanScore));
  return (
    <div className="space-y-1" data-profile={profile.name}>
      <h4 className="font-mono text-xs">
        {profile.name}
        {profile.binned ? (
          <span className="ml-2 font-sans text-muted-foreground">
            10 equal-width bins
          </span>
        ) : null}
      </h4>
      <div className="overflow-x-auto">
        <Table className="w-full text-xs">
          <TableCaption className="sr-only">
            Score profile for {profile.name}
          </TableCaption>
          <TableHeader>
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead className={columnHeadCell} scope="col">
                Value
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Trials
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Mean score
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Best score
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.bins.map((bin, index) => {
              return (
                <TableRow className="border-border border-b" key={index}>
                  <TableHead className={`${headCell} font-mono`} scope="row">
                    {formatBinRange(bin)}
                  </TableHead>
                  <TableCell className={numCell}>{bin.count}</TableCell>
                  <TableCell
                    className={`${numCell} ${range === null ? "" : heatClass(bin.meanScore, range.min, range.max, direction)}`}
                  >
                    {formatScore(bin.meanScore)}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatScore(bin.bestScore)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

const Heatmap = ({
  heatmap,
  direction,
}: {
  readonly heatmap: NonNullable<Run["analytics"]["heatmap"]>;
  readonly direction: "maximize" | "minimize";
}) => {
  const range = finiteRange(heatmap.meanScores.flat());
  return (
    <section
      aria-labelledby="optimization-heatmap-heading"
      className="space-y-2"
    >
      <SectionTitle
        help="Mean score per cell for the two most important numeric parameters; darker is better for the run's direction. Empty cells had no scored trial."
        id="optimization-heatmap-heading"
      >
        Heatmap: <span className="font-mono">{heatmap.y}</span> ×{" "}
        <span className="font-mono">{heatmap.x}</span>
      </SectionTitle>
      <div className="overflow-x-auto">
        <Table className="text-xs" data-heatmap="">
          <TableCaption className="sr-only">
            Mean score by {heatmap.y} (rows) and {heatmap.x} (columns);{" "}
            {heatmap.filledCells} filled cells
          </TableCaption>
          <TableHeader>
            <TableRow className="border-border border-b text-muted-foreground">
              <TableHead
                className={`${headCell} font-mono text-muted-foreground`}
                scope="col"
              >
                {heatmap.y} / {heatmap.x}
              </TableHead>
              {heatmap.xBins.map((bin, column) => {
                return (
                  <TableHead
                    className={`${headCell} text-right font-mono text-muted-foreground`}
                    key={column}
                    scope="col"
                  >
                    {formatBinRange(bin)}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {heatmap.yBins.map((bin, row) => {
              return (
                <TableRow className="border-border border-b" key={row}>
                  <TableHead className={`${headCell} font-mono`} scope="row">
                    {formatBinRange(bin)}
                  </TableHead>
                  {(heatmap.meanScores[row] ?? []).map((value, column) => {
                    return (
                      <TableCell
                        className={`${numCell} min-w-16 ${range === null ? "" : heatClass(value, range.min, range.max, direction)}`}
                        data-cell={`${row}-${column}`}
                        key={column}
                        title={`${heatmap.counts[row]?.[column] ?? 0} trials`}
                      >
                        {formatScore(value)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
};

const ProfilesPanel = ({ run }: { readonly run: Run }) => (
  <>
    <section
      aria-labelledby="optimization-profiles-heading"
      className="space-y-3"
    >
      <SectionTitle
        help="Per numeric parameter: trials, mean and best score for each value (or equal-width bin). Derived by the server from the stored trials."
        id="optimization-profiles-heading"
      >
        Score profiles
      </SectionTitle>
      {run.analytics.profiles.length === 0 ? (
        <Empty>No numeric parameters.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {run.analytics.profiles.map((profile) => {
            return (
              <ProfileTable
                direction={run.analytics.direction}
                key={profile.name}
                profile={profile}
              />
            );
          })}
        </div>
      )}
    </section>
    {run.analytics.heatmap === null ? (
      <Empty>
        No heatmap: needs two numeric parameters with at least two values each.
      </Empty>
    ) : (
      <Heatmap
        direction={run.analytics.direction}
        heatmap={run.analytics.heatmap}
      />
    )}
  </>
);

// ---------------------------------------------------------------------------
// Pareto and folds

const ParetoPanel = ({ run }: { readonly run: Run }) => {
  const names = paramNames(run.paretoFront);
  return (
    <section
      aria-labelledby="optimization-pareto-heading"
      className="space-y-2"
    >
      <SectionTitle
        help="First non-dominated front over all objectives (NSGA-II), one row per distinct parameter set."
        id="optimization-pareto-heading"
      >
        Pareto front
      </SectionTitle>
      {run.paretoFront.length === 0 ? (
        <Empty>No front recorded.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[32rem] text-xs" data-pareto-table="">
            <TableCaption className="sr-only">Pareto front</TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground">
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Trial
                </TableHead>
                {run.objectives.map((objective) => {
                  return (
                    <TableHead
                      className={`${headCell} text-right font-mono text-muted-foreground`}
                      key={objective.metric}
                      scope="col"
                    >
                      {objective.metric} (
                      {objective.direction === "maximize" ? "max" : "min"})
                    </TableHead>
                  );
                })}
                {names.map((name) => {
                  return (
                    <TableHead
                      className={`${headCell} font-mono text-muted-foreground`}
                      key={name}
                      scope="col"
                    >
                      {name}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.paretoFront.map((point) => {
                return (
                  <TableRow
                    className="border-border border-b font-mono"
                    data-pareto-trial={point.trialIndex}
                    key={point.trialIndex}
                  >
                    <TableCell className={numCell}>
                      {point.trialIndex}
                    </TableCell>
                    {run.objectives.map((objective) => {
                      return (
                        <TableCell className={numCell} key={objective.metric}>
                          {formatScore(point.values[objective.metric])}
                        </TableCell>
                      );
                    })}
                    {names.map((name) => {
                      return (
                        <TableCell className={cell} key={name}>
                          {formatParamValue(point.params[name])}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
};

const FoldsPanel = ({ run }: { readonly run: Run }) => (
  <section aria-labelledby="optimization-folds-heading" className="space-y-2">
    <SectionTitle
      help="Each fold searches its train window, then re-runs the chosen parameters on the following test window. Bar indices are half-open [start, end)."
      id="optimization-folds-heading"
    >
      Walk-forward folds
    </SectionTitle>
    {run.folds.length === 0 ? (
      <Empty>No folds recorded.</Empty>
    ) : (
      <div className="overflow-x-auto">
        <Table className="w-full min-w-[56rem] text-xs" data-folds-table="">
          <TableCaption className="sr-only">Walk-forward folds</TableCaption>
          <TableHeader>
            <TableRow className="border-border border-b text-left text-muted-foreground">
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Fold
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Train
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Test
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Trials
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Stop
              </TableHead>
              <TableHead className={columnHeadCell} scope="col">
                Chosen params
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                IS score
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                OOS score
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                Degradation
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                DSR
                <InfoGlyph text={DSR_HELP} />
              </TableHead>
              <TableHead
                className={`${headCell} text-right text-muted-foreground`}
                scope="col"
              >
                PBO
                <InfoGlyph text={PBO_HELP} />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.folds.map((fold) => {
              return (
                <TableRow
                  className="border-border border-b"
                  data-fold={fold.index}
                  key={fold.index}
                >
                  <TableHead
                    className={`${headCell} text-right font-mono`}
                    scope="row"
                  >
                    {fold.index}
                  </TableHead>
                  <TableCell className={`${cell} font-mono`}>
                    {windowText(fold.train)}
                  </TableCell>
                  <TableCell className={`${cell} font-mono`}>
                    {windowText(fold.test)}
                  </TableCell>
                  <TableCell className={numCell}>{fold.trialCount}</TableCell>
                  <TableCell className={cell}>
                    {STOP_REASON_LABELS[fold.stopReason] ?? fold.stopReason}
                  </TableCell>
                  <TableCell className={`${cell} font-mono`}>
                    {formatParams(fold.params)}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatScore(fold.oos?.inSampleScore)}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatScore(fold.oos?.score)}
                  </TableCell>
                  <TableCell className={numCell}>
                    {formatScore(fold.oos?.degradation)}
                  </TableCell>
                  <TableCell
                    className={numCell}
                    title={fold.diagnostics?.deflatedSharpeReason ?? undefined}
                  >
                    {formatProbability(
                      fold.diagnostics?.deflatedSharpe?.probability
                    )}
                  </TableCell>
                  <TableCell
                    className={numCell}
                    title={fold.diagnostics?.pboReason ?? undefined}
                  >
                    {formatProbability(fold.diagnostics?.pbo?.pbo)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    )}
  </section>
);

// ---------------------------------------------------------------------------

const runTitle = (
  run: Pick<Run, "strategyName" | "method">,
  taskTitle: string | null
): string => {
  return (
    run.strategyName ??
    taskTitle ??
    `${METHOD_LABELS[run.method] ?? run.method} optimization`
  );
};

export type OptimizationDetailProps = Readonly<{
  detail: OptimizationGetOutput;
  tab: OptimizationTab;
  onTab: (tab: OptimizationTab) => void;
  onClose: () => void;
}>;

export const OptimizationDetail = ({
  detail,
  tab,
  onTab,
  onClose,
}: OptimizationDetailProps) => {
  const run = detail.optimization;
  const tabs = availableTabs(run);
  const current = tabs.includes(tab) ? tab : "overview";
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = tabKeyTarget(event.key, current, tabs);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`optimization-tab-${next}`)?.focus();
  };
  return (
    <section
      aria-labelledby="optimization-detail-heading"
      className="space-y-4 rounded-md border border-border p-4"
      data-optimization-detail={run.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            className="break-words font-medium text-base"
            id="optimization-detail-heading"
          >
            {runTitle(run, detail.task?.title ?? null)}
          </h2>
          <p className="break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {METHOD_LABELS[run.method] ?? run.method} ·{" "}
            {VALIDATION_LABELS[run.validation.mode] ?? run.validation.mode} ·{" "}
            <span className="font-mono">{formatMarkets(run.markets, 6)}</span> ·
            recorded {formatTimestamp(run.createdAt)} UTC
          </p>
        </div>
        <Button onClick={onClose} type="button" variant="secondary">
          Close
        </Button>
      </div>
      <div
        aria-label="Optimization views"
        className="flex flex-wrap gap-1 border-border border-b"
        onKeyDown={onTabKey}
        role="tablist"
      >
        {tabs.map((option) => {
          return (
            <button
              aria-controls={`optimization-panel-${option}`}
              aria-selected={current === option}
              className={`min-h-11 border-b-2 px-3 text-sm ${current === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              data-tab={option}
              id={`optimization-tab-${option}`}
              key={option}
              onClick={() => onTab(option)}
              role="tab"
              tabIndex={current === option ? 0 : -1}
              type="button"
            >
              {OPTIMIZATION_TAB_LABELS[option]}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`optimization-tab-${current}`}
        className="space-y-5"
        id={`optimization-panel-${current}`}
        role="tabpanel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanel: the panel is focusable so keyboard users reach its content.
        tabIndex={0}
      >
        {current === "overview" ? (
          <OverviewPanel detail={detail} />
        ) : current === "trials" ? (
          <TrialsPanel key={run.id} run={run} />
        ) : current === "importance" ? (
          <ImportancePanel run={run} />
        ) : current === "profiles" ? (
          <ProfilesPanel run={run} />
        ) : current === "pareto" ? (
          <ParetoPanel run={run} />
        ) : (
          <FoldsPanel run={run} />
        )}
      </div>
    </section>
  );
};
