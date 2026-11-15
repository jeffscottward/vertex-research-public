import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blackScholes } from "../../packages/api/src/options-chain-greeks.ts";
import {
  alignForward,
  buildMarket,
  CONFIGS,
  type Config,
  type Cycle,
  calendarGreeks,
  intrinsic,
  legCost,
  legValue,
  type Market,
  MIN_CYCLES,
  parseCloses,
  passRule,
  payoffAtNearExpiry,
  RV_WINDOW,
  realizedVol,
  renderResults,
  runCalendarSpreadCli,
  runStudy,
  simulate,
  stats,
  strategyVerdict,
  strikeForCallDelta,
  termStructureIv,
  UNDERLYINGS,
  valueAtNearExpiry,
} from "./calendar-spread.ts";

const ATM = {
  right: "call" as const,
  spot: 100,
  strike: 100,
  nearYears: 30 / 365,
  farYears: 60 / 365,
  nearIv: 0.3,
  farIv: 0.3,
  rate: 0.04,
  dividendYield: 0,
};

const isoDay = (offset: number): string =>
  new Date(Date.UTC(2020, 0, 1) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** A daily market (every calendar day is a trading day) for simulate tests. */
const market = (
  spot: readonly number[],
  iv: (index: number, days: number) => number = () => 0.3,
  costScale = 1
): Market => ({
  symbol: "TEST",
  dates: spot.map((_, index) => isoDay(index)),
  spot,
  costScale: spot.map(() => costScale),
  rate: spot.map(() => 0.04),
  dividendYield: 0,
  slippage: 0.01,
  ivSource: "flat",
  iv,
});

const CONFIG_30: Config = {
  id: "A",
  label: "30/60",
  nearDays: 30,
  delta: null,
};

const cycle = (ret: number, callRet: number): Cycle => ({
  entryDate: "2020-01-01",
  exitDate: "2020-01-31",
  reason: "expiry",
  strike: 100,
  debit: 1,
  ret,
  callRet,
  daysHeld: 30,
});

describe("option values and Greeks", () => {
  it("uses intrinsic value for calls and puts", () => {
    expect(intrinsic("call", 110, 100)).toBe(10);
    expect(intrinsic("call", 90, 100)).toBe(0);
    expect(intrinsic("put", 90, 100)).toBe(10);
    expect(intrinsic("put", 110, 100)).toBe(0);
  });

  it("prices with Black-Scholes before expiry, intrinsic at expiry and never below intrinsic", () => {
    const leg = { ...ATM, years: 0.5, volatility: 0.3 };
    const model = blackScholes(leg)?.price ?? Number.NaN;
    expect(legValue(leg)).toBeCloseTo(model, 10);
    expect(legValue({ ...leg, spot: 120, years: 0 })).toBe(20);
    // A deep in-the-money call with a high dividend yield is worth less than intrinsic as a European option.
    const deep = { ...leg, spot: 200, years: 2, dividendYield: 0.2 };
    expect(blackScholes(deep)?.price).toBeLessThan(100);
    expect(legValue(deep)).toBe(100);
    expect(() => legValue({ ...leg, spot: 0 })).toThrow("outside the model");
  });

  it("nets calendar Greeks as far leg minus near leg", () => {
    const far = blackScholes({ ...ATM, years: ATM.farYears, volatility: 0.3 });
    const near = blackScholes({
      ...ATM,
      years: ATM.nearYears,
      volatility: 0.3,
    });
    const greeks = calendarGreeks(ATM);
    expect(greeks.price).toBeCloseTo(
      (far?.price ?? 0) - (near?.price ?? 0),
      10
    );
    expect(greeks.delta).toBeCloseTo(
      (far?.delta ?? 0) - (near?.delta ?? 0),
      10
    );
    expect(greeks.gamma).toBeLessThan(0);
    expect(greeks.theta).toBeGreaterThan(0);
    expect(greeks.vega).toBeGreaterThan(0);
  });

  it("peaks at the strike at the near expiry with two break-evens", () => {
    const debit = calendarGreeks(ATM).price;
    const payoff = payoffAtNearExpiry(ATM, debit);
    expect(payoff.peakSpot).toBeCloseTo(100, 0);
    expect(payoff.maxValue).toBeCloseTo(
      valueAtNearExpiry(ATM, payoff.peakSpot),
      10
    );
    expect(payoff.maxProfit).toBeCloseTo(payoff.maxValue - debit, 10);
    expect(payoff.breakevens).toHaveLength(2);
    const [low = 0, high = 0] = payoff.breakevens;
    expect(low).toBeLessThan(100);
    expect(high).toBeGreaterThan(100);
    expect(valueAtNearExpiry(ATM, low) - debit).toBeCloseTo(0, 2);
    expect(
      payoffAtNearExpiry(ATM, debit, 10).breakevens.length
    ).toBeGreaterThan(0);
  });

  it("finds the strike for a call delta", () => {
    const input = {
      spot: 100,
      years: 0.25,
      volatility: 0.3,
      rate: 0.04,
      dividendYield: 0,
    };
    const strike = strikeForCallDelta(input, 0.3);
    expect(strike).toBeGreaterThan(100);
    expect(
      blackScholes({ ...input, right: "call", strike })?.delta
    ).toBeCloseTo(0.3, 6);
  });
});

describe("costs and volatility inputs", () => {
  it("charges commission plus the larger of the minimum and percent slippage", () => {
    expect(legCost(0.1, 0.01)).toBeCloseTo(0.0165, 10);
    expect(legCost(10, 0.03)).toBeCloseTo(0.3065, 10);
    // Before a 2-for-1 split the fixed parts are half as large in split-adjusted dollars.
    expect(legCost(0.1, 0.01, 0.5)).toBeCloseTo(0.008_25, 10);
  });

  it("interpolates the 30/93-day term structure in total variance and is flat outside", () => {
    expect(termStructureIv(0.2, 0.25, 10)).toBe(0.2);
    expect(termStructureIv(0.2, 0.25, 200)).toBe(0.25);
    const variance = 0.04 * 30 + ((0.0625 * 93 - 0.04 * 30) * 30) / 63;
    expect(termStructureIv(0.2, 0.25, 60)).toBeCloseTo(
      Math.sqrt(variance / 60),
      12
    );
  });

  it("annualizes realized volatility of log returns", () => {
    const closes = [100, 110, 100, 110, 100];
    const up = Math.log(1.1);
    const sample = [up, -up, up, -up];
    const mean = 0;
    const variance =
      sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 3;
    expect(realizedVol(closes, 4, 4)).toBeCloseTo(
      Math.sqrt(variance * 252),
      12
    );
  });
});

describe("simulate", () => {
  it("takes profit early when the price stays at the strike", () => {
    const result = simulate(
      market(Array.from({ length: 40 }, () => 100)),
      CONFIG_30,
      0
    );
    const [first] = result.cycles;
    expect(first?.reason).toBe("target");
    expect(first?.ret).toBeGreaterThan(0.3);
    expect(first?.strike).toBe(100);
    expect(result.skippedDays).toBe(0);
  });

  it("holds to the near expiry and loses when the price runs away, never more than debit plus costs", () => {
    const spot = Array.from({ length: 40 }, (_, index) =>
      index === 0 ? 100 : 160
    );
    const [first] = simulate(market(spot), CONFIG_30, 0).cycles;
    expect(first?.reason).toBe("expiry");
    expect(first?.exitDate).toBe(isoDay(30));
    expect(first?.ret).toBeLessThan(-0.5);
    // Both legs are floored at intrinsic, so only exit costs can push the loss past the debit.
    const debit = first?.debit ?? 0;
    const exitCosts = legCost(60, 0.01) + legCost(65, 0.01);
    expect(first?.ret).toBeGreaterThanOrEqual(-1 - exitCosts / debit);
    expect(first?.callRet).toBeGreaterThan(first?.ret ?? 0);
  });

  it("applies fixed costs at the traded price level through costScale", () => {
    const spot = Array.from({ length: 40 }, () => 100);
    const traded =
      simulate(market(spot, undefined, 1), CONFIG_30, 0).cycles[0]?.ret ?? 0;
    const presplit =
      simulate(market(spot, undefined, 0.01), CONFIG_30, 0).cycles[0]?.ret ?? 0;
    expect(presplit).toBeGreaterThan(traded);
  });

  it("skips days that fail the term-structure check or have no debit", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const steep = simulate(
      market(flat, (_, days) => (days > 30 ? 0.5 : 0.3)),
      CONFIG_30,
      0
    );
    expect(steep.cycles).toHaveLength(0);
    expect(steep.skippedDays).toBe(10);
    const inverted = simulate(
      market(flat, (_, days) => (days > 30 ? 0.01 : 1)),
      CONFIG_30,
      0
    );
    expect(inverted.cycles).toHaveLength(0);
    expect(inverted.skippedDays).toBe(10);
  });

  it("uses the delta strike when the config asks for one", () => {
    const config: Config = { ...CONFIG_30, id: "C", delta: 0.3 };
    const [first] = simulate(
      market(Array.from({ length: 40 }, () => 100)),
      config,
      0
    ).cycles;
    expect(first?.strike).toBeGreaterThan(100);
  });
});

