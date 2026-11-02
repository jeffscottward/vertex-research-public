import { describe, expect, it, vi } from "vitest";

import { createNautilusArmAuditRepository } from "./arm-switch-audit.ts";
import type { DatabaseExecutor } from "./client.ts";

const fakeDatabase = (countValue: number) => {
  const inserted: unknown[] = [];
  const where = vi.fn(async () => [{ value: countValue }]);
  const database = {
    insert: () => ({ values: async (row: unknown) => inserted.push(row) }),
    select: () => ({ from: () => ({ where }) }),
  } as unknown as DatabaseExecutor;
  return { database, inserted, where };
};

const now = new Date("2026-10-28T12:00:00.000Z");

describe("nautilus arm audit repository", () => {
  it("records an audit row for an arm request", async () => {
    const { database, inserted } = fakeDatabase(0);
    const repository = createNautilusArmAuditRepository(database, {
      now: () => now,
      generateId: () => "audit-1",
    });
    await expect(
      repository.record({
        action: "nautilus.arm.intent",
        actorUserId: "u1",
        armRequestId: "dr-1",
        requestId: "req-1",
        metadata: { brokenRules: ["X03"], explanation: "named X03" },
      })
    ).resolves.toEqual({ id: "audit-1" });
    expect(inserted).toEqual([
      expect.objectContaining({
        id: "audit-1",
        action: "nautilus.arm.intent",
        entityType: "nautilus_node",
        entityId: "dr-1",
        actorUserId: "u1",
        requestId: "req-1",
        createdAt: now,
      }),
    ]);
  });

  it("refuses credential fields, unknown actions and a blank request id", async () => {
    const { database, inserted } = fakeDatabase(0);
    const repository = createNautilusArmAuditRepository(database, {
      now: () => now,
      generateId: () => "audit-1",
    });
    const base = {
      actorUserId: "u1",
      armRequestId: "dr-1",
      requestId: "req-1",
    };
    await expect(
      repository.record({
        ...base,
        action: "nautilus.arm.intent",
        metadata: { nested: [{ password: "x" }] },
      })
    ).rejects.toThrow(/credential/u);
    await expect(
      repository.record({
        ...base,
        action: "nautilus.arm.intent",
        metadata: { token: "x" },
      })
    ).rejects.toThrow(/credential/u);
    await expect(
      repository.record({ ...base, action: "nope" as never, metadata: {} })
    ).rejects.toThrow(/unknown audit action/u);
    await expect(
      repository.record({
        ...base,
        requestId: "  ",
        action: "nautilus.disarm.intent",
        metadata: {},
      })
    ).rejects.toThrow(/requestId/u);
    expect(inserted).toHaveLength(0);
  });

  it("counts recent rows of one action for one actor", async () => {
    const { database, where } = fakeDatabase(3);
    const repository = createNautilusArmAuditRepository(database, {
      now: () => now,
      generateId: () => "x",
    });
    await expect(
      repository.countSince({
        actorUserId: "u1",
        action: "nautilus.arm.password-failed",
        since: now,
      })
    ).resolves.toBe(3);
    expect(where).toHaveBeenCalledTimes(1);
    const empty = createNautilusArmAuditRepository(
      {
        select: () => ({ from: () => ({ where: async () => [] }) }),
      } as unknown as DatabaseExecutor,
      { now: () => now, generateId: () => "x" }
    );
    await expect(
      empty.countSince({
        actorUserId: "u1",
        action: "nautilus.arm.password-failed",
        since: now,
      })
    ).resolves.toBe(0);
  });
});
