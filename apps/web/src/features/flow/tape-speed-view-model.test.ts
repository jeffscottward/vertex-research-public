import type { FlowTapeSpeed } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildTapeSpeedChart,
  burstCountLine,
  burstRows,
  evaluatedSentence,
  ruleSentence,
  TAPE_SPEED_BURST_HEADERS,
  TAPE_SPEED_PAD,
  tapeFaultLine,
  tapeLine,
  tapeSpeedAriaLabel,
  tapeSpeedCaption,
  tapeSpeedLegend,
  tapeSpeedTitle,
  tapeSymbolOf,
} from "./tape-speed-view-model.ts";
import { CHART_HEIGHT } from "./view-model.ts";

type Bar = FlowTapeSpeed["bars"][number];

// Friday 2026-11-20, 16:00 New York (EST).
const AXIS = "2026-11-20T21:00:00.000Z";
const startOf = (index: number, bucket = 10): string =>
  new Date(Date.parse(AXIS) + index * bucket * 1000).toISOString();

const counted = (index: number, overrides: Partial<Bar> = {}): Bar => ({
  burstSeconds: 0,
  contracts: 300,
  coveredSeconds: 10,
  peakContracts: 60,
  peakTrades: 25,
  start: startOf(index),
  state: "counted",
  trades: 100,
  ...overrides,
});
const shaded = (index: number, state: "no_data" | "not_recorded"): Bar => ({
  burstSeconds: 0,
  contracts: 0,
  coveredSeconds: 0,
  peakContracts: 0,
  peakTrades: 0,
  start: startOf(index),
  state,
  trades: 0,
});

const documentOf = (overrides: Partial<FlowTapeSpeed> = {}): FlowTapeSpeed => ({
  axisStart: AXIS,
  bars: [counted(0), counted(1)],
  bucketSeconds: 10,
  bursts: [],
  contract: "ESZ6",
  rules: {
    baselineSeconds: 600,
    floorTrades: 20,
    minBaselineCoveredSeconds: 300,
    multiple: 8,
    version: "flow-tape-speed-rules.v1",
  },
  schemaVersion: "flow-tape-speed.v1",
  storedUntil: "2026-11-20T21:59:00.000Z",
  symbol: "ES",
  tape: {
    ageSeconds: 40,
    lastOkAt: "2026-11-20T21:59:20.000Z",
    lastStatus: "ok",
    message: "streamed tape ESZ6: 2 prints in 2 complete minutes",
    sessionOpen: true,
    source: "ticks",
    state: "fresh",
  },
  totals: { bursts: 0, coveredSeconds: 20, evaluatedSeconds: 20 },
  ...overrides,
});
const tape = (
  overrides: Partial<FlowTapeSpeed["tape"]>
): FlowTapeSpeed["tape"] => ({ ...documentOf().tape, ...overrides });

describe("the future that a symbol shows", () => {
  it("is ES for SPY and ES, and NQ for QQQ and NQ", () => {
    expect((["SPY", "ES", "QQQ", "NQ"] as const).map(tapeSymbolOf)).toEqual([
      "ES",
      "ES",
      "NQ",
      "NQ",
    ]);
  });

  it("titles a future by itself and names the group for SPY and QQQ", () => {
    expect(tapeSpeedTitle("ES")).toBe("Tape speed (ES)");
    expect(tapeSpeedTitle("NQ")).toBe("Tape speed (NQ)");
    expect(tapeSpeedTitle("SPY")).toBe(
      "Tape speed (ES, the future of the S&P 500 group)"
    );
    expect(tapeSpeedTitle("QQQ")).toBe(
      "Tape speed (NQ, the future of the Nasdaq 100 group)"
    );
  });
});

