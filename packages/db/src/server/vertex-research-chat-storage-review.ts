import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import {
  array,
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
import type {
  VertexAction,
  VertexPrincipal,
  VertexRecord,
  VertexRightsRecord,
  VertexScope,
} from "./vertex-ports.ts";
import {
  researchChatStorageReviewResource,
  type VertexResearchChatExecutionOptions,
} from "./vertex-research-chat-execution-ports.ts";

// Private operation group of the existing review owner. The public review FK,
// AcceptedReview and StrategySpec semantics remain untouched. A stage is merely
// provenance until an independently authorized human accepts this EXACT plan.
export const createResearchChatStorageReviewOperations = (
  ctx: PersistenceContext,
  options: VertexResearchChatExecutionOptions
) => {
  const checked = async (
    name: "storageReview" | "storageEvidence" | "plan",
    raw: unknown,
    hash?: unknown
  ): Promise<VertexRecord> => {
    const before = await ctx.hash(raw);
    if (hash !== undefined && hash !== before) return fail("integrity");
    const value = ctx.capture(await options.validate(name, raw));
    if ((await ctx.hash(value)) !== before) return fail("integrity");
    return value;
  };
  const plan = async (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string,
    planId: string,
    planSha256: string
  ): Promise<VertexRecord> => {
    const row = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId} and plan_id = ${planId}`
    );
    if (!row) return fail("denied");
    const value = await checked("plan", row["payload"], row["record_hash"]);
    const { planSha256: omittedHash, planId: omittedId, ...body } = value;
    if (
      value["planId"] !== planId ||
      value["planSha256"] !== planSha256 ||
      (await ctx.hash(body)) !== planSha256 ||
      value["responseRequestId"] !== responseRequestId ||
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment ||
      value["ownerActorId"] !== row["owner_actor_id"] ||
      value["threadId"] !== row["thread_id"] ||
      value["requestSha256"] !== row["request_sha256"]
    )
      return fail("integrity");
    return value;
  };
  // The caller holds authorization-global -> policy -> scope locks. Retain
  // primitive bounds, not an earlier boolean: later object reads and hashes may
  // cross ANY joined grant/rights deadline, including an earlier report's.
  const finalCurrent = (bounds: readonly bigint[], at: string): void => {
    const now = time(ctx.now());
    if (now < time(at) || bounds.some((bound) => bound <= now)) fail("stale");
  };
  const retainGrant = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    resourceId: string,
    action: VertexAction,
    bounds: bigint[]
  ): Promise<void> => {
    const at = ctx.now();
    await ctx.authorize(principal, scope, null, resourceId, action, at);
    const found = await rows(
      tx,
      sql`select v.payload, v.record_hash, c.current_version, c.revision from vertex_grant_bindings b join vertex_grant_current c on c.account_alias = b.account_alias and c.environment = b.environment and c.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.version = c.current_version join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment} and b.grantee_actor_id = ${principal.actorId} and b.collection_key = '' and b.resource_id = ${resourceId} and a.action = ${action} and v.status = 'granted' order by v.expires_at_ns desc limit 129`
    );
    if (found.length > 128) return fail("denied");
    for (const row of found) {
      const value = object(row["payload"]);
      if ((await ctx.hash(value)) !== row["record_hash"])
        return fail("integrity");
      const boundScope = object(value["scope"]);
      if (
        value["granteeActorId"] === principal.actorId &&
        boundScope["accountAlias"] === scope.accountAlias &&
        boundScope["environment"] === scope.environment &&
        value["collectionId"] === null &&
        value["resourceId"] === resourceId &&
        value["status"] === "granted" &&
        array(value["actions"], 8).includes(action) &&
        value["version"] === row["current_version"] &&
        value["revision"] === row["revision"] &&
        time(value["recordedAt"]) <= time(at) &&
        time(value["validFrom"]) <= time(at) &&
        time(value["expiresAt"]) > time(ctx.now())
      ) {
        bounds.push(time(value["expiresAt"]));
        return;
      }
    }
    return fail("denied");
  };
  const retainArtifact = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord,
    bounds: bigint[]
  ): Promise<void> => {
    await retainGrant(tx, principal, scope, "account-scope", "read", bounds);
    await retainGrant(
      tx,
      principal,
      scope,
      identifier(pin["artifactId"]),
      "read",
      bounds
    );
    const at = ctx.now();
    const catalog = await ctx.artifact(
      tx,
      principal,
      scope,
      null,
      identifier(pin["artifactId"]),
      "read",
      at
    );
    let policyId: string;
    let version: string;
    if (catalog) {
      if (
        catalog.artifactSha256 !== pin["artifactSha256"] ||
        catalog.contractName !== pin["contractName"] ||
        catalog.schemaVersion !== pin["schemaVersion"]
      )
        return fail("integrity");
      policyId = catalog.rights.policyId;
      version = catalog.rights.version;
      bounds.push(time(catalog.rights.expiresAt));
      if (catalog.rights.retentionUntil !== null)
        bounds.push(time(catalog.rights.retentionUntil));
    } else {
      const stage = await one(
        tx,
        "vertex_worker_stages",
        scope,
        sql`artifact_id = ${identifier(pin["artifactId"])} and collection_key = ''`
      );
      if (!stage) return fail("denied");
      const descriptor = object(stage["payload"]);
      if (
        (await ctx.hash(descriptor)) !== stage["request_hash"] ||
        descriptor["accountAlias"] !== scope.accountAlias ||
        descriptor["environment"] !== scope.environment ||
        descriptor["collectionId"] !== null ||
        descriptor["artifactId"] !== pin["artifactId"] ||
        descriptor["jobId"] !== stage["job_id"] ||
        descriptor["contentSha256"] !== pin["artifactSha256"] ||
        descriptor["canonicalSha256"] !== pin["artifactSha256"] ||
        stage["content_sha256"] !== pin["artifactSha256"] ||
        stage["canonical_sha256"] !== pin["artifactSha256"]
      )
        return fail("integrity");
      policyId = identifier(descriptor["rightsPolicyId"]);
      version = string(descriptor["rightsVersion"]);
    }
    const row = await ctx.latestRights(tx, scope, null, policyId);
    if (!row) return fail("denied");
    const rights = object(row["payload"]) as unknown as VertexRightsRecord;
    if (
      (await ctx.hash(rights)) !== row["record_hash"] ||
      rights.policyId !== policyId ||
      rights.version !== version ||
      row["policy_id"] !== policyId ||
      row["version"] !== version ||
      row["status"] !== rights.status ||
      time(rights.checkedAt).toString() !== row["checked_at_ns"] ||
      time(rights.expiresAt).toString() !== row["expires_at_ns"] ||
      (rights.retentionUntil === null
        ? null
        : time(rights.retentionUntil).toString()) !== row["retention_until_ns"]
    )
      return fail("integrity");
    await ctx.rights(tx, scope, null, rights, "read", at);
    bounds.push(time(rights.expiresAt));
    if (rights.retentionUntil !== null)
      bounds.push(time(rights.retentionUntil));
  };
  const original = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord,
    bounds: bigint[]
  ): Promise<Uint8Array> => {
    await retainArtifact(tx, principal, scope, pin, bounds);
    const raw = await options.readSelectedArtifact(tx, principal, scope, pin);
    if (
      !(raw instanceof Uint8Array) ||
      raw.byteLength === 0 ||
      raw.byteLength > 1_048_576 ||
      (await ctx.digest(raw)) !== pin["artifactSha256"]
    )
      return fail("integrity");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return fail("integrity");
    }
    const canonical = ctx.encode(value);
    if (
      canonical.byteLength !== raw.byteLength ||
      !raw.every((byte, index) => byte === canonical[index])
    )
      return fail("integrity");
    return raw;
  };
  const evidence = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    selectedPlan: VertexRecord,
    at: string
  ): Promise<
    Readonly<{
      value: VertexRecord;
      issuerActorId: string;
      producerServiceId: string;
      bounds: readonly bigint[];
    }>
  > => {
    const bounds = [time(selectedPlan["expiresAt"])];
    const selected = object(selectedPlan["storageEvidence"]);
    if (
      (await ctx.hash(selected)) !== (await ctx.hash(options.storage.evidence))
    )
      return fail("denied");
    const bytes = await original(tx, principal, scope, selected, bounds);
    const value = await checked(
      "storageEvidence",
      JSON.parse(new TextDecoder().decode(bytes))
    );
    if (
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== "research" ||
      scope.environment !== "research"
    )
      return fail("denied");
    for (const key of [
      "capabilityReferenceId",
      "backendDeploymentId",
      "storageProfileSha256",
      "implementationSha256",
      "contractSha256",
    ] as const) {
      if (value[key] !== options.storage[key]) return fail("denied");
    }
    for (const key of [
      "capabilityReferenceId",
      "backendDeploymentId",
      "storageProfileSha256",
    ]) {
      if (selectedPlan[key] !== value[key]) return fail("denied");
    }
    if (
      time(value["observedAt"]) > time(at) ||
      time(value["expiresAt"]) <= time(ctx.now())
    )
      return fail("stale");
    bounds.push(time(value["expiresAt"]));
    const stage = await one(
      tx,
      "vertex_worker_stages",
      scope,
      sql`artifact_id = ${identifier(selected["artifactId"])} and collection_key = ''`
    );
    if (
      !stage ||
      stage["content_sha256"] !== selected["artifactSha256"] ||
      stage["canonical_sha256"] !== selected["artifactSha256"] ||
      stage["byte_length"] !== bytes.byteLength
    )
      return fail("integrity");
    const descriptor = object(stage["payload"]);
    if (
      (await ctx.hash(descriptor)) !== stage["request_hash"] ||
      descriptor["artifactId"] !== selected["artifactId"] ||
      descriptor["jobId"] !== stage["job_id"] ||
      descriptor["accountAlias"] !== scope.accountAlias ||
      descriptor["environment"] !== scope.environment ||
      descriptor["collectionId"] !== null ||
      descriptor["contentSha256"] !== selected["artifactSha256"] ||
      descriptor["canonicalSha256"] !== selected["artifactSha256"]
    )
      return fail("integrity");
    const job = await one(
      tx,
      "vertex_worker_jobs",
      scope,
      sql`job_id = ${stage["job_id"]}`
    );
    if (!job) return fail("integrity");
    const lease = object(job["payload"]);
    const stable = {
      kind: lease["kind"],
      researchPrincipalId: lease["researchPrincipalId"],
      payloadArtifactId: lease["payloadArtifactId"],
      payloadSha256: lease["payloadSha256"],
      policySelectionId: lease["policySelectionId"],
      policySelectionSha256: lease["policySelectionSha256"],
      deadlineAt: lease["deadlineAt"],
    };
    if (
      lease["jobId"] !== stage["job_id"] ||
      lease["accountAlias"] !== scope.accountAlias ||
      lease["environment"] !== scope.environment ||
      lease["eventId"] !== job["event_id"] ||
      lease["leaseId"] !== job["lease_id"] ||
      lease["leaseEpoch"] !== job["lease_epoch"] ||
      (await ctx.hash({ scope, eventId: job["event_id"], ...stable })) !==
        job["binding_hash"] ||
      lease["jobId"] !==
        `job-${await ctx.hash({ scope, eventId: job["event_id"] })}`
    )
      return fail("integrity");
    const issuerActorId = identifier(lease["researchPrincipalId"]);
    if (value["issuerActorId"] !== issuerActorId) return fail("integrity");
    const admission = await one(
      tx,
      "vertex_worker_run_admissions",
      scope,
      sql`job_id = ${stage["job_id"]}`
    );
    if (
      !admission ||
      time(admission["admitted_at"]) > time(descriptor["createdAt"]) ||
      admission["lease_epoch"] !== lease["leaseEpoch"]
    )
      return fail("integrity");
    const service = await one(
      tx,
      "vertex_worker_service_grants",
      scope,
      sql`grant_id = ${job["grant_id"]}`
    );
    if (
      !service ||
      (await ctx.hash(service["payload"])) !== service["record_hash"]
    )
      return fail("integrity");
    const grant = object(service["payload"]);
    if (
      grant["grantId"] !== job["grant_id"] ||
      grant["servicePrincipalId"] !== service["service_principal_id"] ||
      grant["accountAlias"] !== scope.accountAlias ||
      grant["environment"] !== scope.environment ||
      !array(grant["operations"], 32).includes("stageArtifact") ||
      time(grant["issuedAt"]) > time(descriptor["createdAt"]) ||
      time(grant["expiresAt"]) <= time(descriptor["createdAt"]) ||
      (grant["revokedAt"] !== null &&
        time(grant["revokedAt"]) <= time(descriptor["createdAt"]))
    )
      return fail("denied");
    // Historical issuing lease need not remain running. Current *human issuer*
    // publication authority and report rights are nevertheless required.
    await retainGrant(
      tx,
      { actorId: issuerActorId },
      scope,
      identifier(selected["artifactId"]),
      "publish",
      bounds
    );
    for (const report of array(value["durabilityEvidence"], 16))
      await original(tx, principal, scope, object(report), bounds);
    finalCurrent(bounds, at);
    return {
      value,
      issuerActorId,
      producerServiceId: identifier(grant["servicePrincipalId"]),
      bounds,
    };
  };
  const reviewAuthority = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    selectedPlan: VertexRecord,
    source: Readonly<{ issuerActorId: string; producerServiceId: string }>,
    bounds: bigint[]
  ): Promise<void> => {
    if (
      principal.actorId !== options.storage.reviewerActorId ||
      [
        selectedPlan["ownerActorId"],
        source.issuerActorId,
        source.producerServiceId,
      ].includes(principal.actorId)
    )
      return fail("denied");
    await retainGrant(
      tx,
      principal,
      scope,
      identifier(object(selectedPlan["storageEvidence"])["artifactId"]),
      "review",
      bounds
    );
    await retainGrant(
      tx,
      principal,
      scope,
      researchChatStorageReviewResource(
        identifier(selectedPlan["responseRequestId"])
      ),
      "review",
      bounds
    );
  };
  const latest = (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string
  ): Promise<Record<string, unknown> | null> => {
    return one(
      tx,
      "vertex_research_chat_storage_reviews",
      scope,
      sql`response_request_id = ${responseRequestId}`,
      sql`order by reviewed_at_ns desc, review_id desc`
    );
  };
  const verifyReview = async (
    row: Record<string, unknown>,
    selectedPlan: VertexRecord
  ): Promise<VertexRecord> => {
    const value = await checked(
      "storageReview",
      row["payload"],
      row["record_hash"]
    );
    if (
      value["reviewId"] !== row["review_id"] ||
      value["responseRequestId"] !== selectedPlan["responseRequestId"] ||
      value["planId"] !== selectedPlan["planId"] ||
      value["planSha256"] !== selectedPlan["planSha256"] ||
      value["ownerActorId"] !== selectedPlan["ownerActorId"] ||
      value["actorId"] !== row["actor_id"] ||
      value["decision"] !== row["decision"] ||
      value["requestSha256"] !== row["request_sha256"] ||
      value["idempotencyKey"] !== row["idempotency_key"] ||
      time(value["reviewedAt"]).toString() !== row["reviewed_at_ns"] ||
      time(value["expiresAt"]).toString() !== row["expires_at_ns"] ||
      (await ctx.hash(value["evidence"])) !==
        (await ctx.hash(selectedPlan["storageEvidence"]))
    )
      return fail("integrity");
    return value;
  };
  const readResearchChatStorageQualificationForTransaction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    selectedPlan: VertexRecord,
    at: string
  ): Promise<VertexRecord> => {
    const current = await latest(
      tx,
      scope,
      identifier(selectedPlan["responseRequestId"])
    );
    if (!current) return fail("denied");
    const review = await verifyReview(current, selectedPlan);
    if (
      review["decision"] !== "accepted" ||
      time(review["reviewedAt"]) > time(at) ||
      time(review["expiresAt"]) <= time(ctx.now())
    )
      return fail("denied");
    const source = await evidence(tx, principal, scope, selectedPlan, at);
    if (review["issuerActorId"] !== source.issuerActorId)
      return fail("integrity");
    const bounds = [...source.bounds, time(review["expiresAt"])];
    await reviewAuthority(
      tx,
      { actorId: identifier(review["actorId"]) },
      scope,
      selectedPlan,
      source,
      bounds
    );
    // No await after the final sample: all original joined authority survives.
    finalCurrent(bounds, at);
    return review;
  };
  const recordResearchChatStorageQualificationReview = async (
    principal: VertexPrincipal,
    raw: unknown
  ): Promise<VertexRecord> => {
    const command = ctx.capture(
      await options.validate("storageReviewInput", ctx.capture(raw))
    );
    const scope: VertexScope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "research",
    };
    const requestSha256 = await ctx.hash({
      operation: "recordResearchChatStorageQualificationReview",
      actorId: principal.actorId,
      input: command,
    });
    return ctx.run(
      principal,
      scope,
      null,
      researchChatStorageReviewResource(
        identifier(command["responseRequestId"])
      ),
      "review",
      async (tx, at) => {
        const selectedPlan = await plan(
          tx,
          scope,
          identifier(command["responseRequestId"]),
          identifier(command["planId"]),
          string(command["planSha256"])
        );
        if (
          (await ctx.hash(command["evidence"])) !==
          (await ctx.hash(selectedPlan["storageEvidence"]))
        )
          return fail("conflict");
        const source = await evidence(tx, principal, scope, selectedPlan, at);
        const bounds = [...source.bounds];
        await reviewAuthority(
          tx,
          principal,
          scope,
          selectedPlan,
          source,
          bounds
        );
        const prior = await one(
          tx,
          "vertex_research_chat_storage_reviews",
          scope,
          sql`actor_id = ${principal.actorId} and idempotency_key = ${command["idempotencyKey"]}`
        );
        if (prior) {
          if (prior["request_sha256"] !== requestSha256)
            return fail("conflict");
          const value = await verifyReview(prior, selectedPlan);
          // Exact replay is not a renewal or a promotion of a rejected decision.
          if (
            value["actorId"] !== principal.actorId ||
            value["issuerActorId"] !== source.issuerActorId ||
            value["decision"] !== command["decision"] ||
            value["expiresAt"] !== command["expiresAt"] ||
            value["supersedesReviewId"] !== command["expectedReviewId"] ||
            (await ctx.hash(value["allowedCopyOperations"])) !==
              (await ctx.hash(command["allowedCopyOperations"]))
          )
            return fail("integrity");
          if (time(value["reviewedAt"]) > time(at)) return fail("stale");
          finalCurrent([...bounds, time(value["expiresAt"])], at);
          return value;
        }
        const head = await latest(
          tx,
          scope,
          identifier(command["responseRequestId"])
        );
        if (
          (head?.["review_id"] ?? null) !== command["expectedReviewId"] ||
          (head && BigInt(string(head["reviewed_at_ns"])) >= time(at))
        )
          return fail("conflict");
        if (
          time(command["expiresAt"]) <= time(ctx.now()) ||
          time(command["expiresAt"]) > time(source.value["expiresAt"]) ||
          time(command["expiresAt"]) > time(selectedPlan["expiresAt"])
        )
          return fail("stale");
        const value = await checked("storageReview", {
          schemaVersion: "1.0.0",
          format: "vertex-research-chat-storage-qualification-review-v1",
          ...scope,
          responseRequestId: selectedPlan["responseRequestId"],
          planId: selectedPlan["planId"],
          planSha256: selectedPlan["planSha256"],
          ownerActorId: selectedPlan["ownerActorId"],
          reviewId: `storage-review-${requestSha256}`,
          requestSha256,
          actorId: principal.actorId,
          issuerActorId: source.issuerActorId,
          evidence: selectedPlan["storageEvidence"],
          purpose: "storage-qualification",
          decision: command["decision"],
          allowedCopyOperations: command["allowedCopyOperations"],
          reviewedAt: at,
          expiresAt: command["expiresAt"],
          supersedesReviewId: command["expectedReviewId"],
          idempotencyKey: command["idempotencyKey"],
        });
        await reviewAuthority(
          tx,
          principal,
          scope,
          selectedPlan,
          source,
          bounds
        );
        const recordHash = await ctx.hash(value);
        // No new deadline or TTL: the supplied review must still be current both
        // before insertion and after the final transactional I/O, before commit.
        const reviewBounds = [...bounds, time(value["expiresAt"])];
        finalCurrent(reviewBounds, at);
        await insert(tx, "vertex_research_chat_storage_reviews", scope, {
          response_request_id: value["responseRequestId"],
          plan_id: value["planId"],
          plan_sha256: value["planSha256"],
          evidence_artifact_id: object(value["evidence"])["artifactId"],
          evidence_sha256: object(value["evidence"])["artifactSha256"],
          review_id: value["reviewId"],
          actor_id: principal.actorId,
          issuer_actor_id: source.issuerActorId,
          request_sha256: requestSha256,
          idempotency_key: value["idempotencyKey"],
          decision: value["decision"],
          reviewed_at_ns: time(at).toString(),
          expires_at_ns: time(value["expiresAt"]).toString(),
          supersedes_review_id: value["supersedesReviewId"],
          record_hash: recordHash,
          payload: value,
        });
        finalCurrent(reviewBounds, at);
        return value;
      },
      true
    );
  };
  return {
    plan,
    evidence,
    recordResearchChatStorageQualificationReview,
    readResearchChatStorageQualificationForTransaction,
  };
};
