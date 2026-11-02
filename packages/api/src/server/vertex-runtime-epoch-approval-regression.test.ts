import { describe, expect, it } from "vitest";
import {
  canonical,
  decodeBase64,
  hashArtifact,
  rawSha,
} from "./vertex-runtime-epoch-bytes.ts";
import {
  toVertexVerifiedNativeApproval,
  verifyVertexHistoricalEpochApproval,
  verifyVertexNativeApproval,
  type VertexEpochAuthority,
  type VertexNativeApprovalBinding,
} from "./vertex-runtime-epoch-approval.ts";

// Unexecuted regression definitions. The deterministic seed below is PUBLIC
// TEST MATERIAL, never enrollment/default config. No keys are created at import.
const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const testKey = async (byte: number) => {
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
    0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array(48);
  der.set(prefix);
  der.fill(byte, 16);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    true,
    ["sign"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const publicText = jwk.x!.replace(/-/g, "+").replace(/_/g, "/");
  return {
    key,
    publicKeyBase64: publicText.padEnd(
      Math.ceil(publicText.length / 4) * 4,
      "="
    ),
  };
};
const sign = async (
  keyId: string,
  payload: Record<string, unknown>,
  key: CryptoKey
) => {
  const prefix = new TextEncoder().encode(
    "vertex-native-approval-signature-v1\0"
  );
  const body = canonical({ keyId, payload });
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, message)
  );
  const signatureHex = Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return { keyId, payload, signatureHex };
};
const fixture = async () => {
  const signer = await testKey(1);
  const statusSigner = await testKey(2);
  const common = {
    policyId: "fixture-policy",
    policySha256: "a".repeat(64),
    policyVersion: "1.0.0",
    accountAlias: "fixture-account",
    environment: "paper" as const,
    simulatorId: "fixture-simulator",
    currency: "USD",
  };
  const statusPayload = {
    ...common,
    format: "vertex-native-approval-status-v1",
    revision: "1",
    checkedNs: "100",
    expiresNs: "200",
    revokedKeyIds: [] as string[],
    revokedApprovalIds: [] as string[],
    revokedNonces: [] as string[],
  };
  const approvalPayload = {
    ...common,
    format: "vertex-native-approval-v1",
    approvalId: "fixture-approval",
    nonce: "b".repeat(64),
    actorId: "fixture-approver",
    ownerEpoch: "2",
    action: "owner-epoch-transition",
    issuedNs: "100",
    expiresNs: "200",
    subject: { transitionSha256: "c".repeat(64) },
  };
  const status = await sign("fixture-status", statusPayload, statusSigner.key);
  const approval = await sign("fixture-approver", approvalPayload, signer.key);
  const authority: VertexEpochAuthority = {
    configuredAtNs: "100",
    validUntilNs: "200",
    policy: {
      ...common,
      maximumApprovalTtlNs: "100",
      maximumStatusAgeNs: "100",
    },
    keys: [
      {
        keyId: "fixture-approver",
        actorId: "fixture-approver",
        publicKeyBase64: signer.publicKeyBase64,
        roles: ["approval"],
        notBeforeNs: "0",
        expiresNs: "1000",
      },
      {
        keyId: "fixture-status",
        actorId: "fixture-status-owner",
        publicKeyBase64: statusSigner.publicKeyBase64,
        roles: ["status"],
        notBeforeNs: "0",
        expiresNs: "1000",
      },
    ],
    statusKeyId: "fixture-status",
    currentStatusBase64: base64(canonical(status)),
    currentStatusSha256: await hashArtifact(status),
    minimumStatusRevision: "1",
    grants: [
      {
        grantId: "fixture-grant",
        keyId: "fixture-approver",
        actorId: "fixture-approver",
        requestingActorId: "fixture-emitter",
        accountAlias: "fixture-account",
        environment: "paper",
        simulatorId: "fixture-simulator",
        streamId: "fixture-stream",
        journalIdentity: "fixture-journal",
        action: "owner-epoch-transition",
        notBeforeNs: "100",
        expiresNs: "200",
        revoked: false,
      },
    ],
  };
  const binding: VertexNativeApprovalBinding = {
    action: "owner-epoch-transition",
    subject: { transitionSha256: "c".repeat(64) },
    accountAlias: "fixture-account",
    environment: "paper",
    simulatorId: "fixture-simulator",
    streamId: "fixture-stream",
    journalIdentity: "fixture-journal",
    ownerEpoch: "2",
  };
  return {
    authority,
    binding,
    approval,
    approvalPayload,
    statusPayload,
    signer,
    statusSigner,
    approvalBase64: base64(canonical(approval)),
  };
};

