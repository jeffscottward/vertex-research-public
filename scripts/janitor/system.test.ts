import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createJanitorDeps } from "./system.ts";

describe("janitor system adapters", () => {
  const dir = mkdtempSync(join(tmpdir(), "janitor-system-"));
  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const deps = createJanitorDeps(new Date("2026-11-01T00:00:00Z"));

  it("captures stdout and the exit status of a command", () => {
    expect(deps.now.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(deps.out).toBe(process.stdout);
    expect(deps.run("pwd", [], { cwd: dir })).toEqual({
      status: 0,
      stdout: `${dir}\n`,
    });
    expect(deps.run("false", [], { cwd: dir }).status).toBe(1);
  });

  it("streams inherited output and maps a signal death to status 1", () => {
    expect(deps.run("true", [], { cwd: dir, inherit: true })).toEqual({
      status: 0,
      stdout: "",
    });
    expect(deps.run("sh", ["-c", "kill -9 $$"], { cwd: dir }).status).toBe(1);
  });

  it("writes files and reads them back, or undefined when absent", () => {
    const path = join(dir, "busy.txt");
    expect(deps.readFile(path)).toBeUndefined();
    deps.writeFile(path, "a.ts\n");
    expect(deps.readFile(path)).toBe("a.ts\n");
  });

  it("defaults the clock to now", () => {
    expect(
      Math.abs(createJanitorDeps().now.getTime() - Date.now())
    ).toBeLessThan(60_000);
  });
});
