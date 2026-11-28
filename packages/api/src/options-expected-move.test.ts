import { describe, expect, it } from "vitest";

import type {
  OptionContract,
  OptionsChainOutput,
  OptionsChainRow,
} from "./contracts/options-chain.ts";
import { OptionsExpectedMoveOutputSchema } from "./contracts/options-chain.ts";
import { expiryCloseMs, yearsToExpiry } from "./options-chain-greeks.ts";
import {
  computeOptionsExpectedMove,
  findAtmPairRow,
  STRADDLE_TO_ONE_SIGMA,
} from "./options-expected-move.ts";

const NOW = new Date("2026-11-04T15:00:00.000Z");

const makeContract = (
  overrides: Partial<OptionContract> = {}
): OptionContract => ({
  ask: 4.4,
  bid: 4.0,
  change: 0.1,
  contractSymbol: "SPY261120C00500000",
  flow: null,
  greeks: null,
  inTheMoney: false,
  iv: 0.24,
  last: 4.2,
  lastTradeAt: "2026-11-04T14:55:00.000Z",
  openInterest: 1000,
  sources: {
    delta: "model",
    iv: "quantdata",
    openInterest: "quantdata",
    quote: "ibkr",
  },
  volume: 120,
  ...overrides,
});

const makeChain = (
  overrides: Partial<OptionsChainOutput> = {}
): OptionsChainOutput => ({
  assumptions: {
    dayCount: "act/365",
    dividendYield: 0.015,
    model: "black-scholes-european",
    riskFreeRate: 0.04,
  },
  currency: "USD",
  dte: 16,
  expiries: [
    { date: "2026-11-06", dte: 2 },
    { date: "2026-11-20", dte: 16 },
  ],
  expiriesSources: ["quantdata", "yahoo"],
  expiry: "2026-11-20",
  flowFirstPageOnly: false,
  notes: ["Quant Data note.", "Yahoo note."],
  quoteTime: "2026-11-04T14:59:00.000Z",
  receivedAt: NOW.toISOString(),
  rows: [
    {
      call: makeContract({ ask: 8.2, bid: 7.8, iv: 0.25, last: 8.0 }),
      put: makeContract({
        ask: 2.2,
        bid: 1.8,
        contractSymbol: "SPY261120P00495000",
        iv: 0.26,
        last: 2.0,
      }),
      strike: 495,
    },
    {
      call: makeContract({ ask: 5.2, bid: 4.8, iv: 0.22, last: 5.0 }),
      put: makeContract({
        ask: 5.4,
        bid: 5.0,
        contractSymbol: "SPY261120P00500000",
        iv: 0.24,
        last: 5.1,
      }),
      strike: 500,
    },
    {
      call: makeContract({ ask: 2.4, bid: 2.0, iv: 0.21, last: 2.2 }),
      put: makeContract({
        ask: 8.4,
        bid: 8.0,
        contractSymbol: "SPY261120P00505000",
        iv: 0.23,
        last: 8.2,
      }),
      strike: 505,
    },
  ],
  sources: [
    { message: null, source: "quantdata", status: "used" },
    { message: null, source: "ibkr", status: "used" },
    { message: null, source: "yahoo", status: "used" },
    { message: null, source: "nasdaq", status: "off" },
  ],
  spot: 500,
  spotSource: "quantdata",
  symbol: "SPY",
  ...overrides,
});

describe("findAtmPairRow", () => {
  it("skips single-sided strikes and breaks equidistant ties to the lower strike", () => {
    const rows: OptionsChainRow[] = [
      { call: makeContract(), put: null, strike: 500 },
      { call: makeContract(), put: makeContract(), strike: 505 },
      { call: makeContract(), put: makeContract(), strike: 495 },
    ];
    expect(findAtmPairRow(rows, 500)?.strike).toBe(495);
    expect(
      findAtmPairRow([{ call: null, put: makeContract(), strike: 500 }], 500)
    ).toBeNull();
  });
});

