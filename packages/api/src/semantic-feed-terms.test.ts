import { describe, expect, it } from "vitest";

import type {
  PortfolioMonitorOutput,
  PortfolioMonitorPosition,
} from "./contracts/portfolio-monitor.ts";
import {
  computeOpenRisk,
  FEED_TERM_READERS,
  type FeedTermReader,
  feedProblem,
  SEMANTIC_FEED_MAX_AGE_MS,
  SEMANTIC_FEED_MAX_FUTURE_SKEW_MS,
} from "./server/semantic-feed-terms.ts";

// Fictional account values only.
const AS_OF = "2026-11-06T15:00:00.000Z";
const NOW = new Date(AS_OF);

const snapshot = (
  over: Readonly<{
    status?: Partial<PortfolioMonitorOutput["status"]>;
    netLiquidation?: number | null;
    pnl?: Partial<PortfolioMonitorOutput["pnl"]>;
    positions?: PortfolioMonitorPosition[];
    account?: PortfolioMonitorOutput["account"];
  }> = {}
): PortfolioMonitorOutput => ({
  account: over.account ?? { count: 1, mode: "live" },
  completed: [],
  executions: [],
  messages: [],
  orders: [],
  pnl: { daily: -1284.4, realized: 1050, unrealized: 5830, ...over.pnl },
  positions: over.positions ?? [],
  readOnly: true,
  source: "ibkr-gateway",
  status: {
    clientId: 78,
    connected: true,
    dataAsOf: AS_OF,
    gateway: "live",
    generatedAt: AS_OF,
    lastError: null,
    ordersAsOf: AS_OF,
    receivedAt: AS_OF,
    ...over.status,
  },
  summary: {
    availableFunds: null,
    buyingPower: null,
    cushion: null,
    equityWithLoanValue: null,
    excessLiquidity: null,
    grossPositionValue: null,
    initMarginReq: null,
    leverage: null,
    lookAheadExcessLiquidity: null,
    maintMarginReq: null,
    netLiquidation:
      over.netLiquidation === undefined ? 250_000 : over.netLiquidation,
    settledCash: null,
    totalCashValue: null,
  },
});

const stock = (
  symbol: string,
  position: number,
  avgPrice = 100
): PortfolioMonitorPosition => ({
  avgPrice,
  costBasis: Math.abs(avgPrice * position),
  currency: "USD",
  dailyPnl: null,
  description: symbol,
  id: `stk-${symbol}-${position}`,
  last: avgPrice,
  marketValue: avgPrice * position,
  position,
  realized: null,
  secType: "STK",
  symbol,
  unrealized: 0,
  unrealizedPct: null,
  weightPct: null,
});

// avgPrice is per share (portfolio-monitor.ts divides IBKR avgCost by the multiplier); costBasis is
// avgPrice x quantity x multiplier.
const option = (
  input: Readonly<{
    symbol: string;
    expiry: string;
    strike: number;
    right: string;
    position: number;
    avgPrice: number | null;
    costBasis: number | null;
    description?: string;
  }>
): PortfolioMonitorPosition => ({
  avgPrice: input.avgPrice,
  costBasis: input.costBasis,
  currency: "USD",
  dailyPnl: null,
  description:
    input.description ??
    `${input.symbol} ${input.expiry} ${input.strike}${input.right}`,
  id: `opt-${input.symbol}-${input.strike}${input.right}-${input.position}`,
  last: null,
  marketValue: null,
  option: { expiry: input.expiry, right: input.right, strike: input.strike },
  position: input.position,
  realized: null,
  secType: "OPT",
  symbol: input.symbol,
  unrealized: null,
  unrealizedPct: null,
  weightPct: null,
});

