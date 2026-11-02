import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  NativeOutboxReplayGrantSchema,
  NativeOutboxReplaySchema,
  PortfolioEpochTransitionSchema,
} from "../../../api/src/contracts/vertex-worker-epoch.ts";
import {
  computePortfolioGenesisHash,
  ExecutionProjectionSchema,
  NativeFactProjectionSchema,
  NativeJournalProofSchema,
  PortfolioSnapshotSchema,
} from "../../../api/src/vertex.ts";
import type { Database, Transaction } from "./client.ts";
import type { VertexVerifiedNativeApproval } from "./vertex-native-approval-audit.ts";
import { createNativeFactOperations } from "./vertex-native-fact-store.ts";
import {
  createNativeOutboxReplayOperations,
  type VertexNativeOutboxReplayVerifier,
} from "./vertex-native-replay-store.ts";
import {
  createPersistenceContext,
  type Row,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexAuthorization,
  VertexBoundary,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";

// Authored only: no tests, SQL, runtime, provider or model calls executed.
// This SQL-recording transaction fixture is not a PostgreSQL concurrency proof.
// Its synthetic verifier receipt is not a real enrolled human signature.
const AT = "2026-09-22T12:00:00.000000001Z";
const BEFORE = "2026-09-22T11:59:59.000000001Z";
const LATER = "2026-09-22T12:10:00.000000001Z";
const scope: VertexScope = {
  accountAlias: "synthetic-replay-account",
  environment: "paper",
};
const principal = { actorId: "synthetic-native-emitter" };
const streamId = "retained-stream";
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const hash = (value: unknown): Promise<string> => hashArtifact(encode(value));
const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const blob = (value: unknown): string => base64(encode(value));
const genesis = async () => {
  const zero = "0".repeat(64);
  const value = PortfolioSnapshotSchema.parse({
    schemaVersion: "1.0.0",
    snapshotId: "original-genesis",
    ...scope,
    streamId,
    ownerEpoch: "1",
    sequence: "1",
    sourceEventHash: zero,
    sourceKind: "paper-simulation",
    asOfAt: BEFORE,
    receivedAt: BEFORE,
    currency: "USD",
    cash: "73",
    netAssetValue: "73",
    positions: [],
    lots: [],
    reservations: [],
    sleeveAllocations: [],
    continuity: {
      ...scope,
      streamId,
      ownerEpoch: "1",
      highWaterSequence: "1",
      highWaterEventHash: zero,
      lastOccurredAt: BEFORE,
      lastReceivedAt: BEFORE,
      evaluatedAt: BEFORE,
      freshness: {
        status: "fresh",
        observedAt: BEFORE,
        evaluatedAt: BEFORE,
        maxAgeMs: 60_000,
      },
      state: "continuous",
      expectedNextSequence: "2",
      receivedSequence: null,
      newRiskInhibited: true,
      authoritative: false,
    },
    observationOnly: true,
    executionAuthorized: false,
    researchNotionalIncluded: false,
  });
  const sourceEventHash = await computePortfolioGenesisHash(value);
  return {
    ...value,
    sourceEventHash,
    continuity: { ...value.continuity, highWaterEventHash: sourceEventHash },
  };
};
const nativeFixture = async (
  previousEventHash: unknown,
  overrides: VertexRecord = {}
) => {
  const fact = {
    kind: "reconciliation",
    reconciliationId: "native-reconciliation",
    observedSnapshotId: "original-genesis",
    unknownCount: 0,
    reconciled: true,
  };
  const body = {
    schemaVersion: "1.0.0",
    projectionId: "native-2",
    ...scope,
    streamId,
    ownerEpoch: "1",
    sequence: "2",
    proofJournalSequence: "7",
    proofJournalHeadHash: "c".repeat(64),
    factOrdinal: 0,
    previousEventHash,
    occurredAt: AT,
    receivedAt: AT,
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    expiresAt: LATER,
    idempotencyKey: "native-key-2",
    sourceKind: "paper-simulation",
    fact,
    authoritative: false,
    reservationAuthority: "native-owner-only",
    executionAuthorized: false,
    ...overrides,
  };
  const proof = {
    schemaVersion: "1.0.0",
    proofKind: "native-journal-event",
    ...scope,
    streamId,
    ownerEpoch: body.ownerEpoch,
    sourceEventId: `source-${body.projectionId}`,
    journalSequence: body.proofJournalSequence,
    journalHeadHash: body.proofJournalHeadHash,
    factOrdinal: body.factOrdinal,
    occurredAt: body.occurredAt,
    eventType: fact.kind,
    payload: fact,
  };
  const bytes = encode(proof);
  const identity = {
    ...body,
    proof: {
      artifactId: `proof-${body.projectionId}`,
      sha256: await hashArtifact(bytes),
      sourceEventId: proof.sourceEventId,
    },
  };
  return {
    value: { ...identity, eventHash: await hash(identity) },
    proof,
    bytes,
  };
};
const orderFixture = async (previousEventHash: unknown) => {
  const body = {
    schemaVersion: "1.0.0",
    projectionId: "order-3",
    ...scope,
    streamId,
    ownerEpoch: "1",
    sequence: "3",
    previousEventHash,
    occurredAt: AT,
    receivedAt: AT,
    actorId: principal.actorId,
    policyVersion: "1.0.0",
    strategyVersion: "strategy-1",
    reviewedArtifactSha256: "d".repeat(64),
    admissionId: "historical-admission",
    expiresAt: LATER,
    idempotencyKey: "order-key-3",
    sourceKind: "paper-simulation",
    receipt: {
      schemaVersion: "1.0.0",
      intentId: "intent-1",
      submissionKey: "submission-1",
      brokerOrderRef: "native-order-1",
      environment: "paper",
      observationOnly: true,
      status: "filled",
      totalQuantity: "1",
      filledQuantity: "1",
      remainingQuantity: "0",
      lastReconciledAt: AT,
      errorClass: null,
      auditEventIds: ["audit-1"],
    },
    authoritative: false,
    reservationAuthority: "native-owner-only",
  };
  return { ...body, eventHash: await hash(body) };
};
type SourceRow = Readonly<{
  kind: string;
  value: VertexRecord;
  proof?: Uint8Array;
}>;
const packet = async (
  sources: readonly SourceRow[],
  startingSequence: string,
  startingEventHash: unknown,
  overrides: VertexRecord = {},
  retainedEpochTransition: VertexRecord | null = null
) => {
  const rows = sources.map((row) => ({
    kind: row.kind,
    projectionBase64: blob(row.value),
    proofBase64: row.proof ? base64(row.proof) : null,
  }));
  const identities = await Promise.all(
    sources.map(async (row) => ({
      projectionId: row.value["projectionId"] ?? row.value["snapshotId"],
      sequence: row.value["sequence"],
      eventHash: row.value["eventHash"] ?? row.value["sourceEventHash"],
      projectionRawSha256: await hash(row.value),
      kind: row.kind,
      proofSha256: row.proof ? await hashArtifact(row.proof) : null,
    }))
  );
  const subject = {
    schemaVersion: "1.0.0",
    grantId: "replay-approval",
    ...scope,
    streamId,
    priorOwnerEpoch: "1",
    currentOwnerEpoch: "2",
    serviceActorId: principal.actorId,
    startingSequence,
    startingEventHash,
    journalIdentity: "retained-journal",
    journalSequence: "8",
    journalHeadSha256: "a".repeat(64),
    nativeJournalEvidenceSha256: "b".repeat(64),
    nativeOwnerFenceSha256: "c".repeat(64),
    retainedEpochTransitionSha256:
      retainedEpochTransition === null
        ? null
        : await hash(retainedEpochTransition),
    issuedAt: AT,
    expiresAt: LATER,
    rows: identities,
    ...overrides,
  };
  const replaySha256 = await hash(subject);
  const approval = {
    keyId: "enrolled-human-key",
    payload: {
      format: "vertex-native-approval-v1",
      accountAlias: subject.accountAlias,
      environment: "paper",
      action: "native-outbox-replay",
      actorId: "independent-human",
      approvalId: subject.grantId,
      nonce: "f".repeat(64),
      issuedNs: time(subject.issuedAt).toString(),
      expiresNs: time(subject.expiresAt).toString(),
      subject: { replaySha256 },
    },
    signatureHex: "e".repeat(128),
  };
  const approvalBase64 = blob(approval);
  const receipt: VertexVerifiedNativeApproval = {
    signerKeyId: approval.keyId,
    signerKeySha256: "d".repeat(64),
    approvalId: approval.payload.approvalId,
    nonce: approval.payload.nonce,
    actorId: approval.payload.actorId,
    action: "native-outbox-replay",
    subjectSha256: replaySha256,
    approvalSha256: await hash(approval),
    statusRevision: "1",
    statusSha256: "e".repeat(64),
    expiresAt: subject.expiresAt,
  };
  return {
    replay: {
      grant: { ...subject, approvalBase64 },
      retainedEpochTransitionBase64:
        retainedEpochTransition === null ? null : blob(retainedEpochTransition),
      rows,
    },
    receipt,
    replaySha256,
  };
};
const fixture = async () => {
  const old = await genesis();
  const fact = await nativeFixture(old.sourceEventHash);
  const order = await orderFixture(fact.value.eventHash);
  const snapshot = {
    ...old,
    snapshotId: "retained-snapshot-3",
    sequence: "3",
    sourceEventHash: order.eventHash,
    asOfAt: AT,
    receivedAt: AT,
    continuity: {
      ...old.continuity,
      highWaterSequence: "3",
      highWaterEventHash: order.eventHash,
      lastOccurredAt: AT,
      lastReceivedAt: AT,
      evaluatedAt: AT,
      freshness: {
        status: "fresh",
        observedAt: AT,
        evaluatedAt: AT,
        maxAgeMs: 60_000,
      },
      expectedNextSequence: "4",
    },
  };
  const sources: SourceRow[] = [
    { kind: "native-fact", value: fact.value, proof: fact.bytes },
    { kind: "order", value: order },
    { kind: "portfolio-snapshot", value: snapshot },
  ];
  return {
    old,
    fact,
    order,
    snapshot,
    sources,
    ...(await packet(sources, "1", old.sourceEventHash)),
  };
};
const retainedTransitionFixture = async () => {
  const old = await fixture();
  const zero = "0".repeat(64);
  const candidate = PortfolioSnapshotSchema.parse({
    ...old.old,
    snapshotId: "retained-genesis-2",
    ownerEpoch: "2",
    sourceEventHash: zero,
    continuity: {
      ...old.old.continuity,
      ownerEpoch: "2",
      highWaterEventHash: zero,
    },
  });
  const sourceEventHash = await computePortfolioGenesisHash(candidate);
  const snapshot = {
    ...candidate,
    sourceEventHash,
    continuity: {
      ...candidate.continuity,
      highWaterEventHash: sourceEventHash,
    },
  };
  // The historical signature is intentionally expired. Only the independently
  // verified current replay receipt can ratify it; these are synthetic bytes.
  const historicalApproval = {
    keyId: "historical-human-key",
    payload: {
      format: "vertex-native-approval-v1",
      ...scope,
      ownerEpoch: "2",
      action: "owner-epoch-transition",
      actorId: "historical-human",
      approvalId: "original-transition-approval",
      nonce: "1".repeat(64),
      issuedNs: time("2026-09-22T11:58:00Z").toString(),
      expiresNs: time("2026-09-22T11:59:59.500000001Z").toString(),
      subject: { transitionSha256: "2".repeat(64) },
    },
    signatureHex: "3".repeat(128),
  };
  const transition = {
    schemaVersion: "1.0.0",
    transitionId: "original-transition-2",
    snapshot,
    priorOwnerEpoch: "1",
    priorProjectionSequence: "1",
    priorProjectionHash: old.old.sourceEventHash,
    journalIdentity: "retained-journal",
    journalSequence: "8",
    journalHeadSha256: "a".repeat(64),
    nativeOutboxEvidenceSha256: "b".repeat(64),
    nativeOwnerFenceSha256: "c".repeat(64),
    approvalBase64: blob(historicalApproval),
  };
  const fact = await nativeFixture(snapshot.sourceEventHash, {
    ownerEpoch: "2",
    projectionId: "epoch2-native-2",
    idempotencyKey: "epoch2-native-key-2",
    proofJournalSequence: "9",
  });
  const sources: SourceRow[] = [
    { kind: "portfolio-genesis", value: snapshot },
    { kind: "native-fact", value: fact.value, proof: fact.bytes },
  ];
  return {
    old,
    snapshot,
    transition,
    fact,
    sources,
    ...(await packet(
      sources,
      "0",
      null,
      { priorOwnerEpoch: "2", currentOwnerEpoch: "3", journalSequence: "9" },
      transition
    )),
  };
};

type Query = Readonly<{ sql: string; params: unknown[] }>;
const harness = async (f: Awaited<ReturnType<typeof fixture>>, seed = true) => {
  const tables = new Map<string, Row[]>();
  const data = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const scoped = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
  };
  if (seed) {
    data("vertex_projection_heads").push({
      ...scoped,
      stream_id: streamId,
      owner_epoch: "1",
      high_water_sequence: "1",
      high_water_event_hash: f.old.sourceEventHash,
      last_occurred_at: BEFORE,
      last_received_at: BEFORE,
      expires_at_ns: time(LATER).toString(),
      state: "continuous",
      received_sequence: null,
    });
    data("vertex_portfolio_snapshots").push({
      ...scoped,
      snapshot_id: f.old.snapshotId,
      stream_id: streamId,
      owner_epoch: "1",
      sequence: "1",
      source_event_hash: f.old.sourceEventHash,
      source_kind: "paper-simulation",
      as_of_at_ns: time(BEFORE).toString(),
      received_at_ns: time(BEFORE).toString(),
      record_hash: await hash(f.old),
      payload: f.old,
    });
  }
  const admission = {
    policyVersion: f.order.policyVersion,
    strategyVersion: f.order.strategyVersion,
    reviewedArtifactSha256: f.order.reviewedArtifactSha256,
    streamId,
    ownerEpoch: "1",
    intentId: f.order.receipt.intentId,
    admittedAt: BEFORE,
  };
  data("vertex_paper_jobs").push({
    ...scoped,
    admission_id: f.order.admissionId,
    record_hash: await hash(admission),
    payload: admission,
  });
  const queries: Query[] = [];
  const lifecycle: string[] = [];
  const control = { now: AT };
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    const { sql: text, params: p } = query;
    queries.push(query);
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (
      text.startsWith("select * from vertex_native_approval_audit") &&
      text.includes("and request_sha256")
    )
      return {
        rows: data("vertex_native_approval_audit")
          .filter(
            (row) =>
              row["signer_key_sha256"] === p[0] &&
              row["approval_id"] === p[1] &&
              row["request_sha256"] === p[2]
          )
          .slice(0, 1),
      };
    if (text.startsWith("select * from vertex_native_approval_audit"))
      return {
        rows: data("vertex_native_approval_audit")
          .filter(
            (row) =>
              row["signer_key_sha256"] === p[0] &&
              (row["nonce"] === p[1] || row["approval_id"] === p[2])
          )
          .slice(0, 2),
      };
    const inserted =
      /^insert into (?:(?:"([a-z_]+)")|([a-z_]+)) \(([^)]+)\) values/.exec(
        text
      );
    if (inserted) {
      const name = inserted[1] ?? inserted[2]!;
      const columns = inserted[3]!
        .split(",")
        .map((key) => key.trim().replace(/"/g, ""));
      data(name).push(
        Object.fromEntries(
          columns.map((key, i) => [
            key,
            ["payload", "outcome"].includes(key)
              ? JSON.parse(String(p[i]))
              : p[i],
          ])
        )
      );
      return { rows: [] };
    }
    if (
      text.startsWith("insert into vertex_accounts") ||
      text.startsWith("insert into vertex_account_aliases")
    )
      return { rows: [] };
    const selected = /^select \* from "([a-z_]+)"/.exec(text);
    if (selected) {
      const name = selected[1]!;
      const found = data(name).filter(
        (row) => row["account_alias"] === p[0] && row["environment"] === p[1]
      );
      if (name === "vertex_projection_heads")
        return {
          rows: found.filter((row) => row["stream_id"] === p[2]).slice(0, 1),
        };
      if (name === "vertex_native_journal_proofs")
        return {
          rows: found.filter((row) => row["artifact_id"] === p[2]).slice(0, 1),
        };
      if (name === "vertex_paper_jobs")
        return {
          rows: found.filter((row) => row["admission_id"] === p[2]).slice(0, 1),
        };
      if (name === "vertex_portfolio_epoch_transitions")
        return {
          rows: found
            .filter(
              (row) =>
                row["transition_id"] === p[2] ||
                (row["stream_id"] === p[3] &&
                  (row["owner_epoch"] === p[4] ||
                    row["prior_owner_epoch"] === p[5]))
            )
            .slice(0, 1),
        };
      if (name === "vertex_portfolio_snapshots") {
        if (text.includes("snapshot_id =") && text.includes(" or "))
          return {
            rows: found
              .filter(
                (row) =>
                  row["snapshot_id"] === p[2] ||
                  (row["stream_id"] === p[3] &&
                    row["owner_epoch"] === p[4] &&
                    (p[5] === undefined || row["sequence"] === p[5]))
              )
              .slice(0, 1),
          };
        if (text.includes("snapshot_id ="))
          return {
            rows: found
              .filter((row) => row["snapshot_id"] === p[2])
              .slice(0, 1),
          };
        return {
          rows: found
            .filter(
              (row) =>
                row["stream_id"] === p[2] &&
                (p[3] === undefined || row["owner_epoch"] === p[3])
            )
            .sort((a, b) =>
              Number(
                BigInt(String(b["sequence"])) - BigInt(String(a["sequence"]))
              )
            )
            .slice(0, 1),
        };
      }
      if (
        [
          "vertex_execution_projections",
          "vertex_native_fact_projections",
        ].includes(name)
      ) {
        if (text.includes("projection_id ="))
          return {
            rows: found
              .filter(
                (row) =>
                  row["projection_id"] === p[2] ||
                  (row["stream_id"] === p[3] &&
                    ((row["owner_epoch"] === p[4] &&
                      row["sequence"] === p[5]) ||
                      row["idempotency_key"] === p[6])) ||
                  (text.includes("proof_journal_sequence =") &&
                    row["owner_epoch"] === p[7] &&
                    row["proof_journal_sequence"] === p[8] &&
                    row["proof_journal_head_hash"] === p[9] &&
                    row["fact_ordinal"] === p[10])
              )
              .slice(0, 1),
          };
        if (text.includes("applied = false or owner_epoch"))
          return {
            rows: found
              .filter(
                (row) =>
                  row["stream_id"] === p[2] &&
                  (row["applied"] === false || row["owner_epoch"] === p[3])
              )
              .slice(0, 1),
          };
        if (text.includes("applied = false"))
          return {
            rows: found
              .filter(
                (row) =>
                  row["stream_id"] === p[2] &&
                  BigInt(String(row["owner_epoch"])) >= BigInt(String(p[3])) &&
                  row["applied"] === false
              )
              .slice(0, 1),
          };
        if (text.includes("applied = true"))
          return {
            rows: found
              .filter(
                (row) =>
                  row["stream_id"] === p[2] &&
                  row["owner_epoch"] === p[3] &&
                  row["sequence"] === p[4] &&
                  row["event_hash"] === p[5] &&
                  row["applied"] === true
              )
              .slice(0, 1),
          };
        return {
          rows: found.filter((row) => row["stream_id"] === p[2]).slice(0, 1),
        };
      }
      throw new Error(`Unexpected fixture table ${name}`);
    }
    if (text.startsWith("update vertex_projection_heads set owner_epoch")) {
      const head = data("vertex_projection_heads").find(
        (row) =>
          row["stream_id"] === p[8] &&
          row["owner_epoch"] === p[9] &&
          row["high_water_sequence"] === p[10] &&
          row["high_water_event_hash"] === p[11]
      );
      if (!head) return { rows: [] };
      Object.assign(head, {
        owner_epoch: p[0],
        high_water_sequence: "1",
        high_water_event_hash: p[1],
        last_occurred_at: p[2],
        last_received_at: p[3],
        expires_at_ns: p[4],
        state: p[5],
        received_sequence: null,
      });
      return { rows: [{ high_water_sequence: "1" }] };
    }
    if (
      text.startsWith("update vertex_projection_heads set high_water_sequence")
    ) {
      const head = data("vertex_projection_heads").find(
        (row) =>
          row["stream_id"] === p[9] &&
          row["owner_epoch"] === p[10] &&
          row["high_water_sequence"] === p[11] &&
          row["high_water_event_hash"] === p[12]
      );
      if (!head) return { rows: [] };
      Object.assign(head, {
        high_water_sequence: p[0],
        high_water_event_hash: p[1],
        last_occurred_at: p[2],
        last_received_at: p[3],
        expires_at_ns: p[4],
        state: p[5],
        received_sequence: p[6],
      });
      return { rows: [{ high_water_sequence: p[0] }] };
    }
    const updated =
      /^update "(vertex_(?:execution|native_fact)_projections)" set applied/.exec(
        text
      );
    if (updated) {
      const row = data(updated[1]!).find(
        (entry) =>
          entry["projection_id"] === p[3] && entry["event_hash"] === p[4]
      )!;
      Object.assign(row, { applied: true, disposition: p[0] });
      return { rows: [] };
    }
    throw new Error(`Unexpected fixture SQL ${text}`);
  });
  const transaction = vi.fn(
    async (operation: (tx: Transaction) => Promise<unknown>) => {
      const saved = structuredClone([...tables.entries()]);
      lifecycle.push("begin");
      try {
        const outcome = await operation({ execute } as unknown as Transaction);
        lifecycle.push("commit");
        return outcome;
      } catch (error) {
        tables.clear();
        for (const [key, rows] of saved) tables.set(key, rows);
        lifecycle.push("rollback");
        throw error;
      }
    }
  );
  const db = { transaction } as unknown as Database;
  const validate: VertexBoundary["validate"] = (name, input) => {
    if (name === "NativeOutboxReplay")
      return NativeOutboxReplaySchema.parse(input);
    if (name === "NativeOutboxReplayGrant")
      return NativeOutboxReplayGrantSchema.parse(input);
    if (name === "NativeFactProjection")
      return NativeFactProjectionSchema.parse(input);
    if (name === "NativeJournalProof")
      return NativeJournalProofSchema.parse(input);
    if (name === "ExecutionProjection")
      return ExecutionProjectionSchema.parse(input);
    if (name === "PortfolioSnapshot")
      return PortfolioSnapshotSchema.parse(input);
    if (name === "PortfolioEpochTransition")
      return PortfolioEpochTransitionSchema.parse(input);
    throw new Error("Unexpected fixture schema");
  };
  const authorize = vi.fn<VertexAuthorization["authorize"]>(async () => true);
  const verify = vi.fn<VertexNativeOutboxReplayVerifier>(async () => f.receipt);
  const ctx = createPersistenceContext(db, {
    boundary: { validate, encode, digest: hashArtifact },
    clock: { now: () => control.now },
    authorization: { authorize },
    maxProjectionAgeMs: 60_000,
  });
  const ops = createNativeOutboxReplayOperations(ctx, {
    verifyNativeOutboxReplay: verify,
  });
  return {
    ctx,
    ops,
    data,
    queries,
    lifecycle,
    transaction,
    authorize,
    verify,
    control,
  };
};
const writes = (queries: readonly Query[]): Query[] =>
  queries.filter((query) => /^(?:insert|update|delete) /i.test(query.sql));

