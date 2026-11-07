// No JSON data files (owner rule 2026-11-07, card vertex-no-json-data): the app does not read or
// store data in JSON files. Data lives in Postgres and is served by oRPC. Allowed JSON: build and
// tool config, test fixtures, generated artifacts and vendored code. scripts/ci/json-data.test.ts
// enforces this rule with the classifiers below and the lists in json-data-allowlist.ts. A new kind
// of tool config extends the classifier here; the lists only shrink.

export type JsonFileClass = "config" | "fixture" | "generated" | "vendor";

const JSON_EXTENSION = String.raw`\.(?:json5?|jsonc|jsonl|ndjson|geojson)(?:\.(?:gz|zst|br))?`;
const JSON_FILE = new RegExp(`${JSON_EXTENSION}$`, "iu");

// Config names that are valid in any folder (tool config that lives next to its package).
const CONFIG_ANYWHERE = [
  /^package\.json$/u,
  /^tsconfig(?:\.[\w-]+)*\.json$/u,
  /^wrangler(?:\.[\w-]+)?\.jsonc?$/u,
  /^deno\.jsonc?$/u,
  /\.schema\.json$/u,
];
// Config files tied to where the tool reads them.
const CONFIG_PATHS = [
  /^(?:\.bestpractices\.json|\.mcp\.json|biome\.jsonc?|knip\.jsonc?|renovate\.json|turbo\.json)$/u,
  /^\.markdownlint[\w.-]*\.jsonc?$/u,
  /^(?:apps|packages)\/[^/]+\/(?:components\.json|biome\.jsonc?|turbo\.json)$/u,
  /^\.devcontainer\/[^/]+\.json$/u,
  /^\.github\/[^/]+\.json$/u,
  /(?:^|\/)\.vscode\/[^/]+\.jsonc?$/u,
];

const FIXTURE_SEGMENTS =
  /(?:^|\/)(?:fixtures|__fixtures__|tests?|__tests__|e2e)\//u;
const FIXTURE_BASENAME = /\.fixture\.json$/u;

// Known generator outputs only; a generic `generated/` folder could hide committed data.
const GENERATED_PATHS = [
  /^packages\/db\/migrations\/meta\/[^/]+\.json$/u,
  /^packages\/db\/migration-sources\/[^/]+\/generated\/[^/]+\.json$/u,
  /^packages\/api\/openapi\.json$/u,
];

const VENDOR_SEGMENT = /(?:^|\/)(?:vendor|node_modules)\//u;

export const isJsonFile = (path: string): boolean => JSON_FILE.test(path);

const isConfigName = (name: string): boolean =>
  CONFIG_ANYWHERE.some((pattern) => pattern.test(name));

/** The allowed class of a tracked JSON file, or null when the file holds data. */
export function classifyJsonFile(path: string): JsonFileClass | null {
  if (VENDOR_SEGMENT.test(path)) return "vendor";
  if (
    isConfigName(path.slice(path.lastIndexOf("/") + 1)) ||
    CONFIG_PATHS.some((pattern) => pattern.test(path))
  )
    return "config";
  if (GENERATED_PATHS.some((pattern) => pattern.test(path))) return "generated";
  if (FIXTURE_SEGMENTS.test(path) || FIXTURE_BASENAME.test(path))
    return "fixture";
  return null;
}

// App and server runtime code. Build tooling under apps/*/scripts and packages/*/scripts is not
// runtime; infra/**/scripts is (systemd units run it), and so are the top-level tick scripts.
const RUNTIME_ROOTS = /^(?:apps|infra|packages|services)\//u;
const RUNTIME_TOP_LEVEL = /^scripts\/vertex-[\w-]+-tick\.ts$/u;
const RUNTIME_SOURCE =
  /(?:\.(?:[cm]?[jt]sx?|py|rs|sh|go|civet|ya?ml|service|path|timer|conf|env)|(?:^|\/)(?:Caddyfile|Dockerfile)[^/]*)$/u;
const NOT_RUNTIME = [
  /\.(?:test|spec|acceptance)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)[^/]*test-support[^/]*$/u,
  /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/u,
  /(?:^|\/)(?:fixtures|__fixtures__|tests?|__tests__|e2e)\//u,
  /^(?:apps|packages)\/[^/]+\/scripts\//u,
  /(?:^|\/)(?:vendor|node_modules)\//u,
  /(?:^|\/)vitest\.config\.[cm]?[jt]s$/u,
];

