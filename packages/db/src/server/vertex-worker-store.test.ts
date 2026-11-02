import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type { VertexRecord, VertexScope } from "./vertex-ports.ts";
import {
  createVertexWorkerStore,
  type VertexWorkerOptions,
} from "./vertex-worker-store.ts";

// Authored, deliberately not executed during the build-first implementation wave.
// Fixture registry is not a second worker wire schema; API integration injects
// actual authoritative Civet parsers. No SQL server/provider/token is used here.
const scope: VertexScope = {
  accountAlias: "research-one",
  environment: "paper",
};
const before = "2026-09-22T12:00:00.000000001Z";
const now = "2026-09-22T12:00:01.000000001Z";
const later = "2026-09-22T12:05:00.000000001Z";
const digest = "a".repeat(64);
const fixtureHash = async (value: unknown) =>
  hashArtifact(canonicalArtifactJson(value));
const lease = {
  schemaVersion: "1.0.0",
  ...scope,
  jobId: "job-one",
  eventId: "event-one",
  kind: "research-run",
  researchPrincipalId: "researcher",
  payloadArtifactId: "payload-one",
  payloadSha256: digest,
  policySelectionId: "selection-one",
  policySelectionSha256: digest,
  deadlineAt: later,
  leaseId: "worker-one",
  leaseEpoch: "3",
  leaseExpiresAt: later,
  attempt: 1,
};
const fence = {
  ...scope,
  jobId: lease.jobId,
  leaseId: lease.leaseId,
  leaseEpoch: lease.leaseEpoch,
};

const harness = async (jobLease = lease) => {
  const scope: VertexScope = {
    accountAlias: jobLease.accountAlias,
    environment: jobLease.environment,
  };
  const lease = jobLease;
  const dialect = new PgDialect();
  const allowed = new Map<string, Set<string>>();
  const register = (name: string, value: unknown): void => {
    if (!allowed.has(name)) allowed.set(name, new Set());
    allowed.get(name)!.add(canonicalArtifactJson(value));
  };
  const grant = {
    grantId: "grant-one",
    servicePrincipalId: "native-service",
    ...scope,
    operations: [
      "status",
      "renew",
      "complete",
      "cancel",
      "stageArtifact",
      "readDataset",
    ],
    issuedAt: before,
    expiresAt: later,
    revokedAt: null,
  };
  register("WorkerServiceGrant", grant);
  register("WorkerLease", lease);
  const grantRow: Record<string, unknown> = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: grant.grantId,
    service_principal_id: grant.servicePrincipalId,
    credential_digest: digest,
    issued_at_ns: timestampToEpochNanoseconds(before).toString(),
    expires_at_ns: timestampToEpochNanoseconds(later).toString(),
    revoked_at: null,
    record_hash: await fixtureHash(grant),
    payload: grant,
  };
  let job: VertexRecord = {
    job_id: lease.jobId,
    event_id: lease.eventId,
    grant_id: grant.grantId,
    worker_instance_id: lease.leaseId,
    state: "running",
    lease_id: lease.leaseId,
    lease_epoch: lease.leaseEpoch,
    lease_expires_at_ns: timestampToEpochNanoseconds(later).toString(),
    deadline_at_ns: timestampToEpochNanoseconds(later).toString(),
    output_artifact_ids: [],
    outcome_hash: null,
    payload: lease,
  };
  let clock = now;
  const calls: string[] = [];
  const execute = vi.fn(async (statement) => {
    const query = dialect.sqlToQuery(statement);
    calls.push(query.sql);
    if (query.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (query.sql.startsWith('select * from "vertex_worker_service_grants"'))
      return { rows: [grantRow] };
    if (query.sql.startsWith('select * from "vertex_worker_jobs"'))
      return { rows: [job] };
    // No committed or preparatory originals exist in this denial-only harness.
    if (query.sql.startsWith('select * from "vertex_worker_stages"'))
      return { rows: [] };
    if (
      query.sql.startsWith("update vertex_worker_jobs set state = 'unknown'")
    ) {
      job = { ...job, state: "unknown" };
      return { rows: [] };
    }
    throw new Error("Unexpected fixture SQL");
  });
  const transaction = vi.fn(async (body) => body({ execute }));
  const objects = { putIfAbsent: vi.fn(), getBounded: vi.fn() };
  const modelUse = vi.fn();
  const epochTransition = vi.fn();
  const options: VertexWorkerOptions = {
    boundary: {
      encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
      digest: async (bytes) => hashArtifact(new TextDecoder().decode(bytes)),
      validate: async () => {
        throw new Error("No domain fixture");
      },
    },
    validateWorker: async (name, value) => {
      if (name === "WorkerResult") return value as VertexRecord;
      if (!allowed.get(name)?.has(canonicalArtifactJson(value)))
        throw new Error("Unregistered exact fixture");
      return structuredClone(value) as VertexRecord;
    },
    clock: { now: () => clock },
    authorization: { authorize: vi.fn(async () => true) },
    maxProjectionAgeMs: 1000,
    objectCapabilities: () => objects,
    authorizeGrantAdministration: vi.fn(async () => false),
    authorizeBootstrapEnqueue: vi.fn(async () => false),
    authorizeNativeBootstrap: vi.fn(async () => false),
    policySelection: vi.fn(),
    pinPolicySelection: vi.fn(),
    modelUse,
    epochTransition,
    nativeProjectionPrincipal: vi.fn(),
    nativeOutboxReplay: vi.fn(),
  };
  const store = createVertexWorkerStore(
    { transaction } as unknown as Database,
    options
  );
  return {
    store,
    register,
    grantRow,
    calls,
    objects,
    modelUse,
    epochTransition,
    options,
    setClock: (value: string) => {
      return (clock = value);
    },
    setJob: (value: VertexRecord) => {
      return (job = { ...job, ...value });
    },
  };
};

