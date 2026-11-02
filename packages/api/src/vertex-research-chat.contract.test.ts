import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  VertexResearchChatCorpusSchema,
  VertexResearchChatCreateThreadInputSchema,
  VertexResearchChatErrors,
  VertexResearchChatListMessagesInputSchema,
  VertexResearchChatListMessagesOutputSchema,
  VertexResearchChatListThreadsInputSchema,
  VertexResearchChatListThreadsOutputSchema,
  VertexResearchChatMessageSchema,
  VertexResearchChatOrdinalSchema,
  VertexResearchChatReadThreadInputSchema,
  VertexResearchChatReadThreadOutputSchema,
  VertexResearchChatReadTranscriptPageInputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatReadonlyOutputs,
  VertexResearchChatResponseSchema,
  VertexResearchChatRosterEntrySchema,
  VertexResearchChatRosterInputSchema,
  VertexResearchChatRosterOutputSchema,
  VertexResearchChatSendMessageInputSchema,
  VertexResearchChatSendMessageOutputSchema,
  VertexResearchChatThreadSchema,
  vertexResearchChatContract,
  type VertexResearchChatMessage,
  type VertexResearchChatThread,
  type VertexResearchChatReadTranscriptPageInput,
  type VertexResearchChatReadTranscriptPageOutput,
} from "./contracts/vertex-research-chat.ts";

// Synthetic identities and evidence pins only; no current corpus or access claim.
const scope = {
  accountAlias: "synthetic-research",
  environment: "research",
} as const;
const envelope = {
  schemaVersion: "1.0.0",
  ...scope,
  executionAuthorized: false,
} as const;
const corpus = {
  status: "reviewed",
  collectionId: "collection-1",
  snapshotSha256: "a".repeat(64),
  reviewId: "review-1",
} as const;
const participant = {
  participantId: "expert-1",
  displayName: "Synthetic Expert",
  specialty: "Synthetic evidence review",
  kind: "expert",
  availability: "ready",
  reasonCodes: [],
  corpus,
} as const;
const thread = {
  ...envelope,
  threadId: "thread-1",
  title: "Synthetic research conversation",
  ownerActorId: "actor-1",
  participantIds: ["expert-1"],
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:01Z",
  revision: "9007199254740993",
} as const;
const message = {
  schemaVersion: "1.0.0",
  threadId: "thread-1",
  messageId: "message-1",
  sequence: "9007199254740993",
  author: { kind: "user", actorId: "actor-1" },
  kind: "statement",
  body: "Synthetic question.\nSecond line.\tDetail.\r\nEnd.",
  citations: [{ artifactId: "artifact-1", sha256: "b".repeat(64) }],
  recordedAt: "2026-09-23T00:00:01Z",
  executionAuthorized: false,
} as const;
const send = {
  ...scope,
  threadId: "thread-1",
  expectedRevision: "9007199254740993",
  idempotencyKey: "send-1",
  body: "Synthetic question",
  requestedParticipantIds: ["expert-1"],
  mode: "discuss",
} as const;
const create = {
  ...scope,
  title: "Synthetic research",
  participantIds: ["expert-1"],
  idempotencyKey: "create-1",
} as const;
const response = {
  status: "not-requested",
  runId: null,
  jobId: null,
  reasonCodes: [],
} as const;
const acknowledgement = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  message,
  threadRevision: "9007199254740994",
  response,
} as const;
// Listed/transcript human statements carry no citations (f30459c): only agent
// reference messages cite artifacts.
const transcriptMessage = { ...message, citations: [] } as const;
const messagesPage = {
  ...envelope,
  threadId: "thread-1",
  items: [transcriptMessage],
  nextCursor: null,
} as const;
const threadsPage = { ...envelope, items: [thread], nextCursor: null } as const;
const roster = { ...envelope, participants: [participant] } as const;
const threadRead = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  thread,
  participants: [participant],
} as const;
const transcriptPage = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  thread: { ...thread, revision: "9007199254740995" },
  snapshotRevision: "9007199254740994",
  highWaterSequence: "9007199254740993",
  items: [transcriptMessage],
  nextCursor: null,
} as const;
const inputCases = [
  { schema: VertexResearchChatRosterInputSchema, value: scope },
  { schema: VertexResearchChatListThreadsInputSchema, value: scope },
  { schema: VertexResearchChatCreateThreadInputSchema, value: create },
  {
    schema: VertexResearchChatReadThreadInputSchema,
    value: { ...scope, threadId: "thread-1" },
  },
  {
    schema: VertexResearchChatListMessagesInputSchema,
    value: { ...scope, threadId: "thread-1" },
  },
  { schema: VertexResearchChatSendMessageInputSchema, value: send },
  {
    schema: VertexResearchChatReadTranscriptPageInputSchema,
    value: { ...scope, threadId: "thread-1" },
  },
];
const outputCases = [
  { schema: VertexResearchChatCorpusSchema, value: corpus },
  { schema: VertexResearchChatRosterEntrySchema, value: participant },
  { schema: VertexResearchChatThreadSchema, value: thread },
  { schema: VertexResearchChatMessageSchema, value: message },
  { schema: VertexResearchChatResponseSchema, value: response },
  { schema: VertexResearchChatRosterOutputSchema, value: roster },
  { schema: VertexResearchChatListThreadsOutputSchema, value: threadsPage },
  { schema: VertexResearchChatReadThreadOutputSchema, value: threadRead },
  { schema: VertexResearchChatListMessagesOutputSchema, value: messagesPage },
  { schema: VertexResearchChatSendMessageOutputSchema, value: acknowledgement },
  {
    schema: VertexResearchChatReadTranscriptPageOutputSchema,
    value: transcriptPage,
  },
];
const routes = [
  {
    procedure: vertexResearchChatContract.roster,
    method: "GET",
    path: "/vertex/research-chat/roster",
    name: "roster",
    input: VertexResearchChatRosterInputSchema,
    output: VertexResearchChatRosterOutputSchema,
  },
  {
    procedure: vertexResearchChatContract.listThreads,
    method: "GET",
    path: "/vertex/research-chat/threads",
    name: "listThreads",
    input: VertexResearchChatListThreadsInputSchema,
    output: VertexResearchChatListThreadsOutputSchema,
  },
  {
    procedure: vertexResearchChatContract.createThread,
    method: "POST",
    path: "/vertex/research-chat/threads",
    name: "createThread",
    input: VertexResearchChatCreateThreadInputSchema,
    output: VertexResearchChatThreadSchema,
  },
  {
    procedure: vertexResearchChatContract.readThread,
    method: "GET",
    path: "/vertex/research-chat/threads/{threadId}",
    name: "readThread",
    input: VertexResearchChatReadThreadInputSchema,
    output: VertexResearchChatReadThreadOutputSchema,
  },
  {
    procedure: vertexResearchChatContract.listMessages,
    method: "GET",
    path: "/vertex/research-chat/threads/{threadId}/messages",
    name: "listMessages",
    input: VertexResearchChatListMessagesInputSchema,
    output: VertexResearchChatListMessagesOutputSchema,
  },
  {
    procedure: vertexResearchChatContract.readTranscriptPage,
    method: "GET",
    path: "/vertex/research-chat/transcript",
    name: "readTranscriptPage",
    input: VertexResearchChatReadTranscriptPageInputSchema,
    output: VertexResearchChatReadTranscriptPageOutputSchema,
  },
  {
    procedure: vertexResearchChatContract.sendMessage,
    method: "POST",
    path: "/vertex/research-chat/threads/{threadId}/messages",
    name: "sendMessage",
    input: VertexResearchChatSendMessageInputSchema,
    output: VertexResearchChatSendMessageOutputSchema,
  },
] as const;

