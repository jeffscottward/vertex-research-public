// What: Drizzle repository for private per-user custom baskets ("fake ETFs") and their members.
// Used by: packages/db/src/server/repositories.ts (createRepositories), packages/api/src/server/baskets.ts.
// See: packages/db/migrations/0041_baskets.sql; packages/api/src/contracts/baskets.ts.
import { and as andWhere, asc, eq, inArray, isNull } from "drizzle-orm";

import {
  BASKET_MAX_MEMBERS,
  BASKET_NAME_MAX_LENGTH,
  BASKET_SYMBOL_PATTERN,
  type Basket,
  type BasketMember,
  basketMembers,
  baskets,
  WATCHLIST_SYMBOL_PATTERN,
} from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
  type RepositoryDependencies,
  requireNonBlank,
} from "./repository-errors.ts";

// Tracking only: no orders, intents, held quantities or broker linkage.

export type BasketWithMembers = Readonly<{
  basket: Basket;
  members: BasketMember[];
}>;

export type BasketMemberInput = Readonly<{
  symbol: string;
  // Decimal string, 0 < weight <= 1, at most 8 fractional digits.
  weight: string;
}>;

export type CreateBasketInput = Readonly<{
  userId: string;
  symbol: string;
  name: string;
  members: readonly BasketMemberInput[];
}>;

export type UpdateBasketInput = Readonly<{
  id: string;
  userId: string;
  name?: string;
  // Replacing members clears the fixed base; it is fixed again at the next full session close.
  members?: readonly BasketMemberInput[];
}>;

export type FixBasketBaseInput = Readonly<{
  id: string;
  userId: string;
  // updatedAt of the basket the valuation read; a member change since then cancels the fix.
  expectedUpdatedAt: Date;
  baseDate: string;
  // Close on baseDate per member symbol, decimal string > 0.
  prices: Readonly<Record<string, string>>;
  // Benchmark (SPY) close on baseDate, decimal string > 0; null or absent when unknown.
  benchmarkPrice?: string | null;
}>;

export type SetBasketBenchmarkBaseInput = Readonly<{
  id: string;
  userId: string;
  // Must equal the stored base date; a different or cleared base is left alone.
  baseDate: string;
  // Benchmark (SPY) close on baseDate, decimal string > 0.
  price: string;
}>;

export type BasketRepository = Readonly<{
  listByUser: (userId: string) => Promise<BasketWithMembers[]>;
  get: (id: string, userId: string) => Promise<BasketWithMembers | null>;
  create: (input: CreateBasketInput) => Promise<BasketWithMembers>;
  update: (input: UpdateBasketInput) => Promise<BasketWithMembers | null>;
  remove: (id: string, userId: string) => Promise<boolean>;
  // Sets the base only while it is still open; returns null when the basket is missing.
  fixBase: (input: FixBasketBaseInput) => Promise<BasketWithMembers | null>;
  // Stores the benchmark close of an already fixed base once (bases fixed before it was kept).
  // Returns false when nothing changed.
  setBenchmarkBase: (input: SetBasketBenchmarkBaseInput) => Promise<boolean>;
}>;

const MAX_BASKETS_LISTED = 200;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SCALE = 100_000_000n;
// Weights must sum to 1 within 1e-6 (equal thirds stored as 0.33333333 are accepted).
const WEIGHT_SUM_TOLERANCE = 100n;

const scaled = (value: string): bigint => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(8, "0"));
};

export const normalizeBasketSymbol = (value: string): string | null => {
  const symbol = value.trim().toUpperCase();
  return BASKET_SYMBOL_PATTERN.test(symbol) ? symbol : null;
};

const validateName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > BASKET_NAME_MAX_LENGTH) {
    throw new InvalidRepositoryInputError(
      `name must be 1 to ${BASKET_NAME_MAX_LENGTH} characters`
    );
  }
  return trimmed;
};

