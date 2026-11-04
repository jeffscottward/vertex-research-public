import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

// The restart route for vertex-web on QuantVPS. The idle decision is checked with
// recorded `ss -tni` probe fixtures; the full flow runs against a fake remote runner,
// so no test reaches QuantVPS or restarts anything.
const script = fileURLToPath(
  new URL("./restart-when-idle.sh", import.meta.url)
);
const fixture = (name: string): string =>
  fileURLToPath(
    new URL(`./fixtures/restart-when-idle/${name}`, import.meta.url)
  );

const decide = (name: string, quiet = "30") => {
  const result = spawnSync("bash", [script, "--decide", fixture(name), quiet], {
    encoding: "utf8",
  });
  const [decision, ...reasons] = result.stdout.trim().split("\n");
  return { decision, reasons, status: result.status };
};

describe("idle decision", () => {
  it("treats answered keep-alive connections outside the quiet window as idle", () => {
    expect(decide("idle-keepalive.txt")).toEqual({
      decision: "idle",
      reasons: [
        "no open request on :3450 (2 keep-alive connection(s), quiet >= 30 s); last log line 100 s ago",
      ],
      status: 0,
    });
  });

  it("is idle with no connection and an old log line", () => {
    expect(decide("idle-no-connections.txt").decision).toBe("idle");
  });

  it("is idle when the unit is not active", () => {
    expect(decide("idle-unit-inactive.txt")).toMatchObject({
      decision: "idle",
      reasons: ["unit vertex-web is failed; nothing to protect"],
    });
  });

  it("is busy while a request waits for its response", () => {
    expect(decide("busy-open-request.txt")).toMatchObject({
      decision: "busy",
      reasons: [
        "connection 127.0.0.1:42318: request received 45 s ago, no response yet",
      ],
    });
  });

  it("is busy after recent traffic on a connection", () => {
    expect(decide("busy-recent-data.txt")).toMatchObject({
      decision: "busy",
      reasons: ["connection 127.0.0.1:42318: data 2000 ms ago"],
    });
  });

  it("is busy after a recent log line", () => {
    expect(decide("busy-recent-log.txt")).toMatchObject({
      decision: "busy",
      reasons: ["last log line 10 s ago (quiet window 30 s)"],
    });
  });

  it("is idle after the same log line when the quiet window is shorter", () => {
    expect(decide("busy-recent-log.txt", "5").decision).toBe("idle");
  });

  it("is busy while bytes are queued", () => {
    expect(decide("busy-queued-bytes.txt")).toMatchObject({
      decision: "busy",
      reasons: ["connection 127.0.0.1:42318: 120 bytes queued"],
    });
  });

  it("reads a missing lastsnd field as 0 ms ago", () => {
    expect(decide("busy-missing-lastsnd.txt").decision).toBe("busy");
  });

  it("is busy when the probe is incomplete", () => {
    expect(decide("busy-empty-probe.txt")).toMatchObject({
      decision: "busy",
      reasons: ["probe incomplete (no unit state)"],
    });
  });

  it("is busy while a new connection holds a request with no byte sent yet", () => {
    expect(decide("busy-new-connection.txt")).toMatchObject({
      decision: "busy",
      reasons: [
        "connection 127.0.0.1:42318: request received 40 s ago, no response yet",
      ],
    });
  });

  it("is busy when the ss output did not complete", () => {
    expect(decide("busy-cut-probe.txt")).toMatchObject({
      decision: "busy",
      reasons: ["probe incomplete (no complete ss output)"],
    });
  });

  it("rejects a malformed --decide call", () => {
    const result = spawnSync("bash", [script, "--decide"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
  });
});

// Fake remote runner: names each call by its ": <name>;" marker, logs it, and answers from
// <dir>/<name>.<n> (n-th call) or <dir>/<name>. A <name>.fail or <name>.<n>.fail file makes
// that call fail; a <name>.stderr file is written to stderr. Every command string must pass
// `bash -n`. With a <dir>/real file, gate, candidate, restart and rollback run for real against
// VERTEX_WEB_DIR, with a systemctl stub on PATH.
const FAKE = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$FAKE_DIR/calls"
bash -n -c "$cmd" 2>>"$FAKE_DIR/syntax" || { echo "$name" >>"$FAKE_DIR/syntax"; exit 97; }
n=$(grep -cx "$name" "$FAKE_DIR/calls")
case "$name" in restart|rollback) printf '%s\\n' "\${cmd//$'\\n'/ }" >>"$FAKE_DIR/commands" ;; esac
[ -f "$FAKE_DIR/$name.stderr" ] && cat "$FAKE_DIR/$name.stderr" >&2
if [ -f "$FAKE_DIR/real" ]; then
  case "$name" in gate|candidate|restart|rollback) exec bash -c "$cmd" ;; esac
