import { oc } from "@orpc/contract";
import { z } from "zod";

// Read-only research lenses (ported from the vertex-research workspace views ?view=rotation and
// ?view=deep-value). Source: JSON documents written by the rig data jobs and served on the QuantVPS
// tailnet (VERTEX_RESEARCH_LENSES_URL, bearer VERTEX_DEPLOY_STATUS_TOKEN). The on-demand TRUE SLAP
// score reads Yahoo Finance daily bars and SEC EDGAR XBRL facts. Research only: nothing here can
// place, change or cancel an order.

export const ROTATION_PERIODS = ["1D", "1M", "3M", "6M"] as const;
export const ROTATION_CAPS = ["large", "mid", "small"] as const;
export const DEEP_VALUE_CRITERION_IDS = [
  "timeHorizon",
  "risk",
  "upside",
  "entry",
  "substance",
  "longevity",
  "alignment",
  "price",
] as const;
export const RESEARCH_LENS_MAX_ROWS = 5000;
// One-letter class suffix allowed (BRK.B, BF-B), as in the vertex-research endpoint.
export const DEEP_VALUE_TICKER_PATTERN = /^[A-Z]{1,5}(?:[.-][A-Z])?$/u;

const num = z.number().nullable();
const text = (max: number) => z.string().max(max);
const list = <T extends z.ZodType>(item: T) =>
  z.array(item).max(RESEARCH_LENS_MAX_ROWS);

// Upstream documents are parsed with these schemas too; unknown keys are dropped (zod strip mode).

export const RotationBriefSchema = z.object({
  marketCap: num,
  ret: num,
  symbol: text(24),
});

const rotationCellShape = {
  breadth: num,
  laggards: list(RotationBriefSchema),
  leaders: list(RotationBriefSchema),
  n: z.number().int().nonnegative(),
  retCapWeighted: num,
  retMedian: num,
};

export const RotationCellSchema = z.object({
  ...rotationCellShape,
  symbols: list(RotationBriefSchema).optional(),
});

export const RotationStandoutSchema = RotationBriefSchema.extend({
  cap: z.enum(ROTATION_CAPS),
  industry: text(160),
  sector: text(120),
  z: z.number(),
});

export const RotationIndustrySchema = z.object({
  ...rotationCellShape,
  cells: z.object({
    large: RotationCellSchema.optional(),
    mid: RotationCellSchema.optional(),
    small: RotationCellSchema.optional(),
  }),
  industry: text(160),
  quintile: z.number().int().min(1).max(5).optional(),
  rank: z.number().int().positive().optional(),
  sector: text(120),
  standouts: list(RotationStandoutSchema),
});

export const RotationSectorSchema = z.object({
  ...rotationCellShape,
  industries: list(text(160)),
  sector: text(120),
});

export const RotationRankedSchema = z.object({
  industry: text(160),
  n: z.number().int().nonnegative(),
  retMedian: num,
  sector: text(120),
});

export const RotationPeriodSchema = z.object({
  bars: z.number().int().positive(),
  bottom: list(RotationRankedSchema),
  industries: list(RotationIndustrySchema),
  n: z.number().int().nonnegative(),
  sectors: list(RotationSectorSchema),
  standouts: list(RotationStandoutSchema),
  top: list(RotationRankedSchema),
});

export const RotationOurNameSchema = z.object({
  cap: z.enum(ROTATION_CAPS).nullable().optional(),
  cell1M: text(16).optional(),
  cell3M: text(16).optional(),
  covered: z.boolean(),
  industry: text(160).optional(),
  opportunity: z.boolean().optional(),
  roles: list(text(40)),
  sector: text(120).optional(),
  symbol: text(24),
});

export const RotationSourceSchema = z.object({
  bars: text(300),
  failed: z.number().int().nonnegative().optional(),
  finvizMap: text(300).optional(),
  metadata: text(300),
  staleDropped: z.number().int().nonnegative().optional(),
});

