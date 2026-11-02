// QuantJourney strategy library research generator (research only). See scripts/research/quantjourney.ts.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runQuantJourneyCli } from "./research/quantjourney.ts";

process.exitCode = await runQuantJourneyCli(process.argv.slice(2), {
  now: () => new Date(),
  root: fileURLToPath(new URL("..", import.meta.url)),
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
  stderr: process.stderr,
  stdout: process.stdout,
});
