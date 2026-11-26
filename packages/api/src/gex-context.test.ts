import { describe, expect, it } from "vitest";

import type {
  FlowEvent,
  GexContextFactor,
} from "./contracts/options-analytics.ts";
import { GexContextSchema } from "./contracts/options-analytics.ts";
import { blackScholes } from "./options-chain-greeks.ts";
import {
  buildGexContext,
  callGreeks,
  dealerTotals,
  flipFromProfile,
  flowContext,
  type GexContextInput,
  gexFlip,
  gexProfile,
  gexWalls,
  greeksMissingCause,
  ivContext,
  marketSession,
  newYorkDate,
  nextMonthlyOpex,
} from "./server/gex-context.ts";
import {
  blackScholesGamma,
  type ChainRow,
  exposure,
  type GammaModel,
  gammaModel,
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
): Pick<GexContextInput, "strikes" | "totalGex"> => {
  const estimate = exposure(oi, chain, spot, TODAY);
  return { strikes: estimate.strikes, totalGex: estimate.section.totalGex };
};

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
  ...section(OI, CHAIN, 101),
  fetchedAt: null,
  flowHours: 24,
  flowOk: true,
  flowPartial: false,
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
    expect(greeks.vanna).toBeGreaterThan(0);
    // Finite differences: vanna = d(delta)/d(IV), charm = -d(delta)/d(years).
    const step = 1e-5;
    const deltaAt = (iv: number, years: number) =>
      callGreeks(100, 105, iv, years).delta;
    expect(greeks.vanna).toBeCloseTo(
      (deltaAt(0.3 + step, 0.1) - deltaAt(0.3 - step, 0.1)) / (2 * step),
      4
    );
    return expect(greeks.charm).toBeCloseTo(
      -(deltaAt(0.3, 0.1 + step) - deltaAt(0.3, 0.1 - step)) / (2 * step),
      4
    );
  });

  it("totals dealer exposure and skips strikes without IV", () => {
    const strikes = [
      { callOpenInterest: 10, gex: null, putOpenInterest: 0, strike: 100 },
    ];
    expect(dealerTotals(strikes, model(null), 100)).toBeNull();
    const totals = dealerTotals(strikes, model(0.3), 100);
    // Ten ATM calls: open-interest delta near +0.5 x 10 x 100 x $100.
    expect(totals?.dex).toBeGreaterThan(45_000);
    expect(totals?.gex).toBeGreaterThan(0);
    // Ten ATM puts: holders are short delta, and dealers (short the puts) hold -gamma.
    const puts = dealerTotals(
      [{ callOpenInterest: 0, gex: null, putOpenInterest: 10, strike: 100 }],
      model(0.3),
      100
    );
    expect(puts?.dex).toBeLessThan(-45_000);
    return expect(puts?.gex).toBeLessThan(0);
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

  it("sweeps GEX over +/-30% spot in 121 steps and brackets the flip", () => {
    const strikes = [
      { callOpenInterest: 0, gex: null, putOpenInterest: 1000, strike: 90 },
      { callOpenInterest: 1000, gex: null, putOpenInterest: 0, strike: 110 },
    ];
    const profile = gexProfile(strikes, model(0.3), 100);
    expect(profile).toHaveLength(121);
    expect(profile[0]?.spot).toBeCloseTo(70, 6);
    expect(profile[60]?.spot).toBeCloseTo(100, 6);
    expect(profile[120]?.spot).toBeCloseTo(130, 6);
    const flip = gexFlip(strikes, model(0.3), 100);
    expect(flip).not.toBeNull();
    const bracketIndex = profile.findIndex(
      (point, index) =>
        index + 1 < profile.length &&
        point.spot <= (flip ?? 0) &&
        (profile[index + 1]?.spot ?? 0) >= (flip ?? 0)
    );
    expect(bracketIndex).toBeGreaterThanOrEqual(0);
    const left = profile[bracketIndex];
    const right = profile[bracketIndex + 1];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect((left?.gex ?? 0) * (right?.gex ?? 0)).toBeLessThan(0);
    // Short-DTE call-only chain whose far-left Black-Scholes tail underflows to 0 must not
    // fabricate a zero-gamma crossing.
    const shortDteModel: GammaModel = {
      atmIv: 0.15,
      expiry: "2026-10-23",
      ivAt: () => 0.15,
      years: 1 / 365,
    };
    const callOnly = [
      { callOpenInterest: 1000, gex: null, putOpenInterest: 0, strike: 110 },
    ];
    const callProfile = gexProfile(callOnly, shortDteModel, 100);
    expect(callProfile.some((point) => point.gex === 0)).toBe(true);
    expect(gexFlip(callOnly, shortDteModel, 100)).toBeNull();
    // Touching zero without changing sign is not a crossing; crossing through exact zero(s) is.
    expect(
      flipFromProfile(
        [
          { gex: 100, spot: 80 },
          { gex: 0, spot: 90 },
          { gex: 100, spot: 100 },
        ],
        95
      )
    ).toBeNull();
    expect(
      flipFromProfile(
        [
          { gex: -100, spot: 80 },
          { gex: 0, spot: 90 },
          { gex: 0, spot: 94 },
          { gex: 100, spot: 100 },
        ],
        95
      )
    ).toBe(92);
    // Multiple sign crossings: pick the crossing nearest spot (whether earlier or later).
    const twoCrossings = [
      { gex: -100, spot: 80 },
      { gex: 100, spot: 90 },
      { gex: 100, spot: 110 },
      { gex: -100, spot: 120 },
    ];
    expect(flipFromProfile(twoCrossings, 88)).toBeCloseTo(85, 6);
    expect(flipFromProfile(twoCrossings, 112)).toBeCloseTo(115, 6);
    expect(gexProfile(strikes, model(null), 100)).toEqual([]);
    expect(gexProfile(strikes, model(0.3), Number.NaN)).toEqual([]);
    return expect(gexProfile(strikes, model(0.3), 0)).toEqual([]);
  });
  it("picks the largest positive, most negative, and largest absolute GEX strikes as walls and king node", () => {
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
        row(101, Number.NaN),
        row(102, 0),
        row(105, 3),
        row(110, 7),
        row(115, 2),
        row(120, -1),
      ])
    ).toEqual({ callWall: 110, kingNode: 95, putWall: 95 });
    expect(gexWalls([row(100, -4), row(105, 8)])).toEqual({
      callWall: 105,
      kingNode: 105,
      putWall: 100,
    });
    return expect(gexWalls([row(100, null), row(105, 0)])).toEqual({
      callWall: null,
      kingNode: null,
      putWall: null,
    });
  });
});

