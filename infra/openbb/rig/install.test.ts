import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OPENBB_JOBS } from "../../../packages/api/src/contracts/openbb.ts";
import { insideOpenbbWindow } from "../../../scripts/openbb/tick.ts";

// The rig route of the OpenBB ingest: one tick-runner timer runs the steps file. Static checks of
// the steps, units and scripts, plus the run wrapper and install preflight against fake commands in
// a temp HOME, so no test reaches the rig, systemd, uv or the network.
const here = (name: string): string =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));
const read = (name: string): string => readFileSync(here(name), "utf8");

type Step = Readonly<{
  name: string;
  timeout: number;
  every: number;
  stage: number;
  command: string[];
}>;

const steps: Step[] = read("vertex-openbb.steps")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => {
    const [name, timeout, every, stage, ...command] = line.trim().split(/\s+/u);
    return {
      command,
      every: Number(every),
      name: String(name),
      stage: Number(stage),
      timeout: Number(timeout),
    };
  });

const directive = (text: string, key: string): string | undefined =>
  text
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);

describe("vertex-openbb.steps", () => {
  it("has one well-formed step per job, running the wrapper with that job", () => {
    expect(steps.map((step) => step.name).sort()).toEqual(
      [...OPENBB_JOBS].sort()
    );
    for (const step of steps) {
      expect(Number.isInteger(step.timeout) && step.timeout > 0).toBe(true);
      expect(Number.isInteger(step.every) && step.every >= 300).toBe(true);
      expect(Number.isInteger(step.stage) && step.stage >= 1).toBe(true);
      expect(step.command.slice(0, 2)).toEqual([
        "~/.local/bin/vertex-openbb-run",
        step.name,
      ]);
      const rest = step.command.slice(2);
      if (rest.length > 0) {
        expect(rest[0]).toBe("--window");
        expect(rest).toHaveLength(2);
        expect(() =>
          insideOpenbbWindow(String(rest[1]), new Date())
        ).not.toThrow();
      }
    }
  });

  it("runs every SEC job in a stage of its own and nothing else in SEC stages", () => {
    const sec = steps.filter((step) => step.name.startsWith("sec-"));
    const secStages = new Set(sec.map((step) => step.stage));
    expect(secStages.size).toBe(sec.length);
    for (const step of steps.filter((item) => !item.name.startsWith("sec-")))
      expect(secStages.has(step.stage)).toBe(false);
  });
});

describe("vertex-openbb.service", () => {
  const service = read("vertex-openbb.service");

  it("bounds the run: stage maxima plus 10 s per stage fit TimeoutStartSec, memory capped", () => {
    const byStage = new Map<number, number>();
    for (const step of steps)
      byStage.set(
        step.stage,
        Math.max(byStage.get(step.stage) ?? 0, step.timeout)
      );
    const needed = [...byStage.values()].reduce(
      (sum, timeout) => sum + timeout + 10,
      0
    );
    expect(
      Number(directive(service, "TimeoutStartSec"))
    ).toBeGreaterThanOrEqual(needed);
    expect(directive(service, "MemoryMax")).toBe("3G");
    expect(directive(service, "Type")).toBe("oneshot");
    expect(directive(service, "ExecStart")).toBe(
      "%h/Github/tools/self-healing-harness/bin/tick-runner vertex-openbb %h/.local/share/vertex-openbb/vertex-openbb.steps"
    );
  });

  it("starts every 5 minutes", () => {
    expect(directive(read("vertex-openbb.timer"), "OnUnitInactiveSec")).toBe(
      "5min"
    );
  });
});

describe("scripts", () => {
  it("never print the key, never trace, and use the fixed base folder", () => {
    for (const name of ["install.sh", "vertex-openbb-run.sh"]) {
      const text = read(name);
      expect(text).not.toMatch(/(echo|printf)[^\n]*(KEY|openbb-key\b[^)])/u);
      expect(text).not.toMatch(/set -[a-z]*x/u);
      expect(text).not.toContain("VERTEX_OPENBB_HOME");
      expect(text).toContain('"$HOME/.local/share/vertex-openbb"');
    }
    const install = read("install.sh");
    expect(install).toContain(
      'uv pip sync --quiet --require-hashes "$base/checkout/$lock"'
    );
    expect(install).toContain(
      "uv pip install --quiet --no-deps --no-build-isolation"
    );
    expect(install.indexOf("worktree prune")).toBeLessThan(
      install.indexOf("worktree add")
    );
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

/** A temp HOME with the env and key files, a checkout folder and fake commands on PATH. */
const fakeHome = (linger = "yes") => {
  const home = mkdtempSync(join(tmpdir(), "vertex-openbb-"));
  roots.push(home);
  const bin = join(home, "fake-bin");
  const log = join(home, "calls.log");
  mkdirSync(join(home, ".config/vertex"), { recursive: true });
  mkdirSync(join(home, ".local/share/vertex-openbb/checkout"), {
    recursive: true,
  });
  mkdirSync(bin);
  writeFileSync(
    join(home, ".config/vertex/openbb.env"),
    "VERTEX_ORIGIN=https://vertex.domain.test\n",
    { mode: 0o600 }
  );
  writeFileSync(join(home, ".config/vertex/openbb-key"), "dfk_secret\n", {
    mode: 0o600,
  });
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("bun", `echo "bun $*" >>"${log}"`);
  fake("flock", `echo "flock $1" >>"${log}"; shift; exec "$@"`);
  fake("loginctl", `echo ${linger}`);
  const run = (script: string, args: string[]) =>
    spawnSync("bash", [here(script), ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        USER: "tester",
      },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { calls, home, run };
};

describe("vertex-openbb-run.sh", () => {
  it("holds the SEC lock for sec-* jobs only and passes arguments through", () => {
    const host = fakeHome();
    const sec = host.run("vertex-openbb-run.sh", ["sec-13f", "--dry-run"]);
    expect(sec.status).toBe(0);
    expect(host.calls()).toBe(
      `flock ${host.home}/.cache/vertex-openbb/sec.lock\nbun run vertex:openbb:tick sec-13f --dry-run\n`
    );
    expect(existsSync(join(host.home, ".cache/vertex-openbb"))).toBe(true);
    const other = fakeHome();
    expect(other.run("vertex-openbb-run.sh", ["fed-rates"]).status).toBe(0);
    expect(other.calls()).toBe("bun run vertex:openbb:tick fed-rates\n");
    expect(`${sec.stdout}${sec.stderr}`).not.toContain("dfk_secret");
  });

  it("exits 2 without the env or key file", () => {
    const host = fakeHome();
    rmSync(join(host.home, ".config/vertex/openbb-key"));
    const result = host.run("vertex-openbb-run.sh", ["fed-rates"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing");
    expect(host.calls()).toBe("");
  });
});

describe("install.sh preflight", () => {
  it("exits 2 without tick-runner, then without lingering", () => {
    const host = fakeHome("no");
    const missing = host.run("install.sh", ["deadbeef"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("self-healing-harness");
    const runner = join(host.home, "Github/tools/self-healing-harness/bin");
    mkdirSync(runner, { recursive: true });
    writeFileSync(join(runner, "tick-runner"), "#!/bin/sh\n");
    chmodSync(join(runner, "tick-runner"), 0o755);
    const noLinger = host.run("install.sh", ["deadbeef"]);
    expect(noLinger.status).toBe(2);
    expect(noLinger.stderr).toContain("loginctl enable-linger");
    expect(host.run("install.sh", []).status).toBe(2);
  });
});
