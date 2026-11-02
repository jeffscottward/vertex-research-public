import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import {
  digestString,
  fail,
  identifier,
  object,
  type PersistenceContext,
  type Row,
  rows,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexProjectionResult,
  VertexScope,
} from "./vertex-ports.ts";

export type VertexNativeApprovalAction =
  | "owner-epoch-transition"
  | "native-outbox-replay";
// Trusted verifier output only. The immutable key version is the digest of the
// actually enrolled raw Ed25519 public key, never a caller-supplied key version.
export type VertexVerifiedNativeApproval = Readonly<{
  signerKeyId: string;
  signerKeySha256: string;
  approvalId: string;
  nonce: string;
  actorId: string;
  action: VertexNativeApprovalAction;
  subjectSha256: string;
  approvalSha256: string;
  statusRevision: string;
  statusSha256: string;
  expiresAt: string;
}>;
export type VertexNativeApprovalBinding = Readonly<{
  action: VertexNativeApprovalAction;
  requestId: string;
  requestSha256: string;
  streamId: string;
  approvalBase64: string;
}>;
const receiptKeys = [
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
] as const;
const stableKeys = receiptKeys.filter(
  (key) => key !== "statusRevision" && key !== "statusSha256"
);
const exact = (value: Row, keys: readonly string[]): void => {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("denied");
};
const action = (value: unknown): VertexNativeApprovalAction => {
  if (value !== "owner-epoch-transition" && value !== "native-outbox-replay")
    return fail("denied");
  return value;
};

export const captureVerifiedNativeApproval = (
  ctx: PersistenceContext,
  input: unknown,
  at: string
): VertexVerifiedNativeApproval => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("denied");
  const value = object(ctx.capture(input));
  exact(value, receiptKeys);
  for (const key of ["signerKeyId", "approvalId", "actorId"])
    identifier(value[key]);
  for (const key of [
    "signerKeySha256",
    "nonce",
    "subjectSha256",
    "approvalSha256",
    "statusSha256",
  ])
    digestString(value[key]);
  action(value["action"]);
  if (
    sequence(value["statusRevision"]) < 1n ||
    time(value["expiresAt"]) <= time(at)
  )
    fail("denied");
  return value as unknown as VertexVerifiedNativeApproval;
};

// A refreshed current status may advance while an identical signed request is
// retried. Do not overwrite its first verification receipt or accept rollback.
export const assertSameNativeApproval = (
  prior: VertexVerifiedNativeApproval,
  current: VertexVerifiedNativeApproval
): void => {
  if (stableKeys.some((key) => prior[key] !== current[key])) fail("conflict");
  if (
    sequence(current.statusRevision) < sequence(prior.statusRevision) ||
    (current.statusRevision === prior.statusRevision &&
      current.statusSha256 !== prior.statusSha256)
  )
    fail("conflict");
};

