import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The exec-node broker-safety tests are standard-library Python unittest files:
// the kill switch clears the arm record (test_arm_killswitch.py), the
// options-only, defined-risk order policy with its 2% max-loss cap and
// persisted close reservations (test_order_policy.py), the run_live.py
// signal-intake removal (test_no_signal_intake.py), the disabled
// direct-placeOrder host script (test_transmit_disabled.py), plus the
// file-only checks of test_exec_node.py that pin those owned files against the
// frozen manifest. This test runs them so CI and pre-push cover them. They use
// temporary directories and fake clients only; nothing reaches a broker,
// Docker or QuantVPS.
const here = fileURLToPath(new URL(".", import.meta.url));
const SUITES: ReadonlyArray<{ name: string; args: readonly string[] }> = [
  { name: "test_arm_killswitch.py", args: [] },
  { name: "test_order_policy.py", args: [] },
  { name: "test_no_signal_intake.py", args: [] },
  { name: "test_transmit_disabled.py", args: [] },
  { name: "test_exec_node.py", args: ["OwnedRuntimeTests", "ManifestTests"] },
];
const PYTHON_TIMEOUT_MS = 120_000;

describe.each(SUITES)("exec-node $name", ({ name, args }) => {
  it("passes under python3", { timeout: PYTHON_TIMEOUT_MS + 30_000 }, () => {
    // -B: no __pycache__ under runtime/ (test_exec_node.py lists that tree).
    const result = spawnSync(
      "python3",
      ["-B", "-I", "-W", "ignore", name, ...args],
      {
        cwd: here,
        encoding: "utf8",
        timeout: PYTHON_TIMEOUT_MS,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/^OK$/mu);
  });
});
