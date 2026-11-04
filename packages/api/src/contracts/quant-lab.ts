import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  ResearchPaperStageSchema,
  ResearchPaperVerdictSchema,
} from "./agent-ops.ts";
import { StrategyStatusSchema } from "./strategy-library.ts";

// Quant Lab read side (P2b): frozen strategy specs from SSRN papers, each with its paper, strategy
// and newest backtest, plus recent SSRN captures. Read-only and operator-only. Records are written by
// the local recorder (`bun run vertex:quantlab:record`), never through oRPC. Research only: a
// verdict does not authorize a trade.

export const QUANT_LAB_STUDIES_MAX = 50;
export const QUANT_LAB_CAPTURES_MAX = 20;
export const QUANT_LAB_PAPER_CLAIMS_MAX = 50;
const QUANT_LAB_JSON_KEYS_MAX = 40;
const QUANT_LAB_JSON_ITEMS_MAX = 100;
const QUANT_LAB_JSON_TEXT_MAX = 4000;

export const QUANT_LAB_API_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: { message: "Quant Lab storage unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

// Stored JSON (paper_claims, our_reading) is bounded to two levels: an object whose values are
// scalars, arrays of scalars or flat objects of scalars. Deeper or larger values fail validation.
const JsonKeySchema = z.string().min(1).max(64);
const JsonScalarSchema = z.union([
  z.string().max(QUANT_LAB_JSON_TEXT_MAX),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const boundedKeys = <T extends z.ZodType<Record<string, unknown>>>(schema: T) =>
  schema.refine(
    (value) => Object.keys(value).length <= QUANT_LAB_JSON_KEYS_MAX,
    { message: `At most ${QUANT_LAB_JSON_KEYS_MAX} keys` }
  );
const JsonValueSchema = z.union([
  JsonScalarSchema,
  z.array(JsonScalarSchema).max(QUANT_LAB_JSON_ITEMS_MAX),
  boundedKeys(z.record(JsonKeySchema, JsonScalarSchema)),
]);
export const QuantLabJsonObjectSchema = boundedKeys(
  z.record(JsonKeySchema, JsonValueSchema)
);
export type QuantLabJsonObject = z.infer<typeof QuantLabJsonObjectSchema>;

export const QuantLabStudyPaperSchema = z.object({
  id: z.string().min(1),
  // DOI for SSRN papers (10.2139/ssrn.<id>).
  identifier: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  stage: ResearchPaperStageSchema,
  title: z.string(),
  verdict: ResearchPaperVerdictSchema,
});

export const QuantLabStudyStrategySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  status: StrategyStatusSchema,
});

export const QuantLabStudyBacktestSchema = z.object({
  createdAt: z.date(),
  id: z.string().min(1),
  instruments: z.string(),
  maxDrawdown: z.number().nullable(),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  // One line per preregistered criterion (PASS/FAIL) plus provenance lines.
  notes: z.string().nullable(),
  periodEnd: z.string(),
  periodStart: z.string(),
});

export const QuantLabStudySchema = z.object({
  backtest: QuantLabStudyBacktestSchema.nullable(),
  createdAt: z.date(),
  hypothesis: z.string(),
  id: z.string().min(1),
  name: z.string(),
  // Our interpretation, gaps, assumptions and deviations.
  ourReading: QuantLabJsonObjectSchema,
  paper: QuantLabStudyPaperSchema.nullable(),
  // Verbatim quotes from the paper, usually { quote, locator }.
  paperClaims: z
    .array(QuantLabJsonObjectSchema)
    .max(QUANT_LAB_PAPER_CLAIMS_MAX),
  specKey: z.string().min(1),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  strategy: QuantLabStudyStrategySchema.nullable(),
});
export type QuantLabStudy = z.infer<typeof QuantLabStudySchema>;

export const QuantLabCaptureSchema = z.object({
  capturedAt: z.date(),
  doi: z.string(),
  id: z.string().min(1),
  // "retained" or "metadata_only:<reason>".
  pdfStatus: z.string(),
  ssrnId: z.string(),
  title: z.string(),
  topic: z.string(),
  url: z.string(),
  version: z.string(),
});
export type QuantLabCapture = z.infer<typeof QuantLabCaptureSchema>;

export const QuantLabListInputSchema = z.object({}).strict();
export const QuantLabListOutputSchema = z.object({
  captures: z.array(QuantLabCaptureSchema).max(QUANT_LAB_CAPTURES_MAX),
  studies: z.array(QuantLabStudySchema).max(QUANT_LAB_STUDIES_MAX),
});
export type QuantLabListOutput = z.infer<typeof QuantLabListOutputSchema>;

const list = oc
  .errors(QUANT_LAB_API_ERRORS)
  .route({
    method: "GET",
    operationId: "quantLab.list",
    path: "/quant-lab",
    summary:
      "List Quant Lab studies (spec, paper, strategy, newest backtest) and recent SSRN captures",
    tags: ["Quant Lab"],
  })
  .input(QuantLabListInputSchema)
  .output(QuantLabListOutputSchema);

export const quantLabContract = { list };
