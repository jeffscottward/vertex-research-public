import { vi } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import { createVertexWorkerStore } from "@darkfactory/db/server/vertex-worker";
import { VERTEX_WORKER_CONTRACT_SCHEMAS } from "../contracts/vertex-worker.ts";
import { parseRuntimePolicySelection } from "../contracts/vertex-policy.ts";
import { createVertexExperienceCommands } from "./vertex-experience-commands.ts";
import {
  fixture,
  actor,
  principal,
  scope,
} from "./vertex-backtest-intent.test-support.ts";
import { mutableClone } from "./mutable-clone.test-support.ts";

// Synthetic persisted originals only. No Host execution, HMAC authenticity,
// scientific acceptance or DB/service integration is implied by this fixture.
// A separate running research-run job consumes the committed producer graph
// through the real worker readBacktestRun proof; nothing in it is mocked.
const now = "2026-09-22T12:00:00Z";
const ns = (value: string) => (BigInt(Date.parse(value)) * 1000000n).toString();
const bytes = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const base64 = (value: unknown) => btoa(canonicalArtifactJson(value));
const digest = "a".repeat(64);
const publishedAt = "2026-09-22T12:00:01Z";
const record = (name: string, fields: Record<string, unknown>) => ({
  record: name,
  fields,
});
const tuple = (values: unknown[]) => ({ tuple: values });
const integer = (value: number) => ({ integer: String(value) });
type ObjectCapabilities = Awaited<
  ReturnType<typeof fixture>
>["objectCapabilities"];

