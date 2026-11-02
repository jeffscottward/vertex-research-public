import { afterEach, describe, expect, it, vi } from "vitest";

const originalExitCode = process.exitCode;
const originalArgv = process.argv;

afterEach(() => {
  process.exitCode = originalExitCode;
  process.argv = originalArgv;
  vi.doUnmock("./deployment/cli.ts");
  vi.doUnmock("./deployment/runtime.ts");
  vi.resetModules();
});

describe("web deployment entrypoint", () => {
  it.each([0, 1])(
    "hands only the operator arguments and runtime adapters to the CLI (exit %i)",
    async (status) => {
      const dependencies = Object.freeze({ kind: "deployment-dependencies" });
      const createWebDeploymentDependencies = vi.fn(() => dependencies);
      const runWebDeploymentCli = vi.fn(async () => status);
      vi.doMock("./deployment/cli.ts", () => ({ runWebDeploymentCli }));
      vi.doMock("./deployment/runtime.ts", () => ({
        createWebDeploymentDependencies,
      }));
      process.argv = [
        "bun",
        "scripts/deployment.ts",
        "--environment",
        "staging",
      ];
      process.exitCode = 99;
      await import("./deployment.ts");
      expect(createWebDeploymentDependencies).toHaveBeenCalledExactlyOnceWith();
      expect(runWebDeploymentCli).toHaveBeenCalledExactlyOnceWith(
        ["--environment", "staging"],
        dependencies
      );
      expect(process.exitCode).toBe(status);
    }
  );
});