// Fixture of docs/vertex-rebuild/agent-semantic-layer.md (tests/integration/semantic-layer/fixtures.ts).
const NVDA_CALL = option({
  avgPrice: 12.5,
  costBasis: 6250,
  description: "NVDA Dec18'26 200 CALL",
  expiry: "20261218",
  position: 5,
  right: "C",
  strike: 200,
  symbol: "NVDA",
});
const SPY_PUT = option({
  avgPrice: 10.95,
  costBasis: 4380,
  description: "SPY Jan15'27 550 PUT",
  expiry: "20270115",
  position: 4,
  right: "P",
  strike: 550,
  symbol: "SPY",
});
const QQQ_SHORT = option({
  avgPrice: 11,
  costBasis: 2200,
  description: "QQQ Nov21'26 520 CALL",
  expiry: "20261121",
  position: -2,
  right: "C",
  strike: 520,
  symbol: "QQQ",
});
const QQQ_LONG = option({
  avgPrice: 7,
  costBasis: 1400,
  description: "QQQ Nov21'26 530 CALL",
  expiry: "20261121",
  position: 2,
  right: "C",
  strike: 530,
  symbol: "QQQ",
});
const DESIGN_POSITIONS = [
  stock("SPY", 120, 550),
  stock("NVDA", 150, 185),
  NVDA_CALL,
  SPY_PUT,
  QQQ_SHORT,
  QQQ_LONG,
];

const reader = (id: string): FeedTermReader => {
  const found = FEED_TERM_READERS[id];
  if (found === undefined) throw new Error(`no reader ${id}`);
  return found;
};

describe("feedProblem", () => {
  it("accepts a live, connected, fresh snapshot", () => {
    expect(feedProblem(snapshot(), NOW)).toBeNull();
    const edge = new Date(NOW.getTime() + SEMANTIC_FEED_MAX_AGE_MS);
    expect(feedProblem(snapshot(), edge)).toBeNull();
  });

  it("refuses a gateway that is not live", () => {
    expect(
      feedProblem(snapshot({ status: { gateway: "starting" } }), NOW)
    ).toBe("The IB gateway is starting; live account values are unknown.");
  });

  it("refuses a paper or unknown account: only the live account answers", () => {
    for (const mode of ["paper", "unknown"] as const) {
      expect(feedProblem(snapshot({ account: { count: 1, mode } }), NOW)).toBe(
        `The feed reports a ${mode} account, not the live account; live account values are unknown.`
      );
    }
    expect(
      feedProblem(snapshot({ account: { count: 2, mode: "live" } }), NOW)
    ).toBeNull();
  });

  it("refuses a disconnected gateway", () => {
    expect(feedProblem(snapshot({ status: { connected: false } }), NOW)).toBe(
      "The IB gateway is live and disconnected; live account values are unknown."
    );
    expect(
      feedProblem(
        snapshot({ status: { connected: false, gateway: "disconnected" } }),
        NOW
      )
    ).toContain("disconnected and disconnected");
  });

  it("refuses a snapshot without a data time", () => {
    expect(feedProblem(snapshot({ status: { dataAsOf: null } }), NOW)).toBe(
      "The feed has no data time; values are unknown."
    );
  });

  it("refuses a snapshot older than five minutes", () => {
    const later = new Date(NOW.getTime() + SEMANTIC_FEED_MAX_AGE_MS + 60_000);
    expect(feedProblem(snapshot(), later)).toBe(
      `The feed data is 6 minutes old (as of ${AS_OF}); live account values are unknown.`
    );
  });

  it("refuses an unparsable data time", () => {
    expect(
      feedProblem(snapshot({ status: { dataAsOf: "not a time" } }), NOW)
    ).toBe(
      "The feed data time not a time is not a valid time; values are unknown."
    );
  });

  it("refuses a data time more than a minute in the future", () => {
    const ahead = (ms: number) =>
      snapshot({
        status: { dataAsOf: new Date(NOW.getTime() + ms).toISOString() },
      });
    expect(
      feedProblem(ahead(SEMANTIC_FEED_MAX_FUTURE_SKEW_MS), NOW)
    ).toBeNull();
    const future = new Date(
      NOW.getTime() + SEMANTIC_FEED_MAX_FUTURE_SKEW_MS + 1
    ).toISOString();
    expect(feedProblem(ahead(SEMANTIC_FEED_MAX_FUTURE_SKEW_MS + 1), NOW)).toBe(
      `The feed data time ${future} is in the future; values are unknown.`
    );
  });
});

describe("net_liquidation", () => {
  it("reads the value in USD", () => {
    expect(reader("net_liquidation")(snapshot(), {})).toEqual({
      answer:
        "Net liquidation of the live IBKR account (vertex-portfolio feed): 250,000.00 USD.",
      rows: [{ currency: "USD", net_liquidation: 250_000 }],
      status: "ok",
    });
  });

  it("is unknown when the feed has no value", () => {
    expect(
      reader("net_liquidation")(snapshot({ netLiquidation: null }), {})
    ).toEqual({
      answer: "The feed reports no net liquidation value.",
      rows: [],
      status: "unknown",
    });
  });
});

