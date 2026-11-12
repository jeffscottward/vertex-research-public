import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("merge-pr", import.meta.url));

// Answers one response per call from $STATE/<key>, one line per call; the last
// line repeats. A line "!N text" prints text and exits N. Every call is logged.
const responder = [
  "respond() {",
  '  local file="$STATE/$1" count n line',
  '  [[ -f "$file" ]] || exit 3',
  '  count=$(cat "$file.count" 2>/dev/null || echo 0)',
  '  n=$(wc -l <"$file")',
  "  count=$((count + 1))",
  '  echo "$count" >"$file.count"',
  "  ((count <= n)) || count=$n",
  '  line=$(sed -n "${count}p" "$file")',
  '  if [[ "$line" =~ ^!([0-9]+)\\ ?(.*)$ ]]; then',
  '    [[ -z "${BASH_REMATCH[2]}" ]] || printf "%b\\n" "${BASH_REMATCH[2]}"',
  '    exit "${BASH_REMATCH[1]}"',
  "  fi",
  '  printf "%b\\n" "$line"',
  "}",
].join("\n");

// Stands in for the GitHub CLI, keyed on the exact calls scripts/merge-pr makes for PR 9.
const fakeGh = [
  "#!/usr/bin/env bash",
  'echo "gh $*" >>"$CALL_LOG"',
  responder,
  'case "$*" in',
  '  "repo view --json nameWithOwner "*) respond repo ;;',
  '  "pr view 9 --json state,isDraft,"*) respond view ;;',
  '  "pr view 9 --json headRefOid "*) respond head ;;',
  '  "pr view 9 --json state,mergeCommit "*) respond merged ;;',
  '  "api repos/owner/vertex-research-public/git/ref/heads/base/main "*) respond ref ;;',
  '  "api repos/owner/vertex-research-public/compare/"*) respond compare ;;',
  '  "api repos/owner/vertex-research-public/commits/"*) respond tree ;;',
  '  "pr update-branch 9") respond update ;;',
  '  "pr checks 9 --required --json bucket "*) respond checks ;;',
  '  "pr checks 9 --required") echo "ci-gate fail" ;;',
  '  "pr merge 9 --merge --match-head-commit "*) respond merge ;;',
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

// Stands in for the firstmate CLI: claim answers from $STATE/claim, beat and release succeed.
const fakeFm = [
  "#!/usr/bin/env bash",
  'echo "fm $*" >>"$CALL_LOG"',
  responder,
  'case "$1" in',
  "  claim) respond claim ;;",
  "  beat | release) exit 0 ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

const BASE = "base/main";
const CLEAN: Record<string, string[]> = {
  checks: ["pass"],
  claim: ["claimed"],
  compare: ["0"],
  head: ["head1"],
  merge: [""],
  merged: ["MERGED\\tmerge1"],
  ref: ["base1"],
  repo: ["owner/vertex-research-public"],
  tree: ["tree1"],
  update: [""],
  view: [`OPEN\\tfalse\\t${BASE}\\thead1`],
};

const run = (
  responses: Record<string, string[]>,
  args: string[] = ["9", "--card", "job-a"]
): {
  calls: string[];
  status: number | null;
  stdout: string;
  stderr: string;
} => {
  const directory = mkdtempSync(join(tmpdir(), "merge-pr-"));
  const log = join(directory, "calls.log");
  try {
    writeFileSync(join(directory, "gh"), fakeGh, { mode: 0o755 });
    writeFileSync(join(directory, "fm"), fakeFm, { mode: 0o755 });
    writeFileSync(log, "");
    for (const [key, lines] of Object.entries({ ...CLEAN, ...responses })) {
      writeFileSync(join(directory, key), `${lines.join("\n")}\n`);
    }
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        CALL_LOG: log,
        MERGE_PR_POLL_SECONDS: "0",
        PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        STATE: directory,
      },
    });
    return {
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const claimCall = `fm claim job-a branch:vertex-research-public:${BASE}`;
const releaseCall = `fm release job-a branch:vertex-research-public:${BASE}`;
const merges = (calls: string[]): string[] =>
  calls.filter((call) => call.startsWith("gh pr merge"));

describe("scripts/merge-pr", () => {
  it("merges an up-to-date green PR pinned to its head and releases the claim", () => {
    const { calls, status, stdout } = run({});
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("merge1");
    expect(calls).toContain(claimCall);
    expect(merges(calls)).toEqual([
      "gh pr merge 9 --merge --match-head-commit head1",
    ]);
    expect(calls.at(-1)).toBe(releaseCall);
    expect(calls.some((call) => call.includes("update-branch"))).toBe(false);
  });

  it("updates a behind PR, waits for CI on the new head, then merges that head", () => {
    const { calls, status } = run({
      checks: ["!1 no required checks reported", "pending", "pass"],
      compare: ["3", "0"],
      head: ["head1", "head2"],
    });
    expect(status).toBe(0);
    expect(calls).toContain("gh pr update-branch 9");
    expect(merges(calls)).toEqual([
      "gh pr merge 9 --merge --match-head-commit head2",
    ]);
    expect(
      calls.filter((call) =>
        call.startsWith("gh pr checks 9 --required --json")
      )
    ).toHaveLength(3);
  });

  it("updates again when the base moved while CI ran", () => {
    const { calls, status } = run({
      compare: ["0", "2", "2", "0"],
      head: ["head1", "head1", "head1", "head2"],
    });
    expect(status).toBe(0);
    expect(
      calls.filter((call) => call === "gh pr update-branch 9")
    ).toHaveLength(1);
    expect(merges(calls)).toEqual([
      "gh pr merge 9 --merge --match-head-commit head2",
    ]);
  });

  it("refuses with exit 4 while another card holds the base, touching nothing", () => {
    const { calls, status, stderr } = run({
      claim: ["!4 refused: held by card job-b"],
    });
    expect(status).toBe(4);
    expect(stderr).toContain("held by card job-b");
    expect(merges(calls)).toEqual([]);
    expect(calls).not.toContain(releaseCall);
    expect(calls.some((call) => call.includes("update-branch"))).toBe(false);
  });

  it("with --wait retries the claim until the holder releases it", () => {
    const { calls, status } = run(
      { claim: ["!4 held by job-b", "!4 held by job-b", "claimed"] },
      ["9", "--card", "job-a", "--wait", "1"]
    );
    expect(status).toBe(0);
    expect(calls.filter((call) => call === claimCall)).toHaveLength(3);
    expect(merges(calls)).toHaveLength(1);
  });

  it("stops on failed checks without merging and releases the claim", () => {
    const { calls, status, stderr } = run({ checks: ["pending", "fail"] });
    expect(status).toBe(1);
    expect(stderr).toContain("required checks failed on head1");
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("stops when the PR head moves while CI runs", () => {
    const { calls, status, stderr } = run({
      checks: ["pending"],
      head: ["head1", "head9"],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("PR head moved to head9");
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("stops on an update-branch conflict and names the local fix", () => {
    const { calls, status, stderr } = run({
      compare: ["4"],
      update: ["!1 merge conflict"],
    });
    expect(status).toBe(1);
    expect(stderr).toContain(`merge origin/${BASE} into the PR branch locally`);
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("refuses a draft PR before claiming", () => {
    const { calls, status } = run({ view: [`OPEN\\ttrue\\t${BASE}\\thead1`] });
    expect(status).toBe(1);
    expect(calls.some((call) => call.startsWith("fm claim"))).toBe(false);
  });

  it("fails with exit 5 when the merge commit tree differs from the PR head tree", () => {
    const { status, stderr } = run({ tree: ["tree1", "tree2"] });
    expect(status).toBe(5);
    expect(stderr).toContain("differs from PR head head1");
  });

  it("rejects calls without a PR number or card", () => {
    expect(run({}, ["9"]).status).toBe(2);
    expect(run({}, ["--card", "job-a"]).status).toBe(2);
    expect(run({}, ["9", "--card", "job-a", "--wait", "x"]).status).toBe(2);
  });
});
