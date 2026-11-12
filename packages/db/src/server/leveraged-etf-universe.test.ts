import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { leveragedEtfUniverse } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  createLeveragedEtfUniverseRepository,
  type LeveragedEtfUniverseDocument,
} from "./leveraged-etf-universe.ts";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

type Fund = LeveragedEtfUniverseDocument["funds"][number];

const GENERATED_AT = "2026-11-11T15:30:00Z";
const GATE = {
  bandPct: 10,
  maxHalfSpreadPct: 4,
  maxWindowDays: 21,
  minBandOpenInterest: 1000,
  minWindowDays: 5,
  version: 1,
};
const OPTIONS: NonNullable<Fund["options"]> = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  windowExpiry: "2026-11-20",
};
const WITH_OPTIONS: Fund = {
  leverage: 3,
  listingExchange: "NASDAQ",
  name: "ProShares UltraPro QQQ",
  optionGate: "pass",
  optionGateReasons: [],
  options: OPTIONS,
  optionsListed: true,
  productType: "etf",
  symbol: "TQQQ",
  underlying: "QQQ",
};
const WITHOUT_OPTIONS: Fund = {
  leverage: -2,
  listingExchange: "NYSE ARCA",
  name: "Example 2x Inverse Note",
  optionGate: "fail",
  optionGateReasons: ["no-listed-options"],
  options: null,
  optionsListed: false,
  productType: "etn",
  symbol: "AAAZ",
  underlying: null,
};
const DOCUMENT: LeveragedEtfUniverseDocument = {
  funds: [WITHOUT_OPTIONS, WITH_OPTIONS],
  gate: GATE,
  generatedAt: GENERATED_AT,
};

type Options = Readonly<{
  /** Symbols the delete statement returns. */
  deleted?: readonly string[];
  /** What the insert rejects with, instead of returning its rows. */
  insertError?: unknown;
  /** Rows of the `max(generated_at)` read. */
  newest?: readonly { generatedAt: Date | null }[];
}>;

// A transaction double: it records every statement of the one transaction. A rejected statement
// rejects the transaction, as drizzle rolls back and rethrows.
const createDouble = ({
  deleted = [],
  insertError,
  newest = [{ generatedAt: null }],
}: Options = {}) => {
  const calls = {
    conflicts: [] as { set: Record<string, unknown>; target: unknown }[],
    deleteWhere: [] as unknown[],
    inserts: [] as Record<string, unknown>[][],
    locks: 0,
    transactions: 0,
  };
  const transaction = {
    delete: () => ({
      where: (where: unknown) => {
        calls.deleteWhere.push(where);
        return {
          returning: () =>
            Promise.resolve(deleted.map((symbol) => ({ symbol }))),
        };
      },
    }),
    execute: () => {
      calls.locks += 1;
      return Promise.resolve([]);
    },
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => {
        calls.inserts.push(rows);
        return {
          onConflictDoUpdate: (config: (typeof calls.conflicts)[number]) => {
            calls.conflicts.push(config);
            return {
              returning: () =>
                insertError === undefined
                  ? Promise.resolve(rows.map(({ symbol }) => ({ symbol })))
                  : Promise.reject(insertError),
            };
          },
        };
      },
    }),
    select: () => ({ from: () => Promise.resolve(newest) }),
  };
  const database = {
    transaction: (work: (tx: typeof transaction) => Promise<unknown>) => {
      calls.transactions += 1;
      return work(transaction);
    },
  } as unknown as DatabaseExecutor;
  return { calls, database };
};

const postgresError = (code: string, constraint?: string): Error =>
  Object.assign(new Error("query failed"), { cause: { code, constraint } });

