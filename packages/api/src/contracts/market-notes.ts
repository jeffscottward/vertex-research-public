import { oc } from "@orpc/contract";
import { z } from "zod";

// Owner market notes (marketNotes.*): dated narrative context that the owner sends (a reel, an
// article or plain text), stored in Postgres table market_notes. A note holds the source, the raw
// text, one theme line, the claims with a verification status each, the affected area, a stance
// and a review date. See docs/vertex-rebuild/market-notes.md.
//
// A note is a third-party opinion until its claims are checked. Every surface shows the claim
// statuses. Notes are research context only: no procedure here reads or changes an order, the arm
// state, a size or a risk setting.

export const MARKET_NOTE_SOURCE_KINDS = [
  "reel",
  "article",
  "owner-text",
] as const;
export const MARKET_NOTE_CLAIM_STATUSES = [
  "unverified",
  "supported",
  "contradicted",
  "cannot-check",
] as const;
/** The statuses a check can record. A check never sets a claim back to "unverified". */
export const MARKET_NOTE_CHECK_STATUSES = [
  "supported",
  "contradicted",
  "cannot-check",
] as const;
export const MARKET_NOTE_STANCES = ["risk-on", "risk-off", "neutral"] as const;
export const MARKET_NOTE_CONFIDENCES = ["low", "medium", "high"] as const;
/**
 * "expired" is derived, not stored: the review date is before today (UTC). An expired note shows
 * as stale and is left out of agent context until review renews it. "retired" is final.
 */
export const MARKET_NOTE_STATUSES = ["active", "expired", "retired"] as const;
export const MARKET_NOTE_LIST_SCOPES = ["active", "all"] as const;

export const MARKET_NOTE_MAX_CLAIMS = 12;
/** Most notes one list answer holds. Scope "active" holds at most half of it. */
export const MARKET_NOTE_LIST_MAX = 100;
export const MARKET_NOTE_RAW_TEXT_MAX = 200_000;

export const MARKET_NOTE_URL_MAX = 2000;
/** A note comes up for review within a year: reviewBy is at most this many days after today (UTC). */
export const MARKET_NOTE_REVIEW_MAX_DAYS = 366;
/** asOf is at most this many days after today (UTC): the next session, in any time zone. */
export const MARKET_NOTE_AS_OF_MAX_DAYS_AHEAD = 1;
/** receivedAt is at most this far after the server time (clock difference of the sender). */
export const MARKET_NOTE_RECEIVED_AT_MAX_AHEAD_MS = 5 * 60_000;
/** Market dates and review dates stay inside this range (a typing error gives year 0026 or 20226). */
export const MARKET_NOTE_DATE_MIN = "2000-01-01";
export const MARKET_NOTE_DATE_MAX = "2100-12-31";

const date = z.iso
  .date()
  .refine(
    (value) => value >= MARKET_NOTE_DATE_MIN && value <= MARKET_NOTE_DATE_MAX,
    `must be from ${MARKET_NOTE_DATE_MIN} to ${MARKET_NOTE_DATE_MAX}`
  );
const timestamp = z.iso.datetime({ offset: true });

// Characters that break a one-line text form or hide text from a reader: control characters
// (Cc, with U+0000 and line breaks), format characters (Cf: zero-width and bidi controls), the
// line and paragraph separators (Zl, Zp) and lone surrogates (Cs; with the u flag a surrogate pair
// is one character and is not Cs, so this is the test String.prototype.isWellFormed makes).
const UNSAFE_LINE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** Postgres text cannot hold U+0000 and jsonb cannot hold a lone surrogate. */
const isStorableText = (text: string): boolean =>
  !(text.includes("\u0000") || /\p{Cs}/u.test(text));
const STORABLE_TEXT_MESSAGE = "must not hold U+0000 or a lone surrogate";

/**
 * http or https, no user name or password, and no white space, control or format character
 * anywhere (a URL parser would drop a tab or a line break in silence, so the text is checked first).
 */
const isPlainUrl = (value: string): boolean => {
  if (
    /\s/u.test(value) ||
    UNSAFE_LINE_CHARACTER.test(value) ||
    !/^https?:\/\//iu.test(value)
  )
    return false;
  const parsed = URL.canParse(value) ? new URL(value) : null;
  return parsed !== null && parsed.username === "" && parsed.password === "";
};
const url = z
  .string()
  .max(MARKET_NOTE_URL_MAX)
  .refine(
    isPlainUrl,
    "must be an http or https URL without credentials, white space or control characters"
  );
