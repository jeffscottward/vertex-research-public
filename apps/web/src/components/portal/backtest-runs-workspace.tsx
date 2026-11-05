"use client";

import {
  type ApiClient,
  type BacktestRun,
  type BacktestRunReportOutput,
  type BacktestRunSubmitInput,
  type BacktestRunSummary,
  createApiClient,
  type InstantBacktestSeries,
} from "@darkfactory/api";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  COST_PROFILE_OPTIONS,
  costRows,
  describeRevision,
  describeUniverseBatch,
  describeUniversePlan,
  isFinished,
  isCostProfilePresetId,
  isoDate,
  metricRows,
  type RunForm,
  replayGeometry,
  toSubmitInput,
  toUniverseSubmitInputs,
} from "./backtest-runs-model.ts";
import {
  DEFAULT_UNIVERSE_CHOICE,
  parseUniverseChoice,
  UniverseSelect,
  universeChoiceLabel,
  visibleSeries,
} from "./backtest-universe.tsx";
import { DEFAULT_INSTANT_PARAMS } from "./instant-backtest-workspace.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";
import { NumberField } from "./number-field.tsx";

// Backtest runs: queue a run over a date range, follow it until it finishes, then read the report
// (metrics, equity and drawdown charts, trade list and trade-by-trade replay). Research only; no
// order path exists on this page or behind its API.

const LazyBacktestSeriesChart = lazy(async () => ({
  default: (await import("../../features/charts/backtest-series.tsx"))
    .BacktestSeriesChart,
}));

const POLL_MS = 1000;
const POLL_MAX = 300;
const STILL_RUNNING =
  "The run has not finished yet. Select it in Recent runs to check again.";
const REPLAY_WIDTH = 960;
const REPLAY_HEIGHT = 260;

export interface BacktestRunsGateway {
  readonly series: () => Promise<readonly InstantBacktestSeries[]>;
  readonly strategies: () => Promise<
    readonly Readonly<{ id: string; name: string }>[]
  >;
  readonly submit: (input: BacktestRunSubmitInput) => Promise<BacktestRun>;
  readonly get: (id: string) => Promise<BacktestRun>;
  readonly list: () => Promise<readonly BacktestRunSummary[]>;
}