describe("tapeLine", () => {
  const SUFFIX =
    "stored per complete minute, 1 to 2 minutes behind the market; the newest minute can still change";

  it("gives the state, the start of the newest stored minute with its date, and the delay", () => {
    expect(tapeLine(documentOf())).toBe(
      `Tape ESZ6: fresh · newest stored minute Nov 20, 4:58 PM EST · ${SUFFIX}`
    );
  });

  it("says market closed for a closed session and adds no message", () => {
    expect(tapeLine(documentOf({ tape: tape({ state: "closed" }) }))).toBe(
      `Tape ESZ6: market closed · newest stored minute Nov 20, 4:58 PM EST · ${SUFFIX}`
    );
  });

  it("adds the last message for a stale tape, when there is one", () => {
    expect(
      tapeLine(
        documentOf({
          tape: tape({
            message: "tape stream down: connection closed",
            state: "stale",
          }),
        })
      )
    ).toBe(
      `Tape ESZ6: stale · newest stored minute Nov 20, 4:58 PM EST · ${SUFFIX} · last read: tape stream down: connection closed`
    );
    expect(
      tapeLine(documentOf({ tape: tape({ message: null, state: "stale" }) }))
    ).toBe(
      `Tape ESZ6: stale · newest stored minute Nov 20, 4:58 PM EST · ${SUFFIX}`
    );
  });

  it("names the symbol without a contract and says so without a stored minute", () => {
    expect(
      tapeLine(
        documentOf({
          contract: null,
          storedUntil: null,
          tape: tape({ message: "tape stream off: no tick", state: "never" }),
        })
      )
    ).toBe(
      `Tape ES: never collected · no per-second counts in this window · ${SUFFIX} · last read: tape stream off: no tick`
    );
  });
});

describe("tapeFaultLine", () => {
  it("is null without the note of a failed per-second write", () => {
    expect(tapeFaultLine(documentOf())).toBeNull();
    expect(tapeFaultLine(documentOf({ tape: tape({ message: null }) }))).toBe(
      null
    );
  });

  it("names the fault from the note, in every tape state and before the skip note", () => {
    const note = "; per-second counts not stored (PostgresError 42501)";
    expect(
      tapeFaultLine(
        documentOf({
          tape: tape({ message: `streamed tape ESZ6: 2 prints${note}` }),
        })
      )
    ).toBe("Per-second counts are not being stored: (PostgresError 42501)");
    expect(
      tapeFaultLine(
        documentOf({
          tape: tape({
            message: `tape stream down: x${note}; older minutes skipped (look-back limit 10 min)`,
            state: "stale",
          }),
        })
      )
    ).toBe("Per-second counts are not being stored: (PostgresError 42501)");
  });
});

