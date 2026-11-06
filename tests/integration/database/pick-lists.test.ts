import {
  baskets,
  pickListMembers,
  pickListSnapshots,
  users,
} from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createPickListRepository,
  type Database,
  type ImportPickListSnapshotInput,
  type PickListMemberRow,
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

const member = (
  symbol: string,
  overrides: Partial<PickListMemberRow> = {}
): PickListMemberRow => ({
  addedOn: null,
  rank: null,
  rating: null,
  sector: null,
  symbol,
  targetPrice: null,
  thesis: null,
  weight: null,
  ...overrides,
});

const snapshot = (
  overrides: Partial<ImportPickListSnapshotInput> = {}
): ImportPickListSnapshotInput => ({
  asOf: "2026-11-01",
  members: [
    member("NVDA", {
      addedOn: "2026-10-01",
      rank: 2,
      rating: "Buy",
      sector: "Technology",
      targetPrice: "212.5",
      thesis: "AI capex",
      weight: "0.25",
    }),
    member("AAPL", { rank: 1 }),
    member("MSFT"),
  ],
  method: "manual",
  name: "Wish list",
  slug: "wishlist",
  source: "wishlist",
  sourceLabel: "Owner wish list",
  userId: "user-a",
  ...overrides,
});

describe("pick list repository (Postgres)", () => {
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
        email: "owner@example.test",
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

  it("upserts lists, replaces same-date snapshots, keeps history and scopes by owner", async () => {
    const repository = createPickListRepository(database());

    const first = await repository.importSnapshot(snapshot());
    expect(first.snapshotCount).toBe(1);
    expect(first.latest.members.map((row) => row.symbol)).toEqual([
      "AAPL",
      "NVDA",
      "MSFT",
    ]);
    expect(first.latest.members[1]).toEqual(
      member("NVDA", {
        addedOn: "2026-10-01",
        rank: 2,
        rating: "Buy",
        sector: "Technology",
        targetPrice: "212.5",
        thesis: "AI capex",
        weight: "0.25",
      })
    );

    // Same date again replaces that snapshot; the label update is kept.
    const replaced = await repository.importSnapshot(
      snapshot({ members: [member("TSLA")], sourceLabel: "My wish list" })
    );
    expect(replaced.list.id).toBe(first.list.id);
    expect(replaced.list.sourceLabel).toBe("My wish list");
    expect(replaced.snapshotCount).toBe(1);
    expect(replaced.latest.members.map((row) => row.symbol)).toEqual(["TSLA"]);

    // An older date adds history but the latest stays the max as-of.
    const older = await repository.importSnapshot(
      snapshot({ asOf: "2026-10-01", method: "adapter" })
    );
    expect(older.snapshotCount).toBe(2);
    expect(older.latest.asOf).toBe("2026-11-01");

    await repository.importSnapshot(
      snapshot({ slug: "growth", name: "Growth picks", source: "newsletter" })
    );
    const listed = await repository.listByUser("user-a");
    expect(
      listed.map((item) => `${item.list.source}/${item.list.slug}`)
    ).toEqual(["newsletter/growth", "wishlist/wishlist"]);
    expect(await repository.listByUser("user-b")).toEqual([]);
    // The agent viewer's read of operator lists: by email, case-insensitive.
    expect(
      (await repository.listByUserEmails([" OWNER@example.test "])).map(
        (item) => `${item.list.userId}/${item.list.slug}`
      )
    ).toEqual(["user-a/growth", "user-a/wishlist"]);
    expect(await repository.listByUserEmails(["other@example.test"])).toEqual(
      []
    );
    expect(await repository.listByUserEmails(["nobody@example.test"])).toEqual(
      []
    );
    expect(await repository.get(first.list.id, "user-b")).toBeNull();

    const at = new Date("2026-11-05T12:00:00.000Z");
    await database().insert(baskets).values({
      createdAt: at,
      id: "basket-wish",
      name: "Wish list",
      symbol: "WISH",
      updatedAt: at,
      userId: "user-a",
    });
    const bucketed = await repository.setBucket(
      first.list.id,
      "user-a",
      "wish",
      "basket-wish"
    );
    expect(bucketed?.list.bucketSymbol).toBe("WISH");
    expect(bucketed?.list.bucketBasketId).toBe("basket-wish");
    expect(
      await repository.setBucket(first.list.id, "user-b", "WISH", "basket-wish")
    ).toBeNull();
    await expect(
      repository.setBucket(first.list.id, "user-a", "WISH", "missing")
    ).rejects.toThrow("does not exist");

    // Deleting the basket clears the link but keeps the symbol.
    await database().delete(baskets);
    const unlinked = await repository.get(first.list.id, "user-a");
    expect(unlinked?.list.bucketBasketId).toBeNull();
    expect(unlinked?.list.bucketSymbol).toBe("WISH");

    // Deleting the owner cascades through snapshots and members.
    await database().delete(users);
    expect(await database().select().from(pickListSnapshots)).toEqual([]);
    expect(await database().select().from(pickListMembers)).toEqual([]);
  });
});
