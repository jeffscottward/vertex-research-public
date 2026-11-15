import { describe, expect, it } from "vitest";

import {
  OPTIONS_CHAIN_SOURCES,
  OptionContractSourcesSchema,
  OptionsChainExpiriesOutputSchema,
  OptionsChainOutputSchema,
} from "./contracts/options-chain.ts";
import {
  hasChain,
  liveQuotes,
  mergeOptionsChain,
  mergeOptionsExpiries,
  OPTIONS_CHAIN_FLOW_HOURS,
  OPTIONS_CHAIN_PRIORITY,
  OPTIONS_CHAIN_RISK_FREE_RATE,
  type OptionsChainReads,
} from "./options-chain-merge.ts";
import type {
  OptionsAnalyticsSnapshot,
  OptionsChainSnapshot,
  OptionsQuoteSnapshot,
} from "./server/options-chain-source.ts";
import { parseYahooOptions } from "./server/options-chain-yahoo.ts";
import fixture from "./server/options-chain-yahoo.fixture.json" with {
  type: "json",
};

const NOW = new Date("2026-11-04T20:00:00.000Z");
const EXPIRY = "2026-11-06";

// Fictional values (symbol DEMO, Yahoo spot 100): calls 90, 100, 110 and puts 95, 100, 105.
const yahooSnapshot: OptionsChainSnapshot = parseYahooOptions(fixture, "DEMO");

const ibkrSnapshot: OptionsQuoteSnapshot = {
  asOf: "2026-11-04T19:59:58Z",
  expiries: ["2026-11-06", "2026-11-13"],
  expiry: EXPIRY,
  quotes: [
    // A strike only IBKR knows.
    { ask: 15.9, bid: 15.7, right: "call", strike: 85 },
    { ask: 1.42, bid: 1.38, right: "call", strike: 100 },
  ],
  spot: 100.2,
  warning: null,
};

const flow = { premium: 125_000, trades: 3, volume: 410 };
const QUANT_DATA_ROWS: OptionsAnalyticsSnapshot["rows"] = [
  {
    delta: 0.55,
    expiry: EXPIRY,
    flow,
    iv: 0.31,
    openInterest: 2500,
    right: "call",
    strike: 100,
  },
  {
    delta: null,
    expiry: EXPIRY,
    flow: null,
    iv: 0.29,
    openInterest: null,
    right: "put",
    strike: 100,
  },
  // A strike only Quant Data knows, without an IV.
  {
    delta: -0.9,
    expiry: EXPIRY,
    flow: { premium: 900, trades: 1, volume: 2 },
    iv: null,
    openInterest: 12,
    right: "put",
    strike: 115,
  },
  // Another expiry, which only Quant Data lists: never a row of EXPIRY.
  {
    delta: 0.5,
    expiry: "2026-11-27",
    flow: null,
    iv: 0.4,
    openInterest: 7,
    right: "call",
    strike: 100,
  },
];
// Quant Data is the first source: its spot (100.5) wins over IBKR (100.2) and Yahoo (100).
const quantDataSnapshot: OptionsAnalyticsSnapshot = {
  expiries: [EXPIRY, "2026-11-27"],
  flowFirstPageOnly: false,
  rows: QUANT_DATA_ROWS,
  spot: 100.5,
  warning: null,
};

const ok = <Data>(data: Data) => ({ data, status: "ok" }) as const;
const off = { message: "Not asked", status: "off" } as const;
const failed = { message: "Request failed", status: "failed" } as const;

const reads = (
  overrides: Partial<OptionsChainReads> = {}
): OptionsChainReads => ({
  quantdata: ok(quantDataSnapshot),
  ibkr: ok(ibkrSnapshot),
  symbol: "DEMO",
  yahoo: ok(yahooSnapshot),
  ...overrides,
});

const yahooOnly = reads({ ibkr: off, quantdata: off });

describe("OPTIONS_CHAIN_PRIORITY", () => {
  it("is the one source order per field and names only contract sources", () => {
    expect(OPTIONS_CHAIN_PRIORITY).toEqual({
      delta: ["quantdata", "model"],
      expiries: ["quantdata", "ibkr", "yahoo"],
      iv: ["quantdata", "yahoo"],
      openInterest: ["quantdata", "yahoo"],
      // Quant Data has no live bid and ask.
      quote: ["ibkr", "yahoo"],
      spot: ["quantdata", "ibkr", "yahoo"],
    });
    // Quant Data first wherever it has the value.
    expect(OPTIONS_CHAIN_PRIORITY.spot).toEqual(OPTIONS_CHAIN_SOURCES);
    expect(OPTIONS_CHAIN_PRIORITY.expiries).toEqual(OPTIONS_CHAIN_SOURCES);
    for (const field of ["quote", "iv", "openInterest", "delta"] as const)
      expect(OptionContractSourcesSchema.shape[field].unwrap().options).toEqual(
        OPTIONS_CHAIN_PRIORITY[field]
      );
    expect(OptionsChainOutputSchema.shape.spotSource.unwrap().options).toEqual(
      OPTIONS_CHAIN_PRIORITY.spot
    );
    expect(
      OptionsChainOutputSchema.shape.expiriesSources.element.options
    ).toEqual(OPTIONS_CHAIN_PRIORITY.expiries);
    expect(OPTIONS_CHAIN_FLOW_HOURS).toBe(24);
  });
});

