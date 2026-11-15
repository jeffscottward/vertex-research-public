// Core 7 re-run of the QuantJourney strategy library (research only). See scripts/research/core7-rerun.ts.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runCore7RerunCli } from "./research/core7-rerun.ts";
import { nautilusProcessIo } from "./research/nautilus-process-io.ts";

process.exitCode = await runCore7RerunCli(process.argv.slice(2), {
  defaultPython: process.env["VERTEX_NAUTILUS_PYTHON"],
  nautilus: nautilusProcessIo("core7-nautilus-"),
  now: () => new Date(),
  root: fileURLToPath(new URL("..", import.meta.url)),
  sha256: (text) => createHash("sha256").update(text).digest("hex"),
  stderr: process.stderr,
  stdout: process.stdout,
});
