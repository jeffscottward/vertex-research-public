import { describe, expect, it } from "vitest";

import { appContract } from "../contract.ts";
import {
  OptionContractSchema,
  OptionsChainExpiriesInputSchema,
  OptionsChainInputSchema,
  OptionsChainOutputSchema,
} from "./options-chain.ts";

const contract = {
  ask: 1.4,
  bid: 1.3,
  change: null,
  contractSymbol: "DEMO261106C00100000",
  greeks: { delta: 0.52, gamma: 0.19, rho: 0.003, theta: -0.18, vega: 0.03 },
  inTheMoney: false,
  iv: 0.28,
  last: 1.35,
  lastTradeAt: null,
  openInterest: 2210,
  volume: 812,
};

describe("optionsChain contract", () => {
  it("normalizes the symbol and accepts an optional real expiry", () => {
    expect(OptionsChainExpiriesInputSchema.parse({ symbol: " nvda " })).toEqual(
      { symbol: "NVDA" }
    );
    expect(
      OptionsChainInputSchema.parse({ expiry: "2026-11-20", symbol: "brk.b" })
    ).toEqual({ expiry: "2026-11-20", symbol: "BRK.B" });
    for (const input of [
      { symbol: "1ABC" },
      { expiry: "2026-02-30x", symbol: "NVDA" },
      { expiry: "2026-13-01", symbol: "NVDA" },
      { expiry: "2026-02-31", symbol: "NVDA" },
      { other: true, symbol: "NVDA" },
    ])
      expect(OptionsChainInputSchema.safeParse(input).success).toBe(false);
  });

  it("keeps contracts strict and Greeks nullable", () => {
    expect(OptionContractSchema.parse(contract)).toEqual(contract);
    expect(
      OptionContractSchema.parse({ ...contract, greeks: null, iv: null })
    ).toMatchObject({ greeks: null });
    expect(
      OptionContractSchema.safeParse({ ...contract, orderId: "x" }).success
    ).toBe(false);
    expect(
      OptionContractSchema.safeParse({ ...contract, bid: -1 }).success
    ).toBe(false);
  });

  it("describes a chain with its assumptions", () => {
    const output = {
      assumptions: {
        dayCount: "act/365",
        dividendYield: 0,
        model: "black-scholes-european",
        riskFreeRate: 0.04,
      },
      currency: "USD",
      dte: 2,
      expiries: [{ date: "2026-11-06", dte: 2 }],
      expiry: "2026-11-06",
      notes: ["Dummy note"],
      quoteTime: null,
      receivedAt: "2026-11-04T20:00:00.000Z",
      rows: [{ call: contract, put: null, strike: 100 }],
      source: "yahoo",
      spot: 100,
      symbol: "DEMO",
    };
    expect(OptionsChainOutputSchema.parse(output)).toEqual(output);
    expect(
      OptionsChainOutputSchema.safeParse({ ...output, source: "ibkr" }).success
    ).toBe(false);
  });

  it("exposes two read-only GET procedures", () => {
    const routes = [
      appContract.optionsChain.expiries,
      appContract.optionsChain.chain,
    ].map((procedure) => procedure["~orpc"].route);
    expect(routes.map((route) => [route.method, route.path])).toEqual([
      ["GET", "/options-chain/expiries"],
      ["GET", "/options-chain/chain"],
    ]);
  });
});
