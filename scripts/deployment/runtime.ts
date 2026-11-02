import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebDeploymentDependencies } from "./cli.ts";
import {
  assertAmbientInputs,
  inputFailure,
  sha256,
} from "./approved-inputs.ts";
import { runApprovedRevisionDeployment } from "./runner.ts";
import { createDockerRunnerPorts } from "./runner-runtime.ts";

export const readPrivateDestinationReceipt = async (
  path: string,
  root: string,
  isIgnored: (path: string) => Promise<boolean>
): Promise<string> => {
  const resolved = resolve(root, path);
  const privateRoot = resolve(root, "private/deployment");
  const child = relative(privateRoot, resolved);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    (await realpath(resolved)) !== resolved ||
    !(await isIgnored(resolved))
  ) {
    throw new Error(
      "Destination evidence must be an ignored, non-symlinked private deployment file"
    );
  }
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 65_536
    ) {
      throw new Error(
        "Destination evidence must be a bounded regular file with mode 0600"
      );
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (result.bytesRead === 0)
        throw new Error("Destination evidence changed during reading");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(resolved);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1 ||
      named.ino !== stat.ino ||
      named.dev !== stat.dev ||
      (await realpath(resolved)) !== resolved
    ) {
      throw new Error("Destination evidence changed during reading");
    }
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
};

// The installed official adapter loads all four production dotenv locations
// before Vite loads CLOUDFLARE_* again. Do not parse secrets or try to duplicate
// two different expansion algorithms: app-local implicit inputs are unsupported.
const assertAdapterInputs = async (root: string): Promise<void> => {
  const app = resolve(root, "apps/web");
  if ((await realpath(app)) !== app) {
    throw new Error(
      "The adapter application root must not use workspace symlinks"
    );
  }
  for (const path of [
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
    ".dev.vars",
    ".dev.vars.production",
    ".dev.vars.staging",
    "wrangler.json",
    "wrangler.toml",
    "cloudflare.config.ts",
    ".wrangler/deploy/config.json",
  ]) {
    try {
      await lstat(resolve(app, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "App-local dotenv and alternate adapter configuration inputs are unsupported"
    );
  }
  const config = resolve(app, "wrangler.jsonc");
  if ((await realpath(config)) !== config || !(await lstat(config)).isFile()) {
    throw new Error(
      "The reviewed Wrangler configuration must be a regular, non-symlinked file"
    );
  }
};

export const createWebDeploymentDependencies = (
  root = fileURLToPath(new URL("../../", import.meta.url))
): WebDeploymentDependencies => {
  const source = Object.freeze({ ...process.env });
  const git = (args: readonly string[]) => {
    assertAmbientInputs(source);
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 4_194_304,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  };
  const configurationAt = (headSha: string): string => {
    if (!/^[a-f0-9]{40}$/.test(headSha)) {
      throw new Error("Configuration reads require an exact commit SHA");
    }
    return git(["show", `${headSha}:apps/web/wrangler.jsonc`]);
  };
  const ignored = (resolved: string): boolean => {
    try {
      git(["check-ignore", "--quiet", "--", resolved]);
      return true;
    } catch {
      return false;
    }
  };
  return {
    source,
    // Async wrappers turn synchronous Git failures into rejections.
    readConfiguration: async (headSha) => configurationAt(headSha),
    readReceipt: (path) =>
      readPrivateDestinationReceipt(path, root, async (resolved) =>
        ignored(resolved)
      ),
    currentHead: async () => git(["rev-parse", "--verify", "HEAD"]).trim(),
    cleanTree: async () =>
      git(["status", "--porcelain", "--untracked-files=normal"]).trim() === "",
    assertAdapterInputs: () => assertAdapterInputs(root),
    deploy: async (request) => {
      const ports = createDockerRunnerPorts(root, source, async (admitted) => {
        await assertAdapterInputs(root);
        if (
          git(["status", "--porcelain", "--untracked-files=normal"]).trim() !==
            "" ||
          git(["rev-parse", "--verify", "HEAD"]).trim() !== admitted.exactSha ||
          sha256(
            git(["show", `${admitted.exactSha}:apps/web/wrangler.jsonc`])
          ) !== admitted.configurationSha256
        ) {
          return inputFailure("admission-drift");
        }
        return;
      });
      const result = await runApprovedRevisionDeployment(
        request,
        source,
        ports
      );
      const output = result.exitCode === 0 ? process.stdout : process.stderr;
      output.write(`deployment runner: ${JSON.stringify(result)}\n`);
      return result.exitCode;
    },
    output: process.stdout,
    errorOutput: process.stderr,
  };
};
