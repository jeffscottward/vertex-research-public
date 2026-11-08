// Play upsert (stdin → plays). See scripts/plays/upsert.ts.
import { runPlaysUpsert } from "./plays/upsert.ts";

process.exitCode = await runPlaysUpsert(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdinIsTTY: process.stdin.isTTY,
  stderr: process.stderr,
  stdout: process.stdout,
});
