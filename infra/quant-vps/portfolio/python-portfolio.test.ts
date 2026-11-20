import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The QuantVPS portfolio service tests (vertex_portfolio.py: account states, snapshots, HTTP API).
// Standard-library unittest with a fake IBKR client and HTTP on 127.0.0.1 only; nothing reaches
// QuantVPS or IBKR. This test runs it so CI and pre-push cover it (card vertex-infra-unittest-ci-lane).
// Python gets a fresh TMPDIR, and the run must delete every folder it made; the finally block
// deletes the TMPDIR also after a failed or killed run.
const here = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_TIMEOUT_MS = 120_000;

describe("test_vertex_portfolio.py", () => {
  it("passes under python3 and leaves no temp folders", {
    timeout: PYTHON_TIMEOUT_MS + 30_000,
  }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vertex-portfolio-tmpdir-"));
    try {
      // -B: no __pycache__ in the source tree; -I: no user site packages (tempfile still reads TMPDIR).
      const result = spawnSync(
        "python3",
        ["-B", "-I", "-W", "ignore", "test_vertex_portfolio.py"],
        {
          cwd: here,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: tempDir },
          timeout: PYTHON_TIMEOUT_MS,
        }
      );
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
