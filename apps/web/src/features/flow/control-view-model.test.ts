import { describe, expect, it } from "vitest";

import { LAB_NOW } from "../../lab/fixtures/core.ts";
import { labFlowControl } from "../../lab/fixtures/flow.ts";
import {
  buildNetDriftChart,
  controlAgeNotice,
  controlFreshnessRows,
  controlLines,
  controlTitle,
  crossCheckLine,
  groupOfSymbol,
  NET_DRIFT_VIEWS,
  netDriftSummary,
  STATE_TONE,
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
      asOf: null,
      key: "futures",
      ratio: null,
      since: null,
      state: "no_data",
      text: "Futures: deep trades not collected yet; futures and options agreement is not compared or tested",
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
