import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  VertexStoreError,
  type VertexAuthorizationRepository,
  type VertexPage,
  type VertexRecord,
  type VertexStore,
} from "@darkfactory/db/server/vertex";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { vertexPersistenceBoundary } from "./server/vertex-experience-adapter.ts";
import type { VertexExperienceDependencies } from "./server/vertex-experience-core.ts";
import {
  getResearchChatRoster,
  listResearchChatThreads,
  createResearchChatThread,
  readResearchChatThread,
  listResearchChatMessages,
  readResearchChatTranscriptPage,
  sendResearchChatMessage,
  requestResearchChatResponse,
  readResearchChatResponse,
} from "./server/vertex-research-chat.ts";

// Synthetic ports only: no accounts, DB, provider, corpus or model execution.
const principal: SafePrincipal = {
  userId: "fixture-member",
  role: "member",
  status: "active",
};
const scope = {
  accountAlias: "fixture-research",
  environment: "research" as const,
};
const now = "2026-09-23T12:00:00Z";
const base = { schemaVersion: "1.0.0", executionAuthorized: false } as const;
const createInput = {
  ...scope,
  title: "Literal <b>research</b>",
  participantIds: ["jan-smolen"],
  idempotencyKey: "create-a",
};
const sendInput = {
  ...scope,
  threadId: "thread-a",
  expectedRevision: "1",
  idempotencyKey: "send-a",
  body: "Literal <script>not executable</script>",
  requestedParticipantIds: ["jan-smolen"],
  mode: "discuss" as const,
};
const thread = {
  ...base,
  ...scope,
  threadId: "thread-a",
  title: createInput.title,
  ownerActorId: principal.userId,
  participantIds: ["jan-smolen"],
  createdAt: now,
  updatedAt: now,
  revision: "1",
};
const message = {
  ...base,
  threadId: thread.threadId,
  messageId: "message-a",
  sequence: "1",
  author: { kind: "user", actorId: principal.userId },
  kind: "statement",
  body: sendInput.body,
  citations: [],
  recordedAt: now,
};
const ack = {
  ...base,
  message,
  threadRevision: "2",
  response: {
    status: "unavailable",
    runId: null,
    jobId: null,
    reasonCodes: ["research-chat-agent-admission-unavailable"],
  },
};
const transcriptInput = {
  ...scope,
  threadId: thread.threadId,
  limit: 1,
  cursor: null,
};
const transcript = {
  ...base,
  thread: { ...thread, revision: "2" },
  snapshotRevision: "2",
  highWaterSequence: "1",
  items: [message],
  nextCursor: null,
};
const responseInput = {
  ...scope,
  threadId: thread.threadId,
  parentMessageId: message.messageId,
  participantId: "jan-smolen",
  snapshotRevision: "2",
  contextStartSequence: "1",
  retrievalQuery: "  Literal <b>research</b> query  ",
  idempotencyKey: "response-a",
};
const readResponseInput = {
  ...scope,
  threadId: thread.threadId,
  idempotencyKey: responseInput.idempotencyKey,
};
const fixture = () => {
  const authorize = vi.fn(
    async (
      _request: Parameters<VertexAuthorizationRepository["authorize"]>[0]
    ) => true
  );
  const resolvePolicy = vi.fn(async () => {
    throw new Error("Model policy must remain unused");
  });
  const store = {
    listResearchChatThreads: vi.fn(
      async (): Promise<VertexPage<VertexRecord>> => ({
        items: [thread],
        nextCursor: null,
      })
    ),
    createResearchChatThread: vi.fn(async (): Promise<VertexRecord> => thread),
    readResearchChatThread: vi.fn(async () => thread as VertexRecord | null),
    listResearchChatMessages: vi.fn(
      async (): Promise<VertexPage<VertexRecord>> => ({
        items: [message],
        nextCursor: null,
      })
    ),
    readResearchChatTranscriptPage: vi.fn(
      async (): Promise<VertexRecord | null> => transcript
    ),
    sendResearchChatMessage: vi.fn(async (): Promise<VertexRecord> => ack),
    requestResearchChatResponse: vi.fn(
      async (): Promise<VertexRecord> => responseResult()
    ),
    readResearchChatResponse: vi.fn(
      async (): Promise<VertexRecord | null> => ({
        ...base,
        checkedAt: now,
        receipt: await responseResult(),
        job: null,
        delivery: { status: "not-applicable" },
      })
    ),
  };
  const dependencies: VertexExperienceDependencies = {
    store: store as unknown as VertexStore,
    authorization: {
      authorize,
      listAuthorizedScopes: vi.fn(async () => [scope]),
      issueGrant: vi.fn(async () => {
        throw new Error("Unexpected grant");
      }),
      revokeGrant: vi.fn(async () => {
        throw new Error("Unexpected revocation");
      }),
      discoverCleanupFamilies: vi.fn(async () => {
        throw new Error("Unexpected cleanup discovery");
      }),
      authorizeCleanupFamily: vi.fn(async () => {
        throw new Error("Unexpected cleanup authorization");
      }),
    },
    clock: { now: () => now },
    resolvePolicy,
  };
  return { dependencies, store, authorize, resolvePolicy };
};

const rejection = async (promise: Promise<unknown>, code: string) => {
  return await expect(promise).rejects.toMatchObject({
    name: "VertexExperienceServiceError",
    code,
  });
};

