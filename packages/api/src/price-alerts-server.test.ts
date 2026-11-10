import { readFileSync } from "node:fs";
import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { WatchlistItem } from "@darkfactory/db/schema";
import {
  PriceAlertLimitError,
  type PriceAlertRepository,
  type PriceAlertRuleRecord,
  type Repositories,
  type WatchlistRepository,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import type {
  DeployStatusConfig,
  DeployStatusFetch,
} from "./server/deploy-status.ts";
import { handleApiRequest } from "./server/handler.ts";
import { resetIbkrPacing } from "./server/merged-bars.ts";
import {
  HISTORY_CONFIG,
  historyBar,
  historyResponse,
  withHistory,
} from "./server/merged-bars.test-support.ts";
import {
  type PriceAlertsNtfyConfig,
  resolvePriceAlertsNtfyConfig,
  setPriceAlertsOptionsForTesting,
} from "./server/price-alerts.ts";

// Yahoo chart fixtures copied from day-trader-skill (MIT); see fixtures/day-trader-skill/NOTICE.md.
const fixtureText = (symbol: string): string =>
  readFileSync(
    new URL(
      `./fixtures/day-trader-skill/trader-alerts/yahoo-${symbol}.json`,
      import.meta.url
    ),
    "utf8"
  );

const CREATED = new Date("2026-10-13T13:00:00.000Z");
const NOW = new Date("2026-10-13T20:05:00.000Z");
const PLAINTEXT = "dfk_price_alerts_test_key";
const NTFY: PriceAlertsNtfyConfig = {
  origin: "https://ntfy.domain.test",
  token: "tk_secret-token",
  topic: "vertex-secret-topic",
};

const record = (
  overrides: Partial<PriceAlertRuleRecord> = {}
): PriceAlertRuleRecord => ({
  createdAt: CREATED,
  id: "rule-1",
  kind: "below",
  level: "54",
  note: null,
  role: "stop",
  state: { lastCheckedAt: null, status: "active" },
  symbol: "BAC",
  userId: "owner",
  ...overrides,
});

// In-memory owner-scoped repository with the same state rules as Postgres.
const memoryRules = (initial: PriceAlertRuleRecord[] = []) => {
  const rows = [...initial];
  const replace = (next: PriceAlertRuleRecord) => {
    rows.splice(
      rows.findIndex((row) => row.id === next.id),
      1,
      next
    );
    return next;
  };
  const repository = {
    create: vi.fn(async (input) => {
      const created = record({ ...input, id: `rule-${rows.length + 1}` });
      rows.push(created);
      return created;
    }),
    // Owners stand in for users whose email is `<userId>@domain.test`.
    listActive: vi.fn(
      async (limit: number, operatorEmails: readonly string[] | undefined) =>
        rows
          .filter(
            (row) =>
              row.state.status === "active" &&
              (operatorEmails ?? []).includes(`${row.userId}@domain.test`)
          )
          .slice(0, limit)
    ),
    listActiveByUser: vi.fn(async (userId: string) =>
      rows.filter(
        (row) => row.userId === userId && row.state.status === "active"
      )
    ),
    listByUser: vi.fn(async (userId: string) =>
      rows.filter((row) => row.userId === userId)
    ),
    markAttempted: vi.fn(async (ids: readonly string[]) => {
      // Back of the queue, like ordering by updated_at.
      for (const id of ids) {
        const index = rows.findIndex((row) => row.id === id);
        const [moved] = index < 0 ? [] : rows.splice(index, 1);
        if (moved !== undefined) rows.push(moved);
      }
    }),
    markChecked: vi.fn(async (ids: readonly string[], checkedAt: Date) => {
      for (const row of rows)
        if (ids.includes(row.id) && row.state.status === "active")
          replace({
            ...row,
            state: { lastCheckedAt: checkedAt, status: "active" },
          });
    }),
    recordDelivery: vi.fn(async (ids: readonly string[], delivery) =>
      rows
        .filter(
          (row) =>
            ids.includes(row.id) &&
            row.state.status === "triggered" &&
            row.state.delivery === "pending"
        )
        .map((row) =>
          replace({
            ...row,
            state: {
              delivery,
              status: "triggered",
              triggeredAt:
                row.state.status === "triggered" ? row.state.triggeredAt : NOW,
              triggerPrice:
                row.state.status === "triggered" ? row.state.triggerPrice : "",
            },
          })
        )
    ),
    remove: vi.fn(async (id: string, userId: string) => {
      const index = rows.findIndex(
        (row) => row.id === id && row.userId === userId
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    trigger: vi.fn(async (input) => {
      const row = rows.find((candidate) => candidate.id === input.id);
      if (row === undefined || row.state.status !== "active") return null;
      return replace({
        ...row,
        state: {
          delivery: "pending",
          status: "triggered",
          triggeredAt: input.triggeredAt,
          triggerPrice: input.triggerPrice,
        },
      });
    }),
  } satisfies PriceAlertRepository;
  return { repository, rows };
};

const watchlistOf = (symbols: string[]): WatchlistRepository => ({
  addMany: vi.fn(),
  listByUser: vi.fn(async (userId: string) =>
    symbols.map(
      (symbol): WatchlistItem => ({
        buyZoneHigh: null,
        buyZoneLow: null,
        createdAt: CREATED,
        id: `w-${symbol}`,
        note: null,
        symbol,
        updatedAt: CREATED,
        userId,
      })
    )
  ),
  remove: vi.fn(),
  update: vi.fn(),
});

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: CREATED,
    expiresAt: new Date("2026-10-14T13:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: CREATED,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: CREATED,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: CREATED,
  },
});

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const clientFor = (
  options: Readonly<{
    rules?: PriceAlertRepository;
    watchlist?: WatchlistRepository;
    ntfy?: PriceAlertsNtfyConfig | null;
    apiKey?: string;
    keyAccess?: "read" | "write";
    session?: SafeAuthSession | null;
    marketHistory?: DeployStatusConfig;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.rules === undefined ? {} : { priceAlerts: options.rules }),
    ...(options.watchlist === undefined
      ? {}
      : { watchlist: options.watchlist }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        access: options.keyAccess ?? "write",
        apiKeyId: "key-1",
        email: "owner@domain.test",
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "owner",
      };
    }),
  };
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request) => {
      if (options.apiKey !== undefined)
        request.headers.set("x-api-key", options.apiKey);
      const context = createApiContext(request, {
        agentApiKeys: agentApiKeys as never,
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        ...(options.marketHistory === undefined
          ? {}
          : { marketHistory: options.marketHistory }),
        operatorEmails: ["owner@domain.test", "second@domain.test"],
        priceAlertsNtfy: options.ntfy ?? null,
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          const current =
            options.session === undefined ? session("owner") : options.session;
          if (current === null) throw denied();
          return current;
        },
      });
      return handleApiRequest(request, context);
    },
  });
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

