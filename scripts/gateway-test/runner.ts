import { isAbsolute, join, normalize } from "node:path";

export const GATEWAY_PYTHON_IMAGE =
  "python:3.12.11@sha256:c1a5d356638cc86bd865d9019efbc34a6b0c3ad15a21e5ab4eb57bd2d1c3f7ce";
export const GATEWAY_TEST_ARGUMENTS = Object.freeze([
  "-m",
  "unittest",
  "discover",
  "-s",
  "services/gateway",
  "-p",
  "test_infrastructure_probe.py",
]);
const SOURCE_NAMES = [
  "infrastructure_probe.py",
  "test_infrastructure_probe.py",
] as const;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

export type GatewayCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  capture: boolean;
}>;
export type GatewayResult = Readonly<{ status: number; stdout: string }>;
export type GatewayDependencies = Readonly<{
  platform: string;
  root: string;
  socket: string | undefined;
  pythonLocation: string | undefined;
  run: (command: GatewayCommand) => GatewayResult;
  realpath: (path: string) => string;
  isFile: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  isSocket: (path: string) => boolean;
  temporaryDirectory: () => string;
  removeDirectory: (path: string) => void;
  writeError: (message: string) => void;
}>;

const assertPath = (path: string): void => {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    /[,":\x00-\x1f\x7f]/u.test(path)
  ) {
    throw new Error(
      "Gateway test paths must be absolute, normalized and free of mount delimiters"
    );
  }
};

const runContainer = (dependencies: GatewayDependencies): number => {
  const { socket } = dependencies;
  if (socket === undefined) {
    throw new Error(
      "macOS requires GATEWAY_TEST_DOCKER_SOCKET pointing to a trusted local Unix Docker socket"
    );
  }
  assertPath(socket);
  if (!dependencies.isSocket(socket)) {
    throw new Error("Gateway test Docker endpoint is not a local Unix socket");
  }
  const root = dependencies.realpath(dependencies.root);
  assertPath(root);
  const sources = SOURCE_NAMES.map((name) => {
    const source = join(root, "services/gateway", name);
    if (
      dependencies.realpath(source) !== source ||
      !dependencies.isFile(source)
    ) {
      throw new Error(
        "Gateway test sources must be regular files inside services/gateway, not symlinks"
      );
    }
    return `type=bind,source=${source},target=/workspace/services/gateway/${name},readonly`;
  });
  const configuration = dependencies.temporaryDirectory();
  try {
    const environment = {
      PATH: SAFE_PATH,
      HOME: configuration,
      DOCKER_CONFIG: configuration,
    };
    const docker = (
      arguments_: readonly string[],
      capture: boolean
    ): GatewayResult => {
      return dependencies.run({
        executable: "docker",
        arguments: [
          "--host",
          `unix://${socket}`,
          "--config",
          configuration,
          ...arguments_,
        ],
        cwd: root,
        environment,
        capture,
      });
    };
    const engine = docker(["info", "--format", "{{.OSType}}"], true);
    if (engine.status !== 0 || engine.stdout.trim() !== "linux") {
      throw new Error(
        "Gateway tests require an accessible local Docker Linux engine"
      );
    }
    const identity = docker(
      ["image", "inspect", "--format", "{{.Os}}", GATEWAY_PYTHON_IMAGE],
      true
    );
    if (identity.status !== 0 || identity.stdout.trim() !== "linux") {
      throw new Error(
        "Gateway test image is absent or is not Linux; provision the pinned image explicitly"
      );
    }
    return docker(
      [
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
        ...sources.flatMap((source) => ["--mount", source]),
        "--entrypoint=/usr/bin/timeout",
        GATEWAY_PYTHON_IMAGE,
        "--signal=KILL",
        "120",
        "/usr/local/bin/python3",
        "-B",
        ...GATEWAY_TEST_ARGUMENTS,
      ],
      false
    ).status;
  } finally {
    dependencies.removeDirectory(configuration);
  }
};

const runNative = (dependencies: GatewayDependencies): number => {
  const environment: Record<string, string> = {
    PATH: SAFE_PATH,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  let executable = "/usr/bin/python3";
  const { pythonLocation } = dependencies;
  if (pythonLocation !== undefined) {
    assertPath(pythonLocation);
    if (dependencies.realpath(pythonLocation) !== pythonLocation) {
      throw new Error(
        "pythonLocation must be a canonical local installation directory"
      );
    }
    const library = join(pythonLocation, "lib");
    if (
      dependencies.realpath(library) !== library ||
      !dependencies.isDirectory(library)
    ) {
      throw new Error(
        "pythonLocation must supply its own canonical library directory"
      );
    }
    executable = dependencies.realpath(join(pythonLocation, "bin/python3"));
    assertPath(executable);
    if (!executable.startsWith(`${join(pythonLocation, "bin")}/`)) {
      throw new Error(
        "pythonLocation interpreter must remain inside its installation bin directory"
      );
    }
    environment["LD_LIBRARY_PATH"] = library;
  }
  if (!dependencies.isFile(executable)) {
    throw new Error(
      "Gateway tests require the selected Python interpreter to be a regular file"
    );
  }
  return dependencies.run({
    executable,
    arguments: GATEWAY_TEST_ARGUMENTS,
    cwd: dependencies.root,
    environment,
    capture: false,
  }).status;
};

export const runGatewayTests = (dependencies: GatewayDependencies): number => {
  try {
    if (dependencies.platform === "linux") return runNative(dependencies);
    if (dependencies.platform === "darwin") return runContainer(dependencies);
    throw new Error(
      "Gateway tests support Linux or macOS with the documented local Linux-container prerequisite"
    );
  } catch {
    dependencies.writeError(
      "Gateway tests failed closed. Check the local-development.md Python/Docker prerequisites; no tests were skipped.\n"
    );
    return 1;
  }
};
