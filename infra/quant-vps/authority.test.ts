import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeHostRelease,
  verifySignedPayload,
  type AuthorityInput,
} from "./authority.ts";
import type {
  DeploymentPolicy,
  ReleaseRequest,
  SignedReceipt,
} from "./contract.ts";

const fixture = () => {
  // Ephemeral synthetic keys are created only when the future test is run.
  const approvalKey = generateKeyPairSync("ed25519");
  const trustKey = generateKeyPairSync("ed25519");
  const encode = (
    payload: unknown,
    keyRef: string,
    kind: "approval" | "trust"
  ): SignedReceipt => {
    const bytes = Buffer.from(JSON.stringify(payload));
    return {
      format: "vertex-ed25519-receipt-v1",
      keyRef,
      payloadBase64: bytes.toString("base64"),
      signatureBase64: sign(
        null,
        bytes,
        kind === "approval" ? approvalKey.privateKey : trustKey.privateKey
      ).toString("base64"),
    };
  };
  const request: ReleaseRequest = {
    format: "vertex-host-release-request-v1",
    requestId: "a".repeat(32),
    action: "release",
    targetManifestSha256: "b".repeat(64),
    currentManifestSha256: null,
    policySha256: "c".repeat(64),
  };
  const policy = {
    hostRef: "synthetic:host",
    releaseApprovalKeyRef: "synthetic:approval",
    hostTrustKeyRef: "synthetic:trust",
  } as DeploymentPolicy;
  const issuedAt = "2026-09-22T12:00:00.000Z";
  const expiresAt = "2026-09-22T12:10:00.000Z";
  const approvalPayload = {
    ...request,
    hostRef: policy.hostRef,
    approvedByRef: "synthetic:operator",
    humanApproved: true,
    issuedAt,
    expiresAt,
  };
  const trustPayload = {
    format: "vertex-host-trust-v1",
    hostRef: policy.hostRef,
    machineIdentitySha256: "d".repeat(64),
    sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    evidenceRef: "synthetic:console-evidence",
    verifiedByRef: "synthetic:operator",
    consoleVerified: true,
    issuedAt,
    expiresAt,
  };
  const input: AuthorityInput = {
    request,
    policy,
    machineIdentitySha256: trustPayload.machineIdentitySha256,
    sshHostKeyFingerprint: trustPayload.sshHostKeyFingerprint,
    approval: encode(approvalPayload, policy.releaseApprovalKeyRef, "approval"),
    hostTrust: encode(trustPayload, policy.hostTrustKeyRef, "trust"),
    nowMs: Date.parse("2026-09-22T12:01:00.000Z"),
  };
  const resolveKey = async (reference: string) => {
    if (reference === policy.releaseApprovalKeyRef)
      return approvalKey.publicKey;
    if (reference === policy.hostTrustKeyRef) return trustKey.publicKey;
    throw new Error("unknown-key-ref");
  };
  return { input, encode, approvalPayload, trustPayload, resolveKey };
};

describe("host release approval authority", () => {
  it("accepts only signatures from independently resolved explicit key references", async () => {
    const f = fixture();
    return await expect(
      authorizeHostRelease(f.input, f.resolveKey)
    ).resolves.toBeUndefined();
  });
  it.each([
    "action",
    "requestId",
    "targetManifestSha256",
    "currentManifestSha256",
    "policySha256",
  ])("rejects signed scope mismatch: %s", async (field) => {
    const f = fixture();
    const value =
      field === "action"
        ? "rollback"
        : field === "requestId"
          ? "e".repeat(32)
          : "e".repeat(64);
    const approval = f.encode(
      { ...f.approvalPayload, [field]: value },
      f.input.policy.releaseApprovalKeyRef,
      "approval"
    );
    return await expect(
      authorizeHostRelease({ ...f.input, approval }, f.resolveKey)
    ).rejects.toThrow("approval-scope");
  });
  it.each(["machineIdentitySha256", "sshHostKeyFingerprint"])(
    "rejects copied trust on different %s",
    async (field) => {
      const f = fixture();
      const value =
        field === "sshHostKeyFingerprint"
          ? `SHA256:${"B".repeat(43)}`
          : "f".repeat(64);
      return await expect(
        authorizeHostRelease({ ...f.input, [field]: value }, f.resolveKey)
      ).rejects.toThrow("host-trust");
    }
  );
  it("rejects expired approval without renewals or fallback", async () => {
    const f = fixture();
    return await expect(
      authorizeHostRelease(
        { ...f.input, nowMs: Date.parse("2026-09-22T12:10:00.000Z") },
        f.resolveKey
      )
    ).rejects.toThrow("receipt-expired");
  });
  it("does not use a key selected by the receipt instead of the authority", async () => {
    const f = fixture();
    return await expect(
      verifySignedPayload(
        { ...f.input.approval, keyRef: "synthetic:attacker" },
        f.input.policy.releaseApprovalKeyRef,
        f.resolveKey
      )
    ).rejects.toThrow("receipt-key");
  });
  it("rejects modified payload bytes even if the schema is valid", async () => {
    const f = fixture();
    const approval = {
      ...f.input.approval,
      payloadBase64: Buffer.from(
        JSON.stringify({
          ...f.approvalPayload,
          approvedByRef: "synthetic:other",
        })
      ).toString("base64"),
    };
    return await expect(
      authorizeHostRelease({ ...f.input, approval }, f.resolveKey)
    ).rejects.toThrow("receipt-signature");
  });
  return it("rejects unconfirmed host trust signed by the correct key", async () => {
    const f = fixture();
    const hostTrust = f.encode(
      { ...f.trustPayload, consoleVerified: false },
      f.input.policy.hostTrustKeyRef,
      "trust"
    );
    return await expect(
      authorizeHostRelease({ ...f.input, hostTrust }, f.resolveKey)
    ).rejects.toThrow();
  });
});
