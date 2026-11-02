import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_PYTHON_IMAGE,
  GATEWAY_TEST_ARGUMENTS,
  runGatewayTests,
  type GatewayDependencies,
  type GatewayResult,
} from "./runner.ts";

const fixture = () => {
  const run = vi.fn<GatewayDependencies["run"]>();
  run.mockReturnValueOnce({ status: 0, stdout: "linux\n" });
  run.mockReturnValueOnce({ status: 0, stdout: "linux\n" });
  run.mockReturnValue({ status: 0, stdout: "" });
  const dependencies: GatewayDependencies = {
    platform: "darwin",
    root: "/checkout with spaces;literal",
    socket: "/Users/developer/.docker/run/docker.sock",
    pythonLocation: undefined,
    run,
    realpath: vi.fn((path) => path),
    isFile: vi.fn(() => true),
    isDirectory: vi.fn(() => true),
    isSocket: vi.fn(() => true),
    temporaryDirectory: vi.fn(() => "/tmp/vertex-gateway-test-owned"),
    removeDirectory: vi.fn(),
    writeError: vi.fn(),
  };
  return { dependencies, run };
};

const expectClosed = (dependencies: GatewayDependencies): void => {
  expect(runGatewayTests(dependencies)).toBe(1);
  expect(dependencies.writeError).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("failed closed")
  );
};

