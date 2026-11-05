import {
  END,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { VERTEX_CONTRACT_SCHEMAS } from "../contracts/vertex.ts";
import { VERTEX_CONTROL_CONTRACT_SCHEMAS } from "../contracts/vertex-control.ts";
import {
  VERTEX_WORKER_CONTRACT_SCHEMAS,
  WorkerReadArtifactOutputSchema,
} from "../contracts/vertex-worker.ts";
import {
  VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  parseModelUseRequest,
  computeModelUseRequestHash,
} from "../contracts/vertex-model-use.ts";
import { VERTEX_POLICY_CONTRACT_SCHEMAS } from "../contracts/vertex-policy.ts";
import {
  type ModelPrivacyCandidateSchema,
  ModelPrivacyCandidateStatusSchema,
  ReadModelPrivacyReviewRequestInputSchema,
  ReadModelPrivacyReviewRequestOutputSchema,
  RecordModelPrivacyReviewInputSchema,
  RecordModelPrivacyReviewOutputSchema,
} from "../contracts/vertex-model-privacy-rendezvous.ts";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import { ChatWorkerOriginalClosedError } from "./vertex-research-chat-worker-runtime.ts";
import {
  completeResponse,
  fenceInputs,
  revokeGrant,
  base64,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import { handleApiRequest } from "./handler.ts";
import type { ApiContext } from "./context.ts";
import { appContract } from "../contract.ts";
import { VERTEX_WORKER_METHOD_DEFINITIONS } from "../contracts/vertex-worker-rpc.ts";
import {
  pinnedPython,
  RESEARCH_SDK_DISTRIBUTIONS,
} from "./research-python.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

const TIMEOUT = scaledTimeout(120_000);
const candidateTable = "vertex_research_chat_model_privacy_candidates";
const dispatchTable = "vertex_research_chat_model_dispatches";
const fixture = (extra = {}) =>
  chatWorkerFixture({
    rendezvous: true,
    participantId: "first-mate",
    admissionPath: "conversation",
    ...extra,
  });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const schemas = {
  ...VERTEX_CONTRACT_SCHEMAS,
  ...VERTEX_CONTROL_CONTRACT_SCHEMAS,
  ...VERTEX_WORKER_CONTRACT_SCHEMAS,
  ...VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
  ...VERTEX_POLICY_CONTRACT_SCHEMAS,
};
type OwnerFailure = Readonly<{
  exceptionClass: string | null;
  code: string | null;
  frames: readonly string[];
}>;
const ownerFailures = new WeakMap<ApiContext, OwnerFailure>();
const safeErrorCode = (value: unknown): string | null =>
  typeof value === "string" &&
  [
    "unavailable",
    "denied",
    "invalid",
    "conflict",
    "integrity",
    "stale",
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "PAYLOAD_TOO_LARGE",
    "INVALID_SOURCE",
    "SERVICE_UNAVAILABLE",
    "INTERNAL_SERVER_ERROR",
  ].includes(value)
    ? value
    : null;
const ownerFailure = (error: unknown): OwnerFailure => {
  const name = error instanceof Error ? error.constructor.name : "";
  const exceptionClass = [
    "Error",
    "TypeError",
    "VertexStoreError",
    "ChatWorkerOriginalClosedError",
  ].includes(name)
    ? name
    : null;
  const code = safeErrorCode(
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : null
  );
  const root = fileURLToPath(new URL("../../../../", import.meta.url)),
    frames: string[] = [];
  // Discard the message and function names; retain only bounded source locations.
  for (const line of (error instanceof Error ? (error.stack ?? "") : "")
    .slice(0, 16_384)
    .split("\n")
    .slice(1)) {
    const start = line.indexOf(root);
    if (start < 0) continue;
    const match =
      /^((?:packages|services)\/[A-Za-z0-9_./-]+\.(?:civet|ts|js|py)):(\d+)(?::\d+)?\)?$/.exec(
        line.slice(start + root.length)
      );
    if (match) frames.push(`${match[1]}:${match[2]}`);
    if (frames.length === 8) break;
  }
  return { exceptionClass, code, frames };
};
const reviewerContext = (
  f: Fixture,
  actorId = f.privacyReviewer.actorId,
  status = "active"
): ApiContext =>
  ({
    requireSession: async () => ({
      principal: { userId: actorId, role: "member", status },
    }),
    vertexModelPrivacyReviewer: f.privacy,
    vertexResearchChatConversation: f.runtime.conversation,
    vertexExperience: {
      store: f.store,
      authorization: f.authorization,
      clock: f.clock,
    },
  }) as unknown as ApiContext;
const workerContext = (f: Fixture): ApiContext => {
  const context = {
    vertexWorker: {
      store: {
        authenticate: (...args: Parameters<typeof f.worker.authenticate>) =>
          f.worker.authenticate(...args),
        invoke: async (...args: Parameters<typeof f.worker.invoke>) => {
          try {
            return await f.worker.invoke(...args);
          } catch (error) {
            try {
              ownerFailures.set(context, ownerFailure(error));
            } catch (e) {
              if (typeof e !== "object" || e === null) {
                throw e;
              }
            }
            throw error;
          }
        },
      },
      clock: f.clock,
      claim: async () => {
        throw new Error("No second claim in same-invocation test");
      },
    },
    workerRequest: {
      headers: new Headers({ authorization: `Bearer ${f.workerToken}` }),
    },
  } as unknown as ApiContext;
  return context;
};
const rpcResponse = async (context: ApiContext, path: string, input: unknown) =>
  handleApiRequest(
    new Request(`https://test.invalid/api/orpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    context
  );
const rpc = async (context: ApiContext, path: string, input: unknown) => {
  const response = await rpcResponse(context, path, input);
  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as {
      code?: unknown;
      json?: { code?: unknown };
    } | null;
    const routes = [
      ...Object.keys(VERTEX_WORKER_METHOD_DEFINITIONS).map(
        (method) => `vertexWorker/${method}`
      ),
      "vertex/researchChat/readModelPrivacyReviewRequest",
      "vertex/researchChat/recordModelPrivacyReview",
    ];
    const diagnostic = {
      path: routes.includes(path) ? path : null,
      status: response.status,
      code: safeErrorCode(envelope?.json?.code ?? envelope?.code),
      owner: ownerFailures.get(context) ?? null,
    };
    throw Object.assign(
      new Error(`Synthetic source RPC denied: ${JSON.stringify(diagnostic)}`),
      { status: response.status }
    );
  }
  const envelope = (await response.json()) as { json: unknown };
  return envelope.json;
};
const readCandidate = async (
  f: Fixture,
  operation = "model-tokenize",
  context = reviewerContext(f)
) =>
  ReadModelPrivacyReviewRequestOutputSchema.parse(
    await rpc(context, "vertex/researchChat/readModelPrivacyReviewRequest", {
      ...scope,
      responseRequestId: f.responseRequestId,
      operation,
    })
  ).candidate;
const decide = async (
  f: Fixture,
  candidate: ReturnType<typeof ModelPrivacyCandidateSchema.parse>,
  decision: "accepted" | "rejected" = "accepted"
) =>
  rpc(reviewerContext(f), "vertex/researchChat/recordModelPrivacyReview", {
    candidateId: candidate.candidateId,
    review: f.privacyInput(candidate.request, {
      decision,
      expiresAt: candidate.expiresAt,
    }),
  });
const workerRpc = (f: Fixture, method: string, input: unknown) =>
  rpc(workerContext(f), `vertexWorker/${method}`, input);

// One small test-only stdio bridge, not a production control framework. Native
// configuration/_Job/consumer/rights/output owners call actual RPC/store owners.
// Only external SQL, object, HTTP socket, clock and session-auth ports are doubles.
const consumeNative = async (f: Fixture) => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const artifacts: Record<string, string> = {},
    copies: Record<string, string> = {};
  for (const binding of f.selection.artifacts) {
    const object = [...f.objects.values()].find(
      (entry) => entry.id === binding.artifact.artifactId
    );
    if (object) artifacts[binding.artifact.artifactId] = base64(object.body);
  }
  // Admitted copies use the fenced worker reader, not pre-admission approval.
  for (const purpose of [
    "context",
    "tokenizeInput",
    "completionInput",
  ] as const) {
    const pin = f.recipe.copies[purpose];
    const input = WorkerReadArtifactOutputSchema.parse(
      await workerRpc(f, "readArtifact", {
        ...f.fence,
        collectionId: null,
        artifactId: pin.copyId,
      })
    );
    expect(input).toMatchObject({
      artifact: { artifactId: pin.copyId, artifactSha256: pin.sha256 },
      contentSha256: pin.sha256,
      canonicalSha256: null,
      contentType: "application/json",
    });
    const bytes = Uint8Array.from(atob(input.contentBase64), (character) =>
      character.charCodeAt(0)
    );
    expect(bytes.byteLength).toBe(pin.byteLength);
    expect(await hashArtifact(bytes)).toBe(pin.sha256);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(canonicalArtifactJson(JSON.parse(text))).toBe(text);
    copies[purpose] = base64(bytes);
  }
  const child = spawn(
    process.env["VERTEX_RENDEZVOUS_TEST_PYTHON"] ?? "python3",
    [
      resolve(
        root,
        "services/research/adapters/tests/privacy_rendezvous_stdio.py"
      ),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: ["research", "control-client", "market-data", "execution"]
          .map((name) => resolve(root, "services", name))
          .join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let watchdogFired = false,
    completedWorkerRpcCount = 0;
  let lastWorkerMethod: string | null = null,
    lastSchemaName: string | null = null;
  const timer = setTimeout(() => {
    watchdogFired = true;
    return child.kill("SIGKILL");
  }, scaledTimeout(120_000));
  let done: Record<string, any> | null = null;
  child.stderr.resume(); // Drain without retaining or emitting arbitrary child messages.
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }
  );
  const reviewed: string[] = [],
    pending: string[] = [];
  child.stdin.write(
    `${JSON.stringify({
      selection: f.selection,
      artifacts,
      copies,
      recipe: f.recipe,
      lease: f.lease,
      at: f.state.at,
    })}\n`
  );
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.kind === "done") {
        done = message;
        break;
      }
      let value: unknown;
      if (message.kind === "validate") {
        lastSchemaName =
          typeof message.name === "string" &&
          Object.hasOwn(schemas, message.name)
            ? message.name
            : null;
        const schema = schemas[message.name as keyof typeof schemas];
        if (message.version !== "1.0.0" || schema === undefined)
          throw new Error(
            `Synthetic native schema unavailable: ${message.name}`
          );
        const validation = schema.safeParse(message.value);
        if (!validation.success) {
          const issues = validation.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
          }));
          throw new Error(
            `Synthetic native schema rejected: ${JSON.stringify({ name: message.name, issues })}`
          );
        }
        value = true;
      } else {
        expect(message.kind).toBe("worker");
        lastWorkerMethod =
          typeof message.method === "string" &&
          Object.hasOwn(VERTEX_WORKER_METHOD_DEFINITIONS, message.method)
            ? message.method
            : null;
        value = await workerRpc(f, message.method, message.value);
        completedWorkerRpcCount += 1;
        if (message.method === "prepareModelPrivacyReview") {
          const status = ModelPrivacyCandidateStatusSchema.parse(value);
          expect(status.status).toBe("pending");
          pending.push(message.value.operation);
          const count = message.value.operation === "model-tokenize" ? 0 : 1;
          expect(f.table(dispatchTable)).toHaveLength(count);
          expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(
            count
          );
        }
        if (
          message.method === "readModelPrivacyReview" &&
          ModelPrivacyCandidateStatusSchema.parse(value).status === "pending"
        ) {
          const candidate = await readCandidate(f, message.value.operation);
          expect(candidate.request).toEqual(message.value);
          expect(candidate.request.inputTokens).toBe(
            message.value.operation === "model-tokenize" ? null : 37
          );
          await decide(f, candidate);
          reviewed.push(candidate.request.operation);
        }
      }
      child.stdin.write(`${JSON.stringify({ ok: true, value })}\n`);
    }
    child.stdin.end();
    const exit = await exited;
    const terminal = JSON.stringify({
      exitCode: exit.code,
      exitSignal: exit.signal,
      watchdogFired,
      completedWorkerRpcCount,
      lastWorkerMethod,
      lastSchemaName,
      status: done?.["outcome"]?.status ?? null,
      reason: done?.["outcome"]?.reason ?? null,
      outputCount: Array.isArray(done?.["outcome"]?.outputArtifactIds)
        ? done["outcome"].outputArtifactIds.length
        : null,
      pendingCount: pending.length,
      reviewedCount: reviewed.length,
    });
    expect(exit.code, terminal).toBe(0);
    expect(done, terminal).not.toBeNull();
    expect(done?.["outcome"]?.status, terminal).toBe("completed");
    expect(pending, terminal).toEqual(["model-tokenize", "model-completion"]);
    expect(reviewed, terminal).toEqual(pending);
    return done!;
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
};

describe("FirstMate exact-request privacy rendezvous source", () => {
  it(
    "connects pending tokenizer -> authenticated independent review -> native 1+1 -> actual governed publication/private read",
    async ({ skip }) => {
      // The Python consumer imports its pytest HTTP double and invokes the real
      // pinned SDK; without that stack in python3 the round trip cannot run.
      const consumer = pinnedPython("VERTEX_RENDEZVOUS_TEST_PYTHON", {
        ...RESEARCH_SDK_DISTRIBUTIONS,
        pytest: null,
      });
      skip(consumer.skip, consumer.note);
      // Conditional frozen-clock source proof, not advancing-clock readiness.
      const f = await fixture({ frozenRightsAtExecution: true });
      // Native endpoint storage-read is separate from provider/model permission.
      const rightsAdmin = { actorId: "fixture-grant-admin" };
      await f.grant(rightsAdmin.actorId, "endpoint-policy", ["manage-rights"]);
      await f.store.putRights(rightsAdmin, scope, null, {
        policyId: "endpoint-policy",
        version: "1.0.0",
        status: "granted",
        allowedUses: ["read"],
        checkedAt: f.clock.now(),
        expiresAt: END,
        retentionUntil: null,
      });
      await f.grant(owner.actorId, "endpoint-policy", ["read"]);
      const originalRights = structuredClone(f.table("vertex_rights_versions"));
      expect(
        originalRights
          .map((row) => [
            row["collection_key"],
            row["policy_id"],
            row["version"],
          ])
          .sort()
      ).toEqual(
        [
          ["", "endpoint-policy", "1.0.0"],
          ["", "policy-rights", "1.0.0"],
          ["corpus", "corpus-rights", "1.0.0"],
          ["corpus", "policy-rights", "1.0.0"],
        ].sort()
      );
      for (const row of originalRights) {
        expect(row["revision"]).toBe("1");
        expect(row["payload"].checkedAt).toBe(f.clock.now());
      }
      expect(
        originalRights.find((row) => row["policy_id"] === "endpoint-policy")?.[
          "payload"
        ].allowedUses
      ).toEqual(["read"]);
      const done = await consumeNative(f);
      expect(done["outcome"]).toMatchObject({
        status: "completed",
        outputArtifactIds: [f.plan.runId],
        executionAuthorized: false,
      });
      expect(done["sends"]).toEqual([
        { path: "/tokenize", sha256: f.recipe.copies.tokenizeInput.sha256 },
        {
          path: "/v1/chat/completions",
          sha256: f.recipe.copies.completionInput.sha256,
        },
      ]);
      expect(f.table(candidateTable)).toHaveLength(2);
      expect(f.table(dispatchTable)).toHaveLength(2);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(2);
      await completeResponse(f);
      await fenceInputs(f);
      const appended = await f.runtime.conversation.appendResponse(owner, {
        ...f.selector,
        expectedRevision: "2",
      });
      if (appended.status !== "appended")
        throw new Error("Actual private advisory reference unavailable");
      const content = await f.runtime.conversation.readResponseContent(owner, {
        ...f.selector,
        messageId: appended.message.messageId,
      });
      expect(content.status).toBe("available");
      if (content.status !== "available")
        throw new Error("Actual private advisory read unavailable");
      expect(content.profile).toMatchObject({
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        executionAuthorized: false,
      });
      expect(await hashArtifact(content.profile)).toBe(content.sha256);
      return expect(f.table("vertex_rights_versions")).toEqual(originalRights);
    },
    scaledTimeout(180_000)
  );
  it(
    "binds immutable slot, current worker authority and narrow private reviewer discovery",
    async () => {
      const f = await fixture();
      expect(
        await workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toMatchObject({ status: "not-observed", expiresAt: null });
      const prepared = await workerRpc(
        f,
        "prepareModelPrivacyReview",
        f.tokenizeRequest
      );
      expect(
        await workerRpc(f, "prepareModelPrivacyReview", f.tokenizeRequest)
      ).toEqual(prepared);
      expect(
        await workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toEqual(prepared);
      expect(f.table(candidateTable)).toHaveLength(1);
      expect(f.table(dispatchTable)).toHaveLength(0);
      for (const actor of [
        owner.actorId,
        f.identity.servicePrincipalId,
        "other-reviewer",
      ])
        await expect(
          readCandidate(f, "model-tokenize", reviewerContext(f, actor))
        ).rejects.toMatchObject({ status: 403 });
      await expect(
        readCandidate(
          f,
          "model-tokenize",
          reviewerContext(f, f.privacyReviewer.actorId, "suspended")
        )
      ).rejects.toMatchObject({ status: 403 });
      const selector = {
        ...scope,
        responseRequestId: f.responseRequestId,
        operation: "model-tokenize",
      };
      const response = await rpcResponse(
        reviewerContext(f),
        "vertex/researchChat/readModelPrivacyReviewRequest",
        selector
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0"
      );
      const candidate = await readCandidate(f);
      expect(canonicalArtifactJson(candidate)).not.toContain("messages");
      await expect(
        rpc(
          reviewerContext(f),
          "vertex/researchChat/readModelPrivacyReviewRequest",
          { ...selector, responseRequestId: "wrong-response" }
        )
      ).rejects.toThrow();
      await expect(
        rpc(
          reviewerContext(f),
          "vertex/researchChat/readModelPrivacyReviewRequest",
          { ...selector, accountAlias: "wrong-account" }
        )
      ).rejects.toThrow();
      await expect(
        rpc(
          reviewerContext(f),
          "vertex/researchChat/recordModelPrivacyReview",
          {
            candidateId: "wrong-candidate",
            review: f.privacyInput(candidate.request, {
              expiresAt: candidate.expiresAt,
            }),
          }
        )
      ).rejects.toThrow();
      const altered = { ...f.tokenizeRequest, leaseEpoch: "2" };
      const request = await parseModelUseRequest({
        ...altered,
        requestSha256: await computeModelUseRequestHash(altered),
      });
      await expect(
        workerRpc(f, "readModelPrivacyReview", request)
      ).rejects.toThrow();
      await decide(f, candidate, "rejected");
      expect(
        await workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toMatchObject({ status: "rejected" });
      const proof = await Promise.allSettled([
        f.modelUseRequest(f.tokenizeRequest),
      ]);
      if (proof[0]!.status === "fulfilled")
        expect(proof[0]!.value).toMatchObject({
          decision: "denied",
          externalDispatchAllowed: false,
        });
      expect(f.table(dispatchTable)).toHaveLength(0);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(0);
      const current = ReadModelPrivacyReviewRequestOutputSchema.parse(
        await rpc(
          reviewerContext(f),
          "vertex/researchChat/readModelPrivacyReviewRequest",
          selector
        )
      );
      expect(current.currentReviewId).not.toBeNull();
      const replacement = {
        candidateId: candidate.candidateId,
        review: f.privacyInput(candidate.request, {
          expiresAt: candidate.expiresAt,
          expectedReviewId: current.currentReviewId,
          idempotencyKey: "privacy-replacement",
        }),
      };
      const recorded = RecordModelPrivacyReviewOutputSchema.parse(
        await rpc(
          reviewerContext(f),
          "vertex/researchChat/recordModelPrivacyReview",
          replacement
        )
      );
      expect(recorded.decision).toBe("accepted");
      expect(
        await rpc(
          reviewerContext(f),
          "vertex/researchChat/recordModelPrivacyReview",
          replacement
        )
      ).toEqual(recorded);
      await expect(decide(f, candidate)).rejects.toThrow();
      expect(
        await workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toMatchObject({ status: "accepted" });
      expect(f.table(dispatchTable)).toHaveLength(0);
      return expect(
        f.table("vertex_model_use_budget_reservations")
      ).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "does not replace a measured completion slot with a different request or count",
    async () => {
      const f = await fixture();
      const first = await f.completionRequest(37),
        changed = await f.completionRequest(38);
      await workerRpc(f, "prepareModelPrivacyReview", first);
      const candidate = await readCandidate(f, "model-completion");
      await expect(
        workerRpc(f, "prepareModelPrivacyReview", changed)
      ).rejects.toThrow();
      await expect(
        workerRpc(f, "readModelPrivacyReview", changed)
      ).rejects.toThrow();
      await expect(
        rpc(
          reviewerContext(f),
          "vertex/researchChat/recordModelPrivacyReview",
          {
            candidateId: candidate.candidateId,
            review: f.privacyInput(changed, { expiresAt: candidate.expiresAt }),
          }
        )
      ).rejects.toThrow();
      expect(f.table(candidateTable)).toHaveLength(1);
      expect(f.table(candidateTable)[0]!["payload"].request).toEqual(first);
      return expect(f.table(dispatchTable)).toHaveLength(0);
    },
    TIMEOUT
  );
  it.each(["prepareModelPrivacyReview", "readModelPrivacyReview"] as const)(
    "does not upgrade missing explicit service authority for %s",
    async (operation) => {
      const f = await fixture({ omitServiceOperation: operation });
      await expect(
        workerRpc(f, operation, f.tokenizeRequest)
      ).rejects.toThrow();
      expect(f.table(candidateTable)).toHaveLength(0);
      return expect(f.table(dispatchTable)).toHaveLength(0);
    },
    TIMEOUT
  );
  it("documents exact structural worker and reviewer routes without exposing dispatch authority", () => {
    // Actual root/schema identities only. Full-app OpenAPI qualification remains
    // blocked by the preexisting debate input converters; this is not that claim.
    const read =
      appContract.vertex.researchChat.readModelPrivacyReviewRequest["~orpc"];
    const record =
      appContract.vertex.researchChat.recordModelPrivacyReview["~orpc"];
    expect(read.route).toMatchObject({
      method: "POST",
      path: "/vertex/research-chat/model-privacy/read",
    });
    expect(record.route).toMatchObject({
      method: "POST",
      path: "/vertex/research-chat/model-privacy/record",
    });
    expect(read.inputSchema).toBe(ReadModelPrivacyReviewRequestInputSchema);
    expect(read.outputSchema).toBe(ReadModelPrivacyReviewRequestOutputSchema);
    expect(record.inputSchema).toBe(RecordModelPrivacyReviewInputSchema);
    expect(record.outputSchema).toBe(RecordModelPrivacyReviewOutputSchema);
    expect(
      z.toJSONSchema(ReadModelPrivacyReviewRequestInputSchema, { io: "input" })
        .required
    ).toEqual(
      expect.arrayContaining([
        "accountAlias",
        "environment",
        "responseRequestId",
        "operation",
      ])
    );
    expect(
      z.toJSONSchema(RecordModelPrivacyReviewInputSchema, { io: "input" })
        .required
    ).toEqual(expect.arrayContaining(["candidateId", "review"]));
    expect(
      z.toJSONSchema(ReadModelPrivacyReviewRequestOutputSchema, { io: "input" })
        .required
    ).toEqual(expect.arrayContaining(["candidate", "currentReviewId"]));
    expect(
      z.toJSONSchema(RecordModelPrivacyReviewOutputSchema, { io: "input" })
        .required
    ).toEqual(
      expect.arrayContaining([
        "candidateId",
        "requestSha256",
        "reviewId",
        "decision",
        "expiresAt",
      ])
    );
    for (const [operation, nativeInput] of [
      ["prepareModelPrivacyReview", "WorkerPrepareModelPrivacyReviewInput"],
      ["readModelPrivacyReview", "WorkerReadModelPrivacyReviewInput"],
    ] as const) {
      const leaf = appContract.vertexWorker[operation]["~orpc"],
        definition = VERTEX_WORKER_METHOD_DEFINITIONS[operation];
      expect(leaf.route).toMatchObject({
        method: "POST",
        path: `/vertex-worker/${operation}`,
      });
      expect(leaf.inputSchema).toBe(definition.input);
      expect(leaf.outputSchema).toBe(definition.output);
      expect(definition.input).toBe(
        VERTEX_WORKER_CONTRACT_SCHEMAS[nativeInput]
      );
      expect(definition.input).toBe(
        VERTEX_MODEL_USE_CONTRACT_SCHEMAS.ModelUseRequest
      );
      expect(definition.output).toBe(
        VERTEX_WORKER_CONTRACT_SCHEMAS.WorkerModelPrivacyReviewOutput
      );
      expect(definition.output).toBe(ModelPrivacyCandidateStatusSchema);
      expect(
        z.toJSONSchema(definition.input, { io: "input" }).required
      ).toEqual(
        expect.arrayContaining([
          "accountAlias",
          "environment",
          "jobId",
          "leaseId",
          "leaseEpoch",
          "requestId",
          "requestSha256",
          "inputTokens",
        ])
      );
      const output = z.toJSONSchema(definition.output, { io: "input" });
      expect(output.required).toEqual(
        expect.arrayContaining([
          "candidateId",
          "requestId",
          "requestSha256",
          "status",
          "expiresAt",
        ])
      );

      expect(output.properties).not.toHaveProperty("externalDispatchAllowed");
    }
  });
  it.each(["expiry", "reviewer-revocation", "owner-revocation", "cancelled"])(
    "fails closed on original %s after pending without extending candidate",
    async (loss) => {
      const f = await fixture();
      await workerRpc(f, "prepareModelPrivacyReview", f.tokenizeRequest);
      const candidate = await readCandidate(f);
      if (loss === "expiry") f.state.at = candidate.expiresAt;
      if (loss === "reviewer-revocation")
        await revokeGrant(f, "chat-privacy-policy", f.privacyReviewer.actorId);
      if (loss === "owner-revocation")
        await revokeGrant(f, "chat-tokenize-grant");
      if (loss === "cancelled")
        await f.worker.invoke(f.identity, "cancel", {
          ...f.fence,
          reason: "requested",
        });
      await expect(
        workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).rejects.toThrow();
      await expect(decide(f, candidate)).rejects.toThrow();
      expect(f.table(candidateTable)[0]!["payload"]).toEqual(candidate);
      return expect(f.table(dispatchTable)).toHaveLength(0);
    },
    TIMEOUT
  );
  it.each(["read-first", "record-first"])(
    "commits original context closure on reviewer %s before worker polling and never revives after regrant",
    async (entry) => {
      const f = await fixture(),
        domainTable = "vertex_research_chat_copy_domain_closures";
      await workerRpc(f, "prepareModelPrivacyReview", f.tokenizeRequest);
      const candidate = await readCandidate(f);
      const binding = f
        .table("vertex_grant_bindings")
        .find(
          (row) =>
            row["grantee_actor_id"] === owner.actorId &&
            row["resource_id"] ===
              `research-chat-context-use:${f.responseRequestId}` &&
            row["collection_key"] === ""
        )!;
      const originalGrant = structuredClone(
        f
          .table("vertex_grant_versions")
          .find(
            (row) =>
              row["grant_id"] === binding["grant_id"] &&
              row["version"] === "1.0.0"
          )!["payload"]
      );
      expect(f.table(domainTable)).toHaveLength(0);
      await f.revokeContext();

      // Calibrate the actual rollback-capable SQL fixture with the real closure
      // writes. A fake transaction that always commits must fail this regression.
      const beforeRollback = f.calls.length;
      await expect(
        f.db.transaction((tx) =>
          f.runtime.workerModel.readRendezvousOriginalForTransaction(
            tx,
            f.tokenizeRequest,
            f.state.at
          )
        )
      ).rejects.toBeInstanceOf(ChatWorkerOriginalClosedError);
      expect(
        f.calls
          .slice(beforeRollback)
          .filter(
            (query) =>
              query.sql.startsWith("insert into ") &&
              query.sql.includes(domainTable)
          )
      ).toHaveLength(2);
      expect(f.table(domainTable)).toHaveLength(0);

      // No worker status/currentModelUse call intervenes: the authenticated
      // reviewer transport itself must commit the original-authority closure.
      if (entry === "read-first") {
        await expect(readCandidate(f)).rejects.toThrow();
      } else {
        await expect(decide(f, candidate)).rejects.toThrow();
      }
      const closures = structuredClone(f.table(domainTable));
      expect(closures.map((row) => row["domain"]).sort()).toEqual([
        "derived",
        "inputs",
      ]);
      expect(
        closures.every(
          (row) => row["response_request_id"] === f.responseRequestId
        )
      ).toBe(true);
      await f.authorization.issueGrant({
        principal: { actorId: originalGrant.recordedByActorId },
        grantId: originalGrant.grantId,
        granteeActorId: originalGrant.granteeActorId,
        scope: originalGrant.scope,
        collectionId: originalGrant.collectionId,
        resourceId: originalGrant.resourceId,
        actions: originalGrant.actions,
        version: "3.0.0",
        expectedVersion: "2.0.0",
        validFrom: originalGrant.validFrom,
        expiresAt: originalGrant.expiresAt,
      });
      await expect(readCandidate(f)).rejects.toThrow();
      await expect(decide(f, candidate)).rejects.toThrow();
      await expect(
        workerRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).rejects.toThrow();
      await expect(
        workerRpc(f, "currentModelUse", f.tokenizeRequest)
      ).rejects.toThrow();
      expect(f.table(domainTable)).toEqual(closures);
      expect(f.table(candidateTable)[0]!["payload"]).toEqual(candidate);
      expect(f.table(dispatchTable)).toHaveLength(0);
      return expect(
        f.table("vertex_model_use_budget_reservations")
      ).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "keeps old preissued profiles and non-FirstMate jobs out of this optional connector",
    async () => {
      const old = await chatWorkerFixture({
        participantId: "first-mate",
        admissionPath: "conversation",
      });
      await expect(
        old.worker.invoke(
          old.identity,
          "prepareModelPrivacyReview",
          old.tokenizeRequest
        )
      ).rejects.toThrow();
      expect(old.table(candidateTable)).toHaveLength(0);
      const expert = await fixture({ participantId: "jan-smolen" });
      await expect(
        workerRpc(expert, "prepareModelPrivacyReview", expert.tokenizeRequest)
      ).rejects.toThrow();
      return expect(expert.table(candidateTable)).toHaveLength(0);
    },
    TIMEOUT
  );
});