describe("worker current identity and lease fences", () => {
  it("rejects forged identities even when every caller-authored field matches", async () => {
    const h = await harness();
    h.register("WorkerStatusInput", { ...scope, jobId: lease.jobId });
    await expect(
      h.store.invoke(
        {
          grantId: "grant-one",
          servicePrincipalId: "native-service",
          scope,
          expiresAt: later,
        },
        "status",
        { ...scope, jobId: lease.jobId }
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.objects.putIfAbsent).not.toHaveBeenCalled();
  });
  it("rechecks revocation after authentication rather than trusting the cached grant", async () => {
    const h = await harness();
    const identity = await h.store.authenticate(digest, scope, "status");
    h.grantRow["revoked_at"] = now;
    const input = { ...scope, jobId: lease.jobId };
    h.register("WorkerStatusInput", input);
    return await expect(
      h.store.invoke(identity, "status", input)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("marks an expired running lease unknown without rearming or reexecuting", async () => {
    const h = await harness();
    const identity = await h.store.authenticate(digest, scope, "status");
    h.setJob({
      lease_expires_at_ns: timestampToEpochNanoseconds(now).toString(),
    });
    const input = { ...scope, jobId: lease.jobId };
    h.register("WorkerStatusInput", input);
    await expect(
      h.store.invoke(identity, "status", input)
    ).resolves.toMatchObject({
      status: "unknown",
      state: "unknown",
      lease: null,
    });
    expect(h.objects.putIfAbsent).not.toHaveBeenCalled();
    return expect(h.modelUse).not.toHaveBeenCalled();
  });
  it("rejects a stale lease epoch before content upload or publication effects", async () => {
    const h = await harness();
    const identity = await h.store.authenticate(digest, scope, "stageArtifact");
    const input = {
      ...fence,
      leaseEpoch: "2",
      collectionId: null,
      artifactId: "artifact",
      contentBase64: "e30=",
      contentSha256: digest,
      canonicalSha256: digest,
      contentType: "application/json",
      rightsPolicyId: "rights",
      rightsVersion: "1.0.0",
      lineageArtifactIds: [],
    };
    h.register("WorkerStageArtifactInput", input);
    await expect(
      h.store.invoke(identity, "stageArtifact", input)
    ).rejects.toMatchObject({ code: "stale" });
    return expect(h.objects.putIfAbsent).not.toHaveBeenCalled();
  });
  it("cannot complete unknown effects or reinterpret acknowledgement as success", async () => {
    const h = await harness();
    const identity = await h.store.authenticate(digest, scope, "complete");
    h.setJob({ state: "unknown" });
    const input = {
      ...fence,
      outcome: "succeeded",
      outcomeSha256: digest,
      outputArtifactIds: [],
    };
    h.register("WorkerCompleteInput", input);
    await expect(
      h.store.invoke(identity, "complete", input)
    ).rejects.toMatchObject({ code: "stale" });
    return expect(
      h.calls.some((query) => query.includes("outcome_hash ="))
    ).toBe(false);
  });
  it("requires independent privileged issue authorization without generating a credential", async () => {
    const h = await harness();
    await expect(
      h.store.issueGrant({ callerFlag: "admin" }, h.grantRow["payload"], digest)
    ).rejects.toMatchObject({ code: "denied" });
    expect(
      h.calls.some((query) => /\b(insert|update|delete)\b/i.test(query))
    ).toBe(false);
    return expect(h.options.authorizeGrantAdministration).toHaveBeenCalledWith(
      { callerFlag: "admin" },
      "issue",
      scope,
      (h.grantRow["payload"] as Record<string, unknown>)["grantId"],
      expect.objectContaining({
        grant: h.grantRow["payload"],
        credentialDigest: digest,
        recordSha256: h.grantRow["record_hash"],
        previousRecordSha256: h.grantRow["record_hash"],
        authorizationSha256: await hashArtifact({
          grant: h.grantRow["payload"],
          credentialDigest: digest,
        }),
        tx: expect.any(Object),
      })
    );
  });
  it("keeps issued-reference provenance across the extracted owner and denies clones and other instances", async () => {
    const h = await harness();
    const other = await harness();
    const input = { ...scope, jobId: lease.jobId };
    h.register("WorkerStatusInput", input);
    other.register("WorkerStatusInput", input);
    const identity = await h.store.authenticate(digest, scope, "status");
    await expect(
      h.store.invoke({ ...identity }, "status", input)
    ).rejects.toMatchObject({ code: "denied" });
    return await expect(
      other.store.invoke(identity, "status", input)
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("metadata permission never becomes an existing worker execution permission", async () => {
    const h = await harness();
    const value = {
      ...(h.grantRow["payload"] as VertexRecord),
      operations: ["chat-copy-cleanup-discovery"],
    };
    h.register("WorkerServiceGrant", value);
    h.grantRow["payload"] = value;
    h.grantRow["record_hash"] = await fixtureHash(value);
    await expect(
      h.store.authenticate(digest, scope, "status")
    ).rejects.toMatchObject({ code: "denied" });
    const identity = await h.store.authenticate(
      digest,
      scope,
      "chat-copy-cleanup-discovery"
    );
    const input = { ...scope, jobId: lease.jobId };
    h.register("WorkerStatusInput", input);
    await expect(
      h.store.invoke(identity, "status", input)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.options.policySelection).not.toHaveBeenCalled();
    return expect(h.objects.getBounded).not.toHaveBeenCalled();
  });
  it("revocation retains exact immutable grant/digest approval and never trusts a caller admin flag", async () => {
    const h = await harness();
    await expect(
      h.store.revokeGrant({ callerFlag: "admin" }, scope, "grant-one")
    ).rejects.toMatchObject({ code: "denied" });
    const value = h.grantRow["payload"];
    expect(h.options.authorizeGrantAdministration).toHaveBeenCalledWith(
      { callerFlag: "admin" },
      "revoke",
      scope,
      "grant-one",
      expect.objectContaining({
        grant: value,
        credentialDigest: digest,
        recordSha256: h.grantRow["record_hash"],
        previousRecordSha256: h.grantRow["record_hash"],
        authorizationSha256: await fixtureHash({
          grant: value,
          credentialDigest: digest,
        }),
        tx: expect.any(Object),
      })
    );
    return expect(
      h.calls.some((query) => /^(insert|update|delete)/.test(query))
    ).toBe(false);
  });
  return it("rejects credential payload actor substitution even with a recomputed record hash", async () => {
    const h = await harness();
    const value = {
      ...(h.grantRow["payload"] as VertexRecord),
      servicePrincipalId: "other-service",
    };
    h.register("WorkerServiceGrant", value);
    h.grantRow["payload"] = value;
    h.grantRow["record_hash"] = await fixtureHash(value);
    return await expect(
      h.store.authenticate(digest, scope, "status")
    ).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("historical dataset read denial without synthetic positive authority", () => {
  const researchLease = {
    ...lease,
    environment: "research" as const,
    kind: "backtest",
  };
  const researchScope = {
    accountAlias: scope.accountAlias,
    environment: "research" as const,
  };
  const capturePin = {
    collectionId: "synthetic-review-collection",
    evidenceId: "synthetic-capture-evidence",
    artifactId: "synthetic-evidence-original",
    artifactSha256: digest,
    reviewId: "synthetic-review-not-authority",
    reviewVersion: "1.0.0",
    rightsPolicyId: "synthetic-rights",
    rightsVersion: "1.0.0",
  };
  const request = () => ({
    ...fence,
    ...researchScope,
    collectionId: null,
    manifest: {
      artifactId: "synthetic-global-manifest",
      artifactSha256: digest,
    },
    member: "content",
    source: null,
    reviewPins: [capturePin],
  });
  it("denies a global dataset read outside a research backtest before any original-byte read", async () => {
    const h = await harness();
    const identity = await h.store.authenticate(digest, scope, "readDataset");
    const input = { ...request(), ...scope };
    h.register("WorkerReadDatasetInput", input);
    await expect(
      h.store.invoke(identity, "readDataset", input)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.options.policySelection).not.toHaveBeenCalled();
    return expect(h.objects.getBounded).not.toHaveBeenCalled();
  });
  it("denies absent or extraneous capture pins and mismatched collection scope", async () => {
    const h = await harness(researchLease);
    const identity = await h.store.authenticate(
      digest,
      researchScope,
      "readDataset"
    );
    for (const input of [
      { ...request(), reviewPins: [] },
      {
        ...request(),
        reviewPins: [capturePin, { ...capturePin, evidenceId: "unrelated" }],
      },
      { ...request(), collectionId: "other-collection" },
    ]) {
      h.register("WorkerReadDatasetInput", input);
      await expect(
        h.store.invoke(identity, "readDataset", input)
      ).rejects.toMatchObject({ code: "denied" });
    }
    expect(h.options.policySelection).not.toHaveBeenCalled();
    return expect(h.objects.getBounded).not.toHaveBeenCalled();
  });
  it("does not turn an unselected global manifest into read authority", async () => {
    const h = await harness(researchLease);
    vi.mocked(h.options.policySelection).mockResolvedValue({ artifacts: [] });
    const identity = await h.store.authenticate(
      digest,
      researchScope,
      "readDataset"
    );
    const input = request();
    h.register("WorkerReadDatasetInput", input);
    await expect(
      h.store.invoke(identity, "readDataset", input)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.options.policySelection).toHaveBeenCalledWith(
      expect.any(Object),
      { actorId: lease.researchPrincipalId },
      {
        ...researchScope,
        selectionId: lease.policySelectionId,
        selectionSha256: lease.policySelectionSha256,
      },
      "native-service",
      lease.jobId
    );
    return expect(h.objects.getBounded).not.toHaveBeenCalled();
  });
  return it("requires retained original recipe provenance even when its selection label matches", async () => {
    const h = await harness(researchLease);
    vi.mocked(h.options.policySelection).mockResolvedValue({
      artifacts: [
        {
          role: "simulation-engine",
          artifact: {
            contractName: "HostBacktestRecipe",
            schemaVersion: "1.0.0",
            artifactId: "synthetic-recipe-without-original",
            artifactSha256: digest,
          },
        },
      ],
    });
    const identity = await h.store.authenticate(
      digest,
      researchScope,
      "readDataset"
    );
    const input = request();
    h.register("WorkerReadDatasetInput", input);
    await expect(
      h.store.invoke(identity, "readDataset", input)
    ).rejects.toMatchObject({ code: "denied" });
    expect(
      h.calls.some((query) => query.includes('from "vertex_worker_stages"'))
    ).toBe(true);
    expect(h.objects.getBounded).not.toHaveBeenCalled();
    expect(h.objects.putIfAbsent).not.toHaveBeenCalled();
    return expect(
      h.calls.some((query) => /\b(insert|update|delete)\b/i.test(query))
    ).toBe(false);
  });
});

const bootstrapPayload = {
  format: "vertex-native-bootstrap-job-v1",
  journalIdentity: "journal-one",
  simulatorId: "simulator-one",
  streamId: "stream-one",
  selectionId: "selection-one",
  selectionSha256: digest,
  mode: "initialize",
};
const bootstrapCommand = async (overrides: VertexRecord = {}) => ({
  schemaVersion: "1.0.0",
  accountAlias: scope.accountAlias,
  environment: "paper",
  researchPrincipalId: "researcher",
  payloadArtifactId: "bootstrap-payload",
  payloadSha256: await fixtureHash(bootstrapPayload),
  policySelectionId: bootstrapPayload.selectionId,
  policySelectionSha256: bootstrapPayload.selectionSha256,
  rightsPolicyId: "policy-one",
  rightsVersion: "1.0.0",
  issuedAt: before,
  deadlineAt: later,
  idempotencyKey: "bootstrap-one",
  payload: bootstrapPayload,
  ...overrides,
});
// Bootstrap enqueue SQL transport only; both injected authorities and the
// parser are explicit fixtures. No worker job, lease or grant is created.
const bootstrapHarness = (outbox: VertexRecord[] = []) => {
  const dialect = new PgDialect();
  const calls: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (statement) => {
    const query = dialect.sqlToQuery(statement);
    calls.push(query);
    if (query.sql.startsWith('select * from "vertex_outbox"'))
      return { rows: outbox };
    if (/^select\b/i.test(query.sql) && !query.sql.includes("pg_advisory"))
      throw new Error("Unexpected fixture SQL");
    return { rows: [] };
  });
  const transaction = vi.fn(async (body) => body({ execute }));
  const authorizeBootstrapEnqueue = vi.fn(async () => true);
  const authorizeNativeBootstrap = vi.fn(async () => true);
  const parsed: string[] = [];
  const options = {
    boundary: {
      encode: (value: unknown) =>
        new TextEncoder().encode(canonicalArtifactJson(value)),
      digest: async (bytes: Uint8Array) =>
        hashArtifact(new TextDecoder().decode(bytes)),
      validate: async () => {
        throw new Error("No domain fixture");
      },
    },
    validateWorker: async (name: string, value: unknown) => {
      parsed.push(name);
      if (
        name !== "WorkerBootstrapCommand" ||
        typeof value !== "object" ||
        value === null ||
        (value as VertexRecord)["schemaVersion"] !== "1.0.0"
      )
        throw new Error("Unregistered exact fixture");
      return structuredClone(value) as VertexRecord;
    },
    clock: { now: () => now },
    authorization: { authorize: vi.fn(async () => true) },
    maxProjectionAgeMs: 1000,
    objectCapabilities: () => ({}),
    authorizeGrantAdministration: vi.fn(async () => false),
    authorizeBootstrapEnqueue,
    authorizeNativeBootstrap,
    policySelection: vi.fn(),
    pinPolicySelection: vi.fn(),
    modelUse: vi.fn(),
    epochTransition: vi.fn(),
    nativeProjectionPrincipal: vi.fn(),
    nativeOutboxReplay: vi.fn(),
  } as unknown as VertexWorkerOptions;
  const store = createVertexWorkerStore(
    { transaction } as unknown as Database,
    options
  );
  const inserted = () =>
    calls.filter((query) =>
      query.sql.startsWith('insert into "vertex_outbox"')
    );
  return {
    store,
    calls,
    parsed,
    inserted,
    authorizeBootstrapEnqueue,
    authorizeNativeBootstrap,
  };
};

describe("native bootstrap command enqueue", () => {
  it("records one paper-scoped bootstrap event after both injected authorities agree", async () => {
    const h = bootstrapHarness(),
      command = await bootstrapCommand(),
      admin = { operator: "synthetic-admin" };
    const eventId = `bootstrap-${await fixtureHash(command)}`;
    expect(await h.store.enqueueNativeBootstrap(admin, command)).toEqual({
      status: "accepted",
      eventId,
    });
    expect(h.parsed).toEqual(["WorkerBootstrapCommand"]);
    expect(h.authorizeBootstrapEnqueue).toHaveBeenCalledWith(
      admin,
      expect.anything(),
      scope,
      command
    );
    expect(h.authorizeNativeBootstrap).toHaveBeenCalledWith(
      expect.anything(),
      { actorId: "researcher" },
      scope,
      command
    );
    expect(
      h.calls.some((query) =>
        query.sql.startsWith("insert into vertex_accounts")
      )
    ).toBe(true);
    const [insert] = h.inserted();
    expect(insert?.params).toEqual(
      expect.arrayContaining([
        scope.accountAlias,
        "paper",
        eventId,
        "vertex.native-bootstrap.requested",
        command.idempotencyKey,
      ])
    );
    return expect(h.inserted()).toHaveLength(1);
  });
  it("replays an exact prior event and refuses a changed one under the same key", async () => {
    const command = await bootstrapCommand(),
      hash = await fixtureHash(command),
      eventId = `bootstrap-${hash}`;
    const exact = bootstrapHarness([{ event_id: eventId, record_hash: hash }]);
    expect(await exact.store.enqueueNativeBootstrap({}, command)).toEqual({
      status: "duplicate",
      eventId,
    });
    expect(exact.inserted()).toHaveLength(0);
    const changed = bootstrapHarness([
      { event_id: eventId, record_hash: "b".repeat(64) },
    ]);
    await expect(
      changed.store.enqueueNativeBootstrap({}, command)
    ).rejects.toMatchObject({ code: "conflict" });
    const other = bootstrapHarness([
      { event_id: "bootstrap-other", record_hash: hash },
    ]);
    await expect(
      other.store.enqueueNativeBootstrap({}, command)
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(other.inserted()).toHaveLength(0);
  });
  it.each(["enqueue", "native"])(
    "denies without writing when the %s authority refuses",
    async (kind) => {
      const h = bootstrapHarness();
      if (kind === "enqueue")
        h.authorizeBootstrapEnqueue.mockResolvedValueOnce(false);
      if (kind === "native")
        h.authorizeNativeBootstrap.mockResolvedValueOnce(false);
      await expect(
        h.store.enqueueNativeBootstrap({}, await bootstrapCommand())
      ).rejects.toMatchObject({ code: "denied" });
      expect(h.authorizeNativeBootstrap).toHaveBeenCalledTimes(
        kind === "enqueue" ? 0 : 1
      );
      return expect(h.inserted()).toHaveLength(0);
    }
  );
  it.each([
    ["future issue", { issuedAt: later }],
    ["expired deadline", { deadlineAt: before }],
    ["payload digest", { payloadSha256: "b".repeat(64) }],
    ["unparsed command", { schemaVersion: "2.0.0" }],
  ] as const)("rejects a command with a %s", async (_kind, overrides) => {
    const h = bootstrapHarness();
    await expect(
      h.store.enqueueNativeBootstrap({}, await bootstrapCommand(overrides))
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.inserted()).toHaveLength(0);
  });
});
