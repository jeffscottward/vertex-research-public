import type { Transaction } from "@darkfactory/db/server";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import type { VertexWorkerOptions } from "@darkfactory/db/server/vertex-worker";
import {
  createNativeOutboxReplayOperations,
  type PersistenceContext,
} from "@darkfactory/db/server/vertex-epoch";
import {
  computeNativeOutboxReplayGrantHash,
  parseNativeOutboxReplay,
  type NativeOutboxReplay,
} from "../contracts/vertex-worker-epoch.ts";
import {
  toVertexVerifiedNativeApproval,
  verifyVertexNativeApproval,
  type VerifiedVertexEpochApproval,
} from "./vertex-runtime-epoch-approval.ts";
import {
  canonicalRecord,
  decodeBase64,
  hashArtifact,
  list,
  ns,
  rawSha,
  record,
  requireEpoch,
  same,
  text,
  timestampToEpochNanoseconds,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import {
  reconstructVertexEpochEvidence,
  type ReconstructedVertexEpochEvidence,
} from "./vertex-runtime-epoch-evidence.ts";
import {
  readVertexEpochEvidenceArtifact,
  type VertexRuntimeEpochOptions,
} from "./vertex-runtime-epoch.ts";
import { verifyVertexHistoricalEpochTransition } from "./vertex-runtime-epoch-historical.ts";
import { present } from "./present.ts";

export type VertexRuntimeReplayOptions = VertexRuntimeEpochOptions;
export type VerifiedVertexNativeOutboxReplay = Readonly<{
  grantId: string;
  replaySha256: string;
  replayRequestSha256: string;
  streamId: string;
  priorOwnerEpoch: string;
  currentOwnerEpoch: string;
  serviceActorId: string;
  startingSequence: string;
  startingEventHash: string | null;
  rowCount: number;
  journalIdentity: string;
  journalSequence: string;
  journalHeadSha256: string;
  nativeJournalEvidenceSha256: string;
  nativeOwnerFenceSha256: string;
  retainedEpochTransitionSha256: string | null;
  approval: VerifiedVertexEpochApproval;
  verifiedAt: string;
}>;
const active = (options: VertexRuntimeReplayOptions): void => {
  requireEpoch(!options.signal?.aborted, "unavailable");
};
const replayKind = (value: unknown): string =>
  value === "execution" ? "order" : text(value);

// A valid projection DTO or a matching caller hash is not proof of retention.
// Select ONLY the original journal's first unacknowledged publication suffix.
// Snapshot rows keep their existing head; only genesis/order/fact rows advance it.
const verifyRetainedReplayRows = async (
  replay: NativeOutboxReplay,
  evidence: ReconstructedVertexEpochEvidence
): Promise<void> => {
  const grant = replay.grant;
  let pending = false;
  let startingSequence = "0";
  let startingEventHash: string | null = null;
  const retained: NativeRecord[] = [];
  for (const row of evidence.projections) {
    if (row["acknowledged"]) {
      requireEpoch(!pending);
      if (row["ownerEpoch"] === grant.priorOwnerEpoch) {
        startingSequence = text(row["sequence"]);
        startingEventHash = text(row["eventHash"]);
      }
    } else {
      pending = true;
      // No earlier epoch's unacknowledged row can be skipped by a newer grant.
      requireEpoch(row["ownerEpoch"] === grant.priorOwnerEpoch);
      retained.push(row);
    }
  }
  requireEpoch(
    retained.length >= replay.rows.length &&
      replay.rows.length > 0 &&
      replay.rows.length <= 64
  );
  requireEpoch(
    startingSequence === grant.startingSequence &&
      startingEventHash === grant.startingEventHash
  );
  const proofs = new Map<string, NativeRecord>();
  for (const raw of list(evidence.outbox["nativeProofs"])) {
    const proof = record(raw);
    proofs.set(`${proof["artifactId"]}:${proof["sha256"]}`, proof);
  }
  for (const [index, row] of replay.rows.entries()) {
    const original = present(retained[index]);
    const identity = present(grant.rows[index]);
    const projection = record(original["projection"]);
    requireEpoch(
      replayKind(original["kind"]) === row.kind && row.kind === identity.kind
    );
    requireEpoch(
      original["payloadBase64"] === row.projectionBase64 &&
        original["payloadSha256"] === identity.projectionRawSha256 &&
        original["sequence"] === identity.sequence &&
        original["eventHash"] === identity.eventHash
    );
    requireEpoch(
      (row.kind === "portfolio-genesis" || row.kind === "portfolio-snapshot"
        ? projection["snapshotId"]
        : projection["projectionId"]) === identity.projectionId
    );
    // Original bytes, not re-serialized caller JSON, must agree on both sides.
    const bytes = decodeBase64(row.projectionBase64);
    requireEpoch(
      (await rawSha(bytes)) === identity.projectionRawSha256 &&
        same(canonicalRecord(bytes), projection)
    );
    if (row.kind === "native-fact") {
      const reference = record(projection["proof"]);
      const proof = proofs.get(
        `${reference["artifactId"]}:${reference["sha256"]}`
      );
      requireEpoch(
        proof &&
          proof["sha256"] === identity.proofSha256 &&
          proof["payloadBase64"] === row.proofBase64
      );
      requireEpoch(
        (await rawSha(decodeBase64(row.proofBase64))) === identity.proofSha256
      );
    } else {
      requireEpoch(row.proofBase64 === null && identity.proofSha256 === null);
    }
  }
};

// This is concrete verification, not an injected allow/deny callback. The same
// explicitly enrolled Ed25519/status authority as epoch transitions is used;
// worker JWTs and staged object descriptors do not confer replay approval.
export const verifyVertexRuntimeNativeOutboxReplay = async (
  ctx: PersistenceContext,
  options: VertexRuntimeReplayOptions,
  tx: Transaction,
  principal: VertexPrincipal,
  scope: VertexScope,
  input: unknown,
  at: string
): Promise<VerifiedVertexNativeOutboxReplay> => {
  active(options);
  requireEpoch(options.authority, "unavailable");
  const authority = ctx.capture(present(options.authority));
  const replay = await parseNativeOutboxReplay(ctx.capture(input));
  const grant = replay.grant;
  const now = timestampToEpochNanoseconds(at);
  const issued = timestampToEpochNanoseconds(grant.issuedAt);
  const expires = timestampToEpochNanoseconds(grant.expiresAt);
  requireEpoch(
    scope.environment === "paper" &&
      grant.accountAlias === scope.accountAlias &&
      grant.environment === scope.environment &&
      grant.serviceActorId === principal.actorId,
    "denied"
  );
  requireEpoch(issued <= now && now < expires, "stale");
  // Separate, current emitter permissions are necessary even after the worker
  // has independently resolved its configured nativeProjectionPrincipal.
  await ctx.authorize(principal, scope, null, grant.streamId, "project", at);
  await ctx.authorize(
    principal,
    scope,
    null,
    "native-outbox-replay",
    "project",
    at
  );
  const outboxBytes = await readVertexEpochEvidenceArtifact(
    ctx,
    options,
    tx,
    principal,
    scope,
    `native-outbox-evidence-${grant.nativeJournalEvidenceSha256}`,
    grant.nativeJournalEvidenceSha256,
    at
  );
  const fenceBytes = await readVertexEpochEvidenceArtifact(
    ctx,
    options,
    tx,
    principal,
    scope,
    `native-owner-fence-${grant.nativeOwnerFenceSha256}`,
    grant.nativeOwnerFenceSha256,
    at
  );
  // false is LOCAL to this recovery path. Normal epoch transition still calls
  // the reconstruction helper with its default all-ACK requirement.
  const evidence = await reconstructVertexEpochEvidence(
    outboxBytes,
    fenceBytes,
    now,
    false
  );
  const native = evidence.outbox;
  requireEpoch(
    evidence.outboxSha256 === grant.nativeJournalEvidenceSha256 &&
      evidence.fenceSha256 === grant.nativeOwnerFenceSha256
  );
  requireEpoch(
    native["accountAlias"] === grant.accountAlias &&
      native["environment"] === grant.environment &&
      native["streamId"] === grant.streamId &&
      native["priorOwnerEpoch"] === grant.priorOwnerEpoch &&
      native["ownerEpoch"] === grant.currentOwnerEpoch
  );
  requireEpoch(
    native["journalIdentity"] === grant.journalIdentity &&
      native["journalSequence"] === grant.journalSequence &&
      native["journalHeadSha256"] === grant.journalHeadSha256
  );
  requireEpoch(
    native["simulatorId"] === authority.policy.simulatorId &&
      native["currency"] === authority.policy.currency,
    "denied"
  );
  requireEpoch(
    ns(native["capturedAtNs"]) <= issued &&
      now - ns(native["capturedAtNs"]) <=
        ns(authority.policy.maximumApprovalTtlNs),
    "stale"
  );
  await verifyRetainedReplayRows(replay, evidence);
  const replaySha256 = await computeNativeOutboxReplayGrantHash(grant);
  const approval = await verifyVertexNativeApproval(
    authority,
    grant.approvalBase64,
    {
      action: "native-outbox-replay",
      subject: { replaySha256 },
      accountAlias: grant.accountAlias,
      environment: "paper",
      simulatorId: text(native["simulatorId"]),
      streamId: grant.streamId,
      journalIdentity: grant.journalIdentity,
      ownerEpoch: grant.currentOwnerEpoch,
    },
    principal.actorId,
    now
  );
  // These clocks and IDs are part of both signed representations. Alias or
  // lifetime widening is rejected, including independently valid signatures.
  const approvalPayload = record(
    canonicalRecord(decodeBase64(grant.approvalBase64, 65_536))["payload"]
  );
  requireEpoch(
    grant.grantId === approval.approvalId &&
      issued === ns(approvalPayload["issuedNs"]) &&
      expires === ns(approval.expiresNs),
    "denied"
  );
  if (replay.retainedEpochTransitionBase64 !== null) {
    const originalBytes = decodeBase64(replay.retainedEpochTransitionBase64);
    const original = canonicalRecord(originalBytes);
    const first = present(replay.rows[0]);
    requireEpoch(
      grant.retainedEpochTransitionSha256 !== null &&
        grant.startingSequence === "0" &&
        grant.startingEventHash === null &&
        first.kind === "portfolio-genesis"
    );
    requireEpoch(
      (await rawSha(originalBytes)) === grant.retainedEpochTransitionSha256
    );
    const originalSnapshot = canonicalRecord(
      decodeBase64(first.projectionBase64)
    );
    requireEpoch(same(original["snapshot"], originalSnapshot));
    // This independently verifies fresh ratification AGAIN from signed bytes,
    // then the original transition as historical evidence at its issuance.
    // Old expiry is never promoted to current owner-epoch authority. Original
    // artifacts are read by their old hashes under current read permissions.
    const historical = await verifyVertexHistoricalEpochTransition(
      ctx,
      options,
      tx,
      principal,
      scope,
      originalBytes,
      at,
      { grant }
    );
    requireEpoch(
      historical.historicalOnly === true &&
        historical.transitionSha256 === grant.retainedEpochTransitionSha256 &&
        historical.snapshotSha256 ===
          present(grant.rows[0]).projectionRawSha256 &&
        historical.ownerEpoch === grant.priorOwnerEpoch
    );
    requireEpoch(
      historical.ratification.approvalSha256 === approval.approvalSha256 &&
        historical.ratification.nativeTransitionSha256 === replaySha256
    );
    // Shared identity alone cannot link two journals. The current original
    // chain must extend the exact historical head committed by the sidecar.
    requireEpoch(
      historical.journalIdentity === grant.journalIdentity &&
        ns(historical.journalSequence) < ns(grant.journalSequence)
    );
    const currentJournal = list(native["events"]).map(record);
    const prefix = currentJournal.find(
      (row) => row["sequence"] === historical.journalSequence
    );
    requireEpoch(
      prefix && prefix["eventHash"] === historical.journalHeadSha256
    );
    // Native stores the signed transition before appending this exact genesis,
    // with no intervening journal event. Require that actual edge, not merely
    // two compatible histories bearing the same journal name.
    const genesisSequence = (ns(historical.journalSequence) + 1n).toString();
    const genesisRow = currentJournal.find(
      (row) => row["sequence"] === genesisSequence
    );
    requireEpoch(genesisRow);
    const genesisEvent = canonicalRecord(
      decodeBase64(present(genesisRow)["payloadBase64"], 262_144),
      262_144
    );
    requireEpoch(
      genesisEvent["sequence"] === genesisSequence &&
        genesisEvent["previousHash"] === historical.journalHeadSha256 &&
        genesisEvent["ownerEpoch"] === grant.priorOwnerEpoch &&
        genesisEvent["kind"] === "portfolio-genesis"
    );
    requireEpoch(
      same(genesisEvent["data"], {
        snapshotId: originalSnapshot["snapshotId"],
        sequence: originalSnapshot["sequence"],
        ownerEpoch: originalSnapshot["ownerEpoch"],
        sourceEventHash: originalSnapshot["sourceEventHash"],
      })
    );
  }
  const replayRequestSha256 = await hashArtifact(replay);
  active(options);
  return Object.freeze({
    grantId: grant.grantId,
    replaySha256,
    replayRequestSha256,
    streamId: grant.streamId,
    priorOwnerEpoch: grant.priorOwnerEpoch,
    currentOwnerEpoch: grant.currentOwnerEpoch,
    serviceActorId: grant.serviceActorId,
    startingSequence: grant.startingSequence,
    startingEventHash: grant.startingEventHash,
    rowCount: replay.rows.length,
    journalIdentity: grant.journalIdentity,
    journalSequence: grant.journalSequence,
    journalHeadSha256: grant.journalHeadSha256,
    nativeJournalEvidenceSha256: evidence.outboxSha256,
    nativeOwnerFenceSha256: evidence.fenceSha256,
    retainedEpochTransitionSha256: grant.retainedEpochTransitionSha256,
    approval,
    verifiedAt: at,
  });
};

// Composition is inert. Missing enrollment is unavailable only if replay is
// invoked. State owns one atomic transaction, original receipt deduplication,
// exact starting-head fencing and the append of this bounded retained prefix.
export const createVertexRuntimeNativeOutboxReplay = (
  ctx: PersistenceContext,
  options: VertexRuntimeReplayOptions
): NonNullable<VertexWorkerOptions["nativeOutboxReplay"]> => {
  return async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    replay: VertexRecord,
    at: string
  ): Promise<VertexRecord> => {
    active(options);
    requireEpoch(options.authority, "unavailable");
    const operations = createNativeOutboxReplayOperations(ctx, {
      verifyNativeOutboxReplay: async (request) => {
        const proof = await verifyVertexRuntimeNativeOutboxReplay(
          ctx,
          options,
          tx,
          request.principal,
          request.scope,
          request.replay,
          request.now
        );
        requireEpoch(proof.replaySha256 === request.replaySha256);
        // Return actual signer/key-version/current-status claims. The shared
        // DB audit consumes this proof in the SAME transaction as old receipts;
        // this verifier performs no parallel ledger writes or nonce consumption.
        return toVertexVerifiedNativeApproval(proof.approval);
      },
    });
    const result = await operations.replayNativeOutboxInTransaction(
      tx,
      principal,
      scope,
      replay,
      at
    );
    active(options);
    requireEpoch(
      result.status === "applied" || result.status === "duplicate",
      "conflict"
    );
    return { ...result };
  };
};
