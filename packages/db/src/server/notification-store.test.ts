import type {
  NotificationAdmissionInput,
  NotificationScope,
} from "@darkfactory/notifications/server";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import {
  createNotificationStore,
  NotificationStoreError,
  type NotificationStoreOperation,
} from "./notification-store.ts";

// Source-authored unit harness only; no DB connection/migration/provider exists.
const scope: NotificationScope = {
  tenantKey: "tenant-1",
  recipientKey: "recipient-1",
  channel: "phone",
  purpose: "market-alert",
};
const input: NotificationAdmissionInput = {
  scope,
  idempotencyKey: "key-1",
  fingerprint: "a".repeat(64),
  attemptId: "attempt-1",
  now: 1000,
  expiresAt: 10_000,
  cooldownMs: 2000,
  mode: "commit",
};
type CapturedQuery = Readonly<{ sql: string; params: unknown[] }>;
const fixture = (
  respond: (query: CapturedQuery) => Record<string, unknown>[] = () => []
) => {
  const queries: CapturedQuery[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push(compiled);
    return { rows: respond(compiled) };
  });
  const transaction = vi.fn(
    async (
      operation: (tx: { execute: typeof execute }) => Promise<unknown>,
      _configuration?: unknown
    ) => operation({ execute })
  );
  const authorize = vi.fn(
    async (_scope: NotificationScope, _operation: NotificationStoreOperation) =>
      true
  );
  const now = vi.fn(() => 1000);
  const db = { transaction } as unknown as Database;
  const store = createNotificationStore(db, { authorize, clock: { now } });
  return { store, db, queries, execute, transaction, authorize, now };
};
const previous =
  (state: string, fingerprint = input.fingerprint) =>
  (query: CapturedQuery) => {
    return query.sql.startsWith("select fingerprint")
      ? [{ fingerprint, acceptance: state }]
      : [];
  };

