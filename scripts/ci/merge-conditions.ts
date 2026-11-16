// Merge-condition gate for review-sensitive paths (card vertex-agent-review-enforcement,
// follow-up of the vertex-agents-no-human-review plan, PR #234). AGENTS.md
// "Code review practice" says a change to an order, execution, arming, risk, auth, CI
// or deploy path merges only after a fresh-context agent reviewed the full diff at the
// head, and that a change to an owner-decision item links the owner's decision in the
// PR body. This gate checks the PR body for that evidence:
//
//   Agent review: <40-character head SHA>
//   Owner decision: https://discord.com/channels/<guild>/<channel>/<message>
//     or
//   Owner decision: not needed (<why the change does not alter what the item allows>)
//
// The gate reads the PR body from the GitHub API when it runs, so after a body edit a
// rerun of the failed "Merge conditions" job sees the new text. It runs only on ready
// pull requests; draft, push, schedule and manual runs pass. It cannot prove that a
// review happened: it makes the review claim explicit and tied to one commit, and the
// merge review still checks the claim.

/** Paths where a full-diff agent review at the head is required. */
export const REVIEW_PATH_PREFIXES = [
  ".github/",
  "scripts/ci/",
  "scripts/deployment/",
  "scripts/deployment.ts",
  "scripts/deployment-inputs.ts",
  "scripts/merge-pr",
  "scripts/merge-conditions",
  "services/execution/",
  "services/execution-kernel/",
  "services/kernel-bridge/",
  "services/gateway/",
  "infra/quant-vps/",
  "infra/quantvps/",
  "packages/auth/",
  "apps/web/src/components/auth/",
] as const;

/** Paths where a change can alter an owner-decision item (arming, orders, risk, live units). */
export const OWNER_DECISION_PATH_PREFIXES = [
  "services/execution-kernel/",
  "infra/quant-vps/exec-node/",
] as const;

// Vendored third-party code is never a Vertex decision path.
const VENDOR = /(^|\/)vendor\//;
// Lesson text and docs name risk and orders as topics; a word match there is not a decision path.
const CONTENT = /^(docs\/|packages\/academy\/|scripts\/academy\/)|\.md$/;
// A path segment (or a word inside one) that names an owner-decision item.
const OWNER_DECISION_WORD =
  /(^|[/_.-])(risk|arming|arm|kill[-_]?switch|live[-_]?orders?)([/_.-]|$)/i;
// A path segment that names an order or execution path.
const REVIEW_WORD = /(^|[/_.-])(orders?|order[-_]flow|execution)([/_.-]|$)/i;

export type PathClass = "owner-decision" | "review" | "none";

export function classifyPath(path: string): PathClass {
  if (VENDOR.test(path)) return "none";
  const words = !CONTENT.test(path);
  if (
    (words && OWNER_DECISION_WORD.test(path)) ||
    OWNER_DECISION_PATH_PREFIXES.some((p) => path.startsWith(p))
  ) {
    return "owner-decision";
  }
  if (
    (words && REVIEW_WORD.test(path)) ||
    REVIEW_PATH_PREFIXES.some((p) => path.startsWith(p))
  ) {
    return "review";
  }
  return "none";
}

const REVIEW_LINE = /^\s*Agent review:\s*([0-9a-f]{40})\b/gim;
const DECISION_LINK =
  /^\s*Owner decision:\s*<?https:\/\/(?:discord\.com\/channels\/\d+\/\d+\/\d+|github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+#issuecomment-\d+)\b/im;
const DECISION_NOT_NEEDED =
  /^\s*Owner decision:\s*not needed\s*\(([^)]{20,})\)/im;

export interface MergeConditionInput {
  body: string;
  files: string[];
  /** Parents of the head commit, first parent first. */
  headParents: string[];
  headSha: string;
  /** True when the commit is an ancestor of (or equal to) the base branch tip. */
  isOnBase: (sha: string) => boolean;
}

export interface MergeConditionResult {
  ok: boolean;
  ownerDecision: string[];
  problems: string[];
  review: string[];
}

/**
 * The reviewed SHA is accepted when it is the head, or when the head is a
 * merge of the base into the reviewed SHA (what `gh pr update-branch` and
 * scripts/merge-pr make): first parent is the reviewed SHA, second parent is on
 * the base branch.
 */
function reviewCoversHead(
  reviewed: string,
  input: MergeConditionInput
): boolean {
  if (reviewed === input.headSha) return true;
  const [first, second] = input.headParents;
  return (
    input.headParents.length === 2 &&
    first === reviewed &&
    second !== undefined &&
    input.isOnBase(second)
  );
}

export function evaluateMergeConditions(
  input: MergeConditionInput
): MergeConditionResult {
  const ownerDecision = input.files.filter(
    (f) => classifyPath(f) === "owner-decision"
  );
  const review = input.files.filter((f) => classifyPath(f) !== "none");
  const problems: string[] = [];
  if (review.length > 0) {
    const reviewed = [...input.body.matchAll(REVIEW_LINE)].map((m) =>
      String(m[1]).toLowerCase()
    );
    if (reviewed.length === 0) {
      problems.push(
        "Add the line 'Agent review: <40-character head SHA>' to the PR body after a fresh-context agent reviewed the full diff at that head."
      );
    } else if (!reviewed.some((sha) => reviewCoversHead(sha, input))) {
      problems.push(
        `The 'Agent review:' SHA ${reviewed.join(", ")} is not the head ${input.headSha}. Review the full diff at the head and update the line.`
      );
    }
  }
  if (
    ownerDecision.length > 0 &&
    !DECISION_LINK.test(input.body) &&
    !DECISION_NOT_NEEDED.test(input.body)
  ) {
    problems.push(
      "Add 'Owner decision: <Discord message or GitHub comment link>' to the PR body, or 'Owner decision: not needed (<reason of 20+ characters>)' when the change does not alter what an owner-decision item allows."
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

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

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
  const headParents =
    lines(
      await deps.run("git", ["rev-list", "--parents", "-n", "1", HEAD_SHA])
    )[0]
      ?.split(" ")
      .slice(1) ?? [];
  const onBase = new Map<string, boolean>();
  for (const sha of headParents) {
    try {
      await deps.run("git", ["merge-base", "--is-ancestor", sha, BASE_SHA]);
      onBase.set(sha, true);
    } catch {
      onBase.set(sha, false);
    }
  }
  const result = evaluateMergeConditions({
    body,
    files,
    headParents,
    headSha: HEAD_SHA,
    isOnBase: (sha) => onBase.get(sha) === true,
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
