// What: Drizzle repository for dated pick-list snapshots (external stock-pick lists with provenance).
// Used by: packages/db/src/server/repositories.ts (createRepositories), packages/api/src/server/pick-lists.ts.
// See: packages/db/migrations/0048_pick_lists.sql; packages/api/src/contracts/pick-lists.ts.
import { and as andWhere, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  BASKET_SYMBOL_PATTERN,
  PICK_LIST_IMPORT_METHODS,
  PICK_LIST_MAX_MEMBERS,
  PICK_LIST_NAME_MAX_LENGTH,
  PICK_LIST_SLUG_PATTERN,
  type PickList,
  pickListMembers,
  pickListSnapshots,
  pickLists,
  users,
  WATCHLIST_SYMBOL_PATTERN,
} from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
  type RepositoryDependencies,
  requireNonBlank,
} from "./repositories.ts";

// Research only: no orders, intents or broker linkage.

export type PickListImportMethod = (typeof PICK_LIST_IMPORT_METHODS)[number];

export type PickListMemberRow = Readonly<{
  symbol: string;
  rank: number | null;
  /** numeric as decimal string */
  weight: string | null;
  sector: string | null;
  rating: string | null;
  thesis: string | null;
  /** decimal string */
  targetPrice: string | null;
  /** YYYY-MM-DD */
  addedOn: string | null;
}>;

export type PickListRecord = Readonly<{
  id: string;
  userId: string;
  source: string;
  sourceLabel: string;
  slug: string;
  name: string;
  bucketSymbol: string | null;
  /** Basket the list was last synced into; null once that basket is deleted. */
  bucketBasketId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PickListSnapshotRecord = Readonly<{
  id: string;
  pickListId: string;
  asOf: string;
  method: PickListImportMethod;
  importedAt: Date;
  /** ordered: rank asc nulls last, then symbol */
  members: PickListMemberRow[];
}>;

export type PickListWithLatest = Readonly<{
  list: PickListRecord;
  latest: PickListSnapshotRecord;
  snapshotCount: number;
}>;

export type ImportPickListSnapshotInput = Readonly<{
  userId: string;
  source: string;
  sourceLabel: string;
  slug: string;
  name: string;
  asOf: string;
  method: PickListImportMethod;
  members: readonly PickListMemberRow[];
}>;

export type PickListRepository = Readonly<{
  /**
   * Upserts the list (userId, source, slug), updating sourceLabel/name, then replaces the snapshot
   * with the same asOf in one transaction. Returns the list with its latest snapshot (max asOf).
   */
  importSnapshot: (
    input: ImportPickListSnapshotInput
  ) => Promise<PickListWithLatest>;
  /** Lists ordered by source, slug; capped at 200. */
  listByUser: (userId: string) => Promise<PickListWithLatest[]>;
  /**
   * Lists of every user whose email (case-insensitive) is given, ordered by source, slug; capped
   * at 200. Read-only. Used for the agent viewer's read of the operator buckets (owner decision
   * 2026-11-05, card vertex-bucket-buy-proposal). No emails, or no matching user, gives [].
   */
  listByUserEmails: (
    emails: readonly string[] | undefined
  ) => Promise<PickListWithLatest[]>;
  get: (id: string, userId: string) => Promise<PickListWithLatest | null>;
  /** Sets bucket_symbol and bucket_basket_id; null when the list is missing for that user. */
  setBucket: (
    id: string,
    userId: string,
    bucketSymbol: string,
    basketId: string
  ) => Promise<PickListWithLatest | null>;
}>;

const MAX_PICK_LISTS_LISTED = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const WEIGHT_PATTERN = /^(0|1)(\.[0-9]{1,8})?$/u;
const PRICE_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/u;
const SECTOR_MAX = 60;
const RATING_MAX = 40;
const THESIS_MAX = 2000;

const requireSlug = (value: string, field: string): string => {
  if (!PICK_LIST_SLUG_PATTERN.test(value)) {
    throw new InvalidRepositoryInputError(
      `${field} must be 1 to 40 lowercase letters, digits or dashes`
    );
  }
  return value;
};

const requireLabel = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PICK_LIST_NAME_MAX_LENGTH) {
    throw new InvalidRepositoryInputError(
      `${field} must be 1 to ${PICK_LIST_NAME_MAX_LENGTH} characters`
    );
  }
  return trimmed;
};

const isCalendarDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const requireDate = (value: string, field: string): string => {
  if (!isCalendarDate(value)) {
    throw new InvalidRepositoryInputError(`${field} must be a YYYY-MM-DD date`);
  }
  return value;
};

const optionalText = (
  value: string | null,
  max: number,
  field: string
): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new InvalidRepositoryInputError(
      `${field} must be at most ${max} characters`
    );
  }
  return trimmed;
};

const validateMember = (member: PickListMemberRow): PickListMemberRow => {
  const symbol = member.symbol.trim().toUpperCase();
  if (!WATCHLIST_SYMBOL_PATTERN.test(symbol)) {
    throw new InvalidRepositoryInputError(
      `invalid member symbol: ${member.symbol.trim().slice(0, 16)}`
    );
  }
  if (
    member.rank !== null &&
    (!Number.isInteger(member.rank) || member.rank < 1 || member.rank > 1000)
  ) {
    throw new InvalidRepositoryInputError(
      `rank for ${symbol} must be an integer from 1 to 1000`
    );
  }
  const weight = member.weight?.trim() ?? null;
  if (weight !== null && (!WEIGHT_PATTERN.test(weight) || Number(weight) > 1)) {
    throw new InvalidRepositoryInputError(
      `weight for ${symbol} must be a decimal from 0 to 1 with at most 8 fractional digits`
    );
  }
  const targetPrice = member.targetPrice?.trim() ?? null;
  if (
    targetPrice !== null &&
    (!PRICE_PATTERN.test(targetPrice) || Number(targetPrice) <= 0)
  ) {
    throw new InvalidRepositoryInputError(
      `target price for ${symbol} must be a positive decimal with at most 4 fractional digits`
    );
  }
  return {
    symbol,
    rank: member.rank,
    weight,
    sector: optionalText(member.sector, SECTOR_MAX, "sector"),
    rating: optionalText(member.rating, RATING_MAX, "rating"),
    thesis: optionalText(member.thesis, THESIS_MAX, "thesis"),
    targetPrice,
    addedOn:
      member.addedOn === null ? null : requireDate(member.addedOn, "addedOn"),
  };
};

export const validatePickListMembers = (
  members: readonly PickListMemberRow[]
): PickListMemberRow[] => {
  if (members.length === 0 || members.length > PICK_LIST_MAX_MEMBERS) {
    throw new InvalidRepositoryInputError(
      `a pick list snapshot needs 1 to ${PICK_LIST_MAX_MEMBERS} members`
    );
  }
  const seen = new Set<string>();
  return members.map((member) => {
    const normalized = validateMember(member);
    if (seen.has(normalized.symbol)) {
      throw new InvalidRepositoryInputError(
        `duplicate member: ${normalized.symbol}`
      );
    }
    seen.add(normalized.symbol);
    return normalized;
  });
};

/** Rank ascending with nulls last, then symbol. */
export const comparePickListMembers = (
  a: PickListMemberRow,
  b: PickListMemberRow
): number => {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
};

const isImportMethod = (value: string): value is PickListImportMethod =>
  (PICK_LIST_IMPORT_METHODS as readonly string[]).includes(value);

const mapPickListError = (error: unknown): never => {
  if (
    error instanceof InvalidRepositoryInputError ||
    error instanceof DatabasePersistenceError
  ) {
    throw error;
  }
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError(
      "pick list violates a field constraint"
    );
  }
  if (details.code === "23503") {
    throw new InvalidRepositoryInputError(
      "pick list owner or bucket basket does not exist"
    );
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("pick list operation");
  }
  throw error;
};

