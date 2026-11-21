import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  FlowMarketPremiumRanking,
  FlowMarketPremiumSessionRecord,
  FlowRepository,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_PATHS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import { setSmartMoneyClockForTesting } from "./server/smart-money.ts";

// smartMoney.ranking reads the market premium ledger and rows through the flow repository (a fake
// here); the SQL runs against Postgres in tests/integration/database/flow-market-premium.test.ts.

// November 2026 is EST (UTC-5). 2026-11-20 is a Friday.
const at = (iso: string) => new Date(iso);
const FRI_1100 = at("2026-11-20T16:00:00.000Z");
const MINUTE = 60_000;

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: FRI_1100,
    expiresAt: at("2026-11-21T16:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: FRI_1100,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: FRI_1100,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: FRI_1100,
  },
});

const ledgerRow = (
  sessionDate: string,
  overrides: Partial<FlowMarketPremiumSessionRecord> = {}
): FlowMarketPremiumSessionRecord => ({
  attempts: 1,
  capturedAt: at(`${sessionDate}T22:00:00.000Z`),
  lastAttemptAt: at(`${sessionDate}T22:00:00.000Z`),
  lastMessage: "stored",
  sessionDate,
  status: "complete",
  tickers: 700,
  ...overrides,
});

const EMPTY: FlowMarketPremiumRanking = {
  rows: [],
  totals: { bearishPremium: 0, bullishPremium: 0, premium: 0, tickers: 0 },
};

