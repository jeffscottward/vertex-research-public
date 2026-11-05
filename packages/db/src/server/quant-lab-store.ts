// Quant Lab research-record store (migration 0043 plus the shared paper, strategy, task and
// backtest tables). Callers pass rows with content-hash ids. Every insert is idempotent on its
// natural key, so recording the same artifacts twice writes nothing new.
// Research records only: nothing here reads, routes or submits orders.
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  type AgentMetrics,
  agentTasks,
  backtestResults,
  paperCaptures,
  type ResearchPaperStage,
  type ResearchPaperVerdict,
  researchPapers,
  strategies,
  strategySpecs,
} from "../schema/index.ts";
import type { Database, DatabaseExecutor } from "./client.ts";

export type QuantLabPaperRow = typeof researchPapers.$inferInsert &
  Readonly<{ identifier: string }>;
export type QuantLabCaptureRow = typeof paperCaptures.$inferInsert;
export type QuantLabStrategyRow = typeof strategies.$inferInsert &
  Readonly<{ id: string }>;
export type QuantLabSpecRow = typeof strategySpecs.$inferInsert;
export type QuantLabTaskRow = typeof agentTasks.$inferInsert;
export type QuantLabBacktestRow = typeof backtestResults.$inferInsert;
export type QuantLabPaperOutcome = Readonly<{
  stage: ResearchPaperStage;
  verdict: ResearchPaperVerdict;
  reproducedMetrics: AgentMetrics;
}>;

export class QuantLabStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantLabStoreError";
  }
}

const firstId = (rows: readonly { id: string }[], what: string): string => {
  const row = rows[0];
  if (row === undefined) {
    throw new QuantLabStoreError(`${what} was not found after insert`);
  }
  return row.id;
};

/** Paper stages a recorded backtest may move forward from. */
const OUTCOME_FROM_STAGES = [
  "queued",
  "ingested",
  "spec_extracted",
  "implemented",
] as const satisfies readonly ResearchPaperStage[];

/** Write and lookup operations of one Quant Lab recording. */
export interface QuantLabStore {
  advancePaperStage: (
    paperId: string,
    stage: ResearchPaperStage,
    fromStages: readonly ResearchPaperStage[]
  ) => Promise<void>;
  ensureBacktest: (row: QuantLabBacktestRow) => Promise<void>;
  ensureCapture: (row: QuantLabCaptureRow) => Promise<string>;
  ensurePaper: (row: QuantLabPaperRow) => Promise<string>;
  ensureSpec: (row: QuantLabSpecRow) => Promise<void>;
  ensureTask: (row: QuantLabTaskRow) => Promise<void>;
  findCaptureId: (doi: string, version: string) => Promise<string | null>;
  findPaperId: (doi: string) => Promise<string | null>;
  setPaperOutcome: (
    paperId: string,
    outcome: QuantLabPaperOutcome
  ) => Promise<void>;
  upsertStrategy: (row: QuantLabStrategyRow) => Promise<string>;
}

