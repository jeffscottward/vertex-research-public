import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexPrincipal,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import { DigestSchema, IdentifierSchema } from "../contracts/vertex.ts";
import { VertexCursorSchema } from "../contracts/vertex-experience.ts";
import {
  VertexResearchChatRosterInputSchema,
  VertexResearchChatRosterOutputSchema,
  VertexResearchChatListThreadsInputSchema,
  VertexResearchChatListThreadsOutputSchema,
  VertexResearchChatCreateThreadInputSchema,
  VertexResearchChatThreadSchema,
  VertexResearchChatReadThreadInputSchema,
  VertexResearchChatReadThreadOutputSchema,
  VertexResearchChatListMessagesInputSchema,
  VertexResearchChatListMessagesOutputSchema,
  VertexResearchChatReadTranscriptPageInputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatSendMessageInputSchema,
  VertexResearchChatSendMessageOutputSchema,
  VertexResearchChatMessageSchema,
  VertexResearchChatRosterEntrySchema,
  VertexResearchChatOrdinalSchema,
  type VertexResearchChatRosterEntry,
  type VertexResearchChatThread,
  type VertexResearchChatMessage,
  VertexResearchChatTranscriptMessageSchema,
  type VertexResearchChatTranscriptMessage,
} from "../contracts/vertex-research-chat.ts";
import {
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatResponseReceiptSchema,
  VertexResearchChatReadResponseOutputSchema,
  type VertexResearchChatReadResponseInput,
  type VertexResearchChatResponseReceipt,
} from "../contracts/vertex-research-chat-response.ts";
import {
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatCopyCleanupReceiptSchema,
  type VertexResearchChatReadCopyCleanupInput,
  type VertexResearchChatCopyCleanupReceipt,
} from "../contracts/vertex-research-chat-copy-cleanup.ts";
import {
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import {
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatReadDebateRunInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
} from "../contracts/vertex-research-chat-debate.ts";
import {
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import { VertexResearchChatNativeEvidencePrepareOutputSchema } from "../contracts/vertex-research-chat-conversation.ts";
import {
  VertexResearchChatDebatePrepareOutputSchema,
  VertexResearchChatExecutionPrepareOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import type { VertexResearchChatConversationService } from "./vertex-research-chat-conversation-runtime.ts";
import {
  authorizeVertex,
  checkVertexCancellation,
  failVertex,
  requireVertexScope,
  sameVertexScope,
  vertexActor,
  vertexInput,
  vertexOperation,
  vertexPorts,
  vertexSource,
  vertexNow,
  type VertexExperienceDependencies,
} from "./vertex-experience-core.ts";
import { present } from "./present.ts";

const envelope = Object.freeze({
  schemaVersion: "1.0.0" as const,
  executionAuthorized: false as const,
});
// Configuration planning only: corpus-based research perspectives, not people
// attending a room, endorsement, measured completeness, or runnable agents.
const configuredExperts: readonly (readonly [string, string, string])[] = [
  ["jan-smolen", "Jan Smolen", "Discretionary macro and sentiment"],
  ["imre-gams", "Imre Gams", "Process, psychology and risk"],
  ["fabio-valentini", "Fabio Valentini", "Order-flow Nasdaq futures"],
  ["andrea-cimitan", "Andrea Cimitan", "Liquidity, auction and footprint"],
  ["patrick-nill", "Patrick Nill", "Process, futures and swing"],
  ["tom-vorwald", "Tom Vorwald", "Auction and price-volume"],
  ["fredy-sarmiento", "Fredy Sarmiento", "Order flow, options and gamma"],
  ["matteo-conti", "Matteo Conti", "Systematic research and validation"],
  ["serge-hoffmann", "Serge Hoffmann", "Orderbook and tape scalping"],
  [
    "lars-schmeldtenkopf",
    "Lars Schmeldtenkopf",
    "Macro, technical and volatility timing",
  ],
  ["brandon-kioseff", "Brandon Kioseff", "Pine and quantitative profiles"],
  ["enrico-stucchi", "Enrico Stucchi", "Microstructure and DOM"],
  ["deltatrend", "DeltaTrend", "Configured corpus-based research perspective"],
  [
    "verrillo-aleks",
    "Verrillo-Aleks",
    "Configured corpus-based research perspective",
  ],
  [
    "nicholas-crown",
    "Nicholas Crown",
    "Configured corpus-based research perspective",
  ],
  [
    "defineyourrisk",
    "DefineYourRisk",
    "Configured corpus-based research perspective",
  ],
];
const roster: readonly VertexResearchChatRosterEntry[] = Object.freeze([
  ...configuredExperts.map(([participantId, displayName, specialty]) =>
    VertexResearchChatRosterEntrySchema.parse({
      participantId,
      displayName,
      specialty,
      kind: "expert",
      availability: "unavailable",
      reasonCodes: ["corpus-not-qualified"],
      corpus: {
        status: "incomplete",
        collectionId: null,
        snapshotSha256: null,
        reviewId: null,
      },
    })
  ),
  VertexResearchChatRosterEntrySchema.parse({
    participantId: "first-mate",
    displayName: "First Mate",
    specialty: "Research-room coordination tools are not integrated",
    kind: "first-mate",
    availability: "unavailable",
    reasonCodes: ["tools-not-integrated"],
    corpus: {
      status: "unknown",
      collectionId: null,
      snapshotSha256: null,
      reviewId: null,
    },
  }),
]);
const participantsFor = (
  ids: readonly string[],
  source = false
): readonly VertexResearchChatRosterEntry[] =>
  ids.map((id) => {
    const participant = roster.find((entry) => entry.participantId === id);
    if (!participant)
      return failVertex(source ? "INVALID_SOURCE" : "BAD_REQUEST");
    return participant;
  });
const selectedScope = (
  input: Readonly<{ accountAlias: string; environment: "research" }>
): VertexScope =>
  Object.freeze({
    accountAlias: input.accountAlias,
    environment: input.environment,
  });
const authorizeChat = async (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  scope: VertexScope,
  write = false
): Promise<VertexPrincipal> => {
  const actor = await requireVertexScope(dependencies, principal, scope);
  await authorizeVertex(dependencies, actor, scope, "research-chat", "read");
  if (write)
    await authorizeVertex(
      dependencies,
      actor,
      scope,
      "research-chat",
      "publish"
    );
  return actor;
};
const checkedThread = (
  raw: unknown,
  actor: VertexPrincipal,
  scope: VertexScope,
  threadId?: string
): VertexResearchChatThread => {
  const value = vertexSource(VertexResearchChatThreadSchema, raw);
  if (
    value.ownerActorId !== actor.actorId ||
    !sameVertexScope(value, scope) ||
    (threadId !== undefined && value.threadId !== threadId)
  )
    return failVertex("INVALID_SOURCE");
  participantsFor(value.participantIds, true);
  return value;
};
const readOwnedThread = async (
  dependencies: VertexExperienceDependencies,
  actor: VertexPrincipal,
  scope: VertexScope,
  threadId: string
): Promise<VertexResearchChatThread> => {
  const raw = await vertexOperation(dependencies, () =>
    vertexPorts(dependencies).store.readResearchChatThread(
      actor,
      scope,
      threadId
    )
  );
  if (raw === null) return failVertex("NOT_FOUND");
  return checkedThread(raw, actor, scope, threadId);
};
const checkedMessage = (
  raw: unknown,
  actor: VertexPrincipal,
  threadId: string
): VertexResearchChatMessage => {
  const value = vertexSource(VertexResearchChatMessageSchema, raw);
  // This integration admits only human statements. Agent records/citations need
  // a separately reviewed run/publication boundary, not an adapter assertion.
  if (
    value.threadId !== threadId ||
    value.author.kind !== "user" ||
    value.author.actorId !== actor.actorId ||
    value.kind !== "statement" ||
    value.citations.length !== 0
  )
    return failVertex("INVALID_SOURCE");
  return value;
};
const checkedTranscriptMessage = (
  raw: unknown,
  actor: VertexPrincipal,
  thread: VertexResearchChatThread
): VertexResearchChatTranscriptMessage => {
  const value = vertexSource(VertexResearchChatTranscriptMessageSchema, raw);
  if (value.kind !== "advisory-reference") {
    const message = checkedMessage(value, actor, thread.threadId);
    // checkedMessage already admits only human statements; narrow for the type.
    if (message.author.kind !== "user" || message.kind !== "statement")
      return failVertex("INVALID_SOURCE");
    return Object.freeze({
      ...message,
      author: message.author,
      kind: message.kind,
    });
  }
  if (
    value.threadId !== thread.threadId ||
    !thread.participantIds.includes(value.author.participantId)
  )
    return failVertex("INVALID_SOURCE");
  return value;
};
const digest = (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));
const ordinalBefore = (left: string, right: string): boolean =>
  left.length < right.length || (left.length === right.length && left < right);
const CursorSchema = z
  .object({ version: z.literal(1), binding: DigestSchema, after: z.string() })
  .strict();
const ThreadPageSchema = z
  .object({
    items: z.array(VertexResearchChatThreadSchema).max(100),
    nextCursor: VertexCursorSchema,
  })
  .strict();
const MessagePageSchema = z
  .object({
    items: z.array(VertexResearchChatTranscriptMessageSchema).max(100),
    nextCursor: VertexCursorSchema,
  })
  .strict();
type ChatPage = Readonly<{ limit: number; cursor: string | null }>;
type ChatOrder = "listThreads" | "listMessages";
const cursorAfter = (
  cursor: string | null,
  binding: string,
  order: ChatOrder,
  source = false
): string | null => {
  if (cursor === null) return null;
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const value = CursorSchema.parse(JSON.parse(text));
    const canonical = btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/[=]+$/u, "");
    if (canonical !== cursor || value.binding !== binding)
      throw new TypeError("Invalid cursor");
    if (order === "listThreads") {
      IdentifierSchema.parse(value.after);
    } else VertexResearchChatOrdinalSchema.parse(value.after);
    return value.after;
  } catch {
    return failVertex(source ? "INVALID_SOURCE" : "BAD_REQUEST");
  }
};
const pageState = async (
  actor: VertexPrincipal,
  scope: VertexScope,
  threadId: string | null,
  input: ChatPage,
  operation: ChatOrder
) => {
  const binding = await digest({
    operation,
    actorId: actor.actorId,
    scope,
    threadId,
    limit: input.limit,
  });
  return { binding, after: cursorAfter(input.cursor, binding, operation) };
};
const checkPage = (
  ids: readonly string[],
  nextCursor: string | null,
  input: ChatPage,
  state: Readonly<{ binding: string; after: string | null }>,
  operation: ChatOrder
): void => {
  if (ids.length > input.limit || new Set(ids).size !== ids.length)
    failVertex("INVALID_SOURCE");
  const before =
    operation === "listThreads"
      ? (left: string, right: string) => left < right
      : ordinalBefore;
  for (let index = 0; index < ids.length; index += 1) {
    const previous = index === 0 ? state.after : present(ids[index - 1]);
    if (previous !== null && !before(previous, present(ids[index])))
      failVertex("INVALID_SOURCE");
  }
  const next = cursorAfter(nextCursor, state.binding, operation, true);
  if (
    next !== null &&
    (ids.length !== input.limit ||
      ids.length === 0 ||
      next !== ids.at(-1) ||
      nextCursor === input.cursor)
  )
    failVertex("INVALID_SOURCE");
};

