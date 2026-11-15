import { describe, expect, it, vi } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  createVertexRuntimeRecipes,
  type VertexRuntimeRecipesOptions,
} from "./vertex-runtime-recipes.ts";
import {
  buildVertexRuntimeRecipe,
  type VertexRuntimeRecipeInputs,
} from "./vertex-runtime-recipe-build.ts";
import {
  HostBacktestRecipeSchema,
  KnowledgeRecipeSchema,
} from "./vertex-runtime-recipe-profiles.ts";

const now = "2026-09-22T12:00:00.000000001Z";
const expires = "2026-09-22T13:00:00Z";
const digest = "a".repeat(64);
const scope = {
  accountAlias: "fictional-test-account",
  environment: "research" as const,
};
const artifact = (
  artifactId: string,
  contractName = "PrivateFixture",
  artifactSha256 = digest
) => ({ artifactId, artifactSha256, contractName, schemaVersion: "1.0.0" });
const policy = (role: string) => ({
  role,
  policyId: `policy-${role}`,
  version: "1.0.0",
  artifact: artifact(`artifact-${role}`),
});
const groups = [
  "broker-execution",
  "quantvps-transport",
  "options-analytics",
  "fundamentals-news",
  "historical-quant-data",
  "models-agent-tools",
  "storage-queue-audit",
];
const module = {
  moduleId: "test-module",
  version: "1.0.0",
  codeSha256: digest,
  contractSha256: digest,
  artifact: artifact("module-artifact"),
  enabled: true,
  capabilities: ["research"],
  requiredComponents: ["host"],
};
const seal = async (value: Record<string, unknown>) => ({
  ...value,
  selectionSha256: await hashArtifact(value),
});
const base = (environment = "research") => ({
  schemaVersion: "1.0.0",
  selectionId: "test-selection",
  accountAlias: scope.accountAlias,
  environment,
  revision: "1",
  issuedAt: now,
  expiresAt: expires,
  sourcePins: [
    {
      sourceId: "source",
      revision: "1",
      sourceSha256: digest,
      provenanceArtifact: artifact("source-artifact"),
    },
  ],
  modules: [module],
  policies: [
    policy("licensing-rights"),
    policy("provider-budget"),
    policy("tool"),
    policy("risk"),
    policy("capital"),
    policy("cost"),
    policy("calendar"),
  ],
  configuration: groups.map((group) => ({
    group,
    state: "unknown",
    referenceIds: [],
    reasonCodes: [],
    provenanceSourceIds: ["source"],
  })),
  references: [],
  providerCapabilities: [],
  artifacts: [],
  review: null,
  research: null,
  simulation: null,
  readOnly: true,
  nativeRearmAllowed: false,
  cloudCapitalAuthority: false,
});
const endpoint = (environment = "research") => ({
  referenceId: "endpoint",
  referenceSha256: digest,
  logicalName: "fixture.endpoint",
  kind: "nonsecret-reference",
  ownerService: "test-service",
  accountAlias: scope.accountAlias,
  environment,
  permissions: ["read"],
  entitlementPolicyId: "policy-licensing-rights",
  rotationOwner: "test-owner",
  requiredWhen: [],
  legacyAliases: [],
  verificationState: "unknown",
  lastVerifiedAt: null,
  expiresAt: expires,
  exposure: "server-only",
});
const fact = (
  providerId: string,
  operation: string,
  modelVersion: string | null = null
) => ({
  capabilityId: "capability",
  providerId,
  endpointReferenceId: "endpoint",
  endpointSha256: digest,
  modelVersion,
  operation,
  state: "ready",
  rightsPolicyId: "policy-licensing-rights",
  rightsPolicyVersion: "1.0.0",
  observedAt: now,
  expiresAt: expires,
  evidenceArtifact: artifact("capability-evidence"),
});
const evidence = {
  schemaVersion: "1.0.0",
  evidenceId: "evidence",
  collectionId: "ssrn",
  snapshotId: "snapshot",
  sourceType: "paper",
  sourceUri: "https://example.test/evidence",
  sourceIdentity: {
    provider: "fixture",
    sourceId: "source",
    snapshotId: "source-snapshot",
    contentHash: digest,
  },
  sourceLocator: "page 1",
  attribution: "Fictional source",
  publishedAt: null,
  capturedAt: now,
  contentHash: digest,
  claim: "Fixture claim",
  method: "Fixture method",
  limitations: [],
  acceptanceStatus: "unreviewed",
  rightsPolicyId: "policy-licensing-rights",
  untrustedContent: true,
};
const run = {
  schemaVersion: "1.0.0",
  runId: "test-run",
  agentRole: "research",
  taskContract: "test-task",
  allowedTools: ["read-evidence"],
  modelVersion: "test-model",
  inputEvidenceIds: ["evidence"],
  outputArtifactIds: [],
  tokenBudget: 100,
  costBudgetUsd: "1",
  status: "queued",
  errors: [],
  approvalRequests: [],
  executionAuthorized: false,
};
const eventFor = async (value = run) => {
  const body = {
    schemaVersion: "1.0.0",
    eventType: "agent.recorded",
    occurredAt: now,
    effectiveAt: now,
    correlationId: "test-trace",
    causationId: null,
    actorId: "test-actor",
    moduleId: "vertex-persistence",
    moduleVersion: "1.0.0",
    environment: "research",
    idempotencyKey: "test-event",
    payload: value,
  };
  return {
    ...body,
    eventId: `event-${await hashArtifact(body)}`,
    receivedAt: now,
  };
};
const researchTemplate = () => ({
  profile: "vertex-research-run-v1",
  thread_id: null,
  request: {
    run_id: "overridden-run",
    trace_id: "overridden-trace",
    actor_id: "overridden-actor",
    task_contract: "overridden-task",
    task: "Not an admitted question",
    model_version: "overridden-model",
    scopes: [{ collection_id: "unselected", snapshot_id: "unselected" }],
    budget: {
      tokens: 9999,
      usd: "999",
      attempt_tokens: 20,
      attempt_usd: "0.1",
      max_attempts: 3,
      max_retries: 0,
      max_tool_calls: 1,
    },
    reference_ns: "0",
    deadline_ns: "0",
    per_attempt_timeout_ns: "1000000000",
    account_alias: "wrong-account",
    environment: "research",
    allowed_tools: ["request-backtest"],
    phases: ["analyst", "counterpoint", "synthesis"],
    max_evidence: 4,
    max_excerpt_chars: 1000,
    max_evidence_age_ns: "1000000000",
  },
});
const researchInput = async (): Promise<VertexRuntimeRecipeInputs> => {
  const configuration = researchTemplate();
  const event = await eventFor();
  const selection = await seal({
    ...base(),
    references: [endpoint()],
    providerCapabilities: [fact("test-provider", "advisory", "test-model")],
    artifacts: [
      {
        bindingId: "research-recipe",
        role: "tool-config",
        artifact: artifact(
          "recipe",
          "PrivateRecipe",
          await hashArtifact(configuration)
        ),
      },
    ],
    research: {
      moduleId: module.moduleId,
      taskContract: "test-task",
      modelVersion: "test-model",
      modelCapabilityId: "capability",
      tokenBudget: 100,
      costBudgetUsd: "1",
      rightsPolicyId: "policy-licensing-rights",
      allowedTools: ["read-evidence"],
      requiredComponents: ["host"],
    },
  });
  return {
    command: { kind: "queued-agent", event },
    scope,
    eventId: event.eventId,
    collectionId: "ssrn",
    selection,
    now,
    route: {
      taskContract: "test-task",
      kind: "research-run",
      bindingId: "research-recipe",
      ttlMilliseconds: 10_000,
    },
    configuration,
    proposal: {
      question: "Explain the selected evidence limitations.",
      evidenceIds: ["evidence"],
      role: "research",
      proposalOnly: true,
      executionAuthorized: false,
    },
    evidence: [evidence],
  };
};

