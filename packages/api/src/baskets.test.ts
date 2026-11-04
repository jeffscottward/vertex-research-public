import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type BasketRepository,
  type CreateBasketInput,
  type BasketWithMembers,
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { BasketUpdateInputSchema } from "./contracts/baskets.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { setBasketFetchOptionsForTesting } from "./server/baskets.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-10-20T15:00:00.000Z");
const config: DeployStatusConfig = {
  url: "https://quantvps.tailnet.test:8443/vertex-history/v1",
  token: "h".repeat(43),
};
const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

const record = (
  userId: string,
  symbol: string,
  members: [string, string][],
  baseDate: string | null = null
): BasketWithMembers => ({
  basket: {
    id: `${userId}-${symbol}`,
    userId,
    symbol,
    name: `${symbol} basket`,
    baseDate,
    baseValue: "100",
    benchmarkBasePrice: null,
    createdAt: at,
    updatedAt: at,
  },
  members: members.map(([member, weight]) => ({
    basketId: `${userId}-${symbol}`,
    symbol: member,
    weight,
    basePrice: baseDate === null ? null : "10",
    sharesAtBase: baseDate === null ? null : "3.33",
  })),
});

const memoryRepository = (seed: BasketWithMembers[] = []) => {
  const rows = [...seed];
  const find = (id: string, userId: string) =>
    rows.findIndex(
      (row) => row.basket.id === id && row.basket.userId === userId
    );
  const repository: {
    -readonly [Key in keyof BasketRepository]: BasketRepository[Key];
  } = {
    listByUser: vi.fn(async (userId: string) =>
      rows.filter((row) => row.basket.userId === userId)
    ),
    get: vi.fn(
      async (id: string, userId: string) => rows[find(id, userId)] ?? null
    ),
    create: vi.fn(async (input: CreateBasketInput) => {
      if (input.symbol === "DUP") throw new DatabaseConflictError("basket");
      if (input.symbol === "BAD") {
        throw new InvalidRepositoryInputError("weights must sum to 1");
      }
      if (input.symbol === "DOWN") {
        throw new DatabasePersistenceError("basket mutation");
      }
      if (input.symbol === "BOOM") throw new Error("unexpected");
      const created = record(
        input.userId,
        input.symbol,
        input.members.map((member): [string, string] => [
          member.symbol,
          member.weight,
        ])
      );
      rows.push(created);
      return created;
    }),
    update: vi.fn(async (input) => {
      if (input.name === "invalid") {
        throw new InvalidRepositoryInputError("bad name");
      }
      const index = find(input.id, input.userId);
      if (index < 0) return null;
      const current = rows[index] as BasketWithMembers;
      const next = {
        basket: { ...current.basket, name: input.name ?? current.basket.name },
        members: current.members,
      };
      rows[index] = next;
      return next;
    }),
    remove: vi.fn(async (id: string, userId: string) => {
      if (id === "explode")
        throw new DatabasePersistenceError("basket mutation");
      const index = find(id, userId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    fixBase: vi.fn(async (input) => {
      const index = find(input.id, input.userId);
      if (index < 0) return null;
      const current = rows[index] as BasketWithMembers;
      const next = {
        basket: {
          ...current.basket,
          baseDate: input.baseDate,
          benchmarkBasePrice: input.benchmarkPrice ?? null,
        },
        members: current.members.map((member) => ({
          ...member,
          basePrice: input.prices[member.symbol] ?? null,
        })),
      };
      rows[index] = next;
      return next;
    }),
    setBenchmarkBase: vi.fn(async () => true),
  };
  return Object.assign(repository, { rows });
};

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-12-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  baskets?: BasketRepository,
  marketHistory: DeployStatusConfig | null | undefined = config
) => {
  const repositories = {
    profiles: {},
    addresses: {},
    userPreferences: {},
    featureItems: {},
    adminUsers: {},
    dashboard: {},
    ...(baskets === undefined ? {} : { baskets }),
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      requireRole: async () => {
        throw denied();
      },
      operatorEmails: ["operator@domain.test"],
      ...(marketHistory === undefined ? {} : { marketHistory }),
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
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

const CLOSES: Record<string, Record<string, number>> = {
  AAA: { "2026-10-20": 10, "2026-10-21": 11, "2026-10-22": 12 },
  BBB: { "2026-10-20": 20, "2026-10-21": 20, "2026-10-22": 18 },
  SPY: { "2026-10-20": 500, "2026-10-21": 505, "2026-10-22": 510 },
};

// Per-symbol fetch time overrides; the default is after the 10-22 close.
const FETCHED_AT: Record<string, string> = {};

const historyFetch = vi.fn(async (url: string | URL | Request) => {
  const symbol = new URL(String(url)).searchParams.get("symbol") ?? "";
  const closes = CLOSES[symbol];
  if (closes === undefined) {
    return new Response(JSON.stringify({ error: "paced", message: "pacing" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
  const bars = Object.entries(closes).map(([date, c]) => ({
    t: day(date),
    o: c,
    h: c,
    l: c,
    c,
    v: 1,
  }));
  return new Response(
    JSON.stringify({
      schema: "vertex-history-bars-v1",
      source: "ibkr-gateway",
      client_id: 77,
      request: {
        symbol,
        secType: "STK",
        exchange: "SMART",
        currency: "USD",
        barSize: "1 day",
        duration: "1 Y",
        whatToShow: "TRADES",
        useRTH: true,
        contractMonth: null,
      },
      contract: {
        conId: 1,
        secType: "STK",
        localSymbol: symbol,
        exchange: "SMART",
        currency: "USD",
        lastTradeDateOrContractMonth: null,
        multiplier: null,
        longName: null,
        timeZoneId: null,
        matches: 1,
      },
      bars,
      count: bars.length,
      fetched_at: FETCHED_AT[symbol] ?? "2026-10-23T00:00:00Z",
      as_of: "2026-10-22T00:00:00Z",
      cache: { hit: false, age_seconds: 0, ttl_seconds: 3600, stale: false },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
});

afterEach(() => {
  setBasketFetchOptionsForTesting({});
  for (const key of Object.keys(FETCHED_AT)) delete FETCHED_AT[key];
});

describe("baskets contract", () => {
  it("requires a name or members on update", () => {
    expect(BasketUpdateInputSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(
      BasketUpdateInputSchema.safeParse({ id: "x", name: "New" }).success
    ).toBe(true);
  });
});

describe("baskets procedures", () => {
  it("are operator-only", async () => {
    const repository = memoryRepository();
    await expectCode(
      clientFor(null, repository).baskets.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), repository).baskets.list({}),
      "FORBIDDEN",
      403
    );
    expect(repository.listByUser).not.toHaveBeenCalled();
  });

  it("reports list storage failures and unconfigured history", async () => {
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]]),
    ]);
    const unconfigured = await clientFor(
      session("operator"),
      repository,
      null
    ).baskets.valuation({ id: "operator-TITY" });
    expect(unconfigured.unavailable.map((entry) => entry.symbol)).toEqual([
      "SPY",
      "AAA",
    ]);
    repository.listByUser = vi.fn(async () => {
      throw new DatabasePersistenceError("basket list");
    });
    await expectCode(
      clientFor(session("operator"), repository).baskets.list({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("reports missing storage as 503", async () => {
    await expectCode(
      clientFor(session("operator")).baskets.list({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("creates, lists, renames and removes the owner's baskets", async () => {
    const repository = memoryRepository([
      record("someone-else", "XXX", [["AAA", "1"]]),
    ]);
    const client = clientFor(session("operator"), repository);
    const created = await client.baskets.create({
      symbol: "tity",
      name: "TITY",
      members: [
        { symbol: "aaa", weight: "0.5" },
        { symbol: "BBB", weight: "0.5" },
      ],
    });
    expect(created).toMatchObject({
      symbol: "TITY",
      baseDate: null,
      members: [
        { symbol: "AAA", weight: "0.5", basePrice: null, sharesAtBase: null },
        { symbol: "BBB", weight: "0.5" },
      ],
    });
    expect((await client.baskets.list({})).items.map((b) => b.symbol)).toEqual([
      "TITY",
    ]);
    const renamed = await client.baskets.update({
      id: created.id,
      name: "Renamed",
    });
    expect(renamed.name).toBe("Renamed");
    await client.baskets.update({
      id: created.id,
      members: [{ symbol: "AAA", weight: "1" }],
    });
    await expect(client.baskets.remove({ id: created.id })).resolves.toEqual({
      id: created.id,
      removed: true,
    });
    await expectCode(
      client.baskets.remove({ id: created.id }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.baskets.update({ id: "missing", name: "x" }),
      "NOT_FOUND",
      404
    );
  });

  it("maps repository failures to typed errors", async () => {
    const client = clientFor(session("operator"), memoryRepository());
    const members = [{ symbol: "AAA", weight: "1" }];
    await expectCode(
      client.baskets.create({ symbol: "DUP", name: "x", members }),
      "CONFLICT",
      409
    );
    await expectCode(
      client.baskets.create({ symbol: "BAD", name: "x", members }),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      client.baskets.create({ symbol: "DOWN", name: "x", members }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      client.baskets.create({ symbol: "BOOM", name: "x", members }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    await expectCode(
      client.baskets.update({ id: "x", name: "invalid" }),
      "VALIDATION_ERROR",
      422
    );
    await expectCode(
      client.baskets.remove({ id: "explode" }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      client.baskets.valuation({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });

  it("values a basket from daily closes, fixes the base and reports unavailable symbols", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      // 2026-10-22 17:00 New York: the 10-22 close is final.
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [
        ["AAA", "0.5"],
        ["BBB", "0.5"],
      ]),
      record("operator", "GAPS", [
        ["AAA", "0.5"],
        ["ZZZ", "0.5"],
      ]),
    ]);
    const client = clientFor(session("operator"), repository);
    const valuation = await client.baskets.valuation({ id: "operator-TITY" });
    expect(valuation.baseState).toBe("fixed");
    expect(valuation.baseDate).toBe("2026-10-21");
    expect(repository.fixBase).toHaveBeenCalledWith({
      id: "operator-TITY",
      userId: "operator",
      expectedUpdatedAt: at,
      baseDate: "2026-10-21",
      prices: { AAA: "11", BBB: "20" },
      benchmarkPrice: "505",
    });
    expect(valuation.basket.baseDate).toBe("2026-10-21");
    expect(valuation.latest?.value).toBeCloseTo(
      ((0.5 * 12) / 11) * 100 + 45,
      8
    );
    expect(valuation.benchmarkSymbol).toBe("SPY");
    expect(valuation.unavailable).toEqual([]);

    // A stored base is used as is; no second fix.
    const again = await client.baskets.valuation({ id: "operator-TITY" });
    expect(again.baseDate).toBe("2026-10-21");
    expect(repository.fixBase).toHaveBeenCalledTimes(1);

    // 2026-10-22 15:00 New York: 10-22 is not final, so a basket created 10-21 stays provisional.
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T19:00:00Z"),
    });
    const early = memoryRepository([
      {
        ...record("operator", "EARLY", [["AAA", "1"]]),
        basket: {
          ...record("operator", "EARLY", [["AAA", "1"]]).basket,
          updatedAt: new Date("2026-10-21T15:00:00Z"),
        },
      },
    ]);
    const provisional = await clientFor(
      session("operator"),
      early
    ).baskets.valuation({
      id: "operator-EARLY",
    });
    expect(provisional.baseState).toBe("provisional");
    expect(early.fixBase).not.toHaveBeenCalled();

    const gaps = await client.baskets.valuation({ id: "operator-GAPS" });
    expect(gaps.baseState).toBe("pending");
    expect(gaps.latest).toBeNull();
    expect(gaps.unavailable).toEqual([
      { symbol: "ZZZ", reason: expect.any(String) },
    ]);
  });

  it("keeps the base provisional while any member's bars were fetched before the close", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [
        ["AAA", "0.5"],
        ["BBB", "0.5"],
      ]),
    ]);
    const client = clientFor(session("operator"), repository);
    // A cached copy from 2026-10-21 15:50 New York: the 10-21 bar was intraday.
    FETCHED_AT["BBB"] = "2026-10-21T19:50:00Z";
    const cached = await client.baskets.valuation({ id: "operator-TITY" });
    expect(cached.baseState).toBe("provisional");
    expect(repository.fixBase).not.toHaveBeenCalled();
  });

  it("keeps the loaded basket when the base fix finds no row and reports non-history failures", async () => {
    setBasketFetchOptionsForTesting({
      fetch: async (url) => {
        if (String(url).includes("symbol=BBB")) throw new TypeError("network");
        return historyFetch(url);
      },
      maxBytes: 10_000_000,
    });
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]]),
      record("operator", "NET", [["BBB", "1"]]),
    ]);
    repository.fixBase = vi.fn(async () => null);
    const client = clientFor(session("operator"), repository);
    const valuation = await client.baskets.valuation({ id: "operator-TITY" });
    expect(valuation.basket.baseDate).toBeNull();
    // Nothing was stored, so the response must not claim a fixed base.
    expect(valuation.baseState).toBe("provisional");
    expect(valuation.baseDate).toBe("2026-10-21");
    const net = await client.baskets.valuation({ id: "operator-NET" });
    expect(net.unavailable[0]?.symbol).toBe("BBB");
  });

  it("reports a provisional base when the members changed before the fix was stored", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]]),
    ]);
    // fixBase finds a newer membership and keeps the basket as it is (base still open).
    repository.fixBase = vi.fn(
      async () => repository.rows[0] as BasketWithMembers
    );
    const valuation = await clientFor(
      session("operator"),
      repository
    ).baskets.valuation({ id: "operator-TITY" });
    expect(repository.fixBase).toHaveBeenCalledTimes(1);
    expect(valuation.basket.baseDate).toBeNull();
    expect(valuation.baseState).toBe("provisional");
  });

  it("values against a base that a concurrent valuation stored first", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]]),
    ]);
    const other = record("operator", "TITY", [["AAA", "1"]], "2026-10-20");
    repository.fixBase = vi.fn(async () => other);
    const valuation = await clientFor(
      session("operator"),
      repository
    ).baskets.valuation({ id: "operator-TITY" });
    expect(valuation.baseState).toBe("fixed");
    expect(valuation.baseDate).toBe("2026-10-20");
    expect(valuation.basket.baseDate).toBe("2026-10-20");
    // The stored base price is 10, so the 10-22 close of 12 is 120.
    expect(valuation.latest?.value).toBeCloseTo(120, 8);
  });

  it("returns the valuation when storing the benchmark base price fails", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]], "2026-10-21"),
    ]);
    repository.setBenchmarkBase = vi.fn(async () => {
      throw new DatabasePersistenceError("basket mutation");
    });
    const valuation = await clientFor(
      session("operator"),
      repository
    ).baskets.valuation({ id: "operator-TITY" });
    expect(repository.setBenchmarkBase).toHaveBeenCalledTimes(1);
    expect(valuation.latest?.benchmark).toBeCloseTo((510 / 505) * 100, 8);
  });

  it("fixes the base without a benchmark close when SPY history is unavailable", async () => {
    setBasketFetchOptionsForTesting({
      fetch: async (url) =>
        String(url).includes("symbol=SPY")
          ? new Response("", { status: 503 })
          : historyFetch(url),
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "TITY", [["AAA", "1"]]),
    ]);
    const valuation = await clientFor(
      session("operator"),
      repository
    ).baskets.valuation({ id: "operator-TITY" });
    expect(valuation.baseState).toBe("fixed");
    expect(repository.fixBase).toHaveBeenCalledWith(
      expect.objectContaining({ benchmarkPrice: null })
    );
    expect(valuation.unavailable.map((entry) => entry.symbol)).toEqual(["SPY"]);
  });

  it("keeps the SPY line from the stored benchmark base after the base leaves the window", async () => {
    setBasketFetchOptionsForTesting({
      fetch: historyFetch,
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const old = record("operator", "OLD", [["AAA", "1"]], "2025-06-02");
    const repository = memoryRepository([
      {
        ...old,
        basket: { ...old.basket, benchmarkBasePrice: "400" },
      },
      record("operator", "NEW", [["AAA", "1"]], "2026-10-21"),
      record("operator", "GONE", [["AAA", "1"]], "2025-06-02"),
    ]);
    const client = clientFor(session("operator"), repository);
    const valuation = await client.baskets.valuation({ id: "operator-OLD" });
    expect(valuation.baseState).toBe("fixed");
    expect(valuation.latest?.benchmark).toBeCloseTo((510 / 400) * 100, 8);
    expect(repository.setBenchmarkBase).not.toHaveBeenCalled();

    // A base fixed before the column existed gets its SPY close stored while it is in the window.
    const fresh = await client.baskets.valuation({ id: "operator-NEW" });
    expect(fresh.latest?.benchmark).toBeCloseTo((510 / 505) * 100, 8);
    expect(repository.setBenchmarkBase).toHaveBeenCalledWith({
      id: "operator-NEW",
      userId: "operator",
      baseDate: "2026-10-21",
      price: "505",
    });

    // Outside the window with no stored close there is nothing to store.
    const gone = await client.baskets.valuation({ id: "operator-GONE" });
    expect(gone.latest?.benchmark).toBeNull();
    expect(repository.setBenchmarkBase).toHaveBeenCalledTimes(1);
  });

  it("sends history requests one at a time and defers symbols past the time budget", async () => {
    let time = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const requested: string[] = [];
    setBasketFetchOptionsForTesting({
      // Each request takes 10 s of fake time, like the paced history service.
      fetch: async (url) => {
        requested.push(new URL(String(url)).searchParams.get("symbol") ?? "");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        time += 10_000;
        inFlight -= 1;
        return historyFetch(url);
      },
      clock: () => time,
      sleep: async (ms) => {
        time += ms;
        await Promise.resolve();
      },
      now: () => new Date("2026-10-22T21:00:00Z"),
    });
    const repository = memoryRepository([
      record("operator", "WIDE", [
        ["AAA", "0.5"],
        ["BBB", "0.5"],
      ]),
      record("operator", "PAIR", [
        ["AAA", "0.5"],
        ["BBB", "0.5"],
      ]),
    ]);
    const client = clientFor(session("operator"), repository);
    const [wide, pair] = await Promise.all([
      client.baskets.valuation({ id: "operator-WIDE" }),
      client.baskets.valuation({ id: "operator-PAIR" }),
    ]);
    expect(maxInFlight).toBe(1);
    // SPY at 0 s and AAA at 10 s fit WIDE's 15 s budget; BBB is deferred, not requested.
    // PAIR waited for WIDE's requests, so its budget ran out before it could send one.
    expect(requested).toEqual(["SPY", "AAA"]);
    const deferred = (symbol: string) => ({
      symbol,
      reason: "History request deferred for IBKR pacing; reload in a minute",
    });
    expect(wide.unavailable).toEqual([deferred("BBB")]);
    expect(pair.unavailable).toEqual([deferred("AAA"), deferred("BBB")]);
    expect(wide.baseState).toBe("pending");

    // The next view reuses SPY and AAA and loads BBB.
    const again = await client.baskets.valuation({ id: "operator-WIDE" });
    expect(requested).toEqual(["SPY", "AAA", "BBB"]);
    expect(again.unavailable).toEqual([]);
    expect(again.baseState).toBe("fixed");
  });

  it("waits with a real timer by default", async () => {
    vi.useFakeTimers();
    try {
      setBasketFetchOptionsForTesting({ fetch: historyFetch });
      const repository = memoryRepository([
        record("operator", "TITY", [["AAA", "1"]]),
      ]);
      const client = clientFor(session("operator"), repository);
      const first = client.baskets.valuation({ id: "operator-TITY" });
      const second = client.baskets.valuation({ id: "operator-TITY" });
      await vi.runAllTimersAsync();
      await expect(first).resolves.toMatchObject({ unavailable: [] });
      await expect(second).resolves.toMatchObject({ unavailable: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
