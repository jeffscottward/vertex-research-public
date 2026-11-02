import { readFileSync } from "node:fs";
import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { CongressIndexError } from "./congress-trades.ts";
import {
  CongressTradesError,
  type CongressTradesOptions,
  clearCongressTradesCacheForTesting,
  fetchCongressTradesFeed,
  fetchHouseIndex,
  setCongressTradesOptionsForTesting,
} from "./server/congress-trades.ts";
import { createApiContext } from "./server/context.ts";
import {
  AGENT_API_KEY_PROCEDURE_ROOTS,
  handleApiRequest,
} from "./server/handler.ts";
import { MCP_TOOLS } from "./server/mcp.ts";

// The 2026 index is the upstream day-trader-skill fixture (MIT, see
// fixtures/day-trader-skill/NOTICE.md). No live House Clerk request is made.

const FIXTURE = new Uint8Array(
  readFileSync(
    new URL(
      "./fixtures/day-trader-skill/trader-pelosi/2026FD.zip",
      import.meta.url
    )
  )
);
const INDEX_2025 = new TextEncoder().encode(
  "<FinancialDisclosure><Member><Prefix>Hon.</Prefix><Last>Doe</Last><First>Jane</First><Suffix /><FilingType>P</FilingType><StateDst>ZZ01</StateDst><Year>2025</Year><FilingDate>12/20/2025</FilingDate><DocID>20030001</DocID></Member></FinancialDisclosure>"
);
const CLERK = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/";
const oct13 = new Date("2026-10-13T15:00:00.000Z");

const zipResponse = (bytes: Uint8Array) =>
  new Response(bytes.slice(), {
    headers: { "content-type": "application/x-zip-compressed" },
    status: 200,
  });

type Fetch = NonNullable<CongressTradesOptions["fetch"]>;

/** A fetch that serves index files by year and records each call. */
const clerk = (years: Record<number, Uint8Array>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ init, url });
    const year = Number(url.slice(CLERK.length, CLERK.length + 4));
    const bytes = years[year];
    return bytes === undefined
      ? new Response("missing", { status: 404 })
      : zipResponse(bytes);
  };
  return { calls, fetch };
};

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => new Error("expected a failure"),
    (error: unknown) => error
  );

afterEach(() => {
  clearCongressTradesCacheForTesting();
  setCongressTradesOptionsForTesting({});
  vi.unstubAllGlobals();
});

describe("House index download", () => {
  it("sends a bounded GET with manual redirects and a User-Agent", async () => {
    const { calls, fetch } = clerk({ 2026: FIXTURE });
    expect(await fetchHouseIndex(2026, { fetch })).toEqual(FIXTURE);
    expect(calls[0]?.url).toBe(`${CLERK}2026FD.zip`);
    expect(calls[0]?.init).toMatchObject({
      headers: { "user-agent": expect.stringContaining("vertex-research") },
      method: "GET",
      redirect: "manual",
    });
    return expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the global fetch by default and reads an empty body", async () => {
    const global = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", global);
    expect(await fetchHouseIndex(2026)).toEqual(new Uint8Array(0));
    return expect(global).toHaveBeenCalledOnce();
  });

  it("maps HTTP, network, size and read failures to typed errors", async () => {
    const run = (fetch: Fetch, extra: CongressTradesOptions = {}) =>
      fail(fetchHouseIndex(2026, { fetch, timeoutMs: 1000, ...extra }));
    const status = (code: number) => async () =>
      new Response("x", { status: code });
    const cases: [Promise<unknown>, string, string][] = [
      [run(status(404)), "NOT_FOUND", "returned HTTP 404"],
      [run(status(503)), "UNAVAILABLE", "returned HTTP 503"],
      [run(status(500)), "UPSTREAM_ERROR", "returned HTTP 500"],
      [
        run(async () => {
          throw new Error("dns");
        }),
        "UNAVAILABLE",
        "request failed",
      ],
      [
        run(async () => zipResponse(FIXTURE), { maxBytes: 10 }),
        "UPSTREAM_ERROR",
        "exceeds the size cap",
      ],
      [
        run(
          async () =>
            new Response(FIXTURE.slice(), {
              headers: { "content-length": "99999999" },
              status: 200,
            })
        ),
        "UPSTREAM_ERROR",
        "exceeds the size cap",
      ],
      [
        run(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                cancel: () => {
                  throw new Error("cancel failed");
                },
                pull: (controller) => controller.enqueue(new Uint8Array(64)),
              }),
              { status: 200 }
            ),
          { maxBytes: 100 }
        ),
        "UPSTREAM_ERROR",
        "exceeds the size cap",
      ],
      [
        run(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => controller.error(new Error("reset")),
              }),
              { status: 200 }
            )
        ),
        "UPSTREAM_ERROR",
        "response could not be read",
      ],
    ];
    for (const [promise, code, detail] of cases) {
      const error = await promise;
      expect(error).toBeInstanceOf(CongressTradesError);
      expect(error).toMatchObject({
        code,
        message: `House 2026 disclosure index ${detail}`,
      });
    }
  });

  it("reports timeouts before and during the body read", async () => {
    // The tsconfig lib predates Promise.withResolvers.
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("x")));
      });
    expect(
      await fail(fetchHouseIndex(2026, { fetch: hang, timeoutMs: 5 }))
    ).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("timed out"),
    });
    const stall: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            init.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted"))
            );
          },
        }),
        { status: 200 }
      );
    return expect(
      await fail(fetchHouseIndex(2026, { fetch: stall, timeoutMs: 5 }))
    ).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("timed out"),
    });
  });
});

