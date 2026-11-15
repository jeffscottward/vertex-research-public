// What: Drizzle repository for the operator's options plays (defined-risk research ideas).
// Used by: packages/db/src/server/repositories.ts (createRepositories), packages/api/src/server/plays.ts,
// packages/db/src/seeds/plays.ts.
// See: packages/db/migrations/0050_plays.sql; packages/api/src/contracts/plays.ts; docs/plays.md.
import { desc } from "drizzle-orm";

import {
  PLAY_STATUSES,
  PLAYS_MAX,
  type Play,
  type PlayLeg,
  type PlayStatus,
  plays,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
  requireNonBlank,
} from "./repository-errors.ts";

// Research only: no orders, intents or broker linkage. Options only, defined risk required.

export type { PlayLeg, PlayStatus } from "../schema/index.ts";

export const PLAY_MAX_LEGS = 8;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export type PlayRecord = Readonly<{
  id: string;
  ticker: string;
  structure: string;
  legs: readonly PlayLeg[];
  /** numeric as decimal string, > 0 */
  maxLossUsd: string;
  definedRisk: true;
  thesis: string;
  trigger: string;
  exitRule: string;
  status: PlayStatus;
  notes: string | null;
  sourceUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type UpsertPlayInput = Readonly<{
  id: string;
  ticker: string;
  structure: string;
  legs: readonly PlayLeg[];
  maxLossUsd: number | string;
  thesis: string;
  trigger: string;
  exitRule: string;
  status: PlayStatus;
  notes?: string | null;
  sourceUrl?: string | null;
}>;

export type PlaysRepository = Readonly<{
  /** Newest first (updated_at desc), at most PLAYS_MAX rows. */
  list: () => Promise<PlayRecord[]>;
  /** Server-side writes and seeds only (no API write endpoint). Inserts or updates by id. */
  upsert: (input: UpsertPlayInput) => Promise<PlayRecord>;
}>;

const requireText = (value: string, field: string, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new InvalidRepositoryInputError(
      `${field} must be 1-${max} characters`
    );
  }
  return trimmed;
};

const isValidDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

/**
 * Defined risk: every short option is covered by long options of the same right that expire no
 * earlier. For each right and each short expiry, the long contracts expiring on or after it must be
 * at least the short contracts expiring on or after it. A naked short, or a short covered only by an
 * earlier long, has no defined maximum loss.
 */
const requireCoveredShorts = (legs: readonly PlayLeg[]): void => {
  const contracts = (
    side: PlayLeg["side"],
    right: PlayLeg["right"],
    expiry: string
  ) =>
    legs
      .filter(
        (leg) =>
          leg.side === side && leg.right === right && leg.expiry >= expiry
      )
      .reduce((total, leg) => total + leg.quantity, 0);
  for (const short of legs.filter((leg) => leg.side === "sell")) {
    if (
      contracts("buy", short.right, short.expiry) <
      contracts("sell", short.right, short.expiry)
    ) {
      throw new InvalidRepositoryInputError(
        `short ${short.right} legs must be covered by long ${short.right} legs expiring no earlier (defined risk)`
      );
    }
  }
};

export const validatePlayLegs = (legs: readonly PlayLeg[]): PlayLeg[] => {
  if (legs.length === 0 || legs.length > PLAY_MAX_LEGS) {
    throw new InvalidRepositoryInputError(
      `legs must have 1-${PLAY_MAX_LEGS} entries`
    );
  }
  const checked = legs.map((leg, index) => {
    const at = `legs[${index}]`;
    if (leg.side !== "buy" && leg.side !== "sell") {
      throw new InvalidRepositoryInputError(`${at}.side must be buy or sell`);
    }
    if (leg.right !== "call" && leg.right !== "put") {
      throw new InvalidRepositoryInputError(`${at}.right must be call or put`);
    }
    if (!(Number.isFinite(leg.strike) && leg.strike > 0)) {
      throw new InvalidRepositoryInputError(`${at}.strike must be > 0`);
    }
    if (!isValidDate(leg.expiry)) {
      throw new InvalidRepositoryInputError(
        `${at}.expiry must be a YYYY-MM-DD date`
      );
    }
    if (!(Number.isInteger(leg.quantity) && leg.quantity > 0)) {
      throw new InvalidRepositoryInputError(
        `${at}.quantity must be a positive integer`
      );
    }
    return {
      side: leg.side,
      right: leg.right,
      strike: leg.strike,
      expiry: leg.expiry,
      quantity: leg.quantity,
    };
  });
  requireCoveredShorts(checked);
  return checked;
};

