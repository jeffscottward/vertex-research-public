import {
  type VertexObjectCapabilities,
  vertexQualifiedObjectKey,
} from "@darkfactory/storage";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import { invalidateTransactionRows } from "./vertex-transaction-read-cache.ts";
import {
  type HistoricalBarModeledOutcome,
  verifyHistoricalBarResult,
} from "./vertex-historical-bar-proof.ts";
import { createNativeFactOperations } from "./vertex-native-fact-store.ts";
import { createOutboxOperations } from "./vertex-outbox-store.ts";
import {
  array,
  collectionId,
  collectionKey,
  createPersistenceContext,
  digestString,
  fail,
  identifier,
  insert,
  json,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  string,
  time,
  type VertexStoreOptions,
} from "./vertex-persistence-core.ts";
import type {
  VertexArtifactMetadata,
  VertexImmutableInput,
  VertexOutboxLease,
  VertexPrincipal,
  VertexRecord,
  VertexRightsRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { createProjectionOperations } from "./vertex-projection-store.ts";
import { createQueryOperations } from "./vertex-query-store.ts";
import {
  isNativeEvidencePlan,
  type NativeEvidenceCopyPurpose,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";
import type {
  ResearchChatOutputPort,
  ResearchChatOutputPrepared,
} from "./vertex-research-chat-output-ports.ts";
import type {
  ResearchChatSourceInputs,
  ResearchChatSourceRequest,
} from "./vertex-research-chat-source-ports.ts";
import type { ResearchChatWorkerOperations } from "./vertex-research-chat-worker-store.ts";
import { readResearchProposalForTransaction } from "./vertex-research-proposal-read.ts";
import {
  createResearchOperations,
  type WorkerLineageParentResolver,
} from "./vertex-research-store.ts";
import { createReviewOperations } from "./vertex-review-store.ts";
import {
  createVertexWorkerCredentials,
  type WorkerServiceIdentity,
} from "./vertex-worker-credentials.ts";

export type {
  VertexResearchChatCopyCleanupOptions,
  VertexResearchChatCopyCleanupStore,
} from "./vertex-research-chat-copy-cleanup-service.ts";
export { createVertexResearchChatCopyCleanupStore } from "./vertex-research-chat-copy-cleanup-service.ts";
export type { WorkerServiceIdentity } from "./vertex-worker-credentials.ts";

export type WorkerDispatchBinding = Readonly<{
  kind:
    | "research-run"
    | "dataset-ingest"
    | "knowledge-import"
    | "backtest"
    | "paper-simulation"
    | "native-bootstrap";
  researchPrincipalId: string;
  payloadArtifactId: string;
  payloadSha256: string;
  policySelectionId: string;
  policySelectionSha256: string;
  deadlineAt: string;
  workerInstanceId: string;
}>;
export type WorkerPayloadPreparation = Readonly<{
  researchPrincipalId: string;
  artifactId: string;
  sha256: string;
  bytes: Uint8Array;
  rightsPolicyId: string;
  rightsVersion: string;
}>;
export type VertexWorkerOptions = VertexStoreOptions &
  Readonly<{
    // The API injects the actual VERTEX_WORKER_CONTRACT_SCHEMAS parser. No DTO clone.
    validateWorker: (
      name: string,
      value: unknown
    ) => VertexRecord | Promise<VertexRecord>;
    objectCapabilities: (scope: VertexScope) => VertexObjectCapabilities;
    authorizeGrantAdministration: (
      context: unknown,
      action: "issue" | "revoke",
      scope: VertexScope,
      grantId: string,
      details: Readonly<{
        grant: VertexRecord;
        credentialDigest: string;
        recordSha256: string;
        previousRecordSha256: string | null;
        authorizationSha256: string;
        tx: Transaction;
      }>
    ) => Promise<boolean>;
    // Transaction-bound exact selection materialization, never an alias/read-only history lookup.
    policySelection: (
      tx: Transaction,
      principal: VertexPrincipal,
      lookup: Readonly<{
        accountAlias: string;
        environment: string;
        selectionId: string;
        selectionSha256: string;
      }>,
      consumerServiceId: string,
      holderId: string
    ) => Promise<VertexRecord>;
    pinPolicySelection: (
      tx: Transaction,
      principal: VertexPrincipal,
      lookup: Readonly<{
        accountAlias: string;
        environment: string;
        selectionId: string;
        selectionSha256: string;
      }>,
      consumerServiceId: string,
      holderId: string
    ) => Promise<void>;
    authorizeBootstrapEnqueue: (
      context: unknown,
      tx: Transaction,
      scope: VertexScope,
      command: VertexRecord
    ) => Promise<boolean>;
    authorizeNativeBootstrap: (
      tx: Transaction,
      principal: VertexPrincipal,
      scope: VertexScope,
      command: VertexRecord
    ) => Promise<boolean>;
    modelUse: (
      tx: Transaction,
      principal: VertexPrincipal,
      request: VertexRecord,
      at: string,
      governedInput?: Uint8Array
    ) => Promise<VertexRecord>;
    chatWorker?: ResearchChatWorkerOperations;
    chatOutput?: ResearchChatOutputPort;
    chatModelPrivacyReview?: (
      tx: Transaction,
      operation: "prepareModelPrivacyReview" | "readModelPrivacyReview",
      request: VertexRecord,
      at: string,
      governedInput: Uint8Array
    ) => Promise<VertexRecord>;
    epochTransition: (
      tx: Transaction,
      principal: VertexPrincipal,
      scope: VertexScope,
      transition: VertexRecord,
      at: string
    ) => Promise<VertexRecord>;
    nativeProjectionPrincipal: (
      tx: Transaction,
      identity: WorkerServiceIdentity,
      lease: VertexRecord,
      operation: string,
      projection: VertexRecord
    ) => Promise<VertexPrincipal>;
    nativeOutboxReplay: (
      tx: Transaction,
      principal: VertexPrincipal,
      scope: VertexScope,
      replay: VertexRecord,
      at: string
    ) => Promise<VertexRecord>;
  }>;
const terminal = (state: unknown): boolean =>
  ["succeeded", "failed", "cancelled"].includes(string(state));
const canonicalBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const decode = (value: unknown): Uint8Array => {
  const text = string(value);
  if (
    text.length > 1_398_104 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text
    )
  )
    fail("invalid");
  let raw: string;
  try {
    raw = atob(text);
  } catch {
    return fail("invalid");
  }
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  if (bytes.byteLength > 1_048_576 || canonicalBase64(bytes) !== text)
    fail("invalid");
  return bytes;
};

// Fixed inert HostBacktestRecipe v2 projection. This neither imports native code
// nor accepts a caller-selected decoder/type. Unsupported/lossy values deny.
const backtestRecipeFields: Readonly<Record<string, readonly string[]>> = {
  Pin: ["identity", "version", "digest"],
  DataPin: [
    "dataset_id",
    "manifest_digest",
    "content_digest",
    "source_digests",
    "calendar_pin",
    "vintage_id",
    "entitlement_evidence_id",
    "data_kinds",
  ],
  PointInTimeEvidence: [
    "evidence_id",
    "dataset_id",
    "source_id",
    "source_digest",
    "observed_at",
    "published_at",
    "available_at",
    "revision_at",
    "decision_at",
    "vintage_id",
  ],
  ModelAssumption: [
    "kind",
    "disposition",
    "model_pin",
    "parameters_bytes",
    "evidence_ids",
  ],
  TimeWindow: ["start_at", "end_at"],
  WalkForwardFold: [
    "fold_id",
    "training",
    "test",
    "fitted_at",
    "training_labels_end_at",
    "purge_ms",
    "embargo_ms",
    "parameter_digest",
    "evidence_ids",
  ],
  TrialRegistry: [
    "trial_ids",
    "selected_trial_id",
    "selection_policy_digest",
    "registered_at",
    "evidence_id",
  ],
  ForwardCriteria: [
    "registered_at",
    "not_before",
    "minimum_samples",
    "minimum_duration_ms",
    "minimum_regimes",
    "maximum_open_blocking_incidents",
    "policy_digest",
    "evidence_ids",
  ],
  Incident: ["incident_id", "code", "severity", "evidence_ids", "resolved"],
  AcceptanceCriterion: [
    "metric_id",
    "operator",
    "threshold",
    "registered_at",
    "evidence_ids",
  ],
  LineageInputs: [
    "strategy_version_id",
    "strategy_frozen_at",
    "code_pin",
    "engine_pin",
    "data_pins",
    "point_in_time",
    "assumptions",
    "folds",
    "trials",
    "forward_criteria",
    "incidents",
    "citations",
    "acceptance_criteria",
    "environment_digest",
  ],
  HistoricalBarLineage: [
    "strategy_version_id",
    "code_pin",
    "engine_pin",
    "model_digest",
    "interpretation_digest",
    "review_pins_bytes",
  ],
  ResourceBudget: [
    "maximum_input_bytes",
    "maximum_events",
    "maximum_candidates",
    "maximum_folds",
    "maximum_trials",
    "maximum_memory_bytes",
    "maximum_cpu_ms",
    "maximum_wall_ms",
    "network_allowed",
    "execution_allowed",
  ],
  EngineDescriptor: [
    "pin",
    "modeled_assumptions",
    "supported_formats",
    "sandbox_policy_digest",
    "simulation_only",
  ],
};
const backtestRecipeNames: Readonly<Record<string, readonly string[]>> = {
  ModelAssumption: [
    "kind",
    "disposition",
    "modelPin",
    "parameters",
    "evidenceIds",
  ],
  TimeWindow: ["startAtInclusive", "endAtExclusive"],
  WalkForwardFold: [
    "foldId",
    "trainingWindow",
    "testWindow",
    "fittedAt",
    "trainingLabelsEndAt",
    "purgeMs",
    "embargoMs",
    "parameterDigest",
    "evidenceIds",
  ],
  TrialRegistry: [
    "trialIds",
    "selectedTrialId",
    "selectionPolicyDigest",
    "registeredAt",
    "evidenceId",
  ],
  AcceptanceCriterion: [
    "metricId",
    "operator",
    "threshold",
    "registeredAt",
    "evidenceIds",
  ],
  LineageInputs: [
    "strategyVersionId",
    "strategyFrozenAt",
    "codePin",
    "enginePin",
    "dataPins",
    "pointInTime",
    "assumptions",
    "folds",
    "trials",
    "forwardCriteria",
    "incidents",
    "citations",
    "acceptanceCriteria",
    "environmentDigest",
  ],
  HistoricalBarLineage: [
    "strategyVersionId",
    "codePin",
    "enginePin",
    "modelDigest",
    "interpretationDigest",
    "reviewPins",
  ],
};
const backtestTimestamp = (raw: unknown): string => {
  const text = string(raw).replace(/\+00:00$/, "Z");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    text
  );
  if (!match) return fail("integrity");
  time(text);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return `${match[1]}${fraction === "000000" ? "" : `.${fraction}`}Z`;
};
const backtestRecipeValue = (
  raw: unknown,
  depth = 0,
  budget = { nodes: 0 }
): unknown => {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 20_000) fail("invalid");
  if (raw === null || typeof raw === "string" || typeof raw === "boolean")
    return raw;
  const value = object(raw);
  const keys = Object.keys(value).sort().join(",");
  const child = (item: unknown): unknown =>
    backtestRecipeValue(item, depth + 1, budget);
  if (keys === "tuple") return array(value["tuple"], 1024).map(child);
  if (keys === "datetime") return backtestTimestamp(value["datetime"]);
  if (keys === "integer") {
    const text = string(value["integer"]);
    if (
      !(
        /^(0|-?[1-9][0-9]{0,15})$/.test(text) &&
        Number.isSafeInteger(Number(text))
      )
    )
      fail("integrity");
    return Number(text);
  }
  if (keys !== "fields,record") return fail("integrity");
  const name = string(value["record"]);
  if (!Object.hasOwn(backtestRecipeFields, name)) return fail("integrity");
  const expected = backtestRecipeFields[name];
  const fields = object(value["fields"]);
  if (
    !expected ||
    Object.keys(fields).sort().join(",") !== [...expected].sort().join(",")
  )
    return fail("integrity");
  const names = backtestRecipeNames[name] ?? expected;
  const result: Record<string, unknown> = {};
  for (const [index, field] of expected.entries()) {
    if (
      (name === "ModelAssumption" && field === "parameters_bytes") ||
      (name === "HistoricalBarLineage" && field === "review_pins_bytes")
    ) {
      const envelope = object(fields[field]);
      if (Object.keys(envelope).join(",") !== "bytes") fail("integrity");
      try {
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            decode(envelope["bytes"])
          )
        );
        result[requirePresent(names[index], "names[index]")] =
          name === "HistoricalBarLineage" ? array(parsed, 32) : object(parsed);
      } catch {
        return fail("integrity");
      }
    } else {
      result[requirePresent(names[index], "names[index]")] = child(
        fields[field]
      );
    }
  }
  if (name === "HistoricalBarLineage") {
    Object.assign(result, {
      format: "vertex-historical-bar-lineage-inputs-v1",
      researchClass:
        "limited-retrospective-adjusted-bar-simulation-nonpromotion",
      promotionEligible: false,
    });
  }
  return result;
};

type VertexBacktestResultOptions = VertexStoreOptions &
  Pick<VertexWorkerOptions, "validateWorker" | "objectCapabilities">;
