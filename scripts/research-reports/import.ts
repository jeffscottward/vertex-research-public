// Imports the research dossiers of the old vertex-research workspace into Postgres (merge plan P1).
// Usage: DATABASE_URL=postgres://... bun run vertex:research-reports:import -- --data-root <dir> [--dry-run]
//   [--allow-remove]
// <dir> is the workspace `data/` folder. The loader verifies every revision token first; a mismatch
// stops the import before any write. --dry-run prints the counts without a database. Writes go
// through the Drizzle research reports repository in one transaction and are idempotent: stored
// revisions are never rewritten, so a rerun adds only new revisions; a stored revision that differs
// from the source stops the import. A report that left the catalog is deleted with its revisions
// only with --allow-remove; otherwise the import stops. Research only; no order path.
import {
  createNodeDatabase,
  createResearchReportsRepository,
  ResearchReportsInputError,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";

import {
  loadResearchCatalog,
  ResearchSourceError,
  type ResearchSourceFs,
  summarizeResearchImport,
} from "./load.ts";

export type ResearchImportIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type ResearchImportDependencies = Readonly<{
  fs?: ResearchSourceFs;
  openRepository?: (databaseUrl: string) => Readonly<{
    repository: ResearchReportsRepository;
    close: () => Promise<void>;
  }>;
}>;

const USAGE =
  "usage: bun run vertex:research-reports:import -- --data-root <workspace data dir> [--dry-run] [--allow-remove]";

const openNodeRepository = (databaseUrl: string) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    repository: createResearchReportsRepository(resource.db),
  };
};

/** Runs the importer and returns the exit code: 0 ok, 2 usage or source error, 1 other failure. */
export const runResearchReportsImport = async (
  argv: readonly string[],
  io: ResearchImportIo,
  dependencies: ResearchImportDependencies = {}
): Promise<number> => {
  const index = argv.indexOf("--data-root");
  const root = index >= 0 ? argv[index + 1] : undefined;
  const dryRun = argv.includes("--dry-run");
  const databaseUrl = io.env["DATABASE_URL"];
  if (root === undefined || root.startsWith("--")) {
    io.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!dryRun && (databaseUrl === undefined || databaseUrl === "")) {
    io.stderr.write(`DATABASE_URL is required (or pass --dry-run)\n${USAGE}\n`);
    return 2;
  }
  try {
    const input = await loadResearchCatalog(root, dependencies.fs);
    const source = summarizeResearchImport(input);
    if (dryRun || databaseUrl === undefined) {
      io.stdout.write(`${JSON.stringify({ dryRun: true, source }, null, 2)}\n`);
      return 0;
    }
    const opened = (dependencies.openRepository ?? openNodeRepository)(
      databaseUrl
    );
    const result = await opened.repository
      .replaceCatalog(input, { allowRemoval: argv.includes("--allow-remove") })
      .finally(() => opened.close());
    io.stdout.write(`${JSON.stringify({ result, source }, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (
      error instanceof ResearchSourceError ||
      error instanceof ResearchReportsInputError
    ) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `research report import failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
