// Merge-condition gate (card vertex-agent-review-enforcement, follow-up of the
// vertex-agents-no-human-review plan, PR #234). AGENTS.md requires a fresh-context
// agent review of the full diff at the head before every merge, and a linked owner
// decision when a change alters what an owner-decision item allows. This gate checks
// the PR body of every ready PR for that evidence:
//
//   Agent review: <40-character head SHA>                     (every ready PR)
//   Owner decision: <Discord message or GitHub issue/PR URL>  (owner-decision paths)
//     or
//   Owner decision: not needed (<why the change does not alter what the item allows>)
//
// Lines inside HTML comments and code fences do not count. The gate reads the PR body
// and draft state from the GitHub API when it runs, so after a body edit a rerun of the
// failed "Merge conditions" job sees the new text. CI runs the base commit's copy of
// this file when the base has one, so a PR cannot change the gate script it is judged
// by; the PR's own ci.yml can still change or drop the step, and the merge review must
// catch that. This file and scripts/merge-conditions.ts may import only node: builtins
// (CI copies these two files alone). The gate cannot prove that a review happened: it
// ties the review claim to one commit, and the merge review still checks the claim.

import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Paths where a change can alter an owner-decision item (arming, orders, risk, sizing, live units). */
const OWNER_DECISION_PATH_PREFIXES = [
  "services/execution-kernel/",
  "infra/quant-vps/exec-node/",
  "infra/golive-drafts/",
  "scripts/golive/",
] as const;

// Vendored third-party code and lesson text name these words as topics; a word match
// there is not a decision path. Prefix matches still apply.
const NO_WORD_MATCH =
  /(^|\/)vendor\/|^(docs\/|packages\/academy\/|scripts\/academy\/)|\.md$/;
// A path segment (or a word inside one) that names an owner-decision item.
const OWNER_DECISION_WORD =
  /(^|[/_.-])(risk|arming|arm|kill[-_]?switch|live[-_]?orders?|caps?|sizing|go[-_]?live|position[-_]actions)([/_.-]|$)/i;

export type PathClass = "owner-decision" | "none";

export function classifyPath(path: string): PathClass {
  // camelCase names split into words: riskAllocator -> risk-Allocator.
  const words = NO_WORD_MATCH.test(path)
    ? ""
    : path.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  if (
    OWNER_DECISION_WORD.test(words) ||
    OWNER_DECISION_PATH_PREFIXES.some((p) => path.startsWith(p))
  ) {
    return "owner-decision";
  }
  return "none";
}

const REVIEW_LINE = /^\s*Agent review:\s*([0-9a-f]{40})\b/gim;
const DECISION_LINK =
  /^\s*Owner decision:\s*<?https:\/\/(?:discord\.com\/channels\/\d+\/\d+\/\d+|github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)\b/im;
const DECISION_NOT_NEEDED =
  /^\s*Owner decision:\s*not needed\s*\((.{20,})\)\s*$/im;

