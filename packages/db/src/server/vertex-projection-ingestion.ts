import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  fail,
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
  VertexProjectionResult,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";

// Both source kinds share the account/environment transaction fence, identity
// namespace and vertex_projection_heads. This helper owns no alternate ledger.
export type ProjectionKind = "order" | "native-fact";
const tables = {
  order: "vertex_execution_projections",
  "native-fact": "vertex_native_fact_projections",
} as const;
const verifyNativeColumns = (row: Row, value: VertexRecord): void => {
  const proof = object(value["proof"]);
  const expected: Row = {
    fact_kind: object(value["fact"])["kind"],
    proof_artifact_id: proof["artifactId"],
    proof_sha256: proof["sha256"],
    proof_source_event_id: proof["sourceEventId"],
    proof_journal_sequence: value["proofJournalSequence"],
    proof_journal_head_hash: value["proofJournalHeadHash"],
    fact_ordinal: value["factOrdinal"],
    authoritative: false,
    execution_authorized: false,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (row[key] !== expectedValue) fail("integrity");
  }
};

export const createProjectionIngestion = (ctx: PersistenceContext) => {
  const findAppliedProjection = async (
    tx: Transaction,
    scope: VertexScope,
    streamId: unknown,
    ownerEpoch: unknown,
    eventSequence: unknown,
    eventHash: unknown
  ): Promise<Row | null> => {
    const where = sql`stream_id = ${streamId} and owner_epoch = ${ownerEpoch} and sequence = ${eventSequence} and event_hash = ${eventHash} and applied = true`;
    const order = await one(tx, tables.order, scope, where);
    const native = await one(tx, tables["native-fact"], scope, where);
    if (order && native) fail("integrity");
    const event = order ?? native;
    if (event) {
      const { eventHash: storedHash, ...identity } = object(event["payload"]);
      if (storedHash !== eventHash || (await ctx.hash(identity)) !== eventHash)
        fail("integrity");
      if (native) verifyNativeColumns(native, object(native["payload"]));
    }
    return event;
  };
  const pending = async (
    tx: Transaction,
    scope: VertexScope,
    streamId: unknown,
    ownerEpoch: unknown,
    incoming: Row | null = null
  ): Promise<Row | null> => {
    const where = sql`stream_id = ${streamId} and owner_epoch >= ${ownerEpoch} and applied = false`;
    const order = sql`order by (owner_epoch <> ${ownerEpoch}) desc, sequence, projection_id`;
    const candidates = [
      incoming,
      await one(tx, tables.order, scope, where, order),
      await one(tx, tables["native-fact"], scope, where, order),
    ].filter((row): row is Row => row !== null);
    candidates.sort((left, right) => {
      if (
        (left["owner_epoch"] !== ownerEpoch) !==
        (right["owner_epoch"] !== ownerEpoch)
      )
        return left["owner_epoch"] === ownerEpoch ? 1 : -1;
      const a = sequence(left["sequence"]);
      const b = sequence(right["sequence"]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return candidates[0] ?? null;
  };
  const append = async (
    tx: Transaction,
    scope: VertexScope,
    value: VertexRecord,
    at: string,
    kind: ProjectionKind,
    normalize: () => Promise<void>,
    columns: Row = {}
  ): Promise<VertexProjectionResult> => {
    const table = tables[kind];
    const other = tables[kind === "order" ? "native-fact" : "order"];
    const identity = sql`projection_id = ${value["projectionId"]} or (stream_id = ${value["streamId"]} and ((owner_epoch = ${value["ownerEpoch"]} and sequence = ${value["sequence"]}) or idempotency_key = ${value["idempotencyKey"]}))`;
    // Check the OTHER kind even for an exact same-kind retry. A cross-kind
    // projection ID, stream position or idempotency collision is never replay.
    if (await one(tx, other, scope, identity)) fail("conflict");
    // One journal event may emit 64 different facts. Its ordinal, not the
    // projection sequence or a caller-chosen stream alias, distinguishes them.
    const sameKindIdentity =
      kind === "native-fact"
        ? sql`(${identity}) or (owner_epoch = ${value["ownerEpoch"]} and proof_journal_sequence = ${value["proofJournalSequence"]} and proof_journal_head_hash = ${value["proofJournalHeadHash"]} and fact_ordinal = ${value["factOrdinal"]})`
        : identity;
    const existing = await one(tx, table, scope, sameKindIdentity);
    if (
      existing &&
      (existing["event_hash"] !== value["eventHash"] ||
        existing["projection_id"] !== value["projectionId"] ||
        (await ctx.hash(object(existing["payload"]))) !==
          (await ctx.hash(value)))
    )
      fail("conflict");
    if (existing && kind === "native-fact")
      verifyNativeColumns(existing, value);
    let head = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${value["streamId"]}`
    );
    // Paper observations require PortfolioGenesis. Preserve the original
    // broker-observation empty stream only; it never seeds simulator capital.
    const legacyBroker =
      kind === "order" && value["sourceKind"] === "broker-observation";
    if (!head) {
      if (!legacyBroker) return fail("stale");
      await ctx.ensureAccount(tx, scope, at);
      head = {
        stream_id: value["streamId"],
        owner_epoch: value["ownerEpoch"],
        high_water_sequence: "0",
        high_water_event_hash: null,
        last_occurred_at: null,
        last_received_at: null,
        expires_at_ns: null,
        state: "empty",
        received_sequence: null,
      };
      await insert(tx, "vertex_projection_heads", scope, head);
    }
    const result = (
      status: VertexProjectionResult["status"]
    ): VertexProjectionResult => ({
      status,
      highWaterSequence: string(
        requirePresent(head, "head")["high_water_sequence"]
      ),
      highWaterEventHash:
        requirePresent(head, "head")["high_water_event_hash"] === null
          ? null
          : string(requirePresent(head, "head")["high_water_event_hash"]),
    });
    if (existing?.["applied"] === true) return result("duplicate");
    // A retired owner cannot poison the replacement epoch's continuity or
    // append normalized observations. Exact committed retries above are inert.
    if (sequence(value["ownerEpoch"]) < sequence(head["owner_epoch"]))
      fail("stale");
    const incomingSequence = sequence(value["sequence"]);
    if (
      !legacyBroker &&
      (incomingSequence < 2n || value["previousEventHash"] === null)
    )
      fail("invalid");
    // Legacy sequence one is an EMPTY broker stream observation, not a way to
    // occupy an already committed PortfolioGenesis position in the other kind.
    if (
      legacyBroker &&
      incomingSequence === 1n &&
      (head["high_water_sequence"] !== "0" ||
        head["high_water_event_hash"] !== null)
    )
      fail("conflict");
    sequence((incomingSequence + 1n).toString());
    const next = sequence(head["high_water_sequence"]) + 1n;
    const epochMismatch = value["ownerEpoch"] !== head["owner_epoch"];
    const gap =
      incomingSequence !== next ||
      value["previousEventHash"] !== head["high_water_event_hash"];
    const chronologicallyInvalid =
      head["last_occurred_at"] !== null &&
      (time(value["occurredAt"]) < time(head["last_occurred_at"]) ||
        time(value["receivedAt"]) < time(head["last_received_at"]));
    if (!(epochMismatch || gap) && chronologicallyInvalid) fail("integrity");
    const stale =
      time(value["expiresAt"]) <= time(at) ||
      time(at) - time(value["occurredAt"]) >
        BigInt(ctx.maxProjectionAgeMs) * 1_000_000n;
    const disposition = epochMismatch
      ? "epoch-mismatch"
      : gap
        ? "gap"
        : stale
          ? "stale"
          : "applied";
    const applied = !(epochMismatch || gap);
    if (!existing) {
      await insert(tx, table, scope, {
        ...columns,
        projection_id: value["projectionId"],
        stream_id: value["streamId"],
        owner_epoch: value["ownerEpoch"],
        sequence: value["sequence"],
        event_hash: value["eventHash"],
        previous_event_hash: value["previousEventHash"],
        idempotency_key: value["idempotencyKey"],
        occurred_at: value["occurredAt"],
        received_at: value["receivedAt"],
        expires_at_ns: time(value["expiresAt"]).toString(),
        applied,
        disposition,
        payload: value,
      });
      await normalize();
    } else if (applied) {
      // Replay may repair a gap after its predecessor; never rewrite evidence.
      await tx.execute(
        sql`update ${sql.identifier(table)} set applied = true, disposition = ${disposition} where ${scopeWhere(scope)} and projection_id = ${value["projectionId"]} and event_hash = ${value["eventHash"]} and applied = false`
      );
    }
    const unresolved = await pending(
      tx,
      scope,
      value["streamId"],
      head["owner_epoch"],
      applied
        ? null
        : { owner_epoch: value["ownerEpoch"], sequence: value["sequence"] }
    );
    const pendingState = unresolved
      ? unresolved["owner_epoch"] === head["owner_epoch"]
        ? "gap"
        : "epoch-mismatch"
      : null;
    if (!applied) {
      const changed = await rows(
        tx,
        sql`update vertex_projection_heads set state = ${pendingState ?? disposition}, received_sequence = ${unresolved?.["sequence"] ?? value["sequence"]} where ${scopeWhere(scope)} and stream_id = ${value["streamId"]} and owner_epoch = ${head["owner_epoch"]} and high_water_sequence = ${head["high_water_sequence"]} and high_water_event_hash is not distinct from ${head["high_water_event_hash"]} returning high_water_sequence`
      );
      if (changed.length !== 1) fail("conflict");
      return result(epochMismatch ? "epoch-mismatch" : "gap");
    }
    const changed = await rows(
      tx,
      sql`update vertex_projection_heads set high_water_sequence = ${value["sequence"]}, high_water_event_hash = ${value["eventHash"]}, last_occurred_at = ${value["occurredAt"]}, last_received_at = ${value["receivedAt"]}, expires_at_ns = ${time(value["expiresAt"]).toString()}, state = ${pendingState ?? (stale ? "stale" : "continuous")}, received_sequence = ${unresolved?.["sequence"] ?? null} where ${scopeWhere(scope)} and stream_id = ${value["streamId"]} and owner_epoch = ${value["ownerEpoch"]} and high_water_sequence = ${head["high_water_sequence"]} and high_water_event_hash is not distinct from ${head["high_water_event_hash"]} returning high_water_sequence`
    );
    if (changed.length !== 1) fail("conflict");
    head = {
      ...head,
      high_water_sequence: value["sequence"],
      high_water_event_hash: value["eventHash"],
    };
    return result(stale ? "stale" : "applied");
  };
  return { append, findAppliedProjection };
};
