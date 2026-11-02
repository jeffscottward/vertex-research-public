import type { ApiClient } from "@darkfactory/api/client";
import {
  VertexResearchChatCreateThreadInputSchema,
  VertexResearchChatListMessagesInputSchema,
  VertexResearchChatListMessagesOutputSchema,
  VertexResearchChatListThreadsInputSchema,
  VertexResearchChatListThreadsOutputSchema,
  VertexResearchChatReadThreadInputSchema,
  VertexResearchChatReadThreadOutputSchema,
  VertexResearchChatRosterInputSchema,
  VertexResearchChatRosterOutputSchema,
  VertexResearchChatSendMessageInputSchema,
  VertexResearchChatSendMessageOutputSchema,
  VertexResearchChatThreadSchema,
  VertexResearchChatReadTranscriptPageInputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatOrdinalSchema,
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidencePrepareOutputSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseOutputSchema,
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatDebatePrepareOutputSchema,
  VertexResearchChatReadDebateRunInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
  type VertexResearchChatReadResponseInput,
  type VertexResearchChatReadTranscriptPageInput,
  type VertexResearchChatReadTranscriptPageOutput,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import {
  classifyVertexFailure,
  VertexReadError,
} from "../../components/research/vertex-client.ts";
import type { ExperienceResearchChatPort, ExperienceScope } from "./ports.ts";
import {
  assertResearchDebatePreview,
  assertResearchDebateRun,
} from "./research-chat-debate.ts";

const malformed = (): never => {
  throw new VertexReadError("malformed");
};
const checkAbort = (signal: AbortSignal): void => {
  if (signal.aborted) throw new VertexReadError("suspended");
};
const safeFailure = (error: unknown): VertexReadError => {
  try {
    return new VertexReadError(classifyVertexFailure(error).kind);
  } catch {
    // Even a hostile error prototype/accessor must not expose provider text.
    return new VertexReadError("error");
  }
};
const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const parse = <T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
  kind: "invalid" | "malformed"
): T => {
  try {
    // Canonicalization rejects accessors, hidden fields and non-JSON values.
    // Parse the captured bytes, not the caller/provider object a second time.
    const snapshot: unknown = JSON.parse(canonicalArtifactJson(value));
    return freeze(schema.parse(snapshot));
  } catch {
    throw new VertexReadError(kind);
  }
};
const sameScope = (value: ExperienceScope, input: ExperienceScope): void => {
  if (
    value.accountAlias !== input.accountAlias ||
    value.environment !== input.environment
  )
    throw new VertexReadError("malformed");
};
const sameResponseKey = (
  value: VertexResearchChatReadResponseInput,
  input: VertexResearchChatReadResponseInput
): void => {
  sameScope(value, input);
  if (
    value.threadId !== input.threadId ||
    value.idempotencyKey !== input.idempotencyKey
  )
    throw new VertexReadError("malformed");
};
const page = (
  value: {
    readonly items: readonly unknown[];
    readonly nextCursor: string | null;
  },
  input: { readonly limit: number; readonly cursor: string | null }
): void => {
  if (value.items.length > input.limit) throw new VertexReadError("malformed");
  if (
    value.nextCursor !== null &&
    (value.nextCursor === input.cursor || value.items.length === 0)
  )
    throw new VertexReadError("malformed");
};

const TranscriptCursorSchema = z
  .object({
    version: z.literal(2),
    operation: z.literal("readTranscriptPage"),
    binding: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/u),
    after: VertexResearchChatOrdinalSchema,
    snapshotRevision: VertexResearchChatOrdinalSchema,
    highWaterSequence: z
      .string()
      .max(30)
      .regex(/^(0|[1-9][0-9]{0,29})$/u)
      .refine((value) => value.trim() === value),
  })
  .strict();
