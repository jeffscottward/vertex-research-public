import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type {
  GoLiveApprovedOrderLegValue,
  GoLiveApprovedOrderValue,
  GoLiveDraftKindValue,
  GoLiveDraftRow,
  GoLiveDraftStateValue,
  GoLiveEntryBasisValue,
  GoLiveExitReasonValue,
  GoLiveExitRuleValue,
  GoLiveNodeBadgeValue,
  GoLivePlanApprovalBasisValue,
  GoLivePlanLimitsValue,
  GoLivePlanRow,
  GoLivePlanSleeveValue,
  GoLivePlanStatusValue,
  GoLiveQuoteSourceValue,
  GoLiveStoredQuoteValue,
  GoLiveStructureValue,
} from "../schema/index.ts";
import {
  GOLIVE_EXIT_RULE_VALUE,
  goLiveDraftRuns,
  goLiveDrafts,
  goLivePlans,
} from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";

// Go-live draft queue store (goLiveDrafts.*). One plan is in force at a time (proposed or
// approved); writePlan retires it and inserts the next version. collect stores the generator's
// entry candidates of one trading day under deterministic ids. A rerun adds no second draft: it
// gives a stored draft without a decision the quote, the facts and the entry basis of the later
// run, and expires proposed drafts that are no longer wanted. decide records the owner's
// approval or rejection of a proposed draft, once; an approval stores the approved order in the
// same statement, and only while the draft is as the approval read it. Inputs are validated by
// the oRPC contract and the seed script; the table checks enforce the same rules.
// RECORDS ONLY: no order path.

export type {
  GoLiveApprovedOrderLegValue,
  GoLiveApprovedOrderValue,
  GoLiveDefinitionVariantValue,
  GoLiveDraftKindValue,
  GoLiveDraftStateValue,
  GoLiveEntryBasisValue,
  GoLiveExitReasonValue,
  GoLiveExitRuleValue,
  GoLiveNodeBadgeValue,
  GoLivePlanApprovalBasisValue,
  GoLivePlanLimitsValue,
  GoLivePlanSleeveValue,
  GoLivePlanStatusValue,
  GoLiveQuoteSourceValue,
  GoLiveStoredQuoteValue,
  GoLiveStructureValue,
} from "../schema/index.ts";

export type GoLivePlanRecord = Readonly<{
  /** The plan's name key; the same in every version of it. */
  id: string;
  name: string;
  version: number;
  status: GoLivePlanStatusValue;
  approvalBasis: GoLivePlanApprovalBasisValue | null;
  ownerMessageUrl: string | null;
  evidenceUrl: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  retiredAt: Date | null;
  limits: GoLivePlanLimitsValue;
  sleeves: GoLivePlanSleeveValue[];
  exitRule: GoLiveExitRuleValue;
  createdAt: Date;
  updatedAt: Date;
}>;

