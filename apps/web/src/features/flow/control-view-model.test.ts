import { describe, expect, it } from "vitest";

import { LAB_NOW } from "../../lab/fixtures/core.ts";
import { labFlowControl } from "../../lab/fixtures/flow.ts";
import {
  absorptionMarks,
  buildDeepTradesChart,
  buildNetDriftChart,
  controlAgeNotice,
  controlFreshnessRows,
  controlLines,
  controlTitle,
  crossCheckLine,
  deepTradeRows,
  deepTradesCoverageLine,
  deepTradesLimitLine,
  deepTradesMoreLine,
  deepTradesSum,
  groupOfSymbol,
  levelsLine,
  NET_DRIFT_VIEWS,
  netDriftSummary,
  STATE_TONE,
  sessionEventLine,
  studyLine,
} from "./control-view-model.ts";

const sp500 = labFlowControl("sp500");
const nasdaq = labFlowControl("nasdaq100");
const REFRESH = 60_000;

describe("control view-model", () => {
  it("maps SPY and ES to sp500 and QQQ and NQ to nasdaq100", () => {
    expect(
      ["SPY", "ES", "QQQ", "NQ"].map((symbol) => groupOfSymbol(symbol as "SPY"))
    ).toEqual(["sp500", "sp500", "nasdaq100", "nasdaq100"]);
  });

  it("titles the panel by group", () => {
    expect(controlTitle(sp500)).toBe("Who is in control: S&P 500");
    expect(controlTitle(nasdaq)).toBe("Who is in control: Nasdaq 100");
  });

  it("builds the options line and the one futures line with tone, text, since, as-of and ratio, and no agreement line", () => {
    const lines = controlLines(sp500, LAB_NOW, REFRESH);
    expect(lines.map((line) => line.key)).toEqual(["options", "futures"]);
    expect(lines[0]).toMatchObject({
      ratio: "Ratio 0.42 (enter ratio 0.30)",
      since: expect.stringMatching(/^since /u),
      state: "buyers",
      text: "SPX options: bullish, call buying leads",
      tone: "success",
    });
    expect(lines[0]?.asOf).toMatch(/^as of .*, 1m ago$/u);
    expect(lines[1]).toEqual({
      asOf: expect.stringMatching(/^as of .*, 2m ago$/u),
      key: "futures",
      ratio: null,
      since: null,
      state: "no_data",
      text: "Futures: deep trades only (sampled tape, no state); futures and options agreement is not compared or tested",
      tone: "info",
    });
    expect(STATE_TONE.mixed).toBe("warning");
  });

  it("joins label and detail for a side without data", () => {
    const control = {
      ...sp500,
      options: {
        ...sp500.options,
        asOf: null,
        detail: "4 of 10 minutes needed since 09:30 ET",
        label: "Session start",
        ratio: null,
        since: null,
        state: "no_data" as const,
      },
    };
    expect(controlLines(control, LAB_NOW, REFRESH)[0]).toMatchObject({
      asOf: null,
      ratio: null,
      since: null,
      text: "Session start: 4 of 10 minutes needed since 09:30 ET",
    });
  });

  it("drops the tones and adds the age notice for a document older than two refresh periods", () => {
    const later = new Date(LAB_NOW.getTime() + 5 * 60_000);
    expect(controlAgeNotice(sp500, LAB_NOW, REFRESH)).toBeNull();
    expect(controlAgeNotice(sp500, later, REFRESH)).toBe(
      "Data is 5 min old, refreshing"
    );
    expect(
      controlLines(sp500, later, REFRESH).map((line) => line.tone)
    ).toEqual(["neutral", "neutral"]);
  });

  it("summarises the totals per view, says no bucket yet for a missing total and shows the expiry split sentence", () => {
    const [series] = sp500.netDrift;
    if (series === undefined) throw new Error("no series");
    expect(NET_DRIFT_VIEWS.map((entry) => entry.label)).toEqual([
      "All expiries",
      "Same day (0DTE)",
      "Longer",
    ]);
    expect(
      netDriftSummary(series, "total").map((metric) => metric.label)
    ).toEqual([
      "Net call premium",
      "Net put premium",
      "Call minus put",
      "Slope per minute (15 min)",
    ]);
    expect(
      netDriftSummary({ ...series, slopeWindowMinutes: 20 }, "total")[3]?.label
    ).toBe("Slope per minute (20 min)");
    expect(netDriftSummary(series, "zero_dte")).toHaveLength(3);
    expect(netDriftSummary(series, "longer")[0]?.value).toMatch(/^\$/u);
    const partial = {
      ...series,
      partsDetail: "The same-day (0DTE) part of SPX net drift is missing",
      totals: { ...series.totals, longer: null, total: null, zeroDte: null },
    };
    expect(netDriftSummary(partial, "zero_dte")).toEqual([
      { label: "Net call premium", value: "no bucket yet" },
      { label: "Net put premium", value: "no bucket yet" },
      { label: "Call minus put", value: "no bucket yet" },
      {
        label: "Expiry split",
        value: "The same-day (0DTE) part of SPX net drift is missing",
      },
    ]);
    expect(netDriftSummary(partial, "total")).toHaveLength(4);
  });

  it("builds three lines in a 320 by 96 box, a flat line at 48 and empty strings without points", () => {
    const [series] = sp500.netDrift;
    if (series === undefined) throw new Error("no series");
    const chart = buildNetDriftChart(series, "total");
    expect(chart).toMatchObject({ height: 96, min: 0, width: 320 });
    expect(chart.call.split(" ")).toHaveLength(120);
    expect(chart.call.split(" ")[0]).toMatch(/^0\.0,/u);
    expect(chart.call.split(" ").at(-1)).toMatch(/^320\.0,/u);
    expect(chart.zeroY).toBe(92);
    expect(buildNetDriftChart(series, "zero_dte").put).not.toBe("");
    expect(buildNetDriftChart(series, "longer").difference).not.toBe("");
    const flat = buildNetDriftChart(
      {
        ...series,
        points: [
          {
            longer: null,
            minute: "t",
            total: { netCallPremiumUsd: 0, netPutPremiumUsd: 0 },
            underlyingPrice: null,
            zeroDte: null,
          },
        ],
      },
      "total"
    );
    expect(flat).toMatchObject({ call: "0.0,48.0", zeroY: 48 });
    const none = buildNetDriftChart(
      {
        ...series,
        points: series.points.map((point) => ({ ...point, zeroDte: null })),
      },
      "zero_dte"
    );
    expect(none).toEqual({
      call: "",
      difference: "",
      height: 96,
      max: 0,
      min: 0,
      put: "",
      width: 320,
      zeroY: 48,
    });
  });

  it("passes the cross-check and the study sentence through", () => {
    expect(crossCheckLine(nasdaq)).toBe(
      "Option prints are not collected for QQQ"
    );
    expect(studyLine(sp500)).toBe(
      "Options-side continuation rule (modelled fills): not tested yet"
    );
  });

  it("lists one freshness row per ticker", () => {
    expect(controlFreshnessRows(sp500)).toEqual([
      expect.objectContaining({ key: "SPX:net_drift", tone: "success" }),
      expect.objectContaining({ key: "SPY:net_drift" }),
    ]);
    expect(controlFreshnessRows(sp500)[0]?.text).toMatch(
      /^SPX net drift: fresh, last answer /u
    );
    const never = {
      ...sp500,
      freshness: [
        {
          ageSeconds: null,
          instrument: "SPX",
          lastOkAt: null,
          message: null,
          source: "net_drift" as const,
          state: "never" as const,
        },
      ],
    };
    expect(controlFreshnessRows(never)[0]?.text).toBe(
      "SPX net drift: never collected"
    );
  });
});

