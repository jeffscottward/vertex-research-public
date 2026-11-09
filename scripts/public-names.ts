// Public tailnet-names gate entry point; CI's "Changes" job runs it on every PR. See scripts/ci/public-names.ts.
import { fileURLToPath } from "node:url";
import { runPublicNamesCli } from "./ci/public-names.ts";

process.exitCode = await runPublicNamesCli(process.argv.slice(2), {
  root: fileURLToPath(new URL("..", import.meta.url)),
  stderr: process.stderr,
  stdout: process.stdout,
});
