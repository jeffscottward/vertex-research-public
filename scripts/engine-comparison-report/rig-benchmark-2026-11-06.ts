// The hand benchmark on the rig of 2026-11-06T06:25Z (the first step-4 report page) and the
// worker outages read from the journal before it rotates. The report script does not measure
// these again; the page shows them with their date. Research only; no orders.
import type { EngineComparisonFeature } from "../../packages/api/src/contracts/engine-comparison.ts";

export type BenchmarkRow = Readonly<{
  feature: EngineComparisonFeature;
  label: string;
  method: string;
  nautilus: Readonly<{
    cpuMs: number;
    p50Ms: number;
    p95Ms: number;
    processes: number;
  }>;
  typescript: Readonly<{ cpuMs: number; p50Ms: number; p95Ms: number }>;
}>;

export type KnownOutage = Readonly<{
  from: string;
  reason: string;
  to: string;
}>;

export type Benchmark = Readonly<{
  conditions: string;
  differences: readonly string[];
  gpu: Readonly<{
    device: string;
    note: string;
    rows: readonly Readonly<{
      cells: number;
      cpuMs: number;
      gpuMemoryMb: number;
      gpuMs: number;
    }>[];
  }>;
  knownOutages: readonly KnownOutage[];
  measuredAt: string;
  roundTripMs: number;
  rows: readonly BenchmarkRow[];
  warmEngineMs: number;
}>;

export const RIG_BENCHMARK_2026_11_06: Benchmark = {
  conditions:
    "32 CPUs, load 11-25 from CI runners; 20 runs per feature; p95 = nearest rank",
  differences: [
    "Instant: same trades; |Δ total return| 1.5e-08, |Δ Sharpe| 1.6e-08.",
    "Sweep: 90 of 90 cells with the same trades; max |Δ total return| 8.6e-08, max |Δ Sharpe| 5.2e-08.",
    "Autopilot gate: 2 of 2 slices with the same trades; max |Δ Sharpe| 3.1e-07.",
  ],
  gpu: {
    device: "NVIDIA GeForce RTX 3080 Ti",
    note: "Nautilus is a CPU engine; no benchmark process opened the GPU. A vectorized SMA screen on the GPU is faster for large grids; a per-bar state machine (stops, exits) was slower on the GPU (318 ms vs 56 ms on CPU for 184 cells). Results of record come from Nautilus.",
    rows: [
      { cells: 184, cpuMs: 15.4, gpuMemoryMb: 57, gpuMs: 1.3 },
      { cells: 2230, cpuMs: 157.9, gpuMemoryMb: 677, gpuMs: 5.8 },
      { cells: 16_793, cpuMs: 7105.1, gpuMemoryMb: 5074, gpuMs: 46.3 },
    ],
  },
  knownOutages: [
    {
      from: "2026-11-07T21:08:54.000Z",
      reason:
        "worker could not resolve the API host name (getaddrinfo ENOTFOUND) until the service restart (worker journal, read 2026-11-10)",
      to: "2026-11-08T12:24:54.000Z",
    },
  ],
  measuredAt: "2026-11-06T06:25:00.000Z",
  roundTripMs: 73,
  rows: [
    {
      feature: "instant",
      label: "Instant backtest (SPY 2015-2024, SMA 20/50, 5% stop, 10% target)",
      method: "2,516 daily bars, 1 case in 1 cold process",
      nautilus: { cpuMs: 3250, p50Ms: 2550, p95Ms: 4070, processes: 1 },
      typescript: { cpuMs: 0.5, p50Ms: 0.3, p95Ms: 0.4 },
    },
    {
      feature: "sweep",
      label: "Parameter sweep (90 SMA cells, SPY 2015-2024)",
      method: "2,516 bars, 90 cases over 8 cold processes",
      nautilus: { cpuMs: 45_150, p50Ms: 6560, p95Ms: 7680, processes: 8 },
      typescript: { cpuMs: 12.9, p50Ms: 10.5, p95Ms: 17.6 },
    },
    {
      feature: "autopilotGate",
      label:
        "Autopilot gate (ATR template, in-sample 60% + out-of-sample slices)",
      method:
        "2 slices (1,509 + 1,007 bars), 1 case each in 2 cold processes, no stops",
      nautilus: { cpuMs: 4350, p50Ms: 1090, p95Ms: 1530, processes: 2 },
      typescript: { cpuMs: 0.7, p50Ms: 0.5, p95Ms: 0.7 },
    },
  ],
  warmEngineMs: 203.6,
};
