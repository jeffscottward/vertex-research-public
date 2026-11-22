// Template identity that `bun run init` leaves in the tracked files of a new project.
// Two tests share this module: leftovers.test.ts plans the init in memory on every push
// (a few seconds), and init.acceptance.test.ts runs the real init in a clone (CI only).
import { type InitPlan, isBinary, type TrackedFile } from "./plan.ts";

const TEMPLATE_IDENTITY = /darkfactory|jeffscott/giu;

// Tracked text that may keep a template-identity match after init, with the
// reason. Upstream keeps it empty: every entry is identity leaking into a new
// project. Vertex exception: these recorded provenance/evidence files keep the
// original author's absolute source paths (/home|/Users/jeffscottward/...).
// They are records of where the reviewed sources came from; rewriting them
// would falsify the records and break the hashes that pin them, so init leaves
// them untouched.
export const ALLOWED_LEFTOVERS: readonly string[] = [
  "docs/vertex-rebuild/deliverables.json: 23",
  "docs/vertex-rebuild/implementation-plan.md: 1",
  "docs/vertex-rebuild/migration-matrix.json: 15",
  "docs/vertex-rebuild/provenance-baseline.json: 2",
  // Copy of the unit deployed on QuantVPS (17736a8); its absolute paths are the live ones.
  "infra/quantvps/vertex-web.service: 3",
  "services/control-client/authoring-handoff.private.v1.json: 1",
  "services/execution-kernel/private/source-provenance-v1.json: 5",
  "services/execution/private/source-handoff-v1.json: 1",
  "services/host/HostBuild-v1.private.json: 1",
  "services/research/provenance/numeric-backend.json: 1",
];

/** The tracked files as they are after `plan` is applied: edits, then renames and deletions. */
export const applyPlan = (
  files: readonly TrackedFile[],
  plan: InitPlan
): readonly TrackedFile[] => {
  const encoder = new TextEncoder();
  const edited = new Map(
    plan.edits.map((edit) => [edit.path, encoder.encode(edit.content)])
  );
  const renamed = new Map(
    plan.renames.map((rename) => [rename.from, rename.to])
  );
  const deleted = new Set(plan.deletions);
  return files
    .filter((file) => !deleted.has(file.path))
    .map((file) => ({
      bytes: edited.get(file.path) ?? file.bytes,
      path: renamed.get(file.path) ?? file.path,
    }));
};

/**
 * Template-identity matches in `files`: `<path> (path)` for a path that names the
 * template, and `<path>: <count>` for text content. Binary content is not searched.
 */
export const identityLeftovers = (
  files: readonly TrackedFile[]
): readonly string[] => {
  const decoder = new TextDecoder();
  const count = (text: string): number =>
    [...text.matchAll(TEMPLATE_IDENTITY)].length;
  return files.flatMap(({ path, bytes }) => {
    const matches = isBinary(bytes) ? 0 : count(decoder.decode(bytes));
    return [
      ...(count(path) > 0 ? [`${path} (path)`] : []),
      ...(matches > 0 ? [`${path}: ${matches}`] : []),
    ];
  });
};

/** The leftovers that `allowed` does not list. Each one fails the init tests. */
export const unexpectedLeftovers = (
  files: readonly TrackedFile[],
  allowed: readonly string[] = ALLOWED_LEFTOVERS
): readonly string[] =>
  identityLeftovers(files).filter((entry) => !allowed.includes(entry));
