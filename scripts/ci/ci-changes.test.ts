import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("ci-changes.sh", import.meta.url));

const classify = (paths: string[]): string =>
  execFileSync("bash", [script, "classify"], { input: paths.join("\n") })
    .toString()
    .trim();

const plan = (env: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "ci-changes-"));
  const output = join(directory, "out");
  try {
    execFileSync("bash", [script, "plan"], {
      env: { PATH: process.env["PATH"] ?? "", GITHUB_OUTPUT: output, ...env },
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("ci-changes.sh", () => {
  it("treats Markdown and non-code files under docs, research and plans as docs", () => {
    expect(classify(["README.md", "apps/web/notes.md"])).toBe("docs");
    expect(
      classify(["docs/a.png", "research/x/report.pdf", "plans/p.txt"])
    ).toBe("docs");
  });

  it("treats code, tested data and anything else as code", () => {
    expect(classify(["README.md", "apps/web/src/page.civet"])).toBe("code");
    expect(classify(["research/master-rules/check-master-rules.mjs"])).toBe(
      "code"
    );
    expect(classify(["research/baskets/owner-baskets.json"])).toBe("code");
    for (const path of [
      "docs/a.jsonl",
      "research/b.ndjson",
      "plans/c.JSON",
      "docs/d.json5",
      "docs/e.geojson",
      "docs/f.json.gz",
    ])
      expect([path, classify([path])]).toEqual([path, "code"]);
    expect(classify([".github/workflows/ci.yml"])).toBe("code");
    expect(classify([".agents/skills/x/SKILL.md"])).toBe("code");
    expect(classify(["CLAUDE.md"])).toBe("code");
    expect(classify(["packages/a/AGENTS.md"])).toBe("code");
    expect(classify([])).toBe("code");
  });

  it("always takes the full lane on a manual run", () => {
    const out = plan({ EVENT: "workflow_dispatch", BROWSER_TESTS: "on" });
    expect(out).toContain("heavy=true");
    expect(out).toContain("exclude=[]");
  });

  it("takes the full lane when the changed files cannot be listed", () => {
    const out = plan({
      EVENT: "push",
      BEFORE: "0000000000000000000000000000000000000000",
    });
    expect(out).toContain("heavy=true");
    expect(out).toContain('exclude=[{"lane":"browser"}]');
  });

  it("takes only the light lane on a draft pull request", () => {
    const out = plan({ EVENT: "workflow_dispatch", DRAFT: "true" });
    expect(out).toContain("heavy=false");
    expect(out).toContain(
      'exclude=[{"lane":"integration"},{"lane":"browser"}]'
    );
  });
});
