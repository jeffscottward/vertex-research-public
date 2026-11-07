// No JSON data files (owner rule 2026-11-07, card vertex-no-json-data): the app does not read or
// store data in JSON files. Data lives in Postgres and is served by oRPC. Allowed JSON: build and
// tool config, test fixtures, generated artifacts and vendored code. scripts/ci/json-data.test.ts
// enforces this rule with the classifiers below and the lists in json-data-allowlist.ts.

export type JsonFileClass = "config" | "fixture" | "generated" | "vendor";

const JSON_FILE = /\.(?:json|jsonc|jsonl|ndjson)$/u;

const CONFIG_BASENAMES: Readonly<Record<string, true>> = {
  ".bestpractices.json": true,
  "biome.json": true,
  "biome.jsonc": true,
  "components.json": true,
  "deno.json": true,
  "knip.json": true,
  "knip.jsonc": true,
  "package.json": true,
  "renovate.json": true,
  "turbo.json": true,
};
const CONFIG_BASENAME_PATTERNS = [
  /^\.markdownlint[\w.-]*\.jsonc?$/u,
  /^tsconfig(?:\.[\w-]+)?\.json$/u,
  /^wrangler(?:\.[\w-]+)?\.jsonc?$/u,
];
const CONFIG_DIRECTORIES = [".devcontainer/", ".github/", ".vscode/"];

const FIXTURE_SEGMENTS =
  /(?:^|\/)(?:fixtures|__fixtures__|tests?|__tests__|e2e)\//u;
const FIXTURE_BASENAME = /\.fixture\.json$/u;

const GENERATED_PATTERNS = [
  /^packages\/db\/migrations\/meta\/[^/]+\.json$/u,
  /(?:^|\/)generated\//u,
  /^packages\/api\/openapi\.json$/u,
];

const VENDOR_SEGMENT = /(?:^|\/)(?:vendor|node_modules)\//u;

export const isJsonFile = (path: string): boolean => JSON_FILE.test(path);

/** The allowed class of a tracked JSON file, or null when the file holds data. */
export function classifyJsonFile(path: string): JsonFileClass | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (VENDOR_SEGMENT.test(path)) return "vendor";
  if (
    Object.hasOwn(CONFIG_BASENAMES, name) ||
    CONFIG_BASENAME_PATTERNS.some((pattern) => pattern.test(name)) ||
    CONFIG_DIRECTORIES.some((directory) => path.startsWith(directory))
  )
    return "config";
  if (GENERATED_PATTERNS.some((pattern) => pattern.test(path)))
    return "generated";
  if (FIXTURE_SEGMENTS.test(path) || FIXTURE_BASENAME.test(name))
    return "fixture";
  return null;
}

/** Roots that hold app and server runtime code. Dev tooling (scripts/, research/) is not runtime. */
const RUNTIME_ROOTS = ["apps/", "infra/", "packages/", "services/"];
const RUNTIME_SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|sh|go)$/u;
const NOT_RUNTIME = [
  /\.(?:test|spec|acceptance)\.[cm]?[jt]sx?$/u,
  /\.test-support\.[cm]?[jt]sx?$/u,
  /(?:^|\/)test-support[^/]*$/u,
  /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/u,
  /(?:^|\/)(?:fixtures|__fixtures__|tests?|__tests__|e2e)\//u,
  /(?:^|\/)scripts\//u,
  /(?:^|\/)(?:vendor|node_modules)\//u,
  /(?:^|\/)vitest\.config\.[cm]?[jt]s$/u,
];

/** True for tracked app or server runtime source files that the reader scan covers. */
export const isRuntimeSource = (path: string): boolean =>
  RUNTIME_ROOTS.some((root) => path.startsWith(root)) &&
  RUNTIME_SOURCE.test(path) &&
  !NOT_RUNTIME.some((pattern) => pattern.test(path));

// A quoted path or name that ends in a JSON extension: static imports, fs paths, served file names.
const JSON_LITERAL = /(?<=["'`])[^"'`\n]*\.(?:json|jsonl|ndjson)(?=["'`])/gu;
const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** JSON data file names in one runtime source file; remote URLs and config file names do not count. */
export function jsonDataReferences(source: string): string[] {
  const hits: string[] = [];
  for (const [literal] of source.matchAll(JSON_LITERAL)) {
    if (REMOTE.test(literal)) continue;
    if (classifyJsonFile(literal) === "config") continue;
    hits.push(literal);
  }
  return hits;
}

export type GateViolation = Readonly<{ path: string; problem: string }>;

/** Entries ending in "/" match every file below that directory. */
export const matchesEntry = (path: string, entry: string): boolean =>
  entry.endsWith("/") ? path.startsWith(entry) : path === entry;

/**
 * Checks every tracked JSON data file against the pending and kept lists. Each data file must be on
 * exactly one list, and every list entry must still match a tracked data file.
 */
export function checkJsonFiles(
  tracked: readonly string[],
  pending: readonly string[],
  kept: Readonly<Record<string, string>>
): GateViolation[] {
  const violations: GateViolation[] = [];
  const keptEntries = Object.keys(kept);
  const dataFiles = tracked.filter(
    (path) => isJsonFile(path) && classifyJsonFile(path) === null
  );
  for (const path of dataFiles) {
    const onPending = pending.some((entry) => matchesEntry(path, entry));
    const onKept = keptEntries.some((entry) => matchesEntry(path, entry));
    if (!(onPending || onKept))
      violations.push({
        path,
        problem:
          "new JSON data file: store the data in Postgres and serve it through oRPC (AGENTS.md rule 13)",
      });
    else if (onPending && onKept)
      violations.push({ path, problem: "listed as both pending and kept" });
  }
  for (const entry of [...pending, ...keptEntries])
    if (!dataFiles.some((path) => matchesEntry(path, entry)))
      violations.push({
        path: entry,
        problem: "allowlist entry matches no tracked JSON data file: remove it",
      });
  return violations;
}

/**
 * Ratchet for runtime JSON data access: each runtime source file may name at most the recorded
 * number of JSON data files, and a count that dropped must be lowered in the baseline.
 */
export function checkRuntimeReaders(
  counts: ReadonlyMap<string, number>,
  baseline: Readonly<Record<string, number>>
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const [path, count] of counts) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed)
      violations.push({
        path,
        problem: `${count} JSON data references, baseline ${allowed}: read the data from Postgres through a repository (AGENTS.md rule 13)`,
      });
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const count = counts.get(path) ?? 0;
    if (count < allowed)
      violations.push({
        path,
        problem: `${count} JSON data references, baseline ${allowed}: lower the baseline in scripts/ci/json-data-allowlist.ts`,
      });
  }
  return violations;
}