const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
const createResult = async () => ({
  ...thread,
  threadId: `chat-${await hash({ operation: "createThread", actorId: principal.userId, scope, idempotencyKey: createInput.idempotencyKey })}`,
});
const sendResult = async () => ({
  ...ack,
  message: {
    ...message,
    messageId: `message-${await hash({ operation: "sendMessage", actorId: principal.userId, scope, threadId: thread.threadId, idempotencyKey: sendInput.idempotencyKey })}`,
  },
});
const responseResult = async (input = responseInput) => {
  const { retrievalQuery: _retrievalQuery, ...metadata } = input;
  return {
    ...base,
    ...metadata,
    ownerActorId: principal.userId,
    responseRequestId: `response-${await hash({ operation: "requestResponse", actorId: principal.userId, scope: { accountAlias: input.accountAlias, environment: input.environment }, threadId: input.threadId, idempotencyKey: input.idempotencyKey })}`,
    requestSha256: await hash({
      operation: "requestResponse",
      actorId: principal.userId,
      input,
    }),
    recordedAt: now,
    status: "unavailable",
    reasonCodes: ["research-runtime-unavailable"],
    admission: null,
    jobId: null,
  };
};
const cursor = async (
  operation: "listThreads" | "listMessages",
  after: string,
  limit = 1,
  actorId = principal.userId,
  threadId: string | null = null
) => {
  const binding = await hash({ operation, actorId, scope, threadId, limit });
  return btoa(JSON.stringify({ version: 1, binding, after }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/u, "");
};
const transcriptCursor = async (
  after: string,
  snapshotRevision: string,
  highWaterSequence: string,
  change: Record<string, unknown> = {}
) => {
  const fields = {
    operation: "readTranscriptPage",
    version: 2,
    actorId: principal.userId,
    scope,
    threadId: thread.threadId,
    limit: 1,
    after,
    snapshotRevision,
    highWaterSequence,
    ...change,
  };
  const binding = await hash(fields);
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

describe("human-only research chat service", () => {
  it("lists a truthful configured corpus roster without policy or model resolution", async () => {
    const h = fixture();
    const roster = await getResearchChatRoster(
      h.dependencies,
      principal,
      scope
    );
    expect(roster.participants).toHaveLength(17);
    expect(
      roster.participants.filter((entry) => entry.kind === "expert")
    ).toHaveLength(16);
    for (const entry of roster.participants) {
      expect(entry.availability).toBe("unavailable");
      expect(entry.corpus).toEqual({
        status: entry.kind === "expert" ? "incomplete" : "unknown",
        collectionId: null,
        snapshotSha256: null,
        reviewId: null,
      });
      expect(entry.reasonCodes).toEqual([
        entry.kind === "expert"
          ? "corpus-not-qualified"
          : "tools-not-integrated",
      ]);
    }
    expect(h.resolvePolicy).not.toHaveBeenCalled();
    return expect(
      h.authorize.mock.calls.map(([request]) => [
        request.resourceId,
        request.action,
      ])
    ).toEqual([
      ["account-scope", "read"],
      ["research-chat", "read"],
    ]);
  });

  it("requires active identity and research account/resource access", async () => {
    const h = fixture();
    await rejection(
      getResearchChatRoster(
        h.dependencies,
        { ...principal, status: "suspended" },
        scope
      ),
      "FORBIDDEN"
    );
    await rejection(
      getResearchChatRoster(h.dependencies, principal, {
        ...scope,
        environment: "paper",
      }),
      "BAD_REQUEST"
    );
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== "account-scope"
    );
    await rejection(
      getResearchChatRoster(h.dependencies, principal, scope),
      "FORBIDDEN"
    );
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== "research-chat"
    );
    await rejection(
      getResearchChatRoster(h.dependencies, principal, scope),
      "FORBIDDEN"
    );
    return expect(h.store.listResearchChatThreads).not.toHaveBeenCalled();
  });

  it("does not promote read rights or roles to publish", async () => {
    const h = fixture();
    h.authorize.mockImplementation(
      async (request) => request.action === "read"
    );
    await rejection(
      createResearchChatThread(h.dependencies, principal, createInput),
      "FORBIDDEN"
    );
    await rejection(
      sendResearchChatMessage(h.dependencies, principal, sendInput),
      "FORBIDDEN"
    );
    expect(h.store.createResearchChatThread).not.toHaveBeenCalled();
    return expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
  });

  it("rejects unknown participants and client authority fields before writing", async () => {
    const h = fixture();
    await rejection(
      createResearchChatThread(h.dependencies, principal, {
        ...createInput,
        participantIds: ["unknown"],
      }),
      "BAD_REQUEST"
    );
    await rejection(
      sendResearchChatMessage(h.dependencies, principal, {
        ...sendInput,
        requestedParticipantIds: ["unknown"],
      }),
      "BAD_REQUEST"
    );
    await rejection(
      sendResearchChatMessage(h.dependencies, principal, {
        ...sendInput,
        requestedParticipantIds: ["first-mate"],
      }),
      "BAD_REQUEST"
    );
    await rejection(
      sendResearchChatMessage(h.dependencies, principal, {
        ...sendInput,
        citations: [],
        actorId: "forged",
      }),
      "BAD_REQUEST"
    );
    expect(h.store.createResearchChatThread).not.toHaveBeenCalled();
    return expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
  });

  it("rejects cross-owner/scope/thread reads and absent records", async () => {
    const h = fixture();
    for (const corrupt of [
      { ownerActorId: "other" },
      { accountAlias: "other" },
      { threadId: "other" },
      { participantIds: ["unknown"] },
    ]) {
      h.store.readResearchChatThread.mockResolvedValue({
        ...thread,
        ...corrupt,
      });
      await rejection(
        readResearchChatThread(h.dependencies, principal, {
          ...scope,
          threadId: thread.threadId,
        }),
        "INVALID_SOURCE"
      );
    }
    h.store.readResearchChatThread.mockResolvedValue(null);
    await rejection(
      readResearchChatThread(h.dependencies, principal, {
        ...scope,
        threadId: thread.threadId,
      }),
      "NOT_FOUND"
    );
    return expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
  });

  it("reads one exact owned thread with only its configured participants", async () => {
    const h = fixture();
    const result = await readResearchChatThread(h.dependencies, principal, {
      ...scope,
      threadId: thread.threadId,
    });
    expect(result.thread).toEqual(thread);
    expect(result.participants.map((entry) => entry.participantId)).toEqual(
      thread.participantIds
    );
    expect(result.executionAuthorized).toBe(false);
    return expect(h.resolvePolicy).not.toHaveBeenCalled();
  });

  it("passes bounded pages once, rejects duplicate/foreign/message actor results", async () => {
    const h = fixture();
    const page = { ...scope, limit: 1, cursor: null };
    expect(
      (await listResearchChatThreads(h.dependencies, principal, page)).items
    ).toEqual([thread]);
    expect(h.store.listResearchChatThreads).toHaveBeenCalledTimes(1);
    expect(h.store.listResearchChatThreads).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      { limit: 1, cursor: null }
    );
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [thread, thread],
      nextCursor: null,
    });
    await rejection(
      listResearchChatThreads(h.dependencies, principal, { ...page, limit: 2 }),
      "INVALID_SOURCE"
    );
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [{ ...thread, ownerActorId: "other" }],
      nextCursor: null,
    });
    await rejection(
      listResearchChatThreads(h.dependencies, principal, page),
      "INVALID_SOURCE"
    );
    expect(
      (
        await listResearchChatMessages(h.dependencies, principal, {
          ...page,
          threadId: thread.threadId,
        })
      ).items
    ).toEqual([message]);
    h.store.listResearchChatMessages.mockResolvedValue({
      items: [{ ...message, author: { kind: "user", actorId: "other" } }],
      nextCursor: null,
    });
    return await rejection(
      listResearchChatMessages(h.dependencies, principal, {
        ...page,
        threadId: thread.threadId,
      }),
      "INVALID_SOURCE"
    );
  });

  it("fails closed on unavailable ports, cancellation and private adapter errors", async () => {
    await rejection(
      getResearchChatRoster({}, principal, scope),
      "SERVICE_UNAVAILABLE"
    );
    const h = fixture();
    const abort = new AbortController();
    abort.abort();
    await rejection(
      getResearchChatRoster(
        { ...h.dependencies, signal: abort.signal },
        principal,
        scope
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.authorize).not.toHaveBeenCalled();
    h.store.listResearchChatThreads.mockRejectedValue(
      new Error("private provider details")
    );
    await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: null,
      }),
      "SERVICE_UNAVAILABLE"
    );
    h.store.listResearchChatThreads.mockRejectedValue({
      code: "denied",
      message: "private untyped adapter error",
    });
    await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: null,
      }),
      "SERVICE_UNAVAILABLE"
    );
    h.store.listResearchChatThreads.mockRejectedValue(
      new VertexStoreError("denied")
    );
    return await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: null,
      }),
      "FORBIDDEN"
    );
  });

  it("captures input and identity before the first authorization await", async () => {
    const h = fixture();
    let release: () => void = () => undefined;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          return (release = () => resolve(true));
        })
    );
    const input = { ...scope, threadId: thread.threadId };
    const actor = { ...principal };
    const pending = readResearchChatThread(h.dependencies, actor, input);
    input.accountAlias = "mutated";
    input.threadId = "mutated";
    actor.userId = "mutated";
    release();
    expect((await pending).thread).toEqual(thread);
    return expect(h.store.readResearchChatThread).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      thread.threadId
    );
  });

  it("checks cancellation after an in-flight store result", async () => {
    const h = fixture();
    const abort = new AbortController();
    h.store.readResearchChatThread.mockImplementation(async () => {
      abort.abort();
      return thread;
    });
    return await rejection(
      readResearchChatThread(
        { ...h.dependencies, signal: abort.signal },
        principal,
        { ...scope, threadId: thread.threadId }
      ),
      "SERVICE_UNAVAILABLE"
    );
  });

  it("strictly validates exact injected chat input and output names", async () => {
    const validator = vertexPersistenceBoundary.validateResearchChatInput!;
    expect(await validator("createThread", createInput)).toEqual(createInput);
    await expect(
      validator("createThread", { ...createInput, ownerActorId: "forged" })
    ).rejects.toThrow();
    expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatThread",
        thread,
        "1.0.0"
      )
    ).toEqual(thread);
    expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatMessage",
        message,
        "1.0.0"
      )
    ).toEqual(message);
    expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatSendMessageOutput",
        ack,
        "1.0.0"
      )
    ).toEqual(ack);
    expect(await validator("readTranscriptPage", transcriptInput)).toEqual(
      transcriptInput
    );
    await expect(
      validator("readTranscriptPage", {
        ...transcriptInput,
        snapshotRevision: "2",
      })
    ).rejects.toThrow();
    return expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatReadTranscriptPageOutput",
        transcript,
        "1.0.0"
      )
    ).toEqual(transcript);
  });

  it("creates exactly the selected room and preserves idempotent store responses", async () => {
    const h = fixture();
    const value = await createResult();
    h.store.createResearchChatThread.mockResolvedValue(value);
    expect(
      await createResearchChatThread(h.dependencies, principal, createInput)
    ).toEqual(value);
    expect(
      await createResearchChatThread(h.dependencies, principal, createInput)
    ).toEqual(value);
    expect(h.store.createResearchChatThread).toHaveBeenCalledTimes(2);
    expect(h.store.createResearchChatThread).toHaveBeenLastCalledWith({
      principal: { actorId: principal.userId },
      scope,
      title: createInput.title,
      participantIds: createInput.participantIds,
      idempotencyKey: createInput.idempotencyKey,
    });
    expect(h.resolvePolicy).not.toHaveBeenCalled();

    for (const invalid of [
      { threadId: "wrong" },
      { title: "wrong" },
      { participantIds: ["first-mate"] },
      { ownerActorId: "other" },
      { revision: "2" },
      { unexpected: true },
    ]) {
      h.store.createResearchChatThread.mockResolvedValue({
        ...value,
        ...invalid,
      });
      await rejection(
        createResearchChatThread(h.dependencies, principal, createInput),
        "INVALID_SOURCE"
      );
    }
  });

  it("persists human text with unavailable response, not a mock model answer", async () => {
    const h = fixture();
    const value = await sendResult();
    h.store.sendResearchChatMessage.mockResolvedValue(value);
    expect(
      await sendResearchChatMessage(h.dependencies, principal, sendInput)
    ).toEqual(value);
    expect(
      await sendResearchChatMessage(h.dependencies, principal, sendInput)
    ).toEqual(value);
    expect(h.store.sendResearchChatMessage).toHaveBeenCalledTimes(2);
    expect(h.store.sendResearchChatMessage).toHaveBeenLastCalledWith({
      principal: { actorId: principal.userId },
      scope,
      threadId: sendInput.threadId,
      expectedRevision: "1",
      idempotencyKey: sendInput.idempotencyKey,
      body: sendInput.body,
      requestedParticipantIds: ["jan-smolen"],
      mode: "discuss",
    });
    expect(h.resolvePolicy).not.toHaveBeenCalled();

    for (const mode of ["discuss", "debate"] as const) {
      const humanOnly = {
        ...value,
        response: {
          status: "not-requested",
          runId: null,
          jobId: null,
          reasonCodes: [],
        },
      };
      h.store.sendResearchChatMessage.mockResolvedValue(humanOnly);
      expect(
        await sendResearchChatMessage(h.dependencies, principal, {
          ...sendInput,
          mode,
          requestedParticipantIds: [],
        })
      ).toEqual(humanOnly);
    }
  });

  it("rejects wrong ack identity, scope-derived key, body, revision or fabricated readiness", async () => {
    const h = fixture();
    const value = await sendResult();
    const foreignId = `message-${await hash({ operation: "sendMessage", actorId: principal.userId, scope: { ...scope, accountAlias: "other" }, threadId: thread.threadId, idempotencyKey: sendInput.idempotencyKey })}`;
    const corrupt: readonly VertexRecord[] = [
      { ...value, threadRevision: "3" },
      {
        ...value,
        response: {
          status: "queued",
          runId: "fabricated",
          jobId: "fabricated",
          reasonCodes: [],
        },
      },
      {
        ...value,
        response: {
          status: "not-requested",
          runId: null,
          jobId: null,
          reasonCodes: [],
        },
      },
      {
        ...value,
        response: {
          status: "unavailable",
          runId: null,
          jobId: null,
          reasonCodes: [],
        },
      },
      ...[
        { messageId: foreignId },
        { body: "changed" },
        { sequence: "2" },
        { threadId: "other" },
        { author: { kind: "user", actorId: "other" } },
        { citations: [{ artifactId: "untrusted", sha256: "a".repeat(64) }] },
      ].map((patch) => ({ ...value, message: { ...value.message, ...patch } })),
    ];

    for (const invalid of corrupt) {
      h.store.sendResearchChatMessage.mockResolvedValue(invalid);
      await rejection(
        sendResearchChatMessage(h.dependencies, principal, sendInput),
        "INVALID_SOURCE"
      );
    }
  });

  it("snapshots mutable write arrays and body before authorization awaits", async () => {
    const h = fixture();
    h.store.sendResearchChatMessage.mockResolvedValue(await sendResult());
    let release: () => void = () => undefined;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          return (release = () => resolve(true));
        })
    );
    const input = {
      ...sendInput,
      requestedParticipantIds: [...sendInput.requestedParticipantIds],
    };
    const pending = sendResearchChatMessage(h.dependencies, principal, input);
    input.body = "mutated";
    input.requestedParticipantIds[0] = "first-mate";
    input.mode = "debate" as typeof input.mode;
    release();
    const output = await pending;
    expect(output.message.body).toBe(sendInput.body);
    return expect(h.store.sendResearchChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: sendInput.body,
        requestedParticipantIds: ["jan-smolen"],
        mode: "discuss",
      })
    );
  });

  it("binds cursor identity/limit/order and rejects repeated, empty or forged continuation", async () => {
    const h = fixture();
    const next = await cursor("listThreads", thread.threadId);
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [thread],
      nextCursor: next,
    });
    expect(
      (
        await listResearchChatThreads(h.dependencies, principal, {
          ...scope,
          limit: 1,
          cursor: null,
        })
      ).nextCursor
    ).toBe(next);
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [{ ...thread, threadId: "thread-b" }],
      nextCursor: null,
    });
    expect(
      (
        await listResearchChatThreads(h.dependencies, principal, {
          ...scope,
          limit: 1,
          cursor: next,
        })
      ).items[0]?.threadId
    ).toBe("thread-b");
    expect(h.store.listResearchChatThreads).toHaveBeenLastCalledWith(
      { actorId: principal.userId },
      scope,
      { limit: 1, cursor: next }
    );
    h.store.listResearchChatThreads.mockClear();
    for (const invalid of [
      "invalid",
      await cursor("listThreads", "thread-a", 1, "other"),
      await cursor("listThreads", "thread-a", 2),
      await cursor("listMessages", "1"),
    ]) {
      await rejection(
        listResearchChatThreads(h.dependencies, principal, {
          ...scope,
          limit: 1,
          cursor: invalid,
        }),
        "BAD_REQUEST"
      );
    }
    expect(h.store.listResearchChatThreads).not.toHaveBeenCalled();
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [thread],
      nextCursor: next,
    });
    await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: next,
      }),
      "INVALID_SOURCE"
    );
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [],
      nextCursor: next,
    });
    await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: null,
      }),
      "INVALID_SOURCE"
    );
    h.store.listResearchChatThreads.mockResolvedValue({
      items: [thread],
      nextCursor: await cursor("listThreads", "wrong"),
    });
    return await rejection(
      listResearchChatThreads(h.dependencies, principal, {
        ...scope,
        limit: 1,
        cursor: null,
      }),
      "INVALID_SOURCE"
    );
  });

  it("binds message pagination to exact thread and exact ordinal, not Number coercion", async () => {
    const h = fixture();
    const start = "9007199254740992";
    const next = await cursor(
      "listMessages",
      start,
      1,
      principal.userId,
      thread.threadId
    );
    const value = { ...message, sequence: "9007199254740993" };
    h.store.listResearchChatMessages.mockResolvedValue({
      items: [value],
      nextCursor: null,
    });
    expect(
      (
        await listResearchChatMessages(h.dependencies, principal, {
          ...scope,
          threadId: thread.threadId,
          limit: 1,
          cursor: next,
        })
      ).items
    ).toEqual([value]);
    expect(h.store.listResearchChatMessages).toHaveBeenCalledTimes(1);
    const foreign = await cursor(
      "listMessages",
      start,
      1,
      principal.userId,
      "other"
    );
    await rejection(
      listResearchChatMessages(h.dependencies, principal, {
        ...scope,
        threadId: thread.threadId,
        limit: 1,
        cursor: foreign,
      }),
      "BAD_REQUEST"
    );
    h.store.listResearchChatMessages.mockResolvedValue({
      items: [value, value],
      nextCursor: null,
    });
    return await rejection(
      listResearchChatMessages(h.dependencies, principal, {
        ...scope,
        threadId: thread.threadId,
        limit: 2,
        cursor: null,
      }),
      "INVALID_SOURCE"
    );
  });

  it("fails closed on malformed records, getters and immutable output", async () => {
    const h = fixture();
    h.store.readResearchChatThread.mockResolvedValue({
      ...thread,
      unexpected: true,
    });
    await rejection(
      readResearchChatThread(h.dependencies, principal, {
        ...scope,
        threadId: thread.threadId,
      }),
      "INVALID_SOURCE"
    );
    const read = vi.fn(() => scope.accountAlias);
    const raw = { ...scope };
    Object.defineProperty(raw, "accountAlias", { enumerable: true, get: read });
    await rejection(
      getResearchChatRoster(h.dependencies, principal, raw),
      "BAD_REQUEST"
    );
    expect(read).not.toHaveBeenCalled();
    const roster = await getResearchChatRoster(
      h.dependencies,
      principal,
      scope
    );
    expect(Object.isFrozen(roster)).toBe(true);
    expect(Object.isFrozen(roster.participants)).toBe(true);
    return expect(Object.isFrozen(roster.participants[0]?.corpus)).toBe(true);
  });

  it("reads one authorized atomic transcript page without a torn compatibility fallback", async () => {
    const h = fixture();
    expect(
      await readResearchChatTranscriptPage(
        h.dependencies,
        principal,
        transcriptInput
      )
    ).toEqual(transcript);
    expect(
      h.store.readResearchChatTranscriptPage
    ).toHaveBeenCalledExactlyOnceWith(
      { actorId: principal.userId },
      scope,
      thread.threadId,
      { limit: 1, cursor: null }
    );
    expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
    expect(h.store.listResearchChatMessages).not.toHaveBeenCalled();
    expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
    expect(h.resolvePolicy).not.toHaveBeenCalled();
    return expect(
      h.authorize.mock.calls.map(([request]) => [
        request.resourceId,
        request.action,
      ])
    ).toEqual([
      ["account-scope", "read"],
      ["research-chat", "read"],
    ]);
  });

  it("keeps a final snapshot page valid after an interleaved append advances the current head", async () => {
    const h = fixture();
    const next = await transcriptCursor("1", "3", "2");
    h.store.readResearchChatTranscriptPage.mockResolvedValue({
      ...transcript,
      thread: { ...thread, revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      nextCursor: next,
    });
    expect(
      (
        await readResearchChatTranscriptPage(
          h.dependencies,
          principal,
          transcriptInput
        )
      ).nextCursor
    ).toBe(next);
    const final = {
      ...transcript,
      thread: { ...thread, revision: "4" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [{ ...message, messageId: "message-b", sequence: "2" }],
    };
    h.store.readResearchChatTranscriptPage.mockResolvedValue(final);
    expect(
      await readResearchChatTranscriptPage(h.dependencies, principal, {
        ...transcriptInput,
        cursor: next,
      })
    ).toEqual(final);
    expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== "research-chat"
    );
    await rejection(
      readResearchChatTranscriptPage(h.dependencies, principal, {
        ...transcriptInput,
        cursor: next,
      }),
      "FORBIDDEN"
    );
    return expect(h.store.readResearchChatTranscriptPage).toHaveBeenCalledTimes(
      2
    );
  });

  it("correlates transcript continuation above Number precision and rejects a noncanonical cursor ordinal", async () => {
    const h = fixture();
    const next = await transcriptCursor(
      "9007199254740992",
      "9007199254740994",
      "9007199254740993"
    );
    const final = {
      ...transcript,
      thread: { ...thread, revision: "9007199254740995" },
      snapshotRevision: "9007199254740994",
      highWaterSequence: "9007199254740993",
      items: [{ ...message, sequence: "9007199254740993" }],
    };
    h.store.readResearchChatTranscriptPage.mockResolvedValue(final);
    expect(
      await readResearchChatTranscriptPage(h.dependencies, principal, {
        ...transcriptInput,
        cursor: next,
      })
    ).toEqual(final);
    const noncanonical = await transcriptCursor("1\n", "3", "2");
    await rejection(
      readResearchChatTranscriptPage(h.dependencies, principal, {
        ...transcriptInput,
        cursor: noncanonical,
      }),
      "BAD_REQUEST"
    );
    return expect(h.store.readResearchChatTranscriptPage).toHaveBeenCalledTimes(
      1
    );
  });

  it("correlates transcript cursor identity, limit, boundary and exact page progression", async () => {
    const h = fixture();
    for (const continuation of [
      "invalid",
      await cursor("listMessages", "1", 1, principal.userId, thread.threadId),
      await transcriptCursor("1", "3", "2", { actorId: "other" }),
      await transcriptCursor("1", "3", "2", { limit: 2 }),
      await transcriptCursor("1", "3", "2", { threadId: "other" }),
      await transcriptCursor("1", "3", "2", {
        scope: { ...scope, accountAlias: "other" },
      }),
    ]) {
      await rejection(
        readResearchChatTranscriptPage(h.dependencies, principal, {
          ...transcriptInput,
          cursor: continuation,
        }),
        "BAD_REQUEST"
      );
    }
    expect(h.store.readResearchChatTranscriptPage).not.toHaveBeenCalled();
    const next = await transcriptCursor("1", "3", "2");
    for (const corrupt of [
      transcript,
      {
        ...transcript,
        thread: { ...thread, revision: "4" },
        snapshotRevision: "4",
        highWaterSequence: "3",
        items: [{ ...message, sequence: "3" }],
      },
      {
        ...transcript,
        thread: { ...thread, revision: "3" },
        snapshotRevision: "3",
        highWaterSequence: "2",
        items: [message],
        nextCursor: next,
      },
    ]) {
      h.store.readResearchChatTranscriptPage.mockResolvedValue(corrupt);
      await rejection(
        readResearchChatTranscriptPage(h.dependencies, principal, {
          ...transcriptInput,
          cursor: next,
        }),
        "INVALID_SOURCE"
      );
    }
    h.store.readResearchChatTranscriptPage.mockResolvedValue({
      ...transcript,
      thread: { ...thread, revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [message, { ...message, messageId: "message-b", sequence: "2" }],
    });
    return await rejection(
      readResearchChatTranscriptPage(
        h.dependencies,
        principal,
        transcriptInput
      ),
      "INVALID_SOURCE"
    );
  });

  it("rejects a cursor-null transcript suffix even when its final tail and current head are consistent", async () => {
    const h = fixture();
    h.store.readResearchChatTranscriptPage.mockResolvedValue({
      ...transcript,
      thread: { ...thread, revision: "3" },
      snapshotRevision: "3",
      highWaterSequence: "2",
      items: [{ ...message, sequence: "2" }],
    });
    return await rejection(
      readResearchChatTranscriptPage(
        h.dependencies,
        principal,
        transcriptInput
      ),
      "INVALID_SOURCE"
    );
  });

  it("rechecks read rights and rejects foreign, nonhuman, malformed or absent transcript records", async () => {
    const h = fixture();
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== "research-chat"
    );
    await rejection(
      readResearchChatTranscriptPage(
        h.dependencies,
        principal,
        transcriptInput
      ),
      "FORBIDDEN"
    );
    expect(h.store.readResearchChatTranscriptPage).not.toHaveBeenCalled();
    h.authorize.mockResolvedValue(true);
    for (const change of [
      { ownerActorId: "other" },
      { accountAlias: "other" },
      { threadId: "other" },
      { participantIds: ["unknown"] },
      { revision: "3" },
    ]) {
      h.store.readResearchChatTranscriptPage.mockResolvedValue({
        ...transcript,
        thread: { ...transcript.thread, ...change },
      });
      await rejection(
        readResearchChatTranscriptPage(
          h.dependencies,
          principal,
          transcriptInput
        ),
        "INVALID_SOURCE"
      );
    }
    for (const change of [
      { author: { kind: "user", actorId: "other" } },
      {
        author: { kind: "agent", participantId: "jan-smolen", runId: "run-a" },
      },
      { sequence: "2" },
      { kind: "synthesis" },
    ]) {
      h.store.readResearchChatTranscriptPage.mockResolvedValue({
        ...transcript,
        items: [{ ...message, ...change }],
      });
      await rejection(
        readResearchChatTranscriptPage(
          h.dependencies,
          principal,
          transcriptInput
        ),
        "INVALID_SOURCE"
      );
    }
    h.store.readResearchChatTranscriptPage.mockResolvedValue(null);
    return await rejection(
      readResearchChatTranscriptPage(
        h.dependencies,
        principal,
        transcriptInput
      ),
      "NOT_FOUND"
    );
  });

  it("captures transcript inputs before authorization and discards cancelled store responses", async () => {
    const h = fixture();
    let release: () => void = () => undefined;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          return (release = () => resolve(true));
        })
    );
    const input = { ...transcriptInput };
    const pending = readResearchChatTranscriptPage(
      h.dependencies,
      principal,
      input
    );
    input.threadId = "mutated";
    input.limit = 100;
    release();
    expect(await pending).toEqual(transcript);
    expect(h.store.readResearchChatTranscriptPage).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      thread.threadId,
      { limit: 1, cursor: null }
    );
    const abort = new AbortController();
    h.store.readResearchChatTranscriptPage.mockImplementation(async () => {
      abort.abort();
      return transcript;
    });
    return await rejection(
      readResearchChatTranscriptPage(
        { ...h.dependencies, signal: abort.signal },
        principal,
        transcriptInput
      ),
      "SERVICE_UNAVAILABLE"
    );
  });

  it("accepts the original immutable send receipt after the current head advances", async () => {
    const h = fixture();
    const original = await sendResult();
    h.store.readResearchChatThread.mockResolvedValue({
      ...thread,
      revision: "8",
    });
    h.store.sendResearchChatMessage.mockResolvedValue(original);
    expect(
      await sendResearchChatMessage(h.dependencies, principal, sendInput)
    ).toEqual(original);
    return expect(h.store.sendResearchChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: "1",
        idempotencyKey: sendInput.idempotencyKey,
      })
    );
  });
});