// Yahoo stand-in: serves the upstream fixtures by symbol; an unknown symbol is Yahoo's 404.
const yahoo = vi.fn(async (url: string) => {
  const symbol = /chart\/([^?]+)\?/u.exec(url)?.[1] ?? "";
  if (!["AAPL", "BAC", "KO", "TSLA"].includes(symbol))
    return new Response(fixtureText("ZZZZ"), {
      headers: { "content-type": "application/json" },
      status: 404,
    });
  return new Response(fixtureText(symbol), {
    headers: { "content-type": "application/json;charset=utf-8" },
  });
});

const ntfyAccepting = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { topic: string };
  return Response.json({ event: "message", id: "msg1", topic: body.topic });
});

afterEach(() => {
  setPriceAlertsOptionsForTesting({});
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolvePriceAlertsNtfyConfig", () => {
  it("is configured only with an origin and a topic; the token is optional", () => {
    expect(resolvePriceAlertsNtfyConfig(undefined, "t", "k")).toBeNull();
    expect(
      resolvePriceAlertsNtfyConfig("https://n.test", undefined, "k")
    ).toBeNull();
    expect(
      resolvePriceAlertsNtfyConfig("https://n.test", "t", undefined)
    ).toEqual({
      origin: "https://n.test",
      token: null,
      topic: "t",
    });
    expect(
      resolvePriceAlertsNtfyConfig("https://n.test", "t", "k")?.token
    ).toBe("k");
  });
});

