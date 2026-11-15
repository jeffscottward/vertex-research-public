import { describe, expect, it } from "vitest";

import { researchStudies } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";
import { createResearchStudyRepository } from "./research-studies.ts";

type Outcome = readonly Record<string, unknown>[] | Error;

const createDouble = (outcome: Outcome) => {
  const calls: Record<string, unknown> = {};
  const settle = () =>
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  const chain = {
    from: (table: unknown) => {
      calls["from"] = table;
      return chain;
    },
    limit: (count: number) => {
      calls["limit"] = count;
      return settle();
    },
    onConflictDoUpdate: (config: unknown) => {
      calls["onConflict"] = config;
      return chain;
    },
    // Awaiting the chain itself (a select that ends at where) settles the outcome.
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected: (reason: unknown) => unknown
    ) => settle().then(onFulfilled, onRejected),
    returning: (columns: unknown) => {
      calls["returning"] = columns;
      return settle();
    },
    values: (values: unknown) => {
      calls["values"] = values;
      return chain;
    },
    where: (where: unknown) => {
      calls["where"] = where;
      return chain;
    },
  };
  const database = {
    insert: (table: unknown) => {
      calls["insert"] = table;
      return chain;
    },
    select: (columns?: unknown) => {
      calls["select"] = columns;
      return chain;
    },
  } as unknown as DatabaseExecutor;
  return { calls, database };
};

const AT = new Date("2026-11-07T12:00:00.000Z");
const LATER = new Date("2026-11-07T12:05:00.000Z");
const RECORD = {
  createdAt: AT,
  id: "adx-rvol-filters",
  ranOn: "2026-10-31",
  specRef: "docs/specs/research/adx-filter.md",
  summary: {
    id: "adx-rvol-filters",
    spec: "docs/specs/research/adx-filter.md",
  },
  updatedAt: AT,
};
const INPUT = {
  id: RECORD.id,
  ranOn: RECORD.ranOn,
  specRef: RECORD.specRef,
  summary: RECORD.summary,
};

const postgresError = (code: string, constraint?: string): Error =>
  Object.assign(new Error("query failed"), {
    cause: { code, constraint },
  });

describe("research study repository", () => {
  it("returns the stored study by id", async () => {
    const double = createDouble([RECORD]);
    const repository = createResearchStudyRepository(double.database);
    await expect(repository.get("adx-rvol-filters")).resolves.toEqual(RECORD);
    expect(double.calls["from"]).toBe(researchStudies);
    expect(double.calls["limit"]).toBe(1);
    expect(double.calls["where"]).toBeDefined();
  });

  it("reads only the id, kind and verdict keys of the requested studies", async () => {
    const rows = [
      { id: "triple-rsi", kind: "strategy-backtest", verdict: "no-edge" },
      { id: "adx-rvol-filters", kind: null, verdict: null },
    ];
    const double = createDouble(rows);
    const repository = createResearchStudyRepository(double.database);
    await expect(
      repository.verdicts(["triple-rsi", "adx-rvol-filters"])
    ).resolves.toEqual(rows);
    expect(Object.keys(double.calls["select"] as object).sort()).toEqual([
      "id",
      "kind",
      "verdict",
    ]);
    expect(double.calls["from"]).toBe(researchStudies);
    expect(double.calls["where"]).toBeDefined();
  });

  it("makes no query for an empty verdict lookup", async () => {
    const double = createDouble(new Error("must not run"));
    const repository = createResearchStudyRepository(double.database);
    await expect(repository.verdicts([])).resolves.toEqual([]);
    expect(double.calls["from"]).toBeUndefined();
  });

  it("maps a database error in the verdict lookup", async () => {
    const repository = createResearchStudyRepository(
      createDouble(postgresError("57P01")).database
    );
    await expect(repository.verdicts(["triple-rsi"])).rejects.toBeInstanceOf(
      DatabasePersistenceError
    );
  });

  it("returns null for an unknown id", async () => {
    const repository = createResearchStudyRepository(createDouble([]).database);
    await expect(repository.get("missing")).resolves.toBeNull();
  });

  it("maps database failures on read and rethrows other errors", async () => {
    await expect(
      createResearchStudyRepository(
        createDouble(postgresError("08006")).database
      ).get("adx-rvol-filters")
    ).rejects.toThrow(DatabasePersistenceError);
    const plain = new TypeError("bug");
    await expect(
      createResearchStudyRepository(createDouble(plain).database).get("x")
    ).rejects.toBe(plain);
  });

  it("inserts a new study and reports it as created", async () => {
    const double = createDouble([
      { createdAt: AT, id: RECORD.id, updatedAt: AT },
    ]);
    const repository = createResearchStudyRepository(double.database);
    await expect(repository.upsert(INPUT)).resolves.toEqual({
      created: true,
      id: RECORD.id,
      updatedAt: AT,
    });
    expect(double.calls["insert"]).toBe(researchStudies);
    expect(double.calls["values"]).toEqual(INPUT);
    expect(double.calls["onConflict"]).toMatchObject({
      set: {
        ranOn: INPUT.ranOn,
        specRef: INPUT.specRef,
        summary: INPUT.summary,
      },
      target: researchStudies.id,
    });
  });

  it("reports a replaced study as not created", async () => {
    const double = createDouble([
      { createdAt: AT, id: RECORD.id, updatedAt: LATER },
    ]);
    await expect(
      createResearchStudyRepository(double.database).upsert(INPUT)
    ).resolves.toMatchObject({ created: false, updatedAt: LATER });
  });

  it("names the failed check, maps other database failures and an empty result", async () => {
    await expect(
      createResearchStudyRepository(
        createDouble(postgresError("23514", "research_studies_summary_check"))
          .database
      ).upsert(INPUT)
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "research study fails research_studies_summary_check"
      )
    );
    await expect(
      createResearchStudyRepository(
        createDouble(postgresError("23514")).database
      ).upsert(INPUT)
    ).rejects.toThrow("research study fails a check");
    await expect(
      createResearchStudyRepository(
        createDouble(postgresError("57P01")).database
      ).upsert(INPUT)
    ).rejects.toThrow(DatabasePersistenceError);
    for (const code of ["22007", "22008"])
      await expect(
        createResearchStudyRepository(
          createDouble(postgresError(code)).database
        ).upsert(INPUT)
      ).rejects.toThrow(
        new InvalidRepositoryInputError("research study has an invalid date")
      );
    await expect(
      createResearchStudyRepository(createDouble([]).database).upsert(INPUT)
    ).rejects.toThrow("Database operation failed: research study write");
  });
});

