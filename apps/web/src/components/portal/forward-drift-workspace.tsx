"use client";

import {
  type ApiClient,
  type BacktestRunSummary,
  createApiClient,
  type ForwardDriftAlert,
  type ForwardDriftCheckOutput,
  type ForwardDriftCreateInput,
  type ForwardDriftMonitor,
  type ForwardDriftMonitorSummary,
  type ForwardDriftRecordInput,
  type PaperForwardTickResult,
} from "@darkfactory/api";
import { StatusBadge } from "@darkfactory/ui";
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
import { describeMarketDataFailure } from "./market-data-client.ts";
import { describeRun } from "./portfolio-combos-workspace.tsx";

// Forward drift: pin a finished backtest run as the baseline, record paper equity points and closed
// paper trades, and read five drift checks with warn/alert levels. Open alerts form the in-app
// inbox at the top of the page. Paper data only; nothing here places or changes orders.

export interface ForwardDriftGateway {
  readonly acknowledge: (id: string) => Promise<ForwardDriftAlert>;
  readonly create: (
    input: ForwardDriftCreateInput
  ) => Promise<ForwardDriftMonitor>;
  readonly get: (id: string) => Promise<ForwardDriftMonitor>;
  readonly list: () => Promise<
    Readonly<{
      monitors: readonly ForwardDriftMonitorSummary[];
      openAlerts: readonly ForwardDriftAlert[];
    }>
  >;
  readonly paperSet: (
    id: string,
    running: boolean
  ) => Promise<ForwardDriftMonitor>;
  readonly paperTick: (id: string) => Promise<PaperForwardTickResult | null>;
  readonly record: (
    input: ForwardDriftRecordInput
  ) => Promise<
    Readonly<{ monitor: ForwardDriftMonitor; raised: ForwardDriftAlert[] }>
  >;
  readonly runs: () => Promise<readonly BacktestRunSummary[]>;
}

export const createForwardDriftGateway = (
  client: ApiClient
): ForwardDriftGateway => ({
  acknowledge: (id) => client.backtestRuns.drift.acknowledge({ id }),
  create: (input) => client.backtestRuns.drift.create(input),
  get: (id) => client.backtestRuns.drift.get({ id }),
  list: () => client.backtestRuns.drift.list({}),
  paperSet: (id, running) =>
    client.backtestRuns.drift.paperSet({ id, running }),
  paperTick: async (id) =>
    (await client.backtestRuns.drift.paperTick({ id })).results[0] ?? null,
  record: (input) => client.backtestRuns.drift.record(input),
  runs: async () => (await client.backtestRuns.list({ limit: 100 })).runs,
});

/** Builds the API client on each call, so server rendering never reads `window`. */
export const createBrowserForwardDriftGateway = (): ForwardDriftGateway => {
  const current = () =>
    createForwardDriftGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
  return {
    acknowledge: (id) => current().acknowledge(id),
    create: (input) => current().create(input),
    get: (id) => current().get(id),
    list: () => current().list(),
    paperSet: (id, running) => current().paperSet(id, running),
    paperTick: (id) => current().paperTick(id),
    record: (input) => current().record(input),
    runs: () => current().runs(),
  };
};

type Level = ForwardDriftCheckOutput["level"];

const LEVEL_STATUS: Readonly<
  Record<Level, "neutral" | "success" | "warning" | "destructive">
> = {
  alert: "destructive",
  insufficient: "neutral",
  ok: "success",
  warn: "warning",
};

const LEVEL_TEXT: Readonly<Record<Level, string>> = {
  alert: "Alert",
  insufficient: "Not enough data",
  ok: "OK",
  warn: "Warning",
};

const LevelBadge = ({ level }: Readonly<{ level: Level }>) => (
  <StatusBadge status={LEVEL_STATUS[level]}>{LEVEL_TEXT[level]}</StatusBadge>
);

