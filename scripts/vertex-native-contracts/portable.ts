import {
  canonicalArtifactJson,
  VERTEX_TIMESTAMP_PATTERN,
} from "../../packages/shared/src/vertex/index.ts";

// Offline admission ceilings, not latency/memory guarantees or a claim that all
// combinations of public maxima are accepted. Transport callers must impose
// tighter per-contract limits; never parse bulk observations in tick callbacks.
export const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;
export const MAX_STRING_BYTES = 2 * 1024 * 1024;
export const MAX_PROGRAM_STEPS = 16_000_000;
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail: (message: string) => never = (message) => {
  throw new TypeError(message);
};

// Duplicate keys, negative zero, unsafe numbers and malformed UTF-8 are errors,
// not values that a JSON.parse round trip may silently repair before pinning.
export const parseStrictJson = (
  bytes: Uint8Array,
  maximumBytes = 8 * 1024 * 1024
): unknown => {
  if (bytes.byteLength > maximumBytes) fail("JSON byte limit exceeded");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  let offset = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (offset < text.length && /[\t\n\r ]/.test(text.charAt(offset)))
      offset += 1;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text.charAt(offset++);
      if (character === "\\") {
        offset += 1;
        continue;
      }
      if (character !== '"') continue;
      const value = JSON.parse(text.slice(start, offset)) as string;
      if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES)
        fail("JSON string limit exceeded");
      canonicalArtifactJson(value);
      return value;
    }
    return fail("Unterminated JSON string");
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES)
      fail("JSON resource limit exceeded");
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      const isArray = character === "[";
      offset += 1;
      const result: unknown[] | Record<string, unknown> = isArray
        ? []
        : Object.create(null);
      const close = isArray ? "]" : "}";
      whitespace();
      if (text[offset] === close) {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        whitespace();
        let key = "";
        if (!isArray) {
          if (text[offset] !== '"') fail("Expected JSON property");
          key = string();
          if (Object.hasOwn(result, key)) fail("Duplicate JSON property");
          whitespace();
          if (text[offset++] !== ":") fail("Expected JSON colon");
        }
        const child = value(depth + 1);
        if (isArray) {
          (result as unknown[]).push(child);
        } else (result as Record<string, unknown>)[key] = child;
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === close) return result;
        if (delimiter !== ",") fail("Expected JSON delimiter");
      }
      return fail("Unterminated JSON container");
    }
    const literal =
      /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(offset)
      )?.[0];
    if (literal === undefined) return fail("Invalid JSON value");
    offset += literal.length;
    const scalar: unknown = JSON.parse(literal);
    if (
      typeof scalar === "number" &&
      (!(
        /^-?(?:0|[1-9][0-9]*)$/.test(literal) && Number.isSafeInteger(scalar)
      ) ||
        Object.is(scalar, -0))
    ) {
      fail("Only canonical safe integers may cross a data boundary");
    }
    return scalar;
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) fail("Trailing JSON content");
  canonicalArtifactJson(result);
  return result;
};

// Numbers in the IR are bounded literal integers. Evaluators promote integer
// operands to unbounded integers, including integer(get(sequence)) and epoch.
// every/some retain the current rule root; parent resolves the immediately
// enclosing iteration current. call starts an isolated root/current stack.
const OPERATOR_ARITIES: Readonly<Record<string, readonly [number, number]>> = {
  lit: [1, 1],
  get: [1, 1],
  root: [1, 1],
  parent: [1, 1],
  call: [2, 2],
  and: [1, 512],
  or: [1, 512],
  not: [1, 1],
  if: [3, 3],
  eq: [2, 2],
  ne: [2, 2],
  lt: [2, 2],
  le: [2, 2],
  gt: [2, 2],
  ge: [2, 2],
  add: [2, 2],
  sub: [2, 2],
  mod: [2, 2],
  mul: [2, 2],
  len: [1, 1],
  concat: [1, 512],
  slice: [3, 3],
  decimal: [1, 1],
  epoch: [1, 1],
  integer: [1, 1],
  unique: [1, 1],
  uniqueBy: [2, 2],
  every: [2, 2],
  some: [2, 2],
  contains: [2, 2],
  keys: [1, 1],
  values: [1, 1],
  hashOmit: [2, 2],
  nonoverlap: [3, 3],
  publicHttps: [1, 1],
  timestamp: [1, 1],
  hashOmitPaths: [2, 2],
  base64Length: [1, 1],
  at: [2, 2],
  index: [0, 0],
  sum: [2, 2],
};

