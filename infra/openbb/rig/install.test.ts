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

  it("gives every step at least the fetcher deadline plus 90 s", () => {
    const cli = readFileSync(
      fileURLToPath(
        new URL(
          "../../../services/openbb/vertex_openbb/cli.py",
          import.meta.url
        )
      ),
      "utf8"
    );
    const deadline = Number(/^DEFAULT_DEADLINE_S = ([\d.]+)$/mu.exec(cli)?.[1]);
    expect(deadline).toBe(240);
    for (const step of steps)
      expect(step.timeout, step.name).toBeGreaterThanOrEqual(
        // SEC steps also wait up to 20 s for the SEC lock before the fetcher starts.
        deadline + 90 + (step.name.startsWith("sec-") ? 20 : 0)
      );
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
    expect(directive(service, "MemoryHigh")).toBe("2560M");
    expect(directive(service, "OOMPolicy")).toBe("continue");
    expect(directive(service, "Environment")).toBe("VERTEX_OPENBB_TIMER=1");
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
      'uv pip sync --quiet --require-hashes --only-binary :all: --no-config "$base/checkout/$lock"'
    );
    expect(install).toContain('user="$(id -un)"');
    expect(install).toContain("uv venv --quiet --no-config --python 3.12");
    // The run lock is released before systemd is touched.
    expect(install.indexOf("exec 9>&-")).toBeGreaterThan(-1);
    expect(install.indexOf("exec 9>&-")).toBeLessThan(
      install.indexOf("systemctl --user daemon-reload")
    );
    expect(install).not.toContain("$USER");
    expect(install).not.toContain("static interface");
    expect(install).toContain(
      "uv pip install --quiet --no-config --no-deps --no-build-isolation"
    );
    expect(install.indexOf("worktree unlock")).toBeLessThan(
      install.indexOf("worktree prune")
    );
    expect(install.indexOf("worktree prune")).toBeLessThan(
      install.indexOf("worktree add")
    );
    expect(install).toContain("worktree lock --reason");
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
  fake(
    "bun",
    `echo "bun $*" >>"${log}"; if [[ -n "\${OPENBB_DEADLINE_S:-}" ]]; then echo "deadline leaked" >>"${log}"; fi`
  );
  // Logs its full argument list; FAKE_FLOCK_BUSY makes it fail like a held lock (-E code, or 1).
  fake(
    "flock",
    [
      `echo "flock $*" >>"${log}"`,
      'code=1; args=("$@")',
      'while [[ "${1:-}" == -* ]]; do case "$1" in -E) code="$2"; shift 2;; -w) shift 2;; *) shift;; esac; done',
      'if [[ -n "${FAKE_FLOCK_BUSY:-}" ]]; then exit "$code"; fi',
      "shift",
      'if [[ $# -gt 0 ]]; then exec "$@"; fi',
    ].join("\n")
  );
  fake("loginctl", `echo ${linger}`);
  const run = (
    script: string,
    args: string[],
    extra: Record<string, string> = {}
  ) =>
    spawnSync("bash", [here(script), ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        ...extra,
      },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const addTickRunner = () => {
    const runner = join(home, "Github/tools/self-healing-harness/bin");
    mkdirSync(runner, { recursive: true });
    writeFileSync(join(runner, "tick-runner"), "#!/bin/sh\n");
    chmodSync(join(runner, "tick-runner"), 0o755);
  };
  return { addTickRunner, calls, home, run };
};

describe("vertex-openbb-run.sh", () => {
  it("manual SEC runs wait for the SEC lock; other jobs take no lock", () => {
    const host = fakeHome();
    const sec = host.run("vertex-openbb-run.sh", ["sec-13f", "--dry-run"]);
    expect(sec.status).toBe(0);
    expect(host.calls()).toBe(
      `flock ${host.home}/.cache/vertex-openbb/sec.lock ${host.home}/fake-bin/bun run vertex:openbb:tick sec-13f --dry-run\nbun run vertex:openbb:tick sec-13f --dry-run\n`
    );
    expect(existsSync(join(host.home, ".cache/vertex-openbb"))).toBe(true);
    const other = fakeHome();
    expect(other.run("vertex-openbb-run.sh", ["fed-rates"]).status).toBe(0);
    expect(other.calls()).toBe("bun run vertex:openbb:tick fed-rates\n");
    expect(`${sec.stdout}${sec.stderr}`).not.toContain("dfk_secret");
  });

  it("timer SEC runs wait 20 s for the lock, then skip with exit 0", () => {
    const host = fakeHome();
    const timer = { VERTEX_OPENBB_TIMER: "1" };
    const free = host.run("vertex-openbb-run.sh", ["sec-ftd"], timer);
    expect(free.status).toBe(0);
    expect(host.calls().split("\n")[0]).toBe(
      `flock -w 20 -E 75 ${host.home}/.cache/vertex-openbb/sec.lock ${host.home}/fake-bin/bun run vertex:openbb:tick sec-ftd`
    );
    const busy = host.run("vertex-openbb-run.sh", ["sec-ftd"], {
      ...timer,
      FAKE_FLOCK_BUSY: "1",
    });
    expect(busy.status).toBe(0);
    expect(busy.stdout).toBe("skip: SEC lock held (manual run in progress)\n");
    const failing = fakeHome();
    writeFileSync(
      join(failing.home, "fake-bin/bun"),
      "#!/usr/bin/env bash\nexit 1\n"
    );
    expect(failing.run("vertex-openbb-run.sh", ["sec-ftd"], timer).status).toBe(
      1
    );
  });

  it("treats a shell with INVOCATION_ID but no timer marker as a manual run that waits", () => {
    const host = fakeHome();
    const run = host.run("vertex-openbb-run.sh", ["sec-form4"], {
      INVOCATION_ID: "desktop-session",
    });
    expect(run.status).toBe(0);
    expect(host.calls().split("\n")[0]).toBe(
      `flock ${host.home}/.cache/vertex-openbb/sec.lock ${host.home}/fake-bin/bun run vertex:openbb:tick sec-form4`
    );
  });

  it("drops an OPENBB_DEADLINE_S override from the shell and from openbb.env", () => {
    const host = fakeHome();
    writeFileSync(
      join(host.home, ".config/vertex/openbb.env"),
      "VERTEX_ORIGIN=https://vertex.domain.test\nOPENBB_DEADLINE_S=900\n",
      { mode: 0o600 }
    );
    expect(
      host.run("vertex-openbb-run.sh", ["fed-rates"], {
        OPENBB_DEADLINE_S: "900",
      }).status
    ).toBe(0);
    expect(host.calls()).toBe("bun run vertex:openbb:tick fed-rates\n");
    expect(read("vertex-openbb-run.sh")).toContain("unset OPENBB_DEADLINE_S");
  });

  it("exits 2 without the env or key file, or with an empty key", () => {
    const host = fakeHome();
    rmSync(join(host.home, ".config/vertex/openbb-key"));
    const result = host.run("vertex-openbb-run.sh", ["fed-rates"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing");
    writeFileSync(join(host.home, ".config/vertex/openbb-key"), "\r\n", {
      mode: 0o600,
    });
    const empty = host.run("vertex-openbb-run.sh", ["fed-rates"]);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("is empty");
    expect(host.calls()).toBe("");
  });
});

describe("install.sh preflight", () => {
  it("rejects bad arguments, then a missing tick-runner, then lingering off", () => {
    const host = fakeHome("no");
    for (const args of [
      [],
      ["--enable"],
      ["deadbeef", "--bogus"],
      ["a", "--enable", "b"],
    ])
      expect(host.run("install.sh", args).status).toBe(2);
    const missing = host.run("install.sh", ["deadbeef"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("self-healing-harness");
    host.addTickRunner();
    const noLinger = host.run("install.sh", ["deadbeef"]);
    expect(noLinger.status).toBe(2);
    expect(noLinger.stderr).toContain("loginctl enable-linger");
    expect(host.calls()).toBe("");
  });

  it("holds tick-runner's run lock for the whole install and gives up after 600 s", () => {
    const host = fakeHome();
    host.addTickRunner();
    const busy = host.run("install.sh", ["deadbeef", "--enable"], {
      FAKE_FLOCK_BUSY: "1",
    });
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain("run.lock after 600 s");
    expect(host.calls()).toBe("flock -w 600 9\n");
    expect(
      existsSync(
        join(host.home, ".local/state/tick-runner/vertex-openbb/run.lock")
      )
    ).toBe(true);
  });
});

describe("install.sh worktree lock", () => {
  it("locks the checkout worktree on fresh install, re-install, unlocked upgrade, and manual delete recovery", () => {
    const host = fakeHome();
    host.addTickRunner();
    // fakeHome pre-creates an empty checkout dir; start clean for a real fresh install.
    const checkout = join(host.home, ".local/share/vertex-openbb/checkout");
    rmSync(checkout, { force: true, recursive: true });

    const bin = join(host.home, "fake-bin");
    const addFake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    addFake("pnpm", "exit 0");
    addFake("systemctl", "exit 0");
    addFake(
      "uv",
      [
        'if [[ "${1:-}" == "venv" ]]; then',
        '  dest="${@: -1}"',
        '  mkdir -p "$dest/bin"',
        '  printf "#!/usr/bin/env bash\necho warm: ok\n" >"$dest/bin/python"',
        '  chmod +x "$dest/bin/python"',
        "fi",
        "exit 0",
      ].join("\n")
    );

    const repo = mkdtempSync(join(tmpdir(), "vertex-openbb-repo-"));
    roots.push(repo);
    const git = (...args: string[]) => {
      const res = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: "test@example.test",
          GIT_AUTHOR_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.test",
          GIT_COMMITTER_NAME: "test",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: host.home,
        },
      });
      if (res.status !== 0)
        throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
      return res.stdout.trim();
    };
    git("init", "-q");
    mkdirSync(join(repo, "infra/openbb/rig"), { recursive: true });
    mkdirSync(join(repo, "services/openbb"), { recursive: true });
    for (const file of [
      "install.sh",
      "vertex-openbb-run.sh",
      "vertex-openbb.service",
      "vertex-openbb.steps",
      "vertex-openbb.timer",
    ])
      writeFileSync(join(repo, "infra/openbb/rig", file), read(file));
    chmodSync(join(repo, "infra/openbb/rig/install.sh"), 0o755);
    writeFileSync(
      join(repo, "services/openbb/requirements-openbb-linux-py312.lock"),
      "# lock\n"
    );
    git("add", ".");
    git("commit", "-qm", "initial");
    const sha1 = git("rev-parse", "HEAD");

    writeFileSync(
      join(repo, "services/openbb/requirements-openbb-linux-py312.lock"),
      "# lock v2\n"
    );
    git("add", ".");
    git("commit", "-qm", "second");
    const sha2 = git("rev-parse", "HEAD");

    const runInstall = (sha: string) =>
      spawnSync("bash", [join(repo, "infra/openbb/rig/install.sh"), sha], {
        encoding: "utf8",
        env: {
          HOME: host.home,
          PATH: `${bin}:/usr/bin:/bin`,
        },
      });

    // 1. Fresh install creates and locks the detached worktree.
    const fresh = runInstall(sha1);
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(
      spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim()
    ).toBe(sha1);
    expect(git("worktree", "list", "--porcelain")).toContain(
      "locked Live deploy worktree for vertex-openbb.service"
    );

    // Bulk cleanup (`git worktree remove --force`) refuses to delete the locked checkout.
    const forcedRemove = spawnSync(
      "git",
      ["-C", repo, "worktree", "remove", "--force", checkout],
      { encoding: "utf8" }
    );
    expect(forcedRemove.status).not.toBe(0);
    expect(existsSync(checkout)).toBe(true);

    // 2. Re-install on an already-locked worktree succeeds and updates the SHA.
    const upgrade = runInstall(sha2);
    expect(upgrade.status, upgrade.stderr).toBe(0);
    expect(
      spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim()
    ).toBe(sha2);
    expect(git("worktree", "list", "--porcelain")).toContain(
      "locked Live deploy worktree for vertex-openbb.service"
    );

    // 3. Re-install on an existing unlocked worktree re-locks it.
    git("worktree", "unlock", checkout);
    expect(git("worktree", "list", "--porcelain")).not.toContain("locked");
    const relock = runInstall(sha2);
    expect(relock.status, relock.stderr).toBe(0);
    expect(git("worktree", "list", "--porcelain")).toContain(
      "locked Live deploy worktree for vertex-openbb.service"
    );

    // 4. Recovery after manual removal of a locked checkout unlocks, prunes, recreates, and relocks.
    rmSync(checkout, { force: true, recursive: true });
    const recovered = runInstall(sha2);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(checkout)).toBe(true);
    expect(git("worktree", "list", "--porcelain")).toContain(
      "locked Live deploy worktree for vertex-openbb.service"
    );
  });
});
