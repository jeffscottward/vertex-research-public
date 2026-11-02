import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexStore,
  type VertexArtifactMetadata,
  type VertexAuthorizationRepository,
  type VertexCommandKey,
  type VertexCommandPolicyGuard,
  type VertexCommandPolicyIdentity,
  type VertexRecord,
  type VertexScope,
  type VertexStore,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { AgentRunSchema } from "../contracts/vertex.ts";
import {
  VertexResearchProposalInputSchema,
  VertexReviewDecisionInputSchema,
  VertexSimulationProposalInputSchema,
} from "../contracts/vertex-experience.ts";
import { createVertexExperienceCommands } from "./vertex-experience-commands.ts";
import {
  createVertexRequestDependencies,
  vertexPersistenceBoundary,
} from "./vertex-experience-adapter.ts";
import {
  resolveVertexExperiencePolicy,
  type VertexExperienceDependencies,
  type VertexExperiencePolicy,
  type VertexExperiencePolicyResolver,
} from "./vertex-experience-core.ts";

// Authored only; these fixtures have no live DB, provider, object store or account.
const principal: SafePrincipal = {
  userId: "fixture-member",
  role: "member",
  status: "active",
};
const actor = Object.freeze({ actorId: principal.userId });
const scope: VertexScope = Object.freeze({
  accountAlias: "fixture-a",
  environment: "paper",
});
const now = "2026-09-22T12:00:00.000000001Z";
const before = "2026-09-22T11:59:00Z";
const end = "2026-09-22T12:10:00Z";
const identity: VertexCommandPolicyIdentity = Object.freeze({
  selectionId: "selection-a",
  selectionSha256: "a".repeat(64),
  selectionRevision: "3",
  revision: "7",
});
const reviewPolicy = Object.freeze({
  version: "1.0.0",
  reviewVersion: "1.0.0",
  ttlMilliseconds: 60_000,
});
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
const researchInput = VertexResearchProposalInputSchema.parse({
  ...scope,
  question: "Compare the synthetic research evidence.",
  collectionId: "collection-a",
  evidenceIds: [],
  role: "research",
  idempotencyKey: "research-a",
  proposalOnly: true,
  executionAuthorized: false,
});
const reviewInput = VertexReviewDecisionInputSchema.parse({
  ...scope,
  artifactId: "strategy-a",
  artifactSha256: "b".repeat(64),
  strategyVersion: "strategy-a",
  decision: "accepted",
  purpose: "research",
  expectedReviewId: null,
  idempotencyKey: "review-a",
});
const simulationInput = VertexSimulationProposalInputSchema.parse({
  ...scope,
  admissionId: "admission-a",
  reviewId: "review-a",
  reviewVersion: "1.0.0",
  intentId: "intent-a",
  intentSha256: "b".repeat(64),
  strategyVersion: "strategy-a",
  idempotencyKey: "simulation-a",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
});
const keyFor = async (
  kind: VertexCommandKey["kind"],
  command: VertexRecord
): Promise<VertexCommandKey> => ({
  kind,
  command,
  idempotencyKey: command["idempotencyKey"] as string,
  requestHash: await hash({ actorId: actor.actorId, kind, input: command }),
  commandPolicy: identity,
});
const deferred = <T>() => {
  let complete: (value: T) => void = () => {
    throw new Error("Uninitialized fixture");
  };
  const promise = new Promise<T>((resolve) => {
    return (complete = resolve);
  });
  return { promise, complete: (value: T) => complete(value) };
};

const serviceFixture = (resolvePolicy?: VertexExperiencePolicyResolver) => {
  const authorize = vi.fn(async () => true);
  const available = vi.fn(async () => true);
  const getCommandReceipt = vi.fn(async () => null);
  const findRecordArtifact = vi.fn(async () => null);
  const prepareManifest = vi.fn(async (): Promise<VertexArtifactMetadata> => {
    throw new Error("Unexpected staging");
  });
  const dependencies: VertexExperienceDependencies = {
    clock: { now: () => now },
    authorization: {
      authorize,
      listAuthorizedScopes: vi.fn(async () => [scope]),
    } as unknown as VertexAuthorizationRepository,
    store: { getCommandReceipt, findRecordArtifact } as unknown as VertexStore,
    prepareManifest,
    reviewPolicy,
    research: {
      available,
      taskContract: "task-a",
      modelVersion: "model-a",
      tokenBudget: 100,
      costBudgetUsd: "1",
      rightsPolicyId: "rights-a",
      allowedTools: ["read-evidence"],
    },
    simulation: {
      available,
      simulatorId: "simulator-a",
      maximumLoss: "10",
      maximumNotional: "100",
      ttlMilliseconds: 60_000,
    },
    ...(resolvePolicy === undefined ? {} : { resolvePolicy }),
  };
  return {
    dependencies,
    authorize,
    available,
    getCommandReceipt,
    findRecordArtifact,
    prepareManifest,
  };
};