const toRecord = (row: PickList): PickListRecord => ({
  id: row.id,
  userId: row.userId,
  source: row.source,
  sourceLabel: row.sourceLabel,
  slug: row.slug,
  name: row.name,
  bucketSymbol: row.bucketSymbol,
  bucketBasketId: row.bucketBasketId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createPickListRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: RepositoryDependencies = {}
): PickListRepository => {
  const now = repositoryDependencies.now ?? (() => new Date());
  const generateId =
    repositoryDependencies.generateId ?? (() => crypto.randomUUID());

  const withLatest = async (
    executor: DatabaseExecutor,
    rows: readonly PickList[]
  ): Promise<PickListWithLatest[]> => {
    if (rows.length === 0) return [];
    const snapshots = await executor
      .select()
      .from(pickListSnapshots)
      .where(
        inArray(
          pickListSnapshots.pickListId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(asc(pickListSnapshots.pickListId), desc(pickListSnapshots.asOf));
    const latestByList = new Map<
      string,
      { snapshot: (typeof snapshots)[number]; count: number }
    >();
    for (const snapshot of snapshots) {
      const current = latestByList.get(snapshot.pickListId);
      if (current === undefined) {
        latestByList.set(snapshot.pickListId, { snapshot, count: 1 });
      } else {
        current.count += 1;
        if (snapshot.asOf > current.snapshot.asOf) current.snapshot = snapshot;
      }
    }
    const latestIds = [...latestByList.values()].map(
      (entry) => entry.snapshot.id
    );
    const memberRows =
      latestIds.length === 0
        ? []
        : await executor
            .select()
            .from(pickListMembers)
            .where(inArray(pickListMembers.snapshotId, latestIds))
            .orderBy(
              asc(pickListMembers.snapshotId),
              asc(pickListMembers.rank),
              asc(pickListMembers.symbol)
            );
    const result: PickListWithLatest[] = [];
    for (const row of rows) {
      const entry = latestByList.get(row.id);
      // A list always gets a snapshot in the same transaction; skip a torn read defensively.
      if (entry === undefined) continue;
      const { snapshot } = entry;
      if (!isImportMethod(snapshot.method)) {
        throw new DatabasePersistenceError("pick list snapshot method");
      }
      const members = memberRows
        .filter((member) => member.snapshotId === snapshot.id)
        .map(
          (member): PickListMemberRow => ({
            symbol: member.symbol,
            rank: member.rank,
            weight: member.weight,
            sector: member.sector,
            rating: member.rating,
            thesis: member.thesis,
            targetPrice: member.targetPrice,
            addedOn: member.addedOn,
          })
        )
        .sort(comparePickListMembers);
      result.push({
        list: toRecord(row),
        latest: {
          id: snapshot.id,
          pickListId: snapshot.pickListId,
          asOf: snapshot.asOf,
          method: snapshot.method,
          importedAt: snapshot.importedAt,
          members,
        },
        snapshotCount: entry.count,
      });
    }
    return result;
  };

  const loadOne = async (
    executor: DatabaseExecutor,
    id: string,
    userId: string
  ): Promise<PickListWithLatest | null> => {
    const rows = await executor
      .select()
      .from(pickLists)
      .where(andWhere(eq(pickLists.id, id), eq(pickLists.userId, userId)))
      .limit(1);
    const [loaded] = await withLatest(executor, rows);
    return loaded ?? null;
  };

  return {
    importSnapshot: async (input) => {
      requireNonBlank(input.userId, "userId");
      const source = requireSlug(input.source, "source");
      const slug = requireSlug(input.slug, "slug");
      const sourceLabel = requireLabel(input.sourceLabel, "sourceLabel");
      const name = requireLabel(input.name, "name");
      const asOf = requireDate(input.asOf, "asOf");
      if (!isImportMethod(input.method)) {
        throw new InvalidRepositoryInputError(
          "method must be manual or adapter"
        );
      }
      const method = input.method;
      const members = validatePickListMembers(input.members);
      try {
        return await withTransaction(database, async (transaction) => {
          const timestamp = now();
          const [list] = await transaction
            .insert(pickLists)
            .values({
              id: generateId(),
              userId: input.userId,
              source,
              sourceLabel,
              slug,
              name,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: [pickLists.userId, pickLists.source, pickLists.slug],
              set: { sourceLabel, name, updatedAt: timestamp },
            })
            .returning();
          if (list === undefined) {
            throw new DatabasePersistenceError("pick list upsert");
          }
          await transaction
            .delete(pickListSnapshots)
            .where(
              andWhere(
                eq(pickListSnapshots.pickListId, list.id),
                eq(pickListSnapshots.asOf, asOf)
              )
            );
          const snapshotId = generateId();
          await transaction.insert(pickListSnapshots).values({
            id: snapshotId,
            pickListId: list.id,
            asOf,
            method,
            importedAt: timestamp,
          });
          await transaction
            .insert(pickListMembers)
            .values(members.map((member) => ({ snapshotId, ...member })));
          const [loaded] = await withLatest(transaction, [list]);
          if (loaded === undefined) {
            throw new DatabasePersistenceError("pick list snapshot read");
          }
          return loaded;
        });
      } catch (error) {
        return mapPickListError(error);
      }
    },

    listByUser: async (userId) => {
      requireNonBlank(userId, "userId");
      try {
        const rows = await database
          .select()
          .from(pickLists)
          .where(eq(pickLists.userId, userId))
          .orderBy(asc(pickLists.source), asc(pickLists.slug))
          .limit(MAX_PICK_LISTS_LISTED);
        return await withLatest(database, rows);
      } catch (error) {
        return mapPickListError(error);
      }
    },

    listByUserEmails: async (emails) => {
      const normalized = [
        ...new Set(
          (emails ?? [])
            .map((email) => email.trim().toLowerCase())
            .filter((email) => email !== "")
        ),
      ];
      if (normalized.length === 0) return [];
      try {
        const owners = await database
          .select({ id: users.id })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, normalized));
        if (owners.length === 0) return [];
        const rows = await database
          .select()
          .from(pickLists)
          .where(
            inArray(
              pickLists.userId,
              owners.map((owner) => owner.id)
            )
          )
          .orderBy(asc(pickLists.source), asc(pickLists.slug))
          .limit(MAX_PICK_LISTS_LISTED);
        return await withLatest(database, rows);
      } catch (error) {
        return mapPickListError(error);
      }
    },

    get: async (id, userId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      try {
        return await loadOne(database, id, userId);
      } catch (error) {
        return mapPickListError(error);
      }
    },

    setBucket: async (id, userId, bucketSymbol, basketId) => {
      requireNonBlank(id, "id");
      requireNonBlank(userId, "userId");
      requireNonBlank(basketId, "basketId");
      const symbol = bucketSymbol.trim().toUpperCase();
      if (!BASKET_SYMBOL_PATTERN.test(symbol)) {
        throw new InvalidRepositoryInputError(
          "bucket symbol must be 1 to 10 letters or digits, starting with a letter"
        );
      }
      try {
        return await withTransaction(database, async (transaction) => {
          const updated = await transaction
            .update(pickLists)
            .set({
              bucketSymbol: symbol,
              bucketBasketId: basketId,
              updatedAt: now(),
            })
            .where(andWhere(eq(pickLists.id, id), eq(pickLists.userId, userId)))
            .returning({ id: pickLists.id });
          if (updated.length === 0) return null;
          return await loadOne(transaction, id, userId);
        });
      } catch (error) {
        return mapPickListError(error);
      }
    },
  };
};