describe("statistics and the pass rule", () => {
  it("summarizes returns", () => {
    expect(stats([])).toMatchObject({ n: 0, mean: 0, t: 0 });
    expect(stats([0.5])).toMatchObject({
      n: 1,
      mean: 0.5,
      sd: 0,
      t: 0,
      sharpe: 0,
      winRate: 1,
    });
    const summary = stats([0.1, -0.1, 0.3]);
    expect(summary.mean).toBeCloseTo(0.1, 12);
    expect(summary.sd).toBeCloseTo(0.2, 12);
    expect(summary.t).toBeCloseTo(0.1 / (0.2 / Math.sqrt(3)), 12);
    expect(summary.sharpe).toBeCloseTo(0.5, 12);
    expect(summary.winRate).toBeCloseTo(2 / 3, 12);
    expect(summary).toMatchObject({ worst: -0.1, best: 0.3 });
  });

  it("passes only with enough cycles, significance, both halves and a better Sharpe than the call", () => {
    const good = Array.from({ length: MIN_CYCLES }, (_, index) =>
      cycle(index % 2 === 0 ? 0.3 : 0.1, index % 2 === 0 ? 1 : -0.8)
    );
    expect(passRule(good).pass).toBe(true);
    expect(passRule(good.slice(0, MIN_CYCLES - 2)).enoughCycles).toBe(false);
    const flatCall = good.map((item) => ({ ...item, callRet: item.ret }));
    expect(passRule(flatCall).beatsCall).toBe(false);
    const badHalf = good.map((item, index) =>
      index < 15 ? { ...item, ret: -0.05 } : item
    );
    expect(passRule(badHalf).bothHalves).toBe(false);
    expect(passRule(badHalf).pass).toBe(false);
  });

  it("needs one config passing on 3 of 4 underlyings including SPY or QQQ", () => {
    expect(strategyVerdict(new Map([["A", ["SPY", "QQQ"]]])).pass).toBe(false);
    expect(
      strategyVerdict(new Map([["A", ["TQQQ", "SOXL", "UPRO"]]])).pass
    ).toBe(false);
    expect(
      strategyVerdict(
        new Map([
          ["A", ["SPY"]],
          ["B", ["QQQ", "TQQQ", "SOXL"]],
        ])
      )
    ).toEqual({
      pass: true,
      configs: ["B"],
    });
  });
});