const databaseFixture = async (
  storedPolicy: VertexCommandPolicyIdentity | null = identity,
  guard: VertexCommandPolicyGuard | null = async () => true
) => {
  const key = await keyFor("research", researchInput);
  const value = AgentRunSchema.parse({
    schemaVersion: "1.0.0",
    runId: `run-${key.requestHash}`,
    agentRole: "research",
    taskContract: "task-a",
    allowedTools: ["read-evidence"],
    modelVersion: "model-a",
    inputEvidenceIds: [],
    outputArtifactIds: [],
    tokenBudget: 100,
    costBudgetUsd: "1",
    status: "queued",
    errors: [],
    approvalRequests: [],
    executionAuthorized: false,
  });
  const sha256 = await hash(value);
  const rights = {
    policyId: "rights-a",
    version: "1.0.0",
    status: "granted" as const,
    allowedUses: ["store", "read", "derive"] as const,
    checkedAt: before,
    expiresAt: end,
    retentionUntil: null,
  };
  const metadata: VertexArtifactMetadata = {
    artifactId: `agent-${key.requestHash}`,
    scope,
    collectionId: researchInput.collectionId,
    objectKey: "fixture/agent.json",
    artifactSha256: sha256,
    sourceContentSha256: null,
    byteLength: new TextEncoder().encode(canonicalArtifactJson(value))
      .byteLength,
    contentType: "application/json",
    schemaVersion: "1.0.0",
    contractName: "AgentRun",
    rights,
    lineageArtifactIds: [],
    createdAt: before,
  };
  const result = { artifactId: metadata.artifactId, sha256, value };
  const proposal = {
    question: researchInput.question,
    evidenceIds: researchInput.evidenceIds,
    role: researchInput.role,
    proposalOnly: true as const,
    executionAuthorized: false as const,
  };
  const receipt = {
    request_hash: key.requestHash,
    command:
      storedPolicy === null
        ? key.command
        : { command: key.command, commandPolicy: storedPolicy },
    result,
    result_hash: await hash(
      storedPolicy === null ? result : { result, commandPolicy: storedPolicy }
    ),
  };
  const records: Readonly<Record<string, readonly VertexRecord[]>> = {
    vertex_command_receipts: [receipt],
    vertex_records: [
      {
        artifact_id: metadata.artifactId,
        collection_key: metadata.collectionId,
        artifact_sha256: sha256,
        record_hash: sha256,
        contract_name: "AgentRun",
        payload: value,
      },
    ],
    vertex_artifacts: [
      { payload: metadata, metadata_hash: await hash(metadata) },
    ],
    vertex_rights_versions: [
      { payload: rights, record_hash: await hash(rights) },
    ],
    vertex_research_proposals: [
      { payload: proposal, proposal_hash: await hash(proposal) },
    ],
    vertex_research_proposal_evidence: [],
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const query = dialect.sqlToQuery(fragment);
    queries.push({ sql: query.sql, params: query.params });
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    for (const [table, data] of Object.entries(records)) {
      if (
        query.sql.includes(`from "${table}"`) ||
        query.sql.includes(`from ${table} `)
      )
        return { rows: [...data] };
    }
    throw new Error("Unexpected fixture query");
  });
  const tx = { execute } as unknown as Transaction;
  const transaction = vi.fn(
    async (operation: (executor: Transaction) => Promise<unknown>) =>
      operation(tx)
  );
  const db = { execute, transaction } as unknown as Database;
  const authorize = vi.fn(async () => true);
  const store = createVertexStore(db, {
    boundary: vertexPersistenceBoundary,
    clock: { now: () => now },
    authorization: { authorize },
    maxProjectionAgeMs: 60_000,
    ...(guard === null ? {} : { commandPolicy: guard }),
  });
  return {
    store,
    db,
    tx,
    key,
    result,
    metadata,
    value,
    proposal,
    queries,
    execute,
    transaction,
    authorize,
  };
};

