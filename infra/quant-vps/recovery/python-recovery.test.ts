import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The IBKR recovery service tests (vertex_ibkr_recovery.py: login states, 2FA request, arm status).
// Standard-library unittest, fake Docker and temporary directories only; nothing reaches QuantVPS.
// This test runs it so CI and pre-push cover it (card vertex-status-b1-quantvps).
const here = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_TIMEOUT_MS = 120_000;

describe("test_vertex_ibkr_recovery.py", () => {
  it("passes under python3", { timeout: PYTHON_TIMEOUT_MS + 30_000 }, () => {
    // -B: no __pycache__ in the source tree; -I: no user site packages.
    const result = spawnSync(
      "python3",
      ["-B", "-I", "-W", "ignore", "test_vertex_ibkr_recovery.py"],
      { cwd: here, encoding: "utf8", timeout: PYTHON_TIMEOUT_MS }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/^OK$/mu);
  });
});
