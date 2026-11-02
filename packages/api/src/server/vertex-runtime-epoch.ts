import { sql } from "drizzle-orm";
import type { Transaction } from "@darkfactory/db/server";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexRightsRecord,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import {
  createEpochTransitionOperations,
  one,
  type PersistenceContext,
} from "@darkfactory/db/server/vertex-epoch";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import { parsePortfolioEpochTransition } from "../contracts/vertex-worker-epoch.ts";
import {
  toVertexVerifiedNativeApproval,
  verifyVertexEpochApproval,
  type VerifiedVertexEpochApproval,
  type VertexEpochAuthority,
} from "./vertex-runtime-epoch-approval.ts";
import {
  canonicalRecord,
  decodeBase64,
  hashArtifact,
  id,
  ns,
  rawSha,
  record,
  requireEpoch,
  sha,
  text,
  timestampToEpochNanoseconds,
} from "./vertex-runtime-epoch-bytes.ts";
import { reconstructVertexEpochEvidence } from "./vertex-runtime-epoch-evidence.ts";
import { rebuildEpochSnapshot } from "./vertex-runtime-epoch-snapshot.ts";
import { present } from "./present.ts";
export type {
  VertexEpochAuthority,
  VerifiedVertexEpochApproval,
} from "./vertex-runtime-epoch-approval.ts";

export type VertexRuntimeEpochOptions = Readonly<{
  authority?: VertexEpochAuthority;
  objectCapabilities: (scope: VertexScope) => VertexObjectCapabilities;
  signal?: AbortSignal;
}>;
export type VerifiedVertexEpochTransition = Readonly<{
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
  approval: VerifiedVertexEpochApproval;
  verifiedAt: string;
}>;
const active = (options: VertexRuntimeEpochOptions): void => {
  requireEpoch(!options.signal?.aborted, "unavailable");
};

// Real scoped DB descriptor + current rights + bounded object storage lookup.
// Staging or worker authentication alone never authorizes reading these bytes.
export const readVertexEpochEvidenceArtifact = async (
  ctx: PersistenceContext,
  options: VertexRuntimeEpochOptions,
  tx: Transaction,
  principal: VertexPrincipal,
  scope: VertexScope,
  artifactId: string,
  expectedSha256: string,
  at: string
): Promise<Uint8Array> => {
  active(options);
  id(artifactId);
  sha(expectedSha256);
  const row = await one(
    tx,
    "vertex_worker_stages",
    scope,
    sql`artifact_id = ${artifactId}`
  );
  requireEpoch(row, "unavailable");
  const stage = present(row);
  const descriptor = record(stage["payload"]);
  const collection =
    stage["collection_key"] === "" ? null : id(stage["collection_key"]);
  requireEpoch(
    (await ctx.hash(descriptor)) === stage["request_hash"] &&
      descriptor["artifactId"] === artifactId &&
      descriptor["accountAlias"] === scope.accountAlias &&
      descriptor["environment"] === scope.environment &&
      descriptor["collectionId"] === collection &&
      stage["content_sha256"] === expectedSha256 &&
      (stage["canonical_sha256"] === null ||
        stage["canonical_sha256"] === expectedSha256)
  );
  await ctx.authorize(principal, scope, collection, artifactId, "read", at);
  const policyId = id(descriptor["rightsPolicyId"]);
  await ctx.authorize(principal, scope, collection, policyId, "read", at);
  const current = await ctx.latestRights(tx, scope, collection, policyId);
  requireEpoch(current, "denied");
  const rights = record(
    present(current)["payload"]
  ) as unknown as VertexRightsRecord;
  requireEpoch(
    (await ctx.hash(rights)) === present(current)["record_hash"] &&
      rights.version === descriptor["rightsVersion"],
    "stale"
  );
  await ctx.rights(tx, scope, collection, rights, "read", at);
  const expectedKey = vertexQualifiedObjectKey(
    scope,
    collection,
    stage["canonical_sha256"] === expectedSha256 ? "manifest" : "content",
    expectedSha256
  );
  requireEpoch(stage["object_key"] === expectedKey);
  const capabilities = options.objectCapabilities(scope);
  requireEpoch(capabilities.getBounded, "unavailable");
  active(options);
  const response = await present(capabilities.getBounded)(
    expectedKey,
    1_048_576
  );
  requireEpoch(response.status === "ok", "unavailable");
  if (response.status !== "ok") throw new Error("unreachable");
  const bytes = response.value.body;
  requireEpoch(
    bytes instanceof Uint8Array &&
      bytes.length > 0 &&
      bytes.length <= 1_048_576 &&
      bytes.length === stage["byte_length"] &&
      response.value.metadata.key === expectedKey &&
      response.value.metadata.size === bytes.length &&
      (await rawSha(bytes)) === expectedSha256
  );
  active(options);
  return new Uint8Array(bytes);
};

