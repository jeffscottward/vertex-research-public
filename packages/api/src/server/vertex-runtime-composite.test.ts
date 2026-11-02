import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import * as vertex from "../contracts/vertex.ts";
import * as worker from "../contracts/vertex-worker.ts";
import * as control from "../contracts/vertex-control.ts";
import * as policy from "../contracts/vertex-policy.ts";
import { SleeveResearchRecipeSchema } from "./vertex-runtime-recipe-profiles.ts";
import {
  createVertexRuntimeRecipes,
  type VertexRuntimeRecipesOptions,
} from "./vertex-runtime-recipes.ts";

// Source-only composition. External object storage, reviewer/control service and
// policy registry fixtures do NOT establish backend durability or live grants.
// All recipe, loader, handler, _Job, ControlClient, rights/publication adapter and
// composite-envelope owners are real. The two component contents are SYNTHETIC
// review-pinned vertex-sleeve-result-v1 shapes of the verified HMM and jump
// operations (not re-executed here). Source Zod validation is not an installed bundle.
const at = "2026-09-22T12:00:00Z";
const expires = "2026-09-22T13:00:00Z";
const fitAt = "2026-09-17T12:00:00Z";
const modelAt = "2026-09-18T12:00:00Z";
const day1 = "2026-09-21T12:00:00Z";
const day2 = "2026-09-22T09:00:00Z";
const day2Jump = "2026-09-22T09:30:00Z";
const componentAsOf = "2026-09-22T10:00:00Z";
const componentCapturedAt = "2026-09-22T10:30:00Z";
const bindingAt = "2026-09-22T11:00:00Z";
const scope = {
  accountAlias: "fictional-composite-account",
  environment: "research" as const,
};
const collection = "composite-fixture";
const snapshot = "composite-snapshot";
const digest = "a".repeat(64);
const hmmModel = "d".repeat(64);
const jumpModel = "e".repeat(64);
const market = "synthetic-us-equity-index";
const calendar = "synthetic-xnys";
const rights = {
  policyId: "policy-licensing-rights",
  version: "1.0.0",
  status: "granted",
  allowedUses: ["read", "store", "derive", "export"],
  checkedAt: at,
  expiresAt: expires,
  retentionUntil: expires,
};
const bytes = (value: unknown) => Buffer.from(canonicalArtifactJson(value));
const artifact = (
  artifactId: string,
  contractName: string,
  artifactSha256 = digest
) => ({ artifactId, artifactSha256, contractName, schemaVersion: "1.0.0" });
const schemas: Record<string, any> = {
  ...vertex,
  ...worker,
  ...control,
  ...policy,
};
const ns = (value: string) => String(BigInt(Date.parse(value)) * 1_000_000n);
const pending = [
  {
    component: "ORCA",
    role: "detector",
    status: "pending-not-implemented-excluded-from-summary",
  },
  {
    component: "HMM-RL",
    role: "downstream-policy-not-a-stance",
    status: "pending-not-implemented-excluded-from-summary",
  },
];
const componentTimes = {
  model_fit_cutoff: ns(fitAt),
  model_available_at: ns(modelAt),
  scaler_fit_cutoff: ns(fitAt),
  scaler_available_at: ns(modelAt),
};
const sleeveResult = (
  operation: string,
  variant: string,
  encoding: string,
  projectedResult: unknown,
  prefix: string,
  modelSha: string
) => ({
  profile: "vertex-sleeve-result-v1",
  operation,
  asOf: componentAsOf,
  recipeSha256: "c".repeat(64),
  parameters: { variant },
  proposalOnly: true,
  executionAuthorized: false,
  acceptanceStatus: "unreviewed",
  simulatedCapitalEntersNav: false,
  projectedResult,
  projectionTimeEncoding: "epoch-nanoseconds-decimal-string",
  projectionDecimalEncoding: encoding,
  stateBasis: null,
  inputs: [
    ["features", "1".repeat(64)],
    ["model", modelSha],
    ["scaler", "2".repeat(64)],
  ].map(([name, sha256]) => ({
    role: `${prefix}_${name}`,
    review: {
      collectionId: collection,
      evidenceId: `${prefix}-${name}-evidence`,
      artifactId: `${prefix}-${name}-record`,
      artifactSha256: digest,
      reviewId: `${prefix}-${name}-review`,
      reviewVersion: "1.0.0",
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
    },
    content: { artifactId: `${prefix}-${name}-content`, sha256 },
  })),
  limitations: ["Synthetic component fixture; not a re-executed component."],
});
const hmmEncoding = "binary64-posterior-rounded-15-decimal-places-v1";
const jumpEncoding =
  "decimal-prec-200-half-even-cost-margin-rounded-15-decimal-places-v1";
