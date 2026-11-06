// What: Idempotent seeding of named custom baskets for one user, through the basket repository.
// Used by: scripts/baskets/seed.ts (`bun run vertex:baskets:seed`).
// See: packages/db/src/server/basket-repository.ts; research/baskets/owner-baskets.json.
import { eq, sql } from "drizzle-orm";

import { users } from "../schema/index.ts";
import type {
  BasketMemberInput,
  BasketRepository,
} from "./basket-repository.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabaseConflictError,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

// Tracking only: seeding writes basket rows; it never creates orders or broker intents.

export type BasketSeed = Readonly<{
  symbol: string;
  name: string;
  members: readonly BasketMemberInput[];
}>;

export type BasketSeedResult = Readonly<{
  created: string[];
  skipped: string[];
}>;

const WEIGHT_SCALE = 100_000_000;

/**
 * Equal weights as 8-digit decimal strings that sum to exactly 1.
 * The rounding remainder goes to the first members, one unit each.
 */
export const equalBasketWeights = (count: number): string[] => {
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidRepositoryInputError(
      "equal weights need at least 1 member"
    );
  }
  const base = Math.floor(WEIGHT_SCALE / count);
  const remainder = WEIGHT_SCALE - base * count;
  return Array.from({ length: count }, (_, index) => {
    const units = base + (index < remainder ? 1 : 0);
    if (units === WEIGHT_SCALE) return "1";
    return `0.${String(units).padStart(8, "0")}`;
  });
};

/** Returns the id of the user with this email (case-insensitive), or null. */
export const findUserIdByEmail = async (
  database: DatabaseExecutor,
  email: string
): Promise<string | null> => {
  const normalized = email.trim().toLowerCase();
  if (normalized === "") {
    throw new InvalidRepositoryInputError("email is required");
  }
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalized))
    .limit(2);
  if (rows.length > 1) {
    throw new InvalidRepositoryInputError("email matches more than one user");
  }
  return rows[0]?.id ?? null;
};

/**
 * Creates each seed basket the user does not have yet (matched by symbol).
 * Existing baskets are never changed, so the owner's own edits are kept. listByUser returns at
 * most 200 baskets, so a create that conflicts on the symbol also counts as an existing basket.
 */
export const seedUserBaskets = async (
  repository: BasketRepository,
  userId: string,
  seeds: readonly BasketSeed[]
): Promise<BasketSeedResult> => {
  const existing = new Set(
    (await repository.listByUser(userId)).map((entry) => entry.basket.symbol)
  );
  const created: string[] = [];
  const skipped: string[] = [];
  for (const seed of seeds) {
    const symbol = seed.symbol.trim().toUpperCase();
    if (existing.has(symbol)) {
      skipped.push(symbol);
      continue;
    }
    existing.add(symbol);
    try {
      await repository.create({
        members: seed.members,
        name: seed.name,
        symbol,
        userId,
      });
    } catch (error) {
      if (!(error instanceof DatabaseConflictError)) throw error;
      skipped.push(symbol);
      continue;
    }
    created.push(symbol);
  }
  return { created, skipped };
};
