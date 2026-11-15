import { z } from "zod";
import {
  IdentifierSchema as id,
  DigestSchema,
  NonnegativeDecimalSchema,
  TimestampSchema,
} from "../contracts/vertex.ts";
import { WorkerReviewPinSchema } from "../contracts/vertex-worker.ts";
import { WorkerExperimentDependencyPinSchema } from "../contracts/vertex-worker-experiment.ts";
import { PolicyArtifactPinSchema } from "../contracts/vertex-policy.ts";
import {
  VertexResearchChatInputPolicyV1Schema,
  VertexResearchChatInputBudgetsSchema,
} from "../contracts/vertex-research-chat-execution.ts";
import { VertexResearchChatDebatePlanV1Schema } from "../contracts/vertex-research-chat-debate.ts";
import { VertexResearchChatNativeEvidencePlanProtocolSchema } from "../contracts/vertex-research-chat-native-evidence.ts";
import { present } from "./present.ts";

// Private Host/ProviderAdapters payloads, NOT additional public wire contracts.
// Exact inventory: research/adapters/handlers.py, agents/types.py,
// market-data/vertex_market_data/normalization.py and host/research_engine.py.
const ns = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(4000);
const RecipeArtifactRefSchema = z
  .object({ artifactId: id, sha256: DigestSchema })
  .strict();
export const RecipeScopeSchema = z
  .object({ collection_id: id, snapshot_id: id })
  .strict();
export const ResearchRecipeSchema = z
  .object({
    profile: z.literal("vertex-research-run-v1"),
    thread_id: id.nullable(),
    request: z
      .object({
        run_id: id,
        trace_id: id,
        actor_id: id,
        task_contract: id,
        task: z.string().min(1).max(2000),
        model_version: id,
        scopes: z.array(RecipeScopeSchema).min(1).max(8),
        budget: z
          .object({
            tokens: count.positive(),
            usd: NonnegativeDecimalSchema,
            attempt_tokens: count.positive(),
            attempt_usd: NonnegativeDecimalSchema,
            max_attempts: count.positive().max(64),
            max_retries: count.max(8),
            max_tool_calls: count.max(64),
          })
          .strict(),
        reference_ns: ns,
        deadline_ns: ns,
        per_attempt_timeout_ns: ns,
        account_alias: id,
        environment: z.enum(["research", "paper"]),
        allowed_tools: z
          .array(
            z.enum([
              "read-evidence",
              "search-authorized-corpus",
              "propose-strategy",
              "request-backtest",
              "write-research-artifact",
            ])
          )
          .max(5),
        phases: z
          .array(z.enum(["analyst", "counterpoint", "synthesis"]))
          .min(1)
          .max(3)
          .refine((values) => values.at(-1) === "synthesis"),
        max_evidence: count.positive().max(64),
        max_excerpt_chars: count.positive().max(8000),
        max_evidence_age_ns: ns.refine(
          (value) => BigInt(value) <= 31_536_000_000_000_000n
        ),
      })
      .strict(),
  })
  .strict();

// Bodyless private continuation. All projections are equality-checked against
// original persisted approval by the concrete worker owner, never authority.
const chatReservation = z
  .object({ copyId: id, reservationSha256: DigestSchema })
  .strict();
const chatInput = chatReservation
  .extend({ sha256: DigestSchema, byteLength: count.positive().max(1_048_576) })
  .strict();
const ResearchChatRecipeV1Schema = z
  .object({
    profile: z.literal("vertex-research-chat-job-v1"),
    run_id: id,
    trace_id: id,
    actor_id: id,
    account_alias: id,
    environment: z.literal("research"),
    response_request_id: id,
    plan_id: id,
    plan_sha256: DigestSchema,
    copies: z
      .object({
        context: chatInput,
        tokenizeInput: chatInput,
        completionInput: chatInput,
        advisory: chatReservation.extend({ content: z.null() }).strict(),
      })
      .strict(),
    execution: z
      .object({
        taskContract: id,
        collectionId: id,
        snapshotId: id,
        selectionId: id,
        selectionSha256: DigestSchema,
        participantConfiguration: PolicyArtifactPinSchema,
        inputPolicy: VertexResearchChatInputPolicyV1Schema,
        advisoryMaximumBytes: count.positive().max(1_048_576),
        queuedRun: z
          .object({
            artifactId: id,
            artifactSha256: DigestSchema,
            rightsPolicyId: id,
            rightsVersion: id,
          })
          .strict(),
        provider: z
          .object({
            providerId: id,
            modelVersion: id,
            servedModel: id,
            tokenizerArtifact: PolicyArtifactPinSchema,
            tokenizeEndpoint: PolicyArtifactPinSchema,
            completionEndpoint: PolicyArtifactPinSchema,
            maximumInputTokens: count.positive(),
            maximumOutputTokens: count.positive(),
            maximumCostUsd: NonnegativeDecimalSchema,
          })
          .strict(),
        budgets: VertexResearchChatInputBudgetsSchema,
        reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
        deadlineAt: TimestampSchema,
      })
      .strict(),
  })
  .strict();
