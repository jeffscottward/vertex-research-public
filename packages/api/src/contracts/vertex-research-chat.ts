import { oc } from "@orpc/contract";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import { DigestSchema, IdentifierSchema, TimestampSchema } from "./vertex.ts";
import { VertexCursorSchema } from "./vertex-experience.ts";

// Product research conversation only: not operator chat, broker authority or a
// model/provider contract. Schema validity proves shape, never current access.
export const VertexResearchChatSchemaVersionSchema = z.literal("1.0.0");
export const VertexResearchChatOrdinalSchema = z
  .string()
  .max(30)
  .regex(/^[1-9][0-9]{0,29}$/)
  .refine((value) => value.trim() === value, {
    message: "Ordinal must be canonical without whitespace",
  });
export const VertexResearchChatErrors = {
  BAD_REQUEST: { status: 400, message: "Invalid Vertex research chat request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Vertex research chat access denied" },
  NOT_FOUND: { status: 404, message: "Vertex research chat record not found" },
  CONFLICT: {
    status: 409,
    message: "Vertex research chat revision or idempotency conflict",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Vertex research chat service unavailable",
  },
  INVALID_SOURCE: {
    status: 502,
    message: "Vertex research chat source record invalid",
  },
} as const;

const scope = {
  accountAlias: IdentifierSchema,
  environment: z.literal("research"),
};
const record = {
  schemaVersion: VertexResearchChatSchemaVersionSchema,
  executionAuthorized: z.literal(false),
};
const envelope = { ...record, ...scope };
const uniqueIds = (minimum: number, maximum: number) =>
  z
    .array(IdentifierSchema)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Duplicate identity",
    })
    .readonly();
const ReasonCodesSchema = uniqueIds(0, 32);
// Strings are literal display text, never executable HTML, instructions, or
// authorization. Permit TAB/LF/CR only in bodies; reject other C0/C1 controls,
// directional overrides/isolation and unpaired surrogates without normalization.
const text = (maximum: number, multiline = false) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(
      multiline
        ? /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]*$/u
        : /^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]*$/u
    )
    // Zod >=4.6 measures string maxima in code points; Vertex chat bounds are
    // UTF-16 code units, so keep the original unit bound explicitly.
    .refine((value) => value.length <= maximum, {
      message: `Expected at most ${maximum} UTF-16 code units`,
    })
    .refine(
      (value) =>
        value.trim().length > 0 && (multiline || !/[\r\n]/u.test(value)),
      {
        message:
          "Expected nonblank literal text with the permitted line breaks",
      }
    );
const TitleSchema = text(160);
const chronological = (start: string, end: string): boolean => {
  try {
    return (
      timestampToEpochNanoseconds(start) <= timestampToEpochNanoseconds(end)
    );
  } catch {
    return false;
  }
};
// Canonical positive integer strings compare exactly without Number conversion.
// Invalid strings remain a schema failure, never an arithmetic exception.
const ordinalBefore = (left: string, right: string): boolean =>
  left.length < right.length || (left.length === right.length && left < right);

