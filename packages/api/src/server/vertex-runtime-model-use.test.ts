import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  createVertexRuntimeModelUse,
  vertexRuntimeModelUseBoundary,
} from "./vertex-runtime-model-use.ts";
import {
  createVertexRuntimeModelEvidence,
  VertexRuntimeModelBudgetPolicySchema,
} from "./vertex-runtime-model-evidence.ts";
import {
  fixtureSelection,
  fixtureAt,
  fixtureExpires,
  fixtureScope,
  fixturePrincipal,
  fixtureDigest,
} from "../contracts/vertex-policy.test-support.ts";
import {
  computeRuntimePolicySelectionHash,
  parseRuntimePolicySelection,
  type RuntimePolicySelection,
} from "../contracts/vertex-policy.ts";
import {
  computeModelUseRequestHash,
  parseModelUseRequest,
} from "../contracts/vertex-model-use.ts";

// Authored during the source-only implementation phase; deliberately unexecuted.
// SQL is an in-memory transaction double, never a live DB or object backend.
const bytesOf = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const ns = timestampToEpochNanoseconds;
const harness = async (maximumCostUsd = "1") => {
  const dialect = new PgDialect();
  const input = new TextEncoder().encode("synthetic prompt");
  const objects = new Map<string, Uint8Array>();
  const documents = new Map<string, Uint8Array>();
  const stages = new Map<string, Record<string, unknown>>();
  const persisted = new Map<string, Record<string, unknown>[]>();
  const selected = await fixtureSelection();
  const budgetPolicy = {
    format: "vertex-model-budget-policy-v1",
    ...fixtureScope,
    policyId: "policy-provider-budget",
    policyVersion: "1.0.0",
    periodId: "synthetic-period",
    startsAt: fixtureAt,
    expiresAt: fixtureExpires,
    maximumTokens: 10_000,
    maximumCostUsd: "10",
    chargeProfile: "approved-grant-ceiling-v1",
    unknownOutcome: "retain-charge",
  };
  const rights = {
    policyId: "synthetic-source-rights",
    version: "1.0.0",
    status: "granted",
    allowedUses: ["read"],
    checkedAt: fixtureAt,
    expiresAt: fixtureExpires,
    retentionUntil: fixtureExpires,
  };
  const stage = async (id: string, bytes: Uint8Array, canonical = true) => {
    const sha = await hashArtifact(bytes);
    const key = `vertex/v1/${fixtureScope.accountAlias}/paper/account/${canonical ? "manifest" : "content"}/sha256/${sha}`;
    const descriptor = {
      artifactId: id,
      contentSha256: sha,
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
    };
    stages.set(id, {
      artifact_id: id,
      job_id: "synthetic-job",
      collection_key: "",
      content_sha256: sha,
      canonical_sha256: canonical ? sha : null,
      object_key: key,
      byte_length: bytes.byteLength,
      request_hash: await hashArtifact(descriptor),
      payload: descriptor,
    });
    objects.set(key, bytes);
    documents.set(id, bytes);
    return {
      artifactId: id,
      artifactSha256: sha,
      contractName: "SyntheticPrivateModelEvidence",
      schemaVersion: "1.0.0",
    };
  };
  const tokenizer = await stage(
    "synthetic-tokenizer",
    bytesOf({ tokenizer: "synthetic-v1" })
  );
  const pricing = {
    currency: "USD",
    basis: "conservative-input-byte-output-token-ceiling",
    tokenizationBaseUsd: "0.01",
    tokenizationInputByteUsd: "0.01",
    completionBaseUsd: "0.01",
    completionInputByteUsd: "0.01",
    outputTokenUsd: "0.01",
    expiresAt: fixtureExpires,
  };
  const descriptor = {
    format: "vertex-model-binding-v1",
    ...fixtureScope,
    providerId: "synthetic-provider",
    modelVersion: "synthetic-model-v1",
    tokenizerArtifactId: tokenizer.artifactId,
    tokenizerSha256: tokenizer.artifactSha256,
    endpointReferenceId: "synthetic-endpoint",
    endpointSha256: fixtureDigest,
    modelUsePolicyVersion: "1.0.0",
    expiresAt: fixtureExpires,
    pricing,
  };
  const model = await stage("synthetic-model-descriptor", bytesOf(descriptor));
  const capability = await stage(
    "synthetic-capability",
    bytesOf({ fact: "synthetic-ready-model-evidence" })
  );
  const budget = await stage("synthetic-budget", bytesOf(budgetPolicy));
  const inputPin = await stage("synthetic-input", input, false);
  const rawSelection = {
    ...selected,
    references: selected.references.map((entry) => ({
      ...entry,
      verificationState: "verified",
      lastVerifiedAt: fixtureAt,
    })),
    research: { ...selected.research!, tokenBudget: 1000, costBudgetUsd: "2" },
    artifacts: [
      { bindingId: "model", role: "model", artifact: model },
      { bindingId: "tokenizer", role: "tokenizer", artifact: tokenizer },
    ],
    policies: selected.policies.map((entry) =>
      entry.role === "provider-budget" ? { ...entry, artifact: budget } : entry
    ),
    providerCapabilities: selected.providerCapabilities.map((entry) => ({
      ...entry,
      evidenceArtifact: capability,
    })),
  };
  const selection = await parseRuntimePolicySelection({
    ...rawSelection,
    // Fixture artifact pins carry the literal "1.0.0" schema version at runtime.
    selectionSha256: await computeRuntimePolicySelectionHash(
      rawSelection as RuntimePolicySelection
    ),
  });
  const rawRequest = {
    schemaVersion: "1.0.0",
    ...fixtureScope,
    researchPrincipalId: fixturePrincipal.actorId,
    consumerServiceId: "synthetic-host",
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    providerId: descriptor.providerId,
    modelVersion: descriptor.modelVersion,
    tokenizerArtifactId: tokenizer.artifactId,
    tokenizerSha256: tokenizer.artifactSha256,
    endpointReferenceId: descriptor.endpointReferenceId,
    endpointSha256: descriptor.endpointSha256,
    modelUsePolicyVersion: "1.0.0",
    requestId: "synthetic-request",
    requestSha256: fixtureDigest,
    jobId: "synthetic-job",
    leaseId: "synthetic-lease",
    leaseEpoch: "1",
    grantId: "synthetic-independent-model-grant",
    grantVersion: "1.0.0",
    operation: "model-completion",
    purpose: "research",
    tools: ["read-evidence"],
    evidence: [],
    inputSha256: inputPin.artifactSha256,
    inputBytes: input.byteLength,
    inputTokens: 3,
    maximumOutputTokens: 10,
    maximumCostUsd: "1",
    deadlineAt: fixtureExpires,
  };
  rawRequest.maximumCostUsd = maximumCostUsd;
  const request = await parseModelUseRequest({
    ...rawRequest,
    requestSha256: await computeModelUseRequestHash(
      rawRequest as Parameters<typeof computeModelUseRequestHash>[0]
    ),
  });
  const privacy = await stage(
    "synthetic-privacy",
    bytesOf({
      format: "vertex-model-privacy-decision-v1",
      request,
      policyId: "synthetic-privacy-policy",
      policyVersion: "1.0.0",
      issuedByActorId: "synthetic-privacy-reviewer",
      decidedAt: fixtureAt,
      expiresAt: fixtureExpires,
      decision: "allow-model-processing",
      executionAuthorized: false,
    })
  );
  const lease = {
    schemaVersion: "1.0.0",
    jobId: request.jobId,
    eventId: "synthetic-event",
    kind: "research-run",
    researchPrincipalId: fixturePrincipal.actorId,
    ...fixtureScope,
    payloadArtifactId: "synthetic-payload",
    payloadSha256: fixtureDigest,
    policySelectionId: selection.selectionId,
    policySelectionSha256: selection.selectionSha256,
    deadlineAt: fixtureExpires,
    leaseId: request.leaseId,
    leaseEpoch: "1",
    leaseExpiresAt: fixtureExpires,
    attempt: 1,
  };
  const job: Record<string, unknown> = {
    job_id: request.jobId,
    event_id: lease.eventId,
    grant_id: "synthetic-service-grant",
    state: "running",
    lease_id: request.leaseId,
    lease_epoch: "1",
    lease_expires_at_ns: ns(fixtureExpires).toString(),
    deadline_at_ns: ns(fixtureExpires).toString(),
    attempt: 1,
    payload: lease,
  };
  const service = {
    grantId: "synthetic-service-grant",
    servicePrincipalId: "synthetic-host",
    ...fixtureScope,
    operations: ["currentModelUse"],
    issuedAt: fixtureAt,
    expiresAt: fixtureExpires,
    revokedAt: null,
  };
  const serviceRow: Record<string, unknown> = {
    grant_id: service.grantId,
    service_principal_id: service.servicePrincipalId,
    payload: service,
    record_hash: await hashArtifact(service),
    issued_at_ns: ns(fixtureAt).toString(),
    expires_at_ns: ns(fixtureExpires).toString(),
    revoked_at: null,
  };
  const rightsRow: Record<string, unknown> = {
    payload: rights,
    record_hash: await hashArtifact(rights),
    version: rights.version,
    status: rights.status,
    checked_at_ns: ns(fixtureAt).toString(),
    expires_at_ns: ns(fixtureExpires).toString(),
    retention_until_ns: ns(fixtureExpires).toString(),
  };
  let admitted = true;
  let acl = true;
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    const text = compiled.sql;
    const p = compiled.params;
    if (text.includes("vertex_grant_bindings")) {
      if (!acl) return { rows: [] };
      const binding = {
        grantId: "synthetic-read-grant",
        granteeActorId: p[2],
        scope: { accountAlias: p[0], environment: p[1] },
        collectionId: p[3] === "" ? null : p[3],
        resourceId: p[4],
        actions: ["read"],
      };
      const version = {
        ...binding,
        version: "1.0.0",
        revision: "1",
        status: "granted",
        validFrom: fixtureAt,
        expiresAt: fixtureExpires,
        recordedAt: fixtureAt,
        recordedByActorId: "synthetic-admin",
      };
      return {
        rows: [
          {
            account_alias: p[0],
            environment: p[1],
            grant_id: binding.grantId,
            grantee_actor_id: p[2],
            collection_key: p[3],
            resource_id: p[4],
            binding_payload: binding,
            binding_hash: await hashArtifact(binding),
            version_payload: version,
            payload: version,
            record_hash: await hashArtifact(version),
            current_version: "1.0.0",
            current_revision: "1",
            version_name: "1.0.0",
            version_revision: "1",
            revision: "1",
            version_status: "granted",
            valid_from_ns: ns(fixtureAt).toString(),
            expires_at_ns: ns(fixtureExpires).toString(),
            recorded_at_ns: ns(fixtureAt).toString(),
          },
        ],
      };
    }
    for (const [table, rows] of persisted)
      if (text.includes(`"${table}"`)) return { rows };
    if (text.includes('"vertex_worker_jobs"')) return { rows: [job] };
    if (text.includes('"vertex_worker_run_admissions"'))
      return {
        rows: admitted ? [{ lease_epoch: "1", admitted_at: fixtureAt }] : [],
      };
    if (text.includes('"vertex_worker_service_grants"'))
      return { rows: [serviceRow] };
    if (text.includes('"vertex_rights_versions"')) return { rows: [rightsRow] };
    if (text.includes('"vertex_artifacts"')) return { rows: [] };
    if (text.includes('"vertex_worker_stages"'))
      return {
        rows: stages.has(String(p[2])) ? [stages.get(String(p[2]))!] : [],
      };
    throw new Error("Unexpected synthetic SQL");
  });
  const tx = { execute } as unknown as Transaction;
  const db = {
    execute,
    transaction: vi.fn(
      async (operation: (value: Transaction) => Promise<unknown>) =>
        operation(tx)
    ),
  } as unknown as Database;
  const clock = { now: vi.fn(() => fixtureAt) };
  const getBounded = vi.fn(async (key: string, maximum: number) => {
    const body = objects.get(key);
    if (!body || body.byteLength > maximum)
      return { status: "unavailable" } as const;
    return {
      status: "ok",
      value: {
        body,
        metadata: {
          key,
          size: body.byteLength,
          contentType: "application/json",
          checksum: await hashArtifact(body),
        },
      },
    } as const;
  });
  const options = {
    db,
    clock,
    objectCapabilities: vi.fn(() => ({ getBounded })),
    policySelection: vi.fn(async () => selection),
    readSelectedArtifact: vi.fn(
      async (
        _tx: Transaction,
        _principal: unknown,
        _scope: unknown,
        pin: { artifactId: string }
      ) => new Uint8Array(documents.get(pin.artifactId)!)
    ),
    requestEvidence: [
      {
        ...fixtureScope,
        jobId: request.jobId,
        requestSha256: request.requestSha256,
        inputArtifactId: inputPin.artifactId,
        inputCollectionId: null,
        privacyDecision: privacy,
        privacyIssuerActorId: "synthetic-privacy-reviewer",
      },
    ],
    privilegedAuthorization: { authorize: vi.fn(async () => false) },
  };
  const runtime = createVertexRuntimeModelUse(
    options as unknown as Parameters<typeof createVertexRuntimeModelUse>[0]
  );
  return {
    runtime,
    options,
    tx,
    job,
    serviceRow,
    rightsRow,
    rights,
    stages,
    objects,
    documents,
    persisted,
    request,
    budgetPolicy,
    execute,
    getBounded,
    setAdmitted: (value: boolean) => {
      return (admitted = value);
    },
    setAcl: (value: boolean) => {
      return (acl = value);
    },
    context: () =>
      runtime.currentUseContext(tx, fixturePrincipal, request, fixtureAt),
  };
};

