import { oc } from "@orpc/contract";
import { z } from "zod";

// Agent semantic layer (semanticTerms.*, docs/vertex-rebuild/agent-semantic-layer.md). A catalog of
// certified business terms in Postgres (migration 0056). The assistant calls list and query (MCP tools
// terms_list and terms_query); the model chooses a term and its parameters and never writes SQL.
// Postgres terms run their certified SQL read-only as the role vertex_semantic_reader; feed terms read
// the live IBKR account through the vertex-portfolio feed, never the paper exec node. The operator page
// /semantic-terms reads the full catalog, edits it and certifies it. Read only for trading: nothing
// here places, routes or approves an order or changes a risk setting.

const SEMANTIC_TERM_SOURCES = ["postgres", "feed", "none"] as const;
const SEMANTIC_QUERY_STATUSES = ["ok", "unknown", "not_available"] as const;
const SEMANTIC_CATALOG_KINDS = ["term", "attribute", "relationship"] as const;
const SEMANTIC_PARAM_TYPES = ["text", "number"] as const;
/**
 * What one row of a SQL attribute stands for (migration 0058). The backtest terms have two attributes:
 * `strategy` (latest succeeded engine run per linked strategy) and `run_spec` (latest succeeded engine
 * run per run spec: symbol, timeframe, rule, stop loss, take profit, cost and date range, for runs with no
 * strategy). Same list as the database check.
 */
export const SEMANTIC_ATTRIBUTE_GRAINS = [
  "strategy",
  "run_spec",
  "candidate",
  "request",
  "monitor",
] as const;
/** How the assistant answer and the operator page name the rows of one grain. */
export const SEMANTIC_GRAIN_LABELS: Readonly<
  Record<(typeof SEMANTIC_ATTRIBUTE_GRAINS)[number], string>
> = {
  candidate: "per gate candidate",
  monitor: "per drift monitor",
  request: "per deployment request",
  run_spec:
    "per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy",
  strategy: "per strategy (engine runs linked to a strategy)",
};
// not_run: certified but not run (the term is not certified, or another attribute failed).
const SEMANTIC_GROUPING_STATUSES = [
  "ok",
  "unknown",
  "not_certified",
  "not_run",
] as const;
const SEMANTIC_RELATIONSHIP_CARDINALITIES = [
  "many_to_one",
  "one_to_one",
] as const;

/** Most rows one query returns to the model. */
export const SEMANTIC_QUERY_MAX_ROWS = 100;
const TEXT_MAX = 2000;
const SQL_MAX = 8000;

const IdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,62}$/, "Lowercase letters, digits and _");
const text = (max: number) => z.string().trim().min(1).max(max);
const IsoSchema = z.string().max(40);

export const SemanticParamSpecSchema = z
  .object({
    description: z.string().max(400),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    options: z.array(z.string().max(40)).max(20).optional(),
    required: z.boolean(),
    type: z.enum(SEMANTIC_PARAM_TYPES),
  })
  .strict();

const CertificationSchema = {
  certificationNote: z.string().max(TEXT_MAX).nullable(),
  certified: z.boolean(),
  certifiedAt: IsoSchema.nullable(),
  certifiedBy: z.string().max(200).nullable(),
  updatedAt: IsoSchema,
  updatedBy: z.string().max(200).nullable(),
};

const SemanticGrainSchema = z.enum(SEMANTIC_ATTRIBUTE_GRAINS);

/** One term as the assistant sees it in terms_list. */
export const SemanticTermSummarySchema = z
  .object({
    // A Postgres term is certified only when at least one of its SQL attributes is certified too.
    certified: z.boolean(),
    description: z.string().max(TEXT_MAX),
    // Postgres terms: one entry per SQL attribute (row grouping), with its own certification.
    groupings: z
      .array(
        z
          .object({ certified: z.boolean(), grain: SemanticGrainSchema })
          .strict()
      )
      .max(SEMANTIC_ATTRIBUTE_GRAINS.length),
    id: IdSchema,
    label: z.string().max(120),
    params: z.array(SemanticParamSpecSchema).max(10),
    source: z.enum(SEMANTIC_TERM_SOURCES),
    synonyms: z.array(z.string().max(120)).max(40),
    unit: z.string().max(40),
  })
  .strict();