export const VertexResearchChatCorpusSchema = z
  .object({
    status: z.enum(["unknown", "incomplete", "reviewed"]),
    collectionId: IdentifierSchema.nullable(),
    snapshotSha256: DigestSchema.nullable(),
    reviewId: IdentifierSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "reviewed" ||
      (value.collectionId !== null &&
        value.snapshotSha256 !== null &&
        value.reviewId !== null),
    {
      message:
        "Reviewed corpus requires collection, exact snapshot and review pins",
    }
  )
  .readonly();

export const VertexResearchChatAdvisoryAvailabilitySchema = z
  .object({
    status: z.enum(["configured", "unavailable"]),
    authorization: z.literal("requires-governed-prepare"),
    reasonCodes: z
      .array(
        z.enum([
          "first-mate-configuration-unavailable",
          "governed-prepare-required",
        ])
      )
      .length(1),
  })
  .strict()
  .refine(
    (value) =>
      value.reasonCodes[0] ===
      (value.status === "configured"
        ? "governed-prepare-required"
        : "first-mate-configuration-unavailable")
  )
  .readonly();
export type VertexResearchChatAdvisoryAvailability = z.infer<
  typeof VertexResearchChatAdvisoryAvailabilitySchema
>;

export const VertexResearchChatRosterEntrySchema = z
  .object({
    participantId: IdentifierSchema,
    displayName: text(200),
    specialty: text(200),
    kind: z.enum(["expert", "first-mate"]),
    availability: z.enum(["unavailable", "blocked", "ready"]),
    reasonCodes: ReasonCodesSchema,
    corpus: VertexResearchChatCorpusSchema,
    advisory: VertexResearchChatAdvisoryAvailabilitySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.kind !== "expert" ||
      value.availability !== "ready" ||
      value.corpus.status === "reviewed",
    {
      message:
        "Ready experts require reviewed corpus pins, not merely an imported collection",
    }
  )
  .refine(
    (value) =>
      value.advisory === undefined ||
      (value.kind === "first-mate" &&
        value.participantId === "first-mate" &&
        value.availability === "unavailable"),
    { message: "First Mate advisory configuration is not runtime availability" }
  )
  .readonly();

export const VertexResearchChatThreadSchema = z
  .object({
    ...envelope,
    threadId: IdentifierSchema,
    title: TitleSchema,
    ownerActorId: IdentifierSchema,
    participantIds: uniqueIds(1, 16),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    revision: VertexResearchChatOrdinalSchema,
  })
  .strict()
  .refine((value) => chronological(value.createdAt, value.updatedAt), {
    message: "Thread update precedes creation",
  })
  .readonly();

export const VertexResearchChatAuthorSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), actorId: IdentifierSchema }).strict(),
    z
      .object({
        kind: z.literal("agent"),
        participantId: IdentifierSchema,
        runId: IdentifierSchema,
      })
      .strict(),
  ])
  .readonly();
export const VertexResearchChatCitationSchema = z
  .object({
    artifactId: IdentifierSchema,
    sha256: DigestSchema,
  })
  .strict()
  .readonly();
export const VertexResearchChatMessageSchema = z
  .object({
    ...record,
    threadId: IdentifierSchema,
    messageId: IdentifierSchema,
    sequence: VertexResearchChatOrdinalSchema,
    author: VertexResearchChatAuthorSchema,
    kind: z.enum(["statement", "synthesis"]),
    body: text(20_000, true),
    citations: z
      .array(VertexResearchChatCitationSchema)
      .max(32)
      .refine(
        (values) =>
          new Set(values.map((value) => `${value.artifactId}/${value.sha256}`))
            .size === values.length,
        { message: "Duplicate exact artifact citation" }
      )
      .readonly(),
    recordedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) => value.author.kind !== "user" || value.kind === "statement",
    { message: "Synthesis requires an attributed agent run" }
  )
  .readonly();

// Historical references contain no advisory text and never establish current
// readiness or permission. The original broad message/send shapes stay intact.
const ReferenceIdentifierSchema = IdentifierSchema.refine(
  (value) => value.trim() === value
);
const ReferenceDigestSchema = DigestSchema.refine(
  (value) => value.trim() === value
);
const ReferenceArtifactSchema = z
  .object({
    artifactId: ReferenceIdentifierSchema,
    artifactSha256: ReferenceDigestSchema,
  })
  .strict();
