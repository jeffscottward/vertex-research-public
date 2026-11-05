"use client";

import {
  type ApiClient,
  BACKTEST_SWEEP_MAX_DIMENSIONS,
  BACKTEST_SWEEP_METRICS,
  BACKTEST_SWEEP_PARAMS,
  type BacktestRun,
  type BacktestRunSubmitInput,
  type BacktestSweepCell,
  type BacktestSweepInput,
  type BacktestSweepMetric,
  type BacktestSweepOutput,
  type BacktestSweepRequest,
  createApiClient,
  type InstantBacktestSeries,
  type SweepRobustness,
  sweepCoordinates,
  sweepParamApplies,
} from "@darkfactory/api";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  createResultCache,
  currentSearch,
  useDebouncedValue,
  writeQuery,
} from "./backtest-lab-query.ts";
import { isoDate } from "./backtest-runs-model.ts";
import {
  autoSweepKey,
  cellSubmitInput,
  DEFAULT_SWEEP_METRIC,
  defaultAxes,
  defaultDimensions,
  describeCell,
  formatSweepMetric,
  type HeatmapAxes,
  heatmapView,
  moveAxis,
  parseSweepQuery,
  pickSeries,
  robustnessFor,
  SWEEP_METRIC_LABELS,
  SWEEP_PARAM_LABELS,
  type SweepDimensionForm,
  type SweepForm,
  seriesKey,
  sweepRunKey,
  toSweepInput,
} from "./backtest-sweeps-model.ts";
import {
  DEFAULT_UNIVERSE_CHOICE,
  firstSeriesKey,
  UniverseSelect,
  visibleSeries,
} from "./backtest-universe.tsx";
import { DEFAULT_INSTANT_PARAMS } from "./instant-backtest-workspace.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";
import { NumberField } from "./number-field.tsx";

// Parameter sweep: run a grid of backtests, read the heatmap of any two swept parameters for a
// selected metric, compare each cell with its neighbours (robust rank, isolated spikes) and queue
// a full backtest run for one cell. The default grid runs on open on stored bars (a sweep stores
// nothing); an edited grid waits for "Run sweep". Research only; no order path exists on this page
// or its API.

const RANKED_ROWS = 20;
const AUTO_RUN_DELAY_MS = 350;
const CACHED_SWEEPS = 20;
const selectClass = "min-h-11 rounded-md border bg-background px-3 text-sm";

export interface BacktestSweepsGateway {
  readonly series: () => Promise<readonly InstantBacktestSeries[]>;
  readonly submit: (input: BacktestRunSubmitInput) => Promise<BacktestRun>;
  readonly sweep: (input: BacktestSweepInput) => Promise<BacktestSweepOutput>;
}