fi
f="$FAKE_DIR/$name.$n"; [ -f "$f" ] || f="$FAKE_DIR/$name"
[ -f "$f" ] && cat "$f"
{ [ -f "$FAKE_DIR/$name.$n.fail" ] || [ -f "$FAKE_DIR/$name.fail" ]; } && exit 1
exit 0
`;
const IDLE = readFileSync(fixture("idle-keepalive.txt"), "utf8");
const BUSY = readFileSync(fixture("busy-open-request.txt"), "utf8");
const HEALTHY =
  "root=200 dashboard=307 http://127.0.0.1:3450/sign-in?callbackURL=%2Fdashboard active=active\n";
const STARTS =
  "vertex-web Sun 2026-11-01 12:55:08 UTC\n/ibkr-nautilus-exec-node-ib-gateway-1 2026-10-31T17:52:12Z\n";
// After a restart only the vertex-web line changes.
const STARTS_AFTER = STARTS.replace("12:55:08", "15:10:00");
// No global or system git config for fixture commits and the script's ancestry checks.
const HERMETIC_GIT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = "";
});

const setup = (files: Record<string, string>) => {
  dir = mkdtempSync(join(tmpdir(), "vertex-restart-"));
  writeFileSync(join(dir, "fake.sh"), FAKE);
  chmodSync(join(dir, "fake.sh"), 0o755);
  writeFileSync(
    join(dir, "alert.sh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >>"${join(dir, "alerts")}"\n`
  );
  chmodSync(join(dir, "alert.sh"), 0o755);
  const defaults: Record<string, string> = {
    candidate: "20261101T125501Z\n",
    gate: "build-output-ok\n",
    health: HEALTHY,
    probe: IDLE,
    shas: "new abc1234\ndeployed abc1234\n",
    starts: STARTS,
    "starts.2": STARTS_AFTER,
  };
  for (const [name, body] of Object.entries({ ...defaults, ...files }))
    writeFileSync(join(dir, name), body);
};

const run = (args: string[] = [], env: Record<string, string> = {}) => {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...HERMETIC_GIT,
      FAKE_DIR: dir,
      PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      VERTEX_RESTART_ALERT: join(dir, "alert.sh"),
      VERTEX_RESTART_GIVE_UP_AFTER: "20",
      VERTEX_RESTART_HEALTH_TIMEOUT: "0",
      VERTEX_RESTART_LOCK: join(dir, "lock"),
      VERTEX_RESTART_SLEEP: "true",
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
    alerts: read("alerts"),
    calls: read("calls"),
    commands: read("commands"),
    status: result.status,
    stdout: result.stdout,
    syntax: read("syntax"),
    systemctl: read("systemctl"),
  };
};

