import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The QuantVPS status collector tests (collect.py: session states, kill switch, redaction).
// Standard-library unittest, fake Docker and temporary directories only; nothing reaches QuantVPS.
// This test runs it so CI and pre-push cover it (card vertex-status-b1-quantvps).
// Python gets a fresh TMPDIR, and the run must delete every folder it made: before card
// rig-tmp-vx-hist-recurred each run left 19 vx-status-* folders in /tmp. The finally block
// deletes the TMPDIR also after a failed or killed run.
const here = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_TIMEOUT_MS = 120_000;

describe("test_collect.py", () => {
  it("passes under python3 and leaves no temp folders", {
    timeout: PYTHON_TIMEOUT_MS + 30_000,
  }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vertex-status-tmpdir-"));
    try {
      // -B: no __pycache__ in the source tree; -I: no user site packages (tempfile still reads TMPDIR).
      const result = spawnSync(
        "python3",
        ["-B", "-I", "-W", "ignore", "test_collect.py"],
        {
          cwd: here,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: tempDir },
          timeout: PYTHON_TIMEOUT_MS,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toMatch(/^OK$/mu);
      expect(readdirSync(tempDir), "temp folders left by the run").toEqual([]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
