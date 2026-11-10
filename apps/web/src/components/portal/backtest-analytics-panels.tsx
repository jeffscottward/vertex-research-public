"use client";

import type { BacktestGetOutput } from "@darkfactory/api";
import { useState, type ReactNode } from "react";

import { InfoGlyph } from "./agent-ops-client.tsx";

type Backtest = BacktestGetOutput["backtest"];
type Analytics = Backtest["analytics"];
type Interval = NonNullable<Analytics["bootstrap"]["sharpe"]>;
type MonteCarloRun = NonNullable<Analytics["monteCarlo"]>["reshuffle"];
type RatingEvaluation = NonNullable<Backtest["ratingEvaluation"]>;
type ReadyEvaluation = Extract<RatingEvaluation, { status: "ready" }>;

export const BACKTEST_TABS = [
  "overview",
  "trades",
  "risk",
  "periods",
  "regimes",
  "validation",
  "placebo",
] as const;
export type BacktestTab = (typeof BACKTEST_TABS)[number];
export const BACKTEST_TAB_LABELS: Readonly<Record<BacktestTab, string>> = {
  overview: "Overview",
  trades: "Trades",
  risk: "Risk",
  periods: "Periods",
  regimes: "Regimes",
  validation: "Validation",
  placebo: "Placebo",
};

export const isBacktestTab = (value: string | null): value is BacktestTab => {
  return value !== null && (BACKTEST_TABS as readonly string[]).includes(value);
};

// The Placebo tab exists only for a result that carries a rating series.
export const backtestTabsFor = (
  evaluation: RatingEvaluation | null
): readonly BacktestTab[] => {
  return evaluation === null
    ? BACKTEST_TABS.filter((tab) => tab !== "placebo")
    : BACKTEST_TABS;
};

export const DASH = "—";
export const pct = (value: number | null | undefined, digits = 2): string => {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : `${(value * 100).toFixed(digits)}%`;
};
export const num = (value: number | null | undefined, digits = 2): string => {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      });
};
const signed = (value: number | null | undefined, digits = 2): string => {
  return value === null || value === undefined || !Number.isFinite(value)
    ? DASH
    : `${value > 0 ? "+" : ""}${num(value, digits)}`;
};
const duration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const tone = (value: number | null | undefined): string => {
  return value === null || value === undefined || value === 0
    ? ""
    : value > 0
      ? "text-success-foreground"
      : "text-destructive";
};
export const cell = "py-1 pr-3";
export const headCell = "py-1 pr-3 font-normal";
export const numCell = "py-1 pr-3 text-right font-mono";

