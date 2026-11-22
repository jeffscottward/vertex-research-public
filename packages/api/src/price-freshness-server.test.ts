import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
} from "@darkfactory/auth/types";
import type {
  MarketBarsRepository,
  MarketDailySeriesRepository,
  OpenbbFreshnessRepository,
  OpenbbFreshnessState,
  Repositories,
} from "@darkfactory/db/server";
import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "./client.ts";
import { OPENBB_DAILY_BAR_SYMBOLS } from "./contracts/openbb.ts";
import {
  OpenbbCheckPriceFreshnessInputSchema,
  OpenbbCheckPriceFreshnessOutputSchema,
  OpenbbPriceFreshnessInputSchema,
  OpenbbPriceFreshnessOutputSchema,
  OpenbbRecordPriceFreshnessChatInputSchema,
  OpenbbRecordPriceFreshnessChatOutputSchema,
  openbbPriceFreshnessContract,
} from "./contracts/price-freshness.ts";
import { OPENBB_ALL_DAILY_SERIES_IDS } from "./price-freshness.ts";
import { type ApiContext, createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import {
  type FreshnessDeps,
  handleCheckPriceFreshness,
  handlePriceFreshness,
  handleRecordPriceFreshnessChat,
  requireFreshnessWriteKey,
  setOpenbbPriceFreshnessOptionsForTesting,
} from "./server/price-freshness.ts";

// Tuesday 2026-11-24 06:15 EST -> expectedSession = Monday 2026-11-23
const NOW = new Date("2026-11-24T11:15:00Z");
const FRESH_DATE = "2026-11-23";
const STALE_DATE = "2026-11-18"; // 3 NYSE sessions behind 2026-11-23 (19, 20, 23)

const storageError = (options?: { message?: string }) =>
  new Error(options?.message ?? "storage error");

const makeStore = (initial: OpenbbFreshnessState | null = null) => {
  let state = initial;
  let stageCalls = 0;
  let completeCalls = 0;
  const store: OpenbbFreshnessRepository = {
    completeFreshnessDelivery: async (_monitor, eventId, delivery, now) => {
      completeCalls += 1;
      if (state === null || state.pendingEventId !== eventId) return false;
      if (delivery === "sent") {
        state = {
          ...state,
          activeKeys: [...state.pendingKeys],
          lastTransitionAt: now,
          pendingDelivery: null,
          pendingEventId: null,
          pendingKeys: [],
          pendingKind: null,
          updatedAt: now,
        };
        return true;
      }
      state = { ...state, pendingDelivery: delivery, updatedAt: now };
      return true;
    },
    getFreshnessState: async () => state,
    stageFreshnessTransition: async (monitor, decide, now) => {
      stageCalls += 1;
      const decision = decide(state);
      const currentActive = state === null ? [] : [...state.activeKeys];
      if (decision.kind === "noop" || decision.kind === "in-flight")
        return { activeKeys: currentActive, kind: decision.kind };
      if (decision.kind === "prune-active") {
        state = {
          activeKeys: [...decision.activeKeys],
          lastTransitionAt: now,
          monitor,
          pendingDelivery: null,
          pendingEventId: null,
          pendingKeys: [],
          pendingKind: null,
          updatedAt: now,
        };
        return { activeKeys: [...decision.activeKeys], kind: "prune-active" };
      }
      if (decision.kind === "clear-pending") {
        state = {
          activeKeys: currentActive,
          lastTransitionAt: state?.lastTransitionAt ?? null,
          monitor,
          pendingDelivery: null,
          pendingEventId: null,
          pendingKeys: [],
          pendingKind: null,
          updatedAt: now,
        };
        return { activeKeys: currentActive, kind: "clear-pending" };
      }
      state = {
        activeKeys: currentActive,
        lastTransitionAt: state?.lastTransitionAt ?? null,
        monitor,
        pendingDelivery: "pending",
        pendingEventId: decision.eventId,
        pendingKeys: [...decision.pendingKeys],
        pendingKind: decision.pendingKind,
        updatedAt: now,
      };
      return {
        activeKeys: currentActive,
        eventId: decision.eventId,
        kind: "stage-pending",
        pendingKeys: [...decision.pendingKeys],
        pendingKind: decision.pendingKind,
      };
    },
  };
  return {
    completeCalls: () => completeCalls,
    stageCalls: () => stageCalls,
    state: () => state,
    store,
  };
};

const makeDeps = (
  options: {
    barDateOverrides?: Record<string, string>;
    freshness?: OpenbbFreshnessRepository;
    ntfy?: ApiContext["priceAlertsNtfy"];
    notifyFetch?: FreshnessDeps["notifyFetch"];
    sendNtfy?: FreshnessDeps["sendNtfy"];
    seriesDateOverrides?: Record<string, string>;
  } = {}
): FreshnessDeps => {
  const s = options.freshness ?? makeStore().store;
  const series = {
    latestPoints: async () =>
      OPENBB_ALL_DAILY_SERIES_IDS.map((id) => ({
        adjClose: null,
        close: 100,
        id,
        lastDate: options.seriesDateOverrides?.[id] ?? FRESH_DATE,
      })),
  } as unknown as MarketDailySeriesRepository;
  const bars = {
    latestBars: async () => [
      ...OPENBB_DAILY_BAR_SYMBOLS.map((symbol) => ({
        close: 100,
        lastT: Date.parse(
          `${options.barDateOverrides?.[symbol] ?? FRESH_DATE}T00:00:00Z`
        ),
        symbol,
      })),
      // Extra unmonitored bar symbol should be filtered out cleanly.
      {
        close: 50,
        lastT: Date.parse("2020-01-02T00:00:00Z"),
        symbol: "UNMONITORED",
      },
    ],
  } as unknown as MarketBarsRepository;
  return {
    bars,
    clock: () => NOW,
    context: {
      priceAlertsNtfy: options.ntfy ?? null,
    } as ApiContext,
    failures: { STORAGE_ERROR: storageError },
    freshness: s,
    notifyFetch: options.notifyFetch,
    sendNtfy: options.sendNtfy,
    series,
  };
};

describe("server/price-freshness handlers", () => {
  it("handlePriceFreshness reports all 45 series, ntfyConfigured, and active/pending state", async () => {
    const mem = makeStore({
      activeKeys: ["daily_series:SPY"],
      lastTransitionAt: NOW,
      monitor: "price-freshness",
      pendingDelivery: "not-configured",
      pendingEventId: "evt-1",
      pendingKeys: ["daily_series:SPY"],
      pendingKind: "alert",
      updatedAt: NOW,
    });
    const out = await handlePriceFreshness(
      makeDeps({
        freshness: mem.store,
        seriesDateOverrides: { SPY: STALE_DATE },
      })
    );
    expect(out.dailySeriesCount).toBe(31);
    expect(out.dailyBarsCount).toBe(14);
    expect(out.expectedSession).toBe("2026-11-23");
    expect(out.ntfyConfigured).toBe(false);
    expect(out.activeAlertKeys).toEqual(["daily_series:SPY"]);
    expect(out.pendingDelivery).toBe("not-configured");
    expect(out.pendingKind).toBe("alert");
    expect(out.stale).toHaveLength(1);

    const freshOut = await handlePriceFreshness(
      makeDeps({
        ntfy: { origin: "https://ntfy.test", token: null, topic: "t" },
      })
    );
    expect(freshOut.ntfyConfigured).toBe(true);
    expect(freshOut.activeAlertKeys).toEqual([]);
    expect(freshOut.pendingDelivery).toBeNull();
    expect(freshOut.stale).toEqual([]);
  });

  it("handleCheckPriceFreshness dryRun is strictly read-only with pendingChat null", async () => {
    const mem = makeStore();
    const out = await handleCheckPriceFreshness(
      makeDeps({
        freshness: mem.store,
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      true
    );
    expect(out.dryRun).toBe(true);
    expect(out.action).toBe("alert");
    expect(out.delivery).toBe("dry-run");
    expect(out.pendingChat).toBeNull();
    expect(out.plannedAlert?.kind).toBe("alert");
    expect(mem.stageCalls()).toBe(0);
    expect(mem.completeCalls()).toBe(0);
    // Dry-run with an existing state row preserves activeAlertKeys without writing.
    const memExisting = makeStore({
      activeKeys: ["daily_series:SPY"],
      lastTransitionAt: NOW,
      monitor: "price-freshness",
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: NOW,
    });
    const outExisting = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memExisting.store,
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      true
    );
    expect(outExisting.activeAlertKeys).toEqual(["daily_series:SPY"]);
    expect(outExisting.action).toBe("noop");
  });

  it("handles ntfy sent (commits immediately), ntfy not-configured (returns pendingChat + ack), and ntfy throw", async () => {
    // 1. ntfy configured and returns 200 -> committed immediately, pendingChat null
    const memSent = makeStore();
    const sent = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memSent.store,
        notifyFetch: async () =>
          new Response(
            JSON.stringify({ event: "message", id: "msg-1", topic: "topic" }),
            { headers: { "content-type": "application/json" }, status: 200 }
          ),
        ntfy: { origin: "https://ntfy.test", token: "tok", topic: "topic" },
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      false
    );
    expect(sent.action).toBe("alert");
    expect(sent.delivery).toBe("sent");
    expect(sent.pendingChat).toBeNull();
    expect(sent.activeAlertKeys).toEqual(["daily_series:SPY"]);
    expect(memSent.state()?.pendingEventId).toBeNull();

    // 2. ntfy not-configured -> returns pendingChat; ack commits activeKeys
    const memChat = makeStore();
    const depsChat = makeDeps({
      freshness: memChat.store,
      seriesDateOverrides: { SPY: STALE_DATE },
    });
    const staged = await handleCheckPriceFreshness(depsChat, false);
    expect(staged.delivery).toBe("not-configured");
    expect(staged.pendingChat).not.toBeNull();
    expect(staged.activeAlertKeys).toEqual([]);

    const acked = await handleRecordPriceFreshnessChat(depsChat, {
      delivery: "sent",
      eventId: staged.pendingChat?.eventId ?? "",
    });
    expect(acked.committed).toBe(true);
    expect(memChat.state()?.activeKeys).toEqual(["daily_series:SPY"]);

    // 3. sendNtfy throws -> caught and mapped to "failed", returns pendingChat
    const memThrow = makeStore();
    const thrown = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memThrow.store,
        ntfy: { origin: "https://ntfy.test", token: null, topic: "topic" },
        sendNtfy: async () => {
          throw new Error("unexpected ntfy crash");
        },
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      false
    );
    expect(thrown.delivery).toBe("failed");
    expect(thrown.pendingChat).not.toBeNull();
    // Validate outputs against oRPC contract schemas and test label validation.
    expect(OpenbbPriceFreshnessInputSchema.parse({})).toEqual({});
    expect(
      OpenbbCheckPriceFreshnessInputSchema.parse({ dryRun: true })
    ).toEqual({
      dryRun: true,
    });
    expect(OpenbbCheckPriceFreshnessOutputSchema.parse(sent).delivery).toBe(
      "sent"
    );
    expect(
      OpenbbPriceFreshnessOutputSchema.parse(
        await handlePriceFreshness(makeDeps({ freshness: memSent.store }))
      ).activeAlertKeys
    ).toEqual(["daily_series:SPY"]);
    expect(
      OpenbbRecordPriceFreshnessChatInputSchema.parse({
        delivery: "sent",
        eventId: " evt-1 ",
      }).eventId
    ).toBe("evt-1");
    expect(() =>
      OpenbbRecordPriceFreshnessChatInputSchema.parse({
        delivery: "sent",
        eventId: "bad\nid",
      })
    ).toThrow("line breaks");
    expect(
      OpenbbRecordPriceFreshnessChatOutputSchema.parse(acked).committed
    ).toBe(true);
    expect(Object.keys(openbbPriceFreshnessContract).sort()).toEqual([
      "checkPriceFreshness",
      "priceFreshness",
      "recordPriceFreshnessChat",
    ]);
  });

  it("handles noop, prune-active, clear-pending, in-flight, and superseded Phase 3 eventId", async () => {
    // noop
    const memNoop = makeStore();
    const noop = await handleCheckPriceFreshness(
      makeDeps({ freshness: memNoop.store }),
      false
    );
    expect(noop.action).toBe("noop");
    expect(noop.delivery).toBeNull();
    expect(noop.pendingChat).toBeNull();

    // prune-active
    const memPrune = makeStore({
      activeKeys: ["daily_series:QQQ", "daily_series:SPY"],
      lastTransitionAt: NOW,
      monitor: "price-freshness",
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: NOW,
    });
    const pruned = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memPrune.store,
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      false
    );
    expect(pruned.action).toBe("prune-active");
    expect(pruned.activeAlertKeys).toEqual(["daily_series:SPY"]);

    // clear-pending
    const memClear = makeStore({
      activeKeys: [],
      lastTransitionAt: null,
      monitor: "price-freshness",
      pendingDelivery: "failed",
      pendingEventId: "evt-old",
      pendingKeys: ["daily_series:SPY"],
      pendingKind: "alert",
      updatedAt: new Date(NOW.getTime() - 120_000),
    });
    const cleared = await handleCheckPriceFreshness(
      makeDeps({ freshness: memClear.store }),
      false
    );
    expect(cleared.action).toBe("clear-pending");
    expect(memClear.state()?.pendingEventId).toBeNull();

    // in-flight lease returns action "in-flight" with zero ntfy/DB writes
    const memInFlight = makeStore({
      activeKeys: [],
      lastTransitionAt: null,
      monitor: "price-freshness",
      pendingDelivery: "not-configured",
      pendingEventId: "evt-live",
      pendingKeys: ["daily_series:SPY"],
      pendingKind: "alert",
      updatedAt: new Date(NOW.getTime() - 10_000),
    });
    const inFlight = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memInFlight.store,
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      false
    );
    expect(inFlight.action).toBe("in-flight");
    expect(inFlight.delivery).toBeNull();
    expect(inFlight.pendingChat).toBeNull();
    expect(memInFlight.completeCalls()).toBe(0);

    // end-to-end recovery transition + ntfy sent commits empty activeKeys
    const memRecovery = makeStore({
      activeKeys: ["daily_series:SPY"],
      lastTransitionAt: new Date(NOW.getTime() - 3_600_000),
      monitor: "price-freshness",
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: new Date(NOW.getTime() - 3_600_000),
    });
    const recovered = await handleCheckPriceFreshness(
      makeDeps({
        freshness: memRecovery.store,
        ntfy: { origin: "https://ntfy.test", token: "tok", topic: "topic" },
        sendNtfy: async () => "sent",
      }),
      false
    );
    expect(recovered.action).toBe("recovery");
    expect(recovered.delivery).toBe("sent");
    expect(recovered.activeAlertKeys).toEqual([]);
    expect(recovered.plannedAlert?.kind).toBe("recovery");
    expect(memRecovery.state()?.activeKeys).toEqual([]);

    // handleRecordPriceFreshnessChat records failed chat delivery and reports superseded eventId
    const memFailedChat = makeStore({
      activeKeys: [],
      lastTransitionAt: null,
      monitor: "price-freshness",
      pendingDelivery: "not-configured",
      pendingEventId: "evt-chat",
      pendingKeys: ["daily_series:SPY"],
      pendingKind: "alert",
      updatedAt: NOW,
    });
    const failedAck = await handleRecordPriceFreshnessChat(
      makeDeps({ freshness: memFailedChat.store }),
      { delivery: "failed", eventId: "evt-chat" }
    );
    expect(failedAck).toEqual({
      committed: true,
      delivery: "failed",
      eventId: "evt-chat",
    });
    expect(memFailedChat.state()?.pendingDelivery).toBe("failed");
    const staleAck = await handleRecordPriceFreshnessChat(
      makeDeps({ freshness: memFailedChat.store }),
      { delivery: "sent", eventId: "evt-other" }
    );
    expect(staleAck).toEqual({
      committed: false,
      delivery: "sent",
      eventId: "evt-other",
    });

    // superseded Phase 3 returns pendingChat null
    const base = makeStore();
    const supersededStore: OpenbbFreshnessRepository = {
      ...base.store,
      completeFreshnessDelivery: async () => false,
    };
    const sup = await handleCheckPriceFreshness(
      makeDeps({
        freshness: supersededStore,
        seriesDateOverrides: { SPY: STALE_DATE },
      }),
      false
    );
    expect(sup.pendingChat).toBeNull();

    // defensive guard when stageFreshnessTransition skips callback
    const skippedCallbackStore: OpenbbFreshnessRepository = {
      ...base.store,
      stageFreshnessTransition: async () => ({ activeKeys: [], kind: "noop" }),
    };
    await expect(
      handleCheckPriceFreshness(
        makeDeps({ freshness: skippedCallbackStore }),
        false
      )
    ).rejects.toThrow("transition callback did not run");
  });

  it("wraps repository errors in STORAGE_ERROR across all 3 handlers", async () => {
    const brokenStore: OpenbbFreshnessRepository = {
      completeFreshnessDelivery: async () => {
        throw new Error("db down");
      },
      getFreshnessState: async () => {
        throw "raw-fail";
      },
      stageFreshnessTransition: async () => {
        throw new Error("tx fail");
      },
    };
    await expect(
      handlePriceFreshness(makeDeps({ freshness: brokenStore }))
    ).rejects.toThrow("openbb.priceFreshness: raw-fail");

    await expect(
      handleCheckPriceFreshness(makeDeps({ freshness: brokenStore }), true)
    ).rejects.toThrow("openbb.checkPriceFreshness: raw-fail");

    await expect(
      handleCheckPriceFreshness(makeDeps({ freshness: brokenStore }), false)
    ).rejects.toThrow("openbb.checkPriceFreshness: tx fail");

    const phase3Broken: OpenbbFreshnessRepository = {
      ...makeStore().store,
      completeFreshnessDelivery: async () => {
        throw new Error("phase3 fail");
      },
    };
    await expect(
      handleCheckPriceFreshness(
        makeDeps({
          freshness: phase3Broken,
          seriesDateOverrides: { SPY: STALE_DATE },
        }),
        false
      )
    ).rejects.toThrow("openbb.checkPriceFreshness: phase3 fail");

    // Load failure in checkPriceFreshness
    const brokenBarsDeps: FreshnessDeps = {
      ...makeDeps(),
      bars: {
        latestBars: async () => {
          throw new Error("bars down");
        },
      } as unknown as MarketBarsRepository,
    };
    await expect(
      handleCheckPriceFreshness(brokenBarsDeps, false)
    ).rejects.toThrow("openbb.checkPriceFreshness: bars down");

    await expect(
      handleRecordPriceFreshnessChat(makeDeps({ freshness: brokenStore }), {
        delivery: "sent",
        eventId: "evt-1",
      })
    ).rejects.toThrow("openbb.recordPriceFreshnessChat: db down");
  });
});

