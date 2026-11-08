import type { SafeAuthSession } from "@darkfactory/auth/server";
import type { FlowRepository, Repositories } from "@darkfactory/db/server";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiContext } from "./context.ts";
import {
  flowRouter,
  readFlowSnapshot,
  setFlowClockForTesting,
} from "./flow.ts";
import { setOptionsAnalyticsForTesting } from "./options-analytics.ts";

// Monday 2026-11-09 10:00 New York: every flow source's market is open.
const OPEN = new Date("2026-11-09T15:00:00.000Z");
const OPERATOR_EMAIL = "operator@domain.test";

const operatorSession: SafeAuthSession = {
  principal: { role: "member", status: "active", userId: "operator" },
  session: {
    createdAt: OPEN,
    expiresAt: new Date("2026-11-10T15:00:00.000Z"),
    id: "session-operator",
    ipAddress: null,
    updatedAt: OPEN,
    userAgent: null,
    userId: "operator",
  },
  user: {
    createdAt: OPEN,
    email: OPERATOR_EMAIL,
    emailVerified: true,
    id: "operator",
    image: null,
    name: "operator",
    role: "member",
    status: "active",
    updatedAt: OPEN,
  },
};

const agentKeys = {
  authenticate: vi.fn(async () => ({
    access: "write",
    apiKeyId: "key-1",
    email: OPERATOR_EMAIL,
    emailVerified: true,
    role: "member" as const,
    status: "active" as const,
    userId: "operator",
  })),
} as unknown as NonNullable<ApiContext["agentApiKeys"]>;

const emptyWindow = {
  books: [],
  events: [],
  gex: null,
  minutes: [],
  prints: [],
};

const fakeRepository = (overrides: Partial<FlowRepository> = {}) =>
  ({
    insertBooks: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertEvents: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertGex: vi.fn(async (rows: readonly unknown[]) => rows.length),
    insertOptionPrints: vi.fn(async (rows: readonly unknown[]) => rows.length),
    latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
    newestDataAt: vi.fn(async () => null),
    newestOptionPrintAt: vi.fn(async () => null),
    prune: vi.fn(async () => 0),
    readWindow: vi.fn(async () => emptyWindow),
    recordSample: vi.fn(async () => undefined),
    upsertMinutes: vi.fn(async (rows: readonly unknown[]) => rows.length),
    ...overrides,
  }) satisfies FlowRepository;

const clientFor = (
  flow: FlowRepository | undefined,
  overrides: Partial<ApiContext> = {}
) => {
  const repositories = {
    ...(flow === undefined ? {} : { flow }),
  } as Repositories;
  const context: ApiContext = {
    agentApiKeyPresented: true,
    agentApiKeys: agentKeys,
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    operatorEmails: [OPERATOR_EMAIL],
    repositories,
    requestId: "request-flow",
    requireRole: vi.fn(async () => operatorSession),
    requireSession: vi.fn(async () => operatorSession),
    ...overrides,
  };
  return createRouterClient(flowRouter, { context });
};

const expectCode = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

afterEach(() => {
  setFlowClockForTesting();
  vi.unstubAllGlobals();
  setOptionsAnalyticsForTesting({});
});

