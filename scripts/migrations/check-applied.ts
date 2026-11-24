// What: Verifies that every database migration of a build commit is applied on QuantVPS Postgres
// before `infra/quantvps/restart-when-idle.sh` restarts `vertex-web`.
// QuantVPS applies individual migrations with `psql` (leaving `drizzle.__drizzle_migrations`
// incomplete), so this checker inspects the live catalog (tables, columns, nullability, indexes,
// constraints, replaced CHECK literals, and `vertex_research` grants) alongside the Drizzle ledger.
// Used by: scripts/db-migrations-check.ts (called by infra/quantvps/restart-when-idle.sh).
// See: infra/quantvps/README.md (Migration guard); card vertex-deploy-migration-guard.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const MIGRATIONS_DIR = "packages/db/migrations";
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;
const TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/u;
const SAFE_CHECK_LITERAL = /^[A-Za-z0-9_.^=:@/-]{1,80}$/u;
const PG_MAX_IDENT_BYTES = 63;
const APP_ROLE = "vertex_research";
const MAX_REASONS_PER_MIGRATION = 4;

export const EXIT_APPLIED = 0;
export const EXIT_ERROR = 2;
export const EXIT_UNAPPLIED = 3;

const TRACKED_PRIVILEGES: Record<string, true> = {
  DELETE: true,
  INSERT: true,
  SELECT: true,
  UPDATE: true,
};
const TABLE_CONSTRAINT_KEYWORDS: Record<string, true> = {
  CHECK: true,
  CONSTRAINT: true,
  EXCLUDE: true,
  FOREIGN: true,
  LIKE: true,
  PRIMARY: true,
  UNIQUE: true,
};

/**
 * Single read-only SQL query executed inside `vertex-postgres` against `vertex_research_development`.
 * Emits tab-delimited rows framed by `@@START` and `@@END` so truncated SSH responses fail closed.
 * Joins `pg_roles` on `r.oid` so `has_table_privilege` is never evaluated when `vertex_research`
 * does not exist (e.g. isolated test databases).
 */
export const MIGRATIONS_SNAPSHOT_SQL = `SELECT kind, a, b, c
FROM (
  SELECT 0 AS ord, '@@START'::text AS kind, ''::text AS a, ''::text AS b, ''::text AS c
  UNION ALL
  SELECT 1 AS ord, 'H'::text AS kind, h::text AS a, ''::text AS b, ''::text AS c
  FROM (
    SELECT unnest(
      CASE
        WHEN to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
        THEN xpath(
          '/table/row/hash/text()',
          query_to_xml('SELECT hash FROM drizzle.__drizzle_migrations', false, false, '')
        )
        ELSE ARRAY[]::xml[]
      END
    ) AS h
  ) ledger
  UNION ALL
  SELECT 2 AS ord, 'T'::text AS kind, tablename::text AS a, ''::text AS b, ''::text AS c
  FROM pg_catalog.pg_tables
  WHERE schemaname = 'public'
  UNION ALL
  SELECT 3 AS ord, 'C'::text AS kind, table_name::text AS a, column_name::text AS b, is_nullable::text AS c
  FROM information_schema.columns
  WHERE table_schema = 'public'
  UNION ALL
  SELECT 4 AS ord, 'I'::text AS kind, indexname::text AS a, ''::text AS b, ''::text AS c
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'
  UNION ALL
  SELECT 5 AS ord, 'K'::text AS kind, cls.relname::text AS a, con.conname::text AS b,
         replace(replace(replace(pg_catalog.pg_get_constraintdef(con.oid), E'\\r', ' '), E'\\n', ' '), E'\\t', ' ')::text AS c
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
  WHERE ns.nspname = 'public'
  UNION ALL
  SELECT 6 AS ord, 'R'::text AS kind, rolname::text AS a, ''::text AS b, ''::text AS c
  FROM pg_catalog.pg_roles
  WHERE rolname NOT LIKE 'pg_%'
  UNION ALL
  SELECT 7 AS ord, 'G'::text AS kind, tbl.tablename::text AS a, priv.p::text AS b, ''::text AS c
  FROM pg_catalog.pg_roles r
  JOIN pg_catalog.pg_tables tbl ON tbl.schemaname = 'public'
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS priv(p)
  WHERE r.rolname = '${APP_ROLE}'
    AND has_table_privilege(r.oid, format('%I.%I', 'public', tbl.tablename), priv.p)
  UNION ALL
  SELECT 9 AS ord, '@@END'::text AS kind, ''::text AS a, ''::text AS b, ''::text AS c
) snapshot
ORDER BY ord, a, b;`;

