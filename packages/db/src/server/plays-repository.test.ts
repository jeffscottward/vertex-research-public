import { describe, expect, it } from "vitest";

import { PLAYS_MAX, type Play, plays } from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createPlaysRepository,
  PLAY_MAX_LEGS,
  type PlayLeg,
  type UpsertPlayInput,
  validatePlayLegs,
} from "./plays-repository.ts";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");

interface Operation {
  kind: "select" | "insert";
  conflict?: { set: Record<string, unknown>; target: unknown };
  limit?: number;
  orderBy?: unknown[];
  table?: unknown;
  values?: Record<string, unknown>;
}

interface Double {
  database: Database;
  operations: Operation[];
}

const createDouble = (outcomes: Array<readonly unknown[] | Error>): Double => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (value: number) => {
        operation.limit = value;
        return chain;
      },
      onConflictDoUpdate: (conflict: NonNullable<Operation["conflict"]>) => {
        operation.conflict = conflict;
        return chain;
      },
      orderBy: (...columns: unknown[]) => {
        operation.orderBy = columns;
        return chain;
      },
      returning: () => chain,
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const outcome = outcomes.shift() ?? [];
        return (
          outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome)
        ).then(resolve, reject);
      },
      values: (values: Record<string, unknown>) => {
        operation.values = values;
        return chain;
      },
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
  } as unknown as Database;
  return { database, operations };
};

const pgError = (code: string) => Object.assign(new Error("pg"), { code });

const LEGS: PlayLeg[] = [
  {
    side: "buy",
    right: "call",
    strike: 100,
    expiry: "2027-01-15",
    quantity: 1,
  },
  {
    side: "sell",
    right: "call",
    strike: 110,
    expiry: "2027-01-15",
    quantity: 1,
  },
];

const input = (overrides: Partial<UpsertPlayInput> = {}): UpsertPlayInput => ({
  id: "play-1",
  ticker: "zzzt",
  structure: " call debit spread ",
  legs: LEGS,
  maxLossUsd: 250,
  thesis: "Fake thesis",
  trigger: "Fake trigger",
  exitRule: "Fake exit",
  status: "idea",
  ...overrides,
});