export type GoLiveDraftRecord = Readonly<{
  id: string;
  planId: string;
  planVersion: number;
  /** YYYY-MM-DD. */
  tradingDay: string;
  kind: GoLiveDraftKindValue;
  sleeveKey: string;
  symbol: string;
  structure: GoLiveStructureValue;
  /** YYYYMMDD. */
  expiry: string;
  longStrike: number;
  shortStrike: number;
  entryBasis: GoLiveEntryBasisValue | null;
  exitReason: GoLiveExitReasonValue | null;
  parentDraftId: string | null;
  signalFacts: string[];
  /** As stored: asOf is an ISO-8601 instant. */
  quote: GoLiveStoredQuoteValue | null;
  exitRule: GoLiveExitRuleValue;
  state: GoLiveDraftStateValue;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  nodeBadgeAtDecision: GoLiveNodeBadgeValue | null;
  /** The order the owner approved, as stored with the approval. null unless state is approved. */
  approvedOrder: GoLiveApprovedOrderValue | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** The fields of GoLivePlanSeedSchema (packages/api); the seed script validates them. */
export type GoLivePlanSeedInput = Readonly<{
  id: string;
  name: string;
  status: "proposed" | "approved";
  approvalBasis: GoLivePlanApprovalBasisValue | null;
  ownerMessageUrl: string | null;
  evidenceUrl: string | null;
  approvedBy: string | null;
  limits: Readonly<GoLivePlanLimitsValue>;
  sleeves: readonly Readonly<
    Omit<GoLivePlanSleeveValue, "symbols"> & { symbols: readonly string[] }
  >[];
}>;

/** One wanted entry, as GoLiveDraftCandidateSchema (packages/api) parses it. */
export type GoLiveDraftCandidateInput = Readonly<{
  entryBasis: GoLiveEntryBasisValue;
  expiry: string;
  longStrike: number;
  quote: Readonly<{
    asOf: Date;
    longAsk: number;
    longBid: number;
    shortAsk: number;
    shortBid: number;
    source: GoLiveQuoteSourceValue;
  }> | null;
  shortStrike: number;
  signalFacts: readonly string[];
  sleeveKey: string;
  structure: GoLiveStructureValue;
  symbol: string;
}>;

export type GoLiveCollectRecord = Readonly<{
  planId: string;
  planVersion: number;
  /** YYYY-MM-DD. */
  tradingDay: string;
  generatedAt: Date;
  candidates: readonly GoLiveDraftCandidateInput[];
  /** The most drafts the trading day may hold after this run (GOLIVE_DRAFT_LIST_MAX). */
  maxDrafts: number;
}>;

/** Every candidate of the run is counted once in created, updated or unchanged. */
export type GoLiveCollectResult = Readonly<{
  created: number;
  updated: number;
  unchanged: number;
  expired: number;
}>;

export type GoLiveDraftRunRecord = Readonly<{
  generatedAt: Date;
  candidateCount: number;
  planId: string;
  planVersion: number;
}>;

/** The order of an approval, as VertexComboInputSchema (packages/api) describes it. */
export type GoLiveApprovedOrderInput = Readonly<
  Omit<GoLiveApprovedOrderValue, "legs"> & {
    legs: readonly Readonly<GoLiveApprovedOrderLegValue>[];
  }
>;

interface GoLiveDecisionFields {
  id: string;
  decidedBy: string;
  note: string | null;
  nodeBadge: GoLiveNodeBadgeValue | null;
}

/**
 * An approval always carries the approved order and the updated time of the draft as the
 * approving request read it; a rejection carries neither.
 */
export type GoLiveDecideInput =
  | Readonly<
      GoLiveDecisionFields & {
        decision: "approved";
        approvedOrder: GoLiveApprovedOrderInput;
        expectedUpdatedAt: Date;
      }
    >
  | Readonly<
      GoLiveDecisionFields & {
        decision: "rejected";
        approvedOrder?: never;
        expectedUpdatedAt?: never;
      }
    >;

export class GoLiveDraftNotFoundError extends Error {
  readonly draftId: string;
  constructor(draftId: string) {
    super(`Go-live draft ${draftId} does not exist`);
    this.name = "GoLiveDraftNotFoundError";
    this.draftId = draftId;
  }
}

/** The draft exists and is not in state proposed (decided before, or expired). */
export class GoLiveDraftConflictError extends Error {
  readonly draftId: string;
  constructor(draftId: string) {
    super(`Go-live draft ${draftId} is no longer proposed`);
    this.name = "GoLiveDraftConflictError";
    this.draftId = draftId;
  }
}

/** The draft is still proposed and is not as the approval read it: a collect changed it. */
export class GoLiveDraftChangedError extends Error {
  readonly draftId: string;
  constructor(draftId: string) {
    super(`Go-live draft ${draftId} changed after it was read`);
    this.name = "GoLiveDraftChangedError";
    this.draftId = draftId;
  }
}

/** The run would take the drafts of its trading day above the limit. Nothing was written. */
export class GoLiveDraftLimitError extends Error {
  readonly tradingDay: string;
  readonly limit: number;
  constructor(
    tradingDay: string,
    limit: number,
    stored: number,
    added: number
  ) {
    super(
      `Trading day ${tradingDay} holds ${stored} go-live drafts and the run adds ${added}: more than the limit of ${limit}`
    );
    this.name = "GoLiveDraftLimitError";
    this.tradingDay = tradingDay;
    this.limit = limit;
  }
}

/** The generator built its candidates for a plan version that is not the plan in force. */
export class GoLivePlanMismatchError extends Error {
  readonly sent: Readonly<{ planId: string; planVersion: number }>;
  readonly inForce: Readonly<{ planId: string; planVersion: number }> | null;
  constructor(
    sent: Readonly<{ planId: string; planVersion: number }>,
    inForce: Readonly<{ planId: string; planVersion: number }> | null
  ) {
    super(
      inForce === null
        ? `Go-live plan ${sent.planId} version ${sent.planVersion} was sent and no plan is in force`
        : `Go-live plan ${sent.planId} version ${sent.planVersion} was sent and the plan in force is ${inForce.planId} version ${inForce.planVersion}`
    );
    this.name = "GoLivePlanMismatchError";
    this.sent = sent;
    this.inForce = inForce;
  }
}

export type GoLiveDraftsRepository = Readonly<{
  /** The proposed or approved plan, or null when none was written or the last one is retired. */
  planInForce: () => Promise<GoLivePlanRecord | null>;
  /** One transaction: retires the plan in force and inserts the seed as the next version. */
  writePlan: (
    seed: GoLivePlanSeedInput,
    options: Readonly<{ actor: string }>
  ) => Promise<GoLivePlanRecord>;
  /** The drafts of one trading day (YYYY-MM-DD), by sleeve key, symbol, then id. */
  listDrafts: (
    filter: Readonly<{ tradingDay: string }>
  ) => Promise<GoLiveDraftRecord[]>;
  /** The generator's last report for the trading day, or null when it has not reported. */
  lastRun: (tradingDay: string) => Promise<GoLiveDraftRunRecord | null>;
  /**
   * One transaction. Throws GoLivePlanMismatchError unless planId and planVersion are the plan in
   * force, and GoLiveDraftLimitError when the run would take the trading day above maxDrafts;
   * a refused run writes nothing. Each candidate is counted once:
   * - created: its id is new; it is stored as a proposed entry draft.
   * - updated: its id is stored without a decision, and the stored quote, facts or entry basis
   *   differ (they are replaced), or the draft was expired by an earlier run of this trading day
   *   (it goes back to proposed with the content of this run).
   * - unchanged: nothing was written: the stored draft is the same, or it is approved or
   *   rejected. Approved and rejected drafts never change.
   * Then expires proposed drafts of earlier trading days and proposed entry drafts of this
   * trading day that are not in this run (expired).
   */
  collect: (run: GoLiveCollectRecord) => Promise<GoLiveCollectResult>;
  /**
   * Records the owner's decision on a proposed draft. An approval stores its order in the same
   * statement that moves the draft from proposed to approved, and only while the draft is as it
   * was read (expectedUpdatedAt); a rejection stores no order. Throws GoLiveDraftNotFoundError
   * for an unknown id, GoLiveDraftChangedError when a proposed draft changed after it was read,
   * and GoLiveDraftConflictError when the draft is not proposed any more.
   */
  decide: (input: GoLiveDecideInput) => Promise<GoLiveDraftRecord>;
}>;

export type GoLiveDraftsRepositoryDependencies = Readonly<{
  now?: () => Date;
  /** Accepted so every repository takes the same dependencies; ids here are never random. */
  generateId?: () => string;
}>;

const planOf = (row: GoLivePlanRow): GoLivePlanRecord => ({
  approvalBasis: row.approvalBasis,
  approvedAt: row.approvedAt,
  approvedBy: row.approvedBy,
  createdAt: row.createdAt,
  evidenceUrl: row.evidenceUrl,
  exitRule: row.exitRule,
  id: row.id,
  limits: row.limits,
  name: row.name,
  ownerMessageUrl: row.ownerMessageUrl,
  retiredAt: row.retiredAt,
  sleeves: row.sleeves,
  status: row.status,
  updatedAt: row.updatedAt,
  version: row.version,
});

const draftOf = (row: GoLiveDraftRow): GoLiveDraftRecord => ({
  approvedOrder: row.approvedOrder,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  decidedBy: row.decidedBy,
  decisionNote: row.decisionNote,
  entryBasis: row.entryBasis,
  exitReason: row.exitReason,
  exitRule: row.exitRule,
  expiry: row.expiry,
  id: row.id,
  kind: row.kind,
  longStrike: row.longStrike,
  nodeBadgeAtDecision: row.nodeBadgeAtDecision,
  parentDraftId: row.parentDraftId,
  planId: row.planId,
  planVersion: row.planVersion,
  quote: row.quote,
  shortStrike: row.shortStrike,
  signalFacts: row.signalFacts,
  sleeveKey: row.sleeveKey,
  state: row.state,
  structure: row.structure,
  symbol: row.symbol,
  tradingDay: row.tradingDay,
  updatedAt: row.updatedAt,
});

const IN_FORCE: readonly GoLivePlanStatusValue[] = ["proposed", "approved"];

/**
 * The id of an entry draft: the first 32 hex characters of the SHA-256 of
 * `planId|planVersion|tradingDay|entry|sleeveKey|symbol|structure|expiry|longStrike|shortStrike`.
 * The same wanted entry of the same plan version and trading day always has the same id.
 */
export const goLiveEntryDraftId = async (
  run: Readonly<{ planId: string; planVersion: number; tradingDay: string }>,
  candidate: Pick<
    GoLiveDraftCandidateInput,
    | "sleeveKey"
    | "symbol"
    | "structure"
    | "expiry"
    | "longStrike"
    | "shortStrike"
  >
): Promise<string> => {
  const text = [
    run.planId,
    run.planVersion,
    run.tradingDay,
    "entry",
    candidate.sleeveKey,
    candidate.symbol,
    candidate.structure,
    candidate.expiry,
    candidate.longStrike,
    candidate.shortStrike,
  ].join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, 32);
};

