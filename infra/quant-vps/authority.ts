import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  approvalPayloadSchema,
  hostTrustPayloadSchema,
  parseBoundedJson,
  releaseFailure,
  signedReceiptSchema,
  type DeploymentPolicy,
  type ReleaseRequest,
  type SignedReceipt,
} from "./contract.ts";

export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export type PublicKeyResolver = (
  reference: string
) => Promise<KeyObject | string | Buffer>;

// Resolvers are supplied by the release authority, not read from candidate code,
// receipt payloads, dotenv, a discovery URL, or an ambient SSH trust store.
export const verifySignedPayload = async (
  receiptInput: SignedReceipt,
  expectedKeyRef: string,
  resolveKey: PublicKeyResolver
): Promise<unknown> => {
  const receipt = signedReceiptSchema.parse(receiptInput);
  if (receipt.keyRef !== expectedKeyRef) releaseFailure("receipt-key");
  const payload = Buffer.from(receipt.payloadBase64, "base64");
  const signature = Buffer.from(receipt.signatureBase64, "base64");
  if (
    payload.toString("base64") !== receipt.payloadBase64 ||
    signature.toString("base64") !== receipt.signatureBase64 ||
    signature.length !== 64
  )
    releaseFailure("receipt-encoding");
  const selected = await resolveKey(expectedKeyRef);
  const key =
    typeof selected === "string" || Buffer.isBuffer(selected)
      ? createPublicKey(selected)
      : selected;
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, payload, key, signature)
  )
    releaseFailure("receipt-signature");
  return parseBoundedJson(payload, 49_152);
};

const assertFresh = (
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
  maximumLifetimeMs: number
): void => {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    issued > nowMs ||
    expires <= nowMs ||
    expires <= issued ||
    expires - issued > maximumLifetimeMs
  )
    releaseFailure("receipt-expired");
};

export type AuthorityInput = Readonly<{
  request: ReleaseRequest;
  policy: DeploymentPolicy;
  machineIdentitySha256: string;
  sshHostKeyFingerprint: string;
  approval: SignedReceipt;
  hostTrust: SignedReceipt;
  nowMs: number;
}>;

export const authorizeHostRelease = async (
  input: AuthorityInput,
  resolveKey: PublicKeyResolver
): Promise<void> => {
  const approval = approvalPayloadSchema.parse(
    await verifySignedPayload(
      input.approval,
      input.policy.releaseApprovalKeyRef,
      resolveKey
    )
  );
  const trust = hostTrustPayloadSchema.parse(
    await verifySignedPayload(
      input.hostTrust,
      input.policy.hostTrustKeyRef,
      resolveKey
    )
  );
  for (const key of [
    "format",
    "requestId",
    "action",
    "targetManifestSha256",
    "currentManifestSha256",
    "policySha256",
  ] as const) {
    if (approval[key] !== input.request[key]) releaseFailure("approval-scope");
  }
  if (
    approval.hostRef !== input.policy.hostRef ||
    trust.hostRef !== input.policy.hostRef ||
    trust.machineIdentitySha256 !== input.machineIdentitySha256 ||
    trust.sshHostKeyFingerprint !== input.sshHostKeyFingerprint
  )
    releaseFailure("host-trust");
  assertFresh(approval.issuedAt, approval.expiresAt, input.nowMs, 900_000);
  assertFresh(trust.issuedAt, trust.expiresAt, input.nowMs, 31 * 86_400_000);
  // consoleVerified and humanApproved are signed evidence from separate trusted
  // references. This code cannot create approvals or learn/accept a host key.
};
