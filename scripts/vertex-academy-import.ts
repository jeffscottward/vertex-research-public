// Academy database-course importer (authored specs and sources → Postgres). See
// scripts/academy/import-lessons.ts.
import { homedir } from "node:os";

import { runAcademyImport } from "./academy/import-lessons.ts";

process.exitCode = await runAcademyImport(
  process.argv.slice(2),
  { env: process.env, stderr: process.stderr, stdout: process.stdout },
  { home: homedir() }
);
