import {
  type AgentApiKeyService,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { MarketBar } from "./contracts/market-data.ts";
import { PICK_LIST_SCREEN_MAX_MEMBERS } from "./contracts/pick-lists.ts";
import { createApiContext } from "./server/context.ts";
import type { DeployStatusConfig } from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./server/merged-bars.test-support.ts";
import { resetIbkrPacing } from "./server/merged-bars.ts";
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
  addedOn: null,
  rank: null,
  rating: null,
  sector: null,
  symbol,
  targetPrice: null,
  thesis: null,
  weight: null,
  ...extra,
});

const pickList = (
  id: string,
  members: PickListMemberRow[],
  bucketSymbol: string | null = null,
  userId = "operator",
  bucketBasketId = bucketSymbol === null ? null : `basket-${bucketSymbol}`
): PickListWithLatest => ({
  latest: {
    asOf: "2026-11-01",
    id: `${id}-snap`,
    importedAt: at,
    members,
    method: "manual",
    pickListId: id,
  },
  list: {
    bucketBasketId,
    bucketSymbol,
    createdAt: at,
    id,
    name: `${id} picks`,
    slug: id,
    source: "newsletter",
    sourceLabel: "Monthly newsletter",
    updatedAt: at,
    userId,
  },
  snapshotCount: 2,
});

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

const pickListRepository = (seed: PickListWithLatest[] = []) => {
  const rows = [...seed];
  const repository: Mutable<PickListRepository> = {
    get: vi.fn(
      async (id: string, userId: string) =>
        rows.find(
          (entry) => entry.list.id === id && entry.list.userId === userId
        ) ?? null
    ),
    importSnapshot: vi.fn(async (input: ImportPickListSnapshotInput) => {
      if (input.slug === "down") throw new DatabasePersistenceError("import");
      if (input.slug === "bad") throw new InvalidRepositoryInputError("bad");
      if (input.slug === "boom") throw new Error("unexpected");
      const created = pickList(input.slug, [...input.members]);
      return {
        ...created,
        latest: { ...created.latest, asOf: input.asOf, method: input.method },
        list: { ...created.list, name: input.name, source: input.source },
        snapshotCount: 1,
      };
    }),
    listByUser: vi.fn(async (userId: string) =>
      rows.filter((entry) => entry.list.userId === userId)
    ),
    // Test emails are `<userId>@domain.test`.
    listByUserEmails: vi.fn(async (emails: readonly string[] | undefined) =>
      rows.filter((entry) =>
        (emails ?? []).includes(`${entry.list.userId}@domain.test`)
      )
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
          list: { ...current.list, bucketBasketId, bucketSymbol },
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
    baseDate: null,
    baseValue: "100",
    benchmarkBasePrice: null,
    createdAt: at,
    id,
    name: `${symbol} basket`,
    symbol,
    updatedAt: at,
    userId: "operator",
  },
  members: members.map((member) => ({
    basePrice: null,
    basketId: id,
    sharesAtBase: null,
    symbol: member.symbol,
    weight: member.weight,
  })),
});