describe("pnl", () => {
  const pnl = reader("pnl");

  it.each([
    ["daily", -1284.4],
    ["unrealized", 5830],
    ["realized", 1050],
  ] as const)("reads the %s window", (window, value) => {
    const result = pnl(snapshot(), { window });
    expect(result.status).toBe("ok");
    expect(result.rows).toEqual([{ currency: "USD", pnl: value, window }]);
  });

  it("reads every window without a window or with an unknown one", () => {
    const all = pnl(snapshot(), {});
    expect(all).toEqual({
      answer:
        "P&L of the live IBKR account (vertex-portfolio feed): daily -1,284.40 USD; unrealized 5,830.00 USD; realized 1,050.00 USD.",
      rows: [
        { currency: "USD", pnl: -1284.4, window: "daily" },
        { currency: "USD", pnl: 5830, window: "unrealized" },
        { currency: "USD", pnl: 1050, window: "realized" },
      ],
      status: "ok",
    });
    expect(pnl(snapshot(), { window: null })).toEqual(all);
    expect(pnl(snapshot(), { window: "weekly" })).toEqual(all);
  });

  it("is unknown when a window has no value", () => {
    const missing = snapshot({ pnl: { daily: null, realized: null } });
    expect(pnl(missing, { window: "daily" })).toEqual({
      answer: "The feed reports no daily P&L.",
      rows: [],
      status: "unknown",
    });
    expect(pnl(missing, {}).answer).toBe(
      "The feed reports no daily, realized P&L."
    );
    expect(pnl(missing, { window: "unrealized" }).status).toBe("ok");
  });
});

describe("position", () => {
  const position = reader("position");
  const held = snapshot({
    positions: [...DESIGN_POSITIONS, stock("AAPL", 0)],
  });

  it("matches the symbol case-insensitively across sec types", () => {
    const result = position(held, { sec_type: null, symbol: "nvda" });
    expect(result.status).toBe("ok");
    expect(result.answer).toBe(
      "NVDA positions in the live IBKR account (vertex-portfolio feed): 2 row(s)."
    );
    expect(result.rows).toEqual([
      {
        avg_price: 185,
        cost_basis: 27_750,
        description: "NVDA",
        expiry: null,
        last: 185,
        market_value: 27_750,
        quantity: 150,
        right: null,
        sec_type: "STK",
        strike: null,
        symbol: "NVDA",
        unrealized: 0,
      },
      {
        avg_price: 12.5,
        cost_basis: 6250,
        description: "NVDA Dec18'26 200 CALL",
        expiry: "20261218",
        last: null,
        market_value: null,
        quantity: 5,
        right: "C",
        sec_type: "OPT",
        strike: 200,
        symbol: "NVDA",
        unrealized: null,
      },
    ]);
  });

  it("filters by sec_type", () => {
    const result = position(held, { sec_type: "opt", symbol: "NVDA" });
    expect(result.rows.map((row) => row["sec_type"])).toEqual(["OPT"]);
    expect(result.answer).toBe(
      "NVDA OPT positions in the live IBKR account (vertex-portfolio feed): 1 row(s)."
    );
  });

  it("excludes zero quantities and says when nothing is held", () => {
    expect(position(held, { symbol: "AAPL" })).toEqual({
      answer:
        "the live IBKR account (vertex-portfolio feed) holds no AAPL position.",
      rows: [],
      status: "ok",
    });
    expect(position(held, { sec_type: "STK", symbol: "TSLA" }).answer).toBe(
      "the live IBKR account (vertex-portfolio feed) holds no TSLA STK position."
    );
    expect(position(held, {}).rows).toEqual([]);
  });
});