// This additive cursor is deliberately incompatible with listMessages. Its
// digest correlates the complete fixed boundary; it grants no read permission.
const TranscriptCursorSchema = z
  .object({
    version: z.literal(2),
    operation: z.literal("readTranscriptPage"),
    binding: DigestSchema,
    after: VertexResearchChatOrdinalSchema,
    snapshotRevision: VertexResearchChatOrdinalSchema,
    highWaterSequence: z
      .string()
      .max(30)
      .regex(/^(0|[1-9][0-9]{0,29})$/u)
      .refine((value) => value.trim() === value),
  })
  .strict();
const transcriptCursorState = async (
  cursor: string | null,
  actor: VertexPrincipal,
  scope: VertexScope,
  threadId: string,
  limit: number,
  source = false
) => {
  if (cursor === null) return null;
  try {
    const value = TranscriptCursorSchema.parse(
      JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")))
    );
    const canonical = btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/[=]+$/u, "");
    const { operation, version, after, snapshotRevision, highWaterSequence } =
      value;
    const binding = await digest({
      operation,
      version,
      actorId: actor.actorId,
      scope,
      threadId,
      limit,
      after,
      snapshotRevision,
      highWaterSequence,
    });
    if (
      canonical !== cursor ||
      binding !== value.binding ||
      BigInt(after) >= BigInt(highWaterSequence) ||
      BigInt(snapshotRevision) !== BigInt(highWaterSequence) + 1n
    )
      throw new TypeError("Invalid transcript cursor");
    return value;
  } catch {
    return failVertex(source ? "INVALID_SOURCE" : "BAD_REQUEST");
  }
};