describe("deep trades view-model", () => {
  const deep = sp500.deepTrades;
  const nq = nasdaq.deepTrades;
  type Deep = typeof deep;
  const trade = (
    at: string,
    signing: "quote" | "tick",
    side: "buy" | "sell" = "buy"
  ): Deep["trades"][number] => ({ at, price: 6870.5, side, signing, size: 42 });

  it("states the size limit and the signing rule for tick only, quote only, mixed signing with the tick count, and without rows", () => {
    expect(deepTradesLimitLine(nq)).toBe(
      "A deep trade is one print of at least 10 contracts on NQ. Sides come from the tick rule."
    );
    expect(deepTradesLimitLine({ ...deep, signing: "quote" })).toBe(
      "A deep trade is one print of at least 40 contracts on ES. Sides come from the quote rule."
    );
    expect(deepTradesLimitLine(deep)).toBe(
      "A deep trade is one print of at least 40 contracts on ES. Sides come from the quote rule where a quote was seen, else from the tick rule; the tick rule signed 5 of the 14 trades listed."
    );
    expect(deepTradesLimitLine({ ...deep, trades: [] })).toBe(
      "A deep trade is one print of at least 40 contracts on ES."
    );
  });

  it("hides the limit line without a limit", () => {
    expect(deepTradesLimitLine({ ...deep, limitSize: null })).toBeNull();
  });

  it("states coverage as a share and in seconds, and says so before the first sampled second", () => {
    expect(deepTradesCoverageLine(deep)).toBe(
      "Tape seen: about 31% of seconds in the last 30 min (558 of 1,800 s). Busy periods are seen least: each fetch holds the newest 1000 prints, which span less time when trading is busy. The figure is approximate: it counts the first and last second of each sample, which deep-trade detection leaves out. Every sum is a lower bound."
    );
    expect(
      deepTradesCoverageLine({
        ...deep,
        coverage: { seenSeconds: 0, share: null, windowSeconds: 1800 },
      })
    ).toBe("Tape seen: no sampled second in this window yet.");
  });

  it("labels the running sum as a sum of sampled deep trades", () => {
    const sums = (buyVolume: number, sellVolume: number) =>
      deepTradesSum({
        ...deep,
        sums: {
          buyVolume,
          cumulativeFrom: null,
          netVolume: buyVolume - sellVolume,
          sellVolume,
        },
      });
    expect(sums(520, 308)).toEqual({
      label: "Sum of sampled deep trades since 09:30 ET",
      value: "+212 contracts (buy 520, sell 308)",
    });
    expect(sums(10, 1310).value).toBe("−1,300 contracts (buy 10, sell 1,310)");
    expect(sums(0, 0).value).toBe("0 contracts (buy 0, sell 0)");
  });

  it("places minutes by time, breaks the line at unsampled minutes, draws a one-minute run and is empty without minutes", () => {
    const open = Date.parse("2026-10-30T13:30:00.000Z");
    const minute = (n: number, buyVolume: number, sellVolume = 0) => ({
      buyVolume,
      coveredSeconds: 30,
      minute: new Date(open + n * 60_000).toISOString(),
      sellVolume,
    });
    const chart = buildDeepTradesChart({
      ...deep,
      minutes: [minute(0, 40), minute(1, 0, 80), minute(389, 40)],
    });
    expect(chart).toMatchObject({ height: 96, max: 40, min: -40, width: 320 });
    expect(chart.zeroY).toBe(48);
    expect(chart.segments).toEqual([
      "0.0,4.0 0.8,92.0",
      "320.0,48.0 321.0,48.0",
    ]);
    expect(buildDeepTradesChart({ ...deep, minutes: [] })).toEqual({
      height: 96,
      max: 0,
      min: 0,
      segments: [],
      width: 320,
      zeroY: 48,
    });
    expect(
      buildDeepTradesChart({ ...deep, minutes: [minute(5, 0)] }).segments
    ).toEqual(["4.1,48.0 5.1,48.0"]);
    expect(buildDeepTradesChart(deep).segments).toHaveLength(3);
  });

  it("lists trades with time, side, tone, size, price and rule", () => {
    const rows = deepTradeRows({
      ...deep,
      trades: [
        trade("2026-10-30T14:42:07.000Z", "quote"),
        trade("2026-10-30T14:43:00.000Z", "tick", "sell"),
      ],
    });
    expect(rows).toEqual([
      {
        key: "2026-10-30T14:42:07.000Z:0",
        price: "6,870.50",
        side: "Buy",
        signing: "quote rule",
        size: "42",
        time: "10:42:07 ET",
        tone: "success",
      },
      expect.objectContaining({
        side: "Sell",
        signing: "tick rule",
        tone: "destructive",
      }),
    ]);
  });

  it("says how many trades are not shown", () => {
    expect(deepTradesMoreLine(deep)).toBeNull();
    expect(deepTradesMoreLine({ ...deep, totalTrades: 143 })).toBe(
      "Showing the newest 14 of 143 deep trades"
    );
  });

  it("lists absorption marks with and without a price", () => {
    expect(absorptionMarks(deep)).toEqual([
      {
        key: "2026-10-30T15:08:00.000Z:0",
        text: "Buy absorption: heavy buying, price held at 6,871.25",
        time: "11:08 ET",
      },
      {
        key: "2026-10-30T14:41:00.000Z:1",
        text: "Sell absorption: heavy selling, price held",
        time: "10:41 ET",
      },
    ]);
  });

  it("shows the FOMC line only on an event day", () => {
    expect(sessionEventLine(nasdaq)).toBe("FOMC meeting day.");
    expect(sessionEventLine(sp500)).toBeNull();
  });

  it("prints the levels and names a missing part", () => {
    expect(levelsLine(sp500)).toBe(
      "SPX session (from one-minute closes; on a half day this is not the official close): open 6,852.10, high 6,880.40, low 6,841.00, previous close 6,848.30"
    );
    expect(levelsLine(nasdaq)).toBeNull();
    const levels = sp500.levels as NonNullable<typeof sp500.levels>;
    expect(
      levelsLine({ ...sp500, levels: { ...levels, previousClose: null } })
    ).toContain("previous close no value yet");
  });

  it("the futures line joins the sampled-tape label and the agreement detail", () => {
    const futures = controlLines(nasdaq, LAB_NOW, REFRESH).find(
      (line) => line.key === "futures"
    );
    expect(futures?.text).toBe(
      "Futures: deep trades only (sampled tape, no state); futures and options agreement is not compared or tested"
    );
  });
});
