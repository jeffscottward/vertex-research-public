import { runWebDeploymentCli } from "./deployment/cli.ts";
import { createWebDeploymentDependencies } from "./deployment/runtime.ts";

process.exitCode = await runWebDeploymentCli(
  process.argv.slice(2),
  createWebDeploymentDependencies()
);
