import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import {
  fail,
  insert,
  object,
  one,
  type PersistenceContext,
  time,
} from "./vertex-persistence-core.ts";
import type { VertexRecord, VertexScope } from "./vertex-ports.ts";
import type { VertexResearchChatCopyInventory } from "./vertex-research-chat-copy-ports.ts";

export const nativeEvidenceCopyPurposes = [
  "context",
  "tokenizeInput",
  "completionInput",
  "evidenceBundle",
  "phaseOneResponse",
  "toolResult",
  "phaseTwoTokenizeInput",
  "phaseTwoCompletionInput",
  "advisory",
] as const;
export type NativeEvidenceCopyPurpose =
  (typeof nativeEvidenceCopyPurposes)[number];
export const nativeEvidenceCopyKey = (purpose: string): string => {
  if (!(nativeEvidenceCopyPurposes as readonly string[]).includes(purpose))
    return fail("invalid");
  return `native-evidence-${purpose}-v1`;
};
export const isNativeEvidencePlan = (plan: VertexRecord): boolean =>
  plan["format"] === "vertex-research-chat-native-evidence-plan-v1";
type Content = Readonly<{ sha256: string; byteLength: number }>;
export type NativeEvidencePhase = Readonly<{
  profile: "vertex-research-chat-native-phase-v1";
  accountAlias: string;
  environment: "research";
  responseRequestId: string;
  planSha256: string;
  phaseOrdinal: 1 | 2;
  tokenizeInput: Content;
  completionInput: Content;
  derivation: VertexRecord | null;
  expiresAt: string;
  phaseSha256: string;
}>;
export type NativeEvidencePhaseTwoInput = Readonly<{
  phaseOneResponse: Uint8Array;
  toolResult: Uint8Array;
  phaseTwoTokenizeInput: Uint8Array;
  phaseTwoCompletionInput: Uint8Array;
  derivation: VertexRecord;
}>;
const exact = (value: unknown, keys: readonly string[]): VertexRecord => {
  const result = object(value);
  if (Object.keys(result).sort().join() !== [...keys].sort().join())
    return fail("integrity");
  return result;
};
const hash = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    return fail("integrity");
  return value;
};
const pin = (raw: unknown): Content => {
  const value = exact(raw, ["sha256", "byteLength"]);
  if (
    typeof value["byteLength"] !== "number" ||
    !Number.isSafeInteger(value["byteLength"]) ||
    value["byteLength"] < 1 ||
    value["byteLength"] > 262_144
  )
    return fail("integrity");
  return Object.freeze({
    sha256: hash(value["sha256"]),
    byteLength: value["byteLength"],
  });
};
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
// Metadata only. Lifecycle performs the current original authority and storage
// proof joins before calling either operation. This owner never grants access.
export const createResearchChatNativePhaseStore = (ctx: PersistenceContext) => {
  const contentFor = (
    inventory: VertexResearchChatCopyInventory,
    purpose: NativeEvidenceCopyPurpose
  ): Content => {
    const entry = inventory.copies.find(
      (copy) =>
        copy.allocation.copyIdempotencyKey === nativeEvidenceCopyKey(purpose)
    );
    if (!entry?.contentBinding) return fail("unavailable");
    return pin(entry.contentBinding.content);
  };
  const derivationFor = async (
    raw: unknown,
    plan: VertexRecord,
    inventory: VertexResearchChatCopyInventory
  ): Promise<VertexRecord> => {
    const value = exact(ctx.capture(raw), [
      "profile",
      "phaseOneResponseSha256",
      "phaseOneRequestSha256",
      "phaseOneProofSha256",
      "callId",
      "toolName",
      "argumentsCanonical",
      "evidenceId",
      "bundleSha256",
      "toolResultSha256",
    ]);
    if (
      value["profile"] !== "reviewed-evidence-single-projection-v1" ||
      value["toolName"] !== "read_reviewed_evidence"
    )
      return fail("integrity");
    for (const key of [
      "phaseOneResponseSha256",
      "phaseOneRequestSha256",
      "phaseOneProofSha256",
      "bundleSha256",
      "toolResultSha256",
    ])
      hash(value[key]);
    for (const key of ["callId", "evidenceId"])
      if (
        typeof value[key] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value[key] as string)
      )
        return fail("integrity");
    if (
      value["argumentsCanonical"] !==
      JSON.stringify({ evidence_id: value["evidenceId"] })
    )
      return fail("integrity");
    if (
      value["phaseOneResponseSha256"] !==
        contentFor(inventory, "phaseOneResponse").sha256 ||
      value["toolResultSha256"] !==
        contentFor(inventory, "toolResult").sha256 ||
      value["bundleSha256"] !==
        contentFor(inventory, "evidenceBundle").sha256 ||
      value["bundleSha256"] !==
        object(object(plan["nativeEvidence"])["bundle"])["sha256"]
    )
      return fail("integrity");
    return await freeze(value);
  };
  const checked = async (
    raw: unknown,
    plan: VertexRecord,
    inventory: VertexResearchChatCopyInventory,
    ordinal: 1 | 2
  ): Promise<NativeEvidencePhase> => {
    const phase = exact(ctx.capture(raw), [
      "profile",
      "accountAlias",
      "environment",
      "responseRequestId",
      "planSha256",
      "phaseOrdinal",
      "tokenizeInput",
      "completionInput",
      "derivation",
      "expiresAt",
      "phaseSha256",
    ]);
    if (
      !isNativeEvidencePlan(plan) ||
      phase["profile"] !== "vertex-research-chat-native-phase-v1" ||
      phase["accountAlias"] !== plan["accountAlias"] ||
      phase["environment"] !== "research" ||
      phase["responseRequestId"] !== plan["responseRequestId"] ||
      phase["planSha256"] !== plan["planSha256"] ||
      phase["phaseOrdinal"] !== ordinal ||
      phase["expiresAt"] !== plan["expiresAt"]
    )
      return fail("integrity");
    const tokenize = pin(phase["tokenizeInput"]),
      completion = pin(phase["completionInput"]);
    if (
      (await ctx.hash(tokenize)) !==
        (await ctx.hash(
          contentFor(
            inventory,
            ordinal === 1 ? "tokenizeInput" : "phaseTwoTokenizeInput"
          )
        )) ||
      (await ctx.hash(completion)) !==
        (await ctx.hash(
          contentFor(
            inventory,
            ordinal === 1 ? "completionInput" : "phaseTwoCompletionInput"
          )
        ))
    )
      return fail("integrity");
    if (ordinal === 1) {
      if (phase["derivation"] !== null) return fail("integrity");
    } else await derivationFor(phase["derivation"], plan, inventory);
    const { phaseSha256, ...body } = phase;
    if ((await ctx.hash(body)) !== hash(phaseSha256)) return fail("integrity");
    return freeze(phase as NativeEvidencePhase);
  };
  const read = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    inventory: VertexResearchChatCopyInventory,
    ordinal: 1 | 2,
    at: string
  ): Promise<NativeEvidencePhase | null> => {
    if (!isNativeEvidencePlan(plan) || (ordinal !== 1 && ordinal !== 2))
      return fail("invalid");
    const row = await one(
      tx,
      "vertex_research_chat_native_phases",
      scope,
      sql`response_request_id = ${plan["responseRequestId"]} and phase_ordinal = ${ordinal}`
    );
    if (!row) return null;
    const value = await checked(row["payload"], plan, inventory, ordinal);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      row["account_alias"] !== scope.accountAlias ||
      row["environment"] !== scope.environment ||
      row["response_request_id"] !== value.responseRequestId ||
      row["phase_ordinal"] !== ordinal ||
      row["plan_sha256"] !== value.planSha256 ||
      row["phase_sha256"] !== value.phaseSha256 ||
      row["expires_at_ns"] !== time(value.expiresAt).toString()
    )
      return fail("integrity");
    if (time(at) >= time(value.expiresAt)) return fail("stale");
    return value;
  };
  const persist = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    inventory: VertexResearchChatCopyInventory,
    ordinal: 1 | 2,
    derivation: VertexRecord | null,
    at: string
  ): Promise<NativeEvidencePhase> => {
    const body = {
      profile: "vertex-research-chat-native-phase-v1",
      ...scope,
      responseRequestId: plan["responseRequestId"],
      planSha256: plan["planSha256"],
      phaseOrdinal: ordinal,
      tokenizeInput: contentFor(
        inventory,
        ordinal === 1 ? "tokenizeInput" : "phaseTwoTokenizeInput"
      ),
      completionInput: contentFor(
        inventory,
        ordinal === 1 ? "completionInput" : "phaseTwoCompletionInput"
      ),
      derivation,
      expiresAt: plan["expiresAt"],
    };
    const value = await checked(
      { ...body, phaseSha256: await ctx.hash(body) },
      plan,
      inventory,
      ordinal
    );
    const prior = await read(tx, scope, plan, inventory, ordinal, at);
    if (prior) {
      if ((await ctx.hash(prior)) !== (await ctx.hash(value)))
        return fail("conflict");
      return prior;
    }
    if (ordinal === 2 && !(await read(tx, scope, plan, inventory, 1, at)))
      return fail("integrity");
    if (time(at) >= time(value.expiresAt)) return fail("stale");
    await insert(tx, "vertex_research_chat_native_phases", scope, {
      response_request_id: value.responseRequestId,
      phase_ordinal: ordinal,
      plan_sha256: value.planSha256,
      phase_sha256: value.phaseSha256,
      expires_at_ns: time(value.expiresAt).toString(),
      record_hash: await ctx.hash(value),
      payload: value,
    });
    return value;
  };
  return Object.freeze({ read, persist });
};
