import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";

// biome-ignore lint/suspicious/noExplicitAny: in-memory SQL/JSON fixture rows are untyped transport data; tests assert shapes via schemas, and unknown cascades casts into every consumer test
type FixtureValue = any;
type Row = Record<string, FixtureValue>;
interface Query {
  sql: string;
  params: unknown[];
}
interface Fixture {
  db: Database;
  table: (name: string) => Row[];
  calls: Query[];
  state: { afterQuery: (query: Query) => void };
}
type Truth = boolean | null;

// External SQL boundary ONLY. No accepted records, grants, proofs, plans, leases
// or worker/original-authority objects are manufactured here. Owners supply ALL
// inserted rows. The original fixture retains rollback/serialization/ALS and
// commit-ACK failure injection. This is not PostgreSQL concurrency qualification.
const unsupported = (value: string): never => {
  throw new Error(`Unsupported chat worker SQL boundary: ${value}`);
};
const conflict = (): never => {
  throw Object.assign(new Error("fixture unique constraint"), {
    code: "23505",
  });
};
const immutable = (): never => {
  throw Object.assign(new Error("fixture immutable privacy metadata"), {
    code: "23514",
  });
};
const unquote = (value: string): string => value.replaceAll('"', "");
const split = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0,
    quoted = false,
    start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && char === "(") depth += 1;
    if (!quoted && char === ")") depth -= 1;
    if (!quoted && depth === 0 && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || depth !== 0) return unsupported(value);
  parts.push(value.slice(start).trim());
  return parts;
};
// WHERE/projection sources are evaluated per row; their parameterized text is a
// small fixed set, so tokenize each source once. Unsupported text still throws.
const tokenCache = new Map<string, readonly string[]>();
const tokens = (value: string): readonly string[] => {
  const cached = tokenCache.get(value);
  if (cached !== undefined) return cached;
  const found: string[] = [];
  const pattern =
    /\s+|'(?:''|[^'])*'|"[a-zA-Z_0-9]+"|\$[0-9]+|::|>=|<=|<>|!=|@>|[=<>(),.]|-?[0-9]+|[a-zA-Z_][a-zA-Z_0-9]*/gy;
  let position = 0;
  while (position < value.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(value);
    if (match === null) return unsupported(value.slice(position));
    position = pattern.lastIndex;
    if (match[0].trim() !== "") found.push(unquote(match[0]));
  }
  tokenCache.set(value, Object.freeze(found));
  return found;
};
const isNull = (value: unknown): boolean =>
  value === null || value === undefined;