const storedQuote = (
  quote: GoLiveDraftCandidateInput["quote"]
): GoLiveStoredQuoteValue | null =>
  quote === null
    ? null
    : {
        asOf: quote.asOf.toISOString(),
        longAsk: quote.longAsk,
        longBid: quote.longBid,
        shortAsk: quote.shortAsk,
        shortBid: quote.shortBid,
        source: quote.source,
      };

/** The approved order as stored: a new object with the order fields and nothing else. */
const storedOrder = (
  order: GoLiveApprovedOrderInput
): GoLiveApprovedOrderValue => ({
  legs: order.legs.map((leg) => ({
    expiry: leg.expiry,
    ratio: leg.ratio,
    right: leg.right,
    side: leg.side,
    strike: leg.strike,
  })),
  limitPrice: order.limitPrice,
  quantity: order.quantity,
  symbol: order.symbol,
});

/** The row of a new entry draft: state proposed, created and updated at the same time. */
const draftValues = (
  run: GoLiveCollectRecord,
  id: string,
  candidate: GoLiveDraftCandidateInput,
  at: Date
) => ({
  createdAt: at,
  entryBasis: candidate.entryBasis,
  exitRule: GOLIVE_EXIT_RULE_VALUE,
  expiry: candidate.expiry,
  id,
  kind: "entry" as const,
  longStrike: candidate.longStrike,
  planId: run.planId,
  planVersion: run.planVersion,
  quote: storedQuote(candidate.quote),
  shortStrike: candidate.shortStrike,
  signalFacts: [...candidate.signalFacts],
  sleeveKey: candidate.sleeveKey,
  state: "proposed" as const,
  structure: candidate.structure,
  symbol: candidate.symbol,
  tradingDay: run.tradingDay,
  updatedAt: at,
});