describe("Vertex runtime scoped experience policy", () => {
  it("keeps resolver and command guard inert during construction", async () => {
    const resolvePolicy = vi.fn(async () => Object.freeze({}));
    const commandPolicy = vi.fn(async () => false);
    const execute = vi.fn();
    const transaction = vi.fn();
    const dependencies = createVertexRequestDependencies({
      db: { execute, transaction } as unknown as Database,
      resolvePolicy,
      commandPolicy,
    });
    createVertexExperienceCommands(dependencies.vertexExperience);
    expect(dependencies.vertexExperience.resolvePolicy).toBe(resolvePolicy);
    expect(resolvePolicy).not.toHaveBeenCalled();
    expect(commandPolicy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    return expect(transaction).not.toHaveBeenCalled();
  });

  it("denies all missing scoped bindings without falling back to configured static values", async () => {
    const resolvePolicy = vi.fn(async () => Object.freeze({}));
    const h = serviceFixture(resolvePolicy);
    const commands = createVertexExperienceCommands(h.dependencies);
    await expect(
      commands.decideReview(principal, reviewInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      commands.proposeResearch(principal, researchInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      commands.proposeSimulation(principal, simulationInput)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(resolvePolicy).toHaveBeenCalledTimes(3);
    expect(h.available).not.toHaveBeenCalled();
    expect(h.getCommandReceipt).not.toHaveBeenCalled();
    expect(h.findRecordArtifact).not.toHaveBeenCalled();
    return expect(h.prepareManifest).not.toHaveBeenCalled();
  });

  it("does not resolve policy before account authorization or after cancellation", async () => {
    const resolvePolicy = vi.fn(async () =>
      Object.freeze({ reviewPolicy, policyIdentity: identity })
    );
    const h = serviceFixture(resolvePolicy);
    h.authorize.mockResolvedValue(false);
    await expect(
      createVertexExperienceCommands(h.dependencies).decideReview(
        principal,
        reviewInput
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolvePolicy).not.toHaveBeenCalled();
    h.authorize.mockResolvedValue(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveVertexExperiencePolicy(
        { ...h.dependencies, signal: controller.signal },
        actor,
        scope
      )
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    return expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it("requires a runtime identity while preserving explicit static consumers", async () => {
    const h = serviceFixture(async () => ({ reviewPolicy }));
    await expect(
      resolveVertexExperiencePolicy(h.dependencies, actor, scope)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const legacy = serviceFixture();
    const resolved = await resolveVertexExperiencePolicy(
      legacy.dependencies,
      actor,
      scope
    );
    expect(resolved.reviewPolicy).toEqual(reviewPolicy);
    expect(resolved.reviewPolicy).not.toBe(reviewPolicy);
    expect(resolved.policyIdentity).toBeUndefined();
    return expect(Object.isFrozen(resolved.research!.allowedTools)).toBe(true);
  });

  return it("captures separate frozen bindings for interleaved accounts without mutating dependencies", async () => {
    const first = deferred<VertexExperiencePolicy>();
    const second = deferred<VertexExperiencePolicy>();
    const entered = deferred<void>();
    let count = 0;
    const resolvePolicy = vi.fn(
      async (
        _principal: Parameters<VertexExperiencePolicyResolver>[0],
        target: VertexScope
      ) => {
        expect(Object.isFrozen(target)).toBe(true);
        count += 1;
        if (count === 2) entered.complete(undefined);
        return target.accountAlias === scope.accountAlias
          ? first.promise
          : second.promise;
      }
    ) as VertexExperiencePolicyResolver;
    const h = serviceFixture(resolvePolicy);
    const originalStatic = h.dependencies.reviewPolicy;
    const a = {
      reviewPolicy: { ...reviewPolicy },
      research: {
        ...h.dependencies.research!,
        allowedTools: ["read-evidence"] as (
          | "read-evidence"
          | "propose-strategy"
        )[],
      },
      policyIdentity: { ...identity },
    };
    const b = {
      reviewPolicy: { ...reviewPolicy, version: "2.0.0" },
      research: {
        ...h.dependencies.research!,
        modelVersion: "model-b",
        allowedTools: ["propose-strategy"] as (
          | "read-evidence"
          | "propose-strategy"
        )[],
      },
      policyIdentity: {
        ...identity,
        selectionId: "selection-b",
        selectionSha256: "b".repeat(64),
      },
    };
    const pendingA = resolveVertexExperiencePolicy(
      h.dependencies,
      actor,
      scope
    );
    const pendingB = resolveVertexExperiencePolicy(h.dependencies, actor, {
      ...scope,
      accountAlias: "fixture-b",
    });
    await entered.promise;
    second.complete(b);
    const resolvedB = await pendingB;
    first.complete(a);
    const resolvedA = await pendingA;
    (a.reviewPolicy as { version: string }).version = "9.0.0";
    a.research.allowedTools.push("propose-strategy");
    a.policyIdentity.revision = "999";
    b.research.modelVersion = "mutated-model";
    expect(resolvedA.reviewPolicy!.version).toBe("1.0.0");
    expect(resolvedA.research!.allowedTools).toEqual(["read-evidence"]);
    expect(resolvedA.policyIdentity!.revision).toBe("7");
    expect(resolvedB.reviewPolicy!.version).toBe("2.0.0");
    expect(resolvedB.research!.modelVersion).toBe("model-b");
    expect(resolvedB.policyIdentity!.selectionId).toBe("selection-b");
    expect(Object.isFrozen(resolvedA)).toBe(true);
    expect(Object.isFrozen(resolvedA.policyIdentity)).toBe(true);
    expect(Object.isFrozen(resolvedA.research)).toBe(true);
    return expect(h.dependencies.reviewPolicy).toBe(originalStatic);
  });
});

describe("Vertex runtime atomic command policy guard", () => {
  it("guards a matching duplicate under the same transaction and ordered locks without leaking the pin", async () => {
    const guard = vi.fn(
      async (
        _tx: Transaction,
        _input: Parameters<VertexCommandPolicyGuard>[1]
      ) => true
    );
    const h = await databaseFixture(identity, guard);
    const result = await h.store.getCommandReceipt(actor, scope, h.key);
    expect(result).toEqual(h.result);
    expect(result).not.toHaveProperty("commandPolicy");
    expect(guard).toHaveBeenCalledTimes(2);
    for (const [tx, input] of guard.mock.calls) {
      expect(tx).toBe(h.tx);
      expect(input).toEqual({
        principal: actor,
        scope,
        kind: "research",
        commandPolicy: identity,
        now,
      });
    }
    return expect(
      h.queries.slice(0, 3).map((query) => query.params[0])
    ).toEqual([
      "vertex-authorization:global",
      JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment]),
      JSON.stringify(["vertex", scope.accountAlias, scope.environment]),
    ]);
  });

  it("fails closed when a pin or its configured transaction guard is absent", async () => {
    const guarded = await databaseFixture();
    const { commandPolicy: _pin, ...legacyKey } = guarded.key;
    await expect(
      guarded.store.getCommandReceipt(actor, scope, legacyKey)
    ).rejects.toMatchObject({ code: "denied" });
    expect(guarded.transaction).not.toHaveBeenCalled();
    const missingGuard = await databaseFixture(identity, null);
    await expect(
      missingGuard.store.getCommandReceipt(actor, scope, missingGuard.key)
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(missingGuard.transaction).not.toHaveBeenCalled();
  });

  it("rejects a changed immutable selection, head revision, or legacy duplicate even if the current callback approves", async () => {
    for (const previous of [
      { ...identity, selectionId: "previous-selection" },
      { ...identity, selectionSha256: "c".repeat(64) },
      { ...identity, selectionRevision: "2" },
      { ...identity, revision: "6" },
      null,
    ]) {
      const h = await databaseFixture(previous);
      await expect(
        h.store.getCommandReceipt(actor, scope, h.key)
      ).rejects.toMatchObject({ code: "conflict" });

      expect(
        h.queries.some((query) => query.sql.includes('from "vertex_records"'))
      ).toBe(false);
    }
  });

  it("denies current-policy changes before duplicates and all three command mutations", async () => {
    const guard = vi.fn(async () => false);
    const h = await databaseFixture(identity, guard);
    await expect(
      h.store.getCommandReceipt(actor, scope, h.key)
    ).rejects.toMatchObject({ code: "denied" });
    const reviewKey = await keyFor("review", reviewInput);
    const simulationKey = await keyFor("simulation", simulationInput);
    await expect(
      h.store.recordReviewedEvidence({
        principal: actor,
        scope,
        review: {},
        acceptedEvidence: null,
        ...reviewKey,
      })
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.enqueueResearchProposal({
        principal: actor,
        scope,
        collectionId: researchInput.collectionId,
        record: h.value,
        metadata: h.metadata,
        proposal: h.proposal,
        ...h.key,
      })
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.store.queuePaperSimulation({
        principal: actor,
        scope,
        admission: {},
        ...simulationKey,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(guard).toHaveBeenCalledTimes(4);
    return expect(
      h.queries.every((query) => query.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });

  it("rechecks the policy before returning a fully loaded duplicate", async () => {
    const guard = vi
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const h = await databaseFixture(identity, guard);
    await expect(
      h.store.getCommandReceipt(actor, scope, h.key)
    ).rejects.toMatchObject({ code: "denied" });
    expect(guard).toHaveBeenCalledTimes(2);
    return expect(
      h.queries.some((query) => query.sql.includes('from "vertex_records"'))
    ).toBe(true);
  });

  it("retains legacy static receipt compatibility without upgrading it to runtime policy proof", async () => {
    const h = await databaseFixture(null, null);
    const { commandPolicy: _pin, ...key } = h.key;
    await expect(h.store.getCommandReceipt(actor, scope, key)).resolves.toEqual(
      h.result
    );
    return expect(h.queries[0]!.params[0]).toBe("vertex-authorization:global");
  });

  return it("rechecks revoked grants inside the transaction before any policy or receipt work", async () => {
    const guard = vi.fn(async () => true);
    const h = await databaseFixture(identity, guard);
    h.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      h.store.getCommandReceipt(actor, scope, h.key)
    ).rejects.toMatchObject({ code: "denied" });
    expect(guard).not.toHaveBeenCalled();
    return expect(
      h.queries.every((query) => query.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
});
