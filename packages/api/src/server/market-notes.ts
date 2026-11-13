import type {
  MarketNoteDetailRecord,
  MarketNoteRecord,
  MarketNotesRepository,
} from "@darkfactory/db/server";
import type { SemanticEvent } from "@darkfactory/observability/port";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  MARKET_NOTE_AS_OF_MAX_DAYS_AHEAD,
  MARKET_NOTE_RECEIVED_AT_MAX_AHEAD_MS,
  MARKET_NOTE_REVIEW_MAX_DAYS,
  MARKET_NOTE_URL_MAX,
  type MarketNote,
  type MarketNoteDetail,
  MarketNoteDetailSchema,
  MarketNoteSchema,
  type MarketNotesAddInput,
} from "../contracts/market-notes.ts";
import {
  marketNoteContextLines,
  marketNoteSourceKey,
  marketNoteStatus,
  marketNoteVerification,
} from "../market-notes.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// Owner market notes procedures (marketNotes.*). Operator-only. list and get are reads: operator
// session, agent viewer or a read key. add, recordChecks and review are the rig's writes: operator
// agent WRITE key only (a read key gets 403 from requireOperator and a session gets 403 here).
// Every stored row is parsed with the contract schema before it leaves this module. A list drops a
// row that does not match the contract and reports it as a structured event, so one bad row never
// hides the other notes; a single-note answer (get, add, recordChecks, review) is a storage error.
// "expired" is derived here from the review date and today's UTC date. Research context only: no
// order path.

const api = implement(appContract).$context<ApiContext>();

