import { and, asc, eq, sql } from "drizzle-orm";

import {
  semanticRelationships,
  semanticSqlAttributes,
  semanticTerms,
} from "../schema/index.ts";
import { createRequestDatabase, type DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
} from "./repository-errors.ts";

// Agent semantic layer (docs/vertex-rebuild/agent-semantic-layer.md). The catalog is read by the
// assistant tools and edited and certified on the operator page. Any edit removes the certification of
// the edited row, and a certification names the version it approves (updatedAt), so an edit made after
// the operator read the row is never certified unseen. The assistant only runs certified definitions.
//
// Certified SQL runs read-only at the database, not behind a keyword filter (createSemanticReader):
// - its own connection, opened per run, that logs in as the LOGIN role "vertex_semantic_reader"
//   (migration 0056). The role has SELECT on a fixed table list, no write privilege and no membership
//   in the app role, so it cannot SET ROLE back to the app role; session changes die with the connection;
// - a READ ONLY transaction, so INSERT, UPDATE, DELETE, DDL and data-modifying CTEs fail;
// - the stored text is wrapped as one subquery with bound parameters, so pg uses the extended protocol,
//   which runs exactly one statement (no "; COMMIT; ..." escape);
// - a statement timeout and a row cap.
// Placeholders: $n in the stored text binds parameter n of the term, also inside quotes or comments.

export const SEMANTIC_READER_ROLE = "vertex_semantic_reader";

export type SemanticTermRow = typeof semanticTerms.$inferSelect;
export type SemanticSqlAttributeRow = typeof semanticSqlAttributes.$inferSelect;
export type SemanticRelationshipRow = typeof semanticRelationships.$inferSelect;

export type SemanticCatalog = Readonly<{
  terms: readonly SemanticTermRow[];
  attributes: readonly SemanticSqlAttributeRow[];
  relationships: readonly SemanticRelationshipRow[];
}>;

export type SemanticCatalogKind = "term" | "attribute" | "relationship";

// An undefined field is left unchanged.
export type SemanticTermPatch = Readonly<{
  label?: string | undefined;
  description?: string | undefined;
  synonyms?: readonly string[] | undefined;
  unit?: string | undefined;
}>;

export type SemanticAttributePatch = Readonly<{
  description?: string | undefined;
  sql?: string | undefined;
}>;

export type SemanticRelationshipPatch = Readonly<{
  description?: string | undefined;
}>;

export type SemanticCertification = Readonly<{
  kind: SemanticCatalogKind;
  id: string;
  /** updatedAt of the row version the operator reviewed. */
  expectedUpdatedAt: Date;
  certified: boolean;
  note: string | null;
  actor: string;
}>;

export type SemanticParamValue = string | number | null;
export type SemanticJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SemanticJsonValue[]
  | Readonly<{ [key: string]: SemanticJsonValue }>;
export type SemanticRow = Readonly<Record<string, SemanticJsonValue>>;

export type SemanticAttributeRunOptions = Readonly<{
  rowLimit: number;
  timeoutMs: number;
}>;

/** Why a certified attribute gave no rows: the reason is shown to the model and the operator. */
export type SemanticRunFailure =
  | "reader_unavailable"
  | "write_refused"
  | "permission_denied"
  | "timeout"
  | "invalid_sql"
  | "query_failed";

export type SemanticAttributeResult =
  | Readonly<{
      status: "ok";
      query: string;
      rows: readonly SemanticRow[];
      truncated: boolean;
    }>
  | Readonly<{
      status: "failed";
      query: string;
      failure: SemanticRunFailure;
      message: string;
    }>;