const TranscriptCanonicalDataSchema = z.unknown().transform((value, ctx) => {
  const invalid = "Transcript must be a canonical JSON data graph";
  try {
    return JSON.parse(canonicalArtifactJson(value)) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: invalid });
    return z.NEVER;
  }
});
export const VertexResearchChatAgentReferenceMessageSchema =
  TranscriptCanonicalDataSchema.pipe(
    z
      .object({
        ...record,
        threadId: ReferenceIdentifierSchema,
        messageId: ReferenceIdentifierSchema,
        sequence: VertexResearchChatOrdinalSchema,
        author: z
          .object({
            kind: z.literal("agent"),
            participantId: ReferenceIdentifierSchema,
            runId: ReferenceIdentifierSchema,
          })
          .strict(),
        kind: z.literal("advisory-reference"),
        parentMessageId: ReferenceIdentifierSchema,
        replyToMessageId: ReferenceIdentifierSchema,
        response: z
          .object({
            responseRequestId: ReferenceIdentifierSchema,
            planId: ReferenceIdentifierSchema,
            planSha256: ReferenceDigestSchema,
            requestSha256: ReferenceDigestSchema,
            contextSha256: ReferenceDigestSchema,
            snapshotRevision: VertexResearchChatOrdinalSchema,
            contextStartSequence: VertexResearchChatOrdinalSchema,
            jobId: ReferenceIdentifierSchema,
            traceId: ReferenceIdentifierSchema,
            eventId: ReferenceIdentifierSchema,
            runArtifact: ReferenceArtifactSchema,
            advisoryArtifact: ReferenceArtifactSchema,
            fenceAcknowledgementsSha256: ReferenceDigestSchema,
          })
          .strict(),
        recordedAt: TimestampSchema,
      })
      .strict()
      .refine(
        (value) => {
          const response = value.response;
          try {
            const snapshot = BigInt(response.snapshotRevision),
              count = snapshot - BigInt(response.contextStartSequence);
            return (
              snapshot >= 2n &&
              count >= 1n &&
              count <= 16n &&
              BigInt(value.sequence) >= snapshot &&
              value.author.runId === response.runArtifact.artifactId &&
              value.messageId !== value.parentMessageId &&
              value.messageId !== value.replyToMessageId
            );
          } catch {
            return false;
          }
        },
        {
          message:
            "Reference must preserve the bounded original context and run identity",
        }
      )
  ).transform(deepFreezeArtifact);
const HumanTranscriptMessageSchema = VertexResearchChatMessageSchema.unwrap()
  .safeExtend({
    author: z
      .object({ kind: z.literal("user"), actorId: IdentifierSchema })
      .strict()
      .readonly(),
    kind: z.literal("statement"),
    body: VertexResearchChatMessageSchema.unwrap()
      .shape.body.max(8000)
      .refine((value) => value.length <= 8000, {
        message: "Expected at most 8000 UTF-16 code units",
      }),
    citations: z.array(VertexResearchChatCitationSchema).length(0).readonly(),
  })
  .strict()
  .readonly();
export const VertexResearchChatTranscriptMessageSchema =
  TranscriptCanonicalDataSchema.pipe(
    z.union([
      HumanTranscriptMessageSchema,
      VertexResearchChatAgentReferenceMessageSchema,
    ])
  ).transform(deepFreezeArtifact);

// Every caller input contains only scope selectors and bounded requests. The
// authenticated server supplies actor identity, clocks, ordinals and all rights.
export const VertexResearchChatRosterInputSchema = z.object(scope).strict();
const pageInput = {
  limit: z.number().int().min(1).max(100).default(100),
  cursor: VertexCursorSchema.default(null),
};
export const VertexResearchChatListThreadsInputSchema = z
  .object({ ...scope, ...pageInput })
  .strict();
