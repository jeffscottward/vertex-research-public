import { describe, expect, it } from "vitest";

import { spawnOpenbbFetcher } from "./spawn.ts";

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

  it("passes only the given environment", async () => {
    await expect(
      spawnOpenbbFetcher("sh", ["-c", 'printf "${SECRET:-unset}"'], {
        cwd: "/",
        env,
      })
    ).resolves.toMatchObject({ exitCode: 0, stdout: "unset" });
  });

  it("reports a signal kill as exit code 1", async () => {
    await expect(
      spawnOpenbbFetcher("sh", ["-c", "kill -TERM $$"], { cwd: "/", env })
    ).resolves.toMatchObject({ exitCode: 1 });
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