type Failures = Readonly<{
  BAD_REQUEST: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
  NOT_FOUND: () => Error;
  STORAGE_ERROR: () => Error;
}>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): MarketNotesRepository => {
  const repository = context.repositories.marketNotes;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

/** Runs a repository call and the parse of its rows; any failure is one storage error. */
const storage = async <T>(
  failures: Failures,
  work: () => Promise<T>
): Promise<T> => {
  try {
    return await work();
  } catch {
    throw failures.STORAGE_ERROR();
  }
};

const requireAgentKey = (
  context: ApiContext,
  failures: Failures,
  procedure: string
): void => {
  // Rig only: the intake and the verification run with the operator's agent key.
  if (context.agentApiKeyPresented !== true)
    throw failures.FORBIDDEN({
      message: `${procedure} needs an agent API key`,
    });
};

/** YYYY-MM-DD in UTC: the date "expired" is derived against. */
export const marketNotesToday = (now: Date): string =>
  now.toISOString().slice(0, 10);

/** The date `days` days after `day` (both YYYY-MM-DD). */
const dayAfter = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const REVIEW_TOO_LATE_MESSAGE = `reviewBy must be within ${MARKET_NOTE_REVIEW_MAX_DAYS} days of today (UTC)`;

type MarketNotesFailureAction = "assistantContext" | "list";

/**
 * Best-effort structured event for a failure this module does not pass to the caller (a dropped
 * row, a notes block left out of the assistant prompt). It carries note ids and counts only, never
 * note text.
 */
const reportFailure = async (
  context: ApiContext,
  action: MarketNotesFailureAction,
  errorCategory: "invalid-stored-row" | "storage-error",
  attributes: Readonly<Record<string, string | number>>
): Promise<void> => {
  if (context.semanticEvents === undefined) return;
  const event: SemanticEvent = {
    action,
    attributes,
    correlation: {
      ...(context.span?.correlation ?? {}),
      procedure: `marketNotes.${action}`,
      requestId: context.requestId,
    },
    entityType: "market-note",
    errorCategory,
    eventId: crypto.randomUUID(),
    name: `vertex.marketNotes.${action}`,
    occurredAt: new Date().toISOString(),
    outcome: "failure",
    source: "api",
  };
  try {
    await context.semanticEvents.emit(event);
  } catch {
    // Reporting never fails the request.
  }
};

// verification is derived from the parsed claims, so the stored fields are parsed without it.
const StoredNoteSchema = MarketNoteSchema.omit({ verification: true });
const StoredDetailSchema = MarketNoteDetailSchema.omit({ verification: true });

const fieldsOf = (record: MarketNoteRecord, today: string) => ({
  affected: record.affected,
  asOf: record.asOf,
  claims: record.claims,
  id: record.id,
  ownerMessageUrl: record.ownerMessageUrl,
  receivedAt: record.receivedAt.toISOString(),
  reviewBy: record.reviewBy,
  source: {
    author: record.sourceAuthor,
    kind: record.sourceKind,
    url: record.sourceUrl,
  },
  stance: { confidence: record.stanceConfidence, direction: record.stance },
  status: marketNoteStatus(record.status, record.reviewBy, today),
  theme: record.theme,
  updatedAt: record.updatedAt.toISOString(),
});

/** One stored row as a contract note, or null when the row does not match the contract. */
const marketNoteOf = (
  record: MarketNoteRecord,
  today: string
): MarketNote | null => {
  const parsed = StoredNoteSchema.safeParse(fieldsOf(record, today));
  return parsed.success
    ? {
        ...parsed.data,
        verification: marketNoteVerification(parsed.data.claims),
      }
    : null;
};

/** The single-note form: a row that does not match the contract is a storage error. */
const requiredNoteOf = (
  record: MarketNoteRecord,
  today: string
): MarketNote => {
  const note = marketNoteOf(record, today);
  if (note === null) throw new Error("stored market note is not valid");
  return note;
};

const detailOf = (
  record: MarketNoteDetailRecord,
  today: string
): MarketNoteDetail => {
  const detail = StoredDetailSchema.parse({
    ...fieldsOf(record, today),
    rawText: record.rawText,
  });
  return { ...detail, verification: marketNoteVerification(detail.claims) };
};

/**
 * Stored rows as contract notes: each row is parsed on its own and its status is derived for
 * `today`. A row that does not match the contract is dropped and reported as one structured
 * event, so the other notes still reach the caller.
 */
const marketNotesOf = async (
  context: ApiContext,
  action: MarketNotesFailureAction,
  records: readonly MarketNoteRecord[],
  today: string
): Promise<MarketNote[]> => {
  const notes: MarketNote[] = [];
  const invalidIds: string[] = [];
  for (const record of records) {
    const note = marketNoteOf(record, today);
    if (note === null) invalidIds.push(record.id);
    else notes.push(note);
  }
  if (invalidIds.length > 0)
    await reportFailure(context, action, "invalid-stored-row", {
      count: invalidIds.length,
      noteIds: invalidIds.slice(0, 10).join(","),
    });
  return notes;
};

/**
 * The labelled block of active owner market notes for the assistant's system prompt (the notes of
 * marketNotes.list with scope "active"). The block is optional context: with no repository or a
 * storage failure the turn runs without it, and the failure is reported as a structured event.
 */
export const marketNoteAssistantLines = async (
  context: ApiContext,
  now: Date
): Promise<string[]> => {
  const repository = context.repositories.marketNotes;
  if (repository === undefined) return [];
  const today = marketNotesToday(now);
  let records: MarketNoteRecord[];
  try {
    records = (await repository.listActive(today)).notes;
  } catch {
    await reportFailure(context, "assistantContext", "storage-error", {});
    return [];
  }
  return marketNoteContextLines(
    await marketNotesOf(context, "assistantContext", records, today)
  );
};

const list = api.marketNotes.list
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = new Date();
    const today = marketNotesToday(now);
    const { scope, sourceUrl } = input;
    const page = await storage(failures, async () => {
      if (sourceUrl !== undefined) {
        const record = await repository.findBySourceKey(
          await marketNoteSourceKey({ url: sourceUrl }, "")
        );
        return { notes: record === null ? [] : [record], truncated: false };
      }
      // Both reads filter in SQL, before the row limit: a note that agents can still read is
      // never pushed out by newer retired notes.
      return scope === "active"
        ? await repository.listActive(today)
        : await repository.list(today);
    });
    const notes = await marketNotesOf(context, "list", page.notes, today);
    return {
      asOf: now.toISOString(),
      notes:
        scope === "active"
          ? notes.filter((note) => note.status === "active")
          : notes,
      today,
      truncated: page.truncated,
    };
  });

const get = api.marketNotes.get
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const today = marketNotesToday(new Date());
    const note = await storage(failures, async () => {
      const record = await repository.get(input.id);
      return record === null ? null : detailOf(record, today);
    });
    if (note === null) throw failures.NOT_FOUND();
    return { note };
  });

/** The stored form of a URL: parsed and serialized, so one page has one spelling. */
const storedUrl = (url: string | null): string | null =>
  url === null ? null : new URL(url).href;

