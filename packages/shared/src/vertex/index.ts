// Gamma's schemas/base.py hashes strings as raw UTF-8 and structures as
// sorted, compact, ensure_ascii=False JSON. Vertex restricts numbers to safe
// integers; all financial decimals are strings, avoiding Python/JS float drift.
export const VERTEX_SCHEMA_VERSION = "1.0.0" as const;
export const VERTEX_HASH_PROFILE = "gamma-json-utf8-safe-integer-v1" as const;
export const RECOVERY_CONFIRMATION =
  "I request IBKR recovery only; this does not authorize trading." as const;

// Proleptic Gregorian years 0000–9999, seconds required, no leap seconds.
// Offsets are explicit ±HH:MM (00:00–23:59); fractions retain 1–9 digits.
// Keep the lexical pattern portable to Python/Rust; the helper also requires the
// match to consume every byte, avoiding `$` accepting a trailing line terminator.
export const VERTEX_TIMESTAMP_PATTERN =
  /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$/;

export const timestampToEpochNanoseconds = (value: string): bigint => {
  const parts = VERTEX_TIMESTAMP_PATTERN.exec(value);
  if (!parts || parts[0] !== value)
    throw new TypeError(
      "Expected a seconds-qualified timestamp with at most nine fractional digits and an explicit offset"
    );
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > (monthLengths[month - 1] ?? 0))
    throw new TypeError("Invalid Gregorian calendar date");
  // Floor division, not truncation, also handles astronomical year zero.
  const previousYear = year - 1;
  const daysBeforeYear =
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400);
  const days =
    daysBeforeYear -
    719_162 +
    monthLengths.slice(0, month - 1).reduce((sum, length) => sum + length, 0) +
    day -
    1;
  const offsetSeconds =
    parts[8] === "Z"
      ? 0
      : (parts[9] === "-" ? -1 : 1) *
        (Number(parts[10]) * 3600 + Number(parts[11]) * 60);
  const seconds =
    BigInt(days) * 86400n +
    BigInt(
      Number(parts[4]) * 3600 +
        Number(parts[5]) * 60 +
        Number(parts[6]) -
        offsetSeconds
    );
  // Add the fraction to the start of the signed second, including pre-epoch.
  return seconds * 1_000_000_000n + BigInt((parts[7] ?? "").padEnd(9, "0"));
};

export type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

// Python orders str keys by code point. Walk both keys in step without
// allocating: equal prefixes share offsets, and a differing unit decides.
const compareCodePoints = (left: string, right: string): number => {
  let index = 0;
  while (index < left.length && index < right.length) {
    const a = left.codePointAt(index) ?? 0;
    const b = right.codePointAt(index) ?? 0;
    if (a !== b) return a - b;
    index += a > 0xff_ff ? 2 : 1;
  }
  return left.length - right.length;
};

// In unicode mode a well-formed pair is one astral code point, so this class
// matches exactly the lone surrogates Python's UTF-8 encoder rejects.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const encodeString = (value: string): string => {
  const json = JSON.stringify(value);
  // Python's UTF-8 encoder rejects lone surrogates; never silently replace them.
  // JSON.stringify writes a lone surrogate as "\udXXX". An escaped backslash can
  // also produce that text, so the exact check runs only in that case.
  if (json.includes("\\ud") && LONE_SURROGATE.test(value)) {
    throw new TypeError("Invalid Unicode scalar");
  }
  return json;
};

// Records repeat the same keys. Keep the JSON text of keys with no surrogate
// code unit (such a key needs no Unicode check). The set is bounded, so
// unusual inputs cannot grow it without limit.
const KEY_TEXT_LIMIT = 4096;
const keyTexts = new Map<string, string>();
const plainKeyText = (key: string): string | undefined => {
  const known = keyTexts.get(key);
  if (known !== undefined) return known;
  for (let index = 0; index < key.length; index += 1) {
    const unit = key.charCodeAt(index);
    if (unit >= 0xd8_00 && unit <= 0xdf_ff) return undefined;
  }
  const text = JSON.stringify(key);
  if (keyTexts.size < KEY_TEXT_LIMIT) keyTexts.set(key, text);
  return text;
};

// Code-unit order equals code-point order unless a key holds a surrogate.
// Returns the sorted keys with their JSON text; null means "encode at use", so
// a key's Unicode error keeps its original place after earlier keys' checks.
const sortedKeyTexts = (
  keys: string[]
): (readonly [string, string | null])[] => {
  const texts: (readonly [string, string])[] = [];
  for (const key of keys) {
    const text = plainKeyText(key);
    if (text === undefined)
      return keys
        .sort(compareCodePoints)
        .map((entry) => [entry, null] as const);
    texts.push([key, text]);
  }
  // Own keys are distinct, so two keys never compare equal.
  return texts.sort((left, right) => (left[0] < right[0] ? -1 : 1));
};