describe("research study repository upsertMany", () => {
  // A transaction double: each write in the transaction settles with the next outcome; a rejected
  // write rejects the transaction, as drizzle rolls back and rethrows.
  const transactional = (outcomes: readonly Outcome[]) => {
    const written: unknown[] = [];
    let transactions = 0;
    let next = 0;
    const transaction = {
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: () => ({
            returning: () => {
              const outcome = outcomes[next++] as Outcome;
              if (outcome instanceof Error) return Promise.reject(outcome);
              written.push(values);
              return Promise.resolve(outcome);
            },
          }),
        }),
      }),
    };
    const database = {
      transaction: async (
        operation: (executor: typeof transaction) => Promise<unknown>
      ) => {
        transactions += 1;
        return operation(transaction);
      },
    } as unknown as DatabaseExecutor;
    return {
      database,
      transactions: () => transactions,
      written,
    };
  };
  const SECOND = { ...INPUT, id: "qc-opex-week" };

  it("writes every study in one transaction and returns results in input order", async () => {
    const double = transactional([
      [{ createdAt: AT, id: INPUT.id, updatedAt: LATER }],
      [{ createdAt: AT, id: SECOND.id, updatedAt: AT }],
    ]);
    await expect(
      createResearchStudyRepository(double.database).upsertMany([INPUT, SECOND])
    ).resolves.toEqual([
      { created: false, id: INPUT.id, updatedAt: LATER },
      { created: true, id: SECOND.id, updatedAt: AT },
    ]);
    expect(double.transactions()).toBe(1);
    expect(double.written).toEqual([INPUT, SECOND]);
  });

  it("refuses a repeated id before opening a transaction", async () => {
    const double = transactional([]);
    await expect(
      createResearchStudyRepository(double.database).upsertMany([
        INPUT,
        SECOND,
        { ...INPUT, ranOn: "2026-11-01" },
      ])
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "research study adx-rvol-filters appears more than once in one batch"
      )
    );
    expect(double.transactions()).toBe(0);
    expect(double.written).toEqual([]);
  });

  it("opens no transaction for no studies", async () => {
    const double = transactional([]);
    await expect(
      createResearchStudyRepository(double.database).upsertMany([])
    ).resolves.toEqual([]);
    expect(double.transactions()).toBe(0);
  });

  it("maps a failed write in the transaction like a single upsert", async () => {
    await expect(
      createResearchStudyRepository(
        transactional([
          [{ createdAt: AT, id: INPUT.id, updatedAt: AT }],
          postgresError("23514", "research_studies_summary_check"),
        ]).database
      ).upsertMany([INPUT, SECOND])
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "research study fails research_studies_summary_check"
      )
    );
    await expect(
      createResearchStudyRepository(transactional([[]]).database).upsertMany([
        INPUT,
      ])
    ).rejects.toThrow("Database operation failed: research study write");
  });
});
