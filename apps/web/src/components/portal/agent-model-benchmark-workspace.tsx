"use client";

import {
  AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX,
  AGENT_RATING_VALUES,
  type AgentModelBenchmarkArmByValue,
  type AgentModelBenchmarkArmOutput,
  type AgentModelBenchmarkOutput,
  type AgentModelBenchmarkPairOutput,
  type AgentModelRunFacetName,
  type AgentModelRunFacetsOutput,
} from "@darkfactory/api";
import {
  Button,
  Input,
  SectionHeader,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type AgentModelBenchmarkGateway,
  ARM_BY_LABELS,
  ARM_BY_OPTIONS,
  agreementBand,
  BENCHMARK_FACETS,
  type BenchmarkSettings,
  benchmarkFilters,
  benchmarkInput,
  createBrowserAgentModelBenchmarkGateway,
  DEFAULT_BENCHMARK_SETTINGS,
  formatDistance,
  formatDuration,
  formatPValue,
  withArmBy,
} from "./agent-model-benchmark-client.ts";
import { ResearchOnlyNote } from "./agent-model-run-badges.tsx";
import {
  datesOutOfOrder,
  describeModelRunFailure,
  formatCount,
  formatShare,
  formatUsd,
  isModelRunForbidden,
  toggleFacetValue,
} from "./agent-model-runs-client.ts";
import { FacetGroup } from "./agent-model-runs-workspace.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";

export interface AgentModelBenchmarkWorkspaceProps {
  /** Extra section under the results (the framework reference sheets). */
  readonly children?: ReactNode;
  readonly gateway?: AgentModelBenchmarkGateway;
}

type LoadState = Readonly<{
  phase: "loading" | "ready" | "error" | "forbidden";
  facets: AgentModelRunFacetsOutput | null;
  result: AgentModelBenchmarkOutput | null;
  message: string;
}>;

const selectClass =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";
const tableClass = "w-full min-w-max border-collapse text-sm";
const cellClass = "border-border border-b px-2 py-2 text-left tabular-nums";
const headClass =
  "border-border border-b px-2 py-2 text-left font-medium text-muted-foreground text-xs";

const RATING_SEGMENT_CLASS: Readonly<
  Record<(typeof AGENT_RATING_VALUES)[number], string>
> = {
  buy: "bg-emerald-600",
  hold: "bg-zinc-400",
  overweight: "bg-emerald-400",
  sell: "bg-red-600",
  underweight: "bg-red-400",
};

const costLabel = (arm: AgentModelBenchmarkArmOutput): string =>
  arm.local ? "local" : formatUsd(arm.avgCostUsd);

const ArmSelect = ({
  label,
  value,
  arms,
  emptyLabel,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly arms: readonly string[];
  readonly emptyLabel: string;
  readonly onChange: (value: string) => void;
}) => (
  <label className="space-y-1 text-xs">
    <span className="block text-muted-foreground">{label}</span>
    <select
      className={selectClass}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">{emptyLabel}</option>
      {arms.map((arm) => (
        <option key={arm} value={arm}>
          {arm}
        </option>
      ))}
    </select>
  </label>
);

