import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import type { ArtifactPin, OwnershipPin } from "@darkfactory/config/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import {
  fixtureSelection,
  fixtureScope,
  fixturePrincipal,
  fixtureAt,
  fixtureExpires,
  fixtureLookup,
} from "../contracts/vertex-policy.test-support.ts";
import {
  createVertexRuntimePolicy,
  vertexRuntimePolicyBoundary,
  type VertexRuntimePolicyOptions,
} from "./vertex-runtime-policy.ts";
import {
  computeRuntimePolicySelectionHash,
  parseRuntimePolicySelection,
  RuntimePolicySelectionSchema,
} from "../contracts/vertex-policy.ts";
import type { VertexResearchChatCopyRetentionLookup } from "./vertex-research-chat-copy-retention.ts";

// Source-only regressions. No real DB, provider, network or host process. These
// cases must not be executed until the user's deferred verification phase.
const ns = (value: string) => timestampToEpochNanoseconds(value).toString();
const serviceId = "synthetic-host";
const earlier = "2026-09-22T11:59:00.000000001Z";
type Row = Record<string, unknown>;
const grantRow = async (resourceId: string): Promise<Row> => {
  const binding = {
    grantId: `read-${resourceId}`,
    granteeActorId: fixturePrincipal.actorId,
    scope: fixtureScope,
    collectionId: null,
    resourceId,
    actions: ["read"],
  };
  const version = {
    ...binding,
    version: "1.0.0",
    revision: "1",
    status: "granted",
    validFrom: earlier,
    expiresAt: fixtureExpires,
    recordedAt: earlier,
    recordedByActorId: "synthetic-admin",
  };
  return {
    account_alias: fixtureScope.accountAlias,
    environment: fixtureScope.environment,
    grant_id: binding.grantId,
    grantee_actor_id: fixturePrincipal.actorId,
    collection_key: "",
    resource_id: resourceId,
    binding_hash: await hashArtifact(binding),
    binding_payload: binding,
    version_payload: version,
    record_hash: await hashArtifact(version),
    request_hash: "a".repeat(64),
    version_status: "granted",
    valid_from_ns: ns(earlier),
    expires_at_ns: ns(fixtureExpires),
    recorded_at_ns: ns(earlier),
    version_name: "1.0.0",
    version_revision: "1",
    current_version: "1.0.0",
    current_revision: "1",
  };
};
const harness = async () => {
  const selection = await fixtureSelection();
  const rights = {
    policyId: "policy-licensing-rights",
    version: "2.0.0",
    status: "granted",
    allowedUses: ["store", "read", "derive"],
    checkedAt: earlier,
    expiresAt: fixtureExpires,
    retentionUntil: null,
  };
  const rightsRow: Row = {
    policy_id: rights.policyId,
    version: rights.version,
    revision: "1",
    status: rights.status,
    checked_at_ns: ns(rights.checkedAt),
    expires_at_ns: ns(fixtureExpires),
    retention_until_ns: null,
    record_hash: await hashArtifact(rights),
    payload: rights,
  };
  const selectedRow: Row = {
    selection_id: selection.selectionId,
    selection_sha256: selection.selectionSha256,
    revision: selection.revision,
    issued_at_ns: ns(selection.issuedAt),
    expires_at_ns: ns(selection.expiresAt),
    payload: selection,
  };
  const head = {
    ...fixtureScope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    revision: "2",
    state: "active-read-only",
    updatedAt: fixtureAt,
  };
  const headRow: Row = {
    revision: head.revision,
    selection_id: head.selectionId,
    selection_sha256: head.selectionSha256,
    state: head.state,
    updated_at: head.updatedAt,
    record_hash: await hashArtifact(head),
    payload: head,
  };
  const pins = [
    ...selection.sourcePins.map((p) => p.provenanceArtifact),
    ...selection.modules.map((p) => p.artifact),
    ...selection.policies.map((p) => p.artifact),
    ...selection.providerCapabilities.map((p) => p.evidenceArtifact),
  ];
  const catalog = new Map<string, Row>();
  for (const pin of pins) {
    const key = vertexQualifiedObjectKey(
      fixtureScope,
      null,
      "manifest",
      pin.artifactSha256
    );
    const value = {
      ...pin,
      scope: fixtureScope,
      collectionId: null,
      objectKey: key,
      sourceContentSha256: null,
      byteLength: 1,
      contentType: "application/json",
      rights,
      lineageArtifactIds: [],
      createdAt: earlier,
    };
    catalog.set(pin.artifactId, {
      metadata_hash: await hashArtifact(value),
      artifact_sha256: pin.artifactSha256,
      object_key: key,
      byte_length: "1",
      rights_policy_id: rights.policyId,
      rights_version: rights.version,
      payload: value,
    });
  }
  const receipt = {
    ...fixtureScope,
    evidenceId: "host-receipt",
    componentId: "synthetic-host",
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    state: "ready",
    codeSha256: selection.modules[0]!.codeSha256,
    contractSha256: selection.modules[0]!.contractSha256,
    observedAt: fixtureAt,
    expiresAt: "2026-09-22T12:01:00.000000001Z",
    reasonCodes: ["host-observed"],
  };
  const body = new TextEncoder().encode(canonicalArtifactJson(receipt));
  const evidence: ArtifactPin = {
    artifactId: "host-evidence",
    artifactSha256: await hashArtifact(body),
    contractName: "RuntimeComponentEvidence",
    schemaVersion: "1.0.0",
  };
  const key = vertexQualifiedObjectKey(
    fixtureScope,
    null,
    "manifest",
    evidence.artifactSha256
  );
  const metadata = {
    key,
    size: body.byteLength,
    checksum: evidence.artifactSha256,
    createdAt: fixtureAt,
    updatedAt: fixtureAt,
  };
  const grant = {
    grantId: "worker-service-grant",
    servicePrincipalId: serviceId,
    ...fixtureScope,
    operations: ["claim", "readiness", "policySelection"],
    issuedAt: earlier,
    expiresAt: fixtureExpires,
    revokedAt: null,
  };
  const serviceRow: Row = {
    grant_id: grant.grantId,
    service_principal_id: serviceId,
    revoked_at: null,
    issued_at_ns: ns(earlier),
    expires_at_ns: ns(fixtureExpires),
    record_hash: await hashArtifact(grant),
    payload: grant,
  };
  const authRows = await Promise.all(
    [
      "account-scope",
      "runtime-policy",
      selection.selectionId,
      "host-evidence",
      `policy-consumer:${serviceId}`,
    ].map(grantRow)
  );
  const state = {
    at: fixtureAt,
    allowAcl: true,
    corruptBody: false,
    denyHead: false,
    pin: null as Row | null,
    job: null as Row | null,
    outbox: null as Row | null,
    workerReceipt: null as Row | null,
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const query = dialect.sqlToQuery(fragment);
    calls.push(query);
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (query.sql.includes("from vertex_grant_bindings"))
      return {
        rows: state.allowAcl
          ? authRows.filter(
              (row) =>
                query.params.includes(row["resource_id"]) &&
                query.params.includes(fixturePrincipal.actorId) &&
                query.params.includes(fixtureScope.accountAlias)
            )
          : [],
      };
    if (/from "?vertex_policy_selections"?/.test(query.sql))
      return {
        rows: query.params.includes(fixtureScope.accountAlias)
          ? [selectedRow]
          : [],
      };
    if (/from "?vertex_policy_heads"?/.test(query.sql))
      return { rows: state.denyHead ? [] : [headRow] };
    if (/from "?vertex_policy_revocations"?/.test(query.sql))
      return { rows: [] };
    if (query.sql.includes("from vertex_rights_versions"))
      return { rows: [rightsRow] };
    if (query.sql.includes("from vertex_artifacts"))
      return {
        rows: [...catalog]
          .filter(([id]) => query.params.includes(id))
          .map(([, row]) => row),
      };
    if (query.sql.includes("from vertex_worker_stages")) return { rows: [] };
    if (query.sql.includes("from vertex_worker_service_grants"))
      return { rows: [serviceRow] };
    if (query.sql.includes("from vertex_worker_jobs"))
      return { rows: state.job ? [state.job] : [] };
    if (query.sql.includes("from vertex_worker_readiness"))
      return { rows: state.workerReceipt ? [state.workerReceipt] : [] };
    if (query.sql.includes("from vertex_outbox"))
      return { rows: state.outbox ? [state.outbox] : [] };
    if (/from "?vertex_policy_ownership_pins"?/.test(query.sql))
      return { rows: state.pin ? [state.pin] : [] };
    if (query.sql.startsWith("insert into vertex_policy_ownership_pins")) {
      const pin = JSON.parse(query.params.at(-1) as string) as OwnershipPin;
      state.pin = {
        holder_id: pin.holderId,
        holder_kind: pin.holderKind,
        selection_id: pin.selectionId,
        selection_sha256: pin.selectionSha256,
        module_id: pin.module.moduleId,
        module_version: pin.module.version,
        code_sha256: pin.module.codeSha256,
        owner_service_id: pin.ownerServiceId,
        owner_epoch: pin.ownerEpoch,
        pinned_at_ns: ns(pin.pinnedAt),
        released_at_ns: null,
        record_hash: await hashArtifact(pin),
        payload: pin,
      };
      return { rows: [] };
    }
    throw new Error("Unexpected synthetic SQL");
  });
  const tx = { execute } as unknown as Transaction;
  const transaction = vi.fn(
    async (operation: (tx: Transaction) => Promise<unknown>) => operation(tx)
  );
  const db = { execute, transaction } as unknown as Database;
  const options: VertexRuntimePolicyOptions = {
    db,
    clock: { now: () => state.at },
    consumerServiceId: serviceId,
    objectCapabilities: () => ({
      head: async () => ({ status: "ok", value: metadata }),
      getBounded: async () => ({
        status: "ok",
        value: {
          metadata,
          body: state.corruptBody ? new Uint8Array(body.length) : body,
        },
      }),
    }),
    components: [
      {
        ...fixtureScope,
        componentId: "synthetic-host",
        moduleId: "synthetic-module",
        servicePrincipalId: serviceId,
        grantId: grant.grantId,
        maximumAgeMilliseconds: 60_000,
        source: "host-object",
        principal: fixturePrincipal,
        evidence,
        rightsPolicyId: rights.policyId,
        rightsVersion: rights.version,
      },
    ],
    jobModules: [
      {
        ...fixtureScope,
        kind: "research-run",
        consumerServiceId: serviceId,
        moduleId: "synthetic-module",
      },
    ],
  };
  const installJob = async () => {
    const eventId = "source-event";
    const jobId = `job-${await hashArtifact({ scope: fixtureScope, eventId })}`;
    const stable = {
      kind: "research-run",
      researchPrincipalId: fixturePrincipal.actorId,
      payloadArtifactId: "source-payload",
      payloadSha256: "b".repeat(64),
      policySelectionId: selection.selectionId,
      policySelectionSha256: selection.selectionSha256,
      deadlineAt: fixtureExpires,
    };
    const lease = {
      schemaVersion: "1.0.0",
      ...fixtureScope,
      ...stable,
      jobId,
      eventId,
      leaseId: "worker-instance",
      leaseEpoch: "1",
      leaseExpiresAt: fixtureExpires,
      attempt: 1,
    };
    state.job = {
      job_id: jobId,
      event_id: eventId,
      grant_id: grant.grantId,
      worker_instance_id: lease.leaseId,
      binding_hash: await hashArtifact({
        scope: fixtureScope,
        eventId,
        ...stable,
      }),
      state: "leased",
      lease_id: lease.leaseId,
      lease_epoch: lease.leaseEpoch,
      lease_expires_at_ns: ns(fixtureExpires),
      deadline_at_ns: ns(fixtureExpires),
      attempt: 1,
      payload: lease,
    };
    const payload = { source: "synthetic-command" };
    state.outbox = {
      published_at: null,
      lease_owner: lease.leaseId,
      lease_fence: lease.leaseEpoch,
      lease_expires_at_ns: ns(fixtureExpires),
      record_hash: await hashArtifact(payload),
      payload,
    };
    return lease;
  };
  return {
    options,
    runtime: createVertexRuntimePolicy(options),
    state,
    selection,
    rightsRow,
    serviceRow,
    selectedRow,
    headRow,
    catalog,
    calls,
    tx,
    transaction,
    installJob,
  };
};

