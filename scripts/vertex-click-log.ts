// UI click log reader (operator key). See scripts/click-log/query.ts and docs/vertex-rebuild/click-log.md.
import { runClickLogQuery } from "./click-log/query.ts";

process.exitCode = await runClickLogQuery({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: (request) => globalThis.fetch(request),
  now: () => new Date(),
  stderr: process.stderr,
  stdout: process.stdout,
});