const hmmContent = sleeveResult(
  "macro-hmm-forward-v1",
  "diagonal-gaussian-log-forward-v1",
  hmmEncoding,
  {
    profile: "vertex-hmm-forward-result-v1",
    prediction_as_of: ns(componentAsOf),
    feature_order: ["ret"],
    state_labels: ["low-vol", "mid-vol", "high-vol"],
    ...componentTimes,
    numerical_encoding: hmmEncoding,
    filtered: [
      {
        observed_at: ns(day1),
        available_at: ns(day1),
        posterior: ["0.8", "0.15", "0.05"],
        state_index: 0,
        state_label: "low-vol",
      },
      {
        observed_at: ns(day2),
        available_at: ns(day2),
        posterior: ["0.1", "0.1", "0.8"],
        state_index: 2,
        state_label: "high-vol",
      },
    ],
    limitations: ["Synthetic component fixture."],
  },
  "hmm",
  hmmModel
);
const jumpContent = sleeveResult(
  "macro-jump-state-v1",
  "discrete-fixed-centroid-trailing-window-dp-v1",
  jumpEncoding,
  {
    profile: "vertex-jump-state-result-v1",
    assignment_kind: "hard-assignment-not-probability",
    variant: "discrete-fixed-centroid-trailing-window-dp-v1",
    prediction_as_of: ns(componentAsOf),
    feature_order: ["downside"],
    feature_construction:
      "upstream-reviewed-downside-deviation-variant-declared-unknown-v1",
    state_labels: ["bull", "bear"],
    jump_penalty: "0.5",
    window_length: 2,
    window_semantics: "trailing-window-fresh-start-each-step-v1",
    tie_rule: "lowest-state-index-v1",
    ...componentTimes,
    numerical_encoding: jumpEncoding,
    states: [
      {
        observed_at: ns(day1),
        available_at: ns(day1),
        window_start_observed_at: ns(day1),
        window_observations: 1,
        warmup: true,
        state_index: 0,
        state_label: "bull",
        tie: false,
        cost_margin: "0.5",
      },
      {
        observed_at: ns(day2),
        available_at: ns(day2Jump),
        window_start_observed_at: ns(day1),
        window_observations: 2,
        warmup: false,
        state_index: 1,
        state_label: "bear",
        tie: false,
        cost_margin: "0.2",
      },
    ],
    limitations: ["Synthetic component fixture."],
  },
  "jump",
  jumpModel
);