/** Why the server refuses an add that the contract accepts, or null. */
const addRefusal = (
  input: MarketNotesAddInput,
  urls: readonly (string | null)[],
  receivedAt: Date,
  now: Date
): string | null => {
  const today = marketNotesToday(now);
  if (
    receivedAt.getTime() >
    now.getTime() + MARKET_NOTE_RECEIVED_AT_MAX_AHEAD_MS
  )
    return "receivedAt must not be later than the server time";
  if (input.asOf > dayAfter(today, MARKET_NOTE_AS_OF_MAX_DAYS_AHEAD))
    return "asOf must not be later than tomorrow (UTC)";
  if (input.reviewBy > dayAfter(today, MARKET_NOTE_REVIEW_MAX_DAYS))
    return REVIEW_TOO_LATE_MESSAGE;
  // A serialized URL can be longer than the URL as sent (percent-encoding).
  if (urls.some((url) => url !== null && url.length > MARKET_NOTE_URL_MAX))
    return "A URL is too long";
  return null;
};

const add = api.marketNotes.add
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    requireAgentKey(context, failures, "marketNotes.add");
    const repository = repositoryFor(context, failures);
    const now = new Date();
    const receivedAt =
      input.receivedAt === undefined ? now : new Date(input.receivedAt);
    const sourceUrl = storedUrl(input.source.url);
    const ownerMessageUrl = storedUrl(input.ownerMessageUrl);
    const refusal = addRefusal(
      input,
      [sourceUrl, ownerMessageUrl],
      receivedAt,
      now
    );
    if (refusal !== null) throw failures.BAD_REQUEST({ message: refusal });
    const sourceKey = await marketNoteSourceKey(
      { url: sourceUrl },
      input.rawText
    );
    return await storage(failures, async () => {
      const { created, note } = await repository.insert({
        affected: input.affected,
        asOf: input.asOf,
        // Claim ids are the claim positions: c1, c2, ... Every claim starts unverified.
        claims: input.claims.map((text, index) => ({
          checkedAt: null,
          evidence: null,
          id: `c${index + 1}`,
          status: "unverified" as const,
          text,
        })),
        ownerMessageUrl,
        rawText: input.rawText,
        receivedAt,
        reviewBy: input.reviewBy,
        sourceAuthor: input.source.author,
        sourceKey,
        sourceKind: input.source.kind,
        sourceUrl,
        stance: input.stance.direction,
        stanceConfidence: input.stance.confidence,
        theme: input.theme,
      });
      return { created, note: requiredNoteOf(note, marketNotesToday(now)) };
    });
  });

const recordChecks = api.marketNotes.recordChecks
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    requireAgentKey(context, failures, "marketNotes.recordChecks");
    const repository = repositoryFor(context, failures);
    const today = marketNotesToday(new Date());
    const result = await storage(failures, async () => {
      const outcome = await repository.recordChecks(input.id, input.checks);
      return outcome.kind === "ok"
        ? { kind: "ok" as const, note: requiredNoteOf(outcome.note, today) }
        : outcome;
    });
    if (result.kind === "ok") return { note: result.note };
    if (result.kind === "not-found") throw failures.NOT_FOUND();
    throw failures.BAD_REQUEST({
      message:
        result.kind === "retired"
          ? "A retired note takes no checks"
          : `Unknown claim id ${result.claimId}`,
    });
  });

const REVIEW_REFUSALS = {
  retired: "A retired note cannot be renewed",
  "review-date-before-as-of":
    "reviewBy must not be before the asOf of the note",
  "review-date-past": "reviewBy must be today or later (UTC)",
} as const;

const review = api.marketNotes.review
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    requireAgentKey(context, failures, "marketNotes.review");
    const repository = repositoryFor(context, failures);
    const today = marketNotesToday(new Date());
    const { action } = input;
    if (
      action.kind === "renew" &&
      action.reviewBy > dayAfter(today, MARKET_NOTE_REVIEW_MAX_DAYS)
    )
      throw failures.BAD_REQUEST({ message: REVIEW_TOO_LATE_MESSAGE });
    const result = await storage(failures, async () => {
      const outcome = await repository.review(input.id, action);
      return outcome.kind === "ok"
        ? { kind: "ok" as const, note: requiredNoteOf(outcome.note, today) }
        : outcome;
    });
    if (result.kind === "ok") return { note: result.note };
    if (result.kind === "not-found") throw failures.NOT_FOUND();
    throw failures.BAD_REQUEST({ message: REVIEW_REFUSALS[result.kind] });
  });

export const marketNotesRouter = { add, get, list, recordChecks, review };
