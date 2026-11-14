// What: the pure view-model of the "Owner market notes" card on /markets. It turns the
// marketNotes.list answer into what the card prints: which notes to show and in what order, the
// labels, the verification summary and the claim rows. No React and no I/O.
// Used by: owner-market-notes-card.tsx.
// See: packages/api/src/contracts/market-notes.ts (the contract), docs/vertex-rebuild/market-notes.md.
import type {
  MarketNote,
  MarketNoteAffected,
  MarketNoteClaim,
  MarketNoteSource,
  MarketNoteStance,
  MarketNotesListOutput,
  MarketNoteVerification,
} from "@darkfactory/api";

/** The StatusBadge tones of @darkfactory/ui. A label always goes with the tone. */
export type OwnerMarketNoteTone =
  | "destructive"
  | "info"
  | "neutral"
  | "success"
  | "warning";

export interface OwnerMarketNoteBadge {
  readonly label: string;
  readonly tone: OwnerMarketNoteTone;
}

export interface OwnerMarketNoteClaimView {
  /** Null while the claim is unverified. */
  readonly check: Readonly<{ checkedOn: string; evidence: string }> | null;
  readonly id: string;
  readonly status: MarketNoteClaim["status"];
  readonly statusLabel: string;
  readonly text: string;
  readonly tone: OwnerMarketNoteTone;
}

export interface OwnerMarketNoteSourceView {
  /** The source URL when it is an http(s) link; the card opens it in a new tab. */
  readonly href: string | null;
  readonly label: string;
}

export interface OwnerMarketNoteAffectedGroup {
  readonly label: "Sectors" | "Strategies" | "Tickers";
  readonly values: readonly string[];
}

export interface OwnerMarketNoteView {
  /** Only the groups that list something. */
  readonly affected: readonly OwnerMarketNoteAffectedGroup[];
  readonly asOf: string;
  readonly claims: readonly OwnerMarketNoteClaimView[];
  readonly id: string;
  /** The UTC date of receivedAt. */
  readonly receivedOn: string;
  readonly reviewBy: string;
  readonly source: OwnerMarketNoteSourceView;
  /** Set for an expired note (the review date passed); null for an active one. */
  readonly stale: Readonly<{ label: string; notice: string }> | null;
  readonly stanceLabel: string;
  readonly theme: string;
  readonly verificationBadge: OwnerMarketNoteBadge;
  readonly verificationSummary: string;
}

export interface OwnerMarketNotesView {
  /** Set when no note is shown; it names why. */
  readonly emptyText: string | null;
  /** When the shown answer was loaded, for example "Showing notes loaded at 14:00 UTC." */
  readonly loadedLine: string;
  /** Active notes first, then expired ones; each group keeps the server order (newest first). */
  readonly notes: readonly OwnerMarketNoteView[];
  readonly retiredCount: number;
  /** Retired notes are not listed; this line counts them. Null when there are none. */
  readonly retiredLine: string | null;
  /** The UTC date the server used to derive "expired". */
  readonly today: string;
  /** Set when the answer leaves out older notes; it always holds the newest 50 active notes. */
  readonly truncatedLine: string | null;
}

export const STALE_NOTE_LABEL = "Stale: review date passed";
export const STALE_NOTE_NOTICE =
  "Left out of agent context until the review date is renewed.";
export const NO_NOTES_TEXT = "No owner market notes yet.";
export const ONLY_RETIRED_NOTES_TEXT = "No active or stale owner market notes.";
const TRUNCATED_NOTES_TEXT = "Older expired and retired notes are not listed.";

const CLAIM_STATUS: Readonly<
  Record<MarketNoteClaim["status"], OwnerMarketNoteBadge>
> = {
  "cannot-check": { label: "Cannot check", tone: "neutral" },
  contradicted: { label: "Contradicted", tone: "destructive" },
  supported: { label: "Supported", tone: "success" },
  unverified: { label: "Unverified", tone: "warning" },
};

const SOURCE_KIND_LABEL: Readonly<Record<MarketNoteSource["kind"], string>> = {
  article: "Article",
  "owner-text": "Owner text",
  reel: "Reel",
};

const STANCE_LABEL: Readonly<Record<MarketNoteStance["direction"], string>> = {
  neutral: "Neutral",
  "risk-off": "Risk-off",
  "risk-on": "Risk-on",
};

/** The UTC date (YYYY-MM-DD) of an ISO timestamp; text that is not a timestamp is returned as is. */
export const utcDate = (timestamp: string): string => {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds)
    ? timestamp
    : new Date(milliseconds).toISOString().slice(0, 10);
};

/** The UTC time ("HH:MM UTC") of an ISO timestamp; text that is not a timestamp is returned as is. */
export const utcTime = (timestamp: string): string => {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds)
    ? timestamp
    : `${new Date(milliseconds).toISOString().slice(11, 16)} UTC`;
};

