import { users } from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createPriceAlertRepository,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The scheduler tick reads only rules whose owner is still an operator. The unit tests check
// the SQL shape; this suite runs the owner join and the round-robin order on real Postgres.

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

let clock = new Date("2026-10-13T14:00:00.000Z");
let next = 0;
const dependencies = {
  generateId: () => {
    next += 1;
    return `alert-${next}`;
  },
  now: () => clock,
};

const owner = (
  id: string,
  email: string,
  overrides: Partial<typeof users.$inferInsert> = {}
): typeof users.$inferInsert => ({
  email,
  emailVerified: true,
  id,
  name: id,
  status: "active",
  ...overrides,
});

describe("price alert rules on real Postgres", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(databaseResource.db);
    return await databaseResource.db.insert(users).values([
      owner("operator", "Owner@Domain.test"),
      owner("member", "member@domain.test"),
      owner("unverified", "unverified@domain.test", {
        emailVerified: false,
      }),
      owner("suspended", "suspended@domain.test", { status: "suspended" }),
    ]);
  }, 60_000);

  afterAll(async () => {
    try {
      if (databaseResource !== undefined) return await databaseResource.close();
      return;
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("lists only operator owners' active rules, least recently attempted first", async () => {
    const rules = createPriceAlertRepository(databaseResource.db, dependencies);
    const create = (userId: string, symbol: string) =>
      rules.create({
        kind: "above",
        level: "100",
        note: null,
        role: "price",
        symbol,
        userId,
      });
    const first = await create("operator", "AAPL");
    clock = new Date("2026-10-13T14:01:00.000Z");
    const second = await create("operator", "KO");
    for (const userId of ["member", "unverified", "suspended"])
      await create(userId, "BAC");
    const emails = [" owner@domain.TEST ", "unverified@domain.test"];
    const listed = async () =>
      (await rules.listActive(50, [...emails, "suspended@domain.test"])).map(
        (rule) => rule.id
      );

    expect(await listed()).toEqual([first.id, second.id]);
    expect(await rules.listActive(50, [])).toEqual([]);
    expect(await rules.listActive(50, undefined)).toEqual([]);

    // A failed quote moves the rule to the back; a check does the same and sets its window.
    clock = new Date("2026-10-13T14:05:00.000Z");
    await rules.markAttempted([first.id]);
    expect(await listed()).toEqual([second.id, first.id]);
    clock = new Date("2026-10-13T14:10:00.000Z");
    await rules.markChecked([second.id], clock);
    expect(await listed()).toEqual([first.id, second.id]);
    expect(
      (await rules.listActiveByUser("operator")).map((rule) => rule.id)
    ).toEqual([first.id, second.id]);

    // A triggered rule leaves the active list.
    await rules.trigger({
      id: first.id,
      triggeredAt: clock,
      triggerPrice: "101",
    });
    return expect(await listed()).toEqual([second.id]);
  });
});
