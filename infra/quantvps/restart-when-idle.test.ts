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
// against VERTEX_WEB_DIR, with a systemctl stub on PATH; a <dir>/real-runtime file adds runtime,
// and a <dir>/real-build file adds stage, shas and record. Without a stage answer file, no build
// is staged. Each probe appends the content of dist/server/wrangler.json to <dir>/probe-dist.
// Without a runtime answer file, the runtime tree is at the new build SHA of the shas answer, so
// the runtime guard passes with no swap.
const FAKE = `#!/usr/bin/env bash
cmd="$1"; name="\${cmd#: }"; name="\${name%%;*}"
echo "$name" >>"$FAKE_DIR/calls"
# The worker pause file as each probe saw it (the idle wait).
if [ "$name" = probe ] && [ -f "\${VERTEX_WORKER_PAUSE_FILE:-/nonexistent}" ]; then cp "$VERTEX_WORKER_PAUSE_FILE" "$FAKE_DIR/pause-seen"; fi
# The build that dist held at each probe (the idle wait).
if [ "$name" = probe ] && [ -f "\${VERTEX_WEB_DIR:-/nonexistent}/dist/server/wrangler.json" ]; then
  echo "$(cat "$VERTEX_WEB_DIR/dist/server/wrangler.json")" >>"$FAKE_DIR/probe-dist"
fi
bash -n -c "$cmd" 2>>"$FAKE_DIR/syntax" || { echo "$name" >>"$FAKE_DIR/syntax"; exit 97; }
n=$(grep -cx "$name" "$FAKE_DIR/calls")
case "$name" in restart|rollback) printf '%s\\n' "\${cmd//$'\\n'/ }" >>"$FAKE_DIR/commands" ;; esac
[ -f "$FAKE_DIR/$name.stderr" ] && cat "$FAKE_DIR/$name.stderr" >&2
if [ -f "$FAKE_DIR/real" ]; then
  case "$name" in gate|candidate|restart|rollback) exec bash -c "$cmd" ;; esac
  if [ "$name" = unswap ]; then exec bash -c "$cmd"; fi
  if [ "$name" = runtime ] && [ -f "$FAKE_DIR/real-runtime" ]; then exec bash -c "$cmd"; fi
  if [ -f "$FAKE_DIR/real-build" ]; then case "$name" in stage|shas|record) exec bash -c "$cmd" ;; esac; fi
fi
if [ "$name" = stage ] && [ ! -f "$FAKE_DIR/stage" ] && [ ! -f "$FAKE_DIR/stage.$n" ] && [ ! -f "$FAKE_DIR/stage.fail" ]; then
  echo "staged none"; exit 0
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
  // A test can call setup more than once: remove the folder of the call before.
  if (dir) rmSync(dir, { force: true, recursive: true });
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
      // A Saturday: the market hours guard never depends on the time of the test run.
      VERTEX_DEPLOY_NY_TIME: "6 1200 EST",
      VERTEX_RESTART_ALERT: join(dir, "alert.sh"),
      // CI runners have bash 5.2, which the bash version guard refuses; see "bash version guard".
      VERTEX_RESTART_BASH_VERSION: "5.3",
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
    // Stopped while it waits for idle: the TERM trap exits through the EXIT trap. The first probe
    // sends the signal to the PID in the pause file. The script writes that file after it sets
    // its traps, so the signal cannot arrive before them, however slow the start is. With no
    // signal the script gives up at the first busy probe (limit 0) and exits with 4.
    setup({ probe: BUSY });
    writeFileSync(
      join(dir, "term-on-probe.sh"),
      `#!/usr/bin/env bash
