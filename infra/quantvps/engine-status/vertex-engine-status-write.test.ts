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
      // A real sh process: poll for its temp file (the condition), not a fixed sleep.
      const deadline = Date.now() + 20_000;
      while (!files(data).some((name) => name.startsWith(".push."))) {
        if (Date.now() > deadline) throw new Error("writer never started");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The whole SSH session's process group gets the signal, as on a dropped connection.
      process.kill(-(child.pid ?? 0), signal);
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
