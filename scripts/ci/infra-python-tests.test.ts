import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Card vertex-infra-unittest-ci-lane (2026-11-20): three Python unittest files
// under infra/ ran in no CI job and no pre-push step, because each file runs only
// when a Vitest wrapper in its folder names it (python-*.test.ts, in the unit
// project). This test keeps that from happening again: every tracked
// infra/**/test_*.py file must be named by a *.test.ts file in the same folder.
const root = fileURLToPath(new URL("../../", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z", "infra"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path !== "");

const pythonTests = tracked.filter((path) => /\/test_[^/]+\.py$/u.test(path));

describe("infra Python unittest files", () => {
  it("finds the tracked Python test files", () => {
    expect(pythonTests.length).toBeGreaterThan(0);
  });

  it.each(pythonTests)(
    "%s runs through a Vitest wrapper in its folder",
    (path) => {
      const name = basename(path);
      // Vitest files of the same folder only, not of its subfolders.
      const naming = tracked.filter(
        (wrapper) =>
          dirname(wrapper) === dirname(path) &&
          wrapper.endsWith(".test.ts") &&
          readFileSync(join(root, wrapper), "utf8").includes(`"${name}"`)
      );
      expect(
        naming,
        `no *.test.ts in ${dirname(path)} names "${name}"`
      ).not.toEqual([]);
    }
  );
});
