import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Breadth90CollectRecord,
  Breadth90DayRecord,
  Breadth90EventRecord,
  Breadth90Repository,
  Breadth90StatusRecord,
  Breadth90StoredDay,
  Breadth90StoredEvent,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { Breadth90CollectInput } from "./contracts/breadth-90.ts";
import { sessionWindow } from "./server/breadth-90.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const NOW = new Date("2026-11-06T21:20:00.000Z");
const PLAINTEXT = "dfk_breadth90_test_key";

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-07T21:20:00.000Z"),
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

/** In-memory repository with the same upsert and insert-once semantics as the Postgres one. */
const createMemoryRepository = () => {
  const days = new Map<string, Breadth90StoredDay>();
  const events = new Map<string, Breadth90StoredEvent>();
  let status: (Breadth90StatusRecord & { updatedAt: Date }) | null = null;
  let id = 0;
  const store = {
    getStatus: vi.fn(async () => status),
    listRecentDays: vi.fn(async (limit: number) =>
      [...days.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit)
    ),
    listRecentEvents: vi.fn(async (limit: number) =>
      [...events.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit)
    ),
    recordEvents: vi.fn(async (input: readonly Breadth90EventRecord[]) => {
      const created: Breadth90StoredEvent[] = [];
      for (const event of input) {
        const key = `${event.kind}|${event.date}|${event.tier}`;
        if (events.has(key)) continue;
        id += 1;
        const stored = { ...event, createdAt: NOW, id: `event-${id}` };
        events.set(key, stored);
        created.push(stored);
      }
      return created;
    }),
    saveStatus: vi.fn(async (next: Breadth90StatusRecord) => {
      status = { ...next, updatedAt: NOW };
    }),
    upsertDays: vi.fn(async (input: readonly Breadth90DayRecord[]) => {
      for (const day of input) days.set(day.date, { ...day, updatedAt: NOW });
      return input.length;
    }),
  };
  const repository = {
    ...store,
    // The Postgres repository runs these three in one transaction.
    collect: vi.fn(async (push: Breadth90CollectRecord) => {
      const written = await store.upsertDays(push.days);
      const created = await store.recordEvents(push.events);
      await store.saveStatus(push.status);
      return { created, days: written };
    }),
  } satisfies Breadth90Repository;
  return { days, events, repository };
};

const clientFor = (
  options: Readonly<{
    repository?: Breadth90Repository;
    apiKey?: string;
    keyAccess?: "read" | "write";
    sessionUser?: string;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.repository === undefined
      ? {}
      : { breadth90: options.repository }),
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
        operatorEmails: ["owner@domain.test"],
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => session(options.sessionUser ?? "owner"),
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

const finalDay = (
  date: string,
  upPct = 50
): Breadth90CollectInput["days"][number] => ({
  adv: 1500.4,
  advPct: 50,
  date,
  decl: 1499.6,
  dvol: 1_000_000_000,
  final: true,
  kind: "NEUTRAL",
  source: "tradingview",
  sourceAsOf: `${date}T21:10:00.000Z`,
  upPct,
  uvol: 1_000_000_000,
});

const push = (
  overrides: Partial<Breadth90CollectInput> = {}
): Breadth90CollectInput => ({
  armedOn: "2026-10-28",
  asOf: "2026-11-06T21:15:00.000Z",
  basket: {
    asOf: "2026-11-05",
    reportPath: "reports/dip-basket.md",
    rulesNote: "Research only.",
    summary: "Dip basket",
    tiers: [{ id: "core", label: "Core", tickers: ["SPY"], weightPctNlv: 20 }],
  },
  days: [
    { ...finalDay("2026-10-28", 8.4), kind: "DOWN_90" },
    { ...finalDay("2026-11-06", 93.1), final: false, kind: "UP_90" },
  ],
  events: [
    {
      advPct: 50,
      armedOn: "2026-10-28",
      date: "2026-10-28",
      grade: null,
      kind: "ARMED",
      strict: true,
      tier: "strict",
      trigger: null,
      upPct: 8.4,
    },
  ],
  sessionsLeft: 23,
  state: "FORMING",
  strict: true,
  ...overrides,
});

describe("breadth90.collect", () => {
  it("stores sessions, records each event once and replaces the status", async () => {
    const memory = createMemoryRepository();
    const client = clientFor({
      apiKey: PLAINTEXT,
      repository: memory.repository,
    });
    const first = await client.breadth90.collect(push());
    expect(first).toEqual({
      asOf: "2026-11-06T21:15:00.000Z",
      newEvents: [push().events[0]],
      stored: { days: 2, events: 1 },
    });
    expect(memory.days.get("2026-10-28")).toMatchObject({
      adv: 1500,
      decl: 1500,
    });
    expect(memory.repository.saveStatus).toHaveBeenCalledWith({
      armedOn: "2026-10-28",
      asOf: new Date("2026-11-06T21:15:00.000Z"),
      basket: push().basket,
      sessionsLeft: 23,
      state: "FORMING",
      strict: true,
    });
    // A rerun records nothing new, and the closed session overwrites its intraday row.
    const second = await client.breadth90.collect(
      push({
        days: [{ ...finalDay("2026-11-06", 92), kind: "UP_90" }],
        state: "FIRED",
      })
    );
    expect(second.newEvents).toEqual([]);
    expect(second.stored).toEqual({ days: 1, events: 0 });
    expect(memory.days.get("2026-11-06")).toMatchObject({
      final: true,
      upPct: 92,
    });
  });

  it("needs an agent write key", async () => {
    const memory = createMemoryRepository();
    await expectCode(
      clientFor({ repository: memory.repository }).breadth90.collect(push()),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        repository: memory.repository,
      }).breadth90.collect(push()),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({
        apiKey: "dfk_wrong",
        repository: memory.repository,
      }).breadth90.collect(push()),
      "UNAUTHORIZED",
      401
    );
    expect(memory.repository.collect).not.toHaveBeenCalled();
  });

  it("rejects an invalid push and reports missing storage", async () => {
    const memory = createMemoryRepository();
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        repository: memory.repository,
      }).breadth90.collect({
        ...push(),
        state: "SOLD" as never,
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      clientFor({ apiKey: PLAINTEXT }).breadth90.collect(push()),
      "STORAGE_ERROR",
      503
    );
  });
});

