import { readFileSync } from "node:fs";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { MAX_VERTEX_CHAT_COPY_BYTES } from "@darkfactory/storage/chat-copies";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type {
  VertexAuthorization,
  VertexBoundaryContractName,
  VertexRecord,
  VertexResearchChatInputName,
} from "./vertex-ports.ts";
import { createVertexStore } from "./vertex-repository.ts";
import type {
  VertexResearchChatCopyAllocation,
  VertexResearchChatCopyOperations,
} from "./vertex-research-chat-copy-ports.ts";

// Deterministic offline fake, NOT PostgreSQL/trigger/concurrency qualification.
// API fixtures reject every unregistered input/output; real public DTO coverage
// remains in the existing API tests. No network or storage transport is injected.
const NOW = "2026-09-24T18:00:00.000000001Z";
const principal = { actorId: "human-1" };
const cleaner = { actorId: "cleanup-service" };
const scope = {
  accountAlias: "research-room",
  environment: "research" as const,
};
const PROFILE = "a".repeat(64);
const CONTENT = { sha256: "b".repeat(64), byteLength: 17 };
const FAMILY = "vertex_research_chat_copy_families";
const ALLOCATION = "vertex_research_chat_copy_allocations";
const PIN = "vertex_research_chat_copy_content_bindings";
const EDGE = "vertex_research_chat_copy_dependencies";
const CLOSURE = "vertex_research_chat_copy_closures";
const INTENT = "vertex_research_chat_copy_cleanup_intents";
const COPY_TABLES = [FAMILY, ALLOCATION, PIN, EDGE, CLOSURE];
type Row = Record<string, unknown>;
type Reserve = Parameters<
  VertexResearchChatCopyOperations["reserveResearchChatCopy"]
>[0];
const hash = (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    return (release = resolve);
  });
  return { promise, release };
};
const harness = () => {
  let state = new Map<string, Row[]>();
  let queue: Promise<unknown> = Promise.resolve();
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
    throw new Error("No policy resolution permitted");
  });
  const controls: {
    beforeCommit: (() => Promise<void>) | null;
    loseAck: boolean;
    beforeQuery: ((table: string, result: Row[]) => Row[]) | null;
    beforeInsert: ((table: string, row: Row) => void) | null;
  } = {
    beforeCommit: null,
    loseAck: false,
    beforeQuery: null,
    beforeInsert: null,
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const lifecycle: string[] = [];
  const dialect = new PgDialect();
  const executeOn = async (draft: Map<string, Row[]>, fragment: SQL) => {
    const compiled = dialect.sqlToQuery(fragment);
    const text = compiled.sql;
    const params = compiled.params;
    calls.push({ sql: text, params });
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    const insertion = /^insert into "([a-z_]+)" \(([^)]+)\) values \(/.exec(
      text
    );
    if (insertion) {
      const table = insertion[1]!;
      const names = [...insertion[2]!.matchAll(/"([a-z_][a-z0-9_]*)"/g)].map(
        (match) => match[1]!
      );
      const row: Row = {};
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        const value = params[index];
        row[name] = [
          "payload",
          "command",
          "result",
          "request",
          "response",
        ].includes(name)
          ? JSON.parse(value as string)
          : value;
      }
      controls.beforeInsert?.(table, row);
      if (!draft.has(table)) draft.set(table, []);
      draft.get(table)!.push(row);
      return { rows: [] };
    }
    const selection = /^select \* from "([a-z_]+)"/.exec(text);
    if (!selection) throw new Error("Unexpected fake SQL");
    const table = selection[1]!;
    let result = [...(draft.get(table) ?? [])];
    for (const match of text.matchAll(
      /(?:"?)([a-z_]+)(?:"?)\s*(=|>=|<=|>)\s*\$(\d+)/g
    )) {
      const column = match[1]!;
      const operation = match[2]!;
      const value = params[Number(match[3]) - 1];
      result = result.filter((row) => {
        if (operation === "=") return row[column] === value;
        const left = BigInt(row[column] as string);
        const right = BigInt(value as string);
        return operation === ">="
          ? left >= right
          : operation === "<="
            ? left <= right
            : left > right;
      });
    }
    if (/order by sequence asc/.test(text))
      result.sort((a, b) =>
        BigInt(a["sequence"] as string) < BigInt(b["sequence"] as string)
          ? -1
          : 1
      );
    const limit = /limit (?:\$(\d+)|(\d+))/.exec(text);
    if (limit)
      result = result.slice(
        0,
        limit[1] ? Number(params[Number(limit[1]) - 1]) : Number(limit[2])
      );
    result = controls.beforeQuery?.(table, result) ?? result;
    return { rows: structuredClone(result) };
  };
  const transaction = vi.fn((operation: (tx: unknown) => Promise<unknown>) => {
    const next = queue.then(async () => {
      const draft = structuredClone(state);
      lifecycle.push("begin");
      let result: unknown;
      try {
        result = await operation({
          execute: (fragment: SQL) => executeOn(draft, fragment),
        });
        await controls.beforeCommit?.();
      } catch (error) {
        lifecycle.push("rollback");
        throw error;
      }
      state = draft;
      lifecycle.push("commit");
      if (controls.loseAck) {
        controls.loseAck = false;
        throw new Error("Synthetic commit acknowledgement unavailable");
      }
      return result;
    });
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  });
  const now = vi.fn(() => NOW);
  const store = createVertexStore({ transaction } as unknown as Database, {
    boundary: {
      encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
      digest: hashArtifact,
      validate,
      validateResearchChatInput: validate,
    },
    clock: { now },
    authorization: { authorize },
    maxProjectionAgeMs: 60_000,
    commandPolicy,
  });
  const table = (name: string): Row[] => {
    if (!state.has(name)) state.set(name, []);
    return state.get(name)!;
  };
  return {
    store,
    table,
    calls,
    lifecycle,
    controls,
    authorize,
    accept,
    validate,
    commandPolicy,
    now,
  };
};
type Harness = ReturnType<typeof harness>;
const fixture = async (count = 1) => {
  const h = harness();
  const command = {
    ...scope,
    title: "Synthetic human room",
    participantIds: ["expert-1"],
    idempotencyKey: "create-1",
  };
  const threadId = `chat-${await hash({ operation: "createThread", actorId: principal.actorId, scope, idempotencyKey: command.idempotencyKey })}`;
  const original = {
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
  const current = { ...original, revision: String(count + 1) };
  const threadRequest = {
    operation: "createThread",
    actorId: principal.actorId,
    input: command,
  };
  h.table("vertex_research_chat_threads").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    owner_actor_id: principal.actorId,
    thread_id: threadId,
    revision: current.revision,
    last_sequence: String(count),
    created_at: NOW,
    updated_at: NOW,
    payload: current,
    record_hash: await hash(current),
    idempotency_key: command.idempotencyKey,
    request: threadRequest,
    request_hash: await hash(threadRequest),
    response: original,
    response_hash: await hash(original),
  });
  h.accept("createThread", command);
  h.accept("ResearchChatThread", original);
  h.accept("ResearchChatThread", current);
  let parentMessageId = "";
  for (let sequence = 1; sequence <= count; sequence++) {
    const idempotencyKey = `send-${sequence}`;
    const messageCommand = {
      ...scope,
      threadId,
      expectedRevision: String(sequence),
      idempotencyKey,
      body: "PRIVATE-HUMAN-BODY-SENTINEL",
      requestedParticipantIds: [],
      mode: "discuss",
    };
    parentMessageId = `message-${await hash({ operation: "sendMessage", actorId: principal.actorId, scope, threadId, idempotencyKey })}`;
    const message = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      threadId,
      messageId: parentMessageId,
      sequence: String(sequence),
      author: { kind: "user", actorId: principal.actorId },
      kind: "statement",
      body: messageCommand.body,
      citations: [],
      recordedAt: NOW,
    };
    const response = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      message,
      threadRevision: String(sequence + 1),
      response: {
        status: "not-requested",
        runId: null,
        jobId: null,
        reasonCodes: [],
      },
    };
    const requested = {
      operation: "sendMessage",
      actorId: principal.actorId,
      input: messageCommand,
    };
    h.table("vertex_research_chat_messages").push({
      account_alias: scope.accountAlias,
      environment: scope.environment,
      owner_actor_id: principal.actorId,
      thread_id: threadId,
      message_id: parentMessageId,
      sequence: String(sequence),
      recorded_at: NOW,
      idempotency_key: idempotencyKey,
      request: requested,
      request_hash: await hash(requested),
      payload: message,
      record_hash: await hash(message),
      response,
      response_hash: await hash(response),
    });
    h.accept("sendMessage", messageCommand);
    h.accept("ResearchChatMessage", message);
    h.accept("ResearchChatSendMessageOutput", response);
  }
  const request = {
    ...scope,
    threadId,
    parentMessageId,
    participantId: "expert-1",
    snapshotRevision: String(count + 1),
    contextStartSequence: "1",
    retrievalQuery: "PRIVATE-RETRIEVAL-QUERY-SENTINEL",
    idempotencyKey: "response-1",
  };
  h.accept("requestResponse", request);
  const input: Reserve = {
    principal,
    scope,
    request,
    kind: "context",
    copyIdempotencyKey: "context-1",
    storageProfileSha256: PROFILE,
    maximumBytes: 100,
    parentCopyIds: [],
  };
  return { h, input, request, threadId };
};
const bind = (
  h: Harness,
  allocation: VertexResearchChatCopyAllocation,
  content = CONTENT
) =>
  h.store.bindResearchChatCopyContent({
    principal,
    scope,
    responseRequestId: allocation.responseRequestId,
    copyId: allocation.copyId,
    content,
  });
