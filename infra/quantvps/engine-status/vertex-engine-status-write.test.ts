import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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

// Forced command of the rig status-push key (infra/rig/engine-status/README.md). The test runs a copy
// whose target directory is a temp folder, so nothing reaches QuantVPS.
const source = readFileSync(
  fileURLToPath(new URL("./vertex-engine-status-write", import.meta.url)),
  "utf8"
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "vtx-status-write-"));
  dirs.push(root);
  const data = join(root, "data");
  const script = join(root, "write");
  spawnSync("mkdir", [data]);
  const patched = source.replace(
    "d=/var/lib/vertex-engine-status",
    `d=${data}`
  );
  expect(patched).not.toBe(source);
  writeFileSync(script, patched);
  chmodSync(script, 0o755);
  writeFileSync(join(data, "status.json"), "old-status");
  writeFileSync(join(data, "markets.json"), "old-markets");
  return { data, script };
};

// QuantVPS runs the forced command with /bin/sh = dash, which skips the EXIT trap when a signal kills
// it (bash runs it). Use dash when it is installed so the signal test matches production.
const SHELL =
  spawnSync("sh", ["-c", "command -v dash"], {
    encoding: "utf8",
  }).stdout.trim() || "sh";

const write = (script: string, input: string) =>
  spawnSync(SHELL, [script], { encoding: "utf8", input });

const files = (data: string) => readdirSync(data).sort();

// Linux /proc: commands of the processes in one process group. The writer is ready for the signal
// only when `head` runs (exec done): then mktemp has finished, $t is set and every trap is in place.
// The temp file alone is too early (card vertex-sighup-test-timeout; in 1000 loaded runs 14 hangs
// with bash as sh, 4 with dash):
// - A group signal that lands after mktemp but before head has exec'd reaches only the shell, or the
//   forked child while it still has the shell's handler. head never gets the signal, and the shell
//   defers its trap until head ends (POSIX), so head waits for stdin forever.
// - A signal inside the mktemp command substitution can leave $t empty, so the temp file stays.
const groupCommands = (group: number): string[] =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .flatMap((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[2]) === group
          ? [stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))]
          : [];
      } catch {
        return [];
      }
    });

describe("vertex-engine-status-write", () => {
  it("stores each schema in its own fixed file and rejects anything else", () => {
    const { data, script } = setup();
    const engines = JSON.stringify({ schema: "vertex-engine-status-v1" });
    const markets = JSON.stringify({ schema: "vertex-market-context-v1" });
    expect(write(script, engines).status).toBe(0);
    expect(write(script, markets).status).toBe(0);
    expect(readFileSync(join(data, "status.json"), "utf8")).toBe(engines);
    expect(readFileSync(join(data, "markets.json"), "utf8")).toBe(markets);
    for (const bad of ['{"schema":"other"}', '{"schema":[1]}', "[1]", "nope"]) {
      const result = write(script, bad);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("rejected");
    }
    expect(readFileSync(join(data, "status.json"), "utf8")).toBe(engines);
    expect(files(data)).toEqual(["markets.json", "status.json"]);
  });

  it.each(["SIGTERM", "SIGHUP"] as const)(
    "removes its temp file when a dropped session sends %s",
    async (signal) => {
      const { data, script } = setup();
      const child = spawn(SHELL, [script], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (code) => resolve(code))
      );
      child.stdin.write('{"schema":"vertex-market');
      // A real sh process: poll for the condition (temp file created, writer parked in head), not a
      // fixed sleep.
      const deadline = Date.now() + 20_000;
      while (
        !(
          files(data).some((name) => name.startsWith(".push.")) &&
          groupCommands(child.pid ?? 0).includes("head")
        )
      ) {
        if (Date.now() > deadline) throw new Error("writer never reached head");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The whole SSH session's process group gets the signal, as on a dropped connection.
      process.kill(-(child.pid ?? 0), signal);
      // A dropped connection also closes stdin. The signal is already pending in head, so it still
      // ends head; the EOF only guarantees that no missed signal can leave head waiting forever.
      child.stdin.end();
      // The writer's own trap exits with 128 + signal number. Without the trap the shell dies by
      // the signal (exit code null), so this also guards the fix where /bin/sh is bash.
      expect(await exited).toBe(signal === "SIGTERM" ? 143 : 129);
      expect(files(data)).toEqual(["markets.json", "status.json"]);
      expect(readFileSync(join(data, "markets.json"), "utf8")).toBe(
        "old-markets"
      );
    },
    // Spawning sh can take seconds when the full suite runs in parallel (acceptance shard); the
    // poll deadline above must stay inside this test timeout.
    30_000
  );
});
