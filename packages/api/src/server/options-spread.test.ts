import type { MarketDailyLatestPoint } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import type {
  OptionContract,
  OptionsChainOutput,
  OptionsSpreadOutput,
  OptionsSpreadParsedInput,
} from "../contracts/options-chain.ts";
import {
  buildOptionsSpread,
  MODEL_INPUT_MAX_AGE_DAYS,
} from "./options-spread.ts";

// Consult 2026-11-19: QQQ 2027-01-15 puts at the close, 57 days to expiry, VXN 33.12, IRX 4.00.
const contract = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  ask: 1,
  bid: 1,
  change: null,
  contractSymbol: "QQQ270115P00640000",
  flow: null,
  greeks: { delta: -0.42, gamma: 0.0042, rho: -0.5, theta: -0.21, vega: 1 },
  inTheMoney: false,
  iv: 0.309,
  last: null,
  lastTradeAt: "2026-11-19T21:12:00Z",
  openInterest: 20_949,
  sources: {
    delta: "quantdata",
    iv: "quantdata",
    openInterest: "quantdata",
    quote: "yahoo",
  },
  volume: 100,
  ...overrides,
});

const chain = (
  overrides: Partial<OptionsChainOutput> = {}
): OptionsChainOutput => ({
  assumptions: {
    dayCount: "act/365",
    dividendYield: 0.007,
    model: "black-scholes-european",
    riskFreeRate: 0.04,
  },
  currency: "USD",
  dte: 57,
  expiries: [{ date: "2027-01-15", dte: 57 }],
  expiriesSources: ["yahoo"],
  expiry: "2027-01-15",
  flowFirstPageOnly: false,
  notes: [],
  quoteTime: "2026-11-19T21:14:00Z",
  receivedAt: "2026-11-19T23:29:00.000Z",
  rows: [
    {
      call: null,
      put: contract({
        ask: 13.48,
        bid: 13.23,
        greeks: {
          delta: -0.24,
          gamma: 0.0031,
          rho: -0.3,
          theta: -0.17,
          vega: 0.8,
        },
        iv: 0.35,
      }),
      strike: 595,
    },
    { call: null, put: contract({ ask: null, bid: null }), strike: 600 },
    { call: null, put: contract({ ask: 26.6, bid: 26.23 }), strike: 640 },
  ],
  sources: [
    { message: null, source: "quantdata", status: "used" },
    { message: null, source: "ibkr", status: "off" },
    { message: null, source: "yahoo", status: "used" },
  ],
  spot: 645.04,
  spotSource: "quantdata",
  symbol: "QQQ",
  ...overrides,
});

const input: OptionsSpreadParsedInput = {
  expiry: "2027-01-15",
  longStrike: 640,
  right: "put",
  shortStrike: 595,
  symbol: "QQQ",
};

const points: MarketDailyLatestPoint[] = [
  { adjClose: null, close: 4, id: "IRX", lastDate: "2026-11-18" },
  { adjClose: null, close: 33.12, id: "VXN", lastDate: "2026-11-18" },
];

