import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("ci-changes.sh", import.meta.url));

const classify = (paths: string[]): string =>
  execFileSync("bash", [script, "classify"], { input: paths.join("\n") })
    .toString()
    .trim();

// Stands in for the GitHub CLI: the pull request changed one code file, and
// LIVE_DRAFT is its draft state now ("true", "false", or "error" for a failed read).
const fakeGh = [
  "#!/usr/bin/env bash",
  'case "$*" in',
  '  *"/files "*) echo apps/web/src/page.civet ;;',
  '  *".changed_files") echo 1 ;;',
  '  *".draft") [[ "$LIVE_DRAFT" != error ]] && echo "$LIVE_DRAFT" ;;',
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

const plan = (env: Record<string, string>): string => {
  const directory = mkdtempSync(join(tmpdir(), "ci-changes-"));
  const output = join(directory, "out");
  try {
    writeFileSync(join(directory, "gh"), fakeGh, { mode: 0o755 });
    execFileSync("bash", [script, "plan"], {
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// A pull request run: `eventDraft` is the draft flag in the event that started the
// run, `liveDraft` is what GitHub answers when the run asks.
const planPullRequest = (eventDraft: string, liveDraft: string): string =>
  plan({
    EVENT: "pull_request",
    REPO: "owner/repo",
    PR_NUMBER: "7",
    DRAFT: eventDraft,
    LIVE_DRAFT: liveDraft,
    BROWSER_TESTS: "on",
  });

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

  it("takes only the light lane on a pull request that is still a draft", () => {
    const out = planPullRequest("true", "true");
    expect(out).toContain("heavy=false");
    expect(out).toContain("draft=true");
    expect(out).toContain(
      'exclude=[{"lane":"integration"},{"lane":"browser"}]'
    );
  });

  // PR #84 (card vertex-ci-draft-ready-race): `gh pr ready` came one second after
  // `gh pr create --draft`. The run for the draft event cancelled the run for the
  // ready event, then took the light lane 15 seconds after the PR was ready.
  it("takes the full lane when a draft event runs after the pull request became ready", () => {
    const out = planPullRequest("true", "false");
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
    expect(out).toContain("exclude=[]");
  });

  it("takes the full lane when the draft state cannot be read", () => {
    const out = planPullRequest("true", "error");
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
  });

  it("never moves a ready event to the light lane", () => {
    const out = planPullRequest("false", "true");
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
  });
});