const transcriptCursor = async (
  cursor: string | null,
  input: VertexResearchChatReadTranscriptPageInput,
  actorId: string
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
    const scope = {
      accountAlias: input.accountAlias,
      environment: input.environment,
    };
    const binding = await hashArtifact(
      canonicalArtifactJson({
        operation,
        version,
        actorId,
        scope,
        threadId: input.threadId,
        limit: input.limit,
        after,
        snapshotRevision,
        highWaterSequence,
      })
    );
    if (
      canonical !== cursor ||
      binding !== value.binding ||
      BigInt(after) >= BigInt(highWaterSequence) ||
      BigInt(snapshotRevision) !== BigInt(highWaterSequence) + 1n
    )
      return malformed();
    return value;
  } catch {
    return malformed();
  }
};
const transcriptPage = async (
  result: VertexResearchChatReadTranscriptPageOutput,
  input: VertexResearchChatReadTranscriptPageInput
): Promise<void> => {
  sameScope(result.thread, input);
  if (result.thread.threadId !== input.threadId) return malformed();
  page(result, input);
  const previous = await transcriptCursor(
    input.cursor,
    input,
    result.thread.ownerActorId
  );
  if (previous === null) {
    if (result.thread.revision !== result.snapshotRevision) return malformed();
  } else if (
    previous.snapshotRevision !== result.snapshotRevision ||
    previous.highWaterSequence !== result.highWaterSequence
  )
    return malformed();
  const first = result.items[0];
  if (
    first !== undefined &&
    BigInt(first.sequence) !== BigInt(previous?.after ?? "0") + 1n
  )
    return malformed();
  const next = await transcriptCursor(
    result.nextCursor,
    input,
    result.thread.ownerActorId
  );
  if (
    next !== null &&
    (result.items.length !== input.limit ||
      next.after !== result.items.at(-1)?.sequence ||
      next.snapshotRevision !== result.snapshotRevision ||
      next.highWaterSequence !== result.highWaterSequence)
  )
    return malformed();
};

// One request, one page, no retained records or background work. Input snapshot,
// schema validation and request-specific acknowledgement checks all share the
// cancellation/error boundary; raw provider text, payload and cause never escape.
const guarded = <Input, Output>(
  inputSchema: { parse: (value: unknown) => Input },
  outputSchema: { parse: (value: unknown) => Output },
  operation: (input: Input, signal: AbortSignal) => Promise<Output>,
  validate: (value: Output, input: Input) => void | Promise<void>
): ((input: Input, signal: AbortSignal) => Promise<Output>) => {
  return async (input, signal) => {
    checkAbort(signal);
    try {
      const selection = parse(inputSchema, input, "invalid");
      checkAbort(signal);
      const response = await operation(selection, signal);
      checkAbort(signal);
      const result = parse(outputSchema, response, "malformed");
      checkAbort(signal);
      await validate(result, selection);
      checkAbort(signal);
      return result;
    } catch (error) {
      checkAbort(signal);
      const failure = safeFailure(error);
      checkAbort(signal);
      throw failure;
    }
  };
};

