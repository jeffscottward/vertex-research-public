import { describe, expect, it } from "vitest";

import { vertexOrderSendClaims } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import { createOrderIntentRepository } from "./order-intents.ts";

type Row = Readonly<{
  action: string;
  createdAt: Date;
  entityId: string;
  metadata: Record<string, unknown> | null;
}>;

const fakeDatabase = (rows: Row[]) => {
  const inserted: Record<string, unknown>[] = [];
  const database = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => inserted.push(row),
    }),
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as DatabaseExecutor;
  return { database, inserted };
};

const now = new Date("2026-11-03T12:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const deps = { generateId: () => "row-1", now: () => now };

describe("order intent repository", () => {
  it("writes intent and outcome rows keyed by orderRef", async () => {
    const { database, inserted } = fakeDatabase([]);
    const repository = createOrderIntentRepository(database, deps);
    await repository.recordIntent({
      actorUserId: "u1",
      intent: {
        contract: "AAPL C",
        expiry: "2027-01-15",
        heldBefore: 2,
        orderRef: "leaps-vertex-a",
        right: "C",
        strike: 200,
        symbol: "AAPL",
      },
      requestId: "req-1",
    });
    await repository.recordOutcome({
      action: "vertex.order.result",
      actorUserId: "u1",
      orderRef: "leaps-vertex-a",
      outcome: "unknown",
      requestId: "req-1",
    });
    expect(inserted).toEqual([
      expect.objectContaining({
        action: "vertex.order.intent",
        createdAt: now,
        entityId: "leaps-vertex-a",
        entityType: "vertex_order",
        metadata: {
          contract: "AAPL C",
          expiry: "2027-01-15",
          heldBefore: 2,
          right: "C",
          strike: 200,
          symbol: "AAPL",
        },
      }),
      expect.objectContaining({
        action: "vertex.order.result",
        metadata: { outcome: "unknown" },
      }),
    ]);
  });

  it("refuses a blank request id or orderRef", async () => {
    const repository = createOrderIntentRepository(
      fakeDatabase([]).database,
      deps
    );
    const intent = {
      contract: "X",
      expiry: "2027-01-15",
      heldBefore: 0,
      orderRef: "r",
      right: "C",
      strike: 1,
      symbol: "X",
    };
    await expect(
      repository.recordIntent({ actorUserId: "u", intent, requestId: " " })
    ).rejects.toThrow("requestId");
    return expect(
      repository.recordIntent({
        actorUserId: "u",
        intent: { ...intent, orderRef: "" },
        requestId: "q",
      })
    ).rejects.toThrow("orderRef");
  });

  it("lists intents whose last outcome is missing or unknown", async () => {
    const rows: Row[] = [
      {
        action: "vertex.order.result",
        createdAt: at(1),
        entityId: "b",
        metadata: { outcome: "unknown" },
      },
      {
        action: "vertex.order.intent",
        createdAt: at(0),
        entityId: "a",
        metadata: {
          contract: "A",
          expiry: "2027-01-15",
          heldBefore: 1,
          right: "C",
          strike: 5,
          symbol: "A",
        },
      },
      {
        action: "vertex.order.intent",
        createdAt: at(0),
        entityId: "b",
        metadata: null,
      },
      {
        action: "vertex.order.intent",
        createdAt: at(0),
        entityId: "c",
        metadata: { contract: "C", heldBefore: 0 },
      },
      {
        action: "vertex.order.result",
        createdAt: at(1),
        entityId: "c",
        metadata: { outcome: "unknown" },
      },
      {
        action: "vertex.order.reconciled",
        createdAt: at(2),
        entityId: "c",
        metadata: { outcome: "open" },
      },
      {
        action: "vertex.order.result",
        createdAt: at(3),
        entityId: "d",
        metadata: {},
      },
    ];
    const repository = createOrderIntentRepository(
      fakeDatabase(rows).database,
      deps
    );
    return expect(repository.unresolved(at(-60))).resolves.toEqual([
      {
        contract: "A",
        createdAt: at(0),
        expiry: "2027-01-15",
        heldBefore: 1,
        orderRef: "a",
        right: "C",
        strike: 5,
        symbol: "A",
      },
      {
        contract: "",
        createdAt: at(0),
        expiry: "",
        heldBefore: 0,
        orderRef: "b",
        right: "",
        strike: 0,
        symbol: "",
      },
    ]);
  });

  it("answers whether the last outcome of an orderRef is refused", async () => {
    const rows = (outcomes: [number, string][]) =>
      fakeDatabase([
        {
          action: "vertex.order.intent",
          createdAt: at(0),
          entityId: "vertex-gla",
          metadata: {},
        },
        ...outcomes.map(([minute, outcome]) => ({
          action: "vertex.order.result",
          createdAt: at(minute),
          entityId: "vertex-gla",
          metadata: { outcome },
        })),
      ]).database;
    const refused = (outcomes: [number, string][]) =>
      createOrderIntentRepository(rows(outcomes), deps).refused("vertex-gla");
    expect(await refused([[1, "refused"]])).toBe(true);
    expect(
      await refused([
        [2, "placed"],
        [1, "refused"],
      ])
    ).toBe(false);
    expect(
      await refused([
        [1, "placed"],
        [2, "refused"],
      ])
    ).toBe(true);
    expect(await refused([])).toBe(false);
    // refused, then a new intent (sent again) with no outcome yet: not refused, and unresolved
    const again = fakeDatabase([
      {
        action: "vertex.order.intent",
        createdAt: at(0),
        entityId: "vertex-gla",
        metadata: {},
      },
      {
        action: "vertex.order.result",
        createdAt: at(1),
        entityId: "vertex-gla",
        metadata: { outcome: "refused" },
      },
      {
        action: "vertex.order.intent",
        createdAt: at(2),
        entityId: "vertex-gla",
        metadata: {},
      },
    ]).database;
    expect(
      await createOrderIntentRepository(again, deps).refused("vertex-gla")
    ).toBe(false);
    expect(
      (await createOrderIntentRepository(again, deps).unresolved(at(-5))).map(
        (i) => i.orderRef
      )
    ).toEqual(["vertex-gla"]);
    // Same millisecond, rows in any order: the resend's intent still wins.
    const tie = fakeDatabase([
      {
        action: "vertex.order.intent",
        createdAt: at(1),
        entityId: "vertex-gla",
        metadata: {},
      },
      {
        action: "vertex.order.result",
        createdAt: at(1),
        entityId: "vertex-gla",
        metadata: { outcome: "refused" },
      },
    ]).database;
    expect(
      await createOrderIntentRepository(tie, deps).refused("vertex-gla")
    ).toBe(false);
  });

  it("answers whether any row exists for an orderRef", async () => {
    const limited = (rows: unknown[]) =>
      ({
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => rows }) }),
        }),
      }) as unknown as DatabaseExecutor;
    expect(
      await createOrderIntentRepository(limited([{ id: "r" }]), deps).hasIntent(
        "vertex-gla"
      )
    ).toBe(true);
    expect(
      await createOrderIntentRepository(limited([]), deps).hasIntent(
        "vertex-gla"
      )
    ).toBe(false);
  });

  const row = (
    minute: number,
    action: string,
    outcome?: string,
    entityId = "vertex-gla"
  ): Row => ({
    action,
    createdAt: at(minute),
    entityId,
    metadata: outcome === undefined ? {} : { outcome },
  });
  const INTENT = "vertex.order.intent";
  const RESULT = "vertex.order.result";

  it("reads where the send of each orderRef stands from its last row", async () => {
    const { database } = fakeDatabase([
      row(0, INTENT, undefined, "a"),
      row(0, INTENT, undefined, "b"),
      row(1, RESULT, "placed", "b"),
      row(0, INTENT, undefined, "c"),
      row(1, RESULT, "not-a-known-outcome", "c"),
      row(0, INTENT, undefined, "d"),
      row(1, RESULT, "unknown", "d"),
      row(2, "vertex.order.reconciled", "not-found", "d"),
    ]);
    const states = await createOrderIntentRepository(database, deps).sendStates(
      ["a", "b", "c", "d", "e"]
    );
    expect(Object.fromEntries(states)).toEqual({
      a: "pending",
      b: "placed",
      // An outcome this code does not know may have reached IBKR.
      c: "unknown",
      d: "not-found",
      e: "none",
    });
    // No ref: no query.
    const noQuery = {
      select: () => {
        throw new Error("no query expected");
      },
    } as unknown as DatabaseExecutor;
    expect(
      (await createOrderIntentRepository(noQuery, deps).sendStates([])).size
    ).toBe(0);
  });

  // A database whose transaction runs on the same fake; vertex_order_send_claims keeps its
  // primary key (orderRef, attempt) in `taken`, as another process's claim would.
  const claimDatabase = (rows: Row[], taken = new Set<string>()) => {
    const inserted: Record<string, unknown>[] = [];
    const claims: Record<string, unknown>[] = [];
    const executor = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          if (table !== vertexOrderSendClaims) {
            inserted.push(value);
            return Promise.resolve();
          }
          return {
            onConflictDoNothing: () => ({
              returning: async () => {
                const key = `${String(value["orderRef"])}#${String(value["attempt"])}`;
                if (taken.has(key)) return [];
                taken.add(key);
                claims.push(value);
                return [{ attempt: value["attempt"] }];
              },
            }),
          };
        },
      }),
      select: () => ({ from: () => ({ where: async () => rows }) }),
    };
    const database = {
      ...executor,
      transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
        await operation(executor),
    } as unknown as DatabaseExecutor;
    return { claims, database, inserted, taken };
  };
  const once = (database: DatabaseExecutor, requestId = "req-2") =>
    createOrderIntentRepository(database, deps).recordIntentOnce({
      actorUserId: "owner",
      intent: {
        contract: "SPY combo",
        expiry: "20261218",
        heldBefore: 0,
        orderRef: "vertex-gla",
        right: "C",
        strike: 100,
        symbol: "SPY",
      },
      requestId,
    });

  it("writes the first intent of a ref with its claim, attempt 0", async () => {
    const fake = claimDatabase([]);
    expect(await once(fake.database)).toBe(true);
    expect(fake.claims).toEqual([
      {
        attempt: 0,
        claimedAt: now,
        orderRef: "vertex-gla",
        requestId: "req-2",
      },
    ]);
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: INTENT,
        entityId: "vertex-gla",
        metadata: expect.objectContaining({ contract: "SPY combo" }),
        requestId: "req-2",
      }),
    ]);
  });

  it("refuses, writing nothing, when another send holds the claim", async () => {
    // Two processes read the same rows; the first claim wins the primary key.
    const taken = new Set<string>();
    const first = claimDatabase([], taken);
    const second = claimDatabase([], taken);
    expect(await once(first.database, "req-a")).toBe(true);
    expect(await once(second.database, "req-b")).toBe(false);
    expect(second.claims).toEqual([]);
    expect(second.inserted).toEqual([]);
  });

  it("refuses a ref already sent, and claims the next attempt after each bridge refusal", async () => {
    for (const sent of [
      [row(0, INTENT)],
      [row(0, INTENT), row(1, RESULT, "placed")],
      [row(0, INTENT), row(1, RESULT, "unknown")],
      [
        row(0, INTENT),
        row(1, RESULT, "unknown"),
        row(2, "vertex.order.reconciled", "not-found"),
      ],
      [row(0, INTENT), row(1, RESULT, "refused"), row(2, INTENT)],
    ]) {
      const fake = claimDatabase(sent);
      expect(await once(fake.database)).toBe(false);
      expect(fake.claims).toEqual([]);
      expect(fake.inserted).toEqual([]);
    }
    const refusedTwice = claimDatabase([
      row(0, INTENT),
      row(1, RESULT, "refused"),
      row(2, INTENT),
      row(3, RESULT, "refused"),
    ]);
    expect(await once(refusedTwice.database)).toBe(true);
    expect(refusedTwice.claims).toEqual([
      expect.objectContaining({ attempt: 2 }),
    ]);
    expect(refusedTwice.inserted).toHaveLength(1);
  });

  it("refuses a blank request id or orderRef before any claim", async () => {
    const fake = claimDatabase([]);
    await expect(once(fake.database, " ")).rejects.toThrow(
      "requestId is required"
    );
    await expect(
      createOrderIntentRepository(fake.database, deps).recordIntentOnce({
        actorUserId: "owner",
        intent: {
          contract: "SPY combo",
          expiry: "20261218",
          heldBefore: 0,
          orderRef: " ",
          right: "C",
          strike: 100,
          symbol: "SPY",
        },
        requestId: "req-2",
      })
    ).rejects.toThrow("orderRef is required");
    expect(fake.claims).toEqual([]);
  });
});