const ResearchChatRecipeV2Schema = ResearchChatRecipeV1Schema.extend({
  profile: z.literal("vertex-research-chat-job-v2"),
  execution: ResearchChatRecipeV1Schema.shape.execution
    .extend({ debate: VertexResearchChatDebatePlanV1Schema })
    .strict(),
}).strict();
const nativeDeferredCopy = chatReservation
  .extend({ content: z.null() })
  .strict();
const ResearchChatNativeEvidenceRecipeSchema =
  ResearchChatRecipeV1Schema.extend({
    profile: z.literal("vertex-research-chat-native-evidence-job-v1"),
    copies: z
      .object({
        context: chatInput,
        tokenizeInput: chatInput,
        completionInput: chatInput,
        evidenceBundle: chatInput,
        phaseOneResponse: nativeDeferredCopy,
        toolResult: nativeDeferredCopy,
        phaseTwoTokenizeInput: nativeDeferredCopy,
        phaseTwoCompletionInput: nativeDeferredCopy,
        advisory: nativeDeferredCopy,
      })
      .strict(),
    execution: ResearchChatRecipeV1Schema.shape.execution
      .extend({
        nativeEvidence: VertexResearchChatNativeEvidencePlanProtocolSchema,
      })
      .strict(),
  }).strict();
export const ResearchChatRecipeSchema = z.union([
  ResearchChatRecipeV1Schema,
  ResearchChatRecipeV2Schema,
  ResearchChatNativeEvidenceRecipeSchema,
]);

export const QUANT_EXPERIMENT_MAX_BYTES = 700_000;
export const QuantExperimentRecipeSchema = z
  .object({
    profile: z.literal("vertex-quant-experiment-recipe-v1"),
    module_id: id,
    task_contract: id,
    collection_id: id,
    experiment_id: id,
    handoff: RecipeArtifactRefSchema,
    dependency_pins: z
      .array(WorkerExperimentDependencyPinSchema)
      .min(1)
      .max(64),
    publication: z
      .object({
        account_alias: id,
        environment: z.enum(["research", "paper"]),
        collection_id: id,
        rights_policy_id: id,
        rights_version: id,
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    return (
      value.publication.collection_id === value.collection_id &&
      new Set(value.dependency_pins.map((pin) => pin.artifactId)).size ===
        value.dependency_pins.length &&
      new Set(value.dependency_pins.map((pin) => pin.artifactSha256)).size ===
        value.dependency_pins.length
    );
  });

// Gamma consumes only independently reviewed, exact-byte input bindings. These
// private profiles are data/configuration, never review or execution authority.
const gammaDecimal = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,18})?$/);
const gammaRule = z
  .object({
    path_pattern: z.string().min(1).max(256),
    quantum: gammaDecimal,
    maximum_absolute_error: gammaDecimal,
  })
  .strict();
const gammaInput = z
  .object({
    role: z.enum([
      "setup",
      "option_chain",
      "financial_context",
      "portfolio",
      "rows",
      "spy_rows",
      "qqq_rows",
      "payload",
      "stock_rows",
      "option_totals",
      "snapshot",
      "candidate",
      "research_brief",
      "flow_snapshot",
      "market_structure",
      "volatility",
      "liquidity",
      "fundamental_catalyst",
      "market_regime",
    ]),
    review: WorkerReviewPinSchema,
    binding: RecipeArtifactRefSchema,
  })
  .strict();
const gammaText = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[^\u0000-\u001f\u007f\ud800-\udfff]*$/u);
const gammaMetadata = z
  .object({
    evidenceId: id,
    collectionId: id,
    snapshotId: id,
    sourceUri: z.string().url().max(2048),
    sourceIdentity: z
      .object({ provider: id, sourceId: id, snapshotId: id })
      .strict(),
    sourceLocator: gammaText.max(200),
    attribution: gammaText.max(200),
    publishedAt: TimestampSchema.nullable(),
    capturedAt: TimestampSchema,
    claim: gammaText,
    limitations: z.array(gammaText).max(64),
    rightsPolicyId: id,
  })
  .strict();

// Source-only paper/lab lane. Implementation/config pins are not approval;
// the worker independently resolves original current evidence before computing.
const PAPER_LAB_SOURCE_PATHS = [
  "services/research/adapters/paper_lab.py",
  "services/research/strategies/lab_authority.py",
  "services/research/strategies/paper_lab.py",
  "services/research/strategies/experiment_backtest.py",
  "services/research/strategies/experiment_gates.py",
  "services/research/strategies/lab_metrics.py",
  "services/research/strategies/quant.py",
  "services/research/strategies/publication.py",
  "services/research/strategies/core.py",
  "services/research/backtesting/lineage.py",
  "services/research/backtesting/ports.py",
  "services/research/backtesting/planner.py",
  "services/research/agents/types.py",
  "services/research/knowledge/models.py",
  "services/research/knowledge/papers.py",
  "services/research/adapters/experiments.py",
  "services/research/adapters/handlers.py",
  "services/research/adapters/ports.py",
  "services/research/providers/ports.py",
  "services/research/providers/boundary.py",
  "services/control-client/vertex_control/adapters.py",
  "services/control-client/vertex_control/client.py",
] as const;
export const PaperLabImplementationSchema = z
  .object({
    profile: z.literal("vertex-paper-lab-implementation-v1"),
    identity: z.literal("vertex-paper-lab"),
    version: z.literal("1.0.0"),
    sourceHashes: z
      .record(z.string().max(200), DigestSchema)
      .refine((values) => {
        return (
          Object.keys(values).length === PAPER_LAB_SOURCE_PATHS.length &&
          PAPER_LAB_SOURCE_PATHS.every(
            (path) => typeof values[path] === "string"
          )
        );
      }),
  })
  .strict();