// These fixtures exercise recipe/envelope validation only. Their explicitly
// synthetic originals are not reviewed native configurations or accepted proof.
const syntheticModel = () => ({
  strategy_digest: digest,
  strategy_code_digest: digest,
  assumptions_digest: digest,
  engine_digest: digest,
  review_digest: digest,
  instrument_id: "ibkr-conid-1.RESEARCH",
  quantity: "1",
  initial_cash: "100",
  commission_per_fill: "0.01",
  slippage_per_unit: "0",
  enter_not_before_ns: "1",
  exit_not_before_ns: "2",
  evidence_template_bytes: btoa(
    canonicalArtifactJson({ synthetic: true, purpose: "recipe-boundary-only" })
  ),
  native_configuration_bytes: btoa(
    canonicalArtifactJson({ synthetic: true, purpose: "not-native-execution" })
  ),
});
const syntheticReviewPin = () => ({
  collectionId: "ssrn",
  evidenceId: "synthetic-capture-evidence",
  artifactId: "synthetic-evidence-original",
  artifactSha256: digest,
  reviewId: "synthetic-review-not-authority",
  reviewVersion: "1.0.0",
  rightsPolicyId: "policy-licensing-rights",
  rightsVersion: "1.0.0",
});
const historicalRecipe = (collectionId: string | null = null) => {
  const pin = syntheticReviewPin();
  return {
    format: "vertex-host-backtest-recipe-v3",
    strategy: { artifactId: "synthetic-strategy", sha256: digest },
    run: { artifactId: "synthetic-planned-run", sha256: digest },
    datasets: [
      {
        manifest: { artifactId: "synthetic-manifest", sha256: digest },
        content: { artifactId: "synthetic-content", sha256: digest },
        contentFormat: "vertex-ibkr-historical-bars-v1",
        declaredEvents: 1,
        collectionId,
        reviewPins: [pin],
      },
    ],
    evidence: [{ artifactId: pin.artifactId, sha256: pin.artifactSha256 }],
    reviewPins: [pin],
    lineage: {
      format: "vertex-historical-bar-lineage-inputs-v1",
      researchClass:
        "limited-retrospective-adjusted-bar-simulation-nonpromotion",
      promotionEligible: false,
    },
    budget: { network_allowed: false, execution_allowed: false },
    descriptor: {
      supported_formats: ["vertex-ibkr-historical-bars-v1"],
      simulation_only: true,
    },
    model: syntheticModel(),
    plannedAt: "2026-09-22T12:00:00Z",
    publication: {
      actorId: "test-actor",
      collectionId: "ssrn",
      snapshotId: "snapshot",
      rightsPolicyId: "policy-licensing-rights",
      rightsVersion: "1.0.0",
    },
  };
};
const backtestInput = async (configuration: Record<string, unknown>) => {
  const selectedDigest = await hashArtifact(configuration);
  const selection = await seal({
    ...base(),
    artifacts: [
      {
        bindingId: "backtest-recipe",
        role: "simulation-engine",
        artifact: artifact(
          "backtest-recipe",
          "HostBacktestRecipe",
          selectedDigest
        ),
      },
    ],
  });
  const event = await eventFor();
  return {
    command: { kind: "queued-agent" as const, event },
    scope,
    eventId: event.eventId,
    collectionId: "ssrn",
    selection,
    now,
    configuration,
    route: {
      taskContract: "test-task",
      kind: "backtest" as const,
      bindingId: "backtest-recipe",
      ttlMilliseconds: 1000,
    },
  };
};

