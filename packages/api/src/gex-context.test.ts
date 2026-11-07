import { describe, expect, it } from "vitest";

import type {
  ExposureSection,
  FlowEvent,
  GexContextFactor,
} from "./contracts/options-analytics.ts";
import { GexContextSchema } from "./contracts/options-analytics.ts";
import { blackScholes } from "./options-chain-greeks.ts";
import {
  buildGexContext,
  callGreeks,
  dealerTotals,
  flowContext,
  gexFlip,
  gexWalls,
  type GexContextInput,
  ivContext,
  marketSession,
  nextMonthlyOpex,
} from "./server/gex-context.ts";
import {
  blackScholesGamma,
  type ChainRow,
  exposure,
  type GammaModel,
  type OpenInterestRow,
  termStructure,
} from "./server/options-analytics-engine.ts";

// Dummy data only: a fictional symbol around spot 100.
const TODAY = "2026-11-06";
// Friday 2026-11-06 14:45 New York (EST, UTC-5).
const PM = new Date("2026-11-06T19:45:00.000Z");
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120] as const;

const chainFor = (
  expiries: readonly (readonly [string, number])[],
  skewed = true
): ChainRow[] =>
  expiries.flatMap(([expiry, iv]) =>
    STRIKES.flatMap((strike) => {
      const wing = Math.abs(strike - 100);
      return [
        {
          delta: 0.5,
          expiry,
          iv: iv + (skewed ? wing * 0.002 : 0),
          right: "call" as const,
          strike,
        },
        {
          delta: -0.5,
          expiry,
          iv: iv + (skewed ? wing * 0.003 : 0),
          right: "put" as const,
          strike,
        },
      ];
    })
  );

const CHAIN = chainFor([
  ["2026-11-06", 0.3],
  ["2026-11-09", 0.28],
  ["2026-11-20", 0.25],
  ["2026-12-18", 0.24],
]);

const OI: readonly OpenInterestRow[] = STRIKES.map((strike) => ({
  callOpenInterest: strike >= 100 ? 5000 + (strike === 110 ? 20_000 : 0) : 1000,
  putOpenInterest: strike <= 100 ? 4000 + (strike === 90 ? 25_000 : 0) : 800,
  strike,
}));

const section = (
  oi: readonly OpenInterestRow[],
  chain: readonly ChainRow[],
  spot: number | null
): ExposureSection => ({
  ...exposure(oi, chain, spot, TODAY),
  message: null,
  status: "ok",
});

const event = (overrides: Partial<FlowEvent>): FlowEvent => ({
  contract: "DUMMY 2026-11-06 105C",
  expiry: "2026-11-06",
  flowType: null,
  premium: 100_000,
  right: "call",
  sentiment: "bullish",
  size: 10,
  strike: 105,
  time: "2026-11-06T19:40:00.000Z",
  unusual: false,
  ...overrides,
});

const input = (overrides: Partial<GexContextInput> = {}): GexContextInput => ({
  chain: CHAIN,
  events: [
    event({ premium: 500_000 }),
    event({
      expiry: "2026-11-20",
      premium: -200_000,
      right: "put",
      sentiment: "bearish",
      time: "2026-11-06T19:00:00.000Z",
    }),
  ],
  exposure: section(OI, CHAIN, 101),
  flowHours: 24,
  flowOk: true,
  now: PM,
  spot: 101,
  term: termStructure(CHAIN, 101, TODAY),
  ...overrides,
});

const factor = (
  factors: readonly GexContextFactor[],
  key: GexContextFactor["key"]
): GexContextFactor => {
  const found = factors.find((item) => item.key === key);
  if (found === undefined) throw new Error(`missing factor ${key}`);
  return found;
};

const model = (iv: number | null, years = 10 / 365): GammaModel => ({
  atmIv: iv,
  expiry: "2026-11-16",
  ivAt: () => iv,
  years,
});

