import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  NativeOutboxReplaySchema,
  PortfolioEpochTransitionSchema,
} from "../../../api/src/contracts/vertex-worker-epoch.ts";
import {
  computePortfolioGenesisHash,
  PortfolioSnapshotSchema,
} from "../../../api/src/vertex.ts";
import type { Database, Transaction } from "./client.ts";
import { createEpochTransitionOperations } from "./vertex-epoch-store.ts";
import {
  createNativeApprovalAuditOperations,
  type VertexNativeApprovalBinding,
  type VertexVerifiedNativeApproval,
} from "./vertex-native-approval-audit.ts";
import {
  createPersistenceContext,
  type Row,
} from "./vertex-persistence-core.ts";
import type {
  VertexBoundary,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createProjectionIngestion } from "./vertex-projection-ingestion.ts";
import { createProjectionOperations } from "./vertex-projection-store.ts";

// Authored only. This transactional SQL-recording fixture is not a PostgreSQL
// migration/concurrency proof or a real human approval/native verifier.
const at = "2026-09-22T12:00:00.000000001Z";
const scope: VertexScope = {
  accountAlias: "synthetic-epoch-account",
  environment: "paper",
};
const principal = { actorId: "synthetic-native-emitter" };
const snapshot = async (ownerEpoch = "2", cash = "73") => {
  const hash = "0".repeat(64);
  const value = PortfolioSnapshotSchema.parse({
    schemaVersion: "1.0.0",
    snapshotId: `restored-${ownerEpoch}`,
    ...scope,
    streamId: "paper-stream",
    ownerEpoch,
    sequence: "1",
    sourceEventHash: hash,
    sourceKind: "paper-simulation",
    asOfAt: at,
    receivedAt: at,
    currency: "USD",
    cash,
    netAssetValue: "93",
    positions: [
      {
        instrumentId: "synthetic-share",
        quantity: "2",
        marketValue: "20",
        costBasis: "16",
        currency: "USD",
        priceAsOf: at,
        sleeveId: "sleeve-a",
      },
    ],
    lots: [
      {
        lotId: "existing-lot",
        instrumentId: "synthetic-share",
        quantity: "2",
        unitCost: "8",
        currency: "USD",
        openedAt: at,
        sourceEventId: "existing-fill",
      },
    ],
    reservations: [
      {
        reservationId: "existing-reservation",
        submissionKey: "existing-submission",
        instrumentId: "synthetic-share",
        cashAmount: "3",
        shareQuantity: "1",
        currency: "USD",
        state: "reserved",
        sourceEventId: "existing-order",
        authoritative: false,
      },
    ],
    sleeveAllocations: [
      {
        sleeveId: "sleeve-a",
        allocatedAmount: "50",
        currency: "USD",
        sourceEventId: "existing-allocation",
        authoritative: false,
      },
    ],
    continuity: {
      ...scope,
      streamId: "paper-stream",
      ownerEpoch,
      highWaterSequence: "1",
      highWaterEventHash: hash,
      lastOccurredAt: at,
      lastReceivedAt: at,
      evaluatedAt: at,
      freshness: {
        status: "fresh",
        observedAt: at,
        evaluatedAt: at,
        maxAgeMs: 10_000,
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
  return PortfolioSnapshotSchema.parse({
    ...value,
    sourceEventHash,
    continuity: { ...value.continuity, highWaterEventHash: sourceEventHash },
  });
};

const snapshotRow = async (
  value: Awaited<ReturnType<typeof snapshot>>
): Promise<Row> => ({
  ...scope,
  account_alias: scope.accountAlias,
  environment: scope.environment,
  snapshot_id: value.snapshotId,
  stream_id: value.streamId,
  owner_epoch: value.ownerEpoch,
  sequence: value.sequence,
  source_event_hash: value.sourceEventHash,
  source_kind: value.sourceKind,
  received_at_ns: timestampToEpochNanoseconds(value.receivedAt).toString(),
  as_of_at_ns: timestampToEpochNanoseconds(value.asOfAt).toString(),
  record_hash: await hashArtifact(value),
  payload: value,
});
type Query = Readonly<{ sql: string; params: unknown[] }>;
const harness = async () => {
  const old = await snapshot("1");
  const restored = await snapshot();
  const expiresAt = "2026-09-22T12:10:00.000000001Z";
  const approvalEnvelope = {
    keyId: "synthetic-human-key",
    payload: {
      format: "vertex-native-approval-v1",
      ...scope,
      action: "owner-epoch-transition",
      actorId: "synthetic-human-approver",
      approvalId: "approval-a",
      nonce: "9".repeat(64),
      subject: { transitionSha256: "8".repeat(64) },
      expiresNs: timestampToEpochNanoseconds(expiresAt).toString(),
    },
    signatureHex: "0".repeat(128),
  };
  const approvalBase64 = btoa(canonicalArtifactJson(approvalEnvelope));
  const receipt: VertexVerifiedNativeApproval = {
    signerKeyId: "synthetic-human-key",
    signerKeySha256: "7".repeat(64),
    approvalId: "approval-a",
    nonce: "9".repeat(64),
    actorId: "synthetic-human-approver",
    action: "owner-epoch-transition",
    subjectSha256: "8".repeat(64),
    approvalSha256: await hashArtifact(approvalEnvelope),
    statusRevision: "1",
    statusSha256: "6".repeat(64),
    expiresAt,
  };
  const transition = PortfolioEpochTransitionSchema.parse({
    schemaVersion: "1.0.0",
    transitionId: "transition-a",
    snapshot: restored,
    priorOwnerEpoch: "1",
    priorProjectionSequence: "1",
    priorProjectionHash: old.sourceEventHash,
    journalIdentity: "native-journal",
    journalSequence: "47",
    journalHeadSha256: "a".repeat(64),
    nativeOutboxEvidenceSha256: "b".repeat(64),
    nativeOwnerFenceSha256: "c".repeat(64),
    approvalBase64,
  });
  const expectedSha = await hashArtifact(transition);
  let tables: Record<string, Row[]> = {
    vertex_projection_heads: [
      {
        account_alias: scope.accountAlias,
        environment: scope.environment,
        stream_id: old.streamId,
        owner_epoch: "1",
        high_water_sequence: "1",
        high_water_event_hash: old.sourceEventHash,
        last_occurred_at: at,
        last_received_at: at,
        expires_at_ns: (
          timestampToEpochNanoseconds(at) + 10_000_000_001n
        ).toString(),
        state: "continuous",
        received_sequence: null,
      },
    ],
    vertex_portfolio_snapshots: [await snapshotRow(old)],
  };
  const queries: Query[] = [];
  const lifecycle: string[] = [];
  const control = { loseCAS: false };
  const dialect = new PgDialect();
  const execute = vi.fn(async (value: SQL) => {
    const query = dialect.sqlToQuery(value);
    queries.push(query);
    const { sql: text, params: p } = query;
    if (text.startsWith("select pg_advisory")) return { rows: [] };
    if (text.includes("from vertex_native_approval_audit")) {
      return {
        rows: (tables["vertex_native_approval_audit"] ?? []).filter(
          (row) =>
            row["signer_key_sha256"] === p[0] &&
            (text.includes("and request_sha256")
              ? row["approval_id"] === p[1] && row["request_sha256"] === p[2]
              : row["nonce"] === p[1] || row["approval_id"] === p[2])
        ),
      };
    }
    const from = /from "([a-z_]+)"/.exec(text)?.[1];
    if (from) {
      const records = (tables[from] ?? []).filter(
        (row) => row["account_alias"] === p[0] && row["environment"] === p[1]
      );
      let found: Row[] = [];
      if (from === "vertex_projection_heads") {
        found = records.filter((row) => row["stream_id"] === p[2]);
      } else if (from === "vertex_portfolio_epoch_transitions") {
        found = records.filter(
          (row) =>
            row["transition_id"] === p[2] ||
            (row["stream_id"] === p[3] &&
              (row["owner_epoch"] === p[4] ||
                row["prior_owner_epoch"] === p[5]))
        );
      } else if (from === "vertex_portfolio_snapshots") {
        if (text.includes("exists (select 1")) {
          found = records.filter((row) =>
            (tables["vertex_projection_heads"] ?? []).some(
              (head) =>
                head["stream_id"] === row["stream_id"] &&
                head["owner_epoch"] === row["owner_epoch"]
            )
          );
        } else if (text.includes("snapshot_id =") && text.includes(" or ")) {
          found = records.filter(
            (row) =>
              row["snapshot_id"] === p[2] ||
              (row["stream_id"] === p[3] && row["owner_epoch"] === p[4])
          );
        } else if (text.includes("snapshot_id =")) {
          found = records.filter((row) => row["snapshot_id"] === p[2]);
        } else
          found = records.filter(
            (row) => row["stream_id"] === p[2] && row["owner_epoch"] === p[3]
          );
      } else if (text.includes("applied = false or owner_epoch")) {
        found = records.filter(
          (row) =>
            row["stream_id"] === p[2] &&
            (row["applied"] === false || row["owner_epoch"] === p[3])
        );
      } else if (text.includes("applied = true")) {
        found = records.filter(
          (row) =>
            row["stream_id"] === p[2] &&
            row["owner_epoch"] === p[3] &&
            row["sequence"] === p[4] &&
            row["event_hash"] === p[5] &&
            row["applied"] === true
        );
      } else found = records.filter((row) => row["projection_id"] === p[2]);
      return { rows: found.slice(0, 1) };
    }
    const inserted = /^insert into "?([a-z_]+)"? \(([^)]+)\)/.exec(text);
    if (inserted) {
      const columns = [...inserted[2]!.matchAll(/"?([a-z0-9_]+)"?/g)].map(
        (match) => match[1]!
      );
      const row = Object.fromEntries(
        columns.map((column, index) => [
          column,
          column === "payload" || column === "outcome"
            ? JSON.parse(p[index] as string)
            : p[index],
        ])
      );
      (tables[inserted[1]!] ??= []).push(row);
      return { rows: [] };
    }
    if (text.startsWith("update vertex_projection_heads")) {
      if (control.loseCAS) return { rows: [] };
      const head = (tables["vertex_projection_heads"] ?? [])[0]!;
      if (
        head["owner_epoch"] !== p[9] ||
        head["high_water_sequence"] !== p[10] ||
        head["high_water_event_hash"] !== p[11]
      )
        return { rows: [] };
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
    return { rows: [] };
  });
  const tx = { execute } as unknown as Transaction;
  let queue = Promise.resolve();
  const transaction = vi.fn(
    async (operation: (transaction: Transaction) => Promise<unknown>) => {
      const previous = queue;
      let release: () => void = () => undefined;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = structuredClone(tables);
      lifecycle.push("begin");
      try {
        const result = await operation(tx);
        // Model the deferred exact-triple FK only; PostgreSQL behavior remains
        // unexecuted and must be verified in the eventual authorized DB gate.
        for (const epoch of tables["vertex_portfolio_epoch_transitions"] ??
          []) {
          if (
            epoch["authorization_kind"] === "retained-replay" &&
            !(tables["vertex_native_approval_audit"] ?? []).some(
              (audit) =>
                audit["signer_key_sha256"] ===
                  epoch["authorizing_signer_key_sha256"] &&
                audit["approval_id"] === epoch["authorizing_approval_id"] &&
                audit["request_sha256"] ===
                  epoch["authorizing_replay_request_sha256"]
            )
          )
            throw Object.assign(new Error("Deferred recovery audit FK"), {
              code: "23503",
            });
        }
        lifecycle.push("commit");
        return result;
      } catch (error) {
        tables = before;
        lifecycle.push("rollback");
        throw error;
      } finally {
        release();
      }
    }
  );
  const boundary: VertexBoundary = {
    validate: (name, value) =>
      name === "NativeOutboxReplay"
        ? NativeOutboxReplaySchema.parse(value)
        : name === "PortfolioEpochTransition"
          ? PortfolioEpochTransitionSchema.parse(value)
          : PortfolioSnapshotSchema.parse(value),
    encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
    digest: (bytes) => hashArtifact(bytes),
  };
  const authorize = vi.fn(
    async (_input: Readonly<{ resourceId: string }>) => true
  );
  const verify = vi.fn(
    async (
      input: Readonly<{ transition: VertexRecord; transitionSha256: string }>
    ): Promise<VertexVerifiedNativeApproval | null> =>
      input.transitionSha256 === expectedSha &&
      (await hashArtifact(input.transition)) === expectedSha
        ? receipt
        : null
  );
  const ctx = createPersistenceContext({ transaction } as unknown as Database, {
    boundary,
    authorization: { authorize },
    clock: { now: () => at },
    maxProjectionAgeMs: 10_000,
  });
  const operations = createEpochTransitionOperations(ctx, {
    verifyNativeEpochTransition: verify,
  });
  return {
    old,
    restored,
    transition,
    receipt,
    queries,
    lifecycle,
    control,
    ctx,
    operations,
    verify,
    authorize,
    transaction,
    tx,
    table: (name: string) => tables[name] ?? [],
    add: (name: string, row: Row) => {
      (tables[name] ??= []).push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        ...row,
      });
    },
  };
};

const retainedReplay = async (
  test: Awaited<ReturnType<typeof harness>>,
  original: VertexRecord = test.transition
) => {
  const restored = original["snapshot"] as VertexRecord;
  const originalBytes = canonicalArtifactJson(original);
  const projectionBytes = canonicalArtifactJson(restored);
  const unsigned = {
    schemaVersion: "1.0.0",
    grantId: "fresh-recovery",
    ...scope,
    streamId: restored["streamId"],
    priorOwnerEpoch: restored["ownerEpoch"],
    currentOwnerEpoch: "3",
    serviceActorId: principal.actorId,
    startingSequence: "0",
    startingEventHash: null,
    journalIdentity: "native-journal",
    journalSequence: "60",
    journalHeadSha256: "a".repeat(64),
    nativeJournalEvidenceSha256: "b".repeat(64),
    nativeOwnerFenceSha256: "c".repeat(64),
    retainedEpochTransitionSha256: await hashArtifact(
      new TextEncoder().encode(originalBytes)
    ),
    issuedAt: at,
    expiresAt: test.receipt.expiresAt,
    rows: [
      {
        projectionId: restored["snapshotId"],
        sequence: "1",
        eventHash: restored["sourceEventHash"],
        projectionRawSha256: await hashArtifact(
          new TextEncoder().encode(projectionBytes)
        ),
        kind: "portfolio-genesis",
        proofSha256: null,
      },
    ],
  };
  const subjectSha256 = await hashArtifact(unsigned);
  const proof = {
    keyId: test.receipt.signerKeyId,
    payload: {
      format: "vertex-native-approval-v1",
      ...scope,
      action: "native-outbox-replay",
      actorId: test.receipt.actorId,
      approvalId: "fresh-replay-approval",
      nonce: "4".repeat(64),
      subject: { replaySha256: subjectSha256 },
      expiresNs: timestampToEpochNanoseconds(test.receipt.expiresAt).toString(),
    },
    signatureHex: "0".repeat(128),
  };
  const approvalBase64 = btoa(canonicalArtifactJson(proof));
  const receipt: VertexVerifiedNativeApproval = {
    ...test.receipt,
    approvalId: "fresh-replay-approval",
    nonce: "4".repeat(64),
    action: "native-outbox-replay",
    subjectSha256,
    approvalSha256: await hashArtifact(proof),
  };
  const replay = NativeOutboxReplaySchema.parse({
    grant: { ...unsigned, approvalBase64 },
    retainedEpochTransitionBase64: btoa(originalBytes),
    rows: [
      {
        kind: "portfolio-genesis",
        projectionBase64: btoa(projectionBytes),
        proofBase64: null,
      },
    ],
  });
  const binding: VertexNativeApprovalBinding = {
    action: "native-outbox-replay",
    requestId: unsigned.grantId,
    requestSha256: await hashArtifact(replay),
    streamId: String(restored["streamId"]),
    approvalBase64,
  };
  return { replay, receipt, binding, original };
};

describe("explicit native owner epoch observation", () => {
  it("retains old economics/history and atomically normalizes the exact restored checkpoint without seeding", async () => {
    const test = await harness();
    expect(
      await test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).toEqual({
      status: "applied",
      highWaterSequence: "1",
      highWaterEventHash: test.restored.sourceEventHash,
    });
    expect(test.lifecycle).toEqual(["begin", "commit"]);
    expect(test.verify).toHaveBeenCalledTimes(2);
    expect(
      test
        .table("vertex_portfolio_snapshots")
        .map((row) => (row["payload"] as VertexRecord)["cash"])
    ).toEqual(["73", "73"]);
    for (const table of [
      "vertex_portfolio_positions",
      "vertex_portfolio_lots",
      "vertex_reservation_observations",
      "vertex_sleeve_observations",
    ]) {
      expect(test.table(table)).toHaveLength(1);
    }
    expect(test.table("vertex_portfolio_lots")[0]).toMatchObject({
      lot_id: "existing-lot",
      unit_cost: "8",
    });
    expect(test.table("vertex_reservation_observations")[0]).toMatchObject({
      cash_amount: "3",
      share_quantity: "1",
      authoritative: false,
    });
    expect(test.table("vertex_portfolio_epoch_transitions")[0]).toMatchObject({
      prior_owner_epoch: "1",
      owner_epoch: "2",
      journal_sequence: "47",
      prior_projection_sequence: "1",
      authoritative: false,
      execution_authorized: false,
    });
    return expect(
      test.queries.some((query) => /delete|truncate/i.test(query.sql))
    ).toBe(false);
  });

  it("fails unavailable with no verifier and never treats the wire as a verification result", async () => {
    const test = await harness();
    const absent = createEpochTransitionOperations(test.ctx);
    await expect(
      absent.transitionPortfolioEpoch(principal, scope, test.transition)
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(test.table("vertex_portfolio_epoch_transitions")).toHaveLength(0);
    return await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        verified: true,
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("requires both exact current project resources without broadening worker grants", async () => {
    const test = await harness();
    test.authorize.mockImplementation(
      async (input) => input.resourceId !== "owner-epoch-transition"
    );
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(test.verify).not.toHaveBeenCalled();
    return expect(
      test.table("vertex_projection_heads")[0]!["owner_epoch"]
    ).toBe("1");
  });

  it.each([
    "missing-drain",
    "missing-fence",
    "revoked-approver",
    "invalid-signature",
  ])("rejects independent native verifier denial: %s", async (_reason) => {
    const test = await harness();
    test.verify.mockResolvedValue(null);
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(test.table("vertex_portfolio_snapshots")).toHaveLength(1);
  });

  it("sanitizes verifier exceptions without persisting incomplete evidence", async () => {
    const test = await harness();
    test.verify.mockRejectedValue(new Error("private verifier diagnostic"));
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(
      test.table("vertex_portfolio_epoch_transitions")
    ).toHaveLength(0);
  });

  it.each([
    "journalHeadSha256",
    "nativeOutboxEvidenceSha256",
    "nativeOwnerFenceSha256",
  ])("rejects rebound proof digest %s", async (field) => {
    const test = await harness();
    return await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        [field]: "d".repeat(64),
      })
    ).rejects.toMatchObject({ code: "denied" });
  });

  it("rejects canonical-but-changed restored balances through the independently bound verifier", async () => {
    const test = await harness();
    const changed = await snapshot("2", "100");
    await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        snapshot: changed,
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(test.table("vertex_portfolio_snapshots")).toHaveLength(1);
  });

  it("rejects tampered genesis before verification and writes", async () => {
    const test = await harness();
    await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        snapshot: { ...test.restored, cash: "74" },
      })
    ).rejects.toMatchObject({ code: "integrity" });
    return expect(test.verify).not.toHaveBeenCalled();
  });

  it.each(["vertex_execution_projections", "vertex_native_fact_projections"])(
    "refuses pending mixed facts in %s rather than silently retiring them",
    async (table) => {
      const test = await harness();
      test.add(table, {
        stream_id: "paper-stream",
        owner_epoch: "1",
        sequence: "3",
        applied: false,
      });
      await expect(
        test.operations.transitionPortfolioEpoch(
          principal,
          scope,
          test.transition
        )
      ).rejects.toMatchObject({ code: "conflict" });
      return expect(
        test.table("vertex_projection_heads")[0]!["owner_epoch"]
      ).toBe("1");
    }
  );

  it("refuses a mismatched prior head and nonincreasing epoch", async () => {
    const test = await harness();
    test.table("vertex_projection_heads")[0]!["high_water_event_hash"] =
      "e".repeat(64);
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "conflict" });
    return await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        snapshot: test.old,
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rolls back all normalized rows when native authority changes before commit", async () => {
    const test = await harness();
    test.verify.mockResolvedValueOnce(test.receipt).mockResolvedValueOnce(null);
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(test.lifecycle).toEqual(["begin", "rollback"]);
    expect(test.table("vertex_portfolio_epoch_transitions")).toHaveLength(0);
    expect(test.table("vertex_portfolio_positions")).toHaveLength(0);
    expect(test.table("vertex_portfolio_snapshots")).toHaveLength(1);
    return expect(test.table("vertex_native_approval_audit")).toHaveLength(0);
  });

  it("rechecks resource authorization after verifier return before committing", async () => {
    const test = await harness();
    test.verify
      .mockImplementationOnce(async () => test.receipt)
      .mockImplementationOnce(async () => {
        test.authorize.mockResolvedValue(false);
        return test.receipt;
      });
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      test.table("vertex_portfolio_epoch_transitions")
    ).toHaveLength(0);
  });

  it("CAS race loss rolls back snapshots and lineage instead of advancing another owner", async () => {
    const test = await harness();
    test.control.loseCAS = true;
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "conflict" });
    expect(test.table("vertex_portfolio_snapshots")).toHaveLength(1);
    expect(test.table("vertex_native_approval_audit")).toHaveLength(0);
    const update = test.queries.find((query) =>
      query.sql.startsWith("update vertex_projection_heads")
    )!;
    expect(update.sql).toContain("owner_epoch =");
    expect(update.sql).toContain("high_water_sequence =");
    expect(update.sql).toContain("high_water_event_hash =");
    return expect(update.params.slice(-6)).toEqual([
      scope.accountAlias,
      scope.environment,
      "paper-stream",
      "1",
      "1",
      test.old.sourceEventHash,
    ]);
  });

  it("exact retry verifies stored lineage and snapshot but returns advanced head without rewinding", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    Object.assign(test.table("vertex_projection_heads")[0]!, {
      high_water_sequence: "8",
      high_water_event_hash: "f".repeat(64),
    });
    const writes = test.queries.filter((query) =>
      /^(insert|update)/.test(query.sql)
    ).length;
    expect(
      await test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).toEqual({
      status: "duplicate",
      highWaterSequence: "8",
      highWaterEventHash: "f".repeat(64),
    });
    expect(
      test.queries.filter((query) => /^(insert|update)/.test(query.sql))
    ).toHaveLength(writes);
    return expect(
      test.table("vertex_portfolio_epoch_transitions")
    ).toHaveLength(1);
  });

  it("rejects corrupted stored evidence and conflicting transition identity even with a permissive verifier fixture", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    test.verify.mockResolvedValue(test.receipt);
    await expect(
      test.operations.transitionPortfolioEpoch(principal, scope, {
        ...test.transition,
        transitionId: "conflicting-id",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    test.table("vertex_portfolio_epoch_transitions")[0]![
      "native_owner_fence_sha256"
    ] = "d".repeat(64);
    return await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("serializes duplicate attempts in the fixture and writes one immutable lineage", async () => {
    const test = await harness();
    const results = await Promise.all([
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      ),
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    expect(test.table("vertex_portfolio_epoch_transitions")).toHaveLength(1);
    return expect(
      test.queries.filter((query) =>
        query.sql.includes("pg_advisory_xact_lock")
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("exposes the worker transaction callback without opening a nested transaction", async () => {
    const test = await harness();
    expect(
      await test.operations.transitionPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        test.transition,
        at
      )
    ).toMatchObject({ status: "applied" });
    return expect(test.transaction).not.toHaveBeenCalled();
  });

  it("returns only current-epoch economics and never relabels delayed old snapshots", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    const projections = createProjectionOperations(test.ctx);
    const current = await projections.currentPortfolio(test.tx, scope, at);
    expect(current).toMatchObject({
      ownerEpoch: "2",
      snapshotId: "restored-2",
      cash: "73",
      continuity: { ownerEpoch: "2", highWaterSequence: "1" },
    });
    test.table("vertex_portfolio_snapshots").splice(1, 1);
    expect(await projections.currentPortfolio(test.tx, scope, at)).toBeNull();
    return expect(
      test.queries.some((query) =>
        query.sql.includes(
          "h.owner_epoch = vertex_portfolio_snapshots.owner_epoch"
        )
      )
    ).toBe(true);
  });

  it.each(["order", "native-fact"] as const)(
    "retired %s projections cannot mutate new head or normalize facts",
    async (kind) => {
      const test = await harness();
      await test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      );
      const normalize = vi.fn(async (): Promise<void> => undefined);
      const oldProjection: VertexRecord = {
        projectionId: "late-old-projection",
        streamId: "paper-stream",
        ownerEpoch: "1",
        sequence: "2",
        eventHash: "e".repeat(64),
        previousEventHash: test.old.sourceEventHash,
        idempotencyKey: "late-old",
        sourceKind: "paper-simulation",
      };
      const writes = test.queries.filter((query) =>
        /^(insert|update)/.test(query.sql)
      ).length;
      await expect(
        createProjectionIngestion(test.ctx).append(
          test.tx,
          scope,
          oldProjection,
          at,
          kind,
          normalize
        )
      ).rejects.toMatchObject({ code: "stale" });
      expect(normalize).not.toHaveBeenCalled();
      expect(
        test.queries.filter((query) => /^(insert|update)/.test(query.sql))
      ).toHaveLength(writes);
      return expect(test.table("vertex_projection_heads")[0]).toMatchObject({
        owner_epoch: "2",
        state: "continuous",
        high_water_sequence: "1",
      });
    }
  );

  it("retains an applied prior order chain and never equates journal high-water with projection high-water", async () => {
    const test = await harness();
    const identity = {
      projectionId: "prior-order",
      streamId: "paper-stream",
      ownerEpoch: "1",
      sequence: "2",
      idempotencyKey: "prior-order-key",
      sourceKind: "paper-simulation",
    };
    const eventHash = await hashArtifact(identity);
    test.add("vertex_execution_projections", {
      projection_id: identity.projectionId,
      stream_id: identity.streamId,
      owner_epoch: "1",
      sequence: "2",
      event_hash: eventHash,
      applied: true,
      payload: { ...identity, eventHash },
    });
    Object.assign(test.table("vertex_projection_heads")[0]!, {
      high_water_sequence: "2",
      high_water_event_hash: eventHash,
    });
    test.verify.mockResolvedValue(test.receipt);
    const transition = {
      ...test.transition,
      priorProjectionSequence: "2",
      priorProjectionHash: eventHash,
    };
    expect(
      await test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        transition
      )
    ).toMatchObject({ status: "applied" });
    expect(test.table("vertex_execution_projections")).toHaveLength(1);
    return expect(
      test.table("vertex_portfolio_epoch_transitions")[0]
    ).toMatchObject({
      journal_sequence: "47",
      prior_projection_sequence: "2",
      prior_projection_hash: eventHash,
    });
  });

  // validate() hashes each input with WebCrypto before the transaction queue, so
  // the order in which two concurrent calls enter the serialized fixture depends
  // on thread-pool completion, not on call order. Each case fixes the order: it
  // holds the later caller's digest until the earlier one is inside its lock.
  it.each([
    ["transition-a", "competing-transition"],
    ["competing-transition", "transition-a"],
  ])(
    "allows only one competing transition from the same prior owner when %s locks first",
    async (winner, loser) => {
      const test = await harness();
      let releaseLoser: () => void = () => undefined;
      const winnerLocked = new Promise<void>((resolve) => {
        releaseLoser = resolve;
      });
      test.verify.mockImplementation(async () => {
        releaseLoser();
        return test.receipt;
      });
      // Gate on the async WebCrypto hash step: a window selects that path
      // (server runtimes otherwise hash synchronously and leave no gate).
      vi.stubGlobal("window", globalThis);
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const loserMarker = `"transitionId":"${loser}"`;
      let held = 0;
      const spy = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation(async (algorithm, data) => {
          if (
            new TextDecoder()
              .decode(data as Uint8Array<ArrayBuffer>)
              .includes(loserMarker)
          ) {
            held += 1;
            await winnerLocked;
          }
          return digest(algorithm, data);
        });
      try {
        const ids = ["transition-a", "competing-transition"];
        const results = await Promise.allSettled(
          ids.map((transitionId) =>
            test.operations.transitionPortfolioEpoch(principal, scope, {
              ...test.transition,
              transitionId,
            })
          )
        );
        // The gate engaged, so the order below is forced, not chance.
        expect(held).toBeGreaterThan(0);
        expect(results[ids.indexOf(winner)]).toMatchObject({
          status: "fulfilled",
          value: { status: "applied" },
        });
        expect(results[ids.indexOf(loser)]).toMatchObject({
          status: "rejected",
          reason: { code: "conflict" },
        });
        expect(test.table("vertex_portfolio_epoch_transitions")).toEqual([
          expect.objectContaining({ transition_id: winner }),
        ]);
        return expect(test.table("vertex_portfolio_snapshots")).toHaveLength(2);
      } finally {
        spy.mockRestore();
      }
    }
  );

  it("treats an exact previously applied retired-order retry as inert, not epoch-mismatch", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    const value: VertexRecord = {
      projectionId: "historical-order",
      streamId: "paper-stream",
      ownerEpoch: "1",
      sequence: "2",
      eventHash: "a".repeat(64),
      idempotencyKey: "historical-key",
    };
    test.add("vertex_execution_projections", {
      projection_id: value["projectionId"],
      event_hash: value["eventHash"],
      applied: true,
      payload: value,
    });
    const normalize = vi.fn(async (): Promise<void> => undefined);
    const writes = test.queries.filter((query) =>
      /^(insert|update)/.test(query.sql)
    ).length;
    expect(
      await createProjectionIngestion(test.ctx).append(
        test.tx,
        scope,
        value,
        at,
        "order",
        normalize
      )
    ).toMatchObject({
      status: "duplicate",
      highWaterSequence: "1",
      highWaterEventHash: test.restored.sourceEventHash,
    });
    expect(normalize).not.toHaveBeenCalled();
    return expect(
      test.queries.filter((query) => /^(insert|update)/.test(query.sql))
    ).toHaveLength(writes);
  });

  it("atomically consumes approval with transition and permits only an exact ACK under refreshed status", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    const first = structuredClone(
      test.table("vertex_native_approval_audit")[0]
    );
    expect(first).toMatchObject({
      request_id: "transition-a",
      action: "owner-epoch-transition",
      recipient_actor_id: principal.actorId,
    });
    test.verify.mockResolvedValue({
      ...test.receipt,
      statusRevision: "2",
      statusSha256: "5".repeat(64),
    });
    expect(
      await test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).toMatchObject({ status: "duplicate" });
    expect(test.table("vertex_native_approval_audit")).toEqual([first]);
    test.table("vertex_portfolio_epoch_transitions").splice(0);
    return await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });

  return it("rejects a generic true verifier result and a current revocation even on an exact retry", async () => {
    const test = await harness();
    test.verify.mockResolvedValue(
      true as unknown as VertexVerifiedNativeApproval
    );
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    test.verify.mockResolvedValue(test.receipt);
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    test.verify.mockResolvedValue(null);
    await expect(
      test.operations.transitionPortfolioEpoch(
        principal,
        scope,
        test.transition
      )
    ).rejects.toMatchObject({ code: "denied" });
    return expect(test.table("vertex_native_approval_audit")).toHaveLength(1);
  });
});

describe("fresh replay ratification of an original retained epoch transition", () => {
  it("restores cloud epoch1 to original genesis2 under current owner3 replay authority without pretending owner2 is current", async () => {
    const test = await harness();
    const oldProof = JSON.parse(atob(test.transition.approvalBase64));
    oldProof.payload.expiresNs = (
      timestampToEpochNanoseconds(at) - 1n
    ).toString();
    const original = {
      ...test.transition,
      approvalBase64: btoa(canonicalArtifactJson(oldProof)),
    };
    const recovery = await retainedReplay(test, original);
    await test.transaction(async (tx) => {
      const result =
        await test.operations.restoreRetainedPortfolioEpochInTransaction(
          tx,
          principal,
          scope,
          recovery.replay,
          recovery.receipt,
          at
        );
      expect(result).toMatchObject({
        status: "applied",
        highWaterSequence: "1",
      });
      return await createNativeApprovalAuditOperations(
        test.ctx
      ).recordNativeApprovalInTransaction(
        tx,
        principal,
        scope,
        recovery.binding,
        recovery.receipt,
        result!,
        at
      );
    });
    expect(test.verify).not.toHaveBeenCalled();
    expect(test.table("vertex_projection_heads")[0]).toMatchObject({
      owner_epoch: "2",
      high_water_sequence: "1",
    });
    expect(test.table("vertex_portfolio_epoch_transitions")[0]).toMatchObject({
      payload: original,
      transition_sha256: recovery.replay.grant.retainedEpochTransitionSha256,
      authorization_kind: "retained-replay",
      authorizing_replay_request_sha256: recovery.binding.requestSha256,
      authorizing_signer_key_sha256: recovery.receipt.signerKeySha256,
      authorizing_approval_id: recovery.receipt.approvalId,
    });
    expect(test.table("vertex_portfolio_snapshots")).toHaveLength(2);
    return expect(test.table("vertex_native_approval_audit")).toHaveLength(1);
  });

  it("cannot commit retained recovery without its exact final replay audit triple", async () => {
    const test = await harness();
    const recovery = await retainedReplay(test);
    await expect(
      test.transaction((tx) =>
        test.operations.restoreRetainedPortfolioEpochInTransaction(
          tx,
          principal,
          scope,
          recovery.replay,
          recovery.receipt,
          at
        )
      )
    ).rejects.toMatchObject({ code: "23503" });
    expect(test.table("vertex_projection_heads")[0]!["owner_epoch"]).toBe("1");
    expect(test.table("vertex_portfolio_epoch_transitions")).toHaveLength(0);
    await expect(
      test.transaction(async (tx) => {
        const result =
          await test.operations.restoreRetainedPortfolioEpochInTransaction(
            tx,
            principal,
            scope,
            recovery.replay,
            recovery.receipt,
            at
          );
        return await createNativeApprovalAuditOperations(
          test.ctx
        ).recordNativeApprovalInTransaction(
          tx,
          principal,
          scope,
          { ...recovery.binding, requestSha256: "0".repeat(64) },
          recovery.receipt,
          result!,
          at
        );
      })
    ).rejects.toMatchObject({ code: "23503" });
    return expect(test.table("vertex_native_approval_audit")).toHaveLength(0);
  });

  it("ACKs existing exact direct transition2 without rewriting provenance or rewinding its advanced head", async () => {
    const test = await harness();
    await test.operations.transitionPortfolioEpoch(
      principal,
      scope,
      test.transition
    );
    Object.assign(test.table("vertex_projection_heads")[0]!, {
      high_water_sequence: "5",
      high_water_event_hash: "f".repeat(64),
    });
    const originalRow = structuredClone(
      test.table("vertex_portfolio_epoch_transitions")[0]
    );
    const recovery = await retainedReplay(test);
    const result =
      await test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        recovery.receipt,
        at
      );
    expect(result).toMatchObject({
      status: "duplicate",
      highWaterSequence: "5",
    });
    expect(test.table("vertex_portfolio_epoch_transitions")).toEqual([
      originalRow,
    ]);
    return expect(originalRow).toMatchObject({
      authorization_kind: "direct",
      authorizing_replay_request_sha256: null,
      authorizing_signer_key_sha256: null,
      authorizing_approval_id: null,
    });
  });

  it("permits retained replay duplicates only with exact committed original history and never rolls epoch3 back", async () => {
    const test = await harness();
    const recovery = await retainedReplay(test);
    await test.transaction(async (tx) => {
      const result =
        await test.operations.restoreRetainedPortfolioEpochInTransaction(
          tx,
          principal,
          scope,
          recovery.replay,
          recovery.receipt,
          at
        );
      return await createNativeApprovalAuditOperations(
        test.ctx
      ).recordNativeApprovalInTransaction(
        tx,
        principal,
        scope,
        recovery.binding,
        recovery.receipt,
        result!,
        at
      );
    });
    Object.assign(test.table("vertex_projection_heads")[0]!, {
      owner_epoch: "3",
      high_water_sequence: "4",
      high_water_event_hash: "f".repeat(64),
    });
    expect(
      await test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        recovery.receipt,
        at
      )
    ).toMatchObject({ status: "duplicate", highWaterSequence: "4" });
    expect(test.table("vertex_projection_heads")[0]!["owner_epoch"]).toBe("3");
    test.table("vertex_portfolio_epoch_transitions").splice(0);
    return await expect(
      test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        recovery.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });

  return it("rejects old-purpose or absent current receipts, mutated sidecars and wrong prior heads without writes", async () => {
    const test = await harness();
    const recovery = await retainedReplay(test);
    await expect(
      test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        test.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        null as unknown as VertexVerifiedNativeApproval,
        at
      )
    ).rejects.toMatchObject({ code: "denied" });
    const changed = {
      ...recovery.replay,
      retainedEpochTransitionBase64: btoa(
        canonicalArtifactJson({
          ...test.transition,
          transitionId: "changed-original",
        })
      ),
    };
    await expect(
      test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        changed,
        recovery.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "integrity" });
    test.table("vertex_projection_heads")[0]!["high_water_sequence"] = "2";
    await expect(
      test.operations.restoreRetainedPortfolioEpochInTransaction(
        test.tx,
        principal,
        scope,
        recovery.replay,
        recovery.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(
      test.table("vertex_portfolio_epoch_transitions")
    ).toHaveLength(0);
  });
});