"$FAKE_DIR/fake.sh" "$@" || exit
case "$1" in ": probe;"*) read -r _ pid <"$VERTEX_WORKER_PAUSE_FILE" && kill -TERM "$pid" ;; esac
`
    );
    chmodSync(join(dir, "term-on-probe.sh"), 0o755);
    const stopped = run([], {
      VERTEX_RESTART_GIVE_UP_AFTER: "0",
      VERTEX_WEB_SSH: join(dir, "term-on-probe.sh"),
    });
    // One object, so that a failure shows every field and the output of the script.
    expect({
      callsFromFirstProbe: stopped.calls.slice(stopped.calls.indexOf("probe")),
      pauseLeft: stopped.pauseLeft,
      pauseSeen: stopped.pauseSeen.length,
      signal: stopped.signal,
      status: stopped.status,
      stdout: stopped.stdout,
    }).toEqual({
      callsFromFirstProbe: ["probe"],
      pauseLeft: false,
      pauseSeen: 2,
      signal: null,
      status: 143,
      stdout: expect.stringContaining("worker paused: "),
    });
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

  it("accepts only a pair of directories as rollback source: no symlink, no file", () => {
    setup({ real: "" });
    const web = join(dir, "web");
    const put = (path: string, body: string) => {
      mkdirSync(join(web, path, ".."), { recursive: true });
      writeFileSync(join(web, path), body);
    };
    put("dist/server/wrangler.json", "live");
    put(".wrangler/deploy/config.json", "live");
    put("dist.bak-20261001T000000Z/server/wrangler.json", "oldest");
    put(".wrangler.bak-20261001T000000Z/deploy/config.json", "oldest");
    // Newest: dist.bak-<TS> is a symlink to a directory.
    symlinkSync(
      "dist.bak-20261001T000000Z",
      join(web, "dist.bak-20261103T000000Z")
    );
    put(".wrangler.bak-20261103T000000Z/deploy/config.json", "link half");
    // Next: dist.bak-<TS> is a file.
    put("dist.bak-20261102T000000Z", "a file");
    put(".wrangler.bak-20261102T000000Z/deploy/config.json", "file half");
    // Next: .wrangler.bak-<TS> is a symlink to a directory.
    put("dist.bak-20261101T125501Z/server/wrangler.json", "half");
    symlinkSync(
      ".wrangler.bak-20261001T000000Z",
      join(web, ".wrangler.bak-20261101T125501Z")
    );
    const result = run(["--dry-run"], { VERTEX_WEB_DIR: web });
    expect(result.syntax).toEqual([]);
    expect(result.stdout).toContain(
      "rollback source: 20261001T000000Z (dist.bak-<TS> + .wrangler.bak-<TS>)"
    );
    // A named backup that is no pair of directories is refused.
    const named = run(["--backup", "20261103T000000Z"], {
      VERTEX_WEB_DIR: web,
    });
    expect(named.status).toBe(3);
    expect(named.stdout).toContain("NOT RESTARTED: no rollback source");
    expect(named.calls).not.toContain("restart");
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
          VERTEX_DEPLOY_NY_TIME: "6 1200 EST",
          VERTEX_RESTART_BASH_VERSION: "5.3",
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

// Bash before 5.3 can lose a trapped stop signal that arrives while it parses a $(...), and can
// then leave the idle wait and restart (restart-when-idle.sh, "Bash version"). A real run refuses
// such a bash before it takes the lock or calls QuantVPS. The test hook VERTEX_RESTART_BASH_VERSION
// replaces the version that the script reads, so both answers are tested on every runner.
describe("bash version guard", () => {
  // The bash that run() starts: the same PATH as run().
  const runnerBash = () => {
    const [major = "", minor = "", full = ""] = spawnSync(
      "bash",
      ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]} $BASH_VERSION"'],
      {
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        },
      }
    )
      .stdout.trim()
      .split(" ");
    return {
      full,
      old: Number(major) < 5 || (Number(major) === 5 && Number(minor) < 3),
    };
  };
  const refusal = (shown: string) =>
    `NOT RESTARTED: bash ${shown} is older than 5.3. Bash before 5.3 can lose a stop signal (INT, TERM, HUP) in the idle wait and then restart vertex-web anyway (bash bug, fixed in 5.3); run this script with bash 5.3 or newer`;
  // Refused: only the expected lines, exit 2, and nothing done: no remote call, lock or pause file.
  const refused = (
    result: { pauseSeen: string[]; status: number | null; stdout: string },
    lines: string[]
  ) => {
    expect({
      calls: existsSync(join(dir, "calls")),
      lock: existsSync(join(dir, "lock")),
      pause: existsSync(join(dir, "state")),
      pauseSeen: result.pauseSeen,
      status: result.status,
      stdout: result.stdout,
    }).toEqual({
      calls: false,
      lock: false,
      pause: false,
      pauseSeen: [],
      status: 2,
      stdout: `${lines.join("\n")}\n`,
    });
  };

  // 5.2, 5.02 (minor 02 reads as 2) and 4.4: too old. 5, .3, x.y, 5.3.1 and 1234.1: not
  // <major>.<minor> with 1-3 digits each, so they count as too old (fail closed).
  it.each(["5.2", "5.02", "4.4", "5", ".3", "x.y", "5.3.1", "1234.1"])(
    "refuses a real run on bash %s: no lock, no pause file, no remote call",
    (version) => {
      setup({});
      refused(run([], { VERTEX_RESTART_BASH_VERSION: version }), [
        `bash version guard: test hook VERTEX_RESTART_BASH_VERSION=${version} replaces bash ${runnerBash().full}`,
        refusal(version),
      ]);
    }
  );

  it.each(["5.3", "5.10", "6.0", "05.3"])(
    "restarts as usual on bash %s",
    (version) => {
      setup({});
      const result = run([], { VERTEX_RESTART_BASH_VERSION: version });
      expect(result.status).toBe(0);
      expect(result.commands).toEqual([
        ": restart; systemctl restart vertex-web",
      ]);
      expect(result.stdout).toContain(
        `bash version guard: test hook VERTEX_RESTART_BASH_VERSION=${version} replaces bash `
      );
    }
  );

  it("allows a dry run and --decide on bash 5.2: they set no trap", () => {
    setup({});
    const dry = run(["--dry-run"], { VERTEX_RESTART_BASH_VERSION: "5.2" });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("decision: idle");
    expect(dry.stdout).toContain("dry run: no restart");
    expect(dry.stdout).not.toContain("NOT RESTARTED");
    const decided = spawnSync(
      "bash",
      [script, "--decide", fixture("idle-keepalive.txt"), "30"],
      {
        encoding: "utf8",
        env: { ...process.env, VERTEX_RESTART_BASH_VERSION: "5.2" },
      }
    );
    expect(decided.status).toBe(0);
    expect(decided.stdout.split("\n")[0]).toBe("idle");
  });

  it("reads the version of the bash that runs it when the hook is empty", () => {
    setup({});
    // CI (bash 5.2) checks the refusal, the rig (bash 5.3) the restart.
    const bash = runnerBash();
    const result = run([], { VERTEX_RESTART_BASH_VERSION: "" });
    if (bash.old) refused(result, [refusal(bash.full)]);
    else {
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("bash version guard:");
    }
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

describe("build stage and swap", () => {
  const BUILD = "abc1234";
  const CONFIG = ".wrangler/deploy/config.json";
  // apps/web in a checkout: the live build "old", a backup pair, and a complete stage of BUILD.
  // The systemctl stub records its arguments and the build that dist holds when it is called.
  const stagedCheckout = () => {
    const root = join(dir, "checkout");
    const web = join(root, "apps/web");
    const put = (path: string, body: string) => {
      mkdirSync(join(web, path, ".."), { recursive: true });
      writeFileSync(join(web, path), body);
    };
    const read = (path: string) => readFileSync(join(web, path), "utf8");
    const has = (path: string) => existsSync(join(web, path));
    put("dist/server/wrangler.json", "old");
    put("dist/DEPLOYED_SHA", "0ld0000\n");
    put(CONFIG, "old config");
    put(".wrangler/state/v3/cache.db", "local state");
    put("DEPLOYED_SHA", `${BUILD}\n`);
    put(".build-next/dist/server/wrangler.json", "new");
    put(".build-next/dist/DEPLOYED_SHA", `${BUILD}\n`);
    put(`.build-next/${CONFIG}`, "new config");
    put(".build-next/STAGED_SHA", `${BUILD}\n`);
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/systemctl"),
      `#!/usr/bin/env bash
