import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { basketMembers, baskets } from "../schema/index.ts";
import {
  createBasketRepository,
  normalizeBasketSymbol,
  validateBasketMembers,
} from "./basket-repository.ts";
import type { Database } from "./client.ts";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
} from "./repositories.ts";

const NOW = new Date("2026-10-23T03:04:05.000Z");
const dialect = new PgDialect();

interface Operation {
  kind: "select" | "insert" | "update" | "delete";
  set?: Record<string, unknown>;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (
  outcomes: Array<readonly Record<string, unknown>[] | Error>
) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      for: () => chain,
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: () => chain,
      orderBy: () => chain,
      returning: () => chain,
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
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
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: (operation: (transaction: unknown) => Promise<unknown>) =>
      operation(database),
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return { database, operations };
};

const repositoryFor = (double: ReturnType<typeof createDouble>) =>
  createBasketRepository(double.database, {
    generateId: () => "basket-1",
    now: () => NOW,
  });

const basketRow = (overrides: Record<string, unknown> = {}) => ({
  baseDate: null,
  baseValue: "100",
  benchmarkBasePrice: null,
  createdAt: NOW,
  id: "basket-1",
  name: "TITY",
  symbol: "TITY",
  updatedAt: NOW,
  userId: "user-a",
  ...overrides,
});
const memberRow = (
  symbol: string,
  overrides: Record<string, unknown> = {}
) => ({
  basePrice: null,
  basketId: "basket-1",
  sharesAtBase: null,
  symbol,
  weight: "0.5",
  ...overrides,
});
const pgError = (code: string) => Object.assign(new Error("pg"), { code });
const members = [
  { symbol: "vsco", weight: "0.5" },
  { symbol: "AVTR", weight: "0.5" },
];

describe("basket validation", () => {
  it("normalizes basket symbols", () => {
    expect(normalizeBasketSymbol(" tity ")).toBe("TITY");
    expect(normalizeBasketSymbol("1AB")).toBeNull();
  });

  it("accepts weights summing to 1 within 1e-6 and rejects the rest", () => {
    expect(
      validateBasketMembers([
        { symbol: "a", weight: "0.33333333" },
        { symbol: "b", weight: "0.33333333" },
        { symbol: "c", weight: "0.33333334" },
      ]).map((member) => member.symbol)
    ).toEqual(["A", "B", "C"]);
    expect(validateBasketMembers([{ symbol: "A", weight: "1" }])).toHaveLength(
      1
    );
    const bad: [Array<{ symbol: string; weight: string }>, RegExp][] = [
      [[], /1 to 50 members/],
      [[{ symbol: "1X", weight: "1" }], /invalid member symbol/],
      [
        [
          { symbol: "A", weight: "0.5" },
          { symbol: "a", weight: "0.5" },
        ],
        /duplicate member/,
      ],
      [[{ symbol: "A", weight: "1e-3" }], /decimal/],
      [[{ symbol: "A", weight: "0" }], /greater than 0/],
      [[{ symbol: "A", weight: "1.5" }], /at most 1/],
      [[{ symbol: "A", weight: "0.9" }], /sum to 1/],
      [
        [
          { symbol: "A", weight: "0.6" },
          { symbol: "B", weight: "0.6" },
        ],
        /sum to 1/,
      ],
    ];
    for (const [input, message] of bad) {
      expect(() => validateBasketMembers(input)).toThrow(message);
    }
  });
});