export const Stat = ({
  label,
  value,
  valueTone = "",
  help,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueTone?: string;
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
    <dd className={`font-mono text-sm ${valueTone}`}>{value}</dd>
  </div>
);

export const StatGrid = ({
  children,
  label,
  columns = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
}: {
  readonly children: ReactNode;
  readonly label: string;
  // Responsive column classes; fewer columns leave room for longer labels.
  readonly columns?: string;
}) => (
  <dl aria-label={label} className={`grid gap-2 ${columns}`}>
    {children}
  </dl>
);

export const SectionTitle = ({
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

export const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-muted-foreground text-xs">{children}</p>
);

// ---------------------------------------------------------------------------

export const OverviewStats = ({
  backtest,
}: {
  readonly backtest: Backtest;
}) => {
  const { returns, trades } = backtest.analytics;
  return (
    <div className="space-y-3">
      {returns === null ? (
        <Empty>
          Fewer than three equity points; return statistics need a longer
          series.
        </Empty>
      ) : (
        <StatGrid label="Return statistics">
          <Stat
            label="Total return"
            value={pct(returns.totalReturn)}
            valueTone={tone(returns.totalReturn)}
          />
          <Stat
            label="CAGR"
            value={pct(returns.cagr)}
            valueTone={tone(returns.cagr)}
            help="Annualized over the elapsed time between the first and last equity point."
          />
          <Stat
            label="Max drawdown"
            value={pct(returns.maxDrawdown)}
            valueTone={tone(returns.maxDrawdown)}
          />
          <Stat
            label="Sharpe"
            value={num(returns.sharpe)}
            help={`Risk-free rate 0. Annualized with ${num(returns.periodsPerYear, 1)} observed periods per year.`}
          />
          <Stat
            label="Sortino"
            value={num(returns.sortino)}
            help="Mean return over downside deviation (all periods), annualized."
          />
          <Stat
            label="Calmar"
            value={num(returns.calmar)}
            help="CAGR divided by the absolute max drawdown."
          />
          <Stat
            label="Volatility (ann.)"
            value={pct(returns.annualVolatility)}
          />
          <Stat
            label="PSR"
            value={pct(returns.psr, 1)}
            help="Probabilistic Sharpe ratio: probability that the true Sharpe exceeds 0, given skew, kurtosis and sample length."
          />
          <Stat label="Skew" value={num(returns.skew)} />
          <Stat label="Excess kurtosis" value={num(returns.excessKurtosis)} />
          <Stat label="Periods" value={String(returns.periods)} />
        </StatGrid>
      )}
      {trades === null ? (
        <Empty>No trades reported.</Empty>
      ) : (
        <StatGrid label="Trade statistics">
          <Stat
            label="Net P&L"
            value={signed(trades.netPnl)}
            valueTone={tone(trades.netPnl)}
          />
          <Stat label="Trades" value={String(trades.count)} />
          <Stat label="Win rate" value={pct(trades.winRate, 1)} />
          <Stat label="Profit factor" value={num(trades.profitFactor)} />
          <Stat
            label="Expectancy"
            value={signed(trades.expectancy)}
            valueTone={tone(trades.expectancy)}
            help="Net P&L per trade."
          />
          <Stat
            label="Payoff ratio"
            value={num(trades.payoffRatio)}
            help="Average win divided by the absolute average loss."
          />
          <Stat
            label="Avg win"
            value={signed(trades.avgWin)}
            valueTone={tone(trades.avgWin)}
          />
          <Stat
            label="Avg loss"
            value={signed(trades.avgLoss)}
            valueTone={tone(trades.avgLoss)}
          />
          <Stat
            label="Largest win"
            value={signed(trades.largestWin)}
            valueTone={tone(trades.largestWin)}
          />
          <Stat
            label="Largest loss"
            value={signed(trades.largestLoss)}
            valueTone={tone(trades.largestLoss)}
          />
          <Stat
            label="Win / loss streak"
            value={`${trades.maxConsecutiveWins} / ${trades.maxConsecutiveLosses}`}
          />
          <Stat
            label="Avg hold"
            value={duration(trades.avgHoldMinutes * 60_000)}
          />
          <Stat
            label="Long / short"
            value={`${trades.longCount} / ${trades.shortCount}`}
          />
          <Stat
            label="Long P&L"
            value={signed(trades.longNetPnl)}
            valueTone={tone(trades.longNetPnl)}
          />
          <Stat
            label="Short P&L"
            value={signed(trades.shortNetPnl)}
            valueTone={tone(trades.shortNetPnl)}
          />
          <Stat label="Commission" value={num(trades.totalCommission)} />
        </StatGrid>
      )}
    </div>
  );
};

export const RunConfigLine = ({
  backtest,
}: {
  readonly backtest: Backtest;
}) => {
  const config = backtest.runConfig;
  if (config === null) return null;
  const parts = [
    config.initialCapital === undefined
      ? null
      : `capital ${num(config.initialCapital)}`,
    config.timeframe === undefined ? null : `timeframe ${config.timeframe}`,
    config.fillModel === undefined ? null : `fills ${config.fillModel}`,
    config.commissionPerContract === undefined
      ? null
      : `commission/contract ${num(config.commissionPerContract, 4)}`,
    config.commissionPerTrade === undefined
      ? null
      : `commission/trade ${num(config.commissionPerTrade, 4)}`,
    config.commissionPercent === undefined
      ? null
      : `commission ${num(config.commissionPercent, 4)}%`,
    config.slippagePercent === undefined
      ? null
      : `slippage ${num(config.slippagePercent, 4)}%`,
    config.leverage === undefined ? null : `leverage ${num(config.leverage)}x`,
  ].filter((part) => part !== null);
  return (
    <p className="font-mono text-muted-foreground text-xs" data-run-config>
      {parts.join(" · ")}
    </p>
  );
};

// ---------------------------------------------------------------------------

export const DistributionBars = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const distribution = analytics.distribution;
  if (distribution === null) return <Empty>No trades reported.</Empty>;
  const peak = Math.max(...distribution.bins.map((bin) => bin.count), 1);
  return (
    <div className="space-y-1" data-distribution>
      <p className="font-mono text-muted-foreground text-xs">
        mean {signed(distribution.mean)} · median {signed(distribution.median)}{" "}
        · stdev {num(distribution.stdev)}
      </p>
      <ol className="space-y-0.5">
        {distribution.bins.map((bin, index) => {
          return (
            <li
              className="grid grid-cols-[10rem_1fr_3rem] items-center gap-2 text-xs"
              key={index}
            >
              <span className="font-mono text-muted-foreground">
                {signed(bin.from, 0)} to {signed(bin.to, 0)}
              </span>
              <span
                aria-hidden="true"
                className="h-3 rounded-sm bg-primary/70"
                style={{ width: `${(bin.count / peak) * 100}%` }}
              />
              <span className="text-right font-mono">{bin.count}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

// ---------------------------------------------------------------------------

const IntervalRow = ({
  label,
  value,
  format,
}: {
  readonly label: string;
  readonly value: Interval | null;
  readonly format: (value: number) => string;
}) => (
  <tr className="border-border border-b" data-interval={label}>
    <th className={headCell} scope="row">
      {label}
    </th>
    {value === null ? (
      <td className={`${cell} text-muted-foreground`} colSpan={4}>
        {DASH}
      </td>
    ) : (
      <>
        <td className={numCell}>{format(value.p2_5)}</td>
        <td className={numCell}>{format(value.p50)}</td>
        <td className={numCell}>{format(value.p97_5)}</td>
        <td className={numCell}>{format(value.mean)}</td>
      </>
    )}
  </tr>
);

const PercentileRow = ({
  label,
  value,
  format,
}: {
  readonly label: string;
  readonly value: MonteCarloRun["finalPnl"];
  readonly format: (value: number) => string;
}) => (
  <tr className="border-border border-b">
    <th className={headCell} scope="row">
      {label}
    </th>
    {[value.p5, value.p25, value.p50, value.p75, value.p95].map(
      (entry, index) => (
        <td className={numCell} key={index}>
          {format(entry)}
        </td>
      )
    )}
  </tr>
);

// Five evenly spaced checkpoints along the fan (20%, 40%, 60%, 80%, 100% of the trade sequence).
const fanCheckpoints = <T,>(fan: readonly T[]): T[] => {
  if (fan.length === 0) return [];
  const picked = [0.2, 0.4, 0.6, 0.8, 1].flatMap((share) => {
    const point = fan[Math.max(0, Math.ceil(share * fan.length) - 1)];
    return point === undefined ? [] : [point];
  });
  return [...new Set(picked)];
};

// Worst simulated path across both methods; sizing reads this run, never the median.
const WorstRunStats = ({
  monteCarlo,
}: {
  readonly monteCarlo: Analytics["monteCarlo"];
}) =>
  monteCarlo === null ? null : (
    <>
      <Stat
        help="Deepest drawdown of any simulated path, both methods."
        label="Worst run max DD"
        value={pct(monteCarlo.worst.maxDrawdown)}
      />
      <Stat
        label="Worst run final P&L"
        value={signed(monteCarlo.worst.finalPnl)}
      />
      <Stat
        help={`Sized from worst run: ${pct(monteCarlo.sizing.drawdownBudget, 0)} drawdown budget divided by the worst simulated drawdown, capped at 1. Never the median.`}
        label="Size scale (sized from worst run)"
        value={num(monteCarlo.sizing.sizeScale)}
      />
    </>
  );

// Always shown on the overview: every backtest gets a Monte Carlo pass, no toggle.
export const MonteCarloOverview = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const mc = analytics.monteCarlo;
  return (
    <section aria-labelledby="backtest-mc-overview" className="space-y-2">
      <SectionTitle
        {...(mc === null
          ? {}
          : {
              help: `${mc.paths} paths per method (trade-order shuffle and bootstrap of ${mc.pnlSource === "trades" ? "trade P&L" : "per-bar equity changes"}). Seed ${mc.seed}.`,
            })}
        id="backtest-mc-overview"
      >
        Monte Carlo
      </SectionTitle>
      {mc === null ? (
        <p className="text-muted-foreground text-xs">
          Not enough data to simulate (needs two or more trades or equity
          changes and a starting capital).
        </p>
      ) : (
        <StatGrid label="Monte Carlo summary">
          <Stat
            label="Risk of ruin (worst method)"
            value={pct(mc.worst.riskOfRuin, 1)}
          />
          <Stat
            label="Median max DD (bootstrap)"
            value={pct(mc.bootstrap.maxDrawdown.p50)}
          />
          <WorstRunStats monteCarlo={mc} />
        </StatGrid>
      )}
    </section>
  );
};

export const RiskPanel = ({ analytics }: { readonly analytics: Analytics }) => {
  const [mode, setMode] = useState<"reshuffle" | "bootstrap">("bootstrap");
  const run = analytics.monteCarlo?.[mode] ?? null;
  const trades = analytics.trades;
  return (
    <div className="space-y-5">
      <StatGrid label="Risk statistics">
        <Stat
          label="Kelly fraction"
          value={pct(trades?.kelly, 1)}
          help="Win rate minus loss rate divided by payoff ratio. Informational; not a sizing instruction."
        />
        <Stat label="Payoff ratio" value={num(trades?.payoffRatio)} />
        <Stat label="Expectancy" value={signed(trades?.expectancy)} />
        <Stat
          label="Risk of ruin"
          value={run === null ? DASH : pct(run.riskOfRuin, 1)}
          help={`Share of simulated paths whose equity falls to ${pct(analytics.method.ruinFraction, 0)} of starting capital or below.`}
        />
        <Stat
          label="P(profit)"
          value={run === null ? DASH : pct(run.probabilityOfProfit, 1)}
        />
        <Stat
          label="Median max DD (sim)"
          value={run === null ? DASH : pct(run.maxDrawdown.p50)}
        />
        <WorstRunStats monteCarlo={analytics.monteCarlo} />
      </StatGrid>
      <section aria-labelledby="backtest-mc-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle
            help={`${analytics.method.monteCarloPaths} paths from starting capital ${num(analytics.method.initialCapital)}. Seed ${analytics.method.seed}.`}
            id="backtest-mc-heading"
          >
            Monte Carlo
          </SectionTitle>
          <div
            aria-label="Simulation method"
            className="flex gap-1"
            role="radiogroup"
          >
            {(["bootstrap", "reshuffle"] as const).map((option) => {
              return (
                <button
                  aria-checked={mode === option}
                  className={`min-h-11 rounded-md border px-3 text-xs ${mode === option ? "border-primary bg-primary/10" : "border-border"}`}
                  key={option}
                  onClick={() => setMode(option)}
                  role="radio"
                  type="button"
                >
                  {option === "bootstrap"
                    ? "Trade bootstrap (P&L)"
                    : "Order reshuffle (path)"}
                </button>
              );
            })}
          </div>
        </div>
        {run === null ? (
          <Empty>
            Needs at least two trades and a starting capital (run config or
            first equity point).
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-monte-carlo={mode}>
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground">
                  <th className={headCell} scope="col">
                    Outcome
                  </th>
                  {["5%", "25%", "50%", "75%", "95%"].map((label) => (
                    <th
                      className={`${headCell} text-right`}
                      key={label}
                      scope="col"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mode === "bootstrap" ? (
                  <PercentileRow
                    format={(value) => signed(value)}
                    label="Final P&L"
                    value={run.finalPnl}
                  />
                ) : null}
                <PercentileRow
                  format={(value) => pct(value)}
                  label="Max drawdown"
                  value={run.maxDrawdown}
                />
                {fanCheckpoints(run.fan).map((point) => {
                  return (
                    <PercentileRow
                      format={(value) => signed(value)}
                      key={point.step}
                      label={`P&L after ${point.step} trades`}
                      value={point}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section
        aria-labelledby="backtest-bootstrap-heading"
        className="space-y-2"
      >
        <SectionTitle
          help={`Returns: circular block bootstrap, block length ${analytics.method.blockLength ?? DASH}. Trades: resampled with replacement. ${analytics.method.resamples} resamples.`}
          id="backtest-bootstrap-heading"
        >
          Bootstrap confidence intervals (95%)
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground">
                <th className={headCell} scope="col">
                  Metric
                </th>
                <th className={`${headCell} text-right`} scope="col">
                  2.5%
                </th>
                <th className={`${headCell} text-right`} scope="col">
                  Median
                </th>
                <th className={`${headCell} text-right`} scope="col">
                  97.5%
                </th>
                <th className={`${headCell} text-right`} scope="col">
                  Mean
                </th>
              </tr>
            </thead>
            <tbody>
              <IntervalRow
                format={(value) => num(value)}
                label="Sharpe"
                value={analytics.bootstrap.sharpe}
              />
              <IntervalRow
                format={(value) => pct(value)}
                label="Total return"
                value={analytics.bootstrap.totalReturn}
              />
              <IntervalRow
                format={(value) => pct(value)}
                label="Max drawdown"
                value={analytics.bootstrap.maxDrawdown}
              />
              <IntervalRow
                format={(value) => pct(value, 1)}
                label="Win rate"
                value={analytics.bootstrap.winRate}
              />
              <IntervalRow
                format={(value) => num(value)}
                label="Profit factor"
                value={analytics.bootstrap.profitFactor}
              />
              <IntervalRow
                format={(value) => signed(value)}
                label="Expectancy"
                value={analytics.bootstrap.expectancy}
              />
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const heat = (value: number | undefined): string => {
  return value === undefined || value === 0
    ? ""
    : value > 0
      ? "bg-success-subtle text-success-foreground"
      : "bg-destructive-subtle text-destructive";
};

const BucketTable = ({
  id,
  title,
  rows,
}: {
  readonly id: string;
  readonly title: string;
  readonly rows: Analytics["pnlBy"]["weekday"];
}) => (
  <section aria-labelledby={id} className="space-y-1">
    <SectionTitle id={id}>{title}</SectionTitle>
    {rows.length === 0 ? (
      <Empty>No trades reported.</Empty>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground">
              <th className={headCell} scope="col">
                Period
              </th>
              <th className={`${headCell} text-right`} scope="col">
                Trades
              </th>
              <th className={`${headCell} text-right`} scope="col">
                Win rate
              </th>
              <th className={`${headCell} text-right`} scope="col">
                Net P&L
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr className="border-border border-b" key={row.key}>
                  <th className={`${headCell} font-mono`} scope="row">
                    {row.key}
                  </th>
                  <td className={numCell}>{row.trades}</td>
                  <td className={numCell}>{pct(row.winRate, 1)}</td>
                  <td className={`${numCell} ${tone(row.netPnl)}`}>
                    {signed(row.netPnl)}
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

export const PeriodsPanel = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  const years = [...new Set(analytics.monthlyReturns.map((row) => row.year))];
  const byKey = new Map(
    analytics.monthlyReturns.map((row) => [
      `${row.year}-${row.month}`,
      row.return,
    ])
  );
  const yearly = new Map(
    analytics.yearlyReturns.map((row) => [row.year, row.return])
  );
  const drawdowns = analytics.drawdowns;
  return (
    <div className="space-y-5">
      <section aria-labelledby="backtest-monthly-heading" className="space-y-1">
        <SectionTitle
          help="Month-end equity over the previous month-end (UTC). The first month uses the first equity point."
          id="backtest-monthly-heading"
        >
          Monthly returns
        </SectionTitle>
        {years.length === 0 ? (
          <Empty>Needs an equity series.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[48rem] text-xs"
              data-monthly-returns
            >
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground">
                  <th className={headCell} scope="col">
                    Year
                  </th>
                  {MONTHS.map((month) => (
                    <th
                      className={`${headCell} text-right`}
                      key={month}
                      scope="col"
                    >
                      {month}
                    </th>
                  ))}
                  <th className={`${headCell} text-right`} scope="col">
                    Year
                  </th>
                </tr>
              </thead>
              <tbody>
                {years.map((year) => {
                  return (
                    <tr className="border-border border-b" key={year}>
                      <th className={`${headCell} font-mono`} scope="row">
                        {year}
                      </th>
                      {MONTHS.map((_, index) => {
                        const value = byKey.get(`${year}-${index + 1}`);
                        return (
                          <td
                            className={`${numCell} ${heat(value)}`}
                            key={index}
                          >
                            {value === undefined ? "" : pct(value, 1)}
                          </td>
                        );
                      })}
                      <td
                        className={`${numCell} font-medium ${tone(yearly.get(year))}`}
                      >
                        {pct(yearly.get(year), 1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="backtest-dd-heading" className="space-y-1">
        <SectionTitle
          help="From a peak, through the lowest point, to the first equity at or above the peak. Deepest first."
          id="backtest-dd-heading"
        >
          Drawdown periods
        </SectionTitle>
        {drawdowns === null || drawdowns.count === 0 ? (
          <Empty>No drawdown periods.</Empty>
        ) : (
          <>
            <p className="font-mono text-muted-foreground text-xs">
              {drawdowns.count} periods · longest underwater{" "}
              {duration(drawdowns.longestUnderwaterMs)} · avg recovery{" "}
              {duration(drawdowns.avgRecoveryMs)}
              {drawdowns.ongoing ? " · ongoing at end" : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-drawdown-periods>
                <thead>
                  <tr className="border-border border-b text-left text-muted-foreground">
                    <th className={headCell} scope="col">
                      Peak
                    </th>
                    <th className={headCell} scope="col">
                      Trough
                    </th>
                    <th className={headCell} scope="col">
                      Recovered
                    </th>
                    <th className={`${headCell} text-right`} scope="col">
                      Depth
                    </th>
                    <th className={`${headCell} text-right`} scope="col">
                      Decline
                    </th>
                    <th className={`${headCell} text-right`} scope="col">
                      Recovery
                    </th>
                    <th className={`${headCell} text-right`} scope="col">
                      Underwater
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drawdowns.periods.map((period) => {
                    return (
                      <tr
                        className="border-border border-b font-mono"
                        key={period.peakT}
                      >
                        <td className={cell}>{period.peakT}</td>
                        <td className={cell}>{period.troughT}</td>
                        <td className={cell}>
                          {period.recoveryT ?? "ongoing"}
                        </td>
                        <td className={`${numCell} text-destructive`}>
                          {pct(period.depth)}
                        </td>
                        <td className={numCell}>
                          {duration(period.declineMs)}
                        </td>
                        <td className={numCell}>
                          {duration(period.recoveryMs)}
                        </td>
                        <td className={numCell}>
                          {duration(period.underwaterMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <BucketTable
          id="backtest-weekday-heading"
          rows={analytics.pnlBy.weekday}
          title="Net P&L by exit weekday (UTC)"
        />
        <BucketTable
          id="backtest-hour-heading"
          rows={analytics.pnlBy.hour}
          title="Net P&L by exit hour (UTC)"
        />
        <BucketTable
          id="backtest-year-heading"
          rows={analytics.pnlBy.year}
          title="Net P&L by exit year"
        />
        <BucketTable
          id="backtest-month-heading"
          rows={analytics.pnlBy.month}
          title="Net P&L by exit month"
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

export const RegimesPanel = ({
  analytics,
}: {
  readonly analytics: Analytics;
}) => {
  if (analytics.regimes.length === 0)
    return <Empty>No trades carry a regime label.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-regimes>
        <thead>
          <tr className="border-border border-b text-left text-muted-foreground">
            <th className={headCell} scope="col">
              Regime
            </th>
            <th className={`${headCell} text-right`} scope="col">
              Trades
            </th>
            <th className={`${headCell} text-right`} scope="col">
              Win rate
            </th>
            <th className={`${headCell} text-right`} scope="col">
              Avg P&L
            </th>
            <th className={`${headCell} text-right`} scope="col">
              Net P&L
            </th>
            <th className={`${headCell} text-right`} scope="col">
              Profit factor
            </th>
          </tr>
        </thead>
        <tbody>
          {analytics.regimes.map((row) => {
            return (
              <tr className="border-border border-b" key={row.regime}>
                <th className={headCell} scope="row">
                  {row.regime}
                </th>
                <td className={numCell}>{row.trades}</td>
                <td className={numCell}>{pct(row.winRate, 1)}</td>
                <td className={`${numCell} ${tone(row.avgPnl)}`}>
                  {signed(row.avgPnl)}
                </td>
                <td className={`${numCell} ${tone(row.netPnl)}`}>
                  {signed(row.netPnl)}
                </td>
                <td className={numCell}>{num(row.profitFactor)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const BenchmarkStats = ({
  backtest,
}: {
  readonly backtest: Backtest;
}) => {
  const stats = backtest.analytics.benchmark;
  if (backtest.benchmark === null) return <Empty>No benchmark reported.</Empty>;
  if (stats === null)
    return (
      <Empty>
        Fewer than three timestamps shared with {backtest.benchmark.label}.
      </Empty>
    );
  return (
    <StatGrid label="Benchmark comparison">
      <Stat label="Benchmark" value={backtest.benchmark.label} />
      <Stat
        label="Benchmark return"
        value={pct(stats.benchmarkReturn)}
        valueTone={tone(stats.benchmarkReturn)}
      />
      <Stat label="Beta" value={num(stats.beta)} />
      <Stat
        label="Alpha (ann.)"
        value={pct(stats.alphaAnnual)}
        valueTone={tone(stats.alphaAnnual)}
        help="Per-period alpha from an OLS regression on benchmark returns, times observed periods per year."
      />
      <Stat label="Correlation" value={num(stats.correlation)} />
      <Stat label="R²" value={num(stats.rSquared)} />
    </StatGrid>
  );
};

// ---------------------------------------------------------------------------

// 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, ...
export const ordinal = (value: number): string => {
  const whole = Math.round(value);
  const teen = whole % 100 >= 11 && whole % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][whole % 10] ?? "th");
  return `${whole}${suffix}`;
};

const UNAVAILABLE_MESSAGES: Readonly<
  Record<Extract<RatingEvaluation, { status: "unavailable" }>["reason"], string>
> = {
  no_bars:
    "No stored daily bars for this symbol. Import them with bun run vertex:bars:import to replay the ratings.",
  outside_history:
    "The first decision falls outside the stored price history, so there is nothing to replay.",
  too_few_decisions: "The rating series needs at least two decisions.",
  storage_error:
    "The stored price history could not be read. Reload to try again.",
  bad_bars:
    "The stored price history has a zero, negative or missing price in the replay window, so the ratings were not replayed.",
  evaluation_error:
    "The rating replay failed for this result. The stored result is unchanged.",
};

const RATING_LABELS: Readonly<
  Record<ReadyEvaluation["byRating"][number]["rating"], string>
> = {
  buy: "Buy",
  overweight: "Overweight",
  hold: "Hold",
  underweight: "Underweight",
  sell: "Sell",
};

const finalReturn = (equity: number): number => equity / 100 - 1;

const StrategyTable = ({
  evaluation,
}: {
  readonly evaluation: ReadyEvaluation;
}) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[48rem] text-xs" data-placebo-strategies>
      <caption className="sr-only">Rating replay against baselines</caption>
      <thead>
        <tr className="border-border border-b text-left text-muted-foreground">
          <th className={headCell} scope="col">
            Strategy
          </th>
          {[
            "Total return",
            "Annual return",
            "Sharpe",
            "Max drawdown",
            "Trades",
            "Cost drag",
            "Time in market",
          ].map((label) => (
            <th className={`${headCell} text-right`} key={label} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {evaluation.strategies.map((strategy) => {
          const { metrics } = strategy;
          return (
            <tr
              className="border-border border-b"
              data-strategy={strategy.key}
              key={strategy.key}
            >
              <th className={headCell} scope="row">
                {strategy.label}
              </th>
              <td className={`${numCell} ${tone(metrics.totalReturn)}`}>
                {pct(metrics.totalReturn)}
              </td>
              <td className={numCell}>{pct(metrics.annualReturn)}</td>
              <td className={numCell}>{num(metrics.sharpe)}</td>
              <td className={numCell}>{pct(metrics.maxDrawdown)}</td>
              <td className={numCell}>{metrics.trades}</td>
              <td className={numCell}>{pct(metrics.costDrag, 3)}</td>
              <td className={numCell}>{pct(metrics.timeInMarket, 1)}</td>
            </tr>
          );
        })}
        <tr className="border-border border-b" data-strategy="placebo_median">
          <th className={headCell} scope="row">
            Placebo median
          </th>
          <td className={numCell}>
            {pct(finalReturn(evaluation.placebo.finalP50))}
          </td>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <td className={numCell} key={index}>
              {DASH}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  </div>
);

const BandTable = ({
  evaluation,
}: {
  readonly evaluation: ReadyEvaluation;
}) => {
  const agents = evaluation.strategies.find(
    (strategy) => strategy.key === "agents_rating"
  );
  const { placebo } = evaluation;
  const rows = (agents?.equity ?? []).map((point, index) => ({
    t: point.t,
    agents: point.equity,
    p5: placebo.p5[index],
    p50: placebo.p50[index],
    p95: placebo.p95[index],
  }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-placebo-band>
        <caption className="sr-only">
          Agents equity against the placebo band
        </caption>
        <thead>
          <tr className="border-border border-b text-left text-muted-foreground">
            {["Date", "Agents", "Placebo 5%", "Placebo 50%", "Placebo 95%"].map(
              (label, index) => (
                <th
                  className={index === 0 ? headCell : `${headCell} text-right`}
                  key={label}
                  scope="col"
                >
                  {label}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {fanCheckpoints(rows).map((row) => (
            <tr className="border-border border-b" key={row.t}>
              <th className={`${headCell} font-mono`} scope="row">
                {row.t}
              </th>
              <td className={numCell}>{num(row.agents)}</td>
              <td className={numCell}>{num(row.p5)}</td>
              <td className={numCell}>{num(row.p50)}</td>
              <td className={numCell}>{num(row.p95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ByRatingTable = ({
  evaluation,
}: {
  readonly evaluation: ReadyEvaluation;
}) => (
  <div className="overflow-x-auto">
    <table className="w-full text-xs" data-placebo-by-rating>
      <caption className="sr-only">Next-period return by rating</caption>
      <thead>
        <tr className="border-border border-b text-left text-muted-foreground">
          {[
            "Rating",
            "Decisions",
            "Hit rate",
            "Average next return (close to close)",
          ].map((label, index) => (
            <th
              className={index === 0 ? headCell : `${headCell} text-right`}
              key={label}
              scope="col"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {evaluation.byRating.map((row) => (
          <tr
            className="border-border border-b"
            data-rating={row.rating}
            key={row.rating}
          >
            <th className={headCell} scope="row">
              {RATING_LABELS[row.rating]}
            </th>
            <td className={numCell}>{row.decisions}</td>
            <td className={numCell}>{pct(row.hitRate, 1)}</td>
            <td className={`${numCell} ${tone(row.averageNextReturn)}`}>
              {pct(row.averageNextReturn)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/**
 * Replay of the agent rating series against buy and hold, the 50/200-day MA rule and the same
 * ratings shuffled across the same dates. `equityChart` renders the agents equity line.
 */
export const PlaceboPanel = ({
  evaluation,
  equityChart,
}: {
  readonly evaluation: RatingEvaluation | null;
  readonly equityChart: (
    points: readonly { t: string; value: number }[]
  ) => ReactNode;
}) => {
  if (evaluation === null) return null;
  const notice = (
    <p className="text-muted-foreground text-xs" data-research-notice>
      Research only. Agent ratings never place orders.
    </p>
  );
  if (evaluation.status === "unavailable")
    return (
      <div className="space-y-2" data-placebo={evaluation.reason}>
        <Empty>{UNAVAILABLE_MESSAGES[evaluation.reason]}</Empty>
        {notice}
      </div>
    );
  const { placebo } = evaluation;
  const agents = evaluation.strategies.find(
    (strategy) => strategy.key === "agents_rating"
  );
  return (
    <div className="space-y-5" data-placebo="ready">
      {notice}
      <p className="font-mono text-muted-foreground text-xs">
        {evaluation.symbol} · {evaluation.startDate} to {evaluation.endDate} ·{" "}
        {evaluation.days} days · cost {num(evaluation.costBps)} bp
      </p>
      <p className="text-sm" data-placebo-summary>
        Agents finished at the {ordinal(placebo.agentsPercentile)} percentile of{" "}
        {placebo.sims} shuffled-rating placebos (5th-95th band{" "}
        {pct(finalReturn(placebo.finalP5), 1)} to{" "}
        {pct(finalReturn(placebo.finalP95), 1)}).
        <InfoGlyph
          text={
            placebo.exhaustive
              ? "Every distinct ordering of the same ratings over the same dates ran once."
              : `Seeded random orderings of the same ratings over the same dates (seed ${placebo.seed}).`
          }
        />
      </p>
      <section
        aria-labelledby="backtest-placebo-strategies"
        className="space-y-2"
      >
        <SectionTitle
          help="Each decision trades at the next open. Buy is 100% long, overweight 50%, hold and failed runs keep the position, underweight and sell are flat."
          id="backtest-placebo-strategies"
        >
          Rating replay against baselines
        </SectionTitle>
        <StrategyTable evaluation={evaluation} />
      </section>
      <section aria-labelledby="backtest-placebo-band" className="space-y-2">
        <SectionTitle id="backtest-placebo-band">
          Equity against the placebo band
        </SectionTitle>
        {equityChart(
          (agents?.equity ?? []).map((point) => ({
            t: point.t,
            value: point.equity,
          }))
        )}
        <BandTable evaluation={evaluation} />
      </section>
      <section aria-labelledby="backtest-placebo-ratings" className="space-y-2">
        <SectionTitle
          help="Return from the decision close to the next decision close (the last bar for the final decision). A hit is a rise after buy or overweight and a fall after underweight or sell; hold has no hit rate."
          id="backtest-placebo-ratings"
        >
          By rating
        </SectionTitle>
        <ByRatingTable evaluation={evaluation} />
        <p className="text-muted-foreground text-xs" data-failed-decisions>
          Failed or unrated runs: {evaluation.failedDecisions}. They keep the
          position and are never counted as hold.
        </p>
      </section>
    </div>
  );
};
