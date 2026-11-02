import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayDependencies, runGatewayCommand } from "./system.ts";
import type { GatewayCommand } from "./runner.ts";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdtempSync: vi.fn(),
  realpathSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  tmpdir: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({
  mkdtempSync: mocks.mkdtempSync,
  realpathSync: mocks.realpathSync,
  rmSync: mocks.rmSync,
  statSync: mocks.statSync,
}));
vi.mock("node:os", () => ({ tmpdir: mocks.tmpdir }));

const command: GatewayCommand = {
  executable: "docker",
  arguments: ["--host", "unix:///tmp/socket", "literal;not a shell command"],
  cwd: "/checkout with spaces",
  environment: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/owned-temp",
    DOCKER_CONFIG: "/owned-temp",
  },
  capture: true,
};

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  return vi.restoreAllMocks();
});

describe("gateway system adapter", () => {
  it.each([true, false])(
    "uses bounded structured argv and no inherited environment (capture %s)",
    (capture) => {
      vi.stubEnv("BROKER_PASSWORD", "synthetic-not-forwarded");
      vi.stubEnv("DOCKER_HOST", "tcp://remote.invalid:2375");
      vi.stubEnv("DOCKER_CONTEXT", "remote-context");
      vi.stubEnv("DOCKER_CONFIG", "/private/docker");
      vi.stubEnv("HTTP_PROXY", "http://proxy.invalid");
      vi.stubEnv("PYTHONPATH", "/private/python");
      vi.stubEnv("LD_LIBRARY_PATH", "/private/lib:/untrusted/lib");
      vi.stubEnv("PYTHONHOME", "/private/python-home");
      vi.stubEnv("PYTHONNOUSERSITE", "0");
      mocks.spawnSync.mockReturnValue({
        status: 7,
        stdout: capture ? "linux\n" : null,
      });
      expect(runGatewayCommand({ ...command, capture })).toEqual({
        status: 7,
        stdout: capture ? "linux\n" : "",
      });
      expect(mocks.spawnSync).toHaveBeenCalledExactlyOnceWith(
        "docker",
        [...command.arguments],
        {
          cwd: command.cwd,
          env: command.environment,
          shell: false,
          encoding: "utf8",
          stdio: [
            "ignore",
            capture ? "pipe" : "inherit",
            capture ? "pipe" : "inherit",
          ],
          timeout: 150_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_048_576,
        }
      );
      const options = mocks.spawnSync.mock.calls[0]![2] as {
        env: Record<string, string>;
      };
      expect(options.env).not.toBe(command.environment);
      return expect(Object.keys(options.env).sort()).toEqual([
        "DOCKER_CONFIG",
        "HOME",
        "PATH",
      ]);
    }
  );

  it.each([
    { status: null, signal: "SIGTERM", stdout: "" },
    { status: null, error: new Error("ENOENT"), stdout: "" },
    { status: 0, error: new Error("ETIMEDOUT"), stdout: "" },
  ])("fails closed on abnormal subprocess result %#", (result) => {
    mocks.spawnSync.mockReturnValue(result);
    return expect(() => runGatewayCommand(command)).toThrow(
      "subprocess failed to complete"
    );
  });

  it("does not swallow a synchronous spawn exception", () => {
    mocks.spawnSync.mockImplementation(() => {
      throw new Error("spawn unavailable");
    });
    return expect(() => runGatewayCommand(command)).toThrow(
      "spawn unavailable"
    );
  });

  it("wires only explicit socket/pythonLocation settings and owned filesystem operations", () => {
    vi.stubEnv("GATEWAY_TEST_DOCKER_SOCKET", "/local/docker.sock");
    vi.stubEnv("GATEWAY_TEST_IMAGE", "untrusted:latest");
    vi.stubEnv("DOCKER_HOST", "ssh://remote.invalid");
    vi.stubEnv("pythonLocation", "/opt/hostedtoolcache/Python/3.12.11/x64");
    const dependencies = createGatewayDependencies();
    expect(dependencies.platform).toBe(process.platform);
    expect(dependencies.root).toBe(
      fileURLToPath(new URL("../../", import.meta.url))
    );
    expect(dependencies.socket).toBe("/local/docker.sock");
    expect(dependencies.pythonLocation).toBe(
      "/opt/hostedtoolcache/Python/3.12.11/x64"
    );
    expect(dependencies).not.toHaveProperty("image");
    expect(dependencies.run).toBe(runGatewayCommand);
    mocks.realpathSync.mockReturnValue("/canonical/source.py");
    expect(dependencies.realpath("/source.py")).toBe("/canonical/source.py");
    expect(mocks.realpathSync).toHaveBeenCalledExactlyOnceWith("/source.py");
    mocks.statSync.mockReturnValue({
      isFile: () => true,
      isSocket: () => false,
      isDirectory: () => true,
    });
    expect(dependencies.isFile("/source.py")).toBe(true);
    expect(dependencies.isSocket("/not-a-socket")).toBe(false);
    expect(dependencies.isDirectory("/opt/python/lib")).toBe(true);
    expect(mocks.statSync.mock.calls).toEqual([
      ["/source.py"],
      ["/not-a-socket"],
      ["/opt/python/lib"],
    ]);
    mocks.tmpdir.mockReturnValue("/tmp");
    mocks.mkdtempSync.mockReturnValue("/tmp/vertex-gateway-test-owned");
    expect(dependencies.temporaryDirectory()).toBe(
      "/tmp/vertex-gateway-test-owned"
    );
    expect(mocks.mkdtempSync).toHaveBeenCalledExactlyOnceWith(
      "/tmp/vertex-gateway-test-"
    );
    dependencies.removeDirectory("/tmp/vertex-gateway-test-owned");
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(
      "/tmp/vertex-gateway-test-owned",
      { recursive: true, force: true }
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    dependencies.writeError("bounded failure\n");
    return expect(stderr).toHaveBeenCalledExactlyOnceWith("bounded failure\n");
  });

  it("does not infer a Docker socket from the user's context or remote host", () => {
    vi.stubEnv("GATEWAY_TEST_DOCKER_SOCKET", undefined);
    vi.stubEnv("DOCKER_HOST", "tcp://remote.invalid:2375");
    vi.stubEnv("DOCKER_CONTEXT", "remote");
    return expect(createGatewayDependencies().socket).toBeUndefined();
  });

  return it("preserves an unset pythonLocation for the deliberate system-interpreter fallback", () => {
    vi.stubEnv("pythonLocation", undefined);
    vi.stubEnv("PYTHONHOME", "/untrusted/python");
    vi.stubEnv("PATH", "/untrusted/bin");
    return expect(createGatewayDependencies().pythonLocation).toBeUndefined();
  });
});
