"use client";

import {
  type ApiClient,
  createApiClient,
  type InstantBacktestRunInput,
  type InstantBacktestRunOutput,
  type InstantBacktestSeries,
  type InstantBacktestSeriesListOutput,
} from "@darkfactory/api";
import { StatCard } from "@darkfactory/ui";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  DEFAULT_UNIVERSE_CHOICE,
  firstSeriesKey,
  UniverseSelect,
  visibleSeries,
} from "./backtest-universe.tsx";
import {
  createBrowserEngineComparisonGateway,
  type EngineComparisonGateway,
  NautilusCard,
  TypeScriptEngineLine,
} from "./engine-comparison.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";

// Instant backtest: parameter changes run the backtest again with at most one request in flight;
// only the newest parameters are shown. The page never reloads. Research only; no orders.

const LazyBacktestSeriesChart = lazy(async () => ({
  default: (await import("../../features/charts/backtest-series.tsx"))
    .BacktestSeriesChart,
}));

export interface InstantBacktestGateway {
  readonly run: (
    input: InstantBacktestRunInput
  ) => Promise<InstantBacktestRunOutput>;
  readonly series: () => Promise<InstantBacktestSeriesListOutput>;
}

const createGateway = (client: ApiClient): InstantBacktestGateway => ({
  run: (input) => client.instantBacktest.run(input),
  series: () => client.instantBacktest.series(),
});

const createBrowserInstantBacktestGateway = (): InstantBacktestGateway => {
  let gateway: InstantBacktestGateway | undefined;
  const current = () => {
    gateway ??= createGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    run: (input: InstantBacktestRunInput) => current().run(input),
    series: () => current().series(),
  });
};

export type InstantParams = Readonly<{
  ruleKind: "smaCross" | "breakout";
  fast: number;
  slow: number;
  entryLookback: number;
  exitLookback: number;
  trendSma: number;
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
}>;

export const DEFAULT_INSTANT_PARAMS: InstantParams = {
  costBps: 2,
  entryLookback: 20,
  exitLookback: 10,
  fast: 50,
  ruleKind: "smaCross",
  slow: 200,
  stopLossPct: 0,
  takeProfitPct: 0,
  trendSma: 0,
};

type NumericParam = Exclude<keyof InstantParams, "ruleKind">;

type FieldSpec = Readonly<{
  key: NumericParam;
  label: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}>;

const WINDOW_FIELDS: Record<InstantParams["ruleKind"], readonly FieldSpec[]> = {
  breakout: [
    {
      key: "entryLookback",
      label: "Entry: close above high of last N bars",
      max: 500,
      min: 1,
      step: 1,
    },
    {
      key: "exitLookback",
      label: "Exit: close below low of last N bars",
      max: 500,
      min: 1,
      step: 1,
    },
    {
      hint: "0 turns the filter off.",
      key: "trendSma",
      label: "Trend filter: close above average of N bars",
      max: 1000,
      min: 0,
      step: 1,
    },
  ],
  smaCross: [
    { key: "fast", label: "Fast average (bars)", max: 500, min: 1, step: 1 },
    { key: "slow", label: "Slow average (bars)", max: 1000, min: 2, step: 1 },
  ],
};

const RISK_FIELDS: readonly FieldSpec[] = [
  {
    hint: "0 turns the stop off.",
    key: "stopLossPct",
    label: "Stop-loss (% below entry)",
    max: 50,
    min: 0,
    step: 0.5,
  },
  {
    hint: "0 turns the target off.",
    key: "takeProfitPct",
    label: "Take-profit (% above entry)",
    max: 200,
    min: 0,
    step: 1,
  },
  {
    key: "costBps",
    label: "Cost per side (basis points)",
    max: 50,
    min: 0,
    step: 0.5,
  },
];

const seriesKey = (series: InstantBacktestSeries): string =>
  `${series.symbol}:${series.timeframe}`;