export interface MigrationSource {
  readonly sql: string;
  readonly tag: string;
}

export interface DatabaseSnapshot {
  readonly appGrants: ReadonlySet<string>;
  readonly columns: ReadonlyMap<string, string>;
  readonly constraints: ReadonlyMap<string, string>;
  readonly indexes: ReadonlySet<string>;
  readonly ledgerHashes: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
}

export type SnapshotParseResult =
  | { readonly ok: true; readonly snapshot: DatabaseSnapshot }
  | { readonly error: string; readonly ok: false };

export interface MissingMigration {
  readonly reasons: readonly string[];
  readonly tag: string;
}

export interface MigrationCheckReport {
  readonly checkedCount: number;
  readonly ledgerCount: number;
  readonly missing: readonly MissingMigration[];
  readonly ok: boolean;
  readonly structuralCount: number;
}

export type GitRunner = (
  gitDir: string,
  args: readonly string[]
) => { readonly ok: boolean; readonly stderr: string; readonly stdout: string };

export type MigrationLoadResult =
  | { readonly migrations: readonly MigrationSource[]; readonly ok: true }
  | { readonly error: string; readonly ok: false };

export interface MigrationCheckCliDeps {
  readonly readStdin: () => string;
  readonly runGit?: GitRunner;
  readonly stdout: (line: string) => void;
}

interface NullabilityRule {
  readonly nullable: "NO" | "YES";
  readonly tag: string;
}

interface IndexRule {
  readonly table: string;
  readonly tag: string;
}

interface RequiredLiteral {
  readonly literal: string;
  readonly tag: string;
}

interface MigrationExpectations {
  readonly columns: Map<string, string>;
  readonly constraints: Map<string, string>;
  readonly grants: Map<string, string>;
  readonly indexes: Map<string, IndexRule>;
  readonly nullability: Map<string, NullabilityRule>;
  readonly requiredLiterals: Map<string, RequiredLiteral[]>;
  readonly tables: Map<string, string>;
}

interface ExtractionState extends MigrationExpectations {
  readonly constraintLiterals: Map<string, Set<string>>;
  readonly previousConstraintLiterals: Map<string, Set<string>>;
  readonly previousRequiredLiterals: Map<string, RequiredLiteral[]>;
}

interface MutableSnapshot {
  readonly appGrants: Set<string>;
  readonly columns: Map<string, string>;
  readonly constraints: Map<string, string>;
  readonly indexes: Set<string>;
  readonly ledgerHashes: Set<string>;
  readonly roles: Set<string>;
  readonly tables: Set<string>;
}

const IDENT = '(?:(?:"public"|public)\\.)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)';
const SIMPLE_IDENT = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)';
const IDENT_END = "(?=$|[\\s;(,])";

const CREATE_TABLE_RE = new RegExp(
  `^CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${IDENT})\\s*\\(`,
  "iu"
);
const DROP_TABLE_RE = new RegExp(
  `^DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(${IDENT})${IDENT_END}`,
  "iu"
);
const ALTER_TABLE_RE = new RegExp(
  `^ALTER\\s+TABLE(?:\\s+ONLY)?\\s+(${IDENT})\\s+([\\s\\S]+)$`,
  "iu"
);
const ADD_COLUMN_RE = new RegExp(
  `^ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${SIMPLE_IDENT})${IDENT_END}`,
  "iu"
);
const DROP_COLUMN_RE = new RegExp(
  `^DROP\\s+COLUMN(?:\\s+IF\\s+EXISTS)?\\s+(${SIMPLE_IDENT})${IDENT_END}`,
  "iu"
);
const ALTER_NULL_RE = new RegExp(
  `^ALTER\\s+COLUMN\\s+(${SIMPLE_IDENT})\\s+(DROP|SET)\\s+NOT\\s+NULL\\b`,
  "iu"
);
const DROP_CONSTRAINT_RE = new RegExp(
  `^DROP\\s+CONSTRAINT(?:\\s+IF\\s+EXISTS)?\\s+(${SIMPLE_IDENT})${IDENT_END}`,
  "iu"
);
const RENAME_CONSTRAINT_RE = new RegExp(
  `^RENAME\\s+CONSTRAINT\\s+(${SIMPLE_IDENT})\\s+TO\\s+(${SIMPLE_IDENT})${IDENT_END}`,
  "iu"
);
const ADD_CONSTRAINT_RE = new RegExp(
  `^ADD\\s+CONSTRAINT\\s+(${SIMPLE_IDENT})\\s+([\\s\\S]+)$`,
  "iu"
);
const INLINE_CONSTRAINT_RE = new RegExp(
  `^CONSTRAINT\\s+(${SIMPLE_IDENT})\\s+([\\s\\S]+)$`,
  "iu"
);
const COLUMN_DEF_RE = new RegExp(`^(${SIMPLE_IDENT})\\s+`, "u");
const CREATE_INDEX_RE = new RegExp(
  `^CREATE(?:\\s+UNIQUE)?\\s+INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(${SIMPLE_IDENT})\\s+ON(?:\\s+ONLY)?\\s+(${IDENT})${IDENT_END}`,
  "iu"
);
const DROP_INDEX_RE = new RegExp(
  `^DROP\\s+INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+EXISTS)?\\s+(${IDENT})${IDENT_END}`,
  "iu"
);
/** Truncates a PostgreSQL identifier to NAMEDATALEN - 1 (63 UTF-8 bytes), folding unquoted names. */
export function truncatePgIdent(raw: string, quoted: boolean): string {
  const folded = quoted ? raw : raw.toLowerCase();
  if (Buffer.byteLength(folded, "utf8") <= PG_MAX_IDENT_BYTES) {
    return folded;
  }
  let bytes = 0;
  let result = "";
  for (const ch of folded) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > PG_MAX_IDENT_BYTES) {
      break;
    }
    result += ch;
    bytes += size;
  }
  return result;
}