/** One line of text: no control, format or line-separator character and no lone surrogate. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (text) => !UNSAFE_LINE_CHARACTER.test(text),
      "must be one line of text without control or format characters"
    );

export const MarketNoteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u, "letters, digits, - and _ only");
export const MarketNoteClaimIdSchema = z
  .string()
  .regex(/^c(?:[1-9]|1[0-2])$/u, "claim ids are c1 to c12");
const claimText = line(500);
// Evidence is text of several lines: line feed, carriage return and tab are the only control
// characters it may hold. Format characters, the line and paragraph separators and lone surrogates
// are refused, as in a line field.
const UNSAFE_EVIDENCE_CHARACTER = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|[^\P{Cc}\n\r\t]/u;
/** Evidence may hold line breaks; the agent context form puts it on one line. */
const evidenceText = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (text) => !UNSAFE_EVIDENCE_CHARACTER.test(text),
    "must be text without control or format characters (line breaks and tabs are allowed)"
  );

export const MarketNoteSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      author: line(120).nullable(),
      kind: z.enum(["reel", "article"]),
      url,
    })
    .strict(),
  z
    .object({
      author: line(120).nullable(),
      kind: z.literal("owner-text"),
      url: z.null(),
    })
    .strict(),
]);

/** A claim is unverified with no evidence, or checked with evidence and the check time. */
export const MarketNoteClaimSchema = z.discriminatedUnion("status", [
  z
    .object({
      checkedAt: z.null(),
      evidence: z.null(),
      id: MarketNoteClaimIdSchema,
      status: z.literal("unverified"),
      text: claimText,
    })
    .strict(),
  z
    .object({
      checkedAt: timestamp,
      evidence: evidenceText,
      id: MarketNoteClaimIdSchema,
      status: z.enum(MARKET_NOTE_CHECK_STATUSES),
      text: claimText,
    })
    .strict(),
]);

export const MarketNoteAffectedSchema = z
  .object({
    sectors: z.array(line(60)).max(12),
    /** Strategy or sleeve names as the owner uses them. */
    strategies: z.array(line(80)).max(12),
    tickers: z
      .array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u, "upper-case ticker"))
      .max(30),
  })
  .strict();

export const MarketNoteStanceSchema = z
  .object({
    confidence: z.enum(MARKET_NOTE_CONFIDENCES),
    direction: z.enum(MARKET_NOTE_STANCES),
  })
  .strict();

/** Claim counts by status. "checked" is true when no claim is unverified. */
export const MarketNoteVerificationSchema = z.object({
  cannotCheck: z.number().int().min(0),
  checked: z.boolean(),
  contradicted: z.number().int().min(0),
  supported: z.number().int().min(0),
  unverified: z.number().int().min(0),
});

/** A note without its raw text (list rows, agent context). */
export const MarketNoteSchema = z.object({
  affected: MarketNoteAffectedSchema,
  /** The market date the note speaks about. */
  asOf: date,
  claims: z.array(MarketNoteClaimSchema).min(1).max(MARKET_NOTE_MAX_CLAIMS),
  id: MarketNoteIdSchema,
  /** Link to the owner's message that supplied the note. */
  ownerMessageUrl: url.nullable(),
  receivedAt: timestamp,
  reviewBy: date,
  source: MarketNoteSourceSchema,
  stance: MarketNoteStanceSchema,
  status: z.enum(MARKET_NOTE_STATUSES),
  theme: line(300),
  updatedAt: timestamp,
  verification: MarketNoteVerificationSchema,
});

export const MarketNoteDetailSchema = MarketNoteSchema.extend({
  /** The transcript or the text as received. Third-party text: untrusted data. */
  rawText: z.string().min(1).max(MARKET_NOTE_RAW_TEXT_MAX),
});

export const MarketNotesListInputSchema = z
  .object({
    /**
     * "active" leaves out expired and retired notes (what agents read): the newest 50. "all" holds
     * those same active notes and then the newest notes of any status, up to MARKET_NOTE_LIST_MAX
     * in total.
     */
    scope: z.enum(MARKET_NOTE_LIST_SCOPES).default("all"),
    /**
     * Only the note stored for this source URL (the server applies its own URL normalization).
     * The intake uses it to skip the download when the note already exists.
     */
    sourceUrl: url.optional(),
  })
  .strict();

export const MarketNotesListOutputSchema = z.object({
  asOf: timestamp,
  /** Newest first by receivedAt. */
  notes: z.array(MarketNoteSchema).max(MARKET_NOTE_LIST_MAX),
  /** The UTC date used to derive "expired". */
  today: date,
  /** True when the store holds older notes of this scope that the answer does not hold. */
  truncated: z.boolean(),
});

export const MarketNotesGetInputSchema = z
  .object({ id: MarketNoteIdSchema })
  .strict();

export const MarketNotesGetOutputSchema = z.object({
  note: MarketNoteDetailSchema,
});