const assertPlanInForce = (
  run: GoLiveCollectRecord,
  plan: GoLivePlanRow | undefined
): void => {
  if (
    plan === undefined ||
    plan.id !== run.planId ||
    plan.version !== run.planVersion
  ) {
    throw new GoLivePlanMismatchError(
      { planId: run.planId, planVersion: run.planVersion },
      plan === undefined ? null : { planId: plan.id, planVersion: plan.version }
    );
  }
};

// A draft without a decision: proposed, or expired (an expired draft never holds a decision).
const OPEN_STATES: GoLiveDraftStateValue[] = ["proposed", "expired"];

const sameQuote = (
  a: GoLiveStoredQuoteValue | null,
  b: GoLiveStoredQuoteValue | null
): boolean =>
  a === null || b === null
    ? a === b
    : a.asOf === b.asOf &&
      a.longAsk === b.longAsk &&
      a.longBid === b.longBid &&
      a.shortAsk === b.shortAsk &&
      a.shortBid === b.shortBid &&
      a.source === b.source;

/**
 * true when collect must write a stored draft that a run sends again: the draft has no decision
 * and it is expired (it goes back to proposed), or its quote, its facts or its entry basis
 * differ from the candidate. Approved and rejected drafts are never written.
 */
const needsRefresh = (
  row: Readonly<{
    entryBasis: GoLiveEntryBasisValue | null;
    quote: GoLiveStoredQuoteValue | null;
    signalFacts: readonly string[];
    state: GoLiveDraftStateValue;
  }>,
  candidate: GoLiveDraftCandidateInput
): boolean => {
  if (!OPEN_STATES.includes(row.state)) return false;
  return (
    row.state === "expired" ||
    row.entryBasis !== candidate.entryBasis ||
    !sameQuote(row.quote, storedQuote(candidate.quote)) ||
    row.signalFacts.length !== candidate.signalFacts.length ||
    row.signalFacts.some((fact, index) => fact !== candidate.signalFacts[index])
  );
};

