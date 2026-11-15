import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  AGENT_OPS_API_ERRORS,
  BacktestResultSummarySchema,
} from "./agent-ops.ts";
import {
  QC_PORT_STUDY_KIND,
  QcPortStudySchema,
  STRATEGY_BACKTEST_STUDY_KIND,
  StrategyBacktestStudySchema,
} from "./research-studies.ts";

// Operator strategy library: strategies, typed parameter schemas, named presets and linked backtests.
// Operator-only (requireOperator); agent keys may call it, read keys only list and get.
// Field, params and preset rules are enforced once in the repository; params and preset values are
// accepted structurally here so its precise messages reach the caller as VALIDATION_ERROR.

export const STRATEGY_KIND_VALUES = ["python", "native", "external"] as const;
export const STRATEGY_STATUS_VALUES = [
  "idea",
  "researching",
  "backtested",
  "paper",
  "live_candidate",
  "retired",
] as const;
export const STRATEGY_PARAM_TYPE_VALUES = [
  "integer",
  "decimal",
  "boolean",
  "choice",
] as const;
export const STRATEGY_SORT_VALUES = [
  "updated",
  "name",
  "sharpe",
  "return",
] as const;
// high lists a strategy first inside every sort.
export const STRATEGY_PRIORITY_VALUES = ["normal", "high"] as const;
export const STRATEGY_EXTERNAL_METRICS_LIMIT = 12;
export const STRATEGY_LIST_MAX = 500;
export const STRATEGY_PARAMS_LIMIT = 60;
export const STRATEGY_TAGS_LIMIT = 20;
export const STRATEGY_PRESET_VALUES_LIMIT = 60;
// Tags that name where a library strategy comes from; the portal offers them as a source filter.
export const STRATEGY_SOURCE_TAGS: Readonly<Record<string, string>> =
  Object.freeze({
    "151-strategies": "151 Trading Strategies",
    freestockalerts: "FreeStockAlerts",
    "instagram-carousel": "Instagram carousel",
    quantjourney: "QuantJourney",
  });

export const StrategyKindSchema = z.enum(STRATEGY_KIND_VALUES);
export const StrategyStatusSchema = z.enum(STRATEGY_STATUS_VALUES);
export const StrategyParamTypeSchema = z.enum(STRATEGY_PARAM_TYPE_VALUES);
export const StrategySortSchema = z.enum(STRATEGY_SORT_VALUES);
export const StrategyPrioritySchema = z.enum(STRATEGY_PRIORITY_VALUES);

const IdSchema = z.string().trim().min(1).max(128);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
// Blank strings clear the field (null); undefined leaves it unchanged.
const clearableText = (max: number) => {
  return z.union([z.string().max(max), z.null()]).transform((value) => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });
};

const ParamValueSchema = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(100),
]);
// Structural only; the repository checks names, types, bounds, options and uniqueness.
const ParamsInputSchema = z
  .array(z.record(z.string().max(64), z.unknown()))
  .max(STRATEGY_PARAMS_LIMIT);
const TagsInputSchema = z.array(z.string().max(64)).max(STRATEGY_TAGS_LIMIT);

export const StrategyParamSchema = z.object({
  name: z.string(),
  type: StrategyParamTypeSchema,
  title: z.string(),
  default: ParamValueSchema,
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.string()).optional(),
});

export const StrategyExternalMetricSchema = z
  .object({ label: requiredText(60), value: requiredText(80) })
  .strict();
// A third party's published CLAIM about the strategy: where it was published, the method the source
// describes and the metrics it reports. Non-null is the single source of the label "Externally
// pre-validated". It never means validated by Vertex; null means no external claim.
export const StrategyExternalValidationSchema = z
  .object({
    sourceUrl: z.url({ protocol: /^https$/u }).max(300),
    sourceTitle: requiredText(200),
    sourceAuthor: requiredText(120),
    publishedOn: z.iso.date(),
    claimedMethod: requiredText(1000),
    claimedMetrics: z
      .array(StrategyExternalMetricSchema)
      .min(1)
      .max(STRATEGY_EXTERNAL_METRICS_LIMIT),
  })
  .strict();