const paperLabSource = z
  .object({ binding: RecipeArtifactRefSchema, review: WorkerReviewPinSchema })
  .strict();
export const PaperLabRecipeSchema = z
  .object({
    profile: z.literal("vertex-paper-lab-recipe-v1"),
    module_id: id,
    task_contract: id,
    operation: z.enum([
      "map-claims",
      "freeze-experiment",
      "map-backtest",
      "review-gates",
    ]),
    collection_id: id,
    snapshot_id: id,
    implementation: RecipeArtifactRefSchema,
    request: paperLabSource,
    inputs: z
      .array(
        paperLabSource
          .extend({ name: id.refine((value) => value !== "request") })
          .strict()
      )
      .max(63),
    dependency_pins: z.array(WorkerExperimentDependencyPinSchema).max(64),
    // capturedAt comes from actual durable admitted_at, never a future template or
    // changing retry clock. It means input admission, not completed computation.
    publication: gammaMetadata.omit({ capturedAt: true }).strict(),
  })
  .strict()
  .refine((value) => {
    const sources = [value.request, ...value.inputs];
    const reviewIds = sources.map((source) => source.review.evidenceId);
    const artifactIds = sources.map((source) => source.review.artifactId);
    return (
      new Set(value.inputs.map((source) => source.name)).size ===
        value.inputs.length &&
      new Set(reviewIds).size === sources.length &&
      new Set(artifactIds).size === sources.length &&
      sources.every(
        (source) => source.review.collectionId === value.collection_id
      ) &&
      !reviewIds.includes(value.publication.evidenceId) &&
      !artifactIds.includes(value.publication.evidenceId) &&
      sources.every(
        (source) => source.binding.artifactId !== value.publication.evidenceId
      ) &&
      value.publication.collectionId === value.collection_id &&
      value.publication.snapshotId === value.snapshot_id &&
      value.publication.sourceIdentity.snapshotId === value.snapshot_id &&
      (value.operation === "freeze-experiment"
        ? value.dependency_pins.length > 0
        : value.operation === "map-backtest" ||
          value.dependency_pins.length === 0) &&
      new Set(value.dependency_pins.map((pin) => pin.artifactId)).size ===
        value.dependency_pins.length &&
      new Set(value.dependency_pins.map((pin) => pin.artifactSha256)).size ===
        value.dependency_pins.length
    );
  });
const gammaCommon = {
  profile: z.literal("vertex-gamma-recipe-v1"),
  module_id: id,
  collection_id: id,
  snapshot_id: id,
  as_of: TimestampSchema,
  max_input_age_ns: ns.refine(
    (value) => BigInt(value) > 0n && BigInt(value) <= 31_536_000_000_000_000n
  ),
  inputs: z.array(gammaInput).min(1).max(8),
  conversion: z
    .object({
      policy_id: id,
      version: id,
      basis: z.literal("binary64-shortest-roundtrip-decimal"),
      rounding: z.literal("ROUND_HALF_EVEN"),
      rules: z.array(gammaRule).min(1).max(256),
    })
    .strict(),
  // No fabricated placeholder hashes or authority flags in reviewed config.
  // Planner supplies BOTH derived-output hashes and the unreviewed status.
  publication: gammaMetadata,
};
const gammaTickerParameters = z.object({ ticker: gammaText.max(160) }).strict();
// Roles are the authored ResearchAdapter keyword arguments, not generic signals
// or interchangeable feature blobs. Setup consumes OptionFlowSnapshot, NOT the
// OptionFlowFeatureSnapshot returned by option_flow.
const gammaRoles: Readonly<
  Record<
    string,
    Readonly<{ required: readonly string[]; optional: readonly string[] }>
  >
