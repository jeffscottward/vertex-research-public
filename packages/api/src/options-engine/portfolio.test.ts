import { describe, expect, it } from "vitest";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import { formatDay, parseDay } from "./calendar.ts";
import type { PricedTrade } from "./book.ts";
import { runOptionsLedger, summarizeOptionsRun } from "./index.ts";
import type { LedgerResult } from "./ledger.ts";
import {
  alignSeries,
  marketOf,
  maxOpenRisk,
  monthEndIndices,
  type OptionsDatasetRows,
  optionsContextFromRows,
  optionsDatasetFromRows,
  optionsDefinitionSeriesIds,
  runOptionsDefinition,
  windowSpans,
} from "./portfolio.ts";

const weekdays = (start: string, count: number): string[] => {
  const out: string[] = [];
  for (let day = parseDay(start); out.length < count; day++) {
    const of = new Date(day * 86_400_000).getUTCDay();
    if (of !== 0 && of !== 6) out.push(formatDay(day));
  }
  return out;
};

const DATES = weekdays("2024-01-02", 80);
const etf = (first: number) => {
  const close = DATES.map((_, index) => first + index * 0.5);
  return {
    dates: DATES,
    open: close,
    high: close,
    low: close,
    close,
    adjClose: close,
  };
};
const ROWS: OptionsDatasetRows = {
  SPY: etf(470),
  QQQ: { ...etf(400), close: [...etf(400).close.slice(0, 79), null] },
  VIX: { dates: DATES, close: DATES.map(() => 14) },
  VXN: { dates: DATES.slice(10), close: DATES.slice(10).map(() => 18) },
  IRX: { dates: DATES, close: DATES.map(() => 5.2) },
};

const definition = (extra: Record<string, unknown>) =>
  StrategyDefinitionSchema.parse({
    name: "unit",
    version: 1,
    entry: {
      all: [
        {
          left: { type: "price", field: "close" },
          op: ">",
          right: { type: "const", value: 0 },
        },
      ],
    },
    options: {
      structure: "callDebitVertical",
      dte: { target: 30, min: 20 },
      widthSigma: 0.5,
      maxLossPct: 2,
    },
    ...extra,
  });

describe("dataset from series-store rows", () => {
  it("keeps valid ETF bars, every finite close and the total-return series", () => {
    const data = optionsDatasetFromRows(ROWS);
    expect(data.calendar).toBe(data.bars["SPY"]?.dates);
    expect(data.bars["QQQ"]?.dates).toHaveLength(79);
    expect(Object.keys(data.series)).toEqual([
      "SPY",
      "QQQ",
      "VIX",
      "VXN",
      "IRX",
      "SPY:TR",
      "QQQ:TR",
    ]);
    expect(optionsContextFromRows(ROWS)["SPY:TR"]?.["2024-01-03"]).toBe(470.5);
  });

  it("refuses inconsistent rows and a missing calendar", () => {
    expect(() =>
      optionsDatasetFromRows({ VIX: { dates: ["2024-01-02"], close: [] } })
    ).toThrow("VIX: close and dates differ in length");
    const { open: _open, ...noOpen } = etf(1);
    expect(() => optionsDatasetFromRows({ SPY: noOpen })).toThrow(
      "SPY: open misses dates"
    );
    expect(() =>
      optionsDatasetFromRows({ SPY: { ...etf(1), low: [1] } })
    ).toThrow("SPY: low misses dates");
    const backwards = { ...etf(1), dates: [...DATES].reverse() };
    expect(() => optionsDatasetFromRows({ SPY: backwards })).toThrow(
      "SPY: dates must be strictly increasing"
    );
    expect(() => optionsDatasetFromRows({ QQQ: etf(1) })).toThrow(
      "The market calendar needs SPY bars"
    );
  });

  it("builds the options market with the 5-bar carry", () => {
    expect(
      alignSeries(
        { "2024-01-01": 1, "2024-01-04": 2 },
        ["2024-01-02", "2024-01-05", "2024-01-08"],
        1
      )
    ).toEqual([1, 2, 2]);
    expect(
      alignSeries(
        { "2024-01-01": 1 },
        ["2024-01-02", "2024-01-03", "2024-01-04"],
        1
      )
    ).toEqual([1, 1, null]);
    expect(alignSeries({}, ["2024-01-02"], 5)).toEqual([null]);
    const data = optionsDatasetFromRows(ROWS);
    const market = marketOf(data, "QQQ");
    expect([market.ivIndex[9], market.ivIndex[10], market.rate[0]]).toEqual([
      null,
      18,
      0.052_000_000_000_000_005,
    ]);
    expect(() => marketOf(data, "XYZ")).toThrow("No IV index for XYZ");
    expect(() => marketOf(data, "IWM")).toThrow("No bars for IWM");
    const { IRX: _irx, ...noRate } = ROWS;
    expect(() => marketOf(optionsDatasetFromRows(noRate), "SPY")).toThrow(
      "Series data is not available for IRX"
    );
  });
});

