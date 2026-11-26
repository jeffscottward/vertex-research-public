import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
} from "@darkfactory/auth/types";
import type {
  FlowRepository,
  FlowSampleRecord,
  OpenbbFreshnessRepository,
  OpenbbFreshnessState,
  OpenbbRepository,
  OpenbbRun,
  Repositories,
} from "@darkfactory/db/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import { CONNECTIVITY_ALERT_MONITOR } from "./connectivity-health.ts";
import {
  type ConnectivityDeps,
  handleCheckConnectivityAlerts,
  handleConnectivityHealth,
  handleRecordConnectivityAlertChat,
  setConnectivityOptionsForTesting,
} from "./server/connectivity.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const NOW = new Date("2026-11-24T15:30:00.000Z");
const OPERATOR = {
  email: "operator@vertex.test",
  emailVerified: true,
  id: "op-1",
  name: "Operator",
  role: "admin",
  status: "active",
} as const;

const NTFY_CONFIG = {
  origin: "https://ntfy.example.test",
  token: "ntfy-test-token",
  topic: "vertex-alerts",
} as const;

const createMemoryFreshness = (
  initial: OpenbbFreshnessState | null = null
): OpenbbFreshnessRepository & { state: OpenbbFreshnessState | null } => {
  const box = { state: initial };
  return {
    completeFreshnessDelivery: vi.fn(
      async (_monitor, eventId, delivery, now) => {
        if (box.state === null || box.state.pendingEventId !== eventId)
          return false;
        if (delivery === "sent") {
          box.state = {
            ...box.state,
            activeKeys: [...box.state.pendingKeys],
            lastTransitionAt: now,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          };
        } else {
          box.state = {
            ...box.state,
            pendingDelivery: delivery,
            updatedAt: now,
          };
        }
        return true;
      }
    ),
    getFreshnessState: vi.fn(async () => box.state),
    stageFreshnessTransition: vi.fn(async (monitor, decide, now) => {
      const decision = decide(box.state);
      if (decision.kind === "stage-pending") {
        box.state = {
          activeKeys: box.state?.activeKeys ?? [],
          lastTransitionAt: box.state?.lastTransitionAt ?? null,
          monitor,
          pendingDelivery: "pending",
          pendingEventId: decision.eventId,
          pendingKeys: [...decision.pendingKeys],
          pendingKind: decision.pendingKind,
          updatedAt: now,
        };
        return {
          activeKeys: [...box.state.activeKeys],
          eventId: decision.eventId,
          kind: "stage-pending" as const,
          pendingKeys: [...decision.pendingKeys],
          pendingKind: decision.pendingKind,
        };
      }
      if (decision.kind === "prune-active" && box.state !== null) {
        box.state = {
          ...box.state,
          activeKeys: [...decision.activeKeys],
          updatedAt: now,
        };
      }
      if (decision.kind === "clear-pending" && box.state !== null) {
        box.state = {
          ...box.state,
          pendingDelivery: null,
          pendingEventId: null,
          pendingKeys: [],
          pendingKind: null,
          updatedAt: now,
        };
      }
      return {
        activeKeys: [...(box.state?.activeKeys ?? [])],
        kind: decision.kind,
      };
    }),
    get state() {
      return box.state;
    },
    set state(next: OpenbbFreshnessState | null) {
      box.state = next;
    },
  };
};
const makeSample = (
  overrides: Partial<FlowSampleRecord> = {}
): FlowSampleRecord => ({
  at: NOW,
  items: 0,
  message:
    "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
  source: "options",
  status: "unavailable",
  symbol: "SPY",
  ...overrides,
});

const makeRun = (overrides: Partial<OpenbbRun> = {}): OpenbbRun => ({
  error: null,
  finishedAt: NOW,
  id: "run-1",
  job: "daily-prices",
  openbbVersion: "4.0.0",
  rowsReceived: 30,
  rowsWritten: 30,
  startedAt: NOW,
  status: "ok",
  warnings: [],
  ...overrides,
});