const same = (left: unknown, right: unknown): boolean => {
  if (
    typeof left !== typeof right &&
    [typeof left, typeof right].every(
      (kind) => kind === "number" || kind === "string"
    ) &&
    /^-?\d+$/.test(String(left)) &&
    /^-?\d+$/.test(String(right))
  )
    return BigInt(String(left)) === BigInt(String(right));
  return left === right;
};
const compare = (left: unknown, right: unknown): number => {
  if (/^-?\d+$/.test(String(left)) && /^-?\d+$/.test(String(right)))
    return BigInt(String(left)) < BigInt(String(right))
      ? -1
      : BigInt(String(left)) > BigInt(String(right))
        ? 1
        : 0;
  return String(left) < String(right)
    ? -1
    : String(left) > String(right)
      ? 1
      : 0;
};
const contains = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.every((item) => actual.some((entry) => contains(entry, item)))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Row)[key], value)
      )
    );
  return actual === expected;
};
type Evaluator = (query: Query, row: Row) => unknown;
const CASTS = ["jsonb", "text", "numeric", "bigint", "integer"];
const COMPARISONS = ["=", "<>", "!=", "<", ">", "<=", ">=", "@>"];
// Same grammar, evaluation order and NULL logic as reading the tokens per row,
// but each source is parsed once into closures. Every operand is evaluated
// (no short-circuit), exactly as before.
const compile = (source: string): Evaluator => {
  const input = tokens(source);
  let index = 0;
  const peek = (): string => (input[index] ?? "").toLowerCase();
  const take = (): string => {
    const value = input[index];
    index += 1;
    return value ?? unsupported(source);
  };
  const need = (value: string): void => {
    if (take().toLowerCase() !== value) unsupported(source);
  };
  const truth = (value: unknown): Truth => {
    if (isNull(value)) return null;
    if (typeof value !== "boolean") return unsupported(source);
    return value;
  };
  const term = (): Evaluator => {
    const token = take(),
      lower = token.toLowerCase();
    if (token === "(") {
      const inner = parseOr();
      need(")");
      return inner;
    }
    if (token.startsWith("$")) {
      const position = Number(token.slice(1)) - 1;
      return (query) => query.params[position];
    }
    if (token.startsWith("'")) {
      const text = token.slice(1, -1).replaceAll("''", "'");
      return () => text;
    }
    if (lower === "null") return () => null;
    if (lower === "true" || lower === "false") {
      const flag = lower === "true";
      return () => flag;
    }
    if (/^-?\d+$/.test(token)) return () => token;
    if (lower === "coalesce" && peek() === "(") {
      take();
      const entries = [primary()];
      while (peek() === ",") {
        take();
        entries.push(primary());
      }
      need(")");
      return (query, row) =>
        entries
          .map((entry) => entry(query, row))
          .find((value) => !isNull(value)) ?? null;
    }
    let qualifier: string | null = null,
      field = token;
    if (peek() === ".") {
      take();
      qualifier = token;
      field = take();
    }
    const owner = qualifier;
    return (_query, row) =>
      owner !== null && row[owner] !== undefined
        ? row[owner][field]
        : row[field];
  };
  const primary = (): Evaluator => {
    const base = term();
    const casts: string[] = [];
    while (peek() === "::") {
      take();
      const cast = take().toLowerCase();
      if (!CASTS.includes(cast)) return unsupported(source);
      casts.push(cast);
    }
    if (casts.length === 0) return base;
    return (query, row) => {
      let value = base(query, row);
      for (const cast of casts) {
        if (cast === "jsonb" && typeof value === "string")
          value = JSON.parse(value);
        else if (cast === "text" && !isNull(value)) value = String(value);
      }
      return value;
    };
  };
  const atom = (): Evaluator => {
    const left = primary(),
      op = peek();
    if (op === "is") {
      take();
      const negated = peek() === "not";
      if (negated) take();
      if (peek() === "distinct") {
        take();
        need("from");
        const right = primary();
        return (query, row) => {
          const a = left(query, row),
            b = right(query, row);
          const equal =
            (isNull(a) && isNull(b)) ||
            (!(isNull(a) || isNull(b)) && same(a, b));
          return negated ? equal : !equal;
        };
      }
      need("null");
      return (query, row) => {
        const value = left(query, row);
        return negated ? !isNull(value) : isNull(value);
      };
    }
    if (op === "in") {
      take();
      need("(");
      const options = [primary()];
      while (peek() === ",") {
        take();
        options.push(primary());
      }
      need(")");
      return (query, row) => {
        const value = left(query, row);
        const values = options.map((option) => option(query, row));
        if (isNull(value)) return null;
        if (values.some((entry) => !isNull(entry) && same(value, entry)))
          return true;
        return values.some(isNull) ? null : false;
      };
    }
    if (COMPARISONS.includes(op)) {
      take();
      const right = primary();
      return (query, row) => {
        const a = left(query, row),
          b = right(query, row);
        if (isNull(a) || isNull(b)) return null;
        if (op === "=") return same(a, b);
        if (op === "<>" || op === "!=") return !same(a, b);
        if (op === "@>") return contains(a, b);
        const order = compare(a, b);
        return op === "<"
          ? order < 0
          : op === ">"
            ? order > 0
            : op === "<="
              ? order <= 0
              : order >= 0;
      };
    }
    return left;
  };
  // Left-associative AND/OR: evaluate the next operand, then test both truths.
  const chain = (
    next: () => Evaluator,
    keyword: string,
    combine: (a: Truth, b: Truth) => Truth
  ): Evaluator => {
    const first = next();
    const rest: Evaluator[] = [];
    while (peek() === keyword) {
      take();
      rest.push(next());
    }
    if (rest.length === 0) return first;
    return (query, row) => {
      let left = first(query, row);
      for (const operand of rest) {
        const right = operand(query, row);
        left = combine(truth(left), truth(right));
      }
      return left;
    };
  };
  const parseAnd = (): Evaluator =>
    chain(atom, "and", (a, b) =>
      a === false || b === false
        ? false
        : a === null || b === null
          ? null
          : true
    );
  const parseOr = (): Evaluator =>
    chain(parseAnd, "or", (a, b) =>
      a === true || b === true ? true : a === null || b === null ? null : false
    );
  const result = parseOr();
  if (index !== input.length) return unsupported(source);
  return result;
};
// Each source is parsed on its first evaluation, as before, then reused.
const compiled = new Map<string, Evaluator>();
const evaluate = (source: string, query: Query, row: Row): unknown => {
  let evaluator = compiled.get(source);
  if (evaluator === undefined) {
    evaluator = compile(source);
    compiled.set(source, evaluator);
  }
  return evaluator(query, row);
};
const matches = (source: string | undefined, query: Query, row: Row): boolean =>
  source === undefined ||
  source.trim() === "" ||
  evaluate(source, query, row) === true;