type BacktestSourceCheck = (now: string) => Promise<unknown>;
// Inert read capabilities only. Never constructs credentials or captures a
// worker invocation, expiry, admission, mutation or lifecycle owner.
const createBacktestReadProof = (
  ctx: PersistenceContext,
  options: Pick<
    VertexBacktestResultOptions,
    "validateWorker" | "objectCapabilities"
  >
) => {
  const parse = async (name: string, value: unknown): Promise<VertexRecord> => {
    try {
      return object(await options.validateWorker(name, ctx.capture(value)));
    } catch {
      return fail("invalid");
    }
  };
  // Reuses all existing guards but pins their callbacks to the SAME scope lock,
  // transaction and current clock as worker lease/grant validation. No nested tx.
  const boundContext = (
    tx: Transaction,
    at: string,
    scope: VertexScope
  ): PersistenceContext => ({
    ...ctx,
    run: async (
      principal,
      requestedScope,
      collection,
      resource,
      action,
      operation
    ) => {
      if (
        requestedScope.accountAlias !== scope.accountAlias ||
        requestedScope.environment !== scope.environment
      )
        fail("denied");
      await ctx.authorize(principal, scope, collection, resource, action, at);
      return operation(tx, at);
    },
  });
  const currentRights = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    policyId: string,
    use: "store" | "read" | "derive" | "export",
    at: string,
    version?: string
  ): Promise<VertexRightsRecord> => {
    await ctx.authorize(
      principal,
      scope,
      collection,
      identifier(policyId),
      use === "read" ? "read" : "publish",
      at
    );
    // Worker rights checks follow object I/O: always read the current head.
    invalidateTransactionRows(tx, "vertex_rights_versions");
    const current = await ctx.latestRights(tx, scope, collection, policyId);
    if (!current) return fail("denied");
    const rights = object(current["payload"]) as unknown as VertexRightsRecord;
    if (
      (await ctx.hash(rights)) !== current["record_hash"] ||
      (version !== undefined && rights.version !== version)
    )
      fail("stale");
    await ctx.rights(tx, scope, collection, rights, use, at);
    return rights;
  };
  const objectRead = async (
    scope: VertexScope,
    objectKey: string,
    expectedHash: string
  ): Promise<Uint8Array> => {
    const capabilities = options.objectCapabilities(scope);
    if (!capabilities.getBounded) return fail("unavailable");
    const response = await capabilities.getBounded(objectKey, 1_048_576);
    if (response.status !== "ok") return fail("unavailable");
    const bytes = response.value.body;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > 1_048_576 ||
      response.value.metadata.key !== objectKey ||
      response.value.metadata.size !== bytes.byteLength ||
      (await ctx.digest(bytes)) !== expectedHash
    )
      fail("integrity");
    return bytes;
  };
  const experimentPublication = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    row: Row,
    at: string,
    uses: readonly ("read" | "store" | "derive" | "export")[] = ["read"]
  ): Promise<VertexRecord> => {
    const descriptor = object(row["payload"]);
    const collection = identifier(row["collection_id"]);
    const experimentId = identifier(row["experiment_id"]);
    const artifactId = `experiment-${await ctx.hash({ collectionId: collection, experimentId })}`;
    const digest = digestString(row["content_sha256"]);
    const objectKey = vertexQualifiedObjectKey(
      scope,
      collection,
      "manifest",
      digest
    );
    if (
      (await ctx.hash(descriptor)) !== row["record_hash"] ||
      descriptor["profile"] !== "vertex-private-experiment-publication-v1" ||
      descriptor["accountAlias"] !== scope.accountAlias ||
      descriptor["environment"] !== scope.environment ||
      descriptor["collectionId"] !== collection ||
      descriptor["experimentId"] !== experimentId ||
      row["artifact_id"] !== artifactId ||
      descriptor["artifactId"] !== artifactId ||
      descriptor["contentSha256"] !== digest ||
      row["object_key"] !== objectKey ||
      descriptor["objectKey"] !== objectKey ||
      descriptor["byteLength"] !== row["byte_length"]
    )
      fail("integrity");
    await ctx.authorize(principal, scope, collection, artifactId, "read", at);
    for (const use of uses) {
      await currentRights(
        tx,
        principal,
        scope,
        collection,
        identifier(descriptor["rightsPolicyId"]),
        use,
        at,
        identifier(descriptor["rightsVersion"])
      );
    }
    // A stored provenance receipt never substitutes for current dependency rights.
    for (const pin of array(descriptor["dependencyPins"], 64).map(object)) {
      await ctx.authorize(
        principal,
        scope,
        collection,
        identifier(pin["artifactId"]),
        "read",
        at
      );
      for (const use of uses) {
        await currentRights(
          tx,
          principal,
          scope,
          collection,
          identifier(pin["rightsPolicyId"]),
          use,
          at,
          identifier(pin["rightsVersion"])
        );
      }
    }
    // Inspect the original handoff even for an omitted descriptor field: a
    // declared mapping is a required dependency, not optional review metadata.
    const bytes = await objectRead(scope, objectKey, digest);
    let original: unknown;
    try {
      original = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
    } catch {
      return fail("integrity");
    }
    const handoff = await parse("WorkerExperimentHandoff", original);
    const canonical = ctx.encode(handoff);
    if (
      handoff["experimentId"] !== experimentId ||
      (await ctx.hash(handoff)) !== digest ||
      bytes.byteLength !== canonical.byteLength ||
      !bytes.every((byte, index) => byte === canonical[index])
    )
      fail("integrity");
    if (
      descriptor["sourceReviewPins"] === undefined &&
      array(object(handoff["hypothesis"])["citations"], 64)
        .map(object)
        .some((citation) =>
          string(citation["locator"]).includes(":mapping-sha256:")
        )
    )
      fail("integrity");
    if (descriptor["sourceReviewPins"] !== undefined) {
      await experimentSources(
        tx,
        principal,
        scope,
        collection,
        identifier(descriptor["producerPrincipalId"]),
        handoff,
        array(descriptor["dependencyPins"], 64).map(object),
        experimentSourcePins(descriptor["sourceReviewPins"]),
        at
      );
    }
    return descriptor;
  };
  const experimentDependency = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    strategyId: string,
    pin: VertexRecord,
    at: string
  ): Promise<VertexRecord> => {
    const artifactId = identifier(pin["artifactId"]);
    const metadata = await ctx.artifact(
      tx,
      principal,
      scope,
      collection,
      artifactId,
      "read",
      at
    );
    const pinContract =
      metadata?.contractName === "StrategySpec" ||
      metadata?.contractName === "DatasetManifest" ||
      metadata?.contractName === "ResearchEvidence"
        ? metadata.contractName
        : null;
    if (
      !metadata ||
      metadata.artifactSha256 !== pin["artifactSha256"] ||
      metadata.rights.policyId !== pin["rightsPolicyId"] ||
      pinContract === null
    )
      return fail("denied");
    const source = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${artifactId} and collection_key = ${collection} and contract_name = ${metadata.contractName}`
    );
    if (
      !source ||
      source["record_hash"] !== pin["artifactSha256"] ||
      source["artifact_sha256"] !== pin["artifactSha256"] ||
      (await ctx.hash(source["payload"])) !== pin["artifactSha256"]
    )
      return fail("integrity");
    const record = await ctx.validate(pinContract, source["payload"]);
    if ((await ctx.hash(record)) !== pin["artifactSha256"]) fail("integrity");
    if (metadata.contractName === "ResearchEvidence") {
      if (record["collectionId"] !== collection) fail("integrity");
      const membership = await one(
        tx,
        "vertex_claim_evidence",
        scope,
        sql`artifact_id = ${artifactId} and collection_id = ${collection} and snapshot_id = ${record["snapshotId"]} and evidence_id = ${record["evidenceId"]}`
      );
      const generation = await one(
        tx,
        "vertex_collection_generations",
        scope,
        sql`collection_id = ${collection} and snapshot_id = ${record["snapshotId"]}`
      );
      if (!(membership && generation)) fail("denied");
    }
    // Generic current review semantics: latest first (including rejection), exact
    // hash/scope/strategy and the atomic reviewed-artifact link, not evidence-only.
    const latest = await one(
      tx,
      "vertex_reviews",
      scope,
      sql`collection_key = ${collection} and artifact_id = ${artifactId} and purpose = 'research'`,
      sql`order by reviewed_at_ns desc, review_id desc`
    );
    if (
      !latest ||
      (await ctx.hash(latest["payload"])) !== latest["record_hash"]
    )
      return fail("stale");
    const review = await ctx.validate("AcceptedReview", latest["payload"]);
    if (
      review["accountAlias"] !== scope.accountAlias ||
      review["environment"] !== scope.environment ||
      review["collectionId"] !== collection ||
      review["artifactId"] !== artifactId ||
      review["artifactSha256"] !== pin["artifactSha256"] ||
      review["reviewId"] !== pin["reviewId"] ||
      review["reviewVersion"] !== pin["reviewVersion"] ||
      review["strategyVersion"] !== strategyId ||
      review["purpose"] !== "research" ||
      review["decision"] !== "accepted" ||
      time(review["reviewedAt"]) > time(at) ||
      time(review["expiresAt"]) <= time(at)
    )
      fail("stale");
    const linked = await one(
      tx,
      "vertex_reviewed_artifact_links",
      scope,
      sql`review_id = ${review["reviewId"]} and collection_key = ${collection} and artifact_id = ${artifactId} and artifact_sha256 = ${pin["artifactSha256"]}`
    );
    if (!linked) fail("denied");
    await ctx.authorize(
      principal,
      scope,
      collection,
      identifier(review["reviewId"]),
      "read",
      at
    );
    await ctx.authorize(
      { actorId: identifier(review["actorId"]) },
      scope,
      collection,
      artifactId,
      "review",
      at
    );
    for (const use of ["read", "store", "derive", "export"] as const) {
      await currentRights(
        tx,
        principal,
        scope,
        collection,
        identifier(pin["rightsPolicyId"]),
        use,
        at,
        identifier(pin["rightsVersion"])
      );
    }
    return {
      contractName: metadata.contractName,
      record,
      objectKey: metadata.objectKey,
    };
  };
  // Sidecars never expand the exact strategy/dataset/citation dependency cover.
  // Only an original handoff citation's claim-map digest can require one.
  const experimentSourcePins = (raw: unknown): VertexRecord[] => {
    const pins = array(raw, 64).map(object);
    const keys = [
      "collectionId",
      "evidenceId",
      "artifactId",
      "artifactSha256",
      "reviewId",
      "reviewVersion",
      "rightsPolicyId",
      "rightsVersion",
    ]
      .sort()
      .join(",");
    if (
      pins.length === 0 ||
      new Set(pins.map((pin) => pin["evidenceId"])).size !== pins.length ||
      new Set(pins.map((pin) => pin["artifactId"])).size !== pins.length
    )
      fail("integrity");
    for (const pin of pins) {
      if (Object.keys(pin).sort().join(",") !== keys) fail("integrity");
      for (const key of [
        "collectionId",
        "evidenceId",
        "artifactId",
        "reviewId",
        "reviewVersion",
        "rightsPolicyId",
        "rightsVersion",
      ]) {
        identifier(pin[key]);
      }
      digestString(pin["artifactSha256"]);
    }
    return pins.sort((left, right) =>
      string(left["artifactId"]) < string(right["artifactId"]) ? -1 : 1
    );
  };
  const experimentSources = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    producerId: string,
    handoff: VertexRecord,
    dependencyPins: readonly VertexRecord[],
    pins: readonly VertexRecord[],
    at: string
  ): Promise<void> => {
    const hypothesis = object(handoff["hypothesis"]);
    const citations = array(hypothesis["citations"], 64).map(object);
    const required = new Map<string, VertexRecord[]>();
    const rechecks: ((now: string) => Promise<unknown>)[] = [];
    for (const citation of citations) {
      const locator = string(citation["locator"]);
      if (!locator.includes(":mapping-sha256:")) continue;
      const match =
        /^page:([1-9]\d*):normalized-char:(0|[1-9]\d*):length:([1-9]\d*):claim:(.+):mapping-sha256:([0-9a-f]{64})$/.exec(
          locator
        );
      if (!match) fail("integrity");
      const digest = requirePresent(
        requirePresent(match, "match")[5],
        "match![5]"
      );
      required.set(digest, [...(required.get(digest) ?? []), citation]);
    }
    if (required.size !== pins.length) fail("integrity");
    const checked = new Set<string>();
    for (const pin of pins) {
      if (
        pin["collectionId"] !== collection ||
        dependencyPins.some(
          (dependency) => dependency["artifactId"] === pin["artifactId"]
        )
      )
        fail("denied");
      const checkSource = async (now: string) => {
        if (time(now) < time(at)) fail("stale");
        // Transaction-bound latest review, including superseding rejection.
        const latest = await createQueryOperations(
          boundContext(tx, now, scope)
        ).getAcceptedEvidence(
          principal,
          scope,
          collection,
          identifier(pin["evidenceId"])
        );
        if (
          !latest ||
          latest.artifact.artifactId !== pin["artifactId"] ||
          latest.artifact.artifactSha256 !== pin["artifactSha256"] ||
          latest.review["reviewId"] !== pin["reviewId"] ||
          latest.review["reviewVersion"] !== pin["reviewVersion"] ||
          latest.review["accountAlias"] !== scope.accountAlias ||
          latest.review["environment"] !== scope.environment ||
          latest.review["collectionId"] !== collection ||
          latest.review["purpose"] !== "research" ||
          latest.review["decision"] !== "accepted" ||
          time(latest.review["reviewedAt"]) > time(now) ||
          time(latest.review["expiresAt"]) <= time(now)
        )
          return fail("stale");
        if (
          latest.artifact.rights.policyId !== pin["rightsPolicyId"] ||
          latest.evidence["rightsPolicyId"] !== pin["rightsPolicyId"]
        )
          fail("denied");
        await ctx.authorize(
          principal,
          scope,
          collection,
          identifier(pin["artifactId"]),
          "read",
          now
        );
        await ctx.authorize(
          { actorId: identifier(latest.review["actorId"]) },
          scope,
          collection,
          identifier(pin["artifactId"]),
          "review",
          now
        );
        for (const use of ["read", "derive", "export"] as const) {
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            identifier(pin["rightsPolicyId"]),
            use,
            now,
            identifier(pin["rightsVersion"])
          );
        }
        return latest;
      };
      const current = await checkSource(at);
      rechecks.push(async (now) => {
        await checkSource(now);
      });
      const evidence = current.evidence;
      const sourceIdentity = object(evidence["sourceIdentity"]);
      const digest = digestString(evidence["contentHash"]);
      if (
        !required.has(digest) ||
        checked.has(digest) ||
        evidence["evidenceId"] !== pin["evidenceId"] ||
        evidence["collectionId"] !== collection ||
        evidence["sourceType"] !== "derived-analysis" ||
        evidence["untrustedContent"] !== true ||
        sourceIdentity["contentHash"] !== digest ||
        sourceIdentity["snapshotId"] !== evidence["snapshotId"] ||
        current.artifact.sourceContentSha256 !== digest ||
        current.artifact.rights.policyId !== pin["rightsPolicyId"] ||
        evidence["rightsPolicyId"] !== pin["rightsPolicyId"]
      )
        fail("integrity");
      checked.add(digest);
      const evidenceBytes = await objectRead(
        scope,
        current.artifact.objectKey,
        digestString(pin["artifactSha256"])
      );
      const evidenceCanonical = ctx.encode(evidence);
      if (
        (await ctx.hash(evidence)) !== pin["artifactSha256"] ||
        evidenceBytes.byteLength !== evidenceCanonical.byteLength ||
        !evidenceBytes.every((byte, index) => byte === evidenceCanonical[index])
      )
        fail("integrity");
      const bytes = await objectRead(
        scope,
        vertexQualifiedObjectKey(scope, collection, "content", digest),
        digest
      );
      let mapping: VertexRecord;
      try {
        mapping = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
      } catch {
        return fail("integrity");
      }
      const canonical = ctx.encode(mapping);
      if (
        (await ctx.hash(mapping)) !== digest ||
        bytes.byteLength !== canonical.byteLength ||
        !bytes.every((byte, index) => byte === canonical[index]) ||
        Object.keys(mapping).sort().join(",") !==
          [
            "format",
            "mappingId",
            "revision",
            "scope",
            "hypothesis",
            "claims",
            "executionAuthority",
          ]
            .sort()
            .join(",") ||
        mapping["format"] !== "vertex-reviewed-paper-claim-map-v1" ||
        mapping["executionAuthority"] !== "none" ||
        typeof mapping["revision"] !== "number" ||
        !Number.isSafeInteger(mapping["revision"]) ||
        mapping["revision"] < 1
      )
        fail("integrity");
      identifier(mapping["mappingId"]);
      const expectedScope = {
        actorId: producerId,
        ...scope,
        collectionId: collection,
        snapshotId: identifier(evidence["snapshotId"]),
      };
      if (
        (await ctx.hash(mapping["scope"])) !== (await ctx.hash(expectedScope))
      )
        fail("integrity");
      const { citations: omittedCitations, ...expectedHypothesis } = hypothesis;
      if (
        (await ctx.hash(mapping["hypothesis"])) !==
        (await ctx.hash(expectedHypothesis))
      )
        fail("integrity");
      const claims = array(mapping["claims"], 64).map(object);
      if (
        claims.length === 0 ||
        new Set(claims.map((claim) => claim["claimId"])).size !== claims.length
      )
        fail("integrity");
      const projected: VertexRecord[] = [];
      for (const claim of claims) {
        if (
          Object.keys(claim).sort().join(",") !==
          [
            "claimId",
            "sourceId",
            "ssrnId",
            "versionId",
            "rawPaperHash",
            "mediaType",
            "metadataHash",
            "pageNumber",
            "pageTextHash",
            "sourceLocator",
            "normalizedStart",
            "quote",
            "statement",
            "claimKind",
            "evidenceId",
            "evidenceHash",
            "reviewId",
            "reviewRevision",
            "sourceSnapshotId",
            "urlOrDoi",
            "author",
            "rightsReceiptId",
          ]
            .sort()
            .join(",")
        )
          fail("integrity");
        for (const key of [
          "claimId",
          "sourceId",
          "versionId",
          "evidenceId",
          "reviewId",
          "sourceSnapshotId",
          "rightsReceiptId",
        ]) {
          identifier(claim[key]);
        }
        for (const key of [
          "rawPaperHash",
          "metadataHash",
          "pageTextHash",
          "evidenceHash",
        ]) {
          digestString(claim[key]);
        }
        if (
          !/^[1-9]\d{0,11}$/.test(string(claim["ssrnId"])) ||
          claim["sourceId"] !==
            `ssrn:${claim["ssrnId"]}:${claim["versionId"]}` ||
          !["text/plain", "application/pdf"].includes(
            string(claim["mediaType"])
          ) ||
          claim["claimKind"] !== "source-asserted" ||
          typeof claim["pageNumber"] !== "number" ||
          !Number.isSafeInteger(claim["pageNumber"]) ||
          claim["pageNumber"] < 1 ||
          claim["pageNumber"] > 64 ||
          typeof claim["normalizedStart"] !== "number" ||
          !Number.isSafeInteger(claim["normalizedStart"]) ||
          claim["normalizedStart"] < 0 ||
          claim["normalizedStart"] > 1800 ||
          typeof claim["reviewRevision"] !== "number" ||
          !Number.isSafeInteger(claim["reviewRevision"]) ||
          claim["reviewRevision"] < 1
        )
          fail("integrity");
        for (const key of ["quote", "statement", "urlOrDoi", "author"]) {
          if (
            string(claim[key]).trim().length === 0 ||
            string(claim[key]).length > 65_536
          )
            fail("integrity");
        }
        const quote = [...string(claim["quote"])];
        if (
          quote.length > 1800 ||
          claim["sourceLocator"] !==
            `page:${claim["pageNumber"]}:normalized-char:0`
        )
          fail("integrity");
        const matches = dependencyPins.filter(
          (candidate) => candidate["artifactSha256"] === claim["evidenceHash"]
        );
        if (matches.length !== 1) fail("integrity");
        const dependencyPin = requirePresent(matches[0], "matches[0]");
        const dependency = await experimentDependency(
          tx,
          principal,
          scope,
          collection,
          identifier(object(handoff["strategy"])["id"]),
          dependencyPin,
          at
        );
        rechecks.push(async (now) => {
          await experimentDependency(
            tx,
            principal,
            scope,
            collection,
            identifier(object(handoff["strategy"])["id"]),
            dependencyPin,
            now
          );
        });
        const record = object(dependency["record"]);
        const identity = object(record["sourceIdentity"]);
        const version = string(dependencyPin["reviewVersion"]).split(".");
        if (version.length !== 3 || version.some((part) => !/^\d+$/.test(part)))
          fail("integrity");
        const revision = BigInt(
          `1${version.map((part) => `${String(part.length).padStart(2, "0")}${part}`).join("")}`
        );
        const page = [...string(record["claim"])];
        if (
          dependency["contractName"] !== "ResearchEvidence" ||
          record["evidenceId"] !== claim["evidenceId"] ||
          record["collectionId"] !== collection ||
          record["snapshotId"] !== evidence["snapshotId"] ||
          record["sourceType"] !== "paper" ||
          identity["provider"] !== "ssrn" ||
          identity["sourceId"] !== claim["sourceId"] ||
          identity["snapshotId"] !== claim["sourceSnapshotId"] ||
          claim["sourceSnapshotId"] !== evidence["snapshotId"] ||
          record["contentHash"] !== claim["rawPaperHash"] ||
          identity["contentHash"] !== claim["rawPaperHash"] ||
          record["sourceLocator"] !== claim["sourceLocator"] ||
          record["sourceUri"] !==
            `https://ssrn.com/abstract=${claim["ssrnId"]}` ||
          record["attribution"] !== claim["author"] ||
          page.length > 1800 ||
          page
            .slice(
              claim["normalizedStart"],
              claim["normalizedStart"] + quote.length
            )
            .join("") !== claim["quote"] ||
          dependencyPin["reviewId"] !== claim["reviewId"] ||
          revision !== BigInt(claim["reviewRevision"])
        )
          fail("integrity");
        const recordBytes = await objectRead(
          scope,
          string(dependency["objectKey"]),
          digestString(claim["evidenceHash"])
        );
        const recordCanonical = ctx.encode(record);
        if (
          recordBytes.byteLength !== recordCanonical.byteLength ||
          !recordBytes.every((byte, index) => byte === recordCanonical[index])
        )
          fail("integrity");
        projected.push({
          sourceId: claim["sourceId"],
          artifactHash: claim["evidenceHash"],
          locator: `page:${claim["pageNumber"]}:normalized-char:${claim["normalizedStart"]}:length:${quote.length}:claim:${claim["claimId"]}:mapping-sha256:${digest}`,
          urlOrDoi: claim["urlOrDoi"],
          author: claim["author"],
          sourceVersion: claim["versionId"],
          rightsReceiptId: claim["rightsReceiptId"],
          claimKind: claim["claimKind"],
        });
      }
      if (
        (await ctx.hash(projected)) !==
        (await ctx.hash(
          requirePresent(required.get(digest), "required.get(digest)")
        ))
      )
        fail("integrity");
    }
    // Object reads above can outlive a review/right. Recheck authority after IO,
    // as well as when this helper is run by the outer transaction-final checks.
    for (const check of rechecks) {
      const now = ctx.now();
      if (time(now) < time(at)) fail("stale");
      await check(now);
    }
  };
  const staged = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    artifactId: string,
    collection: string | null,
    at: string,
    jobId?: string
  ): Promise<Row> => {
    const row = await one(
      tx,
      "vertex_worker_stages",
      scope,
      sql`artifact_id = ${artifactId} and collection_key = ${collectionKey(collection)}`
    );
    if (!row || (jobId !== undefined && row["job_id"] !== jobId))
      return fail("denied");
    const value = object(row["payload"]);
    if ((await ctx.hash(value)) !== row["request_hash"]) fail("integrity");
    await currentRights(
      tx,
      principal,
      scope,
      collection,
      string(value["rightsPolicyId"]),
      "read",
      at,
      string(value["rightsVersion"])
    );
    return row;
  };
  // Restricted historical graph reconstruction shared by commit and read. This
  // never resolves a caller-provided raw hash outside its immutable manifest.
  const historicalDataset = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    producerId: string,
    record: VertexRecord,
    at: string
  ) => {
    const semantics = object(record["historicalSemantics"]);
    if (
      record["provider"] !== "ibkr" ||
      record["calendar"] !== null ||
      semantics["profile"] !== "vertex-ibkr-historical-bars-v1" ||
      semantics["researchAdmission"] !== "unqualified" ||
      semantics["pointInTime"] !== false
    )
      return fail("denied");
    const sources = array(record["sources"], 1).map(object);
    if (sources.length !== 1) return fail("integrity");
    const source = requirePresent(sources[0], "sources[0]");
    const load = async (
      artifactId: string,
      digest: string,
      isCanonical: boolean,
      mediaType: string
    ) => {
      const stage = await staged(
        tx,
        principal,
        scope,
        artifactId,
        collection,
        at,
        producerId
      );
      const descriptor = object(stage["payload"]);
      const key = vertexQualifiedObjectKey(
        scope,
        collection,
        isCanonical ? "manifest" : "content",
        digest
      );
      if (
        stage["content_sha256"] !== digest ||
        stage["canonical_sha256"] !== (isCanonical ? digest : null) ||
        stage["object_key"] !== key ||
        descriptor["accountAlias"] !== scope.accountAlias ||
        descriptor["environment"] !== scope.environment ||
        descriptor["collectionId"] !== collection ||
        descriptor["jobId"] !== producerId ||
        descriptor["artifactId"] !== artifactId ||
        descriptor["contentSha256"] !== digest ||
        descriptor["canonicalSha256"] !== stage["canonical_sha256"] ||
        descriptor["contentType"] !== mediaType ||
        descriptor["rightsPolicyId"] !== record["entitlementPolicyId"] ||
        array(descriptor["lineageArtifactIds"], 64).length !== 0
      )
        return fail("integrity");
      await ctx.authorize(principal, scope, collection, artifactId, "read", at);
      await currentRights(
        tx,
        principal,
        scope,
        collection,
        identifier(descriptor["rightsPolicyId"]),
        "derive",
        at,
        identifier(descriptor["rightsVersion"])
      );
      const bytes = await objectRead(scope, key, digest);
      if (bytes.byteLength !== stage["byte_length"]) return fail("integrity");
      let value: VertexRecord;
      try {
        value = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
      } catch {
        return fail("integrity");
      }
      return {
        stage,
        descriptor,
        bytes,
        value,
        ref: { artifactId, artifactSha256: digest },
      };
    };
    const content = await load(
      identifier(record["storageRef"]),
      digestString(record["contentHash"]),
      false,
      "application/json"
    );
    if (
      Object.keys(content.value).sort().join(",") !==
      "acquisition,availabilitySemantics,capture,effectiveRequestPointer,instrumentId,limitations,numericSemantics,orderingSemantics,profile,providerWindowPointer,qualifiedContractPointer,records,request,rowBindings,semantics,snapshotIdentitySemantics,source"
    )
      fail("integrity");
    const canonical = ctx.encode(content.value);
    if (
      (await ctx.hash(content.value)) !== record["contentHash"] ||
      canonical.byteLength !== content.bytes.byteLength ||
      !content.bytes.every((byte, index) => byte === canonical[index])
    )
      fail("integrity");
    const capture = await load(
      `blob-${digestString(source["contentHash"])}`,
      digestString(source["contentHash"]),
      false,
      "application/vnd.vertex.ibkr-history-capture.v1+json"
    );
    const requestRef = object(content.value["request"]);
    if (
      Object.keys(requestRef).sort().join(",") !==
      "artifactId,bytesBase64,sha256"
    )
      fail("integrity");
    const request = await load(
      `ibkr-history-intent-${await ctx.hash({ jobId: producerId, requestSha256: digestString(requestRef["sha256"]) })}`,
      digestString(requestRef["sha256"]),
      true,
      "application/json"
    );
    const requestBytes = ctx.encode(request.value);
    if (
      requestRef["artifactId"] !== request.ref.artifactId ||
      requestRef["bytesBase64"] !== canonicalBase64(request.bytes) ||
      (await ctx.hash(request.value)) !== request.ref.artifactSha256 ||
      requestBytes.byteLength !== request.bytes.byteLength ||
      !request.bytes.every((byte, index) => byte === requestBytes[index])
    )
      fail("integrity");
    const raw = capture.value;
    if (
      Object.keys(raw).sort().join(",") !==
      "acquisition,admissible,attempts,cancel_status,capture_complete,data_valid,effective_request,events,limitations,market_coverage,owner,owner_slot_quarantined,point_in_time_adjustments,provider_window,qualified_contract,records,request,request_sha256,schema_version,sdk,source_response_complete,status"
    )
      fail("integrity");
    const kind = object(request.value["kind"]);
    const limits = object(request.value["limits"]);
    if (
      request.value["schema_version"] !== "1.0.0" ||
      kind["type"] !== "bars" ||
      !["TRADES", "ADJUSTED_LAST"].includes(string(kind["what_to_show"])) ||
      !["1 min", "1 day"].includes(string(kind["bar_size"])) ||
      raw["schema_version"] !== "1.0.0" ||
      raw["request_sha256"] !== request.ref.artifactSha256 ||
      (await ctx.hash(raw["request"])) !== request.ref.artifactSha256 ||
      raw["source_response_complete"] !== true ||
      raw["capture_complete"] !== true ||
      raw["data_valid"] !== true ||
      raw["admissible"] !== false ||
      raw["market_coverage"] !== "unqualified" ||
      raw["point_in_time_adjustments"] !== false ||
      raw["owner_slot_quarantined"] !== false ||
      raw["status"] !== "source-response-complete"
    )
      fail("integrity");
    if (
      typeof limits["max_bytes"] !== "number" ||
      capture.bytes.byteLength > limits["max_bytes"] ||
      limits["max_bytes"] > 1_048_576 ||
      typeof limits["max_rows"] !== "number" ||
      limits["max_rows"] < 1 ||
      limits["max_rows"] > 5000
    )
      fail("integrity");
    const sdk = object(raw["sdk"]);
    if (
      sdk["version"] !== "ibapi=3.3.0" ||
      sdk["extension"] !== "vertex-history-strict-v1" ||
      sdk["upstream_archive_sha256"] !==
        "fc5651f11bacdf138a1a910dc075c21e425912ff767e7f3e237b9fe14d9f3f76"
    )
      fail("integrity");
    const qualified = object(raw["qualified_contract"]);
    if (
      Object.keys(qualified).sort().join(",") !==
      "decoded_contract,qualification_capture,semantics"
    )
      fail("integrity");
    const contractSemantics = object(qualified["semantics"]);
    if (
      Object.keys(contractSemantics).sort().join(",") !==
      "calendar_ref,details_sha256,price_magnifier,price_precision,size_unit,timezone,volume_unit"
    )
      fail("integrity");
    const qualification = object(qualified["qualification_capture"]);
    if (
      Object.keys(qualification).sort().join(",") !==
        "encoding,observed_unix_ns,original_bytes_base64,raw_wire,sha256" ||
      qualification["encoding"] !== "ibapi-serde-json" ||
      qualification["raw_wire"] !== false ||
      typeof qualification["original_bytes_base64"] !== "string" ||
      qualification["original_bytes_base64"].length === 0 ||
      qualification["original_bytes_base64"].length > 87_384
    )
      fail("integrity");
    const qualificationDigest = digestString(qualification["sha256"]);
    const qualificationBytes = decode(qualification["original_bytes_base64"]);
    // Original SDK-serde bytes may contain floats; never canonicalize them.
    // Their actual contract equality is enforced by the qualified native owner.
    if (
      qualificationBytes.byteLength === 0 ||
      qualificationBytes.byteLength > 65_536 ||
      (await ctx.digest(qualificationBytes)) !== qualificationDigest ||
      contractSemantics["details_sha256"] !== qualificationDigest
    )
      fail("integrity");
    const contract = object(qualified["decoded_contract"]);
    if (
      typeof contract["contract_id"] !== "number" ||
      !Number.isSafeInteger(contract["contract_id"]) ||
      contract["contract_id"] <= 0 ||
      contract["contract_id"] > 2_147_483_647
    )
      fail("integrity");
    const instrument = `ibkr-conid-${contract["contract_id"]}`;
    if (
      source["provider"] !== "ibkr" ||
      source["sourceId"] !== instrument ||
      source["snapshotId"] !== `ibkr-capture-${capture.ref.artifactSha256}` ||
      (await ctx.hash(record["instrumentUniverse"])) !==
        (await ctx.hash([instrument]))
    )
      fail("integrity");
    if (
      content.value["profile"] !== semantics["profile"] ||
      content.value["instrumentId"] !== instrument ||
      (await ctx.hash(content.value["source"])) !== (await ctx.hash(source)) ||
      (await ctx.hash(content.value["semantics"])) !==
        (await ctx.hash(semantics)) ||
      content.value["snapshotIdentitySemantics"] !==
        "vertex-capture-sha256-not-provider-snapshot" ||
      content.value["availabilitySemantics"] !==
        "actual-later-acquisition-not-historical-arrival" ||
      content.value["numericSemantics"] !==
        "unchanged-sdk-ieee754-bits-no-volume-or-price-unit-conversion" ||
      content.value["orderingSemantics"] !==
        "sdk-decoded-receive-order-not-exchange-tie-order"
    )
      fail("integrity");
    if (
      content.value["qualifiedContractPointer"] !== "/qualified_contract" ||
      content.value["effectiveRequestPointer"] !== "/effective_request" ||
      content.value["providerWindowPointer"] !== "/provider_window" ||
      (await ctx.hash(content.value["capture"])) !==
        (await ctx.hash({
          artifactId: capture.ref.artifactId,
          sha256: capture.ref.artifactSha256,
          mediaType: capture.descriptor["contentType"],
        }))
    )
      fail("integrity");
    const adjustment =
      kind["what_to_show"] === "TRADES"
        ? "split-adjusted-not-dividend-adjusted"
        : "split-and-dividend-adjusted";
    if (
      semantics["adjustment"] !== adjustment ||
      object(raw["effective_request"])["adjustment"] !== adjustment ||
      (await ctx.hash(content.value["limitations"])) !==
        (await ctx.hash(raw["limitations"]))
    )
      fail("integrity");
    const expectedEffective = {
      type: "bars",
      what_to_show: kind["what_to_show"],
      bar_size: kind["bar_size"],
      duration: `${kind["duration_days"]} D`,
      end_unix_seconds: kind["end_unix_seconds"],
      use_rth: kind["use_rth"],
      format_date: 2,
      keep_up_to_date: false,
      adjustment,
      end_semantics:
        kind["end_unix_seconds"] === null
          ? "provider-now-single-request"
          : "explicit-UTC-second",
    };
    if (
      (await ctx.hash(raw["effective_request"])) !==
        (await ctx.hash(expectedEffective)) ||
      semantics["intervalSemantics"] !==
        "provider-terminal-window-not-certified-market-coverage"
    )
      fail("integrity");
    const acquisition = object(raw["acquisition"]);
    if (
      Object.keys(acquisition).sort().join(",") !==
      "elapsed_monotonic_ns,finished_unix_ns,started_unix_ns"
    )
      fail("integrity");
    const clock = (rawNs: unknown): bigint => {
      const ns = string(rawNs);
      if (!/^[0-9]{1,30}$/.test(ns)) return fail("integrity");
      return BigInt(ns);
    };
    const started = clock(acquisition["started_unix_ns"]);
    const finished = clock(acquisition["finished_unix_ns"]);
    if (
      started <= 0n ||
      finished < started ||
      time(record["asOfAt"]) !== finished ||
      time(record["captureTime"]) < finished ||
      time(record["endAtExclusive"]) > finished ||
      time(record["captureTime"]) > time(at) ||
      (await ctx.hash(content.value["acquisition"])) !==
        (await ctx.hash(acquisition)) ||
      time(request.descriptor["createdAt"]) > started ||
      time(capture.descriptor["createdAt"]) < finished
    )
      fail("integrity");
    if (
      clock(qualification["observed_unix_ns"]) <= 0n ||
      clock(qualification["observed_unix_ns"]) > started
    )
      fail("integrity");
    clock(acquisition["elapsed_monotonic_ns"]);
    const window = object(raw["provider_window"]);
    if (Object.keys(window).sort().join(",") !== "end,start") fail("integrity");
    const terminalInstant = (value: unknown): bigint => {
      const stamp = object(value);
      if (
        Object.keys(stamp).sort().join(",") !== "offset_seconds,unix_ns" ||
        typeof stamp["offset_seconds"] !== "number" ||
        !Number.isInteger(stamp["offset_seconds"]) ||
        Math.abs(stamp["offset_seconds"]) > 86_399
      )
        return fail("integrity");
      const ns = clock(stamp["unix_ns"]);
      if (ns < 946684800000000000n || ns > 4102444800000000000n)
        return fail("integrity");
      return ns;
    };
    const windowStart = terminalInstant(window["start"]);
    const windowEnd = terminalInstant(window["end"]);
    if (
      windowStart >= windowEnd ||
      windowEnd > finished ||
      time(record["startAtInclusive"]) !== windowStart ||
      time(record["endAtExclusive"]) !== windowEnd
    )
      fail("integrity");
    if (kind["what_to_show"] === "TRADES") {
      if (
        typeof kind["end_unix_seconds"] !== "number" ||
        !Number.isSafeInteger(kind["end_unix_seconds"]) ||
        windowEnd > BigInt(kind["end_unix_seconds"]) * 1_000_000_000n
      )
        fail("integrity");
    } else if (kind["end_unix_seconds"] !== null) fail("integrity");
    // Do not turn the SDK's '<N> D' duration into invented UTC/DST/calendar
    // arithmetic. Root bounds are proven provider terminal instants only.
    const records = array(raw["records"], 5000).map(object);
    const bindings = array(content.value["rowBindings"], 5000).map(object);
    if (
      records.length > limits["max_rows"] ||
      bindings.length !== records.length ||
      (await ctx.hash(content.value["records"])) !== (await ctx.hash(records))
    )
      fail("integrity");
    for (const [ordinal, row] of records.entries()) {
      if (
        Object.keys(row).sort().join(",") !==
          "acquired_unix_ns,close_f64_bits,decoded_receive_ordinal,high_f64_bits,low_f64_bits,open_f64_bits,provider_timestamp,trade_count,type,volume_f64_bits,wap_f64_bits" ||
        row["type"] !== "bar" ||
        row["decoded_receive_ordinal"] !== ordinal ||
        typeof row["trade_count"] !== "number" ||
        !Number.isInteger(row["trade_count"]) ||
        row["trade_count"] < -2_147_483_648 ||
        row["trade_count"] > 2_147_483_647 ||
        clock(row["acquired_unix_ns"]) < started ||
        clock(row["acquired_unix_ns"]) > finished
      )
        fail("integrity");
      for (const field of ["open", "high", "low", "close", "volume", "wap"]) {
        if (!/^[0-9a-f]{16}$/.test(string(row[`${field}_f64_bits`])))
          fail("integrity");
      }
      const stamp = object(row["provider_timestamp"]);
      if (kind["bar_size"] === "1 day") {
        if (
          Object.keys(stamp).sort().join(",") !== "kind,sdk_decoded_label" ||
          stamp["kind"] !== "date" ||
          !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(
            string(stamp["sdk_decoded_label"])
          )
        )
          fail("integrity");
      } else {
        const instant = object(stamp["value"]);
        if (
          Object.keys(stamp).sort().join(",") !== "kind,value" ||
          stamp["kind"] !== "datetime" ||
          Object.keys(instant).sort().join(",") !== "offset_seconds,unix_ns" ||
          typeof instant["offset_seconds"] !== "number" ||
          !Number.isInteger(instant["offset_seconds"]) ||
          Math.abs(instant["offset_seconds"]) > 86_399
        )
          fail("integrity");
        if (
          clock(instant["unix_ns"]) < windowStart ||
          clock(instant["unix_ns"]) > windowEnd
        )
          fail("integrity");
      }
      if (
        (await ctx.hash(bindings[ordinal])) !==
        (await ctx.hash({
          ordinal,
          captureJsonPointer: `/records/${ordinal}`,
          rowSha256: await ctx.hash(row),
        }))
      )
        fail("integrity");
    }
    if (
      content.descriptor["rightsVersion"] !==
        capture.descriptor["rightsVersion"] ||
      request.descriptor["rightsVersion"] !==
        capture.descriptor["rightsVersion"]
    )
      fail("integrity");
    return { content, capture, request, source };
  };
  const readBacktestRunProof = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    at: string,
    value: VertexRecord,
    finalChecks: BacktestSourceCheck[]
  ) => {
    const collection = identifier(value["collectionId"]);
    const reference = (
      rawRef: unknown
    ): { artifactId: string; artifactSha256: string } => {
      const ref = object(rawRef);
      return {
        artifactId: identifier(ref["artifactId"]),
        artifactSha256: digestString(ref["artifactSha256"]),
      };
    };
    const artifact = reference(value["artifact"]);
    const plannedRun = reference(value["plannedRun"]);
    const results = reference(value["results"]);
    const recipe = reference(value["recipe"]);
    if (
      new Set([
        artifact.artifactId,
        plannedRun.artifactId,
        results.artifactId,
        recipe.artifactId,
      ]).size !== 4 ||
      artifact.artifactId !== `backtest-run-${artifact.artifactSha256}` ||
      results.artifactId !== `backtest-results-${results.artifactSha256}`
    )
      fail("integrity");
    const original = async (
      key: string,
      digest: string,
      canonical = true
    ): Promise<{ bytes: Uint8Array; record: VertexRecord }> => {
      const bytes = await objectRead(scope, key, digest);
      let record: VertexRecord;
      try {
        record = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
      } catch {
        return fail("integrity");
      }
      if (canonical) {
        const encoded = ctx.encode(record);
        if (
          (await ctx.hash(record)) !== digest ||
          encoded.byteLength !== bytes.byteLength ||
          !bytes.every((byte, index) => byte === encoded[index])
        )
          fail("integrity");
      }
      return { bytes, record };
    };
    const originalDatasetScopes = new Map<
      string,
      { collection: string | null; digest: string }
    >();
    const committed = async (
      ref: { artifactId: string; artifactSha256: string },
      name:
        | "BacktestRun"
        | "ResearchEvidence"
        | "StrategySpec"
        | "DatasetManifest",
      sourceCollection: string | null = collection
    ) => {
      if (
        sourceCollection !== collection &&
        (sourceCollection !== null || name !== "DatasetManifest")
      )
        fail("denied");
      const metadata = await ctx.artifact(
        tx,
        principal,
        scope,
        sourceCollection,
        ref.artifactId,
        "read",
        at
      );
      const row = await one(
        tx,
        "vertex_records",
        scope,
        sql`artifact_id = ${ref.artifactId} and collection_key = ${collectionKey(sourceCollection)} and contract_name = ${name}`
      );
      if (
        !(metadata && row) ||
        metadata.contractName !== name ||
        metadata.artifactSha256 !== ref.artifactSha256 ||
        row["artifact_sha256"] !== ref.artifactSha256 ||
        row["record_hash"] !== ref.artifactSha256 ||
        (await ctx.hash(row["payload"])) !== ref.artifactSha256 ||
        metadata.objectKey !==
          vertexQualifiedObjectKey(
            scope,
            sourceCollection,
            "manifest",
            ref.artifactSha256
          ) ||
        metadata.contentType !== "application/json"
      )
        return fail("denied");
      const content = await original(metadata.objectKey, ref.artifactSha256);
      const record = await ctx.validate(name, content.record);
      if (
        (await ctx.hash(record)) !== row["record_hash"] ||
        content.bytes.byteLength !== metadata.byteLength
      )
        fail("integrity");
      const parents = array(metadata.lineageArtifactIds, 64).map(identifier);
      if (
        new Set(parents).size !== parents.length ||
        parents.includes(ref.artifactId)
      )
        fail("integrity");
      const links = await rows(
        tx,
        sql`select parent_artifact_id from vertex_artifact_lineage where ${scopeWhere(scope)} and artifact_id = ${ref.artifactId}`
      );
      if (
        (await ctx.hash(
          links.map((link) => identifier(link["parent_artifact_id"])).sort()
        )) !== (await ctx.hash([...parents].sort()))
      )
        fail("integrity");
      const check = async (now: string): Promise<void> => {
        if (time(now) < time(at)) fail("stale");
        const current = await ctx.artifact(
          tx,
          principal,
          scope,
          sourceCollection,
          ref.artifactId,
          "read",
          now
        );
        if (
          !current ||
          (await ctx.hash(current)) !== (await ctx.hash(metadata))
        )
          fail("stale");
        for (const parent of parents) {
          const pin = originalDatasetScopes.get(parent);
          const parentCollection = pin ? pin.collection : sourceCollection;
          const dependencyMetadata = await ctx.artifact(
            tx,
            principal,
            scope,
            parentCollection,
            parent,
            "read",
            now
          );
          if (
            !dependencyMetadata ||
            (pin && dependencyMetadata.artifactSha256 !== pin.digest)
          )
            fail("denied");
        }
      };
      // Parent scopes come from the exact producer recipe later in this
      // same transaction, never a scoped-first/global fallback.
      finalChecks.push(check);
      return { ...content, record, metadata, row, parents, ref };
    };
    // Neither root can be obtained from stages, even for matching bytes.
    const root = await committed(artifact, "BacktestRun");
    const planned = await committed(plannedRun, "BacktestRun");
    if (
      root.record["resultsRef"] !== results.artifactId ||
      root.record["runId"] !== planned.record["runId"] ||
      plannedRun.artifactId !== planned.record["runId"] ||
      planned.record["resultsRef"] !== null ||
      planned.record["reviewStatus"] !== "unreviewed" ||
      planned.record["forwardSampleCount"] !== 0 ||
      root.record["reviewStatus"] === "accepted"
    )
      fail("integrity");
    if (
      (await ctx.hash({
        ...root.record,
        resultsRef: null,
        reviewStatus: "unreviewed",
        forwardSampleCount: 0,
      })) !== plannedRun.artifactSha256
    )
      fail("integrity");
    for (const item of [root, planned]) {
      const version = await one(
        tx,
        "vertex_backtest_versions",
        scope,
        sql`artifact_id = ${item.ref.artifactId}`
      );
      if (
        !version ||
        version["run_id"] !== item.record["runId"] ||
        version["results_ref"] !== item.record["resultsRef"] ||
        version["strategy_artifact_id"] !== item.record["strategyVersion"] ||
        item.row["record_id"] !== item.record["runId"] ||
        item.row["version"] !== item.ref.artifactSha256
      )
        fail("integrity");
    }
    // The canonical root stage is provenance ONLY after both immutable
    // metadata and public record exist. It identifies the real producer.
    const rootStage = await one(
      tx,
      "vertex_worker_stages",
      scope,
      sql`artifact_id = ${artifact.artifactId} and collection_key = ${collection}`
    );
    if (!rootStage) return fail("denied");
    const producerId = identifier(rootStage["job_id"]);
    const producer = await one(
      tx,
      "vertex_worker_jobs",
      scope,
      sql`job_id = ${producerId}`
    );
    if (
      producer?.["state"] !== "succeeded" ||
      producer["outcome_hash"] === null ||
      !array(producer["output_artifact_ids"], 64).includes(artifact.artifactId)
    )
      return fail("denied");
    const producerLease = await parse("WorkerLease", producer["payload"]);
    const stableBinding = {
      kind: producerLease["kind"],
      researchPrincipalId: producerLease["researchPrincipalId"],
      payloadArtifactId: producerLease["payloadArtifactId"],
      payloadSha256: producerLease["payloadSha256"],
      policySelectionId: producerLease["policySelectionId"],
      policySelectionSha256: producerLease["policySelectionSha256"],
      deadlineAt: producerLease["deadlineAt"],
    };
    if (
      producerLease["kind"] !== "backtest" ||
      producerLease["jobId"] !== producerId ||
      producerLease["accountAlias"] !== scope.accountAlias ||
      producerLease["environment"] !== scope.environment ||
      producerLease["eventId"] !== producer["event_id"] ||
      producerLease["leaseId"] !== producer["lease_id"] ||
      producerLease["leaseEpoch"] !== producer["lease_epoch"] ||
      time(producerLease["leaseExpiresAt"]).toString() !==
        producer["lease_expires_at_ns"] ||
      time(producerLease["deadlineAt"]).toString() !==
        producer["deadline_at_ns"] ||
      (await ctx.hash({
        scope,
        eventId: producer["event_id"],
        ...stableBinding,
      })) !== producer["binding_hash"] ||
      producerId !==
        `job-${await ctx.hash({ scope, eventId: producer["event_id"] })}`
    )
      fail("integrity");
    const admitted = await one(
      tx,
      "vertex_worker_run_admissions",
      scope,
      sql`job_id = ${producerId}`
    );
    if (
      !admitted ||
      admitted["run_id"] !== producerId ||
      admitted["request_hash"] !== producerLease["payloadSha256"] ||
      admitted["lease_epoch"] !== producerLease["leaseEpoch"] ||
      time(admitted["admitted_at"]) > time(root.row["recorded_at"]) ||
      time(root.row["recorded_at"]) > time(at) ||
      time(root.row["recorded_at"]) >= time(producerLease["deadlineAt"]) ||
      time(root.row["recorded_at"]) >= time(producerLease["leaseExpiresAt"])
    )
      return fail("denied");
    const sourceGrant = await one(
      tx,
      "vertex_worker_service_grants",
      scope,
      sql`grant_id = ${producer["grant_id"]}`
    );
    if (!sourceGrant) return fail("denied");
    const producerGrant = await parse(
      "WorkerServiceGrant",
      sourceGrant["payload"]
    );
    if (
      time(producerGrant["issuedAt"]).toString() !==
        sourceGrant["issued_at_ns"] ||
      time(producerGrant["expiresAt"]).toString() !==
        sourceGrant["expires_at_ns"] ||
      producerGrant["revokedAt"] !== sourceGrant["revoked_at"]
    )
      fail("integrity");
    if (
      (await ctx.hash(producerGrant)) !== sourceGrant["record_hash"] ||
      producerGrant["grantId"] !== producer["grant_id"] ||
      producerGrant["servicePrincipalId"] !==
        sourceGrant["service_principal_id"] ||
      producerGrant["accountAlias"] !== scope.accountAlias ||
      producerGrant["environment"] !== scope.environment ||
      time(producerGrant["issuedAt"]) > time(admitted["admitted_at"]) ||
      time(producerGrant["expiresAt"]) <= time(root.row["recorded_at"]) ||
      (sourceGrant["revoked_at"] !== null &&
        time(sourceGrant["revoked_at"]) <= time(root.row["recorded_at"])) ||
      !["admitRun", "stageArtifact", "publishArtifact", "complete"].every(
        (op) => array(producerGrant["operations"], 32).includes(op)
      )
    )
      fail("denied");
    // Historical immutable selection, not materialize(old completed job).
    // The CURRENT caller selection/fence and every source's read rights are
    // checked separately, including immediately before returning bytes.
    const selectionRow = await one(
      tx,
      "vertex_policy_selections",
      scope,
      sql`selection_id = ${producerLease["policySelectionId"]}`
    );
    const ownershipRow = await one(
      tx,
      "vertex_policy_ownership_pins",
      scope,
      sql`holder_id = ${producerId}`
    );
    if (!(selectionRow && ownershipRow)) return fail("denied");
    const selected = object(selectionRow["payload"]);
    const { selectionSha256: selectionHash, ...selectionBody } = selected;
    const ownership = object(ownershipRow["payload"]);
    if (
      (await ctx.hash(selectionBody)) !== selectionHash ||
      selectionHash !== producerLease["policySelectionSha256"] ||
      selectionHash !== selectionRow["selection_sha256"] ||
      selected["selectionId"] !== producerLease["policySelectionId"] ||
      selected["accountAlias"] !== scope.accountAlias ||
      selected["environment"] !== scope.environment ||
      time(selected["issuedAt"]) > time(admitted["admitted_at"]) ||
      time(selected["expiresAt"]) <= time(root.row["recorded_at"]) ||
      (await ctx.hash(ownership)) !== ownershipRow["record_hash"] ||
      ownership["holderId"] !== producerId ||
      ownership["selectionId"] !== selected["selectionId"] ||
      ownership["selectionSha256"] !== selectionHash ||
      ownership["accountAlias"] !== scope.accountAlias ||
      ownership["environment"] !== scope.environment ||
      ownership["ownerServiceId"] !== producerGrant["servicePrincipalId"] ||
      time(ownership["pinnedAt"]) > time(admitted["admitted_at"]) ||
      (ownership["releasedAt"] !== null &&
        time(ownership["releasedAt"]) < time(root.row["recorded_at"]))
    )
      fail("integrity");
    if (
      selected["revision"] !== selectionRow["revision"] ||
      time(selected["issuedAt"]).toString() !== selectionRow["issued_at_ns"] ||
      time(selected["expiresAt"]).toString() !==
        selectionRow["expires_at_ns"] ||
      selected["readOnly"] !== true ||
      selected["nativeRearmAllowed"] !== false ||
      selected["cloudCapitalAuthority"] !== false ||
      ownership["holderKind"] !== "job" ||
      ownership["ownerEpoch"] !== producerLease["leaseEpoch"] ||
      ownership["holderId"] !== ownershipRow["holder_id"] ||
      ownership["ownerServiceId"] !== ownershipRow["owner_service_id"] ||
      ownership["ownerEpoch"] !== ownershipRow["owner_epoch"]
    )
      fail("integrity");
    if (
      ownership["selectionId"] !== ownershipRow["selection_id"] ||
      ownership["selectionSha256"] !== ownershipRow["selection_sha256"] ||
      ownership["holderKind"] !== ownershipRow["holder_kind"] ||
      time(ownership["pinnedAt"]).toString() !== ownershipRow["pinned_at_ns"] ||
      (ownership["releasedAt"] === null
        ? null
        : time(ownership["releasedAt"]).toString()) !==
        ownershipRow["released_at_ns"]
    )
      fail("integrity");
    const ownedModule = object(ownership["module"]);
    const selectedModules = array(selected["modules"], 128)
      .map(object)
      .filter((module) => module["moduleId"] === ownedModule["moduleId"]);
    if (
      ownedModule["moduleId"] !== ownershipRow["module_id"] ||
      ownedModule["version"] !== ownershipRow["module_version"] ||
      ownedModule["codeSha256"] !== ownershipRow["code_sha256"]
    )
      fail("integrity");
    if (
      selectedModules.length !== 1 ||
      requirePresent(selectedModules[0], "selectedModules[0]")["enabled"] !==
        true ||
      (await ctx.hash(selectedModules[0])) !== (await ctx.hash(ownedModule))
    )
      fail("integrity");
    const revoked = await one(
      tx,
      "vertex_policy_revocations",
      scope,
      sql`selection_id = ${selected["selectionId"]}`
    );
    if (
      revoked &&
      BigInt(string(revoked["recorded_at_ns"])) <= time(root.row["recorded_at"])
    )
      fail("denied");
    if (
      revoked &&
      ((await ctx.hash(revoked["payload"])) !== revoked["record_hash"] ||
        object(revoked["payload"])["selectionId"] !== selected["selectionId"] ||
        object(revoked["payload"])["selectionSha256"] !== selectionHash ||
        time(object(revoked["payload"])["recordedAt"]).toString() !==
          revoked["recorded_at_ns"])
    )
      fail("integrity");
    const selectedRecipes = array(selected["artifacts"], 512)
      .map(object)
      .filter(
        (entry) =>
          entry["role"] === "simulation-engine" &&
          object(entry["artifact"])["contractName"] === "HostBacktestRecipe"
      );
    if (
      selectedRecipes.length !== 1 ||
      object(
        requirePresent(selectedRecipes[0], "selectedRecipes[0]")["artifact"]
      )["schemaVersion"] !== "1.0.0" ||
      object(
        requirePresent(selectedRecipes[0], "selectedRecipes[0]")["artifact"]
      )["artifactId"] !== recipe.artifactId ||
      object(
        requirePresent(selectedRecipes[0], "selectedRecipes[0]")["artifact"]
      )["artifactSha256"] !== recipe.artifactSha256
    )
      fail("denied");
    // This private reader is only used with graph-derived refs or the exact
    // historically selected recipe. It never becomes generic stage access.
    const sourceStage = async (
      ref: { artifactId: string; artifactSha256: string },
      sourceCollection: string | null,
      expectedJob: string | null,
      canonicalStage: boolean,
      canonicalBytes = true
    ) => {
      const stage = await staged(
        tx,
        principal,
        scope,
        ref.artifactId,
        sourceCollection,
        at,
        expectedJob ?? undefined
      );
      const descriptor = object(stage["payload"]);
      const objectKey = vertexQualifiedObjectKey(
        scope,
        sourceCollection,
        canonicalStage ? "manifest" : "content",
        ref.artifactSha256
      );
      if (
        stage["content_sha256"] !== ref.artifactSha256 ||
        stage["canonical_sha256"] !==
          (canonicalStage ? ref.artifactSha256 : null) ||
        stage["object_key"] !== objectKey ||
        descriptor["accountAlias"] !== scope.accountAlias ||
        descriptor["environment"] !== scope.environment ||
        descriptor["collectionId"] !== sourceCollection ||
        descriptor["jobId"] !== stage["job_id"] ||
        descriptor["artifactId"] !== ref.artifactId ||
        descriptor["contentSha256"] !== ref.artifactSha256 ||
        descriptor["canonicalSha256"] !== stage["canonical_sha256"] ||
        descriptor["contentType"] !== "application/json" ||
        time(descriptor["createdAt"]) > time(root.row["recorded_at"])
      )
        fail("integrity");
      await ctx.authorize(
        principal,
        scope,
        sourceCollection,
        ref.artifactId,
        "read",
        at
      );
      const content = await original(
        objectKey,
        ref.artifactSha256,
        canonicalBytes
      );
      if (content.bytes.byteLength !== stage["byte_length"]) fail("integrity");
      if (
        expectedJob === producerId &&
        ref.artifactId !== producerLease["payloadArtifactId"] &&
        time(descriptor["createdAt"]) < time(admitted["admitted_at"])
      )
        fail("integrity");
      finalChecks.push(async (now) => {
        await ctx.authorize(
          principal,
          scope,
          sourceCollection,
          ref.artifactId,
          "read",
          now
        );
        return await currentRights(
          tx,
          principal,
          scope,
          sourceCollection,
          identifier(descriptor["rightsPolicyId"]),
          "read",
          now,
          identifier(descriptor["rightsVersion"])
        );
      });
      return { ...content, descriptor, stage };
    };
    const rootOriginal = await sourceStage(
      artifact,
      collection,
      producerId,
      true
    );
    if (
      (await ctx.hash(rootOriginal.descriptor["lineageArtifactIds"])) !==
      (await ctx.hash(root.parents))
    )
      fail("integrity");
    const payload = await sourceStage(
      {
        artifactId: identifier(producerLease["payloadArtifactId"]),
        artifactSha256: digestString(producerLease["payloadSha256"]),
      },
      collection,
      producerId,
      true
    );
    if (
      Object.keys(payload.record).sort().join(",") !==
        "format,recipeArtifactId,recipeSha256" ||
      payload.record["format"] !== "vertex-backtest-job-v1" ||
      payload.record["recipeArtifactId"] !== recipe.artifactId ||
      payload.record["recipeSha256"] !== recipe.artifactSha256
    )
      fail("integrity");
    const recipeOriginal = await sourceStage(recipe, null, null, true);
    const recipeRecord = recipeOriginal.record;
    const historicalBar =
      recipeRecord["format"] === "vertex-host-backtest-recipe-v3";
    const recipeKeys = historicalBar
      ? "budget,datasets,descriptor,evidence,format,lineage,model,plannedAt,publication,reviewPins,run,strategy"
      : "budget,datasets,descriptor,evidence,format,lineage,model,plannedAt,publication,run,strategy";
    if (
      Object.keys(recipeRecord).sort().join(",") !== recipeKeys ||
      ![
        "vertex-host-backtest-recipe-v2",
        "vertex-host-backtest-recipe-v3",
      ].includes(string(recipeRecord["format"]))
    )
      fail("integrity");
    if (
      historicalBar &&
      (value["experiment"] !== undefined ||
        root.record["reviewStatus"] !== "incomplete" ||
        root.record["forwardSampleCount"] !== 0)
    )
      fail("denied");
    const recipeRef = (
      rawRef: unknown
    ): { artifactId: string; artifactSha256: string } => {
      const ref = object(rawRef);
      if (Object.keys(ref).sort().join(",") !== "artifactId,sha256")
        fail("integrity");
      return {
        artifactId: identifier(ref["artifactId"]),
        artifactSha256: digestString(ref["sha256"]),
      };
    };
    if (
      (await ctx.hash(recipeRef(recipeRecord["run"]))) !==
      (await ctx.hash(plannedRun))
    )
      fail("integrity");
    const publication = object(recipeRecord["publication"]);
    if (
      publication["collectionId"] !== collection ||
      publication["actorId"] !== producerLease["researchPrincipalId"] ||
      publication["rightsPolicyId"] !== root.metadata.rights.policyId ||
      publication["rightsVersion"] !== root.metadata.rights.version
    )
      fail("denied");
    const strategyRef = recipeRef(recipeRecord["strategy"]);
    const strategy = await committed(strategyRef, "StrategySpec");
    if (strategyRef.artifactId !== planned.record["strategyVersion"])
      fail("integrity");
    const datasetRefs = array(recipeRecord["datasets"], 64).map(object);
    const evidenceRefs = array(recipeRecord["evidence"], 64).map(recipeRef);
    const inputs = [plannedRun.artifactId, strategyRef.artifactId];
    const datasetIds: string[] = [];
    const historicalSources: {
      manifest: VertexRecord;
      manifestSha256: string;
      content: VertexRecord;
      capture: VertexRecord;
      captureSha256: string;
      requestSha256: string;
    }[] = [];
    for (const entry of datasetRefs) {
      const manifestRef = recipeRef(entry["manifest"]);
      const datasetCollection = historicalBar
        ? entry["collectionId"] === null
          ? null
          : identifier(entry["collectionId"])
        : collection;
      if (historicalBar)
        originalDatasetScopes.set(manifestRef.artifactId, {
          collection: datasetCollection,
          digest: manifestRef.artifactSha256,
        });
      const manifest = await committed(
        manifestRef,
        "DatasetManifest",
        datasetCollection
      );
      const contentRef = recipeRef(entry["content"]);
      if (manifest.record["contentHash"] !== contentRef.artifactSha256)
        fail("integrity");
      const relation = await one(
        tx,
        "vertex_datasets",
        scope,
        sql`dataset_id = ${identifier(manifest.record["datasetId"])}`
      );
      if (
        !relation ||
        relation["collection_key"] !== collectionKey(datasetCollection) ||
        relation["artifact_id"] !== manifestRef.artifactId
      )
        fail("integrity");
      if (historicalBar) {
        if (
          Object.keys(entry).sort().join(",") !==
            "collectionId,content,contentFormat,declaredEvents,manifest,reviewPins" ||
          entry["contentFormat"] !== "vertex-ibkr-historical-bars-v1" ||
          contentRef.artifactId !== manifest.record["storageRef"]
        )
          fail("integrity");
        const manifestStage = await one(
          tx,
          "vertex_worker_stages",
          scope,
          sql`artifact_id = ${manifestRef.artifactId} and collection_key = ${collectionKey(datasetCollection)}`
        );
        if (!manifestStage) fail("integrity");
        const datasetProducerId = identifier(manifestStage["job_id"]);
        const datasetProducer = await one(
          tx,
          "vertex_worker_jobs",
          scope,
          sql`job_id = ${datasetProducerId}`
        );
        if (
          datasetProducer?.["state"] !== "succeeded" ||
          !array(datasetProducer["output_artifact_ids"], 64).includes(
            manifestRef.artifactId
          )
        )
          fail("denied");
        const graph = await historicalDataset(
          tx,
          principal,
          scope,
          datasetCollection,
          datasetProducerId,
          manifest.record,
          at
        );
        historicalSources.push({
          manifest: manifest.record,
          manifestSha256: manifestRef.artifactSha256,
          content: graph.content.value,
          capture: graph.capture.value,
          captureSha256: graph.capture.ref.artifactSha256,
          requestSha256: graph.request.ref.artifactSha256,
        });
        finalChecks.push(async (now) => {
          await historicalDataset(
            tx,
            principal,
            scope,
            datasetCollection,
            datasetProducerId,
            manifest.record,
            now
          );
        });
      }
      inputs.push(manifestRef.artifactId);
      datasetIds.push(identifier(manifest.record["datasetId"]));
    }
    if (
      datasetRefs.length === 0 ||
      new Set(datasetIds).size !== datasetIds.length ||
      (await ctx.hash([...datasetIds].sort())) !==
        (await ctx.hash(
          array(planned.record["datasetManifestIds"], 64).map(identifier).sort()
        ))
    )
      fail("integrity");
    const historicalReviews: {
      artifactSha256: string;
      evidence: VertexRecord;
    }[] = [];
    for (const ref of evidenceRefs) {
      const evidence = await committed(ref, "ResearchEvidence");
      if (
        evidence.record["collectionId"] !== collection ||
        evidence.record["snapshotId"] !== publication["snapshotId"]
      )
        fail("integrity");
      const checkReview = async (now: string): Promise<string> => {
        const accepted = await createQueryOperations(
          boundContext(tx, now, scope)
        ).getAcceptedEvidence(
          principal,
          scope,
          collection,
          identifier(evidence.record["evidenceId"])
        );
        if (
          !accepted ||
          accepted.artifact.artifactId !== ref.artifactId ||
          accepted.artifact.artifactSha256 !== ref.artifactSha256
        )
          return fail("denied");
        await ctx.authorize(
          { actorId: identifier(accepted.review["actorId"]) },
          scope,
          collection,
          ref.artifactId,
          "review",
          now
        );
        if (historicalBar) {
          const pins = array(recipeRecord["reviewPins"], 32)
            .map(object)
            .filter(
              (pin) => pin["evidenceId"] === evidence.record["evidenceId"]
            );
          const expected = {
            collectionId: collection,
            evidenceId: evidence.record["evidenceId"],
            artifactId: ref.artifactId,
            artifactSha256: ref.artifactSha256,
            reviewId: accepted.review["reviewId"],
            reviewVersion: accepted.review["reviewVersion"],
            rightsPolicyId: accepted.artifact.rights.policyId,
            rightsVersion: accepted.artifact.rights.version,
          };
          if (
            pins.length !== 1 ||
            (await ctx.hash(pins[0])) !== (await ctx.hash(expected))
          )
            return fail("denied");
        }
        return ctx.hash(accepted.review);
      };
      const reviewHash = await checkReview(at);
      finalChecks.push(async (now) => {
        if ((await checkReview(now)) !== reviewHash) return fail("stale");
        return;
      });
      inputs.push(ref.artifactId);
      if (historicalBar)
        historicalReviews.push({
          artifactSha256: ref.artifactSha256,
          evidence: evidence.record,
        });
    }
    if (
      new Set(inputs).size !== inputs.length ||
      inputs.some((id) => !root.parents.includes(id))
    )
      fail("integrity");
    const parentEvidence: Awaited<ReturnType<typeof committed>>[] = [];
    for (const id of root.parents.filter(
      (parent) => !inputs.includes(parent)
    )) {
      const metadata = await ctx.artifact(
        tx,
        principal,
        scope,
        collection,
        id,
        "read",
        at
      );
      if (metadata?.contractName !== "ResearchEvidence") return fail("denied");
      const evidence = await committed(
        { artifactId: id, artifactSha256: metadata.artifactSha256 },
        "ResearchEvidence"
      );
      if (
        evidence.record["collectionId"] !== collection ||
        evidence.record["snapshotId"] !== publication["snapshotId"] ||
        evidence.record["acceptanceStatus"] === "accepted" ||
        evidence.record["contentHash"] !== metadata.sourceContentSha256 ||
        object(evidence.record["sourceIdentity"])["contentHash"] !==
          metadata.sourceContentSha256
      )
        fail("integrity");
      if (
        evidence.record["sourceType"] !== "derived-analysis" ||
        evidence.record["acceptanceStatus"] !== "unreviewed" ||
        object(evidence.record["sourceIdentity"])["snapshotId"] !==
          publication["snapshotId"] ||
        evidence.record["rightsPolicyId"] !== publication["rightsPolicyId"] ||
        evidence.record["evidenceId"] !== evidence.ref.artifactId
      )
        fail("integrity");
      const stagedEvidence = await sourceStage(
        evidence.ref,
        collection,
        producerId,
        true
      );
      if (
        (await ctx.hash(stagedEvidence.descriptor["lineageArtifactIds"])) !==
        (await ctx.hash(evidence.parents))
      )
        fail("integrity");
      parentEvidence.push(evidence);
    }
    const resultCaptures = parentEvidence.filter(
      (item) =>
        item.ref.artifactId.startsWith("backtest-results-evidence-") &&
        item.record["contentHash"] === results.artifactSha256 &&
        item.record["sourceLocator"] === results.artifactId &&
        object(item.record["sourceIdentity"])["sourceId"] === results.artifactId
    );
    if (resultCaptures.length !== 1) return fail("denied");
    const resultEvidence = requirePresent(
      resultCaptures[0],
      "resultCaptures[0]"
    );
    const resultEvidenceId = resultEvidence.ref.artifactId;
    if (
      (await ctx.hash([...resultEvidence.parents].sort())) !==
      (await ctx.hash([...inputs].sort()))
    )
      fail("integrity");
    const resultsOriginal = await sourceStage(
      results,
      collection,
      producerId,
      false
    );
    if (
      (await ctx.hash(
        array(resultsOriginal.descriptor["lineageArtifactIds"], 64)
          .map(identifier)
          .sort()
      )) !== (await ctx.hash([...inputs].sort()))
    )
      fail("integrity");
    if (
      object(recipeRecord["lineage"])["record"] !==
        (historicalBar ? "HistoricalBarLineage" : "LineageInputs") ||
      object(recipeRecord["budget"])["record"] !== "ResourceBudget" ||
      object(recipeRecord["descriptor"])["record"] !== "EngineDescriptor"
    )
      fail("integrity");
    const lineage = object(backtestRecipeValue(recipeRecord["lineage"]));
    const budget = object(backtestRecipeValue(recipeRecord["budget"]));
    const descriptor = object(backtestRecipeValue(recipeRecord["descriptor"]));
    const resultRecord = resultsOriginal.record;
    const model = object(recipeRecord["model"]);
    const engine = object(descriptor["pin"]);
    const economics = object(resultRecord["economics"]);
    let modeledOutcome:
      | HistoricalBarModeledOutcome
      | Readonly<{
          availability: "unavailable";
          reason: "format-not-qualified";
        }> = { availability: "unavailable", reason: "format-not-qualified" };
    if (historicalBar) {
      if (historicalSources.length !== 1) fail("integrity");
      modeledOutcome = await verifyHistoricalBarResult(ctx, {
        recipe: recipeRecord,
        lineage,
        budget,
        descriptor,
        result: resultRecord,
        planned: planned.record,
        plannedSha256: plannedRun.artifactSha256,
        strategy: strategy.record,
        strategySha256: strategyRef.artifactSha256,
        dataset: requirePresent(historicalSources[0], "historicalSources[0]"),
        evidence: historicalReviews,
        admittedAt: string(admitted["admitted_at"]),
      });
    } else {
      const expectedLineage = {
        strategyDigest: strategyRef.artifactSha256,
        runDigest: plannedRun.artifactSha256,
        datasetManifestDigests: datasetRefs.map(
          (entry) => recipeRef(entry["manifest"]).artifactSha256
        ),
        evidenceDigests: evidenceRefs.map((ref) => ref.artifactSha256),
        lineage,
        budget,
        engineDescriptor: descriptor,
        gammaReplayEvidence: null,
        gammaSourceCaptures: [],
        plannedAt: backtestTimestamp(recipeRecord["plannedAt"]),
        proposalOnly: true,
        executionAuthorized: false,
      };
      if (
        Object.keys(resultRecord).sort().join(",") !==
          "assumptionDigest,datasetContentDigests,economics,economicsOrigin,economicsSimulated,enginePin,evidenceDigests,executionAuthorized,forwardAssessment,incidentCodes,lineageDigest,sandbox,strategyDigest" ||
        resultRecord["economicsOrigin"] !== "injected-simulation-engine" ||
        resultRecord["economicsSimulated"] !== true
      )
        fail("integrity");
      if (
        resultRecord["lineageDigest"] !== (await ctx.hash(expectedLineage)) ||
        resultRecord["strategyDigest"] !== strategyRef.artifactSha256 ||
        (await ctx.hash(resultRecord["enginePin"])) !==
          (await ctx.hash(descriptor["pin"])) ||
        (await ctx.hash(resultRecord["datasetContentDigests"])) !==
          (await ctx.hash(
            datasetRefs.map(
              (entry) => recipeRef(entry["content"]).artifactSha256
            )
          )) ||
        resultRecord["assumptionDigest"] !==
          (await ctx.hash(lineage["assumptions"])) ||
        resultRecord["assumptionDigest"] !== model["assumptions_digest"] ||
        model["strategy_digest"] !== strategyRef.artifactSha256 ||
        model["strategy_code_digest"] !== strategy.record["codeDigest"] ||
        model["engine_digest"] !== object(descriptor["pin"])["digest"] ||
        descriptor["simulation_only"] !== true ||
        budget["network_allowed"] !== false ||
        budget["execution_allowed"] !== false ||
        resultRecord["executionAuthorized"] !== false ||
        time(recipeRecord["plannedAt"]) > time(admitted["admitted_at"])
      )
        fail("integrity");
      if (
        engine["identity"] !== "vertex-nautilus-quote-research" ||
        engine["version"] !== "1.0.0" ||
        engine["version"] !== planned.record["engineVersion"] ||
        economics["model"] !== engine["identity"] ||
        economics["modelVersion"] !== engine["version"] ||
        economics["reviewDigest"] !== model["review_digest"] ||
        (await ctx.hash(lineage["enginePin"])) !== (await ctx.hash(engine)) ||
        object(lineage["codePin"])["digest"] !==
          model["strategy_code_digest"] ||
        lineage["strategyVersionId"] !== planned.record["strategyVersion"] ||
        (await ctx.hash(descriptor["supported_formats"])) !==
          (await ctx.hash(["vertex-jsonl-events-v1"])) ||
        (await ctx.hash(descriptor["modeled_assumptions"])) !==
          (await ctx.hash(["commission", "slippage", "spread"]))
      )
        fail("integrity");
    }
    // Wrapper Version is x.y.z; the actual original native distribution pin
    // remains the prerelease, never a relabelled/fabricated upstream 2.0.0.
    let nativeConfiguration: VertexRecord;
    try {
      nativeConfiguration = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            decode(model["native_configuration_bytes"])
          )
        )
      );
    } catch {
      return fail("integrity");
    }
    const nativeDistribution = object(nativeConfiguration["distribution"]);
    if (
      nativeDistribution["name"] !== "nautilus-trader" ||
      nativeDistribution["version"] !== "2.0.0rc5"
    )
      fail("integrity");
    const experimentProof: Record<string, unknown> = {};
    if (value["experiment"] !== undefined) {
      // A current review or caller-supplied requestedAt cannot establish
      // precommitment. Resolve the ORIGINAL private publication and its
      // reviewed planned-run parent, before the real producer admission.
      const expectedExperiment = object(value["experiment"]);
      const experimentId = identifier(expectedExperiment["experimentId"]);
      const experimentRef = reference(expectedExperiment["artifact"]);
      const experimentRow = await one(
        tx,
        "vertex_worker_experiment_publications",
        scope,
        sql`collection_id = ${collection} and experiment_id = ${experimentId}`
      );
      if (
        !experimentRow ||
        experimentRow["artifact_id"] !== experimentRef.artifactId ||
        experimentRow["content_sha256"] !== experimentRef.artifactSha256
      )
        return fail("denied");
      const publicationDescriptor = await experimentPublication(
        tx,
        principal,
        scope,
        experimentRow,
        at
      );
      const frozen = (
        await original(
          string(publicationDescriptor["objectKey"]),
          experimentRef.artifactSha256
        )
      ).record;
      const publishedAt = time(publicationDescriptor["publishedAt"]);
      if (
        publishedAt > time(planned.row["recorded_at"]) ||
        time(planned.row["recorded_at"]) >= time(admitted["admitted_at"]) ||
        publishedAt > time(recipeOriginal.descriptor["createdAt"]) ||
        time(recipeOriginal.descriptor["createdAt"]) >=
          time(admitted["admitted_at"])
      )
        fail("integrity");
      const frozenStrategy = object(frozen["strategy"]);
      const windows = object(frozen["windows"]);
      const training = object(windows["training"]);
      const test = object(windows["outOfSample"]);
      const frozenDatasets = array(frozen["datasets"], 64).map(object);
      const frozenManifests = frozenDatasets.map((entry) => ({
        artifactId: identifier(entry["datasetId"]),
        artifactSha256: digestString(entry["manifestHash"]),
      }));
      if (
        frozen["experimentId"] !== experimentId ||
        frozenStrategy["id"] !== strategyRef.artifactId ||
        frozenStrategy["hash"] !== strategyRef.artifactSha256 ||
        frozen["implementationDigest"] !== strategy.record["codeDigest"] ||
        frozen["implementationDigest"] !== model["strategy_code_digest"] ||
        frozen["environmentDigest"] !== lineage["environmentDigest"] ||
        frozen["engineVersion"] !== engine["version"] ||
        frozen["seed"] !== planned.record["seed"] ||
        planned.record["validationMode"] !== "historical"
      )
        fail("integrity");
      if (
        (await ctx.hash(planned.record["trainingWindow"])) !==
          (await ctx.hash({
            startAtInclusive: training["start"],
            endAtExclusive: training["end"],
          })) ||
        (await ctx.hash(planned.record["testWindow"])) !==
          (await ctx.hash({
            startAtInclusive: test["start"],
            endAtExclusive: test["end"],
          })) ||
        (await ctx.hash(frozenManifests)) !==
          (await ctx.hash(
            datasetRefs.map((entry) => recipeRef(entry["manifest"]))
          ))
      )
        fail("integrity");
      // Existing publication pins identify every dependency; the one other
      // planned parent must be the original reviewed experiment mapping.
      const dependencyPins = array(
        publicationDescriptor["dependencyPins"],
        64
      ).map(object);
      const dependencyIds = dependencyPins.map((pin) =>
        identifier(pin["artifactId"])
      );
      if (
        new Set(dependencyIds).size !== dependencyIds.length ||
        dependencyIds.some((id) => !planned.parents.includes(id))
      )
        fail("integrity");
      for (const pin of dependencyPins) {
        const checkDependency = async (now: string): Promise<void> => {
          if (time(now) < time(at)) fail("stale");
          await experimentDependency(
            tx,
            principal,
            scope,
            collection,
            identifier(frozenStrategy["id"]),
            pin,
            now
          );
        };
        await checkDependency(at);
        finalChecks.push(checkDependency);
      }
      const bindingIds = planned.parents.filter(
        (id) => !dependencyIds.includes(id)
      );
      if (bindingIds.length !== 1) return fail("denied");
      const bindingId = requirePresent(bindingIds[0], "bindingIds[0]");
      const bindingMetadata = await ctx.artifact(
        tx,
        principal,
        scope,
        collection,
        bindingId,
        "read",
        at
      );
      if (bindingMetadata?.contractName !== "ResearchEvidence")
        return fail("denied");
      const bindingEvidence = await committed(
        {
          artifactId: bindingId,
          artifactSha256: bindingMetadata.artifactSha256,
        },
        "ResearchEvidence"
      );
      const bindingHash = digestString(bindingEvidence.record["contentHash"]);
      if (
        bindingEvidence.record["collectionId"] !== collection ||
        bindingEvidence.record["snapshotId"] !== publication["snapshotId"] ||
        bindingEvidence.metadata.sourceContentSha256 !== bindingHash ||
        object(bindingEvidence.record["sourceIdentity"])["contentHash"] !==
          bindingHash ||
        object(bindingEvidence.record["sourceIdentity"])["snapshotId"] !==
          bindingEvidence.record["snapshotId"] ||
        time(bindingEvidence.row["recorded_at"]) >
          time(planned.row["recorded_at"])
      )
        fail("integrity");
      const checkBindingReview = async (now: string): Promise<string> => {
        const accepted = await createQueryOperations(
          boundContext(tx, now, scope)
        ).getAcceptedEvidence(
          principal,
          scope,
          collection,
          identifier(bindingEvidence.record["evidenceId"])
        );
        if (
          !accepted ||
          accepted.artifact.artifactId !== bindingId ||
          accepted.artifact.artifactSha256 !==
            bindingEvidence.ref.artifactSha256
        )
          return fail("denied");
        await ctx.authorize(
          { actorId: identifier(accepted.review["actorId"]) },
          scope,
          collection,
          bindingId,
          "review",
          now
        );
        return ctx.hash(accepted.review);
      };
      const bindingReviewHash = await checkBindingReview(at);
      finalChecks.push(async (now) => {
        if ((await checkBindingReview(now)) !== bindingReviewHash)
          return fail("stale");
        return;
      });
      const binding = (
        await original(
          vertexQualifiedObjectKey(scope, collection, "content", bindingHash),
          bindingHash
        )
      ).record;
      if (
        binding["format"] !==
          "vertex-reviewed-experiment-backtest-binding-v1" ||
        binding["experimentId"] !== experimentId ||
        binding["experimentHash"] !== experimentRef.artifactSha256 ||
        binding["runId"] !== plannedRun.artifactId ||
        binding["runHash"] !== plannedRun.artifactSha256 ||
        binding["executionAuthority"] !== "none" ||
        binding["simulatedCapitalEntersNav"] !== false ||
        binding["modelHash"] !== (await ctx.hash(model)) ||
        binding["publicationHash"] !== (await ctx.hash(publication)) ||
        binding["costModelHash"] !==
          (await ctx.hash(planned.record["transactionCosts"])) ||
        binding["plannedAt"] !== recipeRecord["plannedAt"]
      )
        fail("integrity");
      if (
        (await ctx.hash(binding["lineage"])) !== (await ctx.hash(lineage)) ||
        (await ctx.hash(binding["budget"])) !== (await ctx.hash(budget)) ||
        (await ctx.hash(binding["descriptor"])) !==
          (await ctx.hash(descriptor)) ||
        (await ctx.hash(binding["model"])) !== (await ctx.hash(model)) ||
        (await ctx.hash(binding["publication"])) !==
          (await ctx.hash(publication))
      )
        fail("integrity");
      const originalPublicationHash = experimentRow["record_hash"];
      finalChecks.push(async (now) => {
        if (time(now) < time(at)) fail("stale");
        const current = await one(
          tx,
          "vertex_worker_experiment_publications",
          scope,
          sql`collection_id = ${collection} and experiment_id = ${experimentId}`
        );
        if (
          !current ||
          current["record_hash"] !== originalPublicationHash ||
          current["artifact_id"] !== experimentRef.artifactId ||
          current["content_sha256"] !== experimentRef.artifactSha256
        )
          return fail("stale");
        return await experimentPublication(tx, principal, scope, current, now);
      });
      // Reconstructed from checked server records, never a request echo.
      experimentProof["experiment"] = {
        experimentId: identifier(experimentRow["experiment_id"]),
        artifact: {
          artifactId: identifier(experimentRow["artifact_id"]),
          artifactSha256: digestString(experimentRow["content_sha256"]),
        },
      };
    }
    const receipts = parentEvidence.filter(
      (item) =>
        item.ref.artifactId.startsWith("sandbox-receipt-evidence-") &&
        item.record["sourceLocator"] ===
          `sandbox-receipt-${item.record["contentHash"]}` &&
        object(item.record["sourceIdentity"])["sourceId"] ===
          item.record["sourceLocator"]
    );
    if (receipts.length !== 1) return fail("denied");
    const receiptEvidence = requirePresent(receipts[0], "receipts[0]");
    const receipt = {
      artifactId: identifier(receiptEvidence.record["sourceLocator"]),
      artifactSha256: digestString(receiptEvidence.record["contentHash"]),
    };
    const receiptOriginal = await sourceStage(
      receipt,
      collection,
      producerId,
      false
    );
    const receiptRecord = receiptOriginal.record;
    const isolationId = identifier(receiptRecord["isolationArtifactId"]);
    const isolationEvidence = parentEvidence.filter(
      (item) =>
        item.ref.artifactId ===
          object(resultRecord["sandbox"])["isolation_evidence_id"] &&
        isolationId === `sandbox-isolation-${item.record["contentHash"]}`
    );
    if (isolationEvidence.length !== 1 || parentEvidence.length !== 3)
      return fail("denied");
    const isolationWrapper = requirePresent(
      isolationEvidence[0],
      "isolationEvidence[0]"
    );
    const isolation = {
      artifactId: isolationId,
      artifactSha256: digestString(isolationWrapper.record["contentHash"]),
    };
    if (
      (await ctx.hash(resultRecord["evidenceDigests"])) !==
        (await ctx.hash([isolationWrapper.ref.artifactSha256])) ||
      object(resultRecord["sandbox"])["limits_enforced"] !== true ||
      object(resultRecord["sandbox"])["network_used"] !== false ||
      object(resultRecord["sandbox"])["execution_authority_used"] !== false
    )
      fail("integrity");
    // Wrapper identity binds the retained original isolation capture, not
    // merely result bytes that could recur with different provenance.
    const captureId = async (
      prefix: string,
      source: { artifactId: string; artifactSha256: string }
    ): Promise<string> => {
      return `${prefix}${await ctx.hash({ sourceArtifactId: source.artifactId, sourceContentSha256: source.artifactSha256, isolationEvidenceId: isolationWrapper.ref.artifactId, isolationEvidenceSha256: isolationWrapper.ref.artifactSha256 })}`;
    };
    if (
      resultEvidenceId !==
        (await captureId("backtest-results-evidence-", results)) ||
      receiptEvidence.ref.artifactId !==
        (await captureId("sandbox-receipt-evidence-", receipt))
    )
      fail("integrity");
    // Isolation originals are native protocol bytes, not canonical JSON.
    // Their exact hash is preserved; no reserialization or crypto claim.
    const isolationOriginal = await sourceStage(
      isolation,
      collection,
      producerId,
      false,
      false
    );
    if (
      receiptRecord["format"] !== "vertex-worker-observation-v1" ||
      receiptRecord["processExited"] !== true ||
      receiptRecord["cgroupEmpty"] !== true ||
      object(receiptRecord["observation"])["policy_digest"] !==
        descriptor["sandbox_policy_digest"] ||
      object(resultRecord["sandbox"])["policy_digest"] !==
        descriptor["sandbox_policy_digest"] ||
      (await ctx.hash(object(resultRecord["sandbox"])["budget"])) !==
        (await ctx.hash(budget)) ||
      (await ctx.hash(isolationWrapper.parents)) !==
        (await ctx.hash([resultEvidenceId])) ||
      (await ctx.hash([...receiptEvidence.parents].sort())) !==
        (await ctx.hash(
          [resultEvidenceId, isolationWrapper.ref.artifactId].sort()
        ))
    )
      fail("integrity");
    const observation = object(receiptRecord["observation"]);
    if (
      Object.keys(receiptRecord).sort().join(",") !==
        "cgroupEmpty,cpuMs,finishAttestationBase64,format,isolationArtifactId,memoryEvents,observation,outputSha256,peakMemoryBytes,processExited,startAttestationBase64,wallMs" ||
      Object.keys(isolationOriginal.record).sort().join(",") !==
        "bindingDigest,enforcement" ||
      (await ctx.hash(
        object(isolationOriginal.record["enforcement"])["parentObservation"]
      )) !== (await ctx.hash(observation))
    )
      fail("integrity");
    digestString(receiptRecord["outputSha256"]);
    digestString(isolationOriginal.record["bindingDigest"]);
    // Only byte/payload joins: historical HMAC keys are intentionally absent.
    for (const [phase, field] of [
      ["start", "startAttestationBase64"],
      ["finish", "finishAttestationBase64"],
    ] as const) {
      let proof: VertexRecord;
      let decodedPayload: VertexRecord;
      try {
        const proofBytes = decode(receiptRecord[field]);
        if (proofBytes.byteLength > 65_536) fail("invalid");
        proof = object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(proofBytes)
          )
        );
        if (Object.keys(proof).sort().join(",") !== "mac,payload")
          fail("integrity");
        digestString(proof["mac"]);
        const payloadBytes = decode(proof["payload"]);
        if (payloadBytes.byteLength > 60_000) fail("invalid");
        decodedPayload = object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)
          )
        );
      } catch {
        return fail("integrity");
      }
      const expected = {
        phase,
        bindingDigest: isolationOriginal.record["bindingDigest"],
        enforcementDigest: isolation.artifactSha256,
        ...(phase === "finish"
          ? { outputDigest: receiptRecord["outputSha256"] }
          : {}),
      };
      if ((await ctx.hash(decodedPayload)) !== (await ctx.hash(expected)))
        fail("integrity");
    }
    if (
      isolationWrapper.ref.artifactId !==
        `isolation-${identifier(observation["session_id"])}` ||
      object(isolationWrapper.record["sourceIdentity"])["sourceId"] !==
        isolationWrapper.ref.artifactId ||
      observation["thread_profile"] !==
        "nautilus-rc5-glibc244-x86_64-2task-v1" ||
      (await ctx.hash(isolationOriginal.descriptor["lineageArtifactIds"])) !==
        (await ctx.hash(isolationWrapper.parents)) ||
      (await ctx.hash(receiptOriginal.descriptor["lineageArtifactIds"])) !==
        (await ctx.hash(receiptEvidence.parents))
    )
      fail("integrity");
    if (
      new Set([
        artifact.artifactId,
        plannedRun.artifactId,
        results.artifactId,
        recipe.artifactId,
        receipt.artifactId,
        isolation.artifactId,
        ...parentEvidence.map((item) => item.ref.artifactId),
      ]).size !== 9
    )
      fail("integrity");
    return {
      output: {
        jobId: producerId,
        collectionId: collection,
        artifact: root.ref,
        plannedRun: planned.ref,
        results: {
          artifactId: identifier(root.record["resultsRef"]),
          artifactSha256: digestString(resultEvidence.record["contentHash"]),
        },
        recipe: recipeRef({
          artifactId: payload.record["recipeArtifactId"],
          sha256: payload.record["recipeSha256"],
        }),
        receipt,
        isolation,
        ...experimentProof,
        contentBase64: canonicalBase64(root.bytes),
        contentSha256: root.ref.artifactSha256,
        canonicalSha256: root.ref.artifactSha256,
        contentType: "application/json",
      },
      strategy: strategyRef,
      producerPrincipalId: string(producerLease["researchPrincipalId"]),
      selection: selected,
      modeledOutcome,
    };
  };
  return {
    parse,
    boundContext,
    currentRights,
    objectRead,
    experimentPublication,
    experimentDependency,
    experimentSourcePins,
    experimentSources,
    staged,
    historicalDataset,
    readBacktestRunProof,
  };
};

