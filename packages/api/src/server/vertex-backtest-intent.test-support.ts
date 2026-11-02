import { vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@darkfactory/db/server";
import {
  createVertexStore,
  type VertexArtifactMetadata,
} from "@darkfactory/db/server/vertex";
import { createVertexWorkerStore } from "@darkfactory/db/server/vertex-worker";
import { createVertexWorkerDispatcher } from "./vertex-dispatch/index.ts";
import { createVertexWorkerDispatchBoundary } from "./vertex-worker-service.ts";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { vertexPersistenceBoundary } from "./vertex-experience-adapter.ts";
import { createVertexExperienceCommands } from "./vertex-experience-commands.ts";
import { createVertexRuntimeRecipes } from "./vertex-runtime-recipes.ts";
import { extendChatWorkerSql } from "./vertex-research-chat-worker-sql.test-support.ts";
import { VertexResearchProposalInputSchema } from "../contracts/vertex-experience.ts";
import { parseRuntimePolicySelection } from "../contracts/vertex-policy.ts";

const now = "2026-09-22T12:00:00Z";
const end = "2026-09-22T13:00:00Z";
const digest = "a".repeat(64);
export const scope = {
  accountAlias: "synthetic-backtest",
  environment: "research" as const,
};
export const actor = { actorId: "synthetic-owner" };
export const principal = {
  userId: actor.actorId,
  role: "member" as const,
  status: "active" as const,
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));