// Rows hold JSON-like data. Copy plain records and arrays directly, which is
// much faster than structuredClone; other objects (bytes, dates) still use it.
const copy = (value: FixtureValue): FixtureValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copy);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return structuredClone(value);
  const result: Row = {};
  for (const key of Object.keys(value)) result[key] = copy(value[key]);
  return result;
};
const projection = (
  source: string | undefined,
  query: Query,
  row: Row
): Row => {
  if (source === undefined) return {};
  if (source.trim() === "*") return copy(row);
  const result: Row = {};
  for (const item of split(source)) {
    const selected = /^(.*?)\s+as\s+([a-z_0-9]+)$/i.exec(item);
    const expression = selected?.[1] ?? item,
      name = selected?.[2] ?? unquote(expression).split(".").at(-1)!;
    result[name] = structuredClone(evaluate(expression, query, row));
  }
  return result;
};
const assignments = (source: string, query: Query, row: Row): Row => {
  const result: Row = {};
  for (const item of split(source)) {
    const match = /^"?([a-z_0-9]+)"?\s*=\s*(.+)$/i.exec(item);
    if (match === null) return unsupported(item);
    result[match[1]!] = structuredClone(evaluate(match[2]!, query, row));
  }
  return result;
};
const scopedKeys = (keys: readonly string[]): string[] => [
  "account_alias",
  "environment",
  ...keys,
];
const uniqueKeys: Record<string, readonly string[][]> = {
  vertex_model_use_grant_versions: [
    scopedKeys(["grant_id", "grant_version"]),
    scopedKeys(["grant_id", "revision"]),
    scopedKeys(["command_id"]),
  ],
  vertex_model_use_grant_current: [scopedKeys(["grant_id"])],
  vertex_model_use_attempt_identities: [scopedKeys(["request_id"])],
  vertex_model_use_proof_audits: [
    scopedKeys(["request_id", "checked_at_ns", "record_hash"]),
  ],
  vertex_model_use_budget_windows: [
    scopedKeys(["window_id"]),
    scopedKeys(["selection_id", "policy_id", "period_id"]),
  ],
  vertex_model_use_budget_reservations: [
    scopedKeys(["job_id", "selection_id", "request_sha256"]),
    scopedKeys(["reservation_id"]),
  ],
  vertex_worker_jobs: [scopedKeys(["job_id"]), scopedKeys(["event_id"])],
  vertex_worker_run_admissions: [
    scopedKeys(["run_id"]),
    scopedKeys(["job_id"]),
  ],
  vertex_policy_ownership_pins: [scopedKeys(["holder_id"])],
  vertex_research_chat_model_dispatches: [
    scopedKeys(["response_request_id", "operation"]),
    scopedKeys(["request_id"]),
  ],
  vertex_research_chat_model_privacy_reviews: [
    scopedKeys(["review_id"]),
    scopedKeys(["actor_id", "idempotency_key"]),
    scopedKeys(["response_request_id", "operation", "revision"]),
  ],
  vertex_research_chat_model_privacy_candidates: [
    scopedKeys(["response_request_id", "operation"]),
    scopedKeys(["request_id"]),
    scopedKeys(["candidate_id"]),
  ],
  vertex_research_chat_native_phases: [
    scopedKeys(["response_request_id", "phase_ordinal"]),
  ],
  vertex_research_chat_native_phase_requests: [
    scopedKeys(["response_request_id", "phase_ordinal", "operation"]),
    scopedKeys(["request_id"]),
  ],
  vertex_research_chat_native_model_dispatches: [
    scopedKeys(["response_request_id", "phase_ordinal", "operation"]),
    scopedKeys(["request_id"]),
  ],
  vertex_research_chat_native_model_privacy_reviews: [
    scopedKeys(["review_id"]),
    scopedKeys(["actor_id", "idempotency_key"]),
    scopedKeys([
      "response_request_id",
      "phase_ordinal",
      "operation",
      "revision",
    ]),
  ],
  vertex_research_chat_native_model_privacy_candidates: [
    scopedKeys(["response_request_id", "phase_ordinal", "operation"]),
    scopedKeys(["request_id"]),
    scopedKeys(["candidate_id"]),
  ],
  vertex_research_chat_advisory_origins: [
    scopedKeys(["response_request_id"]),
    scopedKeys(["job_id"]),
    scopedKeys(["copy_id"]),
  ],
  vertex_research_chat_debate_runs: [
    scopedKeys(["debate_run_id"]),
    scopedKeys(["owner_actor_id", "thread_id", "run_key"]),
  ],
  vertex_research_chat_debate_steps: [
    scopedKeys(["debate_run_id", "ordinal"]),
    scopedKeys(["response_request_id"]),
  ],
  vertex_research_chat_derived_dependencies: [
    scopedKeys(["review_id"]),
    scopedKeys(["response_request_id", "revision"]),
    scopedKeys(["reviewer_actor_id", "idempotency_key"]),
  ],
};
const immutableTables = new Set([
  "vertex_research_chat_model_privacy_candidates",
  "vertex_research_chat_model_privacy_reviews",
  "vertex_research_chat_model_dispatches",
  "vertex_research_chat_advisory_origins",
  "vertex_research_chat_debate_runs",
  "vertex_research_chat_derived_dependencies",
]);
for (const name of [
  "vertex_research_chat_native_phases",
  "vertex_research_chat_native_phase_requests",
  "vertex_research_chat_native_model_privacy_candidates",
  "vertex_research_chat_native_model_privacy_reviews",
  "vertex_research_chat_native_model_dispatches",
])
  immutableTables.add(name);