export const createQuantLabStore = (
  database: DatabaseExecutor
): QuantLabStore => ({
  /** Moves a paper forward only from the listed earlier stages; a later stage is never moved back. */
  advancePaperStage: async (
    paperId: string,
    stage: ResearchPaperStage,
    fromStages: readonly ResearchPaperStage[]
  ): Promise<void> => {
    await database
      .update(researchPapers)
      .set({ stage, updatedAt: sql`now()` })
      .where(
        and(
          eq(researchPapers.id, paperId),
          inArray(researchPapers.stage, [...fromStages])
        )
      );
  },

  ensureBacktest: async (row: QuantLabBacktestRow): Promise<void> => {
    await database
      .insert(backtestResults)
      .values(row)
      .onConflictDoNothing({ target: backtestResults.id });
  },

  ensureCapture: async (row: QuantLabCaptureRow): Promise<string> => {
    await database
      .insert(paperCaptures)
      .values(row)
      .onConflictDoNothing({
        target: [paperCaptures.doi, paperCaptures.version],
      });
    return firstId(
      await database
        .select({ id: paperCaptures.id })
        .from(paperCaptures)
        .where(
          and(
            eq(paperCaptures.doi, row.doi),
            eq(paperCaptures.version, row.version)
          )
        )
        .limit(1),
      "paper capture"
    );
  },
  /** Keeps an existing paper with the same DOI (for example one added by hand) and returns its id. */
  ensurePaper: async (row: QuantLabPaperRow): Promise<string> => {
    await database
      .insert(researchPapers)
      .values(row)
      .onConflictDoNothing({ target: researchPapers.identifier });
    return firstId(
      await database
        .select({ id: researchPapers.id })
        .from(researchPapers)
        .where(eq(researchPapers.identifier, row.identifier))
        .limit(1),
      "research paper"
    );
  },

  ensureSpec: async (row: QuantLabSpecRow): Promise<void> => {
    await database
      .insert(strategySpecs)
      .values(row)
      .onConflictDoNothing({ target: strategySpecs.specSha256 });
  },

  ensureTask: async (row: QuantLabTaskRow): Promise<void> => {
    await database
      .insert(agentTasks)
      .values(row)
      .onConflictDoNothing({ target: agentTasks.id });
  },

  findCaptureId: async (
    doi: string,
    version: string
  ): Promise<string | null> => {
    const rows = await database
      .select({ id: paperCaptures.id })
      .from(paperCaptures)
      .where(
        and(eq(paperCaptures.doi, doi), eq(paperCaptures.version, version))
      )
      .limit(1);
    return rows[0]?.id ?? null;
  },

  findPaperId: async (doi: string): Promise<string | null> => {
    const rows = await database
      .select({ id: researchPapers.id })
      .from(researchPapers)
      .where(eq(researchPapers.identifier, doi))
      .limit(1);
    return rows[0]?.id ?? null;
  },

  /**
   * Records a backtest outcome. The stage moves forward only from an earlier stage, and the
   * verdict is set only when it is still pending or the paper was at an earlier stage, so a later
   * stage or an operator's verdict is kept. Reproduced metrics are always refreshed.
   */
  setPaperOutcome: async (
    paperId: string,
    outcome: QuantLabPaperOutcome
  ): Promise<void> => {
    const earlier = inArray(researchPapers.stage, [...OUTCOME_FROM_STAGES]);
    await database
      .update(researchPapers)
      .set({
        reproducedMetrics: outcome.reproducedMetrics,
        stage: sql`case when ${earlier} then ${outcome.stage} else ${researchPapers.stage} end`,
        updatedAt: sql`now()`,
        verdict: sql`case when ${researchPapers.verdict} = 'pending' or ${earlier} then ${outcome.verdict} else ${researchPapers.verdict} end`,
      })
      .where(eq(researchPapers.id, paperId));
  },

  /**
   * Matches a strategy by slug. A rerun refreshes its description and parameters; the status is
   * taken only while the stored status is still "idea" or "researching", so it never moves back.
   */
  upsertStrategy: async (row: QuantLabStrategyRow): Promise<string> => {
    await database
      .insert(strategies)
      .values(row)
      .onConflictDoUpdate({
        set: {
          description: sql`excluded.description`,
          params: sql`excluded.params`,
          status: sql`case when ${strategies.status} in ('idea', 'researching') then excluded.status else ${strategies.status} end`,
          updatedAt: sql`now()`,
        },
        target: strategies.slug,
      });

    return firstId(
      await database
        .select({ id: strategies.id })
        .from(strategies)
        .where(eq(strategies.slug, row.slug))
        .limit(1),
      "strategy"
    );
  },
});

/** Runs every write of one recording in a single transaction. */
export const recordQuantLab = <T>(
  database: Database,
  work: (store: QuantLabStore) => Promise<T>
): Promise<T> => database.transaction((tx) => work(createQuantLabStore(tx)));