describe("flow.collect", () => {
  it("needs an agent API key", async () => {
    const repository = fakeRepository();
    const client = clientFor(repository, { agentApiKeyPresented: false });
    await expectCode(client.collect({}), "FORBIDDEN");
    expect(repository.latestSamples).not.toHaveBeenCalled();
  });

  it("fails with STORAGE_ERROR without a flow repository", async () => {
    await expectCode(clientFor(undefined).collect({}), "STORAGE_ERROR");
    await expectCode(
      clientFor(undefined).snapshot({ symbol: "SPY" }),
      "STORAGE_ERROR"
    );
  });

  it("runs without market history or QuantData", async () => {
    setFlowClockForTesting(() => OPEN);
    const output = await clientFor(fakeRepository(), {
      marketHistory: null,
      quantData: null,
    }).collect({ dryRun: true });
    expect(output.at).toBe(OPEN.toISOString());
    const statuses = Object.fromEntries(
      output.runs.map((run) => [`${run.symbol}:${run.source}`, run])
    );
    expect(statuses["SPY:depth"]?.status).toBe("unavailable");
    expect(statuses["SPY:ticks"]?.message).toBe(
      "IBKR pacing unknown (history health failed)"
    );
    expect(statuses["SPY:options"]?.message).toBe("QuantData not configured");
    expect(statuses["SPY:gex"]?.message).toBe("QuantData not configured");
  });

  it("wires history and QuantData into the collector", async () => {
    setFlowClockForTesting(() => OPEN);
    const urls: string[] = [];
    // flow.collect passes no fetch options, so the history calls use the global fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/health"))
          return Response.json({
            pacing: { backoff_seconds: 0, recent_requests: 0 },
          });
        return Response.json({ error: "down" }, { status: 502 });
      })
    );
    const quantDataFetch = vi.fn(async () =>
      Response.json({ error: "down" }, { status: 500 })
    );
    setOptionsAnalyticsForTesting(
      { fetch: quantDataFetch, minIntervalMs: 0, sleep: async () => undefined },
      () => OPEN
    );
    const output = await clientFor(fakeRepository(), {
      marketHistory: {
        token: "h".repeat(43),
        url: "https://history.test/vertex-history/v1",
      },
      quantData: { apiKey: "q".repeat(32), baseUrl: "https://qd.test" },
    }).collect({ dryRun: true, symbols: ["ES"] });
    const bySource = Object.fromEntries(
      output.runs.map((run) => [run.source, run.status])
    );
    // Ticks went past pacing to the ticks endpoint; options and GEX reached QuantData.
    expect(bySource["ticks"]).toBe("unavailable");
    expect(bySource["depth"]).toBe("unavailable");
    expect(bySource["options"]).not.toBe("skipped");
    expect(bySource["gex"]).not.toBe("skipped");
    expect(urls.some((url) => url.includes("/ticks"))).toBe(true);
    expect(urls.some((url) => url.includes("/depth"))).toBe(true);
    expect(quantDataFetch).toHaveBeenCalled();
  });
});

describe("flow.snapshot", () => {
  it("returns one symbol's window", async () => {
    setFlowClockForTesting(() => OPEN);
    const repository = fakeRepository();
    const output = await clientFor(repository).snapshot({ symbol: "ES" });
    expect(output.symbol).toBe("ES");
    expect(repository.readWindow).toHaveBeenCalledWith({
      from: new Date(OPEN.getTime() - 120 * 60_000),
      symbol: "ES",
      to: OPEN,
    });
  });

  it("maps repository failures to STORAGE_ERROR", async () => {
    const repository = fakeRepository({
      readWindow: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expectCode(
      clientFor(repository).snapshot({ symbol: "SPY" }),
      "STORAGE_ERROR"
    );
  });
});

describe("readFlowSnapshot window", () => {
  const windowTo = async (newest: Date | null) => {
    const repository = fakeRepository({
      newestDataAt: vi.fn(async () => newest),
    });
    const output = await readFlowSnapshot(
      repository,
      { minutes: 30, symbol: "SPY" },
      OPEN
    );
    expect(repository.readWindow).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SPY" })
    );
    return output;
  };

  it("ends at now when nothing is stored", async () => {
    const output = await windowTo(null);
    expect([output.windowStart, output.windowEnd]).toEqual([
      new Date(OPEN.getTime() - 30 * 60_000).toISOString(),
      OPEN.toISOString(),
    ]);
  });

  it("ends at the newest stored data", async () => {
    const newest = new Date(OPEN.getTime() - 3_600_000);
    const output = await windowTo(newest);
    expect(output.windowEnd).toBe(newest.toISOString());
  });

  it("ends at now when the newest data is in the future", async () => {
    const output = await windowTo(new Date(OPEN.getTime() + 60_000));
    expect(output.windowEnd).toBe(OPEN.toISOString());
  });
});
