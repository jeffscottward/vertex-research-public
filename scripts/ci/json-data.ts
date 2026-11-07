// No JSON data files (owner rule 2026-11-07, card vertex-no-json-data): the app does not read or
// store data in JSON files. Data lives in Postgres and is served by oRPC. Allowed JSON: build and
// tool config, test fixtures, generated artifacts and vendored code. scripts/ci/json-data.test.ts
// enforces this rule with the classifiers below and the lists in json-data-allowlist.ts. A new kind
// of tool config extends the classifier here; the lists only shrink.

export type JsonFileClass = "config" | "fixture" | "generated" | "vendor";

const JSON_EXTENSION = String.raw`\.(?:json5?|jsonc|jsonl|ndjson|geojson)(?:\.(?:gz|zst|br))?`;
const JSON_FILE = new RegExp(`${JSON_EXTENSION}$`, "iu");

// Config names that are valid in the repository root, a package root or a top-level tool folder.
const PACKAGE_CONFIG =
  /^(?:(?:apps|packages|services)\/[^/]+\/|(?:infra|scripts|tests)\/)?(?:package\.json|tsconfig(?:\.[\w-]+)*\.json|wrangler(?:\.[\w-]+)?\.jsonc?|deno\.jsonc?|components\.json|biome\.jsonc?|turbo\.json)$/u;
// Config files tied to where their tool reads them.
const CONFIG_PATHS = [
  PACKAGE_CONFIG,
  /^(?:\.bestpractices\.json|\.mcp\.json|knip\.jsonc?|renovate\.json)$/u,
  /^\.markdownlint[\w.-]*\.jsonc?$/u,
  /^docs\/.+\.schema\.json$/u,
  /^\.devcontainer\/[^/]+\.json$/u,
  /^\.github\/[^/]+\.json$/u,
  /(?:^|\/)\.vscode\/[^/]+\.jsonc?$/u,
];
// Config names that code may mention without reading data (package manifests and compiler config).
const CONFIG_NAME =
  /^(?:package\.json|tsconfig(?:\.[\w-]+)*\.json|wrangler\.jsonc?)$/u;

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

/** The allowed class of a tracked JSON file, or null when the file holds data. */
export function classifyJsonFile(path: string): JsonFileClass | null {
  if (VENDOR_SEGMENT.test(path)) return "vendor";
  if (CONFIG_PATHS.some((pattern) => pattern.test(path))) return "config";
  if (GENERATED_PATHS.some((pattern) => pattern.test(path))) return "generated";
  if (FIXTURE_SEGMENTS.test(path) || FIXTURE_BASENAME.test(path))
    return "fixture";
  return null;
}

// App and server runtime code. Build tooling under apps/*/scripts and packages/*/scripts is not
// runtime; infra/**/scripts is (systemd units run it), and so are the top-level scripts/vertex-*.ts
// entry points (timers and workers run them). Executable files count whatever their name.
const RUNTIME_ROOTS = /^(?:apps|infra|packages|services)\//u;
const RUNTIME_TOP_LEVEL = /^scripts\/vertex-[\w-]+\.ts$/u;
const RUNTIME_SOURCE =
  /(?:\.(?:[cm]?[jt]sx?|py|rs|sh|go|civet|ya?ml|env)|\.(?:service|path|timer|conf)(?:\.[\w-]+)*|(?:^|\/)(?:Caddyfile|Dockerfile)[^/]*)$/u;
const NOT_RUNTIME = [
  /\.(?:test|spec|acceptance)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)[^/]*test-support[^/]*$/u,
  /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/u,
  /(?:^|\/)(?:fixtures|__fixtures__|tests?|__tests__|e2e)\//u,
  /^(?:apps|packages)\/[^/]+\/scripts\//u,
  /(?:^|\/)(?:vendor|node_modules)\//u,
  /(?:^|\/)vitest\.config\.[cm]?[jt]s$/u,
  /\.md$/u,
];

/** True for tracked app or server runtime files (code, units, config, executables) that the reader scan covers. */
export const isRuntimeSource = (path: string, executable = false): boolean =>
  (RUNTIME_ROOTS.test(path) || RUNTIME_TOP_LEVEL.test(path)) &&
  (executable || RUNTIME_SOURCE.test(path)) &&
  !NOT_RUNTIME.some((pattern) => pattern.test(path));