describe("bounded retained native replay in the caller transaction", () => {
  it("atomically observes mixed native/order/same-sequence snapshot rows and never opens a nested transaction", async () => {
    const f = await fixture();
    const h = await harness(f);
    const outcome = await h.transaction((tx) =>
      h.ops.replayNativeOutboxInTransaction(tx, principal, scope, f.replay, AT)
    );
    expect(outcome).toEqual({
      status: "applied",
      highWaterSequence: "3",
      highWaterEventHash: f.order.eventHash,
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(h.data("vertex_native_reconciliations")).toHaveLength(1);
    expect(h.data("vertex_receipt_orders")).toHaveLength(1);
    expect(h.data("vertex_portfolio_snapshots")).toHaveLength(2);
    expect(h.data("vertex_native_approval_audit")).toHaveLength(1);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.verify.mock.calls[0]![0]).toEqual({
      principal,
      scope,
      replay: f.replay,
      replaySha256: f.replaySha256,
      now: AT,
    });
    expect(h.authorize).toHaveBeenCalledWith({
      principal,
      scope,
      collectionId: null,
      resourceId: "native-outbox-replay",
      action: "project",
      now: AT,
    });
    expect(h.data("vertex_projection_heads")[0]!["owner_epoch"]).toBe("1");
    return expect(
      writes(h.queries).every(
        (query) =>
          !/insert into "?vertex_(?:paper_jobs|command_outbox|risk)/.test(
            query.sql
          )
      )
    ).toBe(true);
  });
  it("accepts an exact committed prefix, then ACK-only retries without rewinding or rewriting", async () => {
    const f = await fixture();
    const h = await harness(f);
    await createNativeFactOperations(h.ctx).appendNativeFactProjection(
      principal,
      scope,
      f.fact.value,
      f.fact.bytes
    );
    expect(
      await h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).toMatchObject({ status: "applied", highWaterSequence: "3" });
    const before = writes(h.queries).length;
    expect(
      await h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).toMatchObject({ status: "duplicate", highWaterSequence: "3" });
    expect(writes(h.queries)).toHaveLength(before);
    expect(h.data("vertex_native_reconciliations")).toHaveLength(1);
    return expect(h.data("vertex_native_approval_audit")).toHaveLength(1);
  });
  it("allows only actually verified retained genesis from zero, never an ordinary bootstrap exemption", async () => {
    const f = await fixture();
    const retained = await packet(
      [{ kind: "portfolio-genesis", value: f.old }],
      "0",
      null
    );
    const h = await harness(f, false);
    h.verify.mockResolvedValue(retained.receipt);
    expect(
      await h.ops.replayNativeOutbox(principal, scope, retained.replay)
    ).toMatchObject({
      status: "applied",
      highWaterSequence: "1",
      highWaterEventHash: f.old.sourceEventHash,
    });
    expect(h.data("vertex_portfolio_snapshots")[0]!["payload"]).toEqual(f.old);
    const denied = await harness(f, false);
    denied.verify.mockResolvedValue(null);
    await expect(
      denied.ops.replayNativeOutbox(principal, scope, retained.replay)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(denied.data("vertex_projection_heads")).toEqual([]);
  });
  it("commits historical observations while retaining stale freshness, not new-risk permission", async () => {
    const f = await fixture();
    const h = await harness(f);
    h.control.now = "2026-09-22T12:02:00.000000001Z";
    expect(
      await h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).toMatchObject({ status: "applied" });
    return expect(h.data("vertex_projection_heads")[0]!["state"]).toBe("stale");
  });
  it("rolls back normalized rows, proofs, head and audit if the final independent approval is revoked", async () => {
    const f = await fixture();
    const h = await harness(f);
    h.verify.mockResolvedValueOnce(f.receipt).mockResolvedValueOnce(null);
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.lifecycle).toEqual(["begin", "rollback"]);
    for (const table of [
      "vertex_execution_projections",
      "vertex_native_fact_projections",
      "vertex_native_journal_proofs",
      "vertex_native_reconciliations",
      "vertex_native_approval_audit",
    ]) {
      expect(h.data(table)).toEqual([]);
    }
    return expect(
      h.data("vertex_projection_heads")[0]!["high_water_sequence"]
    ).toBe("1");
  });
  it("rechecks current scoped project grants after verifier return and before duplicate ACK", async () => {
    const f = await fixture();
    const h = await harness(f);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    const count = writes(h.queries).length;
    h.verify.mockImplementation(async () => {
      h.authorize.mockResolvedValue(false);
      return f.receipt;
    });
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(writes(h.queries)).toHaveLength(count);
  });
  it("rejects absent verifier, false, true, null and unavailable verifier instead of accepting caller permission", async () => {
    const f = await fixture();
    const h = await harness(f);
    await expect(
      createNativeOutboxReplayOperations(h.ctx).replayNativeOutbox(
        principal,
        scope,
        f.replay
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    for (const invalid of [false, true, null]) {
      h.verify.mockResolvedValue(
        invalid as unknown as VertexVerifiedNativeApproval
      );
      await expect(
        h.ops.replayNativeOutbox(principal, scope, f.replay)
      ).rejects.toMatchObject({ code: "denied" });
    }
    h.verify.mockRejectedValue(new Error("evidence unavailable"));
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(writes(h.queries)).toEqual([]);
  });
  it("rejects changed projection/proof bytes and noncanonical originals before any write", async () => {
    const f = await fixture();
    const mutations = [
      {
        ...f.replay,
        rows: [
          {
            ...f.replay.rows[0]!,
            projectionBase64: blob({
              ...f.fact.value,
              idempotencyKey: "changed",
            }),
          },
          ...f.replay.rows.slice(1),
        ],
      },
      {
        ...f.replay,
        rows: [
          {
            ...f.replay.rows[0]!,
            proofBase64: blob({ ...f.fact.proof, sourceEventId: "changed" }),
          },
          ...f.replay.rows.slice(1),
        ],
      },
      {
        ...f.replay,
        rows: [
          {
            ...f.replay.rows[0]!,
            projectionBase64: base64(
              new TextEncoder().encode(
                `${canonicalArtifactJson(f.fact.value)} `
              )
            ),
          },
          ...f.replay.rows.slice(1),
        ],
      },
    ];
    for (const input of mutations) {
      const h = await harness(f);
      await expect(
        h.ops.replayNativeOutbox(principal, scope, input)
      ).rejects.toMatchObject({ code: "integrity" });
      expect(writes(h.queries)).toEqual([]);
    }
  });
  it("rejects noncontiguous, omitted, extra, reordered and unlisted rows", async () => {
    const f = await fixture();
    const variants = [
      { ...f.replay, rows: f.replay.rows.slice(1) },
      { ...f.replay, rows: [...f.replay.rows, f.replay.rows[0]] },
      {
        ...f.replay,
        rows: [f.replay.rows[1], f.replay.rows[0], f.replay.rows[2]],
      },
      {
        ...f.replay,
        grant: {
          ...f.replay.grant,
          rows: [
            { ...f.replay.grant.rows[0]!, sequence: "4" },
            ...f.replay.grant.rows.slice(1),
          ],
        },
      },
      { ...f.replay, callerApproved: true },
    ];
    for (const input of variants) {
      const h = await harness(f);
      await expect(
        h.ops.replayNativeOutbox(principal, scope, input)
      ).rejects.toMatchObject({ code: "invalid" });
      expect(writes(h.queries)).toEqual([]);
    }
  });
  it("denies wrong account, native service principal, live scope and replay resource grant", async () => {
    const f = await fixture();
    for (const [actor, target] of [
      [principal, { ...scope, accountAlias: "foreign" }],
      [{ actorId: "worker-human" }, scope],
      [principal, { ...scope, environment: "live" }],
    ] as const) {
      const h = await harness(f);
      await expect(
        h.ops.replayNativeOutbox(actor, target, f.replay)
      ).rejects.toMatchObject({ code: "denied" });
      expect(writes(h.queries)).toEqual([]);
    }
    const h = await harness(f);
    h.authorize.mockImplementation(
      async (request) => request.resourceId !== "native-outbox-replay"
    );
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.verify).not.toHaveBeenCalled();
  });
  it("rejects future original times and expires the grant during verification without partial commit", async () => {
    const f = await fixture();
    const future = await nativeFixture(f.old.sourceEventHash, {
      occurredAt: LATER,
      receivedAt: LATER,
      expiresAt: "2026-09-22T12:20:00.000000001Z",
    });
    const input = await packet(
      [{ kind: "native-fact", value: future.value, proof: future.bytes }],
      "1",
      f.old.sourceEventHash
    );
    const h = await harness(f);
    h.verify.mockResolvedValue(input.receipt);
    await expect(
      h.ops.replayNativeOutbox(principal, scope, input.replay)
    ).rejects.toMatchObject({ code: "invalid" });
    h.verify.mockImplementation(async () => {
      h.control.now = LATER;
      return f.receipt;
    });
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    return expect(writes(h.queries)).toEqual([]);
  });
  it("rejects a missing non-prefix row and a consumed approval with missing history", async () => {
    const f = await fixture();
    const h = await harness(f);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    h.data("vertex_native_fact_projections").splice(0);
    const count = writes(h.queries).length;
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "conflict" });
    expect(writes(h.queries)).toHaveLength(count);
    const allMissing = await harness(f);
    await allMissing.ops.replayNativeOutbox(principal, scope, f.replay);
    allMissing.data("vertex_execution_projections").splice(0);
    allMissing.data("vertex_native_fact_projections").splice(0);
    allMissing.data("vertex_portfolio_snapshots").splice(1);
    return await expect(
      allMissing.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("never appends a missing old row after transition, including ordinary direct append", async () => {
    const f = await fixture();
    const h = await harness(f);
    Object.assign(h.data("vertex_projection_heads")[0]!, {
      owner_epoch: "2",
      high_water_sequence: "1",
      high_water_event_hash: "9".repeat(64),
    });
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      createNativeFactOperations(h.ctx).appendNativeFactProjection(
        principal,
        scope,
        f.fact.value,
        f.fact.bytes
      )
    ).rejects.toMatchObject({ code: "stale" });
    expect(h.data("vertex_native_fact_projections")).toEqual([]);
    expect(h.data("vertex_native_journal_proofs")).toEqual([]);
    return expect(h.data("vertex_projection_heads")[0]!["owner_epoch"]).toBe(
      "2"
    );
  });
  it("ACKs only wholly known old rows after transition without overwriting the active head", async () => {
    const f = await fixture();
    const h = await harness(f);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    const newHash = "9".repeat(64);
    Object.assign(h.data("vertex_projection_heads")[0]!, {
      owner_epoch: "2",
      high_water_sequence: "1",
      high_water_event_hash: newHash,
    });
    const count = writes(h.queries).length;
    expect(await h.ops.replayNativeOutbox(principal, scope, f.replay)).toEqual({
      status: "duplicate",
      highWaterSequence: "1",
      highWaterEventHash: newHash,
    });
    return expect(writes(h.queries)).toHaveLength(count);
  });
  it("rejects retained proof corruption even for exact already-applied retries", async () => {
    const f = await fixture();
    const h = await harness(f);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    h.data("vertex_native_journal_proofs")[0]!["canonical_json"] = "{}";
    const count = writes(h.queries).length;
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(writes(h.queries)).toHaveLength(count);
  });
  it("rolls back receipt signer substitution or status rollback between the two current verifications", async () => {
    const f = await fixture();
    for (const changed of [
      { ...f.receipt, signerKeySha256: "1".repeat(64) },
      { ...f.receipt, statusSha256: "2".repeat(64) },
    ]) {
      const h = await harness(f);
      h.verify.mockResolvedValueOnce(f.receipt).mockResolvedValueOnce(changed);
      await expect(
        h.ops.replayNativeOutbox(principal, scope, f.replay)
      ).rejects.toMatchObject({ code: "conflict" });
      expect(h.data("vertex_projection_heads")[0]!["high_water_sequence"]).toBe(
        "1"
      );
      expect(h.data("vertex_native_approval_audit")).toEqual([]);
    }
  });
  it("recovers retained transition 1-to-2 under current replay owner 3 and then applies the original epoch2 suffix in one transaction", async () => {
    const f = await retainedTransitionFixture();
    const h = await harness(f.old);
    h.verify.mockResolvedValue(f.receipt);
    expect(await h.ops.replayNativeOutbox(principal, scope, f.replay)).toEqual({
      status: "applied",
      highWaterSequence: "2",
      highWaterEventHash: f.fact.value.eventHash,
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toEqual(["begin", "commit"]);
    expect(h.data("vertex_projection_heads")[0]!["owner_epoch"]).toBe("2");
    expect(
      h
        .data("vertex_portfolio_snapshots")
        .find((row) => row["snapshot_id"] === f.snapshot.snapshotId)?.[
        "payload"
      ]
    ).toEqual(f.snapshot);
    expect(h.data("vertex_portfolio_epoch_transitions")[0]!["payload"]).toEqual(
      f.transition
    );
    expect(h.data("vertex_portfolio_epoch_transitions")[0]).toMatchObject({
      authorization_kind: "retained-replay",
      authorizing_replay_request_sha256: await hash(f.replay),
      authorizing_signer_key_sha256: f.receipt.signerKeySha256,
      authorizing_approval_id: f.receipt.approvalId,
    });
    expect(h.data("vertex_native_approval_audit")).toHaveLength(1);
    expect(h.data("vertex_native_approval_audit")[0]!["action"]).toBe(
      "native-outbox-replay"
    );
    return expect(h.verify).toHaveBeenCalledTimes(2);
  });
  it("ACKs a retained transition and full suffix again without rewinding an already newer cloud head", async () => {
    const f = await retainedTransitionFixture();
    const h = await harness(f.old);
    h.verify.mockResolvedValue(f.receipt);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    const advanced = "8".repeat(64);
    Object.assign(h.data("vertex_projection_heads")[0]!, {
      owner_epoch: "3",
      high_water_sequence: "1",
      high_water_event_hash: advanced,
    });
    const count = writes(h.queries).length;
    expect(await h.ops.replayNativeOutbox(principal, scope, f.replay)).toEqual({
      status: "duplicate",
      highWaterSequence: "1",
      highWaterEventHash: advanced,
    });
    return expect(writes(h.queries)).toHaveLength(count);
  });
  it("does not treat an omitted sidecar or mismatched prior cloud head as transition authority", async () => {
    const f = await retainedTransitionFixture();
    const omitted = await packet(f.sources, "0", null, {
      priorOwnerEpoch: "2",
      currentOwnerEpoch: "3",
      journalSequence: "9",
    });
    const h = await harness(f.old);
    h.verify.mockResolvedValue(omitted.receipt);
    await expect(
      h.ops.replayNativeOutbox(principal, scope, omitted.replay)
    ).rejects.toMatchObject({ code: "stale" });
    h.verify.mockResolvedValue(f.receipt);
    h.data("vertex_projection_heads")[0]!["high_water_event_hash"] = "7".repeat(
      64
    );
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(writes(h.queries)).toEqual([]);
  });
  it("rejects changed retained bytes, mismatched genesis bytes and unpaired sidecar fields before writes", async () => {
    const f = await retainedTransitionFixture();
    const badGenesis = {
      ...f.transition,
      snapshot: { ...f.snapshot, cash: "999" },
    };
    const remapped = await packet(
      f.sources,
      "0",
      null,
      { priorOwnerEpoch: "2", currentOwnerEpoch: "3", journalSequence: "9" },
      badGenesis
    );
    for (const input of [
      {
        value: {
          ...f.replay,
          retainedEpochTransitionBase64: blob({
            ...f.transition,
            transitionId: "altered",
          }),
        },
        code: "integrity",
      },
      { value: remapped.replay, code: "integrity" },
      {
        value: { ...f.replay, retainedEpochTransitionBase64: null },
        code: "invalid",
      },
      {
        value: {
          ...f.replay,
          grant: { ...f.replay.grant, retainedEpochTransitionSha256: null },
        },
        code: "invalid",
      },
    ]) {
      const h = await harness(f.old);
      await expect(
        h.ops.replayNativeOutbox(principal, scope, input.value)
      ).rejects.toMatchObject({ code: input.code });
      expect(writes(h.queries)).toEqual([]);
      expect(h.verify).not.toHaveBeenCalled();
    }
  });
  it("requires a current independent approval even when all original signed transition bytes are retained", async () => {
    const f = await retainedTransitionFixture();
    const h = await harness(f.old);
    h.verify.mockResolvedValue(null);
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    expect(writes(h.queries)).toEqual([]);
    return expect(h.data("vertex_projection_heads")[0]!["owner_epoch"]).toBe(
      "1"
    );
  });
  it("rolls back retained transition history, genesis, suffix and current audit together on final revocation", async () => {
    const f = await retainedTransitionFixture();
    const h = await harness(f.old);
    h.verify.mockResolvedValueOnce(f.receipt).mockResolvedValueOnce(null);
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.data("vertex_projection_heads")[0]!["owner_epoch"]).toBe("1");
    expect(h.data("vertex_portfolio_snapshots")).toHaveLength(1);
    for (const table of [
      "vertex_portfolio_epoch_transitions",
      "vertex_native_fact_projections",
      "vertex_native_approval_audit",
    ]) {
      expect(h.data(table)).toEqual([]);
    }
    return expect(h.lifecycle).toEqual(["begin", "rollback"]);
  });
  return it("never recreates missing retained transition history with an already consumed current approval", async () => {
    const f = await retainedTransitionFixture();
    const h = await harness(f.old);
    h.verify.mockResolvedValue(f.receipt);
    await h.ops.replayNativeOutbox(principal, scope, f.replay);
    h.data("vertex_portfolio_epoch_transitions").splice(0);
    const count = writes(h.queries).length;
    await expect(
      h.ops.replayNativeOutbox(principal, scope, f.replay)
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(writes(h.queries)).toHaveLength(count);
  });
});