describe("priceAlerts.list / create / remove", () => {
  it("lists the owner's rules, watchlist symbols and whether ntfy is configured", async () => {
    const { repository } = memoryRules([
      record(),
      record({ id: "other", userId: "someone-else" }),
    ]);
    const watchlist = watchlistOf(["AAPL", "BAC"]);
    const listed = await clientFor({
      rules: repository,
      watchlist,
    }).priceAlerts.list({});
    expect(listed).toEqual({
      notifications: "not-configured",
      rules: [
        {
          createdAt: CREATED,
          id: "rule-1",
          kind: "below",
          level: "54",
          note: null,
          role: "stop",
          state: { lastCheckedAt: null, status: "active" },
          symbol: "BAC",
        },
      ],
      symbols: ["AAPL", "BAC"],
    });
    const configured = await clientFor({
      ntfy: NTFY,
      rules: repository,
      watchlist,
    }).priceAlerts.list({});
    expect(configured.notifications).toBe("configured");
    expect(JSON.stringify(configured)).not.toContain("secret");
  });

  it("creates a rule only for a watchlist symbol and maps the per-owner cap", async () => {
    const { repository } = memoryRules();
    const client = clientFor({
      rules: repository,
      watchlist: watchlistOf(["BAC"]),
    });
    const created = await client.priceAlerts.create({
      kind: "below",
      level: "54",
      note: " lunch low ",
      role: "stop",
      symbol: "bac",
    });
    expect(created.rule).toMatchObject({
      kind: "below",
      level: "54",
      note: "lunch low",
      role: "stop",
      state: { status: "active" },
      symbol: "BAC",
    });
    expect(repository.create).toHaveBeenCalledWith({
      kind: "below",
      level: "54",
      note: "lunch low",
      role: "stop",
      symbol: "BAC",
      userId: "owner",
    });
    await client.priceAlerts.create({
      kind: "above",
      level: 60,
      role: "target",
      symbol: "BAC",
    });
    expect(repository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ level: "60", note: null })
    );
    await expectCode(
      client.priceAlerts.create({
        kind: "above",
        level: "1",
        role: "price",
        symbol: "AAPL",
      }),
      "BAD_REQUEST",
      400
    );
    repository.create.mockRejectedValueOnce(new PriceAlertLimitError());
    await expectCode(
      client.priceAlerts.create({
        kind: "above",
        level: "1",
        role: "price",
        symbol: "BAC",
      }),
      "VALIDATION_ERROR",
      422
    );
    repository.create.mockRejectedValueOnce(new Error("storage down"));
    await expectCode(
      client.priceAlerts.create({
        kind: "above",
        level: "1",
        role: "price",
        symbol: "BAC",
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("removes only the owner's rule", async () => {
    const { repository } = memoryRules([record()]);
    const client = clientFor({ rules: repository });
    await expect(client.priceAlerts.remove({ id: "rule-1" })).resolves.toEqual({
      id: "rule-1",
      removed: true,
    });
    await expectCode(
      client.priceAlerts.remove({ id: "rule-1" }),
      "NOT_FOUND",
      404
    );
  });

  it("reports missing storage and refuses non-operators and read keys for writes", async () => {
    await expectCode(
      clientFor({}).priceAlerts.remove({ id: "x" }),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({ rules: memoryRules().repository }).priceAlerts.list({}),
      "STORAGE_ERROR",
      503
    );
    await expectCode(
      clientFor({
        rules: memoryRules().repository,
        session: session("stranger"),
      }).priceAlerts.list({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({
        rules: memoryRules().repository,
        session: null,
      }).priceAlerts.list({}),
      "UNAUTHORIZED",
      401
    );
    const reader = clientFor({
      apiKey: PLAINTEXT,
      keyAccess: "read",
      rules: memoryRules().repository,
      watchlist: watchlistOf([]),
    });
    await expect(reader.priceAlerts.list({})).resolves.toMatchObject({
      rules: [],
    });
    await expectCode(reader.priceAlerts.tick({}), "FORBIDDEN", 403);
  });
});

describe("priceAlerts.check", () => {
  it("triggers a touched stop once, notifies ntfy with fixed text and marks untouched rules checked", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const checkedBefore = new Date("2026-10-13T19:00:00.000Z");
    const { repository, rows } = memoryRules([
      record(),
      record({
        id: "rule-2",
        kind: "above",
        level: "400",
        role: "target",
        state: { lastCheckedAt: checkedBefore, status: "active" },
        symbol: "AAPL",
      }),
      record({ id: "rule-3", symbol: "NOPE" }),
    ]);
    const client = clientFor({ ntfy: NTFY, rules: repository });
    const result = await client.priceAlerts.check({});
    expect(result.checked).toBe(2);
    expect(result.delivery).toBe("sent");
    expect(result.quoteErrors).toEqual([
      { reason: "Yahoo chart returned HTTP 404", symbol: "NOPE" },
    ]);
    expect(result.triggered).toEqual([
      expect.objectContaining({
        id: "rule-1",
        state: {
          delivery: "sent",
          status: "triggered",
          triggeredAt: NOW,
          triggerPrice: "53.64",
        },
      }),
    ]);
    expect(result.rules).toHaveLength(3);
    expect(rows.find((row) => row.id === "rule-2")?.state).toEqual({
      lastCheckedAt: NOW,
      status: "active",
    });
    expect(rows.find((row) => row.id === "rule-3")?.state).toEqual({
      lastCheckedAt: null,
      status: "active",
    });
    expect(repository.markAttempted).toHaveBeenCalledWith(["rule-3"]);
    expect(rows.at(-1)?.id).toBe("rule-3");
    expect(ntfyAccepting).toHaveBeenCalledTimes(1);
    const [url, init] = ntfyAccepting.mock.calls[0] ?? [];
    expect(url).toBe("https://ntfy.domain.test/");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tk_secret-token",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      message:
        "A price alert rule triggered. Open Vertex to review it. This is not an instruction to trade.",
      title: "Vertex price alert",
      topic: "vertex-secret-topic",
    });
    expect(yahoo).toHaveBeenCalledWith(
      "https://query1.finance.yahoo.com/v8/finance/chart/BAC?range=1d&interval=5m",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
    const again = await client.priceAlerts.check({});
    expect(again).toMatchObject({
      checked: 1,
      delivery: "none",
      triggered: [],
    });
    expect(ntfyAccepting).toHaveBeenCalledTimes(1);
  });

  it("records not-configured without ntfy and failed when ntfy does not accept", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: async () => new Response("down", { status: 500 }),
      now: () => NOW,
    });
    const unconfigured = memoryRules([record()]);
    const plain = await clientFor({
      rules: unconfigured.repository,
    }).priceAlerts.check({});
    expect(plain.delivery).toBe("not-configured");
    expect(plain.triggered[0]?.state).toMatchObject({
      delivery: "not-configured",
    });
    const failing = memoryRules([record()]);
    const failed = await clientFor({
      ntfy: NTFY,
      rules: failing.repository,
    }).priceAlerts.check({});
    expect(failed.delivery).toBe("failed");
    const invalid = memoryRules([record()]);
    const refused = await clientFor({
      ntfy: { ...NTFY, origin: "http://ntfy.domain.test" },
      rules: invalid.repository,
    }).priceAlerts.check({});
    expect(refused.delivery).toBe("failed");
  });

  it("skips non-active rules, keeps a lost trigger race silent and keeps a pending delivery it could not settle", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const { repository } = memoryRules([record(), record({ id: "rule-2" })]);
    repository.listActiveByUser.mockResolvedValueOnce([
      record({
        id: "done",
        state: {
          delivery: "sent",
          status: "triggered",
          triggeredAt: CREATED,
          triggerPrice: "1",
        },
      }),
      record(),
      record({ id: "rule-2" }),
    ]);
    repository.trigger.mockResolvedValueOnce(null);
    repository.recordDelivery.mockResolvedValueOnce([]);
    const result = await clientFor({
      ntfy: NTFY,
      rules: repository,
    }).priceAlerts.check({});
    expect(result.checked).toBe(2);
    expect(result.triggered.map((rule) => rule.id)).toEqual(["rule-2"]);
    expect(result.triggered[0]?.state).toMatchObject({ delivery: "pending" });
    expect(repository.trigger).toHaveBeenCalledTimes(2);
  });

  it("uses the platform fetch and clock by default", async () => {
    const platformFetch = vi.fn(async (url: string, init: RequestInit) =>
      url.includes("yahoo") ? yahoo(url) : ntfyAccepting(url, init)
    );
    vi.stubGlobal("fetch", platformFetch);
    const { repository } = memoryRules([record()]);
    const result = await clientFor({
      ntfy: NTFY,
      rules: repository,
    }).priceAlerts.check({});
    expect(result.delivery).toBe("sent");
    expect(platformFetch).toHaveBeenCalledTimes(2);
  });

  it("notifies before writing the checked marks, so a failed mark cannot lose a notification", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const { repository, rows } = memoryRules([
      record(),
      record({ id: "rule-2", kind: "above", level: "400", symbol: "AAPL" }),
    ]);
    repository.markChecked.mockRejectedValueOnce(new Error("database down"));
    await expect(
      clientFor({ ntfy: NTFY, rules: repository }).priceAlerts.check({})
    ).rejects.toBeInstanceOf(ORPCError);
    expect(ntfyAccepting).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.id === "rule-1")?.state).toMatchObject({
      delivery: "sent",
      status: "triggered",
    });
  });
});