export const assertPrograms = (programs: Record<string, unknown>): void => {
  if (Object.keys(programs).length === 0) fail("Empty semantic programs");
  canonicalArtifactJson(programs);
  let nodes = 0;
  const edges = new Map<string, Set<string>>();
  const path = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      (value !== "" &&
        !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value))
    ) {
      fail("Invalid field path");
    }
  };
  const visit = (
    expression: unknown,
    depth: number,
    scope: number,
    rule: string
  ): void => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES)
      fail("Program resource limit exceeded");
    if (
      expression === null ||
      typeof expression === "string" ||
      typeof expression === "boolean"
    )
      return;
    if (typeof expression === "number") {
      if (!Number.isSafeInteger(expression) || Object.is(expression, -0))
        fail("Invalid program integer");
      return;
    }
    if (!Array.isArray(expression) || typeof expression[0] !== "string")
      fail("Expression must be literal scalar or operator array");
    const [opcode, ...operands] = expression as [string, ...unknown[]];
    const arity = OPERATOR_ARITIES[opcode];
    if (!arity || operands.length < arity[0] || operands.length > arity[1])
      fail(`Unsupported operator/arity: ${opcode}`);
    if (opcode === "lit") {
      const bytes = new TextEncoder().encode(
        canonicalArtifactJson(operands[0])
      );
      parseStrictJson(bytes);
      return;
    }
    if (opcode === "get" || opcode === "root" || opcode === "parent") {
      path(operands[0]);
      if (opcode === "parent" && scope < 1)
        fail("parent is unavailable outside an iteration");
      return;
    }
    if (opcode === "index") {
      if (scope < 1) fail("index is unavailable outside an iteration");
      return;
    }
    if (opcode === "call") {
      if (
        typeof operands[0] !== "string" ||
        !Object.hasOwn(programs, operands[0])
      )
        fail("Missing called semantic program");
      (edges.get(rule) ?? fail("Unknown semantic program")).add(operands[0]);
      visit(operands[1], depth + 1, scope, rule);
      return;
    }
    if (opcode === "uniqueBy" || opcode === "nonoverlap") {
      visit(operands[0], depth + 1, scope, rule);
      for (const field of operands.slice(1)) {
        path(field);
        if (field === "" || (field as string).includes("."))
          fail("Expected a direct record field");
      }
      return;
    }
    if (opcode === "every" || opcode === "some" || opcode === "sum") {
      visit(operands[0], depth + 1, scope, rule);
      visit(operands[1], depth + 1, scope + 1, rule);
      return;
    }
    if (opcode === "hashOmit" || opcode === "hashOmitPaths") {
      const fields = operands[1];
      if (
        !Array.isArray(fields) ||
        fields.length !== 2 ||
        fields[0] !== "lit" ||
        !Array.isArray(fields[1]) ||
        !fields[1].every((entry) => typeof entry === "string") ||
        new Set(fields[1]).size !== fields[1].length
      ) {
        fail(`${opcode} requires an explicit unique literal field-name array`);
      }
      if (opcode === "hashOmitPaths") {
        const paths = (fields as [string, string[]])[1];
        if (
          canonicalArtifactJson(paths) !==
          canonicalArtifactJson([
            "sourceEventHash",
            "continuity.highWaterEventHash",
          ])
        ) {
          fail(
            "v1 hashOmitPaths permits only the declared portfolio genesis omissions in order"
          );
        }
        for (const field of paths) {
          path(field);
          if (
            field === "" ||
            paths.some(
              (other) => other !== field && field.startsWith(`${other}.`)
            )
          ) {
            fail("hashOmitPaths rejects empty and ancestor-overlapping paths");
          }
        }
      }
    }
    for (const operand of operands) visit(operand, depth + 1, scope, rule);
  };
  for (const name of Object.keys(programs)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
      fail("Invalid semantic program name");
    edges.set(name, new Set());
  }
  for (const [name, expression] of Object.entries(programs))
    visit(expression, 0, 0, name);
  const done = new Set<string>();
  const active = new Set<string>();
  const acyclic = (name: string, depth: number): void => {
    if (active.has(name) || depth > MAX_DEPTH)
      fail("Recursive/deep semantic program calls");
    if (done.has(name)) return;
    active.add(name);
    for (const target of edges.get(name) ?? []) acyclic(target, depth + 1);
    active.delete(name);
    done.add(name);
  };
  for (const name of edges.keys()) acyclic(name, 0);
};

