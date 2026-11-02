import { describe, expect, it } from "vitest";

import { runOptionsBacktest } from "./backtest.ts";

const DAY = 86_400_000;
const start = Date.UTC(2020, 0, 1);

const bars = (closes: number[]) => ({
  t: closes.map((_, index) => start + index * DAY),
  c: closes,
});

const trend = (days: number, daily: number, wiggle = 0.004) =>
  Array.from(
    { length: days },
    (_, index) =>
      100 * (1 + daily) ** index * (1 + wiggle * Math.sin(index / 3))
  );

describe("runOptionsBacktest", () => {
  it("runs a covered call and reports a modeled equity curve and trades", () => {
    const result = runOptionsBacktest({
      bars: bars(trend(400, 0.0005)),
      structure: "covered_call",
      rules: {},
      capital: 100_000,
    });
    expect(result.modeled).toBe(true);
    expect(result.equity.length).toBeGreaterThan(300);
    expect(result.equity.every((point) => Number.isFinite(point.equity))).toBe(
      true
    );
    expect(result.trades.length).toBeGreaterThan(5);
    expect(result.trades[0]?.legs.length).toBeGreaterThan(0);
    expect(result.stats.totalReturn).toBeGreaterThan(0);
  });

  it("earns premium on a put credit spread in a quiet market", () => {
    const result = runOptionsBacktest({
      bars: bars(trend(300, 0.0002, 0.002)),
      structure: "put_credit_spread",
      rules: {},
      capital: 100_000,
    });
    expect(result.stats.totalReturn).toBeGreaterThan(0);
    expect(result.stats.winRate).toBeGreaterThan(0.5);
  });

  it("loses on long calls when the market falls", () => {
    const result = runOptionsBacktest({
      bars: bars(trend(300, -0.002)),
      structure: "long_call",
      rules: {},
      capital: 100_000,
    });
    expect(result.stats.totalReturn).toBeLessThan(0);
  });

  it("charges costs: higher costs give a lower return", () => {
    const input = {
      bars: bars(trend(300, 0.0004)),
      structure: "iron_condor" as const,
      capital: 100_000,
    };
    const cheap = runOptionsBacktest({
      ...input,
      rules: { costPerContract: 0, slippagePct: 0 },
    });
    const dear = runOptionsBacktest({
      ...input,
      rules: { costPerContract: 5, slippagePct: 5 },
    });
    expect(dear.stats.totalReturn).toBeLessThan(cheap.stats.totalReturn);
  });

  it("uses a supplied implied-volatility series when given", () => {
    const closes = trend(200, 0.0003);
    const iv = closes.map(() => 0.5);
    const result = runOptionsBacktest({
      bars: { ...bars(closes), iv },
      structure: "cash_secured_put",
      rules: {},
      capital: 100_000,
    });
    expect(result.ivSource).toBe("supplied");
  });

  it("counts core-only trades and explains a budget too small for one unit", () => {
    const rolled = runOptionsBacktest({
      bars: bars(trend(500, 0.0005)),
      structure: "deep_itm_call",
      rules: { coreDte: 120, coreExitDte: 30 },
      capital: 100_000,
    });
    expect(rolled.stats.trades).toBeGreaterThan(2);
    const starved = runOptionsBacktest({
      bars: bars(trend(200, 0.0005)),
      structure: "deep_itm_call",
      rules: { riskPct: 0.5 },
      capital: 10_000,
    });
    expect(starved.trades).toHaveLength(0);
    expect(starved.assumptions.join(" ")).toMatch(/risk budget/u);
  });

  it("refuses unknown rules and short histories", () => {
    expect(() =>
      runOptionsBacktest({
        bars: bars(trend(300, 0)),
        structure: "long_call",
        rules: { nope: 1 },
        capital: 100_000,
      })
    ).toThrow(/not a rule/u);
    expect(() =>
      runOptionsBacktest({
        bars: bars(trend(20, 0)),
        structure: "long_call",
        rules: {},
        capital: 100_000,
      })
    ).toThrow(/at least/u);
  });

  it("settles a weekend expiry at the last trading bar on or before it, not the next Monday", () => {
    // Weekday-only bars from Tue 2024-01-02.
    const t: number[] = [];
    for (let day = Date.UTC(2024, 0, 2); t.length < 300; day += DAY) {
      const weekday = new Date(day).getUTCDay();
      if (weekday !== 0 && weekday !== 6) t.push(day);
    }
    const c = t.map((_, index) => 100 * (1 + 0.003 * Math.sin(index / 3)));
    const result = runOptionsBacktest({
      bars: { t, c },
      structure: "long_call",
      rules: {
        dte: 60,
        exitDte: 0,
        profitTakePct: 10_000,
        stopLossPct: 10_000,
      },
      capital: 100_000,
    });
    const expiries = result.trades.filter((trade) => trade.reason === "expiry");
    expect(expiries.length).toBeGreaterThan(0);
    for (const trade of expiries) {
      const held = (Date.parse(trade.exitT) - Date.parse(trade.entryT)) / DAY;
      expect(held).toBeLessThanOrEqual(60);
    }
  });
});

describe("runOptionsBacktest edge cases", () => {
  it("falls back to 20% vol when the trailing window has a non-positive close", () => {
    const closes = trend(120, 0.0005);
    closes[10] = 0;
    const result = runOptionsBacktest({
      bars: bars(closes),
      structure: "long_call",
      rules: {},
      capital: 100_000,
    });
    expect(result.ivSource).toBe("rv-model");
    expect(result.equity.every((point) => Number.isFinite(point.equity))).toBe(
      true
    );
  });

  it("sizes an unbounded-loss structure off 20% of notional", () => {
    const result = runOptionsBacktest({
      bars: bars(trend(200, 0.0002, 0.002)),
      structure: "short_strangle",
      rules: {},
      capital: 100_000,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]?.units).toBeGreaterThanOrEqual(1);
  });

  it("reports a flat zero drawdown when there is no capital", () => {
    const result = runOptionsBacktest({
      bars: bars(trend(80, 0.001)),
      structure: "long_call",
      rules: {},
      capital: 0,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.drawdown.every((point) => point.drawdown === 0)).toBe(true);
    expect(result.stats.finalEquity).toBe(0);
  });
});