// Every public entry captures strict input before its first await, including
// readonly detached participant arrays; no raw title/body is logged or prompted.
export const getResearchChatRoster = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatRosterInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const advisory = conversation
      ? await conversation.readFirstMateAdvisoryConfiguration(actor, scope)
      : {
          status: "unavailable" as const,
          authorization: "requires-governed-prepare" as const,
          reasonCodes: ["first-mate-configuration-unavailable" as const],
        };
    const participants = roster.map((entry) =>
      entry.kind === "first-mate" ? { ...entry, advisory } : entry
    );
    return vertexSource(VertexResearchChatRosterOutputSchema, {
      ...envelope,
      ...scope,
      participants,
    });
  });
export const listResearchChatThreads = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatListThreadsInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const page = Object.freeze({ limit: input.limit, cursor: input.cursor });
    const state = await pageState(actor, scope, null, page, "listThreads");
    const result = vertexSource(
      ThreadPageSchema,
      await vertexOperation(dependencies, () =>
        vertexPorts(dependencies).store.listResearchChatThreads(
          actor,
          scope,
          page
        )
      )
    );
    const items = result.items.map((value) =>
      checkedThread(value, actor, scope)
    );
    checkPage(
      items.map((value) => value.threadId),
      result.nextCursor,
      page,
      state,
      "listThreads"
    );
    return vertexSource(VertexResearchChatListThreadsOutputSchema, {
      ...envelope,
      ...scope,
      items,
      nextCursor: result.nextCursor,
    });
  });
