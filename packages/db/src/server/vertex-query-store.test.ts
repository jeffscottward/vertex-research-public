import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { PersistenceContext } from "./vertex-persistence-core.ts";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { VertexStoreError } from "./vertex-ports.ts";
import { createQueryOperations } from "./vertex-query-store.ts";

const at = "2026-09-22T12:00:00Z";
const until = "2026-09-22T12:01:00Z";
const principal: VertexPrincipal = { actorId: "synthetic-reader" };
const scope: VertexScope = {
  accountAlias: "synthetic-account",
  environment: "research",
};
const digest = "a".repeat(64);
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
type Row = Record<string, unknown>;
interface Query {
  params: unknown[];
  sql: string;
}
interface RecordFixture {
  metadata: VertexArtifactMetadata;
  row: {
    artifact_id: string;
    collection_key: string;
    contract_name: string;
    record_id: string;
    artifact_sha256: string;
    record_hash: string;
    payload: VertexRecord;
  };
}
const record = async (
  artifactId: string,
  contractName = "StrategySpec",
  value: VertexRecord = {
    schemaVersion: "1.0.0",
    strategyId: "strategy-1",
    version: "1.0.0",
  }
): Promise<RecordFixture> => {
  const artifactSha256 = await hash(value);
  const collectionId =
    contractName === "ResearchEvidence" ? "collection-1" : null;
  const metadata: VertexArtifactMetadata = {
    artifactId,
    scope,
    collectionId,
    objectKey: `vertex/v1/synthetic-account/research/account/manifest/sha256/${artifactSha256}`,
    artifactSha256,
    sourceContentSha256: contractName === "ResearchEvidence" ? digest : null,
    byteLength: 10,
    contentType: "application/json",
    schemaVersion: "1.0.0",
    contractName: contractName as VertexArtifactMetadata["contractName"],
    rights: {
      policyId: "rights-1",
      version: "1.0.0",
      status: "granted",
      allowedUses: ["read"],
      checkedAt: at,
      expiresAt: until,
      retentionUntil: null,
    },
    lineageArtifactIds: [],
    createdAt: at,
  };
  const row = {
    artifact_id: artifactId,
    collection_key: collectionId ?? "",
    contract_name: contractName,
    record_id:
      contractName === "ResearchEvidence" ? "evidence-1" : "strategy-1",
    artifact_sha256: artifactSha256,
    record_hash: artifactSha256,
    payload: value,
  };
  return { row, metadata };
};
const harness = (
  records: RecordFixture[],
  respond?: (query: Query) => Row[]
) => {
  const dialect = new PgDialect();
  const queries: Query[] = [];
  const execute = vi.fn(async (input: SQL) => {
    const query = dialect.sqlToQuery(input);
    queries.push(query);
    if (respond) return { rows: respond(query) };
    return {
      rows: query.sql.includes("from vertex_records r")
        ? records.map((value) => value.row)
        : [],
    };
  });
  const authorize = vi.fn(
    async (
      _actor: VertexPrincipal,
      _scope: VertexScope,
      _collection: string | null,
      _id: string,
      _action?: string,
      _now?: string
    ): Promise<void> => undefined
  );
  const artifact = vi.fn(
    async (
      _tx: unknown,
      _actor: VertexPrincipal,
      _scope: VertexScope,
      _collection: string | null,
      id: string
    ): Promise<VertexArtifactMetadata | null> =>
      records.find((value) => value.metadata.artifactId === id)?.metadata ??
      null
  );
  const validate = vi.fn(async (_name: string, value: unknown) =>
    structuredClone(value)
  );
  const context = {
    now: () => at,
    hash,
    encode: (value: unknown) =>
      new TextEncoder().encode(canonicalArtifactJson(value)),
    digest: (bytes: Uint8Array) => hashArtifact(bytes),
    validate,
    scoped: () => undefined,
    authorize,
    artifact,
    run: (
      _actor: VertexPrincipal,
      _scope: VertexScope,
      _collection: string | null,
      _resource: string,
      _action: string,
      operation: (
        tx: { execute: typeof execute },
        now: string
      ) => Promise<unknown>
    ) => operation({ execute }, at),
  } as unknown as PersistenceContext;
  return {
    queries,
    artifact,
    authorize,
    validate,
    operations: createQueryOperations(context),
  };
};

