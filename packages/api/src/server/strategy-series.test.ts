import type {
  MarketDailyColumns,
  MarketDailySeriesRepository,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex } from "../canonical-json.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "../strategy-dsl.ts";
import { StrategySeriesDataError } from "../strategy-dsl-compile.ts";
import {
  loadStrategySeries,
  loadStrategySeriesRows,
  runInputsSha256,
  strategySeriesInput,
  strategySeriesRowsSha256,
  strategySeriesStoreIds,
} from "./strategy-series.ts";

const DATES = ["2024-01-02", "2024-01-03", "2024-01-04"];
const etf = (closes: number[]): MarketDailyColumns => ({
  adjClose: closes.map((value) => value + 0.5),
  close: closes,
  dates: DATES,
  high: closes,
  low: closes,
  open: closes,
});
const level = (closes: number[]): MarketDailyColumns => ({
  adjClose: [null, null, null],
  close: closes,
  dates: DATES,
  high: [null, null, null],
  low: [null, null, null],
  open: [null, null, null],
});
const ROWS: Record<string, MarketDailyColumns> = {
  ES: level([1, 2, 3]),
  QQQ: etf([10, 11, 12]),
  SPY: etf([20, 21, 22]),
  VIX: level([15, 16, 17]),
};
const store = (): MarketDailySeriesRepository => ({
  listSeries: vi.fn(),
  loadSeries: vi.fn(async (ids: readonly string[]) => {
    const found = ids.flatMap((id) => {
      const columns = ROWS[id];
      return columns === undefined ? [] : [[id, columns] as const];
    });
    return new Map(found);
  }),
  replaceSeries: vi.fn(),
});

const expr = (series: string) => ({
  left: { series, type: "series" },
  op: ">",
  right: { type: "const", value: 0 },
});
const definition = (extra: Record<string, unknown>) =>
  StrategyDefinitionSchema.parse({ ...STRATEGY_TEMPLATES.smaCross, ...extra });

describe("strategy series loader", () => {
  it("resolves the refs a definition reads to store ids, `<ETF>:TR` reading the ETF row", () => {
    const reads = definition({
      entry: { all: [expr("$tr"), expr("QQQ:TR"), expr("QQQ")] },
      filters: [{ max: 50, type: "ivRank" }],
    });
    expect(strategySeriesStoreIds(reads, "SPY")).toEqual(["VIX", "SPY", "QQQ"]);
    expect(strategySeriesStoreIds(definition({}), "SPY")).toEqual([]);
    expect(() => strategySeriesStoreIds(reads, "AAPL")).toThrow(
      new StrategySeriesDataError("$iv of AAPL")
    );
    const options = definition({
      options: {
        dte: { min: 20, target: 30 },
        maxLossPct: 2,
        structure: "putCreditVertical",
        widthSigma: 0.5,
      },
    });
    expect(strategySeriesStoreIds(options, "QQQ")).toEqual([
      "QQQ",
      "VXN",
      "IRX",
      "SPY",
    ]);
  });

  it("loads the rows up to `to` in id order and fails on a missing id or store", async () => {
    const repository = store();
    const rows = await loadStrategySeriesRows(
      repository,
      ["VIX", "SPY"],
      "2024-01-03"
    );
    expect([...rows.keys()]).toEqual(["VIX", "SPY"]);
    expect(repository.loadSeries).toHaveBeenCalledWith(["VIX", "SPY"], {
      to: "2024-01-03",
    });
    await loadStrategySeriesRows(repository, ["VIX"]);
    expect(repository.loadSeries).toHaveBeenLastCalledWith(["VIX"], {});
    await expect(
      loadStrategySeriesRows(repository, ["VIX", "VIX3M"])
    ).rejects.toThrow(new StrategySeriesDataError("VIX3M"));
    await expect(
      loadStrategySeriesRows(undefined, ["VIX", "VIX3M"])
    ).rejects.toThrow(new StrategySeriesDataError("VIX, VIX3M"));
  });

  it("loads a definition's series with a stable hash, or nothing when it reads none", async () => {
    const repository = store();
    expect(
      await loadStrategySeries(undefined, definition({}), "SPY")
    ).toBeNull();
    const reads = definition({ filters: [{ max: 50, type: "ivRank" }] });
    const loaded = await loadStrategySeries(
      repository,
      reads,
      "SPY",
      "2024-01-04"
    );
    expect(loaded?.ids).toEqual(["VIX"]);
    const sha = await sha256Hex(canonicalJson({ VIX: ROWS["VIX"] }));
    expect(loaded?.sha256).toBe(sha);
    expect(
      await strategySeriesRowsSha256(
        new Map([["VIX", ROWS["VIX"] as MarketDailyColumns]])
      )
    ).toBe(sha);
    expect(await runInputsSha256("a".repeat(64), null)).toBe("a".repeat(64));
    expect(await runInputsSha256("a".repeat(64), sha)).toBe(
      await sha256Hex(canonicalJson({ bars: "a".repeat(64), series: sha }))
    );
  });

  it("builds the series input of the resolved refs: closes, and adjusted closes for `:TR`", () => {
    const reads = definition({
      entry: { all: [expr("$tr"), expr("ES=F")] },
      filters: [{ max: 50, type: "ivRank" }],
    });
    const rows = new Map(Object.entries(ROWS));
    rows.set("ES=F", ROWS["ES"] as MarketDailyColumns);
    expect(strategySeriesInput(reads, "SPY", rows)).toEqual({
      context: {
        "ES=F": { "2024-01-02": 1, "2024-01-03": 2, "2024-01-04": 3 },
        "SPY:TR": {
          "2024-01-02": 20.5,
          "2024-01-03": 21.5,
          "2024-01-04": 22.5,
        },
        VIX: { "2024-01-02": 15, "2024-01-03": 16, "2024-01-04": 17 },
      },
      symbol: "SPY",
    });
    rows.delete("VIX");
    expect(() => strategySeriesInput(reads, "SPY", rows)).toThrow(
      new StrategySeriesDataError("VIX")
    );
  });
});