const unique = (
  name: string,
  table: Row[],
  next: Row,
  excluded?: Row
): void => {
  // Native predecessor uniqueness coalesces NULL, matching the actual schema.
  if (
    name === "vertex_research_chat_native_model_privacy_reviews" &&
    table.some(
      (row) =>
        row !== excluded &&
        scopedKeys(["response_request_id", "phase_ordinal", "operation"]).every(
          (key) => same(row[key], next[key])
        ) &&
        (row["supersedes_review_id"] ?? "") ===
          (next["supersedes_review_id"] ?? "")
    )
  )
    conflict();
  for (const keys of uniqueKeys[name] ?? [])
    if (
      table.some(
        (row) =>
          row !== excluded &&
          keys.every((key) => !isNull(next[key]) && same(row[key], next[key]))
      )
    )
      conflict();
};

// Each distinct statement text is classified once; params differ per call but
// the regex captures below depend only on the text. Same order and results as
// re-running the regexes per call.
interface Statement {
  text: string;
  delegate: boolean;
  referenceLookup: RegExpExecArray | null;
  modelJoin: RegExpExecArray | null;
  selection: RegExpExecArray | null;
  update: RegExpExecArray | null;
  insertion: RegExpExecArray | null;
}
const statements = new Map<string, Statement>();
const classify = (sql: string): Statement => {
  const cached = statements.get(sql);
  if (cached !== undefined) return cached;
  const text = sql.replace(/\s+/g, " ").trim();
  // The original grant SQL owner verifies all binding/version/hash columns.
  // Its established join implementation is retained, not substituted here.
  if (
    text.includes("from vertex_grant_bindings") ||
    text.includes("pg_advisory_xact_lock")
  ) {
    const value: Statement = {
      text,
      delegate: true,
      referenceLookup: null,
      modelJoin: null,
      selection: null,
      update: null,
      insertion: null,
    };
    statements.set(sql, value);
    return value;
  }
  // Exact new history-owner JSON selector only. Filter actual persisted rows;
  // caller/provenance validation still belongs to the real history owner.
  const referenceLookup =
    /^select \* from vertex_research_chat_messages where account_alias = \$(\d+) and environment = \$(\d+) and request->>'operation' = 'appendResponse' and payload->'response'->>'responseRequestId' = \$(\d+) limit 2$/.exec(
      text
    );
  const modelJoin =
    /^select v\.\*, c\.revision as current_revision from vertex_model_use_grant_current c join vertex_model_use_grant_versions v .* where (.*?) limit 1$/i.exec(
      text
    );
  const selection =
    /^select (.*?) from "?(vertex_[a-z_0-9]+)"?(?: where (.*?))?(?: order by (.*?))?(?: limit (\$\d+|\d+))?(?: for update(?: skip locked)?)?$/i.exec(
      text
    );
  const update =
    /^update "?(vertex_[a-z_0-9]+)"? set (.*?) where (.*?)(?: returning (.*))?$/i.exec(
      text
    );
  const insertion =
    /^insert into "?(vertex_[a-z_0-9]+)"? \((.*?)\) values \((.*?)\)(.*)$/i.exec(
      text
    );
  // Plain inserts understood by the existing boundary stay there unless a
  // worker/model uniqueness constraint needs simulation in this extension.
  const ownInsert =
    insertion !== null &&
    (text.includes(" on conflict ") || uniqueKeys[insertion[1]!] !== undefined);
  const value: Statement = {
    text,
    delegate: !(
      referenceLookup ||
      modelJoin ||
      selection ||
      update ||
      ownInsert
    ),
    referenceLookup,
    modelJoin,
    selection,
    update,
    insertion,
  };
  statements.set(sql, value);
  return value;
};

