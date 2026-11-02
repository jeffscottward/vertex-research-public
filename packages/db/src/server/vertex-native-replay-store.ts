import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import { createEpochTransitionOperations } from "./vertex-epoch-store.ts";
import {
  assertSameNativeApproval,
  captureVerifiedNativeApproval,
  createNativeApprovalAuditOperations,
  type VertexVerifiedNativeApproval,
} from "./vertex-native-approval-audit.ts";
import { createNativeFactOperations } from "./vertex-native-fact-store.ts";
import {
  array,
  fail,
  identifier,
  object,
  one,
  type PersistenceContext,
  type Row,
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
import { createProjectionOperations } from "./vertex-projection-store.ts";

// A trusted read-only, idempotent composition port, never a request permission.
// Resolve persisted native journal/outbox/fence evidence and currently enrolled
// human approval independently. Worker bearer authority is not human approval.
// replaySha256 is the signed subject: canonical grant excluding ONLY approvalBase64.
// The concrete closure captures the caller's transaction; this port owns no commit.
export type VertexNativeOutboxReplayVerifier = (
  input: Readonly<{
    principal: VertexPrincipal;
    scope: VertexScope;
    replay: VertexRecord;
    replaySha256: string;
    now: string;
  }>
) => Promise<VertexVerifiedNativeApproval | null>;
export type VertexNativeOutboxReplayOptions = Readonly<{
  verifyNativeOutboxReplay?: VertexNativeOutboxReplayVerifier;
}>;
type ReplayKind =
  | "portfolio-genesis"
  | "portfolio-snapshot"
  | "order"
  | "native-fact";
type ReplayRow = Readonly<{
  kind: ReplayKind;
  identity: VertexRecord;
  value: VertexRecord;
  bytes: Uint8Array;
  proofBytes: Uint8Array | null;
  proof: VertexRecord | null;
}>;
const MAX_BLOB_BYTES = 1_048_576;
const MAX_DECODED_BYTES = 8_388_608;
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength &&
  a.every((value, index) => value === b[index]);
const base64Bytes = (input: unknown): Uint8Array => {
  const value = string(input);
  if (
    value.length < 4 ||
    value.length > 1_398_104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  )
    return fail("invalid");
  try {
    const decoded = atob(value);
    if (
      decoded.length === 0 ||
      decoded.length > MAX_BLOB_BYTES ||
      btoa(decoded) !== value
    )
      return fail("invalid");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return fail("invalid");
  }
};
const decode = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    ) as unknown;
  } catch {
    return fail("invalid");
  }
};
const result = (
  head: Row,
  status: "applied" | "duplicate"
): VertexProjectionResult => ({
  status,
  highWaterSequence: string(head["high_water_sequence"]),
  highWaterEventHash:
    head["high_water_event_hash"] === null
      ? null
      : string(head["high_water_event_hash"]),
});

