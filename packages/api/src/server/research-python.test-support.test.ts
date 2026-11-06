import { afterEach, describe, expect, it, vi } from "vitest";

// The module reads VERTEX_TEST_PYTHON and CI once at import, so each case
// loads a fresh copy under stubbed variables.
const load = async (python: string | undefined, ci: string | undefined) => {
  vi.resetModules();
  vi.stubEnv("VERTEX_TEST_PYTHON", python);
  vi.stubEnv("CI", ci);
  return import("./research-python.test-support.ts");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("VERTEX_TEST_PYTHON resolution", () => {
  it("uses a configured interpreter as given and never skips", async () => {
    const support = await load("/configured/python", undefined);
    expect(support.testPython).toBe("/configured/python");
    expect(support.requireTestPython()).toBe("/configured/python");
    expect(support.skipWithoutTestPython).toBe(false);
    expect(support.researchParityPython).toBe("/configured/python");
    expect(support.researchParityPythonSkip).toBe(false);
    expect(support.pinnedPython({ absent: "1" })).toMatchObject({
      python: "/configured/python",
      skip: false,
    });
  });

  it("skips locally and fails in CI without an interpreter", async () => {
    const local = await load(undefined, undefined);
    expect(local.testPython).toBe("python3");
    expect(local.skipWithoutTestPython).toBe(true);
    expect(() => local.requireTestPython()).toThrow("VERTEX_TEST_PYTHON");
    expect(local.researchParityPythonSkipNote).toContain("VERTEX_TEST_PYTHON");
    const ci = await load(undefined, "true");
    expect(ci.skipWithoutTestPython).toBe(false);
  });

  it("probes python3 for pinned distributions when unconfigured", async () => {
    const support = await load(undefined, undefined);
    const first = support.pinnedPython({
      "vertex-absent-test-distribution": "1",
    });
    expect(first).toMatchObject({ python: "python3", skip: true });
    expect(first.note).toContain("VERTEX_TEST_PYTHON");
    expect(
      support.pinnedPython({ "vertex-absent-test-distribution": "1" })
    ).toEqual(first);
  });
});