/** The PR body without HTML comments and fenced code blocks (text a reader does not see as evidence). */
export function visibleBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/^\s*(```|~~~)[\s\S]*?(^\s*\1|(?![\s\S]))/gm, "");
}

export interface MergeConditionInput {
  body: string;
  /**
   * Commits a review covers: the head, then each first parent reached through
   * clean merges of the base into the branch (what `gh pr update-branch` and
   * scripts/merge-pr make). The CLI builds this list.
   */
  coveredShas: string[];
  files: string[];
}

export interface MergeConditionResult {
  ok: boolean;
  ownerDecision: string[];
  problems: string[];
}

export function evaluateMergeConditions(
  input: MergeConditionInput
): MergeConditionResult {
  const body = visibleBody(input.body);
  const ownerDecision = input.files.filter(
    (f) => classifyPath(f) === "owner-decision"
  );
  const problems: string[] = [];
  {
    const reviewed = [...body.matchAll(REVIEW_LINE)].map((m) =>
      String(m[1]).toLowerCase()
    );
    if (reviewed.length === 0) {
      problems.push(
        "Add the line 'Agent review: <40-character head SHA>' to the PR body after a fresh-context agent reviewed the full diff at that head."
      );
    } else if (!reviewed.some((sha) => input.coveredShas.includes(sha))) {
      problems.push(
        `The 'Agent review:' SHA ${reviewed.join(", ")} is not the head ${input.coveredShas[0]}. Review the full diff at the head and update the line.`
      );
    }
  }
  if (
    ownerDecision.length > 0 &&
    !DECISION_LINK.test(body) &&
    !DECISION_NOT_NEEDED.test(body)
  ) {
    problems.push(
      "Add 'Owner decision: <Discord message or GitHub issue/PR URL>' to the PR body, or 'Owner decision: not needed (<reason of 20+ characters>)' when the change does not alter what an owner-decision item allows."
    );
  }
  return { ok: problems.length === 0, ownerDecision, problems };
}

export interface MergeConditionsEnv {
  BASE_SHA?: string;
  EVENT?: string;
  GITHUB_OUTPUT?: string;
  HEAD_SHA?: string;
  PR_NUMBER?: string;
  REPO?: string;
}

export interface MergeConditionsDeps {
  /** Runs a command and returns its stdout; throws on a nonzero exit. */
  run: (command: string, args: string[]) => Promise<string>;
  stderr: { write: (text: string) => unknown };
  stdout: { write: (text: string) => unknown };
}

const execFileAsync = promisify(execFile);

/** Real command runner for the CI entry point (scripts/merge-conditions.ts). */
export async function runCommand(
  command: string,
  args: string[]
): Promise<string> {
  return (await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 }))
    .stdout;
}

const firstLine = (text: string): string =>
  text.trim().replace(/\n[\s\S]*/, "");

/** Most clean base merges in a row that keep a review valid. */
export const MAX_BASE_MERGES = 20;

/** The head and the commits under it reached through clean base merges. */
async function coveredShas(
  head: string,
  base: string,
  deps: MergeConditionsDeps
): Promise<string[]> {
  const covered = [head];
  let sha = head;
  for (let hop = 0; hop < MAX_BASE_MERGES; hop++) {
    const parents = firstLine(
      await deps.run("git", ["rev-list", "--parents", "-n", "1", sha])
    )
      .split(" ")
      .slice(1);
    const [first, second] = parents;
    if (parents.length !== 2 || !first || !second) break;
    const onBase = await deps
      .run("git", ["merge-base", "--is-ancestor", second, base])
      .then(
        () => true,
        () => false
      );
    if (!onBase) break;
    // A merge with hand-resolved conflict edits has another tree than a clean merge.
    const clean = firstLine(
      await deps
        .run("git", ["merge-tree", "--write-tree", first, second])
        .catch(() => "")
    );
    const tree = firstLine(
      await deps.run("git", ["rev-parse", `${sha}^{tree}`])
    );
    if (!clean || clean !== tree) break;
    covered.push(first);
    sha = first;
  }
  return covered;
}

/** CLI (`node scripts/merge-conditions.ts`, env from ci.yml): exit code 1 when a condition is missing. */
export async function runMergeConditionsCli(
  env: MergeConditionsEnv,
  deps: MergeConditionsDeps
): Promise<number> {
  // ci.yml names the run's gate "ci-gate" (the required check) only when this job
  // reports enforced=true, so a skipped check never stands in for the required one.
  const enforced = async (value: boolean) => {
    if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `enforced=${value}\n`);
  };
  if (env.EVENT !== "pull_request") {
    await enforced(false);
    deps.stdout.write(
      `merge-conditions: not a pull request (${env.EVENT ?? "unknown"}); nothing to check\n`
    );
    return 0;
  }
  const { PR_NUMBER, REPO, BASE_SHA, HEAD_SHA } = env;
  if (!(PR_NUMBER && REPO && BASE_SHA && HEAD_SHA)) {
    deps.stderr.write(
      "merge-conditions: PR_NUMBER, REPO, BASE_SHA and HEAD_SHA are required\n"
    );
    return 1;
  }
  // The live draft state, not the event's (a ready event can follow a draft one).
  const parsed: unknown = JSON.parse(
    await deps.run("gh", [
      "pr",
      "view",
      PR_NUMBER,
      "--repo",
      REPO,
      "--json",
      "body,isDraft",
    ])
  );
  const pr = typeof parsed === "object" && parsed !== null ? parsed : {};
  if ("isDraft" in pr && pr.isDraft === true) {
    await enforced(false);
    deps.stdout.write(
      "merge-conditions: draft pull request; nothing to check\n"
    );
    return 0;
  }
  await enforced(true);
  const body = "body" in pr && typeof pr.body === "string" ? pr.body : "";
  const files = (
    await deps.run("git", [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${BASE_SHA}...${HEAD_SHA}`,
    ])
  )
    .split("\0")
    .filter((f) => f.length > 0);
  const result = evaluateMergeConditions({
    body,
    coveredShas: await coveredShas(HEAD_SHA, BASE_SHA, deps),
    files,
  });
  deps.stdout.write(
    `merge-conditions: ${files.length} changed file(s), ${result.ownerDecision.length} owner-decision path(s)\n`
  );
  for (const f of result.ownerDecision)
    deps.stdout.write(`  owner-decision: ${f}\n`);
  if (!result.ok) {
    deps.stderr.write(
      `merge-conditions: failed\n${result.problems.map((p) => `- ${p}`).join("\n")}\nAfter you edit the PR body, rerun the failed jobs of this run.\n`
    );
    return 1;
  }
  deps.stdout.write("merge-conditions: passed\n");
  return 0;
}