/** Strips optional `public.` prefix and quotes from an identifier token, then truncates to 63 B. */
export function parseIdentToken(token: string): string {
  const withoutSchema = token.trim().replace(/^(?:"public"|public)\./iu, "");
  if (withoutSchema.startsWith('"') && withoutSchema.endsWith('"')) {
    return truncatePgIdent(
      withoutSchema.slice(1, -1).replace(/""/gu, '"'),
      true
    );
  }
  return truncatePgIdent(withoutSchema, false);
}

/** Advances past a quoted string/identifier starting at `start`, returning the next index. */
function scanQuoted(text: string, start: number, quote: "'" | '"'): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** Advances past a dollar-quoted block starting at `start`, or returns -1 if not at a tag. */
function scanDollarQuoted(text: string, start: number): number {
  const match = /^\$[A-Za-z0-9_]*\$/u.exec(text.slice(start));
  if (!match) {
    return -1;
  }
  const tag = match[0];
  const closeIdx = text.indexOf(tag, start + tag.length);
  return closeIdx >= 0 ? closeIdx + tag.length : text.length;
}

/** Strips SQL line and block comments while keeping single/double-quoted text intact. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(sql, i, ch);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "-" && next === "-") {
      const newline = sql.indexOf("\n", i + 2);
      i = newline >= 0 ? newline : sql.length;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close >= 0 ? close + 2 : sql.length;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Splits SQL text by a single-character delimiter at paren depth 0 outside quotes and $$ blocks. */
export function splitTopLevel(text: string, delimiter: ";" | ","): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = scanQuoted(text, i, ch);
      continue;
    }
    if (ch === "$") {
      const end = scanDollarQuoted(text, i);
      if (end >= 0) {
        i = end;
        continue;
      }
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")" && depth > 0) {
      depth -= 1;
    } else if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = scanQuoted(text, i, ch);
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function extractSafeCheckLiterals(expr: string): Set<string> {
  const literals = new Set<string>();
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      const end = scanQuoted(expr, i, "'");
      if (end > i + 1 && expr[end - 1] === "'") {
        const inner = expr.slice(i + 1, end - 1);
        if (!inner.includes("''") && SAFE_CHECK_LITERAL.test(inner)) {
          literals.add(inner);
        }
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return literals;
}

function recordGrantStatements(
  sqlFragment: string,
  tag: string,
  grants: Map<string, string>
): void {
  const grantRe =
    /\bGRANT\s+([A-Za-z,\s]+?)\s+ON\s+(?:TABLE\s+)?([^;]+?)\s+TO\s+(?:"vertex_research"|vertex_research)(?=$|[\s;])/giu;
  let match = grantRe.exec(sqlFragment);
  while (match !== null) {
    const privList = String(match[1])
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter((p) => Object.hasOwn(TRACKED_PRIVILEGES, p));
    const tableList = String(match[2])
      .split(",")
      .map((t) => parseIdentToken(t))
      .filter((t) => t.length > 0);
    for (const table of tableList) {
      for (const priv of privList) {
        grants.set(`${table}:${priv}`, tag);
      }
    }
    match = grantRe.exec(sqlFragment);
  }
}

function deleteByPrefix<T>(map: Map<string, T>, prefix: string): void {
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) {
      map.delete(key);
    }
  }
}

