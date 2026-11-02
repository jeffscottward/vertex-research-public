import { sql } from "drizzle-orm";
import {
  createVertexAuthorization,
  createVertexModelUseStore,
  createVertexModelUseStoreForTransaction,
  type VertexModelUseStoreOptions,
} from "@darkfactory/db/server/vertex";
import type { Database, Transaction } from "@darkfactory/db/server";
import type { VertexWorkerOptions } from "@darkfactory/db/server/vertex-worker";
import type {
  ArtifactPin,
  PolicyPrincipal,
  PolicyScope,
  CurrentModelUseContext,
  ModelUseBoundary,
  ModelUseRecords,
} from "@darkfactory/config/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import {
  canonicalArtifactJson,
  decimalUnits,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  ModelUseGrantSchema,
  ModelUseProofSchema,
  parseModelUseRequest,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { parseRuntimePolicySelection } from "../contracts/vertex-policy.ts";
import {
  WorkerLeaseSchema,
  WorkerServiceGrantSchema,
} from "../contracts/vertex-worker.ts";
import { IdentifierSchema, DigestSchema } from "../contracts/vertex.ts";
import {
  createVertexRuntimeModelEvidence,
  vertexRuntimeModelBoundDatabase,
  vertexRuntimeModelJson,
  vertexRuntimeModelRow,
  VertexRuntimeModelDescriptorSchema,
  VertexRuntimeModelBudgetPolicySchema,
  VertexRuntimeModelPrivacyDecisionSchema,
} from "./vertex-runtime-model-evidence.ts";
import {
  ChatWorkerOriginalClosedError,
  type VertexResearchChatWorkerRuntime,
} from "./vertex-research-chat-worker-runtime.ts";
import type { createResearchChatModelPrivacyOperations } from "./vertex-research-chat-model-privacy.ts";
import { VertexResearchChatInputBudgetsSchema } from "../contracts/vertex-research-chat-execution.ts";
import { present } from "./present.ts";

// Explicit server configuration pins only. No credentials, inferred grants,
// permissive booleans, object URLs or runtime-authored allow decisions.
export type VertexRuntimeModelRequestEvidence = Readonly<{
  accountAlias: string;
  environment: "research" | "paper";
  jobId: string;
  requestSha256: string;
  inputArtifactId: string;
  inputCollectionId: string | null;
  privacyDecision: ArtifactPin;
  privacyIssuerActorId: string;
}>;
export type VertexRuntimeModelUseOptions = Readonly<{
  db: Database;
  clock: Readonly<{ now: () => string }>;
  objectCapabilities: (scope: PolicyScope) => VertexObjectCapabilities;
  policySelection: VertexWorkerOptions["policySelection"];
  readSelectedArtifact: (
    tx: Transaction,
    principal: PolicyPrincipal,
    scope: PolicyScope,
    pin: ArtifactPin
  ) => Promise<Uint8Array>;
  requestEvidence: readonly VertexRuntimeModelRequestEvidence[];
  privilegedAuthorization: VertexModelUseStoreOptions["privilegedAuthorization"];
  signal?: AbortSignal;
  chat?: Readonly<{
    owner: VertexResearchChatWorkerRuntime;
    privacy: ReturnType<typeof createResearchChatModelPrivacyOperations>;
  }>;
}>;
const requireFact = (condition: unknown): void => {
  if (!condition) throw new Error("Current model-use context unavailable");
};
const minimum = (...values: string[]): string =>
  values.reduce((left, right) =>
    timestampToEpochNanoseconds(left) <= timestampToEpochNanoseconds(right)
      ? left
      : right
  );
