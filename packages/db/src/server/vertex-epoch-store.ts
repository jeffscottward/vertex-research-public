import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  assertSameNativeApproval,
  captureVerifiedNativeApproval,
  createNativeApprovalAuditOperations,
  type VertexNativeApprovalBinding,
  type VertexVerifiedNativeApproval,
} from "./vertex-native-approval-audit.ts";
import {
  array,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexProjectionResult,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createProjectionIngestion } from "./vertex-projection-ingestion.ts";
import { persistPortfolioSnapshotRows } from "./vertex-projection-store.ts";

// Trusted composition port, NOT a request boolean. The implementation must
// independently resolve signed evidence hashes to actual durable native outbox
// ACK high-water, journal/checkpoint economics and current owner-fence state;
// verify the exact subject with a separately enrolled, currently unrevoked human
// owner-epoch-transition approver. A worker/service grant is never that approval.
// No native state is seeded or changed by this observation-only store.
export type VertexNativeEpochTransitionVerifier = (
  input: Readonly<{
    principal: VertexPrincipal;
    scope: VertexScope;
    transition: VertexRecord;
    transitionSha256: string;
    now: string;
  }>
) => Promise<VertexVerifiedNativeApproval | null>;
export type VertexEpochTransitionOptions = Readonly<{
  verifyNativeEpochTransition?: VertexNativeEpochTransitionVerifier;
}>;

const transitionColumns = (
  value: VertexRecord,
  snapshot: VertexRecord,
  transitionSha256: string,
  snapshotSha256: string
): Row => ({
  transition_id: value["transitionId"],
  stream_id: snapshot["streamId"],
  prior_owner_epoch: value["priorOwnerEpoch"],
  prior_projection_sequence: value["priorProjectionSequence"],
  prior_projection_hash: value["priorProjectionHash"],
  owner_epoch: snapshot["ownerEpoch"],
  snapshot_id: snapshot["snapshotId"],
  snapshot_sha256: snapshotSha256,
  genesis_hash: snapshot["sourceEventHash"],
  journal_identity: value["journalIdentity"],
  journal_sequence: value["journalSequence"],
  journal_head_sha256: value["journalHeadSha256"],
  native_outbox_evidence_sha256: value["nativeOutboxEvidenceSha256"],
  native_owner_fence_sha256: value["nativeOwnerFenceSha256"],
  approval_base64: value["approvalBase64"],
  transition_sha256: transitionSha256,
  authoritative: false,
  execution_authorized: false,
});
const canonicalRetainedRecord = (
  ctx: PersistenceContext,
  encoded: unknown
): { bytes: Uint8Array; value: VertexRecord } => {
  const base64 = string(encoded);
  if (
    base64.length < 4 ||
    base64.length > 1_398_104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64
    )
  )
    return fail("invalid");
  try {
    const binary = atob(base64);
    if (binary.length > 1_048_576 || btoa(binary) !== base64)
      return fail("invalid");
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const value = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
    const canonical = ctx.encode(value);
    if (
      canonical.length !== bytes.length ||
      canonical.some((byte, index) => byte !== bytes[index])
    )
      return fail("integrity");
    return { bytes, value };
  } catch {
    return fail("invalid");
  }
};

