import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import {
  type AutopilotCampaignStatus,
  type AutopilotCandidateOrigin,
  type AutopilotCandidateStatus,
  autopilotCampaigns,
  autopilotCandidates,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Autopilot campaigns and candidates (research only). The campaign status lifecycle is guarded here
// with conditional updates: running <-> stopped, running -> completed | failed; completed and failed
// are final. Progress is saved only while the campaign is still running at the version the runner
// read, so a stop during a tick wins. Every candidate row is one trial of its series ledger.

export const AUTOPILOT_CAMPAIGN_LIST_MAX = 100;
export const AUTOPILOT_CANDIDATE_LIST_MAX = 500;
export const AUTOPILOT_LEDGER_SAMPLE_MAX = 2000;

export type AutopilotCampaignRecord = typeof autopilotCampaigns.$inferSelect;
export type AutopilotCandidateRecord = typeof autopilotCandidates.$inferSelect;
/** A candidate without its definition, genome and equity curve: list rows. */
export type AutopilotCandidateSummary = Omit<
  AutopilotCandidateRecord,
  "definition" | "genome"
>;

export type AutopilotCampaignInput = Readonly<{
  name: string;
  symbol: string;
  timeframe: string;
  config: Record<string, unknown>;
  createdBy: string;
}>;

const TRANSITIONS: Readonly<
  Record<AutopilotCampaignStatus, readonly AutopilotCampaignStatus[]>
> = {
  completed: ["running"],
  failed: ["running"],
  running: ["stopped"],
  stopped: ["running"],
};

/** The statuses a campaign may move from into `to`. */
export const autopilotTransitionSources = (
  to: AutopilotCampaignStatus
): readonly AutopilotCampaignStatus[] => TRANSITIONS[to];

export type AutopilotProgressInput = Readonly<{
  id: string;
  version: number;
  generation: number;
  cpuMs: number;
  /** "completed" when a budget is used up. */
  status: "running" | "completed";
  note: string | null;
}>;

export type AutopilotCandidateInput = Readonly<{
  id: string;
  campaignId: string;
  series: string;
  generation: number;
  origin: AutopilotCandidateOrigin;
  parentIds: readonly string[];
  genome: Record<string, unknown>;
  genomeKey: string;
  label: string;
  definition: Record<string, unknown>;
  fitness: number | null;
  inSample: Record<string, unknown>;
  returnsCount: number;
  returnsMean: number;
  returnsStd: number;
  firstT: Date;
  lastT: Date;
}>;

export type AutopilotPopulationMember = Readonly<{
  id: string;
  genome: Record<string, unknown>;
  genomeKey: string;
  fitness: number;
}>;

export type AutopilotLedgerTrial = Readonly<{
  id: string;
  returns: number;
  meanReturn: number;
  stdReturn: number;
  firstT: Date;
  lastT: Date;
}>;

export type AutopilotCandidateFilters = Readonly<{
  campaignId: string;
  status?: AutopilotCandidateStatus;
  order: "fitness" | "recent";
  limit: number;
}>;

export type AutopilotRepository = Readonly<{
  createCampaign: (
    input: AutopilotCampaignInput
  ) => Promise<AutopilotCampaignRecord>;
  listCampaigns: (limit: number) => Promise<AutopilotCampaignRecord[]>;
  getCampaign: (id: string) => Promise<AutopilotCampaignRecord | null>;
  /** Null when the campaign does not exist or its status does not allow the move. */
  transitionCampaign: (
    input: Readonly<{
      id: string;
      to: AutopilotCampaignStatus;
      note?: string | null;
    }>
  ) => Promise<AutopilotCampaignRecord | null>;
  /** Running campaigns, least recently ticked first. */
  dueCampaigns: (limit: number) => Promise<AutopilotCampaignRecord[]>;
  /** Null when the campaign stopped or another runner saved first. */
  recordProgress: (
    input: AutopilotProgressInput
  ) => Promise<AutopilotCampaignRecord | null>;
  /** Inserts new candidates; a genome already in the campaign is skipped. Returns inserted ids. */
  insertCandidates: (
    rows: readonly AutopilotCandidateInput[]
  ) => Promise<string[]>;
  campaignKeys: (campaignId: string) => Promise<string[]>;
  population: (
    campaignId: string,
    limit: number
  ) => Promise<AutopilotPopulationMember[]>;
  /** Evaluated (not gated) bred candidates with positive fitness, best first. */
  ungated: (
    campaignId: string,
    limit: number
  ) => Promise<AutopilotCandidateRecord[]>;
  /** Null when the candidate was gated already. */
  recordGate: (
    input: Readonly<{
      id: string;
      status: "rejected" | "verified";
      gate: Record<string, unknown>;
      oosSharpe: number | null;
    }>
  ) => Promise<AutopilotCandidateRecord | null>;
  getCandidate: (id: string) => Promise<AutopilotCandidateRecord | null>;
  listCandidates: (
    filters: AutopilotCandidateFilters
  ) => Promise<AutopilotCandidateSummary[]>;
  children: (
    candidateId: string,
    limit: number
  ) => Promise<AutopilotCandidateSummary[]>;
  getCandidates: (
    ids: readonly string[]
  ) => Promise<AutopilotCandidateSummary[]>;
  /** Trial count of the series and the newest trials except `excludeId`. */
  ledger: (
    input: Readonly<{ series: string; excludeId: string; sample: number }>
  ) => Promise<Readonly<{ total: number; others: AutopilotLedgerTrial[] }>>;
  /** Null when the candidate is not verified or already has a deployment request. */
  recordHandoff: (
    input: Readonly<{
      id: string;
      strategyId: string;
      deploymentRequestId: string;
    }>
  ) => Promise<AutopilotCandidateRecord | null>;
}>;

const bound = (limit: number, max: number): number =>
  Math.min(Math.max(Math.trunc(limit), 1), max);

const campaigns = autopilotCampaigns;
const candidates = autopilotCandidates;

// Gate JSON without the equity curve: list rows stay small.
const summaryColumns = {
  campaignId: candidates.campaignId,
  createdAt: candidates.createdAt,
  deploymentRequestId: candidates.deploymentRequestId,
  firstT: candidates.firstT,
  fitness: candidates.fitness,
  gate: sql<Record<string, unknown> | null>`${candidates.gate} - 'curve'`,
  gatedAt: candidates.gatedAt,
  generation: candidates.generation,
  genomeKey: candidates.genomeKey,
  id: candidates.id,
  inSample: candidates.inSample,
  label: candidates.label,
  lastT: candidates.lastT,
  oosSharpe: candidates.oosSharpe,
  origin: candidates.origin,
  parentIds: candidates.parentIds,
  returnsCount: candidates.returnsCount,
  returnsMean: candidates.returnsMean,
  returnsStd: candidates.returnsStd,
  series: candidates.series,
  status: candidates.status,
  strategyId: candidates.strategyId,
};

const first = <T>(rows: readonly T[]): T | null => rows[0] ?? null;

export const createAutopilotRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): AutopilotRepository => ({
  campaignKeys: async (campaignId) =>
    (
      await database
        .select({ key: candidates.genomeKey })
        .from(candidates)
        .where(eq(candidates.campaignId, campaignId))
    ).map((row) => row.key),
  children: async (candidateId, limit) =>
    (await database
      .select(summaryColumns)
      .from(candidates)
      .where(
        sql`${candidates.parentIds} @> ${JSON.stringify([candidateId])}::jsonb`
      )
      .orderBy(asc(candidates.createdAt), asc(candidates.id))
      .limit(
        bound(limit, AUTOPILOT_CANDIDATE_LIST_MAX)
      )) as AutopilotCandidateSummary[],
  createCampaign: async (input) => {
    const now = dependencies.now();
    const [row] = await database
      .insert(campaigns)
      .values({
        config: input.config,
        createdAt: now,
        createdBy: input.createdBy,
        id: dependencies.generateId(),
        name: input.name,
        startedAt: now,
        status: "running",
        symbol: input.symbol,
        timeframe: input.timeframe,
        updatedAt: now,
      })
      .returning();
    return row as AutopilotCampaignRecord;
  },
  dueCampaigns: async (limit) =>
    await database
      .select()
      .from(campaigns)
      .where(eq(campaigns.status, "running"))
      .orderBy(sql`${campaigns.tickedAt} asc nulls first`, asc(campaigns.id))
      .limit(bound(limit, AUTOPILOT_CAMPAIGN_LIST_MAX)),
  getCampaign: async (id) =>
    first(
      await database
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .limit(1)
    ),
  getCandidate: async (id) =>
    first(
      await database
        .select()
        .from(candidates)
        .where(eq(candidates.id, id))
        .limit(1)
    ),
  getCandidates: async (ids) =>
    ids.length === 0
      ? []
      : ((await database
          .select(summaryColumns)
          .from(candidates)
          .where(
            inArray(candidates.id, [...ids])
          )) as AutopilotCandidateSummary[]),
  insertCandidates: async (rows) => {
    if (rows.length === 0) return [];
    const now = dependencies.now();
    const inserted = await database
      .insert(candidates)
      .values(
        rows.map((row) => ({
          ...row,
          createdAt: now,
          parentIds: [...row.parentIds],
          status: "evaluated" as const,
        }))
      )
      .onConflictDoNothing({
        target: [candidates.campaignId, candidates.genomeKey],
      })
      .returning({ id: candidates.id });
    return inserted.map((row) => row.id);
  },
  ledger: async (input) => {
    const [count] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(candidates)
      .where(eq(candidates.series, input.series));
    const others = await database
      .select({
        firstT: candidates.firstT,
        id: candidates.id,
        lastT: candidates.lastT,
        meanReturn: candidates.returnsMean,
        returns: candidates.returnsCount,
        stdReturn: candidates.returnsStd,
      })
      .from(candidates)
      .where(
        and(
          eq(candidates.series, input.series),
          ne(candidates.id, input.excludeId),
          // Trials without return spread are left out of the sample, so they count as p = 1.
          gt(candidates.returnsStd, 0)
        )
      )
      .orderBy(desc(candidates.createdAt), desc(candidates.id))
      .limit(bound(input.sample, AUTOPILOT_LEDGER_SAMPLE_MAX));
    return { others, total: Number(count?.total ?? 0) };
  },
  listCampaigns: async (limit) =>
    await database
      .select()
      .from(campaigns)
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(bound(limit, AUTOPILOT_CAMPAIGN_LIST_MAX)),
  listCandidates: async (filters) =>
    (await database
      .select(summaryColumns)
      .from(candidates)
      .where(
        and(
          eq(candidates.campaignId, filters.campaignId),
          ...(filters.status === undefined
            ? []
            : [eq(candidates.status, filters.status)])
        )
      )
      .orderBy(
        ...(filters.order === "fitness"
          ? [sql`${candidates.fitness} desc nulls last`, asc(candidates.id)]
          : [desc(candidates.createdAt), desc(candidates.id)])
      )
      .limit(
        bound(filters.limit, AUTOPILOT_CANDIDATE_LIST_MAX)
      )) as AutopilotCandidateSummary[],
  population: async (campaignId, limit) =>
    (await database
      .select({
        fitness: candidates.fitness,
        genome: candidates.genome,
        genomeKey: candidates.genomeKey,
        id: candidates.id,
      })
      .from(candidates)
      .where(
        and(
          eq(candidates.campaignId, campaignId),
          isNotNull(candidates.fitness),
          // Neighbours exist because their parent passed out-of-sample checks: never parents.
          ne(candidates.origin, "neighbour")
        )
      )
      .orderBy(desc(candidates.fitness), asc(candidates.id))
      .limit(
        bound(limit, AUTOPILOT_CANDIDATE_LIST_MAX)
      )) as AutopilotPopulationMember[],
  recordGate: async (input) =>
    first(
      await database
        .update(candidates)
        .set({
          gate: input.gate,
          gatedAt: dependencies.now(),
          oosSharpe: input.oosSharpe,
          status: input.status,
        })
        .where(
          and(eq(candidates.id, input.id), eq(candidates.status, "evaluated"))
        )
        .returning()
    ),
  recordHandoff: async (input) =>
    first(
      await database
        .update(candidates)
        .set({
          deploymentRequestId: input.deploymentRequestId,
          strategyId: input.strategyId,
        })
        .where(
          and(
            eq(candidates.id, input.id),
            eq(candidates.status, "verified"),
            isNull(candidates.deploymentRequestId)
          )
        )
        .returning()
    ),
  recordProgress: async (input) => {
    const now = dependencies.now();
    // Explicit alias "c": unqualified column interpolations would be ambiguous in this update.
    const counts = (filter: string) =>
      sql<number>`(select count(*)::int from ${candidates} c where c.campaign_id = ${input.id}${sql.raw(filter)})`;
    const best = sql`(select c.id, c.fitness from ${candidates} c where c.campaign_id = ${input.id} and c.fitness is not null order by c.fitness desc, c.id limit 1)`;
    return first(
      await database
        .update(campaigns)
        .set({
          bestCandidateId: sql`(select b.id from ${best} b)`,
          bestFitness: sql`(select b.fitness from ${best} b)`,
          candidateCount: counts(""),
          cpuMs: sql`${campaigns.cpuMs} + ${Math.max(0, Math.round(input.cpuMs))}`,
          gatedCount: counts(" and c.status <> 'evaluated'"),
          generation: input.generation,
          note: input.note,
          status: input.status,
          tickedAt: now,
          updatedAt: now,
          verifiedCount: counts(" and c.status = 'verified'"),
          version: sql`${campaigns.version} + 1`,
          ...(input.status === "completed" ? { finishedAt: now } : {}),
        })
        .where(
          and(
            eq(campaigns.id, input.id),
            eq(campaigns.version, input.version),
            eq(campaigns.status, "running")
          )
        )
        .returning()
    );
  },
  transitionCampaign: async (input) => {
    const now = dependencies.now();
    return first(
      await database
        .update(campaigns)
        .set({
          status: input.to,
          updatedAt: now,
          version: sql`${campaigns.version} + 1`,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.to === "running" ? { startedAt: now } : {}),
          ...(input.to === "completed" || input.to === "failed"
            ? { finishedAt: now }
            : {}),
        })
        .where(
          and(
            eq(campaigns.id, input.id),
            inArray(campaigns.status, [...TRANSITIONS[input.to]])
          )
        )
        .returning()
    );
  },
  ungated: async (campaignId, limit) =>
    await database
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.campaignId, campaignId),
          eq(candidates.status, "evaluated"),
          ne(candidates.origin, "neighbour"),
          gt(candidates.fitness, 0)
        )
      )
      .orderBy(desc(candidates.fitness), asc(candidates.id))
      .limit(bound(limit, AUTOPILOT_CANDIDATE_LIST_MAX)),
});