describe("restart flow", () => {
  it("dry run prints the idle decision and never restarts", () => {
    setup({});
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("decision: idle");
    expect(result.stdout).toContain(
      "rollback source: 20261101T125501Z (dist.bak-<TS> + .wrangler.bak-<TS>)"
    );
    expect(result.stdout).toContain("dry run: no restart");
    expect(result.calls).not.toContain("restart");
    expect(result.alerts).toEqual([]);
    expect(result.syntax).toEqual([]);
  });

  it("dry run exits 10 when busy", () => {
    setup({ probe: BUSY });
    const result = run(["--dry-run"]);
    expect(result.status).toBe(10);
    expect(result.stdout).toContain("decision: busy");
    expect(result.calls).not.toContain("restart");
  });

  it("restarts only vertex-web after two idle polls in a row and checks health", () => {
    setup({ "probe.1": IDLE, "probe.2": BUSY, "probe.3": IDLE });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call === "probe")).toHaveLength(4);
    expect(result.commands).toEqual([
      ": restart; systemctl restart vertex-web",
    ]);
    expect(result.stdout).toContain(
      "protected containers: start times unchanged"
    );
    expect(result.alerts).toEqual([]);
  });

  it("takes the container start-time baseline after the idle wait, right before the restart", () => {
    // The wait can cross the 03:00 UTC exec-node container restarts; those must not count.
    setup({ "probe.1": BUSY, "probe.2": IDLE });
    const result = run();
    expect(result.status).toBe(0);
    const firstStarts = result.calls.indexOf("starts");
    expect(firstStarts).toBeGreaterThan(result.calls.lastIndexOf("probe"));
    expect(firstStarts).toBe(result.calls.indexOf("restart") - 1);
  });

  it("gives up with one alert when the app stays busy", () => {
    setup({ probe: BUSY });
    const result = run([], { VERTEX_RESTART_GIVE_UP_AFTER: "0" });
    expect(result.status).toBe(4);
    expect(result.calls).not.toContain("restart");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("vertex-web restart abandoned");
    expect(result.alerts[0]).toContain("request received 45 s ago");
  });

  it("ignores ssh warnings on stderr in the gate and health checks", () => {
    const warning =
      "** WARNING: connection is not using a post-quantum key exchange\n";
    setup({ "gate.stderr": warning, "health.stderr": warning });
    expect(run().status).toBe(0);
  });

  it("reports no restart when the vertex-web start time did not change", () => {
    setup({ "restart.fail": "", "starts.2": STARTS });
    const result = run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "NOT RESTARTED: vertex-web ActiveEnterTimestamp did not change"
    );
  });

  it("does not roll back when the health check gets no answer over ssh", () => {
    setup({ health: "", "health.fail": "" });
    const result = run();
    expect(result.status).toBe(6);
    expect(result.calls).not.toContain("rollback");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("state unknown");
  });

  it("refuses to restart without the build output", () => {
    setup({ gate: "\n", "gate.fail": "" });
    const result = run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("NOT RESTARTED: build output missing");
    expect(result.calls).not.toContain("restart");
  });

  it("refuses to restart without a rollback source", () => {
    setup({ candidate: "dist.bak-old\n" });
    const result = run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("NOT RESTARTED: no rollback source");
  });

  it("rolls back to the backup build when the health check fails", () => {
    setup({
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
    });
    const result = run();
    expect(result.status).toBe(5);
    expect(result.commands[1]).toContain(
      "cp -a dist.bak-20261101T125501Z dist"
    );
    expect(result.commands[1]).toContain(
      "cp -a .wrangler.bak-20261101T125501Z .wrangler"
    );
    expect(result.commands[1]).toContain("mv dist dist.failed-");
    expect(result.commands[1]).toContain("systemctl restart vertex-web");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("Rolled back to build 20261101T125501Z");
  });

  it("runs the real rollback commands: newest timestamped pair, nothing deleted", () => {
    setup({
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      real: "",
    });
    const web = join(dir, "web");
    const put = (path: string, body: string) => {
      mkdirSync(join(web, path, ".."), { recursive: true });
      writeFileSync(join(web, path), body);
    };
    put("dist/server/wrangler.json", "new");
    put(".wrangler/deploy/config.json", "new");
    for (const ts of ["20261001T000000Z", "20261101T125501Z"]) {
      put(`dist.bak-${ts}/server/wrangler.json`, ts);
      put(`.wrangler.bak-${ts}/deploy/config.json`, ts);
    }
    put("dist.bak-old/server/wrangler.json", "stray");
    put(".wrangler.bak-old/deploy/config.json", "stray");
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/systemctl"),
      `#!/usr/bin/env bash\necho "$*" >>"${join(dir, "systemctl")}"\n`
    );
    chmodSync(join(dir, "bin/systemctl"), 0o755);
    const result = run([], { VERTEX_WEB_DIR: web });
    expect(result.status).toBe(5);
    expect(result.syntax).toEqual([]);
    expect(result.systemctl).toEqual([
      "restart vertex-web",
      "restart vertex-web",
    ]);
    const read = (path: string) => readFileSync(join(web, path), "utf8");
    expect(read("dist/server/wrangler.json")).toBe("20261101T125501Z");
    expect(read(".wrangler/deploy/config.json")).toBe("20261101T125501Z");
    expect(read("dist.bak-20261101T125501Z/server/wrangler.json")).toBe(
      "20261101T125501Z"
    );
    expect(read("dist.bak-old/server/wrangler.json")).toBe("stray");
    const failed = readdirSync(web).filter((name) =>
      name.startsWith("dist.failed-")
    );
    expect(failed).toHaveLength(1);
    expect(read(`${failed[0]}/server/wrangler.json`)).toBe("new");
  });

  it("reports the web app as down when the rollback also fails", () => {
    setup({ health: "root=000 dashboard=000  active=failed\n" });
    const result = run();
    expect(result.status).toBe(6);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("vertex-web is down");
  });

  it("alerts when a container start time changed", () => {
    setup({
      "starts.2": STARTS_AFTER.replace(
        "2026-10-31T17:52:12Z",
        "2026-11-01T15:10:01Z"
      ),
    });
    const result = run();
    expect(result.status).toBe(7);
    expect(result.stdout).toContain("START TIME CHANGED");
    expect(result.stdout).toContain(
      "/ibkr-nautilus-exec-node-ib-gateway-1 started 2026-10-31T17:52:12Z -> 2026-11-01T15:10:01Z"
    );
    expect(result.alerts).toHaveLength(1);
  });

  it("alerts when a baseline container is missing after the restart", () => {
    setup({ "starts.2": "vertex-web Sun 2026-11-01 15:10:00 UTC\n" });
    const result = run();
    expect(result.status).toBe(7);
    expect(result.stdout).toContain(
      "/ibkr-nautilus-exec-node-ib-gateway-1 missing"
    );
  });

  it("ignores one-off compose run containers that appear or vanish", () => {
    setup({
      starts: `${STARTS}/ibkr-nautilus-exec-node-nautilus-trader-run-063ddc8f4c24 2026-11-01T14:23:40Z\n`,
      "starts.2": `${STARTS_AFTER}/ibkr-nautilus-exec-node-nautilus-trader-run-abc123 2026-11-01T15:10:02Z\n`,
    });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "protected containers: start times unchanged"
    );
    expect(result.alerts).toEqual([]);
  });

  it("reports a failed start-time check without a container alert", () => {
    setup({ "starts.2": "", "starts.2.fail": "" });
    const result = run();
    expect(result.status).toBe(7);
    expect(result.stdout).toContain("start-time check FAILED");
    expect(result.alerts).toEqual([]);
  });

  it("exits at once when another waiter holds the lock", () => {
    setup({});
    const holder = spawnSync(
      "bash",
      [
        "-c",
        `exec 9>"$1"; flock -n 9 && bash "$2"`,
        "_",
        join(dir, "lock"),
        script,
      ],
      {
        encoding: "utf8",
        env: {
          FAKE_DIR: dir,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          VERTEX_RESTART_LOCK: join(dir, "lock"),
          VERTEX_WEB_SSH: join(dir, "fake.sh"),
        },
      }
    );
    expect(holder.status).toBe(8);
    expect(holder.stdout).toContain(
      "NOT RESTARTED: another vertex-web restart waiter is active"
    );
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("reports a lock file it cannot open as a failed run, never as another waiter", () => {
    setup({});
    // A directory cannot be opened for writing (EISDIR), also as root.
    const result = run([], { VERTEX_RESTART_LOCK: dir });
    expect(result.status).toBe(11);
    expect(result.stdout).toContain(
      `NOT RESTARTED: cannot open lock file ${dir}: Is a directory`
    );
    expect(result.stdout).not.toContain("another vertex-web restart waiter");
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("reports any other flock failure as a failed run", () => {
    setup({});
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/flock"), "#!/usr/bin/env bash\nexit 65\n");
    chmodSync(join(dir, "bin/flock"), 0o755);
    const result = run();
    expect(result.status).toBe(11);
    expect(result.stdout).toContain(
      `NOT RESTARTED: cannot lock ${join(dir, "lock")} (flock exit 65)`
    );
    expect(existsSync(join(dir, "calls"))).toBe(false);
  });

  it("rejects unknown arguments and a malformed backup timestamp", () => {
    setup({});
    expect(run(["--now"]).status).toBe(2);
    expect(run(["--backup", "latest"]).status).toBe(2);
  });
});

// A real git history for the version guard: base <- mid <- tip, plus a side branch from base.
// Hermetic git: no global or system config, so no global core.hooksPath hooks run on each
// commit (they made this fixture 10x slower on a loaded rig and timed tests out).
const gitRepo = () => {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...HERMETIC_GIT,
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_AUTHOR_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
      },
    }).stdout.trim();
  git("init", "-q", "-b", "main");
  const commit = (msg: string) => {
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base");
  const mid = commit("mid");
  const tip = commit("tip");
  git("checkout", "-q", "-b", "side", base);
  const side = commit("side");
  return { base, mid, repo, side, tip };
};