describe("runtime native recipes (source-only regressions)", () => {
  it("constructs research from admitted identity/question/budget, never template authority", async () => {
    const input = await researchInput();
    const prepared = await buildVertexRuntimeRecipe(input);
    const request = prepared.payload["request"] as Record<string, unknown>;
    expect(request).toMatchObject({
      run_id: "test-run",
      actor_id: "test-actor",
      account_alias: scope.accountAlias,
      task: "Explain the selected evidence limitations.",
      scopes: [{ collection_id: "ssrn", snapshot_id: "snapshot" }],
      model_version: "test-model",
      allowed_tools: ["read-evidence"],
      budget: { tokens: 100, usd: "1" },
    });
    expect(typeof request["reference_ns"]).toBe("string");
    expect(prepared.binding.deadlineAt).toBe("2026-09-22T12:00:10.000000001Z");
    expect(prepared.binding.payloadSha256).toBe(
      await hashArtifact(
        new TextEncoder().encode(canonicalArtifactJson(prepared.payload))
      )
    );
    expect(prepared.rightsVersion).toBe("1.0.0");
    return expect(await buildVertexRuntimeRecipe(input)).toEqual(prepared);
  });
  it("fails missing inputs, tampered selected template, stale policy and widened attempt budget", async () => {
    const input = await researchInput();
    await expect(
      buildVertexRuntimeRecipe({ ...input, configuration: undefined })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      buildVertexRuntimeRecipe({
        ...input,
        configuration: { ...researchTemplate(), thread_id: "changed" },
      })
    ).rejects.toMatchObject({ code: "integrity" });
    await expect(
      buildVertexRuntimeRecipe({ ...input, now: expires })
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      buildVertexRuntimeRecipe({
        ...input,
        scope: { ...scope, accountAlias: "other" },
      })
    ).rejects.toMatchObject({ code: "denied" });
    const configuration = researchTemplate();
    configuration.request.budget.attempt_tokens = 101;
    const { selectionSha256: omitted, ...body } = input.selection as Record<
      string,
      unknown
    >;
    const selection = await seal({
      ...body,
      artifacts: [
        {
          bindingId: "research-recipe",
          role: "tool-config",
          artifact: artifact(
            "recipe",
            "PrivateRecipe",
            await hashArtifact(configuration)
          ),
        },
      ],
    });
    return await expect(
      buildVertexRuntimeRecipe({ ...input, selection, configuration })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("builds actual knowledge profile and preserves collection/rights bindings", async () => {
    const configuration = {
      profile: "vertex-knowledge-import-v1",
      collection_id: "nicholas-crown",
      snapshot_id: "selected-snapshot",
      expected_snapshot_id: null,
      rights_policy_id: "policy-licensing-rights",
      captured_at: now,
      input: { bundle: { artifactId: "selected-bundle", sha256: digest } },
    };
    const event = await eventFor({ ...run, agentRole: "knowledge-import" });
    const selection = await seal({
      ...base(),
      artifacts: [
        {
          bindingId: "knowledge-recipe",
          role: "tool-config",
          artifact: artifact(
            "recipe",
            "PrivateRecipe",
            await hashArtifact(configuration)
          ),
        },
      ],
    });
    const input = {
      command: { kind: "queued-agent" as const, event },
      scope,
      eventId: event.eventId,
      collectionId: "nicholas-crown",
      selection,
      now,
      configuration,
      route: {
        taskContract: "test-task",
        kind: "knowledge-import" as const,
        bindingId: "knowledge-recipe",
        ttlMilliseconds: 1000,
      },
    };
    expect((await buildVertexRuntimeRecipe(input)).payload).toEqual(
      configuration
    );
    return await expect(
      buildVertexRuntimeRecipe({ ...input, collectionId: "ssrn" })
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("accepts jay-medrow Instagram transcript imports like define-your-risk", () => {
    const configuration = {
      profile: "vertex-knowledge-import-v1",
      collection_id: "jay-medrow",
      snapshot_id: "selected-snapshot",
      expected_snapshot_id: null,
      rights_policy_id: "policy-licensing-rights",
      captured_at: now,
      input: {
        manifest: { artifactId: "jay-medrow-manifest", sha256: digest },
        transcripts: {
          "ig-ABC123": { artifactId: "jay-medrow-ig-ABC123", sha256: digest },
        },
      },
    };
    expect(KnowledgeRecipeSchema.safeParse(configuration).success).toBe(true);
    expect(
      KnowledgeRecipeSchema.safeParse({
        ...configuration,
        input: { bundle: { artifactId: "selected-bundle", sha256: digest } },
      }).success
    ).toBe(false);
    return expect(
      KnowledgeRecipeSchema.safeParse({
        ...configuration,
        collection_id: "jay_medrow",
      }).success
    ).toBe(false);
  });
  it("builds explicit supported provider SourceContext without defaulting any fields", async () => {
    const configuration = {
      profile: "vertex-dataset-ingest-v1",
      provider: "financialdatasets",
      operation: "equity-bars",
      request: { symbol: "FICTIONAL", interval: "1d" },
      sourceContext: {
        instrument_id: "fictional-instrument",
        currency: "USD",
        calendar: "selected-calendar",
        provider_timezone: "America/New_York",
        snapshot_id: "snapshot",
        source_id: "source",
        as_of_at: now,
        vintage_id: null,
        maximum_age_ms: 1000,
        price_unit: "USD",
        quantity_unit: "shares",
        adjustment_method: "unadjusted",
        data_kind: "real",
        synthetic_reason: null,
      },
      publication: {
        dataset_id: "dataset",
        storage_ref: "fixture-reference",
        start_at: now,
        end_at: expires,
        as_of_at: now,
        retention_policy: "retention",
        require_point_in_time: true,
      },
    };
    const event = await eventFor();
    const selection = await seal({
      ...base(),
      references: [endpoint()],
      providerCapabilities: [fact("financialdatasets", "equity-bars")],
      artifacts: [
        {
          bindingId: "dataset-recipe",
          role: "tool-config",
          artifact: artifact(
            "recipe",
            "PrivateRecipe",
            await hashArtifact(configuration)
          ),
        },
      ],
    });
    const prepared = await buildVertexRuntimeRecipe({
      command: { kind: "queued-agent", event },
      scope,
      eventId: event.eventId,
      collectionId: null,
      selection,
      now,
      configuration,
      route: {
        taskContract: "test-task",
        kind: "dataset-ingest",
        bindingId: "dataset-recipe",
        ttlMilliseconds: 1000,
      },
    });
    expect(prepared.payload).toEqual(configuration);
    return expect(prepared.binding.kind).toBe("dataset-ingest");
  });
  it("constructs independent public bootstrap pins without adding capital or rearm flags", async () => {
    const paperScope = { ...scope, environment: "paper" as const };
    const selection = await seal({
      ...base("paper"),
      simulation: {
        moduleId: module.moduleId,
        simulatorId: "simulator",
        maximumLoss: "1",
        maximumNotional: "1",
        ttlMilliseconds: 1000,
        requiredComponents: ["host"],
        capitalAuthority: "native-owner-only",
      },
    });
    const payload = {
      format: "vertex-native-bootstrap-job-v1",
      journalIdentity: "journal",
      simulatorId: "simulator",
      streamId: "stream",
      selectionId: "test-selection",
      selectionSha256: selection.selectionSha256,
      mode: "initialize",
    };
    const bootstrap = {
      schemaVersion: "1.0.0",
      ...paperScope,
      researchPrincipalId: "test-actor",
      payloadArtifactId: "explicit-bootstrap-payload",
      payloadSha256: await hashArtifact(payload),
      policySelectionId: "test-selection",
      policySelectionSha256: selection.selectionSha256,
      rightsPolicyId: "policy-licensing-rights",
      rightsVersion: "1.0.0",
      issuedAt: now,
      deadlineAt: expires,
      idempotencyKey: "bootstrap",
      payload,
    };
    const eventId = `bootstrap-${await hashArtifact(bootstrap)}`;
    const prepared = await buildVertexRuntimeRecipe({
      command: { kind: "native-bootstrap", bootstrap },
      scope: paperScope,
      eventId,
      collectionId: null,
      selection,
      now,
    });
    expect(prepared.payload).toEqual(payload);
    expect(prepared.binding).toMatchObject({
      kind: "native-bootstrap",
      payloadArtifactId: "explicit-bootstrap-payload",
      payloadSha256: bootstrap.payloadSha256,
    });
    return expect(Object.keys(prepared.payload)).not.toContain("capital");
  });
  it("constructs backtest envelopes only from an exact selected Host recipe", async () => {
    const ref = { artifactId: "input-artifact", sha256: digest };
    const configuration = {
      format: "vertex-host-backtest-recipe-v2",
      strategy: ref,
      run: ref,
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
      model: syntheticModel(),
      plannedAt: now,
      publication: {
        actorId: "test-actor",
        collectionId: "ssrn",
        snapshotId: "snapshot",
        rightsPolicyId: "policy-licensing-rights",
        rightsVersion: "1.0.0",
      },
    };
    const selectedDigest = await hashArtifact(configuration);
    const selection = await seal({
      ...base(),
      artifacts: [
        {
          bindingId: "backtest-recipe",
          role: "simulation-engine",
          artifact: artifact(
            "backtest-recipe",
            "HostBacktestRecipe",
            selectedDigest
          ),
        },
      ],
    });
    const event = await eventFor();
    const input = {
      command: { kind: "queued-agent" as const, event },
      scope,
      eventId: event.eventId,
      collectionId: "ssrn",
      selection,
      now,
      configuration,
      route: {
        taskContract: "test-task",
        kind: "backtest" as const,
        bindingId: "backtest-recipe",
        ttlMilliseconds: 1000,
      },
    };
    expect((await buildVertexRuntimeRecipe(input)).payload).toEqual({
      format: "vertex-backtest-job-v1",
      recipeArtifactId: "backtest-recipe",
      recipeSha256: selectedDigest,
    });
    return await expect(
      buildVertexRuntimeRecipe({ ...input, collectionId: "other-collection" })
    ).rejects.toMatchObject({ code: "denied" });
  });
  it.each([null, "ssrn"])(
    "preserves the explicit historical dataset scope %s and exact synthetic review pins",
    async (collectionId) => {
      const configuration = historicalRecipe(collectionId);
      expect(HostBacktestRecipeSchema.parse(configuration)).toEqual(
        configuration
      );
      const input = await backtestInput(configuration);
      expect((await buildVertexRuntimeRecipe(input)).payload).toEqual({
        format: "vertex-backtest-job-v1",
        recipeArtifactId: "backtest-recipe",
        recipeSha256: await hashArtifact(configuration),
      });
      const changed = structuredClone(configuration);
      changed.datasets[0]!.collectionId = collectionId === null ? "ssrn" : null;
      await expect(
        buildVertexRuntimeRecipe({ ...input, configuration: changed })
      ).rejects.toMatchObject({ code: "integrity" });
      return await expect(
        buildVertexRuntimeRecipe({ ...input, collectionId: "other-collection" })
      ).rejects.toMatchObject({ code: "denied" });
    }
  );
  it("rejects wildcard formats, implicit scope, missing scientific fields and malformed original bytes", () => {
    const original = historicalRecipe();
    const variants = [
      { ...original, format: "vertex-host-backtest-recipe-v*" },
      {
        ...original,
        datasets: [{ ...original.datasets[0], contentFormat: "*" }],
      },
      {
        ...original,
        datasets: [{ ...original.datasets[0], collectionId: undefined }],
      },
      {
        ...original,
        datasets: [{ ...original.datasets[0], declaredEvents: 0 }],
      },
      { ...original, datasets: [...original.datasets, ...original.datasets] },
      { ...original, model: {} },
      {
        ...original,
        model: { ...original.model, assumptions_digest: undefined },
      },
      { ...original, model: { ...original.model, quantity: 1 } },
      {
        ...original,
        model: {
          ...original.model,
          exit_not_before_ns: original.model.enter_not_before_ns,
        },
      },
      {
        ...original,
        model: { ...original.model, native_configuration_bytes: "e30" },
      },
      { ...original, plannedAt: now },
    ];
    for (const variant of variants)
      expect(HostBacktestRecipeSchema.safeParse(variant).success).toBe(false);
  });
  it("rejects absent, duplicate, stale-scope and nonmember historical review pins", () => {
    const original = historicalRecipe();
    const pin = original.reviewPins[0]!;
    const variants = [
      { ...original, reviewPins: [] },
      { ...original, evidence: [] },
      {
        ...original,
        reviewPins: [pin, pin],
        evidence: [...original.evidence, ...original.evidence],
      },
      { ...original, reviewPins: [{ ...pin, artifactSha256: "b".repeat(64) }] },
      {
        ...original,
        reviewPins: [{ ...pin, collectionId: "other-collection" }],
      },
      { ...original, reviewPins: [{ ...pin, rightsVersion: "2.0.0" }] },
      { ...original, datasets: [{ ...original.datasets[0], reviewPins: [] }] },
      {
        ...original,
        datasets: [
          {
            ...original.datasets[0],
            reviewPins: [{ ...pin, reviewId: "unselected-review" }],
          },
        ],
      },
    ];
    for (const variant of variants)
      expect(HostBacktestRecipeSchema.safeParse(variant).success).toBe(false);
  });
  it("constructs one paper leg from the admission and exact selected strategy without capital", async () => {
    const paperScope = { ...scope, environment: "paper" as const };
    const strategyArtifact = {
      artifactId: "strategy-version",
      artifactSha256: digest,
    };
    const selection = await seal({
      ...base("paper"),
      artifacts: [
        {
          bindingId: "strategy",
          role: "simulation-engine",
          artifact: artifact(strategyArtifact.artifactId, "StrategySpec"),
        },
      ],
      simulation: {
        moduleId: module.moduleId,
        simulatorId: "simulator",
        maximumLoss: "1",
        maximumNotional: "1",
        ttlMilliseconds: 1000,
        requiredComponents: ["host"],
        capitalAuthority: "native-owner-only",
      },
    });
    const admission = {
      schemaVersion: "1.0.0",
      admissionId: "admission",
      admissionKind: "PAPER-SIMULATION",
      ...paperScope,
      simulatorId: "simulator",
      streamId: "stream",
      ownerEpoch: "1",
      intentId: "intent",
      intentSha256: digest,
      reviewedArtifactSha256: digest,
      reviewId: "review",
      reviewVersion: "1.0.0",
      actorId: "test-actor",
      policyVersion: "1.0.0",
      strategyVersion: strategyArtifact.artifactId,
      portfolioSnapshotId: "snapshot",
      portfolioSequence: "1",
      maximumLoss: "1",
      maximumNotional: "1",
      admittedAt: now,
      expiresAt: expires,
      idempotencyKey: "simulation-request",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
      executionAuthorized: false,
    };
    const prepared = await buildVertexRuntimeRecipe({
      command: { kind: "paper-admission", admission },
      scope: paperScope,
      eventId: `simulation-${await hashArtifact(admission)}`,
      collectionId: null,
      selection,
      now,
      paper: {
        intentArtifactId: "intent-artifact",
        intentSha256: digest,
        strategyArtifact,
      },
    });
    expect(prepared.payload).toEqual({
      format: "vertex-paper-job-v1",
      batchIdempotencyKey: admission.idempotencyKey,
      legs: [
        {
          intentArtifactId: "intent-artifact",
          intentSha256: digest,
          admissionId: "admission",
        },
      ],
      strategyArtifact,
    });
    return expect(prepared.binding.kind).toBe("paper-simulation");
  });
  it("stages canonical bytes with the original authenticated identity and exact rights", async () => {
    const input = await researchInput();
    if (input.command.kind !== "queued-agent")
      throw new Error("Fixture command");
    const encoder = new TextEncoder();
    const agentBytes = encoder.encode(canonicalArtifactJson(run));
    const rights = {
      policyId: "policy-licensing-rights",
      version: "1.0.0",
      status: "granted",
      allowedUses: ["read", "store"],
      checkedAt: now,
      expiresAt: expires,
      retentionUntil: null,
    };
    const metadata = {
      artifactId: "agent-artifact",
      scope,
      collectionId: "ssrn",
      objectKey: "fixture-key",
      artifactSha256: await hashArtifact(run),
      sourceContentSha256: null,
      byteLength: agentBytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      contractName: "AgentRun",
      rights,
      lineageArtifactIds: [],
      createdAt: now,
    };
    const evidenceBytes = encoder.encode(canonicalArtifactJson(evidence));
    const evidenceMetadata = {
      ...metadata,
      artifactId: "evidence-artifact",
      objectKey: "evidence-key",
      contractName: "ResearchEvidence",
      artifactSha256: await hashArtifact(evidence),
      byteLength: evidenceBytes.byteLength,
    };
    const identity = Object.freeze({
      grantId: "grant",
      servicePrincipalId: "service",
      scope,
      expiresAt: expires,
    });
    const lease = {
      eventId: input.eventId,
      scope,
      collectionId: "ssrn",
      eventType: "agent.recorded",
      payload: input.command.event,
      leaseOwner: "worker",
      leaseFence: "1",
      leaseExpiresAt: expires,
    };
    const prepareOutboxPayload = vi.fn(
      async (
        _identity: unknown,
        _lease: unknown,
        value: { artifactId: string; sha256: string; bytes: Uint8Array }
      ) => ({ artifactId: value.artifactId, artifactSha256: value.sha256 })
    );
    const options = {
      db: {
        transaction: async (effect: (tx: unknown) => Promise<unknown>) =>
          effect({}),
      },
      store: {
        findRecordArtifact: async () => metadata,
        findEvidence: async () => evidenceMetadata,
        findArtifact: async (
          _principal: unknown,
          _scope: unknown,
          _collection: unknown,
          artifactId: string
        ) =>
          artifactId === evidenceMetadata.artifactId
            ? evidenceMetadata
            : metadata,
        getRights: async () => rights,
      },
      workerStore: {
        prepareOutboxPayload,
        readResearchProposal: async () => input.proposal,
      },
      policyRegistry: {
        readHead: async () => ({
          state: "active-read-only",
          selectionId: "test-selection",
          selectionSha256: (input.selection as { selectionSha256: string })
            .selectionSha256,
        }),
        materialize: async () => input.selection,
      },
      readSelectedArtifact: async () =>
        encoder.encode(canonicalArtifactJson(input.configuration)),
      objectCapabilities: () => ({
        getBounded: async (key: string) => ({
          status: "ok",
          value: {
            body:
              key === evidenceMetadata.objectKey ? evidenceBytes : agentBytes,
            metadata: {
              key,
              size:
                key === evidenceMetadata.objectKey
                  ? evidenceBytes.byteLength
                  : agentBytes.byteLength,
            },
          },
        }),
      }),
      clock: { now: () => now },
      consumerServiceId: "test-service",
      routes: [input.route],
    } as unknown as VertexRuntimeRecipesOptions;
    const recipes = createVertexRuntimeRecipes(options);
    const prepared = await recipes.resolveBinding({
      identity,
      lease,
      command: input.command,
      signal: new AbortController().signal,
    });
    expect(prepareOutboxPayload).toHaveBeenCalledTimes(1);
    expect(prepareOutboxPayload.mock.calls[0]![0]).toBe(identity);
    expect(prepareOutboxPayload.mock.calls[0]![1]).toBe(lease);
    expect(prepareOutboxPayload.mock.calls[0]![2]).toMatchObject({
      artifactId: prepared!.payloadArtifactId,
      sha256: prepared!.payloadSha256,
      rightsPolicyId: rights.policyId,
      rightsVersion: rights.version,
    });
    return expect(
      await hashArtifact(prepareOutboxPayload.mock.calls[0]![2].bytes)
    ).toBe(prepared!.payloadSha256);
  });
  return it("constructs no effects eagerly and stops cancelled dispatch before registry/storage IO", async () => {
    const readHead = vi.fn();
    const options = {
      routes: [],
      policyRegistry: { readHead },
    } as unknown as VertexRuntimeRecipesOptions;
    const recipes = createVertexRuntimeRecipes(options);
    expect(readHead).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    expect(
      await recipes.resolveBinding({ signal: controller.signal } as Parameters<
        typeof recipes.resolveBinding
      >[0])
    ).toBeNull();
    return expect(readHead).not.toHaveBeenCalled();
  });
});