export const RotationCapLabelsSchema = z.object({
  large: text(60),
  mid: text(60),
  small: text(60),
});

export const RotationMatrixDocumentSchema = z.object({
  asOf: text(40).nullable(),
  capLabels: RotationCapLabelsSchema,
  generatedAt: text(40),
  ours: list(RotationOurNameSchema),
  periods: z.object({
    "1D": RotationPeriodSchema,
    "1M": RotationPeriodSchema,
    "3M": RotationPeriodSchema,
    "6M": RotationPeriodSchema,
  }),
  source: RotationSourceSchema.optional(),
  universeSize: z.number().int().nonnegative(),
});

export const RotationMatrixInputSchema = z
  .object({ period: z.enum(ROTATION_PERIODS).default("1M") })
  .strict();

export const RotationMatrixOutputSchema = RotationPeriodSchema.extend({
  asOf: text(40).nullable(),
  capLabels: RotationCapLabelsSchema,
  generatedAt: text(40),
  ours: list(RotationOurNameSchema),
  period: z.enum(ROTATION_PERIODS),
  receivedAt: text(40),
  source: RotationSourceSchema.nullable(),
  universeSize: z.number().int().nonnegative(),
});

export const DeepValueCriterionSchema = z.object({
  id: z.enum(DEEP_VALUE_CRITERION_IDS),
  label: text(60),
  lens: z.enum(["TRUE", "SLAP"]),
  proxy: text(300),
});

export const DeepValueCriterionResultSchema = z.object({
  evidence: text(400),
  score: z.number().int().min(0).max(2).nullable(),
});

export const DeepValueFlagSchema = z.object({
  id: text(40),
  label: text(200),
});

export const DeepValueRowSchema = z.object({
  asOf: text(40).nullable(),
  coverage: z.number().int().min(0).max(8),
  criteria: z.record(text(40), DeepValueCriterionResultSchema),
  errors: list(text(300)).optional(),
  flags: list(DeepValueFlagSchema),
  industry: text(160).nullable(),
  marketCap: num,
  metrics: z.record(text(40), z.union([z.number(), z.boolean(), z.null()])),
  name: text(200).nullable(),
  normalized: num,
  price: num,
  rank: z.number().int().positive().optional(),
  reasons: list(text(500)),
  roles: list(text(40)),
  symbol: text(24),
  total: z.number().int().min(0).max(16),
});

export const DeepValueUniverseCutoffsSchema = z.object({
  maxMarketCap: z.number(),
  maxPrice: z.number(),
  minDollarVolume: z.number(),
  minMarketCap: z.number(),
});

export const DeepValueCutoffsSchema = z.object({
  flags: z.record(text(40), z.number()),
  note: text(400),
  scoring: z.record(text(40), z.union([z.number(), z.array(z.number())])),
  universe: DeepValueUniverseCutoffsSchema,
});

export const DeepValueCountsSchema = z.object({
  ours: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  universe: z.number().int().nonnegative(),
  withErrors: z.number().int().nonnegative(),
});

export const DeepValuePeerMedianSchema = z.object({
  evSales: z.number(),
  n: z.number().int().positive(),
});

const deepValueShape = {
  counts: DeepValueCountsSchema,
  criteria: z.array(DeepValueCriterionSchema).max(8),
  cutoffs: DeepValueCutoffsSchema,
  generatedAt: text(40),
  method: text(200),
  rows: list(DeepValueRowSchema),
  sources: z.record(text(40), text(300)),
};

export const DeepValueDocumentSchema = z.object({
  ...deepValueShape,
  industryBySymbol: z.record(text(24), text(200)).optional(),
  industryMedians: z.record(text(200), DeepValuePeerMedianSchema).optional(),
});

export const DeepValueInputSchema = z.object({}).strict();

export const DeepValueOutputSchema = z.object({
  ...deepValueShape,
  receivedAt: text(40),
});