/**
 * The URL when it is an http(s) link, else null. The contract already allows only http(s); the
 * source URL comes from third-party content, so the card does not link anything else.
 */
export const httpHref = (url: string | null): string | null => {
  if (url === null) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * For example "Reel by Example Analyst (example.test)". The host is the hostname of the source
 * URL without a leading "www."; a source with no http(s) URL has no host and no link.
 */
export const sourceView = (
  source: MarketNoteSource
): OwnerMarketNoteSourceView => {
  const href = httpHref(source.url);
  return {
    href,
    label: [
      SOURCE_KIND_LABEL[source.kind],
      source.author === null ? null : `by ${source.author}`,
      href === null
        ? null
        : `(${new URL(href).hostname.replace(/^www\./u, "")})`,
    ]
      .filter((part) => part !== null)
      .join(" "),
  };
};

/** For example "Risk-off, medium confidence". */
export const stanceLabel = (stance: MarketNoteStance): string =>
  `${STANCE_LABEL[stance.direction]}, ${stance.confidence} confidence`;

/** Every count in a fixed order: "2 supported, 1 contradicted, 1 cannot check, 3 unverified". */
export const verificationSummary = (
  verification: MarketNoteVerification
): string =>
  [
    `${verification.supported} supported`,
    `${verification.contradicted} contradicted`,
    `${verification.cannotCheck} cannot check`,
    `${verification.unverified} unverified`,
  ].join(", ");

/**
 * "Unverified" when no claim is checked, "Partly checked" when some are, "Checked" when none is
 * left unverified. "Checked" says the checks are done, not that the claims hold: a contradicted
 * claim is counted in the label ("Checked: 1 contradicted"), and the tone is success only when
 * every claim is supported.
 */
export const verificationBadge = (
  verification: MarketNoteVerification
): OwnerMarketNoteBadge => {
  const checked =
    verification.supported +
    verification.contradicted +
    verification.cannotCheck;
  if (checked === 0) return { label: "Unverified", tone: "warning" };
  const stage = verification.unverified > 0 ? "Partly checked" : "Checked";
  if (verification.contradicted > 0)
    return {
      label: `${stage}: ${verification.contradicted} contradicted`,
      tone: "destructive",
    };
  if (verification.unverified > 0) return { label: stage, tone: "info" };
  return {
    label: stage,
    tone: verification.supported === checked ? "success" : "neutral",
  };
};

export const claimView = (claim: MarketNoteClaim): OwnerMarketNoteClaimView => {
  const { label, tone } = CLAIM_STATUS[claim.status];
  return {
    check:
      claim.status === "unverified"
        ? null
        : { checkedOn: utcDate(claim.checkedAt), evidence: claim.evidence },
    id: claim.id,
    status: claim.status,
    statusLabel: label,
    text: claim.text,
    tone,
  };
};

export const affectedGroups = (
  affected: MarketNoteAffected
): readonly OwnerMarketNoteAffectedGroup[] =>
  (
    [
      { label: "Tickers", values: affected.tickers },
      { label: "Sectors", values: affected.sectors },
      { label: "Strategies", values: affected.strategies },
    ] as const
  ).filter((group) => group.values.length > 0);

export const noteView = (note: MarketNote): OwnerMarketNoteView => ({
  affected: affectedGroups(note.affected),
  asOf: note.asOf,
  claims: note.claims.map(claimView),
  id: note.id,
  receivedOn: utcDate(note.receivedAt),
  reviewBy: note.reviewBy,
  source: sourceView(note.source),
  stale:
    note.status === "expired"
      ? { label: STALE_NOTE_LABEL, notice: STALE_NOTE_NOTICE }
      : null,
  stanceLabel: stanceLabel(note.stance),
  theme: note.theme,
  verificationBadge: verificationBadge(note.verification),
  verificationSummary: verificationSummary(note.verification),
});

const retiredLine = (count: number): string | null => {
  if (count === 0) return null;
  return count === 1
    ? "1 retired note is not shown."
    : `${count} retired notes are not shown.`;
};

const emptyText = (shown: number, retired: number): string | null => {
  if (shown > 0) return null;
  return retired === 0 ? NO_NOTES_TEXT : ONLY_RETIRED_NOTES_TEXT;
};

export const buildOwnerMarketNotesView = (
  output: MarketNotesListOutput
): OwnerMarketNotesView => {
  const withStatus = (status: MarketNote["status"]) =>
    output.notes.filter((note) => note.status === status);
  const notes = [...withStatus("active"), ...withStatus("expired")].map(
    noteView
  );
  const retiredCount = withStatus("retired").length;
  return {
    emptyText: emptyText(notes.length, retiredCount),
    loadedLine: `Showing notes loaded at ${utcTime(output.asOf)}.`,
    notes,
    retiredCount,
    retiredLine: retiredLine(retiredCount),
    today: output.today,
    truncatedLine: output.truncated ? TRUNCATED_NOTES_TEXT : null,
  };
};
