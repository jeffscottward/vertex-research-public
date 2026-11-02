import { describe, expect, it } from "vitest";
import { createMemoryNotificationFixture } from "../testing/memory-store.ts";
import type { NotificationAdmissionInput } from "./contracts.ts";

const admission: NotificationAdmissionInput = {
  scope: {
    tenantKey: "tenant-a",
    recipientKey: "recipient-a",
    channel: "phone",
    purpose: "market-alert",
  },
  idempotencyKey: "event-a",
  fingerprint: "a".repeat(64),
  attemptId: "attempt-a",
  now: 1_700_000_000_000,
  expiresAt: 1_700_000_100_000,
  cooldownMs: 30_000,
  mode: "commit",
};

// These are authored contract cases for the later Drizzle store as well. The
// fixture models semantics, not process durability or database isolation proof.
describe("notification atomic store contract", () => {
  it("does not write any state in observe mode", async () => {
    const fixture = createMemoryNotificationFixture();
    expect(
      await fixture.store.admit({ ...admission, mode: "observe" })
    ).toEqual({ status: "eligible" });
    return expect(fixture.inspect()).toEqual({
      reservations: 0,
      cooldowns: 0,
      outcomes: [],
    });
  });

  it("atomically deduplicates racing attempts and reserves before outcome", async () => {
    const { store, inspect } = createMemoryNotificationFixture();
    const results = await Promise.all([
      store.admit(admission),
      store.admit({ ...admission, attemptId: "attempt-b" }),
    ]);
    expect(results).toEqual([
      { status: "admitted", attemptId: "attempt-a" },
      { status: "duplicate", acceptance: "pending" },
    ]);
    return expect(inspect().outcomes).toEqual(["pending"]);
  });

  it("checks content conflict before cooldown", async () => {
    const { store } = createMemoryNotificationFixture();
    await store.admit(admission);
    expect(
      await store.admit({ ...admission, fingerprint: "b".repeat(64) })
    ).toEqual({ status: "conflict" });
    return expect(
      await store.admit({ ...admission, idempotencyKey: "event-b" })
    ).toEqual({ status: "cooldown" });
  });

  it("retains pending and unknown indefinitely rather than lease-retrying", async () => {
    for (const outcome of ["pending", "unknown"] as const) {
      const { store } = createMemoryNotificationFixture();
      await store.admit(admission);
      if (outcome === "unknown") {
        await store.recordOutcome({
          scope: admission.scope,
          idempotencyKey: admission.idempotencyKey,
          attemptId: admission.attemptId,
          acceptance: "unknown",
          now: admission.now + 1,
        });
      }
      const later = admission.now + 365 * 86_400_000;

      expect(
        await store.admit({
          ...admission,
          now: later,
          expiresAt: later + 10_000,
        })
      ).toEqual({ status: "duplicate", acceptance: outcome });
    }
  });

  it("never allows a stale outcome to release or overwrite another reservation", async () => {
    const { store } = createMemoryNotificationFixture();
    await store.admit(admission);
    const outcome = {
      scope: admission.scope,
      idempotencyKey: admission.idempotencyKey,
      attemptId: admission.attemptId,
      acceptance: "accepted" as const,
      now: admission.now + 1,
    };
    expect(
      await store.recordOutcome({ ...outcome, attemptId: "wrong" })
    ).toEqual({ status: "stale" });
    expect(
      await store.recordOutcome({
        ...outcome,
        scope: { ...admission.scope, recipientKey: "other" },
      })
    ).toEqual({ status: "stale" });
    expect(await store.recordOutcome(outcome)).toEqual({ status: "recorded" });
    expect(await store.recordOutcome(outcome)).toEqual({ status: "recorded" });
    expect(
      await store.recordOutcome({ ...outcome, acceptance: "unknown" })
    ).toEqual({ status: "stale" });
    return expect(await store.admit(admission)).toEqual({
      status: "duplicate",
      acceptance: "accepted",
    });
  });

  it("isolates recipient tenant and channel while sharing cooldown across purpose", async () => {
    const { store } = createMemoryNotificationFixture();
    await store.admit(admission);
    expect(
      await store.admit({
        ...admission,
        scope: { ...admission.scope, purpose: "research-update" },
      })
    ).toEqual({ status: "cooldown" });
    for (const change of [
      { recipientKey: "recipient-b" },
      { tenantKey: "tenant-b" },
      { channel: "email" as const },
    ]) {
      expect(
        (
          await store.admit({
            ...admission,
            scope: { ...admission.scope, ...change },
          })
        ).status
      ).toBe("admitted");
    }
  });

  return it("does not reserve expired requests and admits at the cooldown boundary", async () => {
    const { store, inspect } = createMemoryNotificationFixture();
    expect(
      await store.admit({ ...admission, expiresAt: admission.now })
    ).toEqual({ status: "expired" });
    expect(inspect().reservations).toBe(0);
    await store.admit(admission);
    return expect(
      (
        await store.admit({
          ...admission,
          idempotencyKey: "event-b",
          now: admission.now + admission.cooldownMs,
        })
      ).status
    ).toBe("admitted");
  });
});
