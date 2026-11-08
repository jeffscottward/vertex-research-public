import { execFileSync } from "node:child_process";
import type { TestEnvironmentDependencies } from "./test-env.ts";

// Same rule as apps/web/vite.config.ts: a 7-40 char lowercase hex commit.
const BUILD_SHA_PATTERN = /^[0-9a-f]{7,40}$/u;

export type BuildShaDependencies = Readonly<{
  env: NodeJS.ProcessEnv;
  /** `git rev-parse HEAD`, or undefined when git is unavailable. */
  readHead: () => string | undefined;
  spawn: TestEnvironmentDependencies["spawn"];
  error: (line: string) => void;
}>;

/**
 * `env` with VERTEX_BUILD_SHA set to the commit being built. turbo.json keys
 * the web build cache on VERTEX_BUILD_SHA, so a new commit never replays a
 * cached bundle that embeds the previous commit (card vertex-build-sha-turbo-cache).
 * A valid caller-supplied value wins; otherwise git HEAD; otherwise unchanged
 * (Vite then falls back to "unknown").
 */
export const buildShaEnvironment = (
  env: NodeJS.ProcessEnv,
  readHead: BuildShaDependencies["readHead"]
): NodeJS.ProcessEnv => {
  const given = env["VERTEX_BUILD_SHA"];
  if (given !== undefined && BUILD_SHA_PATTERN.test(given)) return env;
  const head = readHead()?.trim();
  return head !== undefined && BUILD_SHA_PATTERN.test(head)
    ? { ...env, VERTEX_BUILD_SHA: head }
    : env;
};

/** `bun scripts/with-build-sha.ts <command> [arguments...]` */
export const runWithBuildSha = async (
  arguments_: readonly string[],
  dependencies: BuildShaDependencies
): Promise<number> => {
  const [command, ...rest] = arguments_;
  if (command === undefined) {
    dependencies.error(
      "Usage: bun scripts/with-build-sha.ts <command> [arguments...]"
    );
    return 2;
  }
  return await dependencies.spawn(
    command,
    rest,
    buildShaEnvironment(dependencies.env, dependencies.readHead)
  );
};

export const readGitHead = (): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};