/**
 * Stores the wanted entries of a run that are new and refreshes the stored ones that have no
 * decision. Throws GoLiveDraftLimitError before the first write when the trading day would hold
 * more than run.maxDrafts. Returns how many drafts were created and how many were updated.
 */
const storeWanted = async (
  transaction: DatabaseExecutor,
  run: GoLiveCollectRecord,
  wanted: ReadonlyMap<string, GoLiveDraftCandidateInput>,
  at: Date
): Promise<Readonly<{ created: number; updated: number }>> => {
  let created = 0;
  let updated = 0;
  // Every draft of this trading day, locked until the transaction ends, in id order so
  // that two runs take the locks in the same order. An id holds its trading day, so a
  // stored draft with a wanted id is always in this list.
  const stored = await transaction
    .select({
      entryBasis: goLiveDrafts.entryBasis,
      id: goLiveDrafts.id,
      quote: goLiveDrafts.quote,
      signalFacts: goLiveDrafts.signalFacts,
      state: goLiveDrafts.state,
    })
    .from(goLiveDrafts)
    .where(eq(goLiveDrafts.tradingDay, run.tradingDay))
    .orderBy(asc(goLiveDrafts.id))
    .for("update");
  const storedById = new Map(stored.map((row) => [row.id, row]));
  const fresh = [...wanted].filter(([id]) => !storedById.has(id));
  // Checked before the first write: a refused run stores, refreshes and expires nothing.
  if (stored.length + fresh.length > run.maxDrafts)
    throw new GoLiveDraftLimitError(
      run.tradingDay,
      run.maxDrafts,
      stored.length,
      fresh.length
    );
  if (fresh.length > 0) {
    const inserted = await transaction
      .insert(goLiveDrafts)
      .values(
        fresh.map(([id, candidate]) => draftValues(run, id, candidate, at))
      )
      .onConflictDoNothing({ target: goLiveDrafts.id })
      .returning({ id: goLiveDrafts.id });
    created = inserted.length;
  }
  // A stored draft without a decision gets the quote, the facts and the entry basis of
  // this run, so the 12:40 and 15:40 runs replace what the first run of the day stored.
  // A draft that an earlier run of today expired and that is wanted again goes back to
  // proposed. Nothing is written for a proposed draft that is sent again unchanged, and
  // approved and rejected drafts never change, whatever the run sends.
  for (const [id, candidate] of wanted) {
    const row = storedById.get(id);
    if (row === undefined || !needsRefresh(row, candidate)) continue;
    const refreshed = await transaction
      .update(goLiveDrafts)
      .set({
        entryBasis: candidate.entryBasis,
        quote: storedQuote(candidate.quote),
        signalFacts: [...candidate.signalFacts],
        state: "proposed",
        updatedAt: at,
      })
      .where(
        and(
          eq(goLiveDrafts.id, id),
          inArray(goLiveDrafts.state, OPEN_STATES),
          isNull(goLiveDrafts.decidedBy)
        )
      )
      .returning({ id: goLiveDrafts.id });
    updated += refreshed.length;
  }
  return { created, updated };
};

