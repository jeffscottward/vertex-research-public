import { oc } from "@orpc/contract";
import { z } from "zod";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";

// Saved strategy definitions (backtestRuns.definitions.*): append-only revisions of one strategy
// definition (see ../strategy-dsl.ts). `save` without an id starts a new definition at revision 1;
// with an id it appends the next revision, or returns the latest revision unchanged when the
// definition content (SHA-256 of its canonical JSON) is equal. `validate` checks a value and stores
// nothing. Operator-only; save needs an operator session (agent keys are refused, so agents save
// only through an approved assistant confirm card); read keys may validate, list and get. Research and
// backtest use only; a saved definition never creates, routes or simulates broker orders.

export const STRATEGY_DEFINITION_LIST_DEFAULT = 50;
export const STRATEGY_DEFINITION_LIST_MAX = 100;
/** Revisions listed in the history of one definition (newest first). */
export const STRATEGY_DEFINITION_HISTORY_MAX = 50;
export const STRATEGY_DEFINITION_NOTE_MAX = 500;

const id = z.string().trim().min(1).max(128);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionNumber = z.number().int().min(1).max(1_000_000);

export const StrategyDefinitionValidateInputSchema = z
  .object({
    /** Any JSON value; the result lists every schema issue. */
    definition: z.unknown(),
  })
  .strict();

export const StrategyDefinitionIssueSchema = z.object({
  message: z.string(),
  /** Dot path, for example "entry.all.0.left.length"; "" is the root. */
  path: z.string(),
});

export const StrategyDefinitionValidateOutputSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({
      /** The definition with defaults applied. */
      definition: StrategyDefinitionSchema,
      ok: z.literal(true),
      /** SHA-256 of the canonical JSON; equal definitions have equal values. */
      sha256,
    }),
    z.object({
      issues: z.array(StrategyDefinitionIssueSchema),
      ok: z.literal(false),
    }),
  ]
);

export const StrategyDefinitionSaveInputSchema = z
  .object({
    definition: StrategyDefinitionSchema,
    /** Omit to start a new definition; set to append a revision to an existing one. */
    id: id.optional(),
    note: z.string().trim().max(STRATEGY_DEFINITION_NOTE_MAX).optional(),
  })
  .strict();

export const StrategyDefinitionRevisionSchema = z.object({
  createdAt: z.date(),
  definition: StrategyDefinitionSchema,
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  revision: revisionNumber,
  sha256,
});

export const StrategyDefinitionSaveOutputSchema = z.object({
  /** False when the definition equals the latest revision; nothing new was stored. */
  created: z.boolean(),
  revision: StrategyDefinitionRevisionSchema,
});

export const StrategyDefinitionListInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(STRATEGY_DEFINITION_LIST_MAX)
      .default(STRATEGY_DEFINITION_LIST_DEFAULT),
  })
  .strict();

export const StrategyDefinitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: revisionNumber,
  sha256,
  /** Time of the latest revision. */
  updatedAt: z.date(),
});

export const StrategyDefinitionListOutputSchema = z.object({
  definitions: z
    .array(StrategyDefinitionSummarySchema)
    .max(STRATEGY_DEFINITION_LIST_MAX),
});

export const StrategyDefinitionGetInputSchema = z
  .object({
    id,
    /** Omit for the latest revision. */
    revision: revisionNumber.optional(),
  })
  .strict();

export const StrategyDefinitionHistoryEntrySchema = z.object({
  createdAt: z.date(),
  name: z.string(),
  note: z.string().nullable(),
  revision: revisionNumber,
  sha256,
});

export const StrategyDefinitionGetOutputSchema = z.object({
  history: z
    .array(StrategyDefinitionHistoryEntrySchema)
    .max(STRATEGY_DEFINITION_HISTORY_MAX),
  revision: StrategyDefinitionRevisionSchema,
});

export const STRATEGY_DEFINITION_ERRORS = {
  BAD_REQUEST: { message: "Invalid strategy definition request", status: 400 },
  CONFLICT: {
    message: "Another revision was saved at the same time; save again",
    status: 409,
  },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Strategy definition not found", status: 404 },
  STORAGE_ERROR: {
    message: "Strategy definition storage unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const definitions = oc.errors(STRATEGY_DEFINITION_ERRORS);
const tags = ["Strategy definitions"];

const validate = definitions
  .route({
    method: "POST",
    operationId: "backtestRuns.definitions.validate",
    path: "/strategy-definitions/validate",
    summary: "Validate a strategy definition without storing it",
    tags,
  })
  .input(StrategyDefinitionValidateInputSchema)
  .output(StrategyDefinitionValidateOutputSchema);

const save = definitions
  .route({
    method: "POST",
    operationId: "backtestRuns.definitions.save",
    path: "/strategy-definitions",
    summary:
      "Save a strategy definition as a new definition or as the next revision of one (research only)",
    tags,
  })
  .input(StrategyDefinitionSaveInputSchema)
  .output(StrategyDefinitionSaveOutputSchema);

const list = definitions
  .route({
    method: "GET",
    operationId: "backtestRuns.definitions.list",
    path: "/strategy-definitions",
    summary: "List saved strategy definitions with their latest revision",
    tags,
  })
  .input(StrategyDefinitionListInputSchema)
  .output(StrategyDefinitionListOutputSchema);

const get = definitions
  .route({
    method: "GET",
    operationId: "backtestRuns.definitions.get",
    path: "/strategy-definitions/{id}",
    summary: "Read one revision of a strategy definition and its history",
    tags,
  })
  .input(StrategyDefinitionGetInputSchema)
  .output(StrategyDefinitionGetOutputSchema);

export const strategyDefinitionsContract = { get, list, save, validate };

export type StrategyDefinitionSaveInput = z.input<
  typeof StrategyDefinitionSaveInputSchema
>;
export type StrategyDefinitionRevision = z.infer<
  typeof StrategyDefinitionRevisionSchema
>;
export type StrategyDefinitionSummary = z.infer<
  typeof StrategyDefinitionSummarySchema
>;
export type StrategyDefinitionValidateOutput = z.infer<
  typeof StrategyDefinitionValidateOutputSchema
>;
export type StrategyDefinitionGetOutput = z.infer<
  typeof StrategyDefinitionGetOutputSchema
>;