function recordCreateTable(
  stmt: string,
  match: RegExpExecArray,
  tag: string,
  state: ExtractionState
): void {
  const table = parseIdentToken(String(match[1]));
  const openIdx = stmt.indexOf("(", match[0].length - 1);
  const closeIdx = findMatchingParen(stmt, openIdx);
  state.tables.set(table, tag);
  if (closeIdx <= openIdx) {
    return;
  }
  for (const rawItem of splitTopLevel(stmt.slice(openIdx + 1, closeIdx), ",")) {
    const item = rawItem.trim();
    if (item.length === 0) {
      continue;
    }
    const conMatch = INLINE_CONSTRAINT_RE.exec(item);
    if (conMatch) {
      const conKey = `${table}.${parseIdentToken(String(conMatch[1]))}`;
      const conRest = String(conMatch[2]);
      state.constraints.set(conKey, tag);
      if (/^CHECK\b/iu.test(conRest)) {
        state.constraintLiterals.set(conKey, extractSafeCheckLiterals(conRest));
      }
      continue;
    }
    const colMatch = COLUMN_DEF_RE.exec(item);
    if (!colMatch) {
      continue;
    }
    const rawCol = String(colMatch[1]);
    if (
      !rawCol.startsWith('"') &&
      Object.hasOwn(TABLE_CONSTRAINT_KEYWORDS, rawCol.toUpperCase())
    ) {
      continue;
    }
    state.columns.set(`${table}.${parseIdentToken(rawCol)}`, tag);
  }
}

function recordDropTable(table: string, state: ExtractionState): void {
  state.tables.delete(table);
  const prefix = `${table}.`;
  deleteByPrefix(state.columns, prefix);
  deleteByPrefix(state.nullability, prefix);
  deleteByPrefix(state.constraints, prefix);
  deleteByPrefix(state.constraintLiterals, prefix);
  deleteByPrefix(state.requiredLiterals, prefix);
  deleteByPrefix(state.previousConstraintLiterals, prefix);
  deleteByPrefix(state.previousRequiredLiterals, prefix);
  deleteByPrefix(state.grants, `${table}:`);
}

function recordAddConstraint(
  conKey: string,
  conRest: string,
  tag: string,
  state: ExtractionState
): void {
  state.constraints.set(conKey, tag);
  if (!/^CHECK\b/iu.test(conRest)) {
    return;
  }
  const newLits = extractSafeCheckLiterals(conRest);
  const prevLits = state.previousConstraintLiterals.get(conKey);
  if (prevLits) {
    const carried: RequiredLiteral[] = [];
    const prevReqs = state.previousRequiredLiterals.get(conKey);
    if (prevReqs) {
      for (const req of prevReqs) {
        if (newLits.has(req.literal)) {
          carried.push(req);
        }
      }
    }
    for (const lit of newLits) {
      if (!prevLits.has(lit)) {
        carried.push({ literal: lit, tag });
      }
    }
    if (carried.length > 0) {
      state.requiredLiterals.set(conKey, carried);
    }
  }
  state.previousConstraintLiterals.delete(conKey);
  state.previousRequiredLiterals.delete(conKey);
  state.constraintLiterals.set(conKey, newLits);
}

function recordRenameConstraint(
  oldKey: string,
  newKey: string,
  tag: string,
  state: ExtractionState
): void {
  state.constraints.delete(oldKey);
  state.constraints.set(newKey, tag);
  const lits = state.constraintLiterals.get(oldKey);
  if (lits) {
    state.constraintLiterals.delete(oldKey);
    state.constraintLiterals.set(newKey, lits);
  }
  const reqs = state.requiredLiterals.get(oldKey);
  if (reqs) {
    state.requiredLiterals.delete(oldKey);
    state.requiredLiterals.set(newKey, reqs);
  }
}