describe("openbbPriceFreshnessRouter end-to-end", () => {
  afterEach(() => {
    setOpenbbPriceFreshnessOptionsForTesting(null);
  });

  const PLAINTEXT = "vrk_price_freshness_test";

  const clientFor = (options: {
    apiKey?: string;
    deps?: FreshnessDeps;
    keyAccess?: "read" | "write";
    omitFreshnessRepo?: boolean;
    omitRepos?: boolean;
  }) => {
    const deps = options.deps ?? makeDeps();
    const repositories: Repositories = {
      addresses: {} as Repositories["addresses"],
      adminUsers: {} as Repositories["adminUsers"],
      dashboard: {} as Repositories["dashboard"],
      featureItems: {} as Repositories["featureItems"],
      profiles: {} as Repositories["profiles"],
      userPreferences: {} as Repositories["userPreferences"],
      ...(options.omitRepos
        ? {}
        : {
            marketBars: deps.bars,
            marketDailySeries: deps.series,
            ...(options.omitFreshnessRepo
              ? {}
              : {
                  openbbFreshness:
                    deps.freshness as unknown as OpenbbFreshnessRepository,
                }),
          }),
    };
    const agentApiKeys = {
      authenticate: async (headers: Headers) => {
        if (headers.get("x-api-key") !== PLAINTEXT)
          throw new AuthAuthorizationError(
            AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
            401
          );
        return {
          access: options.keyAccess ?? "write",
          apiKeyId: "key-1",
          email: "owner@domain.test",
          emailVerified: true,
          role: "member" as const,
          status: "active" as const,
          userId: "owner",
        };
      },
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
          priceAlertsNtfy: deps.context.priceAlertsNtfy ?? null,
          repositories,
          requestId: "req-freshness-1",
          requireRole: async () => {
            throw new AuthAuthorizationError(
              AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
              401
            );
          },
          requireSession: async () => ({
            principal: { role: "member", status: "active", userId: "owner" },
            session: {
              createdAt: NOW,
              expiresAt: new Date("2027-01-01T00:00:00Z"),
              id: "sess-1",
              ipAddress: null,
              updatedAt: NOW,
              userAgent: null,
              userId: "owner",
            },
            user: {
              createdAt: NOW,
              email: "owner@domain.test",
              emailVerified: true,
              id: "owner",
              image: null,
              name: "Owner",
              role: "member" as const,
              status: "active" as const,
              updatedAt: NOW,
            },
          }),
        });
        return handleApiRequest(request, context);
      },
    });
  };

  it("enforces read-key vs write-key vs session auth and executes full check + chat ack flow", async () => {
    expect(AGENT_API_KEY_READ_PROCEDURES.has("openbb.priceFreshness")).toBe(
      true
    );
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("openbb.checkPriceFreshness")
    ).toBe(false);
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("openbb.recordPriceFreshnessChat")
    ).toBe(false);

    // Default system clock works without options override
    const defaultClient = clientFor({});
    const liveStatus = await defaultClient.openbb.priceFreshness({});
    expect(liveStatus.dailySeriesCount).toBe(31);
    expect(liveStatus.dailyBarsCount).toBe(14);

    setOpenbbPriceFreshnessOptionsForTesting({ clock: () => NOW });

    // Operator session without API key can read priceFreshness, but is refused on write procedures.
    const sessionClient = clientFor({});
    const status = await sessionClient.openbb.priceFreshness({});
    expect(status.expectedSession).toBe(FRESH_DATE);
    await expect(sessionClient.openbb.checkPriceFreshness({})).rejects.toThrow(
      "needs a write agent API key"
    );
    await expect(
      sessionClient.openbb.recordPriceFreshnessChat({
        delivery: "sent",
        eventId: "evt-1",
      })
    ).rejects.toThrow("needs a write agent API key");

    // Read-only API key can call priceFreshness, but is refused on write procedures.
    const readKeyClient = clientFor({ apiKey: PLAINTEXT, keyAccess: "read" });
    expect((await readKeyClient.openbb.priceFreshness({})).stale).toEqual([]);
    await expect(readKeyClient.openbb.checkPriceFreshness({})).rejects.toThrow(
      "read-only"
    );
    await expect(
      readKeyClient.openbb.recordPriceFreshnessChat({
        delivery: "sent",
        eventId: "evt-1",
      })
    ).rejects.toThrow("read-only");

    // Defense-in-depth requireFreshnessWriteKey also rejects callerCanWrite !== true
    const forbidden = (options?: { message?: string }) =>
      new Error(options?.message ?? "forbidden");
    expect(() =>
      requireFreshnessWriteKey(
        { agentApiKeyPresented: true, callerCanWrite: false } as ApiContext,
        { FORBIDDEN: forbidden, STORAGE_ERROR: storageError },
        "checkPriceFreshness"
      )
    ).toThrow("needs a write agent API key");

    // Write API key stages alert and commits chat ack end-to-end.
    const mem = makeStore();
    const deps = makeDeps({
      freshness: mem.store,
      seriesDateOverrides: { SPY: STALE_DATE },
    });
    const writeClient = clientFor({
      apiKey: PLAINTEXT,
      deps,
      keyAccess: "write",
    });
    const checked = await writeClient.openbb.checkPriceFreshness({});
    expect(checked.action).toBe("alert");
    expect(checked.pendingChat).not.toBeNull();
    const ack = await writeClient.openbb.recordPriceFreshnessChat({
      delivery: "sent",
      eventId: checked.pendingChat?.eventId ?? "",
    });
    expect(ack.committed).toBe(true);
    expect(mem.state()?.activeKeys).toEqual(["daily_series:SPY"]);
  });

  it("throws STORAGE_ERROR when repositories are not configured", async () => {
    const missingAll = clientFor({ apiKey: PLAINTEXT, omitRepos: true });
    await expect(missingAll.openbb.priceFreshness({})).rejects.toThrow(
      "OpenBB freshness"
    );
    await expect(missingAll.openbb.checkPriceFreshness({})).rejects.toThrow(
      "OpenBB freshness"
    );
    const missingFreshness = clientFor({
      apiKey: PLAINTEXT,
      omitFreshnessRepo: true,
    });
    await expect(
      missingFreshness.openbb.recordPriceFreshnessChat({
        delivery: "sent",
        eventId: "evt-1",
      })
    ).rejects.toThrow("OpenBB freshness");
  });
});
