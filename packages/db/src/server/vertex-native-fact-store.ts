import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import {
  array,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type { VertexRecord, VertexScope, VertexStore } from "./vertex-ports.ts";
import { createProjectionIngestion } from "./vertex-projection-ingestion.ts";

// The public validator is injected. This module never imports API runtime code,
// reads a provider, expires historical admissions or allocates buying power.
const MAX_PROOF_BYTES = 1_048_576;
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);
const captureProof = (input: Uint8Array): Uint8Array => {
  try {
    if (
      !(input instanceof Uint8Array) ||
      Object.getPrototypeOf(input) !== Uint8Array.prototype ||
      Object.hasOwn(input, "buffer") ||
      Object.hasOwn(input, "byteLength") ||
      Object.hasOwn(input, "length") ||
      Object.hasOwn(input, "byteOffset") ||
      !(input.buffer instanceof ArrayBuffer) ||
      input.byteLength === 0 ||
      input.byteLength > MAX_PROOF_BYTES
    )
      return fail("invalid");
    const bytes = new Uint8Array(input.byteLength);
    Uint8Array.prototype.set.call(bytes, input);
    return bytes;
  } catch {
    return fail("invalid");
  }
};
const decodeProof = (
  bytes: Uint8Array
): Readonly<{ text: string; decoded: unknown }> => {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { text, decoded: JSON.parse(text) as unknown };
  } catch {
    return fail("invalid");
  }
};