// Public schemas enforce exact envelopes, message attribution, unique IDs and
// ascending canonical sequence strings. These extra checks bind valid records
// to this request; none supplies actor/grants/timestamps or execution authority.
export const guardResearchChatPort = (
  port: ExperienceResearchChatPort
): ExperienceResearchChatPort =>
  Object.freeze<ExperienceResearchChatPort>({
    roster: guarded(
      VertexResearchChatRosterInputSchema,
      VertexResearchChatRosterOutputSchema,
      (input, signal) => port.roster(input, signal),
      sameScope
    ),
    listThreads: guarded(
      VertexResearchChatListThreadsInputSchema,
      VertexResearchChatListThreadsOutputSchema,
      (input, signal) => port.listThreads(input, signal),
      (result, input) => {
        sameScope(result, input);
        return page(result, input);
      }
    ),
    createThread: guarded(
      VertexResearchChatCreateThreadInputSchema,
      VertexResearchChatThreadSchema,
      (input, signal) => port.createThread(input, signal),
      (result, input) => {
        sameScope(result, input);
        if (
          result.title !== input.title ||
          result.participantIds.length !== input.participantIds.length ||
          result.participantIds.some((id) => !input.participantIds.includes(id))
        )
          return malformed();
        return;
      }
    ),
    readThread: guarded(
      VertexResearchChatReadThreadInputSchema,
      VertexResearchChatReadThreadOutputSchema,
      (input, signal) => port.readThread(input, signal),
      (result, input) => {
        sameScope(result.thread, input);
        if (result.thread.threadId !== input.threadId) return malformed();
        return;
      }
    ),
    listMessages: guarded(
      VertexResearchChatListMessagesInputSchema,
      VertexResearchChatListMessagesOutputSchema,
      (input, signal) => port.listMessages(input, signal),
      (result, input) => {
        sameScope(result, input);
        if (result.threadId !== input.threadId) return malformed();
        return page(result, input);
      }
    ),
    readTranscriptPage: guarded(
      VertexResearchChatReadTranscriptPageInputSchema,
      VertexResearchChatReadTranscriptPageOutputSchema,
      (input, signal) => port.readTranscriptPage(input, signal),
      transcriptPage
    ),
    sendMessage: guarded(
      VertexResearchChatSendMessageInputSchema,
      VertexResearchChatSendMessageOutputSchema,
      (input, signal) => port.sendMessage(input, signal),
      (result, input) => {
        if (
          result.message.threadId !== input.threadId ||
          result.message.body !== input.body ||
          result.message.author.kind !== "user" ||
          result.message.kind !== "statement"
        )
          return malformed();
        // Never coerce ordinals through Number; the output schema bounds overflow.
        if (
          result.threadRevision !==
          (BigInt(input.expectedRevision) + 1n).toString()
        )
          return malformed();
        if (
          (input.requestedParticipantIds.length === 0) !==
          (result.response.status === "not-requested")
        )
          return malformed();
        return;
      }
    ),
    prepareResponse: guarded(
      VertexResearchChatPrepareResponseInputSchema,
      VertexResearchChatPrepareResponseOutputSchema,
      (input, signal) => port.prepareResponse(input, signal),
      (result, input) => {
        if (result.status === "prepared") {
          if (
            canonicalArtifactJson(result.preview.request) !==
            canonicalArtifactJson(input)
          )
            return malformed();
          return;
        }
        return sameResponseKey(result.selector, input);
      }
    ),
    approveAndRequestResponse: guarded(
      VertexResearchChatApproveAndRequestResponseInputSchema,
      VertexResearchChatApproveAndRequestResponseOutputSchema,
      (input, signal) => port.approveAndRequestResponse(input, signal),
      async (result, input) => {
        sameResponseKey(result.selector, input.request);
        if (result.status === "recorded") {
          const receipt = result.receipt;
          const request = input.request;
          sameResponseKey(receipt, request);
          if (
            receipt.parentMessageId !== request.parentMessageId ||
            receipt.participantId !== request.participantId ||
            receipt.snapshotRevision !== request.snapshotRevision ||
            receipt.contextStartSequence !== request.contextStartSequence
          )
            return malformed();
          const requestSha256 = await hashArtifact(
            canonicalArtifactJson(request)
          );
          if (receipt.requestSha256 !== requestSha256) return malformed();
          return;
        }
        return;
      }
    ),
    prepareNativeEvidence: guarded(
      VertexResearchChatNativeEvidenceRequestSchema,
      VertexResearchChatNativeEvidencePrepareOutputSchema,
      (input, signal) => port.prepareNativeEvidence(input, signal),
      (result, input) => {
        if (result.status === "prepared") {
          if (
            canonicalArtifactJson(result.preview.request) !==
              canonicalArtifactJson(input) ||
            result.preview.nativeEvidence.profile !== input.protocol ||
            result.preview.expert.participantId !== "first-mate"
          )
            return malformed();
          return;
        }
        return sameResponseKey(result.selector, input);
      }
    ),
    approveAndRequestNativeEvidence: guarded(
      VertexResearchChatNativeEvidenceApproveInputSchema,
      VertexResearchChatApproveAndRequestResponseOutputSchema,
      (input, signal) => port.approveAndRequestNativeEvidence(input, signal),
      async (result, input) => {
        sameResponseKey(result.selector, input.request);
        if (result.status === "recorded") {
          const receipt = result.receipt,
            request = input.request;
          sameResponseKey(receipt, request);
          if (
            receipt.parentMessageId !== request.parentMessageId ||
            receipt.participantId !== request.participantId ||
            receipt.snapshotRevision !== request.snapshotRevision ||
            receipt.contextStartSequence !== request.contextStartSequence
          )
            return malformed();
          if (
            receipt.requestSha256 !==
            (await hashArtifact(canonicalArtifactJson(request)))
          )
            return malformed();
          return;
        }
        return;
      }
    ),
    prepareDebateStep: guarded(
      VertexResearchChatDebateStepInputSchema,
      VertexResearchChatDebatePrepareOutputSchema,
      (input, signal) => port.prepareDebateStep(input, signal),
      (result, input) => {
        if (result.status === "prepared") {
          return assertResearchDebatePreview(result.preview, input);
        }
        return sameResponseKey(result.selector, input);
      }
    ),
    approveAndRequestDebateStep: guarded(
      VertexResearchChatDebateApproveInputSchema,
      VertexResearchChatApproveAndRequestResponseOutputSchema,
      (input, signal) => port.approveAndRequestDebateStep(input, signal),
      async (result, input) => {
        sameResponseKey(result.selector, input.request);
        if (result.status === "recorded") {
          const receipt = result.receipt,
            request = input.request;
          sameResponseKey(receipt, request);
          if (
            receipt.parentMessageId !== request.parentMessageId ||
            receipt.participantId !== request.participantId ||
            receipt.snapshotRevision !== request.snapshotRevision ||
            receipt.contextStartSequence !== request.contextStartSequence
          )
            return malformed();
          if (
            receipt.requestSha256 !==
            (await hashArtifact(canonicalArtifactJson(request)))
          )
            return malformed();
          return;
        }
        return;
      }
    ),
    readDebateRun: guarded(
      VertexResearchChatReadDebateRunInputSchema,
      VertexResearchChatReadDebateRunOutputSchema,
      (input, signal) => port.readDebateRun(input, signal),
      (result, input) => {
        if (
          canonicalArtifactJson(result.selector) !==
          canonicalArtifactJson(input)
        )
          return malformed();
        if (result.status === "available")
          return assertResearchDebateRun(result);
        return;
      }
    ),
    readResponse: guarded(
      VertexResearchChatReadResponseInputSchema,
      VertexResearchChatReadResponseOutputSchema,
      (input, signal) => port.readResponse(input, signal),
      (result, input) => sameResponseKey(result.receipt, input)
    ),
    appendResponse: guarded(
      VertexResearchChatAppendResponseInputSchema,
      VertexResearchChatAppendResponseOutputSchema,
      (input, signal) => port.appendResponse(input, signal),
      (result, input) => {
        sameScope(result.selector, input);
        if (
          result.selector.threadId !== input.threadId ||
          result.selector.responseRequestId !== input.responseRequestId
        )
          return malformed();
        if (result.status === "appended") {
          // Original-operation replay returns its immutable earlier reference,
          // not the refreshed thread head. The schema checks sequence + 1.
          if (BigInt(result.message.sequence) > BigInt(input.expectedRevision))
            return malformed();
          return;
        }
        return;
      }
    ),
    readResponseContent: guarded(
      VertexResearchChatReadResponseContentInputSchema,
      VertexResearchChatReadResponseContentOutputSchema,
      (input, signal) => port.readResponseContent(input, signal),
      async (result, input) => {
        const reference = result.reference;
        if (
          reference.threadId !== input.threadId ||
          reference.messageId !== input.messageId ||
          reference.response.responseRequestId !== input.responseRequestId
        )
          return malformed();
        if (result.status === "available") {
          // DTO hashes are not authority. Independently bind the received canonical
          // private profile bytes to the reference; the server still owns rights.
          const digest = await hashArtifact(
            canonicalArtifactJson(result.profile)
          );
          if (
            digest !== result.sha256 ||
            digest !== reference.response.advisoryArtifact.artifactSha256
          )
            return malformed();
          return;
        }
        return;
      }
    ),
  });

