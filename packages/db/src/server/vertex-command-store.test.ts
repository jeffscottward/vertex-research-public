import { readFileSync } from "node:fs";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { vertexArtifacts } from "../schema/vertex.ts";
import * as commandSchema from "../schema/vertex-commands.ts";
import type { Database } from "./client.ts";
import { validateVertexCommand } from "./vertex-command-input.ts";
import { createCommandOperations } from "./vertex-command-store.ts";
import { createPersistenceContext } from "./vertex-persistence-core.ts";
import type {
  VertexArtifactMetadata,
  VertexBoundaryContractName,
  VertexCommandKey,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createResearchOperations } from "./vertex-research-store.ts";

// Source-authored tests only. All query results and authoritative-domain outputs
// are registered fixtures; no live SQL engine, provider or object store exists.
const NOW = "2026-09-22T12:00:00.000000001Z";
const BEFORE = "2026-09-22T11:59:00.000000001Z";
const END = "2026-09-22T12:10:00.000000001Z";
const principal = { actorId: "reviewer-1" };
const scope: VertexScope = { accountAlias: "vertex-a", environment: "paper" };
const encoder = new TextEncoder();
const rights = {
  policyId: "policy-1",
  version: "1.0.0",
  status: "granted" as const,
  allowedUses: ["store", "read", "derive"] as const,
  checkedAt: BEFORE,
  expiresAt: END,
  retentionUntil: END,
};
const hash = (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));
type Step = Readonly<{
  match: RegExp;
  rows?: Record<string, unknown>[];
  error?: string;
}>;
const harness = (steps: Step[] = []) => {
  const pending = [...steps];
  const calls: { sql: string; params: unknown[] }[] = [];
  const lifecycle: string[] = [];
  const fixtures = new Map<VertexBoundaryContractName, Set<string>>();
  const authorize = vi.fn(async () => true);
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const compiled = dialect.sqlToQuery(fragment);
    calls.push({ sql: compiled.sql, params: compiled.params });
    if (compiled.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (pending[0]?.match.test(compiled.sql)) {
      const step = pending.shift()!;
      if (step.error) throw new Error(step.error);
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
  const ctx = createPersistenceContext(
    { execute, transaction } as unknown as Database,
    {
      boundary: {
        encode: (value) => encoder.encode(canonicalArtifactJson(value)),
        digest: (bytes) => hashArtifact(bytes),
        validate: async (name, value, version) => {
          if (
            version !== "1.0.0" ||
            !fixtures.get(name)?.has(canonicalArtifactJson(value))
          )
            throw new Error("Unregistered domain fixture");
          return structuredClone(value) as VertexRecord;
        },
      },
      clock: { now: () => NOW },
      authorization: { authorize },
      maxProjectionAgeMs: 60_000,
    }
  );
  const accept = (name: VertexBoundaryContractName, value: unknown): void => {
    if (!fixtures.has(name)) fixtures.set(name, new Set());
    fixtures.get(name)!.add(canonicalArtifactJson(value));
  };
  return {
    ctx,
    commands: createCommandOperations(ctx),
    calls,
    lifecycle,
    transaction,
    authorize,
    accept,
    pending,
  };
};
const commandKey = async (
  kind: VertexCommandKey["kind"],
  command: VertexRecord
): Promise<VertexCommandKey> => ({
  kind,
  command,
  idempotencyKey: command["idempotencyKey"] as string,
  requestHash: await hash({ actorId: principal.actorId, kind, input: command }),
});
const researchCommand = (patch: VertexRecord = {}): VertexRecord => ({
  ...scope,
  question: "What evidence supports the hypothesis?",
  collectionId: "collection-1",
  evidenceIds: [],
  role: "research",
  idempotencyKey: "research-key-1",
  proposalOnly: true,
  executionAuthorized: false,
  ...patch,
});
const reviewCommand = (patch: VertexRecord = {}): VertexRecord => ({
  ...scope,
  artifactId: "strategy-artifact-1",
  artifactSha256: "a".repeat(64),
  strategyVersion: "strategy-artifact-1",
  decision: "accepted",
  purpose: "research",
  expectedReviewId: null,
  idempotencyKey: "review-key-1",
  ...patch,
});
const simulationCommand = (patch: VertexRecord = {}): VertexRecord => ({
  ...scope,
  admissionId: "admission-1",
  reviewId: "review-1",
  reviewVersion: "1.0.0",
  intentId: "intent-1",
  intentSha256: "a".repeat(64),
  strategyVersion: "strategy-1",
  idempotencyKey: "simulation-key-1",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
  ...patch,
});
const metadata = async (
  value: VertexRecord,
  contractName: VertexArtifactMetadata["contractName"],
  artifactId: string,
  collectionId: string | null
): Promise<VertexArtifactMetadata> => ({
  artifactId,
  scope,
  collectionId,
  objectKey: `sealed/${artifactId}.json`,
  artifactSha256: await hash(value),
  sourceContentSha256:
    typeof value["contentHash"] === "string" ? value["contentHash"] : null,
  byteLength: encoder.encode(canonicalArtifactJson(value)).byteLength,
  contentType: "application/json",
  schemaVersion: "1.0.0",
  contractName,
  rights,
  lineageArtifactIds: [],
  createdAt: BEFORE,
});
const artifactRow = async (value: VertexArtifactMetadata) => ({
  artifact_id: value.artifactId,
  collection_key: value.collectionId ?? "",
  metadata_hash: await hash(value),
  payload: value,
});
const policyRow = async () => ({
  payload: rights,
  record_hash: await hash(rights),
});
const recordRow = (value: VertexRecord, a: VertexArtifactMetadata) => ({
  artifact_id: a.artifactId,
  collection_key: a.collectionId ?? "",
  artifact_sha256: a.artifactSha256,
  record_hash: a.artifactSha256,
  contract_name: a.contractName,
  payload: value,
});
const artifactSteps = async (a: VertexArtifactMetadata): Promise<Step[]> => [
  { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
  { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
];
// Later reads in the same transaction reuse the current rights head.
const repeatedArtifactSteps = async (
  a: VertexArtifactMetadata
): Promise<Step[]> => [
  { match: /from "vertex_artifacts"/, rows: [await artifactRow(a)] },
];
const reviewFixture = async () => {
  const strategy: VertexRecord = {
    schemaVersion: "1.0.0",
    strategyId: "strategy-1",
    version: "1.0.0",
    riskLimits: {
      maximumLoss: "100",
      maximumNotional: "1000",
      maximumPositions: 1,
    },
  };
  const a = await metadata(
    strategy,
    "StrategySpec",
    "strategy-artifact-1",
    null
  );
  const command = reviewCommand({ artifactSha256: a.artifactSha256 });
  const key = await commandKey("review", command);
  const review: VertexRecord = {
    schemaVersion: "1.0.0",
    reviewId: `review-${key.requestHash}`,
    ...scope,
    collectionId: null,
    artifactId: a.artifactId,
    artifactSha256: a.artifactSha256,
    reviewVersion: "1.0.0",
    decision: "accepted",
    purpose: "research",
    actorId: principal.actorId,
    reviewedAt: NOW,
    expiresAt: END,
    policyVersion: "1.0.0",
    strategyVersion: a.artifactId,
    supersedesReviewId: null,
    executionAuthorized: false,
  };
  const record = recordRow(strategy, a);
  const steps: Step[] = [
    { match: /from "vertex_command_receipts"/, rows: [] },
    { match: /from "vertex_records"/, rows: [record] },
    ...(await artifactSteps(a)),
    ...(await repeatedArtifactSteps(a)),
    { match: /from "vertex_records"/, rows: [record] },
    { match: /from "vertex_records"/, rows: [record] },
    ...(await repeatedArtifactSteps(a)),
    { match: /from "vertex_reviews"/, rows: [] },
    { match: /from "vertex_reviews"/, rows: [] },
  ];
  return {
    strategy,
    a,
    command,
    key,
    review,
    record,
    steps,
    input: {
      principal,
      scope,
      review,
      acceptedEvidence: null,
      idempotencyKey: key.idempotencyKey,
      requestHash: key.requestHash,
      command,
    },
  };
};

describe("strict actor-bound immutable commands", () => {
  it.each(["review", "research", "simulation"] as const)(
    "accepts only the exact frozen %s command shape",
    async (kind) => {
      const h = harness();
      const command =
        kind === "review"
          ? reviewCommand()
          : kind === "research"
            ? researchCommand()
            : simulationCommand();
      const key = await commandKey(kind, command);
      expect(await validateVertexCommand(h.ctx, principal, scope, key)).toEqual(
        command
      );
      const extra = { ...command, executionAuthority: true };
      return await expect(
        validateVertexCommand(
          h.ctx,
          principal,
          scope,
          await commandKey(kind, extra)
        )
      ).rejects.toMatchObject({ code: "invalid" });
    }
  );
  it("binds the original command hash to actor/kind/scope/key rather than generated clocks", async () => {
    const h = harness();
    const key = await commandKey("research", researchCommand());
    await expect(
      h.commands.getCommandReceipt({ actorId: "other-actor" }, scope, key)
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      h.commands.getCommandReceipt(
        principal,
        { ...scope, environment: "live" },
        key
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.commands.getCommandReceipt(principal, scope, {
        ...key,
        idempotencyKey: "different-key",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(h.calls).toEqual([]);
  });
  it("matches authoritative UTF-16 question bounds and rejects controls/duplicate evidence", async () => {
    const h = harness();
    for (const command of [
      researchCommand({ question: "short" }),
      researchCommand({ question: "a".repeat(2001) }),
      researchCommand({ question: "invalid\nquestion" }),
      researchCommand({ evidenceIds: ["evidence-1", "evidence-1"] }),
      researchCommand({ role: "broker-trading" }),
    ]) {
      await expect(
        validateVertexCommand(
          h.ctx,
          principal,
          scope,
          await commandKey("research", command)
        )
      ).rejects.toMatchObject({ code: "invalid" });
    }
    return expect(h.calls).toEqual([]);
  });
  it("rejects all nonnull accepted derivatives before receipt lookup or writes", async () => {
    const f = await reviewFixture();
    const h = harness();
    await expect(
      h.commands.recordReviewedEvidence({
        ...f.input,
        acceptedEvidence: { record: {}, metadata: f.a },
      } as never)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  it("authorizes before returning even an unseen receipt", async () => {
    const h = harness();
    h.authorize.mockResolvedValue(false);
    await expect(
      h.commands.getCommandReceipt(
        principal,
        scope,
        await commandKey("research", researchCommand())
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  it("receipt primary lookup includes actor, exact scope, kind and key", async () => {
    const h = harness([{ match: /from "vertex_command_receipts"/, rows: [] }]);
    const key = await commandKey("research", researchCommand());
    expect(
      await h.commands.getCommandReceipt(principal, scope, key)
    ).toBeNull();
    const receipts = h.calls.filter((entry) =>
      entry.sql.includes('from "vertex_command_receipts"')
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.params).toEqual([
      scope.accountAlias,
      scope.environment,
      principal.actorId,
      "research",
      key.idempotencyKey,
    ]);
    return expect(h.authorize).toHaveBeenCalled();
  });
  return it("reused actor/key with changed content conflicts before exposing old results", async () => {
    const h = harness([
      {
        match: /from "vertex_command_receipts"/,
        rows: [{ request_hash: "f".repeat(64) }],
      },
    ]);
    return await expect(
      h.commands.getCommandReceipt(
        principal,
        scope,
        await commandKey("review", reviewCommand())
      )
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("original immutable review overlay transaction", () => {
  it("commits review, original-artifact link, internal outbox and receipt in one transaction", async () => {
    const f = await reviewFixture();
    const h = harness(f.steps);
    h.accept("StrategySpec", f.strategy);
    h.accept("AcceptedReview", f.review);
    expect(await h.commands.recordReviewedEvidence(f.input)).toEqual({
      review: f.review,
      acceptedEvidenceArtifactId: null,
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(h.pending).toEqual([]);
    for (const table of [
      "vertex_reviews",
      "vertex_reviewed_artifact_links",
      "vertex_outbox",
      "vertex_command_receipts",
    ]) {
      expect(
        h.calls.some((entry) => entry.sql.startsWith(`insert into "${table}"`))
      ).toBe(true);
    }
    return expect(
      h.calls.some((entry) =>
        /insert into "vertex_(artifacts|records|evidence|collection_generations)"|update vertex_collections/.test(
          entry.sql
        )
      )
    ).toBe(false);
  });
  it("rolls back the review if overlay or receipt persistence fails", async () => {
    for (const table of [
      "vertex_reviewed_artifact_links",
      "vertex_command_receipts",
    ]) {
      const f = await reviewFixture();
      const h = harness([
        ...f.steps,
        {
          match: new RegExp(`insert into "${table}"`),
          error: "synthetic storage failure",
        },
      ]);
      h.accept("StrategySpec", f.strategy);
      h.accept("AcceptedReview", f.review);
      await expect(
        h.commands.recordReviewedEvidence(f.input)
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(h.transaction).toHaveBeenCalledTimes(1);
      expect(h.lifecycle).toEqual(["begin", "rollback"]);
    }
  });
  it("denies stale/rejected replacement on receipt replay rather than returning older accepted proof", async () => {
    const f = await reviewFixture();
    const result = { review: f.review, acceptedEvidenceArtifactId: null };
    const h = harness([
      {
        match: /from "vertex_command_receipts"/,
        rows: [
          {
            request_hash: f.key.requestHash,
            command: f.command,
            result,
            result_hash: await hash(result),
          },
        ],
      },
      { match: /from "vertex_records"/, rows: [f.record] },
      ...(await artifactSteps(f.a)),
      {
        match: /from "vertex_reviews"/,
        rows: [{ review_id: "newer-rejection" }],
      },
    ]);
    h.accept("StrategySpec", f.strategy);
    h.accept("AcceptedReview", f.review);
    await expect(
      h.commands.getCommandReceipt(principal, scope, f.key)
    ).rejects.toMatchObject({ code: "stale" });
    return expect(
      h.calls.some((entry) => entry.sql.startsWith("insert into"))
    ).toBe(false);
  });
  return it("does not return a stored receipt with altered result bytes", async () => {
    const f = await reviewFixture();
    const h = harness([
      {
        match: /from "vertex_command_receipts"/,
        rows: [
          {
            request_hash: f.key.requestHash,
            command: f.command,
            result: {
              review: f.review,
              acceptedEvidenceArtifactId: "forged-accepted",
            },
            result_hash: "0".repeat(64),
          },
        ],
      },
    ]);
    return await expect(
      h.commands.getCommandReceipt(principal, scope, f.key)
    ).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("atomic proposal and simulation queue boundaries", () => {
  it("registers a staged queued AgentRun only inside proposal/receipt/outbox commit", async () => {
    const command = researchCommand();
    const key = await commandKey("research", command);
    const value: VertexRecord = {
      schemaVersion: "1.0.0",
      runId: "agent-1",
      agentRole: "research",
      taskContract: "task-1",
      allowedTools: [],
      modelVersion: null,
      inputEvidenceIds: [],
      outputArtifactIds: [],
      tokenBudget: 10,
      costBudgetUsd: "1",
      status: "queued",
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    };
    const a = await metadata(
      value,
      "AgentRun",
      "agent-artifact-1",
      "collection-1"
    );
    const proposal = {
      question: command["question"] as string,
      evidenceIds: [] as string[],
      role: "research",
      proposalOnly: true as const,
      executionAuthorized: false as const,
    };
    const identity = {
      schemaVersion: "1.0.0",
      eventType: "agent.recorded",
      occurredAt: NOW,
      effectiveAt: NOW,
      correlationId: `research-${key.requestHash}`,
      causationId: null,
      actorId: principal.actorId,
      moduleId: "vertex-persistence",
      moduleVersion: "1.0.0",
      environment: scope.environment,
      idempotencyKey: `research-${key.requestHash}`,
      payload: value,
    };
    const event = {
      ...identity,
      eventId: `event-${await hash(identity)}`,
      receivedAt: NOW,
    };
    const steps: Step[] = [
      { match: /from "vertex_command_receipts"/, rows: [] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
      { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
      { match: /from "vertex_artifacts"/, rows: [] },
      ...(await repeatedArtifactSteps(a)),
      { match: /from "vertex_record_idempotency"/, rows: [] },
      { match: /from "vertex_records"/, rows: [] },
      { match: /from "vertex_outbox"/, rows: [] },
    ];
    const h = harness(steps);
    h.accept("AgentRun", value);
    h.accept("EventEnvelope", event);
    expect(
      await h.commands.enqueueResearchProposal({
        principal,
        scope,
        collectionId: "collection-1",
        record: value,
        metadata: a,
        proposal,
        command,
        idempotencyKey: key.idempotencyKey,
        requestHash: key.requestHash,
      })
    ).toEqual({ artifactId: a.artifactId, sha256: a.artifactSha256, value });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(
      h.calls.some((entry) =>
        /insert into "vertex_research_proposals"/.test(entry.sql)
      )
    ).toBe(true);
    return expect(
      h.calls.some((entry) =>
        /insert into "vertex_command_receipts"/.test(entry.sql)
      )
    ).toBe(true);
  });
  it("rejects agent input/proposal mismatch before staged metadata is registered", async () => {
    const command = researchCommand();
    const key = await commandKey("research", command);
    const value = {
      schemaVersion: "1.0.0",
      agentRole: "research",
      inputEvidenceIds: [],
      outputArtifactIds: ["invented-output"],
      errors: [],
      status: "queued",
      executionAuthorized: false,
    };
    const a = await metadata(
      value,
      "AgentRun",
      "agent-artifact-1",
      "collection-1"
    );
    const h = harness([{ match: /from "vertex_command_receipts"/, rows: [] }]);
    h.accept("AgentRun", value);
    await expect(
      h.commands.enqueueResearchProposal({
        principal,
        scope,
        collectionId: "collection-1",
        record: value,
        metadata: a,
        proposal: {
          question: command["question"] as string,
          evidenceIds: [],
          role: "research",
          proposalOnly: true,
          executionAuthorized: false,
        },
        command,
        idempotencyKey: key.idempotencyKey,
        requestHash: key.requestHash,
      })
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(
      h.calls.some((entry) => entry.sql.startsWith("insert into"))
    ).toBe(false);
  });
  return it("does not bypass exact simulation binding or create a broker submission", async () => {
    const command = simulationCommand();
    const key = await commandKey("simulation", command);
    const admission = {
      ...command,
      schemaVersion: "1.0.0",
      actorId: "foreign-reviewer",
    };
    const h = harness([{ match: /from "vertex_command_receipts"/, rows: [] }]);
    h.accept("PaperSimulationAdmission", admission);
    await expect(
      h.commands.queuePaperSimulation({
        principal,
        scope,
        admission,
        command,
        idempotencyKey: key.idempotencyKey,
        requestHash: key.requestHash,
      })
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(
      h.calls.some((entry) => entry.sql.startsWith("insert into"))
    ).toBe(false);
  });
});

describe("command schema source retention", () => {
  it("same-byte object keys permit independent immutable aliases", () => {
    const index = getTableConfig(vertexArtifacts).indexes.find(
      (entry) => entry.config.name === "vertex_artifact_object"
    )!;
    expect(index.config.unique).toBe(false);
    // Retained pre-consolidation source, not a claim of migration registration.
    const migration = readFileSync(
      new URL(
        "../../migration-sources/0008_vertex_buildout/forward/0008_vertex_substrate.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(migration).toContain("CREATE INDEX vertex_artifact_object");
    return expect(migration).not.toContain(
      "CREATE UNIQUE INDEX vertex_artifact_object"
    );
  });
  return it("normalizes receipts and original-only overlays with a guarded empty-only reverse", () => {
    const migration = readFileSync(
      new URL(
        "../../migration-sources/0008_vertex_buildout/forward/0012_vertex_commands.sql",
        import.meta.url
      ),
      "utf8"
    );
    const rollback = readFileSync(
      new URL(
        "../../migration-sources/0008_vertex_buildout/rollback/0012_vertex_commands.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    const names = [...migration.matchAll(/CREATE TABLE (vertex_[a-z_]+)/g)]
      .map((match) => match[1]!)
      .sort();
    expect(names).toEqual(
      Object.values(commandSchema)
        .map((table) => getTableConfig(table).name)
        .sort()
    );
    expect(names).toEqual(
      [...rollback.matchAll(/DROP TABLE (vertex_[a-z_]+)/g)]
        .map((match) => match[1]!)
        .sort()
    );
    expect(migration).not.toContain("accepted_artifact_id");
    expect(rollback.indexOf("RAISE EXCEPTION")).toBeLessThan(
      rollback.indexOf("DROP TABLE")
    );
    expect(rollback).toContain("IN ACCESS EXCLUSIVE MODE");
    return expect(rollback).not.toMatch(/CASCADE|TRUNCATE|DELETE FROM/);
  });
});

describe("source flags and byte aliases are not review authority", () => {
  it("rejects accepted source evidence through ordinary recordImmutable before publication", async () => {
    const value = {
      schemaVersion: "1.0.0",
      evidenceId: "evidence-1",
      collectionId: "collection-1",
      acceptanceStatus: "accepted",
    };
    const a = await metadata(
      value,
      "ResearchEvidence",
      "evidence-artifact-1",
      "collection-1"
    );
    const h = harness();
    h.accept("ResearchEvidence", value);
    await expect(
      createResearchOperations(h.ctx).recordImmutable({
        principal,
        scope,
        collectionId: "collection-1",
        contractName: "ResearchEvidence",
        record: value,
        artifact: a,
        idempotencyKey: "ordinary-accepted-1",
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.calls.every((entry) => entry.sql.includes("pg_advisory_xact_lock"))
    ).toBe(true);
  });
  it("rejects accepted import flags even before an idempotent generation lookup", async () => {
    const knowledge = {
      schemaVersion: "1.0.0",
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      sourceIdentities: [],
      unavailableSources: [],
      duplicateMappings: [],
      rightsPolicyId: rights.policyId,
      contentClass: "article",
      transcriptQuality: "not-applicable",
      retrievalScope: "collection-only",
      replacementScope: "collection-snapshot",
      untrustedContent: true,
    };
    const evidence = {
      schemaVersion: "1.0.0",
      evidenceId: "evidence-1",
      collectionId: "collection-1",
      acceptanceStatus: "accepted",
    };
    const importMetadata = await metadata(
      knowledge,
      "KnowledgeImport",
      "import-1",
      "collection-1"
    );
    const evidenceMetadata = await metadata(
      evidence,
      "ResearchEvidence",
      "evidence-artifact-1",
      "collection-1"
    );
    const h = harness();
    h.accept("KnowledgeImport", knowledge);
    h.accept("ResearchEvidence", evidence);
    await expect(
      createResearchOperations(h.ctx).publication(
        {
          principal,
          scope,
          collectionId: "collection-1",
          expectedActiveSnapshotId: null,
          imports: [{ record: knowledge, artifact: importMetadata }],
          evidence: [{ record: evidence, artifact: evidenceMetadata }],
          datasets: [],
          idempotencyKey: "publication-1",
        },
        async () => "recorded"
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.calls).toEqual([]);
  });
  return it("records distinct immutable aliases pointing at the same sealed bytes", async () => {
    const value = { schemaVersion: "1.0.0" };
    const first = await metadata(value, "DatasetManifest", "alias-1", null);
    const second = { ...first, artifactId: "alias-2" };
    const steps: Step[] = [];
    for (const _item of [first, second]) {
      steps.push(
        { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
        { match: /from "vertex_rights_versions"/, rows: [await policyRow()] },
        { match: /from "vertex_artifacts"/, rows: [] }
      );
    }
    const h = harness(steps);
    const research = createResearchOperations(h.ctx);
    expect(await research.registerArtifact(principal, first)).toBe("recorded");
    expect(await research.registerArtifact(principal, second)).toBe("recorded");
    const writes = h.calls.filter((entry) =>
      entry.sql.startsWith('insert into "vertex_artifacts"')
    );
    expect(writes).toHaveLength(2);
    expect(
      writes.every((entry) => entry.params.includes(first.objectKey))
    ).toBe(true);
    expect(writes[0]!.params).toContain("alias-1");
    return expect(writes[1]!.params).toContain("alias-2");
  });
});