// The original checks, in their original order. They run only for an array
// whose shape is not plain, which always fails one of them, so every error
// keeps its message and precedence (an earlier element's error comes first).
const throwIrregularArray = (
  value: readonly unknown[],
  ancestors: Set<object>
): never => {
  if (Object.keys(value).length !== value.length)
    throw new TypeError("Sparse or decorated array");
  if (Object.getOwnPropertyNames(value).length !== value.length + 1)
    throw new TypeError("Decorated array");
  for (let index = 0; ; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor))
      throw new TypeError("Sparse array or accessor");
    encodeValue(descriptor.value, ancestors);
  }
};

const encodeArray = (
  value: readonly unknown[],
  ancestors: Set<object>
): string => {
  // Plain shape: exactly the indices plus "length", each an enumerable data
  // property. Anything else takes the original checks above.
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!(descriptor?.enumerable && "value" in descriptor))
      return throwIrregularArray(value, ancestors);
    values.push(descriptor.value);
  }
  if (Object.getOwnPropertyNames(value).length !== value.length + 1)
    return throwIrregularArray(value, ancestors);
  let json = "[";
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) json += ",";
    json += encodeValue(values[index], ancestors);
  }
  return `${json}]`;
};

const encodeRecord = (value: object, ancestors: Set<object>): string => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Artifact must contain plain records");
  }
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new TypeError("Artifact must not contain hidden properties");
  }
  let json = "{";
  for (const [key, keyText] of sortedKeyTexts(keys)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      throw new TypeError("Artifact must not contain accessors");
    if (json.length > 1) json += ",";
    json += `${keyText ?? encodeString(key)}:${encodeValue(descriptor.value, ancestors)}`;
  }
  return `${json}}`;
};

const encodeValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError(
        "Artifact numbers must be safe integers; use decimal strings"
      );
    }
    return String(value);
  }
  if (typeof value !== "object")
    throw new TypeError("Artifact must be JSON data");
  if (ancestors.has(value)) throw new TypeError("Cyclic artifact");
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("Artifact must not contain symbol keys");
    }
    return Array.isArray(value)
      ? encodeArray(value, ancestors)
      : encodeRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalArtifactJson = (value: unknown): string => {
  return encodeValue(value, new Set());
};

const freezeNodes = <T>(value: T): DeepReadonly<T> => {
  if (value !== null && typeof value === "object") {
    // Do not skip frozen parents: Zod readonly outputs may be shallow-frozen.
    for (const child of Object.values(value)) freezeNodes(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
};

export const deepFreezeArtifact = <T>(value: T): DeepReadonly<T> => {
  // Validate before touching the graph: cycles, accessors, decorated collections,
  // unsupported prototypes and noncanonical scalars never become verified data.
  canonicalArtifactJson(value);
  return freezeNodes(value);
};

export const hashArtifact = async (value: unknown): Promise<string> => {
  let bytes: Uint8Array<ArrayBuffer>;
  if (value instanceof Uint8Array) {
    bytes = Uint8Array.from(value);
  } else {
    const text =
      typeof value === "string" ? value : canonicalArtifactJson(value);
    encodeString(text);
    bytes = new TextEncoder().encode(text);
  }
  return await sha256Hex(bytes);
};

interface NodeSha256 {
  readonly createHash: (algorithm: "sha256") => {
    update: (data: Uint8Array) => { digest: (encoding: "hex") => string };
  };
}

// Server runtimes (Node, Bun, workerd with nodejs_compat) expose node:crypto through
// process.getBuiltinModule; a synchronous hash avoids one WebCrypto thread-pool round
// trip per artifact. Any scope with a window (browsers, DOM test runs) keeps
// WebCrypto. Same SHA-256 hex either way.
export const serverSha256 = (
  scope: {
    readonly window?: unknown;
    readonly process?: { getBuiltinModule?: (id: string) => unknown };
  } = globalThis
): NodeSha256 | null =>
  scope.window === undefined
    ? ((scope.process?.getBuiltinModule?.("node:crypto") as
        | NodeSha256
        | undefined) ?? null)
    : null;

/** SHA-256 hex of bytes; `node` selects the server path, null the WebCrypto path. */
export const sha256Hex = async (
  bytes: Uint8Array<ArrayBuffer>,
  node: NodeSha256 | null = serverSha256()
): Promise<string> => {
  if (node !== null)
    return node.createHash("sha256").update(bytes).digest("hex");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

export const verifyArtifactHash = async (
  value: unknown,
  expectedHash: string
): Promise<boolean> => {
  return (
    /^[0-9a-f]{64}$/.test(expectedHash) &&
    (await hashArtifact(value)) === expectedHash
  );
};

// A fixed 18-place scale preserves wire precision; no binary floating point.
export const decimalUnits = (value: string): bigint => {
  if (
    !/^(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))$/.test(
      value
    )
  ) {
    throw new TypeError("Expected a canonical bounded decimal string");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const magnitude =
    BigInt(whole ?? "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  return negative ? -magnitude : magnitude;
};

export const compareDecimals = (left: string, right: string): number => {
  const difference = decimalUnits(left) - decimalUnits(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

export const isTickAligned = (value: string, tickSize: string): boolean => {
  const tick = decimalUnits(tickSize);
  return tick > 0n && decimalUnits(value) % tick === 0n;
};
