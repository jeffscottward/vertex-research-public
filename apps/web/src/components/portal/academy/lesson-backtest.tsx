"use client";

// Backtest area: a preset scenario and tickers per lesson, all editable. Results are MODELED option
// prices on stored daily bars (labeled on screen). Charts use the lesson palette.
import type { AcademyBacktestOutput } from "@darkfactory/api";
import {
  type DataTable,
  type Lesson,
  type SceneData,
  STRUCTURE_DEFS,
} from "@darkfactory/academy";
import { LessonChart } from "@darkfactory/academy/chart";
import { FlaskConical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { type AcademyGateway, errorMessage } from "./academy-client.ts";
import { useAcademyTheme } from "./academy-theme.tsx";
import { TableView } from "./lesson-interactive.tsx";

const RULE_LABELS: Readonly<Record<string, string>> = {
  dte: "Days to expiry (cycle legs)",
  coreDte: "Days to expiry (core leg)",
  coreExitDte: "Roll core leg at DTE",
  exitDte: "Close cycle legs at DTE",
  longDelta: "Long leg delta",
  shortDelta: "Short leg delta",
  coreDelta: "Core leg delta",
  shortPutDelta: "Short put delta",
  longPutDelta: "Long put delta",
  shortCallDelta: "Short call delta",
  longCallDelta: "Long call delta",
  putDelta: "Put delta",
  callDelta: "Call delta",
  atmPut: "ATM put delta",
  atmCall: "ATM call delta",
  wingPutDelta: "Put wing delta",
  wingCallDelta: "Call wing delta",
  profitTakePct: "Take profit (% of entry premium)",
  stopLossPct: "Stop loss (% of entry premium)",
  riskPct: "Max loss per position (% of equity)",
  ivMult: "IV = RV20 x",
  costPerContract: "Commission per contract ($)",
  slippagePct: "Slippage (% of premium)",
  slipCap: "Slippage cap ($ per share)",
};

const pct = (value: number | null, digits = 1) =>
  value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
const usd = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const yearOf = (date: string) => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const start = Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
  return new Date(ms).getUTCFullYear() + (ms - start) / (365.25 * 86_400_000);
};

const resultScene = (result: AcademyBacktestOutput): SceneData => {
  const equity = result.equity.map(
    (point) => [yearOf(point.t), point.equity] as const
  );
  const benchmark = result.benchmark.map(
    (point) => [yearOf(point.t), point.equity] as const
  );
  const drawdown = result.drawdown.map(
    (point) => [yearOf(point.t), point.drawdown * 100] as const
  );
  const xs = equity.map((point) => point[0]);
  const ys = [...equity, ...benchmark].map((point) => point[1]);
  const low = Math.min(...ys);
  const high = Math.max(...ys);
  return {
    panels: [
      {
        id: "equity",
        title: `Equity: ${result.structure.replace(/_/gu, " ")} on ${result.ticker} vs buy and hold`,
        xLabel: "Year",
        yLabel: "Equity ($)",
        xDomain: [Math.min(...xs), Math.max(...xs)],
        yDomain: [low - (high - low) * 0.05, high + (high - low) * 0.05],
        series: [
          {
            element: "b",
            label: `Buy and hold ${result.ticker}`,
            points: benchmark,
            width: 1.5,
            dashed: true,
          },
          {
            element: "a",
            label: "Strategy (modeled)",
            points: equity,
            width: 2.5,
          },
        ],
        markers: [],
        bars: [],
        elements: ["a", "b"],
        xFormat: "count",
        yFormat: "usd",
      },
      {
        id: "drawdown",
        title: "Strategy drawdown",
        xLabel: "Year",
        yLabel: "Drawdown (%)",
        xDomain: [Math.min(...xs), Math.max(...xs)],
        yDomain: [Math.min(...drawdown.map((point) => point[1]), -1) * 1.1, 0],
        series: [
          {
            element: "drawdown",
            label: "Drawdown",
            points: drawdown,
            width: 1.5,
            fill: true,
          },
        ],
        markers: [],
        bars: [],
        elements: ["drawdown"],
        xFormat: "count",
        yFormat: "pct",
      },
    ],
    horizon: 1,
    timeLabel: "",
    timeUnit: "days",
    now: 1,
    layout: "stack",
  };
};