export const createGoLiveDraftsRepository = (
  database: DatabaseExecutor,
  dependencies: GoLiveDraftsRepositoryDependencies = {}
): GoLiveDraftsRepository => {
  const now = dependencies.now ?? (() => new Date());

  const selectPlanInForce = async (
    executor: DatabaseExecutor
  ): Promise<GoLivePlanRow | undefined> => {
    const rows = await executor
      .select()
      .from(goLivePlans)
      .where(inArray(goLivePlans.status, IN_FORCE))
      .limit(1);
    return rows[0];
  };

  const repository: GoLiveDraftsRepository = {
    collect: (run) =>
      withTransaction(database, async (transaction) => {
        const plan = await selectPlanInForce(transaction);
        assertPlanInForce(run, plan);
        const at = now();
        // A candidate sent twice in one run is one draft: the first one is kept.
        const wanted = new Map<string, GoLiveDraftCandidateInput>();
        for (const candidate of run.candidates) {
          const id = await goLiveEntryDraftId(run, candidate);
          if (!wanted.has(id)) wanted.set(id, candidate);
        }
        const ids = [...wanted.keys()];
        const { created, updated } =
          ids.length === 0
            ? { created: 0, updated: 0 }
            : await storeWanted(transaction, run, wanted, at);
        // Exit drafts are not part of a generator run, so a run never expires today's exits.
        const todayNotWanted = and(
          eq(goLiveDrafts.tradingDay, run.tradingDay),
          eq(goLiveDrafts.kind, "entry"),
          ids.length === 0 ? undefined : notInArray(goLiveDrafts.id, ids)
        );
        const expired = await transaction
          .update(goLiveDrafts)
          .set({ state: "expired", updatedAt: at })
          .where(
            and(
              eq(goLiveDrafts.state, "proposed"),
              or(lt(goLiveDrafts.tradingDay, run.tradingDay), todayNotWanted)
            )
          )
          .returning({ id: goLiveDrafts.id });
        const runValues = {
          candidateCount: run.candidates.length,
          generatedAt: run.generatedAt,
          planId: run.planId,
          planVersion: run.planVersion,
        };
        await transaction
          .insert(goLiveDraftRuns)
          .values({ ...runValues, tradingDay: run.tradingDay })
          .onConflictDoUpdate({
            set: runValues,
            target: goLiveDraftRuns.tradingDay,
          });
        return {
          created,
          expired: expired.length,
          unchanged: ids.length - created - updated,
          updated,
        };
      }),
    decide: async (input) => {
      const at = now();
      // Both are built before the statement, so an approval without a usable order or without
      // the time its draft was read at writes nothing.
      const approvedOrder =
        input.decision === "approved" ? storedOrder(input.approvedOrder) : null;
      // An approval matches the draft only as it was read: a collect that refreshed the quote,
      // the facts or the entry basis in between moved updated_at. A rejection has no such
      // condition: it does not depend on what the draft holds.
      const asRead =
        input.decision === "approved"
          ? eq(
              goLiveDrafts.updatedAt,
              new Date(input.expectedUpdatedAt.getTime())
            )
          : undefined;
      // One statement: the state, the decision fields and the approved order change together,
      // and only while the draft is still proposed. The table check refuses an approved row
      // without an order and an order on any other state.
      const decided = await database
        .update(goLiveDrafts)
        .set({
          approvedOrder,
          decidedAt: at,
          decidedBy: input.decidedBy,
          decisionNote: input.note,
          nodeBadgeAtDecision: input.nodeBadge,
          state: input.decision,
          updatedAt: at,
        })
        .where(
          and(
            eq(goLiveDrafts.id, input.id),
            eq(goLiveDrafts.state, "proposed"),
            asRead
          )
        )
        .returning();
      const row = decided[0];
      if (row !== undefined) return draftOf(row);
      const existing = await database
        .select({ id: goLiveDrafts.id, state: goLiveDrafts.state })
        .from(goLiveDrafts)
        .where(eq(goLiveDrafts.id, input.id))
        .limit(1);
      const found = existing[0];
      if (found === undefined) throw new GoLiveDraftNotFoundError(input.id);
      // Still proposed, and the statement did not match: the draft is not as it was read.
      if (found.state === "proposed")
        throw new GoLiveDraftChangedError(input.id);
      throw new GoLiveDraftConflictError(input.id);
    },
    lastRun: async (tradingDay) => {
      const rows = await database
        .select()
        .from(goLiveDraftRuns)
        .where(eq(goLiveDraftRuns.tradingDay, tradingDay))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        candidateCount: row.candidateCount,
        generatedAt: row.generatedAt,
        planId: row.planId,
        planVersion: row.planVersion,
      };
    },
    listDrafts: async ({ tradingDay }) => {
      const rows = await database
        .select()
        .from(goLiveDrafts)
        .where(eq(goLiveDrafts.tradingDay, tradingDay))
        .orderBy(
          asc(goLiveDrafts.sleeveKey),
          asc(goLiveDrafts.symbol),
          asc(goLiveDrafts.id)
        );
      return rows.map(draftOf);
    },
    planInForce: async () => {
      const row = await selectPlanInForce(database);
      return row === undefined ? null : planOf(row);
    },
    writePlan: (seed, { actor }) =>
      withTransaction(database, async (transaction) => {
        const at = now();
        await transaction
          .update(goLivePlans)
          .set({ retiredAt: at, status: "retired", updatedAt: at })
          .where(inArray(goLivePlans.status, IN_FORCE));
        const latest = await transaction
          .select({
            version:
              sql<number>`coalesce(max(${goLivePlans.version}), 0)`.mapWith(
                Number
              ),
          })
          .from(goLivePlans);
        const approved = seed.status === "approved";
        const inserted = await transaction
          .insert(goLivePlans)
          .values({
            approvalBasis: seed.approvalBasis,
            approvedAt: approved ? at : null,
            // The seed names who approved; the actor is who ran the write.
            approvedBy: approved ? (seed.approvedBy ?? actor) : null,
            createdAt: at,
            evidenceUrl: seed.evidenceUrl,
            exitRule: GOLIVE_EXIT_RULE_VALUE,
            id: seed.id,
            limits: { ...seed.limits },
            name: seed.name,
            ownerMessageUrl: seed.ownerMessageUrl,
            sleeves: seed.sleeves.map((sleeve) => ({
              ...sleeve,
              symbols: [...sleeve.symbols],
            })),
            status: seed.status,
            updatedAt: at,
            version: (latest[0]?.version ?? 0) + 1,
          })
          .returning();
        return planOf(inserted[0] as GoLivePlanRow);
      }),
  };
  return repository;
};