describe("buildTapeSpeedChart", () => {
  const usable = CHART_HEIGHT - TAPE_SPEED_PAD;

  it("draws one slot per bar on a logarithmic scale topped at the largest second", () => {
    const chart = buildTapeSpeedChart(
      documentOf({
        bars: [
          // Mean 9 trades per second and a top of 99: ln(10) ÷ ln(100), half of the usable height.
          counted(0, { peakTrades: 99, trades: 90 }),
          counted(1, { contracts: 10, peakContracts: 400, peakTrades: 4 }),
        ],
      })
    );
    expect(chart.width).toBe(8);
    expect(chart.height).toBe(CHART_HEIGHT);
    expect(chart.topTrades).toBe(99);
    expect(chart.topContracts).toBe(400);
    expect(chart.counted).toBe(2);
    const [first, second] = chart.trades;
    expect(first).toMatchObject({
      partial: false,
      start: startOf(0),
      width: 3,
      x: 0.5,
    });
    expect(first?.height).toBeCloseTo(usable / 2, 10);
    expect(first?.y).toBeCloseTo(CHART_HEIGHT - usable / 2, 10);
    expect(first?.tickY).toBeCloseTo(TAPE_SPEED_PAD, 10);
    expect(second?.x).toBe(4.5);
    // The tick of the largest contract second is at the top padding; the bar is its mean of 1.
    expect(chart.contracts[1]?.tickY).toBeCloseTo(TAPE_SPEED_PAD, 10);
    expect(chart.contracts[1]?.height).toBeCloseTo(
      (Math.log(2) / Math.log(401)) * usable,
      10
    );
  });

  it("has the width of the page windows: 366 and 391 bars", () => {
    const bars = (count: number) =>
      Array.from({ length: count }, (_, index) => counted(index));
    expect(buildTapeSpeedChart(documentOf({ bars: bars(366) })).width).toBe(
      1464
    );
    expect(buildTapeSpeedChart(documentOf({ bars: bars(391) })).width).toBe(
      1564
    );
  });

  it("draws a counted bar without a trade at height 0, and marks a partly covered bar", () => {
    const chart = buildTapeSpeedChart(
      documentOf({
        bars: [
          counted(0, {
            contracts: 0,
            peakContracts: 0,
            peakTrades: 0,
            trades: 0,
          }),
          counted(1, { coveredSeconds: 7 }),
        ],
      })
    );
    expect(chart.trades[0]).toMatchObject({
      height: 0,
      partial: false,
      tickY: CHART_HEIGHT,
      y: CHART_HEIGHT,
    });
    expect(chart.trades[1]?.partial).toBe(true);
    expect(chart.shades).toEqual([]);
    expect(chart.shadedSeconds).toEqual({ no_data: 0, not_recorded: 0 });
  });

  it("joins neighbouring bars of one state into one shade and keeps states apart", () => {
    const chart = buildTapeSpeedChart(
      documentOf({
        bars: [
          shaded(0, "no_data"),
          shaded(1, "no_data"),
          shaded(2, "not_recorded"),
          counted(3),
          shaded(4, "no_data"),
        ],
      })
    );
    expect(chart.shades).toEqual([
      { state: "no_data", width: 8, x: 0 },
      { state: "not_recorded", width: 4, x: 8 },
      { state: "no_data", width: 4, x: 16 },
    ]);
    expect(chart.shadedSeconds).toEqual({ no_data: 30, not_recorded: 10 });
    expect(chart.trades.map((bar) => bar.x)).toEqual([12.5]);
  });

  it("puts one mark over the middle of each bar with a burst second", () => {
    const chart = buildTapeSpeedChart(
      documentOf({
        bars: [
          counted(0, { burstSeconds: 1 }),
          counted(1),
          counted(2),
          counted(3, { burstSeconds: 2 }),
        ],
        totals: { bursts: 2, coveredSeconds: 40, evaluatedSeconds: 40 },
      })
    );
    expect(chart.marks).toEqual([
      { leftPercent: 12.5, start: startOf(0) },
      { leftPercent: 87.5, start: startOf(3) },
    ]);
    expect(chart.bursts).toBe(2);
  });

  it("draws shades only, on a scale of 1, without a counted bar", () => {
    const chart = buildTapeSpeedChart(
      documentOf({
        bars: [shaded(0, "not_recorded"), shaded(1, "not_recorded")],
      })
    );
    expect(chart).toMatchObject({
      contracts: [],
      counted: 0,
      marks: [],
      topContracts: 1,
      topTrades: 1,
      trades: [],
    });
    expect(chart.shades).toEqual([{ state: "not_recorded", width: 8, x: 0 }]);
  });

  it("labels the start and the end of the axis in New York time", () => {
    const bars = Array.from({ length: 366 }, (_, index) => counted(index));
    const chart = buildTapeSpeedChart(documentOf({ bars }));
    expect([chart.startLabel, chart.endLabel]).toEqual([
      "4:00 PM EST",
      "5:01 PM EST",
    ]);
  });
});

describe("texts of the charts", () => {
  const chart = buildTapeSpeedChart(
    documentOf({
      bars: [
        counted(0, {
          burstSeconds: 1,
          peakContracts: 16_104,
          peakTrades: 2740,
        }),
        shaded(1, "no_data"),
      ],
      totals: { bursts: 3, coveredSeconds: 10, evaluatedSeconds: 10 },
    })
  );

  it("gives each chart a text alternative with the axis, the bucket and the largest second", () => {
    expect(tapeSpeedAriaLabel(chart, "trades")).toBe(
      "Trades per second from 4:00 PM EST to 4:00 PM EST, one bar per 10 s, largest second 2,740, 3 bursts"
    );
    expect(tapeSpeedAriaLabel(chart, "contracts")).toBe(
      "Contracts per second from 4:00 PM EST to 4:00 PM EST, one bar per 10 s, largest second 16,104"
    );
  });

  it.each([10, 20, 60])("states a bucket of %i s in the caption", (bucket) => {
    const caption = tapeSpeedCaption(
      buildTapeSpeedChart(documentOf({ bucketSeconds: bucket }))
    );
    expect(caption).toBe(
      `Each bar: ${bucket} s. Bar: mean per second over the covered seconds of the bar. Tick: the busiest second of the bar. Logarithmic scale. Largest second: 25 trades, 60 contracts. A lighter bar had only part of its seconds covered.`
    );
  });

  it("lists a legend entry for each shade state that occurs, with minutes rounded up", () => {
    expect(tapeSpeedLegend(buildTapeSpeedChart(documentOf()))).toEqual([]);
    // 59 shaded seconds are 1 minute; 61 are 2 minutes.
    const sixty = (state: "no_data" | "not_recorded", seconds: number) =>
      documentOf({ bars: [shaded(0, state)], bucketSeconds: seconds });
    expect(tapeSpeedLegend(buildTapeSpeedChart(sixty("no_data", 59)))).toEqual([
      {
        state: "no_data",
        text: "No data: 1 min (the stream was not live, or it had no trade for more than 60 s)",
      },
    ]);
    expect(
      tapeSpeedLegend(
        buildTapeSpeedChart(
          documentOf({
            bars: [shaded(0, "no_data"), shaded(1, "not_recorded")],
            bucketSeconds: 61,
          })
        )
      )
    ).toEqual([
      {
        state: "not_recorded",
        text: "Collected, but no per-second counts: 2 min (before this panel was deployed, or the per-second write failed)",
      },
      {
        state: "no_data",
        text: "No data: 2 min (the stream was not live, or it had no trade for more than 60 s)",
      },
    ]);
  });
});