describe("Vertex research-chat contract-only authority", () => {
  it("declares seven product operations with exact input and immutable output schemas", () => {
    expect(Object.keys(vertexResearchChatContract)).toEqual([
      "roster",
      "listThreads",
      "createThread",
      "readThread",
      "listMessages",
      "readTranscriptPage",
      "sendMessage",
    ]);
    for (const { procedure, method, path, name, input, output } of routes) {
      expect(procedure["~orpc"].route).toMatchObject({
        method,
        path,
        operationId: `vertex.researchChat.${name}`,
      });
      expect(procedure["~orpc"].inputSchema).toBe(input);
      expect(procedure["~orpc"].outputSchema).toBe(output);
    }
    expect(VertexResearchChatReadonlyOutputs).toEqual(
      routes.map((entry) => entry.output)
    );
    expect(Object.isFrozen(VertexResearchChatReadonlyOutputs)).toBe(true);
    return expect(VertexResearchChatErrors).toEqual({
      BAD_REQUEST: {
        status: 400,
        message: "Invalid Vertex research chat request",
      },
      UNAUTHORIZED: { status: 401, message: "Authentication required" },
      FORBIDDEN: { status: 403, message: "Vertex research chat access denied" },
      NOT_FOUND: {
        status: 404,
        message: "Vertex research chat record not found",
      },
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
    });
  });

  it("accepts complete synthetic records without converting strings or inventing authority", () => {
    for (const { schema, value } of outputCases) {
      expect(schema.parse(value)).toEqual(value);
      expect(Object.isFrozen(schema.parse(value))).toBe(true);
    }
    for (const { schema, value } of inputCases) {
      expect(schema.safeParse(value).success).toBe(true);
    }
    const parsed = VertexResearchChatMessageSchema.parse(message);
    expect(Object.isFrozen(parsed.author)).toBe(true);
    expect(Object.isFrozen(parsed.citations)).toBe(true);
    expect(Object.isFrozen(parsed.citations[0])).toBe(true);
    expect(
      Object.isFrozen(
        VertexResearchChatThreadSchema.parse(thread).participantIds
      )
    ).toBe(true);
    expect(
      Object.isFrozen(
        VertexResearchChatRosterEntrySchema.parse(participant).corpus
      )
    ).toBe(true);
    expect(
      Object.isFrozen(
        VertexResearchChatRosterEntrySchema.parse(participant).reasonCodes
      )
    ).toBe(true);
    expectTypeOf<
      z.output<typeof VertexResearchChatMessageSchema>
    >().toEqualTypeOf<VertexResearchChatMessage>();
    expectTypeOf<
      z.output<typeof VertexResearchChatThreadSchema>
    >().toEqualTypeOf<VertexResearchChatThread>();
    type ThreadOutput = NonNullable<
      (typeof vertexResearchChatContract.createThread)["~orpc"]["outputSchema"]
    >;
    expectTypeOf<VertexResearchChatThread>().toExtend<
      InferSchemaInput<ThreadOutput>
    >();
    expectTypeOf<
      InferSchemaOutput<ThreadOutput>
    >().toEqualTypeOf<VertexResearchChatThread>();
    expectTypeOf<
      z.output<typeof VertexResearchChatReadTranscriptPageInputSchema>
    >().toEqualTypeOf<VertexResearchChatReadTranscriptPageInput>();
    expectTypeOf<
      z.output<typeof VertexResearchChatReadTranscriptPageOutputSchema>
    >().toEqualTypeOf<VertexResearchChatReadTranscriptPageOutput>();
    const transcript =
      VertexResearchChatReadTranscriptPageOutputSchema.parse(transcriptPage);
    expect(Object.isFrozen(transcript.items)).toBe(true);
    expect(Object.isFrozen(transcript.thread)).toBe(true);
    return expect(Object.isFrozen(transcript.items[0])).toBe(true);
  });

  it("rejects absent, extra and unknown keys rather than silently stripping them", () => {
    for (const { schema, value } of [...inputCases, ...outputCases]) {
      expect(
        schema.safeParse({ ...value, extra: "unrecognized" }).success
      ).toBe(false);
      for (const invalid of [null, undefined, [], "record"]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    }
    for (const { schema, value } of [...inputCases, ...outputCases]) {
      for (const key of Object.keys(value)) {
        const missing = { ...value } as Record<string, unknown>;
        delete missing[key];
        expect(schema.safeParse(missing).success).toBe(false);
      }
    }
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        author: { ...message.author, displayName: "Spoofed" },
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        citations: [
          { ...message.citations[0], url: "https://example.invalid" },
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatRosterEntrySchema.safeParse({
        ...participant,
        corpus: { ...corpus, rightsGranted: true },
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatSendMessageOutputSchema.safeParse({
        ...acknowledgement,
        response: { ...response, answer: "not generated" },
      }).success
    ).toBe(false);
  });

  it("rejects caller identities, labels, authority, timestamps, model endpoints and tool or budget injections", () => {
    const injections = [
      { actorId: "admin" },
      { ownerActorId: "admin" },
      { author: message.author },
      { speaker: "expert-1" },
      { displayName: "Spoofed expert" },
      { participantId: "expert-1" },
      { runId: "run-1" },
      { jobId: "job-1" },
      { recordedAt: message.recordedAt },
      { createdAt: thread.createdAt },
      { sequence: "1" },
      { revision: "1" },
      { rights: ["all"] },
      { reviewId: "review-1" },
      { corpus },
      { modelEndpoint: "https://example.invalid" },
      { model: "caller-model" },
      { toolGrants: ["broker"] },
      { budget: 100 },
      { maxTokens: 100 },
      { executionAuthorized: true },
      { executionAuthorized: false },
      { rawReasoning: "private chain" },
      { citations: message.citations },
      { metadata: {} },
      { kind: "synthesis" },
      { availability: "ready" },
    ];
    for (const { schema, value } of inputCases) {
      for (const extra of injections) {
        expect(schema.safeParse({ ...value, ...extra }).success).toBe(false);
      }
    }

    for (const { schema, value } of [
      outputCases[2]!,
      outputCases[3]!,
      outputCases[5]!,
      outputCases[6]!,
      outputCases[7]!,
      outputCases[8]!,
      outputCases[9]!,
    ]) {
      expect(
        schema.safeParse({ ...value, executionAuthorized: true }).success
      ).toBe(false);
    }
  });

  it("requires authenticated scope selectors on every input and literal research everywhere scope is represented", () => {
    for (const { schema, value } of inputCases) {
      for (const environment of ["paper", "live", "unknown", null, undefined]) {
        expect(schema.safeParse({ ...value, environment }).success).toBe(false);
      }
      for (const accountAlias of ["", "../account", null, undefined]) {
        expect(schema.safeParse({ ...value, accountAlias }).success).toBe(
          false
        );
      }
    }
    for (const { schema, value } of [
      outputCases[2]!,
      outputCases[5]!,
      outputCases[6]!,
      outputCases[8]!,
    ]) {
      expect(schema.safeParse({ ...value, environment: "paper" }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ ...value, schemaVersion: "2.0.0" }).success
      ).toBe(false);
    }
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        schemaVersion: "2.0.0",
      }).success
    ).toBe(false);

    for (const { schema, value } of [outputCases[7]!, outputCases[9]!]) {
      expect(
        schema.safeParse({ ...value, schemaVersion: "2.0.0" }).success
      ).toBe(false);
      expect(
        schema.safeParse({ ...value, schemaVersion: undefined }).success
      ).toBe(false);
      expect(
        schema.safeParse({ ...value, executionAuthorized: undefined }).success
      ).toBe(false);
    }
  });

  it("requires all reviewed corpus pins and never promotes unknown or incomplete expert corpus to ready", () => {
    for (const key of ["collectionId", "snapshotSha256", "reviewId"]) {
      expect(
        VertexResearchChatCorpusSchema.safeParse({ ...corpus, [key]: null })
          .success
      ).toBe(false);
    }
    for (const status of ["unknown", "incomplete"]) {
      for (const pins of [
        { collectionId: null, snapshotSha256: null, reviewId: null },
        { collectionId: "collection-1", snapshotSha256: null, reviewId: null },
        corpus,
      ]) {
        const uncertain = { ...pins, status };
        expect(
          VertexResearchChatRosterEntrySchema.safeParse({
            ...participant,
            corpus: uncertain,
          }).success
        ).toBe(false);
        expect(
          VertexResearchChatRosterEntrySchema.safeParse({
            ...participant,
            availability: "blocked",
            corpus: uncertain,
          }).success
        ).toBe(true);
        expect(
          VertexResearchChatRosterEntrySchema.safeParse({
            ...participant,
            availability: "unavailable",
            corpus: uncertain,
          }).success
        ).toBe(true);
      }
    }
    expect(
      VertexResearchChatRosterEntrySchema.safeParse({
        ...participant,
        kind: "first-mate",
        corpus: {
          status: "unknown",
          collectionId: null,
          snapshotSha256: null,
          reviewId: null,
        },
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatCorpusSchema.safeParse({
        ...corpus,
        snapshotSha256: "A".repeat(64),
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatRosterEntrySchema.safeParse({
        ...participant,
        kind: "operator",
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatRosterEntrySchema.safeParse({
        ...participant,
        availability: "authorized",
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatCorpusSchema.safeParse({
        ...corpus,
        status: "approved",
      }).success
    ).toBe(false);
  });

  it("preserves canonical positive decimal ordinals beyond Number precision", () => {
    for (const ordinal of [
      "1",
      "9007199254740993",
      "999999999999999999999999999999",
    ]) {
      expect(VertexResearchChatOrdinalSchema.parse(ordinal)).toBe(ordinal);
      expect(
        VertexResearchChatThreadSchema.parse({ ...thread, revision: ordinal })
          .revision
      ).toBe(ordinal);
      expect(
        VertexResearchChatMessageSchema.parse({ ...message, sequence: ordinal })
          .sequence
      ).toBe(ordinal);
      expect(
        VertexResearchChatSendMessageInputSchema.safeParse({
          ...send,
          expectedRevision: ordinal,
        }).success
      ).toBe(true);
      expect(
        VertexResearchChatSendMessageOutputSchema.safeParse({
          ...acknowledgement,
          threadRevision: ordinal,
        }).success
      ).toBe(true);
    }

    for (const ordinal of [
      "0",
      "-0",
      "01",
      "+1",
      "-1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "1\n",
      "",
      "1".repeat(31),
      1,
      9_007_199_254_740_992,
      null,
    ]) {
      expect(VertexResearchChatOrdinalSchema.safeParse(ordinal).success).toBe(
        false
      );
      expect(
        VertexResearchChatThreadSchema.safeParse({
          ...thread,
          revision: ordinal,
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatMessageSchema.safeParse({
          ...message,
          sequence: ordinal,
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatSendMessageInputSchema.safeParse({
          ...send,
          expectedRevision: ordinal,
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatSendMessageOutputSchema.safeParse({
          ...acknowledgement,
          threadRevision: ordinal,
        }).success
      ).toBe(false);
    }
  });

  it("enforces bounded unique participants, reasons, roster identities and exact citation pairs", () => {
    for (const participantIds of [
      [],
      ["expert-1", "expert-1"],
      Array.from({ length: 17 }, (_, i) => `expert-${i}`),
    ]) {
      expect(
        VertexResearchChatThreadSchema.safeParse({ ...thread, participantIds })
          .success
      ).toBe(false);
      expect(
        VertexResearchChatCreateThreadInputSchema.safeParse({
          ...create,
          participantIds,
        }).success
      ).toBe(false);
    }
    const sixteen = Array.from({ length: 16 }, (_, i) => `expert-${i}`);
    expect(
      VertexResearchChatThreadSchema.safeParse({
        ...thread,
        participantIds: sixteen,
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatCreateThreadInputSchema.safeParse({
        ...create,
        participantIds: sixteen,
      }).success
    ).toBe(true);
    for (const requestedParticipantIds of [
      ["expert-1", "expert-1"],
      Array.from({ length: 9 }, (_, i) => `expert-${i}`),
    ]) {
      expect(
        VertexResearchChatSendMessageInputSchema.safeParse({
          ...send,
          requestedParticipantIds,
        }).success
      ).toBe(false);
    }
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...send,
        requestedParticipantIds: Array.from(
          { length: 8 },
          (_, i) => `expert-${i}`
        ),
      }).success
    ).toBe(true);
    const citations = Array.from({ length: 32 }, (_, i) => ({
      artifactId: `artifact-${i}`,
      sha256: "b".repeat(64),
    }));
    expect(
      VertexResearchChatMessageSchema.safeParse({ ...message, citations })
        .success
    ).toBe(true);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        citations: [
          ...citations,
          { artifactId: "artifact-33", sha256: "b".repeat(64) },
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        citations: [message.citations[0], message.citations[0]],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        citations: [
          message.citations[0],
          { ...message.citations[0], sha256: "c".repeat(64) },
        ],
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        citations: [{ artifactId: "artifact-1", sha256: "bad" }],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatRosterOutputSchema.safeParse({
        ...roster,
        participants: [participant, participant],
      }).success
    ).toBe(false);
    const rosterParticipants = Array.from({ length: 256 }, (_, i) => ({
      ...participant,
      participantId: `expert-${i}`,
    }));
    expect(
      VertexResearchChatRosterOutputSchema.safeParse({
        ...roster,
        participants: rosterParticipants,
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatRosterOutputSchema.safeParse({
        ...roster,
        participants: [
          ...rosterParticipants,
          { ...participant, participantId: "expert-256" },
        ],
      }).success
    ).toBe(false);
    const reasonCodes = Array.from({ length: 32 }, (_, i) => `reason-${i}`);

    for (const base of [
      { schema: VertexResearchChatRosterEntrySchema, value: participant },
      { schema: VertexResearchChatResponseSchema, value: response },
    ]) {
      expect(
        base.schema.safeParse({ ...base.value, reasonCodes }).success
      ).toBe(true);
      expect(
        base.schema.safeParse({
          ...base.value,
          reasonCodes: [...reasonCodes, "reason-33"],
        }).success
      ).toBe(false);
      expect(
        base.schema.safeParse({
          ...base.value,
          reasonCodes: ["blocked", "blocked"],
        }).success
      ).toBe(false);
    }
  });

  it("attributes synthesis only to a run-backed agent and rejects mixed authors", () => {
    const agent = { kind: "agent", participantId: "expert-1", runId: "run-1" };
    for (const kind of ["statement", "synthesis"]) {
      expect(
        VertexResearchChatMessageSchema.safeParse({
          ...message,
          author: agent,
          kind,
        }).success
      ).toBe(true);
    }
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        kind: "synthesis",
      }).success
    ).toBe(false);
    for (const author of [
      { kind: "agent", participantId: "expert-1" },
      { ...agent, actorId: "actor-1" },
      { ...message.author, participantId: "expert-1" },
      { kind: "system" },
    ]) {
      expect(
        VertexResearchChatMessageSchema.safeParse({ ...message, author })
          .success
      ).toBe(false);
    }

    for (const kind of ["reasoning", "tool-call", "approval"]) {
      expect(
        VertexResearchChatMessageSchema.safeParse({ ...message, kind }).success
      ).toBe(false);
    }
  });

  it("accepts human-only sends without selecting or requesting a model", () => {
    for (const mode of ["discuss", "debate"]) {
      const parsed = VertexResearchChatSendMessageInputSchema.parse({
        ...send,
        mode,
        requestedParticipantIds: [],
      });
      expect(parsed.requestedParticipantIds).toEqual([]);
      expect(parsed.mode).toBe(mode);
    }
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...send,
        mode: "execute",
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...send,
        requestedParticipantIds: undefined,
      }).success
    ).toBe(false);
  });

  it("separates the durable human message from actual enqueue acknowledgement", () => {
    for (const status of ["not-requested", "unavailable", "queued"]) {
      for (const runId of [null, "run-1"]) {
        for (const jobId of [null, "job-1"]) {
          const valid =
            status === "queued"
              ? runId !== null && jobId !== null
              : runId === null && jobId === null;
          const candidate = { status, runId, jobId, reasonCodes: [] };
          expect(
            VertexResearchChatResponseSchema.safeParse(candidate).success
          ).toBe(valid);
          expect(
            VertexResearchChatSendMessageOutputSchema.safeParse({
              ...acknowledgement,
              response: candidate,
            }).success
          ).toBe(valid);
        }
      }
    }
    for (const status of ["completed", "running", "failed"]) {
      expect(
        VertexResearchChatSendMessageOutputSchema.safeParse({
          ...acknowledgement,
          response: { ...response, status },
        }).success
      ).toBe(false);
    }
    const agentMessage = {
      ...message,
      author: { kind: "agent", participantId: "expert-1", runId: "run-1" },
    };
    expect(
      VertexResearchChatSendMessageOutputSchema.safeParse({
        ...acknowledgement,
        message: agentMessage,
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatSendMessageOutputSchema.safeParse({
        ...acknowledgement,
        message: { ...agentMessage, kind: "synthesis" },
      }).success
    ).toBe(false);
  });

  it("requires read participants to exactly match selected thread participant IDs, not roster order", () => {
    for (const participants of [
      [],
      [participant, participant],
      [{ ...participant, participantId: "other" }],
      [participant, { ...participant, participantId: "extra" }],
    ]) {
      expect(
        VertexResearchChatReadThreadOutputSchema.safeParse({
          ...threadRead,
          participants,
        }).success
      ).toBe(false);
    }
    const second = { ...participant, participantId: "expert-2" };
    return expect(
      VertexResearchChatReadThreadOutputSchema.safeParse({
        ...threadRead,
        thread: { ...thread, participantIds: ["expert-1", "expert-2"] },
        participants: [second, participant],
      }).success
    ).toBe(true);
  });

  it("checks local page relationships without comparing ordinals as floating-point numbers", () => {
    expect(
      VertexResearchChatListThreadsOutputSchema.safeParse({
        ...threadsPage,
        items: [{ ...thread, accountAlias: "other" }],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListThreadsOutputSchema.safeParse({
        ...threadsPage,
        items: [thread, thread],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [{ ...transcriptMessage, threadId: "other" }],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [transcriptMessage, transcriptMessage],
      }).success
    ).toBe(false);
    const next = {
      ...transcriptMessage,
      messageId: "message-2",
      sequence: "9007199254740994",
    };
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [transcriptMessage, next],
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [next, transcriptMessage],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [
          transcriptMessage,
          { ...next, sequence: transcriptMessage.sequence },
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [
          transcriptMessage,
          { ...next, messageId: transcriptMessage.messageId },
        ],
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [transcriptMessage, { ...next, sequence: "invalid" }],
      }).success
    ).toBe(false);
    return expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [
          { ...transcriptMessage, sequence: "9" },
          { ...next, sequence: "10" },
        ],
      }).success
    ).toBe(true);
  });

  it("keeps a fixed high-water page while returning the actual newer head, including exact large ordinals", () => {
    expect(VertexResearchChatReadTranscriptPageInputSchema).toBe(
      VertexResearchChatListMessagesInputSchema
    );
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.parse(transcriptPage)
    ).toEqual(transcriptPage);
    const empty = {
      ...transcriptPage,
      thread: { ...thread, revision: "1" },
      snapshotRevision: "1",
      highWaterSequence: "0",
      items: [],
    };
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.parse(empty)
    ).toEqual(empty);
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...empty,
        thread: { ...thread, revision: "3" },
      }).success
    ).toBe(true);
    const atMaximum = {
      ...transcriptPage,
      thread: { ...thread, revision: "999999999999999999999999999999" },
      snapshotRevision: "999999999999999999999999999999",
      highWaterSequence: "999999999999999999999999999998",
      items: [
        {
          ...message,
          citations: [],
          sequence: "999999999999999999999999999998",
        },
      ],
    };
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.parse(atMaximum)
    ).toEqual(atMaximum);
    const first = { ...message, citations: [], sequence: "9" };
    const second = { ...first, messageId: "message-2", sequence: "10" };
    const page = {
      ...transcriptPage,
      thread: { ...thread, revision: "15" },
      snapshotRevision: "12",
      highWaterSequence: "11",
      items: [first, second],
      nextCursor: "cursor_2",
    };
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.parse(page)
    ).toEqual(page);
    return expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...page,
        items: [{ ...second, sequence: "11" }],
        nextCursor: null,
      }).success
    ).toBe(true);
  });

  it("rejects malformed snapshot boundaries, future snapshots and empty or incomplete final pages", () => {
    for (const field of ["snapshotRevision", "highWaterSequence"]) {
      for (const value of [
        "",
        "-1",
        "-0",
        "+1",
        "01",
        "1.0",
        "1e3",
        " 1",
        "1 ",
        "1\n",
        "1".repeat(31),
        "invalid",
        1,
        null,
      ]) {
        expect(
          VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
            ...transcriptPage,
            [field]: value,
          }).success
        ).toBe(false);
      }
    }

    for (const change of [
      { snapshotRevision: "0" },
      { snapshotRevision: transcriptPage.highWaterSequence },
      { thread: { ...thread, revision: "9007199254740993" } },
      { items: [] },
      { nextCursor: "more" },
      {
        highWaterSequence: "9007199254740994",
        snapshotRevision: "9007199254740995",
      },
      {
        highWaterSequence: "0",
        snapshotRevision: "1",
        items: [],
        nextCursor: "more",
      },
      {
        highWaterSequence: "999999999999999999999999999999",
        snapshotRevision: "1000000000000000000000000000000",
      },
      { executionAuthorized: true },
      { schemaVersion: "2.0.0" },
    ]) {
      expect(
        VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
          ...transcriptPage,
          ...change,
        }).success
      ).toBe(false);
    }
  });

  it("rejects foreign, noncontiguous, out-of-boundary and unsupported human transcript rows", () => {
    const human = transcriptPage.items[0];
    for (const change of [
      { threadId: "other-thread" },
      { author: { kind: "user", actorId: "other-human" } },
      { author: { kind: "agent", participantId: "expert-1", runId: "run-1" } },
      { kind: "synthesis" },
      { citations: message.citations },
      { body: "a".repeat(8001) },
      { recordedAt: "2026-09-22T23:59:59Z" },
      { recordedAt: "2026-09-23T00:00:02Z" },
      { sequence: "9007199254740994" },
    ]) {
      expect(
        VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
          ...transcriptPage,
          items: [{ ...human, ...change }],
        }).success
      ).toBe(false);
    }
    for (const items of [
      [human, human],
      [
        { ...human, sequence: "9007199254740991" },
        { ...human, messageId: "second" },
      ],
      [human, { ...human, sequence: "9007199254740992", messageId: "second" }],
      [{ ...human, sequence: "9007199254740992" }, human],
    ]) {
      expect(
        VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
          ...transcriptPage,
          items,
        }).success
      ).toBe(false);
    }
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...human,
      messageId: `item-${index}`,
      sequence: String(index + 1),
    }));
    const bounded = {
      ...transcriptPage,
      thread: { ...thread, revision: "101" },
      snapshotRevision: "101",
      highWaterSequence: "100",
      items,
    };
    expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse(bounded)
        .success
    ).toBe(true);
    return expect(
      VertexResearchChatReadTranscriptPageOutputSchema.safeParse({
        ...bounded,
        thread: { ...thread, revision: "102" },
        snapshotRevision: "102",
        highWaterSequence: "101",
        items: [...items, { ...human, messageId: "item-100", sequence: "101" }],
      }).success
    ).toBe(false);
  });

  it("uses opaque cursor defaults and bounds both inputs and pages to 100 records", () => {
    for (const { schema, value } of [
      inputCases[1]!,
      inputCases[4]!,
      inputCases[6]!,
    ]) {
      expect(schema.parse(value)).toMatchObject({ limit: 100, cursor: null });
      expect(
        schema.safeParse({ ...value, limit: 1, cursor: "abc_DEF-123" }).success
      ).toBe(true);
      for (const limit of [0, -1, 101, 1.5, "100", null]) {
        expect(schema.safeParse({ ...value, limit }).success).toBe(false);
      }
      for (const cursor of ["", "a/b", "a=b", " ", "a".repeat(4097), 1]) {
        expect(schema.safeParse({ ...value, cursor }).success).toBe(false);
      }
      expect(
        schema.safeParse({ ...value, cursor: "a".repeat(4096) }).success
      ).toBe(true);
    }
    const items = Array.from({ length: 100 }, (_, i) => ({
      ...transcriptMessage,
      messageId: `message-${i}`,
      sequence: String(i + 1),
    }));
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items,
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatListMessagesOutputSchema.safeParse({
        ...messagesPage,
        items: [
          ...items,
          { ...transcriptMessage, messageId: "message-101", sequence: "101" },
        ],
      }).success
    ).toBe(false);
    const threads = Array.from({ length: 100 }, (_, i) => ({
      ...thread,
      threadId: `thread-${i}`,
    }));
    expect(
      VertexResearchChatListThreadsOutputSchema.safeParse({
        ...threadsPage,
        items: threads,
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatListThreadsOutputSchema.safeParse({
        ...threadsPage,
        items: [...threads, { ...thread, threadId: "thread-101" }],
      }).success
    ).toBe(false);

    for (const base of [
      { schema: VertexResearchChatListThreadsOutputSchema, value: threadsPage },
      {
        schema: VertexResearchChatListMessagesOutputSchema,
        value: messagesPage,
      },
    ]) {
      expect(
        base.schema.safeParse({ ...base.value, items: [], nextCursor: null })
          .success
      ).toBe(true);
      expect(
        base.schema.safeParse({ ...base.value, nextCursor: "a/b" }).success
      ).toBe(false);
    }
  });

  it("bounds text, preserves literal multiline text and rejects malformed or unsafe controls", () => {
    expect(
      VertexResearchChatSendMessageInputSchema.parse({
        ...send,
        body: "<b>Literal text</b>\nNot HTML authority",
      }).body
    ).toBe("<b>Literal text</b>\nNot HTML authority");
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...send,
        body: "a".repeat(8000),
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatSendMessageInputSchema.safeParse({
        ...send,
        body: "a".repeat(8001),
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        body: "a".repeat(20_000),
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        body: "a".repeat(20_001),
      }).success
    ).toBe(false);
    for (const body of [
      "",
      " \r\n\t",
      "a\u0000",
      "a\u0001",
      "a\u0008",
      "a\u000b",
      "a\u000c",
      "a\u001b",
      "a\u007f",
      "a\u0085",
      "a\u009f",
      "a\u202e",
      "a\u2066",
      "a\ud800",
      "a\udfff",
    ]) {
      expect(
        VertexResearchChatMessageSchema.safeParse({ ...message, body }).success
      ).toBe(false);
      expect(
        VertexResearchChatSendMessageInputSchema.safeParse({ ...send, body })
          .success
      ).toBe(false);
    }
    for (const title of [
      "",
      " ",
      "a\nsecond",
      "a\n",
      "a\r\n",
      "a".repeat(161),
      "a\u0000",
    ]) {
      expect(
        VertexResearchChatThreadSchema.safeParse({ ...thread, title }).success
      ).toBe(false);
      expect(
        VertexResearchChatCreateThreadInputSchema.safeParse({
          ...create,
          title,
        }).success
      ).toBe(false);
    }
    expect(
      VertexResearchChatCreateThreadInputSchema.safeParse({
        ...create,
        title: "a".repeat(160),
      }).success
    ).toBe(true);

    for (const key of ["displayName", "specialty"]) {
      expect(
        VertexResearchChatRosterEntrySchema.safeParse({
          ...participant,
          [key]: "",
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatRosterEntrySchema.safeParse({
          ...participant,
          [key]: "a".repeat(201),
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatRosterEntrySchema.safeParse({
          ...participant,
          [key]: "a\nline",
        }).success
      ).toBe(false);
    }
  });

  it("reuses Gregorian timestamp validation and rejects backwards thread chronology at nanosecond precision", () => {
    for (const timestamp of [
      "invalid",
      "2026-02-30T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-09-23T00:00:00+24:00",
    ]) {
      expect(
        VertexResearchChatThreadSchema.safeParse({
          ...thread,
          createdAt: timestamp,
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatMessageSchema.safeParse({
          ...message,
          recordedAt: timestamp,
        }).success
      ).toBe(false);
    }
    expect(
      VertexResearchChatThreadSchema.safeParse({
        ...thread,
        createdAt: "2026-09-23T00:00:01.000000002Z",
        updatedAt: "2026-09-23T00:00:01.000000001Z",
      }).success
    ).toBe(false);
    expect(
      VertexResearchChatThreadSchema.safeParse({
        ...thread,
        updatedAt: thread.createdAt,
      }).success
    ).toBe(true);
    // The shared timestamp contract accepts explicit offsets, not only Z.
    for (const timestamp of [
      "2026-09-23T00:00:00+00:00",
      "2026-09-23T01:00:00+01:00",
      "2026-09-22T23:00:00-01:00",
    ]) {
      expect(
        VertexResearchChatThreadSchema.safeParse({
          ...thread,
          createdAt: timestamp,
          updatedAt: thread.createdAt,
        }).success
      ).toBe(true);
      expect(
        VertexResearchChatMessageSchema.safeParse({
          ...message,
          recordedAt: timestamp,
        }).success
      ).toBe(true);
    }
    return expect(
      VertexResearchChatMessageSchema.safeParse({
        ...message,
        recordedAt: "2000-02-29T00:00:00Z",
      }).success
    ).toBe(true);
  });
});
