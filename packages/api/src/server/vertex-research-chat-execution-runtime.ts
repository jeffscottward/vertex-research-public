import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  type VertexClock,
  type VertexPrincipal,
  type VertexScope,
  type VertexRecord,
  type VertexRightsRecord,
  type VertexAction,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import {
  createPersistenceContext,
  fail,
  object,
  string,
  identifier,
  rows,
} from "@darkfactory/db/server/vertex-research-chat-runtime";
import { createResearchChatExecutionOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import type { VertexResearchChatExecutionOptions } from "@darkfactory/db/server/vertex-research-chat-runtime";
import { createResearchChatCopyLifecycle } from "@darkfactory/db/server/vertex-research-chat-runtime";
import { createResearchChatDebateOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import {
  VertexResearchChatDebateConfigurationV1Schema,
  VertexResearchChatDebatePlanV1Schema,
  VertexResearchChatDebateStepV1Schema,
  VertexResearchChatDerivedUseReviewInputSchema,
} from "../contracts/vertex-research-chat-debate.ts";
import { VertexResearchChatPlanV2Schema } from "../contracts/vertex-research-chat-execution.ts";
import type { ResearchChatDerivedContext } from "./vertex-research-chat-derived.ts";
import { ResearchEvidenceSchema } from "../contracts/vertex.ts";
import { AcceptedReviewSchema } from "../contracts/vertex-control.ts";
import {
  PolicyArtifactPinSchema,
  parseRuntimePolicySelection,
} from "../contracts/vertex-policy.ts";
import {
  VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS,
  VertexResearchChatParticipantConfigurationV1Schema,
} from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatRequestResponseInputSchema } from "../contracts/vertex-research-chat-response.ts";
import { VertexResearchChatNativeEvidenceRequestSchema } from "../contracts/vertex-research-chat-native-evidence.ts";
import { VertexResearchChatNativeEvidenceConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import { prepareResearchChatNativeEvidenceInputs } from "./vertex-research-chat-inputs.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import { vertexPersistenceBoundary } from "./vertex-experience-adapter.ts";
import {
  createVertexRuntimePolicy,
  type VertexRuntimePolicyOptions,
} from "./vertex-runtime-policy.ts";
import {
  createVertexRuntimePolicyArtifacts,
  vertexPolicyTransactionDatabase,
} from "./vertex-runtime-policy-artifacts.ts";
import {
  createVertexRuntimeModelEvidence,
  VertexRuntimeModelDescriptorSchema,
} from "./vertex-runtime-model-evidence.ts";
import {
  prepareResearchChatInputs,
  prepareResearchChatInputsV2,
  canonicalResearchChatInputJson,
  type ResearchChatProducerInput,
  type ResearchChatModelPolicy,
  type ResearchChatEndpointPolicy,
  type ResearchChatEvidenceProjection,
} from "./vertex-research-chat-inputs.ts";
import { createResearchChatWorkerOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import { ResearchChatRecipeSchema } from "./vertex-runtime-recipe-profiles.ts";
import { createVertexResearchChatWorkerRuntime } from "./vertex-research-chat-worker-runtime.ts";
import { createResearchChatModelPrivacyOperations } from "./vertex-research-chat-model-privacy.ts";
import { createVertexResearchChatOutputRuntime } from "./vertex-research-chat-output-runtime.ts";
import { createVertexResearchChatConversationRuntime } from "./vertex-research-chat-conversation-runtime.ts";
import { present } from "./present.ts";

// Private programmatic composition only. Construction does not grant, write,
// dispatch, qualify a backend or expose an RPC. There is no builder/selection/
// evidence callback returning authority; only external DB/object/clock ports.
export type VertexResearchChatExecutionRuntimeOptions = Readonly<{
  db: Database;
  clock: VertexClock;
  objectCapabilities: (scope: VertexScope) => VertexObjectCapabilities;
  policy: Omit<
    VertexRuntimePolicyOptions,
    "db" | "clock" | "objectCapabilities" | "signal" | "privilegedAuthorization"
  >;
  experts: VertexResearchChatExecutionOptions["experts"];
  firstMate?: VertexResearchChatExecutionOptions["firstMate"];
  nativeEvidence?: VertexResearchChatExecutionOptions["nativeEvidence"];
  storage: VertexResearchChatExecutionOptions["storage"];
  maxProjectionAgeMs: number;
  signal?: AbortSignal;
  privacyReviewerActorId?: string;
  debate?: Readonly<{
    configuration: ReturnType<typeof PolicyArtifactPinSchema.parse>;
    reviewerActorId: string;
  }>;
}>;
const ns = timestampToEpochNanoseconds;
const minimum = (values: readonly string[]): string => {
  if (values.length === 0) return fail("invalid");
  return values.reduce((left, right) => (ns(left) <= ns(right) ? left : right));
};
const researchScope = (
  scope: VertexScope
): Readonly<{ accountAlias: string; environment: "research" }> => {
  if (scope.environment !== "research") return fail("denied");
  return {
    accountAlias: identifier(scope.accountAlias),
    environment: "research",
  };
};
// EXACT existing vertex_control.adapters._revision representation. This integer
// is not an independent revision counter or authority. Keep the original SemVer
// pin; call only on an actual current accepted-review join. No float coercion.
export const researchChatAcceptedReviewRevision = (version: string): bigint => {
  const parts = version.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0 || /[^0-9]/.test(part))
  )
    return fail("invalid");
  const revision = BigInt(
    "1" +
      parts.map((part) => String(part.length).padStart(2, "0") + part).join("")
  );
  if (revision > 9_007_199_254_740_991n) return fail("invalid");
  return revision;
};
export const createVertexResearchChatExecutionRuntime = (
  options: VertexResearchChatExecutionRuntimeOptions
) => {
  const clock = options.clock;
  const configuration = JSON.parse(
    canonicalArtifactJson(options.policy)
  ) as VertexResearchChatExecutionRuntimeOptions["policy"];
  const policyOptions = {
    ...configuration,
    db: options.db,
    clock,
    objectCapabilities: options.objectCapabilities,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const policy = createVertexRuntimePolicy(policyOptions);
  const authorization = createVertexAuthorization(options.db, { clock });
  const ctx = createPersistenceContext(options.db, {
    boundary: vertexPersistenceBoundary,
    authorization,
    clock,
    commandPolicy: policy.commandPolicy,
    maxProjectionAgeMs: options.maxProjectionAgeMs,
  });
  const experts = ctx.capture(options.experts);
  const firstMate =
    options.firstMate === undefined
      ? undefined
      : ctx.capture(options.firstMate);
  const nativeEvidence =
    options.nativeEvidence === undefined
      ? undefined
      : ctx.capture(options.nativeEvidence);
  const { capabilities, ...storageIdentity } = options.storage;
  const storage = { ...ctx.capture(storageIdentity), capabilities };
  const artifacts = createVertexRuntimePolicyArtifacts(policyOptions);
  const source = createVertexRuntimeModelEvidence(policyOptions);
  const current = (startedAt: string): string => {
    const at = clock.now();
    if (options.signal?.aborted || ns(at) < ns(startedAt)) return fail("stale");
    return at;
  };
  const selected = async (
    tx: Transaction,
    principal: VertexPrincipal,
    rawScope: VertexScope
  ) => {
    const scope = researchScope(rawScope);
    const local = createVertexRuntimePolicy({
      ...policyOptions,
      db: vertexPolicyTransactionDatabase(tx),
    });
    const head = await local.registry.readHead(principal, scope);
    if (
      head.state !== "active-read-only" ||
      !head.selectionId ||
      !head.selectionSha256
    )
      return fail("unavailable");
    return local.materializeForTransaction(
      tx,
      principal,
      {
        ...scope,
        selectionId: head.selectionId,
        selectionSha256: head.selectionSha256,
      },
      policyOptions.consumerServiceId
    );
  };
  const readCollectionArtifact: VertexResearchChatExecutionOptions["readCollectionArtifact"] =
    async (tx, principal, rawScope, collectionId, rawPin) => {
      const scope = researchScope(rawScope);
      const pin = PolicyArtifactPinSchema.parse(rawPin);
      if (
        pin.contractName !== "ResearchEvidence" ||
        scope.environment !== "research"
      )
        return fail("denied");
      const at = clock.now();
      const metadata = await ctx.artifact(
        tx,
        principal,
        scope,
        collectionId,
        pin.artifactId,
        "read",
        at
      );
      if (
        metadata?.contractName !== "ResearchEvidence" ||
        metadata.artifactSha256 !== pin.artifactSha256 ||
        metadata.objectKey !==
          vertexQualifiedObjectKey(
            scope,
            collectionId,
            "manifest",
            pin.artifactSha256
          )
      )
        return fail("integrity");
      const bytes = await source.objectBytes(
        scope,
        metadata.objectKey,
        pin.artifactSha256,
        metadata.byteLength
      );
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const evidence = ResearchEvidenceSchema.parse(JSON.parse(text));
        if (
          canonicalArtifactJson(evidence) !== text ||
          evidence.collectionId !== collectionId ||
          evidence.contentHash !== metadata.sourceContentSha256 ||
          evidence.rightsPolicyId !== metadata.rights.policyId
        )
          return fail("integrity");
        const after = await ctx.artifact(
          tx,
          principal,
          scope,
          collectionId,
          pin.artifactId,
          "read",
          current(at)
        );
        if (
          !after ||
          canonicalArtifactJson(after) !== canonicalArtifactJson(metadata)
        )
          return fail("stale");
        return bytes;
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
    };
  // Retain a genuine exact grant's deadline AFTER the real authorization owner
  // verifies its full binding/version. This is metadata, not boolean authority.
  const grantEnd = async (
    tx: Transaction,
    principal: VertexPrincipal,
    rawScope: VertexScope,
    collectionId: string | null,
    resourceId: string,
    action: VertexAction,
    at: string
  ): Promise<string> => {
    const scope = researchScope(rawScope);
    if (action === "read")
      return (
        await source.readGrant(
          tx,
          principal,
          scope,
          collectionId,
          resourceId,
          at
        )
      ).expiresAt;
    await ctx.authorize(principal, scope, collectionId, resourceId, action, at);
    const found = await rows(
      tx,
      sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = ${collectionId ?? ""} and b.resource_id = ${resourceId} and a.action = ${action} and v.status = 'granted' order by v.expires_at_ns desc limit 129`
    );
    if (found.length > 128) return fail("denied");
    for (const row of found) {
      const value = object(row["payload"]),
        boundScope = object(value["scope"]);
      if ((await ctx.hash(value)) !== row["record_hash"])
        return fail("integrity");
      if (
        value["granteeActorId"] === principal.actorId &&
        boundScope["accountAlias"] === scope.accountAlias &&
        boundScope["environment"] === scope.environment &&
        value["collectionId"] === collectionId &&
        value["resourceId"] === resourceId &&
        value["status"] === "granted" &&
        Array.isArray(value["actions"]) &&
        value["actions"].includes(action) &&
        value["version"] === row["current_version"] &&
        value["revision"] === row["revision"] &&
        ns(string(value["recordedAt"])) <= ns(at) &&
        ns(string(value["validFrom"])) <= ns(at) &&
        ns(string(value["expiresAt"])) > ns(current(at))
      )
        return string(value["expiresAt"]);
    }
    return fail("denied");
  };
  const prepareInputs: VertexResearchChatExecutionOptions["prepareInputs"] =
    async (tx, principal, rawScope, raw) => {
      const scope = researchScope(rawScope);
      // Detached originals before any await. No request-supplied policy, budget,
      // excerpt, message or grant survives the strict public request boundary.
      const { debatePrepared, ...base } = raw;
      const input = ctx.capture(base),
        startedAt = clock.now();
      const { debate: omittedStep, ...humanRequest } = input.request;
      const native =
        humanRequest["protocol"] === "first-mate-read-reviewed-evidence-v1";
      const request = native
        ? VertexResearchChatNativeEvidenceRequestSchema.parse(humanRequest)
        : VertexResearchChatRequestResponseInputSchema.parse(humanRequest);
      if ((omittedStep === undefined) !== (debatePrepared === undefined))
        return fail("integrity");
      const parsedConfiguration = native
        ? VertexResearchChatNativeEvidenceConfigurationV1Schema.parse(
            input.configuration
          )
        : VertexResearchChatParticipantConfigurationV1Schema.parse(
            input.configuration
          );
      if (
        parsedConfiguration.participantId === "first-mate" &&
        (omittedStep !== undefined || debatePrepared !== undefined)
      )
        return fail("denied");
      const participantConfiguration = PolicyArtifactPinSchema.parse(
        input.participantConfiguration
      );
      const selection = await parseRuntimePolicySelection(input.selection);
      const bounds = [parsedConfiguration.expiresAt, selection.expiresAt];
      if (debatePrepared) bounds.push(debatePrepared.expiresAt);
      const retain = async (
        actor: VertexPrincipal,
        collectionId: string | null,
        resourceId: string,
        action: VertexAction = "read"
      ) => {
        bounds.push(
          await grantEnd(
            tx,
            actor,
            scope,
            collectionId,
            resourceId,
            action,
            current(startedAt)
          )
        );
      };
      for (const id of [
        "account-scope",
        "runtime-policy",
        selection.selectionId,
        `policy-consumer:${policyOptions.consumerServiceId}`,
        "research-chat",
      ])
        await retain(principal, null, id);
      await retain(principal, null, "research-chat", "publish");
      const authorityPins = [
        ...selection.sourcePins.map((p) => p.provenanceArtifact),
        ...selection.modules.map((p) => p.artifact),
        ...selection.policies.map((p) => p.artifact),
        ...selection.artifacts.map((p) => p.artifact),
        ...selection.providerCapabilities.map((p) => p.evidenceArtifact),
        participantConfiguration,
      ];
      for (const pin of authorityPins) {
        const descriptor = await artifacts.inspect(
          tx,
          scope,
          pin,
          current(startedAt)
        );
        const rights = await artifacts.currentRights(
          tx,
          scope,
          descriptor.rightsPolicyId,
          descriptor.rightsVersion,
          current(startedAt)
        );
        bounds.push(string(rights["expiresAt"]));
        if (rights["retentionUntil"] !== null)
          bounds.push(string(rights["retentionUntil"]));
        const metadata = await ctx.artifact(
          tx,
          principal,
          scope,
          null,
          pin.artifactId,
          "read",
          current(startedAt)
        );
        if (metadata) {
          bounds.push(string(metadata.rights.expiresAt));
          if (metadata.rights.retentionUntil !== null)
            bounds.push(metadata.rights.retentionUntil);
        }
        await retain(principal, null, pin.artifactId);
      }
      for (const pin of selection.policies.filter(
        (p) => p.role === "licensing-rights"
      )) {
        const rights = await artifacts.currentRights(
          tx,
          scope,
          pin.policyId,
          pin.version,
          current(startedAt)
        );
        bounds.push(string(rights["expiresAt"]));
        if (rights["retentionUntil"] !== null)
          bounds.push(string(rights["retentionUntil"]));
      }
      bounds.push(
        ...selection.references.map((ref) => ref.expiresAt),
        ...selection.providerCapabilities.map((fact) => fact.expiresAt)
      );
      const temporaryBytes: Uint8Array[] = [];
      const read = async (
        pin: ReturnType<typeof PolicyArtifactPinSchema.parse>
      ) => {
        const readAt = current(startedAt);
        await retain(principal, null, pin.artifactId);
        const bytes = await artifacts.readSelectedArtifact(
          tx,
          principal,
          scope,
          pin
        );
        temporaryBytes.push(bytes);
        current(readAt);
        return bytes;
      };
      try {
        const decode = (bytes: Uint8Array): VertexRecord =>
          object(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          );
        const modelPolicyPin = parsedConfiguration.modelPolicy;
        const models = selection.artifacts.filter(
          (entry) => entry.role === "model"
        );
        if (models.length !== 1) return fail("denied");
        const modelDescriptorPin = present(models[0]).artifact;
        const modelPolicyBytes = await read(modelPolicyPin);
        const modelPolicy = decode(modelPolicyBytes) as ResearchChatModelPolicy;
        const modelDescriptorBytes = await read(modelDescriptorPin);
        const modelDescriptor = VertexRuntimeModelDescriptorSchema.parse(
          decode(modelDescriptorBytes)
        );
        const tokenizePolicyBytes = await read(
          parsedConfiguration.provider.tokenizeEndpoint
        );
        const completionPolicyBytes = await read(
          parsedConfiguration.provider.completionEndpoint
        );
        const endpoints = [
          decode(tokenizePolicyBytes),
          decode(completionPolicyBytes),
        ] as unknown as readonly [
          ResearchChatEndpointPolicy,
          ResearchChatEndpointPolicy,
        ];
        const manifests = selection.artifacts.filter(
          (pin) =>
            pin.role === "tool-config" &&
            pin.artifact.artifactSha256 === modelPolicy.serving_manifest_sha256
        );
        const prices = selection.artifacts.filter(
          (pin) =>
            pin.role === "tool-config" &&
            pin.artifact.artifactId === modelPolicy.pricing_source_artifact_id
        );
        if (manifests.length !== 1 || prices.length !== 1)
          return fail("denied");
        const servingManifestBytes = await read(present(manifests[0]).artifact),
          pricingBytes = await read(present(prices[0]).artifact);
        bounds.push(
          modelDescriptor.expiresAt,
          modelDescriptor.pricing.expiresAt
        );
        const evidence: ResearchChatEvidenceProjection[] = [];
        for (const joined of input.evidence) {
          const value = ResearchEvidenceSchema.parse(joined["evidence"]),
            review = AcceptedReviewSchema.parse(joined["review"]),
            metadata = object(joined["artifact"]);
          const pinned = object(
            metadata["rights"]
          ) as unknown as VertexRightsRecord;
          const row = await ctx.latestRights(
            tx,
            scope,
            value.collectionId,
            value.rightsPolicyId
          );
          if (!row || (await ctx.hash(row["payload"])) !== row["record_hash"])
            return fail("integrity");
          const rights = object(
            row["payload"]
          ) as unknown as VertexRightsRecord;
          if (
            rights.version !== pinned.version ||
            rights.policyId !== pinned.policyId
          )
            return fail("stale");
          for (const use of ["read", "derive", "export"] as const)
            await ctx.rights(
              tx,
              scope,
              value.collectionId,
              pinned,
              use,
              current(startedAt)
            );
          await retain(principal, value.collectionId, value.evidenceId);
          await retain(
            principal,
            value.collectionId,
            string(metadata["artifactId"])
          );
          await retain(principal, value.collectionId, review.reviewId);
          await retain(
            { actorId: review.actorId },
            value.collectionId,
            string(metadata["artifactId"]),
            "review"
          );
          const ends = [
            review.expiresAt,
            string(pinned.expiresAt),
            string(rights.expiresAt),
          ];
          if (pinned.retentionUntil !== null) ends.push(pinned.retentionUntil);
          if (rights.retentionUntil !== null) ends.push(rights.retentionUntil);
          bounds.push(...ends);
          // DataKnowledge.retrieve uses precisely this bounded claim and a separate
          // UTF-8 digest, NEVER the manifest bytes or source contentHash as excerpt.
          if (value.claim.length > 8000 || ns(value.capturedAt) > ns(startedAt))
            return fail("invalid");
          const excerptBytes = new TextEncoder().encode(value.claim);
          temporaryBytes.push(excerptBytes);
          evidence.push({
            evidence_id: value.evidenceId,
            collection_id: value.collectionId,
            snapshot_id: value.snapshotId,
            source_id: value.sourceIdentity.sourceId,
            source_snapshot_id: value.sourceIdentity.snapshotId,
            source_uri: value.sourceUri,
            locator: value.sourceLocator,
            attribution: value.attribution,
            content_hash: value.contentHash,
            excerpt_digest: await hashArtifact(excerptBytes),
            excerpt: value.claim,
            rights_policy_id: value.rightsPolicyId,
            captured_ns: ns(value.capturedAt),
            published_ns:
              value.publishedAt === null ? null : ns(value.publishedAt),
            valid_until_ns: ns(minimum(ends)),
            artifact_digest: string(metadata["artifactSha256"]),
            accepted_review_id: review.reviewId,
            accepted_review_revision: researchChatAcceptedReviewRevision(
              review.reviewVersion
            ),
            untrusted_content: true,
          });
        }
        const messages = await Promise.all(
          input.messages.map(async (message) => {
            const author = object(message["author"]);
            if (
              author["kind"] !== "user" ||
              author["actorId"] !== principal.actorId
            )
              return fail("denied");
            return {
              message_id: message["messageId"],
              sequence: message["sequence"],
              record_sha256: await ctx.hash(message),
              author: { kind: "user", actor_id: author["actorId"] },
              body: message["body"],
            };
          })
        );
        const humanContext = parseVertexResearchChatHumanContextV1({
          schema_version: "1.0.0",
          kind: "research-chat-human-context",
          account_alias: scope.accountAlias,
          environment: scope.environment,
          owner_actor_id: principal.actorId,
          response_request_id: input.responseRequestId,
          thread_id: request.threadId,
          parent_message_id: request.parentMessageId,
          participant_id: request.participantId,
          participant_config_sha256: participantConfiguration.artifactSha256,
          participant_label: parsedConfiguration.participantLabel,
          persona_text: parsedConfiguration.personaText,
          snapshot_revision: request.snapshotRevision,
          high_water_sequence: (
            BigInt(request.snapshotRevision) - 1n
          ).toString(),
          start_sequence: request.contextStartSequence,
          messages,
        });
        const after = await selected(tx, principal, scope);
        if (canonicalArtifactJson(after) !== canonicalArtifactJson(selection))
          return fail("stale");
        const expiresAt = minimum(bounds);
        const producer: ResearchChatProducerInput = {
          ownerActorId: principal.actorId,
          responseRequestId: input.responseRequestId,
          request,
          humanContext,
          configuration: parsedConfiguration,
          participantConfiguration,
          selection: {
            accountAlias: selection.accountAlias,
            environment: "research",
            selectionId: selection.selectionId,
            selectionSha256: selection.selectionSha256,
            expiresAt: selection.expiresAt,
            research: selection.research,
            artifacts: selection.artifacts,
            references: selection.references,
            providerCapabilities: selection.providerCapabilities,
          },
          evidence,
          modelPolicy,
          modelPolicyPin,
          endpoints,
          modelDescriptor,
          modelDescriptorPin,
          modelPolicyBytes,
          tokenizePolicyBytes,
          completionPolicyBytes,
          modelDescriptorBytes,
          servingManifestBytes,
          pricingBytes,
          budgets: parsedConfiguration.budgets,
          identity: {
            runId: `chat-run-${await ctx.hash({ responseRequestId: input.responseRequestId, purpose: "one-expert-run" })}`,
            traceId: `chat-trace-${await ctx.hash({ responseRequestId: input.responseRequestId, purpose: "one-expert-trace" })}`,
            expiresAt,
          },
        };
        let prepared:
          | Awaited<ReturnType<typeof prepareResearchChatInputsV2>>
          | Awaited<ReturnType<typeof prepareResearchChatNativeEvidenceInputs>>
          | Awaited<ReturnType<typeof prepareResearchChatInputs>>;
        if (debatePrepared) {
          const debateSource = debatePrepared.debate;
          const advisoryPredecessors = await Promise.all(
            debatePrepared.sources.map(async (entry) => {
              if (
                !entry.bytes ||
                (await hashArtifact(entry.bytes)) !==
                  entry.pin["contentSha256"] ||
                entry.bytes.byteLength !== entry.pin["byteLength"]
              )
                return fail("integrity");
              const advisory = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes)
              ) as unknown;
              if ((await hashArtifact(advisory)) !== entry.pin["contentSha256"])
                return fail("integrity");
              return { pin: entry.pin, advisory };
            })
          );
          const derivedContext = {
            profile: "vertex-research-chat-derived-context-v1",
            debateRunId: debateSource.debateRunId,
            ordinal: debateSource.ordinal,
            kind: debateSource.kind,
            predecessors: advisoryPredecessors,
          } as ResearchChatDerivedContext;
          const derivedBytes = new TextEncoder().encode(
            canonicalResearchChatInputJson(derivedContext)
          );
          temporaryBytes.push(derivedBytes);
          const debate = VertexResearchChatDebatePlanV1Schema.parse({
            ...debateSource,
            derivedContext: {
              sha256: await hashArtifact(derivedBytes),
              byteLength: derivedBytes.byteLength,
            },
          });
          prepared = await prepareResearchChatInputsV2(
            producer,
            debate,
            derivedContext
          );
        } else if (native) {
          prepared = await prepareResearchChatNativeEvidenceInputs(producer);
        } else prepared = await prepareResearchChatInputs(producer);
        try {
          const returnedAt = current(startedAt);
          if (ns(expiresAt) <= ns(returnedAt)) return fail("stale");
          return prepared;
        } catch (error) {
          for (const purpose of [
            "context",
            "tokenizeInput",
            "completionInput",
          ] as const)
            prepared[purpose].fill(0);
          if (
            "evidenceBundle" in prepared &&
            prepared.evidenceBundle instanceof Uint8Array
          )
            prepared.evidenceBundle.fill(0);
          throw error;
        }
      } finally {
        for (const bytes of temporaryBytes) bytes.fill(0);
      }
    };
  const debate = options.debate
    ? createResearchChatDebateOperations(ctx, {
        configuration: PolicyArtifactPinSchema.parse(
          options.debate.configuration
        ),
        reviewerActorId: options.debate.reviewerActorId,
        validate: (name, value) =>
          ({
            configuration: VertexResearchChatDebateConfigurationV1Schema,
            step: VertexResearchChatDebateStepV1Schema,
            plan: VertexResearchChatPlanV2Schema,
            reviewInput: VertexResearchChatDerivedUseReviewInputSchema,
          })[name].parse(value) as VertexRecord,
        readSelectedArtifact: (tx, principal, scope, pin) =>
          artifacts.readSelectedArtifact(
            tx,
            principal,
            researchScope(scope),
            PolicyArtifactPinSchema.parse(pin)
          ),
        readPublished: (tx, principal, scope, pin, at) =>
          output.readPublishedPredecessorForTransaction(
            tx,
            principal,
            researchScope(scope),
            pin,
            at
          ),
        sourceInputs: {
          prepareSourceInputs: (request) => output.prepareSourceInputs(request),
          recheckSourceInputsForTransaction: (
            tx,
            request,
            token,
            at,
            includeBytes
          ) =>
            output.recheckSourceInputsForTransaction(
              tx,
              request,
              token,
              at,
              includeBytes
            ),
          disposeSourceInputs: (token) => output.disposeSourceInputs(token),
        },
      })
    : undefined;
  const executionOptions: VertexResearchChatExecutionOptions = {
    validate: (name, value) =>
      VERTEX_RESEARCH_CHAT_EXECUTION_SCHEMAS[name].parse(value) as VertexRecord,
    experts,
    storage,
    ...(firstMate ? { firstMate } : {}),
    ...(nativeEvidence ? { nativeEvidence } : {}),
    ...(debate ? { debate } : {}),
    readSelectedArtifact: (tx, principal, scope, pin) =>
      artifacts.readSelectedArtifact(
        tx,
        principal,
        researchScope(scope),
        PolicyArtifactPinSchema.parse(pin)
      ),
    readCollectionArtifact,
    readSelection: selected,
    readRetention: (tx, principal, scope, selection, native = false) =>
      native
        ? policy.readResearchChatNativeCopyRetentionForTransaction(
            tx,
            principal,
            {
              ...researchScope(scope),
              selectionId: identifier(selection["selectionId"]),
              selectionSha256: string(selection["selectionSha256"]),
            },
            policyOptions.consumerServiceId
          )
        : policy.readResearchChatCopyRetentionForTransaction(
            tx,
            principal,
            {
              ...researchScope(scope),
              selectionId: identifier(selection["selectionId"]),
              selectionSha256: string(selection["selectionSha256"]),
            },
            policyOptions.consumerServiceId
          ),
    prepareInputs,
  };
  const operations = createResearchChatExecutionOperations(
    ctx,
    executionOptions
  );
  const copies = createResearchChatCopyLifecycle(
    ctx,
    operations,
    executionOptions,
    options.db
  );
  const worker = createResearchChatWorkerOperations(ctx, operations, copies, {
    objectCapabilities: options.objectCapabilities,
    validateRecipe: (value) => ResearchChatRecipeSchema.parse(value),
  });
  const workerModel = createVertexResearchChatWorkerRuntime(
    ctx,
    worker,
    policy
  );
  const privacy = options.privacyReviewerActorId
    ? createResearchChatModelPrivacyOperations(ctx, workerModel, {
        reviewerActorId: options.privacyReviewerActorId,
      })
    : undefined;
  const output = createVertexResearchChatOutputRuntime(
    ctx,
    options.db,
    worker,
    workerModel,
    policy,
    privacy,
    debate
  );
  const conversation = createVertexResearchChatConversationRuntime(
    ctx,
    operations,
    copies,
    worker,
    output,
    debate
  );
  // Only conversation is the bounded public leaf. Administration/worker owners
  // stay programmatic; constructing either surface sends/runs/grants nothing.
  return Object.freeze({
    planResearchChatResponse: operations.planResearchChatResponse,
    recordResearchChatStorageQualificationReview:
      operations.recordResearchChatStorageQualificationReview,
    approveResearchChatResponse: operations.approveResearchChatResponse,
    writeApprovedInputs: copies.writeApprovedInputs,
    reconcileApprovedInputs: copies.reconcileApprovedInputs,
    readApprovedInput: copies.readApprovedInput,
    closeApprovedInputs: copies.closeApprovedInputs,
    drainApprovedCopyCleanup: copies.drainApprovedCopyCleanup,
    admitApprovedResponse: worker.admitApprovedResponse,
    worker,
    workerModel,
    privacy,
    output,
    conversation,
    debate,
  });
};
