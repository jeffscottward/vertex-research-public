import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import registry from "../../docs/vertex-rebuild/migration-matrix.json";
import {
  authorizedNames,
  ConfigurationError,
  inventory,
  parseAssignments,
  serialize,
  type Values,
} from "./core.ts";

// A registry addition/relocation is not credential-read authority. Intersect the
// registry with the exact already-reviewed local root bindings; no externalSources.
const reviewedRepositoryIds: readonly string[] = [
  "ibkr-vertex-ai-fund",
  "charan-discord-bot",
  "AI-Cornell-bots",
  "vertex-research",
  "vertex-quant-trail-capability",
  "trade-calculator",
  "optical-photonics-reports",
  "asts-stock-watcher",
  "ai-hedge-fund",
  "youtube-knowledge-bases",
  "TradingAgents",
  "worktrees",
  "vertex-quant",
  "gamma-forge",
  "full-port",
];
// Sibling source repositories live beside this checkout (its parent directory).
export const LOCAL_TRADING_ROOT = dirname(
  fileURLToPath(new URL("../../", import.meta.url))
);
export const boundInspectionRepositoryIds = (
  roots: readonly Readonly<{ id: string; sourcePath: string }>[],
  tradingRoot: string = LOCAL_TRADING_ROOT
): readonly string[] => {
  return Object.freeze(
    roots
      .filter(
        (entry) =>
          reviewedRepositoryIds.includes(entry.id) &&
          entry.sourcePath === join(tradingRoot, entry.id)
      )
      .map((entry) => entry.id)
  );
};

export const inspectionRepositoryIds: readonly string[] =
  boundInspectionRepositoryIds(registry.roots);
export type SourceSelection = Readonly<{
  repository: string;
  path: string;
  keys: readonly string[];
}>;
export type SelectionManifest = Readonly<{
  version: 1;
  sources: readonly SourceSelection[];
}>;
export type InspectionSource = Readonly<{
  repository: string;
  path: string;
  content: string | null;
}>;
export type InspectionInput = Readonly<{
  manifest: SelectionManifest;
  sources: readonly InspectionSource[];
  schema: string;
  existing: string | null;
}>;
export type InspectionOrigin = Readonly<{
  repository: string | null;
  path: string;
  kind: "source" | "master";
}>;
export type InspectionDisposition =
  | "eligible"
  | "ineligible"
  | "excluded"
  | "deferred";
export type InspectionObservation = Readonly<{
  origin: InspectionOrigin;
  disposition: InspectionDisposition;
  reason: string;
}>;
export type InspectionEntry = Readonly<{
  name: string;
  equality: "absent" | "unique" | "identical" | "conflicting";
  decision:
    | "retain-existing-master"
    | "eligible-candidate"
    | "unresolved"
    | "no-candidate";
  observations: readonly InspectionObservation[];
  groups: readonly Readonly<{
    id: string;
    origins: readonly InspectionOrigin[];
  }>[];
}>;
export type InspectionReport = Readonly<{
  version: 1;
  mode: "names-only-dry-run";
  validation: "not-performed";
  selectedNames: readonly string[];
  eligibleNames: readonly string[];
  ineligibleNames: readonly string[];
  conflictingNames: readonly string[];
  excludedNames: readonly string[];
  deferredNames: readonly string[];
  entries: readonly InspectionEntry[];
}>;

