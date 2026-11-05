import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The exec-node broker-safety tests are standard-library Python unittest files:
// the kill switch clears the arm record (test_arm_killswitch.py) and the
// options-only, defined-risk order policy (test_order_policy.py). This test
// runs them so CI and pre-push cover them. They use temporary directories and
// fake clients only; nothing reaches a broker or QuantVPS.
const here = fileURLToPath(new URL(".", import.meta.url));
const SUITES = ["test_arm_killswitch.py", "test_order_policy.py"] as const;
const PYTHON_TIMEOUT_MS = 120_000;

describe.each(SUITES)("exec-node %s", (suite) => {
  it("passes under python3", { timeout: PYTHON_TIMEOUT_MS + 30_000 }, () => {
    // -B: no __pycache__ under runtime/ (test_exec_node.py lists that tree).
    const result = spawnSync("python3", ["-B", "-I", "-W", "ignore", suite], {
      cwd: here,
      encoding: "utf8",
      timeout: PYTHON_TIMEOUT_MS,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/^OK$/mu);
  });
});