echo "$*" >>"${join(dir, "systemctl")}"
echo "$(cat "${join(web, "dist/server/wrangler.json")}")" >>"${join(dir, "systemctl-dist")}"
`
    );
    chmodSync(join(dir, "bin/systemctl"), 0o755);
    const names = (prefix: string) =>
      readdirSync(web).filter((name) => name.startsWith(prefix));
    return { has, names, put, read, root, web };
  };
  const lines = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  const REAL = { real: "", "real-build": "" };
  // The stage is complete again and the live build is the old one.
  const expectOldLive = (c: {
    names: (prefix: string) => string[];
    read: (path: string) => string;
  }) => {
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.read(CONFIG)).toBe("old config");
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(c.read(".build-next/STAGED_SHA")).toBe(`${BUILD}\n`);
    expect(c.names("dist.bak-")).toEqual([]);
    expect(c.names("dist.failed-")).toEqual([]);
  };

  it("swaps the staged build in with the restart: the old process never serves from the new dist", () => {
    setup({ ...REAL, "probe.1": BUSY });
    const c = stagedCheckout();
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.stdout).toContain(
      `build: the staged build ${BUILD} will be swapped in at the restart`
    );
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    // During the whole idle wait dist holds the build that the process was started from.
    expect(lines("probe-dist")).toEqual(["old", "old", "old"]);
    // The new build is in place when the unit restarts, and only then.
    expect(result.systemctl).toEqual(["restart vertex-web"]);
    expect(lines("systemctl-dist")).toEqual(["new"]);
    expect(result.stdout).toMatch(
      /build: swapped in abc1234 \(previous build: dist\.bak-\d{8}T\d{6}Z with \.wrangler\.bak-\d{8}T\d{6}Z\)/u
    );
    expect(result.stdout).toMatch(
      /build: \d+ ms from the first rename to the restart call/u
    );
    expect(result.stdout).toContain(`build: ${BUILD} is live`);
    const [bak] = c.names("dist.bak-");
    const ts = (bak ?? "").replace("dist.bak-", "");
    expect(ts).toMatch(/^\d{8}T\d{6}Z$/u);
    expect(c.read(`dist.bak-${ts}/server/wrangler.json`)).toBe("old");
    expect(c.read(`.wrangler.bak-${ts}/deploy/config.json`)).toBe("old config");
    expect(c.read(`.wrangler.bak-${ts}/state/v3/cache.db`)).toBe("local state");
    expect(c.read("dist/server/wrangler.json")).toBe("new");
    expect(c.read(CONFIG)).toBe("new config");
    expect(c.read(".wrangler/state/v3/cache.db")).toBe("local state");
    expect(c.has(".build-next/dist")).toBe(false);
    expect(c.read("DEPLOYED_SHA")).toBe(`${BUILD}\n`);
    expect(result.stdout).toContain(`recorded DEPLOYED_SHA ${BUILD}`);
    expect(result.alerts).toEqual([]);
    // The stage is consumed: a second run has nothing to deploy.
    expect(run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web }).status).toBe(3);
  });

  it("refuses --deploy without a complete stage of that commit", () => {
    const refused = (stage: Record<string, string>, text: string) => {
      setup(stage);
      const result = run(["--deploy", BUILD]);
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("NOT RESTARTED: build stage:");
      expect(result.stdout).toContain(text);
      expect(result.calls).not.toContain("probe");
      expect(result.calls).not.toContain("restart");
      expect(result.alerts).toEqual([]);
    };
    refused({}, "no build is staged");
    refused({ stage: "staged incomplete\n" }, "is not complete");
    refused({ stage: "staged def5678\n" }, "the staged build is def5678");
    refused({ stage: "", "stage.fail": "" }, "no answer from QuantVPS");
    expect(run(["--deploy"]).status).toBe(2);
    expect(run(["--deploy", "not-a-sha"]).status).toBe(2);
  });

  it("ignores a stage without --deploy and restarts the live build", () => {
    setup(REAL);
    const c = stagedCheckout();
    c.put("dist.bak-20261101T125501Z/server/wrangler.json", "older");
    c.put(".wrangler.bak-20261101T125501Z/deploy/config.json", "older");
    c.put("dist/DEPLOYED_SHA", `${BUILD}\n`);
    const result = run([], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `build: the staged build ${BUILD} in .build-next is ignored (no --deploy)`
    );
    expect(result.commands).toEqual([
      ": restart; systemctl restart vertex-web",
    ]);
    expect(lines("systemctl-dist")).toEqual(["old"]);
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(c.names("dist.bak-")).toEqual(["dist.bak-20261101T125501Z"]);
    // An incomplete stage does not block a plain restart either.
    setup({ stage: "staged incomplete\n" });
    const plain = run();
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(
      "build: the staged build incomplete in .build-next is ignored (no --deploy)"
    );
  });

  it("needs no older backup pair for --deploy: the swap makes the rollback source", () => {
    setup({ candidate: "", "candidate.fail": "", stage: `staged ${BUILD}\n` });
    const result = run(["--deploy", BUILD]);
    expect(result.stdout).toContain(
      "gate: build output ok; rollback source: the live build (the swap makes the backup pair)"
    );
    expect(result.calls).toContain("restart");
    // A named backup must still exist.
    setup({ candidate: "", "candidate.fail": "", stage: `staged ${BUILD}\n` });
    const named = run(["--deploy", BUILD, "--backup", "20261101T125501Z"]);
    expect(named.status).toBe(3);
    expect(named.stdout).toContain("NOT RESTARTED: no rollback source");
  });

  it("rolls back to the pair of the swap when the new build fails its health check", () => {
    setup({
      ...REAL,
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
    });
    const c = stagedCheckout();
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(5);
    expect(result.syntax).toEqual([]);
    expect(lines("systemctl-dist")).toEqual(["new", "old"]);
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.read(CONFIG)).toBe("old config");
    const [failed] = c.names("dist.failed-");
    expect(c.read(`${failed}/server/wrangler.json`)).toBe("new");
    expect(c.names("dist.bak-")).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatch(/Rolled back to build \d{8}T\d{6}Z/u);
    // The restored build is recorded, as after every rollback.
    expect(c.read("DEPLOYED_SHA")).toBe("0ld0000\n");
  });

  it("moves nothing when the stage changed after the guard", () => {
    setup({
      ...REAL,
      "real-build": "",
      stage: `staged ${BUILD}\n`,
      "starts.2": STARTS,
    });
    const c = stagedCheckout();
    // The guard sees the canned answer; the restart command reads the real marker.
    rmSync(join(dir, "real-build"));
    c.put(".build-next/STAGED_SHA", "def5678\n");
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "build: the staged build changed after the guard"
    );
    expect(result.stdout).toContain("build: nothing moved");
    expect(result.systemctl).toEqual([]);
    expect(result.calls).not.toContain("unswap");
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(c.names("dist.bak-")).toEqual([]);
    expect(c.names(".wrangler.bak-")).toEqual([]);
    expect(result.alerts).toEqual([]);
  });

  it("puts the build back when the runtime tree swap fails", () => {
    setup({
      ...REAL,
      runtime: `live 0ld0000\nstaged ${BUILD}\nincomplete none\n`,
      "starts.2": STARTS,
    });
    const c = stagedCheckout();
    // No .runtime-next/PATHS in the checkout: the runtime swap refuses before its first move.
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.syntax).toEqual([]);
    expect(result.stdout).toContain("build: swapped in");
    expect(result.stdout).toContain("swap: nothing moved");
    expect(result.stdout).toContain("build: undone");
    expect(result.systemctl).toEqual([]);
    expect(result.calls).not.toContain("unswap");
    expectOldLive(c);
  });

  it("swaps the build and the runtime tree in one command, the build first", () => {
    setup({ ...REAL, "real-runtime": "" });
    const c = stagedCheckout();
    const root = (path: string) => join(c.root, path);
    writeFileSync(root("RUNTIME_SHA"), "0ld0000\n");
    writeFileSync(root("package.json"), "old runtime");
    mkdirSync(root(".runtime-next"));
    writeFileSync(root(".runtime-next/RUNTIME_SHA"), `${BUILD}\n`);
    writeFileSync(root(".runtime-next/package.json"), "new runtime");
    writeFileSync(root(".runtime-next/PATHS"), "package.json\nRUNTIME_SHA\n");
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    expect(result.stdout.indexOf("build: swapped in")).toBeGreaterThan(-1);
    expect(result.stdout.indexOf("swapped 2 paths")).toBeGreaterThan(
      result.stdout.indexOf("build: swapped in")
    );
    expect(lines("systemctl-dist")).toEqual(["new"]);
    expect(readFileSync(root("package.json"), "utf8")).toBe("new runtime");
    expect(readFileSync(root("RUNTIME_SHA"), "utf8")).toBe(`${BUILD}\n`);
    expect(c.read("dist/server/wrangler.json")).toBe("new");
    expect(result.alerts).toEqual([]);
  });

  it("moves the build back when the unit did not restart", () => {
    setup({ ...REAL, "starts.2": STARTS });
    const c = stagedCheckout();
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.calls).toContain("unswap");
    expect(result.stdout).toContain(
      "build: undone: the previous build is back in dist; the new build is back in .build-next"
    );
    expect(result.stdout).toContain(
      "NOT RESTARTED: vertex-web ActiveEnterTimestamp did not change"
    );
    expectOldLive(c);
    expect(result.alerts).toEqual([]);
  });

  it("confirms an unknown swap from dist/DEPLOYED_SHA, or reports it", () => {
    // No closing line from the restart command (for example a lost connection).
    setup({ stage: `staged ${BUILD}\n` });
    const confirmed = run(["--deploy", BUILD]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout).toContain(
      `build: confirmed: dist/DEPLOYED_SHA holds ${BUILD}`
    );
    expect(confirmed.alerts).toEqual([]);
    setup({ stage: `staged ${BUILD}\n`, "record.fail": "" });
    const open = run(["--deploy", BUILD]);
    expect(open.status).toBe(3);
    expect(open.stdout).toContain("NOT DEPLOYED:");
    expect(open.alerts).toHaveLength(1);
    expect(open.alerts[0]).toContain("deploy not confirmed");
    expect(open.alerts[0]).toContain(".build-next/dist");
  });

  it("reads the new commit from the stage: an older staged build is refused", () => {
    setup({
      ...REAL,
      shas: `new ${BUILD}\ndeployed ${BUILD}\n`,
    });
    const c = stagedCheckout();
    c.put(".build-next/dist/DEPLOYED_SHA", "none\n");
    c.put(".build-next/STAGED_SHA", "none\n");
    // A stage whose commit name is no SHA never passes the build guard.
    expect(run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web }).status).toBe(3);
    // A stage with an unknown deployed commit is refused by the version guard, with the stage text.
    c.put(".build-next/dist/DEPLOYED_SHA", `${BUILD}\n`);
    c.put(".build-next/STAGED_SHA", `${BUILD}\n`);
    c.put("DEPLOYED_SHA", "none\n");
    const refused = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(refused.status).toBe(9);
    expect(refused.stdout).toContain(
      "The refused build stays in apps/web/.build-next on QuantVPS"
    );
    expect(refused.systemctl).toEqual([]);
    expectOldLive(c);
  });

  it("dry run prints the stage state and the --deploy decision", () => {
    setup({ stage: `staged ${BUILD}\n` });
    const plain = run(["--dry-run"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(
      `build: the staged build ${BUILD} in .build-next is ignored (no --deploy)`
    );
    const deploy = run(["--dry-run", "--deploy", BUILD]);
    expect(deploy.stdout).toContain(
      `build: the staged build ${BUILD} will be swapped in at the restart`
    );
    const refused = run(["--dry-run", "--deploy", "def5678"]);
    expect(refused.status).toBe(0);
    expect(refused.stdout).toContain("build stage would refuse:");
    expect(refused.calls).not.toContain("restart");
    expect(refused.alerts).toEqual([]);
    // No answer about the stage: the other lines are still printed.
    setup({ stage: "", "stage.fail": "" });
    expect(run(["--dry-run"]).stdout).toContain(
      "rollback source: 20261101T125501Z"
    );
  });

  it("names the repair paragraph when dist is missing", () => {
    setup({ gate: "\n", "gate.fail": "" });
    const result = run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('"Repair a cut build swap"');
  });
});

describe("market hours guard", () => {
  // "<day 1-7> <HHMM> <zone>" as `TZ=America/New_York date +'%u %H%M %Z'` prints it.
  const at = (time: string) => ({ VERTEX_DEPLOY_NY_TIME: time });

  it("refuses on a weekday from 08:30 to 15:59 New York time, before any remote call", () => {
    for (const time of ["1 0830 EST", "3 1200 EDT", "5 1559 EDT"]) {
      setup({});
      const result = run([], at(time));
      expect(result.stdout).toContain("NOT RESTARTED: market hours guard:");
      expect(result.stdout).toContain("--allow-market-hours <reason>");
      expect(result.status).toBe(14);
      expect(result.calls).toEqual([]);
      expect(result.alerts).toEqual([]);
    }
  });

  it("allows 08:29, 16:00 and the weekend", () => {
    for (const time of [
      "1 0829 EST",
      "5 1600 EDT",
      "6 1200 EST",
      "7 0900 EDT",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "market hours guard: test hook VERTEX_DEPLOY_NY_TIME replaces the clock"
      );
      expect(result.stdout).toContain("market hours: outside Monday to Friday");
    }
  });

  it("counts a time that cannot be read as market hours", () => {
    // GNU date prints UTC without an error when the New York zone data is missing.
    for (const time of [
      "6 1200 UTC",
      "6 1200",
      "8 1200 EST",
      "6 2500 EST",
      "x",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(14);
      expect(result.stdout).toContain("New York time unknown");
      expect(result.calls).toEqual([]);
    }
  });

  it("stops the idle wait when the clock reaches 08:30", () => {
    setup({ probe: BUSY });
    // The clock of the first three reads is 08:29, then 08:30.
    writeFileSync(
      join(dir, "clock.sh"),
      `#!/usr/bin/env bash
