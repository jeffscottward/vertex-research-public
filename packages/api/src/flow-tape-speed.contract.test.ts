import { describe, expect, it } from "vitest";
import {
  FLOW_TAPE_SPEED_BAR_STATES,
  FLOW_TAPE_SPEED_MAX_BARS,
  FLOW_TAPE_SPEED_MAX_BURSTS,
  FLOW_TAPE_SYMBOLS,
  type FlowTapeSpeed,
  FlowTapeSpeedInputSchema,
  FlowTapeSpeedSchema,
  flowContract,
} from "./contracts/flow.ts";

const bar: FlowTapeSpeed["bars"][number] = {
  burstSeconds: 1,
  contracts: 940,
  coveredSeconds: 20,
  peakContracts: 310,
  peakTrades: 120,
  start: "2026-11-09T15:00:00.000Z",
  state: "counted",
  trades: 410,
};
const burst: FlowTapeSpeed["bursts"][number] = {
  baseline: 12.5,
  contracts: 310,
  multiple: 9.6,
  peakTrades: 120,
  seconds: 1,
  start: "2026-11-09T15:00:07.000Z",
};
const document: FlowTapeSpeed = {
  axisStart: "2026-11-09T13:00:00.000Z",
  bars: [bar],
  bucketSeconds: 20,
  bursts: [burst],
  contract: "ESZ6",
  rules: {
    baselineSeconds: 600,
    floorTrades: 20,
    minBaselineCoveredSeconds: 300,
    multiple: 8,
    version: "flow-tape-speed-rules.v1",
  },
  schemaVersion: "flow-tape-speed.v1",
  storedUntil: "2026-11-09T15:01:00.000Z",
  symbol: "ES",
  tape: {
    ageSeconds: 42,
    lastOkAt: "2026-11-09T15:01:05.000Z",
    lastStatus: "ok",
    message: "streamed tape ESZ6: 2 prints",
    sessionOpen: true,
    source: "ticks",
    state: "fresh",
  },
  totals: { bursts: 1, coveredSeconds: 20, evaluatedSeconds: 20 },
};
const accepts = (value: unknown): boolean =>
  FlowTapeSpeedSchema.safeParse(value).success;

describe("flow.tapeSpeed input", () => {
  it("takes the two symbols with a streamed tape and the window of flow.snapshot", () => {
    expect(FLOW_TAPE_SYMBOLS).toEqual(["ES", "NQ"]);
    expect(FlowTapeSpeedInputSchema.parse({ symbol: "NQ" })).toEqual({
      minutes: 120,
      symbol: "NQ",
    });
    // A GET request sends the minutes as text.
    expect(
      FlowTapeSpeedInputSchema.parse({ minutes: "390", symbol: "ES" })
    ).toEqual({ minutes: 390, symbol: "ES" });
    expect(
      FlowTapeSpeedInputSchema.safeParse({ minutes: 15, symbol: "ES" }).success
    ).toBe(true);
  });

  it.each([
    [{ symbol: "SPY" }],
    [{ symbol: "QQQ" }],
    [{ minutes: 14, symbol: "ES" }],
    [{ minutes: 391, symbol: "ES" }],
    [{ minutes: 60.5, symbol: "ES" }],
    [{ group: "sp500", symbol: "ES" }],
    [{}],
  ])("refuses %j", (input) => {
    expect(FlowTapeSpeedInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("flow-tape-speed.v1", () => {
  it("accepts a full document, and null for the contract, storedUntil and a multiple", () => {
    expect(accepts(document)).toBe(true);
    expect(
      accepts({
        ...document,
        bursts: [{ ...burst, multiple: null }],
        contract: null,
        storedUntil: null,
      })
    ).toBe(true);
  });

  it("has three bar states in priority order", () => {
    expect(FLOW_TAPE_SPEED_BAR_STATES).toEqual([
      "counted",
      "not_recorded",
      "no_data",
    ]);
    for (const state of FLOW_TAPE_SPEED_BAR_STATES)
      expect(accepts({ ...document, bars: [{ ...bar, state }] })).toBe(true);
    expect(
      accepts({ ...document, bars: [{ ...bar, state: "not_collected" }] })
    ).toBe(false);
  });

  it("refuses an unknown key at every level", () => {
    expect(accepts({ ...document, generatedAt: document.axisStart })).toBe(
      false
    );
    expect(
      accepts({ ...document, bars: [{ ...bar, provisional: true }] })
    ).toBe(false);
    expect(
      accepts({ ...document, bursts: [{ ...burst, provisional: true }] })
    ).toBe(false);
    expect(
      accepts({ ...document, totals: { ...document.totals, trades: 1 } })
    ).toBe(false);
    expect(
      accepts({ ...document, rules: { ...document.rules, window: 600 } })
    ).toBe(false);
    expect(accepts({ ...document, tape: { ...document.tape, extra: 1 } })).toBe(
      false
    );
  });

  it("refuses another version, another symbol, a negative count and a multiple of 0 in the rules", () => {
    expect(accepts({ ...document, schemaVersion: "flow-tape-speed.v2" })).toBe(
      false
    );
    expect(accepts({ ...document, symbol: "SPY" })).toBe(false);
    expect(accepts({ ...document, bars: [{ ...bar, trades: -1 }] })).toBe(
      false
    );
    expect(accepts({ ...document, bars: [{ ...bar, trades: 1.5 }] })).toBe(
      false
    );
    expect(
      accepts({ ...document, rules: { ...document.rules, multiple: 0 } })
    ).toBe(false);
    expect(accepts({ ...document, contract: "E".repeat(21) })).toBe(false);
  });

  it("holds at most 391 bars and 50 bursts", () => {
    expect(FLOW_TAPE_SPEED_MAX_BARS).toBe(391);
    expect(FLOW_TAPE_SPEED_MAX_BURSTS).toBe(50);
    const bars = (count: number) => new Array(count).fill(bar);
    const bursts = (count: number) => new Array(count).fill(burst);
    expect(accepts({ ...document, bars: bars(391), bursts: bursts(50) })).toBe(
      true
    );
    expect(accepts({ ...document, bars: bars(392) })).toBe(false);
    expect(accepts({ ...document, bursts: bursts(51) })).toBe(false);
  });

  it("exposes flow.tapeSpeed as GET /flow/tape-speed, next to the other flow procedures", () => {
    const route = (
      flowContract.tapeSpeed as unknown as {
        "~orpc": {
          route: { method: string; path: string; operationId: string };
        };
      }
    )["~orpc"].route;
    expect(route).toMatchObject({
      method: "GET",
      operationId: "flow.tapeSpeed",
      path: "/flow/tape-speed",
    });
    expect(Object.keys(flowContract).sort()).toEqual([
      "collect",
      "control",
      "events",
      "hedgingPressure",
      "liquidityHeatmap",
      "optionBubbles",
      "putCallRatio",
      "snapshot",
      "strikeHeatmap",
      "tapeSpeed",
    ]);
  });
});