const objectWithKeys = (
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

export const parseSelectionManifest = (value: unknown): SelectionManifest => {
  if (
    !objectWithKeys(value, ["version", "sources"]) ||
    value["version"] !== 1 ||
    !Array.isArray(value["sources"]) ||
    value["sources"].length === 0 ||
    value["sources"].length > 64
  ) {
    throw new ConfigurationError("invalid-manifest");
  }
  const sources: SourceSelection[] = [];
  const seen = new Set<string>();
  for (const source of value["sources"]) {
    if (!objectWithKeys(source, ["repository", "path", "keys"])) {
      throw new ConfigurationError("invalid-manifest");
    }
    if (
      typeof source["repository"] !== "string" ||
      !inspectionRepositoryIds.includes(source["repository"])
    ) {
      throw new ConfigurationError("invalid-manifest-repository");
    }
    if (
      typeof source["path"] !== "string" ||
      source["path"].length > 512 ||
      !/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*\.env(?:\.local|\.schema|\.example)?$/.test(
        source["path"]
      )
    ) {
      throw new ConfigurationError("invalid-manifest-path");
    }
    if (
      !Array.isArray(source["keys"]) ||
      source["keys"].length === 0 ||
      source["keys"].length > 256 ||
      source["keys"].some(
        (key: unknown) =>
          typeof key !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)
      )
    ) {
      throw new ConfigurationError("invalid-manifest-keys");
    }
    const keys = source["keys"] as string[];
    const identity = `${source["repository"]}/${source["path"]}`;
    if (seen.has(identity) || new Set(keys).size !== keys.length) {
      throw new ConfigurationError("duplicate-manifest-selection");
    }
    seen.add(identity);
    sources.push({
      repository: source["repository"],
      path: source["path"],
      keys: [...keys],
    });
  }
  return { version: 1, sources };
};

const canonicalName = (name: string): string =>
  name === "FINANCIALDATASETS_API_KEY" ? "FINANCIAL_DATASETS_API_KEY" : name;
const excluded = new Set([
  "QUANTVPS_SSH_PASSWORD",
  "IBKR_TRADING_MODE",
  "IBKR_READ_ONLY",
  "NAUTILUS_TRADING_MODE",
]);

