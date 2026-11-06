"use client";

import {
  type BacktestRunReportOutput,
  type HistogramBin,
  type RunMonteCarlo,
  runMonteCarlo,
  simulatePropRules,
  type TradeGroupRow,
  tradesAnalysis,
} from "@darkfactory/api";
import { useMemo, useState } from "react";

// Backtest report depth (LuxAlgo gap P3): the Trades Analysis and Simulation tabs of a run report.
// Everything is computed in the browser from the stored run report. Research only; no orders.

const WIDTH = 640;
const CONE_HEIGHT = 220;
const HIST_HEIGHT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

const money = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      });
const share = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const holdDays = (ms: number | null) =>
  ms === null ? "—" : `${(ms / DAY_MS).toFixed(1)} d`;

const Stats = ({
  rows,
}: Readonly<{ rows: readonly (readonly [string, string])[] }>) => (
  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {rows.map(([label, value]) => (
      <div className="flex justify-between gap-4 border-b py-1" key={label}>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="font-medium tabular-nums">{value}</dd>
      </div>
    ))}
  </dl>
);

export const Histogram = ({
  bins,
  format,
  label,
}: Readonly<{
  bins: readonly HistogramBin[];
  format: (value: number) => string;
  label: string;
}>) => {
  if (bins.length === 0)
    return <p className="text-muted-foreground text-sm">{label}: no data.</p>;
  const most = Math.max(...bins.map((bin) => bin.count), 1);
  const width = WIDTH / bins.length;
  const first = bins[0];
  const last = bins.at(-1);
  return (
    <figure className="grid gap-1">
      <figcaption className="font-medium text-sm">{label}</figcaption>
      <svg
        aria-label={`${label}: ${bins.length} bins from ${format(first?.from ?? 0)} to ${format(last?.to ?? 0)}`}
        className="h-auto w-full rounded-md border bg-background"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HIST_HEIGHT}`}
      >
        {bins.map((bin, index) => {
          const height = (bin.count / most) * (HIST_HEIGHT - 4);
          return (
            <rect
              fill={bin.to <= 0 ? "var(--destructive)" : "var(--foreground)"}
              height={height}
              key={`${bin.from}`}
              opacity={0.7}
              width={Math.max(1, width - 1)}
              x={index * width}
              y={HIST_HEIGHT - height}
            >
              <title>{`${format(bin.from)} to ${format(bin.to)}: ${bin.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{format(first?.from ?? 0)}</span>
        <span>{format(last?.to ?? 0)}</span>
      </div>
    </figure>
  );
};