describe("durable unavailable response reconciliation service", () => {
  it("forwards exact authenticated selectors and literal query without execution or pre-reading", async () => {
    const h = fixture();
    const original = await responseResult();
    expect(
      await requestResearchChatResponse(
        h.dependencies,
        principal,
        responseInput
      )
    ).toEqual(original);
    expect(h.store.requestResearchChatResponse).toHaveBeenCalledExactlyOnceWith(
      {
        principal: { actorId: principal.userId },
        scope,
        threadId: responseInput.threadId,
        parentMessageId: responseInput.parentMessageId,
        participantId: responseInput.participantId,
        snapshotRevision: responseInput.snapshotRevision,
        contextStartSequence: responseInput.contextStartSequence,
        retrievalQuery: responseInput.retrievalQuery,
        idempotencyKey: responseInput.idempotencyKey,
      }
    );
    expect(
      h.authorize.mock.calls.map(([request]) => [
        request.resourceId,
        request.action,
      ])
    ).toEqual([
      ["account-scope", "read"],
      ["research-chat", "read"],
      ["research-chat", "publish"],
    ]);
    expect(h.resolvePolicy).not.toHaveBeenCalled();
    expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
    expect(h.store.listResearchChatMessages).not.toHaveBeenCalled();
    expect(h.store.readResearchChatTranscriptPage).not.toHaveBeenCalled();
    expect(h.store.createResearchChatThread).not.toHaveBeenCalled();
    expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
    return expect(JSON.stringify(original)).not.toContain(
      responseInput.retrievalQuery
    );
  });

  it("reconciles an original receipt after head/catalog changes and permits a selected First Mate", async () => {
    const h = fixture();
    h.store.readResearchChatThread.mockRejectedValue(
      new Error("Current roster/head must not gate original receipts")
    );
    for (const participantId of ["retired-expert", "first-mate"]) {
      const input = { ...responseInput, participantId };
      const original = await responseResult(input);
      h.store.requestResearchChatResponse.mockResolvedValue(original);
      expect(
        await requestResearchChatResponse(h.dependencies, principal, input)
      ).toEqual(original);
      expect(
        await requestResearchChatResponse(h.dependencies, principal, input)
      ).toEqual(original);
      expect(h.store.requestResearchChatResponse).toHaveBeenLastCalledWith(
        expect.objectContaining({
          participantId,
          snapshotRevision: "2",
          idempotencyKey: responseInput.idempotencyKey,
        })
      );
    }
    expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
    return expect(h.resolvePolicy).not.toHaveBeenCalled();
  });

  it("rechecks account/read/publish access and active identity before every request", async () => {
    const h = fixture();
    await rejection(
      requestResearchChatResponse(
        h.dependencies,
        { ...principal, status: "suspended" },
        responseInput
      ),
      "FORBIDDEN"
    );
    expect(h.authorize).not.toHaveBeenCalled();
    for (const [resourceId, action] of [
      ["account-scope", "read"],
      ["research-chat", "read"],
      ["research-chat", "publish"],
    ]) {
      h.authorize.mockImplementation(
        async (request) =>
          !(request.resourceId === resourceId && request.action === action)
      );
      await rejection(
        requestResearchChatResponse(h.dependencies, principal, responseInput),
        "FORBIDDEN"
      );
    }
    expect(h.store.requestResearchChatResponse).not.toHaveBeenCalled();
    h.authorize.mockResolvedValue(true);
    await requestResearchChatResponse(h.dependencies, principal, responseInput);
    h.authorize.mockResolvedValue(false);
    await rejection(
      requestResearchChatResponse(h.dependencies, principal, responseInput),
      "FORBIDDEN"
    );
    return expect(h.store.requestResearchChatResponse).toHaveBeenCalledTimes(1);
  });

  it("validates canonical exact inputs before authorization without invoking getters", async () => {
    const h = fixture();
    for (const change of [
      { environment: "paper" },
      { principal: { actorId: "forged" } },
      { participantIds: ["jan-smolen"] },
      { retrievalQuery: "short" },
      { retrievalQuery: "ten chars\nextra" },
      { snapshotRevision: "18" },
      { contextStartSequence: "2" },
      { idempotencyKey: "response-a\n" },
      { snapshotRevision: 2 },
    ]) {
      await rejection(
        requestResearchChatResponse(h.dependencies, principal, {
          ...responseInput,
          ...change,
        }),
        "BAD_REQUEST"
      );
    }
    const getter = vi.fn(() => responseInput.retrievalQuery);
    const accessor = { ...responseInput };
    Object.defineProperty(accessor, "retrievalQuery", {
      enumerable: true,
      get: getter,
    });
    await rejection(
      requestResearchChatResponse(h.dependencies, principal, accessor),
      "BAD_REQUEST"
    );
    expect(getter).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    return expect(h.store.requestResearchChatResponse).not.toHaveBeenCalled();
  });

  it("captures original query/key/scope/identity before the first authorization await", async () => {
    const h = fixture();
    let release: () => void = () => undefined;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          return (release = () => resolve(true));
        })
    );
    const input = { ...responseInput };
    const actor = { ...principal };
    const pending = requestResearchChatResponse(h.dependencies, actor, input);
    input.accountAlias = "mutated";
    input.threadId = "mutated";
    input.retrievalQuery = "mutated query";
    input.idempotencyKey = "mutated";
    actor.userId = "mutated";
    release();
    expect(await pending).toEqual(await responseResult());
    return expect(h.store.requestResearchChatResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { actorId: principal.userId },
        scope,
        threadId: responseInput.threadId,
        retrievalQuery: responseInput.retrievalQuery,
        idempotencyKey: responseInput.idempotencyKey,
      })
    );
  });

  it("leaves changed-key payload conflict and new prefix/member decisions to the store", async () => {
    const h = fixture();
    h.store.requestResearchChatResponse.mockRejectedValue(
      new VertexStoreError("conflict")
    );
    const changed = {
      ...responseInput,
      retrievalQuery: `${responseInput.retrievalQuery}changed`,
    };
    await rejection(
      requestResearchChatResponse(h.dependencies, principal, changed),
      "CONFLICT"
    );
    expect(h.store.requestResearchChatResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalQuery: changed.retrievalQuery,
        idempotencyKey: responseInput.idempotencyKey,
      })
    );
    for (const [storeCode, code] of [
      ["invalid", "BAD_REQUEST"],
      ["integrity", "INVALID_SOURCE"],
      ["denied", "FORBIDDEN"],
    ] as const) {
      h.store.requestResearchChatResponse.mockRejectedValue(
        new VertexStoreError(storeCode)
      );
      await rejection(
        requestResearchChatResponse(h.dependencies, principal, responseInput),
        code
      );
    }
    return expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
  });

  it("binds every request output selector and canonical raw digest without Number coercion", async () => {
    const h = fixture();
    const large = {
      ...responseInput,
      snapshotRevision: "9007199254740994",
      contextStartSequence: "9007199254740993",
    };
    h.store.requestResearchChatResponse.mockResolvedValue(
      await responseResult(large)
    );
    expect(
      await requestResearchChatResponse(h.dependencies, principal, large)
    ).toEqual(await responseResult(large));
    const original = await responseResult();
    const foreignId = `response-${await hash({ operation: "requestResponse", actorId: principal.userId, scope, threadId: "other", idempotencyKey: responseInput.idempotencyKey })}`;
    for (const patch of [
      { ownerActorId: "other" },
      { accountAlias: "other" },
      { environment: "paper" },
      { threadId: "other" },
      { responseRequestId: foreignId },
      { idempotencyKey: "other" },
      { parentMessageId: "other" },
      { participantId: "first-mate" },
      { snapshotRevision: "3" },
      { contextStartSequence: "2", snapshotRevision: "3" },
      { requestSha256: "a".repeat(64) },
      { reasonCodes: ["policy-revoked"] },
      { reasonCodes: ["research-runtime-unavailable", "corpus-unavailable"] },
      { status: "queued" },
      { jobId: "fake-job" },
      { executionAuthorized: true },
      { retrievalQuery: responseInput.retrievalQuery },
    ]) {
      h.store.requestResearchChatResponse.mockResolvedValue({
        ...original,
        ...patch,
      });
      await rejection(
        requestResearchChatResponse(h.dependencies, principal, responseInput),
        "INVALID_SOURCE"
      );
    }
    h.store.requestResearchChatResponse.mockResolvedValue({
      ...original,
      status: "admitted",
      reasonCodes: [],
      admission: {
        bindingSha256: "a".repeat(64),
        contextSha256: "b".repeat(64),
        participantConfigSha256: "c".repeat(64),
        collectionId: "collection-a",
        proposal: { artifactId: "proposal-a", sha256: "d".repeat(64) },
        runId: "run-a",
        eventId: "event-a",
      },
    });
    return await rejection(
      requestResearchChatResponse(h.dependencies, principal, responseInput),
      "INVALID_SOURCE"
    );
  });

  it("reads only the exact original key with current read permission and no publish/policy/context gate", async () => {
    const h = fixture();
    h.authorize.mockImplementation(
      async (request) => request.action === "read"
    );
    const original = await responseResult({
      ...responseInput,
      participantId: "retired-expert",
    });
    const observation = {
      ...base,
      checkedAt: now,
      receipt: original,
      job: null,
      delivery: { status: "not-applicable" },
    };
    h.store.readResearchChatResponse.mockResolvedValue(observation);
    const output = await readResearchChatResponse(
      h.dependencies,
      principal,
      readResponseInput
    );
    expect(output).toEqual(observation);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.receipt.reasonCodes)).toBe(true);
    expect(h.store.readResearchChatResponse).toHaveBeenCalledExactlyOnceWith(
      { actorId: principal.userId },
      scope,
      thread.threadId,
      responseInput.idempotencyKey
    );
    expect(
      h.authorize.mock.calls.map(([request]) => [
        request.resourceId,
        request.action,
      ])
    ).toEqual([
      ["account-scope", "read"],
      ["research-chat", "read"],
    ]);
    expect(h.resolvePolicy).not.toHaveBeenCalled();
    expect(h.store.readResearchChatThread).not.toHaveBeenCalled();
    expect(h.store.listResearchChatMessages).not.toHaveBeenCalled();
    expect(h.store.readResearchChatTranscriptPage).not.toHaveBeenCalled();
    expect(h.store.requestResearchChatResponse).not.toHaveBeenCalled();
    return expect(h.store.sendResearchChatMessage).not.toHaveBeenCalled();
  });

  it("maps absence at read time to NOT_FOUND without resending or inventing a fresh key", async () => {
    const h = fixture();
    h.store.readResearchChatResponse.mockResolvedValue(null);
    await rejection(
      readResearchChatResponse(h.dependencies, principal, readResponseInput),
      "NOT_FOUND"
    );
    expect(h.store.readResearchChatResponse).toHaveBeenCalledExactlyOnceWith(
      { actorId: principal.userId },
      scope,
      thread.threadId,
      responseInput.idempotencyKey
    );
    expect(h.store.requestResearchChatResponse).not.toHaveBeenCalled();
    return expect(h.resolvePolicy).not.toHaveBeenCalled();
  });

  it("rejects injected read fields and checks current account/read access before lookup", async () => {
    const h = fixture();
    for (const change of [
      { retrievalQuery: responseInput.retrievalQuery },
      { responseRequestId: "derived-key" },
      { retry: true },
      { ownerActorId: principal.userId },
      { environment: "paper" },
    ]) {
      await rejection(
        readResearchChatResponse(h.dependencies, principal, {
          ...readResponseInput,
          ...change,
        }),
        "BAD_REQUEST"
      );
    }
    expect(h.authorize).not.toHaveBeenCalled();
    await rejection(
      readResearchChatResponse(
        h.dependencies,
        { ...principal, status: "suspended" },
        readResponseInput
      ),
      "FORBIDDEN"
    );
    for (const resourceId of ["account-scope", "research-chat"]) {
      h.authorize.mockImplementation(
        async (request) => request.resourceId !== resourceId
      );
      await rejection(
        readResearchChatResponse(h.dependencies, principal, readResponseInput),
        "FORBIDDEN"
      );
    }
    return expect(h.store.readResearchChatResponse).not.toHaveBeenCalled();
  });

  it("rejects foreign read receipt identity, malformed observations and regressed clock", async () => {
    const h = fixture();
    const original = await responseResult();
    const observation = {
      ...base,
      checkedAt: now,
      receipt: original,
      job: null,
      delivery: { status: "not-applicable" },
    };
    for (const patch of [
      { ownerActorId: "other" },
      { accountAlias: "other" },
      { threadId: "other" },
      { idempotencyKey: "other" },
      { responseRequestId: "other" },
      { requestSha256: "invalid" },
      { reasonCodes: ["policy-revoked"] },
      { extra: "private" },
    ]) {
      h.store.readResearchChatResponse.mockResolvedValue({
        ...observation,
        receipt: { ...original, ...patch },
      });
      await rejection(
        readResearchChatResponse(h.dependencies, principal, readResponseInput),
        "INVALID_SOURCE"
      );
    }

    for (const patch of [
      { checkedAt: "2026-09-22T12:00:00Z" },
      { job: { jobId: "fake-job", state: "queued" } },
      { delivery: { status: "pending" } },
      { executionAuthorized: true },
      { text: "private output" },
    ]) {
      h.store.readResearchChatResponse.mockResolvedValue({
        ...observation,
        ...patch,
      });
      await rejection(
        readResearchChatResponse(h.dependencies, principal, readResponseInput),
        "INVALID_SOURCE"
      );
    }
  });

  it("captures read identity/key before await and rechecks cancellation for both operations", async () => {
    const h = fixture();
    let release: () => void = () => undefined;
    h.authorize.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          return (release = () => resolve(true));
        })
    );
    const input = { ...readResponseInput };
    const actor = { ...principal };
    const pending = readResearchChatResponse(h.dependencies, actor, input);
    input.accountAlias = "mutated";
    input.threadId = "mutated";
    input.idempotencyKey = "mutated";
    actor.userId = "mutated";
    release();
    await pending;
    expect(h.store.readResearchChatResponse).toHaveBeenCalledWith(
      { actorId: principal.userId },
      scope,
      thread.threadId,
      responseInput.idempotencyKey
    );
    const aborted = new AbortController();
    aborted.abort();
    await rejection(
      requestResearchChatResponse(
        { ...h.dependencies, signal: aborted.signal },
        principal,
        responseInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.store.requestResearchChatResponse).not.toHaveBeenCalled();
    const requestAbort = new AbortController();
    h.store.requestResearchChatResponse.mockImplementation(async () => {
      requestAbort.abort();
      return responseResult();
    });
    await rejection(
      requestResearchChatResponse(
        { ...h.dependencies, signal: requestAbort.signal },
        principal,
        responseInput
      ),
      "SERVICE_UNAVAILABLE"
    );
    const readAbort = new AbortController();
    h.store.readResearchChatResponse.mockImplementation(async () => {
      readAbort.abort();
      return null;
    });
    return await rejection(
      readResearchChatResponse(
        { ...h.dependencies, signal: readAbort.signal },
        principal,
        readResponseInput
      ),
      "SERVICE_UNAVAILABLE"
    );
  });

  it("maps untyped private failures to unavailable and does not acknowledge missing ports", async () => {
    await rejection(
      requestResearchChatResponse({}, principal, responseInput),
      "SERVICE_UNAVAILABLE"
    );
    await rejection(
      readResearchChatResponse({}, principal, readResponseInput),
      "SERVICE_UNAVAILABLE"
    );
    const h = fixture();
    h.store.requestResearchChatResponse.mockRejectedValue(
      new Error("private model/provider details")
    );
    await rejection(
      requestResearchChatResponse(h.dependencies, principal, responseInput),
      "SERVICE_UNAVAILABLE"
    );
    h.store.readResearchChatResponse.mockRejectedValue({
      code: "denied",
      message: "private store details",
    });
    return await rejection(
      readResearchChatResponse(h.dependencies, principal, readResponseInput),
      "SERVICE_UNAVAILABLE"
    );
  });

  it("registers exact authoritative response validators without weakening canonical/refinement/freeze rules", async () => {
    const validate = vertexPersistenceBoundary.validateResearchChatInput!;
    expect(await validate("requestResponse", responseInput)).toEqual(
      responseInput
    );
    expect(await validate("readResponse", readResponseInput)).toEqual(
      readResponseInput
    );
    await expect(
      validate("requestResponse", { ...responseInput, retrievalQuery: "short" })
    ).rejects.toThrow();
    await expect(
      validate("readResponse", {
        ...readResponseInput,
        retrievalQuery: responseInput.retrievalQuery,
      })
    ).rejects.toThrow();
    const original = await responseResult();
    const observation = {
      ...base,
      checkedAt: now,
      receipt: original,
      job: null,
      delivery: { status: "not-applicable" },
    };
    const value = await vertexPersistenceBoundary.validate(
      "ResearchChatResponseReceipt",
      original,
      "1.0.0"
    );
    expect(value).toEqual(original);
    expect(Object.isFrozen(value)).toBe(true);
    expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatReadResponseOutput",
        observation,
        "1.0.0"
      )
    ).toEqual(observation);
    await expect(
      vertexPersistenceBoundary.validate(
        "ResearchChatResponseReceipt",
        { ...original, jobId: "fake" },
        "1.0.0"
      )
    ).rejects.toThrow();
    await expect(
      vertexPersistenceBoundary.validate(
        "ResearchChatReadResponseOutput",
        { ...observation, checkedAt: "2026-09-22T12:00:00Z" },
        "1.0.0"
      )
    ).rejects.toThrow();
    return await expect(
      vertexPersistenceBoundary.validate(
        "ResearchChatResponseReceipt",
        original,
        "2.0.0" as unknown as "1.0.0"
      )
    ).rejects.toThrow();
  });
});