// Real git and bash subprocesses: the 30 s budget is for a loaded rig (load average ~75 timed out
// at the 5 s default in pre-push on 2026-11-03), not a correctness threshold.
describe("version guard", { timeout: 30_000 }, () => {
  it("refuses an ancestor of the deployed SHA with no restart", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.mid}\ndeployed ${g.tip}\n`);
    const result = run([], { VERTEX_DEPLOY_GIT_DIR: g.repo });
    expect(result.status).toBe(9);
    expect(result.stdout).toContain("is OLDER than deployed");
    expect(result.calls).not.toContain("restart");
    expect(result.calls).not.toContain("probe");
    expect(result.calls).not.toContain("record");
  });

  it("passes a descendant and records the new SHA after the restart", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.tip}\ndeployed ${g.base}\n`);
    const result = run([], { VERTEX_DEPLOY_GIT_DIR: g.repo });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("restart");
    expect(result.calls.at(-1)).toBe("record");
  });

  it("passes an equal SHA, also as a short SHA", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(
      join(dir, "shas"),
      `new ${g.tip.slice(0, 8)}\ndeployed ${g.tip}\n`
    );
    expect(run([], { VERTEX_DEPLOY_GIT_DIR: g.repo }).status).toBe(0);
  });

  it("passes a build on a diverged branch (not an ancestor)", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.side}\ndeployed ${g.tip}\n`);
    expect(run([], { VERTEX_DEPLOY_GIT_DIR: g.repo }).status).toBe(0);
  });

  it("passes an ancestor with --allow-older and prints the reason", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.base}\ndeployed ${g.tip}\n`);
    const result = run(["--allow-older", "rollback after bad build"], {
      VERTEX_DEPLOY_GIT_DIR: g.repo,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "allowed by --allow-older: rollback after bad build"
    );
    expect(result.calls).toContain("restart");
  });

  it("refuses an unknown deployed SHA unless --allow-older is given", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.tip}\ndeployed none\n`);
    const refused = run([], { VERTEX_DEPLOY_GIT_DIR: g.repo });
    expect(refused.status).toBe(9);
    expect(refused.stdout).toContain("deployed SHA unknown");
    expect(refused.calls).not.toContain("restart");
    rmSync(join(dir, "calls"));
    expect(
      run(["--allow-older", "first recorded deploy"], {
        VERTEX_DEPLOY_GIT_DIR: g.repo,
      }).status
    ).toBe(0);
  });

  it("refuses an unknown new SHA and a SHA missing from the checkout", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new none\ndeployed ${g.tip}\n`);
    expect(run([], { VERTEX_DEPLOY_GIT_DIR: g.repo }).status).toBe(9);
    writeFileSync(
      join(dir, "shas"),
      `new ${"f".repeat(40)}\ndeployed ${g.tip}\n`
    );
    const missing = run([], { VERTEX_DEPLOY_GIT_DIR: g.repo });
    expect(missing.status).toBe(9);
    expect(missing.stdout).toContain("a commit is missing");
  });

  it("dry run reports a refusal without exiting 9", () => {
    setup({});
    const g = gitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.mid}\ndeployed ${g.tip}\n`);
    const result = run(["--dry-run"], { VERTEX_DEPLOY_GIT_DIR: g.repo });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("version guard would refuse:");
  });

  it("refuses when dist changes during the idle wait", () => {
    setup({
      shas: "new abc1234\ndeployed abc1234\n",
      "shas.2": "new def5678\ndeployed abc1234\n",
    });
    const result = run();
    expect(result.status).toBe(9);
    expect(result.stdout).toContain("changed during the idle wait");
    expect(result.calls).not.toContain("restart");
  });

  it("rejects --allow-older without a reason", () => {
    setup({});
    expect(run(["--allow-older"]).status).toBe(2);
    expect(run(["--allow-older", "--dry-run"]).status).toBe(2);
  });

  it("reads real SHA files and records only the checked SHA", () => {
    setup({ real: "" });
    const g = gitRepo();
    const web = join(dir, "web");
    const put = (path: string, body: string) => {
      mkdirSync(join(web, path, ".."), { recursive: true });
      writeFileSync(join(web, path), body);
    };
    put("dist/DEPLOYED_SHA", `${g.tip}\n`);
    put("DEPLOYED_SHA", `${g.base}\n`);
    writeFileSync(
      join(dir, "fake.sh"),
      FAKE.replace("gate|candidate|restart|rollback)", "shas|record)")
    );
    const ok = run([], { VERTEX_DEPLOY_GIT_DIR: g.repo, VERTEX_WEB_DIR: web });
    expect(ok.status).toBe(0);
    expect(ok.syntax).toEqual([]);
    expect(ok.stdout).toContain(`recorded DEPLOYED_SHA ${g.tip}`);
    expect(readFileSync(join(web, "DEPLOYED_SHA"), "utf8").trim()).toBe(g.tip);
    rmSync(join(web, "DEPLOYED_SHA"));
    rmSync(join(dir, "calls"));
    const unknown = run([], {
      VERTEX_DEPLOY_GIT_DIR: g.repo,
      VERTEX_WEB_DIR: web,
    });
    expect(unknown.status).toBe(9);
    expect(unknown.stdout).toContain(
      "deployed SHA unknown (DEPLOYED_SHA: none)"
    );
    expect(unknown.stdout).toContain("restore dist.bak-<TS>");
  });

  it("does not record when the health check gets no answer", () => {
    setup({ health: "", "health.fail": "" });
    const result = run();
    expect(result.status).toBe(6);
    expect(result.calls).not.toContain("record");
  });

  it("records the restored SHA after a rollback (real commands)", () => {
    setup({
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      real: "",
    });
    const web = join(dir, "web");
    const put = (path: string, body: string) => {
      mkdirSync(join(web, path, ".."), { recursive: true });
      writeFileSync(join(web, path), body);
    };
    put("dist/server/wrangler.json", "new");
    put("dist/DEPLOYED_SHA", "abc1234\n");
    put(".wrangler/deploy/config.json", "new");
    put("dist.bak-20261101T125501Z/server/wrangler.json", "old");
    put("dist.bak-20261101T125501Z/DEPLOYED_SHA", "0ld0000\n");
    put(".wrangler.bak-20261101T125501Z/deploy/config.json", "old");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/systemctl"), "#!/usr/bin/env bash\n");
    chmodSync(join(dir, "bin/systemctl"), 0o755);
    // record is not a "real" call in the fake, so run it here as the fake would.
    writeFileSync(
      join(dir, "fake.sh"),
      FAKE.replace(
        "gate|candidate|restart|rollback)",
        "gate|candidate|restart|rollback|record)"
      )
    );
    const result = run([], { VERTEX_WEB_DIR: web });
    expect(result.status).toBe(5);
    expect(result.syntax).toEqual([]);
    expect(readFileSync(join(web, "DEPLOYED_SHA"), "utf8")).toBe("0ld0000\n");
  });
});