// A path or name that ends in a JSON extension, quoted or not. A match starts only where a run of
// name characters starts (linear on long lines); `.json(`, `.json<T>(` and `.json::<` are calls.
const NAME_CHARS = String.raw`\w\${}:~.@/%-`;
const JSON_NAME = new RegExp(
  String.raw`(?<![${NAME_CHARS}])[${NAME_CHARS}]*${JSON_EXTENSION}(?![\w(]|<[^>\n]*>\s*\(|::<)`,
  "giu"
);
const MAY_NAME_JSON = /json/iu;
// A bare extension (".json", "*.json") names no file.
const BARE_EXTENSION = new RegExp(`^\\*?${JSON_EXTENSION}$`, "iu");
// Imports of fixture modules from runtime code ship test data in the app.
const FIXTURE_IMPORT =
  /(?<=(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`])[^"'`\n]*\/(?:fixtures|__fixtures__)(?:\/[^"'`\n]*)?(?=["'`])/gu;
// Third-party JSON endpoints the app may fetch; any other absolute URL counts.
const THIRD_PARTY_JSON = /^https:\/\/(?:www\.|data\.)?sec\.gov\//u;

// Languages with property access and `//` comments; every other runtime file uses `#` comments.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|rs|go|civet)$/u;
const PYTHON_FILE = /\.py$/u;
const SLASH_COMMENT = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$))/u;
const HASH_COMMENT = /^\s*#(?:\s|$)/u;
// `reply.json`, `c.req.json`, `sa.JSON` outside a string literal are property access, not files.
const PROPERTY_ACCESS =
  /^(?:[A-Za-z_$][\w$]*)?(?:\.[A-Za-z_$][\w$]*)*\.json$/iu;
// A false match is marked on its line with the reason: `json-data-ignore: <why this is not data>`.
const IGNORE_MARK = /json-data-ignore: \S/u;

const insideString = (line: string, index: number): boolean => {
  const before = line.slice(0, index).replace(/\\./gu, "");
  return ['"', "'", "`"].some((quote) => before.split(quote).length % 2 === 0);
};

/** JSON data names on one line; `properties` is true where `a.json` can be property access. */
const lineDataNames = (line: string, properties: boolean): string[] =>
  [...line.matchAll(JSON_NAME)]
    .filter(
      ({ 0: name, index }) =>
        !(
          BARE_EXTENSION.test(name) ||
          THIRD_PARTY_JSON.test(name) ||
          CONFIG_NAME.test(name.slice(name.lastIndexOf("/") + 1)) ||
          (properties &&
            PROPERTY_ACCESS.test(name) &&
            !insideString(line, index))
        )
    )
    .map(([name]) => name);

/**
 * Distinct JSON data names in one runtime file: JSON paths and file names (not package, tsconfig or
 * wrangler names, not known third-party URLs, not property access in code) and fixture-module
 * imports. Comment-only lines and lines marked `json-data-ignore: <reason>` do not count.
 */
export function jsonDataReferences(source: string, path: string): string[] {
  const code = CODE_FILE.test(path);
  const comment = code ? SLASH_COMMENT : HASH_COMMENT;
  const properties = code || PYTHON_FILE.test(path);
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    if (comment.test(line) || IGNORE_MARK.test(line)) continue;
    for (const [target] of line.matchAll(FIXTURE_IMPORT)) names.add(target);
    if (MAY_NAME_JSON.test(line))
      for (const name of lineDataNames(line, properties)) names.add(name);
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
 * for it. A recorded name that is gone must be removed from the baseline, and a baseline file must
 * still be a tracked runtime file (moving a reader out of runtime scope does not remove it).
 */
export function checkRuntimeReaders(
  found: ReadonlyMap<string, readonly string[]>,
  baseline: Readonly<Record<string, readonly string[]>>,
  runtimeFiles: ReadonlySet<string>
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
    if (!runtimeFiles.has(path)) {
      violations.push({
        path,
        problem:
          "baseline entry is not a tracked runtime file: remove it if the file is gone; moving a reader out of runtime scope does not remove it",
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