describe("mergeOptionsChain", () => {
  it("serves the Yahoo snapshot alone with Black-Scholes Greeks", () => {
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(yahooOnly, EXPIRY, NOW)
    );
    expect(output.rows.map((row) => row.strike)).toEqual([
      90, 95, 100, 105, 110,
    ]);
    expect(output.expiries.map((expiry) => expiry.dte)).toEqual([
      2, 16, 44, 72,
    ]);
    expect(output).toMatchObject({
      assumptions: {
        dayCount: "act/365",
        dividendYield: 0.01,
        model: "black-scholes-european",
        riskFreeRate: OPTIONS_CHAIN_RISK_FREE_RATE,
      },
      currency: "USD",
      dte: 2,
      expiriesSources: ["yahoo"],
      expiry: EXPIRY,
      quoteTime: "2026-11-04T20:00:00.000Z",
      receivedAt: NOW.toISOString(),
      sources: [
        { message: "Not asked", source: "quantdata", status: "off" },
        { message: "Not asked", source: "ibkr", status: "off" },
        { message: null, source: "yahoo", status: "used" },
      ],
      spot: 100,
      spotSource: "yahoo",
      symbol: "DEMO",
    });
    const atm = output.rows[2];
    expect(atm?.call).toMatchObject({
      ask: 1.4,
      bid: 1.3,
      contractSymbol: "DEMO261106C00100000",
      flow: null,
      iv: 0.28,
      openInterest: 2210,
      sources: {
        delta: "model",
        iv: "yahoo",
        openInterest: "yahoo",
        quote: "yahoo",
      },
      volume: 812,
    });
    expect(atm?.call?.greeks?.delta).toBeGreaterThan(0.45);
    expect(atm?.call?.greeks?.delta).toBeLessThan(0.6);
    expect(atm?.put?.greeks?.delta).toBeLessThan(0);
    expect(atm?.call?.greeks?.theta).toBeLessThan(0);
    expect(atm?.call?.greeks?.gamma).toBeGreaterThan(0.1);
    expect(atm?.put?.greeks?.gamma).toBeGreaterThan(0.1);
    // Yahoo sent a negative bid: the pair still comes from Yahoo, with no bid.
    expect(atm?.put).toMatchObject({ ask: 1.25, bid: null });
    expect(atm?.put?.sources.quote).toBe("yahoo");
    expect(output.rows[1]?.call).toBeNull();
    // A placeholder IV: no Greeks, so no delta source either.
    expect(output.rows[4]?.call).toMatchObject({
      greeks: null,
      iv: null,
      sources: { delta: null, iv: null, quote: "yahoo" },
    });
    const notes = output.notes.join(" ");
    expect(notes).toContain(
      "Spot price: Yahoo Finance. Expiry list: Yahoo Finance. Bid and ask: Yahoo Finance for 6 (of 6 contracts)."
    );
    expect(notes).toContain("can be delayed by 15 minutes or more");
    expect(notes).toContain(
      "IV: Yahoo Finance for 5. Open interest: Yahoo Finance for 6."
    );
    expect(notes).toContain("from the chosen IV: risk-free rate 4.00 %");
    expect(notes).toContain("dividend yield 1.00 % (trailing)");
    expect(notes).toContain("1 contracts have no usable IV");
    expect(notes).not.toContain("Quant Data");
    expect(notes).not.toContain("IBKR");
  });

  it("takes each value from the first source of its priority order", () => {
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(reads(), EXPIRY, NOW)
    );
    expect(output.rows.map((row) => row.strike)).toEqual([
      85, 90, 95, 100, 105, 110, 115,
    ]);
    expect(output).toMatchObject({
      // The union of the lists: Quant Data (11-06, 11-27), IBKR (11-06, 11-13) and Yahoo.
      expiries: [
        { date: "2026-11-06", dte: 2 },
        { date: "2026-11-13", dte: 9 },
        { date: "2026-11-20", dte: 16 },
        { date: "2026-11-27", dte: 23 },
        { date: "2026-12-18", dte: 44 },
        { date: "2027-01-15", dte: 72 },
      ],
      expiriesSources: ["quantdata", "ibkr", "yahoo"],
      // Quant Data sends no quote time.
      quoteTime: null,
      sources: [
        { message: null, source: "quantdata", status: "used" },
        { message: null, source: "ibkr", status: "used" },
        { message: null, source: "yahoo", status: "used" },
      ],
      spot: 100.5,
      spotSource: "quantdata",
    });
    const atm = output.rows[3];
    // IBKR quote, Quant Data IV, delta, open interest and flow; the rest stays Yahoo.
    expect(atm?.call).toMatchObject({
      ask: 1.42,
      bid: 1.38,
      change: yahooSnapshot.calls[1]?.change,
      contractSymbol: "DEMO261106C00100000",
      flow,
      // 100 is below the Quant Data spot of 100.5.
      inTheMoney: true,
      iv: 0.31,
      last: yahooSnapshot.calls[1]?.last,
      lastTradeAt: yahooSnapshot.calls[1]?.lastTradeAt,
      openInterest: 2500,
      sources: {
        delta: "quantdata",
        iv: "quantdata",
        openInterest: "quantdata",
        quote: "ibkr",
      },
      volume: 812,
    });
    expect(atm?.call?.greeks?.delta).toBe(0.55);
    expect(atm?.call?.greeks?.gamma).toBeGreaterThan(0);
    // Quant Data has the IV only: Yahoo fills the quote and open interest, the model the delta.
    expect(atm?.put).toMatchObject({
      ask: 1.25,
      flow: null,
      iv: 0.29,
      openInterest: 1500,
      sources: {
        delta: "model",
        iv: "quantdata",
        openInterest: "yahoo",
        quote: "yahoo",
      },
    });
    expect(atm?.put?.greeks?.delta).toBeLessThan(0);
    const notes = output.notes.join(" ");
    expect(notes).toContain(
      "Spot price: Quant Data. Expiry list: Quant Data, IBKR, Yahoo Finance. Bid and ask: IBKR live quotes for 2, Yahoo Finance for 5 (of 8 contracts)."
    );
    expect(notes).toContain(
      "IV: Quant Data for 2, Yahoo Finance for 3. Open interest: Quant Data for 2, Yahoo Finance for 5."
    );
    expect(notes).toContain(
      "Quant Data open interest and flow come from the order-flow prints of the last 24 hours"
    );
    expect(notes).toContain("Delta comes from Quant Data for 1 contracts.");
    expect(notes).toContain("3 contracts have no usable IV");
  });

  it("gives a contract only IBKR or Quant Data knows its own row", () => {
    const output = mergeOptionsChain(reads(), EXPIRY, NOW);
    expect(output.rows[0]).toEqual({
      call: {
        ask: 15.9,
        bid: 15.7,
        change: null,
        contractSymbol: "DEMO261106C00085000",
        flow: null,
        greeks: null,
        inTheMoney: true,
        iv: null,
        last: null,
        lastTradeAt: null,
        openInterest: null,
        sources: { delta: null, iv: null, openInterest: null, quote: "ibkr" },
        volume: null,
      },
      put: null,
      strike: 85,
    });
    // Quant Data has a delta but no IV: no Greeks, so the delta is not shown.
    expect(output.rows[6]).toEqual({
      call: null,
      put: {
        ask: null,
        bid: null,
        change: null,
        contractSymbol: "DEMO261106P00115000",
        flow: { premium: 900, trades: 1, volume: 2 },
        greeks: null,
        inTheMoney: true,
        iv: null,
        last: null,
        lastTradeAt: null,
        openInterest: 12,
        sources: {
          delta: null,
          iv: null,
          openInterest: "quantdata",
          quote: null,
        },
        volume: null,
      },
      strike: 115,
    });
  });

  it("builds the OCC-style symbol of a contract Yahoo does not list", () => {
    // Root without the class separator, YYMMDD, C or P, strike in thousandths.
    const output = mergeOptionsChain(
      {
        ibkr: ok({
          ...ibkrSnapshot,
          expiry: "2027-01-15",
          quotes: [
            { ask: 0.4, bid: 0.3, right: "put", strike: 17.5 },
            { ask: 2.4, bid: 2.3, right: "call", strike: 1250 },
          ],
        }),
        quantdata: off,
        symbol: "BRK.B",
        yahoo: failed,
      },
      "2027-01-15",
      NOW
    );
    expect(
      output.rows.map((row) => (row.call ?? row.put)?.contractSymbol)
    ).toEqual(["BRKB270115P00017500", "BRKB270115C01250000"]);
  });

  it("serves IBKR and Quant Data alone when Yahoo failed", () => {
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(reads({ yahoo: failed }), EXPIRY, NOW)
    );
    expect(output.rows.map((row) => row.strike)).toEqual([85, 100, 115]);
    expect(output).toMatchObject({
      assumptions: { dividendYield: 0 },
      currency: null,
      expiriesSources: ["quantdata", "ibkr"],
      sources: [
        { source: "quantdata", status: "used" },
        { source: "ibkr", status: "used" },
        { message: "Request failed", source: "yahoo", status: "failed" },
      ],
      spotSource: "quantdata",
      symbol: "DEMO",
    });
    expect(output.expiries.map((item) => item.date)).toEqual([
      "2026-11-06",
      "2026-11-13",
      "2026-11-27",
    ]);
    expect(output.rows[1]?.call).toMatchObject({
      ask: 1.42,
      contractSymbol: "DEMO261106C00100000",
      inTheMoney: true,
      last: null,
      sources: { delta: "quantdata", quote: "ibkr" },
    });
    // 100 is below the Quant Data spot of 100.5: the put is out of the money.
    expect(output.rows[1]?.put).toMatchObject({
      inTheMoney: false,
      sources: { delta: "model", iv: "quantdata", quote: null },
    });
    const notes = output.notes.join(" ");
    expect(notes).toContain(
      "Bid and ask: IBKR live quotes for 2 (of 4 contracts)."
    );
    expect(notes).toContain(
      "IV: Quant Data for 2. Open interest: Quant Data for 2."
    );
    expect(notes).toContain("dividend yield 0.00 % (no dividend data)");
    expect(notes).not.toContain("Yahoo");
  });

  it("Quant Data alone serves the chain when IBKR and Yahoo both failed", () => {
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(reads({ ibkr: failed, yahoo: failed }), EXPIRY, NOW)
    );
    expect(output).toMatchObject({
      currency: null,
      expiries: [
        { date: "2026-11-06", dte: 2 },
        { date: "2026-11-27", dte: 23 },
      ],
      expiriesSources: ["quantdata"],
      quoteTime: null,
      sources: [
        { message: null, source: "quantdata", status: "used" },
        { message: "Request failed", source: "ibkr", status: "failed" },
        { message: "Request failed", source: "yahoo", status: "failed" },
      ],
      spot: 100.5,
      spotSource: "quantdata",
    });
    expect(output.rows.map((row) => row.strike)).toEqual([100, 115]);
    // IV, delta, open interest and flow; no bid, ask, last or volume.
    expect(output.rows[0]?.call).toMatchObject({
      ask: null,
      bid: null,
      change: null,
      contractSymbol: "DEMO261106C00100000",
      flow,
      inTheMoney: true,
      iv: 0.31,
      last: null,
      lastTradeAt: null,
      openInterest: 2500,
      sources: {
        delta: "quantdata",
        iv: "quantdata",
        openInterest: "quantdata",
        quote: null,
      },
      volume: null,
    });
    expect(output.rows[0]?.call?.greeks?.delta).toBe(0.55);
    expect(output.rows[0]?.put).toMatchObject({
      ask: null,
      bid: null,
      contractSymbol: "DEMO261106P00100000",
      inTheMoney: false,
      sources: { delta: "model", iv: "quantdata", quote: null },
    });
    const notes = output.notes.join(" ");
    expect(notes).toContain(
      "Spot price: Quant Data. Expiry list: Quant Data. Bid and ask: no source (of 3 contracts)."
    );
    expect(notes).toContain(
      "Quant Data IV, delta and spot can be up to about 6 minutes old"
    );
    expect(notes).not.toContain("IBKR");
    expect(notes).not.toContain("Yahoo");
  });

  it("falls back for the spot price: Quant Data, then IBKR, then Yahoo", () => {
    expect(mergeOptionsChain(reads(), EXPIRY, NOW)).toMatchObject({
      quoteTime: null,
      spot: 100.5,
      spotSource: "quantdata",
    });
    const noQuantDataSpot = reads({
      quantdata: ok({ ...quantDataSnapshot, spot: null }),
    });
    // The quote time follows the source of the spot.
    expect(mergeOptionsChain(noQuantDataSpot, EXPIRY, NOW)).toMatchObject({
      quoteTime: "2026-11-04T19:59:58Z",
      spot: 100.2,
      spotSource: "ibkr",
    });
    expect(
      mergeOptionsChain(reads({ quantdata: off }), EXPIRY, NOW)
    ).toMatchObject({ spot: 100.2, spotSource: "ibkr" });
    expect(
      mergeOptionsChain(
        { ...noQuantDataSpot, ibkr: ok({ ...ibkrSnapshot, spot: null }) },
        EXPIRY,
        NOW
      )
    ).toMatchObject({
      quoteTime: "2026-11-04T20:00:00.000Z",
      spot: 100,
      spotSource: "yahoo",
    });
    // A put only Quant Data knows is out of the money without any spot.
    const none = mergeOptionsChain(
      reads({
        ibkr: off,
        quantdata: ok({ ...quantDataSnapshot, spot: null }),
        yahoo: failed,
      }),
      EXPIRY,
      NOW
    );
    expect(none).toMatchObject({
      quoteTime: null,
      spot: null,
      spotSource: null,
    });
    expect(none.rows.at(-1)?.put?.inTheMoney).toBe(false);
  });

  it("shows no Greeks without a spot price or after the close, and drops past expiries", () => {
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(
        reads({
          ibkr: off,
          quantdata: ok({ ...quantDataSnapshot, spot: null }),
          yahoo: ok({ ...yahooSnapshot, dividendYield: null, spot: null }),
        }),
        EXPIRY,
        new Date("2026-11-21T12:00:00Z")
      )
    );
    expect(
      output.rows.every(
        (row) =>
          (row.put?.greeks ?? null) === null &&
          (row.call?.greeks ?? null) === null
      )
    ).toBe(true);
    // Past expiries drop out; the expiry being shown stays so the selector can show it.
    // 2026-11-27 is the open expiry that only Quant Data lists.
    expect(output.expiries.map((expiry) => expiry.date)).toEqual([
      "2026-11-06",
      "2026-11-27",
      "2026-12-18",
      "2027-01-15",
    ]);
    expect(output.expiriesSources).toEqual(["quantdata", "yahoo"]);
    expect(output.assumptions.dividendYield).toBe(0);
    expect(output.dte).toBe(0);
    // Every conditional note at once still fits the contract limit.
    expect(output.notes).toHaveLength(10);
    const notes = output.notes.join(" ");
    expect(notes).toContain("This expiry has closed");
    expect(notes).toContain("No spot price");
    expect(notes).not.toContain("Spot price:");
    const complete = mergeOptionsChain(
      {
        ...yahooOnly,
        yahoo: ok({ ...yahooSnapshot, calls: yahooSnapshot.calls.slice(0, 2) }),
      },
      EXPIRY,
      NOW
    );
    expect(complete.notes.join(" ")).not.toContain("no usable IV");
  });

  it("reports a source that answered without a usable value as empty", () => {
    const frozen = { ...ibkrSnapshot, quotes: [], spot: null };
    const output = mergeOptionsChain(
      reads({
        ibkr: ok(frozen),
        quantdata: ok({
          expiries: [],
          flowFirstPageOnly: false,
          rows: [],
          spot: null,
          warning: null,
        }),
      }),
      EXPIRY,
      NOW
    );
    // Nothing of an IBKR answer without a live value is used: Yahoo lists the expiries.
    expect(output).toMatchObject({
      expiriesSources: ["yahoo"],
      sources: [
        {
          message: "Quant Data answered without a usable value",
          source: "quantdata",
          status: "empty",
        },
        {
          message: "IBKR answered without a live quote",
          source: "ibkr",
          status: "empty",
        },
        { message: null, source: "yahoo", status: "used" },
      ],
      spotSource: "yahoo",
    });
    expect(output.expiries).toHaveLength(4);
    expect(output.rows[2]?.call?.sources.quote).toBe("yahoo");
    // The adapter's reason replaces the default text.
    const stale = mergeOptionsChain(
      reads({ ibkr: ok({ ...frozen, warning: "IBKR sent an old copy" }) }),
      EXPIRY,
      NOW
    );
    expect(stale.sources[1]).toEqual({
      message: "IBKR sent an old copy",
      source: "ibkr",
      status: "empty",
    });
    // Yahoo answered for another expiry: only its expiry list is used.
    const elsewhere = mergeOptionsChain(
      reads({
        yahoo: ok({ ...yahooSnapshot, currency: null, expiry: "2026-11-20" }),
      }),
      EXPIRY,
      NOW
    );
    expect(elsewhere.sources[2]).toEqual({
      message: null,
      source: "yahoo",
      status: "used",
    });
    expect(elsewhere.expiriesSources).toEqual(["quantdata", "ibkr", "yahoo"]);
    expect(elsewhere.rows.map((row) => row.strike)).toEqual([85, 100, 115]);
    // Yahoo answered with nothing at all: empty.
    const nothing = mergeOptionsChain(
      reads({
        yahoo: ok({
          ...yahooSnapshot,
          calls: [],
          currency: null,
          expiries: [],
          expiry: null,
          puts: [],
          spot: null,
        }),
      }),
      EXPIRY,
      NOW
    );
    expect(nothing.sources[2]).toEqual({
      message: "Yahoo Finance has no option rows for this expiry",
      source: "yahoo",
      status: "empty",
    });
    expect(nothing.expiriesSources).toEqual(["quantdata", "ibkr"]);
    // With a currency Yahoo is used, but no delayed market value of it is shown.
    const currencyOnly = mergeOptionsChain(
      reads({ yahoo: ok({ ...yahooSnapshot, expiry: "2026-11-20" }) }),
      EXPIRY,
      NOW
    );
    expect(currencyOnly.sources[2].status).toBe("used");
    expect(currencyOnly.notes.join(" ")).not.toContain("delayed");
  });

  it("shows a partial failure of a used source and caps the message", () => {
    const output = mergeOptionsChain(
      reads({
        quantdata: ok({
          ...quantDataSnapshot,
          warning: `QuantData orderFlow: HTTP 500.${"x".repeat(300)}`,
        }),
        yahoo: { message: "y".repeat(300), status: "failed" },
      }),
      EXPIRY,
      NOW
    );
    expect(output.sources[0].status).toBe("used");
    expect(output.sources[0].message).toHaveLength(200);
    expect(output.sources[0].message).toContain("orderFlow: HTTP 500.");
    expect(output.sources[2].message).toBe("y".repeat(200));
    expect(OptionsChainOutputSchema.safeParse(output).success).toBe(true);
  });

  it("ignores IBKR quotes of another expiry and Yahoo rows without any price", () => {
    const output = mergeOptionsChain(
      reads({
        ibkr: ok({ ...ibkrSnapshot, expiry: "2026-11-13" }),
        quantdata: off,
        yahoo: ok({
          ...yahooSnapshot,
          calls: yahooSnapshot.calls.map((quote) => ({
            ...quote,
            ask: null,
            bid: null,
          })),
        }),
      }),
      EXPIRY,
      NOW
    );
    expect(output.rows.map((row) => row.strike)).toEqual([
      90, 95, 100, 105, 110,
    ]);
    expect(output.rows[2]?.call).toMatchObject({
      ask: null,
      bid: null,
      sources: { quote: null },
    });
    // The IBKR spot and expiry list are still used.
    expect(output).toMatchObject({
      expiriesSources: ["ibkr", "yahoo"],
      spot: 100.2,
      spotSource: "ibkr",
    });
    expect(output.sources[1].status).toBe("used");
    expect(output.notes.join(" ")).toContain(
      "Bid and ask: Yahoo Finance for 3 (of 6 contracts)."
    );
    const unquoted = mergeOptionsChain(
      reads({
        ibkr: off,
        quantdata: off,
        yahoo: ok({
          ...yahooSnapshot,
          calls: [],
          puts: [
            {
              ...yahooSnapshot.puts[0]!,
              ask: null,
              bid: null,
              iv: null,
              openInterest: null,
            },
          ],
        }),
      }),
      EXPIRY,
      NOW
    );
    expect(unquoted.notes.join(" ")).toContain(
      "Bid and ask: no source (of 1 contracts)."
    );
    expect(unquoted.notes.join(" ")).toContain(
      "IV: no source. Open interest: no source."
    );
  });
});