const makeDeps = (
  overrides: Partial<ConnectivityDeps> = {}
): ConnectivityDeps => ({
  clock: () => NOW,
  config: {
    deployStatus: true,
    engineStatus: true,
    ibkrMonitor: true,
    ibkrRecovery: true,
    marketHistory: true,
    portfolioMonitor: true,
    priceAlertsNtfy: true,
    quantData: true,
    researchLenses: true,
  },
  failures: {
    FORBIDDEN: (opts) => new Error(`FORBIDDEN:${opts?.message ?? ""}`),
    STORAGE_ERROR: (opts) => new Error(`STORAGE_ERROR:${opts?.message ?? ""}`),
  },
  flow: {
    recentSamples: vi.fn(async () => []),
  } as unknown as FlowRepository,
  freshness: createMemoryFreshness(),
  ntfy: null,
  openbb: {
    latestRuns: vi.fn(async () => []),
  } as unknown as OpenbbRepository,
  ...overrides,
});

afterEach(() => {
  setConnectivityOptionsForTesting();
});

describe("connectivity handlers", () => {
  it("reads health cleanly even when repositories are undefined or return samples/runs", async () => {
    const empty = await handleConnectivityHealth(
      makeDeps({ flow: undefined, freshness: undefined, openbb: undefined })
    );
    expect(empty.overallStatus).toBe("healthy");
    expect(empty.activeAlertKeys).toEqual([]);

    const auth = await handleConnectivityHealth(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        openbb: {
          latestRuns: vi.fn(async () => [makeRun()]),
        } as unknown as OpenbbRepository,
      })
    );
    expect(auth.overallStatus).toBe("auth_failed");
    expect(auth.issues).toHaveLength(1);
    expect(auth.issues[0]?.escalation).toBe("needs_you_credential_rotation");
  });

  it("wraps repository read failures in STORAGE_ERROR", async () => {
    await expect(
      handleConnectivityHealth(
        makeDeps({
          flow: {
            recentSamples: vi.fn(async () => {
              throw new Error("db down");
            }),
          } as unknown as FlowRepository,
        })
      )
    ).rejects.toThrow("STORAGE_ERROR:connectivity.health: db down");

    await expect(
      handleConnectivityHealth(
        makeDeps({
          flow: {
            recentSamples: vi.fn(async () => {
              throw "raw-error";
            }),
          } as unknown as FlowRepository,
        })
      )
    ).rejects.toThrow("STORAGE_ERROR:connectivity.health: raw-error");
  });

  it("checkAlerts dryRun plans alerts without mutating state and handles storage errors", async () => {
    const freshness = createMemoryFreshness();
    const dry = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        freshness,
      }),
      { dryRun: true }
    );
    expect(dry.action).toBe("alert");
    expect(dry.delivery).toBe("dry-run");
    expect(dry.needsOwnerAsk).toBe(true);
    expect(dry.pendingChat).toBeNull();
    expect(freshness.stageFreshnessTransition).not.toHaveBeenCalled();

    const dryHealthy = await handleCheckConnectivityAlerts(
      makeDeps({ flow: undefined, freshness, openbb: undefined }),
      { dryRun: true }
    );
    expect(dryHealthy.action).toBe("noop");
    expect(dryHealthy.delivery).toBeNull();

    await expect(
      handleCheckConnectivityAlerts(makeDeps({ freshness: undefined }), {})
    ).rejects.toThrow("STORAGE_ERROR");

    await expect(
      handleCheckConnectivityAlerts(
        makeDeps({
          flow: {
            recentSamples: vi.fn(async () => {
              throw new Error("flow read failed");
            }),
          } as unknown as FlowRepository,
        }),
        {}
      )
    ).rejects.toThrow(
      "STORAGE_ERROR:connectivity.checkAlerts: flow read failed"
    );

    await expect(
      handleCheckConnectivityAlerts(
        makeDeps({
          freshness: {
            ...freshness,
            getFreshnessState: vi.fn(async () => {
              throw new Error("state read failed");
            }),
          },
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(
      "STORAGE_ERROR:connectivity.checkAlerts: state read failed"
    );
  });

  it("delivers via ntfy when configured, falls back to pendingChat when not configured or ntfy throws, and supports chat ack", async () => {
    const freshness = createMemoryFreshness();
    const sent = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        freshness,
        notify: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                event: "message",
                id: "ntfy-1",
                topic: NTFY_CONFIG.topic,
              }),
              {
                headers: { "content-type": "application/json" },
                status: 200,
              }
            )
        ),
        ntfy: NTFY_CONFIG,
      }),
      {}
    );
    expect(sent.action).toBe("alert");
    expect(sent.delivery).toBe("sent");
    expect(sent.needsOwnerAsk).toBe(true);
    expect(sent.pendingChat).toBeNull();
    expect(sent.activeAlertKeys).toEqual(["flow:SPY:options:auth_failed"]);

    // Second run with same active key -> noop
    const second = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        freshness,
        ntfy: NTFY_CONFIG,
      }),
      {}
    );
    expect(second.action).toBe("noop");
    expect(second.delivery).toBeNull();

    // Recovery with ntfy throwing -> returns pendingChat and commits on recordAlertChat
    const recovered = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [
            makeSample({ message: "ok", status: "ok" }),
          ]),
        } as unknown as FlowRepository,
        freshness,
        notify: vi.fn(async () => {
          throw new Error("ntfy down");
        }),
        ntfy: NTFY_CONFIG,
      }),
      {}
    );
    expect(recovered.action).toBe("recovery");
    expect(recovered.delivery).toBe("failed");
    expect(recovered.pendingChat).not.toBeNull();

    const ack = await handleRecordConnectivityAlertChat(
      {
        clock: () => NOW,
        failures: makeDeps().failures,
        freshness,
      },
      { delivery: "sent", eventId: recovered.pendingChat?.eventId ?? "" }
    );
    expect(ack.committed).toBe(true);
    expect(freshness.state?.activeKeys).toEqual([]);
  });

  it("handles prune-active, clear-pending, stage errors, complete errors, and uncommitted completion", async () => {
    const freshness = createMemoryFreshness({
      activeKeys: [
        "flow:SPY:options:auth_failed",
        "flow:ES:ticks:upstream_5xx",
      ],
      lastTransitionAt: NOW,
      monitor: CONNECTIVITY_ALERT_MONITOR,
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: NOW,
    });

    const pruned = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        freshness,
      }),
      {}
    );
    expect(pruned.action).toBe("prune-active");
    expect(pruned.activeAlertKeys).toEqual(["flow:SPY:options:auth_failed"]);

    // Uncommitted completion -> returns pendingChat: null
    const uncommitted = await handleCheckConnectivityAlerts(
      makeDeps({
        flow: {
          recentSamples: vi.fn(async () => [makeSample()]),
        } as unknown as FlowRepository,
        freshness: {
          ...createMemoryFreshness(),
          completeFreshnessDelivery: vi.fn(async () => false),
          getFreshnessState: vi.fn(async () => null),
        },
      }),
      {}
    );
    expect(uncommitted.delivery).toBe("not-configured");
    expect(uncommitted.pendingChat).toBeNull();

    // Stage error and complete error wrap in STORAGE_ERROR
    await expect(
      handleCheckConnectivityAlerts(
        makeDeps({
          freshness: {
            ...createMemoryFreshness(),
            stageFreshnessTransition: vi.fn(async () => {
              throw new Error("stage boom");
            }),
          },
        }),
        {}
      )
    ).rejects.toThrow("STORAGE_ERROR:connectivity.checkAlerts: stage boom");

    await expect(
      handleCheckConnectivityAlerts(
        makeDeps({
          flow: {
            recentSamples: vi.fn(async () => [makeSample()]),
          } as unknown as FlowRepository,
          freshness: {
            ...createMemoryFreshness(),
            completeFreshnessDelivery: vi.fn(async () => {
              throw new Error("commit boom");
            }),
          },
        }),
        {}
      )
    ).rejects.toThrow("STORAGE_ERROR:connectivity.checkAlerts: commit boom");

    // Stage returning noop without calling callback falls back cleanly
    const skippedCallback = await handleCheckConnectivityAlerts(
      makeDeps({
        freshness: {
          ...createMemoryFreshness(),
          stageFreshnessTransition: vi.fn(async () => ({
            activeKeys: [],
            kind: "noop" as const,
          })),
        },
      }),
      {}
    );
    expect(skippedCallback.action).toBe("noop");

    // recordAlertChat errors
    await expect(
      handleRecordConnectivityAlertChat(
        {
          clock: () => NOW,
          failures: makeDeps().failures,
          freshness: undefined,
        },
        { delivery: "sent", eventId: "evt-1" }
      )
    ).rejects.toThrow("STORAGE_ERROR");

    await expect(
      handleRecordConnectivityAlertChat(
        {
          clock: () => NOW,
          failures: makeDeps().failures,
          freshness: {
            ...createMemoryFreshness(),
            completeFreshnessDelivery: vi.fn(async () => {
              throw new Error("ack boom");
            }),
          },
        },
        { delivery: "failed", eventId: "evt-1" }
      )
    ).rejects.toThrow("STORAGE_ERROR:connectivity.recordAlertChat: ack boom");
  });
});

