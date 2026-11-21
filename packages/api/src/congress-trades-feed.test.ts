import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  OpenbbCongressFeed,
  OpenbbJobRuns,
  OpenbbRepository,
  OpenbbRun,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { setCongressTradesClockForTesting } from "./server/congress-trades.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_PATHS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";

// congressTrades.feed reads the congress tables through the openbb repository (a fake here); the
// SQL runs against Postgres in tests/integration/database/openbb.test.ts.

// 12:00 UTC on 2026-11-19 is 07:00 in New York, so "today" is 2026-11-19.
const NOW = new Date("2026-11-19T12:00:00.000Z");
const HOUR_MS = 3_600_000;

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-20T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

const FIRST_SEEN = new Date("2026-11-04T00:00:00.000Z");
const HOUSE_URL =
  "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20099001.pdf";

const trade = (
  overrides: Partial<OpenbbCongressFeed["trades"][number]> = {}
): OpenbbCongressFeed["trades"][number] => ({
  amends: false,
  amountHigh: 15_000,
  amountLabel: "$1,001 - $15,000",
  amountLow: 1001,
  asset: "Example Holdings Inc. (EXMP) [ST]",
  assetType: "ST",
  chamber: "house",
  docId: "20099001",
  filedOn: "2026-11-03",
  firstSeenAt: FIRST_SEEN,
  holder: "spouse",
  member: "Hon. Avery Example",
  rowNumber: 1,
  ticker: "EXMP",
  transactionDate: "2026-10-21",
  transactionType: "purchase",
  url: HOUSE_URL,
  ...overrides,
});

const filing = (
  overrides: Partial<OpenbbCongressFeed["filings"][number]> = {}
): OpenbbCongressFeed["filings"][number] => ({
  amends: false,
  chamber: "house",
  docId: "20099001",
  filedOn: "2026-11-03",
  firstSeenAt: FIRST_SEEN,
  member: "Hon. Avery Example",
  parserVersion: "house.v1",
  reason: null,
  rowCount: 2,
  stateDistrict: "ZZ01",
  status: "parsed",
  url: HOUSE_URL,
  ...overrides,
});

const run = (
  job: string,
  status: OpenbbRun["status"],
  hoursAgo: number
): OpenbbRun => ({
  error: null,
  finishedAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS),
  id: `${job}-${hoursAgo}`,
  job,
  openbbVersion: null,
  rowsReceived: 1,
  rowsWritten: 1,
  startedAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS - 60_000),
  status,
  warnings: [],
});

type Fake = Readonly<{
  congressFeed: ReturnType<typeof vi.fn>;
  lastRunsFor: ReturnType<typeof vi.fn>;
}>;

const fakeRepository = (
  feed: OpenbbCongressFeed = { filings: [], trades: [] },
  runs: OpenbbJobRuns[] = []
): Fake => ({
  congressFeed: vi.fn(async () => feed),
  lastRunsFor: vi.fn(async () => runs),
});

