import { describe, expect, it } from "vitest";

import { appContract } from "../contract.ts";
import {
  OPTIONS_CHAIN_MAX_EXPIRIES,
  OPTIONS_CHAIN_MAX_ROWS,
  OPTIONS_CHAIN_SNAPSHOT_MAX_INT32,
  OPTIONS_CHAIN_SNAPSHOT_MAX_IV,
  OPTIONS_CHAIN_SOURCE_LABELS,
  OPTIONS_CHAIN_SOURCES,
  OptionContractSchema,
  OptionsChainExpiriesInputSchema,
  OptionsChainExpiriesOutputSchema,
  OptionsChainInputSchema,
  OptionsChainOutputSchema,
  OptionsChainSnapshotIngestInputSchema,
  OptionsChainSnapshotReadInputSchema,
  OptionsExpectedMoveOutputSchema,
  OptionsSpreadInputSchema,
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

  it("exposes live chain reads, spread pricing, plus snapshot ingest and read routes", () => {
    const routes = [
      appContract.optionsChain.expiries,
      appContract.optionsChain.chain,
      appContract.optionsChain.expectedMove,
      appContract.optionsChain.spread,
      appContract.optionsChain.ingestSnapshot,
      appContract.optionsChain.snapshot,
    ].map((procedure) => procedure["~orpc"].route);
    expect(routes.map((route) => [route.method, route.path])).toEqual([
      ["GET", "/options-chain/expiries"],
      ["GET", "/options-chain/chain"],
      ["GET", "/options-chain/expected-move"],
      ["GET", "/options-chain/spread"],
      ["POST", "/options-chain/snapshots/ingest"],
      ["GET", "/options-chain/snapshots"],
    ]);
  });

  it("validates snapshot ingest payloads, uniqueness, bounds and tradingDay alignment", () => {
    const valid = {
      expiry: "2027-01-15",
      quotes: [
        {
          ask: 4.5,
          bid: 4.2,
          iv: 0.22,
          last: 4.3,
          openInterest: 100,
          right: "call" as const,
          source: "ibkr" as const,
          strike: 500,
          volume: 25,
        },
      ],
      snapshotAt: "2026-11-19T20:30:00.000Z",
      source: "ibkr+yahoo",
      spot: 500.25,
      tradingDay: "2026-11-19",
      underlying: "qqq",
    };
    expect(OptionsChainSnapshotIngestInputSchema.parse(valid).underlying).toBe(
      "QQQ"
    );

    // Duplicate (strike, right) rejected
    expect(
      OptionsChainSnapshotIngestInputSchema.safeParse({
        ...valid,
        quotes: [valid.quotes[0], valid.quotes[0]],
      }).success
    ).toBe(false);

    // tradingDay more than 1 calendar day from snapshotAt rejected
    expect(
      OptionsChainSnapshotIngestInputSchema.safeParse({
        ...valid,
        tradingDay: "2026-11-17",
      }).success
    ).toBe(false);

    // Postgres int32 overflow and extreme IV rejected
    expect(
      OptionsChainSnapshotIngestInputSchema.safeParse({
        ...valid,
        quotes: [
          { ...valid.quotes[0], volume: OPTIONS_CHAIN_SNAPSHOT_MAX_INT32 + 1 },
        ],
      }).success
    ).toBe(false);
    expect(
      OptionsChainSnapshotIngestInputSchema.safeParse({
        ...valid,
        quotes: [{ ...valid.quotes[0], iv: OPTIONS_CHAIN_SNAPSHOT_MAX_IV + 1 }],
      }).success
    ).toBe(false);

    // Read input normalizes underlying and validates optional filters
    expect(
      OptionsChainSnapshotReadInputSchema.parse({
        expiry: "2027-01-15",
        snapshotAt: "2026-11-19T20:30:00.000Z",
        tradingDay: "2026-11-19",
        underlying: "spy",
      }).underlying
    ).toBe("SPY");
  });

  it("coerces spread strikes from query strings and refuses equal strikes", () => {
    const input = {
      expiry: "2027-01-15",
      longStrike: "640",
      right: "put",
      shortStrike: "595",
      symbol: "QQQ",
    };
    expect(OptionsSpreadInputSchema.parse(input)).toEqual({
      ...input,
      longStrike: 640,
      shortStrike: 595,
    });
    for (const bad of [
      { ...input, shortStrike: "640" },
      { ...input, longStrike: "abc" },
      { ...input, longStrike: "-5" },
      { ...input, right: "both" },
    ])
      expect(OptionsSpreadInputSchema.safeParse(bad).success).toBe(false);
  });

  it("enforces OptionsExpectedMoveOutputSchema bijection, spot range, and basis-straddle consistency", () => {
    const baseBand = {
      atmIv: 0.25,
      atmStrike: 500,
      basis: "atm_straddle_mid" as const,
      callPrice: 5.0,
      callQuoteSource: "ibkr" as const,
      expectedMove: 12.53,
      expectedMovePct: 0.025_06,
      expiryCloseAt: "2026-11-20T21:00:00.000Z",
      expiryCloseMs: 1_795_208_400_000,
      lowerBand: 487.47,
      putPrice: 5.0,
      putQuoteSource: "ibkr" as const,
      straddleLower: 490,
      straddlePct: 0.02,
      straddlePrice: 10.0,
      straddleUpper: 510,
      upperBand: 512.53,
    };
    const baseOutput = {
      band: baseBand,
      currency: "USD",
      dte: 16,
      expiries: [{ date: "2026-11-20", dte: 16 }],
      expiriesSources: ["yahoo" as const],
      expiry: "2026-11-20",
      notes: ["Research view only."],
      quoteTime: "2026-11-04T15:00:00.000Z",
      receivedAt: "2026-11-04T15:00:00.000Z",
      sources: [
        {
          message: "off",
          source: "quantdata" as const,
          status: "off" as const,
        },
        { message: null, source: "ibkr" as const, status: "used" as const },
        { message: null, source: "yahoo" as const, status: "used" as const },
      ],
      spot: 500,
      spotSource: "ibkr" as const,
      symbol: "SPY",
      unavailableReason: null,
    };

    expect(OptionsExpectedMoveOutputSchema.safeParse(baseOutput).success).toBe(
      true
    );
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: null,
        unavailableReason: null,
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        unavailableReason: "conflict",
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        spot: null,
        spotSource: null,
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...baseBand, lowerBand: 501, upperBand: 520 },
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...baseBand, straddlePrice: null },
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...baseBand, basis: "atm_iv_model" as const },
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...baseBand, straddleLower: 501, straddleUpper: 520 },
      }).success
    ).toBe(false);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...baseBand, straddleLower: 480, straddleUpper: 499 },
      }).success
    ).toBe(false);
    const modelBand = {
      ...baseBand,
      basis: "atm_iv_model" as const,
      callPrice: null,
      callQuoteSource: null,
      putPrice: null,
      putQuoteSource: null,
      straddleLower: null,
      straddlePct: null,
      straddlePrice: null,
      straddleUpper: null,
    };
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: modelBand,
      }).success
    ).toBe(true);
    expect(
      OptionsExpectedMoveOutputSchema.safeParse({
        ...baseOutput,
        band: { ...modelBand, atmIv: null },
      }).success
    ).toBe(false);
  });
});