export const createNativeFactOperations = (ctx: PersistenceContext) => {
  const ingestion = createProjectionIngestion(ctx);
  const retainProof = async (
    tx: Transaction,
    scope: VertexScope,
    value: VertexRecord,
    proof: VertexRecord,
    bytes: Uint8Array,
    text: string
  ): Promise<void> => {
    const reference = object(value["proof"]);
    const prior = await one(
      tx,
      "vertex_native_journal_proofs",
      scope,
      sql`artifact_id = ${reference["artifactId"]}`
    );
    if (prior) {
      // Catalog identity, exact canonical bytes and independent raw-byte hash
      // must all agree. A valid caller digest alone cannot relabel stored proof.
      if (
        prior["artifact_id"] !== reference["artifactId"] ||
        prior["sha256"] !== reference["sha256"] ||
        prior["canonical_json"] !== text ||
        String(prior["byte_length"]) !== bytes.byteLength.toString()
      )
        fail("conflict");
      if (
        prior["stream_id"] !== proof["streamId"] ||
        prior["owner_epoch"] !== proof["ownerEpoch"] ||
        prior["source_event_id"] !== proof["sourceEventId"] ||
        prior["occurred_at"] !== proof["occurredAt"] ||
        prior["event_type"] !== proof["eventType"] ||
        prior["journal_sequence"] !== proof["journalSequence"] ||
        prior["journal_head_hash"] !== proof["journalHeadHash"] ||
        prior["fact_ordinal"] !== proof["factOrdinal"]
      )
        fail("integrity");
      if (
        (await ctx.digest(
          new TextEncoder().encode(string(prior["canonical_json"]))
        )) !== reference["sha256"] ||
        !sameBytes(ctx.encode(object(prior["payload"])), bytes)
      )
        fail("integrity");
      return;
    }
    await insert(tx, "vertex_native_journal_proofs", scope, {
      artifact_id: reference["artifactId"],
      stream_id: proof["streamId"],
      owner_epoch: proof["ownerEpoch"],
      source_event_id: proof["sourceEventId"],
      occurred_at: proof["occurredAt"],
      event_type: proof["eventType"],
      journal_sequence: proof["journalSequence"],
      journal_head_hash: proof["journalHeadHash"],
      fact_ordinal: proof["factOrdinal"],
      sha256: reference["sha256"],
      byte_length: bytes.byteLength,
      canonical_json: text,
      payload: proof,
    });
  };
  const normalize = async (
    tx: Transaction,
    scope: VertexScope,
    projection: VertexRecord
  ): Promise<void> => {
    const fact = object(projection["fact"]);
    const base = {
      projection_id: projection["projectionId"],
      authoritative: false,
      execution_authorized: false,
    };
    switch (fact["kind"]) {
      case "checkpoint": {
        await insert(tx, "vertex_native_checkpoints", scope, {
          ...base,
          snapshot_id: fact["snapshotId"],
          snapshot_sha256: fact["snapshotSha256"],
          journal_sequence: fact["journalSequence"],
          journal_head_hash: fact["journalHeadHash"],
        });
        break;
      }
      case "cash-settlement":
      case "assignment":
      case "exercise":
      case "option-expiry": {
        const cash = fact["kind"] === "cash-settlement";
        // Pending deltas are obligations, not posted balances. Cash settlement
        // has no synthetic instrument, quantity, due date or order intent.
        await insert(tx, "vertex_native_settlements", scope, {
          ...base,
          fact_kind: fact["kind"],
          settlement_id: fact["settlementId"],
          settlement_state: cash ? "settled" : fact["settlementState"],
          instrument_id: cash ? null : fact["instrumentId"],
          underlying_id: cash ? null : fact["underlyingId"],
          settlement_kind: cash ? null : fact["settlementKind"],
          quantity: cash ? null : fact["quantity"],
          currency: fact["currency"],
          cash_delta: fact["cashDelta"],
          share_delta: cash ? null : fact["shareDelta"],
          due_at: cash ? null : fact["dueAt"],
          due_at_ns: cash ? null : time(fact["dueAt"]).toString(),
          occurred_at_ns: time(projection["occurredAt"]).toString(),
        });
        for (const [ordinal, sourceEventId] of array(
          fact["fillEventIds"],
          512
        ).entries()) {
          await insert(tx, "vertex_native_settlement_sources", scope, {
            projection_id: projection["projectionId"],
            source_ordinal: ordinal,
            source_event_id: identifier(sourceEventId),
          });
        }
        break;
      }
      case "corporate-action": {
        await insert(tx, "vertex_native_corporate_actions", scope, {
          ...base,
          action_id: fact["actionId"],
          old_instrument_id: fact["oldInstrumentId"],
          new_instrument_id: fact["newInstrumentId"],
          quantity_numerator: fact["quantityNumerator"],
          quantity_denominator: fact["quantityDenominator"],
          previous_quantity: fact["previousQuantity"],
          new_quantity: fact["newQuantity"],
          cash_delta: fact["cashDelta"],
          currency: fact["currency"],
          previous_qualification_sha256: fact["previousQualificationSha256"],
          replacement_qualification_sha256:
            fact["replacementQualificationSha256"],
        });
        break;
      }
      case "reconciliation": {
        await insert(tx, "vertex_native_reconciliations", scope, {
          ...base,
          reconciliation_id: fact["reconciliationId"],
          observed_snapshot_id: fact["observedSnapshotId"],
          unknown_count: fact["unknownCount"],
          reconciled: fact["reconciled"],
        });
        break;
      }
      case "kill-state": {
        // This records a native owner's observation, including reset grant ID;
        // it never creates a cloud permission, reset grant or risk transition.
        await insert(tx, "vertex_native_kill_states", scope, {
          ...base,
          action: fact["action"],
          grant_id: fact["grantId"],
        });
        for (const [ordinal, reasonCode] of array(
          fact["reasonCodes"],
          64
        ).entries()) {
          await insert(tx, "vertex_native_kill_reasons", scope, {
            projection_id: projection["projectionId"],
            reason_ordinal: ordinal,
            reason_code: identifier(reasonCode),
          });
        }
        break;
      }
      default: {
        fail("invalid");
      }
    }
  };
  const appendNativeFactProjection: VertexStore["appendNativeFactProjection"] =
    async (principal, scope, input, proofBytes) => {
      // Snapshot mutable caller-owned bytes before the first await, including
      // direct factory callers that do not use the public repository wrapper.
      const bytes = captureProof(proofBytes);
      const value = await ctx.validate("NativeFactProjection", input);
      ctx.scoped(value, scope);
      if (
        scope.environment !== "paper" ||
        value["actorId"] !== principal.actorId
      )
        fail("denied");
      const { eventHash, ...identity } = value;
      if ((await ctx.hash(identity)) !== eventHash) fail("integrity");
      if (ctx.encode(value).byteLength > MAX_PROOF_BYTES) fail("invalid");
      const reference = object(value["proof"]);
      if ((await ctx.digest(bytes)) !== reference["sha256"]) fail("integrity");
      const { text, decoded } = decodeProof(bytes);
      if (!sameBytes(ctx.encode(decoded), bytes)) fail("invalid");
      const proof = await ctx.validate("NativeJournalProof", decoded);
      if (!sameBytes(ctx.encode(proof), bytes)) fail("integrity");
      const fact = object(value["fact"]);
      if (
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
        proof["factOrdinal"] !== value["factOrdinal"]
      )
        fail("integrity");
      if (
        fact["kind"] === "checkpoint" &&
        (fact["journalSequence"] !== proof["journalSequence"] ||
          fact["journalHeadHash"] !== proof["journalHeadHash"])
      )
        fail("integrity");
      return ctx.run(
        principal,
        scope,
        null,
        identifier(value["streamId"]),
        "project",
        async (tx, at) => {
          if (time(value["receivedAt"]) > time(at)) fail("invalid");
          await retainProof(tx, scope, value, proof, bytes, text);
          return ingestion.append(
            tx,
            scope,
            value,
            at,
            "native-fact",
            () => normalize(tx, scope, value),
            {
              fact_kind: fact["kind"],
              proof_artifact_id: reference["artifactId"],
              proof_sha256: reference["sha256"],
              proof_source_event_id: reference["sourceEventId"],
              proof_journal_sequence: value["proofJournalSequence"],
              proof_journal_head_hash: value["proofJournalHeadHash"],
              fact_ordinal: value["factOrdinal"],
              authoritative: false,
              execution_authorized: false,
            }
          );
        }
      );
    };
  return { appendNativeFactProjection };
};
