import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

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

// The entry has no exports: importing it runs it, as `bun
// scripts/install-dependencies.ts` does. A static import would run it once at
// load; resetModules plus a dynamic import runs it again in each test.
const runEntry = async (): Promise<number | string | undefined> => {
  vi.resetModules();
  process.exitCode = undefined;
  await import("./install-dependencies.ts");
  return process.exitCode;
};

let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  mocks.spawnSync.mockReset();
  vi.unstubAllEnvs();
  return vi.restoreAllMocks();
});

it("runs one frozen-lockfile pnpm install outside Git's hook repository", async () => {
  vi.stubEnv("GIT_DIR", "/repository/.git");
  mocks.spawnSync.mockReturnValue(spawnResult(0));
  expect(await runEntry()).toBe(0);
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

it("fails with pnpm's exit code so the turbo run after it never starts", async () => {
  const errorOutput = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  mocks.spawnSync.mockReturnValue(spawnResult(7));
  expect(await runEntry()).toBe(7);
  return expect(errorOutput).toHaveBeenCalledWith(
    expect.stringContaining("dependency install failed (7)")
  );
});

it.each([
  [
    "cannot start",
    spawnResult(null, { error: new Error("spawnSync pnpm ENOENT") }),
  ],
  ["is killed", spawnResult(null, { signal: "SIGTERM" })],
])("fails with exit code 1 when pnpm %s", async (_case, result) => {
  const errorOutput = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  mocks.spawnSync.mockReturnValue(result);
  expect(await runEntry()).toBe(1);
  return expect(errorOutput).toHaveBeenCalledWith(
    expect.stringContaining("dependency install failed (1)")
  );
});