describe("mergeOptionsChain value rules", () => {
  const atm = (output: ReturnType<typeof mergeOptionsChain>) =>
    output.rows.find((row) => row.strike === 100);

  it("Greeks follow the chosen IV: the Quant Data IV, else the Yahoo IV", () => {
    // Call 100, Quant Data spot 100.5, 2 days to expiry: Quant Data IV 0.31, Yahoo IV 0.28.
    const fromQuantData = atm(mergeOptionsChain(reads(), EXPIRY, NOW))?.call;
    expect(fromQuantData?.iv).toBe(0.31);
    expect(fromQuantData?.greeks?.delta).toBe(0.55);
    expect(fromQuantData?.greeks?.gamma).toBeCloseTo(0.166_581_613_61, 12);
    expect(fromQuantData?.greeks?.theta).toBeCloseTo(-0.226_254_272_538, 12);
    expect(fromQuantData?.greeks?.vega).toBeCloseTo(0.029_175_133_758, 12);
    expect(fromQuantData?.greeks?.rho).toBeCloseTo(0.003_262_940_417, 12);
    // Quant Data without a row for the contract: the same spot, the Yahoo IV.
    const fromYahoo = atm(
      mergeOptionsChain(
        reads({ quantdata: ok({ ...quantDataSnapshot, rows: [] }) }),
        EXPIRY,
        NOW
      )
    )?.call;
    expect(fromYahoo?.iv).toBe(0.28);
    expect(fromYahoo?.greeks?.delta).toBeCloseTo(0.601_242_372_782, 12);
    expect(fromYahoo?.greeks?.gamma).toBeCloseTo(0.183_405_440_595, 12);
    expect(fromYahoo?.greeks?.theta).toBeCloseTo(-0.203_790_642_642, 12);
    expect(fromYahoo?.greeks?.vega).toBeCloseTo(0.029_013_113_921, 12);
    expect(fromYahoo?.greeks?.rho).toBeCloseTo(0.003_317_224_116, 12);
  });

  it("a Yahoo row with bid 0 and ask 0 plus an IBKR live quote shows the IBKR quote", () => {
    const zeroed = ok({
      ...yahooSnapshot,
      calls: yahooSnapshot.calls.map((quote) => ({
        ...quote,
        ask: 0,
        bid: 0,
      })),
    });
    expect(
      atm(mergeOptionsChain(reads({ yahoo: zeroed }), EXPIRY, NOW))?.call
    ).toMatchObject({ ask: 1.42, bid: 1.38, sources: { quote: "ibkr" } });
    // Without the IBKR quote the Yahoo zeros stay, tagged yahoo.
    expect(
      atm(mergeOptionsChain(reads({ ibkr: off, yahoo: zeroed }), EXPIRY, NOW))
        ?.call
    ).toMatchObject({ ask: 0, bid: 0, sources: { quote: "yahoo" } });
  });

  it("Quant Data delta is used only when its sign fits the right, else the model delta", () => {
    const row = (
      right: "call" | "put",
      strike: number,
      delta: number,
      iv: number | null = null
    ) => ({
      delta,
      expiry: EXPIRY,
      flow: null,
      iv,
      openInterest: null,
      right,
      strike,
    });
    const output = mergeOptionsChain(
      reads({
        ibkr: off,
        quantdata: ok({
          ...quantDataSnapshot,
          rows: [
            // The limits of each range fit.
            row("call", 90, 1),
            row("put", 95, 0),
            row("call", 100, -0.45),
            row("put", 100, 0.45),
            row("put", 105, -1.5),
            row("call", 110, 1.2, 0.3),
          ],
          spot: null,
        }),
      }),
      EXPIRY,
      NOW
    );
    const tagged = output.rows.flatMap((item) =>
      (["call", "put"] as const).flatMap((right) => {
        const contract = item[right];
        return contract === null
          ? []
          : [[right, item.strike, contract.sources.delta] as const];
      })
    );
    expect(tagged).toEqual([
      ["call", 90, "quantdata"],
      ["put", 95, "quantdata"],
      ["call", 100, "model"],
      ["put", 100, "model"],
      ["put", 105, "model"],
      ["call", 110, "model"],
    ]);
    expect(output.rows[0]?.call?.greeks?.delta).toBe(1);
    expect(output.rows[1]?.put?.greeks?.delta).toBe(0);
    // The model delta has the sign of the right.
    expect(atm(output)?.call?.greeks?.delta).toBeGreaterThan(0);
    expect(atm(output)?.put?.greeks?.delta).toBeLessThan(0);
    expect(output.rows[4]?.call?.greeks?.delta).toBeLessThan(1);
    expect(output.notes.join(" ")).toContain(
      "Delta comes from Quant Data for 2 contracts."
    );
  });

  it("inTheMoney follows the spot shown, and Yahoo's flag only without a spot", () => {
    // Quant Data spot 100.5; Yahoo (spot 100) flags the 100 call out of and the 100 put in the
    // money.
    const live = atm(mergeOptionsChain(reads(), EXPIRY, NOW));
    expect(live?.call?.inTheMoney).toBe(true);
    expect(live?.put?.inTheMoney).toBe(false);
    const unpriced = mergeOptionsChain(
      reads({
        ibkr: off,
        quantdata: off,
        yahoo: ok({ ...yahooSnapshot, spot: null }),
      }),
      EXPIRY,
      NOW
    );
    expect(atm(unpriced)?.call?.inTheMoney).toBe(false);
    expect(atm(unpriced)?.put?.inTheMoney).toBe(true);
    expect(unpriced.rows[0]?.call?.inTheMoney).toBe(true);
  });

  it("says how old the values of each source can be, in priority order", () => {
    const quantData =
      "Quant Data IV, delta and spot can be up to about 6 minutes old (5 min shared cache plus 60 s here).";
    const ibkr =
      "IBKR live quotes and spot can be about 90 seconds old (30 s service cache plus 60 s here).";
    const yahoo =
      "Yahoo Finance values can be delayed by 15 minutes or more; its bid and ask can show 0 outside market hours.";
    // One note for the age of the values of all three sources; it fits the contract limit.
    const all = OptionsChainOutputSchema.parse(
      mergeOptionsChain(reads(), EXPIRY, NOW)
    );
    expect(all.notes[1]).toBe(`${quantData} ${ibkr} ${yahoo}`);
    expect(all.notes[1]?.length).toBeLessThanOrEqual(300);
    expect(
      mergeOptionsChain(reads({ yahoo: failed }), EXPIRY, NOW).notes[1]
    ).toBe(`${quantData} ${ibkr}`);
    expect(mergeOptionsChain(yahooOnly, EXPIRY, NOW).notes[1]).toBe(yahoo);
    // The IBKR spot alone counts: no IBKR quote, no Quant Data.
    expect(
      mergeOptionsChain(
        reads({ ibkr: ok({ ...ibkrSnapshot, quotes: [] }), quantdata: off }),
        EXPIRY,
        NOW
      ).notes[1]
    ).toBe(`${ibkr} ${yahoo}`);
    // An IBKR quote counts without the IBKR spot (the spot is Quant Data's).
    expect(
      mergeOptionsChain(
        reads({ ibkr: ok({ ...ibkrSnapshot, spot: null }), yahoo: failed }),
        EXPIRY,
        NOW
      ).notes[1]
    ).toBe(`${quantData} ${ibkr}`);
    // Quant Data with the spot only, with an IV only and with a delta only.
    const only = (snapshot: Partial<OptionsAnalyticsSnapshot>) =>
      mergeOptionsChain(
        reads({
          ibkr: off,
          quantdata: ok({ ...quantDataSnapshot, ...snapshot }),
        }),
        EXPIRY,
        NOW
      ).notes[1];
    const row = QUANT_DATA_ROWS[0]!;
    expect(only({ rows: [] })).toBe(`${quantData} ${yahoo}`);
    expect(
      only({ rows: [{ ...row, delta: null, flow: null }], spot: null })
    ).toBe(`${quantData} ${yahoo}`);
    expect(only({ rows: [{ ...row, flow: null, iv: null }], spot: null })).toBe(
      `${quantData} ${yahoo}`
    );
    // Quant Data open interest and flow alone are not IV, delta or spot.
    expect(
      only({ rows: [{ ...row, delta: null, iv: null }], spot: null })
    ).toBe(yahoo);
  });

  it("says when the Quant Data flow is the first provider page only", () => {
    const warning =
      "Quant Data order flow: first provider page only, so flow totals can be too low";
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(
        reads({
          quantdata: ok({
            ...quantDataSnapshot,
            flowFirstPageOnly: true,
            warning,
          }),
        }),
        EXPIRY,
        NOW
      )
    );
    expect(output.flowFirstPageOnly).toBe(true);
    expect(output.sources[0]).toEqual({
      message: warning,
      source: "quantdata",
      status: "used",
    });
    expect(output.notes.join(" ")).toContain(
      "order-flow prints of the last 24 hours, so a contract without a print shows neither. Only the first provider page of prints was read: flow totals can be too low and contracts can be missing."
    );
    const complete = mergeOptionsChain(reads(), EXPIRY, NOW);
    expect(complete.flowFirstPageOnly).toBe(false);
    expect(complete.notes.join(" ")).not.toContain("first provider page");
    expect(mergeOptionsChain(yahooOnly, EXPIRY, NOW).flowFirstPageOnly).toBe(
      false
    );
  });
});

