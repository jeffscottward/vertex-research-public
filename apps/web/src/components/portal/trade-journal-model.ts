// What: pure math for the read-only Trade Journal: KPIs, per-symbol rows, the chronological fill
// list and the cumulative realized P&L line, all from the IBKR executions of one snapshot.
// Used by: trade-journal.tsx, trade-journal-chart.tsx, dashboard-widgets.tsx (journal summary).
// See: packages/api/src/contracts/portfolio-monitor.ts (PortfolioMonitorExecutionSchema).
import type { PortfolioMonitorExecution } from "@darkfactory/api";

import { ibkrTimeKey } from "./portfolio-monitor-model.ts";

type Num = number | null;

export type JournalKpis = Readonly<{
  fills: number;
  /** Sum of the realized P&L IBKR reported; fills without a commission report count as 0. */
  realized: number;
  commissions: number;
  /** Fills with realized P&L other than 0 (closing fills). */
  closing: number;
  wins: number;
  losses: number;
  /** wins / closing, 0..1; null when no fill closed anything. */
  winRate: Num;
  avgWin: Num;
  avgLoss: Num;
}>;

export type JournalSymbolRow = Readonly<{
  symbol: string;
  fills: number;
  bought: number;
  sold: number;
  realized: number;
  commissions: number;
  winRate: Num;
}>;

export type JournalPoint = Readonly<{ time: string; value: number }>;

const amount = (value: Num): number => value ?? 0;

const isClosing = (execution: PortfolioMonitorExecution): boolean =>
  execution.realized !== null && execution.realized !== 0;

const mean = (values: readonly number[]): Num =>
  values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;

/** IBKR sends BOT/SLD; some feeds send BUY/SELL. */
export const sideLabel = (side: string): "Buy" | "Sell" | string => {
  const upper = side.trim().toUpperCase();
  if (upper === "BOT" || upper === "BUY") return "Buy";
  if (upper === "SLD" || upper === "SELL") return "Sell";
  return side;
};

/** Oldest first by IBKR time. Rows without a readable time keep their arrival order. */
export const chronologicalFills = (
  executions: readonly PortfolioMonitorExecution[]
): PortfolioMonitorExecution[] =>
  executions
    .map((execution, index) => ({
      execution,
      index,
      key: ibkrTimeKey(execution.time),
    }))
    .sort((left, right) => {
      if (left.key !== null && right.key !== null && left.key !== right.key)
        return left.key.localeCompare(right.key);
      return left.index - right.index;
    })
    .map((entry) => entry.execution);

export const journalKpis = (
  executions: readonly PortfolioMonitorExecution[]
): JournalKpis => {
  const closing = executions
    .filter(isClosing)
    .map((execution) => amount(execution.realized));
  const wins = closing.filter((value) => value > 0);
  const losses = closing.filter((value) => value < 0);
  return {
    avgLoss: mean(losses),
    avgWin: mean(wins),
    closing: closing.length,
    commissions: executions.reduce(
      (total, execution) => total + amount(execution.commission),
      0
    ),
    fills: executions.length,
    losses: losses.length,
    realized: executions.reduce(
      (total, execution) => total + amount(execution.realized),
      0
    ),
    winRate: closing.length === 0 ? null : wins.length / closing.length,
    wins: wins.length,
  };
};

/** One row per symbol, alphabetical. */
export const journalSymbolRows = (
  executions: readonly PortfolioMonitorExecution[]
): JournalSymbolRow[] => {
  const groups = new Map<string, PortfolioMonitorExecution[]>();
  for (const execution of executions) {
    const group = groups.get(execution.symbol);
    if (group === undefined) groups.set(execution.symbol, [execution]);
    else group.push(execution);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([symbol, group]) => {
      const kpis = journalKpis(group);
      const shares = (side: "Buy" | "Sell") =>
        group
          .filter((execution) => sideLabel(execution.side) === side)
          .reduce((total, execution) => total + amount(execution.shares), 0);
      return {
        bought: shares("Buy"),
        commissions: kpis.commissions,
        fills: kpis.fills,
        realized: kpis.realized,
        sold: shares("Sell"),
        symbol,
        winRate: kpis.winRate,
      };
    });
};

/** Running realized P&L after each closing fill, oldest first, from a 0 start. */
export const cumulativeRealized = (
  executions: readonly PortfolioMonitorExecution[]
): JournalPoint[] => {
  let running = 0;
  return chronologicalFills(executions)
    .filter(isClosing)
    .map((execution) => {
      running += amount(execution.realized);
      return { time: execution.time, value: running };
    });
};

export type ChartGeometry = Readonly<{
  path: string;
  /** y of the 0 line. */
  zeroY: number;
}>;

/** SVG path through 0 and each point, scaled to width x height (y grows downward). */
export const lineGeometry = (
  points: readonly JournalPoint[],
  width: number,
  height: number
): ChartGeometry => {
  const values = [0, ...points.map((point) => point.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min === 0 ? 1 : max - min;
  const y = (value: number) =>
    Number((height - ((value - min) / range) * height).toFixed(2));
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const path = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${Number((index * step).toFixed(2))} ${y(value)}`
    )
    .join(" ");
  return { path, zeroY: y(0) };
};

const MONEY = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

export const formatMoney = (value: Num): string =>
  value === null ? "—" : MONEY.format(value);

export const formatSignedMoney = (value: Num): string =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${MONEY.format(value)}`;

export const formatPercent = (ratio: Num): string =>
  ratio === null ? "—" : `${Math.round(ratio * 100)}%`;

export const formatNumber = (value: Num): string =>
  value === null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });

export const pnlTextClass = (value: Num): string => {
  if (value === null || value === 0) return "";
  return value > 0 ? "text-success-foreground" : "text-destructive";
};

const IBKR_DATE_TIME = /^(\d{4})(\d{2})(\d{2})[ -](\d{2}:\d{2}:\d{2})(.*)$/u;

/** "20261009 09:30:00 US/Eastern" -> "2026-10-09 09:30:00 US/Eastern"; anything else unchanged. */
export const journalTime = (time: string): string => {
  const match = IBKR_DATE_TIME.exec(time.trim());
  if (match === null) return time;
  const [, year, month, day, clock, zone] = match;
  return `${year}-${month}-${day} ${clock}${zone}`;
};
