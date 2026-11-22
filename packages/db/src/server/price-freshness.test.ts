import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { openbbFreshnessState } from "../schema/openbb-freshness.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createOpenbbFreshnessRepository,
  type OpenbbFreshnessState,
} from "./price-freshness.ts";

const NOW = new Date("2026-11-22T12:00:00Z");

const fakeDb = (initial: OpenbbFreshnessState | null = null) => {
  let row: OpenbbFreshnessState | null = initial;
  const writes: string[] = [];
  let lockCalls = 0;

  const tx = {
    execute: async () => {
      lockCalls += 1;
    },
    insert: () => ({
      values: (vals: OpenbbFreshnessState) => ({
        onConflictDoUpdate: async ({
          set,
        }: {
          set: Partial<OpenbbFreshnessState>;
        }) => {
          writes.push("upsert");
          row = row === null ? { ...vals } : { ...row, ...set };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => (row === null ? [] : [row]),
      }),
    }),
    update: () => ({
      set: (patch: Partial<OpenbbFreshnessState>) => ({
        where: async () => {
          writes.push("update");
          if (row !== null) row = { ...row, ...patch };
        },
      }),
    }),
  };

  const database = {
    ...tx,
    transaction: async <T>(fn: (executor: typeof tx) => Promise<T>) =>
      await fn(tx),
  } as unknown as DatabaseExecutor;

  return {
    database,
    lockCalls: () => lockCalls,
    row: () => row,
    writes,
  };
};

describe("createOpenbbFreshnessRepository", () => {
  it("validates monitor name on every method", async () => {
    const { database } = fakeDb();
    const repo = createOpenbbFreshnessRepository(database);
    await expect(repo.getFreshnessState("BAD_NAME!")).rejects.toThrow(
      "Invalid freshness monitor"
    );
    await expect(
      repo.stageFreshnessTransition("BAD!", () => ({ kind: "noop" }), NOW)
    ).rejects.toThrow("Invalid freshness monitor");
    await expect(
      repo.completeFreshnessDelivery("BAD!", "evt-1", "sent", NOW)
    ).rejects.toThrow("Invalid freshness monitor");
  });

  it("performs zero DB writes on noop and in-flight decisions", async () => {
    const db = fakeDb();
    const repo = createOpenbbFreshnessRepository(db.database);
    expect(await repo.getFreshnessState("price-freshness")).toBeNull();

    const noop = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({ kind: "noop" }),
      NOW
    );
    expect(noop).toEqual({ activeKeys: [], kind: "noop" });
    expect(db.writes).toEqual([]);
    expect(db.lockCalls()).toBe(1);

    const inFlight = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({ kind: "in-flight" }),
      NOW
    );
    expect(inFlight).toEqual({ activeKeys: [], kind: "in-flight" });
    expect(db.writes).toEqual([]);
  });

  it("stages pending alert, updates delivery on failure, and commits activeKeys on sent", async () => {
    const db = fakeDb();
    const repo = createOpenbbFreshnessRepository(db.database);

    const staged = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({
        eventId: "evt-1",
        kind: "stage-pending",
        pendingKeys: ["daily_series:SPY"],
        pendingKind: "alert",
      }),
      NOW
    );
    expect(staged).toEqual({
      activeKeys: [],
      eventId: "evt-1",
      kind: "stage-pending",
      pendingKeys: ["daily_series:SPY"],
      pendingKind: "alert",
    });
    expect(db.row()?.pendingDelivery).toBe("pending");
    expect(db.row()?.activeKeys).toEqual([]);

    // Mismatched eventId returns false
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-wrong",
        "sent",
        NOW
      )
    ).toBe(false);

    // Failed/not-configured keeps pending intact
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-1",
        "not-configured",
        NOW
      )
    ).toBe(true);
    expect(db.row()?.pendingDelivery).toBe("not-configured");
    expect(db.row()?.activeKeys).toEqual([]);

    // Sent commits pendingKeys -> activeKeys and clears pending columns
    const later = new Date("2026-11-22T12:05:00Z");
    expect(
      await repo.completeFreshnessDelivery(
        "price-freshness",
        "evt-1",
        "sent",
        later
      )
    ).toBe(true);
    const afterSent = await repo.getFreshnessState("price-freshness");
    expect(afterSent?.activeKeys).toEqual(["daily_series:SPY"]);
    expect(afterSent?.pendingEventId).toBeNull();
    expect(afterSent?.pendingKind).toBeNull();
    expect(afterSent?.pendingDelivery).toBeNull();
    expect(afterSent?.pendingKeys).toEqual([]);
    expect(afterSent?.lastTransitionAt).toEqual(later);
  });

  it("handles prune-active, clear-pending, and completeFreshnessDelivery when no row exists", async () => {
    const empty = fakeDb();
    const emptyRepo = createOpenbbFreshnessRepository(empty.database);
    expect(
      await emptyRepo.completeFreshnessDelivery(
        "price-freshness",
        "evt-1",
        "sent",
        NOW
      )
    ).toBe(false);

    const db = fakeDb({
      activeKeys: ["daily_bars:QQQ", "daily_series:SPY"],
      lastTransitionAt: new Date("2026-11-21T12:00:00Z"),
      monitor: "price-freshness",
      pendingDelivery: "failed",
      pendingEventId: "evt-old",
      pendingKeys: ["daily_bars:QQQ", "daily_series:SPY"],
      pendingKind: "alert",
      updatedAt: new Date("2026-11-21T12:00:00Z"),
    });
    const repo = createOpenbbFreshnessRepository(db.database);

    const cleared = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({ kind: "clear-pending" }),
      NOW
    );
    expect(cleared).toEqual({
      activeKeys: ["daily_bars:QQQ", "daily_series:SPY"],
      kind: "clear-pending",
    });
    expect(db.row()?.pendingEventId).toBeNull();
    expect(db.row()?.lastTransitionAt).toEqual(
      new Date("2026-11-21T12:00:00Z")
    );

    // Clear-pending when row was null also exercises the ?? null fallback cleanly
    const clearNull = fakeDb(null);
    await createOpenbbFreshnessRepository(
      clearNull.database
    ).stageFreshnessTransition(
      "price-freshness",
      () => ({ kind: "clear-pending" }),
      NOW
    );
    expect(clearNull.row()?.lastTransitionAt).toBeNull();

    const pruned = await repo.stageFreshnessTransition(
      "price-freshness",
      () => ({
        activeKeys: ["daily_bars:QQQ"],
        kind: "prune-active",
      }),
      NOW
    );
    expect(pruned).toEqual({
      activeKeys: ["daily_bars:QQQ"],
      kind: "prune-active",
    });
    expect(db.row()?.activeKeys).toEqual(["daily_bars:QQQ"]);
    expect(db.row()?.lastTransitionAt).toEqual(NOW);
  });

  it("exposes openbb_freshness_state Drizzle table config and check constraint", () => {
    const config = getTableConfig(openbbFreshnessState);
    expect(config.name).toBe("openbb_freshness_state");
    expect(config.checks.map((c) => c.name)).toEqual([
      "openbb_freshness_state_check",
    ]);
  });
});
