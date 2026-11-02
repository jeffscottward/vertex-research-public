import type { Transaction } from "@darkfactory/db/server";
import type {
  VertexPrincipal,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import type { PersistenceContext } from "@darkfactory/db/server/vertex-epoch";
import {
  computeNativeOutboxReplayGrantHash,
  NativeOutboxReplayGrantSchema,
  parsePortfolioEpochTransition,
  type NativeOutboxReplayGrant,
} from "../contracts/vertex-worker-epoch.ts";
import {
  verifyVertexHistoricalEpochApproval,
  type VerifiedVertexEpochApproval,
  type VerifiedVertexHistoricalEpochApproval,
} from "./vertex-runtime-epoch-approval.ts";
import {
  canonicalRecord,
  decodeBase64,
  hashArtifact,
  ns,
  rawSha,
  record,
  requireEpoch,
  text,
  timestampToEpochNanoseconds,
} from "./vertex-runtime-epoch-bytes.ts";
import { reconstructVertexEpochEvidence } from "./vertex-runtime-epoch-evidence.ts";
import {
  readVertexEpochEvidenceArtifact,
  type VertexRuntimeEpochOptions,
} from "./vertex-runtime-epoch.ts";
import { rebuildEpochSnapshot } from "./vertex-runtime-epoch-snapshot.ts";
import { present } from "./present.ts";

export type VerifiedVertexHistoricalEpochTransition = Readonly<{
  historicalOnly: true;
  transitionId: string;
  transitionSha256: string;
  snapshotSha256: string;
  streamId: string;
  priorOwnerEpoch: string;
  ownerEpoch: string;
  priorProjectionSequence: string;
  priorProjectionHash: string;
  journalIdentity: string;
  journalSequence: string;
  journalHeadSha256: string;
  nativeOutboxEvidenceSha256: string;
  nativeOwnerFenceSha256: string;
  priorStateSha256: string;
  restoredStateSha256: string;
  historicalApproval: VerifiedVertexHistoricalEpochApproval;
  ratification: VerifiedVertexEpochApproval;
  verifiedAt: string;
}>;

// Historical provenance is never admitted through normal epochTransition.
// The fresh replay owner independently ratifies the exact retained sidecar;
// the caller must additionally match this old journal head to the prefix of
// its reconstructed CURRENT journal and the first retained genesis bytes.
// State alone owns prior-head CAS/history insertion and the fresh0019 consume.
export const verifyVertexHistoricalEpochTransition = async (
  ctx: PersistenceContext,
  options: VertexRuntimeEpochOptions,
  tx: Transaction,
  principal: VertexPrincipal,
  scope: VertexScope,
  originalBytes: Uint8Array,
  at: string,
  ratificationInput: Readonly<{ grant: NativeOutboxReplayGrant }>
): Promise<VerifiedVertexHistoricalEpochTransition> => {
  requireEpoch(!options.signal?.aborted && options.authority, "unavailable");
  const authority = ctx.capture(present(options.authority));
  const grant = NativeOutboxReplayGrantSchema.parse(ratificationInput.grant);
  const transition = await parsePortfolioEpochTransition(
    canonicalRecord(originalBytes)
  );
  const snapshot = transition.snapshot;
  const transitionSha256 = await rawSha(originalBytes);
  const snapshotSha256 = await hashArtifact(snapshot);
  const now = timestampToEpochNanoseconds(at);
  const issued = timestampToEpochNanoseconds(grant.issuedAt);
  const expires = timestampToEpochNanoseconds(grant.expiresAt);
  requireEpoch(
    scope.environment === "paper" &&
      grant.environment === "paper" &&
      grant.accountAlias === scope.accountAlias &&
      grant.serviceActorId === principal.actorId,
    "denied"
  );
  requireEpoch(
    snapshot.accountAlias === scope.accountAlias &&
      snapshot.environment === "paper" &&
      snapshot.streamId === grant.streamId &&
      snapshot.ownerEpoch === grant.priorOwnerEpoch &&
      transition.journalIdentity === grant.journalIdentity &&
      ns(grant.currentOwnerEpoch) > ns(snapshot.ownerEpoch),
    "denied"
  );
  requireEpoch(
    grant.retainedEpochTransitionSha256 !== null &&
      grant.retainedEpochTransitionSha256 === transitionSha256 &&
      (await hashArtifact(transition)) === transitionSha256,
    "denied"
  );
  const first = grant.rows[0];
  requireEpoch(
    grant.startingSequence === "0" &&
      grant.startingEventHash === null &&
      first?.kind === "portfolio-genesis" &&
      first.sequence === "1" &&
      first.projectionId === snapshot.snapshotId &&
      first.eventHash === snapshot.sourceEventHash &&
      first.projectionRawSha256 === snapshotSha256 &&
      first.proofSha256 === null,
    "denied"
  );
  requireEpoch(issued <= now && now < expires, "stale");
  await ctx.authorize(principal, scope, null, grant.streamId, "project", at);
  await ctx.authorize(
    principal,
    scope,
    null,
    "native-outbox-replay",
    "project",
    at
  );
  const nativeSubject = {
    account_alias: scope.accountAlias,
    environment: "paper",
    simulator_id: authority.policy.simulatorId,
    stream_id: snapshot.streamId,
    journal_identity: transition.journalIdentity,
    prior_owner_epoch: transition.priorOwnerEpoch,
    current_owner_epoch: snapshot.ownerEpoch,
    prior_projection_sequence: transition.priorProjectionSequence,
    prior_projection_hash: transition.priorProjectionHash,
    journal_sequence: transition.journalSequence,
    journal_head_sha256: transition.journalHeadSha256,
    new_snapshot_sha256: snapshotSha256,
    native_outbox_evidence_sha256: transition.nativeOutboxEvidenceSha256,
    native_owner_fence_sha256: transition.nativeOwnerFenceSha256,
  };
  const replaySha256 = await computeNativeOutboxReplayGrantHash(grant);
  const verified = await verifyVertexHistoricalEpochApproval(
    authority,
    transition.approvalBase64,
    nativeSubject,
    principal.actorId,
    now,
    {
      approvalBase64: grant.approvalBase64,
      binding: {
        action: "native-outbox-replay",
        subject: { replaySha256 },
        accountAlias: grant.accountAlias,
        environment: "paper",
        simulatorId: authority.policy.simulatorId,
        streamId: grant.streamId,
        journalIdentity: grant.journalIdentity,
        ownerEpoch: grant.currentOwnerEpoch,
      },
    }
  );
  const freshPayload = record(
    canonicalRecord(decodeBase64(grant.approvalBase64, 65_536))["payload"]
  );
  requireEpoch(
    grant.grantId === verified.ratification.approvalId &&
      issued === ns(freshPayload["issuedNs"]) &&
      expires === ns(verified.ratification.expiresNs),
    "denied"
  );
  // Resolve the ORIGINAL staged objects by their original digest identities.
  // Never fabricate an old owner fence/dump from today's journal or snapshot.
  const outboxBytes = await readVertexEpochEvidenceArtifact(
    ctx,
    options,
    tx,
    principal,
    scope,
    `native-outbox-evidence-${transition.nativeOutboxEvidenceSha256}`,
    transition.nativeOutboxEvidenceSha256,
    at
  );
  const fenceBytes = await readVertexEpochEvidenceArtifact(
    ctx,
    options,
    tx,
    principal,
    scope,
    `native-owner-fence-${transition.nativeOwnerFenceSha256}`,
    transition.nativeOwnerFenceSha256,
    at
  );
  const historicalIssued = ns(verified.historicalApproval.issuedNs);
  const evidence = await reconstructVertexEpochEvidence(
    outboxBytes,
    fenceBytes,
    historicalIssued
  );
  const native = evidence.outbox;
  requireEpoch(
    native["accountAlias"] === scope.accountAlias &&
      native["environment"] === "paper" &&
      native["streamId"] === snapshot.streamId &&
      native["ownerEpoch"] === snapshot.ownerEpoch &&
      native["priorOwnerEpoch"] === transition.priorOwnerEpoch &&
      native["priorProjectionSequence"] ===
        transition.priorProjectionSequence &&
      native["priorProjectionHash"] === transition.priorProjectionHash &&
      native["journalIdentity"] === transition.journalIdentity &&
      native["journalSequence"] === transition.journalSequence &&
      native["journalHeadSha256"] === transition.journalHeadSha256
  );
  requireEpoch(
    native["simulatorId"] === authority.policy.simulatorId &&
      native["currency"] === authority.policy.currency,
    "denied"
  );
  requireEpoch(
    evidence.outboxSha256 === transition.nativeOutboxEvidenceSha256 &&
      evidence.fenceSha256 === transition.nativeOwnerFenceSha256
  );
  requireEpoch(
    ns(native["capturedAtNs"]) <= historicalIssued &&
      historicalIssued - ns(native["capturedAtNs"]) <=
        ns(authority.policy.maximumApprovalTtlNs),
    "denied"
  );
  const evaluated = timestampToEpochNanoseconds(
    snapshot.continuity.evaluatedAt
  );
  requireEpoch(
    evaluated <= now && evaluated < ns(verified.historicalApproval.expiresNs),
    "denied"
  );
  await rebuildEpochSnapshot(evidence.state, snapshot);
  requireEpoch(!options.signal?.aborted, "unavailable");
  return Object.freeze({
    historicalOnly: true,
    transitionId: transition.transitionId,
    transitionSha256,
    snapshotSha256,
    streamId: snapshot.streamId,
    priorOwnerEpoch: transition.priorOwnerEpoch,
    ownerEpoch: snapshot.ownerEpoch,
    priorProjectionSequence: transition.priorProjectionSequence,
    priorProjectionHash: transition.priorProjectionHash,
    journalIdentity: transition.journalIdentity,
    journalSequence: transition.journalSequence,
    journalHeadSha256: transition.journalHeadSha256,
    nativeOutboxEvidenceSha256: evidence.outboxSha256,
    nativeOwnerFenceSha256: evidence.fenceSha256,
    priorStateSha256: text(native["priorStateSha256"]),
    restoredStateSha256: text(native["currentStateSha256"]),
    historicalApproval: verified.historicalApproval,
    ratification: verified.ratification,
    verifiedAt: at,
  });
};