function recordAlterTable(
  table: string,
  action: string,
  tag: string,
  state: ExtractionState
): void {
  const addCol = ADD_COLUMN_RE.exec(action);
  if (addCol) {
    state.columns.set(`${table}.${parseIdentToken(String(addCol[1]))}`, tag);
    return;
  }
  const dropCol = DROP_COLUMN_RE.exec(action);
  if (dropCol) {
    const colKey = `${table}.${parseIdentToken(String(dropCol[1]))}`;
    state.columns.delete(colKey);
    state.nullability.delete(colKey);
    return;
  }
  const alterNull = ALTER_NULL_RE.exec(action);
  if (alterNull) {
    const colKey = `${table}.${parseIdentToken(String(alterNull[1]))}`;
    const op = String(alterNull[2]).toUpperCase();
    state.nullability.set(colKey, {
      nullable: op === "DROP" ? "YES" : "NO",
      tag,
    });
    return;
  }
  const dropCon = DROP_CONSTRAINT_RE.exec(action);
  if (dropCon) {
    const conKey = `${table}.${parseIdentToken(String(dropCon[1]))}`;
    const prev = state.constraintLiterals.get(conKey);
    if (prev) {
      state.previousConstraintLiterals.set(conKey, prev);
    }
    const prevReqs = state.requiredLiterals.get(conKey);
    if (prevReqs) {
      state.previousRequiredLiterals.set(conKey, prevReqs);
    }
    state.constraints.delete(conKey);
    state.constraintLiterals.delete(conKey);
    state.requiredLiterals.delete(conKey);
    return;
  }
  const renameCon = RENAME_CONSTRAINT_RE.exec(action);
  if (renameCon) {
    recordRenameConstraint(
      `${table}.${parseIdentToken(String(renameCon[1]))}`,
      `${table}.${parseIdentToken(String(renameCon[2]))}`,
      tag,
      state
    );
    return;
  }
  const addCon = ADD_CONSTRAINT_RE.exec(action);
  if (addCon) {
    recordAddConstraint(
      `${table}.${parseIdentToken(String(addCon[1]))}`,
      String(addCon[2]),
      tag,
      state
    );
  }
}

const DO_BLOCK_PREFIX_RE =
  /^(?:BEGIN\b\s*|IF\b[\s\S]*?\bTHEN\b\s*|ELSIF\b[\s\S]*?\bTHEN\b\s*|ELSE\b\s*)+/iu;

function processDoBlock(
  stmt: string,
  tag: string,
  state: ExtractionState
): void {
  recordGrantStatements(stmt, tag, state.grants);
  const tagMatch = /\$[A-Za-z0-9_]*\$/u.exec(stmt);
  if (!tagMatch) {
    return;
  }
  const delim = tagMatch[0];
  const bodyStart = tagMatch.index + delim.length;
  const bodyEnd = stmt.indexOf(delim, bodyStart);
  if (bodyEnd <= bodyStart) {
    return;
  }
  const body = stmt.slice(bodyStart, bodyEnd);
  for (const rawPiece of splitTopLevel(body, ";")) {
    const inner = rawPiece.trim().replace(DO_BLOCK_PREFIX_RE, "").trim();
    if (inner.length > 0 && !/^(?:DO\s+\$|GRANT\b)/iu.test(inner)) {
      processStatement(inner, tag, state);
    }
  }
}

function processStatement(
  stmt: string,
  tag: string,
  state: ExtractionState
): void {
  if (/^DO\s+\$/iu.test(stmt)) {
    processDoBlock(stmt, tag, state);
    return;
  }
  if (/^GRANT\b/iu.test(stmt)) {
    recordGrantStatements(stmt, tag, state.grants);
    return;
  }
  const createTable = CREATE_TABLE_RE.exec(stmt);
  if (createTable) {
    recordCreateTable(stmt, createTable, tag, state);
    return;
  }
  const dropTable = DROP_TABLE_RE.exec(stmt);
  if (dropTable) {
    recordDropTable(parseIdentToken(String(dropTable[1])), state);
    return;
  }
  const alterTable = ALTER_TABLE_RE.exec(stmt);
  if (alterTable) {
    const table = parseIdentToken(String(alterTable[1]));
    for (const rawAction of splitTopLevel(String(alterTable[2]), ",")) {
      const action = rawAction.trim();
      if (action.length > 0) {
        recordAlterTable(table, action, tag, state);
      }
    }
    return;
  }
  const createIndex = CREATE_INDEX_RE.exec(stmt);
  if (createIndex) {
    state.indexes.set(parseIdentToken(String(createIndex[1])), {
      table: parseIdentToken(String(createIndex[2])),
      tag,
    });
    return;
  }
  const dropIndex = DROP_INDEX_RE.exec(stmt);
  if (dropIndex) {
    state.indexes.delete(parseIdentToken(String(dropIndex[1])));
  }
}