export const createResearchChatThread = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatCreateThreadInputSchema, raw)
    );
    participantsFor(input.participantIds);
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope, true);
    const threadId = `chat-${await digest({ operation: "createThread", actorId: actor.actorId, scope, idempotencyKey: input.idempotencyKey })}`;
    const value = checkedThread(
      await vertexOperation(dependencies, () =>
        vertexPorts(dependencies).store.createResearchChatThread({
          principal: actor,
          scope,
          title: input.title,
          participantIds: input.participantIds,
          idempotencyKey: input.idempotencyKey,
        })
      ),
      actor,
      scope,
      threadId
    );
    if (
      value.title !== input.title ||
      canonicalArtifactJson(value.participantIds) !==
        canonicalArtifactJson(input.participantIds) ||
      value.revision !== "1" ||
      value.createdAt !== value.updatedAt
    )
      return failVertex("INVALID_SOURCE");
    return value;
  });
export const readResearchChatThread = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatReadThreadInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const thread = await readOwnedThread(
      dependencies,
      actor,
      scope,
      input.threadId
    );
    return vertexSource(VertexResearchChatReadThreadOutputSchema, {
      ...envelope,
      thread,
      participants: participantsFor(thread.participantIds, true),
    });
  });
export const listResearchChatMessages = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatListMessagesInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const thread = await readOwnedThread(
      dependencies,
      actor,
      scope,
      input.threadId
    );
    const page = Object.freeze({ limit: input.limit, cursor: input.cursor });
    const state = await pageState(
      actor,
      scope,
      input.threadId,
      page,
      "listMessages"
    );
    const result = vertexSource(
      MessagePageSchema,
      await vertexOperation(dependencies, () =>
        vertexPorts(dependencies).store.listResearchChatMessages(
          actor,
          scope,
          input.threadId,
          page
        )
      )
    );
    const items = result.items.map((value) =>
      checkedTranscriptMessage(value, actor, thread)
    );
    checkPage(
      items.map((value) => value.sequence),
      result.nextCursor,
      page,
      state,
      "listMessages"
    );
    return vertexSource(VertexResearchChatListMessagesOutputSchema, {
      ...envelope,
      ...scope,
      threadId: input.threadId,
      items,
      nextCursor: result.nextCursor,
    });
  });
export const readResearchChatTranscriptPage = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatReadTranscriptPageInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const page = Object.freeze({ limit: input.limit, cursor: input.cursor });
    const previous = await transcriptCursorState(
      input.cursor,
      actor,
      scope,
      input.threadId,
      input.limit
    );
    const rawPage = await vertexOperation(dependencies, () =>
      vertexPorts(dependencies).store.readResearchChatTranscriptPage(
        actor,
        scope,
        input.threadId,
        page
      )
    );
    if (rawPage === null) return failVertex("NOT_FOUND");
    const result = vertexSource(
      VertexResearchChatReadTranscriptPageOutputSchema,
      rawPage
    );
    checkedThread(result.thread, actor, scope, input.threadId);
    for (const message of result.items)
      checkedTranscriptMessage(message, actor, result.thread);
    if (result.items.length > input.limit) return failVertex("INVALID_SOURCE");
    if (previous === null) {
      if (result.thread.revision !== result.snapshotRevision)
        return failVertex("INVALID_SOURCE");
    } else if (
      previous.snapshotRevision !== result.snapshotRevision ||
      previous.highWaterSequence !== result.highWaterSequence
    )
      return failVertex("INVALID_SOURCE");
    if (
      result.items.length > 0 &&
      BigInt(present(result.items[0]).sequence) !==
        BigInt(previous?.after ?? "0") + 1n
    )
      return failVertex("INVALID_SOURCE");
    const next = await transcriptCursorState(
      result.nextCursor,
      actor,
      scope,
      input.threadId,
      input.limit,
      true
    );
    if (
      next !== null &&
      (result.items.length !== input.limit ||
        next.after !== result.items.at(-1)?.sequence ||
        next.snapshotRevision !== result.snapshotRevision ||
        next.highWaterSequence !== result.highWaterSequence ||
        result.nextCursor === input.cursor)
    )
      return failVertex("INVALID_SOURCE");
    return result;
  });
