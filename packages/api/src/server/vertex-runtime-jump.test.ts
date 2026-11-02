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
// fixed-centroid jump-model owners are real. Source Zod validation is not an installed bundle.
const at = "2026-09-22T12:00:00Z";
const expires = "2026-09-22T13:00:00Z";
const fitAt = "2026-09-19T12:00:00Z";
const modelAt = "2026-09-20T12:00:00Z";
const firstAt = "2026-09-21T12:00:00Z";
const scope = {
  accountAlias: "fictional-jump-account",
  environment: "research" as const,
};
const collection = "jump-fixture";
const snapshot = "jump-snapshot";
const digest = "a".repeat(64);
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
    role: string | null = null
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
      sourceType: "dataset",
      sourceUri: `https://example.test/${id}`,
      sourceIdentity: {
        provider: "synthetic-fixture",
        sourceId: id,
        snapshotId: snapshot,
        contentHash: content.sha256,
      },
      sourceLocator: "Authored synthetic source only",
      attribution: "Synthetic jump-model proof fixture",
      publishedAt: null,
      capturedAt,
      contentHash: content.sha256,
      claim:
        "Synthetic supplied input; no measured market or fitted model claim.",
      method: "Fixed authored fixture",
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
  const modelOrigin = await source(
    "model-origin",
    { synthetic: "fixed-centroids-penalty-window" },
    modelAt
  );
  const scalerOrigin = await source(
    "scaler-origin",
    { synthetic: "fixed-unit-scaler" },
    modelAt
  );
  const firstOrigin = await source(
    "first-origin",
    { synthetic: "first-zero-observation" },
    firstAt
  );
  const secondOrigin = await source(
    "second-origin",
    { synthetic: "second-downside-observation" },
    at
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
  const model = {
    profile: "vertex-jump-fixed-centroid-model-v1",
    feature_order: ["downside"],
    state_labels: ["bull", "bear"],
    centroids: [["0"], ["1"]],
    jump_penalty: "0.5",
    window_length: 3,
    window_semantics: "trailing-window-fresh-start-each-step-v1",
    tie_rule: "lowest-state-index-v1",
    fit_cutoff: fitAt,
    available_at: modelAt,
    source_id: "model-origin",
    source_hash: modelOrigin.content.sha256,
  };
  const scaler = {
    profile: "vertex-jump-scaler-v1",
    feature_order: ["downside"],
    center: ["0"],
    scale: ["1"],
    fit_cutoff: fitAt,
    available_at: modelAt,
    source_id: "scaler-origin",
    source_hash: scalerOrigin.content.sha256,
  };
  const features = {
    profile: "vertex-jump-features-v1",
    feature_order: ["downside"],
    feature_construction:
      "upstream-reviewed-downside-deviation-variant-declared-unknown-v1",
    observations: [
      {
        observed_at: firstAt,
        available_at: firstAt,
        values: ["0"],
        source_id: "first-origin",
        source_hash: firstOrigin.content.sha256,
      },
      {
        observed_at: at,
        available_at: at,
        values: ["0.8"],
        source_id: "second-origin",
        source_hash: secondOrigin.content.sha256,
      },
    ],
  };
  const inputs = [
    await source(
      "features",
      envelope("jump_features", features, at),
      at,
      "jump_features"
    ),
    await source(
      "model",
      envelope("jump_model", model, modelAt),
      modelAt,
      "jump_model"
    ),
    await source(
      "scaler",
      envelope("jump_scaler", scaler, modelAt),
      modelAt,
      "jump_scaler"
    ),
  ];
  const dependencies = [modelOrigin, scalerOrigin, firstOrigin, secondOrigin];
  const publication = {
    evidenceId: "jump-derived-evidence",
    collectionId: collection,
    snapshotId: snapshot,
    sourceUri: "https://example.test/jump-result",
    sourceIdentity: {
      provider: "synthetic-fixture",
      sourceId: "jump-result",
      snapshotId: snapshot,
    },
    sourceLocator: "Synthetic connected source proof",
    attribution: "Synthetic fixture",
    publishedAt: null,
    capturedAt: at,
    claim: "Fixed-centroid hard state assignment only; not a probability",
    limitations: ["No paper performance reproduction"],
    rightsPolicyId: rights.policyId,
  };
  const configuration = {
    profile: "vertex-sleeve-recipe-v1",
    module_id: "jump-module",
    task_contract: "jump-task",
    collection_id: collection,
    snapshot_id: snapshot,
    as_of: at,
    max_input_age_ns: "259200000000000",
    operation: "macro-jump-state-v1",
    parameters: { variant: "discrete-fixed-centroid-trailing-window-dp-v1" },
    inputs,
    dependencies,
    publication,
  };
  SleeveResearchRecipeSchema.parse(configuration);
  const recipeRef = await add(
    "jump-recipe",
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
    "jump-adapters",
    adapterConfig,
    "PrivateFixture"
  );
  const selectionBody = {
    schemaVersion: "1.0.0",
    selectionId: "jump-selection",
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
        moduleId: "jump-module",
        version: "1.0.0",
        codeSha256: digest,
        contractSha256: digest,
        artifact: artifact("jump-module-artifact", "PrivateFixture"),
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
        bindingId: "jump-recipe",
        role: "tool-config",
        artifact: artifact(
          recipeRef.artifactId,
          "WorkerSleeveRecipe",
          recipeRef.sha256
        ),
      },
      {
        bindingId: "jump-adapters",
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
    runId: "jump-run",
    agentRole: "research",
    taskContract: "jump-task",
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
  await add("jump-agent", run, "AgentRun");
  const eventBody = {
    schemaVersion: "1.0.0",
    eventType: "agent.recorded",
    occurredAt: at,
    effectiveAt: at,
    correlationId: "jump-trace",
    causationId: null,
    actorId: "jump-researcher",
    moduleId: "vertex-persistence",
    moduleVersion: "1.0.0",
    environment: "research",
    idempotencyKey: "jump-event",
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
      findRecordArtifact: async () => metadata.get("jump-agent"),
      findEvidence: async (_p: unknown, _s: unknown, _c: unknown, id: string) =>
        metadata.get(reviews.get(id).artifactId),
      findArtifact: async (_p: unknown, _s: unknown, _c: unknown, id: string) =>
        metadata.get(id),
      getRights: async () => rights,
    },
    workerStore: {
      readResearchProposal: async () => ({
        question:
          "Assign states from the supplied fixed jump-model centroids only.",
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
        taskContract: "jump-task",
        kind: "research-run",
        bindingId: "jump-recipe",
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
    jobId: "jump-job",
    eventId: event.eventId,
    ...scope,
    ...binding,
    leaseId: "jump-lease",
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
    publication,
    selection,
    lease,
    payload,
    configArtifacts: {
      "jump-adapters": originals.get("jump-adapters")!.toString("base64"),
    },
  };
};

const runWorker = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const interpreter = process.env["VERTEX_JUMP_TEST_PYTHON"];
  if (!interpreter)
    throw new Error(
      "Explicit existing VERTEX_JUMP_TEST_PYTHON is required; no install or fallback"
    );
  const root = process.cwd();
  const child = spawn(
    interpreter,
    ["-B", resolve(root, "services/research/tests/jump_reviewed_caller.py")],
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
    calls: string[] = [];
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
      expect(value.runId).toBe("jump-run");
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
    return { done, stages, publications, calls };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
};

// Ordinary unit discovery is opt-in; the focused launcher supplies the explicit
// existing interpreter and requires this exact case to pass (never skip).
describe.skipIf(!process.env["VERTEX_JUMP_TEST_PYTHON"])(
  "bounded jump-model reviewed caller source",
  () => {
    return it("connects selected recipe through real handler and reviewed adapters to unreviewed hard-assignment evidence", async () => {
      const f = await fixture();
      const { done, stages, publications, calls } = await runWorker(f);
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
        operation: "macro-jump-state-v1",
        acceptanceStatus: "unreviewed",
        proposalOnly: true,
        executionAuthorized: false,
        simulatedCapitalEntersNav: false,
        projectionDecimalEncoding:
          "decimal-prec-200-half-even-cost-margin-rounded-15-decimal-places-v1",
        projectedResult: {
          profile: "vertex-jump-state-result-v1",
          assignment_kind: "hard-assignment-not-probability",
          variant: "discrete-fixed-centroid-trailing-window-dp-v1",
          feature_order: ["downside"],
          feature_construction:
            "upstream-reviewed-downside-deviation-variant-declared-unknown-v1",
          state_labels: ["bull", "bear"],
          jump_penalty: "0.5",
          window_length: 3,
          window_semantics: "trailing-window-fresh-start-each-step-v1",
          tie_rule: "lowest-state-index-v1",
        },
      });
      // Losses (0,.5) then (.32,.02); lambda .5 keeps bull: V=(.32,.52), margin .2.
      expect(result.projectedResult.states).toEqual([
        {
          observed_at: ns(firstAt),
          available_at: ns(firstAt),
          window_start_observed_at: ns(firstAt),
          window_observations: 1,
          warmup: true,
          state_index: 0,
          state_label: "bull",
          tie: false,
          cost_margin: "0.5",
        },
        {
          observed_at: ns(at),
          available_at: ns(at),
          window_start_observed_at: ns(firstAt),
          window_observations: 2,
          warmup: true,
          state_index: 0,
          state_label: "bull",
          tie: false,
          cost_margin: "0.2",
        },
      ]);
      // Limitations intentionally say "never averaged with HMM posteriors"; check the assignment payload only.
      expect(JSON.stringify(result.projectedResult.states)).not.toContain(
        "posterior"
      );
      expect(Object.keys(result.projectedResult)).not.toContain("posterior");
      expect(stages[0].canonicalSha256).toBeNull();
      expect(stages[1].canonicalSha256).toBe(stages[1].contentSha256);
      expect(calls.filter((m) => m === "acceptedEvidence")).toHaveLength(28);
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
        "fixed-centroid trailing-window jump DP hard assignment, not probability"
      );
      expect(
        record.limitations.some((text: string) =>
          text.includes("not paper reproduction")
        )
      ).toBe(true);
      expect(
        record.limitations.some((text: string) =>
          text.includes("not a calibrated probability")
        )
      ).toBe(true);
      // Strict profile refusal is part of this one connected case, not another campaign.
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          parameters: { variant: "continuous-jump" },
        }).success
      ).toBe(false);
      expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          inputs: f.inputs.slice(0, 2),
        }).success
      ).toBe(false);
      return expect(
        SleeveResearchRecipeSchema.safeParse({
          ...f.payload.recipe,
          operation: "macro-hmm-forward-v1",
          parameters: { variant: "diagonal-gaussian-log-forward-v1" },
        }).success
      ).toBe(false);
    }, 60_000);
  }
);
