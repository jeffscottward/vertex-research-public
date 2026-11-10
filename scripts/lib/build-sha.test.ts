import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildShaEnvironment,
  readGitHead,
  runWithBuildSha,
} from "./build-sha.ts";
import { spawnInherited } from "./test-env.ts";

const HEAD = "94fc35b7c2d7fe0d06bf6e1069d0a3cef5dc10d6";
const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = [...originalArguments];
  process.exitCode = originalExitCode;
  vi.doUnmock("./build-sha.ts");
  vi.doUnmock("./test-env.ts");
  return vi.resetModules();
});

describe("buildShaEnvironment", () => {
  it("sets VERTEX_BUILD_SHA to git HEAD and keeps the rest", () => {
    expect(buildShaEnvironment({ KEEP: "1" }, () => `${HEAD}\n`)).toEqual({
      KEEP: "1",
      VERTEX_BUILD_SHA: HEAD,
    });
  });

  it("keeps a valid caller-supplied SHA without reading git", () => {
    const readHead = vi.fn(() => HEAD);
    const env = { VERTEX_BUILD_SHA: "0123abc" };
    expect(buildShaEnvironment(env, readHead)).toBe(env);
    expect(readHead).not.toHaveBeenCalled();
  });

  it("replaces an invalid caller value with HEAD, as Vite would", () => {
    expect(
      buildShaEnvironment({ VERTEX_BUILD_SHA: "not a sha" }, () => HEAD)
    ).toEqual({ VERTEX_BUILD_SHA: HEAD });
  });

  it("leaves the environment unchanged without a usable HEAD", () => {
    const env = { KEEP: "1" };
    expect(buildShaEnvironment(env, () => undefined)).toBe(env);
    expect(buildShaEnvironment(env, () => "garbage")).toBe(env);
  });
});

describe("runWithBuildSha", () => {
  it("prints usage without a command", async () => {
    const error = vi.fn();
    const spawn = vi.fn();
    expect(
      await runWithBuildSha([], { env: {}, error, readHead: () => HEAD, spawn })
    ).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Usage: bun scripts/with-build-sha.ts <command> [arguments...]"
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the command with the build SHA and returns its exit code", async () => {
    const spawn = vi.fn(async () => 5);
    expect(
      await runWithBuildSha(["bunx", "turbo", "run", "build"], {
        env: { KEEP: "1" },
        error: vi.fn(),
        readHead: () => HEAD,
        spawn,
      })
    ).toBe(5);
    expect(spawn).toHaveBeenCalledWith("bunx", ["turbo", "run", "build"], {
      KEEP: "1",
      VERTEX_BUILD_SHA: HEAD,
    });
  });
});

describe("readGitHead", () => {
  it("reads this checkout's HEAD", () => {
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    expect(readGitHead()).toBe(expected);
  });

  it("returns undefined outside a git checkout", () => {
    const original = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = "/nonexistent-darkfactory-git-dir";
    try {
      expect(readGitHead()).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = original;
    }
  });
});

describe("bun scripts/with-build-sha.ts", () => {
  it("forwards arguments and node dependencies from the root wrapper", async () => {
    const runWithBuildShaMock = vi.fn(
      async (
        _arguments: readonly string[],
        dependencies: Readonly<{ error: (line: string) => void }>
      ) => {
        dependencies.error("probe");
        return 6;
      }
    );
    vi.doMock("./build-sha.ts", () => ({
      readGitHead,
      runWithBuildSha: runWithBuildShaMock,
    }));
    vi.doMock("./test-env.ts", () => ({ spawnInherited }));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.argv = [
      "bun",
      "with-build-sha.ts",
      "bunx",
      "turbo",
      "run",
      "build",
    ];

    // Importing the entrypoint is the behavior under test (it runs on load).
    await import("../with-build-sha.ts");

    expect(runWithBuildShaMock).toHaveBeenCalledWith(
      ["bunx", "turbo", "run", "build"],
      expect.objectContaining({
        env: process.env,
        readHead: readGitHead,
        spawn: spawnInherited,
      })
    );
    expect(stderr).toHaveBeenCalledWith("probe\n");
    stderr.mockRestore();
    return expect(process.exitCode).toBe(6);
  });
});