const weekdays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  ) {
    const date = new Date(day);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      out.push(date.toISOString().slice(0, 10));
  }
  return out;
};

const csvOf = (
  dates: readonly string[],
  value: (index: number) => number
): string =>
  [
    "date,close",
    ...dates.map((date, index) => `${date},${value(index)}`),
    "",
  ].join("\n");

/** Synthetic CSV texts for every input the backtest reads. */
const dataset = (): Map<string, string> => {
  const dates = weekdays("2010-09-01", "2011-09-30");
  const wave = (index: number): number =>
    100 * (1 + 0.05 * Math.sin(index / 7));
  const csv = new Map<string, string>();
  for (const { symbol } of UNDERLYINGS) {
    csv.set(symbol, csvOf(dates, wave));
    csv.set(`${symbol}.splits`, "date,ratio\n2011-03-01,2\n");
  }
  csv.set(
    "VIX",
    csvOf(dates, () => 20)
  );
  csv.set(
    "VIX3M",
    csvOf(dates, () => 21)
  );
  csv.set(
    "VXN",
    csvOf(dates, () => 22)
  );
  csv.set(
    "IRX",
    csvOf(dates, () => 4)
  );
  return csv;
};

describe("data loading", () => {
  it("parses closes, skipping the header, blank and short lines", () => {
    const closes = parseCloses(
      "date,close\n2020-01-02,1.5\n\n2020-01-03\n2020-01-06,2\n"
    );
    expect([...closes.entries()]).toEqual([
      ["2020-01-02", 1.5],
      ["2020-01-06", 2],
    ]);
    expect(() => parseCloses("date,close\n2020-01-02,x\n")).toThrow(
      "bad close on 2020-01-02"
    );
  });

  it("carries the last value forward and refuses dates before the first value", () => {
    const series = new Map([
      ["2020-01-03", 1],
      ["2020-01-01", 0.5],
    ]);
    expect(alignForward(["2020-01-02", "2020-01-04"], series, "X")).toEqual([
      0.5, 1,
    ]);
    expect(() => alignForward(["2019-12-31"], series, "X")).toThrow(
      "X has no value on or before 2019-12-31"
    );
  });

  it("builds each implied-volatility proxy and the split cost scale", () => {
    const csv = dataset();
    const [spy, qqq, tqqq] = UNDERLYINGS.map((underlying) =>
      buildMarket(underlying, csv)
    );
    expect(spy?.dates[0]).toBe("2011-01-03");
    expect(spy?.iv(0, 30)).toBeCloseTo(0.2, 12);
    expect(spy?.iv(0, 93)).toBeCloseTo(0.21, 12);
    expect(qqq?.iv(0, 200)).toBeCloseTo(0.22, 12);
    expect(tqqq?.iv(0, 30)).toBeGreaterThanOrEqual(0.2);
    expect(spy?.rate[0]).toBeCloseTo(0.04, 12);
    expect(spy?.costScale[0]).toBe(0.5);
    expect(spy?.costScale.at(-1)).toBe(1);
    // The split date already trades post-split: its fixed costs are not scaled, the day before is.
    const splitDay = spy?.dates.indexOf("2011-03-01") ?? -1;
    expect(spy?.costScale[splitDay]).toBe(1);
    expect(spy?.costScale[splitDay - 1]).toBe(0.5);
    // Prices stay split-adjusted: index 0 is the first weekday of 2011 in the synthetic series.
    const offset = weekdays("2010-09-01", "2010-12-31").length;
    expect(spy?.spot[0]).toBeCloseTo(
      100 * (1 + 0.05 * Math.sin(offset / 7)),
      6
    );
  });

  it("sorts closes by date whatever the file order", () => {
    const csv = dataset();
    const text = csv.get("SPY") ?? "";
    const [header = "", ...rows] = text.trim().split("\n");
    csv.set("SPY", [header, ...rows.reverse(), ""].join("\n"));
    const [spy] = UNDERLYINGS;
    if (spy === undefined) throw new Error("no SPY");
    const market = buildMarket(spy, csv);
    expect(market.dates[0]).toBe("2011-01-03");
    expect([...market.dates].sort()).toEqual(market.dates);
  });

  it("refuses missing files and too little history", () => {
    const csv = dataset();
    const [spy] = UNDERLYINGS;
    if (spy === undefined) throw new Error("no SPY");
    expect(() => buildMarket(spy, csv, "2010-10-01")).toThrow(
      `SPY needs ${RV_WINDOW} closes before 2010-10-01`
    );
    csv.delete("VIX");
    expect(() => buildMarket(spy, csv)).toThrow("missing VIX.csv");
  });
});