describe("connectivity oRPC router", () => {
  const clientFor = (options: {
    apiKey?: "read" | "write" | null;
    freshness?: OpenbbFreshnessRepository;
    samples?: FlowSampleRecord[];
  }) => {
    const freshness = options.freshness ?? createMemoryFreshness();
    const apiKey = options.apiKey ?? null;
    const repositories: Repositories = {
      addresses: {} as Repositories["addresses"],
      adminUsers: {} as Repositories["adminUsers"],
      dashboard: {} as Repositories["dashboard"],
      featureItems: {} as Repositories["featureItems"],
      flow: {
        recentSamples: vi.fn(async () => options.samples ?? []),
      } as unknown as FlowRepository,
      openbb: {
        latestRuns: vi.fn(async () => []),
      } as unknown as OpenbbRepository,
      openbbFreshness: freshness,
      profiles: {} as Repositories["profiles"],
      userPreferences: {} as Repositories["userPreferences"],
    };
    const agentApiKeys = {
      authenticate: async () => ({
        access: apiKey ?? "write",
        apiKeyId: "key-1",
        email: OPERATOR.email,
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: OPERATOR.id,
      }),
    };
    return createApiClient({
      baseUrl: "https://vertex.test",
      fetch: async (request) => {
        if (apiKey !== null) request.headers.set("x-api-key", "vtx_test_key");
        const context = createApiContext(request, {
          agentApiKeys: agentApiKeys as never,
          capabilities: {
            ai: false,
            analytics: false,
            emailDelivery: false,
            telemetryExport: false,
          },
          deployStatus: { token: "t".repeat(32), url: "https://status.test" },
          deployStatusV2: null,
          engineStatus: "http://127.0.0.1:3462",
          ibkrMonitor: "http://127.0.0.1:3461",
          ibkrRecovery: {
            token: "r".repeat(32),
            url: "https://recovery.test",
          },
          marketHistory: {
            token: "t".repeat(32),
            url: "https://history.test",
          },
          operatorEmails: [OPERATOR.email],
          portfolioMonitor: {
            token: "t".repeat(32),
            url: "https://portfolio.test",
          },
          priceAlertsNtfy: NTFY_CONFIG,
          quantData: { apiKey: "qd-key", baseUrl: "https://api.quantdata.us" },
          repositories,
          requestId: "req-conn-1",
          requireRole: async () => {
            throw new AuthAuthorizationError(
              AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
              401
            );
          },
          requireSession: async () => ({
            principal: {
              role: "admin",
              status: "active",
              userId: OPERATOR.id,
            },
            session: {
              createdAt: NOW,
              expiresAt: new Date("2027-01-01T00:00:00.000Z"),
              id: "sess-1",
              ipAddress: null,
              updatedAt: NOW,
              userAgent: null,
              userId: OPERATOR.id,
            },
            user: {
              createdAt: NOW,
              email: OPERATOR.email,
              emailVerified: true,
              id: OPERATOR.id,
              image: null,
              name: OPERATOR.name,
              role: "admin",
              status: "active",
              updatedAt: NOW,
            },
          }),
          researchLenses: {
            token: "t".repeat(32),
            url: "https://lenses.test",
          },
        });
        return await handleApiRequest(request, context);
      },
    });
  };

  it("serves connectivity.health to operator sessions and read API keys, and requires write API key for alert mutations", async () => {
    setConnectivityOptionsForTesting({
      clock: () => NOW,
      notify: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              event: "message",
              id: "ntfy-2",
              topic: NTFY_CONFIG.topic,
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            }
          )
      ),
    });
    const sessionClient = clientFor({ samples: [makeSample()] });
    const health = await sessionClient.connectivity.health({});
    expect(health.overallStatus).toBe("auth_failed");
    expect(health.providers.find((p) => p.id === "quantdata")?.configured).toBe(
      true
    );

    // Session without x-api-key cannot call checkAlerts or recordAlertChat
    await expect(
      sessionClient.connectivity.checkAlerts({})
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      sessionClient.connectivity.recordAlertChat({
        delivery: "sent",
        eventId: "conn-1",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Read API key can read health, cannot call checkAlerts
    const readClient = clientFor({ apiKey: "read" });
    expect((await readClient.connectivity.health({})).overallStatus).toBe(
      "healthy"
    );
    await expect(readClient.connectivity.checkAlerts({})).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );

    // Write API key runs checkAlerts and recordAlertChat
    const freshness = createMemoryFreshness();
    setConnectivityOptionsForTesting({
      clock: () => NOW,
      notify: vi.fn(async () => new Response("err", { status: 500 })),
    });
    const writeClient = clientFor({
      apiKey: "write",
      freshness,
      samples: [makeSample()],
    });
    const checked = await writeClient.connectivity.checkAlerts({});
    expect(checked.action).toBe("alert");
    expect(checked.needsOwnerAsk).toBe(true);
    expect(checked.pendingChat).not.toBeNull();

    const ack = await writeClient.connectivity.recordAlertChat({
      delivery: "sent",
      eventId: checked.pendingChat?.eventId ?? "conn-missing",
    });
    expect(ack.committed).toBe(true);
  });

  it("uses system clock and reports unconfigured services cleanly when optional configs are absent", async () => {
    setConnectivityOptionsForTesting();
    const repositories: Repositories = {
      addresses: {} as Repositories["addresses"],
      adminUsers: {} as Repositories["adminUsers"],
      dashboard: {} as Repositories["dashboard"],
      featureItems: {} as Repositories["featureItems"],
      flow: {
        recentSamples: vi.fn(async () => []),
      } as unknown as FlowRepository,
      openbb: {
        latestRuns: vi.fn(async () => []),
      } as unknown as OpenbbRepository,
      openbbFreshness: createMemoryFreshness(),
      profiles: {} as Repositories["profiles"],
      userPreferences: {} as Repositories["userPreferences"],
    };
    const client = createApiClient({
      baseUrl: "https://vertex.test",
      fetch: async (request) => {
        const context = createApiContext(request, {
          capabilities: {
            ai: false,
            analytics: false,
            emailDelivery: false,
            telemetryExport: false,
          },
          operatorEmails: [OPERATOR.email],
          repositories,
          requestId: "req-conn-empty",
          requireRole: async () => {
            throw new AuthAuthorizationError(
              AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
              401
            );
          },
          requireSession: async () => ({
            principal: { role: "admin", status: "active", userId: OPERATOR.id },
            session: {
              createdAt: NOW,
              expiresAt: new Date("2027-01-01T00:00:00.000Z"),
              id: "sess-empty",
              ipAddress: null,
              updatedAt: NOW,
              userAgent: null,
              userId: OPERATOR.id,
            },
            user: {
              createdAt: NOW,
              email: OPERATOR.email,
              emailVerified: true,
              id: OPERATOR.id,
              image: null,
              name: OPERATOR.name,
              role: "admin",
              status: "active",
              updatedAt: NOW,
            },
          }),
        });
        return await handleApiRequest(request, context);
      },
    });
    const health = await client.connectivity.health({});
    expect(health.overallStatus).toBe("healthy");
    expect(health.ntfyConfigured).toBe(false);
    expect(health.providers.find((p) => p.id === "quantdata")?.status).toBe(
      "not_configured"
    );
    expect(health.providers.find((p) => p.id === "deploy-status")?.status).toBe(
      "not_configured"
    );
  });
});