const cleanup = (h: Harness, allocation: VertexResearchChatCopyAllocation) =>
  h.store.closeResearchChatCopyFamily({
    principal: cleaner,
    scope,
    responseRequestId: allocation.responseRequestId,
  });
const inventory = (h: Harness, allocation: VertexResearchChatCopyAllocation) =>
  h.store.readResearchChatCopyInventory(
    cleaner,
    scope,
    allocation.responseRequestId
  );
const child = (
  input: Reserve,
  parent: VertexResearchChatCopyAllocation,
  key = "model-1"
): Reserve => ({
  ...input,
  kind: "model-input",
  copyIdempotencyKey: key,
  parentCopyIds: [parent.copyId],
});
const copyWrites = (h: Harness) =>
  h.calls.filter((call) =>
    /^insert into "vertex_research_chat_copy_/.test(call.sql)
  );
const rewriteParents = async (
  row: Row,
  parents: readonly string[]
): Promise<void> => {
  const old = row["payload"] as VertexResearchChatCopyAllocation;
  const {
    reservationSha256: _sha,
    reservedAt,
    binding,
    objectKey,
    ...oldBase
  } = old;
  const base = { ...oldBase, parentCopyIds: parents };
  const reservationSha256 = await hash(base);
  const allocation = {
    ...base,
    reservationSha256,
    reservedAt,
    binding: { ...binding, reservationSha256 },
    objectKey,
  };
  row["reservation_sha256"] = reservationSha256;
  row["payload"] = allocation;
  row["record_hash"] = await hash(allocation);
};