describe("breadth90.get", () => {
  it("returns an empty card before the first push", async () => {
    const memory = createMemoryRepository();
    await expect(
      clientFor({ repository: memory.repository }).breadth90.get({})
    ).resolves.toEqual({
      days: [],
      events: [],
      status: null,
      thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
    });
  });

  it("returns the status, sessions oldest first and events newest first", async () => {
    const memory = createMemoryRepository();
    await clientFor({
      apiKey: PLAINTEXT,
      repository: memory.repository,
    }).breadth90.collect(push());
    for (const client of [
      clientFor({ repository: memory.repository }),
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        repository: memory.repository,
      }),
    ]) {
      const card = await client.breadth90.get({});
      expect(card.status).toEqual({
        armedOn: "2026-10-28",
        asOf: "2026-11-06T21:15:00.000Z",
        basket: push().basket,
        sessionsLeft: 23,
        state: "FORMING",
        strict: true,
      });
      expect(card.days.map((day) => [day.date, day.final])).toEqual([
        ["2026-10-28", true],
        ["2026-11-06", false],
      ]);
      expect(card.days[0]).toMatchObject({
        sourceAsOf: "2026-10-28T21:10:00.000Z",
        updatedAt: NOW.toISOString(),
      });
      expect(card.events).toEqual([
        { ...push().events[0], createdAt: NOW.toISOString() },
      ]);
    }
    expect(memory.repository.listRecentDays).toHaveBeenCalledWith(31);
    expect(memory.repository.listRecentEvents).toHaveBeenCalledWith(20);
  });

  it("is operator-only and needs storage", async () => {
    const memory = createMemoryRepository();
    await expectCode(
      clientFor({
        repository: memory.repository,
        sessionUser: "stranger",
      }).breadth90.get({}),
      "FORBIDDEN",
      403
    );
    await expectCode(clientFor({}).breadth90.get({}), "STORAGE_ERROR", 503);
  });
});

describe("sessionWindow", () => {
  const stored = (date: string, final: boolean): Breadth90StoredDay => ({
    ...finalDay(date),
    adv: 1500,
    decl: 1500,
    final,
    updatedAt: NOW,
  });

  it("keeps finals and a trailing intraday session, oldest first, at most 30", () => {
    const finals = Array.from({ length: 31 }, (_, index) =>
      stored(`2026-09-${String(30 - index).padStart(2, "0")}`, true)
    );
    const window = sessionWindow([stored("2026-10-01", false), ...finals]);
    expect(window).toHaveLength(30);
    expect(window.at(-1)).toMatchObject({ date: "2026-10-01", final: false });
    expect(window[0]?.date).toBe("2026-09-02");
  });

  it("drops an intraday row older than the newest session", () => {
    expect(
      sessionWindow([
        stored("2026-11-06", true),
        stored("2026-11-05", false),
        stored("2026-11-04", true),
      ]).map((day) => day.date)
    ).toEqual(["2026-11-04", "2026-11-06"]);
  });
});
