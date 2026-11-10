import { createHash } from "node:crypto";
import { required } from "../lib/required.ts";

const MAX_CONFIG_BYTES = 262_144;
// The graph of this repository was 84 MB on 2026-11-10 (48,866 nodes,
// 125,901 links), above the former 64 MiB bound.
const MAX_GRAPH_BYTES = 268_435_456;
const MAX_SOURCE_FILE_BYTES = 8_388_608;
const MAX_SOURCE_TOTAL_BYTES = 134_217_728;
const MAX_SOURCE_FILES = 20_000;
const COMMAND_OPTIONS = Object.freeze({
  timeoutMs: 120_000,
  maxOutputBytes: 1_048_576,
});
// A full extract of this repository took 110 s with the pinned Graphify on an
// idle 32-core rig, so the 120 s command limit killed it under any load.
const EXTRACT_TIMEOUT_MS = 600_000;
const SUPPORTED_GRAPH_PATH = "graphify-out/graph.json";

export type GraphAction = "build" | "update" | "check" | "verify";

export type GraphConfig = Readonly<{
  version: 1;
  graphPath: string;
  manifestPath: string;
  source: Readonly<{
    roots: readonly string[];
    files: readonly string[];
    extensions: readonly string[];
    excludes: readonly string[];
  }>;
  verificationPath: readonly string[];
}>;

export type GraphManifest = Readonly<{
  version: 1;
  graphifyVersion: string;
  configDigest: string;
  graphDigest: string;
  sourceFingerprint: string;
  sourceFileCount: number;
}>;

export type GraphFileInfo = Readonly<{
  kind: "missing" | "file" | "directory" | "symlink" | "other";
  size: number;
}>;

export type GraphFileSystem = Readonly<{
  exists: (path: string) => Promise<boolean>;
  inspect: (path: string) => Promise<GraphFileInfo>;
  readText: (path: string, maximumBytes?: number) => Promise<string>;
  writeText: (path: string, content: string) => Promise<void>;
  resetGraphOutput: (graphPath: string) => Promise<void>;
  listSourceFiles: (config: GraphConfig) => Promise<readonly string[]>;
  createSourceSnapshot: (
    config: GraphConfig
  ) => Promise<Readonly<{ path: string; cleanup: () => Promise<void> }>>;
}>;

export type GraphCommandOptions = Readonly<{
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: Readonly<Record<string, string>>;
}>;

export type GraphCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  // True when the command was killed because it reached timeoutMs.
  timedOut?: boolean;
}>;

export type GraphProcess = Readonly<{
  run: (
    command: string,
    arguments_: readonly string[],
    options?: GraphCommandOptions
  ) => Promise<GraphCommandResult>;
}>;

// The pinned Graphify toolchain. scripts/graph/requirements.lock pins graphifyy;
// another Graphify on PATH (for example a newer global uv tool) builds a
// different graph and can be much slower, so the wrapper uses PATH only at the
// pinned version and otherwise runs a hash-locked venv.
export type GraphToolchain = Readonly<{
  pinnedVersion: () => Promise<string>;
  // Python of an existing pinned venv, or null when none was provisioned yet.
  pinnedPython: () => Promise<string | null>;
  // Builds the pinned venv when needed and returns its Python.
  provision: () => Promise<string>;
}>;

export type GraphDependencies = Readonly<{
  files: GraphFileSystem;
  process: GraphProcess;
  toolchain?: GraphToolchain;
}>;

type GraphifyTool = Readonly<{
  command: string;
  prefix: readonly string[];
  version: string;
}>;

export type GraphReport = Readonly<{
  action: GraphAction;
  ok: boolean;
  fresh: boolean;
  reason: string;
  sourceFileCount?: number;
  sourceFingerprint?: string;
  graphifyVersion?: string;
  queriesVerified?: number;
}>;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const stringArray = (value: unknown, name: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`Graph config ${name} must be a nonempty string array`);
  }
  return Object.freeze([...value] as string[]);
};

const isSafeRelative = (path: string): boolean => {
  return (
    path.length > 0 &&
    path !== "." &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  );
};

const isSafeRoot = (path: string): boolean =>
  path === "." || isSafeRelative(path);
const isSafeSymbol = (value: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_.:$-]{0,127}$/.test(value);

