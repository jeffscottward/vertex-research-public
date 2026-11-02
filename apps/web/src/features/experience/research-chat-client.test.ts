import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApiClient } from "@darkfactory/api/client";
import type {
  VertexResearchChatCreateThreadInput,
  VertexResearchChatMessage,
  VertexResearchChatRosterEntry,
  VertexResearchChatSendMessageInput,
  VertexResearchChatSendMessageOutput,
  VertexResearchChatThread,
  VertexResearchChatPrepareResponseInput,
  VertexResearchChatPrepareResponseOutput,
  VertexResearchChatResponseReceipt,
  VertexResearchChatAgentReferenceMessage,
  VertexResearchChatAdvisoryProfile,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import { guardExperienceServices } from "./guards.ts";
import type {
  ExperienceResearchChatPort,
  ExperienceServices,
} from "./ports.ts";
import {
  createResearchChatPort,
  guardResearchChatPort,
} from "./research-chat-client.ts";
import { createExperienceServices } from "./transport.ts";
import {
  VertexResearchChatDebatePrepareOutputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
} from "@darkfactory/api/vertex";

const scope = { accountAlias: "account-a", environment: "research" } as const;
const record = { schemaVersion: "1.0.0", executionAuthorized: false } as const;
const envelope = { ...record, ...scope };
const signal = () => new AbortController().signal;
const page = { ...scope, limit: 2, cursor: null } as const;
const selectedThread = { ...scope, threadId: "thread-a" };
const participant = (): VertexResearchChatRosterEntry => ({
  participantId: "expert-a",
  displayName: "Research expert",
  specialty: "Research methods",
  kind: "expert",
  availability: "unavailable",
  reasonCodes: ["not-configured"],
  corpus: {
    status: "unknown",
    collectionId: null,
    snapshotSha256: null,
    reviewId: null,
  },
});
const thread = (): VertexResearchChatThread => ({
  ...envelope,
  threadId: "thread-a",
  title: "Shared research question",
  ownerActorId: "server-actor",
  participantIds: ["expert-a"],
  revision: "9007199254740993",
  createdAt: "2026-09-23T12:00:00Z",
  updatedAt: "2026-09-23T12:00:01Z",
});
const message = (): VertexResearchChatMessage => ({
  ...record,
  threadId: "thread-a",
  messageId: "message-a",
  sequence: "9007199254740993",
  author: { kind: "user", actorId: "server-actor" },
  kind: "statement",
  body: "Compare the research assumptions.",
  citations: [],
  recordedAt: "2026-09-23T12:00:01Z",
});
const create = (): VertexResearchChatCreateThreadInput => ({
  ...scope,
  title: thread().title,
  participantIds: ["expert-a"],
  idempotencyKey: "create-a",
});
const send = (): VertexResearchChatSendMessageInput => ({
  ...selectedThread,
  expectedRevision: "9007199254740993",
  idempotencyKey: "send-a",
  body: message().body,
  requestedParticipantIds: [],
  mode: "discuss",
});
const acknowledgement = (): VertexResearchChatSendMessageOutput => ({
  ...record,
  message: message(),
  threadRevision: "9007199254740994",
  response: {
    status: "not-requested",
    runId: null,
    jobId: null,
    reasonCodes: [],
  },
});
const transcript = () => ({
  ...record,
  thread: { ...thread(), revision: "2" },
  snapshotRevision: "2",
  highWaterSequence: "1",
  items: [{ ...message(), sequence: "1" }],
  nextCursor: null,
});
const transcriptInput = { ...page, threadId: "thread-a", limit: 1 };
const transcriptCursor = async (
  after: string,
  snapshotRevision: string,
  highWaterSequence: string,
  change: Record<string, unknown> = {}
) => {
  const binding = await hashArtifact(
    canonicalArtifactJson({
      operation: "readTranscriptPage",
      version: 2,
      actorId: thread().ownerActorId,
      scope,
      threadId: "thread-a",
      limit: 1,
      after,
      snapshotRevision,
      highWaterSequence,
      ...change,
    })
  );
  return btoa(
    JSON.stringify({
      version: 2,
      operation: "readTranscriptPage",
      binding,
      after,
      snapshotRevision,
      highWaterSequence,
    })
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/u, "");
};
// Wire-boundary fixtures only, never proof of real preparation, review, grants,
// worker admission or current content authority. Default operations stay closed.
const digest = "a".repeat(64);
const preparedRequest = (): VertexResearchChatPrepareResponseInput => ({
  ...selectedThread,
  parentMessageId: "human-a",
  participantId: "expert-a",
  snapshotRevision: "2",
  contextStartSequence: "1",
  retrievalQuery: "Compare the research assumptions.",
  idempotencyKey: "response-key-a",
});
const responseKey = () => ({
  ...selectedThread,
  idempotencyKey: "response-key-a",
});
const executionSelector = () => ({
  ...selectedThread,
  responseRequestId: "response-a",
});
const approval = () => ({
  planId: "plan-a",
  planSha256: digest,
  request: preparedRequest(),
});
const appendInput = () => ({ ...executionSelector(), expectedRevision: "2" });
const contentInput = () => ({ ...executionSelector(), messageId: "agent-a" });
const responseReceipt = (): VertexResearchChatResponseReceipt => ({
  ...envelope,
  threadId: "thread-a",
  ownerActorId: "server-actor",
  responseRequestId: "response-a",
  parentMessageId: "human-a",
  participantId: "expert-a",
  idempotencyKey: "response-key-a",
  requestSha256: digest,
  recordedAt: "2026-09-23T12:00:00Z",
  snapshotRevision: "2",
  contextStartSequence: "1",
  jobId: null,
  status: "unavailable",
  reasonCodes: ["research-runtime-unavailable"],
  admission: null,
});
const reference = (
  sha256 = digest
): VertexResearchChatAgentReferenceMessage => ({
  ...record,
  threadId: "thread-a",
  messageId: "agent-a",
  sequence: "2",
  author: { kind: "agent", participantId: "expert-a", runId: "run-a" },
  kind: "advisory-reference",
  parentMessageId: "human-a",
  replyToMessageId: "human-a",
  recordedAt: "2026-09-23T12:00:01Z",
  response: {
    responseRequestId: "response-a",
    planId: "plan-a",
    planSha256: digest,
    requestSha256: digest,
    contextSha256: digest,
    snapshotRevision: "2",
    contextStartSequence: "1",
    jobId: "job-a",
    traceId: "trace-a",
    eventId: "event-a",
    runArtifact: { artifactId: "run-a", artifactSha256: digest },
    advisoryArtifact: { artifactId: "advisory-a", artifactSha256: sha256 },
    fenceAcknowledgementsSha256: digest,
  },
});
const prepared = (): VertexResearchChatPrepareResponseOutput => ({
  ...record,
  status: "prepared",
  preview: {
    responseRequestId: "response-a",
    planId: "plan-a",
    planSha256: digest,
    request: preparedRequest(),
    context: {
      messageIds: ["human-a"],
      snapshotRevision: "2",
      contextStartSequence: "1",
      highWaterSequence: "1",
      messageCount: 1,
      sha256: digest,
      byteLength: 100,
    },
    expert: {
      participantId: "expert-a",
      configurationSha256: digest,
      modelVersion: "model-a",
    },
    inputs: {
      tokenizeInput: { sha256: digest, byteLength: 100 },
      completionInput: { sha256: digest, byteLength: 100 },
    },
    corpus: {
      collectionId: "collection-a",
      snapshotId: "snapshot-a",
      reviewPins: [
        {
          collectionId: "collection-a",
          evidenceId: "evidence-a",
          artifactId: "evidence-artifact-a",
          artifactSha256: digest,
          reviewId: "review-a",
          reviewVersion: "1",
          rightsPolicyId: "rights-a",
          rightsVersion: "1",
        },
      ],
    },
    model: {
      providerId: "provider-a",
      modelVersion: "model-a",
      servedModel: "model-a",
      modelPolicySha256: digest,
      destination: {
        scheme: "https",
        hostname: "model.example.test",
        port: "",
      },
      tokenizeEndpoint: {
        artifactId: "tokenize-a",
        artifactSha256: digest,
        endpointId: "tokenize",
      },
      completionEndpoint: {
        artifactId: "completion-a",
        artifactSha256: digest,
        endpointId: "completion",
      },
    },
    retention: {
      policyId: "retention-a",
      policyVersion: "1.0.0",
      artifact: { artifactId: "retention-a", artifactSha256: digest },
      rules: [
        { kind: "context", cleanupTrigger: "response-attempt-terminal" },
        { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
        { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
      ],
      earlierCleanupTriggers: ["revocation", "rights-expiry"],
      readNotAfter: "2026-09-23T12:10:00Z",
      guaranteedDeletionDeadline: null,
    },
    storage: {
      storageProfileSha256: digest,
      backendDeploymentId: "deployment-a",
      evidence: { artifactId: "storage-a", artifactSha256: digest },
      namespace: "vertex/chat-copy/v1",
      createSemantics: "conditional-create-no-overwrite",
      readSemantics: "exact-bound-current-bytes-or-fenced",
      fenceSemantics: "conditional-permanent-tombstone-no-resurrection",
      retainedVersions: "no-application-readable-prior-content-version",
      claimScope: "application-managed-copy-namespace-only",
      excludedClaims: [
        "provider",
        "backups",
        "physical-media",
        "RAM",
        "exports",
      ],
    },
    checkedAt: "2026-09-23T12:00:00Z",
    notAfter: "2026-09-23T12:05:00Z",
  },
});
const advisory = (
  text = "A bounded research limitation."
): VertexResearchChatAdvisoryProfile => ({
  profile: "vertex-research-chat-advisory-v1",
  responseRequestId: "response-a",
  planId: "plan-a",
  planSha256: digest,
  runId: "run-a",
  traceId: "trace-a",
  taskContract: "research-a",
  modelVersion: "model-a",
  modelUseRequestSha256: digest,
  responseSha256: digest,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    completionCostUsd: "0.01",
  },
  output: {
    claims: [
      {
        text,
        kind: "limitation",
        citations: [
          {
            evidence_id: "evidence-a",
            source_id: "source-a",
            source_snapshot_id: "snapshot-a",
            content_hash: digest,
            excerpt_digest: digest,
            quote: "Literal source quote.",
          },
        ],
      },
    ],
    proposals: [],
    execution_authorized: false,
  },
  executionAuthorized: false,
});
const privateContent = async (profile = advisory()) => {
  const bytes = canonicalArtifactJson(profile);
  const sha256 = await hashArtifact(bytes);
  return {
    ...record,
    status: "available" as const,
    reference: reference(sha256),
    checkedAt: "2026-09-23T12:00:00Z",
    notAfter: "2026-09-23T12:05:00Z",
    profile,
    sha256,
    byteLength: new TextEncoder().encode(bytes).byteLength,
  };
};
const fixture = () => {
  const api = {
    roster: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...envelope,
        participants: [participant()],
      })
    ),
    listThreads: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...envelope,
        items: [thread()],
        nextCursor: null,
      })
    ),
    createThread: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => thread()
    ),
    readThread: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        thread: thread(),
        participants: [participant()],
      })
    ),
    listMessages: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...envelope,
        threadId: "thread-a",
        items: [message()],
        nextCursor: null,
      })
    ),
    readTranscriptPage: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> =>
        transcript()
    ),
    sendMessage: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> =>
        acknowledgement()
    ),
    prepareResponse: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        selector: responseKey(),
        reasonCodes: ["review-unavailable"],
      })
    ),
    approveAndRequestResponse: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "blocked",
        selector: responseKey(),
        reasonCodes: ["review-unavailable"],
      })
    ),
    readResponse: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        checkedAt: "2026-09-23T12:00:01Z",
        receipt: responseReceipt(),
        job: null,
        delivery: { status: "not-applicable" },
      })
    ),
    appendResponse: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        selector: executionSelector(),
        reasonCodes: ["projection-unavailable"],
      })
    ),
    readResponseContent: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        reference: reference(),
        checkedAt: "2026-09-23T12:00:01Z",
        reasonCodes: ["rights-denied"],
      })
    ),
    prepareDebateStep: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        selector: responseKey(),
        reasonCodes: ["review-unavailable"],
      })
    ),
    approveAndRequestDebateStep: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unknown",
        selector: responseKey(),
        reasonCodes: ["outcome-unknown"],
      })
    ),
    readDebateRun: vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        selector: { ...selectedThread, runKey: "debate-key" },
        checkedAt: "2026-09-23T12:00:00Z",
      })
    ),
  };
  const client = {
    vertex: { experience: {}, researchChat: api },
  } as unknown as ApiClient;
  return { api, client, port: createResearchChatPort(client) };
};
const wireError = (code = "SERVICE_UNAVAILABLE", status = 503) => ({
  defined: true,
  code,
  status,
  message: "private provider text",
  data: { secret: "private" },
});

