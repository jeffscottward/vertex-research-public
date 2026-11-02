import type { VertexVerifiedNativeApproval } from "@darkfactory/db/server/vertex-epoch";
import {
  canonical,
  canonicalRecord,
  decodeBase64,
  exact,
  hashArtifact,
  id,
  list,
  ns,
  rawSha,
  record,
  requireEpoch,
  sha,
  text,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import { present } from "./present.ts";

export type VertexEpochEnrolledKey = Readonly<{
  keyId: string;
  actorId: string;
  publicKeyBase64: string;
  roles: readonly ("approval" | "status")[];
  notBeforeNs: string;
  expiresNs: string;
}>;
export type VertexEpochScopedGrant = Readonly<{
  grantId: string;
  keyId: string;
  actorId: string;
  requestingActorId: string;
  accountAlias: string;
  environment: "paper";
  simulatorId: string;
  streamId: string;
  journalIdentity: string;
  action: "owner-epoch-transition" | "native-outbox-replay";
  notBeforeNs: string;
  expiresNs: string;
  revoked: boolean;
}>;
export type VertexEpochAuthority = Readonly<{
  // Authoritative per-request configuration, NOT worker input. Provisioning,
  // key enrollment, grant review and status refresh remain user-owned.
  configuredAtNs: string;
  validUntilNs: string;
  policy: Readonly<{
    policyId: string;
    policySha256: string;
    policyVersion: string;
    accountAlias: string;
    environment: "paper";
    simulatorId: string;
    currency: string;
    maximumApprovalTtlNs: string;
    maximumStatusAgeNs: string;
  }>;
  keys: readonly VertexEpochEnrolledKey[];
  statusKeyId: string;
  currentStatusBase64: string;
  currentStatusSha256: string;
  minimumStatusRevision: string;
  grants: readonly VertexEpochScopedGrant[];
}>;
export type VerifiedVertexEpochApproval = Readonly<{
  keyId: string;
  signerKeySha256: string;
  actorId: string;
  approvalId: string;
  nonce: string;
  action: "owner-epoch-transition" | "native-outbox-replay";
  approvalSha256: string;
  grantId: string;
  statusRevision: string;
  statusSha256: string;
  nativeTransitionSha256: string;
  expiresNs: string;
}>;
const COMMON = [
  "policyId",
  "policySha256",
  "policyVersion",
  "accountAlias",
  "environment",
  "simulatorId",
  "currency",
];
const domain = new TextEncoder().encode(
  "vertex-native-approval-signature-v1\0"
);

const signed = async (
  bytes: Uint8Array,
  authority: VertexEpochAuthority,
  role: "approval" | "status",
  now: bigint
): Promise<{
  envelope: NativeRecord;
  payload: NativeRecord;
  key: VertexEpochEnrolledKey;
}> => {
  const envelope = exact(
    canonicalRecord(bytes, role === "approval" ? 65_536 : 1_048_576),
    ["keyId", "payload", "signatureHex"]
  );
  const key = authority.keys.find(
    (candidate) => candidate.keyId === id(envelope["keyId"])
  );
  requireEpoch(key?.roles.includes(role), "denied");
  const enrolled = present(key);
  requireEpoch(
    ns(enrolled.notBeforeNs) <= now && now < ns(enrolled.expiresNs),
    "denied"
  );
  if (role === "status")
    requireEpoch(enrolled.keyId === authority.statusKeyId, "denied");
  const payload = record(envelope["payload"]);
  for (const field of COMMON)
    requireEpoch(
      payload[field] ===
        authority.policy[field as keyof VertexEpochAuthority["policy"]],
      "denied"
    );
  const signature = text(envelope["signatureHex"]);
  requireEpoch(/^[0-9a-f]{128}$/.test(signature), "denied");
  const body = canonical({ keyId: enrolled.keyId, payload });
  const message = new Uint8Array(domain.length + body.length);
  message.set(domain);
  message.set(body, domain.length);
  requireEpoch(globalThis.crypto?.subtle, "unavailable");
  const publicKey = decodeBase64(enrolled.publicKeyBase64, 32);
  requireEpoch(publicKey.length === 32, "unavailable");
  let valid = false;
  try {
    const imported = await globalThis.crypto.subtle.importKey(
      "raw",
      new Uint8Array(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const signatureBytes = Uint8Array.from(
      present(signature.match(/../g)),
      (pair) => Number.parseInt(pair, 16)
    );
    valid = await globalThis.crypto.subtle.verify(
      "Ed25519",
      imported,
      signatureBytes,
      message
    );
  } catch {
    requireEpoch(false, "unavailable");
  }
  requireEpoch(valid, "denied");
  return { envelope, payload, key: enrolled };
};

export type VertexNativeApprovalBinding = Readonly<{
  action: "owner-epoch-transition" | "native-outbox-replay";
  subject: Readonly<{ transitionSha256: string } | { replaySha256: string }>;
  accountAlias: string;
  environment: "paper";
  simulatorId: string;
  streamId: string;
  journalIdentity: string;
  ownerEpoch: string;
}>;
export const verifyVertexNativeApproval = async (
  authority: VertexEpochAuthority | undefined,
  approvalBase64: string,
  binding: VertexNativeApprovalBinding,
  requestingActorId: string,
  now: bigint
): Promise<VerifiedVertexEpochApproval> => {
  requireEpoch(authority, "unavailable");
  const trust = present(authority);
  requireEpoch(
    ns(trust.configuredAtNs) <= now && now < ns(trust.validUntilNs),
    "unavailable"
  );
  requireEpoch(
    list(trust.keys, 64).length > 0 && list(trust.grants, 4096).length > 0,
    "unavailable"
  );
  const keyIds = new Set<string>();
  const publicKeys = new Set<string>();
  for (const key of trust.keys) {
    id(key.keyId);
    id(key.actorId);
    requireEpoch(
      !(keyIds.has(key.keyId) || publicKeys.has(key.publicKeyBase64)) &&
        decodeBase64(key.publicKeyBase64, 32).length === 32,
      "unavailable"
    );
    requireEpoch(
      list(key.roles, 2).length > 0 &&
        new Set(key.roles).size === key.roles.length &&
        key.roles.every((role) => role === "approval" || role === "status"),
      "unavailable"
    );
    requireEpoch(ns(key.notBeforeNs) < ns(key.expiresNs), "unavailable");
    keyIds.add(key.keyId);
    publicKeys.add(key.publicKeyBase64);
  }
  id(trust.policy.policyId);
  sha(trust.policy.policySha256);
  requireEpoch(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
      trust.policy.policyVersion
    ) &&
      trust.policy.policyVersion.length <= 64 &&
      /^[A-Z]{3}$/.test(trust.policy.currency) &&
      trust.policy.environment === "paper",
    "unavailable"
  );
  const maximumTtl = ns(trust.policy.maximumApprovalTtlNs);
  const maximumStatusAge = ns(trust.policy.maximumStatusAgeNs);
  requireEpoch(
    maximumTtl > 0n &&
      maximumTtl <= 86_400_000_000_000n &&
      maximumStatusAge > 0n &&
      maximumStatusAge <= 300_000_000_000n,
    "unavailable"
  );
  const statusBytes = decodeBase64(trust.currentStatusBase64);
  const status = await signed(statusBytes, trust, "status", now);
  const statusPayload = exact(status.payload, [
    ...COMMON,
    "format",
    "revision",
    "checkedNs",
    "expiresNs",
    "revokedKeyIds",
    "revokedApprovalIds",
    "revokedNonces",
  ]);
  const statusSha256 = await hashArtifact(status.envelope);
  requireEpoch(statusSha256 === sha(trust.currentStatusSha256), "unavailable");
  requireEpoch(
    statusPayload["format"] === "vertex-native-approval-status-v1" &&
      ns(statusPayload["revision"]) > 0n &&
      ns(statusPayload["revision"]) >= ns(trust.minimumStatusRevision),
    "denied"
  );
  const checked = ns(statusPayload["checkedNs"]);
  const statusExpiry = ns(statusPayload["expiresNs"]);
  requireEpoch(
    ns(status.key.notBeforeNs) <= checked &&
      checked <= now &&
      now < statusExpiry &&
      statusExpiry <= ns(status.key.expiresNs) &&
      statusExpiry - checked <= maximumStatusAge,
    "stale"
  );
  for (const field of [
    "revokedKeyIds",
    "revokedApprovalIds",
    "revokedNonces",
  ]) {
    const entries = list(statusPayload[field]);
    for (const entry of entries) {
      if (field === "revokedNonces") sha(entry);
      else id(entry);
    }
    requireEpoch(
      new Set(entries).size === entries.length &&
        entries.every(
          (entry, index) => index === 0 || entries[index - 1] < entry
        )
    );
  }
  requireEpoch(
    !statusPayload["revokedKeyIds"].includes(status.key.keyId),
    "denied"
  );
  const approval = await signed(
    decodeBase64(approvalBase64, 65_536),
    trust,
    "approval",
    now
  );
  const payload = exact(approval.payload, [
    ...COMMON,
    "format",
    "approvalId",
    "nonce",
    "actorId",
    "ownerEpoch",
    "action",
    "issuedNs",
    "expiresNs",
    "subject",
  ]);
  requireEpoch(approval.key.keyId !== status.key.keyId, "denied");
  requireEpoch(
    payload["format"] === "vertex-native-approval-v1" &&
      payload["action"] === binding.action &&
      payload["actorId"] === approval.key.actorId,
    "denied"
  );
  id(payload["approvalId"]);
  sha(payload["nonce"]);
  const issued = ns(payload["issuedNs"]);
  const expires = ns(payload["expiresNs"]);
  requireEpoch(
    ns(approval.key.notBeforeNs) <= issued &&
      issued <= now &&
      now < expires &&
      expires <= ns(approval.key.expiresNs) &&
      expires - issued <= maximumTtl,
    "stale"
  );
  requireEpoch(
    !(
      statusPayload["revokedKeyIds"].includes(approval.key.keyId) ||
      statusPayload["revokedApprovalIds"].includes(payload["approvalId"]) ||
      statusPayload["revokedNonces"].includes(payload["nonce"])
    ),
    "denied"
  );
  const subjectField =
    binding.action === "owner-epoch-transition"
      ? "transitionSha256"
      : "replaySha256";
  const nativeTransitionSha256 = sha(record(binding.subject)[subjectField]);
  requireEpoch(
    exact(payload["subject"], [subjectField])[subjectField] ===
      nativeTransitionSha256 && payload["ownerEpoch"] === binding.ownerEpoch,
    "denied"
  );
  requireEpoch(
    binding.accountAlias === trust.policy.accountAlias &&
      binding.environment === trust.policy.environment &&
      binding.simulatorId === trust.policy.simulatorId,
    "denied"
  );
  const grant = trust.grants.find(
    (candidate) =>
      candidate.keyId === approval.key.keyId &&
      candidate.actorId === payload["actorId"] &&
      candidate.requestingActorId === requestingActorId &&
      candidate.accountAlias === binding.accountAlias &&
      candidate.environment === "paper" &&
      candidate.simulatorId === binding.simulatorId &&
      candidate.streamId === binding.streamId &&
      candidate.journalIdentity === binding.journalIdentity &&
      candidate.action === binding.action &&
      candidate.revoked === false &&
      ns(candidate.notBeforeNs) <= now &&
      now < ns(candidate.expiresNs)
  );
  requireEpoch(grant, "denied");
  return Object.freeze({
    keyId: approval.key.keyId,
    signerKeySha256: await rawSha(
      decodeBase64(approval.key.publicKeyBase64, 32)
    ),
    actorId: payload["actorId"],
    approvalId: payload["approvalId"],
    nonce: payload["nonce"],
    action: binding.action,
    approvalSha256: await hashArtifact(approval.envelope),
    grantId: id(present(grant).grantId),
    statusRevision: statusPayload["revision"],
    statusSha256,
    nativeTransitionSha256,
    expiresNs: payload["expiresNs"],
  });
};

export const verifyVertexEpochApproval = async (
  authority: VertexEpochAuthority | undefined,
  approvalBase64: string,
  nativeSubject: NativeRecord,
  requestingActorId: string,
  now: bigint
): Promise<VerifiedVertexEpochApproval> => {
  requireEpoch(nativeSubject["environment"] === "paper");
  return verifyVertexNativeApproval(
    authority,
    approvalBase64,
    {
      action: "owner-epoch-transition",
      subject: { transitionSha256: await hashArtifact(nativeSubject) },
      accountAlias: nativeSubject["account_alias"],
      environment: "paper",
      simulatorId: nativeSubject["simulator_id"],
      streamId: nativeSubject["stream_id"],
      journalIdentity: nativeSubject["journal_identity"],
      ownerEpoch: nativeSubject["current_owner_epoch"],
    },
    requestingActorId,
    now
  );
};

// The DB owns the sole durable approval consumption. This exact trusted DTO
// contains verified identities, never request-supplied booleans or claims.
export const toVertexVerifiedNativeApproval = (
  approval: VerifiedVertexEpochApproval
): VertexVerifiedNativeApproval => {
  const epochNs = ns(approval.expiresNs);
  requireEpoch(epochNs / 1_000_000n <= 8_640_000_000_000_000n);
  const iso = new Date(Number(epochNs / 1_000_000n)).toISOString();
  requireEpoch(/^[0-9]{4}-/.test(iso));
  const expiresAt = `${iso.slice(0, 19)}.${(epochNs % 1_000_000_000n).toString().padStart(9, "0")}Z`;
  return Object.freeze({
    signerKeyId: approval.keyId,
    signerKeySha256: approval.signerKeySha256,
    approvalId: approval.approvalId,
    nonce: approval.nonce,
    actorId: approval.actorId,
    action: approval.action,
    subjectSha256: approval.nativeTransitionSha256,
    approvalSha256: approval.approvalSha256,
    statusRevision: approval.statusRevision,
    statusSha256: approval.statusSha256,
    expiresAt,
  });
};

export type VerifiedVertexHistoricalEpochApproval = Readonly<{
  historicalOnly: true;
  keyId: string;
  signerKeySha256: string;
  actorId: string;
  approvalId: string;
  nonce: string;
  action: "owner-epoch-transition";
  subjectSha256: string;
  approvalSha256: string;
  issuedNs: string;
  expiresNs: string;
  statusRevision: string;
  statusSha256: string;
  ratifyingApprovalSha256: string;
}>;

// Narrow recovery provenance, NOT a relaxed normal approval verifier. First
// authenticate a fresh replay signature/grant at the actual current clock.
// Only then inspect the old epoch signature at issuance, still rejecting all
// CURRENT revocations. This distinct result cannot become a fresh DB receipt.
export const verifyVertexHistoricalEpochApproval = async (
  authority: VertexEpochAuthority | undefined,
  historicalApprovalBase64: string,
  nativeSubject: NativeRecord,
  requestingActorId: string,
  now: bigint,
  fresh: Readonly<{
    approvalBase64: string;
    binding: VertexNativeApprovalBinding;
  }>
): Promise<
  Readonly<{
    historicalApproval: VerifiedVertexHistoricalEpochApproval;
    ratification: VerifiedVertexEpochApproval;
  }>
> => {
  requireEpoch(fresh.binding.action === "native-outbox-replay", "denied");
  const ratification = await verifyVertexNativeApproval(
    authority,
    fresh.approvalBase64,
    fresh.binding,
    requestingActorId,
    now
  );
  const trust = present(authority);
  requireEpoch(
    nativeSubject["environment"] === "paper" &&
      nativeSubject["account_alias"] === fresh.binding.accountAlias &&
      nativeSubject["simulator_id"] === fresh.binding.simulatorId &&
      nativeSubject["stream_id"] === fresh.binding.streamId &&
      nativeSubject["journal_identity"] === fresh.binding.journalIdentity &&
      ns(nativeSubject["current_owner_epoch"]) < ns(fresh.binding.ownerEpoch),
    "denied"
  );
  const bytes = decodeBase64(historicalApprovalBase64, 65_536);
  const unsignedEnvelope = exact(canonicalRecord(bytes, 65_536), [
    "keyId",
    "payload",
    "signatureHex",
  ]);
  const issued = ns(record(unsignedEnvelope["payload"])["issuedNs"]);
  requireEpoch(issued <= now, "denied");
  // The key must be explicitly retained in current enrollment. Its expired
  // lifetime is permitted ONLY as a historical cryptographic record, provided
  // issuance and original expiry both lay within that enrolled key lifetime.
  const original = await signed(bytes, trust, "approval", issued);
  const payload = exact(original.payload, [
    ...COMMON,
    "format",
    "approvalId",
    "nonce",
    "actorId",
    "ownerEpoch",
    "action",
    "issuedNs",
    "expiresNs",
    "subject",
  ]);
  requireEpoch(
    payload["format"] === "vertex-native-approval-v1" &&
      payload["action"] === "owner-epoch-transition" &&
      payload["actorId"] === original.key.actorId &&
      original.key.keyId !== trust.statusKeyId,
    "denied"
  );
  const expiry = ns(payload["expiresNs"]);
  requireEpoch(
    issued < expiry &&
      expiry <= ns(original.key.expiresNs) &&
      expiry - issued <= ns(trust.policy.maximumApprovalTtlNs),
    "denied"
  );
  id(payload["approvalId"]);
  sha(payload["nonce"]);
  const subjectSha256 = await hashArtifact(nativeSubject);
  requireEpoch(
    exact(payload["subject"], ["transitionSha256"])["transitionSha256"] ===
      subjectSha256 &&
      payload["ownerEpoch"] === nativeSubject["current_owner_epoch"],
    "denied"
  );
  // Fresh verification above authenticated this EXACT current status pin;
  // historical status files are never accepted or used to undo revocations.
  const status = record(
    canonicalRecord(decodeBase64(trust.currentStatusBase64))["payload"]
  );
  requireEpoch(
    !(
      list(status["revokedKeyIds"]).includes(original.key.keyId) ||
      list(status["revokedApprovalIds"]).includes(payload["approvalId"]) ||
      list(status["revokedNonces"]).includes(payload["nonce"])
    ),
    "denied"
  );
  const historicalApproval: VerifiedVertexHistoricalEpochApproval =
    Object.freeze({
      historicalOnly: true,
      keyId: original.key.keyId,
      signerKeySha256: await rawSha(
        decodeBase64(original.key.publicKeyBase64, 32)
      ),
      actorId: payload["actorId"],
      approvalId: payload["approvalId"],
      nonce: payload["nonce"],
      action: "owner-epoch-transition",
      subjectSha256,
      approvalSha256: await rawSha(bytes),
      issuedNs: payload["issuedNs"],
      expiresNs: payload["expiresNs"],
      statusRevision: ratification.statusRevision,
      statusSha256: ratification.statusSha256,
      ratifyingApprovalSha256: ratification.approvalSha256,
    });
  return Object.freeze({ historicalApproval, ratification });
};