const acceptedFixture = async () => {
  const h = await harness();
  const content = new TextEncoder().encode(
    "Synthetic evidence source, not production information."
  );
  const contentHash = await hashArtifact(content);
  const collectionId = "synthetic-collection";
  const evidence = {
    schemaVersion: "1.0.0",
    evidenceId: "synthetic-evidence",
    collectionId,
    snapshotId: "synthetic-snapshot",
    sourceType: "article",
    sourceUri: "https://example.com/synthetic-evidence",
    sourceIdentity: {
      provider: "synthetic-provider",
      sourceId: "synthetic-source",
      snapshotId: "synthetic-snapshot",
      contentHash,
    },
    sourceLocator: "synthetic section",
    attribution: "synthetic author",
    publishedAt: null,
    capturedAt: fixtureAt,
    contentHash,
    claim: "synthetic claim",
    method: "synthetic method",
    limitations: [],
    acceptanceStatus: "unreviewed",
    rightsPolicyId: h.rights.policyId,
    untrustedContent: true,
  };
  const bytes = bytesOf(evidence);
  const artifactSha256 = await hashArtifact(bytes);
  const objectKey = `vertex/v1/${fixtureScope.accountAlias}/paper/collection/${collectionId}/manifest/sha256/${artifactSha256}`;
  const sourceKey = `vertex/v1/${fixtureScope.accountAlias}/paper/collection/${collectionId}/content/sha256/${contentHash}`;
  const metadata = {
    artifactId: "synthetic-evidence-artifact",
    scope: fixtureScope,
    collectionId,
    objectKey,
    artifactSha256,
    sourceContentSha256: contentHash,
    byteLength: bytes.byteLength,
    contentType: "application/json",
    schemaVersion: "1.0.0",
    contractName: "ResearchEvidence",
    rights: h.rights,
    lineageArtifactIds: [],
    createdAt: fixtureAt,
  };
  h.persisted.set("vertex_artifacts", [
    {
      payload: metadata,
      metadata_hash: await hashArtifact(metadata),
      collection_key: collectionId,
      artifact_sha256: artifactSha256,
      object_key: objectKey,
      byte_length: String(bytes.byteLength),
      rights_policy_id: h.rights.policyId,
      rights_version: h.rights.version,
    },
  ]);
  const review = {
    schemaVersion: "1.0.0",
    reviewId: "synthetic-review",
    ...fixtureScope,
    collectionId,
    artifactId: metadata.artifactId,
    artifactSha256,
    reviewVersion: "1.0.0",
    decision: "accepted",
    purpose: "research",
    actorId: fixturePrincipal.actorId,
    reviewedAt: fixtureAt,
    expiresAt: fixtureExpires,
    policyVersion: "1.0.0",
    strategyVersion: "synthetic-strategy",
    supersedesReviewId: null,
    executionAuthorized: false,
  };
  const reviewRow = {
    payload: review,
    record_hash: await hashArtifact(review),
    review_id: review.reviewId,
    reviewed_at_ns: ns(fixtureAt).toString(),
    expires_at_ns: ns(fixtureExpires).toString(),
    decision: "accepted",
    review_version: review.reviewVersion,
    artifact_sha256: artifactSha256,
    actor_id: fixturePrincipal.actorId,
    policy_version: review.policyVersion,
  };
  h.persisted.set("vertex_reviews", [reviewRow]);
  h.persisted.set("vertex_reviewed_artifact_links", [
    { review_id: review.reviewId },
  ]);
  h.persisted.set("vertex_records", [
    {
      artifact_sha256: artifactSha256,
      record_hash: artifactSha256,
      payload: evidence,
    },
  ]);
  h.objects.set(objectKey, bytes);
  h.objects.set(sourceKey, content);
  const reference = {
    artifactId: metadata.artifactId,
    artifactSha256,
    reviewId: review.reviewId,
    reviewVersion: review.reviewVersion,
    rightsPolicyId: h.rights.policyId,
    rightsVersion: h.rights.version,
  };
  const source = createVertexRuntimeModelEvidence(
    h.options as unknown as Parameters<
      typeof createVertexRuntimeModelEvidence
    >[0]
  );
  return {
    h,
    review,
    reviewRow,
    evidence,
    sourceKey,
    reference,
    accepted: () =>
      source.accepted(h.tx, fixturePrincipal, h.request, reference, fixtureAt),
  };
};

