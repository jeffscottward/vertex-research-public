import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The runtime stage for vertex-web on QuantVPS. The script runs against a temporary git worktree
// and a local "checkout" directory: the fake remote runner executes every remote command on this
// machine, except the program check, so no test reaches QuantVPS.
const script = fileURLToPath(new URL("./stage-runtime.sh", import.meta.url));

// Fake remote runner: logs the ": <name>;" marker of each call. `smoke` answers from
// <dir>/smoke (a <dir>/smoke.fail file makes it fail); every other command runs for real.
const FAKE = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$FAKE_DIR/calls"
bash -n -c "$cmd" 2>>"$FAKE_DIR/syntax" || { echo "$name" >>"$FAKE_DIR/syntax"; exit 97; }
if [ "$name" = smoke ]; then
  cat "$FAKE_DIR/smoke"
  [ -f "$FAKE_DIR/smoke.fail" ] && exit 1
  exit 0
fi
exec bash -c "$cmd"
`;
const HERMETIC_GIT = {
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0

  apps/web:
    dependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0

  'packages/ui':
    dependencies: {}

  packages/not-installed:
    dependencies: {}

packages:

  a@1.0.0:
    resolution: {integrity: sha512-x}
`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = "";
});

const setup = () => {
  dir = mkdtempSync(join(tmpdir(), "vertex-stage-"));
  const repo = join(dir, "repo");
  const checkout = join(dir, "checkout");
  const put = (root: string, path: string, body: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...HERMETIC_GIT },
    }).stdout.trim();
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  put(repo, ".gitignore", "node_modules\ndist\n");
  put(repo, "package.json", "{}");
  put(repo, "pnpm-lock.yaml", LOCKFILE);
  put(repo, "tsconfig.json", "{}");
  put(repo, "apps/web/package.json", '{"name":"web"}');
  put(repo, "apps/web/vite.config.ts", "export default {};");
  put(repo, "apps/web/src/proxy.ts", "export {};");
  put(repo, "apps/operator/package.json", "{}");
  put(repo, "packages/ui/package.json", "{}");
  put(repo, "infra/quantvps/run-preview.mjs", "// runner");
  put(repo, "my notes.md", "a name with a space");
  put(repo, "café.md", "a name that git would quote");
  git("add", "-A");
  git("commit", "-q", "-m", "build");
  const sha = git("rev-parse", "HEAD");
  // Installed packages and other untracked files of a build worktree.
  put(repo, "node_modules/.modules.yaml", "layoutVersion: 5\n");
  put(repo, "node_modules/.pnpm/a@1.0.0/node_modules/a/index.js", "a");
  mkdirSync(join(repo, "apps/web/node_modules"));
  symlinkSync(
    "../../../node_modules/.pnpm/a@1.0.0/node_modules/a",
    join(repo, "apps/web/node_modules/a")
  );
  put(repo, "packages/ui/node_modules/.keep", "");
  put(repo, "apps/web/dist/server/wrangler.json", "build output");
  put(repo, "notes.txt", "untracked");
  // The live checkout: an older runtime tree and server-side state.
  put(checkout, "apps/web/package.json", '{"name":"old"}');
  put(checkout, "apps/web/dist/server/wrangler.json", "live build");
  put(checkout, "RUNTIME_SHA", "0ld0000\n");
  put(checkout, ".runtime-next/RUNTIME_SHA", "stale\n");
  put(checkout, ".runtime-next/stale-file", "from an earlier stage");
  // The same package file as in the worktree (same bytes and time): it must become a hard link.
  const packageFile = ".pnpm/a@1.0.0/node_modules/a/index.js";
  put(checkout, `node_modules/${packageFile}`, "a");
  const when = new Date("2026-10-21T20:44:17Z");
  utimesSync(join(repo, "node_modules", packageFile), when, when);
  utimesSync(join(checkout, "node_modules", packageFile), when, when);
  writeFileSync(join(dir, "fake.sh"), FAKE);
  chmodSync(join(dir, "fake.sh"), 0o755);
  writeFileSync(
    join(dir, "pnpm.sh"),
    '#!/usr/bin/env bash\necho "$*" >>"$FAKE_DIR/pnpm"\n'
  );
  chmodSync(join(dir, "pnpm.sh"), 0o755);
  writeFileSync(
    join(dir, "smoke"),
    "vite/8.3.5 linux-x64 node-v24.21.0\nworkerd 2026-10-23\n"
  );
  return { checkout, put, repo, sha };
};

