import { and, desc, eq, getTableColumns, gte } from "drizzle-orm";

import type {
  MarketNoteClaimStatusValue,
  MarketNoteRow,
} from "../schema/index.ts";
import { marketNotes } from "../schema/index.ts";
import { type DatabaseExecutor, withTransaction } from "./client.ts";
import { DatabasePersistenceError } from "./repository-errors.ts";

// Owner market notes store (marketNotes.*). One row per source: insert is idempotent on source_key,
// so a second add of the same reel, article or text returns the stored note unchanged. A check and a
// review each lock the row, change it and write it in one transaction, so two writers never lose an
// update, and both take the row time from the repository clock after the lock, so updated_at never
// goes back. "expired" is derived from review_by; only "active" and "retired" are stored.
// The jsonb columns (claims, affected) are returned as stored: the oRPC layer parses them before a
// row leaves the server. Research context only: no order path.

export type {
  MarketNoteAffectedValue,
  MarketNoteClaimStatusValue,
  MarketNoteClaimValue,
  MarketNoteConfidenceValue,
  MarketNoteSourceKindValue,
  MarketNoteStanceValue,
  MarketNoteStoredStatusValue,
} from "../schema/index.ts";

/** Most rows one list call returns. */
export const MARKET_NOTES_LIST_LIMIT = 100;
/**
 * Most rows of the active read. A list always holds these rows: the newest notes that are active
 * today.
 */
export const MARKET_NOTES_ACTIVE_LIMIT = 50;

/** A stored note with its raw text. */
export type MarketNoteDetailRecord = Readonly<MarketNoteRow>;
/** A stored note without its raw text (list rows, write results). */
export type MarketNoteRecord = Readonly<Omit<MarketNoteRow, "rawText">>;

/** What insert takes: the repository adds the id, the status "active" and the row times. */
export type MarketNoteNewRecord = Readonly<
  Omit<MarketNoteRow, "createdAt" | "id" | "status" | "updatedAt">
>;

export type MarketNoteCheckRecord = Readonly<{
  claimId: string;
  evidence: string;
  status: Exclude<MarketNoteClaimStatusValue, "unverified">;
}>;

export type MarketNoteReviewAction =
  | Readonly<{ kind: "renew"; reviewBy: string }>
  | Readonly<{ kind: "retire" }>;

export type MarketNoteListResult = Readonly<{
  /** Newest first by receivedAt. */
  notes: MarketNoteRecord[];
  /** True when the store holds older rows of this read that `notes` does not hold. */
  truncated: boolean;
}>;

export type MarketNoteInsertResult = Readonly<{
  /** False when a note with the same source key already existed. */
  created: boolean;
  note: MarketNoteRecord;
}>;

export type MarketNoteChecksResult =
  | Readonly<{ kind: "ok"; note: MarketNoteRecord }>
  | Readonly<{ kind: "not-found" }>
  /** Retire is final: a retired note takes no more checks. */
  | Readonly<{ kind: "retired" }>
  | Readonly<{ kind: "unknown-claim"; claimId: string }>;

export type MarketNoteReviewResult =
  | Readonly<{ kind: "ok"; note: MarketNoteRecord }>
  | Readonly<{ kind: "not-found" }>
  /** Renew on a retired note: retire is final. */
  | Readonly<{ kind: "retired" }>
  /** Renew with a review date before today (UTC, repository clock). */
  | Readonly<{ kind: "review-date-past" }>
  /** Renew with a review date before the note's market date. */
  | Readonly<{ kind: "review-date-before-as-of" }>;

export type MarketNotesRepository = Readonly<{
  /**
   * Notes of any status, without raw text, newest first: the notes of listActive(today) (so newer
   * expired or retired notes never push out a note that agents can still read), then the newest
   * rows of any status, MARKET_NOTES_LIST_LIMIT rows in total.
   */
  list: (today: string) => Promise<MarketNoteListResult>;
  /**
   * The newest MARKET_NOTES_ACTIVE_LIMIT notes that are active on `today` (YYYY-MM-DD): not
   * retired and with a review date of today or later. The filter runs before the limit, so newer
   * expired or retired notes never push an active note out.
   */
  listActive: (today: string) => Promise<MarketNoteListResult>;
  findBySourceKey: (sourceKey: string) => Promise<MarketNoteRecord | null>;
  /** One note with its raw text. */
  get: (id: string) => Promise<MarketNoteDetailRecord | null>;
  /** Insert-once by source key; an existing note is returned unchanged. */
  insert: (note: MarketNoteNewRecord) => Promise<MarketNoteInsertResult>;
  /**
   * Sets status, evidence and checkedAt on the named claims. checkedAt and updatedAt are one
   * instant of the repository clock. Writes nothing on a refusal.
   */
  recordChecks: (
    id: string,
    checks: readonly MarketNoteCheckRecord[]
  ) => Promise<MarketNoteChecksResult>;
  /**
   * Renews the review date or retires the note. A new review date must be today (UTC, repository
   * clock) or later and must not be before the note's market date.
   */
  review: (
    id: string,
    action: MarketNoteReviewAction
  ) => Promise<MarketNoteReviewResult>;
}>;

export type MarketNotesRepositoryDependencies = Readonly<{
  now?: () => Date;
  generateId?: () => string;
}>;

const { rawText: _rawText, ...summaryColumns } = getTableColumns(marketNotes);

/** Why a new review date is refused, or null: it must be today (UTC) or later and not before the market date. */
const renewRefusal = (
  reviewBy: string,
  asOf: string,
  now: Date
): "review-date-past" | "review-date-before-as-of" | null => {
  if (reviewBy < now.toISOString().slice(0, 10)) return "review-date-past";
  return reviewBy < asOf ? "review-date-before-as-of" : null;
};

