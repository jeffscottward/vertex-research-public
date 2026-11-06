import {
  snapshotVertexChatCopyBinding,
  VERTEX_CHAT_COPY_FENCE_PROFILE,
  type VertexChatCopyBinding,
  type VertexChatCopyCreation,
  type VertexChatCopyFence,
  type VertexChatCopyInspection,
  type VertexChatCopyProof,
  type VertexChatCopyRead,
  vertexChatCopyKey,
} from "@darkfactory/storage/chat-copies";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  accountCatalogArtifact,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  string,
  time,
} from "./vertex-persistence-core.ts";
import {
  invalidateTransactionRows,
  withTransactionReadScope,
} from "./vertex-transaction-read-cache.ts";
import type { VertexPrincipal, VertexRecord } from "./vertex-ports.ts";
import type { VertexResearchChatCopyInventory } from "./vertex-research-chat-copy-ports.ts";
import { createResearchChatCopyMetadata } from "./vertex-research-chat-copy-store.ts";
import type {
  ChatApprovedInputOwner,
  ChatApprovedInputs,
  ChatInputPurpose,
  VertexResearchChatExecutionOptions,
} from "./vertex-research-chat-execution-ports.ts";
import { researchChatContextUseResource } from "./vertex-research-chat-execution-ports.ts";
import {
  createResearchChatNativePhaseStore,
  isNativeEvidencePlan,
  type NativeEvidencePhaseTwoInput,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";
import type { ResearchChatSourceInputs } from "./vertex-research-chat-source-ports.ts";

const purposes = ["context", "tokenizeInput", "completionInput"] as const;
const nativeInitialPurposes = [...purposes, "evidenceBundle"] as const;
const nativeIntermediatePurposes = [
  "phaseOneResponse",
  "toolResult",
  "phaseTwoTokenizeInput",
  "phaseTwoCompletionInput",
] as const;
const initialPurposesFor = (plan: VertexRecord): readonly ChatInputPurpose[] =>
  isNativeEvidencePlan(plan) ? nativeInitialPurposes : purposes;
const preparedBytes = (
  prepared: ChatApprovedInputs["prepared"],
  purpose: ChatInputPurpose
): Uint8Array => {
  if (
    purpose === "context" ||
    purpose === "tokenizeInput" ||
    purpose === "completionInput"
  )
    return prepared[purpose];
  if (purpose === "evidenceBundle" && prepared.evidenceBundle)
    return prepared.evidenceBundle;
  return fail("invalid");
};
const effectsTable = "vertex_research_chat_copy_effects";
const observationsTable = "vertex_research_chat_copy_effect_observations";
const domainsTable = "vertex_research_chat_copy_domain_closures";
type Scope = Readonly<{ accountAlias: string; environment: "research" }>;
type Domain = "inputs" | "derived";
type Cause =
  | "explicit"
  | "deadline"
  | "original-authority-revoked"
  | "original-authority-expired"
  | "rights-denied"
  | "rights-expiry"
  | "rights-superseded"
  | "retention-ended"
  | "storage-review-superseded"
  | "storage-review-rejected"
  | "storage-review-expired"
  | "corpus-review-superseded"
  | "corpus-review-rejected"
  | "corpus-review-expired"
  | "response-attempt-terminal"
  | "storage-fenced";
type AuthorityKind =
  | "owner-context-grant"
  | "corpus-rights"
  | "private-policy-rights"
  | "storage-review"
  | "corpus-review"
  | "plan"
  | "cleanup-grant"
  | "response-attempt"
  | "storage-fence";
type Authority = Readonly<{
  kind: AuthorityKind;
  resourceId: string;
  version: string | null;
}>;
type Loss = Readonly<{ cause: Cause; authority: Authority }>;
const lossOf = (
  cause: Cause,
  kind: AuthorityKind,
  resourceId: unknown,
  version: unknown = null
): Loss => ({
  cause,
  authority: {
    kind,
    resourceId: identifier(resourceId),
    version: version === null ? null : identifier(version),
  },
});
type Input = Readonly<{
  principal: VertexPrincipal;
  scope: Scope;
  supplied: VertexRecord;
  responseRequestId: string;
  sourceInputs?: ResearchChatSourceInputs;
}>;
type Summary = Readonly<{
  purpose: ChatInputPurpose;
  copyId: string;
  status: "live" | "unknown" | "closed";
}>;

// Private concrete owner, NOT an authorization interface for injected clients.
// Immutable intents are effect fences, not retry requests. Private worker
// continuations never dispatch a model or assert publication/terminal success.
export const createResearchChatCopyLifecycle = (
  ctx: PersistenceContext,
  execution: ChatApprovedInputOwner,
  options: VertexResearchChatExecutionOptions,
  db: Database
) => {
  const metadata = createResearchChatCopyMetadata(ctx);
  const phases = createResearchChatNativePhaseStore(ctx);
  const capabilities = options.storage.capabilities;
  const current = (startedAt: string, ...ends: readonly string[]): void => {
    const now = time(ctx.now());
    if (now < time(startedAt) || ends.some((end) => time(end) <= now))
      fail("stale");
  };
  const save = async (
    tx: Transaction,
    table: string,
    scope: Scope,
    value: VertexRecord,
    columns: VertexRecord
  ): Promise<void> => {
    await insert(tx, table, scope, {
      ...columns,
      record_hash: await ctx.hash(value),
      payload: value,
    });
  };
  const prepare = async (
    rawPrincipal: VertexPrincipal,
    raw: unknown
  ): Promise<Input> => {
    const principal = ctx.capture(rawPrincipal),
      captured = ctx.capture(raw);
    const supplied = ctx.capture(
      await options.validate("approveInput", captured)
    );
    if ((await ctx.hash(supplied)) !== (await ctx.hash(captured)))
      return fail("invalid");
    const request = object(supplied["request"]);
    const scope: Scope = {
      accountAlias: identifier(request["accountAlias"]),
      environment: "research",
    };
    if (request["environment"] !== "research") return fail("invalid");
    const responseRequestId = `response-${await ctx.hash({ operation: "requestResponse", actorId: principal.actorId, scope, threadId: request["threadId"], idempotencyKey: request["idempotencyKey"] })}`;
    return { principal, scope, supplied, responseRequestId };
  };
  const original = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string
  ) => {
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    const approved = await one(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!(row && approved)) return fail("denied");
    const plan = ctx.capture(await options.validate("plan", row["payload"])),
      approval = ctx.capture(
        await options.validate("approval", approved["payload"])
      );
    const { planId, planSha256, ...body } = plan;
    if (
      (await ctx.hash(plan)) !== row["record_hash"] ||
      (await ctx.hash(body)) !== planSha256 ||
      planId !== `chat-plan-${planSha256}` ||
      (await ctx.hash(approval)) !== approved["record_hash"]
    )
      return fail("integrity");
    if (
      plan["accountAlias"] !== scope.accountAlias ||
      plan["environment"] !== scope.environment ||
      plan["responseRequestId"] !== responseRequestId ||
      row["plan_id"] !== planId ||
      row["plan_sha256"] !== planSha256 ||
      row["owner_actor_id"] !== plan["ownerActorId"] ||
      approved["owner_actor_id"] !== plan["ownerActorId"] ||
      approved["plan_id"] !== planId ||
      approved["plan_sha256"] !== planSha256 ||
      approval["planId"] !== planId ||
      approval["planSha256"] !== planSha256 ||
      approval["ownerActorId"] !== plan["ownerActorId"] ||
      approval["responseRequestId"] !== responseRequestId ||
      approval["requestSha256"] !== plan["requestSha256"] ||
      approved["storage_review_id"] !== approval["storageReviewId"]
    )
      return fail("integrity");
    const reviewRow = await one(
      tx,
      "vertex_research_chat_storage_reviews",
      scope,
      sql`review_id = ${approval["storageReviewId"]}`
    );
    if (!reviewRow) return fail("integrity");
    const review = ctx.capture(
      await options.validate("storageReview", reviewRow["payload"])
    );
    if (
      (await ctx.hash(review)) !== reviewRow["record_hash"] ||
      approval["storageReviewSha256"] !== reviewRow["record_hash"] ||
      review["planSha256"] !== planSha256 ||
      review["responseRequestId"] !== responseRequestId ||
      review["decision"] !== "accepted"
    )
      return fail("integrity");
    // Cleanup retains historical accepted provenance, not today's processing
    // grants. It may fence after processing rights expire, but never another backend.
    for (const key of [
      "capabilityReferenceId",
      "backendDeploymentId",
      "storageProfileSha256",
    ] as const)
      if (plan[key] !== options.storage[key]) return fail("denied");
    if (
      (await ctx.hash(plan["storageEvidence"])) !==
      (await ctx.hash(options.storage.evidence))
    )
      return fail("denied");
    return { plan, approval, review };
  };
  const inventoryFor = async (
    tx: Transaction,
    scope: Scope,
    plan: VertexRecord
  ): Promise<VertexResearchChatCopyInventory | null> => {
    const inventory = await metadata.load(
      tx,
      scope,
      string(plan["responseRequestId"])
    );
    if (!inventory) return null;
    const native = isNativeEvidencePlan(plan);
    if (
      inventory.family.ownerActorId !== plan["ownerActorId"] ||
      inventory.family.threadId !== plan["threadId"] ||
      inventory.family.requestSha256 !== plan["requestSha256"] ||
      inventory.family.storageProfileSha256 !== plan["storageProfileSha256"] ||
      inventory.copies.length !== (native ? 9 : 4)
    )
      return fail("integrity");
    for (const purpose of native
      ? nativeEvidenceCopyPurposes
      : ([...purposes, "advisory"] as const)) {
      const entry = inventory.copies.find(
        (candidate) =>
          candidate.allocation.copyIdempotencyKey ===
          (native ? nativeEvidenceCopyKey(purpose) : `one-expert-${purpose}-v1`)
      );
      if (
        !entry ||
        entry.allocation.kind !==
          (purpose === "context"
            ? "context"
            : purpose === "advisory"
              ? "derived-output"
              : "model-input")
      )
        return fail("integrity");
      if (purpose === "advisory") {
        if (entry.allocation.maximumBytes !== plan["advisoryMaximumBytes"])
          return fail("integrity");
      } else if (
        (nativeIntermediatePurposes as readonly string[]).includes(purpose)
      ) {
        if (
          entry.allocation.maximumBytes !==
          object(plan["nativeEvidence"])["maximumIntermediateBytes"]
        )
          return fail("integrity");
      } else {
        const content = object(
          purpose === "evidenceBundle"
            ? object(plan["nativeEvidence"])["bundle"]
            : plan[purpose]
        );
        if (
          !entry.contentBinding ||
          (await ctx.hash(entry.contentBinding.content)) !==
            (await ctx.hash(content)) ||
          entry.allocation.maximumBytes !== content["byteLength"]
        )
          return fail("integrity");
      }
    }
    return inventory;
  };
  const domain = async (
    tx: Transaction,
    scope: Scope,
    plan: VertexRecord,
    value: Domain
  ): Promise<VertexRecord | null> => {
    const row = await one(
      tx,
      domainsTable,
      scope,
      sql`response_request_id = ${plan["responseRequestId"]} and domain = ${value}`
    );
    if (!row) return null;
    const closed = object(row["payload"]);
    if (
      (await ctx.hash(closed)) !== row["record_hash"] ||
      closed["profile"] !== "vertex-research-chat-copy-domain-closure-v1" ||
      (await ctx.hash(closed["scope"])) !== (await ctx.hash(scope)) ||
      closed["responseRequestId"] !== plan["responseRequestId"] ||
      closed["planSha256"] !== plan["planSha256"] ||
      closed["domain"] !== value ||
      row["plan_sha256"] !== plan["planSha256"] ||
      row["closed_at_ns"] !== time(closed["closedAt"]).toString()
    )
      return fail("integrity");
    return closed;
  };
  const closeDomain = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    target: Domain,
    loss: Loss,
    at: string
  ): Promise<VertexRecord> => {
    const { plan } = await original(tx, scope, responseRequestId);
    const previous = await domain(tx, scope, plan, target);
    if (previous) return previous;
    const inventory = await inventoryFor(tx, scope, plan);
    if (
      time(at) < time(plan["plannedAt"]) ||
      inventory?.copies.some(
        (entry) =>
          time(at) <
          time(entry.contentBinding?.boundAt ?? entry.allocation.reservedAt)
      )
    )
      return fail("stale");
    const value = {
      profile: "vertex-research-chat-copy-domain-closure-v1",
      scope,
      responseRequestId,
      planSha256: plan["planSha256"],
      domain: target,
      cause: loss.cause,
      authority: loss.authority,
      closedAt: at,
    };
    await save(tx, domainsTable, scope, value, {
      response_request_id: responseRequestId,
      plan_sha256: plan["planSha256"],
      domain: target,
      closed_at_ns: time(at).toString(),
    });
    return value;
  };
  // Future worker owner must prove real origin/lease/publication itself. This
  // same-transaction hook is input-only and makes NO worker-success claim.
  const closeResponseAttemptInputsForTransaction = (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    cause: "explicit" | "response-attempt-terminal",
    at: string
  ): Promise<VertexRecord> =>
    closeDomain(
      tx,
      scope,
      responseRequestId,
      "inputs",
      lossOf(
        cause,
        cause === "explicit" ? "cleanup-grant" : "response-attempt",
        cause === "explicit"
          ? `research-chat-copies:${responseRequestId}`
          : responseRequestId
      ),
      at
    );
  const closeAuthorityDomains = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    loss: Loss,
    at: string
  ): Promise<void> => {
    await closeDomain(tx, scope, responseRequestId, "inputs", loss, at);
    await closeDomain(tx, scope, responseRequestId, "derived", loss, at);
  };
  // Only explicit persisted ORIGINAL authority losses close the shared domain.
  // Missing caller grants, parse failures, backend failures and transient denies
  // are not global revocation. No query echo is read by this metadata check.
  const authorityLoss = async (
    tx: Transaction,
    scope: Scope,
    plan: VertexRecord,
    review: VertexRecord,
    at: string
  ): Promise<Loss | null> => {
    // Each authority observation reads current rights afresh (it can follow
    // external copy I/O); repeated reads inside it reuse the first result.
    // Catalog artifact rows are immutable and absences are never cached, so
    // they stay reusable for the whole transaction.
    invalidateTransactionRows(tx, "vertex_rights_versions");
    // Retain the exact verified source of each deadline. Classification happens
    // once, synchronously, AFTER the final metadata await. Dependent approval
    // and plan ceilings cannot mask the original right/review/grant that ended.
    type Bound = Readonly<{ end: bigint; loss: Loss }>;
    const rootBounds: Bound[] = [],
      grantBounds: Bound[] = [];
    const retain = (end: unknown, loss: Loss): void => {
      rootBounds.push({ end: time(end), loss });
    };
    // Latest head, not latest accepted. These are verified persisted records,
    // independent from whether today's reader is allowed to see their bytes.
    const storageRow = await one(
      tx,
      "vertex_research_chat_storage_reviews",
      scope,
      sql`response_request_id = ${plan["responseRequestId"]}`,
      sql`order by reviewed_at_ns desc, review_id desc`
    );
    if (!storageRow) return fail("integrity");
    const storageHead = ctx.capture(
      await options.validate("storageReview", storageRow["payload"])
    );
    if (
      (await ctx.hash(storageHead)) !== storageRow["record_hash"] ||
      storageHead["accountAlias"] !== scope.accountAlias ||
      storageHead["environment"] !== scope.environment ||
      storageHead["reviewId"] !== storageRow["review_id"] ||
      storageHead["responseRequestId"] !== plan["responseRequestId"] ||
      storageHead["planId"] !== plan["planId"] ||
      storageHead["planSha256"] !== plan["planSha256"] ||
      storageHead["ownerActorId"] !== plan["ownerActorId"] ||
      storageHead["actorId"] !== storageRow["actor_id"] ||
      storageHead["decision"] !== storageRow["decision"] ||
      storageHead["requestSha256"] !== storageRow["request_sha256"] ||
      storageHead["idempotencyKey"] !== storageRow["idempotency_key"] ||
      time(storageHead["reviewedAt"]).toString() !==
        storageRow["reviewed_at_ns"] ||
      time(storageHead["expiresAt"]).toString() !==
        storageRow["expires_at_ns"] ||
      time(storageHead["reviewedAt"]) > time(at) ||
      (await ctx.hash(storageHead["evidence"])) !==
        (await ctx.hash(plan["storageEvidence"]))
    )
      return fail("integrity");
    if (storageHead["decision"] === "rejected")
      return lossOf(
        "storage-review-rejected",
        "storage-review",
        storageHead["reviewId"]
      );
    if (storageHead["reviewId"] !== review["reviewId"])
      return lossOf(
        "storage-review-superseded",
        "storage-review",
        storageHead["reviewId"]
      );
    const resource = researchChatContextUseResource(
      string(plan["responseRequestId"])
    );
    const found = await rows(
      tx,
      sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${plan["ownerActorId"]} and b.collection_key = '' and b.resource_id = ${resource} limit 129`
    );
    if (found.length > 128) return fail("integrity");
    let revoked: Loss | null = null,
      active = false;
    for (const row of found) {
      const grant = object(row["payload"]);
      if (
        (await ctx.hash(grant)) !== row["record_hash"] ||
        grant["version"] !== row["current_version"] ||
        grant["revision"] !== row["revision"] ||
        grant["granteeActorId"] !== plan["ownerActorId"] ||
        (await ctx.hash(grant["scope"])) !== (await ctx.hash(scope)) ||
        grant["collectionId"] !== null ||
        grant["resourceId"] !== resource
      )
        return fail("integrity");
      if (
        !(
          Array.isArray(grant["actions"]) &&
          grant["actions"].includes("publish")
        ) ||
        time(grant["recordedAt"]) > time(at)
      )
        continue;
      if (grant["status"] === "revoked") {
        revoked = lossOf(
          "original-authority-revoked",
          "owner-context-grant",
          grant["grantId"],
          grant["version"]
        );
      } else if (
        grant["status"] === "granted" &&
        time(grant["validFrom"]) <= time(at)
      ) {
        const end = time(grant["expiresAt"]);
        grantBounds.push({
          end,
          loss: lossOf(
            "original-authority-expired",
            "owner-context-grant",
            grant["grantId"],
            grant["version"]
          ),
        });
        if (end > time(at)) active = true;
      }
    }
    if (!active && revoked) return revoked;
    const rightsLoss = async (
      collection: string | null,
      policyId: string,
      version: string,
      kind: "corpus-rights" | "private-policy-rights"
    ): Promise<Loss | null> => {
      const row = await ctx.latestRights(tx, scope, collection, policyId);
      if (!row) return fail("integrity");
      if ((await ctx.hash(row["payload"])) !== row["record_hash"])
        return fail("integrity");
      const rights = object(row["payload"]);
      if (
        row["collection_key"] !== (collection ?? "") ||
        row["policy_id"] !== policyId ||
        rights["policyId"] !== policyId ||
        row["version"] !== rights["version"] ||
        time(rights["checkedAt"]) > time(at)
      )
        return fail("integrity");
      if (rights["status"] === "denied")
        return lossOf("rights-denied", kind, policyId, rights["version"]);
      if (rights["status"] === "expired")
        return lossOf("rights-expiry", kind, policyId, rights["version"]);
      if (rights["expiresAt"] !== null)
        retain(
          rights["expiresAt"],
          lossOf("rights-expiry", kind, policyId, rights["version"])
        );
      if (rights["retentionUntil"] !== null)
        retain(
          rights["retentionUntil"],
          lossOf("retention-ended", kind, policyId, rights["version"])
        );
      if (rights["version"] !== version) {
        if (
          rights["expiresAt"] !== null &&
          time(rights["expiresAt"]) <= time(at)
        )
          return lossOf("rights-expiry", kind, policyId, rights["version"]);
        if (
          rights["retentionUntil"] !== null &&
          time(rights["retentionUntil"]) <= time(at)
        )
          return lossOf("retention-ended", kind, policyId, rights["version"]);
        return lossOf("rights-superseded", kind, policyId, rights["version"]);
      }
      return null;
    };
    for (const raw of plan["reviewPins"] as readonly VertexRecord[]) {
      const originalRow = await one(
        tx,
        "vertex_reviews",
        scope,
        sql`collection_key = ${raw["collectionId"]} and review_id = ${raw["reviewId"]}`
      );
      const headRow = await one(
        tx,
        "vertex_reviews",
        scope,
        sql`collection_key = ${raw["collectionId"]} and artifact_id = ${raw["artifactId"]} and purpose = 'research'`,
        sql`order by reviewed_at_ns desc, review_id desc`
      );
      if (!(originalRow && headRow)) return fail("integrity");
      const checked = async (
        row: Record<string, unknown>
      ): Promise<VertexRecord> => {
        const value = await ctx.validate("AcceptedReview", row["payload"]);
        if (
          (await ctx.hash(value)) !== row["record_hash"] ||
          value["accountAlias"] !== scope.accountAlias ||
          value["environment"] !== scope.environment ||
          value["collectionId"] !== raw["collectionId"] ||
          value["artifactId"] !== raw["artifactId"] ||
          value["artifactSha256"] !== raw["artifactSha256"] ||
          value["purpose"] !== "research" ||
          value["reviewId"] !== row["review_id"] ||
          value["reviewVersion"] !== row["review_version"] ||
          value["actorId"] !== row["actor_id"] ||
          value["decision"] !== row["decision"] ||
          time(value["reviewedAt"]).toString() !== row["reviewed_at_ns"] ||
          time(value["expiresAt"]).toString() !== row["expires_at_ns"] ||
          time(value["reviewedAt"]) > time(at)
        )
          return fail("integrity");
        if (value["decision"] === "accepted") {
          const link = await one(
            tx,
            "vertex_reviewed_artifact_links",
            scope,
            sql`review_id = ${value["reviewId"]} and collection_key = ${raw["collectionId"]} and artifact_id = ${raw["artifactId"]} and artifact_sha256 = ${raw["artifactSha256"]}`
          );
          if (!link) return fail("integrity");
        }
        return value;
      };
      const originalReview = await checked(originalRow),
        head = await checked(headRow);
      if (
        originalReview["reviewId"] !== raw["reviewId"] ||
        originalReview["reviewVersion"] !== raw["reviewVersion"] ||
        originalReview["decision"] !== "accepted"
      )
        return fail("integrity");
      if (head["decision"] === "rejected")
        return lossOf(
          "corpus-review-rejected",
          "corpus-review",
          head["reviewId"],
          head["reviewVersion"]
        );
      if (
        head["reviewId"] !== raw["reviewId"] ||
        head["reviewVersion"] !== raw["reviewVersion"]
      )
        return lossOf(
          "corpus-review-superseded",
          "corpus-review",
          head["reviewId"],
          head["reviewVersion"]
        );
      retain(
        originalReview["expiresAt"],
        lossOf(
          "corpus-review-expired",
          "corpus-review",
          raw["reviewId"],
          raw["reviewVersion"]
        )
      );
      const loss = await rightsLoss(
        identifier(raw["collectionId"]),
        identifier(raw["rightsPolicyId"]),
        string(raw["rightsVersion"]),
        "corpus-rights"
      );
      if (loss) return loss;
    }
    // Exact original selected bytes are committed by the plan selection digest.
    // This metadata-only loss observer never reads bodies with a revoked grant.
    const selectedRow = await one(
      tx,
      "vertex_policy_selections",
      scope,
      sql`selection_id = ${plan["selectionId"]}`
    );
    if (!selectedRow) return fail("integrity");
    const selection = object(selectedRow["payload"]),
      { selectionSha256, ...selectionBody } = selection;
    if (
      (await ctx.hash(selectionBody)) !== plan["selectionSha256"] ||
      selectionSha256 !== plan["selectionSha256"] ||
      selectedRow["selection_sha256"] !== plan["selectionSha256"] ||
      selection["selectionId"] !== plan["selectionId"] ||
      selection["accountAlias"] !== scope.accountAlias ||
      selection["environment"] !== scope.environment
    )
      return fail("integrity");
    const items = (value: unknown): readonly VertexRecord[] => {
      if (!Array.isArray(value) || value.length > 512) return fail("integrity");
      return value.map(object);
    };
    const pins = [
      object(plan["participantConfiguration"]),
      object(plan["retentionArtifact"]),
      object(plan["storageEvidence"]),
      ...items(selection["sourcePins"]).map((entry) =>
        object(entry["provenanceArtifact"])
      ),
      ...items(selection["modules"]).map((entry) => object(entry["artifact"])),
      ...items(selection["policies"]).map((entry) => object(entry["artifact"])),
      ...items(selection["artifacts"]).map((entry) =>
        object(entry["artifact"])
      ),
      ...items(selection["providerCapabilities"]).map((entry) =>
        object(entry["evidenceArtifact"])
      ),
    ];
    for (const pin of pins) {
      const artifact = await accountCatalogArtifact(
        tx,
        scope,
        pin["artifactId"]
      );
      let policyId: string, version: string;
      if (artifact) {
        const value = object(artifact["payload"]),
          rights = object(value["rights"]);
        if (
          (await ctx.hash(value)) !== artifact["metadata_hash"] ||
          value["artifactId"] !== pin["artifactId"] ||
          value["artifactSha256"] !== pin["artifactSha256"] ||
          artifact["artifact_sha256"] !== pin["artifactSha256"] ||
          value["collectionId"] !== null ||
          (await ctx.hash(value["scope"])) !== (await ctx.hash(scope))
        )
          return fail("integrity");
        policyId = identifier(rights["policyId"]);
        version = string(rights["version"]);
      } else {
        const stage = await one(
          tx,
          "vertex_worker_stages",
          scope,
          sql`collection_key = '' and artifact_id = ${pin["artifactId"]}`
        );
        if (!stage) return fail("integrity");
        const value = object(stage["payload"]);
        if (
          (await ctx.hash(value)) !== stage["request_hash"] ||
          value["artifactId"] !== pin["artifactId"] ||
          value["contentSha256"] !== pin["artifactSha256"] ||
          stage["content_sha256"] !== pin["artifactSha256"] ||
          value["accountAlias"] !== scope.accountAlias ||
          value["environment"] !== scope.environment ||
          value["collectionId"] !== null
        )
          return fail("integrity");
        policyId = identifier(value["rightsPolicyId"]);
        version = string(value["rightsVersion"]);
      }
      const loss = await rightsLoss(
        null,
        policyId,
        version,
        "private-policy-rights"
      );
      if (loss) return loss;
    }
    for (const selected of items(selection["policies"]).filter(
      (entry) => entry["role"] === "licensing-rights"
    )) {
      const loss = await rightsLoss(
        null,
        identifier(selected["policyId"]),
        string(selected["version"]),
        "private-policy-rights"
      );
      if (loss) return loss;
    }
    for (const selected of items(selection["providerCapabilities"])) {
      const loss = await rightsLoss(
        null,
        identifier(selected["rightsPolicyId"]),
        string(selected["rightsPolicyVersion"]),
        "private-policy-rights"
      );
      if (loss) return loss;
    }
    // Any current exact grant suffices; classify grant expiry only after the
    // last eligible one has ended, while preserving that exact grant/version.
    if (grantBounds.length)
      rootBounds.push(grantBounds.reduce((a, b) => (a.end >= b.end ? a : b)));
    rootBounds.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    const finalNow = time(ctx.now());
    if (finalNow < time(at)) return fail("stale");
    const expiredRoot = rootBounds.find((bound) => bound.end <= finalNow);
    if (expiredRoot) return expiredRoot.loss;
    if (time(review["expiresAt"]) <= finalNow)
      return lossOf(
        "storage-review-expired",
        "storage-review",
        review["reviewId"]
      );
    if (time(plan["expiresAt"]) <= finalNow)
      return lossOf("deadline", "plan", plan["planId"]);
    return null;
  };
  // Internal terminal/return-boundary observation of persisted ORIGINAL loss
  // only. A caller's independent read/publish denial is not a global loss and
  // must never roll back an already-proved terminal input closure.
  const observeOriginalAuthorityLossForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ): Promise<Loss | null> => {
    const { plan, review } = await original(tx, scope, responseRequestId);
    if (!(await inventoryFor(tx, scope, plan))) return fail("integrity");
    const loss = await authorityLoss(tx, scope, plan, review, at);
    if (loss)
      await closeAuthorityDomains(
        tx,
        scope,
        responseRequestId,
        loss,
        ctx.now()
      );
    current(at);
    return loss;
  };
  const open = async (
    tx: Transaction,
    input: Input,
    at: string
  ): Promise<boolean> => {
    const { plan, review } = await original(
      tx,
      input.scope,
      input.responseRequestId
    );
    const request = object(input.supplied["request"]);
    if (
      plan["ownerActorId"] !== input.principal.actorId ||
      plan["planId"] !== input.supplied["planId"] ||
      plan["planSha256"] !== input.supplied["planSha256"] ||
      plan["requestSha256"] !==
        (await ctx.hash({
          operation: "requestResponse",
          actorId: input.principal.actorId,
          input: request,
        }))
    )
      return fail("conflict");
    const inventory = await inventoryFor(tx, input.scope, plan);
    if (inventory?.closure || (await domain(tx, input.scope, plan, "inputs")))
      return false;
    const loss = await authorityLoss(tx, input.scope, plan, review, ctx.now());
    if (loss) {
      await closeAuthorityDomains(
        tx,
        input.scope,
        input.responseRequestId,
        loss,
        ctx.now()
      );
      return false;
    }
    current(at);
    return true;
  };
  // Narrow metadata-only observer after a previously committed exact effect.
  // It cannot grant body access or dispatch anything. Entry read grants may have
  // expired during I/O, so closure cannot depend on invoking ctx.run again.
  // Durable effect + immutable owner/request binding is required, not a boolean
  // asserting a former claim. Missing/integrity failures never become a cause.
  const observeAfterIo = async (
    input: Input,
    binding: VertexChatCopyBinding,
    startedAt: string
  ): Promise<boolean> => {
    current(startedAt);
    const result = await db.transaction(
      withTransactionReadScope(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
        );
        if (ctx.commandPolicy)
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", input.scope.accountAlias, input.scope.environment])}, 0))`
          );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", input.scope.accountAlias, input.scope.environment])}, 0))`
        );
        const at = ctx.now();
        current(startedAt);
        const { plan } = await original(
          tx,
          input.scope,
          input.responseRequestId
        );
        if (
          binding.ownerActorId !== input.principal.actorId ||
          binding.responseRequestId !== input.responseRequestId ||
          binding.threadId !== plan["threadId"] ||
          binding.scope.accountAlias !== input.scope.accountAlias ||
          binding.scope.environment !== input.scope.environment
        )
          return fail("integrity");
        const inventory = await inventoryFor(tx, input.scope, plan);
        const entry = inventory?.copies.find(
          (candidate) => candidate.allocation.copyId === binding.copyId
        );
        if (
          !entry?.contentBinding ||
          (await ctx.hash({
            ...entry.allocation.binding,
            content: entry.contentBinding.content,
          })) !== (await ctx.hash(binding))
        )
          return fail("integrity");
        if (
          !(await effect(tx, input.scope, plan, binding, "create", at, false))
        )
          return fail("integrity");
        const visible = await open(tx, input, at);
        current(startedAt);
        return visible;
      })
    );
    current(startedAt);
    return result;
  };
  const bindingFor = (
    inventory: VertexResearchChatCopyInventory,
    purpose: ChatInputPurpose
  ): VertexChatCopyBinding => {
    const entry = inventory.copies.find(
      (candidate) =>
        candidate.allocation.copyIdempotencyKey ===
        (inventory.copies.length === 9
          ? nativeEvidenceCopyKey(purpose)
          : `one-expert-${purpose}-v1`)
    );
    if (!entry?.contentBinding) return fail("integrity");
    return snapshotVertexChatCopyBinding({
      ...entry.allocation.binding,
      content: entry.contentBinding.content,
    });
  };
  const bindingHash = async (
    binding: VertexChatCopyBinding
  ): Promise<string> => {
    const { content, ...base } = binding;
    return await ctx.hash(base);
  };
  const checkedEffect = async (
    row: VertexRecord | null,
    stable: VertexRecord,
    plan: VertexRecord,
    at: string
  ) => {
    if (!row) return null;
    const value = object(row["payload"]),
      { intentCommittedAt, ...rest } = value;
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      (await ctx.hash(rest)) !== (await ctx.hash(stable)) ||
      row["plan_sha256"] !== plan["planSha256"] ||
      row["binding_sha256"] !== stable["bindingSha256"] ||
      row["intent_committed_at_ns"] !== time(intentCommittedAt).toString()
    )
      return fail("integrity");
    if (time(intentCommittedAt) > time(at)) return fail("stale");
    return { fresh: false, value };
  };
  const effect = async (
    tx: Transaction,
    scope: Scope,
    plan: VertexRecord,
    binding: VertexChatCopyBinding,
    operation: "create" | "fence",
    at: string,
    create: boolean
  ) => {
    const row = await one(
      tx,
      effectsTable,
      scope,
      sql`response_request_id = ${binding.responseRequestId} and copy_id = ${binding.copyId} and operation = ${operation}`
    );
    const stable = {
      profile: "vertex-research-chat-copy-effect-v1",
      scope,
      responseRequestId: binding.responseRequestId,
      copyId: binding.copyId,
      planSha256: plan["planSha256"],
      operation,
      bindingSha256: await bindingHash(binding),
      content: binding.content,
    };
    if (row) return checkedEffect(row, stable, plan, at);
    if (!create) return null;
    const value = { ...stable, intentCommittedAt: at };
    await save(tx, effectsTable, scope, value, {
      response_request_id: binding.responseRequestId,
      copy_id: binding.copyId,
      operation,
      plan_sha256: plan["planSha256"],
      binding_sha256: stable.bindingSha256,
      intent_committed_at_ns: time(at).toString(),
    });
    return { fresh: true, value };
  };
  const checkedProof = async (
    binding: VertexChatCopyBinding,
    proof: VertexChatCopyProof,
    state: "live" | "fenced",
    at: string
  ): Promise<VertexChatCopyProof> => {
    const p = ctx.capture(proof),
      hash = await bindingHash(binding);
    const marker = ctx.encode({
      profile: VERTEX_CHAT_COPY_FENCE_PROFILE,
      bindingSha256: hash,
    });
    const content =
      state === "live"
        ? binding.content
        : { sha256: await ctx.digest(marker), byteLength: marker.byteLength };
    if (
      !content ||
      Object.keys(p).sort().join() !==
        [
          "key",
          "state",
          "bindingSha256",
          "reservationSha256",
          "storageProfileSha256",
          "sha256",
          "byteLength",
          "etag",
          "version",
          "uploadedAt",
        ]
          .sort()
          .join() ||
      p.key !== vertexChatCopyKey(binding) ||
      p.state !== state ||
      p.bindingSha256 !== hash ||
      p.reservationSha256 !== binding.reservationSha256 ||
      p.storageProfileSha256 !== binding.storageProfileSha256 ||
      p.sha256 !== content.sha256 ||
      p.byteLength !== content.byteLength ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(p.etag) ||
      !/^[\x21-\x7e]{1,256}$/.test(p.version) ||
      time(p.uploadedAt) > time(at)
    )
      return fail("integrity");
    return p;
  };
  const observe = async (
    tx: Transaction,
    plan: VertexRecord,
    binding: VertexChatCopyBinding,
    operation: "create" | "fence",
    proof: VertexChatCopyProof,
    at: string
  ): Promise<void> => {
    const scope = binding.scope;
    const prior = await one(
      tx,
      observationsTable,
      scope,
      sql`response_request_id = ${binding.responseRequestId} and copy_id = ${binding.copyId} and operation = ${operation}`
    );
    if (prior) {
      const value = object(prior["payload"]);
      if (
        (await ctx.hash(value)) !== prior["record_hash"] ||
        value["planSha256"] !== plan["planSha256"] ||
        value["copyId"] !== binding.copyId ||
        value["operation"] !== operation ||
        (await ctx.hash(value["proof"])) !== (await ctx.hash(proof))
      )
        return fail("integrity");
      return;
    }
    const value = {
      profile: "vertex-research-chat-copy-effect-observation-v1",
      scope,
      responseRequestId: binding.responseRequestId,
      copyId: binding.copyId,
      planSha256: plan["planSha256"],
      operation,
      proof,
      observedAt: at,
    };
    await save(tx, observationsTable, scope, value, {
      response_request_id: binding.responseRequestId,
      copy_id: binding.copyId,
      operation,
      observed_at_ns: time(at).toString(),
    });
  };
  const transact = <T>(
    input: Input,
    operation: (tx: Transaction, at: string) => Promise<T>
  ): Promise<T> =>
    ctx.run(
      input.principal,
      input.scope,
      null,
      "research-chat",
      "read",
      operation,
      true
    );
  const claim = async (
    input: Input,
    purpose: ChatInputPurpose,
    create: boolean
  ) =>
    transact(input, async (tx, at) => {
      const joined = await currentJoin(tx, input, at);
      if (!joined) return null;
      const inventory = create
        ? await metadata.reserveApprovedInputsForTransaction(
            tx,
            joined.plan,
            joined.approval,
            ctx.now()
          )
        : await inventoryFor(tx, input.scope, joined.plan);
      if (!inventory) return fail("unavailable");
      const binding = bindingFor(inventory, purpose);
      const intent = await effect(
        tx,
        input.scope,
        joined.plan,
        binding,
        "create",
        ctx.now(),
        create
      );
      if (!intent) return fail("unavailable");
      // All SQL writes finish BEFORE the last original authority join. Transaction
      // return is still not commit; only its successfully resolved caller dispatches.
      const after = await currentJoin(tx, input, ctx.now());
      if (!after) return null;
      current(at, joined.expiresAt, after.expiresAt);
      return {
        binding,
        fresh: intent.fresh,
        bytes: new Uint8Array(preparedBytes(after.prepared, purpose)),
        expiresAt: after.expiresAt,
        startedAt: at,
      };
    });
  const safeRead = async (
    binding: VertexChatCopyBinding
  ): Promise<VertexChatCopyRead> => {
    try {
      return await capabilities.readCopy(binding);
    } catch {
      return { status: "unavailable", reason: "backend" };
    }
  };
  const currentJoin = async (
    tx: Transaction,
    input: Input,
    at: string
  ): Promise<ChatApprovedInputs | null> => {
    if (!(await open(tx, input, at))) return null;
    try {
      return await execution.readApprovedForTransaction(
        tx,
        input.principal,
        input.supplied,
        at,
        input.sourceInputs
      );
    } catch (error) {
      // A deadline crossed inside the join must commit its closure, not throw
      // inside this transaction and silently roll cleanup back.
      if (!(await open(tx, input, at))) return null;
      throw error;
    }
  };
  const settle = async (
    input: Input,
    purpose: ChatInputPurpose,
    binding: VertexChatCopyBinding,
    external: VertexChatCopyRead,
    wantBytes: boolean
  ) => {
    if (!(await observeAfterIo(input, binding, ctx.now())))
      return { status: "closed" as const, expiresAt: null, bytes: null };
    const startedAt = ctx.now();
    const result = await transact(input, async (tx, at) => {
      const joined = await currentJoin(tx, input, at);
      if (!joined)
        return { status: "closed" as const, expiresAt: null, bytes: null };
      const inventory = await inventoryFor(tx, input.scope, joined.plan);
      if (
        !inventory ||
        (await ctx.hash(bindingFor(inventory, purpose))) !==
          (await ctx.hash(binding)) ||
        !(await effect(
          tx,
          input.scope,
          joined.plan,
          binding,
          "create",
          at,
          false
        ))
      )
        return fail("integrity");
      if (external.status === "fenced") {
        await checkedProof(binding, external.proof, "fenced", ctx.now());
        await closeDomain(
          tx,
          input.scope,
          input.responseRequestId,
          "inputs",
          lossOf("storage-fenced", "storage-fence", binding.copyId),
          ctx.now()
        );
        return { status: "closed" as const, expiresAt: null, bytes: null };
      }
      if (external.status === "invalid") return fail("integrity");
      if (external.status === "conflict") return fail("conflict");
      if (external.status !== "live") {
        current(at, joined.expiresAt);
        return {
          status: "unknown" as const,
          expiresAt: joined.expiresAt,
          bytes: null,
        };
      }
      const bytes = new Uint8Array(external.bytes),
        proof = await checkedProof(binding, external.proof, "live", ctx.now());
      if (
        bytes.byteLength !== binding.content?.byteLength ||
        (await ctx.digest(bytes)) !== binding.content.sha256 ||
        (await ctx.digest(preparedBytes(joined.prepared, purpose))) !==
          binding.content.sha256
      )
        return fail("integrity");
      await observe(tx, joined.plan, binding, "create", proof, ctx.now());
      const after = await currentJoin(tx, input, ctx.now());
      if (!after)
        return { status: "closed" as const, expiresAt: null, bytes: null };
      current(at, joined.expiresAt, after.expiresAt);
      return {
        status: "live" as const,
        expiresAt: after.expiresAt,
        bytes: wantBytes ? bytes : null,
      };
    });
    if (result.expiresAt) current(startedAt, result.expiresAt);
    return result;
  };
  const withSourceInputs = async <T>(
    principal: VertexPrincipal,
    supplied: unknown,
    purpose: string,
    operation: (inputs?: ResearchChatSourceInputs) => Promise<T>
  ): Promise<T> => {
    if (execution.withSourceInputs)
      return await execution.withSourceInputs(
        principal,
        supplied,
        purpose,
        operation
      );
    if (options.debate) return fail("unavailable");
    return await operation();
  };
  const inputsWithSources = async (
    principal: VertexPrincipal,
    supplied: unknown,
    create: boolean,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<readonly Summary[]> => {
    const input = {
        ...(await prepare(principal, supplied)),
        ...(sourceInputs ? { sourceInputs } : {}),
      },
      result: Summary[] = [];
    const selectedPurposes = await transact(input, async (tx, at) => {
      const joined = await currentJoin(tx, input, at);
      if (!joined) return fail("denied");
      return initialPurposesFor(joined.plan);
    });
    for (const purpose of selectedPurposes) {
      const selected = await claim(input, purpose, create);
      if (!selected) return fail("denied");
      try {
        current(selected.startedAt, selected.expiresAt);
        // Unknown/throw inspects the SAME binding first. Missing proves nothing
        // about the original call. A live proof still requires exact bytes.
        let observed: VertexChatCopyCreation | VertexChatCopyInspection;
        if (selected.fresh) {
          try {
            observed = await capabilities.createCopy(
              selected.binding,
              selected.bytes
            );
          } catch {
            observed = { status: "unknown" };
          }
          if (
            !(await observeAfterIo(input, selected.binding, selected.startedAt))
          )
            return fail("denied");
          if (
            observed.status === "unknown" ||
            observed.status === "unavailable"
          ) {
            try {
              observed = await capabilities.inspectCopy(selected.binding);
            } catch {
              observed = { status: "unavailable", reason: "backend" };
            }
          }
        } else {
          try {
            observed = await capabilities.inspectCopy(selected.binding);
          } catch {
            observed = { status: "unavailable", reason: "backend" };
          }
        }
        if (
          !(await observeAfterIo(input, selected.binding, selected.startedAt))
        )
          return fail("denied");
        if (observed.status !== "live") {
          const value = await settle(
            input,
            purpose,
            selected.binding,
            observed as VertexChatCopyRead,
            false
          );
          result.push({
            purpose,
            copyId: selected.binding.copyId,
            status: value.status,
          });
          continue;
        }
        await checkedProof(selected.binding, observed.proof, "live", ctx.now());
        const beforeRead = await claim(input, purpose, false);
        if (!beforeRead) return fail("denied");
        beforeRead.bytes.fill(0);
        current(selected.startedAt, selected.expiresAt, beforeRead.expiresAt);
        const value = await settle(
          input,
          purpose,
          selected.binding,
          await safeRead(selected.binding),
          false
        );
        result.push({
          purpose,
          copyId: selected.binding.copyId,
          status: value.status,
        });
      } finally {
        selected.bytes.fill(0);
      }
    }
    if (
      selectedPurposes.length === 4 &&
      result.every((entry) => entry.status === "live")
    )
      await transact(input, async (tx, at) => {
        const joined = await readCurrentOriginalForTransaction(
          tx,
          input.scope,
          input.responseRequestId,
          at
        );
        if (!joined) return fail("denied");
        await phases.persist(
          tx,
          input.scope,
          joined.plan,
          joined.inventory,
          1,
          null,
          at
        );
        const after = await currentJoin(tx, input, ctx.now());
        if (!after) return fail("denied");
        return current(at, after.expiresAt);
      });
    return result;
  };
  const inputs = (
    principal: VertexPrincipal,
    supplied: unknown,
    create: boolean
  ) => {
    return withSourceInputs(
      principal,
      supplied,
      create ? "copy-write" : "copy-reconcile",
      (sourceInputs) =>
        inputsWithSources(principal, supplied, create, sourceInputs)
    );
  };
  const readApprovedWithSources = async (
    principal: VertexPrincipal,
    supplied: unknown,
    purpose: ChatInputPurpose,
    sourceInputs?: ResearchChatSourceInputs
  ): Promise<Uint8Array> => {
    if (!(nativeInitialPurposes as readonly string[]).includes(purpose))
      return fail("invalid");
    const input = {
        ...(await prepare(principal, supplied)),
        ...(sourceInputs ? { sourceInputs } : {}),
      },
      selected = await claim(input, purpose, false);
    if (!selected) return fail("denied");
    selected.bytes.fill(0);
    current(selected.startedAt, selected.expiresAt);
    let inspection: VertexChatCopyInspection;
    try {
      inspection = await capabilities.inspectCopy(selected.binding);
    } catch {
      inspection = { status: "unavailable", reason: "backend" };
    }
    if (!(await observeAfterIo(input, selected.binding, selected.startedAt)))
      return fail("denied");
    if (inspection.status !== "live") {
      await settle(
        input,
        purpose,
        selected.binding,
        inspection as VertexChatCopyRead,
        false
      );
      return fail("denied");
    }
    await checkedProof(selected.binding, inspection.proof, "live", ctx.now());
    const beforeRead = await claim(input, purpose, false);
    if (!beforeRead) return fail("denied");
    beforeRead.bytes.fill(0);
    current(selected.startedAt, selected.expiresAt, beforeRead.expiresAt);
    const result = await settle(
      input,
      purpose,
      selected.binding,
      await safeRead(selected.binding),
      true
    );
    current(
      selected.startedAt,
      ...(result.expiresAt ? [result.expiresAt] : [])
    );
    if (result.status !== "live" || !result.bytes) return fail("denied");
    return result.bytes;
  };
  const readApprovedInput = (
    principal: VertexPrincipal,
    supplied: unknown,
    purpose: ChatInputPurpose,
    borrowedSources?: ResearchChatSourceInputs
  ): Promise<Uint8Array> => {
    return borrowedSources
      ? readApprovedWithSources(principal, supplied, purpose, borrowedSources)
      : withSourceInputs(principal, supplied, "copy-read", (sourceInputs) =>
          readApprovedWithSources(principal, supplied, purpose, sourceInputs)
        );
  };
  const cleanupInput = async (rawPrincipal: VertexPrincipal, raw: unknown) => {
    const principal = ctx.capture(rawPrincipal),
      captured = ctx.capture(raw);
    const selector = ctx.capture(await options.validate("selector", captured));
    if ((await ctx.hash(selector)) !== (await ctx.hash(captured)))
      return fail("invalid");
    const scope: Scope = {
      accountAlias: identifier(selector["accountAlias"]),
      environment: "research",
    };
    return {
      principal,
      scope,
      selector,
      responseRequestId: identifier(selector["responseRequestId"]),
    };
  };
  const cleanupTransaction = async <T>(
    input: Awaited<ReturnType<typeof cleanupInput>>,
    operation: (tx: Transaction, plan: VertexRecord, at: string) => Promise<T>
  ): Promise<T> => {
    const resource = `research-chat-copies:${input.responseRequestId}`;
    const result = await ctx.run(
      input.principal,
      input.scope,
      null,
      resource,
      "cleanup-chat-copies",
      async (tx, at) => {
        const { plan } = await original(
          tx,
          input.scope,
          input.responseRequestId
        );
        if (plan["threadId"] !== input.selector["threadId"])
          return fail("denied");
        const value = await operation(tx, plan, at);
        await ctx.authorize(
          input.principal,
          input.scope,
          null,
          resource,
          "cleanup-chat-copies",
          ctx.now()
        );
        const found = await rows(
          tx,
          sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version where b.account_alias = ${input.scope.accountAlias} and b.environment = ${input.scope.environment} and b.grantee_actor_id = ${input.principal.actorId} and b.collection_key = '' and b.resource_id = ${resource} limit 129`
        );
        if (found.length > 128) return fail("denied");
        let expiresAt: string | null = null;
        for (const row of found) {
          const grant = object(row["payload"]);
          if ((await ctx.hash(grant)) !== row["record_hash"])
            return fail("integrity");
          if (
            grant["version"] === row["current_version"] &&
            grant["revision"] === row["revision"] &&
            grant["granteeActorId"] === input.principal.actorId &&
            (await ctx.hash(grant["scope"])) ===
              (await ctx.hash(input.scope)) &&
            grant["collectionId"] === null &&
            grant["resourceId"] === resource &&
            grant["status"] === "granted" &&
            Array.isArray(grant["actions"]) &&
            grant["actions"].includes("cleanup-chat-copies") &&
            time(grant["recordedAt"]) <= time(at) &&
            time(grant["validFrom"]) <= time(at) &&
            time(grant["expiresAt"]) > time(ctx.now())
          )
            expiresAt = string(grant["expiresAt"]);
        }
        if (!expiresAt) return fail("denied");
        current(at, expiresAt);
        return { value, at, expiresAt };
      },
      true
    );
    current(result.at, result.expiresAt);
    return result.value;
  };
  const closeApprovedInputs = async (
    principal: VertexPrincipal,
    supplied: unknown
  ) => {
    const input = await cleanupInput(principal, supplied);
    return cleanupTransaction(input, async (tx, _plan, at) => {
      const value = await closeResponseAttemptInputsForTransaction(
        tx,
        input.scope,
        input.responseRequestId,
        "explicit",
        at
      );
      await ctx.authorize(
        input.principal,
        input.scope,
        null,
        `research-chat-copies:${input.responseRequestId}`,
        "cleanup-chat-copies",
        ctx.now()
      );
      current(at);
      return value;
    });
  };
  const drainApprovedCopyCleanup = async (
    principal: VertexPrincipal,
    supplied: unknown
  ) => {
    const input = await cleanupInput(principal, supplied);
    const targets = await cleanupTransaction(input, async (tx, plan, at) => {
      const { review } = await original(
        tx,
        input.scope,
        input.responseRequestId
      );
      const loss = await authorityLoss(
        tx,
        input.scope,
        plan,
        review,
        ctx.now()
      );
      if (loss)
        await closeAuthorityDomains(
          tx,
          input.scope,
          input.responseRequestId,
          loss,
          ctx.now()
        );
      const inventory = await inventoryFor(tx, input.scope, plan);
      if (!inventory) return [];
      const inputsClosed = await domain(tx, input.scope, plan, "inputs"),
        derivedClosed = await domain(tx, input.scope, plan, "derived");
      current(at);
      return inventory.copies
        .filter(
          (entry) =>
            inventory.closure ||
            (entry.allocation.kind === "derived-output"
              ? derivedClosed
              : inputsClosed)
        )
        .map((entry) =>
          snapshotVertexChatCopyBinding({
            ...entry.allocation.binding,
            content: entry.contentBinding?.content ?? null,
          })
        );
    });
    const result: Readonly<{ copyId: string; status: "fenced" | "unknown" }>[] =
      [];
    for (const binding of targets) {
      const intent = await cleanupTransaction(input, async (tx, plan, at) => {
        const value = await effect(
          tx,
          input.scope,
          plan,
          binding,
          "fence",
          at,
          true
        );
        await ctx.authorize(
          input.principal,
          input.scope,
          null,
          `research-chat-copies:${input.responseRequestId}`,
          "cleanup-chat-copies",
          ctx.now()
        );
        current(at);
        return requirePresent(value, "value");
      });
      let external: VertexChatCopyFence | VertexChatCopyInspection;
      try {
        external = intent.fresh
          ? await capabilities.fenceCopy(binding)
          : await capabilities.inspectCopy(binding);
      } catch {
        external = { status: "unknown" };
      }
      const status = await cleanupTransaction(input, async (tx, plan, at) => {
        if (!(await effect(tx, input.scope, plan, binding, "fence", at, false)))
          return fail("integrity");
        if (external.status === "invalid") return fail("integrity");
        if (external.status === "conflict") return fail("conflict");
        if (external.status === "fenced")
          await observe(
            tx,
            plan,
            binding,
            "fence",
            await checkedProof(binding, external.proof, "fenced", ctx.now()),
            ctx.now()
          );
        await ctx.authorize(
          input.principal,
          input.scope,
          null,
          `research-chat-copies:${input.responseRequestId}`,
          "cleanup-chat-copies",
          ctx.now()
        );
        current(at);
        return external.status === "fenced"
          ? ("fenced" as const)
          : ("unknown" as const);
      });
      result.push({ copyId: binding.copyId, status });
    }
    return result;
  };
  // Untrusted historical rows only: the caller retains every current authority,
  // reconstruction and clock boundary. Existing concrete owners hold the scope
  // lock and historical effects/observations are insert-only under that lock.
  const historicalProofPairs = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    bindings: readonly VertexChatCopyBinding[]
  ) => {
    if (
      bindings.length !== 3 ||
      new Set(bindings.map((binding) => binding.copyId)).size !== 3
    )
      return fail("integrity");
    const found = await rows(
      tx,
      sql`select expected.ordinal, expected.purpose, expected.copy_id, to_jsonb(e) || jsonb_build_object('intent_committed_at_ns', e.intent_committed_at_ns::text) as effect_row, to_jsonb(o) as observation_row from (values (0, 'context', ${requirePresent(bindings[0], "bindings[0]").copyId}), (1, 'tokenizeInput', ${requirePresent(bindings[1], "bindings[1]").copyId}), (2, 'completionInput', ${requirePresent(bindings[2], "bindings[2]").copyId})) as expected(ordinal, purpose, copy_id) left join vertex_research_chat_copy_effects e on e.account_alias = ${scope.accountAlias} and e.environment = ${scope.environment} and e.response_request_id = ${responseRequestId} and e.copy_id = expected.copy_id and e.operation = 'create' left join vertex_research_chat_copy_effect_observations o on o.account_alias = ${scope.accountAlias} and o.environment = ${scope.environment} and o.response_request_id = ${responseRequestId} and o.copy_id = expected.copy_id and o.operation = 'create' order by expected.ordinal limit 4`
    );
    if (found.length !== 3) return fail("integrity");
    return found;
  };
  const historicalRow = (
    raw: unknown,
    scope: Scope,
    responseRequestId: string,
    copyId: string
  ): VertexRecord | null => {
    if (raw === null) return null;
    const row = object(raw);
    if (
      row["account_alias"] !== scope.accountAlias ||
      row["environment"] !== scope.environment ||
      row["response_request_id"] !== responseRequestId ||
      row["copy_id"] !== copyId ||
      row["operation"] !== "create"
    )
      return fail("integrity");
    return row;
  };
  // Internal worker continuation. Only persisted original metadata selects a
  // family; no caller query, capability, reconstructed approval or allow flag.
  // A null result must be returned through the surrounding transaction so
  // authoritative-loss closures commit BEFORE the caller reports denial.
  const currentOriginalForDomain = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string,
    selectedDomain: Domain
  ) => {
    const { plan, review } = await original(tx, scope, responseRequestId);
    const inventory = await inventoryFor(tx, scope, plan);
    if (
      !inventory ||
      inventory.closure ||
      (await domain(tx, scope, plan, selectedDomain))
    )
      return null;
    const loss = await authorityLoss(tx, scope, plan, review, ctx.now());
    if (loss) {
      await closeAuthorityDomains(
        tx,
        scope,
        responseRequestId,
        loss,
        ctx.now()
      );
      return null;
    }
    if (!execution.readCurrentOriginalForTransaction)
      return fail("unavailable");
    let joined: Awaited<
      ReturnType<typeof execution.readCurrentOriginalForTransaction>
    >;
    try {
      joined = await execution.readCurrentOriginalForTransaction(
        tx,
        scope,
        responseRequestId,
        at
      );
    } catch (error) {
      const lost = await authorityLoss(tx, scope, plan, review, ctx.now());
      if (lost) {
        await closeAuthorityDomains(
          tx,
          scope,
          responseRequestId,
          lost,
          ctx.now()
        );
        return null;
      }
      throw error;
    }
    const selectedPurposes = initialPurposesFor(plan);
    const bindings = selectedPurposes.map((purpose) =>
      bindingFor(inventory, purpose)
    );
    let pairs: VertexRecord[] | undefined;
    for (const [ordinal, purpose] of selectedPurposes.entries()) {
      const binding = requirePresent(bindings[ordinal], "bindings[ordinal]"),
        effectAt = ctx.now();
      // Lazy first fetch retains the legacy pre-SELECT effect clock sample.
      // Later samples remain after the preceding checkedProof, never parallel.
      if (!pairs) {
        if (isNativeEvidencePlan(plan)) {
          pairs = [];
          for (const [index, candidate] of bindings.entries())
            pairs.push({
              ordinal: index,
              purpose: selectedPurposes[index],
              copy_id: candidate.copyId,
              effect_row: await one(
                tx,
                effectsTable,
                scope,
                sql`response_request_id = ${responseRequestId} and copy_id = ${candidate.copyId} and operation = 'create'`
              ),
              observation_row: await one(
                tx,
                observationsTable,
                scope,
                sql`response_request_id = ${responseRequestId} and copy_id = ${candidate.copyId} and operation = 'create'`
              ),
            });
        } else {
          pairs = await historicalProofPairs(
            tx,
            scope,
            responseRequestId,
            bindings
          );
        }
      }
      const pair = requirePresent(pairs[ordinal], "pairs[ordinal]");
      if (
        pair["ordinal"] !== ordinal ||
        pair["purpose"] !== purpose ||
        pair["copy_id"] !== binding.copyId
      )
        return fail("integrity");
      const row = historicalRow(
        pair["effect_row"],
        scope,
        responseRequestId,
        binding.copyId
      );
      const stable = {
        profile: "vertex-research-chat-copy-effect-v1",
        scope,
        responseRequestId: binding.responseRequestId,
        copyId: binding.copyId,
        planSha256: plan["planSha256"],
        operation: "create",
        bindingSha256: await bindingHash(binding),
        content: binding.content,
      };
      if (!(await checkedEffect(row, stable, plan, effectAt)))
        return fail("unavailable");
      const observed = historicalRow(
        pair["observation_row"],
        scope,
        responseRequestId,
        binding.copyId
      );
      if (!observed) return fail("unavailable");
      const value = object(observed["payload"]);
      if (
        (await ctx.hash(value)) !== observed["record_hash"] ||
        value["planSha256"] !== plan["planSha256"] ||
        value["copyId"] !== binding.copyId ||
        value["operation"] !== "create"
      )
        return fail("integrity");
      await checkedProof(
        binding,
        value["proof"] as VertexChatCopyProof,
        "live",
        ctx.now()
      );
    }
    const finalLoss = await authorityLoss(tx, scope, plan, review, ctx.now());
    if (finalLoss) {
      await closeAuthorityDomains(
        tx,
        scope,
        responseRequestId,
        finalLoss,
        ctx.now()
      );
      return null;
    }
    current(at, joined.expiresAt);
    return { ...joined, inventory };
  };
  const readCurrentOriginalForTransaction = (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => currentOriginalForDomain(tx, scope, responseRequestId, at, "inputs");
  // Terminal input fences are historical parent provenance, not a derived read
  // grant. All original plan/storage/owner/rights/review deadlines stay in force.
  const readCurrentDerivedForTransaction = (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => currentOriginalForDomain(tx, scope, responseRequestId, at, "derived");
  const readHistoricalOriginalForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string
  ) => {
    const historical = await original(tx, scope, responseRequestId);
    const inventory = await inventoryFor(tx, scope, historical.plan);
    if (!inventory) return fail("integrity");
    return { ...historical, inventory };
  };
  const nativeLiveForTransaction = async (
    tx: Transaction,
    scope: Scope,
    plan: VertexRecord,
    inventory: VertexResearchChatCopyInventory,
    purpose: ChatInputPurpose,
    at: string
  ): Promise<void> => {
    const binding = bindingFor(inventory, purpose);
    if (!(await effect(tx, scope, plan, binding, "create", at, false)))
      return fail("unavailable");
    const row = await one(
      tx,
      observationsTable,
      scope,
      sql`response_request_id = ${plan["responseRequestId"]} and copy_id = ${binding.copyId} and operation = 'create'`
    );
    if (!row) return fail("unavailable");
    const value = object(row["payload"]);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      value["planSha256"] !== plan["planSha256"] ||
      value["responseRequestId"] !== plan["responseRequestId"] ||
      value["copyId"] !== binding.copyId ||
      value["operation"] !== "create" ||
      time(value["observedAt"]) > time(at)
    )
      return fail("integrity");
    await checkedProof(
      binding,
      value["proof"] as VertexChatCopyProof,
      "live",
      at
    );
  };
  const readNativePhaseForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    phaseOrdinal: 1 | 2,
    at: string
  ) => {
    if (phaseOrdinal !== 1 && phaseOrdinal !== 2) return fail("invalid");
    const joined = await readCurrentOriginalForTransaction(
      tx,
      scope,
      responseRequestId,
      at
    );
    if (!(joined && isNativeEvidencePlan(joined.plan))) return null;
    const phase = await phases.read(
      tx,
      scope,
      joined.plan,
      joined.inventory,
      phaseOrdinal,
      at
    );
    if (!phase) return null;
    if (phaseOrdinal === 2)
      for (const purpose of nativeIntermediatePurposes)
        await nativeLiveForTransaction(
          tx,
          scope,
          joined.plan,
          joined.inventory,
          purpose,
          ctx.now()
        );
    const after = await readCurrentOriginalForTransaction(
      tx,
      scope,
      responseRequestId,
      ctx.now()
    );
    if (!after) return null;
    current(at, joined.expiresAt, after.expiresAt);
    return phase;
  };
  // Internal only: the concrete API has verified completion-one dispatch/audits
  // and independently derived these bytes. No worker-supplied allow flag exists.
  // Each fresh conditional effect is committed before I/O; replay inspects and
  // never retries an unknown create. Sensitive buffers never enter SQL payloads.
  const materializeNativeEvidencePhaseTwo = async (
    scope: Scope,
    responseRequestId: string,
    supplied: NativeEvidencePhaseTwoInput
  ) => {
    const startedAt = ctx.now(),
      derivation = ctx.capture(supplied.derivation);
    const content = Object.fromEntries(
      nativeIntermediatePurposes.map((purpose) => [
        purpose,
        new Uint8Array(supplied[purpose]),
      ])
    ) as Record<(typeof nativeIntermediatePurposes)[number], Uint8Array>;
    try {
      const pins: Record<
        string,
        Readonly<{ sha256: string; byteLength: number }>
      > = {};
      for (const purpose of nativeIntermediatePurposes) {
        if (
          !content[purpose].byteLength ||
          content[purpose].byteLength > 262_144
        )
          return fail("invalid");
        pins[purpose] = {
          sha256: await ctx.digest(content[purpose]),
          byteLength: content[purpose].byteLength,
        };
      }
      const phase = await advisoryLock(scope, async (tx, at) => {
        const joined = await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          at
        );
        if (!(joined && isNativeEvidencePlan(joined.plan))) return null;
        if (
          !(await phases.read(tx, scope, joined.plan, joined.inventory, 1, at))
        )
          return fail("denied");
        for (const purpose of nativeIntermediatePurposes)
          await metadata.bindNativeContentForTransaction(
            tx,
            joined.plan,
            purpose,
            pins[purpose],
            at
          );
        const inventory = await inventoryFor(tx, scope, joined.plan);
        if (!inventory) return fail("integrity");
        const value = await phases.persist(
          tx,
          scope,
          joined.plan,
          inventory,
          2,
          derivation,
          at
        );
        const after = await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
        if (!after) return null;
        current(startedAt, joined.expiresAt, after.expiresAt);
        return value;
      });
      if (!phase) return fail("denied");
      for (const purpose of nativeIntermediatePurposes) {
        const selected = await advisoryLock(scope, async (tx, at) => {
          const joined = await readCurrentOriginalForTransaction(
            tx,
            scope,
            responseRequestId,
            at
          );
          if (!joined) return null;
          const stored = await phases.read(
            tx,
            scope,
            joined.plan,
            joined.inventory,
            2,
            at
          );
          if (!stored || stored.phaseSha256 !== phase.phaseSha256)
            return fail("integrity");
          const binding = bindingFor(joined.inventory, purpose);
          if (
            (await ctx.hash(binding.content)) !==
            (await ctx.hash(pins[purpose]))
          )
            return fail("conflict");
          const intent = await effect(
            tx,
            scope,
            joined.plan,
            binding,
            "create",
            at,
            true
          );
          if (!intent) return fail("integrity");
          const after = await readCurrentOriginalForTransaction(
            tx,
            scope,
            responseRequestId,
            ctx.now()
          );
          if (!after) return null;
          current(startedAt, joined.expiresAt, after.expiresAt);
          return { binding, fresh: intent.fresh, expiresAt: after.expiresAt };
        });
        if (!selected) return fail("denied");
        const rejoin = () =>
          advisoryLock(scope, async (tx, at) => {
            const joined = await readCurrentOriginalForTransaction(
              tx,
              scope,
              responseRequestId,
              at
            );
            if (!joined) return false;
            if (
              (await ctx.hash(bindingFor(joined.inventory, purpose))) !==
                (await ctx.hash(selected.binding)) ||
              !(await effect(
                tx,
                scope,
                joined.plan,
                selected.binding,
                "create",
                at,
                false
              ))
            )
              return fail("integrity");
            current(startedAt, selected.expiresAt, joined.expiresAt);
            return true;
          });
        if (!(await rejoin())) return fail("denied");
        let observed: VertexChatCopyCreation | VertexChatCopyInspection;
        if (selected.fresh) {
          try {
            observed = await capabilities.createCopy(
              selected.binding,
              content[purpose]
            );
          } catch {
            observed = { status: "unknown" };
          }
          if (!(await rejoin())) return fail("denied");
          if (
            observed.status === "unknown" ||
            observed.status === "unavailable"
          ) {
            try {
              observed = await capabilities.inspectCopy(selected.binding);
            } catch {
              observed = { status: "unavailable", reason: "backend" };
            }
          }
        } else {
          try {
            observed = await capabilities.inspectCopy(selected.binding);
          } catch {
            observed = { status: "unavailable", reason: "backend" };
          }
        }
        if (!(await rejoin())) return fail("denied");
        if (observed.status === "live")
          await checkedProof(
            selected.binding,
            observed.proof,
            "live",
            ctx.now()
          );
        const external =
          observed.status === "live"
            ? await safeRead(selected.binding)
            : (observed as VertexChatCopyRead);
        try {
          const live = await advisoryLock(scope, async (tx, at) => {
            const joined = await readCurrentOriginalForTransaction(
              tx,
              scope,
              responseRequestId,
              at
            );
            if (!joined) return false;
            if (
              (await ctx.hash(bindingFor(joined.inventory, purpose))) !==
                (await ctx.hash(selected.binding)) ||
              !(await effect(
                tx,
                scope,
                joined.plan,
                selected.binding,
                "create",
                at,
                false
              ))
            )
              return fail("integrity");
            if (external.status === "fenced") {
              await checkedProof(
                selected.binding,
                external.proof,
                "fenced",
                at
              );
              await closeDomain(
                tx,
                scope,
                responseRequestId,
                "inputs",
                lossOf(
                  "storage-fenced",
                  "storage-fence",
                  selected.binding.copyId
                ),
                at
              );
              return false;
            }
            if (external.status !== "live")
              return fail(
                external.status === "conflict"
                  ? "conflict"
                  : external.status === "invalid"
                    ? "integrity"
                    : "unavailable"
              );
            if (
              external.bytes.byteLength !==
                requirePresent(pins[purpose], "pins[purpose]").byteLength ||
              (await ctx.digest(external.bytes)) !==
                requirePresent(pins[purpose], "pins[purpose]").sha256
            )
              return fail("integrity");
            await observe(
              tx,
              joined.plan,
              selected.binding,
              "create",
              await checkedProof(selected.binding, external.proof, "live", at),
              at
            );
            const after = await readCurrentOriginalForTransaction(
              tx,
              scope,
              responseRequestId,
              ctx.now()
            );
            if (!after) return false;
            current(startedAt, selected.expiresAt, after.expiresAt);
            return true;
          });
          if (!live) return fail("denied");
        } finally {
          if (external.status === "live") external.bytes.fill(0);
        }
      }
      const result = await advisoryLock(scope, (tx, at) =>
        readNativePhaseForTransaction(tx, scope, responseRequestId, 2, at)
      );
      if (!result || result.phaseSha256 !== phase.phaseSha256)
        return fail("denied");
      current(startedAt, result.expiresAt);
      return result;
    } finally {
      for (const value of Object.values(content)) value.fill(0);
    }
  };
  const readOriginalInput = async (
    scope: Scope,
    responseRequestId: string,
    purpose: ChatInputPurpose
  ): Promise<Uint8Array> => {
    if (
      !(nativeEvidenceCopyPurposes as readonly string[]).includes(purpose) ||
      purpose === ("advisory" as string)
    )
      return fail("invalid");
    const startedAt = ctx.now();
    const locked = async <T>(
      operation: (tx: Transaction) => Promise<T>
    ): Promise<T> =>
      db.transaction(
        withTransactionReadScope(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
          );
          if (ctx.commandPolicy)
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
            );
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
          );
          current(startedAt);
          return operation(tx);
        })
      );
    const first = await locked(async (tx) => {
      const joined = await readCurrentOriginalForTransaction(
        tx,
        scope,
        responseRequestId,
        ctx.now()
      );
      if (joined && isNativeEvidencePlan(joined.plan))
        await nativeLiveForTransaction(
          tx,
          scope,
          joined.plan,
          joined.inventory,
          purpose,
          ctx.now()
        );
      return joined
        ? {
            binding: bindingFor(joined.inventory, purpose),
            expiresAt: joined.expiresAt,
          }
        : null;
    });
    if (!first) return fail("denied");
    current(startedAt, first.expiresAt);
    const external = await safeRead(first.binding);
    // Assigned inside the locked callback; widen so CFA does not pin it to null.
    let bytes = null as Uint8Array | null;
    try {
      const settled = await locked(async (tx) => {
        const joined = await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
        if (!joined) return null;
        if (isNativeEvidencePlan(joined.plan))
          await nativeLiveForTransaction(
            tx,
            scope,
            joined.plan,
            joined.inventory,
            purpose,
            ctx.now()
          );
        if (
          (await ctx.hash(bindingFor(joined.inventory, purpose))) !==
          (await ctx.hash(first.binding))
        )
          return fail("integrity");
        if (external.status === "fenced") {
          await checkedProof(
            first.binding,
            external.proof,
            "fenced",
            ctx.now()
          );
          await closeDomain(
            tx,
            scope,
            responseRequestId,
            "inputs",
            lossOf("storage-fenced", "storage-fence", first.binding.copyId),
            ctx.now()
          );
          return null;
        }
        if (external.status !== "live")
          return fail(
            external.status === "conflict"
              ? "conflict"
              : external.status === "invalid"
                ? "integrity"
                : "unavailable"
          );
        bytes = new Uint8Array(external.bytes);
        await checkedProof(first.binding, external.proof, "live", ctx.now());
        if (
          bytes.byteLength !== first.binding.content?.byteLength ||
          (await ctx.digest(bytes)) !== first.binding.content.sha256
        )
          return fail("integrity");
        const after = await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
        if (!after) return null;
        current(startedAt, first.expiresAt, after.expiresAt);
        return after.expiresAt;
      });
      if (!(settled && bytes)) return fail("denied");
      current(startedAt, settled);
      return new Uint8Array(bytes);
    } finally {
      if (bytes) bytes.fill(0);
      if (external.status === "live") external.bytes.fill(0);
    }
  };
  const advisoryBinding = (
    inventory: VertexResearchChatCopyInventory
  ): VertexChatCopyBinding => {
    const entry = inventory.copies.find(
      (copy) =>
        copy.allocation.copyIdempotencyKey ===
        (inventory.copies.length === 9
          ? nativeEvidenceCopyKey("advisory")
          : "one-expert-advisory-v1")
    );
    if (!entry?.contentBinding || entry.allocation.kind !== "derived-output")
      return fail("unavailable");
    return snapshotVertexChatCopyBinding({
      ...entry.allocation.binding,
      content: entry.contentBinding.content,
    });
  };
  type AdvisoryClaim = Readonly<{
    binding: VertexChatCopyBinding;
    fresh: boolean;
    startedAt: string;
    expiresAt: string;
  }>;
  const advisoryClaims = new WeakSet<object>();
  const advisoryLock = async <T>(
    scope: Scope,
    operation: (tx: Transaction, at: string) => Promise<T>
  ): Promise<T> =>
    db.transaction(
      withTransactionReadScope(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
        );
        if (ctx.commandPolicy)
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
          );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
        );
        return operation(tx, ctx.now());
      })
    );
  const claimAdvisoryForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    content: Readonly<{ sha256: string; byteLength: number }>,
    at: string
  ): Promise<AdvisoryClaim | null> => {
    const historical = await readHistoricalOriginalForTransaction(
      tx,
      scope,
      responseRequestId
    );
    const entry = requirePresent(
      historical.inventory.copies.find(
        (copy) =>
          copy.allocation.copyIdempotencyKey ===
          (isNativeEvidencePlan(historical.plan)
            ? nativeEvidenceCopyKey("advisory")
            : "one-expert-advisory-v1")
      ),
      "historical.inventory.copies.find( (copy) => copy.allocation.copyIdempotencyKe..."
    );
    const prior = entry.contentBinding
      ? await effect(
          tx,
          scope,
          historical.plan,
          advisoryBinding(historical.inventory),
          "create",
          at,
          false
        )
      : null;
    const joined = prior
      ? await readCurrentDerivedForTransaction(tx, scope, responseRequestId, at)
      : await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          at
        );
    if (!joined) return null;
    const pin = await metadata.bindAdvisoryContentForTransaction(
      tx,
      joined.plan,
      content,
      ctx.now()
    );
    const inventory = await inventoryFor(tx, scope, joined.plan);
    if (!inventory) return fail("integrity");
    const binding = advisoryBinding(inventory);
    if (
      binding.copyId !== pin.copyId ||
      (await ctx.hash(binding.content)) !== (await ctx.hash(content))
    )
      return fail("integrity");
    const intent = await effect(
      tx,
      scope,
      joined.plan,
      binding,
      "create",
      ctx.now(),
      true
    );
    if (!intent) return fail("integrity");
    const after = intent.fresh
      ? await readCurrentOriginalForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        )
      : await readCurrentDerivedForTransaction(
          tx,
          scope,
          responseRequestId,
          ctx.now()
        );
    if (!after) return null;
    current(at, joined.expiresAt, after.expiresAt);
    const issued = Object.freeze({
      binding,
      fresh: intent.fresh,
      startedAt: at,
      expiresAt: after.expiresAt,
    });
    advisoryClaims.add(issued);
    return issued;
  };
  const advisoryEffectCurrent = async (
    binding: VertexChatCopyBinding,
    startedAt: string,
    fresh: boolean
  ): Promise<boolean> =>
    advisoryLock(binding.scope, async (tx, at) => {
      current(startedAt);
      const joined = fresh
        ? await readCurrentOriginalForTransaction(
            tx,
            binding.scope,
            binding.responseRequestId,
            at
          )
        : await readCurrentDerivedForTransaction(
            tx,
            binding.scope,
            binding.responseRequestId,
            at
          );
      if (!joined) return false;
      if (
        (await ctx.hash(advisoryBinding(joined.inventory))) !==
          (await ctx.hash(binding)) ||
        !(await effect(
          tx,
          binding.scope,
          joined.plan,
          binding,
          "create",
          at,
          false
        ))
      )
        return fail("integrity");
      current(startedAt, joined.expiresAt);
      return true;
    });
  // SQL intent already committed before this method receives its opaque claim.
  // The instance token prevents a forged/reused fresh boolean; SQL remains the
  // durable first-dispatch authority after process loss or ambiguous effects.
  const writeOrInspectAdvisory = async (
    held: AdvisoryClaim,
    bytes: Uint8Array
  ): Promise<VertexChatCopyRead> => {
    if (!advisoryClaims.has(held)) return fail("denied");
    advisoryClaims.delete(held);
    const content = new Uint8Array(bytes);
    try {
      if (
        !held.binding.content ||
        content.byteLength !== held.binding.content.byteLength ||
        (await ctx.digest(content)) !== held.binding.content.sha256
      )
        return fail("integrity");
      if (
        !(await advisoryEffectCurrent(held.binding, held.startedAt, held.fresh))
      )
        return { status: "unavailable", reason: "backend" };
      let observed: VertexChatCopyCreation | VertexChatCopyInspection;
      if (held.fresh) {
        try {
          observed = await capabilities.createCopy(held.binding, content);
        } catch {
          observed = { status: "unknown" };
        }
        if (!(await advisoryEffectCurrent(held.binding, held.startedAt, false)))
          return { status: "unavailable", reason: "backend" };
        if (
          observed.status === "unknown" ||
          observed.status === "unavailable"
        ) {
          try {
            observed = await capabilities.inspectCopy(held.binding);
          } catch {
            observed = { status: "unavailable", reason: "backend" };
          }
        }
      } else {
        try {
          observed = await capabilities.inspectCopy(held.binding);
        } catch {
          observed = { status: "unavailable", reason: "backend" };
        }
      }
      if (!(await advisoryEffectCurrent(held.binding, held.startedAt, false)))
        return { status: "unavailable", reason: "backend" };
      if (observed.status !== "live") return observed as VertexChatCopyRead;
      await checkedProof(held.binding, observed.proof, "live", ctx.now());
      return safeRead(held.binding);
    } finally {
      content.fill(0);
    }
  };
  const settleAdvisoryForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    binding: VertexChatCopyBinding,
    external: VertexChatCopyRead,
    at: string
  ) => {
    const joined = await readCurrentDerivedForTransaction(
      tx,
      scope,
      responseRequestId,
      at
    );
    if (!joined) return { status: "closed" as const };
    if (
      (await ctx.hash(advisoryBinding(joined.inventory))) !==
        (await ctx.hash(binding)) ||
      !(await effect(tx, scope, joined.plan, binding, "create", at, false))
    )
      return fail("integrity");
    if (external.status === "fenced") {
      await checkedProof(binding, external.proof, "fenced", ctx.now());
      await closeDomain(
        tx,
        scope,
        responseRequestId,
        "derived",
        lossOf("storage-fenced", "storage-fence", binding.copyId),
        ctx.now()
      );
      return { status: "closed" as const };
    }
    if (external.status === "invalid") return fail("integrity");
    if (external.status === "conflict") return fail("conflict");
    if (external.status !== "live") return { status: "unknown" as const };
    if (
      external.bytes.byteLength !== binding.content?.byteLength ||
      (await ctx.digest(external.bytes)) !== binding.content.sha256
    )
      return fail("integrity");
    const proof = await checkedProof(
      binding,
      external.proof,
      "live",
      ctx.now()
    );
    await observe(tx, joined.plan, binding, "create", proof, ctx.now());
    const after = await readCurrentDerivedForTransaction(
      tx,
      scope,
      responseRequestId,
      ctx.now()
    );
    if (!after) return { status: "closed" as const };
    current(at, joined.expiresAt, after.expiresAt);
    return { status: "live" as const, binding, expiresAt: after.expiresAt };
  };
  const readAdvisory = async (
    principal: VertexPrincipal,
    scope: Scope,
    responseRequestId: string
  ): Promise<Uint8Array> => {
    const startedAt = ctx.now();
    const before = await ctx.run(
      principal,
      scope,
      null,
      "research-chat",
      "read",
      async (tx, at) => {
        const joined = await readCurrentDerivedForTransaction(
          tx,
          scope,
          responseRequestId,
          at
        );
        if (!joined) return null;
        if (joined.plan["ownerActorId"] !== principal.actorId)
          return fail("denied");
        const binding = advisoryBinding(joined.inventory);
        if (
          !(await effect(tx, scope, joined.plan, binding, "create", at, false))
        )
          return fail("unavailable");
        return { binding, expiresAt: joined.expiresAt };
      },
      true
    );
    if (!before) return fail("denied");
    current(startedAt, before.expiresAt);
    const external = await safeRead(before.binding);
    try {
      const settled = await advisoryLock(scope, async (tx, at) =>
        settleAdvisoryForTransaction(
          tx,
          scope,
          responseRequestId,
          before.binding,
          external,
          at
        )
      );
      if (settled.status !== "live" || external.status !== "live")
        return fail(settled.status === "closed" ? "denied" : "unavailable");
      // The caller's independent owner-read grant is checked again after I/O.
      await ctx.authorize(
        principal,
        scope,
        null,
        "research-chat",
        "read",
        ctx.now()
      );
      current(startedAt, before.expiresAt, settled.expiresAt);
      return new Uint8Array(external.bytes);
    } finally {
      if (external.status === "live") external.bytes.fill(0);
    }
  };
  const inputFenceAcksForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => {
    const { plan, inventory } = await readHistoricalOriginalForTransaction(
      tx,
      scope,
      responseRequestId
    );
    if (!(await domain(tx, scope, plan, "inputs"))) return null;
    const acknowledgements: VertexRecord[] = [];
    const targets = isNativeEvidencePlan(plan)
      ? inventory.copies.filter(
          (entry) => entry.allocation.kind !== "derived-output"
        )
      : purposes.map((purpose) =>
          requirePresent(
            inventory.copies.find(
              (entry) =>
                entry.allocation.copyIdempotencyKey ===
                `one-expert-${purpose}-v1`
            ),
            "inventory.copies.find( (entry) => entry.allocation.copyIdempotencyKey === `on..."
          )
        );
    for (const entry of targets) {
      const binding = snapshotVertexChatCopyBinding({
        ...entry.allocation.binding,
        content: entry.contentBinding?.content ?? null,
      });
      if (!(await effect(tx, scope, plan, binding, "fence", at, false)))
        return null;
      const row = await one(
        tx,
        observationsTable,
        scope,
        sql`response_request_id = ${responseRequestId} and copy_id = ${binding.copyId} and operation = 'fence'`
      );
      if (!row) return null;
      const value = object(row["payload"]);
      if (
        (await ctx.hash(value)) !== row["record_hash"] ||
        value["planSha256"] !== plan["planSha256"] ||
        value["copyId"] !== binding.copyId ||
        value["operation"] !== "fence" ||
        time(value["observedAt"]) > time(at)
      )
        return fail("integrity");
      await checkedProof(
        binding,
        value["proof"] as VertexChatCopyProof,
        "fenced",
        at
      );
      acknowledgements.push(value);
    }
    return Object.freeze(acknowledgements);
  };
  const advisoryLiveProofForTransaction = async (
    tx: Transaction,
    scope: Scope,
    responseRequestId: string,
    at: string
  ) => {
    const joined = await readCurrentDerivedForTransaction(
      tx,
      scope,
      responseRequestId,
      at
    );
    if (!joined) return null;
    const binding = advisoryBinding(joined.inventory);
    if (!(await effect(tx, scope, joined.plan, binding, "create", at, false)))
      return fail("unavailable");
    const row = await one(
      tx,
      observationsTable,
      scope,
      sql`response_request_id = ${responseRequestId} and copy_id = ${binding.copyId} and operation = 'create'`
    );
    if (!row) return fail("unavailable");
    const value = object(row["payload"]);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      value["planSha256"] !== joined.plan["planSha256"] ||
      value["copyId"] !== binding.copyId ||
      value["operation"] !== "create" ||
      time(value["observedAt"]) > time(at)
    )
      return fail("integrity");
    return {
      binding,
      proof: await checkedProof(
        binding,
        value["proof"] as VertexChatCopyProof,
        "live",
        at
      ),
    };
  };
  return {
    writeApprovedInputs: (principal: VertexPrincipal, supplied: unknown) =>
      inputs(principal, supplied, true),
    reconcileApprovedInputs: (principal: VertexPrincipal, supplied: unknown) =>
      inputs(principal, supplied, false),
    readApprovedInput,
    closeApprovedInputs,
    drainApprovedCopyCleanup,
    closeResponseAttemptInputsForTransaction,
    observeOriginalAuthorityLossForTransaction,
    readCurrentOriginalForTransaction,
    readCurrentDerivedForTransaction,
    readHistoricalOriginalForTransaction,
    readOriginalInput,
    readNativeInput: readOriginalInput,
    readNativePhaseForTransaction,
    materializeNativeEvidencePhaseTwo,
    claimAdvisoryForTransaction,
    writeOrInspectAdvisory,
    settleAdvisoryForTransaction,
    readAdvisory,
    inputFenceAcksForTransaction,
    advisoryLiveProofForTransaction,
  };
};