> = {
  "options-selector": {
    required: ["setup", "option_chain"],
    optional: ["financial_context"],
  },
  "portfolio-committee": { required: ["portfolio"], optional: [] },
  momentum: { required: ["rows"], optional: ["spy_rows", "qqq_rows"] },
  market_structure: { required: ["rows"], optional: [] },
  volatility: { required: ["payload"], optional: [] },
  liquidity: {
    required: [],
    optional: ["stock_rows", "option_chain", "option_totals"],
  },
  fundamental_catalyst: { required: ["payload"], optional: [] },
  option_flow: { required: ["snapshot"], optional: [] },
  identify_setup: {
    required: [
      "candidate",
      "research_brief",
      "flow_snapshot",
      "market_structure",
      "volatility",
    ],
    optional: ["liquidity", "fundamental_catalyst", "market_regime"],
  },
};
export const GammaResearchRecipeSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...gammaCommon,
        operation: z.literal("options-selector"),
        constraints: z
          .object({
            min_dte: count.positive(),
            max_dte: count.positive(),
            min_open_interest: count,
            min_volume: count,
            call_delta_target: gammaDecimal,
            put_delta_target: gammaDecimal,
            max_delta_deviation: gammaDecimal,
            max_bid_ask_spread_pct: gammaDecimal,
            max_premium: gammaDecimal,
            max_loss: gammaDecimal,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("portfolio-committee"),
        constraints: z
          .object({
            max_premium_per_trade: gammaDecimal.nullable(),
            max_portfolio_premium_at_risk_pct: gammaDecimal,
            max_trade_risk_pct: gammaDecimal,
            max_theme_exposure_pct: gammaDecimal,
            max_ticker_exposure_pct: gammaDecimal,
            max_correlated_exposure_pct: gammaDecimal,
            max_same_expiry_exposure_pct: gammaDecimal,
            max_event_risk_exposure_pct: gammaDecimal,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("momentum"),
        parameters: gammaTickerParameters,
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("market_structure"),
        parameters: gammaTickerParameters
          .extend({ timeframe: gammaText.max(160) })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("volatility"),
        parameters: gammaTickerParameters,
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("liquidity"),
        parameters: gammaTickerParameters,
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("fundamental_catalyst"),
        parameters: gammaTickerParameters,
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("option_flow"),
        parameters: z.object({}).strict(),
      })
      .strict(),
    z
      .object({
        ...gammaCommon,
        operation: z.literal("identify_setup"),
        parameters: z.object({}).strict(),
      })
      .strict(),
  ])
  .refine((value) => {
    const roles = value.inputs.map((input) => input.role);
    const { required, optional } = present(gammaRoles[value.operation]);
    const allowed = [...required, ...optional];
    return (
      new Set(roles).size === roles.length &&
      required.every((role) => roles.some((entry) => entry === role)) &&
      roles.every((role) => allowed.includes(role)) &&
      new Set(value.inputs.map((input) => input.review.evidenceId)).size ===
        value.inputs.length &&
      value.inputs.every(
        (input) => input.review.collectionId === value.collection_id
      ) &&
      value.publication.collectionId === value.collection_id &&
      value.publication.snapshotId === value.snapshot_id &&
      value.publication.sourceIdentity.snapshotId === value.snapshot_id
    );
  });

// Closed private caller for existing exact-decimal strategy functions. Typed
// original input payloads are decoded by sleeve_research.py, not reinterpreted
// from DatasetManifest aliases. Every original source has its own current pin.
const sleeveDecimal = z
  .string()
  .max(123)
  .regex(/^-?(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,60})?$/);
const sleeveDependency = z
  .object({ review: WorkerReviewPinSchema, content: RecipeArtifactRefSchema })
  .strict();
const sleeveInput = sleeveDependency
  .extend({
    role: z.enum([
      "facts",
      "assumptions",
      "thesis_observations",
      "bars",
      "benchmark_bars",
      "regime",
      "session",
      "study",
      "macro_vintages",
      "hmm_features",
      "hmm_model",
      "hmm_scaler",
      "jump_features",
      "jump_model",
      "jump_scaler",
      "composite_hmm_binding",
      "composite_jump_binding",
      "wheel_state",
      "exercise_quotes",
      "dividend_calendar",
    ]),
  })
  .strict();
const sleeveAxis = z
  .object({
    series_id: id,
    unit: id,
    positive_change_threshold: sleeveDecimal,
    maximum_release_age_days: count,
    maximum_period_age_days: count,
  })
  .strict();
const sleeveSwingPolicy = z
  .object({
    allowed_regimes: z
      .array(id)
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length),
    maximum_age_seconds: count,
    minimum_relative_strength: sleeveDecimal,
    minimum_relative_volume: sleeveDecimal,
    maximum_atr_fraction: sleeveDecimal,
    stop_atr_multiple: sleeveDecimal,
    target_risk_multiple: sleeveDecimal,
    tick_size: sleeveDecimal,
  })
  .strict();
const sleeveThesisParameters = {
  instrument_id: id,
  thesis_id: id,
  head_profile: RecipeArtifactRefSchema,
  instrument_kind: z.literal("equity"),
  currency: id,
  maximum_fact_age_days: count,
};
const sleeveThesisCandidate = z
  .object({
    proposed_at: TimestampSchema,
    text: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    evidence_refs: z
      .array(
        z
          .object({
            evidence_id: id,
            record: RecipeArtifactRefSchema,
            content: RecipeArtifactRefSchema,
          })
          .strict()
      )
      .min(1)
      .max(64),
    invalidation_rules: z
      .array(
        z
          .object({
            rule_id: id,
            feature_id: id,
            operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
            threshold: sleeveDecimal,
            lookback_bars: count.positive().max(100_000),
            unit: id,
          })
          .strict()
      )
      .min(1)
      .max(64),
  })
  .strict();