export const MarketNotesAddInputSchema = z
  .object({
    affected: MarketNoteAffectedSchema,
    asOf: date,
    /** Claim texts in order; they become c1, c2, ... and start unverified. */
    claims: z
      .array(claimText)
      .min(1)
      .max(MARKET_NOTE_MAX_CLAIMS)
      .refine(
        (claims) => new Set(claims).size === claims.length,
        "claims must be unique"
      ),
    ownerMessageUrl: url.nullable(),
    rawText: z
      .string()
      .trim()
      .min(1)
      .max(MARKET_NOTE_RAW_TEXT_MAX)
      .refine(isStorableText, STORABLE_TEXT_MESSAGE),
    /**
     * Defaults to the server time. Not before 2000. The server allows a time up to five minutes
     * after its own clock (clock difference of the sender) and refuses a later one.
     */
    receivedAt: timestamp
      .refine(
        (value) => Date.parse(value) >= Date.parse(MARKET_NOTE_DATE_MIN),
        `must not be before ${MARKET_NOTE_DATE_MIN}`
      )
      .optional(),
    reviewBy: date,
    source: MarketNoteSourceSchema,
    stance: MarketNoteStanceSchema,
    theme: line(300),
  })
  .strict()
  .refine((input) => input.reviewBy >= input.asOf, {
    message: "reviewBy must not be before asOf",
    path: ["reviewBy"],
  });

export const MarketNotesAddOutputSchema = z.object({
  /** False when a note with the same source already exists; that note is returned unchanged. */
  created: z.boolean(),
  note: MarketNoteSchema,
});

export const MarketNotesRecordChecksInputSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            claimId: MarketNoteClaimIdSchema,
            evidence: evidenceText,
            status: z.enum(MARKET_NOTE_CHECK_STATUSES),
          })
          .strict()
      )
      .min(1)
      .max(MARKET_NOTE_MAX_CLAIMS)
      .refine(
        (checks) =>
          new Set(checks.map((check) => check.claimId)).size === checks.length,
        "one check per claim"
      ),
    id: MarketNoteIdSchema,
  })
  .strict();

export const MarketNotesReviewInputSchema = z
  .object({
    action: z.discriminatedUnion("kind", [
      /**
       * Sets a new review date: today (UTC) or later, not before the note's asOf and at most
       * MARKET_NOTE_REVIEW_MAX_DAYS after today. An expired note becomes active again.
       */
      z.object({ kind: z.literal("renew"), reviewBy: date }).strict(),
      /** Final: a retired note cannot be renewed. */
      z.object({ kind: z.literal("retire") }).strict(),
    ]),
    id: MarketNoteIdSchema,
  })
  .strict();

export const MarketNoteOutputSchema = z.object({ note: MarketNoteSchema });

export type MarketNote = z.infer<typeof MarketNoteSchema>;
export type MarketNoteAffected = z.infer<typeof MarketNoteAffectedSchema>;
export type MarketNoteClaim = z.infer<typeof MarketNoteClaimSchema>;
export type MarketNoteDetail = z.infer<typeof MarketNoteDetailSchema>;
export type MarketNoteSource = z.infer<typeof MarketNoteSourceSchema>;
export type MarketNoteStance = z.infer<typeof MarketNoteStanceSchema>;
export type MarketNoteVerification = z.infer<
  typeof MarketNoteVerificationSchema
>;
export type MarketNotesAddInput = z.infer<typeof MarketNotesAddInputSchema>;
export type MarketNotesListOutput = z.infer<typeof MarketNotesListOutputSchema>;

export const MARKET_NOTES_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Market note not found", status: 404 },
  STORAGE_ERROR: { message: "Market notes storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const marketNotes = oc.errors(MARKET_NOTES_API_ERRORS);
const tags = ["Market notes"];

const list = marketNotes
  .route({
    method: "GET",
    operationId: "marketNotes.list",
    path: "/market-notes",
    summary:
      "Owner market notes, newest first, each with its claim statuses and review date",
    tags,
  })
  .input(MarketNotesListInputSchema)
  .output(MarketNotesListOutputSchema);

const get = marketNotes
  .route({
    method: "GET",
    operationId: "marketNotes.get",
    path: "/market-notes/{id}",
    summary: "One owner market note with its raw text",
    tags,
  })
  .input(MarketNotesGetInputSchema)
  .output(MarketNotesGetOutputSchema);

const add = marketNotes
  .route({
    method: "POST",
    operationId: "marketNotes.add",
    path: "/market-notes",
    summary:
      "Rig intake: store one owner market note; a second add of the same source returns the stored note",
    tags,
  })
  .input(MarketNotesAddInputSchema)
  .output(MarketNotesAddOutputSchema);

const recordChecks = marketNotes
  .route({
    method: "POST",
    operationId: "marketNotes.recordChecks",
    path: "/market-notes/{id}/checks",
    summary:
      "Rig verification: record a status and its evidence for claims of one note",
    tags,
  })
  .input(MarketNotesRecordChecksInputSchema)
  .output(MarketNoteOutputSchema);

const review = marketNotes
  .route({
    method: "POST",
    operationId: "marketNotes.review",
    path: "/market-notes/{id}/review",
    summary: "Renew the review date of one note, or retire the note",
    tags,
  })
  .input(MarketNotesReviewInputSchema)
  .output(MarketNoteOutputSchema);

export const marketNotesContract = { add, get, list, recordChecks, review };
