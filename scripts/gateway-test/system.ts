import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GatewayCommand,
  GatewayDependencies,
  GatewayResult,
} from "./runner.ts";

export const runGatewayCommand = (command: GatewayCommand): GatewayResult => {
  const result = spawnSync(command.executable, [...command.arguments], {
    cwd: command.cwd,
    env: { ...command.environment },
    shell: false,
    encoding: "utf8",
    stdio: command.capture
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "inherit", "inherit"],
    timeout: 150_000,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
  });
  if (result.error !== undefined || result.status === null) {
    throw new Error("Gateway test subprocess failed to complete");
  }
  return { status: result.status, stdout: result.stdout ?? "" };
};

export const createGatewayDependencies = (): GatewayDependencies => ({
  platform: process.platform,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  socket: process.env["GATEWAY_TEST_DOCKER_SOCKET"],
  pythonLocation: process.env["pythonLocation"],
  run: runGatewayCommand,
  realpath: (path) => realpathSync(path),
  isFile: (path) => statSync(path).isFile(),
  isDirectory: (path) => statSync(path).isDirectory(),
  isSocket: (path) => statSync(path).isSocket(),
  temporaryDirectory: () => mkdtempSync(join(tmpdir(), "vertex-gateway-test-")),
  removeDirectory: (path) => rmSync(path, { recursive: true, force: true }),
  writeError: (message) => {
    process.stderr.write(message);
    return;
  },
});
