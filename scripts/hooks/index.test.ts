import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ readFileSync: mocks.readFileSync }));

import { runPostCheckout, runPreCommit } from "./index.ts";

const BUN_VERSION = "1.4.2";

const spawnResult = (status: number | null, stdout = "", error?: Error) => ({
  status,
  stdout,
  stderr: "",
  pid: 123,
  signal: null,
  ...(error === undefined ? {} : { error }),
});

type SpawnCall = [executable: string, arguments_: string[], options?: unknown];

const spawnCalls = (): SpawnCall[] => {
  const spawnMock = Reflect.get(mocks, "spawnSync") as object;
  const mockState = Reflect.get(spawnMock, "mock") as object;
  return Reflect.get(mockState, "calls") as SpawnCall[];
};

const preCommitCalls = () => {
  return spawnCalls().filter(([executable, arguments_]) => {
    return !(
      executable === "bun" &&
      arguments_.length === 1 &&
      arguments_[0] === "--version"
    );
  });
};
beforeEach(() => {
  vi.stubGlobal("Bun", { version: BUN_VERSION });
  mocks.readFileSync.mockReturnValue(`${BUN_VERSION}\n`);
  mocks.spawnSync.mockImplementation((executable, arguments_) => {
    return executable === "bun" && arguments_[0] === "--version"
      ? spawnResult(0, `${BUN_VERSION}\n`)
      : spawnResult(0);
  });
});

afterEach(() => {
  mocks.readFileSync.mockReset();
  mocks.spawnSync.mockReset();
  vi.unstubAllGlobals();
  return vi.restoreAllMocks();
});