const verifyVertexRuntimeEpochTransition = async (
  ctx: PersistenceContext,
  options: VertexRuntimeEpochOptions,
  tx: Transaction,
  principal: VertexPrincipal,
  scope: VertexScope,
  input: unknown,
  at: string
): Promise<VerifiedVertexEpochTransition> => {
  active(options);
  requireEpoch(options.authority, "unavailable");
  // Capture configured authority afresh for EACH of the store's two checks.
  // No process-global public-key/revocation/permission cache is consulted.
  const authority = ctx.capture(present(options.authority));
  const transition = await parsePortfolioEpochTransition(input);
  const snapshot = transition.snapshot;
  requireEpoch(
    scope.environment === "paper" &&
      snapshot.accountAlias === scope.accountAlias &&
      snapshot.environment === scope.environment,
    "denied"
  );
  await ctx.authorize(principal, scope, null, snapshot.streamId, "project", at);
  await ctx.authorize(
    principal,
    scope,
    null,
    "owner-epoch-transition",
    "project",
    at
  );
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
  const now = timestampToEpochNanoseconds(at);
  const evidence = await reconstructVertexEpochEvidence(
    outboxBytes,
    fenceBytes,
    now
  );
  const native = evidence.outbox;
  requireEpoch(
    native["accountAlias"] === scope.accountAlias &&
      native["environment"] === scope.environment &&
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
  await rebuildEpochSnapshot(evidence.state, snapshot);
  const snapshotSha256 = await hashArtifact(snapshot);
  const nativeSubject = {
    account_alias: scope.accountAlias,
    environment: "paper",
    simulator_id: native["simulatorId"],
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
  const approval = await verifyVertexEpochApproval(
    authority,
    transition.approvalBase64,
    nativeSubject,
    principal.actorId,
    now
  );
  // Signed evidence must predate the human approval and remain within the
  // current approval lifetime; a newly signed stale owner dump is not fresh.
  const approvalPayload = record(
    canonicalRecord(decodeBase64(transition.approvalBase64, 65_536))["payload"]
  );
  requireEpoch(
    ns(native["capturedAtNs"]) <= ns(approvalPayload["issuedNs"]) &&
      now - ns(native["capturedAtNs"]) <=
        ns(authority.policy.maximumApprovalTtlNs),
    "stale"
  );
  const transitionSha256 = await hashArtifact(transition);
  // Only check the exact retained transition for idempotent head handling.
  // Shared DB audit owns permanent, global cross-purpose approval/nonce
  // consumption atomically with projection writes; no parallel API ledger.
  const existing = await one(
    tx,
    "vertex_portfolio_epoch_transitions",
    scope,
    sql`transition_id = ${transition.transitionId}`
  );
  let exactPriorTransition = false;
  if (existing) {
    requireEpoch(
      existing["transition_sha256"] === transitionSha256 &&
        (await ctx.hash(existing["payload"])) === transitionSha256,
      "conflict"
    );
    exactPriorTransition = true;
  }
  const head = await one(
    tx,
    "vertex_projection_heads",
    scope,
    sql`stream_id = ${snapshot.streamId}`
  );
  requireEpoch(head, "stale");
  const oldHead =
    present(head)["owner_epoch"] === transition.priorOwnerEpoch &&
    present(head)["high_water_sequence"] ===
      transition.priorProjectionSequence &&
    present(head)["high_water_event_hash"] === transition.priorProjectionHash;
  // A duplicate's real head may have advanced. Immutable transition/snapshot
  // retention is checked by the atomic DB operation; never reset its head.
  requireEpoch(
    oldHead ||
      (exactPriorTransition &&
        ns(present(head)["owner_epoch"]) >= ns(snapshot.ownerEpoch)),
    "conflict"
  );
  active(options);
  return Object.freeze({
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
    approval,
    verifiedAt: at,
  });
};

// Factory creation is inert: no DB transaction, crypto import, clock call,
// storage lookup, authority enrollment or ambient/private configuration read.
export const createVertexRuntimeEpochOperations = (
  ctx: PersistenceContext,
  options: VertexRuntimeEpochOptions
) => {
  const epochTransition = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    transition: VertexRecord,
    at: string
  ): Promise<VertexRecord> => {
    active(options);
    const operations = createEpochTransitionOperations(ctx, {
      verifyNativeEpochTransition: async (request) => {
        const proof = await verifyVertexRuntimeEpochTransition(
          ctx,
          options,
          tx,
          request.principal,
          request.scope,
          request.transition,
          request.now
        );
        requireEpoch(proof.transitionSha256 === request.transitionSha256);
        return toVertexVerifiedNativeApproval(proof.approval);
      },
    });
    const result = await operations.transitionPortfolioEpochInTransaction(
      tx,
      principal,
      scope,
      transition,
      at
    );
    active(options);
    return { ...result };
  };
  return Object.freeze({ epochTransition });
};
