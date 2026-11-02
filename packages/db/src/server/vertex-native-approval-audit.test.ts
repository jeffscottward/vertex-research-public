import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database, Transaction } from "./client.ts";
import {
  assertSameNativeApproval,
  captureVerifiedNativeApproval,
  createNativeApprovalAuditOperations,
  type VertexNativeApprovalAction,
  type VertexNativeApprovalBinding,
  type VertexVerifiedNativeApproval,
} from "./vertex-native-approval-audit.ts";
import {
  createPersistenceContext,
  type Row,
} from "./vertex-persistence-core.ts";
import type { VertexProjectionResult, VertexScope } from "./vertex-ports.ts";

// Source-only deferred tests. Synthetic envelopes contain no authentic human
// signatures; ONLY the trusted runtime verifier can produce production receipts.
const at = "2026-09-22T12:00:00.000000001Z";
const expiresAt = "2026-09-22T12:10:00.000000001Z";
const scope: VertexScope = {
  accountAlias: "synthetic-approval-account",
  environment: "paper",
};
const principal = { actorId: "synthetic-service" };
const outcome: VertexProjectionResult = {
  status: "applied",
  highWaterSequence: "1",
  highWaterEventHash: "a".repeat(64),
};
const approval = async (
  action: VertexNativeApprovalAction = "owner-epoch-transition",
  changes: Partial<VertexVerifiedNativeApproval> = {},
  account: VertexScope = scope
) => {
  const receipt: VertexVerifiedNativeApproval = {
    signerKeyId: "enrolled-human-key",
    signerKeySha256: "b".repeat(64),
    approvalId: "approval-1",
    nonce: "c".repeat(64),
    actorId: "synthetic-human",
    action,
    subjectSha256: "d".repeat(64),
    approvalSha256: "0".repeat(64),
    statusRevision: "10",
    statusSha256: "e".repeat(64),
    expiresAt,
    ...changes,
  };
  const subject =
    action === "owner-epoch-transition"
      ? { transitionSha256: receipt.subjectSha256 }
      : { replaySha256: receipt.subjectSha256 };
  const envelope = {
    keyId: receipt.signerKeyId,
    payload: {
      format: "vertex-native-approval-v1",
      ...account,
      action,
      actorId: receipt.actorId,
      approvalId: receipt.approvalId,
      nonce: receipt.nonce,
      subject,
      expiresNs: timestampToEpochNanoseconds(receipt.expiresAt).toString(),
    },
    signatureHex: "0".repeat(128),
  };
  const proof = canonicalArtifactJson(envelope);
  const verified = {
    ...receipt,
    approvalSha256: await hashArtifact(new TextEncoder().encode(proof)),
  };
  const binding: VertexNativeApprovalBinding = {
    action,
    requestId: "request-1",
    requestSha256: "f".repeat(64),
    streamId: "native-stream",
    approvalBase64: btoa(proof),
  };
  return { receipt: verified, binding };
};
const harness = () => {
  let persisted: Row[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (value: SQL) => {
    const query = dialect.sqlToQuery(value);
    queries.push(query);
    if (query.sql.startsWith("select pg_advisory")) return { rows: [] };
    if (query.sql.startsWith("select * from vertex_native_approval_audit")) {
      return {
        rows: persisted.filter(
          (row) =>
            row["signer_key_sha256"] === query.params[0] &&
            (row["nonce"] === query.params[1] ||
              row["approval_id"] === query.params[2])
        ),
      };
    }
    if (query.sql.startsWith("insert into vertex_native_approval_audit")) {
      const columns = query.sql
        .slice(query.sql.indexOf("(") + 1, query.sql.indexOf(")"))
        .split(",");
      const row = Object.fromEntries(
        columns.map((column, index) => [
          column,
          column === "payload" || column === "outcome"
            ? JSON.parse(query.params[index] as string)
            : query.params[index],
        ])
      );
      if (
        persisted.some(
          (previous) =>
            previous["signer_key_sha256"] === row["signer_key_sha256"] &&
            (previous["nonce"] === row["nonce"] ||
              previous["approval_id"] === row["approval_id"])
        )
      )
        throw Object.assign(new Error("Unique violation"), { code: "23505" });
      persisted.push(row);
      return { rows: [] };
    }
    throw new Error("Unexpected audit fixture query");
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
      const before = structuredClone(persisted);
      try {
        return await operation(tx);
      } catch (error) {
        persisted = before;
        throw error;
      } finally {
        release();
      }
    }
  );
  const ctx = createPersistenceContext({ transaction } as unknown as Database, {
    boundary: {
      validate: (_name, value) => value as Row,
      encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
      digest: (bytes) => hashArtifact(bytes),
    },
    authorization: { authorize: async () => true },
    clock: { now: () => at },
    maxProjectionAgeMs: 10_000,
  });
  const operations = createNativeApprovalAuditOperations(ctx);
  return {
    tx,
    ctx,
    operations,
    queries,
    transaction,
    persisted: () => persisted,
  };
};