const requireMaxLoss = (value: number | string): string => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !(Number.isFinite(parsed) && parsed > 0) ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new InvalidRepositoryInputError(
      "maxLossUsd must be > 0 (defined risk required)"
    );
  }
  return String(value).trim();
};

const requireOptional = (
  value: string | null | undefined,
  field: string,
  max: number
): string | null => {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max);
};

const requireSourceUrl = (value: string | null | undefined): string | null => {
  const url = requireOptional(value, "sourceUrl", 2000);
  if (url !== null && !url.startsWith("https://")) {
    throw new InvalidRepositoryInputError("sourceUrl must be an https URL");
  }
  return url;
};

const mapPlaysError = (error: unknown): never => {
  if (
    error instanceof InvalidRepositoryInputError ||
    error instanceof DatabasePersistenceError
  ) {
    throw error;
  }
  const details = databaseErrorDetails(error);
  if (details.code === "23514") {
    throw new InvalidRepositoryInputError("play violates a field constraint");
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("plays operation");
  }
  throw error;
};

const toRecord = (row: Play): PlayRecord => ({
  id: row.id,
  ticker: row.ticker,
  structure: row.structure,
  legs: row.legs,
  maxLossUsd: row.maxLossUsd,
  definedRisk: true,
  thesis: row.thesis,
  trigger: row.trigger,
  exitRule: row.exitRule,
  status: row.status,
  notes: row.notes,
  sourceUrl: row.sourceUrl,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Checks and normalizes a play for storage (the rules of `upsert`, without a database): text
 * lengths, ticker, status, legs with covered shorts (defined risk), max loss > 0 and an https source.
 */
export const normalizePlayInput = (input: UpsertPlayInput) => {
  requireNonBlank(input.id, "id");
  const ticker = input.ticker.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker)) {
    throw new InvalidRepositoryInputError("ticker must be a symbol");
  }
  if (!(PLAY_STATUSES as readonly string[]).includes(input.status)) {
    throw new InvalidRepositoryInputError(
      "status must be idea, armed, taken or dropped"
    );
  }
  return {
    ticker,
    structure: requireText(input.structure, "structure", 80),
    legs: validatePlayLegs(input.legs),
    maxLossUsd: requireMaxLoss(input.maxLossUsd),
    definedRisk: true,
    thesis: requireText(input.thesis, "thesis", 2000),
    trigger: requireText(input.trigger, "trigger", 500),
    exitRule: requireText(input.exitRule, "exitRule", 500),
    status: input.status,
    notes: requireOptional(input.notes, "notes", 2000),
    sourceUrl: requireSourceUrl(input.sourceUrl),
  };
};

export const createPlaysRepository = (
  database: DatabaseExecutor,
  repositoryDependencies: Readonly<{ now?: () => Date }> = {}
): PlaysRepository => {
  const now = repositoryDependencies.now ?? (() => new Date());
  return Object.freeze({
    list: async () => {
      try {
        const rows = await database
          .select()
          .from(plays)
          .orderBy(desc(plays.updatedAt), desc(plays.id))
          .limit(PLAYS_MAX);
        return rows.map(toRecord);
      } catch (error) {
        return mapPlaysError(error);
      }
    },

    upsert: async (input) => {
      const values = normalizePlayInput(input);
      try {
        const timestamp = now();
        const [row] = await database
          .insert(plays)
          .values({
            id: input.id,
            ...values,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: plays.id,
            set: { ...values, updatedAt: timestamp },
          })
          .returning();
        if (row === undefined) {
          throw new DatabasePersistenceError("play upsert");
        }
        return toRecord(row);
      } catch (error) {
        return mapPlaysError(error);
      }
    },
  });
};