describe("independently enrolled native Ed25519 authority (deferred)", () => {
  it("verifies exact domain/canonical bytes with independent current status and scoped grant", async () => {
    const f = await fixture();
    const proof = await verifyVertexNativeApproval(
      f.authority,
      f.approvalBase64,
      f.binding,
      "fixture-emitter",
      150n
    );
    expect(proof).toMatchObject({
      approvalId: "fixture-approval",
      keyId: "fixture-approver",
      grantId: "fixture-grant",
      nativeTransitionSha256: "c".repeat(64),
      statusRevision: "1",
    });
    return expect(typeof proof).toBe("object");
  });
  it("returns exact trusted shared-ledger metadata, including real enrolled key fingerprint", async () => {
    const f = await fixture();
    const proof = await verifyVertexNativeApproval(
      f.authority,
      f.approvalBase64,
      f.binding,
      "fixture-emitter",
      150n
    );
    const receipt = toVertexVerifiedNativeApproval(proof);
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "signerKeyId",
        "signerKeySha256",
        "approvalId",
        "nonce",
        "actorId",
        "action",
        "subjectSha256",
        "approvalSha256",
        "statusRevision",
        "statusSha256",
        "expiresAt",
      ].sort()
    );
    expect(receipt.signerKeySha256).toBe(
      await rawSha(decodeBase64(f.signer.publicKeyBase64, 32))
    );
    expect(receipt.approvalSha256).toBe(
      await rawSha(decodeBase64(f.approvalBase64))
    );
    expect(receipt.expiresAt).toBe("1970-01-01T00:00:00.000000200Z");
    return expect(receipt.subjectSha256).toBe("c".repeat(64));
  });
  it.each(["revokedKeyIds", "revokedApprovalIds", "revokedNonces"] as const)(
    "rejects current signed revocation %s",
    async (field) => {
      const f = await fixture();
      f.statusPayload[field] = [
        field === "revokedKeyIds"
          ? "fixture-approver"
          : field === "revokedApprovalIds"
            ? "fixture-approval"
            : "b".repeat(64),
      ];
      const status = await sign(
        "fixture-status",
        f.statusPayload,
        f.statusSigner.key
      );
      const authority = {
        ...f.authority,
        currentStatusBase64: base64(canonical(status)),
        currentStatusSha256: await hashArtifact(status),
      };
      return await expect(
        verifyVertexNativeApproval(
          authority,
          f.approvalBase64,
          f.binding,
          "fixture-emitter",
          150n
        )
      ).rejects.toMatchObject({ code: "denied" });
    }
  );
  it("rejects subject changes even when envelope is otherwise canonical", async () => {
    const f = await fixture();
    return await expect(
      verifyVertexNativeApproval(
        f.authority,
        f.approvalBase64,
        { ...f.binding, subject: { transitionSha256: "d".repeat(64) } },
        "fixture-emitter",
        150n
      )
    ).rejects.toThrow();
  });
  it("rejects unsigned payload changes and forged worker bearer trust", async () => {
    const f = await fixture();
    f.approval.payload["ownerEpoch"] = "3";
    await expect(
      verifyVertexNativeApproval(
        f.authority,
        base64(canonical(f.approval)),
        { ...f.binding, ownerEpoch: "3" },
        "fixture-emitter",
        150n
      )
    ).rejects.toMatchObject({ code: "denied" });
    return await expect(
      verifyVertexNativeApproval(
        { ...f.authority, keys: [] },
        f.approvalBase64,
        f.binding,
        "fixture-emitter",
        150n
      )
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects stale status, downgraded status revision and wrong grant actor", async () => {
    const f = await fixture();
    await expect(
      verifyVertexNativeApproval(
        f.authority,
        f.approvalBase64,
        f.binding,
        "different-worker",
        150n
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      verifyVertexNativeApproval(
        { ...f.authority, minimumStatusRevision: "2" },
        f.approvalBase64,
        f.binding,
        "fixture-emitter",
        150n
      )
    ).rejects.toMatchObject({ code: "denied" });
    return await expect(
      verifyVertexNativeApproval(
        { ...f.authority, validUntilNs: "300" },
        f.approvalBase64,
        f.binding,
        "fixture-emitter",
        200n
      )
    ).rejects.toMatchObject({ code: "stale" });
  });
  return it("rejects a cross-purpose replay grant under epoch action", async () => {
    const f = await fixture();
    const grants = f.authority.grants.map((grant) => ({
      ...grant,
      action: "native-outbox-replay" as const,
    }));
    return await expect(
      verifyVertexNativeApproval(
        { ...f.authority, grants },
        f.approvalBase64,
        f.binding,
        "fixture-emitter",
        150n
      )
    ).rejects.toMatchObject({ code: "denied" });
  });
});