const basketRepository = (seed: BasketWithMembers[] = []) => {
  const rows = [...seed];
  let createdCount = 0;
  const repository: Mutable<BasketRepository> = {
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
    fixBase: vi.fn(async () => null),
    get: vi.fn(async () => null),
    listByUser: vi.fn(async () => rows),
    remove: vi.fn(async (id: string) => {
      const index = rows.findIndex((entry) => entry.basket.id === id);
      if (index < 0) return false;
      if (rows[index]?.basket.symbol === "STUCK")
        throw new DatabasePersistenceError("basket mutation");
      rows.splice(index, 1);
      return true;
    }),
    setBenchmarkBase: vi.fn(async () => false),
    update: vi.fn(async (input) => {
      const current = rows.find((entry) => entry.basket.id === input.id);
      if (current === undefined || input.id === "basket-GONE") return null;
      return basket(current.basket.symbol, input.members ?? [], input.id);
    }),
  };
  return repository;
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-12-03T03:04:05.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  pickLists?: PickListRepository,
  baskets?: BasketRepository,
  options: Readonly<{
    apiKey?: boolean;
    marketHistory?: DeployStatusConfig;
  }> = {}
) => {
  const repositories = {
    addresses: {},
    adminUsers: {},
    dashboard: {},
    featureItems: {},
    profiles: {},
    userPreferences: {},
    ...(pickLists === undefined ? {} : { pickLists }),
    ...(baskets === undefined ? {} : { baskets }),
  } as unknown as Repositories;
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    if (options.apiKey === true) request.headers.set("x-api-key", "read-key");
    // A read key owned by the operator.
    const agentApiKeys = {
      authenticate: async () => ({
        access: "read" as const,
        apiKeyId: "key-1",
        email: "operator@domain.test",
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "operator",
      }),
    } as unknown as AgentApiKeyService;
    const context = createApiContext(request, {
      agentApiKeys,
      agentViewerEmails: ["viewer@domain.test"],
      ...(options.marketHistory === undefined
        ? {}
        : { marketHistory: options.marketHistory }),
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

const operator = (pickLists?: PickListRepository, baskets?: BasketRepository) =>
  clientFor(session("operator"), pickLists, baskets).pickLists;

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
  message: RegExp = /./u
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code,
      message: expect.stringMatching(message),
      status,
    });
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
          indicators: {
            quote: [
              {
                close: spec.closes.map((close, index) =>
                  spec.emptyLastClose === true &&
                  index === spec.closes.length - 1
                    ? null
                    : close
                ),
                high: spec.closes.map((close) =>
                  close === null ? null : close + 1
                ),
                low: spec.closes.map((close) =>
                  close === null ? null : close - 1
                ),
                open: [...spec.closes],
                volume: spec.closes.map((_, index) =>
                  index === 0 ? null : 1000
                ),
              },
            ],
          },
          meta: {
            regularMarketTime: spec.liveAt ?? (timestamp.at(-1) ?? 0) + DAY,
            ...(spec.price === undefined
              ? {}
              : { regularMarketPrice: spec.price }),
          },
          timestamp,
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
        headers: { "content-type": "application/json" },
        status: spec,
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
    await expectCode(
      clientFor(session("outsider"), repository).pickLists.proposal({}),
      "FORBIDDEN",
      403
    );
    expect(repository.listByUser).not.toHaveBeenCalled();
  });

  it("reports missing storage", async () => {
    const notConfigured =
      /^Pick list storage is not configured on this server; nothing was saved\./u;
    await expectCode(operator().list({}), "STORAGE_ERROR", 503, notConfigured);
    await expectCode(operator().screen({ id: "x" }), "STORAGE_ERROR", 503);
    await expectCode(operator().proposal({}), "STORAGE_ERROR", 503);
    await expectCode(
      operator(pickListRepository()).syncBucket({ bucketSymbol: "B", id: "x" }),
      "STORAGE_ERROR",
      503,
      /^Basket storage is not configured on this server/u
    );
  });
});

