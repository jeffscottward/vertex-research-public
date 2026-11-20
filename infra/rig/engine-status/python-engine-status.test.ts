import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The rig engine-status tests: timer and unit parsers (test_collect.py) and the market
// context snapshot (test_market_context.py; its ssh push is mocked). Standard-library
// unittest with fixtures and temporary directories only; nothing reaches QuantVPS or the
// rig's services. This test runs them so CI and pre-push cover them (card
// vertex-infra-unittest-ci-lane). Python gets a fresh TMPDIR, and the run must delete
// every folder it made; the finally block deletes the TMPDIR also after a failed run.
const here = fileURLToPath(new URL(".", import.meta.url));
const SUITES: readonly string[] = ["test_collect.py", "test_market_context.py"];
const PYTHON_TIMEOUT_MS = 120_000;

describe.each(SUITES)("engine-status %s", (name) => {
  it("passes under python3 and leaves no temp folders", {
    timeout: PYTHON_TIMEOUT_MS + 30_000,
  }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vertex-engine-status-tmpdir-"));
    try {
      // -B: no __pycache__ in the source tree; -I: no user site packages (tempfile still reads TMPDIR).
      const result = spawnSync("python3", ["-B", "-I", "-W", "ignore", name], {
        cwd: here,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: tempDir },
        timeout: PYTHON_TIMEOUT_MS,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      // A plain OK line: any skipped test fails this check.
      expect(result.stderr).toMatch(/^OK$/mu);
      expect(readdirSync(tempDir), "temp folders left by the run").toEqual([]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