export const sendResearchChatMessage = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatSendMessageInputSchema, raw)
    );
    participantsFor(input.requestedParticipantIds);
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope, true);
    const thread = await readOwnedThread(
      dependencies,
      actor,
      scope,
      input.threadId
    );
    if (
      input.requestedParticipantIds.some(
        (id) => !thread.participantIds.includes(id)
      )
    )
      return failVertex("BAD_REQUEST");
    const messageId = `message-${await digest({ operation: "sendMessage", actorId: actor.actorId, scope, threadId: input.threadId, idempotencyKey: input.idempotencyKey })}`;
    checkVertexCancellation(dependencies);
    const output = vertexSource(
      VertexResearchChatSendMessageOutputSchema,
      await vertexOperation(dependencies, () =>
        vertexPorts(dependencies).store.sendResearchChatMessage({
          principal: actor,
          scope,
          threadId: input.threadId,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          body: input.body,
          requestedParticipantIds: input.requestedParticipantIds,
          mode: input.mode,
        })
      )
    );
    const message = checkedMessage(output.message, actor, input.threadId);
    const expectedResponse =
      input.requestedParticipantIds.length === 0
        ? { status: "not-requested", runId: null, jobId: null, reasonCodes: [] }
        : {
            status: "unavailable",
            runId: null,
            jobId: null,
            reasonCodes: ["research-chat-agent-admission-unavailable"],
          };
    if (
      message.messageId !== messageId ||
      message.body !== input.body ||
      message.sequence !== input.expectedRevision ||
      output.threadRevision !==
        (BigInt(input.expectedRevision) + 1n).toString() ||
      canonicalArtifactJson(output.response) !==
        canonicalArtifactJson(expectedResponse)
    )
      return failVertex("INVALID_SOURCE");
    return output;
  });

const responseRequestIdentity = (
  actor: VertexPrincipal,
  scope: VertexScope,
  input: VertexResearchChatReadResponseInput
): Promise<string> => {
  return digest({
    operation: "requestResponse",
    actorId: actor.actorId,
    scope,
    threadId: input.threadId,
    idempotencyKey: input.idempotencyKey,
  }).then((hash) => `response-${hash}`);
};
const checkResponseIdentity = (
  receipt: VertexResearchChatResponseReceipt,
  actor: VertexPrincipal,
  scope: VertexScope,
  input: VertexResearchChatReadResponseInput,
  responseRequestId: string
): void => {
  if (
    receipt.ownerActorId !== actor.actorId ||
    !sameVertexScope(receipt, scope) ||
    receipt.threadId !== input.threadId ||
    receipt.idempotencyKey !== input.idempotencyKey ||
    receipt.responseRequestId !== responseRequestId
  )
    failVertex("INVALID_SOURCE");
};
const checkLegacyResponseReceipt = (
  receipt: VertexResearchChatResponseReceipt
): void => {
  // The old request path remains unavailable-only, never an approval shortcut.
  if (
    receipt.status !== "unavailable" ||
    receipt.admission !== null ||
    receipt.jobId !== null ||
    canonicalArtifactJson(receipt.reasonCodes) !==
      canonicalArtifactJson(["research-runtime-unavailable"])
  )
    failVertex("INVALID_SOURCE");
};

export const requestResearchChatResponse = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatRequestResponseInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope, true);
    const responseRequestId = await responseRequestIdentity(
      actor,
      scope,
      input
    );
    const requestSha256 = await digest({
      operation: "requestResponse",
      actorId: actor.actorId,
      input,
    });
    // The store checks the currently owned thread under its authorization locks.
    // Never pre-read its head/roster or policy here: original-key reconciliation
    // must precede every NEW-request prefix/member/readiness check in that owner.
    const receipt = vertexSource(
      VertexResearchChatResponseReceiptSchema,
      await vertexOperation(dependencies, () =>
        vertexPorts(dependencies).store.requestResearchChatResponse({
          principal: actor,
          scope,
          threadId: input.threadId,
          parentMessageId: input.parentMessageId,
          participantId: input.participantId,
          snapshotRevision: input.snapshotRevision,
          contextStartSequence: input.contextStartSequence,
          retrievalQuery: input.retrievalQuery,
          idempotencyKey: input.idempotencyKey,
        })
      )
    );
    checkResponseIdentity(receipt, actor, scope, input, responseRequestId);
    checkLegacyResponseReceipt(receipt);
    if (
      receipt.parentMessageId !== input.parentMessageId ||
      receipt.participantId !== input.participantId ||
      receipt.snapshotRevision !== input.snapshotRevision ||
      receipt.contextStartSequence !== input.contextStartSequence ||
      receipt.requestSha256 !== requestSha256
    )
      return failVertex("INVALID_SOURCE");
    return receipt;
  });
