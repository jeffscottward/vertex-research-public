import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigurationError,
  inventory,
  localDefaults,
  parseAssignments,
  project,
  serialize,
} from "./core.ts";
import {
  assertIgnored,
  atomicPrivateWrite,
  collectInspection,
  ensurePrivateDirectory,
  readCanonicalSources,
  readRegular,
  writeProjection,
} from "./files.ts";
import { inspectSelection } from "./inspection.ts";
import { applyReviewed } from "./reviewed-apply.ts";

export const consolidate = (root: string): void => {
  for (const path of [
    ".env",
    "private/configuration/.env",
    "private/configuration/inventory.json",
  ]) {
    assertIgnored(root, path);
  }
  const schema = readRegular(join(root, ".env.example"));
  if (schema === null) throw new ConfigurationError("missing-schema");
  const defaults = localDefaults();
  const schemaNames = new Set(
    parseAssignments(schema).map((entry) => entry.name)
  );
  if (Object.keys(defaults).some((name) => !schemaNames.has(name))) {
    throw new ConfigurationError("local-schema-gap");
  }
  const directory = ensurePrivateDirectory(root);
  const masterPath = join(directory, ".env");
  const reportPath = join(directory, "inventory.json");
  const rootPath = join(root, ".env");
  const existing = readRegular(masterPath, true);
  const previousReport = readRegular(reportPath, true);
  const previousRoot = readRegular(rootPath, true);
  const local = serialize(defaults);
  if (previousRoot !== null && previousRoot !== local) {
    throw new ConfigurationError("existing-local-configuration-differs");
  }
  const sources = readCanonicalSources(root);
  const result = inventory(schema, sources.sources, existing);
  const report = `${JSON.stringify({ ...result.report, missingSources: sources.missing, blocked: result.blocked }, null, 2)}\n`;
  if (result.blocked) {
    atomicPrivateWrite(reportPath, report, previousReport);
    throw new ConfigurationError("consolidation-blocked");
  }
  // Serialize everything before writing: unrepresentable values cannot produce a partial bundle.
  const master = serialize(result.selected);
  if (previousRoot === null) atomicPrivateWrite(rootPath, local, null);
  if (existing !== master) atomicPrivateWrite(masterPath, master, existing);
  if (previousReport !== report)
    atomicPrivateWrite(reportPath, report, previousReport);
};

// Trusted root injection is for in-process callers and synthetic tests only.
// The production entrypoint (runVertexConfigCli) binds reviewed reads/writes to the approved checkout.
export const run = (
  args: readonly string[],
  root: string,
  output: { write: (text: string) => unknown }
): number => {
  try {
    if (args.includes("--apply-reviewed") && args.includes("--dry-run")) {
      throw new ConfigurationError(
        "usage: --apply-reviewed and --dry-run are exclusive modes"
      );
    }
    const [command, mode, manifestFlag, manifest] = args;
    if (
      args.length === 4 &&
      command === "consolidate" &&
      mode === "--dry-run" &&
      manifestFlag === "--manifest" &&
      manifest !== undefined
    ) {
      output.write(
        `${JSON.stringify(inspectSelection(collectInspection(root, manifest)), null, 2)}\n`
      );
      return 0;
    }
    if (
      args.length === 4 &&
      command === "consolidate" &&
      mode === "--apply-reviewed" &&
      manifestFlag === "--manifest" &&
      manifest !== undefined &&
      !manifest.startsWith("--")
    ) {
      const result = applyReviewed(root, manifest);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === "applied-to-master" ||
        result.status === "unchanged"
        ? 0
        : 1;
    }
    if (args.length === 1 && args[0] === "consolidate") {
      consolidate(root);
      output.write(
        "private/configuration/inventory.json: local credential-presence inventory; provider validation not performed.\n"
      );
      return 0;
    }
    const [, , environment, serviceFlag, service, keysFlag, keys] = args;
    if (
      args.length === 7 &&
      command === "project" &&
      mode === "--environment" &&
      serviceFlag === "--service" &&
      keysFlag === "--keys" &&
      environment !== undefined &&
      service !== undefined &&
      keys !== undefined
    ) {
      const names = keys.split(",").filter(Boolean);
      const schema = readRegular(join(root, ".env.example"));
      const bundle = readRegular(
        join(root, "private/configuration/.env"),
        true
      );
      if (schema === null || bundle === null)
        throw new ConfigurationError("missing-configuration");
      const result = inventory(schema, [], bundle);
      if (result.blocked) throw new ConfigurationError("invalid-master");
      // Validate before deriving a filename or creating any output directory.
      const selection = { environment, service, names };
      project(result.selected, selection);
      const relativePath = `private/configuration/projections/${environment}-${service}.env`;
      assertIgnored(root, relativePath);
      const directory = join(ensurePrivateDirectory(root), "projections");
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST")
          throw new ConfigurationError("directory-failed");
      }
      writeProjection(join(root, relativePath), result.selected, selection);
      output.write(
        `${relativePath}: explicit disabled-runtime projection; not injected or executed.\n`
      );
      return 0;
    }
    throw new ConfigurationError(
      "usage: consolidate [--dry-run|--apply-reviewed --manifest PATH] | project --environment development|test --service browser|research|market-data|agno|jev --keys NAME[,NAME]"
    );
  } catch (error) {
    output.write(
      `vertex-config: ${error instanceof ConfigurationError ? error.message : "operation-failed"}\n`
    );
    return 1;
  }
};

export type ConfigurationEntrypointDependencies = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  moduleUrl: string;
  output: { write: (text: string) => unknown };
  exitState: { exitCode?: number | string | null | undefined };
  /** VERTEX_APPROVED_CHECKOUT: reviewed absolute checkout path; absent denies reviewed modes. */
  approvedCheckout?: string | undefined;
}>;

export const runConfigurationEntrypoint = (
  dependencies: ConfigurationEntrypointDependencies
): void => {
  if (!dependencies.isMain) return;
  const args = dependencies.argv.slice(2);
  const root = fileURLToPath(new URL("../../", dependencies.moduleUrl));
  if (
    args[0] === "consolidate" &&
    (args.includes("--dry-run") || args.includes("--apply-reviewed")) &&
    (dependencies.approvedCheckout === undefined ||
      dependencies.approvedCheckout === "" ||
      resolve(root) !== resolve(dependencies.approvedCheckout))
  ) {
    dependencies.output.write(
      "vertex-config: unapproved-inspection-location\n"
    );
    dependencies.exitState.exitCode = 1;
    return;
  }
  dependencies.exitState.exitCode = run(args, root, dependencies.output);
};

// The root scripts/vertex-config.ts entry binds this module's own location, so
// reviewed reads/writes stay pinned to the approved checkout.
export const runVertexConfigCli = (
  argv: readonly string[],
  output: { write: (text: string) => unknown },
  environment: Readonly<Record<string, string | undefined>> = process.env
): number => {
  const exitState: { exitCode?: number | string | null | undefined } = {};
  runConfigurationEntrypoint({
    isMain: true,
    argv,
    moduleUrl: import.meta.url,
    output,
    exitState,
    approvedCheckout: environment["VERTEX_APPROVED_CHECKOUT"],
  });
  return Number(exitState.exitCode);
};
