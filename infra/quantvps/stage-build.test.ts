import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The build stage for vertex-web on QuantVPS. The script runs against a temporary git worktree
// and a local "apps/web" directory: the fake remote runner executes every remote command on this
// machine and rsync copies to a local folder, so no test reaches QuantVPS.
const script = fileURLToPath(new URL("./stage-build.sh", import.meta.url));

// Fake remote runner: logs the ": <name>;" marker of each call and runs the command for real. A
// <dir>/<name>.fail file makes that call fail with no output.
const FAKE = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$FAKE_DIR/calls"
bash -n -c "$cmd" 2>>"$FAKE_DIR/syntax" || { echo "$name" >>"$FAKE_DIR/syntax"; exit 97; }
[ -f "$FAKE_DIR/$name.fail" ] && exit 1
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
const CONFIG = ".wrangler/deploy/config.json";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = "";
});

// A build worktree at one commit with its build output, and the live apps/web on the "host".
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), "vertex-stage-build-"));
  const repo = join(dir, "repo");
  const web = join(dir, "host/apps/web");
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
  put(repo, ".gitignore", "dist\n.wrangler\n");
  put(repo, "apps/web/package.json", '{"name":"web"}');
  git("add", "-A");
  git("commit", "-q", "-m", "build");
  const sha = git("rev-parse", "HEAD");
  put(repo, "apps/web/dist/server/wrangler.json", "new build");
  put(repo, "apps/web/dist/server/.dev.vars", "bindings of the rig build");
  put(repo, "apps/web/dist/client/_next/static/css/new.css", "new css");
  put(repo, "apps/web/dist/DEPLOYED_SHA", `${sha}\n`);
  put(repo, `apps/web/${CONFIG}`, "new config");
  put(web, "dist/server/wrangler.json", "live build");
  put(web, "dist/client/_next/static/css/live.css", "live css");
  put(web, CONFIG, "live config");
  writeFileSync(join(dir, "fake.sh"), FAKE);
  chmodSync(join(dir, "fake.sh"), 0o755);
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = spawnSync("bash", [script, ...args], {
      cwd: join(repo, "apps/web"),
      encoding: "utf8",
      env: {
        ...process.env,
        ...HERMETIC_GIT,
        FAKE_DIR: dir,
        VERTEX_BUILD_RSYNC_TARGET: web,
        VERTEX_RESTART_LOCK: join(dir, "lock"),
        VERTEX_WEB_DIR: web,
        VERTEX_WEB_SSH: join(dir, "fake.sh"),
        ...env,
      },
    });
    const lines = (name: string) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
        : [];
    return {
      calls: lines("calls"),
      status: result.status,
      stdout: result.stdout,
      syntax: lines("syntax"),
    };
  };
  const stage = (path: string) => join(web, ".build-next", path);
  const read = (path: string) => readFileSync(stage(path), "utf8");
  const has = (path: string) => existsSync(stage(path));
  const live = (path: string) => readFileSync(join(web, path), "utf8");
  return { git, has, live, put, read, repo, run, sha, stage, web };
};