export const SemanticTermsListInputSchema = z.object({}).strict();
const SemanticTermsListOutputSchema = z
  .object({ terms: z.array(SemanticTermSummarySchema).max(200) })
  .strict();

export const SemanticParamValueSchema = z.union([
  z.string().trim().max(120),
  z.number().finite(),
  z.null(),
]);

export const SemanticTermQueryInputSchema = z
  .object({
    params: z
      .record(z.string().max(32), SemanticParamValueSchema)
      .refine((value) => Object.keys(value).length <= 10, {
        message: "At most 10 parameters",
      })
      .optional(),
    term: IdSchema,
  })
  .strict();

const CellSchema = z.union([
  z.string().max(TEXT_MAX),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const SemanticRowSchema = z.record(z.string().max(64), CellSchema);

/** One SQL attribute of a Postgres term in a query answer and whether it ran. */
export const SemanticGroupingResultSchema = z
  .object({
    attribute: IdSchema,
    certified: z.boolean(),
    grain: SemanticGrainSchema,
    rowCount: z.number().int().nonnegative(),
    status: z.enum(SEMANTIC_GROUPING_STATUSES),
  })
  .strict();

export const SemanticTermQueryOutputSchema = z
  .object({
    answer: z.string().max(TEXT_MAX),
    asOf: IsoSchema.nullable(),
    certified: z.boolean(),
    // Postgres terms: every SQL attribute; rows of a term with several carry a `grain` cell.
    groupings: z
      .array(SemanticGroupingResultSchema)
      .max(SEMANTIC_ATTRIBUTE_GRAINS.length),
    label: z.string().max(120).nullable(),
    params: z.record(z.string().max(32), SemanticParamValueSchema),
    // The certified SQL that ran (with $n parameters; several are joined, each after a
    // `-- grain <grain>` line) or the feed path; null when nothing ran.
    query: z
      .string()
      .max(SEMANTIC_ATTRIBUTE_GRAINS.length * (SQL_MAX + 200))
      .nullable(),
    rowCount: z.number().int().nonnegative(),
    rows: z.array(SemanticRowSchema).max(SEMANTIC_QUERY_MAX_ROWS),
    source: z.enum(SEMANTIC_TERM_SOURCES).nullable(),
    status: z.enum(SEMANTIC_QUERY_STATUSES),
    term: IdSchema,
    truncated: z.boolean(),
    unit: z.string().max(40).nullable(),
  })
  .strict();

const SemanticCatalogTermSchema = z
  .object({
    description: z.string().max(TEXT_MAX),
    feedPath: z.string().max(400).nullable(),
    id: IdSchema,
    label: z.string().max(120),
    mappedColumns: z.array(z.string().max(200)).max(40),
    params: z.array(SemanticParamSpecSchema).max(10),
    source: z.enum(SEMANTIC_TERM_SOURCES),
    synonyms: z.array(z.string().max(120)).max(40),
    unit: z.string().max(40),
    ...CertificationSchema,
  })
  .strict();

const SemanticCatalogAttributeSchema = z
  .object({
    description: z.string().max(TEXT_MAX),
    grain: SemanticGrainSchema,
    id: IdSchema,
    sql: z.string().max(SQL_MAX),
    termId: IdSchema,
    ...CertificationSchema,
  })
  .strict();

const SemanticCatalogRelationshipSchema = z
  .object({
    cardinality: z.enum(SEMANTIC_RELATIONSHIP_CARDINALITIES),
    description: z.string().max(TEXT_MAX),
    fromColumn: z.string().max(64),
    fromTable: z.string().max(64),
    id: IdSchema,
    toColumn: z.string().max(64),
    toTable: z.string().max(64),
    ...CertificationSchema,
  })
  .strict();

const SemanticCatalogInputSchema = z.object({}).strict();
export const SemanticCatalogOutputSchema = z
  .object({
    attributes: z.array(SemanticCatalogAttributeSchema).max(200),
    canWrite: z.boolean(),
    relationships: z.array(SemanticCatalogRelationshipSchema).max(200),
    terms: z.array(SemanticCatalogTermSchema).max(200),
  })
  .strict();

export const SemanticCatalogUpdateInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      description: text(TEXT_MAX).optional(),
      id: IdSchema,
      kind: z.literal("term"),
      label: text(120).optional(),
      synonyms: z.array(text(120)).max(40).optional(),
      unit: text(40).optional(),
    })
    .strict(),
  z
    .object({
      description: text(TEXT_MAX).optional(),
      id: IdSchema,
      kind: z.literal("attribute"),
      sql: text(SQL_MAX).optional(),
    })
    .strict(),
  z
    .object({
      description: text(TEXT_MAX).optional(),
      id: IdSchema,
      kind: z.literal("relationship"),
    })
    .strict(),
]);

