import type { ContractFixture } from "./fixtures.ts";

// Transport DTO acceptance is deliberately weaker than publication/replay
// admission. Services must separately bind canonical bytes, hashes and grants.
export const buildWorkerFixtures = (
  existing: readonly ContractFixture[]
): ContractFixture[] => {
  const sample = (contract: string): Record<string, unknown> => {
    const value = existing.find(
      (entry) => entry.contract === contract && entry.valid
    );
    if (!value) throw new TypeError(`Missing source fixture seed ${contract}`);
    return structuredClone(value.payload) as Record<string, unknown>;
  };
  const hash = "a".repeat(64);
  const zero = "0".repeat(64);
  const t = "2026-09-22T12:00:00.000000001Z";
  const expires = "2026-09-22T12:01:00Z";
  const later = "2026-09-22T12:02:00Z";
  const scope = { accountAlias: "synthetic-paper", environment: "paper" };
  const fence = {
    ...scope,
    jobId: "job-1",
    leaseId: "lease-1",
    leaseEpoch: "1",
  };
  const artifact = { artifactId: "artifact-1", artifactSha256: hash };
  const publication = {
    ...fence,
    collectionId: null,
    artifact,
    idempotencyKey: "publish-1",
  };
  const lease = {
    schemaVersion: "1.0.0",
    ...fence,
    eventId: "job-event-1",
    kind: "paper-simulation",
    researchPrincipalId: "research-principal",
    payloadArtifactId: "payload-1",
    payloadSha256: hash,
    policySelectionId: "selection-1",
    policySelectionSha256: hash,
    deadlineAt: later,
    leaseExpiresAt: expires,
    attempt: 1,
  };
  const rights = {
    policyId: "rights-1",
    version: "rights-v1",
    status: "granted",
    allowedUses: ["read"],
    checkedAt: t,
    expiresAt: expires,
    retentionUntil: later,
  };
  const rightsPin = {
    sourceId: "source-1",
    policyId: "rights-1",
    version: "rights-v1",
  };
  const reviewPin = {
    collectionId: "collection-1",
    evidenceId: "evidence-1",
    artifactId: "artifact-1",
    artifactSha256: hash,
    reviewId: "review-1",
    reviewVersion: "review-v1",
    rightsPolicyId: "rights-1",
    rightsVersion: "rights-v1",
  };
  const good: Record<string, Record<string, unknown>> = {
    WorkerRightsPin: rightsPin,
    WorkerLease: lease,
    WorkerFence: fence,
    WorkerClaimInput: {
      ...scope,
      workerInstanceId: "worker-1",
      kinds: ["paper-simulation"],
      limit: 1,
      leaseDurationMs: 1000,
    },
    WorkerClaimOutput: { status: "accepted", leases: [lease] },
    WorkerRenewInput: { ...fence, leaseExpiresAt: expires },
    WorkerCompleteInput: {
      ...fence,
      outcome: "succeeded",
      outcomeSha256: hash,
      outputArtifactIds: ["artifact-1"],
    },
    WorkerCancelInput: { ...fence, reason: "requested" },
    WorkerStatusInput: { ...scope, jobId: "job-1" },
    WorkerResult: {
      status: "accepted",
      jobId: "job-1",
      state: "leased",
      lease,
      outputArtifactIds: ["artifact-1"],
      reason: null,
    },
    WorkerAdmitRunInput: { ...fence, runId: "run-1", requestSha256: hash },
    WorkerArtifactRef: artifact,
    WorkerReadArtifactInput: {
      ...fence,
      collectionId: null,
      artifactId: "artifact-1",
    },
    WorkerReadArtifactOutput: {
      artifact,
      contentBase64: "e30=",
      contentSha256: hash,
      canonicalSha256: null,
      contentType: "application/json",
    },
    WorkerStageArtifactInput: {
      ...fence,
      collectionId: null,
      artifactId: "artifact-1",
      contentBase64: "e30=",
      contentSha256: hash,
      canonicalSha256: null,
      contentType: "application/json",
      rightsPolicyId: "rights-1",
      rightsVersion: "rights-v1",
      lineageArtifactIds: ["artifact-0"],
    },
    WorkerStageArtifactOutput: {
      status: "accepted",
      artifact,
      contentSha256: hash,
      canonicalSha256: null,
    },
    WorkerPublishArtifactInput: {
      ...publication,
      contractName: "DatasetManifest",
      record: sample("DatasetManifest"),
    },
    WorkerPublishAgentInput: {
      ...publication,
      run: sample("AgentRun"),
      advisoryProfileArtifact: artifact,
      reviewPins: [reviewPin],
    },
    WorkerPublishCollectionInput: {
      ...fence,
      reconstructionArtifact: artifact,
      manifestSha256: hash,
      rightsPins: [rightsPin],
      collectionId: "collection-1",
      expectedActiveSnapshotId: null,
      imports: [{ record: sample("KnowledgeImport"), artifact }],
      evidence: [{ record: sample("ResearchEvidence"), artifact }],
      datasets: [{ record: sample("DatasetManifest"), artifact }],
      idempotencyKey: "publish-collection",
    },
    WorkerActivateCollectionInput: {
      ...fence,
      manifestSha256: hash,
      rightsPins: [rightsPin],
      collectionId: "collection-1",
      expectedActiveSnapshotId: "snapshot-1",
      targetSnapshotId: "snapshot-2",
      idempotencyKey: "activate-1",
    },
    WorkerReadCollectionInput: {
      ...fence,
      collectionId: "collection-1",
      snapshotId: null,
    },
    WorkerCollectionOutput: {
      status: "published",
      reconstructionArtifact: artifact,
      manifestSha256: hash,
      collectionId: "collection-1",
      snapshotId: "snapshot-1",
      previousSnapshotId: null,
      importArtifacts: [artifact],
    },
    WorkerCurrentRightsInput: {
      ...fence,
      collectionId: null,
      policyId: "rights-1",
      use: "read",
    },
    WorkerCurrentRightsOutput: rights,
    WorkerAcceptedEvidenceInput: {
      ...fence,
      collectionId: "collection-1",
      evidenceId: "evidence-1",
    },
    WorkerAcceptedEvidenceOutput: {
      artifact,
      contentBase64: "e30=",
      evidence: sample("ResearchEvidence"),
      review: sample("AcceptedReview"),
      rights,
    },
    WorkerCurrentPaperAdmissionInput: {
      ...fence,
      intentArtifactId: "intent-artifact",
      intentSha256: hash,
      admissionId: "admission-1",
    },
    WorkerCurrentPaperAdmissionOutput: {
      status: "allowed",
      checkedAt: t,
      expiresAt: expires,
      admission: sample("PaperSimulationAdmission"),
      review: sample("AcceptedReview"),
      intentArtifact: artifact,
      intent: sample("TradeIntent"),
    },
    WorkerPublishGenesisInput: {
      ...fence,
      snapshot: sample("PortfolioSnapshot"),
    },
    WorkerPublishPortfolioSnapshotInput: {
      ...fence,
      snapshot: sample("PortfolioSnapshot"),
    },
    WorkerPublishOrderProjectionInput: {
      ...fence,
      projection: sample("ExecutionProjection"),
    },
    WorkerPublishNativeFactsInput: {
      ...fence,
      projection: sample("NativeFactProjection"),
      proofBase64: "e30=",
    },
    WorkerProjectionAck: {
      status: "applied",
      highWaterSequence: "1",
      highWaterEventHash: hash,
    },
    WorkerReadContinuityInput: { ...fence, streamId: "stream-1" },
    WorkerReadinessInput: {
      ...fence,
      state: "ready",
      capabilityIds: ["capability-1"],
      observedAt: t,
    },
    WorkerPolicySelectionInput: {
      ...fence,
      selectionId: "selection-1",
      selectionSha256: hash,
    },
    WorkerServiceGrant: {
      grantId: "grant-1",
      servicePrincipalId: "service-1",
      ...scope,
      operations: ["claim", "currentPaperAdmission"],
      issuedAt: t,
      expiresAt: expires,
      revokedAt: null,
    },
  };
  good["WorkerCurrentRightsObservationInput"] = {
    ...good["WorkerCurrentRightsInput"],
  };
  good["WorkerAcceptedEvidenceObservationInput"] = {
    ...good["WorkerAcceptedEvidenceInput"],
  };
  good["WorkerCurrentRightsObservationOutput"] = {
    format: "vertex-worker-current-rights-observation-v1",
    observedAt: t,
    value: rights,
  };
  good["WorkerAcceptedEvidenceObservationOutput"] = {
    format: "vertex-worker-accepted-evidence-observation-v1",
    observedAt: t,
    value: good["WorkerAcceptedEvidenceOutput"],
  };
  // Private experiment, committed backtest/dataset reads and native evidence
  // phases: transport shapes only, never publication or dispatch authority.
  const dependencyPin = {
    artifactId: "dataset-artifact-1",
    artifactSha256: hash,
    reviewId: "review-1",
    reviewVersion: "review-v1",
    rightsPolicyId: "rights-1",
    rightsVersion: "rights-v1",
  };
  const readOutput = {
    artifact,
    contentBase64: "e30=",
    contentSha256: hash,
    canonicalSha256: hash,
    contentType: "application/json",
  };
  const backtestRefs = {
    plannedRun: { artifactId: "planned-run-1", artifactSha256: hash },
    results: { artifactId: "results-1", artifactSha256: hash },
    recipe: { artifactId: "recipe-1", artifactSha256: hash },
  };
  const nativeContent = { sha256: hash, byteLength: 2 };
  const phaseOne = {
    profile: "vertex-research-chat-native-phase-v1",
    accountAlias: "synthetic-research",
    environment: "research",
    responseRequestId: "response-request-1",
    planSha256: hash,
    phaseOrdinal: 1,
    tokenizeInput: nativeContent,
    completionInput: nativeContent,
    derivation: null,
    expiresAt: expires,
    phaseSha256: hash,
  };
  const phaseTwo = {
    ...phaseOne,
    phaseOrdinal: 2,
    derivation: {
      profile: "reviewed-evidence-single-projection-v1",
      phaseOneResponseSha256: hash,
      phaseOneRequestSha256: hash,
      phaseOneProofSha256: hash,
      callId: "call-1",
      toolName: "read_reviewed_evidence",
      argumentsCanonical: JSON.stringify({ evidence_id: "evidence-1" }),
      evidenceId: "evidence-1",
      bundleSha256: hash,
      toolResultSha256: hash,
    },
  };
  const copy = (copyId: string) => ({
    copyId,
    reservationSha256: hash,
    sha256: hash,
    byteLength: 2,
  });
  Object.assign(good, {
    WorkerExperimentDependencyPin: dependencyPin,
    WorkerPublishExperimentInput: {
      ...fence,
      collectionId: "collection-1",
      experimentId: "experiment-1",
      contentBase64: "e30=",
      contentSha256: hash,
      rightsPolicyId: "rights-1",
      rightsVersion: "rights-v1",
      dependencyPins: [dependencyPin],
    },
    WorkerPublishExperimentOutput: {
      status: "accepted",
      jobId: "job-1",
      collectionId: "collection-1",
      experimentId: "experiment-1",
      artifact,
    },
    WorkerReadExperimentInput: {
      ...fence,
      collectionId: "collection-1",
      experimentId: "experiment-1",
      artifact,
    },
    WorkerReadExperimentOutput: {
      ...readOutput,
      jobId: "job-0",
      collectionId: "collection-1",
      experimentId: "experiment-1",
    },
    WorkerReadBacktestRunInput: {
      ...fence,
      collectionId: "collection-1",
      artifact,
      ...backtestRefs,
    },
    WorkerReadBacktestRunOutput: {
      ...readOutput,
      jobId: "job-0",
      collectionId: "collection-1",
      ...backtestRefs,
      receipt: { artifactId: "receipt-1", artifactSha256: hash },
      isolation: { artifactId: "isolation-1", artifactSha256: hash },
    },
    WorkerReadDatasetInput: {
      ...fence,
      collectionId: "collection-1",
      manifest: artifact,
      member: "content",
      source: null,
      reviewPins: [reviewPin],
    },
    WorkerReadDatasetOutput: {
      ...readOutput,
      canonicalSha256: null,
      producerJobId: "job-0",
      collectionId: "collection-1",
      manifest: artifact,
      member: "content",
      source: null,
    },
    WorkerNativeEvidencePhase: phaseOne,
    WorkerPrepareNativeEvidencePhaseTwoOutput: {
      phase: phaseTwo,
      copies: {
        phaseTwoTokenizeInput: copy("copy-tokenize"),
        phaseTwoCompletionInput: copy("copy-completion"),
        toolResult: copy("copy-tool-result"),
      },
      executionAuthorized: false,
    },
  });
  const cases: ContractFixture[] = [];
  const add = (
    contract: string,
    name: string,
    payload: unknown,
    valid = false
  ): void => {
    cases.push({
      name: `${contract}/${name}`,
      contract,
      payload: structuredClone(payload),
      valid,
    });
  };
  const change = (
    contract: string,
    path: string,
    value: unknown,
    name = path,
    valid = false
  ): void => {
    const payload = structuredClone(good[contract])!;
    const parts = path.split(".");
    let current = payload;
    for (const field of parts.slice(0, -1))
      current = current[field] as Record<string, unknown>;
    current[parts.at(-1)!] = value;
    add(contract, name, payload, valid);
  };
  for (const [contract, payload] of Object.entries(good)) {
    add(contract, "valid", payload, true);
    add(contract, "wrong-root", null);
    add(contract, "unknown-field", { ...payload, unsupported: true });
    const missing = { ...payload };
    delete missing[Object.keys(missing)[0]!];
    add(contract, "missing-field", missing);
    if (Object.hasOwn(payload, "leaseEpoch"))
      change(contract, "leaseEpoch", "0", "nonpositive-fence");
  }
  for (const contract of [
    "DatasetManifest",
    "ResearchEvidence",
    "StrategySpec",
    "BacktestRun",
  ]) {
    add(
      "WorkerPublishArtifactInput",
      `variant-${contract}`,
      { ...publication, contractName: contract, record: sample(contract) },
      true
    );
  }
  change(
    "WorkerLease",
    "kind",
    "native-bootstrap",
    "native-bootstrap-kind",
    true
  );
  change(
    "WorkerClaimInput",
    "kinds",
    [
      "research-run",
      "dataset-ingest",
      "knowledge-import",
      "backtest",
      "paper-simulation",
      "native-bootstrap",
    ],
    "all-six-kinds",
    true
  );
  change(
    "WorkerServiceGrant",
    "operations",
    [
      "currentModelUse",
      "publishEpochTransition",
      "replayNativeOutbox",
      "native-bootstrap",
    ],
    "new-operation-and-bootstrap-permission",
    true
  );
  change("WorkerLease", "leaseExpiresAt", later, "equal-deadline", true);
  change(
    "WorkerLease",
    "leaseExpiresAt",
    "2026-09-22T12:02:00.000000001Z",
    "nanosecond-over-deadline"
  );
  change(
    "WorkerLease",
    "deadlineAt",
    "2026-02-30T00:00:00Z",
    "invalid-calendar"
  );
  change(
    "WorkerClaimOutput",
    "leases.0.leaseExpiresAt",
    "2026-09-22T12:02:00.000000001Z"
  );
  change("WorkerResult", "lease.deadlineAt", t);
  change("WorkerResult", "lease", null, "nullable-lease", true);
  change("WorkerCompleteInput", "outputArtifactIds", [
    "artifact-1",
    "artifact-1",
  ]);
  change("WorkerStageArtifactInput", "lineageArtifactIds", [
    "artifact-1",
    "artifact-1",
  ]);
  change("WorkerReadinessInput", "capabilityIds", [
    "capability-1",
    "capability-1",
  ]);
  change("WorkerRenewInput", "leaseExpiresAt", "2026-02-30T00:00:00Z");
  change("WorkerCurrentRightsOutput", "retentionUntil", "2026-02-30T00:00:00Z");
  change("WorkerCurrentRightsOutput", "checkedAt", "2026-02-30T00:00:00Z");
  for (const contract of [
    "WorkerCurrentRightsObservationOutput",
    "WorkerAcceptedEvidenceObservationOutput",
  ]) {
    change(
      contract,
      "observedAt",
      "2026-02-30T00:00:00Z",
      "invalid-observation-calendar"
    );
    change(
      contract,
      "format",
      "vertex-worker-observation-v0",
      "wrong-observation-format"
    );
    change(
      contract,
      "value",
      {
        ...(good[contract]?.["value"] as Record<string, unknown>),
        observedAt: t,
      },
      "strict-legacy-nested-value"
    );
  }
  for (const contract of [
    "WorkerCurrentRightsOutput",
    "WorkerAcceptedEvidenceOutput",
  ]) {
    add(contract, "reject-observation-field", {
      ...good[contract],
      observedAt: t,
    });
  }
  change(
    "WorkerServiceGrant",
    "operations",
    ["currentRightsObservation", "acceptedEvidenceObservation"],
    "explicit-observation-operations",
    true
  );
  change("WorkerServiceGrant", "expiresAt", t);
  change("WorkerServiceGrant", "revokedAt", "2026-02-30T00:00:00Z");
  change("WorkerPublishArtifactInput", "record.instrumentUniverse", [
    "synthetic-equity",
    "synthetic-equity",
  ]);
  change("WorkerPublishAgentInput", "run.outputArtifactIds", []);
  change(
    "WorkerPublishCollectionInput",
    "imports.0.record.duplicateMappings.0.canonicalSourceId",
    "missing-source"
  );
  change("WorkerPublishCollectionInput", "rightsPins", []);
  change("WorkerActivateCollectionInput", "rightsPins", []);
  change(
    "WorkerPublishCollectionInput",
    "reconstructionArtifact.artifactSha256",
    "not-a-digest"
  );
  change("WorkerCollectionOutput", "manifestSha256", "not-a-digest");
  change("WorkerActivateCollectionInput", "rightsPins.0.version", "");
  change(
    "WorkerPublishCollectionInput",
    "rightsPins",
    [rightsPin, rightsPin],
    "source-does-not-deduplicate-rights-pins",
    true
  );
  change(
    "WorkerPublishCollectionInput",
    "manifestSha256",
    zero,
    "transport-does-not-prove-manifest",
    true
  );
  change("WorkerAcceptedEvidenceOutput", "review.expiresAt", t);
  change("WorkerCurrentPaperAdmissionOutput", "admission.maximumLoss", "0");
  change("WorkerCurrentPaperAdmissionOutput", "review.expiresAt", t);
  change("WorkerCurrentPaperAdmissionOutput", "intent.quantity", "0");
  change(
    "WorkerCurrentPaperAdmissionOutput",
    "checkedAt",
    "2026-02-30T00:00:00Z"
  );
  change(
    "WorkerPublishGenesisInput",
    "snapshot.lots.0.openedAt",
    "2026-02-30T00:00:00Z"
  );
  change(
    "WorkerPublishPortfolioSnapshotInput",
    "snapshot.lots.0.openedAt",
    "2026-02-30T00:00:00Z"
  );
  change(
    "WorkerPublishPortfolioSnapshotInput",
    "snapshot.cash",
    "11",
    "ordinary-snapshot-has-no-genesis-identity",
    true
  );
  const ordinarySecondSnapshot = sample("PortfolioSnapshot");
  ordinarySecondSnapshot["sequence"] = "2";
  const ordinaryContinuity = ordinarySecondSnapshot["continuity"] as Record<
    string,
    unknown
  >;
  ordinaryContinuity["highWaterSequence"] = "2";
  ordinaryContinuity["expectedNextSequence"] = "3";
  add(
    "WorkerPublishPortfolioSnapshotInput",
    "ordinary-sequence-two",
    { ...fence, snapshot: ordinarySecondSnapshot },
    true
  );
  change(
    "WorkerPublishOrderProjectionInput",
    "projection.receipt.totalQuantity",
    "0"
  );
  change(
    "WorkerPublishNativeFactsInput",
    "projection.proofJournalSequence",
    "0"
  );
  change(
    "WorkerPublishOrderProjectionInput",
    "projection.eventHash",
    zero,
    "transport-does-not-prove-order-hash",
    true
  );
  change(
    "WorkerPublishNativeFactsInput",
    "projection.eventHash",
    zero,
    "transport-does-not-prove-fact-hash",
    true
  );
  change(
    "WorkerPublishGenesisInput",
    "snapshot.cash",
    "11",
    "transport-does-not-prove-genesis-hash",
    true
  );
  change(
    "WorkerReadArtifactOutput",
    "contentSha256",
    zero,
    "transport-does-not-decode-or-bind-bytes",
    true
  );
  change(
    "WorkerReadArtifactOutput",
    "contentBase64",
    "A===",
    "malformed-base64"
  );
  change(
    "WorkerPublishNativeFactsInput",
    "proofBase64",
    "not base64",
    "malformed-proof-base64"
  );
  // Source permits noncanonical padding bits; byte decoder/service validation is
  // separately responsible for canonical base64, size and digest correspondence.
  change(
    "WorkerReadArtifactOutput",
    "contentBase64",
    "Zh==",
    "source-regex-not-base64-decoder",
    true
  );
  change("WorkerPublishExperimentInput", "dependencyPins", []);
  change(
    "WorkerPublishExperimentInput",
    "sourceReviewPins",
    [reviewPin],
    "with-source-review-pins",
    true
  );
  change("WorkerPublishExperimentInput", "sourceReviewPins", []);
  change("WorkerPublishExperimentOutput", "status", "rejected");
  change("WorkerReadExperimentOutput", "contentType", "text/plain");
  change("WorkerReadExperimentOutput", "canonicalSha256", null);
  change(
    "WorkerReadBacktestRunInput",
    "experiment",
    { experimentId: "experiment-1", artifact },
    "with-experiment-causal-proof",
    true
  );
  change("WorkerReadBacktestRunOutput", "canonicalSha256", null);
  change("WorkerReadDatasetInput", "member", "capture", "capture-needs-source");
  change("WorkerReadDatasetInput", "reviewPins", []);
  change(
    "WorkerReadDatasetOutput",
    "member",
    "capture",
    "capture-needs-source"
  );
  change("WorkerReadDatasetOutput", "canonicalSha256", hash);
  add("WorkerNativeEvidencePhase", "phase-two-with-derivation", phaseTwo, true);
  change(
    "WorkerNativeEvidencePhase",
    "phaseOrdinal",
    2,
    "phase-two-without-derivation"
  );
  add("WorkerNativeEvidencePhase", "phase-one-with-derivation", {
    ...phaseTwo,
    phaseOrdinal: 1,
  });
  add("WorkerNativeEvidencePhase", "noncanonical-tool-arguments", {
    ...phaseTwo,
    derivation: {
      ...phaseTwo.derivation,
      argumentsCanonical: '{"evidence_id": "evidence-1"}',
    },
  });
  change("WorkerNativeEvidencePhase", "expiresAt", "2026-02-30T00:00:00Z");
  change(
    "WorkerPrepareNativeEvidencePhaseTwoOutput",
    "phase",
    phaseOne,
    "phase-one-is-not-phase-two"
  );
  change(
    "WorkerPrepareNativeEvidencePhaseTwoOutput",
    "executionAuthorized",
    true,
    "never-authorizes-execution"
  );
  return cases;
};

export const buildWorkerByteCapacityFixtures = (
  existing: readonly ContractFixture[]
): ContractFixture[] => {
  const original = buildWorkerFixtures(existing).find(
    (entry) => entry.contract === "WorkerReadArtifactOutput" && entry.valid
  )!;
  const payload = structuredClone(original.payload) as Record<string, unknown>;
  payload["contentBase64"] = `${"A".repeat(1_398_100)}AA==`;
  return [
    {
      name: "WorkerReadArtifactOutput/source-base64-character-cap",
      contract: "WorkerReadArtifactOutput",
      payload,
      valid: true,
    },
  ];
};
