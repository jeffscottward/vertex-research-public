import { describe, expect, it } from "vitest";

import {
  SETUP_REPLAY_MAX_OCCURRENCES,
  SETUP_REPLAY_SETUP_IDS,
  SetupReplayRunOutputSchema,
} from "./contracts/setup-replay.ts";
import {
  type BarColumns,
  InstantBacktestInputError,
} from "./instant-backtest-engine.ts";
import {
  runSetupReplay,
  SETUP_REPLAY_PRESETS,
  type SetupReplayParams,
  setupReplayDefinition,
  setupReplayPresetList,
} from "./setup-replay.ts";
import { compileStrategy } from "./strategy-dsl-compile.ts";

const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2020, 0, 1);

type Row = readonly [o: number, h: number, l: number, c: number];

const columns = (rows: readonly Row[]): BarColumns => ({
  c: Float64Array.from(rows, (row) => row[3]),
  h: Float64Array.from(rows, (row) => row[1]),
  l: Float64Array.from(rows, (row) => row[2]),
  o: Float64Array.from(rows, (row) => row[0]),
  t: Float64Array.from(rows, (_, index) => START_MS + index * DAY_MS),
});

const params = (
  overrides: Partial<SetupReplayParams> = {}
): SetupReplayParams => ({
  maxHoldBars: 5,
  paths: 1000,
  setup: "gapUpHold",
  stop: { kind: "atr", multiple: 1 },
  targetR: 1,
  ...overrides,
});

// 20 quiet bars, then one gap-up-and-hold signal bar (index 20); `after` follows from index 21.
const FLAT: Row = [100, 101, 99, 100];
const SIGNAL: Row = [102, 103, 101.5, 102.5];
const withSignal = (after: readonly Row[]): BarColumns =>
  columns([...Array.from({ length: 20 }, () => FLAT), SIGNAL, ...after]);

const riskAt20 = (bars: BarColumns): number =>
  compileStrategy(bars, setupReplayDefinition(params())).stopDistance?.[20] ??
  Number.NaN;

// Deterministic daily wave: trend, two cycles and a gap up every third bar.
const waveBars = (size: number): BarColumns => {
  const rows: Row[] = [];
  let previous = 100;
  for (let index = 0; index < size; index += 1) {
    const close =
      100 + index * 0.12 + 8 * Math.sin(index / 9) + 3 * Math.sin(index / 2.3);
    const open = index % 3 === 0 ? previous + 1 : previous;
    rows.push([
      open,
      Math.max(open, close) + 0.3,
      Math.min(open, close) - 0.3,
      close,
    ]);
    previous = close;
  }
  return columns(rows);
};