describe("computeOpenRisk", () => {
  it("prices the design-doc fixture at 11,830 USD", () => {
    expect(computeOpenRisk(DESIGN_POSITIONS)).toEqual({
      kind: "defined",
      structures: [
        {
          contracts: 2,
          description: "QQQ Nov21'26 530 CALL / QQQ Nov21'26 520 CALL",
          max_loss: 1200,
          structure: "credit spread",
        },
        {
          contracts: 5,
          description: "NVDA Dec18'26 200 CALL",
          max_loss: 6250,
          structure: "long option",
        },
        {
          contracts: 4,
          description: "SPY Jan15'27 550 PUT",
          max_loss: 4380,
          structure: "long option",
        },
      ],
      total: 11_830,
    });
  });

  it("prices a debit spread at the debit paid", () => {
    const result = computeOpenRisk([
      option({
        avgPrice: 6,
        costBasis: 1800,
        expiry: "20261218",
        position: 3,
        right: "PUT",
        strike: 500,
        symbol: "IWM",
      }),
      option({
        avgPrice: 2,
        costBasis: 600,
        expiry: "20261218",
        position: -3,
        right: "put",
        strike: 490,
        symbol: "iwm",
      }),
    ]);
    expect(result).toEqual({
      kind: "defined",
      structures: [
        {
          contracts: 3,
          description: "IWM 20261218 500PUT / iwm 20261218 490put",
          max_loss: 1200,
          structure: "debit spread",
        },
      ],
      total: 1200,
    });
  });

  it("prices a put credit spread and keeps the extra long contracts as long options", () => {
    const result = computeOpenRisk([
      option({
        avgPrice: 5,
        costBasis: 1000,
        expiry: "20261218",
        position: -2,
        right: "P",
        strike: 500,
        symbol: "SPY",
      }),
      option({
        avgPrice: 2,
        costBasis: 600,
        expiry: "20261218",
        position: 3,
        right: "P",
        strike: 495,
        symbol: "SPY",
      }),
    ]);
    // (500 - 495) x 100 x 2 - (1000 - 400) = 400; the third long put costs 200.
    expect(result).toEqual({
      kind: "defined",
      structures: [
        {
          contracts: 2,
          description: "SPY 20261218 495P / SPY 20261218 500P",
          max_loss: 400,
          structure: "credit spread",
        },
        {
          contracts: 1,
          description: "SPY 20261218 495P",
          max_loss: 200,
          structure: "long option",
        },
      ],
      total: 600,
    });
  });

  it("pairs the closest strike first and skips a long leg already used up", () => {
    const short = option({
      avgPrice: 4,
      costBasis: 400,
      expiry: "20261218",
      position: -1,
      right: "CALL",
      strike: 100,
      symbol: "XYZ",
    });
    const far = option({
      avgPrice: 1,
      costBasis: 100,
      expiry: "20261218",
      position: 1,
      right: "C",
      strike: 120,
      symbol: "XYZ",
    });
    const near = option({
      avgPrice: 2,
      costBasis: 200,
      expiry: "20261218",
      position: 1,
      right: "C",
      strike: 105,
      symbol: "XYZ",
    });
    const result = computeOpenRisk([short, far, near]);
    expect(result).toEqual({
      kind: "defined",
      structures: [
        {
          contracts: 1,
          description: "XYZ 20261218 105C / XYZ 20261218 100CALL",
          max_loss: 300,
          structure: "credit spread",
        },
        {
          contracts: 1,
          description: "XYZ 20261218 120C",
          max_loss: 100,
          structure: "long option",
        },
      ],
      total: 400,
    });
  });

  it("gives an inverted vertical no width loss", () => {
    // Long call below the short call: the short side never loses beyond the long side.
    const result = computeOpenRisk([
      option({
        avgPrice: 6,
        costBasis: 600,
        expiry: "20261218",
        position: 1,
        right: "C",
        strike: 95,
        symbol: "XYZ",
      }),
      option({
        avgPrice: 8,
        costBasis: 800,
        expiry: "20261218",
        position: -1,
        right: "C",
        strike: 100,
        symbol: "XYZ",
      }),
    ]);
    expect(result).toMatchObject({
      kind: "defined",
      structures: [{ max_loss: 0, structure: "credit spread" }],
      total: 0,
    });
  });

  it("has no defined maximum loss for a naked short leg", () => {
    expect(
      computeOpenRisk([
        NVDA_CALL,
        QQQ_SHORT,
        // Same strike and symbol but another expiry: does not cover the short call.
        option({
          avgPrice: 7,
          costBasis: 1400,
          expiry: "20261219",
          position: 2,
          right: "C",
          strike: 530,
          symbol: "QQQ",
        }),
      ])
    ).toEqual({ kind: "undefined", legs: ["QQQ Nov21'26 520 CALL"] });
  });

  it("treats a zero-cost short leg as a short, not a long", () => {
    const zeroShort = option({
      avgPrice: 0,
      costBasis: 0,
      expiry: "20261121",
      position: -1,
      right: "C",
      strike: 600,
      symbol: "ZZZ",
    });
    expect(computeOpenRisk([zeroShort])).toEqual({
      kind: "undefined",
      legs: [zeroShort.description],
    });
  });

  it("has no defined maximum loss for an unreadable leg", () => {
    const noCost = option({
      avgPrice: 1,
      costBasis: null,
      description: "no cost",
      expiry: "20261218",
      position: 1,
      right: "C",
      strike: 10,
      symbol: "XYZ",
    });
    const badRight = option({
      avgPrice: 1,
      costBasis: 100,
      description: "bad right",
      expiry: "20261218",
      position: 1,
      right: "X",
      strike: 10,
      symbol: "XYZ",
    });
    const { option: _dropped, ...noContract } = NVDA_CALL;
    expect(computeOpenRisk([NVDA_CALL, noCost, badRight, noContract])).toEqual({
      kind: "undefined",
      legs: ["no cost", "bad right", "NVDA Dec18'26 200 CALL"],
    });
  });

  it("falls back to a 100 multiplier when avgPrice is null or 0", () => {
    const legs = (avgPrice: number | null) => [
      option({
        avgPrice,
        costBasis: 300,
        expiry: "20261218",
        position: -1,
        right: "C",
        strike: 50,
        symbol: "XYZ",
      }),
      option({
        avgPrice,
        costBasis: 100,
        expiry: "20261218",
        position: 1,
        right: "C",
        strike: 55,
        symbol: "XYZ",
      }),
    ];
    // 5 x 100 - (300 - 100) = 300.
    for (const avgPrice of [null, 0]) {
      expect(computeOpenRisk(legs(avgPrice))).toMatchObject({ total: 300 });
    }
    // A reported avgPrice gives the multiplier: 300 / 30 = 10, so 5 x 10 - 200 = 0.
    expect(computeOpenRisk(legs(10))).toMatchObject({ total: 0 });
    // A negative avgPrice (short legs reported as negative) is read as its size.
    expect(computeOpenRisk(legs(-1))).toMatchObject({ total: 300 });
  });

  it("ignores stock rows and closed option rows", () => {
    expect(
      computeOpenRisk([stock("SPY", 10), { ...NVDA_CALL, position: 0 }])
    ).toEqual({ kind: "defined", structures: [], total: 0 });
  });
});

