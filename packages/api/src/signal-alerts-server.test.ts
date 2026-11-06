import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type Repositories,
  type SignalAlertEventRecord,
  SignalAlertLimitError,
  type SignalAlertRepository,
  type SignalAlertRuleRecord,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import type { PriceAlertsNtfyConfig } from "./server/price-alerts.ts";
import { setSignalAlertsOptionsForTesting } from "./server/signal-alerts.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-11-02T14:30:00.000Z");
const CREATED = new Date(START - 60 * MINUTE);
// Bars 0-4 closed, bar 5 forming.
const NOW = new Date(START + 80 * MINUTE);
const PLAINTEXT = "dfk_signal_alerts_test_key";
const NTFY: PriceAlertsNtfyConfig = {
  origin: "https://ntfy.domain.test",
  token: "tk_secret-token",
  topic: "vertex-secret-topic",
};
const CLOSES = [9, 11, 9, 11, 9, 11];

const yahooDocument = (closes: readonly number[]) => ({
  chart: {
    result: [
      {
        indicators: {
          quote: [
            {
              close: closes,
              high: closes.map((close) => close + 1),
              low: closes.map((close) => close - 1),
              open: closes,
            },
          ],
        },
        timestamp: closes.map(
          (_, index) => (START + index * 15 * MINUTE) / 1000
        ),
      },
    ],
  },
});

const yahoo = vi.fn(async (url: string) => {
  if (url.includes("/chart/ZZZZ"))
    return Response.json({ chart: { result: null } }, { status: 404 });
  if (url.includes("/chart/BIG"))
    return Response.json(yahooDocument(CLOSES.map((close) => close * 100)));
  return Response.json(yahooDocument(CLOSES));
});

const ntfyAccepting = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { topic: string };
  return Response.json({ event: "message", id: "msg1", topic: body.topic });
});

const condition = {
  left: { field: "close", type: "price" },
  operator: "crosses-above",
  right: { type: "value", value: "10" },
} as const;

const record = (
  overrides: Partial<SignalAlertRuleRecord> = {}
): SignalAlertRuleRecord => ({
  activatedAt: null,
  condition,
  createdAt: CREATED,
  fireCount: 0,
  frequency: "per-bar-close",
  id: "rule-1",
  kind: "alert",
  lastBarAt: null,
  lastCheckedAt: null,
  lastFiredAt: null,
  lastFiredBarAt: null,
  name: "SPY 15m",
  origin: "manual",
  status: "active",
  symbol: "SPY",
  timeframe: "15m",
  userId: "owner",
  ...overrides,
});