const row = (overrides: Partial<Play> = {}): Play => ({
  id: "play-1",
  ticker: "ZZZT",
  structure: "call debit spread",
  legs: LEGS,
  maxLossUsd: "250",
  definedRisk: true,
  thesis: "Fake thesis",
  trigger: "Fake trigger",
  exitRule: "Fake exit",
  status: "idea",
  notes: null,
  sourceUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const repositoryFor = (double: Double) =>
  createPlaysRepository(double.database, { now: () => NOW });

describe("plays repository", () => {
  it("lists newest first, capped at PLAYS_MAX, with definedRisk true", async () => {
    const double = createDouble([[row(), row({ id: "play-2" })]]);
    const listed = await repositoryFor(double).list();
    expect(listed.map((play) => play.id)).toEqual(["play-1", "play-2"]);
    expect(listed[0]).toMatchObject({ definedRisk: true, maxLossUsd: "250" });
    expect(double.operations[0]).toMatchObject({
      kind: "select",
      limit: PLAYS_MAX,
      table: plays,
    });
    expect(double.operations[0]?.orderBy).toHaveLength(2);
  });

  it("upserts by id with normalized fields and the clock", async () => {
    const double = createDouble([
      [row({ notes: "n", sourceUrl: "https://x.test" })],
    ]);
    const saved = await repositoryFor(double).upsert(
      input({ notes: " n ", sourceUrl: "https://x.test" })
    );
    expect(saved).toMatchObject({ notes: "n", sourceUrl: "https://x.test" });
    const operation = double.operations[0];
    expect(operation?.values).toMatchObject({
      id: "play-1",
      ticker: "ZZZT",
      structure: "call debit spread",
      maxLossUsd: "250",
      definedRisk: true,
      notes: "n",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(operation?.conflict?.target).toBe(plays.id);
    expect(operation?.conflict?.set).toMatchObject({ updatedAt: NOW });
    expect(operation?.conflict?.set).not.toHaveProperty("createdAt");
  });

  it("defaults the clock and accepts a decimal-string max loss", async () => {
    const double = createDouble([[row()]]);
    await createPlaysRepository(double.database).upsert(
      input({ maxLossUsd: " 12.5 ", notes: null })
    );
    expect(double.operations[0]?.values).toMatchObject({
      maxLossUsd: "12.5",
      notes: null,
      sourceUrl: null,
    });
    expect(double.operations[0]?.values?.["createdAt"]).toBeInstanceOf(Date);
  });

  it.each([
    [{ id: " " }, "id"],
    [{ ticker: "bad ticker" }, "ticker must be a symbol"],
    [{ status: "open" as never }, "status must be"],
    [{ structure: " " }, "structure must be 1-80"],
    [{ thesis: "x".repeat(2001) }, "thesis must be 1-2000"],
    [{ trigger: "" }, "trigger must be"],
    [{ exitRule: "" }, "exitRule must be"],
    [{ maxLossUsd: 0 }, "maxLossUsd must be > 0"],
    [{ maxLossUsd: -5 }, "maxLossUsd must be > 0"],
    [{ maxLossUsd: "" }, "maxLossUsd must be > 0"],
    [{ maxLossUsd: "abc" }, "maxLossUsd must be > 0"],
    [{ maxLossUsd: Number.POSITIVE_INFINITY }, "maxLossUsd must be > 0"],
    [{ notes: "" }, "notes must be"],
    [{ sourceUrl: "http://x.test" }, "sourceUrl must be an https URL"],
    [{ legs: [] }, "legs must have"],
  ])("rejects %o before touching the database", async (overrides, message) => {
    const double = createDouble([]);
    await expect(
      repositoryFor(double).upsert(input(overrides))
    ).rejects.toThrow(message);
    expect(double.operations).toHaveLength(0);
  });

  it("maps a check violation, other pg errors and rethrows unknown errors", async () => {
    await expect(
      repositoryFor(createDouble([pgError("23514")])).upsert(input())
    ).rejects.toThrow(InvalidRepositoryInputError);
    await expect(
      repositoryFor(createDouble([pgError("57P01")])).list()
    ).rejects.toThrow(DatabasePersistenceError);
    const plain = new Error("boom");
    await expect(repositoryFor(createDouble([plain])).list()).rejects.toBe(
      plain
    );
  });

  it("fails when the upsert returns no row", async () => {
    await expect(
      repositoryFor(createDouble([[]])).upsert(input())
    ).rejects.toThrow(DatabasePersistenceError);
  });
});

describe("validatePlayLegs", () => {
  const leg = (overrides: Partial<PlayLeg>): PlayLeg[] => [
    { ...LEGS[0], ...overrides } as PlayLeg,
  ];

  it("copies only the leg fields", () => {
    const extra = [{ ...LEGS[0], note: "x" } as PlayLeg];
    expect(validatePlayLegs(extra)).toEqual([LEGS[0]]);
  });

  it.each([
    [leg({ side: "short" as never }), "side must be buy or sell"],
    [leg({ right: "stock" as never }), "right must be call or put"],
    [leg({ strike: 0 }), "strike must be > 0"],
    [leg({ strike: Number.NaN }), "strike must be > 0"],
    [leg({ expiry: "2027-1-15" }), "expiry must be a YYYY-MM-DD date"],
    [leg({ expiry: "2027-02-30" }), "expiry must be a YYYY-MM-DD date"],
    [leg({ quantity: 0 }), "quantity must be a positive integer"],
    [leg({ quantity: 1.5 }), "quantity must be a positive integer"],
    [
      Array.from({ length: PLAY_MAX_LEGS + 1 }, () => LEGS[0] as PlayLeg),
      "legs must have",
    ],
  ])("rejects invalid legs (%#)", (legs, message) => {
    expect(() => validatePlayLegs(legs)).toThrow(message);
  });
});