export const parseGraphConfig = (source: string): GraphConfig => {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
    throw new Error("Graph config is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Graph config is malformed");
  }
  const root = asRecord(parsed);
  const sourceConfig = asRecord(root?.["source"]);
  if (root?.["version"] !== 1 || !sourceConfig)
    throw new Error("Graph config version or source is invalid");

  const graphPath = root["graphPath"];
  const manifestPath = root["manifestPath"];
  if (typeof graphPath !== "string" || typeof manifestPath !== "string") {
    throw new Error("Graph config output paths are invalid");
  }
  if (graphPath !== SUPPORTED_GRAPH_PATH) {
    throw new Error("Graph config must use the supported graph output path");
  }
  const roots = stringArray(sourceConfig["roots"], "source.roots");
  const files = stringArray(sourceConfig["files"], "source.files");
  const extensions = stringArray(
    sourceConfig["extensions"],
    "source.extensions"
  );
  const excludes = stringArray(sourceConfig["excludes"], "source.excludes");
  const verificationPath = stringArray(
    root["verificationPath"],
    "verificationPath"
  );
  if (verificationPath.length < 2)
    throw new Error("Graph config verificationPath is too short");

  for (const path of [graphPath, manifestPath, ...files, ...excludes]) {
    if (!isSafeRelative(path))
      throw new Error(`Graph config contains an unsafe path: ${path}`);
  }
  // "*" is a glob only in an exclude with no "/"; the one other use is the
  // "/**" suffix. Any other "*" would match nothing, so it is an error.
  const multiSegmentGlob = excludes.find(
    (excluded) =>
      excluded.includes("/") && excluded.replace(/\/\*\*$/, "").includes("*")
  );
  if (multiSegmentGlob !== undefined)
    throw new Error(
      `Graph config exclude globs must be one path segment: ${multiSegmentGlob}`
    );
  for (const path of roots) {
    if (!isSafeRoot(path))
      throw new Error(`Graph config contains an unsafe path: ${path}`);
  }
  if (extensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))) {
    throw new Error("Graph config contains an invalid extension");
  }
  if (verificationPath.some((symbol) => !isSafeSymbol(symbol))) {
    throw new Error("Graph config contains an unsafe verification symbol");
  }

  return Object.freeze({
    version: 1,
    graphPath,
    manifestPath,
    source: Object.freeze({ roots, files, extensions, excludes }),
    verificationPath,
  });
};

const readRegularFile = async (
  files: GraphFileSystem,
  path: string,
  maximumBytes: number,
  label: string
): Promise<string> => {
  const info = await files.inspect(path);
  if (info.kind !== "file")
    throw new Error(`${label} is missing or not a regular file`);
  if (
    !Number.isSafeInteger(info.size) ||
    info.size < 0 ||
    info.size > maximumBytes
  ) {
    throw new Error(`${label} is too large`);
  }
  const content = await files.readText(path, maximumBytes);
  if (Buffer.byteLength(content, "utf8") > maximumBytes)
    throw new Error(`${label} is too large`);
  return content;
};

const parseManifest = (source: string): GraphManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Graph manifest is malformed");
  }
  const manifest = asRecord(parsed);
  const digests = ["configDigest", "graphDigest", "sourceFingerprint"] as const;
  if (
    manifest?.["version"] !== 1 ||
    typeof manifest["graphifyVersion"] !== "string" ||
    digests.some(
      (name) =>
        typeof manifest[name] !== "string" ||
        !/^[a-f0-9]{64}$/.test(manifest[name] as string)
    ) ||
    !Number.isSafeInteger(manifest["sourceFileCount"]) ||
    Number(manifest["sourceFileCount"]) < 0
  )
    throw new Error("Graph manifest has an invalid shape");
  return Object.freeze({
    version: 1,
    graphifyVersion: manifest["graphifyVersion"] as string,
    configDigest: manifest["configDigest"] as string,
    graphDigest: manifest["graphDigest"] as string,
    sourceFingerprint: manifest["sourceFingerprint"] as string,
    sourceFileCount: manifest["sourceFileCount"] as number,
  });
};

export const calculateContentDigest = (content: string): string => {
  return createHash("sha256").update(content).digest("hex");
};

const compareCanonicalText = (left: string, right: string): number => {
  return left < right ? -1 : left > right ? 1 : 0;
};