describe("buildOptionsSpread", () => {
  it("prices the consult's QQQ 640/595 put spread from quotes and from the model", () => {
    const answer = buildOptionsSpread(chain(), input, { points });
    expect(answer).toMatchObject({
      dte: 57,
      expiry: "2027-01-15",
      modelUnavailable: null,
      quoteTime: "2026-11-19T21:14:00Z",
      quotesUnavailable: null,
      right: "put",
      spot: 645.04,
      spotSource: "quantdata",
      symbol: "QQQ",
    });
    const quotes = answer.quotes;
    expect(quotes?.structure).toBe("putDebitVertical");
    expect(quotes?.netMid).toBeCloseTo(13.06, 2);
    expect(quotes?.netWorst).toBeCloseTo(13.37, 2);
    expect(quotes?.maxLossPerContract).toBeCloseTo(1306, 0);
    expect(quotes?.maxGainPerContract).toBeCloseTo(3194, 0);
    expect(quotes?.breakeven).toBeCloseTo(626.94, 2);
    expect(quotes?.netPctWidth).toBeCloseTo(29.0, 1);
    expect(quotes?.greeks?.vega).toBeCloseTo(0.2, 10);
    expect(quotes?.legs[0]).toMatchObject({
      ask: 26.6,
      bid: 26.23,
      greeks: { delta: -0.42, gamma: 0.0042, theta: -0.21, vega: 1 },
      lastTradeAt: "2026-11-19T21:12:00Z",
      mid: 26.415,
      quoteSource: "yahoo",
      side: "long",
      strike: 640,
    });
    expect(quotes?.legs[1]).toMatchObject({
      mid: 13.355,
      side: "short",
      strike: 595,
    });
    const model = answer.model;
    expect(model?.netMid).toBeCloseTo(12.758, 3);
    expect(model?.inputs).toEqual({
      atmIv: 0.9 * 0.3312,
      days: 57,
      dividendYield: 0.007,
      ivIndex: "VXN",
      ivIndexAsOf: "2026-11-18",
      ivIndexLevel: 33.12,
      rate: 0.04,
      rateAsOf: "2026-11-18",
      skew: -0.25,
      spot: 645.04,
    });
    expect(model?.legs.map((leg) => leg.side)).toEqual(["long", "short"]);
    expect(answer.modelVsMidPct).toBeCloseTo((12.758 / 13.06 - 1) * 100, 1);
  });

  it("explains a missing quote and still prices the model", () => {
    const noLeg = buildOptionsSpread(
      chain(),
      { ...input, shortStrike: 590 },
      { points }
    );
    expect(noLeg.quotes).toBeNull();
    expect(noLeg.quotesUnavailable).toBe("No 590 put in the 2027-01-15 chain");
    expect(noLeg.model).not.toBeNull();
    expect(noLeg.modelVsMidPct).toBeNull();
    expect(
      buildOptionsSpread(chain(), { ...input, longStrike: 600 }, { points })
        .quotesUnavailable
    ).toBe("No bid and ask for the 600 put");
    expect(
      buildOptionsSpread(chain(), { ...input, longStrike: 610 }, { points })
        .quotesUnavailable
    ).toBe("No 610 put in the 2027-01-15 chain");
    expect(
      buildOptionsSpread(chain(), { ...input, right: "call" }, { points })
        .quotesUnavailable
    ).toBe("No 640 call in the 2027-01-15 chain");
    const crossed = chain();
    const rows = crossed.rows.map((row) =>
      row.strike === 640
        ? { ...row, put: contract({ ask: 13.3, bid: 13.2 }) }
        : row
    );
    expect(
      buildOptionsSpread({ ...crossed, rows }, input, { points })
        .quotesUnavailable
    ).toBe(
      "A debit spread (long leg nearer the money) needs a net debit above 0"
    );
    const noGreeks = chain().rows.map((row) =>
      row.strike === 595
        ? { ...row, put: contract({ ...row.put, greeks: null }) }
        : row
    );
    const priced = buildOptionsSpread({ ...chain(), rows: noGreeks }, input, {
      points,
    });
    expect(priced.quotes?.greeks).toBeNull();
    expect(priced.quotes?.legs[1].greeks).toBeNull();
  });

  it("explains why the model gives no price", () => {
    const reason = (answer: OptionsSpreadOutput): string | null =>
      answer.modelUnavailable;
    expect(
      reason(
        buildOptionsSpread(
          chain({ symbol: "AAPL" }),
          { ...input, symbol: "AAPL" },
          { points }
        )
      )
    ).toBe(
      "No option model for AAPL; it covers DIA, GLD, IWM, QQQ, SLV, SPY, USO"
    );
    expect(
      reason(
        buildOptionsSpread(chain(), input, {
          readFailure: "This server has no daily series store",
        })
      )
    ).toBe("This server has no daily series store");
    expect(
      reason(buildOptionsSpread(chain({ spot: null }), input, { points }))
    ).toBe("The chain has no spot price");
    expect(
      reason(buildOptionsSpread(chain({ dte: 0 }), input, { points }))
    ).toBe("The spread expires today; the model needs at least 1 day");
    expect(
      reason(buildOptionsSpread(chain(), input, { points: points.slice(0, 1) }))
    ).toBe("No stored VXN close");
    expect(
      reason(buildOptionsSpread(chain(), input, { points: points.slice(1) }))
    ).toBe("No stored IRX close");
    const old = [
      { ...points[1], lastDate: "2026-11-11" },
      points[0],
    ] as MarketDailyLatestPoint[];
    expect(MODEL_INPUT_MAX_AGE_DAYS).toBe(7);
    expect(reason(buildOptionsSpread(chain(), input, { points: old }))).toBe(
      "The stored VXN close of 2026-11-11 is more than 7 days old"
    );
    const edge = [
      { ...points[1], lastDate: "2026-11-12" },
      points[0],
    ] as MarketDailyLatestPoint[];
    expect(
      reason(buildOptionsSpread(chain(), input, { points: edge }))
    ).toBeNull();
    expect(
      reason(buildOptionsSpread(chain({ spot: 1e12 }), input, { points }))
    ).toBe(
      "A debit spread (long leg nearer the money) needs a net debit above 0"
    );
  });
});
