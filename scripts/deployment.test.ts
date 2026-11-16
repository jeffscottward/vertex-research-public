import { describe, expect, it, vi } from "vitest";

// The entrypoint runs its CLI with top-level await, so each exit status needs
// a fresh evaluation: vi.resetModules() and a dynamic import. Both evaluations
// run here, while Vitest collects the file, where no test time limit applies.
// The tests then only check the recorded calls. When the import ran inside
// the test, the first case once timed out at 5 s on a loaded rig (1 of 20
// coverage-shard runs, 5123 ms; card vertex-deployment-test-timeout). The
// cause was not reproduced; this keeps module loading out of every test limit.
const mocks = vi.hoisted(() => {
  const state = {
    dependencies: Object.freeze({ kind: "deployment-dependencies" }),
    status: 0,
  };
  return {
    createWebDeploymentDependencies: vi.fn(() => state.dependencies),
    runWebDeploymentCli: vi.fn(
      async (_argv: readonly string[], _dependencies: unknown) => state.status
    ),
    state,
  };
});

vi.mock("./deployment/cli.ts", () => ({
  runWebDeploymentCli: mocks.runWebDeploymentCli,
}));
vi.mock("./deployment/runtime.ts", () => ({
  createWebDeploymentDependencies: mocks.createWebDeploymentDependencies,
}));

const runEntrypoint = async (status: number) => {
  const originalExitCode = process.exitCode;
  const originalArgv = process.argv;
  mocks.createWebDeploymentDependencies.mockClear();
  mocks.runWebDeploymentCli.mockClear();
  mocks.state.status = status;
  process.argv = ["bun", "scripts/deployment.ts", "--environment", "staging"];
  process.exitCode = 99;
  try {
    vi.resetModules();
    // A static import evaluates the entrypoint once; each status needs its
    // own evaluation of the top-level await.
    await import("./deployment.ts");
    return {
      cliCalls: mocks.runWebDeploymentCli.mock.calls.slice(),
      dependencyCalls: mocks.createWebDeploymentDependencies.mock.calls.slice(),
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = originalExitCode;
    process.argv = originalArgv;
  }
};

const runs = new Map([
  [0, await runEntrypoint(0)],
  [1, await runEntrypoint(1)],
]);

describe("web deployment entrypoint", () => {
  it.each([0, 1])(
    "hands only the operator arguments and runtime adapters to the CLI (exit %i)",
    (status) => {
      const run = runs.get(status);
      expect(run?.dependencyCalls).toEqual([[]]);
      expect(run?.cliCalls).toEqual([
        [["--environment", "staging"], mocks.state.dependencies],
      ]);
      expect(run?.cliCalls[0]?.[1]).toBe(mocks.state.dependencies);
      expect(run?.exitCode).toBe(status);
    }
  );
});
