import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Agent semantic layer (docs/vertex-rebuild/agent-semantic-layer.md): certified business terms, the
// reviewed SQL that answers a Postgres term, and the join paths between the tables those SQL texts read.
// The assistant reads terms through `semanticTerms.query`; the model chooses a term and parameters and
// never writes SQL. SQL attributes run in a read-only transaction as the NOLOGIN role
// `vertex_semantic_reader` (migration 0056), which has SELECT on the tables listed there and nothing else.

export type SemanticTermSourceValue = "postgres" | "feed" | "none";
export type SemanticParamTypeValue = "text" | "number";
export type SemanticRelationshipCardinalityValue = "many_to_one" | "one_to_one";

/** One parameter of a term. A SQL attribute binds parameter n of its term as `$n`. */
export type SemanticParamSpec = Readonly<{
  name: string;
  type: SemanticParamTypeValue;
  required: boolean;
  description: string;
  options?: readonly string[];
}>;

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

// A function, not a shared object: each table gets its own column builders.
const certification = () => ({
  certified: boolean("certified").notNull().default(false),
  certifiedAt: utc("certified_at"),
  certifiedBy: text("certified_by"),
  certificationNote: text("certification_note"),
  updatedAt: utc("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
});

export const semanticTerms = pgTable(
  "semantic_terms",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    synonyms: jsonb("synonyms").$type<string[]>().notNull().default([]),
    source: text("source").$type<SemanticTermSourceValue>().notNull(),
    feedPath: text("feed_path"),
    mappedColumns: jsonb("mapped_columns")
      .$type<string[]>()
      .notNull()
      .default([]),
    unit: text("unit").notNull(),
    params: jsonb("params").$type<SemanticParamSpec[]>().notNull().default([]),
    ...certification(),
  },
  (table) => [
    check(
      "semantic_terms_check",
      sql`${table.id} ~ '^[a-z][a-z0-9_]{1,62}$' and ${table.source} in ('postgres', 'feed', 'none') and (${table.source} = 'feed') = (${table.feedPath} is not null) and (not ${table.certified} or ${table.certifiedAt} is not null) and length(${table.label}) between 1 and 120 and length(${table.description}) between 1 and 2000 and length(${table.unit}) between 1 and 40 and jsonb_typeof(${table.synonyms}) = 'array' and jsonb_typeof(${table.mappedColumns}) = 'array' and jsonb_typeof(${table.params}) = 'array'`
    ),
  ]
);

/**
 * What one row of a SQL attribute stands for (migration 0058). A term has at most one attribute per
 * grain. The backtest terms have two: `strategy` (latest succeeded engine run per linked strategy) and
 * `run_spec` (latest succeeded engine run per run spec: symbol, timeframe, rule, stop loss, take profit, cost and date range, for runs with no strategy).
 * The other attributes have one grain each: gate candidate, deployment request, drift monitor.
 */
export const SEMANTIC_ATTRIBUTE_GRAINS = [
  "strategy",
  "run_spec",
  "candidate",
  "request",
  "monitor",
] as const;
export type SemanticAttributeGrainValue =
  (typeof SEMANTIC_ATTRIBUTE_GRAINS)[number];

export const semanticSqlAttributes = pgTable(
  "semantic_sql_attributes",
  {
    id: text("id").primaryKey(),
    termId: text("term_id")
      .notNull()
      .references(() => semanticTerms.id, { onDelete: "cascade" }),
    grain: text("grain")
      .$type<SemanticAttributeGrainValue>()
      .notNull()
      .default("strategy"),
    description: text("description").notNull(),
    sql: text("sql").notNull(),
    ...certification(),
  },
  (table) => [
    uniqueIndex("semantic_sql_attributes_term_grain_idx").on(
      table.termId,
      table.grain
    ),
    check(
      "semantic_sql_attributes_check",
      sql`${table.id} ~ '^[a-z][a-z0-9_]{1,62}$' and length(${table.sql}) between 1 and 8000 and length(${table.description}) between 1 and 2000 and (not ${table.certified} or ${table.certifiedAt} is not null)`
    ),
    check(
      "semantic_sql_attributes_grain_check",
      sql`${table.grain} in ('strategy', 'run_spec', 'candidate', 'request', 'monitor')`
    ),
  ]
);

export const semanticRelationships = pgTable(
  "semantic_relationships",
  {
    id: text("id").primaryKey(),
    fromTable: text("from_table").notNull(),
    fromColumn: text("from_column").notNull(),
    toTable: text("to_table").notNull(),
    toColumn: text("to_column").notNull(),
    cardinality: text("cardinality")
      .$type<SemanticRelationshipCardinalityValue>()
      .notNull(),
    description: text("description").notNull(),
    ...certification(),
  },
  (table) => [
    check(
      "semantic_relationships_check",
      sql`${table.id} ~ '^[a-z][a-z0-9_]{1,62}$' and ${table.cardinality} in ('many_to_one', 'one_to_one') and length(${table.description}) between 1 and 2000 and (not ${table.certified} or ${table.certifiedAt} is not null)`
    ),
  ]
);