export const VertexResearchChatCreateThreadInputSchema = z
  .object({
    ...scope,
    title: TitleSchema,
    participantIds: uniqueIds(1, 16),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export const VertexResearchChatReadThreadInputSchema = z
  .object({ ...scope, threadId: IdentifierSchema })
  .strict();
export const VertexResearchChatListMessagesInputSchema = z
  .object({ ...scope, threadId: IdentifierSchema, ...pageInput })
  .strict();
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const VertexResearchChatReadTranscriptPageInputSchema =
  VertexResearchChatListMessagesInputSchema;
export const VertexResearchChatSendMessageInputSchema = z
  .object({
    ...scope,
    threadId: IdentifierSchema,
    expectedRevision: VertexResearchChatOrdinalSchema,
    idempotencyKey: IdentifierSchema,
    body: text(8000, true),
    // Empty means human-only, in BOTH modes; never infer automatic generation.
    requestedParticipantIds: uniqueIds(0, 8),
    mode: z.enum(["discuss", "debate"]),
  })
  .strict();

const participants = (minimum: number, maximum: number) =>
  z
    .array(VertexResearchChatRosterEntrySchema)
    .min(minimum)
    .max(maximum)
    .refine(
      (values) =>
        new Set(values.map((value) => value.participantId)).size ===
        values.length,
      { message: "Duplicate roster participant" }
    )
    .readonly();
export const VertexResearchChatRosterOutputSchema = z
  .object({
    ...envelope,
    participants: participants(0, 256),
  })
  .strict()
  .readonly();
export const VertexResearchChatListThreadsOutputSchema = z
  .object({
    ...envelope,
    items: z.array(VertexResearchChatThreadSchema).max(100).readonly(),
    nextCursor: VertexCursorSchema,
  })
  .strict()
  .refine(
    (value) => {
      return (
        new Set(value.items.map((item) => item.threadId)).size ===
          value.items.length &&
        value.items.every(
          (item) =>
            item.accountAlias === value.accountAlias &&
            item.environment === value.environment
        )
      );
    },
    {
      message: "Thread page contains duplicate identities or a different scope",
    }
  )
  .readonly();
export const VertexResearchChatReadThreadOutputSchema = z
  .object({
    ...record,
    thread: VertexResearchChatThreadSchema,
    participants: participants(1, 16),
  })
  .strict()
  .refine(
    (value) =>
      value.participants.length === value.thread.participantIds.length &&
      value.participants.every((participant) =>
        value.thread.participantIds.includes(participant.participantId)
      ),
    { message: "Thread roster must match exactly its selected participants" }
  )
  .readonly();
export const VertexResearchChatListMessagesOutputSchema = z
  .object({
    ...envelope,
    threadId: IdentifierSchema,
    items: z
      .array(VertexResearchChatTranscriptMessageSchema)
      .max(100)
      .readonly(),
    nextCursor: VertexCursorSchema,
  })
  .strict()
  .refine(
    (value) => {
      return (
        new Set(value.items.map((item) => item.messageId)).size ===
          value.items.length &&
        value.items.every(
          (item, index) =>
            item.threadId === value.threadId &&
            (index === 0 ||
              ordinalBefore(
                value.items[index - 1]?.sequence ?? "",
                item.sequence
              ))
        )
      );
    },
    {
      message:
        "Message page must contain unique identities in ascending sequence for one thread",
    }
  )
  .readonly();

// Current metadata and a fixed transcript boundary are deliberately distinct.
// A continuation may observe a newer head without changing its snapshot.
const HighWaterSequenceSchema = z
  .string()
  .max(30)
  .regex(/^(0|[1-9][0-9]{0,29})$/)
  .refine((value) => value.trim() === value, {
    message: "High water must be canonical without whitespace",
  });
export const VertexResearchChatReadTranscriptPageOutputSchema = z
  .object({
    ...record,
    thread: VertexResearchChatThreadSchema,
    snapshotRevision: VertexResearchChatOrdinalSchema,
    highWaterSequence: HighWaterSequenceSchema,
    items: z
      .array(VertexResearchChatTranscriptMessageSchema)
      .max(100)
      .readonly(),
    nextCursor: VertexCursorSchema,
  })
  .strict()
  .refine(
    (value) => {
      try {
        const highWater = BigInt(value.highWaterSequence);
        const snapshot = BigInt(value.snapshotRevision);
        if (
          snapshot !== highWater + 1n ||
          BigInt(value.thread.revision) < snapshot
        )
          return false;
        if (
          new Set(value.items.map((item) => item.messageId)).size !==
          value.items.length
        )
          return false;
        if (
          !value.items.every(
            (item, index) =>
              item.threadId === value.thread.threadId &&
              (item.kind === "advisory-reference"
                ? value.thread.participantIds.includes(
                    item.author.participantId
                  ) &&
                  (index === 0 ||
                    item.parentMessageId === value.items[index - 1]?.messageId)
                : item.author.kind === "user" &&
                  item.author.actorId === value.thread.ownerActorId &&
                  item.kind === "statement" &&
                  item.citations.length === 0 &&
                  item.body.length <= 8000) &&
              chronological(value.thread.createdAt, item.recordedAt) &&
              chronological(item.recordedAt, value.thread.updatedAt) &&
              BigInt(item.sequence) <= highWater &&
              (index === 0 ||
                BigInt(item.sequence) ===
                  BigInt(value.items[index - 1]?.sequence ?? "") + 1n)
          )
        )
          return false;
        const tail =
          value.items.length === 0
            ? 0n
            : BigInt(value.items.at(-1)?.sequence ?? "");
        return value.nextCursor === null
          ? tail === highWater
          : value.items.length > 0 && tail < highWater;
      } catch {
        return false;
      }
    },
    {
      message:
        "Transcript page requires an owned head, strict human/reference rows and an exact contiguous high-water boundary",
    }
  )
  .readonly();

// A queued response acknowledges an actual durable job admission, not a
// completed answer. Other statuses preserve the durable human message without
// implying any admission. Readiness/review pins alone never authorize enqueue.
export const VertexResearchChatResponseSchema = z
  .object({
    status: z.enum(["not-requested", "unavailable", "queued"]),
    runId: IdentifierSchema.nullable(),
    jobId: IdentifierSchema.nullable(),
    reasonCodes: ReasonCodesSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.status === "queued"
        ? value.runId !== null && value.jobId !== null
        : value.runId === null && value.jobId === null,
    { message: "Only queued responses have both a run and job identity" }
  )
  .readonly();
export const VertexResearchChatSendMessageOutputSchema = z
  .object({
    ...record,
    message: VertexResearchChatMessageSchema,
    threadRevision: VertexResearchChatOrdinalSchema,
    response: VertexResearchChatResponseSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.message.author.kind === "user" &&
      value.message.kind === "statement",
    {
      message:
        "Send acknowledgement records the human statement, not an agent answer",
    }
  )
  .readonly();

// These exact validators only freeze parsed data. Accept their readonly outputs
// as oRPC handler input without replacing the schemas or widening wire shapes.
const readonlyOutput = <S extends z.ZodType>(
  schema: S
): z.ZodType<z.output<S>, z.input<S> | z.output<S>> => {
  return schema as z.ZodType<z.output<S>, z.input<S> | z.output<S>>;
};
const vertex = oc.errors(VertexResearchChatErrors);
export const vertexResearchChatContract = {
  roster: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/roster",
      operationId: "vertex.researchChat.roster",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatRosterInputSchema)
    .output(readonlyOutput(VertexResearchChatRosterOutputSchema)),
  listThreads: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads",
      operationId: "vertex.researchChat.listThreads",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatListThreadsInputSchema)
    .output(readonlyOutput(VertexResearchChatListThreadsOutputSchema)),
  createThread: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads",
      operationId: "vertex.researchChat.createThread",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatCreateThreadInputSchema)
    .output(readonlyOutput(VertexResearchChatThreadSchema)),
  readThread: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads/{threadId}",
      operationId: "vertex.researchChat.readThread",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatReadThreadInputSchema)
    .output(readonlyOutput(VertexResearchChatReadThreadOutputSchema)),
  listMessages: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads/{threadId}/messages",
      operationId: "vertex.researchChat.listMessages",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatListMessagesInputSchema)
    .output(readonlyOutput(VertexResearchChatListMessagesOutputSchema)),
  readTranscriptPage: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/transcript",
      operationId: "vertex.researchChat.readTranscriptPage",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatReadTranscriptPageInputSchema)
    .output(readonlyOutput(VertexResearchChatReadTranscriptPageOutputSchema)),
  sendMessage: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads/{threadId}/messages",
      operationId: "vertex.researchChat.sendMessage",
      tags: ["Vertex"],
    })
    .input(VertexResearchChatSendMessageInputSchema)
    .output(readonlyOutput(VertexResearchChatSendMessageOutputSchema)),
};
// Integration owns registration and any generated OpenAPI/native boundary.
// This list permits only the exact shape-preserving named output validators.
export const VertexResearchChatReadonlyOutputs: readonly z.ZodType[] =
  Object.freeze([
    VertexResearchChatRosterOutputSchema,
    VertexResearchChatListThreadsOutputSchema,
    VertexResearchChatThreadSchema,
    VertexResearchChatReadThreadOutputSchema,
    VertexResearchChatListMessagesOutputSchema,
    VertexResearchChatReadTranscriptPageOutputSchema,
    VertexResearchChatSendMessageOutputSchema,
  ]);