describe("open_risk", () => {
  const openRisk = reader("open_risk");

  it("adds a total row with the percent of NLV", () => {
    const result = openRisk(snapshot({ positions: DESIGN_POSITIONS }), {});
    expect(result.status).toBe("ok");
    expect(result.answer).toBe(
      "Open options risk of the live IBKR account (vertex-portfolio feed): 11,830.00 USD maximum loss across 3 structure(s), 4.73% of NLV 250,000.00 USD."
    );
    expect(result.rows).toHaveLength(4);
    expect(result.rows[3]).toEqual({
      contracts: null,
      description: "all open option structures",
      max_loss: 11_830,
      percent_of_nlv: 4.73,
      structure: "total",
    });
  });

  it("gives no percent without a positive NLV", () => {
    for (const netLiquidation of [null, 0, -5]) {
      const result = openRisk(
        snapshot({ netLiquidation, positions: DESIGN_POSITIONS }),
        {}
      );
      expect(result.answer).toBe(
        "Open options risk of the live IBKR account (vertex-portfolio feed): 11,830.00 USD maximum loss across 3 structure(s); percent of NLV unknown (no NLV)."
      );
      expect(result.rows[3]?.["percent_of_nlv"]).toBeNull();
    }
  });

  it("is unknown when a leg has no defined maximum loss", () => {
    expect(
      openRisk(snapshot({ positions: [NVDA_CALL, QQQ_SHORT] }), {})
    ).toEqual({
      answer:
        "Open risk is unknown: these option legs have no defined maximum loss under the certified definition: QQQ Nov21'26 520 CALL.",
      rows: [],
      status: "unknown",
    });
  });
});