describe("dealer Greeks", () => {
  it("matches the Black-Scholes delta and gamma used elsewhere", () => {
    const greeks = callGreeks(100, 105, 0.3, 0.1);
    const reference = blackScholes({
      dividendYield: 0,
      rate: 0,
      right: "call",
      spot: 100,
      strike: 105,
      volatility: 0.3,
      years: 0.1,
    });
    expect(greeks.delta).toBeCloseTo(reference?.delta ?? Number.NaN, 6);
    expect(greeks.gamma).toBeCloseTo(blackScholesGamma(100, 105, 0.3, 0.1), 10);
    // OTM call: delta falls as time passes (negative charm) and rises with IV (positive vanna).
    expect(greeks.charm).toBeLessThan(0);
    return expect(greeks.vanna).toBeGreaterThan(0);
  });

  it("totals dealer exposure and skips strikes without IV", () => {
    const strikes = [
      { callOpenInterest: 10, gex: null, putOpenInterest: 0, strike: 100 },
    ];
    expect(dealerTotals(strikes, model(null), 100)).toBeNull();
    const totals = dealerTotals(strikes, model(0.3), 100);
    // Ten long ATM calls: dealer delta near +0.5 x 10 x 100 x $100.
    expect(totals?.dex).toBeGreaterThan(45_000);
    return expect(totals?.gex).toBeGreaterThan(0);
  });

  it("finds the GEX flip nearest spot, or none", () => {
    const strikes = [
      { callOpenInterest: 0, gex: null, putOpenInterest: 1000, strike: 90 },
      { callOpenInterest: 1000, gex: null, putOpenInterest: 0, strike: 110 },
    ];
    const flip = gexFlip(strikes, model(0.3), 100);
    expect(flip).toBeGreaterThan(95);
    expect(flip).toBeLessThan(105);
    const onlyCalls = [strikes[1] ?? strikes[0]].filter(
      (row) => row !== undefined
    );
    expect(gexFlip(onlyCalls, model(0.3), 100)).toBeNull();
    return expect(gexFlip(strikes, model(null), 100)).toBeNull();
  });

  it("picks the largest positive and most negative GEX strikes as walls", () => {
    const row = (strike: number, gex: number | null) => ({
      callOpenInterest: 1,
      gex,
      putOpenInterest: 1,
      strike,
    });
    expect(
      gexWalls([
        row(90, -5),
        row(95, -9),
        row(100, null),
        row(105, 3),
        row(110, 7),
        row(115, 2),
        row(120, -1),
      ])
    ).toEqual({ callWall: 110, putWall: 95 });
    return expect(gexWalls([row(100, null)])).toEqual({
      callWall: null,
      putWall: null,
    });
  });
});

describe("flow, IV, session and calendar context", () => {
  it("reads who is paying premium and the expiry share of flow", () => {
    expect(flowContext([], TODAY)).toEqual({
      bearishPremium: 0,
      bias: "unknown",
      bullishPremium: 0,
      newestTradeAt: null,
      weekShare: null,
      zeroDteShare: null,
    });
    const bullish = flowContext(
      [
        event({ premium: 300 }),
        event({ expiry: "2026-11-12", premium: 100, sentiment: "neutral" }),
        event({ expiry: "2026-12-18", premium: 100, sentiment: "bearish" }),
      ],
      TODAY
    );
    expect(bullish).toMatchObject({
      bias: "bullish",
      newestTradeAt: "2026-11-06T19:40:00.000Z",
      weekShare: 0.8,
      zeroDteShare: 0.6,
    });
    expect(
      flowContext([event({ premium: 100, sentiment: "bearish" })], TODAY).bias
    ).toBe("bearish");
    return expect(
      flowContext(
        [event({ premium: 100 }), event({ premium: 90, sentiment: "bearish" })],
        TODAY
      ).bias
    ).toBe("balanced");
  });

  it("classifies the IV term structure from front and back ATM IV", () => {
    const point = (dte: number, atmIv: number) => ({
      atmIv,
      dte,
      expiry: `2026-12-${String(dte).padStart(2, "0")}`,
    });
    expect(ivContext([])).toEqual({
      backIv: null,
      frontIv: null,
      regime: "unknown",
    });
    expect(ivContext([point(0, 0.5), point(3, 0.3)])).toEqual({
      backIv: null,
      frontIv: 0.3,
      regime: "unknown",
    });
    expect(ivContext([point(3, 0.3), point(10, 0.3)]).regime).toBe("flat");
    expect(ivContext([point(3, 0.4), point(28, 0.3)])).toEqual({
      backIv: 0.3,
      frontIv: 0.4,
      regime: "inverted",
    });
    return expect(ivContext([point(3, 0.2), point(28, 0.3)]).regime).toBe(
      "contango"
    );
  });

  it("names the New York session, closed on weekends and at night", () => {
    const at = (iso: string) => marketSession(new Date(iso));
    // EST dates (UTC-5).
    expect(at("2026-11-07T15:00:00.000Z")).toBe("closed");
    expect(at("2026-11-08T15:00:00.000Z")).toBe("closed");
    expect(at("2026-11-06T08:00:00.000Z")).toBe("closed");
    expect(at("2026-11-06T13:00:00.000Z")).toBe("premarket");
    expect(at("2026-11-06T15:00:00.000Z")).toBe("morning");
    expect(at("2026-11-06T18:00:00.000Z")).toBe("midday");
    expect(at("2026-11-06T20:00:00.000Z")).toBe("afternoon");
    expect(at("2026-11-06T22:00:00.000Z")).toBe("afterhours");
    return expect(at("2026-11-07T02:00:00.000Z")).toBe("closed");
  });

  it("finds the next monthly OpEx (third Friday)", () => {
    expect(nextMonthlyOpex("2026-11-06")).toBe("2026-11-20");
    expect(nextMonthlyOpex("2026-11-20")).toBe("2026-11-20");
    expect(nextMonthlyOpex("2026-11-21")).toBe("2026-12-18");
    return expect(nextMonthlyOpex("2026-12-30")).toBe("2027-01-15");
  });
});