const run = (
  cwd: string,
  checkout: string,
  env: Record<string, string> = {},
  args: string[] = []
) => {
  const result = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...HERMETIC_GIT,
      FAKE_DIR: dir,
      VERTEX_RESTART_LOCK: join(dir, "lock"),
      VERTEX_RUNTIME_MIN_FREE_KB: "1",
      VERTEX_RUNTIME_NODE: process.execPath,
      VERTEX_RUNTIME_PNPM: join(dir, "pnpm.sh"),
      VERTEX_RUNTIME_RSYNC_TARGET: checkout,
      VERTEX_WEB_DIR: join(checkout, "apps/web"),
      VERTEX_WEB_SSH: join(dir, "fake.sh"),
      ...env,
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    calls: read("calls"),
    pnpm: read("pnpm"),
    status: result.status,
    stdout: result.stdout,
    syntax: read("syntax"),
  };
};

describe("stage-runtime.sh", () => {
  it("stages tracked files and packages next to the live tree, and marks the stage last", () => {
    const { checkout, repo, sha } = setup();
    const result = run(repo, checkout);
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    expect(result.calls).toEqual(["checkout", "space", "prepare", "smoke"]);
    expect(result.pnpm).toEqual(["install --frozen-lockfile --offline"]);
    expect(result.stdout).toContain(`staged runtime ${sha} in `);
    expect(result.stdout).toContain("program check: vite/8.3.5");
    const stage = join(checkout, ".runtime-next");
    const read = (path: string) => readFileSync(join(stage, path), "utf8");
    expect(read("RUNTIME_SHA")).toBe(`${sha}\n`);
    expect(read("PATHS").trim().split("\n")).toEqual([
      ".gitignore",
      "café.md",
      "infra",
      "my notes.md",
      "package.json",
      "packages",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "node_modules",
      "apps/operator",
      "apps/web/package.json",
      "apps/web/src",
      "apps/web/vite.config.ts",
      "apps/web/node_modules",
      "RUNTIME_SHA",
    ]);
    expect(read("apps/web/package.json")).toBe('{"name":"web"}');
    expect(read("apps/web/src/proxy.ts")).toBe("export {};");
    expect(read("infra/quantvps/run-preview.mjs")).toBe("// runner");
    expect(read("node_modules/.modules.yaml")).toContain("layoutVersion");
    // The package link resolves inside the staged tree.
    expect(read("apps/web/node_modules/a/index.js")).toBe("a");
    expect(existsSync(join(stage, "packages/ui/node_modules/.keep"))).toBe(
      true
    );
    // Not staged: untracked files, build output, files of the earlier stage.
    expect(existsSync(join(stage, "notes.txt"))).toBe(false);
    expect(existsSync(join(stage, "apps/web/dist"))).toBe(false);
    expect(existsSync(join(stage, "stale-file"))).toBe(false);
    // An unchanged package file shares its data with the live file.
    const packageFile = "node_modules/.pnpm/a@1.0.0/node_modules/a/index.js";
    expect(statSync(join(stage, packageFile)).ino).toBe(
      statSync(join(checkout, packageFile)).ino
    );
    // The live tree did not change.
    expect(readFileSync(join(checkout, "RUNTIME_SHA"), "utf8")).toBe(
      "0ld0000\n"
    );
    expect(readFileSync(join(checkout, "apps/web/package.json"), "utf8")).toBe(
      '{"name":"old"}'
    );
    expect(
      readFileSync(join(checkout, "apps/web/dist/server/wrangler.json"), "utf8")
    ).toBe("live build");
  });

  it("refuses a changed tracked file, a linked node_modules and a failed pnpm check", () => {
    const { checkout, put, repo } = setup();
    writeFileSync(join(dir, "pnpm.sh"), "#!/usr/bin/env bash\nexit 1\n");
    const pnpmFailed = run(repo, checkout);
    expect(pnpmFailed.status).toBe(3);
    expect(pnpmFailed.stdout).toContain(
      "node_modules does not match pnpm-lock.yaml"
    );
    put(repo, "apps/web/vite.config.ts", "changed");
    const dirty = run(repo, checkout);
    expect(dirty.status).toBe(3);
    expect(dirty.stdout).toContain(
      "NOT STAGED: a tracked file differs from HEAD"
    );
    spawnSync("git", ["-C", repo, "checkout", "-q", "--", "."]);
    rmSync(join(repo, "node_modules"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(repo, "node_modules"));
    const linked = run(repo, checkout);
    expect(linked.status).toBe(3);
    expect(linked.stdout).toContain("is a link");
    // No refusal reached the target: the earlier stage is untouched.
    expect(pnpmFailed.calls).toEqual([]);
    expect(existsSync(join(checkout, ".runtime-next/stale-file"))).toBe(true);
    expect(run(repo, checkout, {}, ["--force"]).status).toBe(2);
    expect(run(dir, checkout).status).toBe(3);
  });

  it("refuses low free space and an unfinished runtime swap before any copy", () => {
    const { checkout, put, repo } = setup();
    const low = run(repo, checkout, {
      VERTEX_RUNTIME_MIN_FREE_KB: "999999999999",
    });
    expect(low.status).toBe(3);
    expect(low.stdout).toContain("MiB free on QuantVPS");
    expect(low.stdout).toContain("owner decision");
    // A refusal changes nothing on the target: the earlier stage is still there.
    expect(low.calls).toEqual(["checkout", "space"]);
    expect(
      readFileSync(join(checkout, ".runtime-next/RUNTIME_SHA"), "utf8")
    ).toBe("stale\n");
    put(checkout, ".runtime-bak-20261115T101500Z/DONE", "package.json\n");
    const unfinished = run(repo, checkout);
    expect(unfinished.status).toBe(3);
    expect(unfinished.stdout).toContain(
      ".runtime-bak-20261115T101500Z has no COMPLETE file"
    );
    put(checkout, ".runtime-bak-20261115T101500Z/UNDONE", "");
    expect(run(repo, checkout).status).toBe(0);
  });

  it("reports a failed copy with exit 5 and leaves no complete stage", () => {
    const { checkout, repo } = setup();
    const result = run(repo, checkout, {
      VERTEX_RUNTIME_RSYNC_TARGET: join(dir, "no-such-directory", "checkout"),
    });
    expect(result.status).toBe(5);
    expect(result.stdout).toContain("rsync of the runtime tree failed");
    expect(result.calls).toEqual(["checkout", "space", "prepare"]);
    expect(existsSync(join(checkout, ".runtime-next/RUNTIME_SHA"))).toBe(false);
  });

  it("leaves the stage incomplete when the program check fails", () => {
    const { checkout, repo } = setup();
    writeFileSync(
      join(dir, "smoke"),
      "workerd: error while loading shared libraries\n"
    );
    writeFileSync(join(dir, "smoke.fail"), "");
    const result = run(repo, checkout);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain(
      "the staged programs do not start on QuantVPS"
    );
    expect(result.stdout).toContain("error while loading shared libraries");
    expect(
      existsSync(join(checkout, ".runtime-next/apps/web/package.json"))
    ).toBe(true);
    expect(existsSync(join(checkout, ".runtime-next/RUNTIME_SHA"))).toBe(false);
    expect(existsSync(join(checkout, ".runtime-next/PATHS"))).toBe(false);
  });

  it("exits at once when the restart lock is held", () => {
    const { checkout, repo } = setup();
    const lock = join(dir, "lock");
    const result = spawnSync(
      "bash",
      ["-c", 'exec 8>"$L"; flock -n 8 || exit 99; bash "$S"; echo "rc=$?"'],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          ...HERMETIC_GIT,
          FAKE_DIR: dir,
          L: lock,
          S: script,
          VERTEX_RESTART_LOCK: lock,
          VERTEX_RUNTIME_RSYNC_TARGET: checkout,
          VERTEX_WEB_DIR: join(checkout, "apps/web"),
          VERTEX_WEB_SSH: join(dir, "fake.sh"),
        },
      }
    );
    expect(result.stdout).toContain(
      "NOT STAGED: a vertex-web restart waiter or another stage is active"
    );
    expect(result.stdout).toContain("rc=8");
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });
});