const historicalFixture = async () => {
  const old = await fixture();
  const currentSigner = await testKey(3);
  const nativeSubject = {
    account_alias: "fixture-account",
    environment: "paper",
    simulator_id: "fixture-simulator",
    stream_id: "fixture-stream",
    journal_identity: "fixture-journal",
    prior_owner_epoch: "1",
    current_owner_epoch: "2",
    prior_projection_sequence: "1",
    prior_projection_hash: "a".repeat(64),
    journal_sequence: "4",
    journal_head_sha256: "b".repeat(64),
    new_snapshot_sha256: "c".repeat(64),
    native_outbox_evidence_sha256: "d".repeat(64),
    native_owner_fence_sha256: "e".repeat(64),
  };
  const originalPayload = {
    ...old.approvalPayload,
    subject: { transitionSha256: await hashArtifact(nativeSubject) },
  };
  const original = await sign(
    "fixture-approver",
    originalPayload,
    old.signer.key
  );
  const statusPayload = {
    ...old.statusPayload,
    revision: "2",
    checkedNs: "300",
    expiresNs: "400",
  };
  const status = await sign(
    "fixture-status",
    statusPayload,
    old.statusSigner.key
  );
  const currentPayload = {
    ...old.approvalPayload,
    approvalId: "fixture-current-replay",
    nonce: "f".repeat(64),
    actorId: "fixture-ratifier",
    action: "native-outbox-replay",
    ownerEpoch: "3",
    issuedNs: "300",
    expiresNs: "400",
    subject: { replaySha256: "9".repeat(64) },
  };
  const current = await sign(
    "fixture-ratifier",
    currentPayload,
    currentSigner.key
  );
  const authority: VertexEpochAuthority = {
    ...old.authority,
    configuredAtNs: "300",
    validUntilNs: "400",
    minimumStatusRevision: "2",
    currentStatusBase64: base64(canonical(status)),
    currentStatusSha256: await hashArtifact(status),
    keys: [
      ...old.authority.keys.map((key) =>
        key.keyId === "fixture-approver" ? { ...key, expiresNs: "200" } : key
      ),
      {
        keyId: "fixture-ratifier",
        actorId: "fixture-ratifier",
        publicKeyBase64: currentSigner.publicKeyBase64,
        roles: ["approval"],
        notBeforeNs: "300",
        expiresNs: "1000",
      },
    ],
    grants: [
      {
        ...old.authority.grants[0]!,
        grantId: "fixture-current-grant",
        keyId: "fixture-ratifier",
        actorId: "fixture-ratifier",
        action: "native-outbox-replay",
        notBeforeNs: "300",
        expiresNs: "400",
      },
    ],
  };
  const fresh = {
    approvalBase64: base64(canonical(current)),
    binding: {
      ...old.binding,
      action: "native-outbox-replay" as const,
      subject: { replaySha256: "9".repeat(64) },
      ownerEpoch: "3",
    },
  };
  return {
    authority,
    nativeSubject,
    originalBase64: base64(canonical(original)),
    fresh,
    statusPayload,
    statusSigner: old.statusSigner,
    oldBinding: { ...old.binding, subject: originalPayload.subject },
  };
};

