import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type BasketRepository,
  type BasketWithMembers,
  DatabaseConflictError,
  DatabasePersistenceError,
  type ImportPickListSnapshotInput,
  InvalidRepositoryInputError,
  type PickListMemberRow,
  type PickListRepository,
  type PickListWithLatest,
  type Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { PICK_LIST_SCREEN_MAX_MEMBERS } from "./contracts/pick-lists.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  orderForBucket,
  setPickListOptionsForTesting,
  toDecimalString,
} from "./server/pick-lists.ts";

const at = new Date("2026-11-05T15:00:00.000Z");

const row = (
  symbol: string,
  extra: Partial<PickListMemberRow> = {}
): PickListMemberRow => ({
  symbol,
  rank: null,
  weight: null,
  sector: null,
  rating: null,
  thesis: null,
  targetPrice: null,
  addedOn: null,
  ...extra,
});

const pickList = (
  id: string,
  members: PickListMemberRow[],
  bucketSymbol: string | null = null,
  userId = "operator",
  bucketBasketId = bucketSymbol === null ? null : `basket-${bucketSymbol}`
): PickListWithLatest => ({
  list: {
    id,
    userId,
    source: "newsletter",
    sourceLabel: "Monthly newsletter",
    slug: id,
    name: `${id} picks`,
    bucketSymbol,
    bucketBasketId,
    createdAt: at,
    updatedAt: at,
  },
  latest: {
    id: `${id}-snap`,
    pickListId: id,
    asOf: "2026-11-01",
    method: "manual",
    importedAt: at,
    members,
  },
  snapshotCount: 2,
});

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

const pickListRepository = (seed: PickListWithLatest[] = []) => {
  const rows = [...seed];
  const repository: Mutable<PickListRepository> = {
    importSnapshot: vi.fn(async (input: ImportPickListSnapshotInput) => {
      if (input.slug === "down") throw new DatabasePersistenceError("import");
      if (input.slug === "bad") throw new InvalidRepositoryInputError("bad");
      if (input.slug === "boom") throw new Error("unexpected");
      const created = pickList(input.slug, [...input.members]);
      return {
        ...created,
        list: { ...created.list, name: input.name, source: input.source },
        latest: { ...created.latest, asOf: input.asOf, method: input.method },
        snapshotCount: 1,
      };
    }),
    listByUser: vi.fn(async (userId: string) =>
      rows.filter((entry) => entry.list.userId === userId)
    ),
    get: vi.fn(
      async (id: string, userId: string) =>
        rows.find(
          (entry) => entry.list.id === id && entry.list.userId === userId
        ) ?? null
    ),
    setBucket: vi.fn(
      async (
        id: string,
        userId: string,
        bucketSymbol: string,
        bucketBasketId: string
      ) => {
        if (id === "unrecorded")
          throw new InvalidRepositoryInputError("bucket");
        const index = rows.findIndex(
          (entry) => entry.list.id === id && entry.list.userId === userId
        );
        const current = rows[index];
        if (current === undefined || id === "vanishes") return null;
        const next = {
          ...current,
          list: { ...current.list, bucketSymbol, bucketBasketId },
        };
        rows[index] = next;
        return next;
      }
    ),
  };
  return repository;
};

const basket = (
  symbol: string,
  members: readonly { symbol: string; weight: string }[],
  id = `basket-${symbol}`
): BasketWithMembers => ({
  basket: {
    id,
    userId: "operator",
    symbol,
    name: `${symbol} basket`,
    baseDate: null,
    baseValue: "100",
    benchmarkBasePrice: null,
    createdAt: at,
    updatedAt: at,
  },
  members: members.map((member) => ({
    basketId: id,
    symbol: member.symbol,
    weight: member.weight,
    basePrice: null,
    sharesAtBase: null,
  })),
});

