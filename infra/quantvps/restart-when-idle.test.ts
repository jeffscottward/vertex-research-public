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
  it("enforces the exact 30 s quiet boundary for both log age and TCP keep-alive traffic", () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-boundary-"));
    try {
      const busyPath = join(dir, "busy-29s.txt");
      writeFileSync(
        busyPath,
        [
          "@@NOW 1030",
          "@@ACTIVE active",
          "@@LAST 1001",
          "0      0      127.0.0.1:3450 127.0.0.1:42318",
          "\t cubic rto:204 mss:32768 bytes_sent:512 bytes_received:256 lastsnd:29999 lastrcv:29999 lastack:29999",
          "@@END",
          "",
        ].join("\n")
      );
      const busy = spawnSync("bash", [script, "--decide", busyPath, "30"], {
        encoding: "utf8",
      });
      expect(busy.status).toBe(0);
      expect(busy.stdout.trim().split("\n")).toEqual([
        "busy",
        "connection 127.0.0.1:42318: data 29999 ms ago",
        "last log line 29 s ago (quiet window 30 s)",
      ]);

      const idlePath = join(dir, "idle-30s.txt");
      writeFileSync(
        idlePath,
        [
          "@@NOW 1031",
          "@@ACTIVE active",
          "@@LAST 1001",
          "0      0      127.0.0.1:3450 127.0.0.1:42318",
          "\t cubic rto:204 mss:32768 bytes_sent:512 bytes_received:256 lastsnd:30000 lastrcv:30000 lastack:30000",
          "@@END",
          "",
        ].join("\n")
      );
      const idle = spawnSync("bash", [script, "--decide", idlePath, "30"], {
        encoding: "utf8",
      });
      expect(idle.status).toBe(0);
      expect(idle.stdout.trim().split("\n")).toEqual([
        "idle",
        "no open request on :3450 (1 keep-alive connection(s), quiet >= 30 s); last log line 30 s ago",
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

// Fake remote runner: names each call by its ": <name>;" marker, logs it, and answers from
// <dir>/<name>.<n> (n-th call) or <dir>/<name>. A <name>.fail or <name>.<n>.fail file makes
// that call fail; a <name>.stderr file is written to stderr. Every command string must pass
// `bash -n`. With a <dir>/real file, gate, candidate, restart, unswap and rollback run for real
// against VERTEX_WEB_DIR, with a systemctl stub on PATH; a <dir>/real-runtime file adds runtime,
// and a <dir>/real-build file adds stage, shas, record and confirm. Without a stage answer file, no build
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
if [ "$name" = migrations ]; then printf '%s' "$cmd" >"$FAKE_DIR/migrations-cmd"; fi
[ -f "$FAKE_DIR/$name.stderr" ] && cat "$FAKE_DIR/$name.stderr" >&2
if [ -f "$FAKE_DIR/real" ]; then
  # restart.skip: the command never runs (ssh exit 255). restart.closed: it runs, but the reader of
  # its output is gone (a closed connection).
  if [ "$name" = restart ] && [ -f "$FAKE_DIR/restart.skip" ]; then exit 255; fi
  if [ "$name" = restart ] && [ -f "$FAKE_DIR/restart.closed" ]; then bash -c "$cmd" | :; exit 0; fi
  case "$name" in gate|candidate|restart|rollback) exec bash -c "$cmd" ;; esac
  if [ "$name" = unswap ]; then exec bash -c "$cmd"; fi
  if [ "$name" = runtime ] && [ -f "$FAKE_DIR/real-runtime" ]; then exec bash -c "$cmd"; fi
  if [ -f "$FAKE_DIR/real-build" ]; then case "$name" in stage|shas|record|confirm) exec bash -c "$cmd" ;; esac; fi
fi
if [ "$name" = stage ] && [ ! -f "$FAKE_DIR/stage" ] && [ ! -f "$FAKE_DIR/stage.$n" ] && [ ! -f "$FAKE_DIR/stage.fail" ]; then
  echo "staged none"; exit 0
fi
if [ "$name" = runtime ] && [ ! -f "$FAKE_DIR/runtime" ] && [ ! -f "$FAKE_DIR/runtime.$n" ] && [ ! -f "$FAKE_DIR/runtime.fail" ]; then
  sed -n 's/^new /live /p' "$FAKE_DIR/shas"; echo "staged none"; echo "incomplete none"; exit 0
fi
if [ "$name" = migrations ] && [ ! -f "$FAKE_DIR/migrations" ] && [ ! -f "$FAKE_DIR/migrations.$n" ] && [ ! -f "$FAKE_DIR/migrations.fail" ]; then
  printf '@@START\t\t\t\n@@END\t\t\t\n'; exit 0
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
  writeFileSync(
    join(dir, "migrations-check.sh"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--print-sql" ]; then echo "SELECT 1;"; exit 0; fi
# Read the snapshot like the real checker. Without this, a slow writer meets a closed pipe,
# SIGPIPE fails the pipeline under pipefail and the guard exits 15 instead of passing.
cat >/dev/null
echo "all 0 build migrations applied (test hook)"
exit 0
`
  );
  chmodSync(join(dir, "migrations-check.sh"), 0o755);
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
      // Legacy tests use fake/empty commits without migration files; migration guard tests clear this.
      VERTEX_MIGRATIONS_CHECKER: join(dir, "migrations-check.sh"),
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
    alerts: read("alerts"),
    calls: read("calls"),
    commands: read("commands"),
    migrationsCmd: existsSync(join(dir, "migrations-cmd"))
      ? readFileSync(join(dir, "migrations-cmd"), "utf8")
      : "",
    pauseLeft: existsSync(join(dir, "state", "worker.pause")),
    pauseSeen: read("pause-seen"),
    signal: result.signal,
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
  it("restarts in the quiet window left by aligned :00 pollers", () => {
    const keepAliveProbe = (now: number, last: number): string => {
      const ageMs = (now - last) * 1000;
      return [
        `@@NOW ${now}`,
        "@@ACTIVE active",
        `@@LAST ${last}`,
        "0 0 127.0.0.1:3450 127.0.0.1:42318",
        `\t cubic bytes_sent:1024 bytes_received:512 lastsnd:${ageMs} lastrcv:${ageMs}`,
        "@@END",
      ].join("\n");
    };
    // Both flow/collect and autopilot/campaigns/tick complete at :01 (1001).
    // Polls every 5 s: busy at :26 (25 s), then idle at :31 (30 s) and :36 (35 s).
    setup({
      "probe.1": keepAliveProbe(1026, 1001),
      "probe.2": keepAliveProbe(1031, 1001),
      "probe.3": keepAliveProbe(1036, 1001),
    });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call === "probe")).toHaveLength(3);
    expect(result.commands).toEqual([
      ": restart; systemctl restart vertex-web",
    ]);
    expect(result.alerts).toEqual([]);
  });

  it("never restarts when split-minute pollers prevent two consecutive idle polls", () => {
    // Pollers at :00 (1000) and :28 (1028) leave a 32 s second half (<35 s two-poll window):
    // :58 scores one 30 s idle poll, then the :00 tick resets the streak before poll 2 at :03.
    const probeAt = (now: number, last: number): string => {
      const ageMs = (now - last) * 1000;
      return [
        `@@NOW ${now}`,
        "@@ACTIVE active",
        `@@LAST ${last}`,
        "0 0 127.0.0.1:3450 127.0.0.1:42318",
        `\t cubic bytes_sent:1024 bytes_received:512 lastsnd:${ageMs} lastrcv:${ageMs}`,
        "@@END",
      ].join("\n");
    };
    setup({
      "probe.1": probeAt(1058, 1028),
      probe: probeAt(1063, 1060),
    });
    const result = run([], { VERTEX_RESTART_GIVE_UP_AFTER: "0" });
    expect(result.status).toBe(4);
    expect(result.calls.filter((call) => call === "probe")).toHaveLength(2);
    expect(result.calls).not.toContain("restart");
    expect(result.stdout).toContain(
      "last log line 3 s ago (quiet window 30 s)"
    );
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
  const stagedCheckout = (build = BUILD, deployed = build) => {
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
    put("DEPLOYED_SHA", `${deployed}\n`);
    put(".build-next/dist/server/wrangler.json", "new");
    put(".build-next/dist/DEPLOYED_SHA", `${build}\n`);
    put(`.build-next/${CONFIG}`, "new config");
    put(".build-next/STAGED_SHA", `${build}\n`);
    // The runtime guard of the fake reads the canned answer: the runtime tree is at this build.
    writeFileSync(join(dir, "shas"), `new ${build}\ndeployed ${deployed}\n`);
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/systemctl"),
      `#!/usr/bin/env bash
echo "$*" >>"${join(dir, "systemctl")}"
echo "$(cat "${join(web, "dist/server/wrangler.json")}")" >>"${join(dir, "systemctl-dist")}"
[ ! -f "${join(dir, "systemctl.fail")}" ] || exit 1
`
    );
    chmodSync(join(dir, "bin/systemctl"), 0o755);
    const names = (prefix: string) =>
      readdirSync(web).filter((name) => name.startsWith(prefix));
    return { has, names, put, read, root, web };
  };
  // A live runtime tree at "0ld0000" and a complete runtime stage for BUILD in the checkout root.
  const stageRuntime = (root: string) => {
    writeFileSync(join(root, "RUNTIME_SHA"), "0ld0000\n");
    writeFileSync(join(root, "package.json"), "old runtime");
    mkdirSync(join(root, ".runtime-next"));
    writeFileSync(join(root, ".runtime-next/RUNTIME_SHA"), `${BUILD}\n`);
    writeFileSync(join(root, ".runtime-next/package.json"), "new runtime");
    writeFileSync(
      join(root, ".runtime-next/PATHS"),
      "package.json\nRUNTIME_SHA\n"
    );
  };
  const lines = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  const REAL = { real: "", "real-build": "" };
  // The stage is complete again and the live build is the old one.
  const expectOldLive = (
    c: {
      names: (prefix: string) => string[];
      read: (path: string) => string;
    },
    build = BUILD
  ) => {
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.read(CONFIG)).toBe("old config");
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(c.read(".build-next/STAGED_SHA")).toBe(`${build}\n`);
    expect(c.names("dist.bak-")).toEqual([]);
    expect(c.names("dist.failed-")).toEqual([]);
  };

  it("swaps the staged build in with the restart: the old process never serves from the new dist", () => {
    setup({ ...REAL, "probe.1": BUSY });
    // Real commits: the deployed record starts at an older commit and must change.
    const g = gitRepo();
    const c = stagedCheckout(g.tip, g.base);
    const env = { VERTEX_DEPLOY_GIT_DIR: g.repo, VERTEX_WEB_DIR: c.web };
    const result = run(["--deploy", g.tip], env);
    expect(result.stdout).toContain(
      `build: the staged build ${g.tip} will be swapped in at the restart`
    );
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    // During the whole idle wait dist holds the build that the process was started from.
    expect(lines("probe-dist")).toEqual(["old", "old", "old"]);
    // The new build is in place when the unit restarts, and only then.
    expect(result.systemctl).toEqual(["restart vertex-web"]);
    expect(lines("systemctl-dist")).toEqual(["new"]);
    expect(result.stdout).toMatch(
      /build: swapped in [0-9a-f]{40} \(previous build: dist\.bak-\d{8}T\d{6}Z with \.wrangler\.bak-\d{8}T\d{6}Z\)/u
    );
    expect(result.stdout).toMatch(
      /build: \d+ ms from the first rename to the restart call/u
    );
    expect(result.stdout).toContain(`build: ${g.tip} is live`);
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
    expect(c.read("DEPLOYED_SHA")).toBe(`${g.tip}\n`);
    expect(result.stdout).toContain(`recorded DEPLOYED_SHA ${g.tip}`);
    expect(result.alerts).toEqual([]);
    // The stage is consumed: a second run has nothing to deploy.
    expect(run(["--deploy", g.tip], env).status).toBe(3);
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
    stageRuntime(c.root);
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

  it("confirms an unknown swap only with a proof from the host, or reports it", () => {
    // No closing line from the restart command (for example a lost connection).
    setup({ confirm: "build-swap-confirmed\n", stage: `staged ${BUILD}\n` });
    const confirmed = run(["--deploy", BUILD]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout).toContain(
      `build: confirmed on QuantVPS: dist holds ${BUILD}`
    );
    expect(confirmed.alerts).toEqual([]);
    // No proof: the new commit in dist alone is not enough.
    setup({ stage: `staged ${BUILD}\n` });
    const open = run(["--deploy", BUILD]);
    expect(open.status).toBe(3);
    expect(open.stdout).toContain("NOT DEPLOYED:");
    expect(open.calls).toContain("confirm");
    expect(open.calls).not.toContain("record");
    expect(open.alerts).toHaveLength(1);
    expect(open.alerts[0]).toContain("deploy not confirmed");
    expect(open.alerts[0]).toContain(".build-next/dist");
    // The unit did not restart: the build is put back, and the unknown state still reaches a person.
    setup({
      stage: `staged ${BUILD}\n`,
      "starts.2": STARTS,
      unswap: "build: undone\n",
    });
    const back = run(["--deploy", BUILD]);
    expect(back.status).toBe(3);
    expect(back.calls).toContain("unswap");
    expect(back.calls).not.toContain("record");
    expect(back.alerts).toHaveLength(1);
    expect(back.alerts[0]).toContain("deploy not confirmed");
    expect(back.alerts[0]).toContain("build: undone");
  });

  it("never confirms a deploy without a confirmed swap and a confirmed restart", () => {
    const swappedLine = `build: swapped in ${BUILD} (previous build: dist.bak-20261122T210501Z with .wrangler.bak-20261122T210501Z)\n`;
    const noStarts = { "starts.2": "", "starts.2.fail": "" };
    const notDeployed = (
      files: Record<string, string>,
      starts: Record<string, string> = noStarts
    ) => {
      setup({ stage: `staged ${BUILD}\n`, ...starts, ...files });
      const result = run(["--deploy", BUILD]);
      expect(result.stdout).toContain("NOT DEPLOYED:");
      expect(result.stdout).not.toContain("is live");
      expect(result.status).toBe(3);
      expect(result.calls).not.toContain("record");
      expect(result.calls).not.toContain("confirm");
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]).toContain("deploy not confirmed");
    };
    // The start times cannot be read after the restart command, and:
    // the swap is reported, but the restart command failed (systemctl restart did not pass);
    notDeployed({ restart: swappedLine, "restart.fail": "" });
    // no closing line arrived (the command was cut);
    notDeployed({});
    // nothing was moved.
    notDeployed({ restart: "build: nothing moved\n", "restart.fail": "" });
    // The start times changed (the unit restarted on its own), and:
    // nothing was moved;
    notDeployed({ restart: "build: nothing moved\n", "restart.fail": "" }, {});
    // an undo did not finish. This state never counts as "no closing line".
    notDeployed(
      {
        confirm: "build-swap-confirmed\n",
        restart:
          "build: the swap failed; putting the live build back\nbuild: the undo did not finish; check dist\n",
        "restart.fail": "",
      },
      {}
    );
    // Swap reported and the restart command passed: only the container check is open (exit 7).
    setup({ stage: `staged ${BUILD}\n`, ...noStarts, restart: swappedLine });
    const result = run(["--deploy", BUILD]);
    expect(result.status).toBe(7);
    expect(result.stdout).toContain(`build: ${BUILD} is live`);
    expect(result.stdout).toContain(`recorded DEPLOYED_SHA ${BUILD}`);
  });

  it("reports a failed swap back, and a failed health check without a rollback source", () => {
    const swappedLine = `build: swapped in ${BUILD} (previous build: dist.bak-20261122T210501Z with .wrangler.bak-20261122T210501Z)\n`;
    setup({
      restart: swappedLine,
      stage: `staged ${BUILD}\n`,
      "starts.2": STARTS,
      unswap: "build: the undo did not finish; check dist\n",
      "unswap.fail": "",
    });
    const stuck = run(["--deploy", BUILD]);
    expect(stuck.status).toBe(3);
    expect(stuck.stdout).toContain("build: WARNING the swap back failed.");
    expect(stuck.alerts).toHaveLength(1);
    expect(stuck.alerts[0]).toContain("build swap back failed");
    // An undo that did not finish, and the unit did not restart: one more undo, and a notice.
    setup({
      restart:
        "build: the swap failed; putting the live build back\nbuild: the undo did not finish; check dist\n",
      "restart.fail": "",
      stage: `staged ${BUILD}\n`,
      "starts.2": STARTS,
      unswap: "build: undone\n",
    });
    const half = run(["--deploy", BUILD]);
    expect(half.status).toBe(3);
    expect(half.calls).toContain("unswap");
    expect(half.alerts).toHaveLength(1);
    expect(half.alerts[0]).toContain("the undo inside the restart command");
    // The old process is unhealthy, the stage was not swapped in, and no older pair exists.
    setup({
      candidate: "",
      "candidate.fail": "",
      health: "root=502 dashboard=000  active=active\n",
      restart: "build: nothing moved\n",
      "restart.fail": "",
      stage: `staged ${BUILD}\n`,
    });
    const down = run(["--deploy", BUILD]);
    expect(down.status).toBe(6);
    expect(down.stdout).toContain("ROLLBACK FAILED: no rollback source.");
    expect(down.calls).not.toContain("rollback");
    expect(down.alerts).toHaveLength(1);
    expect(down.alerts[0]).toContain("vertex-web is down");
  });

  it("rolls back from the pair of the run after an unknown swap, and from --backup when it is given", () => {
    const sick = {
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      stage: `staged ${BUILD}\n`,
    };
    setup(sick);
    const unknown = run(["--deploy", BUILD]);
    expect(unknown.status).toBe(5);
    expect(unknown.commands[1]).toMatch(
      /cp -a dist\.bak-\d{8}T\d{6}Z dist && cp -a \.wrangler\.bak-\d{8}T\d{6}Z \.wrangler/u
    );
    expect(unknown.commands[1]).not.toContain("20261101T125501Z");
    setup(sick);
    const named = run(["--deploy", BUILD, "--backup", "20261101T125501Z"]);
    expect(named.status).toBe(5);
    expect(named.commands[1]).toContain("cp -a dist.bak-20261101T125501Z dist");
  });

  it("runs the restart command to its end when the connection is closed", () => {
    setup({ ...REAL, "restart.closed": "" });
    const c = stagedCheckout();
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    // The swap is followed by the restart although nothing reads the output of the command.
    expect(result.systemctl).toEqual(["restart vertex-web"]);
    expect(lines("systemctl-dist")).toEqual(["new"]);
    // No closing line reached the script: the host proves the swap of this run.
    expect(result.stdout).toContain(
      `build: confirmed on QuantVPS: dist holds ${BUILD}`
    );
    expect(result.status).toBe(0);
    expect(c.read(".build-next/restart.log")).toContain("build: swapped in");
    expect(result.alerts).toEqual([]);
  });

  it("does not confirm a redeploy of the deployed commit whose restart command never ran", () => {
    setup({ ...REAL, "restart.skip": "" });
    const c = stagedCheckout();
    // dist already holds the commit: the deployed build is staged again, with the same config.
    c.put("dist/DEPLOYED_SHA", `${BUILD}\n`);
    c.put(CONFIG, "new config");
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("NOT DEPLOYED:");
    expect(result.stdout).not.toContain("is live");
    expect(result.systemctl).toEqual([]);
    expect(c.names("dist.bak-")).toEqual([]);
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(result.alerts).toHaveLength(1);
  });

  it("puts both swaps back when the unit did not restart", () => {
    setup({ ...REAL, "real-runtime": "", "starts.2": STARTS });
    const c = stagedCheckout();
    stageRuntime(c.root);
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.syntax).toEqual([]);
    expect(readFileSync(join(c.root, "package.json"), "utf8")).toBe(
      "old runtime"
    );
    expect(readFileSync(join(c.root, "RUNTIME_SHA"), "utf8")).toBe("0ld0000\n");
    expectOldLive(c);
    expect(result.alerts).toEqual([]);
  });

  it("names the build state when the health check gets no answer", () => {
    setup({ health: "", "health.fail": "", stage: `staged ${BUILD}\n` });
    const result = run(["--deploy", BUILD]);
    expect(result.status).toBe(6);
    expect(result.calls).not.toContain("rollback");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("Build state unknown");
  });

  it("never reads the log of an earlier deploy when the log cannot be written", () => {
    setup({ ...REAL });
    const c = stagedCheckout();
    // A consumed stage keeps the log of the last deploy; here it cannot be written.
    c.put(
      ".build-next/restart.log",
      "build: swapped in 0ld0000 (previous build: dist.bak-20261101T000000Z with .wrangler.bak-20261101T000000Z)\n"
    );
    chmodSync(join(c.web, ".build-next/restart.log"), 0o444);
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.stdout).toContain(
      "build: cannot write .build-next/restart.log"
    );
    expect(result.stdout).not.toContain("is live");
    expect(result.status).toBe(3);
    expect(result.systemctl).toEqual([]);
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.names("dist.bak-")).toEqual([]);
    expect(result.alerts).toHaveLength(1);
  });

  it("moves nothing when dist is a symlink", () => {
    setup({ ...REAL, "starts.2": STARTS });
    const c = stagedCheckout();
    spawnSync("mv", [join(c.web, "dist"), join(c.web, "dist.real")]);
    symlinkSync("dist.real", join(c.web, "dist"));
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "build: dist or .wrangler in apps/web is not a directory"
    );
    expect(result.stdout).toContain("build: nothing moved");
    expect(result.systemctl).toEqual([]);
    expect(readlinkSync(join(c.web, "dist"))).toBe("dist.real");
    expect(c.read(".build-next/dist/server/wrangler.json")).toBe("new");
    expect(c.names(".wrangler.bak-")).toEqual([]);
  });

  it("rolls both swaps back when the new build fails its health check", () => {
    setup({
      ...REAL,
      health: "root=502 dashboard=000  active=active\n",
      "health.2": HEALTHY,
      "real-runtime": "",
    });
    const c = stagedCheckout();
    const root = (path: string) => join(c.root, path);
    stageRuntime(c.root);
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(5);
    expect(result.syntax).toEqual([]);
    expect(lines("systemctl-dist")).toEqual(["new", "old"]);
    expect(readFileSync(root("package.json"), "utf8")).toBe("old runtime");
    expect(readFileSync(root("RUNTIME_SHA"), "utf8")).toBe("0ld0000\n");
    expect(c.read("dist/server/wrangler.json")).toBe("old");
    expect(c.read(CONFIG)).toBe("old config");
    expect(result.alerts).toHaveLength(1);
  });

  it("does not confirm a swap when systemctl restart fails and the start times cannot be read", () => {
    setup({ ...REAL, "starts.2": "", "starts.2.fail": "" });
    const c = stagedCheckout();
    writeFileSync(join(dir, "systemctl.fail"), "");
    const result = run(["--deploy", BUILD], { VERTEX_WEB_DIR: c.web });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("NOT DEPLOYED:");
    expect(result.stdout).not.toContain("is live");
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("deploy not confirmed");
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
    // A staged build that is a strict ancestor of the deployed commit.
    setup(REAL);
    const g = gitRepo();
    const older = stagedCheckout(g.base, g.tip);
    const ancestor = run(["--deploy", g.base], {
      VERTEX_DEPLOY_GIT_DIR: g.repo,
      VERTEX_WEB_DIR: older.web,
    });
    expect(ancestor.status).toBe(9);
    expect(ancestor.stdout).toContain(
      `new build ${g.base} is OLDER than deployed ${g.tip}`
    );
    expect(ancestor.stdout).toContain(
      "The refused build stays in apps/web/.build-next on QuantVPS"
    );
    expect(ancestor.systemctl).toEqual([]);
    expectOldLive(older, g.base);
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
    expect(result.alerts[0]).toContain("restart run in US market hours");
    expect(result.alerts[0]).toContain("owner decision: urgent fix");
    expect(run(["--allow-market-hours"], at("1 1200 EST")).status).toBe(2);
    // The window opens during the idle wait: the line is printed and the notice is sent, once.
    setup({ "probe.1": BUSY, "probe.2": BUSY });
    writeFileSync(
      join(dir, "clock.sh"),
      `#!/usr/bin/env bash
echo x >>"${join(dir, "clock-reads")}"
if [ "$(wc -l <"${join(dir, "clock-reads")}")" -le 2 ]; then echo "1 0829 EST"; else echo "1 0830 EST"; fi
`
    );
    chmodSync(join(dir, "clock.sh"), 0o755);
    const during = run(
      ["--allow-market-hours", "owner decision"],
      at(join(dir, "clock.sh"))
    );
    expect(during.status).toBe(0);
    expect(during.alerts).toHaveLength(1);
    expect(
      during.stdout.split("market hours: WARNING guard skipped")
    ).toHaveLength(2);
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

  it("allows daytime restarts on NYSE full-day holidays without --allow-market-hours", () => {
    for (const time of [
      "2025-01-09 4 1200 EST",
      "2026-07-03 5 1200 EDT",
      "2026-11-26 4 1200 EST",
      "2026-12-25 5 1000 EST",
      "2027-12-24 5 1200 EST",
      "2028-01-17 1 1200 EST",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(0);
      expect(result.calls).toContain("restart");
      expect(result.alerts).toEqual([]);
      expect(result.stdout).toContain("market hours: NYSE holiday closed");
    }
    // Passing --allow-market-hours on a holiday does nothing and sends no notice.
    setup({});
    const withOverride = run(
      ["--allow-market-hours", "not needed"],
      at("2026-11-26 4 1200 EST")
    );
    expect(withOverride.status).toBe(0);
    expect(withOverride.alerts).toEqual([]);
    expect(withOverride.stdout).toContain(
      "market hours: NYSE holiday closed (New York 2026-11-26 day 4 time 1200)"
    );
    // Dry run prints the holiday decision and sends no notice.
    setup({});
    const dry = run(["--dry-run"], at("2026-11-26 4 1200 EST"));
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(
      "market hours: NYSE holiday closed (New York 2026-11-26 day 4 time 1200)"
    );
    expect(dry.alerts).toEqual([]);
  });

  it("refuses 08:30-12:59 and allows <08:30 and >=13:00 on NYSE early-close days", () => {
    for (const time of [
      "2026-11-27 5 0830 EST",
      "2026-11-27 5 1259 EST",
      "2026-12-24 4 1259 EST",
      "2028-07-03 1 1200 EDT",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(14);
      expect(result.calls).toEqual([]);
      expect(result.alerts).toEqual([]);
      expect(result.stdout).toContain("NOT RESTARTED: market hours guard:");
      expect(result.stdout).toContain("NYSE early close at 13:00");
    }
    for (const time of [
      "2026-11-27 5 0829 EST",
      "2026-11-27 5 1300 EST",
      "2026-11-27 5 1500 EST",
      "2026-12-24 4 1300 EST",
      "2028-07-03 1 1300 EDT",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(0);
      expect(result.calls).toContain("restart");
      expect(result.alerts).toEqual([]);
      expect(result.stdout).toContain(
        "market hours: outside Monday to Friday 08:30-13:00 New York time (NYSE early close;"
      );
    }
    // Regular trading days (including days before observed holidays) stay 08:30-16:00.
    for (const time of [
      "2026-11-25 3 1300 EST",
      "2026-07-02 4 1400 EDT",
      "2027-12-23 4 1400 EST",
    ]) {
      setup({});
      const result = run([], at(time));
      expect(result.status).toBe(14);
      expect(result.calls).toEqual([]);
    }
    // Dry run and --allow-market-hours behave cleanly across the 13:00 boundary.
    setup({});
    const dryBefore = run(["--dry-run"], at("2026-11-27 5 1259 EST"));
    expect(dryBefore.status).toBe(0);
    expect(dryBefore.stdout).toContain(
      "market hours guard would refuse: New York 2026-11-27 day 5 time 1259 (NYSE early close at 13:00)"
    );
    setup({});
    const dryAfter = run(["--dry-run"], at("2026-11-27 5 1300 EST"));
    expect(dryAfter.status).toBe(0);
    expect(dryAfter.stdout).toContain(
      "market hours: outside Monday to Friday 08:30-13:00 New York time (NYSE early close; New York 2026-11-27 day 5 time 1300)"
    );
    setup({});
    const overrideBefore = run(
      ["--allow-market-hours", "owner decision"],
      at("2026-11-27 5 1259 EST")
    );
    expect(overrideBefore.status).toBe(0);
    expect(overrideBefore.alerts).toHaveLength(1);
    setup({});
    const overrideAfter = run(
      ["--allow-market-hours", "not needed"],
      at("2026-11-27 5 1300 EST")
    );
    expect(overrideAfter.status).toBe(0);
    expect(overrideAfter.alerts).toEqual([]);
  });

  it("stops the idle wait when an early-close day reaches 08:30", () => {
    setup({ probe: BUSY });
    writeFileSync(
      join(dir, "clock.sh"),
      `#!/usr/bin/env bash
echo x >>"${join(dir, "clock-reads")}"
if [ "$(wc -l <"${join(dir, "clock-reads")}")" -le 2 ]; then echo "2026-11-27 5 0829 EST"; else echo "2026-11-27 5 0830 EST"; fi
`
    );
    chmodSync(join(dir, "clock.sh"), 0o755);
    const result = run([], at(join(dir, "clock.sh")));
    expect(result.status).toBe(14);
    expect(result.stdout).toContain("NYSE early close at 13:00");
    expect(result.calls).not.toContain("restart");
  });

  it("handles dated regular weekdays, weekends, leap days, and rejects invalid dated clocks", () => {
    for (const time of [
      "2026-11-25 3 0829 EST",
      "2026-11-25 3 1600 EST",
      "2026-11-28 6 1200 EST",
      "2028-02-29 2 1600 EST",
    ]) {
      setup({});
      expect(run([], at(time)).status).toBe(0);
    }
    for (const time of [
      "2026-11-25 3 0830 EST",
      "2026-11-25 3 1559 EST",
      "2028-02-29 2 1200 EST",
    ]) {
      setup({});
      expect(run([], at(time)).status).toBe(14);
    }
    for (const bad of [
      "2026-02-29 7 1200 EST",
      "2026-13-01 4 1200 EST",
      "2026-04-31 4 1200 EST",
      "2026-00-10 2 1200 EST",
      "2026-11-26 6 1200 EST",
      "2026-11-26 4 1200 UTC",
      "2026-11-26 4 1200 EST extra",
      "6 1200 EST extra",
    ]) {
      setup({});
      const result = run([], at(bad));
      expect(result.status).toBe(14);
      expect(result.stdout).toContain("New York time unknown");
      expect(result.calls).toEqual([]);
    }
  });

  it("fails closed on missing, unreadable, malformed or out-of-range NYSE calendars during weekday hours", () => {
    // Missing calendar file: refuses weekday daytime even on Thanksgiving, allows outside 08:30-16:00 with warning.
    setup({});
    const missingPath = join(dir, "no-such-calendar.txt");
    const missingDay = run([], {
      VERTEX_DEPLOY_NY_TIME: "2026-11-26 4 1200 EST",
      VERTEX_DEPLOY_NYSE_CALENDAR: missingPath,
    });
    expect(missingDay.status).toBe(14);
    expect(missingDay.stdout).toContain(
      "market hours guard: test hook VERTEX_DEPLOY_NYSE_CALENDAR replaces the NYSE calendar"
    );
    expect(missingDay.stdout).toContain("NYSE calendar error:");
    expect(missingDay.calls).toEqual([]);

    setup({});
    const missingAfter = run([], {
      VERTEX_DEPLOY_NY_TIME: "2026-11-26 4 1700 EST",
      VERTEX_DEPLOY_NYSE_CALENDAR: missingPath,
    });
    expect(missingAfter.status).toBe(0);
    expect(missingAfter.stdout).toContain("WARNING: NYSE calendar error:");

    // Directory path fails closed on weekday daytime.
    setup({});
    const dirCal = run([], {
      VERTEX_DEPLOY_NY_TIME: "2026-11-26 4 1200 EST",
      VERTEX_DEPLOY_NYSE_CALENDAR: dir,
    });
    expect(dirCal.status).toBe(14);
    expect(dirCal.stdout).toContain("NYSE calendar error:");

    // Malformed calendars: even when 2026-11-26 closed is present, any bad line rejects the whole file.
    const malformedCases = [
      "2026-11-26 closed\n",
      "years 2025-2028\nyears 2025-2028\n2026-11-26 closed\n",
      "years 2028-2025\n2026-11-26 closed\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-26 closed\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-28 closed\n",
      "years 2025-2028\n2026-11-26 closed\n2026-02-29 closed\n",
      "years 2025-2028\n2026-11-26 closed\n2029-01-01 closed\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-27 early:0830\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-27 early:1600\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-27 early:1360\n",
      "years 2025-2028\n2026-11-26 closed\n2026-11-27 holiday\n",
      "years 2025-2028\n2026-11-26 closed extra\n",
    ];
    for (const [idx, body] of malformedCases.entries()) {
      setup({});
      const calPath = join(dir, `bad-${idx}.txt`);
      writeFileSync(calPath, body);
      const result = run([], {
        VERTEX_DEPLOY_NY_TIME: "2026-11-26 4 1200 EST",
        VERTEX_DEPLOY_NYSE_CALENDAR: calPath,
      });
      expect(result.status).toBe(14);
      expect(result.stdout).toContain("NYSE calendar error:");
      expect(result.calls).toEqual([]);
    }

    // Uncovered year (2029): refuses weekday daytime, allows weekend/after-hours with warning.
    setup({});
    const uncoveredDay = run([], at("2029-11-22 4 1200 EST"));
    expect(uncoveredDay.status).toBe(14);
    expect(uncoveredDay.stdout).toContain(
      "NYSE calendar covers 2025-2028, year 2029 not covered"
    );
    setup({});
    const uncoveredAfter = run([], at("2029-11-22 4 1700 EST"));
    expect(uncoveredAfter.status).toBe(0);
    expect(uncoveredAfter.stdout).toContain(
      "WARNING: NYSE calendar covers 2025-2028, year 2029 not covered"
    );

    // Custom early close time in override table works cleanly.
    setup({});
    const customCal = join(dir, "custom.txt");
    writeFileSync(
      customCal,
      "years 2026-2026\n2026-10-15 early:1400 # custom half day\n"
    );
    expect(
      run([], {
        VERTEX_DEPLOY_NY_TIME: "2026-10-15 4 1359 EDT",
        VERTEX_DEPLOY_NYSE_CALENDAR: customCal,
      }).status
    ).toBe(14);
    expect(
      run([], {
        VERTEX_DEPLOY_NY_TIME: "2026-10-15 4 1400 EDT",
        VERTEX_DEPLOY_NYSE_CALENDAR: customCal,
      }).status
    ).toBe(0);
  });

  it("keeps infra/quantvps/nyse-calendar.txt in parity with repo NYSE calendars", () => {
    const calFile = fileURLToPath(
      new URL("./nyse-calendar.txt", import.meta.url)
    );
    const raw = readFileSync(calFile, "utf8");
    const entries: string[] = [];
    const holidays: string[] = [];
    const earlyCloses: string[] = [];
    for (const line of raw.split("\n")) {
      const clean = line.replace(/#.*$/u, "").trim();
      if (!clean || clean.startsWith("years ")) continue;
      const [date, kind] = clean.split(/\s+/u);
      if (!(date && kind)) throw new Error(`bad line: ${line}`);
      entries.push(date);
      if (kind === "closed") holidays.push(date);
      else if (kind === "early:1300") earlyCloses.push(date);
      else throw new Error(`unexpected kind: ${kind}`);
    }
    // Must stay in chronological order with no duplicates.
    expect(entries).toEqual([...entries].sort());
    expect(new Set(entries).size).toBe(entries.length);

    // Parity with scripts/breadth-90/calendar.ts (2025-2027 holidays and early closes).
    const breadthSrc = readFileSync(
      fileURLToPath(
        new URL("../../scripts/breadth-90/calendar.ts", import.meta.url)
      ),
      "utf8"
    );
    const extractDates = (block: string) =>
      [...block.matchAll(/"(\d{4}-\d{2}-\d{2})"/gu)].map((m) => String(m[1]));
    const breadthHolidaysBlock =
      breadthSrc.match(/NYSE_HOLIDAYS[\s\S]*?\]\);/u)?.[0] ?? "";
    const breadthEarlyBlock =
      breadthSrc.match(/NYSE_EARLY_CLOSES[\s\S]*?\]\);/u)?.[0] ?? "";
    expect(holidays.filter((d) => d < "2028-01-01")).toEqual(
      extractDates(breadthHolidaysBlock)
    );
    expect(earlyCloses.filter((d) => d < "2028-01-01")).toEqual(
      extractDates(breadthEarlyBlock)
    );

    // Parity with services/openbb/vertex_openbb/jobs/nyse_closures.py (2025-2028 holidays).
    const openbbSrc = readFileSync(
      fileURLToPath(
        new URL(
          "../../services/openbb/vertex_openbb/jobs/nyse_closures.py",
          import.meta.url
        )
      ),
      "utf8"
    );
    const openbbHolidays = extractDates(openbbSrc).filter(
      (d) => d >= "2025-01-01" && d <= "2028-12-31"
    );
    expect(holidays).toEqual(openbbHolidays);
  });
});

// Migration guard (card vertex-deploy-migration-guard): refuses to restart vertex-web when any
// migration of the build commit is not applied on QuantVPS Postgres (vertex-postgres).
// Every test here clears VERTEX_MIGRATIONS_CHECKER so the real scripts/db-migrations-check.ts runs.
describe("migration guard", { timeout: 30_000 }, () => {
  const migrationGitRepo = () => {
    const repo = join(dir, "mig-git");
    mkdirSync(repo, { recursive: true });
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
    const writeFile = (rel: string, content: string) => {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), content);
    };
    const commitMigrations = (
      msg: string,
      entries: readonly { sql: string; tag: string }[]
    ) => {
      writeFile(
        "packages/db/migrations/meta/_journal.json",
        JSON.stringify({
          dialect: "postgresql",
          entries: entries.map((e, idx) => ({
            breakpoints: true,
            idx,
            tag: e.tag,
            version: "7",
            when: 1_700_000_000_000 + idx * 1000,
          })),
          version: "7",
        })
      );
      for (const e of entries) {
        writeFile(`packages/db/migrations/${e.tag}.sql`, e.sql);
      }
      git("add", ".");
      git("commit", "-q", "-m", msg);
      return git("rev-parse", "HEAD");
    };

    git("init", "-q", "-b", "main");
    const m0 = {
      sql: `
        CREATE TABLE "research_screen_rows" (
          "report_id" text PRIMARY KEY NOT NULL,
          "status" text NOT NULL,
          CONSTRAINT "research_screen_rows_check" CHECK ("status" in ('ok', 'failed'))
        );
        CREATE INDEX "research_screen_rows_status_idx" ON "research_screen_rows" ("status");
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
            GRANT SELECT, INSERT, UPDATE ON TABLE "research_screen_rows" TO "vertex_research";
          END IF;
        END
        $$;
      `,
      tag: "0076_research_screen",
    };
    const m1 = {
      sql: `
        ALTER TABLE "research_screen_rows" DROP CONSTRAINT "research_screen_rows_check";
        ALTER TABLE "research_screen_rows" ADD CONSTRAINT "research_screen_rows_check" CHECK ("status" in ('ok', 'failed', 'stale'));
        CREATE TABLE "price_freshness_state" (
          "monitor" text PRIMARY KEY NOT NULL
        );
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "price_freshness_state" TO "vertex_research";
          END IF;
        END
        $$;
      `,
      tag: "0092_price_freshness_state",
    };
    const v1 = commitMigrations("add 0076", [m0]);
    const v2 = commitMigrations("add 0092", [m0, m1]);
    return { repo, v1, v2 };
  };

  const APPLIED_V1_SNAPSHOT = [
    "@@START\t\t\t",
    "T\tresearch_screen_rows\t\t",
    "C\tresearch_screen_rows\treport_id\tNO",
    "C\tresearch_screen_rows\tstatus\tNO",
    "I\tresearch_screen_rows_status_idx\t\t",
    "K\tresearch_screen_rows\tresearch_screen_rows_check\tCHECK ((status = ANY (ARRAY['ok'::text, 'failed'::text])))",
    "R\tvertex_research\t\t",
    "G\tresearch_screen_rows\tSELECT\t",
    "G\tresearch_screen_rows\tINSERT\t",
    "G\tresearch_screen_rows\tUPDATE\t",
    "@@END\t\t\t",
    "",
  ].join("\n");

  const APPLIED_V2_SNAPSHOT = [
    "@@START\t\t\t",
    "T\tresearch_screen_rows\t\t",
    "T\tprice_freshness_state\t\t",
    "C\tresearch_screen_rows\treport_id\tNO",
    "C\tresearch_screen_rows\tstatus\tNO",
    "C\tprice_freshness_state\tmonitor\tNO",
    "I\tresearch_screen_rows_status_idx\t\t",
    "K\tresearch_screen_rows\tresearch_screen_rows_check\tCHECK ((status = ANY (ARRAY['ok'::text, 'failed'::text, 'stale'::text])))",
    "R\tvertex_research\t\t",
    "G\tresearch_screen_rows\tSELECT\t",
    "G\tresearch_screen_rows\tINSERT\t",
    "G\tresearch_screen_rows\tUPDATE\t",
    "G\tprice_freshness_state\tSELECT\t",
    "G\tprice_freshness_state\tINSERT\t",
    "G\tprice_freshness_state\tUPDATE\t",
    "G\tprice_freshness_state\tDELETE\t",
    "@@END\t\t\t",
    "",
  ].join("\n");

  const runReal = (
    repo: string,
    args: string[] = [],
    extraEnv: Record<string, string> = {}
  ) =>
    run(args, {
      VERTEX_DEPLOY_GIT_DIR: repo,
      VERTEX_MIGRATIONS_CHECKER: "",
      ...extraEnv,
    });

  it("refuses restart (exit 15) when an unapplied migration exists and names the missing migration", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v1}\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), "@@START\t\t\t\n@@END\t\t\t\n");

    const result = runReal(g.repo);
    expect(result.status).toBe(15);
    expect(result.syntax).toEqual([]);
    expect(result.stdout).toContain("NOT RESTARTED: migration guard:");
    expect(result.stdout).toContain("0076_research_screen");
    expect(result.stdout).toContain("missing table research_screen_rows");
    expect(result.calls).toContain("migrations");
    expect(result.calls).not.toContain("probe");
    expect(result.calls).not.toContain("restart");
    expect(result.pauseLeft).toBe(false);
    expect(result.pauseSeen).toEqual([]);
    expect(result.migrationsCmd).toContain(
      "docker exec -i vertex-postgres psql"
    );
    expect(result.migrationsCmd).toContain("vertex_research_development");
    expect(result.migrationsCmd).not.toContain(
      "ibkr-nautilus-exec-node-postgres-1"
    );
  });

  it("refuses restart when a widened CHECK literal or app-role grant is missing", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v2}\ndeployed ${g.v1}\n`);
    // v1 is applied on prod, but v2 (0092) is not applied yet.
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);

    const result = runReal(g.repo);
    expect(result.status).toBe(15);
    expect(result.stdout).toContain("NOT RESTARTED: migration guard:");
    expect(result.stdout).toContain("0092_price_freshness_state");
    expect(result.stdout).toContain("missing table price_freshness_state");
    expect(result.stdout).toContain("missing 'stale'");
    expect(result.calls).not.toContain("restart");

    // Table and widened CHECK literal are present, but DELETE grant for vertex_research is missing.
    writeFileSync(
      join(dir, "migrations"),
      APPLIED_V2_SNAPSHOT.replace("G\tprice_freshness_state\tDELETE\t\n", "")
    );
    const missingGrant = runReal(g.repo);
    expect(missingGrant.status).toBe(15);
    expect(missingGrant.stdout).toContain("0092_price_freshness_state");
    expect(missingGrant.stdout).toContain(
      "missing vertex_research privilege DELETE on price_freshness_state"
    );
    expect(missingGrant.calls).not.toContain("restart");
  });

  it("proceeds to restart when all build migrations are applied (even without Drizzle ledger rows)", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v2}\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), APPLIED_V2_SNAPSHOT);

    const result = runReal(g.repo);
    expect(result.status).toBe(0);
    expect(result.syntax).toEqual([]);
    expect(result.stdout).toContain(
      "migrations: all 2 build migrations applied (2 structurally verified, 0 in drizzle ledger)"
    );
    expect(result.calls).toContain("migrations");
    expect(result.calls).toContain("restart");
    expect(result.calls.indexOf("migrations")).toBeGreaterThan(
      result.calls.indexOf("runtime")
    );
    expect(result.calls.indexOf("migrations")).toBeLessThan(
      result.calls.indexOf("probe")
    );
  });

  it("checks the staged build commit with --deploy and refuses when its new migration is missing", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "stage"), `staged ${g.v2}\n`);
    writeFileSync(join(dir, "shas"), `new ${g.v2}\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);
    writeFileSync(
      join(dir, "restart"),
      `build: swapped in ${g.v2} (previous build: dist.bak-1 with .wrangler.bak-1)\n`
    );

    const blocked = runReal(g.repo, ["--deploy", g.v2]);
    expect(blocked.status).toBe(15);
    expect(blocked.stdout).toContain("0092_price_freshness_state");
    expect(blocked.calls).not.toContain("restart");

    writeFileSync(join(dir, "migrations"), APPLIED_V2_SNAPSHOT);
    const passed = runReal(g.repo, ["--deploy", g.v2]);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(
      "migrations: all 2 build migrations applied"
    );
    expect(passed.calls).toContain("restart");
  });

  it("fails closed (exit 15) when Postgres cannot be read, snapshot is truncated, SHA is unknown, or commit is missing", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v1}\ndeployed ${g.v1}\n`);

    // 1. docker exec / ssh fails
    writeFileSync(join(dir, "migrations.fail"), "");
    const dbFail = runReal(g.repo);
    expect(dbFail.status).toBe(15);
    expect(dbFail.stdout).toContain(
      "cannot read database migration state from vertex-postgres"
    );
    expect(dbFail.calls).not.toContain("restart");
    rmSync(join(dir, "migrations.fail"));

    // 2. Truncated snapshot (no @@END)
    writeFileSync(
      join(dir, "migrations"),
      "@@START\t\t\t\nT\tresearch_screen_rows\t\t\n"
    );
    const truncated = runReal(g.repo);
    expect(truncated.status).toBe(15);
    expect(truncated.stdout).toContain(
      "incomplete Postgres migration snapshot"
    );
    expect(truncated.calls).not.toContain("restart");

    // 3. Unknown new SHA (even with --allow-older)
    writeFileSync(join(dir, "shas"), `new none\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);
    const unknownSha = runReal(g.repo, [
      "--allow-older",
      "test unknown sha",
      "--allow-stale-runtime",
      "test unknown sha",
    ]);
    expect(unknownSha.status).toBe(15);
    expect(unknownSha.stdout).toContain("the new build SHA is unknown");
    expect(unknownSha.calls).not.toContain("restart");

    // 4. Commit missing from checkout (equal SHAs pass version_guard without git lookup)
    writeFileSync(join(dir, "shas"), "new deadbeef\ndeployed deadbeef\n");
    const missingCommit = runReal(g.repo);
    expect(missingCommit.status).toBe(15);
    expect(missingCommit.stdout).toContain("cannot verify database migrations");
    expect(missingCommit.calls).not.toContain("restart");
  });

  it("allows unapplied migrations only with --allow-unapplied-migrations (with alert), and never skips failed reads", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v2}\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);

    const skipped = runReal(g.repo, [
      "--allow-unapplied-migrations",
      "emergency hotfix rollback",
    ]);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("migrations: WARNING guard skipped");
    expect(skipped.stdout).toContain("emergency hotfix rollback");
    expect(skipped.stdout).toContain("0092_price_freshness_state");
    expect(skipped.alerts).toHaveLength(1);
    expect(skipped.alerts[0]).toContain("migration guard skipped");
    expect(skipped.alerts[0]).toContain("emergency hotfix rollback");
    expect(skipped.calls).toContain("restart");

    // Failed Postgres read is NEVER skipped by --allow-unapplied-migrations.
    setup({});
    const g2 = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g2.v2}\ndeployed ${g2.v1}\n`);
    writeFileSync(join(dir, "migrations.fail"), "");
    const stillRefused = runReal(g2.repo, [
      "--allow-unapplied-migrations",
      "emergency hotfix",
    ]);
    expect(stillRefused.status).toBe(15);
    expect(stillRefused.alerts).toEqual([]);
    expect(stillRefused.calls).not.toContain("restart");

    // Truncated snapshot (checker exit 2) is NEVER skipped either.
    rmSync(join(dir, "migrations.fail"));
    writeFileSync(join(dir, "migrations"), "@@START\t\t\t\n");
    const stillRefusedTrunc = runReal(g2.repo, [
      "--allow-unapplied-migrations",
      "emergency hotfix",
    ]);
    expect(stillRefusedTrunc.status).toBe(15);
    expect(stillRefusedTrunc.alerts).toEqual([]);
    expect(stillRefusedTrunc.calls).not.toContain("restart");

    // Uncaught checker crash exiting 1 is NEVER treated as unapplied migrations (never skipped).
    writeFileSync(
      join(dir, "crash-checker.sh"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--print-sql" ]; then echo "SELECT 1;"; exit 0; fi
cat >/dev/null
echo "ReferenceError: simulated runtime crash" >&2
exit 1
`
    );
    chmodSync(join(dir, "crash-checker.sh"), 0o755);
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);
    const crashed = run(["--allow-unapplied-migrations", "emergency hotfix"], {
      VERTEX_DEPLOY_GIT_DIR: g2.repo,
      VERTEX_MIGRATIONS_CHECKER: join(dir, "crash-checker.sh"),
    });
    expect(crashed.status).toBe(15);
    expect(crashed.stdout).toContain("cannot verify database migrations");
    expect(crashed.stdout).toContain("simulated runtime crash");
    expect(crashed.alerts).toEqual([]);
    expect(crashed.calls).not.toContain("restart");

    // Rejects --allow-unapplied-migrations without a reason.
    const badArg = run(["--allow-unapplied-migrations"]);
    expect(badArg.status).toBe(2);
  });

  it("dry run prints migration guard decisions without refusing or alerting", () => {
    setup({});
    const g = migrationGitRepo();
    writeFileSync(join(dir, "shas"), `new ${g.v2}\ndeployed ${g.v1}\n`);
    writeFileSync(join(dir, "migrations"), APPLIED_V1_SNAPSHOT);

    const refused = runReal(g.repo, ["--dry-run"]);
    expect(refused.status).toBe(0);
    expect(refused.stdout).toContain("migration guard would refuse:");
    expect(refused.stdout).toContain("0092_price_freshness_state");
    expect(refused.alerts).toEqual([]);
    expect(refused.calls).not.toContain("restart");

    const skipped = runReal(g.repo, [
      "--dry-run",
      "--allow-unapplied-migrations",
      "dry run check",
    ]);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("migrations: WARNING guard skipped");
    expect(skipped.alerts).toEqual([]);

    writeFileSync(join(dir, "migrations"), APPLIED_V2_SNAPSHOT);
    const applied = runReal(g.repo, ["--dry-run"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain(
      "migrations: all 2 build migrations applied"
    );
  });
});
