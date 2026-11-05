// Pick-list importer (research only, no orders). See scripts/pick-lists/import.ts.
import { readFile } from "node:fs/promises";

import {
  newYorkDate,
  parseTomlWithBun,
  runPickListImport,
} from "./pick-lists/import.ts";

process.exitCode = await runPickListImport({
  argv: process.argv.slice(2),
  env: process.env,
  post: (url, init) => globalThis.fetch(url, init),
  readText: (path) => readFile(path, "utf8"),
  parseToml: (text) => parseTomlWithBun(text),
  today: () => newYorkDate(new Date()),
  stderr: process.stderr,
  stdout: process.stdout,
});