const ArmTable = ({
  arms,
}: {
  readonly arms: readonly AgentModelBenchmarkArmOutput[];
}) => (
  <div className="overflow-x-auto">
    <Table containerClassName="overflow-visible" className={tableClass}>
      <TableCaption className="sr-only">
        Runs, coverage and usage per arm
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Arm
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Runs
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Finished
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Failed
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Rated
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Unrated
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Cells (rated)
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Reruns agree
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Buy or sell
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Avg cost
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Tokens in / out
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            LLM / tool calls
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Median time
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Served models
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {arms.map((arm) => (
          <TableRow data-arm={arm.key} key={arm.key}>
            <TableHead
              className={cn("h-auto whitespace-normal", cellClass)}
              scope="row"
            >
              {arm.key}
            </TableHead>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.runs}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.finished}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.failed}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.rated}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.unrated}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.cells} ({arm.ratedCells})
            </TableCell>
            <TableCell
              className={cn("whitespace-normal", cellClass)}
              title={`${arm.rerun.cells} cells with 2 or more rated runs; mean modal share ${formatShare(arm.rerun.meanModalShare)}`}
            >
              {formatShare(arm.rerun.allAgreeShare)}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {formatShare(arm.extremityShare)}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {costLabel(arm)}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {formatCount(arm.inputTokens)} / {formatCount(arm.outputTokens)}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {arm.llmCalls} / {arm.toolCalls}
            </TableCell>
            <TableCell className={cn("whitespace-normal", cellClass)}>
              {formatDuration(arm.medianDurationMs)}
            </TableCell>
            <TableCell className={`${cellClass} max-w-64 truncate`}>
              {arm.servedModels.length === 0
                ? "—"
                : arm.servedModels.join(", ")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

const RatingMix = ({
  arms,
}: {
  readonly arms: readonly AgentModelBenchmarkArmOutput[];
}) => (
  <ul className="space-y-2" data-rating-mix="true">
    {arms.map((arm) => {
      const counts = AGENT_RATING_VALUES.map(
        (rating) => `${rating} ${arm.ratingMix[rating]}`
      ).join(", ");
      return (
        <li className="space-y-1" key={arm.key}>
          <p className="text-sm">
            <span className="font-medium">{arm.key}</span>{" "}
            <span className="text-muted-foreground text-xs">
              {arm.rated === 0 ? "no rated runs" : counts}
            </span>
          </p>
          <div
            aria-hidden="true"
            className="flex h-3 w-full overflow-hidden rounded bg-muted"
          >
            {AGENT_RATING_VALUES.map((rating) =>
              arm.ratingMix[rating] === 0 ? null : (
                <span
                  className={RATING_SEGMENT_CLASS[rating]}
                  data-segment={rating}
                  key={rating}
                  style={{
                    width: `${(arm.ratingMix[rating] / arm.rated) * 100}%`,
                  }}
                />
              )
            )}
          </div>
        </li>
      );
    })}
  </ul>
);

const AgreementMatrix = ({
  matrix,
}: {
  readonly matrix: AgentModelBenchmarkOutput["matrix"];
}) => (
  <div className="overflow-x-auto">
    <Table
      containerClassName="overflow-visible"
      className={tableClass}
      data-matrix="true"
    >
      <TableCaption className="sr-only">
        Share of shared cells where two arms give the same modal rating
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableCell className={cn("text-muted-foreground", headClass)} />
          {matrix.arms.map((arm) => (
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              key={arm}
              scope="col"
            >
              {arm}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {matrix.rows.map((row, rowIndex) => {
          const rowArm = matrix.arms[rowIndex] as string;
          return (
            <TableRow key={rowArm}>
              <TableHead
                className={cn("h-auto whitespace-normal", cellClass)}
                scope="row"
              >
                {rowArm}
              </TableHead>
              {row.map((value, columnIndex) => (
                <TableCell
                  className={`whitespace-normal ${cellClass} ${agreementBand(value.agreeShare)}`}
                  key={matrix.arms[columnIndex]}
                >
                  {formatShare(value.agreeShare)}
                  <span className="text-muted-foreground text-xs">
                    {" "}
                    (n={value.sharedCells})
                  </span>
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);

const BaselineTable = ({
  arms,
  baselineArm,
}: {
  readonly arms: readonly AgentModelBenchmarkArmOutput[];
  readonly baselineArm: string;
}) => (
  <div className="overflow-x-auto">
    <Table
      containerClassName="overflow-visible"
      className={tableClass}
      data-baseline-table="true"
    >
      <TableCaption className="mt-0 caption-top text-left text-muted-foreground text-xs">
        Against baseline {baselineArm}: the match rate counts cells where the
        arm's modal rating is one of the baseline's ratings; the distance is the
        step to the closest baseline rating (0-4).
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Arm
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Avg cost
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Shared cells
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Match rate
          </TableHead>
          <TableHead
            className={cn("text-muted-foreground", headClass)}
            scope="col"
          >
            Mean closest distance
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {arms.map((arm) =>
          arm.baseline === null ? null : (
            <TableRow key={arm.key}>
              <TableHead
                className={cn("h-auto whitespace-normal", cellClass)}
                scope="row"
              >
                {arm.key}
              </TableHead>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {costLabel(arm)}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {arm.baseline.sharedCells}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {formatShare(arm.baseline.matchRate)}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {formatDistance(arm.baseline.meanClosestDistance)}
              </TableCell>
            </TableRow>
          )
        )}
      </TableBody>
    </Table>
  </div>
);

const PairPanel = ({
  pair,
}: {
  readonly pair: AgentModelBenchmarkPairOutput;
}) => (
  <div className="space-y-2" data-pair="true">
    <p className="text-sm">
      {pair.changedRating} of {pair.sharedCells} shared cells changed rating. On{" "}
      {pair.compared} cells with a call from both arms and a {pair.forwardDays}
      -day forward return, {pair.treatment} hit the direction where{" "}
      {pair.control} missed in {pair.wins}, the reverse in {pair.losses}, and
      both hit or both missed in {pair.ties}. Exact sign test p ={" "}
      {formatPValue(pair.signTestP)}.
    </p>
    <p className="text-muted-foreground text-xs">
      Left out: {pair.excludedNoCall} cells where an arm holds or has no rating,
      {` ${pair.excludedNoBars}`} cells without daily bars or a full forward
      window
      {pair.tickersWithoutBars.length === 0
        ? ""
        : ` (no bars: ${pair.tickersWithoutBars.join(", ")})`}
      {pair.tickersOverCap.length === 0
        ? "."
        : `; bars not loaded, over the ${AGENT_MODEL_BENCHMARK_BAR_TICKERS_MAX}-ticker cap: ${pair.tickersOverCap.join(", ")}.`}{" "}
      A directional hit is a research measure, not a trading result.
    </p>
    <div className="overflow-x-auto">
      <Table containerClassName="overflow-visible" className={tableClass}>
        <TableCaption className="sr-only">
          Paired arms: hits and usage
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Arm
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Hits
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Runs
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Cost
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Tokens
            </TableHead>
            <TableHead
              className={cn("text-muted-foreground", headClass)}
              scope="col"
            >
              Median time
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(
            [
              [`Control: ${pair.control}`, pair.controlArm],
              [`Treatment: ${pair.treatment}`, pair.treatmentArm],
            ] as const
          ).map(([label, arm]) => (
            <TableRow key={label}>
              <TableHead
                className={cn("h-auto whitespace-normal", cellClass)}
                scope="row"
              >
                {label}
              </TableHead>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {arm.hits} of {pair.compared}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {arm.runs}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {formatUsd(arm.totalCostUsd)}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {formatCount(arm.totalTokens)}
              </TableCell>
              <TableCell className={cn("whitespace-normal", cellClass)}>
                {formatDuration(arm.medianDurationMs)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </div>
);

const EmptyHelp = () => (
  <div className="space-y-1 rounded-md border border-border p-4" role="status">
    <p className="font-medium text-sm">No runs match these filters.</p>
    <p className="text-muted-foreground text-sm">
      Record a benchmark with{" "}
      <code className="font-mono">python -m agents.framework_bench</code> (see
      docs/agent-benchmark.md), then choose its batch here.
    </p>
  </div>
);

const Results = ({
  result,
  settings,
}: {
  readonly result: AgentModelBenchmarkOutput;
  readonly settings: BenchmarkSettings;
}) => (
  <div className="space-y-6">
    <p className="text-muted-foreground text-sm" role="status">
      {result.runCount} runs on {result.cells} cells in {result.arms.length}{" "}
      arms.
      {result.truncated
        ? " Only the newest 5000 runs are compared; narrow the filters."
        : ""}
      {result.armsTruncated ? " Only the 100 largest arms are listed." : ""}
    </p>
    <section aria-label="Arms" className="space-y-2">
      <h3 className="font-medium text-sm">Arms</h3>
      <ArmTable arms={result.arms} />
    </section>
    <section aria-label="Rating mix" className="space-y-2">
      <h3 className="font-medium text-sm">Rating mix</h3>
      <RatingMix arms={result.arms} />
    </section>
    <section aria-label="Agreement matrix" className="space-y-2">
      <h3 className="font-medium text-sm">Agreement matrix</h3>
      <AgreementMatrix matrix={result.matrix} />
    </section>
    {result.baselineArm === null ? null : (
      <section aria-label="Cost and agreement" className="space-y-2">
        <h3 className="font-medium text-sm">Cost and agreement</h3>
        <BaselineTable arms={result.arms} baselineArm={result.baselineArm} />
      </section>
    )}
    {result.pair === null ? null : (
      <section aria-label="Paired comparison" className="space-y-2">
        <h3 className="font-medium text-sm">
          Paired comparison: {settings.control} vs {settings.treatment}
        </h3>
        <PairPanel pair={result.pair} />
      </section>
    )}
  </div>
);

export const AgentModelBenchmarkWorkspace = ({
  gateway: suppliedGateway,
  children,
}: AgentModelBenchmarkWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentModelBenchmarkGateway()
  );
  const [settings, setSettings] = useState<BenchmarkSettings>(
    DEFAULT_BENCHMARK_SETTINGS
  );
  const [state, setState] = useState<LoadState>({
    facets: null,
    message: "",
    phase: "loading",
    result: null,
  });
  const request = useRef(0);
  const invalidDates = datesOutOfOrder(settings.filters);

  const load = useCallback(async () => {
    if (invalidDates) return;
    request.current += 1;
    const ticket = request.current;
    setState((current) => ({ ...current, phase: "loading" }));
    try {
      const [facets, result] = await Promise.all([
        gateway.facets(benchmarkFilters(settings)),
        gateway.benchmark(benchmarkInput(settings)),
      ]);
      if (ticket !== request.current) return;
      setState({ facets, message: "", phase: "ready", result });
    } catch (error) {
      if (ticket !== request.current) return;
      setState((current) => ({
        ...current,
        message: describeModelRunFailure(error),
        phase: isModelRunForbidden(error) ? "forbidden" : "error",
      }));
    }
  }, [gateway, settings, invalidDates]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "forbidden")
    return (
      <section aria-label="Model benchmark" className="space-y-3">
        <SectionHeader title="Model benchmark" />
        <OperatorAccessRequired feature="agent-runs" />
      </section>
    );

  const toggle = (facet: AgentModelRunFacetName, value: string) =>
    setSettings((current) => ({
      ...current,
      filters: toggleFacetValue(current.filters, facet, value),
    }));
  const armKeys = state.result?.arms.map((arm) => arm.key) ?? [];
  const facets = state.facets;

  return (
    <section aria-label="Model benchmark" className="space-y-4">
      <SectionHeader title="Model benchmark" />
      <ResearchOnlyNote />
      <p className="text-muted-foreground text-sm">
        Compare models and frameworks on the same tickers and decision dates. To
        test a rating series against shuffled ratings, record it as a backtest
        and open its Placebo tab on{" "}
        <Link className="underline" href="/backtests" prefetch={false}>
          Backtests
        </Link>
        .
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Batch</span>
          <select
            className={selectClass}
            onChange={(event) =>
              setSettings({ ...settings, batch: event.target.value })
            }
            value={settings.batch}
          >
            <option value="">Any batch</option>
            {(facets?.batch ?? []).map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.value} ({entry.count})
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Decision from</span>
          <Input
            aria-invalid={invalidDates}
            onChange={(event) =>
              setSettings({
                ...settings,
                filters: {
                  ...settings.filters,
                  decisionFrom: event.target.value,
                },
              })
            }
            type="date"
            value={settings.filters.decisionFrom}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Decision to</span>
          <Input
            aria-invalid={invalidDates}
            onChange={(event) =>
              setSettings({
                ...settings,
                filters: {
                  ...settings.filters,
                  decisionTo: event.target.value,
                },
              })
            }
            type="date"
            value={settings.filters.decisionTo}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Arms by</span>
          <select
            className={selectClass}
            onChange={(event) =>
              setSettings(
                withArmBy(
                  settings,
                  event.target.value as AgentModelBenchmarkArmByValue
                )
              )
            }
            value={settings.armBy}
          >
            {ARM_BY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {ARM_BY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <ArmSelect
          arms={armKeys}
          emptyLabel="No baseline"
          label="Baseline arm"
          onChange={(value) => setSettings({ ...settings, baselineArm: value })}
          value={settings.baselineArm}
        />
        <ArmSelect
          arms={armKeys}
          emptyLabel="No pair"
          label="Paired: control"
          onChange={(value) => setSettings({ ...settings, control: value })}
          value={settings.control}
        />
        <ArmSelect
          arms={armKeys}
          emptyLabel="No pair"
          label="Paired: treatment"
          onChange={(value) => setSettings({ ...settings, treatment: value })}
          value={settings.treatment}
        />
        <Button
          onClick={() => setSettings(DEFAULT_BENCHMARK_SETTINGS)}
          variant="ghost"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Reset
        </Button>
        <p className="min-h-5 text-muted-foreground text-xs" role="status">
          {state.phase === "loading" && state.result !== null
            ? "Updating…"
            : ""}
        </p>
      </div>
      {invalidDates ? (
        <p className="text-destructive text-sm" role="alert">
          The from date is after the to date.
        </p>
      ) : null}
      {state.phase === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-destructive text-sm">{state.message}</p>
          <Button onClick={() => void load()} variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Retry
          </Button>
        </div>
      ) : null}
      {state.result === null && state.phase === "loading" ? (
        <div aria-busy="true" className="space-y-2" role="status">
          <span className="sr-only">Loading the benchmark</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : null}
      {facets === null || state.result === null ? null : (
        <div
          aria-busy={state.phase === "loading"}
          className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]"
        >
          <aside aria-label="Filters" className="space-y-4">
            {BENCHMARK_FACETS.map((facet) => {
              const counts = facets[facet];
              const selected = settings.filters.facets[facet] ?? [];
              return counts.length === 0 && selected.length === 0 ? null : (
                <FacetGroup
                  counts={counts}
                  facet={facet}
                  key={facet}
                  onToggle={toggle}
                  selected={selected}
                />
              );
            })}
          </aside>
          <div className="min-w-0">
            {state.result.runCount === 0 ? (
              <EmptyHelp />
            ) : (
              <Results result={state.result} settings={settings} />
            )}
          </div>
        </div>
      )}
      {children}
    </section>
  );
};