export const StrategySchema = z.object({
  id: z.string().min(1),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: StrategyKindSchema,
  status: StrategyStatusSchema,
  sourceRef: z.string().nullable(),
  tags: z.array(z.string()),
  favorite: z.boolean(),
  section: z.string().nullable(),
  params: z.array(StrategyParamSchema),
  priority: StrategyPrioritySchema,
  externalValidation: StrategyExternalValidationSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Return statistics derived by the server from the latest linked backtest's reported equity.
export const StrategyLatestBacktestSchema = z.object({
  id: z.string().min(1),
  createdAt: z.date(),
  sharpe: z.number().nullable(),
  totalReturn: z.number().nullable(),
  cagr: z.number().nullable(),
  maxDrawdown: z.number().nullable(),
});

// Vertex's own study result for a strategy: the kind and verdict of the study stored under its slug,
// shown only when the strategy has the study tag for that kind (strategy-study-tags.ts). A research
// result with no trading authority. The server reads the two keys without the full document and
// trusts the full check the import CLI ran on write. Read-only agent keys see it through list/get
// (owner decision 2026-11-13, private tracker card vertex-library-list-vertex-verdict).
export const StrategyVertexStudySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(QC_PORT_STUDY_KIND),
    verdict: QcPortStudySchema.shape.verdict,
  }),
  z.object({
    kind: z.literal(STRATEGY_BACKTEST_STUDY_KIND),
    verdict: StrategyBacktestStudySchema.shape.verdict,
  }),
]);

export const StrategySummarySchema = StrategySchema.extend({
  presetCount: z.number().int().nonnegative(),
  backtestCount: z.number().int().nonnegative(),
  latestBacktest: StrategyLatestBacktestSchema.nullable(),
  vertexStudy: StrategyVertexStudySchema.nullable(),
});

