import { and, desc, eq, sql } from "drizzle-orm";

import { strategyDefinitionRevisions } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Saved strategy definitions: append-only revisions. insert writes one revision and returns null
// when that (definition, revision) pair already exists (a concurrent save), so the caller can report
// a conflict. No method updates or deletes a revision. Research input only; no order path.

export const STRATEGY_DEFINITIONS_LIST_MAX = 100;
export const STRATEGY_DEFINITION_HISTORY_LIST_MAX = 50;

export type StrategyDefinitionRevisionRecord = Readonly<{
  id: string;
  definitionId: string;
  revision: number;
  sha256: string;
  name: string;
  definition: Record<string, unknown>;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}>;

export type StrategyDefinitionHistoryRecord = Omit<
  StrategyDefinitionRevisionRecord,
  "definition" | "createdBy" | "id" | "definitionId"
>;

export type StrategyDefinitionRevisionInput = Readonly<{
  definitionId: string;
  revision: number;
  sha256: string;
  name: string;
  definition: Record<string, unknown>;
  note: string | null;
  createdBy: string;
}>;

export type StrategyDefinitionsRepository = Readonly<{
  /** Stores one revision. Null when the revision number is already taken. */
  insert: (
    input: StrategyDefinitionRevisionInput
  ) => Promise<StrategyDefinitionRevisionRecord | null>;
  latest: (
    definitionId: string
  ) => Promise<StrategyDefinitionRevisionRecord | null>;
  get: (
    definitionId: string,
    revision: number
  ) => Promise<StrategyDefinitionRevisionRecord | null>;
  /** Revisions newest first, without the definition body. */
  history: (
    definitionId: string,
    limit: number
  ) => Promise<StrategyDefinitionHistoryRecord[]>;
  /** The latest revision of each definition, most recently changed first. */
  listLatest: (limit: number) => Promise<StrategyDefinitionRevisionRecord[]>;
}>;

const bound = (limit: number, max: number): number =>
  Math.min(Math.max(Math.trunc(limit), 1), max);

const table = strategyDefinitionRevisions;

export const createStrategyDefinitionsRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): StrategyDefinitionsRepository => ({
  insert: async (input) => {
    const [row] = await database
      .insert(table)
      .values({
        id: dependencies.generateId(),
        definitionId: input.definitionId,
        revision: input.revision,
        sha256: input.sha256,
        name: input.name,
        definition: input.definition,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: dependencies.now(),
      })
      .onConflictDoNothing({ target: [table.definitionId, table.revision] })
      .returning();
    return (row as StrategyDefinitionRevisionRecord | undefined) ?? null;
  },
  latest: async (definitionId) => {
    const [row] = await database
      .select()
      .from(table)
      .where(eq(table.definitionId, definitionId))
      .orderBy(desc(table.revision))
      .limit(1);
    return (row as StrategyDefinitionRevisionRecord | undefined) ?? null;
  },
  get: async (definitionId, revision) => {
    const [row] = await database
      .select()
      .from(table)
      .where(
        and(eq(table.definitionId, definitionId), eq(table.revision, revision))
      )
      .limit(1);
    return (row as StrategyDefinitionRevisionRecord | undefined) ?? null;
  },
  history: async (definitionId, limit) =>
    (await database
      .select({
        revision: table.revision,
        sha256: table.sha256,
        name: table.name,
        note: table.note,
        createdAt: table.createdAt,
      })
      .from(table)
      .where(eq(table.definitionId, definitionId))
      .orderBy(desc(table.revision))
      .limit(
        bound(limit, STRATEGY_DEFINITION_HISTORY_LIST_MAX)
      )) as StrategyDefinitionHistoryRecord[],
  listLatest: async (limit) =>
    (await database
      .select()
      .from(table)
      .where(
        sql`${table.revision} = (select max(other.revision) from ${table} other where other.definition_id = ${table.definitionId})`
      )
      .orderBy(desc(table.createdAt))
      .limit(
        bound(limit, STRATEGY_DEFINITIONS_LIST_MAX)
      )) as StrategyDefinitionRevisionRecord[],
});