const GroupTable = ({
  caption,
  rows,
}: Readonly<{ caption: string; rows: readonly TradeGroupRow[] }>) => (
  <table className="w-full text-sm tabular-nums">
    <caption className="pb-1 text-left font-medium">{caption}</caption>
    <thead className="text-left text-muted-foreground">
      <tr>
        <th className="p-1">Group</th>
        <th className="p-1">Trades</th>
        <th className="p-1">Win rate</th>
        <th className="p-1">Net P/L</th>
        <th className="p-1">Avg P/L</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr className="border-t" key={row.key}>
          <td className="p-1">{row.key}</td>
          <td className="p-1">{row.trades}</td>
          <td className="p-1">{share(row.winRate)}</td>
          <td className="p-1">{money(row.netPnl)}</td>
          <td className="p-1">{money(row.avgPnl)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export const TradesAnalysisPanel = ({
  report,
}: Readonly<{ report: BacktestRunReportOutput }>) => {
  const analysis = useMemo(() => tradesAnalysis(report.trades), [report]);
  if (analysis.trades === 0)
    return <p className="text-muted-foreground text-sm">No trades.</p>;
  return (
    <div className="grid gap-6">
      <Stats
        rows={[
          ["Trades", String(analysis.trades)],
          ["Wins / losses", `${analysis.wins} / ${analysis.losses}`],
          ["Win rate", share(analysis.winRate)],
          ["Average win", money(analysis.avgWin)],
          ["Average loss", money(analysis.avgLoss)],
          [
            "Payoff ratio",
            analysis.payoffRatio === null
              ? "—"
              : analysis.payoffRatio.toFixed(2),
          ],
          ["Expectancy per trade", money(analysis.expectancy)],
          ["Largest win", money(analysis.largestWin)],
          ["Largest loss", money(analysis.largestLoss)],
          ["Average hold", holdDays(analysis.avgHoldMs)],
          ["Average hold, wins", holdDays(analysis.avgHoldWinMs)],
          ["Average hold, losses", holdDays(analysis.avgHoldLossMs)],
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <GroupTable caption="By exit reason" rows={analysis.byExitReason} />
        <GroupTable
          caption="By entry weekday (UTC)"
          rows={analysis.byWeekday}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Histogram
          bins={analysis.pnlHistogram}
          format={(value) => value.toFixed(0)}
          label="Trade P/L distribution"
        />
        <Histogram
          bins={analysis.holdDaysHistogram}
          format={(value) => `${value.toFixed(1)} d`}
          label="Holding time distribution"
        />
      </div>
      {report.tradesTruncated ? (
        <p className="text-muted-foreground text-xs">
          Based on the first {report.trades.length} trades.
        </p>
      ) : null}
    </div>
  );
};

const MonteCarloCone = ({ result }: Readonly<{ result: RunMonteCarlo }>) => {
  const { fan } = result.run;
  const lastStep = fan.at(-1)?.step ?? 1;
  let low = 0;
  let high = 0;
  for (const point of fan) {
    low = Math.min(low, point.p5);
    high = Math.max(high, point.p95);
  }
  const span = high - low || 1;
  const x = (step: number) => (step / lastStep) * WIDTH;
  const y = (value: number) =>
    CONE_HEIGHT - ((value - low) / span) * CONE_HEIGHT;
  const band = (upper: "p95" | "p75", lower: "p5" | "p25") =>
    `M0,${y(0)}${fan.map((p) => `L${x(p.step).toFixed(1)},${y(p[upper]).toFixed(1)}`).join("")}${[
      ...fan,
    ]
      .reverse()
      .map((p) => `L${x(p.step).toFixed(1)},${y(p[lower]).toFixed(1)}`)
      .join("")}L0,${y(0)}Z`;
  const median = `M0,${y(0)}${fan.map((p) => `L${x(p.step).toFixed(1)},${y(p.p50).toFixed(1)}`).join("")}`;
  return (
    <figure className="grid gap-1">
      <figcaption className="font-medium text-sm">
        Monte Carlo cone: P/L after each trade, 5–95% and 25–75% bands, median
        line
      </figcaption>
      <svg
        aria-label={`Monte Carlo cone over ${lastStep} trades, ${result.paths} paths; median final P/L ${result.run.finalPnl.p50.toFixed(0)}`}
        className="h-auto w-full rounded-md border bg-background"
        role="img"
        viewBox={`0 0 ${WIDTH} ${CONE_HEIGHT}`}
      >
        <path d={band("p95", "p5")} fill="var(--vx-gold)" opacity={0.15} />
        <path d={band("p75", "p25")} fill="var(--vx-gold)" opacity={0.3} />
        <line
          stroke="var(--muted-foreground)"
          strokeDasharray="4 4"
          x1={0}
          x2={WIDTH}
          y1={y(0)}
          y2={y(0)}
        />
        <path
          d={median}
          fill="none"
          stroke="var(--foreground)"
          strokeWidth={2}
        />
      </svg>
    </figure>
  );
};

const PropRulesTable = ({
  capital,
  report,
}: Readonly<{ capital: number; report: BacktestRunReportOutput }>) => {
  const results = useMemo(
    () => simulatePropRules(report, capital),
    [report, capital]
  );
  return (
    <section aria-label="Prop-firm rules" className="grid gap-2">
      <h3 className="font-semibold text-base">Prop-firm rule simulation</h3>
      <p className="text-muted-foreground text-xs">
        Generic rule sets modeled on common evaluation formats, not tied to any
        firm. Limits are a percent of the starting balance ({money(capital)}) on
        closed P/L per UTC day. Pass rate reshuffles the order of the same
        trading days.
      </p>
      <div className="overflow-auto rounded-md border">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-2">Rule set</th>
              <th className="p-2">Target / daily / max loss</th>
              <th className="p-2">Result</th>
              <th className="p-2">Why</th>
              <th className="p-2">Pass rate</th>
              <th className="p-2">Fail rate</th>
            </tr>
          </thead>
          <tbody>
            {results.map(({ rule, outcome, passRate, failRate, paths }) => (
              <tr
                className="border-t"
                data-prop-status={outcome.status}
                key={rule.id}
              >
                <td className="p-2">{rule.label}</td>
                <td className="p-2">
                  {rule.profitTargetPct}% /{" "}
                  {rule.maxDailyLossPct === null
                    ? "none"
                    : `${rule.maxDailyLossPct}%`}{" "}
                  / {rule.maxLossPct}% {rule.drawdown}
                  {rule.consistencyPct === null
                    ? ""
                    : `, best day ≤ ${rule.consistencyPct}%`}
                  , min {rule.minTradingDays} days
                </td>
                <td className="p-2 font-medium">
                  {outcome.status === "passed"
                    ? "Pass"
                    : outcome.status === "failed"
                      ? "Fail"
                      : "Not decided"}
                </td>
                <td className="p-2">
                  {outcome.reason}
                  {outcome.decidedOn === null ? "" : ` (${outcome.decidedOn})`}
                </td>
                <td className="p-2">{paths === 0 ? "—" : share(passRate)}</td>
                <td className="p-2">{paths === 0 ? "—" : share(failRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export const SimulationPanel = ({
  capital,
  report,
}: Readonly<{ capital: number; report: BacktestRunReportOutput }>) => {
  const [mode, setMode] = useState<"reshuffle" | "bootstrap">("reshuffle");
  const result = useMemo(
    () => runMonteCarlo(report, capital, mode),
    [report, capital, mode]
  );
  return (
    <div className="grid gap-6">
      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">Monte Carlo method</legend>
        {(
          [
            ["reshuffle", "Reshuffle trade order"],
            ["bootstrap", "Bootstrap trades (with replacement)"],
          ] as const
        ).map(([value, label]) => (
          <label className="flex min-h-11 items-center gap-2" key={value}>
            <input
              checked={mode === value}
              name="monte-carlo-mode"
              onChange={() => setMode(value)}
              type="radio"
            />
            {label}
          </label>
        ))}
      </fieldset>
      {result === null ? (
        <p className="text-muted-foreground text-sm">
          Monte Carlo needs at least two trades.
        </p>
      ) : (
        <>
          <Stats
            rows={[
              ["Paths", result.paths.toLocaleString("en-US")],
              ["Paths in profit", share(result.run.probabilityOfProfit)],
              ["Risk of ruin (50% loss)", share(result.run.riskOfRuin)],
              ["Median final P/L", money(result.run.finalPnl.p50)],
              [
                "Final P/L 5–95%",
                `${money(result.run.finalPnl.p5)} to ${money(result.run.finalPnl.p95)}`,
              ],
              [
                "Max drawdown 5% worst",
                `${(result.run.maxDrawdown.p5 * 100).toFixed(1)}%`,
              ],
            ]}
          />
          <MonteCarloCone result={result} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Histogram
              bins={result.finalPnlHistogram}
              format={(value) => value.toFixed(0)}
              label="Final P/L across paths"
            />
            <Histogram
              bins={result.maxDrawdownHistogram}
              format={(value) => `${value.toFixed(1)}%`}
              label="Max drawdown across paths"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Seed {result.seed} (from the data hash), so the result repeats.
          </p>
        </>
      )}
      <PropRulesTable capital={capital} report={report} />
    </div>
  );
};