export const createBacktestSweepsGateway = (
  client: ApiClient
): BacktestSweepsGateway => ({
  series: async () => (await client.instantBacktest.series()).series,
  submit: (input) => client.backtestRuns.submit(input),
  sweep: (input) => client.backtestRuns.sweep(input),
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserBacktestSweepsGateway = (): BacktestSweepsGateway => {
  const current = () =>
    createBacktestSweepsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
  return {
    series: () => current().series(),
    submit: (input) => current().submit(input),
    sweep: (input) => current().sweep(input),
  };
};

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; series: readonly InstantBacktestSeries[] }>;

type SweepResult = Readonly<{
  request: BacktestSweepRequest;
  output: BacktestSweepOutput;
}>;

const Select = ({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  options: readonly Readonly<{ value: string; label: string }>[];
  onChange: (value: string) => void;
}>) => {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label className="font-medium text-sm" htmlFor={id}>
        {label}
      </label>
      <select
        className={selectClass}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
};

const metricOptions = BACKTEST_SWEEP_METRICS.map((metric) => ({
  label: SWEEP_METRIC_LABELS[metric],
  value: metric,
}));

const SelectedCell = ({
  result,
  index,
  metric,
  robustness,
  gateway,
}: Readonly<{
  result: SweepResult;
  index: number;
  metric: BacktestSweepMetric;
  robustness: SweepRobustness;
  gateway: BacktestSweepsGateway;
}>) => {
  const [state, setState] = useState<
    | Readonly<{ type: "idle" }>
    | Readonly<{ type: "submitting" }>
    | Readonly<{ type: "queued"; id: string }>
    | Readonly<{ type: "error"; message: string }>
  >({ type: "idle" });
  const { output } = result;
  const cell = output.cells[index] as BacktestSweepCell;
  const format = (value: number | null) => formatSweepMetric(metric, value);
  const rows = [
    [SWEEP_METRIC_LABELS[metric], format(cell.metrics[metric])],
    [
      "Worst in neighbourhood",
      format(robustness.worst[index] as number | null),
    ],
    [
      "Neighbour average",
      format(robustness.neighbourMean[index] as number | null),
    ],
    ["Neighbours with a value", String(robustness.neighbours[index])],
    ["Robust rank", String(robustness.rank[index] ?? "not ranked")],
    ["Trades", String(cell.trades ?? "n/a")],
  ] as const;
  const runFull = async () => {
    setState({ type: "submitting" });
    try {
      const run = await gateway.submit(
        cellSubmitInput(result.request, output, index)
      );
      setState({ id: run.id, type: "queued" });
    } catch (error) {
      setState({
        message: describeMarketDataFailure(error).message,
        type: "error",
      });
    }
  };
  return (
    <section aria-label="Selected cell" className="grid gap-3">
      <h3 className="font-semibold text-base">
        Cell: {describeCell(output, index)}
      </h3>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div className="flex justify-between gap-4 border-b py-1" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {cell.error === null ? null : (
        <p className="text-sm" role="status">
          Not run: {cell.error}
        </p>
      )}
      {robustness.spike[index] === true ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <TriangleAlert aria-hidden="true" className="size-4" />
          Isolated spike: the neighbours average less than{" "}
          {output.spikeRatio * 100}% of this value.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
          disabled={
            cell.error !== null ||
            state.type === "submitting" ||
            state.type === "queued"
          }
          onClick={() => void runFull()}
          type="button"
        >
          {state.type === "submitting" ? "Queuing…" : "Run full backtest"}
        </button>
        {state.type === "queued" ? (
          <Link
            className="min-h-11 content-center text-sm underline"
            href={`/backtest-runs?run=${encodeURIComponent(state.id)}`}
            prefetch={false}
          >
            Open the backtest report
          </Link>
        ) : null}
        {state.type === "error" ? (
          <p className="text-sm" role="alert">
            {state.message}
          </p>
        ) : null}
      </div>
    </section>
  );
};

const SweepResults = ({
  result,
  metric,
  onMetric,
  gateway,
}: Readonly<{
  result: SweepResult;
  metric: BacktestSweepMetric;
  onMetric: (metric: BacktestSweepMetric) => void;
  gateway: BacktestSweepsGateway;
}>) => {
  const { output } = result;
  const [mode, setMode] = useState<"value" | "worst">("value");
  const robustness = useMemo(
    () => robustnessFor(output, metric),
    [output, metric]
  );
  // A cached sweep may be ranked for another metric, so start at the best cell for this one.
  const [axes, setAxes] = useState<HeatmapAxes>(() =>
    defaultAxes(output, robustness.ranking[0])
  );
  const [selected, setSelected] = useState<number | null>(
    robustness.ranking[0] ?? null
  );
  const view = heatmapView(output, robustness, metric, mode, axes);
  const shape = output.dimensions.map((dimension) => dimension.values.length);
  const dimensionOptions = output.dimensions.map((dimension, position) => ({
    label: SWEEP_PARAM_LABELS[dimension.param],
    value: String(position),
  }));
  const label = (position: number) =>
    (dimensionOptions[position] as { label: string }).label;
  const cellAt = (index: number) => output.cells[index] as BacktestSweepCell;
  const select = (index: number) => {
    setSelected(index);
    setAxes((current) => ({
      ...current,
      fixed: sweepCoordinates(index, shape),
    }));
  };
  const spikes = robustness.spike.filter(Boolean).length;
  const captionId = useId();
  return (
    <section aria-label="Sweep results" className="grid gap-6">
      <p className="text-muted-foreground text-sm">
        {output.cells.length} cells over {output.bars.toLocaleString("en-US")}{" "}
        bars ({isoDate(output.firstT)} to {isoDate(output.lastT)}),{" "}
        {(output.computeMs / 1000).toFixed(2)} s. {spikes} isolated{" "}
        {spikes === 1 ? "spike" : "spikes"} for{" "}
        {SWEEP_METRIC_LABELS[metric].toLowerCase()}.
      </p>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Metric"
          onChange={(value) => {
            const next = value as BacktestSweepMetric;
            onMetric(next);
            // Follow the best-ranked cell for the new metric.
            const best = robustnessFor(output, next).ranking[0];
            if (best !== undefined) select(best);
          }}
          options={metricOptions}
          value={metric}
        />
        <Select
          label="Colour by"
          onChange={(value) => setMode(value === "worst" ? "worst" : "value")}
          options={[
            { label: "Cell value", value: "value" },
            { label: "Worst in neighbourhood", value: "worst" },
          ]}
          value={mode}
        />
        <Select
          label="Columns"
          onChange={(value) =>
            setAxes((current) => moveAxis(current, "x", Number(value)))
          }
          options={dimensionOptions}
          value={String(axes.x)}
        />
        {axes.y === null ? null : (
          <Select
            label="Rows"
            onChange={(value) =>
              setAxes((current) => moveAxis(current, "y", Number(value)))
            }
            options={dimensionOptions}
            value={String(axes.y)}
          />
        )}
        {output.dimensions.map((dimension, position) =>
          position === axes.x || position === axes.y ? null : (
            <Select
              key={dimension.param}
              label={`Fixed ${SWEEP_PARAM_LABELS[dimension.param]}`}
              onChange={(value) =>
                setAxes((current) => {
                  const fixed = [...current.fixed];
                  fixed[position] = Number(value);
                  return { ...current, fixed };
                })
              }
              options={dimension.values.map((entry, at) => ({
                label: String(entry),
                value: String(at),
              }))}
              value={String(axes.fixed[position])}
            />
          )
        )}
      </div>
      <p className="text-muted-foreground text-sm" id={captionId}>
        {SWEEP_METRIC_LABELS[metric]}
        {mode === "worst" ? " (worst in neighbourhood)" : ""} by{" "}
        {axes.y === null ? "" : `${label(axes.y)} (rows) and `}
        {label(axes.x)} (columns). Stronger colour is better within this view.
        Cells with a warning icon are isolated spikes.
      </p>
      <div className="overflow-x-auto">
        <table
          aria-labelledby={captionId}
          className="text-xs tabular-nums"
          data-sweep-heatmap=""
        >
          <thead>
            <tr>
              <th className="p-1 text-left" scope="col">
                {axes.y === null ? "" : `${label(axes.y)} / `}
                {label(axes.x)}
              </th>
              {view.xValues.map((value) => (
                <th className="p-1 text-right" key={value} scope="col">
                  {value}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, position) => (
              <tr key={String(view.yValues[position])}>
                <th className="p-1 text-left" scope="row">
                  {view.yValues[position] ?? ""}
                </th>
                {row.map((cell) => {
                  const text = formatSweepMetric(metric, cell.value);
                  return (
                    <td className={`p-0.5 ${cell.heat}`} key={cell.index}>
                      <button
                        aria-label={`${describeCell(output, cell.index)}: ${SWEEP_METRIC_LABELS[metric]} ${text}${cell.rank === null ? ", not ranked" : `, robust rank ${cell.rank}`}${cell.spike ? ", isolated spike" : ""}`}
                        aria-pressed={selected === cell.index}
                        className="flex min-h-11 min-w-16 items-center justify-end gap-1 rounded-sm px-2 aria-[pressed=true]:outline aria-[pressed=true]:outline-2 aria-[pressed=true]:outline-foreground"
                        data-spike={cell.spike ? "" : undefined}
                        onClick={() => select(cell.index)}
                        title={cell.error ?? undefined}
                        type="button"
                      >
                        {cell.spike ? (
                          <TriangleAlert
                            aria-hidden="true"
                            className="size-3 shrink-0"
                          />
                        ) : null}
                        {text}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected === null ? null : (
        <SelectedCell
          gateway={gateway}
          index={selected}
          key={selected}
          metric={metric}
          result={result}
          robustness={robustness}
        />
      )}
      <section aria-label="Most robust cells" className="grid gap-2">
        <h3 className="font-semibold text-base">Most robust cells</h3>
        <p className="text-muted-foreground text-sm">
          Ranked by the worst {SWEEP_METRIC_LABELS[metric].toLowerCase()} in
          each cell's neighbourhood (the cell and the cells one step away in one
          parameter), not by the single best cell.
        </p>
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 bg-background text-left">
              <tr>
                <th className="p-2">Rank</th>
                <th className="p-2">Settings</th>
                <th className="p-2">Value</th>
                <th className="p-2">Worst in neighbourhood</th>
                <th className="p-2">Neighbour average</th>
                <th className="p-2">Spike</th>
              </tr>
            </thead>
            <tbody>
              {robustness.ranking.slice(0, RANKED_ROWS).map((index) => (
                <tr className="border-t" key={index}>
                  <td className="p-2">{robustness.rank[index]}</td>
                  <td className="p-2">
                    <button
                      className="min-h-11 text-left underline"
                      onClick={() => select(index)}
                      type="button"
                    >
                      {describeCell(output, index)}
                    </button>
                  </td>
                  <td className="p-2">
                    {formatSweepMetric(metric, cellAt(index).metrics[metric])}
                  </td>
                  <td className="p-2">
                    {formatSweepMetric(
                      metric,
                      robustness.worst[index] as number | null
                    )}
                  </td>
                  <td className="p-2">
                    {formatSweepMetric(
                      metric,
                      robustness.neighbourMean[index] as number | null
                    )}
                  </td>
                  <td className="p-2">
                    {robustness.spike[index] === true ? "Yes" : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
};

const DimensionRow = ({
  dimension,
  position,
  available,
  onChange,
  onRemove,
}: Readonly<{
  dimension: SweepDimensionForm;
  position: number;
  available: readonly SweepDimensionForm["param"][];
  onChange: (dimension: SweepDimensionForm) => void;
  onRemove: (() => void) | null;
}>) => (
  <fieldset className="grid gap-3 rounded-md border p-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
    <legend className="px-1 font-medium text-sm">
      Dimension {position + 1}
    </legend>
    <Select
      label={`Dimension ${position + 1} parameter`}
      onChange={(value) =>
        onChange({ ...dimension, param: value as SweepDimensionForm["param"] })
      }
      options={available.map((param) => ({
        label: SWEEP_PARAM_LABELS[param],
        value: param,
      }))}
      value={dimension.param}
    />
    <NumberField
      label={`Dimension ${position + 1} from`}
      onChange={(from) => onChange({ ...dimension, from })}
      step={0.5}
      value={dimension.from}
    />
    <NumberField
      label={`Dimension ${position + 1} to`}
      onChange={(to) => onChange({ ...dimension, to })}
      step={0.5}
      value={dimension.to}
    />
    <NumberField
      label={`Dimension ${position + 1} step`}
      onChange={(step) => onChange({ ...dimension, step })}
      step={0.5}
      value={dimension.step}
    />
    {onRemove === null ? null : (
      <button
        className="min-h-11 self-end rounded-md border px-3 text-sm"
        onClick={onRemove}
        type="button"
      >
        Remove dimension {position + 1}
      </button>
    )}
  </fieldset>
);

export type BacktestSweepsWorkspaceProps = Readonly<{
  gateway?: BacktestSweepsGateway;
}>;

export const BacktestSweepsWorkspace = ({
  gateway: injected,
}: BacktestSweepsWorkspaceProps) => {
  const gateway = useMemo(
    () => injected ?? createBrowserBacktestSweepsGateway(),
    [injected]
  );
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [selectedSeries, setSelectedSeries] = useState("");
  const [universe, setUniverse] = useState(DEFAULT_UNIVERSE_CHOICE);
  const universeRef = useRef(universe);
  universeRef.current = universe;
  // The URL is read once, on the first series load; a later reload keeps the user's choices.
  const queryRead = useRef(false);
  const [form, setForm] = useState<SweepForm>({
    dimensions: defaultDimensions(DEFAULT_INSTANT_PARAMS.ruleKind),
    from: "",
    metric: DEFAULT_SWEEP_METRIC,
    params: DEFAULT_INSTANT_PARAMS,
    to: "",
  });
  const [result, setResult] = useState<SweepResult | null>(null);
  const [sweeps, setSweeps] = useState(0);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Finished sweeps for this visit, so going back to a choice does not run it again.
  const [cache] = useState(() =>
    createResultCache<BacktestSweepOutput>(CACHED_SWEEPS)
  );
  // Run key of the last sweep started, and a counter so only the latest answer is shown.
  const lastRun = useRef<string | null>(null);
  const latest = useRef(0);
  const fromId = useId();
  const toId = useId();

  // Selects a series and sets the dates to its stored range.
  const applySeries = useCallback((next: InstantBacktestSeries | undefined) => {
    if (next === undefined) return;
    setSelectedSeries(seriesKey(next));
    setForm((current) => ({
      ...current,
      from: isoDate(next.firstT),
      to: isoDate(next.lastT),
    }));
  }, []);

  useEffect(() => {
    let active = true;
    gateway.series().then(
      (loaded) => {
        if (!active) return;
        setLoad({ series: loaded, type: "ready" });
        if (queryRead.current) {
          // A reload keeps the user's universe choice.
          applySeries(visibleSeries(loaded, universeRef.current).series[0]);
          return;
        }
        queryRead.current = true;
        const query = parseSweepQuery(currentSearch());
        setUniverse(query.universe);
        setForm((current) => ({
          ...current,
          dimensions: defaultDimensions(query.rule),
          metric: query.metric,
          params: { ...current.params, ruleKind: query.rule },
        }));
        applySeries(pickSeries(loaded, query.universe, query.symbol));
      },
      (error: unknown) => {
        if (!active) return;
        setLoad(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : {
                message: describeMarketDataFailure(error).message,
                type: "error",
              }
        );
      }
    );
    return () => {
      active = false;
    };
  }, [gateway, applySeries]);

  // Runs one sweep (a read: it computes on stored bars and stores nothing), from the cache when
  // the same request already ran. The metric is not part of the key: it only re-ranks.
  const run = useCallback(
    async (input: BacktestSweepRequest) => {
      const key = sweepRunKey(input);
      lastRun.current = key;
      latest.current += 1;
      const ticket = latest.current;
      let outcome:
        | Readonly<{ output: BacktestSweepOutput }>
        | Readonly<{ message: string }>;
      const cached = cache.get(key);
      if (cached === undefined) {
        setRunning(true);
        setMessage(null);
        try {
          const output = await gateway.sweep(input);
          cache.set(key, output);
          outcome = { output };
        } catch (error) {
          outcome = { message: describeMarketDataFailure(error).message };
        }
        // A newer sweep started meanwhile; its answer wins.
        if (ticket !== latest.current) return;
      } else outcome = { output: cached };
      setRunning(false);
      if ("message" in outcome) {
        setMessage(outcome.message);
        return;
      }
      setMessage(null);
      setResult({ output: outcome.output, request: input });
      setSweeps((count) => count + 1);
    },
    [cache, gateway]
  );

  const stored = load.type === "ready" ? load.series : [];
  const series = stored.find((entry) => seriesKey(entry) === selectedSeries);
  const request = series === undefined ? null : toSweepInput(form, series);
  const requestRef = useRef(request);
  requestRef.current = request;
  const autoKey = autoSweepKey(form, series);
  const settledKey = useDebouncedValue(autoKey, AUTO_RUN_DELAY_MS);

  // The default grid runs without a click: at once on open, then (debounced) after a universe,
  // series or rule change while the grid is still the default. An edited grid waits for
  // "Run sweep", and nothing here queues a stored job.
  useEffect(() => {
    const key = lastRun.current === null ? autoKey : settledKey;
    if (key === null || key !== autoKey || key === lastRun.current) return;
    const current = requestRef.current as Readonly<{
      input: BacktestSweepRequest;
    }>;
    void run(current.input);
  }, [autoKey, settledKey, run]);

  // Keeps the choices in the address bar; default values stay out of it.
  useEffect(() => {
    if (load.type !== "ready") return;
    writeQuery(
      {
        metric: form.metric,
        rule: form.params.ruleKind,
        symbol: selectedSeries,
        universe,
      },
      {
        metric: DEFAULT_SWEEP_METRIC,
        rule: DEFAULT_INSTANT_PARAMS.ruleKind,
        symbol: firstSeriesKey(load.series, universe),
        universe: DEFAULT_UNIVERSE_CHOICE,
      }
    );
  }, [load, universe, selectedSeries, form.metric, form.params.ruleKind]);

  if (load.type === "forbidden")
    return <OperatorAccessRequired feature="backtests" />;
  if (load.type === "loading")
    return <p className="text-muted-foreground text-sm">Loading series…</p>;
  if (load.type === "error")
    return (
      <p className="text-sm" role="alert">
        {load.message}
      </p>
    );

  const visible = visibleSeries(load.series, universe);
  const { params } = form;
  const used = new Set(form.dimensions.map((dimension) => dimension.param));
  const applicable = BACKTEST_SWEEP_PARAMS.filter((param) =>
    sweepParamApplies(param, params.ruleKind)
  );
  const unused = applicable.filter((param) => !used.has(param));
  const setParam = (key: keyof SweepForm["params"], value: number) =>
    setForm((current) => ({
      ...current,
      params: { ...current.params, [key]: value },
    }));
  const setDimensions = (dimensions: readonly SweepDimensionForm[]) =>
    setForm((current) => ({ ...current, dimensions }));

  const ruleFields =
    params.ruleKind === "smaCross"
      ? ([
          ["fast", "Fast average (bars)"],
          ["slow", "Slow average (bars)"],
        ] as const)
      : ([
          ["entryLookback", "Entry lookback (bars)"],
          ["exitLookback", "Exit lookback (bars)"],
          ["trendSma", "Trend average (bars, 0 = off)"],
        ] as const);

  return (
    <div className="grid gap-8">
      {load.series.length === 0 ? (
        <p className="text-sm">
          No stored bar series. Import bars with
          scripts/vertex-market-bars-import.ts first.
        </p>
      ) : null}
      <form
        className="grid gap-4 rounded-md border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (request !== null && "input" in request) void run(request.input);
        }}
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <UniverseSelect
            fallback={visible.fallback}
            onChange={(choice) => {
              setUniverse(choice);
              applySeries(visibleSeries(load.series, choice).series[0]);
            }}
            storedSymbols={load.series.map((entry) => entry.symbol)}
            value={universe}
          />
          <Select
            label="Symbol and timeframe"
            onChange={(value) => {
              const next = load.series.find(
                (entry) => seriesKey(entry) === value
              ) as InstantBacktestSeries;
              setSelectedSeries(value);
              setForm((current) => ({
                ...current,
                from: isoDate(next.firstT),
                to: isoDate(next.lastT),
              }));
            }}
            options={visible.series.map((entry) => ({
              label: `${entry.symbol} ${entry.timeframe} (${isoDate(entry.firstT)} to ${isoDate(entry.lastT)})`,
              value: seriesKey(entry),
            }))}
            value={selectedSeries}
          />
          <Select
            label="Rule"
            onChange={(value) => {
              const ruleKind = value === "breakout" ? "breakout" : "smaCross";
              setForm((current) => ({
                ...current,
                dimensions: defaultDimensions(ruleKind),
                params: { ...current.params, ruleKind },
              }));
            }}
            options={[
              { label: "Moving-average cross", value: "smaCross" },
              { label: "Breakout", value: "breakout" },
            ]}
            value={params.ruleKind}
          />
          <div className="grid gap-1">
            <label className="font-medium text-sm" htmlFor={fromId}>
              From
            </label>
            <input
              className={selectClass}
              id={fromId}
              onChange={(event) =>
                setForm((current) => ({ ...current, from: event.target.value }))
              }
              type="date"
              value={form.from}
            />
          </div>
          <div className="grid gap-1">
            <label className="font-medium text-sm" htmlFor={toId}>
              To
            </label>
            <input
              className={selectClass}
              id={toId}
              onChange={(event) =>
                setForm((current) => ({ ...current, to: event.target.value }))
              }
              type="date"
              value={form.to}
            />
          </div>
        </div>
        <fieldset className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <legend className="font-medium text-sm">
            Fixed settings (a swept parameter replaces its fixed value)
          </legend>
          {ruleFields.map(([key, label]) => (
            <NumberField
              key={key}
              label={label}
              onChange={(value) => setParam(key, value)}
              value={params[key]}
            />
          ))}
          <NumberField
            label="Stop-loss (%)"
            onChange={(value) => setParam("stopLossPct", value)}
            step={0.5}
            value={params.stopLossPct}
          />
          <NumberField
            label="Take-profit (%)"
            onChange={(value) => setParam("takeProfitPct", value)}
            value={params.takeProfitPct}
          />
          <NumberField
            label="Cost per side (bps)"
            onChange={(value) => setParam("costBps", value)}
            step={0.5}
            value={params.costBps}
          />
        </fieldset>
        {form.dimensions.map((dimension, position) => (
          <DimensionRow
            available={[
              dimension.param,
              ...unused.filter((param) => param !== dimension.param),
            ]}
            dimension={dimension}
            key={dimension.param}
            onChange={(next) =>
              setDimensions(
                form.dimensions.map((entry, at) =>
                  at === position ? next : entry
                )
              )
            }
            onRemove={
              form.dimensions.length > 1
                ? () =>
                    setDimensions(
                      form.dimensions.filter((_entry, at) => at !== position)
                    )
                : null
            }
            position={position}
          />
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <button
            className="min-h-11 rounded-md border px-4 text-sm disabled:opacity-60"
            disabled={
              unused.length === 0 ||
              form.dimensions.length >= BACKTEST_SWEEP_MAX_DIMENSIONS
            }
            onClick={() => {
              const param = unused[0] as SweepDimensionForm["param"];
              const value = params[param];
              setDimensions([
                ...form.dimensions,
                { from: value, param, step: 1, to: value + 4 },
              ]);
            }}
            type="button"
          >
            Add dimension
          </button>
          <button
            className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
            disabled={running || request === null || "error" in request}
            type="submit"
          >
            {running ? "Running sweep…" : "Run sweep"}
          </button>
          {request !== null && "error" in request ? (
            <p className="text-sm" role="status">
              {request.error}
            </p>
          ) : null}
          {message === null ? null : (
            <p className="text-sm" role="alert">
              {message}
            </p>
          )}
        </div>
      </form>
      {result === null ? null : (
        <SweepResults
          gateway={gateway}
          key={sweeps}
          metric={form.metric}
          onMetric={(metric) => setForm((current) => ({ ...current, metric }))}
          result={result}
        />
      )}
      <p className="text-muted-foreground text-xs">
        Each cell is one instant backtest (long only, next-open fills). A sweep
        is a screening result; it does not authorize a trade. Research only; no
        orders.
      </p>
    </div>
  );
};