// The existing authenticated oRPC client is the only transport. No independent
// fetch route, provider session, actor selection, model call or pagination loop.
export const createResearchChatPort = (
  client: ApiClient
): ExperienceResearchChatPort =>
  guardResearchChatPort({
    roster: (input, signal) =>
      client.vertex.researchChat.roster(input, { signal }),
    listThreads: (input, signal) =>
      client.vertex.researchChat.listThreads(input, { signal }),
    createThread: (input, signal) =>
      client.vertex.researchChat.createThread(input, { signal }),
    readThread: (input, signal) =>
      client.vertex.researchChat.readThread(input, { signal }),
    listMessages: (input, signal) =>
      client.vertex.researchChat.listMessages(input, { signal }),
    readTranscriptPage: (input, signal) =>
      client.vertex.researchChat.readTranscriptPage(input, { signal }),
    sendMessage: (input, signal) =>
      client.vertex.researchChat.sendMessage(input, { signal }),
    prepareResponse: (input, signal) =>
      client.vertex.researchChat.prepareResponse(input, { signal }),
    approveAndRequestResponse: (input, signal) =>
      client.vertex.researchChat.approveAndRequestResponse(input, { signal }),
    prepareNativeEvidence: (input, signal) =>
      client.vertex.researchChat.prepareNativeEvidence(input, { signal }),
    approveAndRequestNativeEvidence: (input, signal) =>
      client.vertex.researchChat.approveAndRequestNativeEvidence(input, {
        signal,
      }),
    prepareDebateStep: (input, signal) =>
      client.vertex.researchChat.prepareDebateStep(input, { signal }),
    approveAndRequestDebateStep: (input, signal) =>
      client.vertex.researchChat.approveAndRequestDebateStep(input, { signal }),
    readDebateRun: (input, signal) =>
      client.vertex.researchChat.readDebateRun(input, { signal }),
    readResponse: (input, signal) =>
      client.vertex.researchChat.readResponse(input, { signal }),
    appendResponse: (input, signal) =>
      client.vertex.researchChat.appendResponse(input, { signal }),
    readResponseContent: (input, signal) =>
      client.vertex.researchChat.readResponseContent(input, { signal }),
  });