describe("concrete persisted runtime policy composition (authored, deferred)", () => {
  it("checks the authoritative digest, not just selection shape", async () => {
    const selection = await fixtureSelection();
    return await expect(
      vertexRuntimePolicyBoundary.validate("RuntimePolicySelection", {
        ...selection,
        revision: "2",
      })
    ).rejects.toThrow();
  });
  it("reuses a validated selection only for the same data and never caches a failure", async () => {
    const selection = await fixtureSelection();
    const validate = vertexRuntimePolicyBoundary.validate;
    const first = await validate("RuntimePolicySelection", selection);
    expect(Object.isFrozen(first)).toBe(true);
    // The frozen result itself and an equal copy return the same frozen value.
    expect(await validate("RuntimePolicySelection", first)).toBe(first);
    expect(
      await validate("RuntimePolicySelection", structuredClone(selection))
    ).toBe(first);
    // A frozen result is not accepted under another record name.
    await expect(validate("PolicySelectionLookup", first)).rejects.toThrow();
    // Failures are not cached: the bad copy fails, and so does a second try.
    const changed = { ...selection, revision: "2" };
    await expect(validate("RuntimePolicySelection", changed)).rejects.toThrow();
    await expect(validate("RuntimePolicySelection", changed)).rejects.toThrow();
    // Fill the cache past its limit; the evicted selection still validates.
    for (let index = 0; index < 70; index += 1) {
      await validate("PolicySelectionLookup", {
        accountAlias: selection.accountAlias,
        environment: selection.environment,
        selectionId: `${selection.selectionId}-${index}`,
        selectionSha256: selection.selectionSha256,
      });
    }
    const again = await validate(
      "RuntimePolicySelection",
      structuredClone(selection)
    );
    expect(again).not.toBe(first);
    return expect(again).toEqual(first);
  });
  it("bootstraps all three exact-account bindings from independently authorized bounded host evidence", async () => {
    const f = await harness();
    const result = await f.runtime.resolvePolicy(
      fixturePrincipal,
      fixtureScope
    );
    expect(result.policyIdentity).toEqual({
      selectionId: f.selection.selectionId,
      selectionSha256: f.selection.selectionSha256,
      selectionRevision: "1",
      revision: "2",
    });
    expect(result.reviewPolicy).toBeDefined();
    expect(result.research).toBeDefined();
    expect(result.simulation).toBeDefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.calls.some((q) => q.sql.includes("from vertex_worker_jobs"))).toBe(
      false
    );
    return expect(
      await f.runtime.resolvePolicy(fixturePrincipal, {
        ...fixtureScope,
        accountAlias: "other-account",
      })
    ).toEqual({});
  });
  it("denies stale licensing version even when the newer row remains granted", async () => {
    const f = await harness();
    const changed = { ...(f.rightsRow["payload"] as Row), version: "3.0.0" };
    Object.assign(f.rightsRow, {
      version: "3.0.0",
      payload: changed,
      record_hash: await hashArtifact(changed),
    });
    return expect(
      await f.runtime.resolvePolicy(fixturePrincipal, fixtureScope)
    ).toEqual({});
  });
  it.each(["receipt-bytes", "grant-revoked", "acl-revoked", "expired-receipt"])(
    "never derives readiness from flags when %s is invalid",
    async (change) => {
      const f = await harness();
      if (change === "receipt-bytes") f.state.corruptBody = true;
      if (change === "grant-revoked") f.serviceRow["revoked_at"] = fixtureAt;
      if (change === "acl-revoked") f.state.allowAcl = false;
      if (change === "expired-receipt")
        f.state.at = "2026-09-22T12:02:00.000000001Z";
      const result = await f.runtime.resolvePolicy(
        fixturePrincipal,
        fixtureScope
      );
      expect(result.reviewPolicy).toBeUndefined();
      expect(result.research).toBeUndefined();
      return expect(result.simulation).toBeUndefined();
    }
  );
  it("denies policy mutation when independent administration is absent", async () => {
    const f = await harness();
    await expect(
      f.runtime.registry.stage({
        ...fixtureLookup(f.selection),
        principal: fixturePrincipal,
        commandId: "stage-command",
        expectedRevision: "2",
        selection: f.selection,
      })
    ).rejects.toThrow("Vertex policy unavailable");
    return expect(f.calls.some((q) => /^insert|^update/.test(q.sql))).toBe(
      false
    );
  });
  it("pins only a real current job and claimed source, using the caller transaction", async () => {
    const f = await harness();
    await expect(
      f.runtime.pinPolicySelection(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId,
        "missing-job"
      )
    ).rejects.toThrow();
    const lease = await f.installJob();
    await f.runtime.pinPolicySelection(
      f.tx,
      fixturePrincipal,
      fixtureLookup(f.selection),
      serviceId,
      lease.jobId
    );
    expect(f.transaction).not.toHaveBeenCalled();
    expect((f.state.pin!["payload"] as OwnershipPin).module).toEqual(
      f.selection.modules[0]
    );
    expect(
      await f.runtime.policySelection(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId,
        lease.jobId
      )
    ).toEqual(f.selection);
    f.state.job!["lease_epoch"] = "2";
    return await expect(
      f.runtime.policySelection(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId,
        lease.jobId
      )
    ).rejects.toThrow();
  });
  it("atomically rejects a different head CAS or immutable selection revision", async () => {
    const f = await harness();
    const resolved = await f.runtime.resolvePolicy(
      fixturePrincipal,
      fixtureScope
    );
    const input = {
      principal: fixturePrincipal,
      scope: fixtureScope,
      kind: "review" as const,
      commandPolicy: resolved.policyIdentity!,
      now: fixtureAt,
    };
    expect(await f.runtime.commandPolicy(f.tx, input)).toBe(true);
    expect(
      await f.runtime.commandPolicy(f.tx, {
        ...input,
        commandPolicy: { ...input.commandPolicy, revision: "3" },
      })
    ).toBe(false);
    return expect(
      await f.runtime.commandPolicy(f.tx, {
        ...input,
        commandPolicy: { ...input.commandPolicy, selectionRevision: "2" },
      })
    ).toBe(false);
  });
  it("does not cache authority or a completed DB transaction in available callbacks", async () => {
    const f = await harness();
    const resolved = await f.runtime.resolvePolicy(
      fixturePrincipal,
      fixtureScope
    );
    f.state.allowAcl = false;
    expect(await resolved.research!.available(fixtureScope)).toBe(false);
    return expect(f.transaction.mock.calls.length).toBeGreaterThan(1);
  });
  it("accepts exact persisted worker receipts and rejects epoch or module-hash drift", async () => {
    const f = await harness();
    const lease = await f.installJob();
    await f.runtime.pinPolicySelection(
      f.tx,
      fixturePrincipal,
      fixtureLookup(f.selection),
      serviceId,
      lease.jobId
    );
    const receipt = {
      ...fixtureScope,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      state: "ready",
      capabilityIds: ["synthetic-host"],
      observedAt: fixtureAt,
    };
    f.state.workerReceipt = {
      job_id: lease.jobId,
      lease_epoch: lease.leaseEpoch,
      observed_at_ns: ns(fixtureAt),
      payload: receipt,
    };
    const runtime = createVertexRuntimePolicy({
      ...f.options,
      components: [
        {
          ...fixtureScope,
          source: "worker-job",
          jobId: lease.jobId,
          grantId: "worker-service-grant",
          servicePrincipalId: serviceId,
          componentId: "synthetic-host",
          moduleId: "synthetic-module",
          maximumAgeMilliseconds: 60_000,
        },
      ],
    });
    expect(
      (await runtime.resolvePolicy(fixturePrincipal, fixtureScope)).reviewPolicy
    ).toBeDefined();
    f.state.workerReceipt["lease_epoch"] = "2";
    expect(
      (await runtime.resolvePolicy(fixturePrincipal, fixtureScope)).reviewPolicy
    ).toBeUndefined();
    f.state.workerReceipt["lease_epoch"] = "1";
    const pin = f.state.pin!["payload"] as OwnershipPin;
    const changed = {
      ...pin,
      module: { ...pin.module, contractSha256: "f".repeat(64) },
    };
    Object.assign(f.state.pin!, {
      payload: changed,
      record_hash: await hashArtifact(changed),
    });
    return expect(
      (await runtime.resolvePolicy(fixturePrincipal, fixtureScope)).reviewPolicy
    ).toBeUndefined();
  });
  it("denies a stale claimed-outbox fence without writing a policy pin", async () => {
    const f = await harness();
    const lease = await f.installJob();
    f.state.outbox!["lease_fence"] = "2";
    await expect(
      f.runtime.pinPolicySelection(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId,
        lease.jobId
      )
    ).rejects.toThrow("Vertex policy unavailable");
    return expect(f.state.pin).toBeNull();
  });
  it("supports pre-job bootstrap materialization only with the current exact head", async () => {
    const f = await harness();
    expect(
      await f.runtime.materializeForTransaction(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId
      )
    ).toEqual(f.selection);
    expect(f.transaction).not.toHaveBeenCalled();
    f.state.denyHead = true;
    return await expect(
      f.runtime.materializeForTransaction(
        f.tx,
        fixturePrincipal,
        fixtureLookup(f.selection),
        serviceId
      )
    ).rejects.toThrow("Vertex policy unavailable");
  });
  return it("fails closed on an aborted request without opening a transaction", async () => {
    const f = await harness();
    const signal = AbortSignal.abort();
    const runtime = createVertexRuntimePolicy({ ...f.options, signal });
    expect(await runtime.resolvePolicy(fixturePrincipal, fixtureScope)).toEqual(
      {}
    );
    return expect(f.transaction).not.toHaveBeenCalled();
  });
});