const basketRepository = (seed: BasketWithMembers[] = []) => {
  const rows = [...seed];
  let createdCount = 0;
  const repository: Mutable<BasketRepository> = {
    listByUser: vi.fn(async () => rows),
    get: vi.fn(async () => null),
    create: vi.fn(async (input) => {
      if (input.symbol === "TAKEN") throw new DatabaseConflictError("basket");
      createdCount += 1;
      const created = basket(
        input.symbol,
        input.members,
        `basket-new-${createdCount}`
      );
      rows.push(created);
      return created;
    }),
    update: vi.fn(async (input) => {
      const current = rows.find((entry) => entry.basket.id === input.id);
      if (current === undefined || input.id === "basket-GONE") return null;
      return basket(current.basket.symbol, input.members ?? [], input.id);
    }),
    remove: vi.fn(async (id: string) => {
      const index = rows.findIndex((entry) => entry.basket.id === id);
      if (index < 0) return false;
      if (rows[index]?.basket.symbol === "STUCK")
        throw new DatabasePersistenceError("basket mutation");
      rows.splice(index, 1);
      return true;
    }),
    fixBase: vi.fn(async () => null),
    setBenchmarkBase: vi.fn(async () => false),
  };
  return repository;
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
  pickLists?: PickListRepository,
  baskets?: BasketRepository
) => {
  const repositories = {
    profiles: {},
    addresses: {},
    userPreferences: {},
    featureItems: {},
    adminUsers: {},
    dashboard: {},
    ...(pickLists === undefined ? {} : { pickLists }),
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
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const operator = (pickLists?: PickListRepository, baskets?: BasketRepository) =>
  clientFor(session("operator"), pickLists, baskets).pickLists;

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

// Yahoo stand-in: daily OHLCV charts by symbol; a status number answers with that HTTP status.
type ChartSpec =
  | number
  | "garbage"
  | "empty"
  | Readonly<{
      closes: readonly (number | null)[];
      liveAt?: number;
      /** Quote price (regularMarketPrice). */
      price?: number;
      /** The newest close is empty while its open, high and low exist. */
      emptyLastClose?: boolean;
    }>;

const DAY = 86_400;
const FIRST_BAR = Date.UTC(2025, 10, 3, 14, 30) / 1000;

const chartBody = (spec: Exclude<ChartSpec, number>): unknown => {
  if (spec === "garbage") return { chart: { result: "nope" } };
  if (spec === "empty") return { chart: { result: [] } };
  const timestamp = spec.closes.map((_, index) => FIRST_BAR + index * DAY);
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketTime: spec.liveAt ?? (timestamp.at(-1) ?? 0) + DAY,
            ...(spec.price === undefined
              ? {}
              : { regularMarketPrice: spec.price }),
          },
          timestamp,
          indicators: {
            quote: [
              {
                open: [...spec.closes],
                high: spec.closes.map((close) =>
                  close === null ? null : close + 1
                ),
                low: spec.closes.map((close) =>
                  close === null ? null : close - 1
                ),
                close: spec.closes.map((close, index) =>
                  spec.emptyLastClose === true &&
                  index === spec.closes.length - 1
                    ? null
                    : close
                ),
                volume: spec.closes.map((_, index) =>
                  index === 0 ? null : 1000
                ),
              },
            ],
          },
        },
      ],
    },
  };
};

const symbolOf = (url: string): string =>
  decodeURIComponent(
    new URL(url).pathname.split("/").at(-1) ?? ""
  ).toUpperCase();

const yahooWith = (specs: Readonly<Record<string, ChartSpec>>) =>
  vi.fn(async (url: string, _init: RequestInit) => {
    const spec = specs[symbolOf(url)] ?? 404;
    if (typeof spec === "number")
      return new Response("{}", {
        status: spec,
        headers: { "content-type": "application/json" },
      });
    return Response.json(chartBody(spec));
  });

const rising = (count: number, start = 100, step = 0.1) =>
  Array.from({ length: count }, (_, index) => start + step * index);

afterEach(() => {
  setPickListOptionsForTesting({});
});

