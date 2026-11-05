"use client";

import type {
  BacktestGetOutput,
  BacktestResultSummaryOutput,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import {
  BACKTEST_TAB_LABELS,
  BenchmarkStats,
  backtestTabsFor,
  DistributionBars,
  isBacktestTab,
  OverviewStats,
  PeriodsPanel,
  PlaceboPanel,
  RegimesPanel,
  RiskPanel,
  RunConfigLine,
  type BacktestTab,
} from "./backtest-analytics-panels.tsx";
import {
  MultipleTestingPanel,
  PairsLensPanel,
  SignificancePanel,
  VolatilityPanel,
} from "./backtest-quant-panels.tsx";
import {
  InfoGlyph,
  OperatorAccessRequired,
  createBrowserBacktestsGateway,
  describeAgentOpsFailure,
  formatMetrics,
  formatTimestamp,
  isOperatorAccessDenied,
  type BacktestsGateway,
} from "./agent-ops-client.tsx";
import { tabKeyTarget } from "./optimizations-model.ts";

// Chart package code loads only when a detail view with series data is open.
const LazyBacktestSeriesChart = lazy(async () => ({
  default: (await import("../../features/charts/backtest-series.tsx"))
    .BacktestSeriesChart,
}));

export interface BacktestsWorkspaceProps {
  readonly gateway?: BacktestsGateway;
  readonly initialBacktestId?: string | null;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: BacktestResultSummaryOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type DetailState =
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; detail: BacktestGetOutput }>
  | Readonly<{ type: "error"; id: string; message: string }>;

const TRADE_ROWS_SHOWN = 500;

const metricValue = (
  metrics: Readonly<Record<string, number | string>>,
  keys: readonly string[]
): number | string | null => {
  for (const key of keys) {
    const value = metrics[key];
    if (value !== undefined) return value;
  }
  return null;
};

export const reportedSharpe = (
  metrics: Readonly<Record<string, number | string>>
) => metricValue(metrics, ["sharpe", "sharpe_ratio", "Sharpe"]);
const reportedCagr = (metrics: Readonly<Record<string, number | string>>) =>
  metricValue(metrics, ["cagr", "CAGR", "annual_return"]);

export const formatReported = (value: number | string | null): string => {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
};

export const formatPercent = (value: number | null): string => {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
};

const formatNumber = (value: number): string => {
  return Number.isInteger(value)
    ? String(value)
    : value
        .toPrecision(8)
        .replace(/(\.\d*?)0+$/u, "$1")
        .replace(/\.$/u, "");
};

const readInitialId = (): string | null => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
};

const readInitialTab = (): BacktestTab => {
  if (typeof window === "undefined") return "overview";
  const value = new URLSearchParams(window.location.search).get("tab");
  return isBacktestTab(value) ? value : "overview";
};

// Keeps ?id= and ?tab= in the address bar so a detail view can be linked and restored.
const writeLocation = (id: string | null, tab: BacktestTab): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete("id");
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("id", id);
    if (tab === "overview") {
      url.searchParams.delete("tab");
    } else url.searchParams.set("tab", tab);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const cell = "py-1 pr-3";
const headCell = "py-1 pr-3 font-normal";

const Chart = ({
  points,
  label,
  yLabel,
  caption,
}: {
  readonly points: readonly { t: string; value: number }[];
  readonly label: string;
  readonly yLabel: string;
  readonly caption: string;
}) => (
  <ChartRendererBoundary>
    <Suspense
      fallback={<p className="text-muted-foreground text-xs">Loading chart…</p>}
    >
      <LazyBacktestSeriesChart
        caption={caption}
        label={label}
        points={points}
        yLabel={yLabel}
      />
    </Suspense>
  </ChartRendererBoundary>
);

