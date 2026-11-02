import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  buildVertexContractDocument,
  VERTEX_CONTRACT_SCHEMAS,
} from "../../packages/api/src/contracts/vertex.ts";
import { VERTEX_CONTROL_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-control.ts";
import { VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-native-facts.ts";
import { VERTEX_WORKER_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-worker.ts";
import { VERTEX_POLICY_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-policy.ts";
import { VERTEX_MODEL_USE_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-model-use.ts";
import { VERTEX_EPOCH_CONTRACT_SCHEMAS } from "../../packages/api/src/contracts/vertex-worker-epoch.ts";
import {
  canonicalArtifactJson,
  hashArtifact,
  VERTEX_HASH_PROFILE,
  VERTEX_SCHEMA_VERSION,
} from "../../packages/shared/src/vertex/index.ts";
import {
  assertPrograms,
  assertSupportedSchema,
  normalizeIntegerLiteralSchemas,
  parseStrictJson,
} from "./portable.ts";

const BUNDLE_FORMAT = "vertex-native-contract-bundle-v1";
const SEMANTIC_PROFILE = "vertex-invariants-v1";
export const INVARIANT_PATH =
  "scripts/vertex-native-contracts/invariants-v1.json";
export const AUTHORITATIVE_SOURCE_PATHS = [
  "packages/api/src/contracts/vertex.ts",
  "packages/api/src/contracts/vertex-control.ts",
  "packages/api/src/contracts/vertex-native-facts.ts",
  "packages/api/src/contracts/vertex-worker.ts",
  "packages/api/src/contracts/vertex-worker-experiment.ts",
  "packages/api/src/contracts/vertex-model-privacy-rendezvous.ts",
  "packages/api/src/contracts/vertex-policy.ts",
  "packages/api/src/contracts/vertex-model-use.ts",
  "packages/api/src/contracts/vertex-worker-epoch.ts",
  "packages/shared/src/vertex/index.ts",
] as const;
// Explicit native replay boundary approved in addition to (not inserted into)
// the public source registries. The shape is exactly the source input schema;
// its rule mirrors parsePortfolioGenesis. Identity is not capital permission,
// publisher authentication or a replacement for the native owner's journal.
const NATIVE_REPLAY_SCHEMA_ALIASES = {
  PortfolioGenesis: "PortfolioSnapshot",
} as const;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface NativeInvariantMetadata {
  semanticProfile: string;
  programs: Record<string, Json>;
  contractRules: Record<string, string>;
  sourcePins: Record<string, string>;
}
export interface NativeContractBundle {
  bundleFormat: string;
  schemaVersion: string;
  hashProfile: string;
  semanticProfile: string;
  sources: Record<string, string>;
  schemas: Record<string, Json>;
  programs: Record<string, Json>;
  contractRules: Record<string, string>;
  programDigest: string;
  sourceDigest: string;
}
export type SourceReader = (repoRelativePath: string) => Promise<Uint8Array>;

const record = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const requireExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  if (
    canonicalArtifactJson(actual) !== canonicalArtifactJson([...keys].sort())
  ) {
    throw new TypeError(`${label}: exact keys required`);
  }
};

// The names deliberately distinguish exact original bytes from canonical JSON.
// hashArtifact(string) hashes raw UTF-8; it must receive the canonical text, not
// a JSON-encoded string containing that text. No self-pinned bundle is trusted.
export const rawBytesSha256 = async (bytes: Uint8Array): Promise<string> =>
  hashArtifact(bytes);
export const canonicalJsonSha256 = async (value: unknown): Promise<string> =>
  hashArtifact(canonicalArtifactJson(value));

export const readRepositorySource: SourceReader = async (repoRelativePath) => {
  if (
    ![...AUTHORITATIVE_SOURCE_PATHS, INVARIANT_PATH].some(
      (path) => path === repoRelativePath
    )
  ) {
    throw new TypeError("Unregistered contract source path");
  }
  const handle = await open(
    resolve(REPOSITORY_ROOT, repoRelativePath),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BUNDLE_BYTES) {
      throw new TypeError("Contract source must be a bounded regular file");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new TypeError("Contract source changed while reading");
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
};

export const validateInvariantMetadata = (
  input: unknown,
  contractNames: readonly string[],
  actualSourcePins: Record<string, string>
): NativeInvariantMetadata => {
  if (!record(input))
    throw new TypeError("Invariant metadata must be an object");
  requireExactKeys(
    input,
    ["semanticProfile", "programs", "contractRules", "sourcePins"],
    "Invariant metadata"
  );
  if (input["semanticProfile"] !== SEMANTIC_PROFILE)
    throw new TypeError("Unsupported semantic profile");
  if (
    !(
      record(input["programs"]) &&
      record(input["contractRules"]) &&
      record(input["sourcePins"])
    )
  ) {
    throw new TypeError("Invariant metadata maps are required");
  }
  requireExactKeys(
    input["sourcePins"],
    AUTHORITATIVE_SOURCE_PATHS,
    "Invariant source pins"
  );
  requireExactKeys(
    actualSourcePins,
    AUTHORITATIVE_SOURCE_PATHS,
    "Actual source pins"
  );
  for (const path of AUTHORITATIVE_SOURCE_PATHS) {
    const pin = input["sourcePins"][path];
    if (
      typeof pin !== "string" ||
      !/^[0-9a-f]{64}$/.test(pin) ||
      pin !== actualSourcePins[path]
    ) {
      throw new TypeError(`Stale invariant source pin: ${path}`);
    }
  }
  requireExactKeys(
    input["contractRules"],
    contractNames,
    "Invariant contract coverage"
  );
  for (const [contract, rule] of Object.entries(input["contractRules"])) {
    if (typeof rule !== "string" || !Object.hasOwn(input["programs"], rule)) {
      throw new TypeError(`Missing semantic program: ${contract}`);
    }
  }
  assertPrograms(input["programs"]);
  return input as unknown as NativeInvariantMetadata;
};

// This function is the entire bundle-producing boundary. Importing the module
// does not read files, spawn processes or write a runtime bundle.
// The reader injection supports offline fixtures; callers must supply the real
// frozen source bytes in production, never bytes from an untrusted repository.
export const generateNativeContractBundle = async (
  readSource: SourceReader = readRepositorySource
): Promise<Uint8Array> => {
  if (
    VERTEX_SCHEMA_VERSION !== "1.0.0" ||
    VERTEX_HASH_PROFILE !== "gamma-json-utf8-safe-integer-v1"
  ) {
    throw new TypeError("Unsupported source schema or hash profile");
  }
  const paths = [...AUTHORITATIVE_SOURCE_PATHS, INVARIANT_PATH];
  const boundedSource = async (path: string): Promise<Uint8Array> => {
    const bytes = Uint8Array.from(await readSource(path));
    if (bytes.byteLength > MAX_BUNDLE_BYTES)
      throw new TypeError("Source exceeds byte limit");
    return bytes;
  };
  const sourcePins: Record<string, string> = {};
  for (const path of AUTHORITATIVE_SOURCE_PATHS)
    sourcePins[path] = await rawBytesSha256(await boundedSource(path));
  const invariantBytes = await boundedSource(INVARIANT_PATH);
  const base = buildVertexContractDocument();
  if (
    base.schemaVersion !== VERTEX_SCHEMA_VERSION ||
    base.hashProfile !== VERTEX_HASH_PROFILE
  ) {
    throw new TypeError("Contract document profiles disagree");
  }
  const baseNames = Object.keys(VERTEX_CONTRACT_SCHEMAS);
  requireExactKeys(base.schemas, baseNames, "Base source registry");
  const supplemental = [
    VERTEX_CONTROL_CONTRACT_SCHEMAS,
    VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
    VERTEX_WORKER_CONTRACT_SCHEMAS,
    VERTEX_POLICY_CONTRACT_SCHEMAS,
    VERTEX_MODEL_USE_CONTRACT_SCHEMAS,
    VERTEX_EPOCH_CONTRACT_SCHEMAS,
  ];
  const contractNames = [
    ...baseNames,
    ...supplemental.flatMap((registry) => Object.keys(registry)),
    ...Object.keys(NATIVE_REPLAY_SCHEMA_ALIASES),
  ];
  if (new Set(contractNames).size !== contractNames.length)
    throw new TypeError("Contract source registry collision");
  const metadata = validateInvariantMetadata(
    parseStrictJson(invariantBytes, MAX_BUNDLE_BYTES),
    contractNames,
    sourcePins
  );
  const schemas: Record<string, Json> = { ...base.schemas } as Record<
    string,
    Json
  >;
  for (const registry of supplemental) {
    for (const [name, schema] of Object.entries(registry)) {
      schemas[name] = z.toJSONSchema(schema, { io: "input" }) as Json;
    }
  }
  for (const [alias, source] of Object.entries(NATIVE_REPLAY_SCHEMA_ALIASES)) {
    const sourceSchema = Object.hasOwn(schemas, source)
      ? schemas[source]
      : undefined;
    if (Object.hasOwn(schemas, alias) || sourceSchema === undefined)
      throw new TypeError(
        "Replay schema alias collides or lacks source authority"
      );
    schemas[alias] = sourceSchema;
  }
  for (const [name, schema] of Object.entries(schemas)) {
    schemas[name] = normalizeIntegerLiteralSchemas(schema) as Json;
    assertSupportedSchema(schemas[name], name);
  }
  const sources: Record<string, string> = {
    ...sourcePins,
    [INVARIANT_PATH]: await rawBytesSha256(invariantBytes),
  };
  const bundle: NativeContractBundle = {
    bundleFormat: BUNDLE_FORMAT,
    schemaVersion: VERTEX_SCHEMA_VERSION,
    hashProfile: VERTEX_HASH_PROFILE,
    semanticProfile: SEMANTIC_PROFILE,
    sources,
    schemas,
    programs: metadata.programs,
    contractRules: metadata.contractRules,
    programDigest: await canonicalJsonSha256(metadata.programs),
    sourceDigest: await canonicalJsonSha256(sources),
  };
  const bytes = new TextEncoder().encode(canonicalArtifactJson(bundle));
  if (bytes.byteLength > MAX_BUNDLE_BYTES)
    throw new TypeError("Bundle exceeds byte limit");
  // A changing source tree must not produce a successful receipt. This does not
  // replace freezing/restarting the generator process when source code changes.
  for (const path of paths) {
    if ((await rawBytesSha256(await readSource(path))) !== sources[path]) {
      throw new TypeError(`Contract source changed during generation: ${path}`);
    }
  }
  return bytes;
};

export const runNativeContractGeneratorCli = async (
  args: readonly string[]
): Promise<number> => {
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new TypeError(
      "Usage: vertex-contracts.ts generate --output <new-explicit-bundle-path>"
    );
  }
  const output = resolve(args[1]);
  if (
    dirname(output) === REPOSITORY_ROOT ||
    [...AUTHORITATIVE_SOURCE_PATHS, INVARIANT_PATH].some(
      (path) => resolve(REPOSITORY_ROOT, path) === output
    )
  ) {
    throw new TypeError(
      "Bundle output must not overwrite repository authority"
    );
  }
  const bytes = await generateNativeContractBundle();
  // Exclusive creation: pinned bundles are immutable. An existing file is never
  // silently replaced. Parents must already exist; there is no path discovery.
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      path: output,
      rawBundleSha256: await rawBytesSha256(bytes),
    })
  );
  return 0;
};
