import { describe, expect, it, vi } from "vitest";

import { createAcademyAuditRepository } from "./academy-audit.ts";
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

describe("academy audit repository", () => {
  it("records an audit row for a deployment request", async () => {
    const { database, inserted } = fakeDatabase(0);
    const repository = createAcademyAuditRepository(database, {
      now: () => now,
      generateId: () => "audit-1",
    });
    await expect(
      repository.record({
        action: "academy.deploy.override",
        actorUserId: "u1",
        deploymentRequestId: "dr-1",
        requestId: "req-1",
        metadata: { brokenRules: ["X03"], explanation: "named X03" },
      })
    ).resolves.toEqual({ id: "audit-1" });
    expect(inserted).toEqual([
      expect.objectContaining({
        id: "audit-1",
        action: "academy.deploy.override",
        entityType: "deployment_request",
        entityId: "dr-1",
        actorUserId: "u1",
        requestId: "req-1",
        createdAt: now,
      }),
    ]);
  });

  it("refuses credential fields, unknown actions and a blank request id", async () => {
    const { database, inserted } = fakeDatabase(0);
    const repository = createAcademyAuditRepository(database, {
      now: () => now,
      generateId: () => "audit-1",
    });
    const base = {
      actorUserId: "u1",
      deploymentRequestId: "dr-1",
      requestId: "req-1",
    };
    await expect(
      repository.record({
        ...base,
        action: "academy.deploy.override",
        metadata: { nested: [{ password: "x" }] },
      })
    ).rejects.toThrow(/credential/u);
    await expect(
      repository.record({
        ...base,
        action: "academy.deploy.override",
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
        action: "academy.deploy.request",
        metadata: {},
      })
    ).rejects.toThrow(/requestId/u);
    expect(inserted).toHaveLength(0);
  });

  it("counts recent rows of one action for one actor", async () => {
    const { database, where } = fakeDatabase(3);
    const repository = createAcademyAuditRepository(database, {
      now: () => now,
      generateId: () => "x",
    });
    await expect(
      repository.countSince({
        actorUserId: "u1",
        action: "academy.deploy.password-failed",
        since: now,
      })
    ).resolves.toBe(3);
    expect(where).toHaveBeenCalledTimes(1);
    const empty = createAcademyAuditRepository(
      {
        select: () => ({ from: () => ({ where: async () => [] }) }),
      } as unknown as DatabaseExecutor,
      { now: () => now, generateId: () => "x" }
    );
    await expect(
      empty.countSince({
        actorUserId: "u1",
        action: "academy.deploy.password-failed",
        since: now,
      })
    ).resolves.toBe(0);
  });
});