describe("pickLists.import", () => {
  const input = {
    asOf: "2026-11-01",
    list: { name: "Core picks", slug: "core" },
    members: [
      {
        addedOn: "2026-06-01",
        rank: 1,
        rating: "Buy",
        sector: "Technology",
        symbol: "aapl",
        targetPrice: 250.123_456,
        thesis: "Services growth",
        weight: 0.125,
      },
      { symbol: "MSFT" },
    ],
    method: "adapter" as const,
    source: "newsletter",
    sourceLabel: "Monthly newsletter",
  };

  it("stores decimal strings for the owner and returns numbers", async () => {
    const repository = pickListRepository();
    const result = await operator(repository).import(input);
    expect(repository.importSnapshot).toHaveBeenCalledWith({
      asOf: "2026-11-01",
      members: [
        {
          addedOn: "2026-06-01",
          rank: 1,
          rating: "Buy",
          sector: "Technology",
          symbol: "AAPL",
          targetPrice: "250.1235",
          thesis: "Services growth",
          weight: "0.125",
        },
        row("MSFT"),
      ],
      method: "adapter",
      name: "Core picks",
      slug: "core",
      source: "newsletter",
      sourceLabel: "Monthly newsletter",
      userId: "operator",
    });
    expect(result).toEqual({
      bucketSymbol: null,
      id: "core",
      latest: {
        asOf: "2026-11-01",
        id: "core-snap",
        importedAt: at.toISOString(),
        members: [
          {
            addedOn: "2026-06-01",
            rank: 1,
            rating: "Buy",
            sector: "Technology",
            symbol: "AAPL",
            targetPrice: 250.1235,
            thesis: "Services growth",
            weight: 0.125,
          },
          { ...row("MSFT") },
        ],
        method: "adapter",
      },
      name: "Core picks",
      slug: "core",
      snapshotCount: 1,
      source: "newsletter",
      sourceLabel: "Monthly newsletter",
    });
  });

  it("maps repository failures", async () => {
    const repository = pickListRepository();
    const client = operator(repository);
    const withSlug = (slug: string) => ({
      ...input,
      list: { name: "x", slug },
    });
    await expectCode(client.import(withSlug("bad")), "VALIDATION_ERROR", 400);
    await expectCode(
      client.import(withSlug("down")),
      "STORAGE_ERROR",
      503,
      /^Pick list storage: the database returned an error at \d\d:\d\d UTC\. Reload to check whether the change was saved\.$/u
    );
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
      pickList("core", [row("AAA", { targetPrice: "12.5", weight: "0.5" })]),
      pickList("other", [row("BBB")], null, "someone-else"),
    ]);
    const { items } = await operator(repository).list({});
    expect(items.map((item) => item.id)).toEqual(["core"]);
    expect(items[0]?.latest.members[0]).toMatchObject({
      targetPrice: 12.5,
      weight: 0.5,
    });
    expect(repository.listByUser).toHaveBeenCalledWith("operator");
  });

  it("reports storage failures", async () => {
    const repository = pickListRepository();
    repository.listByUser = vi.fn(async () => {
      throw new DatabasePersistenceError("list");
    });
    await expectCode(
      operator(repository).list({}),
      "STORAGE_ERROR",
      503,
      /^Pick list storage: the database returned an error at \d\d:\d\d UTC\. Nothing was changed\. Try again\.$/u
    );
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
      bucketSymbol: " core ",
      id: "core",
    });
    const created = vi.mocked(baskets.create).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      name: "core picks",
      symbol: "CORE",
      userId: "operator",
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
      list: { bucketSymbol: "CORE" },
      memberCount: 50,
      omitted: ["S050", "S051"],
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
      bucketSymbol: "CORE",
      id: "core",
    });
    expect(baskets.update).toHaveBeenCalledWith({
      id: "basket-CORE",
      members: [
        { symbol: "AAA", weight: "0.50000000" },
        { symbol: "BBB", weight: "0.50000000" },
      ],
      name: "core picks",
      userId: "operator",
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
    await client.syncBucket({ bucketSymbol: "CORE", id: "core" });
    // The basket row was listed but deleted before the update.
    await client.syncBucket({ bucketSymbol: "GONE", id: "gone" });
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
      client.syncBucket({ bucketSymbol: "ARKK", id: "core" }),
      "CONFLICT",
      409
    );
    // Created concurrently between the listing and the insert.
    await expectCode(
      client.syncBucket({ bucketSymbol: "TAKEN", id: "taken" }),
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
    const first = await client.syncBucket({ bucketSymbol: "ABC", id: "first" });
    await baskets.remove(first.basketId, "operator");
    const second = await client.syncBucket({
      bucketSymbol: "ABC",
      id: "second",
    });
    expect(second.basketId).not.toBe(first.basketId);
    await expectCode(
      client.syncBucket({ bucketSymbol: "ABC", id: "first" }),
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
      client.syncBucket({ bucketSymbol: "NEW", id: "unrecorded" }),
      "VALIDATION_ERROR",
      400
    );
    expect(baskets.remove).toHaveBeenCalledWith("basket-new-1", "operator");
    // A retry is not blocked by its own orphan.
    await expectCode(
      client.syncBucket({ bucketSymbol: "NEW", id: "unrecorded" }),
      "VALIDATION_ERROR",
      400
    );
    expect(baskets.create).toHaveBeenCalledTimes(2);
    // An existing bucket that was only updated is kept.
    await expectCode(
      client.syncBucket({ bucketSymbol: "OWN", id: "vanishes" }),
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
        bucketSymbol: "STUCK",
        id: "unrecorded",
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
      client.syncBucket({ bucketSymbol: "MISS", id: "missing" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      client.syncBucket({ bucketSymbol: "VAN", id: "vanishes" }),
      "NOT_FOUND",
      404
    );
    // The basket created for the vanished list is removed again.
    expect(baskets.remove).toHaveBeenCalledWith("basket-new-1", "operator");
  });

  it("names both stores when a sync write fails in the database", async () => {
    const lists = pickListRepository([pickList("core", [row("AAA")])]);
    const baskets = basketRepository();
    vi.mocked(baskets.create).mockRejectedValueOnce(
      new DatabasePersistenceError("basket create")
    );
    await expectCode(
      operator(lists, baskets).syncBucket({ bucketSymbol: "CORE", id: "core" }),
      "STORAGE_ERROR",
      503,
      /^Pick list or basket storage: the database returned an error at \d\d:\d\d UTC\. Reload to check whether the change was saved\.$/u
    );
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
    AAA: { closes: rising(120) },
    BAD: "garbage",
    "BRK-B": { closes: rising(120, 300, -0.5) },
    // One row without prices (dropped) and a newest bar still in session.
    LIVE: {
      closes: rising(30).map((close, index) => (index === 3 ? null : close)),
      liveAt: FIRST_BAR + 29 * DAY + 3600,
    },
    NONE: "empty",
    SPY: { closes: rising(120, 400, 1) },
    XLE: 503,
    XLK: { closes: rising(120, 200, 0.3) },
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
      last: 111.9,
      reason: null,
      sectorEtf: "XLK",
      status: "pass",
      symbol: "AAA",
    });
    expect(aaa?.quadrant).not.toBeNull();
    expect(aaa?.sectorQuadrant).not.toBeNull();
    expect(brk).toMatchObject({
      sectorEtf: "XLE",
      sectorQuadrant: null,
      status: "fail",
    });
    // The newest bar is still in session, so it is dropped.
    expect(live).toMatchObject({
      lastDate: "2025-12-01",
      status: "not_evaluated",
    });
    expect(live?.gates.emaTrend.detail).toBe(
      "Not enough history (28 bars, needs 50)"
    );
    expect(live?.quadrant).toBeNull();
    expect(bad).toMatchObject({
      reason: "Yahoo returned an unexpected document",
      status: "no_data",
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
      CLOSED: { closes: rising(30), liveAt: afterClose, price: 999 },
      FILL: {
        closes: rising(30),
        emptyLastClose: true,
        liveAt: afterClose,
        price: 150,
      },
      NOPRICE: { closes: rising(30), emptyLastClose: true, liveAt: afterClose },
      SPY: { closes: rising(30) },
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
      expect.objectContaining({
        reason,
        status: "not_screened",
        symbol: "M000",
      }),
      {
        gates: {
          aboveVwap20: { detail: "Not screened", ok: null },
          emaTrend: { detail: "Not screened", ok: null },
          notOverextended: { detail: "Not screened", ok: null },
        },
        last: null,
        lastDate: null,
        quadrant: null,
        quadrantReason: "Not screened",
        reason,
        sector: "Energy",
        sectorEtf: "XLE",
        sectorQuadrant: null,
        sectorQuadrantReason: "Not screened",
        status: "not_screened",
        symbol: "ZZZ",
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
      quadrant: null,
      sectorQuadrant: null,
      status: "pass",
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

describe("pickLists.proposal", () => {
  const now = new Date("2026-11-05T21:00:00.000Z");
  const useYahoo = (specs: Readonly<Record<string, ChartSpec>>) => {
    const fetch = yahooWith(specs);
    setPickListOptionsForTesting({ fetch, now: () => now });
    return fetch;
  };
  const fetchedSymbols = (fetch: ReturnType<typeof yahooWith>) =>
    fetch.mock.calls.map(([url]) => symbolOf(url));

  it("proposes a defined-risk spread per member of every bucketed list", async () => {
    const fetch = useYahoo({
      AAA: { closes: rising(120) },
      BBB: { closes: rising(120, 300, -0.5) },
      SPY: { closes: rising(120, 400, 1) },
      XLK: { closes: rising(120, 200, 0.3) },
    });
    const repository = pickListRepository([
      pickList(
        "wish",
        [row("BBB", { rank: 2 }), row("AAA", { rank: 1 })],
        "WISH"
      ),
      // Re-imported after Make bucket: the bucket still holds AAA and CCC, not NEW.
      pickList(
        "moby",
        [row("AAA", { sector: "Technology" }), row("NEW")],
        "TMOBY"
      ),
      // The bucket basket was deleted: no bucket, no rows.
      pickList("gone", [row("OLD")], "GONE", "operator", null),
      // The recorded basket no longer exists for this owner.
      pickList("lost", [row("LOST")], "LOST"),
      pickList("loose", [row("ZZZ")]),
    ]);
    const weight = { weight: "0.5" };
    const baskets = basketRepository([
      basket("WISH", [
        { symbol: "AAA", ...weight },
        { symbol: "BBB", ...weight },
      ]),
      basket("TMOBY", [
        { symbol: "AAA", ...weight },
        { symbol: "CCC", ...weight },
      ]),
    ]);
    const result = await operator(repository, baskets).proposal({});
    expect(fetchedSymbols(fetch)).toEqual(["SPY", "AAA", "CCC", "BBB", "XLK"]);
    expect(result.proposalOnly).toBe(true);
    expect(result.computedAt).toBe(now.toISOString());
    expect(result.rules.maxLossGatePct).toBe(2);
    expect(result.buckets).toEqual([
      {
        listId: "moby",
        listName: "moby picks",
        memberCount: 2,
        symbol: "TMOBY",
      },
      {
        listId: "wish",
        listName: "wish picks",
        memberCount: 2,
        symbol: "WISH",
      },
    ]);
    expect(result.rows.map((entry) => entry.symbol)).toEqual([
      "AAA",
      "CCC",
      "BBB",
    ]);
    const [aaa, ccc, bbb] = result.rows;
    expect(aaa).toMatchObject({
      buckets: ["TMOBY", "WISH"],
      sectorEtf: "XLK",
      status: "pass",
    });
    expect(["full", "half"]).toContain(aaa?.tier);
    expect(aaa?.structure).toMatchObject({
      dte: 134,
      expiry: "2027-03-19",
      kind: "call-debit-spread",
    });
    expect(aaa?.maxLossPctNlv).toBeGreaterThan(0);
    expect(aaa?.maxLossPctNlv).toBeLessThanOrEqual(2);
    expect(ccc).toMatchObject({
      notes: "No entry: no daily bars (Yahoo chart returned HTTP 404).",
      structure: null,
      tier: "none",
    });
    expect(bbb).toMatchObject({ buckets: ["WISH"], tier: "none" });
    expect(result.totalMaxLossPct).toBe(aaa?.maxLossPctNlv);
    expect(result.notProposed).toEqual([]);
  });

  it("proposes the first 60 members and reports the rest", async () => {
    const ranked = Array.from({ length: 61 }, (_, index) =>
      row(`M${String(index).padStart(3, "0")}`, { rank: index + 1 })
    );
    const members = (rows: readonly PickListMemberRow[]) =>
      rows.map((entry) => ({ symbol: entry.symbol, weight: "0.1" }));
    const fetch = useYahoo({});
    const result = await operator(
      pickListRepository([
        pickList("a", ranked.slice(0, 40), "AAA"),
        pickList("b", ranked.slice(40), "BBB"),
      ]),
      basketRepository([
        basket("AAA", members(ranked.slice(0, 40))),
        basket("BBB", members(ranked.slice(40))),
      ])
    ).proposal({});
    expect(fetchedSymbols(fetch)).toHaveLength(61);
    expect(result.rows).toHaveLength(60);
    expect(result.notProposed).toEqual(["M060"]);
    expect(result.totalMaxLossPct).toBe(0);
  });

  it("returns an empty proposal without buckets", async () => {
    useYahoo({});
    const result = await operator(
      pickListRepository([pickList("loose", [row("ZZZ")])]),
      basketRepository()
    ).proposal({});
    expect(result.buckets).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("reports storage failures", async () => {
    useYahoo({});
    const repository = pickListRepository();
    repository.listByUser = vi.fn(async () => {
      throw new DatabasePersistenceError("list");
    });
    await expectCode(
      operator(repository, basketRepository()).proposal({}),
      "STORAGE_ERROR",
      503
    );
    // Lists load, but basket storage is missing.
    await expectCode(
      operator(pickListRepository()).proposal({}),
      "STORAGE_ERROR",
      503
    );
  });

  it("lets the read-only agent viewer read the operator buckets", async () => {
    useYahoo({});
    const repository = pickListRepository([
      pickList("moby", [row("AAA")], "TMOBY"),
      pickList("own", [row("VVV")], "VIEW", "viewer"),
      pickList("other", [row("OOO")], "OTHER", "outsider"),
    ]);
    const baskets = basketRepository([
      basket("TMOBY", [{ symbol: "AAA", weight: "1" }]),
      basket("VIEW", [{ symbol: "VVV", weight: "1" }]),
      basket("OTHER", [{ symbol: "OOO", weight: "1" }]),
    ]);
    const result = await clientFor(
      session("viewer"),
      repository,
      baskets
    ).pickLists.proposal({});
    expect(repository.listByUserEmails).toHaveBeenCalledWith([
      "operator@domain.test",
    ]);
    expect(repository.listByUser).not.toHaveBeenCalled();
    expect(baskets.listByUser).toHaveBeenCalledWith("operator");
    expect(result.buckets.map((bucket) => bucket.symbol)).toEqual(["TMOBY"]);
    expect(result.rows.map((entry) => entry.symbol)).toEqual(["AAA"]);
    // The viewer still cannot change a bucket.
    await expectCode(
      clientFor(session("viewer"), repository, baskets).pickLists.syncBucket({
        bucketSymbol: "TMOBY",
        id: "moby",
      }),
      "FORBIDDEN",
      403
    );
  });

  it("reads the key owner's own buckets with an API key", async () => {
    useYahoo({});
    const repository = pickListRepository([
      pickList("moby", [row("AAA")], "TMOBY"),
    ]);
    const result = await clientFor(null, repository, basketRepository(), {
      apiKey: true,
    }).pickLists.proposal({});
    expect(repository.listByUser).toHaveBeenCalledWith("operator");
    expect(repository.listByUserEmails).not.toHaveBeenCalled();
    expect(result.buckets).toEqual([]);
  });

  it("counts DTE from the New York date", async () => {
    // 2026-11-06T02:00Z is still 2026-11-05 in New York.
    const late = new Date("2026-11-06T02:00:00.000Z");
    setPickListOptionsForTesting({
      fetch: yahooWith({
        AAA: { closes: rising(120) },
        SPY: { closes: rising(120, 400, 1) },
      }),
      now: () => late,
    });
    const result = await operator(
      pickListRepository([pickList("one", [row("AAA")], "ONE")]),
      basketRepository([basket("ONE", [{ symbol: "AAA", weight: "1" }])])
    ).proposal({});
    expect(result.rows[0]?.structure).toMatchObject({
      dte: 134,
      expiry: "2027-03-19",
    });
  });
});

describe("pickLists.screen with IBKR history", () => {
  const now = new Date("2026-11-05T21:00:00.000Z");
  const DAY_MS = 86_400_000;
  // One IBKR daily bar per calendar day from 2025-11-05 through 2026-11-05.
  const yearOfBars = (start = Date.UTC(2025, 10, 5), close = 100) =>
    Array.from(
      { length: Math.round((Date.UTC(2026, 10, 5) - start) / DAY_MS) + 1 },
      (_, index) =>
        historyBar((start + index * DAY_MS) / 1000, close + index * 0.1)
    );
  const ibkrClient = (repository: PickListRepository) =>
    clientFor(session("operator"), repository, undefined, {
      marketHistory: HISTORY_CONFIG,
    }).pickLists;
  // No sector: the screen reads SPY and AAA only (two requests fit the per-isolate pacing budget).
  const list = () => pickList("core", [row("AAA")]);

  beforeEach(() => {
    resetIbkrPacing();
  });

  it("screens from IBKR bars without a Yahoo request, dropping a live or empty bar", async () => {
    const yahoo = yahooWith({});
    let fetchedAt = "2026-11-10T20:00:00Z";
    const history = withHistory((url) => {
      const bars = yearOfBars();
      // A bar without a positive price is dropped.
      bars[10] = historyBar((bars[10] as { t: number }).t, 0);
      // A bar without volume counts as 0 shares.
      bars[11] = { ...(bars[11] as MarketBar), v: null };
      return historyResponse(url, bars, { fetchedAt });
    }, yahoo);
    setPickListOptionsForTesting({ fetch: history.fetch, now: () => now });
    const repository = pickListRepository([list()]);
    const result = await ibkrClient(repository).screen({ id: "core" });
    expect(yahoo).not.toHaveBeenCalled();
    expect(
      history.urls.map((url) => new URL(url).searchParams.get("symbol"))
    ).toEqual(["SPY", "AAA"]);
    expect(history.urls[0]).toContain("barSize=1+day");
    expect(history.urls[0]).toContain("duration=1+Y");
    expect(history.urls[0]).toContain("whatToShow=TRADES");
    expect(result.members[0]).toMatchObject({
      lastDate: "2026-11-05",
      reason: null,
      symbol: "AAA",
    });
    // A cached copy fetched during the session holds a live newest bar: it is dropped.
    resetIbkrPacing();
    fetchedAt = "2026-11-05T15:00:00Z";
    setPickListOptionsForTesting({ fetch: history.fetch, now: () => now });
    const live = await ibkrClient(repository).screen({ id: "core" });
    expect(live.members[0]?.lastDate).toBe("2026-11-04");
    expect(yahoo).not.toHaveBeenCalled();
  });

  it("reads Yahoo when IBKR fails or its pacing slots are used up", async () => {
    const yahoo = yahooWith({
      AAA: { closes: rising(120) },
      SPY: { closes: rising(120, 400, 1) },
      XLK: { closes: rising(120, 200, 0.3) },
    });
    const history = withHistory(
      () => Response.json({ error: "down" }, { status: 503 }),
      yahoo
    );
    setPickListOptionsForTesting({ fetch: history.fetch, now: () => now });
    const repository = pickListRepository([list()]);
    const result = await ibkrClient(repository).screen({ id: "core" });
    expect(history.urls).toHaveLength(2);
    expect(yahoo.mock.calls.map(([url]) => symbolOf(url))).toEqual([
      "SPY",
      "AAA",
    ]);
    expect(result.members[0]).toMatchObject({ last: 111.9, reason: null });
    // The next view inside the pacing window does not ask IBKR again.
    setPickListOptionsForTesting({ fetch: history.fetch, now: () => now });
    await ibkrClient(repository).screen({ id: "core" });
    expect(history.urls).toHaveLength(2);
    expect(yahoo).toHaveBeenCalledTimes(4);
  });

  it("fills the days before IBKR's late first bar from Yahoo with continuous volume", async () => {
    // Yahoo: 200 days at 100 (volume 1000 shares) from 2025-11-03 through 2026-05-21.
    const yahoo = yahooWith({
      AAA: { closes: Array.from({ length: 200 }, () => 100) },
      SPY: { closes: rising(200, 400, 1) },
      XLK: { closes: rising(200, 200, 0.3) },
    });
    // IBKR: 10 days at 200 from 2026-05-22, 10 lots of 100 shares each.
    const late = Array.from({ length: 10 }, (_, index) =>
      historyBar((Date.UTC(2026, 4, 22) + index * DAY_MS) / 1000, 200, 10)
    );
    const history = withHistory(
      (url) =>
        url.includes("symbol=AAA")
          ? historyResponse(url, late)
          : Response.json({ error: "down" }, { status: 503 }),
      yahoo
    );
    setPickListOptionsForTesting({ fetch: history.fetch, now: () => now });
    const result = await ibkrClient(pickListRepository([list()])).screen({
      id: "core",
    });
    expect(yahoo.mock.calls.map(([url]) => symbolOf(url))).toContain("AAA");
    // The last 20 bars: 10 Yahoo days at 100 and 10 IBKR days at 200, 1000 shares each.
    expect(result.members[0]?.lastDate).toBe("2026-05-31");
    expect(result.members[0]?.gates.aboveVwap20.detail).toBe(
      "Close 200.00 vs 20-day VWAP 150.00"
    );
  });
});
