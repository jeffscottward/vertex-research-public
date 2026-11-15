import { describe, expect, it } from "vitest";

import {
  parseResearchScreenChart,
  researchScreenChartUrl,
} from "./research-screen-quote.ts";

// Synthetic fixtures: invented prices on invented days.
const DAY = 86_400;
const T0 = Date.UTC(2030, 0, 7, 14, 30) / 1000;

const meta = (overrides: Record<string, unknown> = {}) => ({
  currency: "USD",
  currentTradingPeriod: {
    regular: { end: T0 + 2 * DAY + 23_400, start: T0 + 2 * DAY },
  },
  exchangeTimezoneName: "America/New_York",
  instrumentType: "EQUITY",
  regularMarketPrice: 12.5,
  regularMarketTime: T0 + 2 * DAY + 600,
  symbol: "TEST",
  ...overrides,
});

const answer = (result: unknown) => ({ chart: { error: null, result } });

const full = (overrides: Record<string, unknown> = {}) =>
  answer([
    {
      indicators: {
        quote: [
          {
            close: [10.5, 11.5, 12.5],
            high: [11, 12, 13],
            low: [9, 10, 11],
            open: [10, 11, 12],
            volume: [100, 200, 300],
          },
        ],
      },
      meta: meta(),
      timestamp: [T0, T0 + DAY, T0 + 2 * DAY],
      ...overrides,
    },
  ]);

describe("researchScreenChartUrl", () => {
  it("builds the chart URL of a plain symbol", () => {
    expect(researchScreenChartUrl("TEST")).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/TEST?range=1y&interval=1d&includePrePost=false"
    );
  });

  it("keeps a suffixed foreign symbol and encodes a futures symbol", () => {
    expect(researchScreenChartUrl("AAA.TO")).toContain("/chart/AAA.TO?");
    expect(researchScreenChartUrl("AA=F")).toContain("/chart/AA%3DF?");
    expect(researchScreenChartUrl("^AAA")).toContain("/chart/%5EAAA?");
  });
});

describe("parseResearchScreenChart", () => {
  it("reads the quote and the bars of a full answer", () => {
    expect(parseResearchScreenChart(full())).toEqual({
      bars: [
        { c: 10.5, date: "2030-01-07", h: 11, l: 9, o: 10 },
        { c: 11.5, date: "2030-01-08", h: 12, l: 10, o: 11 },
        { c: 12.5, date: "2030-01-09", h: 13, l: 11, o: 12 },
      ],
      quote: {
        currency: "USD",
        instrumentType: "EQUITY",
        price: 12.5,
        quoteAt: new Date((T0 + 2 * DAY + 600) * 1000),
        sessionEnd: new Date((T0 + 2 * DAY + 23_400) * 1000),
        sessionStart: new Date((T0 + 2 * DAY) * 1000),
        timeZone: "America/New_York",
      },
    });
  });

  it("returns no quote and no bars for an answer without a result", () => {
    const empty = { bars: [], quote: null };
    expect(parseResearchScreenChart(answer(null))).toEqual(empty);
    expect(parseResearchScreenChart(answer([]))).toEqual(empty);
    expect(parseResearchScreenChart(answer(["text"]))).toEqual(empty);
    expect(parseResearchScreenChart({})).toEqual(empty);
    expect(parseResearchScreenChart(null)).toEqual(empty);
    expect(parseResearchScreenChart("not json")).toEqual(empty);
  });

  it("returns a null quote and UTC dates when meta is missing", () => {
    const late = Date.UTC(2030, 0, 8, 2) / 1000;
    const columns = { close: [2], high: [3], low: [1], open: [2] };
    const parsed = parseResearchScreenChart(
      answer([
        { indicators: { quote: [columns] }, meta: null, timestamp: [late] },
      ])
    );
    expect(parsed.quote).toBeNull();
    expect(parsed.bars).toEqual([
      { c: 2, date: "2030-01-08", h: 3, l: 1, o: 2 },
    ]);
    // The same instant is the previous calendar day in New York.
    const zoned = parseResearchScreenChart(
      answer([
        { indicators: { quote: [columns] }, meta: meta(), timestamp: [late] },
      ])
    );
    expect(zoned.bars.map((bar) => bar.date)).toEqual(["2030-01-07"]);
  });

  it("uses UTC when the time zone is missing or not accepted", () => {
    const late = Date.UTC(2030, 0, 8, 2) / 1000;
    for (const exchangeTimezoneName of [undefined, "Not/AZone"]) {
      const parsed = parseResearchScreenChart(
        full({ meta: meta({ exchangeTimezoneName }), timestamp: [late] })
      );
      expect(parsed.bars.map((bar) => bar.date)).toEqual(["2030-01-08"]);
    }
  });

  it("gives null parts for a missing price, time and identity fields", () => {
    const parsed = parseResearchScreenChart(
      full({
        meta: {
          currency: 7,
          currentTradingPeriod: { regular: { end: "x", start: null } },
          instrumentType: " ",
          regularMarketPrice: 0,
          regularMarketTime: Number.MAX_VALUE,
        },
      })
    );
    expect(parsed.quote).toEqual({
      currency: null,
      instrumentType: null,
      price: null,
      quoteAt: null,
      sessionEnd: null,
      sessionStart: null,
      timeZone: null,
    });
    expect(parsed.bars).toHaveLength(3);
    const noPeriod = parseResearchScreenChart(
      full({ meta: meta({ currentTradingPeriod: undefined }) })
    );
    expect(noPeriod.quote?.sessionStart).toBeNull();
    expect(noPeriod.quote?.sessionEnd).toBeNull();
    expect(noPeriod.quote?.price).toBe(12.5);
    const noTime = parseResearchScreenChart(
      full({ meta: meta({ regularMarketTime: undefined }) })
    );
    expect(noTime.quote?.quoteAt).toBeNull();
    expect(parseResearchScreenChart(full({ meta: "text" })).quote).toBeNull();
  });

  it("drops bars with null or non-finite values and later duplicates of a date", () => {
    const parsed = parseResearchScreenChart(
      full({
        indicators: {
          quote: [
            {
              close: [10.5, null, 12.5, 13.5, 14.5, 15.5],
              high: [11, 12, 13, 14, 15],
              low: [9, 10, 11, 12, "13"],
              open: [10, 11, 12, 13, 14, 15],
            },
          ],
        },
        timestamp: [
          T0,
          T0 + DAY,
          T0 + 2 * DAY,
          T0 + 2 * DAY + 60,
          T0 + 4 * DAY,
          null,
        ],
      })
    );
    expect(parsed.bars).toEqual([
      { c: 10.5, date: "2030-01-07", h: 11, l: 9, o: 10 },
      { c: 12.5, date: "2030-01-09", h: 13, l: 11, o: 12 },
    ]);
  });

  it("returns no bars when the bar fields are missing or malformed", () => {
    expect(
      parseResearchScreenChart(full({ timestamp: undefined })).bars
    ).toEqual([]);
    expect(
      parseResearchScreenChart(full({ indicators: undefined })).bars
    ).toEqual([]);
    expect(
      parseResearchScreenChart(full({ indicators: { quote: [] } })).bars
    ).toEqual([]);
    const columns = parseResearchScreenChart(
      full({
        indicators: { quote: [{ close: "x", high: [1], low: [1], open: [1] }] },
      })
    );
    expect(columns.bars).toEqual([]);
    expect(columns.quote?.price).toBe(12.5);
  });
});