describe("pick list helpers", () => {
  it("formats decimals without trailing zeros and rejects exponent notation", () => {
    expect(toDecimalString(0.125, 8)).toBe("0.125");
    expect(toDecimalString(100, 8)).toBe("100");
    expect(toDecimalString(0, 8)).toBe("0");
    expect(toDecimalString(123.456_789, 4)).toBe("123.4568");
    expect(() => toDecimalString(1e21, 4)).toThrow(InvalidRepositoryInputError);
  });

  it("orders a bucket by rank, unranked last, then symbol, keeping 50", () => {
    const members = [
      row("ZZZ"),
      row("BBB", { rank: 2 }),
      row("AAA", { rank: 2 }),
      row("CCC", { rank: 1 }),
      row("MMM"),
    ];
    expect(orderForBucket(members)).toEqual({
      kept: ["CCC", "AAA", "BBB", "MMM", "ZZZ"],
      omitted: [],
    });
    const many = Array.from({ length: 53 }, (_, index) =>
      row(`S${String(index).padStart(3, "0")}`, { rank: 53 - index })
    );
    const ordered = orderForBucket(many);
    expect(ordered.kept).toHaveLength(50);
    expect(ordered.kept[0]).toBe("S052");
    expect(ordered.omitted).toEqual(["S002", "S001", "S000"]);
  });
});

describe("pickLists access", () => {
  it("is operator-only", async () => {
    const repository = pickListRepository();
    await expectCode(
      clientFor(null, repository).pickLists.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor(session("outsider"), repository).pickLists.list({}),
      "FORBIDDEN",
      403
    );
    expect(repository.listByUser).not.toHaveBeenCalled();
  });

  it("reports missing storage", async () => {
    await expectCode(operator().list({}), "STORAGE_ERROR", 503);
    await expectCode(operator().screen({ id: "x" }), "STORAGE_ERROR", 503);
    await expectCode(
      operator(pickListRepository()).syncBucket({ id: "x", bucketSymbol: "B" }),
      "STORAGE_ERROR",
      503
    );
  });
});

describe("pickLists.import", () => {
  const input = {
    source: "newsletter",
    sourceLabel: "Monthly newsletter",
    list: { slug: "core", name: "Core picks" },
    asOf: "2026-11-01",
    method: "adapter" as const,
    members: [
      {
        symbol: "aapl",
        rank: 1,
        weight: 0.125,
        sector: "Technology",
        rating: "Buy",
        thesis: "Services growth",
        targetPrice: 250.123_456,
        addedOn: "2026-06-01",
      },
      { symbol: "MSFT" },
    ],
  };

  it("stores decimal strings for the owner and returns numbers", async () => {
    const repository = pickListRepository();
    const result = await operator(repository).import(input);
    expect(repository.importSnapshot).toHaveBeenCalledWith({
      userId: "operator",
      source: "newsletter",
      sourceLabel: "Monthly newsletter",
      slug: "core",
      name: "Core picks",
      asOf: "2026-11-01",
      method: "adapter",
      members: [
        {
          symbol: "AAPL",
          rank: 1,
          weight: "0.125",
          sector: "Technology",
          rating: "Buy",
          thesis: "Services growth",
          targetPrice: "250.1235",
          addedOn: "2026-06-01",
        },
        row("MSFT"),
      ],
    });
    expect(result).toEqual({
      id: "core",
      source: "newsletter",
      sourceLabel: "Monthly newsletter",
      slug: "core",
      name: "Core picks",
      bucketSymbol: null,
      snapshotCount: 1,
      latest: {
        id: "core-snap",
        asOf: "2026-11-01",
        method: "adapter",
        importedAt: at.toISOString(),
        members: [
          {
            symbol: "AAPL",
            rank: 1,
            weight: 0.125,
            sector: "Technology",
            rating: "Buy",
            thesis: "Services growth",
            targetPrice: 250.1235,
            addedOn: "2026-06-01",
          },
          { ...row("MSFT") },
        ],
      },
    });
  });

  it("maps repository failures", async () => {
    const repository = pickListRepository();
    const client = operator(repository);
    const withSlug = (slug: string) => ({
      ...input,
      list: { slug, name: "x" },
    });
    await expectCode(client.import(withSlug("bad")), "VALIDATION_ERROR", 400);
    await expectCode(client.import(withSlug("down")), "STORAGE_ERROR", 503);
    await expectCode(
      client.import(withSlug("boom")),
      "INTERNAL_SERVER_ERROR",
      500
    );
    await expectCode(
      client.import({
        ...input,
        members: [{ symbol: "AAA", targetPrice: 1e21 }],
      }),
      "VALIDATION_ERROR",
      400
    );
    await expectCode(
      client.import({ ...input, members: [] }),
      "BAD_REQUEST",
      400
    );
  });
});