describe("stage-build.sh", () => {
  it("stages the build output, the deploy config and the marker; the live build is untouched", () => {
    const t = setup();
    const result = t.run();
    expect(result.stdout).toContain(
      `staged build ${t.sha} in ${t.web}/.build-next; next: infra/quantvps/stage-runtime.sh, then infra/quantvps/restart-when-idle.sh --deploy ${t.sha}`
    );
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    expect(result.calls).toEqual(["webdir", "prepare", "mark"]);
    expect(t.read("dist/server/wrangler.json")).toBe("new build");
    expect(t.read("dist/client/_next/static/css/new.css")).toBe("new css");
    expect(t.read("dist/DEPLOYED_SHA")).toBe(`${t.sha}\n`);
    expect(t.read(CONFIG)).toBe("new config");
    expect(t.read("STAGED_SHA")).toBe(`${t.sha}\n`);
    // The bindings file of the rig build never reaches the host.
    expect(t.has("dist/server/.dev.vars")).toBe(false);
    expect(t.live("dist/server/wrangler.json")).toBe("live build");
    expect(t.live("dist/client/_next/static/css/live.css")).toBe("live css");
    expect(t.live(CONFIG)).toBe("live config");
  });

  it("replaces an earlier stage: files that left the build are deleted", () => {
    const t = setup();
    t.put(t.web, ".build-next/dist/client/_next/static/css/stale.css", "x");
    t.put(t.web, ".build-next/dist/server/wrangler.json", "older stage");
    t.put(t.web, ".build-next/STAGED_SHA", "0ld0000\n");
    expect(t.run().status).toBe(0);
    expect(t.has("dist/client/_next/static/css/stale.css")).toBe(false);
    expect(t.read("dist/server/wrangler.json")).toBe("new build");
    expect(t.read("STAGED_SHA")).toBe(`${t.sha}\n`);
  });

  it("leaves no marker when the copy fails", () => {
    const t = setup();
    t.put(t.web, ".build-next/dist/server/wrangler.json", "older stage");
    t.put(t.web, ".build-next/STAGED_SHA", "0ld0000\n");
    const result = t.run([], {
      VERTEX_BUILD_RSYNC_TARGET: join(dir, "no-such-folder"),
    });
    expect(result.status).toBe(5);
    expect(result.stdout).toContain(
      "NOT STAGED: rsync of the build output failed"
    );
    expect(result.calls).not.toContain("mark");
    // The earlier stage lost its marker before the copy started.
    expect(t.has("STAGED_SHA")).toBe(false);
  });

  it("writes no marker when the copied stage holds another commit", () => {
    const t = setup();
    // The rsync target is another folder, so the stage on the "host" stays empty.
    mkdirSync(join(dir, "elsewhere/.build-next/.wrangler/deploy"), {
      recursive: true,
    });
    const result = t.run([], {
      VERTEX_BUILD_RSYNC_TARGET: join(dir, "elsewhere"),
    });
    expect(result.status).toBe(5);
    expect(result.stdout).toContain("the check of the copied stage failed");
    expect(t.has("STAGED_SHA")).toBe(false);
  });

  it("refuses before any change: wrong commit, changed file, missing output, no path, a symlink", () => {
    // change(repo, web) breaks one precondition in a fresh fixture.
    const refused = (
      change: (repo: string, web: string) => void,
      text: string
    ) => {
      if (dir) rmSync(dir, { force: true, recursive: true });
      const t = setup();
      t.put(t.web, ".build-next/STAGED_SHA", "0ld0000\n");
      change(t.repo, t.web);
      const result = t.run();
      expect(result.stdout).toContain("NOT STAGED:");
      expect(result.stdout).toContain(text);
      expect(result.status).toBe(3);
      // The marker of the earlier stage is still there: nothing changed.
      expect(t.read("STAGED_SHA")).toBe("0ld0000\n");
      expect(result.calls).not.toContain("mark");
    };
    refused(
      (repo) =>
        writeFileSync(join(repo, "apps/web/dist/DEPLOYED_SHA"), "0ld0000\n"),
      "apps/web/dist/DEPLOYED_SHA holds 0ld0000, but HEAD is"
    );
    refused(
      (repo) => rmSync(join(repo, "apps/web/dist/DEPLOYED_SHA")),
      "apps/web/dist/DEPLOYED_SHA holds nothing"
    );
    refused(
      (repo) => writeFileSync(join(repo, "apps/web/package.json"), "changed"),
      "a tracked file differs from HEAD"
    );
    refused(
      (repo) => rmSync(join(repo, "apps/web", CONFIG)),
      "the build output is missing"
    );
    refused(
      () => writeFileSync(join(dir, "webdir.fail"), ""),
      "no apps/web path from QuantVPS"
    );
    refused((_repo, web) => {
      mkdirSync(join(web, "elsewhere"));
      symlinkSync("../elsewhere", join(web, ".build-next/dist"));
    }, ".build-next/dist is a symlink or a file");
  });

  it("refuses a symlink in place of the stage folder", () => {
    const t = setup();
    mkdirSync(join(t.web, "elsewhere"));
    symlinkSync("elsewhere", join(t.web, ".build-next"));
    const result = t.run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(".build-next is a symlink or a file");
    expect(existsSync(join(t.web, "elsewhere/dist"))).toBe(false);
  });

  it("exits 8 while a restart waiter or another stage holds the lock, and 2 for an argument", () => {
    const t = setup();
    const holder = spawnSync(
      "flock",
      ["-n", join(dir, "lock"), "bash", script],
      {
        cwd: t.repo,
        encoding: "utf8",
        env: {
          ...process.env,
          ...HERMETIC_GIT,
          FAKE_DIR: dir,
          VERTEX_BUILD_RSYNC_TARGET: t.web,
          VERTEX_RESTART_LOCK: join(dir, "lock"),
          VERTEX_WEB_DIR: t.web,
          VERTEX_WEB_SSH: join(dir, "fake.sh"),
        },
      }
    );
    expect(holder.status).toBe(8);
    expect(holder.stdout).toContain(
      "NOT STAGED: a vertex-web restart waiter or another stage is active"
    );
    expect(t.has("dist")).toBe(false);
    expect(t.run(["--force"]).status).toBe(2);
    const blocked = t.run([], { VERTEX_RESTART_LOCK: dir });
    expect(blocked.status).toBe(11);
  });
});