// SQL/object/policy transports only. Commands, persisted request recovery,
// current rights/review reads and recipe resolver are the actual source owners.
// biome-ignore lint/suspicious/noExplicitAny: in-memory SQL/JSON fixture rows are untyped transport data; tests assert shapes via schemas, and unknown cascades casts into every consumer test
type FixtureValue = any;
export const fixture = async () => {
  const tables = new Map<string, Record<string, FixtureValue>[]>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const access = { allowed: true, at: now };
  const dialect = new PgDialect();
  const execute = async (fragment: SQL) => {
    const q = dialect.sqlToQuery(fragment);
    calls.push(q);
    if (q.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    // Exact findRecordArtifact transport query. The shared worker SQL helper
    // deliberately delegates aliased joins; do not replace the source reader.
    const lookup =
      /^select r\.\* from vertex_records r inner join vertex_artifacts a on a\.account_alias = r\.account_alias and a\.environment = r\.environment and a\.artifact_id = r\.artifact_id and a\.collection_key = r\.collection_key where r\.account_alias = \$1 and r\.environment = \$2 and r\.(artifact_id|record_id) = \$3( and r\.contract_name = \$4)? order by r\.artifact_id asc limit \$(4|5)$/.exec(
        q.sql
      );
    if (lookup) {
      const hasContract = lookup[2] !== undefined,
        count = hasContract ? 5 : 4;
      const limit = q.params[count - 1];
      if (
        q.params.length !== count ||
        Number(lookup[3]) !== count ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      )
        throw new Error("Unsupported fixture record lookup parameters");
      const joined: Record<string, FixtureValue>[] = [];
      for (const record of table("vertex_records")) {
        if (
          record["account_alias"] !== q.params[0] ||
          record["environment"] !== q.params[1] ||
          record[lookup[1]!] !== q.params[2] ||
          (hasContract && record["contract_name"] !== q.params[3])
        )
          continue;
        for (const artifact of table("vertex_artifacts")) {
          if (
            artifact["account_alias"] === record["account_alias"] &&
            artifact["environment"] === record["environment"] &&
            artifact["artifact_id"] === record["artifact_id"] &&
            artifact["collection_key"] === record["collection_key"]
          )
            joined.push(record);
        }
      }
      joined.sort((left, right) =>
        left["artifact_id"] < right["artifact_id"]
          ? -1
          : left["artifact_id"] > right["artifact_id"]
            ? 1
            : 0
      );
      return { rows: structuredClone(joined.slice(0, limit)) };
    }
    const match =
      /^insert into "(vertex_[a-z_0-9]+)" \((.*?)\) values \((.*?)\)$/.exec(
        q.sql
      );
    if (!match) throw new Error(`Unsupported fixture SQL: ${q.sql}`);
    const columns = match[2]!
      .split(",")
      .map((value) => value.trim().replaceAll('"', ""));
    const values = match[3]!.split(",").map((value) => value.trim());
    const row: Record<string, unknown> = {};
    for (const [index, column] of columns.entries()) {
      const token = values[index]!,
        pin = /^\$(\d+)(::jsonb)?$/.exec(token);
      if (!pin) throw new Error("Unsupported fixture insert");
      const value = q.params[Number(pin[1]) - 1];
      row[column] = pin[2] ? JSON.parse(String(value)) : structuredClone(value);
    }
    table(match[1]!).push(row);
    return { rows: [] };
  };
  const raw = {
    execute,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone(tables);
      try {
        return await fn({ execute });
      } catch (error) {
        tables.clear();
        for (const [key, value] of before) tables.set(key, value);
        throw error;
      }
    },
  } as unknown as Database;
  const db = extendChatWorkerSql({
    db: raw,
    table,
    calls,
    state: { afterQuery: () => undefined },
  });
  const options = {
    boundary: vertexPersistenceBoundary,
    authorization: { authorize: async () => access.allowed },
    clock: { now: () => access.at },
    maxProjectionAgeMs: 60_000,
    commandPolicy: async () => true,
  };
  const store = { ...createVertexStore(db, options) };
  const rights = {
    policyId: "policy-licensing-rights",
    version: "1.0.0",
    status: "granted" as const,
    allowedUses: ["store", "read", "derive"] as const,
    checkedAt: now,
    expiresAt: end,
    retentionUntil: null,
  };
  await store.putRights(actor, scope, "ssrn", rights);
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata: VertexArtifactMetadata }
  >();
  const seal = async (
    artifactId: string,
    contractName: VertexArtifactMetadata["contractName"],
    value: unknown
  ) => {
    const body = bytes(value),
      sha256 = await hashArtifact(body);
    const metadata: VertexArtifactMetadata = {
      artifactId,
      scope,
      collectionId: "ssrn",
      objectKey: `synthetic/${artifactId}`,
      artifactSha256: sha256,
      sourceContentSha256: null,
      byteLength: body.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName,
      rights,
      lineageArtifactIds: [],
      createdAt: now,
    };
    objects.set(artifactId, { bytes: body, metadata });
    return metadata;
  };
  const cost = {
    commissionPerUnit: "0.01",
    spreadBps: "2",
    slippageBps: "1",
    borrowAnnualBps: "100",
    impactModel: "participation-capped",
    maximumParticipationBps: "500",
  };
  const strategy = {
    schemaVersion: "1.0.0",
    strategyId: "synthetic-strategy",
    version: "1.0.0",
    sleeve: "quant",
    hypothesis: "Synthetic source-owner fixture only",
    universe: ["instrument"],
    signalSchedule: {
      calendar: "XNYS",
      timezone: "UTC",
      interval: "bar-close",
    },
    entryRules: [
      {
        ruleId: "entry",
        featureId: "feature",
        operator: "gt",
        threshold: "1",
        lookbackBars: 5,
      },
    ],
    exitRules: [
      {
        ruleId: "exit",
        featureId: "feature",
        operator: "lt",
        threshold: "0",
        lookbackBars: 5,
      },
    ],
    riskLimits: {
      maximumLoss: "1",
      maximumNotional: "100",
      maximumPositions: 1,
    },
    requiredData: [
      {
        kind: "candles",
        maximumAgeMs: 5000,
        pointInTimeRequired: true,
        entitlementPolicyId: rights.policyId,
      },
    ],
    costModel: cost,
    codeDigest: digest,
  };
  const planned = {
    schemaVersion: "1.0.0",
    runId: "synthetic-planned-run",
    strategyVersion: "strategy-original",
    datasetManifestIds: ["dataset"],
    seed: 1,
    engineVersion: "1.0.0",
    trainingWindow: {
      startAtInclusive: "2026-09-20T00:00:00Z",
      endAtExclusive: "2026-09-21T00:00:00Z",
    },
    testWindow: {
      startAtInclusive: "2026-09-21T00:00:00Z",
      endAtExclusive: now,
    },
    benchmark: "benchmark",
    transactionCosts: cost,
    slippageModel: "fixed-bps",
    resultsRef: null,
    leakageChecks: [],
    reviewStatus: "unreviewed",
    validationMode: "historical",
    forwardSampleCount: 0,
    gammaProvenance: null,
  };
  const strategyMeta = await seal(
      "strategy-original",
      "StrategySpec",
      strategy
    ),
    plannedMeta = await seal("planned-original", "BacktestRun", planned);
  for (const [metadata, value] of [
    [strategyMeta, strategy],
    [plannedMeta, planned],
  ] as const) {
    await store.registerArtifact(actor, metadata);
    // Historical source rows are fixture inputs, not simulated Host results.
    // The new command below goes through the actual atomic command owner.
    table("vertex_records").push({
      account_alias: scope.accountAlias,
      environment: scope.environment,
      collection_key: "ssrn",
      contract_name: metadata.contractName,
      record_id: "runId" in value ? value.runId : value.strategyId,
      version: "1.0.0",
      artifact_id: metadata.artifactId,
      artifact_sha256: metadata.artifactSha256,
      record_hash: metadata.artifactSha256,
      recorded_at: now,
      payload: value,
    });
  }
  await store.recordReview(actor, scope, {
    schemaVersion: "1.0.0",
    reviewId: "synthetic-review",
    ...scope,
    collectionId: "ssrn",
    artifactId: strategyMeta.artifactId,
    artifactSha256: strategyMeta.artifactSha256,
    reviewVersion: "1.0.0",
    decision: "accepted",
    purpose: "research",
    actorId: actor.actorId,
    reviewedAt: now,
    expiresAt: end,
    policyVersion: "1.0.0",
    strategyVersion: strategyMeta.artifactId,
    supersedesReviewId: null,
    executionAuthorized: false,
  });
  const ref = { artifactId: "synthetic-data", sha256: digest };
  const recipe = {
    format: "vertex-host-backtest-recipe-v2",
    strategy: {
      artifactId: strategyMeta.artifactId,
      sha256: strategyMeta.artifactSha256,
    },
    run: {
      artifactId: plannedMeta.artifactId,
      sha256: plannedMeta.artifactSha256,
    },
    datasets: [
      {
        manifest: ref,
        content: ref,
        contentFormat: "canonical-json",
        declaredEvents: 1,
      },
    ],
    evidence: [],
    lineage: {},
    budget: {},
    descriptor: {},
    model: {
      strategy_digest: digest,
      strategy_code_digest: digest,
      assumptions_digest: digest,
      engine_digest: digest,
      review_digest: digest,
      instrument_id: "synthetic",
      quantity: "1",
      initial_cash: "100",
      commission_per_fill: "0",
      slippage_per_unit: "0",
      enter_not_before_ns: "1",
      exit_not_before_ns: "2",
      evidence_template_bytes: btoa('{"synthetic":true}'),
      native_configuration_bytes: btoa('{"synthetic":true}'),
    },
    plannedAt: now,
    publication: {
      actorId: actor.actorId,
      collectionId: "ssrn",
      snapshotId: "snapshot",
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
    },
  };
  const pin = (
    artifactId: string,
    contractName = "SyntheticFixture",
    artifactSha256 = digest
  ) => ({ artifactId, contractName, artifactSha256, schemaVersion: "1.0.0" });
  const policyBody = {
    schemaVersion: "1.0.0",
    selectionId: "selection",
    ...scope,
    revision: "1",
    issuedAt: now,
    expiresAt: end,
    sourcePins: [
      {
        sourceId: "source",
        revision: "1",
        sourceSha256: digest,
        provenanceArtifact: pin("provenance"),
      },
    ],
    modules: [
      {
        moduleId: "module",
        version: "1.0.0",
        codeSha256: digest,
        contractSha256: digest,
        artifact: pin("module-artifact"),
        enabled: true,
        capabilities: ["research"],
        requiredComponents: ["host"],
      },
    ],
    policies: [
      "licensing-rights",
      "provider-budget",
      "tool",
      "risk",
      "capital",
      "cost",
      "calendar",
    ].map((role) => ({
      role,
      policyId: `policy-${role}`,
      version: "1.0.0",
      artifact: pin(`artifact-${role}`),
    })),
    configuration: [
      "broker-execution",
      "quantvps-transport",
      "options-analytics",
      "fundamentals-news",
      "historical-quant-data",
      "models-agent-tools",
      "storage-queue-audit",
    ].map((group) => ({
      group,
      state: "unknown",
      referenceIds: [],
      reasonCodes: [],
      provenanceSourceIds: ["source"],
    })),
    references: [],
    providerCapabilities: [],
    artifacts: [
      {
        bindingId: "backtest",
        role: "simulation-engine",
        artifact: pin(
          "recipe",
          "HostBacktestRecipe",
          await hashArtifact(recipe)
        ),
      },
    ],
    review: null,
    research: null,
    simulation: null,
    readOnly: true,
    nativeRearmAllowed: false,
    cloudCapitalAuthority: false,
  };
  const selection = await parseRuntimePolicySelection({
    ...policyBody,
    selectionSha256: await hashArtifact(policyBody),
  });
  const state = { selection, recipe, unavailable: false };
  const objectCapabilities = () => ({
    getBounded: async (key: string) => {
      const found = [...objects.values()].find(
        (value) => value.metadata.objectKey === key
      );
      return found
        ? {
            status: "ok",
            value: {
              body: new Uint8Array(found.bytes),
              metadata: { key, size: found.bytes.byteLength },
            },
          }
        : { status: "not-found" };
    },
  });
  const worker = createVertexWorkerStore(db, {
    ...options,
    objectCapabilities,
  } as never);
  const staged = vi.fn(async (_identity, _lease, payload) => ({
    artifactId: payload.artifactId,
    artifactSha256: payload.sha256,
  }));
  const recipes = createVertexRuntimeRecipes({
    db,
    store,
    workerStore: {
      readResearchProposal: worker.readResearchProposal,
      prepareOutboxPayload: staged,
    },
    objectCapabilities: objectCapabilities as never,
    clock: options.clock,
    consumerServiceId: "fixture-service",
    routes: [
      {
        taskContract: "backtest-task",
        kind: "backtest",
        bindingId: "backtest",
        ttlMilliseconds: 10_000,
      },
    ],
    readSelectedArtifact: async () => bytes(state.recipe),
    policyRegistry: {
      readHead: async () =>
        ({
          state: "active-read-only",
          selectionId: state.selection.selectionId,
          selectionSha256: state.selection.selectionSha256,
        }) as never,
      materialize: async () => {
        if (state.unavailable) throw new Error("Unavailable fixture policy");
        return state.selection;
      },
    },
  });
  const input = VertexResearchProposalInputSchema.parse({
    ...scope,
    question: "Run this exact synthetic reviewed backtest.",
    collectionId: "ssrn",
    evidenceIds: [],
    role: "research",
    idempotencyKey: "request-one",
    proposalOnly: true,
    executionAuthorized: false,
    backtestExpectation: {
      operation: "request-backtest",
      taskContract: "backtest-task",
      bindingId: "backtest",
      strategy: recipe.strategy,
      plannedRun: recipe.run,
      recipe: { artifactId: "recipe", sha256: await hashArtifact(recipe) },
      policy: {
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
        selectionRevision: selection.revision,
      },
    },
  });
  const deps = {
    ...options,
    store,
    research: {
      available: async () => true,
      taskContract: "backtest-task",
      modelVersion: "synthetic-model",
      tokenBudget: 100,
      costBudgetUsd: "1",
      rightsPolicyId: rights.policyId,
      allowedTools: [],
    },
    resolvePolicy: async () => ({
      policyIdentity: {
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
        selectionRevision: selection.revision,
        revision: "1",
      },
      research: deps.research,
    }),
    validateBacktestRequest: recipes.validateBacktestRequest,
    prepareManifest: async (value: FixtureValue) =>
      seal(value.artifactId, value.contractName, value.manifest),
    storage: () => ({
      getManifest: async (value: FixtureValue) =>
        objects.get(value.artifactId) ?? null,
    }),
  };
  const service = createVertexExperienceCommands(deps as never);
  const dispatch = async () => {
    const source = table("vertex_outbox").find(
      (row) => row["payload"]?.eventType === "agent.recorded"
    )!;
    return recipes.resolveBinding({
      command: { kind: "queued-agent", event: source["payload"] },
      lease: { scope, collectionId: "ssrn", eventId: source["event_id"] },
      identity: { scope },
      signal: new AbortController().signal,
    } as never);
  };
  const bindOutbox = vi.fn(async (_identity, source, binding) => ({
    status: "accepted",
    jobId: "synthetic-job",
    state: "leased",
    outputArtifactIds: [],
    reason: null,
    lease: {
      schemaVersion: "1.0.0",
      jobId: "synthetic-job",
      eventId: source.eventId,
      ...scope,
      kind: binding.kind,
      researchPrincipalId: binding.researchPrincipalId,
      payloadArtifactId: binding.payloadArtifactId,
      payloadSha256: binding.payloadSha256,
      policySelectionId: binding.policySelectionId,
      policySelectionSha256: binding.policySelectionSha256,
      deadlineAt: binding.deadlineAt,
      leaseId: "fixture-worker",
      leaseEpoch: "1",
      leaseExpiresAt: binding.deadlineAt,
      attempt: 1,
    },
  }));
  const dispatchClaimed = async () => {
    const source = table("vertex_outbox").find(
      (row) => row["payload"]?.eventType === "agent.recorded"
    )!;
    const row = {
      eventId: source["event_id"],
      scope,
      collectionId: "ssrn",
      eventType: "agent.recorded",
      payload: source["payload"],
      leaseOwner: "fixture-worker",
      leaseFence: "1",
      leaseExpiresAt: end,
    };
    const identity = {
      grantId: "fixture-grant",
      servicePrincipalId: "fixture-service",
      scope,
      expiresAt: end,
    };
    const dispatcher = createVertexWorkerDispatcher({
      boundary: createVertexWorkerDispatchBoundary(),
      outboxStore: {
        claimOutbox: async () => [row],
        settleOutbox: async () => true,
      },
      workerStore: { bindOutbox },
      resolveBinding: recipes.resolveBinding,
      clock: options.clock,
    } as never);
    return dispatcher.dispatchClaimed(identity, row, {
      workerInstanceId: "fixture-worker",
      kinds: ["backtest"],
    });
  };
  return {
    table,
    tables,
    calls,
    access,
    state,
    store,
    worker,
    service,
    recipes,
    input,
    dispatch,
    dispatchClaimed,
    bindOutbox,
    staged,
    objects,
    deps,
    db,
    options,
    objectCapabilities,
  };
};
