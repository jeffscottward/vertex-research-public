import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  withTransactionReadScope,
  VertexStoreError,
  type VertexPrincipal,
  type VertexRecord,
  type VertexScope,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  decimalUnits,
} from "@darkfactory/shared/vertex";
import {
  array,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  reusePredecessorRead,
  rows,
  string,
  time,
  type PersistenceContext,
  withPredecessorWalk,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import type {
  ResearchChatWorkerOperations,
  createResearchChatDebateOperations,
  ResearchChatOutputPrepared,
  ResearchChatOutputMetadata,
  ResearchChatPreparedSources,
  ResearchChatSourceRequest,
  ResearchChatSourceRecheck,
  ResearchChatSourceInputs,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import type { WorkerServiceIdentity } from "@darkfactory/db/server/vertex-research-chat-runtime";
import {
  ModelUseGrantSchema,
  ModelUseProofSchema,
  parseModelUseRequest,
  type ModelUseRequest,
  type ModelUseProof,
} from "../contracts/vertex-model-use.ts";
import {
  WorkerStageArtifactInputSchema,
  WorkerNativeEvidencePhaseSchema,
  WorkerPrepareNativeEvidencePhaseTwoInputSchema,
  WorkerPrepareNativeEvidencePhaseTwoOutputSchema,
} from "../contracts/vertex-worker.ts";
import {
  VertexResearchChatExecutionPlanSchema,
  VertexResearchChatParticipantConfigurationV1Schema,
  VertexResearchChatNativeEvidencePlanV1Schema,
  VertexResearchChatNativeEvidenceConfigurationV1Schema,
} from "../contracts/vertex-research-chat-execution.ts";
import {
  VertexResearchChatPublishedPredecessorV1Schema,
  type VertexResearchChatPublishedPredecessorV1,
} from "../contracts/vertex-research-chat-debate.ts";
import { VertexResearchChatAdvisoryV2ProfileSchema } from "../contracts/vertex-research-chat-conversation.ts";
import { PolicyArtifactPinSchema } from "../contracts/vertex-policy.ts";
import {
  ChatWorkerOriginalClosedError,
  type VertexResearchChatWorkerRuntime,
} from "./vertex-research-chat-worker-runtime.ts";
import {
  SelectedChatModelPrivacyReviewSchema,
  readResearchChatModelDispatchProvenanceForTransaction,
  type createResearchChatModelPrivacyOperations,
} from "./vertex-research-chat-model-privacy.ts";
import type { createVertexRuntimePolicy } from "./vertex-runtime-policy.ts";
import { vertexRuntimeModelJson } from "./vertex-runtime-model-evidence.ts";
import {
  decodeResearchChatAdvisoryOutput,
  decodeResearchChatNativeEvidenceAdvisoryOutput,
} from "./vertex-research-chat-output-parser.ts";
import {
  prepareNativeEvidencePhaseTwoInputs,
  parseNativeEvidenceJson,
} from "./vertex-research-chat-native-inputs.ts";
import { present } from "./present.ts";

const table = "vertex_research_chat_advisory_origins";
const same = (a: unknown, b: unknown): boolean =>
  canonicalArtifactJson(a) === canonicalArtifactJson(b);
type Scope = Readonly<{ accountAlias: string; environment: "research" }>;
type Joined = Exclude<
  NonNullable<
    Awaited<ReturnType<ResearchChatWorkerOperations["originalForTransaction"]>>
  >,
  { closed: true }
>;
type CallerReadGrant = Readonly<{
  grantId: string;
  version: string;
  revision: string;
  recordSha256: string;
  expiresAt: string;
}>;
type ConversationCaller = Readonly<{
  accountScope: CallerReadGrant;
  read: CallerReadGrant;
  publish: CallerReadGrant | null;
  checkedAt: string;
  expiresAt: string;
}>;
const scopeOf = (value: VertexScope): Scope => {
  if (value.environment !== "research") return fail("denied");
  return { accountAlias: value.accountAlias, environment: "research" };
};
const bytesOf = (value: string): Uint8Array => {
  const raw = atob(value),
    bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (bytes.byteLength > 1_048_576 || btoa(raw) !== value)
    return fail("invalid");
  return bytes;
};
// Only composed from actual original owners. No injected authorization result,
// provider attestation claim, ordinary private stage, or provider retry path.
export const createVertexResearchChatOutputRuntime = (
  ctx: PersistenceContext,
  db: Database,
  worker: ResearchChatWorkerOperations,
  model: VertexResearchChatWorkerRuntime,
  policy: ReturnType<typeof createVertexRuntimePolicy>,
  privacy:
    | ReturnType<typeof createResearchChatModelPrivacyOperations>
    | undefined,
  debate?: ReturnType<typeof createResearchChatDebateOperations>
) => {
  const locked = <T>(
    scope: Scope,
    operation: (tx: Transaction, at: string) => Promise<T>
  ): Promise<T> =>
    db.transaction(
      withTransactionReadScope(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
        );
        return operation(tx, ctx.now());
      })
    );
  // Caller authority is invocation-local, not family authority. Retain one exact
  // current read grant across all body/metadata awaits; a later grant cannot
  // extend this invocation, and its loss never closes either shared domain.
  const callerGrantForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    resourceId: "research-chat" | "account-scope",
    action: "read" | "publish",
    at: string,
    expected?: CallerReadGrant
  ): Promise<CallerReadGrant> => {
    const authorizationAt = at;
    await ctx.authorize(
      principal,
      scope,
      null,
      resourceId,
      action,
      authorizationAt
    );
    const found = await rows(
      tx,
      sql`select b.grant_id, b.binding_hash, b.payload as binding_payload, v.payload, v.record_hash, v.version as version_name, v.revision as version_revision, v.status as version_status, v.valid_from_ns, v.expires_at_ns, v.recorded_at_ns, c.current_version, c.revision as current_revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = '' and b.resource_id = ${resourceId} and a.action = ${action} and v.status = 'granted' order by v.expires_at_ns desc, b.grant_id asc limit 129`
    );
    if (found.length > 128) return fail("denied");
    for (const row of found) {
      const value = object(row["payload"]),
        boundScope = object(value["scope"]);
      const binding = {
        grantId: value["grantId"],
        granteeActorId: value["granteeActorId"],
        scope: value["scope"],
        collectionId: value["collectionId"],
        resourceId: value["resourceId"],
        actions: value["actions"],
      };
      if (
        (await ctx.hash(binding)) !== row["binding_hash"] ||
        !same(binding, object(row["binding_payload"])) ||
        value["grantId"] !== row["grant_id"] ||
        (await ctx.hash(value)) !== row["record_hash"] ||
        value["version"] !== row["current_version"] ||
        value["version"] !== row["version_name"] ||
        value["revision"] !== row["current_revision"] ||
        value["revision"] !== row["version_revision"] ||
        value["status"] !== row["version_status"] ||
        time(value["validFrom"]).toString() !== row["valid_from_ns"] ||
        time(value["expiresAt"]).toString() !== row["expires_at_ns"] ||
        time(value["recordedAt"]).toString() !== row["recorded_at_ns"] ||
        value["granteeActorId"] !== principal.actorId ||
        boundScope["accountAlias"] !== scope.accountAlias ||
        boundScope["environment"] !== scope.environment ||
        value["collectionId"] !== null ||
        value["resourceId"] !== resourceId
      )
        return fail("integrity");
      if (
        value["status"] !== "granted" ||
        !array(value["actions"], 8).includes(action) ||
        time(value["recordedAt"]) > time(at) ||
        time(value["validFrom"]) > time(at)
      )
        continue;
      const pin: CallerReadGrant = {
        grantId: identifier(value["grantId"]),
        version: string(value["version"]),
        revision: string(value["revision"]),
        recordSha256: string(row["record_hash"]),
        expiresAt: string(value["expiresAt"]),
      };
      if (expected && !same(pin, expected)) continue;
      const checkedAt = ctx.now();
      if (time(checkedAt) < time(at) || time(checkedAt) >= time(pin.expiresAt))
        return fail("denied");
      return pin;
    }
    return fail("denied");
  };
  const callerReadGrantForTransaction = (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    at: string,
    expected?: CallerReadGrant
  ) =>
    callerGrantForTransaction(
      tx,
      principal,
      scope,
      "research-chat",
      "read",
      at,
      expected
    );
  // Concrete current grants, not caller-supplied DTO authority. The same pins
  // are carried through one invocation; substitution with a renewed grant fails.
  const conversationCallerForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    at: string,
    publish: boolean,
    expected?: ConversationCaller
  ): Promise<ConversationCaller> => {
    const accountScope = await callerGrantForTransaction(
      tx,
      principal,
      scope,
      "account-scope",
      "read",
      at,
      expected?.accountScope
    );
    const read = await callerReadGrantForTransaction(
      tx,
      principal,
      scope,
      ctx.now(),
      expected?.read
    );
    const publishGrant = publish
      ? await callerGrantForTransaction(
          tx,
          principal,
          scope,
          "research-chat",
          "publish",
          ctx.now(),
          expected?.publish ?? undefined
        )
      : null;
    if (expected && (expected.publish === null) !== (publishGrant === null))
      return fail("denied");
    const expiresAt = [
      accountScope.expiresAt,
      read.expiresAt,
      ...(publishGrant ? [publishGrant.expiresAt] : []),
    ].reduce((a, b) => (time(a) <= time(b) ? a : b));
    const checkedAt = ctx.now();
    if (
      time(checkedAt) < time(at) ||
      (expected && time(checkedAt) < time(expected.checkedAt)) ||
      time(checkedAt) >= time(expiresAt)
    )
      return fail("denied");
    return Object.freeze({
      accountScope,
      read,
      publish: publishGrant,
      checkedAt,
      expiresAt,
    });
  };
  // Historical immutable provenance remains inspectable after input fencing.
  // This is NOT processing authority; current use separately rejoins the copy,
  // original, grant and privacy owners before any body use or publication.
  const nativePhaseForProvenance = async (
    tx: Transaction,
    joined: Joined,
    ordinal: 1 | 2
  ) => {
    const { plan, inventory } = joined,
      scope = scopeOf(plan as VertexScope);
    if (plan["format"] !== "vertex-research-chat-native-evidence-plan-v1")
      return fail("denied");
    const row = await one(
      tx,
      "vertex_research_chat_native_phases",
      scope,
      sql`response_request_id = ${plan["responseRequestId"]} and phase_ordinal = ${ordinal}`
    );
    if (!row) return fail("denied");
    const phase = WorkerNativeEvidencePhaseSchema.parse(row["payload"]);
    const { phaseSha256, ...body } = phase;
    if (
      (await ctx.hash(phase)) !== row["record_hash"] ||
      (await ctx.hash(body)) !== phaseSha256 ||
      phase.accountAlias !== plan["accountAlias"] ||
      phase.environment !== plan["environment"] ||
      phase.responseRequestId !== plan["responseRequestId"] ||
      phase.planSha256 !== plan["planSha256"] ||
      phase.phaseOrdinal !== ordinal ||
      phase.expiresAt !== plan["expiresAt"] ||
      row["response_request_id"] !== phase.responseRequestId ||
      row["phase_ordinal"] !== ordinal ||
      row["phase_sha256"] !== phaseSha256 ||
      row["plan_sha256"] !== phase.planSha256 ||
      row["expires_at_ns"] !== time(phase.expiresAt).toString()
    )
      return fail("integrity");
    for (const [purpose, content] of [
      [
        ordinal === 1 ? "tokenizeInput" : "phaseTwoTokenizeInput",
        phase.tokenizeInput,
      ],
      [
        ordinal === 1 ? "completionInput" : "phaseTwoCompletionInput",
        phase.completionInput,
      ],
    ] as const) {
      const copy = inventory.copies.find(
        (entry) =>
          entry.allocation.copyIdempotencyKey ===
          `native-evidence-${purpose}-v1`
      );
      if (!(copy?.contentBinding && same(copy.contentBinding.content, content)))
        return fail("integrity");
    }
    if (phase.derivation) {
      for (const [purpose, digest] of [
        ["phaseOneResponse", phase.derivation.phaseOneResponseSha256],
        ["toolResult", phase.derivation.toolResultSha256],
        ["evidenceBundle", phase.derivation.bundleSha256],
      ] as const) {
        const copy = inventory.copies.find(
          (entry) =>
            entry.allocation.copyIdempotencyKey ===
            `native-evidence-${purpose}-v1`
        );
        if (
          !copy?.contentBinding ||
          copy.contentBinding.content.sha256 !== digest
        )
          return fail("integrity");
      }
      if (
        object(object(plan["nativeEvidence"])["bundle"])["sha256"] !==
          phase.derivation.bundleSha256 ||
        !array(plan["reviewPins"], 16).some(
          (pin) =>
            object(pin)["evidenceId"] === present(phase.derivation).evidenceId
        )
      )
        return fail("integrity");
    } else if (
      !(
        same(phase.tokenizeInput, plan["tokenizeInput"]) &&
        same(phase.completionInput, plan["completionInput"])
      )
    )
      return fail("integrity");
    return phase;
  };
  const provenance = async (
    tx: Transaction,
    joined: Joined,
    request: ModelUseRequest,
    proof: ModelUseProof,
    at: string,
    nativeOrdinal: 1 | 2 = 2
  ) => {
    const scope = scopeOf(request),
      { plan, origin } = joined;
    const phase =
      plan["format"] === "vertex-research-chat-native-evidence-plan-v1"
        ? await nativePhaseForProvenance(tx, joined, nativeOrdinal)
        : undefined;
    const input = phase?.completionInput ?? object(plan["completionInput"]);
    if (
      request.operation !== "model-completion" ||
      proof.operation !== request.operation ||
      proof.decision !== "allowed" ||
      proof.externalDispatchAllowed !== false ||
      proof.requestId !== request.requestId ||
      proof.requestSha256 !== request.requestSha256 ||
      request.jobId !== origin["jobId"] ||
      request.researchPrincipalId !== plan["ownerActorId"] ||
      request.selectionId !== plan["selectionId"] ||
      request.selectionSha256 !== plan["selectionSha256"] ||
      request.inputSha256 !== input.sha256 ||
      request.inputBytes !== input.byteLength ||
      request.deadlineAt !== plan["expiresAt"]
    )
      return fail("denied");
    for (const key of [
      "accountAlias",
      "environment",
      "researchPrincipalId",
      "consumerServiceId",
      "selectionId",
      "selectionSha256",
      "providerId",
      "modelVersion",
      "endpointReferenceId",
      "endpointSha256",
      "tokenizerArtifactId",
      "tokenizerSha256",
      "modelUsePolicyVersion",
      "jobId",
      "leaseId",
      "leaseEpoch",
      "grantId",
      "grantVersion",
    ] as const)
      if (proof[key] !== request[key]) return fail("denied");
    const proofHash = await ctx.hash(proof);
    const audit = await one(
      tx,
      "vertex_model_use_proof_audits",
      scope,
      sql`request_id = ${request.requestId} and checked_at_ns = ${time(proof.checkedAt).toString()} and record_hash = ${proofHash}`
    );
    if (
      !(audit && same(audit["payload"], proof)) ||
      audit["request_sha256"] !== request.requestSha256 ||
      audit["actor_id"] !== request.researchPrincipalId ||
      audit["grant_id"] !== request.grantId ||
      audit["grant_version"] !== request.grantVersion ||
      audit["grant_revision"] !== proof.grantRevision ||
      audit["decision"] !== "allowed" ||
      time(proof.checkedAt) > time(at)
    )
      return fail("denied");
    const dispatchRow =
      await readResearchChatModelDispatchProvenanceForTransaction(tx, request, {
        responseRequestId: string(plan["responseRequestId"]),
        planId: string(plan["planId"]),
        planSha256: string(plan["planSha256"]),
        originalRequestSha256: string(plan["requestSha256"]),
        ...(phase
          ? {
              nativePhase: {
                phaseOrdinal: phase.phaseOrdinal,
                phaseSha256: phase.phaseSha256,
              },
            }
          : {}),
      });
    if (!dispatchRow) return fail("denied");
    const dispatch = object(dispatchRow["payload"]);
    if (
      (await ctx.hash(dispatch)) !== dispatchRow["record_hash"] ||
      dispatch["profile"] !==
        (phase
          ? "vertex-research-chat-native-model-dispatch-v1"
          : "vertex-research-chat-model-dispatch-v1") ||
      dispatch["accountAlias"] !== scope.accountAlias ||
      dispatch["environment"] !== scope.environment ||
      dispatch["responseRequestId"] !== plan["responseRequestId"] ||
      dispatch["planId"] !== plan["planId"] ||
      dispatch["planSha256"] !== plan["planSha256"] ||
      dispatch["originalRequestSha256"] !== plan["requestSha256"] ||
      !same(dispatch["request"], request)
    )
      return fail("integrity");
    for (const [key, expected] of Object.entries({
      response_request_id: plan["responseRequestId"],
      plan_id: plan["planId"],
      plan_sha256: plan["planSha256"],
      original_request_sha256: plan["requestSha256"],
      operation: request.operation,
      request_id: request.requestId,
      request_sha256: request.requestSha256,
      review_id: dispatch["reviewId"],
      reserved_at_ns: time(dispatch["reservedAt"]).toString(),
    }))
      if (dispatchRow[key] !== expected) return fail("integrity");
    if (time(dispatch["reservedAt"]) > time(proof.checkedAt))
      return fail("denied");
    const auditHistory = await rows(
      tx,
      sql`select * from vertex_model_use_proof_audits where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and request_id = ${request.requestId} limit 129`
    );
    if (auditHistory.length > 128) return fail("denied");
    let firstDispatchSha256: string | null = null;
    for (const row of auditHistory) {
      const first = ModelUseProofSchema.parse(row["payload"]);
      if (
        (await ctx.hash(first)) !== row["record_hash"] ||
        row["request_sha256"] !== first.requestSha256 ||
        row["checked_at_ns"] !== time(first.checkedAt).toString()
      )
        return fail("integrity");
      if (!first.externalDispatchAllowed) continue;
      for (const key of [
        "accountAlias",
        "environment",
        "researchPrincipalId",
        "consumerServiceId",
        "selectionId",
        "selectionSha256",
        "providerId",
        "modelVersion",
        "endpointReferenceId",
        "endpointSha256",
        "tokenizerArtifactId",
        "tokenizerSha256",
        "modelUsePolicyVersion",
        "jobId",
        "leaseId",
        "leaseEpoch",
        "grantId",
        "grantVersion",
      ] as const)
        if (first[key] !== request[key]) return fail("integrity");
      if (
        row["request_id"] !== request.requestId ||
        first.requestId !== request.requestId ||
        first.operation !== request.operation ||
        row["decision"] !== first.decision ||
        row["grant_id"] !== first.grantId ||
        row["grant_version"] !== first.grantVersion ||
        row["grant_revision"] !== first.grantRevision ||
        first.privacyPolicyId !== proof.privacyPolicyId ||
        first.privacyPolicyVersion !== proof.privacyPolicyVersion
      )
        return fail("integrity");
      if (
        first.decision !== "allowed" ||
        first.requestSha256 !== request.requestSha256 ||
        first.jobId !== request.jobId ||
        first.leaseId !== request.leaseId ||
        first.leaseEpoch !== request.leaseEpoch ||
        first.grantId !== request.grantId ||
        first.grantVersion !== request.grantVersion ||
        first.grantRevision !== proof.grantRevision ||
        row["actor_id"] !== request.researchPrincipalId ||
        time(first.checkedAt) > time(dispatch["reservedAt"]) ||
        time(first.validUntil) <= time(dispatch["reservedAt"])
      )
        return fail("integrity");
      if (
        firstDispatchSha256 !== null &&
        firstDispatchSha256 !== row["record_hash"]
      )
        return fail("integrity");
      firstDispatchSha256 = string(row["record_hash"]);
    }
    if (firstDispatchSha256 === null) return fail("denied");
    const reviewRow = await one(
      tx,
      phase
        ? "vertex_research_chat_native_model_privacy_reviews"
        : "vertex_research_chat_model_privacy_reviews",
      scope,
      sql`review_id = ${dispatch["reviewId"]}`
    );
    if (!reviewRow) return fail("denied");
    const review = SelectedChatModelPrivacyReviewSchema.parse(
      reviewRow["payload"]
    );
    if (
      (await ctx.hash(review)) !== reviewRow["record_hash"] ||
      review.reviewId !== dispatch["reviewId"] ||
      review.responseRequestId !== plan["responseRequestId"] ||
      review.planId !== plan["planId"] ||
      review.planSha256 !== plan["planSha256"] ||
      !same(review.request, request) ||
      review.decision !== "accepted" ||
      review.privacyDecision === null ||
      proof.privacyPolicyId !== review.policyId ||
      proof.privacyPolicyVersion !== review.policyVersion ||
      time(review.reviewedAt) > time(dispatch["reservedAt"]) ||
      time(review.expiresAt) < time(proof.validUntil)
    )
      return fail("integrity");
    if (
      phase &&
      (!(
        "nativePhase" in review &&
        same(review.nativePhase, {
          phaseOrdinal: phase.phaseOrdinal,
          phaseSha256: phase.phaseSha256,
        })
      ) ||
        reviewRow["phase_ordinal"] !== phase.phaseOrdinal ||
        reviewRow["phase_sha256"] !== phase.phaseSha256)
    )
      return fail("integrity");
    const budgetRow = await one(
      tx,
      "vertex_model_use_budget_reservations",
      scope,
      sql`job_id = ${request.jobId} and selection_id = ${request.selectionId} and request_sha256 = ${request.requestSha256}`
    );
    if (!budgetRow) return fail("denied");
    const budget = object(budgetRow["payload"]),
      grant = ModelUseGrantSchema.parse(budget["grant"]),
      reservation = object(budget["reservation"]),
      admission = object(budget["admission"]);
    const grantRow = await one(
      tx,
      "vertex_model_use_grant_versions",
      scope,
      sql`grant_id = ${request.grantId} and grant_version = ${request.grantVersion}`
    );
    // Historical issuance identity remains necessary after processing ends;
    // this is deliberately NOT a current-head/worker/model-use reauthorization.
    if (
      !grantRow ||
      (await ctx.hash(grantRow["payload"])) !== grantRow["record_hash"] ||
      !same(grantRow["payload"], grant) ||
      grant.status !== "granted" ||
      grantRow["status"] !== grant.status ||
      grantRow["grant_id"] !== grant.grantId ||
      grantRow["grant_version"] !== grant.grantVersion ||
      grantRow["revision"] !== grant.revision ||
      grantRow["issued_by_actor_id"] !== grant.issuedByActorId ||
      grantRow["issued_at_ns"] !== time(grant.issuedAt).toString() ||
      grantRow["valid_from_ns"] !== time(grant.validFrom).toString() ||
      grantRow["expires_at_ns"] !== time(grant.expiresAt).toString()
    )
      return fail("integrity");
    const tokenCharge =
        BigInt(grant.maximumInputTokens) + BigInt(grant.maximumOutputTokens),
      costCharge = decimalUnits(grant.maximumCostUsd);
    if (
      (await ctx.hash(budget)) !== budgetRow["record_hash"] ||
      !same(budget["request"], request) ||
      grant.grantId !== request.grantId ||
      grant.grantVersion !== request.grantVersion ||
      grant.revision !== proof.grantRevision ||
      grant.privacyPolicyId !== review.policyId ||
      grant.privacyPolicyVersion !== review.policyVersion ||
      budget["tokenCharge"] !== tokenCharge.toString() ||
      budget["costChargeUnits"] !== costCharge.toString()
    )
      return fail("integrity");
    if (
      !same(reservation, {
        reservationId: `model-budget:${request.requestSha256}`,
        requestSha256: request.requestSha256,
        operation: request.operation,
        inputBytes: request.inputBytes,
        inputTokens: request.inputTokens,
        maximumOutputTokens: request.maximumOutputTokens,
        maximumCostUsd: request.maximumCostUsd,
        expiresAt: admission["expiresAt"],
      }) ||
      admission["chargeProfile"] !== "approved-grant-ceiling-v1" ||
      admission["unknownOutcome"] !== "retain-charge"
    )
      return fail("integrity");
    for (const [key, expected] of Object.entries({
      job_id: request.jobId,
      selection_id: request.selectionId,
      selection_sha256: request.selectionSha256,
      request_sha256: request.requestSha256,
      request_id: request.requestId,
      grant_id: request.grantId,
      grant_version: request.grantVersion,
      lease_id: request.leaseId,
      lease_epoch: request.leaseEpoch,
      reservation_id: reservation["reservationId"],
      operation: request.operation,
      input_bytes: String(request.inputBytes),
      input_tokens: String(request.inputTokens),
      maximum_output_tokens: String(request.maximumOutputTokens),
      maximum_cost_usd: request.maximumCostUsd,
      token_charge: tokenCharge.toString(),
      cost_charge_units: costCharge.toString(),
      window_id: budget["windowId"],
      window_revision: budget["windowRevision"],
      expires_at_ns: time(admission["expiresAt"]).toString(),
    }))
      if (budgetRow[key] !== expected) return fail("integrity");
    return {
      proofHash,
      firstDispatchSha256,
      dispatchSha256: string(dispatchRow["record_hash"]),
      budgetSha256: string(budgetRow["record_hash"]),
      reviewId: review.reviewId,
      reviewSha256: string(reviewRow["record_hash"]),
      ...(phase ? { nativePhase: phase } : {}),
    };
  };
  const nativeChainForProvenance = async (
    tx: Transaction,
    joined: Joined,
    phase: ReturnType<typeof WorkerNativeEvidencePhaseSchema.parse>,
    at: string
  ) => {
    if (phase.phaseOrdinal !== 2 || !phase.derivation) return fail("denied");
    const environment = string(joined.plan["environment"]);
    if (environment !== "research") return fail("denied");
    const scope = scopeOf({
        accountAlias: string(joined.plan["accountAlias"]),
        environment,
      }),
      derivation = phase.derivation;
    const dispatch = await one(
      tx,
      "vertex_research_chat_native_model_dispatches",
      scope,
      sql`response_request_id = ${phase.responseRequestId} and phase_ordinal = 1 and operation = 'model-completion'`
    );
    const audit = await one(
      tx,
      "vertex_model_use_proof_audits",
      scope,
      sql`request_sha256 = ${derivation.phaseOneRequestSha256} and record_hash = ${derivation.phaseOneProofSha256}`
    );
    if (!(dispatch && audit)) return fail("denied");
    const request = await parseModelUseRequest(
        object(dispatch["payload"])["request"]
      ),
      proof = ModelUseProofSchema.parse(audit["payload"]);
    if (
      request.requestSha256 !== derivation.phaseOneRequestSha256 ||
      (await ctx.hash(proof)) !== derivation.phaseOneProofSha256 ||
      !same(request.tools, ["read_reviewed_evidence"])
    )
      return fail("integrity");
    const original = await provenance(tx, joined, request, proof, at, 1);
    return {
      phaseOneDispatchSha256: original.dispatchSha256,
      phaseOneProofSha256: original.proofHash,
      phaseTwoSha256: phase.phaseSha256,
      derivationSha256: await ctx.hash(derivation),
    };
  };
  // One concrete local continuation, not a model loop or review issuer. Exact
  // phase-one audits precede governed reads; each asynchronous boundary rejoins
  // the original current authority. Only metadata leaves this method.
  const prepareNativeEvidencePhaseTwo = async (
    identity: WorkerServiceIdentity,
    raw: VertexRecord
  ): Promise<VertexRecord> => {
    const value = WorkerPrepareNativeEvidencePhaseTwoInputSchema.parse(
      ctx.capture(raw)
    );
    const scope = scopeOf(identity.scope),
      request = await parseModelUseRequest(value.request),
      proof = ModelUseProofSchema.parse(value.proof);
    if (
      !privacy ||
      request.consumerServiceId !== identity.servicePrincipalId ||
      scope.accountAlias !== value.accountAlias ||
      scope.environment !== value.environment
    )
      return fail("denied");
    const responseBytes = bytesOf(value.responseBase64),
      startedAt = ctx.now();
    let firstInput: Uint8Array | undefined, bundleBytes: Uint8Array | undefined;
    let derived:
      | ReturnType<typeof prepareNativeEvidencePhaseTwoInputs>
      | undefined;
    const currentOriginal = async (tx: Transaction, at: string) => {
      const joined = await worker.originalForTransaction(
        tx,
        scope,
        { jobId: value.jobId },
        at
      );
      if (
        !joined ||
        joined.closed ||
        joined.plan["format"] !== "vertex-research-chat-native-evidence-plan-v1"
      )
        return fail("denied");
      const original = await model.readModelOriginalForTransaction(
        tx,
        request,
        ctx.now()
      );
      if (
        original.nativePhase?.phaseOrdinal !== 1 ||
        request.leaseId !== value.leaseId ||
        request.leaseEpoch !== value.leaseEpoch ||
        request.jobId !== value.jobId ||
        !same(request.tools, ["read_reviewed_evidence"])
      )
        return fail("denied");
      await privacy.readForTransaction(tx, request, ctx.now());
      const association = await provenance(
        tx,
        joined,
        request,
        proof,
        ctx.now(),
        1
      );
      if (
        time(ctx.now()) < time(startedAt) ||
        time(ctx.now()) >= time(proof.validUntil) ||
        time(ctx.now()) >= time(original.expiresAt)
      )
        return fail("stale");
      return { joined, association, original };
    };
    try {
      const before = await locked(scope, currentOriginal),
        responseRequestId = string(before.joined.plan["responseRequestId"]);
      firstInput = await worker.copies.readNativeInput(
        scope,
        responseRequestId,
        "completionInput"
      );
      await locked(scope, currentOriginal);
      bundleBytes = await worker.copies.readNativeInput(
        scope,
        responseRequestId,
        "evidenceBundle"
      );
      const source = await locked(scope, currentOriginal);
      if (
        !(
          same(source.joined.plan, before.joined.plan) &&
          same(source.association, before.association)
        ) ||
        firstInput.byteLength !== request.inputBytes ||
        (await ctx.digest(firstInput)) !== request.inputSha256
      )
        return fail("integrity");
      derived = prepareNativeEvidencePhaseTwoInputs(
        firstInput,
        bundleBytes,
        responseBytes
      );
      const response = object(parseNativeEvidenceJson(responseBytes)),
        usage = object(response["usage"]);
      if (
        usage["prompt_tokens"] !== request.inputTokens ||
        typeof usage["completion_tokens"] !== "number" ||
        !Number.isSafeInteger(usage["completion_tokens"]) ||
        usage["completion_tokens"] < 0 ||
        usage["completion_tokens"] > request.maximumOutputTokens
      )
        return fail("integrity");
      // Usage and exact pricing are independently checked, never SDK attestation.
      await locked(scope, async (tx, at) => {
        await currentOriginal(tx, at);
        const policyBytes = await policy.readSelectedArtifact(
          tx,
          { actorId: request.researchPrincipalId },
          scope,
          PolicyArtifactPinSchema.parse(
            object(source.joined.plan["inputPolicy"])["modelPolicy"]
          )
        );
        try {
          if (
            (await ctx.digest(policyBytes)) !==
            object(source.joined.plan["inputPolicy"])["modelPolicySha256"]
          )
            return fail("integrity");
          const selected = object(vertexRuntimeModelJson(policyBytes));
          if (
            response["model"] !== selected["served_model"] ||
            response["model"] !==
              object(source.joined.plan["provider"])["servedModel"]
          )
            return fail("integrity");
          const inputPrice = decimalUnits(
              string(selected["input_usd_per_million"])
            ),
            outputPrice = decimalUnits(
              string(selected["output_usd_per_million"])
            );
          const cost =
            (BigInt(present(request.inputTokens)) * inputPrice +
              BigInt(usage["completion_tokens"] as number) * outputPrice +
              999999n) /
            1000000n;
          if (
            inputPrice <= 0n ||
            outputPrice <= 0n ||
            cost > decimalUnits(request.maximumCostUsd)
          )
            return fail("denied");
          return await currentOriginal(tx, ctx.now());
        } finally {
          policyBytes.fill(0);
        }
      });
      const derivation = {
        ...derived.derivation,
        phaseOneRequestSha256: request.requestSha256,
        phaseOneProofSha256: await ctx.hash(proof),
      };
      const phase = await worker.copies.materializeNativeEvidencePhaseTwo(
        scope,
        responseRequestId,
        {
          phaseOneResponse: responseBytes,
          toolResult: derived.toolResult,
          phaseTwoTokenizeInput: derived.phaseTwoTokenizeInput,
          phaseTwoCompletionInput: derived.phaseTwoCompletionInput,
          derivation,
        }
      );
      return await locked(scope, async (tx, at) => {
        const after = await currentOriginal(tx, at);
        const currentPhase = await worker.copies.readNativePhaseForTransaction(
          tx,
          scope,
          responseRequestId,
          2,
          ctx.now()
        );
        if (
          !(
            currentPhase &&
            same(currentPhase, phase) &&
            same(after.joined.plan, before.joined.plan)
          )
        )
          return fail("integrity");
        const handle = (
          purpose:
            | "phaseTwoTokenizeInput"
            | "phaseTwoCompletionInput"
            | "toolResult"
        ) => {
          const copy = after.joined.inventory.copies.find(
            (entry) =>
              entry.allocation.copyIdempotencyKey ===
              `native-evidence-${purpose}-v1`
          );
          if (!copy?.contentBinding) return fail("integrity");
          return {
            copyId: copy.allocation.copyId,
            reservationSha256: copy.allocation.reservationSha256,
            ...copy.contentBinding.content,
          };
        };
        const output = WorkerPrepareNativeEvidencePhaseTwoOutputSchema.parse({
          phase: currentPhase,
          copies: {
            phaseTwoTokenizeInput: handle("phaseTwoTokenizeInput"),
            phaseTwoCompletionInput: handle("phaseTwoCompletionInput"),
            toolResult: handle("toolResult"),
          },
          executionAuthorized: false,
        });
        await currentOriginal(tx, ctx.now());
        return output as unknown as VertexRecord;
      });
    } finally {
      responseBytes.fill(0);
      firstInput?.fill(0);
      bundleBytes?.fill(0);
      derived?.toolResult.fill(0);
      derived?.phaseTwoTokenizeInput.fill(0);
      derived?.phaseTwoCompletionInput.fill(0);
    }
  };
  const checkedOutputMetadata = (
    value: VertexRecord
  ): ResearchChatOutputMetadata => {
    const byteLength = value["byteLength"];
    if (
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > 262_144
    )
      return fail("integrity");
    return {
      ...value,
      responseRequestId: identifier(value["responseRequestId"]),
      planId: identifier(value["planId"]),
      planSha256: digestString(value["planSha256"]),
      copyId: identifier(value["copyId"]),
      contentSha256: digestString(value["contentSha256"]),
      byteLength,
    };
  };
  const readOrigin = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string
  ) => {
    const row = await one(
      tx,
      table,
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!row) return null;
    const value = object(row["payload"]);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      ![
        "vertex-research-chat-advisory-origin-v1",
        "vertex-research-chat-native-evidence-advisory-origin-v1",
      ].includes(string(value["profile"])) ||
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment ||
      value["responseRequestId"] !== responseRequestId
    )
      return fail("integrity");
    for (const [key, expected] of Object.entries({
      response_request_id: value["responseRequestId"],
      job_id: value["jobId"],
      run_id: value["runId"],
      plan_sha256: value["planSha256"],
      copy_id: value["copyId"],
      content_sha256: value["contentSha256"],
      request_sha256: value["modelUseRequestSha256"],
      response_sha256: value["responseSha256"],
    }))
      if (row[key] !== expected) return fail("integrity");
    return checkedOutputMetadata(value);
  };
  const prepareForTransaction = async (
    tx: Transaction,
    identity: WorkerServiceIdentity,
    raw: unknown,
    completionInputBytes: Uint8Array,
    at: string,
    sourceInputs?: ResearchChatSourceInputs
  ) => {
    const stage = WorkerStageArtifactInputSchema.parse(raw),
      extension = stage.chatCompletion;
    if (!(extension && privacy)) return fail("unavailable");
    const scope = scopeOf(identity.scope),
      request = await parseModelUseRequest(extension.request),
      proof = ModelUseProofSchema.parse(extension.proof);
    const joined = await worker.originalForTransaction(
      tx,
      scope,
      { jobId: stage.jobId },
      at
    );
    if (joined?.closed) return null;
    if (
      !joined ||
      stage.collectionId !== joined.plan["collectionId"] ||
      stage.artifactId !==
        object(object(joined.recipe["copies"])["advisory"])["copyId"] ||
      stage.rightsPolicyId !== joined.queuedMetadata.rights.policyId ||
      stage.rightsVersion !== joined.queuedMetadata.rights.version ||
      !same(
        stage.lineageArtifactIds,
        array(joined.plan["reviewPins"], 16).map(
          (pin) => object(pin)["artifactId"]
        )
      ) ||
      stage.contentType !== "application/json" ||
      stage.canonicalSha256 !== stage.contentSha256 ||
      request.consumerServiceId !== identity.servicePrincipalId ||
      request.leaseId !== stage.leaseId ||
      request.leaseEpoch !== stage.leaseEpoch ||
      time(proof.validUntil) <= time(ctx.now())
    )
      return fail("denied");
    await recheckSourceInputsForPlan(
      tx,
      { actorId: identifier(joined.plan["ownerActorId"]) },
      joined.plan,
      sourceInputs,
      ctx.now()
    );
    const association = await provenance(tx, joined, request, proof, at);
    const nativeChain = association.nativePhase
      ? await nativeChainForProvenance(tx, joined, association.nativePhase, at)
      : undefined;
    try {
      await model.readModelOriginalForTransaction(tx, request, ctx.now());
      await privacy.readForTransaction(tx, request, ctx.now());
    } catch (error) {
      if (error instanceof ChatWorkerOriginalClosedError) return null;
      throw error;
    }
    const modelPolicyBytes = new Uint8Array(
      await policy.readSelectedArtifact(
        tx,
        { actorId: request.researchPrincipalId },
        scope,
        PolicyArtifactPinSchema.parse(
          object(joined.plan["inputPolicy"])["modelPolicy"]
        )
      )
    );
    const responseBytes = bytesOf(extension.responseBase64),
      suppliedBytes = bytesOf(stage.contentBase64);
    let toolResultBytes: Uint8Array | undefined;
    try {
      if (association.nativePhase) {
        const complete = object(parseNativeEvidenceJson(completionInputBytes));
        toolResultBytes = new TextEncoder().encode(
          string(object(array(complete["messages"], 4)[3])["content"])
        );
      }
      const decoded =
        association.nativePhase && toolResultBytes
          ? await decodeResearchChatNativeEvidenceAdvisoryOutput({
              plan: VertexResearchChatNativeEvidencePlanV1Schema.parse(
                joined.plan
              ),
              configuration:
                VertexResearchChatNativeEvidenceConfigurationV1Schema.parse(
                  joined.configuration
                ),
              request,
              responseBytes,
              completionInputBytes,
              modelPolicy: object(vertexRuntimeModelJson(modelPolicyBytes)),
              phase: association.nativePhase,
              toolResultBytes,
            })
          : await decodeResearchChatAdvisoryOutput({
              plan: VertexResearchChatExecutionPlanSchema.parse(joined.plan),
              configuration:
                VertexResearchChatParticipantConfigurationV1Schema.parse(
                  joined.configuration
                ),
              request,
              responseBytes,
              completionInputBytes,
              modelPolicy: object(vertexRuntimeModelJson(modelPolicyBytes)),
            });
      try {
        const hash = await ctx.digest(decoded.bytes),
          selected = object(joined.selection["research"]);
        if (
          decoded.bytes.byteLength >
            Math.min(Number(joined.plan["advisoryMaximumBytes"]), 262_144) ||
          suppliedBytes.byteLength !== decoded.bytes.byteLength ||
          !suppliedBytes.every(
            (value, index) => value === decoded.bytes[index]
          ) ||
          hash !== stage.contentSha256
        )
          return fail("integrity");
        if (
          BigInt(decoded.usage.totalTokens) >
            BigInt(String(selected["tokenBudget"])) ||
          decimalUnits(decoded.usage.completionCostUsd) >
            decimalUnits(string(selected["costBudgetUsd"]))
        )
          return fail("denied");
        const metadata = {
          profile: nativeChain
            ? "vertex-research-chat-native-evidence-advisory-origin-v1"
            : "vertex-research-chat-advisory-origin-v1",
          ...(nativeChain ? { nativeChain } : {}),
          ...scope,
          responseRequestId: joined.plan["responseRequestId"],
          planId: joined.plan["planId"],
          planSha256: joined.plan["planSha256"],
          originalRequestSha256: joined.plan["requestSha256"],
          jobId: request.jobId,
          runId: joined.plan["runId"],
          traceId: joined.plan["traceId"],
          eventId: joined.origin["eventId"],
          recipeSha256: joined.origin["recipeSha256"],
          copyId: stage.artifactId,
          contentSha256: hash,
          byteLength: decoded.bytes.byteLength,
          modelUseRequestId: request.requestId,
          modelUseRequestSha256: request.requestSha256,
          postProofSha256: association.proofHash,
          postProofCheckedAt: proof.checkedAt,
          firstDispatchProofSha256: association.firstDispatchSha256,
          dispatchSha256: association.dispatchSha256,
          budgetSha256: association.budgetSha256,
          privacyReviewId: association.reviewId,
          privacyReviewSha256: association.reviewSha256,
          responseSha256: decoded.responseSha256,
          usage: decoded.usage,
          boundAt: at,
        };
        const old = await readOrigin(
          tx,
          scope,
          identifier(joined.plan["responseRequestId"])
        );
        if (old && !same({ ...old, boundAt: at }, metadata))
          return fail("conflict");
        const claim = await worker.copies.claimAdvisoryForTransaction(
          tx,
          scope,
          identifier(joined.plan["responseRequestId"]),
          { sha256: hash, byteLength: decoded.bytes.byteLength },
          ctx.now()
        );
        if (!claim) return null;
        if (!old)
          await insert(tx, table, scope, {
            response_request_id: metadata.responseRequestId,
            job_id: metadata.jobId,
            run_id: metadata.runId,
            plan_sha256: metadata.planSha256,
            copy_id: metadata.copyId,
            content_sha256: metadata.contentSha256,
            request_sha256: metadata.modelUseRequestSha256,
            response_sha256: metadata.responseSha256,
            record_hash: await ctx.hash(metadata),
            payload: metadata,
          });
        return {
          claim,
          metadata: checkedOutputMetadata(old ?? metadata),
          request,
          bytes: new Uint8Array(decoded.bytes),
          duplicate: old !== null,
          ...(sourceInputs ? { sourceInputs } : {}),
        };
      } finally {
        decoded.bytes.fill(0);
      }
    } finally {
      responseBytes.fill(0);
      suppliedBytes.fill(0);
      modelPolicyBytes.fill(0);
      toolResultBytes?.fill(0);
    }
  };
  type Prepared = ResearchChatOutputPrepared;
  const inspectForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => {
    const joined = await worker.derivedForTransaction(
      tx,
      scope,
      { responseRequestId },
      at
    );
    if (joined?.closed) return null;
    if (!joined) return fail("denied");
    const metadata = await readOrigin(tx, scope, responseRequestId);
    if (!metadata) return fail("unavailable");
    if (
      metadata["jobId"] !== joined.origin["jobId"] ||
      metadata["runId"] !== joined.plan["runId"] ||
      metadata["traceId"] !== joined.plan["traceId"] ||
      metadata["eventId"] !== joined.origin["eventId"] ||
      metadata["recipeSha256"] !== joined.origin["recipeSha256"] ||
      metadata.planId !== joined.plan["planId"] ||
      metadata.planSha256 !== joined.plan["planSha256"] ||
      metadata["originalRequestSha256"] !== joined.plan["requestSha256"] ||
      metadata.copyId !==
        object(object(joined.recipe["copies"])["advisory"])["copyId"] ||
      time(metadata["boundAt"]) > time(at)
    )
      return fail("integrity");
    const native =
      joined.plan["format"] === "vertex-research-chat-native-evidence-plan-v1";
    if (
      metadata["profile"] !==
      (native
        ? "vertex-research-chat-native-evidence-advisory-origin-v1"
        : "vertex-research-chat-advisory-origin-v1")
    )
      return fail("integrity");
    const dispatch = await one(
      tx,
      native
        ? "vertex_research_chat_native_model_dispatches"
        : "vertex_research_chat_model_dispatches",
      scope,
      sql`response_request_id = ${responseRequestId} and operation = 'model-completion' and ${native ? sql`phase_ordinal = 2` : sql`true`}`
    );
    const audit = await one(
      tx,
      "vertex_model_use_proof_audits",
      scope,
      sql`request_id = ${metadata["modelUseRequestId"]} and checked_at_ns = ${time(metadata["postProofCheckedAt"]).toString()} and record_hash = ${metadata["postProofSha256"]}`
    );
    if (!(dispatch && audit)) return fail("integrity");
    const request = await parseModelUseRequest(
        object(dispatch["payload"])["request"]
      ),
      proof = ModelUseProofSchema.parse(audit["payload"]);
    const association = await provenance(tx, joined, request, proof, at);
    if (
      metadata["modelUseRequestSha256"] !== request.requestSha256 ||
      association.proofHash !== metadata["postProofSha256"] ||
      association.firstDispatchSha256 !==
        metadata["firstDispatchProofSha256"] ||
      association.dispatchSha256 !== metadata["dispatchSha256"] ||
      association.budgetSha256 !== metadata["budgetSha256"] ||
      association.reviewId !== metadata["privacyReviewId"] ||
      association.reviewSha256 !== metadata["privacyReviewSha256"]
    )
      return fail("integrity");
    if (
      native &&
      !(
        association.nativePhase &&
        same(
          metadata["nativeChain"],
          await nativeChainForProvenance(
            tx,
            joined,
            association.nativePhase,
            at
          )
        )
      )
    )
      return fail("integrity");
    const copy = joined.inventory.copies.find(
      (entry) => entry.allocation.copyId === metadata.copyId
    );
    if (
      !copy?.contentBinding ||
      copy.contentBinding.content.sha256 !== metadata.contentSha256 ||
      copy.contentBinding.content.byteLength !== metadata.byteLength
    )
      return fail("integrity");
    return { joined, metadata };
  };
  const writeAndObserve = async (prepared: Prepared) => {
    let external:
      | Awaited<ReturnType<typeof worker.copies.writeOrInspectAdvisory>>
      | undefined;
    try {
      await locked(prepared.claim.binding.scope, async (tx, at) => {
        const source = await inspectForTransaction(
          tx,
          prepared.claim.binding.scope,
          prepared.claim.binding.responseRequestId,
          at
        );
        if (!(source && same(source.metadata, prepared.metadata)))
          return fail("denied");
        return await recheckSourceInputsForPlan(
          tx,
          { actorId: identifier(source.joined.plan["ownerActorId"]) },
          source.joined.plan,
          prepared.sourceInputs,
          ctx.now()
        );
      });
      const observed = await worker.copies.writeOrInspectAdvisory(
        prepared.claim,
        prepared.bytes
      );
      external = observed;
      return await locked(prepared.claim.binding.scope, async (tx, at) => {
        const source = await inspectForTransaction(
          tx,
          prepared.claim.binding.scope,
          prepared.claim.binding.responseRequestId,
          at
        );
        if (!source) return { status: "closed" as const };
        if (!same(source.metadata, prepared.metadata)) return fail("integrity");
        await recheckSourceInputsForPlan(
          tx,
          { actorId: identifier(source.joined.plan["ownerActorId"]) },
          source.joined.plan,
          prepared.sourceInputs,
          ctx.now()
        );
        const settled = await worker.copies.settleAdvisoryForTransaction(
          tx,
          prepared.claim.binding.scope,
          prepared.claim.binding.responseRequestId,
          prepared.claim.binding,
          observed,
          at
        );
        if (settled.status === "live")
          await recheckSourceInputsForPlan(
            tx,
            { actorId: identifier(source.joined.plan["ownerActorId"]) },
            source.joined.plan,
            prepared.sourceInputs,
            ctx.now()
          );
        return settled;
      });
    } finally {
      prepared.bytes.fill(0);
      if (external?.status === "live") external.bytes.fill(0);
    }
  };
  // Denial is not authority. Independently observe only this authenticated
  // original owner's immutable family/origin when an entry or late check fails.
  // No body read, new permission, or caller-denial-derived closure occurs here.
  const observeDeniedOwnerRead = (
    principal: VertexPrincipal,
    scope: Scope,
    responseRequestId: string
  ): Promise<void> =>
    locked(scope, async (tx, at) => {
      const original = await worker.copies.readHistoricalOriginalForTransaction(
        tx,
        scope,
        responseRequestId
      );
      if (original.plan["ownerActorId"] !== principal.actorId)
        return fail("denied");
      const row = await one(
        tx,
        "vertex_research_chat_worker_origins",
        scope,
        sql`response_request_id = ${responseRequestId}`
      );
      if (!row) return fail("denied");
      const origin = object(row["payload"]);
      if (
        (await ctx.hash(origin)) !== row["record_hash"] ||
        origin["profile"] !== "vertex-research-chat-worker-origin-v1" ||
        origin["accountAlias"] !== scope.accountAlias ||
        origin["environment"] !== scope.environment ||
        origin["responseRequestId"] !== responseRequestId ||
        origin["responseRequestId"] !== row["response_request_id"] ||
        origin["ownerActorId"] !== principal.actorId ||
        origin["ownerActorId"] !== row["owner_actor_id"] ||
        origin["planId"] !== original.plan["planId"] ||
        origin["planId"] !== row["plan_id"] ||
        origin["planSha256"] !== original.plan["planSha256"] ||
        origin["planSha256"] !== row["plan_sha256"] ||
        origin["requestSha256"] !== original.plan["requestSha256"] ||
        origin["approvalSha256"] !== (await ctx.hash(original.approval)) ||
        origin["runId"] !== original.plan["runId"] ||
        origin["runId"] !== row["run_id"] ||
        origin["traceId"] !== original.plan["traceId"] ||
        origin["eventId"] !== row["event_id"] ||
        origin["jobId"] !== row["job_id"] ||
        origin["recipeSha256"] !== row["recipe_sha256"] ||
        origin["recipeSha256"] !== (await ctx.hash(origin["recipe"]))
      )
        return fail("integrity");
      await worker.copies.observeOriginalAuthorityLossForTransaction(
        tx,
        scope,
        responseRequestId,
        at
      );
      return;
    });
  const readAdvisory = async (
    rawPrincipal: VertexPrincipal,
    rawScope: Scope,
    rawResponseRequestId: string,
    borrowedSources?: ResearchChatSourceInputs
  ): Promise<Uint8Array> => {
    const principal: VertexPrincipal = Object.freeze({
      actorId: identifier(rawPrincipal.actorId),
    });
    const scope: Scope = Object.freeze(
      scopeOf({
        accountAlias: identifier(rawScope.accountAlias),
        environment: rawScope.environment,
      })
    );
    const responseRequestId = identifier(rawResponseRequestId);
    const startedAt = ctx.now();
    let sourceInputs = borrowedSources;
    try {
      const before = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const callerGrant = await callerReadGrantForTransaction(
            tx,
            principal,
            scope,
            at
          );
          const source = await inspectForTransaction(
            tx,
            scope,
            responseRequestId,
            at
          );
          return source ? { ...source, callerGrant } : null;
        },
        true
      );
      if (!before || before.joined.plan["ownerActorId"] !== principal.actorId)
        return fail("denied");
      if (!sourceInputs)
        sourceInputs = await prepareSourceInputsForPlan(
          principal,
          scope,
          before.joined.plan,
          "private-read"
        );
      if (sourceInputs)
        await locked(scope, (tx, at) =>
          recheckSourceInputsForPlan(
            tx,
            principal,
            before.joined.plan,
            sourceInputs,
            at
          )
        );
      const bytes = await worker.copies.readAdvisory(
        principal,
        scope,
        responseRequestId
      );
      try {
        const digest = await ctx.digest(bytes);
        const after = await ctx.run(
          principal,
          scope,
          null,
          "research-chat",
          "read",
          async (tx, at) => {
            const source = await inspectForTransaction(
              tx,
              scope,
              responseRequestId,
              at
            );
            if (!source) return null;
            // Keep the original source and final caller pin under the SAME locks.
            await callerReadGrantForTransaction(
              tx,
              principal,
              scope,
              ctx.now(),
              before.callerGrant
            );
            const sourceUse = await recheckSourceInputsForPlan(
              tx,
              principal,
              source.joined.plan,
              sourceInputs,
              ctx.now()
            );
            return { ...source, sourceExpiresAt: sourceUse?.expiresAt };
          },
          true
        );
        if (
          !(after && same(before.metadata, after.metadata)) ||
          bytes.byteLength !== after.metadata.byteLength ||
          digest !== after.metadata.contentSha256
        )
          return fail("denied");
        const returnedAt = ctx.now();
        if (time(returnedAt) < time(startedAt)) return fail("denied");
        if (time(returnedAt) >= time(after.joined.expiresAt)) {
          await locked(scope, (tx, at) =>
            worker.copies.observeOriginalAuthorityLossForTransaction(
              tx,
              scope,
              responseRequestId,
              at
            )
          );
          return fail("denied");
        }
        if (
          time(returnedAt) >= time(before.callerGrant.expiresAt) ||
          (after.sourceExpiresAt &&
            time(returnedAt) >= time(after.sourceExpiresAt))
        )
          return fail("denied");
        return new Uint8Array(bytes);
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      await observeDeniedOwnerRead(principal, scope, responseRequestId);
      throw error;
    } finally {
      if (!borrowedSources && sourceInputs)
        disposeSourceInputs(sourceInputs.token);
    }
  };
  const expectedPublicRunForTransaction = async (
    tx: Transaction,
    joined: Joined
  ) => {
    const row = await one(
      tx,
      "vertex_records",
      scopeOf(joined.queuedMetadata.scope),
      sql`artifact_id = ${joined.origin["runArtifactId"]} and contract_name = 'AgentRun'`
    );
    if (
      !row ||
      row["record_hash"] !== joined.origin["runSha256"] ||
      (await ctx.hash(row["payload"])) !== row["record_hash"]
    )
      return fail("integrity");
    return ctx.validate("AgentRun", {
      ...object(row["payload"]),
      status: "completed",
      outputArtifactIds: [
        object(object(joined.recipe["copies"])["advisory"])["copyId"],
      ],
    });
  };
  const publicStageForTransaction = async (
    tx: Transaction,
    identity: WorkerServiceIdentity,
    raw: unknown,
    at: string
  ) => {
    const value = WorkerStageArtifactInputSchema.parse(raw),
      scope = scopeOf(identity.scope);
    const joined = await worker.originalForTransaction(
      tx,
      scope,
      { jobId: value.jobId },
      at
    );
    if (joined?.closed) return null;
    if (!joined) return fail("denied");
    const source = await inspectForTransaction(
      tx,
      scope,
      identifier(joined.plan["responseRequestId"]),
      at
    );
    if (
      !(
        source &&
        (await worker.copies.advisoryLiveProofForTransaction(
          tx,
          scope,
          identifier(joined.plan["responseRequestId"]),
          ctx.now()
        ))
      )
    )
      return null;
    if (
      value.chatCompletion !== undefined ||
      value.artifactId !== joined.plan["runId"] ||
      value.collectionId !== joined.plan["collectionId"] ||
      value.rightsPolicyId !== joined.queuedMetadata.rights.policyId ||
      value.rightsVersion !== joined.queuedMetadata.rights.version ||
      value.lineageArtifactIds.length !== 0 ||
      value.contentType !== "application/json" ||
      value.canonicalSha256 !== value.contentSha256
    )
      return fail("denied");
    const expected = await expectedPublicRunForTransaction(tx, joined),
      bytes = bytesOf(value.contentBase64);
    try {
      if (
        (await ctx.hash(expected)) !== value.contentSha256 ||
        (await ctx.digest(bytes)) !== value.contentSha256 ||
        !same(Array.from(bytes), Array.from(ctx.encode(expected)))
      )
        return fail("integrity");
      return expected;
    } finally {
      bytes.fill(0);
    }
  };
  const publicationForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => {
    const source = await inspectForTransaction(
      tx,
      scope,
      responseRequestId,
      at
    );
    if (
      !(
        source &&
        (await worker.copies.advisoryLiveProofForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        ))
      )
    )
      return { closed: true as const, publication: null };
    const { joined, metadata } = source;
    const publication = await one(
      tx,
      "vertex_worker_agent_publications",
      scope,
      sql`run_id = ${joined.plan["runId"]}`
    );
    if (!publication) return { closed: false as const, publication: null };
    const job = await one(
      tx,
      "vertex_worker_jobs",
      scope,
      sql`job_id = ${joined.origin["jobId"]}`
    );
    const admission = await one(
      tx,
      "vertex_worker_run_admissions",
      scope,
      sql`job_id = ${joined.origin["jobId"]} and run_id = ${joined.plan["runId"]}`
    );
    const row = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${joined.plan["runId"]} and contract_name = 'AgentRun'`
    );
    if (
      !(job && admission && row) ||
      job["event_id"] !== joined.origin["eventId"] ||
      admission["request_hash"] !== joined.origin["recipeSha256"] ||
      admission["lease_epoch"] !== job["lease_epoch"] ||
      time(admission["admitted_at"]) > time(publication["published_at"]) ||
      time(publication["published_at"]) < time(metadata["boundAt"]) ||
      time(publication["published_at"]) > time(at)
    )
      return fail("integrity");
    const lease = object(job["payload"]),
      stableBinding = {
        kind: lease["kind"],
        researchPrincipalId: lease["researchPrincipalId"],
        payloadArtifactId: lease["payloadArtifactId"],
        payloadSha256: lease["payloadSha256"],
        policySelectionId: lease["policySelectionId"],
        policySelectionSha256: lease["policySelectionSha256"],
        deadlineAt: lease["deadlineAt"],
      };
    if (
      lease["jobId"] !== job["job_id"] ||
      lease["eventId"] !== joined.origin["eventId"] ||
      lease["kind"] !== "research-run" ||
      lease["researchPrincipalId"] !== joined.plan["ownerActorId"] ||
      lease["payloadArtifactId"] !== joined.origin["recipeArtifactId"] ||
      lease["payloadSha256"] !== joined.origin["recipeSha256"] ||
      lease["policySelectionId"] !== joined.plan["selectionId"] ||
      lease["policySelectionSha256"] !== joined.plan["selectionSha256"] ||
      lease["deadlineAt"] !== joined.plan["expiresAt"] ||
      lease["leaseId"] !== job["lease_id"] ||
      lease["leaseEpoch"] !== job["lease_epoch"] ||
      (await ctx.hash({
        scope,
        eventId: lease["eventId"],
        ...stableBinding,
      })) !== job["binding_hash"] ||
      !same(job["output_artifact_ids"], [joined.plan["runId"]])
    )
      return fail("integrity");
    const run = await expectedPublicRunForTransaction(tx, joined),
      runHash = await ctx.hash(run);
    const artifact = {
        artifactId: identifier(joined.plan["runId"]),
        artifactSha256: runHash,
      },
      profile = {
        artifactId: identifier(metadata.copyId),
        artifactSha256: string(metadata.contentSha256),
      };
    if (
      !same(row["payload"], run) ||
      row["record_hash"] !== runHash ||
      row["artifact_sha256"] !== runHash ||
      publication["run_artifact_id"] !== artifact.artifactId ||
      publication["advisory_artifact_id"] !== profile.artifactId ||
      publication["advisory_sha256"] !== profile.artifactSha256 ||
      !same(publication["review_pins"], joined.plan["reviewPins"]) ||
      publication["request_hash"] !==
        (await ctx.hash({
          run,
          artifact,
          profile,
          reviewPins: joined.plan["reviewPins"],
        }))
    )
      return fail("integrity");
    const stored = await ctx.artifact(
      tx,
      { actorId: identifier(joined.plan["ownerActorId"]) },
      scope,
      identifier(joined.plan["collectionId"]),
      artifact.artifactId,
      "read",
      ctx.now()
    );
    if (
      stored?.contractName !== "AgentRun" ||
      stored.artifactSha256 !== runHash ||
      stored.rights.policyId !== joined.queuedMetadata.rights.policyId ||
      stored.rights.version !== joined.queuedMetadata.rights.version
    )
      return fail("integrity");
    if (joined.plan["format"] === "vertex-research-chat-plan-v2") {
      if (!debate) return fail("unavailable");
      await debate.currentForTransaction(tx, scope, joined.plan, ctx.now());
      await debate.settleForTransaction(
        tx,
        scope,
        joined.plan,
        object(metadata["usage"]),
        string(object(joined.configuration["budgets"])["tokenizeCostUsd"])
      );
    }
    return {
      closed: false as const,
      publication: {
        run,
        artifact,
        advisory: profile,
        job,
        publishedAt: string(publication["published_at"]),
      },
    };
  };
  // This is a transaction-bound concrete join, not the completed delivery
  // wrapper and not an authority-bearing source DTO. The conversation owner
  // calls it inside the SAME protected transaction as its reference/CAS work.
  const conversationEligibilityForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => {
    const startedAt = at;
    try {
      const original = await worker.derivedForTransaction(
        tx,
        scope,
        { responseRequestId },
        startedAt
      );
      if (!original || original.closed) return null;
      if (original.plan["ownerActorId"] !== principal.actorId)
        return fail("denied");
      if (!(await readOrigin(tx, scope, responseRequestId))) return null;
      const source = await inspectForTransaction(
        tx,
        scope,
        responseRequestId,
        ctx.now()
      );
      if (!source) return null;
      const value = await publicationForTransaction(
        tx,
        scope,
        responseRequestId,
        ctx.now()
      );
      if (
        value.closed ||
        !value.publication ||
        value.publication.job["state"] !== "succeeded" ||
        value.publication.job["outcome_hash"] === null
      )
        return null;
      // Lifecycle owner returns actual ACKs in context/tokenize/completion order
      // and verifies each bound copy effect and independent storage proof.
      const inputFenceAcknowledgements =
        await worker.copies.inputFenceAcksForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
      if (
        !inputFenceAcknowledgements ||
        inputFenceAcknowledgements.length !==
          (original.plan["format"] ===
          "vertex-research-chat-native-evidence-plan-v1"
            ? 8
            : 3)
      )
        return null;
      // Inside a predecessor walk both reads can share one kept original, so
      // plan and approval are compared across walks only; any insert in
      // between drops the kept read.
      const after = await worker.derivedForTransaction(
        tx,
        scope,
        { responseRequestId },
        ctx.now()
      );
      if (!after || after.closed) return null;
      if (
        !(
          same(original.plan, after.plan) &&
          same(original.approval, after.approval) &&
          same(original.origin, after.origin) &&
          same(source.joined.plan, after.plan)
        )
      )
        return fail("integrity");
      const expiresAt = [
        original.expiresAt,
        source.joined.expiresAt,
        after.expiresAt,
      ].reduce((a, b) => (time(a) <= time(b) ? a : b));
      if (
        time(ctx.now()) < time(startedAt) ||
        time(ctx.now()) >= time(expiresAt)
      )
        return fail("stale");
      return {
        joined: after,
        metadata: source.metadata,
        publication: value.publication,
        inputFenceAcknowledgements,
        expiresAt,
      };
    } catch (error) {
      // Missing creation/publication evidence is ineligible, never completed.
      // Do not reinterpret denial, corruption or a clock failure as evidence.
      if (error instanceof VertexStoreError && error.code === "unavailable")
        return null;
      throw error;
    }
  };
  // Independent owner continuation; NOT a relaxation of worker service/lease
  // checks and NOT an append/delivery ACK. One unknown fence remains ineligible.
  const readPrivateDeliverySource = async (
    rawPrincipal: VertexPrincipal,
    rawScope: Scope,
    rawResponseRequestId: string
  ) => {
    const principal: VertexPrincipal = Object.freeze({
      actorId: identifier(rawPrincipal.actorId),
    });
    const scope: Scope = Object.freeze(
      scopeOf({
        accountAlias: identifier(rawScope.accountAlias),
        environment: rawScope.environment,
      })
    );
    const responseRequestId = identifier(rawResponseRequestId);
    const startedAt = ctx.now();
    try {
      const result = await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        async (tx, at) => {
          const callerGrant = await callerReadGrantForTransaction(
            tx,
            principal,
            scope,
            at
          );
          const source = await inspectForTransaction(
            tx,
            scope,
            responseRequestId,
            at
          );
          if (!source) return null;
          if (source.joined.plan["ownerActorId"] !== principal.actorId)
            return fail("denied");
          const value = await publicationForTransaction(
            tx,
            scope,
            responseRequestId,
            ctx.now()
          );
          if (
            value.closed ||
            !value.publication ||
            value.publication.job["state"] !== "succeeded" ||
            value.publication.job["outcome_hash"] === null
          )
            return null;
          const acknowledgements =
            await worker.copies.inputFenceAcksForTransaction(
              tx,
              scope,
              responseRequestId,
              ctx.now()
            );
          if (
            !acknowledgements ||
            acknowledgements.length !==
              (source.joined.plan["format"] ===
              "vertex-research-chat-native-evidence-plan-v1"
                ? 8
                : 3)
          )
            return null;
          const after = await worker.derivedForTransaction(
            tx,
            scope,
            { responseRequestId },
            ctx.now()
          );
          if (!after || after.closed) return null;
          await callerReadGrantForTransaction(
            tx,
            principal,
            scope,
            ctx.now(),
            callerGrant
          );
          return {
            expiresAt: after.expiresAt,
            callerGrant,
            source: {
              run: value.publication.run,
              runArtifact: value.publication.artifact,
              advisoryArtifact: value.publication.advisory,
              inputFenceAcknowledgements: acknowledgements,
            },
          };
        },
        true
      );
      if (!result) return null;
      const returnedAt = ctx.now();
      if (time(returnedAt) < time(startedAt)) return fail("denied");
      if (time(returnedAt) >= time(result.expiresAt)) {
        await locked(scope, (tx, at) =>
          worker.copies.observeOriginalAuthorityLossForTransaction(
            tx,
            scope,
            responseRequestId,
            at
          )
        );
        return null;
      }
      if (time(returnedAt) >= time(result.callerGrant.expiresAt))
        return fail("denied");
      return result.source;
    } catch (error) {
      await observeDeniedOwnerRead(principal, scope, responseRequestId);
      throw error;
    }
  };
  // Local preparation only. The independent DB lineage owner separately binds
  // redisclosure authority. No caller-supplied reader or accepted boolean here.
  // SQL metadata/proof join ONLY. Source use also requires this owner's fresh
  // invocation-private external-read bundle; these projections are not authority.
  const readPublishedPredecessorOnce = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    pin: VertexResearchChatPublishedPredecessorV1,
    at: string
  ) => {
    const caller = await conversationCallerForTransaction(
      tx,
      principal,
      scope,
      at,
      false
    );
    const before = await conversationEligibilityForTransaction(
      tx,
      principal,
      scope,
      pin.responseRequestId,
      ctx.now()
    );
    if (
      before?.joined.plan["format"] !== "vertex-research-chat-plan-v2" ||
      !debate
    )
      return fail("denied");
    const original = before.joined.plan,
      step = object(original["debate"]);
    const copy = before.joined.inventory.copies.find(
      (entry) => entry.allocation.copyId === before.metadata.copyId
    );
    if (!copy) return fail("integrity");
    const expected = {
      ordinal: step["ordinal"],
      participantId: original["participantId"],
      responseRequestId: original["responseRequestId"],
      planId: original["planId"],
      planSha256: original["planSha256"],
      runId: original["runId"],
      copyId: before.metadata.copyId,
      reservationSha256: copy.allocation.reservationSha256,
      contentSha256: before.metadata.contentSha256,
      byteLength: before.metadata.byteLength,
      publishedAt: before.publication.publishedAt,
    };
    if (!same(pin, expected)) return fail("integrity");
    // Read grant and rights hold only at the moment they are checked, so a
    // reuse inside a predecessor walk runs this again.
    const authority = async (): Promise<void> => {
      await ctx.authorize(
        principal,
        scope,
        identifier(original["collectionId"]),
        pin.copyId,
        "read",
        ctx.now()
      );
      for (const action of ["derive", "export"] as const)
        await ctx.rights(
          tx,
          scope,
          identifier(original["collectionId"]),
          before.joined.queuedMetadata.rights,
          action,
          ctx.now()
        );
    };
    await authority();
    const live = await worker.copies.advisoryLiveProofForTransaction(
      tx,
      scope,
      pin.responseRequestId,
      ctx.now()
    );
    if (!live) return fail("denied");
    const authoritySha256 = await debate.sourceReviewShaForTransaction(
      tx,
      scope,
      original
    );
    const finalCaller = await conversationCallerForTransaction(
      tx,
      principal,
      scope,
      ctx.now(),
      false,
      caller
    );
    const expiresAt = [before.expiresAt, finalCaller.expiresAt].reduce(
      (a, b) => (time(a) <= time(b) ? a : b)
    );
    if (time(ctx.now()) < time(at) || time(ctx.now()) >= time(expiresAt))
      return fail("stale");
    return {
      source: {
        pin: expected,
        plan: original,
        metadata: before.metadata,
        bindingSha256: await ctx.hash(live.binding),
        proofSha256: await ctx.hash(live.proof),
        authoritySha256,
        expiresAt,
      },
      authority,
    };
  };
  // A nested currency check of an earlier debate turn reads the same exact pins
  // again. Inside one predecessor walk (withPredecessorWalk) a completed read is
  // reused. The key binds the caller, the scope and the full pin. A reuse runs
  // the read grant and rights checks again, then the same final clock checks
  // as a fresh read.
  const readPublishedPredecessorForTransaction = (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: Scope,
    supplied: VertexRecord,
    at: string
  ) =>
    withPredecessorWalk(tx, async () => {
      const pin =
        VertexResearchChatPublishedPredecessorV1Schema.parse(supplied);
      const read = await reusePredecessorRead(
        tx,
        readPublishedPredecessorOnce,
        canonicalArtifactJson({ actorId: principal.actorId, scope, pin }),
        () => readPublishedPredecessorOnce(tx, principal, scope, pin, at),
        async (kept) => {
          await kept.authority();
          if (
            time(ctx.now()) < time(at) ||
            time(ctx.now()) >= time(kept.source.expiresAt)
          )
            fail("stale");
        }
      );
      return read.source;
    });
  type SourceSnapshot = Awaited<
    ReturnType<typeof readPublishedPredecessorForTransaction>
  > &
    Readonly<{ bytes: Uint8Array }>;
  type SourceState = Readonly<{
    request: ResearchChatSourceRequest;
    caller: ConversationCaller;
    startedAt: string;
    expiresAt: string;
    sources: readonly SourceSnapshot[];
  }>;
  const sourceInputStates = new WeakMap<
    ResearchChatPreparedSources,
    SourceState
  >();
  const captureSourceRequest = (
    raw: ResearchChatSourceRequest
  ): ResearchChatSourceRequest => {
    const value = ctx.capture(raw);
    const keys = [
      "scope",
      "ownerActorId",
      "requesterActorId",
      "threadId",
      "responseRequestId",
      "requestSha256",
      "planSha256",
      "planExpiresAt",
      "purpose",
      "predecessors",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value.scope).length !== 2 ||
      value.scope.environment !== "research"
    )
      return fail("invalid");
    const pins = array(value.predecessors, 4).map((pin) =>
      VertexResearchChatPublishedPredecessorV1Schema.parse(pin)
    );
    if (
      pins.some(
        (pin, i) =>
          pin.ordinal !== i + 1 ||
          pin.responseRequestId === value.responseRequestId
      )
    )
      return fail("denied");
    if (value.planExpiresAt !== null) time(value.planExpiresAt);
    return Object.freeze({
      scope: {
        accountAlias: identifier(value.scope.accountAlias),
        environment: "research" as const,
      },
      ownerActorId: identifier(value.ownerActorId),
      requesterActorId: identifier(value.requesterActorId),
      threadId: identifier(value.threadId),
      responseRequestId: identifier(value.responseRequestId),
      requestSha256: digestString(value.requestSha256),
      planSha256:
        value.planSha256 === null ? null : digestString(value.planSha256),
      planExpiresAt: value.planExpiresAt,
      purpose: identifier(value.purpose),
      predecessors: pins,
    });
  };
  const disposeSourceInputs = (token: ResearchChatPreparedSources): void => {
    const state = sourceInputStates.get(token);
    sourceInputStates.delete(token);
    if (state) for (const source of state.sources) source.bytes.fill(0);
  };
  const recheckSourceInputsForTransaction = async (
    tx: Transaction,
    supplied: ResearchChatSourceRequest,
    token: ResearchChatPreparedSources,
    at: string,
    includeBytes = false
  ): Promise<ResearchChatSourceRecheck> => {
    const request = captureSourceRequest(supplied),
      state = sourceInputStates.get(token);
    if (
      !(state && same(request, state.request)) ||
      time(at) < time(state.startedAt) ||
      time(ctx.now()) >= time(state.expiresAt)
    )
      return fail("denied");
    const principal = { actorId: request.ownerActorId },
      scope = request.scope;
    const sources: {
      pin: VertexRecord;
      expiresAt: string;
      bytes?: Uint8Array;
    }[] = [];
    let expiresAt = state.expiresAt;
    try {
      // One walk: a later pin's nested checks reuse the earlier pins' reads.
      await withPredecessorWalk(tx, async () => {
        for (const held of state.sources) {
          const current = await readPublishedPredecessorForTransaction(
            tx,
            principal,
            scope,
            held.pin,
            ctx.now()
          );
          if (
            !(
              same(held.pin, current.pin) &&
              same(held.plan, current.plan) &&
              same(held.metadata, current.metadata)
            ) ||
            held.bindingSha256 !== current.bindingSha256 ||
            held.proofSha256 !== current.proofSha256 ||
            held.authoritySha256 !== current.authoritySha256 ||
            held.bytes.byteLength !== current.pin.byteLength ||
            (await ctx.digest(held.bytes)) !== current.pin.contentSha256
          )
            return fail("denied");
          expiresAt =
            time(current.expiresAt) < time(expiresAt)
              ? current.expiresAt
              : expiresAt;
          sources.push({
            pin: current.pin,
            expiresAt: current.expiresAt,
            ...(includeBytes ? { bytes: new Uint8Array(held.bytes) } : {}),
          });
        }
      });
      const caller = await conversationCallerForTransaction(
        tx,
        principal,
        scope,
        ctx.now(),
        false,
        state.caller
      );
      expiresAt =
        time(caller.expiresAt) < time(expiresAt) ? caller.expiresAt : expiresAt;
      if (
        !sourceInputStates.has(token) ||
        time(ctx.now()) < time(at) ||
        time(ctx.now()) >= time(expiresAt)
      )
        return fail("stale");
      return { expiresAt, sources };
    } catch (error) {
      for (const source of sources) source.bytes?.fill(0);
      throw error;
    }
  };
  const prepareSourceInputs = async (
    supplied: ResearchChatSourceRequest
  ): Promise<ResearchChatPreparedSources> => {
    const request = captureSourceRequest(supplied),
      principal = { actorId: request.ownerActorId },
      scope = request.scope,
      startedAt = ctx.now();
    const before = await locked(scope, async (tx, at) => {
      const caller = await conversationCallerForTransaction(
        tx,
        principal,
        scope,
        at,
        false
      );
      const sources: Awaited<
        ReturnType<typeof readPublishedPredecessorForTransaction>
      >[] = [];
      // One walk: a later pin's nested checks reuse the earlier pins' reads.
      await withPredecessorWalk(tx, async () => {
        for (const pin of request.predecessors) {
          const source = await readPublishedPredecessorForTransaction(
            tx,
            principal,
            scope,
            pin,
            ctx.now()
          );
          if (
            source.plan["ownerActorId"] !== request.ownerActorId ||
            source.plan["threadId"] !== request.threadId
          )
            return fail("denied");
          sources.push(source);
        }
      });
      return { caller, sources };
    });
    const held: SourceSnapshot[] = [];
    const token: ResearchChatPreparedSources = Object.freeze({
      kind: "research-chat-prepared-sources-v1",
    });
    try {
      // One governed external read per predecessor, outside ALL SQL transactions.
      // Metadata ancestor joins never recursively read objects.
      for (const source of before.sources) {
        const bytes = await worker.copies.readAdvisory(
          principal,
          scope,
          identifier(source.pin.responseRequestId)
        );
        held.push({ ...source, bytes });
        if (
          bytes.byteLength !== source.pin.byteLength ||
          (await ctx.digest(bytes)) !== source.pin.contentSha256
        )
          return fail("integrity");
        const profile = VertexResearchChatAdvisoryV2ProfileSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
        if (
          profile.responseRequestId !== source.plan["responseRequestId"] ||
          profile.planId !== source.plan["planId"] ||
          profile.planSha256 !== source.plan["planSha256"] ||
          profile.runId !== source.plan["runId"] ||
          !same(profile.debate, source.plan["debate"]) ||
          (await ctx.hash(profile)) !== source.pin.contentSha256
        )
          return fail("integrity");
      }
      const projectionEnd = new Date(
        Number(time(startedAt) / 1_000_000n) + ctx.maxProjectionAgeMs
      ).toISOString();
      const ends = [
        projectionEnd,
        before.caller.expiresAt,
        ...held.map((source) => source.expiresAt),
        ...(request.planExpiresAt ? [request.planExpiresAt] : []),
      ];
      const expiresAt = ends.reduce((a, b) => (time(a) <= time(b) ? a : b));
      sourceInputStates.set(token, {
        request,
        caller: before.caller,
        startedAt,
        expiresAt,
        sources: held,
      });
      await locked(scope, (tx, at) =>
        recheckSourceInputsForTransaction(tx, request, token, at)
      );
      return token;
    } catch (error) {
      disposeSourceInputs(token);
      for (const source of held) source.bytes.fill(0);
      throw error;
    }
  };
  const prepareSourceInputsForPlan = async (
    principal: VertexPrincipal,
    scope: Scope,
    plan: VertexRecord,
    purpose: string
  ): Promise<ResearchChatSourceInputs | undefined> => {
    if (plan["format"] !== "vertex-research-chat-plan-v2") return undefined;
    if (
      plan["ownerActorId"] !== principal.actorId ||
      plan["accountAlias"] !== scope.accountAlias ||
      plan["environment"] !== scope.environment
    )
      return fail("denied");
    const request: ResearchChatSourceRequest = {
      scope,
      ownerActorId: principal.actorId,
      requesterActorId: principal.actorId,
      threadId: identifier(plan["threadId"]),
      responseRequestId: identifier(plan["responseRequestId"]),
      requestSha256: string(plan["requestSha256"]),
      planSha256: string(plan["planSha256"]),
      planExpiresAt: string(plan["expiresAt"]),
      purpose,
      predecessors: array(object(plan["debate"])["predecessors"], 4).map(
        object
      ),
    };
    return { request, token: await prepareSourceInputs(request) };
  };
  const recheckSourceInputsForPlan = async (
    tx: Transaction,
    principal: VertexPrincipal,
    plan: VertexRecord,
    inputs: ResearchChatSourceInputs | undefined,
    at: string
  ) => {
    if (plan["format"] !== "vertex-research-chat-plan-v2") {
      if (inputs) return fail("denied");
      return null;
    }
    if (
      !inputs ||
      plan["ownerActorId"] !== principal.actorId ||
      inputs.request.planExpiresAt === null ||
      time(inputs.request.planExpiresAt) > time(plan["expiresAt"])
    )
      return fail("denied");
    const expected: ResearchChatSourceRequest = {
      ...inputs.request,
      scope: {
        accountAlias: identifier(plan["accountAlias"]),
        environment: "research",
      },
      ownerActorId: principal.actorId,
      threadId: identifier(plan["threadId"]),
      responseRequestId: identifier(plan["responseRequestId"]),
      requestSha256: string(plan["requestSha256"]),
      planSha256: string(plan["planSha256"]),
      predecessors: array(object(plan["debate"])["predecessors"], 4).map(
        object
      ),
    };
    return await recheckSourceInputsForTransaction(
      tx,
      expected,
      inputs.token,
      at
    );
  };
  return Object.freeze({
    prepareNativeEvidencePhaseTwo,
    prepareForTransaction,
    inspectForTransaction,
    writeAndObserve,
    readAdvisory,
    expectedPublicRunForTransaction,
    publicStageForTransaction,
    publicationForTransaction,
    readPrivateDeliverySource,
    conversationCallerForTransaction,
    conversationEligibilityForTransaction,
    observeDeniedOwnerRead,
    readPublishedPredecessorForTransaction,
    prepareSourceInputs,
    recheckSourceInputsForTransaction,
    disposeSourceInputs,
    prepareSourceInputsForPlan,
    recheckSourceInputsForPlan,
  });
};
export type VertexResearchChatOutputRuntime = ReturnType<
  typeof createVertexResearchChatOutputRuntime
>;