describe("exclusive copy inventory metadata, never a content grant", () => {
  it("wires four operations into the actual store without construction I/O", () => {
    const h = harness();
    for (const name of [
      "reserveResearchChatCopy",
      "bindResearchChatCopyContent",
      "closeResearchChatCopyFamily",
      "readResearchChatCopyInventory",
    ] as const)
      expect(typeof h.store[name]).toBe("function");
    expect(h.calls).toEqual([]);
    expect(h.now).not.toHaveBeenCalled();
    return expect(h.authorize).not.toHaveBeenCalled();
  });
  it("commits metadata before returning and stores no query/body, authority or physical observation", async () => {
    const { h, input } = await fixture();
    const entered = gate();
    const release = gate();
    h.controls.beforeCommit = async () => {
      entered.release();
      return await release.promise;
    };
    let returned = false;
    const pending = h.store.reserveResearchChatCopy(input).then((result) => {
      returned = true;
      return result;
    });
    await Promise.race([entered.promise, pending.then(() => undefined)]);
    expect(returned).toBe(false);
    expect(h.table(ALLOCATION)).toEqual([]);
    release.release();
    const allocation = await pending;
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(allocation.binding.content).toBeNull();
    expect(Object.isFrozen(allocation)).toBe(true);
    expect(Object.isFrozen(allocation.parentCopyIds)).toBe(true);
    const persisted = JSON.stringify(copyWrites(h));
    for (const prohibited of [
      "PRIVATE-HUMAN-BODY-SENTINEL",
      "PRIVATE-RETRIEVAL-QUERY-SENTINEL",
      "retrievalQuery",
      "executionAuthorized",
      "ready",
      "jobId",
      "corpusSha",
      "consent",
    ])
      expect(persisted).not.toContain(prohibited);
    expect(h.commandPolicy).not.toHaveBeenCalled();
    return expect(
      h.calls
        .filter((call) => call.sql.includes("pg_advisory_xact_lock"))
        .map((call) => call.params[0])
    ).toEqual([
      "vertex-authorization:global",
      JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment]),
      JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
    ]);
  });
  it("reconciles lost commit ACK using exactly the same original allocation", async () => {
    const { h, input } = await fixture();
    h.controls.loseAck = true;
    await expect(h.store.reserveResearchChatCopy(input)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(h.table(ALLOCATION)).toHaveLength(1);
    const original = structuredClone(h.table(ALLOCATION)[0]!["payload"]);
    const retry = await h.store.reserveResearchChatCopy(input);
    expect(retry).toEqual(original);
    expect(h.table(FAMILY)).toHaveLength(1);
    expect(h.table(ALLOCATION)).toHaveLength(1);
    return expect((await inventory(h, retry))?.copies[0]?.allocation).toEqual(
      original
    );
  });
  it("captures all caller-owned values before await and retains a null-content original allocation ACK", async () => {
    const { h, input } = await fixture();
    const mutable = structuredClone(input) as {
      principal: { actorId: string };
      scope: { accountAlias: string; environment: "research" };
      request: Record<string, unknown>;
      kind: "context";
      copyIdempotencyKey: string;
      storageProfileSha256: string;
      maximumBytes: number;
      parentCopyIds: string[];
    };
    const pending = h.store.reserveResearchChatCopy(mutable);
    mutable.principal.actorId = "other";
    mutable.scope.accountAlias = "other";
    mutable.request["retrievalQuery"] = "changed after capture";
    mutable.parentCopyIds.push(`chat-copy-${"c".repeat(64)}`);
    const original = await pending;
    const pin = await bind(h, original);
    expect(pin.content).toEqual(CONTENT);
    expect(await h.store.reserveResearchChatCopy(input)).toEqual(original);
    expect((await inventory(h, original))?.copies[0]?.contentBinding).toEqual(
      pin
    );
    return expect(original.binding.content).toBeNull();
  });
  it.each([
    "maximumBytes",
    "storageProfileSha256",
    "request",
    "parentCopyIds",
  ] as const)(
    "conflicts on changed %s under the same logical identity",
    async (field) => {
      const { h, input } = await fixture();
      await h.store.reserveResearchChatCopy(input);
      const changed = {
        ...input,
        [field]:
          field === "maximumBytes"
            ? 101
            : field === "storageProfileSha256"
              ? "c".repeat(64)
              : field === "parentCopyIds"
                ? [`chat-copy-${"c".repeat(64)}`]
                : {
                    ...input.request,
                    retrievalQuery: "different literal query",
                  },
      };
      if (field === "request") h.accept("requestResponse", changed.request);
      await expect(
        h.store.reserveResearchChatCopy(changed)
      ).rejects.toMatchObject({ code: "conflict" });
      return expect(h.table(ALLOCATION)).toHaveLength(1);
    }
  );
  it("returns exact content pins, conflicts on changed pins and cannot bind beyond allocation", async () => {
    const { h, input } = await fixture();
    const allocation = await h.store.reserveResearchChatCopy(input);
    const pin = await bind(h, allocation);
    h.now.mockReturnValue("2026-09-24T18:01:00Z");
    expect(await bind(h, allocation)).toEqual(pin);
    await expect(
      bind(h, allocation, { ...CONTENT, sha256: "c".repeat(64) })
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      bind(h, allocation, { ...CONTENT, byteLength: 101 })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.table(PIN)).toHaveLength(1);
    return expect(Object.keys(pin).sort()).toEqual([
      "boundAt",
      "content",
      "copyId",
      "profile",
      "reservationSha256",
      "responseRequestId",
      "scope",
    ]);
  });
  it("keeps committed content pins discoverable after lost ACK, without claiming body existence", async () => {
    const { h, input } = await fixture();
    const allocation = await h.store.reserveResearchChatCopy(input);
    h.controls.loseAck = true;
    await expect(bind(h, allocation)).rejects.toMatchObject({
      code: "unavailable",
    });
    const original = structuredClone(h.table(PIN)[0]!["payload"]);
    expect(await bind(h, allocation)).toEqual(original);
    expect(h.table(PIN)).toHaveLength(1);
    return expect(
      (await inventory(h, allocation))?.copies[0]?.contentBinding
    ).toEqual(original);
  });
  it("requires every declared parent pin before binding and accepts an exclusive context/model/output DAG", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const model = await h.store.reserveResearchChatCopy(child(input, root));
    await expect(bind(h, model)).rejects.toMatchObject({ code: "conflict" });
    await bind(h, root);
    await bind(h, model);
    const output = await h.store.reserveResearchChatCopy({
      ...input,
      kind: "derived-output",
      copyIdempotencyKey: "output-1",
      parentCopyIds: [root.copyId, model.copyId].sort(),
    });
    await bind(h, output);
    expect(h.table(EDGE)).toHaveLength(3);
    const closed = await cleanup(h, root);
    expect(closed.copies).toHaveLength(3);
    expect(closed.closure?.copyIds).toEqual(
      [root.copyId, model.copyId, output.copyId].sort()
    );
    return expect(closed.closure?.inventorySha256).toBe(
      await hash({ family: closed.family, copies: closed.copies })
    );
  });
  it.each([
    "missing",
    "foreign",
    "self",
    "duplicate",
    "unsorted",
    "context-parent",
    "derived-parent",
    "derived-without-model",
  ])("rejects invalid %s dependency declaration", async (scenario) => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const model = await h.store.reserveResearchChatCopy(child(input, root));
    const output = await h.store.reserveResearchChatCopy({
      ...input,
      kind: "derived-output",
      copyIdempotencyKey: "output",
      parentCopyIds: [model.copyId],
    });
    let changed: Reserve = child(input, root, "next");
    if (scenario === "missing") changed = { ...changed, parentCopyIds: [] };
    if (scenario === "foreign")
      changed = { ...changed, parentCopyIds: [`chat-copy-${"f".repeat(64)}`] };
    if (scenario === "self") {
      const self = `chat-copy-${await hash({ operation: "reserveResearchChatCopy", actorId: principal.actorId, scope, threadId: root.threadId, responseRequestId: root.responseRequestId, kind: changed.kind, copyIdempotencyKey: changed.copyIdempotencyKey })}`;
      changed = { ...changed, parentCopyIds: [self] };
    }
    if (scenario === "duplicate")
      changed = { ...changed, parentCopyIds: [root.copyId, root.copyId] };
    if (scenario === "unsorted")
      changed = {
        ...changed,
        parentCopyIds: [root.copyId, model.copyId].sort().reverse(),
      };
    if (scenario === "context-parent")
      changed = { ...changed, kind: "context" };
    if (scenario === "derived-parent")
      changed = { ...changed, parentCopyIds: [output.copyId] };
    if (scenario === "derived-without-model")
      changed = { ...changed, kind: "derived-output" };
    await expect(
      h.store.reserveResearchChatCopy(changed)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.table(ALLOCATION)).toHaveLength(3);
  });
  it("accepts an old bounded valid human prefix and retries before new-prefix checks", async () => {
    const { h, input } = await fixture(3);
    const messages = h.table("vertex_research_chat_messages");
    const request = {
      ...input.request,
      snapshotRevision: "2",
      parentMessageId: messages[0]!["message_id"],
    };
    h.accept("requestResponse", request);
    const old = { ...input, request };
    const original = await h.store.reserveResearchChatCopy(old);
    h.table("vertex_research_chat_messages").splice(0);
    const queryCount = h.calls.filter((call) =>
      call.sql.includes('from "vertex_research_chat_messages"')
    ).length;
    expect(await h.store.reserveResearchChatCopy(old)).toEqual(original);
    return expect(
      h.calls.filter((call) =>
        call.sql.includes('from "vertex_research_chat_messages"')
      )
    ).toHaveLength(queryCount);
  });
  it.each(["future", "gapped", "foreign", "agent", "member", "parent"])(
    "rejects a new %s prefix",
    async (scenario) => {
      const { h, input } = await fixture(2);
      const request = { ...input.request };
      if (scenario === "future") request["snapshotRevision"] = "4";
      if (scenario === "member") request["participantId"] = "not-selected";
      if (scenario === "parent") request["parentMessageId"] = "not-parent";
      if (scenario === "gapped")
        h.table("vertex_research_chat_messages").splice(0, 1);
      if (scenario === "foreign")
        h.table("vertex_research_chat_messages")[0]!["owner_actor_id"] =
          "other";
      if (scenario === "agent") {
        const row = h.table("vertex_research_chat_messages")[0]!;
        const payload = {
          ...(row["payload"] as Row),
          author: { kind: "agent", participantId: "expert-1" },
        };
        row["payload"] = payload;
        row["record_hash"] = await hash(payload);
        h.accept("ResearchChatMessage", payload);
      }
      h.accept("requestResponse", request);
      await expect(
        h.store.reserveResearchChatCopy({ ...input, request })
      ).rejects.toMatchObject({
        code: ["future", "member", "parent"].includes(scenario)
          ? "invalid"
          : "integrity",
      });
      return expect(h.table(FAMILY)).toHaveLength(0);
    }
  );
  it.each(["read", "publish"] as const)(
    "rechecks current %s authorization before original allocation or pin existence",
    async (action) => {
      const { h, input } = await fixture();
      const original = await h.store.reserveResearchChatCopy(input);
      await bind(h, original);
      h.calls.length = 0;
      h.authorize.mockImplementation(
        async (request) => request.action !== action
      );
      await expect(
        h.store.reserveResearchChatCopy(input)
      ).rejects.toMatchObject({ code: "denied" });
      await expect(bind(h, original)).rejects.toMatchObject({ code: "denied" });
      return expect(
        h.calls.some((call) =>
          call.sql.includes('from "vertex_research_chat_copy_')
        )
      ).toBe(false);
    }
  );
  it("checks owned thread before allocation lookup and masks other owner bind existence", async () => {
    const { h, input } = await fixture();
    const original = await h.store.reserveResearchChatCopy(input);
    h.table("vertex_research_chat_threads")[0]!["owner_actor_id"] = "other";
    h.calls.length = 0;
    await expect(h.store.reserveResearchChatCopy(input)).rejects.toMatchObject({
      code: "denied",
    });
    await expect(bind(h, original)).rejects.toMatchObject({ code: "denied" });
    expect(
      h.calls.some((call) =>
        call.sql.includes('from "vertex_research_chat_copy_allocations"')
      )
    ).toBe(false);
    return await expect(
      h.store.bindResearchChatCopyContent({
        principal: { actorId: "other" },
        scope,
        responseRequestId: original.responseRequestId,
        copyId: original.copyId,
        content: CONTENT,
      })
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("closes and reads using only current exact dedicated cleanup grants without transcript access", async () => {
    const { h, input } = await fixture();
    const original = await h.store.reserveResearchChatCopy(input);
    await bind(h, original);
    h.calls.length = 0;
    h.authorize.mockClear();
    h.authorize.mockImplementation(
      async (request) =>
        request.action === "cleanup-chat-copies" &&
        request.resourceId ===
          `research-chat-copies:${original.responseRequestId}` &&
        request.principal.actorId === cleaner.actorId &&
        request.collectionId === null
    );
    h.controls.beforeQuery = (table, result) => {
      if (!COPY_TABLES.includes(table))
        throw new Error("Cleanup must not read human or processing state");
      return result;
    };
    const closed = await cleanup(h, original);
    expect(await inventory(h, original)).toEqual(closed);
    expect(
      h.authorize.mock.calls.every(
        ([request]) =>
          request.action === "cleanup-chat-copies" &&
          request.collectionId === null &&
          request.resourceId ===
            `research-chat-copies:${original.responseRequestId}` &&
          request.scope.accountAlias === scope.accountAlias &&
          request.scope.environment === "research"
      )
    ).toBe(true);
    expect(h.commandPolicy).not.toHaveBeenCalled();
    return expect(
      h.calls.some((call) =>
        /vertex_(worker|command_receipts|research_chat_threads|research_chat_messages)/.test(
          call.sql
        )
      )
    ).toBe(false);
  });
  it("retains original closure across authorized actors and lost ACK, but closed mutation retries always conflict", async () => {
    const { h, input } = await fixture();
    const original = await h.store.reserveResearchChatCopy(input);
    await bind(h, original);
    h.controls.loseAck = true;
    await expect(cleanup(h, original)).rejects.toMatchObject({
      code: "unavailable",
    });
    const closure = structuredClone(h.table(CLOSURE)[0]!["payload"]);
    const retry = await h.store.closeResearchChatCopyFamily({
      principal: { actorId: "other-cleaner" },
      scope,
      responseRequestId: original.responseRequestId,
    });
    expect(retry.closure).toEqual(closure);
    expect(h.table(CLOSURE)).toHaveLength(1);
    await expect(h.store.reserveResearchChatCopy(input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(bind(h, original)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      h.store.reserveResearchChatCopy(child(input, original))
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.table(ALLOCATION)).toHaveLength(1);
    return expect(
      h.calls.some((call) => /^(update|delete)/i.test(call.sql))
    ).toBe(false);
  });
  it.each(["read", "publish", "manage-rights", "dispatch-outbox"])(
    "does not turn %s or any role into cleanup permission",
    async (allowed) => {
      const { h, input } = await fixture();
      const allocation = await h.store.reserveResearchChatCopy(input);
      h.authorize.mockImplementation(
        async (request) => request.action === allowed
      );
      h.calls.length = 0;
      await expect(cleanup(h, allocation)).rejects.toMatchObject({
        code: "denied",
      });
      await expect(inventory(h, allocation)).rejects.toMatchObject({
        code: "denied",
      });
      return expect(h.calls).toEqual([]);
    }
  );
  it("rechecks cleanup grant after lock acquisition and does not leak missing inventory", async () => {
    const { h, input } = await fixture();
    const allocation = await h.store.reserveResearchChatCopy(input);
    h.authorize.mockReset();
    h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    h.calls.length = 0;
    await expect(cleanup(h, allocation)).rejects.toMatchObject({
      code: "denied",
    });
    expect(
      h.calls.every((call) => call.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
    h.authorize.mockResolvedValue(true);
    expect(
      await h.store.readResearchChatCopyInventory(
        cleaner,
        scope,
        `response-${"f".repeat(64)}`
      )
    ).toBeNull();
    return await expect(
      h.store.closeResearchChatCopyFamily({
        principal: cleaner,
        scope,
        responseRequestId: `response-${"f".repeat(64)}`,
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it.each(["reserve", "bind"])(
    "serializes delayed stale %s behind closure without attaching new metadata",
    async (operation) => {
      const { h, input } = await fixture();
      const original = await h.store.reserveResearchChatCopy(input);
      const entered = gate();
      const release = gate();
      let waitOnce = true;
      h.authorize.mockImplementation(async (request) => {
        if (request.action === "publish" && waitOnce) {
          waitOnce = false;
          entered.release();
          await release.promise;
        }
        return true;
      });
      const stale =
        operation === "reserve"
          ? h.store.reserveResearchChatCopy(child(input, original))
          : bind(h, original);
      const rejection = expect(stale).rejects.toMatchObject({
        code: "conflict",
      });
      await entered.promise;
      const closed = await cleanup(h, original);
      release.release();
      await rejection;
      expect(await inventory(h, original)).toEqual(closed);
      expect(h.table(ALLOCATION)).toHaveLength(1);
      expect(h.table(PIN)).toHaveLength(0);
      return expect(h.table(EDGE)).toHaveLength(0);
    }
  );
  it.each(["reserve", "bind"])(
    "includes a committing %s ahead of closure in the complete serialized inventory",
    async (operation) => {
      const { h, input } = await fixture();
      const original = await h.store.reserveResearchChatCopy(input);
      const entered = gate();
      const release = gate();
      h.controls.beforeCommit = async () => {
        h.controls.beforeCommit = null;
        entered.release();
        return await release.promise;
      };
      const mutation =
        operation === "reserve"
          ? h.store.reserveResearchChatCopy(child(input, original))
          : bind(h, original);
      await entered.promise;
      const closing = cleanup(h, original);
      release.release();
      await mutation;
      const closed = await closing;
      expect(closed.copies).toHaveLength(operation === "reserve" ? 2 : 1);
      if (operation === "bind")
        expect(closed.copies[0]?.contentBinding?.content).toEqual(CONTENT);
      return expect(closed.closure?.inventorySha256).toBe(
        await hash({ family: closed.family, copies: closed.copies })
      );
    }
  );
  it.each([
    "missing-edge",
    "extra-edge",
    "duplicate-edge",
    "foreign-edge",
    "orphan-edge",
    "cycle",
    "shared-key",
    "pin-column",
    "family-column",
    "allocation-hash",
    "closure-digest",
    "missing-family",
    "orphan-pin",
    "missing-parent-pin",
    "extra-payload-key",
    "timestamp-column",
  ])("fails closed on %s metadata tampering", async (scenario) => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const model = await h.store.reserveResearchChatCopy(child(input, root));
    const next = await h.store.reserveResearchChatCopy(
      child(input, model, "next-model")
    );
    if (scenario === "closure-digest") await cleanup(h, root);
    if (scenario === "missing-edge") h.table(EDGE).splice(0, 1);
    if (scenario === "extra-edge")
      h.table(EDGE).push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        response_request_id: root.responseRequestId,
        child_copy_id: next.copyId,
        parent_copy_id: root.copyId,
      });
    if (scenario === "duplicate-edge")
      h.table(EDGE).push(structuredClone(h.table(EDGE)[0]!));
    if (scenario === "foreign-edge")
      h.controls.beforeQuery = (table, result) =>
        table === EDGE
          ? [...result, { ...result[0], account_alias: "other" }]
          : result;
    if (scenario === "orphan-edge")
      h.table(EDGE)[0]!["parent_copy_id"] = `chat-copy-${"f".repeat(64)}`;
    if (scenario === "cycle") {
      await rewriteParents(
        h.table(ALLOCATION).find((row) => row["copy_id"] === model.copyId)!,
        [next.copyId]
      );
      h.table(EDGE).find((row) => row["child_copy_id"] === model.copyId)![
        "parent_copy_id"
      ] = next.copyId;
    }
    if (scenario === "shared-key")
      h.table(ALLOCATION)[1]!["object_key"] = root.objectKey;
    if (scenario === "pin-column") {
      await bind(h, root);
      h.table(PIN)[0]!["byte_length"] = 18;
    }
    if (scenario === "family-column")
      h.table(FAMILY)[0]!["owner_actor_id"] = "other";
    if (scenario === "missing-family") h.table(FAMILY).splice(0);
    if (scenario === "orphan-pin") {
      await bind(h, root);
      const row = h.table(PIN)[0]!;
      row["copy_id"] = `chat-copy-${"f".repeat(64)}`;
      row["payload"] = { ...(row["payload"] as Row), copyId: row["copy_id"] };
      row["record_hash"] = await hash(row["payload"]);
    }
    if (scenario === "missing-parent-pin") {
      await bind(h, root);
      await bind(h, model);
      h.table(PIN).splice(
        h.table(PIN).findIndex((row) => row["copy_id"] === root.copyId),
        1
      );
    }
    if (scenario === "extra-payload-key") {
      const row = h.table(FAMILY)[0]!;
      row["payload"] = { ...(row["payload"] as Row), body: "FORBIDDEN-BODY" };
      row["record_hash"] = await hash(row["payload"]);
    }
    if (scenario === "timestamp-column")
      h.table(ALLOCATION)[0]!["reserved_at_ns"] = "1";
    if (scenario === "allocation-hash")
      h.table(ALLOCATION)[0]!["record_hash"] = "f".repeat(64);
    if (scenario === "closure-digest") {
      const row = h.table(CLOSURE)[0]!;
      row["payload"] = {
        ...(row["payload"] as Row),
        inventorySha256: "f".repeat(64),
      };
      row["inventory_sha256"] = "f".repeat(64);
      row["record_hash"] = await hash(row["payload"]);
    }
    await expect(inventory(h, root)).rejects.toMatchObject({
      code: "integrity",
    });
    return await expect(cleanup(h, root)).rejects.toMatchObject({
      code: "integrity",
    });
  });
  it.each([FAMILY, ALLOCATION, PIN, EDGE, CLOSURE])(
    "rejects over-bound %s results instead of truncating",
    async (table) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const ceiling =
        table === EDGE ? 2016 : [FAMILY, CLOSURE].includes(table) ? 1 : 64;
      h.controls.beforeQuery = (name, result) =>
        name === table
          ? Array.from({ length: ceiling + 1 }, () => result[0] ?? {})
          : result;
      return await expect(inventory(h, root)).rejects.toMatchObject({
        code: "integrity",
      });
    }
  );
  // 66 sequential locked reservations exceed the 5 s default on a loaded CI runner.
  it("enforces total reserved capacity and the 64 allocation domain under the same lock", async () => {
    const f = await fixture();
    await f.h.store.reserveResearchChatCopy({
      ...f.input,
      maximumBytes: MAX_VERTEX_CHAT_COPY_BYTES,
    });
    await expect(
      f.h.store.reserveResearchChatCopy({
        ...f.input,
        copyIdempotencyKey: "overflow",
        maximumBytes: 1,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    const { h, input } = await fixture();
    for (let index = 0; index < 64; index++)
      await h.store.reserveResearchChatCopy({
        ...input,
        copyIdempotencyKey: `copy-${index}`,
        maximumBytes: 1,
      });
    await expect(
      h.store.reserveResearchChatCopy({
        ...input,
        copyIdempotencyKey: "copy-64",
        maximumBytes: 1,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.table(ALLOCATION)).toHaveLength(64);
  }, 20_000);
  it.each([
    "principal-newline",
    "scope-newline",
    "query",
    "id-newline",
    "sha-newline",
    "response-newline",
    "scope-disagreement",
    "paper",
    "extra",
    "getter",
    "sparse",
    "zero",
    "unsafe",
    "oversize",
  ])("rejects strict %s input before persistence", async (scenario) => {
    const { h, input } = await fixture();
    const changed = structuredClone(input) as Record<string, unknown>;
    if (scenario === "principal-newline")
      changed["principal"] = { actorId: "human-1\n" };
    if (scenario === "scope-newline")
      changed["scope"] = { ...scope, accountAlias: "research-room\n" };
    if (scenario === "query")
      changed["request"] = { ...input.request, retrievalQuery: "short" };
    if (scenario === "id-newline") changed["copyIdempotencyKey"] = "key\n";
    if (scenario === "sha-newline")
      changed["storageProfileSha256"] = `${PROFILE}\n`;
    if (scenario === "scope-disagreement")
      changed["request"] = { ...input.request, accountAlias: "other" };
    if (scenario === "paper")
      changed["scope"] = { ...scope, environment: "paper" };
    if (scenario === "extra") changed["authorized"] = true;
    if (scenario === "getter")
      Object.defineProperty(changed, "maximumBytes", {
        enumerable: true,
        get: () => 100,
      });
    if (scenario === "sparse") changed["parentCopyIds"] = new Array(2);
    if (scenario === "zero") changed["maximumBytes"] = 0;
    if (scenario === "unsafe")
      changed["maximumBytes"] = Number.MAX_SAFE_INTEGER + 1;
    if (scenario === "oversize")
      changed["maximumBytes"] = MAX_VERTEX_CHAT_COPY_BYTES + 1;
    const operation =
      scenario === "response-newline"
        ? h.store.readResearchChatCopyInventory(
            cleaner,
            scope,
            `response-${"a".repeat(64)}\n`
          )
        : h.store.reserveResearchChatCopy(changed as unknown as Reserve);
    await expect(operation).rejects.toMatchObject({ code: "invalid" });
    return expect(h.calls).toEqual([]);
  });
  it("settled original unavailable response blocks reserve/bind but cannot block independently authorized cleanup", async () => {
    const { h, input, request } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const changedRequest = {
      ...request,
      retrievalQuery: "A different settled literal query",
    };
    h.accept("requestResponse", changedRequest);
    const requestSha256 = await hash({
      operation: "requestResponse",
      actorId: principal.actorId,
      input: changedRequest,
    });
    const { retrievalQuery: _query, ...metadata } = changedRequest;
    const receipt = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      ...scope,
      threadId: request.threadId,
      ownerActorId: principal.actorId,
      responseRequestId: root.responseRequestId,
      parentMessageId: request.parentMessageId,
      participantId: request.participantId,
      idempotencyKey: request.idempotencyKey,
      requestSha256,
      recordedAt: NOW,
      snapshotRevision: request.snapshotRevision,
      contextStartSequence: request.contextStartSequence,
      status: "unavailable",
      reasonCodes: ["research-runtime-unavailable"],
      admission: null,
      jobId: null,
    };
    h.accept("ResearchChatResponseReceipt", receipt);
    const legacy = {
      principal,
      scope,
      threadId: changedRequest.threadId,
      parentMessageId: changedRequest.parentMessageId,
      participantId: changedRequest.participantId,
      snapshotRevision: changedRequest.snapshotRevision,
      contextStartSequence: changedRequest.contextStartSequence,
      retrievalQuery: changedRequest.retrievalQuery,
      idempotencyKey: changedRequest.idempotencyKey,
    };
    const before = h.calls.length;
    expect(await h.store.requestResearchChatResponse(legacy)).toEqual(receipt);
    expect(
      h.calls
        .slice(before)
        .some((call) => call.sql.includes("vertex_research_chat_copy_"))
    ).toBe(false);
    h.table("vertex_research_chat_messages").splice(0);
    expect(await h.store.requestResearchChatResponse(legacy)).toEqual(receipt);
    await expect(h.store.reserveResearchChatCopy(input)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(bind(h, root)).rejects.toMatchObject({ code: "conflict" });
    const closed = await cleanup(h, root);
    expect(closed.family.requestSha256).not.toBe(requestSha256);
    expect(await inventory(h, root)).toEqual(closed);
    expect(metadata).not.toHaveProperty("retrievalQuery");
    return expect(h.table("vertex_command_receipts")).toHaveLength(1);
  });
  it("keeps scope and exact-family cleanup authority separate even for service actors", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    h.authorize.mockImplementation(
      async (request) =>
        request.action === "cleanup-chat-copies" &&
        request.resourceId ===
          `research-chat-copies:${root.responseRequestId}` &&
        request.scope.accountAlias === scope.accountAlias &&
        request.principal.actorId === cleaner.actorId
    );
    h.calls.length = 0;
    await expect(
      h.store.readResearchChatCopyInventory(
        cleaner,
        { ...scope, accountAlias: "other" },
        root.responseRequestId
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.readResearchChatCopyInventory(
        cleaner,
        scope,
        `response-${"f".repeat(64)}`
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.readResearchChatCopyInventory(
        principal,
        scope,
        root.responseRequestId
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.calls).toEqual([]);
    return expect((await inventory(h, root))?.family.responseRequestId).toBe(
      root.responseRequestId
    );
  });
  return it("authors only forward metadata/action SQL with exact JSON checks and immutable tombstones", () => {
    const source = readFileSync(
      new URL("./vertex-research-chat-copy-store.ts", import.meta.url),
      "utf8"
    );
    const migration = readFileSync(
      new URL(
        "../../migrations/0012_vertex_research_chat_copy_inventory.sql",
        import.meta.url
      ),
      "utf8"
    );
    const schema = readFileSync(
      new URL("../schema/vertex-research-chat-copies.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(
      /from ["'][^"']*(r2|provider|worker|controller)/
    );
    expect(source).not.toMatch(
      /\b(fetch|putObject|deleteObject|fenceCopy|issueGrant)\s*\(/
    );
    expect(migration).not.toMatch(/^\s*(GRANT|TRUNCATE)\s/im);
    expect(migration).toContain("'cleanup-chat-copies'");
    for (const table of COPY_TABLES)
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    for (const suffix of ["family", "allocation", "content", "closure"]) {
      expect(migration).toContain(`"vertex_copy_${suffix}_payload" CHECK ((`);
      // Formatter-independent: Biome may wrap the check() arguments.
      expect(schema).toMatch(
        new RegExp(`check\\(\\s*"vertex_copy_${suffix}_payload",\\s*sql\``)
      );
    }
    expect((migration.match(/BEFORE UPDATE OR DELETE/g) ?? []).length).toBe(5);
    return expect(source).not.toMatch(
      /\b(update|delete) vertex_research_chat_copy_/
    );
  });
});

type Cleanup = Parameters<
  VertexResearchChatCopyOperations["requestResearchChatCopyCleanup"]
>[0];
const cleanupFixture = async (
  h: Harness,
  allocation: VertexResearchChatCopyAllocation,
  idempotencyKey = "cleanup-1",
  recordedAt = NOW
) => {
  const command = {
    ...scope,
    threadId: allocation.threadId,
    responseRequestId: allocation.responseRequestId,
    idempotencyKey,
  };
  const requestSha256 = await hash({
    operation: "requestCopyCleanup",
    actorId: principal.actorId,
    input: command,
  });
  const receipt = {
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    status: "requested",
    ...command,
    ownerActorId: principal.actorId,
    cleanupRequestId: `copy-cleanup-${requestSha256}`,
    requestSha256,
    recordedAt,
    targetKinds: ["context", "model-input", "derived-output"],
  };
  h.accept("requestCopyCleanup", command);
  h.accept("readCopyCleanup", command);
  h.accept("ResearchChatCopyCleanupReceipt", receipt);
  const request: Cleanup = {
    principal,
    scope,
    threadId: allocation.threadId,
    responseRequestId: allocation.responseRequestId,
    idempotencyKey,
  };
  const read = () =>
    h.store.readResearchChatCopyCleanup(
      principal,
      scope,
      command.threadId,
      command.responseRequestId,
      command.idempotencyKey
    );
  return { request, command, receipt, read };
};

describe("durable explicit cleanup intent, never physical cleanup state", () => {
  it("keeps account request/read owner-bound after the private service verifier extraction", async () => {
    const { h, input } = await fixture();
    const allocation = await h.store.reserveResearchChatCopy(input);
    const expected = await cleanupFixture(h, allocation);
    const original = await h.store.requestResearchChatCopyCleanup(
      expected.request
    );
    const writes = copyWrites(h).length;
    // Even an exact resource grant for the cleaner cannot impersonate the
    // original account owner or originate another account's explicit intent.
    await expect(
      h.store.readResearchChatCopyCleanup(
        cleaner,
        scope,
        allocation.threadId,
        allocation.responseRequestId,
        expected.command.idempotencyKey
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.requestResearchChatCopyCleanup({
        ...expected.request,
        principal: cleaner,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(await expected.read()).toEqual(original);
    expect(original["status"]).toBe("requested");
    expect(original["executionAuthorized"]).toBe(false);
    return expect(copyWrites(h)).toHaveLength(writes);
  });
  it("adds request/read to the real store without construction I/O", () => {
    const h = harness();
    expect(typeof h.store.requestResearchChatCopyCleanup).toBe("function");
    expect(typeof h.store.readResearchChatCopyCleanup).toBe("function");
    expect(h.calls).toEqual([]);
    return expect(h.now).not.toHaveBeenCalled();
  });
  it("commits a complete all-kind closure and separate immutable intent in one transaction before ACK", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const model = await h.store.reserveResearchChatCopy(child(input, root));
    const output = await h.store.reserveResearchChatCopy({
      ...input,
      kind: "derived-output",
      copyIdempotencyKey: "output-cleanup",
      parentCopyIds: [model.copyId],
    });
    await bind(h, root);
    await bind(h, model);
    await bind(h, output);
    const originalAllocations = structuredClone(h.table(ALLOCATION));
    const originalPins = structuredClone(h.table(PIN));
    const f = await cleanupFixture(h, root);
    const entered = gate();
    const release = gate();
    h.controls.beforeCommit = async () => {
      entered.release();
      return await release.promise;
    };
    h.lifecycle.length = 0;
    h.calls.length = 0;
    let returned = false;
    const pending = h.store
      .requestResearchChatCopyCleanup(f.request)
      .then((value) => {
        returned = true;
        return value;
      });
    await Promise.race([entered.promise, pending.then(() => undefined)]);
    expect(returned).toBe(false);
    expect(h.table(CLOSURE)).toEqual([]);
    expect(h.table(INTENT)).toEqual([]);
    release.release();
    expect(await pending).toEqual(f.receipt);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(h.table(CLOSURE)).toHaveLength(1);
    expect(h.table(INTENT)).toHaveLength(1);
    const stored = h.table(INTENT)[0]!["payload"] as VertexRecord;
    const closure = h.table(CLOSURE)[0]!["payload"] as VertexRecord;
    expect(stored).toEqual({
      profile: "vertex-research-chat-copy-explicit-cleanup-intent-v1",
      receipt: f.receipt,
      closureId: closure["closureId"],
      inventorySha256: closure["inventorySha256"],
    });
    expect(closure["copyIds"]).toEqual(
      [root.copyId, model.copyId, output.copyId].sort()
    );
    expect(h.table(ALLOCATION)).toEqual(originalAllocations);
    expect(h.table(PIN)).toEqual(originalPins);
    expect(root.binding.content).toBeNull();
    expect(
      copyWrites(h).map((call) => call.sql.match(/^insert into "([^"]+)"/)?.[1])
    ).toEqual([CLOSURE, INTENT]);
    expect(
      h.calls.every(
        (call) =>
          call.sql.includes("pg_advisory_xact_lock") ||
          call.sql.includes("vertex_research_chat_copy_")
      )
    ).toBe(true);
    return expect(h.commandPolicy).not.toHaveBeenCalled();
  });
  it("does not infer explicit intent from generic closure, and requests later without changing that closure", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const closed = await cleanup(h, root);
    const later = "2026-09-24T18:01:00Z";
    const f = await cleanupFixture(h, root, "cleanup-later", later);
    expect(await f.read()).toBeNull();
    expect(h.table(INTENT)).toEqual([]);
    h.now.mockReturnValue(later);
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      f.receipt
    );
    expect((await inventory(h, root))?.closure).toEqual(closed.closure);
    expect(h.table(CLOSURE)).toHaveLength(1);
    return expect(h.table(INTENT)).toHaveLength(1);
  });
  it("replays and reads the exact original requested ACK, not a clock refresh or cleanup observation", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const f = await cleanupFixture(h, root);
    const original = await h.store.requestResearchChatCopyCleanup(f.request);
    h.calls.length = 0;
    h.now.mockReturnValue("2026-09-25T18:00:00Z");
    const replay = await h.store.requestResearchChatCopyCleanup(f.request);
    const read = await f.read();
    expect(replay).toEqual(original);
    expect(read).toEqual(original);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read?.["targetKinds"])).toBe(true);
    expect(copyWrites(h)).toEqual([]);
    expect(h.table(INTENT)).toHaveLength(1);
    h.now.mockReturnValue("2026-09-23T18:00:00Z");
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      original
    );
    expect(await f.read()).toEqual(original);
    const absent = await cleanupFixture(h, root, "another-original-key");
    expect(await absent.read()).toBeNull();
    return expect(h.table(INTENT)).toHaveLength(1);
  });
  it("requires only exact-family cleanup authorization even after processing/account reads and thread data disappear", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const f = await cleanupFixture(h, root);
    h.table("vertex_research_chat_threads").splice(0);
    h.table("vertex_research_chat_messages").splice(0);
    h.table("vertex_command_receipts").push({
      sentinel: "immutable-unavailable-response",
    });
    h.authorize.mockClear();
    h.authorize.mockImplementation(
      async (request) =>
        request.action === "cleanup-chat-copies" &&
        request.resourceId ===
          `research-chat-copies:${root.responseRequestId}` &&
        request.collectionId === null &&
        request.principal.actorId === principal.actorId
    );
    h.calls.length = 0;
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      f.receipt
    );
    expect(await f.read()).toEqual(f.receipt);
    expect(
      h.authorize.mock.calls.every(
        ([request]) =>
          request.action === "cleanup-chat-copies" &&
          request.resourceId ===
            `research-chat-copies:${root.responseRequestId}` &&
          request.collectionId === null
      )
    ).toBe(true);
    expect(
      h.calls.every(
        (call) =>
          call.sql.includes("pg_advisory_xact_lock") ||
          call.sql.includes("vertex_research_chat_copy_")
      )
    ).toBe(true);
    expect(h.table("vertex_command_receipts")).toEqual([
      { sentinel: "immutable-unavailable-response" },
    ]);
    expect(h.commandPolicy).not.toHaveBeenCalled();
    for (const prohibited of [
      "PRIVATE-HUMAN-BODY-SENTINEL",
      "PRIVATE-RETRIEVAL-QUERY-SENTINEL",
      "retrievalQuery",
      "jobId",
      "backend",
      "consent",
      "ready",
    ])
      expect(JSON.stringify(h.table(INTENT))).not.toContain(prohibited);
  });
  it.each(["before-transaction", "after-lock"] as const)(
    "denies absent/revoked cleanup authority %s before metadata reads or writes",
    async (stage) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      for (const operation of [
        () => h.store.requestResearchChatCopyCleanup(f.request),
        f.read,
      ]) {
        h.authorize.mockReset();
        if (stage === "after-lock") {
          h.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
        } else h.authorize.mockResolvedValue(false);
        h.calls.length = 0;
        await expect(operation()).rejects.toMatchObject({ code: "denied" });
        expect(
          h.calls.every((call) => call.sql.includes("pg_advisory_xact_lock"))
        ).toBe(true);
      }
      expect(h.table(INTENT)).toEqual([]);
      return expect(h.table(CLOSURE)).toEqual([]);
    }
  );
  it.each(["owner", "thread", "account", "response", "paper", "live"] as const)(
    "rejects wrong %s on both request and read without synthesizing family or intent",
    async (field) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      const bad = {
        ...f.request,
        principal: field === "owner" ? cleaner : principal,
        scope: {
          ...scope,
          accountAlias: field === "account" ? "other" : scope.accountAlias,
          environment:
            field === "paper"
              ? ("paper" as const)
              : field === "live"
                ? ("live" as const)
                : ("research" as const),
        },
        threadId: field === "thread" ? "other-thread" : root.threadId,
        responseRequestId:
          field === "response"
            ? `response-${"f".repeat(64)}`
            : root.responseRequestId,
      };
      const command = {
        ...bad.scope,
        threadId: bad.threadId,
        responseRequestId: bad.responseRequestId,
        idempotencyKey: bad.idempotencyKey,
      };
      h.accept("requestCopyCleanup", command);
      h.accept("readCopyCleanup", command);
      for (const operation of [
        () => h.store.requestResearchChatCopyCleanup(bad),
        () =>
          h.store.readResearchChatCopyCleanup(
            bad.principal,
            bad.scope,
            bad.threadId,
            bad.responseRequestId,
            bad.idempotencyKey
          ),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: ["paper", "live"].includes(field) ? "invalid" : "denied",
        });
      }
      expect(h.table(FAMILY)).toHaveLength(1);
      expect(h.table(INTENT)).toEqual([]);
      return expect(h.table(CLOSURE)).toEqual([]);
    }
  );
  it("captures request and read arguments before the first await", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const f = await cleanupFixture(h, root);
    const mutable = {
      ...f.request,
      principal: { ...principal },
      scope: { ...scope },
    };
    const pending = h.store.requestResearchChatCopyCleanup(mutable);
    mutable.principal.actorId = "other";
    mutable.scope.accountAlias = "other";
    mutable.threadId = "other";
    mutable.idempotencyKey = "other";
    expect(await pending).toEqual(f.receipt);
    const readPrincipal = { ...principal };
    const readScope = { ...scope };
    const reading = h.store.readResearchChatCopyCleanup(
      readPrincipal,
      readScope,
      root.threadId,
      root.responseRequestId,
      f.request.idempotencyKey
    );
    readPrincipal.actorId = "other";
    readScope.accountAlias = "other";
    return expect(await reading).toEqual(f.receipt);
  });
  it.each([
    "extra",
    "getter",
    "hidden",
    "symbol",
    "prototype",
    "key-newline",
    "thread-newline",
    "response-newline",
  ] as const)(
    "rejects hostile cleanup input %s without authorization or SQL",
    async (scenario) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      const bad: Record<string, unknown> = { ...f.request };
      const getter = vi.fn(() => "cleanup-1");
      if (scenario === "extra") bad["ttl"] = 1;
      if (scenario === "getter")
        Object.defineProperty(bad, "idempotencyKey", {
          enumerable: true,
          get: getter,
        });
      if (scenario === "hidden")
        Object.defineProperty(bad, "approved", {
          enumerable: false,
          value: true,
        });
      if (scenario === "symbol")
        Object.defineProperty(bad, Symbol("human"), { value: true });
      if (scenario === "prototype")
        Object.setPrototypeOf(bad, { approved: true });
      if (scenario === "key-newline") bad["idempotencyKey"] = "cleanup-1\n";
      if (scenario === "thread-newline") bad["threadId"] = `${root.threadId}\n`;
      if (scenario === "response-newline")
        bad["responseRequestId"] = `${root.responseRequestId}\n`;
      h.authorize.mockClear();
      h.calls.length = 0;
      await expect(
        h.store.requestResearchChatCopyCleanup(bad as unknown as Cleanup)
      ).rejects.toMatchObject({ code: "invalid" });
      expect(getter).not.toHaveBeenCalled();
      expect(h.authorize).not.toHaveBeenCalled();
      return expect(h.calls).toEqual([]);
    }
  );
  it("rolls back closure and intent together on synthetic intent insert failure", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const f = await cleanupFixture(h, root);
    h.controls.beforeInsert = (table) => {
      if (table === INTENT) throw new Error("Synthetic intent insert failure");
      return;
    };
    h.lifecycle.length = 0;
    await expect(
      h.store.requestResearchChatCopyCleanup(f.request)
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    expect(h.table(CLOSURE)).toEqual([]);
    expect(h.table(INTENT)).toEqual([]);
    expect((await inventory(h, root))?.closure).toBeNull();
    h.controls.beforeInsert = null;
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      f.receipt
    );
    expect(h.table(CLOSURE)).toHaveLength(1);
    return expect(h.table(INTENT)).toHaveLength(1);
  });
  it("recovers commit-then-lost-ACK by original key without another closure or intent", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const f = await cleanupFixture(h, root);
    h.controls.loseAck = true;
    await expect(
      h.store.requestResearchChatCopyCleanup(f.request)
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(h.table(CLOSURE)).toHaveLength(1);
    expect(h.table(INTENT)).toHaveLength(1);
    h.calls.length = 0;
    expect(await f.read()).toEqual(f.receipt);
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      f.receipt
    );
    return expect(copyWrites(h)).toEqual([]);
    // This deterministic cloned-map rollback/commit fault injection does NOT
    // qualify PostgreSQL durability, SQL constraints, concurrency or erasure.
  });
  it.each([
    "profile",
    "extra",
    "missing-receipt",
    "status",
    "targets",
    "actor",
    "thread",
    "response",
    "key",
    "digest",
    "identity",
    "authority",
    "time",
    "chronology",
    "closure-link",
    "inventory-link",
    "hash",
    "duplicate",
    "missing-closure",
    "incomplete-inventory",
  ] as const)(
    "fails closed on stored intent/inventory tamper %s for request and read",
    async (scenario) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      await h.store.requestResearchChatCopyCleanup(f.request);
      const row = h.table(INTENT)[0]!;
      const stored = row["payload"] as Record<string, unknown>;
      const receipt = stored["receipt"] as Record<string, unknown>;
      if (scenario === "profile")
        stored["profile"] = "vertex-research-chat-copy-closure-v1";
      if (scenario === "extra") stored["complete"] = true;
      if (scenario === "missing-receipt") delete stored["receipt"];
      if (scenario === "status") receipt["status"] = "complete";
      if (scenario === "targets") receipt["targetKinds"] = ["derived-output"];
      if (scenario === "actor") receipt["ownerActorId"] = "other";
      if (scenario === "thread") receipt["threadId"] = "other";
      if (scenario === "response")
        receipt["responseRequestId"] = `response-${"f".repeat(64)}`;
      if (scenario === "key") receipt["idempotencyKey"] = "other";
      if (scenario === "digest") receipt["requestSha256"] = "f".repeat(64);
      if (scenario === "identity")
        receipt["cleanupRequestId"] = `copy-cleanup-${"f".repeat(64)}`;
      if (scenario === "authority") receipt["executionAuthorized"] = true;
      if (scenario === "time") receipt["recordedAt"] = "2026-02-30T18:00:00Z";
      if (scenario === "chronology") {
        receipt["recordedAt"] = "2026-09-23T18:00:00Z";
        row["recorded_at"] = receipt["recordedAt"];
        row["recorded_at_ns"] = (
          BigInt(Date.parse(receipt["recordedAt"] as string)) * 1_000_000n
        ).toString();
      }
      if (scenario === "closure-link")
        stored["closureId"] = `copy-closure-${"f".repeat(64)}`;
      if (scenario === "inventory-link")
        stored["inventorySha256"] = "f".repeat(64);
      if (scenario === "missing-closure") h.table(CLOSURE).splice(0);
      if (scenario === "incomplete-inventory") h.table(ALLOCATION).splice(0);
      h.accept("ResearchChatCopyCleanupReceipt", receipt);
      row["record_hash"] =
        scenario === "hash" ? "f".repeat(64) : await hash(stored);
      if (scenario === "duplicate") h.table(INTENT).push(structuredClone(row));
      h.calls.length = 0;
      await expect(
        h.store.requestResearchChatCopyCleanup(f.request)
      ).rejects.toMatchObject({ code: "integrity" });
      await expect(f.read()).rejects.toMatchObject({ code: "integrity" });
      return expect(copyWrites(h)).toEqual([]);
    }
  );
  it.each([
    "account_alias",
    "environment",
    "owner_actor_id",
    "thread_id",
    "response_request_id",
    "idempotency_key",
    "cleanup_request_id",
    "request_sha256",
    "recorded_at",
    "recorded_at_ns",
    "closure_id",
    "inventory_sha256",
  ] as const)(
    "rejects tampered indexed %s instead of treating the original as absent",
    async (column) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      await h.store.requestResearchChatCopyCleanup(f.request);
      h.table(INTENT)[0]![column] = "tampered";
      await expect(
        h.store.requestResearchChatCopyCleanup(f.request)
      ).rejects.toMatchObject({ code: "integrity" });
      await expect(f.read()).rejects.toMatchObject({ code: "integrity" });
      return expect(h.table(INTENT)).toHaveLength(1);
    }
  );
  it("rejects stale new intent time after generic closure without altering the closure", async () => {
    const { h, input } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    h.now.mockReturnValue("2026-09-25T18:00:00Z");
    const closed = await cleanup(h, root);
    const f = await cleanupFixture(h, root);
    h.now.mockReturnValue(NOW);
    await expect(
      h.store.requestResearchChatCopyCleanup(f.request)
    ).rejects.toMatchObject({ code: "stale" });
    expect(h.table(INTENT)).toEqual([]);
    return expect((await inventory(h, root))?.closure).toEqual(closed.closure);
  });
  it("never upgrades a settled response receipt or original allocation ACK when explicit intent is accepted", async () => {
    const { h, input, request } = await fixture();
    const root = await h.store.reserveResearchChatCopy(input);
    const requestSha256 = await hash({
      operation: "requestResponse",
      actorId: principal.actorId,
      input: request,
    });
    const response = {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      ...scope,
      threadId: request.threadId,
      ownerActorId: principal.actorId,
      responseRequestId: root.responseRequestId,
      parentMessageId: request.parentMessageId,
      participantId: request.participantId,
      idempotencyKey: request.idempotencyKey,
      requestSha256,
      recordedAt: NOW,
      snapshotRevision: request.snapshotRevision,
      contextStartSequence: request.contextStartSequence,
      status: "unavailable",
      reasonCodes: ["research-runtime-unavailable"],
      admission: null,
      jobId: null,
    };
    h.accept("ResearchChatResponseReceipt", response);
    const legacy = {
      principal,
      scope,
      threadId: request.threadId,
      parentMessageId: request.parentMessageId,
      participantId: request.participantId,
      snapshotRevision: request.snapshotRevision,
      contextStartSequence: request.contextStartSequence,
      retrievalQuery: request.retrievalQuery,
      idempotencyKey: request.idempotencyKey,
    };
    expect(await h.store.requestResearchChatResponse(legacy)).toEqual(response);
    const receipts = structuredClone(h.table("vertex_command_receipts"));
    const allocation = structuredClone(h.table(ALLOCATION));
    const f = await cleanupFixture(h, root);
    expect(await h.store.requestResearchChatCopyCleanup(f.request)).toEqual(
      f.receipt
    );
    expect(await f.read()).toEqual(f.receipt);
    expect(await h.store.requestResearchChatResponse(legacy)).toEqual(response);
    expect(h.table("vertex_command_receipts")).toEqual(receipts);
    expect(h.table(ALLOCATION)).toEqual(allocation);
    return expect(root.binding.content).toBeNull();
  });
  it.each(["input", "receipt"] as const)(
    "requires the authoritative %s validator without leaving partial intent metadata",
    async (target) => {
      const { h, input } = await fixture();
      const root = await h.store.reserveResearchChatCopy(input);
      const f = await cleanupFixture(h, root);
      h.validate.mockImplementation(async (name, value) => {
        if (
          name ===
          (target === "input"
            ? "requestCopyCleanup"
            : "ResearchChatCopyCleanupReceipt")
        )
          throw new Error("Boundary unavailable");
        return structuredClone(value) as VertexRecord;
      });
      h.calls.length = 0;
      await expect(
        h.store.requestResearchChatCopyCleanup(f.request)
      ).rejects.toMatchObject({ code: "invalid" });
      expect(h.table(CLOSURE)).toEqual([]);
      expect(h.table(INTENT)).toEqual([]);
      if (target === "input") {
        return expect(h.calls).toEqual([]);
      }
      return expect(h.lifecycle.at(-1)).toBe("rollback");
    }
  );
  return it("authors additive append-only intent source with null-safe payload/closure linkage and no execution wiring", () => {
    const source = readFileSync(
      new URL("./vertex-research-chat-copy-store.ts", import.meta.url),
      "utf8"
    );
    const migration = readFileSync(
      new URL(
        "../../migrations/0013_vertex_research_chat_copy_cleanup.sql",
        import.meta.url
      ),
      "utf8"
    );
    const schema = readFileSync(
      new URL("../schema/vertex-research-chat-copies.ts", import.meta.url),
      "utf8"
    );
    const journal = JSON.parse(
      readFileSync(
        new URL("../../migrations/meta/_journal.json", import.meta.url),
        "utf8"
      )
    ) as { entries: { idx: number; tag: string }[] };
    expect(migration).toContain(`CREATE TABLE "${INTENT}"`);
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_cleanup_intents"'
    );
    expect(migration).toContain(
      'EXECUTE FUNCTION "vertex_chat_copy_immutable"()'
    );
    expect(migration).toContain(
      'REFERENCES "vertex_research_chat_copy_closures"'
    );
    expect(migration).toContain(
      'REFERENCES "vertex_research_chat_copy_families"'
    );
    expect(migration).toContain(
      "'targetKinds',jsonb_build_array('context','model-input','derived-output')"
    );
    expect(migration).toContain(")) is true)");
    for (const suffix of ["scope", "identity", "time", "payload"]) {
      expect(migration).toContain(`"vertex_copy_cleanup_${suffix}" CHECK (`);
      // Formatter-independent: Biome may wrap the check() arguments.
      expect(schema).toMatch(
        new RegExp(`check\\(\\s*"vertex_copy_cleanup_${suffix}",\\s*sql\``)
      );
    }
    // Append-only: later migrations (0017+) extend the journal, so assert
    // contiguous ordering and the fixed positions instead of an exact length.
    expect(journal.entries.length).toBeGreaterThanOrEqual(17);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, position) => position)
    );
    expect(journal.entries[13]).toMatchObject({
      idx: 13,
      tag: "0013_vertex_research_chat_copy_cleanup",
    });
    expect(journal.entries[14]).toMatchObject({
      idx: 14,
      tag: "0014_watchlist_items",
    });
    expect(journal.entries[15]).toMatchObject({
      idx: 15,
      tag: "0015_agent_ops_ledger",
    });
    expect(journal.entries[16]).toMatchObject({
      idx: 16,
      tag: "0016_agent_api_keys",
    });
    expect(migration).not.toMatch(/^\s*(GRANT|TRUNCATE|UPDATE|DELETE)\s/im);
    return expect(source).not.toMatch(
      /\b(fetch|putObject|deleteObject|fenceCopy|issueGrant)\s*\(/
    );
  });
});