const scopeOf = (request: ModelUseRequest): PolicyScope => ({
  accountAlias: request.accountAlias,
  environment: request.environment,
});
export const vertexRuntimeModelUseBoundary: ModelUseBoundary = Object.freeze({
  validate: async <K extends keyof ModelUseRecords>(
    name: K,
    value: unknown
  ): Promise<ModelUseRecords[K]> => {
    const parsed =
      name === "ModelUseRequest"
        ? await parseModelUseRequest(value)
        : name === "ModelUseGrant"
          ? ModelUseGrantSchema.parse(value)
          : ModelUseProofSchema.parse(value);
    return parsed as ModelUseRecords[K];
  },
  encode: (value: unknown) =>
    new TextEncoder().encode(canonicalArtifactJson(value)),
  digest: hashArtifact,
  epochNanoseconds: timestampToEpochNanoseconds,
  decimalUnits,
});

export const createVertexRuntimeModelUse = (
  options: VertexRuntimeModelUseOptions
) => {
  // Capture explicit reference declarations only. No clocks, DB, object reads,
  // grant issuance, ledger writes or provider calls occur during construction.
  canonicalArtifactJson(options.requestEvidence);
  const bindings = structuredClone(options.requestEvidence);
  const source = createVertexRuntimeModelEvidence(options);
  const currentUseContext = async (
    tx: Transaction,
    principal: PolicyPrincipal,
    raw: unknown,
    at: string,
    governedInput?: Uint8Array
  ): Promise<CurrentModelUseContext | null> => {
    try {
      const request = await parseModelUseRequest(raw);
      const scope = scopeOf(request);
      IdentifierSchema.parse(principal.actorId);
      requireFact(
        principal.actorId === request.researchPrincipalId &&
          !options.signal?.aborted
      );
      const chatOrigin = options.chat
        ? await options.chat.owner.worker.originalForTransaction(
            tx,
            scope,
            { jobId: request.jobId },
            at
          )
        : null;
      if (chatOrigin?.closed) return null;
      const chat = chatOrigin
        ? await present(options.chat).owner.readModelOriginalForTransaction(
            tx,
            request,
            at
          )
        : null;
      const matches = chat
        ? []
        : bindings.filter(
            (entry) =>
              entry.accountAlias === scope.accountAlias &&
              entry.environment === scope.environment &&
              entry.jobId === request.jobId &&
              entry.requestSha256 === request.requestSha256
          );
      requireFact(chat || matches.length === 1);
      const binding = chat ? null : present(matches[0]);
      if (binding) {
        IdentifierSchema.parse(binding.inputArtifactId);
        IdentifierSchema.parse(binding.privacyIssuerActorId);
        DigestSchema.parse(binding.privacyDecision.artifactSha256);
      }
      const job = await vertexRuntimeModelRow(
        tx,
        "vertex_worker_jobs",
        scope,
        sql`job_id = ${request.jobId}`
      );
      // Models run only after durable admitRun; an unadmitted leased job is not
      // an implicit permission to tokenize or dispatch to an external provider.
      requireFact(
        job &&
          job["state"] === "running" &&
          job["lease_id"] === request.leaseId &&
          job["lease_epoch"] === request.leaseEpoch
      );
      const admission = await vertexRuntimeModelRow(
        tx,
        "vertex_worker_run_admissions",
        scope,
        sql`job_id = ${request.jobId}`
      );
      requireFact(
        admission &&
          admission["lease_epoch"] === request.leaseEpoch &&
          typeof admission["admitted_at"] === "string" &&
          timestampToEpochNanoseconds(admission["admitted_at"]) <=
            timestampToEpochNanoseconds(at)
      );
      const lease = WorkerLeaseSchema.parse(present(job)["payload"]);
      requireFact(chat || !lease.payloadArtifactId.startsWith("chat-recipe-"));
      requireFact(
        lease.jobId === request.jobId &&
          lease.accountAlias === scope.accountAlias &&
          lease.environment === scope.environment &&
          lease.leaseId === request.leaseId &&
          lease.leaseEpoch === request.leaseEpoch &&
          lease.researchPrincipalId === principal.actorId &&
          lease.policySelectionId === request.selectionId &&
          lease.policySelectionSha256 === request.selectionSha256 &&
          lease.kind === "research-run"
      );
      requireFact(
        present(job)["event_id"] === lease.eventId &&
          present(job)["lease_expires_at_ns"] ===
            timestampToEpochNanoseconds(lease.leaseExpiresAt).toString() &&
          present(job)["deadline_at_ns"] ===
            timestampToEpochNanoseconds(lease.deadlineAt).toString() &&
          present(job)["attempt"] === lease.attempt
      );
      const currentAt = source.current(at);
      const atNs = timestampToEpochNanoseconds(currentAt);
      requireFact(
        timestampToEpochNanoseconds(lease.leaseExpiresAt) > atNs &&
          timestampToEpochNanoseconds(lease.deadlineAt) > atNs &&
          timestampToEpochNanoseconds(request.deadlineAt) <=
            timestampToEpochNanoseconds(lease.deadlineAt)
      );
      const serviceRow = await vertexRuntimeModelRow(
        tx,
        "vertex_worker_service_grants",
        scope,
        sql`grant_id = ${present(job)["grant_id"]}`
      );
      requireFact(serviceRow);
      const service = WorkerServiceGrantSchema.parse(
        present(serviceRow)["payload"]
      );
      requireFact(
        (await hashArtifact(service)) === present(serviceRow)["record_hash"] &&
          service.grantId === present(job)["grant_id"] &&
          service.servicePrincipalId === request.consumerServiceId &&
          present(serviceRow)["service_principal_id"] ===
            service.servicePrincipalId &&
          service.accountAlias === scope.accountAlias &&
          service.environment === scope.environment &&
          service.revokedAt === null &&
          present(serviceRow)["revoked_at"] === null &&
          service.operations.includes("currentModelUse") &&
          timestampToEpochNanoseconds(service.issuedAt) <= atNs &&
          timestampToEpochNanoseconds(service.expiresAt) > atNs
      );
      requireFact(
        present(serviceRow)["issued_at_ns"] ===
          timestampToEpochNanoseconds(service.issuedAt).toString() &&
          present(serviceRow)["expires_at_ns"] ===
            timestampToEpochNanoseconds(service.expiresAt).toString()
      );
      const selection = await parseRuntimePolicySelection(
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: request.selectionId,
            selectionSha256: request.selectionSha256,
          },
          request.consumerServiceId,
          request.jobId
        )
      );
      requireFact(
        selection.selectionId === request.selectionId &&
          selection.selectionSha256 === request.selectionSha256 &&
          selection.accountAlias === scope.accountAlias &&
          selection.environment === scope.environment &&
          selection.research &&
          selection.research.modelVersion === request.modelVersion &&
          timestampToEpochNanoseconds(selection.issuedAt) <= atNs &&
          timestampToEpochNanoseconds(selection.expiresAt) > atNs
      );
      const research = present(selection.research);
      // The concrete native chat owner above has rejoined the immutable phase,
      // selected one-tool serving manifest and exact wire-tool grant. Only that
      // phase-one completion maps its wire name to the existing read-evidence
      // research permission; legacy requests retain exact allowlist matching.
      const nativeEvidenceRead =
        chat?.nativePhase?.phaseOrdinal === 1 &&
        request.operation === "model-completion" &&
        request.tools.length === 1 &&
        request.tools[0] === "read_reviewed_evidence" &&
        research.allowedTools.includes("read-evidence");
      requireFact(
        (nativeEvidenceRead ||
          request.tools.every((tool) =>
            research.allowedTools.some((allowed) => allowed === tool)
          )) &&
          (request.inputTokens === null ||
            request.inputTokens <= research.tokenBudget) &&
          request.maximumOutputTokens <= research.tokenBudget &&
          decimalUnits(request.maximumCostUsd) <=
            decimalUnits(research.costBudgetUsd)
      );
      const capability = chat
        ? selection.providerCapabilities.find(
            (entry) =>
              entry.operation === request.operation &&
              entry.endpointReferenceId === request.endpointReferenceId &&
              entry.endpointSha256 === request.endpointSha256 &&
              entry.providerId === request.providerId &&
              entry.modelVersion === request.modelVersion
          )
        : selection.providerCapabilities.find(
            (entry) => entry.capabilityId === research.modelCapabilityId
          );
      requireFact(
        capability &&
          capability.state === "ready" &&
          capability.providerId === request.providerId &&
          capability.modelVersion === request.modelVersion &&
          capability.endpointReferenceId === request.endpointReferenceId &&
          capability.endpointSha256 === request.endpointSha256 &&
          timestampToEpochNanoseconds(capability.observedAt) <= atNs &&
          timestampToEpochNanoseconds(capability.expiresAt) > atNs
      );
      const endpoint = selection.references.find(
        (entry) => entry.referenceId === request.endpointReferenceId
      );
      requireFact(
        endpoint &&
          endpoint.referenceSha256 === request.endpointSha256 &&
          endpoint.exposure === "server-only" &&
          endpoint.ownerService === request.consumerServiceId &&
          endpoint.verificationState === "verified" &&
          endpoint.lastVerifiedAt !== null &&
          timestampToEpochNanoseconds(endpoint.lastVerifiedAt) <= atNs &&
          timestampToEpochNanoseconds(endpoint.expiresAt) > atNs
      );
      const deadlines = [
        selection.expiresAt,
        service.expiresAt,
        present(capability).expiresAt,
        present(endpoint).expiresAt,
      ];
      const readSelected = async (pin: ArtifactPin): Promise<Uint8Array> => {
        const bytes = await options.readSelectedArtifact(
          tx,
          principal,
          scope,
          pin
        );
        requireFact(
          bytes instanceof Uint8Array &&
            bytes.byteLength <= 1_048_576 &&
            (await hashArtifact(bytes)) === pin.artifactSha256
        );
        const grant = await source.readGrant(
          tx,
          principal,
          scope,
          null,
          pin.artifactId,
          source.current(at)
        );
        const row = await vertexRuntimeModelRow(
          tx,
          "vertex_artifacts",
          scope,
          sql`artifact_id = ${pin.artifactId} and collection_key = ''`
        );
        const stage = row
          ? null
          : await vertexRuntimeModelRow(
              tx,
              "vertex_worker_stages",
              scope,
              sql`artifact_id = ${pin.artifactId} and collection_key = ''`
            );
        requireFact(row || stage);
        const payload = (row?.["payload"] ??
          present(stage)["payload"]) as Record<string, unknown>;
        const rightsPin = row
          ? (payload["rights"] as { policyId: unknown; version: unknown })
          : {
              policyId: payload["rightsPolicyId"],
              version: payload["rightsVersion"],
            };
        const rights = await source.rights(
          tx,
          principal,
          scope,
          null,
          IdentifierSchema.parse(rightsPin.policyId),
          IdentifierSchema.parse(rightsPin.version),
          source.current(at)
        );
        deadlines.push(grant.expiresAt, rights.expiresAt);
        return new Uint8Array(bytes);
      };
      const modelPins = selection.artifacts.filter(
        (entry) => entry.role === "model"
      );
      requireFact(modelPins.length === 1);
      const model = VertexRuntimeModelDescriptorSchema.parse(
        vertexRuntimeModelJson(
          await readSelected(present(modelPins[0]).artifact)
        )
      );
      for (const field of [
        "accountAlias",
        "environment",
        "providerId",
        "modelVersion",
        "tokenizerArtifactId",
        "tokenizerSha256",
        "modelUsePolicyVersion",
      ] as const)
        requireFact(model[field] === request[field]);
      if (!chat)
        requireFact(
          model.endpointReferenceId === request.endpointReferenceId &&
            model.endpointSha256 === request.endpointSha256
        );
      deadlines.push(model.expiresAt, model.pricing.expiresAt);
      const price = model.pricing;
      const requiredCost =
        request.operation === "model-tokenize"
          ? decimalUnits(price.tokenizationBaseUsd) +
            BigInt(request.inputBytes) *
              decimalUnits(price.tokenizationInputByteUsd)
          : decimalUnits(price.completionBaseUsd) +
            BigInt(request.inputBytes) *
              decimalUnits(price.completionInputByteUsd) +
            BigInt(request.maximumOutputTokens) *
              decimalUnits(price.outputTokenUsd);
      // Price the real byte upper bound, not a caller's potentially smaller
      // token claim. Zero-cost is possible only when explicitly pinned as zero.
      requireFact(decimalUnits(request.maximumCostUsd) >= requiredCost);
      const tokenizerPins = selection.artifacts.filter(
        (entry) =>
          entry.role === "tokenizer" &&
          entry.artifact.artifactId === request.tokenizerArtifactId &&
          entry.artifact.artifactSha256 === request.tokenizerSha256
      );
      requireFact(tokenizerPins.length === 1);
      await readSelected(present(tokenizerPins[0]).artifact);
      await readSelected(present(capability).evidenceArtifact);
      const budgetPins = selection.policies.filter(
        (entry) => entry.role === "provider-budget"
      );
      requireFact(budgetPins.length === 1);
      const budgetPin = present(budgetPins[0]);
      const budgetPolicy = VertexRuntimeModelBudgetPolicySchema.parse(
        vertexRuntimeModelJson(await readSelected(budgetPin.artifact))
      );
      requireFact(
        budgetPolicy.accountAlias === scope.accountAlias &&
          budgetPolicy.environment === scope.environment &&
          budgetPolicy.policyId === budgetPin.policyId &&
          budgetPolicy.policyVersion === budgetPin.version &&
          timestampToEpochNanoseconds(budgetPolicy.startsAt) <= atNs &&
          timestampToEpochNanoseconds(budgetPolicy.expiresAt) > atNs
      );
      const originalPrivacy = chat
        ? await present(options.chat).privacy.readForTransaction(
            tx,
            request,
            source.current(at)
          )
        : null;
      const privacy = originalPrivacy
        ? originalPrivacy.decision
        : VertexRuntimeModelPrivacyDecisionSchema.parse(
            vertexRuntimeModelJson(
              await readSelected(present(binding).privacyDecision)
            )
          );
      requireFact(
        (chat ||
          privacy.issuedByActorId === present(binding).privacyIssuerActorId) &&
          (await hashArtifact(privacy.request)) ===
            (await hashArtifact(request)) &&
          timestampToEpochNanoseconds(privacy.decidedAt) <= atNs &&
          timestampToEpochNanoseconds(privacy.expiresAt) > atNs
      );
      if (chat) {
        requireFact(
          governedInput instanceof Uint8Array &&
            governedInput.byteLength === request.inputBytes &&
            (await hashArtifact(governedInput)) === request.inputSha256
        );
        deadlines.push(chat.expiresAt, present(originalPrivacy).expiresAt);
      } else {
        const input = await vertexRuntimeModelRow(
          tx,
          "vertex_worker_stages",
          scope,
          sql`artifact_id = ${present(binding).inputArtifactId} and collection_key = ${present(binding).inputCollectionId ?? ""}`
        );
        requireFact(
          input &&
            input["job_id"] === request.jobId &&
            input["content_sha256"] === request.inputSha256 &&
            input["byte_length"] === request.inputBytes
        );
        const inputDescriptor = present(input)["payload"] as Record<
          string,
          unknown
        >;
        requireFact(
          (await hashArtifact(inputDescriptor)) ===
            present(input)["request_hash"] &&
            inputDescriptor["artifactId"] ===
              present(binding).inputArtifactId &&
            inputDescriptor["contentSha256"] === request.inputSha256
        );
        const inputGrant = await source.readGrant(
          tx,
          principal,
          scope,
          present(binding).inputCollectionId,
          present(binding).inputArtifactId,
          source.current(at)
        );
        const inputRights = await source.rights(
          tx,
          principal,
          scope,
          present(binding).inputCollectionId,
          IdentifierSchema.parse(inputDescriptor["rightsPolicyId"]),
          IdentifierSchema.parse(inputDescriptor["rightsVersion"]),
          source.current(at)
        );
        const inputKey = vertexQualifiedObjectKey(
          scope,
          present(binding).inputCollectionId,
          present(input)["canonical_sha256"] === request.inputSha256
            ? "manifest"
            : "content",
          request.inputSha256
        );
        requireFact(present(input)["object_key"] === inputKey);
        await source.objectBytes(
          scope,
          inputKey,
          request.inputSha256,
          request.inputBytes
        );
        deadlines.push(inputGrant.expiresAt, inputRights.expiresAt);
      }
      const evidence: CurrentModelUseContext["evidence"][number][] = [];
      for (const reference of request.evidence)
        evidence.push(
          await source.accepted(
            tx,
            principal,
            request,
            reference,
            source.current(at)
          )
        );
      const completedAt = timestampToEpochNanoseconds(source.current(at));
      requireFact(
        deadlines.every(
          (value) => timestampToEpochNanoseconds(value) > completedAt
        ) &&
          timestampToEpochNanoseconds(lease.leaseExpiresAt) > completedAt &&
          timestampToEpochNanoseconds(privacy.expiresAt) > completedAt &&
          timestampToEpochNanoseconds(budgetPolicy.expiresAt) > completedAt
      );
      const chatBudgets = chatOrigin
        ? VertexResearchChatInputBudgetsSchema.parse(
            chatOrigin.configuration["budgets"]
          )
        : null;
      const jobMaximumTokens = chatBudgets
        ? Math.min(
            research.tokenBudget,
            chatBudgets.requestTokens,
            chatBudgets.attemptTokens
          )
        : research.tokenBudget;
      const jobMaximumCostUsd = (
        chatBudgets
          ? [
              research.costBudgetUsd,
              chatBudgets.requestCostUsd,
              chatBudgets.attemptCostUsd,
            ]
          : [research.costBudgetUsd]
      ).reduce((a, b) => (decimalUnits(a) <= decimalUnits(b) ? a : b));
      return {
        authenticatedActorId: principal.actorId,
        lease: {
          jobId: lease.jobId,
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          researchPrincipalId: lease.researchPrincipalId,
          consumerServiceId: service.servicePrincipalId,
          ...scope,
          selectionId: lease.policySelectionId,
          selectionSha256: lease.policySelectionSha256,
          state: "leased",
          expiresAt: lease.leaseExpiresAt,
          deadlineAt: lease.deadlineAt,
        },
        selection: {
          ...scope,
          researchPrincipalId: principal.actorId,
          consumerServiceId: service.servicePrincipalId,
          selectionId: selection.selectionId,
          selectionSha256: selection.selectionSha256,
          providerId: model.providerId,
          modelVersion: model.modelVersion,
          tokenizerArtifactId: model.tokenizerArtifactId,
          tokenizerSha256: model.tokenizerSha256,
          endpointReferenceId: chat
            ? request.endpointReferenceId
            : model.endpointReferenceId,
          endpointSha256: chat ? request.endpointSha256 : model.endpointSha256,
          modelUsePolicyVersion: model.modelUsePolicyVersion,
          expiresAt: minimum(...deadlines),
        },
        evidence,
        budgetAdmission: {
          policyId: budgetPolicy.policyId,
          policyVersion: budgetPolicy.policyVersion,
          policyArtifactId: budgetPin.artifact.artifactId,
          policyArtifactSha256: budgetPin.artifact.artifactSha256,
          periodId: budgetPolicy.periodId,
          startsAt: budgetPolicy.startsAt,
          expiresAt: budgetPolicy.expiresAt,
          maximumTokens: budgetPolicy.maximumTokens,
          maximumCostUsd: budgetPolicy.maximumCostUsd,
          jobMaximumTokens,
          jobMaximumCostUsd,
          chargeProfile: budgetPolicy.chargeProfile,
          unknownOutcome: budgetPolicy.unknownOutcome,
        },
        privacy: {
          policyId: privacy.policyId,
          policyVersion: privacy.policyVersion,
          requestSha256: privacy.request.requestSha256,
          allowedOperation: privacy.request.operation,
          expiresAt: privacy.expiresAt,
        },
      };
    } catch {
      return null;
    }
  };
  const modelUse: VertexWorkerOptions["modelUse"] = async (
    tx,
    principal,
    request,
    at,
    governedInput
  ) => {
    // Borrow the worker transaction and its lock ordering; never acquire a pool
    // or run an independent transaction for a current model-use observation.
    const parsed = await parseModelUseRequest(request);
    source.current(at);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", parsed.accountAlias, parsed.environment])}, 0))`
    );
    const authorization = createVertexAuthorization(
      vertexRuntimeModelBoundDatabase(tx),
      { clock: options.clock }
    );
    const store = createVertexModelUseStoreForTransaction(tx, {
      boundary: vertexRuntimeModelUseBoundary,
      clock: options.clock,
      authorization,
      privilegedAuthorization: options.privilegedAuthorization,
      currentUseContext: (currentTx, actor, input) =>
        currentUseContext(currentTx, actor, input, at, governedInput),
    });
    const proof = await store.currentModelUse(principal, parsed);
    const origin = options.chat
      ? await options.chat.owner.worker.originalForTransaction(
          tx,
          scopeOf(parsed),
          { jobId: parsed.jobId },
          source.current(at)
        )
      : null;
    if (origin?.closed)
      return ModelUseProofSchema.parse({
        ...proof,
        decision: "denied",
        reasonCodes: ["current-context-unavailable"],
        externalDispatchAllowed: false,
      });
    if (origin && proof.decision === "allowed") {
      try {
        const dispatch = await present(
          options.chat
        ).privacy.reserveDispatchForTransaction(tx, parsed, source.current(at));
        return ModelUseProofSchema.parse({
          ...proof,
          externalDispatchAllowed:
            proof.externalDispatchAllowed && dispatch.fresh,
        });
      } catch (error) {
        if (error instanceof ChatWorkerOriginalClosedError)
          return ModelUseProofSchema.parse({
            ...proof,
            decision: "denied",
            reasonCodes: ["current-context-unavailable"],
            externalDispatchAllowed: false,
          });
        throw error;
      }
    }
    return proof;
  };
  const admin = () =>
    createVertexModelUseStore(options.db, {
      boundary: vertexRuntimeModelUseBoundary,
      clock: options.clock,
      authorization: createVertexAuthorization(options.db, {
        clock: options.clock,
      }),
      privilegedAuthorization: options.privilegedAuthorization,
      currentUseContext: async () => null,
    });
  return Object.freeze({
    modelUse,
    currentUseContext,
    grantAdministration: Object.freeze({
      issueGrant: async (
        input: Parameters<
          ReturnType<typeof createVertexModelUseStore>["issueGrant"]
        >[0]
      ) => {
        requireFact(!options.signal?.aborted);
        return await admin().issueGrant(input);
      },
      revokeGrant: async (
        input: Parameters<
          ReturnType<typeof createVertexModelUseStore>["revokeGrant"]
        >[0]
      ) => {
        requireFact(!options.signal?.aborted);
        return await admin().revokeGrant(input);
      },
    }),
  });
};