describe("report and CLI", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        now: () => new Date("2026-11-08T12:00:00Z"),
        stdout: { write: (text: string) => out.push(text) },
        stderr: { write: (text: string) => err.push(text) },
      },
    };
  };
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("renders a table with the verdict", () => {
    const csv = dataset();
    const markets = UNDERLYINGS.map((underlying) =>
      buildMarket(underlying, csv)
    );
    const rows = runStudy(markets);
    expect(rows).toHaveLength(CONFIGS.length * UNDERLYINGS.length);
    const report = renderResults(rows, "2026-11-08");
    expect(report).toContain("## Verdict: FAIL");
    expect(report).toContain("2011-01-03 to 2011-09-30");
    const passing = rows.map((row) => ({
      ...row,
      check: { ...row.check, pass: row.config.id === "B" },
    }));
    expect(renderResults(passing, "2026-11-08")).toContain(
      "## Verdict: PASS (configs B)"
    );
    expect(renderResults([], "2026-11-08")).toContain("Window no data");
  });

  it("runs the backtest from a data directory and writes the report", async () => {
    dir = mkdtempSync(join(tmpdir(), "calendar-spread-"));
    for (const [name, text] of dataset())
      writeFileSync(join(dir, `${name}.csv`), text);
    const out = join(dir, "results.md");
    const run = io();
    expect(
      await runCalendarSpreadCli(
        ["backtest", "--data", dir, "--out", out],
        run.io
      )
    ).toBe(0);
    const report = await readFile(out, "utf8");
    expect(report).toContain("on 2026-11-08");
    expect(run.out.join("")).toBe(report);
  });

  it("describes a play with defaults and with every option", async () => {
    const base = [
      "play",
      "--asof",
      "2026-11-06",
      "--spot",
      "45.97",
      "--strike",
      "100",
      "--near",
      "2027-02-19",
      "--far",
      "2027-05-21",
      "--near-iv",
      "1.34",
      "--far-iv",
      "1.259",
      "--debit",
      "3.75",
    ];
    const call = io();
    expect(await runCalendarSpreadCli(base, call.io)).toBe(0);
    expect(call.out.join("")).toContain("Calendar call 100");
    expect(call.out.join("")).toContain("debit used USD 375 = maximum loss");
    const put = io();
    expect(
      await runCalendarSpreadCli(
        [...base, "--right", "put", "--rate", "0.03", "--dividend", "0.01"],
        put.io
      )
    ).toBe(0);
    expect(put.out.join("")).toContain("Calendar put 100");
  });

  it("reports usage and input errors", async () => {
    const usage = io();
    expect(await runCalendarSpreadCli(["nope"], usage.io)).toBe(2);
    expect(usage.err.join("")).toContain("usage:");
    const missing = io();
    expect(await runCalendarSpreadCli(["backtest", "--data"], missing.io)).toBe(
      1
    );
    expect(missing.err.join("")).toContain("missing --data");
    const absent = io();
    expect(await runCalendarSpreadCli(["backtest"], absent.io)).toBe(1);
    expect(absent.err.join("")).toContain("missing --data");
    const right = io();
    expect(
      await runCalendarSpreadCli(["play", "--right", "straddle"], right.io)
    ).toBe(1);
    expect(right.err.join("")).toContain("--right must be call or put");
    const notNumber = io();
    expect(
      await runCalendarSpreadCli(
        ["play", "--asof", "2026-11-06", "--spot", "abc"],
        notNumber.io
      )
    ).toBe(1);
    expect(notNumber.err.join("")).toContain("--spot must be a number");
    const thrown = io();
    const failing = {
      ...thrown.io,
      stdout: {
        write: () => {
          throw "closed";
        },
      },
    };
    expect(
      await runCalendarSpreadCli(
        [
          "play",
          "--asof",
          "2026-11-06",
          "--spot",
          "1",
          "--strike",
          "1",
          "--near",
          "2026-12-01",
          "--far",
          "2027-01-01",
          "--near-iv",
          "0.3",
          "--far-iv",
          "0.3",
          "--debit",
          "0.01",
        ],
        failing
      )
    ).toBe(1);
    expect(thrown.err.join("")).toBe("closed\n");
  });
});
