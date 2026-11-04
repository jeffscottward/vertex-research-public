// Research dossier importer (merge plan P1). See scripts/research-reports/import.ts.
import { runResearchReportsImport } from "./research-reports/import.ts";

process.exitCode = await runResearchReportsImport(process.argv.slice(2), {
  env: process.env,
  stderr: process.stderr,
  stdout: process.stdout,
});