// Engine support, not schema inference: these are reviewed regex spellings
// in the frozen authoritative sources. Unreviewed patterns (even valid regular
// expressions) fail closed, preventing backtracking outside the step budget.
// New source patterns require a native profile review, not automatic inference.
const SUPPORTED_SCHEMA_PATTERNS = new Set([
  "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
  "^[0-9a-f]{64}$",
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`,
  String.raw`^(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))$`,
  String.raw`^(?:0|[1-9]\d{0,29})(?:\.\d{0,17}[1-9])?$`,
  "^[A-Z]{3}$",
  String.raw`^[^\u0000-\u001f\u007f\ud800-\udfff]*$`,
  "^replay-manifest-[0-9a-f]{24}$",
  String.raw`^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$`,
  String.raw`^[^\ud800-\udfff]*$`,
  "^event-[0-9a-f]{64}$",
  String.raw`^(0|[1-9]\d{0,29})$`,
  "^[1-9][0-9]{0,29}$",
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
  String.raw`^[1-9]\d{0,29}$`,
  "^[A-Z][A-Z0-9_]{0,127}$",
  VERTEX_TIMESTAMP_PATTERN.source,
]);

const SCHEMA_KEYS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "format",
  "title",
  "description",
  "readOnly",
]);

// Zod exports numeric literals as type:number. A safe integer const accepts
// exactly the same value with type:integer; retain const and every constraint.
// Visit schema positions only, never const/enum data or arbitrary annotations.
export const normalizeIntegerLiteralSchemas = (schema: unknown): unknown => {
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      fail("Schema normalization resource limit");
    if (typeof value === "boolean") return value;
    if (!object(value)) return fail("Schema must be a record or boolean");
    const result: Record<string, unknown> = { ...value };
    if (
      value["type"] === "number" &&
      typeof value["const"] === "number" &&
      Number.isSafeInteger(value["const"]) &&
      !Object.is(value["const"], -0)
    ) {
      result["type"] = "integer";
    }
    for (const key of ["properties", "$defs"]) {
      const children = value[key];
      if (object(children)) {
        result[key] = Object.fromEntries(
          Object.entries(children).map(([name, child]) => [
            name,
            walk(child, depth + 1),
          ])
        );
      }
    }
    for (const key of ["items", "additionalProperties", "not"]) {
      if (Object.hasOwn(value, key)) result[key] = walk(value[key], depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const children = value[key];
      if (Array.isArray(children))
        result[key] = children.map((child) => walk(child, depth + 1));
    }
    return result;
  };
  return walk(schema, 0);
};

export const assertSupportedSchema = (
  schema: unknown,
  label = "schema"
): void => {
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      fail(`${label}: schema resource limit`);
    if (typeof value === "boolean") return;
    if (!object(value)) fail(`${label}: schema must be a record or boolean`);
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (!SCHEMA_KEYS.has(key))
        fail(`${label}: unsupported schema keyword ${key}`);
      if (key === "properties" || key === "$defs") {
        if (!object(child)) fail(`${label}: ${key} must be a map`);
        for (const nested of Object.values(child as Record<string, unknown>))
          walk(nested, depth + 1);
      } else if (["items", "additionalProperties", "not"].includes(key)) {
        walk(child, depth + 1);
      } else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(child) || child.length === 0)
          fail(`${label}: invalid schema branches`);
        for (const nested of child as unknown[]) walk(nested, depth + 1);
      } else if (key === "$schema") {
        if (child !== "https://json-schema.org/draft/2020-12/schema")
          fail(`${label}: unsupported dialect`);
      } else if (key === "$ref") {
        if (typeof child !== "string" || !/^#\/\$defs\/[^/]+$/.test(child))
          fail(`${label}: only local definitions may be referenced`);
        const decoded = (child as string)
          .slice(8)
          .replace(/~1/g, "/")
          .replace(/~0/g, "~");
        if (
          !(
            object(schema) &&
            object(schema["$defs"]) &&
            Object.hasOwn(schema["$defs"], decoded)
          )
        )
          fail(`${label}: unresolved local reference`);
      } else if (key === "type") {
        const types = Array.isArray(child) ? child : [child];
        if (
          types.length === 0 ||
          !types.every((type) =>
            [
              "null",
              "boolean",
              "integer",
              "string",
              "array",
              "object",
            ].includes(type as string)
          )
        )
          fail(`${label}: unsupported schema type`);
      } else if (key === "format") {
        if (child !== "uri") fail(`${label}: unsupported format`);
      } else if (key === "pattern") {
        if (typeof child !== "string" || !SUPPORTED_SCHEMA_PATTERNS.has(child))
          fail(`${label}: unsupported source pattern`);
      } else if (["title", "description"].includes(key)) {
        if (typeof child !== "string") fail(`${label}: invalid annotation`);
      } else if (key === "readOnly") {
        if (typeof child !== "boolean")
          fail(`${label}: invalid readOnly annotation`);
      } else if (key === "required") {
        if (
          !(
            Array.isArray(child) &&
            child.every((entry) => typeof entry === "string")
          ) ||
          new Set(child).size !== child.length
        )
          fail(`${label}: invalid required keys`);
      } else if (key === "enum") {
        if (!Array.isArray(child) || child.length === 0)
          fail(`${label}: invalid enumeration`);
        canonicalArtifactJson(child);
      } else if (key === "const") {
        canonicalArtifactJson(child);
      } else if (
        typeof child !== "number" ||
        !Number.isSafeInteger(child) ||
        Object.is(child, -0) ||
        (["minItems", "maxItems", "minLength", "maxLength"].includes(key) &&
          child < 0)
      ) {
        fail(`${label}: invalid integer bound`);
      }
    }
  };
  canonicalArtifactJson(schema);
  walk(schema, 0);
};
