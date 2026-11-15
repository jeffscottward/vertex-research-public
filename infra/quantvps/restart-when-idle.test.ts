import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
// `bash -n`. With a <dir>/real file, gate, candidate, restart, unswap and rollback run for real
// against VERTEX_WEB_DIR, with a systemctl stub on PATH; a <dir>/real-runtime file adds runtime.
// Without a runtime answer file, the runtime tree is at the new build SHA of the shas answer, so
// the runtime guard passes with no swap.
const FAKE = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$FAKE_DIR/calls"
# The worker pause file as each probe saw it (the idle wait).
if [ "$name" = probe ] && [ -f "\${VERTEX_WORKER_PAUSE_FILE:-/nonexistent}" ]; then cp "$VERTEX_WORKER_PAUSE_FILE" "$FAKE_DIR/pause-seen"; fi
bash -n -c "$cmd" 2>>"$FAKE_DIR/syntax" || { echo "$name" >>"$FAKE_DIR/syntax"; exit 97; }
n=$(grep -cx "$name" "$FAKE_DIR/calls")
case "$name" in restart|rollback) printf '%s\\n' "\${cmd//$'\\n'/ }" >>"$FAKE_DIR/commands" ;; esac
[ -f "$FAKE_DIR/$name.stderr" ] && cat "$FAKE_DIR/$name.stderr" >&2
if [ -f "$FAKE_DIR/real" ]; then
  case "$name" in gate|candidate|restart|rollback) exec bash -c "$cmd" ;; esac
  if [ "$name" = unswap ]; then exec bash -c "$cmd"; fi
  if [ "$name" = runtime ] && [ -f "$FAKE_DIR/real-runtime" ]; then exec bash -c "$cmd"; fi
fi
if [ "$name" = runtime ] && [ ! -f "$FAKE_DIR/runtime" ] && [ ! -f "$FAKE_DIR/runtime.$n" ] && [ ! -f "$FAKE_DIR/runtime.fail" ]; then
  sed -n 's/^new /live /p' "$FAKE_DIR/shas"; echo "staged none"; echo "incomplete none"; exit 0
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
      VERTEX_WORKER_PAUSE_FILE: join(dir, "state", "worker.pause"),
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
    pauseLeft: existsSync(join(dir, "state", "worker.pause")),
    pauseSeen: read("pause-seen"),
    signal: result.signal,
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

  it("pauses the worker during the idle wait and removes the pause file on exit", () => {
    setup({ "probe.1": BUSY, "probe.2": IDLE });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.pauseSeen[0]).toMatch(/^pid \d+$/u);
    expect(result.pauseSeen[1]).toMatch(
      /^since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u
    );
    expect(result.stdout).toContain("worker paused: ");
    expect(result.pauseLeft).toBe(false);
  });

  it("removes the pause file when it gives up, when dist changes and on SIGTERM", () => {
    setup({ probe: BUSY });
    const gaveUp = run([], { VERTEX_RESTART_GIVE_UP_AFTER: "0" });
    expect(gaveUp.status).toBe(4);
    expect(gaveUp.pauseSeen).toHaveLength(2);
    expect(gaveUp.pauseLeft).toBe(false);
    setup({ "shas.2": "new def5678\ndeployed abc1234\n" });
    const changed = run();
    expect(changed.status).toBe(9);
    expect(changed.pauseSeen).toHaveLength(2);
    expect(changed.pauseLeft).toBe(false);
    // Stopped while it waits for idle: the TERM trap exits through the EXIT trap.
    setup({ probe: BUSY });
    const started = Date.now();
    const stopped = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...HERMETIC_GIT,
        FAKE_DIR: dir,
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        VERTEX_RESTART_ALERT: join(dir, "alert.sh"),
        VERTEX_RESTART_LOCK: join(dir, "lock"),
        VERTEX_RESTART_POLL: "0.2",
        VERTEX_WEB_SSH: join(dir, "fake.sh"),
        VERTEX_WORKER_PAUSE_FILE: join(dir, "state", "worker.pause"),
      },
      killSignal: "SIGTERM",
      timeout: 2000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stopped.status).toBe(143);
    expect(existsSync(join(dir, "pause-seen"))).toBe(true);
    expect(existsSync(join(dir, "state", "worker.pause"))).toBe(false);
  });

  it("does not pause the worker before the gates pass, and a dry run leaves the file alone", () => {
    setup({ gate: "missing\n" });
    const gate = run();
    expect(gate.status).toBe(3);
    expect(gate.pauseLeft).toBe(false);
    setup({});
    mkdirSync(join(dir, "state"));
    writeFileSync(join(dir, "state", "worker.pause"), "pid 1\n");
    const dry = run(["--dry-run"]);
    expect(dry.status).toBe(0);
    // Neither rewritten nor removed.
    expect(dry.pauseSeen).toEqual(["pid 1"]);
    expect(readFileSync(join(dir, "state", "worker.pause"), "utf8")).toBe(
      "pid 1\n"
    );
  });

  it("warns and still restarts when the pause file cannot be written", () => {
    setup({});
    writeFileSync(join(dir, "state"), "a file, not a directory");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "warning: cannot write the worker pause file"
    );
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
      join(dir, "runtime"),
      `live ${g.tip}\nstaged none\nincomplete none\n`
    );
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