// Authored, intentionally not executed until Main's final all-writers gate.
describe("durable NotificationStore", () => {
  it("reserves pending and cross-purpose cooldown in one transaction before admission", async () => {
    const test = fixture();
    expect(await test.store.admit(input)).toEqual({
      status: "admitted",
      attemptId: input.attemptId,
    });
    expect(test.transaction).toHaveBeenCalledTimes(1);
    expect(
      test.queries.map((query) => query.sql.split(" ").slice(0, 3).join(" "))
    ).toEqual([
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      "select fingerprint, acceptance",
      "select cooldown_until_ms from",
      "insert into notification_admissions",
      "insert into notification_cooldowns",
    ]);
    const reservation = test.queries.find((query) =>
      query.sql.startsWith("insert into notification_admissions")
    )!;
    expect(reservation.params).toEqual([
      "tenant-1",
      "recipient-1",
      "phone",
      "market-alert",
      "key-1",
      input.fingerprint,
      "attempt-1",
      1000,
      10_000,
    ]);
    const cooldown = test.queries.find((query) =>
      query.sql.startsWith("insert into notification_cooldowns")
    )!;
    expect(cooldown.params).toEqual([
      "tenant-1",
      "recipient-1",
      "phone",
      1000,
      3000,
    ]);
    return expect(cooldown.sql).not.toContain("purpose");
  });

  it("performs observe in a read-only repeatable snapshot without reservation or lock", async () => {
    const test = fixture();
    expect(await test.store.admit({ ...input, mode: "observe" })).toEqual({
      status: "eligible",
    });
    expect(test.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(test.queries).toHaveLength(2);
    expect(
      test.queries.every(
        (query) =>
          query.sql.startsWith("select ") &&
          !query.sql.includes("advisory") &&
          !query.sql.includes("for update")
      )
    ).toBe(true);
    return expect(
      test.authorize.mock.calls.every((call) => call[1] === "observe")
    ).toBe(true);
  });

  it.each(["pending", "accepted", "rejected", "unknown", "not-sent"])(
    "retains %s admission and deduplicates before cooldown",
    async (state) => {
      const test = fixture(previous(state));
      expect(
        await test.store.admit({ ...input, attemptId: "different-attempt" })
      ).toEqual({ status: "duplicate", acceptance: state });
      expect(
        test.queries.some((query) =>
          query.sql.includes("notification_cooldowns")
        )
      ).toBe(false);
      return expect(
        test.queries.some((query) => query.sql.startsWith("insert"))
      ).toBe(false);
    }
  );

  it("does not recycle a terminal or pending key after request expiry", async () => {
    const test = fixture(previous("unknown"));
    test.now.mockReturnValue(20_000);
    expect(await test.store.admit(input)).toEqual({
      status: "duplicate",
      acceptance: "unknown",
    });
    expect(
      await test.store.admit({
        ...input,
        fingerprint: "b".repeat(64),
        expiresAt: 30_000,
      })
    ).toEqual({ status: "conflict" });
    return expect(
      test.queries.every((query) => !query.sql.startsWith("insert"))
    ).toBe(true);
  });

  it("shares cooldown across purposes but not tenants recipients or channels", async () => {
    const test = fixture((query) =>
      query.sql.startsWith("select cooldown_until_ms")
        ? [{ cooldown_until_ms: "3000" }]
        : []
    );
    expect(
      await test.store.admit({
        ...input,
        scope: { ...scope, purpose: "research-update" },
      })
    ).toEqual({ status: "cooldown" });
    const cooldown = test.queries.find((query) =>
      query.sql.startsWith("select cooldown_until_ms")
    )!;
    expect(cooldown.params).toEqual([
      scope.tenantKey,
      scope.recipientKey,
      scope.channel,
    ]);
    expect(cooldown.sql).not.toContain("purpose");
    return expect(test.queries[0]?.params).toEqual([
      JSON.stringify([
        "notification-admission",
        scope.tenantKey,
        scope.recipientKey,
        scope.channel,
      ]),
    ]);
  });

  it("fails closed before SQL on absent grant and ignores role-looking request data", async () => {
    const test = fixture();
    test.authorize.mockResolvedValue(false);
    await expect(test.store.admit(input)).rejects.toMatchObject({
      code: "denied",
    });
    expect(test.transaction).not.toHaveBeenCalled();
    await expect(
      test.store.admit({ ...input, admin: true } as NotificationAdmissionInput)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("refuses capability construction without clock or scope authorization", () => {
    const test = fixture();
    expect(() => createNotificationStore(test.db, undefined!)).toThrow(
      NotificationStoreError
    );
    return expect(() =>
      createNotificationStore(test.db, {
        authorize: undefined!,
        clock: { now: () => 1000 },
      })
    ).toThrow(NotificationStoreError);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    -1,
    253_402_300_800_000,
    1.5,
  ])("rejects invalid epoch milliseconds %s before SQL", async (now) => {
    const test = fixture();
    await expect(test.store.admit({ ...input, now })).rejects.toMatchObject({
      code: "invalid",
    });
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("rejects unbounded lifetimes cooldowns unknown purposes and credential-shaped keys", async () => {
    const test = fixture();
    for (const change of [
      { cooldownMs: 999 },
      { cooldownMs: 604_800_001 },
      { expiresAt: input.now + 86_400_001 },
      { scope: { ...scope, purpose: "arbitrary" } },
      { idempotencyKey: "https://secret.example/topic" },
      { mode: "commit-now" },
    ]) {
      await expect(
        test.store.admit({ ...input, ...change } as NotificationAdmissionInput)
      ).rejects.toMatchObject({ code: "invalid" });
    }
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("does not invoke accessors or accept caller mutation while authorization awaits", async () => {
    const test = fixture();
    let accessed = false;
    const hostile = { ...input };
    Object.defineProperty(hostile, "scope", {
      enumerable: true,
      get: () => {
        accessed = true;
        return scope;
      },
    });
    await expect(test.store.admit(hostile)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(accessed).toBe(false);
    const mutable = { ...input, scope: { ...scope } };
    test.authorize.mockImplementation(async () => {
      mutable.scope.tenantKey = "other-tenant";
      return true;
    });
    await test.store.admit(mutable);
    return expect(
      test.queries.find((query) =>
        query.sql.startsWith("insert into notification_admissions")
      )?.params[0]
    ).toBe("tenant-1");
  });

  it("re-evaluates trusted time after a queued transaction and cannot admit expired work", async () => {
    const test = fixture();
    test.now.mockReturnValue(10_000);
    expect(await test.store.admit(input)).toEqual({ status: "expired" });
    return expect(
      test.queries.some((query) => query.sql.startsWith("insert"))
    ).toBe(false);
  });

  it("CASes outcome only for exact scope key and admitted attempt without releasing cooldown", async () => {
    const test = fixture((query) => {
      if (query.sql.startsWith("select attempt_id"))
        return [
          {
            attempt_id: "attempt-1",
            acceptance: "pending",
            admitted_at_ms: "1000",
            outcome_at_ms: null,
          },
        ];
      if (query.sql.startsWith("update notification_admissions"))
        return [{ attempt_id: "attempt-1" }];
      return [];
    });
    expect(
      await test.store.recordOutcome({
        scope,
        idempotencyKey: "key-1",
        attemptId: "attempt-1",
        acceptance: "unknown",
        now: 1001,
      })
    ).toEqual({ status: "recorded" });
    const update = test.queries.find((query) =>
      query.sql.startsWith("update")
    )!;
    expect(update.params).toEqual([
      "unknown",
      1001,
      "tenant-1",
      "recipient-1",
      "phone",
      "market-alert",
      "key-1",
      "attempt-1",
    ]);
    expect(update.sql).toContain("acceptance = 'pending'");
    return expect(
      test.queries.every(
        (query) => !query.sql.includes("notification_cooldowns")
      )
    ).toBe(true);
  });

  it.each(["accepted", "rejected", "unknown", "not-sent"])(
    "makes repeated identical %s outcome idempotent but rejects changed outcomes",
    async (state) => {
      const test = fixture((query) =>
        query.sql.startsWith("select attempt_id")
          ? [
              {
                attempt_id: "attempt-1",
                acceptance: state,
                admitted_at_ms: "1000",
                outcome_at_ms: "1001",
              },
            ]
          : []
      );
      const acceptance = state as
        | "accepted"
        | "rejected"
        | "unknown"
        | "not-sent";
      expect(
        await test.store.recordOutcome({
          scope,
          idempotencyKey: "key-1",
          attemptId: "attempt-1",
          acceptance,
          now: 1002,
        })
      ).toEqual({ status: "recorded" });
      expect(
        await test.store.recordOutcome({
          scope,
          idempotencyKey: "key-1",
          attemptId: "attempt-1",
          acceptance: acceptance === "accepted" ? "unknown" : "accepted",
          now: 1002,
        })
      ).toEqual({ status: "stale" });
      return expect(
        test.queries.every((query) => !query.sql.startsWith("update"))
      ).toBe(true);
    }
  );

  it("rejects missing wrong-attempt and preadmission outcome observations", async () => {
    const test = fixture((query) =>
      query.sql.startsWith("select attempt_id")
        ? [
            {
              attempt_id: "attempt-1",
              acceptance: "pending",
              admitted_at_ms: "1000",
              outcome_at_ms: null,
            },
          ]
        : []
    );
    expect(
      await test.store.recordOutcome({
        scope,
        idempotencyKey: "key-1",
        attemptId: "attempt-2",
        acceptance: "accepted",
        now: 1001,
      })
    ).toEqual({ status: "stale" });
    expect(
      await test.store.recordOutcome({
        scope,
        idempotencyKey: "key-1",
        attemptId: "attempt-1",
        acceptance: "accepted",
        now: 999,
      })
    ).toEqual({ status: "stale" });
    return expect(
      test.queries.every((query) => !query.sql.startsWith("update"))
    ).toBe(true);
  });

  return it("sanitizes database exceptions without logging message content or configuration", async () => {
    const test = fixture();
    test.transaction.mockRejectedValue(
      new Error("provider-token-must-not-escape")
    );
    await expect(test.store.admit(input)).rejects.toEqual(
      new NotificationStoreError("unavailable")
    );
    return expect(test.queries).toHaveLength(0);
  });
});