describe("leveraged ETF universe repository", () => {
  it("upserts every fund and deletes the funds that left, in one locked transaction", async () => {
    const double = createDouble({ deleted: ["GONE"] });
    await expect(
      createLeveragedEtfUniverseRepository(double.database).replaceUniverse(
        DOCUMENT
      )
    ).resolves.toEqual({ deleted: 1, upserted: 2 });
    expect(double.calls).toMatchObject({ locks: 1, transactions: 1 });
    expect(double.calls.inserts).toHaveLength(1);
    expect(double.calls.deleteWhere).toHaveLength(1);
    expect(double.calls.deleteWhere[0]).toBeDefined();
  });

  it("flattens a fund with options and the gate constants into one row", async () => {
    const double = createDouble();
    await createLeveragedEtfUniverseRepository(double.database).replaceUniverse(
      DOCUMENT
    );
    expect(double.calls.inserts[0]?.[1]).toEqual({
      bandOpenInterest: 23_456,
      gateBandPct: 10,
      gateMaxHalfSpreadPct: 4,
      gateMaxWindowDays: 21,
      gateMinBandOpenInterest: 1000,
      gateMinWindowDays: 5,
      gateVersion: 1,
      generatedAt: new Date(GENERATED_AT),
      halfSpreadPct: 1.2,
      leverage: 3,
      listingExchange: "NASDAQ",
      name: "ProShares UltraPro QQQ",
      nearestExpiries: ["2026-11-13", "2026-11-20"],
      optionGate: "pass",
      optionGateReasons: [],
      optionsListed: true,
      productType: "etf",
      quotedAt: new Date("2026-11-11T15:20:00Z"),
      quoteSession: "regular",
      spot: 58.65,
      symbol: "TQQQ",
      totalOpenInterest: 123_456,
      underlying: "QQQ",
      windowExpiry: "2026-11-20",
    });
  });

  it("stores null option facts and no expiries for a fund without listed options", async () => {
    const double = createDouble();
    await createLeveragedEtfUniverseRepository(double.database).replaceUniverse(
      DOCUMENT
    );
    expect(double.calls.inserts[0]?.[0]).toMatchObject({
      bandOpenInterest: null,
      halfSpreadPct: null,
      nearestExpiries: [],
      optionGateReasons: ["no-listed-options"],
      optionsListed: false,
      quotedAt: null,
      quoteSession: null,
      spot: null,
      symbol: "AAAZ",
      totalOpenInterest: null,
      underlying: null,
      windowExpiry: null,
    });
  });

  it("replaces every column except the key on a symbol conflict", async () => {
    const double = createDouble();
    await createLeveragedEtfUniverseRepository(double.database).replaceUniverse(
      DOCUMENT
    );
    const conflict = double.calls.conflicts[0];
    expect(conflict?.target).toBe(leveragedEtfUniverse.symbol);
    expect(Object.keys(conflict?.set ?? {}).sort()).toEqual(
      Object.keys(getTableColumns(leveragedEtfUniverse))
        .filter((key) => key !== "symbol")
        .sort()
    );
  });

  it("writes a large universe in several insert statements", async () => {
    const double = createDouble();
    const funds = Array.from({ length: 501 }, (_, index) => ({
      ...WITHOUT_OPTIONS,
      symbol: `F${index}`,
    }));
    await expect(
      createLeveragedEtfUniverseRepository(double.database).replaceUniverse({
        ...DOCUMENT,
        funds,
      })
    ).resolves.toEqual({ deleted: 0, upserted: 501 });
    expect(double.calls.inserts.map((rows) => rows.length)).toEqual([500, 1]);
  });

  it("refuses a document with no funds, a repeated symbol or a broken datetime before any transaction", async () => {
    const double = createDouble();
    const repository = createLeveragedEtfUniverseRepository(double.database);
    const cases: readonly (readonly [LeveragedEtfUniverseDocument, string])[] =
      [
        [
          { ...DOCUMENT, funds: [] },
          "leveraged ETF universe document has no funds",
        ],
        [
          { ...DOCUMENT, funds: [WITH_OPTIONS, WITHOUT_OPTIONS, WITH_OPTIONS] },
          "leveraged ETF universe document lists TQQQ more than once",
        ],
        [
          { ...DOCUMENT, generatedAt: "yesterday" },
          "leveraged ETF universe generatedAt is not a datetime",
        ],
        [
          {
            ...DOCUMENT,
            funds: [
              { ...WITH_OPTIONS, options: { ...OPTIONS, quotedAt: "noon" } },
            ],
          },
          "leveraged ETF universe TQQQ options.quotedAt is not a datetime",
        ],
      ];
    for (const [document, message] of cases)
      await expect(repository.replaceUniverse(document)).rejects.toThrow(
        new InvalidRepositoryInputError(message)
      );
    expect(double.calls.transactions).toBe(0);
  });

  it("refuses a document that is older than the stored universe and writes nothing", async () => {
    const double = createDouble({
      newest: [{ generatedAt: new Date("2026-11-11T15:30:00.001Z") }],
    });
    await expect(
      createLeveragedEtfUniverseRepository(double.database).replaceUniverse(
        DOCUMENT
      )
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "leveraged ETF universe document generated at 2026-11-11T15:30:00.000Z is older than the stored universe (2026-11-11T15:30:00.001Z)"
      )
    );
    expect(double.calls.locks).toBe(1);
    expect(double.calls.inserts).toEqual([]);
    expect(double.calls.deleteWhere).toEqual([]);
  });

  it("accepts a document as new as the stored universe, and an empty table", async () => {
    for (const newest of [[{ generatedAt: new Date(GENERATED_AT) }], []])
      await expect(
        createLeveragedEtfUniverseRepository(
          createDouble({ newest }).database
        ).replaceUniverse(DOCUMENT)
      ).resolves.toEqual({ deleted: 0, upserted: 2 });
  });

  it("names the failed check and reports wrong dates and numbers as input problems", async () => {
    const failing = (insertError: unknown) =>
      createLeveragedEtfUniverseRepository(
        createDouble({ insertError }).database
      ).replaceUniverse(DOCUMENT);
    await expect(
      failing(postgresError("23514", "leveraged_etf_universe_gate_check"))
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "leveraged ETF universe fails leveraged_etf_universe_gate_check"
      )
    );
    await expect(failing(postgresError("23514"))).rejects.toThrow(
      new InvalidRepositoryInputError("leveraged ETF universe fails a check")
    );
    for (const code of ["22007", "22008"])
      await expect(failing(postgresError(code))).rejects.toThrow(
        new InvalidRepositoryInputError(
          "leveraged ETF universe has an invalid date"
        )
      );
    await expect(failing(postgresError("22003"))).rejects.toThrow(
      new InvalidRepositoryInputError(
        "leveraged ETF universe has a number out of range"
      )
    );
  });

  it("maps other database failures and rethrows errors that are not from the database", async () => {
    await expect(
      createLeveragedEtfUniverseRepository(
        createDouble({ insertError: postgresError("57P01") }).database
      ).replaceUniverse(DOCUMENT)
    ).rejects.toThrow(
      new DatabasePersistenceError("leveraged ETF universe replace")
    );
    const plain = new TypeError("bug");
    await expect(
      createLeveragedEtfUniverseRepository(
        createDouble({ insertError: plain }).database
      ).replaceUniverse(DOCUMENT)
    ).rejects.toBe(plain);
  });
});
