import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// test_odte_quotes.py holds the standard-library Python unittest tests of the
// read-only SPY 0DTE quote collector (card vertex-noise-band-0dte-collect):
// strike selection, the files it writes, resume after an IBKR error, the
// missed-day check and the static scan that allows only reqContractDetails and
// reqHistoricalData. This test runs the file so pre-push and CI cover it. The
// Python tests use a fake IBKR source and need the standard library only;
// nothing reaches a broker, QuantVPS or Discord. install.sh runs the same file
// on QuantVPS before it installs anything.
const here = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_TIMEOUT_MS = 60_000;

describe("odte-quotes test_odte_quotes.py", () => {
  it("passes under python3 without skips and leaves no temp folders", {
    timeout: PYTHON_TIMEOUT_MS + 30_000,
  }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "odte-quotes-tmpdir-"));
    try {
      // -B: no __pycache__ next to the sources. NO_COLOR: Python 3.14 colors -v lines under FORCE_COLOR.
      const result = spawnSync(
        "python3",
        ["-B", "-I", "-W", "ignore", "test_odte_quotes.py", "-v"],
        {
          cwd: here,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1", TMPDIR: tempDir },
          timeout: PYTHON_TIMEOUT_MS,
        }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(result.stderr, output).toMatch(/^OK$/mu);
      expect(result.stderr, output).not.toMatch(/ \.\.\. skipped /u);
      expect(readdirSync(tempDir), "temp folders left by the run").toEqual([]);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