export const DeepValueScoreInputSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(DEEP_VALUE_TICKER_PATTERN, "Invalid ticker"),
  })
  .strict();

export const DeepValueScoreOutputSchema = DeepValueRowSchema.extend({
  errors: list(text(300)),
  peerMedian: DeepValuePeerMedianSchema.nullable(),
});

export const RESEARCH_LENS_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_CONFIGURED: {
    message: "Research lens endpoint not configured",
    status: 503,
  },
  NOT_FOUND: { message: "No data for this request", status: 404 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "Research lens service unavailable", status: 503 },
  UPSTREAM_ERROR: { message: "Research lens request failed", status: 502 },
} as const;

const researchLens = oc.errors(RESEARCH_LENS_ERRORS);

const rotationMatrix = researchLens
  .route({
    method: "GET",
    operationId: "researchLenses.rotationMatrix",
    path: "/research-lenses/rotation-matrix",
    summary:
      "Sector, industry and cap-bucket rotation matrix for one period, with our names tagged",
    tags: ["Research lenses"],
  })
  .input(RotationMatrixInputSchema)
  .output(RotationMatrixOutputSchema);

const deepValue = researchLens
  .route({
    method: "GET",
    operationId: "researchLenses.deepValue",
    path: "/research-lenses/deep-value",
    summary:
      "Stored TRUE SLAP deep value ranking (8 criteria, 0-2 each, with evidence and risk flags)",
    tags: ["Research lenses"],
  })
  .input(DeepValueInputSchema)
  .output(DeepValueOutputSchema);

const deepValueScore = researchLens
  .route({
    method: "GET",
    operationId: "researchLenses.deepValueScore",
    path: "/research-lenses/deep-value/score",
    summary:
      "Score one ticker on the TRUE SLAP criteria from Yahoo daily bars and SEC XBRL facts",
    tags: ["Research lenses"],
  })
  .input(DeepValueScoreInputSchema)
  .output(DeepValueScoreOutputSchema);

export const researchLensesContract = {
  deepValue,
  deepValueScore,
  rotationMatrix,
};

export type RotationPeriod = (typeof ROTATION_PERIODS)[number];
export type RotationCap = (typeof ROTATION_CAPS)[number];
export type RotationBrief = z.infer<typeof RotationBriefSchema>;
export type RotationCell = z.infer<typeof RotationCellSchema>;
export type RotationIndustry = z.infer<typeof RotationIndustrySchema>;
export type RotationSector = z.infer<typeof RotationSectorSchema>;
export type RotationStandout = z.infer<typeof RotationStandoutSchema>;
export type RotationOurName = z.infer<typeof RotationOurNameSchema>;
export type RotationMatrixDocument = z.infer<
  typeof RotationMatrixDocumentSchema
>;
export type RotationMatrixInput = z.input<typeof RotationMatrixInputSchema>;
export type RotationMatrixOutput = z.infer<typeof RotationMatrixOutputSchema>;
export type DeepValueCriterionId = (typeof DEEP_VALUE_CRITERION_IDS)[number];
export type DeepValueCriterion = z.infer<typeof DeepValueCriterionSchema>;
export type DeepValueCriterionResult = z.infer<
  typeof DeepValueCriterionResultSchema
>;
export type DeepValueFlag = z.infer<typeof DeepValueFlagSchema>;
export type DeepValueRow = z.infer<typeof DeepValueRowSchema>;
export type DeepValuePeerMedian = z.infer<typeof DeepValuePeerMedianSchema>;
export type DeepValueDocument = z.infer<typeof DeepValueDocumentSchema>;
export type DeepValueOutput = z.infer<typeof DeepValueOutputSchema>;
export type DeepValueScoreInput = z.infer<typeof DeepValueScoreInputSchema>;
export type DeepValueScoreOutput = z.infer<typeof DeepValueScoreOutputSchema>;