/** Not retired and with a review date of `today` (YYYY-MM-DD) or later: what agents read. */
const activeOn = (today: string) =>
  and(eq(marketNotes.status, "active"), gte(marketNotes.reviewBy, today));

export const createMarketNotesRepository = (
  database: DatabaseExecutor,
  dependencies: MarketNotesRepositoryDependencies = {}
): MarketNotesRepository => {
  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());
  const findBySourceKey = async (
    sourceKey: string
  ): Promise<MarketNoteRecord | null> => {
    const rows = await database
      .select(summaryColumns)
      .from(marketNotes)
      .where(eq(marketNotes.sourceKey, sourceKey))
      .limit(1);
    return rows[0] ?? null;
  };
  return {
    findBySourceKey,
    get: async (id) => {
      const rows = await database
        .select()
        .from(marketNotes)
        .where(eq(marketNotes.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    insert: async (note) => {
      const at = now();
      const rows = await database
        .insert(marketNotes)
        .values({
          ...note,
          createdAt: at,
          id: generateId(),
          status: "active",
          updatedAt: at,
        })
        .onConflictDoNothing({ target: marketNotes.sourceKey })
        .returning(summaryColumns);
      const created = rows[0];
      if (created !== undefined) return { created: true, note: created };
      // The conflicting row is committed by the time the insert returns nothing.
      const stored = await findBySourceKey(note.sourceKey);
      if (stored === null)
        throw new DatabasePersistenceError("market note insert");
      return { created: false, note: stored };
    },
    list: async (today) => {
      const guaranteed = await database
        .select(summaryColumns)
        .from(marketNotes)
        .where(activeOn(today))
        .orderBy(desc(marketNotes.receivedAt), desc(marketNotes.id))
        .limit(MARKET_NOTES_ACTIVE_LIMIT);
      // One row more than an answer can hold: it shows that older rows exist.
      const newest = await database
        .select(summaryColumns)
        .from(marketNotes)
        .orderBy(desc(marketNotes.receivedAt), desc(marketNotes.id))
        .limit(MARKET_NOTES_LIST_LIMIT + 1);
      const guaranteedIds = new Set(guaranteed.map((row) => row.id));
      const others = newest.filter((row) => !guaranteedIds.has(row.id));
      const fill = others.slice(0, MARKET_NOTES_LIST_LIMIT - guaranteed.length);
      return {
        notes: [...guaranteed, ...fill].sort(
          (left, right) =>
            right.receivedAt.getTime() - left.receivedAt.getTime() ||
            Number(right.id > left.id) - Number(right.id < left.id)
        ),
        truncated: others.length > fill.length,
      };
    },
    listActive: async (today) => {
      const rows = await database
        .select(summaryColumns)
        .from(marketNotes)
        .where(activeOn(today))
        .orderBy(desc(marketNotes.receivedAt), desc(marketNotes.id))
        .limit(MARKET_NOTES_ACTIVE_LIMIT + 1);
      return {
        notes: rows.slice(0, MARKET_NOTES_ACTIVE_LIMIT),
        truncated: rows.length > MARKET_NOTES_ACTIVE_LIMIT,
      };
    },
    recordChecks: (id, checks) =>
      withTransaction(database, async (transaction) => {
        const [row] = await transaction
          .select(summaryColumns)
          .from(marketNotes)
          .where(eq(marketNotes.id, id))
          .for("update");
        if (row === undefined) return { kind: "not-found" };
        if (row.status === "retired") return { kind: "retired" };
        const claimIds = new Set(row.claims.map((claim) => claim.id));
        const unknown = checks.find((check) => !claimIds.has(check.claimId));
        if (unknown !== undefined)
          return { claimId: unknown.claimId, kind: "unknown-claim" };
        const byClaim = new Map(checks.map((check) => [check.claimId, check]));
        // Read after the lock: a later writer never stores an earlier time.
        const checkedAt = now();
        const claims = row.claims.map((claim) => {
          const check = byClaim.get(claim.id);
          return check === undefined
            ? claim
            : {
                ...claim,
                checkedAt: checkedAt.toISOString(),
                evidence: check.evidence,
                status: check.status,
              };
        });
        const changes = { claims, updatedAt: checkedAt };
        await transaction
          .update(marketNotes)
          .set(changes)
          .where(eq(marketNotes.id, id));
        // The row is locked, so the stored row is the read row plus these changes.
        return { kind: "ok", note: { ...row, ...changes } };
      }),
    review: (id, action) =>
      withTransaction(database, async (transaction) => {
        const [row] = await transaction
          .select(summaryColumns)
          .from(marketNotes)
          .where(eq(marketNotes.id, id))
          .for("update");
        if (row === undefined) return { kind: "not-found" };
        const retired = row.status === "retired";
        // Retire is idempotent: a second retire returns the stored note unchanged.
        if (action.kind === "retire" && retired)
          return { kind: "ok", note: row };
        if (retired) return { kind: "retired" };
        // Read after the lock: a later writer never stores an earlier time.
        const updatedAt = now();
        const refusal =
          action.kind === "renew"
            ? renewRefusal(action.reviewBy, row.asOf, updatedAt)
            : null;
        if (refusal !== null) return { kind: refusal };
        const changes =
          action.kind === "retire"
            ? { status: "retired" as const, updatedAt }
            : { reviewBy: action.reviewBy, updatedAt };
        await transaction
          .update(marketNotes)
          .set(changes)
          .where(eq(marketNotes.id, id));
        return { kind: "ok", note: { ...row, ...changes } };
      }),
  };
};