describe("flow, IV, session and calendar context", () => {
  it("reads who is paying premium and the expiry share of flow", () => {
    expect(flowContext([], TODAY)).toEqual({
      bearishPremium: 0,
      bias: "no_signed_flow",
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
      regime: "no_term_data",
    });
    expect(ivContext([point(0, 0.5), point(3, 0.3)])).toEqual({
      backIv: null,
      frontIv: 0.3,
      regime: "no_term_data",
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
    expect(at("2026-11-07T02:00:00.000Z")).toBe("closed");
    // Boundaries in summer time (EDT, UTC-4): 09:30, 12:00, 14:00, 16:00 and 20:00 New York.
    expect(at("2026-07-06T13:29:00.000Z")).toBe("premarket");
    expect(at("2026-07-06T13:30:00.000Z")).toBe("morning");
    expect(at("2026-07-06T16:00:00.000Z")).toBe("midday");
    expect(at("2026-07-06T18:00:00.000Z")).toBe("afternoon");
    expect(at("2026-07-06T20:00:00.000Z")).toBe("afterhours");
    expect(at("2026-07-07T00:00:00.000Z")).toBe("closed");
    return expect(at("2026-07-06T08:00:00.000Z")).toBe("premarket");
  });

  it("uses the New York date, not the UTC date", () => {
    // 21:00 New York on Friday 2026-11-06 is already Saturday in UTC.
    expect(newYorkDate(new Date("2026-11-07T02:00:00.000Z"))).toBe(
      "2026-11-06"
    );
    return expect(newYorkDate(new Date("2026-07-06T03:59:00.000Z"))).toBe(
      "2026-07-05"
    );
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
    expect(context.levels.kingNode).toBe(105);
    expect(context.profile).toHaveLength(121);
    expect(context.profile[0]?.spot).toBeCloseTo(101 * 0.7, 6);
    expect(context.profile[60]?.spot).toBeCloseTo(101, 6);
    expect(context.profile[120]?.spot).toBeCloseTo(101 * 1.3, 6);
    const flipIndex = context.profile.findIndex(
      (point, index) =>
        index + 1 < context.profile.length &&
        point.spot <= (context.levels.flip ?? 0) &&
        (context.profile[index + 1]?.spot ?? 0) >= (context.levels.flip ?? 0)
    );
    expect(flipIndex).toBeGreaterThanOrEqual(0);
    expect(
      (context.profile[flipIndex]?.gex ?? 0) *
        (context.profile[flipIndex + 1]?.gex ?? 0)
    ).toBeLessThan(0);
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
    expect(factor(factors, "vanna").value).toBe(
      "+$394K per IV pt · IV up: dealers sell, IV down: dealers buy"
    );
    expect(factor(factors, "ivRegime")).toMatchObject({
      tone: "caution",
      value: "Inverted 28% vs 24%",
    });
    return expect(factor(factors, "events")).toMatchObject({
      tone: "neutral",
      value: "Monthly OpEx in 14d (11-20)",
    });
  });

  it("names the missing input instead of guessing when inputs are missing", () => {
    const empty = buildGexContext(
      input({
        chain: [],
        events: [],
        ...section([], [], null),
        flowOk: false,
        spot: null,
        term: [],
      })
    );
    expect(GexContextSchema.parse(empty)).toEqual(empty);
    expect(empty).toMatchObject({
      flow: { bias: "not_received" },
      greeks: { netCharm: null, netDex: null, netVanna: null },
      iv: { regime: "no_term_data" },
      levels: {
        callWall: null,
        dailyMove: null,
        flip: null,
        kingNode: null,
        putWall: null,
      },
      profile: [],
      regime: "no_data",
    });
    const values = Object.fromEntries(
      empty.factors.map((item) => [item.key, [item.value, item.tone]])
    );
    expect(values).toMatchObject({
      charm: ["Not computed: no spot price", "neutral"],
      dex: ["Not computed: no spot price", "neutral"],
      expiryMix: ["No listed expiry", "neutral"],
      flow: ["Not received: QuantData flow request failed", "alert"],
      freshness: ["OI prior session · flow not received", "caution"],
      ivRegime: ["Not computed: no front expiry IV", "alert"],
      levels: ["No flip or walls", "neutral"],
      regime: ["Not computed: no GEX estimate", "alert"],
      vanna: ["Not computed: no spot price", "neutral"],
    });
    expect(factor(empty.factors, "flow").detail).toBe(
      "The QuantData option-flow request for the last 24 h failed; the next load of this page retries it. Without flow, a GEX level says where hedging changes, not which way price goes."
    );
    expect(factor(empty.factors, "expiryMix").detail).toBe(
      "OI is aggregated across all expiries, so the 0DTE vs monthly split of these levels is not reported by the source. Levels from the front expiry roll off at its close. Flow request failed, so there is no 0DTE or 7-day flow share."
    );
    expect(factor(empty.factors, "ivRegime").detail).toBe(
      "Front and back expiry IV are missing: no expiry 1 or more days out has an ATM IV in the QuantData chain. Front ATM IV vs the first expiry 25+ days out. Inverted (front above back) means stress and a larger vanna effect. Historical IV rank is not in this feed."
    );
    expect(factor(empty.factors, "dex").detail).toMatch(
      /^Not computed: no spot price\. Net delta of open options/
    );
    expect(factor(empty.factors, "charm").detail).toMatch(
      /^Not computed: no spot price\. Estimated change of dealer delta per day/
    );
    expect(factor(empty.factors, "vanna").detail).toMatch(
      /^Not computed: no spot price\. Estimated change of dealer delta if IV/
    );
    // The longest new detail (rule 7): the regime without an estimate.
    const regimeDetail = factor(empty.factors, "regime").detail;
    expect(regimeDetail).toBe(
      "No net GEX: open interest, option-chain IV or the spot price was not received from QuantData (the exposure message names which). Positive GEX does not guarantee a range and negative GEX does not guarantee a selloff. Either regime can trend; check flow, the other Greeks and IV first."
    );
    expect(regimeDetail.length).toBeLessThanOrEqual(300);
    for (const item of empty.factors) {
      expect(item.value.length).toBeLessThan(80);
      expect(item.detail.length).toBeLessThanOrEqual(300);
    }
  });

  it("separates flow that was received without a side from flow that failed", () => {
    const neutralOnly = buildGexContext(
      input({ events: [event({ sentiment: "neutral" })] })
    );
    expect(neutralOnly.flow.bias).toBe("no_signed_flow");
    expect(factor(neutralOnly.factors, "flow")).toEqual({
      detail:
        "QuantData returned 1 trades for the last 24 h and none has a bullish or bearish sentiment. Without flow, a GEX level says where hedging changes, not which way price goes.",
      key: "flow",
      label: "Flow (who is paying)",
      tone: "alert",
      value: "No signed flow in last 24 h",
    });
    // Signed premium exists, so the share sentence keeps its two percent values.
    expect(factor(neutralOnly.factors, "expiryMix").detail).toContain(
      "Flow share in the 24 h window: 100% 0DTE, 100% within 7 days."
    );
    const noTrades = buildGexContext(input({ events: [] }));
    expect(noTrades.flow.bias).toBe("no_signed_flow");
    expect(factor(noTrades.factors, "expiryMix").detail).toBe(
      "OI is aggregated across all expiries, so the 0DTE vs monthly split of these levels is not reported by the source. Levels from the front expiry roll off at its close. No flow premium in the 24 h window, so there is no 0DTE or 7-day flow share."
    );
    // A failed request never shows the events that came with it.
    const failed = buildGexContext(input({ flowOk: false }));
    expect(failed.flow).toMatchObject({
      bias: "not_received",
      bullishPremium: 0,
      zeroDteShare: null,
    });
  });

  it("separates a net GEX of exactly zero from a missing estimate", () => {
    const zero = buildGexContext(input({ totalGex: 0 }));
    expect(zero.regime).toBe("zero");
    expect(factor(zero.factors, "regime")).toEqual({
      detail:
        "Net GEX over the strikes within 50-150% of spot is exactly 0, so it has no sign. Positive GEX does not guarantee a range and negative GEX does not guarantee a selloff. Either regime can trend; check flow, the other Greeks and IV first.",
      key: "regime",
      label: "Regime (estimate)",
      tone: "alert",
      value: "Not computed: net GEX is 0",
    });
    const positive = factor(buildGexContext(input()).factors, "regime");
    expect(positive.tone).toBe("neutral");
    expect(positive.detail).toMatch(/^Positive GEX does not guarantee/);
  });

  it("names the first missing input of the dealer Greeks", () => {
    const dex = (overrides: Partial<GexContextInput>): string =>
      factor(buildGexContext(input(overrides)).factors, "dex").value;
    expect(dex({ spot: null })).toBe("Not computed: no spot price");
    expect(dex({ spot: 0 })).toBe("Not computed: no spot price");
    expect(dex({ strikes: [] })).toBe("Not computed: no strike open interest");
    expect(dex({ chain: [] })).toBe("Not computed: no option chain rows");
    // A chain without IV: OI shown, but no dealer numbers.
    const noIv = CHAIN.map((row) => ({ ...row, iv: null }));
    const blind = buildGexContext(
      input({ chain: noIv, ...section(OI, noIv, 101) })
    );
    expect(blind.greeks.netDex).toBeNull();
    expect(blind.levels.dailyMove).toBeNull();
    expect(factor(blind.factors, "dex").value).toBe(
      "Not computed: no front ATM IV"
    );
    expect(factor(blind.factors, "charm").value).toBe(
      "Not computed: no front ATM IV"
    );
    expect(factor(blind.factors, "vanna").value).toBe(
      "Not computed: no front ATM IV"
    );
    // With a front ATM IV every strike is priced, so buildGexContext never reaches the
    // last cause; the function still names it instead of leaving the state without a text.
    expect(greeksMissingCause(101, 9, model(0.3))).toBe(
      "no strike could be priced"
    );
    expect(greeksMissingCause(101, 9, model(null))).toBe("no front ATM IV");
    expect(greeksMissingCause(101, 9, null)).toBe("no option chain rows");
    expect(greeksMissingCause(101, 0, null)).toBe("no strike open interest");
    return expect(greeksMissingCause(null, 0, null)).toBe("no spot price");
  });

  it("says flow was received without a trade, not that it was not received", () => {
    const noTrades = buildGexContext(input({ events: [] }));
    expect(factor(noTrades.factors, "freshness").value).toBe(
      "OI prior session · no recent trades"
    );
    // A failed request with trades in its input never reads as trades or as no trades.
    const failed = buildGexContext(input({ flowOk: false }));
    expect(factor(failed.factors, "freshness").value).toBe(
      "OI prior session · flow not received"
    );
  });

  it("says why there is no front and back IV pair", () => {
    const IV_DETAIL =
      "Front ATM IV vs the first expiry 25+ days out. Inverted (front above back) means stress and a larger vanna effect. Historical IV rank is not in this feed.";
    const oneExpiry = chainFor([["2026-11-09", 0.28]]);
    const single = buildGexContext(
      input({ term: termStructure(oneExpiry, 101, TODAY) })
    );
    expect(single.iv).toMatchObject({ backIv: null, regime: "no_term_data" });
    expect(factor(single.factors, "ivRegime")).toEqual({
      detail: `No back expiry: the front expiry (ATM IV 28%) is the last one with an ATM IV in the QuantData chain. ${IV_DETAIL}`,
      key: "ivRegime",
      label: "IV regime",
      tone: "alert",
      value: "Not computed: no expiry after the front",
    });
    // Three expiries with an IV, 28, 56 and 91 days out: the front is itself the first one
    // 25+ days out, so the later expiries are not a back expiry.
    const point = (dte: number, atmIv: number) => ({
      atmIv,
      dte,
      expiry: new Date(Date.parse(`${TODAY}T00:00:00Z`) + dte * 86_400_000)
        .toISOString()
        .slice(0, 10),
    });
    const farTerm = [point(28, 0.31), point(56, 0.3), point(91, 0.29)];
    expect(ivContext(farTerm)).toEqual({
      backIv: null,
      frontIv: 0.31,
      regime: "no_term_data",
    });
    const far = factor(
      buildGexContext(input({ term: farTerm })).factors,
      "ivRegime"
    );
    expect(far).toEqual({
      detail: `No separate back expiry: the front expiry (28 days out, ATM IV 31%) is also the first one 25+ days out. ${IV_DETAIL}`,
      key: "ivRegime",
      label: "IV regime",
      tone: "alert",
      value: "Not computed: front is the first expiry 25+ days out",
    });
    expect(far.value.length).toBeLessThan(80);
    expect(far.detail.length).toBeLessThanOrEqual(300);
  });

  it("flags flow that fights the regime and a negative regime", () => {
    const putHeavy = OI.map((row) => ({
      ...row,
      putOpenInterest: row.putOpenInterest * 20,
    }));
    const negative = buildGexContext(
      input({
        events: [event({ premium: 400 })],
        ...section(putHeavy, CHAIN, 101),
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
        ...section(flatOi, flatChain, 100),
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
        ...section(big, contango, 101),
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

  it("reads the next expiry and newest trade from unsorted input on the New York day", () => {
    // 21:00 New York on 2026-11-06 (02:00 UTC on 2026-11-07): today's expiry closed at 16:00.
    const evening = new Date("2026-11-07T02:00:00.000Z");
    const unsorted = [
      ...chainFor([["2026-11-20", 0.25]]),
      ...chainFor([["2026-11-05", 0.3]]),
      ...chainFor([["2026-11-06", 0.3]]),
    ];
    const context = buildGexContext(
      input({
        chain: unsorted,
        events: [
          event({ time: "2026-11-06T15:00:00.000Z" }),
          event({ time: "2026-11-06T20:59:00.000Z" }),
          event({ time: "2026-11-06T18:00:00.000Z" }),
        ],
        now: evening,
      })
    );
    expect(context.expiry).toMatchObject({
      nextExpiry: "2026-11-20",
      nextExpiryDte: 14,
    });
    // Prior-session OI still holds today's expired contracts until the overnight update.
    expect(factor(context.factors, "expiryMix")).toMatchObject({
      tone: "caution",
      value: "Today's expiry closed; OI still counts it · next in 14d",
    });
    expect(context.flow.newestTradeAt).toBe("2026-11-06T20:59:00.000Z");
    expect(context.flow.zeroDteShare).toBe(1);
    return expect(context.session).toBe("closed");
  });

  it("still counts today's expiry as 0DTE before its close", () => {
    // 15:59 New York on expiry day 2026-11-06 (EST): the close is 16:00.
    const context = buildGexContext(
      input({ now: new Date("2026-11-06T20:59:00.000Z") })
    );
    expect(context.expiry).toMatchObject({
      nextExpiry: "2026-11-06",
      nextExpiryDte: 0,
    });
    return expect(factor(context.factors, "expiryMix").value).toBe(
      "0DTE today: levels roll off at close"
    );
  });

  it("uses the 13:00 early close and 16:00 for a date without a session", () => {
    // 14:00 New York on Friday 2026-11-27, the day after Thanksgiving (13:00 close).
    // 2026-11-28 is a Saturday: no NYSE session, so its close falls back to 16:00.
    const context = buildGexContext(
      input({
        chain: chainFor([
          ["2026-11-27", 0.3],
          ["2026-11-28", 0.3],
          ["2026-12-04", 0.28],
        ]),
        now: new Date("2026-11-27T19:00:00.000Z"),
      })
    );
    expect(context.expiry).toMatchObject({
      nextExpiry: "2026-11-28",
      nextExpiryDte: 1,
    });
    expect(factor(context.factors, "expiryMix")).toMatchObject({
      tone: "caution",
      value: "Today's expiry closed; OI still counts it · next in 1d",
    });
    // The Saturday expiry closes at the 16:00 fallback: at 15:59 it is next, at 16:01 not.
    const saturday = (now: string) =>
      buildGexContext(
        input({
          chain: chainFor([
            ["2026-11-28", 0.3],
            ["2026-12-04", 0.28],
          ]),
          now: new Date(now),
        })
      ).expiry.nextExpiry;
    expect(saturday("2026-11-28T20:59:00.000Z")).toBe("2026-11-28");
    return expect(saturday("2026-11-28T21:01:00.000Z")).toBe("2026-12-04");
  });

  it("keeps the closed-today warning when no later expiry is listed", () => {
    // 21:00 New York on 2026-11-06; the chain lists only today's expiry.
    const context = buildGexContext(
      input({
        chain: chainFor([["2026-11-06", 0.3]]),
        now: new Date("2026-11-07T02:00:00.000Z"),
      })
    );
    expect(context.expiry.nextExpiry).toBeNull();
    return expect(factor(context.factors, "expiryMix")).toMatchObject({
      tone: "caution",
      value: "Today's expiry closed; OI still counts it",
    });
  });

  it("moves monthly OpEx to the next month once the OpEx close has passed", () => {
    // 2026-11-20 is the third Friday. 15:00 New York: OpEx today; 16:30: next is 12-18.
    const before = buildGexContext(
      input({ now: new Date("2026-11-20T20:00:00.000Z") })
    );
    expect(factor(before.factors, "events").value).toBe("Monthly OpEx today");
    const after = buildGexContext(
      input({ now: new Date("2026-11-20T21:30:00.000Z") })
    );
    expect(after.expiry).toMatchObject({
      monthlyOpexDays: 28,
      nextMonthlyOpex: "2026-12-18",
    });
    return expect(factor(after.factors, "events")).toMatchObject({
      tone: "neutral",
      value: "Monthly OpEx in 28d (12-18)",
    });
  });

  it("flags flow totals that cover only the first provider page", () => {
    const partial = buildGexContext(input({ flowPartial: true }));
    const flow = factor(partial.factors, "flow");
    expect(flow).toMatchObject({
      tone: "caution",
      value: "Bulls +$300K net · first page only, 2 trades",
    });
    expect(flow.detail).toContain("totals cover its first page only");
    expect(factor(partial.factors, "expiryMix").detail).toContain(
      "window (first flow page only)"
    );
    const full = buildGexContext(input());
    expect(factor(full.factors, "flow")).toMatchObject({
      tone: "neutral",
      value: "Bulls +$300K net",
    });
    return expect(factor(full.factors, "flow").detail).not.toContain(
      "first page"
    );
  });

  it("names both IV directions for vanna and the time direction for charm", () => {
    const calls = buildGexContext(input());
    const putHeavy = OI.map((row) => ({
      ...row,
      putOpenInterest: row.putOpenInterest * 20,
    }));
    // Calls below spot (in the money) turn dealer vanna negative.
    const itmCalls = STRIKES.map((strike) => ({
      callOpenInterest: strike < 100 ? 50_000 : 100,
      putOpenInterest: 100,
      strike,
    }));
    const books = [
      calls,
      buildGexContext(input(section(putHeavy, CHAIN, 101))),
      buildGexContext(input(section(itmCalls, CHAIN, 101))),
    ];
    const vanna = books.map((context) => ({
      sign: Math.sign(context.greeks.netVanna ?? 0),
      value: factor(context.factors, "vanna").value,
    }));
    const charm = books.map((context) => ({
      sign: Math.sign(context.greeks.netCharm ?? 0),
      value: factor(context.factors, "charm").value,
    }));
    // The books give both signs of each Greek.
    expect(new Set(vanna.map((item) => item.sign))).toEqual(new Set([-1, 1]));
    expect(new Set(charm.map((item) => item.sign))).toEqual(new Set([-1, 1]));
    for (const { sign, value } of vanna)
      expect(value).toMatch(
        sign > 0
          ? /^\+\$\S+ per IV pt · IV up: dealers sell, IV down: dealers buy$/u
          : /^-\$\S+ per IV pt · IV up: dealers buy, IV down: dealers sell$/u
      );
    for (const { sign, value } of charm)
      expect(value).toMatch(
        sign > 0
          ? /^\+\$\S+\/day as time passes: dealers sell$/u
          : /^-\$\S+\/day as time passes: dealers buy$/u
      );
    return expect(factor(calls.factors, "vanna").detail).toContain(
      "an IV drop reverses the hedge"
    );
  });

  it("states the chain and OI fetch age and keeps every text inside the schema", () => {
    const context = buildGexContext(
      input({
        events: [event({ premium: -1_234_500_000_000, sentiment: "bearish" })],
        fetchedAt: PM.getTime() - 3 * 60_000,
        flowHours: 168,
        flowPartial: true,
      })
    );
    expect(factor(context.factors, "freshness").detail).toContain(
      "Chain and OI fetched 3 min ago (cached up to 5 min)."
    );
    expect(factor(context.factors, "levels").detail).toContain(
      "every strike within 50-150% of spot"
    );
    expect(factor(context.factors, "dex").detail).toContain(
      "strikes within 50-150% of spot"
    );
    // The longest values end whole (buildFactors would cut them silently at 80).
    expect(factor(context.factors, "flow").value).toBe(
      "Bears -$1234.5B net · first page only, 1 trades"
    );
    expect(factor(context.factors, "vanna").value).toMatch(
      /IV up: dealers (buy|sell), IV down: dealers (buy|sell)$/u
    );
    return expect(GexContextSchema.parse(context)).toEqual(context);
  });

  it("computes DEX, vanna and charm over every in-range strike, not the 80 shown", () => {
    // 200 strikes 1..200 around spot 101: 101 are in range, fewer than 80 are displayed.
    const wide = Array.from({ length: 200 }, (_, index) => ({
      callOpenInterest: 1000 + index * 10,
      putOpenInterest: 900,
      strike: index + 1,
    }));
    const chain: ChainRow[] = wide.flatMap(({ strike }) => [
      { delta: 0.5, expiry: "2026-11-20", iv: 0.4, right: "call", strike },
      { delta: -0.5, expiry: "2026-11-20", iv: 0.45, right: "put", strike },
    ]);
    const estimate = exposure(wide, chain, 101, TODAY);
    const model = gammaModel(chain, 101, TODAY);
    const all =
      model === null ? null : dealerTotals(estimate.strikes, model, 101);
    const shown =
      model === null
        ? null
        : dealerTotals(estimate.section.strikes, model, 101);
    const context = buildGexContext(
      input({ chain, spot: 101, ...section(wide, chain, 101) })
    );
    expect(estimate.section.strikes.length).toBeLessThan(
      estimate.strikes.length
    );
    expect(context.greeks).toEqual({
      netCharm: all?.charm,
      netDex: all?.dex,
      netVanna: all?.vanna,
    });
    return expect(context.greeks.netDex).not.toBe(shown?.dex);
  });
});
