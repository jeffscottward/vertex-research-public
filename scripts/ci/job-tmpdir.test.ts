import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("job-tmpdir.sh", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "job-tmpdir-"));
  roots.push(root);
  const shm = join(root, "shm");
  mkdirSync(shm);
  const githubEnv = join(root, "github-env");
  writeFileSync(githubEnv, "");
  const env = {
    PATH: process.env["PATH"] ?? "",
    JOB_TMPDIR_SHM: shm,
    GITHUB_ENV: githubEnv,
    RUNNER_NAME: "rig-vertex-4",
    GITHUB_RUN_ID: "41",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "coverage-shards",
    JOB_INDEX: "3",
    TMPDIR: "/var/tmp/old",
    JOB_TMPDIR_MIN_KIB: "0",
  };
  const run = (command: string, extra: Record<string, string> = {}) =>
    execFileSync("bash", [script, command], {
      env: { ...env, ...extra },
    }).toString();
  return { shm, githubEnv, run };
};

const jobDir = "vct-rig-vertex-4";

describe("job-tmpdir.sh", () => {
  it("exports a private tmpfs TMPDIR and removes it on down", () => {
    const { shm, githubEnv, run } = setup();
    expect(run("up")).toContain("(tmpfs,");
    const dir = join(shm, jobDir);
    expect(readFileSync(githubEnv, "utf8")).toBe(`TMPDIR=${dir}\n`);
    writeFileSync(join(dir, "file"), "x");
    run("down");
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the current TMPDIR when tmpfs has too little room", () => {
    const { shm, githubEnv, run } = setup();
    const out = run("up", { JOB_TMPDIR_MIN_KIB: "999999999999" });
    expect(out).toContain("TMPDIR: /var/tmp/old (unchanged;");
    expect(readFileSync(githubEnv, "utf8")).toBe("");
    expect(readdirSync(shm)).toEqual([]);
  });

  it("keeps the current TMPDIR when the tmpfs root is missing", () => {
    const { shm, githubEnv, run } = setup();
    rmSync(shm, { recursive: true });
    expect(run("up")).toContain("(unchanged;");
    expect(readFileSync(githubEnv, "utf8")).toBe("");
  });

  it("removes leftovers of this runner only", () => {
    const { shm, run } = setup();
    mkdirSync(join(shm, jobDir));
    writeFileSync(join(shm, jobDir, "stale"), "x");
    mkdirSync(join(shm, "vct-rig-vertex-45"));
    run("up");
    expect(readdirSync(shm).sort()).toEqual([jobDir, "vct-rig-vertex-45"]);
    expect(readdirSync(join(shm, jobDir))).toEqual([]);
  });

  it("rejects an unknown command", () => {
    const { run } = setup();
    expect(() => run("bad")).toThrow();
  });
});
