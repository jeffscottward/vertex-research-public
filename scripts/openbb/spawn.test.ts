import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createOpenbbFetcherSpawn,
  OPENBB_EXIT_GRACE_MS,
  OPENBB_STDOUT_MAX_BYTES,
  spawnOpenbbFetcher,
} from "./spawn.ts";

const env = { PATH: process.env["PATH"] };
const limit = 30_000;

/** Kills the process whose pid the test child wrote to `file`, when it wrote one. */
const killFrom = (file: string) => {
  try {
    process.kill(Number(readFileSync(file, "utf8").trim()), "SIGKILL");
  } catch {
    // No pid file, or the process is gone.
  }
};

describe("spawnOpenbbFetcher", () => {
  it("collects stdout, stderr and the exit code", async () => {
    await expect(
      spawnOpenbbFetcher(
        "sh",
        ["-c", 'printf out; printf err >&2; printf "$PWD" >&2; exit 3'],
        { cwd: "/", env, timeoutMs: limit }
      )
    ).resolves.toEqual({ exitCode: 3, stderr: "err/", stdout: "out" });
  });

  it("passes only the given environment, never the parent's", async () => {
    const before = process.env["VERTEX_AGENT_API_KEY"];
    process.env["VERTEX_AGENT_API_KEY"] = "leak";
    try {
      await expect(
        spawnOpenbbFetcher(
          "sh",
          ["-c", 'printf "${VERTEX_AGENT_API_KEY:-unset}"'],
          { cwd: "/", env, timeoutMs: limit }
        )
      ).resolves.toMatchObject({ exitCode: 0, stdout: "unset" });
    } finally {
      if (before === undefined) delete process.env["VERTEX_AGENT_API_KEY"];
      else process.env["VERTEX_AGENT_API_KEY"] = before;
    }
  });

  it("reports a signal kill as exit code 1", async () => {
    await expect(
      spawnOpenbbFetcher("sh", ["-c", "kill -TERM $$"], {
        cwd: "/",
        env,
        timeoutMs: limit,
      })
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("kills the fetcher and rejects when stdout passes the cap", async () => {
    expect(OPENBB_STDOUT_MAX_BYTES).toBe(64 * 1024 * 1024);
    const capped = createOpenbbFetcherSpawn(1024);
    await expect(
      capped("sh", ["-c", "exec yes"], {
        cwd: "/",
        env,
        timeoutMs: limit,
      })
    ).rejects.toThrow("fetcher stdout exceeded 1024 bytes");
    // Multi-byte UTF-8 split across chunks still decodes once, at the end.
    await expect(
      capped("sh", ["-c", "printf 'caf\\303\\251'"], {
        cwd: "/",
        env,
        timeoutMs: limit,
      })
    ).resolves.toMatchObject({ stdout: "café" });
  });

  it("kills the fetcher and rejects at the time limit, even when a descendant holds stdout", async () => {
    const folder = mkdtempSync(join(tmpdir(), "openbb-spawn-"));
    const pidFile = join(folder, "pid");
    try {
      const started = Date.now();
      // The fetcher keeps running; its background sleep keeps stdout open after the kill.
      await expect(
        spawnOpenbbFetcher(
          "sh",
          ["-c", `sleep 30 & echo $! >${pidFile}; exec sleep 30`],
          {
            cwd: "/",
            env,
            timeoutMs: 300,
          }
        )
      ).rejects.toThrow(
        "fetcher still running after the 0.3 s time limit; killed"
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      // The descendant stays in the tick's process group, which tick-runner kills after the step.
      killFrom(pidFile);
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("rejects at the stdout cap without waiting for a descendant that holds stdout", async () => {
    const folder = mkdtempSync(join(tmpdir(), "openbb-spawn-"));
    const pidFile = join(folder, "pid");
    try {
      const started = Date.now();
      await expect(
        createOpenbbFetcherSpawn(1024)(
          "sh",
          ["-c", `sleep 30 & echo $! >${pidFile}; exec yes`],
          { cwd: "/", env, timeoutMs: limit }
        )
      ).rejects.toThrow("fetcher stdout exceeded 1024 bytes");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      killFrom(pidFile);
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("settles with the output once the fetcher exits, even when a descendant holds stdout", async () => {
    const folder = mkdtempSync(join(tmpdir(), "openbb-spawn-"));
    const pidFile = join(folder, "pid");
    try {
      const started = Date.now();
      await expect(
        spawnOpenbbFetcher(
          "sh",
          ["-c", `sleep 30 & echo $! >${pidFile}; printf ok; exit 0`],
          { cwd: "/", env, timeoutMs: limit }
        )
      ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
      expect(Date.now() - started).toBeLessThan(OPENBB_EXIT_GRACE_MS + 3000);
    } finally {
      killFrom(pidFile);
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      spawnOpenbbFetcher("/nonexistent/vertex-openbb-python", [], {
        cwd: "/",
        env,
        timeoutMs: limit,
      })
    ).rejects.toThrow(/ENOENT/u);
  });
});
