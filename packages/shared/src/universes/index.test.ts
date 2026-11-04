import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BACKTEST_UNIVERSES,
  BAR_SYMBOL_PATTERN,
  backtestUniverse,
  CORE7_MARKETS,
  DEFAULT_BACKTEST_UNIVERSE_ID,
  etfTwinOfFuture,
  isFuturesSymbol,
  isBacktestUniverseId,
  universeSeries,
} from "./index.ts";

describe("backtest universes", () => {
  it("defaults to the Core 7 futures", () => {
    expect(DEFAULT_BACKTEST_UNIVERSE_ID).toBe("core7-futures");
    expect(backtestUniverse(DEFAULT_BACKTEST_UNIVERSE_ID).label).toBe(
      "Core 7 futures"
    );
  });

  it("lists the seven futures and their ETF twins in the same market order", () => {
    expect(
      backtestUniverse("core7-futures").members.map((m) => m.symbol)
    ).toEqual(["ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F"]);
    expect(
      backtestUniverse("core7-etf-twins").members.map((m) => m.symbol)
    ).toEqual(["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"]);
    expect(backtestUniverse("core7-futures").members[0]).toEqual({
      market: "S&P 500",
      symbol: "ES=F",
      twin: "SPY",
    });
    expect(backtestUniverse("core7-etf-twins").members[6]).toEqual({
      market: "WTI crude oil",
      symbol: "USO",
      twin: "CL=F",
    });
    expect(BACKTEST_UNIVERSES.map((u) => u.id)).toEqual([
      "core7-futures",
      "core7-etf-twins",
    ]);
  });

  it("accepts every member symbol in the stored bar symbol pattern", () => {
    for (const entry of CORE7_MARKETS) {
      expect(BAR_SYMBOL_PATTERN.test(entry.future)).toBe(true);
      expect(BAR_SYMBOL_PATTERN.test(entry.etf)).toBe(true);
    }
    expect(BAR_SYMBOL_PATTERN.test("^VIX")).toBe(true);
    expect(BAR_SYMBOL_PATTERN.test("es=f")).toBe(false);
    expect(BAR_SYMBOL_PATTERN.test("ES; DROP")).toBe(false);
    expect(BAR_SYMBOL_PATTERN.test("")).toBe(false);
  });

  it("recognizes universe ids", () => {
    expect(isBacktestUniverseId("core7-etf-twins")).toBe(true);
    expect(isBacktestUniverseId("all")).toBe(false);
    expect(isBacktestUniverseId(7)).toBe(false);
  });

  it("selects stored series of a universe in member order", () => {
    const series = [
      { symbol: "BTC", timeframe: "1d" },
      { symbol: "CL=F", timeframe: "1d" },
      { symbol: "ES=F", timeframe: "1d" },
      { symbol: "ES=F", timeframe: "1m" },
      { symbol: "SPY", timeframe: "1d" },
    ];
    expect(universeSeries(series, "core7-futures")).toEqual([
      { symbol: "ES=F", timeframe: "1d" },
      { symbol: "ES=F", timeframe: "1m" },
      { symbol: "CL=F", timeframe: "1d" },
    ]);
    expect(universeSeries(series, "core7-etf-twins")).toEqual([
      { symbol: "SPY", timeframe: "1d" },
    ]);
    expect(universeSeries([], "core7-futures")).toEqual([]);
  });

  it("maps a Core 7 future to its ETF twin", () => {
    expect(etfTwinOfFuture("CL=F")).toBe("USO");
    expect(etfTwinOfFuture("SPY")).toBeNull();
  });

  it("recognizes Yahoo continuous futures symbols", () => {
    expect(isFuturesSymbol("ZB=F")).toBe(true);
    expect(isFuturesSymbol("SPY")).toBe(false);
    expect(isFuturesSymbol("EURUSD=X")).toBe(false);
  });

  it("imports nothing, so broker-isolation guards may allow it as a leaf", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*(?:import|export)[^;]*\bfrom\s/mu);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
  });
});
