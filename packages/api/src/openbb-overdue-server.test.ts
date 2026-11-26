import type { OpenbbFreshnessStageDecision } from "@darkfactory/db/server";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENBB_JOBS } from "./contracts/openbb.ts";
import { openbbOverdueContract } from "./contracts/openbb-overdue.ts";
import { OPENBB_OVERDUE_MONITOR } from "./openbb-overdue.ts";
import type { ApiContext } from "./server/context.ts";
import {
  handleCheckSourceOverdue,
  handleRecordSourceOverdueChat,
  type OverdueDeps,
  setOpenbbOverdueOptionsForTesting,
} from "./server/openbb-overdue.ts";
import { AGENT_API_KEY_READ_PROCEDURES } from "./server/operator-access.ts";
import { appRouter } from "./server/router.ts";

const NOW = new Date("2026-11-23T16:00:00.000Z"); // Mon 11:00 ET

const healthyRuns = () =>
  OPENBB_JOBS.map((job) => ({
    job,
    latest: {
      error: null,
      finishedAt: new Date("2026-11-23T15:00:00.000Z"),
      id: `run-${job}`,
      job,
      openbbVersion: "4.0",
      rowsReceived: 10,
      rowsWritten: 10,
      startedAt: new Date("2026-11-23T14:59:00.000Z"),
      status: "ok" as const,
      warnings: [],
    },
    latestUsable: {
      error: null,
      finishedAt: new Date("2026-11-23T15:00:00.000Z"),
      id: `run-${job}`,
      job,
      openbbVersion: "4.0",
      rowsReceived: 10,
      rowsWritten: 10,
      startedAt: new Date("2026-11-23T14:59:00.000Z"),
      status: "ok" as const,
      warnings: [],
    },
  }));