/** Builds the run request, or returns the reason the parameters cannot run. */
export const toRunInput = (
  params: InstantParams,
  series: Pick<InstantBacktestSeries, "symbol" | "timeframe">
):
  | Readonly<{ input: InstantBacktestRunInput }>
  | Readonly<{ error: string }> => {
  const fields = [...WINDOW_FIELDS[params.ruleKind], ...RISK_FIELDS];
  for (const field of fields) {
    const value = params[field.key];
    const whole = field.step === 1 ? Number.isInteger(value) : true;
    if (!(whole && value >= field.min && value <= field.max)) {
      return {
        error: `${field.label} must be ${field.step === 1 ? "a whole number " : ""}from ${field.min} to ${field.max}.`,
      };
    }
  }
  if (params.ruleKind === "smaCross" && params.fast >= params.slow) {
    return { error: "The fast average must be shorter than the slow average." };
  }
  return {
    input: {
      costBps: params.costBps,
      rule:
        params.ruleKind === "smaCross"
          ? { fast: params.fast, kind: "smaCross", slow: params.slow }
          : {
              entryLookback: params.entryLookback,
              exitLookback: params.exitLookback,
              kind: "breakout",
              trendSma: params.trendSma,
            },
      stopLossPct: params.stopLossPct,
      symbol: series.symbol,
      takeProfitPct: params.takeProfitPct,
      timeframe: series.timeframe,
    },
  };
};

export const formatPercent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const formatRatio = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(2);

const formatDate = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 10);

type SeriesState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; series: readonly InstantBacktestSeries[] }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>;

type RunResult = Readonly<{
  output: InstantBacktestRunOutput;
  roundTripMs: number;
}>;

type PendingRun = Readonly<{
  input: InstantBacktestRunInput;
  started: number;
}>;

type RunState = Readonly<{
  status: "idle" | "running" | "ready" | "error";
  result: RunResult | null;
  message: string | null;
}>;

