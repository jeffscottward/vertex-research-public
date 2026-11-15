// Research study importer (stdin → research_studies). See scripts/research-studies/import.ts.
import { runResearchStudiesImport } from "./research-studies/import.ts";

process.exitCode = await runResearchStudiesImport(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stderr: process.stderr,
  stdout: process.stdout,
});