const makeInMemoryFreshness = () => {
  let row: {
    activeKeys: string[];
    lastTransitionAt: Date | null;
    monitor: string;
    pendingDelivery: "pending" | "not-configured" | "failed" | null;
    pendingEventId: string | null;
    pendingKeys: string[];
    pendingKind: "alert" | "recovery" | null;
    updatedAt: Date;
  } | null = null;
  return {
    completeFreshnessDelivery: vi.fn(
      async (
        _monitor: string,
        eventId: string,
        delivery: "sent" | "not-configured" | "failed",
        now: Date
      ) => {
        if (row === null || row.pendingEventId !== eventId) return false;
        if (delivery === "sent") {
          row = {
            ...row,
            activeKeys: [...row.pendingKeys],
            lastTransitionAt: now,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          };
        } else {
          row = { ...row, pendingDelivery: delivery, updatedAt: now };
        }
        return true;
      }
    ),
    getFreshnessState: vi.fn(async () => (row === null ? null : { ...row })),
    getRow: () => row,
    setRow: (next: typeof row) => {
      row = next;
    },
    stageFreshnessTransition: vi.fn(
      async (
        monitor: string,
        decide: (current: typeof row) => OpenbbFreshnessStageDecision,
        now: Date
      ) => {
        const decision = decide(row);
        const currentActive = row === null ? [] : [...row.activeKeys];
        if (decision.kind === "noop" || decision.kind === "in-flight") {
          return { activeKeys: currentActive, kind: decision.kind };
        }
        if (decision.kind === "prune-active") {
          row = {
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
          row = {
            activeKeys: currentActive,
            lastTransitionAt: row?.lastTransitionAt ?? null,
            monitor,
            pendingDelivery: null,
            pendingEventId: null,
            pendingKeys: [],
            pendingKind: null,
            updatedAt: now,
          };
          return { activeKeys: currentActive, kind: "clear-pending" };
        }
        row = {
          activeKeys: currentActive,
          lastTransitionAt: row?.lastTransitionAt ?? null,
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
      }
    ),
  };
};

const makeDeps = (overrides?: {
  freshness?: ReturnType<typeof makeInMemoryFreshness>;
  ntfy?: ApiContext["priceAlertsNtfy"];
  overdue?: boolean;
  sendNtfy?: OverdueDeps["sendNtfy"];
}) => {
  const freshness = overrides?.freshness ?? makeInMemoryFreshness();
  const runs = overrides?.overdue
    ? healthyRuns().map((r) =>
        r.job === "congress-house"
          ? { ...r, latest: null, latestUsable: null }
          : r
      )
    : healthyRuns();
  const openbb = {
    form4IndexDays: vi.fn(async () => [
      { complete: true, done: 10, indexDay: "2026-11-20", listed: 10 },
    ]),
    lastRunsFor: vi.fn(async () => runs),
    tableStats: vi.fn(async () => [
      {
        newestDate: "2026-11-20",
        rows: 100,
        table: "openbb_short_volume_daily",
      },
    ]),
  };
  const flow = {
    latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
    marketPremiumLedger: vi.fn(async () => [
      {
        capturedAt: new Date("2026-11-23T15:50:00.000Z"),
        lastAttemptAt: new Date("2026-11-23T15:50:00.000Z"),
        lastMessage: null,
        sessionDate: "2026-11-23",
        status: "partial" as const,
        tickers: 500,
      },
    ]),
  };
  const failures = {
    FORBIDDEN: (opts?: { message?: string }) =>
      new Error(opts?.message ?? "forbidden"),
    STORAGE_ERROR: (opts?: { message?: string }) =>
      new Error(opts?.message ?? "storage"),
  };
  const deps: OverdueDeps = {
    clock: () => NOW,
    context: {
      priceAlertsNtfy: overrides?.ntfy ?? null,
    } as unknown as ApiContext,
    failures,
    flow: flow as unknown as OverdueDeps["flow"],
    freshness: freshness as unknown as OverdueDeps["freshness"],
    openbb: openbb as unknown as OverdueDeps["openbb"],
    sendNtfy: overrides?.sendNtfy,
  };
  return { deps, flow, freshness, openbb };
};

afterEach(() => {
  setOpenbbOverdueOptionsForTesting(null);
});

describe("openbbOverdueContract and handlers", () => {
  it("exposes checkSourceOverdue and recordSourceOverdueChat and keeps them write-only", () => {
    expect(Object.keys(openbbOverdueContract).sort()).toEqual([
      "checkSourceOverdue",
      "recordSourceOverdueChat",
    ]);
    expect(AGENT_API_KEY_READ_PROCEDURES.has("openbb.checkSourceOverdue")).toBe(
      false
    );
    expect(
      AGENT_API_KEY_READ_PROCEDURES.has("openbb.recordSourceOverdueChat")
    ).toBe(false);
  });

  it("handles dry-run (read-only), alert->sent, noop, prune-active, clear-pending, and recovery", async () => {
    const { deps, freshness } = makeDeps({
      ntfy: { origin: "https://ntfy.test", token: "tok", topic: "top" },
      overdue: true,
      sendNtfy: vi.fn(async () => "sent" as const),
    });

    // dry-run stages nothing
    const dry = await handleCheckSourceOverdue(deps, true);
    expect(dry.action).toBe("alert");
    expect(dry.delivery).toBe("dry-run");
    expect(dry.pendingChat).toBeNull();
    expect(freshness.stageFreshnessTransition).not.toHaveBeenCalled();

    // dry-run when state row already exists (covers state !== null branch)
    freshness.setRow({
      activeKeys: ["openbb:congress-house"],
      lastTransitionAt: NOW,
      monitor: OPENBB_OVERDUE_MONITOR,
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: NOW,
    });
    const dryWithState = await handleCheckSourceOverdue(deps, true);
    expect(dryWithState.activeAlertKeys).toEqual(["openbb:congress-house"]);
    freshness.setRow(null);

    // real alert -> ntfy sent -> activeKeys committed
    const alerted = await handleCheckSourceOverdue(deps, false);
    expect(alerted.action).toBe("alert");
    expect(alerted.delivery).toBe("sent");
    expect(alerted.activeAlertKeys).toEqual(["openbb:congress-house"]);
    expect(alerted.pendingChat).toBeNull();

    // repeat while still overdue -> noop
    const steady = await handleCheckSourceOverdue(deps, false);
    expect(steady.action).toBe("noop");
    expect(steady.delivery).toBeNull();

    // partial recovery -> prune-active
    freshness.setRow({
      activeKeys: ["openbb:congress-house", "openbb:congress-senate"],
      lastTransitionAt: NOW,
      monitor: OPENBB_OVERDUE_MONITOR,
      pendingDelivery: null,
      pendingEventId: null,
      pendingKeys: [],
      pendingKind: null,
      updatedAt: NOW,
    });
    const pruned = await handleCheckSourceOverdue(deps, false);
    expect(pruned.action).toBe("prune-active");
    expect(pruned.activeAlertKeys).toEqual(["openbb:congress-house"]);

    // clear-pending when obsolete pending exists after lease expired
    freshness.setRow({
      activeKeys: ["openbb:congress-house"],
      lastTransitionAt: NOW,
      monitor: OPENBB_OVERDUE_MONITOR,
      pendingDelivery: "failed",
      pendingEventId: "old-evt",
      pendingKeys: ["openbb:congress-house"],
      pendingKind: "alert",
      updatedAt: new Date(NOW.getTime() - 120_000),
    });
    const cleared = await handleCheckSourceOverdue(deps, false);
    expect(cleared.action).toBe("clear-pending");

    // full recovery
    const healthy = makeDeps({
      freshness,
      ntfy: { origin: "https://ntfy.test", token: "tok", topic: "top" },
      overdue: false,
      sendNtfy: vi.fn(async () => "sent" as const),
    });
    const recovered = await handleCheckSourceOverdue(healthy.deps, false);
    expect(recovered.action).toBe("recovery");
    expect(recovered.delivery).toBe("sent");
    expect(recovered.activeAlertKeys).toEqual([]);
  });

  it("returns pendingChat when ntfy throws or is not-configured and supports recordSourceOverdueChat", async () => {
    const { deps, freshness } = makeDeps({
      overdue: true,
      sendNtfy: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const res = await handleCheckSourceOverdue(deps, false);
    expect(res.action).toBe("alert");
    expect(res.delivery).toBe("failed");
    expect(res.pendingChat).not.toBeNull();
    const eventId = res.pendingChat?.eventId ?? "";

    const ack = await handleRecordSourceOverdueChat(
      { clock: () => NOW, failures: deps.failures, freshness: deps.freshness },
      { delivery: "sent", eventId }
    );
    expect(ack).toEqual({ committed: true, delivery: "sent", eventId });
    expect(freshness.getRow()?.activeKeys).toEqual(["openbb:congress-house"]);
  });

  it("handles uncommitted phase-3 delivery and storage errors cleanly", async () => {
    const freshness = makeInMemoryFreshness();
    freshness.completeFreshnessDelivery.mockResolvedValueOnce(false);
    const { deps } = makeDeps({
      freshness,
      overdue: true,
      sendNtfy: vi.fn(async () => "not-configured" as const),
    });
    const res = await handleCheckSourceOverdue(deps, false);
    expect(res.pendingChat).toBeNull();

    // Load error
    const brokenLoad = makeDeps();
    brokenLoad.openbb.lastRunsFor.mockRejectedValueOnce("db-down");
    await expect(
      handleCheckSourceOverdue(brokenLoad.deps, false)
    ).rejects.toThrow("openbb.checkSourceOverdue: db-down");

    // Dry-run state read error
    const brokenDry = makeDeps();
    brokenDry.freshness.getFreshnessState.mockRejectedValueOnce(
      new Error("state read fail")
    );
    await expect(
      handleCheckSourceOverdue(brokenDry.deps, true)
    ).rejects.toThrow("openbb.checkSourceOverdue: state read fail");

    // Stage error
    const brokenStage = makeDeps({ overdue: true });
    brokenStage.freshness.stageFreshnessTransition.mockRejectedValueOnce(
      new Error("tx fail")
    );
    await expect(
      handleCheckSourceOverdue(brokenStage.deps, false)
    ).rejects.toThrow("openbb.checkSourceOverdue: tx fail");

    // Stage callback did not run
    const noCb = makeDeps({ overdue: true });
    noCb.freshness.stageFreshnessTransition.mockResolvedValueOnce({
      activeKeys: [],
      kind: "noop",
    });
    await expect(handleCheckSourceOverdue(noCb.deps, false)).rejects.toThrow(
      "transition callback did not run"
    );

    // Phase 3 commit error
    const brokenCommit = makeDeps({
      overdue: true,
      sendNtfy: vi.fn(async () => "sent" as const),
    });
    brokenCommit.freshness.completeFreshnessDelivery.mockRejectedValueOnce(
      new Error("commit fail")
    );
    await expect(
      handleCheckSourceOverdue(brokenCommit.deps, false)
    ).rejects.toThrow("openbb.checkSourceOverdue: commit fail");

    // Record chat error
    const brokenChat = makeDeps();
    brokenChat.freshness.completeFreshnessDelivery.mockRejectedValueOnce(
      new Error("chat commit fail")
    );
    await expect(
      handleRecordSourceOverdueChat(
        {
          clock: () => NOW,
          failures: brokenChat.deps.failures,
          freshness: brokenChat.deps.freshness,
        },
        { delivery: "failed", eventId: "evt-1" }
      )
    ).rejects.toThrow("openbb.recordSourceOverdueChat: chat commit fail");
  });

  it("enforces operator write-key auth and storage checks through appRouter", async () => {
    setOpenbbOverdueOptionsForTesting({
      clock: () => NOW,
      sendNtfy: vi.fn(async () => "sent" as const),
    });
    const { flow, freshness, openbb } = makeDeps({ overdue: true });
    const makeClient = (opts: {
      apiKey?: boolean;
      hasFreshness?: boolean;
      hasOpenbb?: boolean;
    }) =>
      createRouterClient(appRouter, {
        context: {
          agentApiKeyPresented: opts.apiKey ?? true,
          agentApiKeys: {
            authenticate: vi.fn(async () => ({
              access: "write" as const,
              email: "op@domain.test",
              emailVerified: true,
              role: "admin",
              status: "active",
              userId: "u1",
            })),
          },
          agentViewerEmails: [],
          operatorEmails: ["op@domain.test"],
          priceAlertsNtfy: null,
          repositories: {
            flow: flow as never,
            openbb: opts.hasOpenbb === false ? undefined : (openbb as never),
            openbbFreshness:
              opts.hasFreshness === false ? undefined : (freshness as never),
          },
          requireSession: vi.fn(async () => ({
            principal: { role: "admin", status: "active", userId: "u1" },
            user: {
              email: "op@domain.test",
              emailVerified: true,
              status: "active",
            },
          })),
        } as unknown as ApiContext,
      });

    // Session without API key refused
    const sessionClient = makeClient({ apiKey: false });
    await expect(sessionClient.openbb.checkSourceOverdue({})).rejects.toThrow(
      "needs an agent API key"
    );
    await expect(
      sessionClient.openbb.recordSourceOverdueChat({
        delivery: "sent",
        eventId: "e1",
      })
    ).rejects.toThrow("needs an agent API key");

    // Missing storage refused
    const noStorage = makeClient({ hasFreshness: false, hasOpenbb: false });
    await expect(noStorage.openbb.checkSourceOverdue({})).rejects.toThrow(
      "OpenBB"
    );
    await expect(
      noStorage.openbb.recordSourceOverdueChat({
        delivery: "sent",
        eventId: "e1",
      })
    ).rejects.toThrow("OpenBB");

    // Valid write key succeeds
    const writeClient = makeClient({ apiKey: true });
    const checked = await writeClient.openbb.checkSourceOverdue({
      dryRun: true,
    });
    expect(checked.action).toBe("alert");
    expect(checked.delivery).toBe("dry-run");
    // Default sendPriceAlertsNtfy (null config -> not-configured) and default systemClock
    setOpenbbOverdueOptionsForTesting(null);
    const liveChecked = await writeClient.openbb.checkSourceOverdue({});
    expect(liveChecked.delivery).toBe("not-configured");
    expect(liveChecked.pendingChat).not.toBeNull();

    const ack = await writeClient.openbb.recordSourceOverdueChat({
      delivery: "sent",
      eventId: "missing-event",
    });
    expect(ack.committed).toBe(false);
  });
});