/** Computes the net structural requirements of an ordered sequence of SQL migrations. */
export function extractMigrationExpectations(
  migrations: readonly MigrationSource[]
): MigrationExpectations {
  const state: ExtractionState = {
    columns: new Map(),
    constraintLiterals: new Map(),
    constraints: new Map(),
    grants: new Map(),
    indexes: new Map(),
    nullability: new Map(),
    previousConstraintLiterals: new Map(),
    previousRequiredLiterals: new Map(),
    requiredLiterals: new Map(),
    tables: new Map(),
  };

  for (const migration of migrations) {
    const cleaned = stripSqlComments(migration.sql);
    for (const rawStatement of splitTopLevel(cleaned, ";")) {
      const stmt = rawStatement.trim();
      if (stmt.length > 0) {
        processStatement(stmt, migration.tag, state);
      }
    }
  }

  return {
    columns: state.columns,
    constraints: state.constraints,
    grants: state.grants,
    indexes: state.indexes,
    nullability: state.nullability,
    requiredLiterals: state.requiredLiterals,
    tables: state.tables,
  };
}

function applySnapshotRecord(
  line: string,
  snap: MutableSnapshot
): string | null {
  const [kind = "", a = "", b = "", c = ""] = line.split("\t");
  switch (kind) {
    case "H":
      if (a) {
        snap.ledgerHashes.add(a);
      }
      return null;
    case "T":
      if (a) {
        snap.tables.add(a);
      }
      return null;
    case "C":
      if (a && b) {
        snap.columns.set(`${a}.${b}`, c);
      }
      return null;
    case "I":
      if (a) {
        snap.indexes.add(a);
      }
      return null;
    case "K":
      if (a && b) {
        snap.constraints.set(`${a}.${b}`, c);
      }
      return null;
    case "R":
      if (a) {
        snap.roles.add(a);
      }
      return null;
    case "G":
      if (a && b) {
        snap.appGrants.add(`${a}:${b}`);
      }
      return null;
    default:
      return `unexpected record kind '${kind}' in Postgres migration snapshot`;
  }
}

/** Parses tab-delimited output produced by `MIGRATIONS_SNAPSHOT_SQL`. */
export function parsePostgresSnapshot(raw: string): SnapshotParseResult {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const startIdx = lines.findIndex((line) => line.split("\t")[0] === "@@START");
  const endIdx = lines.findIndex((line) => line.split("\t")[0] === "@@END");
  if (startIdx < 0 || endIdx <= startIdx) {
    return {
      error:
        "incomplete Postgres migration snapshot (missing @@START/@@END markers)",
      ok: false,
    };
  }

  const snap: MutableSnapshot = {
    appGrants: new Set(),
    columns: new Map(),
    constraints: new Map(),
    indexes: new Set(),
    ledgerHashes: new Set(),
    roles: new Set(),
    tables: new Set(),
  };

  for (const line of lines.slice(startIdx + 1, endIdx)) {
    const error = applySnapshotRecord(line, snap);
    if (error !== null) {
      return { error, ok: false };
    }
  }

  return { ok: true, snapshot: snap };
}

function addReason(
  reasonsByTag: Map<string, string[]>,
  tag: string,
  reason: string
): void {
  const existing = reasonsByTag.get(tag);
  if (existing) {
    existing.push(reason);
  } else {
    reasonsByTag.set(tag, [reason]);
  }
}

function checkTablesAndColumns(
  expectations: MigrationExpectations,
  snapshot: DatabaseSnapshot,
  structuralTags: Set<string>,
  reasonsByTag: Map<string, string[]>
): void {
  for (const [table, tag] of expectations.tables) {
    structuralTags.add(tag);
    if (!snapshot.tables.has(table)) {
      addReason(reasonsByTag, tag, `missing table ${table}`);
    }
  }
  for (const [colKey, tag] of expectations.columns) {
    structuralTags.add(tag);
    const table = colKey.slice(0, colKey.indexOf("."));
    if (snapshot.tables.has(table) && !snapshot.columns.has(colKey)) {
      addReason(reasonsByTag, tag, `missing column ${colKey}`);
    }
  }
  for (const [colKey, rule] of expectations.nullability) {
    structuralTags.add(rule.tag);
    const actual = snapshot.columns.get(colKey);
    if (actual !== undefined && actual !== rule.nullable) {
      const actualText = actual === "YES" ? "nullable" : "NOT NULL";
      const expectedText = rule.nullable === "YES" ? "nullable" : "NOT NULL";
      addReason(
        reasonsByTag,
        rule.tag,
        `column ${colKey} is ${actualText} (expected ${expectedText})`
      );
    }
  }
}