const sleeveCommon = {
  profile: z.literal("vertex-sleeve-recipe-v1"),
  module_id: id,
  task_contract: id,
  collection_id: id,
  snapshot_id: id,
  as_of: TimestampSchema,
  max_input_age_ns: ns.refine(
    (value) => BigInt(value) > 0n && BigInt(value) <= 31_536_000_000_000_000n
  ),
  inputs: z.array(sleeveInput).min(1).max(3),
  dependencies: z.array(sleeveDependency).max(63),
  publication: gammaMetadata
    .extend({ limitations: z.array(gammaText).max(60) })
    .strict(),
};
const sleeveRoles: Readonly<
  Record<
    string,
    Readonly<{ required: readonly string[]; optional: readonly string[] }>
  >
> = {
  "fundamental-value-equity": {
    required: ["facts", "assumptions"],
    optional: [],
  },
  "fundamental-build-dossier": {
    required: ["facts", "assumptions"],
    optional: [],
  },
  "fundamental-review-thesis": {
    required: ["facts", "assumptions", "thesis_observations"],
    optional: [],
  },
  "fundamental-revise-thesis": {
    required: ["facts", "assumptions"],
    optional: [],
  },
  "swing-momentum": { required: ["bars"], optional: ["benchmark_bars"] },
  "swing-decision": {
    required: ["bars", "regime"],
    optional: ["benchmark_bars"],
  },
  "swing-dual-zone-review": {
    required: ["bars"],
    optional: ["benchmark_bars"],
  },
  "swing-session-breakout": {
    required: ["bars", "session", "study"],
    optional: [],
  },
  "macro-classify-regime": { required: ["macro_vintages"], optional: [] },
  "macro-hmm-forward-v1": {
    required: ["hmm_features", "hmm_model", "hmm_scaler"],
    optional: [],
  },
  "macro-jump-state-v1": {
    required: ["jump_features", "jump_model", "jump_scaler"],
    optional: [],
  },
  "macro-regime-composite-envelope-v1": {
    required: ["composite_hmm_binding", "composite_jump_binding"],
    optional: [],
  },
  "wheel-obligations": { required: ["wheel_state"], optional: [] },
  "wheel-early-exercise-review": {
    required: ["wheel_state", "exercise_quotes"],
    optional: ["dividend_calendar"],
  },
};
export const SleeveResearchRecipeSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("fundamental-value-equity"),
        parameters: z
          .object({
            instrument_id: id,
            instrument_kind: z.literal("equity"),
            currency: id,
            maximum_fact_age_days: count,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("fundamental-build-dossier"),
        parameters: z.object(sleeveThesisParameters).strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("fundamental-review-thesis"),
        parameters: z
          .object({
            ...sleeveThesisParameters,
            maximum_feature_age_seconds: count.max(31_536_000),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("fundamental-revise-thesis"),
        parameters: z
          .object({
            ...sleeveThesisParameters,
            candidate: sleeveThesisCandidate,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("swing-momentum"),
        parameters: z
          .object({
            instrument_id: id,
            benchmark_id: id.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("swing-decision"),
        parameters: z
          .object({
            instrument_id: id,
            benchmark_id: id.nullable(),
            policy: sleeveSwingPolicy,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("swing-dual-zone-review"),
        parameters: z
          .object({
            instrument_id: id,
            benchmark_id: id.nullable(),
            volume_trigger: sleeveDecimal,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("swing-session-breakout"),
        parameters: z
          .object({
            minimum_relative_volume: sleeveDecimal,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("macro-classify-regime"),
        parameters: z
          .object({
            growth: sleeveAxis,
            inflation: sleeveAxis,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("macro-hmm-forward-v1"),
        parameters: z
          .object({
            variant: z.literal("diagonal-gaussian-log-forward-v1"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("macro-jump-state-v1"),
        parameters: z
          .object({
            variant: z.literal("discrete-fixed-centroid-trailing-window-dp-v1"),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("macro-regime-composite-envelope-v1"),
        parameters: z
          .object({
            variant: z.literal("implemented-components-agreement-envelope-v1"),
            market_id: id,
            calendar_id: id,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("wheel-obligations"),
        parameters: z.object({}).strict(),
      })
      .strict(),
    z
      .object({
        ...sleeveCommon,
        operation: z.literal("wheel-early-exercise-review"),
        parameters: z
          .object({
            maximum_quote_age_seconds: count.max(86_400),
            maximum_dividend_age_seconds: count.max(31_536_000),
          })
          .strict(),
      })
      .strict(),
  ])
  .refine((value) => {
    const roles = value.inputs.map((input) => input.role);
    const { required, optional } = present(sleeveRoles[value.operation]);
    const allowed = [...required, ...optional];
    const sources = [...value.inputs, ...value.dependencies];
    const recordIds = sources.map((source) => source.review.artifactId);
    const contentIds = sources.map((source) => source.content.artifactId);
    if (
      value.operation === "wheel-obligations"
        ? value.dependencies.length !== 0
        : value.dependencies.length === 0
    )
      return false;
    if (
      (value.operation === "swing-momentum" ||
        value.operation === "swing-decision" ||
        value.operation === "swing-dual-zone-review") &&
      ((value.parameters.benchmark_id !== null) !==
        roles.includes("benchmark_bars") ||
        value.parameters.benchmark_id === value.parameters.instrument_id)
    )
      return false;
    if (
      value.operation === "macro-classify-regime" &&
      value.parameters.growth.series_id === value.parameters.inflation.series_id
    )
      return false;
    if (
      (value.operation === "macro-hmm-forward-v1" ||
        value.operation === "macro-jump-state-v1" ||
        value.operation === "macro-regime-composite-envelope-v1") &&
      value.publication.limitations.length > 57
    )
      return false;
    // Exactly the two review-pinned component result records (HMM, JM); no extra sources.
    if (
      value.operation === "macro-regime-composite-envelope-v1" &&
      value.dependencies.length !== 2
    )
      return false;
    if (
      (value.operation === "fundamental-build-dossier" ||
        value.operation === "fundamental-review-thesis" ||
        value.operation === "fundamental-revise-thesis") &&
      (recordIds.includes(value.parameters.head_profile.artifactId) ||
        contentIds.includes(value.parameters.head_profile.artifactId) ||
        value.publication.evidenceId ===
          value.parameters.head_profile.artifactId)
    )
      return false;
    return (
      sources.length <= 64 &&
      new Set(roles).size === roles.length &&
      required.every((role) => roles.some((entry) => entry === role)) &&
      roles.every((role) => allowed.includes(role)) &&
      new Set(sources.map((source) => source.review.evidenceId)).size ===
        sources.length &&
      new Set(recordIds).size === sources.length &&
      new Set(contentIds).size === sources.length &&
      recordIds.every((recordId) => !contentIds.includes(recordId)) &&
      sources.every(
        (source) =>
          source.review.collectionId === value.collection_id &&
          source.review.evidenceId !== value.publication.evidenceId
      ) &&
      !recordIds.includes(value.publication.evidenceId) &&
      !contentIds.includes(value.publication.evidenceId) &&
      value.publication.collectionId === value.collection_id &&
      value.publication.snapshotId === value.snapshot_id &&
      value.publication.sourceIdentity.snapshotId === value.snapshot_id
    );
  });
const SourceContextSchema = z
  .object({
    instrument_id: id,
    currency: text,
    calendar: id,
    provider_timezone: text,
    snapshot_id: id,
    source_id: id,
    as_of_at: TimestampSchema,
    vintage_id: id.nullable(),
    maximum_age_ms: count,
    price_unit: text,
    quantity_unit: z.enum(["shares", "contracts", "base-asset"]),
    adjustment_method: z.enum([
      "unadjusted",
      "split-adjusted",
      "total-return",
      "provider-defined",
    ]),
    data_kind: z.enum(["real", "synthetic"]),
    synthetic_reason: text.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.data_kind === "synthetic") === (value.synthetic_reason !== null) &&
      value.price_unit === value.currency
  );
const RequestSchema = z
  .object({
    symbol: text.optional(),
    start_date: text.optional(),
    end_date: text.optional(),
    interval: text.optional(),
    period: text.optional(),
    filing_type: text.optional(),
    accession_number: text.optional(),
    item: text.optional(),
    start_at: TimestampSchema.optional(),
    end_at: TimestampSchema.optional(),
    aggregation_period: text.optional(),
    snapshot_at: TimestampSchema.optional(),
    expiration_date: text.optional(),
    strike: NonnegativeDecimalSchema.optional(),
    contract_type: text.optional(),
    filters: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();
export const DatasetRecipeSchema = z
  .object({
    profile: z.literal("vertex-dataset-ingest-v1"),
    provider: z.enum(["financialdatasets", "quantdata"]),
    operation: id,
    request: RequestSchema,
    sourceContext: SourceContextSchema,
    publication: z
      .object({
        dataset_id: id,
        storage_ref: text,
        start_at: TimestampSchema,
        end_at: TimestampSchema,
        as_of_at: TimestampSchema,
        retention_policy: id,
        require_point_in_time: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const HistoricalRecipeSchema = z
  .object({
    profile: z.literal("vertex-historical-input-v1"),
    input: z
      .object({
        source_id: id,
        snapshot_id: id,
        operation: id,
        format: text,
        public_source_uri: text,
        coverage_start: TimestampSchema,
        coverage_end: TimestampSchema,
        available_at: TimestampSchema,
        received_at: TimestampSchema,
        vintage_id: id,
        calendar: id,
        retention_policy: id,
        rights_policy_id: id,
        expected_digest: DigestSchema,
      })
      .strict(),
    artifact: RecipeArtifactRefSchema,
    current_session_start: TimestampSchema,
    dataset_id: id,
    storage_ref: text,
    instrument_universe: z.array(id).min(1).max(1024),
    adjustment_method: z.enum([
      "unadjusted",
      "split-adjusted",
      "total-return",
      "provider-defined",
    ]),
  })
  .strict()
  .refine((value) => value.input.expected_digest === value.artifact.sha256);
// Restricted existing-owner request, not endpoint/client selection. Ticks use a
// different source type and are deliberately absent from this bars-first recipe.
const IbkrHistoryRequestSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    request_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_:/.-]+$/),
    contract_ref: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_:/.-]+$/),
    kind: z
      .object({
        type: z.literal("bars"),
        what_to_show: z.enum(["TRADES", "ADJUSTED_LAST"]),
        bar_size: z.enum(["1 min", "1 day"]),
        duration_days: z.number().int().min(1).max(365),
        end_unix_seconds: z
          .number()
          .int()
          .min(946_684_800)
          .max(4_102_444_800)
          .nullable(),
        use_rth: z.boolean(),
      })
      .strict()
      .refine(
        (value) =>
          (value.bar_size !== "1 min" || value.duration_days === 1) &&
          (value.what_to_show === "ADJUSTED_LAST"
            ? value.end_unix_seconds === null
            : value.end_unix_seconds !== null)
      ),
    limits: z
      .object({
        timeout_ms: z.number().int().min(1000).max(60_000),
        max_rows: z.number().int().min(1).max(5000),
        max_bytes: z.number().int().min(32_768).max(4_194_304),
        max_events: z.number().int().min(1).max(256),
      })
      .strict(),
  })
  .strict();
export const IbkrHistoryRecipeSchema = z
  .object({
    profile: z.literal("vertex-ibkr-history-ingest-v1"),
    request: IbkrHistoryRequestSchema,
    publication: z
      .object({
        dataset_id: id,
        storage_ref: id,
        instrument_id: id,
        rights_policy_id: id,
        retention_policy: id,
      })
      .strict(),
  })
  .strict();
const paper = z
  .object({
    paper: z
      .object({
        ssrn_id: text,
        version_id: text,
        title: text,
        authors: z.array(text).min(1).max(128),
        doi: text.nullable(),
        published_at: TimestampSchema.nullable(),
        captured_at: TimestampSchema,
        media_type: text,
        rights_policy_id: id,
        expected_digest: DigestSchema,
      })
      .strict(),
    artifact: RecipeArtifactRefSchema,
  })
  .strict();
const transcripts = z
  .object({
    manifest: RecipeArtifactRefSchema,
    transcripts: z
      .record(id, RecipeArtifactRefSchema)
      .refine((value) => Object.keys(value).length <= 1000),
  })
  .strict();
// DeltaTrend's loader keys are original YouTube IDs, not platform identifiers.
// Leading "-" or "_" is valid; do not rename source identities or widen id.
const deltaTranscripts = z
  .object({
    manifest: RecipeArtifactRefSchema,
    transcripts: z
      .record(
        z
          .string()
          .length(11)
          .regex(/^[A-Za-z0-9_-]{11}$/),
        RecipeArtifactRefSchema
      )
      .refine((value) => Object.keys(value).length <= 1000),
  })
  .strict();
const crownBundles = z
  .object({
    bundles: z
      .array(RecipeArtifactRefSchema)
      .min(1)
      .max(32)
      .refine(
        (values) =>
          new Set(values.map((value) => value.artifactId)).size ===
            values.length &&
          new Set(values.map((value) => value.sha256)).size === values.length
      ),
  })
  .strict();
export const KnowledgeRecipeSchema = z
  .object({
    profile: z.literal("vertex-knowledge-import-v1"),
    collection_id: z.enum([
      "ssrn",
      "deltatrendtrading",
      "verrillo-aleks",
      "nicholas-crown",
      "jay-medrow",
      "define-your-risk",
    ]),
    snapshot_id: id,
    expected_snapshot_id: id.nullable(),
    rights_policy_id: id,
    captured_at: TimestampSchema,
    input: z.union([
      paper,
      transcripts,
      deltaTranscripts,
      z.object({ bundle: RecipeArtifactRefSchema }).strict(),
      crownBundles,
    ]),
  })
  .strict()
  .refine((value) => {
    if (value.collection_id === "ssrn") {
      const parsed = paper.safeParse(value.input);
      return (
        parsed.success &&
        parsed.data.paper.expected_digest === parsed.data.artifact.sha256 &&
        parsed.data.paper.rights_policy_id === value.rights_policy_id &&
        parsed.data.paper.captured_at === value.captured_at
      );
    }
    if (value.collection_id === "nicholas-crown")
      return "bundle" in value.input || "bundles" in value.input;
    if (value.collection_id === "deltatrendtrading")
      return deltaTranscripts.safeParse(value.input).success;
    return transcripts.safeParse(value.input).success;
  });
// ReviewedResearchModel.record() uses exact decimal strings for v2 model times
// and standard Base64 for the original immutable byte fields. Do not decode
// native JSON here: its integer semantics and runtime pins belong to the Host.
const modelNs = z
  .string()
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) <= 2n ** 127n - 1n
  );
const modelDecimal = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?$/);
const positiveModelDecimal = modelDecimal.refine((value) =>
  /[1-9]/.test(value)
);
const reviewedBytes = (maximum: number) =>
  z
    .string()
    .min(4)
    .max(Math.ceil(maximum / 3) * 4)
    .refine((value) => {
      if (value.length > Math.ceil(maximum / 3) * 4) return false;
      try {
        const bytes = atob(value);
        return (
          bytes.length > 0 && bytes.length <= maximum && btoa(bytes) === value
        );
      } catch {
        return false;
      }
    });
const ReviewedResearchModelSchema = z
  .object({
    strategy_digest: DigestSchema,
    strategy_code_digest: DigestSchema,
    assumptions_digest: DigestSchema,
    engine_digest: DigestSchema,
    review_digest: DigestSchema,
    instrument_id: id,
    quantity: positiveModelDecimal,
    initial_cash: positiveModelDecimal,
    commission_per_fill: modelDecimal,
    slippage_per_unit: modelDecimal,
    enter_not_before_ns: modelNs,
    exit_not_before_ns: modelNs,
    evidence_template_bytes: reviewedBytes(64_000),
    native_configuration_bytes: reviewedBytes(1_048_576),
  })
  .strict()
  .refine(
    (value) =>
      modelNs.safeParse(value.enter_not_before_ns).success &&
      modelNs.safeParse(value.exit_not_before_ns).success &&
      BigInt(value.exit_not_before_ns) > BigInt(value.enter_not_before_ns)
  );

const HostQuoteBacktestRecipeSchema = z
  .object({
    format: z.literal("vertex-host-backtest-recipe-v2"),
    strategy: RecipeArtifactRefSchema,
    run: RecipeArtifactRefSchema,
    datasets: z
      .array(
        z
          .object({
            manifest: RecipeArtifactRefSchema,
            content: RecipeArtifactRefSchema,
            contentFormat: text,
            declaredEvents: count,
          })
          .strict()
      )
      .min(1)
      .max(64),
    evidence: z.array(RecipeArtifactRefSchema).max(64),
    // Native typed envelopes are interpreted only by the closed Host wire registry.
    lineage: z.record(z.string(), z.unknown()),
    budget: z.record(z.string(), z.unknown()),
    descriptor: z.record(z.string(), z.unknown()),
    model: ReviewedResearchModelSchema,
    plannedAt: TimestampSchema,
    publication: z
      .object({
        actorId: id,
        collectionId: id,
        snapshotId: id,
        rightsPolicyId: id,
        rightsVersion: id,
      })
      .strict(),
  })
  .strict();

// Closed retrospective profile; not an alias for v2, Candle or PIT/OOS input.
const HostHistoricalBarBacktestRecipeSchema = z
  .object({
    format: z.literal("vertex-host-backtest-recipe-v3"),
    strategy: RecipeArtifactRefSchema,
    run: RecipeArtifactRefSchema,
    datasets: z
      .array(
        z
          .object({
            manifest: RecipeArtifactRefSchema,
            content: RecipeArtifactRefSchema,
            contentFormat: z.literal("vertex-ibkr-historical-bars-v1"),
            declaredEvents: count.positive().max(5000),
            collectionId: id.nullable(),
            reviewPins: z.array(WorkerReviewPinSchema).min(1).max(16),
          })
          .strict()
      )
      .length(1),
    evidence: z.array(RecipeArtifactRefSchema).min(1).max(32),
    reviewPins: z.array(WorkerReviewPinSchema).min(1).max(32),
    lineage: z.record(z.string(), z.unknown()),
    budget: z.record(z.string(), z.unknown()),
    descriptor: z.record(z.string(), z.unknown()),
    model: ReviewedResearchModelSchema,
    plannedAt: TimestampSchema.refine((value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    ),
    publication: z
      .object({
        actorId: id,
        collectionId: id,
        snapshotId: id,
        rightsPolicyId: id,
        rightsVersion: id,
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    const pins = value.reviewPins;
    return (
      new Set(pins.map((pin) => pin.evidenceId)).size === pins.length &&
      pins.length === value.evidence.length &&
      pins.every(
        (pin) =>
          pin.collectionId === value.publication.collectionId &&
          pin.rightsPolicyId === value.publication.rightsPolicyId &&
          pin.rightsVersion === value.publication.rightsVersion &&
          value.evidence.some(
            (ref) =>
              ref.artifactId === pin.artifactId &&
              ref.sha256 === pin.artifactSha256
          )
      ) &&
      present(value.datasets[0]).reviewPins.every((pin) =>
        pins.some((current) =>
          Object.keys(pin).every(
            (key) =>
              pin[key as keyof typeof pin] ===
              current[key as keyof typeof current]
          )
        )
      )
    );
  });
export const HostBacktestRecipeSchema = z.union([
  HostQuoteBacktestRecipeSchema,
  HostHistoricalBarBacktestRecipeSchema,
]);