describe("setup replay presets", () => {
  it("lists every preset id once with a label and description", () => {
    const list = setupReplayPresetList();
    expect(list.map((preset) => preset.id)).toEqual([
      ...SETUP_REPLAY_SETUP_IDS,
    ]);
    for (const preset of list) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("builds a valid long-only DSL strategy with ATR stop and R target", () => {
    for (const setup of SETUP_REPLAY_SETUP_IDS) {
      const definition = setupReplayDefinition({
        setup,
        stop: { kind: "atr", multiple: 1.5 },
        targetR: 2,
      });
      expect(definition.entry.all).toHaveLength(
        SETUP_REPLAY_PRESETS[setup].entry.length
      );
      expect(definition.exit.any).toEqual([]);
      expect(definition.stopLoss).toEqual({
        kind: "atr",
        length: 14,
        multiple: 1.5,
      });
      expect(definition.takeProfit).toEqual({
        kind: "atr",
        length: 14,
        multiple: 3,
      });
    }
  });

  it("finds occurrences of every preset on the synthetic wave", () => {
    const bars = waveBars(600);
    for (const setup of SETUP_REPLAY_SETUP_IDS) {
      const result = runSetupReplay(bars, params({ setup }), "wave");
      expect(result.summary.count, setup).toBeGreaterThan(0);
      expect(
        SetupReplayRunOutputSchema.safeParse({
          ...result,
          series: {
            bars: 600,
            from: "2020-01-01",
            id: "WAVE:1d",
            symbol: "WAVE",
            to: "2021-08-22",
          },
        }).success
      ).toBe(true);
    }
  });
});

describe("setup replay outcomes", () => {
  it("classifies a target-first trade at +targetR", () => {
    const bars = withSignal([
      [103, 110, 102.5, 109],
      [109, 109.5, 108.5, 109],
    ]);
    const risk = riskAt20(bars);
    const result = runSetupReplay(bars, params({ targetR: 1.5 }), "k");
    expect(result.occurrences).toEqual([
      {
        barsHeld: 1,
        entryDate: "2020-01-22",
        entryPrice: 103,
        exitDate: "2020-01-22",
        exitPrice: 103 + 1.5 * risk,
        outcome: "target",
        returnPct: expect.closeTo(((1.5 * risk) / 103) * 100, 10),
        rMultiple: expect.closeTo(1.5, 12),
      },
    ]);
    expect(result.summary).toEqual({
      avgR: expect.closeTo(1.5, 12),
      breakEvenShare: 0.4,
      count: 1,
      expectancyR: 1.5,
      stopFirst: 0,
      targetFirst: 1,
      targetShare: 1,
      timeExit: 0,
      winRate: 1,
    });
  });

  it("classifies a stop, including a gap through it below -1R", () => {
    const touched = withSignal([
      [103, 103.5, 100, 100.5],
      [100.5, 101, 100, 100.5],
    ]);
    const stop = runSetupReplay(touched, params(), "k");
    expect(stop.occurrences[0]?.outcome).toBe("stop");
    expect(stop.occurrences[0]?.rMultiple).toBeCloseTo(-1, 12);

    const gapped = withSignal([
      [103, 103.5, 102.5, 103],
      [99, 99.5, 98, 99],
    ]);
    const gap = runSetupReplay(gapped, params(), "k");
    const risk = riskAt20(gapped);
    expect(gap.occurrences[0]).toMatchObject({
      barsHeld: 2,
      exitPrice: 99,
      outcome: "stop",
      rMultiple: (99 - 103) / risk,
    });
    expect(gap.summary.avgR).toBeLessThan(-1);
    expect(gap.summary.expectancyR).toBe(-1);
    expect(gap.summary.winRate).toBe(0);
  });

  it("exits at the next open after maxHoldBars as a time exit", () => {
    const quiet: Row = [103, 103.4, 102.6, 103];
    const bars = withSignal([
      ...Array.from({ length: 5 }, () => quiet),
      [103.2, 103.4, 102.6, 103],
      quiet,
    ]);
    const result = runSetupReplay(bars, params({ maxHoldBars: 5 }), "k");
    // A time exit shows exactly the chosen hold.
    expect(result.occurrences[0]?.barsHeld).toBe(5);
    expect(result.occurrences).toEqual([
      expect.objectContaining({
        barsHeld: 5,
        entryDate: "2020-01-22",
        exitDate: "2020-01-27",
        exitPrice: 103.2,
        outcome: "time",
      }),
    ]);
    expect(result.summary).toMatchObject({
      count: 1,
      targetShare: null,
      timeExit: 1,
      winRate: 1,
    });
    expect(result.summary.expectancyR).toBeCloseTo(0.2 / riskAt20(bars), 12);
  });

  it("leaves out a trade still open when the data ends", () => {
    const bars = withSignal([
      [103, 103.4, 102.6, 103],
      [103, 103.4, 102.6, 102.8],
    ]);
    const result = runSetupReplay(bars, params({ maxHoldBars: 20 }), "k");
    expect(result.occurrences).toEqual([]);
    expect(result.summary.count).toBe(0);
    expect(result.monteCarlo).toBeNull();
    // The same bars with a closed trade first: only the closed one counts.
    const closed = withSignal([
      [103, 110, 102.5, 109],
      [109, 109.5, 108.5, 109],
      [109, 109.5, 108.5, 109],
      [110, 111, 109.8, 110.5],
      [110.5, 111, 110, 110.6],
    ]);
    const mixed = runSetupReplay(closed, params({ maxHoldBars: 20 }), "k");
    expect(mixed.occurrences.map((entry) => entry.outcome)).toEqual(["target"]);
    expect(mixed.summary.count).toBe(1);
    expect(mixed.monteCarlo?.tradesPerPath).toBe(1);
  });

  it("returns empty statistics and no Monte Carlo when the setup never occurs", () => {
    const bars = columns(Array.from({ length: 30 }, () => FLAT));
    expect(runSetupReplay(bars, params(), "k")).toEqual({
      monteCarlo: null,
      occurrences: [],
      summary: {
        avgR: null,
        breakEvenShare: 0.5,
        count: 0,
        expectancyR: null,
        stopFirst: 0,
        targetFirst: 0,
        targetShare: null,
        timeExit: 0,
        winRate: null,
      },
    });
  });

  it("rejects a series shorter than the setup's indicators", () => {
    expect(() =>
      runSetupReplay(waveBars(150), params({ setup: "rsi2Oversold" }), "k")
    ).toThrow(InstantBacktestInputError);
  });

  it("lists the newest occurrences first and caps the list", () => {
    // A staircase that gaps up every bar: one target-first trade every two bars.
    const rows: Row[] = Array.from({ length: 4400 }, (_, index) => {
      const open = 10 + index * 3;
      return [open, open + 1.5, open - 0.5, open + 1];
    });
    const result = runSetupReplay(columns(rows), params(), "stairs");
    expect(result.summary.count).toBeGreaterThan(SETUP_REPLAY_MAX_OCCURRENCES);
    expect(result.occurrences).toHaveLength(SETUP_REPLAY_MAX_OCCURRENCES);
    const [newest, next] = result.occurrences;
    expect((newest?.entryDate ?? "") > (next?.entryDate ?? "")).toBe(true);
    expect(result.monteCarlo?.tradesPerPath).toBe(result.summary.count);
  });
});

describe("setup replay Monte Carlo", () => {
  const bars = waveBars(600);

  it("is deterministic for the same data and parameters", () => {
    const first = runSetupReplay(bars, params({ paths: 1000 }), "WAVE:1d|v1");
    const again = runSetupReplay(bars, params({ paths: 1000 }), "WAVE:1d|v1");
    expect(again.monteCarlo).toEqual(first.monteCarlo);
    const other = runSetupReplay(bars, params({ paths: 1000 }), "WAVE:1d|v2");
    expect(other.monteCarlo?.seed).not.toBe(first.monteCarlo?.seed);
  });

  it("reports ordered percentiles and a probability for the chosen path count", () => {
    const result = runSetupReplay(bars, params({ paths: 5000 }), "WAVE:1d");
    const run = result.monteCarlo;
    expect(run?.paths).toBe(5000);
    expect(run?.tradesPerPath).toBe(result.summary.count);
    expect(run?.pProfit).toBeGreaterThanOrEqual(0);
    expect(run?.pProfit).toBeLessThanOrEqual(1);
    for (const spread of [run?.totalR, run?.totalReturnPct]) {
      expect(spread?.p5).toBeLessThanOrEqual(spread?.p25 ?? Number.NaN);
      expect(spread?.p25).toBeLessThanOrEqual(spread?.p50 ?? Number.NaN);
      expect(spread?.p50).toBeLessThanOrEqual(spread?.p75 ?? Number.NaN);
      expect(spread?.p75).toBeLessThanOrEqual(spread?.p95 ?? Number.NaN);
    }
  });

  it("compounds identical outcomes exactly", () => {
    const quiet: Row = [103, 103.4, 102.6, 103];
    const winner = withSignal([[103, 110, 102.5, 109], quiet]);
    const run = runSetupReplay(winner, params(), "k").monteCarlo;
    const risk = riskAt20(winner);
    expect(run?.totalR.p50).toBeCloseTo(1, 12);
    expect(run?.totalReturnPct.p50).toBeCloseTo((risk / 103) * 100, 10);
    expect(run?.pProfit).toBe(1);
  });
});