// This separate research fixture exercises the real factory, registry, Drizzle
// authorization and selected-artifact owner. Only DB rows/object capabilities
// are fake. No injected materialize result, authority flag or model callback.
const retentionScope = {
  accountAlias: "synthetic-policy-research",
  environment: "research",
} as const;
const retentionDocument = () => ({
  schemaVersion: "1.0.0",
  format: "vertex-research-chat-copy-retention-policy-v1",
  ...retentionScope,
  policyId: "policy-retention",
  policyVersion: "1.0.0",
  rules: [
    { kind: "context", cleanupTrigger: "response-attempt-terminal" },
    { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
    { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
  ],
  earlierCleanupTriggers: ["revocation", "rights-expiry"],
});
type RetentionFixtureOptions = Readonly<{
  document?: unknown;
  bytes?: Uint8Array;
  signal?: AbortSignal;
}>;
const retentionHarness = async (input: RetentionFixtureOptions = {}) => {
  const body =
    input.bytes ??
    new TextEncoder().encode(
      canonicalArtifactJson(input.document ?? retentionDocument())
    );
  const artifact: ArtifactPin = {
    artifactId: "selected-retention-artifact",
    artifactSha256: await hashArtifact(body),
    contractName: "VertexResearchChatCopyRetentionPolicy",
    schemaVersion: "1.0.0",
  };
  const base = await fixtureSelection();
  const raw = RuntimePolicySelectionSchema.parse({
    ...base,
    ...retentionScope,
    simulation: null,
    references: base.references.map((reference) => ({
      ...reference,
      ...retentionScope,
    })),
    policies: [
      ...base.policies,
      {
        role: "retention",
        policyId: "policy-retention",
        version: "1.0.0",
        artifact,
      },
    ],
  });
  const selection = await parseRuntimePolicySelection({
    ...raw,
    selectionSha256: await computeRuntimePolicySelectionHash(raw),
  });
  const lookup: VertexResearchChatCopyRetentionLookup = {
    ...retentionScope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
  };
  const rights = {
    policyId: "policy-licensing-rights",
    version: "2.0.0",
    status: "granted",
    allowedUses: ["read"],
    checkedAt: earlier,
    expiresAt: fixtureExpires,
    retentionUntil: null,
  };
  const rightsRow: Row = {
    policy_id: rights.policyId,
    version: rights.version,
    revision: "1",
    status: rights.status,
    checked_at_ns: ns(earlier),
    expires_at_ns: ns(fixtureExpires),
    retention_until_ns: null,
    record_hash: await hashArtifact(rights),
    payload: rights,
  };
  const selectedRow: Row = {
    selection_id: selection.selectionId,
    selection_sha256: selection.selectionSha256,
    revision: selection.revision,
    issued_at_ns: ns(selection.issuedAt),
    expires_at_ns: ns(selection.expiresAt),
    payload: selection,
  };
  const headValue = {
    ...retentionScope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    revision: "2",
    state: "active-read-only",
    updatedAt: fixtureAt,
  };
  const headRow: Row = {
    revision: headValue.revision,
    selection_id: headValue.selectionId,
    selection_sha256: headValue.selectionSha256,
    state: headValue.state,
    updated_at: headValue.updatedAt,
    record_hash: await hashArtifact(headValue),
    payload: headValue,
  };
  const authRows: Row[] = [];
  for (const resourceId of [
    "account-scope",
    "runtime-policy",
    selection.selectionId,
    artifact.artifactId,
    `policy-consumer:${serviceId}`,
  ]) {
    const binding = {
      grantId: `read-${resourceId}`,
      granteeActorId: fixturePrincipal.actorId,
      scope: retentionScope,
      collectionId: null,
      resourceId,
      actions: ["read"],
    };
    const version = {
      ...binding,
      version: "1.0.0",
      revision: "1",
      status: "granted",
      validFrom: earlier,
      expiresAt: fixtureExpires,
      recordedAt: earlier,
      recordedByActorId: "synthetic-admin",
    };
    authRows.push({
      account_alias: retentionScope.accountAlias,
      environment: retentionScope.environment,
      grant_id: binding.grantId,
      grantee_actor_id: fixturePrincipal.actorId,
      collection_key: "",
      resource_id: resourceId,
      binding_hash: await hashArtifact(binding),
      binding_payload: binding,
      version_payload: version,
      record_hash: await hashArtifact(version),
      request_hash: "a".repeat(64),
      version_status: "granted",
      valid_from_ns: ns(earlier),
      expires_at_ns: ns(fixtureExpires),
      recorded_at_ns: ns(earlier),
      version_name: "1.0.0",
      version_revision: "1",
      current_version: "1.0.0",
      current_revision: "1",
    });
  }
  const catalog = new Map<string, Row>();
  const stages = new Map<string, Row>();
  const pins = [
    ...selection.sourcePins.map((pin) => pin.provenanceArtifact),
    ...selection.modules.map((pin) => pin.artifact),
    ...selection.policies.map((pin) => pin.artifact),
    ...selection.providerCapabilities.map((pin) => pin.evidenceArtifact),
  ];
  for (const pin of pins) {
    const key = vertexQualifiedObjectKey(
      retentionScope,
      null,
      "manifest",
      pin.artifactSha256
    );
    const byteLength =
      pin.artifactId === artifact.artifactId ? body.byteLength : 1;
    const value = {
      ...pin,
      scope: retentionScope,
      collectionId: null,
      objectKey: key,
      sourceContentSha256: null,
      byteLength,
      contentType: "application/json",
      rights,
      lineageArtifactIds: [],
      createdAt: earlier,
    };
    catalog.set(pin.artifactId, {
      metadata_hash: await hashArtifact(value),
      artifact_sha256: pin.artifactSha256,
      object_key: key,
      byte_length: String(byteLength),
      rights_policy_id: rights.policyId,
      rights_version: rights.version,
      payload: value,
    });
  }
  const key = vertexQualifiedObjectKey(
    retentionScope,
    null,
    "manifest",
    artifact.artifactSha256
  );
  const metadata = {
    key,
    size: body.byteLength,
    checksum: artifact.artifactSha256,
    createdAt: fixtureAt,
    updatedAt: fixtureAt,
  };
  const state = {
    at: fixtureAt,
    deniedResources: [] as string[],
    revocations: [] as Row[],
    onGet: null as (() => Promise<void>) | null,
    onQuery: null as
      | ((query: { sql: string; params: unknown[] }) => Promise<void>)
      | null,
    body,
    metadata: { ...metadata },
    headMetadata: { ...metadata },
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (fragment: SQL) => {
    const query = dialect.sqlToQuery(fragment);
    calls.push(query);
    if (state.onQuery) await state.onQuery(query);
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (query.sql.includes("from vertex_grant_bindings")) {
      const matching = authRows.filter(
        (row) =>
          query.params.includes(row["resource_id"]) &&
          query.params.includes(fixturePrincipal.actorId) &&
          query.params.includes(retentionScope.accountAlias) &&
          query.params.includes("research") &&
          !state.deniedResources.includes(row["resource_id"] as string)
      );
      if (
        query.sql.startsWith(
          "select v.payload, v.record_hash, c.current_version, c.revision "
        )
      ) {
        return {
          rows: matching.map((row) => ({
            payload: row["version_payload"],
            record_hash: row["record_hash"],
            current_version: row["current_version"],
            revision: row["current_revision"],
          })),
        };
      }
      return { rows: matching };
    }
    if (/from "?vertex_policy_selections"?/.test(query.sql))
      return {
        rows: query.params.includes(retentionScope.accountAlias)
          ? [selectedRow]
          : [],
      };
    if (/from "?vertex_policy_heads"?/.test(query.sql))
      return { rows: [headRow] };
    if (/from "?vertex_policy_revocations"?/.test(query.sql))
      return { rows: state.revocations };
    if (query.sql.includes("from vertex_rights_versions"))
      return { rows: [rightsRow] };
    if (query.sql.includes("from vertex_artifacts"))
      return {
        rows: [...catalog]
          .filter(([id]) => query.params.includes(id))
          .map(([, row]) => row),
      };
    if (query.sql.includes("from vertex_worker_stages"))
      return {
        rows: [...stages]
          .filter(([id]) => query.params.includes(id))
          .map(([, row]) => row),
      };
    // A write, job/holder/readiness/model lookup or unrelated query fails here.
    throw new Error("Unexpected synthetic retention SQL");
  });
  const tx = { execute } as unknown as Transaction;
  const transaction = vi.fn(
    async (operation: (tx: Transaction) => Promise<unknown>) => operation(tx)
  );
  const db = { execute, transaction } as unknown as Database;
  const head = vi.fn(async (_key: string) => ({
    status: "ok" as const,
    value: state.headMetadata,
  }));
  const getBounded = vi.fn(async (_key: string, _maximumBytes: number) => {
    if (state.onGet) await state.onGet();
    return {
      status: "ok" as const,
      value: { metadata: state.metadata, body: state.body },
    };
  });
  const clock = { now: vi.fn(() => state.at) };
  const objectCapabilities = vi.fn(() => ({ head, getBounded }));
  const options: VertexRuntimePolicyOptions = {
    db,
    clock,
    consumerServiceId: serviceId,
    components: [],
    jobModules: [],
    objectCapabilities,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const runtime = createVertexRuntimePolicy(options);
  const updateHead = async (change: Row): Promise<void> => {
    const value = { ...(headRow["payload"] as Row), ...change };
    Object.assign(headRow, {
      revision: value["revision"],
      selection_id: value["selectionId"],
      selection_sha256: value["selectionSha256"],
      state: value["state"],
      updated_at: value["updatedAt"],
      record_hash: await hashArtifact(value),
      payload: value,
    });
    return;
  };
  const replaceSelection = async (change: (value: Row) => void) => {
    const value = structuredClone(selectedRow["payload"]) as Row;
    change(value);
    const { selectionSha256: _old, ...identity } = value;
    value["selectionSha256"] = await hashArtifact(identity);
    Object.assign(selectedRow, {
      selection_id: value["selectionId"],
      selection_sha256: value["selectionSha256"],
      revision: value["revision"],
      issued_at_ns: ns(value["issuedAt"] as string),
      expires_at_ns: ns(value["expiresAt"] as string),
      payload: value,
    });
    await updateHead({
      selectionId: value["selectionId"],
      selectionSha256: value["selectionSha256"],
    });
    return {
      ...retentionScope,
      selectionId: value["selectionId"] as string,
      selectionSha256: value["selectionSha256"] as string,
    };
  };
  const read = () =>
    runtime.readResearchChatCopyRetentionForTransaction(
      tx,
      fixturePrincipal,
      lookup,
      serviceId
    );
  return {
    runtime,
    options,
    state,
    selection,
    lookup,
    artifact,
    rightsRow,
    selectedRow,
    headRow,
    catalog,
    stages,
    authRows,
    calls,
    tx,
    transaction,
    head,
    getBounded,
    objectCapabilities,
    clock,
    read,
    replaceSelection,
    updateHead,
  };
};

describe("actual factory selected research-chat retention observation (authored, deferred)", () => {
  it("constructs purely and observes exact current metadata without readiness, grants, leases or nested transactions", async () => {
    const f = await retentionHarness();
    expect(f.calls).toEqual([]);
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.objectCapabilities).not.toHaveBeenCalled();
    let headReadsAtGet = 0;
    f.state.onGet = async () => {
      headReadsAtGet = f.calls.filter((q) =>
        /from "?vertex_policy_heads"?/.test(q.sql)
      ).length;
      return;
    };
    const result = await f.read();
    expect(result).toEqual({
      profile: "vertex-research-chat-copy-retention-observation-v1",
      ...retentionScope,
      observedByActorId: fixturePrincipal.actorId,
      consumerServiceId: serviceId,
      selectionId: f.selection.selectionId,
      selectionSha256: f.selection.selectionSha256,
      policy: retentionDocument(),
      artifact: f.artifact,
      checkedAt: fixtureAt,
    });
    for (const value of [
      result,
      result.artifact,
      result.policy,
      result.policy.rules,
      ...result.policy.rules,
      result.policy.earlierCleanupTriggers,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(headReadsAtGet).toBe(1);
    expect(
      f.calls.filter((q) => /from "?vertex_policy_heads"?/.test(q.sql))
    ).toHaveLength(2);
    expect(f.getBounded).toHaveBeenCalledExactlyOnceWith(
      f.state.metadata.key,
      f.state.body.byteLength
    );
    expect(f.head).toHaveBeenCalledExactlyOnceWith(f.state.metadata.key);
    expect(f.transaction).not.toHaveBeenCalled();
    expect(
      f.calls.some((q) =>
        /\b(insert|update|delete|vertex_policy_ownership_pins|vertex_worker_jobs|vertex_worker_readiness|vertex_model_use)\b/i.test(
          q.sql
        )
      )
    ).toBe(false);
    return expect(Object.keys(result).sort()).toEqual([
      "accountAlias",
      "artifact",
      "checkedAt",
      "consumerServiceId",
      "environment",
      "observedByActorId",
      "policy",
      "profile",
      "selectionId",
      "selectionSha256",
    ]);
  });
  it("uses the same verified selected-artifact stage fallback without staging or granting anything", async () => {
    const f = await retentionHarness();
    const value = {
      ...retentionScope,
      collectionId: null,
      artifactId: f.artifact.artifactId,
      jobId: "synthetic-existing-stage",
      contentSha256: f.artifact.artifactSha256,
      canonicalSha256: f.artifact.artifactSha256,
      contentType: "application/json",
      rightsPolicyId: "policy-licensing-rights",
      rightsVersion: "2.0.0",
    };
    f.stages.set(f.artifact.artifactId, {
      payload: value,
      request_hash: await hashArtifact(value),
      job_id: value.jobId,
      content_sha256: value.contentSha256,
      canonical_sha256: value.canonicalSha256,
      object_key: f.state.metadata.key,
      byte_length: String(f.state.body.byteLength),
    });
    f.catalog.delete(f.artifact.artifactId);
    expect((await f.read()).artifact).toEqual(f.artifact);
    return expect(
      f.calls.some((q) => /^(insert|update|delete)/i.test(q.sql))
    ).toBe(false);
  });
  it("leaves legacy selection materialization available without a retention document", async () => {
    const f = await retentionHarness();
    const lookup = await f.replaceSelection((value) => {
      value["policies"] = (value["policies"] as Row[]).filter(
        (pin) => pin["role"] !== "retention"
      );
      return;
    });
    expect(
      (
        await f.runtime.materializeForTransaction(
          f.tx,
          fixturePrincipal,
          lookup,
          serviceId
        )
      ).selectionSha256
    ).toBe(lookup.selectionSha256);
    await expect(
      f.runtime.readResearchChatCopyRetentionForTransaction(
        f.tx,
        fixturePrincipal,
        lookup,
        serviceId
      )
    ).rejects.toThrow("Vertex policy unavailable");
    expect(f.getBounded).not.toHaveBeenCalled();
    // Read permission/terms observation never supplies privileged issuance.
    return await expect(
      f.runtime.registry.stage({
        ...lookup,
        principal: fixturePrincipal,
        commandId: "no-retention-grant",
        expectedRevision: "2",
        selection: f.selectedRow["payload"] as typeof f.selection,
      })
    ).rejects.toThrow("Vertex policy unavailable");
  });
  it("preserves legacy materialization with a different private retention contract", async () => {
    const f = await retentionHarness();
    const lookup = await f.replaceSelection((value) => {
      const pin = (value["policies"] as Row[]).find(
        (entry) => entry["role"] === "retention"
      )!;
      const pinArtifact = pin["artifact"] as Row;
      pinArtifact["contractName"] = "OtherPrivateRetentionPolicy";
      return;
    });
    const row = f.catalog.get(f.artifact.artifactId)!;
    const value = {
      ...(row["payload"] as Row),
      contractName: "OtherPrivateRetentionPolicy",
    };
    Object.assign(row, {
      payload: value,
      metadata_hash: await hashArtifact(value),
    });
    expect(
      (
        await f.runtime.materializeForTransaction(
          f.tx,
          fixturePrincipal,
          lookup,
          serviceId
        )
      ).selectionSha256
    ).toBe(lookup.selectionSha256);
    await expect(
      f.runtime.readResearchChatCopyRetentionForTransaction(
        f.tx,
        fixturePrincipal,
        lookup,
        serviceId
      )
    ).rejects.toThrow("Vertex policy unavailable");
    return expect(f.getBounded).not.toHaveBeenCalled();
  });
  it.each([
    "account-scope",
    "selection-1",
    "selected-retention-artifact",
    `policy-consumer:${serviceId}`,
  ])("requires the real current %s read grant", async (resource) => {
    const f = await retentionHarness();
    f.state.deniedResources.push(resource);
    await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
    return expect(f.getBounded).not.toHaveBeenCalled();
  });
  it("does not substitute the unrelated policy-head listing grant for exact selection authority", async () => {
    const f = await retentionHarness();
    f.state.deniedResources.push("runtime-policy");
    expect((await f.read()).selectionId).toBe(f.lookup.selectionId);
    return expect(
      f.calls.some((call) => call.params.includes("runtime-policy"))
    ).toBe(false);
  });
  it.each(["actor", "account", "consumer", "selection-id", "selection-sha"])(
    "denies mismatched %s instead of treating an identity as authority",
    async (change) => {
      const f = await retentionHarness();
      const principal =
        change === "actor" ? { actorId: "other-actor" } : fixturePrincipal;
      const lookup = {
        ...f.lookup,
        ...(change === "account" ? { accountAlias: "other-account" } : {}),
        ...(change === "selection-id"
          ? { selectionId: "other-selection" }
          : {}),
        ...(change === "selection-sha"
          ? { selectionSha256: "f".repeat(64) }
          : {}),
      };
      await expect(
        f.runtime.readResearchChatCopyRetentionForTransaction(
          f.tx,
          principal,
          lookup,
          change === "consumer" ? "other-consumer" : serviceId
        )
      ).rejects.toThrow("Vertex policy unavailable");
      return expect(f.getBounded).not.toHaveBeenCalled();
    }
  );
  it.each([
    "paper",
    "live",
    "extra-key",
    "account-LF",
    "selection-LF",
    "digest-LF",
    "actor-LF",
    "consumer-LF",
    "consumer-too-long",
    "hidden",
    "symbol",
    "prototype",
  ])("rejects invalid %s before I/O", async (change) => {
    const f = await retentionHarness();
    const principal = { ...fixturePrincipal };
    const lookup: Row = { ...f.lookup };
    let consumer = serviceId;
    if (change === "paper" || change === "live") lookup["environment"] = change;
    if (change === "extra-key") lookup["holderId"] = "not-a-shortcut";
    if (change === "account-LF")
      lookup["accountAlias"] = `${lookup["accountAlias"]}\n`;
    if (change === "selection-LF")
      lookup["selectionId"] = `${lookup["selectionId"]}\n`;
    if (change === "digest-LF")
      lookup["selectionSha256"] = `${lookup["selectionSha256"]}\n`;
    if (change === "actor-LF")
      Object.assign(principal, { actorId: `${principal.actorId}\n` });
    if (change === "consumer-LF") consumer += "\n";
    if (change === "consumer-too-long") consumer = "x".repeat(144);
    if (change === "hidden")
      Object.defineProperty(lookup, "ready", { value: true });
    if (change === "symbol")
      Object.defineProperty(principal, Symbol("ready"), { value: true });
    if (change === "prototype") Object.setPrototypeOf(lookup, { ready: true });
    await expect(
      f.runtime.readResearchChatCopyRetentionForTransaction(
        f.tx,
        principal,
        lookup as unknown as VertexResearchChatCopyRetentionLookup,
        consumer
      )
    ).rejects.toThrow("Vertex policy unavailable");
    expect(f.calls).toEqual([]);
    return expect(f.objectCapabilities).not.toHaveBeenCalled();
  });
  it("rejects principal/lookup getters without evaluating them or touching the DB", async () => {
    for (const target of ["principal", "lookup"]) {
      const f = await retentionHarness();
      const principal = { ...fixturePrincipal };
      const lookup = { ...f.lookup };
      const getter = vi.fn(() => "synthetic-value");
      Object.defineProperty(
        target === "principal" ? principal : lookup,
        target === "principal" ? "actorId" : "selectionId",
        { enumerable: true, get: getter }
      );
      await expect(
        f.runtime.readResearchChatCopyRetentionForTransaction(
          f.tx,
          principal,
          lookup,
          serviceId
        )
      ).rejects.toThrow("Vertex policy unavailable");
      expect(getter).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
    }
    return;
  });
  it("captures principal and lookup synchronously before the first await", async () => {
    const f = await retentionHarness();
    const principal = { actorId: fixturePrincipal.actorId as string };
    const lookup = { ...f.lookup };
    const pending = f.runtime.readResearchChatCopyRetentionForTransaction(
      f.tx,
      principal,
      lookup,
      serviceId
    );
    principal.actorId = "later-caller-actor";
    lookup.accountAlias = "later-caller-account";
    lookup.selectionId = "later-caller-selection";
    lookup.selectionSha256 = "e".repeat(64);
    const result = await pending;
    expect(result.observedByActorId).toBe(fixturePrincipal.actorId);
    expect(result.accountAlias).toBe(retentionScope.accountAlias);
    return expect(result.selectionSha256).toBe(f.selection.selectionSha256);
  });
  it.each([
    "absent",
    "duplicate",
    "wrong-role",
    "wrong-contract",
    "wrong-schema",
    "policy-id-LF",
    "policy-version-LF",
    "artifact-id-LF",
    "artifact-sha-LF",
    "no-research",
  ])("fails closed for selected pin %s", async (change) => {
    const f = await retentionHarness();
    const lookup = await f.replaceSelection((value) => {
      const policies = value["policies"] as Row[];
      const pin = policies.find((entry) => entry["role"] === "retention")!;
      const artifact = pin["artifact"] as Row;
      if (change === "absent")
        value["policies"] = policies.filter((entry) => entry !== pin);
      if (change === "duplicate") policies.push(structuredClone(pin));
      if (change === "wrong-role") pin["role"] = "calendar";
      if (change === "wrong-contract")
        artifact["contractName"] = "OtherPrivatePolicy";
      if (change === "wrong-schema") artifact["schemaVersion"] = "2.0.0";
      if (change === "policy-id-LF") pin["policyId"] = `${pin["policyId"]}\n`;
      if (change === "policy-version-LF")
        pin["version"] = `${pin["version"]}\n`;
      if (change === "artifact-id-LF")
        artifact["artifactId"] = `${artifact["artifactId"]}\n`;
      if (change === "artifact-sha-LF")
        artifact["artifactSha256"] = `${artifact["artifactSha256"]}\n`;
      if (change === "no-research") value["research"] = null;
      return;
    });
    await expect(
      f.runtime.readResearchChatCopyRetentionForTransaction(
        f.tx,
        fixturePrincipal,
        lookup,
        serviceId
      )
    ).rejects.toThrow("Vertex policy unavailable");
    return expect(f.getBounded).not.toHaveBeenCalled();
  });
  it.each([
    "account",
    "environment",
    "policy-id",
    "policy-version",
    "schema",
    "rules",
    "authority",
    "ttl",
  ])(
    "rejects a verified document with mismatched/unknown %s",
    async (change) => {
      const document: Row = retentionDocument();
      if (change === "account") document["accountAlias"] = "other-account";
      if (change === "environment") document["environment"] = "paper";
      if (change === "policy-id") document["policyId"] = "other-policy";
      if (change === "policy-version") document["policyVersion"] = "2.0.0";
      if (change === "schema") document["schemaVersion"] = "2.0.0";
      if (change === "rules") document["rules"] = [];
      if (change === "authority") document["authorized"] = true;
      if (change === "ttl") document["ttlMilliseconds"] = 1000;
      const f = await retentionHarness({ document });
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      return expect(f.getBounded).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["noncanonical", "invalid-utf8", "invalid-json", "oversized"])(
    "rejects %s selected object bytes even when their raw digest is pinned",
    async (change) => {
      const bytes =
        change === "noncanonical"
          ? new TextEncoder().encode(
              JSON.stringify(retentionDocument(), null, 2)
            )
          : change === "invalid-utf8"
            ? new Uint8Array([0xff])
            : change === "invalid-json"
              ? new TextEncoder().encode("{")
              : new TextEncoder().encode(
                  canonicalArtifactJson({
                    ...retentionDocument(),
                    extra: "x".repeat(8192),
                  })
                );
      const f = await retentionHarness({ bytes });
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      return expect(f.getBounded).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "body-digest",
    "head-checksum",
    "head-key",
    "head-length",
    "returned-key",
    "returned-length",
    "catalog-hash",
    "catalog-key",
    "catalog-contract",
    "missing-artifact",
  ])("preserves artifact owner integrity for %s", async (change) => {
    const f = await retentionHarness();
    const catalog = f.catalog.get(f.artifact.artifactId)!;
    if (change === "body-digest")
      f.state.body = new Uint8Array(f.state.body.byteLength);
    if (change === "head-checksum")
      f.state.headMetadata.checksum = "c".repeat(64);
    if (change === "head-key")
      f.state.headMetadata.key = "arbitrary-object-key";
    if (change === "head-length") f.state.headMetadata.size += 1;
    if (change === "returned-key")
      f.state.metadata.key = "arbitrary-object-key";
    if (change === "returned-length") f.state.metadata.size += 1;
    if (change === "catalog-hash") catalog["metadata_hash"] = "c".repeat(64);
    if (change === "catalog-key")
      catalog["object_key"] = "arbitrary-object-key";
    if (change === "catalog-contract") {
      const value = {
        ...(catalog["payload"] as Row),
        contractName: "OtherPrivatePolicy",
      };
      Object.assign(catalog, {
        payload: value,
        metadata_hash: await hashArtifact(value),
      });
    }
    if (change === "missing-artifact") f.catalog.delete(f.artifact.artifactId);
    return await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
  });
  it.each(["draining", "disabled", "other-head"])(
    "does not use a holder shortcut for %s",
    async (change) => {
      const f = await retentionHarness();
      await f.updateHead(
        change === "other-head"
          ? { selectionId: "other-selection", selectionSha256: "e".repeat(64) }
          : { state: change }
      );
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      expect(f.getBounded).not.toHaveBeenCalled();
      return expect(
        f.calls.some((q) => q.sql.includes("vertex_policy_ownership_pins"))
      ).toBe(false);
    }
  );
  it.each([
    "artifact-acl",
    "account-acl",
    "consumer-acl",
    "rights-revoked",
    "rights-expired",
    "rights-retention-expired",
    "selection-revoked",
    "head-changed",
    "selection-changed",
    "expired",
  ])(
    "rechecks actual current authority after %s during object I/O",
    async (change) => {
      const f = await retentionHarness();
      f.state.onGet = async () => {
        if (change === "artifact-acl")
          f.state.deniedResources.push(f.artifact.artifactId);
        if (change === "account-acl")
          f.state.deniedResources.push("account-scope");
        if (change === "consumer-acl")
          f.state.deniedResources.push(`policy-consumer:${serviceId}`);
        if (
          change === "rights-revoked" ||
          change === "rights-expired" ||
          change === "rights-retention-expired"
        ) {
          const value = { ...(f.rightsRow["payload"] as Row) };
          if (change === "rights-revoked") value["status"] = "denied";
          if (change === "rights-expired") value["expiresAt"] = fixtureAt;
          if (change === "rights-retention-expired")
            value["retentionUntil"] = fixtureAt;
          Object.assign(f.rightsRow, {
            payload: value,
            record_hash: await hashArtifact(value),
            status: value["status"],
            expires_at_ns: ns(value["expiresAt"] as string),
            retention_until_ns:
              value["retentionUntil"] === null
                ? null
                : ns(value["retentionUntil"] as string),
          });
        }
        if (change === "selection-revoked") {
          const value = {
            selectionId: f.selection.selectionId,
            selectionSha256: f.selection.selectionSha256,
            recordedAt: fixtureAt,
            actorId: "synthetic-admin",
            commandId: "synthetic-revocation",
          };
          f.state.revocations.push({
            selection_id: value.selectionId,
            selection_sha256: value.selectionSha256,
            actor_id: value.actorId,
            command_id: value.commandId,
            recorded_at_ns: ns(value.recordedAt),
            record_hash: await hashArtifact(value),
            payload: value,
          });
        }
        if (change === "head-changed")
          await f.updateHead({
            selectionId: "other-selection",
            selectionSha256: "b".repeat(64),
          });
        if (change === "selection-changed") {
          await f.replaceSelection((value) => {
            const pin = (value["policies"] as Row[]).find(
              (entry) => entry["role"] === "retention"
            )!;
            pin["version"] = "2.0.0";
            return;
          });
        }
        if (change === "expired") f.state.at = fixtureExpires;
        return;
      };
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      expect(f.getBounded).toHaveBeenCalledTimes(1);
      return expect(f.transaction).not.toHaveBeenCalled();
    }
  );
  it.each(["pre", "mid", "final"])(
    "fails closed on %s cancellation",
    async (when) => {
      const controller = new AbortController();
      const f = await retentionHarness({ signal: controller.signal });
      if (when === "pre") controller.abort();
      if (when === "mid") {
        f.state.onGet = async () => {
          controller.abort();
          return;
        };
      }
      if (when === "final") {
        let reads = 0;
        f.state.onQuery = async (query) => {
          if (/from "?vertex_policy_heads"?/.test(query.sql)) {
            reads += 1;
            if (reads === 2) controller.abort();
          }
          return;
        };
      }
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      if (when === "pre") {
        expect(f.calls).toEqual([]);
        return expect(f.objectCapabilities).not.toHaveBeenCalled();
      }
      return;
    }
  );
  it("rejects a clock regression even while all grants and selections remain valid", async () => {
    const f = await retentionHarness();
    f.state.at = "2026-09-22T12:00:10.000000001Z";
    f.state.onGet = async () => {
      f.state.at = fixtureAt;
      return;
    };
    return await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
  });
  it.each(["invalid-start", "future-selection", "final-expiry"])(
    "rejects %s timestamp bounds",
    async (change) => {
      const f = await retentionHarness();
      if (change === "invalid-start") f.state.at = `${fixtureAt}\n`;
      if (change === "future-selection") f.state.at = earlier;
      if (change === "final-expiry") {
        let reads = 0;
        f.state.onQuery = async (query) => {
          if (/from "?vertex_policy_heads"?/.test(query.sql)) {
            reads += 1;
            if (reads === 2) f.state.at = fixtureExpires;
          }
          return;
        };
      }
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      if (change === "invalid-start") return expect(f.calls).toEqual([]);
      return;
    }
  );
  it.each(["expiresAt", "retentionUntil"] as const)(
    "rejects rights %s expiring during final materialization despite later selection/grant expiry",
    async (field) => {
      const f = await retentionHarness();
      const bound = "2026-09-22T12:30:00.000000001Z";
      const rights = { ...(f.rightsRow["payload"] as Row), [field]: bound };
      Object.assign(f.rightsRow, {
        payload: rights,
        record_hash: await hashArtifact(rights),
        expires_at_ns: ns(rights["expiresAt"] as string),
        retention_until_ns:
          rights["retentionUntil"] === null
            ? null
            : ns(rights["retentionUntil"] as string),
      });
      let headReads = 0;
      f.state.onQuery = async (query) => {
        if (/from "?vertex_policy_heads"?/.test(query.sql)) {
          headReads += 1;
          if (headReads === 2) f.state.at = "2026-09-22T12:31:00.000000001Z";
        }
        return;
      };
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      expect(headReads).toBe(2);
      expect(f.getBounded).toHaveBeenCalledTimes(1);
      return expect(f.selection.expiresAt).toBe(fixtureExpires);
    }
  );
  it.each([
    "account-scope",
    "selection-1",
    `policy-consumer:${serviceId}`,
    "selected-retention-artifact",
  ])(
    "rejects required %s grant expiry during final materialization",
    async (resourceId) => {
      const f = await retentionHarness();
      const row = f.authRows.find(
        (candidate) => candidate["resource_id"] === resourceId
      )!;
      const expiresAt = "2026-09-22T12:30:00.000000001Z";
      const value = { ...(row["version_payload"] as Row), expiresAt };
      Object.assign(row, {
        version_payload: value,
        record_hash: await hashArtifact(value),
        expires_at_ns: ns(expiresAt),
      });
      let headReads = 0;
      f.state.onQuery = async (query) => {
        if (/from "?vertex_policy_heads"?/.test(query.sql)) {
          headReads += 1;
          if (headReads === 2) f.state.at = "2026-09-22T12:31:00.000000001Z";
        }
        return;
      };
      await expect(f.read()).rejects.toThrow("Vertex policy unavailable");
      expect(headReads).toBe(2);
      expect(f.getBounded).toHaveBeenCalledTimes(1);
      expect(f.selection.expiresAt).toBe(fixtureExpires);
      return expect(
        f.authRows
          .filter((candidate) => candidate !== row)
          .every(
            (candidate) => candidate["expires_at_ns"] === ns(fixtureExpires)
          )
      ).toBe(true);
    }
  );
  it("detaches bytes before later awaits and never returns content permission or an effective TTL", async () => {
    const f = await retentionHarness();
    let reads = 0;
    f.state.onQuery = async (query) => {
      if (/from "?vertex_policy_heads"?/.test(query.sql)) {
        reads += 1;
        if (reads === 2) f.state.body.fill(0);
      }
      return;
    };
    const result = await f.read();
    expect(result.policy).toEqual(retentionDocument());
    expect(result).not.toHaveProperty("authorized");
    expect(result).not.toHaveProperty("ready");
    expect(result).not.toHaveProperty("cleanupWitness");
    expect(result.policy).not.toHaveProperty("expiresAt");
    return expect(result.policy).not.toHaveProperty("ttlMilliseconds");
  });
  it("never promotes read-right retentionUntil or observation time into selected cleanup terms", async () => {
    const f = await retentionHarness();
    const retentionUntil = "2026-09-22T12:30:00.000000001Z";
    const rights = { ...(f.rightsRow["payload"] as Row), retentionUntil };
    Object.assign(f.rightsRow, {
      payload: rights,
      record_hash: await hashArtifact(rights),
      retention_until_ns: ns(retentionUntil),
    });
    const first = await f.read();
    f.state.at = "2026-09-22T12:01:00.000000001Z";
    const second = await f.read();
    expect(first.checkedAt).not.toBe(second.checkedAt);
    expect(first.policy).toEqual(second.policy);
    expect(first.artifact).toEqual(second.artifact);
    expect(first.policy).not.toHaveProperty("retentionUntil");
    await expect(
      f.runtime.registry.stage({
        ...f.lookup,
        principal: fixturePrincipal,
        commandId: "observation-is-not-issuance",
        expectedRevision: "2",
        selection: f.selection,
      })
    ).rejects.toThrow("Vertex policy unavailable");
    return expect(
      f.calls.some((q) => /^(insert|update|delete)/i.test(q.sql))
    ).toBe(false);
  });
  return it("normalizes unknown DB/object failures to the fixed unavailable result", async () => {
    for (const target of ["db", "object"]) {
      const f = await retentionHarness();
      const unavailable = async (): Promise<void> => {
        throw new Error("synthetic internal details");
      };
      if (target === "db") f.state.onQuery = unavailable;
      if (target === "object") f.state.onGet = unavailable;
      await expect(f.read()).rejects.toMatchObject({
        code: "unavailable",
        message: "Vertex policy unavailable",
      });
    }
    return;
  });
});