describe("congress trades feed", () => {
  it("returns PTR filings in the window, newest first, with members and source", async () => {
    const { fetch } = clerk({ 2026: FIXTURE });
    const feed = await fetchCongressTradesFeed(7, { fetch, now: () => oct13 });
    expect(feed.filings.map((row) => row.docId)).toEqual([
      "20035635",
      "20035622",
      "20035585",
      "20035590",
      "20035562",
    ]);
    expect(feed.members).toEqual([
      "Gilbert Cisneros",
      "Josh Gottheimer",
      "Rick Larsen",
      "Lisa McClain",
      "Maria Elvira Salazar",
    ]);
    expect(feed.source).toContain("2026FD.zip");
    return expect(feed.receivedAt).toEqual(oct13);
  });

  it("caches each index year for 15 minutes", async () => {
    const { calls, fetch } = clerk({ 2026: FIXTURE });
    let now = oct13;
    const options = { fetch, now: () => now };
    await fetchCongressTradesFeed(30, options);
    now = new Date(oct13.getTime() + 14 * 60 * 1000);
    const cached = await fetchCongressTradesFeed(90, options);
    expect(calls).toHaveLength(1);
    expect(cached.receivedAt).toEqual(oct13);
    expect(cached.members).toContain("Nancy Pelosi");
    now = new Date(oct13.getTime() + 16 * 60 * 1000);
    await fetchCongressTradesFeed(30, options);
    return expect(calls).toHaveLength(2);
  });

  it("reads the previous year across Jan 1 and tolerates a missing current index", async () => {
    const jan5 = new Date("2026-01-05T12:00:00.000Z");
    const { calls, fetch } = clerk({ 2025: INDEX_2025 });
    const feed = await fetchCongressTradesFeed(30, { fetch, now: () => jan5 });
    expect(calls.map((call) => call.url)).toEqual([
      `${CLERK}2026FD.zip`,
      `${CLERK}2025FD.zip`,
    ]);
    expect(feed.filings).toMatchObject([
      { docId: "20030001", filedOn: "2025-12-20", year: 2025 },
    ]);
    expect(feed.source).toContain("2026FD.zip, 2025FD.zip");
    clearCongressTradesCacheForTesting();
    const jan30 = new Date("2026-01-30T12:00:00.000Z");
    const later = new Date("2026-01-30T12:10:00.000Z");
    const both = clerk({ 2025: INDEX_2025, 2026: FIXTURE });
    await fetchCongressTradesFeed(7, { fetch: both.fetch, now: () => jan30 });
    const mixed = await fetchCongressTradesFeed(90, {
      fetch: both.fetch,
      now: () => later,
    });
    expect(both.calls).toHaveLength(2);
    expect(mixed.receivedAt).toEqual(jan30);
    return expect(mixed.filings.map((row) => row.docId)).toEqual([
      "20033725",
      "20030001",
    ]);
  });

  it("fails when no index exists, the index is unreadable or the fetch fails", async () => {
    expect(
      await fail(
        fetchCongressTradesFeed(7, { fetch: clerk({}).fetch, now: () => oct13 })
      )
    ).toMatchObject({
      code: "NOT_FOUND",
      message: "No House disclosure index for 2026",
    });
    expect(
      await fail(
        fetchCongressTradesFeed(7, {
          fetch: clerk({ 2026: new Uint8Array([0x50, 0x4b, 1]) }).fetch,
          now: () => oct13,
        })
      )
    ).toBeInstanceOf(CongressIndexError);
    return expect(
      await fail(
        fetchCongressTradesFeed(7, {
          fetch: async () => new Response("", { status: 503 }),
          now: () => oct13,
        })
      )
    ).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("uses the real clock by default", async () => {
    const { fetch } = clerk({
      [new Date().getUTCFullYear()]: FIXTURE,
      [new Date().getUTCFullYear() - 1]: FIXTURE,
    });
    const feed = await fetchCongressTradesFeed(90, { fetch });
    return expect(Array.isArray(feed.filings)).toBe(true);
  });
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: oct13,
    expiresAt: new Date("2026-10-14T12:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: oct13,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: oct13,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: oct13,
  },
});

const clientFor = (requestSession: SafeAuthSession | null) => {
  const repositories = {} as unknown as Repositories;
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
  const error = await fail(promise);
  expect(error).toBeInstanceOf(ORPCError);
  return expect(error).toMatchObject({ code, status });
};

describe("congressTrades.feed procedure", () => {
  it("is operator-only and never calls upstream for denied callers", async () => {
    const doFetch = vi.fn(async () => zipResponse(FIXTURE));
    setCongressTradesOptionsForTesting({ fetch: doFetch, now: () => oct13 });
    await expectCode(
      clientFor(null).congressTrades.feed({ days: 7 }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider")).congressTrades.feed({ days: 7 }),
      "FORBIDDEN",
      403
    );
    return expect(doFetch).not.toHaveBeenCalled();
  });

  it("returns the feed to operators with a 30 day default window", async () => {
    setCongressTradesOptionsForTesting({
      fetch: clerk({ 2026: FIXTURE }).fetch,
      now: () => oct13,
    });
    const client = clientFor(session("operator"));
    const feed = await client.congressTrades.feed({});
    expect(feed.filings).toHaveLength(10);
    expect(feed.receivedAt).toEqual(oct13);
    expect(
      (await client.congressTrades.feed({ days: 7 })).filings
    ).toHaveLength(5);
    return await expectCode(
      // Bypass the client type to prove the server rejects other windows.
      client.congressTrades.feed({ days: 15 as 7 }),
      "BAD_REQUEST",
      400
    );
  });

  it("maps typed and unexpected failures", async () => {
    const client = clientFor(session("operator"));
    setCongressTradesOptionsForTesting({
      fetch: clerk({}).fetch,
      now: () => oct13,
    });
    await expectCode(client.congressTrades.feed({ days: 7 }), "NOT_FOUND", 404);
    setCongressTradesOptionsForTesting({
      fetch: async () => new Response("", { status: 502 }),
      now: () => oct13,
    });
    await expectCode(
      client.congressTrades.feed({ days: 7 }),
      "UNAVAILABLE",
      503
    );
    setCongressTradesOptionsForTesting({
      fetch: clerk({ 2026: new Uint8Array([0x50, 0x4b, 1]) }).fetch,
      now: () => oct13,
    });
    await expectCode(
      client.congressTrades.feed({ days: 7 }),
      "UPSTREAM_ERROR",
      502
    );
    setCongressTradesOptionsForTesting({
      now: () => {
        throw new Error("clock failed");
      },
    });
    return await expectCode(
      client.congressTrades.feed({ days: 7 }),
      "UPSTREAM_ERROR",
      502
    );
  });

  it("is not reachable with agent API keys or MCP tools", () => {
    expect(AGENT_API_KEY_PROCEDURE_ROOTS).not.toContain("congressTrades");
    return expect(
      MCP_TOOLS.some((tool) => tool.procedure.startsWith("congressTrades"))
    ).toBe(false);
  });
});