describe("shared immutable native approval audit", () => {
  it("records full canonical signed proof and verification receipt atomically with permanent global nonce identity", async () => {
    const test = harness();
    const { binding, receipt } = await approval();
    await test.transaction(async (tx) => {
      expect(
        await test.operations.checkNativeApprovalInTransaction(
          tx,
          principal,
          scope,
          binding,
          receipt,
          at
        )
      ).toBe("new");
      return await test.operations.recordNativeApprovalInTransaction(
        tx,
        principal,
        scope,
        binding,
        receipt,
        outcome,
        at
      );
    });
    expect(test.persisted()).toHaveLength(1);
    expect(test.persisted()[0]).toMatchObject({
      signer_key_sha256: receipt.signerKeySha256,
      approval_id: receipt.approvalId,
      nonce: receipt.nonce,
      approval_base64: binding.approvalBase64,
      action: binding.action,
      recipient_actor_id: principal.actorId,
      outcome,
      payload: { receipt, outcome },
    });
    const lookups = test.queries.filter((query) =>
      query.sql.includes("from vertex_native_approval_audit")
    );
    expect(
      lookups.every(
        (query) =>
          !(
            query.sql.includes("account_alias =") ||
            query.sql.includes("action =")
          )
      )
    ).toBe(true);
    return expect(
      test.queries.some(
        (query) =>
          query.sql.includes("pg_advisory_xact_lock") &&
          query.params.includes(
            JSON.stringify(["vertex-native-approval", receipt.signerKeySha256])
          )
      )
    ).toBe(true);
  });

  it("allows an exact request ACK under newer valid status without rewriting the first audit", async () => {
    const test = harness();
    const { binding, receipt } = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      binding,
      receipt,
      outcome,
      at
    );
    const first = structuredClone(test.persisted()[0]);
    const refreshed = {
      ...receipt,
      statusRevision: "11",
      statusSha256: "1".repeat(64),
    };
    expect(
      await test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        refreshed,
        at
      )
    ).toBe("duplicate");
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      binding,
      refreshed,
      { ...outcome, status: "duplicate", highWaterSequence: "8" },
      at
    );
    expect(test.persisted()).toEqual([first]);
    return expect(
      test.queries.filter((query) => query.sql.startsWith("insert"))
    ).toHaveLength(1);
  });

  it.each(["rollback", "same-revision-equivocation"])(
    "rejects current status %s while retaining original history",
    async (kind) => {
      const test = harness();
      const { binding, receipt } = await approval();
      await test.operations.recordNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        receipt,
        outcome,
        at
      );
      const changed = {
        ...receipt,
        statusRevision: kind === "rollback" ? "9" : receipt.statusRevision,
        statusSha256: "2".repeat(64),
      };
      return await expect(
        test.operations.checkNativeApprovalInTransaction(
          test.tx,
          principal,
          scope,
          binding,
          changed,
          at
        )
      ).rejects.toMatchObject({ code: "conflict" });
    }
  );

  it("rejects nonce reuse across epoch-transition and outbox-replay purposes", async () => {
    const test = harness();
    const initial = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      initial.binding,
      initial.receipt,
      outcome,
      at
    );
    const replay = await approval("native-outbox-replay", {
      approvalId: "approval-2",
    });
    await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        replay.binding,
        replay.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(test.persisted()).toHaveLength(1);
  });

  it("rejects approval-ID reuse even with a fresh nonce", async () => {
    const test = harness();
    const initial = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      initial.binding,
      initial.receipt,
      outcome,
      at
    );
    const replacement = await approval("owner-epoch-transition", {
      nonce: "3".repeat(64),
    });
    return await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        replacement.binding,
        replacement.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects cross-account reuse globally rather than hiding history behind current scope", async () => {
    const test = harness();
    const initial = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      initial.binding,
      initial.receipt,
      outcome,
      at
    );
    const foreignScope: VertexScope = {
      ...scope,
      accountAlias: "other-account",
    };
    const foreign = await approval("owner-epoch-transition", {}, foreignScope);
    return await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        foreignScope,
        foreign.binding,
        foreign.receipt,
        at
      )
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it.each(["recipient", "request", "stream", "request-hash"])(
    "rejects changed %s on a previously consumed approval",
    async (kind) => {
      const test = harness();
      const { binding, receipt } = await approval();
      await test.operations.recordNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        receipt,
        outcome,
        at
      );
      const recipient =
        kind === "recipient" ? { actorId: "other-service" } : principal;
      const changed = {
        ...binding,
        ...(kind === "request"
          ? { requestId: "other-request" }
          : kind === "stream"
            ? { streamId: "other-stream" }
            : kind === "request-hash"
              ? { requestSha256: "4".repeat(64) }
              : {}),
      };
      return await expect(
        test.operations.checkNativeApprovalInTransaction(
          test.tx,
          recipient,
          scope,
          changed,
          receipt,
          at
        )
      ).rejects.toMatchObject({ code: "conflict" });
    }
  );

  it("binds immutable raw-key version rather than trusting a reused textual key ID", async () => {
    const test = harness();
    const initial = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      initial.binding,
      initial.receipt,
      outcome,
      at
    );
    const rotated = await approval("owner-epoch-transition", {
      signerKeySha256: "5".repeat(64),
    });
    expect(
      await test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        rotated.binding,
        rotated.receipt,
        at
      )
    ).toBe("new");
    // Only independent current enrollment can establish that rotated receipt.
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      rotated.binding,
      rotated.receipt,
      outcome,
      at
    );
    return expect(test.persisted()).toHaveLength(2);
  });

  it("rejects generic true, null, unexpected receipt keys and expired receipts", async () => {
    const test = harness();
    const { receipt } = await approval();
    for (const input of [
      true,
      null,
      { ...receipt, verified: true },
      { ...receipt, expiresAt: at },
    ]) {
      expect(() =>
        captureVerifiedNativeApproval(test.ctx, input, at)
      ).toThrow();
    }
    return expect(test.persisted()).toHaveLength(0);
  });

  it("cannot claim a receipt whose exact signed bytes or subject binding changed", async () => {
    const test = harness();
    const { binding, receipt } = await approval();
    await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        { ...receipt, approvalSha256: "0".repeat(64) },
        at
      )
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        { ...receipt, subjectSha256: "0".repeat(64) },
        at
      )
    ).rejects.toMatchObject({ code: "integrity" });
    const noncanonical = {
      ...binding,
      approvalBase64: btoa(`${atob(binding.approvalBase64)} `),
    };
    return await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        noncanonical,
        receipt,
        at
      )
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects stored payload or normalized metadata corruption", async () => {
    const test = harness();
    const { binding, receipt } = await approval();
    await test.operations.recordNativeApprovalInTransaction(
      test.tx,
      principal,
      scope,
      binding,
      receipt,
      outcome,
      at
    );
    test.persisted()[0]!["request_sha256"] = "0".repeat(64);
    return await expect(
      test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        receipt,
        at
      )
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("rolls audit consumption back with failed enclosing state writes", async () => {
    const test = harness();
    const { binding, receipt } = await approval();
    await expect(
      test.transaction(async (tx) => {
        await test.operations.recordNativeApprovalInTransaction(
          tx,
          principal,
          scope,
          binding,
          receipt,
          outcome,
          at
        );
        throw new Error("simulated state CAS failure");
      })
    ).rejects.toThrow("simulated state CAS failure");
    expect(test.persisted()).toHaveLength(0);
    return expect(
      await test.operations.checkNativeApprovalInTransaction(
        test.tx,
        principal,
        scope,
        binding,
        receipt,
        at
      )
    ).toBe("new");
  });

  it("permits exactly one cross-purpose claim in the serialized transaction fixture", async () => {
    const test = harness();
    const epoch = await approval();
    const replay = await approval("native-outbox-replay");
    const results = await Promise.allSettled(
      [epoch, replay].map((value) =>
        test.transaction((tx) =>
          test.operations.recordNativeApprovalInTransaction(
            tx,
            principal,
            scope,
            value.binding,
            value.receipt,
            outcome,
            at
          )
        )
      )
    );
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    return expect(test.persisted()).toHaveLength(1);
  });

  return it("rejects stable metadata changes between the two independent verifier passes", async () => {
    const { receipt } = await approval();
    expect(() =>
      assertSameNativeApproval(receipt, {
        ...receipt,
        signerKeySha256: "0".repeat(64),
      })
    ).toThrow();
    return expect(() =>
      assertSameNativeApproval(receipt, {
        ...receipt,
        statusRevision: "11",
        statusSha256: "0".repeat(64),
      })
    ).not.toThrow();
  });
});
