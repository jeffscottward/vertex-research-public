// The root scripts that start turbo run this first. pnpm-workspace.yaml sets
// verifyDepsBeforeRun: error, so a turbo task never installs on its own; this
// one serial install brings node_modules up to date after a lockfile-changing
// pull before any task starts (card vertex-manual-turbo-stale-deps-race).
import { installDependencies } from "./lib/dependencies.ts";

const { error, signal, status } = installDependencies();
if (error || signal || status !== 0) {
  const exitCode = typeof status === "number" && status > 0 ? status : 1;
  const cause = error?.message ?? signal;
  console.error(
    `[deps] dependency install failed (${exitCode})${cause ? `: ${cause}` : ""}; run pnpm install --frozen-lockfile`
  );
  process.exitCode = exitCode;
} else {
  process.exitCode = 0;
}