/** True for tracked app or server runtime files (code and unit/config files) that the reader scan covers. */
export const isRuntimeSource = (path: string): boolean =>
  (RUNTIME_ROOTS.test(path) || RUNTIME_TOP_LEVEL.test(path)) &&
  RUNTIME_SOURCE.test(path) &&
  !NOT_RUNTIME.some((pattern) => pattern.test(path));

// A path or name that ends in a JSON extension, quoted or not; `.json(` (a method call) is not one.
const JSON_NAME = new RegExp(
  String.raw`(?<![\w$])[\w\${}:~.@/-]*${JSON_EXTENSION}(?![\w(])`,
  "giu"
);
// Imports of fixture modules from runtime code ship test data in the app.
const FIXTURE_IMPORT =
  /(?<=(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`])[^"'`\n]*\/(?:fixtures|__fixtures__)\/[^"'`\n]*(?=["'`])/gu;
// Third-party JSON endpoints the app may fetch; any other absolute URL counts.
const THIRD_PARTY_JSON = /^https:\/\/(?:www\.|data\.)?sec\.gov\//u;

const LINE_COMMENT = /^\s*(?:\/\/|#(?:\s|$)|\*|\/\*)/u;
// `reply.json` outside quotes is a property access, not a file name.
const PROPERTY_ACCESS = /^[A-Za-z_$][\w$]*\.json$/u;
const QUOTE = /["'`]/u;

/**
 * Distinct JSON data names in one runtime file: JSON paths and file names (not package/tsconfig/
 * wrangler config names, not known third-party URLs, not unquoted `name.json` property access) and
 * fixture-module imports. Comment-only lines do not count.
 */
export function jsonDataReferences(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    if (LINE_COMMENT.test(line)) continue;
    for (const { 0: name, index } of line.matchAll(JSON_NAME)) {
      if (THIRD_PARTY_JSON.test(name)) continue;
      if (PROPERTY_ACCESS.test(name) && !QUOTE.test(line.charAt(index - 1)))
        continue;
      if (isConfigName(name.slice(name.lastIndexOf("/") + 1))) continue;
      names.add(name);
    }
    for (const [target] of line.matchAll(FIXTURE_IMPORT)) names.add(target);
  }
  return [...names].sort();
}

export type GateViolation = Readonly<{ path: string; problem: string }>;

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
  const dataFiles = tracked.filter(
    (path) => isJsonFile(path) && classifyJsonFile(path) === null
  );
  for (const path of dataFiles) {
    const onPending = pending.includes(path);
    const onKept = Object.hasOwn(kept, path);
    if (!(onPending || onKept))
      violations.push({
        path,
        problem:
          "new JSON data file: store the data in Postgres and serve it through oRPC (AGENTS.md rule 13)",
      });
    else if (onPending && onKept)
      violations.push({ path, problem: "listed as both pending and kept" });
  }
  for (const entry of [...pending, ...Object.keys(kept)])
    if (!dataFiles.includes(entry))
      violations.push({
        path: entry,
        problem: "allowlist entry matches no tracked JSON data file: remove it",
      });
  return violations;
}

/**
 * Ratchet for runtime JSON data access: each runtime file may name only the JSON data names recorded
 * for it. A recorded name that is gone must be removed from the baseline.
 */
export function checkRuntimeReaders(
  found: ReadonlyMap<string, readonly string[]>,
  baseline: Readonly<Record<string, readonly string[]>>
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const [path, names] of found) {
    const allowed = baseline[path] ?? [];
    for (const name of names)
      if (!allowed.includes(name))
        violations.push({
          path,
          problem: `new JSON data reference ${name}: read the data from Postgres through a repository (AGENTS.md rule 13)`,
        });
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    if (!isRuntimeSource(path)) {
      violations.push({
        path,
        problem:
          "baseline entry is not a runtime file: moving a reader out of runtime scope does not remove it",
      });
      continue;
    }
    const names = found.get(path) ?? [];
    for (const name of allowed)
      if (!names.includes(name))
        violations.push({
          path,
          problem: `JSON data reference ${name} is gone: remove it from scripts/ci/json-data-allowlist.ts`,
        });
  }
  return violations;
}