describe("mergeOptionsChain contract limits", () => {
  const manyCalls = (count: number): OptionsChainSnapshot["calls"] =>
    Array.from({ length: count }, (_, index) => ({
      ...yahooSnapshot.calls[0]!,
      contractSymbol: `DEMO${index}`,
      strike: index + 1,
    }));

  it("keeps the 2000 strikes nearest the spot, or the lowest 2000 without a spot", () => {
    const wide = { ...yahooSnapshot, calls: manyCalls(2001), puts: [] };
    const near = OptionsChainOutputSchema.parse(
      mergeOptionsChain(
        reads({
          ibkr: off,
          quantdata: off,
          yahoo: ok({ ...wide, spot: 1500 }),
        }),
        EXPIRY,
        NOW
      )
    );
    expect(near.rows).toHaveLength(2000);
    // Strike 1 is the farthest from 1500.
    expect([near.rows[0]?.strike, near.rows.at(-1)?.strike]).toEqual([2, 2001]);
    expect(near.notes[0]).toContain("(of 2000 contracts)");
    const unpriced = OptionsChainOutputSchema.parse(
      mergeOptionsChain(
        reads({
          ibkr: off,
          quantdata: off,
          yahoo: ok({ ...wide, spot: null }),
        }),
        EXPIRY,
        NOW
      )
    );
    expect([unpriced.rows[0]?.strike, unpriced.rows.at(-1)?.strike]).toEqual([
      1, 2000,
    ]);
    // At the limit nothing is cut.
    expect(
      mergeOptionsChain(
        {
          ...yahooOnly,
          yahoo: ok({ ...yahooSnapshot, calls: manyCalls(2000), puts: [] }),
        },
        EXPIRY,
        NOW
      ).rows
    ).toHaveLength(2000);
  });

  it("lists at most 400 expiries and always the one being shown", () => {
    const day = (index: number): string =>
      new Date(Date.parse(`${EXPIRY}T00:00:00Z`) + index * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const dates = Array.from({ length: 450 }, (_, index) => day(index));
    const listed = (expiry: string | null) =>
      OptionsChainExpiriesOutputSchema.parse(
        mergeOptionsExpiries(
          {
            ...yahooOnly,
            yahoo: ok({ ...yahooSnapshot, expiries: dates, expiry }),
          },
          expiry,
          NOW
        )
      ).expiries.map((item) => item.date);
    expect(listed(EXPIRY)).toEqual(dates.slice(0, 400));
    expect(listed(null)).toEqual(dates.slice(0, 400));
    // A far expiry being shown takes the last place.
    expect(listed(day(449))).toEqual([...dates.slice(0, 399), day(449)]);
    // A source whose expiries are all cut is not named as a source of the list.
    const cut = mergeOptionsExpiries(
      reads({
        ibkr: off,
        quantdata: ok({ ...quantDataSnapshot, expiries: [day(500)] }),
        yahoo: ok({ ...yahooSnapshot, expiries: dates }),
      }),
      EXPIRY,
      NOW
    );
    expect(cut.expiries).toHaveLength(400);
    expect(cut.expiriesSources).toEqual(["yahoo"]);
  });

  it("cuts an IBKR list of more than 400 expirations instead of refusing it", () => {
    const dates = Array.from({ length: 401 }, (_, index) =>
      new Date(Date.parse(`${EXPIRY}T00:00:00Z`) + index * 86_400_000)
        .toISOString()
        .slice(0, 10)
    );
    const output = OptionsChainOutputSchema.parse(
      mergeOptionsChain(
        reads({ ibkr: ok({ ...ibkrSnapshot, expiries: dates }) }),
        EXPIRY,
        NOW
      )
    );
    // The lists of the other sources are inside the same 401 days.
    expect(output.expiriesSources).toEqual(["quantdata", "ibkr", "yahoo"]);
    expect(output.expiries.map((item) => item.date)).toEqual(
      dates.slice(0, 400)
    );
  });

  it("lists the expiry being shown when no list has it", () => {
    const output = mergeOptionsChain(
      reads({
        ibkr: ok({
          ...ibkrSnapshot,
          expiries: ["2026-11-05", "2026-11-13"],
        }),
        quantdata: ok({ ...quantDataSnapshot, expiries: ["2026-11-27"] }),
        yahoo: failed,
      }),
      EXPIRY,
      NOW
    );
    expect(output.expiriesSources).toEqual(["quantdata", "ibkr"]);
    expect(output.expiries.map((item) => item.date)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-13",
      "2026-11-27",
    ]);
  });

  it("merges the expiry lists: the union, with the sources that gave one in priority order", () => {
    const sources = (overrides: Partial<OptionsChainReads>) =>
      mergeOptionsExpiries(reads(overrides), EXPIRY, NOW);
    const dates = (output: ReturnType<typeof sources>) =>
      output.expiries.map((item) => item.date);
    const all = sources({});
    expect(all.expiriesSources).toEqual(["quantdata", "ibkr", "yahoo"]);
    expect(dates(all)).toEqual([
      "2026-11-06",
      "2026-11-13",
      "2026-11-20",
      "2026-11-27",
      "2026-12-18",
      "2027-01-15",
    ]);
    // Each source alone.
    const quantDataAlone = sources({ ibkr: off, yahoo: failed });
    expect(quantDataAlone.expiriesSources).toEqual(["quantdata"]);
    expect(dates(quantDataAlone)).toEqual(["2026-11-06", "2026-11-27"]);
    const ibkrAlone = sources({ quantdata: off, yahoo: failed });
    expect(ibkrAlone.expiriesSources).toEqual(["ibkr"]);
    expect(dates(ibkrAlone)).toEqual(["2026-11-06", "2026-11-13"]);
    const yahooAlone = sources({ ibkr: off, quantdata: failed });
    expect(yahooAlone.expiriesSources).toEqual(["yahoo"]);
    expect(dates(yahooAlone)).toEqual(yahooSnapshot.expiries);
    // Pairs keep the priority order.
    expect(sources({ ibkr: off }).expiriesSources).toEqual([
      "quantdata",
      "yahoo",
    ]);
    expect(sources({ quantdata: off }).expiriesSources).toEqual([
      "ibkr",
      "yahoo",
    ]);
    // An IBKR answer without a live value adds no expiry.
    expect(
      sources({ ibkr: ok({ ...ibkrSnapshot, quotes: [], spot: null }) })
        .expiriesSources
    ).toEqual(["quantdata", "yahoo"]);
    // A source whose only expiries have closed gives none.
    expect(
      mergeOptionsExpiries(
        reads({ ibkr: ok({ ...ibkrSnapshot, expiries: ["2026-11-03"] }) }),
        null,
        NOW
      ).expiriesSources
    ).toEqual(["quantdata", "yahoo"]);
  });
});