describe("portable gateway test runner", () => {
  it("pins the full Python image that supplies the real OpenSSH test dependency", () => {
    return expect(GATEWAY_PYTHON_IMAGE).toBe(
      "python:3.12.11@sha256:c1a5d356638cc86bd865d9019efbc34a6b0c3ad15a21e5ab4eb57bd2d1c3f7ce"
    );
  });

  it.each([0, 1, 7, 137])(
    "runs the unchanged native command exactly once and returns status %i",
    (status) => {
      const { dependencies, run } = fixture();
      run.mockReset().mockReturnValue({ status, stdout: "" });
      expect(
        runGatewayTests({
          ...dependencies,
          platform: "linux",
          socket: undefined,
        })
      ).toBe(status);
      expect(run).toHaveBeenCalledExactlyOnceWith({
        executable: "/usr/bin/python3",
        arguments: [
          "-m",
          "unittest",
          "discover",
          "-s",
          "services/gateway",
          "-p",
          "test_infrastructure_probe.py",
        ],
        cwd: dependencies.root,
        environment: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
        },
        capture: false,
      });
      expect(dependencies.temporaryDirectory).not.toHaveBeenCalled();
      expect(dependencies.isSocket).not.toHaveBeenCalled();
      expect(dependencies.writeError).not.toHaveBeenCalled();
      expect(dependencies.isFile).toHaveBeenCalledExactlyOnceWith(
        "/usr/bin/python3"
      );
      expect(dependencies.realpath).not.toHaveBeenCalled();
      return expect(dependencies.isDirectory).not.toHaveBeenCalled();
    }
  );

  it.each([0, 7])(
    "selects setup-python's absolute interpreter and only its derived library directory (status %i)",
    (status) => {
      const { dependencies, run } = fixture();
      const pythonLocation = "/opt/hostedtoolcache/Python/3.12.11/x64";
      run.mockReset().mockReturnValue({ status, stdout: "" });
      const realpath = vi.fn((path: string) => {
        if (path === `${pythonLocation}/bin/python3`)
          return `${pythonLocation}/bin/python3.12`;
        return path;
      });
      expect(
        runGatewayTests({
          ...dependencies,
          platform: "linux",
          pythonLocation,
          realpath,
        })
      ).toBe(status);
      expect(run).toHaveBeenCalledExactlyOnceWith({
        executable: `${pythonLocation}/bin/python3.12`,
        arguments: GATEWAY_TEST_ARGUMENTS,
        cwd: dependencies.root,
        environment: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
          LD_LIBRARY_PATH: `${pythonLocation}/lib`,
        },
        capture: false,
      });
      expect(realpath.mock.calls).toEqual([
        [pythonLocation],
        [`${pythonLocation}/lib`],
        [`${pythonLocation}/bin/python3`],
      ]);
      expect(dependencies.isDirectory).toHaveBeenCalledExactlyOnceWith(
        `${pythonLocation}/lib`
      );
      return expect(dependencies.isFile).toHaveBeenCalledExactlyOnceWith(
        `${pythonLocation}/bin/python3.12`
      );
    }
  );

  it.each([
    "",
    "relative",
    "/opt/python/../other",
    "/opt/python:extra",
    "/opt/python\n",
    "/opt/python,extra",
  ])(
    "rejects unsafe explicit pythonLocation %s without falling back",
    (pythonLocation) => {
      const { dependencies, run } = fixture();
      expectClosed({ ...dependencies, platform: "linux", pythonLocation });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it.each(["root", "library", "interpreter"] as const)(
    "rejects an escaped setup-python %s path",
    (kind) => {
      const { dependencies, run } = fixture();
      const pythonLocation = "/opt/python";
      const selected = {
        root: pythonLocation,
        library: `${pythonLocation}/lib`,
        interpreter: `${pythonLocation}/bin/python3`,
      }[kind];
      const realpath = (path: string): string => {
        if (path === selected) return "/elsewhere";
        return path;
      };
      expectClosed({
        ...dependencies,
        platform: "linux",
        pythonLocation,
        realpath,
      });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it("rejects unsafe resolved interpreter paths even within the selected installation", () => {
    const { dependencies, run } = fixture();
    const pythonLocation = "/opt/python";
    const realpath = (path: string): string => {
      if (path.endsWith("/bin/python3"))
        return `${pythonLocation}/bin/python:unsafe`;
      return path;
    };
    expectClosed({
      ...dependencies,
      platform: "linux",
      pythonLocation,
      realpath,
    });
    return expect(run).not.toHaveBeenCalled();
  });

  it.each(["/opt/python", "/opt/python/lib", "/opt/python/bin/python3"])(
    "rejects missing explicit installation path %s without a fallback",
    (missing) => {
      const { dependencies, run } = fixture();
      const realpath = (path: string): string => {
        if (path === missing) throw new Error("ENOENT");
        return path;
      };
      expectClosed({
        ...dependencies,
        platform: "linux",
        pythonLocation: "/opt/python",
        realpath,
      });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it("requires the selected installation library path to be a directory", () => {
    const { dependencies, run } = fixture();
    expectClosed({
      ...dependencies,
      platform: "linux",
      pythonLocation: "/opt/python",
      isDirectory: () => false,
    });
    return expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, "/opt/python"])(
    "rejects a non-file interpreter for pythonLocation %s",
    (pythonLocation) => {
      const { dependencies, run } = fixture();
      expectClosed({
        ...dependencies,
        platform: "linux",
        pythonLocation,
        isFile: () => false,
      });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it.each([0, 3, 125, 137])(
    "runs the offline macOS container once and returns status %i",
    (status) => {
      const { dependencies, run } = fixture();
      run.mockReturnValue({ status, stdout: "" });
      expect(
        runGatewayTests({
          ...dependencies,
          pythonLocation: "/irrelevant:unsafe",
        })
      ).toBe(status);
      const prefix = [
        "--host",
        `unix://${dependencies.socket}`,
        "--config",
        "/tmp/vertex-gateway-test-owned",
      ];
      expect(run).toHaveBeenCalledTimes(3);
      expect(run.mock.calls.map(([command]) => command.arguments)).toEqual([
        [...prefix, "info", "--format", "{{.OSType}}"],
        [
          ...prefix,
          "image",
          "inspect",
          "--format",
          "{{.Os}}",
          GATEWAY_PYTHON_IMAGE,
        ],
        [
          ...prefix,
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65534:65534",
          "--pids-limit=64",
          "--memory=256m",
          "--memory-swap=256m",
          "--cpus=1",
          "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
          "--workdir=/workspace",
          "--mount",
          `type=bind,source=${dependencies.root}/services/gateway/infrastructure_probe.py,target=/workspace/services/gateway/infrastructure_probe.py,readonly`,
          "--mount",
          `type=bind,source=${dependencies.root}/services/gateway/test_infrastructure_probe.py,target=/workspace/services/gateway/test_infrastructure_probe.py,readonly`,
          "--entrypoint=/usr/bin/timeout",
          GATEWAY_PYTHON_IMAGE,
          "--signal=KILL",
          "120",
          "/usr/local/bin/python3",
          "-B",
          ...GATEWAY_TEST_ARGUMENTS,
        ],
      ]);
      for (const [command] of run.mock.calls) {
        expect(command.executable).toBe("docker");
        expect(command.cwd).toBe(dependencies.root);
        expect(command.environment).toEqual({
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp/vertex-gateway-test-owned",
          DOCKER_CONFIG: "/tmp/vertex-gateway-test-owned",
        });
      }
      expect(run.mock.calls.map(([command]) => command.capture)).toEqual([
        true,
        true,
        false,
      ]);
      expect(dependencies.removeDirectory).toHaveBeenCalledExactlyOnceWith(
        "/tmp/vertex-gateway-test-owned"
      );
      return expect(dependencies.writeError).not.toHaveBeenCalled();
    }
  );

  it.each(["win32", "freebsd", "unknown"])(
    "rejects unsupported host %s without spawning",
    (platform) => {
      const { dependencies, run } = fixture();
      expectClosed({ ...dependencies, platform });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it.each([
    undefined,
    "",
    "tcp://host:2375",
    "ssh://host",
    "relative.sock",
    "/tmp/../docker.sock",
    "/tmp/socket,host=remote",
    '/tmp/socket"',
    "/tmp/socket:remote",
    "/tmp/socket\n",
    "/tmp/socket\r",
    "/tmp/socket\0",
    "/tmp/socket\u007f",
  ])("rejects missing, remote or delimiter-bearing socket %s", (socket) => {
    const { dependencies, run } = fixture();
    expectClosed({ ...dependencies, socket });
    expect(run).not.toHaveBeenCalled();
    return expect(dependencies.temporaryDirectory).not.toHaveBeenCalled();
  });

  it("rejects an endpoint which is not a Unix socket", () => {
    const { dependencies, run } = fixture();
    expectClosed({ ...dependencies, isSocket: () => false });
    return expect(run).not.toHaveBeenCalled();
  });

  it.each(["relative", "/repo,private", "/repo/../other"])(
    "rejects unsafe resolved mount root %s",
    (root) => {
      const { dependencies, run } = fixture();
      expectClosed({ ...dependencies, root });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it.each(["infrastructure_probe.py", "test_infrastructure_probe.py"])(
    "rejects a source symlink for %s",
    (name) => {
      const { dependencies, run } = fixture();
      expectClosed({
        ...dependencies,
        realpath: (path) => (path.endsWith(name) ? "/private/source.py" : path),
      });
      return expect(run).not.toHaveBeenCalled();
    }
  );

  it("rejects non-regular source mounts", () => {
    const { dependencies, run } = fixture();
    expectClosed({ ...dependencies, isFile: () => false });
    return expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [1, { status: 1, stdout: "linux" }],
    [1, { status: 0, stdout: "windows" }],
    [1, { status: 0, stdout: "" }],
    [2, { status: 1, stdout: "linux" }],
    [2, { status: 0, stdout: "windows" }],
    [2, { status: 0, stdout: "" }],
  ] as const)("stops at failed Docker preflight %i", (stage, failure) => {
    const { dependencies, run } = fixture();
    const responses: GatewayResult[] = [
      { status: 0, stdout: "linux" },
      failure,
    ];
    if (stage === 1) responses.shift();
    run.mockReset().mockImplementation(() => responses.shift()!);
    expectClosed(dependencies);
    expect(run).toHaveBeenCalledTimes(stage);
    return expect(dependencies.removeDirectory).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])(
    "cleans owned configuration after Docker spawn exception %i",
    (stage) => {
      const { dependencies, run } = fixture();
      const responses = [
        { status: 0, stdout: "linux" },
        { status: 0, stdout: "linux" },
      ];
      let calls = 0;
      run.mockReset().mockImplementation(() => {
        calls += 1;
        if (calls === stage)
          throw new Error("synthetic secret subprocess detail");
        return responses.shift()!;
      });
      expectClosed(dependencies);
      expect(run).toHaveBeenCalledTimes(stage);
      expect(dependencies.removeDirectory).toHaveBeenCalledOnce();
      return expect(dependencies.writeError).not.toHaveBeenCalledWith(
        expect.stringContaining("synthetic secret")
      );
    }
  );

  it("fails closed on native spawn failure", () => {
    const { dependencies, run } = fixture();
    run.mockReset().mockImplementation(() => {
      throw new Error("missing Python");
    });
    expectClosed({ ...dependencies, platform: "linux" });
    return expect(run).toHaveBeenCalledOnce();
  });

  it("fails closed on unreadable sources, inaccessible sockets, and temporary configuration failures", () => {
    for (const field of [
      "realpath",
      "isFile",
      "isSocket",
      "temporaryDirectory",
    ] as const) {
      const { dependencies, run } = fixture();
      const unavailable = (): never => {
        throw new Error("unavailable");
      };
      expectClosed({ ...dependencies, [field]: unavailable });
      expect(run).not.toHaveBeenCalled();
      expect(dependencies.removeDirectory).not.toHaveBeenCalled();
    }
  });

  return it("does not report success when configuration cleanup fails", () => {
    const { dependencies, run } = fixture();
    const removeDirectory = (): never => {
      throw new Error("cleanup failed");
    };
    expectClosed({ ...dependencies, removeDirectory });
    return expect(run).toHaveBeenCalledTimes(3);
  });
});