export const createNativeApprovalAuditOperations = (
  ctx: PersistenceContext
) => {
  const bound = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    input: VertexNativeApprovalBinding,
    supplied: VertexVerifiedNativeApproval,
    at: string
  ) => {
    const binding = object(ctx.capture(input));
    exact(binding, [
      "action",
      "requestId",
      "requestSha256",
      "streamId",
      "approvalBase64",
    ]);
    identifier(principal.actorId);
    identifier(scope.accountAlias);
    if (scope.environment !== "paper") fail("denied");
    identifier(binding["requestId"]);
    identifier(binding["streamId"]);
    digestString(binding["requestSha256"]);
    const receipt = captureVerifiedNativeApproval(ctx, supplied, at);
    if (
      receipt.action !== action(binding["action"]) ||
      receipt.actorId === principal.actorId
    )
      fail("denied");
    const approvalBase64 = string(binding["approvalBase64"]);
    if (
      approvalBase64.length < 4 ||
      approvalBase64.length > 1_398_104 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        approvalBase64
      )
    )
      fail("invalid");
    let bytes: Uint8Array;
    let envelope: Row;
    try {
      const binary = atob(approvalBase64);
      if (
        binary.length < 1 ||
        binary.length > 1_048_576 ||
        btoa(binary) !== approvalBase64
      )
        return fail("invalid");
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      envelope = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      );
      const canonical = ctx.encode(envelope);
      if (
        canonical.length !== bytes.length ||
        canonical.some((byte, index) => byte !== bytes[index])
      )
        return fail("integrity");
    } catch {
      return fail("invalid");
    }
    if ((await ctx.digest(bytes)) !== receipt.approvalSha256) fail("integrity");
    exact(envelope, ["keyId", "payload", "signatureHex"]);
    const payload = object(envelope["payload"]);
    const subject = object(payload["subject"]);
    const subjectKey =
      receipt.action === "owner-epoch-transition"
        ? "transitionSha256"
        : "replaySha256";
    exact(subject, [subjectKey]);
    if (
      envelope["keyId"] !== receipt.signerKeyId ||
      !/^[0-9a-f]{128}$/.test(string(envelope["signatureHex"])) ||
      payload["format"] !== "vertex-native-approval-v1" ||
      payload["accountAlias"] !== scope.accountAlias ||
      payload["environment"] !== scope.environment ||
      payload["action"] !== receipt.action ||
      payload["actorId"] !== receipt.actorId ||
      payload["approvalId"] !== receipt.approvalId ||
      payload["nonce"] !== receipt.nonce ||
      subject[subjectKey] !== receipt.subjectSha256 ||
      sequence(payload["expiresNs"]) !== time(receipt.expiresAt)
    )
      fail("integrity");
    // This is only a consistency check AFTER independent crypto verification.
    // Parsing a canonical signature envelope never enrolls or authenticates it.
    return {
      binding: binding as unknown as VertexNativeApprovalBinding,
      receipt,
    };
  };
  const lookup = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    binding: VertexNativeApprovalBinding,
    receipt: VertexVerifiedNativeApproval
  ): Promise<Row | null> => {
    // Account locks alone cannot enforce cross-account/cross-purpose replay.
    // One global signer-version lock orders every nonce/approval-ID claim.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-native-approval", receipt.signerKeySha256])}, 0))`
    );
    const found = await rows(
      tx,
      sql`select * from vertex_native_approval_audit where signer_key_sha256 = ${receipt.signerKeySha256} and (nonce = ${receipt.nonce} or approval_id = ${receipt.approvalId}) limit 2`
    );
    if (found.length > 1) return fail("conflict");
    const stored = found[0];
    if (!stored) return null;
    if ((await ctx.hash(stored["payload"])) !== stored["record_hash"])
      fail("integrity");
    const payload = object(stored["payload"]);
    const previous = object(
      payload["receipt"]
    ) as unknown as VertexVerifiedNativeApproval;
    const expected: Row = {
      signer_key_id: previous.signerKeyId,
      signer_key_sha256: previous.signerKeySha256,
      approval_id: previous.approvalId,
      nonce: previous.nonce,
      approver_actor_id: previous.actorId,
      action: previous.action,
      subject_sha256: previous.subjectSha256,
      approval_sha256: previous.approvalSha256,
      status_revision: previous.statusRevision,
      status_sha256: previous.statusSha256,
      expires_at: previous.expiresAt,
      account_alias: payload["accountAlias"],
      environment: payload["environment"],
      recipient_actor_id: payload["recipientActorId"],
      stream_id: payload["streamId"],
      request_id: payload["requestId"],
      request_sha256: payload["requestSha256"],
      approval_base64: payload["approvalBase64"],
      recorded_at: payload["recordedAt"],
    };
    for (const [key, value] of Object.entries(expected)) {
      if (stored[key] !== value) fail("integrity");
    }
    if (
      (await ctx.hash(stored["outcome"])) !==
      (await ctx.hash(payload["outcome"]))
    )
      fail("integrity");
    assertSameNativeApproval(previous, receipt);
    if (
      payload["accountAlias"] !== scope.accountAlias ||
      payload["environment"] !== scope.environment ||
      payload["recipientActorId"] !== principal.actorId ||
      payload["streamId"] !== binding.streamId ||
      payload["requestId"] !== binding.requestId ||
      payload["requestSha256"] !== binding.requestSha256 ||
      payload["approvalBase64"] !== binding.approvalBase64
    )
      fail("conflict");
    return stored;
  };
  const checkNativeApprovalInTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    binding: VertexNativeApprovalBinding,
    receipt: VertexVerifiedNativeApproval,
    at: string
  ): Promise<"new" | "duplicate"> => {
    const checked = await bound(principal, scope, binding, receipt, at);
    return (await lookup(
      tx,
      principal,
      scope,
      checked.binding,
      checked.receipt
    ))
      ? "duplicate"
      : "new";
  };
  const recordNativeApprovalInTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    binding: VertexNativeApprovalBinding,
    receipt: VertexVerifiedNativeApproval,
    outcome: VertexProjectionResult,
    at: string
  ): Promise<void> => {
    const checked = await bound(principal, scope, binding, receipt, at);
    if (await lookup(tx, principal, scope, checked.binding, checked.receipt))
      return;
    const result = object(ctx.capture(outcome));
    exact(result, ["status", "highWaterSequence", "highWaterEventHash"]);
    if (
      !["applied", "duplicate", "gap", "epoch-mismatch", "stale"].includes(
        string(result["status"])
      )
    )
      fail("invalid");
    sequence(result["highWaterSequence"]);
    if (result["highWaterEventHash"] !== null)
      digestString(result["highWaterEventHash"]);
    const payload = {
      accountAlias: scope.accountAlias,
      environment: scope.environment,
      recipientActorId: principal.actorId,
      streamId: checked.binding.streamId,
      requestId: checked.binding.requestId,
      requestSha256: checked.binding.requestSha256,
      approvalBase64: checked.binding.approvalBase64,
      receipt: checked.receipt,
      outcome: result,
      recordedAt: at,
    };
    const recordHash = await ctx.hash(payload);
    const value = checked.receipt;
    await tx.execute(
      sql`insert into vertex_native_approval_audit (signer_key_id,signer_key_sha256,approval_id,nonce,approver_actor_id,action,subject_sha256,approval_sha256,status_revision,status_sha256,expires_at,account_alias,environment,recipient_actor_id,stream_id,request_id,request_sha256,approval_base64,outcome,recorded_at,record_hash,payload) values (${value.signerKeyId},${value.signerKeySha256},${value.approvalId},${value.nonce},${value.actorId},${value.action},${value.subjectSha256},${value.approvalSha256},${value.statusRevision},${value.statusSha256},${value.expiresAt},${scope.accountAlias},${scope.environment},${principal.actorId},${checked.binding.streamId},${checked.binding.requestId},${checked.binding.requestSha256},${checked.binding.approvalBase64},${JSON.stringify(result)}::jsonb,${at},${recordHash},${JSON.stringify(payload)}::jsonb)`
    );
  };
  return {
    checkNativeApprovalInTransaction,
    recordNativeApprovalInTransaction,
  };
};