export const backtestRunReadFixture = async () => {
  const h = await fixture();
  const rights = h.objects.get("strategy-original")!.metadata.rights;
  await h.store.putRights(actor, scope, null, rights);
  const remove = (table: string, id: string) => {
    const rows = h.table(table);
    for (let index = rows.length - 1; index >= 0; index -= 1)
      if (rows[index]!["artifact_id"] === id) rows.splice(index, 1);
  };
  const install = async (
    id: string,
    name: string,
    value: Record<string, unknown>,
    recordId: string,
    parents: string[] = [],
    sourceHash: string | null = null,
    at = now
  ) => {
    const body = bytes(value),
      sha = await hashArtifact(body);
    const metadata = {
      artifactId: id,
      scope,
      collectionId: "ssrn",
      objectKey: vertexQualifiedObjectKey(scope, "ssrn", "manifest", sha),
      artifactSha256: sha,
      sourceContentSha256: sourceHash,
      byteLength: body.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName: name,
      rights,
      lineageArtifactIds: parents,
      createdAt: at,
    };
    remove("vertex_artifacts", id);
    remove("vertex_records", id);
    remove("vertex_artifact_lineage", id);
    h.objects.set(id, { bytes: body, metadata } as never);
    await h.store.registerArtifact(actor, metadata as never);
    h.table("vertex_records").push({
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: "ssrn",
      contract_name: name,
      record_id: recordId,
      version: name === "BacktestRun" ? sha : "1.0.0",
      artifact_id: id,
      artifact_sha256: sha,
      record_hash: sha,
      recorded_at: at,
      payload: value,
    });
    if (name === "BacktestRun")
      h.table("vertex_backtest_versions").push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        artifact_id: id,
        run_id: value["runId"],
        strategy_artifact_id: value["strategyVersion"],
        results_ref: value["resultsRef"],
      });
    return { artifactId: id, sha256: sha };
  };
  const decoded = (id: string): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(h.objects.get(id)!.bytes));
  const strategyValue = decoded("strategy-original");
  const plannedValue = {
    ...decoded("planned-original"),
    runId: "planned-original",
  };
  const strategy = await install(
    "strategy-original",
    "StrategySpec",
    strategyValue,
    String(strategyValue["strategyId"])
  );
  const planned = await install(
    "planned-original",
    "BacktestRun",
    plannedValue,
    "planned-original"
  );
  const datasetContentSha = await hashArtifact({
    synthetic: "retained-source",
  });
  const dataset = await install(
    "dataset-manifest",
    "DatasetManifest",
    {
      schemaVersion: "1.0.0",
      datasetId: "dataset",
      provider: "synthetic",
      entitlementPolicyId: rights.policyId,
      instrumentUniverse: ["instrument"],
      startAtInclusive: "2026-09-20T00:00:00Z",
      endAtExclusive: now,
      captureTime: now,
      dataVintageId: "vintage",
      dataVintageStatus: "available",
      asOfAt: now,
      adjustmentMethod: "unadjusted",
      calendar: "XNYS",
      contentHash: datasetContentSha,
      storageRef: "synthetic-data",
      retentionPolicy: "retention",
      sources: [
        {
          provider: "synthetic",
          sourceId: "synthetic-data",
          snapshotId: "snapshot",
          contentHash: datasetContentSha,
        },
      ],
      gammaProvenance: null,
    },
    "dataset"
  );
  h.table("vertex_datasets").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    dataset_id: "dataset",
    collection_key: "ssrn",
    artifact_id: dataset.artifactId,
  });
  const engine = {
    identity: "vertex-nautilus-quote-research",
    version: "1.0.0",
    digest,
  };
  const code = {
    identity: "synthetic-strategy-code",
    version: "1.0.0",
    digest: strategyValue["codeDigest"],
  };
  const lineage = {
    strategyVersionId: strategy.artifactId,
    strategyFrozenAt: now,
    codePin: code,
    enginePin: engine,
    dataPins: [],
    pointInTime: [],
    assumptions: [],
    folds: [],
    trials: null,
    forwardCriteria: null,
    incidents: [],
    citations: [],
    acceptanceCriteria: [],
    environmentDigest: digest,
  };
  const budget = {
    maximum_input_bytes: 1_048_576,
    maximum_events: 10,
    maximum_candidates: 1,
    maximum_folds: 1,
    maximum_trials: 1,
    maximum_memory_bytes: 1_048_576,
    maximum_cpu_ms: 1000,
    maximum_wall_ms: 1000,
    network_allowed: false,
    execution_allowed: false,
  };
  const descriptor = {
    pin: engine,
    modeled_assumptions: ["commission", "slippage", "spread"],
    supported_formats: ["vertex-jsonl-events-v1"],
    sandbox_policy_digest: digest,
    simulation_only: true,
  };
  const recipe = {
    ...h.state.recipe,
    strategy,
    run: planned,
    datasets: [
      {
        manifest: dataset,
        content: { artifactId: "synthetic-data", sha256: datasetContentSha },
        contentFormat: "canonical-json",
        declaredEvents: 1,
      },
    ],
    lineage: record("LineageInputs", {
      strategy_version_id: strategy.artifactId,
      strategy_frozen_at: now,
      code_pin: record("Pin", code),
      engine_pin: record("Pin", engine),
      data_pins: tuple([]),
      point_in_time: tuple([]),
      assumptions: tuple([]),
      folds: tuple([]),
      trials: null,
      forward_criteria: null,
      incidents: tuple([]),
      citations: tuple([]),
      acceptance_criteria: tuple([]),
      environment_digest: digest,
    }),
    budget: record(
      "ResourceBudget",
      Object.fromEntries(
        Object.entries(budget).map(([key, value]) => [
          key,
          typeof value === "number" ? integer(value) : value,
        ])
      )
    ),
    descriptor: record("EngineDescriptor", {
      ...descriptor,
      pin: record("Pin", engine),
      modeled_assumptions: tuple(descriptor.modeled_assumptions),
      supported_formats: tuple(descriptor.supported_formats),
    }),
    plannedAt: now,
    model: {
      ...h.state.recipe.model,
      strategy_digest: strategy.sha256,
      strategy_code_digest: String(strategyValue["codeDigest"]),
      assumptions_digest: await hashArtifact([]),
      engine_digest: digest,
      native_configuration_bytes: base64({
        distribution: { name: "nautilus-trader", version: "2.0.0rc5" },
      }),
    },
  };
  h.state.recipe = recipe as never;
  const recipeSha = await hashArtifact(recipe);
  // A selection expiring before the route TTL bounds the producer deadline.
  const { selectionSha256: omitted, ...selectionBody } = mutableClone(
    h.state.selection
  );
  selectionBody.expiresAt = "2026-09-22T12:00:05Z";
  selectionBody.artifacts[0]!.artifact.artifactSha256 = recipeSha;
  h.state.selection = await parseRuntimePolicySelection({
    ...selectionBody,
    selectionSha256: await hashArtifact(selectionBody),
  });
  const selection = h.state.selection;
  const policyIdentity = {
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    selectionRevision: selection.revision,
    revision: "1",
  };
  const commands = createVertexExperienceCommands({
    ...h.deps,
    resolvePolicy: async () => ({ policyIdentity, research: h.deps.research }),
  } as never);
  await commands.proposeResearch(principal, {
    ...h.input,
    backtestExpectation: {
      ...h.input.backtestExpectation!,
      strategy,
      plannedRun: planned,
      recipe: { artifactId: "recipe", sha256: recipeSha },
      policy: {
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
        selectionRevision: selection.revision,
      },
    },
  });
  // The real resolver dispatches this exact selected request.
  const binding = (await h.dispatch())!;
  const event = h.table("vertex_outbox")[0]!,
    eventId = String(event["event_id"]);
  const jobId = `job-${await hashArtifact({ scope, eventId })}`;
  const lease = {
    schemaVersion: "1.0.0",
    jobId,
    eventId,
    ...scope,
    ...binding,
    leaseId: "fixture-worker",
    leaseEpoch: "1",
    leaseExpiresAt: binding.deadlineAt,
    attempt: 1,
  };
  const job = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    event_id: eventId,
    grant_id: "historical-grant",
    worker_instance_id: "fixture-worker",
    binding_hash: await hashArtifact({ scope, eventId, ...binding }),
    state: "succeeded",
    lease_id: lease.leaseId,
    lease_epoch: lease.leaseEpoch,
    lease_expires_at_ns: ns(lease.leaseExpiresAt),
    deadline_at_ns: ns(lease.deadlineAt),
    attempt: 1,
    outcome_hash: digest as string | null,
    output_artifact_ids: [] as string[],
    payload: lease,
  };
  h.table("vertex_worker_jobs").push(job);
  event["published_at"] = now;
  const stage = async (
    id: string,
    value: unknown,
    collection: string | null,
    producer: string,
    canonical: boolean,
    parents: string[],
    at = publishedAt
  ) => {
    const body = bytes(value),
      sha = await hashArtifact(body),
      key = vertexQualifiedObjectKey(
        scope,
        collection,
        canonical ? "manifest" : "content",
        sha
      );
    const payload = {
      schemaVersion: "1.0.0",
      jobId: producer,
      ...scope,
      collectionId: collection,
      artifactId: id,
      contentSha256: sha,
      canonicalSha256: canonical ? sha : null,
      contentType: "application/json",
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
      lineageArtifactIds: parents,
      createdAt: at,
    };
    h.table("vertex_worker_stages").push({
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: collection ?? "",
      artifact_id: id,
      job_id: producer,
      content_sha256: sha,
      canonical_sha256: canonical ? sha : null,
      object_key: key,
      byte_length: body.byteLength,
      request_hash: await hashArtifact(payload),
      payload,
    });
    h.objects.set(`stage-${id}`, {
      bytes: body,
      metadata: { objectKey: key },
    } as never);
    return { artifactId: id, sha256: sha };
  };
  await stage(
    "recipe",
    recipe,
    null,
    "historical-recipe-preparer",
    true,
    [],
    now
  );
  await stage(
    binding.payloadArtifactId,
    {
      format: "vertex-backtest-job-v1",
      recipeArtifactId: "recipe",
      recipeSha256: recipeSha,
    },
    "ssrn",
    jobId,
    true,
    [],
    now
  );
  h.table("vertex_worker_run_admissions").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    run_id: jobId,
    request_hash: binding.payloadSha256,
    lease_epoch: "1",
    admitted_at: now,
  });
  const grantRow = async (
    value: Record<string, unknown> & {
      grantId: string;
      servicePrincipalId: string;
      issuedAt: string;
      expiresAt: string;
    },
    credentialDigest?: string
  ) => ({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: value.grantId,
    service_principal_id: value.servicePrincipalId,
    ...(credentialDigest ? { credential_digest: credentialDigest } : {}),
    issued_at_ns: ns(value.issuedAt),
    expires_at_ns: ns(value.expiresAt),
    revoked_at: null,
    record_hash: await hashArtifact(value),
    payload: value,
  });
  const grant = {
    grantId: job.grant_id,
    servicePrincipalId: "historical-service",
    ...scope,
    operations: ["admitRun", "stageArtifact", "publishArtifact", "complete"],
    issuedAt: now,
    expiresAt: "2026-09-22T12:00:03Z",
    revokedAt: null,
  };
  h.table("vertex_worker_service_grants").push(await grantRow(grant));
  h.table("vertex_policy_selections").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    selection_id: selection.selectionId,
    selection_sha256: selection.selectionSha256,
    revision: selection.revision,
    issued_at_ns: ns(selection.issuedAt),
    expires_at_ns: ns(selection.expiresAt),
    payload: selection,
  });
  const module = selection.modules[0]!;
  const ownership = {
    holderId: jobId,
    holderKind: "job",
    ...scope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    ownerServiceId: grant.servicePrincipalId,
    ownerEpoch: "1",
    pinnedAt: now,
    releasedAt: "2026-09-22T12:00:02Z",
    module,
  };
  h.table("vertex_policy_ownership_pins").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    holder_id: jobId,
    holder_kind: "job",
    selection_id: selection.selectionId,
    selection_sha256: selection.selectionSha256,
    owner_service_id: grant.servicePrincipalId,
    owner_epoch: "1",
    pinned_at_ns: ns(now),
    released_at_ns: ns(ownership.releasedAt),
    module_id: module.moduleId,
    module_version: module.version,
    code_sha256: module.codeSha256,
    record_hash: await hashArtifact(ownership),
    payload: ownership,
  });
  const sourceEvidence = (
    id: string,
    sourceId: string,
    sha: string,
    sourceLocator = sourceId
  ) => ({
    schemaVersion: "1.0.0",
    evidenceId: id,
    collectionId: "ssrn",
    snapshotId: recipe.publication.snapshotId,
    sourceType: "derived-analysis",
    sourceUri: "https://synthetic.invalid/backtest",
    sourceIdentity: {
      provider: "synthetic",
      sourceId,
      snapshotId: recipe.publication.snapshotId,
      contentHash: sha,
    },
    sourceLocator,
    attribution: "Synthetic retained source",
    publishedAt: null,
    capturedAt: publishedAt,
    contentHash: sha,
    claim: "Synthetic simulation integrity fixture",
    method: "Synthetic source construction",
    limitations: ["Not execution or scientific acceptance"],
    acceptanceStatus: "unreviewed",
    rightsPolicyId: rights.policyId,
    untrustedContent: true,
  });
  const observation = {
    session_id: "synthetic-session",
    thread_profile: "nautilus-rc5-glibc244-x86_64-2task-v1",
    policy_digest: digest,
  };
  const isolationValue = {
    bindingDigest: digest,
    enforcement: { parentObservation: observation },
  };
  const isolationSha = await hashArtifact(isolationValue),
    isolationId = `sandbox-isolation-${isolationSha}`,
    isolationEvidenceId = `isolation-${observation.session_id}`;
  const isolationEvidence = sourceEvidence(
    isolationEvidenceId,
    isolationEvidenceId,
    isolationSha,
    isolationId
  );
  const isolationEvidenceSha = await hashArtifact(isolationEvidence);
  const expectedLineage = {
    strategyDigest: strategy.sha256,
    runDigest: planned.sha256,
    datasetManifestDigests: [dataset.sha256],
    evidenceDigests: [],
    lineage,
    budget,
    engineDescriptor: descriptor,
    gammaReplayEvidence: null,
    gammaSourceCaptures: [],
    plannedAt: now,
    proposalOnly: true,
    executionAuthorized: false,
  };
  const resultValue = {
    assumptionDigest: await hashArtifact([]),
    datasetContentDigests: [datasetContentSha],
    economics: {
      model: engine.identity,
      modelVersion: engine.version,
      reviewDigest: recipe.model.review_digest,
    },
    economicsOrigin: "injected-simulation-engine",
    economicsSimulated: true,
    enginePin: engine,
    evidenceDigests: [isolationEvidenceSha],
    executionAuthorized: false,
    forwardAssessment: {},
    incidentCodes: [],
    lineageDigest: await hashArtifact(expectedLineage),
    sandbox: {
      isolation_evidence_id: isolationEvidenceId,
      limits_enforced: true,
      network_used: false,
      execution_authority_used: false,
      policy_digest: digest,
      budget,
    },
    strategyDigest: strategy.sha256,
  };
  const resultsSha = await hashArtifact(resultValue),
    resultsId = `backtest-results-${resultsSha}`;
  const captureId = async (prefix: string, id: string, sha: string) =>
    `${prefix}${await hashArtifact({ sourceArtifactId: id, sourceContentSha256: sha, isolationEvidenceId, isolationEvidenceSha256: isolationEvidenceSha })}`;
  const resultEvidenceId = await captureId(
    "backtest-results-evidence-",
    resultsId,
    resultsSha
  );
  const resultEvidence = sourceEvidence(
    resultEvidenceId,
    resultsId,
    resultsSha
  );
  const attestation = (phase: string) =>
    base64({
      mac: digest,
      payload: base64({
        phase,
        bindingDigest: digest,
        enforcementDigest: isolationSha,
        ...(phase === "finish" ? { outputDigest: digest } : {}),
      }),
    });
  const receiptValue = {
    format: "vertex-worker-observation-v1",
    processExited: true,
    cgroupEmpty: true,
    isolationArtifactId: isolationId,
    observation,
    outputSha256: digest,
    startAttestationBase64: attestation("start"),
    finishAttestationBase64: attestation("finish"),
    cpuMs: 1,
    wallMs: 1,
    peakMemoryBytes: 1024,
    memoryEvents: {},
  };
  const receiptSha = await hashArtifact(receiptValue),
    receiptId = `sandbox-receipt-${receiptSha}`;
  const receiptEvidenceId = await captureId(
      "sandbox-receipt-evidence-",
      receiptId,
      receiptSha
    ),
    receiptEvidence = sourceEvidence(receiptEvidenceId, receiptId, receiptSha);
  const inputs = [planned.artifactId, strategy.artifactId, dataset.artifactId];
  h.access.at = publishedAt;
  await install(
    resultEvidenceId,
    "ResearchEvidence",
    resultEvidence,
    resultEvidenceId,
    inputs,
    resultsSha,
    publishedAt
  );
  await install(
    isolationEvidenceId,
    "ResearchEvidence",
    isolationEvidence,
    isolationEvidenceId,
    [resultEvidenceId],
    isolationSha,
    publishedAt
  );
  await install(
    receiptEvidenceId,
    "ResearchEvidence",
    receiptEvidence,
    receiptEvidenceId,
    [resultEvidenceId, isolationEvidenceId],
    receiptSha,
    publishedAt
  );
  await stage(resultsId, resultValue, "ssrn", jobId, false, inputs);
  await stage(resultEvidenceId, resultEvidence, "ssrn", jobId, true, inputs);
  await stage(isolationId, isolationValue, "ssrn", jobId, false, [
    resultEvidenceId,
  ]);
  await stage(isolationEvidenceId, isolationEvidence, "ssrn", jobId, true, [
    resultEvidenceId,
  ]);
  await stage(receiptId, receiptValue, "ssrn", jobId, false, [
    resultEvidenceId,
    isolationEvidenceId,
  ]);
  await stage(receiptEvidenceId, receiptEvidence, "ssrn", jobId, true, [
    resultEvidenceId,
    isolationEvidenceId,
  ]);
  const completedValue = {
      ...plannedValue,
      resultsRef: resultsId,
      reviewStatus: "incomplete",
    },
    completedSha = await hashArtifact(completedValue),
    completedId = `backtest-run-${completedSha}`;
  const parents = [
    ...inputs,
    resultEvidenceId,
    isolationEvidenceId,
    receiptEvidenceId,
  ];
  await install(
    completedId,
    "BacktestRun",
    completedValue,
    "planned-original",
    parents,
    null,
    publishedAt
  );
  await stage(completedId, completedValue, "ssrn", jobId, true, parents);
  job.output_artifact_ids = [
    resultEvidenceId,
    isolationEvidenceId,
    receiptEvidenceId,
    completedId,
  ];
  // The consuming research-run job: its own grant, fence and live lease. The
  // lease may be renewed up to its fixed deadline.
  const consumerAt = "2026-09-22T12:00:20Z";
  const consumerLeaseEnd = "2026-09-22T12:00:40Z";
  const consumerEnd = "2026-09-22T12:00:50Z";
  const credentialDigest = "c".repeat(64);
  const consumerGrant = {
    grantId: "consumer-grant",
    servicePrincipalId: "consumer-service",
    ...scope,
    operations: [
      "readBacktestRun",
      "readArtifact",
      "renew",
      "readiness",
      "readCollection",
      "policySelection",
    ],
    issuedAt: "2026-09-22T12:00:10Z",
    expiresAt: "2026-09-22T12:01:00Z",
    revokedAt: null,
  };
  h.table("vertex_worker_service_grants").push(
    await grantRow(consumerGrant, credentialDigest)
  );
  const consumerLease = {
    schemaVersion: "1.0.0",
    jobId: "consumer-job",
    eventId: "consumer-event",
    kind: "research-run",
    researchPrincipalId: actor.actorId,
    ...scope,
    payloadArtifactId: "consumer-recipe",
    payloadSha256: digest,
    policySelectionId: selection.selectionId,
    policySelectionSha256: selection.selectionSha256,
    deadlineAt: consumerEnd,
    leaseId: "consumer-lease",
    leaseEpoch: "1",
    leaseExpiresAt: consumerLeaseEnd,
    attempt: 1,
  };
  const consumer = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: consumerLease.jobId,
    event_id: consumerLease.eventId,
    grant_id: consumerGrant.grantId,
    worker_instance_id: "consumer-worker",
    binding_hash: digest,
    state: "running",
    lease_id: consumerLease.leaseId,
    lease_epoch: consumerLease.leaseEpoch,
    lease_expires_at_ns: ns(consumerLeaseEnd),
    deadline_at_ns: ns(consumerEnd),
    attempt: 1,
    outcome_hash: null,
    output_artifact_ids: [] as string[],
    payload: consumerLease,
  };
  h.table("vertex_worker_jobs").push(consumer);
  h.access.at = consumerAt;
  const policySelection = vi.fn(async () => selection);
  const workerWith = (objectCapabilities: ObjectCapabilities) =>
    createVertexWorkerStore(h.db, {
      ...h.options,
      objectCapabilities,
      policySelection,
      validateWorker: async (name: string, value: unknown) =>
        VERTEX_WORKER_CONTRACT_SCHEMAS[
          name as keyof typeof VERTEX_WORKER_CONTRACT_SCHEMAS
        ].parse(value) as never,
    } as never);
  const fence = {
    ...scope,
    jobId: consumerLease.jobId,
    leaseId: consumerLease.leaseId,
    leaseEpoch: consumerLease.leaseEpoch,
  };
  const input = {
    ...fence,
    collectionId: "ssrn",
    artifact: { artifactId: completedId, artifactSha256: completedSha },
    plannedRun: {
      artifactId: planned.artifactId,
      artifactSha256: planned.sha256,
    },
    results: { artifactId: resultsId, artifactSha256: resultsSha },
    recipe: { artifactId: "recipe", artifactSha256: recipeSha },
  };
  const invoke = async (
    operation: string,
    value: unknown,
    worker = workerWith(h.objectCapabilities)
  ) => {
    const identity = await worker.authenticate(
      credentialDigest,
      scope,
      operation
    );
    return worker.invoke(identity, operation, value);
  };
  const read = (
    worker = workerWith(h.objectCapabilities),
    value: unknown = input
  ) => invoke("readBacktestRun", value, worker);
  return {
    ...h,
    job,
    consumer,
    consumerGrant,
    grant,
    selection,
    policySelection,
    workerWith,
    fence,
    input,
    invoke,
    read,
    expected: {
      jobId,
      completedRun: { artifactId: completedId, artifactSha256: completedSha },
      completedValue,
      isolationId,
      receiptId,
    },
  };
};
