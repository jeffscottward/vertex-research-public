import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type {
  VertexAuthorization,
  VertexBoundaryContractName,
  VertexRecord,
  VertexResearchChatInputName,
  VertexScope,
} from "./vertex-ports.ts";
import { createVertexStore } from "./vertex-repository.ts";

// Scripted transaction/validator fixtures, not a PostgreSQL concurrency proof.
// The API owns exact wire-schema tests; these fixtures reject unregistered input
// and output bytes so persistence cannot silently bypass either injected seam.
const NOW = "2026-09-23T12:00:00.000000001Z";
const principal = { actorId: "human-1" };
const scope: VertexScope = {
  accountAlias: "research-room",
  environment: "research",
};
const hash = (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));
type Step = Readonly<{
  match: RegExp;
  rows?: Record<string, unknown>[];
  error?: string;
  onRead?: () => void;
}>;
const harness = (steps: Step[] = [], inputValidation = true) => {
  const pending = [...steps];
  const calls: { sql: string; params: unknown[] }[] = [];
  const lifecycle: string[] = [];
  const fixtures = new Map<string, Set<string>>();
  const accept = (
    name: VertexBoundaryContractName | VertexResearchChatInputName,
    value: unknown
  ): void => {
    if (!fixtures.has(name)) fixtures.set(name, new Set());
    fixtures.get(name)!.add(canonicalArtifactJson(value));
  };
  const validate = vi.fn(async (name: string, value: unknown) => {
    if (!fixtures.get(name)?.has(canonicalArtifactJson(value)))
      throw new Error("Unregistered fixture");
    return structuredClone(value) as VertexRecord;
  });
  const authorize = vi.fn(
    async (_request: Parameters<VertexAuthorization["authorize"]>[0]) => true
  );
  const commandPolicy = vi.fn(async () => {
    throw new Error("Human chat must not resolve research policy");
  });
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const compiled = dialect.sqlToQuery(fragment);
    calls.push({ sql: compiled.sql, params: compiled.params });
    if (compiled.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (pending[0]?.match.test(compiled.sql)) {
      const step = pending.shift()!;
      if (step.error) throw new Error(step.error);
      step.onRead?.();
      return { rows: step.rows ?? [] };
    }
    if (/^select\b|returning\b/i.test(compiled.sql))
      throw new Error("Unexpected scripted query");
    return { rows: [] };
  });
  const transaction = vi.fn(
    async (operation: (tx: unknown) => Promise<unknown>) => {
      lifecycle.push("begin");
      try {
        const result = await operation({ execute });
        lifecycle.push("commit");
        return result;
      } catch (error) {
        lifecycle.push("rollback");
        throw error;
      }
    }
  );
  const now = vi.fn(() => NOW);
  const store = createVertexStore(
    { execute, transaction } as unknown as Database,
    {
      boundary: {
        encode: (value) =>
          new TextEncoder().encode(canonicalArtifactJson(value)),
        digest: hashArtifact,
        validate,
        ...(inputValidation ? { validateResearchChatInput: validate } : {}),
      },
      clock: { now },
      authorization: { authorize },
      maxProjectionAgeMs: 60_000,
      commandPolicy,
    }
  );
  return {
    store,
    calls,
    lifecycle,
    pending,
    accept,
    authorize,
    validate,
    commandPolicy,
    now,
  };
};
const createInput = {
  principal,
  scope,
  title: "Synthetic research discussion",
  participantIds: ["expert-1"],
  idempotencyKey: "create-1",
};
const createCommand = {
  ...scope,
  title: createInput.title,
  participantIds: createInput.participantIds,
  idempotencyKey: createInput.idempotencyKey,
};
const createFixture = async (
  revision = "1",
  idempotencyKey = createInput.idempotencyKey,
  participantIds: readonly string[] = createInput.participantIds
) => {
  const command = { ...createCommand, idempotencyKey, participantIds };
  const request = {
    operation: "createThread",
    actorId: principal.actorId,
    input: command,
  };
  const threadId = `chat-${await hash({ operation: "createThread", actorId: principal.actorId, scope, idempotencyKey })}`;
  const result = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    ...scope,
    threadId,
    ownerActorId: principal.actorId,
    title: command.title,
    participantIds: command.participantIds,
    createdAt: NOW,
    updatedAt: NOW,
    revision: "1",
  };
  const current = { ...result, revision };
  const row = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    owner_actor_id: principal.actorId,
    thread_id: threadId,
    revision,
    last_sequence: (BigInt(revision) - 1n).toString(),
    created_at: NOW,
    updated_at: NOW,
    payload: current,
    record_hash: await hash(current),
    idempotency_key: idempotencyKey,
    request,
    request_hash: await hash(request),
    response: result,
    response_hash: await hash(result),
  };
  return { threadId, command, result, current, row };
};
const sendFixture = async (
  revision = "1",
  requestedParticipantIds: readonly string[] = [],
  idempotencyKey = "send-1",
  participantIds: readonly string[] = createInput.participantIds
) => {
  const thread = await createFixture(
    revision,
    createInput.idempotencyKey,
    participantIds
  );
  const command = {
    ...scope,
    threadId: thread.threadId,
    expectedRevision: revision,
    idempotencyKey,
    body: "A synthetic human hypothesis, not an execution instruction.",
    requestedParticipantIds,
    mode: "discuss" as const,
  };
  const input = {
    principal,
    scope,
    threadId: command.threadId,
    expectedRevision: revision,
    idempotencyKey: command.idempotencyKey,
    body: command.body,
    requestedParticipantIds,
    mode: command.mode,
  };
  const request = {
    operation: "sendMessage",
    actorId: principal.actorId,
    input: command,
  };
  const messageId = `message-${await hash({ operation: "sendMessage", actorId: principal.actorId, scope, threadId: thread.threadId, idempotencyKey: command.idempotencyKey })}`;
  const message = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    threadId: thread.threadId,
    messageId,
    sequence: revision,
    author: { kind: "user", actorId: principal.actorId },
    kind: "statement",
    body: command.body,
    citations: [],
    recordedAt: NOW,
  };
  const next = {
    ...thread.current,
    revision: (BigInt(revision) + 1n).toString(),
  };
  const response = {
    status:
      requestedParticipantIds.length === 0 ? "not-requested" : "unavailable",
    runId: null,
    jobId: null,
    reasonCodes:
      requestedParticipantIds.length === 0
        ? []
        : ["research-chat-agent-admission-unavailable"],
  };
  const result = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    message,
    threadRevision: next.revision,
    response,
  };
  const row = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    owner_actor_id: principal.actorId,
    thread_id: thread.threadId,
    message_id: messageId,
    sequence: revision,
    recorded_at: NOW,
    idempotency_key: command.idempotencyKey,
    request,
    request_hash: await hash(request),
    payload: message,
    record_hash: await hash(message),
    response: result,
    response_hash: await hash(result),
  };
  return { thread, command, input, message, next, result, row };
};
const acceptCreate = (
  h: ReturnType<typeof harness>,
  f: Awaited<ReturnType<typeof createFixture>>
): void => {
  h.accept("createThread", f.command);
  h.accept("ResearchChatThread", f.result);
  h.accept("ResearchChatThread", f.current);
};
const acceptSend = (
  h: ReturnType<typeof harness>,
  f: Awaited<ReturnType<typeof sendFixture>>
): void => {
  acceptCreate(h, f.thread);
  h.accept("sendMessage", f.command);
  h.accept("ResearchChatThread", f.next);
  h.accept("ResearchChatMessage", f.message);
  h.accept("ResearchChatSendMessageOutput", f.result);
};
const threadRead = (row?: Record<string, unknown>): Step => ({
  match: /from "vertex_research_chat_threads"/,
  rows: row ? [row] : [],
});
const messageRead = (row?: Record<string, unknown>): Step => ({
  match: /from "vertex_research_chat_messages"/,
  rows: row ? [row] : [],
});
const cas = (threadId: string): Step => ({
  match: /update vertex_research_chat_threads/,
  rows: [{ thread_id: threadId }],
});
const transcriptCursor = async (
  threadId: string,
  limit: number,
  after: string,
  snapshotRevision: string,
  highWaterSequence: string
): Promise<string> => {
  const binding = await hash({
    operation: "readTranscriptPage",
    version: 2,
    actorId: principal.actorId,
    scope,
    threadId,
    limit,
    after,
    snapshotRevision,
    highWaterSequence,
  });
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
    .replace(/[=]+$/g, "");
};
const transcriptOutput = (
  thread: VertexRecord,
  snapshotRevision: string,
  items: readonly VertexRecord[],
  nextCursor: string | null = null
): VertexRecord => {
  return {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    thread,
    snapshotRevision,
    highWaterSequence: (BigInt(snapshotRevision) - 1n).toString(),
    items,
    nextCursor,
  };
};
const acceptTranscript = (
  h: ReturnType<typeof harness>,
  threadId: string,
  limit: number,
  cursor: string | null,
  result?: VertexRecord
): void => {
  h.accept("readTranscriptPage", { ...scope, threadId, limit, cursor });
  if (result) h.accept("ResearchChatReadTranscriptPageOutput", result);
};