export interface SemanticLayerRepository {
  catalog: () => Promise<SemanticCatalog>;
  /** One term with its SQL attribute (null for feed and none terms), or null when the id is unknown. */
  term: (id: string) => Promise<Readonly<{
    term: SemanticTermRow;
    attribute: SemanticSqlAttributeRow | null;
  }> | null>;
  /** Edits a term and removes its certification. Null when the id is unknown. */
  updateTerm: (
    id: string,
    patch: SemanticTermPatch,
    actor: string
  ) => Promise<SemanticTermRow | null>;
  /** Edits a SQL attribute and removes its certification. Null when the id is unknown. */
  updateAttribute: (
    id: string,
    patch: SemanticAttributePatch,
    actor: string
  ) => Promise<SemanticSqlAttributeRow | null>;
  /** Edits a relationship and removes its certification. Null when the id is unknown. */
  updateRelationship: (
    id: string,
    patch: SemanticRelationshipPatch,
    actor: string
  ) => Promise<SemanticRelationshipRow | null>;
  /**
   * Sets or removes a certification of the row version the operator saw. "changed" when the row was
   * edited after that version (updatedAt differs); "not_found" when the id is unknown.
   */
  certify: (
    input: SemanticCertification
  ) => Promise<"certified" | "changed" | "not_found">;
}

const persistence = async <T>(operation: string, work: Promise<T>) => {
  try {
    return await work;
  } catch (error) {
    if (typeof databaseErrorDetails(error).code === "string") {
      throw new DatabasePersistenceError(operation);
    }
    throw error;
  }
};

export class SemanticSqlParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticSqlParameterError";
  }
}

const PLACEHOLDER = /\$(\d+)/g;

export type CertifiedStatement = Readonly<{ text: string; values: unknown[] }>;

/**
 * The stored SQL as one parameterized statement: `select * from (<sql>) as certified_result limit $k`.
 * `$n` binds params[n - 1]; positions are renumbered in order of first use, so an unused parameter is
 * not sent. The limit is always bound, so pg sends the statement with the extended protocol.
 */
export const certifiedStatement = (
  storedSql: string,
  params: readonly SemanticParamValue[],
  rowLimit: number
): CertifiedStatement => {
  const values: unknown[] = [];
  const renumbered = new Map<number, number>();
  const body = storedSql.replace(PLACEHOLDER, (_match, digits: string) => {
    const position = Number(digits);
    if (position < 1 || position > params.length) {
      throw new SemanticSqlParameterError(
        `The SQL uses $${position}, but the term has ${params.length} parameter(s).`
      );
    }
    let index = renumbered.get(position);
    if (index === undefined) {
      values.push(params[position - 1]);
      index = values.length;
      renumbered.set(position, index);
    }
    return `$${index}`;
  });
  values.push(rowLimit + 1);
  return {
    text: `select * from (\n${body}\n) as certified_result limit $${values.length}`,
    values,
  };
};

const toJson = (value: unknown): SemanticJsonValue => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJson(item)])
    );
  }
  return value as SemanticJsonValue;
};

// SQLSTATE -> failure.
const FAILURES: Readonly<Record<string, SemanticRunFailure>> = {
  "25006": "write_refused",
  "57014": "timeout",
  "42601": "invalid_sql",
  "42703": "invalid_sql",
  "42P01": "invalid_sql",
  "42883": "invalid_sql",
  "42804": "invalid_sql",
  "42501": "permission_denied",
  "28P01": "reader_unavailable",
  "28000": "reader_unavailable",
  "3D000": "reader_unavailable",
};

const FAILURE_MESSAGES: Readonly<Record<SemanticRunFailure, string>> = {
  reader_unavailable: `The read-only database login ${SEMANTIC_READER_ROLE} is not configured or cannot connect.`,
  write_refused:
    "The SQL tried to change data; the read-only transaction refused it.",
  permission_denied: `The read-only role ${SEMANTIC_READER_ROLE} may not do this (a table outside its grant, or a role change).`,
  timeout: "The SQL ran past its time limit.",
  invalid_sql: "The SQL is not valid for this database.",
  query_failed: "The SQL failed.",
};

export type SemanticReader = Readonly<{
  /** Runs a certified SQL text read-only as the reader login. `params` bind $1..$n in order. */
  run: (
    attribute: Pick<SemanticSqlAttributeRow, "sql">,
    params: readonly SemanticParamValue[],
    options: SemanticAttributeRunOptions
  ) => Promise<SemanticAttributeResult>;
}>;