// Runtime tree: tracked files and node_modules of the checkout on QuantVPS (RUNTIME_SHA names
// their commit). The guard runs after the version guard; a stage for the new build is swapped in
// by the restart command and swapped back by the rollback command.
describe("runtime guard and swap", () => {
  const BUILD = "abc1234";
  const stubSystemctl = () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/systemctl"),
      `#!/usr/bin/env bash\necho "$*" >>"${join(dir, "systemctl")}"\n`
    );
    chmodSync(join(dir, "bin/systemctl"), 0o755);
  };
  // A checkout with a live runtime tree at "0ld0000", server-side state, and a complete stage
  // for BUILD. Returns helpers bound to the checkout root.
  const checkout = () => {
    const root = join(dir, "checkout");
    const put = (path: string, body: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    const read = (path: string) => readFileSync(join(root, path), "utf8");
    put("RUNTIME_SHA", "0ld0000\n");
    put("package.json", "old");
    put("node_modules/.pnpm/a@1/index.js", "a1");
    put("packages/ui/package.json", "old ui");
    put("apps/web/vite.config.ts", "old config");
    put("apps/web/node_modules/.keep", "old links");
    put("apps/web/dist/server/wrangler.json", "new build");
    put("apps/web/dist/DEPLOYED_SHA", `${BUILD}\n`);
    put("apps/web/.wrangler/deploy/config.json", "new build");
    put("apps/web/dist.bak-20261101T125501Z/server/wrangler.json", "old build");
    put("apps/web/.wrangler.bak-20261101T125501Z/deploy/config.json", "old");
    put("apps/web/DEPLOYED_SHA", "0ld0000\n");
    put("private/basic-app-named/.prod.vars", "server only");
    put(".runtime-next/RUNTIME_SHA", `${BUILD}\n`);
    put(".runtime-next/package.json", "new");
    put(".runtime-next/node_modules/.pnpm/a@2/index.js", "a2");
    put(".runtime-next/packages/ui/package.json", "new ui");
    put(".runtime-next/licenses/NOTICE", "new unit");
    // A tracked link whose target does not exist on this host is still a unit.
    symlinkSync("missing-old", join(root, "CLAUDE.md"));
    symlinkSync("missing-new", join(root, ".runtime-next/CLAUDE.md"));
    put(".runtime-next/apps/web/vite.config.ts", "new config");
    put(".runtime-next/apps/web/node_modules/.keep", "new links");
    put(
      ".runtime-next/PATHS",
      [
        "package.json",
        "packages",
        "licenses",
        "CLAUDE.md",
        "node_modules",
        "apps/web/vite.config.ts",
        "apps/web/node_modules",
        "RUNTIME_SHA",
      ]
        .join("\n")
        .concat("\n")
    );
    const dirs = (prefix: string) =>
      readdirSync(root).filter((name) => name.startsWith(prefix));
    return { dirs, put, read, root, web: join(root, "apps/web") };
  };

  it("restarts with no swap when the runtime tree is at the new build", () => {
    setup({});
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `runtime: live runtime tree is at build ${BUILD}`
    );
    expect(result.commands[0]).not.toContain("swap_paths");
    expect(result.calls.indexOf("runtime")).toBeGreaterThan(
      result.calls.indexOf("shas")
    );
  });

  it("refuses when the runtime tree is at another commit and no stage exists", () => {
    setup({ runtime: "live 0ld0000\nstaged none\nincomplete none\n" });
    const result = run();
    expect(result.status).toBe(12);
    expect(result.stdout).toContain("NOT RESTARTED: runtime guard:");
    expect(result.stdout).toContain(
      "Run infra/quantvps/stage-runtime.sh in the build worktree"
    );
    expect(result.calls).not.toContain("probe");
    expect(result.calls).not.toContain("restart");
    expect(result.pauseLeft).toBe(false);
  });

  it("refuses a stage for another build, a failed read and an unfinished swap", () => {
    setup({ runtime: "live 0ld0000\nstaged def5678\nincomplete none\n" });
    expect(run().status).toBe(12);
    writeFileSync(join(dir, "runtime"), "");
    const silent = run();
    expect(silent.status).toBe(12);
    expect(silent.stdout).toContain("no answer from QuantVPS");
    writeFileSync(
      join(dir, "runtime"),
      `live ${BUILD}\nstaged none\nincomplete .runtime-bak-20261115T101500Z\n`
    );
    const unfinished = run();
    expect(unfinished.status).toBe(12);
    expect(unfinished.stdout).toContain(
      ".runtime-bak-20261115T101500Z has no COMPLETE file"
    );
    expect(unfinished.calls).not.toContain("restart");
  });

  it("restarts on a stale runtime tree only with --allow-stale-runtime, and alerts", () => {
    setup({ runtime: "live 0ld0000\nstaged none\nincomplete none\n" });
    const result = run(["--allow-stale-runtime", "disk gate, urgent fix"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "runtime: WARNING guard skipped (runtime tree at 0ld0000, build abc1234): disk gate, urgent fix"
    );
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("runtime guard skipped");
    expect(result.commands[0]).not.toContain("swap_paths");
    // The override never covers an unfinished swap or a failed read.
    writeFileSync(
      join(dir, "runtime"),
      "live 0ld0000\nstaged none\nincomplete .runtime-failed-20261115T101500Z\n"
    );
    expect(run(["--allow-stale-runtime", "x"]).status).toBe(12);
    expect(run(["--allow-stale-runtime"]).status).toBe(2);
  });

  it("dry run prints the runtime state and the guard decision", () => {
    setup({ runtime: "live 0ld0000\nstaged none\nincomplete none\n" });
    const refused = run(["--dry-run"]);
    expect(refused.stdout).toContain("runtime guard would refuse:");
    expect(refused.calls).not.toContain("restart");
    expect(refused.alerts).toEqual([]);
    writeFileSync(
      join(dir, "runtime"),
      `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`
    );
    expect(run(["--dry-run"]).stdout).toContain(
      `runtime: the staged tree of build ${BUILD} will be swapped in at the restart (live: 0ld0000)`
    );
  });

  it("swaps the staged runtime tree in with the restart (real commands)", () => {
    setup({ real: "", "real-runtime": "" });
    stubSystemctl();
    const c = checkout();
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    expect(result.systemctl).toEqual(["restart vertex-web"]);
    expect(result.stdout).toContain(
      "swapped 8 paths: .runtime-next -> live, live -> .runtime-bak-"
    );
    expect(result.stdout).toContain(`runtime: files of ${BUILD} are live`);
    expect(c.read("RUNTIME_SHA")).toBe(`${BUILD}\n`);
    expect(c.read("package.json")).toBe("new");
    expect(c.read("node_modules/.pnpm/a@2/index.js")).toBe("a2");
    expect(existsSync(join(c.root, "node_modules/.pnpm/a@1"))).toBe(false);
    expect(c.read("packages/ui/package.json")).toBe("new ui");
    expect(c.read("licenses/NOTICE")).toBe("new unit");
    expect(c.read("apps/web/vite.config.ts")).toBe("new config");
    expect(c.read("apps/web/node_modules/.keep")).toBe("new links");
    expect(readlinkSync(join(c.root, "CLAUDE.md"))).toBe("missing-new");
    // Server-side state stays in place.
    expect(c.read("apps/web/dist/server/wrangler.json")).toBe("new build");
    expect(c.read("private/basic-app-named/.prod.vars")).toBe("server only");
    const [bak] = c.dirs(".runtime-bak-");
    expect(c.dirs(".runtime-bak-")).toHaveLength(1);
    expect(c.read(`${bak}/RUNTIME_SHA`)).toBe("0ld0000\n");
    expect(c.read(`${bak}/node_modules/.pnpm/a@1/index.js`)).toBe("a1");
    expect(c.read(`${bak}/apps/web/vite.config.ts`)).toBe("old config");
    expect(readlinkSync(join(c.root, `${bak}/CLAUDE.md`))).toBe("missing-old");
    expect(existsSync(join(c.root, `${bak}/COMPLETE`))).toBe(true);
    // The used stage is no longer complete: a second run has nothing to swap.
    expect(existsSync(join(c.root, ".runtime-next/RUNTIME_SHA"))).toBe(false);
    rmSync(join(dir, "calls"));
    const again = run([], { VERTEX_WEB_DIR: c.web });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(
      `runtime: live runtime tree is at build ${BUILD}`
    );
    expect(c.dirs(".runtime-bak-")).toHaveLength(1);
  });

  it("moves the old runtime tree back when the health check fails (real commands)", () => {
    setup({
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      real: "",
      "real-runtime": "",
    });
    stubSystemctl();
    const c = checkout();
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(5);
    expect(result.syntax).toEqual([]);
    expect(result.systemctl).toEqual([
      "restart vertex-web",
      "restart vertex-web",
    ]);
    expect(c.read("RUNTIME_SHA")).toBe("0ld0000\n");
    expect(c.read("package.json")).toBe("old");
    expect(c.read("node_modules/.pnpm/a@1/index.js")).toBe("a1");
    expect(c.read("apps/web/vite.config.ts")).toBe("old config");
    // A unit that the old tree did not have is moved out, with nothing put in its place.
    expect(existsSync(join(c.root, "licenses"))).toBe(false);
    expect(c.read("apps/web/dist/server/wrangler.json")).toBe("old build");
    const [failed] = c.dirs(".runtime-failed-");
    expect(c.read(`${failed}/package.json`)).toBe("new");
    expect(c.read(`${failed}/licenses/NOTICE`)).toBe("new unit");
    expect(c.read(`${failed}/RUNTIME_SHA`)).toBe(`${BUILD}\n`);
    expect(existsSync(join(c.root, `${failed}/COMPLETE`))).toBe(true);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain(
      "Runtime files of the previous deploy were restored"
    );
    expect(result.stdout).toContain("rolled back to 20261101T125501Z");
  });

  it("puts finished paths back and does not restart when a move fails (real commands)", () => {
    setup({ real: "", "real-runtime": "", "starts.2": STARTS });
    stubSystemctl();
    const c = checkout();
    // `licenses` is a file in the live tree's way of the staged `licenses/NOTICE` parent: the
    // staged unit `licenses` is fine, so block a nested path instead.
    c.put(".runtime-next/apps/web/blocked/file", "x");
    c.put("apps/web/blocked", "a file where the parent directory must be");
    writeFileSync(
      join(c.root, ".runtime-next/PATHS"),
      "package.json\nnode_modules\napps/web/blocked/file\nRUNTIME_SHA\n"
    );
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.systemctl).toEqual([]);
    expect(result.stdout).toContain(
      "swap: move failed at apps/web/blocked/file"
    );
    expect(result.stdout).toContain(
      "runtime: The runtime tree was not swapped."
    );
    expect(c.read("RUNTIME_SHA")).toBe("0ld0000\n");
    expect(c.read("package.json")).toBe("old");
    expect(c.read("node_modules/.pnpm/a@1/index.js")).toBe("a1");
    expect(c.read(".runtime-next/package.json")).toBe("new");
    const [bak] = c.dirs(".runtime-bak-");
    expect(existsSync(join(c.root, `${bak}/UNDONE`))).toBe(true);
    expect(existsSync(join(c.root, `${bak}/COMPLETE`))).toBe(false);
    // A swap that was put back is not an unfinished swap: the next guard run is a normal refusal
    // or swap, not the repair refusal.
    rmSync(join(dir, "calls"));
    const next = run(["--dry-run"], { VERTEX_WEB_DIR: c.web });
    expect(next.stdout).not.toContain("did not finish");
  });

  it("refuses unsafe or missing paths before any move (real commands)", () => {
    for (const paths of [
      "package.json\n../outside\n",
      "/etc/passwd\n",
      "package.json\nnot-staged\n",
    ]) {
      setup({ real: "", "real-runtime": "", "starts.2": STARTS });
      stubSystemctl();
      const c = checkout();
      writeFileSync(join(c.root, ".runtime-next/PATHS"), paths);
      const result = run([], { VERTEX_WEB_DIR: c.web });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("swap: ");
      expect(result.systemctl).toEqual([]);
      expect(c.read("package.json")).toBe("old");
      expect(c.dirs(".runtime-bak-")).toEqual([]);
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("moves the saved tree back when the swap ran and the unit did not restart (real commands)", () => {
    setup({ real: "", "real-runtime": "", "starts.2": STARTS });
    stubSystemctl();
    const c = checkout();
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.calls).toContain("unswap");
    expect(result.stdout).toContain("runtime: swapped 8 paths: .runtime-bak-");
    expect(result.stdout).toContain("ActiveEnterTimestamp did not change");
    expect(c.read("RUNTIME_SHA")).toBe("0ld0000\n");
    expect(c.read("package.json")).toBe("old");
    expect(c.read("node_modules/.pnpm/a@1/index.js")).toBe("a1");
    const [failed] = c.dirs(".runtime-failed-");
    expect(c.read(`${failed}/package.json`)).toBe("new");
  });

  it("does not swap a stage that changed after the guard (real commands)", () => {
    setup({
      real: "",
      runtime: `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`,
      "starts.2": STARTS,
    });
    stubSystemctl();
    const c = checkout();
    c.put(".runtime-next/RUNTIME_SHA", "def5678\n");
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "swap: the staged runtime tree changed after the guard"
    );
    expect(result.systemctl).toEqual([]);
    expect(result.calls).not.toContain("unswap");
    expect(c.read("package.json")).toBe("old");
    expect(c.dirs(".runtime-bak-")).toEqual([]);
  });

  it("accepts a short build SHA for a stage with the full name", () => {
    setup({
      restart:
        "swapped 8 paths: .runtime-next -> live, live -> .runtime-bak-X\n",
      runtime: `live 0ld0000\nstaged ${BUILD}def5678abc1234def5678abc1234def56\nincomplete none\n`,
    });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.commands[0]).toContain(
      `= '${BUILD}def5678abc1234def5678abc1234def56' ]`
    );
    expect(result.stdout).toContain(`runtime: files of ${BUILD} are live`);
  });

  it("reports the runtime state in the alert when the rollback does not restore it", () => {
    const staged = `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`;
    const swapped =
      "swapped 8 paths: .runtime-next -> live, live -> .runtime-bak-X\n";
    // The swap back failed inside the rollback command.
    setup({
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      restart: swapped,
      rollback: "warning: runtime files were not restored\n",
      runtime: staged,
    });
    const notRestored = run();
    expect(notRestored.status).toBe(5);
    expect(notRestored.alerts[0]).toContain("Runtime files were NOT restored");
    rmSync(dir, { force: true, recursive: true });
    // The rollback command gave no answer (lost connection): the state is unknown, not "not swapped".
    setup({
      health: "root=502 dashboard=000  active=active\n",
      restart: swapped,
      "rollback.fail": "",
      runtime: staged,
    });
    const silent = run();
    expect(silent.status).toBe(6);
    expect(silent.alerts[0]).toContain("vertex-web is down");
    expect(silent.alerts[0]).toContain("Runtime tree state unknown");
    rmSync(dir, { force: true, recursive: true });
    // The restart command gave no answer either: unknown as well.
    setup({
      health: "",
      "health.fail": "",
      "restart.fail": "",
      runtime: staged,
    });
    const lost = run();
    expect(lost.status).toBe(6);
    expect(lost.alerts[0]).toContain("Runtime tree state unknown");
  });

  it("leaves an unfinished swap visible when the undo fails, and alerts (real commands)", () => {
    setup({ real: "", "real-runtime": "", "starts.2": STARTS });
    stubSystemctl();
    // An mv that fails for the argument lists named in <dir>/mv-fail (one per line).
    writeFileSync(
      join(dir, "bin/mv"),
      `#!/usr/bin/env bash\nwhile IFS= read -r pattern; do [[ "$*" == "$pattern" ]] && exit 1; done <"${join(dir, "mv-fail")}"\nPATH=/usr/bin:/bin exec mv "$@"\n`
    );
    chmodSync(join(dir, "bin/mv"), 0o755);
    writeFileSync(
      join(dir, "mv-fail"),
      "-T .runtime-next/node_modules node_modules\n-T package.json .runtime-next/package.json\n"
    );
    const c = checkout();
    writeFileSync(
      join(c.root, ".runtime-next/PATHS"),
      "package.json\nnode_modules\nRUNTIME_SHA\n"
    );
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.systemctl).toEqual([]);
    expect(result.stdout).toContain("swap: move failed at node_modules");
    expect(result.stdout).toContain("swap: the undo did not finish");
    expect(result.stdout).toContain("runtime: WARNING the swap back failed.");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("runtime swap back failed");
    expect(result.alerts[0]).toContain("Runtime tree state unknown");
    // The saved packages are back; the first unit could not be put back and stays swapped.
    expect(c.read("node_modules/.pnpm/a@1/index.js")).toBe("a1");
    expect(c.read("package.json")).toBe("new");
    const [bak] = c.dirs(".runtime-bak-");
    expect(c.read(`${bak}/package.json`)).toBe("old");
    expect(existsSync(join(c.root, `${bak}/UNDONE`))).toBe(false);
    expect(existsSync(join(c.root, `${bak}/COMPLETE`))).toBe(false);
    // The next run refuses until the directory is repaired.
    rmSync(join(dir, "calls"));
    const next = run([], { VERTEX_WEB_DIR: c.web });
    expect(next.status).toBe(12);
    expect(next.stdout).toContain(`${bak} has no COMPLETE file`);
    expect(next.calls).not.toContain("restart");
  });

  it("swaps back when the unit did not restart, also when a container start time changed", () => {
    setup({
      restart:
        "swapped 8 paths: .runtime-next -> live, live -> .runtime-bak-X\n",
      runtime: `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`,
      "starts.2": STARTS.replace("17:52:12Z", "18:00:00Z"),
      unswap:
        "swapped 8 paths: .runtime-bak-X -> live, live -> .runtime-failed-X\n",
    });
    const result = run();
    expect(result.status).toBe(3);
    expect(result.calls).toContain("unswap");
    expect(result.calls).not.toContain("record");
    expect(result.stdout).toContain("runtime: swapped 8 paths: .runtime-bak-X");
    expect(result.stdout).toContain("ActiveEnterTimestamp did not change");
  });

  it("warns and alerts when the unit restarted and the swap gave no answer", () => {
    setup({
      restart: "",
      runtime: `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`,
    });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "runtime: WARNING Runtime tree state unknown"
    );
    expect(result.stdout).not.toContain(`runtime: files of ${BUILD} are live`);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("needs a check");
  });

  it("names the swapped runtime tree when the health check gets no answer", () => {
    setup({
      health: "",
      "health.fail": "",
      restart:
        "swapped 8 paths: .runtime-next -> live, live -> .runtime-bak-X\n",
      runtime: `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`,
    });
    const result = run();
    expect(result.status).toBe(6);
    expect(result.commands[0]).toContain(
      "swap_paths .runtime-next .runtime-bak-"
    );
    expect(result.commands[0]).toContain("&& systemctl restart vertex-web");
    expect(result.calls).not.toContain("rollback");
    expect(result.alerts[0]).toContain(
      `Runtime files of ${BUILD} stay swapped in (previous: .runtime-bak-`
    );
  });
});
