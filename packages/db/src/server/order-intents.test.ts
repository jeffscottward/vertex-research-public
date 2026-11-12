import { describe, expect, it } from "vitest";

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
});