export const readResearchChatResponse = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input = Object.freeze(
      vertexInput(VertexResearchChatReadResponseInputSchema, raw)
    );
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    const responseRequestId = await responseRequestIdentity(
      actor,
      scope,
      input
    );
    const rawOutput = await vertexOperation(dependencies, () =>
      conversation
        ? conversation.readResponse(actor, input)
        : vertexPorts(dependencies).store.readResearchChatResponse(
            actor,
            scope,
            input.threadId,
            input.idempotencyKey
          )
    );
    // Absence at this instant is not permission to resend with a new key or to
    // recompute: an in-flight original request may commit after this observation.
    if (rawOutput === null) return failVertex("NOT_FOUND");
    const output = vertexSource(
      VertexResearchChatReadResponseOutputSchema,
      rawOutput
    );
    checkResponseIdentity(
      output.receipt,
      actor,
      scope,
      input,
      responseRequestId
    );
    if (!conversation) checkLegacyResponseReceipt(output.receipt);
    return output;
  });

// These are deliberately separate owner actions. A human send or GET never
// approves context/model use, admits work, or appends an agent reference.
const prepareChatStep = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  debate: boolean | "native",
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input =
      debate === "native"
        ? vertexInput(VertexResearchChatNativeEvidenceRequestSchema, raw)
        : debate
          ? vertexInput(VertexResearchChatDebateStepInputSchema, raw)
          : vertexInput(VertexResearchChatPrepareResponseInputSchema, raw);
    const scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope, true);
    await readOwnedThread(dependencies, actor, scope, input.threadId);
    const selector = {
      ...scope,
      environment: "research" as const,
      threadId: input.threadId,
      idempotencyKey: input.idempotencyKey,
    };
    const responseRequestId = await responseRequestIdentity(
      actor,
      scope,
      input
    );
    if (!conversation)
      return vertexSource(VertexResearchChatExecutionPrepareOutputSchema, {
        ...envelope,
        status: "unavailable",
        selector,
        reasonCodes: ["research-runtime-unavailable"],
      });
    const result = vertexSource(
      VertexResearchChatExecutionPrepareOutputSchema,
      await (debate === "native"
        ? conversation.prepareResearchChatNativeEvidence(actor, input)
        : debate
          ? conversation.prepareDebateStep(actor, input)
          : conversation.prepareResponse(actor, input))
    );
    if (result.status === "unavailable") {
      const originalSelector = canonicalArtifactJson(selector);
      if (canonicalArtifactJson(result.selector) !== originalSelector)
        return failVertex("INVALID_SOURCE");
      return result;
    }
    if (
      result.preview.responseRequestId !== responseRequestId ||
      canonicalArtifactJson(result.preview.request) !==
        canonicalArtifactJson(input)
    )
      return failVertex("INVALID_SOURCE");
    const now = vertexNow(dependencies);
    if (
      timestampToEpochNanoseconds(now) <
      timestampToEpochNanoseconds(result.preview.checkedAt)
    )
      return failVertex("CONFLICT");
    if (
      timestampToEpochNanoseconds(result.preview.notAfter) <=
      timestampToEpochNanoseconds(now)
    )
      return vertexSource(VertexResearchChatExecutionPrepareOutputSchema, {
        ...envelope,
        status: "unavailable",
        selector,
        reasonCodes: ["deadline"],
      });
    return result;
  });
export const prepareResearchChatResponse = async (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return vertexSource(
    VertexResearchChatPrepareResponseOutputSchema,
    await prepareChatStep(dependencies, principal, raw, false, conversation)
  );
};
export const prepareResearchChatDebateStep = async (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return vertexSource(
    VertexResearchChatDebatePrepareOutputSchema,
    await prepareChatStep(dependencies, principal, raw, true, conversation)
  );
};
export const prepareResearchChatNativeEvidence = async (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return vertexSource(
    VertexResearchChatNativeEvidencePrepareOutputSchema,
    await prepareChatStep(dependencies, principal, raw, "native", conversation)
  );
};