describe("durable owner-scoped human research chat", () => {
  it("creates an immutable actor-scoped original receipt without model policy, artifact or job admission", async () => {
    const f = await createFixture();
    const h = harness([threadRead()]);
    acceptCreate(h, f);
    const result = await h.store.createResearchChatThread(createInput);
    expect(result).toEqual(f.result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result["participantIds"])).toBe(true);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(h.commandPolicy).not.toHaveBeenCalled();
    expect(
      h.calls.some((c) =>
        /insert into "vertex_research_chat_threads"/.test(c.sql)
      )
    ).toBe(true);
    expect(
      h.calls.some((c) =>
        /vertex_(artifacts|records|outbox|agent|worker|research_proposals)/.test(
          c.sql
        )
      )
    ).toBe(false);
    expect(
      h.authorize.mock.calls.every(
        ([request]) =>
          request.resourceId === "research-chat" && request.action === "publish"
      )
    ).toBe(true);
    return expect(
      h.calls
        .filter((c) => c.sql.includes("pg_advisory_xact_lock"))
        .map((c) => c.params[0])
    ).toEqual([
      "vertex-authorization:global",
      JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment]),
      JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
    ]);
  });
  it("replays the original creation response even after the thread advanced", async () => {
    const f = await createFixture("7");
    const h = harness([threadRead(f.row)]);
    acceptCreate(h, f);
    expect(await h.store.createResearchChatThread(createInput)).toEqual(
      f.result
    );
    return expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
      false
    );
  });
  it("conflicts on changed create bytes before returning a previous receipt", async () => {
    const f = await createFixture();
    const h = harness([threadRead(f.row)]);
    acceptCreate(h, f);
    h.accept("createThread", {
      ...createCommand,
      title: "Different exact title",
    });
    await expect(
      h.store.createResearchChatThread({
        ...createInput,
        title: "Different exact title",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  it.each(["paper", "live"] as const)(
    "rejects %s even at the persistence boundary",
    async (environment) => {
      const h = harness();
      await expect(
        h.store.createResearchChatThread({
          ...createInput,
          scope: { ...scope, environment },
        })
      ).rejects.toMatchObject({ code: "invalid" });
      return expect(h.calls).toEqual([]);
    }
  );
  it("does not promote a read grant into publish, including receipt replay", async () => {
    const f = await createFixture();
    const h = harness();
    acceptCreate(h, f);
    h.authorize.mockImplementation(
      async (request) => request.action === "read"
    );
    await expect(
      h.store.createResearchChatThread(createInput)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  it("treats missing and cross-owner reads identically and scopes SQL to actor/account/environment", async () => {
    const f = await createFixture();
    const h = harness([threadRead(), threadRead()]);
    const command = { ...scope, threadId: f.threadId };
    h.accept("readThread", command);
    expect(
      await h.store.readResearchChatThread(principal, scope, f.threadId)
    ).toBeNull();
    expect(
      await h.store.readResearchChatThread(
        { actorId: "other-human" },
        scope,
        f.threadId
      )
    ).toBeNull();
    const lookups = h.calls.filter((c) =>
      c.sql.includes('from "vertex_research_chat_threads"')
    );
    return expect(lookups.map((c) => c.params)).toEqual([
      [scope.accountAlias, scope.environment, principal.actorId, f.threadId],
      [scope.accountAlias, scope.environment, "other-human", f.threadId],
    ]);
  });
  it.each([{ requested: [] }, { requested: ["expert-1"] }])(
    "persists only a human statement and truthfully reports request $requested",
    async ({ requested }) => {
      const f = await sendFixture("1", requested);
      const h = harness([
        threadRead(f.thread.row),
        messageRead(),
        cas(f.thread.threadId),
      ]);
      acceptSend(h, f);
      const result = await h.store.sendResearchChatMessage(f.input);
      expect(result).toEqual(f.result);
      expect(h.lifecycle).toEqual(["begin", "commit"]);
      expect(h.commandPolicy).not.toHaveBeenCalled();
      expect(
        h.calls.filter((c) =>
          /^insert into "vertex_research_chat_messages"/.test(c.sql)
        )
      ).toHaveLength(1);
      expect(
        h.calls.some((c) =>
          /vertex_(outbox|agent|worker|artifacts|records)/.test(c.sql)
        )
      ).toBe(false);
      return expect(Object.isFrozen(result["response"])).toBe(true);
    }
  );
  it("replays the exact original acknowledgement after later messages without stale-revision rejection", async () => {
    const f = await sendFixture("1", ["expert-1"]);
    const later = await createFixture("9");
    const h = harness([threadRead(later.row), messageRead(f.row)]);
    acceptSend(h, f);
    h.accept("ResearchChatThread", later.current);
    expect(await h.store.sendResearchChatMessage(f.input)).toEqual(f.result);
    return expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
      false
    );
  });
  it.each(["body", "mode", "expectedRevision", "requestedParticipantIds"])(
    "conflicts when a duplicate send changes %s",
    async (field) => {
      const f = await sendFixture();
      const changes: Record<string, unknown> = {
        body: "Changed text",
        mode: "debate",
        expectedRevision: "2",
        requestedParticipantIds: ["expert-1"],
      };
      const h = harness([threadRead(f.thread.row), messageRead(f.row)]);
      acceptSend(h, f);
      h.accept("sendMessage", { ...f.command, [field]: changes[field] });
      await expect(
        h.store.sendResearchChatMessage({ ...f.input, [field]: changes[field] })
      ).rejects.toMatchObject({ code: "conflict" });
      return expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
        false
      );
    }
  );
  it("rejects a stale revision or unselected participant before transcript mutation", async () => {
    const f = await sendFixture();
    const later = await createFixture("2");
    const h = harness([threadRead(later.row), messageRead()]);
    acceptSend(h, f);
    h.accept("ResearchChatThread", later.current);
    await expect(
      h.store.sendResearchChatMessage(f.input)
    ).rejects.toMatchObject({ code: "conflict" });
    const other = await sendFixture("1", ["not-selected"]);
    const denied = harness([threadRead(other.thread.row), messageRead()]);
    acceptSend(denied, other);
    await expect(
      denied.store.sendResearchChatMessage(other.input)
    ).rejects.toMatchObject({ code: "invalid" });
    for (const value of [h, denied])
      expect(value.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
        false
      );
  });
  it("allocates sequence and revision above 2^53 without Number rounding", async () => {
    const f = await sendFixture("9007199254740993");
    const h = harness([
      threadRead(f.thread.row),
      messageRead(),
      cas(f.thread.threadId),
    ]);
    acceptSend(h, f);
    expect(await h.store.sendResearchChatMessage(f.input)).toEqual(f.result);
    expect(f.result.threadRevision).toBe("9007199254740994");
    expect(f.message.sequence).toBe("9007199254740993");
    const update = h.calls.find((c) =>
      c.sql.startsWith("update vertex_research_chat_threads")
    )!;
    expect(update.sql).toContain("revision =");
    expect(update.params).toContain("9007199254740993");
    return expect(update.params).toContain("9007199254740994");
  });
  it("rolls back on failed CAS or failed message insertion without an acknowledgement", async () => {
    const f = await sendFixture();
    for (const steps of [
      [
        threadRead(f.thread.row),
        messageRead(),
        { match: /update vertex_research_chat_threads/, rows: [] },
      ],
      [
        threadRead(f.thread.row),
        messageRead(),
        cas(f.thread.threadId),
        {
          match: /insert into "vertex_research_chat_messages"/,
          error: "synthetic storage failure",
        },
      ],
    ]) {
      const h = harness(steps);
      acceptSend(h, f);
      await expect(
        h.store.sendResearchChatMessage(f.input)
      ).rejects.toMatchObject({
        code: steps.length === 3 ? "conflict" : "unavailable",
      });
      expect(h.lifecycle).toEqual(["begin", "rollback"]);
    }
  });
  it("rejects altered stored acknowledgement bytes rather than blessing a new hash", async () => {
    const f = await sendFixture();
    const latest = await createFixture("2");
    const h = harness([
      threadRead(latest.row),
      messageRead({ ...f.row, response_hash: "0".repeat(64) }),
    ]);
    acceptSend(h, f);
    h.accept("ResearchChatThread", latest.current);
    return await expect(
      h.store.sendResearchChatMessage(f.input)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  return it("requires authoritative input validation before any DB access", async () => {
    const h = harness();
    await expect(
      h.store.createResearchChatThread({
        ...createInput,
        title: "illegal\u0000title",
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.calls).toEqual([]);
  });
});

describe("research-chat immutable boundary and bounded pagination", () => {
  it("fails unavailable without the exact injected input validators", async () => {
    const h = harness([], false);
    await expect(
      h.store.createResearchChatThread(createInput)
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(h.calls).toEqual([]);
  });
  it("reauthorizes under the existing global lock before admitting a write", async () => {
    const f = await createFixture();
    const h = harness();
    acceptCreate(h, f);
    h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(
      h.store.createResearchChatThread(createInput)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    return expect(
      h.calls.every((call) => call.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
  it("captures the full request before the caller can mutate scope, actor, title or participants", async () => {
    const f = await createFixture();
    const h = harness([threadRead()]);
    acceptCreate(h, f);
    const mutable = {
      ...createInput,
      principal: { ...principal },
      scope: { ...scope },
      participantIds: [...createInput.participantIds],
    };
    const promise = h.store.createResearchChatThread(mutable);
    mutable.title = "Replaced title";
    mutable.principal.actorId = "other-human";
    mutable.scope.environment = "live";
    mutable.participantIds.push("other-expert");
    return expect(await promise).toEqual(f.result);
  });
  it("rejects server-owned extra fields and validator transformations", async () => {
    const f = await createFixture();
    const h = harness();
    acceptCreate(h, f);
    await expect(
      h.store.createResearchChatThread({
        ...createInput,
        ownerActorId: "other-human",
      } as never)
    ).rejects.toMatchObject({ code: "invalid" });
    h.validate.mockImplementationOnce(async (_name, value) => ({
      ...(value as VertexRecord),
      title: "Normalized title",
    }));
    await expect(
      h.store.createResearchChatThread(createInput)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.calls).toEqual([]);
  });
  it("rejects exhaustion of the 30-digit revision without any write", async () => {
    const f = await sendFixture("999999999999999999999999999999");
    const h = harness([threadRead(f.thread.row), messageRead()]);
    acceptSend(h, f);
    await expect(
      h.store.sendResearchChatMessage(f.input)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(
      h.calls.some((call) => /^insert|^update/.test(call.sql))
    ).toBe(false);
  });
  it("does not leak a cross-owner row even if the adapter returns it", async () => {
    const f = await createFixture();
    const h = harness([
      threadRead({ ...f.row, owner_actor_id: "other-human" }),
    ]);
    acceptCreate(h, f);
    h.accept("readThread", { ...scope, threadId: f.threadId });
    return await expect(
      h.store.readResearchChatThread(principal, scope, f.threadId)
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("lists threads in deterministic ID order and binds opaque cursors to actor, scope, operation and limit", async () => {
    const first = await createFixture("1", "page-1");
    const second = await createFixture("1", "page-2");
    const sorted = [first, second].sort((a, b) =>
      a.threadId < b.threadId ? -1 : 1
    );
    const h = harness([
      {
        match: /from "vertex_research_chat_threads"/,
        rows: sorted.map((entry) => entry.row),
      },
      { match: /from "vertex_research_chat_threads"/, rows: [sorted[1]!.row] },
    ]);
    for (const f of sorted) acceptCreate(h, f);
    h.accept("listThreads", { ...scope, limit: 1, cursor: null });
    const page = await h.store.listResearchChatThreads(principal, scope, {
      limit: 1,
      cursor: null,
    });
    expect(page.items).toEqual([sorted[0]!.current]);
    expect(page.nextCursor).not.toBeNull();
    expect(Object.isFrozen(page.items)).toBe(true);
    const token = page.nextCursor!;
    h.accept("listThreads", { ...scope, limit: 1, cursor: token });
    const next = await h.store.listResearchChatThreads(principal, scope, {
      limit: 1,
      cursor: token,
    });
    expect(next).toEqual({ items: [sorted[1]!.current], nextCursor: null });
    await expect(
      h.store.listResearchChatThreads({ actorId: "other-human" }, scope, {
        limit: 1,
        cursor: token,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    h.accept("listThreads", {
      ...scope,
      accountAlias: "other-room",
      limit: 1,
      cursor: token,
    });
    await expect(
      h.store.listResearchChatThreads(
        principal,
        { ...scope, accountAlias: "other-room" },
        { limit: 1, cursor: token }
      )
    ).rejects.toMatchObject({ code: "invalid" });
    h.accept("listThreads", { ...scope, limit: 2, cursor: token });
    await expect(
      h.store.listResearchChatThreads(principal, scope, {
        limit: 2,
        cursor: token,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    h.accept("listMessages", {
      ...scope,
      threadId: first.threadId,
      limit: 1,
      cursor: token,
    });
    await expect(
      h.store.listResearchChatMessages(principal, scope, first.threadId, {
        limit: 1,
        cursor: token,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    h.accept("listThreads", { ...scope, limit: 1, cursor: `${token}=` });
    await expect(
      h.store.listResearchChatThreads(principal, scope, {
        limit: 1,
        cursor: `${token}=`,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.pending).toEqual([]);
    const queries = h.calls.filter((call) =>
      call.sql.includes('from "vertex_research_chat_threads"')
    );
    expect(queries).toHaveLength(2);
    expect(
      queries.every((call) =>
        call.sql.includes('order by thread_id collate "C" asc')
      )
    ).toBe(true);
    return expect(queries[0]!.params).toEqual([
      scope.accountAlias,
      scope.environment,
      principal.actorId,
      2,
    ]);
  });
  it("paginates exact message sequences beyond 2^53 and rejects replay against another thread", async () => {
    const first = await sendFixture("9007199254740993", [], "page-message-1");
    const second = await sendFixture("9007199254740994", [], "page-message-2");
    const latest = await createFixture("9007199254740995");
    const h = harness([
      threadRead(latest.row),
      {
        match: /from "vertex_research_chat_messages"/,
        rows: [first.row, second.row],
      },
      threadRead(latest.row),
      messageRead(second.row),
    ]);
    acceptSend(h, first);
    acceptSend(h, second);
    acceptCreate(h, latest);
    h.accept("listMessages", {
      ...scope,
      threadId: latest.threadId,
      limit: 1,
      cursor: null,
    });
    const page = await h.store.listResearchChatMessages(
      principal,
      scope,
      latest.threadId,
      { limit: 1, cursor: null }
    );
    expect(page.items).toEqual([first.message]);
    const token = page.nextCursor!;
    expect(token).toBeTypeOf("string");
    h.accept("listMessages", {
      ...scope,
      threadId: latest.threadId,
      limit: 1,
      cursor: token,
    });
    expect(
      await h.store.listResearchChatMessages(
        principal,
        scope,
        latest.threadId,
        { limit: 1, cursor: token }
      )
    ).toEqual({ items: [second.message], nextCursor: null });
    h.accept("listMessages", {
      ...scope,
      threadId: "another-thread",
      limit: 1,
      cursor: token,
    });
    await expect(
      h.store.listResearchChatMessages(principal, scope, "another-thread", {
        limit: 1,
        cursor: token,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    const queries = h.calls.filter((call) =>
      call.sql.includes('from "vertex_research_chat_messages"')
    );
    expect(queries[1]!.params).toContain("9007199254740993");
    expect(queries[1]!.sql).toContain("order by sequence asc");
    return expect(h.pending).toEqual([]);
  });
  it("rejects duplicate or nonascending message pages without producing a cursor", async () => {
    const first = await sendFixture("1", [], "page-message-1");
    const second = await sendFixture("2", [], "page-message-2");
    const latest = await createFixture("3");
    for (const candidates of [
      [first.row, first.row],
      [second.row, first.row],
    ]) {
      const h = harness([
        threadRead(latest.row),
        { match: /from "vertex_research_chat_messages"/, rows: candidates },
      ]);
      acceptSend(h, first);
      acceptSend(h, second);
      acceptCreate(h, latest);
      h.accept("listMessages", {
        ...scope,
        threadId: latest.threadId,
        limit: 2,
        cursor: null,
      });
      await expect(
        h.store.listResearchChatMessages(principal, scope, latest.threadId, {
          limit: 2,
          cursor: null,
        })
      ).rejects.toMatchObject({ code: "integrity" });
    }
  });
  it("returns an empty message page for a missing or foreign-owner thread without reading messages", async () => {
    const h = harness([threadRead(), threadRead()]);
    const command = {
      ...scope,
      threadId: "not-visible",
      limit: 100,
      cursor: null,
    };
    h.accept("listMessages", command);
    for (const actor of [principal, { actorId: "other-human" }]) {
      expect(
        await h.store.listResearchChatMessages(actor, scope, command.threadId, {
          limit: 100,
          cursor: null,
        })
      ).toEqual({ items: [], nextCursor: null });
    }
    return expect(
      h.calls.some((call) => call.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
  });
  it.each([1, 100])(
    "accepts bounded page limit %s and requests at most one lookahead row",
    async (limit) => {
      const h = harness([
        { match: /from "vertex_research_chat_threads"/, rows: [] },
      ]);
      h.accept("listThreads", { ...scope, limit, cursor: null });
      expect(
        await h.store.listResearchChatThreads(principal, scope, {
          limit,
          cursor: null,
        })
      ).toEqual({ items: [], nextCursor: null });
      return expect(
        h.calls
          .find((call) =>
            call.sql.includes('from "vertex_research_chat_threads"')
          )!
          .params.at(-1)
      ).toBe(limit + 1);
    }
  );
  it.each([0, 101, -1, 1.5])(
    "honors injected rejection of illegal page limit %s before querying",
    async (limit) => {
      const h = harness();
      await expect(
        h.store.listResearchChatThreads(principal, scope, {
          limit,
          cursor: null,
        })
      ).rejects.toMatchObject({ code: "invalid" });
      return expect(h.calls).toEqual([]);
    }
  );
  return it("does not look up receipts or leak existence when sending to a missing or foreign-owner thread", async () => {
    const f = await sendFixture();
    for (const actor of [principal, { actorId: "other-human" }]) {
      const h = harness([threadRead()]);
      acceptSend(h, f);
      await expect(
        h.store.sendResearchChatMessage({ ...f.input, principal: actor })
      ).rejects.toMatchObject({ code: "denied" });
      expect(
        h.calls.some(
          (call) =>
            call.sql.includes("vertex_research_chat_messages") ||
            /^insert|^update/.test(call.sql)
        )
      ).toBe(false);
    }
  });
});

describe("research-chat fixed high-water transcript pages", () => {
  it("reads an empty snapshot and current head within one existing read-authorized transaction", async () => {
    const f = await createFixture();
    const h = harness([threadRead(f.row), messageRead()]);
    acceptCreate(h, f);
    const expected = transcriptOutput(f.current, "1", []);
    acceptTranscript(h, f.threadId, 100, null, expected);
    const result = await h.store.readResearchChatTranscriptPage(
      principal,
      scope,
      f.threadId,
      { limit: 100, cursor: null }
    );
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!["items"])).toBe(true);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(
      h.authorize.mock.calls.every(
        ([request]) =>
          request.action === "read" && request.resourceId === "research-chat"
      )
    ).toBe(true);
    expect(
      h.calls
        .filter((c) => c.sql.includes("pg_advisory_xact_lock"))
        .map((c) => c.params[0])
    ).toEqual([
      "vertex-authorization:global",
      JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment]),
      JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
    ]);
    const query = h.calls.find((c) =>
      c.sql.includes('from "vertex_research_chat_messages"')
    )!;
    expect(query.sql).toContain("sequence <=");
    expect(query.sql).toContain("order by sequence asc");
    expect(query.params).toEqual([
      scope.accountAlias,
      scope.environment,
      principal.actorId,
      f.threadId,
      "0",
      101,
    ]);
    expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(false);
    return expect(h.commandPolicy).not.toHaveBeenCalled();
  });
  it("keeps the head captured before the message read even if the fixture's current row advances", async () => {
    const first = await sendFixture();
    const captured = await createFixture("2");
    const latest = await createFixture("3");
    const row = { ...captured.row };
    const h = harness([
      threadRead(row),
      {
        ...messageRead(first.row),
        onRead: () => {
          Object.assign(row, latest.row);
        },
      },
    ]);
    acceptSend(h, first);
    acceptCreate(h, captured);
    const expected = transcriptOutput(captured.current, "2", [first.message]);
    acceptTranscript(h, captured.threadId, 100, null, expected);
    expect(
      await h.store.readResearchChatTranscriptPage(
        principal,
        scope,
        captured.threadId,
        { limit: 100, cursor: null }
      )
    ).toEqual(expected);
    expect(row.revision).toBe("3");
    return expect(
      h.calls.find((c) => c.sql.includes("order by sequence"))!.params[4]
    ).toBe("1");
    // This adversarial fixture checks capture semantics, not SQL concurrency;
    // coordinated real writers must acquire the same scope lock first.
  });
  it("keeps all continuation pages at the captured boundary while exposing a newer current head and refreshing explicitly", async () => {
    const first = await sendFixture("1", [], "page-1");
    const second = await sendFixture("2", [], "page-2");
    const third = await sendFixture("3", [], "page-3");
    const appended = await sendFixture("4", [], "page-4");
    const captured = await createFixture("4");
    const latest = await createFixture("5");
    const h = harness([
      threadRead(captured.row),
      {
        match: /from "vertex_research_chat_messages"/,
        rows: [first.row, second.row],
      },
      threadRead(latest.row),
      {
        match: /from "vertex_research_chat_messages"/,
        rows: [second.row, third.row],
      },
      threadRead(latest.row),
      messageRead(third.row),
      threadRead(latest.row),
      {
        match: /from "vertex_research_chat_messages"/,
        rows: [first.row, second.row, third.row, appended.row],
      },
      threadRead(latest.row),
      messageRead(first.row),
    ]);
    for (const f of [first, second, third, appended]) acceptSend(h, f);
    for (const f of [captured, latest]) acceptCreate(h, f);
    const token1 = await transcriptCursor(captured.threadId, 1, "1", "4", "3");
    const token2 = await transcriptCursor(captured.threadId, 1, "2", "4", "3");
    const page1 = transcriptOutput(
      captured.current,
      "4",
      [first.message],
      token1
    );
    const page2 = transcriptOutput(
      latest.current,
      "4",
      [second.message],
      token2
    );
    const page3 = transcriptOutput(latest.current, "4", [third.message]);
    const fresh = transcriptOutput(latest.current, "5", [
      first.message,
      second.message,
      third.message,
      appended.message,
    ]);
    for (const [cursor, result] of [
      [null, page1],
      [token1, page2],
      [token2, page3],
    ] as const) {
      acceptTranscript(h, captured.threadId, 1, cursor, result);
      expect(
        await h.store.readResearchChatTranscriptPage(
          principal,
          scope,
          captured.threadId,
          { limit: 1, cursor }
        )
      ).toEqual(result);
    }
    acceptTranscript(h, latest.threadId, 100, null, fresh);
    expect(
      await h.store.readResearchChatTranscriptPage(
        principal,
        scope,
        latest.threadId,
        { limit: 100, cursor: null }
      )
    ).toEqual(fresh);
    // Snapshot reads neither replace nor mutate the historical human receipt.
    expect(await h.store.sendResearchChatMessage(first.input)).toEqual(
      first.result
    );
    const queries = h.calls.filter(
      (c) =>
        c.sql.includes('from "vertex_research_chat_messages"') &&
        c.sql.includes("order by")
    );
    expect(queries.map((c) => c.params[4])).toEqual(["3", "3", "3", "4"]);
    expect(queries[1]!.params).toContain("1");
    expect(queries[2]!.params).toContain("2");
    expect(h.pending).toEqual([]);
    return expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
      false
    );
  });
  it("orders contiguous continuation ordinals exactly beyond Number precision", async () => {
    const first = await sendFixture("9007199254740993", [], "large-1");
    const second = await sendFixture("9007199254740994", [], "large-2");
    const latest = await createFixture("9007199254740996");
    const h = harness([
      threadRead(latest.row),
      {
        match: /from "vertex_research_chat_messages"/,
        rows: [first.row, second.row],
      },
    ]);
    for (const f of [first, second]) acceptSend(h, f);
    acceptCreate(h, latest);
    const cursor = await transcriptCursor(
      latest.threadId,
      2,
      "9007199254740992",
      "9007199254740995",
      "9007199254740994"
    );
    const expected = transcriptOutput(latest.current, "9007199254740995", [
      first.message,
      second.message,
    ]);
    acceptTranscript(h, latest.threadId, 2, cursor, expected);
    expect(
      await h.store.readResearchChatTranscriptPage(
        principal,
        scope,
        latest.threadId,
        { limit: 2, cursor }
      )
    ).toEqual(expected);
    const query = h.calls.find((c) => c.sql.includes("order by sequence"))!;
    expect(query.params).toContain("9007199254740994");
    return expect(query.params).toContain("9007199254740992");
  });
  it("rejects actor, account, thread, limit and old-operation cursor replay before database access", async () => {
    const f = await createFixture("4");
    const cursor = await transcriptCursor(f.threadId, 1, "1", "4", "3");
    const oldBinding = await hash({
      operation: "listMessages",
      actorId: principal.actorId,
      scope,
      threadId: f.threadId,
      limit: 1,
    });
    const oldCursor = btoa(
      JSON.stringify({ version: 1, binding: oldBinding, after: "1" })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/[=]+$/g, "");
    for (const attempt of [
      {
        principal: { actorId: "other" },
        scope,
        threadId: f.threadId,
        limit: 1,
        cursor,
      },
      {
        principal,
        scope: { ...scope, accountAlias: "other" },
        threadId: f.threadId,
        limit: 1,
        cursor,
      },
      { principal, scope, threadId: "other", limit: 1, cursor },
      { principal, scope, threadId: f.threadId, limit: 2, cursor },
      { principal, scope, threadId: f.threadId, limit: 1, cursor: oldCursor },
    ]) {
      const h = harness();
      h.accept("readTranscriptPage", {
        ...attempt.scope,
        threadId: attempt.threadId,
        limit: attempt.limit,
        cursor: attempt.cursor,
      });
      await expect(
        h.store.readResearchChatTranscriptPage(
          attempt.principal,
          attempt.scope,
          attempt.threadId,
          { limit: attempt.limit, cursor: attempt.cursor }
        )
      ).rejects.toMatchObject({ code: "invalid" });
      expect(h.calls).toEqual([]);
    }
    const h = harness();
    h.accept("listMessages", {
      ...scope,
      threadId: f.threadId,
      limit: 1,
      cursor,
    });
    await expect(
      h.store.listResearchChatMessages(principal, scope, f.threadId, {
        limit: 1,
        cursor,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.calls).toEqual([]);
  });
  it("rejects malformed, altered, noncanonical and future snapshot cursors", async () => {
    const f = await createFixture("4");
    const valid = await transcriptCursor(f.threadId, 1, "1", "4", "3");
    const decoded = JSON.parse(
      atob(valid.replace(/-/g, "+").replace(/_/g, "/"))
    );
    const encode = (value: unknown): string =>
      btoa(JSON.stringify(value))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/[=]+$/g, "");
    for (const cursor of [
      "",
      "!",
      "a".repeat(4097),
      `${valid}=`,
      encode({ ...decoded, extra: true }),
      encode({ ...decoded, version: 1 }),
      encode({ ...decoded, operation: "listMessages" }),
      encode({ ...decoded, binding: "wrong" }),
      encode({ ...decoded, after: "2" }),
      encode({ ...decoded, snapshotRevision: "5", highWaterSequence: "4" }),
      await transcriptCursor(f.threadId, 1, "0", "4", "3"),
      await transcriptCursor(f.threadId, 1, "3", "4", "3"),
      await transcriptCursor(f.threadId, 1, "1", "3", "3"),
      await transcriptCursor(f.threadId, 1, "01", "4", "3"),
      await transcriptCursor(f.threadId, 1, "1", "4\n", "3"),
      await transcriptCursor(f.threadId, 1, "1", "4", "03"),
      await transcriptCursor(f.threadId, 1, "1", "4", "1".repeat(31)),
    ]) {
      const h = harness();
      acceptTranscript(h, f.threadId, 1, cursor);
      await expect(
        h.store.readResearchChatTranscriptPage(principal, scope, f.threadId, {
          limit: 1,
          cursor,
        })
      ).rejects.toMatchObject({ code: "invalid" });
      expect(h.calls).toEqual([]);
    }
    const future = await transcriptCursor(f.threadId, 1, "1", "5", "4");
    const h = harness([threadRead(f.row)]);
    acceptCreate(h, f);
    acceptTranscript(h, f.threadId, 1, future);
    await expect(
      h.store.readResearchChatTranscriptPage(principal, scope, f.threadId, {
        limit: 1,
        cursor: future,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(
      h.calls.some((c) => c.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
  });
  it("rechecks current read permission and ownership for a continuation and returns null for invisible threads", async () => {
    const f = await createFixture("4");
    const cursor = await transcriptCursor(f.threadId, 1, "1", "4", "3");
    for (const locked of [false, true]) {
      const h = harness();
      acceptTranscript(h, f.threadId, 1, cursor);
      if (locked) {
        h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
      } else h.authorize.mockResolvedValue(false);
      await expect(
        h.store.readResearchChatTranscriptPage(principal, scope, f.threadId, {
          limit: 1,
          cursor,
        })
      ).rejects.toMatchObject({ code: "denied" });
      expect(
        h.calls.every((c) => c.sql.includes("pg_advisory_xact_lock"))
      ).toBe(true);
    }
    const missing = harness([threadRead()]);
    acceptTranscript(missing, f.threadId, 1, cursor);
    expect(
      await missing.store.readResearchChatTranscriptPage(
        principal,
        scope,
        f.threadId,
        { limit: 1, cursor }
      )
    ).toBeNull();
    expect(
      missing.calls.some((c) => c.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
    for (const actor of [principal, { actorId: "other" }]) {
      const h = harness([threadRead()]);
      acceptTranscript(h, f.threadId, 1, null);
      expect(
        await h.store.readResearchChatTranscriptPage(actor, scope, f.threadId, {
          limit: 1,
          cursor: null,
        })
      ).toBeNull();
      expect(
        h.calls.some((c) => c.sql.includes("vertex_research_chat_messages"))
      ).toBe(false);
    }
    const h = harness([threadRead({ ...f.row, owner_actor_id: "other" })]);
    acceptCreate(h, f);
    acceptTranscript(h, f.threadId, 1, cursor);
    return await expect(
      h.store.readResearchChatTranscriptPage(principal, scope, f.threadId, {
        limit: 1,
        cursor,
      })
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("fails closed on missing, foreign, duplicate, noncontiguous, oversize or out-of-boundary rows", async () => {
    const first = await sendFixture("1", [], "integrity-1");
    const second = await sendFixture("2", [], "integrity-2");
    const third = await sendFixture("3", [], "integrity-3");
    const latest = await createFixture("4");
    const cursor = await transcriptCursor(latest.threadId, 2, "1", "3", "2");
    for (const test of [
      { cursor: null, rows: [] },
      { cursor: null, rows: [first.row] },
      { cursor: null, rows: [second.row] },
      { cursor: null, rows: [first.row, third.row] },
      { cursor: null, rows: [first.row, first.row] },
      { cursor: null, rows: [second.row, first.row] },
      { cursor: null, rows: [first.row, second.row, third.row, third.row] },
      { cursor, rows: [second.row, third.row] },
      { cursor, rows: [] },
      { cursor: null, rows: [{ ...first.row, owner_actor_id: "other" }] },
      { cursor: null, rows: [{ ...first.row, account_alias: "other" }] },
      { cursor: null, rows: [{ ...first.row, thread_id: "other" }] },
      { cursor: null, rows: [{ ...first.row, record_hash: "0".repeat(64) }] },
      { cursor: null, rows: [{ ...first.row, response_hash: "0".repeat(64) }] },
    ]) {
      const h = harness([
        threadRead(latest.row),
        { match: /from "vertex_research_chat_messages"/, rows: test.rows },
      ]);
      for (const f of [first, second, third]) acceptSend(h, f);
      acceptCreate(h, latest);
      acceptTranscript(h, latest.threadId, 2, test.cursor);
      await expect(
        h.store.readResearchChatTranscriptPage(
          principal,
          scope,
          latest.threadId,
          { limit: 2, cursor: test.cursor }
        )
      ).rejects.toMatchObject({ code: "integrity" });
      expect(h.lifecycle).toEqual(["begin", "rollback"]);
    }
  });
  it("never admits a self-consistent agent or altered human row through the human-only transcript path", async () => {
    const first = await sendFixture();
    const latest = await createFixture("2");
    for (const change of [
      { author: { kind: "agent", participantId: "expert-1", runId: "run-1" } },
      { author: { kind: "user", actorId: "other" } },
      { body: "Changed human text" },
      { kind: "synthesis" },
      { citations: [{ artifactId: "artifact-1", sha256: "a".repeat(64) }] },
    ]) {
      const message = { ...first.message, ...change };
      const result = { ...first.result, message };
      const row = {
        ...first.row,
        payload: message,
        record_hash: await hash(message),
        response: result,
        response_hash: await hash(result),
      };
      const h = harness([threadRead(latest.row), messageRead(row)]);
      acceptSend(h, first);
      acceptCreate(h, latest);
      h.accept("ResearchChatMessage", message);
      h.accept("ResearchChatSendMessageOutput", result);
      acceptTranscript(h, latest.threadId, 100, null);
      await expect(
        h.store.readResearchChatTranscriptPage(
          principal,
          scope,
          latest.threadId,
          { limit: 100, cursor: null }
        )
      ).rejects.toMatchObject({ code: "integrity" });
    }
  });
  it("requires an unchanged authoritative output validator rather than blessing transformed page bytes", async () => {
    const f = await createFixture();
    const h = harness([threadRead(f.row), messageRead()]);
    acceptCreate(h, f);
    acceptTranscript(h, f.threadId, 100, null);
    h.validate.mockImplementation(async (name, value) => {
      if (name === "ResearchChatReadTranscriptPageOutput")
        return { ...(value as VertexRecord), snapshotRevision: "2" };
      return structuredClone(value) as VertexRecord;
    });
    await expect(
      h.store.readResearchChatTranscriptPage(principal, scope, f.threadId, {
        limit: 100,
        cursor: null,
      })
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(h.calls.some((c) => /^insert|^update/.test(c.sql))).toBe(
      false
    );
  });
  return it("rejects caller-authored boundary metadata and invalid page inputs before opening a transaction", async () => {
    const h = harness();
    for (const page of [
      { limit: 100, cursor: null, snapshotRevision: "1" },
      { limit: 100, cursor: null, highWaterSequence: "0" },
      { limit: 100, cursor: null, thread: {} },
      { limit: 0, cursor: null },
      { limit: 101, cursor: null },
      { limit: 1.5, cursor: null },
    ]) {
      await expect(
        h.store.readResearchChatTranscriptPage(
          principal,
          scope,
          "thread-1",
          page as never
        )
      ).rejects.toMatchObject({ code: "invalid" });
    }
    return expect(h.calls).toEqual([]);
  });
});

const responseFixture = async (
  snapshotRevision = "2",
  contextStartSequence = "1",
  currentRevision = snapshotRevision,
  participantId = "expert-1",
  participantIds: readonly string[] = [participantId]
) => {
  const thread = await createFixture(
    currentRevision,
    createInput.idempotencyKey,
    participantIds
  );
  const messages: Awaited<ReturnType<typeof sendFixture>>[] = [];
  for (
    let sequence = BigInt(contextStartSequence);
    sequence < BigInt(snapshotRevision);
    sequence++
  ) {
    messages.push(
      await sendFixture(
        sequence.toString(),
        [],
        `send-${sequence}`,
        participantIds
      )
    );
  }
  const parentMessageId = messages.at(-1)!.message.messageId;
  const metadata = {
    ...scope,
    threadId: thread.threadId,
    parentMessageId,
    participantId,
    snapshotRevision,
    contextStartSequence,
    idempotencyKey: "response-key-1",
  };
  const retrievalQuery = "What should we examine?";
  const command = { ...metadata, retrievalQuery };
  const input = {
    principal,
    scope,
    threadId: metadata.threadId,
    parentMessageId,
    participantId,
    snapshotRevision,
    contextStartSequence,
    retrievalQuery,
    idempotencyKey: metadata.idempotencyKey,
  };
  const storedCommand = {
    profile: "vertex-research-chat-response-command-v1",
    operation: "requestResponse",
    actorId: principal.actorId,
    input: metadata,
  };
  const responseRequestId = `response-${await hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId: thread.threadId, idempotencyKey: metadata.idempotencyKey })}`;
  const requestHash = await hash({
    operation: "requestResponse",
    actorId: principal.actorId,
    input: command,
  });
  const result = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    ...metadata,
    ownerActorId: principal.actorId,
    responseRequestId,
    requestSha256: requestHash,
    recordedAt: NOW,
    status: "unavailable",
    reasonCodes: ["research-runtime-unavailable"],
    admission: null,
    jobId: null,
  };
  const row = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    actor_id: principal.actorId,
    kind: "research-chat-response",
    idempotency_key: responseRequestId,
    request_hash: requestHash,
    command: storedCommand,
    result,
    result_hash: await hash({ command: storedCommand, result }),
    collection_key: "",
    target_artifact_id: null,
    review_id: null,
    admission_id: null,
    committed_at: NOW,
    committed_at_ns: timestampToEpochNanoseconds(NOW).toString(),
  };
  const observation = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    checkedAt: NOW,
    receipt: result,
    job: null,
    delivery: { status: "not-applicable" },
  };
  return {
    thread,
    messages,
    command,
    input,
    metadata,
    storedCommand,
    result,
    row,
    observation,
  };
};
const acceptResponse = (
  h: ReturnType<typeof harness>,
  f: Awaited<ReturnType<typeof responseFixture>>
): void => {
  acceptCreate(h, f.thread);
  for (const message of f.messages) acceptSend(h, message);
  h.accept("requestResponse", f.command);
  h.accept("readResponse", {
    ...scope,
    threadId: f.input.threadId,
    idempotencyKey: f.input.idempotencyKey,
  });
  h.accept("ResearchChatResponseReceipt", f.result);
  h.accept("ResearchChatReadResponseOutput", f.observation);
};
const receiptRead = (row?: Record<string, unknown>): Step => ({
  match: /from "vertex_command_receipts"/,
  rows: row ? [row] : [],
});
const contextRead = (
  messages: readonly Readonly<{ row: VertexRecord }>[]
): Step => ({
  match: /from "vertex_research_chat_messages"/,
  rows: messages.map((message) => message.row),
});
const responseMutations = (h: ReturnType<typeof harness>) =>
  h.calls.filter((call) => /^(insert|update|delete)\b/i.test(call.sql));

describe("durable metadata-only unavailable research-chat responses", () => {
  it.each(["expert-1", "first-mate"])(
    "records an unavailable receipt for selected %s without any execution/transcript side effect",
    async (participantId) => {
      const f = await responseFixture("2", "1", "2", participantId);
      const h = harness([
        threadRead(f.thread.row),
        receiptRead(),
        contextRead(f.messages),
      ]);
      acceptResponse(h, f);
      const result = await h.store.requestResearchChatResponse(f.input);
      expect(result).toEqual(f.result);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["reasonCodes"])).toBe(true);
      expect(h.lifecycle).toEqual(["begin", "commit"]);
      expect(h.pending).toEqual([]);
      const mutations = responseMutations(h);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.sql).toMatch(
        /^insert into "vertex_command_receipts"/
      );
      expect(mutations[0]!.params).toContain(JSON.stringify(f.storedCommand));
      expect(mutations[0]!.params).not.toContain(f.input.retrievalQuery);
      const serialized = JSON.stringify(mutations);
      for (const forbidden of [
        f.input.retrievalQuery,
        f.messages[0]!.command.body,
        "retrievalQuery",
        "requestedParticipantIds",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(
        h.calls.some((call) =>
          /vertex_(artifacts|records|outbox|agent|worker|research_proposals|paper_jobs)/.test(
            call.sql
          )
        )
      ).toBe(false);
      expect(h.commandPolicy).not.toHaveBeenCalled();
      expect(h.authorize.mock.calls.map(([request]) => request.action)).toEqual(
        ["publish", "publish", "read"]
      );
      expect(
        h.calls
          .filter((call) => call.sql.includes("pg_advisory_xact_lock"))
          .map((call) => call.params[0])
      ).toEqual([
        "vertex-authorization:global",
        JSON.stringify([
          "vertex-policy",
          scope.accountAlias,
          scope.environment,
        ]),
        JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
      ]);
      const lookup = h.calls.find((call) =>
        call.sql.includes('from "vertex_command_receipts"')
      )!;
      expect(lookup.params).toEqual([
        scope.accountAlias,
        scope.environment,
        principal.actorId,
        "research-chat-response",
        f.result.responseRequestId,
      ]);
      expect(result["idempotencyKey"]).toBe(f.input.idempotencyKey);
      return expect(result["idempotencyKey"]).not.toBe(
        result["responseRequestId"]
      );
    }
  );
  it.each([
    ["3", "2", "9"],
    ["17", "1", "20"],
    ["9007199254740994", "9007199254740993", "9007199254740995"],
  ])(
    "accepts an older exact bounded prefix %s/%s under current head %s",
    async (snapshot, start, head) => {
      const f = await responseFixture(snapshot, start, head);
      const h = harness([
        threadRead(f.thread.row),
        receiptRead(),
        contextRead(f.messages),
      ]);
      acceptResponse(h, f);
      expect(await h.store.requestResearchChatResponse(f.input)).toEqual(
        f.result
      );
      const query = h.calls.find((call) =>
        call.sql.includes('from "vertex_research_chat_messages"')
      )!;
      expect(query.sql).toContain("sequence >=");
      expect(query.sql).toContain("sequence <=");
      expect(query.sql).toContain("limit 17");
      expect(query.params).toContain(start);
      expect(query.params).toContain((BigInt(snapshot) - 1n).toString());
      return expect(responseMutations(h)).toHaveLength(1);
    }
  );
  it("reconciles an original receipt after later appends without rereading transcript or resolving mutable command policy", async () => {
    const f = await responseFixture("2", "1", "99");
    const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
    acceptResponse(h, f);
    expect(await h.store.requestResearchChatResponse(f.input)).toEqual(
      f.result
    );
    expect(
      h.calls.some((call) => call.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
    expect(responseMutations(h)).toEqual([]);
    return expect(h.commandPolicy).not.toHaveBeenCalled();
  });
  it.each([
    "What should  we examine?",
    "what should we examine?",
    "What should we examine? ",
  ])("conflicts on changed literal query bytes: %s", async (retrievalQuery) => {
    const f = await responseFixture();
    const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
    acceptResponse(h, f);
    h.accept("requestResponse", { ...f.command, retrievalQuery });
    await expect(
      h.store.requestResearchChatResponse({ ...f.input, retrievalQuery })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(responseMutations(h)).toEqual([]);
    return expect(
      h.calls.some((call) => call.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
  });
  it.each([
    { field: "participantId", value: "not-selected" },
    { field: "parentMessageId", value: "other-parent" },
    { field: "snapshotRevision", value: "4" },
    { field: "contextStartSequence", value: "2" },
  ])(
    "compares the original digest before new-request $field checks",
    async ({ field, value }) => {
      const f = await responseFixture("3");
      const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
      acceptResponse(h, f);
      h.accept("requestResponse", { ...f.command, [field]: value });
      await expect(
        h.store.requestResearchChatResponse({ ...f.input, [field]: value })
      ).rejects.toMatchObject({ code: "conflict" });
      return expect(
        h.calls.some((call) =>
          call.sql.includes("vertex_research_chat_messages")
        )
      ).toBe(false);
    }
  );
  it("captures original scope, actor, range, query and key before caller mutation", async () => {
    const f = await responseFixture();
    const h = harness([
      threadRead(f.thread.row),
      receiptRead(),
      contextRead(f.messages),
    ]);
    acceptResponse(h, f);
    const mutable = {
      ...f.input,
      principal: { ...principal },
      scope: { ...scope },
    };
    const promise = h.store.requestResearchChatResponse(mutable);
    mutable.principal.actorId = "other";
    mutable.scope.accountAlias = "other";
    mutable.threadId = "other";
    mutable.parentMessageId = "other";
    mutable.participantId = "other";
    mutable.snapshotRevision = "20";
    mutable.contextStartSequence = "19";
    mutable.retrievalQuery = "A completely different query";
    mutable.idempotencyKey = "other";
    return expect(await promise).toEqual(f.result);
  });
  it("requires current publish and read, including original retries and revocation under the lock", async () => {
    const f = await responseFixture();
    for (const mode of ["read-only", "publish-only", "revoked"]) {
      const h = harness();
      acceptResponse(h, f);
      if (mode === "revoked") {
        h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
      } else
        h.authorize.mockImplementation(
          async (request) =>
            request.action === (mode === "read-only" ? "read" : "publish")
        );
      await expect(
        h.store.requestResearchChatResponse(f.input)
      ).rejects.toMatchObject({ code: "denied" });
      expect(
        h.calls.every((call) => call.sql.includes("pg_advisory_xact_lock"))
      ).toBe(true);
      expect(responseMutations(h)).toEqual([]);
    }
  });
  it("does not probe receipts for missing or foreign-owned threads", async () => {
    const f = await responseFixture();
    const h = harness([threadRead(), threadRead()]);
    acceptResponse(h, f);
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "denied" });
    expect(
      await h.store.readResearchChatResponse(
        { actorId: "other-human" },
        scope,
        f.input.threadId,
        f.input.idempotencyKey
      )
    ).toBeNull();
    return expect(
      h.calls.some((call) => call.sql.includes("vertex_command_receipts"))
    ).toBe(false);
  });
  it("returns the full no-job not-applicable observation under read alone, without query or transcript access", async () => {
    const f = await responseFixture("2", "1", "99");
    const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
    acceptResponse(h, f);
    h.authorize.mockImplementation(
      async (request) => request.action === "read"
    );
    const result = await h.store.readResearchChatResponse(
      principal,
      scope,
      f.input.threadId,
      f.input.idempotencyKey
    );
    expect(result).toEqual(f.observation);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!["receipt"])).toBe(true);
    expect(
      h.calls.some((call) => call.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
    expect(
      h.authorize.mock.calls.every(([request]) => request.action === "read")
    ).toBe(true);
    expect(h.commandPolicy).not.toHaveBeenCalled();
    return expect(responseMutations(h)).toEqual([]);
  });
  it("returns null for an absent original receipt and never retries computation", async () => {
    const f = await responseFixture();
    const h = harness([threadRead(f.thread.row), receiptRead()]);
    acceptResponse(h, f);
    expect(
      await h.store.readResearchChatResponse(
        principal,
        scope,
        f.input.threadId,
        f.input.idempotencyKey
      )
    ).toBeNull();
    expect(responseMutations(h)).toEqual([]);
    return expect(h.commandPolicy).not.toHaveBeenCalled();
  });
  it("requires a current locked read grant for reconciliation", async () => {
    const f = await responseFixture();
    const h = harness();
    acceptResponse(h, f);
    h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(
      h.store.readResearchChatResponse(
        principal,
        scope,
        f.input.threadId,
        f.input.idempotencyKey
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.calls.every((call) => call.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
  it.each(["request", "read"])(
    "rejects a regressed real clock for a new %s without fabricating timestamps",
    async (operation) => {
      const f = await responseFixture();
      const h = harness([
        threadRead(f.thread.row),
        receiptRead(operation === "read" ? f.row : undefined),
        ...(operation === "request" ? [contextRead(f.messages)] : []),
      ]);
      acceptResponse(h, f);
      h.now.mockReturnValue("2026-09-23T12:00:00.000000000Z");
      const pending =
        operation === "read"
          ? h.store.readResearchChatResponse(
              principal,
              scope,
              f.input.threadId,
              f.input.idempotencyKey
            )
          : h.store.requestResearchChatResponse(f.input);
      await expect(pending).rejects.toMatchObject({ code: "stale" });
      return expect(responseMutations(h)).toEqual([]);
    }
  );
  it("keeps original acknowledgement replay independent of a later regressed read-observation clock", async () => {
    const f = await responseFixture();
    const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
    acceptResponse(h, f);
    h.now.mockReturnValue("2026-09-23T12:00:00.000000000Z");
    expect(await h.store.requestResearchChatResponse(f.input)).toEqual(
      f.result
    );
    return expect(responseMutations(h)).toEqual([]);
  });
  it("requires the actual human parent at the exact selected prefix high water, not merely an earlier owned message", async () => {
    const f = await responseFixture("3");
    const parentMessageId = f.messages[0]!.message.messageId;
    const h = harness([
      threadRead(f.thread.row),
      receiptRead(),
      contextRead(f.messages),
    ]);
    acceptResponse(h, f);
    h.accept("requestResponse", { ...f.command, parentMessageId });
    await expect(
      h.store.requestResearchChatResponse({ ...f.input, parentMessageId })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(responseMutations(h)).toEqual([]);
  });
  it("does not turn an oversized new prefix into a context-limit receipt", async () => {
    const f = await responseFixture("18");
    const h = harness([threadRead(f.thread.row), receiptRead()]);
    acceptResponse(h, f);
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      h.calls.some((call) => call.sql.includes("vertex_research_chat_messages"))
    ).toBe(false);
    return expect(responseMutations(h)).toEqual([]);
  });
  it("captures read ownership and original-key arguments before caller mutation", async () => {
    const f = await responseFixture();
    const h = harness([threadRead(f.thread.row), receiptRead(f.row)]);
    acceptResponse(h, f);
    const actor = { ...principal };
    const target = { ...scope };
    const pending = h.store.readResearchChatResponse(
      actor,
      target,
      f.input.threadId,
      f.input.idempotencyKey
    );
    actor.actorId = "other";
    target.accountAlias = "other";
    return expect(await pending).toEqual(f.observation);
  });
  it.each([
    { field: "participantId", value: "not-selected", prefix: false },
    { field: "snapshotRevision", value: "3", prefix: false },
    { field: "parentMessageId", value: "other-parent", prefix: true },
    { field: "contextStartSequence", value: "0", prefix: false },
  ])(
    "rejects invalid new $field without an unavailable downgrade",
    async ({ field, value, prefix }) => {
      const f = await responseFixture();
      const h = harness([
        threadRead(f.thread.row),
        receiptRead(),
        ...(prefix ? [contextRead(f.messages)] : []),
      ]);
      acceptResponse(h, f);
      h.accept("requestResponse", { ...f.command, [field]: value });
      await expect(
        h.store.requestResearchChatResponse({ ...f.input, [field]: value })
      ).rejects.toMatchObject({ code: "invalid" });
      return expect(responseMutations(h)).toEqual([]);
    }
  );
  it.each([
    "gap",
    "duplicate",
    "out-of-order",
    "outside-range",
    "tail-missing",
    "tampered",
    "other-owner",
    "agent",
  ])("rejects committed prefix %s as integrity failure", async (change) => {
    const f = await responseFixture("4");
    const messages: (Omit<Awaited<ReturnType<typeof sendFixture>>, "row"> & {
      row: VertexRecord;
    })[] = f.messages.map((message) => structuredClone(message));
    if (change === "gap") messages.splice(1, 1);
    if (change === "duplicate") messages[1] = messages[0]!;
    if (change === "out-of-order") messages.reverse();
    if (change === "outside-range")
      messages[2] = await sendFixture("4", [], "send-4");
    if (change === "tail-missing") messages.pop();
    if (change === "tampered")
      messages[1]!.row = { ...messages[1]!.row, record_hash: "a".repeat(64) };
    if (change === "other-owner")
      messages[1]!.row = { ...messages[1]!.row, owner_actor_id: "other" };
    if (change === "agent") {
      const original = messages[1]!;
      const altered = {
        ...original.message,
        author: {
          kind: "agent",
          participantId: "expert-1",
          runId: "synthetic-run",
        },
      };
      const acknowledgement = { ...original.result, message: altered };
      original.row = {
        ...original.row,
        payload: altered,
        record_hash: await hash(altered),
        response: acknowledgement,
        response_hash: await hash(acknowledgement),
      };
    }
    const h = harness([
      threadRead(f.thread.row),
      receiptRead(),
      contextRead(messages),
    ]);
    acceptResponse(h, f);
    for (const message of messages) {
      h.accept("ResearchChatMessage", message.row["payload"]);
      h.accept("ResearchChatSendMessageOutput", message.row["response"]);
    }
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(responseMutations(h)).toEqual([]);
  });
  return it("rejects a failed durable receipt insertion rather than acknowledging", async () => {
    const f = await responseFixture();
    const h = harness([
      threadRead(f.thread.row),
      receiptRead(),
      contextRead(f.messages),
      {
        match: /insert into "vertex_command_receipts"/,
        error: "synthetic storage failure",
      },
    ]);
    acceptResponse(h, f);
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    return expect(h.commandPolicy).not.toHaveBeenCalled();
  });
});

describe("unavailable response receipt integrity and boundary fences", () => {
  it.each([
    { field: "account_alias", value: "other-account" },
    { field: "environment", value: "paper" },
    { field: "actor_id", value: "other-actor" },
    { field: "kind", value: "research" },
    { field: "idempotency_key", value: "response-key-1" },
    { field: "collection_key", value: "copied-collection" },
    { field: "target_artifact_id", value: "invented-artifact" },
    { field: "review_id", value: "invented-review" },
    { field: "admission_id", value: "invented-admission" },
    { field: "committed_at_ns", value: "0" },
    { field: "committed_at", value: "2026-09-23T12:00:01Z" },
    { field: "request_hash", value: "bad-digest" },
    { field: "request_hash", value: "a".repeat(64) },
    { field: "result_hash", value: "a".repeat(64) },
    { field: "command", value: null },
    { field: "result", value: null },
  ])(
    "fails closed on stored row $field corruption",
    async ({ field, value }) => {
      const f = await responseFixture();
      const h = harness([
        threadRead(f.thread.row),
        receiptRead({ ...f.row, [field]: value }),
      ]);
      acceptResponse(h, f);
      await expect(
        h.store.readResearchChatResponse(
          principal,
          scope,
          f.input.threadId,
          f.input.idempotencyKey
        )
      ).rejects.toMatchObject({ code: "integrity" });
      return expect(responseMutations(h)).toEqual([]);
    }
  );
  it.each([
    "profile",
    "operation",
    "actorId",
    "extra",
    "input-extra",
    "input-missing",
    "input-null",
    "input-type",
    "scope",
    "thread",
    "key",
    "parent",
    "participant",
    "range",
  ])("rejects rehashed metadata corruption: %s", async (change) => {
    const f = await responseFixture();
    const command: Record<string, unknown> = structuredClone(f.storedCommand);
    const metadata = command["input"] as Record<string, unknown>;
    if (change === "profile") command["profile"] = "another-profile";
    if (change === "operation") command["operation"] = "sendMessage";
    if (change === "actorId") command["actorId"] = "other";
    if (change === "extra") command["queryPreview"] = "forbidden copied query";
    if (change === "input-extra")
      metadata["retrievalQuery"] = f.input.retrievalQuery;
    if (change === "input-missing") delete metadata["participantId"];
    if (change === "input-null") metadata["participantId"] = null;
    if (change === "input-type") metadata["snapshotRevision"] = 2;
    if (change === "scope") metadata["accountAlias"] = "other";
    if (change === "thread") metadata["threadId"] = "other";
    if (change === "key") metadata["idempotencyKey"] = "other";
    if (change === "parent") metadata["parentMessageId"] = "other";
    if (change === "participant") metadata["participantId"] = "other";
    if (change === "range") metadata["snapshotRevision"] = "99";
    const row = {
      ...f.row,
      command,
      result_hash: await hash({ command, result: f.result }),
    };
    const h = harness([threadRead(f.thread.row), receiptRead(row)]);
    acceptResponse(h, f);
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(responseMutations(h)).toEqual([]);
  });
  it.each([
    { status: "admitted" },
    { reasonCodes: ["policy-unavailable"] },
    { reasonCodes: [] },
    { jobId: "invented-job" },
    { admission: { runId: "invented-run" } },
    { executionAuthorized: true },
    { idempotencyKey: "other-original-key" },
    { responseRequestId: `response-${"a".repeat(64)}` },
    { requestSha256: "a".repeat(64) },
    { recordedAt: "2026-09-23T12:00:01Z" },
    { ownerActorId: "other" },
    { accountAlias: "other" },
    { threadId: "other" },
    { contextStartSequence: "2" },
    { body: "forbidden copied response" },
  ])(
    "rejects rehashed receipt changes even if a fixture validator accepts them: %j",
    async (change) => {
      const f = await responseFixture();
      const result = { ...f.result, ...change };
      const row = {
        ...f.row,
        result,
        result_hash: await hash({ command: f.storedCommand, result }),
      };
      const h = harness([threadRead(f.thread.row), receiptRead(row)]);
      acceptResponse(h, f);
      h.accept("ResearchChatResponseReceipt", result);
      return await expect(
        h.store.readResearchChatResponse(
          principal,
          scope,
          f.input.threadId,
          f.input.idempotencyKey
        )
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  it("checks stored integrity before a changed raw request can hide corruption as conflict", async () => {
    const f = await responseFixture();
    const h = harness([
      threadRead(f.thread.row),
      receiptRead({ ...f.row, result_hash: "a".repeat(64) }),
    ]);
    acceptResponse(h, f);
    const retrievalQuery = "Changed literal query";
    h.accept("requestResponse", { ...f.command, retrievalQuery });
    return await expect(
      h.store.requestResearchChatResponse({ ...f.input, retrievalQuery })
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("binds the original user key to its derived scoped physical key even after a self-consistent metadata/result rewrite", async () => {
    const f = await responseFixture();
    const command = {
      ...f.storedCommand,
      input: { ...f.metadata, idempotencyKey: "other-original-key" },
    };
    const result = { ...f.result, idempotencyKey: "other-original-key" };
    const row = {
      ...f.row,
      command,
      result,
      result_hash: await hash({ command, result }),
    };
    const h = harness([threadRead(f.thread.row), receiptRead(row)]);
    acceptResponse(h, f);
    h.accept("ResearchChatResponseReceipt", result);
    return await expect(
      h.store.readResearchChatResponse(
        principal,
        scope,
        f.input.threadId,
        f.input.idempotencyKey
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("rejects a self-consistent receipt time before its owned thread existed", async () => {
    const f = await responseFixture();
    const at = "2026-09-22T12:00:00Z";
    const result = { ...f.result, recordedAt: at };
    const row = {
      ...f.row,
      result,
      committed_at: at,
      committed_at_ns: timestampToEpochNanoseconds(at).toString(),
      result_hash: await hash({ command: f.storedCommand, result }),
    };
    const h = harness([threadRead(f.thread.row), receiptRead(row)]);
    acceptResponse(h, f);
    h.accept("ResearchChatResponseReceipt", result);
    return await expect(
      h.store.readResearchChatResponse(
        principal,
        scope,
        f.input.threadId,
        f.input.idempotencyKey
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("requires authoritative input validators, rejects transforms and refuses extra request fields before DB work", async () => {
    const f = await responseFixture();
    const missing = harness([], false);
    await expect(
      missing.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "unavailable" });
    const h = harness();
    acceptResponse(h, f);
    await expect(
      h.store.requestResearchChatResponse({
        ...f.input,
        admission: null,
      } as never)
    ).rejects.toMatchObject({ code: "invalid" });
    h.validate.mockImplementationOnce(async (_name, value) => ({
      ...(value as VertexRecord),
      retrievalQuery: "normalized query",
    }));
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.calls).toEqual([]);
    return expect(missing.calls).toEqual([]);
  });
  return it("rejects transformed output boundaries without saving a different immutable acknowledgement", async () => {
    const f = await responseFixture();
    const h = harness([
      threadRead(f.thread.row),
      receiptRead(),
      contextRead(f.messages),
    ]);
    acceptResponse(h, f);
    h.validate.mockImplementation(async (name, value) => {
      if (name === "ResearchChatResponseReceipt")
        return {
          ...(value as VertexRecord),
          reasonCodes: ["policy-unavailable"],
        };
      return structuredClone(value) as VertexRecord;
    });
    await expect(
      h.store.requestResearchChatResponse(f.input)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(responseMutations(h)).toEqual([]);
  });
});
