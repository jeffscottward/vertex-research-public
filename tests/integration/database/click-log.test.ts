import { uiClickEvents, users } from "@darkfactory/db/schema";
import {
  CLICK_LOG_RETENTION_DAYS,
  type ClickLogInsert,
  createClickLogRepository,
  createNodeDatabase,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const TAB = "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11";
const NOW = new Date("2026-11-03T20:00:00.000Z");

const click = (overrides: Partial<ClickLogInsert> = {}): ClickLogInsert => ({
  buildSha: "abc1234",
  important: false,
  kind: "click",
  label: "Dashboard",
  occurredAt: new Date("2026-11-03T19:00:00.000Z"),
  recordRequestId: "request-1",
  requestIds: [],
  role: "link",
  route: "/assistant",
  tabId: TAB,
  targetRoute: "/dashboard",
  testId: null,
  userId: "user-a",
  ...overrides,
});

describe("click log repository (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
    const at = new Date("2026-01-02T03:04:05.000Z");
    await resource.db.insert(users).values([
      {
        createdAt: at,
        email: "Owner@Example.test",
        emailVerified: true,
        id: "user-a",
        name: "Owner",
        updatedAt: at,
      },
      {
        createdAt: at,
        email: "other@example.test",
        emailVerified: true,
        id: "user-b",
        name: "Other",
        updatedAt: at,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined) {
        await dropPostgresTestDatabase(testDatabase);
      }
    }
  });

  it("stores clicks, reads them by user id or email in time order, and prunes old rows", async () => {
    let id = 0;
    const repository = createClickLogRepository(database(), {
      generateId: () => `click-${(id += 1)}`,
      now: () => NOW,
      retentionDays: CLICK_LOG_RETENTION_DAYS,
    });

    // A row received 15 days ago: the next record call deletes it.
    await database()
      .insert(uiClickEvents)
      .values({
        ...click({
          label: "Old",
          occurredAt: new Date("2026-10-19T12:00:00.000Z"),
        }),
        id: "old",
        receivedAt: new Date(NOW.getTime() - 15 * 86_400_000),
        requestIds: [],
      });

    await expect(
      repository.record([
        click({
          important: true,
          label: "Stop",
          occurredAt: new Date("2026-11-03T19:30:00.000Z"),
          requestIds: ["send-1", "reload-1"],
          role: "button",
          targetRoute: null,
        }),
        click(),
        click({ label: "Backtests", userId: "user-b" }),
      ])
    ).resolves.toBe(3);

    const old = await repository.query({
      from: new Date("2026-10-19T00:00:00.000Z"),
      limit: 10,
      to: new Date("2026-10-20T00:00:00.000Z"),
    });
    expect(old.events).toEqual([]);

    const range = {
      from: new Date("2026-11-03T18:00:00.000Z"),
      limit: 10,
      to: new Date("2026-11-03T20:00:00.000Z"),
    };
    const byEmail = await repository.query({
      ...range,
      user: "owner@example.test",
    });
    expect(byEmail.truncated).toBe(false);
    expect(
      byEmail.events.map((event) => [
        event.label,
        event.userEmail,
        event.requestIds,
      ])
    ).toEqual([
      ["Dashboard", "Owner@Example.test", []],
      ["Stop", "Owner@Example.test", ["send-1", "reload-1"]],
    ]);

    const byId = await repository.query({ ...range, user: "user-b" });
    expect(byId.events.map((event) => event.label)).toEqual(["Backtests"]);

    const everyone = await repository.query({ ...range, limit: 2 });
    expect(everyone.events).toHaveLength(2);
    expect(everyone.truncated).toBe(true);

    const outside = await repository.query({
      ...range,
      to: new Date("2026-11-03T18:30:00.000Z"),
    });
    expect(outside.events).toEqual([]);
  });

  it("rejects rows that break the table checks", async () => {
    const repository = createClickLogRepository(database(), {
      generateId: () => crypto.randomUUID(),
      now: () => NOW,
      retentionDays: CLICK_LOG_RETENTION_DAYS,
    });
    await expect(
      repository.record([click({ label: "x".repeat(81) })])
    ).rejects.toThrow();
  });
});