export const StrategyPresetSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  name: z.string(),
  values: z.record(z.string(), ParamValueSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const StrategyListInputSchema = z
  .object({
    search: z.string().max(100).optional(),
    status: StrategyStatusSchema.optional(),
    favorite: z.boolean().optional(),
    // null lists only strategies without a section.
    section: z.string().max(80).nullable().optional(),
    // Only strategies whose tags include this tag (exact match).
    tag: z.string().trim().min(1).max(64).optional(),
    sort: StrategySortSchema.optional(),
    limit: z.number().int().min(1).max(STRATEGY_LIST_MAX).optional(),
  })
  .strict();
export const StrategyListOutputSchema = z.object({
  strategies: z.array(StrategySummarySchema),
});

export const StrategyGetInputSchema = z.object({ id: IdSchema }).strict();
export const StrategyGetOutputSchema = z.object({
  strategy: StrategySummarySchema,
  presets: z.array(StrategyPresetSchema),
  backtests: z.array(BacktestResultSummarySchema),
});

export const StrategyCreateInputSchema = z
  .object({
    name: requiredText(200),
    kind: StrategyKindSchema,
    description: clearableText(2000).optional(),
    status: StrategyStatusSchema.optional(),
    sourceRef: clearableText(300).optional(),
    tags: TagsInputSchema.optional(),
    favorite: z.boolean().optional(),
    section: clearableText(80).optional(),
    params: ParamsInputSchema.optional(),
    priority: StrategyPrioritySchema.optional(),
    // null (or omitted on create) means no external claim.
    externalValidation: StrategyExternalValidationSchema.nullable().optional(),
  })
  .strict();

export const StrategyUpdateInputSchema = z
  .object({
    id: IdSchema,
    name: requiredText(200).optional(),
    description: clearableText(2000).optional(),
    status: StrategyStatusSchema.optional(),
    sourceRef: clearableText(300).optional(),
    tags: TagsInputSchema.optional(),
    favorite: z.boolean().optional(),
    section: clearableText(80).optional(),
    params: ParamsInputSchema.optional(),
    priority: StrategyPrioritySchema.optional(),
    // null (or omitted on create) means no external claim.
    externalValidation: StrategyExternalValidationSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        input.name,
        input.description,
        input.status,
        input.sourceRef,
        input.tags,
        input.favorite,
        input.section,
        input.params,
        input.priority,
        input.externalValidation,
      ].some((value) => value !== undefined),
    { message: "Change at least one field" }
  );

export const StrategyPresetSaveInputSchema = z
  .object({
    strategyId: IdSchema,
    name: requiredText(80),
    values: z
      .record(z.string().max(64), ParamValueSchema)
      .refine(
        (values) => Object.keys(values).length <= STRATEGY_PRESET_VALUES_LIMIT,
        {
          message: `At most ${STRATEGY_PRESET_VALUES_LIMIT} values`,
        }
      ),
  })
  .strict();

export const StrategyPresetRemoveInputSchema = z
  .object({ strategyId: IdSchema, id: IdSchema })
  .strict();
export const StrategyPresetRemoveOutputSchema = z.object({
  removed: z.literal(true),
});

const strategyLibrary = oc.errors(AGENT_OPS_API_ERRORS);

const list = strategyLibrary
  .route({
    method: "GET",
    path: "/strategy-library",
    operationId: "strategyLibrary.list",
    summary:
      "List strategies with filters; sharpe and return sorts use the latest linked backtest",
    tags: ["Strategy library"],
  })
  .input(StrategyListInputSchema)
  .output(StrategyListOutputSchema);

const get = strategyLibrary
  .route({
    method: "GET",
    path: "/strategy-library/{id}",
    operationId: "strategyLibrary.get",
    summary: "Read one strategy with presets and linked backtest summaries",
    tags: ["Strategy library"],
  })
  .input(StrategyGetInputSchema)
  .output(StrategyGetOutputSchema);

const create = strategyLibrary
  .route({
    method: "POST",
    path: "/strategy-library",
    operationId: "strategyLibrary.create",
    summary: "Create a strategy; the slug is derived from the name",
    tags: ["Strategy library"],
  })
  .input(StrategyCreateInputSchema)
  .output(StrategySchema);

const update = strategyLibrary
  .route({
    method: "PATCH",
    path: "/strategy-library/{id}",
    operationId: "strategyLibrary.update",
    summary: "Update strategy fields or its params schema",
    tags: ["Strategy library"],
  })
  .input(StrategyUpdateInputSchema)
  .output(StrategySchema);

const savePreset = strategyLibrary
  .route({
    method: "PUT",
    path: "/strategy-library/{strategyId}/presets",
    operationId: "strategyLibrary.presets.save",
    summary:
      "Create or replace a named preset; values are checked against the params schema",
    tags: ["Strategy library"],
  })
  .input(StrategyPresetSaveInputSchema)
  .output(StrategyPresetSchema);

const removePreset = strategyLibrary
  .route({
    method: "DELETE",
    path: "/strategy-library/{strategyId}/presets/{id}",
    operationId: "strategyLibrary.presets.remove",
    summary: "Delete a preset",
    tags: ["Strategy library"],
  })
  .input(StrategyPresetRemoveInputSchema)
  .output(StrategyPresetRemoveOutputSchema);

export const strategyLibraryContract = {
  list,
  get,
  create,
  update,
  presets: { save: savePreset, remove: removePreset },
};

export type StrategyKindValue = z.infer<typeof StrategyKindSchema>;
export type StrategyStatusValue = z.infer<typeof StrategyStatusSchema>;
export type StrategySortValue = z.infer<typeof StrategySortSchema>;
export type StrategyPriorityValue = z.infer<typeof StrategyPrioritySchema>;
export type StrategyExternalValidationOutput = z.infer<
  typeof StrategyExternalValidationSchema
>;
export type StrategyParamOutput = z.infer<typeof StrategyParamSchema>;
export type StrategyOutput = z.infer<typeof StrategySchema>;
export type StrategySummaryOutput = z.infer<typeof StrategySummarySchema>;
export type StrategyVertexStudy = z.infer<typeof StrategyVertexStudySchema>;
export type StrategyLatestBacktestOutput = z.infer<
  typeof StrategyLatestBacktestSchema
>;
export type StrategyPresetOutput = z.infer<typeof StrategyPresetSchema>;
export type StrategyListInput = z.input<typeof StrategyListInputSchema>;
export type StrategyGetOutput = z.infer<typeof StrategyGetOutputSchema>;
export type StrategyCreateInput = z.input<typeof StrategyCreateInputSchema>;
export type StrategyUpdateInput = z.input<typeof StrategyUpdateInputSchema>;
export type StrategyPresetSaveInput = z.input<
  typeof StrategyPresetSaveInputSchema
>;
