import { afterEach, describe, expect, it, vi } from "vitest";
import { scaledTimeout } from "./lib/test-timeout-scale.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.doUnmock("./gateway-test/runner.ts");
  vi.doUnmock("./gateway-test/system.ts");
  return vi.resetModules();
});

describe("gateway gate entrypoint", () => {
  return it.each([0, 1, 7])(
    "runs once with system dependencies and propagates status %i",
    async (status) => {
      const dependencies = Object.freeze({
        kind: "gateway-system-dependencies",
      });
      const createGatewayDependencies = vi.fn(() => dependencies);
      const runGatewayTests = vi.fn(() => status);
      vi.doMock("./gateway-test/runner.ts", () => ({ runGatewayTests }));
      vi.doMock("./gateway-test/system.ts", () => ({
        createGatewayDependencies,
      }));
      process.exitCode = 99;
      await import("./gateway-test.ts");
      expect(createGatewayDependencies).toHaveBeenCalledOnce();
      expect(runGatewayTests).toHaveBeenCalledExactlyOnceWith(dependencies);
      return expect(process.exitCode).toBe(status);
    },
    // The first case imports the entrypoint cold under coverage instrumentation; on a
    // loaded rig that import alone exceeded the 5 s default (local coverage shard 1/12 rerun).
    scaledTimeout(30_000)
  );
});
