import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

import { runDependencyInstall } from "./dependencies.ts";

const INSTALL = [
  "install",
  "--frozen-lockfile",
  "--prefer-offline",
  "--config.confirm-modules-purge=false",
];

const spawnResult = (
  status: number | null,
  extra: Readonly<{ error?: Error; signal?: NodeJS.Signals }> = {}
) => ({ status, signal: null, stdout: null, stderr: null, pid: 1, ...extra });

afterEach(() => {
  mocks.spawnSync.mockReset();
  vi.unstubAllEnvs();
  return vi.restoreAllMocks();
});

describe("runDependencyInstall", () => {
  it("runs one frozen-lockfile pnpm install outside Git's hook repository", () => {
    vi.stubEnv("GIT_DIR", "/repository/.git");
    mocks.spawnSync.mockReturnValue(spawnResult(0));
    expect(runDependencyInstall()).toBe(0);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "pnpm",
      INSTALL,
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
      })
    );
    const [, , options] = mocks.spawnSync.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(options.env).not.toHaveProperty("GIT_DIR");
    return expect(options.env["PATH"]).toBe(process.env["PATH"]);
  });

  it("fails with pnpm's exit code", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.spawnSync.mockReturnValue(spawnResult(7));
    expect(runDependencyInstall()).toBe(7);
    return expect(errorOutput).toHaveBeenCalledWith(
      "[deps] dependency install failed (7); run pnpm install --frozen-lockfile"
    );
  });

  return it.each([
    [
      "cannot start",
      spawnResult(null, { error: new Error("spawnSync pnpm ENOENT") }),
      "spawnSync pnpm ENOENT",
    ],
    ["is killed", spawnResult(null, { signal: "SIGTERM" }), "SIGTERM"],
  ])("fails with exit code 1 when pnpm %s", (_case, result, cause) => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.spawnSync.mockReturnValue(result);
    expect(runDependencyInstall()).toBe(1);
    return expect(errorOutput).toHaveBeenCalledWith(
      `[deps] dependency install failed (1): ${cause}; run pnpm install --frozen-lockfile`
    );
  });
});

describe("bun scripts/install-dependencies.ts", () => {
  return it("exits with the install's exit code", async () => {
    const previousExitCode = process.exitCode;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.spawnSync.mockReturnValue(spawnResult(3));
    try {
      process.exitCode = undefined;
      // Importing the entrypoint is the behavior under test (it runs on load).
      await import("../install-dependencies.ts");
      expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
      return expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