const classify = (
  name: string,
  value: string,
  path: string,
  schema: ReadonlySet<string>
): Readonly<{ disposition: InspectionDisposition; reason: string }> => {
  if (excluded.has(name))
    return { disposition: "excluded", reason: "excluded-name" };
  if (!authorizedNames.includes(name))
    return { disposition: "deferred", reason: "unsupported-name" };
  if (!schema.has(name))
    return { disposition: "deferred", reason: "schema-gap" };
  if (!value.trim()) return { disposition: "ineligible", reason: "empty" };
  if (value.trim().startsWith("op://"))
    return { disposition: "excluded", reason: "unresolved-reference" };
  if (!/(?:^|\/)\.env(?:\.local)?$/.test(path))
    return { disposition: "ineligible", reason: "template" };
  if (
    /^(?:your[_ -]|replace[_ -]|changeme|change-me|example|placeholder|dummy|test[_ -]|<|\$\{)/i.test(
      value.trim()
    )
  ) {
    return { disposition: "ineligible", reason: "placeholder" };
  }
  if (name === "DATABASE_URL") {
    try {
      const url = new URL(value);
      if (
        !(
          ["postgres:", "postgresql:"].includes(url.protocol) &&
          url.hostname.endsWith(".pg.psdb.cloud")
        )
      ) {
        return { disposition: "ineligible", reason: "ineligible-database" };
      }
    } catch {
      return { disposition: "ineligible", reason: "ineligible-database" };
    }
  }
  return { disposition: "eligible", reason: "local-candidate" };
};

// Values remain internal to planning. Only inspectSelection's names-only report
// crosses the read-only CLI boundary; the reviewed writer consumes a separate plan.
// Selection maps are keyed by every selected name before any add or lookup.
const selectedEntry = <T>(map: ReadonlyMap<string, T>, name: string): T => {
  const entry = map.get(name);
  if (entry === undefined)
    throw new ConfigurationError("invalid-inspection-sources");
  return entry;
};

const planSelection = (input: InspectionInput) => {
  const manifest = parseSelectionManifest(input.manifest);
  const schema = new Set(
    parseAssignments(input.schema).map((entry) => entry.name)
  );
  const master = inventory(input.schema, [], input.existing);
  if (master.blocked) throw new ConfigurationError("invalid-master");
  if (input.sources.length !== manifest.sources.length) {
    throw new ConfigurationError("invalid-inspection-sources");
  }
  const selectedNames = [
    ...new Set(
      manifest.sources.flatMap((source) => source.keys.map(canonicalName))
    ),
  ].sort();
  const observations = new Map<string, InspectionObservation[]>(
    selectedNames.map((name) => [name, []])
  );
  const candidates = new Map<string, Map<string, InspectionOrigin[]>>(
    selectedNames.map((name) => [name, new Map<string, InspectionOrigin[]>()])
  );
  const add = (
    name: string,
    value: string | null,
    origin: InspectionOrigin,
    missingReason: string
  ): void => {
    const classification = classify(name, value ?? "", origin.path, schema);
    const result =
      value === null &&
      !["deferred", "excluded"].includes(classification.disposition)
        ? { disposition: "ineligible" as const, reason: missingReason }
        : classification;
    selectedEntry(observations, name).push({ origin, ...result });
    if (value !== null && result.disposition === "eligible") {
      const values = selectedEntry(candidates, name);
      const origins = values.get(value) ?? [];
      origins.push(origin);
      values.set(value, origins);
    }
  };
  for (const [index, selection] of manifest.sources.entries()) {
    const source = input.sources[index];
    if (
      source === undefined ||
      source.repository !== selection.repository ||
      source.path !== selection.path
    ) {
      throw new ConfigurationError("invalid-inspection-sources");
    }
    const origin: InspectionOrigin = {
      repository: selection.repository,
      path: selection.path,
      kind: "source",
    };
    const assignments =
      source.content === null ? [] : parseAssignments(source.content);
    for (const key of selection.keys) {
      const matching = assignments.filter((entry) => entry.name === key);
      const name = canonicalName(key);
      if (matching.length === 0) {
        add(
          name,
          null,
          origin,
          source.content === null ? "missing-file" : "missing-key"
        );
      }
      for (const entry of matching) {
        add(name, entry.value, origin, "missing-key");
      }
    }
  }
  const entries: InspectionEntry[] = [];
  for (const name of selectedNames) {
    const existing = master.selected[name];
    if (existing !== undefined) {
      add(
        name,
        existing,
        {
          repository: null,
          path: "private/configuration/.env",
          kind: "master",
        },
        "missing-key"
      );
    }
    const values = selectedEntry(candidates, name);
    // Insertion-ordered Map grouping is linear even for duplicate-heavy files.
    const groups = [...values.values()].map((origins, index) => ({
      id: `g${index + 1}`,
      origins,
    }));
    const equality =
      values.size === 0
        ? "absent"
        : values.size > 1
          ? "conflicting"
          : (groups[0]?.origins.length ?? 0) > 1
            ? "identical"
            : "unique";
    const decision =
      existing === undefined
        ? values.size > 1
          ? "unresolved"
          : values.size === 1
            ? "eligible-candidate"
            : "no-candidate"
        : "retain-existing-master";
    entries.push({
      name,
      equality,
      decision,
      observations: selectedEntry(observations, name),
      groups,
    });
  }
  const namesWith = (disposition: InspectionDisposition): string[] =>
    entries
      .filter((entry) =>
        entry.observations.some(
          (observation) => observation.disposition === disposition
        )
      )
      .map((entry) => entry.name);
  const report: InspectionReport = {
    version: 1,
    mode: "names-only-dry-run",
    validation: "not-performed",
    selectedNames,
    eligibleNames: namesWith("eligible"),
    ineligibleNames: namesWith("ineligible"),
    conflictingNames: entries
      .filter((entry) => entry.equality === "conflicting")
      .map((entry) => entry.name),
    excludedNames: namesWith("excluded"),
    deferredNames: namesWith("deferred"),
    entries,
  };
  return { report, candidates };
};

export const inspectSelection = (input: InspectionInput): InspectionReport =>
  planSelection(input).report;

export type ReviewedSelectionPlan = Readonly<{
  report: InspectionReport;
  content: string | null;
  addedNames: readonly string[];
  retainedNames: readonly string[];
  conflictingNames: readonly string[];
}>;

// Existing legacy masters may use core.inventory's two established IB aliases.
// Recognize them only for collision protection, never as new selected-source names.
const masterCanonicalName = (name: string): string =>
  name === "IB_GATEWAY_HOST"
    ? "IBKR_HOST"
    : name === "IB_GATEWAY_PORT"
      ? "IBKR_PORT"
      : canonicalName(name);

// Do not feed arbitrary existing settings through legacy inventory/serialize:
// those deliberately accept a smaller master vocabulary. Preserve all unselected
// statements byte-for-byte and compare selected names even when existing values
// are placeholders or references. A nonempty target is never replacement authority.
export const planReviewedSelection = (
  input: InspectionInput
): ReviewedSelectionPlan => {
  const { report, candidates } = planSelection({ ...input, existing: null });
  let assignments: ReturnType<typeof parseAssignments>;
  try {
    assignments = parseAssignments(input.existing ?? "");
  } catch {
    throw new ConfigurationError("invalid-master");
  }
  const existing = new Map<string, string[]>();
  for (const entry of assignments) {
    const name = masterCanonicalName(entry.name);
    const values = existing.get(name) ?? [];
    values.push(entry.value);
    existing.set(name, values);
  }
  const additions: Record<string, string> = Object.create(null);
  const retainedNames: string[] = [];
  const conflicting = new Set(report.conflictingNames);
  for (const entry of report.entries) {
    if (entry.decision !== "eligible-candidate") continue;
    // An eligible candidate has exactly one distinct value.
    const [value] = selectedEntry(candidates, entry.name).keys();
    const previous = existing.get(entry.name) ?? [];
    const nonempty = previous.filter((item) => item.trim() !== "");
    if (new Set(previous).size > 1 || nonempty.some((item) => item !== value)) {
      conflicting.add(entry.name);
    } else if (nonempty.length > 0) {
      // An old alias is not a canonical master entry and cannot silently shadow it.
      if (
        assignments.some(
          (item) =>
            item.name !== entry.name &&
            masterCanonicalName(item.name) === entry.name
        )
      ) {
        conflicting.add(entry.name);
      } else {
        retainedNames.push(entry.name);
      }
    } else if (value !== undefined) {
      additions[entry.name] = value;
    }
  }
  const conflictingNames = [...conflicting].sort();
  const addedNames = Object.keys(additions).sort();
  if (conflictingNames.length > 0 || addedNames.length === 0) {
    return {
      report,
      content: input.existing,
      addedNames: [],
      retainedNames,
      conflictingNames,
    };
  }
  // The full parser above validated the grammar. This sticky scanner locates
  // complete statements (including quoted newlines), not regex hits inside values.
  const text = input.existing ?? "";
  let position = text.startsWith("\uFEFF") ? 1 : 0;
  let preserved = text.slice(0, position);
  const statement =
    /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|`[^`]*`|[^#\r\n]*)(?:[ \t]*#[^\r\n]*)?[ \t]*(?:\r?\n|$)/y;
  const blank = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
  while (position < text.length) {
    blank.lastIndex = position;
    const skipped = blank.exec(text);
    if (skipped && skipped[0].length > 0) {
      preserved += skipped[0];
      position = blank.lastIndex;
      continue;
    }
    statement.lastIndex = position;
    const matched = statement.exec(text);
    if (!matched || matched[0].length === 0)
      throw new ConfigurationError("invalid-master");
    if (!Object.hasOwn(additions, masterCanonicalName(String(matched[1]))))
      preserved += matched[0];
    position = statement.lastIndex;
  }
  const content =
    preserved +
    (preserved.length > 0 && !preserved.endsWith("\n") ? "\n" : "") +
    serialize(additions as Values);
  // Output is bounded too, and a parser round-trip catches unsupported encodings.
  parseAssignments(content);
  return { report, content, addedNames, retainedNames, conflictingNames };
};