export const createNativeOutboxReplayOperations = (
  ctx: PersistenceContext,
  options: VertexNativeOutboxReplayOptions = {}
) => {
  const prepare = async (
    input: unknown,
    principal: VertexPrincipal,
    scope: VertexScope,
    at: string
  ) => {
    const captured = ctx.capture(input);
    const replay = await ctx.validate("NativeOutboxReplay", captured);
    if (!sameBytes(ctx.encode(captured), ctx.encode(replay))) fail("integrity");
    const grant = await ctx.validate(
      "NativeOutboxReplayGrant",
      replay["grant"]
    );
    ctx.scoped(grant, scope);
    if (
      scope.environment !== "paper" ||
      grant["serviceActorId"] !== principal.actorId
    )
      fail("denied");
    if (
      sequence(grant["currentOwnerEpoch"]) <= sequence(grant["priorOwnerEpoch"])
    )
      fail("invalid");
    const stream = identifier(grant["streamId"]);
    const identities = array(grant["rows"], 64).map(object);
    const packetRows = array(replay["rows"], 64).map(object);
    if (identities.length === 0 || identities.length !== packetRows.length)
      fail("invalid");
    const retainedBytes =
      replay["retainedEpochTransitionBase64"] === null
        ? null
        : base64Bytes(replay["retainedEpochTransitionBase64"]);
    if (
      (retainedBytes === null) !==
      (grant["retainedEpochTransitionSha256"] === null)
    )
      fail("invalid");
    let total =
      base64Bytes(grant["approvalBase64"]).byteLength +
      (retainedBytes?.byteLength ?? 0);
    let previousSequence = sequence(grant["startingSequence"]);
    let previousHash = grant["startingEventHash"];
    if ((previousSequence === 0n) !== (previousHash === null)) fail("invalid");
    const prepared: ReplayRow[] = [];
    for (const [index, packet] of packetRows.entries()) {
      const identity = requirePresent(identities[index], "identities[index]");
      const kind = packet["kind"] as ReplayKind;
      if (
        ![
          "portfolio-genesis",
          "portfolio-snapshot",
          "order",
          "native-fact",
        ].includes(kind) ||
        kind !== identity["kind"]
      )
        fail("invalid");
      const bytes = base64Bytes(packet["projectionBase64"]);
      const proofBytes =
        packet["proofBase64"] === null
          ? null
          : base64Bytes(packet["proofBase64"]);
      total += bytes.byteLength + (proofBytes?.byteLength ?? 0);
      if (
        total > MAX_DECODED_BYTES ||
        (kind === "native-fact") !== (proofBytes !== null) ||
        (kind === "native-fact") !== (identity["proofSha256"] !== null)
      )
        fail("invalid");
      if ((await ctx.digest(bytes)) !== identity["projectionRawSha256"])
        fail("integrity");
      const decoded = decode(bytes);
      if (!sameBytes(ctx.encode(decoded), bytes)) fail("invalid");
      const value = await ctx.validate(
        kind === "native-fact"
          ? "NativeFactProjection"
          : kind === "order"
            ? "ExecutionProjection"
            : "PortfolioSnapshot",
        decoded
      );
      if (!sameBytes(ctx.encode(value), bytes)) fail("integrity");
      ctx.scoped(value, scope);
      if (
        value["accountAlias"] !== grant["accountAlias"] ||
        value["environment"] !== "paper" ||
        value["streamId"] !== stream ||
        value["ownerEpoch"] !== grant["priorOwnerEpoch"] ||
        value["sequence"] !== identity["sequence"] ||
        value["sourceKind"] !== "paper-simulation"
      )
        fail("denied");
      const occurredAt =
        kind === "order" || kind === "native-fact"
          ? value["occurredAt"]
          : value["asOfAt"];
      if (
        time(occurredAt) > time(value["receivedAt"]) ||
        time(value["receivedAt"]) > time(at) ||
        time(value["receivedAt"]) > time(grant["issuedAt"])
      )
        fail("invalid");
      if (kind === "portfolio-snapshot") {
        if (
          previousSequence === 0n ||
          sequence(value["sequence"]) !== previousSequence ||
          value["sourceEventHash"] !== previousHash
        )
          fail("integrity");
      } else if (
        sequence(value["sequence"]) !== previousSequence + 1n ||
        (kind === "portfolio-genesis" && previousSequence !== 0n) ||
        (previousSequence === 0n && kind !== "portfolio-genesis")
      )
        fail("integrity");
      if (kind === "order" || kind === "native-fact") {
        if (value["actorId"] !== grant["serviceActorId"]) fail("denied");
        const { eventHash, ...body } = value;
        if (
          value["projectionId"] !== identity["projectionId"] ||
          eventHash !== identity["eventHash"] ||
          value["previousEventHash"] !== previousHash ||
          (await ctx.hash(body)) !== eventHash
        )
          fail("integrity");
        if (
          kind === "order" &&
          time(object(value["receipt"])["lastReconciledAt"]) >
            time(value["receivedAt"])
        )
          fail("invalid");
      } else {
        if (
          value["snapshotId"] !== identity["projectionId"] ||
          value["sourceEventHash"] !== identity["eventHash"]
        )
          fail("integrity");
        const continuity = object(value["continuity"]);
        if (
          time(continuity["evaluatedAt"]) > time(at) ||
          time(continuity["evaluatedAt"]) > time(grant["issuedAt"])
        )
          fail("invalid");
        if (kind === "portfolio-genesis") {
          const {
            sourceEventHash: _eventHash,
            continuity: _continuity,
            ...body
          } = value;
          const { highWaterEventHash: _highWaterHash, ...continuityBody } =
            continuity;
          if (
            value["sequence"] !== "1" ||
            continuity["state"] !== "continuous" ||
            (await ctx.hash({ ...body, continuity: continuityBody })) !==
              value["sourceEventHash"]
          )
            fail("integrity");
        }
      }
      let proof: VertexRecord | null = null;
      if (proofBytes) {
        if ((await ctx.digest(proofBytes)) !== identity["proofSha256"])
          fail("integrity");
        const decodedProof = decode(proofBytes);
        if (!sameBytes(ctx.encode(decodedProof), proofBytes)) fail("invalid");
        proof = await ctx.validate("NativeJournalProof", decodedProof);
        if (!sameBytes(ctx.encode(proof), proofBytes)) fail("integrity");
        const reference = object(value["proof"]);
        const fact = object(value["fact"]);
        if (
          reference["sha256"] !== identity["proofSha256"] ||
          proof["accountAlias"] !== value["accountAlias"] ||
          proof["environment"] !== value["environment"] ||
          proof["streamId"] !== value["streamId"] ||
          proof["ownerEpoch"] !== value["ownerEpoch"] ||
          proof["sourceEventId"] !== reference["sourceEventId"] ||
          proof["occurredAt"] !== value["occurredAt"] ||
          proof["eventType"] !== fact["kind"] ||
          !sameBytes(ctx.encode(proof["payload"]), ctx.encode(fact))
        )
          fail("integrity");
        if (
          proof["journalSequence"] !== value["proofJournalSequence"] ||
          proof["journalHeadHash"] !== value["proofJournalHeadHash"] ||
          proof["factOrdinal"] !== value["factOrdinal"] ||
          sequence(proof["journalSequence"]) >
            sequence(grant["journalSequence"])
        )
          fail("integrity");
        if (
          fact["kind"] === "checkpoint" &&
          (fact["journalSequence"] !== proof["journalSequence"] ||
            fact["journalHeadHash"] !== proof["journalHeadHash"])
        )
          fail("integrity");
      }
      prepared.push({ kind, identity, value, bytes, proofBytes, proof });
      if (kind !== "portfolio-snapshot") {
        previousSequence = sequence(identity["sequence"]);
        previousHash = identity["eventHash"];
      }
    }
    if (retainedBytes) {
      if (
        grant["startingSequence"] !== "0" ||
        grant["startingEventHash"] !== null ||
        requirePresent(prepared[0], "prepared[0]").kind !== "portfolio-genesis"
      )
        fail("invalid");
      if (
        (await ctx.digest(retainedBytes)) !==
        grant["retainedEpochTransitionSha256"]
      )
        fail("integrity");
      const decoded = decode(retainedBytes);
      if (!sameBytes(ctx.encode(decoded), retainedBytes)) fail("invalid");
      const retained = await ctx.validate("PortfolioEpochTransition", decoded);
      if (
        !(
          sameBytes(ctx.encode(retained), retainedBytes) &&
          sameBytes(
            ctx.encode(retained["snapshot"]),
            requirePresent(prepared[0], "prepared[0]").bytes
          )
        )
      )
        fail("integrity");
      // Original signed provenance, not current authority. The current replay
      // verifier ratifies these exact bytes and checks historical revocation.
      if (
        object(retained["snapshot"])["ownerEpoch"] !== grant["priorOwnerEpoch"]
      )
        fail("integrity");
    }
    const { approvalBase64: _approval, ...subject } = grant;
    return {
      replay,
      grant,
      stream,
      prepared,
      replaySha256: await ctx.hash(subject),
      terminalSequence: previousSequence.toString(),
      terminalHash: previousHash,
    };
  };

  const known = async (
    tx: Transaction,
    scope: VertexScope,
    row: ReplayRow
  ): Promise<boolean> => {
    const { kind, value, bytes, identity } = row;
    const snapshot =
      kind === "portfolio-genesis" || kind === "portfolio-snapshot";
    const table = snapshot
      ? "vertex_portfolio_snapshots"
      : kind === "order"
        ? "vertex_execution_projections"
        : "vertex_native_fact_projections";
    const where = snapshot
      ? sql`snapshot_id = ${value["snapshotId"]} or (stream_id = ${value["streamId"]} and owner_epoch = ${value["ownerEpoch"]} and sequence = ${value["sequence"]})`
      : sql`projection_id = ${value["projectionId"]} or (stream_id = ${value["streamId"]} and ((owner_epoch = ${value["ownerEpoch"]} and sequence = ${value["sequence"]}) or idempotency_key = ${value["idempotencyKey"]}))`;
    if (
      !snapshot &&
      (await one(
        tx,
        kind === "order"
          ? "vertex_native_fact_projections"
          : "vertex_execution_projections",
        scope,
        where
      ))
    )
      fail("conflict");
    const stored = await one(tx, table, scope, where);
    if (!stored) return false;
    if (
      !sameBytes(ctx.encode(stored["payload"]), bytes) ||
      (await ctx.digest(ctx.encode(stored["payload"]))) !==
        identity["projectionRawSha256"]
    )
      fail("conflict");
    if (
      stored["stream_id"] !== value["streamId"] ||
      stored["owner_epoch"] !== value["ownerEpoch"] ||
      stored["sequence"] !== value["sequence"]
    )
      fail("integrity");
    if (snapshot) {
      if (
        stored["snapshot_id"] !== value["snapshotId"] ||
        stored["source_event_hash"] !== value["sourceEventHash"] ||
        stored["record_hash"] !== identity["projectionRawSha256"] ||
        stored["source_kind"] !== value["sourceKind"] ||
        stored["as_of_at_ns"] !== time(value["asOfAt"]).toString() ||
        stored["received_at_ns"] !== time(value["receivedAt"]).toString()
      )
        fail("integrity");
      return true;
    }
    if (
      stored["projection_id"] !== value["projectionId"] ||
      stored["event_hash"] !== value["eventHash"] ||
      stored["previous_event_hash"] !== value["previousEventHash"] ||
      stored["idempotency_key"] !== value["idempotencyKey"] ||
      stored["occurred_at"] !== value["occurredAt"] ||
      stored["received_at"] !== value["receivedAt"] ||
      stored["expires_at_ns"] !== time(value["expiresAt"]).toString() ||
      typeof stored["applied"] !== "boolean"
    )
      fail("integrity");
    if (kind === "native-fact") {
      const proof = requirePresent(row.proof, "row.proof");
      const reference = object(value["proof"]);
      const expected = {
        fact_kind: object(value["fact"])["kind"],
        proof_artifact_id: reference["artifactId"],
        proof_sha256: reference["sha256"],
        proof_source_event_id: reference["sourceEventId"],
        proof_journal_sequence: value["proofJournalSequence"],
        proof_journal_head_hash: value["proofJournalHeadHash"],
        fact_ordinal: value["factOrdinal"],
        authoritative: false,
        execution_authorized: false,
      };
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (stored[key] !== expectedValue) fail("integrity");
      }
      const retained = await one(
        tx,
        "vertex_native_journal_proofs",
        scope,
        sql`artifact_id = ${reference["artifactId"]}`
      );
      if (
        !retained ||
        retained["sha256"] !== identity["proofSha256"] ||
        String(retained["byte_length"]) !==
          requirePresent(
            row.proofBytes,
            "row.proofBytes"
          ).byteLength.toString() ||
        !sameBytes(
          new TextEncoder().encode(string(retained["canonical_json"])),
          requirePresent(row.proofBytes, "row.proofBytes")
        ) ||
        !sameBytes(
          ctx.encode(retained["payload"]),
          requirePresent(row.proofBytes, "row.proofBytes")
        )
      )
        fail("integrity");
      const proofColumns = {
        stream_id: proof["streamId"],
        owner_epoch: proof["ownerEpoch"],
        source_event_id: proof["sourceEventId"],
        occurred_at: proof["occurredAt"],
        event_type: proof["eventType"],
        journal_sequence: proof["journalSequence"],
        journal_head_hash: proof["journalHeadHash"],
        fact_ordinal: proof["factOrdinal"],
      };
      for (const [key, expectedValue] of Object.entries(proofColumns)) {
        if (requirePresent(retained, "retained")[key] !== expectedValue)
          fail("integrity");
      }
    }
    return stored["applied"] === true;
  };

  const replayNativeOutboxInTransaction = async (
    tx: Transaction,
    caller: VertexPrincipal,
    requestedScope: VertexScope,
    input: unknown,
    at: string
  ): Promise<VertexProjectionResult> => {
    const principal = ctx.capture(caller);
    const scope = ctx.capture(requestedScope);
    time(at);
    const verifier = options.verifyNativeOutboxReplay;
    if (typeof verifier !== "function") return fail("unavailable");
    const batch = await prepare(input, principal, scope, at);
    const { replay, grant, stream, prepared, replaySha256 } = batch;
    let lastCheckedAt = at;
    const currentAuthority = async (): Promise<string> => {
      const currentAt = ctx.now();
      if (time(currentAt) < time(lastCheckedAt)) fail("stale");
      if (time(grant["issuedAt"]) > time(currentAt)) fail("invalid");
      if (time(currentAt) >= time(grant["expiresAt"])) fail("denied");
      lastCheckedAt = currentAt;
      await ctx.authorize(principal, scope, null, stream, "project", currentAt);
      await ctx.authorize(
        principal,
        scope,
        null,
        "native-outbox-replay",
        "project",
        currentAt
      );
      return currentAt;
    };
    const authority = async (): Promise<VertexVerifiedNativeApproval> => {
      const now = await currentAuthority();
      let verified: VertexVerifiedNativeApproval | null;
      try {
        verified = await verifier({
          principal: ctx.capture(principal),
          scope: ctx.capture(scope),
          replay: ctx.capture(replay),
          replaySha256,
          now,
        });
      } catch {
        return fail("unavailable");
      }
      // Legacy boolean permission is deliberately not a verified signer receipt.
      if (!verified || typeof verified !== "object" || Array.isArray(verified))
        return fail("denied");
      const receipt = captureVerifiedNativeApproval(ctx, verified, now);
      if (
        receipt.action !== "native-outbox-replay" ||
        receipt.subjectSha256 !== replaySha256 ||
        receipt.approvalId !== grant["grantId"] ||
        time(receipt.expiresAt) !== time(grant["expiresAt"])
      )
        fail("integrity");
      await currentAuthority();
      return receipt;
    };
    await currentAuthority();
    // Re-entrant in the worker's existing account fence. Never db.transaction.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
    );
    const initialApproval = await authority();
    const audit = createNativeApprovalAuditOperations(ctx);
    const binding = {
      action: "native-outbox-replay" as const,
      requestId: identifier(grant["grantId"]),
      requestSha256: await ctx.hash(replay),
      streamId: stream,
      approvalBase64: string(grant["approvalBase64"]),
    };
    const priorApproval = await audit.checkNativeApprovalInTransaction(
      tx,
      principal,
      scope,
      binding,
      initialApproval,
      lastCheckedAt
    );
    // Recover only an explicitly retained original transition ratified by the
    // CURRENT replay approval. The helper owns exact prior-head CAS/history and
    // independently derives consumed-approval ACK-only behavior in this tx.
    const restored = await createEpochTransitionOperations(
      ctx
    ).restoreRetainedPortfolioEpochInTransaction(
      tx,
      principal,
      scope,
      replay,
      initialApproval,
      lastCheckedAt
    );
    const head = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${stream}`
    );
    let expectedSequence = string(grant["startingSequence"]);
    let expectedHash = grant["startingEventHash"];
    let missing = false;
    const applied: boolean[] = [];
    for (const row of prepared) {
      const exists = await known(tx, scope, row);
      applied.push(exists);
      if (exists) {
        // A missing snapshot before a later applied event is NOT a listed
        // committed prefix; never reconstruct old holdings behind a new head.
        if (missing) fail("conflict");
        if (row.kind !== "portfolio-snapshot") {
          expectedSequence = string(row.identity["sequence"]);
          expectedHash = row.identity["eventHash"];
        }
      } else {
        missing = true;
      }
    }
    if (!missing) {
      if (
        !head ||
        sequence(head["owner_epoch"]) < sequence(grant["priorOwnerEpoch"]) ||
        sequence(head["owner_epoch"]) > sequence(grant["currentOwnerEpoch"])
      )
        fail("stale");
      if (
        head["owner_epoch"] === grant["priorOwnerEpoch"] &&
        (sequence(head["high_water_sequence"]) <
          sequence(batch.terminalSequence) ||
          (head["high_water_sequence"] === batch.terminalSequence &&
            head["high_water_event_hash"] !== batch.terminalHash))
      )
        fail("integrity");
      // A fully known old batch is an inert retry even after a transition. Its
      // historical bytes/proofs and current independent permission still match.
      const finalApproval = await authority();
      assertSameNativeApproval(initialApproval, finalApproval);
      const outcome = result(
        requirePresent(head, "head"),
        restored !== null && restored.status !== "duplicate"
          ? "applied"
          : "duplicate"
      );
      await audit.recordNativeApprovalInTransaction(
        tx,
        principal,
        scope,
        binding,
        finalApproval,
        outcome,
        lastCheckedAt
      );
      await currentAuthority();
      return outcome;
    }
    // A consumed exact approval is ACK-only. Missing history must not allow the
    // same signed grant to apply again after storage loss or partial tampering.
    if (priorApproval === "duplicate") fail("conflict");
    if (head) {
      if (head["owner_epoch"] !== grant["priorOwnerEpoch"]) fail("stale");
      if (
        head["high_water_sequence"] !== expectedSequence ||
        head["high_water_event_hash"] !== expectedHash
      )
        fail("conflict");
    } else if (
      expectedSequence !== "0" ||
      expectedHash !== null ||
      applied.some(Boolean) ||
      requirePresent(prepared[0], "prepared[0]").kind !== "portfolio-genesis"
    ) {
      fail("stale");
    }
    const boundRun: PersistenceContext["run"] = async (
      boundPrincipal,
      boundScope,
      collection,
      resource,
      action,
      operation,
      command = false
    ) => {
      if (
        boundPrincipal.actorId !== principal.actorId ||
        boundScope.accountAlias !== scope.accountAlias ||
        boundScope.environment !== scope.environment ||
        collection !== null ||
        resource !== stream ||
        action !== "project" ||
        command
      )
        fail("denied");
      const currentAt = await currentAuthority();
      return operation(tx, currentAt);
    };
    const bound: PersistenceContext = { ...ctx, run: boundRun };
    const projections = createProjectionOperations(bound);
    const facts = createNativeFactOperations(bound);
    for (const [index, row] of prepared.entries()) {
      if (applied[index]) continue;
      if (
        row.kind === "portfolio-genesis" ||
        row.kind === "portfolio-snapshot"
      ) {
        // The independent verifier proved this exact retained original row and
        // original capital provenance; this is not ordinary bootstrap authority.
        await projections.recordPortfolioSnapshot(principal, scope, row.value);
      } else {
        const appended =
          row.kind === "order"
            ? await projections.appendExecutionProjection(
                principal,
                scope,
                row.value
              )
            : await facts.appendNativeFactProjection(
                principal,
                scope,
                row.value,
                requirePresent(row.proofBytes, "row.proofBytes")
              );
        if (!["applied", "stale", "duplicate"].includes(appended.status))
          fail("conflict");
      }
    }
    const finalHead = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${stream}`
    );
    if (
      !finalHead ||
      finalHead["owner_epoch"] !== grant["priorOwnerEpoch"] ||
      finalHead["high_water_sequence"] !== batch.terminalSequence ||
      finalHead["high_water_event_hash"] !== batch.terminalHash
    )
      fail("conflict");
    const finalApproval = await authority();
    assertSameNativeApproval(initialApproval, finalApproval);
    // Applied denotes the whole batch, not freshness or risk authority. The
    // original append path keeps historical head freshness and inhibition.
    const outcome = result(requirePresent(finalHead, "finalHead"), "applied");
    await audit.recordNativeApprovalInTransaction(
      tx,
      principal,
      scope,
      binding,
      finalApproval,
      outcome,
      lastCheckedAt
    );
    await currentAuthority();
    return outcome;
  };
  const replayNativeOutbox = async (
    caller: VertexPrincipal,
    requestedScope: VertexScope,
    input: unknown
  ): Promise<VertexProjectionResult> => {
    const principal = ctx.capture(caller);
    const scope = ctx.capture(requestedScope);
    const replay = ctx.capture(input);
    const stream = identifier(object(object(replay)["grant"])["streamId"]);
    return await ctx.run(principal, scope, null, stream, "project", (tx, at) =>
      replayNativeOutboxInTransaction(tx, principal, scope, replay, at)
    );
  };
  return { replayNativeOutbox, replayNativeOutboxInTransaction };
};