echo x >>"${join(dir, "clock-reads")}"
if [ "$(wc -l <"${join(dir, "clock-reads")}")" -le 3 ]; then echo "1 0829 EST"; else echo "1 0830 EST"; fi
`
    );
    chmodSync(join(dir, "clock.sh"), 0o755);
    const result = run([], at(join(dir, "clock.sh")));
    expect(result.status).toBe(14);
    expect(result.stdout).toContain("NOT RESTARTED: market hours guard:");
    // Two polls ran before the window opened; the restart was never sent.
    expect(result.calls.filter((call) => call === "probe")).toHaveLength(2);
    expect(result.calls).not.toContain("restart");
    expect(result.pauseLeft).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it("checks the clock again after the idle wait", () => {
    setup({});
    // Reads: start, poll 1, poll 2, then the read after the wait.
    writeFileSync(
      join(dir, "clock.sh"),
      `#!/usr/bin/env bash
echo x >>"${join(dir, "clock-reads")}"
if [ "$(wc -l <"${join(dir, "clock-reads")}")" -le 3 ]; then echo "1 0829 EST"; else echo "1 0830 EST"; fi
`
    );
    chmodSync(join(dir, "clock.sh"), 0o755);
    const result = run([], at(join(dir, "clock.sh")));
    expect(result.status).toBe(14);
    expect(result.calls.filter((call) => call === "probe")).toHaveLength(2);
    expect(result.calls).not.toContain("restart");
  });

  it("restarts in market hours only with --allow-market-hours, and sends one notice", () => {
    setup({ "probe.1": BUSY });
    const result = run(
      ["--allow-market-hours", "owner decision: urgent fix"],
      at("1 1200 EST")
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "market hours: WARNING guard skipped (New York day 1 time 1200): owner decision: urgent fix"
    );
    expect(result.calls).toContain("restart");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("restart in US market hours");
    expect(result.alerts[0]).toContain("owner decision: urgent fix");
    expect(run(["--allow-market-hours"], at("1 1200 EST")).status).toBe(2);
    // Outside market hours the override does nothing and sends nothing.
    setup({});
    const outside = run(
      ["--allow-market-hours", "not needed"],
      at("6 1200 EST")
    );
    expect(outside.status).toBe(0);
    expect(outside.alerts).toEqual([]);
  });

  it("dry run prints the decision, never refuses and sends no notice", () => {
    setup({});
    const refused = run(["--dry-run"], at("1 1200 EST"));
    expect(refused.status).toBe(0);
    expect(refused.stdout).toContain(
      "market hours guard would refuse: New York day 1 time 1200"
    );
    const skipped = run(
      ["--dry-run", "--allow-market-hours", "owner decision"],
      at("1 1200 EST")
    );
    expect(skipped.stdout).toContain("market hours: WARNING guard skipped");
    expect(skipped.alerts).toEqual([]);
    expect(run(["--dry-run"], at("6 1200 EST")).stdout).toContain(
      "market hours: outside Monday to Friday"
    );
  });
});
