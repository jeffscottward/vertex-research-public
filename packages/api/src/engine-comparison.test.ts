import { describe, expect, it, vi } from "vitest";

import {
  ENGINE_COMPARISON_TRADES_MAX,
  TIMER_FROZEN_NOTE,
} from "./contracts/engine-comparison.ts";
import { comparisonQueueFor } from "./server/engine-comparison.ts";
import type { ApiContext } from "./server/context.ts";
import {
  barDate,
  compactTrades,
  createComparisonQueue,
  compareEngineResults,
  measureWall,
  typescriptSide,
} from "./engine-comparison.ts";
import type { InstantStats, InstantTrade } from "./instant-backtest-engine.ts";

const stats: InstantStats = {
  bars: 100,
  buyHoldMaxDrawdown: -0.2,
  buyHoldReturn: 0.3,
  cagr: 0.1,
  exposure: 0.4,
  maxDrawdown: -0.1,
  profitFactor: 1.5,
  sharpe: 1.2,
  sortino: 1.8,
  totalReturn: 0.25,
  trades: 2,
  winRate: 0.5,
};

const trade = (
  entryIndex: number,
  exitIndex: number,
  exitReason: InstantTrade["exitReason"]
): InstantTrade => ({
  entryIndex,
  entryPrice: 100,
  exitIndex,
  exitPrice: 101,
  exitReason,
  netReturn: 0.01,
  pnl: 0.01,
  units: 0.01,
});

const trades = [trade(3, 9, "signal"), trade(12, 20, "stop")];

describe("measureWall", () => {
  it("returns the elapsed time, or null with a note when the clock did not move", () => {
    const ticks = [10, 14.5];
    expect(
      measureWall(
        () => ticks.shift() as number,
        () => "x"
      )
    ).toEqual({
      value: "x",
      wallMs: 4.5,
    });
    expect(
      measureWall(
        () => 7,
        () => 1
      )
    ).toEqual({
      value: 1,
      wallMs: null,
      wallNote: TIMER_FROZEN_NOTE,
    });
    const backwards = [5, 4];
    expect(
      measureWall(
        () => backwards.shift() as number,
        () => 0
      ).wallMs
    ).toBeNull();
  });
});

describe("typescriptSide", () => {
  it("keeps the stats, the trade count and at most the cap of compact trades", () => {
    const many = Array.from({ length: ENGINE_COMPARISON_TRADES_MAX + 2 }, () =>
      trade(1, 2, "target")
    );
    const side = typescriptSide(
      { stats, trades: many },
      { wallMs: 3 },
      "web server"
    );
    expect(side).toMatchObject({
      host: "web server",
      stats,
      tradeCount: ENGINE_COMPARISON_TRADES_MAX + 2,
      wallMs: 3,
    });
    expect(side.trades).toHaveLength(ENGINE_COMPARISON_TRADES_MAX);
    expect(side).not.toHaveProperty("wallNote");
    expect(
      typescriptSide(
        { stats, trades },
        { wallMs: null, wallNote: TIMER_FROZEN_NOTE },
        "h"
      )
    ).toMatchObject({ wallMs: null, wallNote: TIMER_FROZEN_NOTE });
    expect(compactTrades(trades)).toEqual([
      [3, 9, "signal"],
      [12, 20, "stop"],
    ]);
  });
});

describe("compareEngineResults", () => {
  const side = typescriptSide({ stats, trades }, { wallMs: 1 }, "h");

  it("matches within the parity tolerances", () => {
    expect(
      compareEngineResults(side, {
        stats: {
          ...stats,
          maxDrawdown: stats.maxDrawdown + 5e-6,
          sharpe: 1.2005,
          totalReturn: 0.250_009,
        },
        trades,
      })
    ).toEqual({ items: [], ok: true });
  });

  it("lists the trade count, the first different trade and stats beyond the tolerance", () => {
    const result = compareEngineResults(side, {
      stats: {
        ...stats,
        maxDrawdown: -0.2,
        sharpe: 1.3,
        totalReturn: 0.26,
      },
      trades: [
        trade(3, 9, "signal"),
        trade(12, 21, "stop"),
        trade(30, 31, "end"),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.items.map((item) => item.field)).toEqual([
      "tradeCount",
      "trades",
      "totalReturn",
      "sharpe",
      "maxDrawdown",
    ]);
    expect(result.items[0]).toMatchObject({ nautilus: 3, typescript: 2 });
    expect(result.items[1]).toMatchObject({
      detail: "Trade 2 differs (entry bar, exit bar, exit reason)",
      nautilus: "12->21 stop",
      typescript: "12->20 stop",
    });
    expect(result.items[2]?.detail).toContain("above the tolerance 0.00001");
  });

  it("reports a stat that only one engine has", () => {
    const sharpeless = typescriptSide(
      { stats: { ...stats, sharpe: null }, trades },
      { wallMs: 1 },
      "h"
    );
    expect(compareEngineResults(sharpeless, { stats, trades }).items).toEqual([
      {
        detail: "sharpe is missing in TypeScript and present in Nautilus",
        field: "sharpe",
        nautilus: 1.2,
        typescript: null,
      },
    ]);
    expect(
      compareEngineResults(side, { stats: { ...stats, sharpe: null }, trades })
        .items[0]?.detail
    ).toBe("sharpe is present in TypeScript and missing in Nautilus");
    expect(
      compareEngineResults(sharpeless, {
        stats: { ...stats, sharpe: null },
        trades,
      }).ok
    ).toBe(true);
    // Different exit reasons and entry bars count as different trades too.
    expect(
      compareEngineResults(side, {
        stats,
        trades: [trade(3, 9, "target"), trades[1] as InstantTrade],
      }).items[0]?.field
    ).toBe("trades");
    expect(
      compareEngineResults(side, {
        stats,
        trades: [trade(4, 9, "signal"), trades[1] as InstantTrade],
      }).items[0]?.nautilus
    ).toBe("4->9 signal");
  });
});

describe("comparison queue", () => {
  it("is off without the setting or storage, and labels the host", async () => {
    const createMany = vi.fn(async () => []);
    const context = (extra: Partial<ApiContext>) =>
      ({
        repositories: { backtestRuns: { createMany } },
        ...extra,
      }) as ApiContext;
    expect(comparisonQueueFor(context({}), "u")).toBeNull();
    expect(
      comparisonQueueFor(
        { engineComparison: "on", repositories: {} } as unknown as ApiContext,
        "u"
      )
    ).toBeNull();
    expect(
      comparisonQueueFor(context({ engineComparison: "on" }), "u")?.host
    ).toBe("web server");
    const queue = createComparisonQueue(
      { createMany },
      "rig web",
      "u",
      () => "g-9"
    );
    await expect(
      queue.enqueue({
        dropped: 0,
        feature: "instant",
        groupId: "fixed",
        runs: [],
      })
    ).resolves.toBe("fixed");
    await expect(queue.enqueue({ feature: "instant", runs: [] })).resolves.toBe(
      "g-9"
    );
    expect(barDate(Date.parse("2026-11-05T23:59:00Z"))).toBe("2026-11-05");
  });
});