describe("pickLists.list", () => {
  it("lists the owner's lists", async () => {
    const repository = pickListRepository([
      pickList("core", [row("AAA", { weight: "0.5", targetPrice: "12.5" })]),
      pickList("other", [row("BBB")], null, "someone-else"),
    ]);
    const { items } = await operator(repository).list({});
    expect(items.map((item) => item.id)).toEqual(["core"]);
    expect(items[0]?.latest.members[0]).toMatchObject({
      weight: 0.5,
      targetPrice: 12.5,
    });
    expect(repository.listByUser).toHaveBeenCalledWith("operator");
  });

  it("reports storage failures", async () => {
    const repository = pickListRepository();
    repository.listByUser = vi.fn(async () => {
      throw new DatabasePersistenceError("list");
    });
    await expectCode(operator(repository).list({}), "STORAGE_ERROR", 503);
  });
});

describe("pickLists.syncBucket", () => {
  const members = Array.from({ length: 52 }, (_, index) =>
    row(`S${String(index).padStart(3, "0")}`, {
      rank: index < 50 ? index + 1 : null,
    })
  );

  it("creates an equal-weight bucket of the first 50 and records its symbol", async () => {
    const lists = pickListRepository([pickList("core", members)]);
    const baskets = basketRepository();
    const result = await operator(lists, baskets).syncBucket({
      id: "core",
      bucketSymbol: " core ",
    });
    const created = vi.mocked(baskets.create).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      userId: "operator",
      symbol: "CORE",
      name: "core picks",
    });
    expect(created?.members).toHaveLength(50);
    expect(created?.members[0]).toEqual({
      symbol: "S000",
      weight: "0.02000000",
    });
    expect(lists.setBucket).toHaveBeenCalledWith(
      "core",
      "operator",
      "CORE",
      "basket-new-1"
    );
    expect(result).toMatchObject({
      basketId: "basket-new-1",
      memberCount: 50,
      omitted: ["S050", "S051"],
      list: { bucketSymbol: "CORE" },
    });
  });

  it("refreshes the list's own bucket", async () => {
    const lists = pickListRepository([
      pickList("core", [row("AAA"), row("BBB")], "CORE"),
    ]);
    const baskets = basketRepository([
      basket("CORE", [{ symbol: "OLD", weight: "1" }]),
    ]);
    const result = await operator(lists, baskets).syncBucket({
      id: "core",
      bucketSymbol: "CORE",
    });
    expect(baskets.update).toHaveBeenCalledWith({
      id: "basket-CORE",
      userId: "operator",
      name: "core picks",
      members: [
        { symbol: "AAA", weight: "0.50000000" },
        { symbol: "BBB", weight: "0.50000000" },
      ],
    });
    expect(baskets.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ basketId: "basket-CORE", memberCount: 2 });
  });

  it("creates the bucket again when it was removed", async () => {
    const lists = pickListRepository([
      pickList("core", [row("AAA")], "CORE"),
      pickList("gone", [row("AAA")], "GONE"),
    ]);
    const baskets = basketRepository([basket("GONE", [])]);
    const client = operator(lists, baskets);
    await client.syncBucket({ id: "core", bucketSymbol: "CORE" });
    // The basket row was listed but deleted before the update.
    await client.syncBucket({ id: "gone", bucketSymbol: "GONE" });
    expect(
      vi.mocked(baskets.create).mock.calls.map(([call]) => call.symbol)
    ).toEqual(["CORE", "GONE"]);
  });

  it("refuses a symbol another basket holds", async () => {
    const lists = pickListRepository([
      pickList("core", [row("AAA")], "CORE"),
      pickList("taken", [row("AAA")]),
    ]);
    const baskets = basketRepository([basket("ARKK", [])]);
    const client = operator(lists, baskets);
    await expectCode(
      client.syncBucket({ id: "core", bucketSymbol: "ARKK" }),
      "CONFLICT",
      409
    );
    // Created concurrently between the listing and the insert.
    await expectCode(
      client.syncBucket({ id: "taken", bucketSymbol: "TAKEN" }),
      "CONFLICT",
      409
    );
    expect(lists.setBucket).not.toHaveBeenCalled();
  });

  it("refuses a basket that took the symbol after the list's bucket was deleted", async () => {
    const lists = pickListRepository([
      pickList("first", [row("AAA")]),
      pickList("second", [row("BBB")]),
    ]);
    const baskets = basketRepository();
    const client = operator(lists, baskets);
    const first = await client.syncBucket({ id: "first", bucketSymbol: "ABC" });
    await baskets.remove(first.basketId, "operator");
    const second = await client.syncBucket({
      id: "second",
      bucketSymbol: "ABC",
    });
    expect(second.basketId).not.toBe(first.basketId);
    await expectCode(
      client.syncBucket({ id: "first", bucketSymbol: "ABC" }),
      "CONFLICT",
      409
    );
    expect(baskets.update).not.toHaveBeenCalled();
  });

  it("removes a basket it created when the list cannot record it", async () => {
    const lists = pickListRepository([
      pickList("unrecorded", [row("AAA")]),
      pickList("vanishes", [row("AAA")], "OWN"),
    ]);
    const baskets = basketRepository([basket("OWN", [])]);
    const client = operator(lists, baskets);
    await expectCode(
      client.syncBucket({ id: "unrecorded", bucketSymbol: "NEW" }),
      "VALIDATION_ERROR",
      400
    );
    expect(baskets.remove).toHaveBeenCalledWith("basket-new-1", "operator");
    // A retry is not blocked by its own orphan.
    await expectCode(
      client.syncBucket({ id: "unrecorded", bucketSymbol: "NEW" }),
      "VALIDATION_ERROR",
      400
    );
    expect(baskets.create).toHaveBeenCalledTimes(2);
    // An existing bucket that was only updated is kept.
    await expectCode(
      client.syncBucket({ id: "vanishes", bucketSymbol: "OWN" }),
      "NOT_FOUND",
      404
    );
    expect(baskets.remove).toHaveBeenCalledTimes(2);
  });

  it("keeps the cause when removing the new basket fails too", async () => {
    const lists = pickListRepository([pickList("unrecorded", [row("AAA")])]);
    const baskets = basketRepository();
    await expectCode(
      operator(lists, baskets).syncBucket({
        id: "unrecorded",
        bucketSymbol: "STUCK",
      }),
      "VALIDATION_ERROR",
      400
    );
    expect(baskets.remove).toHaveBeenCalledWith("basket-new-1", "operator");
  });

  it("reports a missing list", async () => {
    const lists = pickListRepository([pickList("vanishes", [row("AAA")])]);
    const baskets = basketRepository();
    const client = operator(lists, baskets);
    await expectCode(
      client.syncBucket({ id: "missing", bucketSymbol: "MISS" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.syncBucket({ id: "vanishes", bucketSymbol: "VAN" }),
      "NOT_FOUND",
      404
    );
    // The basket created for the vanished list is removed again.
    expect(baskets.remove).toHaveBeenCalledWith("basket-new-1", "operator");
  });
});