const SplitTable = ({
  backtest,
}: {
  readonly backtest: BacktestGetOutput["backtest"];
}) => (
  <section aria-labelledby="backtest-split-heading" className="space-y-1">
    <h3 className="font-medium text-sm" id="backtest-split-heading">
      In-sample / out-of-sample split
      <InfoGlyph text="Windows and per-window metrics as reported. Out-of-sample must start at or after in-sample ends." />
    </h3>
    {backtest.isSplit === null ? (
      <p className="text-muted-foreground text-xs">No split reported.</p>
    ) : (
      <div className="relative overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground">
              <th className={headCell} scope="col">
                Window
              </th>
              <th className={headCell} scope="col">
                Start
              </th>
              <th className={headCell} scope="col">
                End
              </th>
              <th className={headCell} scope="col">
                Metrics
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["In-sample", backtest.isSplit.in_sample],
                ["Out-of-sample", backtest.isSplit.out_of_sample],
              ] as const
            ).map(([label, value]) => {
              return (
                <tr
                  className="border-border border-b"
                  data-split={label}
                  key={label}
                >
                  <th className={headCell} scope="row">
                    {label}
                  </th>
                  <td className={`${cell} font-mono`}>{value.start}</td>
                  <td className={`${cell} font-mono`}>{value.end}</td>
                  <td className={`${cell} font-mono`}>
                    {formatMetrics(value.metrics, 12)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

const FoldsTable = ({
  backtest,
}: {
  readonly backtest: BacktestGetOutput["backtest"];
}) => (
  <section aria-labelledby="backtest-folds-heading" className="space-y-1">
    <h3 className="font-medium text-sm" id="backtest-folds-heading">
      Walk-forward folds
      <InfoGlyph text="Each fold: train_start < train_end <= test_start < test_end; folds ordered by test start." />
    </h3>
    {backtest.folds.length === 0 ? (
      <p className="text-muted-foreground text-xs">No folds reported.</p>
    ) : (
      <div className="relative overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground">
              <th className={headCell} scope="col">
                Fold
              </th>
              <th className={headCell} scope="col">
                Train
              </th>
              <th className={headCell} scope="col">
                Test
              </th>
              <th className={headCell} scope="col">
                Metrics
              </th>
            </tr>
          </thead>
          <tbody>
            {backtest.folds.map((fold, index) => {
              return (
                <tr
                  className="border-border border-b"
                  data-fold={fold.label}
                  key={`${fold.label}-${index}`}
                >
                  <th className={headCell} scope="row">
                    {fold.label}
                  </th>
                  <td className={`${cell} font-mono`}>
                    {fold.train_start} to {fold.train_end}
                  </td>
                  <td className={`${cell} font-mono`}>
                    {fold.test_start} to {fold.test_end}
                  </td>
                  <td className={`${cell} font-mono`}>
                    {formatMetrics(fold.metrics, 12)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

const optionalNumber = (value: number | undefined): string =>
  value === undefined ? "—" : formatNumber(value);

const TradesTable = ({
  backtest,
}: {
  readonly backtest: BacktestGetOutput["backtest"];
}) => {
  const shownTrades = backtest.trades.slice(0, TRADE_ROWS_SHOWN);
  return (
    <section aria-labelledby="backtest-trades-heading" className="space-y-1">
      <h3 className="font-medium text-sm" id="backtest-trades-heading">
        Trades
        <InfoGlyph text="Trades as reported, ordered by entry time. PnL is the agent's figure; it is not recomputed." />
      </h3>
      {backtest.trades.length === 0 ? (
        <p className="text-muted-foreground text-xs">No trades reported.</p>
      ) : (
        <>
          {backtest.trades.length > TRADE_ROWS_SHOWN ? (
            <p className="text-muted-foreground text-xs">
              First {TRADE_ROWS_SHOWN} of {backtest.trades.length} trades.
            </p>
          ) : null}
          <div className="relative overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground">
                  <th className={headCell} scope="col">
                    Entry
                  </th>
                  <th className={headCell} scope="col">
                    Exit
                  </th>
                  <th className={headCell} scope="col">
                    Symbol
                  </th>
                  <th className={headCell} scope="col">
                    Side
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Qty
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Entry px
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Exit px
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Stop
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Target
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    Commission
                  </th>
                  <th className={`${headCell} text-right`} scope="col">
                    PnL
                  </th>
                  <th className={headCell} scope="col">
                    Regime
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownTrades.map((trade, index) => {
                  return (
                    <tr
                      className="border-border border-b font-mono"
                      data-trade-index={index}
                      key={index}
                    >
                      <td className={cell}>{trade.entry_t}</td>
                      <td className={cell}>{trade.exit_t}</td>
                      <td className={cell}>{trade.symbol ?? "—"}</td>
                      <td className={cell}>{trade.side}</td>
                      <td className={`${cell} text-right`}>
                        {formatNumber(trade.qty)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {formatNumber(trade.entry_px)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {formatNumber(trade.exit_px)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {optionalNumber(trade.sl)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {optionalNumber(trade.tp)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {optionalNumber(trade.commission)}
                      </td>
                      <td className={`${cell} text-right`}>
                        {formatNumber(trade.pnl)}
                      </td>
                      <td className={cell}>{trade.regime ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};

const BacktestDetail = ({
  detail,
  onClose,
  tab,
  onTab,
}: {
  readonly detail: BacktestGetOutput;
  readonly onClose: () => void;
  readonly tab: BacktestTab;
  readonly onTab: (tab: BacktestTab) => void;
}) => {
  const { backtest, task } = detail;
  const equityPoints = useMemo(
    () => backtest.equity.map((point) => ({ t: point.t, value: point.equity })),
    [backtest.equity]
  );
  const drawdownPoints = useMemo(
    () =>
      backtest.drawdown.map((point) => ({
        t: point.t,
        value: point.drawdown * 100,
      })),
    [backtest.drawdown]
  );
  // A ?tab=placebo link to a result without a rating series falls back to the overview.
  const shown: BacktestTab =
    tab === "placebo" && backtest.ratingEvaluation === null ? "overview" : tab;
  const panelId = `backtest-panel-${shown}`;
  const tabs = backtestTabsFor(backtest.ratingEvaluation);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = tabKeyTarget(event.key, shown, tabs);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`backtest-tab-${next}`)?.focus();
  };
  return (
    <section
      aria-labelledby="backtest-detail-heading"
      className="space-y-4 rounded-md border border-border p-4"
      data-backtest-detail={backtest.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-medium text-base" id="backtest-detail-heading">
            {backtest.strategy}
          </h2>
          <p className="text-muted-foreground text-xs">
            {backtest.instruments} · {backtest.periodStart} to{" "}
            {backtest.periodEnd} ·{" "}
            <span className="font-mono">{backtest.dataSource}</span> · recorded{" "}
            {formatTimestamp(backtest.createdAt)} UTC
          </p>
          <RunConfigLine backtest={backtest} />
        </div>
        <Button onClick={onClose} type="button" variant="secondary">
          Close
        </Button>
      </div>
      <p
        className="text-muted-foreground text-xs"
        data-provenance="agent-reported"
      >
        Equity, trades and reported metrics are agent-reported. Statistics below
        are derived by the server from them.
        <InfoGlyph
          text={`Analytics ${backtest.analytics.method.version}, seed ${backtest.analytics.method.seed}. Risk-free rate 0. Resampling is deterministic for this result.`}
        />
      </p>
      <div
        aria-label="Backtest views"
        className="flex flex-wrap gap-1 border-border border-b"
        onKeyDown={onTabKey}
        role="tablist"
      >
        {tabs.map((option) => {
          return (
            <button
              aria-controls={`backtest-panel-${option}`}
              aria-selected={shown === option}
              className={`min-h-11 border-b-2 px-3 text-sm ${shown === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              data-tab={option}
              id={`backtest-tab-${option}`}
              key={option}
              onClick={() => onTab(option)}
              role="tab"
              tabIndex={shown === option ? 0 : -1}
              type="button"
            >
              {BACKTEST_TAB_LABELS[option]}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`backtest-tab-${shown}`}
        className="space-y-5"
        id={panelId}
        role="tabpanel"
      >
        {shown === "overview" ? (
          <>
            <OverviewStats backtest={backtest} />
            {backtest.equity.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No equity series reported.
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <Chart
                  caption="Reported equity."
                  label={`${backtest.strategy} equity`}
                  points={equityPoints}
                  yLabel="Equity"
                />
                <Chart
                  caption="Drawdown from running peak."
                  label={`${backtest.strategy} drawdown`}
                  points={drawdownPoints}
                  yLabel="Drawdown (%)"
                />
              </div>
            )}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Task</dt>
              <dd>
                <a
                  className="underline underline-offset-2"
                  href={`/agents?task=${encodeURIComponent(backtest.taskId)}`}
                >
                  {task?.title ?? backtest.taskId}
                </a>
                {task === null ? null : (
                  <span className="text-muted-foreground">
                    {" "}
                    · {task.status} · {task.agent}
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Paper</dt>
              <dd className="font-mono">{backtest.paperId ?? "—"}</dd>
              <dt className="text-muted-foreground">Reported metrics</dt>
              <dd className="font-mono">
                {formatMetrics(backtest.metrics, 40)}
              </dd>
              <dt className="text-muted-foreground">Series</dt>
              <dd className="font-mono">
                {backtest.equity.length} equity points ·{" "}
                {backtest.trades.length} trades · {backtest.folds.length} folds
              </dd>
              {backtest.notes === null ? null : (
                <>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="whitespace-pre-wrap">{backtest.notes}</dd>
                </>
              )}
            </dl>
          </>
        ) : shown === "trades" ? (
          <>
            <section
              aria-labelledby="backtest-distribution-heading"
              className="space-y-1"
            >
              <h3
                className="font-medium text-sm"
                id="backtest-distribution-heading"
              >
                P&L distribution
              </h3>
              <DistributionBars analytics={backtest.analytics} />
            </section>
            <TradesTable backtest={backtest} />
          </>
        ) : shown === "risk" ? (
          <>
            <RiskPanel analytics={backtest.analytics} />
            <VolatilityPanel analytics={backtest.analytics} />
          </>
        ) : shown === "periods" ? (
          <PeriodsPanel analytics={backtest.analytics} />
        ) : shown === "regimes" ? (
          <RegimesPanel analytics={backtest.analytics} />
        ) : shown === "placebo" ? (
          <PlaceboPanel
            equityChart={(points) => (
              <Chart
                caption="Agents rating-only equity, starting at 100. The table lists the placebo band at checkpoints."
                label={`${backtest.strategy} rating replay equity`}
                points={points}
                yLabel="Equity"
              />
            )}
            evaluation={backtest.ratingEvaluation}
          />
        ) : (
          <>
            <SignificancePanel analytics={backtest.analytics} />
            <MultipleTestingPanel analytics={backtest.analytics} />
            <PairsLensPanel metrics={backtest.metrics} />
            <section
              aria-labelledby="backtest-benchmark-heading"
              className="space-y-2"
            >
              <h3
                className="font-medium text-sm"
                id="backtest-benchmark-heading"
              >
                Benchmark
              </h3>
              <BenchmarkStats backtest={backtest} />
            </section>
            <SplitTable backtest={backtest} />
            <FoldsTable backtest={backtest} />
          </>
        )}
      </div>
    </section>
  );
};

export const BacktestsWorkspace = ({
  gateway: suppliedGateway,
  initialBacktestId,
}: BacktestsWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserBacktestsGateway()
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [detail, setDetail] = useState<DetailState>({ type: "closed" });
  const [tab, setTab] = useState<BacktestTab>(readInitialTab);
  const selectTab = useCallback(
    (next: BacktestTab) => {
      setTab(next);
      if (detail.type === "ready")
        return writeLocation(detail.detail.backtest.id, next);
      return;
    },
    [detail]
  );
  const close = useCallback(() => {
    setDetail({ type: "closed" });
    setTab("overview");
    return writeLocation(null, "overview");
  }, []);

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ type: "ready", rows: await gateway.list() });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { type: "error", message: describeAgentOpsFailure(error) }
      );
    }
  }, [gateway]);

  const open = useCallback(
    async (id: string, fromLink = false) => {
      if (!fromLink) {
        setTab("overview");
        writeLocation(id, "overview");
      }
      setDetail({ type: "loading", id });
      try {
        return setDetail({ type: "ready", detail: await gateway.get(id) });
      } catch (error) {
        return setDetail({
          type: "error",
          id,
          message: describeAgentOpsFailure(error),
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    void load();
    const id =
      initialBacktestId === undefined ? readInitialId() : initialBacktestId;
    if (id !== null && id !== "") void open(id, true);
    return;
  }, [load, open, initialBacktestId]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="backtests" />;

  return (
    <div className="space-y-6">
      {detail.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading backtest…
        </p>
      ) : detail.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{detail.message}</p>
          <Button
            onClick={() => setDetail({ type: "closed" })}
            type="button"
            variant="secondary"
          >
            Close
          </Button>
        </div>
      ) : detail.type === "ready" ? (
        <BacktestDetail
          detail={detail.detail}
          onClose={close}
          onTab={selectTab}
          tab={tab}
        />
      ) : null}
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading backtests…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : state.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No backtest results.</p>
      ) : (
        // `relative` makes the scroll box the containing block of the
        // absolutely positioned sr-only "Actions" label, so it is clipped
        // with the table instead of widening the page on a phone.
        <div className="relative overflow-x-auto" data-backtest-results-scroll>
          <table className="w-full min-w-[56rem] text-sm" data-click-private="">
            <caption className="sr-only">Backtest results</caption>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground text-xs">
                <th scope="col">Strategy</th>
                <th scope="col">Instruments</th>
                <th scope="col">Period</th>
                <th className="text-right" scope="col">
                  Sharpe
                  <InfoGlyph text="Reported metric sharpe (or sharpe_ratio), as submitted." />
                </th>
                <th className="text-right" scope="col">
                  CAGR
                  <InfoGlyph text="Reported metric cagr (or annual_return), as submitted; units are the agent's." />
                </th>
                <th className="text-right" scope="col">
                  Max DD
                  <InfoGlyph text="Derived server-side from the reported equity series: min(equity / running peak - 1)." />
                </th>
                <th className="text-right" scope="col">
                  Trades
                </th>
                <th scope="col">
                  Source
                  <InfoGlyph text="Data source named by the agent." />
                </th>
                <th scope="col">Task</th>
                <th scope="col">Recorded (UTC)</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                return (
                  <tr
                    className="border-border border-b align-top"
                    data-backtest-id={row.id}
                    key={row.id}
                  >
                    <th className="py-1 font-normal" scope="row">
                      {row.strategy}
                    </th>
                    <td className="py-1 text-xs">{row.instruments}</td>
                    <td className="py-1 font-mono text-xs">
                      {row.periodStart} to {row.periodEnd}
                    </td>
                    <td
                      className="py-1 text-right font-mono text-xs"
                      data-col="sharpe"
                    >
                      {formatReported(reportedSharpe(row.metrics))}
                    </td>
                    <td
                      className="py-1 text-right font-mono text-xs"
                      data-col="cagr"
                    >
                      {formatReported(reportedCagr(row.metrics))}
                    </td>
                    <td
                      className="py-1 text-right font-mono text-xs"
                      data-col="max-dd"
                    >
                      {formatPercent(row.maxDrawdown)}
                    </td>
                    <td className="py-1 text-right font-mono text-xs">
                      {row.tradeCount}
                    </td>
                    <td className="max-w-48 py-1 text-xs">{row.dataSource}</td>
                    <td className="py-1 text-xs">
                      <a
                        className="underline underline-offset-2"
                        href={`/agents?task=${encodeURIComponent(row.taskId)}`}
                      >
                        {row.taskTitle ?? row.taskId}
                      </a>
                    </td>
                    <td className="py-1 font-mono text-muted-foreground text-xs">
                      {formatTimestamp(row.createdAt)}
                    </td>
                    <td className="py-1 text-right">
                      <Button
                        aria-label={`Open ${row.strategy}`}
                        onClick={() => void open(row.id)}
                        type="button"
                        variant="secondary"
                      >
                        Open
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
