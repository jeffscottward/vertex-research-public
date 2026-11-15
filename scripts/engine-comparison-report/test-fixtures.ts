// Test rows for the engine comparison report tests (not used at runtime).
import type { ComparisonRow, NautilusRun } from "./model.ts";

export const comparisonRow = (
  overrides: Partial<ComparisonRow> = {},
  comparison: Partial<ComparisonRow["comparison"]> = {}
): ComparisonRow => ({
  comparison: {
    feature: "sweep",
    groupId: "group-1",
    label: "SPY SMA 10/40",
    typescript: {
      host: "QuantVPS web (in-request)",
      stats: {
        bars: 2516,
        buyHoldMaxDrawdown: -0.3,
        buyHoldReturn: 1.2,
        cagr: 0.05,
        exposure: 0.6,
        maxDrawdown: -0.2,
        profitFactor: 1.4,
        sharpe: 0.57,
        sortino: 0.8,
        totalReturn: 0.9,
        trades: 36,
        winRate: 0.5,
      },
      tradeCount: 36,
      trades: [],
      wallMs: 1.5,
    },
    ...comparison,
  },
  createdAt: "2026-11-06T03:27:53.699Z",
  differences: { items: [], ok: true },
  engineRun: {
    cpuMs: 2900,
    gpu: "not used (Nautilus engine is CPU-only)",
    host: "omarchy-rig",
    processCases: 1,
    processes: 1,
    processWallMs: 1600,
    wallMs: 270,
  },
  error: null,
  finishedAt: "2026-11-06T03:28:40.000Z",
  from: "2015-01-02",
  id: "run-1",
  queueWaitMs: 42_000,
  startedAt: "2026-11-06T03:28:35.699Z",
  status: "succeeded",
  symbol: "SPY",
  to: "2024-12-31",
  ...overrides,
});

export const nautilusRun = (
  overrides: Partial<NautilusRun> = {}
): NautilusRun => ({
  createdAt: "2026-11-09T13:17:06.000Z",
  engineRun: {
    cpuMs: 14_153,
    gpu: "not used (Nautilus engine is CPU-only)",
    host: "omarchy-rig",
    processCases: 1,
    processes: 1,
    processWallMs: 13_300,
    wallMs: 13_242,
  },
  error: null,
  finishedAt: "2026-11-09T13:17:26.000Z",
  from: "1993-10-29",
  id: "nautilus-1",
  label: "Asset-Class Trend <10-month SMA>",
  startedAt: "2026-11-09T13:17:09.000Z",
  status: "succeeded",
  symbol: "SPY",
  to: "2026-11-06",
  ...overrides,
});