/** Value text in the unit of the check. */
export const formatCheckValue = (
  key: ForwardDriftCheckOutput["key"],
  value: number | null
): string => {
  if (value === null) return "n/a";
  if (key === "drawdown" || key === "winRate")
    return `${(value * 100).toFixed(2)}%`;
  if (key === "losingStreak") return `${value}`;
  return value.toFixed(2);
};

const EPOCH_MS = /^\d+$/u;
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/u;

/**
 * Epoch milliseconds, or an ISO date or date-time; no zone means UTC. NaN otherwise, including a
 * day that the month does not have (Date.parse would roll 2026-02-30 over to March).
 */
const parseTime = (stamp: string): number => {
  if (EPOCH_MS.test(stamp)) return Number(stamp);
  const match = ISO_TIME.exec(stamp);
  if (match === null) return Number.NaN;
  const [, year, month, day, clock = "T00:00", zone = "Z"] = match;
  const calendar = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );
  if (
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day)
  )
    return Number.NaN;
  return Date.parse(`${year}-${month}-${day}${clock}${zone}`);
};

export type ParsedRows = Readonly<
  | { ok: true; rows: { t: number; value: number }[] }
  | { ok: false; message: string }
>;

/**
 * Parses "time, value" lines. Time is epoch milliseconds or an ISO date or date-time (UTC when no
 * zone is given); value is a number. Empty lines are skipped. The first bad line stops the parse.
 */
export const parseRows = (text: string, valueName: string): ParsedRows => {
  const rows: { t: number; value: number }[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const [time, value, ...extra] = line.split(/[\s,;]+/u);
    const t = parseTime(String(time));
    const parsed = Number(value);
    if (
      extra.length > 0 ||
      value === undefined ||
      !Number.isFinite(t) ||
      !Number.isFinite(parsed)
    )
      return {
        message: `Line ${index + 1}: expected "time, ${valueName}"`,
        ok: false,
      };
    rows.push({ t, value: parsed });
  }
  return { ok: true, rows };
};

const CHART_WIDTH = 960;
const CHART_HEIGHT = 220;

/**
 * SVG paths of the baseline and forward equity, each as a ratio of its first value, on one value
 * scale. Each series uses its own time axis (index spread over the width), so their shapes compare.
 */
export const comparePaths = (
  baseline: readonly Readonly<{ equity: number }>[],
  forward: readonly Readonly<{ equity: number }>[],
  width: number,
  height: number
): Readonly<{ baseline: string; forward: string }> => {
  const ratios = (series: readonly Readonly<{ equity: number }>[]) => {
    const first = series[0]?.equity ?? 1;
    return series.map((point) => point.equity / first);
  };
  const base = ratios(baseline);
  const ahead = ratios(forward);
  const all = [...base, ...ahead];
  const low = Math.min(...all, 1);
  const range = Math.max(1e-9, Math.max(...all, 1) - low);
  const path = (values: readonly number[]) =>
    values
      .map(
        (value, index) =>
          `${index === 0 ? "M" : "L"}${((index / Math.max(1, values.length - 1)) * width).toFixed(1)},${(height - ((value - low) / range) * height).toFixed(1)}`
      )
      .join(" ");
  return { baseline: path(base), forward: path(ahead) };
};

const time = (value: Date): string =>
  value.toISOString().replace("T", " ").slice(0, 16);

const AlertList = ({
  alerts,
  labels,
  onAcknowledge,
  busy,
}: Readonly<{
  alerts: readonly ForwardDriftAlert[];
  labels: Readonly<Record<string, string>>;
  onAcknowledge?: (id: string) => void;
  busy: boolean;
}>) =>
  alerts.length === 0 ? (
    <p className="text-muted-foreground text-sm">No open drift alerts.</p>
  ) : (
    <ul className="grid gap-2">
      {alerts.map((alert) => (
        <li
          className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
          key={alert.id}
        >
          <LevelBadge level={alert.level} />
          <span className="font-medium">
            {labels[alert.monitorId] ?? "Monitor"}
          </span>
          <span className="min-w-0 flex-1 break-words">{alert.message}</span>
          <span className="text-muted-foreground tabular-nums">
            {time(alert.createdAt)}
          </span>
          {onAcknowledge === undefined || alert.acknowledgedAt !== null ? (
            <span className="text-muted-foreground">
              {alert.acknowledgedAt === null ? "Open" : "Acknowledged"}
            </span>
          ) : (
            <button
              className="min-h-11 rounded-md border px-4 font-medium"
              disabled={busy}
              onClick={() => onAcknowledge(alert.id)}
              type="button"
            >
              Acknowledge
            </button>
          )}
        </li>
      ))}
    </ul>
  );