const canonicalJson = (value: unknown): string => {
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Graph output contains a non-finite number");
    return JSON.stringify(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const canonicalizeHyperedge = (
  value: unknown,
  nodeIds: ReadonlyMap<string, string>,
  semanticNodeIds: ReadonlySet<string>,
  hyperedgeIds: Set<string>
): Readonly<Record<string, unknown>> => {
  const hyperedge = asRecord(value);
  const id = hyperedge?.["id"];
  if (
    !hyperedge ||
    typeof id !== "string" ||
    id.length === 0 ||
    nodeIds.has(id) ||
    semanticNodeIds.has(id) ||
    hyperedgeIds.has(id)
  )
    throw new Error(
      "Graph output has an invalid or colliding hyperedge identity"
    );

  const memberKeys = ["nodes", "members"].filter((key) => {
    return Object.hasOwn(hyperedge, key);
  });
  if (memberKeys.length !== 1)
    throw new Error("Graph output has invalid hyperedge members");
  const memberKey = required(memberKeys[0], "hyperedge member key");
  const memberValues = hyperedge[memberKey];
  if (!Array.isArray(memberValues) || memberValues.length < 3) {
    throw new Error("Graph output has too few hyperedge members");
  }
  const members = memberValues.map((member) => {
    if (typeof member !== "string" || !nodeIds.has(member)) {
      throw new Error("Graph output has an invalid hyperedge member");
    }
    return required(nodeIds.get(member), "hyperedge member node");
  });
  if (new Set(members).size !== members.length) {
    throw new Error("Graph output has repeated hyperedge members");
  }
  hyperedgeIds.add(id);
  return Object.fromEntries(
    Object.entries(hyperedge).map(([key, entry]) => {
      return key === memberKey
        ? [key, members.sort(compareCanonicalText)]
        : [key, entry];
    })
  );
};

export const calculateGraphDigest = (content: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Graph output is malformed");
  }
  const graph = asRecord(parsed);
  const nodes = graph?.["nodes"];
  const links = graph?.["links"];
  const hyperedges = graph?.["hyperedges"] ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new Error("Graph output has no nodes");
  if (!(Array.isArray(links) && Array.isArray(hyperedges)))
    throw new Error("Graph output has an invalid shape");

  const nodeIds = new Map<string, string>();
  const semanticNodeIds = new Set<string>();
  const canonicalNodes: string[] = [];
  for (const value of nodes) {
    const node = asRecord(value);
    const rawId = node?.["id"];
    if (
      !node ||
      typeof rawId !== "string" ||
      rawId.length === 0 ||
      nodeIds.has(rawId)
    ) {
      throw new Error("Graph output has an invalid node identity");
    }
    const semanticNode = Object.fromEntries(
      Object.entries(node).filter(([key]) => {
        return key !== "id" && key !== "community" && key !== "norm_label";
      })
    );
    const canonicalNode = canonicalJson(semanticNode);
    const semanticId = calculateContentDigest(canonicalNode);
    if (semanticNodeIds.has(semanticId)) {
      throw new Error("Graph output has indistinguishable semantic nodes");
    }
    semanticNodeIds.add(semanticId);
    nodeIds.set(rawId, semanticId);
    canonicalNodes.push(canonicalNode);
  }

  const canonicalLinks = links.map((value) => {
    const link = asRecord(value);
    if (
      !link ||
      typeof link["source"] !== "string" ||
      typeof link["target"] !== "string" ||
      !nodeIds.has(link["source"]) ||
      !nodeIds.has(link["target"])
    )
      throw new Error("Graph output has an invalid link endpoint");
    return canonicalJson({
      ...link,
      source: nodeIds.get(link["source"]),
      target: nodeIds.get(link["target"]),
    });
  });
  const hyperedgeIds = new Set<string>();
  const canonicalHyperedges = hyperedges.map((value) => {
    return canonicalJson(
      canonicalizeHyperedge(value, nodeIds, semanticNodeIds, hyperedgeIds)
    );
  });
  const graphMetadata = Object.fromEntries(
    Object.entries(graph as Record<string, unknown>).filter(([key]) => {
      return (
        key !== "built_at_commit" &&
        key !== "nodes" &&
        key !== "links" &&
        key !== "hyperedges"
      );
    })
  );
  const canonicalGraph = [
    canonicalJson(graphMetadata),
    `[${canonicalNodes.sort(compareCanonicalText).join(",")}]`,
    `[${canonicalLinks.sort(compareCanonicalText).join(",")}]`,
    `[${canonicalHyperedges.sort(compareCanonicalText).join(",")}]`,
  ].join("\0");
  return calculateContentDigest(canonicalGraph);
};

function updateFingerprint(
  hash: ReturnType<typeof createHash>,
  path: string,
  content: string
): void {
  hash.update(String(Buffer.byteLength(path, "utf8")));
  hash.update(":");
  hash.update(path);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(content, "utf8")));
  hash.update(":");
  hash.update(content);
  hash.update("\0");
}

