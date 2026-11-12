// What: Drizzle repository for the leveraged ETF universe (one row per fund).
// Used by: packages/db/src/server/repositories.ts (createRepositories) and
// scripts/leveraged-etf-universe/import.ts (`bun run vertex:leveraged-etf-universe:import`).
// See: packages/db/migrations/0067_leveraged_etf_universe.sql;
// docs/vertex-rebuild/leveraged-etf-universe.md.
// The repository stores the document as given. The caller validates it first with
// LeveragedEtfUniverseDocumentSchema (scripts/leveraged-etf-universe/document.ts); the table checks
// catch the cheap invariants again. Research records only: nothing here places an order.
import { getTableColumns, max, notInArray, sql } from "drizzle-orm";

import {
  type LeveragedEtfOptionGate,
  type LeveragedEtfOptionGateReason,
  type LeveragedEtfProductType,
  type LeveragedEtfQuoteSession,
  leveragedEtfUniverse,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

/** The parts of a `leveraged-etf-universe-v1` document that the table stores. */
export type LeveragedEtfUniverseDocument = Readonly<{
  /** UTC ISO datetime of the document. Stored on every row as `generated_at`. */
  generatedAt: string;
  gate: Readonly<{
    version: number;
    minWindowDays: number;
    maxWindowDays: number;
    bandPct: number;
    minBandOpenInterest: number;
    maxHalfSpreadPct: number;
  }>;
  funds: readonly Readonly<{
    symbol: string;
    name: string;
    productType: LeveragedEtfProductType;
    leverage: number;
    underlying: string | null;
    listingExchange: string;
    optionsListed: boolean;
    /** Null exactly when `optionsListed` is false. */
    options: Readonly<{
      quotedAt: string;
      session: LeveragedEtfQuoteSession;
      spot: number;
      nearestExpiries: readonly string[];
      windowExpiry: string | null;
      totalOpenInterest: number;
      bandOpenInterest: number | null;
      halfSpreadPct: number | null;
    }> | null;
    optionGate: LeveragedEtfOptionGate;
    optionGateReasons: readonly LeveragedEtfOptionGateReason[];
  }>[];
}>;

export type LeveragedEtfUniverseReplaceResult = Readonly<{
  /** Rows deleted because their symbol is not in the document. */
  deleted: number;
  /** Rows inserted or replaced: one per fund of the document. */
  upserted: number;
}>;

export type LeveragedEtfUniverseRepository = Readonly<{
  /**
   * Makes the table equal to the document in one transaction: upserts every fund and deletes every
   * row whose symbol is not in the document. When any step fails, nothing changes. Refuses a
   * document with no funds, with a repeated symbol, or whose `generatedAt` is older than the
   * newest stored `generated_at` (an old document must not replace newer data).
   */
  replaceUniverse: (
    document: LeveragedEtfUniverseDocument
  ) => Promise<LeveragedEtfUniverseReplaceResult>;
}>;

type Fund = LeveragedEtfUniverseDocument["funds"][number];
type Row = typeof leveragedEtfUniverse.$inferInsert;

/** Rows per insert statement: 25 bound values per row, far below the 65535 limit of one statement. */
const UPSERT_CHUNK_ROWS = 500;

/** Serializes replaceUniverse calls, so the stale-document check and the delete see one writer. */
const LOCK_UNIVERSE = sql`select pg_advisory_xact_lock(hashtextextended('leveraged_etf_universe', 0))`;

// On a symbol conflict every column except the key takes the new value; updated_at moves to now().
const REPLACE_ON_CONFLICT = {
  ...Object.fromEntries(
    Object.entries(getTableColumns(leveragedEtfUniverse))
      .filter(([key]) => key !== "symbol")
      .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)])
  ),
  updatedAt: sql`now()`,
};

// The input is wrong, not the database: invalid_datetime_format, datetime_field_overflow (a date
// such as 2026-02-30) and numeric_value_out_of_range. The import CLI reports them as input problems.
const INPUT_ERRORS: Readonly<Record<string, string>> = {
  "22003": "has a number out of range",
  "22007": "has an invalid date",
  "22008": "has an invalid date",
};
const CHECK_VIOLATION = "23514";