const approveChatStep = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  debate: boolean | "native",
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input =
      debate === "native"
        ? vertexInput(VertexResearchChatNativeEvidenceApproveInputSchema, raw)
        : debate
          ? vertexInput(VertexResearchChatDebateApproveInputSchema, raw)
          : vertexInput(
              VertexResearchChatApproveAndRequestResponseInputSchema,
              raw
            );
    const scope = selectedScope(input.request);
    const actor = await authorizeChat(dependencies, principal, scope, true);
    await readOwnedThread(dependencies, actor, scope, input.request.threadId);
    const selector = {
      ...scope,
      environment: "research" as const,
      threadId: input.request.threadId,
      idempotencyKey: input.request.idempotencyKey,
    };
    const responseRequestId = await responseRequestIdentity(
      actor,
      scope,
      input.request
    );
    const requestSha256 = await digest({
      operation: "requestResponse",
      actorId: actor.actorId,
      input: input.request,
    });
    if (!conversation)
      return vertexSource(
        VertexResearchChatApproveAndRequestResponseOutputSchema,
        {
          ...envelope,
          status: "blocked",
          selector,
          reasonCodes: ["research-runtime-unavailable"],
        }
      );
    const result = vertexSource(
      VertexResearchChatApproveAndRequestResponseOutputSchema,
      await (debate === "native"
        ? conversation.approveAndRequestResearchChatNativeEvidence(actor, input)
        : debate
          ? conversation.approveAndRequestDebateStep(actor, input)
          : conversation.approveAndRequestResponse(actor, input))
    );
    if (
      canonicalArtifactJson(result.selector) !== canonicalArtifactJson(selector)
    )
      return failVertex("INVALID_SOURCE");
    if (result.status === "recorded") {
      const receipt = result.receipt;
      checkResponseIdentity(
        receipt,
        actor,
        scope,
        input.request,
        responseRequestId
      );
      if (
        receipt.requestSha256 !== requestSha256 ||
        receipt.parentMessageId !== input.request.parentMessageId ||
        receipt.participantId !== input.request.participantId ||
        receipt.snapshotRevision !== input.request.snapshotRevision ||
        receipt.contextStartSequence !== input.request.contextStartSequence
      )
        return failVertex("INVALID_SOURCE");
    }
    return result;
  });
export const approveAndRequestResearchChatResponse = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return approveChatStep(dependencies, principal, raw, false, conversation);
};
export const approveAndRequestResearchChatDebateStep = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return approveChatStep(dependencies, principal, raw, true, conversation);
};
export const approveAndRequestResearchChatNativeEvidence = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) => {
  return approveChatStep(dependencies, principal, raw, "native", conversation);
};
export const readResearchChatDebateRun = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input = vertexInput(VertexResearchChatReadDebateRunInputSchema, raw),
      scope = selectedScope(input);
    const actor = await authorizeChat(dependencies, principal, scope);
    await readOwnedThread(dependencies, actor, scope, input.threadId);
    const result = vertexSource(
      VertexResearchChatReadDebateRunOutputSchema,
      conversation
        ? await conversation.readDebateRun(actor, input)
        : {
            ...envelope,
            status: "unavailable",
            selector: input,
            checkedAt: vertexNow(dependencies),
          }
    );
    if (canonicalArtifactJson(result.selector) !== canonicalArtifactJson(input))
      return failVertex("INVALID_SOURCE");
    const now = vertexNow(dependencies);
    if (
      timestampToEpochNanoseconds(now) <
      timestampToEpochNanoseconds(result.checkedAt)
    )
      return failVertex("CONFLICT");
    if (
      result.status === "available" &&
      timestampToEpochNanoseconds(result.notAfter) <=
        timestampToEpochNanoseconds(now)
    )
      return vertexSource(VertexResearchChatReadDebateRunOutputSchema, {
        ...envelope,
        status: "unavailable",
        selector: input,
        checkedAt: now,
      });
    return result;
  });

export const appendResearchChatResponse = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input = vertexInput(VertexResearchChatAppendResponseInputSchema, raw);
    const scope = selectedScope(input);
    const actor = vertexActor(principal);
    const { expectedRevision, ...selector } = input;
    if (!conversation) {
      const authorizedActor = await authorizeChat(
        dependencies,
        principal,
        scope,
        true
      );
      await readOwnedThread(
        dependencies,
        authorizedActor,
        scope,
        input.threadId
      );
      return vertexSource(VertexResearchChatAppendResponseOutputSchema, {
        ...envelope,
        status: "unavailable",
        selector,
        reasonCodes: ["research-runtime-unavailable"],
      });
    }
    // The concrete owner owns the permission/ownership transaction AND denied
    // original-loss observation; an outer current-grant gate must not bypass it.
    const result = vertexSource(
      VertexResearchChatAppendResponseOutputSchema,
      await conversation.appendResponse(actor, input)
    );
    if (
      canonicalArtifactJson(result.selector) !== canonicalArtifactJson(selector)
    )
      return failVertex("INVALID_SOURCE");
    if (
      result.status === "appended" &&
      (result.message.threadId !== input.threadId ||
        result.message.response.responseRequestId !== input.responseRequestId)
    )
      return failVertex("INVALID_SOURCE");
    return result;
  });