function checkIndexesAndConstraints(
  expectations: MigrationExpectations,
  snapshot: DatabaseSnapshot,
  structuralTags: Set<string>,
  reasonsByTag: Map<string, string[]>
): void {
  for (const [idx, rule] of expectations.indexes) {
    structuralTags.add(rule.tag);
    if (snapshot.tables.has(rule.table) && !snapshot.indexes.has(idx)) {
      addReason(reasonsByTag, rule.tag, `missing index ${idx}`);
    }
  }
  for (const [conKey, tag] of expectations.constraints) {
    structuralTags.add(tag);
    const table = conKey.slice(0, conKey.indexOf("."));
    if (snapshot.tables.has(table) && !snapshot.constraints.has(conKey)) {
      addReason(reasonsByTag, tag, `missing constraint ${conKey}`);
    }
  }
  for (const [conKey, reqs] of expectations.requiredLiterals) {
    const def = snapshot.constraints.get(conKey);
    for (const req of reqs) {
      structuralTags.add(req.tag);
      if (def !== undefined && !def.includes(`'${req.literal}'`)) {
        addReason(
          reasonsByTag,
          req.tag,
          `constraint ${conKey} missing '${req.literal}'`
        );
      }
    }
  }
}

function checkAppGrants(
  expectations: MigrationExpectations,
  snapshot: DatabaseSnapshot,
  structuralTags: Set<string>,
  reasonsByTag: Map<string, string[]>
): void {
  if (!snapshot.roles.has(APP_ROLE)) {
    return;
  }
  const missingGrants = new Map<string, string[]>();
  for (const [grantKey, tag] of expectations.grants) {
    structuralTags.add(tag);
    const [table = "", priv = ""] = grantKey.split(":");
    if (snapshot.tables.has(table) && !snapshot.appGrants.has(grantKey)) {
      const groupKey = `${tag}\t${table}`;
      const list = missingGrants.get(groupKey);
      if (list) {
        list.push(priv);
      } else {
        missingGrants.set(groupKey, [priv]);
      }
    }
  }
  for (const [groupKey, privs] of missingGrants) {
    const [tag = "", table = ""] = groupKey.split("\t");
    addReason(
      reasonsByTag,
      tag,
      `missing ${APP_ROLE} privilege ${privs.join(", ")} on ${table}`
    );
  }
}

/** Verifies every build migration's net structural expectations against a Postgres snapshot. */
export function checkAppliedMigrations(
  migrations: readonly MigrationSource[],
  snapshot: DatabaseSnapshot
): MigrationCheckReport {
  const expectations = extractMigrationExpectations(migrations);
  const reasonsByTag = new Map<string, string[]>();
  const structuralTags = new Set<string>();

  checkTablesAndColumns(expectations, snapshot, structuralTags, reasonsByTag);
  checkIndexesAndConstraints(
    expectations,
    snapshot,
    structuralTags,
    reasonsByTag
  );
  checkAppGrants(expectations, snapshot, structuralTags, reasonsByTag);

  let ledgerCount = 0;
  const missing: MissingMigration[] = [];
  for (const migration of migrations) {
    const hash = createHash("sha256").update(migration.sql).digest("hex");
    if (snapshot.ledgerHashes.has(hash)) {
      ledgerCount += 1;
    }
    const reasons = reasonsByTag.get(migration.tag);
    if (reasons && reasons.length > 0) {
      missing.push({ reasons, tag: migration.tag });
    }
  }

  return {
    checkedCount: migrations.length,
    ledgerCount,
    missing,
    ok: missing.length === 0,
    structuralCount: structuralTags.size,
  };
}

/** Default git command runner using `git -C <gitDir>`. */
export function defaultRunGit(
  gitDir: string,
  args: readonly string[]
): { readonly ok: boolean; readonly stderr: string; readonly stdout: string } {
  const result = spawnSync("git", ["-C", gitDir, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  };
}

function parseJournalTags(
  rawJson: string,
  commitSha: string
):
  | { readonly ok: true; readonly tags: readonly string[] }
  | { readonly error: string; readonly ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      error: `${JOURNAL_PATH} in commit ${commitSha} is not valid JSON`,
      ok: false,
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    return {
      error: `${JOURNAL_PATH} in commit ${commitSha} has no entries array`,
      ok: false,
    };
  }
  const tags: string[] = [];
  for (const entry of parsed.entries) {
    const tag =
      typeof entry === "object" &&
      entry !== null &&
      "tag" in entry &&
      typeof entry.tag === "string"
        ? entry.tag
        : "";
    if (!TAG_PATTERN.test(tag)) {
      return {
        error: `${JOURNAL_PATH} in commit ${commitSha} contains an invalid migration tag`,
        ok: false,
      };
    }
    tags.push(tag);
  }
  return { ok: true, tags };
}

