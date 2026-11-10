import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendText,
  fileSize,
  readText,
  runCommand,
  systemTickIo,
  writeText,
} from "./system.ts";
import { bunSocket } from "./tradingview.ts";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "breadth-90-system-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { force: true, recursive: true });
  vi.unstubAllGlobals();
});

describe("breadth-90 system files", () => {
  it("writes through a temporary file and creates the directory", async () => {
    const path = join(root(), "state", "state.json");
    await writeText(path, "one");
    await writeText(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(join(path, ".."))).toEqual(["state.json"]);
  });

  it("appends and creates the directory", async () => {
    const path = join(root(), "state", "history.jsonl");
    await appendText(path, "a\n");
    await appendText(path, "b\n");
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });

  it("reads text and sizes, with null and 0 for a missing file", async () => {
    const dir = root();
    const path = join(dir, "file.txt");
    await writeText(path, "12345");
    expect(await readText(path)).toBe("12345");
    expect(await fileSize(path)).toBe(5);
    expect(await readText(join(dir, "missing"))).toBeNull();
    expect(await fileSize(join(dir, "missing"))).toBe(0);
  });
});

describe("breadth-90 system commands", () => {
  it("passes stdin and returns the exit code and stderr", async () => {
    expect(
      await runCommand("sh", ["-c", 'cat >&2; exit "$1"', "sh", "3"], "body")
    ).toEqual({ code: 3, stderr: "body" });
  });

  it("reports a signal kill as exit code 1", async () => {
    expect(await runCommand("sh", ["-c", "kill -9 $$"], "")).toEqual({
      code: 1,
      stderr: "",
    });
  });

  it("reports a command that cannot start as exit code 127", async () => {
    const result = await runCommand(join(root(), "no-such-command"), [], "");
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("systemTickIo", () => {
  it("wires the process, the home directory, the clock and the real access functions", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const host = {
      argv: ["bun", "tick.ts", "--dry-run", "--no-push"],
      env: { BREADTH90_STATE_DIR: "/s" },
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    } as unknown as NodeJS.Process;
    const before = Date.now();
    const io = systemTickIo(host);
    expect(io.argv).toEqual(["--dry-run", "--no-push"]);
    expect(io.env).toBe(host.env);
    expect(io.stderr).toBe(host.stderr);
    expect(io.stdout).toBe(host.stdout);
    expect(io.home).toBe(homedir());
    expect(io.now().getTime()).toBeGreaterThanOrEqual(before);
    expect(io.socket).toBe(bunSocket);
    expect([
      io.appendText,
      io.fileSize,
      io.readText,
      io.run,
      io.writeText,
    ]).toEqual([appendText, fileSize, readText, runCommand, writeText]);
    const init = { method: "POST" };
    expect(await (await io.fetch("https://example.com/x", init)).text()).toBe(
      "ok"
    );
    expect(fetch).toHaveBeenCalledWith("https://example.com/x", init);
  });
});
