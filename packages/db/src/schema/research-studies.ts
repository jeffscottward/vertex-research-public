// What: frozen research studies, for example the ADX/RVOL filter study on the /backtests page. One row
// per study: the whole study document in `summary` (jsonb), with its spec reference and run date
// copied out for listing. The API and the import CLI validate `summary` with FilterStudySchema
// (packages/api/src/contracts/research-studies.ts) on write and on read.
// Research only: nothing here places, changes or cancels an order.
// Used by: packages/db/src/server/research-studies.ts. See: docs/vertex-rebuild/research-studies.md.
import { sql } from "drizzle-orm";
import {
  check,
  date,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const researchStudies = pgTable(
  "research_studies",
  {
    createdAt: utc("created_at").defaultNow().notNull(),
    id: text("id").primaryKey(),
    ranOn: date("ran_on", { mode: "string" }).notNull(),
    specRef: text("spec_ref").notNull(),
    summary: jsonb("summary")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    updatedAt: utc("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "research_studies_fields_check",
      sql`${table.id} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.id}) <= 64 and length(${table.specRef}) between 1 and 300`
    ),
    check(
      "research_studies_summary_check",
      sql`jsonb_typeof(${table.summary}) = 'object' and octet_length(${table.summary}::text) <= 262144 and ${table.summary} ->> 'id' = ${table.id} and ${table.summary} ->> 'spec' = ${table.specRef}`
    ),
  ]
);