describe("pickLists.screen", () => {
  const now = new Date("2026-11-05T21:00:00.000Z");
  let clock = now;
  const useYahoo = (specs: Readonly<Record<string, ChartSpec>>) => {
    const fetch = yahooWith(specs);
    clock = now;
    setPickListOptionsForTesting({ fetch, now: () => clock });
    return fetch;
  };
  const fetchedSymbols = (fetch: ReturnType<typeof yahooWith>) =>
    fetch.mock.calls.map(([url]) => symbolOf(url));

  const specs: Record<string, ChartSpec> = {
    SPY: { closes: rising(120, 400, 1) },
    AAA: { closes: rising(120) },
    "BRK-B": { closes: rising(120, 300, -0.5) },
    XLK: { closes: rising(120, 200, 0.3) },
    XLE: 503,
    // One row without prices (dropped) and a newest bar still in session.
    LIVE: {
      closes: rising(30).map((close, index) => (index === 3 ? null : close)),
      liveAt: FIRST_BAR + 29 * DAY + 3600,
    },
    BAD: "garbage",
    NONE: "empty",
  };

  const screenList = () =>
    pickList("core", [
      row("AAA", { sector: "Technology" }),
      row("BRK.B", { sector: "Energy" }),
      row("LIVE"),
      row("BAD"),
      row("NONE", { sector: "Shipping" }),
      row("MISSING"),
    ]);

  it("screens every member of the latest snapshot", async () => {
    const fetch = useYahoo(specs);
    const repository = pickListRepository([screenList()]);
    const result = await operator(repository).screen({ id: "core" });
    expect(fetchedSymbols(fetch)).toEqual([
      "SPY",
      "AAA",
      "BAD",
      "BRK-B",
      "LIVE",
      "MISSING",
      "NONE",
      "XLK",
      "XLE",
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d"
    );
    expect(result.listId).toBe("core");
    expect(result.snapshotId).toBe("core-snap");
    expect(result.computedAt).toBe(now.toISOString());
    // Unranked members come back in symbol order.
    const [aaa, bad, brk, live, missing, none] = result.members;
    expect(aaa).toMatchObject({
      symbol: "AAA",
      status: "pass",
      last: 111.9,
      sectorEtf: "XLK",
      reason: null,
    });
    expect(aaa?.quadrant).not.toBeNull();
    expect(aaa?.sectorQuadrant).not.toBeNull();
    expect(brk).toMatchObject({
      status: "fail",
      sectorEtf: "XLE",
      sectorQuadrant: null,
    });
    // The newest bar is still in session, so it is dropped.
    expect(live).toMatchObject({ status: "unknown", lastDate: "2025-12-01" });
    expect(live?.gates.emaTrend.detail).toBe(
      "Not enough history (28 bars, needs 50)"
    );
    expect(live?.quadrant).toBeNull();
    expect(bad).toMatchObject({
      status: "unknown",
      reason: "Yahoo returned an unexpected document",
    });
    expect(none).toMatchObject({
      reason: "Yahoo has no daily bars for this symbol",
      sectorEtf: null,
    });
    expect(missing).toMatchObject({
      reason: "Yahoo chart returned HTTP 404",
    });
  });

  it("fills an empty newest close with the quote after the session", async () => {
    const lastOpen = FIRST_BAR + 29 * DAY;
    const afterClose = lastOpen + 7 * 3600;
    useYahoo({
      SPY: { closes: rising(30) },
      FILL: {
        closes: rising(30),
        emptyLastClose: true,
        liveAt: afterClose,
        price: 150,
      },
      NOPRICE: { closes: rising(30), emptyLastClose: true, liveAt: afterClose },
      CLOSED: { closes: rising(30), liveAt: afterClose, price: 999 },
    });
    const result = await operator(
      pickListRepository([
        pickList("fill", [row("FILL"), row("NOPRICE"), row("CLOSED")]),
      ])
    ).screen({ id: "fill" });
    // Unranked members are screened in symbol order.
    const [closed, fill, noPrice] = result.members;
    expect(fill).toMatchObject({ last: 150, lastDate: "2025-12-02" });
    expect(noPrice).toMatchObject({ lastDate: "2025-12-01" });
    expect(closed).toMatchObject({ lastDate: "2025-12-02" });
    expect(closed?.last).toBeCloseTo(102.9);
  });

  it("screens the first 60 members in rank order and reports the rest", async () => {
    const ranked = Array.from({ length: 61 }, (_, index) =>
      row(`M${String(index).padStart(3, "0")}`, { rank: 61 - index })
    );
    const fetch = useYahoo({
      SPY: { closes: [10] },
      ...Object.fromEntries(
        ranked.map((member) => [member.symbol, { closes: [10] }])
      ),
    });
    const result = await operator(
      pickListRepository([
        pickList("wide", [row("ZZZ", { sector: "Energy" }), ...ranked]),
      ])
    ).screen({ id: "wide" });
    expect(PICK_LIST_SCREEN_MAX_MEMBERS).toBe(60);
    const fetched = fetchedSymbols(fetch);
    expect(fetched).toHaveLength(61);
    expect(fetched).not.toContain("M000");
    expect(fetched).not.toContain("XLE");
    expect(result.members.map((member) => member.symbol).slice(0, 2)).toEqual([
      "M060",
      "M059",
    ]);
    expect(result.members).toHaveLength(62);
    const reason = "Not screened: first 60 members per run";
    expect(result.members.slice(60)).toEqual([
      expect.objectContaining({ symbol: "M000", status: "unknown", reason }),
      {
        symbol: "ZZZ",
        status: "unknown",
        last: null,
        lastDate: null,
        gates: {
          emaTrend: { ok: null, detail: "Not screened" },
          aboveVwap20: { ok: null, detail: "Not screened" },
          notOverextended: { ok: null, detail: "Not screened" },
        },
        quadrant: null,
        sector: "Energy",
        sectorEtf: "XLE",
        sectorQuadrant: null,
        reason,
      },
    ]);
  });

  it("reuses bars for ten minutes and retries failures", async () => {
    const fetch = useYahoo(specs);
    const client = operator(pickListRepository([screenList()]));
    await client.screen({ id: "core" });
    fetch.mockClear();
    clock = new Date(now.getTime() + 9 * 60_000);
    await client.screen({ id: "core" });
    expect(fetchedSymbols(fetch)).toEqual(["BAD", "MISSING", "NONE", "XLE"]);
    fetch.mockClear();
    clock = new Date(now.getTime() + 11 * 60_000);
    await client.screen({ id: "core" });
    expect(fetchedSymbols(fetch)).toHaveLength(9);
  });

  it("uses the global fetch and the real clock by default", async () => {
    const fetch = yahooWith(specs);
    vi.stubGlobal("fetch", fetch);
    setPickListOptionsForTesting({});
    try {
      const before = Date.now();
      const result = await operator(
        pickListRepository([pickList("one", [row("AAA")])])
      ).screen({ id: "one" });
      expect(fetchedSymbols(fetch)).toEqual(["SPY", "AAA"]);
      expect(Date.parse(result.computedAt)).toBeGreaterThanOrEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps gates but no quadrants when the benchmark fails", async () => {
    useYahoo({ ...specs, SPY: 502 });
    const result = await operator(pickListRepository([screenList()])).screen({
      id: "core",
    });
    expect(result.members[0]).toMatchObject({
      status: "pass",
      quadrant: null,
      sectorQuadrant: null,
    });
  });

  it("evicts the oldest cached symbol beyond 400", async () => {
    // Seven lists of 60 symbols: SPY plus 420 symbols pass through the 400-entry cache.
    const prefixes = ["A", "B", "C", "D", "E", "F", "G"];
    const symbols = (prefix: string) =>
      Array.from(
        { length: 60 },
        (_, index) => `${prefix}${String(index).padStart(3, "0")}`
      );
    const fetch = useYahoo({
      SPY: { closes: rising(5) },
      ...Object.fromEntries(
        prefixes.flatMap(symbols).map((symbol) => [symbol, { closes: [10] }])
      ),
    });
    const client = operator(
      pickListRepository(
        prefixes.map((prefix) =>
          pickList(
            prefix,
            symbols(prefix).map((symbol) => row(symbol))
          )
        )
      )
    );
    for (const prefix of prefixes) await client.screen({ id: prefix });
    fetch.mockClear();
    await client.screen({ id: "G" });
    // SPY was cached first, so the 401st symbol evicted it; the newest list is still cached.
    expect(fetchedSymbols(fetch)).toEqual(["SPY"]);
  });

  it("reports a missing list and storage failures", async () => {
    useYahoo(specs);
    const repository = pickListRepository();
    await expectCode(
      operator(repository).screen({ id: "missing" }),
      "NOT_FOUND",
      404
    );
    repository.get = vi.fn(async () => {
      throw new DatabasePersistenceError("get");
    });
    await expectCode(
      operator(repository).screen({ id: "core" }),
      "STORAGE_ERROR",
      503
    );
  });
});