describe("rule and bursts", () => {
  it("states the rule with its numbers and version, and what a burst is not", () => {
    expect(ruleSentence(documentOf().rules)).toBe(
      "◆ Burst: a second with at least 8 times the mean rate of the 10 minutes before it and at least 20 trades (rule flow-tape-speed-rules.v1). A burst describes the tape. It is not a trade signal, and it is not a large trade."
    );
  });

  it("says how many covered seconds the rule evaluated, only when some were not", () => {
    expect(evaluatedSentence(documentOf())).toBeNull();
    expect(
      evaluatedSentence(
        documentOf({
          totals: { bursts: 0, coveredSeconds: 7200, evaluatedSeconds: 6600 },
        })
      )
    ).toBe(
      "Rule evaluated on 6,600 of 7,200 covered seconds; it needs 300 covered seconds in the 10 minutes before a second."
    );
  });

  it("formats the burst rows: New York time with seconds, one decimal, and n/a without a multiple", () => {
    expect(TAPE_SPEED_BURST_HEADERS).toEqual([
      "Time (ET)",
      "Seconds",
      "Peak trades/s",
      "Contracts",
      "Baseline",
      "Multiple",
    ]);
    const rows = burstRows(
      documentOf({
        bursts: [
          {
            baseline: 4.26,
            contracts: 1240,
            multiple: 12.44,
            peakTrades: 53,
            seconds: 2,
            start: "2026-11-20T21:39:57.000Z",
          },
          {
            baseline: 0,
            contracts: 31,
            multiple: null,
            peakTrades: 2740,
            seconds: 1,
            start: "2026-11-20T21:52:55.000Z",
          },
        ],
      })
    );
    expect(rows).toEqual([
      {
        baseline: "4.3",
        contracts: "1,240",
        key: "2026-11-20T21:39:57.000Z",
        multiple: "12.4x",
        peakTrades: "53",
        seconds: "2",
        time: "16:39:57 ET",
      },
      {
        baseline: "0.0",
        contracts: "31",
        key: "2026-11-20T21:52:55.000Z",
        multiple: "n/a",
        peakTrades: "2,740",
        seconds: "1",
        time: "16:52:55 ET",
      },
    ]);
  });

  it("has a count line for no burst and for more bursts than listed", () => {
    expect(burstCountLine(documentOf())).toBe("No burst in this window.");
    const listed = [
      {
        baseline: 10,
        contracts: 90,
        multiple: 9,
        peakTrades: 90,
        seconds: 1,
        start: startOf(0),
      },
    ];
    expect(
      burstCountLine(
        documentOf({
          bursts: listed,
          totals: { bursts: 1, coveredSeconds: 20, evaluatedSeconds: 20 },
        })
      )
    ).toBeNull();
    expect(
      burstCountLine(
        documentOf({
          bursts: listed,
          totals: { bursts: 1430, coveredSeconds: 20, evaluatedSeconds: 20 },
        })
      )
    ).toBe("Showing the newest 1 of 1,430 bursts.");
  });
});