export const createEpochTransitionOperations = (
  ctx: PersistenceContext,
  options: VertexEpochTransitionOptions = {}
) => {
  const ingestion = createProjectionIngestion(ctx);
  const audit = createNativeApprovalAuditOperations(ctx);
  const verifyStoredAuthorization = async (
    tx: Transaction,
    scope: VertexScope,
    stored: Row
  ): Promise<void> => {
    const fields = [
      stored["authorizing_replay_request_sha256"],
      stored["authorizing_signer_key_sha256"],
      stored["authorizing_approval_id"],
    ];
    if (stored["authorization_kind"] === "direct") {
      if (fields.some((field) => field !== null)) fail("integrity");
      return;
    }
    if (
      stored["authorization_kind"] !== "retained-replay" ||
      fields.some((field) => field === null)
    )
      fail("integrity");
    digestString(stored["authorizing_replay_request_sha256"]);
    digestString(stored["authorizing_signer_key_sha256"]);
    identifier(stored["authorizing_approval_id"]);
    const authorizations = await rows(
      tx,
      sql`select * from vertex_native_approval_audit where signer_key_sha256 = ${stored["authorizing_signer_key_sha256"]} and approval_id = ${stored["authorizing_approval_id"]} and request_sha256 = ${stored["authorizing_replay_request_sha256"]} limit 1`
    );
    const authorization = authorizations[0];
    if (
      !authorization ||
      (await ctx.hash(authorization["payload"])) !==
        authorization["record_hash"]
    )
      fail("integrity");
    const payload = object(
      requirePresent(authorization, "authorization")["payload"]
    );
    const receipt = object(payload["receipt"]);
    if (
      requirePresent(authorization, "authorization")["action"] !==
        "native-outbox-replay" ||
      receipt["action"] !== "native-outbox-replay" ||
      payload["accountAlias"] !== scope.accountAlias ||
      payload["environment"] !== scope.environment ||
      payload["recipientActorId"] !== stored["actor_id"] ||
      payload["streamId"] !== stored["stream_id"] ||
      payload["requestSha256"] !==
        stored["authorizing_replay_request_sha256"] ||
      receipt["signerKeySha256"] !== stored["authorizing_signer_key_sha256"] ||
      receipt["approvalId"] !== stored["authorizing_approval_id"]
    )
      fail("integrity");
  };
  const transitionPortfolioEpochInTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    input: unknown,
    at: string
  ): Promise<VertexProjectionResult> => {
    const value = await ctx.validate("PortfolioEpochTransition", input);
    const snapshot = await ctx.validate("PortfolioSnapshot", value["snapshot"]);
    ctx.scoped(snapshot, scope);
    const stream = identifier(snapshot["streamId"]);
    const sourceContinuity = object(snapshot["continuity"]);
    if (
      scope.environment !== "paper" ||
      snapshot["sourceKind"] !== "paper-simulation" ||
      snapshot["sequence"] !== "1" ||
      sourceContinuity["state"] !== "continuous" ||
      sequence(snapshot["ownerEpoch"]) <= sequence(value["priorOwnerEpoch"])
    )
      fail("invalid");
    if (
      time(snapshot["receivedAt"]) > time(at) ||
      time(sourceContinuity["evaluatedAt"]) > time(at)
    )
      fail("invalid");
    const {
      sourceEventHash: _sourceEventHash,
      continuity: _continuity,
      ...genesisBody
    } = snapshot;
    const { highWaterEventHash: _highWaterEventHash, ...continuityBody } =
      sourceContinuity;
    if (
      (await ctx.hash({ ...genesisBody, continuity: continuityBody })) !==
      snapshot["sourceEventHash"]
    )
      fail("integrity");
    const transitionSha256 = await ctx.hash(value);
    const snapshotSha256 = await ctx.hash(snapshot);
    if ((await ctx.hash(value["snapshot"])) !== snapshotSha256)
      fail("integrity");
    const verifier = options.verifyNativeEpochTransition;
    if (typeof verifier !== "function") return fail("unavailable");
    const authority = async (): Promise<VertexVerifiedNativeApproval> => {
      const checkedAt = ctx.now();
      if (time(checkedAt) < time(at)) fail("stale");
      await ctx.authorize(principal, scope, null, stream, "project", checkedAt);
      await ctx.authorize(
        principal,
        scope,
        null,
        "owner-epoch-transition",
        "project",
        checkedAt
      );
      let verified: unknown;
      try {
        verified = await verifier({
          principal: ctx.capture(principal),
          scope: ctx.capture(scope),
          transition: ctx.capture(value),
          transitionSha256,
          now: checkedAt,
        });
      } catch {
        return fail("unavailable");
      }
      // Re-evaluate grants after the external verifier has returned too.
      const currentAt = ctx.now();
      if (time(currentAt) < time(checkedAt)) fail("stale");
      await ctx.authorize(principal, scope, null, stream, "project", currentAt);
      await ctx.authorize(
        principal,
        scope,
        null,
        "owner-epoch-transition",
        "project",
        currentAt
      );
      return captureVerifiedNativeApproval(ctx, verified, currentAt);
    };
    // Safe for the Worker callback: acquire the SAME fence in the existing
    // transaction, never open a nested transaction. Re-entrant for ctx.run.
    await ctx.authorize(principal, scope, null, stream, "project", at);
    await ctx.authorize(
      principal,
      scope,
      null,
      "owner-epoch-transition",
      "project",
      at
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
    );
    const initialApproval = await authority();
    const approvalBinding: VertexNativeApprovalBinding = {
      action: "owner-epoch-transition",
      requestId: identifier(value["transitionId"]),
      requestSha256: transitionSha256,
      streamId: stream,
      approvalBase64: string(value["approvalBase64"]),
    };
    const consumed = await audit.checkNativeApprovalInTransaction(
      tx,
      principal,
      scope,
      approvalBinding,
      initialApproval,
      ctx.now()
    );
    const expected = transitionColumns(
      value,
      snapshot,
      transitionSha256,
      snapshotSha256
    );
    const existing = await one(
      tx,
      "vertex_portfolio_epoch_transitions",
      scope,
      sql`transition_id = ${value["transitionId"]} or (stream_id = ${stream} and (owner_epoch = ${snapshot["ownerEpoch"]} or prior_owner_epoch = ${value["priorOwnerEpoch"]}))`
    );
    const head = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${stream}`
    );
    if (!head) return fail("stale");
    if (existing) {
      if (
        existing["transition_id"] !== value["transitionId"] ||
        existing["transition_sha256"] !== transitionSha256
      )
        fail("conflict");
      if ((await ctx.hash(existing["payload"])) !== transitionSha256)
        fail("integrity");
      await verifyStoredAuthorization(tx, scope, existing);
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (existing[key] !== expectedValue) fail("integrity");
      }
      const restored = await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`snapshot_id = ${snapshot["snapshotId"]}`
      );
      if (
        !restored ||
        restored["record_hash"] !== snapshotSha256 ||
        (await ctx.hash(restored["payload"])) !== snapshotSha256 ||
        restored["stream_id"] !== stream ||
        restored["owner_epoch"] !== snapshot["ownerEpoch"] ||
        restored["sequence"] !== "1" ||
        restored["source_event_hash"] !== snapshot["sourceEventHash"]
      )
        fail("integrity");
      if (
        sequence(head["owner_epoch"]) < sequence(snapshot["ownerEpoch"]) ||
        (head["owner_epoch"] === snapshot["ownerEpoch"] &&
          (sequence(head["high_water_sequence"]) < 1n ||
            (head["high_water_sequence"] === "1" &&
              head["high_water_event_hash"] !== snapshot["sourceEventHash"])))
      )
        fail("integrity");
      const currentApproval = await authority();
      assertSameNativeApproval(initialApproval, currentApproval);
      // Return the ACTUAL current high-water. A retry after later projections
      // or a subsequent transition cannot reset a head or rewrite any evidence.
      const result: VertexProjectionResult = {
        status: "duplicate",
        highWaterSequence: string(head["high_water_sequence"]),
        highWaterEventHash:
          head["high_water_event_hash"] === null
            ? null
            : string(head["high_water_event_hash"]),
      };
      await audit.recordNativeApprovalInTransaction(
        tx,
        principal,
        scope,
        approvalBinding,
        currentApproval,
        result,
        ctx.now()
      );
      return result;
    }
    // A consumed approval acknowledges only its already committed transition.
    // Missing lineage must never turn a duplicate nonce into another mutation.
    if (consumed === "duplicate") fail("integrity");
    if (
      head["owner_epoch"] !== value["priorOwnerEpoch"] ||
      head["high_water_sequence"] !== value["priorProjectionSequence"] ||
      head["high_water_event_hash"] !== value["priorProjectionHash"]
    )
      fail("conflict");
    if (
      head["last_occurred_at"] === null ||
      head["last_received_at"] === null ||
      time(snapshot["asOfAt"]) < time(head["last_occurred_at"]) ||
      time(snapshot["receivedAt"]) < time(head["last_received_at"])
    )
      fail("stale");
    // No unresolved order/native observations may be silently retired. This
    // stream-wide check also refuses a staged future epoch; native ACK evidence
    // is independently reconstructed by the verifier, not inferred from this.
    for (const table of [
      "vertex_execution_projections",
      "vertex_native_fact_projections",
    ]) {
      if (
        await one(
          tx,
          table,
          scope,
          sql`stream_id = ${stream} and (applied = false or owner_epoch = ${snapshot["ownerEpoch"]})`
        )
      )
        fail("conflict");
    }
    if (
      await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`snapshot_id = ${snapshot["snapshotId"]} or (stream_id = ${stream} and owner_epoch = ${snapshot["ownerEpoch"]})`
      )
    )
      fail("conflict");
    if (value["priorProjectionSequence"] === "1") {
      const prior = await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`stream_id = ${stream} and owner_epoch = ${value["priorOwnerEpoch"]} and sequence = '1'`
      );
      if (
        !prior ||
        prior["source_event_hash"] !== value["priorProjectionHash"] ||
        (await ctx.hash(prior["payload"])) !== prior["record_hash"]
      )
        fail("integrity");
      const priorSnapshot = object(requirePresent(prior, "prior")["payload"]);
      if (
        priorSnapshot["accountAlias"] !== scope.accountAlias ||
        priorSnapshot["environment"] !== scope.environment ||
        priorSnapshot["streamId"] !== stream ||
        priorSnapshot["ownerEpoch"] !== value["priorOwnerEpoch"] ||
        priorSnapshot["sequence"] !== "1" ||
        priorSnapshot["sourceEventHash"] !== value["priorProjectionHash"]
      )
        fail("integrity");
    } else if (
      !(await ingestion.findAppliedProjection(
        tx,
        scope,
        stream,
        value["priorOwnerEpoch"],
        value["priorProjectionSequence"],
        value["priorProjectionHash"]
      ))
    ) {
      fail("integrity");
    }
    const sourceMaxAgeMs = object(sourceContinuity["freshness"])["maxAgeMs"];
    if (
      typeof sourceMaxAgeMs !== "number" ||
      !Number.isSafeInteger(sourceMaxAgeMs) ||
      sourceMaxAgeMs < 0
    )
      fail("invalid");
    const expiresAtNs =
      time(snapshot["asOfAt"]) +
      BigInt(Math.min(sourceMaxAgeMs, ctx.maxProjectionAgeMs)) * 1_000_000n +
      1n;
    await persistPortfolioSnapshotRows(tx, scope, snapshot, snapshotSha256);
    await insert(tx, "vertex_portfolio_epoch_transitions", scope, {
      ...expected,
      authorization_kind: "direct",
      authorizing_replay_request_sha256: null,
      authorizing_signer_key_sha256: null,
      authorizing_approval_id: null,
      actor_id: principal.actorId,
      recorded_at: at,
      payload: value,
    });
    // Reconstruct current native authority again after normalized persistence.
    // Any revocation/fence change/denial throws and rolls back every row.
    const currentApproval = await authority();
    assertSameNativeApproval(initialApproval, currentApproval);
    const stale = time(ctx.now()) >= expiresAtNs;
    const changed = await rows(
      tx,
      sql`update vertex_projection_heads set owner_epoch = ${snapshot["ownerEpoch"]}, high_water_sequence = '1', high_water_event_hash = ${snapshot["sourceEventHash"]}, last_occurred_at = ${snapshot["asOfAt"]}, last_received_at = ${snapshot["receivedAt"]}, expires_at_ns = ${expiresAtNs.toString()}, state = ${stale ? "stale" : "continuous"}, received_sequence = null where ${scopeWhere(scope)} and stream_id = ${stream} and owner_epoch = ${value["priorOwnerEpoch"]} and high_water_sequence = ${value["priorProjectionSequence"]} and high_water_event_hash = ${value["priorProjectionHash"]} returning high_water_sequence`
    );
    if (changed.length !== 1) fail("conflict");
    const result: VertexProjectionResult = {
      status: stale ? "stale" : "applied",
      highWaterSequence: "1",
      highWaterEventHash: string(snapshot["sourceEventHash"]),
    };
    await audit.recordNativeApprovalInTransaction(
      tx,
      principal,
      scope,
      approvalBinding,
      currentApproval,
      result,
      ctx.now()
    );
    return result;
  };
  // Recovery of a retained ORIGINAL transition is ratified only by the current
  // native-outbox-replay approval. Historical approval bytes remain evidence;
  // this path never invokes the expired old approval as current authority.
  const restoreRetainedPortfolioEpochInTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    input: unknown,
    suppliedApproval: VertexVerifiedNativeApproval,
    at: string
  ): Promise<VertexProjectionResult | null> => {
    const replay = await ctx.validate("NativeOutboxReplay", input);
    const grant = object(replay["grant"]);
    if (
      replay["retainedEpochTransitionBase64"] === null &&
      grant["retainedEpochTransitionSha256"] === null
    )
      return null;
    const retained = canonicalRetainedRecord(
      ctx,
      replay["retainedEpochTransitionBase64"]
    );
    const retainedSha256 = await ctx.digest(retained.bytes);
    if (retainedSha256 !== digestString(grant["retainedEpochTransitionSha256"]))
      fail("integrity");
    const value = await ctx.validate(
      "PortfolioEpochTransition",
      retained.value
    );
    if ((await ctx.hash(value)) !== retainedSha256) fail("integrity");
    const snapshot = await ctx.validate("PortfolioSnapshot", value["snapshot"]);
    ctx.scoped(snapshot, scope);
    ctx.scoped(grant, scope);
    const stream = identifier(snapshot["streamId"]);
    const receipt = captureVerifiedNativeApproval(ctx, suppliedApproval, at);
    const { approvalBase64: _currentApproval, ...unsignedGrant } = grant;
    if (
      receipt.action !== "native-outbox-replay" ||
      receipt.subjectSha256 !== (await ctx.hash(unsignedGrant)) ||
      scope.environment !== "paper" ||
      grant["serviceActorId"] !== principal.actorId ||
      grant["streamId"] !== stream ||
      grant["startingSequence"] !== "0" ||
      grant["startingEventHash"] !== null ||
      grant["priorOwnerEpoch"] !== snapshot["ownerEpoch"] ||
      sequence(grant["currentOwnerEpoch"]) <=
        sequence(snapshot["ownerEpoch"]) ||
      value["journalIdentity"] !== grant["journalIdentity"] ||
      sequence(value["journalSequence"]) > sequence(grant["journalSequence"])
    )
      fail("denied");
    if (
      snapshot["sourceKind"] !== "paper-simulation" ||
      snapshot["sequence"] !== "1" ||
      sequence(snapshot["ownerEpoch"]) <= sequence(value["priorOwnerEpoch"])
    )
      fail("invalid");
    const sourceContinuity = object(snapshot["continuity"]);
    if (
      sourceContinuity["state"] !== "continuous" ||
      time(snapshot["receivedAt"]) > time(at) ||
      time(sourceContinuity["evaluatedAt"]) > time(at)
    )
      fail("invalid");
    const {
      sourceEventHash: _sourceEventHash,
      continuity: _continuity,
      ...genesisBody
    } = snapshot;
    const { highWaterEventHash: _highWaterEventHash, ...continuityBody } =
      sourceContinuity;
    if (
      (await ctx.hash({ ...genesisBody, continuity: continuityBody })) !==
      snapshot["sourceEventHash"]
    )
      fail("integrity");
    const first = object(array(replay["rows"], 64)[0]);
    const identity = object(array(grant["rows"], 64)[0]);
    const originalGenesis = canonicalRetainedRecord(
      ctx,
      first["projectionBase64"]
    );
    const snapshotSha256 = await ctx.hash(snapshot);
    if (
      first["kind"] !== "portfolio-genesis" ||
      first["proofBase64"] !== null ||
      identity["kind"] !== "portfolio-genesis" ||
      identity["sequence"] !== "1" ||
      identity["projectionId"] !== snapshot["snapshotId"] ||
      identity["eventHash"] !== snapshot["sourceEventHash"] ||
      identity["proofSha256"] !== null ||
      (await ctx.digest(originalGenesis.bytes)) !==
        identity["projectionRawSha256"] ||
      (await ctx.hash(originalGenesis.value)) !== snapshotSha256 ||
      (await ctx.hash(value["snapshot"])) !== snapshotSha256
    )
      fail("integrity");
    const current = ctx.now();
    if (
      time(current) < time(at) ||
      time(grant["issuedAt"]) > time(current) ||
      time(grant["expiresAt"]) <= time(current)
    )
      fail("stale");
    await ctx.authorize(principal, scope, null, stream, "project", current);
    await ctx.authorize(
      principal,
      scope,
      null,
      "native-outbox-replay",
      "project",
      current
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
    );
    const binding: VertexNativeApprovalBinding = {
      action: "native-outbox-replay",
      requestId: identifier(grant["grantId"]),
      requestSha256: await ctx.hash(replay),
      streamId: stream,
      approvalBase64: string(grant["approvalBase64"]),
    };
    const consumed = await audit.checkNativeApprovalInTransaction(
      tx,
      principal,
      scope,
      binding,
      receipt,
      ctx.now()
    );
    const expected = transitionColumns(
      value,
      snapshot,
      retainedSha256,
      snapshotSha256
    );
    const existing = await one(
      tx,
      "vertex_portfolio_epoch_transitions",
      scope,
      sql`transition_id = ${value["transitionId"]} or (stream_id = ${stream} and (owner_epoch = ${snapshot["ownerEpoch"]} or prior_owner_epoch = ${value["priorOwnerEpoch"]}))`
    );
    const head = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${stream}`
    );
    if (!head) return fail("stale");
    if (existing) {
      if (
        existing["transition_id"] !== value["transitionId"] ||
        existing["transition_sha256"] !== retainedSha256 ||
        (await ctx.hash(existing["payload"])) !== retainedSha256
      )
        fail("conflict");
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (existing[key] !== expectedValue) fail("integrity");
      }
      await verifyStoredAuthorization(tx, scope, existing);
      const restored = await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`snapshot_id = ${snapshot["snapshotId"]}`
      );
      if (
        !restored ||
        restored["record_hash"] !== snapshotSha256 ||
        (await ctx.hash(restored["payload"])) !== snapshotSha256 ||
        restored["stream_id"] !== stream ||
        restored["owner_epoch"] !== snapshot["ownerEpoch"] ||
        restored["sequence"] !== "1" ||
        restored["source_event_hash"] !== snapshot["sourceEventHash"]
      )
        fail("integrity");
      if (
        sequence(head["owner_epoch"]) < sequence(snapshot["ownerEpoch"]) ||
        (head["owner_epoch"] === snapshot["ownerEpoch"] &&
          (sequence(head["high_water_sequence"]) < 1n ||
            (head["high_water_sequence"] === "1" &&
              head["high_water_event_hash"] !== snapshot["sourceEventHash"])))
      )
        fail("integrity");
      return {
        status: "duplicate",
        highWaterSequence: string(head["high_water_sequence"]),
        highWaterEventHash:
          head["high_water_event_hash"] === null
            ? null
            : string(head["high_water_event_hash"]),
      };
    }
    if (consumed === "duplicate") fail("integrity");
    if (
      head["owner_epoch"] !== value["priorOwnerEpoch"] ||
      head["high_water_sequence"] !== value["priorProjectionSequence"] ||
      head["high_water_event_hash"] !== value["priorProjectionHash"]
    )
      fail("conflict");
    if (
      head["last_occurred_at"] === null ||
      head["last_received_at"] === null ||
      time(snapshot["asOfAt"]) < time(head["last_occurred_at"]) ||
      time(snapshot["receivedAt"]) < time(head["last_received_at"])
    )
      fail("stale");
    for (const table of [
      "vertex_execution_projections",
      "vertex_native_fact_projections",
    ]) {
      if (
        await one(
          tx,
          table,
          scope,
          sql`stream_id = ${stream} and (applied = false or owner_epoch = ${snapshot["ownerEpoch"]})`
        )
      )
        fail("conflict");
    }
    if (
      await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`snapshot_id = ${snapshot["snapshotId"]} or (stream_id = ${stream} and owner_epoch = ${snapshot["ownerEpoch"]})`
      )
    )
      fail("conflict");
    if (value["priorProjectionSequence"] === "1") {
      const prior = await one(
        tx,
        "vertex_portfolio_snapshots",
        scope,
        sql`stream_id = ${stream} and owner_epoch = ${value["priorOwnerEpoch"]} and sequence = '1'`
      );
      if (
        !prior ||
        prior["source_event_hash"] !== value["priorProjectionHash"] ||
        (await ctx.hash(prior["payload"])) !== prior["record_hash"]
      )
        fail("integrity");
      const priorSnapshot = object(requirePresent(prior, "prior")["payload"]);
      if (
        priorSnapshot["accountAlias"] !== scope.accountAlias ||
        priorSnapshot["environment"] !== scope.environment ||
        priorSnapshot["streamId"] !== stream ||
        priorSnapshot["ownerEpoch"] !== value["priorOwnerEpoch"] ||
        priorSnapshot["sequence"] !== "1" ||
        priorSnapshot["sourceEventHash"] !== value["priorProjectionHash"]
      )
        fail("integrity");
    } else if (
      !(await ingestion.findAppliedProjection(
        tx,
        scope,
        stream,
        value["priorOwnerEpoch"],
        value["priorProjectionSequence"],
        value["priorProjectionHash"]
      ))
    ) {
      fail("integrity");
    }
    const sourceMaxAgeMs = object(sourceContinuity["freshness"])["maxAgeMs"];
    if (
      typeof sourceMaxAgeMs !== "number" ||
      !Number.isSafeInteger(sourceMaxAgeMs) ||
      sourceMaxAgeMs < 0
    )
      fail("invalid");
    const expiresAtNs =
      time(snapshot["asOfAt"]) +
      BigInt(Math.min(sourceMaxAgeMs, ctx.maxProjectionAgeMs)) * 1_000_000n +
      1n;
    await persistPortfolioSnapshotRows(tx, scope, snapshot, snapshotSha256);
    await insert(tx, "vertex_portfolio_epoch_transitions", scope, {
      ...expected,
      authorization_kind: "retained-replay",
      authorizing_replay_request_sha256: binding.requestSha256,
      authorizing_signer_key_sha256: receipt.signerKeySha256,
      authorizing_approval_id: receipt.approvalId,
      actor_id: principal.actorId,
      recorded_at: at,
      payload: value,
    });
    const committingAt = ctx.now();
    captureVerifiedNativeApproval(ctx, receipt, committingAt);
    if (
      time(committingAt) < time(current) ||
      time(grant["expiresAt"]) <= time(committingAt)
    )
      fail("stale");
    await ctx.authorize(
      principal,
      scope,
      null,
      stream,
      "project",
      committingAt
    );
    await ctx.authorize(
      principal,
      scope,
      null,
      "native-outbox-replay",
      "project",
      committingAt
    );
    const stale = time(committingAt) >= expiresAtNs;
    const changed = await rows(
      tx,
      sql`update vertex_projection_heads set owner_epoch = ${snapshot["ownerEpoch"]}, high_water_sequence = '1', high_water_event_hash = ${snapshot["sourceEventHash"]}, last_occurred_at = ${snapshot["asOfAt"]}, last_received_at = ${snapshot["receivedAt"]}, expires_at_ns = ${expiresAtNs.toString()}, state = ${stale ? "stale" : "continuous"}, received_sequence = null where ${scopeWhere(scope)} and stream_id = ${stream} and owner_epoch = ${value["priorOwnerEpoch"]} and high_water_sequence = ${value["priorProjectionSequence"]} and high_water_event_hash = ${value["priorProjectionHash"]} returning high_water_sequence`
    );
    if (changed.length !== 1) fail("conflict");
    // The caller MUST complete replay, reverify CURRENT native authority and
    // insert its shared audit last. The deferred exact-triple FK makes missing
    // audit consumption fail the enclosing commit, not silently grant recovery.
    return {
      status: stale ? "stale" : "applied",
      highWaterSequence: "1",
      highWaterEventHash: string(snapshot["sourceEventHash"]),
    };
  };
  const transitionPortfolioEpoch = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    input: unknown
  ): Promise<VertexProjectionResult> => {
    const value = await ctx.validate("PortfolioEpochTransition", input);
    return ctx.run(
      principal,
      scope,
      null,
      identifier(object(value["snapshot"])["streamId"]),
      "project",
      (tx, at) =>
        transitionPortfolioEpochInTransaction(tx, principal, scope, value, at)
    );
  };
  return {
    transitionPortfolioEpoch,
    transitionPortfolioEpochInTransaction,
    restoreRetainedPortfolioEpochInTransaction,
  };
};