export const validateBasketMembers = (
  members: readonly BasketMemberInput[]
): BasketMemberInput[] => {
  if (members.length === 0 || members.length > BASKET_MAX_MEMBERS) {
    throw new InvalidRepositoryInputError(
      `a basket needs 1 to ${BASKET_MAX_MEMBERS} members`
    );
  }
  const seen = new Set<string>();
  let sum = 0n;
  const normalized: BasketMemberInput[] = [];
  for (const member of members) {
    const symbol = member.symbol.trim().toUpperCase();
    if (!WATCHLIST_SYMBOL_PATTERN.test(symbol)) {
      throw new InvalidRepositoryInputError(
        `invalid member symbol: ${member.symbol.trim().slice(0, 16)}`
      );
    }
    if (seen.has(symbol)) {
      throw new InvalidRepositoryInputError(`duplicate member: ${symbol}`);
    }
    seen.add(symbol);
    const weight = member.weight.trim();
    if (!DECIMAL_PATTERN.test(weight)) {
      throw new InvalidRepositoryInputError(
        `weight for ${symbol} must be a decimal with at most 8 fractional digits`
      );
    }
    const value = scaled(weight);
    if (value <= 0n || value > SCALE) {
      throw new InvalidRepositoryInputError(
        `weight for ${symbol} must be greater than 0 and at most 1`
      );
    }
    sum += value;
    normalized.push({ symbol, weight });
  }
  const difference = sum > SCALE ? sum - SCALE : SCALE - sum;
  if (difference > WEIGHT_SUM_TOLERANCE) {
    throw new InvalidRepositoryInputError("weights must sum to 1");
  }
  return normalized;
};

const mapBasketMutationError = (error: unknown): never => {
  if (error instanceof InvalidRepositoryInputError) throw error;
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError("basket violates a field constraint");
  }
  if (details.code === "23505") throw new DatabaseConflictError("basket");
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("basket mutation");
  }
  throw error;
};

// A fixed base is never replaced, and a valuation of an older membership never fixes one.
const keepsCurrentBase = (
  current: BasketWithMembers,
  input: FixBasketBaseInput
): boolean =>
  current.basket.baseDate !== null ||
  current.basket.updatedAt.getTime() !== input.expectedUpdatedAt.getTime();

const requireBasePrices = (
  current: BasketWithMembers,
  input: FixBasketBaseInput
): void => {
  for (const member of current.members) {
    const price = input.prices[member.symbol];
    if (price === undefined || !(Number(price) > 0)) {
      throw new InvalidRepositoryInputError(
        `base price missing for ${member.symbol}`
      );
    }
  }
};

const formatDecimal = (value: number): string => {
  // 10 significant digits is enough for a tracked share count; strip trailing zeros.
  return String(Number(value.toPrecision(10)));
};

const requireBaseDate = (value: string): void => {
  if (!DATE_PATTERN.test(value)) {
    throw new InvalidRepositoryInputError("baseDate must be YYYY-MM-DD");
  }
};

const benchmarkDecimal = (value: string): string => {
  const price = Number(value);
  if (!(Number.isFinite(price) && price > 0)) {
    throw new InvalidRepositoryInputError(
      "benchmark base price must be greater than 0"
    );
  }
  return formatDecimal(price);
};

