import { describe, expect, it } from "vitest";

import { FlowTapeSpeedSchema } from "../contracts/flow.ts";
import type { FlowTapeSecondsRow } from "../flow-tape-seconds.ts";
import { FLOW_TAPE_SPEED_RULES } from "../flow-tape-speed-rules.ts";
import type { FlowSampleRow } from "./flow-snapshot.ts";
import {
  buildFlowTapeSpeed,
  type FlowTapeSpeedRows,
  tapeSpeedAxis,
  tapeSpeedBucketSeconds,
} from "./flow-tape-speed.ts";

// Monday 2026-11-09, 10:03:27 New York: the window ends inside the minute 15:03 UTC.
const END = new Date("2026-11-09T15:03:27.000Z");
const NOW = new Date("2026-11-09T15:05:00.000Z");
const at = (clock: string): Date => new Date(`2026-11-09T${clock}.000Z`);
const epoch = (clock: string): number => at(clock).getTime() / 1000;

const rowsFor = (
  minutes: number,
  overrides: Partial<FlowTapeSpeedRows> = {}
): FlowTapeSpeedRows => ({
  latest: [],
  latestOk: [],
  minuteStarts: [],
  minutes,
  now: NOW,
  seconds: [],
  symbol: "ES",
  windowEnd: END,
  windowStart: new Date(END.getTime() - minutes * 60_000),
  ...overrides,
});

/** One stored minute: `trades(i)` prints and twice as many contracts in second i. */
const minuteRow = (
  minute: Date,
  trades: (second: number) => number = () => 10,
  covered = "1".repeat(60)
): FlowTapeSecondsRow => {
  const counts = Array.from({ length: 60 }, (_, second) => trades(second));
  return {
    contract: "ESZ6",
    contracts: counts.map((count) => count * 2),
    covered,
    minute,
    symbol: "ES",
    totalTrades: counts.reduce((sum, count) => sum + count, 0),
    trades: counts,
  };
};

/** Stored minutes from `from` to before `to`, each second with `trades(epoch second)` prints. */
const stretch = (
  from: string,
  to: string,
  trades: (t: number) => number = () => 10
): FlowTapeSecondsRow[] => {
  const rows: FlowTapeSecondsRow[] = [];
  for (let minute = epoch(from); minute < epoch(to); minute += 60)
    rows.push(
      minuteRow(new Date(minute * 1000), (second) => trades(minute + second))
    );
  return rows;
};

/** The bar of the document that starts at `clock`. */
const barAt = (
  document: ReturnType<typeof buildFlowTapeSpeed>,
  clock: string
) => {
  const bar = document.bars.find(
    (row) => row.start === at(clock).toISOString()
  );
  if (bar === undefined) throw new Error(`no bar at ${clock}`);
  return bar;
};

describe("tapeSpeedBucketSeconds", () => {
  it("is 10 s up to 60 minutes, 20 s up to 120 minutes and 60 s above", () => {
    expect([15, 60, 61, 120, 121, 390].map(tapeSpeedBucketSeconds)).toEqual([
      10, 10, 20, 20, 60, 60,
    ]);
  });
});

describe("tapeSpeedAxis", () => {
  it("runs from the minute of the window start to the end of the minute of the window end, with the lead-in of the rule", () => {
    const axis = tapeSpeedAxis(new Date(END.getTime() - 3_600_000), END);
    expect(axis).toEqual({
      axisEnd: at("15:04:00"),
      axisStart: at("14:03:00"),
      readFrom: at("13:53:00"),
    });
    expect(FLOW_TAPE_SPEED_RULES.baselineSeconds).toBe(600);
  });

  it("keeps a window that ends at a whole minute on that minute", () => {
    const axis = tapeSpeedAxis(at("14:00:00"), at("15:00:00"));
    expect([axis.axisStart, axis.axisEnd]).toEqual([
      at("14:00:00"),
      at("15:01:00"),
    ]);
  });
});