describe("priceAlerts.tick", () => {
  it("evaluates a bounded batch for every owner and sends one notification per owner", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const { repository } = memoryRules([
      record(),
      record({ id: "rule-2", level: "53.9" }),
      record({ id: "rule-3", kind: "above", level: "95", symbol: "KO" }),
      record({ id: "rule-4", userId: "second" }),
      record({ id: "rule-5", symbol: "ZZZZ", userId: "second" }),
      record({ id: "rule-6", userId: "former" }),
    ]);
    const result = await clientFor({
      apiKey: PLAINTEXT,
      ntfy: NTFY,
      rules: repository,
    }).priceAlerts.tick({});
    expect(result).toEqual({
      checked: 4,
      deliveries: { failed: 0, notConfigured: 0, sent: 2 },
      quoteErrors: [
        { reason: "Yahoo chart returned HTTP 404", symbol: "ZZZZ" },
      ],
      triggered: 3,
    });
    expect(repository.listActive).toHaveBeenCalledWith(200, [
      "owner@domain.test",
      "second@domain.test",
    ]);
    expect(repository.trigger).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "rule-6" })
    );
    expect(ntfyAccepting).toHaveBeenCalledTimes(2);
  });

  it("counts not-configured and failed deliveries", async () => {
    setPriceAlertsOptionsForTesting({
      fetch: yahoo,
      notify: async () => new Response("no", { status: 403 }),
      now: () => NOW,
    });
    const quiet = await clientFor({
      apiKey: PLAINTEXT,
      rules: memoryRules([record()]).repository,
    }).priceAlerts.tick({});
    expect(quiet.deliveries).toEqual({ failed: 0, notConfigured: 1, sent: 0 });
    const loud = await clientFor({
      apiKey: PLAINTEXT,
      ntfy: NTFY,
      rules: memoryRules([record()]).repository,
    }).priceAlerts.tick({});
    expect(loud.deliveries).toEqual({ failed: 1, notConfigured: 0, sent: 0 });
  });

  it("refuses a session operator: the tick is for the scheduler's agent key", async () => {
    const { repository } = memoryRules([record()]);
    await expectCode(
      clientFor({ rules: repository }).priceAlerts.tick({}),
      "FORBIDDEN",
      403
    );
    expect(repository.listActive).not.toHaveBeenCalled();
  });
});

