import { describe, expect, it } from "vitest";
import {
  FLOW_HEDGING_MAX_POINTS,
  FLOW_HEDGING_SYMBOLS,
  FLOW_SYMBOLS,
  type FlowHedgingPressure,
  FlowHedgingPressureInputSchema,
  FlowHedgingPressureSchema,
  flowContract,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

const point: FlowHedgingPressure["points"][number] = {
  calls: 2_000_000,
  minute: "2026-11-20T14:30:00.000Z",
  minuteNet: 1_200_000,
  net: 1_200_000,
  price: 661.2,
  prints: 3,
  puts: -800_000,
};
const response: FlowHedgingPressure = {
  options: {
    ageSeconds: 42,
    lastOkAt: "2026-11-20T14:31:05.000Z",
    lastStatus: "ok",
    message: "quantdata flow: 12 prints",
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  points: [point],
  rules: {
    dividendYield: 0.015,
    rate: 0.04,
    version: "hedging-pressure.v1",
    volFallback: 0.2,
  },
  schemaVersion: "flow-hedging-pressure.v1",
  session: "2026-11-20",
  storedUntil: "2026-11-20T14:30:41.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    calls: 2_000_000,
    gross: 2_800_000,
    ivAdjusted: 0,
    largestFall: null,
    largestRise: { minute: point.minute, minuteNet: 1_200_000 },
    net: 1_200_000,
    notPriced: 0,
    notSigned: 1,
    prints: 4,
    puts: -800_000,
    signed: 3,
  },
  truncated: false,
  unread: {
    from: "2026-11-20T15:00:00.000Z",
    ranges: 1,
    to: "2026-11-20T15:20:00.000Z",
  },
};
const accepts = (value: unknown): boolean =>
  FlowHedgingPressureSchema.safeParse(value).success;

describe("flow.hedgingPressure input", () => {
  it("takes SPY and ES", () => {
    expect(FlowHedgingPressureInputSchema.parse({ symbol: "SPY" })).toEqual({
      symbol: "SPY",
    });
    expect(FlowHedgingPressureInputSchema.parse({ symbol: "ES" })).toEqual({
      symbol: "ES",
    });
  });

  it.each([
    [{ symbol: "QQQ" }],
    [{ symbol: "NQ" }],
    [{ minutes: 120, symbol: "SPY" }],
    [{}],
  ])("refuses %j", (input) => {
    expect(FlowHedgingPressureInputSchema.safeParse(input).success).toBe(false);
  });

  it("stays scoped to SPY and ES, which collect option prints", () => {
    expect(FLOW_HEDGING_SYMBOLS).toEqual(["SPY", "ES"]);
    for (const symbol of FLOW_HEDGING_SYMBOLS) {
      expect(FLOW_SYMBOLS).toContain(symbol);
      expect(FLOW_INSTRUMENTS[symbol].sources).toContain("options");
    }
  });
});

describe("flow-hedging-pressure.v1", () => {
  it("accepts a full response, and the empty response of a symbol without prints", () => {
    expect(accepts(response)).toBe(true);
    expect(
      accepts({
        ...response,
        points: [],
        session: null,
        storedUntil: null,
        totals: {
          ...response.totals,
          largestRise: null,
          net: 0,
        },
        unread: null,
      })
    ).toBe(true);
    expect(accepts({ ...response, points: [{ ...point, price: null }] })).toBe(
      true
    );
  });

  it("refuses an unknown key at every level", () => {
    expect(accepts({ ...response, generatedAt: point.minute })).toBe(false);
    expect(accepts({ ...response, points: [{ ...point, gamma: 1 }] })).toBe(
      false
    );
    expect(
      accepts({ ...response, totals: { ...response.totals, trades: 1 } })
    ).toBe(false);
    expect(
      accepts({ ...response, rules: { ...response.rules, window: 600 } })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        unread: { ...response.unread, oldest: point.minute },
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        totals: {
          ...response.totals,
          largestRise: { minute: point.minute, minuteNet: 1, prints: 1 },
        },
      })
    ).toBe(false);
    expect(
      accepts({ ...response, options: { ...response.options, extra: 1 } })
    ).toBe(false);
  });

  it("refuses another version, another symbol, a bad date, a negative count and a non-finite sum", () => {
    expect(
      accepts({ ...response, schemaVersion: "flow-hedging-pressure.v2" })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, version: "hedging-pressure.v2" },
      })
    ).toBe(false);
    expect(accepts({ ...response, symbol: "QQQ" })).toBe(false);
    expect(accepts({ ...response, ticker: "ES" })).toBe(false);
    expect(accepts({ ...response, session: "20 Nov 2026" })).toBe(false);
    expect(
      accepts({ ...response, totals: { ...response.totals, prints: -1 } })
    ).toBe(false);
    expect(
      accepts({ ...response, totals: { ...response.totals, gross: -1 } })
    ).toBe(false);
    expect(
      accepts({ ...response, points: [{ ...point, net: Number.NaN }] })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, volFallback: 0 },
      })
    ).toBe(false);
  });

  it("holds at most 405 points", () => {
    expect(FLOW_HEDGING_MAX_POINTS).toBe(405);
    const points = (count: number) => new Array(count).fill(point);
    expect(accepts({ ...response, points: points(405) })).toBe(true);
    expect(accepts({ ...response, points: points(406) })).toBe(false);
  });

  it("exposes flow.hedgingPressure as GET /flow/hedging-pressure", () => {
    const route = (
      flowContract.hedgingPressure as unknown as {
        "~orpc": {
          route: { method: string; path: string; operationId: string };
        };
      }
    )["~orpc"].route;
    expect(route).toMatchObject({
      method: "GET",
      operationId: "flow.hedgingPressure",
      path: "/flow/hedging-pressure",
    });
  });
});
