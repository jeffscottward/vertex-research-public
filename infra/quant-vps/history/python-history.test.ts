import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// test_vertex_history.py holds the standard-library Python unittest tests of the
// read-only IBKR history service: the static scan that fails on any order,
// account or position API name, the allow-list of IB client calls, and the pin
// of ibapi 9.81.1.post1 in install-history.sh. This test runs the file so
// pre-push and CI cover it. The Python tests use a fake IB client; the only
// sockets are local HTTP servers on 127.0.0.1. Nothing reaches a broker or
// QuantVPS. python3 comes from PATH, as in exec-node/python-safety.test.ts:
// the tests need the standard library only.
//
// The pin test skips when install-history.sh is not next to the test file. The
// QuantVPS install stage needs that skip. Here a skipped pin test must fail,
// so this test reads the -v lines: the pin test must report ok, and the only
// skip it accepts is the one test of IbapiSignatureTest, with the reason of a
// missing ibapi package. That test runs in the QuantVPS install stage, where
// ibapi is installed. ALLOWED_SKIP_REASON must stay equal to the skipUnless
// reason of that class.
//
// The Python tests make one disk cache folder per test service. This test gives
// Python a fresh TMPDIR and checks that the run deletes every folder it made:
// before card rig-tmp-vx-hist-recurred each run left 123 vx-hist-* folders in
// /tmp. The finally block deletes the TMPDIR also after a failed or killed run.
const here = fileURLToPath(new URL(".", import.meta.url));
const SUITE = "test_vertex_history.py";
const PYTHON_TIMEOUT_MS = 120_000;
// unittest -v prints "<test> (<class>)", then the first docstring line, then " ... ok".
const PIN_TEST_OK =
  /^test_ibapi_9_81_is_pinned \([^)]*\)(?:\n[^\n]*)? \.\.\. ok$/mu;
const SKIP_REASON = / \.\.\. skipped (.*)$/gmu;
const ALLOWED_SKIP_REASON = "'ibapi not installed'";

describe("vertex-history test_vertex_history.py", () => {
  it("passes under python3, does not skip the ibapi pin test and leaves no temp folders", {
    timeout: PYTHON_TIMEOUT_MS + 30_000,
  }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vertex-history-tmpdir-"));
    try {
      // -B: no __pycache__ next to the sources. -W ignore: no warning text between the -v lines.
      // NO_COLOR: Python 3.14 colors the -v lines when the caller sets FORCE_COLOR.
      // -I does not stop tempfile from reading TMPDIR.
      const result = spawnSync(
        "python3",
        ["-B", "-I", "-W", "ignore", SUITE, "-v"],
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
      expect(readdirSync(tempDir), "temp folders left by the run").toEqual([]);
      expect(result.stderr, output).toMatch(PIN_TEST_OK);
      const skipReasons = Array.from(
        result.stderr.matchAll(SKIP_REASON),
        (match) => match[1]
      );
      expect(
        skipReasons.filter((reason) => reason !== ALLOWED_SKIP_REASON)
      ).toEqual([]);
      expect(skipReasons.length, output).toBeLessThanOrEqual(1);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