/** Reads the Drizzle migration journal and all SQL files for a specific commit SHA. */
export function loadMigrationsFromGit(
  gitDir: string,
  commitSha: string,
  runGit: GitRunner = defaultRunGit
): MigrationLoadResult {
  const journalRes = runGit(gitDir, ["show", `${commitSha}:${JOURNAL_PATH}`]);
  if (!journalRes.ok) {
    return {
      error: `cannot read ${JOURNAL_PATH} from commit ${commitSha} in ${gitDir}`,
      ok: false,
    };
  }

  const parsedTags = parseJournalTags(journalRes.stdout, commitSha);
  if (!parsedTags.ok) {
    return parsedTags;
  }

  const migrations: MigrationSource[] = [];
  for (const tag of parsedTags.tags) {
    const sqlPath = `${MIGRATIONS_DIR}/${tag}.sql`;
    const sqlRes = runGit(gitDir, ["show", `${commitSha}:${sqlPath}`]);
    if (!sqlRes.ok) {
      return {
        error: `migration file ${sqlPath} is missing in commit ${commitSha}`,
        ok: false,
      };
    }
    migrations.push({ sql: sqlRes.stdout, tag });
  }

  return { migrations, ok: true };
}

const CLI_USAGE =
  "usage: node scripts/db-migrations-check.ts (--print-sql | --git-dir <dir> --sha <commit>)";

type ParsedCliArgs =
  | { readonly mode: "print-sql" }
  | { readonly gitDir: string; readonly mode: "check"; readonly sha: string }
  | { readonly mode: "usage" };

function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  if (args.length === 1 && args[0] === "--print-sql") {
    return { mode: "print-sql" };
  }
  let gitDir = "";
  let sha = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--git-dir") {
      gitDir = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--sha") {
      sha = args[i + 1] ?? "";
      i += 1;
    } else {
      return { mode: "usage" };
    }
  }
  if (gitDir.length === 0 || sha.length === 0) {
    return { mode: "usage" };
  }
  return { gitDir, mode: "check", sha };
}

/** CLI entry point invoked by `infra/quantvps/restart-when-idle.sh`. */
export function runMigrationCheckCli(
  args: readonly string[],
  deps: MigrationCheckCliDeps
): number {
  const parsedArgs = parseCliArgs(args);
  if (parsedArgs.mode === "print-sql") {
    deps.stdout(MIGRATIONS_SNAPSHOT_SQL);
    return EXIT_APPLIED;
  }
  if (parsedArgs.mode === "usage") {
    deps.stdout(CLI_USAGE);
    return EXIT_ERROR;
  }
  const { gitDir, sha } = parsedArgs;

  let rawSnapshot: string;
  try {
    rawSnapshot = deps.readStdin();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.stdout(
      `cannot read Postgres migration snapshot from stdin: ${detail}`
    );
    return EXIT_ERROR;
  }

  const parsed = parsePostgresSnapshot(rawSnapshot);
  if (!parsed.ok) {
    deps.stdout(parsed.error);
    return EXIT_ERROR;
  }

  const loaded = loadMigrationsFromGit(gitDir, sha, deps.runGit);
  if (!loaded.ok) {
    deps.stdout(loaded.error);
    return EXIT_ERROR;
  }

  const report = checkAppliedMigrations(loaded.migrations, parsed.snapshot);
  if (report.ok) {
    deps.stdout(
      `all ${report.checkedCount} build migrations applied (${report.structuralCount} structurally verified, ${report.ledgerCount} in drizzle ledger)`
    );
    return EXIT_APPLIED;
  }

  deps.stdout(
    `${report.missing.length} build migration(s) not applied on prod:`
  );
  for (const item of report.missing) {
    const shown = item.reasons.slice(0, MAX_REASONS_PER_MIGRATION);
    const extra = item.reasons.length - shown.length;
    const suffix = extra > 0 ? ` (+${extra} more)` : "";
    deps.stdout(`  - ${item.tag}: ${shown.join("; ")}${suffix}`);
  }
  return EXIT_UNAPPLIED;
}
