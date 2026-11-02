// Paper agent desk entry point (paper only, no orders). See scripts/agent-desk/cli.ts for usage.
import { fileURLToPath } from "node:url";
import { runAgentDeskCli } from "./agent-desk/cli.ts";

process.exitCode = await runAgentDeskCli(process.argv.slice(2), {
  now: new Date(),
  root: fileURLToPath(new URL("..", import.meta.url)),
  stderr: process.stderr,
  stdout: process.stdout,
});
