import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { users } from "../schema/index.ts";
import type {
  BasketRepository,
  BasketWithMembers,
} from "./basket-repository.ts";
import { validateBasketMembers } from "./basket-repository.ts";
import {
  equalBasketWeights,
  findUserIdByEmail,
  seedUserBaskets,
} from "./basket-seed.ts";
import type { Database } from "./client.ts";
import {
  DatabaseConflictError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

const dialect = new PgDialect();

const units = (weight: string) => {
  const [whole = "0", fraction = ""] = weight.split(".");
  return Number(whole) * 100_000_000 + Number(fraction.padEnd(8, "0"));
};

describe("equalBasketWeights", () => {
  it.each([1, 2, 3, 6, 7, 10, 12, 21, 50])(
    "gives %i weights that sum to exactly 1 and pass member validation",
    (count) => {
      const weights = equalBasketWeights(count);
      expect(weights).toHaveLength(count);
      expect(weights.reduce((sum, weight) => sum + units(weight), 0)).toBe(
        100_000_000
      );
      const spread = weights.map(units);
      expect(Math.max(...spread) - Math.min(...spread)).toBeLessThanOrEqual(1);
      expect(() =>
        validateBasketMembers(
          weights.map((weight, index) => ({
            symbol: `S${String(index).padStart(2, "0")}`,
            weight,
          }))
        )
      ).not.toThrow();
    }
  );

  it("formats thirds with the remainder on the first member", () => {
    expect(equalBasketWeights(3)).toEqual([
      "0.33333334",
      "0.33333333",
      "0.33333333",
    ]);
    expect(equalBasketWeights(1)).toEqual(["1"]);
  });

  it("rejects counts below 1", () => {
    expect(() => equalBasketWeights(0)).toThrow(InvalidRepositoryInputError);
    expect(() => equalBasketWeights(1.5)).toThrow(InvalidRepositoryInputError);
  });
});

const lookupDouble = (rows: readonly Record<string, unknown>[]) => {
  const captured: { table?: unknown; where?: SQL } = {};
  const chain: Record<string, unknown> = {
    from: (table: unknown) => {
      captured.table = table;
      return chain;
    },
    limit: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
    where: (condition: SQL) => {
      captured.where = condition;
      return chain;
    },
  };
  const database = { select: () => chain } as unknown as Database;
  return { captured, database };
};

describe("findUserIdByEmail", () => {
  it("matches the lower-cased, trimmed email on the user table", async () => {
    const double = lookupDouble([{ id: "user-a" }]);
    await expect(
      findUserIdByEmail(double.database, "  Owner@Example.TEST ")
    ).resolves.toBe("user-a");
    expect(double.captured.table).toBe(users);
    const query = dialect.sqlToQuery(double.captured.where as SQL);
    expect(query.sql).toContain('lower("user"."email")');
    expect(query.params).toEqual(["owner@example.test"]);
  });

  it("returns null when no user matches", async () => {
    await expect(
      findUserIdByEmail(lookupDouble([]).database, "x@example.test")
    ).resolves.toBeNull();
  });

  it("refuses a blank email and an ambiguous match", async () => {
    await expect(
      findUserIdByEmail(lookupDouble([]).database, "  ")
    ).rejects.toThrow(InvalidRepositoryInputError);
    await expect(
      findUserIdByEmail(
        lookupDouble([{ id: "a" }, { id: "b" }]).database,
        "x@example.test"
      )
    ).rejects.toThrow("more than one user");
  });
});

const existing = (symbol: string) =>
  ({ basket: { symbol }, members: [] }) as unknown as BasketWithMembers;

describe("seedUserBaskets", () => {
  const seeds = [
    {
      members: [{ symbol: "VSCO", weight: "1" }],
      name: "TITY",
      symbol: "TITY",
    },
    {
      members: [{ symbol: "CAKE", weight: "1" }],
      name: "Unique winners 1y",
      symbol: "uw1y",
    },
  ];

  it("creates only the baskets the user does not have and keeps existing ones", async () => {
    const create = vi.fn(async () => existing("NEW"));
    const repository = {
      create,
      listByUser: vi.fn(async () => [existing("TITY")]),
    } as unknown as BasketRepository;
    await expect(seedUserBaskets(repository, "user-a", seeds)).resolves.toEqual(
      { created: ["UW1Y"], skipped: ["TITY"] }
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      members: [{ symbol: "CAKE", weight: "1" }],
      name: "Unique winners 1y",
      symbol: "UW1Y",
      userId: "user-a",
    });
  });

  it("stops on the first create error", async () => {
    const repository = {
      create: vi.fn(async () => {
        throw new InvalidRepositoryInputError("bad");
      }),
      listByUser: vi.fn(async () => []),
    } as unknown as BasketRepository;
    await expect(seedUserBaskets(repository, "user-a", seeds)).rejects.toThrow(
      "bad"
    );
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it("skips a seed whose symbol exists beyond the listed baskets", async () => {
    // listByUser returns at most 200 baskets, so an existing seed basket can be missing from it.
    const create = vi.fn(async (input: { symbol: string }) => {
      if (input.symbol === "TITY") throw new DatabaseConflictError("basket");
      return existing(input.symbol);
    });
    const repository = {
      create,
      listByUser: vi.fn(async () => []),
    } as unknown as BasketRepository;
    await expect(seedUserBaskets(repository, "user-a", seeds)).resolves.toEqual(
      { created: ["UW1Y"], skipped: ["TITY"] }
    );
    expect(create).toHaveBeenCalledTimes(2);
  });
});
