"use client";

import {
  type BacktestRunReportOutput,
  type HistogramBin,
  type RunMonteCarlo,
  runMonteCarlo,
  propRulesUseEquity,
  simulatePropRules,
  type TradeGroupRow,
  tradesAnalysis,
} from "@darkfactory/api";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
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
const share = (value: number) => `${(value * 100).toFixed(1)}%`;
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
  const from = Math.min(...bins.map((bin) => bin.from));
  const to = Math.max(...bins.map((bin) => bin.to));
  return (
    <figure className="grid gap-1">
      <figcaption className="font-medium text-sm">{label}</figcaption>
      <svg
        aria-label={`${label}: ${bins.length} bins from ${format(from)} to ${format(to)}`}
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
        <span>{format(from)}</span>
        <span>{format(to)}</span>
      </div>
    </figure>
  );
};

const GroupTable = ({
  caption,
  rows,
}: Readonly<{ caption: string; rows: readonly TradeGroupRow[] }>) => (
  <Table className="w-full text-sm tabular-nums">
    <TableCaption className="mt-0 caption-top pb-1 text-left font-medium text-foreground">
      {caption}
    </TableCaption>
    <TableHeader className="text-left">
      <TableRow>
        <TableHead className="p-1" scope="col">
          Group
        </TableHead>
        <TableHead className="p-1" scope="col">
          Trades
        </TableHead>
        <TableHead className="p-1" scope="col">
          Win rate
        </TableHead>
        <TableHead className="p-1" scope="col">
          Net P/L
        </TableHead>
        <TableHead className="p-1" scope="col">
          Avg P/L
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow className="border-t" key={row.key}>
          <TableCell className="whitespace-normal p-1">{row.key}</TableCell>
          <TableCell className="whitespace-normal p-1">{row.trades}</TableCell>
          <TableCell className="whitespace-normal p-1">
            {share(row.winRate)}
          </TableCell>
          <TableCell className="whitespace-normal p-1">
            {money(row.netPnl)}
          </TableCell>
          <TableCell className="whitespace-normal p-1">
            {money(row.avgPnl)}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
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
          ["Win rate", share(analysis.wins / analysis.trades)],
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
  const lastStep = Math.max(1, ...fan.map((point) => point.step));
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
        firm. Limits are a percent of the starting balance ({money(capital)})
        per UTC day,{" "}
        {propRulesUseEquity(report)
          ? "measured on account equity at each bar, so open-trade drawdown counts (moves inside one bar are not seen)."
          : "measured on closed trade P/L (this report has no full per-bar equity curve, so open-trade drawdown is not seen)."}{" "}
        Pass rate reshuffles the order of the same trading days.
      </p>
      <div className="overflow-auto rounded-md border">
        <Table
          className="w-full text-sm tabular-nums"
          containerClassName="overflow-visible"
        >
          <TableHeader className="text-left">
            <TableRow>
              <TableHead className="p-2" scope="col">
                Rule set
              </TableHead>
              <TableHead className="p-2" scope="col">
                Target / daily / max loss
              </TableHead>
              <TableHead className="p-2" scope="col">
                Result
              </TableHead>
              <TableHead className="p-2" scope="col">
                Why
              </TableHead>
              <TableHead className="p-2" scope="col">
                Pass rate
              </TableHead>
              <TableHead className="p-2" scope="col">
                Fail rate
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map(({ rule, outcome, passRate, failRate, paths }) => (
              <TableRow
                className="border-t"
                data-prop-status={outcome.status}
                key={rule.id}
              >
                <TableCell className="whitespace-normal p-2">
                  {rule.label}
                </TableCell>
                <TableCell className="whitespace-normal p-2">
                  {rule.profitTargetPct}% /{" "}
                  {rule.maxDailyLossPct === null
                    ? "none"
                    : `${rule.maxDailyLossPct}%`}{" "}
                  / {rule.maxLossPct}% {rule.drawdown}
                  {rule.consistencyPct === null
                    ? ""
                    : `, best day ≤ ${rule.consistencyPct}%`}
                  , min {rule.minTradingDays} days
                </TableCell>
                <TableCell className="whitespace-normal p-2 font-medium">
                  {outcome.status === "passed"
                    ? "Pass"
                    : outcome.status === "failed"
                      ? "Fail"
                      : "Not decided"}
                </TableCell>
                <TableCell className="whitespace-normal p-2">
                  {outcome.reason}
                  {outcome.decidedOn === null ? "" : ` (${outcome.decidedOn})`}
                </TableCell>
                <TableCell className="whitespace-normal p-2">
                  {paths === 0 ? "—" : share(passRate)}
                </TableCell>
                <TableCell className="whitespace-normal p-2">
                  {paths === 0 ? "—" : share(failRate)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
      {report.tradesTruncated ? (
        <p className="rounded-md border p-2 text-sm" role="status">
          The report keeps only the first {report.trades.length} trades, so the
          Monte Carlo covers those trades only.
          {propRulesUseEquity(report)
            ? " The prop-firm rules use the full equity curve."
            : " The prop-firm rules also use only those trades."}
        </p>
      ) : null}
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
