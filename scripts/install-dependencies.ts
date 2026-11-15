// The root scripts that start turbo, and the verify:core and verify:coverage
// lanes, run this first. pnpm-workspace.yaml sets verifyDepsBeforeRun: error,
// so a turbo task never installs on its own; this one serial install brings
// node_modules up to date after a lockfile-changing pull before any task
// starts (card vertex-manual-turbo-stale-deps-race). A composite script may
// run it more than once; when node_modules is current it is a ~0.6 s no-op.
import { runDependencyInstall } from "./lib/dependencies.ts";

process.exitCode = runDependencyInstall();