describe("historical epoch signatures under independent fresh replay ratification", () => {
  it("accepts expired original approval/key only as historical provenance under a different fresh signer", async () => {
    const f = await historicalFixture();
    const result = await verifyVertexHistoricalEpochApproval(
      f.authority,
      f.originalBase64,
      f.nativeSubject,
      "fixture-emitter",
      350n,
      f.fresh
    );
    expect(result.historicalApproval).toMatchObject({
      historicalOnly: true,
      approvalId: "fixture-approval",
      issuedNs: "100",
      expiresNs: "200",
      statusRevision: "2",
    });
    expect(result.ratification).toMatchObject({
      action: "native-outbox-replay",
      keyId: "fixture-ratifier",
      approvalId: "fixture-current-replay",
    });
    expect(result.historicalApproval.ratifyingApprovalSha256).toBe(
      result.ratification.approvalSha256
    );
    // Normal transition approval remains strict. Historical verification did
    // not restore this expired key/approval's current owner2 permission.
    return await expect(
      verifyVertexNativeApproval(
        f.authority,
        f.originalBase64,
        f.oldBinding,
        "fixture-emitter",
        350n
      )
    ).rejects.toThrow();
  });
  it.each(["revokedKeyIds", "revokedApprovalIds", "revokedNonces"] as const)(
    "rejects current historical revocation %s despite fresh ratification",
    async (field) => {
      const f = await historicalFixture();
      f.statusPayload[field] = [
        field === "revokedKeyIds"
          ? "fixture-approver"
          : field === "revokedApprovalIds"
            ? "fixture-approval"
            : "b".repeat(64),
      ];
      const status = await sign(
        "fixture-status",
        f.statusPayload,
        f.statusSigner.key
      );
      const authority = {
        ...f.authority,
        currentStatusBase64: base64(canonical(status)),
        currentStatusSha256: await hashArtifact(status),
      };
      return await expect(
        verifyVertexHistoricalEpochApproval(
          authority,
          f.originalBase64,
          f.nativeSubject,
          "fixture-emitter",
          350n,
          f.fresh
        )
      ).rejects.toMatchObject({ code: "denied" });
    }
  );
  it("requires actual fresh replay authority, not the expired original or a caller proof", async () => {
    const f = await historicalFixture();
    await expect(
      verifyVertexHistoricalEpochApproval(
        f.authority,
        f.originalBase64,
        f.nativeSubject,
        "fixture-emitter",
        400n,
        f.fresh
      )
    ).rejects.toThrow();
    await expect(
      verifyVertexHistoricalEpochApproval(
        f.authority,
        f.originalBase64,
        f.nativeSubject,
        "fixture-emitter",
        350n,
        { approvalBase64: f.originalBase64, binding: f.oldBinding }
      )
    ).rejects.toThrow();
    return await expect(
      verifyVertexHistoricalEpochApproval(
        { ...f.authority, grants: [] },
        f.originalBase64,
        f.nativeSubject,
        "fixture-emitter",
        350n,
        f.fresh
      )
    ).rejects.toThrow();
  });
  return it("rejects altered original subject and missing explicit historical enrollment", async () => {
    const f = await historicalFixture();
    await expect(
      verifyVertexHistoricalEpochApproval(
        f.authority,
        f.originalBase64,
        { ...f.nativeSubject, new_snapshot_sha256: "0".repeat(64) },
        "fixture-emitter",
        350n,
        f.fresh
      )
    ).rejects.toThrow();
    const authority = {
      ...f.authority,
      keys: f.authority.keys.filter((key) => key.keyId !== "fixture-approver"),
    };
    return await expect(
      verifyVertexHistoricalEpochApproval(
        authority,
        f.originalBase64,
        f.nativeSubject,
        "fixture-emitter",
        350n,
        f.fresh
      )
    ).rejects.toThrow();
  });
});
