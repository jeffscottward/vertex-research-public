import { canonicalArtifactJson } from "../../packages/shared/src/vertex/index.ts";
import type {
  ExecutionProjection,
  PortfolioSnapshot,
} from "../../packages/api/src/contracts/vertex-control.ts";
import type {
  NativeFactProjection,
  NativeJournalProof,
} from "../../packages/api/src/contracts/vertex-native-facts.ts";
import { canonicalJsonSha256, rawBytesSha256 } from "./generate.ts";
import type { ContractFixture } from "./fixtures.ts";

type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;

// Synthetic source-only cases. These factories do not run on import. A valid
// shape/hash never authenticates an approver or grants model dispatch authority.
export const buildModelEpochFixtures = async (
  existing: readonly ContractFixture[]
): Promise<ContractFixture[]> => {
  const sample = (name: string): unknown => {
    const entry = existing.find((item) => item.contract === name && item.valid);
    if (!entry) throw new TypeError(`Missing source fixture ${name}`);
    return structuredClone(entry.payload);
  };
  const hash = "a".repeat(64);
  const zero = "0".repeat(64);
  const t = "2026-09-22T12:00:00.000000001Z";
  const expires = "2026-09-22T12:01:00Z";
  const scope = { accountAlias: "synthetic-paper", environment: "paper" };
  const fence = {
    ...scope,
    jobId: "job-1",
    leaseId: "lease-1",
    leaseEpoch: "1",
  };
  const identity = {
    ...scope,
    researchPrincipalId: "research-principal",
    consumerServiceId: "research-service",
    selectionId: "selection-1",
    selectionSha256: hash,
    providerId: "provider-1",
    modelVersion: "model-1",
    tokenizerArtifactId: "tokenizer-1",
    tokenizerSha256: hash,
    endpointReferenceId: "endpoint-1",
    endpointSha256: hash,
    modelUsePolicyVersion: "1.0.0",
  };
  const evidence = {
    artifactId: "evidence-1",
    artifactSha256: hash,
    reviewId: "review-1",
    reviewVersion: "1.0.0",
    rightsPolicyId: "rights-1",
    rightsVersion: "1.0.0",
  };
  const grant = {
    schemaVersion: "1.0.0",
    grantId: "grant-1",
    grantVersion: "1.0.0",
    revision: "1",
    ...identity,
    operations: ["model-tokenize", "model-completion"],
    purposes: ["research"],
    allowedTools: ["read-evidence"],
    evidence: [evidence],
    maximumInputBytes: 1000,
    maximumInputTokens: 100,
    maximumOutputTokens: 10,
    maximumCostUsd: "1",
    privacyPolicyId: "privacy-1",
    privacyPolicyVersion: "1.0.0",
    validFrom: t,
    expiresAt: expires,
    status: "granted",
    issuedByActorId: "policy-admin",
    issuedAt: t,
    modelProcessingOnly: true,
    executionAuthorized: false,
  };
  const request = {
    schemaVersion: "1.0.0",
    requestId: "request-1",
    requestSha256: zero,
    ...identity,
    jobId: fence.jobId,
    leaseId: fence.leaseId,
    leaseEpoch: fence.leaseEpoch,
    grantId: "grant-1",
    grantVersion: "1.0.0",
    operation: "model-completion",
    purpose: "research",
    tools: ["read-evidence"],
    evidence: [evidence],
    inputSha256: hash,
    inputBytes: 100,
    inputTokens: 10,
    maximumOutputTokens: 10,
    maximumCostUsd: "1",
    deadlineAt: expires,
  };
  const sealRequest = async (value: Record<string, unknown>): Promise<void> => {
    const body = { ...value };
    delete body["requestSha256"];
    value["requestSha256"] = await canonicalJsonSha256(body);
  };
  await sealRequest(request);
  const proof = {
    schemaVersion: "1.0.0",
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    ...identity,
    jobId: fence.jobId,
    leaseId: fence.leaseId,
    leaseEpoch: fence.leaseEpoch,
    grantId: grant.grantId,
    grantVersion: grant.grantVersion,
    grantRevision: "1",
    operation: request.operation,
    decision: "allowed",
    reasonCodes: ["current-independent-grant"],
    checkedAt: t,
    validUntil: expires,
    currentEvidenceSha256: hash,
    privacyPolicyId: grant.privacyPolicyId,
    privacyPolicyVersion: grant.privacyPolicyVersion,
    externalDispatchAllowed: true,
    modelProcessingOnly: true,
    executionAuthorized: false,
  };
  const originalGenesis = sample(
    "PortfolioGenesis"
  ) as Mutable<PortfolioSnapshot>;
  const newerGenesis = structuredClone(originalGenesis);
  newerGenesis.ownerEpoch = "2";
  newerGenesis.continuity.ownerEpoch = "2";
  const genesisBody = structuredClone(newerGenesis) as unknown as Record<
    string,
    unknown
  >;
  delete genesisBody["sourceEventHash"];
  delete (genesisBody["continuity"] as Record<string, unknown>)[
    "highWaterEventHash"
  ];
  const genesisHash = await canonicalJsonSha256(genesisBody);
  newerGenesis.sourceEventHash = genesisHash;
  newerGenesis.continuity.highWaterEventHash = genesisHash;
  const transition = {
    schemaVersion: "1.0.0",
    transitionId: "transition-1",
    snapshot: newerGenesis,
    priorOwnerEpoch: "1",
    priorProjectionSequence: "9",
    priorProjectionHash: hash,
    journalIdentity: "journal-1",
    journalSequence: "12",
    journalHeadSha256: hash,
    nativeOutboxEvidenceSha256: hash,
    nativeOwnerFenceSha256: hash,
    approvalBase64: "AA==",
  };
  const bytes = (value: unknown): Uint8Array =>
    new TextEncoder().encode(canonicalArtifactJson(value));
  const b64 = (value: unknown): string =>
    Buffer.from(bytes(value)).toString("base64");
  const order = sample("ExecutionProjection") as Mutable<ExecutionProjection>;
  order.sequence = "2";
  order.previousEventHash = originalGenesis.sourceEventHash;
  order.actorId = "native-owner";
  const orderBody = { ...order } as Partial<Mutable<ExecutionProjection>>;
  delete orderBody.eventHash;
  order.eventHash = await canonicalJsonSha256(orderBody);
  const fact = sample("NativeFactProjection") as Mutable<NativeFactProjection>;
  const journalProof = sample("NativeJournalProof") as NativeJournalProof;
  fact.sequence = "3";
  fact.previousEventHash = order.eventHash;
  const factBody = { ...fact } as Partial<Mutable<NativeFactProjection>>;
  delete factBody.eventHash;
  fact.eventHash = await canonicalJsonSha256(factBody);
  const retainedSnapshot = structuredClone(originalGenesis);
  retainedSnapshot.snapshotId = "retained-snapshot-1";
  const values = [originalGenesis, retainedSnapshot, order, fact];
  const kinds = [
    "portfolio-genesis",
    "portfolio-snapshot",
    "order",
    "native-fact",
  ];
  const replayIdentities = [] as {
    projectionId: string;
    sequence: string;
    eventHash: string;
    projectionRawSha256: string;
    kind: string;
    proofSha256: string | null;
  }[];
  for (const [index, value] of values.entries()) {
    replayIdentities.push({
      projectionId:
        "projectionId" in value ? value.projectionId : value.snapshotId,
      sequence: value.sequence,
      eventHash: "eventHash" in value ? value.eventHash : value.sourceEventHash,
      projectionRawSha256: await rawBytesSha256(bytes(value)),
      kind: kinds[index]!,
      proofSha256:
        index === 3 ? await rawBytesSha256(bytes(journalProof)) : null,
    });
  }
  const replayGrant = {
    schemaVersion: "1.0.0",
    grantId: "replay-1",
    ...scope,
    streamId: "stream-1",
    priorOwnerEpoch: "1",
    currentOwnerEpoch: "2",
    serviceActorId: "native-owner",
    startingSequence: "0",
    startingEventHash: null as string | null,
    journalIdentity: "journal-1",
    journalSequence: "12",
    journalHeadSha256: hash,
    nativeJournalEvidenceSha256: hash,
    nativeOwnerFenceSha256: hash,
    retainedEpochTransitionSha256: null as string | null,
    issuedAt: t,
    expiresAt: expires,
    rows: replayIdentities,
    approvalBase64: "AA==",
  };
  const replay = {
    grant: replayGrant,
    retainedEpochTransitionBase64: null as string | null,
    rows: values.map((value, index) => ({
      kind: kinds[index]!,
      projectionBase64: b64(value),
      proofBase64: index === 3 ? b64(journalProof) : null,
    })),
  };
  const bootstrapPayload = {
    format: "vertex-native-bootstrap-job-v1",
    journalIdentity: "journal-1",
    simulatorId: "simulator-1",
    streamId: "stream-1",
    selectionId: "selection-1",
    selectionSha256: hash,
    mode: "restore",
  };
  // Research-chat native phase two consumes an already-returned completion and
  // its non-dispatching proof for the same research fence; never new authority.
  const researchFence = {
    accountAlias: "synthetic-research",
    environment: "research",
    jobId: fence.jobId,
    leaseId: fence.leaseId,
    leaseEpoch: fence.leaseEpoch,
  };
  const researchRequest: Record<string, unknown> = {
    ...request,
    accountAlias: researchFence.accountAlias,
    environment: researchFence.environment,
  };
  await sealRequest(researchRequest);
  const researchProof = {
    ...proof,
    accountAlias: researchFence.accountAlias,
    environment: researchFence.environment,
    requestSha256: researchRequest["requestSha256"],
    externalDispatchAllowed: false,
  };
  const privacyStatus = {
    candidateId: "candidate-1",
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    status: "pending",
    expiresAt: expires,
  };
  const good: Record<string, Record<string, unknown>> = {
    ModelUseGrant: grant,
    ModelUseRequest: request,
    ModelUseProof: proof,
    PortfolioEpochTransition: transition,
    NativeOutboxReplayGrant: replayGrant,
    NativeOutboxReplay: replay,
    WorkerBootstrapPayload: bootstrapPayload,
    WorkerBootstrapCommand: {
      schemaVersion: "1.0.0",
      ...scope,
      researchPrincipalId: "research-principal",
      payloadArtifactId: "bootstrap-1",
      payloadSha256: hash,
      policySelectionId: "selection-1",
      policySelectionSha256: hash,
      rightsPolicyId: "rights-1",
      rightsVersion: "1.0.0",
      issuedAt: t,
      deadlineAt: expires,
      idempotencyKey: "bootstrap-key",
      payload: bootstrapPayload,
    },
    WorkerCurrentModelUseInput: request,
    WorkerCurrentModelUseOutput: proof,
    WorkerPublishEpochTransitionInput: { ...fence, transition },
    WorkerReplayNativeOutboxInput: { ...fence, replay },
    WorkerPrepareModelPrivacyReviewInput: request,
    WorkerReadModelPrivacyReviewInput: request,
    WorkerModelPrivacyReviewOutput: privacyStatus,
    WorkerPrepareNativeEvidencePhaseTwoInput: {
      ...researchFence,
      request: researchRequest,
      responseBase64: "e30=",
      proof: researchProof,
    },
  };
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
  const change = async (
    contract: string,
    path: string,
    value: unknown,
    name = path,
    valid = false
  ): Promise<void> => {
    const payload = structuredClone(good[contract])!;
    const parts = path.split(".");
    let current = payload;
    for (const field of parts.slice(0, -1))
      current = current[field] as Record<string, unknown>;
    current[parts.at(-1)!] = value;
    if (contract === "ModelUseRequest" && path !== "requestSha256")
      await sealRequest(payload);
    add(contract, name, payload, valid);
  };
  for (const [contract, payload] of Object.entries(good)) {
    add(contract, "valid", payload, true);
    add(contract, "wrong-root", null);
    add(contract, "unknown-field", { ...payload, unsupported: true });
    const missing = { ...payload };
    delete missing[Object.keys(missing)[0]!];
    add(contract, "missing-field", missing);
  }
  for (const field of ["operations", "purposes", "allowedTools", "evidence"]) {
    const first = (grant as unknown as Record<string, unknown[]>)[field]?.[0];
    await change("ModelUseGrant", field, [first, first]);
  }
  await change("ModelUseGrant", "revision", "0");
  await change("ModelUseGrant", "validFrom", expires);
  await change("ModelUseGrant", "issuedAt", "2026-09-22T12:02:00Z");
  await change("ModelUseGrant", "validFrom", "2026-02-30T00:00:00Z");
  await change("ModelUseGrant", "maximumCostUsd", "-1");
  await change("ModelUseGrant", "maximumInputTokens", 9_007_199_254_740_992);
  add(
    "ModelUseGrant",
    "revoked-late-issuance-is-source-valid",
    { ...grant, status: "revoked", issuedAt: "2026-09-22T12:02:00Z" },
    true
  );
  await change("ModelUseRequest", "requestSha256", zero);
  await change("ModelUseRequest", "inputTokens", null);
  await change("ModelUseRequest", "operation", "model-tokenize");
  await change("ModelUseRequest", "tools", ["read", "read"]);
  await change("ModelUseRequest", "evidence", [evidence, evidence]);
  await change("ModelUseRequest", "deadlineAt", "2026-02-30T00:00:00Z");
  const tokenize: Record<string, unknown> = {
    ...request,
    operation: "model-tokenize",
    inputTokens: null,
    maximumOutputTokens: 0,
  };
  await sealRequest(tokenize);
  add("ModelUseRequest", "tokenize-null-input-zero-output", tokenize, true);
  await change(
    "WorkerCurrentModelUseInput",
    "requestSha256",
    zero,
    "transport-hash-is-not-replay-admission",
    true
  );
  for (const field of [
    "grantRevision",
    "privacyPolicyId",
    "privacyPolicyVersion",
  ])
    await change("ModelUseProof", field, null);
  await change("ModelUseProof", "validUntil", t);
  await change("ModelUseProof", "checkedAt", "2026-02-30T00:00:00Z");
  await change("ModelUseProof", "reasonCodes", ["same", "same"]);
  await change("ModelUseProof", "decision", "denied");
  add(
    "ModelUseProof",
    "denied-equal-time-null-pins",
    {
      ...proof,
      decision: "denied",
      externalDispatchAllowed: false,
      validUntil: t,
      grantRevision: null,
      privacyPolicyId: null,
      privacyPolicyVersion: null,
    },
    true
  );
  await change(
    "ModelUseProof",
    "externalDispatchAllowed",
    false,
    "allowed-proof-does-not-rearm-dispatch",
    true
  );
  await change("WorkerBootstrapCommand", "payload.selectionId", "mismatch");
  await change("WorkerBootstrapCommand", "payload.selectionSha256", zero);
  await change("WorkerBootstrapCommand", "deadlineAt", t);
  await change(
    "WorkerBootstrapPayload",
    "mode",
    "initialize",
    "initialize-shape-not-capital-authority",
    true
  );
  await change("PortfolioEpochTransition", "priorOwnerEpoch", "2");
  await change("PortfolioEpochTransition", "priorProjectionSequence", "0");
  await change("PortfolioEpochTransition", "journalSequence", "0");
  await change(
    "PortfolioEpochTransition",
    "snapshot.cash",
    "11",
    "snapshot-genesis-hash-required"
  );
  await change(
    "WorkerPublishEpochTransitionInput",
    "transition.snapshot.cash",
    "11",
    "transport-does-not-check-genesis-hash",
    true
  );
  for (const base64 of ["", "AB==", "AAB=", "AA", "AA==\n", "_w==", "===="]) {
    await change(
      "PortfolioEpochTransition",
      "approvalBase64",
      base64,
      `canonical-approval-${Buffer.from(base64).toString("hex")}`
    );
  }
  await change(
    "PortfolioEpochTransition",
    "approvalBase64",
    "AA==",
    "opaque-approval-not-authenticated-here",
    true
  );
  await change("WorkerPrepareModelPrivacyReviewInput", "tools", [
    "read",
    "read",
  ]);
  await change(
    "WorkerReadModelPrivacyReviewInput",
    "deadlineAt",
    t.slice(0, 5)
  );
  add(
    "WorkerModelPrivacyReviewOutput",
    "not-observed-has-no-expiry",
    { ...privacyStatus, status: "not-observed", expiresAt: null },
    true
  );
  await change("WorkerModelPrivacyReviewOutput", "expiresAt", null);
  await change("WorkerModelPrivacyReviewOutput", "status", "not-observed");
  await change(
    "WorkerPrepareNativeEvidencePhaseTwoInput",
    "environment",
    "paper",
    "research-environment-only"
  );
  await change(
    "WorkerPrepareNativeEvidencePhaseTwoInput",
    "proof.externalDispatchAllowed",
    true,
    "proof-must-not-dispatch"
  );
  await change(
    "WorkerPrepareNativeEvidencePhaseTwoInput",
    "proof.requestSha256",
    zero,
    "proof-binds-request"
  );
  await change(
    "WorkerPrepareNativeEvidencePhaseTwoInput",
    "jobId",
    "job-2",
    "request-binds-fence"
  );
  await change("NativeOutboxReplayGrant", "currentOwnerEpoch", "1");
  await change("NativeOutboxReplayGrant", "startingEventHash", hash);
  await change("NativeOutboxReplayGrant", "expiresAt", t);
  await change("NativeOutboxReplayGrant", "rows.0.kind", "order");
  await change("NativeOutboxReplayGrant", "rows.1.sequence", "2");
  await change("NativeOutboxReplayGrant", "rows.1.eventHash", zero);
  await change("NativeOutboxReplayGrant", "rows.2.sequence", "3");
  await change("NativeOutboxReplayGrant", "rows.2.kind", "portfolio-genesis");
  await change("NativeOutboxReplayGrant", "rows.3.proofSha256", null);
  await change("NativeOutboxReplayGrant", "rows.2.proofSha256", hash);
  const duplicatedSnapshot = structuredClone(replayGrant);
  duplicatedSnapshot.rows.splice(
    2,
    0,
    structuredClone(duplicatedSnapshot.rows[1]!)
  );
  add("NativeOutboxReplayGrant", "duplicate-kind-and-id", duplicatedSnapshot);
  const resumed = {
    ...replayGrant,
    startingSequence: "1",
    startingEventHash: originalGenesis.sourceEventHash,
    rows: replayGrant.rows.slice(1),
  };
  add(
    "NativeOutboxReplayGrant",
    "resume-with-snapshot-does-not-advance",
    resumed,
    true
  );
  const initialSnapshot = { ...replayGrant, rows: [replayGrant.rows[1]!] };
  add(
    "NativeOutboxReplayGrant",
    "snapshot-cannot-start-empty-chain",
    initialSnapshot
  );
  await change("NativeOutboxReplay", "rows", replay.rows.slice(1));
  await change("NativeOutboxReplay", "rows.0.kind", "order");
  await change("NativeOutboxReplay", "rows.3.proofBase64", null);
  await change("NativeOutboxReplay", "rows.0.proofBase64", "AA==");
  await change(
    "NativeOutboxReplay",
    "grant.accountAlias",
    "other-account",
    "decoded-account-binding"
  );
  await change(
    "NativeOutboxReplay",
    "grant.streamId",
    "other-stream",
    "decoded-stream-binding"
  );
  await change(
    "NativeOutboxReplay",
    "grant.serviceActorId",
    "other-owner",
    "decoded-emitter-binding"
  );
  await change(
    "NativeOutboxReplay",
    "grant.rows.1.projectionId",
    "other-snapshot",
    "decoded-snapshot-id-binding"
  );
  await change(
    "NativeOutboxReplay",
    "grant.rows.2.eventHash",
    zero,
    "decoded-event-hash-binding"
  );
  await change("NativeOutboxReplay", "grant.rows.0.projectionRawSha256", zero);
  await change("NativeOutboxReplay", "grant.rows.3.proofSha256", zero);
  await change(
    "NativeOutboxReplay",
    "rows.0.projectionBase64",
    "AA==",
    "transport-bytes-are-not-a-projection"
  );
  await change(
    "WorkerReplayNativeOutboxInput",
    "replay.rows.0.projectionBase64",
    "AA==",
    "transport-only-opaque-projection",
    true
  );
  const replaceProjection = async (
    name: string,
    index: number,
    value: unknown
  ): Promise<void> => {
    const changed = structuredClone(replay);
    changed.rows[index]!.projectionBase64 = b64(value);
    changed.grant.rows[index]!.projectionRawSha256 = await rawBytesSha256(
      bytes(value)
    );
    add("NativeOutboxReplay", name, changed);
  };
  await replaceProjection("raw-rehashed-wrong-scope", 0, {
    ...originalGenesis,
    accountAlias: "other-account",
  });
  await replaceProjection("raw-rehashed-wrong-actor", 2, {
    ...order,
    actorId: "other-owner",
  });
  await replaceProjection("raw-rehashed-wrong-chain", 2, {
    ...order,
    previousEventHash: zero,
  });
  await replaceProjection("raw-rehashed-snapshot-id", 1, {
    ...retainedSnapshot,
    snapshotId: "other-snapshot",
  });
  for (const [name, raw] of [
    ["whitespace", ` ${canonicalArtifactJson(originalGenesis)}`],
    ["bom", `\ufeff${canonicalArtifactJson(originalGenesis)}`],
    [
      "duplicate-key",
      canonicalArtifactJson(originalGenesis).replace(
        "{",
        '{"schemaVersion":"1.0.0",'
      ),
    ],
  ]) {
    const changed = structuredClone(replay);
    const rawBytes = new TextEncoder().encode(raw!);
    changed.rows[0]!.projectionBase64 =
      Buffer.from(rawBytes).toString("base64");
    changed.grant.rows[0]!.projectionRawSha256 = await rawBytesSha256(rawBytes);
    add("NativeOutboxReplay", `canonical-projection-${name}`, changed);
  }
  const malformedUtf8 = structuredClone(replay);
  const malformed = Uint8Array.from([0xc3, 0x28]);
  malformedUtf8.rows[0]!.projectionBase64 =
    Buffer.from(malformed).toString("base64");
  malformedUtf8.grant.rows[0]!.projectionRawSha256 =
    await rawBytesSha256(malformed);
  add("NativeOutboxReplay", "malformed-utf8-projection", malformedUtf8);
  const wrongProof = structuredClone(replay);
  const differentProof = { ...journalProof, factOrdinal: 1 };
  wrongProof.rows[3]!.proofBase64 = b64(differentProof);
  wrongProof.grant.rows[3]!.proofSha256 = await rawBytesSha256(
    bytes(differentProof)
  );
  const reboundFact = {
    ...fact,
    proof: { ...fact.proof, sha256: wrongProof.grant.rows[3]!.proofSha256! },
  };
  const reboundBody = { ...reboundFact } as Partial<
    Mutable<NativeFactProjection>
  >;
  delete reboundBody.eventHash;
  reboundFact.eventHash = await canonicalJsonSha256(reboundBody);
  wrongProof.rows[3]!.projectionBase64 = b64(reboundFact);
  wrongProof.grant.rows[3]!.projectionRawSha256 = await rawBytesSha256(
    bytes(reboundFact)
  );
  wrongProof.grant.rows[3]!.eventHash = reboundFact.eventHash;
  add(
    "NativeOutboxReplay",
    "all-hashes-rebound-proof-ordinal-mismatch",
    wrongProof
  );
  const retained = {
    grant: {
      ...replayGrant,
      priorOwnerEpoch: "2",
      currentOwnerEpoch: "3",
      retainedEpochTransitionSha256: await rawBytesSha256(bytes(transition)),
      rows: [
        {
          ...replayIdentities[0]!,
          eventHash: newerGenesis.sourceEventHash,
          projectionRawSha256: await rawBytesSha256(bytes(newerGenesis)),
        },
      ],
    },
    retainedEpochTransitionBase64: b64(transition),
    rows: [
      {
        kind: "portfolio-genesis",
        projectionBase64: b64(newerGenesis),
        proofBase64: null,
      },
    ],
  };
  add(
    "NativeOutboxReplay",
    "retained-transition-one-to-two-replayed-two-to-three",
    retained,
    true
  );
  add(
    "WorkerReplayNativeOutboxInput",
    "retained-transition-transport",
    { ...fence, replay: retained },
    true
  );
  await change(
    "NativeOutboxReplay",
    "retainedEpochTransitionBase64",
    "AA==",
    "retained-nullity-without-digest"
  );
  await change(
    "NativeOutboxReplay",
    "grant.retainedEpochTransitionSha256",
    hash,
    "retained-nullity-without-bytes"
  );
  const omittedRetained = { ...replay } as Partial<typeof replay>;
  delete omittedRetained.retainedEpochTransitionBase64;
  add("NativeOutboxReplay", "retained-null-field-required", omittedRetained);
  const omittedRetainedDigest = { ...replayGrant } as Partial<
    typeof replayGrant
  >;
  delete omittedRetainedDigest.retainedEpochTransitionSha256;
  add(
    "NativeOutboxReplayGrant",
    "retained-null-digest-required",
    omittedRetainedDigest
  );
  add("NativeOutboxReplayGrant", "retained-disallows-nonzero-start", {
    ...resumed,
    retainedEpochTransitionSha256: hash,
  });
  add("NativeOutboxReplay", "retained-raw-hash-mismatch", {
    ...retained,
    grant: { ...retained.grant, retainedEpochTransitionSha256: zero },
  });
  add("NativeOutboxReplay", "retained-account-binding", {
    ...retained,
    grant: { ...retained.grant, accountAlias: "other-account" },
  });
  add("NativeOutboxReplay", "retained-stream-binding", {
    ...retained,
    grant: { ...retained.grant, streamId: "other-stream" },
  });
  add("NativeOutboxReplay", "retained-owner-binding", {
    ...retained,
    grant: { ...retained.grant, priorOwnerEpoch: "3", currentOwnerEpoch: "4" },
  });
  const retainedRaw = async (name: string, raw: Uint8Array): Promise<void> => {
    const changed = {
      ...retained,
      grant: {
        ...retained.grant,
        retainedEpochTransitionSha256: await rawBytesSha256(raw),
      },
      retainedEpochTransitionBase64: Buffer.from(raw).toString("base64"),
    };
    add("NativeOutboxReplay", name, changed);
  };
  await retainedRaw(
    "retained-raw-rehashed-invalid-transition",
    bytes({ ...transition, priorOwnerEpoch: "2" })
  );
  await retainedRaw(
    "retained-raw-rehashed-stale-genesis",
    bytes({ ...transition, snapshot: { ...newerGenesis, cash: "11" } })
  );
  await retainedRaw(
    "retained-noncanonical-whitespace",
    new TextEncoder().encode(` ${canonicalArtifactJson(transition)}`)
  );
  await retainedRaw(
    "retained-noncanonical-bom",
    new TextEncoder().encode(`\ufeff${canonicalArtifactJson(transition)}`)
  );
  await retainedRaw(
    "retained-noncanonical-duplicate-key",
    new TextEncoder().encode(
      canonicalArtifactJson(transition).replace(
        "{",
        '{"schemaVersion":"1.0.0",'
      )
    )
  );
  await retainedRaw("retained-malformed-utf8", Uint8Array.from([0xc3, 0x28]));
  const otherGenesis = structuredClone(newerGenesis);
  otherGenesis.snapshotId = "different-valid-genesis";
  const otherBody = structuredClone(otherGenesis) as unknown as Record<
    string,
    unknown
  >;
  delete otherBody["sourceEventHash"];
  delete (otherBody["continuity"] as Record<string, unknown>)[
    "highWaterEventHash"
  ];
  otherGenesis.sourceEventHash = await canonicalJsonSha256(otherBody);
  otherGenesis.continuity.highWaterEventHash = otherGenesis.sourceEventHash;
  add("NativeOutboxReplay", "retained-exact-first-snapshot-byte-binding", {
    ...retained,
    grant: {
      ...retained.grant,
      rows: [
        {
          ...retained.grant.rows[0]!,
          projectionId: otherGenesis.snapshotId,
          eventHash: otherGenesis.sourceEventHash,
          projectionRawSha256: await rawBytesSha256(bytes(otherGenesis)),
        },
      ],
    },
    rows: [
      {
        kind: "portfolio-genesis",
        projectionBase64: b64(otherGenesis),
        proofBase64: null,
      },
    ],
  });
  return cases;
};