// Source-authored tests only: no actual API/provider/model, persistent store or network.
describe("strict authenticated research chat browser boundary", () => {
  it("forwards exactly twelve procedures with captured input and the caller AbortSignal", async () => {
    const { api, port } = fixture();
    const abort = signal();
    const calls = [
      ["roster", scope, () => port.roster(scope, abort)],
      ["listThreads", page, () => port.listThreads(page, abort)],
      ["createThread", create(), () => port.createThread(create(), abort)],
      [
        "readThread",
        selectedThread,
        () => port.readThread(selectedThread, abort),
      ],
      [
        "listMessages",
        { ...page, threadId: "thread-a" },
        () => port.listMessages({ ...page, threadId: "thread-a" }, abort),
      ],
      [
        "readTranscriptPage",
        transcriptInput,
        () => port.readTranscriptPage(transcriptInput, abort),
      ],
      ["sendMessage", send(), () => port.sendMessage(send(), abort)],
      [
        "prepareResponse",
        preparedRequest(),
        () => port.prepareResponse(preparedRequest(), abort),
      ],
      [
        "approveAndRequestResponse",
        approval(),
        () => port.approveAndRequestResponse(approval(), abort),
      ],
      [
        "readResponse",
        responseKey(),
        () => port.readResponse(responseKey(), abort),
      ],
      [
        "appendResponse",
        appendInput(),
        () => port.appendResponse(appendInput(), abort),
      ],
      [
        "readResponseContent",
        contentInput(),
        () => port.readResponseContent(contentInput(), abort),
      ],
    ] as const;
    for (const [name, input, invoke] of calls) {
      await invoke();
      expect(api[name]).toHaveBeenCalledExactlyOnceWith(input, {
        signal: abort,
      });
      expect(api[name].mock.calls[0]?.[0]).not.toBe(input);
      expect(Object.isFrozen(api[name].mock.calls[0]?.[0])).toBe(true);
    }
  });

  it("normalizes absent or null injected capability to unavailable without widening old fixtures", () => {
    const missing = async (): Promise<never> => {
      throw new VertexReadError("unavailable");
    };
    const legacy: ExperienceServices = {
      reads: {
        scopes: missing,
        gateways: missing,
        portfolio: missing,
        continuity: missing,
        inbox: missing,
        strategies: missing,
        dossier: missing,
        agents: missing,
        agent: missing,
        audit: missing,
        gateway: missing,
      },
      reviews: null,
      jobs: null,
    };
    expect(guardExperienceServices(legacy).researchChat).toBeNull();
    expect(
      guardExperienceServices({ ...legacy, researchChat: null }).researchChat
    ).toBeNull();
    const client = { vertex: { experience: {} } } as unknown as ApiClient;
    return expect(createExperienceServices(client).researchChat).toBeNull();
  });

  it("wires the guarded optional capability through the existing service factory", async () => {
    const { api, client } = fixture();
    const port = createExperienceServices(client).researchChat;
    if (port === null || port === undefined)
      throw new Error("Expected research chat capability");
    const abort = signal();
    await expect(port.roster(scope, abort)).resolves.toEqual({
      ...envelope,
      participants: [participant()],
    });
    return expect(api.roster).toHaveBeenCalledExactlyOnceWith(scope, {
      signal: abort,
    });
  });

  it("guards injected ports as strictly as typed transport and sanitizes their errors", async () => {
    const { api } = fixture();
    const injected = api as unknown as ExperienceResearchChatPort;
    const guarded = guardResearchChatPort(injected);
    api.roster.mockResolvedValue({
      ...envelope,
      accountAlias: "other",
      participants: [],
    });
    await expect(guarded.roster(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    api.roster.mockRejectedValue(wireError("FORBIDDEN", 403));
    return await expect(guarded.roster(scope, signal())).rejects.toMatchObject({
      kind: "denied",
    });
  });

  it("rejects authority injection on every procedure before an API call", async () => {
    const { api, port } = fixture();
    for (const authority of [
      { actorId: "forged" },
      { grants: ["admin"] },
      { createdAt: "2026-09-23T12:00:00Z" },
      { speaker: "agent" },
      { executionAuthorized: true },
    ]) {
      await expect(
        port.roster({ ...scope, ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.listThreads({ ...page, ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.createThread({ ...create(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.readThread({ ...selectedThread, ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.listMessages(
          { ...page, threadId: "thread-a", ...authority },
          signal()
        )
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.readTranscriptPage({ ...transcriptInput, ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.sendMessage({ ...send(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.prepareResponse({ ...preparedRequest(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.approveAndRequestResponse(
          { ...approval(), ...authority },
          signal()
        )
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.approveAndRequestResponse(
          { ...approval(), request: { ...preparedRequest(), ...authority } },
          signal()
        )
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.readResponse({ ...responseKey(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.appendResponse({ ...appendInput(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.readResponseContent({ ...contentInput(), ...authority }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
  });

  it("rejects nonresearch inputs, unbounded pages, invalid ordinals and duplicate selection", async () => {
    const { api, port } = fixture();
    await expect(
      port.roster(
        { ...scope, environment: "live" } as unknown as typeof scope,
        signal()
      )
    ).rejects.toMatchObject({ kind: "invalid" });
    for (const limit of [0, 101, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        port.listThreads({ ...page, limit }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.listMessages({ ...page, threadId: "thread-a", limit }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
      await expect(
        port.readTranscriptPage({ ...transcriptInput, limit }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    for (const expectedRevision of [
      "0",
      "01",
      "9007199254740993.0",
      "1".repeat(31),
    ]) {
      await expect(
        port.sendMessage({ ...send(), expectedRevision }, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    await expect(
      port.sendMessage(
        { ...send(), requestedParticipantIds: ["expert-a", "expert-a"] },
        signal()
      )
    ).rejects.toMatchObject({ kind: "invalid" });
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
  });

  it("rejects accessors and hidden authority without evaluating getters", async () => {
    const { api, port } = fixture();
    const getter = vi.fn(() => scope.accountAlias);
    const accessor = Object.defineProperty({ ...scope }, "accountAlias", {
      get: getter,
      enumerable: true,
    });
    await expect(port.roster(accessor, signal())).rejects.toMatchObject({
      kind: "invalid",
    });
    const hidden = Object.defineProperty({ ...scope }, "actorId", {
      value: "forged",
      enumerable: false,
    });
    await expect(port.roster(hidden, signal())).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(api.roster).not.toHaveBeenCalled();
    api.roster.mockResolvedValue(
      Object.defineProperty({ ...envelope, participants: [] }, "accountAlias", {
        get: getter,
        enumerable: true,
      })
    );
    await expect(port.roster(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    return expect(getter).not.toHaveBeenCalled();
  });

  it("captures and deeply freezes input before awaiting without freezing caller data", async () => {
    const { api, port } = fixture();
    const input = { ...create(), participantIds: ["expert-a"] };
    api.createThread.mockImplementation(async (captured) => {
      expect(captured).toEqual(create());
      expect(Object.isFrozen(captured)).toBe(true);
      expect(
        Object.isFrozen(
          (captured as VertexResearchChatCreateThreadInput).participantIds
        )
      ).toBe(true);
      await Promise.resolve();
      expect(captured).toEqual(create());
      return thread();
    });
    const pending = port.createThread(input, signal());
    input.title = "Caller changed title";
    input.participantIds.push("expert-b");
    await expect(pending).resolves.toEqual(thread());
    expect(Object.isFrozen(input)).toBe(false);
    return expect(Object.isFrozen(input.participantIds)).toBe(false);
  });

  it("rejects malformed record envelopes and mismatched requested scope", async () => {
    const { api, port } = fixture();
    for (const change of [
      { schemaVersion: "2.0.0" },
      { executionAuthorized: true },
      { accountAlias: "other" },
      { environment: "paper" },
      { secret: "unexpected" },
    ]) {
      api.roster.mockResolvedValue({
        ...envelope,
        participants: [],
        ...change,
      });
      await expect(port.roster(scope, signal())).rejects.toMatchObject({
        kind: "malformed",
      });
      api.listThreads.mockResolvedValue({
        ...envelope,
        items: [],
        nextCursor: null,
        ...change,
      });
      await expect(port.listThreads(page, signal())).rejects.toMatchObject({
        kind: "malformed",
      });
      api.listMessages.mockResolvedValue({
        ...envelope,
        threadId: "thread-a",
        items: [],
        nextCursor: null,
        ...change,
      });
      await expect(
        port.listMessages({ ...page, threadId: "thread-a" }, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    api.roster.mockResolvedValue({
      ...envelope,
      participants: [participant(), participant()],
    });
    return await expect(port.roster(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("binds creation to exact requested scope, literal title and participant identities", async () => {
    const { api, port } = fixture();
    for (const change of [
      { accountAlias: "other" },
      { environment: "paper" },
      { title: "Substituted title" },
      { participantIds: ["expert-b"] },
      { participantIds: ["expert-a", "expert-b"] },
    ]) {
      api.createThread.mockResolvedValue({ ...thread(), ...change });
      await expect(port.createThread(create(), signal())).rejects.toMatchObject(
        { kind: "malformed" }
      );
    }
    api.createThread.mockResolvedValue({
      ...thread(),
      participantIds: ["expert-b", "expert-a"],
    });
    return await expect(
      port.createThread(
        { ...create(), participantIds: ["expert-a", "expert-b"] },
        signal()
      )
    ).resolves.toMatchObject({ participantIds: ["expert-b", "expert-a"] });
  });

  it("binds readThread to requested scope/thread and exact selected roster", async () => {
    const { api, port } = fixture();
    for (const change of [
      { threadId: "thread-b" },
      { accountAlias: "other" },
      { environment: "paper" },
    ]) {
      api.readThread.mockResolvedValue({
        ...record,
        thread: { ...thread(), ...change },
        participants: [participant()],
      });
      await expect(
        port.readThread(selectedThread, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    for (const participants of [
      [],
      [participant(), participant()],
      [{ ...participant(), participantId: "expert-b" }],
    ]) {
      api.readThread.mockResolvedValue({
        ...record,
        thread: thread(),
        participants,
      });
      await expect(
        port.readThread(selectedThread, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("rejects duplicate or cross-scope threads and bounds each page by the explicit limit", async () => {
    const { api, port } = fixture();
    for (const items of [
      [thread(), thread()],
      [{ ...thread(), accountAlias: "other" }],
    ]) {
      api.listThreads.mockResolvedValue({
        ...envelope,
        items,
        nextCursor: null,
      });
      await expect(port.listThreads(page, signal())).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    api.listThreads.mockResolvedValue({
      ...envelope,
      items: [thread(), { ...thread(), threadId: "thread-b" }],
      nextCursor: null,
    });
    await expect(
      port.listThreads({ ...page, limit: 1 }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    api.listMessages.mockResolvedValue({
      ...envelope,
      threadId: "thread-a",
      items: [
        message(),
        { ...message(), messageId: "message-b", sequence: "9007199254740994" },
      ],
      nextCursor: null,
    });
    return await expect(
      port.listMessages({ ...page, threadId: "thread-a", limit: 1 }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects cursor self-loops and empty nonterminal pages for both page procedures", async () => {
    const { api, port } = fixture();
    for (const items of [[], [thread()]]) {
      api.listThreads.mockResolvedValue({
        ...envelope,
        items,
        nextCursor: "page_a",
      });
      await expect(
        port.listThreads({ ...page, cursor: "page_a" }, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    for (const items of [[], [message()]]) {
      api.listMessages.mockResolvedValue({
        ...envelope,
        threadId: "thread-a",
        items,
        nextCursor: "page_a",
      });
      await expect(
        port.listMessages(
          { ...page, threadId: "thread-a", cursor: "page_a" },
          signal()
        )
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    api.listThreads.mockResolvedValue({
      ...envelope,
      items: [],
      nextCursor: "new_page",
    });
    api.listMessages.mockResolvedValue({
      ...envelope,
      threadId: "thread-a",
      items: [],
      nextCursor: "new_page",
    });
    await expect(port.listThreads(page, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    return await expect(
      port.listMessages({ ...page, threadId: "thread-a" }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("validates exact message thread, IDs and ascending integer sequence above 2^53", async () => {
    const { api, port } = fixture();
    const input = { ...page, threadId: "thread-a" };
    const second = {
      ...message(),
      messageId: "message-b",
      sequence: "9007199254740994",
    };
    api.listMessages.mockResolvedValue({
      ...envelope,
      threadId: "thread-a",
      items: [message(), second],
      nextCursor: null,
    });
    await expect(port.listMessages(input, signal())).resolves.toMatchObject({
      items: [message(), second],
    });
    for (const items of [
      [message(), message()],
      [second, message()],
      [message(), { ...second, sequence: message().sequence }],
      [{ ...message(), threadId: "thread-b" }],
    ]) {
      api.listMessages.mockResolvedValue({
        ...envelope,
        threadId: "thread-a",
        items,
        nextCursor: null,
      });
      await expect(port.listMessages(input, signal())).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    api.listMessages.mockResolvedValue({
      ...envelope,
      threadId: "thread-b",
      items: [],
      nextCursor: null,
    });
    return await expect(
      port.listMessages(input, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("binds send acknowledgement to requested body/thread and the exact next revision", async () => {
    const { api, port } = fixture();
    await expect(port.sendMessage(send(), signal())).resolves.toEqual(
      acknowledgement()
    );
    for (const threadRevision of [
      "9007199254740993",
      "9007199254740995",
      "1".repeat(31),
    ]) {
      api.sendMessage.mockResolvedValue({
        ...acknowledgement(),
        threadRevision,
      });
      await expect(port.sendMessage(send(), signal())).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    for (const change of [
      { threadId: "thread-b" },
      { body: "Substituted body" },
      { author: { kind: "agent", participantId: "expert-a", runId: "run-a" } },
      { kind: "synthesis" },
    ]) {
      api.sendMessage.mockResolvedValue({
        ...acknowledgement(),
        message: { ...message(), ...change },
      });
      await expect(port.sendMessage(send(), signal())).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    api.sendMessage.mockResolvedValue({
      ...acknowledgement(),
      threadRevision: `1${"0".repeat(30)}`,
    });
    return await expect(
      port.sendMessage(
        { ...send(), expectedRevision: "9".repeat(30) },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("keeps empty selection human-only in discuss and debate and never synthesizes a run", async () => {
    const { api, port } = fixture();
    for (const mode of ["discuss", "debate"] as const) {
      await expect(
        port.sendMessage({ ...send(), mode }, signal())
      ).resolves.toEqual(acknowledgement());
    }
    for (const response of [
      { status: "queued", runId: "run-a", jobId: "job-a", reasonCodes: [] },
      {
        status: "unavailable",
        runId: null,
        jobId: null,
        reasonCodes: ["not-configured"],
      },
    ]) {
      api.sendMessage.mockResolvedValue({ ...acknowledgement(), response });
      await expect(port.sendMessage(send(), signal())).rejects.toMatchObject({
        kind: "malformed",
      });
    }
    api.sendMessage.mockResolvedValue(acknowledgement());
    await expect(
      port.sendMessage(
        { ...send(), requestedParticipantIds: ["expert-a"] },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
    for (const response of [
      { status: "queued", runId: "run-a", jobId: "job-a", reasonCodes: [] },
      {
        status: "unavailable",
        runId: null,
        jobId: null,
        reasonCodes: ["not-configured"],
      },
    ]) {
      api.sendMessage.mockResolvedValue({ ...acknowledgement(), response });
      await expect(
        port.sendMessage(
          { ...send(), requestedParticipantIds: ["expert-a"] },
          signal()
        )
      ).resolves.toMatchObject({ response });
    }
    for (const name of [
      "roster",
      "listThreads",
      "createThread",
      "readThread",
      "listMessages",
    ] as const)
      expect(api[name]).not.toHaveBeenCalled();
  });

  it("never follows pages, starts background work or retains response data", async () => {
    const { api, port } = fixture();
    const first = { ...envelope, items: [thread()], nextCursor: "page_b" };
    const last = { ...envelope, items: [], nextCursor: null };
    api.listThreads
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(last)
      .mockResolvedValueOnce(last);
    await expect(port.listThreads(page, signal())).resolves.toEqual(first);
    expect(api.listThreads).toHaveBeenCalledTimes(1);
    const next = { ...page, cursor: "page_b", limit: 1 };
    await expect(port.listThreads(next, signal())).resolves.toEqual(last);
    await expect(port.listThreads(page, signal())).resolves.toEqual(last);
    expect(api.listThreads).toHaveBeenNthCalledWith(2, next, {
      signal: expect.any(AbortSignal),
    });
    expect(api.listThreads).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).not.toHaveBeenCalled();
    return expect(api.roster).not.toHaveBeenCalled();
  });

  it("checks cancellation before each call and after an ignored-abort response or rejection", async () => {
    const { api, port } = fixture();
    const controller = new AbortController();
    controller.abort();
    const calls = [
      () => port.roster(scope, controller.signal),
      () => port.listThreads(page, controller.signal),
      () => port.createThread(create(), controller.signal),
      () => port.readThread(selectedThread, controller.signal),
      () =>
        port.listMessages({ ...page, threadId: "thread-a" }, controller.signal),
      () => port.readTranscriptPage(transcriptInput, controller.signal),
      () => port.sendMessage(send(), controller.signal),
      () => port.prepareResponse(preparedRequest(), controller.signal),
      () => port.approveAndRequestResponse(approval(), controller.signal),
      () => port.readResponse(responseKey(), controller.signal),
      () => port.appendResponse(appendInput(), controller.signal),
      () => port.readResponseContent(contentInput(), controller.signal),
    ];
    for (const invoke of calls)
      await expect(invoke()).rejects.toMatchObject({ kind: "suspended" });
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
    for (const reject of [false, true]) {
      const active = new AbortController();
      api.sendMessage.mockImplementation(async () => {
        await Promise.resolve();
        active.abort();
        if (reject) throw wireError("FORBIDDEN", 403);
        return acknowledgement();
      });
      await expect(
        port.sendMessage(send(), active.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
    }
  });

  it("checks cancellation after output validation and never leaks malformed provider details", async () => {
    const { api, port } = fixture();
    const controller = new AbortController();
    const freeze = Object.freeze;
    const spy = vi.spyOn(Object, "freeze").mockImplementation((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, "threadRevision")
      )
        controller.abort();
      return freeze(value);
    });
    try {
      await expect(
        port.sendMessage(send(), controller.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
    } finally {
      spy.mockRestore();
    }
    return expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sanitizes defined failures and rejects spoofed codes or accessor-backed provider errors", async () => {
    const { api, port } = fixture();
    const cases = [
      ["UNAUTHORIZED", 401, "unauthorized"],
      ["FORBIDDEN", 403, "denied"],
      ["NOT_FOUND", 404, "not-found"],
      ["BAD_REQUEST", 400, "invalid"],
      ["INVALID_SOURCE", 502, "malformed"],
      ["SERVICE_UNAVAILABLE", 503, "unavailable"],
      ["CONFLICT", 409, "error"],
      ["FORBIDDEN", 401, "error"],
    ] as const;
    for (const [code, status, kind] of cases) {
      api.roster.mockRejectedValue(wireError(code, status));
      const failure = await port
        .roster(scope, signal())
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VertexReadError);
      expect(failure).toMatchObject({ kind });
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("data");
      expect(failure).not.toHaveProperty("message", "private provider text");
    }
    const getter = vi.fn(() => "FORBIDDEN");
    const accessor = Object.defineProperty(
      { defined: true, status: 403 },
      "code",
      { get: getter }
    );
    for (const error of [
      accessor,
      { code: "FORBIDDEN", status: 403 },
      new Error("private provider text"),
    ]) {
      api.roster.mockRejectedValue(error);
      await expect(port.roster(scope, signal())).rejects.toMatchObject({
        kind: "error",
      });
    }
    expect(getter).not.toHaveBeenCalled();
    api.roster.mockRejectedValue(new VertexReadError("denied"));
    await expect(port.roster(scope, signal())).rejects.toMatchObject({
      kind: "denied",
    });
    const hostile = Object.defineProperty(
      new VertexReadError("denied"),
      "kind",
      {
        get: () => {
          throw new Error("private provider text");
        },
      }
    );
    api.roster.mockRejectedValue(hostile);
    return await expect(port.roster(scope, signal())).rejects.toMatchObject({
      kind: "error",
    });
  });

  it("correlates a fixed transcript boundary after interleaved appends without reading the old APIs", async () => {
    const { api, port } = fixture();
    const next = await transcriptCursor("1", "3", "2");
    const first = {
      ...transcript(),
      thread: { ...thread(), revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      nextCursor: next,
    };
    api.readTranscriptPage.mockResolvedValueOnce(first);
    await expect(
      port.readTranscriptPage(transcriptInput, signal())
    ).resolves.toEqual(first);
    const final = {
      ...first,
      thread: { ...thread(), revision: "4" },
      items: [{ ...message(), sequence: "2" }],
      nextCursor: null,
    };
    api.readTranscriptPage.mockResolvedValueOnce(final);
    const result = await port.readTranscriptPage(
      { ...transcriptInput, cursor: next },
      signal()
    );
    expect(result).toEqual(final);
    expect(Object.isFrozen(result.thread)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(api.readTranscriptPage).toHaveBeenCalledTimes(2);
    expect(api.readThread).not.toHaveBeenCalled();
    expect(api.listMessages).not.toHaveBeenCalled();
    return expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("correlates transcript continuation above Number precision and rejects noncanonical cursor ordinals", async () => {
    const { api, port } = fixture();
    const next = await transcriptCursor(
      "9007199254740992",
      "9007199254740994",
      "9007199254740993"
    );
    const final = {
      ...transcript(),
      thread: { ...thread(), revision: "9007199254740995" },
      snapshotRevision: "9007199254740994",
      highWaterSequence: "9007199254740993",
      items: [message()],
    };
    api.readTranscriptPage.mockResolvedValue(final);
    await expect(
      port.readTranscriptPage({ ...transcriptInput, cursor: next }, signal())
    ).resolves.toEqual(final);
    api.readTranscriptPage.mockResolvedValue({
      ...transcript(),
      thread: { ...thread(), revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [{ ...message(), sequence: "2" }],
    });
    return await expect(
      port.readTranscriptPage(
        { ...transcriptInput, cursor: await transcriptCursor("1\n", "3", "2") },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects transcript head, identity, human-origin, high-water and requested-limit mismatches", async () => {
    const { api, port } = fixture();
    for (const invalid of [
      { ...transcript(), thread: { ...thread(), revision: "3" } },
      {
        ...transcript(),
        thread: { ...thread(), revision: "2", threadId: "other" },
        items: [{ ...message(), sequence: "1", threadId: "other" }],
      },
      {
        ...transcript(),
        thread: { ...thread(), revision: "2", accountAlias: "other" },
      },
      { ...transcript(), snapshotRevision: "3" },
      { ...transcript(), highWaterSequence: "01" },
      { ...transcript(), items: [] },
      {
        ...transcript(),
        items: [
          {
            ...message(),
            sequence: "1",
            author: { kind: "user", actorId: "other" },
          },
        ],
      },
      {
        ...transcript(),
        items: [
          {
            ...message(),
            sequence: "1",
            author: {
              kind: "agent",
              participantId: "expert-a",
              runId: "run-a",
            },
          },
        ],
      },
      {
        ...transcript(),
        thread: { ...thread(), revision: "3" },
        snapshotRevision: "3",
        highWaterSequence: "2",
        items: [
          { ...message(), sequence: "1" },
          { ...message(), messageId: "second", sequence: "2" },
        ],
      },
    ]) {
      api.readTranscriptPage.mockResolvedValue(invalid);
      await expect(
        port.readTranscriptPage(transcriptInput, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("rejects a cursor-null final transcript suffix before it can appear send-ready", async () => {
    const { api, port } = fixture();
    api.readTranscriptPage.mockResolvedValue({
      ...transcript(),
      thread: { ...thread(), revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [{ ...message(), sequence: "2" }],
    });
    return await expect(
      port.readTranscriptPage(transcriptInput, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects forged transcript continuation bindings, changed boundaries and skipped sequences", async () => {
    const { api, port } = fixture();
    const next = await transcriptCursor("1", "3", "2");
    const final = {
      ...transcript(),
      thread: { ...thread(), revision: "4" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [{ ...message(), sequence: "2" }],
    };
    api.readTranscriptPage.mockResolvedValue(final);
    for (const cursor of [
      "opaque_legacy",
      await transcriptCursor("1", "3", "2", { actorId: "other" }),
      await transcriptCursor("1", "3", "2", { limit: 2 }),
      await transcriptCursor("1", "3", "2", { threadId: "other" }),
      await transcriptCursor("1", "3", "2", {
        scope: { ...scope, accountAlias: "other" },
      }),
    ]) {
      await expect(
        port.readTranscriptPage({ ...transcriptInput, cursor }, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    for (const invalid of [
      transcript(),
      {
        ...final,
        snapshotRevision: "4",
        highWaterSequence: "3",
        items: [{ ...message(), sequence: "3" }],
      },
      { ...final, items: [{ ...message(), sequence: "1" }], nextCursor: next },
    ]) {
      api.readTranscriptPage.mockResolvedValue(invalid);
      await expect(
        port.readTranscriptPage({ ...transcriptInput, cursor: next }, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    for (const nextCursor of [next, await transcriptCursor("2", "4", "3")]) {
      api.readTranscriptPage.mockResolvedValue({ ...transcript(), nextCursor });
      await expect(
        port.readTranscriptPage(transcriptInput, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  return it("captures lazy transcript inputs and aborts after an ignored-abort response without automatic work", async () => {
    const { api, port } = fixture();
    expect(api.readTranscriptPage).not.toHaveBeenCalled();
    const input = { ...transcriptInput };
    api.readTranscriptPage.mockImplementation(async (captured) => {
      await Promise.resolve();
      expect(captured).toEqual(transcriptInput);
      expect(Object.isFrozen(captured)).toBe(true);
      return transcript();
    });
    const pending = port.readTranscriptPage(input, signal());
    input.threadId = "changed";
    await expect(pending).resolves.toEqual(transcript());
    const abort = new AbortController();
    api.readTranscriptPage.mockImplementation(async () => {
      await Promise.resolve();
      abort.abort();
      return transcript();
    });
    await expect(
      port.readTranscriptPage(transcriptInput, abort.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    expect(api.readTranscriptPage).toHaveBeenCalledTimes(2);
    return expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("bounded conversation operation correlation", () => {
  it("accepts only the exact original prepare echo and freezes detached preview metadata", async () => {
    const { api, port } = fixture();
    const value = prepared();
    if (value.status !== "prepared")
      throw new Error("Expected preview fixture");
    api.prepareResponse.mockResolvedValue(value);
    const result = await port.prepareResponse(preparedRequest(), signal());
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "prepared")
      throw new Error("Expected prepared boundary");
    expect(Object.isFrozen(result.preview.request)).toBe(true);
    expect(Object.isFrozen(result.preview.corpus.reviewPins)).toBe(true);
    expect(Object.isFrozen(value.preview)).toBe(false);
    for (const change of [
      { accountAlias: "other" },
      { threadId: "other" },
      { idempotencyKey: "other" },
      { retrievalQuery: "Different literal research question." },
    ]) {
      api.prepareResponse.mockResolvedValue({
        ...value,
        preview: {
          ...value.preview,
          request: { ...value.preview.request, ...change },
        },
      });
      await expect(
        port.prepareResponse(preparedRequest(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    expect(api.approveAndRequestResponse).not.toHaveBeenCalled();
    return expect(api.appendResponse).not.toHaveBeenCalled();
  });

  it("binds unavailable prepare and every approval status to the original scoped key", async () => {
    const { api, port } = fixture();
    for (const change of [
      { accountAlias: "other" },
      { environment: "paper" },
      { threadId: "other" },
      { idempotencyKey: "other" },
    ]) {
      const selector = { ...responseKey(), ...change };
      api.prepareResponse.mockResolvedValue({
        ...record,
        status: "unavailable",
        selector,
        reasonCodes: ["review-unavailable"],
      });
      await expect(
        port.prepareResponse(preparedRequest(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
      for (const status of ["blocked", "unknown"] as const) {
        api.approveAndRequestResponse.mockResolvedValue({
          ...record,
          status,
          selector,
          reasonCodes: [
            status === "unknown" ? "outcome-unknown" : "review-unavailable",
          ],
        });
        await expect(
          port.approveAndRequestResponse(approval(), signal())
        ).rejects.toMatchObject({ kind: "malformed" });
      }
    }
    api.approveAndRequestResponse.mockResolvedValue({
      ...record,
      status: "unknown",
      selector: responseKey(),
      reasonCodes: ["outcome-unknown"],
    });
    await expect(
      port.approveAndRequestResponse(approval(), signal())
    ).resolves.toMatchObject({ status: "unknown" });
    return expect(api.readResponse).not.toHaveBeenCalled();
  });

  it("correlates recorded approval receipts without manufacturing admission or rewriting original context", async () => {
    const { api, port } = fixture();
    const receipt = {
      ...responseReceipt(),
      requestSha256: await hashArtifact(
        canonicalArtifactJson(preparedRequest())
      ),
    };
    const output = {
      ...record,
      status: "recorded",
      selector: responseKey(),
      receipt,
    };
    api.approveAndRequestResponse.mockResolvedValue(output);
    await expect(
      port.approveAndRequestResponse(approval(), signal())
    ).resolves.toEqual(output);
    for (const change of [
      { accountAlias: "other" },
      { threadId: "other" },
      { idempotencyKey: "other" },
      { parentMessageId: "other" },
      { participantId: "other" },
      { snapshotRevision: "3" },
      { snapshotRevision: "3", contextStartSequence: "2" },
    ]) {
      api.approveAndRequestResponse.mockResolvedValue({
        ...output,
        receipt: { ...receipt, ...change },
      });
      await expect(
        port.approveAndRequestResponse(approval(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    api.approveAndRequestResponse.mockResolvedValue({
      ...output,
      receipt: { ...receipt, requestSha256: "b".repeat(64) },
    });
    await expect(
      port.approveAndRequestResponse(approval(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    api.approveAndRequestResponse.mockResolvedValue(output);
    await expect(
      port.approveAndRequestResponse(
        {
          ...approval(),
          request: {
            ...preparedRequest(),
            retrievalQuery: "Different literal research question.",
          },
        },
        signal()
      )
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(api.appendResponse).not.toHaveBeenCalled();
    return expect(api.readResponseContent).not.toHaveBeenCalled();
  });

  it("captures the approval request once and rejects hidden or accessor-backed authority", async () => {
    const { api, port } = fixture();
    const input = approval();
    const expected = approval();
    api.approveAndRequestResponse.mockImplementation(async (captured) => {
      await Promise.resolve();
      expect(captured).toEqual(expected);
      expect(Object.isFrozen((captured as typeof expected).request)).toBe(true);
      return {
        ...record,
        status: "blocked",
        selector: responseKey(),
        reasonCodes: ["review-unavailable"],
      };
    });
    const pending = port.approveAndRequestResponse(input, signal());
    input.request.retrievalQuery = "Changed after the call begins.";
    input.planId = "changed";
    await expect(pending).resolves.toMatchObject({ status: "blocked" });
    expect(Object.isFrozen(input.request)).toBe(false);
    api.approveAndRequestResponse.mockClear();
    const getter = vi.fn(() => "forged");
    const accessor = Object.defineProperty(approval(), "planId", {
      get: getter,
      enumerable: true,
    });
    const hidden = Object.defineProperty(approval(), "grants", {
      value: ["admin"],
      enumerable: false,
    });
    for (const invalid of [accessor, hidden]) {
      await expect(
        port.approveAndRequestResponse(invalid, signal())
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(getter).not.toHaveBeenCalled();
    return expect(api.approveAndRequestResponse).not.toHaveBeenCalled();
  });

  it("keeps readResponse bodyless and binds its immutable receipt to the original key and scope", async () => {
    const { api, port } = fixture();
    const output = {
      ...record,
      checkedAt: "2026-09-23T12:00:01Z",
      receipt: responseReceipt(),
      job: null,
      delivery: { status: "not-applicable" },
    };
    await expect(port.readResponse(responseKey(), signal())).resolves.toEqual(
      output
    );
    for (const change of [
      { accountAlias: "other" },
      { environment: "paper" },
      { threadId: "other" },
      { idempotencyKey: "other" },
    ]) {
      api.readResponse.mockResolvedValue({
        ...output,
        receipt: { ...responseReceipt(), ...change },
      });
      await expect(
        port.readResponse(responseKey(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    for (const invalid of [
      { ...output, profile: advisory() },
      { ...output, body: "private prose" },
      { ...output, receipt: { ...responseReceipt(), body: "private prose" } },
      { ...output, delivery: { status: "eligible", ready: true } },
    ]) {
      api.readResponse.mockResolvedValue(invalid);
      await expect(
        port.readResponse(responseKey(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    expect(api.readResponseContent).not.toHaveBeenCalled();
    return expect(api.appendResponse).not.toHaveBeenCalled();
  });

  it("accepts exact append CAS and earlier immutable replay but rejects impossible future or unrelated references", async () => {
    const { api, port } = fixture();
    const output = {
      ...record,
      status: "appended",
      selector: executionSelector(),
      message: reference(),
      threadRevision: "3",
    };
    api.appendResponse.mockResolvedValue(output);
    await expect(port.appendResponse(appendInput(), signal())).resolves.toEqual(
      output
    );
    await expect(
      port.appendResponse(
        { ...appendInput(), expectedRevision: "9007199254740993" },
        signal()
      )
    ).resolves.toEqual(output);
    for (const invalid of [
      {
        ...output,
        selector: { ...executionSelector(), accountAlias: "other" },
      },
      {
        ...output,
        selector: { ...executionSelector(), threadId: "other" },
        message: { ...reference(), threadId: "other" },
      },
      {
        ...output,
        selector: { ...executionSelector(), responseRequestId: "other" },
        message: {
          ...reference(),
          response: { ...reference().response, responseRequestId: "other" },
        },
      },
      {
        ...output,
        message: { ...reference(), sequence: "3" },
        threadRevision: "4",
      },
      { ...output, threadRevision: "4" },
      { ...output, message: { ...reference(), body: "private prose" } },
    ]) {
      api.appendResponse.mockResolvedValue(invalid);
      await expect(
        port.appendResponse(appendInput(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    expect(api.readResponseContent).not.toHaveBeenCalled();
    return expect(api.approveAndRequestResponse).not.toHaveBeenCalled();
  });

  it("rejects wrong operation scope even on unavailable and unknown append results", async () => {
    const { api, port } = fixture();
    for (const status of ["unavailable", "unknown"] as const) {
      for (const change of [
        { accountAlias: "other" },
        { threadId: "other" },
        { responseRequestId: "other" },
      ]) {
        api.appendResponse.mockResolvedValue({
          ...record,
          status,
          selector: { ...executionSelector(), ...change },
          reasonCodes: [
            status === "unknown" ? "outcome-unknown" : "projection-unavailable",
          ],
        });
        await expect(
          port.appendResponse(appendInput(), signal())
        ).rejects.toMatchObject({ kind: "malformed" });
      }
    }
  });

  it("checks exact private reference identity for both unavailable and available content", async () => {
    const { api, port } = fixture();
    const available = await privateContent();
    const unavailable = {
      ...record,
      status: "unavailable",
      reference: reference(),
      checkedAt: available.checkedAt,
      reasonCodes: ["rights-denied"],
    };
    for (const output of [available, unavailable]) {
      api.readResponseContent.mockResolvedValue(output);
      await expect(
        port.readResponseContent(contentInput(), signal())
      ).resolves.toEqual(output);
      for (const change of [
        { messageId: "other" },
        { threadId: "other" },
        {
          response: {
            ...output.reference.response,
            responseRequestId: "other",
          },
        },
      ]) {
        api.readResponseContent.mockResolvedValue({
          ...output,
          reference: { ...output.reference, ...change },
        });
        await expect(
          port.readResponseContent(contentInput(), signal())
        ).rejects.toMatchObject({ kind: "malformed" });
      }
    }
    expect(api.sendMessage).not.toHaveBeenCalled();
    return expect(api.readResponse).not.toHaveBeenCalled();
  });

  it("hashes actual canonical private bytes rather than trusting matching metadata digests", async () => {
    const { api, port } = fixture();
    const output = await privateContent();
    api.readResponseContent.mockResolvedValue(output);
    const result = await port.readResponseContent(contentInput(), signal());
    expect(result).toEqual(output);
    if (result.status !== "available")
      throw new Error("Expected content fixture");
    expect(Object.isFrozen(result.profile.output.claims[0]?.citations)).toBe(
      true
    );
    expect(Object.isFrozen(output.profile)).toBe(false);
    const claim = output.profile.output.claims[0]!;
    const changedProfile = {
      ...output.profile,
      output: {
        ...output.profile.output,
        claims: [{ ...claim, text: claim.text.replace("bounded", "altered") }],
      },
    };
    for (const invalid of [
      { ...output, profile: changedProfile },
      { ...output, sha256: digest, reference: reference(digest) },
      { ...output, byteLength: output.byteLength + 1 },
      { ...output, profile: { ...output.profile, executionAuthorized: true } },
      { ...output, profile: { ...output.profile, grants: ["admin"] } },
      { ...output, notAfter: output.checkedAt },
    ]) {
      api.readResponseContent.mockResolvedValue(invalid);
      await expect(
        port.readResponseContent(contentInput(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("preserves native Unicode codepoints and literal text without trimming or normalization", async () => {
    const { api, port } = fixture();
    const literal = ` ${"\u{20000}".repeat(1994)}e\u0301\n `;
    const output = await privateContent(advisory(literal));
    api.readResponseContent.mockResolvedValue(output);
    const result = await port.readResponseContent(contentInput(), signal());
    if (result.status !== "available")
      throw new Error("Expected private content");
    expect(result.profile.output.claims[0]?.text).toBe(literal);
    expect(result.sha256).toBe(
      await hashArtifact(canonicalArtifactJson(output.profile))
    );
    for (const text of [
      "\u{20000}".repeat(2001),
      "Unpaired \ud800 scalar",
      "Control\u0000text",
    ]) {
      api.readResponseContent.mockResolvedValue({
        ...output,
        profile: advisory(text),
      });
      await expect(
        port.readResponseContent(contentInput(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("never retains a prior private body across a later denied or malformed read", async () => {
    const { api, port } = fixture();
    const output = await privateContent();
    api.readResponseContent
      .mockResolvedValueOnce(output)
      .mockRejectedValueOnce(wireError("FORBIDDEN", 403))
      .mockResolvedValueOnce({ ...output, body: "extra" });
    await expect(
      port.readResponseContent(contentInput(), signal())
    ).resolves.toEqual(output);
    await expect(
      port.readResponseContent(contentInput(), signal())
    ).rejects.toMatchObject({ kind: "denied" });
    await expect(
      port.readResponseContent(contentInput(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    return expect(api.readResponseContent).toHaveBeenCalledTimes(3);
  });

  it("late cancellation dominates both resolved and rejected outcomes on all five operations", async () => {
    for (const reject of [false, true]) {
      const { api, port } = fixture();
      const calls = [
        [
          "prepareResponse",
          (abort: AbortSignal) =>
            port.prepareResponse(preparedRequest(), abort),
        ],
        [
          "approveAndRequestResponse",
          (abort: AbortSignal) =>
            port.approveAndRequestResponse(approval(), abort),
        ],
        [
          "readResponse",
          (abort: AbortSignal) => port.readResponse(responseKey(), abort),
        ],
        [
          "appendResponse",
          (abort: AbortSignal) => port.appendResponse(appendInput(), abort),
        ],
        [
          "readResponseContent",
          (abort: AbortSignal) =>
            port.readResponseContent(contentInput(), abort),
        ],
      ] as const;
      for (const [name, invoke] of calls) {
        const controller = new AbortController();
        const output = await api[name](undefined, undefined);
        api[name].mockClear();
        api[name].mockImplementation(async () => {
          await Promise.resolve();
          controller.abort();
          if (reject) throw wireError("FORBIDDEN", 403);
          return output;
        });
        await expect(invoke(controller.signal)).rejects.toMatchObject({
          kind: "suspended",
        });
        expect(api[name]).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("checks cancellation after private profile parsing without returning held bytes", async () => {
    const { api, port } = fixture();
    api.readResponseContent.mockResolvedValue(await privateContent());
    const controller = new AbortController();
    const originalFreeze = Object.freeze;
    const spy = vi.spyOn(Object, "freeze").mockImplementation((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, "profile")
      )
        controller.abort();
      return originalFreeze(value);
    });
    try {
      return await expect(
        port.readResponseContent(contentInput(), controller.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
    } finally {
      spy.mockRestore();
    }
  });

  it("checks cancellation again after asynchronous canonical profile hashing", async () => {
    const { api, port } = fixture();
    const output = await privateContent();
    api.readResponseContent.mockResolvedValue(output);
    const controller = new AbortController();
    // Browser code path: a window selects WebCrypto hashing (server runtimes hash synchronously).
    vi.stubGlobal("window", globalThis);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, bytes) => {
        const result = await originalDigest(algorithm, bytes);
        controller.abort();
        return result;
      });
    try {
      await expect(
        port.readResponseContent(contentInput(), controller.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
      return expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects authority and ordinary prose injected into every new operation output", async () => {
    const { api, port } = fixture();
    const calls = [
      [
        "prepareResponse",
        () => port.prepareResponse(preparedRequest(), signal()),
      ],
      [
        "approveAndRequestResponse",
        () => port.approveAndRequestResponse(approval(), signal()),
      ],
      ["readResponse", () => port.readResponse(responseKey(), signal())],
      ["appendResponse", () => port.appendResponse(appendInput(), signal())],
      [
        "readResponseContent",
        () => port.readResponseContent(contentInput(), signal()),
      ],
    ] as const;
    for (const [name, invoke] of calls) {
      const output = (await api[name](undefined, undefined)) as Record<
        string,
        unknown
      >;
      for (const change of [
        { grants: ["admin"] },
        { ready: true },
        { body: "ordinary private prose" },
        { executionAuthorized: true },
      ]) {
        api[name].mockResolvedValue({ ...output, ...change });
        await expect(invoke()).rejects.toMatchObject({ kind: "malformed" });
      }
      const getter = vi.fn(() => "forged");
      api[name].mockResolvedValue(
        Object.defineProperty({ ...output }, "authority", {
          get: getter,
          enumerable: true,
        })
      );
      await expect(invoke()).rejects.toMatchObject({ kind: "malformed" });
      expect(getter).not.toHaveBeenCalled();
    }
  });

  return it("checks late cancellation after hashing the exact recorded approval request", async () => {
    const { api, port } = fixture();
    const receipt = {
      ...responseReceipt(),
      requestSha256: await hashArtifact(
        canonicalArtifactJson(preparedRequest())
      ),
    };
    api.approveAndRequestResponse.mockResolvedValue({
      ...record,
      status: "recorded",
      selector: responseKey(),
      receipt,
    });
    const controller = new AbortController();
    // Browser code path: a window selects WebCrypto hashing (server runtimes hash synchronously).
    vi.stubGlobal("window", globalThis);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, bytes) => {
        const result = await originalDigest(algorithm, bytes);
        controller.abort();
        return result;
      });
    try {
      await expect(
        port.approveAndRequestResponse(approval(), controller.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
      return expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

const debateRequest = () => ({
  ...preparedRequest(),
  debate: {
    profile: "vertex-research-chat-debate-step-v1" as const,
    runKey: "debate-key",
    ordinal: 1,
    predecessors: [],
  },
});
const debatePreview = () => {
  const base = prepared();
  if (base.status !== "prepared") throw new Error("Expected source fixture");
  return VertexResearchChatDebatePrepareOutputSchema.parse({
    ...base,
    preview: {
      ...base.preview,
      request: debateRequest(),
      debate: {
        profile: "vertex-research-chat-debate-plan-v1",
        debateRunId: "debate-run",
        runKey: "debate-key",
        ordinal: 1,
        kind: "statement",
        configuration: {
          artifactId: "debate-config",
          artifactSha256: digest,
          contractName: "vertex-research-chat-debate-configuration-v1",
          schemaVersion: "1.0.0",
        },
        participantIds: ["expert-a", "expert-b"],
        synthesizerId: "expert-b",
        humanWindowSha256: digest,
        predecessors: [],
        turnTokens: 100,
        turnCostUsd: "0.1",
        aggregateTokens: 500,
        aggregateCostUsd: "0.5",
        derivedContext: { sha256: digest, byteLength: 100 },
      },
    },
  });
};

describe("stepwise debate browser boundary", () => {
  it("captures and freezes exact v2 preparation without dispatch or read side effects", async () => {
    const { api, port } = fixture();
    api.prepareDebateStep.mockResolvedValue(debatePreview());
    const input = debateRequest();
    const result = await port.prepareDebateStep(input, signal());
    expect(result.status).toBe("prepared");
    expect(Object.isFrozen(api.prepareDebateStep.mock.calls[0]?.[0])).toBe(
      true
    );
    expect(api.approveAndRequestDebateStep).not.toHaveBeenCalled();
    expect(api.readDebateRun).not.toHaveBeenCalled();
    return expect(api.prepareResponse).not.toHaveBeenCalled();
  });

  it("rejects mismatched step, predecessor and selected speaker pins", async () => {
    const { api, port } = fixture();
    const value = debatePreview();
    if (value.status !== "prepared") throw new Error("Expected debate fixture");
    for (const change of [
      { runKey: "other" },
      { participantIds: ["expert-b", "expert-a"] },
    ]) {
      api.prepareDebateStep.mockResolvedValue({
        ...value,
        preview: {
          ...value.preview,
          debate: { ...value.preview.debate, ...change },
        },
      });
      await expect(
        port.prepareDebateStep(debateRequest(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    const predecessor = {
      ordinal: 1,
      participantId: "expert-a",
      responseRequestId: "prior",
      planId: "prior-plan",
      planSha256: digest,
      runId: "prior-run",
      copyId: "prior-copy",
      reservationSha256: digest,
      contentSha256: digest,
      byteLength: 100,
      publishedAt: value.preview.checkedAt,
    };
    const input = {
      ...debateRequest(),
      participantId: "expert-b",
      debate: {
        ...debateRequest().debate,
        ordinal: 2,
        predecessors: [predecessor],
      },
    };
    api.prepareDebateStep.mockResolvedValue({
      ...value,
      preview: {
        ...value.preview,
        request: input,
        expert: { ...value.preview.expert, participantId: "expert-b" },
        debate: {
          ...value.preview.debate,
          ordinal: 2,
          predecessors: [{ ...predecessor, contentSha256: "b".repeat(64) }],
        },
      },
    });
    return await expect(
      port.prepareDebateStep(input, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("keeps unknown approval on the original key and validates the v2 request digest", async () => {
    const { api, port } = fixture();
    const input = {
      planId: "plan-a",
      planSha256: digest,
      request: debateRequest(),
    };
    await expect(
      port.approveAndRequestDebateStep(input, signal())
    ).resolves.toMatchObject({ status: "unknown", selector: responseKey() });
    expect(api.readResponse).not.toHaveBeenCalled();
    const receipt = {
      ...responseReceipt(),
      requestSha256: await hashArtifact(canonicalArtifactJson(input.request)),
    };
    api.approveAndRequestDebateStep.mockResolvedValue({
      ...record,
      status: "recorded",
      selector: responseKey(),
      receipt,
    });
    await expect(
      port.approveAndRequestDebateStep(input, signal())
    ).resolves.toMatchObject({ status: "recorded" });
    api.approveAndRequestDebateStep.mockResolvedValue({
      ...record,
      status: "recorded",
      selector: responseKey(),
      receipt: {
        ...receipt,
        requestSha256: await hashArtifact(
          canonicalArtifactJson(preparedRequest())
        ),
      },
    });
    return await expect(
      port.approveAndRequestDebateStep(input, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("reads only bound metadata and rejects fabricated next-step readiness and authority", async () => {
    const { api, port } = fixture();
    const selector = { ...selectedThread, runKey: "debate-key" };
    await expect(port.readDebateRun(selector, signal())).resolves.toMatchObject(
      { status: "unavailable" }
    );
    const value = debatePreview();
    if (value.status !== "prepared") throw new Error("Expected debate fixture");
    const { debate } = value.preview;
    const available = {
      ...record,
      status: "available",
      selector,
      debateRunId: debate.debateRunId,
      participantIds: debate.participantIds,
      synthesizerId: debate.synthesizerId,
      configuration: debate.configuration,
      humanWindowSha256: digest,
      collectionId: "collection-a",
      snapshotId: "snapshot-a",
      turnTokens: 100,
      turnCostUsd: "0.1",
      aggregateTokens: 500,
      aggregateCostUsd: "0.5",
      chargedTokens: "0",
      chargedUsdUnits: "0",
      steps: [],
      nextStep: debateRequest().debate,
      complete: false,
      checkedAt: value.preview.checkedAt,
      notAfter: value.preview.notAfter,
    };
    api.readDebateRun.mockResolvedValue(
      VertexResearchChatReadDebateRunOutputSchema.parse(available)
    );
    await expect(port.readDebateRun(selector, signal())).resolves.toMatchObject(
      { status: "available" }
    );
    for (const change of [
      { selector: { ...selector, runKey: "other" } },
      { nextStep: { ...debateRequest().debate, runKey: "other" } },
      { complete: true },
      { chargedTokens: "1" },
      { answer: "Private answer" },
      { executionAuthorized: true },
    ]) {
      api.readDebateRun.mockResolvedValue({ ...available, ...change });
      await expect(
        port.readDebateRun(selector, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    expect(api.prepareDebateStep).not.toHaveBeenCalled();
    return expect(api.approveAndRequestDebateStep).not.toHaveBeenCalled();
  });

  return it("fails closed on cancellation and hostile DTOs for all debate operations", async () => {
    const { api, port } = fixture();
    const selector = { ...selectedThread, runKey: "debate-key" };
    const approvalInput = {
      planId: "plan-a",
      planSha256: digest,
      request: debateRequest(),
    };
    for (const [name, input] of [
      ["prepareDebateStep", debateRequest()],
      ["approveAndRequestDebateStep", approvalInput],
      ["readDebateRun", selector],
    ] as const) {
      const controller = new AbortController();
      api[name].mockImplementation(async () => {
        controller.abort();
        throw wireError();
      });
      const invoke = port[name] as (
        input: unknown,
        signal: AbortSignal
      ) => Promise<unknown>;
      await expect(invoke(input, controller.signal)).rejects.toMatchObject({
        kind: "suspended",
      });
      api[name].mockClear();
      const getter = vi.fn(() => "authority");
      const hostile = Object.defineProperty({ ...input }, "authority", {
        enumerable: true,
        get: getter,
      });
      await expect(invoke(hostile, signal())).rejects.toMatchObject({
        kind: "invalid",
      });
      expect(getter).not.toHaveBeenCalled();
      expect(api[name]).not.toHaveBeenCalled();
    }
  });
});

describe("bounded native evidence browser boundary", () => {
  const nativeRequest = () => ({
    ...preparedRequest(),
    participantId: "first-mate" as const,
    protocol: "first-mate-read-reviewed-evidence-v1" as const,
  });
  const nativeApproval = () => ({
    planId: "plan-a",
    planSha256: digest,
    request: nativeRequest(),
    consent: "approve-bounded-native-evidence-protocol-v1" as const,
  });
  const setup = () => {
    const f = fixture();
    const prepareNativeEvidence = vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unavailable",
        selector: responseKey(),
        reasonCodes: ["review-unavailable"],
      })
    );
    const approveAndRequestNativeEvidence = vi.fn(
      async (_input: unknown, _options: unknown): Promise<unknown> => ({
        ...record,
        status: "unknown",
        selector: responseKey(),
        reasonCodes: ["outcome-unknown"],
      })
    );
    const client = {
      vertex: {
        experience: {},
        researchChat: {
          ...f.api,
          prepareNativeEvidence,
          approveAndRequestNativeEvidence,
        },
      },
    } as unknown as ApiClient;
    return {
      prepareNativeEvidence,
      approveAndRequestNativeEvidence,
      port: createResearchChatPort(client),
    };
  };

  it("forwards an unavailable native preparation only for the original scoped key", async () => {
    const { prepareNativeEvidence, port } = setup();
    const abort = signal();
    await expect(
      port.prepareNativeEvidence(nativeRequest(), abort)
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(prepareNativeEvidence).toHaveBeenCalledExactlyOnceWith(
      nativeRequest(),
      { signal: abort }
    );
    prepareNativeEvidence.mockResolvedValueOnce({
      ...record,
      status: "unavailable",
      selector: { ...responseKey(), idempotencyKey: "other" },
      reasonCodes: ["review-unavailable"],
    });
    return await expect(
      port.prepareNativeEvidence(nativeRequest(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  return it("binds native approval receipts to the exact original request", async () => {
    const { approveAndRequestNativeEvidence, port } = setup();
    const abort = signal();
    await expect(
      port.approveAndRequestNativeEvidence(nativeApproval(), abort)
    ).resolves.toMatchObject({ status: "unknown" });
    expect(approveAndRequestNativeEvidence).toHaveBeenCalledExactlyOnceWith(
      nativeApproval(),
      { signal: abort }
    );
    const receipt = {
      ...responseReceipt(),
      participantId: "first-mate",
      requestSha256: await hashArtifact(canonicalArtifactJson(nativeRequest())),
    };
    const output = {
      ...record,
      status: "recorded",
      selector: responseKey(),
      receipt,
    };
    approveAndRequestNativeEvidence.mockResolvedValueOnce(output);
    await expect(
      port.approveAndRequestNativeEvidence(nativeApproval(), signal())
    ).resolves.toEqual(output);
    for (const change of [
      { parentMessageId: "other" },
      { participantId: "expert-a" },
      { snapshotRevision: "3" },
      { snapshotRevision: "3", contextStartSequence: "2" },
      { requestSha256: "b".repeat(64) },
      { idempotencyKey: "other" },
    ]) {
      approveAndRequestNativeEvidence.mockResolvedValueOnce({
        ...output,
        receipt: { ...receipt, ...change },
      });
      await expect(
        port.approveAndRequestNativeEvidence(nativeApproval(), signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
    approveAndRequestNativeEvidence.mockResolvedValueOnce({
      ...output,
      selector: { ...responseKey(), threadId: "other" },
    });
    return await expect(
      port.approveAndRequestNativeEvidence(nativeApproval(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});