describe("mergeOptionsExpiries", () => {
  it("lists the expiries with the same source fields as the chain", () => {
    const listed = OptionsChainExpiriesOutputSchema.parse(
      mergeOptionsExpiries(reads(), EXPIRY, NOW)
    );
    expect(listed).not.toHaveProperty("rows");
    expect(listed).toMatchObject({
      expiriesSources: ["quantdata", "ibkr", "yahoo"],
      sources: [
        { source: "quantdata", status: "used" },
        { source: "ibkr", status: "used" },
        { source: "yahoo", status: "used" },
      ],
      spotSource: "quantdata",
    });
    expect(mergeOptionsExpiries(yahooOnly, EXPIRY, NOW).expiries[0]).toEqual({
      date: "2026-11-06",
      dte: 2,
    });
  });

  it("drops closed expiries without an expiry to show and survives no source at all", () => {
    const later = new Date("2026-11-21T12:00:00Z");
    expect(
      mergeOptionsExpiries(yahooOnly, null, later).expiries.map(
        (expiry) => expiry.date
      )
    ).toEqual(["2026-12-18", "2027-01-15"]);
    const nothing = OptionsChainExpiriesOutputSchema.parse(
      mergeOptionsExpiries(
        { ibkr: off, quantdata: off, symbol: "NONE", yahoo: failed },
        null,
        NOW
      )
    );
    expect(nothing).toMatchObject({
      currency: null,
      expiries: [],
      expiriesSources: [],
      quoteTime: null,
      spot: null,
      spotSource: null,
      symbol: "NONE",
    });
    // A symbol without listed options: Yahoo still gives the spot.
    const unlisted = mergeOptionsExpiries(
      {
        ...yahooOnly,
        yahoo: ok({
          ...yahooSnapshot,
          calls: [],
          expiries: [],
          expiry: null,
          puts: [],
        }),
      },
      null,
      NOW
    );
    expect(unlisted).toMatchObject({
      expiries: [],
      spot: 100,
      spotSource: "yahoo",
    });
  });
});

