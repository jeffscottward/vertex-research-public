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
  // "uv" also passes uv's own settings (UV_*, XDG_*, proxies) to the child.
  environmentProfile?: "graphify" | "uv";
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
// the wrapper always runs it from a hash-locked venv built from that lock, never
// a Graphify on PATH (same rule as surplus-funds-recovery scripts/graph).
export type GraphToolchain = Readonly<{
  pinnedVersion: () => Promise<string>;
  // Python of an existing pinned venv, or null when none was provisioned yet.
  pinnedPython: () => Promise<string | null>;
  // Builds the pinned venv from the lock and returns its Python. After the
  // install, replaceExisting decides whether a cached venv is still broken and
  // must be discarded (asked then, not before the minutes-long install, so a
  // venv another run repaired meanwhile is kept); otherwise a venv another run
  // installed first is kept.
  provision: (
    options: Readonly<{ replaceExisting: () => Promise<boolean> }>
  ) => Promise<string>;
}>;

export type GraphDependencies = Readonly<{
  files: GraphFileSystem;
  process: GraphProcess;
  toolchain: GraphToolchain;
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

// Graphify AST placeholders for external names (Python `Path`, `Any`, ...) have
// no source metadata, so only the raw id tells them apart. The id embeds the
// random snapshot directory (system.ts: `darkfactory-graph-<hash16>-<random6>`
// then `active/`); the rest is the stable repository path and name. Anchoring
// on that directory keeps an `active` path segment or name in the scope.
const SNAPSHOT_ID_PREFIX =
  /darkfactory_graph_[0-9a-f]{16}_[0-9a-z]{6}_active_/i;

const graphifyAstPlaceholderScope = (
  node: Readonly<Record<string, unknown>>,
  rawId: string
): string | undefined => {
  if (
    node["_origin"] !== "ast" ||
    node["source_file"] !== "" ||
    node["source_location"] !== ""
  )
    return undefined;
  const prefix = SNAPSHOT_ID_PREFIX.exec(rawId);
  return prefix ? rawId.slice(prefix.index + prefix[0].length) : undefined;
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
    const placeholderScope = graphifyAstPlaceholderScope(node, rawId);
    const canonicalNode = canonicalJson(
      placeholderScope === undefined
        ? semanticNode
        : { ...semanticNode, graphify_ast_scope: placeholderScope }
    );
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

// Accepts only a line that is a whole version (`graphify X.Y.Z`, `X.Y.Z` or
// `vX.Y.Z`), so a banner or a prerelease suffix cannot pass as the pinned
// version; the first such line wins.
export const parseGraphifyVersionOutput = (stdout: string): string | null =>
  stdout.match(
    /^[ \t]*(?:graphify[ \t]+)?v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)[ \t]*\r?$/im
  )?.[1] ?? null;

// -P keeps the repository root off sys.path, so no local graphify module can
// shadow the venv's.
const PYTHON_MODULE_PREFIX: readonly string[] = Object.freeze([
  "-P",
  "-m",
  "graphify",
]);

type VersionProbe = Readonly<{ version: string | null; timedOut: boolean }>;

const inspectGraphifyVersion = async (
  dependencies: GraphDependencies,
  python: string
): Promise<VersionProbe> => {
  try {
    const result = await dependencies.process.run(
      python,
      [...PYTHON_MODULE_PREFIX, "--version"],
      {
        ...COMMAND_OPTIONS,
        timeoutMs: 30_000,
      }
    );
    return {
      version:
        result.exitCode === 0
          ? parseGraphifyVersionOutput(result.stdout)
          : null,
      timedOut: result.timedOut === true,
    };
  } catch {
    return { version: null, timedOut: false };
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

const readPinnedVersion = async (
  dependencies: GraphDependencies
): Promise<string> => {
  try {
    return await dependencies.toolchain.pinnedVersion();
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Graphify lock is unreadable"
    );
  }
};

// Returns the Graphify to run, or the reason none can run. Graphify always runs
// from the hash-locked venv, never from PATH: a PATH graphify of the pinned
// version can still carry other tree-sitter or networkx versions.
const resolveGraphify = async (
  dependencies: GraphDependencies
): Promise<GraphifyTool | string> => {
  const toolchain = dependencies.toolchain;
  let pinned: string;
  try {
    pinned = await readPinnedVersion(dependencies);
  } catch (error) {
    return (error as Error).message;
  }

  let existing: string | null;
  try {
    existing = await toolchain.pinnedPython();
  } catch {
    existing = null;
  }
  if (existing) {
    const cached = await inspectGraphifyVersion(dependencies, existing);
    if (cached.version === pinned) {
      return Object.freeze({
        command: existing,
        prefix: PYTHON_MODULE_PREFIX,
        version: pinned,
      });
    }
    // A probe that timed out says nothing about the venv (the rig may be
    // busy, and other runs may be using it), so only a venv that answered
    // with another version or an error is replaced.
    if (cached.timedOut) {
      return `Graphify ${pinned} venv did not answer its version probe in time`;
    }
  }

  let provisioned: string;
  try {
    provisioned = await toolchain.provision({
      replaceExisting: async () => {
        if (existing === null) return false;
        const recheck = await inspectGraphifyVersion(dependencies, existing);
        return !recheck.timedOut && recheck.version !== pinned;
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "unknown provisioning failure";
    return `Graphify ${pinned} venv provisioning failed: ${detail}`;
  }
  const fresh = await inspectGraphifyVersion(dependencies, provisioned);
  return fresh.version === pinned
    ? Object.freeze({
        command: provisioned,
        prefix: PYTHON_MODULE_PREFIX,
        version: pinned,
      })
    : `Graphify ${pinned} venv did not report version ${pinned}`;
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

  if (action === "build" || action === "update") {
    const graphify = await resolveGraphify(dependencies);
    if (typeof graphify === "string") return failure(action, graphify);
    try {
      return await buildOrUpdate(
        action,
        dependencies,
        config,
        configSource,
        graphify
      );
    } catch {
      return failure(action, `Graph ${action} inspection failed`);
    }
  }

  // check and verify compare the metadata with the pinned version first: a
  // stale graph is reported without running or provisioning Graphify, and only
  // verify then needs a runnable Graphify.
  let pinned: string;
  try {
    pinned = await readPinnedVersion(dependencies);
  } catch (error) {
    return failure(action, (error as Error).message);
  }

  try {
    const freshness = await inspectFreshness(
      action,
      dependencies,
      config,
      configSource,
      pinned
    );
    if (!freshness.ok || action === "check") return freshness;
    const graphify = await resolveGraphify(dependencies);
    if (typeof graphify === "string") return failure(action, graphify);

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