export const createVertexWorkerStore = (
  db: Database,
  options: VertexWorkerOptions
) => {
  const ctx = createPersistenceContext(db, options);
  const {
    parse,
    boundContext,
    currentRights,
    objectRead,
    experimentPublication,
    experimentDependency,
    experimentSourcePins,
    experimentSources,
    staged,
    historicalDataset,
    readBacktestRunProof,
  } = createBacktestReadProof(ctx, options);
  const { transaction, grant, authenticate, issueGrant, revokeGrant } =
    createVertexWorkerCredentials(db, ctx, options);
  // A current loss has already written irreversible lifecycle closure metadata.
  // Commit that metadata before converting the internal marker into denial.
  const chatAuthorityClosed = Symbol("chat-authority-closed");
  const chatStagePrepared = Symbol("chat-stage-prepared");
  const chatNativePhasePrepared = Symbol("chat-native-phase-prepared");
  const chatSourcesRequired = Symbol("chat-sources-required");
  const chatOriginal = async (
    tx: Transaction,
    scope: VertexScope,
    selector: Readonly<{ eventId?: string; jobId?: string }>,
    at: string
  ): Promise<
    | Exclude<
        Awaited<
          ReturnType<ResearchChatWorkerOperations["originalForTransaction"]>
        >,
        { closed: true }
      >
    | typeof chatAuthorityClosed
  > => {
    if (!options.chatWorker) return null;
    const row = await one(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      selector.eventId
        ? sql`event_id = ${selector.eventId}`
        : sql`job_id = ${selector.jobId}`
    );
    if (!row) return null;
    const joined = await options.chatWorker.originalForTransaction(
      tx,
      scope,
      selector,
      at
    );
    if (!joined) return fail("denied");
    if (joined.closed) return chatAuthorityClosed;
    return joined;
  };
  const nativeModelPurpose = async (
    tx: Transaction,
    scope: VertexScope,
    plan: VertexRecord,
    request: VertexRecord,
    at: string
  ): Promise<
    | "tokenizeInput"
    | "completionInput"
    | "phaseTwoTokenizeInput"
    | "phaseTwoCompletionInput"
  > => {
    if (
      !options.chatWorker ||
      scope.environment !== "research" ||
      !isNativeEvidencePlan(plan) ||
      !["model-tokenize", "model-completion"].includes(
        string(request["operation"])
      )
    )
      return fail("denied");
    const matches: (
      | "tokenizeInput"
      | "completionInput"
      | "phaseTwoTokenizeInput"
      | "phaseTwoCompletionInput"
    )[] = [];
    for (const ordinal of [1, 2] as const) {
      const phase =
        await options.chatWorker.copies.readNativePhaseForTransaction(
          tx,
          { accountAlias: scope.accountAlias, environment: "research" },
          identifier(plan["responseRequestId"]),
          ordinal,
          at
        );
      if (!phase) continue;
      const pin =
        request["operation"] === "model-tokenize"
          ? phase.tokenizeInput
          : phase.completionInput;
      if (
        pin.sha256 === request["inputSha256"] &&
        pin.byteLength === request["inputBytes"]
      )
        matches.push(
          ordinal === 1
            ? request["operation"] === "model-tokenize"
              ? "tokenizeInput"
              : "completionInput"
            : request["operation"] === "model-tokenize"
              ? "phaseTwoTokenizeInput"
              : "phaseTwoCompletionInput"
        );
    }
    if (matches.length !== 1) return fail("denied");
    return requirePresent(matches[0], "matches[0]");
  };
  const result = async (
    row: Row,
    status: string,
    reason: string | null = null
  ): Promise<VertexRecord> => {
    return await parse("WorkerResult", {
      status,
      jobId: row["job_id"],
      state: row["state"],
      lease:
        row["state"] === "leased" || row["state"] === "running"
          ? row["payload"]
          : null,
      outputArtifactIds: row["output_artifact_ids"],
      reason,
    });
  };
  const closeChatTerminalInputs = async (
    tx: Transaction,
    scope: VertexScope,
    job: Row,
    at: string
  ): Promise<void> => {
    if (
      !options.chatWorker ||
      scope.environment !== "research" ||
      (!terminal(job["state"]) && job["state"] !== "unknown")
    )
      return;
    const row = await one(
      tx,
      "vertex_research_chat_worker_origins",
      scope,
      sql`job_id = ${job["job_id"]}`
    );
    if (!row) return;
    const origin = object(row["payload"]),
      chatScope = {
        accountAlias: scope.accountAlias,
        environment: "research" as const,
      };
    const original =
      await options.chatWorker.copies.readHistoricalOriginalForTransaction(
        tx,
        chatScope,
        identifier(origin["responseRequestId"])
      );
    if (
      (await ctx.hash(origin)) !== row["record_hash"] ||
      origin["jobId"] !== job["job_id"] ||
      origin["eventId"] !== job["event_id"] ||
      origin["ownerActorId"] !== original.plan["ownerActorId"] ||
      origin["planId"] !== original.plan["planId"] ||
      origin["planSha256"] !== original.plan["planSha256"] ||
      origin["requestSha256"] !== original.plan["requestSha256"] ||
      origin["approvalSha256"] !== (await ctx.hash(original.approval)) ||
      origin["runId"] !== original.plan["runId"] ||
      origin["recipeSha256"] !== (await ctx.hash(origin["recipe"]))
    )
      return fail("integrity");
    const lease = await parse("WorkerLease", job["payload"]);
    const binding = {
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
      lease["eventId"] !== origin["eventId"] ||
      lease["researchPrincipalId"] !== origin["ownerActorId"] ||
      lease["payloadArtifactId"] !== origin["recipeArtifactId"] ||
      lease["payloadSha256"] !== origin["recipeSha256"] ||
      lease["leaseId"] !== job["lease_id"] ||
      lease["leaseEpoch"] !== job["lease_epoch"] ||
      (await ctx.hash({ scope, eventId: origin["eventId"], ...binding })) !==
        job["binding_hash"]
    )
      return fail("integrity");
    await options.chatWorker.copies.closeResponseAttemptInputsForTransaction(
      tx,
      chatScope,
      identifier(origin["responseRequestId"]),
      "response-attempt-terminal",
      at
    );
    // Only separately proved original global loss may close derived/family.
    await options.chatWorker.copies.observeOriginalAuthorityLossForTransaction(
      tx,
      chatScope,
      identifier(origin["responseRequestId"]),
      ctx.now()
    );
  };
  const expire = async (
    tx: Transaction,
    scope: VertexScope,
    row: Row,
    at: string
  ): Promise<Row> => {
    if (
      !terminal(row["state"]) &&
      row["state"] !== "unknown" &&
      (BigInt(string(row["lease_expires_at_ns"])) <= time(at) ||
        BigInt(string(row["deadline_at_ns"])) <= time(at))
    ) {
      await tx.execute(
        sql`update vertex_worker_jobs set state = 'unknown' where ${scopeWhere(scope)} and job_id = ${row["job_id"]}`
      );
      await closeChatTerminalInputs(
        tx,
        scope,
        { ...row, state: "unknown" },
        ctx.now()
      );
      return { ...row, state: "unknown" };
    }
    if (terminal(row["state"]) || row["state"] === "unknown")
      await closeChatTerminalInputs(tx, scope, row, at);
    return row;
  };
  // Internal control composition only, NOT a worker RPC. Native callers cannot
  // prepare their own jobs. Exact claimed command + current principal rights
  // bind this immutable private payload before dispatch; no public DTO is forged.
  const prepareOutboxPayload = async (
    identity: WorkerServiceIdentity,
    outbox: VertexOutboxLease,
    input: WorkerPayloadPreparation
  ): Promise<Readonly<{ artifactId: string; artifactSha256: string }>> => {
    const scope = identity.scope;
    const bytes = new Uint8Array(input.bytes);
    if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) fail("invalid");
    const prepared = await transaction<
      | Readonly<{ artifactId: string; artifactSha256: string }>
      | typeof chatAuthorityClosed
    >(scope, async (tx, at) => {
      await grant(tx, identity, "claim", at);
      if (
        scope.accountAlias !== outbox.scope.accountAlias ||
        scope.environment !== outbox.scope.environment
      )
        fail("denied");
      const source = await one(
        tx,
        "vertex_outbox",
        scope,
        sql`event_id = ${outbox.eventId}`
      );
      if (
        !source ||
        source["lease_owner"] !== outbox.leaseOwner ||
        source["lease_fence"] !== outbox.leaseFence ||
        source["published_at"] !== null ||
        BigInt(string(source["lease_expires_at_ns"])) <= time(at) ||
        source["record_hash"] !== (await ctx.hash(outbox.payload))
      )
        fail("stale");
      const principal = { actorId: identifier(input.researchPrincipalId) };
      await ctx.authorize(
        principal,
        scope,
        outbox.collectionId,
        identifier(input.artifactId),
        "publish",
        at
      );
      const rights = await currentRights(
        tx,
        principal,
        scope,
        outbox.collectionId,
        identifier(input.rightsPolicyId),
        "store",
        at,
        identifier(input.rightsVersion)
      );
      let payload: VertexRecord;
      try {
        payload = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
      } catch {
        return fail("invalid");
      }
      const digest = await ctx.digest(bytes);
      if (digest !== input.sha256 || (await ctx.hash(payload)) !== digest)
        fail("integrity");
      const jobId = `job-${await ctx.hash({ scope, eventId: outbox.eventId })}`;
      const chat = await chatOriginal(
        tx,
        scope,
        { eventId: outbox.eventId },
        at
      );
      if (chat === chatAuthorityClosed) return chatAuthorityClosed;
      if (
        chat &&
        (input.researchPrincipalId !== chat.plan["ownerActorId"] ||
          input.artifactId !== chat.origin["recipeArtifactId"] ||
          digest !== chat.origin["recipeSha256"] ||
          (await ctx.hash(payload)) !== (await ctx.hash(chat.recipe)))
      )
        return fail("denied");
      if (
        !chat &&
        [
          "vertex-research-chat-job-v1",
          "vertex-research-chat-job-v2",
          "vertex-research-chat-native-evidence-job-v1",
        ].includes(String(payload["profile"]))
      )
        return fail("denied");
      const prior = await one(
        tx,
        "vertex_worker_stages",
        scope,
        sql`artifact_id = ${input.artifactId}`
      );
      const descriptor = {
        ...scope,
        jobId,
        collectionId: outbox.collectionId,
        artifactId: input.artifactId,
        contentSha256: digest,
        canonicalSha256: digest,
        contentType: "application/json",
        rightsPolicyId: rights.policyId,
        rightsVersion: rights.version,
        lineageArtifactIds: [],
        createdAt: prior ? object(prior["payload"])["createdAt"] : at,
      };
      const hash = await ctx.hash(descriptor);
      if (prior) {
        if (prior["request_hash"] !== hash || prior["job_id"] !== jobId)
          fail("conflict");
        return { artifactId: input.artifactId, artifactSha256: digest };
      }
      const objectKey = vertexQualifiedObjectKey(
        scope,
        outbox.collectionId,
        "manifest",
        digest
      );
      const capabilities = options.objectCapabilities(scope);
      if (!capabilities.putIfAbsent) return fail("unavailable");
      const saved = await capabilities.putIfAbsent({
        key: objectKey,
        body: bytes,
        contentType: "application/json",
        checksum: digest,
      });
      if (
        saved.status !== "ok" ||
        saved.value.key !== objectKey ||
        saved.value.size !== bytes.byteLength ||
        saved.value.checksum !== digest
      )
        fail("unavailable");
      await objectRead(scope, objectKey, digest);
      const now = ctx.now();
      await grant(tx, identity, "claim", now);
      if (BigInt(string(source["lease_expires_at_ns"])) <= time(now))
        fail("stale");
      await currentRights(
        tx,
        principal,
        scope,
        outbox.collectionId,
        rights.policyId,
        "store",
        now,
        rights.version
      );
      if (
        chat &&
        (await chatOriginal(
          tx,
          scope,
          { eventId: outbox.eventId },
          ctx.now()
        )) === chatAuthorityClosed
      )
        return chatAuthorityClosed;
      await insert(tx, "vertex_worker_stages", scope, {
        artifact_id: input.artifactId,
        job_id: jobId,
        collection_key: collectionKey(outbox.collectionId),
        object_key: objectKey,
        content_sha256: digest,
        canonical_sha256: digest,
        request_hash: hash,
        byte_length: bytes.byteLength,
        payload: descriptor,
      });
      return { artifactId: input.artifactId, artifactSha256: digest };
    });
    if (prepared === chatAuthorityClosed) return fail("denied");
    return prepared;
  };
  const enqueueNativeBootstrap = async (
    adminContext: unknown,
    raw: unknown
  ): Promise<
    Readonly<{ status: "accepted" | "duplicate"; eventId: string }>
  > => {
    const command = await parse("WorkerBootstrapCommand", raw);
    const scope: VertexScope = {
      accountAlias: identifier(command["accountAlias"]),
      environment: "paper",
    };
    return transaction(scope, async (tx, at) => {
      if (
        (await options.authorizeBootstrapEnqueue(
          adminContext,
          tx,
          scope,
          command
        )) !== true
      )
        fail("denied");
      const principal = { actorId: identifier(command["researchPrincipalId"]) };
      if (
        (await options.authorizeNativeBootstrap(
          tx,
          principal,
          scope,
          command
        )) !== true
      )
        fail("denied");
      if (
        time(command["issuedAt"]) > time(at) ||
        time(command["deadlineAt"]) <= time(at) ||
        (await ctx.hash(command["payload"])) !== command["payloadSha256"]
      )
        fail("invalid");
      const hash = await ctx.hash(command);
      const eventId = `bootstrap-${hash}`;
      const prior = await one(
        tx,
        "vertex_outbox",
        scope,
        sql`event_id = ${eventId} or idempotency_key = ${command["idempotencyKey"]}`
      );
      if (prior) {
        if (prior["record_hash"] !== hash || prior["event_id"] !== eventId)
          fail("conflict");
        return { status: "duplicate", eventId };
      }
      await ctx.ensureAccount(tx, scope, at);
      await insert(tx, "vertex_outbox", scope, {
        collection_key: "",
        event_id: eventId,
        event_type: "vertex.native-bootstrap.requested",
        idempotency_key: command["idempotencyKey"],
        record_hash: hash,
        payload: command,
        available_at_ns: time(at).toString(),
        lease_owner: null,
        lease_fence: "0",
        lease_expires_at: null,
        lease_expires_at_ns: null,
        published_at: null,
        settlement_hash: null,
      });
      return { status: "accepted", eventId };
    });
  };
  const bindOutbox = async (
    identity: WorkerServiceIdentity,
    outbox: VertexOutboxLease,
    binding: WorkerDispatchBinding
  ): Promise<VertexRecord> => {
    const scope = identity.scope;
    const bound = await transaction<VertexRecord | typeof chatAuthorityClosed>(
      scope,
      async (tx, at) => {
        await grant(tx, identity, "claim", at);
        if (binding.kind === "native-bootstrap") {
          await grant(tx, identity, "native-bootstrap", at);
          if (
            scope.environment !== "paper" ||
            outbox.eventType !== "vertex.native-bootstrap.requested"
          )
            fail("denied");
          const command = await parse("WorkerBootstrapCommand", outbox.payload);
          if (
            (await options.authorizeNativeBootstrap(
              tx,
              { actorId: binding.researchPrincipalId },
              scope,
              command
            )) !== true
          )
            fail("denied");
          for (const key of [
            "researchPrincipalId",
            "payloadArtifactId",
            "payloadSha256",
            "policySelectionId",
            "policySelectionSha256",
            "deadlineAt",
          ] as const) {
            if (command[key] !== binding[key]) fail("integrity");
          }
        }
        if (
          outbox.scope.accountAlias !== scope.accountAlias ||
          outbox.scope.environment !== scope.environment ||
          binding.workerInstanceId !== outbox.leaseOwner
        )
          fail("denied");
        const original = await one(
          tx,
          "vertex_outbox",
          scope,
          sql`event_id = ${outbox.eventId}`
        );
        if (
          !original ||
          original["lease_owner"] !== outbox.leaseOwner ||
          original["lease_fence"] !== outbox.leaseFence ||
          original["published_at"] !== null ||
          BigInt(string(original["lease_expires_at_ns"])) <= time(at) ||
          original["record_hash"] !== (await ctx.hash(outbox.payload))
        )
          fail("stale");
        const chat = await chatOriginal(
          tx,
          scope,
          { eventId: outbox.eventId },
          at
        );
        if (chat === chatAuthorityClosed) return chatAuthorityClosed;
        if (
          chat &&
          (binding.kind !== "research-run" ||
            binding.researchPrincipalId !== chat.plan["ownerActorId"] ||
            binding.payloadArtifactId !== chat.origin["recipeArtifactId"] ||
            binding.payloadSha256 !== chat.origin["recipeSha256"] ||
            binding.policySelectionId !== chat.plan["selectionId"] ||
            binding.policySelectionSha256 !== chat.plan["selectionSha256"] ||
            binding.deadlineAt !== chat.plan["expiresAt"])
        )
          return fail("denied");
        if (
          !chat &&
          string(binding.payloadArtifactId).startsWith("chat-recipe-")
        )
          return fail("denied");
        const { workerInstanceId: omittedWorker, ...stableBinding } = binding;
        const bindingHash = await ctx.hash({
          scope,
          eventId: outbox.eventId,
          ...stableBinding,
        });
        const prior = await one(
          tx,
          "vertex_worker_jobs",
          scope,
          sql`event_id = ${outbox.eventId}`
        );
        if (prior) {
          if (prior["binding_hash"] !== bindingHash) fail("conflict");
          const current = await expire(tx, scope, prior, at);
          if (
            current["grant_id"] !== identity.grantId ||
            current["worker_instance_id"] !== binding.workerInstanceId
          )
            return result(
              {
                ...current,
                state: terminal(current["state"])
                  ? current["state"]
                  : "unknown",
              },
              terminal(current["state"]) ? "completed" : "unknown"
            );
          return result(
            current,
            terminal(current["state"])
              ? "completed"
              : current["state"] === "unknown"
                ? "unknown"
                : "duplicate"
          );
        }
        if (time(binding.deadlineAt) <= time(at)) fail("stale");
        const principal = { actorId: identifier(binding.researchPrincipalId) };
        const artifact = await ctx.artifact(
          tx,
          principal,
          scope,
          outbox.collectionId,
          identifier(binding.payloadArtifactId),
          "read",
          at
        );
        const jobId = `job-${await ctx.hash({ scope, eventId: outbox.eventId })}`;
        if (artifact) {
          if (artifact.artifactSha256 !== binding.payloadSha256)
            fail("integrity");
        } else {
          const privatePayload = await staged(
            tx,
            principal,
            scope,
            identifier(binding.payloadArtifactId),
            outbox.collectionId,
            at,
            jobId
          );
          if (
            privatePayload["canonical_sha256"] !== binding.payloadSha256 ||
            privatePayload["content_sha256"] !== binding.payloadSha256
          )
            fail("integrity");
        }
        const leaseExpiresAt =
          time(outbox.leaseExpiresAt) < time(binding.deadlineAt)
            ? outbox.leaseExpiresAt
            : binding.deadlineAt;
        const lease = await parse("WorkerLease", {
          schemaVersion: "1.0.0",
          jobId,
          eventId: outbox.eventId,
          kind: binding.kind,
          researchPrincipalId: principal.actorId,
          ...scope,
          payloadArtifactId: binding.payloadArtifactId,
          payloadSha256: binding.payloadSha256,
          policySelectionId: binding.policySelectionId,
          policySelectionSha256: binding.policySelectionSha256,
          deadlineAt: binding.deadlineAt,
          leaseId: outbox.leaseOwner,
          leaseEpoch: outbox.leaseFence,
          leaseExpiresAt,
          attempt: 1,
        });
        const row = {
          job_id: jobId,
          event_id: outbox.eventId,
          grant_id: identity.grantId,
          worker_instance_id: binding.workerInstanceId,
          binding_hash: bindingHash,
          state: "leased",
          lease_id: outbox.leaseOwner,
          lease_epoch: outbox.leaseFence,
          lease_expires_at_ns: time(leaseExpiresAt).toString(),
          deadline_at_ns: time(binding.deadlineAt).toString(),
          attempt: 1,
          outcome_hash: null,
          output_artifact_ids: [],
          payload: lease,
        };
        await insert(tx, "vertex_worker_jobs", scope, row);
        await options.pinPolicySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: binding.policySelectionId,
            selectionSha256: binding.policySelectionSha256,
          },
          identity.servicePrincipalId,
          jobId
        );
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: binding.policySelectionId,
            selectionSha256: binding.policySelectionSha256,
          },
          identity.servicePrincipalId,
          jobId
        );
        const now = ctx.now();
        await grant(tx, identity, "claim", now);
        if (time(leaseExpiresAt) <= time(now)) fail("stale");
        if (
          chat &&
          (await chatOriginal(
            tx,
            scope,
            { eventId: outbox.eventId },
            ctx.now()
          )) === chatAuthorityClosed
        )
          return chatAuthorityClosed;
        return result(row, "accepted");
      }
    );
    if (bound === chatAuthorityClosed) return fail("denied");
    return bound;
  };
  const promote = async (
    tx: Transaction,
    local: PersistenceContext,
    principal: VertexPrincipal,
    scope: VertexScope,
    jobId: string,
    collection: string | null,
    contractName: string,
    record: VertexRecord,
    reference: VertexRecord,
    at: string,
    workerParent?: WorkerLineageParentResolver
  ): Promise<VertexArtifactMetadata> => {
    const stage = await staged(
      tx,
      principal,
      scope,
      identifier(reference["artifactId"]),
      collection,
      at,
      jobId
    );
    const descriptor = object(stage["payload"]);
    const canonical = ctx.encode(record);
    const sha = await ctx.digest(canonical);
    if (
      sha !== reference["artifactSha256"] ||
      sha !== stage["canonical_sha256"] ||
      stage["content_sha256"] !== sha
    )
      fail("integrity");
    const bytes = await objectRead(scope, string(stage["object_key"]), sha);
    if (
      bytes.byteLength !== canonical.byteLength ||
      !bytes.every((byte, index) => byte === canonical[index])
    )
      fail("integrity");
    const rights = await currentRights(
      tx,
      principal,
      scope,
      collection,
      string(descriptor["rightsPolicyId"]),
      "store",
      at,
      string(descriptor["rightsVersion"])
    );
    if (typeof record["contentHash"] === "string") {
      const source = await one(
        tx,
        "vertex_worker_stages",
        scope,
        sql`job_id = ${jobId} and collection_key = ${collectionKey(collection)} and content_sha256 = ${record["contentHash"]} and canonical_sha256 is null`
      );
      if (!source) fail("integrity");
      const sourceDescriptor = object(
        requirePresent(source, "source")["payload"]
      );
      if (
        (await ctx.hash(sourceDescriptor)) !==
          requirePresent(source, "source")["request_hash"] ||
        sourceDescriptor["rightsPolicyId"] !== rights.policyId ||
        sourceDescriptor["rightsVersion"] !== rights.version
      )
        fail("integrity");
      const sourceKey = vertexQualifiedObjectKey(
        scope,
        collection,
        "content",
        digestString(record["contentHash"])
      );
      if (requirePresent(source, "source")["object_key"] !== sourceKey)
        fail("integrity");
      await objectRead(scope, sourceKey, record["contentHash"]);
    }
    const metadata: VertexArtifactMetadata = {
      artifactId: identifier(reference["artifactId"]),
      scope,
      collectionId: collection,
      objectKey: string(stage["object_key"]),
      artifactSha256: sha,
      sourceContentSha256:
        typeof record["contentHash"] === "string"
          ? record["contentHash"]
          : null,
      byteLength: bytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName: contractName as VertexArtifactMetadata["contractName"],
      rights,
      lineageArtifactIds: array(descriptor["lineageArtifactIds"]).map(
        identifier
      ),
      createdAt: string(descriptor["createdAt"]),
    };
    await createResearchOperations(local, workerParent).registerArtifact(
      principal,
      metadata
    );
    return metadata;
  };
  const verifyReconstruction = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    jobId: string,
    index: VertexRecord,
    manifestSha256: string,
    at: string
  ): Promise<void> => {
    const imports = array(index["imports"], 64).map(object);
    const evidence = array(index["evidence"], 512).map(object);
    const contents = array(index["content"], 1024).map((entry) =>
      object(object(entry)["artifact"])
    );
    const manifestRef = object(index["manifest"]);
    const contentHashes = contents
      .map((ref) => digestString(ref["artifactSha256"]))
      .sort();
    if (
      new Set(contentHashes).size !== contentHashes.length ||
      manifestRef["artifactSha256"] !== manifestSha256
    )
      fail("integrity");
    let totalBytes = 0;
    const readMember = async (
      ref: VertexRecord,
      raw = false
    ): Promise<Uint8Array> => {
      const row = await staged(
        tx,
        principal,
        scope,
        identifier(ref["artifactId"]),
        collection,
        ctx.now(),
        jobId
      );
      if (
        (row["canonical_sha256"] ?? row["content_sha256"]) !==
        ref["artifactSha256"]
      )
        fail("integrity");
      if (
        raw &&
        (row["content_sha256"] !== ref["artifactSha256"] ||
          row["canonical_sha256"] !== null)
      )
        fail("integrity");
      const bytes = await objectRead(
        scope,
        string(row["object_key"]),
        string(row["content_sha256"])
      );
      totalBytes += bytes.byteLength;
      if (totalBytes > 64_000_000) fail("invalid");
      await ctx.authorize(
        principal,
        scope,
        collection,
        identifier(ref["artifactId"]),
        "read",
        ctx.now()
      );
      return bytes;
    };
    const readJson = async (ref: VertexRecord): Promise<VertexRecord> => {
      const bytes = await readMember(ref);
      try {
        const value = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
        if ((await ctx.hash(value)) !== ref["artifactSha256"])
          fail("integrity");
        return value;
      } catch {
        return fail("integrity");
      }
    };
    for (const ref of contents) await readMember(ref, true);
    const manifest = await readJson(manifestRef);
    if (
      manifest["collectionId"] !== collection ||
      manifest["snapshotId"] !== index["snapshotId"] ||
      manifest["expectedSnapshotId"] !== index["expectedSnapshotId"] ||
      manifest["preparedAt"] !== index["preparedAt"] ||
      manifest["untrustedContent"] !== true ||
      time(index["preparedAt"]) > time(at)
    )
      fail("integrity");
    if (
      (await ctx.hash(manifest["importDigests"])) !==
        (await ctx.hash(imports.map((ref) => ref["artifactSha256"]))) ||
      (await ctx.hash(manifest["evidenceDigests"])) !==
        (await ctx.hash(evidence.map((ref) => ref["artifactSha256"]))) ||
      (await ctx.hash(manifest["contentDigests"])) !==
        (await ctx.hash(contentHashes)) ||
      (await ctx.hash(manifest["rightsRevisions"])) !==
        (await ctx.hash(index["rightsRevisions"]))
    )
      fail("integrity");
    const requiredHashes = new Set<string>();
    const sources = new Map<string, string>();
    const unavailable = new Set<string>();
    const sourcePolicies = new Map<string, string>();
    const profiles = new Set<string>();
    const evidenceIds = new Set<string>();
    for (const ref of imports) {
      const record = await ctx.validate("KnowledgeImport", await readJson(ref));
      if (
        record["collectionId"] !== collection ||
        record["snapshotId"] !== index["snapshotId"]
      )
        fail("integrity");
      profiles.add(
        JSON.stringify([
          record["rightsPolicyId"],
          record["contentClass"],
          record["transcriptQuality"],
        ])
      );
      for (const hash of array(record["contentHashes"]))
        requiredHashes.add(digestString(hash));
      for (const source of array(record["sourceIdentities"]).map(object)) {
        const sourceId = identifier(source["sourceId"]);
        if (
          sources.has(sourceId) ||
          unavailable.has(sourceId) ||
          source["snapshotId"] !== index["snapshotId"]
        )
          fail("integrity");
        sources.set(sourceId, digestString(source["contentHash"]));
        requiredHashes.add(digestString(source["contentHash"]));
      }
      for (const source of array(record["unavailableSources"]).map(object)) {
        const sourceId = identifier(source["sourceId"]);
        if (sources.has(sourceId) || unavailable.has(sourceId))
          fail("integrity");
        unavailable.add(sourceId);
      }
    }
    for (const ref of evidence) {
      const record = await ctx.validate(
        "ResearchEvidence",
        await readJson(ref)
      );
      if (
        record["collectionId"] !== collection ||
        record["snapshotId"] !== index["snapshotId"]
      )
        fail("integrity");
      const source = object(record["sourceIdentity"]);
      const sourceId = identifier(source["sourceId"]);
      const evidenceId = identifier(record["evidenceId"]);
      if (
        evidenceIds.has(evidenceId) ||
        sources.get(sourceId) !== record["contentHash"] ||
        source["snapshotId"] !== index["snapshotId"] ||
        (sourcePolicies.has(sourceId) &&
          sourcePolicies.get(sourceId) !== record["rightsPolicyId"])
      )
        fail("integrity");
      evidenceIds.add(evidenceId);
      sourcePolicies.set(sourceId, identifier(record["rightsPolicyId"]));
      requiredHashes.add(digestString(record["contentHash"]));
    }
    if ([...requiredHashes].some((hash) => !contentHashes.includes(hash)))
      fail("integrity");
    if (profiles.size !== 1 || sourcePolicies.size !== sources.size)
      fail("integrity");
    const membership = array(manifest["membership"], 10_000).map(object);
    if (
      membership.length !== sources.size + unavailable.size ||
      new Set(membership.map((entry) => entry["sourceId"])).size !==
        membership.length
    )
      fail("integrity");
    for (const entry of membership) {
      const sourceId = identifier(entry["sourceId"]);
      if (!(sources.has(sourceId) || unavailable.has(sourceId)))
        fail("integrity");
      if (
        sources.has(sourceId) &&
        (entry["contentHash"] !== sources.get(sourceId) ||
          entry["rightsPolicyId"] !== sourcePolicies.get(sourceId))
      )
        fail("integrity");
    }
    const collectionPolicy = JSON.parse(
      requirePresent([...profiles][0], "[...profiles][0]")
    )[0] as string;
    const expectedPolicies = new Map([
      ["collection", collectionPolicy],
      ...sourcePolicies,
    ]);
    const revisions = array(index["rightsRevisions"], 1024).map((entry) =>
      array(entry, 3)
    );
    if (
      revisions.length !== expectedPolicies.size ||
      new Set(revisions.map((entry) => entry[0])).size !== revisions.length
    )
      fail("integrity");
    for (const revision of revisions) {
      if (
        revision.length !== 3 ||
        expectedPolicies.get(identifier(revision[0])) !== revision[1]
      )
        fail("integrity");
      await currentRights(
        tx,
        principal,
        scope,
        collection,
        identifier(revision[1]),
        "read",
        ctx.now(),
        identifier(revision[2])
      );
    }
    const canonicalSources = new Map<string, string>();
    const duplicates: VertexRecord[] = [];
    for (const sourceId of [...sources.keys()].sort()) {
      const hash = requirePresent(
        sources.get(sourceId),
        "sources.get(sourceId)"
      );
      if (canonicalSources.has(hash)) {
        duplicates.push({
          sourceId,
          canonicalSourceId: canonicalSources.get(hash),
          contentHash: hash,
        });
      } else canonicalSources.set(hash, sourceId);
    }
    if (
      (await ctx.hash(manifest["globalDuplicateMappings"])) !==
      (await ctx.hash(duplicates))
    )
      fail("integrity");
  };
  const readCollection = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string,
    snapshot: string | null,
    at: string
  ): Promise<VertexRecord> => {
    await ctx.authorize(principal, scope, collection, collection, "read", at);
    const head = await one(
      tx,
      "vertex_collections",
      scope,
      sql`collection_id = ${collection}`
    );
    const snapshotId = snapshot ?? head?.["active_snapshot_id"];
    if (typeof snapshotId !== "string") return fail("unavailable");
    const generation = await one(
      tx,
      "vertex_collection_generations",
      scope,
      sql`collection_id = ${collection} and snapshot_id = ${snapshotId}`
    );
    if (
      !generation ||
      (await ctx.hash(generation["payload"])) !== generation["request_hash"]
    )
      fail("integrity");
    const reconstruction = await one(
      tx,
      "vertex_worker_collection_snapshots",
      scope,
      sql`collection_id = ${collection} and snapshot_id = ${snapshotId}`
    );
    if (
      !reconstruction ||
      (await ctx.hash(reconstruction["payload"])) !==
        reconstruction["record_hash"]
    )
      fail("unavailable");
    for (const pin of array(
      requirePresent(reconstruction, "reconstruction")["rights_pins"],
      1024
    ).map(object)) {
      await currentRights(
        tx,
        principal,
        scope,
        collection,
        identifier(pin["policyId"]),
        "read",
        ctx.now(),
        identifier(pin["version"])
      );
    }
    const index = await staged(
      tx,
      principal,
      scope,
      identifier(
        requirePresent(reconstruction, "reconstruction")[
          "reconstruction_artifact_id"
        ]
      ),
      collection,
      at,
      string(requirePresent(reconstruction, "reconstruction")["job_id"])
    );
    if (
      index["canonical_sha256"] !==
      requirePresent(reconstruction, "reconstruction")["reconstruction_sha256"]
    )
      fail("integrity");
    const indexBytes = await objectRead(
      scope,
      string(index["object_key"]),
      string(index["content_sha256"])
    );
    let reconstructed: VertexRecord;
    try {
      reconstructed = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes))
      );
    } catch {
      return fail("integrity");
    }
    if (
      (await ctx.hash(reconstructed)) !==
        requirePresent(reconstruction, "reconstruction")[
          "reconstruction_sha256"
        ] ||
      reconstructed["collectionId"] !== collection ||
      reconstructed["snapshotId"] !== snapshotId
    )
      fail("integrity");
    await verifyReconstruction(
      tx,
      principal,
      scope,
      collection,
      string(requirePresent(reconstruction, "reconstruction")["job_id"]),
      reconstructed,
      string(
        requirePresent(reconstruction, "reconstruction")["manifest_sha256"]
      ),
      at
    );
    const shards = await rows(
      tx,
      sql`select * from vertex_collection_shards where ${scopeWhere(scope)} and collection_id = ${collection} and snapshot_id = ${snapshotId} order by shard_ordinal limit 65`
    );
    if (
      shards.length !==
        requirePresent(generation, "generation")["shard_count"] ||
      shards.length < 1 ||
      shards.length > 64
    )
      fail("integrity");
    const importArtifacts: { artifactId: string; artifactSha256: string }[] =
      [];
    for (const shard of shards) {
      const metadata = await ctx.artifact(
        tx,
        principal,
        scope,
        collection,
        identifier(shard["import_artifact_id"]),
        "read",
        at
      );
      if (
        !metadata ||
        metadata.artifactSha256 !== shard["import_artifact_sha256"]
      )
        fail("integrity");
      importArtifacts.push({
        artifactId: requirePresent(metadata, "metadata").artifactId,
        artifactSha256: requirePresent(metadata, "metadata").artifactSha256,
      });
    }
    return {
      status: "available",
      collectionId: collection,
      snapshotId,
      previousSnapshotId: requirePresent(generation, "generation")[
        "previous_snapshot_id"
      ],
      importArtifacts,
      reconstructionArtifact: {
        artifactId: requirePresent(reconstruction, "reconstruction")[
          "reconstruction_artifact_id"
        ],
        artifactSha256: requirePresent(reconstruction, "reconstruction")[
          "reconstruction_sha256"
        ],
      },
      manifestSha256: requirePresent(reconstruction, "reconstruction")[
        "manifest_sha256"
      ],
    };
  };

  const inputNames: Readonly<Record<string, string>> = {
    currentModelUse: "WorkerCurrentModelUseInput",
    publishEpochTransition: "WorkerPublishEpochTransitionInput",
    prepareModelPrivacyReview: "WorkerPrepareModelPrivacyReviewInput",
    readModelPrivacyReview: "WorkerReadModelPrivacyReviewInput",
    prepareNativeEvidencePhaseTwo: "WorkerPrepareNativeEvidencePhaseTwoInput",
    replayNativeOutbox: "WorkerReplayNativeOutboxInput",
    publishExperiment: "WorkerPublishExperimentInput",
    readExperiment: "WorkerReadExperimentInput",
    readBacktestRun: "WorkerReadBacktestRunInput",
    readDataset: "WorkerReadDatasetInput",
    publishPortfolioSnapshot: "WorkerPublishPortfolioSnapshotInput",
    currentRightsObservation: "WorkerCurrentRightsObservationInput",
    acceptedEvidenceObservation: "WorkerAcceptedEvidenceObservationInput",
    renew: "WorkerRenewInput",
    complete: "WorkerCompleteInput",
    cancel: "WorkerCancelInput",
    status: "WorkerStatusInput",
    admitRun: "WorkerAdmitRunInput",
    readArtifact: "WorkerReadArtifactInput",
    stageArtifact: "WorkerStageArtifactInput",
    publishArtifact: "WorkerPublishArtifactInput",
    publishAgent: "WorkerPublishAgentInput",
    publishCollection: "WorkerPublishCollectionInput",
    activateCollection: "WorkerActivateCollectionInput",
    readCollection: "WorkerReadCollectionInput",
    currentRights: "WorkerCurrentRightsInput",
    acceptedEvidence: "WorkerAcceptedEvidenceInput",
    currentPaperAdmission: "WorkerCurrentPaperAdmissionInput",
    publishGenesis: "WorkerPublishGenesisInput",
    publishOrderProjection: "WorkerPublishOrderProjectionInput",
    publishNativeFacts: "WorkerPublishNativeFactsInput",
    readContinuity: "WorkerReadContinuityInput",
    readiness: "WorkerReadinessInput",
    policySelection: "WorkerPolicySelectionInput",
  };
  const sourceRequestForWorker = async (
    identity: WorkerServiceIdentity,
    operation: string,
    value: VertexRecord,
    plan: VertexRecord,
    leaseExpiresAtNs: unknown
  ): Promise<ResearchChatSourceRequest> => {
    if (identity.scope.environment !== "research") return fail("denied");
    const leaseEnd = new Date(
      Number(BigInt(string(leaseExpiresAtNs)) / 1_000_000n)
    ).toISOString();
    return {
      scope: {
        accountAlias: identity.scope.accountAlias,
        environment: "research",
      },
      ownerActorId: identifier(plan["ownerActorId"]),
      requesterActorId: identity.servicePrincipalId,
      threadId: identifier(plan["threadId"]),
      responseRequestId: identifier(plan["responseRequestId"]),
      requestSha256: string(plan["requestSha256"]),
      planSha256: string(plan["planSha256"]),
      planExpiresAt: [
        string(plan["expiresAt"]),
        leaseEnd,
        identity.expiresAt,
      ].reduce((a, b) => (time(a) <= time(b) ? a : b)),
      purpose: `worker-${operation}-${await ctx.hash({ jobId: value["jobId"], leaseId: value["leaseId"], leaseEpoch: value["leaseEpoch"], grantId: identity.grantId })}`,
      predecessors: array(object(plan["debate"])["predecessors"], 4).map(
        object
      ),
    };
  };
  const invokeTransaction = async (
    identity: WorkerServiceIdentity,
    operation: string,
    raw: unknown,
    governedBytes?: Uint8Array,
    advisoryReceipt?: Readonly<{ metadata: VertexRecord; duplicate: boolean }>,
    sourceInputs?: ResearchChatSourceInputs,
    nativePhaseReceipt?: VertexRecord
  ): Promise<unknown> => {
    const contract = inputNames[operation];
    if (!contract) return fail("invalid");
    const value = await parse(contract, raw);
    const scope = identity.scope;
    if (
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment
    )
      fail("denied");
    return transaction(scope, async (tx, at) => {
      await grant(tx, identity, operation, at);
      const found = await one(
        tx,
        "vertex_worker_jobs",
        scope,
        sql`job_id = ${value["jobId"]}`
      );
      if (!found || found["grant_id"] !== identity.grantId)
        return fail("denied");
      let job = await expire(tx, scope, found, at);
      if (operation === "status")
        return result(
          job,
          terminal(job["state"])
            ? "completed"
            : job["state"] === "unknown"
              ? "unknown"
              : "accepted"
        );
      if (
        options.chatWorker &&
        (terminal(job["state"]) || job["state"] === "unknown") &&
        (await one(
          tx,
          "vertex_research_chat_worker_origins",
          scope,
          sql`job_id = ${job["job_id"]}`
        ))
      )
        return chatAuthorityClosed;
      if (
        job["lease_id"] !== value["leaseId"] ||
        job["lease_epoch"] !== value["leaseEpoch"] ||
        BigInt(string(job["lease_expires_at_ns"])) <= time(at) ||
        BigInt(string(job["deadline_at_ns"])) <= time(at)
      )
        fail("stale");
      const lease = await parse("WorkerLease", job["payload"]);
      const chat = await chatOriginal(
        tx,
        scope,
        { jobId: identifier(value["jobId"]) },
        at
      );
      if (chat === chatAuthorityClosed) return chatAuthorityClosed;
      if (
        !chat &&
        string(lease["payloadArtifactId"]).startsWith("chat-recipe-")
      )
        return fail("denied");
      if (!chat && value["chatCompletion"] !== undefined)
        return fail("invalid");
      if (chat) {
        if (
          lease["kind"] !== "research-run" ||
          lease["researchPrincipalId"] !== chat.plan["ownerActorId"] ||
          lease["eventId"] !== chat.origin["eventId"] ||
          lease["payloadArtifactId"] !== chat.origin["recipeArtifactId"] ||
          lease["payloadSha256"] !== chat.origin["recipeSha256"] ||
          lease["policySelectionId"] !== chat.plan["selectionId"] ||
          lease["policySelectionSha256"] !== chat.plan["selectionSha256"] ||
          lease["deadlineAt"] !== chat.plan["expiresAt"]
        )
          return fail("denied");
        if (
          ![
            "admitRun",
            "readArtifact",
            "currentModelUse",
            "prepareModelPrivacyReview",
            "readModelPrivacyReview",
            "prepareNativeEvidencePhaseTwo",
            "currentRights",
            "acceptedEvidence",
            "currentRightsObservation",
            "acceptedEvidenceObservation",
            "policySelection",
            "renew",
            "stageArtifact",
            "publishAgent",
            "complete",
            "cancel",
          ].includes(operation)
        )
          return fail("unavailable");
        // Completion first commits any real expiry before asking its outer root
        // for fresh sources. Status/cancel do not disclose or publish content.
        if (
          chat.plan["format"] === "vertex-research-chat-plan-v2" &&
          operation !== "cancel" &&
          !sourceInputs
        ) {
          if (operation === "complete") return chatSourcesRequired;
          return fail("denied");
        }
      }
      let bootstrapCommand: VertexRecord | null = null;
      if (lease["kind"] === "native-bootstrap") {
        await grant(tx, identity, "native-bootstrap", at);
        if (
          scope.environment !== "paper" ||
          ![
            "renew",
            "complete",
            "cancel",
            "status",
            "admitRun",
            "readArtifact",
            "currentRights",
            "stageArtifact",
            "readContinuity",
            "readiness",
            "policySelection",
            "publishGenesis",
            "publishPortfolioSnapshot",
            "publishEpochTransition",
            "replayNativeOutbox",
          ].includes(operation)
        )
          fail("denied");
        const commandRow = await one(
          tx,
          "vertex_outbox",
          scope,
          sql`event_id = ${lease["eventId"]} and event_type = 'vertex.native-bootstrap.requested'`
        );
        if (!commandRow) fail("denied");
        bootstrapCommand = await parse(
          "WorkerBootstrapCommand",
          requirePresent(commandRow, "commandRow")["payload"]
        );
        if (
          (await options.authorizeNativeBootstrap(
            tx,
            { actorId: identifier(lease["researchPrincipalId"]) },
            scope,
            bootstrapCommand
          )) !== true
        )
          fail("denied");
      }
      const principal = { actorId: identifier(lease["researchPrincipalId"]) };
      const local = boundContext(tx, at, scope);
      const research = createResearchOperations(local);
      const queries = createQueryOperations(local);
      const projections = createProjectionOperations(local);
      const finalChecks: ((now: string) => Promise<unknown>)[] = [];
      if (
        chat?.plan["format"] === "vertex-research-chat-plan-v2" &&
        operation !== "cancel"
      ) {
        if (!(options.chatOutput && sourceInputs)) return fail("denied");
        const expected = await sourceRequestForWorker(
          identity,
          operation,
          value,
          chat.plan,
          job["lease_expires_at_ns"]
        );
        const outputOwner = options.chatOutput,
          sources = sourceInputs;
        const check = async (now: string): Promise<void> => {
          await outputOwner.recheckSourceInputsForTransaction(
            tx,
            expected,
            sources.token,
            now
          );
        };
        await check(ctx.now());
        finalChecks.push(check);
      }
      let finalCheckObservedAt: string | null = null;
      const ensureCurrent = async (): Promise<void> => {
        const now = ctx.now();
        await grant(tx, identity, operation, now);
        if (
          time(now) >= BigInt(string(job["lease_expires_at_ns"])) ||
          time(now) >= BigInt(string(job["deadline_at_ns"]))
        )
          fail("stale");
        for (const check of finalChecks) await check(now);
        finalCheckObservedAt = now;
      };
      const pinRights = (
        collection: string | null,
        policyId: string,
        version: string,
        use: "store" | "read" | "derive" = "store"
      ): void => {
        finalChecks.push(async (now) => {
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            policyId,
            use,
            now,
            version
          );
        });
      };
      const finish = async <T>(output: T): Promise<T> => {
        // The concrete original owner may already have written irreversible
        // loss closure during model-use. Commit it before lease/grant expiry
        // turns this request into an outside-the-transaction denial.
        if (
          chat &&
          (await chatOriginal(
            tx,
            scope,
            { jobId: identifier(value["jobId"]) },
            ctx.now()
          )) === chatAuthorityClosed
        )
          return chatAuthorityClosed as unknown as T;
        await ensureCurrent();
        if (
          chat &&
          (await chatOriginal(
            tx,
            scope,
            { jobId: identifier(value["jobId"]) },
            ctx.now()
          )) === chatAuthorityClosed
        )
          return chatAuthorityClosed as unknown as T;
        return output;
      };
      const finishObservation = async (
        output: VertexRecord,
        contractName: string,
        format: string
      ): Promise<unknown> => {
        const checked: unknown = await finish(output);
        // Never wrap the closure sentinel: the outer owner must commit then deny.
        if (checked === chatAuthorityClosed) return checked;
        if (finalCheckObservedAt === null) return fail("unavailable");
        return parse(contractName, {
          format,
          observedAt: finalCheckObservedAt,
          value: checked,
        });
      };
      const finishTerminal = async <T>(output: T): Promise<T> => {
        const checked = await finish(output);
        if (checked === chatAuthorityClosed) return checked;
        if (chat) await closeChatTerminalInputs(tx, scope, job, ctx.now());
        return checked;
      };
      const selectedBacktestParent: WorkerLineageParentResolver = async (
        collection,
        id,
        use,
        now
      ) => {
        if (
          scope.environment !== "research" ||
          lease["kind"] !== "backtest" ||
          job["state"] !== "running" ||
          collection === null
        ) {
          return ctx.artifact(tx, principal, scope, collection, id, use, now);
        }
        const selected = await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        const recipes = array(selected["artifacts"], 512)
          .map(object)
          .filter(
            (item) =>
              item["role"] === "simulation-engine" &&
              object(item["artifact"])["contractName"] === "HostBacktestRecipe"
          );
        if (recipes.length !== 1) return fail("denied");
        const ref = object(
          requirePresent(recipes[0], "recipes[0]")["artifact"]
        );
        const stage = await staged(
          tx,
          principal,
          scope,
          identifier(ref["artifactId"]),
          null,
          now
        );
        if (
          ref["schemaVersion"] !== "1.0.0" ||
          stage["content_sha256"] !== ref["artifactSha256"] ||
          stage["canonical_sha256"] !== ref["artifactSha256"] ||
          object(stage["payload"])["contentType"] !== "application/json" ||
          stage["object_key"] !==
            vertexQualifiedObjectKey(
              scope,
              null,
              "manifest",
              digestString(ref["artifactSha256"])
            )
        )
          fail("integrity");
        await ctx.authorize(
          principal,
          scope,
          null,
          identifier(ref["artifactId"]),
          "read",
          now
        );
        const bytes = await objectRead(
          scope,
          string(stage["object_key"]),
          digestString(ref["artifactSha256"])
        );
        let recipe: VertexRecord;
        try {
          recipe = object(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          );
        } catch {
          return fail("integrity");
        }
        const canonical = ctx.encode(recipe);
        if (
          (await ctx.hash(recipe)) !== ref["artifactSha256"] ||
          canonical.byteLength !== bytes.byteLength ||
          !bytes.every((byte, index) => byte === canonical[index])
        )
          fail("integrity");
        if (recipe["format"] !== "vertex-host-backtest-recipe-v3")
          return ctx.artifact(tx, principal, scope, collection, id, use, now);
        if (
          Object.keys(recipe).sort().join(",") !==
            "budget,datasets,descriptor,evidence,format,lineage,model,plannedAt,publication,reviewPins,run,strategy" ||
          object(recipe["publication"])["collectionId"] !== collection ||
          object(recipe["publication"])["actorId"] !== principal.actorId
        )
          fail("denied");
        const payload = {
          format: "vertex-backtest-job-v1",
          recipeArtifactId: ref["artifactId"],
          recipeSha256: ref["artifactSha256"],
        };
        if ((await ctx.hash(payload)) !== lease["payloadSha256"])
          fail("denied");
        const admission = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`job_id = ${job["job_id"]}`
        );
        if (
          !admission ||
          admission["request_hash"] !== lease["payloadSha256"] ||
          admission["lease_epoch"] !== lease["leaseEpoch"]
        )
          fail("denied");
        const entries = array(recipe["datasets"], 1)
          .map(object)
          .filter(
            (candidate) => object(candidate["manifest"])["artifactId"] === id
          );
        if (entries.length === 0)
          return ctx.artifact(tx, principal, scope, collection, id, use, now);
        const entry = requirePresent(entries[0], "entries[0]");
        if (
          entries.length !== 1 ||
          Object.keys(entry).sort().join(",") !==
            "collectionId,content,contentFormat,declaredEvents,manifest,reviewPins" ||
          entry["contentFormat"] !== "vertex-ibkr-historical-bars-v1"
        )
          fail("integrity");
        const sourceCollection =
          entry["collectionId"] === null
            ? null
            : identifier(entry["collectionId"]);
        if (sourceCollection !== null && sourceCollection !== collection)
          fail("denied");
        const manifestRef = object(entry["manifest"]);
        const metadata = await ctx.artifact(
          tx,
          principal,
          scope,
          sourceCollection,
          id,
          use,
          now
        );
        const record = await one(
          tx,
          "vertex_records",
          scope,
          sql`artifact_id = ${id} and collection_key = ${collectionKey(sourceCollection)} and contract_name = 'DatasetManifest'`
        );
        if (
          !(metadata && record) ||
          metadata.contractName !== "DatasetManifest" ||
          metadata.artifactSha256 !== manifestRef["sha256"] ||
          record["artifact_sha256"] !== manifestRef["sha256"] ||
          record["record_hash"] !== manifestRef["sha256"] ||
          (await ctx.hash(record["payload"])) !== manifestRef["sha256"]
        )
          return fail("denied");
        const manifest = object(record["payload"]);
        const manifestStage = await staged(
          tx,
          principal,
          scope,
          id,
          sourceCollection,
          now
        );
        const producer = await one(
          tx,
          "vertex_worker_jobs",
          scope,
          sql`job_id = ${manifestStage["job_id"]}`
        );
        if (
          producer?.["state"] !== "succeeded" ||
          !array(producer["output_artifact_ids"], 64).includes(id)
        )
          fail("denied");
        const graph = await historicalDataset(
          tx,
          principal,
          scope,
          sourceCollection,
          identifier(manifestStage["job_id"]),
          manifest,
          now
        );
        if (
          object(entry["content"])["artifactId"] !==
            graph.content.ref.artifactId ||
          object(entry["content"])["sha256"] !==
            graph.content.ref.artifactSha256
        )
          fail("integrity");
        const pins = array(entry["reviewPins"], 1).map(object);
        if (pins.length !== 1) fail("denied");
        const pin = requirePresent(pins[0], "pins[0]");
        const wholePins = array(recipe["reviewPins"], 32).map(object);
        if (
          !(
            await Promise.all(
              wholePins.map(
                async (candidate) =>
                  (await ctx.hash(candidate)) === (await ctx.hash(pin))
              )
            )
          ).some(Boolean)
        )
          fail("denied");
        const accepted = await createQueryOperations(
          boundContext(tx, now, scope)
        ).getAcceptedEvidence(
          principal,
          scope,
          collection,
          identifier(pin["evidenceId"])
        );
        if (
          !accepted ||
          pin["collectionId"] !== collection ||
          accepted.artifact.artifactId !== pin["artifactId"] ||
          accepted.artifact.artifactSha256 !== pin["artifactSha256"] ||
          accepted.review["reviewId"] !== pin["reviewId"] ||
          accepted.review["reviewVersion"] !== pin["reviewVersion"] ||
          accepted.evidence["contentHash"] !==
            graph.capture.ref.artifactSha256 ||
          (await ctx.hash(accepted.evidence["sourceIdentity"])) !==
            (await ctx.hash(graph.source))
        )
          fail("denied");
        const exactPin = {
          collectionId: collection,
          evidenceId: accepted.evidence["evidenceId"],
          artifactId: accepted.artifact.artifactId,
          artifactSha256: accepted.artifact.artifactSha256,
          reviewId: accepted.review["reviewId"],
          reviewVersion: accepted.review["reviewVersion"],
          rightsPolicyId: accepted.artifact.rights.policyId,
          rightsVersion: accepted.artifact.rights.version,
        };
        if ((await ctx.hash(pin)) !== (await ctx.hash(exactPin)))
          fail("denied");
        await ctx.authorize(
          { actorId: identifier(accepted.review["actorId"]) },
          scope,
          collection,
          identifier(pin["artifactId"]),
          "review",
          now
        );
        for (const requiredUse of ["read", "derive"] as const) {
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            identifier(pin["rightsPolicyId"]),
            requiredUse,
            now,
            identifier(pin["rightsVersion"])
          );
        }
        return metadata;
      };
      const bootstrapSelection = async (): Promise<VertexRecord> => {
        const selected = await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        if (
          selected["selectionId"] !== lease["policySelectionId"] ||
          selected["selectionSha256"] !== lease["policySelectionSha256"] ||
          selected["accountAlias"] !== scope.accountAlias ||
          selected["environment"] !== scope.environment ||
          time(selected["expiresAt"]) <= time(ctx.now())
        )
          fail("denied");
        return selected;
      };
      const bootstrapLicense = async (): Promise<VertexRecord> => {
        const selected = await bootstrapSelection();
        const pins = array(selected["policies"], 128)
          .map(object)
          .filter((pin) => pin["role"] === "licensing-rights");
        if (pins.length !== 1) return fail("denied");
        finalChecks.push(async () => {
          await bootstrapSelection();
        });
        return requirePresent(pins[0], "pins[0]");
      };
      const authorizeBootstrapRead = async (
        artifactId: string,
        hash: string,
        ownStage: boolean
      ): Promise<void> => {
        if (lease["kind"] !== "native-bootstrap") return;
        if (value["collectionId"] !== null) fail("denied");
        if (
          artifactId === lease["payloadArtifactId"] &&
          hash === lease["payloadSha256"]
        )
          return;
        if (
          ownStage &&
          [
            `native-outbox-evidence-${hash}`,
            `native-owner-fence-${hash}`,
          ].includes(artifactId)
        )
          return;
        const selected = await bootstrapSelection();
        const pins = [
          ...array(selected["sourcePins"], 128).map((pin) =>
            object(object(pin)["provenanceArtifact"])
          ),
          ...array(selected["modules"], 128).map((pin) =>
            object(object(pin)["artifact"])
          ),
          ...array(selected["policies"], 128).map((pin) =>
            object(object(pin)["artifact"])
          ),
          ...array(selected["artifacts"], 512).map((pin) =>
            object(object(pin)["artifact"])
          ),
        ];
        if (
          !pins.some(
            (pin) =>
              pin["artifactId"] === artifactId && pin["artifactSha256"] === hash
          )
        )
          fail("denied");
        finalChecks.push(async () => {
          await bootstrapSelection();
        });
      };
      const recordOutputs = async (
        artifactIds: readonly string[]
      ): Promise<void> => {
        const outputs = [
          ...new Set([
            ...array(job["output_artifact_ids"], 64).map(identifier),
            ...artifactIds,
          ]),
        ].sort();
        if (outputs.length > 64) fail("invalid");
        await tx.execute(
          sql`update vertex_worker_jobs set output_artifact_ids = ${json(outputs)} where ${scopeWhere(scope)} and job_id = ${job["job_id"]}`
        );
        job = { ...job, output_artifact_ids: outputs };
      };
      if (operation === "prepareNativeEvidencePhaseTwo") {
        if (
          !(
            chat &&
            isNativeEvidencePlan(chat.plan) &&
            options.chatOutput &&
            options.chatWorker
          ) ||
          scope.environment !== "research" ||
          job["state"] !== "running"
        )
          return fail("denied");
        const request = object(value["request"]),
          proof = object(value["proof"]);
        if (
          request["operation"] !== "model-completion" ||
          request["accountAlias"] !== scope.accountAlias ||
          request["environment"] !== scope.environment ||
          request["jobId"] !== value["jobId"] ||
          request["leaseId"] !== value["leaseId"] ||
          request["leaseEpoch"] !== value["leaseEpoch"] ||
          request["researchPrincipalId"] !== principal.actorId ||
          request["consumerServiceId"] !== identity.servicePrincipalId ||
          request["selectionId"] !== lease["policySelectionId"] ||
          request["selectionSha256"] !== lease["policySelectionSha256"] ||
          time(request["deadlineAt"]) > time(lease["deadlineAt"]) ||
          proof["decision"] !== "allowed" ||
          proof["externalDispatchAllowed"] !== false ||
          proof["requestSha256"] !== request["requestSha256"]
        )
          return fail("denied");
        const chatScope = {
          accountAlias: scope.accountAlias,
          environment: "research" as const,
        };
        const admission = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`job_id = ${job["job_id"]}`
        );
        if (
          !admission ||
          admission["run_id"] !== chat.plan["runId"] ||
          admission["request_hash"] !== chat.origin["recipeSha256"] ||
          admission["lease_epoch"] !== value["leaseEpoch"] ||
          time(admission["admitted_at"]) > time(at)
        )
          return fail("denied");
        const check = async (now: string): Promise<void> => {
          const phaseOne = await requirePresent(
            options.chatWorker,
            "options.chatWorker"
          ).copies.readNativePhaseForTransaction(
            tx,
            chatScope,
            identifier(chat.plan["responseRequestId"]),
            1,
            now
          );
          if (
            !phaseOne ||
            phaseOne.planSha256 !== chat.plan["planSha256"] ||
            phaseOne.completionInput.sha256 !== request["inputSha256"] ||
            phaseOne.completionInput.byteLength !== request["inputBytes"]
          )
            return fail("denied");
          await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(lease["policySelectionId"]),
              selectionSha256: string(lease["policySelectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          );
          if (!nativePhaseReceipt) return;
          const phase = await requirePresent(
            options.chatWorker,
            "options.chatWorker"
          ).copies.readNativePhaseForTransaction(
            tx,
            chatScope,
            identifier(chat.plan["responseRequestId"]),
            2,
            now
          );
          if (
            !phase ||
            (await ctx.hash(phase)) !==
              (await ctx.hash(nativePhaseReceipt["phase"])) ||
            nativePhaseReceipt["executionAuthorized"] !== false
          )
            return fail("integrity");
          const derivation = object(phase.derivation);
          const response = decode(value["responseBase64"]);
          try {
            if (
              derivation["phaseOneRequestSha256"] !==
                request["requestSha256"] ||
              derivation["phaseOneProofSha256"] !== (await ctx.hash(proof)) ||
              derivation["phaseOneResponseSha256"] !==
                (await ctx.digest(response))
            )
              return fail("integrity");
          } finally {
            response.fill(0);
          }
          const current = await requirePresent(
            options.chatWorker,
            "options.chatWorker"
          ).copies.readCurrentOriginalForTransaction(
            tx,
            chatScope,
            identifier(chat.plan["responseRequestId"]),
            now
          );
          if (
            !current ||
            current.plan["planSha256"] !== chat.plan["planSha256"]
          )
            return fail("denied");
          for (const purpose of [
            "phaseTwoTokenizeInput",
            "phaseTwoCompletionInput",
            "toolResult",
          ] as const) {
            const allocation = object(object(chat.recipe["copies"])[purpose]);
            const entry = current.inventory.copies.find(
              (copy) =>
                copy.allocation.copyIdempotencyKey ===
                nativeEvidenceCopyKey(purpose)
            );
            const handle = object(
              object(nativePhaseReceipt["copies"])[purpose]
            );
            if (
              !entry?.contentBinding ||
              entry.allocation.copyId !== allocation["copyId"] ||
              entry.allocation.reservationSha256 !==
                allocation["reservationSha256"] ||
              (await ctx.hash(handle)) !==
                (await ctx.hash({
                  copyId: entry.allocation.copyId,
                  reservationSha256: entry.allocation.reservationSha256,
                  ...entry.contentBinding.content,
                }))
            )
              return fail("integrity");
          }
        };
        await check(ctx.now());
        finalChecks.push(check);
        if (nativePhaseReceipt)
          return finish(
            await parse(
              "WorkerPrepareNativeEvidencePhaseTwoOutput",
              nativePhaseReceipt
            )
          );
        return finish(Object.freeze({ kind: chatNativePhasePrepared }));
      }
      if (
        chat &&
        isNativeEvidencePlan(chat.plan) &&
        [
          "currentModelUse",
          "prepareModelPrivacyReview",
          "readModelPrivacyReview",
        ].includes(operation)
      ) {
        const check = async (now: string): Promise<void> => {
          await nativeModelPurpose(tx, scope, chat.plan, value, now);
          if (
            !governedBytes ||
            governedBytes.byteLength !== value["inputBytes"] ||
            (await ctx.digest(governedBytes)) !== value["inputSha256"]
          )
            return fail("integrity");
        };
        await check(ctx.now());
        finalChecks.push(check);
      }
      if (
        operation === "prepareModelPrivacyReview" ||
        operation === "readModelPrivacyReview"
      ) {
        if (
          !(chat && options.chatModelPrivacyReview && governedBytes) ||
          job["state"] !== "running" ||
          value["researchPrincipalId"] !== principal.actorId ||
          value["consumerServiceId"] !== identity.servicePrincipalId ||
          value["selectionId"] !== lease["policySelectionId"] ||
          value["selectionSha256"] !== lease["policySelectionSha256"]
        )
          return fail("denied");
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        return finish(
          await parse(
            "WorkerModelPrivacyReviewOutput",
            await options.chatModelPrivacyReview(
              tx,
              operation,
              value,
              at,
              governedBytes
            )
          )
        );
      }
      if (operation === "currentModelUse") {
        if (
          job["state"] !== "running" ||
          lease["kind"] === "native-bootstrap" ||
          value["researchPrincipalId"] !== principal.actorId ||
          value["consumerServiceId"] !== identity.servicePrincipalId ||
          value["selectionId"] !== lease["policySelectionId"] ||
          value["selectionSha256"] !== lease["policySelectionSha256"] ||
          time(value["deadlineAt"]) > time(lease["deadlineAt"])
        )
          fail("denied");
        if (chat) {
          if (!(options.chatOutput && governedBytes))
            return fail("unavailable");
          for (const required of [
            "stageArtifact",
            "publishAgent",
            "complete",
          ]) {
            await grant(tx, identity, required, ctx.now());
            finalChecks.push(async (now) => {
              await grant(tx, identity, required, now);
            });
          }
          const ownedCollection = identifier(chat.plan["collectionId"]),
            rights = chat.queuedMetadata.rights;
          for (const artifactId of [
            identifier(chat.plan["runId"]),
            identifier(
              object(object(chat.recipe["copies"])["advisory"])["copyId"]
            ),
          ]) {
            for (const action of ["read", "publish"] as const) {
              await ctx.authorize(
                principal,
                scope,
                ownedCollection,
                artifactId,
                action,
                ctx.now()
              );
              finalChecks.push(async (now) => {
                await ctx.authorize(
                  principal,
                  scope,
                  ownedCollection,
                  artifactId,
                  action,
                  now
                );
              });
            }
          }
          for (const use of ["read", "store", "derive"] as const) {
            await currentRights(
              tx,
              principal,
              scope,
              ownedCollection,
              rights.policyId,
              use,
              ctx.now(),
              rights.version
            );
            pinRights(ownedCollection, rights.policyId, rights.version, use);
          }
        }
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        const proof = await options.modelUse(
          tx,
          principal,
          value,
          at,
          governedBytes
        );
        return finish(await parse("WorkerCurrentModelUseOutput", proof));
      }
      if (operation === "replayNativeOutbox") {
        if (
          scope.environment !== "paper" ||
          lease["kind"] !== "native-bootstrap" ||
          job["state"] !== "running"
        )
          fail("denied");
        const replay = object(value["replay"]);
        const replayGrant = object(replay["grant"]);
        const nativePrincipal = await options.nativeProjectionPrincipal(
          tx,
          identity,
          lease,
          operation,
          replay
        );
        if (nativePrincipal.actorId !== replayGrant["serviceActorId"])
          fail("denied");
        return finish(
          await options.nativeOutboxReplay(
            tx,
            nativePrincipal,
            scope,
            replay,
            at
          )
        );
      }
      if (operation === "publishEpochTransition") {
        if (
          scope.environment !== "paper" ||
          lease["kind"] !== "native-bootstrap" ||
          job["state"] !== "running"
        )
          fail("denied");
        const transition = object(value["transition"]);
        const nativePrincipal = await options.nativeProjectionPrincipal(
          tx,
          identity,
          lease,
          operation,
          object(transition["snapshot"])
        );
        const applied = await options.epochTransition(
          tx,
          nativePrincipal,
          scope,
          transition,
          at
        );
        return finish(applied);
      }
      if (operation === "complete") {
        // A lost publication ACK is unknown, never evidence that committed
        // provenance vanished. Preserve the actual server-owned output ledger.
        const outputs = chat
          ? array(job["output_artifact_ids"], 64)
          : array(value["outputArtifactIds"], 64);
        const hash = await ctx.hash({
          outcome: value["outcome"],
          outcomeSha256: value["outcomeSha256"],
          outputArtifactIds: outputs,
        });
        if (job["outcome_hash"] !== null) {
          if (job["outcome_hash"] !== hash) fail("conflict");
          return finish(
            await result(
              job,
              job["state"] === "unknown" ? "unknown" : "duplicate"
            )
          );
        }
        if (terminal(job["state"]) || job["state"] === "unknown") fail("stale");
        if (value["outcome"] === "succeeded" && job["state"] !== "running")
          fail("conflict");
        if (chat && value["outcome"] === "succeeded") {
          if (!options.chatOutput || scope.environment !== "research")
            return fail("unavailable");
          const published = await options.chatOutput.publicationForTransaction(
            tx,
            { accountAlias: scope.accountAlias, environment: "research" },
            identifier(chat.plan["responseRequestId"]),
            ctx.now()
          );
          if (published.closed) return chatAuthorityClosed;
          if (
            !published.publication ||
            (await ctx.hash(outputs)) !==
              (await ctx.hash([chat.plan["runId"]])) ||
            (await ctx.hash(value["outputArtifactIds"])) !==
              (await ctx.hash(outputs))
          )
            return fail("denied");
        }
        for (const artifactId of array(value["outputArtifactIds"], 64)) {
          if (!array(job["output_artifact_ids"], 64).includes(artifactId))
            fail("integrity");
          const artifact = await one(
            tx,
            "vertex_artifacts",
            scope,
            sql`artifact_id = ${identifier(artifactId)}`
          );
          if (artifact) {
            if (
              !(await ctx.artifact(
                tx,
                principal,
                scope,
                collectionId(artifact["collection_key"]),
                identifier(artifactId),
                "read",
                at
              ))
            )
              fail("integrity");
          } else {
            // Publication explicitly associated this ref with this owned job's
            // output set above. A guessed/cross-job ref cannot complete a job.
            const experiment = await one(
              tx,
              "vertex_worker_experiment_publications",
              scope,
              sql`artifact_id = ${identifier(artifactId)}`
            );
            if (!experiment) fail("integrity");
            await experimentPublication(
              tx,
              principal,
              scope,
              requirePresent(experiment, "experiment"),
              at
            );
            finalChecks.push(async (now) => {
              await experimentPublication(
                tx,
                principal,
                scope,
                requirePresent(experiment, "experiment"),
                now
              );
            });
          }
        }
        await tx.execute(
          sql`update vertex_worker_jobs set state = ${value["outcome"]}, outcome_hash = ${hash}, output_artifact_ids = ${json(outputs)} where ${scopeWhere(scope)} and job_id = ${job["job_id"]}`
        );
        job = {
          ...job,
          state: value["outcome"],
          outcome_hash: hash,
          output_artifact_ids: outputs,
        };
        return finishTerminal(
          await result(
            job,
            value["outcome"] === "unknown" ? "unknown" : "completed"
          )
        );
      }
      if (operation === "cancel") {
        if (terminal(job["state"]))
          return finish(await result(job, "completed"));
        // A cancellation request does not assert that an in-flight engine stopped.
        const next = job["state"] === "leased" ? "cancelled" : "unknown";
        await tx.execute(
          sql`update vertex_worker_jobs set state = ${next} where ${scopeWhere(scope)} and job_id = ${job["job_id"]}`
        );
        job = { ...job, state: next };
        return finishTerminal(
          await result(job, next === "unknown" ? "unknown" : "completed")
        );
      }
      if (terminal(job["state"]) || job["state"] === "unknown") fail("stale");
      if (operation === "renew") {
        const expiry = time(value["leaseExpiresAt"]);
        if (
          expiry <= BigInt(string(job["lease_expires_at_ns"])) ||
          expiry > BigInt(string(job["deadline_at_ns"])) ||
          expiry - time(at) > 300_000_000_000n
        )
          fail("invalid");
        const renewed = await parse("WorkerLease", {
          ...lease,
          leaseExpiresAt: value["leaseExpiresAt"],
        });
        await tx.execute(
          sql`update vertex_worker_jobs set lease_expires_at_ns = ${expiry.toString()}, payload = ${json(renewed)} where ${scopeWhere(scope)} and job_id = ${job["job_id"]}`
        );
        job = {
          ...job,
          lease_expires_at_ns: expiry.toString(),
          payload: renewed,
        };
        return finish(await result(job, "accepted"));
      }
      if (operation === "admitRun") {
        if (
          chat &&
          (value["runId"] !== chat.plan["runId"] ||
            value["requestSha256"] !== chat.origin["recipeSha256"])
        )
          return fail("denied");
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        const prior = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`run_id = ${value["runId"]} or job_id = ${job["job_id"]}`
        );
        if (prior) {
          if (
            prior["run_id"] !== value["runId"] ||
            prior["job_id"] !== job["job_id"] ||
            prior["request_hash"] !== value["requestSha256"] ||
            prior["lease_epoch"] !== value["leaseEpoch"]
          )
            fail("conflict");
          if (time(prior["admitted_at"]) > time(at)) fail("stale");
          return finish(
            await parse("WorkerResult", {
              ...(await result(job, "duplicate")),
              admittedAt: string(prior["admitted_at"]),
            })
          );
        }
        if (job["state"] !== "leased") fail("conflict");
        await insert(tx, "vertex_worker_run_admissions", scope, {
          run_id: value["runId"],
          job_id: job["job_id"],
          request_hash: value["requestSha256"],
          lease_epoch: value["leaseEpoch"],
          admitted_at: at,
        });
        await tx.execute(
          sql`update vertex_worker_jobs set state = 'running' where ${scopeWhere(scope)} and job_id = ${job["job_id"]}`
        );
        job = { ...job, state: "running" };
        return finish(
          await parse("WorkerResult", {
            ...(await result(job, "accepted")),
            admittedAt: at,
          })
        );
      }
      if (operation === "policySelection") {
        if (
          value["selectionId"] !== lease["policySelectionId"] ||
          value["selectionSha256"] !== lease["policySelectionSha256"]
        )
          fail("denied");
        return finish(
          await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(value["selectionId"]),
              selectionSha256: string(value["selectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          )
        );
      }
      if (
        operation === "currentRights" ||
        operation === "currentRightsObservation"
      ) {
        if (
          lease["kind"] === "native-bootstrap" &&
          (value["collectionId"] !== null ||
            !["store", "read", "derive"].includes(string(value["use"])))
        )
          fail("denied");
        const collection =
          value["collectionId"] === null
            ? null
            : identifier(value["collectionId"]);
        const rights = await currentRights(
          tx,
          principal,
          scope,
          collection,
          identifier(value["policyId"]),
          string(value["use"]) as "store" | "read" | "derive" | "export",
          at
        );
        if (lease["kind"] === "native-bootstrap") {
          const selected = await bootstrapLicense();
          if (
            rights.policyId !== selected["policyId"] ||
            rights.version !== selected["version"]
          )
            fail("denied");
        }
        finalChecks.push(async (now) => {
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            rights.policyId,
            string(value["use"]) as "store" | "read" | "derive" | "export",
            now,
            rights.version
          );
        });
        if (operation === "currentRightsObservation") {
          return finishObservation(
            rights,
            "WorkerCurrentRightsObservationOutput",
            "vertex-worker-current-rights-observation-v1"
          );
        }
        return finish(rights);
      }
      if (operation === "readExperiment") {
        const collection = identifier(value["collectionId"]);
        const experimentId = identifier(value["experimentId"]);
        const artifact = object(value["artifact"]);
        const artifactId = identifier(artifact["artifactId"]);
        const digest = digestString(artifact["artifactSha256"]);
        if (
          artifactId !==
          `experiment-${await ctx.hash({ collectionId: collection, experimentId })}`
        )
          fail("denied");
        // A missing or mismatched committed row is terminal: never inspect stages
        // or public records, even when they contain identical bytes.
        const experiment = await one(
          tx,
          "vertex_worker_experiment_publications",
          scope,
          sql`collection_id = ${collection} and experiment_id = ${experimentId}`
        );
        if (
          !experiment ||
          experiment["artifact_id"] !== artifactId ||
          experiment["content_sha256"] !== digest
        )
          return fail("denied");
        await experimentPublication(tx, principal, scope, experiment, at);
        const bytes = await objectRead(
          scope,
          string(experiment["object_key"]),
          digest
        );
        if (bytes.byteLength !== experiment["byte_length"]) fail("integrity");
        finalChecks.push(async (now) => {
          await experimentPublication(tx, principal, scope, experiment, now);
        });
        return finish(
          await parse("WorkerReadExperimentOutput", {
            jobId: job["job_id"],
            collectionId: collection,
            experimentId,
            artifact: { artifactId, artifactSha256: digest },
            contentBase64: canonicalBase64(bytes),
            contentSha256: digest,
            canonicalSha256: digest,
            contentType: "application/json",
          })
        );
      }
      if (operation === "readDataset") {
        if (
          scope.environment !== "research" ||
          lease["kind"] !== "backtest" ||
          job["state"] !== "running"
        )
          return fail("denied");
        const collection =
          value["collectionId"] === null
            ? null
            : identifier(value["collectionId"]);
        const manifestRef = object(value["manifest"]);
        const artifactId = identifier(manifestRef["artifactId"]);
        const digest = digestString(manifestRef["artifactSha256"]);
        const reviews = array(value["reviewPins"], 64).map(object);
        // This closed historical branch has one genuine capture. Extra unrelated
        // review pins cannot manufacture collection or source qualification.
        if (reviews.length !== 1) return fail("denied");
        const reviewPin = requirePresent(reviews[0], "reviews[0]");
        const reviewCollection = identifier(reviewPin["collectionId"]);
        if (collection !== null && collection !== reviewCollection)
          return fail("denied");
        const originalStage = async (
          ref: VertexRecord,
          expectedJob?: string,
          expectedCollection?: string | null
        ) => {
          const id = identifier(ref["artifactId"]);
          const sha = digestString(ref["artifactSha256"]);
          const stagedRow = await one(
            tx,
            "vertex_worker_stages",
            scope,
            sql`artifact_id = ${id}`
          );
          if (!stagedRow) return fail("denied");
          const sourceCollection = collectionId(stagedRow["collection_key"]);
          if (
            expectedCollection !== undefined &&
            sourceCollection !== expectedCollection
          )
            return fail("denied");
          const stage = await staged(
            tx,
            principal,
            scope,
            id,
            sourceCollection,
            at,
            expectedJob
          );
          const descriptor = object(stage["payload"]);
          const key = vertexQualifiedObjectKey(
            scope,
            sourceCollection,
            "manifest",
            sha
          );
          if (
            stage["content_sha256"] !== sha ||
            stage["canonical_sha256"] !== sha ||
            stage["object_key"] !== key ||
            descriptor["accountAlias"] !== scope.accountAlias ||
            descriptor["environment"] !== scope.environment ||
            descriptor["collectionId"] !== sourceCollection ||
            descriptor["jobId"] !== stage["job_id"] ||
            descriptor["artifactId"] !== id ||
            descriptor["contentSha256"] !== sha ||
            descriptor["canonicalSha256"] !== sha ||
            descriptor["contentType"] !== "application/json"
          )
            return fail("integrity");
          await ctx.authorize(
            principal,
            scope,
            sourceCollection,
            id,
            "read",
            at
          );
          const bytes = await objectRead(scope, key, sha);
          let record: VertexRecord;
          try {
            record = object(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes)
              )
            );
          } catch {
            return fail("integrity");
          }
          const encoded = ctx.encode(record);
          if (
            bytes.byteLength !== stage["byte_length"] ||
            (await ctx.hash(record)) !== sha ||
            encoded.byteLength !== bytes.byteLength ||
            !bytes.every((byte, index) => byte === encoded[index])
          )
            return fail("integrity");
          finalChecks.push(async (now) => {
            await ctx.authorize(
              principal,
              scope,
              sourceCollection,
              id,
              "read",
              now
            );
            return await currentRights(
              tx,
              principal,
              scope,
              sourceCollection,
              identifier(descriptor["rightsPolicyId"]),
              "read",
              now,
              identifier(descriptor["rightsVersion"])
            );
          });
          return { stage, descriptor, bytes, record };
        };
        // Resolve the current consumer's collection through its actual selected
        // original recipe, not a fictional RuntimePolicySelection.collections.
        const selected = await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        const selectedRecipes = array(selected["artifacts"], 512)
          .map(object)
          .filter(
            (entry) =>
              entry["role"] === "simulation-engine" &&
              object(entry["artifact"])["contractName"] === "HostBacktestRecipe"
          );
        if (selectedRecipes.length !== 1) return fail("denied");
        const recipeRef = object(
          requirePresent(selectedRecipes[0], "selectedRecipes[0]")["artifact"]
        );
        if (recipeRef["schemaVersion"] !== "1.0.0") return fail("denied");
        const recipe = await originalStage(recipeRef, undefined, null);
        const consumerPayload = await originalStage(
          {
            artifactId: lease["payloadArtifactId"],
            artifactSha256: lease["payloadSha256"],
          },
          string(job["job_id"]),
          reviewCollection
        );
        const historicalConsumer =
          recipe.record["format"] === "vertex-host-backtest-recipe-v3";
        if (
          Object.keys(consumerPayload.record).sort().join(",") !==
            "format,recipeArtifactId,recipeSha256" ||
          consumerPayload.record["format"] !== "vertex-backtest-job-v1" ||
          consumerPayload.record["recipeArtifactId"] !==
            recipeRef["artifactId"] ||
          consumerPayload.record["recipeSha256"] !==
            recipeRef["artifactSha256"] ||
          ![
            "vertex-host-backtest-recipe-v2",
            "vertex-host-backtest-recipe-v3",
          ].includes(string(recipe.record["format"]))
        )
          return fail("denied");
        if (
          historicalConsumer &&
          Object.keys(recipe.record).sort().join(",") !==
            "budget,datasets,descriptor,evidence,format,lineage,model,plannedAt,publication,reviewPins,run,strategy"
        )
          return fail("denied");
        const publication = object(recipe.record["publication"]);
        if (
          publication["collectionId"] !== reviewCollection ||
          publication["actorId"] !== principal.actorId
        )
          return fail("denied");
        const selectedDatasets = array(recipe.record["datasets"], 64)
          .map(object)
          .filter(
            (entry) =>
              object(entry["manifest"])["artifactId"] === artifactId &&
              object(entry["manifest"])["sha256"] === digest
          );
        if (selectedDatasets.length !== 1) return fail("denied");
        if (historicalConsumer) {
          const entry = requirePresent(
            selectedDatasets[0],
            "selectedDatasets[0]"
          );
          if (
            Object.keys(entry).sort().join(",") !==
              "collectionId,content,contentFormat,declaredEvents,manifest,reviewPins" ||
            entry["collectionId"] !== collection ||
            entry["contentFormat"] !== "vertex-ibkr-historical-bars-v1" ||
            array(recipe.record["datasets"], 1).length !== 1 ||
            (await ctx.hash(entry["reviewPins"])) !==
              (await ctx.hash(value["reviewPins"]))
          )
            return fail("denied");
          const pins = array(recipe.record["reviewPins"], 32).map(object);
          for (const pin of array(entry["reviewPins"], 16).map(object)) {
            if (
              !pins.some(
                (candidate) => JSON.stringify(candidate) === JSON.stringify(pin)
              )
            )
              return fail("denied");
          }
        }
        const currentAdmission = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`job_id = ${job["job_id"]}`
        );
        if (
          !currentAdmission ||
          currentAdmission["run_id"] !== job["job_id"] ||
          currentAdmission["request_hash"] !== lease["payloadSha256"] ||
          currentAdmission["lease_epoch"] !== lease["leaseEpoch"] ||
          time(currentAdmission["admitted_at"]) > time(at)
        )
          return fail("denied");
        finalChecks.push(async () => {
          const current = await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(lease["policySelectionId"]),
              selectionSha256: string(lease["policySelectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          );
          if ((await ctx.hash(current)) !== (await ctx.hash(selected)))
            return fail("stale");
          return;
        });
        // Both immutable metadata AND public record must exist before looking at
        // its preparatory stage to identify the actual succeeded producer.
        const metadata = await ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          artifactId,
          "read",
          at
        );
        const root = await one(
          tx,
          "vertex_records",
          scope,
          sql`artifact_id = ${artifactId} and collection_key = ${collectionKey(collection)} and contract_name = 'DatasetManifest'`
        );
        if (
          !(metadata && root) ||
          metadata.contractName !== "DatasetManifest" ||
          metadata.artifactSha256 !== digest ||
          root["artifact_sha256"] !== digest ||
          root["record_hash"] !== digest ||
          (await ctx.hash(root["payload"])) !== digest ||
          metadata.objectKey !==
            vertexQualifiedObjectKey(scope, collection, "manifest", digest) ||
          metadata.contentType !== "application/json"
        )
          return fail("denied");
        const rootOriginal = await originalStage(
          manifestRef,
          undefined,
          collection
        );
        const record = await ctx.validate(
          "DatasetManifest",
          rootOriginal.record
        );
        if (
          record["datasetId"] !== artifactId ||
          root["record_id"] !== artifactId ||
          root["version"] !== record["schemaVersion"] ||
          rootOriginal.bytes.byteLength !== metadata.byteLength ||
          (await ctx.hash(record)) !== digest ||
          metadata.sourceContentSha256 !== record["contentHash"] ||
          record["entitlementPolicyId"] !== metadata.rights.policyId ||
          rootOriginal.descriptor["rightsPolicyId"] !==
            metadata.rights.policyId ||
          rootOriginal.descriptor["rightsVersion"] !==
            metadata.rights.version ||
          array(metadata.lineageArtifactIds, 64).length !== 0 ||
          array(rootOriginal.descriptor["lineageArtifactIds"], 64).length !== 0
        )
          return fail("integrity");
        const rootLinks = await rows(
          tx,
          sql`select parent_artifact_id from vertex_artifact_lineage where ${scopeWhere(scope)} and artifact_id = ${artifactId}`
        );
        if (rootLinks.length !== 0) return fail("integrity");
        const relation = await one(
          tx,
          "vertex_datasets",
          scope,
          sql`dataset_id = ${artifactId} and collection_key = ${collectionKey(collection)}`
        );
        if (
          !relation ||
          relation["artifact_id"] !== artifactId ||
          relation["provider"] !== record["provider"] ||
          relation["content_hash"] !== record["contentHash"] ||
          relation["storage_ref"] !== record["storageRef"] ||
          relation["entitlement_policy_id"] !== record["entitlementPolicyId"] ||
          relation["retention_policy"] !== record["retentionPolicy"] ||
          relation["calendar"] !== record["calendar"] ||
          relation["capture_time"] !== record["captureTime"] ||
          relation["as_of_at"] !== record["asOfAt"] ||
          relation["start_at_inclusive"] !== record["startAtInclusive"] ||
          relation["end_at_exclusive"] !== record["endAtExclusive"] ||
          relation["data_vintage_id"] !== record["dataVintageId"] ||
          relation["data_vintage_status"] !== record["dataVintageStatus"] ||
          relation["adjustment_method"] !== record["adjustmentMethod"]
        )
          return fail("integrity");
        const sourceRows = await rows(
          tx,
          sql`select * from vertex_dataset_sources where ${scopeWhere(scope)} and dataset_id = ${artifactId} order by source_ordinal limit 2`
        );
        const source = object(array(record["sources"], 1)[0]);
        if (
          sourceRows.length !== 1 ||
          requirePresent(sourceRows[0], "sourceRows[0]")["source_ordinal"] !==
            0 ||
          requirePresent(sourceRows[0], "sourceRows[0]")["source_id"] !==
            source["sourceId"] ||
          requirePresent(sourceRows[0], "sourceRows[0]")[
            "source_snapshot_id"
          ] !== source["snapshotId"] ||
          requirePresent(sourceRows[0], "sourceRows[0]")["provider"] !==
            source["provider"] ||
          requirePresent(sourceRows[0], "sourceRows[0]")["content_hash"] !==
            source["contentHash"]
        )
          return fail("integrity");
        const producerId = identifier(rootOriginal.stage["job_id"]);
        const producer = await one(
          tx,
          "vertex_worker_jobs",
          scope,
          sql`job_id = ${producerId}`
        );
        if (
          producer?.["state"] !== "succeeded" ||
          producer["outcome_hash"] === null ||
          !array(producer["output_artifact_ids"], 64).includes(artifactId)
        )
          return fail("denied");
        digestString(producer["outcome_hash"]);
        const producerLease = await parse("WorkerLease", producer["payload"]);
        const stable = {
          kind: producerLease["kind"],
          researchPrincipalId: producerLease["researchPrincipalId"],
          payloadArtifactId: producerLease["payloadArtifactId"],
          payloadSha256: producerLease["payloadSha256"],
          policySelectionId: producerLease["policySelectionId"],
          policySelectionSha256: producerLease["policySelectionSha256"],
          deadlineAt: producerLease["deadlineAt"],
        };
        if (
          producerLease["kind"] !== "dataset-ingest" ||
          producerLease["jobId"] !== producerId ||
          producerLease["accountAlias"] !== scope.accountAlias ||
          producerLease["environment"] !== scope.environment ||
          producerLease["eventId"] !== producer["event_id"] ||
          producerLease["leaseId"] !== producer["lease_id"] ||
          producerLease["leaseEpoch"] !== producer["lease_epoch"] ||
          time(producerLease["leaseExpiresAt"]).toString() !==
            producer["lease_expires_at_ns"] ||
          time(producerLease["deadlineAt"]).toString() !==
            producer["deadline_at_ns"] ||
          (await ctx.hash({
            scope,
            eventId: producer["event_id"],
            ...stable,
          })) !== producer["binding_hash"] ||
          producerId !==
            `job-${await ctx.hash({ scope, eventId: producer["event_id"] })}`
        )
          return fail("integrity");
        const admitted = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`job_id = ${producerId}`
        );
        if (
          !admitted ||
          admitted["run_id"] !== producerId ||
          admitted["request_hash"] !== producerLease["payloadSha256"] ||
          admitted["lease_epoch"] !== producerLease["leaseEpoch"] ||
          time(admitted["admitted_at"]) > time(root["recorded_at"]) ||
          time(root["recorded_at"]) > time(at) ||
          time(root["recorded_at"]) >= time(producerLease["deadlineAt"]) ||
          time(root["recorded_at"]) >= time(producerLease["leaseExpiresAt"])
        )
          return fail("denied");
        const grantRow = await one(
          tx,
          "vertex_worker_service_grants",
          scope,
          sql`grant_id = ${producer["grant_id"]}`
        );
        if (!grantRow) return fail("denied");
        const producerGrant = await parse(
          "WorkerServiceGrant",
          grantRow["payload"]
        );
        if (
          (await ctx.hash(producerGrant)) !== grantRow["record_hash"] ||
          producerGrant["grantId"] !== producer["grant_id"] ||
          producerGrant["servicePrincipalId"] !==
            grantRow["service_principal_id"] ||
          producerGrant["accountAlias"] !== scope.accountAlias ||
          producerGrant["environment"] !== scope.environment ||
          time(producerGrant["issuedAt"]).toString() !==
            grantRow["issued_at_ns"] ||
          time(producerGrant["expiresAt"]).toString() !==
            grantRow["expires_at_ns"] ||
          producerGrant["revokedAt"] !== grantRow["revoked_at"] ||
          time(producerGrant["issuedAt"]) > time(admitted["admitted_at"]) ||
          time(producerGrant["expiresAt"]) <= time(root["recorded_at"]) ||
          (producerGrant["revokedAt"] !== null &&
            time(producerGrant["revokedAt"]) <= time(root["recorded_at"])) ||
          !["admitRun", "stageArtifact", "publishArtifact", "complete"].every(
            (op) => array(producerGrant["operations"], 32).includes(op)
          )
        )
          return fail("denied");
        const selectionRow = await one(
          tx,
          "vertex_policy_selections",
          scope,
          sql`selection_id = ${producerLease["policySelectionId"]}`
        );
        const ownershipRow = await one(
          tx,
          "vertex_policy_ownership_pins",
          scope,
          sql`holder_id = ${producerId}`
        );
        if (!(selectionRow && ownershipRow)) return fail("denied");
        const historical = object(selectionRow["payload"]);
        const { selectionSha256: selectionHash, ...selectionBody } = historical;
        const ownership = object(ownershipRow["payload"]);
        if (
          (await ctx.hash(selectionBody)) !== selectionHash ||
          selectionHash !== producerLease["policySelectionSha256"] ||
          selectionHash !== selectionRow["selection_sha256"] ||
          historical["selectionId"] !== producerLease["policySelectionId"] ||
          historical["accountAlias"] !== scope.accountAlias ||
          historical["environment"] !== scope.environment ||
          time(historical["issuedAt"]) > time(admitted["admitted_at"]) ||
          time(historical["expiresAt"]) <= time(root["recorded_at"]) ||
          historical["revision"] !== selectionRow["revision"] ||
          time(historical["issuedAt"]).toString() !==
            selectionRow["issued_at_ns"] ||
          time(historical["expiresAt"]).toString() !==
            selectionRow["expires_at_ns"] ||
          historical["readOnly"] !== true ||
          historical["nativeRearmAllowed"] !== false ||
          historical["cloudCapitalAuthority"] !== false
        )
          return fail("integrity");
        if (
          (await ctx.hash(ownership)) !== ownershipRow["record_hash"] ||
          ownership["holderId"] !== producerId ||
          ownership["holderKind"] !== "job" ||
          ownership["selectionId"] !== historical["selectionId"] ||
          ownership["selectionSha256"] !== selectionHash ||
          ownership["accountAlias"] !== scope.accountAlias ||
          ownership["environment"] !== scope.environment ||
          ownership["ownerServiceId"] !== producerGrant["servicePrincipalId"] ||
          ownership["ownerEpoch"] !== producerLease["leaseEpoch"] ||
          time(ownership["pinnedAt"]) > time(admitted["admitted_at"]) ||
          (ownership["releasedAt"] !== null &&
            time(ownership["releasedAt"]) < time(root["recorded_at"]))
        )
          return fail("denied");
        if (
          ownership["holderId"] !== ownershipRow["holder_id"] ||
          ownership["holderKind"] !== ownershipRow["holder_kind"] ||
          ownership["selectionId"] !== ownershipRow["selection_id"] ||
          ownership["selectionSha256"] !== ownershipRow["selection_sha256"] ||
          ownership["ownerServiceId"] !== ownershipRow["owner_service_id"] ||
          ownership["ownerEpoch"] !== ownershipRow["owner_epoch"] ||
          time(ownership["pinnedAt"]).toString() !==
            ownershipRow["pinned_at_ns"] ||
          (ownership["releasedAt"] === null
            ? null
            : time(ownership["releasedAt"]).toString()) !==
            ownershipRow["released_at_ns"]
        )
          return fail("integrity");
        const module = object(ownership["module"]);
        const modules = array(historical["modules"], 128)
          .map(object)
          .filter((entry) => entry["moduleId"] === module["moduleId"]);
        if (
          module["moduleId"] !== ownershipRow["module_id"] ||
          module["version"] !== ownershipRow["module_version"] ||
          module["codeSha256"] !== ownershipRow["code_sha256"] ||
          modules.length !== 1 ||
          requirePresent(modules[0], "modules[0]")["enabled"] !== true ||
          (await ctx.hash(modules[0])) !== (await ctx.hash(module))
        )
          return fail("integrity");
        const revoked = await one(
          tx,
          "vertex_policy_revocations",
          scope,
          sql`selection_id = ${historical["selectionId"]}`
        );
        if (
          revoked &&
          (BigInt(string(revoked["recorded_at_ns"])) <=
            time(root["recorded_at"]) ||
            (await ctx.hash(revoked["payload"])) !== revoked["record_hash"] ||
            object(revoked["payload"])["selectionId"] !==
              historical["selectionId"] ||
            object(revoked["payload"])["selectionSha256"] !== selectionHash ||
            time(object(revoked["payload"])["recordedAt"]).toString() !==
              revoked["recorded_at_ns"])
        )
          return fail("denied");
        const producerPayload = await originalStage(
          {
            artifactId: producerLease["payloadArtifactId"],
            artifactSha256: producerLease["payloadSha256"],
          },
          producerId
        );
        const payload = producerPayload.record;
        const target = object(payload["publication"]);
        if (
          Object.keys(payload).sort().join(",") !==
            "profile,publication,request" ||
          payload["profile"] !== "vertex-ibkr-history-ingest-v1" ||
          Object.keys(target).sort().join(",") !==
            "dataset_id,instrument_id,retention_policy,rights_policy_id,storage_ref" ||
          target["dataset_id"] !== artifactId ||
          target["storage_ref"] !== record["storageRef"] ||
          target["instrument_id"] !== source["sourceId"] ||
          target["rights_policy_id"] !== record["entitlementPolicyId"] ||
          target["retention_policy"] !== record["retentionPolicy"]
        )
          return fail("integrity");
        const graph = await historicalDataset(
          tx,
          principal,
          scope,
          collection,
          producerId,
          record,
          at
        );
        const intended = object(payload["request"]);
        const originalLimits = object(intended["limits"]);
        const actualLimits = object(graph.request.value["limits"]);
        if (
          (await ctx.hash({
            ...graph.request.value,
            limits: originalLimits,
          })) !== (await ctx.hash(intended)) ||
          typeof actualLimits["timeout_ms"] !== "number" ||
          typeof originalLimits["timeout_ms"] !== "number" ||
          actualLimits["timeout_ms"] > originalLimits["timeout_ms"] ||
          typeof actualLimits["max_bytes"] !== "number" ||
          typeof originalLimits["max_bytes"] !== "number" ||
          actualLimits["max_bytes"] > originalLimits["max_bytes"] ||
          actualLimits["max_rows"] !== originalLimits["max_rows"] ||
          actualLimits["max_events"] !== originalLimits["max_events"]
        )
          return fail("integrity");
        for (const item of [
          rootOriginal,
          graph.content,
          graph.capture,
          graph.request,
        ]) {
          if (
            time(item.descriptor["createdAt"]) <
              time(admitted["admitted_at"]) ||
            time(item.descriptor["createdAt"]) > time(root["recorded_at"]) ||
            item.descriptor["rightsPolicyId"] !== metadata.rights.policyId ||
            item.descriptor["rightsVersion"] !== metadata.rights.version
          )
            fail("integrity");
        }
        const capability = array(historical["providerCapabilities"], 256)
          .map(object)
          .filter(
            (entry) =>
              entry["providerId"] === "ibkr" &&
              entry["operation"] === "historical-bars" &&
              entry["modelVersion"] === null
          );
        if (
          capability.length !== 1 ||
          requirePresent(capability[0], "capability[0]")["state"] !== "ready" ||
          requirePresent(capability[0], "capability[0]")["rightsPolicyId"] !==
            metadata.rights.policyId ||
          requirePresent(capability[0], "capability[0]")[
            "rightsPolicyVersion"
          ] !== metadata.rights.version ||
          time(requirePresent(capability[0], "capability[0]")["observedAt"]) >
            time(graph.request.descriptor["createdAt"]) ||
          time(requirePresent(capability[0], "capability[0]")["expiresAt"]) <=
            time(graph.capture.descriptor["createdAt"])
        )
          return fail("denied");
        const selectedContent = object(
          requirePresent(selectedDatasets[0], "selectedDatasets[0]")["content"]
        );
        if (
          selectedContent["artifactId"] !== graph.content.ref.artifactId ||
          selectedContent["sha256"] !== graph.content.ref.artifactSha256
        )
          return fail("denied");
        if (
          (value["member"] === "capture" &&
            (await ctx.hash(value["source"])) !== (await ctx.hash(source))) ||
          (value["member"] === "content" && value["source"] !== null)
        )
          return fail("denied");
        const checkReview = async (now: string): Promise<void> => {
          const accepted = await createQueryOperations(
            boundContext(tx, now, scope)
          ).getAcceptedEvidence(
            principal,
            scope,
            reviewCollection,
            identifier(reviewPin["evidenceId"])
          );
          if (
            !accepted ||
            accepted.artifact.artifactId !== reviewPin["artifactId"] ||
            accepted.artifact.artifactSha256 !== reviewPin["artifactSha256"] ||
            accepted.review["reviewId"] !== reviewPin["reviewId"] ||
            accepted.review["reviewVersion"] !== reviewPin["reviewVersion"] ||
            accepted.artifact.rights.policyId !== reviewPin["rightsPolicyId"] ||
            time(accepted.review["expiresAt"]) <= time(now) ||
            accepted.evidence["contentHash"] !== source["contentHash"] ||
            (await ctx.hash(accepted.evidence["sourceIdentity"])) !==
              (await ctx.hash(source))
          )
            return fail("denied");
          await ctx.authorize(
            principal,
            scope,
            reviewCollection,
            identifier(reviewPin["artifactId"]),
            "read",
            now
          );
          await ctx.authorize(
            { actorId: identifier(accepted.review["actorId"]) },
            scope,
            reviewCollection,
            identifier(reviewPin["artifactId"]),
            "review",
            now
          );
          for (const use of ["read", "derive"] as const) {
            await currentRights(
              tx,
              principal,
              scope,
              reviewCollection,
              identifier(reviewPin["rightsPolicyId"]),
              use,
              now,
              identifier(reviewPin["rightsVersion"])
            );
          }
        };
        await checkReview(at);
        finalChecks.push(checkReview);
        finalChecks.push(async (now) => {
          const current = await ctx.artifact(
            tx,
            principal,
            scope,
            collection,
            artifactId,
            "read",
            now
          );
          if (
            !current ||
            (await ctx.hash(current)) !== (await ctx.hash(metadata))
          )
            fail("stale");
          for (const item of [graph.content, graph.capture, graph.request]) {
            await ctx.authorize(
              principal,
              scope,
              collection,
              item.ref.artifactId,
              "read",
              now
            );
            for (const use of ["read", "derive"] as const) {
              await currentRights(
                tx,
                principal,
                scope,
                collection,
                identifier(item.descriptor["rightsPolicyId"]),
                use,
                now,
                identifier(item.descriptor["rightsVersion"])
              );
            }
          }
        });
        const output =
          value["member"] === "content" ? graph.content : graph.capture;
        return finish(
          await parse("WorkerReadDatasetOutput", {
            producerJobId: producerId,
            collectionId: collection,
            manifest: manifestRef,
            member: value["member"],
            source: value["source"],
            artifact: output.ref,
            contentBase64: canonicalBase64(output.bytes),
            contentSha256: output.ref.artifactSha256,
            canonicalSha256: null,
            contentType: output.descriptor["contentType"],
          })
        );
      }
      if (operation === "readBacktestRun") {
        if (
          scope.environment !== "research" ||
          lease["kind"] !== "research-run" ||
          job["state"] !== "running"
        )
          fail("denied");
        const checkSelection = async (): Promise<void> => {
          await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(lease["policySelectionId"]),
              selectionSha256: string(lease["policySelectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          );
        };
        await checkSelection();
        finalChecks.push(async () => {
          await checkSelection();
        });
        const proof = await readBacktestRunProof(
          tx,
          principal,
          scope,
          at,
          value,
          finalChecks
        );
        finalChecks.push(async () => {
          const now = ctx.now();
          await grant(tx, identity, operation, now);
          if (
            time(ctx.now()) >= time(lease["leaseExpiresAt"]) ||
            time(ctx.now()) >= time(lease["deadlineAt"])
          )
            return fail("stale");
          return;
        });
        return finish(await parse("WorkerReadBacktestRunOutput", proof.output));
      }
      if (operation === "readArtifact") {
        const collection =
          value["collectionId"] === null
            ? null
            : identifier(value["collectionId"]);
        const artifactId = identifier(value["artifactId"]);
        if (chat) {
          const inputs = object(chat.recipe["copies"]);
          const native = isNativeEvidencePlan(chat.plan);
          const purposes = native
            ? nativeEvidenceCopyPurposes.filter(
                (candidate) => candidate !== "advisory"
              )
            : ["context", "tokenizeInput", "completionInput"];
          const purpose = purposes.find(
            (candidate) => object(inputs[candidate])["copyId"] === artifactId
          );
          let reference = purpose ? object(inputs[purpose]) : undefined;
          if (native && purpose) {
            const entry = chat.inventory.copies.find(
              (copy) =>
                copy.allocation.copyIdempotencyKey ===
                nativeEvidenceCopyKey(purpose)
            );
            if (
              !entry?.contentBinding ||
              entry.allocation.copyId !==
                requirePresent(reference, "reference")["copyId"] ||
              entry.allocation.reservationSha256 !==
                requirePresent(reference, "reference")["reservationSha256"]
            )
              return fail("denied");
            // Frozen recipe placeholders never change; current bound inventory
            // supplies the content pin only after its original lifecycle join.
            reference = {
              copyId: entry.allocation.copyId,
              ...entry.contentBinding.content,
            };
            if (
              [
                "phaseOneResponse",
                "toolResult",
                "phaseTwoTokenizeInput",
                "phaseTwoCompletionInput",
              ].includes(purpose)
            ) {
              const check = async (now: string): Promise<void> => {
                if (
                  !options.chatWorker ||
                  scope.environment !== "research" ||
                  !(await options.chatWorker.copies.readNativePhaseForTransaction(
                    tx,
                    {
                      accountAlias: scope.accountAlias,
                      environment: "research",
                    },
                    identifier(chat.plan["responseRequestId"]),
                    2,
                    now
                  ))
                )
                  return fail("denied");
              };
              await check(ctx.now());
              finalChecks.push(check);
            }
          }
          if (reference) {
            if (
              collection !== null ||
              job["state"] !== "running" ||
              !governedBytes ||
              governedBytes.byteLength !== reference["byteLength"] ||
              (await ctx.digest(governedBytes)) !== reference["sha256"]
            )
              return fail("denied");
            const admission = await one(
              tx,
              "vertex_worker_run_admissions",
              scope,
              sql`job_id = ${job["job_id"]}`
            );
            if (
              !admission ||
              admission["run_id"] !== chat.plan["runId"] ||
              admission["request_hash"] !== chat.origin["recipeSha256"] ||
              admission["lease_epoch"] !== value["leaseEpoch"] ||
              time(admission["admitted_at"]) > time(at)
            )
              return fail("denied");
            return finish({
              artifact: { artifactId, artifactSha256: reference["sha256"] },
              contentBase64: canonicalBase64(governedBytes),
              contentSha256: reference["sha256"],
              canonicalSha256: null,
              contentType: "application/json",
            });
          }
          if (object(inputs["advisory"])["copyId"] === artifactId) {
            // Frozen null selector is ONLY this governed branch. Rights remain
            // bound to the ORIGINAL collection; never fall through to staged().
            if (
              collection !== null ||
              scope.environment !== "research" ||
              job["state"] !== "running" ||
              !options.chatOutput ||
              !options.chatWorker ||
              !governedBytes
            )
              return fail("denied");
            const source = await options.chatOutput.inspectForTransaction(
              tx,
              { accountAlias: scope.accountAlias, environment: "research" },
              identifier(chat.plan["responseRequestId"]),
              at
            );
            if (!source) return chatAuthorityClosed;
            if (
              !(await options.chatWorker.copies.advisoryLiveProofForTransaction(
                tx,
                { accountAlias: scope.accountAlias, environment: "research" },
                identifier(chat.plan["responseRequestId"]),
                ctx.now()
              ))
            )
              return chatAuthorityClosed;
            if (
              governedBytes.byteLength !== source.metadata.byteLength ||
              (await ctx.digest(governedBytes)) !==
                source.metadata.contentSha256
            )
              return fail("integrity");
            const ownedCollection = identifier(chat.plan["collectionId"]),
              rights = chat.queuedMetadata.rights;
            await ctx.authorize(
              principal,
              scope,
              ownedCollection,
              artifactId,
              "read",
              ctx.now()
            );
            await currentRights(
              tx,
              principal,
              scope,
              ownedCollection,
              rights.policyId,
              "read",
              ctx.now(),
              rights.version
            );
            pinRights(ownedCollection, rights.policyId, rights.version, "read");
            finalChecks.push(async (now) => {
              await ctx.authorize(
                principal,
                scope,
                ownedCollection,
                artifactId,
                "read",
                now
              );
            });
            return finish({
              artifact: {
                artifactId,
                artifactSha256: source.metadata.contentSha256,
              },
              contentBase64: canonicalBase64(governedBytes),
              contentSha256: source.metadata.contentSha256,
              canonicalSha256: source.metadata.contentSha256,
              contentType: "application/json",
            });
          }
        }
        let nativeArtifactSha256: string | undefined;
        if (chat && isNativeEvidencePlan(chat.plan)) {
          // Native copy IDs have already taken the governed-only branch above.
          // Startup and refresh also need immutable ordinary dependencies, but
          // never an arbitrary artifact made readable by the owner principal.
          const expectedPin = async (now: string): Promise<string> => {
            const pins: VertexRecord[] = [];
            if (collection === chat.plan["collectionId"])
              pins.push({
                artifactId: chat.queuedMetadata.artifactId,
                artifactSha256: chat.queuedMetadata.artifactSha256,
              });
            for (const pin of array(chat.plan["reviewPins"], 16).map(object)) {
              if (pin["collectionId"] === collection) pins.push(pin);
            }
            if (collection === null) {
              pins.push(
                {
                  artifactId: chat.origin["recipeArtifactId"],
                  artifactSha256: chat.origin["recipeSha256"],
                },
                object(chat.plan["participantConfiguration"])
              );
              const selected = await options.policySelection(
                tx,
                principal,
                {
                  ...scope,
                  selectionId: string(lease["policySelectionId"]),
                  selectionSha256: string(lease["policySelectionSha256"]),
                },
                identity.servicePrincipalId,
                string(job["job_id"])
              );
              if (
                selected["accountAlias"] !== scope.accountAlias ||
                selected["environment"] !== scope.environment ||
                selected["selectionId"] !== lease["policySelectionId"] ||
                selected["selectionSha256"] !==
                  lease["policySelectionSha256"] ||
                time(selected["issuedAt"]) > time(now) ||
                time(selected["expiresAt"]) <= time(now)
              )
                return fail("denied");
              for (const [group, field] of [
                ["modules", "artifact"],
                ["policies", "artifact"],
                ["artifacts", "artifact"],
                ["sourcePins", "provenanceArtifact"],
                ["providerCapabilities", "evidenceArtifact"],
              ] as const) {
                for (const entry of array(
                  selected[group],
                  group === "artifacts"
                    ? 512
                    : group === "providerCapabilities"
                      ? 256
                      : 128
                ).map(object)) {
                  const pin = object(entry[field]);
                  if (pin["artifactId"] === artifactId) {
                    if (pin["schemaVersion"] !== "1.0.0") return fail("denied");
                    pins.push(pin);
                  }
                }
              }
            }
            const hashes = new Set(
              pins
                .filter((pin) => pin["artifactId"] === artifactId)
                .map((pin) => digestString(pin["artifactSha256"]))
            );
            if (hashes.size !== 1) return fail("denied");
            return requirePresent([...hashes][0], "[...hashes][0]");
          };
          nativeArtifactSha256 = await expectedPin(ctx.now());
          finalChecks.push(async (now) => {
            if ((await expectedPin(now)) !== nativeArtifactSha256)
              return fail("stale");
            return;
          });
        }
        const metadata = await ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          artifactId,
          "read",
          at
        );
        if (metadata) {
          if (
            nativeArtifactSha256 !== undefined &&
            metadata.artifactSha256 !== nativeArtifactSha256
          )
            return fail("denied");
          await authorizeBootstrapRead(
            artifactId,
            metadata.artifactSha256,
            false
          );
          pinRights(
            collection,
            metadata.rights.policyId,
            metadata.rights.version,
            "read"
          );
          finalChecks.push(async (now) => {
            await ctx.authorize(
              principal,
              scope,
              collection,
              artifactId,
              "read",
              now
            );
          });
          const bytes = await objectRead(
            scope,
            metadata.objectKey,
            metadata.artifactSha256
          );
          return finish({
            artifact: { artifactId, artifactSha256: metadata.artifactSha256 },
            contentBase64: canonicalBase64(bytes),
            contentSha256: metadata.artifactSha256,
            canonicalSha256: metadata.artifactSha256,
            contentType: metadata.contentType,
          });
        }
        const stage = await staged(
          tx,
          principal,
          scope,
          artifactId,
          collection,
          at
        );
        if (
          nativeArtifactSha256 !== undefined &&
          (stage["content_sha256"] !== nativeArtifactSha256 ||
            stage["canonical_sha256"] !== nativeArtifactSha256)
        )
          return fail("denied");
        await authorizeBootstrapRead(
          artifactId,
          string(stage["canonical_sha256"] ?? stage["content_sha256"]),
          stage["job_id"] === job["job_id"]
        );
        const descriptor = object(stage["payload"]);
        await ctx.authorize(
          principal,
          scope,
          collection,
          artifactId,
          "read",
          at
        );
        finalChecks.push(async (now) => {
          await ctx.authorize(
            principal,
            scope,
            collection,
            artifactId,
            "read",
            now
          );
        });
        pinRights(
          collection,
          string(descriptor["rightsPolicyId"]),
          string(descriptor["rightsVersion"]),
          "read"
        );
        let selectedPrivateInput = false;
        // Stages remain preparatory. Cross-job reads require a committed link
        // or a current exact selected-policy input, never a guessed object key.
        if (stage["job_id"] !== job["job_id"]) {
          const link = await one(
            tx,
            "vertex_worker_agent_publications",
            scope,
            sql`advisory_artifact_id = ${artifactId}`
          );
          const generation =
            collection === null
              ? null
              : await one(
                  tx,
                  "vertex_worker_collection_snapshots",
                  scope,
                  sql`collection_id = ${collection} and member_artifacts @> ${json([{ artifactId }])}`
                );
          if (!(link || generation)) {
            if (
              collection !== null ||
              stage["canonical_sha256"] !== stage["content_sha256"] ||
              descriptor["contentType"] !== "application/json"
            )
              fail("denied");
            const selectedMembership = async (): Promise<string> => {
              const selected = await options.policySelection(
                tx,
                principal,
                {
                  ...scope,
                  selectionId: string(lease["policySelectionId"]),
                  selectionSha256: string(lease["policySelectionSha256"]),
                },
                identity.servicePrincipalId,
                string(job["job_id"])
              );
              const now = ctx.now();
              if (
                selected["accountAlias"] !== scope.accountAlias ||
                selected["environment"] !== scope.environment ||
                selected["selectionId"] !== lease["policySelectionId"] ||
                selected["selectionSha256"] !==
                  lease["policySelectionSha256"] ||
                time(selected["issuedAt"]) > time(now) ||
                time(selected["expiresAt"]) <= time(now)
              )
                fail("denied");
              const members: VertexRecord[] = [];
              const contracts = new Set<string>();
              for (const [group, field] of [
                ["modules", "artifact"],
                ["policies", "artifact"],
                ["artifacts", "artifact"],
                ["sourcePins", "provenanceArtifact"],
                ["providerCapabilities", "evidenceArtifact"],
              ] as const) {
                for (const entry of array(selected[group], 128).map(object)) {
                  const pin = object(entry[field]);
                  if (
                    pin["artifactId"] !== artifactId ||
                    pin["artifactSha256"] !== stage["content_sha256"]
                  )
                    continue;
                  if (pin["schemaVersion"] !== "1.0.0") fail("denied");
                  contracts.add(identifier(pin["contractName"]));
                  if (group === "artifacts" || group === "policies")
                    identifier(entry["role"]);
                  // Retain the complete membership, including actual role,
                  // binding/module identity, contract, schema and byte hash.
                  members.push({ group, entry });
                }
              }
              if (members.length === 0 || contracts.size !== 1) fail("denied");
              return ctx.hash(members);
            };
            const membershipHash = await selectedMembership();
            selectedPrivateInput = true;
            finalChecks.push(async () => {
              if ((await selectedMembership()) !== membershipHash)
                return fail("stale");
              return;
            });
          }
          if (
            generation &&
            (await ctx.hash(generation["payload"])) !==
              generation["record_hash"]
          )
            fail("integrity");
        }
        const bytes = await objectRead(
          scope,
          string(stage["object_key"]),
          string(stage["content_sha256"])
        );
        if (selectedPrivateInput) {
          let source: unknown;
          try {
            source = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            );
          } catch {
            return fail("integrity");
          }
          const original = ctx.encode(source);
          if (
            original.byteLength !== bytes.byteLength ||
            !bytes.every((byte, index) => byte === original[index])
          )
            fail("integrity");
          // The downstream private consumer owns shape validation. Selection
          // labels and readable preparatory bytes do not establish publication.
        }
        return finish({
          artifact: {
            artifactId,
            artifactSha256:
              stage["canonical_sha256"] ?? stage["content_sha256"],
          },
          contentBase64: canonicalBase64(bytes),
          contentSha256: stage["content_sha256"],
          canonicalSha256: stage["canonical_sha256"],
          contentType: descriptor["contentType"],
        });
      }
      if (operation === "stageArtifact") {
        if (chat) {
          if (
            !(options.chatOutput && options.chatWorker) ||
            scope.environment !== "research" ||
            job["state"] !== "running"
          )
            return fail("unavailable");
          const chatScope = {
            accountAlias: scope.accountAlias,
            environment: "research" as const,
          };
          const advisoryId = object(object(chat.recipe["copies"])["advisory"])[
            "copyId"
          ];
          if (value["artifactId"] === advisoryId) {
            if (
              value["chatCompletion"] === undefined ||
              value["collectionId"] !== chat.plan["collectionId"]
            )
              return fail("denied");
            const ownedCollection = identifier(chat.plan["collectionId"]),
              rights = chat.queuedMetadata.rights;
            await ctx.authorize(
              principal,
              scope,
              ownedCollection,
              identifier(advisoryId),
              "publish",
              ctx.now()
            );
            for (const use of ["store", "derive"] as const) {
              await currentRights(
                tx,
                principal,
                scope,
                ownedCollection,
                rights.policyId,
                use,
                ctx.now(),
                rights.version
              );
              pinRights(ownedCollection, rights.policyId, rights.version, use);
            }
            finalChecks.push(async (now) => {
              await ctx.authorize(
                principal,
                scope,
                ownedCollection,
                identifier(advisoryId),
                "publish",
                now
              );
            });
            if (advisoryReceipt) {
              const source = await options.chatOutput.inspectForTransaction(
                tx,
                chatScope,
                identifier(chat.plan["responseRequestId"]),
                ctx.now()
              );
              if (
                !(
                  source &&
                  (await options.chatWorker.copies.advisoryLiveProofForTransaction(
                    tx,
                    chatScope,
                    identifier(chat.plan["responseRequestId"]),
                    ctx.now()
                  ))
                )
              )
                return chatAuthorityClosed;
              if (
                (await ctx.hash(source.metadata)) !==
                  (await ctx.hash(advisoryReceipt.metadata)) ||
                source.metadata.contentSha256 !== value["contentSha256"] ||
                value["canonicalSha256"] !== value["contentSha256"]
              )
                return fail("integrity");
              return finish({
                status: advisoryReceipt.duplicate ? "duplicate" : "accepted",
                artifact: {
                  artifactId: advisoryId,
                  artifactSha256: value["contentSha256"],
                },
                contentSha256: value["contentSha256"],
                canonicalSha256: value["contentSha256"],
              });
            }
            if (!governedBytes) return fail("unavailable");
            const prepared = await options.chatOutput.prepareForTransaction(
              tx,
              identity,
              value,
              governedBytes,
              ctx.now(),
              sourceInputs
            );
            if (!prepared) return chatAuthorityClosed;
            try {
              const proof = await options.modelUse(
                tx,
                principal,
                prepared.request,
                ctx.now(),
                governedBytes
              );
              if (
                (await chatOriginal(
                  tx,
                  scope,
                  { jobId: identifier(value["jobId"]) },
                  ctx.now()
                )) === chatAuthorityClosed
              ) {
                prepared.bytes.fill(0);
                return chatAuthorityClosed;
              }
              if (
                proof["decision"] !== "allowed" ||
                proof["externalDispatchAllowed"] !== false
              )
                return fail("denied");
              const ready = await finish({ kind: chatStagePrepared, prepared });
              if ((ready as unknown) === chatAuthorityClosed)
                prepared.bytes.fill(0);
              return ready;
            } catch (error) {
              prepared.bytes.fill(0);
              throw error;
            }
          }
          // ONLY exact bodyless public completed provenance may use ordinary
          // staging. Other IDs, missing extensions, and answer-bearing bodies
          // cannot become an alternate private-output sink.
          if (
            value["artifactId"] !== chat.plan["runId"] ||
            value["chatCompletion"] !== undefined
          )
            return fail("denied");
          if (
            !(await options.chatOutput.publicStageForTransaction(
              tx,
              identity,
              value,
              ctx.now()
            ))
          )
            return chatAuthorityClosed;
        }
        if (
          lease["kind"] === "native-bootstrap" &&
          (job["state"] !== "running" ||
            value["collectionId"] !== null ||
            value["canonicalSha256"] === null ||
            value["contentSha256"] !== value["canonicalSha256"] ||
            array(value["lineageArtifactIds"], 64).length !== 0 ||
            ![
              `native-outbox-evidence-${value["canonicalSha256"]}`,
              `native-owner-fence-${value["canonicalSha256"]}`,
            ].includes(string(value["artifactId"])))
        )
          fail("denied");
        const collection =
          value["collectionId"] === null
            ? null
            : identifier(value["collectionId"]);
        await ctx.authorize(
          principal,
          scope,
          collection,
          identifier(value["artifactId"]),
          "publish",
          at
        );
        const rights = await currentRights(
          tx,
          principal,
          scope,
          collection,
          identifier(value["rightsPolicyId"]),
          "store",
          at,
          identifier(value["rightsVersion"])
        );
        if (lease["kind"] === "native-bootstrap") {
          const selected = await bootstrapLicense();
          if (
            rights.policyId !== selected["policyId"] ||
            rights.version !== selected["version"]
          )
            fail("denied");
        }
        pinRights(collection, rights.policyId, rights.version);
        const bytes = decode(value["contentBase64"]);
        const rawHash = await ctx.digest(bytes);
        if (rawHash !== value["contentSha256"]) fail("integrity");
        if (value["canonicalSha256"] !== null) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            );
          } catch {
            return fail("invalid");
          }
          if ((await ctx.hash(parsed)) !== value["canonicalSha256"])
            fail("integrity");
          if (lease["kind"] === "native-bootstrap") {
            const proof = object(parsed);
            const commandPayload = object(
              requirePresent(bootstrapCommand, "bootstrapCommand")["payload"]
            );
            const expectedFormat = string(value["artifactId"]).startsWith(
              "native-outbox-evidence-"
            )
              ? "vertex-native-outbox-evidence-v1"
              : "vertex-native-owner-fence-v1";
            if (
              proof["format"] !== expectedFormat ||
              proof["accountAlias"] !== scope.accountAlias ||
              proof["environment"] !== scope.environment ||
              proof["journalIdentity"] !== commandPayload["journalIdentity"] ||
              proof["simulatorId"] !== commandPayload["simulatorId"] ||
              proof["streamId"] !== commandPayload["streamId"]
            )
              fail("denied");
          }
        }
        for (const parentId of array(value["lineageArtifactIds"], 64)) {
          const id = identifier(parentId);
          const parent = await selectedBacktestParent(
            collection,
            id,
            "derive",
            at
          );
          if (!parent) fail("denied");
          finalChecks.push(async (now) => {
            const current = await selectedBacktestParent(
              collection,
              id,
              "derive",
              now
            );
            if (
              !current ||
              (await ctx.hash(current)) !== (await ctx.hash(parent))
            )
              return fail("stale");
            return;
          });
        }
        const {
          contentBase64: ignoredBytes,
          leaseId: ignoredLease,
          leaseEpoch: ignoredEpoch,
          ...stable
        } = value;
        const prior = await one(
          tx,
          "vertex_worker_stages",
          scope,
          sql`artifact_id = ${value["artifactId"]}`
        );
        const descriptor = {
          ...stable,
          createdAt: prior ? object(prior["payload"])["createdAt"] : at,
        };
        const requestHash = await ctx.hash(descriptor);
        if (prior) {
          if (
            prior["request_hash"] !== requestHash ||
            prior["job_id"] !== job["job_id"]
          )
            fail("conflict");
          return finish({
            status: "duplicate",
            artifact: {
              artifactId: value["artifactId"],
              artifactSha256: value["canonicalSha256"] ?? rawHash,
            },
            contentSha256: rawHash,
            canonicalSha256: value["canonicalSha256"],
          });
        }
        const objectKey = vertexQualifiedObjectKey(
          scope,
          collection,
          value["canonicalSha256"] === rawHash ? "manifest" : "content",
          rawHash
        );
        const capabilities = options.objectCapabilities(scope);
        if (!capabilities.putIfAbsent) return fail("unavailable");
        const saved = await capabilities.putIfAbsent({
          key: objectKey,
          body: bytes,
          contentType: string(value["contentType"]),
          checksum: rawHash,
        });
        if (saved.status !== "ok") return fail("unavailable");
        if (
          saved.value.key !== objectKey ||
          saved.value.size !== bytes.byteLength ||
          saved.value.checksum !== rawHash
        )
          fail("integrity");
        await objectRead(scope, objectKey, rawHash);
        await insert(tx, "vertex_worker_stages", scope, {
          artifact_id: value["artifactId"],
          job_id: job["job_id"],
          collection_key: collectionKey(collection),
          object_key: objectKey,
          content_sha256: rawHash,
          canonical_sha256: value["canonicalSha256"],
          request_hash: requestHash,
          byte_length: bytes.byteLength,
          payload: descriptor,
        });
        return finish({
          status: "accepted",
          artifact: {
            artifactId: value["artifactId"],
            artifactSha256: value["canonicalSha256"] ?? rawHash,
          },
          contentSha256: rawHash,
          canonicalSha256: value["canonicalSha256"],
        });
      }
      if (
        operation === "acceptedEvidence" ||
        operation === "acceptedEvidenceObservation"
      ) {
        const collection = identifier(value["collectionId"]);
        const accepted = await queries.getAcceptedEvidence(
          principal,
          scope,
          collection,
          identifier(value["evidenceId"])
        );
        if (!accepted) return fail("denied");
        await ctx.authorize(
          { actorId: identifier(accepted.review["actorId"]) },
          scope,
          collection,
          accepted.artifact.artifactId,
          "review",
          at
        );
        const rights = await currentRights(
          tx,
          principal,
          scope,
          collection,
          accepted.artifact.rights.policyId,
          "derive",
          at
        );
        pinRights(collection, rights.policyId, rights.version, "derive");
        finalChecks.push(async (now) => {
          await ctx.authorize(
            principal,
            scope,
            collection,
            accepted.artifact.artifactId,
            "read",
            now
          );
          await ctx.authorize(
            { actorId: identifier(accepted.review["actorId"]) },
            scope,
            collection,
            accepted.artifact.artifactId,
            "review",
            now
          );
          if (time(accepted.review["expiresAt"]) <= time(now))
            return fail("stale");
          return;
        });
        const bytes = await objectRead(
          scope,
          accepted.artifact.objectKey,
          accepted.artifact.artifactSha256
        );
        const output = {
          artifact: {
            artifactId: accepted.artifact.artifactId,
            artifactSha256: accepted.artifact.artifactSha256,
          },
          contentBase64: canonicalBase64(bytes),
          evidence: accepted.evidence,
          review: accepted.review,
          rights,
        };
        if (operation === "acceptedEvidenceObservation") {
          return finishObservation(
            output,
            "WorkerAcceptedEvidenceObservationOutput",
            "vertex-worker-accepted-evidence-observation-v1"
          );
        }
        return finish(output);
      }
      if (operation === "readCollection") {
        return finish(
          await readCollection(
            tx,
            principal,
            scope,
            identifier(value["collectionId"]),
            value["snapshotId"] === null
              ? null
              : identifier(value["snapshotId"]),
            at
          )
        );
      }
      if (operation === "activateCollection") {
        const collection = identifier(value["collectionId"]);
        await ctx.authorize(
          principal,
          scope,
          collection,
          collection,
          "publish",
          at
        );
        finalChecks.push(async (now) => {
          await ctx.authorize(
            principal,
            scope,
            collection,
            collection,
            "publish",
            now
          );
        });
        const hash = await ctx.hash({
          collectionId: collection,
          expectedActiveSnapshotId: value["expectedActiveSnapshotId"],
          targetSnapshotId: value["targetSnapshotId"],
          manifestSha256: value["manifestSha256"],
          rightsPins: value["rightsPins"],
        });
        const target = await one(
          tx,
          "vertex_worker_collection_snapshots",
          scope,
          sql`collection_id = ${collection} and snapshot_id = ${value["targetSnapshotId"]}`
        );
        if (
          !target ||
          target["manifest_sha256"] !== value["manifestSha256"] ||
          (await ctx.hash(target["rights_pins"])) !==
            (await ctx.hash(value["rightsPins"]))
        )
          fail("integrity");
        for (const pin of array(value["rightsPins"], 1024).map(object)) {
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            identifier(pin["policyId"]),
            "derive",
            at,
            identifier(pin["version"])
          );
          pinRights(
            collection,
            identifier(pin["policyId"]),
            identifier(pin["version"]),
            "derive"
          );
        }
        const prior = await one(
          tx,
          "vertex_worker_collection_activations",
          scope,
          sql`collection_id = ${collection} and idempotency_key = ${value["idempotencyKey"]}`
        );
        if (prior) {
          if (prior["request_hash"] !== hash) fail("conflict");
          const reconstructed = await readCollection(
            tx,
            principal,
            scope,
            collection,
            identifier(prior["snapshot_id"]),
            at
          );
          return finish({
            ...reconstructed,
            status: "duplicate",
            previousSnapshotId: prior["previous_snapshot_id"],
          });
        }
        if (value["expectedActiveSnapshotId"] === value["targetSnapshotId"])
          fail("invalid");
        const reconstructed = await readCollection(
          tx,
          principal,
          scope,
          collection,
          identifier(value["targetSnapshotId"]),
          at
        );
        // Explicit pointer CAS, not publish's duplicate shortcut. Every generation,
        // source identity, shard and other collection remains immutable/preserved.
        const changed = await rows(
          tx,
          sql`update vertex_collections set active_snapshot_id = ${value["targetSnapshotId"]}, updated_at = ${at} where ${scopeWhere(scope)} and collection_id = ${collection} and active_snapshot_id = ${value["expectedActiveSnapshotId"]} returning active_snapshot_id`
        );
        if (changed.length !== 1) fail("conflict");
        await insert(tx, "vertex_worker_collection_activations", scope, {
          collection_id: collection,
          idempotency_key: value["idempotencyKey"],
          request_hash: hash,
          previous_snapshot_id: value["expectedActiveSnapshotId"],
          snapshot_id: value["targetSnapshotId"],
          activated_at: at,
        });
        return finish({
          ...reconstructed,
          status: "activated",
          previousSnapshotId: value["expectedActiveSnapshotId"],
        });
      }
      if (operation === "publishExperiment") {
        if (
          job["state"] !== "running" ||
          !["research-run", "backtest"].includes(string(lease["kind"]))
        )
          fail("denied");
        const collection = identifier(value["collectionId"]);
        const experimentId = identifier(value["experimentId"]);
        const artifactId = `experiment-${await ctx.hash({ collectionId: collection, experimentId })}`;
        const bytes = decode(value["contentBase64"]);
        const digest = digestString(value["contentSha256"]);
        if (bytes.byteLength === 0 || (await ctx.digest(bytes)) !== digest)
          fail("integrity");
        let original: VertexRecord;
        try {
          original = object(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          );
        } catch {
          return fail("invalid");
        }
        const handoff = await parse("WorkerExperimentHandoff", original);
        const canonical = ctx.encode(handoff);
        if (
          handoff["experimentId"] !== experimentId ||
          (await ctx.hash(handoff)) !== digest ||
          bytes.byteLength !== canonical.byteLength ||
          !bytes.every((byte, index) => byte === canonical[index]) ||
          time(handoff["requestedAt"]) > time(at)
        )
          fail("integrity");
        const checkOutput = async (now: string): Promise<void> => {
          if (time(now) < time(at)) fail("stale");
          await ctx.authorize(
            principal,
            scope,
            collection,
            artifactId,
            "publish",
            now
          );
          await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(lease["policySelectionId"]),
              selectionSha256: string(lease["policySelectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          );
          for (const use of ["store", "derive", "export"] as const) {
            await currentRights(
              tx,
              principal,
              scope,
              collection,
              identifier(value["rightsPolicyId"]),
              use,
              now,
              identifier(value["rightsVersion"])
            );
          }
        };
        await checkOutput(at);
        finalChecks.push(checkOutput);
        const strategy = object(handoff["strategy"]);
        const pins = array(value["dependencyPins"], 64).map(object);
        if (
          pins.length === 0 ||
          new Set(pins.map((pin) => pin["artifactId"])).size !== pins.length
        )
          fail("integrity");
        const dependencies = new Map<string, VertexRecord>();
        for (const pin of pins) {
          const dependency = await experimentDependency(
            tx,
            principal,
            scope,
            collection,
            identifier(strategy["id"]),
            pin,
            at
          );
          const sourceBytes = await objectRead(
            scope,
            string(dependency["objectKey"]),
            digestString(pin["artifactSha256"])
          );
          const sourceCanonical = ctx.encode(dependency["record"]);
          if (
            sourceBytes.byteLength !== sourceCanonical.byteLength ||
            !sourceBytes.every((byte, index) => byte === sourceCanonical[index])
          )
            fail("integrity");
          dependencies.set(identifier(pin["artifactId"]), {
            ...dependency,
            artifactSha256: pin["artifactSha256"],
          });
          finalChecks.push(async (now) => {
            await experimentDependency(
              tx,
              principal,
              scope,
              collection,
              identifier(strategy["id"]),
              pin,
              now
            );
          });
        }
        const used = new Set<string>();
        const strategyDependency = dependencies.get(identifier(strategy["id"]));
        if (
          strategyDependency?.["contractName"] !== "StrategySpec" ||
          strategyDependency["artifactSha256"] !== strategy["hash"]
        )
          fail("integrity");
        const strategyRecord = object(
          requirePresent(strategyDependency, "strategyDependency")["record"]
        );
        if (
          `${strategyRecord["strategyId"]}:${strategyRecord["version"]}` !==
            strategy["id"] ||
          strategyRecord["hypothesis"] !==
            object(handoff["hypothesis"])["statement"]
        )
          fail("integrity");
        used.add(identifier(strategy["id"]));
        for (const dataset of array(handoff["datasets"], 64).map(object)) {
          const matches = [...dependencies.entries()].filter(
            ([, candidate]) =>
              candidate["contractName"] === "DatasetManifest" &&
              candidate["artifactSha256"] === dataset["manifestHash"] &&
              object(candidate["record"])["datasetId"] === dataset["datasetId"]
          );
          if (matches.length !== 1) fail("integrity");
          const [id, dependency] = requirePresent(matches[0], "matches[0]");
          const manifest = object(dependency["record"]);
          // Narrow supported frozen snapshot: original manifest clocks and all
          // source snapshot IDs agree. No inferred availability or vintage.
          if (
            time(manifest["captureTime"]) !== time(dataset["availableAt"]) ||
            time(manifest["asOfAt"]) !== time(dataset["knowledgeCutoff"]) ||
            array(manifest["sources"], 512)
              .map(object)
              .some((source) => source["snapshotId"] !== dataset["snapshotId"])
          )
            fail("integrity");
          used.add(id);
        }
        for (const citation of array(
          object(handoff["hypothesis"])["citations"],
          64
        ).map(object)) {
          const matches = [...dependencies.entries()].filter(
            ([, dependency]) =>
              dependency["contractName"] === "ResearchEvidence" &&
              dependency["artifactSha256"] === citation["artifactHash"] &&
              object(object(dependency["record"])["sourceIdentity"])[
                "sourceId"
              ] === citation["sourceId"]
          );
          if (matches.length !== 1) fail("integrity");
          used.add(requirePresent(matches[0], "matches[0]")[0]);
        }
        if (used.size !== pins.length) fail("integrity");
        const lineage = [...used].sort();
        if (handoff["priorExperimentHash"] !== null) {
          const predecessor = await one(
            tx,
            "vertex_worker_experiment_publications",
            scope,
            sql`collection_id = ${collection} and content_sha256 = ${handoff["priorExperimentHash"]}`
          );
          if (!predecessor || predecessor["experiment_id"] === experimentId)
            fail("integrity");
          await experimentPublication(
            tx,
            principal,
            scope,
            requirePresent(predecessor, "predecessor"),
            at,
            ["read", "store", "derive", "export"]
          );
          finalChecks.push(async (now) => {
            await experimentPublication(
              tx,
              principal,
              scope,
              requirePresent(predecessor, "predecessor"),
              now,
              ["read", "store", "derive", "export"]
            );
          });
          lineage.push(
            identifier(
              requirePresent(predecessor, "predecessor")["artifact_id"]
            )
          );
        }
        const prior = await one(
          tx,
          "vertex_worker_experiment_publications",
          scope,
          sql`collection_id = ${collection} and experiment_id = ${experimentId}`
        );
        const sourcePins =
          value["sourceReviewPins"] === undefined
            ? undefined
            : experimentSourcePins(value["sourceReviewPins"]);
        if (
          sourcePins === undefined &&
          array(object(handoff["hypothesis"])["citations"], 64)
            .map(object)
            .some((citation) =>
              string(citation["locator"]).includes(":mapping-sha256:")
            )
        )
          fail("integrity");
        const sourceFields =
          sourcePins === undefined ? {} : { sourceReviewPins: sourcePins };
        if (prior) {
          const originalPins = object(prior["payload"])["sourceReviewPins"];
          if (
            (originalPins === undefined) !== (sourcePins === undefined) ||
            (originalPins !== undefined &&
              (await ctx.hash(experimentSourcePins(originalPins))) !==
                (await ctx.hash(sourcePins)))
          )
            fail("conflict");
        }
        if (sourcePins !== undefined) {
          const sourceProducer = prior
            ? identifier(object(prior["payload"])["producerPrincipalId"])
            : principal.actorId;
          const checkSources = async (now: string): Promise<void> => {
            if (time(now) < time(at)) fail("stale");
            await experimentSources(
              tx,
              principal,
              scope,
              collection,
              sourceProducer,
              handoff,
              pins,
              sourcePins,
              now
            );
          };
          await checkSources(at);
          finalChecks.push(checkSources);
          lineage.push(
            ...sourcePins.map((pin) => identifier(pin["artifactId"]))
          );
        }
        if (prior) {
          // A new job may confirm the original binding, never add/remove/refresh
          // source-review authority or rewrite any immutable descriptor pins.
          if (prior["content_sha256"] !== digest) fail("conflict");
          await experimentPublication(tx, principal, scope, prior, at, [
            "read",
            "store",
            "derive",
            "export",
          ]);
          const originalBytes = await objectRead(
            scope,
            string(prior["object_key"]),
            digest
          );
          if (
            originalBytes.byteLength !== bytes.byteLength ||
            !originalBytes.every((byte, index) => byte === bytes[index])
          )
            fail("integrity");
          finalChecks.push(async (now) => {
            await experimentPublication(tx, principal, scope, prior, now, [
              "read",
              "store",
              "derive",
              "export",
            ]);
          });
        } else {
          if (
            (await one(
              tx,
              "vertex_artifacts",
              scope,
              sql`artifact_id = ${artifactId}`
            )) ||
            (await one(
              tx,
              "vertex_worker_stages",
              scope,
              sql`artifact_id = ${artifactId}`
            ))
          )
            fail("conflict");
          const objectKey = vertexQualifiedObjectKey(
            scope,
            collection,
            "manifest",
            digest
          );
          const capabilities = options.objectCapabilities(scope);
          if (!capabilities.putIfAbsent) return fail("unavailable");
          const saved = await capabilities.putIfAbsent({
            key: objectKey,
            body: bytes,
            contentType: "application/json",
            checksum: digest,
          });
          if (saved.status !== "ok") return fail("unavailable");
          if (
            saved.value.key !== objectKey ||
            saved.value.size !== bytes.byteLength ||
            saved.value.checksum !== digest
          )
            fail("integrity");
          const persisted = await objectRead(scope, objectKey, digest);
          if (
            persisted.byteLength !== bytes.byteLength ||
            !persisted.every((byte, index) => byte === bytes[index])
          )
            fail("integrity");
          // Object presence alone is not publication; only the committed private
          // binding makes it reachable. Failure rolls back binding and outputs.
          const descriptor = {
            profile: "vertex-private-experiment-publication-v1",
            ...scope,
            collectionId: collection,
            experimentId,
            artifactId,
            contentSha256: digest,
            objectKey,
            byteLength: bytes.byteLength,
            rightsPolicyId: value["rightsPolicyId"],
            rightsVersion: value["rightsVersion"],
            lineageArtifactIds: lineage,
            dependencyPins: pins,
            ...sourceFields,
            producerJobId: job["job_id"],
            producerPrincipalId: principal.actorId,
            publishedAt: ctx.now(),
          };
          await insert(tx, "vertex_worker_experiment_publications", scope, {
            collection_id: collection,
            experiment_id: experimentId,
            artifact_id: artifactId,
            content_sha256: digest,
            object_key: objectKey,
            byte_length: bytes.byteLength,
            record_hash: await ctx.hash(descriptor),
            payload: descriptor,
          });
        }
        await recordOutputs([artifactId]);
        return finish(
          await parse("WorkerPublishExperimentOutput", {
            status: prior ? "duplicate" : "accepted",
            jobId: job["job_id"],
            collectionId: collection,
            experimentId,
            artifact: { artifactId, artifactSha256: digest },
          })
        );
      }
      if (
        operation === "publishArtifact" ||
        operation === "publishAgent" ||
        operation === "publishCollection"
      ) {
        if (job["state"] !== "running") fail("conflict");
        await options.policySelection(
          tx,
          principal,
          {
            ...scope,
            selectionId: string(lease["policySelectionId"]),
            selectionSha256: string(lease["policySelectionSha256"]),
          },
          identity.servicePrincipalId,
          string(job["job_id"])
        );
        finalChecks.push(async (now) => {
          if (time(now) < time(at)) fail("stale");
          return await options.policySelection(
            tx,
            principal,
            {
              ...scope,
              selectionId: string(lease["policySelectionId"]),
              selectionSha256: string(lease["policySelectionSha256"]),
            },
            identity.servicePrincipalId,
            string(job["job_id"])
          );
        });
        const collection =
          value["collectionId"] === null
            ? null
            : identifier(value["collectionId"]);
        finalChecks.push(async (now) => {
          await ctx.authorize(
            principal,
            scope,
            collection,
            identifier(
              operation === "publishCollection"
                ? value["collectionId"]
                : object(value["artifact"])["artifactId"]
            ),
            "publish",
            now
          );
        });
        const seal = async (
          name: string,
          record: VertexRecord,
          reference: VertexRecord
        ): Promise<void> => {
          const metadata = await promote(
            tx,
            local,
            principal,
            scope,
            string(job["job_id"]),
            collection,
            name,
            record,
            reference,
            at,
            selectedBacktestParent
          );
          for (const parentId of metadata.lineageArtifactIds) {
            finalChecks.push(async (now) => {
              if (
                !(await selectedBacktestParent(
                  collection,
                  parentId,
                  "derive",
                  now
                ))
              )
                return fail("denied");
              return;
            });
          }
          pinRights(
            collection,
            metadata.rights.policyId,
            metadata.rights.version
          );
        };
        if (operation === "publishArtifact") {
          const record = object(value["record"]);
          if (value["experimentSource"] !== undefined) {
            // Only this linked planning path bypasses job-private staging. The
            // immutable object write is preparatory; metadata, record and owned
            // output commit only after the SAME transaction's final checks.
            if (
              value["contractName"] !== "BacktestRun" ||
              collection === null ||
              scope.environment !== "research" ||
              lease["kind"] !== "research-run"
            )
              fail("denied");
            const admitted = await one(
              tx,
              "vertex_worker_run_admissions",
              scope,
              sql`job_id = ${job["job_id"]}`
            );
            if (
              !admitted ||
              admitted["request_hash"] !== lease["payloadSha256"] ||
              admitted["lease_epoch"] !== lease["leaseEpoch"] ||
              time(admitted["admitted_at"]) > time(at)
            )
              fail("denied");
            const source = object(value["experimentSource"]);
            const reference = object(value["artifact"]);
            const runId = identifier(record["runId"]);
            const runHash = digestString(reference["artifactSha256"]);
            const experimentId = identifier(source["experimentId"]);
            const experimentHash = digestString(source["experimentHash"]);
            const bindingHash = digestString(source["bindingSha256"]);
            if (
              reference["artifactId"] !== runId ||
              (await ctx.hash(record)) !== runHash
            )
              fail("integrity");
            const checkExperiment = async (
              now: string
            ): Promise<VertexRecord> => {
              if (time(now) < time(at)) fail("stale");
              const committed = await one(
                tx,
                "vertex_worker_experiment_publications",
                scope,
                sql`collection_id = ${collection} and experiment_id = ${experimentId}`
              );
              if (!committed || committed["content_sha256"] !== experimentHash)
                return fail("integrity");
              return experimentPublication(
                tx,
                principal,
                scope,
                committed,
                now,
                ["read", "derive", "export"]
              );
            };
            const committed = await checkExperiment(at);
            finalChecks.push(async (now) => {
              await checkExperiment(now);
            });
            const originalJson = async (
              key: string,
              digest: string
            ): Promise<VertexRecord> => {
              const originalBytes = await objectRead(scope, key, digest);
              let original: VertexRecord;
              try {
                original = object(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      originalBytes
                    )
                  )
                );
              } catch {
                return fail("integrity");
              }
              const canonical = ctx.encode(original);
              if (
                (await ctx.hash(original)) !== digest ||
                originalBytes.byteLength !== canonical.byteLength ||
                !originalBytes.every((byte, index) => byte === canonical[index])
              )
                fail("integrity");
              return original;
            };
            const handoff = await originalJson(
              string(committed["objectKey"]),
              experimentHash
            );
            const frozenStrategy = object(handoff["strategy"]);
            const strategyId = identifier(frozenStrategy["id"]);
            const pins = array(source["dependencyPins"], 63).map(object);
            const committedPins = array(committed["dependencyPins"], 64).map(
              object
            );
            if (
              pins.length === 0 ||
              pins.length !== committedPins.length ||
              new Set(pins.map((pin) => pin["artifactId"])).size !==
                pins.length ||
              pins.some(
                (pin) =>
                  !committedPins.some(
                    (original) =>
                      original["artifactId"] === pin["artifactId"] &&
                      original["artifactSha256"] === pin["artifactSha256"] &&
                      original["rightsPolicyId"] === pin["rightsPolicyId"]
                  )
              )
            )
              fail("integrity");
            const dependencies = new Map<string, VertexRecord>();
            for (const pin of pins) {
              const checkDependency = async (
                now: string
              ): Promise<VertexRecord> => {
                if (time(now) < time(at)) fail("stale");
                return await experimentDependency(
                  tx,
                  principal,
                  scope,
                  requirePresent(collection, "collection"),
                  strategyId,
                  pin,
                  now
                );
              };
              const dependency = await checkDependency(at);
              const original = await originalJson(
                string(dependency["objectKey"]),
                digestString(pin["artifactSha256"])
              );
              if (
                (await ctx.hash(original)) !==
                (await ctx.hash(dependency["record"]))
              )
                fail("integrity");
              dependencies.set(identifier(pin["artifactId"]), {
                ...dependency,
                artifactSha256: pin["artifactSha256"],
              });
              finalChecks.push(async (now) => {
                await checkDependency(now);
              });
            }
            const strategy = dependencies.get(strategyId);
            if (
              strategy?.["contractName"] !== "StrategySpec" ||
              strategy["artifactSha256"] !== frozenStrategy["hash"]
            )
              fail("integrity");
            const strategyRecord = object(
              requirePresent(strategy, "strategy")["record"]
            );
            if (
              `${strategyRecord["strategyId"]}:${strategyRecord["version"]}` !==
                strategyId ||
              strategyRecord["codeDigest"] !==
                handoff["implementationDigest"] ||
              strategyRecord["hypothesis"] !==
                object(handoff["hypothesis"])["statement"]
            )
              fail("integrity");
            const datasets = array(handoff["datasets"], 64).map(object);
            for (const dataset of datasets) {
              const matches = [...dependencies.entries()].filter(
                ([, dependency]) =>
                  dependency["contractName"] === "DatasetManifest" &&
                  dependency["artifactSha256"] === dataset["manifestHash"] &&
                  object(dependency["record"])["datasetId"] ===
                    dataset["datasetId"]
              );
              if (matches.length !== 1) fail("integrity");
              // Match the immutable store's actual dataset relationship target,
              // not just an equally named/digested record in another collection.
              const target = await one(
                tx,
                "vertex_datasets",
                scope,
                sql`dataset_id = ${identifier(dataset["datasetId"])}`
              );
              if (
                !target ||
                target["collection_key"] !== collection ||
                target["artifact_id"] !==
                  requirePresent(matches[0], "matches[0]")[0]
              )
                fail("integrity");
            }
            const bindingPin = object(source["bindingReview"]);
            if (
              bindingPin["collectionId"] !== collection ||
              pins.some((pin) => pin["artifactId"] === bindingPin["artifactId"])
            )
              fail("denied");
            const checkBinding = async (now: string): Promise<VertexRecord> => {
              if (time(now) < time(at)) fail("stale");
              // Generic exact-review lookup also verifies the review's original
              // strategy scope, real author, atomic link and current rights.
              const dependency = await experimentDependency(
                tx,
                principal,
                scope,
                requirePresent(collection, "collection"),
                strategyId,
                bindingPin,
                now
              );
              const evidence = object(dependency["record"]);
              const metadata = await ctx.artifact(
                tx,
                principal,
                scope,
                collection,
                identifier(bindingPin["artifactId"]),
                "read",
                now
              );
              if (
                dependency["contractName"] !== "ResearchEvidence" ||
                evidence["evidenceId"] !== bindingPin["evidenceId"] ||
                evidence["collectionId"] !== collection ||
                evidence["contentHash"] !== bindingHash ||
                object(evidence["sourceIdentity"])["contentHash"] !==
                  bindingHash ||
                object(evidence["sourceIdentity"])["snapshotId"] !==
                  evidence["snapshotId"] ||
                !metadata ||
                metadata.sourceContentSha256 !== bindingHash
              )
                fail("integrity");
              return dependency;
            };
            const bindingDependency = await checkBinding(at);
            finalChecks.push(async (now) => {
              await checkBinding(now);
            });
            await originalJson(
              string(bindingDependency["objectKey"]),
              digestString(bindingPin["artifactSha256"])
            );
            const binding = await originalJson(
              vertexQualifiedObjectKey(
                scope,
                collection,
                "content",
                bindingHash
              ),
              bindingHash
            );
            const bindingKeys = [
              "format",
              "bindingId",
              "revision",
              "experimentId",
              "experimentHash",
              "runId",
              "runHash",
              "costModelHash",
              "lineage",
              "budget",
              "descriptor",
              "memoryMbBytes",
              "trialParameters",
              "parameterTargets",
              "datasetSnapshots",
              "model",
              "modelHash",
              "publication",
              "publicationHash",
              "plannedAt",
              "executionAuthority",
              "simulatedCapitalEntersNav",
            ];
            if (
              Object.keys(binding).sort().join(",") !==
                bindingKeys.sort().join(",") ||
              binding["format"] !==
                "vertex-reviewed-experiment-backtest-binding-v1" ||
              binding["experimentId"] !== experimentId ||
              binding["experimentHash"] !== experimentHash ||
              binding["runId"] !== runId ||
              binding["runHash"] !== runHash ||
              binding["executionAuthority"] !== "none" ||
              binding["simulatedCapitalEntersNav"] !== false ||
              typeof binding["revision"] !== "number" ||
              !Number.isSafeInteger(binding["revision"]) ||
              binding["revision"] < 1
            )
              fail("integrity");
            identifier(binding["bindingId"]);
            if (
              binding["costModelHash"] !==
                (await ctx.hash(strategyRecord["costModel"])) ||
              binding["modelHash"] !== (await ctx.hash(binding["model"])) ||
              binding["publicationHash"] !==
                (await ctx.hash(binding["publication"])) ||
              time(binding["plannedAt"]) < time(handoff["requestedAt"]) ||
              time(binding["plannedAt"]) > time(at)
            )
              fail("integrity");
            const publication = object(binding["publication"]);
            const evidence = object(bindingDependency["record"]);
            if (
              Object.keys(publication).sort().join(",") !==
                [
                  "actorId",
                  "collectionId",
                  "snapshotId",
                  "rightsPolicyId",
                  "rightsVersion",
                ]
                  .sort()
                  .join(",") ||
              publication["actorId"] !== principal.actorId ||
              publication["collectionId"] !== collection ||
              publication["snapshotId"] !== evidence["snapshotId"]
            )
              fail("denied");
            // runHash in independently reviewed original binding covers ALL
            // fields, including benchmark/mode. Everything derived from frozen
            // experiment/strategy is independently reconstructed, not echoed.
            const windows = object(handoff["windows"]);
            const training = object(windows["training"]);
            const test = object(windows["outOfSample"]);
            const expected = {
              schemaVersion: "1.0.0",
              runId,
              strategyVersion: strategyId,
              datasetManifestIds: datasets
                .map((dataset) => identifier(dataset["datasetId"]))
                .sort(),
              seed: handoff["seed"],
              engineVersion: handoff["engineVersion"],
              trainingWindow: {
                startAtInclusive: training["start"],
                endAtExclusive: training["end"],
              },
              testWindow: {
                startAtInclusive: test["start"],
                endAtExclusive: test["end"],
              },
              benchmark: record["benchmark"],
              transactionCosts: strategyRecord["costModel"],
              slippageModel: object(strategyRecord["costModel"])["impactModel"],
              resultsRef: null,
              leakageChecks: [],
              reviewStatus: "unreviewed",
              validationMode: record["validationMode"],
              forwardSampleCount: 0,
              gammaProvenance: null,
            };
            if (
              !["historical", "walk-forward"].includes(
                string(record["validationMode"])
              ) ||
              (await ctx.hash(expected)) !== runHash
            )
              fail("integrity");
            const lineage = [
              ...pins.map((pin) => identifier(pin["artifactId"])),
              identifier(bindingPin["artifactId"]),
            ].sort();
            if (lineage.includes(runId) || runId === committed["artifactId"])
              fail("integrity");
            const checkOutput = async (
              now: string
            ): Promise<VertexRightsRecord> => {
              if (time(now) < time(at)) fail("stale");
              await ctx.authorize(
                principal,
                scope,
                collection,
                runId,
                "publish",
                now
              );
              for (const parent of lineage) {
                if (
                  !(await ctx.artifact(
                    tx,
                    principal,
                    scope,
                    collection,
                    parent,
                    "derive",
                    now
                  ))
                )
                  fail("denied");
              }
              for (const use of ["read", "derive", "export"] as const) {
                await currentRights(
                  tx,
                  principal,
                  scope,
                  collection,
                  identifier(publication["rightsPolicyId"]),
                  use,
                  now,
                  identifier(publication["rightsVersion"])
                );
              }
              return currentRights(
                tx,
                principal,
                scope,
                collection,
                identifier(publication["rightsPolicyId"]),
                "store",
                now,
                identifier(publication["rightsVersion"])
              );
            };
            const rights = await checkOutput(at);
            finalChecks.push(async (now) => {
              await checkOutput(now);
            });
            const bytes = ctx.encode(record);
            if (
              bytes.byteLength === 0 ||
              bytes.byteLength > 1_048_576 ||
              (await ctx.digest(bytes)) !== runHash
            )
              fail("integrity");
            const objectKey = vertexQualifiedObjectKey(
              scope,
              collection,
              "manifest",
              runHash
            );
            const prior = await ctx.artifact(
              tx,
              principal,
              scope,
              collection,
              runId,
              "read",
              at
            );
            const metadata: VertexArtifactMetadata = {
              artifactId: runId,
              scope,
              collectionId: collection,
              objectKey,
              artifactSha256: runHash,
              sourceContentSha256: null,
              byteLength: bytes.byteLength,
              contentType: "application/json",
              schemaVersion: "1.0.0",
              contractName: "BacktestRun",
              rights,
              lineageArtifactIds: lineage,
              createdAt: prior ? prior.createdAt : at,
            };
            if (prior) {
              // No metadata refresh/relabeling on retry, even across jobs.
              if ((await ctx.hash(prior)) !== (await ctx.hash(metadata)))
                fail("conflict");
            } else {
              if (
                (await one(
                  tx,
                  "vertex_worker_stages",
                  scope,
                  sql`artifact_id = ${runId}`
                )) ||
                (await one(
                  tx,
                  "vertex_worker_experiment_publications",
                  scope,
                  sql`artifact_id = ${runId}`
                ))
              )
                fail("conflict");
              const capabilities = options.objectCapabilities(scope);
              if (!capabilities.putIfAbsent) return fail("unavailable");
              const saved = await capabilities.putIfAbsent({
                key: objectKey,
                body: bytes,
                contentType: "application/json",
                checksum: runHash,
              });
              if (saved.status !== "ok") return fail("unavailable");
              if (
                saved.value.key !== objectKey ||
                saved.value.size !== bytes.byteLength ||
                saved.value.checksum !== runHash
              )
                fail("integrity");
            }
            const persisted = await objectRead(scope, objectKey, runHash);
            if (
              persisted.byteLength !== bytes.byteLength ||
              !persisted.every((byte, index) => byte === bytes[index])
            )
              fail("integrity");
            await research.registerArtifact(principal, metadata);
            const recorded = await research.recordImmutable({
              principal,
              scope,
              collectionId: collection,
              contractName: "BacktestRun",
              record,
              artifact: { artifactId: runId, artifactSha256: runHash },
              idempotencyKey: identifier(value["idempotencyKey"]),
            });
            await recordOutputs([runId]);
            return finish(
              await result(
                job,
                recorded.status === "duplicate" ? "duplicate" : "accepted"
              )
            );
          }
          const pins =
            value["reviewPins"] === undefined
              ? []
              : array(value["reviewPins"], 64).map(object);
          if (value["contractName"] === "ResearchEvidence") {
            // The contentHash lookup is the same immutable source binding used
            // by promote; native/input hashes never replace this output digest.
            const source = await one(
              tx,
              "vertex_worker_stages",
              scope,
              sql`job_id = ${job["job_id"]} and collection_key = ${collectionKey(collection)} and content_sha256 = ${record["contentHash"]} and canonical_sha256 is null`
            );
            if (!source) fail("integrity");
            const bytes = await objectRead(
              scope,
              string(requirePresent(source, "source")["object_key"]),
              string(record["contentHash"])
            );
            let content: unknown = null;
            try {
              content = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes)
              );
            } catch {
              // Existing non-JSON evidence sources retain their original path.
              content = null;
            }
            if (
              content !== null &&
              typeof content === "object" &&
              !Array.isArray(content) &&
              (content as VertexRecord)["artifactKind"] ===
                "gamma-research-proposal"
            ) {
              const gamma = object(content);
              if (
                record["sourceType"] !== "derived-analysis" ||
                record["acceptanceStatus"] !== "unreviewed" ||
                gamma["proposalOnly"] !== true ||
                gamma["executionAuthorized"] !== false ||
                pins.length === 0
              )
                fail("denied");
              let nativeIdentity: VertexRecord;
              try {
                nativeIdentity = object(
                  JSON.parse(string(gamma["nativeInputIdentityJson"]))
                );
              } catch {
                return fail("invalid");
              }
              const evidenceIds = array(nativeIdentity["qualification"], 3).map(
                (entry) => identifier(object(entry)["evidence_id"])
              );
              if (
                evidenceIds.length !== pins.length ||
                new Set(evidenceIds).size !== evidenceIds.length ||
                pins.some(
                  (pin) => !evidenceIds.includes(identifier(pin["evidenceId"]))
                )
              )
                fail("integrity");
            }
          }
          if (
            new Set(pins.map((pin) => pin["evidenceId"])).size !== pins.length
          )
            fail("integrity");
          for (const pin of pins) {
            if (collection === null || pin["collectionId"] !== collection)
              fail("denied");
            const check = async (now: string): Promise<void> => {
              // Re-resolve latest, never latest accepted: a superseding reject,
              // changed exact hash, expired review or revoked grant fails closed.
              const current = await createQueryOperations(
                boundContext(tx, now, scope)
              ).getAcceptedEvidence(
                principal,
                scope,
                identifier(pin["collectionId"]),
                identifier(pin["evidenceId"])
              );
              if (
                !current ||
                current.artifact.artifactId !== pin["artifactId"] ||
                current.artifact.artifactSha256 !== pin["artifactSha256"] ||
                current.review["reviewId"] !== pin["reviewId"] ||
                current.review["reviewVersion"] !== pin["reviewVersion"] ||
                time(current.review["expiresAt"]) <= time(now)
              )
                fail("stale");
              if (
                pin["rightsPolicyId"] !==
                requirePresent(current, "current").artifact.rights.policyId
              )
                fail("denied");
              await ctx.authorize(
                principal,
                scope,
                collection,
                identifier(pin["artifactId"]),
                "read",
                now
              );
              await ctx.authorize(
                {
                  actorId: identifier(
                    requirePresent(current, "current").review["actorId"]
                  ),
                },
                scope,
                collection,
                identifier(pin["artifactId"]),
                "review",
                now
              );
              for (const use of ["read", "derive", "export"] as const) {
                await currentRights(
                  tx,
                  principal,
                  scope,
                  collection,
                  identifier(pin["rightsPolicyId"]),
                  use,
                  now,
                  identifier(pin["rightsVersion"])
                );
              }
            };
            await check(at);
            finalChecks.push(check);
          }
          if (
            value["contractName"] === "DatasetManifest" &&
            record["historicalSemantics"] !== undefined
          ) {
            if (
              scope.environment !== "research" ||
              lease["kind"] !== "dataset-ingest" ||
              job["state"] !== "running"
            )
              return fail("denied");
            const selected = await options.policySelection(
              tx,
              principal,
              {
                ...scope,
                selectionId: string(lease["policySelectionId"]),
                selectionSha256: string(lease["policySelectionSha256"]),
              },
              identity.servicePrincipalId,
              string(job["job_id"])
            );
            const graph = await historicalDataset(
              tx,
              principal,
              scope,
              collection,
              string(job["job_id"]),
              record,
              at
            );
            const admitted = await one(
              tx,
              "vertex_worker_run_admissions",
              scope,
              sql`job_id = ${job["job_id"]}`
            );
            if (
              !admitted ||
              admitted["run_id"] !== job["job_id"] ||
              admitted["request_hash"] !== lease["payloadSha256"] ||
              admitted["lease_epoch"] !== lease["leaseEpoch"]
            )
              return fail("denied");
            for (const item of [graph.request, graph.capture, graph.content]) {
              if (
                time(item.descriptor["createdAt"]) <
                  time(admitted["admitted_at"]) ||
                time(item.descriptor["createdAt"]) > time(at)
              )
                fail("integrity");
            }
            const current = async (now: string): Promise<void> => {
              const selection = await options.policySelection(
                tx,
                principal,
                {
                  ...scope,
                  selectionId: string(lease["policySelectionId"]),
                  selectionSha256: string(lease["policySelectionSha256"]),
                },
                identity.servicePrincipalId,
                string(job["job_id"])
              );
              if ((await ctx.hash(selection)) !== (await ctx.hash(selected)))
                fail("stale");
              const capabilities = array(selection["providerCapabilities"], 256)
                .map(object)
                .filter(
                  (entry) =>
                    entry["providerId"] === "ibkr" &&
                    entry["operation"] === "historical-bars" &&
                    entry["modelVersion"] === null
                );
              if (
                capabilities.length !== 1 ||
                requirePresent(capabilities[0], "capabilities[0]")["state"] !==
                  "ready" ||
                requirePresent(capabilities[0], "capabilities[0]")[
                  "rightsPolicyId"
                ] !== record["entitlementPolicyId"] ||
                requirePresent(capabilities[0], "capabilities[0]")[
                  "rightsPolicyVersion"
                ] !== graph.capture.descriptor["rightsVersion"] ||
                time(
                  requirePresent(capabilities[0], "capabilities[0]")[
                    "observedAt"
                  ]
                ) > time(now) ||
                time(
                  requirePresent(capabilities[0], "capabilities[0]")[
                    "expiresAt"
                  ]
                ) <= time(now)
              )
                fail("denied");
              for (const use of ["read", "store", "derive"] as const) {
                await currentRights(
                  tx,
                  principal,
                  scope,
                  collection,
                  identifier(record["entitlementPolicyId"]),
                  use,
                  now,
                  identifier(graph.capture.descriptor["rightsVersion"])
                );
              }
            };
            await current(at);
            finalChecks.push(current);
          }
          await seal(
            string(value["contractName"]),
            object(value["record"]),
            object(value["artifact"])
          );
          const recorded = await research.recordImmutable({
            principal,
            scope,
            collectionId: collection,
            contractName: string(
              value["contractName"]
            ) as VertexImmutableInput["contractName"],
            record: value["record"],
            artifact: object(value["artifact"]) as {
              artifactId: string;
              artifactSha256: string;
            },
            idempotencyKey: identifier(value["idempotencyKey"]),
          });
          await recordOutputs([recorded.artifactId]);
          return finish(
            await result(
              job,
              recorded.status === "duplicate" ? "duplicate" : "accepted"
            )
          );
        }
        if (operation === "publishCollection") {
          if (collection === null) fail("invalid");
          const reconstructionRef = object(value["reconstructionArtifact"]);
          const indexStage = await staged(
            tx,
            principal,
            scope,
            identifier(reconstructionRef["artifactId"]),
            collection,
            at,
            string(job["job_id"])
          );
          if (
            indexStage["content_sha256"] !==
              reconstructionRef["artifactSha256"] ||
            indexStage["canonical_sha256"] !==
              reconstructionRef["artifactSha256"]
          )
            fail("integrity");
          const indexBytes = await objectRead(
            scope,
            string(indexStage["object_key"]),
            string(indexStage["content_sha256"])
          );
          let index: VertexRecord;
          try {
            index = object(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(indexBytes)
              )
            );
          } catch {
            return fail("invalid");
          }
          if (
            Object.keys(index).sort().join(",") !==
              [
                "profile",
                "collectionId",
                "snapshotId",
                "expectedSnapshotId",
                "preparedAt",
                "imports",
                "evidence",
                "content",
                "manifest",
                "rightsRevisions",
              ]
                .sort()
                .join(",") ||
            index["profile"] !== "vertex-control-knowledge-index-v1" ||
            index["collectionId"] !== collection ||
            index["expectedSnapshotId"] !== value["expectedActiveSnapshotId"] ||
            index["snapshotId"] !==
              object(object(array(value["imports"], 64)[0])["record"])[
                "snapshotId"
              ]
          )
            fail("integrity");
          const imports = array(value["imports"], 64).map(
            (item) => object(item)["artifact"]
          );
          const evidence = array(value["evidence"], 512).map(
            (item) => object(item)["artifact"]
          );
          if (
            (await ctx.hash(index["imports"])) !== (await ctx.hash(imports)) ||
            (await ctx.hash(index["evidence"])) !== (await ctx.hash(evidence))
          )
            fail("integrity");
          const pins = array(value["rightsPins"], 1024).map(object);
          if (
            (await ctx.hash(index["rightsRevisions"])) !==
            (await ctx.hash(
              pins.map((pin) => [
                pin["sourceId"],
                pin["policyId"],
                pin["version"],
              ])
            ))
          )
            fail("integrity");
          if (
            new Set(pins.map((pin) => pin["sourceId"])).size !== pins.length ||
            !pins.some((pin) => pin["sourceId"] === "collection")
          )
            fail("invalid");
          for (const pin of pins) {
            await currentRights(
              tx,
              principal,
              scope,
              collection,
              identifier(pin["policyId"]),
              "store",
              at,
              identifier(pin["version"])
            );
            pinRights(
              collection,
              identifier(pin["policyId"]),
              identifier(pin["version"])
            );
          }
          const manifest = object(index["manifest"]);
          if (manifest["artifactSha256"] !== value["manifestSha256"])
            fail("integrity");
          await verifyReconstruction(
            tx,
            principal,
            scope,
            requirePresent(collection, "collection"),
            string(job["job_id"]),
            index,
            digestString(value["manifestSha256"]),
            at
          );
          const members = [
            reconstructionRef,
            manifest,
            ...imports.map(object),
            ...evidence.map(object),
            ...array(index["content"], 1024).map((item) =>
              object(object(item)["artifact"])
            ),
          ];
          for (const member of members) {
            const memberStage = await staged(
              tx,
              principal,
              scope,
              identifier(member["artifactId"]),
              collection,
              at,
              string(job["job_id"])
            );
            if (
              (memberStage["canonical_sha256"] ??
                memberStage["content_sha256"]) !== member["artifactSha256"]
            )
              fail("integrity");
            const memberDescriptor = object(memberStage["payload"]);
            if (
              !pins.some(
                (pin) =>
                  pin["policyId"] === memberDescriptor["rightsPolicyId"] &&
                  pin["version"] === memberDescriptor["rightsVersion"]
              )
            )
              fail("denied");
          }
          const reconstructionDescriptor = {
            collectionId: collection,
            snapshotId: index["snapshotId"],
            reconstructionArtifact: reconstructionRef,
            manifestSha256: value["manifestSha256"],
            memberArtifacts: members,
            rightsPins: value["rightsPins"],
          };
          const reconstructionHash = await ctx.hash(reconstructionDescriptor);
          const priorReconstruction = await one(
            tx,
            "vertex_worker_collection_snapshots",
            scope,
            sql`collection_id = ${collection} and snapshot_id = ${index["snapshotId"]}`
          );
          if (
            priorReconstruction &&
            priorReconstruction["record_hash"] !== reconstructionHash
          )
            fail("conflict");
          for (const [name, key] of [
            ["KnowledgeImport", "imports"],
            ["ResearchEvidence", "evidence"],
            ["DatasetManifest", "datasets"],
          ] as const) {
            for (const item of array(
              value[key],
              key === "imports" ? 64 : 512
            ).map(object)) {
              await seal(
                name,
                object(item["record"]),
                object(item["artifact"])
              );
            }
          }
          const publication = await research.publication(
            {
              principal,
              scope,
              collectionId: requirePresent(collection, "collection"),
              expectedActiveSnapshotId:
                value["expectedActiveSnapshotId"] === null
                  ? null
                  : identifier(value["expectedActiveSnapshotId"]),
              imports: value["imports"],
              evidence: value["evidence"],
              datasets: value["datasets"],
              idempotencyKey: identifier(value["idempotencyKey"]),
            } as Parameters<typeof research.publication>[0],
            createOutboxOperations(local).enqueue
          );
          if (!priorReconstruction) {
            await insert(tx, "vertex_worker_collection_snapshots", scope, {
              collection_id: collection,
              snapshot_id: publication.snapshotId,
              job_id: job["job_id"],
              reconstruction_artifact_id: reconstructionRef["artifactId"],
              reconstruction_sha256: reconstructionRef["artifactSha256"],
              manifest_sha256: value["manifestSha256"],
              member_artifacts: members,
              rights_pins: value["rightsPins"],
              record_hash: reconstructionHash,
              payload: reconstructionDescriptor,
            });
          }
          const reconstructed = await readCollection(
            tx,
            principal,
            scope,
            requirePresent(collection, "collection"),
            publication.snapshotId,
            at
          );
          await recordOutputs(
            imports.map((reference) =>
              identifier(object(reference)["artifactId"])
            )
          );
          return finish({
            ...reconstructed,
            status: publication.status,
            previousSnapshotId: publication.previousSnapshotId,
          });
        }
        const run = object(value["run"]);
        const admission = await one(
          tx,
          "vertex_worker_run_admissions",
          scope,
          sql`job_id = ${job["job_id"]} and run_id = ${run["runId"]}`
        );
        if (!admission) fail("denied");
        const profileRef = object(value["advisoryProfileArtifact"]);
        if (chat) {
          if (
            !(options.chatOutput && options.chatWorker) ||
            scope.environment !== "research" ||
            collection !== chat.plan["collectionId"] ||
            !governedBytes ||
            value["idempotencyKey"] !==
              `chat-publish-${chat.plan["responseRequestId"]}` ||
            object(value["artifact"])["artifactId"] !== chat.plan["runId"] ||
            profileRef["artifactId"] !==
              object(object(chat.recipe["copies"])["advisory"])["copyId"] ||
            (await ctx.hash(value["reviewPins"])) !==
              (await ctx.hash(chat.plan["reviewPins"])) ||
            requirePresent(admission, "admission")["request_hash"] !==
              chat.origin["recipeSha256"] ||
            requirePresent(admission, "admission")["lease_epoch"] !==
              value["leaseEpoch"] ||
            time(requirePresent(admission, "admission")["admitted_at"]) >
              time(at)
          )
            return fail("denied");
          const source = await options.chatOutput.inspectForTransaction(
            tx,
            { accountAlias: scope.accountAlias, environment: "research" },
            identifier(chat.plan["responseRequestId"]),
            ctx.now()
          );
          if (
            !(
              source &&
              (await options.chatWorker.copies.advisoryLiveProofForTransaction(
                tx,
                { accountAlias: scope.accountAlias, environment: "research" },
                identifier(chat.plan["responseRequestId"]),
                ctx.now()
              ))
            )
          )
            return chatAuthorityClosed;
          if (
            source.metadata.contentSha256 !== profileRef["artifactSha256"] ||
            governedBytes.byteLength !== source.metadata.byteLength ||
            (await ctx.digest(governedBytes)) !==
              profileRef["artifactSha256"] ||
            (await ctx.hash(run)) !==
              (await ctx.hash(
                await options.chatOutput.expectedPublicRunForTransaction(
                  tx,
                  chat
                )
              ))
          )
            return fail("integrity");
          const rights = chat.queuedMetadata.rights;
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            rights.policyId,
            "derive",
            ctx.now(),
            rights.version
          );
          pinRights(collection, rights.policyId, rights.version, "derive");
        } else {
          const profile = await staged(
            tx,
            principal,
            scope,
            identifier(profileRef["artifactId"]),
            collection,
            at,
            string(job["job_id"])
          );
          if (
            profile["content_sha256"] !== profileRef["artifactSha256"] ||
            profile["canonical_sha256"] !== profileRef["artifactSha256"]
          )
            fail("integrity");
          const descriptor = object(profile["payload"]);
          pinRights(
            collection,
            string(descriptor["rightsPolicyId"]),
            string(descriptor["rightsVersion"]),
            "derive"
          );
          const profileBytes = await objectRead(
            scope,
            string(profile["object_key"]),
            string(profile["content_sha256"])
          );
          let privateValue: VertexRecord;
          try {
            privateValue = object(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(profileBytes)
              )
            );
          } catch {
            return fail("invalid");
          }
          const privateResult = object(privateValue["result"]);
          if (
            privateValue["profile"] !== "vertex-internal-agent-advisory-v1" ||
            privateValue["taskContract"] !== run["taskContract"] ||
            privateValue["modelVersion"] !== run["modelVersion"] ||
            privateResult["run_id"] !== run["runId"] ||
            privateResult["status"] !== run["status"] ||
            privateResult["execution_authorized"] !== false
          )
            fail("integrity");
        }
        const pins = array(value["reviewPins"], 64).map(object);
        const evidenceIds = array(run["inputEvidenceIds"]).map(identifier);
        if (
          pins.length !== evidenceIds.length ||
          new Set(pins.map((pin) => pin["evidenceId"])).size !== pins.length
        )
          fail("integrity");
        for (const pin of pins) {
          if (
            !evidenceIds.includes(identifier(pin["evidenceId"])) ||
            pin["collectionId"] !== collection
          )
            fail("denied");
          const accepted = await queries.getAcceptedEvidence(
            principal,
            scope,
            identifier(pin["collectionId"]),
            identifier(pin["evidenceId"])
          );
          if (
            !accepted ||
            accepted.artifact.artifactId !== pin["artifactId"] ||
            accepted.artifact.artifactSha256 !== pin["artifactSha256"] ||
            accepted.review["reviewId"] !== pin["reviewId"] ||
            accepted.review["reviewVersion"] !== pin["reviewVersion"]
          )
            fail("stale");
          await ctx.authorize(
            { actorId: identifier(accepted.review["actorId"]) },
            scope,
            collection,
            accepted.artifact.artifactId,
            "review",
            at
          );
          await currentRights(
            tx,
            principal,
            scope,
            collection,
            identifier(pin["rightsPolicyId"]),
            "derive",
            at,
            identifier(pin["rightsVersion"])
          );
          if (pin["rightsPolicyId"] !== accepted.artifact.rights.policyId)
            fail("denied");
          pinRights(
            collection,
            string(pin["rightsPolicyId"]),
            string(pin["rightsVersion"]),
            "derive"
          );
          finalChecks.push(async (now) => {
            if (time(accepted.review["expiresAt"]) <= time(now)) fail("stale");
            await ctx.authorize(
              principal,
              scope,
              collection,
              accepted.artifact.artifactId,
              "read",
              now
            );
            return await ctx.authorize(
              { actorId: identifier(accepted.review["actorId"]) },
              scope,
              collection,
              accepted.artifact.artifactId,
              "review",
              now
            );
          });
        }
        await seal("AgentRun", run, object(value["artifact"]));
        const requestHash = await ctx.hash({
          run,
          artifact: value["artifact"],
          profile: profileRef,
          reviewPins: value["reviewPins"],
        });
        const recorded = await research.recordPrivateAgent(
          {
            principal,
            scope,
            collectionId: collection,
            contractName: "AgentRun",
            record: run,
            artifact: object(value["artifact"]) as {
              artifactId: string;
              artifactSha256: string;
            },
            idempotencyKey: identifier(value["idempotencyKey"]),
          },
          identifier(profileRef["artifactId"]),
          async (sameTx, now) => {
            await ensureCurrent();
            const prior = await one(
              sameTx,
              "vertex_worker_agent_publications",
              scope,
              sql`run_id = ${run["runId"]}`
            );
            if (prior) {
              if (prior["request_hash"] !== requestHash) fail("conflict");
              return;
            }
            return await insert(
              sameTx,
              "vertex_worker_agent_publications",
              scope,
              {
                run_id: run["runId"],
                run_artifact_id: object(value["artifact"])["artifactId"],
                advisory_artifact_id: profileRef["artifactId"],
                advisory_sha256: profileRef["artifactSha256"],
                request_hash: requestHash,
                review_pins: value["reviewPins"],
                published_at: now,
              }
            );
          }
        );
        await recordOutputs([recorded.artifactId]);
        return finish(
          await result(
            job,
            recorded.status === "duplicate" ? "duplicate" : "accepted"
          )
        );
      }
      if (operation === "currentPaperAdmission") {
        if (
          scope.environment !== "paper" ||
          lease["kind"] !== "paper-simulation"
        )
          fail("denied");
        const admission = await one(
          tx,
          "vertex_paper_jobs",
          scope,
          sql`admission_id = ${value["admissionId"]}`
        );
        if (
          !admission ||
          (await ctx.hash(admission["payload"])) !== admission["record_hash"]
        )
          fail("integrity");
        const paper = object(requirePresent(admission, "admission")["payload"]);
        if (
          paper["actorId"] !== principal.actorId ||
          paper["intentSha256"] !== value["intentSha256"]
        )
          fail("denied");
        const reviewRow = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`review_id = ${paper["reviewId"]}`
        );
        if (
          !reviewRow ||
          reviewRow["artifact_id"] !== value["intentArtifactId"]
        )
          fail("denied");
        const review = object(
          requirePresent(reviewRow, "reviewRow")["payload"]
        );
        await ctx.authorize(
          { actorId: identifier(review["actorId"]) },
          scope,
          collectionId(
            requirePresent(reviewRow, "reviewRow")["collection_key"]
          ),
          identifier(value["intentArtifactId"]),
          "review",
          at
        );
        await createReviewOperations(
          local,
          projections.currentPortfolio
        ).admitPaperSimulation(principal, scope, paper);
        const intentRow = await one(
          tx,
          "vertex_records",
          scope,
          sql`artifact_id = ${value["intentArtifactId"]} and contract_name = 'TradeIntent'`
        );
        if (
          !intentRow ||
          (await ctx.hash(intentRow["payload"])) !== value["intentSha256"]
        )
          fail("integrity");
        // Executor throws become rejections, matching the former async check.
        finalChecks.push(
          (now) =>
            new Promise<void>((resolve) => {
              if (
                time(paper["expiresAt"]) <= time(now) ||
                time(review["expiresAt"]) <= time(now)
              )
                fail("stale");
              resolve();
            })
        );
        return finish({
          status: "allowed",
          checkedAt: at,
          expiresAt: paper["expiresAt"],
          admission: paper,
          review,
          intentArtifact: {
            artifactId: value["intentArtifactId"],
            artifactSha256: value["intentSha256"],
          },
          intent: requirePresent(intentRow, "intentRow")["payload"],
        });
      }
      if (
        operation === "publishGenesis" ||
        operation === "publishPortfolioSnapshot" ||
        operation === "publishOrderProjection" ||
        operation === "publishNativeFacts"
      ) {
        if (
          scope.environment !== "paper" ||
          !["paper-simulation", "native-bootstrap"].includes(
            string(lease["kind"])
          ) ||
          job["state"] !== "running"
        )
          fail("denied");
        if (
          lease["kind"] === "native-bootstrap" &&
          (operation === "publishOrderProjection" ||
            operation === "publishNativeFacts")
        )
          fail("denied");
        const observation = object(
          operation === "publishGenesis" ||
            operation === "publishPortfolioSnapshot"
            ? value["snapshot"]
            : value["projection"]
        );
        const nativePrincipal = await options.nativeProjectionPrincipal(
          tx,
          identity,
          lease,
          operation,
          observation
        );
        if (
          observation["actorId"] !== undefined &&
          observation["actorId"] !== nativePrincipal.actorId
        )
          fail("denied");
        if (operation === "publishOrderProjection")
          return finish(
            await projections.appendExecutionProjection(
              nativePrincipal,
              scope,
              value["projection"]
            )
          );
        if (operation === "publishNativeFacts")
          return finish(
            await createNativeFactOperations(local).appendNativeFactProjection(
              nativePrincipal,
              scope,
              value["projection"],
              decode(value["proofBase64"])
            )
          );
        const snapshot = object(value["snapshot"]);
        if (operation === "publishGenesis" && snapshot["sequence"] !== "1")
          fail("invalid");
        const recorded = await projections.recordPortfolioSnapshot(
          nativePrincipal,
          scope,
          snapshot
        );
        return finish({
          status: recorded === "duplicate" ? "duplicate" : "applied",
          highWaterSequence: snapshot["sequence"],
          highWaterEventHash: snapshot["sourceEventHash"],
        });
      }
      if (operation === "readContinuity") {
        const continuity = await projections.getContinuity(
          principal,
          scope,
          identifier(value["streamId"])
        );
        if (!continuity) return fail("unavailable");
        return finish(continuity);
      }
      if (operation === "readiness") {
        if (time(value["observedAt"]) > time(at)) fail("invalid");
        const prior = await one(
          tx,
          "vertex_worker_readiness",
          scope,
          sql`job_id = ${job["job_id"]}`
        );
        if (
          prior &&
          BigInt(string(prior["observed_at_ns"])) >= time(value["observedAt"])
        ) {
          if ((await ctx.hash(prior["payload"])) !== (await ctx.hash(value)))
            fail("stale");
          return finish(await result(job, "duplicate"));
        }
        await tx.execute(
          sql`insert into vertex_worker_readiness (account_alias, environment, job_id, lease_epoch, observed_at_ns, payload) values (${scope.accountAlias},${scope.environment},${job["job_id"]},${job["lease_epoch"]},${time(value["observedAt"]).toString()},${json(value)}) on conflict (account_alias,environment,job_id) do update set lease_epoch = excluded.lease_epoch, observed_at_ns = excluded.observed_at_ns, payload = excluded.payload`
        );
        return finish(await result(job, "accepted"));
      }
      return fail("invalid");
    });
  };
  const readResearchProposal = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    artifactId: string
  ): Promise<VertexRecord | null> => {
    identifier(artifactId);
    return await transaction(scope, async (tx, at) => {
      const source = await readResearchProposalForTransaction(
        ctx,
        tx,
        principal,
        scope,
        artifactId,
        at
      );
      return source?.proposal ?? null;
    });
  };
  // Governed external reads happen only BETWEEN worker transactions. Final
  // entry repeats real grant/lease/origin checks; no nested lifecycle transaction.
  const invoke = async (
    identity: WorkerServiceIdentity,
    operation: string,
    raw: unknown
  ): Promise<unknown> => {
    if (!options.chatWorker) return invokeTransaction(identity, operation, raw);
    // Status is ordinary authenticated durable-ledger observation, not a
    // governed-body read. Terminal calls must let actual expiry commit first.
    if (["status", "complete", "cancel"].includes(operation)) {
      const terminalResult = await invokeTransaction(identity, operation, raw);
      if (terminalResult === chatAuthorityClosed) return fail("denied");
      if (terminalResult !== chatSourcesRequired) return terminalResult;
    }
    const contract = inputNames[operation];
    if (!contract) return fail("invalid");
    const value = await parse(contract, raw),
      scope = identity.scope;
    if (
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment
    )
      return fail("denied");
    const chat = await transaction<
      | (Exclude<
          Awaited<ReturnType<typeof chatOriginal>>,
          null | typeof chatAuthorityClosed
        > &
          Readonly<{
            sourceLeaseExpiresAtNs: unknown;
            nativePurpose?: Exclude<NativeEvidenceCopyPurpose, "advisory">;
          }>)
      | null
      | typeof chatAuthorityClosed
    >(scope, async (tx, at) => {
      await grant(tx, identity, operation, at);
      const joined = await chatOriginal(
        tx,
        scope,
        { jobId: identifier(value["jobId"]) },
        at
      );
      if (joined === chatAuthorityClosed) return chatAuthorityClosed;
      if (!joined) return null;
      const job = await one(
        tx,
        "vertex_worker_jobs",
        scope,
        sql`job_id = ${value["jobId"]}`
      );
      if (
        !job ||
        job["grant_id"] !== identity.grantId ||
        job["lease_id"] !== value["leaseId"] ||
        job["lease_epoch"] !== value["leaseEpoch"] ||
        BigInt(string(job["lease_expires_at_ns"])) <= time(ctx.now()) ||
        BigInt(string(job["deadline_at_ns"])) <= time(ctx.now()) ||
        !["leased", "running"].includes(string(job["state"]))
      )
        return fail("denied");
      const lease = await parse("WorkerLease", job["payload"]);
      if (
        lease["kind"] !== "research-run" ||
        lease["researchPrincipalId"] !== joined.plan["ownerActorId"] ||
        lease["eventId"] !== joined.origin["eventId"] ||
        lease["payloadArtifactId"] !== joined.origin["recipeArtifactId"] ||
        lease["payloadSha256"] !== joined.origin["recipeSha256"] ||
        lease["policySelectionId"] !== joined.plan["selectionId"] ||
        lease["policySelectionSha256"] !== joined.plan["selectionSha256"] ||
        lease["deadlineAt"] !== joined.plan["expiresAt"]
      )
        return fail("denied");
      const native = isNativeEvidencePlan(joined.plan);
      const isGovernedRead =
        operation === "readArtifact" &&
        (native
          ? nativeEvidenceCopyPurposes
          : ["context", "tokenizeInput", "completionInput"]
        ).some(
          (purpose) =>
            object(object(joined.recipe["copies"])[purpose])["copyId"] ===
            value["artifactId"]
        );
      if (native && isGovernedRead && value["collectionId"] !== null)
        return fail("denied");
      if (
        (isGovernedRead ||
          [
            "currentModelUse",
            "prepareModelPrivacyReview",
            "readModelPrivacyReview",
            "prepareNativeEvidencePhaseTwo",
          ].includes(operation)) &&
        job["state"] !== "running"
      )
        return fail("denied");
      let nativePurpose:
        | Exclude<NativeEvidenceCopyPurpose, "advisory">
        | undefined;
      if (native) {
        try {
          if (
            [
              "currentModelUse",
              "prepareModelPrivacyReview",
              "readModelPrivacyReview",
            ].includes(operation)
          )
            nativePurpose = await nativeModelPurpose(
              tx,
              scope,
              joined.plan,
              value,
              at
            );
          if (
            (await chatOriginal(
              tx,
              scope,
              { jobId: identifier(value["jobId"]) },
              ctx.now()
            )) === chatAuthorityClosed
          )
            return chatAuthorityClosed;
          await grant(tx, identity, operation, ctx.now());
          if (
            BigInt(string(job["lease_expires_at_ns"])) <= time(ctx.now()) ||
            BigInt(string(job["deadline_at_ns"])) <= time(ctx.now())
          )
            return fail("stale");
        } catch (error) {
          // Commit independently observed original loss even when phase lookup
          // failed; request rejection by itself never closes the original.
          if (
            (await chatOriginal(
              tx,
              scope,
              { jobId: identifier(value["jobId"]) },
              ctx.now()
            )) === chatAuthorityClosed
          )
            return chatAuthorityClosed;
          throw error;
        }
      }
      return {
        ...joined,
        sourceLeaseExpiresAtNs: job["lease_expires_at_ns"],
        ...(nativePurpose === undefined ? {} : { nativePurpose }),
      };
    });
    if (chat === chatAuthorityClosed) return fail("denied");
    let bytes: Uint8Array | undefined;
    let sourceInputs: ResearchChatSourceInputs | undefined;
    try {
      if (chat?.plan["format"] === "vertex-research-chat-plan-v2") {
        if (!options.chatOutput) return fail("unavailable");
        const request = await sourceRequestForWorker(
          identity,
          operation,
          value,
          chat.plan,
          chat.sourceLeaseExpiresAtNs
        );
        sourceInputs = {
          request,
          token: await options.chatOutput.prepareSourceInputs(request),
        };
      }
      if (
        chat &&
        ([
          "admitRun",
          "readArtifact",
          "currentModelUse",
          "prepareModelPrivacyReview",
          "readModelPrivacyReview",
        ].includes(operation) ||
          (operation === "stageArtifact" &&
            value["chatCompletion"] !== undefined))
      ) {
        if (!options.chatWorker || scope.environment !== "research")
          return fail("unavailable");
        const all = object(chat.recipe["copies"]);
        const native = isNativeEvidencePlan(chat.plan);
        const initial = native
          ? ([
              "context",
              "tokenizeInput",
              "completionInput",
              "evidenceBundle",
            ] as const)
          : (["context", "tokenizeInput", "completionInput"] as const);
        const purposes =
          operation === "admitRun"
            ? initial
            : [
                  "currentModelUse",
                  "prepareModelPrivacyReview",
                  "readModelPrivacyReview",
                ].includes(operation)
              ? ([
                  native
                    ? (chat.nativePurpose ?? fail("denied"))
                    : value["operation"] === "model-tokenize"
                      ? "tokenizeInput"
                      : "completionInput",
                ] as const)
              : operation === "stageArtifact"
                ? ([
                    native ? "phaseTwoCompletionInput" : "completionInput",
                  ] as const)
                : (native
                    ? nativeEvidenceCopyPurposes.filter(
                        (purpose) => purpose !== "advisory"
                      )
                    : (["context", "tokenizeInput", "completionInput"] as const)
                  ).filter(
                    (purpose) =>
                      object(all[purpose])["copyId"] === value["artifactId"]
                  );
        for (const purpose of purposes) {
          const read = native
            ? await options.chatWorker.copies.readNativeInput(
                { accountAlias: scope.accountAlias, environment: "research" },
                identifier(chat.plan["responseRequestId"]),
                purpose
              )
            : await options.chatWorker.readOriginalInput(
                { accountAlias: scope.accountAlias, environment: "research" },
                identifier(chat.plan["responseRequestId"]),
                purpose
              );
          if (
            [
              "readArtifact",
              "currentModelUse",
              "prepareModelPrivacyReview",
              "readModelPrivacyReview",
              "stageArtifact",
            ].includes(operation)
          ) {
            bytes = read;
          } else read.fill(0);
        }
      }
      if (
        chat &&
        (operation === "publishAgent" ||
          (operation === "readArtifact" &&
            value["artifactId"] ===
              object(object(chat.recipe["copies"])["advisory"])["copyId"]))
      ) {
        if (
          !options.chatOutput ||
          scope.environment !== "research" ||
          (operation === "readArtifact" && value["collectionId"] !== null)
        )
          return fail("denied");
        bytes = await options.chatOutput.readAdvisory(
          { actorId: identifier(chat.plan["ownerActorId"]) },
          { accountAlias: scope.accountAlias, environment: "research" },
          identifier(chat.plan["responseRequestId"]),
          sourceInputs
        );
      }
      const output = await invokeTransaction(
        identity,
        operation,
        value,
        bytes,
        undefined,
        sourceInputs
      );
      if (output === chatAuthorityClosed) return fail("denied");
      if (
        output !== null &&
        typeof output === "object" &&
        (output as { kind?: symbol }).kind === chatNativePhasePrepared
      ) {
        if (
          !options.chatOutput ||
          operation !== "prepareNativeEvidencePhaseTwo"
        )
          return fail("unavailable");
        // Exactly one concrete invocation between committed worker transactions;
        // unknown external effects are never automatically retried here.
        const receipt = await parse(
          "WorkerPrepareNativeEvidencePhaseTwoOutput",
          await options.chatOutput.prepareNativeEvidencePhaseTwo(
            identity,
            value
          )
        );
        const accepted = await invokeTransaction(
          identity,
          operation,
          value,
          undefined,
          undefined,
          undefined,
          receipt
        );
        if (accepted === chatAuthorityClosed) return fail("denied");
        return accepted;
      }
      if (
        output !== null &&
        typeof output === "object" &&
        (output as { kind?: symbol }).kind === chatStagePrepared
      ) {
        if (!options.chatOutput) return fail("unavailable");
        const prepared = (output as { prepared: ResearchChatOutputPrepared })
          .prepared;
        const observed = await options.chatOutput.writeAndObserve(prepared);
        if (observed.status !== "live")
          return fail(observed.status === "closed" ? "denied" : "unavailable");
        const accepted = await invokeTransaction(
          identity,
          operation,
          value,
          undefined,
          { metadata: prepared.metadata, duplicate: prepared.duplicate },
          sourceInputs
        );
        if (accepted === chatAuthorityClosed) return fail("denied");
        return accepted;
      }
      return output;
    } catch (error) {
      // A rejected SQL publication/stage may have rolled back an observed
      // closure. Re-observe the concrete ORIGINAL source in a fresh metadata
      // transaction before denial; caller failure itself is NEVER authority.
      if (chat) {
        try {
          await transaction(scope, async (tx, at) =>
            chatOriginal(tx, scope, { jobId: identifier(value["jobId"]) }, at)
          );
        } catch {
          /* No proved loss: retain the original denial. */
        }
      }
      throw error;
    } finally {
      bytes?.fill(0);
      if (sourceInputs)
        requirePresent(
          options.chatOutput,
          "options.chatOutput"
        ).disposeSourceInputs(sourceInputs.token);
    }
  };
  return Object.freeze({
    authenticate,
    issueGrant,
    revokeGrant,
    prepareOutboxPayload,
    enqueueNativeBootstrap,
    readResearchProposal,
    bindOutbox,
    invoke,
  });
};

export type VertexWorkerStore = ReturnType<typeof createVertexWorkerStore>;