const statsTable = (result: AcademyBacktestOutput): DataTable => ({
  id: "bt-stats",
  title: "Backtest results (modeled)",
  columns: ["Measure", "Strategy", `Buy and hold ${result.ticker}`],
  rows: [
    [
      "Total return",
      pct(result.stats.totalReturn),
      pct(result.stats.benchmarkReturn),
    ],
    ["CAGR", pct(result.stats.cagr), ""],
    [
      "Max drawdown",
      pct(result.stats.maxDrawdown),
      pct(result.stats.benchmarkMaxDrawdown),
    ],
    ["Sharpe", result.stats.sharpe.toFixed(2), ""],
    [
      "Sortino",
      result.stats.sortino === null ? "n/a" : result.stats.sortino.toFixed(2),
      "",
    ],
    ["Annual volatility", pct(result.stats.volatility), ""],
    ["Trades (closed)", String(result.stats.trades), ""],
    ["Win rate", pct(result.stats.winRate), ""],
    ["Average P&L per trade", usd(result.stats.avgPnl), ""],
    [
      "Profit factor",
      result.stats.profitFactor === null
        ? "n/a"
        : result.stats.profitFactor.toFixed(2),
      "",
    ],
    ["Time in market", pct(result.stats.exposure, 0), "100%"],
    ["Final equity", usd(result.stats.finalEquity), ""],
  ],
  note: `Data: ${result.data.source}; ${result.data.bars} daily bars ${result.data.first} to ${result.data.last}. Implied volatility: ${result.ivSource === "supplied" ? "VIX index (SPY)" : "realized-volatility model"}.`,
});

const tradesTable = (
  result: AcademyBacktestOutput,
  limit: number
): DataTable => ({
  id: "bt-trades",
  title: `Trades (${Math.min(limit, result.trades.length)} most recent of ${result.tradesTotal})`,
  columns: [
    "Entry",
    "Exit",
    "Legs",
    "Units",
    "Spot in",
    "Spot out",
    "Entry net",
    "Exit value",
    "Costs",
    "P&L",
    "Exit reason",
  ],
  rows: result.trades
    .slice(-limit)
    .reverse()
    .map((trade) => [
      trade.entryT,
      trade.exitT,
      trade.legs.join(" | "),
      String(trade.units),
      trade.spotEntry.toFixed(2),
      trade.spotExit.toFixed(2),
      usd(trade.entryNet),
      usd(trade.exitValue),
      usd(trade.costs),
      usd(trade.pnl),
      trade.reason,
    ]),
});