const fixture = async () => {
  const originals = new Map<string, Buffer>();
  const metadata = new Map<string, any>();
  const reviews = new Map<string, any>();
  const evidenceRecords = new Map<string, any>();
  const add = async (
    id: string,
    value: unknown,
    contractName: string,
    capturedAt = at
  ) => {
    const body = bytes(value);
    const sha256 = await hashArtifact(body);
    originals.set(id, body);
    metadata.set(id, {
      artifactId: id,
      scope,
      collectionId: collection,
      objectKey: id,
      artifactSha256: sha256,
      sourceContentSha256: null,
      byteLength: body.length,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName,
      rights,
      lineageArtifactIds: [],
      createdAt: capturedAt,
    });
    return { artifactId: id, sha256 };
  };
  const source = async (
    id: string,
    value: unknown,
    capturedAt: string,
    role: string | null = null,
    derived: string | null = null
  ) => {
    const content = await add(
      `${id}-content`,
      value,
      "PrivateFixture",
      capturedAt
    );
    const evidence = {
      schemaVersion: "1.0.0",
      evidenceId: `${id}-evidence`,
      collectionId: collection,
      snapshotId: snapshot,
      sourceType: derived === null ? "dataset" : "derived-analysis",
      sourceUri: `https://example.test/${id}`,
      sourceIdentity: {
        provider: "synthetic-fixture",
        sourceId: id,
        snapshotId: snapshot,
        contentHash: content.sha256,
      },
      sourceLocator: "Authored synthetic source only",
      attribution: "Synthetic regime-composite proof fixture",
      publishedAt: null,
      capturedAt,
      contentHash: content.sha256,
      claim:
        derived === null
          ? "Synthetic reviewed binding attestation; no measured market claim."
          : "Synthetic component result content; no measured market or fitted model claim.",
      method: derived ?? "Fixed authored fixture",
      limitations: ["Not acquired market data"],
      acceptanceStatus: "unreviewed",
      rightsPolicyId: rights.policyId,
      untrustedContent: true,
    };
    const record = await add(
      `${id}-record`,
      evidence,
      "ResearchEvidence",
      capturedAt
    );
    const review = {
      schemaVersion: "1.0.0",
      reviewId: `${id}-review`,
      ...scope,
      collectionId: collection,
      artifactId: record.artifactId,
      artifactSha256: record.sha256,
      reviewVersion: "1.0.0",
      decision: "accepted",
      purpose: "research",
      actorId: "independent-fixture-reviewer",
      reviewedAt: at,
      expiresAt: expires,
      policyVersion: "1.0.0",
      strategyVersion: "synthetic-source-review",
      supersedesReviewId: null,
      executionAuthorized: false,
    };
    control.AcceptedReviewSchema.parse(review);
    vertex.ResearchEvidenceSchema.parse(evidence);
    reviews.set(evidence.evidenceId, review);
    evidenceRecords.set(evidence.evidenceId, evidence);
    const pin = {
      collectionId: collection,
      evidenceId: evidence.evidenceId,
      artifactId: record.artifactId,
      artifactSha256: record.sha256,
      reviewId: review.reviewId,
      reviewVersion: review.reviewVersion,
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
    };
    return { ...(role === null ? {} : { role }), review: pin, content };
  };
  // Component results are unreviewed publications; the composite consumes them only through current review pins.
  const hmmComponent = await source(
    "hmm-component",
    hmmContent,
    componentCapturedAt,
    null,
    "macro-hmm-forward-v1; binary64 diagonal Gaussian causal forward filter; synthetic fixture; no execution authority."
  );
  const jumpComponent = await source(
    "jump-component",
    jumpContent,
    componentCapturedAt,
    null,
    "macro-jump-state-v1; fixed-centroid trailing-window jump DP hard assignment, not probability; synthetic fixture; no execution authority."
  );
  const envelope = (
    role: string,
    payload: unknown,
    observed_at: string,
    available_at = observed_at
  ) => ({
    profile: "vertex-sleeve-input-v1",
    role,
    collection_id: collection,
    snapshot_id: snapshot,
    observed_at,
    available_at,
    payload,
  });
  const attestation = {
    market_id: market,
    calendar_id: calendar,
    identity_basis: "reviewed-attestation-not-machine-verified-v1",
  };
  const hmmBinding = {
    profile: "vertex-composite-hmm-binding-v1",
    component_evidence_id: hmmComponent.review.evidenceId,
    component_content_sha256: hmmComponent.content.sha256,
    ...attestation,
    model_content_sha256: hmmModel,
    stance_map: {
      "low-vol": "non-defensive",
      "mid-vol": "neutral",
      "high-vol": "defensive",
    },
    posterior_mass_threshold: "0.7",
  };
  const jumpBinding = {
    profile: "vertex-composite-jump-binding-v1",
    component_evidence_id: jumpComponent.review.evidenceId,
    component_content_sha256: jumpComponent.content.sha256,
    ...attestation,
    model_content_sha256: jumpModel,
    stance_map: { bull: "non-defensive", bear: "defensive" },
  };
  // Each binding envelope is observed at the component capturedAt it attests to, reviewed afterwards.
  const inputs = [
    await source(
      "hmm-binding",
      envelope(
        "composite_hmm_binding",
        hmmBinding,
        componentCapturedAt,
        bindingAt
      ),
      bindingAt,
      "composite_hmm_binding"
    ),
    await source(
      "jump-binding",
      envelope(
        "composite_jump_binding",
        jumpBinding,
        componentCapturedAt,
        bindingAt
      ),
      bindingAt,
      "composite_jump_binding"
    ),
  ];
  const dependencies = [hmmComponent, jumpComponent];
  const publication = {
    evidenceId: "composite-derived-evidence",
    collectionId: collection,
    snapshotId: snapshot,
    sourceUri: "https://example.test/composite-result",
    sourceIdentity: {
      provider: "synthetic-fixture",
      sourceId: "composite-result",
      snapshotId: snapshot,
    },
    sourceLocator: "Synthetic connected source proof",
    attribution: "Synthetic fixture",
    publishedAt: null,
    capturedAt: at,
    claim:
      "Implemented-components agreement envelope only; not an average or probability",
    limitations: ["No paper performance reproduction"],
    rightsPolicyId: rights.policyId,
  };
  const configuration = {
    profile: "vertex-sleeve-recipe-v1",
    module_id: "composite-module",
    task_contract: "composite-task",
    collection_id: collection,
    snapshot_id: snapshot,
    as_of: at,
    max_input_age_ns: "259200000000000",
    operation: "macro-regime-composite-envelope-v1",
    parameters: {
      variant: "implemented-components-agreement-envelope-v1",
      market_id: market,
      calendar_id: calendar,
    },
    inputs,
    dependencies,
    publication,
  };
  SleeveResearchRecipeSchema.parse(configuration);
  const recipeRef = await add(
    "composite-recipe",
    configuration,
    "WorkerSleeveRecipe"
  );
  const adapterConfig = {
    profile: "vertex-provider-adapter-config-v1",
    provider_configs: [],
    admission_limits: [],
    endpoint_artifact_ids: [],
    model_artifact_id: null,
    model_use_artifact_id: null,
    calendar_artifact_ids: [],
  };
  const adapterRef = await add(
    "composite-adapters",
    adapterConfig,
    "PrivateFixture"
  );
  const selectionBody = {
    schemaVersion: "1.0.0",
    selectionId: "composite-selection",
    ...scope,
    revision: "1",
    issuedAt: at,
    expiresAt: expires,
    sourcePins: [
      {
        sourceId: "source",
        revision: "1",
        sourceSha256: digest,
        provenanceArtifact: artifact("source-artifact", "PrivateFixture"),
      },
    ],
    modules: [
      {
        moduleId: "composite-module",
        version: "1.0.0",
        codeSha256: digest,
        contractSha256: digest,
        artifact: artifact("composite-module-artifact", "PrivateFixture"),
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
      artifact: artifact(`artifact-${role}`, "PrivateFixture"),
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
        bindingId: "composite-recipe",
        role: "tool-config",
        artifact: artifact(
          recipeRef.artifactId,
          "WorkerSleeveRecipe",
          recipeRef.sha256
        ),
      },
      {
        bindingId: "composite-adapters",
        role: "provider-config",
        artifact: artifact(
          adapterRef.artifactId,
          "PrivateFixture",
          adapterRef.sha256
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
  const selection = {
    ...selectionBody,
    selectionSha256: await hashArtifact(selectionBody),
  };
  const ids = [...inputs, ...dependencies].map((s) => s.review.evidenceId);
  const run = {
    schemaVersion: "1.0.0",
    runId: "composite-run",
    agentRole: "research",
    taskContract: "composite-task",
    allowedTools: ["read-evidence", "write-research-artifact"],
    modelVersion: "no-model-source-fixture",
    inputEvidenceIds: ids,
    outputArtifactIds: [],
    tokenBudget: 1,
    costBudgetUsd: "0",
    status: "queued",
    errors: [],
    approvalRequests: [],
    executionAuthorized: false,
  };
  await add("composite-agent", run, "AgentRun");
  const eventBody = {
    schemaVersion: "1.0.0",
    eventType: "agent.recorded",
    occurredAt: at,
    effectiveAt: at,
    correlationId: "composite-trace",
    causationId: null,
    actorId: "composite-researcher",
    moduleId: "vertex-persistence",
    moduleVersion: "1.0.0",
    environment: "research",
    idempotencyKey: "composite-event",
    payload: run,
  };
  const event = {
    ...eventBody,
    eventId: `event-${await hashArtifact(eventBody)}`,
    receivedAt: at,
  };
  const identity = Object.freeze({
    grantId: "synthetic-dispatch-grant",
    servicePrincipalId: "fixture-service",
    scope,
    expiresAt: expires,
  });
  const outboxLease = {
    eventId: event.eventId,
    scope,
    collectionId: collection,
    eventType: "agent.recorded",
    payload: event,
    leaseOwner: "fixture-worker",
    leaseFence: "1",
    leaseExpiresAt: expires,
  };
  const stagedPayloads: any[] = [];
  const options = {
    db: {
      transaction: async (effect: (tx: unknown) => Promise<unknown>) =>
        effect({}),
    },
    store: {
      findRecordArtifact: async () => metadata.get("composite-agent"),
      findEvidence: async (_p: unknown, _s: unknown, _c: unknown, id: string) =>
        metadata.get(reviews.get(id).artifactId),
      findArtifact: async (_p: unknown, _s: unknown, _c: unknown, id: string) =>
        metadata.get(id),
      getRights: async () => rights,
    },
    workerStore: {
      readResearchProposal: async () => ({
        question:
          "Publish the implemented-components agreement envelope over the review-pinned HMM and jump results only.",
        evidenceIds: ids,
        role: "research",
        proposalOnly: true,
        executionAuthorized: false,
      }),
      prepareOutboxPayload: async (
        caller: unknown,
        claim: unknown,
        value: any
      ) => {
        expect(caller).toBe(identity);
        expect(claim).toBe(outboxLease);
        stagedPayloads.push(value);
        return { artifactId: value.artifactId, artifactSha256: value.sha256 };
      },
    },
    policyRegistry: {
      readHead: async () => ({
        state: "active-read-only",
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
      }),
      materialize: async () => selection,
    },
    readSelectedArtifact: async (
      _tx: unknown,
      _p: unknown,
      _s: unknown,
      pin: any
    ) => originals.get(pin.artifactId),
    objectCapabilities: () => ({
      getBounded: async (key: string) => ({
        status: "ok",
        value: {
          body: originals.get(key),
          metadata: { key, size: originals.get(key)!.length },
        },
      }),
    }),
    clock: { now: () => at },
    consumerServiceId: "fixture-service",
    routes: [
      {
        taskContract: "composite-task",
        kind: "research-run",
        bindingId: "composite-recipe",
        ttlMilliseconds: 60_000,
      },
    ],
  } as unknown as VertexRuntimeRecipesOptions;
  const binding = await createVertexRuntimeRecipes(options).resolveBinding({
    identity,
    lease: outboxLease,
    command: { kind: "queued-agent", event },
    signal: new AbortController().signal,
  } as any);
  expect(binding).not.toBeNull();
  expect(stagedPayloads).toHaveLength(1);
  const payload = JSON.parse(new TextDecoder().decode(stagedPayloads[0].bytes));
  expect(await hashArtifact(payload)).toBe(binding!.payloadSha256);
  const lease = worker.WorkerLeaseSchema.parse({
    schemaVersion: "1.0.0",
    jobId: "composite-job",
    eventId: event.eventId,
    ...scope,
    ...binding,
    leaseId: "composite-lease",
    leaseEpoch: "1",
    leaseExpiresAt: binding!.deadlineAt,
    attempt: 1,
  });
  return {
    originals,
    reviews,
    evidenceRecords,
    inputs,
    dependencies,
    hmmComponent,
    jumpComponent,
    publication,
    selection,
    lease,
    payload,
    configArtifacts: {
      "composite-adapters": originals
        .get("composite-adapters")!
        .toString("base64"),
    },
  };
};

const runWorker = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const interpreter = process.env["VERTEX_COMPOSITE_TEST_PYTHON"];
  if (!interpreter)
    throw new Error(
      "Explicit existing VERTEX_COMPOSITE_TEST_PYTHON is required; no install or fallback"
    );
  const root = process.cwd();
  const child = spawn(
    interpreter,
    [
      "-B",
      resolve(root, "services/research/tests/composite_reviewed_caller.py"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: [
          "services/research",
          "services/control-client",
          "services/market-data",
          "services/execution",
          "services/contracts/python/src",
        ]
          .map((p) => resolve(root, p))
          .join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const stages: any[] = [],
    publications: any[] = [],
    calls: string[] = [],
    reads: string[] = [];
  let done: any = null;
  let failure: unknown = null;
  let stderr = "";
  let chain = Promise.resolve();
  const fence = {
    accountAlias: scope.accountAlias,
    environment: scope.environment,
    jobId: f.lease.jobId,
    leaseId: f.lease.leaseId,
    leaseEpoch: f.lease.leaseEpoch,
  };
  const respond = async (message: any) => {
    if (message.kind === "validate") {
      const schema = schemas[`${message.name}Schema`];
      if (!schema || message.version !== "1.0.0")
        throw new Error("Source schema unavailable");
      return schema.safeParse(message.value).success;
    }
    if (message.kind !== "worker") throw new Error("Unknown fixture message");
    const value = message.value;
    for (const [key, expected] of Object.entries(fence))
      expect(value[key]).toBe(expected);
    calls.push(message.method);
    if (message.method === "admitRun") {
      expect(value.runId).toBe("composite-run");
      expect(value.requestSha256).toBe(f.lease.payloadSha256);
      return {
        status: "accepted",
        jobId: f.lease.jobId,
        state: "running",
        lease: f.lease,
        outputArtifactIds: [],
        reason: null,
        admittedAt: at,
      };
    }
    expect(value.collectionId).toBe(collection);
    if (message.method === "readArtifact") {
      reads.push(value.artifactId);
      const body = f.originals.get(value.artifactId)!;
      const sha256 = await hashArtifact(body);
      return {
        artifact: { artifactId: value.artifactId, artifactSha256: sha256 },
        contentBase64: body.toString("base64"),
        contentSha256: sha256,
        canonicalSha256: sha256,
        contentType: "application/json",
      };
    }
    if (message.method === "acceptedEvidence") {
      const review = f.reviews.get(value.evidenceId);
      expect(review.actorId).not.toBe(f.lease.researchPrincipalId);
      return {
        artifact: {
          artifactId: review.artifactId,
          artifactSha256: review.artifactSha256,
        },
        contentBase64: f.originals.get(review.artifactId)!.toString("base64"),
        evidence: f.evidenceRecords.get(value.evidenceId),
        review,
        rights,
      };
    }
    if (message.method === "currentRights") {
      expect(value.policyId).toBe(rights.policyId);
      expect(rights.allowedUses).toContain(value.use);
      return rights;
    }
    if (message.method === "stageArtifact") {
      const content = Buffer.from(value.contentBase64, "base64");
      expect(await hashArtifact(content)).toBe(value.contentSha256);
      expect(value.rightsPolicyId).toBe(rights.policyId);
      expect(value.rightsVersion).toBe(rights.version);
      expect(value.lineageArtifactIds).toEqual(
        [...f.dependencies, ...f.inputs].map((s) => s.review.artifactId)
      );
      stages.push({ ...value, content: JSON.parse(content.toString()) });
      return {
        status: "accepted",
        artifact: {
          artifactId: value.artifactId,
          artifactSha256: value.contentSha256,
        },
        contentSha256: value.contentSha256,
        canonicalSha256: value.canonicalSha256,
      };
    }
    if (message.method === "publishArtifact") {
      expect(value.contractName).toBe("ResearchEvidence");
      expect(value.reviewPins).toEqual(
        [...f.dependencies, ...f.inputs].map((s) => s.review)
      );
      expect(stages).toHaveLength(2);
      expect(value.artifact).toEqual({
        artifactId: stages[1].artifactId,
        artifactSha256: stages[1].contentSha256,
      });
      expect(value.record).toEqual(stages[1].content);
      publications.push(value);
      return {
        status: "accepted",
        jobId: f.lease.jobId,
        state: "running",
        lease: f.lease,
        outputArtifactIds: [value.record.evidenceId],
        reason: null,
      };
    }
    throw new Error("External fixture method not allowed");
  };
  child.stderr.on("data", (data) => {
    return (stderr = (stderr + data.toString()).slice(-4096));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    return (chain = chain
      .then(async () => {
        const message = JSON.parse(line);
        if (message.kind === "done") {
          done = message;
          return;
        }
        const value = await respond(message);
        child.stdin.write(`${JSON.stringify({ ok: true, value })}\n`);
      })
      .catch((error) => {
        failure = error;
        child.kill("SIGKILL");
      }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  child.stdin.write(
    `${JSON.stringify({
      at,
      selection: f.selection,
      lease: f.lease,
      payload: f.payload,
      configArtifacts: f.configArtifacts,
    })}\n`
  );
  try {
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit, reject) => {
      child.once("error", reject);
      return child.once("close", (code, signal) =>
        resolveExit({ code, signal })
      );
    });
    await chain;
    if (failure) throw failure;
    expect(exit, stderr).toEqual({ code: 0, signal: null });
    expect(done).not.toBeNull();
    return { done, stages, publications, calls, reads };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
};

// Ordinary unit discovery is opt-in; the focused launcher supplies the explicit
// existing interpreter and requires this exact case to pass (never skip).
describe.skipIf(!process.env["VERTEX_COMPOSITE_TEST_PYTHON"])(
  "bounded regime composite reviewed caller source",
  () => {
    return it("connects selected recipe through real handler to unreviewed implemented-components envelope over two review-pinned component contents", async () => {
      const f = await fixture();
      const { done, stages, publications, calls, reads } = await runWorker(f);
      expect(done.outcome).toMatchObject({
        status: "completed",
        outputArtifactIds: [f.publication.evidenceId],
        acceptanceStatus: "unreviewed",
        proposalOnly: true,
        executionAuthorized: false,
        simulatedCapitalEntersNav: false,
      });
      expect(publications).toHaveLength(1);
      expect(stages).toHaveLength(2);
      const result = stages[0].content;
      const record = publications[0].record;
      expect(record).toMatchObject({
        acceptanceStatus: "unreviewed",
        untrustedContent: true,
        contentHash: stages[0].contentSha256,
        sourceIdentity: { contentHash: stages[0].contentSha256 },
      });
      expect(result).toMatchObject({
        operation: "macro-regime-composite-envelope-v1",
        acceptanceStatus: "unreviewed",
        proposalOnly: true,
        executionAuthorized: false,
        simulatedCapitalEntersNav: false,
        projectionDecimalEncoding:
          "exact-decimal-sum-of-published-hmm-posterior-strings-v1",
      });
      // Both component contents were read by their pinned content references (hash-checked in the adapter).
      expect(
        reads.filter((id) => id === f.hmmComponent.content.artifactId).length
      ).toBeGreaterThanOrEqual(2);
      expect(
        reads.filter((id) => id === f.jumpComponent.content.artifactId).length
      ).toBeGreaterThanOrEqual(2);
      const envelope = result.projectedResult;
      expect(Object.keys(envelope).sort()).toEqual([
        "aggregation",
        "calendar_id",
        "components",
        "identity_basis",
        "limitations",
        "market_id",
        "numerical_encoding",
        "pending",
        "prediction_as_of",
        "profile",
        "provenance_only",
        "rows",
        "summary_scope",
        "variant",
      ]);
      expect(envelope).toMatchObject({
        profile: "vertex-regime-composite-envelope-result-v1",
        variant: "implemented-components-agreement-envelope-v1",
        aggregation: "agreement-envelope-replaces-numeric-average-v1",
        prediction_as_of: ns(at),
        market_id: market,
        calendar_id: calendar,
        identity_basis: "reviewed-attestation-not-machine-verified-v1",
        summary_scope: ["HMM", "JM"],
        pending,
        provenance_only: [
          {
            source: "ruuj-hmm-article-x-2074503360208884204",
            role: "methodological-provenance-only-not-a-component-stance-or-signal",
          },
        ],
        numerical_encoding:
          "exact-decimal-sum-of-published-hmm-posterior-strings-v1",
      });
      expect(envelope.components).toEqual([
        {
          component: "HMM",
          operation: "macro-hmm-forward-v1",
          variant: "diagonal-gaussian-log-forward-v1",
          native_kind: "filtered-posterior-vector",
          evidence_id: f.hmmComponent.review.evidenceId,
          content_sha256: f.hmmComponent.content.sha256,
          model_content_sha256: hmmModel,
          component_as_of: ns(componentAsOf),
          captured_at: ns(componentCapturedAt),
          state_labels: ["low-vol", "mid-vol", "high-vol"],
          stance_map: [
            { state_label: "low-vol", stance: "non-defensive" },
            { state_label: "mid-vol", stance: "neutral" },
            { state_label: "high-vol", stance: "defensive" },
          ],
          posterior_mass_threshold: "0.7",
        },
        {
          component: "JM",
          operation: "macro-jump-state-v1",
          variant: "discrete-fixed-centroid-trailing-window-dp-v1",
          native_kind: "hard-assignment-not-probability",
          evidence_id: f.jumpComponent.review.evidenceId,
          content_sha256: f.jumpComponent.content.sha256,
          model_content_sha256: jumpModel,
          component_as_of: ns(componentAsOf),
          captured_at: ns(componentCapturedAt),
          state_labels: ["bull", "bear"],
          stance_map: [
            { state_label: "bull", stance: "non-defensive" },
            { state_label: "bear", stance: "defensive" },
          ],
          posterior_mass_threshold: null,
        },
      ]);
      // Row 1: HMM non-defensive mass .8 >= .7; JM warmup -> incomplete. Row 2: HMM defensive .8, JM bear
      // (not warmup/tie) -> aligned-defensive; eligible at the later JM available_at.
      expect(envelope.rows).toEqual([
        {
          observed_at: ns(day1),
          eligible_at: ns(day1),
          components: [
            {
              component: "HMM",
              status: "available",
              stance: "non-defensive",
              state_label: "low-vol",
              mapped_defensive_posterior_mass: "0.05",
              mapped_non_defensive_posterior_mass: "0.8",
            },
            {
              component: "JM",
              status: "warmup",
              stance: null,
              state_label: "bull",
              mapped_defensive_posterior_mass: null,
              mapped_non_defensive_posterior_mass: null,
            },
          ],
          coverage: "partial",
          pending,
          implemented_components_summary: "incomplete",
        },
        {
          observed_at: ns(day2),
          eligible_at: ns(day2Jump),
          components: [
            {
              component: "HMM",
              status: "available",
              stance: "defensive",
              state_label: "high-vol",
              mapped_defensive_posterior_mass: "0.8",
              mapped_non_defensive_posterior_mass: "0.1",
            },
            {
              component: "JM",
              status: "available",
              stance: "defensive",
              state_label: "bear",
              mapped_defensive_posterior_mass: null,
              mapped_non_defensive_posterior_mass: null,
            },
          ],
          coverage: "partial",
          pending,
          implemented_components_summary: "aligned-defensive",
        },
      ]);
      // No bare composite label, counts, percentages, votes or averages in the published table.
      const table = JSON.stringify(envelope.rows);
      for (const forbidden of [
        /vote/i,
        /average/i,
        /percent/i,
        /%/,
        /count/i,
        /\b\d+ of \d+\b/,
        /"composite_label"/,
        /"aligned"/,
      ])
        expect(table).not.toMatch(forbidden);
      expect(stages[0].canonicalSha256).toBeNull();
      expect(stages[1].canonicalSha256).toBe(stages[1].contentSha256);
      expect(calls.filter((m) => m === "acceptedEvidence")).toHaveLength(16);
      expect(calls.filter((m) => m === "admitRun")).toHaveLength(1);
      expect(calls.filter((m) => m === "stageArtifact")).toHaveLength(2);
      expect(calls.filter((m) => m === "publishArtifact")).toHaveLength(1);
      expect(calls.indexOf("acceptedEvidence")).toBeLessThan(
        calls.indexOf("admitRun")
      );
      expect(calls.lastIndexOf("acceptedEvidence")).toBeGreaterThan(
        calls.indexOf("stageArtifact")
      );
      expect(record.method).toContain(
        "implemented-components (HMM, JM) agreement envelope, not an average, vote or probability"
      );
      expect(
        record.limitations.some((text: string) =>
          text.includes("not independent confirmation")
        )
      ).toBe(true);
      expect(
        record.limitations.some((text: string) => text.includes("uncalibrated"))
      ).toBe(true);
      expect(
        record.limitations.some((text: string) =>
          text.includes("replaces a numeric average")
        )
      ).toBe(true);
      // Strict profile refusal is part of this one connected case, not another campaign.
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          parameters: {
            ...f.payload.recipe.parameters,
            variant: "weighted-average",
          },
        }).success
      ).toBe(false);
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          parameters: {
            ...f.payload.recipe.parameters,
            weights: ["0.5", "0.5"],
          },
        }).success
      ).toBe(false);
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          inputs: f.inputs.slice(0, 1),
        }).success
      ).toBe(false);
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          dependencies: f.dependencies.slice(0, 1),
        }).success
      ).toBe(false);
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          publication: {
            ...f.payload.recipe.publication,
            limitations: Array.from({ length: 58 }, (_, i) => `limit ${i}`),
          },
        }).success
      ).toBe(false);
      return expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          operation: "macro-jump-state-v1",
          parameters: {
            variant: "discrete-fixed-centroid-trailing-window-dp-v1",
          },
        }).success
      ).toBe(false);
    }, 60_000);
  }
);
