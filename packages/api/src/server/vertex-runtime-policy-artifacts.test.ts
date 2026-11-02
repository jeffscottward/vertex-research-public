import type { Transaction } from "@darkfactory/db/server";
import { withTransactionReadScope } from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import { vertexQualifiedObjectKey } from "@darkfactory/storage";
import type * as DbVertex from "@darkfactory/db/server/vertex";
import { createVertexRuntimePolicyArtifacts } from "./vertex-runtime-policy-artifacts.ts";

// Grants are out of scope here: every ACL check allows. Rights stay real.
vi.mock("@darkfactory/db/server/vertex", async (importOriginal) => ({
  ...(await importOriginal<typeof DbVertex>()),
  createVertexAuthorization: () => ({ authorize: async () => true }),
}));

const scope = {
  accountAlias: "fixture-account",
  environment: "paper",
} as const;
const AT = "2026-06-01T00:00:00Z";

const rightsRow = async (status: "granted" | "expired") => {
  const payload = {
    allowedUses: ["read"],
    checkedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    policyId: "corpus-rights",
    retentionUntil: null,
    status,
    version: status === "granted" ? "1.0.0" : "2.0.0",
  };
  return {
    checked_at_ns: timestampToEpochNanoseconds(payload.checkedAt).toString(),
    expires_at_ns: timestampToEpochNanoseconds(payload.expiresAt).toString(),
    payload,
    policy_id: payload.policyId,
    record_hash: await hashArtifact(payload),
    retention_until_ns: null,
    status,
    version: payload.version,
  };
};

// Each `run` call is one transaction; `latest` stands for the committed head
// that a fresh statement in that transaction would observe.
const database = () => {
  const committed: { latest: Record<string, unknown> | null } = {
    latest: null,
  };
  let reads = 0;
  const run = <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> =>
    withTransactionReadScope(operation)({
      execute: async () => {
        reads += 1;
        return { rows: committed.latest ? [committed.latest] : [] };
      },
    } as unknown as Transaction);
  return { committed, run, reads: () => reads };
};

const artifacts = createVertexRuntimePolicyArtifacts({
  clock: { now: () => AT },
  objectCapabilities: () => {
    throw new Error("not used");
  },
});

const check = (tx: Transaction, at = AT) =>
  artifacts.currentRights(tx, scope, "corpus-rights", "1.0.0", at);

describe("runtime policy rights reuse", () => {
  it("reads current rights once per transaction and re-validates every use", async () => {
    const db = database();
    db.committed.latest = await rightsRow("granted");
    await db.run(async (tx) => {
      for (let step = 0; step < 5; step++) await check(tx);
      // Time bounds are still checked on each cached use.
      await expect(check(tx, "2027-01-01T00:00:00Z")).rejects.toThrow();
    });
    expect(db.reads()).toBe(1);
  });

  it("enforces a revoke committed mid-run from the next transaction", async () => {
    const db = database();
    db.committed.latest = await rightsRow("granted");
    await db.run(async (tx) => {
      await check(tx);
      // Another transaction commits an expired revision while this one runs.
      db.committed.latest = await rightsRow("expired");
      // Documented boundary: the open transaction keeps its first observation.
      await check(tx);
    });
    // The next transaction (next step) sees the revoke and fails closed.
    await expect(db.run((tx) => check(tx))).rejects.toThrow();
  });

  it("does not remember an absent row", async () => {
    const db = database();
    await db.run(async (tx) => {
      await expect(check(tx)).rejects.toThrow();
      db.committed.latest = await rightsRow("granted");
      await check(tx);
    });
    expect(db.reads()).toBe(2);
  });
});

describe("rights recheck after object I/O", () => {
  const principal = { actorId: "fixture-reader" };
  const setup = async () => {
    const document = { schemaVersion: "1.0.0", note: "fixture" };
    const body = new TextEncoder().encode(canonicalArtifactJson(document));
    const sha = await hashArtifact(document);
    const pin = {
      artifactId: "fixture-artifact",
      artifactSha256: sha,
      contractName: "FixtureDocument",
      schemaVersion: "1.0.0",
    };
    const key = vertexQualifiedObjectKey(scope, null, "manifest", sha);
    const granted = await rightsRow("granted");
    const metadata = {
      scope,
      collectionId: null,
      artifactId: pin.artifactId,
      artifactSha256: sha,
      contractName: pin.contractName,
      schemaVersion: pin.schemaVersion,
      objectKey: key,
      byteLength: body.byteLength,
      rights: { policyId: "corpus-rights", version: "1.0.0" },
    };
    const catalog = {
      payload: metadata,
      metadata_hash: await hashArtifact(metadata),
      artifact_sha256: sha,
      object_key: key,
      byte_length: String(body.byteLength),
      rights_policy_id: "corpus-rights",
      rights_version: "1.0.0",
    };
    const committed = {
      rights: granted as Record<string, unknown>,
      objectReads: 0,
    };
    const expired = await rightsRow("expired");
    const reader = createVertexRuntimePolicyArtifacts({
      clock: { now: () => AT },
      objectCapabilities: () =>
        ({
          head: async () => ({
            status: "ok",
            value: { key, size: body.byteLength },
          }),
          getBounded: async () => {
            // Another transaction expires the rights during the object read.
            committed.rights = expired;
            committed.objectReads += 1;
            return {
              status: "ok",
              value: { body, metadata: { key, size: body.byteLength } },
            };
          },
        }) as never,
    });
    const run = <T>(operation: (tx: Transaction) => Promise<T>) =>
      withTransactionReadScope(operation)({
        execute: async (query: unknown) => ({
          rows: JSON.stringify(query).includes("vertex_artifacts")
            ? [catalog]
            : [committed.rights],
        }),
      } as unknown as Transaction);
    return { reader, run, pin, committed };
  };

  it("denies a selected artifact when rights change during its object read", async () => {
    const { reader, run, pin, committed } = await setup();
    await expect(
      run((tx) => reader.readSelectedArtifact(tx, principal, scope, pin))
    ).rejects.toThrow();
    // The denial comes from the recheck after the read, not an earlier step.
    expect(committed.objectReads).toBe(1);
  });

  it("denies a host receipt when rights change during its object read", async () => {
    const { reader, run, pin, committed } = await setup();
    await expect(
      run((tx) =>
        reader.readHostReceipt(
          tx,
          principal,
          scope,
          pin,
          "corpus-rights",
          "1.0.0"
        )
      )
    ).rejects.toThrow();
    expect(committed.objectReads).toBe(1);
  });
});