const fakeFlow = (
  ledger: FlowMarketPremiumSessionRecord[] = [],
  ranking: FlowMarketPremiumRanking = EMPTY
) => ({
  marketPremiumLedger: vi.fn<FlowRepository["marketPremiumLedger"]>(
    async () => ledger
  ),
  marketPremiumRanking: vi.fn<FlowRepository["marketPremiumRanking"]>(
    async () => ranking
  ),
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  flow?: ReturnType<typeof fakeFlow>
) => {
  const repositories = {
    ...(flow === undefined ? {} : { flow: flow as unknown as FlowRepository }),
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: ["operator@domain.test"],
      repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw denied();
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(ORPCError);
  return expect(error).toMatchObject({ code, status });
};

const operator = () => session("operator");

afterEach(() => setSmartMoneyClockForTesting(null));

describe("smartMoney.ranking procedure", () => {
  it("is operator-only and never reads storage for denied callers", async () => {
    const flow = fakeFlow();
    await expectCode(
      clientFor(null, flow).smartMoney.ranking({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), flow).smartMoney.ranking({}),
      "FORBIDDEN",
      403
    );
    return expect(flow.marketPremiumLedger).not.toHaveBeenCalled();
  });

  it("maps missing storage to UNAVAILABLE and read failures to STORAGE_ERROR", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    await expectCode(
      clientFor(operator()).smartMoney.ranking({}),
      "UNAVAILABLE",
      503
    );
    const broken = fakeFlow();
    broken.marketPremiumRanking.mockRejectedValueOnce(new Error("reset"));
    return expectCode(
      clientFor(operator(), broken).smartMoney.ranking({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("sums the newest stored sessions, ranks the rows and adds net premium", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    const flow = fakeFlow(
      [
        ledgerRow("2026-11-16", {
          capturedAt: null,
          status: "no_data",
          tickers: 0,
        }),
        ledgerRow("2026-11-17"),
        ledgerRow("2026-11-18", { status: "partial" }),
        ledgerRow("2026-11-19"),
        ledgerRow("2026-11-20", {
          capturedAt: new Date(FRI_1100.getTime() - 10 * MINUTE),
          status: "partial",
        }),
      ],
      {
        rows: [
          {
            bearishPremium: 1_000_000,
            bullishPremium: 5_000_000,
            premium: 6_500_000,
            rank: 3,
            sessionsPresent: 2,
            ticker: "NVDA",
            tradeCount: 12,
            volume: 900,
          },
          {
            bearishPremium: 2_000_000,
            bullishPremium: 2_500_000,
            premium: 4_600_000,
            rank: 4,
            sessionsPresent: 1,
            ticker: "AAPL",
            tradeCount: 7,
            volume: 400,
          },
        ],
        totals: {
          bearishPremium: 3_000_000,
          bullishPremium: 7_500_000,
          premium: 11_100_000,
          tickers: 2,
        },
      }
    );
    const result = await clientFor(operator(), flow).smartMoney.ranking({
      limit: 10,
      sessions: 5,
      sort: "total",
      ticker: "nvda",
    });
    expect(flow.marketPremiumLedger).toHaveBeenCalledWith({
      from: "2025-10-16",
      to: "2026-11-20",
    });
    expect(flow.marketPremiumRanking).toHaveBeenCalledWith({
      filterProfile: "premium-gte-100k.v1",
      limit: 10,
      sessionDates: ["2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17"],
      sort: "total",
      ticker: "NVDA",
    });
    expect(
      result.rows.map((row) => [row.rank, row.ticker, row.netPremium])
    ).toEqual([
      [3, "NVDA", 4_000_000],
      [4, "AAPL", 500_000],
    ]);
    expect(result.totals.netPremium).toBe(4_500_000);
    expect(result.sessions.map((entry) => entry.status)).toEqual([
      "partial",
      "complete",
      "partial",
      "complete",
    ]);
    expect(result.capturedAt).toEqual(
      new Date(FRI_1100.getTime() - 10 * MINUTE)
    );
    expect(result.coverage).toMatchObject({
      overdueSince: null,
      sessionDate: "2026-11-20",
      state: "fresh",
      status: "partial",
    });
    expect(result.history).toEqual({
      from: "2025-10-16",
      noData: 1,
      pending: 282,
      stored: 3,
      weekdays: 286,
    });
    expect(result.source).toContain("QuantData gainers-losers");
    expect(result.delay).toContain("QuantData, intraday");
  });

  it("uses the defaults and answers an empty store", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    const flow = fakeFlow();
    const result = await clientFor(operator(), flow).smartMoney.ranking({});
    expect(flow.marketPremiumRanking).toHaveBeenCalledWith({
      filterProfile: "premium-gte-100k.v1",
      limit: 50,
      sessionDates: [],
      sort: "net_bullish",
      ticker: null,
    });
    expect(result).toMatchObject({
      capturedAt: null,
      rows: [],
      sessions: [],
    });
    expect(result.coverage).toMatchObject({
      capturedAt: null,
      lastAttemptAt: null,
      lastMessage: null,
      overdueSince: at("2026-11-20T15:00:00.000Z"),
      state: "stale",
      status: null,
    });
  });

  it.each([
    [
      "before 30 minutes of the session without a capture",
      "2026-11-20T14:50:00.000Z",
      [],
      "never",
    ],
    [
      "a capture older than 30 minutes",
      "2026-11-20T16:00:00.000Z",
      [
        ledgerRow("2026-11-20", {
          capturedAt: at("2026-11-20T15:20:00.000Z"),
          status: "partial",
        }),
      ],
      "stale",
    ],
    ["after 16:15", "2026-11-20T21:16:00.000Z", [], "closed"],
    ["before the open", "2026-11-20T14:00:00.000Z", [], "closed"],
    ["a Saturday", "2026-11-21T16:00:00.000Z", [], "closed"],
  ] as const)("reports coverage %s", async (_name, now, ledger, state) => {
    setSmartMoneyClockForTesting(() => at(now));
    const result = await clientFor(
      operator(),
      fakeFlow([...ledger])
    ).smartMoney.ranking({});
    expect(result.coverage.state).toBe(state);
  });

  it("reads with the system clock when no test clock is set", async () => {
    const result = await clientFor(operator(), fakeFlow()).smartMoney.ranking(
      {}
    );
    expect(result.receivedAt.getTime()).toBeGreaterThan(
      Date.parse("2026-01-01T00:00:00.000Z")
    );
  });

  it("names when a stale capture became overdue", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    const result = await clientFor(
      operator(),
      fakeFlow([
        ledgerRow("2026-11-20", {
          capturedAt: at("2026-11-20T15:20:00.000Z"),
          status: "partial",
        }),
      ])
    ).smartMoney.ranking({});
    expect(result.coverage).toMatchObject({
      overdueSince: at("2026-11-20T15:50:00.000Z"),
      state: "stale",
    });
  });

  it("leaves a complete holiday session with almost no tickers out of the window", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    const result = await clientFor(
      operator(),
      fakeFlow([
        ledgerRow("2026-11-18"),
        ledgerRow("2026-11-19", { tickers: 1 }),
      ])
    ).smartMoney.ranking({});
    expect(result.sessions.map((entry) => entry.sessionDate)).toEqual([
      "2026-11-18",
    ]);
  });

  it("marks a complete newest session", async () => {
    setSmartMoneyClockForTesting(() => FRI_1100);
    const result = await clientFor(
      operator(),
      fakeFlow([ledgerRow("2026-11-19")])
    ).smartMoney.ranking({});
    expect(result.sessions).toEqual([
      {
        capturedAt: at("2026-11-19T22:00:00.000Z"),
        sessionDate: "2026-11-19",
        status: "complete",
      },
    ]);
  });

  it("refuses unknown windows, sorts and tickers", async () => {
    const flow = fakeFlow();
    await expectCode(
      clientFor(operator(), flow).smartMoney.ranking({
        sessions: 3 as unknown as 1,
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      clientFor(operator(), flow).smartMoney.ranking({ ticker: "NO SPACE" }),
      "BAD_REQUEST",
      400
    );
    return expect(flow.marketPremiumLedger).not.toHaveBeenCalled();
  });

  it("is readable with an agent read key and through the MCP tool", () => {
    expect(AGENT_API_KEY_PROCEDURE_PATHS).toContain("smartMoney.ranking");
    expect(AGENT_API_KEY_READ_PROCEDURES).toContain("smartMoney.ranking");
    const tool = MCP_TOOLS.find(
      (entry) => entry.name === "openbb_smart_money_ranking"
    );
    expect(tool).toMatchObject({
      procedure: "smartMoney/ranking",
      readOnly: true,
    });
    expect(tool?.description).toContain("not a trade signal");
  });
});
