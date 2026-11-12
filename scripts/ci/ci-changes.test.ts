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

// Stands in for the GitHub CLI. It logs each call and answers only the three exact
// reads that the script makes for pull request 7 of owner/repo; any other call fails.
// FILES holds the changed paths. LIVE_DRAFT is the draft state now: "true", "false",
// or "error" for a failed read (the real CLI then prints the error body on stdout).
const draftRead = "api repos/owner/repo/pulls/7 --jq .draft";
const fakeGh = [
  "#!/usr/bin/env bash",
  'echo "$*" >>"$GH_LOG"',
  'case "$*" in',
  '  "api repos/owner/repo/pulls/7 --jq .changed_files") grep -c . <<<"$FILES" ;;',
  '  "api --paginate repos/owner/repo/pulls/7/files --jq "*) echo "$FILES" ;;',
  `  "${draftRead}")`,
  '    if [[ "$LIVE_DRAFT" == error ]]; then',
  `      echo '{"message":"Server Error","draft":true}'`,
  "      exit 1",
  "    fi",
  '    echo "$LIVE_DRAFT" ;;',
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

const runPlan = (
  env: Record<string, string>
): { calls: string[]; out: string } => {
  const directory = mkdtempSync(join(tmpdir(), "ci-changes-"));
  const output = join(directory, "out");
  const log = join(directory, "gh.log");
  try {
    writeFileSync(join(directory, "gh"), fakeGh, { mode: 0o755 });
    writeFileSync(log, "");
    execFileSync("bash", [script, "plan"], {
      env: {
        PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        GITHUB_OUTPUT: output,
        GH_LOG: log,
        ...env,
      },
    });
    return {
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      out: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// A pull request run: `eventDraft` is the draft flag in the event that started the
// run, `liveDraft` is what GitHub answers when the run asks.
const planPullRequest = (
  eventDraft: string,
  liveDraft: string,
  files = "apps/web/src/page.civet"
): { calls: string[]; out: string } =>
  runPlan({
    EVENT: "pull_request",
    REPO: "owner/repo",
    PR_NUMBER: "7",
    DRAFT: eventDraft,
    LIVE_DRAFT: liveDraft,
    FILES: files,
    BROWSER_TESTS: "on",
  });

describe("ci-changes.sh", () => {
  it("treats Markdown and non-code files under docs, research and plans as docs", () => {
    expect(classify(["CHANGELOG.md", "apps/web/notes.md"])).toBe("docs");
    expect(
      classify(["docs/a.png", "research/x/report.pdf", "plans/p.txt"])
    ).toBe("docs");
  });

  it("treats the root README as code, because a test checks it", () => {
    expect(classify(["README.md"])).toBe("code");
    expect(classify(["infra/quantvps/README.md"])).toBe("docs");
  });

  it("treats code, tested data and anything else as code", () => {
    expect(classify(["CHANGELOG.md", "apps/web/src/page.civet"])).toBe("code");
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
    const { out } = runPlan({
      EVENT: "workflow_dispatch",
      BROWSER_TESTS: "on",
    });
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
    expect(out).toContain("exclude=[]");
  });

  it("takes the full lane when the changed files cannot be listed", () => {
    const { out } = runPlan({
      EVENT: "push",
      BEFORE: "0000000000000000000000000000000000000000",
    });
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
    expect(out).toContain('exclude=[{"lane":"browser"}]');
  });

  it("takes only the light lane on a pull request that is still a draft", () => {
    const { calls, out } = planPullRequest("true", "true");
    expect(calls).toContain(draftRead);
    expect(out).toContain("kind=code");
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
    const { calls, out } = planPullRequest("true", "false");
    expect(calls).toContain(draftRead);
    expect(out).toContain("kind=code");
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
    expect(out).toContain("exclude=[]");
  });

  it("takes the full lane when the draft state cannot be read", () => {
    const { calls, out } = planPullRequest("true", "error");
    expect(calls).toContain(draftRead);
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
  });

  it("never asks for the draft state on a ready event and takes the full lane", () => {
    const { calls, out } = planPullRequest("false", "true");
    expect(calls).not.toContain(draftRead);
    expect(out).toContain("heavy=true");
    expect(out).toContain("draft=false");
  });

  it("keeps the light lane for a docs-only pull request and still reports the draft state", () => {
    const ready = planPullRequest("true", "false", "CHANGELOG.md").out;
    expect(ready).toContain("kind=docs");
    expect(ready).toContain("heavy=false");
    expect(ready).toContain("draft=false");
    const draft = planPullRequest("true", "true", "CHANGELOG.md").out;
    expect(draft).toContain("kind=docs");
    expect(draft).toContain("heavy=false");
    expect(draft).toContain("draft=true");
  });

  // Owner decision 2026-11-11 (card vertex-code-stewardship): the template init
  // acceptance shard is the longest CI job, so it runs nightly and for changes to the
  // init command instead of on every pull request.
  describe("acceptance shard", () => {
    const SKIPPED = 'skip_shards=[{"shard":"acceptance"}]';

    it("skips the shard when no changed path belongs to the init command", () => {
      const { out } = planPullRequest(
        "false",
        "false",
        [
          "apps/web/src/page.tsx",
          "scripts/initial.ts",
          "scripts/init.test.ts",
          "docs/scripts/init/notes.py",
        ].join("\n")
      );
      expect(out).toContain("heavy=true");
      expect(out).toContain("acceptance=false");
      expect(out).toContain(SKIPPED);
    });

    it.each([
      ["scripts/init/plan.ts"],
      ["scripts/init.ts"],
      ["README.md\nscripts/init/init.acceptance.test.ts"],
    ])("plans the shard for a pull request that changes %s", (files) => {
      const { out } = planPullRequest("false", "false", files);
      expect(out).toContain("heavy=true");
      expect(out).toContain("acceptance=true");
      expect(out).toContain("skip_shards=[]");
    });

    it.each([
      ["a manual run", { EVENT: "workflow_dispatch" }],
      ["the nightly run", { EVENT: "schedule" }],
      [
        "a push whose changed files cannot be listed",
        { EVENT: "push", BEFORE: "0".repeat(40) },
      ],
    ])("plans the shard on %s without asking GitHub", (_label, env) => {
      const { calls, out } = runPlan(env);
      expect(calls).toEqual([]);
      expect(out).toContain("kind=code");
      expect(out).toContain("heavy=true");
      expect(out).toContain("acceptance=true");
      expect(out).toContain("skip_shards=[]");
    });

    it("plans no shard outside the full lane, even when the init command changed", () => {
      const { out } = planPullRequest("true", "true", "scripts/init/plan.ts");
      expect(out).toContain("heavy=false");
      expect(out).toContain("acceptance=false");
      expect(out).toContain(SKIPPED);
    });
  });
});