describe("computeOptionsExpectedMove", () => {
  it("computes ±1σ expected move and breakevens from ATM straddle midpoints", () => {
    const output = computeOptionsExpectedMove(makeChain(), NOW);
    expect(OptionsExpectedMoveOutputSchema.parse(output)).toEqual(output);
    expect(output.unavailableReason).toBeNull();
    expect(output.band).not.toBeNull();
    const band = output.band!;
    expect(band.basis).toBe("atm_straddle_mid");
    expect(band.atmStrike).toBe(500);
    expect(band.callPrice).toBeCloseTo(5.0, 6);
    expect(band.putPrice).toBeCloseTo(5.2, 6);
    expect(band.callQuoteSource).toBe("ibkr");
    expect(band.putQuoteSource).toBe("ibkr");
    expect(band.atmIv).toBeCloseTo(0.23, 6);
    expect(band.straddlePrice).toBeCloseTo(10.2, 6);
    expect(band.straddlePct).toBeCloseTo(10.2 / 500, 6);
    expect(band.expectedMove).toBeCloseTo(10.2 * STRADDLE_TO_ONE_SIGMA, 6);
    expect(band.expectedMovePct).toBeCloseTo(
      (10.2 * STRADDLE_TO_ONE_SIGMA) / 500,
      6
    );
    expect(band.upperBand).toBeCloseTo(500 + band.expectedMove, 6);
    expect(band.lowerBand).toBeCloseTo(500 - band.expectedMove, 6);
    expect(band.straddleUpper).toBeCloseTo(510.2, 6);
    expect(band.straddleLower).toBeCloseTo(489.8, 6);
    expect(band.expiryCloseMs).toBe(expiryCloseMs("2026-11-20"));
    expect(band.expiryCloseAt).toBe(
      new Date(expiryCloseMs("2026-11-20")).toISOString()
    );
  });

  it("falls back to atm_straddle_last when one leg has zero bid (after-hours) or crossed/missing quote", () => {
    const chain = makeChain({
      rows: [
        {
          call: makeContract({
            ask: 6.0,
            bid: 0,
            iv: 0.25,
            last: 5.0,
            sources: {
              delta: "model",
              iv: "yahoo",
              openInterest: "yahoo",
              quote: "yahoo",
            },
          }),
          put: makeContract({
            ask: 5.4,
            bid: 5.0,
            iv: null,
            last: 5.1,
            sources: {
              delta: "model",
              iv: null,
              openInterest: "yahoo",
              quote: "ibkr",
            },
          }),
          strike: 500,
        },
      ],
    });
    const output = computeOptionsExpectedMove(chain);
    expect(OptionsExpectedMoveOutputSchema.parse(output)).toEqual(output);
    expect(output.band?.basis).toBe("atm_straddle_last");
    expect(output.band?.callPrice).toBe(5.0);
    expect(output.band?.callQuoteSource).toBe("yahoo");
    expect(output.band?.putPrice).toBe(5.2);
    expect(output.band?.putQuoteSource).toBe("ibkr");
    expect(output.band?.atmIv).toBe(0.25);
  });

  it("rejects inverted quotes and missing quote source in Tier 1, falling back to Tier 3 ATM IV model without quotes", () => {
    const chain = makeChain({
      rows: [
        {
          call: makeContract({
            ask: 4.0,
            bid: 5.0,
            iv: 0.3,
            last: null,
            sources: {
              delta: "quantdata",
              iv: "quantdata",
              openInterest: "quantdata",
              quote: null,
            },
          }),
          put: makeContract({
            ask: null,
            bid: null,
            iv: 0,
            last: 0,
            sources: {
              delta: "quantdata",
              iv: "quantdata",
              openInterest: "quantdata",
              quote: null,
            },
          }),
          strike: 500,
        },
      ],
    });
    const output = computeOptionsExpectedMove(chain, NOW);
    expect(OptionsExpectedMoveOutputSchema.parse(output)).toEqual(output);
    const band = output.band!;
    expect(band.basis).toBe("atm_iv_model");
    expect(band.atmIv).toBe(0.3);
    expect(band.straddlePrice).toBeNull();
    expect(band.straddlePct).toBeNull();
    expect(band.straddleUpper).toBeNull();
    expect(band.straddleLower).toBeNull();
    expect(band.callPrice).toBeNull();
    expect(band.putPrice).toBeNull();
    expect(band.callQuoteSource).toBeNull();
    expect(band.putQuoteSource).toBeNull();
    const expected = 500 * 0.3 * Math.sqrt(yearsToExpiry("2026-11-20", NOW));
    expect(band.expectedMove).toBeCloseTo(expected, 6);
  });

  it("clamps lower bands to zero on extreme volatility and deduplicates/caps notes to 10", () => {
    const manyNotes = Array.from({ length: 12 }, (_, idx) => `Note ${idx}`);
    const chain = makeChain({
      notes: ["Note 0", ...manyNotes],
      rows: [
        {
          call: makeContract({ ask: 8, bid: 6, iv: 4.5 }),
          put: makeContract({ ask: 8, bid: 6, iv: 4.5 }),
          strike: 10,
        },
      ],
      spot: 10,
    });
    const output = computeOptionsExpectedMove(chain, NOW);
    expect(OptionsExpectedMoveOutputSchema.parse(output)).toEqual(output);
    expect(output.band?.lowerBand).toBe(0);
    expect(output.band?.straddleLower).toBe(0);
    expect(output.notes).toHaveLength(10);
    expect(new Set(output.notes).size).toBe(10);
  });

  it("returns unavailable with plain-English reason for missing spot, invalid timestamp, closed expiry, unpaired strikes, or unquoted zero-IV ATM", () => {
    const noSpot = computeOptionsExpectedMove(makeChain({ spot: null }), NOW);
    expect(noSpot.band).toBeNull();
    expect(noSpot.unavailableReason).toContain("spot price");
    expect(OptionsExpectedMoveOutputSchema.parse(noSpot)).toEqual(noSpot);
    const infSpot = computeOptionsExpectedMove(
      makeChain({ spot: Number.POSITIVE_INFINITY }),
      NOW
    );
    expect(infSpot.band).toBeNull();
    expect(infSpot.unavailableReason).toContain("spot price");

    const zeroSpot = computeOptionsExpectedMove(makeChain({ spot: 0 }), NOW);
    expect(zeroSpot.band).toBeNull();
    expect(zeroSpot.unavailableReason).toContain("spot price");

    const badTime = computeOptionsExpectedMove(
      makeChain({ receivedAt: "not-a-date" })
    );
    expect(badTime.band).toBeNull();
    expect(badTime.unavailableReason).toContain("timestamp");

    const closed = computeOptionsExpectedMove(
      makeChain({ dte: 0, expiry: "2026-11-04" }),
      new Date("2026-11-04T21:00:01.000Z")
    );
    expect(closed.band).toBeNull();
    expect(closed.unavailableReason).toContain("already closed");

    const noPair = computeOptionsExpectedMove(
      makeChain({
        rows: [{ call: makeContract(), put: null, strike: 500 }],
      }),
      NOW
    );
    expect(noPair.band).toBeNull();
    expect(noPair.unavailableReason).toContain("both a call and a put");

    const noData = computeOptionsExpectedMove(
      makeChain({
        rows: [
          {
            call: makeContract({ ask: null, bid: null, iv: null, last: null }),
            put: makeContract({ ask: null, bid: null, iv: null, last: null }),
            strike: 500,
          },
        ],
      }),
      NOW
    );
    expect(noData.band).toBeNull();
    expect(noData.unavailableReason).toContain("neither usable");
  });
});