describe("buildFlowTapeSpeed", () => {
  it.each([
    [60, 10, 366],
    [120, 20, 363],
    [240, 60, 241],
    [390, 60, 391],
  ])(
    "the %i-minute window has %i s bars and %i of them, and passes the schema",
    (minutes, bucket, bars) => {
      const document = buildFlowTapeSpeed(rowsFor(minutes));
      expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
      expect(document.bucketSeconds).toBe(bucket);
      expect(document.bars).toHaveLength(bars);
      expect(document.axisStart).toBe(
        new Date(
          Math.floor((END.getTime() - minutes * 60_000) / 60_000) * 60_000
        ).toISOString()
      );
      // The bars follow each other without a step.
      expect(document.bars[1]?.start).toBe(
        new Date(Date.parse(document.axisStart) + bucket * 1000).toISOString()
      );
      expect(document).toMatchObject({
        bursts: [],
        contract: null,
        rules: FLOW_TAPE_SPEED_RULES,
        schemaVersion: "flow-tape-speed.v1",
        storedUntil: null,
        symbol: "ES",
        totals: { bursts: 0, coveredSeconds: 0, evaluatedSeconds: 0 },
      });
      expect(document.bars.every((bar) => bar.state === "no_data")).toBe(true);
    }
  );

  it("counts a stored minute into bars with the sums and the peaks of their covered seconds", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: [minuteRow(at("15:00:00"), (second) => second)],
      })
    );
    expect(barAt(document, "15:00:00")).toEqual({
      burstSeconds: 0,
      contracts: 90,
      coveredSeconds: 10,
      peakContracts: 18,
      peakTrades: 9,
      start: at("15:00:00").toISOString(),
      state: "counted",
      trades: 45,
    });
    expect(barAt(document, "15:00:50")).toMatchObject({
      coveredSeconds: 10,
      peakTrades: 59,
      state: "counted",
      trades: 545,
    });
    expect(document.totals.coveredSeconds).toBe(60);
    expect(document.bars.filter((bar) => bar.state === "counted")).toHaveLength(
      6
    );
  });

  it("uses covered seconds only: a print of an uncovered second adds nothing, and a bar without a covered second is no_data", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        // Every second has 7 prints; only the first 5 seconds are covered.
        seconds: [
          minuteRow(at("15:00:00"), () => 7, "1".repeat(5) + "0".repeat(55)),
        ],
      })
    );
    expect(barAt(document, "15:00:00")).toMatchObject({
      coveredSeconds: 5,
      peakTrades: 7,
      state: "counted",
      trades: 35,
    });
    expect(barAt(document, "15:00:10")).toEqual({
      burstSeconds: 0,
      contracts: 0,
      coveredSeconds: 0,
      peakContracts: 0,
      peakTrades: 0,
      start: at("15:00:10").toISOString(),
      state: "no_data",
      trades: 0,
    });
  });

  it("draws a covered minute without a print as counted bars of zero", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, { seconds: [minuteRow(at("15:00:00"), () => 0)] })
    );
    expect(barAt(document, "15:00:30")).toMatchObject({
      coveredSeconds: 10,
      state: "counted",
      trades: 0,
    });
  });

  it("marks a collected minute without per-second counts as not_recorded, also the newest minute of the axis", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        minuteStarts: [at("14:30:00"), at("15:02:00"), at("15:03:00")],
        seconds: [minuteRow(at("15:02:00"))],
      })
    );
    expect(barAt(document, "14:30:00").state).toBe("not_recorded");
    expect(barAt(document, "14:30:50").state).toBe("not_recorded");
    // A minute with neither row.
    expect(barAt(document, "14:31:00").state).toBe("no_data");
    // A minute with both rows is counted.
    expect(barAt(document, "15:02:00").state).toBe("counted");
    // The newest minute: collected, and its per-second row is missing (a failed write).
    expect(barAt(document, "15:03:00").state).toBe("not_recorded");
    expect(barAt(document, "15:03:50").state).toBe("not_recorded");
    expect(document.storedUntil).toBe(at("15:03:00").toISOString());
  });

  it("takes storedUntil and the contract from the newest per-second row of the axis", () => {
    const newest = { ...minuteRow(at("14:40:00")), contract: "ESH7" };
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        // Not in minute order: the builder does not rely on the order of the rows.
        seconds: [newest, minuteRow(at("14:20:00"))],
      })
    );
    expect(document.storedUntil).toBe(at("14:41:00").toISOString());
    expect(document.contract).toBe("ESH7");
  });

  it("has no storedUntil and no contract when rows exist in the lead-in only, and ignores rows outside the read range", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: [
          minuteRow(at("13:40:00")),
          minuteRow(at("13:58:00")),
          minuteRow(at("15:04:00")),
        ],
      })
    );
    expect(document.storedUntil).toBeNull();
    expect(document.contract).toBeNull();
    expect(document.totals.coveredSeconds).toBe(0);
    expect(document.bars.every((bar) => bar.state === "no_data")).toBe(true);
  });

  it("lists a burst with its baseline and multiple and marks its bar", () => {
    const burst = epoch("14:10:05");
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: stretch("13:53:00", "14:20:00", (t) =>
          t === burst ? 500 : 10
        ),
      })
    );
    expect(document.bursts).toEqual([
      {
        baseline: 10,
        contracts: 1000,
        multiple: 50,
        peakTrades: 500,
        seconds: 1,
        start: at("14:10:05").toISOString(),
      },
    ]);
    expect(document.totals.bursts).toBe(1);
    expect(barAt(document, "14:10:00")).toMatchObject({
      burstSeconds: 1,
      peakTrades: 500,
    });
    expect(document.bars.filter((bar) => bar.burstSeconds > 0)).toHaveLength(1);
  });

  it("does not list a burst of the lead-in, and lists one that starts in the lead-in and ends on the axis", () => {
    const early = epoch("13:59:30");
    const edge = [epoch("14:02:59"), epoch("14:03:00")];
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: stretch("13:53:00", "14:10:00", (t) =>
          t === early || edge.includes(t) ? 500 : 10
        ),
      })
    );
    expect(document.bursts).toEqual([
      expect.objectContaining({
        seconds: 2,
        start: at("14:02:59").toISOString(),
      }),
    ]);
    expect(document.totals.bursts).toBe(1);
    // Only the second on the axis counts in the first bar.
    expect(barAt(document, "14:03:00").burstSeconds).toBe(1);
  });

  it("gives one second the same verdict in the 60-minute and in the 390-minute window", () => {
    const burst = epoch("14:30:07");
    const seconds = stretch("08:23:00", "15:04:00", (t) =>
      t === burst ? 85 : 10
    );
    const short = buildFlowTapeSpeed(rowsFor(60, { seconds }));
    const long = buildFlowTapeSpeed(rowsFor(390, { seconds }));
    expect(short.bursts).toEqual(long.bursts);
    expect(short.bursts).toEqual([
      expect.objectContaining({
        baseline: 10,
        multiple: 8.5,
        start: at("14:30:07").toISOString(),
      }),
    ]);
    expect(barAt(short, "14:30:00").burstSeconds).toBe(1);
    expect(barAt(long, "14:30:00").burstSeconds).toBe(1);
    // Every covered second of both axes has its 600 seconds of baseline.
    expect(short.totals.evaluatedSeconds).toBe(short.totals.coveredSeconds);
    expect(long.totals).toEqual({
      bursts: 1,
      coveredSeconds: 391 * 60,
      evaluatedSeconds: 391 * 60,
    });
  });

  it("lists the newest 50 of 60 bursts, oldest first, and counts all 60", () => {
    const first = epoch("14:10:00");
    const starts = Array.from({ length: 60 }, (_, index) => first + index * 30);
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: stretch("13:53:00", "14:45:00", (t) =>
          starts.includes(t) ? 500 : 10
        ),
      })
    );
    expect(document.totals.bursts).toBe(60);
    expect(document.bursts).toHaveLength(50);
    expect(document.bursts[0]?.start).toBe(
      new Date((first + 10 * 30) * 1000).toISOString()
    );
    expect(document.bursts.at(-1)?.start).toBe(
      new Date((first + 59 * 30) * 1000).toISOString()
    );
    expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
  });

  it("gives a burst after a covered stretch without a trade a null multiple", () => {
    const burst = epoch("14:10:00");
    const document = buildFlowTapeSpeed(
      rowsFor(60, {
        seconds: stretch("13:53:00", "14:11:00", (t) => (t === burst ? 20 : 0)),
      })
    );
    expect(document.bursts).toEqual([
      expect.objectContaining({ baseline: 0, multiple: null, peakTrades: 20 }),
    ]);
  });

  it("counts covered seconds that the rule could not evaluate: no row in the lead-in", () => {
    const document = buildFlowTapeSpeed(
      rowsFor(60, { seconds: stretch("14:03:00", "14:13:00") })
    );
    expect(document.totals).toEqual({
      bursts: 0,
      coveredSeconds: 600,
      evaluatedSeconds: 300,
    });
  });

  describe("tape freshness", () => {
    const sample = (
      secondsAgo: number,
      now: Date,
      overrides: Partial<FlowSampleRow> = {}
    ): FlowSampleRow => ({
      at: new Date(now.getTime() - secondsAgo * 1000),
      items: 2,
      message: "streamed tape ESZ6: 2 prints",
      source: "ticks",
      status: "ok",
      symbol: "ES",
      ...overrides,
    });
    const tapeOf = (
      now: Date,
      latest: FlowSampleRow[],
      latestOk: FlowSampleRow[]
    ) => buildFlowTapeSpeed(rowsFor(60, { latest, latestOk, now })).tape;

    it("is fresh up to 180 s after the last ok sample and stale after it", () => {
      const fresh = sample(180, NOW);
      expect(tapeOf(NOW, [fresh], [fresh])).toEqual({
        ageSeconds: 180,
        lastOkAt: fresh.at.toISOString(),
        lastStatus: "ok",
        message: "streamed tape ESZ6: 2 prints",
        sessionOpen: true,
        source: "ticks",
        state: "fresh",
      });
      const old = sample(181, NOW);
      const failed = sample(10, NOW, {
        message: "tape stream down: connection closed",
        status: "unavailable",
      });
      expect(tapeOf(NOW, [failed], [old])).toMatchObject({
        ageSeconds: 181,
        lastStatus: "unavailable",
        message: "tape stream down: connection closed",
        state: "stale",
      });
    });

    it("is closed outside the Globex session and never without an ok sample", () => {
      const saturday = new Date("2026-11-07T16:00:00.000Z");
      const friday = sample(23 * 3600, saturday);
      expect(tapeOf(saturday, [friday], [friday])).toMatchObject({
        sessionOpen: false,
        state: "closed",
      });
      expect(tapeOf(NOW, [], [])).toEqual({
        ageSeconds: null,
        lastOkAt: null,
        lastStatus: null,
        message: null,
        sessionOpen: true,
        source: "ticks",
        state: "never",
      });
    });

    it("reads the ticks samples only", () => {
      const depth = sample(5, NOW, { source: "depth" });
      expect(tapeOf(NOW, [depth], [depth]).state).toBe("never");
    });
  });
});