describe("buildGexContext", () => {
  it("builds every factor with levels in day-moves and a valid schema", () => {
    const context = buildGexContext(input());
    expect(GexContextSchema.parse(context)).toEqual(context);
    expect(context.factors.map((item) => item.key)).toEqual([
      "dealerSign",
      "regime",
      "freshness",
      "expiryMix",
      "levels",
      "flow",
      "dex",
      "charm",
      "vanna",
      "ivRegime",
      "events",
    ]);
    expect(context).toMatchObject({
      dealerSignAssumption: "dealers long calls, short puts",
      expiry: {
        monthlyOpexDays: 14,
        nextExpiry: "2026-11-06",
        nextExpiryDte: 0,
        nextMonthlyOpex: "2026-11-20",
      },
      flow: { bias: "bullish" },
      iv: { backIv: 0.24, frontIv: 0.28, regime: "inverted" },
      regime: "positive",
      session: "afternoon",
    });
    expect(context.levels.dailyMove).toBeCloseTo((101 * 0.28) / Math.sqrt(252));
    expect(context.levels.flip).not.toBeNull();
    expect(context.levels.callWall).toBe(105);
    expect(context.levels.putWall).toBe(95);
    const { factors } = context;
    expect(factor(factors, "regime").value).toBe(
      "Positive GEX, not a range promise"
    );
    expect(factor(factors, "freshness").value).toBe(
      "OI prior session · newest trade 5 min ago"
    );
    expect(factor(factors, "expiryMix")).toMatchObject({
      tone: "caution",
      value: "0DTE today: levels roll off at close",
    });
    expect(factor(factors, "expiryMix").detail).toContain("71% 0DTE");
    expect(factor(factors, "levels")).toMatchObject({
      tone: "neutral",
      value:
        "flip -1.3 day-moves · call wall +2.2 day-moves · put wall -3.4 day-moves",
    });
    expect(factor(factors, "flow")).toMatchObject({
      tone: "neutral",
      value: "Bulls +$300K net",
    });
    expect(factor(factors, "dex").value).toMatch(/^\+\$\d+\.\dM$/u);
    expect(factor(factors, "charm")).toMatchObject({
      label: "Charm · PM session",
      tone: "caution",
    });
    expect(factor(factors, "vanna")).toMatchObject({ tone: "caution" });
    expect(factor(factors, "vanna").value).toContain("hedge selling");
    expect(factor(factors, "ivRegime")).toMatchObject({
      tone: "caution",
      value: "Inverted 28% vs 24%",
    });
    return expect(factor(factors, "events")).toMatchObject({
      tone: "neutral",
      value: "Monthly OpEx in 14d (11-20)",
    });
  });

  it("says unknown instead of guessing when inputs are missing", () => {
    const empty = buildGexContext(
      input({
        chain: [],
        events: [],
        exposure: section([], [], null),
        flowOk: false,
        spot: null,
        term: [],
      })
    );
    expect(empty).toMatchObject({
      greeks: { netCharm: null, netDex: null, netVanna: null },
      levels: { callWall: null, dailyMove: null, flip: null, putWall: null },
      regime: "unknown",
    });
    const values = Object.fromEntries(
      empty.factors.map((item) => [item.key, [item.value, item.tone]])
    );
    expect(values).toMatchObject({
      charm: ["n/a", "neutral"],
      dex: ["n/a", "neutral"],
      expiryMix: ["No listed expiry", "neutral"],
      flow: ["Unknown", "alert"],
      freshness: ["OI prior session · no recent trades", "caution"],
      ivRegime: ["Unknown", "alert"],
      levels: ["No flip or walls", "neutral"],
      regime: ["Unknown", "alert"],
      vanna: ["n/a", "neutral"],
    });
    expect(factor(empty.factors, "expiryMix").detail).toContain("n/a 0DTE");
    // Flow fetched but nothing signed is still unknown.
    const neutralOnly = buildGexContext(
      input({ events: [event({ sentiment: "neutral" })] })
    );
    expect(factor(neutralOnly.factors, "flow").value).toBe("Unknown");
    // A chain without IV: OI shown, but no dealer numbers.
    const noIv = CHAIN.map((row) => ({ ...row, iv: null }));
    const blind = buildGexContext(
      input({ chain: noIv, exposure: section(OI, noIv, 101) })
    );
    expect(blind.greeks.netDex).toBeNull();
    return expect(
      buildGexContext(input({ spot: 0 })).levels.dailyMove
    ).toBeNull();
  });

  it("flags flow that fights the regime and a negative regime", () => {
    const putHeavy = OI.map((row) => ({
      ...row,
      putOpenInterest: row.putOpenInterest * 20,
    }));
    const negative = buildGexContext(
      input({
        events: [event({ premium: 400 })],
        exposure: section(putHeavy, CHAIN, 101),
      })
    );
    expect(negative.regime).toBe("negative");
    expect(factor(negative.factors, "regime").value).toBe(
      "Negative GEX, not a dump promise"
    );
    expect(factor(negative.factors, "flow")).toMatchObject({
      tone: "caution",
      value: "Bulls +$400 net",
    });
    const positiveBears = buildGexContext(
      input({
        events: [event({ premium: 2_500_000_000, sentiment: "bearish" })],
      })
    );
    expect(factor(positiveBears.factors, "flow")).toMatchObject({
      tone: "caution",
      value: "Bears -$2.5B net",
    });
    const balanced = buildGexContext(
      input({
        events: [
          event({ premium: 5000 }),
          event({ premium: 4500, sentiment: "bearish" }),
        ],
      })
    );
    return expect(factor(balanced.factors, "flow").value).toBe(
      "Balanced +$500 net"
    );
  });

  it("reads quiet sessions, near walls, flat hedging and OpEx day", () => {
    // Equal call and put OI with equal IVs: vanna and charm cancel to exactly zero.
    const flatChain = chainFor(
      [
        ["2026-11-23", 0.25],
        ["2026-12-18", 0.25],
      ],
      false
    );
    const flatOi = [
      { callOpenInterest: 100, putOpenInterest: 100, strike: 150 },
    ];
    const quiet = buildGexContext(
      input({
        chain: flatChain,
        events: [],
        exposure: section(flatOi, flatChain, 100),
        now: new Date("2026-11-20T15:00:00.000Z"),
        spot: 100,
        term: termStructure(flatChain, 100, "2026-11-20"),
      })
    );
    const values = Object.fromEntries(
      quiet.factors.map((item) => [item.key, [item.value, item.tone]])
    );
    expect(values).toMatchObject({
      charm: ["+$0/day, flat", "neutral"],
      events: ["Monthly OpEx today", "caution"],
      expiryMix: ["Next expiry in 3d", "neutral"],
      ivRegime: ["Flat 25% vs 25%", "neutral"],
      vanna: ["+$0 per IV pt, flat", "neutral"],
    });
    expect(quiet.session).toBe("morning");
    expect(factor(quiet.factors, "levels")).toMatchObject({
      tone: "neutral",
      value: "No flip or walls",
    });
    // Contango and a large dealer book in billions.
    const big = OI.map((row) => ({
      ...row,
      callOpenInterest: row.callOpenInterest * 1000,
    }));
    const contango = chainFor([
      ["2026-11-09", 0.2],
      ["2026-12-18", 0.3],
    ]);
    const large = buildGexContext(
      input({
        chain: contango,
        exposure: section(big, contango, 101),
        term: termStructure(contango, 101, TODAY),
      })
    );
    expect(factor(large.factors, "ivRegime").value).toBe("Contango 20% vs 30%");
    expect(factor(large.factors, "dex").value).toMatch(/B$/u);
    // A wall within one day-move is in play today.
    expect(factor(large.factors, "levels")).toMatchObject({
      tone: "caution",
      value: "call wall -0.8 day-moves · put wall -16.5 day-moves",
    });
    return expect(factor(large.factors, "vanna").tone).toBe("neutral");
  });
});