describe("basket repository", () => {
  it("lists the user's baskets with their members", async () => {
    const double = createDouble([
      [basketRow(), basketRow({ id: "basket-2", symbol: "ZZZ" })],
      [
        memberRow("AVTR"),
        memberRow("VSCO"),
        memberRow("A", { basketId: "basket-2" }),
      ],
    ]);
    const list = await repositoryFor(double).listByUser("user-a");
    expect(
      list.map((entry) => [entry.basket.symbol, entry.members.length])
    ).toEqual([
      ["TITY", 2],
      ["ZZZ", 1],
    ]);
    const query = dialect.sqlToQuery(double.operations[0]?.where as SQL);
    expect(query.sql).toContain('"baskets"."user_id" = $1');
    expect(
      await repositoryFor(createDouble([[]])).listByUser("user-a")
    ).toEqual([]);
    await expect(
      repositoryFor(createDouble([])).listByUser(" ")
    ).rejects.toThrow(InvalidRepositoryInputError);
  });

  it("gets one basket scoped to its owner", async () => {
    const found = await repositoryFor(
      createDouble([[basketRow()], [memberRow("VSCO")]])
    ).get("basket-1", "user-a");
    expect(found?.members.map((member) => member.symbol)).toEqual(["VSCO"]);
    expect(
      await repositoryFor(createDouble([[]])).get("x", "user-a")
    ).toBeNull();
  });

  it("creates a basket and its members in one transaction", async () => {
    const double = createDouble([
      [basketRow()],
      [memberRow("VSCO"), memberRow("AVTR")],
    ]);
    const created = await repositoryFor(double).create({
      members,
      name: "  TITY  ",
      symbol: "tity",
      userId: "user-a",
    });
    expect(created.members.map((member) => member.symbol)).toEqual([
      "AVTR",
      "VSCO",
    ]);
    expect(double.operations[0]).toMatchObject({
      table: baskets,
      values: {
        id: "basket-1",
        name: "TITY",
        symbol: "TITY",
        userId: "user-a",
      },
    });
    expect(double.operations[1]).toMatchObject({
      table: basketMembers,
      values: [
        { basketId: "basket-1", symbol: "VSCO", weight: "0.5" },
        { basketId: "basket-1", symbol: "AVTR", weight: "0.5" },
      ],
    });
  });

  it("defaults to the clock and random ids", async () => {
    const double = createDouble([[basketRow()], [memberRow("VSCO")]]);
    await createBasketRepository(double.database).create({
      members,
      name: "TITY",
      symbol: "TITY",
      userId: "user-a",
    });
    const values = double.operations[0]?.values as {
      id: string;
      createdAt: Date;
    };
    expect(values.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(values.createdAt).toBeInstanceOf(Date);
  });

  it("rejects invalid input and maps database errors on create", async () => {
    const create = (
      double: ReturnType<typeof createDouble>,
      symbol = "TITY",
      name = "TITY"
    ) =>
      repositoryFor(double).create({ members, name, symbol, userId: "user-a" });
    await expect(create(createDouble([]), "1BAD")).rejects.toThrow(
      /basket symbol/
    );
    await expect(create(createDouble([]), "TITY", " ")).rejects.toThrow(
      /name must be/
    );
    await expect(create(createDouble([[]]))).rejects.toThrow(
      DatabasePersistenceError
    );
    await expect(create(createDouble([pgError("23505")]))).rejects.toThrow(
      DatabaseConflictError
    );
    await expect(create(createDouble([pgError("23514")]))).rejects.toThrow(
      InvalidRepositoryInputError
    );
    await expect(create(createDouble([pgError("08006")]))).rejects.toThrow(
      DatabasePersistenceError
    );
    await expect(create(createDouble([new Error("other")]))).rejects.toThrow(
      "other"
    );
  });

  it("renames without touching the base and resets the base when members change", async () => {
    const rename = createDouble([
      [basketRow({ name: "New" })],
      [basketRow({ name: "New" })],
      [],
    ]);
    const renamed = await repositoryFor(rename).update({
      id: "basket-1",
      name: "New",
      userId: "user-a",
    });
    expect(renamed?.basket.name).toBe("New");
    // A rename keeps updatedAt, the membership start of an unfixed base.
    expect(rename.operations[0]?.set).toEqual({ name: "New" });

    const replace = createDouble([
      [basketRow()],
      [],
      [],
      [basketRow()],
      [memberRow("A", { weight: "1" })],
    ]);
    await repositoryFor(replace).update({
      id: "basket-1",
      members: [{ symbol: "a", weight: "1" }],
      userId: "user-a",
    });
    expect(replace.operations[0]?.set).toEqual({
      baseDate: null,
      updatedAt: NOW,
    });
    expect(replace.operations[1]?.kind).toBe("delete");
    expect(replace.operations[2]?.values).toEqual([
      { basketId: "basket-1", symbol: "A", weight: "1" },
    ]);

    expect(
      await repositoryFor(createDouble([[]])).update({
        id: "x",
        name: "N",
        userId: "user-a",
      })
    ).toBeNull();
    await expect(
      repositoryFor(createDouble([])).update({ id: "x", userId: "user-a" })
    ).rejects.toThrow(/name or the members/);
    await expect(
      repositoryFor(createDouble([pgError("23514")])).update({
        id: "x",
        name: "N",
        userId: "user-a",
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
  });

  it("removes only the owner's basket", async () => {
    expect(
      await repositoryFor(createDouble([[{ id: "basket-1" }]])).remove(
        "basket-1",
        "user-a"
      )
    ).toBe(true);
    expect(
      await repositoryFor(createDouble([[]])).remove("basket-1", "user-b")
    ).toBe(false);
    await expect(
      repositoryFor(createDouble([pgError("08006")])).remove(
        "basket-1",
        "user-a"
      )
    ).rejects.toThrow(DatabasePersistenceError);
  });

  it("fixes the base once with base prices and implied shares", async () => {
    const double = createDouble([
      [{ id: "basket-1" }],
      [basketRow()],
      [memberRow("AVTR"), memberRow("VSCO")],
      [{ id: "basket-1" }],
      [],
      [],
      [basketRow({ baseDate: "2026-10-23" })],
      [
        memberRow("AVTR", { basePrice: "10" }),
        memberRow("VSCO", { basePrice: "20" }),
      ],
    ]);
    const fixed = await repositoryFor(double).fixBase({
      baseDate: "2026-10-23",
      benchmarkPrice: "505.25",
      expectedUpdatedAt: NOW,
      id: "basket-1",
      prices: { AVTR: "10", VSCO: "20" },
      userId: "user-a",
    });
    expect(fixed?.basket.baseDate).toBe("2026-10-23");
    expect(double.operations[3]?.set).toEqual({
      baseDate: "2026-10-23",
      benchmarkBasePrice: "505.25",
      updatedAt: NOW,
    });
    expect(double.operations[4]?.set).toEqual({
      basePrice: "10",
      sharesAtBase: "5",
    });
    expect(double.operations[5]?.set).toEqual({
      basePrice: "20",
      sharesAtBase: "2.5",
    });
  });

  it("keeps an existing base, handles races, missing rows and bad input", async () => {
    const input = {
      baseDate: "2026-10-23",
      expectedUpdatedAt: NOW,
      id: "basket-1",
      prices: { VSCO: "20" },
      userId: "user-a",
    };
    const existing = createDouble([
      [{ id: "basket-1" }],
      [basketRow({ baseDate: "2026-10-01" })],
      [memberRow("VSCO")],
    ]);
    expect(
      (await repositoryFor(existing).fixBase(input))?.basket.baseDate
    ).toBe("2026-10-01");
    expect(existing.operations).toHaveLength(3);

    const raced = createDouble([
      [{ id: "basket-1" }],
      [basketRow()],
      [memberRow("VSCO")],
      [],
      [basketRow({ baseDate: "2026-10-22" })],
      [memberRow("VSCO")],
    ]);
    expect((await repositoryFor(raced).fixBase(input))?.basket.baseDate).toBe(
      "2026-10-22"
    );

    // The members changed after the valuation read them: no fix, no update.
    const edited = createDouble([
      [{ id: "basket-1" }],
      [basketRow({ updatedAt: new Date("2026-10-23T05:00:00.000Z") })],
      [memberRow("VSCO")],
    ]);
    const unchanged = await repositoryFor(edited).fixBase(input);
    expect(unchanged?.basket.baseDate).toBeNull();
    expect(edited.operations).toHaveLength(3);

    expect(await repositoryFor(createDouble([[]])).fixBase(input)).toBeNull();
    await expect(
      repositoryFor(
        createDouble([[{ id: "basket-1" }], [basketRow()], [memberRow("AVTR")]])
      ).fixBase(input)
    ).rejects.toThrow(/base price missing for AVTR/);
    await expect(
      repositoryFor(createDouble([])).fixBase({
        ...input,
        baseDate: "23/10/2026",
      })
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      repositoryFor(createDouble([])).fixBase({
        ...input,
        benchmarkPrice: "0",
      })
    ).rejects.toThrow(/benchmark base price/);

    // Without a known benchmark close the base is still fixed; the price stays null.
    const noBenchmark = createDouble([
      [{ id: "basket-1" }],
      [basketRow()],
      [memberRow("VSCO")],
      [{ id: "basket-1" }],
      [],
      [basketRow({ baseDate: "2026-10-23" })],
      [memberRow("VSCO", { basePrice: "20" })],
    ]);
    await repositoryFor(noBenchmark).fixBase({
      ...input,
      benchmarkPrice: null,
    });
    expect(noBenchmark.operations[3]?.set).toMatchObject({
      benchmarkBasePrice: null,
    });
  });

  it("stores a missing benchmark base price once for the current base date", async () => {
    const input = {
      baseDate: "2026-10-23",
      id: "basket-1",
      price: "505.5",
      userId: "user-a",
    };
    const double = createDouble([[{ id: "basket-1" }]]);
    expect(await repositoryFor(double).setBenchmarkBase(input)).toBe(true);
    expect(double.operations[0]?.kind).toBe("update");
    expect(double.operations[0]?.set).toEqual({ benchmarkBasePrice: "505.5" });
    const where = dialect.sqlToQuery(double.operations[0]?.where as SQL);
    expect(where.sql).toContain('"benchmark_base_price" is null');
    expect(where.sql).toContain('"base_date" = $');
    expect(where.params).toEqual(
      expect.arrayContaining(["basket-1", "user-a", "2026-10-23"])
    );

    // Already stored, base moved or basket gone: nothing changes.
    expect(
      await repositoryFor(createDouble([[]])).setBenchmarkBase(input)
    ).toBe(false);
    await expect(
      repositoryFor(createDouble([])).setBenchmarkBase({
        ...input,
        price: "-1",
      })
    ).rejects.toThrow(/benchmark base price/);
    await expect(
      repositoryFor(createDouble([])).setBenchmarkBase({
        ...input,
        baseDate: "2026/10/23",
      })
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      repositoryFor(createDouble([pgError("57P01")])).setBenchmarkBase(input)
    ).rejects.toBeInstanceOf(DatabasePersistenceError);
  });
});

describe("0042_basket_benchmark_base migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0042_basket_benchmark_base.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL(
      "../../rollback/0042_basket_benchmark_base.down.sql",
      import.meta.url
    ),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("adds a nullable positive benchmark base price and is journaled at index 42", () => {
    expect(migration).toContain(
      'ALTER TABLE "baskets" ADD COLUMN "benchmark_base_price" numeric;'
    );
    expect(migration).toContain("baskets_benchmark_base_price_check");
    expect(migration).not.toMatch(/NOT NULL/);
    expect(
      journal.entries.find(
        (entry) => entry.tag === "0042_basket_benchmark_base"
      )
    ).toMatchObject({ idx: 42 });
  });

  it("rollback refuses while benchmark prices exist and never cascades", () => {
    expect(rollback).toContain(
      "baskets has benchmark_base_price data; refusing rollback"
    );
    expect(rollback).toContain('DROP COLUMN "benchmark_base_price"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});

describe("0041_baskets migration", () => {
  const migration = readFileSync(
    new URL("../../migrations/0041_baskets.sql", import.meta.url),
    "utf8"
  );
  const rollback = readFileSync(
    new URL("../../rollback/0041_baskets.down.sql", import.meta.url),
    "utf8"
  );
  const journal = JSON.parse(
    readFileSync(
      new URL("../../migrations/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: Array<{ idx: number; tag: string }> };

  it("creates both tables with checks and is journaled at index 34", () => {
    expect(migration).toContain('CREATE TABLE "baskets"');
    expect(migration).toContain('CREATE TABLE "basket_members"');
    expect(migration).toContain("basket_members_weight_check");
    expect(migration).toContain("ON DELETE cascade");
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "basket_members" TO "vertex_research"'
    );
    expect(
      journal.entries.find((entry) => entry.tag === "0041_baskets")
    ).toMatchObject({
      idx: 41,
      tag: "0041_baskets",
    });
  });

  it("rollback refuses while rows exist and never cascades", () => {
    expect(rollback).toContain(
      "basket tables are not empty; refusing rollback"
    );
    expect(rollback).toContain('DROP TABLE "public"."basket_members"');
    expect(rollback).not.toMatch(/CASCADE|TRUNCATE/i);
  });
});