export const readResearchChatResponseContent = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown,
  conversation?: VertexResearchChatConversationService
) =>
  vertexOperation(dependencies, async () => {
    const input = vertexInput(
      VertexResearchChatReadResponseContentInputSchema,
      raw
    );
    const scope = selectedScope(input);
    const actor = vertexActor(principal);
    if (!conversation) {
      const authorizedActor = await authorizeChat(
        dependencies,
        principal,
        scope
      );
      await readOwnedThread(
        dependencies,
        authorizedActor,
        scope,
        input.threadId
      );
      return failVertex("SERVICE_UNAVAILABLE");
    }
    // Do not preempt the concrete denied-owner observer with a separate grant
    // read. It proves current caller scope/ownership before any governed body I/O.
    const result = vertexSource(
      VertexResearchChatReadResponseContentOutputSchema,
      await conversation.readResponseContent(actor, input)
    );
    if (
      result.reference.threadId !== input.threadId ||
      result.reference.messageId !== input.messageId ||
      result.reference.response.responseRequestId !== input.responseRequestId
    )
      return failVertex("INVALID_SOURCE");
    const now = vertexNow(dependencies);
    if (
      timestampToEpochNanoseconds(now) <
      timestampToEpochNanoseconds(result.checkedAt)
    )
      return failVertex("CONFLICT");
    if (
      result.status === "available" &&
      timestampToEpochNanoseconds(result.notAfter) <=
        timestampToEpochNanoseconds(now)
    )
      return vertexSource(VertexResearchChatReadResponseContentOutputSchema, {
        ...envelope,
        status: "unavailable",
        reference: result.reference,
        checkedAt: now,
        reasonCodes: ["deadline"],
      });
    return result;
  });

const checkedCopyCleanupReceipt = (
  raw: unknown,
  actor: VertexPrincipal,
  scope: VertexScope,
  input: VertexResearchChatReadCopyCleanupInput,
  requestSha256: string
): VertexResearchChatCopyCleanupReceipt => {
  const receipt = vertexSource(VertexResearchChatCopyCleanupReceiptSchema, raw);
  if (
    receipt.ownerActorId !== actor.actorId ||
    !sameVertexScope(receipt, scope) ||
    receipt.threadId !== input.threadId ||
    receipt.responseRequestId !== input.responseRequestId ||
    receipt.idempotencyKey !== input.idempotencyKey ||
    receipt.requestSha256 !== requestSha256 ||
    receipt.cleanupRequestId !== `copy-cleanup-${requestSha256}`
  )
    return failVertex("INVALID_SOURCE");
  if (
    canonicalArtifactJson(receipt.targetKinds) !==
    canonicalArtifactJson(["context", "model-input", "derived-output"])
  )
    return failVertex("INVALID_SOURCE");
  return receipt;
};

export const requestResearchChatCopyCleanup = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = vertexInput(
      VertexResearchChatRequestCopyCleanupInputSchema,
      raw
    );
    const actor = vertexActor(principal);
    const scope = selectedScope(input);
    // Cleanup is independent of revoked processing/read/publish/policy grants.
    // The store separately enforces the existing inventory's owner and thread.
    await authorizeVertex(
      dependencies,
      actor,
      scope,
      `research-chat-copies:${input.responseRequestId}`,
      "cleanup-chat-copies",
      null
    );
    const requestSha256 = await digest({
      operation: "requestCopyCleanup",
      actorId: actor.actorId,
      input,
    });
    const rawReceipt = await vertexOperation(dependencies, () =>
      vertexPorts(dependencies).store.requestResearchChatCopyCleanup({
        principal: actor,
        scope,
        threadId: input.threadId,
        responseRequestId: input.responseRequestId,
        idempotencyKey: input.idempotencyKey,
      })
    );
    return checkedCopyCleanupReceipt(
      rawReceipt,
      actor,
      scope,
      input,
      requestSha256
    );
  });
export const readResearchChatCopyCleanup = (
  dependencies: VertexExperienceDependencies,
  principal: SafePrincipal,
  raw: unknown
) =>
  vertexOperation(dependencies, async () => {
    const input = vertexInput(
      VertexResearchChatReadCopyCleanupInputSchema,
      raw
    );
    const actor = vertexActor(principal);
    const scope = selectedScope(input);
    await authorizeVertex(
      dependencies,
      actor,
      scope,
      `research-chat-copies:${input.responseRequestId}`,
      "cleanup-chat-copies",
      null
    );
    const requestSha256 = await digest({
      operation: "requestCopyCleanup",
      actorId: actor.actorId,
      input,
    });
    const rawReceipt = await vertexOperation(dependencies, () =>
      vertexPorts(dependencies).store.readResearchChatCopyCleanup(
        actor,
        scope,
        input.threadId,
        input.responseRequestId,
        input.idempotencyKey
      )
    );
    // This is only the original ACK, never current physical cleanup state.
    if (rawReceipt === null) return failVertex("NOT_FOUND");
    return checkedCopyCleanupReceipt(
      rawReceipt,
      actor,
      scope,
      input,
      requestSha256
    );
  });