// In-memory owner-scoped repository with the Postgres state rules (insert-once per rule and bar).
const memoryRules = (initial: SignalAlertRuleRecord[] = [], limit = 50) => {
  const rows = [...initial];
  const events: SignalAlertEventRecord[] = [];
  const replace = (next: SignalAlertRuleRecord) => {
    rows.splice(
      rows.findIndex((row) => row.id === next.id),
      1,
      next
    );
    return next;
  };
  const repository: SignalAlertRepository = {
    create: vi.fn(async (input) => {
      if (rows.filter((row) => row.userId === input.userId).length >= limit)
        throw new SignalAlertLimitError();
      const created = record({
        ...input,
        createdAt: CREATED,
        id: `rule-${rows.length + 1}`,
      });
      rows.push(created);
      return created;
    }),
    listActive: vi.fn(async (max, operatorEmails) =>
      rows
        .filter(
          (row) =>
            row.status === "active" &&
            (operatorEmails ?? []).includes(`${row.userId}@domain.test`)
        )
        .slice(0, max)
    ),
    listActiveByUser: vi.fn(async (userId) =>
      rows.filter((row) => row.userId === userId && row.status === "active")
    ),
    listByUser: vi.fn(async (userId) =>
      rows.filter((row) => row.userId === userId)
    ),
    listEvents: vi.fn(async (userId, since) =>
      events
        .filter(
          (event) =>
            event.userId === userId &&
            (since === null || event.firedAt.getTime() > since.getTime())
        )
        .reverse()
    ),
    markAttempted: vi.fn(async () => undefined),
    markChecked: vi.fn(async (id, lastBarAt, checkedAt) => {
      const row = rows.find((entry) => entry.id === id);
      if (row?.status === "active")
        replace({ ...row, lastBarAt, lastCheckedAt: checkedAt });
    }),
    recordDelivery: vi.fn(async (ids, delivery) => {
      for (const event of events)
        if (ids.includes(event.id) && event.delivery === "pending")
          events.splice(events.indexOf(event), 1, { ...event, delivery });
    }),
    recordFire: vi.fn(async (input) => {
      const row = rows.find(
        (entry) => entry.id === input.ruleId && entry.userId === input.userId
      );
      if (row?.status !== "active") return null;
      if (
        events.some(
          (event) =>
            event.ruleId === input.ruleId &&
            event.barAt.getTime() === input.barAt.getTime()
        )
      )
        return null;
      const event: SignalAlertEventRecord = {
        barAt: input.barAt,
        delivery: "pending",
        firedAt: NOW,
        id: `event-${events.length + 1}`,
        kind: row.kind,
        name: row.name,
        price: input.price,
        ruleId: row.id,
        symbol: row.symbol,
        userId: row.userId,
      };
      events.push(event);
      replace({
        ...row,
        fireCount: row.fireCount + 1,
        lastFiredAt: NOW,
        lastFiredBarAt: input.barAt,
        ...(input.done ? { status: "done" as const } : {}),
      });
      return event;
    }),
    remove: vi.fn(async (id, userId) => {
      const index = rows.findIndex(
        (row) => row.id === id && row.userId === userId
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    transition: vi.fn(async (id, userId, from, to) => {
      const row = rows.find(
        (entry) => entry.id === id && entry.userId === userId
      );
      if (row === undefined || !from.includes(row.status)) return null;
      return replace({
        ...row,
        status: to,
        ...(to === "active" ? { activatedAt: NOW } : {}),
      });
    }),
  };
  return { events, repository, rows };
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: CREATED,
    expiresAt: new Date(START + 24 * 60 * MINUTE),
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
    rules?: SignalAlertRepository;
    ntfy?: PriceAlertsNtfyConfig | null;
    apiKey?: string;
    keyAccess?: "read" | "write";
    session?: SafeAuthSession | null;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.rules === undefined ? {} : { signalAlerts: options.rules }),
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

const useFakes = () =>
  setSignalAlertsOptionsForTesting({
    fetch: yahoo as never,
    notify: ntfyAccepting,
    now: () => NOW,
  });

afterEach(() => {
  setSignalAlertsOptionsForTesting({});
  vi.clearAllMocks();
});

describe("priceAlerts.signals", () => {
  it("creates, lists and removes a strategy alert with a default name", async () => {
    useFakes();
    const { repository } = memoryRules();
    const client = clientFor({ rules: repository });
    const { rule } = await client.priceAlerts.signals.create({
      condition: {
        left: { period: 20, type: "sma" },
        operator: "crosses-above",
        right: { period: 50, type: "sma" },
      },
      frequency: "per-bar",
      origin: "strategy",
      symbol: "nq=f",
      timeframe: "1h",
    });
    expect(rule).toMatchObject({
      description: "SMA(20) crosses above SMA(50)",
      kind: "alert",
      name: "NQ=F 1h: SMA(20) crosses above SMA(50)",
      origin: "strategy",
      status: "active",
      symbol: "NQ=F",
    });
    const listed = await client.priceAlerts.signals.list({});
    expect(listed.notifications).toBe("not-configured");
    expect(listed.rules.map((entry) => entry.id)).toEqual([rule.id]);
    await expect(
      client.priceAlerts.signals.remove({ id: rule.id })
    ).resolves.toEqual({ id: rule.id, removed: true });
    await expectCode(
      client.priceAlerts.signals.remove({ id: rule.id }),
      "NOT_FOUND",
      404
    );
  });

  it("rejects invalid conditions and the per-owner limit", async () => {
    useFakes();
    const { repository } = memoryRules([], 0);
    const client = clientFor({ rules: repository });
    await expectCode(
      client.priceAlerts.signals.create({
        condition: { ...condition, right: { period: 1, type: "sma" } },
        frequency: "once",
        symbol: "SPY",
        timeframe: "15m",
      }),
      "BAD_REQUEST",
      400
    );
    for (const [timeframe, right] of [
      ["1d", { minutes: 30, side: "high", type: "opening-range" }],
      ["1h", { minutes: 30, side: "high", type: "opening-range" }],
      ["15m", { type: "value", value: "0" }],
    ] as const)
      await expectCode(
        client.priceAlerts.signals.backfill({
          condition: { ...condition, right },
          symbol: "SPY",
          timeframe,
        }),
        "BAD_REQUEST",
        400
      );
    await expectCode(
      client.priceAlerts.signals.backfill({
        condition: {
          ...condition,
          right: { minutes: 60, side: "high", type: "opening-range" },
        },
        symbol: "NQ=F",
        timeframe: "1h",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.priceAlerts.signals.backfill({
        condition: {
          ...condition,
          right: { minutes: 60, side: "high", type: "opening-range" },
        },
        symbol: "BTC-USD",
        timeframe: "1h",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      client.priceAlerts.signals.create({
        condition,
        frequency: "once",
        symbol: "SPY",
        timeframe: "15m",
      }),
      "VALIDATION_ERROR",
      422
    );
  });

  it("backfills a condition from Yahoo bars and reports market data failures", async () => {
    useFakes();
    const client = clientFor({ rules: memoryRules().repository });
    const result = await client.priceAlerts.signals.backfill({
      condition,
      symbol: "SPY",
      timeframe: "15m",
    });
    expect(result).toMatchObject({
      backfill: { bars: 5, count: 2, days: 1 },
      description: "close crosses above 10",
    });
    expect(yahoo.mock.calls[0]?.[0]).toContain("/chart/SPY?range=60d");
    await expectCode(
      client.priceAlerts.signals.backfill({
        condition,
        symbol: "ZZZZ",
        timeframe: "15m",
      }),
      "UPSTREAM_ERROR",
      502
    );
  });

  it("Quant proposes a watch that runs only after Start watching", async () => {
    useFakes();
    const { repository, rows } = memoryRules();
    const client = clientFor({ ntfy: NTFY, rules: repository });
    const proposed = await client.priceAlerts.signals.propose({
      text: "Watch SPY and wake me when a 15m bar closes above 10",
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(proposed.rule).toMatchObject({
      frequency: "per-bar-close",
      kind: "watch",
      origin: "quant",
      status: "proposed",
    });
    expect(proposed.backfill).toMatchObject({ count: 2 });
    expect(proposed.summary).toContain("Watch SPY on 15m bars");
    // A proposed watch is not evaluated.
    expect(await client.priceAlerts.signals.check({})).toMatchObject({
      checked: 0,
      events: [],
    });
    const started = await client.priceAlerts.signals.start({
      id: proposed.rule.id,
    });
    expect(started.rule.status).toBe("active");
    await expectCode(
      client.priceAlerts.signals.start({ id: proposed.rule.id }),
      "NOT_FOUND",
      404
    );
    // A watch started now never fires on bars from before it was started.
    expect(await client.priceAlerts.signals.check({})).toMatchObject({
      checked: 1,
      delivery: "none",
      events: [],
    });
    expect(rows[0]?.activatedAt).toEqual(NOW);
  });

  it("fires fresh bars once, pushes fixed text and lists events", async () => {
    useFakes();
    const { repository, rows } = memoryRules([
      record({ frequency: "per-bar" }),
    ]);
    const client = clientFor({ ntfy: NTFY, rules: repository });
    const checked = await client.priceAlerts.signals.check({});
    expect(checked).toMatchObject({ checked: 1, delivery: "sent" });
    // Bar 3 closed recently; bar 5 is forming; bar 1 is stale.
    expect(checked.events.map((event) => event.barAt)).toEqual([
      new Date(START + 45 * MINUTE),
      new Date(START + 75 * MINUTE),
    ]);
    expect(checked.events.every((event) => event.delivery === "sent")).toBe(
      true
    );
    expect(rows[0]).toMatchObject({ fireCount: 2 });
    // The ntfy body is fixed text: no symbol, price or condition.
    const body = String(ntfyAccepting.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("SPY");
    expect(body).toContain("Vertex signal alert");
    // A repeat run does not fire the same bars again.
    expect(await client.priceAlerts.signals.check({})).toMatchObject({
      delivery: "none",
      events: [],
    });
    const events = await client.priceAlerts.signals.events({});
    expect(events.events).toHaveLength(2);
    expect(await client.priceAlerts.signals.events({ since: NOW })).toEqual({
      events: [],
    });
  });

  it("reports unparseable watch requests and accepts structured agent proposals", async () => {
    useFakes();
    const client = clientFor({
      apiKey: PLAINTEXT,
      rules: memoryRules().repository,
    });
    expect(
      await client.priceAlerts.signals.propose({ text: "watch NQ please" })
    ).toMatchObject({ ok: false });
    const structured = await client.priceAlerts.signals.propose({
      condition,
      frequency: "once",
      name: "SPY reclaim",
      symbol: "SPY",
      timeframe: "15m",
    });
    expect(structured).toMatchObject({
      ok: true,
      rule: { name: "SPY reclaim", status: "proposed" },
    });
  });

  it("dismisses proposals and stops active rules; once rules finish after one fire", async () => {
    useFakes();
    const { repository, rows } = memoryRules([
      record({ frequency: "once", id: "rule-1" }),
      record({ id: "rule-2", kind: "watch", status: "proposed" }),
    ]);
    const client = clientFor({ rules: repository });
    const dismissed = await client.priceAlerts.signals.dismiss({
      id: "rule-2",
    });
    expect(dismissed.rule.status).toBe("dismissed");
    const checked = await client.priceAlerts.signals.check({});
    expect(checked).toMatchObject({ delivery: "not-configured" });
    expect(checked.events).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fireCount: 1, status: "done" });
    await expectCode(
      client.priceAlerts.signals.dismiss({ id: "rule-1" }),
      "NOT_FOUND",
      404
    );
  });

  it("skips rules whose series failed and moves them to the back of the queue", async () => {
    useFakes();
    const { repository } = memoryRules([record({ symbol: "ZZZZ" })]);
    const client = clientFor({ rules: repository });
    const checked = await client.priceAlerts.signals.check({});
    expect(checked).toMatchObject({ checked: 0, events: [] });
    expect(checked.seriesErrors).toEqual([
      expect.objectContaining({ symbol: "ZZZZ", timeframe: "15m" }),
    ]);
    expect(repository.markAttempted).toHaveBeenCalledWith(["rule-1"]);
  });

  it("tick needs a write key and runs every operator owner's active rules", async () => {
    useFakes();
    const { repository } = memoryRules([
      record(),
      record({ id: "rule-9", userId: "stranger" }),
    ]);
    await expectCode(
      clientFor({ rules: repository }).priceAlerts.signals.tick({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({
        apiKey: PLAINTEXT,
        keyAccess: "read",
        rules: repository,
      }).priceAlerts.signals.tick({}),
      "FORBIDDEN",
      403
    );
    const result = await clientFor({
      apiKey: PLAINTEXT,
      ntfy: NTFY,
      rules: repository,
    }).priceAlerts.signals.tick({});
    expect(result).toEqual({
      checked: 1,
      deliveries: { failed: 0, notConfigured: 0, sent: 1 },
      fired: 1,
      seriesErrors: [],
    });
  });

  it("write keys may propose but never create active alerts or start watches", async () => {
    useFakes();
    const { repository, rows } = memoryRules([
      record({ id: "rule-1", kind: "watch", status: "proposed" }),
    ]);
    const client = clientFor({ apiKey: PLAINTEXT, rules: repository });
    await expectCode(
      client.priceAlerts.signals.start({ id: "rule-1" }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      client.priceAlerts.signals.create({
        condition,
        frequency: "once",
        symbol: "SPY",
        timeframe: "15m",
      }),
      "FORBIDDEN",
      403
    );
    expect(rows.map((row) => row.status)).toEqual(["proposed"]);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("read keys may list and backfill but not create", async () => {
    useFakes();
    const client = clientFor({
      apiKey: PLAINTEXT,
      keyAccess: "read",
      rules: memoryRules().repository,
    });
    await expect(client.priceAlerts.signals.list({})).resolves.toMatchObject({
      rules: [],
    });
    await expectCode(
      client.priceAlerts.signals.create({
        condition,
        frequency: "once",
        symbol: "SPY",
        timeframe: "15m",
      }),
      "FORBIDDEN",
      403
    );
  });

  it("lists notifications as configured and skips unreadable stored conditions", async () => {
    useFakes();
    const { repository } = memoryRules([
      record({ condition: { operator: "sideways" } }),
    ]);
    const client = clientFor({ ntfy: NTFY, rules: repository });
    const listed = await client.priceAlerts.signals.list({});
    expect(listed.notifications).toBe("configured");
    expect(listed.rules[0]?.description).toBe("Unreadable condition (skipped)");
    expect(await client.priceAlerts.signals.check({})).toMatchObject({
      checked: 0,
      events: [],
    });
    expect(repository.markAttempted).toHaveBeenCalledWith(["rule-1"]);
  });

  it("formats large prices with two decimals and skips bars another run recorded", async () => {
    useFakes();
    const { events, repository } = memoryRules([
      record({
        condition: { ...condition, right: { type: "value", value: "1000" } },
        symbol: "BIG",
        frequency: "per-bar",
      }),
    ]);
    events.push({
      barAt: new Date(START + 45 * MINUTE),
      delivery: "sent",
      firedAt: CREATED,
      id: "event-0",
      kind: "alert",
      name: "BIG",
      price: "1100",
      ruleId: "rule-1",
      symbol: "BIG",
      userId: "owner",
    });
    const checked = await clientFor({
      rules: repository,
    }).priceAlerts.signals.check({});
    expect(checked.events.map((event) => event.price)).toEqual(["1100"]);
    expect(checked.events[0]?.barAt).toEqual(new Date(START + 75 * MINUTE));
  });

  it("defers rules beyond the per-run series budget", async () => {
    useFakes();
    const rules = Array.from({ length: 21 }, (_, index) =>
      record({ id: `rule-${index}`, symbol: `S${index}` })
    );
    const { repository } = memoryRules(rules);
    const checked = await clientFor({
      rules: repository,
    }).priceAlerts.signals.check({});
    expect(checked.checked).toBe(20);
    expect(repository.markAttempted).toHaveBeenCalledWith(["rule-20"]);
  });

  it("keeps a proposal when its backfill fails and surfaces storage errors", async () => {
    useFakes();
    const { repository } = memoryRules();
    const client = clientFor({ rules: repository });
    expect(
      await client.priceAlerts.signals.propose({
        condition,
        frequency: "once",
        symbol: "ZZZZ",
        timeframe: "15m",
      })
    ).toMatchObject({ backfill: null, ok: true });
    vi.mocked(repository.create).mockRejectedValueOnce(new Error("db down"));
    await expectCode(
      client.priceAlerts.signals.create({
        condition,
        frequency: "once",
        symbol: "SPY",
        timeframe: "15m",
      }),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("uses the real clock and global fetch by default; tick reports unconfigured pushes", async () => {
    setSignalAlertsOptionsForTesting({});
    vi.stubGlobal("fetch", yahoo);
    try {
      const { repository } = memoryRules([record()]);
      const result = await clientFor({
        apiKey: PLAINTEXT,
        rules: repository,
      }).priceAlerts.signals.tick({});
      // Days later every bar is stale: the cursor moves, nothing fires.
      expect(result).toMatchObject({
        checked: 1,
        deliveries: { notConfigured: 0, sent: 0 },
        fired: 0,
      });
      expect(repository.markChecked).toHaveBeenCalledWith(
        "rule-1",
        new Date(START + 75 * MINUTE),
        expect.any(Date)
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires a session and storage", async () => {
    await expectCode(
      clientFor({
        rules: memoryRules().repository,
        session: null,
      }).priceAlerts.signals.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({}).priceAlerts.signals.list({}),
      "STORAGE_ERROR",
      503
    );
  });
});