describe("price alert quotes from IBKR history", () => {
  // 5-minute bars of 2026-10-13 from `from` (UTC hh:mm), one close per bar (low = close - 1).
  const fiveMinute = (from: string, closes: readonly number[]) =>
    closes.map((close, index) =>
      historyBar(
        Date.parse(`2026-10-13T${from}:00Z`) / 1000 + index * 300,
        close
      )
    );
  const run = async (fetch: DeployStatusFetch) => {
    setPriceAlertsOptionsForTesting({
      fetch,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const memory = memoryRules([
      // Listed first so the earlier window of rule-1 replaces it as BAC's window start.
      record({
        id: "rule-2",
        kind: "above",
        level: "70",
        role: "target",
        state: {
          lastCheckedAt: new Date("2026-10-13T19:00:00.000Z"),
          status: "active",
        },
      }),
      record(),
    ]);
    const client = clientFor({
      marketHistory: HISTORY_CONFIG,
      ntfy: NTFY,
      rules: memory.repository,
    });
    return { memory, result: await client.priceAlerts.check({}) };
  };

  beforeEach(() => {
    resetIbkrPacing();
  });

  it("evaluates IBKR 5-minute bars without a Yahoo request", async () => {
    const history = withHistory(
      (url) => historyResponse(url, fiveMinute("13:30", [56, 0, 54.5, 56])),
      yahoo
    );
    const { result } = await run(history.fetch);
    expect(yahoo).not.toHaveBeenCalled();
    expect(history.urls).toHaveLength(1);
    expect(history.urls[0]).toContain("barSize=5+mins");
    expect(history.urls[0]).toContain("duration=1+D");
    expect(history.urls[0]).toContain("useRTH=1");
    expect(result.quoteErrors).toEqual([]);
    expect(result.triggered).toEqual([
      expect.objectContaining({
        id: "rule-1",
        state: expect.objectContaining({ triggerPrice: "53.5" }),
      }),
    ]);
  });

  it("reads Yahoo when IBKR fails or answers with a stale copy", async () => {
    const failing = withHistory(
      () => Response.json({ error: "down" }, { status: 503 }),
      yahoo
    );
    const { result } = await run(failing.fetch);
    expect(failing.urls).toHaveLength(1);
    expect(yahoo).toHaveBeenCalledTimes(1);
    expect(result.triggered[0]?.state).toMatchObject({ triggerPrice: "53.64" });
    resetIbkrPacing();
    yahoo.mockClear();
    const stale = withHistory(
      (url) => historyResponse(url, fiveMinute("13:30", [80]), { stale: true }),
      yahoo
    );
    const second = await run(stale.fetch);
    expect(yahoo).toHaveBeenCalledTimes(1);
    expect(second.result.triggered[0]?.state).toMatchObject({
      triggerPrice: "53.64",
    });
    // Class shares (BRK.B) have no IBKR form here: Yahoo only.
    resetIbkrPacing();
    setPriceAlertsOptionsForTesting({
      fetch: failing.fetch,
      notify: ntfyAccepting,
      now: () => NOW,
    });
    const requests = failing.urls.length;
    const { repository } = memoryRules([
      record({ id: "rule-brk", symbol: "BRK.B" }),
    ]);
    const odd = await clientFor({
      marketHistory: HISTORY_CONFIG,
      rules: repository,
    }).priceAlerts.check({});
    expect(odd.quoteErrors.map((error) => error.symbol)).toEqual(["BRK.B"]);
    expect(failing.urls).toHaveLength(requests);
  });

  it("fills the bars before IBKR's late first bar from Yahoo", async () => {
    // IBKR starts at 13:35 (after the 09:30 open); Yahoo's 13:30 bar touched 53.64.
    const late = withHistory(
      (url) => historyResponse(url, fiveMinute("13:35", [60, 61])),
      yahoo
    );
    const { result } = await run(late.fetch);
    expect(late.urls).toHaveLength(1);
    expect(yahoo).toHaveBeenCalledTimes(1);
    expect(result.triggered).toEqual([
      expect.objectContaining({
        id: "rule-1",
        state: expect.objectContaining({ triggerPrice: "53.64" }),
      }),
    ]);
  });
});