describe("source-bound runtime model use", () => {
  it("constructs without reading clocks, DB, objects, grants or providers", async () => {
    const h = await harness();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.getBounded).not.toHaveBeenCalled();
    expect(h.options.clock.now).not.toHaveBeenCalled();
    return expect(
      h.options.privilegedAuthorization.authorize
    ).not.toHaveBeenCalled();
  });
  it("materializes exact persisted facts but leaves aggregate reservation to DB", async () => {
    const h = await harness();
    const context = await h.context();
    expect(context).not.toBeNull();
    expect(context?.selection.tokenizerSha256).toBe(h.request.tokenizerSha256);
    expect(context?.budgetAdmission).toMatchObject({
      policyId: "policy-provider-budget",
      periodId: "synthetic-period",
      maximumTokens: 10_000,
      jobMaximumTokens: 1000,
      unknownOutcome: "retain-charge",
    });
    expect(context).not.toHaveProperty("budget");
    expect(context?.privacy.requestSha256).toBe(h.request.requestSha256);
    return expect(h.getBounded).toHaveBeenCalledWith(
      expect.any(String),
      1_048_576
    );
  });
  it.each(["leased", "unknown", "cancelled", "succeeded", "failed"])(
    "denies non-admitted/terminal job state %s",
    async (state) => {
      const h = await harness();
      h.job["state"] = state;
      expect(await h.context()).toBeNull();
      return expect(h.getBounded).not.toHaveBeenCalled();
    }
  );
  it("requires durable same-epoch run admission", async () => {
    const h = await harness();
    h.setAdmitted(false);
    return expect(await h.context()).toBeNull();
  });
  it("does not substitute storage read grants for independent model-use issuance", async () => {
    const h = await harness();
    expect(await h.context()).not.toBeNull();
    expect(h.options.privilegedAuthorization.authorize).not.toHaveBeenCalled();
    return expect(
      h.execute.mock.calls.every(
        ([query]) => !new PgDialect().sqlToQuery(query).sql.startsWith("insert")
      )
    ).toBe(true);
  });
  it("requires real persisted ACL records, not merely configuration pins", async () => {
    const h = await harness();
    h.setAcl(false);
    return expect(await h.context()).toBeNull();
  });
  it("denies current rights version drift and worker revocation", async () => {
    const h = await harness();
    h.rightsRow["version"] = "2.0.0";
    expect(await h.context()).toBeNull();
    h.rightsRow["version"] = "1.0.0";
    h.serviceRow["revoked_at"] = fixtureAt;
    return expect(await h.context()).toBeNull();
  });
  it("rehashes original input bytes even when persisted length is unchanged", async () => {
    const h = await harness();
    const input = h.stages.get("synthetic-input")!;
    h.objects.set(
      String(input["object_key"]),
      new Uint8Array(Number(input["byte_length"]))
    );
    return expect(await h.context()).toBeNull();
  });
  it("rejects unconfigured, duplicate, and mismatched request evidence", async () => {
    const h = await harness();
    for (const requestEvidence of [
      [],
      [...h.options.requestEvidence, ...h.options.requestEvidence],
      [{ ...h.options.requestEvidence[0]!, requestSha256: "b".repeat(64) }],
    ]) {
      const runtime = createVertexRuntimeModelUse({
        ...h.options,
        requestEvidence,
      } as unknown as Parameters<typeof createVertexRuntimeModelUse>[0]);

      expect(
        await runtime.currentUseContext(
          h.tx,
          fixturePrincipal,
          h.request,
          fixtureAt
        )
      ).toBeNull();
    }
  });
  it("does not trust request count or purpose changes with a stale digest", async () => {
    const h = await harness();
    await expect(
      vertexRuntimeModelUseBoundary.validate("ModelUseRequest", {
        ...h.request,
        inputTokens: 1,
      })
    ).rejects.toThrow();
    return expect(
      await h.runtime.currentUseContext(
        h.tx,
        fixturePrincipal,
        { ...h.request, purpose: "different-purpose" },
        fixtureAt
      )
    ).toBeNull();
  });
  it.each(["0", "0.01"])(
    "denies request maximum %s below pinned conservative source pricing",
    async (maximum) => {
      const h = await harness(maximum);
      expect(await h.context()).toBeNull();
      return expect(h.getBounded).not.toHaveBeenCalled();
    }
  );
  it("rejects malformed policy windows and policy unknown-outcome refunds", async () => {
    const h = await harness();
    expect(
      VertexRuntimeModelBudgetPolicySchema.safeParse({
        ...h.budgetPolicy,
        expiresAt: fixtureAt,
      }).success
    ).toBe(false);
    return expect(
      VertexRuntimeModelBudgetPolicySchema.safeParse({
        ...h.budgetPolicy,
        unknownOutcome: "refund-on-timeout",
      }).success
    ).toBe(false);
  });
  it("bounds object reads and rejects returned overflow and cancellation", async () => {
    const capabilities = {
      getBounded: vi.fn(async () => ({
        status: "ok",
        value: {
          body: new Uint8Array(1_048_577),
          metadata: { key: "synthetic-key", size: 1_048_577 },
        },
      })),
    };
    const evidence = createVertexRuntimeModelEvidence({
      objectCapabilities: () => capabilities as never,
      clock: { now: () => fixtureAt },
    });
    await expect(
      evidence.objectBytes(fixtureScope, "synthetic-key", fixtureDigest)
    ).rejects.toThrow();
    expect(capabilities.getBounded).toHaveBeenCalledWith(
      "synthetic-key",
      1_048_576
    );
    const controller = new AbortController();
    controller.abort();
    const aborted = createVertexRuntimeModelEvidence({
      objectCapabilities: () => capabilities as never,
      clock: { now: () => fixtureAt },
      signal: controller.signal,
    });
    await expect(
      aborted.objectBytes(fixtureScope, "synthetic-key", fixtureDigest)
    ).rejects.toThrow();
    return expect(capabilities.getBounded).toHaveBeenCalledTimes(1);
  });
  it("uses the latest review overlay without rewriting original unreviewed bytes", async () => {
    const f = await acceptedFixture();
    const current = await f.accepted();
    expect(current.originalArtifactSha256).toBe(f.reference.artifactSha256);
    expect(current.reviewDecision).toBe("accepted");
    expect(f.evidence.acceptanceStatus).toBe("unreviewed");
    const queries = f.h.execute.mock.calls.map(
      ([query]) => new PgDialect().sqlToQuery(query).sql
    );
    expect(
      queries.some((query) =>
        query.includes("order by reviewed_at_ns desc, review_id desc")
      )
    ).toBe(true);
    return expect(
      queries.some((query) => query.includes("decision = 'accepted'"))
    ).toBe(false);
  });
  it("does not fall back to older acceptance after a later rejection", async () => {
    const f = await acceptedFixture();
    f.review.decision = "rejected";
    f.reviewRow.decision = "rejected";
    f.reviewRow.record_hash = await hashArtifact(f.review);
    await expect(f.accepted()).rejects.toThrow();
    return expect(f.h.getBounded).not.toHaveBeenCalled();
  });
  it("requires actual original content bytes and atomic review publication links", async () => {
    const f = await acceptedFixture();
    f.h.objects.delete(f.sourceKey);
    await expect(f.accepted()).rejects.toThrow();
    const missingLink = await acceptedFixture();
    missingLink.h.persisted.set("vertex_reviewed_artifact_links", []);
    return await expect(missingLink.accepted()).rejects.toThrow();
  });
  return it("cannot reuse old rights revision after the current policy changes", async () => {
    const f = await acceptedFixture();
    f.h.rightsRow["payload"] = { ...f.h.rights, version: "2.0.0" };
    f.h.rightsRow["version"] = "2.0.0";
    f.h.rightsRow["record_hash"] = await hashArtifact(f.h.rightsRow["payload"]);
    return await expect(f.accepted()).rejects.toThrow();
  });
});