const ChecksTable = ({
  checks,
}: Readonly<{ checks: readonly ForwardDriftCheckOutput[] }>) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Drift checks</caption>
      <thead>
        <tr className="border-b">
          {[
            "Check",
            "Baseline",
            "Paper",
            "Ratio",
            "Warn at",
            "Alert at",
            "Level",
            "Detail",
          ].map((heading) => (
            <th className="px-2 py-2 font-medium" key={heading} scope="col">
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {checks.map((check) => (
          <tr className="border-b align-top" key={check.key}>
            <th className="px-2 py-2 font-medium" scope="row">
              {check.label}
            </th>
            <td className="px-2 py-2 tabular-nums">
              {formatCheckValue(check.key, check.baseline)}
            </td>
            <td className="px-2 py-2 tabular-nums">
              {formatCheckValue(check.key, check.forward)}
            </td>
            <td className="px-2 py-2 tabular-nums">
              {check.ratio === null ? "n/a" : check.ratio.toFixed(2)}
            </td>
            <td className="px-2 py-2 tabular-nums">{check.warnAt}</td>
            <td className="px-2 py-2 tabular-nums">{check.alertAt}</td>
            <td className="px-2 py-2">
              <LevelBadge level={check.level} />
            </td>
            <td className="px-2 py-2 text-muted-foreground">
              {check.reason} ({check.sample}/{check.minSample} samples)
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const RecordForm = ({
  monitor,
  onRecorded,
  gateway,
}: Readonly<{
  monitor: ForwardDriftMonitor;
  onRecorded: (
    result: Readonly<{
      monitor: ForwardDriftMonitor;
      raised: ForwardDriftAlert[];
    }>
  ) => void;
  gateway: ForwardDriftGateway;
}>) => {
  const pointsId = useId();
  const tradesId = useId();
  const [points, setPoints] = useState("");
  const [trades, setTrades] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const parsedPoints = parseRows(points, "equity");
    const parsedTrades = parseRows(trades, "pnl");
    if (!parsedPoints.ok) return setFailure(parsedPoints.message);
    if (!parsedTrades.ok) return setFailure(parsedTrades.message);
    setBusy(true);
    setFailure(null);
    try {
      onRecorded(
        await gateway.record({
          id: monitor.id,
          points: parsedPoints.rows.map((row) => ({
            equity: row.value,
            t: row.t,
          })),
          source: "paper",
          trades: parsedTrades.rows.map((row) => ({
            pnl: row.value,
            t: row.t,
          })),
        })
      );
      setPoints("");
      setTrades("");
    } catch (error) {
      setFailure(describeMarketDataFailure(error).message);
    } finally {
      setBusy(false);
    }
  }, [gateway, monitor.id, onRecorded, points, trades]);

  return (
    <section aria-label="Record paper results" className="grid gap-3">
      <h3 className="font-semibold">Record paper results</h3>
      <p className="text-muted-foreground text-sm">
        One line per value: time (ISO date or epoch milliseconds), then the
        value. New lines must be later than the stored ones. Paper data only.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={pointsId}>
            Paper equity points (time, equity)
          </label>
          <textarea
            className="min-h-32 rounded-md border bg-background p-3 font-mono text-sm"
            id={pointsId}
            onChange={(event) => setPoints(event.target.value)}
            placeholder={"2026-10-01, 10000\n2026-10-02, 10120"}
            value={points}
          />
        </div>
        <div className="grid gap-1">
          <label className="font-medium text-sm" htmlFor={tradesId}>
            Closed paper trades (time, pnl)
          </label>
          <textarea
            className="min-h-32 rounded-md border bg-background p-3 font-mono text-sm"
            id={tradesId}
            onChange={(event) => setTrades(event.target.value)}
            placeholder={"2026-10-02, 120\n2026-10-03, -45"}
            value={trades}
          />
        </div>
      </div>
      <div>
        <button
          className="min-h-11 rounded-md border px-4 font-medium text-sm"
          disabled={busy || (points.trim() === "" && trades.trim() === "")}
          onClick={() => {
            void submit();
          }}
          type="button"
        >
          Record and check drift
        </button>
      </div>
      {failure === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
};

/** One-line summary of a paper tick for the status line. */
const describeTick = (result: PaperForwardTickResult | null): string =>
  result === null
    ? "The tick found no monitor"
    : `Tick: ${result.newPoints} points, ${result.newTrades} trades, ${result.raised} new alerts${result.note === null ? "" : `. ${result.note}`}`;

const PaperRunner = ({
  monitor,
  gateway,
  onChanged,
}: Readonly<{
  monitor: ForwardDriftMonitor;
  gateway: ForwardDriftGateway;
  onChanged: (monitor: ForwardDriftMonitor) => void;
}>) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = monitor.paper.status === "running";

  const run = useCallback(
    async (work: () => Promise<ForwardDriftMonitor>) => {
      setBusy(true);
      setFailure(null);
      try {
        onChanged(await work());
      } catch (error) {
        setFailure(describeMarketDataFailure(error).message);
      } finally {
        setBusy(false);
      }
    },
    [onChanged]
  );

  return (
    <section aria-label="Paper forward runner" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Paper forward runner</h3>
        <StatusBadge status={running ? "success" : "neutral"}>
          {running ? "Running" : "Stopped"}
        </StatusBadge>
      </div>
      <p className="text-muted-foreground text-sm">
        Runs the baseline strategy on new stored bars after the backtest end
        date, with simulated fills and the run's cost settings. Paper only: no
        broker connection and no orders. The scheduler ticks every running
        runner.
      </p>
      <p className="text-sm">
        Last tick:{" "}
        {monitor.paper.tickedAt === null
          ? "never"
          : time(monitor.paper.tickedAt)}
        {monitor.paper.note === null ? "" : ` (${monitor.paper.note})`}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          className="min-h-11 rounded-md border px-4 font-medium text-sm"
          disabled={busy}
          onClick={() => {
            setMessage(null);
            void run(() => gateway.paperSet(monitor.id, !running));
          }}
          type="button"
        >
          {running ? "Stop paper runner" : "Start paper runner"}
        </button>
        <button
          className="min-h-11 rounded-md border px-4 font-medium text-sm"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              setMessage(describeTick(await gateway.paperTick(monitor.id)));
              return gateway.get(monitor.id);
            });
          }}
          type="button"
        >
          Run one tick now
        </button>
      </div>
      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
      {failure === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
};

const DriftPanel = ({
  monitor,
  gateway,
  onRecorded,
  raised,
}: Readonly<{
  monitor: ForwardDriftMonitor;
  gateway: ForwardDriftGateway;
  onRecorded: (
    result: Readonly<{
      monitor: ForwardDriftMonitor;
      raised: ForwardDriftAlert[];
    }>
  ) => void;
  raised: readonly ForwardDriftAlert[];
}>) => {
  const paths = comparePaths(
    monitor.baseline.equity,
    monitor.points,
    CHART_WIDTH,
    CHART_HEIGHT
  );
  return (
    <section aria-label="Drift panel" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-lg">{monitor.label}</h2>
        <LevelBadge level={monitor.level} />
      </div>
      <p className="text-muted-foreground text-sm">
        Baseline: {monitor.baseline.label} ({monitor.baseline.engineVersion}
        {monitor.strategyRevision === null
          ? ", no strategy revision"
          : `, revision ${monitor.strategyRevision.slice(0, 12)}`}
        ). Paper: {monitor.pointCount} points, {monitor.tradeCount} trades.
      </p>
      {raised.length === 0 ? null : (
        <p className="text-sm" role="status">
          New alerts from this recording: {raised.length}
        </p>
      )}
      <ChecksTable checks={monitor.checks} />
      <figure className="grid gap-2">
        <svg
          aria-label="Baseline and paper equity, each from its own start"
          className="h-auto w-full rounded-md border bg-background"
          role="img"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        >
          <path
            d={paths.baseline}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeDasharray="6 4"
            strokeWidth={1.25}
          />
          <path
            d={paths.forward}
            fill="none"
            stroke="var(--vx-gold)"
            strokeWidth={2}
          />
        </svg>
        <figcaption className="text-muted-foreground text-xs">
          Dashed: backtest baseline. Solid: paper. Both start at 1.
        </figcaption>
      </figure>
      <PaperRunner
        gateway={gateway}
        key={`paper-${monitor.id}`}
        monitor={monitor}
        onChanged={(next) => onRecorded({ monitor: next, raised: [] })}
      />
      <RecordForm
        gateway={gateway}
        key={monitor.id}
        monitor={monitor}
        onRecorded={onRecorded}
      />
      <section aria-label="Monitor alerts" className="grid gap-2">
        <h3 className="font-semibold">Alerts for this monitor</h3>
        <AlertList
          alerts={monitor.alerts}
          busy={false}
          labels={{ [monitor.id]: monitor.label }}
        />
      </section>
    </section>
  );
};

const NewMonitorForm = ({
  busy,
  first,
  onCreate,
  runs,
}: Readonly<{
  busy: boolean;
  first: BacktestRunSummary;
  onCreate: (input: ForwardDriftCreateInput) => void;
  runs: readonly BacktestRunSummary[];
}>) => {
  const [baselineId, setBaselineId] = useState(first.id);
  const [label, setLabel] = useState("");
  const baselineFieldId = useId();
  const labelFieldId = useId();
  const baseline = runs.find((run) => run.id === baselineId) ?? first;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <label className="font-medium text-sm" htmlFor={baselineFieldId}>
          Baseline backtest run
        </label>
        <select
          className="min-h-11 max-w-full rounded-md border bg-background px-3 text-sm"
          id={baselineFieldId}
          onChange={(event) => setBaselineId(event.target.value)}
          value={baseline.id}
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {describeRun(run)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <label className="font-medium text-sm" htmlFor={labelFieldId}>
          Monitor name
        </label>
        <input
          className="min-h-11 rounded-md border bg-background px-3 text-sm"
          id={labelFieldId}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
      </div>
      <button
        className="min-h-11 rounded-md border px-4 font-medium text-sm"
        disabled={busy || label.trim() === ""}
        onClick={() => {
          onCreate({
            baselineRunId: baseline.id,
            expectedRevision: baseline.strategyRevision,
            label: label.trim(),
          });
          setLabel("");
        }}
        type="button"
      >
        Create monitor
      </button>
    </div>
  );
};

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      runs: readonly BacktestRunSummary[];
      monitors: readonly ForwardDriftMonitorSummary[];
      openAlerts: readonly ForwardDriftAlert[];
    }>;

export const ForwardDriftWorkspace = ({
  gateway,
}: Readonly<{ gateway?: ForwardDriftGateway }>) => {
  const api = useMemo(
    () => gateway ?? createBrowserForwardDriftGateway(),
    [gateway]
  );
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [selected, setSelected] = useState<ForwardDriftMonitor | null>(null);
  const [raised, setRaised] = useState<readonly ForwardDriftAlert[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [runs, listed] = await Promise.all([api.runs(), api.list()]);
      setState({
        monitors: listed.monitors,
        openAlerts: listed.openAlerts,
        runs: runs.filter((run) => run.status === "succeeded"),
        type: "ready",
      });
    } catch (error) {
      setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { message: describeMarketDataFailure(error).message, type: "error" }
      );
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setFailure(null);
      try {
        await work();
        await reload();
      } catch (error) {
        setFailure(describeMarketDataFailure(error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  // A recording can finish after the operator opened another monitor; keep that monitor shown.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    shownId.current = selected?.id ?? null;
  }, [selected]);

  const onRecorded = useCallback(
    (
      result: Readonly<{
        monitor: ForwardDriftMonitor;
        raised: ForwardDriftAlert[];
      }>
    ) => {
      if (shownId.current === result.monitor.id) {
        setSelected(result.monitor);
        setRaised(result.raised);
      }
      void reload();
    },
    [reload]
  );

  if (state.type === "loading")
    return (
      <p className="text-sm" role="status">
        Loading drift monitors
      </p>
    );
  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="instant-backtest" />;
  if (state.type === "error")
    return (
      <p className="text-destructive text-sm" role="alert">
        {state.message}
      </p>
    );

  const labels = Object.fromEntries(
    state.monitors.map((monitor) => [monitor.id, monitor.label])
  );

  return (
    <div className="grid gap-8">
      <p className="text-muted-foreground text-sm">
        Paper data only. An alert compares paper results with the backtest that
        is the baseline; it does not change, stop or place anything.
      </p>
      <section aria-label="Open drift alerts" className="grid gap-3">
        <h2 className="font-semibold text-lg">
          Open drift alerts ({state.openAlerts.length})
        </h2>
        <AlertList
          alerts={state.openAlerts}
          busy={busy}
          labels={labels}
          onAcknowledge={(id) => {
            void act(async () => {
              await api.acknowledge(id);
              if (selected !== null) setSelected(await api.get(selected.id));
            });
          }}
        />
      </section>
      <section aria-label="Monitors" className="grid gap-3">
        <h2 className="font-semibold text-lg">Monitors</h2>
        {state.monitors.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No drift monitors yet. Create one from a finished backtest run.
          </p>
        ) : (
          <ul className="grid gap-2">
            {state.monitors.map((monitor) => (
              <li
                className="flex flex-wrap items-center gap-3 text-sm"
                key={monitor.id}
              >
                <LevelBadge level={monitor.level} />
                <button
                  aria-current={
                    selected?.id === monitor.id ? "true" : undefined
                  }
                  className="min-h-11 rounded-md border px-4 font-medium"
                  disabled={busy}
                  onClick={() => {
                    // A recording for the old monitor that ends now must not change this panel.
                    shownId.current = monitor.id;
                    void act(async () => {
                      const next = await api.get(monitor.id);
                      setRaised([]);
                      setSelected(next);
                    });
                  }}
                  type="button"
                >
                  {monitor.label}
                </button>
                <span className="text-muted-foreground tabular-nums">
                  {monitor.pointCount} points, {monitor.tradeCount} trades
                  {monitor.paper.status === "running"
                    ? ", paper runner on"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="New monitor" className="grid gap-3">
        <h2 className="font-semibold text-lg">New monitor</h2>
        {state.runs[0] === undefined ? (
          <p className="text-sm">
            No finished backtest runs. Run a backtest on the Backtest runs page
            first.
          </p>
        ) : (
          <NewMonitorForm
            busy={busy}
            first={state.runs[0]}
            onCreate={(input) => {
              shownId.current = null;
              void act(async () => {
                const created = await api.create(input);
                setRaised([]);
                setSelected(created);
              });
            }}
            runs={state.runs}
          />
        )}
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </section>
      {selected === null ? null : (
        <DriftPanel
          gateway={api}
          monitor={selected}
          onRecorded={onRecorded}
          raised={raised}
        />
      )}
    </div>
  );
};