const decodedHandoff = new WeakMap<SQL, Query>();
// The base SQL fixture uses the decoding handed over by a delegating execute,
// if any, so each statement is decoded by drizzle once.
export const takeDecodedFixtureSql = (fragment: SQL): Query | undefined => {
  const decoded = decodedHandoff.get(fragment);
  decodedHandoff.delete(fragment);
  return decoded;
};

export const extendChatWorkerSql = (f: Fixture): Database => {
  const dialect = new PgDialect();
  const execute = async (
    fragment: SQL,
    delegate: (fragment: SQL) => Promise<unknown>
  ): Promise<unknown> => {
    const decoded = dialect.sqlToQuery(fragment),
      query: Query = { sql: decoded.sql, params: decoded.params };
    const {
      text,
      delegate: delegated,
      referenceLookup,
      modelJoin,
      selection,
      update,
      insertion,
    } = classify(query.sql);
    if (delegated) {
      // Offer the delegate this exact decoding instead of decoding twice. Only
      // its synchronous start can take it; otherwise it decodes as before.
      decodedHandoff.set(fragment, decoded);
      const result = delegate(fragment);
      decodedHandoff.delete(fragment);
      return result;
    }
    f.calls.push(query);
    f.state.afterQuery(query);
    if (referenceLookup) {
      const account = query.params[Number(referenceLookup[1]) - 1],
        environment = query.params[Number(referenceLookup[2]) - 1],
        responseRequestId = query.params[Number(referenceLookup[3]) - 1];
      const found = f
        .table("vertex_research_chat_messages")
        .filter(
          (row) =>
            row["account_alias"] === account &&
            row["environment"] === environment &&
            row["request"]?.operation === "appendResponse" &&
            row["payload"]?.response?.responseRequestId === responseRequestId
        );
      return { rows: found.slice(0, 2).map((row) => structuredClone(row)) };
    }
    if (modelJoin) {
      const found: Row[] = [];
      for (const head of f.table("vertex_model_use_grant_current")) {
        const version = f
          .table("vertex_model_use_grant_versions")
          .find((row) =>
            ["account_alias", "environment", "grant_id", "grant_version"].every(
              (key) => row[key] === head[key]
            )
          );
        if (version && matches(modelJoin[1], query, { c: head, v: version }))
          found.push({
            ...structuredClone(version),
            current_revision: head["revision"],
          });
      }
      return { rows: found.slice(0, 1) };
    }
    if (selection) {
      let found = f
        .table(selection[2]!)
        .filter((row) => matches(selection[3], query, row));
      const fields = selection[1]!;
      if (fields.includes("sum(")) {
        const sums: Row = {};
        for (const item of split(fields)) {
          const match =
            /^coalesce\(sum\(([a-z_0-9]+)\),\s*0\)::text as ([a-z_0-9]+)$/i.exec(
              item
            );
          if (match === null) return unsupported(item);
          sums[match[2]!] = found
            .reduce(
              (total, row) => total + BigInt(String(row[match[1]!] ?? "0")),
              0n
            )
            .toString();
        }
        return { rows: [sums] };
      }
      const maximum = /^max\(([a-z_0-9]+)\)::text as ([a-z_0-9]+)$/i.exec(
        fields
      );
      if (maximum)
        return {
          rows: [
            {
              [maximum[2]!]:
                found.length === 0
                  ? null
                  : found
                      .reduce(
                        (value, row) =>
                          BigInt(String(row[maximum[1]!])) > value
                            ? BigInt(String(row[maximum[1]!]))
                            : value,
                        BigInt(String(found[0]![maximum[1]!]))
                      )
                      .toString(),
            },
          ],
        };
      if (selection[4]) {
        const ordered = split(selection[4]).map(
          (part) => /^(.+?)(?:\s+(asc|desc))?$/i.exec(part)!
        );
        found.sort((left, right) => {
          for (const part of ordered) {
            const a = evaluate(part[1]!, query, left),
              b = evaluate(part[1]!, query, right),
              direction = part[2]?.toLowerCase() === "desc" ? -1 : 1;
            const order =
              isNull(a) && isNull(b)
                ? 0
                : isNull(a)
                  ? 1
                  : isNull(b)
                    ? -1
                    : compare(a, b);
            if (order !== 0) return order * direction;
          }
          return 0;
        });
      }
      if (selection[5])
        found = found.slice(0, Number(evaluate(selection[5], query, {})));
      return { rows: found.map((row) => projection(fields, query, row)) };
    }
    if (update) {
      const name = update[1]!;
      if (immutableTables.has(name)) return immutable();
      const table = f.table(name),
        found = table.filter((row) => matches(update[3], query, row));
      for (const row of found) {
        const next = { ...row, ...assignments(update[2]!, query, row) };
        unique(name, table, next, row);
        Object.assign(row, next);
      }
      return {
        rows: update[4]
          ? found.map((row) => projection(update[4], query, row))
          : [],
      };
    }
    if (insertion) {
      const name = insertion[1]!,
        columns = split(insertion[2]!).map(unquote),
        values = split(insertion[3]!),
        table = f.table(name);
      if (columns.length !== values.length) return unsupported(text);
      const next: Row = {};
      for (let index = 0; index < columns.length; index += 1)
        next[columns[index]!] = structuredClone(
          evaluate(values[index]!, query, {})
        );
      if (name.startsWith("vertex_research_chat_native_")) {
        if (
          ![1, 2].includes(next["phase_ordinal"]) ||
          typeof next["phase_sha256"] !== "string"
        )
          return immutable();
        const samePhase = (row: Row) =>
          scopedKeys([
            "response_request_id",
            "phase_ordinal",
            "phase_sha256",
          ]).every((key) => same(row[key], next[key]));
        if (
          name !== "vertex_research_chat_native_phases" &&
          !f.table("vertex_research_chat_native_phases").some(samePhase)
        )
          return immutable();
        if (
          (name.includes("model_privacy") ||
            name.endsWith("model_dispatches")) &&
          !f
            .table("vertex_research_chat_native_phase_requests")
            .some(
              (row) =>
                samePhase(row) &&
                ["operation", "request_id", "request_sha256"].every((key) =>
                  same(row[key], next[key])
                )
            )
        )
          return immutable();
        if (
          name === "vertex_research_chat_native_model_privacy_reviews" &&
          next["supersedes_review_id"] !== null &&
          !table.some(
            (row) =>
              samePhase(row) &&
              row["operation"] === next["operation"] &&
              row["review_id"] === next["supersedes_review_id"]
          )
        )
          return immutable();
        if (
          name === "vertex_research_chat_native_model_dispatches" &&
          !f
            .table("vertex_research_chat_native_model_privacy_reviews")
            .some(
              (row) =>
                samePhase(row) &&
                [
                  "operation",
                  "request_id",
                  "request_sha256",
                  "review_id",
                ].every((key) => same(row[key], next[key]))
            )
        )
          return immutable();
      }
      const suffix = insertion[4]!.trim();
      const onConflict =
        /^on conflict \((.*?)\) do (nothing|update set (.*?)(?: where (.*?))?)(?: returning (.*))?$/i.exec(
          suffix
        );
      const returned = /^returning (.*)$/i.exec(suffix);
      if (suffix !== "" && !onConflict && !returned) return unsupported(text);
      let effective = next;
      if (onConflict) {
        const keys = split(onConflict[1]!).map(unquote),
          prior = table.find((row) =>
            keys.every((key) => same(row[key], next[key]))
          );
        if (prior) {
          if (onConflict[2]!.toLowerCase() === "nothing") return { rows: [] };
          if (immutableTables.has(name)) return immutable();
          if (!matches(onConflict[4], query, { ...prior, excluded: next }))
            return { rows: [] };
          effective = {
            ...prior,
            ...assignments(onConflict[3]!, query, { ...prior, excluded: next }),
          };
          unique(name, table, effective, prior);
          Object.assign(prior, effective);
          return {
            rows: onConflict[5]
              ? [projection(onConflict[5], query, effective)]
              : [],
          };
        }
      }
      unique(name, table, next);
      table.push(next);
      const returning = onConflict?.[5] ?? returned?.[1];
      return { rows: returning ? [projection(returning, query, next)] : [] };
    }
    return unsupported(text);
  };
  return {
    execute: (fragment: SQL) =>
      execute(fragment, (original) => f.db.execute(original)),
    transaction: <T>(operation: (tx: Transaction) => Promise<T>): Promise<T> =>
      f.db.transaction((tx) =>
        operation({
          ...tx,
          execute: (fragment: SQL) =>
            execute(fragment, (original) => tx.execute(original)),
        } as Transaction)
      ),
  } as unknown as Database;
};