const ParamField = ({
  spec,
  value,
  onChange,
}: {
  readonly spec: FieldSpec;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) => {
  const id = useId();
  const update = (raw: string) => {
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
  };
  return (
    <div className="space-y-1">
      <label className="block font-medium text-sm" htmlFor={id}>
        {spec.label}
      </label>
      <div className="flex items-center gap-3">
        <input
          aria-label={`${spec.label} slider`}
          className="h-11 min-w-0 flex-1 accent-primary"
          max={spec.max}
          min={spec.min}
          onChange={(event) => update(event.currentTarget.value)}
          step={spec.step}
          type="range"
          value={value}
        />
        <input
          className="h-11 w-24 rounded-md border border-input bg-transparent px-2 text-right text-sm tabular-nums"
          id={id}
          max={spec.max}
          min={spec.min}
          onChange={(event) => update(event.currentTarget.value)}
          step={spec.step}
          type="number"
          value={value}
        />
      </div>
      {spec.hint === undefined ? null : (
        <p className="text-muted-foreground text-xs">{spec.hint}</p>
      )}
    </div>
  );
};

const selectClass =
  "h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm";

const Results = ({ result }: { readonly result: RunResult }) => {
  const { output } = result;
  const { stats, series } = output;
  const points = useMemo(
    () =>
      output.equity.map((point) => ({
        t: new Date(point.t).toISOString(),
        value: point.equity,
      })),
    [output.equity]
  );
  const cards: readonly [string, string][] = [
    ["Total return", formatPercent(stats.totalReturn)],
    ["CAGR", formatPercent(stats.cagr)],
    ["Max drawdown", formatPercent(stats.maxDrawdown)],
    ["Sharpe", formatRatio(stats.sharpe)],
    ["Sortino", formatRatio(stats.sortino)],
    ["Trades", String(stats.trades)],
    ["Win rate", formatPercent(stats.winRate)],
    ["Profit factor", formatRatio(stats.profitFactor)],
    ["Time in market", formatPercent(stats.exposure)],
    ["Buy and hold", formatPercent(stats.buyHoldReturn)],
  ];
  return (
    <div className="space-y-4" data-instant-results="ready">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {cards.map(([label, value]) => (
          <StatCard
            className="px-4 py-4"
            data-stat={label}
            key={label}
            label={label}
            value={value}
          />
        ))}
      </div>
      <ChartRendererBoundary>
        <Suspense
          fallback={
            <p className="h-[220px] text-muted-foreground text-xs">
              Loading chart…
            </p>
          }
        >
          <LazyBacktestSeriesChart
            caption={`Equity, start = 1. ${stats.bars.toLocaleString("en-US")} bars; chart shows ${points.length.toLocaleString("en-US")} points.`}
            label="Strategy equity curve"
            points={points}
            yLabel="Equity"
          />
        </Suspense>
      </ChartRendererBoundary>
      <p className="text-muted-foreground text-xs">
        Data: {series.source}. {series.barCount.toLocaleString("en-US")} bars,{" "}
        {formatDate(series.firstT)} to {formatDate(series.lastT)}. Source
        SHA-256 {series.sourceSha256.slice(0, 12)}…. Buy-and-hold max drawdown{" "}
        {formatPercent(stats.buyHoldMaxDrawdown)}.
      </p>
    </div>
  );
};

const statusText = (run: RunState): string => {
  if (run.status === "error") return run.message as string;
  if (run.status !== "ready") return "Running…";
  const { output, roundTripMs } = run.result as RunResult;
  return `Updated in ${Math.round(roundTripMs)} ms (server compute ${output.timing.computeMs.toFixed(1)} ms, bar load ${output.timing.loadMs.toFixed(1)} ms, cache ${output.timing.cache}).`;
};

export interface InstantBacktestWorkspaceProps {
  /** Engine comparison: where the Nautilus status of a run is read. */
  readonly comparisonGateway?: EngineComparisonGateway;
  readonly gateway?: InstantBacktestGateway;
}

export const InstantBacktestWorkspace = ({
  gateway: injected,
  comparisonGateway: injectedComparisons,
}: InstantBacktestWorkspaceProps) => {
  const gateway = useMemo(
    () => injected ?? createBrowserInstantBacktestGateway(),
    [injected]
  );
  const comparisonGateway = useMemo(
    () => injectedComparisons ?? createBrowserEngineComparisonGateway(),
    [injectedComparisons]
  );
  const [seriesState, setSeriesState] = useState<SeriesState>({
    type: "loading",
  });
  const [selected, setSelected] = useState("");
  const [universe, setUniverse] = useState(DEFAULT_UNIVERSE_CHOICE);
  const universeRef = useRef(universe);
  universeRef.current = universe;
  const [params, setParams] = useState(DEFAULT_INSTANT_PARAMS);
  const [run, setRun] = useState<RunState>({
    message: null,
    result: null,
    status: "idle",
  });
  const generation = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef<PendingRun | null>(null);
  const seriesId = useId();
  const ruleId = useId();

  useEffect(() => {
    let active = true;
    gateway.series().then(
      (output) => {
        if (!active) return;
        setSeriesState({ series: output.series, type: "ready" });
        // A reload keeps the user's universe choice; only the series pick follows it.
        setSelected(firstSeriesKey(output.series, universeRef.current));
      },
      (error: unknown) => {
        if (!active) return;
        setSeriesState(
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
  }, [gateway]);

  const series =
    seriesState.type === "ready"
      ? seriesState.series.find((entry) => seriesKey(entry) === selected)
      : undefined;
  const request = useMemo(
    () => (series === undefined ? null : toRunInput(params, series)),
    [params, series]
  );

  // At most one run request is in flight. Changes made meanwhile replace one queued request, so a
  // slider drag sends the newest parameters next instead of one request per input event.
  const send = useCallback(
    (pending: PendingRun) => {
      inFlight.current = true;
      const mine = generation.current;
      const sendQueued = (): boolean => {
        inFlight.current = false;
        const next = queued.current;
        queued.current = null;
        if (next === null) return false;
        send(next);
        return true;
      };
      gateway.run(pending.input).then(
        (output) => {
          if (sendQueued() || mine !== generation.current) return;
          setRun({
            message: null,
            result: {
              output,
              roundTripMs: performance.now() - pending.started,
            },
            status: "ready",
          });
        },
        (error: unknown) => {
          if (sendQueued() || mine !== generation.current) return;
          setRun((previous) => ({
            ...previous,
            message: describeMarketDataFailure(error).message,
            status: "error",
          }));
        }
      );
    },
    [gateway]
  );

  useEffect(() => {
    if (request === null) return;
    generation.current += 1;
    if ("error" in request) {
      // Invalid inputs: drop the old result, the queued request and any response in flight.
      queued.current = null;
      setRun({ message: null, result: null, status: "idle" });
      return;
    }
    setRun((previous) => ({ ...previous, message: null, status: "running" }));
    const pending = { input: request.input, started: performance.now() };
    if (inFlight.current) queued.current = pending;
    else send(pending);
  }, [request, send]);

  if (seriesState.type === "loading") {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Loading stored bar series…
      </p>
    );
  }
  if (seriesState.type === "forbidden")
    return <OperatorAccessRequired feature="instant-backtest" />;
  if (seriesState.type === "error") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {seriesState.message}
      </p>
    );
  }
  if (series === undefined) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No stored bar series yet. Import one with
        scripts/vertex-market-bars-import.ts.
      </p>
    );
  }

  const setNumber = (key: NumericParam) => (value: number) =>
    setParams((previous) => ({ ...previous, [key]: value }));
  const fields = [...WINDOW_FIELDS[params.ruleKind], ...RISK_FIELDS];

  const visible = visibleSeries(seriesState.series, universe);

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <form
        aria-label="Backtest parameters"
        className="space-y-4 rounded-xl border p-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <UniverseSelect
          fallback={visible.fallback}
          onChange={(choice) => {
            setUniverse(choice);
            setSelected(firstSeriesKey(seriesState.series, choice));
          }}
          selectClassName={selectClass}
          storedSymbols={seriesState.series.map((entry) => entry.symbol)}
          value={universe}
        />
        <div className="space-y-1">
          <label className="block font-medium text-sm" htmlFor={seriesId}>
            Bars
          </label>
          <select
            className={selectClass}
            id={seriesId}
            onChange={(event) => setSelected(event.currentTarget.value)}
            value={selected}
          >
            {visible.series.map((entry) => (
              <option key={seriesKey(entry)} value={seriesKey(entry)}>
                {entry.symbol} {entry.timeframe === "1d" ? "daily" : "1-minute"}{" "}
                ({entry.barCount.toLocaleString("en-US")} bars)
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block font-medium text-sm" htmlFor={ruleId}>
            Rule
          </label>
          <select
            className={selectClass}
            id={ruleId}
            onChange={(event) => {
              const ruleKind =
                event.currentTarget.value === "breakout"
                  ? "breakout"
                  : "smaCross";
              setParams((previous) => ({ ...previous, ruleKind }));
            }}
            value={params.ruleKind}
          >
            <option value="smaCross">Moving-average cross</option>
            <option value="breakout">Breakout (prior high and low)</option>
          </select>
        </div>
        {fields.map((spec) => (
          <ParamField
            key={spec.key}
            onChange={setNumber(spec.key)}
            spec={spec}
            value={params[spec.key]}
          />
        ))}
        <p className="text-muted-foreground text-xs">
          Long only. Signals use each close; fills happen at the next open.
          Stops and targets fill inside the bar. Past results do not predict
          future results.
        </p>
      </form>
      <section aria-label="Backtest result" className="min-w-0 space-y-3">
        {request !== null && "error" in request ? (
          <p className="text-destructive text-sm" role="alert">
            {request.error}
          </p>
        ) : (
          <p
            aria-live="polite"
            className="min-h-5 text-muted-foreground text-sm"
            data-instant-status={run.status}
          >
            {statusText(run)}
          </p>
        )}
        {run.result?.output.comparison === undefined ? null : (
          <div className="space-y-2" data-engine-comparison="on">
            <TypeScriptEngineLine
              clientMs={run.result.roundTripMs}
              timing={run.result.output.comparison}
            />
            <NautilusCard
              gateway={comparisonGateway}
              key={run.result.output.comparison.groupId ?? "none"}
              timing={run.result.output.comparison}
            />
          </div>
        )}
        {run.result === null ? null : <Results result={run.result} />}
      </section>
    </div>
  );
};