export type VertexResearchChatCorpus = z.infer<
  typeof VertexResearchChatCorpusSchema
>;
export type VertexResearchChatRosterEntry = z.infer<
  typeof VertexResearchChatRosterEntrySchema
>;
export type VertexResearchChatThread = z.infer<
  typeof VertexResearchChatThreadSchema
>;
export type VertexResearchChatAuthor = z.infer<
  typeof VertexResearchChatAuthorSchema
>;
export type VertexResearchChatCitation = z.infer<
  typeof VertexResearchChatCitationSchema
>;
export type VertexResearchChatMessage = z.infer<
  typeof VertexResearchChatMessageSchema
>;
export type VertexResearchChatAgentReferenceMessage = z.infer<
  typeof VertexResearchChatAgentReferenceMessageSchema
>;
export type VertexResearchChatTranscriptMessage = z.infer<
  typeof VertexResearchChatTranscriptMessageSchema
>;
export type VertexResearchChatResponse = z.infer<
  typeof VertexResearchChatResponseSchema
>;
export type VertexResearchChatRosterInput = z.infer<
  typeof VertexResearchChatRosterInputSchema
>;
export type VertexResearchChatRosterOutput = z.infer<
  typeof VertexResearchChatRosterOutputSchema
>;
export type VertexResearchChatListThreadsInput = z.infer<
  typeof VertexResearchChatListThreadsInputSchema