const mapError = (error: unknown): never => {
  const details = databaseErrorDetails(error);
  if (details.code === CHECK_VIOLATION) {
    throw new InvalidRepositoryInputError(
      `leveraged ETF universe fails ${typeof details.constraint === "string" ? details.constraint : "a check"}`
    );
  }
  const input =
    typeof details.code === "string" ? INPUT_ERRORS[details.code] : undefined;
  if (input !== undefined) {
    throw new InvalidRepositoryInputError(`leveraged ETF universe ${input}`);
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError("leveraged ETF universe replace");
  }
  throw error;
};

const toDate = (value: string, field: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidRepositoryInputError(
      `leveraged ETF universe ${field} is not a datetime`
    );
  }
  return date;
};

const toRow = (
  fund: Fund,
  gate: LeveragedEtfUniverseDocument["gate"],
  generatedAt: Date
): Row => ({
  bandOpenInterest: fund.options?.bandOpenInterest ?? null,
  gateBandPct: gate.bandPct,
  gateMaxHalfSpreadPct: gate.maxHalfSpreadPct,
  gateMaxWindowDays: gate.maxWindowDays,
  gateMinBandOpenInterest: gate.minBandOpenInterest,
  gateMinWindowDays: gate.minWindowDays,
  gateVersion: gate.version,
  generatedAt,
  halfSpreadPct: fund.options?.halfSpreadPct ?? null,
  leverage: fund.leverage,
  listingExchange: fund.listingExchange,
  name: fund.name,
  nearestExpiries: fund.options?.nearestExpiries ?? [],
  optionGate: fund.optionGate,
  optionGateReasons: fund.optionGateReasons,
  optionsListed: fund.optionsListed,
  productType: fund.productType,
  quotedAt:
    fund.options === null
      ? null
      : toDate(fund.options.quotedAt, `${fund.symbol} options.quotedAt`),
  quoteSession: fund.options?.session ?? null,
  spot: fund.options?.spot ?? null,
  symbol: fund.symbol,
  totalOpenInterest: fund.options?.totalOpenInterest ?? null,
  underlying: fund.underlying,
  windowExpiry: fund.options?.windowExpiry ?? null,
});

export const createLeveragedEtfUniverseRepository = (
  database: DatabaseExecutor
): LeveragedEtfUniverseRepository =>
  Object.freeze({
    replaceUniverse: async (document) => {
      const generatedAt = toDate(document.generatedAt, "generatedAt");
      const symbols = document.funds.map((fund) => fund.symbol);
      // drizzle's notInArray(column, []) matches every row: an empty document would empty the table.
      if (symbols.length === 0) {
        throw new InvalidRepositoryInputError(
          "leveraged ETF universe document has no funds"
        );
      }
      // One insert statement cannot update the same row twice (Postgres 21000).
      const repeated = symbols.find(
        (symbol, index) => symbols.indexOf(symbol) !== index
      );
      if (repeated !== undefined) {
        throw new InvalidRepositoryInputError(
          `leveraged ETF universe document lists ${repeated} more than once`
        );
      }
      const rows = document.funds.map((fund) =>
        toRow(fund, document.gate, generatedAt)
      );
      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(LOCK_UNIVERSE);
          const [newest] = await transaction
            .select({ generatedAt: max(leveragedEtfUniverse.generatedAt) })
            .from(leveragedEtfUniverse);
          const storedAt = newest?.generatedAt ?? null;
          if (storedAt !== null && storedAt.getTime() > generatedAt.getTime()) {
            throw new InvalidRepositoryInputError(
              `leveraged ETF universe document generated at ${generatedAt.toISOString()} is older than the stored universe (${storedAt.toISOString()})`
            );
          }
          let upserted = 0;
          // Sequential: one connection per transaction.
          for (let start = 0; start < rows.length; start += UPSERT_CHUNK_ROWS) {
            const written = await transaction
              .insert(leveragedEtfUniverse)
              .values(rows.slice(start, start + UPSERT_CHUNK_ROWS))
              .onConflictDoUpdate({
                set: REPLACE_ON_CONFLICT,
                target: leveragedEtfUniverse.symbol,
              })
              .returning({ symbol: leveragedEtfUniverse.symbol });
            upserted += written.length;
          }
          const deleted = await transaction
            .delete(leveragedEtfUniverse)
            .where(notInArray(leveragedEtfUniverse.symbol, symbols))
            .returning({ symbol: leveragedEtfUniverse.symbol });
          return { deleted: deleted.length, upserted };
        });
      } catch (error) {
        return mapError(error);
      }
    },
  });
