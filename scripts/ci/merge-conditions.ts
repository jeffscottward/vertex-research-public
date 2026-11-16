// Merge-condition gate for review-sensitive paths (card vertex-agent-review-enforcement,
// follow-up of the vertex-agents-no-human-review plan, PR #234). AGENTS.md
// "Code review practice" says a change to an order, execution, arming, risk, auth, CI
// or deploy path merges only after a fresh-context agent reviewed the full diff at the
// head, and that a change to an owner-decision item links the owner's decision in the
// PR body. This gate checks the PR body for that evidence:
//
//   Agent review: <40-character head SHA>
//   Owner decision: <Discord message URL or GitHub issue, PR or comment URL>
//     or
//   Owner decision: not needed (<why the change does not alter what the item allows>)
//
// Lines inside HTML comments and code fences do not count. The gate reads the PR body
// from the GitHub API when it runs, so after a body edit a rerun of the failed
// "Merge conditions" job sees the new text. CI runs the base branch's copy of this
// file when the base has one, so a PR cannot weaken the check it is judged by. It
// cannot prove that a review happened: it makes the review claim explicit and tied to
// one commit, and the merge review still checks the claim.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Paths where a full-diff agent review at the head is required. */
const REVIEW_PATH_PREFIXES = [
  ".github/",
  ".agents/",
  ".claude/",
  "AGENTS.md",
  "CLAUDE.md",
  "wrangler.jsonc",
  "scripts/ci/",
  "scripts/deployment",
  "scripts/merge-pr",
  "scripts/merge-conditions",
  "services/execution/",
  "services/execution-kernel/",
  "services/kernel-bridge/",
  "services/gateway/",
  "infra/quant-vps/",
  "infra/quantvps/",
  "infra/docker/deployment/",
  "packages/auth/",
  "apps/web/src/components/auth/",
  "apps/web/src/app/api/auth/",
  "apps/web/src/app/(auth)/",
  "apps/web/src/lib/server-session",
] as const;

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
  /(^|[/_.-])(risk|arming|arm|kill[-_]?switch|live[-_]?orders?|caps?|sizing|golive|position[-_]actions)([/_.-]|$)/i;
// A path segment that names an order, execution, auth or deploy path.
const REVIEW_WORD =
  /(^|[/_.-])(orders?|order[-_]flow|execution|auth|deploy|deployment)([/_.-]|$)/i;

export type PathClass = "owner-decision" | "review" | "none";

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
  if (
    REVIEW_WORD.test(words) ||
    REVIEW_PATH_PREFIXES.some((p) => path.startsWith(p))
  ) {
    return "review";
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
  review: string[];
}

export function evaluateMergeConditions(
  input: MergeConditionInput
): MergeConditionResult {
  const body = visibleBody(input.body);
  const ownerDecision = input.files.filter(
    (f) => classifyPath(f) === "owner-decision"
  );
  const review = input.files.filter((f) => classifyPath(f) !== "none");
  const problems: string[] = [];
  if (review.length > 0) {
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
      "Add 'Owner decision: <Discord message or GitHub issue/comment link>' to the PR body, or 'Owner decision: not needed (<reason of 20+ characters>)' when the change does not alter what an owner-decision item allows."
    );
  }
  return { ok: problems.length === 0, ownerDecision, problems, review };
}

export interface MergeConditionsEnv {
  BASE_SHA?: string;
  DRAFT?: string;
  EVENT?: string;
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
export const MAX_BASE_MERGES = 5;

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
  if (env.EVENT !== "pull_request" || env.DRAFT === "true") {
    deps.stdout.write(
      `merge-conditions: not a ready pull request (${env.EVENT ?? "unknown"}); nothing to check\n`
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
  const body = await deps.run("gh", [
    "pr",
    "view",
    PR_NUMBER,
    "--repo",
    REPO,
    "--json",
    "body",
    "--jq",
    ".body",
  ]);
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
    `merge-conditions: ${result.review.length} review path(s), ${result.ownerDecision.length} owner-decision path(s)\n`
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