export const createBasketRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): BasketRepository => {
  const now = repositoryDependencies.now ?? (() => new Date());
  const generateId =
    repositoryDependencies.generateId ?? (() => crypto.randomUUID());

  const membersOf = async (
    executor: DatabaseExecutor,
    ids: readonly string[]
  ): Promise<BasketMember[]> => {
    if (ids.length === 0) return [];
    return await executor
      .select()
      .from(basketMembers)
      .where(inArray(basketMembers.basketId, [...ids]))
      .orderBy(asc(basketMembers.basketId), asc(basketMembers.symbol));
  };

  const load = async (
    executor: DatabaseExecutor,
    id: string,
    userId: string
  ): Promise<BasketWithMembers | null> => {
    const [basket] = await executor
      .select()
      .from(baskets)
      .where(andWhere(eq(baskets.id, id), eq(baskets.userId, userId)))
      .limit(1);
    if (basket === undefined) return null;
    return { basket, members: await membersOf(executor, [basket.id]) };
  };

  return {
    listByUser: async (userId) => {
      requireNonBlank(userId, "userId");
      const rows = await database
        .select()
        .from(baskets)
        .where(eq(baskets.userId, userId))
        .orderBy(asc(baskets.symbol))
        .limit(MAX_BASKETS_LISTED);
      const members = await membersOf(
        database,
        rows.map((row) => row.id)
      );
      return rows.map((basket) => ({
        basket,
        members: members.filter((member) => member.basketId === basket.id),
      }));
    },

    get: async (id, userId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      return await load(database, id, userId);
    },

    create: async (input) => {
      requireNonBlank(input.userId, "userId");
      const symbol = normalizeBasketSymbol(input.symbol);
      if (symbol === null) {
        throw new InvalidRepositoryInputError(
          "basket symbol must be 1 to 10 letters or digits, starting with a letter"
        );
      }
      const name = validateName(input.name);
      const members = validateBasketMembers(input.members);
      try {
        return await withTransaction(database, async (transaction) => {
          const timestamp = now();
          const id = generateId();
          const [basket] = await transaction
            .insert(baskets)
            .values({
              id,
              userId: input.userId,
              symbol,
              name,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning();
          if (basket === undefined) {
            throw new DatabasePersistenceError("basket insert");
          }
          const inserted = await transaction
            .insert(basketMembers)
            .values(members.map((member) => ({ basketId: id, ...member })))
            .returning();
          return {
            basket,
            members: inserted.sort((a, b) => a.symbol.localeCompare(b.symbol)),
          };
        });
      } catch (error) {
        return mapBasketMutationError(error);
      }
    },

    update: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      if (input.name === undefined && input.members === undefined) {
        throw new InvalidRepositoryInputError(
          "basket update must change the name or the members"
        );
      }
      const name =
        input.name === undefined ? undefined : validateName(input.name);
      const members =
        input.members === undefined
          ? undefined
          : validateBasketMembers(input.members);
      try {
        return await withTransaction(database, async (transaction) => {
          const [basket] = await transaction
            .update(baskets)
            .set({
              ...(name === undefined ? {} : { name }),
              // updatedAt marks the membership start while the base is unfixed, so only a
              // member change moves it; a rename keeps the pending base date.
              ...(members === undefined
                ? {}
                : { baseDate: null, updatedAt: now() }),
            })
            .where(
              andWhere(
                eq(baskets.id, input.id),
                eq(baskets.userId, input.userId)
              )
            )
            .returning();
          if (basket === undefined) return null;
          if (members !== undefined) {
            await transaction
              .delete(basketMembers)
              .where(eq(basketMembers.basketId, basket.id));
            await transaction
              .insert(basketMembers)
              .values(
                members.map((member) => ({ basketId: basket.id, ...member }))
              );
          }
          return await load(transaction, basket.id, input.userId);
        });
      } catch (error) {
        return mapBasketMutationError(error);
      }
    },

    remove: async (id, userId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      try {
        const removed = await database
          .delete(baskets)
          .where(andWhere(eq(baskets.id, id), eq(baskets.userId, userId)))
          .returning({ id: baskets.id });
        return removed.length > 0;
      } catch (error) {
        return mapBasketMutationError(error);
      }
    },

    fixBase: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      requireBaseDate(input.baseDate);
      const benchmarkBasePrice =
        input.benchmarkPrice === undefined || input.benchmarkPrice === null
          ? null
          : benchmarkDecimal(input.benchmarkPrice);
      try {
        return await withTransaction(database, async (transaction) => {
          // Lock the basket row so a concurrent member replacement cannot interleave.
          const [locked] = await transaction
            .select({ id: baskets.id })
            .from(baskets)
            .where(
              andWhere(
                eq(baskets.id, input.id),
                eq(baskets.userId, input.userId)
              )
            )
            .for("update");
          if (locked === undefined) return null;
          const current = (await load(
            transaction,
            input.id,
            input.userId
          )) as BasketWithMembers;
          if (keepsCurrentBase(current, input)) return current;
          requireBasePrices(current, input);
          const baseValue = Number(current.basket.baseValue);
          const [fixed] = await transaction
            .update(baskets)
            .set({
              baseDate: input.baseDate,
              benchmarkBasePrice,
              updatedAt: now(),
            })
            .where(andWhere(eq(baskets.id, input.id), isNull(baskets.baseDate)))
            .returning({ id: baskets.id });
          // A concurrent request fixed it first; keep that base.
          if (fixed === undefined) {
            return await load(transaction, input.id, input.userId);
          }
          for (const member of current.members) {
            const price = Number(input.prices[member.symbol]);
            await transaction
              .update(basketMembers)
              .set({
                basePrice: formatDecimal(price),
                sharesAtBase: formatDecimal(
                  (Number(member.weight) * baseValue) / price
                ),
              })
              .where(
                andWhere(
                  eq(basketMembers.basketId, input.id),
                  eq(basketMembers.symbol, member.symbol)
                )
              );
          }
          return await load(transaction, input.id, input.userId);
        });
      } catch (error) {
        return mapBasketMutationError(error);
      }
    },

    setBenchmarkBase: async (input) => {
      requireNonBlank(input.id, "id");
      requireNonBlank(input.userId, "userId");
      requireBaseDate(input.baseDate);
      const benchmarkBasePrice = benchmarkDecimal(input.price);
      try {
        // The base is already fixed, so updatedAt (the membership start) is not moved.
        const updated = await database
          .update(baskets)
          .set({ benchmarkBasePrice })
          .where(
            andWhere(
              eq(baskets.id, input.id),
              eq(baskets.userId, input.userId),
              eq(baskets.baseDate, input.baseDate),
              isNull(baskets.benchmarkBasePrice)
            )
          )
          .returning({ id: baskets.id });
        return updated.length > 0;
      } catch (error) {
        return mapBasketMutationError(error);
      }
    },
  };
};