/** The pg client a reader opens per run (a test seam). */
export type SemanticReaderClient = Readonly<{
  query: (
    config:
      | string
      | Readonly<{ queryMode?: "extended"; text: string; values?: unknown[] }>
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}>;

/** One open reader connection and its close (a test seam). */
export type SemanticReaderConnection = Readonly<{
  client: SemanticReaderClient;
  close: () => Promise<void>;
}>;

/**
 * Opens the reader connection with the same hardening as the app's request client
 * (createRequestDatabase): connection-string safety checks, PlanetScale and TLS negotiation rules, the
 * per-isolate connection cap, a client query timeout and an error listener for socket teardown.
 */
const openReaderConnection = async (
  connectionString: string
): Promise<SemanticReaderConnection> => {
  const resource = await createRequestDatabase({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  const client = (resource.db as unknown as { $client: SemanticReaderClient })
    .$client;
  return { client, close: resource.close };
};

const SQLSTATE = /^[0-9A-Z]{5}$/u;
const CONNECTION_SQLSTATES = /^(08|53|57P0)/u;

/** The configured reader URL, or null when it is missing, unparsable or not the reader login. */
const readerUrl = (connectionString: string | null): string | null => {
  if (connectionString === null || !URL.canParse(connectionString)) return null;
  const url = new URL(connectionString);
  const overridesLogin = ["user", "password"].some((key) =>
    url.searchParams.has(key)
  );
  return decodeURIComponent(url.username) === SEMANTIC_READER_ROLE &&
    !overridesLogin
    ? connectionString
    : null;
};

const IDENTITY_SQL =
  "select session_user::text as session_user, current_user::text as current_user, r.rolsuper, r.rolbypassrls, not exists (select 1 from pg_auth_members m where m.member = r.oid) as no_memberships from pg_roles r where r.rolname = current_user";

/**
 * A reader over its own connection string, which must log in as "vertex_semantic_reader" (checked in
 * the URL and again on the server: session and current user, not superuser, no RLS bypass, no role
 * membership). A missing
 * or wrong connection string makes every run fail with reader_unavailable, never fall back to the app
 * connection.
 */
export const createSemanticReader = (
  connectionString: string | null,
  open: (
    connectionString: string
  ) => Promise<SemanticReaderConnection> = openReaderConnection
): SemanticReader => {
  const url = readerUrl(connectionString);
  const failed = (
    query: string,
    failure: SemanticRunFailure,
    message?: string
  ) => ({
    failure,
    message: message ?? FAILURE_MESSAGES[failure],
    query,
    status: "failed" as const,
  });
  return {
    run: async (attribute, params, { rowLimit, timeoutMs }) => {
      let statement: CertifiedStatement;
      try {
        statement = certifiedStatement(attribute.sql, params, rowLimit);
      } catch (error) {
        const message = (error as SemanticSqlParameterError).message;
        return failed(attribute.sql, "invalid_sql", message);
      }
      if (url === null) return failed(statement.text, "reader_unavailable");
      const timeout = Number.isFinite(timeoutMs)
        ? Math.max(1, Math.trunc(timeoutMs))
        : 1;
      let connection: SemanticReaderConnection | undefined;
      let connected = false;
      try {
        connection = await open(url);
        connected = true;
        const { client } = connection;
        const [identity] = (await client.query(IDENTITY_SQL)).rows;
        if (
          identity?.["session_user"] !== SEMANTIC_READER_ROLE ||
          identity["current_user"] !== SEMANTIC_READER_ROLE ||
          identity["rolsuper"] !== false ||
          identity["rolbypassrls"] !== false ||
          identity["no_memberships"] !== true
        ) {
          return failed(
            statement.text,
            "reader_unavailable",
            `The reader connection is not the plain read-only role ${SEMANTIC_READER_ROLE}.`
          );
        }
        await client.query("begin read only");
        await client.query(`set local statement_timeout = ${timeout}`);
        const result = await client.query({
          queryMode: "extended",
          text: statement.text,
          values: statement.values,
        });
        await client.query("rollback");
        const rows = result.rows;
        return {
          query: statement.text,
          rows: rows
            .slice(0, rowLimit)
            .map((row) => toJson(row) as SemanticRow),
          status: "ok",
          truncated: rows.length > rowLimit,
        };
      } catch (error) {
        const code = databaseErrorDetails(error).code;
        if (typeof code === "string" && SQLSTATE.test(code)) {
          return failed(
            statement.text,
            CONNECTION_SQLSTATES.test(code)
              ? "reader_unavailable"
              : (FAILURES[code] ?? "query_failed")
          );
        }
        // Network codes (ECONNREFUSED, ...) and errors while connecting: the reader is unavailable.
        // Any other error after connecting is a bug: rethrow it.
        if (typeof code === "string" || !connected) {
          return failed(statement.text, "reader_unavailable");
        }
        throw error;
      } finally {
        await connection?.close().catch(() => undefined);
      }
    },
  };
};

export const createSemanticLayerRepository = (
  database: DatabaseExecutor,
  now: () => Date
): SemanticLayerRepository => {
  const edited = (actor: string) => ({
    certified: false,
    certifiedAt: null,
    certifiedBy: null,
    certificationNote: null,
    updatedAt: now(),
    updatedBy: actor,
  });
  const certification = (input: SemanticCertification) =>
    input.certified
      ? {
          certified: true,
          certifiedAt: now(),
          certifiedBy: input.actor,
          certificationNote: input.note,
        }
      : {
          certified: false,
          certifiedAt: null,
          certifiedBy: null,
          certificationNote: input.note,
        };

  return {
    catalog: async () => {
      const [terms, attributes, relationships] = await persistence(
        "semantic catalog read",
        Promise.all([
          database.select().from(semanticTerms).orderBy(asc(semanticTerms.id)),
          database
            .select()
            .from(semanticSqlAttributes)
            .orderBy(asc(semanticSqlAttributes.id)),
          database
            .select()
            .from(semanticRelationships)
            .orderBy(asc(semanticRelationships.id)),
        ])
      );
      return { attributes, relationships, terms };
    },
    term: async (id) => {
      const rows = await persistence(
        "semantic term read",
        database
          .select({ attribute: semanticSqlAttributes, term: semanticTerms })
          .from(semanticTerms)
          .leftJoin(
            semanticSqlAttributes,
            eq(semanticSqlAttributes.termId, semanticTerms.id)
          )
          .where(eq(semanticTerms.id, id))
          .limit(1)
      );
      const [row] = rows;
      return row === undefined
        ? null
        : { attribute: row.attribute, term: row.term };
    },
    updateTerm: async (id, patch, actor) => {
      const [row] = await persistence(
        "semantic term update",
        database
          .update(semanticTerms)
          .set({
            description: patch.description,
            label: patch.label,
            synonyms: patch.synonyms && [...patch.synonyms],
            unit: patch.unit,
            ...edited(actor),
          })
          .where(eq(semanticTerms.id, id))
          .returning()
      );
      return row ?? null;
    },
    updateAttribute: async (id, patch, actor) => {
      const [row] = await persistence(
        "semantic attribute update",
        database
          .update(semanticSqlAttributes)
          .set({ ...patch, ...edited(actor) })
          .where(eq(semanticSqlAttributes.id, id))
          .returning()
      );
      return row ?? null;
    },
    updateRelationship: async (id, patch, actor) => {
      const [row] = await persistence(
        "semantic relationship update",
        database
          .update(semanticRelationships)
          .set({ ...patch, ...edited(actor) })
          .where(eq(semanticRelationships.id, id))
          .returning()
      );
      return row ?? null;
    },
    certify: async (input) => {
      const table = {
        attribute: semanticSqlAttributes,
        relationship: semanticRelationships,
        term: semanticTerms,
      }[input.kind];
      const rows = await persistence(
        "semantic certification",
        database
          .update(table)
          .set(certification(input))
          .where(
            and(
              eq(table.id, input.id),
              // updated_at keeps microseconds; the client saw milliseconds.
              sql`date_trunc('milliseconds', ${table.updatedAt}) = ${input.expectedUpdatedAt}`
            )
          )
          .returning({ id: table.id })
      );
      if (rows.length > 0) return "certified";
      const found = await persistence(
        "semantic certification",
        database
          .select({ id: table.id })
          .from(table)
          .where(eq(table.id, input.id))
          .limit(1)
      );
      return found.length > 0 ? "changed" : "not_found";
    },
  };
};
