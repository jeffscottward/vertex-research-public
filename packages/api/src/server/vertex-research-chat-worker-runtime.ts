import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Transaction } from "@darkfactory/db/server";
import type { VertexRecord } from "@darkfactory/db/server/vertex";
import type { ResearchChatWorkerOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import {
  array,
  fail,
  insert,
  object,
  one,
  rows,
  string,
  time,
  type PersistenceContext,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import { decimalUnits, hashArtifact } from "@darkfactory/shared/vertex";
import {
  ModelUseGrantSchema,
  parseModelUseRequest,
  type ModelUseGrant,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import {
  WorkerLeaseSchema,
  WorkerServiceGrantSchema,
} from "../contracts/vertex-worker.ts";
import { FirstMatePrivacyRendezvousAdapterSchema } from "../contracts/vertex-model-privacy-rendezvous.ts";

import { PolicyArtifactPinSchema } from "../contracts/vertex-policy.ts";
import type { createVertexRuntimePolicy } from "./vertex-runtime-policy.ts";
import {
  VertexRuntimeModelDescriptorSchema,
  vertexRuntimeModelJson,
} from "./vertex-runtime-model-evidence.ts";
import { ResearchChatNativeServingManifestSchema } from "./vertex-research-chat-inputs.ts";
import { present } from "./present.ts";
// The pinned private config discriminator is profile, separate from observation
// DTO format. Preserve the exported strict v1 schema and every original join.
const SelectedFirstMatePrivacyRendezvousAdapterSchema = z.union([
  FirstMatePrivacyRendezvousAdapterSchema,
  FirstMatePrivacyRendezvousAdapterSchema.extend({
    profile: z.literal("vertex-first-mate-review-rendezvous-adapter-config-v2"),
  }).strict(),
  FirstMatePrivacyRendezvousAdapterSchema.extend({
    profile: z.literal("vertex-first-mate-native-evidence-adapter-config-v1"),
    native_evidence: z
      .object({
        protocol: z.literal("first-mate-read-reviewed-evidence-v1"),
        nativeServing: PolicyArtifactPinSchema,
        serializerProfile: z.literal(
          "agno-1.7.12-openai-1.93.0-native-single-invoke-v1"
        ),
        allowedTools: z.tuple([z.literal("read_reviewed_evidence")]),
      })
      .strict(),
  }).strict(),
]);
export type ChatWorkerModelOriginal = Readonly<{
  responseRequestId: string;
  planId: string;
  planSha256: string;
  ownerActorId: string;
  consumerServicePrincipalId: string;
  originalRequestSha256: string;
  expiresAt: string;
  modelGrant: ModelUseGrant;
  modelGrantRevision: string;
  nativePhase?: Readonly<{ phaseOrdinal: 1 | 2; phaseSha256: string }>;
}>;
// Concrete server owner, not an injected allow/authority DTO. Every selector is
// joined to the persisted original approval, actual queued event, job and lease.
// Only this observed lifecycle-loss marker may be caught INSIDE a caller's
// metadata transaction so durable closure commits before external denial.
export class ChatWorkerOriginalClosedError extends Error {}
export const createVertexResearchChatWorkerRuntime = (
  ctx: PersistenceContext,
  worker: ResearchChatWorkerOperations,
  policy: ReturnType<typeof createVertexRuntimePolicy>
) => {
  const readModelOriginalForTransaction = async (
    tx: Transaction,
    raw: ModelUseRequest,
    at: string
  ): Promise<ChatWorkerModelOriginal> => {
    const request = await parseModelUseRequest(raw),
      scope = {
        accountAlias: request.accountAlias,
        environment: request.environment,
      };
    const joined = await worker.originalForTransaction(
      tx,
      scope,
      { jobId: request.jobId },
      at
    );
    if (joined?.closed)
      throw new ChatWorkerOriginalClosedError("Original chat authority closed");
    if (!joined || request.environment !== "research") return fail("denied");
    const { plan, origin, configuration, selection } = joined;
    const job = await one(
      tx,
      "vertex_worker_jobs",
      scope,
      sql`job_id = ${request.jobId}`
    );
    const admission = await one(
      tx,
      "vertex_worker_run_admissions",
      scope,
      sql`job_id = ${request.jobId}`
    );
    if (
      !(job && admission) ||
      job["state"] !== "running" ||
      job["lease_id"] !== request.leaseId ||
      job["lease_epoch"] !== request.leaseEpoch ||
      admission["run_id"] !== plan["runId"] ||
      admission["request_hash"] !== origin["recipeSha256"] ||
      admission["lease_epoch"] !== request.leaseEpoch ||
      time(admission["admitted_at"]) > time(at)
    )
      return fail("denied");
    const lease = WorkerLeaseSchema.parse(job["payload"]);
    if (
      lease.jobId !== request.jobId ||
      lease.eventId !== origin["eventId"] ||
      lease.researchPrincipalId !== plan["ownerActorId"] ||
      lease.researchPrincipalId !== request.researchPrincipalId ||
      lease.kind !== "research-run" ||
      lease.leaseId !== request.leaseId ||
      lease.leaseEpoch !== request.leaseEpoch ||
      lease.policySelectionId !== plan["selectionId"] ||
      lease.policySelectionSha256 !== plan["selectionSha256"] ||
      lease.payloadSha256 !== origin["recipeSha256"] ||
      lease.deadlineAt !== plan["expiresAt"] ||
      job["event_id"] !== origin["eventId"] ||
      job["lease_expires_at_ns"] !== time(lease.leaseExpiresAt).toString() ||
      job["deadline_at_ns"] !== time(lease.deadlineAt).toString()
    )
      return fail("denied");
    const stableBinding = {
      kind: lease.kind,
      researchPrincipalId: lease.researchPrincipalId,
      payloadArtifactId: lease.payloadArtifactId,
      payloadSha256: lease.payloadSha256,
      policySelectionId: lease.policySelectionId,
      policySelectionSha256: lease.policySelectionSha256,
      deadlineAt: lease.deadlineAt,
    };
    if (
      lease.accountAlias !== scope.accountAlias ||
      lease.environment !== scope.environment ||
      lease.payloadArtifactId !== origin["recipeArtifactId"] ||
      job["worker_instance_id"] !== lease.leaseId ||
      job["attempt"] !== lease.attempt ||
      (await hashArtifact({
        scope,
        eventId: lease.eventId,
        ...stableBinding,
      })) !== job["binding_hash"]
    )
      return fail("integrity");
    const serviceRow = await one(
      tx,
      "vertex_worker_service_grants",
      scope,
      sql`grant_id = ${job["grant_id"]}`
    );
    if (!serviceRow) return fail("denied");
    const service = WorkerServiceGrantSchema.parse(serviceRow["payload"]);
    if (
      (await hashArtifact(service)) !== serviceRow["record_hash"] ||
      service.grantId !== job["grant_id"] ||
      service.servicePrincipalId !== request.consumerServiceId ||
      serviceRow["service_principal_id"] !== service.servicePrincipalId ||
      service.accountAlias !== scope.accountAlias ||
      service.environment !== scope.environment ||
      service.revokedAt !== null ||
      serviceRow["revoked_at"] !== null ||
      !service.operations.includes("currentModelUse") ||
      serviceRow["issued_at_ns"] !== time(service.issuedAt).toString() ||
      serviceRow["expires_at_ns"] !== time(service.expiresAt).toString() ||
      time(service.issuedAt) > time(at)
    )
      return fail("denied");
    const ownedSelection = await policy.materializeForTransaction(
      tx,
      { actorId: request.researchPrincipalId },
      {
        ...scope,
        selectionId: request.selectionId,
        selectionSha256: request.selectionSha256,
      },
      service.servicePrincipalId,
      request.jobId
    );
    if (
      ownedSelection.selectionId !== plan["selectionId"] ||
      ownedSelection.selectionSha256 !== plan["selectionSha256"]
    )
      return fail("denied");
    const provider = object(plan["provider"]),
      budgets = object(configuration["budgets"]),
      inputPolicy = object(plan["inputPolicy"]);
    const tokenize = request.operation === "model-tokenize";
    const native =
      plan["format"] === "vertex-research-chat-native-evidence-plan-v1"
        ? object(plan["nativeEvidence"])
        : null;
    let nativePhase: ChatWorkerModelOriginal["nativePhase"],
      phaseExpiry: string | undefined;
    let pin = object(plan[tokenize ? "tokenizeInput" : "completionInput"]);
    if (native !== null) {
      if (
        native["profile"] !== "first-mate-read-reviewed-evidence-v1" ||
        plan["participantId"] !== "first-mate" ||
        scope.environment !== "research"
      )
        return fail("denied");
      const researchScope = {
        accountAlias: scope.accountAlias,
        environment: "research" as const,
      };
      for (const ordinal of [1, 2] as const) {
        const phase = await worker.copies.readNativePhaseForTransaction(
          tx,
          researchScope,
          string(plan["responseRequestId"]),
          ordinal,
          at
        );
        if (phase === null) continue;
        const candidate = phase[tokenize ? "tokenizeInput" : "completionInput"];
        if (
          candidate.sha256 !== request.inputSha256 ||
          candidate.byteLength !== request.inputBytes
        )
          continue;
        if (
          nativePhase !== undefined ||
          phase.planSha256 !== plan["planSha256"]
        )
          return fail("integrity");
        nativePhase = { phaseOrdinal: ordinal, phaseSha256: phase.phaseSha256 };
        phaseExpiry = phase.expiresAt;
        pin = candidate;
      }
      if (nativePhase === undefined) return fail("denied");
    }
    const endpointPin = object(
      provider[tokenize ? "tokenizeEndpoint" : "completionEndpoint"]
    );
    const selectedEndpoints = array(selection["artifacts"], 512)
      .map(object)
      .filter(
        (entry) =>
          entry["role"] === "endpoint" &&
          object(entry["artifact"])["artifactId"] ===
            endpointPin["artifactId"] &&
          object(entry["artifact"])["artifactSha256"] ===
            endpointPin["artifactSha256"]
      );
    const readPolicy = async (pinValue: unknown): Promise<VertexRecord> => {
      const parsed = PolicyArtifactPinSchema.parse(pinValue);
      const bytes = await policy.readSelectedArtifact(
        tx,
        { actorId: request.researchPrincipalId },
        scope,
        parsed
      );
      if ((await hashArtifact(bytes)) !== parsed.artifactSha256)
        return fail("integrity");
      return object(vertexRuntimeModelJson(bytes));
    };
    const modelPolicy = await readPolicy(inputPolicy["modelPolicy"]);
    if (native !== null) {
      const nativePin = PolicyArtifactPinSchema.parse(
        native["nativeCapability"]
      );
      const manifests = array(selection["artifacts"], 512)
        .map(object)
        .filter(
          (entry) =>
            object(entry["artifact"])["artifactSha256"] ===
            modelPolicy["serving_manifest_sha256"]
        );
      if (
        manifests.length !== 1 ||
        present(manifests[0])["role"] !== "tool-config" ||
        (await hashArtifact(present(manifests[0])["artifact"])) !==
          (await hashArtifact(nativePin)) ||
        nativePin.artifactSha256 !== modelPolicy["serving_manifest_sha256"]
      )
        return fail("denied");
      const manifest = ResearchChatNativeServingManifestSchema.parse(
        await readPolicy(nativePin)
      );
      if (
        manifest.serializerProfile !== native["serializerProfile"] ||
        manifest.protocol !== native["profile"]
      )
        return fail("denied");
    }
    const descriptor = VertexRuntimeModelDescriptorSchema.parse(
      await readPolicy(inputPolicy["modelDescriptor"])
    );
    const selectedModels = array(selection["artifacts"], 512)
      .map(object)
      .filter((entry) => entry["role"] === "model");
    const selectedPolicies = array(selection["artifacts"], 512)
      .map(object)
      .filter(
        (entry) =>
          entry["role"] === "tool-config" &&
          object(entry["artifact"])["artifactId"] ===
            object(inputPolicy["modelPolicy"])["artifactId"]
      );
    if (
      selectedModels.length !== 1 ||
      (await hashArtifact(present(selectedModels[0])["artifact"])) !==
        (await hashArtifact(inputPolicy["modelDescriptor"])) ||
      selectedPolicies.length !== 1 ||
      (await hashArtifact(present(selectedPolicies[0])["artifact"])) !==
        (await hashArtifact(inputPolicy["modelPolicy"]))
    )
      return fail("denied");
    for (const key of [
      "accountAlias",
      "environment",
      "providerId",
      "modelVersion",
      "tokenizerArtifactId",
      "tokenizerSha256",
      "modelUsePolicyVersion",
    ] as const)
      if (descriptor[key] !== request[key]) return fail("denied");
    if (
      (await hashArtifact(modelPolicy)) !== inputPolicy["modelPolicySha256"] ||
      (await hashArtifact(descriptor)) !==
        inputPolicy["modelDescriptorSha256"] ||
      descriptor.modelUsePolicyVersion !== request.modelUsePolicyVersion
    )
      return fail("denied");
    if (selectedEndpoints.length !== 1) return fail("denied");
    const endpointId = string(present(selectedEndpoints[0])["bindingId"]);
    if (
      endpointId !==
        modelPolicy[
          tokenize ? "tokenize_endpoint_id" : "completion_endpoint_id"
        ] ||
      descriptor.endpointReferenceId !==
        modelPolicy["completion_endpoint_id"] ||
      descriptor.endpointSha256 !==
        object(provider["completionEndpoint"])["artifactSha256"]
    )
      return fail("denied");
    const capabilities = array(selection["providerCapabilities"], 512)
      .map(object)
      .filter(
        (entry) =>
          entry["operation"] === request.operation &&
          entry["endpointReferenceId"] === endpointId &&
          entry["endpointSha256"] === endpointPin["artifactSha256"] &&
          entry["providerId"] === provider["providerId"] &&
          entry["modelVersion"] === provider["modelVersion"]
      );
    if (
      capabilities.length !== 1 ||
      present(capabilities[0])["state"] !== "ready" ||
      time(present(capabilities[0])["observedAt"]) > time(at)
    )
      return fail("denied");
    const references = array(selection["references"], 512)
      .map(object)
      .filter(
        (entry) =>
          entry["referenceId"] === endpointId &&
          entry["referenceSha256"] === endpointPin["artifactSha256"] &&
          entry["ownerService"] === service.servicePrincipalId &&
          entry["exposure"] === "server-only" &&
          entry["verificationState"] === "verified"
      );
    if (
      references.length !== 1 ||
      present(references[0])["lastVerifiedAt"] === null ||
      time(present(references[0])["lastVerifiedAt"]) > time(at)
    )
      return fail("denied");
    const expectedTools =
      nativePhase?.phaseOrdinal === 1 && !tokenize
        ? ["read_reviewed_evidence"]
        : [];
    if (
      request.selectionId !== plan["selectionId"] ||
      request.selectionSha256 !== plan["selectionSha256"] ||
      request.providerId !== provider["providerId"] ||
      request.modelVersion !== provider["modelVersion"] ||
      request.endpointReferenceId !== endpointId ||
      request.endpointSha256 !== endpointPin["artifactSha256"] ||
      object(inputPolicy["endpointPolicySha256"])[request.operation] !==
        request.endpointSha256 ||
      request.tokenizerArtifactId !==
        object(provider["tokenizerArtifact"])["artifactId"] ||
      request.tokenizerSha256 !==
        object(provider["tokenizerArtifact"])["artifactSha256"] ||
      request.inputSha256 !== pin["sha256"] ||
      request.inputBytes !== pin["byteLength"] ||
      (await hashArtifact(request.tools)) !==
        (await hashArtifact(expectedTools)) ||
      request.purpose !== "research" ||
      request.deadlineAt !== plan["expiresAt"]
    )
      return fail("denied");
    const expectedEvidence = array(plan["reviewPins"], 16).map((rawPin) => {
      const p = object(rawPin);
      return {
        artifactId: p["artifactId"],
        artifactSha256: p["artifactSha256"],
        reviewId: p["reviewId"],
        reviewVersion: p["reviewVersion"],
        rightsPolicyId: p["rightsPolicyId"],
        rightsVersion: p["rightsVersion"],
      };
    });
    if (
      (await hashArtifact(expectedEvidence)) !==
      (await hashArtifact(request.evidence))
    )
      return fail("denied");
    if (
      (native === null &&
        (request.maximumOutputTokens !==
          (tokenize ? 0 : provider["maximumOutputTokens"]) ||
          request.maximumCostUsd !==
            budgets[tokenize ? "tokenizeCostUsd" : "completionCostUsd"])) ||
      (tokenize ? request.inputTokens !== null : request.inputTokens === null)
    )
      return fail("denied");
    if (!tokenize) {
      const total =
        BigInt(present(request.inputTokens)) +
        BigInt(String(provider["maximumOutputTokens"]));
      if (
        present(request.inputTokens) < 1 ||
        present(request.inputTokens) > Number(provider["maximumInputTokens"]) ||
        total > BigInt(String(budgets["requestTokens"])) ||
        total > BigInt(String(budgets["attemptTokens"])) ||
        total > BigInt(String(object(selection["research"])["tokenBudget"])) ||
        total > BigInt(String(modelPolicy["maximum_context_tokens"]))
      )
        return fail("denied");
    }
    const totalCost =
      decimalUnits(string(budgets["tokenizeCostUsd"])) +
      decimalUnits(string(budgets["completionCostUsd"]));
    if (
      totalCost > decimalUnits(string(budgets["requestCostUsd"])) ||
      totalCost > decimalUnits(string(budgets["attemptCostUsd"])) ||
      totalCost > decimalUnits(string(provider["maximumCostUsd"]))
    )
      return fail("denied");
    const {
      requestSha256: ignoredHash,
      requestId: ignoredId,
      ...identity
    } = request;
    if (request.requestId !== `model-use-${await hashArtifact(identity)}`)
      return fail("denied");
    const head = await one(
      tx,
      "vertex_model_use_grant_current",
      scope,
      sql`grant_id = ${request.grantId}`
    );
    if (!head) return fail("denied");
    const row = await one(
      tx,
      "vertex_model_use_grant_versions",
      scope,
      sql`grant_id = ${request.grantId} and grant_version = ${head["grant_version"]}`
    );
    if (!row) return fail("denied");
    const grant = ModelUseGrantSchema.parse(row["payload"]);
    if (
      (await hashArtifact(grant)) !== row["record_hash"] ||
      grant.grantId !== request.grantId ||
      grant.grantVersion !== request.grantVersion ||
      grant.grantVersion !== head["grant_version"] ||
      grant.revision !== head["revision"] ||
      grant.revision !== row["revision"] ||
      grant.status !== "granted" ||
      row["status"] !== grant.status ||
      grant.issuedByActorId !== row["issued_by_actor_id"] ||
      time(grant.validFrom).toString() !== row["valid_from_ns"] ||
      time(grant.expiresAt).toString() !== row["expires_at_ns"] ||
      time(grant.issuedAt).toString() !== row["issued_at_ns"] ||
      grant.researchPrincipalId !== row["research_principal_id"] ||
      grant.consumerServiceId !== row["consumer_service_id"] ||
      grant.selectionId !== row["selection_id"] ||
      grant.selectionSha256 !== row["selection_sha256"] ||
      time(grant.validFrom) > time(at) ||
      time(grant.issuedAt) > time(at)
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
      "tokenizerArtifactId",
      "tokenizerSha256",
      "endpointReferenceId",
      "endpointSha256",
      "modelUsePolicyVersion",
    ] as const)
      if (grant[key] !== request[key]) return fail("denied");
    if (
      !(
        grant.operations.includes(request.operation) &&
        grant.purposes.includes(request.purpose)
      ) ||
      grant.maximumInputBytes < request.inputBytes ||
      (request.inputTokens !== null &&
        grant.maximumInputTokens < request.inputTokens) ||
      grant.maximumOutputTokens < request.maximumOutputTokens ||
      decimalUnits(grant.maximumCostUsd) <
        decimalUnits(request.maximumCostUsd) ||
      (await hashArtifact(grant.evidence)) !==
        (await hashArtifact(request.evidence))
    )
      return fail("denied");
    if (request.tools.some((tool) => !grant.allowedTools.includes(tool)))
      return fail("denied");
    if (native !== null && nativePhase !== undefined) {
      const ceilings = array(native["operationCeilings"], 4).map(object);
      if (
        ceilings.length !== 4 ||
        ceilings.some(
          (slot, index) =>
            slot["phaseOrdinal"] !== (index < 2 ? 1 : 2) ||
            slot["operation"] !==
              (index % 2 === 0 ? "model-tokenize" : "model-completion")
        )
      )
        return fail("integrity");
      const ceiling = present(
        ceilings[(nativePhase.phaseOrdinal - 1) * 2 + (tokenize ? 0 : 1)]
      );
      const chargeTokens =
        BigInt(grant.maximumInputTokens) +
        (tokenize ? 0n : BigInt(grant.maximumOutputTokens));
      const chargeCost = decimalUnits(grant.maximumCostUsd);
      if (
        grant.maximumInputTokens > Number(ceiling["maximumInputTokens"]) ||
        (!tokenize &&
          grant.maximumOutputTokens > Number(ceiling["maximumOutputTokens"])) ||
        request.maximumOutputTokens !==
          Number(ceiling["maximumOutputTokens"]) ||
        request.maximumCostUsd !== string(ceiling["maximumCostUsd"]) ||
        chargeCost > decimalUnits(string(ceiling["maximumCostUsd"]))
      )
        return fail("denied");
      // Include every durable reservation, even expired/unknown and grants from
      // another period. A fresh grant never resets this original job allowance.
      const reservations = await rows(
        tx,
        sql`select * from vertex_model_use_budget_reservations where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and job_id = ${request.jobId} and selection_id = ${request.selectionId} limit 5`
      );
      if (reservations.length > 4) return fail("denied");
      let tokens = 0n,
        cost = 0n,
        existing = false;
      for (const reservation of reservations) {
        if (
          reservation["selection_sha256"] !== request.selectionSha256 ||
          !/^[0-9]+$/.test(String(reservation["token_charge"])) ||
          !/^[0-9]+$/.test(String(reservation["cost_charge_units"]))
        )
          return fail("integrity");
        const body = object(reservation["payload"]);
        const priorRequest = await parseModelUseRequest(body["request"]),
          priorGrant = ModelUseGrantSchema.parse(body["grant"]);
        const priorTokens =
          BigInt(priorGrant.maximumInputTokens) +
          (priorRequest.operation === "model-completion"
            ? BigInt(priorGrant.maximumOutputTokens)
            : 0n);
        const priorCost = decimalUnits(priorGrant.maximumCostUsd);
        if (
          (await hashArtifact(body)) !== reservation["record_hash"] ||
          body["tokenCharge"] !== reservation["token_charge"] ||
          body["costChargeUnits"] !== reservation["cost_charge_units"] ||
          priorTokens !== BigInt(String(reservation["token_charge"])) ||
          priorCost !== BigInt(String(reservation["cost_charge_units"])) ||
          priorRequest.accountAlias !== request.accountAlias ||
          priorRequest.environment !== request.environment ||
          priorRequest.jobId !== request.jobId ||
          priorRequest.selectionId !== request.selectionId ||
          priorRequest.selectionSha256 !== request.selectionSha256 ||
          priorRequest.requestSha256 !== reservation["request_sha256"] ||
          priorGrant.grantId !== priorRequest.grantId ||
          priorGrant.grantVersion !== priorRequest.grantVersion
        )
          return fail("integrity");
        tokens += BigInt(String(reservation["token_charge"]));
        cost += BigInt(String(reservation["cost_charge_units"]));
        if (reservation["request_sha256"] === request.requestSha256) {
          if (
            existing ||
            BigInt(String(reservation["token_charge"])) !== chargeTokens ||
            BigInt(String(reservation["cost_charge_units"])) !== chargeCost
          )
            return fail("conflict");
          existing = true;
        }
      }
      if (!existing) {
        tokens += chargeTokens;
        cost += chargeCost;
      }
      if (
        (!existing && reservations.length === 4) ||
        tokens > BigInt(String(native["aggregateTokens"])) ||
        cost > decimalUnits(string(native["aggregateCostUsd"]))
      )
        return fail("denied");
      const association = {
        profile: "vertex-research-chat-native-phase-request-v1",
        ...scope,
        responseRequestId: plan["responseRequestId"],
        planSha256: plan["planSha256"],
        ...nativePhase,
        operation: request.operation,
        requestId: request.requestId,
        requestSha256: request.requestSha256,
        jobId: request.jobId,
        leaseId: request.leaseId,
        leaseEpoch: request.leaseEpoch,
        selectionId: request.selectionId,
        selectionSha256: request.selectionSha256,
      };
      const prior = await one(
        tx,
        "vertex_research_chat_native_phase_requests",
        scope,
        sql`response_request_id = ${plan["responseRequestId"]} and phase_ordinal = ${nativePhase.phaseOrdinal} and operation = ${request.operation}`
      );
      if (prior === null) {
        await insert(tx, "vertex_research_chat_native_phase_requests", scope, {
          response_request_id: plan["responseRequestId"],
          plan_sha256: plan["planSha256"],
          phase_ordinal: nativePhase.phaseOrdinal,
          phase_sha256: nativePhase.phaseSha256,
          operation: request.operation,
          request_id: request.requestId,
          request_sha256: request.requestSha256,
          job_id: request.jobId,
          lease_id: request.leaseId,
          lease_epoch: request.leaseEpoch,
          selection_id: request.selectionId,
          selection_sha256: request.selectionSha256,
          payload: association,
          record_hash: await hashArtifact(association),
        });
      } else {
        if (
          (await hashArtifact(prior["payload"])) !== prior["record_hash"] ||
          (await hashArtifact(association)) !== prior["record_hash"]
        )
          return fail("conflict");
        for (const [column, expected] of Object.entries({
          response_request_id: plan["responseRequestId"],
          plan_sha256: plan["planSha256"],
          phase_ordinal: nativePhase.phaseOrdinal,
          phase_sha256: nativePhase.phaseSha256,
          operation: request.operation,
          request_id: request.requestId,
          request_sha256: request.requestSha256,
          job_id: request.jobId,
          lease_id: request.leaseId,
          lease_epoch: request.leaseEpoch,
          selection_id: request.selectionId,
          selection_sha256: request.selectionSha256,
        }))
          if (prior[column] !== expected) return fail("integrity");
      }
    }
    await ctx.authorize(
      { actorId: request.researchPrincipalId },
      scope,
      null,
      grant.grantId,
      "read",
      ctx.now()
    );
    const ends = [
      joined.expiresAt,
      lease.leaseExpiresAt,
      lease.deadlineAt,
      service.expiresAt,
      grant.expiresAt,
      descriptor.expiresAt,
      descriptor.pricing.expiresAt,
      string(present(capabilities[0])["expiresAt"]),
      string(present(references[0])["expiresAt"]),
    ];
    if (phaseExpiry !== undefined) ends.push(phaseExpiry);
    const expiresAt = ends.reduce((a, b) => (time(a) <= time(b) ? a : b));
    const now = time(ctx.now());
    if (now < time(at) || now >= time(expiresAt)) return fail("stale");
    return {
      responseRequestId: string(plan["responseRequestId"]),
      planId: string(plan["planId"]),
      planSha256: string(plan["planSha256"]),
      ownerActorId: string(plan["ownerActorId"]),
      consumerServicePrincipalId: service.servicePrincipalId,
      originalRequestSha256: string(plan["requestSha256"]),
      expiresAt,
      modelGrant: grant,
      modelGrantRevision: grant.revision,
      ...(nativePhase === undefined ? {} : { nativePhase }),
    };
  };
  const readRendezvousOriginalForTransaction = async (
    tx: Transaction,
    raw: ModelUseRequest,
    at: string
  ) => {
    const source = await readModelOriginalForTransaction(tx, raw, at);
    const scope = {
      accountAlias: raw.accountAlias,
      environment: raw.environment,
    };
    const joined = await worker.originalForTransaction(
      tx,
      scope,
      { jobId: raw.jobId },
      ctx.now()
    );
    if (joined?.closed)
      throw new ChatWorkerOriginalClosedError("Original chat authority closed");
    if (
      !(
        joined &&
        [
          "vertex-research-chat-plan-v1",
          "vertex-research-chat-native-evidence-plan-v1",
        ].includes(string(joined.plan["format"]))
      ) ||
      joined.plan["participantId"] !== "first-mate"
    )
      return fail("denied");
    const selected = array(joined.selection["artifacts"], 512)
      .map(object)
      .filter((entry) => entry["role"] === "provider-config");
    if (selected.length !== 1) return fail("denied");
    const pin = PolicyArtifactPinSchema.parse(present(selected[0])["artifact"]);
    const bytes = await policy.readSelectedArtifact(
      tx,
      { actorId: raw.researchPrincipalId },
      scope,
      pin
    );
    if ((await hashArtifact(bytes)) !== pin.artifactSha256)
      return fail("integrity");
    const config = SelectedFirstMatePrivacyRendezvousAdapterSchema.parse(
      vertexRuntimeModelJson(bytes)
    );
    if (
      (source.nativePhase !== undefined) !==
      (config.profile === "vertex-first-mate-native-evidence-adapter-config-v1")
    )
      return fail("denied");
    if (
      config.profile === "vertex-first-mate-native-evidence-adapter-config-v1"
    ) {
      const native = object(joined.plan["nativeEvidence"]);
      if (
        config.native_evidence.protocol !== native["profile"] ||
        config.native_evidence.serializerProfile !==
          native["serializerProfile"] ||
        (await hashArtifact(config.native_evidence.nativeServing)) !==
          (await hashArtifact(
            PolicyArtifactPinSchema.parse(native["nativeCapability"])
          ))
      )
        return fail("denied");
    }
    if (time(ctx.now()) >= time(source.expiresAt)) return fail("stale");
    return { source, limits: config.privacy_review_rendezvous };
  };
  return Object.freeze({
    readModelOriginalForTransaction,
    readRendezvousOriginalForTransaction,
    worker,
  });
};
export type VertexResearchChatWorkerRuntime = ReturnType<
  typeof createVertexResearchChatWorkerRuntime
>;