describe("helpers", () => {
  it("finds month ends and windows", () => {
    expect(
      monthEndIndices(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"])
    ).toEqual([1]);
    expect(windowSpans([true, true, false, true])).toEqual([
      [0, 1],
      [3, 3],
    ]);
    expect(windowSpans([false, true, false])).toEqual([[1, 1]]);
  });

  it("lists every series id a definition reads", () => {
    const own = definition({
      filters: [{ type: "ivRank", length: 20, min: 10 }],
      entry: {
        all: [
          {
            left: { type: "series", series: "$tr" },
            op: ">",
            right: { type: "series", series: "$future" },
          },
          {
            left: { type: "series", series: "SPY:TR" },
            op: ">",
            right: { type: "series", series: "VIX3M" },
          },
        ],
      },
      portfolio: { symbols: ["QQQ", "GLD"], policy: "roll" },
    });
    expect(optionsDefinitionSeriesIds(own)).toEqual([
      "QQQ",
      "VXN",
      "IRX",
      "SPY",
      "GLD",
      "GVZ",
      "NQ=F",
      "VIX3M",
      "GC=F",
    ]);
    expect(optionsDefinitionSeriesIds(definition({}), "SPY")).toEqual([
      "SPY",
      "VIX",
      "IRX",
    ]);
    const relative = definition({
      entry: {
        all: [
          {
            left: { type: "series", series: "$tr" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
    });
    expect(optionsDefinitionSeriesIds(relative, "XYZ")).toEqual([
      "XYZ",
      "IRX",
      "SPY",
    ]);
    expect(() => optionsDefinitionSeriesIds(definition({}))).toThrow(
      "A definition without a portfolio block needs the run symbol"
    );
  });
});

describe("runOptionsDefinition", () => {
  const data = optionsDatasetFromRows(ROWS);

  it("runs the run symbol with the flat daily policy and slices at the end", () => {
    const outcome = runOptionsDefinition(definition({}), data, {
      start: "2024-01-02",
      end: "2024-03-29",
      symbol: "SPY",
    });
    expect(outcome.result.dates.at(-1)).toBe("2024-03-29");
    expect(outcome.priced.map((trade) => trade.tradeId)).toEqual(
      outcome.priced.map((_, index) => index + 1)
    );
    expect(outcome.signals["SPY"]).toBeGreaterThan(0);
    expect(summarizeOptionsRun(outcome.result, { nTrials: 1 }).trades).toBe(
      outcome.result.trades.length
    );
    expect(runOptionsLedger(outcome.priced).capital).toBe(100_000);
  });

  it("joins a member at its first IV value and runs the window and monthEnd policies", () => {
    const window = runOptionsDefinition(
      definition({
        filters: [
          {
            type: "calendarWindow",
            window: "turnOfMonth",
            fromDay: -2,
            toDay: 2,
          },
        ],
        portfolio: { symbols: ["SPY", "QQQ"], policy: "window" },
      }),
      data,
      { start: "2024-01-02", capital: 50_000 }
    );
    expect(
      window.priced
        .filter((trade) => trade.symbol === "QQQ")
        .every((trade) => trade.entryIndex >= 11)
    ).toBe(true);
    expect(window.result.capital).toBe(50_000);
    const monthEnd = runOptionsDefinition(
      definition({
        portfolio: { symbols: ["SPY"], policy: "flat", cadence: "monthEnd" },
      }),
      data,
      { start: "2024-01-02" }
    );
    expect(monthEnd.signals).toEqual({ SPY: 2 }); // the March candidate waits on the open spread
  });

  it("breaks selection ties by the tie-break, then the symbol order, and skips members without IV", () => {
    const twins = optionsDatasetFromRows({
      ...ROWS,
      QQQ: etf(470),
      VXN: { dates: DATES, close: DATES.map(() => 14) },
      USO: etf(700), // a smaller monthly change: never selected
      OVX: { dates: ["2030-01-02"], close: [30] },
    });
    const change = {
      type: "change",
      of: { type: "price", field: "close" },
      length: 1,
    };
    const outcome = runOptionsDefinition(
      definition({
        portfolio: {
          symbols: ["QQQ", "SPY", "USO"],
          policy: "roll",
          frame: "monthly",
          select: { score: change, tieBreak: change, top: 1 },
        },
      }),
      twins,
      { start: "2024-01-02" }
    );
    expect(outcome.priced.map((trade) => trade.symbol)).toEqual(["QQQ", "QQQ"]);
    expect(outcome.signals).toEqual({ QQQ: 2, SPY: 0, USO: 0 });
  });

  it("needs an options block", () => {
    const { options: _options, ...plain } = definition({});
    expect(() =>
      runOptionsDefinition(plain, data, { start: "2024-01-02", symbol: "SPY" })
    ).toThrow("The options runner needs an options block");
  });
});

describe("maxOpenRisk", () => {
  const ledger = (equity: number[]): LedgerResult =>
    ({
      dates: ["2024-01-02", "2024-01-03", "2024-01-04"],
      equity,
      openPositions: [1, 1, 0],
      trades: [
        {
          id: 1,
          entryDate: "2024-01-02",
          exitDate: "2024-01-04",
          contracts: 2,
        },
      ],
      skipped: [],
      capital: 1000,
      engine: "test",
    }) as unknown as LedgerResult;
  const priced = (maxLoss: number): PricedTrade[] =>
    [{ tradeId: 1, maxLoss }] as unknown as PricedTrade[];

  it("takes the largest open risk over equity", () => {
    expect(maxOpenRisk(ledger([1000, 500, 400]), priced(50))).toBe(0.2);
  });

  it("throws on a trade id without a priced trade, like the Python KeyError", () => {
    expect(() => maxOpenRisk(ledger([1000, 500, 400]), [])).toThrow(
      /trade id 1/
    );
  });

  it("never returns NaN: a NaN ratio keeps the worst so far, like Python max", () => {
    expect(maxOpenRisk(ledger([1000, 500, 400]), priced(Number.NaN))).toBe(0);
  });
});