describe("repository hooks", () => {
  it("runs staged Biome and Markdown scripts with case-insensitive, argument-safe paths", () => {
    mocks.spawnSync
      .mockReturnValueOnce(
        spawnResult(
          0,
          "src/file with space.TS\0README.MARKDOWN\0component.CIVET\0notes.txt\0"
        )
      )
      .mockReturnValue(spawnResult(0));

    expect(runPreCommit()).toBe(0);
    return expect(preCommitCalls()).toEqual([
      [
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        {
          encoding: "utf8",
          shell: false,
          stdio: ["ignore", "pipe", "inherit"],
        },
      ],
      [
        "bun",
        ["run", "format:staged", "--", "./src/file with space.TS"],
        {
          shell: false,
          stdio: "inherit",
        },
      ],
      [
        "bun",
        ["run", "lint:staged", "--", "./src/file with space.TS"],
        {
          shell: false,
          stdio: "inherit",
        },
      ],
      [
        "bun",
        ["run", "lint:markdown:staged", "--", "./README.MARKDOWN"],
        {
          shell: false,
          stdio: "inherit",
        },
      ],
    ]);
  });

  it("formats and lints staged TypeScript even when no Markdown is staged", () => {
    mocks.spawnSync
      .mockReturnValueOnce(spawnResult(0, "src/worker.TS\0"))
      .mockReturnValue(spawnResult(0));

    expect(runPreCommit()).toBe(0);
    return expect(preCommitCalls().slice(1)).toEqual([
      [
        "bun",
        ["run", "format:staged", "--", "./src/worker.TS"],
        { shell: false, stdio: "inherit" },
      ],
      [
        "bun",
        ["run", "lint:staged", "--", "./src/worker.TS"],
        { shell: false, stdio: "inherit" },
      ],
    ]);
  });

  it("silently accepts irrelevant, retired Civet, or empty path records", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.spawnSync.mockReturnValueOnce(
      spawnResult(0, "src/worker.CIVET\0notes.txt\0\0")
    );

    expect(runPreCommit()).toBe(0);
    expect(errorOutput).not.toHaveBeenCalled();
    return expect(preCommitCalls()).toHaveLength(1);
  });

  it("maps a failed staged-path lookup without hiding spawn errors or null statuses", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const spawnError = Object.assign(new Error("git executable unavailable"), {
      code: "ENOENT",
    });
    mocks.spawnSync.mockReturnValueOnce(spawnResult(null, "", spawnError));

    expect(runPreCommit()).toBe(1);
    return expect(errorOutput).toHaveBeenCalledWith(spawnError.message);
  });

  it("stops at each failed staged command", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mocks.spawnSync
      .mockReturnValueOnce(spawnResult(0, "src/index.ts\0README.md\0"))
      .mockReturnValueOnce(spawnResult(4));
    expect(runPreCommit()).toBe(4);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);

    mocks.spawnSync.mockReset();
    errorOutput.mockClear();
    mocks.spawnSync
      .mockReturnValueOnce(spawnResult(0, "src/index.ts\0README.md\0"))
      .mockReturnValueOnce(spawnResult(0))
      .mockReturnValueOnce(spawnResult(5));
    expect(runPreCommit()).toBe(5);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);

    mocks.spawnSync.mockReset();
    errorOutput.mockClear();
    mocks.spawnSync
      .mockReturnValueOnce(spawnResult(0, "README.md\0"))
      .mockReturnValueOnce(spawnResult(6));
    expect(runPreCommit()).toBe(6);
    return expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("returns success after a Biome-only staged batch reaches the terminal path", () => {
    mocks.spawnSync
      .mockReturnValueOnce(spawnResult(0, "src/index.ts\0"))
      .mockReturnValue(spawnResult(0));

    expect(runPreCommit()).toBe(0);
    expect(preCommitCalls()).toHaveLength(3);
    return expect(
      preCommitCalls()
        .slice(1)
        .map(([, arguments_]) => arguments_[1])
    ).toEqual(["format:staged", "lint:staged"]);
  });

  return it("wires the pre-commit entrypoint to its hook runner exit code", async () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      mocks.spawnSync.mockReturnValueOnce(spawnResult(0, ""));
      await import("./pre-commit.ts");
      expect(process.exitCode).toBe(0);
      return expect(mocks.spawnSync).toHaveBeenLastCalledWith(
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        expect.any(Object)
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("post-checkout dependency refresh", () => {
  const NULL_HEAD = "0".repeat(40);
  const HEAD = "a".repeat(40);
  const INSTALL = [
    "install",
    "--frozen-lockfile",
    "--prefer-offline",
    "--config.confirm-modules-purge=false",
  ];

  const lockfiles = (installed: string | undefined, current: string) => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path === "pnpm-lock.yaml") {
        return current;
      }
      if (path === "node_modules/.pnpm/lock.yaml" && installed !== undefined) {
        return installed;
      }
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    });
  };

  it("leaves branch switches, plain checkouts and current dependencies alone", () => {
    lockfiles("old", "new");
    expect(runPostCheckout([HEAD, HEAD, "1"])).toBe(0);
    expect(runPostCheckout([])).toBe(0);
    lockfiles(undefined, "new");
    expect(runPostCheckout([NULL_HEAD, HEAD, "1"])).toBe(0);
    lockfiles("same", "same");
    expect(runPostCheckout([NULL_HEAD, HEAD, "1"])).toBe(0);
    return expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("installs once, outside Git's hook repository, when a new worktree copied node_modules for another lockfile", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubEnv("GIT_DIR", "/repository/.git/worktrees/copy");
    try {
      lockfiles("old", "new");
      expect(runPostCheckout([NULL_HEAD, HEAD, "1"])).toBe(0);
      expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        "pnpm",
        INSTALL,
        expect.objectContaining({
          shell: false,
          stdio: ["ignore", "inherit", "inherit"],
        })
      );
      const [, , options] = spawnCalls()[0] as SpawnCall;
      expect(options).toHaveProperty("env");
      expect(options).not.toHaveProperty("env.GIT_DIR");
      return expect(errorOutput).toHaveBeenCalledWith(
        expect.stringContaining("does not match pnpm-lock.yaml")
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("warns but keeps the new worktree when the install fails", () => {
    const errorOutput = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    lockfiles("old", "new");
    mocks.spawnSync.mockReturnValue(spawnResult(1));

    expect(runPostCheckout([NULL_HEAD, HEAD, "1"])).toBe(0);
    expect(errorOutput).toHaveBeenCalledWith(
      `[hook] failed (1): ${["pnpm", ...INSTALL].map((word) => JSON.stringify(word)).join(" ")}`
    );
    return expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining("dependencies are stale")
    );
  });

  it("passes Git's hook arguments through the shell hook and skips worktrees from before the script", async () => {
    // node:child_process and node:fs are mocked in this file; the shell hook
    // needs the real modules.
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process"
      );
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directory = fs.mkdtempSync(join(tmpdir(), "post-checkout-argv-"));
    try {
      const executable = join(directory, "bun");
      fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
      fs.chmodSync(executable, 0o755);
      const runHook = (cwd: string) =>
        childProcess.spawnSync(
          "/bin/sh",
          [join(process.cwd(), ".husky/post-checkout"), NULL_HEAD, HEAD, "1"],
          {
            cwd,
            encoding: "utf8",
            env: { ...process.env, PATH: directory },
            shell: false,
          }
        );
      const current = runHook(process.cwd());
      expect(current.status).toBe(0);
      expect(current.stdout.trimEnd().split("\n")).toEqual([
        "scripts/hooks/post-checkout.ts",
        NULL_HEAD,
        HEAD,
        "1",
      ]);
      // Git runs the hook of the current checkout in the new worktree, which
      // can be on an older commit without the script.
      const older = runHook(directory);
      expect(older.status).toBe(0);
      return expect(older.stdout).toBe("");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  return it("wires the post-checkout entrypoint to its hook runner exit code", async () => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    try {
      process.argv = ["bun", "scripts/hooks/post-checkout.ts", HEAD, HEAD, "1"];
      process.exitCode = undefined;
      await import("./post-checkout.ts");
      expect(process.exitCode).toBe(0);
      return expect(mocks.spawnSync).not.toHaveBeenCalled();
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
    }
  });
});