describe("liveQuotes and hasChain", () => {
  it("counts an IBKR answer only when it carries a live value", () => {
    expect(liveQuotes(ok(ibkrSnapshot))).toBe(ibkrSnapshot);
    expect(liveQuotes(ok({ ...ibkrSnapshot, quotes: [] }))?.spot).toBe(100.2);
    expect(
      liveQuotes(ok({ ...ibkrSnapshot, spot: null }))?.quotes
    ).toHaveLength(2);
    expect(
      liveQuotes(ok({ ...ibkrSnapshot, quotes: [], spot: null }))
    ).toBeNull();
    expect(liveQuotes(off)).toBeNull();
    expect(liveQuotes(failed)).toBeNull();
  });

  // Without Quant Data: IBKR and Yahoo alone.
  const quotesOnly = (overrides: Partial<OptionsChainReads> = {}) =>
    reads({ quantdata: off, ...overrides });

  it("needs a contract of the expiry from Quant Data, IBKR or Yahoo", () => {
    expect(hasChain(quotesOnly({ yahoo: failed }), EXPIRY, false)).toBe(true);
    expect(hasChain(yahooOnly, EXPIRY, false)).toBe(true);
    expect(hasChain(yahooOnly, "2026-11-20", false)).toBe(false);
    expect(hasChain(yahooOnly, "2026-11-20", true)).toBe(false);
    expect(hasChain(quotesOnly({ yahoo: failed }), "2026-11-13", false)).toBe(
      false
    );
    // A live spot alone is not a chain.
    expect(
      hasChain(
        quotesOnly({
          ibkr: ok({ ...ibkrSnapshot, quotes: [] }),
          yahoo: failed,
        }),
        EXPIRY,
        true
      )
    ).toBe(false);
    expect(
      hasChain(quotesOnly({ ibkr: off, yahoo: failed }), EXPIRY, false)
    ).toBe(false);
  });

  it("Quant Data rows of the expiry are a chain without IBKR and Yahoo", () => {
    const alone = reads({ ibkr: failed, yahoo: failed });
    expect(hasChain(alone, EXPIRY, false)).toBe(true);
    // Its other expiry too; an expiry without a row is not.
    expect(hasChain(alone, "2026-11-27", false)).toBe(true);
    expect(hasChain(alone, "2026-11-13", false)).toBe(false);
    expect(hasChain(alone, "2026-11-13", true)).toBe(false);
    // An answer without rows is not a chain.
    expect(
      hasChain(
        { ...alone, quantdata: ok({ ...quantDataSnapshot, rows: [] }) },
        EXPIRY,
        true
      )
    ).toBe(false);
    expect(hasChain({ ...alone, quantdata: failed }, EXPIRY, true)).toBe(false);
  });

  it("counts an empty Yahoo snapshot as a chain only for a requested expiry", () => {
    const empty = (sides: Partial<OptionsChainSnapshot>) => ({
      ...yahooOnly,
      yahoo: ok({ ...yahooSnapshot, calls: [], puts: [], ...sides }),
    });
    expect(hasChain(empty({}), EXPIRY, true)).toBe(true);
    expect(hasChain(empty({}), EXPIRY, false)).toBe(false);
    // One side is enough.
    expect(hasChain(empty({ calls: yahooSnapshot.calls }), EXPIRY, false)).toBe(
      true
    );
    expect(hasChain(empty({ puts: yahooSnapshot.puts }), EXPIRY, false)).toBe(
      true
    );
    // IBKR quotes or Quant Data rows of the expiry are a chain whatever Yahoo has.
    expect(
      hasChain({ ...empty({}), ibkr: ok(ibkrSnapshot) }, EXPIRY, false)
    ).toBe(true);
    expect(
      hasChain(
        { ...empty({}), quantdata: ok(quantDataSnapshot) },
        EXPIRY,
        false
      )
    ).toBe(true);
  });
});