// Registered fixture graphs isolate repository query behavior; public strict
// schema validation is supplied by production ctx and its separate contract tests.
describe("published Vertex query pages", () => {
  it("requires committed record/catalog join and explicit exact scope/filter SQL", async () => {
    const test = harness([await record("artifact-a")]);
    const page = await test.operations.listArtifacts(principal, scope, {
      contractName: "StrategySpec",
      limit: 10,
      cursor: null,
    });
    expect(page.items.map((item) => item.artifactId)).toEqual(["artifact-a"]);
    expect(page.nextCursor).toBeNull();
    expect(test.queries[0]?.sql).toContain("inner join vertex_artifacts");
    expect(test.queries[0]?.sql).toContain("r.account_alias");
    expect(test.queries[0]?.sql).toContain("r.environment");
    expect(test.queries[0]?.sql).toContain("r.contract_name");
    expect(test.queries[0]?.params).toContain(1000);
  });

  it("filters denied items before page visibility and never emits denied IDs in cursor", async () => {
    const test = harness([
      await record("artifact-a"),
      await record("secret-denied"),
      await record("artifact-z"),
    ]);
    test.artifact.mockImplementation(
      async (_tx, _actor, _scope, _collection, id) => {
        if (id === "secret-denied") throw new VertexStoreError("denied");
        return (await record(id)).metadata;
      }
    );
    const page = await test.operations.listArtifacts(principal, scope, {
      contractName: "StrategySpec",
      limit: 1,
      cursor: null,
    });
    expect(page.items.map((item) => item.artifactId)).toEqual(["artifact-a"]);
    expect(page.nextCursor).not.toBeNull();
    const raw = (page.nextCursor ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const cursor = atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "="));
    expect(cursor).toContain("artifact-a");
    expect(cursor).not.toContain("secret-denied");
  });

  it("binds pagination to actor account collection and exact immutable strategy filter", async () => {
    const test = harness([
      await record("artifact-a"),
      await record("artifact-b"),
    ]);
    const first = await test.operations.listArtifacts(principal, scope, {
      contractName: "StrategySpec",
      limit: 1,
      cursor: null,
    });
    for (const changed of [
      { actor: { actorId: "other" }, scoped: scope, filter: {} },
      {
        actor: principal,
        scoped: { ...scope, accountAlias: "other" },
        filter: {},
      },
      { actor: principal, scoped: scope, filter: { collectionId: null } },
      { actor: principal, scoped: scope, filter: { strategyVersion: "other" } },
    ]) {
      await expect(
        test.operations.listArtifacts(changed.actor, changed.scoped, {
          contractName: "StrategySpec",
          limit: 1,
          cursor: first.nextCursor,
          ...changed.filter,
        })
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("fails honestly rather than leaking cursor IDs after a denied bounded scan", async () => {
    const item = await record("denied-1");
    const test = harness(Array.from({ length: 1000 }, () => item));
    test.artifact.mockRejectedValue(new VertexStoreError("denied"));
    await expect(
      test.operations.listArtifacts(principal, scope, {
        contractName: "StrategySpec",
        limit: 1,
        cursor: null,
      })
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not guess a latest immutable revision or collection on ambiguous record lookup", async () => {
    const test = harness([
      await record("artifact-a"),
      await record("artifact-b"),
    ]);
    await expect(
      test.operations.findRecordArtifact(principal, scope, {
        contractName: "StrategySpec",
        recordId: "strategy-1",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      test.operations.findRecordArtifact(principal, scope, {
        recordId: "strategy-1",
      })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      test.operations.findRecordArtifact(principal, scope, {
        recordId: "strategy-1",
        artifactId: "artifact-a",
        contractName: "StrategySpec",
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("requires source membership in a committed generation for original evidence", async () => {
    const item = await record("evidence-artifact", "ResearchEvidence", {
      schemaVersion: "1.0.0",
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      evidenceId: "evidence-1",
      acceptanceStatus: "unreviewed",
    });
    const test = harness([item]);
    const result = await test.operations.listArtifacts(principal, scope, {
      contractName: "ResearchEvidence",
      collectionId: "collection-1",
      limit: 10,
      cursor: null,
    });
    expect(result.items).toEqual([]);
    expect(
      test.queries.some((query) => query.sql.includes("vertex_claim_evidence"))
    ).toBe(true);
  });

  it("rejects tampered published payloads and preserves unavailable errors", async () => {
    const item = await record("artifact-a");
    item.row.record_hash = "b".repeat(64);
    await expect(
      harness([item]).operations.listArtifacts(principal, scope, {
        contractName: "StrategySpec",
        limit: 10,
        cursor: null,
      })
    ).rejects.toMatchObject({ code: "integrity" });
    const test = harness([await record("artifact-a")]);
    test.artifact.mockRejectedValue(new VertexStoreError("unavailable"));
    await expect(
      test.operations.listArtifacts(principal, scope, {
        contractName: "StrategySpec",
        limit: 10,
        cursor: null,
      })
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([0, 101, -1, 1.5, Number.NaN])(
    "rejects unbounded page size %s before querying",
    async (limit) => {
      const test = harness([]);
      await expect(
        test.operations.listScopeReviews(principal, scope, {
          limit,
          cursor: null,
        })
      ).rejects.toMatchObject({ code: "invalid" });
      expect(test.queries).toEqual([]);
    }
  );

  it("returns only latest current accepted overlay and never rewrites original evidence", async () => {
    const evidence = {
      schemaVersion: "1.0.0",
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      evidenceId: "evidence-1",
      acceptanceStatus: "unreviewed",
    };
    const item = await record(
      "original-artifact",
      "ResearchEvidence",
      evidence
    );
    const review = {
      schemaVersion: "1.0.0",
      reviewId: "review-1",
      artifactId: item.metadata.artifactId,
      artifactSha256: item.metadata.artifactSha256,
      collectionId: "collection-1",
      purpose: "research",
      decision: "accepted",
      reviewedAt: at,
      expiresAt: until,
    };
    const reviewed = { payload: review, record_hash: await hash(review) };
    const test = harness([item], (query) => {
      if (query.sql.includes('from "vertex_records"')) return [item.row];
      if (query.sql.includes('from "vertex_claim_evidence"')) {
        return [{ artifact_id: item.metadata.artifactId }];
      }
      if (query.sql.includes('from "vertex_collection_generations"')) {
        return [{ snapshot_id: "snapshot-1" }];
      }
      if (query.sql.includes('from "vertex_reviews"')) return [reviewed];
      if (query.sql.includes('from "vertex_reviewed_artifact_links"')) {
        return [{ review_id: review.reviewId }];
      }
      return [];
    });
    const result = await test.operations.getAcceptedEvidence(
      principal,
      scope,
      "collection-1",
      "evidence-1"
    );
    expect(result).toEqual({ artifact: item.metadata, evidence, review });
    expect(result?.evidence["acceptanceStatus"]).toBe("unreviewed");
    const reviewQuery = test.queries.find((query) =>
      query.sql.includes('from "vertex_reviews"')
    );
    expect(reviewQuery?.sql).toContain("order by reviewed_at_ns desc");
    expect(reviewQuery?.sql).not.toContain("decision =");
  });

  it.each(["rejected", "expired", "unlinked"])(
    "does not resurrect an older accepted review when current proof is %s",
    async (state) => {
      const item = await record("original-artifact", "ResearchEvidence", {
        schemaVersion: "1.0.0",
        collectionId: "collection-1",
        snapshotId: "snapshot-1",
        evidenceId: "evidence-1",
        acceptanceStatus: "unreviewed",
      });
      const review = {
        schemaVersion: "1.0.0",
        reviewId: "review-newest",
        artifactId: item.metadata.artifactId,
        artifactSha256: item.metadata.artifactSha256,
        collectionId: "collection-1",
        purpose: "research",
        decision: state === "rejected" ? "rejected" : "accepted",
        reviewedAt: at,
        expiresAt: state === "expired" ? at : until,
      };
      const reviewed = { payload: review, record_hash: await hash(review) };
      const test = harness([item], (query) => {
        if (query.sql.includes('from "vertex_records"')) return [item.row];
        if (query.sql.includes('from "vertex_claim_evidence"')) return [{}];
        if (query.sql.includes('from "vertex_collection_generations"')) {
          return [{}];
        }
        if (query.sql.includes('from "vertex_reviews"')) return [reviewed];
        return [];
      });
      expect(
        await test.operations.getAcceptedEvidence(
          principal,
          scope,
          "collection-1",
          "evidence-1"
        )
      ).toBeNull();
      expect(
        test.queries.filter((query) =>
          query.sql.includes('from "vertex_reviews"')
        )
      ).toHaveLength(1);
    }
  );

  it("queries the order/native audit as one explicitly typed union and scoped page", async () => {
    const test = harness([]);
    expect(
      await test.operations.listExecutionProjections(principal, scope, {
        limit: 10,
        cursor: null,
      })
    ).toEqual({ items: [], nextCursor: null });
    expect(test.queries[0]?.sql).toContain("union all");
    expect(test.queries[0]?.sql).toContain("vertex_native_fact_projections");
    expect(test.queries[0]?.sql).toContain(
      "'ExecutionProjection' as contract_name"
    );
    expect(test.queries[0]?.sql).toContain(
      "'NativeFactProjection' as contract_name"
    );
  });

  it("binds audited native fact and proof SQL identity columns independently of stream sequence", async () => {
    const paperScope: VertexScope = { ...scope, environment: "paper" };
    const fact = {
      kind: "cash-settlement",
      settlementId: "settlement-1",
      currency: "USD",
      cashDelta: "1",
      fillEventIds: ["fill-1"],
    };
    const proof = {
      schemaVersion: "1.0.0",
      proofKind: "native-journal-event",
      ...paperScope,
      streamId: "stream-1",
      ownerEpoch: "1",
      sourceEventId: "journal-9",
      journalSequence: "9",
      journalHeadHash: digest,
      factOrdinal: 2,
      occurredAt: at,
      eventType: fact.kind,
      payload: fact,
    };
    const text = canonicalArtifactJson(proof);
    const proofHash = await hashArtifact(new TextEncoder().encode(text));
    const body = {
      schemaVersion: "1.0.0",
      projectionId: "projection-12",
      ...paperScope,
      streamId: "stream-1",
      ownerEpoch: "1",
      sequence: "12",
      proofJournalSequence: "9",
      proofJournalHeadHash: digest,
      factOrdinal: 2,
      previousEventHash: digest,
      occurredAt: at,
      receivedAt: at,
      actorId: "native-emitter",
      policyVersion: "1.0.0",
      expiresAt: until,
      idempotencyKey: "fact-9-2",
      sourceKind: "paper-simulation",
      proof: {
        artifactId: "proof-9-2",
        sha256: proofHash,
        sourceEventId: "journal-9",
      },
      fact,
      authoritative: false,
      reservationAuthority: "native-owner-only",
      executionAuthorized: false,
    };
    const projection = { ...body, eventHash: await hash(body) };
    const factRow: Row = {
      projection_id: body.projectionId,
      event_hash: projection.eventHash,
      payload: projection,
      contract_name: "NativeFactProjection",
      proof_journal_sequence: "9",
      proof_journal_head_hash: digest,
      fact_ordinal: 2,
      fact_kind: fact.kind,
      proof_artifact_id: body.proof.artifactId,
      proof_sha256: proofHash,
      proof_source_event_id: proof.sourceEventId,
    };
    const proofRow: Row = {
      artifact_id: body.proof.artifactId,
      sha256: proofHash,
      byte_length: new TextEncoder().encode(text).byteLength,
      canonical_json: text,
      payload: proof,
      stream_id: proof.streamId,
      owner_epoch: proof.ownerEpoch,
      source_event_id: proof.sourceEventId,
      occurred_at: at,
      event_type: fact.kind,
      journal_sequence: "9",
      journal_head_hash: digest,
      fact_ordinal: 2,
    };
    const run = (factChange: Row = {}, proofChange: Row = {}) => {
      const test = harness([], (query) => {
        if (query.sql.includes("union all")) {
          return [{ ...factRow, ...factChange }];
        }
        if (query.sql.includes('from "vertex_native_journal_proofs"')) {
          return [{ ...proofRow, ...proofChange }];
        }
        return [];
      });
      return {
        ...test,
        result: test.operations.listExecutionProjections(
          principal,
          paperScope,
          { limit: 10, cursor: null }
        ),
      };
    };
    const accepted = run();
    expect((await accepted.result).items).toEqual([projection]);
    expect(accepted.authorize).toHaveBeenCalledWith(
      principal,
      paperScope,
      null,
      proofRow["artifact_id"],
      "read",
      at
    );
    for (const change of [
      { proof_journal_sequence: "12" },
      { proof_journal_head_hash: "b".repeat(64) },
      { fact_ordinal: 3 },
      { proof_source_event_id: "other" },
      { proof_sha256: digest },
      { fact_kind: "assignment" },
    ]) {
      await expect(run(change).result).rejects.toMatchObject({
        code: "integrity",
      });
    }
    for (const change of [
      { journal_sequence: "12" },
      { journal_head_hash: "b".repeat(64) },
      { fact_ordinal: 3 },
      { byte_length: 1 },
      { canonical_json: `${text} ` },
      { source_event_id: "other" },
    ]) {
      await expect(run({}, change).result).rejects.toMatchObject({
        code: "integrity",
      });
    }
  });
});
