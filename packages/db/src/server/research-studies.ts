// What: Drizzle repository for frozen research studies (one jsonb study document per row).
// Used by: packages/db/src/server/repositories.ts (createRepositories) for researchStudies.get and
// for the strategy library list/get verdict lookup (verdicts), and
// scripts/research-studies/import.ts (`bun run vertex:research-studies:import`) for writes.
// See: packages/db/migrations/0051_research_studies.sql; docs/vertex-rebuild/research-studies.md.
// The document is stored and returned as given; callers validate it with ResearchStudyDocumentSchema
// (packages/api/src/contracts/research-studies.ts). `verdicts` reads only two keys inside the stored
// document (summary->>'kind', summary->>'verdict'); its caller validates them. Research records only.
import { eq, inArray, sql } from "drizzle-orm";

import { researchStudies } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
  InvalidRepositoryInputError,
} from "./repository-errors.ts";

export type ResearchStudyRecord = Readonly<{
  createdAt: Date;
  id: string;
  ranOn: string;
  specRef: string;
  summary: Readonly<Record<string, unknown>>;
  updatedAt: Date;
}>;

export type ResearchStudyUpsertInput = Readonly<{
  id: string;
  ranOn: string;
  specRef: string;
  summary: Readonly<Record<string, unknown>>;
}>;

/** The kind and verdict keys of one stored study, read without the rest of the document. */
export type ResearchStudyVerdictRecord = Readonly<{
  id: string;
  kind: string | null;
  verdict: string | null;
}>;

export type ResearchStudyUpsertResult = Readonly<{
  /** True when the row is new; false when an existing study was replaced. */
  created: boolean;
  id: string;
  updatedAt: Date;
}>;

export type ResearchStudyRepository = Readonly<{
  /** The stored study, or null when no study has this id. */
  get: (id: string) => Promise<ResearchStudyRecord | null>;
  /**
   * The kind and verdict keys of the studies with these ids, in one query; ids without a study are
   * left out. Empty ids return [] without a query.
   */
  verdicts: (
    ids: readonly string[]
  ) => Promise<readonly ResearchStudyVerdictRecord[]>;
  /** Stores a study, or replaces the stored document, spec and run date of the same id. */
  upsert: (
    input: ResearchStudyUpsertInput
  ) => Promise<ResearchStudyUpsertResult>;
  /**
   * Upserts every study, in order, in one transaction: when any write fails, none is stored.
   * Results are in input order.
   */
  upsertMany: (
    inputs: readonly ResearchStudyUpsertInput[]
  ) => Promise<ResearchStudyUpsertResult[]>;
}>;

// check_violation, invalid_datetime_format, datetime_field_overflow: the input is wrong, not the
// database, so the import CLI reports them as input problems.
const INPUT_ERRORS: Readonly<Record<string, string>> = {
  "22007": "has an invalid date",
  "22008": "has an invalid date",
};
const CHECK_VIOLATION = "23514";

const mapError = (operation: string, error: unknown): never => {
  const details = databaseErrorDetails(error);
  if (details.code === CHECK_VIOLATION) {
    throw new InvalidRepositoryInputError(
      `research study fails ${typeof details.constraint === "string" ? details.constraint : "a check"}`
    );
  }
  const input =
    typeof details.code === "string" ? INPUT_ERRORS[details.code] : undefined;
  if (input !== undefined) {
    throw new InvalidRepositoryInputError(`research study ${input}`);
  }
  if (typeof details.code === "string") {
    throw new DatabasePersistenceError(operation);
  }
  throw error;
};

const write = async (
  executor: DatabaseExecutor,
  { id, ranOn, specRef, summary }: ResearchStudyUpsertInput
): Promise<ResearchStudyUpsertResult> => {
  const [row] = await executor
    .insert(researchStudies)
    .values({ id, ranOn, specRef, summary })
    .onConflictDoUpdate({
      set: { ranOn, specRef, summary, updatedAt: sql`now()` },
      target: researchStudies.id,
    })
    .returning({
      createdAt: researchStudies.createdAt,
      id: researchStudies.id,
      updatedAt: researchStudies.updatedAt,
    });
  if (row === undefined)
    throw new DatabasePersistenceError("research study write");
  return {
    // Insert sets both timestamps to the same now(); an update moves only updated_at. now() is the
    // transaction start, so this also holds inside upsertMany, which refuses repeated ids.
    created: row.createdAt.getTime() === row.updatedAt.getTime(),
    id: row.id,
    updatedAt: row.updatedAt,
  };
};

export const createResearchStudyRepository = (
  database: DatabaseExecutor
): ResearchStudyRepository =>
  Object.freeze({
    get: async (id) => {
      try {
        const [row] = await database
          .select()
          .from(researchStudies)
          .where(eq(researchStudies.id, id))
          .limit(1);
        return row ?? null;
      } catch (error) {
        return mapError("research study read", error);
      }
    },
    verdicts: async (ids) => {
      if (ids.length === 0) return [];
      try {
        return await database
          .select({
            id: researchStudies.id,
            kind: sql<string | null>`${researchStudies.summary} ->> 'kind'`,
            verdict: sql<
              string | null
            >`${researchStudies.summary} ->> 'verdict'`,
          })
          .from(researchStudies)
          .where(inArray(researchStudies.id, [...ids]));
      } catch (error) {
        return mapError("research study read", error);
      }
    },
    upsert: async (input) => {
      try {
        return await write(database, input);
      } catch (error) {
        return mapError("research study write", error);
      }
    },
    upsertMany: async (inputs) => {
      if (inputs.length === 0) return [];
      // A repeated id would be inserted then updated at the same now(), so `created` would be wrong
      // for both rows; refuse it before opening a transaction.
      const ids = new Set<string>();
      for (const { id } of inputs) {
        if (ids.has(id))
          throw new InvalidRepositoryInputError(
            `research study ${id} appears more than once in one batch`
          );
        ids.add(id);
      }
      try {
        return await database.transaction(async (transaction) => {
          const results: ResearchStudyUpsertResult[] = [];
          // Sequential: one connection per transaction, and results keep the input order.
          for (const input of inputs)
            results.push(await write(transaction, input));
          return results;
        });
      } catch (error) {
        return mapError("research study write", error);
      }
    },
  });