// Opt-in large fixtures remain unmaterialized until the explicit deferred
// exporter runs. Transport-only batches use opaque blobs intentionally.
export const buildModelEpochCapacityFixtures = (
  existing: readonly ContractFixture[]
): ContractFixture[] => {
  const sample = (contract: string): Record<string, unknown> => {
    return structuredClone(
      existing.find((item) => item.contract === contract && item.valid)?.payload
    ) as Record<string, unknown>;
  };
  const transition = sample("PortfolioEpochTransition");
  transition["approvalBase64"] = Buffer.alloc(1_048_576).toString("base64");
  const oversizedApproval = {
    ...transition,
    approvalBase64: Buffer.alloc(1_048_577).toString("base64"),
  };
  const input = sample("WorkerReplayNativeOutboxInput");
  const replay = input["replay"] as {
    grant: Record<string, unknown>;
    rows: Record<string, unknown>[];
  };
  const identities = replay.grant["rows"] as Record<string, unknown>[];
  const order = identities[2]!;
  const retainedInput = structuredClone(input);
  const retainedReplay = retainedInput["replay"] as {
    grant: Record<string, unknown>;
    retainedEpochTransitionBase64: string | null;
    rows: Record<string, unknown>[];
  };
  retainedReplay.retainedEpochTransitionBase64 =
    Buffer.alloc(1_048_576).toString("base64");
  retainedReplay.grant["retainedEpochTransitionSha256"] = "a".repeat(64);
  retainedReplay.grant["startingSequence"] = "0";
  retainedReplay.grant["startingEventHash"] = null;
  retainedReplay.grant["rows"] = Array.from({ length: 7 }, (_, index) => ({
    ...order,
    projectionId: `retained-capacity-${index}`,
    sequence: String(index + 1),
    kind: index === 0 ? "portfolio-genesis" : "order",
    eventHash: "a".repeat(64),
  }));
  retainedReplay.rows = Array.from({ length: 7 }, (_, index) => ({
    kind: index === 0 ? "portfolio-genesis" : "order",
    projectionBase64: Buffer.alloc(
      index === 6 ? 1_048_575 : 1_048_576
    ).toString("base64"),
    proofBase64: null,
  }));
  // Six MiB + (one MiB minus one byte) + one MiB sidecar + one approval byte.
  const retainedOverBudget = structuredClone(retainedInput);
  const retainedOverflow = retainedOverBudget["replay"] as {
    rows: Record<string, unknown>[];
  };
  retainedOverflow.rows[6]!["projectionBase64"] =
    Buffer.alloc(1_048_576).toString("base64");
  return [
    {
      name: "PortfolioEpochTransition/maximum-approval-byte-length",
      contract: "PortfolioEpochTransition",
      payload: transition,
      valid: true,
    },
    {
      name: "PortfolioEpochTransition/approval-decoded-byte-limit",
      contract: "PortfolioEpochTransition",
      payload: oversizedApproval,
      valid: false,
    },
    {
      name: "WorkerReplayNativeOutboxInput/exact-eight-MiB-includes-retained-sidecar",
      contract: "WorkerReplayNativeOutboxInput",
      payload: retainedInput,
      valid: true,
    },
    {
      name: "WorkerReplayNativeOutboxInput/retained-sidecar-counted-over-eight-MiB",
      contract: "WorkerReplayNativeOutboxInput",
      payload: retainedOverBudget,
      valid: false,
    },
  ];
};