export const createBacktestRunsGateway = (
  client: ApiClient
): BacktestRunsGateway => ({
  series: async () => (await client.instantBacktest.series()).series,
  strategies: async () =>
    (await client.strategyLibrary.list({ sort: "name" })).strategies.map(
      (strategy) => ({ id: strategy.id, name: strategy.name })
    ),
  submit: (input) => client.backtestRuns.submit(input),
  get: (id) => client.backtestRuns.get({ id }),
  list: async () => (await client.backtestRuns.list({ limit: 50 })).runs,
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserBacktestRunsGateway = (): BacktestRunsGateway => {
  const current = () =>
    createBacktestRunsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
  return {
    series: () => current().series(),
    strategies: () => current().strategies(),
    submit: (input) => current().submit(input),
    get: (id) => current().get(id),
    list: () => current().list(),
  };
};

const seriesKey = (series: InstantBacktestSeries): string =>
  `${series.symbol}:${series.timeframe}`;

const describeRule = ({ rule }: BacktestRun["spec"]): string => {
  if (rule.kind === "smaCross") return `SMA cross ${rule.fast}/${rule.slow}`;
  if (rule.kind === "dsl") return `Definition: ${rule.definition.name}`;
  return `Breakout ${rule.entryLookback}/${rule.exitLookback}${rule.trendSma > 0 ? `, trend ${rule.trendSma}` : ""}`;
};

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      series: readonly InstantBacktestSeries[];
      strategies: readonly Readonly<{ id: string; name: string }>[];
    }>;

const RunReplay = ({
  report,
}: Readonly<{ report: BacktestRunReportOutput }>) => {
  const total = report.trades.length;
  const [step, setStep] = useState(total);
  useEffect(() => setStep(total), [total]);
  const geometry = useMemo(
    () => replayGeometry(report, step, REPLAY_WIDTH, REPLAY_HEIGHT),
    [report, step]
  );
  const current = report.trades[step - 1];
  const sliderId = useId();
  return (
    <section aria-label="Trade replay" className="grid gap-3">
      <h3 className="font-semibold text-base">Trade replay</h3>
      <svg
        aria-label={`Close price with trades 1 to ${step} of ${total}`}
        className="h-auto w-full rounded-md border bg-background"
        role="img"
        viewBox={`0 0 ${REPLAY_WIDTH} ${REPLAY_HEIGHT}`}
      >
        <path
          d={geometry.path}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeWidth={1}
        />
        {geometry.cursorX === null ? null : (
          <line
            stroke="var(--vx-gold)"
            strokeDasharray="4 4"
            x1={geometry.cursorX}
            x2={geometry.cursorX}
            y1={0}
            y2={REPLAY_HEIGHT}
          />
        )}
        {geometry.markers.map((marker) => (
          <g key={marker.n} opacity={marker.current ? 1 : 0.55}>
            <line
              stroke={marker.win ? "var(--foreground)" : "var(--destructive)"}
              strokeWidth={marker.current ? 3 : 1.5}
              x1={marker.x1}
              x2={marker.x2}
              y1={marker.y1}
              y2={marker.y2}
            />
            <circle
              cx={marker.x1}
              cy={marker.y1}
              fill="var(--foreground)"
              r={3}
            />
            <circle
              cx={marker.x2}
              cy={marker.y2}
              fill={marker.win ? "var(--foreground)" : "var(--destructive)"}
              r={3}
            />
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="min-h-11 min-w-11 rounded-md border px-3 text-sm"
          disabled={step <= 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}
          type="button"
        >
          Previous trade
        </button>
        <label className="sr-only" htmlFor={sliderId}>
          Trades shown
        </label>
        <input
          className="min-h-11 flex-1"
          id={sliderId}
          max={total}
          min={0}
          onChange={(event) => setStep(Number(event.target.value))}
          type="range"
          value={step}
        />
        <button
          className="min-h-11 min-w-11 rounded-md border px-3 text-sm"
          disabled={step >= total}
          onClick={() => setStep((value) => Math.min(total, value + 1))}
          type="button"
        >
          Next trade
        </button>
        <span aria-live="polite" className="text-muted-foreground text-sm">
          {current === undefined
            ? `No trades shown (${total} total)`
            : `Trade ${current.n} of ${total}: ${isoDate(current.entryT)} to ${isoDate(current.exitT)}, P/L ${current.pnl.toFixed(2)}, balance ${current.balanceAfter.toFixed(2)}`}
        </span>
      </div>
    </section>
  );
};

const RunReport = ({ run }: Readonly<{ run: BacktestRun }>) => {
  const report = run.report;
  if (run.status === "failed")
    return (
      <p className="rounded-md border p-4 text-sm" role="alert">
        The backtest failed: {run.error}
      </p>
    );
  if (report === null)
    return (
      <p aria-live="polite" className="text-muted-foreground text-sm">
        The backtest is {run.status}.
      </p>
    );
  const equityPoints = report.equity.map((point) => ({
    t: new Date(point.t).toISOString(),
    value: point.equity,
  }));
  const drawdownPoints = report.equity.map((point) => ({
    t: new Date(point.t).toISOString(),
    value: -point.drawdownPct * 100,
  }));
  return (
    <div className="grid gap-6">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {[...costRows(report), ...metricRows(report.metrics)].map((row) => (
          <div
            className="flex justify-between gap-4 border-b py-1"
            key={row.label}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      <ChartRendererBoundary>
        <Suspense
          fallback={
            <p className="h-[220px] text-muted-foreground text-xs">
              Loading chart…
            </p>
          }
        >
          <LazyBacktestSeriesChart
            caption={`Equity in account currency. ${report.bars.toLocaleString("en-US")} bars.`}
            label="Equity curve"
            points={equityPoints}
            yLabel="Equity"
          />
          <LazyBacktestSeriesChart
            caption="Drawdown from the running equity peak, in percent."
            height={160}
            label="Drawdown"
            points={drawdownPoints}
            yLabel="Drawdown %"
          />
        </Suspense>
      </ChartRendererBoundary>
      <RunReplay report={report} />
      <section aria-label="Trades" className="grid gap-2">
        <h3 className="font-semibold text-base">
          Trades
          {report.tradesTruncated ? ` (first ${report.trades.length})` : ""}
        </h3>
        <div className="max-h-96 overflow-auto rounded-md border">
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 bg-background text-left">
              <tr>
                <th className="p-2">#</th>
                <th className="p-2">Entry</th>
                <th className="p-2">Exit</th>
                <th className="p-2">Entry price</th>
                <th className="p-2">Exit price</th>
                <th className="p-2">Units</th>
                <th className="p-2">P/L</th>
                <th className="p-2">Return</th>
                <th className="p-2">Exit reason</th>
                <th className="p-2">Balance</th>
              </tr>
            </thead>
            <tbody>
              {report.trades.map((trade) => (
                <tr className="border-t" key={trade.n}>
                  <td className="p-2">{trade.n}</td>
                  <td className="p-2">{isoDate(trade.entryT)}</td>
                  <td className="p-2">{isoDate(trade.exitT)}</td>
                  <td className="p-2">{trade.entryPrice.toFixed(2)}</td>
                  <td className="p-2">{trade.exitPrice.toFixed(2)}</td>
                  <td className="p-2">{trade.units.toFixed(2)}</td>
                  <td className="p-2">{trade.pnl.toFixed(2)}</td>
                  <td className="p-2">{(trade.netReturn * 100).toFixed(2)}%</td>
                  <td className="p-2">{trade.exitReason}</td>
                  <td className="p-2">{trade.balanceAfter.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-muted-foreground text-xs">
        Engine {run.engineVersion}. Data SHA-256{" "}
        {report.seriesSha256.slice(0, 12)}….
        {describeRevision(run)} Research only; no orders.
      </p>
    </div>
  );
};

export type BacktestRunsWorkspaceProps = Readonly<{
  gateway?: BacktestRunsGateway;
  initialRunId?: string | null;
  pollMs?: number;
  pollMax?: number;
}>;

export const BacktestRunsWorkspace = ({
  gateway: injected,
  initialRunId = null,
  pollMs = POLL_MS,
  pollMax = POLL_MAX,
}: BacktestRunsWorkspaceProps) => {
  const gateway = useMemo(
    () => injected ?? createBrowserBacktestRunsGateway(),
    [injected]
  );
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [selectedSeries, setSelectedSeries] = useState("");
  const [universe, setUniverse] = useState(DEFAULT_UNIVERSE_CHOICE);
  const [form, setForm] = useState<RunForm>({
    params: DEFAULT_INSTANT_PARAMS,
    from: "",
    to: "",
    initialCapital: 10_000,
    costProfile: "",
    strategyId: "",
  });
  const [runs, setRuns] = useState<readonly BacktestRunSummary[]>([]);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  // A link such as /backtest-runs?run=<id> (from the strategy builder) opens that run. The URL is
  // read after mount, so server and first client render stay equal.
  useEffect(() => {
    if (initialRunId !== null) return;
    const linked = new URLSearchParams(window.location.search).get("run");
    if (linked !== null && linked !== "") setRunId(linked);
  }, [initialRunId]);
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const seriesId = useId();
  const strategyId = useId();
  const costProfileId = useId();
  const ruleId = useId();
  const fromId = useId();
  const toId = useId();

  const refreshList = useCallback(() => {
    gateway.list().then(setRuns, () => undefined);
  }, [gateway]);

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
    Promise.all([gateway.series(), gateway.strategies()]).then(
      ([loadedSeries, strategies]) => {
        if (!active) return;
        setLoad({ type: "ready", series: loadedSeries, strategies });
        // A link such as /backtest-runs?strategy=<id>&universe=core7-futures (from the strategy
        // library) preselects the universe and the strategy. Read after load, like `run` above.
        const query = new URLSearchParams(window.location.search);
        const choice = parseUniverseChoice(query.get("universe"));
        setUniverse(choice);
        const linked = strategies.find(
          (strategy) => strategy.id === query.get("strategy")
        );
        if (linked !== undefined)
          setForm((current) => ({ ...current, strategyId: linked.id }));
        applySeries(visibleSeries(loadedSeries, choice).series[0]);
      },
      (error: unknown) => {
        if (!active) return;
        setLoad(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : {
                type: "error",
                message: describeMarketDataFailure(error).message,
              }
        );
      }
    );
    refreshList();
    return () => {
      active = false;
    };
  }, [gateway, refreshList, applySeries]);

  // Follow the selected run until it finishes, at most POLL_MAX reads.
  useEffect(() => {
    if (runId === null) return;
    let active = true;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      reads += 1;
      gateway.get(runId).then(
        (value) => {
          if (!active) return;
          setRun(value);
          if (isFinished(value)) refreshList();
          else if (reads < pollMax) timer = setTimeout(read, pollMs);
          else setMessage(STILL_RUNNING);
        },
        (error: unknown) => {
          if (active)
            setMessage(
              `${describeMarketDataFailure(error).message} Select the run in Recent runs to check again.`
            );
        }
      );
    };
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [gateway, runId, reload, pollMs, pollMax, refreshList]);

  if (load.type === "forbidden")
    return <OperatorAccessRequired feature="instant-backtest" />;
  if (load.type === "loading")
    return <p className="text-muted-foreground text-sm">Loading series…</p>;
  if (load.type === "error")
    return (
      <p className="text-sm" role="alert">
        {load.message}
      </p>
    );

  const series = load.series.find(
    (entry) => seriesKey(entry) === selectedSeries
  );
  const visible = visibleSeries(load.series, universe);
  // One run per series needs a universe with more than one stored series.
  const batchReady =
    universe !== "all" && !visible.fallback && visible.series.length > 1;
  const plan = toUniverseSubmitInputs(form, visible.series);
  const request = series === undefined ? null : toSubmitInput(form, series);
  const canRun = request !== null && !("error" in request);
  const setParam = (key: keyof RunForm["params"], value: number) =>
    setForm((current) => ({
      ...current,
      params: { ...current.params, [key]: value },
    }));

  const submit = async () => {
    if (request === null || "error" in request) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const created = await gateway.submit(request.input);
      setRun(created);
      setRunId(created.id);
      refreshList();
    } catch (error) {
      setMessage(describeMarketDataFailure(error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitUniverse = async () => {
    const label = universeChoiceLabel(universe);
    setSubmitting(true);
    setMessage(null);
    let submitted = 0;
    let failure: string | null = null;
    try {
      for (const input of plan.inputs) {
        await gateway.submit(input);
        submitted += 1;
      }
    } catch (error) {
      failure = describeMarketDataFailure(error).message;
    }
    setMessage(
      describeUniverseBatch({
        failure,
        label,
        notSubmitted: plan.inputs.length - submitted,
        plan,
        submitted,
      })
    );
    refreshList();
    setSubmitting(false);
  };

  const { params } = form;
  return (
    <div className="grid gap-8">
      {load.series.length === 0 ? (
        <p className="text-sm">
          No stored bar series. Import bars with
          scripts/vertex-market-bars-import.ts first.
        </p>
      ) : null}
      <form
        className="grid gap-4 rounded-md border p-4 md:grid-cols-2 lg:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UniverseSelect
          fallback={visible.fallback}
          onChange={(choice) => {
            setUniverse(choice);
            applySeries(visibleSeries(load.series, choice).series[0]);
          }}
          storedSymbols={load.series.map((entry) => entry.symbol)}
          value={universe}
        />
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={seriesId}>
            Symbol and timeframe
          </label>
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={seriesId}
            onChange={(event) => {
              const next = load.series.find(
                (entry) => seriesKey(entry) === event.target.value
              );
              setSelectedSeries(event.target.value);
              if (next !== undefined)
                setForm((current) => ({
                  ...current,
                  from: isoDate(next.firstT),
                  to: isoDate(next.lastT),
                }));
            }}
            value={selectedSeries}
          >
            {visible.series.map((entry) => (
              <option key={seriesKey(entry)} value={seriesKey(entry)}>
                {entry.symbol} {entry.timeframe} ({isoDate(entry.firstT)} to{" "}
                {isoDate(entry.lastT)})
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={strategyId}>
            Strategy (optional)
          </label>
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={strategyId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                strategyId: event.target.value,
              }))
            }
            value={form.strategyId}
          >
            <option value="">No linked strategy</option>
            {load.strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={ruleId}>
            Rule
          </label>
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={ruleId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                params: {
                  ...current.params,
                  ruleKind:
                    event.target.value === "breakout" ? "breakout" : "smaCross",
                },
              }))
            }
            value={params.ruleKind}
          >
            <option value="smaCross">Moving-average cross</option>
            <option value="breakout">Breakout</option>
          </select>
        </div>
        {params.ruleKind === "smaCross" ? (
          <>
            <NumberField
              label="Fast average (bars)"
              onChange={(v) => setParam("fast", v)}
              value={params.fast}
            />
            <NumberField
              label="Slow average (bars)"
              onChange={(v) => setParam("slow", v)}
              value={params.slow}
            />
          </>
        ) : (
          <>
            <NumberField
              label="Entry lookback (bars)"
              onChange={(v) => setParam("entryLookback", v)}
              value={params.entryLookback}
            />
            <NumberField
              label="Exit lookback (bars)"
              onChange={(v) => setParam("exitLookback", v)}
              value={params.exitLookback}
            />
            <NumberField
              label="Trend average (bars, 0 = off)"
              onChange={(v) => setParam("trendSma", v)}
              value={params.trendSma}
            />
          </>
        )}
        <NumberField
          label="Stop-loss (%)"
          onChange={(v) => setParam("stopLossPct", v)}
          step={0.5}
          value={params.stopLossPct}
        />
        <NumberField
          label="Take-profit (%)"
          onChange={(v) => setParam("takeProfitPct", v)}
          step={1}
          value={params.takeProfitPct}
        />
        <NumberField
          label="Cost per side (bps)"
          onChange={(v) => setParam("costBps", v)}
          step={0.5}
          value={params.costBps}
        />
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={costProfileId}>
            Cost profile
          </label>
          <select
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={costProfileId}
            onChange={(event) => {
              const value = event.target.value;
              setForm((current) => ({
                ...current,
                costProfile: isCostProfilePresetId(value) ? value : "",
              }));
            }}
            value={form.costProfile}
          >
            <option value="">None (flat cost only)</option>
            {COST_PROFILE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <NumberField
          label="Initial capital"
          onChange={(v) =>
            setForm((current) => ({ ...current, initialCapital: v }))
          }
          step={100}
          value={form.initialCapital}
        />
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={fromId}>
            From
          </label>
          <input
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
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
            className="min-h-11 rounded-md border bg-background px-3 text-sm"
            id={toId}
            onChange={(event) =>
              setForm((current) => ({ ...current, to: event.target.value }))
            }
            type="date"
            value={form.to}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3 md:col-span-2 lg:col-span-3">
          <button
            className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
            disabled={submitting || !canRun}
            type="submit"
          >
            {submitting ? "Queuing…" : "Run backtest"}
          </button>
          {batchReady ? (
            <button
              className="min-h-11 rounded-md border px-4 font-medium text-sm disabled:opacity-60"
              disabled={submitting || !canRun || plan.inputs.length === 0}
              onClick={() => {
                void submitUniverse();
              }}
              type="button"
            >
              Run on every series in {universeChoiceLabel(universe)}
            </button>
          ) : null}
          {batchReady ? (
            <p className="text-muted-foreground text-sm" data-universe-plan="">
              {describeUniversePlan(plan)}
            </p>
          ) : null}
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

      {run === null ? null : (
        <section aria-label="Backtest report" className="grid gap-4">
          <h2 className="font-semibold text-lg">
            {run.spec.symbol} {run.spec.timeframe}, {describeRule(run.spec)},{" "}
            {run.spec.from} to {run.spec.to}
          </h2>
          <RunReport run={run} />
        </section>
      )}

      <section aria-label="Recent runs" className="grid gap-2">
        <h2 className="font-semibold text-lg">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">No runs yet.</p>
        ) : (
          <ul className="grid gap-1" data-click-private="">
            {runs.map((entry) => (
              <li key={entry.id}>
                <button
                  aria-current={entry.id === runId ? "true" : undefined}
                  className="min-h-11 w-full rounded-md border px-3 text-left text-sm aria-[current=true]:border-primary"
                  onClick={() => {
                    setRun(null);
                    setMessage(null);
                    setRunId(entry.id);
                    // Re-reads the run even when it is already selected.
                    setReload((count) => count + 1);
                  }}
                  type="button"
                >
                  {entry.spec.symbol} {entry.spec.timeframe} ·{" "}
                  {describeRule(entry.spec)} · {entry.spec.from} to{" "}
                  {entry.spec.to} · {entry.status}
                  {entry.strategySnapshot === null
                    ? ""
                    : ` · ${entry.strategySnapshot.name}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
