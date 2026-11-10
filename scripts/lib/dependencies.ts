import { spawnSync } from "node:child_process";
import { withoutGitRepositoryEnvironment } from "./git-env.ts";

// The lockfile stays as committed. --prefer-offline uses the store first but
// still fetches packages it lacks. A copied node_modules from another pnpm
// layout needs a purge, and hooks have no terminal to confirm it.
export const DEPENDENCY_INSTALL: readonly string[] = Object.freeze([
  "install",
  "--frozen-lockfile",
  "--prefer-offline",
  "--config.confirm-modules-purge=false",
]);

/**
 * Runs one serial `pnpm install` with the committed lockfile. pnpm's own
 * up-to-date check makes it a ~0.6 s no-op when node_modules is current.
 * Git's hook repository variables would point pnpm's lifecycle scripts
 * (husky) at the wrong repository, so they are dropped.
 */
export const installDependencies = (env: NodeJS.ProcessEnv = process.env) =>
  spawnSync("pnpm", DEPENDENCY_INSTALL, {
    env: withoutGitRepositoryEnvironment(env),
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
  });
