import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nautilusProcessIo } from "./nautilus-process-io.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

describe("nautilusProcessIo", () => {
  it("makes a temp folder, writes and reads files, and runs a process", () => {
    const io = nautilusProcessIo("nautilus-io-test-");
    const dir = io.tempDir();
    dirs.push(dir);
    expect(basename(dir).startsWith("nautilus-io-test-")).toBe(true);
    expect(dir.startsWith(tmpdir())).toBe(true);
    const path = join(dir, "batch.json");
    io.writeText(path, "{}");
    expect(existsSync(path)).toBe(true);
    expect(io.readText(path)).toBe("{}");
    expect(
      io.spawn("sh", ["-c", "pwd; echo err >&2; exit 3"], dir)
    ).toMatchObject({
      status: 3,
      stderr: "err\n",
      stdout: `${dir}\n`,
    });
    io.removeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
