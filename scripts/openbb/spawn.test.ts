import { describe, expect, it } from "vitest";

import {
  createOpenbbFetcherSpawn,
  OPENBB_STDOUT_MAX_BYTES,
  spawnOpenbbFetcher,
} from "./spawn.ts";

const env = { PATH: process.env["PATH"] };

describe("spawnOpenbbFetcher", () => {
  it("collects stdout, stderr and the exit code", async () => {
    await expect(
      spawnOpenbbFetcher(
        "sh",
        ["-c", 'printf out; printf err >&2; printf "$PWD" >&2; exit 3'],
        { cwd: "/", env }
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
          { cwd: "/", env }
        )
      ).resolves.toMatchObject({ exitCode: 0, stdout: "unset" });
    } finally {
      if (before === undefined) delete process.env["VERTEX_AGENT_API_KEY"];
      else process.env["VERTEX_AGENT_API_KEY"] = before;
    }
  });

  it("reports a signal kill as exit code 1", async () => {
    await expect(
      spawnOpenbbFetcher("sh", ["-c", "kill -TERM $$"], { cwd: "/", env })
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("kills the fetcher and rejects when stdout passes the cap", async () => {
    expect(OPENBB_STDOUT_MAX_BYTES).toBe(64 * 1024 * 1024);
    const capped = createOpenbbFetcherSpawn(1024);
    await expect(
      capped("sh", ["-c", "exec yes"], {
        cwd: "/",
        env,
      })
    ).rejects.toThrow("fetcher stdout exceeded 1024 bytes");
    // Multi-byte UTF-8 split across chunks still decodes once, at the end.
    await expect(
      capped("sh", ["-c", "printf 'caf\\303\\251'"], { cwd: "/", env })
    ).resolves.toMatchObject({ stdout: "café" });
  });

  it("rejects when the command cannot start", async () => {
    await expect(
      spawnOpenbbFetcher("/nonexistent/vertex-openbb-python", [], {
        cwd: "/",
        env,
      })
    ).rejects.toThrow(/ENOENT/u);
  });
});
