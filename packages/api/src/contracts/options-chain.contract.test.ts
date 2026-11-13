import { describe, expect, it } from "vitest";

import { appContract } from "../contract.ts";
import {
  OPTIONS_CHAIN_SOURCE_LABELS,
  OPTIONS_CHAIN_MAX_EXPIRIES,
  OPTIONS_CHAIN_MAX_ROWS,
  OPTIONS_CHAIN_SOURCES,
  OptionContractSchema,
  OptionsChainExpiriesInputSchema,
  OptionsChainExpiriesOutputSchema,
  OptionsChainInputSchema,
  OptionsChainOutputSchema,
} from "./options-chain.ts";

const contract = {
  ask: 1.4,
  bid: 1.3,
  change: null,
  contractSymbol: "DEMO261106C00100000",
  flow: { premium: 125_000, trades: 3, volume: 410 },
  greeks: { delta: 0.52, gamma: 0.19, rho: 0.003, theta: -0.18, vega: 0.03 },
  inTheMoney: false,
  iv: 0.28,
  last: 1.35,
  lastTradeAt: null,
  openInterest: 2210,
  sources: {
    delta: "quantdata",
    iv: "quantdata",
    openInterest: "quantdata",
    quote: "ibkr",
  },
  volume: 812,
};

const sources = [
  { message: null, source: "quantdata", status: "used" },
  { message: null, source: "ibkr", status: "used" },
  {
    message: "Yahoo options returned HTTP 503",
    source: "yahoo",
    status: "failed",
  },
];

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

  it("names the source of each merged value and the order flow of a contract", () => {
    const unsourced = {
      ...contract,
      flow: null,
      sources: { delta: null, iv: null, openInterest: null, quote: null },
    };
    expect(OptionContractSchema.parse(unsourced)).toEqual(unsourced);
    expect(
      OptionContractSchema.parse({
        ...contract,
        sources: {
          delta: "model",
          iv: "yahoo",
          openInterest: "yahoo",
          quote: "yahoo",
        },
      }).sources.delta
    ).toBe("model");
    for (const broken of [
      { ...contract, sources: { ...contract.sources, quote: "quantdata" } },
      { ...contract, sources: { ...contract.sources, iv: "ibkr" } },
      { ...contract, sources: { ...contract.sources, openInterest: "ibkr" } },
      { ...contract, sources: { ...contract.sources, delta: "yahoo" } },
      { ...contract, sources: { ...contract.sources, last: "yahoo" } },
      { ...contract, sources: undefined },
      { ...contract, flow: undefined },
      { ...contract, flow: { premium: 1, trades: 0, volume: 0 } },
      { ...contract, flow: { premium: -1, trades: 1, volume: 1 } },
      { ...contract, flow: { premium: 1, trades: 1, volume: 1.5 } },
    ])
      expect(OptionContractSchema.safeParse(broken).success).toBe(false);
  });

  it("lists the sources in priority order with display labels", () => {
    expect(OPTIONS_CHAIN_SOURCES).toEqual(["quantdata", "ibkr", "yahoo"]);
    expect(
      OPTIONS_CHAIN_SOURCES.map((id) => OPTIONS_CHAIN_SOURCE_LABELS[id])
    ).toEqual(["Quant Data", "IBKR", "Yahoo Finance"]);
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
      expiriesSources: ["quantdata", "ibkr", "yahoo"],
      expiry: "2026-11-06",
      flowFirstPageOnly: false,
      notes: ["Dummy note"],
      quoteTime: null,
      receivedAt: "2026-11-04T20:00:00.000Z",
      rows: [{ call: contract, put: null, strike: 100 }],
      sources,
      spot: 100,
      spotSource: "ibkr",
      symbol: "DEMO",
    };
    expect(OptionsChainOutputSchema.parse(output)).toEqual(output);
    // The single top-level source is gone.
    expect(
      OptionsChainOutputSchema.safeParse({ ...output, source: "yahoo" }).success
    ).toBe(false);
    expect(
      OptionsChainOutputSchema.parse({
        ...output,
        spot: null,
        spotSource: null,
      }).spotSource
    ).toBeNull();
    for (const broken of [
      { ...output, sources: sources.slice(0, 2) },
      { ...output, sources: [sources[1], sources[0], sources[2]] },
      { ...output, sources: [...sources, sources[2]] },
      {
        ...output,
        sources: [{ ...sources[0], status: "ok" }, sources[1], sources[2]],
      },
      {
        ...output,
        sources: [
          { ...sources[0], message: "x".repeat(201) },
          sources[1],
          sources[2],
        ],
      },
      {
        ...output,
        sources: [{ ...sources[0], url: "x" }, sources[1], sources[2]],
      },
      { ...output, spotSource: "model" },
      // The single expiry source is gone.
      { ...output, expiriesSource: "yahoo" },
      { ...output, expiriesSources: undefined },
      { ...output, expiriesSources: null },
      { ...output, expiriesSources: ["model"] },
      // Priority order, each source at most once.
      { ...output, expiriesSources: ["ibkr", "quantdata"] },
      { ...output, expiriesSources: ["yahoo", "yahoo"] },
      { ...output, expiriesSources: ["quantdata", "ibkr", "yahoo", "yahoo"] },
      { ...output, flowFirstPageOnly: undefined },
      { ...output, flowFirstPageOnly: "yes" },
    ])
      expect(OptionsChainOutputSchema.safeParse(broken).success).toBe(false);
  });

  it("limits a chain to 2000 rows and 400 expiries", () => {
    expect([OPTIONS_CHAIN_MAX_ROWS, OPTIONS_CHAIN_MAX_EXPIRIES]).toEqual([
      2000, 400,
    ]);
    const rows = OptionsChainOutputSchema.shape.rows;
    const row = { call: null, put: null, strike: 100 };
    expect(
      rows.safeParse(Array.from({ length: 2000 }, () => row)).success
    ).toBe(true);
    expect(
      rows.safeParse(Array.from({ length: 2001 }, () => row)).success
    ).toBe(false);
    const expiries = OptionsChainOutputSchema.shape.expiries;
    const expiry = { date: "2026-11-06", dte: 2 };
    expect(
      expiries.safeParse(Array.from({ length: 400 }, () => expiry)).success
    ).toBe(true);
    expect(
      expiries.safeParse(Array.from({ length: 401 }, () => expiry)).success
    ).toBe(false);
  });

  it("gives the expiry list the same source fields", () => {
    const listed = {
      currency: null,
      expiries: [],
      expiriesSources: [],
      quoteTime: null,
      receivedAt: "2026-11-04T20:00:00.000Z",
      sources: [
        {
          message: "Quant Data is not configured",
          source: "quantdata",
          status: "off",
        },
        {
          message: "IBKR is asked only in the US regular session",
          source: "ibkr",
          status: "off",
        },
        { message: null, source: "yahoo", status: "used" },
      ],
      spot: 100,
      spotSource: "yahoo",
      symbol: "DEMO",
    };
    expect(OptionsChainExpiriesOutputSchema.parse(listed)).toEqual(listed);
    for (const expiriesSources of [
      ["quantdata"],
      ["ibkr"],
      ["yahoo"],
      ["quantdata", "yahoo"],
      ["ibkr", "yahoo"],
    ])
      expect(
        OptionsChainExpiriesOutputSchema.parse({ ...listed, expiriesSources })
          .expiriesSources
      ).toEqual(expiriesSources);
    expect(
      OptionsChainExpiriesOutputSchema.safeParse({ ...listed, rows: [] })
        .success
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