export const calculateSourceFingerprint = (
  entries: readonly (readonly [string, string])[]
): string => {
  const hash = createHash("sha256");
  for (const [path, content] of [...entries].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    updateFingerprint(hash, path, content);
  }
  return hash.digest("hex");
};

const serializeManifest = (manifest: GraphManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

const inspectGraphifyVersion = async (
  dependencies: GraphDependencies,
  command: string,
  prefix: readonly string[]
): Promise<string | null> => {
  try {
    const result = await dependencies.process.run(
      command,
      [...prefix, "--version"],
      {
        ...COMMAND_OPTIONS,
        timeoutMs: 30_000,
      }
    );
    if (result.exitCode !== 0) return null;
    const match = result.stdout
      .trim()
      .match(/(?:graphify\s+)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

// Reads the exact graphifyy version from a pip-compile requirements lock.
export const parsePinnedGraphifyVersion = (lock: string): string => {
  const pins = [...lock.matchAll(/^graphifyy==(\S+?)(?:\s|\\|$)/gm)].map(
    (match) => match[1]
  );
  const [pin] = pins;
  if (
    pins.length !== 1 ||
    pin === undefined ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pin)
  ) {
    throw new Error("Graphify lock must pin exactly one graphifyy version");
  }
  return pin;
};

const PYTHON_MODULE_PREFIX: readonly string[] = Object.freeze([
  "-m",
  "graphify",
]);
const PATH_GRAPHIFY_PREFIX: readonly string[] = Object.freeze([]);

// Returns the Graphify to run, or the reason none can run. Without a toolchain
// (tests, embedders) PATH Graphify is used at any version.
const resolveGraphify = async (
  dependencies: GraphDependencies
): Promise<GraphifyTool | string> => {
  const pathVersion = await inspectGraphifyVersion(
    dependencies,
    "graphify",
    PATH_GRAPHIFY_PREFIX
  );
  const toolchain = dependencies.toolchain;
  if (!toolchain) {
    return pathVersion
      ? Object.freeze({
          command: "graphify",
          prefix: PATH_GRAPHIFY_PREFIX,
          version: pathVersion,
        })
      : "Graphify is unavailable or returned an invalid version";
  }

  let pinned: string;
  try {
    pinned = await toolchain.pinnedVersion();
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Graphify lock is unreadable";
  }
  if (pathVersion === pinned) {
    return Object.freeze({
      command: "graphify",
      prefix: PATH_GRAPHIFY_PREFIX,
      version: pinned,
    });
  }

  const pinnedTool = async (
    python: string | null
  ): Promise<GraphifyTool | null> => {
    if (!python) return null;
    const version = await inspectGraphifyVersion(
      dependencies,
      python,
      PYTHON_MODULE_PREFIX
    );
    return version === pinned
      ? Object.freeze({
          command: python,
          prefix: PYTHON_MODULE_PREFIX,
          version: pinned,
        })
      : null;
  };

  let existing: string | null;
  try {
    existing = await toolchain.pinnedPython();
  } catch {
    existing = null;
  }
  const cached = await pinnedTool(existing);
  if (cached) return cached;

  const requirement = `Graphify ${pinned} is required (PATH has ${pathVersion ?? "none"})`;
  let provisioned: string;
  try {
    provisioned = await toolchain.provision();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "unknown provisioning failure";
    return `${requirement} and the pinned venv failed: ${detail}`;
  }
  return (
    (await pinnedTool(provisioned)) ??
    `${requirement} and the pinned venv did not report it`
  );
};

const inspectSources = async (
  dependencies: GraphDependencies,
  config: GraphConfig
): Promise<Readonly<{ fingerprint: string; fileCount: number }>> => {
  const paths = [
    ...new Set(await dependencies.files.listSourceFiles(config)),
  ].sort();
  if (paths.length === 0)
    throw new Error("Architectural source corpus is empty");
  if (paths.length > MAX_SOURCE_FILES)
    throw new Error("Architectural source corpus has too many files");

  let totalBytes = 0;
  const hash = createHash("sha256");
  for (const path of paths) {
    if (!isSafeRelative(path))
      throw new Error("Source listing returned an unsafe path");
    const info = await dependencies.files.inspect(path);
    if (info.kind !== "file")
      throw new Error(`Architectural source is not a regular file: ${path}`);
    if (
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      info.size > MAX_SOURCE_FILE_BYTES
    ) {
      throw new Error(`Architectural source is too large: ${path}`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES)
      throw new Error("Architectural source corpus is too large");
    const content = await dependencies.files.readText(
      path,
      MAX_SOURCE_FILE_BYTES
    );
    if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Architectural source is too large: ${path}`);
    }
    updateFingerprint(hash, path, content);
  }
  return Object.freeze({
    fingerprint: hash.digest("hex"),
    fileCount: paths.length,
  });
};

const inspectGraph = async (
  dependencies: GraphDependencies,
  config: GraphConfig
): Promise<Readonly<{ digest: string }>> => {
  const content = await readRegularFile(
    dependencies.files,
    config.graphPath,
    MAX_GRAPH_BYTES,
    "Graph output"
  );
  return Object.freeze({ digest: calculateGraphDigest(content) });
};

const failure = (action: GraphAction, reason: string): GraphReport =>
  Object.freeze({
    action,
    ok: false,
    fresh: false,
    reason,
  });

const GRAPH_NOT_BUILT = "Graph is not built; run bun run graph:build first";

const isMissing = async (
  files: GraphFileSystem,
  path: string
): Promise<boolean> => {
  try {
    return (await files.inspect(path)).kind === "missing";
  } catch {
    return false;
  }
};

const inspectFreshness = async (
  action: GraphAction,
  dependencies: GraphDependencies,
  config: GraphConfig,
  configSource: string,
  graphifyVersion: string
): Promise<GraphReport> => {
  // The graph and its manifest are local, untracked build outputs.
  for (const path of [config.graphPath, config.manifestPath]) {
    if (await isMissing(dependencies.files, path))
      return failure(action, GRAPH_NOT_BUILT);
  }
  let graph: Readonly<{ digest: string }>;
  try {
    graph = await inspectGraph(dependencies, config);
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : "Missing graph output"
    );
  }

  let manifest: GraphManifest;
  try {
    manifest = parseManifest(
      await readRegularFile(
        dependencies.files,
        config.manifestPath,
        MAX_CONFIG_BYTES,
        "Graph manifest"
      )
    );
  } catch {
    return failure(action, "Graph manifest is missing or malformed");
  }

  const sources = await inspectSources(dependencies, config);
  if (
    manifest.configDigest !== calculateContentDigest(configSource) ||
    manifest.graphDigest !== graph.digest ||
    manifest.sourceFingerprint !== sources.fingerprint ||
    manifest.sourceFileCount !== sources.fileCount
  )
    return Object.freeze({
      action,
      ok: false,
      fresh: false,
      reason: "Graph metadata is stale or its digest differs",
      sourceFileCount: sources.fileCount,
      sourceFingerprint: sources.fingerprint,
      graphifyVersion,
    });
  if (manifest.graphifyVersion !== graphifyVersion) {
    return Object.freeze({
      action,
      ok: false,
      fresh: false,
      reason: "Graphify version differs from the recorded manifest",
      sourceFileCount: sources.fileCount,
      sourceFingerprint: sources.fingerprint,
      graphifyVersion,
    });
  }

  return Object.freeze({
    action,
    ok: true,
    fresh: true,
    reason: "Graph and tracked source metadata are fresh",
    sourceFileCount: sources.fileCount,
    sourceFingerprint: sources.fingerprint,
    graphifyVersion,
  });
};

const buildOrUpdate = async (
  action: "build" | "update",
  dependencies: GraphDependencies,
  config: GraphConfig,
  configSource: string,
  graphify: GraphifyTool
): Promise<GraphReport> => {
  const graphifyVersion = graphify.version;
  const before = await inspectSources(dependencies, config);
  let snapshot: Awaited<ReturnType<GraphFileSystem["createSourceSnapshot"]>>;
  try {
    snapshot = await dependencies.files.createSourceSnapshot(config);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "unknown snapshot failure";
    return failure(action, `Graph source snapshot failed: ${detail}`);
  }
  let execution: GraphCommandResult;
  try {
    try {
      await dependencies.files.resetGraphOutput(config.graphPath);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "unknown output reset failure";
      return failure(action, `Graph output reset failed: ${detail}`);
    }
    execution = await dependencies.process.run(
      graphify.command,
      [...graphify.prefix, "extract", snapshot.path, "--out", "."],
      {
        ...COMMAND_OPTIONS,
        environment: { GRAPHIFY_MAX_WORKERS: "1", PYTHONHASHSEED: "0" },
        timeoutMs: EXTRACT_TIMEOUT_MS,
      }
    );
  } finally {
    await snapshot.cleanup();
  }
  if (execution.timedOut) {
    return failure(
      action,
      `Graphify ${action} timed out after ${EXTRACT_TIMEOUT_MS / 1000} s`
    );
  }
  if (execution.exitCode !== 0) {
    const lastLine = execution.stderr
      .trim()
      .split("\n")
      .at(-1)
      ?.trim()
      .slice(0, 300);
    return failure(
      action,
      `Graphify ${action} command failed (exit ${execution.exitCode})${lastLine ? `: ${lastLine}` : ""}`
    );
  }

  const after = await inspectSources(dependencies, config);
  if (
    before.fingerprint !== after.fingerprint ||
    before.fileCount !== after.fileCount
  ) {
    return failure(
      action,
      "Architectural sources changed during Graphify extraction"
    );
  }

  let graph: Readonly<{ digest: string }>;
  try {
    graph = await inspectGraph(dependencies, config);
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : "Graphify produced no graph"
    );
  }

  const manifest: GraphManifest = Object.freeze({
    version: 1,
    graphifyVersion,
    configDigest: calculateContentDigest(configSource),
    graphDigest: graph.digest,
    sourceFingerprint: after.fingerprint,
    sourceFileCount: after.fileCount,
  });
  await dependencies.files.writeText(
    config.manifestPath,
    serializeManifest(manifest)
  );
  return Object.freeze({
    action,
    ok: true,
    fresh: true,
    reason: `Graphify ${action} completed and metadata was recorded`,
    sourceFileCount: after.fileCount,
    sourceFingerprint: after.fingerprint,
    graphifyVersion,
  });
};

const pathQuerySucceeded = (
  stdout: string,
  from: string,
  to: string
): boolean => {
  return (
    /^Shortest path \(\d+ hops?\):/m.test(stdout) &&
    stdout.includes(from) &&
    stdout.includes(to)
  );
};

export const runGraphAction = async (
  action: GraphAction,
  dependencies: GraphDependencies
): Promise<GraphReport> => {
  let configSource: string;
  let config: GraphConfig;
  try {
    configSource = await readRegularFile(
      dependencies.files,
      ".graphify/config.json",
      MAX_CONFIG_BYTES,
      "Graph config"
    );
    config = parseGraphConfig(configSource);
  } catch {
    return failure(action, "Graph config is missing or malformed");
  }

  const graphify = await resolveGraphify(dependencies);
  if (typeof graphify === "string") return failure(action, graphify);
  const graphifyVersion = graphify.version;

  try {
    if (action === "build" || action === "update") {
      return await buildOrUpdate(
        action,
        dependencies,
        config,
        configSource,
        graphify
      );
    }

    const freshness = await inspectFreshness(
      action,
      dependencies,
      config,
      configSource,
      graphifyVersion
    );
    if (!freshness.ok || action === "check") return freshness;

    let verified = 0;
    for (
      let index = 0;
      index < config.verificationPath.length - 1;
      index += 1
    ) {
      const from = required(
        config.verificationPath[index],
        "verification path node"
      );
      const to = required(
        config.verificationPath[index + 1],
        "verification path node"
      );
      const query = await dependencies.process.run(
        graphify.command,
        [...graphify.prefix, "path", from, to],
        {
          ...COMMAND_OPTIONS,
          timeoutMs: 30_000,
          environment: { GRAPHIFY_QUERY_LOG_DISABLE: "1" },
        }
      );
      if (query.exitCode !== 0 || !pathQuerySucceeded(query.stdout, from, to)) {
        return Object.freeze({
          ...freshness,
          action,
          ok: false,
          reason: `Graph verification path failed between ${from} and ${to}`,
          queriesVerified: verified,
        });
      }
      verified += 1;
    }

    return Object.freeze({
      ...freshness,
      action,
      reason: "Graph is fresh and the architectural verification path resolves",
      queriesVerified: verified,
    });
  } catch {
    return failure(action, `Graph ${action} inspection failed`);
  }
};