export const LessonBacktest = ({
  lesson,
  gateway,
  onResult,
}: {
  readonly lesson: Lesson;
  readonly gateway: AcademyGateway;
  readonly onResult?: (result: AcademyBacktestOutput) => void;
}) => {
  const { palette } = useAcademyTheme();
  const preset = lesson.backtest;
  const initialRules = useMemo(
    () =>
      preset === undefined
        ? {}
        : { ...STRUCTURE_DEFS[preset.structure].defaults, ...preset.rules },
    [preset]
  );
  const [tickers, setTickers] = useState<string[]>(preset?.tickers ?? []);
  const [ticker, setTicker] = useState(preset?.tickers[0] ?? "SPY");
  const [start, setStart] = useState(preset?.scenario.start ?? "2018-01-01");
  const [end, setEnd] = useState(preset?.scenario.end ?? "2024-12-31");
  const [rules, setRules] = useState<Record<string, number>>(initialRules);
  const [capital, setCapital] = useState(100_000);
  const [state, setState] = useState<{
    status: "idle" | "running" | "ready" | "error";
    result: AcademyBacktestOutput | null;
    message: string | null;
  }>({ status: "idle", result: null, message: null });
  const [tradeLimit, setTradeLimit] = useState(25);

  useEffect(() => {
    let active = true;
    gateway.tickers().then(
      (output) => {
        if (!active) return;
        const stored = output.tickers.map((entry) => entry.ticker);
        setTickers([
          ...new Set([
            ...(preset?.tickers ?? []).filter((entry) =>
              stored.includes(entry)
            ),
            ...stored,
          ]),
        ]);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [gateway, preset]);

  const run = () => {
    if (preset === undefined) return;
    setState((current) => ({ ...current, status: "running", message: null }));
    gateway
      .backtest({ slug: lesson.slug, ticker, start, end, rules, capital })
      .then(
        (output) => {
          setState({ status: "ready", result: output, message: null });
          onResult?.(output);
        },
        (error: unknown) =>
          setState({
            status: "error",
            result: null,
            message: errorMessage(error),
          })
      );
  };

  // Run the preset scenario once on load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preset run only on first render.
  useEffect(() => {
    run();
  }, []);

  if (preset === undefined) return null;
  const result = state.result;
  return (
    <div className="flex flex-col gap-4" data-lesson-backtest>
      <p
        className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        role="note"
      >
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <strong>Modeled.</strong> Prices of the options are computed with
          Black-Scholes from daily closes and a volatility model. There is no
          stored history of option quotes for these tickers, so fills, skew and
          early assignment are approximations. Preset: {preset.scenario.label}.{" "}
          {preset.note ?? ""}
        </span>
      </p>
      <form
        className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="bt-ticker"
        >
          Ticker
          <select
            className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
            id="bt-ticker"
            onChange={(event) => setTicker(event.target.value)}
            value={ticker}
          >
            {[...new Set([ticker, ...tickers])].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="bt-start"
        >
          Start
          <input
            className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
            id="bt-start"
            onChange={(event) => setStart(event.target.value)}
            type="date"
            value={start}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="bt-end"
        >
          End
          <input
            className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
            id="bt-end"
            onChange={(event) => setEnd(event.target.value)}
            type="date"
            value={end}
          />
        </label>
        <label
          className="flex flex-col gap-1 text-muted-foreground text-xs"
          htmlFor="bt-capital"
        >
          Capital ($)
          <input
            className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
            id="bt-capital"
            min={1000}
            onChange={(event) => setCapital(Number(event.target.value))}
            step={1000}
            type="number"
            value={capital}
          />
        </label>
        {Object.entries(rules).map(([key, value]) => (
          <label
            className="flex flex-col gap-1 text-muted-foreground text-xs"
            htmlFor={`bt-rule-${key}`}
            key={key}
          >
            {RULE_LABELS[key] ?? key}
            <input
              className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm tabular-nums"
              id={`bt-rule-${key}`}
              onChange={(event) =>
                setRules((current) => ({
                  ...current,
                  [key]: Number(event.target.value),
                }))
              }
              step="any"
              type="number"
              value={value}
            />
          </label>
        ))}
        <div className="col-span-full flex flex-wrap gap-2">
          <button
            className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
            data-run-backtest
            disabled={state.status === "running"}
            type="submit"
          >
            {state.status === "running" ? "Running…" : "Run backtest"}
          </button>
          <button
            className="min-h-11 rounded-md border border-border px-3 text-sm"
            onClick={() => {
              setRules(initialRules);
              setTicker(preset.tickers[0] ?? "SPY");
              setStart(preset.scenario.start);
              setEnd(preset.scenario.end);
            }}
            type="button"
          >
            Reset to preset
          </button>
        </div>
      </form>
      {state.status === "error" ? (
        <p
          className="rounded-md border border-destructive p-3 text-destructive text-sm"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}
      {state.status === "running" && result === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Running the modeled backtest…
        </p>
      ) : null}
      {result === null ? null : (
        <div
          className="flex flex-col gap-3"
          data-backtest-result
          data-backtest-trades={result.tradesTotal}
        >
          <div className="overflow-hidden rounded-lg border border-border">
            <LessonChart
              colors={{ a: "gold", b: "gray", drawdown: "red" }}
              height={560}
              idPrefix="bt"
              palette={palette}
              revealed="all"
              scene={resultScene(result)}
              width={1280}
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <TableView table={statsTable(result)} />
            <TableView
              table={{
                id: "bt-rules",
                title: "Rules used",
                columns: ["Rule", "Value"],
                rows: Object.entries(result.rules).map(([key, value]) => [
                  RULE_LABELS[key] ?? key,
                  String(value),
                ]),
                note: result.assumptions.join(" "),
              }}
            />
          </div>
          <TableView table={tradesTable(result, tradeLimit)} />
          {result.trades.length > tradeLimit ? (
            <button
              className="min-h-11 self-start rounded-md border border-border px-3 text-sm"
              onClick={() => setTradeLimit(result.trades.length)}
              type="button"
            >
              Show all {result.trades.length} trades
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};
