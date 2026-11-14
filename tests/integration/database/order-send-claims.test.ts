import { readFileSync } from "node:fs";

import { users, vertexOrderSendClaims } from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createOrderIntentRepository,
  type Database,
  type OrderIntentRepository,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Once-only send of a go-live orderRef across web processes (card vertex-golive-exec-intake):
// concurrent sends of one ref on separate connections, as two web processes would run them.

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const migrationSql = read(
  "../../../packages/db/migrations/0071_vertex_order_send_claims.sql"
);
const rollbackSql = read(
  "../../../packages/db/rollback/0071_vertex_order_send_claims.down.sql"
);

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};
const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const REF = "vertex-gl0123456789abcdef0123456789ab";
const CONCURRENT = 8;
let id = 0;
let clock = new Date("2026-11-13T15:00:00.000Z");
const repository = (): OrderIntentRepository =>
  createOrderIntentRepository(database(), {
    generateId: () => {
      id += 1;
      return `row-${id}`;
    },
    now: () => clock,
  });

const sendOnce = (requestId: string) =>
  repository().recordIntentOnce({
    actorUserId: "owner",
    intent: {
      contract: "SPY 20261218 100/105 call debit",
      expiry: "20261218",
      heldBefore: 0,
      orderRef: REF,
      right: "C",
      strike: 100,
      symbol: "SPY",
    },
    requestId,
  });

// Every send starts at once; each runs its own transaction on its own pooled connection.
const race = async (round: string): Promise<boolean[]> =>
  await Promise.all(
    Array.from({ length: CONCURRENT }, (_, index) =>
      sendOnce(`${round}-${index}`)
    )
  );

const outcome = async (value: "refused" | "placed") => {
  clock = new Date(clock.getTime() + 60_000);
  await repository().recordOutcome({
    action: "vertex.order.result",
    actorUserId: "owner",
    orderRef: REF,
    outcome: value,
    requestId: `outcome-${value}`,
  });
  clock = new Date(clock.getTime() + 60_000);
};

describe("order send claims (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: CONCURRENT,
    });
    await migrate(resource.db);
    const at = new Date("2026-01-02T03:04:05.000Z");
    await resource.db.insert(users).values({
      createdAt: at,
      email: "owner@example.test",
      emailVerified: true,
      id: "owner",
      name: "Owner",
      updatedAt: at,
    });
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

  it("lets exactly one of concurrent sends of a ref through, again after each bridge refusal, never after a placement", async () => {
    const claims = async () =>
      (
        await database()
          .select({
            attempt: vertexOrderSendClaims.attempt,
            orderRef: vertexOrderSendClaims.orderRef,
          })
          .from(vertexOrderSendClaims)
      )
        .filter((claim) => claim.orderRef === REF)
        .map((claim) => `${claim.orderRef}#${claim.attempt}`)
        .sort();

    const first = await race("first");
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(await claims()).toEqual([`${REF}#0`]);
    expect((await repository().sendStates([REF])).get(REF)).toBe("pending");

    // The bridge refused it before IBKR: the draft may be sent again, once.
    await outcome("refused");
    expect((await repository().sendStates([REF])).get(REF)).toBe("refused");
    const second = await race("second");
    expect(second.filter(Boolean)).toHaveLength(1);
    expect(await claims()).toEqual([`${REF}#0`, `${REF}#1`]);

    // Placed: no send of the ref gets through any more.
    await outcome("placed");
    expect(await race("third")).toEqual(
      Array.from({ length: CONCURRENT }, () => false)
    );
    expect(await claims()).toEqual([`${REF}#0`, `${REF}#1`]);
    expect((await repository().sendStates([REF])).get(REF)).toBe("placed");
  });

  it("refuses a claim another process holds even when the audit rows say nothing was sent", async () => {
    // A claim row with no intent row (a process that holds it right now) wins the primary key.
    const other = "vertex-gl0000000000000000000000000000";
    await database().insert(vertexOrderSendClaims).values({
      attempt: 0,
      claimedAt: clock,
      orderRef: other,
      requestId: "other-process",
    });
    expect(
      await repository().recordIntentOnce({
        actorUserId: "owner",
        intent: {
          contract: "QQQ combo",
          expiry: "20261218",
          heldBefore: 0,
          orderRef: other,
          right: "C",
          strike: 600,
          symbol: "QQQ",
        },
        requestId: "late",
      })
    ).toBe(false);
    expect((await repository().sendStates([other])).get(other)).toBe("none");
  });
  return it("refuses the rollback while a claim has no outcome, then drops only the table", async () => {
    const claimsTable = async () =>
      (
        await postgres().query<{ name: string }>(
          "select table_name as name from information_schema.tables where table_schema = 'public' and table_name = 'vertex_order_send_claims'"
        )
      ).length;
    // The claim of the test above has no intent and no outcome row: a send in flight.
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
    await postgres().query("ROLLBACK");
    expect(await claimsTable()).toBe(1);

    await repository().recordOutcome({
      action: "vertex.order.reconciled",
      actorUserId: "owner",
      orderRef: "vertex-gl0000000000000000000000000000",
      outcome: "not-found",
      requestId: "reconcile-other",
    });
    await postgres().query(rollbackSql);
    expect(await claimsTable()).toBe(0);
    const [intents] = await postgres().query<{ n: number }>(
      "select count(*)::int as n from audit_records where entity_type = 'vertex_order'"
    );
    expect(intents?.n).toBeGreaterThan(0);
    await postgres().query(migrationSql);
    expect(await claimsTable()).toBe(1);
  });
});
