import {
  VertexResearchChatPrepareResponseInputSchema,
  type VertexResearchChatPrepareResponseInput,
  type VertexResearchChatPrepareResponseOutput,
  type VertexResearchChatNativeEvidencePrepareOutput,
  type VertexResearchChatReadTranscriptPageOutput,
  type VertexResearchChatTranscriptMessage,
  type VertexResearchChatAgentReferenceMessage,
  type VertexResearchChatReadResponseContentOutput,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";

import type {
  ResearchDebatePreview,
  ResearchDebateControls,
} from "./research-chat-debate.ts";
export type ResearchHumanMessage = Exclude<
  VertexResearchChatTranscriptMessage,
  VertexResearchChatAgentReferenceMessage
>;
export type ResearchResponsePreview =
  | Extract<
      VertexResearchChatPrepareResponseOutput,
      { status: "prepared" }
    >["preview"]
  | ResearchDebatePreview
  | Extract<
      VertexResearchChatNativeEvidencePrepareOutput,
      { status: "prepared" }
    >["preview"];
export type ResearchPrivateBody = Extract<
  VertexResearchChatReadResponseContentOutput,
  { status: "available" }
>;
export type ResearchPreparedCandidate = Readonly<{
  preview: ResearchResponsePreview;
  messages: readonly ResearchHumanMessage[];
  recordDigests: readonly string[];
  selectionKey: string;
  deadline: number;
}>;
export interface ResearchConversationControls {
  readonly start: string;
  readonly end: string;
  readonly query: string;
  readonly expertId: string;
  readonly busy: boolean;
  readonly locked: boolean;
  readonly candidate: ResearchPreparedCandidate | null;
  readonly status: string;
  readonly operationKey: string | null;
  readonly canAppend: boolean;
  readonly debate?: ResearchDebateControls;
  readonly onSelectionChange: (
    field: "start" | "end" | "query" | "expertId",
    value: string
  ) => void;
  readonly onPrepare: () => void;
  readonly onApprove: () => void;
  readonly onInspect: () => void;
  readonly onAppend: () => void;
}
export type ResearchPrivateView = Readonly<{
  referenceId: string | null;
  status: "idle" | "loading" | "available" | "unavailable";
  value: ResearchPrivateBody | null;
}>;

// This bound is a local revalidation interval, NOT a grant or revocation lease.
const RESEARCH_CONTENT_FRESHNESS_MS = 15_000;
export const researchDeadline = (
  checkedAt: string,
  notAfter: string,
  requestStart: number,
  requestWall: number,
  maximumMs = RESEARCH_CONTENT_FRESHNESS_MS
): number => {
  try {
    const checked = timestampToEpochNanoseconds(checkedAt);
    const end = timestampToEpochNanoseconds(notAfter);
    const wall = BigInt(Math.ceil(requestWall)) * 1_000_000n;
    const lifetime = end - checked;
    const wallRemaining = end - wall;
    const maximum = BigInt(Math.floor(maximumMs)) * 1_000_000n;
    const bound = lifetime < wallRemaining ? lifetime : wallRemaining;
    const bounded = bound < maximum ? bound : maximum;
    if (!Number.isFinite(requestStart) || bounded <= 0n) return requestStart;
    // Round DOWN fractional milliseconds; response latency consumes this bound.
    return requestStart + Number(bounded / 1_000_000n);
  } catch {
    return requestStart;
  }
};

export type ResearchLifetime = Readonly<{
  deadline: number;
  wallDeadline: number;
}>;
// Both deadlines are fixed at the ORIGINAL request start, never at arrival.
// Wall progress during OS suspend closes a paused monotonic window; wall
// rollback cannot extend the independent monotonic cap.
export const researchLifetime = (
  checkedAt: string,
  notAfter: string,
  requestStart: number,
  requestWall: number,
  maximumMs = RESEARCH_CONTENT_FRESHNESS_MS
): ResearchLifetime => {
  const deadline = researchDeadline(
    checkedAt,
    notAfter,
    requestStart,
    requestWall,
    maximumMs
  );
  const duration = Math.max(0, Math.floor(deadline - requestStart));
  return Object.freeze({
    deadline,
    wallDeadline: Math.floor(requestWall) + duration,
  });
};

export const researchLifetimeCurrent = (
  lifetime: ResearchLifetime,
  monotonicNow: number,
  wallNow: number
): boolean => {
  return (
    Number.isFinite(lifetime.deadline) &&
    Number.isFinite(lifetime.wallDeadline) &&
    Number.isFinite(monotonicNow) &&
    Number.isFinite(wallNow) &&
    monotonicNow < lifetime.deadline &&
    wallNow < lifetime.wallDeadline
  );
};

export const researchLifetimeRemaining = (
  lifetime: ResearchLifetime,
  monotonicNow: number,
  wallNow: number
): number => {
  if (!researchLifetimeCurrent(lifetime, monotonicNow, wallNow)) return 0;
  return Math.max(
    0,
    Math.floor(
      Math.min(
        lifetime.deadline - monotonicNow,
        lifetime.wallDeadline - wallNow
      )
    )
  );
};

export const selectResearchHumanWindow = (
  page: VertexResearchChatReadTranscriptPageOutput,
  start: string,
  end: string
): readonly ResearchHumanMessage[] => {
  if (!(/^[1-9][0-9]{0,29}$/u.test(start) && /^[1-9][0-9]{0,29}$/u.test(end)))
    throw new Error("Choose both original human sequence numbers.");
  const low = BigInt(start),
    high = BigInt(end);
  if (high < low || high - low >= 16n || high > BigInt(page.highWaterSequence))
    throw new Error(
      "Choose one contiguous window of 1–16 human messages in this snapshot."
    );
  const window = page.items.filter(
    (message) =>
      BigInt(message.sequence) >= low && BigInt(message.sequence) <= high
  );
  if (BigInt(window.length) !== high - low + 1n)
    throw new Error(
      "The complete selected window must be on this loaded page."
    );
  if (
    !window.every(
      (message, index) =>
        message.kind === "statement" &&
        message.author.kind === "user" &&
        message.author.actorId === page.thread.ownerActorId &&
        message.threadId === page.thread.threadId &&
        BigInt(message.sequence) === low + BigInt(index)
    )
  )
    throw new Error(
      "Agent references cannot enter human context. Select a contiguous human-only window; no gaps are removed."
    );
  return Object.freeze(window as ResearchHumanMessage[]);
};

export const researchResponseRequest = (
  page: VertexResearchChatReadTranscriptPageOutput,
  start: string,
  end: string,
  participantId: string,
  retrievalQuery: string,
  idempotencyKey: string
): VertexResearchChatPrepareResponseInput => {
  const messages = selectResearchHumanWindow(page, start, end);
  return VertexResearchChatPrepareResponseInputSchema.parse({
    accountAlias: page.thread.accountAlias,
    environment: "research",
    threadId: page.thread.threadId,
    parentMessageId: messages.at(-1)?.messageId,
    participantId,
    snapshotRevision: (BigInt(end) + 1n).toString(),
    contextStartSequence: start,
    retrievalQuery,
    idempotencyKey,
  });
};

export const bindResearchPreview = async (
  preview: ResearchResponsePreview,
  request: ResearchResponsePreview["request"],
  messages: readonly ResearchHumanMessage[]
): Promise<readonly string[]> => {
  if (
    canonicalArtifactJson(preview.request) !== canonicalArtifactJson(request) ||
    preview.context.messageIds.length !== messages.length ||
    !messages.every(
      (message, index) =>
        message.messageId === preview.context.messageIds[index] &&
        BigInt(message.sequence) ===
          BigInt(request.contextStartSequence) + BigInt(index)
    )
  )
    throw new Error(
      "The prepared context does not match the displayed human window."
    );
  if ("protocol" in request) {
    if (
      !("nativeEvidence" in preview) ||
      request.protocol !== "first-mate-read-reviewed-evidence-v1" ||
      request.participantId !== "first-mate" ||
      "debate" in request ||
      "debate" in preview ||
      preview.nativeEvidence.profile !== request.protocol
    )
      throw new Error(
        "The bounded native evidence preview does not match the selected protocol."
      );
  } else if ("nativeEvidence" in preview) {
    throw new Error(
      "A native evidence plan requires separately selected protocol consent."
    );
  }
  // Per-record digests describe the exact displayed immutable human records.
  // The server's whole-context digest also binds private persona fields; do not
  // pretend to reconstruct that hidden context or use a digest as consent.
  const digests = Object.freeze(
    await Promise.all(
      messages.map((message) => hashArtifact(canonicalArtifactJson(message)))
    )
  );
  if ("debate" in preview) {
    const window = {
      threadId: request.threadId,
      parentMessageId: request.parentMessageId,
      snapshotRevision: request.snapshotRevision,
      contextStartSequence: request.contextStartSequence,
      messages: messages.map((message, index) => ({
        message_id: message.messageId,
        sequence: message.sequence,
        record_sha256: digests[index],
        author: { kind: "user", actor_id: message.author.actorId },
        body: message.body,
      })),
    };
    if (
      (await hashArtifact(canonicalArtifactJson(window))) !==
      preview.debate.humanWindowSha256
    )
      throw new Error(
        "The debate human-window pin does not match the original displayed records."
      );
  }
  return digests;
};