export const SemanticCatalogCertifyInputSchema = z
  .object({
    certified: z.boolean(),
    expectedUpdatedAt: z.iso.datetime(),
    id: IdSchema,
    kind: z.enum(SEMANTIC_CATALOG_KINDS),
    note: z.string().trim().max(TEXT_MAX).nullable(),
  })
  .strict();

const SemanticCatalogWriteOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type SemanticParamSpec = z.infer<typeof SemanticParamSpecSchema>;
export type SemanticParamValue = z.infer<typeof SemanticParamValueSchema>;
export type SemanticTermSummary = z.infer<typeof SemanticTermSummarySchema>;
export type SemanticTermQueryInput = z.infer<
  typeof SemanticTermQueryInputSchema
>;
export type SemanticTermQueryOutput = z.infer<
  typeof SemanticTermQueryOutputSchema
>;
export type SemanticRow = z.infer<typeof SemanticRowSchema>;
export type SemanticGroupingResult = z.infer<
  typeof SemanticGroupingResultSchema
>;
export type SemanticCatalogOutput = z.infer<typeof SemanticCatalogOutputSchema>;

export const SEMANTIC_TERMS_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  CONFLICT: {
    message: "The row changed after you read it; reload and review it again",
    status: 409,
  },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "Not found", status: 404 },
  STORAGE_ERROR: { message: "Semantic catalog unavailable", status: 503 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const semantic = oc.errors(SEMANTIC_TERMS_API_ERRORS);
const tags = ["Semantic terms"];

const list = semantic
  .route({
    method: "GET",
    operationId: "semanticTerms.list",
    path: "/semantic-terms",
    summary: "Certified business terms the assistant can query",
    tags,
  })
  .input(SemanticTermsListInputSchema)
  .output(SemanticTermsListOutputSchema);

const query = semantic
  .route({
    method: "POST",
    operationId: "semanticTerms.query",
    path: "/semantic-terms/query",
    summary:
      "Answer one certified term: value, rows, the SQL or feed path that produced them, and a status",
    tags,
  })
  .input(SemanticTermQueryInputSchema)
  .output(SemanticTermQueryOutputSchema);

const catalog = semantic
  .route({
    method: "GET",
    operationId: "semanticTerms.catalog",
    path: "/semantic-terms/catalog",
    summary:
      "Operator: every term, SQL attribute and relationship with its certification",
    tags,
  })
  .input(SemanticCatalogInputSchema)
  .output(SemanticCatalogOutputSchema);

const update = semantic
  .route({
    method: "POST",
    operationId: "semanticTerms.update",
    path: "/semantic-terms/update",
    summary:
      "Operator: edit a term, SQL attribute or relationship (removes its certification)",
    tags,
  })
  .input(SemanticCatalogUpdateInputSchema)
  .output(SemanticCatalogWriteOutputSchema);

const certify = semantic
  .route({
    method: "POST",
    operationId: "semanticTerms.certify",
    path: "/semantic-terms/certify",
    summary:
      "Operator: certify or uncertify a term, SQL attribute or relationship",
    tags,
  })
  .input(SemanticCatalogCertifyInputSchema)
  .output(SemanticCatalogWriteOutputSchema);

export const semanticTermsContract = { catalog, certify, list, query, update };