const clientFor = (requestSession: SafeAuthSession | null, openbb?: Fake) => {
  const repositories = {
    ...(openbb === undefined
      ? {}
      : { openbb: openbb as unknown as OpenbbRepository }),
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

afterEach(() => setCongressTradesClockForTesting(null));

describe("congressTrades.feed procedure", () => {
  it("is operator-only and never reads storage for denied callers", async () => {
    const openbb = fakeRepository();
    await expectCode(
      clientFor(null, openbb).congressTrades.feed({ days: 7 }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), openbb).congressTrades.feed({ days: 7 }),
      "FORBIDDEN",
      403
    );
    return expect(openbb.congressFeed).not.toHaveBeenCalled();
  });

  it("maps missing storage to UNAVAILABLE and read failures to STORAGE_ERROR", async () => {
    setCongressTradesClockForTesting(() => NOW);
    await expectCode(
      clientFor(session("operator")).congressTrades.feed({}),
      "UNAVAILABLE",
      503
    );
    const broken = fakeRepository();
    broken.lastRunsFor.mockRejectedValueOnce(new Error("connection reset"));
    return expectCode(
      clientFor(session("operator"), broken).congressTrades.feed({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("reads the 30 day New York window, adds delay days, counts unparsed filings and members", async () => {
    setCongressTradesClockForTesting(() => NOW);
    const senateDoc = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const openbb = fakeRepository(
      {
        filings: [
          filing({
            chamber: "senate",
            docId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            member: "Jordan Placeholder",
            reason: "scanned_image",
            rowCount: 0,
            status: "unparsed",
          }),
          filing({
            chamber: "senate",
            docId: senateDoc,
            member: "Jordan Placeholder",
          }),
          filing(),
          filing({
            docId: "8099002",
            reason: "layout_unknown",
            rowCount: 0,
            status: "unparsed",
          }),
        ],
        trades: [
          trade(),
          trade({ rowNumber: 2, ticker: null, transactionDate: null }),
        ],
      },
      [
        {
          job: "congress-house",
          latest: run("congress-house", "failed", 2),
          latestUsable: run("congress-house", "partial", 8),
        },
        {
          job: "congress-senate",
          latest: run("congress-senate", "ok", 31),
          latestUsable: run("congress-senate", "ok", 31),
        },
      ]
    );
    const feed = await clientFor(
      session("operator"),
      openbb
    ).congressTrades.feed({});
    expect(openbb.congressFeed).toHaveBeenCalledWith({ from: "2026-10-20" });
    expect(openbb.lastRunsFor).toHaveBeenCalledWith([
      "congress-house",
      "congress-senate",
    ]);
    expect(feed.trades.map((row) => row.delayDays)).toEqual([13, null]);
    expect(feed.trades[0]).not.toHaveProperty("firstSeenAt");
    expect(feed.trades[0]).toMatchObject({ amends: false, url: HOUSE_URL });
    expect(feed.filings).toHaveLength(4);
    expect(feed.filings[0]).not.toHaveProperty("firstSeenAt");
    expect(feed.members).toEqual(["Hon. Avery Example", "Jordan Placeholder"]);
    expect(feed.unparsed).toEqual({
      byReason: { layout_unknown: 1, no_transactions: 0, scanned_image: 1 },
      total: 2,
    });
    expect(feed.coverage).toEqual([
      {
        chamber: "house",
        lastOkAt: new Date(NOW.getTime() - 8 * HOUR_MS),
        lastRunAt: new Date(NOW.getTime() - 2 * HOUR_MS),
        lastStatus: "failed",
        overdue: false,
      },
      {
        chamber: "senate",
        lastOkAt: new Date(NOW.getTime() - 31 * HOUR_MS),
        lastRunAt: new Date(NOW.getTime() - 31 * HOUR_MS),
        lastStatus: "ok",
        overdue: true,
      },
    ]);
    expect(feed.receivedAt).toEqual(NOW);
    expect(feed.source).toContain("Senate eFD");
  });

  it("passes the filters and marks a chamber that never ran as overdue", async () => {
    setCongressTradesClockForTesting(() => NOW);
    const openbb = fakeRepository();
    const feed = await clientFor(
      session("operator"),
      openbb
    ).congressTrades.feed({
      chamber: "senate",
      days: 7,
      member: " placeholder ",
      ticker: " exmp ",
    });
    expect(openbb.congressFeed).toHaveBeenCalledWith({
      chamber: "senate",
      from: "2026-11-12",
      member: "placeholder",
      ticker: "EXMP",
    });
    expect(feed.coverage).toEqual([
      {
        chamber: "house",
        lastOkAt: null,
        lastRunAt: null,
        lastStatus: null,
        overdue: true,
      },
      {
        chamber: "senate",
        lastOkAt: null,
        lastRunAt: null,
        lastStatus: null,
        overdue: true,
      },
    ]);
    await expectCode(
      clientFor(session("operator"), openbb).congressTrades.feed({
        days: 14 as 7,
      }),
      "BAD_REQUEST",
      400
    );
    return expectCode(
      clientFor(session("operator"), openbb).congressTrades.feed({
        ticker: "bad ticker!",
      }),
      "BAD_REQUEST",
      400
    );
  });

  it("lists only the members who traded the ticker when a ticker is set", async () => {
    setCongressTradesClockForTesting(() => NOW);
    const openbb = fakeRepository({
      filings: [
        filing(),
        filing({ docId: "20099003", member: "Hon. Riley Sample" }),
      ],
      trades: [trade(), trade({ rowNumber: 2 })],
    });
    const client = clientFor(session("operator"), openbb);
    expect(
      (await client.congressTrades.feed({ ticker: "EXMP" })).members
    ).toEqual(["Hon. Avery Example"]);
    return expect((await client.congressTrades.feed({})).members).toEqual([
      "Hon. Avery Example",
      "Hon. Riley Sample",
    ]);
  });

  it("uses the real clock by default", async () => {
    const openbb = fakeRepository();
    const before = Date.now();
    const feed = await clientFor(
      session("operator"),
      openbb
    ).congressTrades.feed({ days: 90 });
    return expect(feed.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is a read procedure for agent keys and the MCP tool openbb_congress_trades", () => {
    expect(AGENT_API_KEY_PROCEDURE_PATHS).toContain("congressTrades.feed");
    expect(AGENT_API_KEY_READ_PROCEDURES.has("congressTrades.feed")).toBe(true);
    return expect(
      MCP_TOOLS.find((tool) => tool.procedure === "congressTrades/feed")
    ).toMatchObject({ name: "openbb_congress_trades", readOnly: true });
  });
});