>;
export type VertexResearchChatListThreadsOutput = z.infer<
  typeof VertexResearchChatListThreadsOutputSchema
>;
export type VertexResearchChatCreateThreadInput = z.infer<
  typeof VertexResearchChatCreateThreadInputSchema
>;
export type VertexResearchChatReadThreadInput = z.infer<
  typeof VertexResearchChatReadThreadInputSchema
>;
export type VertexResearchChatReadThreadOutput = z.infer<
  typeof VertexResearchChatReadThreadOutputSchema
>;
export type VertexResearchChatListMessagesInput = z.infer<
  typeof VertexResearchChatListMessagesInputSchema
>;
export type VertexResearchChatListMessagesOutput = z.infer<
  typeof VertexResearchChatListMessagesOutputSchema
>;
export type VertexResearchChatReadTranscriptPageInput = z.infer<
  typeof VertexResearchChatReadTranscriptPageInputSchema
>;
export type VertexResearchChatReadTranscriptPageOutput = z.infer<
  typeof VertexResearchChatReadTranscriptPageOutputSchema
>;
export type VertexResearchChatSendMessageInput = z.infer<
  typeof VertexResearchChatSendMessageInputSchema
>;
export type VertexResearchChatSendMessageOutput = z.infer<
  typeof VertexResearchChatSendMessageOutputSchema
>;

// Service/store obligations deliberately remain outside these pure schemas:
// authenticate and scope every operation; resolve membership and current rights;
// validate selected participants, exact corpus/review/citation pins and expiry;
// bind cursors to actor/scope/thread/order and enforce requested page limits;
// assign actor/run identity and timestamps; atomically allocate sequence/revision,
// enforce expectedRevision and scoped idempotency with payload conflict checks;
// persist the human message before acknowledging it and atomically bind actual
// outbox/job admission (or explicit unavailability) to the response; verify the
// leased worker, current authorization and server-owned budgets/tool grants on
// enqueue and execution. Compare returned scope/IDs to the authenticated request.
// Passing a schema performs none of these checks or side effects.
