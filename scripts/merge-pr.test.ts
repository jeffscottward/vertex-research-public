import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("merge-pr", import.meta.url));

// Answers one response per call from $STATE/<key>, one line per call; the last
// line repeats. A line "!N text" prints text and exits N. A missing key fails
// with 3 unless the caller asks for an empty answer.
const responder = [
  "respond() {",
  '  local file="$STATE/$1" count n line',
  '  if [[ ! -f "$file" ]]; then [[ "${2:-}" == empty ]] && exit 0; exit 3; fi',
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

const API = "repos/owner/vertex-research-public";

// Stands in for the GitHub CLI, keyed on the exact calls scripts/merge-pr makes for
// PR 9. Commit reads are keyed by SHA, so a check run only exists for the commit
// a test gives it. Check-run and status answers are raw API JSON filtered through
// the script's own --jq expression with the system jq, as gh does.
const fakeGh = [
  "#!/usr/bin/env bash",
  "set -o pipefail",
  'echo "gh $*" >>"$CALL_LOG"',
  responder,
  'sha() { local rest=${1#*/commits/}; echo "${rest%%/*}"; }',
  'filter() { local args=("$@") i; for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[i]}" == --jq ]] && echo "${args[i + 1]}"; done; }',
  'case "$*" in',
  '  "repo view --json nameWithOwner "*) respond repo ;;',
  '  "pr view 9 --json state,isDraft,baseRefName,headRefOid,mergeStateStatus "*) respond view ;;',
  '  "pr view 9 --json state,mergeCommit "*) respond merged ;;',
  `  "api ${API}/branches/base%2Fmain/protection/required_status_checks "*) respond required ;;`,
  `  "api ${API}/rules/branches/base%2Fmain "*) respond rules empty ;;`,
  `  "api ${API}/git/ref/heads/base/main "*) respond ref ;;`,
  `  "api ${API}/compare/"*) respond compare ;;`,
  `  "api -X GET ${API}/commits/"*"/check-runs "*) respond "runs-$(sha "$4")" | jq -r "$(filter "$@")" ;;`,
  `  "api ${API}/commits/"*"/status?per_page=100 "*) respond "status-$(sha "$2")" | jq -r "$(filter "$@")" ;;`,
  `  "api ${API}/commits/"*" --jq [([.parents"*) respond "parents-$(sha "$2")" ;;`,
  `  "api ${API}/commits/"*" --jq .commit.tree.sha") respond "tree-$(sha "$2")" ;;`,
  '  "pr update-branch 9") respond update ;;',
  '  "pr merge 9 --merge --match-head-commit "*) respond merge ;;',
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

// Stands in for the firstmate CLI: claim and claims answer from $STATE.
const fakeFm = [
  "#!/usr/bin/env bash",
  'echo "fm $*" >>"$CALL_LOG"',
  responder,
  'case "$1" in',
  "  claim) respond claim ;;",
  "  claims) respond claims ;;",
  "  beat | release) exit 0 ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const B1 = "b".repeat(40);
const BASE = "base/main";
const view = (head: string, mergeState = "CLEAN", draft = "false") =>
  `OPEN\\t${draft}\\t${BASE}\\t${head}\\t${mergeState}`;
// A check-runs API page with one ci-gate run, or none.
const runs = (status?: string, conclusion?: string, app = 15_368) =>
  JSON.stringify({
    check_runs: status
      ? [{ app: { id: app }, conclusion: conclusion ?? null, id: 1, status }]
      : [],
  });
const PASS = runs("completed", "success");
const PENDING = runs();
const updateOf = (previous: string) => `${previous} ${B1}\\ttrue\\tweb-flow`;
const RESOURCE = `branch:vertex-research-public:${BASE}`;

const CLEAN: Record<string, string[]> = {
  claim: ["claimed"],
  claims: ["[]"],
  compare: ["0"],
  merge: [""],
  merged: ["MERGED\\tmerge1"],
  ref: [B1],
  repo: ["owner/vertex-research-public"],
  required: ["ci-gate\\t15368"],
  [`runs-${H1}`]: [PASS],
  [`runs-${H2}`]: [PASS],
  [`tree-${H1}`]: ["tree1"],
  [`tree-${H2}`]: ["tree1"],
  "tree-merge1": ["tree1"],
  update: [""],
  view: [view(H1)],
};

const ARGS = ["9", "--card", "job-a", "--head", H1];

const setup = (responses: Record<string, string[]>) => {
  const directory = mkdtempSync(join(tmpdir(), "merge-pr-"));
  const log = join(directory, "calls.log");
  writeFileSync(join(directory, "gh"), fakeGh, { mode: 0o755 });
  writeFileSync(join(directory, "fm"), fakeFm, { mode: 0o755 });
  writeFileSync(log, "");
  for (const [key, lines] of Object.entries({ ...CLEAN, ...responses })) {
    writeFileSync(join(directory, key), `${lines.join("\n")}\n`);
  }
  const env = {
    CALL_LOG: log,
    MERGE_PR_POLL_SECONDS: "0",
    MERGE_PR_RETRY_SECONDS: "0",
    PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    STATE: directory,
    XDG_RUNTIME_DIR: directory,
  };
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const cleanup = () => rmSync(directory, { force: true, recursive: true });
  return { calls, cleanup, env };
};

const run = (responses: Record<string, string[]>, args: string[] = ARGS) => {
  const { calls, cleanup, env } = setup(responses);
  try {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env,
    });
    return {
      calls: calls(),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    cleanup();
  }
};

const claimCall = `fm claim job-a ${RESOURCE}`;
const releaseCall = `fm release job-a ${RESOURCE}`;
const merges = (calls: string[]): string[] =>
  calls.filter((call) => call.startsWith("gh pr merge"));
const checkRunShas = (calls: string[]): string[] =>
  calls
    .filter((call) => call.includes("/check-runs "))
    .map((call) => call.split("/commits/")[1]?.slice(0, 40) ?? "");

describe("scripts/merge-pr", () => {
  it("merges a green reviewed head pinned to that head and releases the claim", () => {
    const { calls, status, stdout } = run({});
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("merge1");
    expect(merges(calls)).toEqual([
      `gh pr merge 9 --merge --match-head-commit ${H1}`,
    ]);
    // The claim is renewed right before merging.
    const lastClaim = calls.lastIndexOf(claimCall);
    expect(lastClaim).toBeGreaterThan(calls.indexOf(claimCall));
    expect(lastClaim).toBeLessThan(calls.indexOf(merges(calls)[0] ?? ""));
    expect(calls.at(-1)).toBe(releaseCall);
    expect(calls.some((call) => call.includes("update-branch"))).toBe(false);
  });

  it("updates a behind PR, then waits for checks on the new head only", () => {
    const { calls, status } = run({
      compare: ["3", "0"],
      [`parents-${H2}`]: [updateOf(H1)],
      [`runs-${H2}`]: [PENDING, runs("in_progress"), PASS],
      view: [view(H1), view(H1), view(H2)],
    });
    expect(status).toBe(0);
    const update = calls.indexOf("gh pr update-branch 9");
    const firstRun = calls.findIndex((call) => call.includes("/check-runs "));
    expect(update).toBeGreaterThan(-1);
    expect(firstRun).toBeGreaterThan(update);
    expect(checkRunShas(calls)).toEqual([H2, H2, H2]);
    expect(merges(calls)).toEqual([
      `gh pr merge 9 --merge --match-head-commit ${H2}`,
    ]);
  });

  it("updates again when GitHub reports the PR behind after CI passed", () => {
    const { calls, status } = run({
      compare: ["0", "2", "0"],
      [`parents-${H2}`]: [updateOf(H1)],
      view: [view(H1), view(H1), view(H1, "BEHIND"), view(H1), view(H2)],
    });
    expect(status).toBe(0);
    expect(
      calls.filter((call) => call === "gh pr update-branch 9")
    ).toHaveLength(1);
    expect(merges(calls)).toEqual([
      `gh pr merge 9 --merge --match-head-commit ${H2}`,
    ]);
  });

  it("stops instead of spinning when GitHub keeps reporting BEHIND", () => {
    const { calls, status, stderr } = run({
      view: [view(H1), view(H1, "BEHIND")],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("base moved 5 times");
    expect(merges(calls)).toEqual([]);
  });

  it("waits out a lingering BLOCKED merge state after the checks pass", () => {
    const { calls, status } = run({
      view: [
        view(H1),
        view(H1),
        view(H1, "BLOCKED"),
        view(H1, "UNKNOWN"),
        view(H1),
      ],
    });
    expect(status).toBe(0);
    expect(merges(calls)).toHaveLength(1);
  });

  it("refuses to merge when GitHub keeps the PR blocked", () => {
    const { calls, status, stderr } = run({
      view: [view(H1), view(H1), view(H1, "DIRTY")],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("merge state DIRTY");
    expect(merges(calls)).toEqual([]);
  });

  it("refuses a PR whose head is not the reviewed --head, before claiming", () => {
    const { calls, status, stderr } = run({}, [
      "9",
      "--card",
      "job-a",
      "--head",
      H2,
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain(`not the reviewed --head ${H2}`);
    expect(calls.some((call) => call.startsWith("fm claim"))).toBe(false);
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
      [...ARGS, "--wait", "1"]
    );
    expect(status).toBe(0);
    expect(calls.filter((call) => call === claimCall).length).toBeGreaterThan(
      3
    );
    expect(merges(calls)).toHaveLength(1);
  });

  it("stops on any fm claim error other than a refusal", () => {
    const { calls, status } = run({ claim: ["!1 coord.json unreadable"] });
    expect(status).toBe(1);
    expect(merges(calls)).toEqual([]);
  });

  it("keeps a claim the card held before it started", () => {
    const { calls, status } = run({
      claims: [`[{"card": "job-a", "resource": "${RESOURCE}"}]`],
    });
    expect(status).toBe(0);
    expect(calls).not.toContain(releaseCall);
  });

  it("does not mistake a prefix-matching claim for the base claim", () => {
    const { calls, status } = run({
      claims: [`[{"card": "job-a", "resource": "${RESOURCE}-fix"}]`],
    });
    expect(status).toBe(0);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("stops with exit 6 when another card takes the claim before merging", () => {
    const { calls, status, stderr } = run({
      claim: ["claimed", "claimed", "!4 held by card job-b"],
    });
    expect(status).toBe(6);
    expect(stderr).toContain(`lost ${RESOURCE}`);
    expect(merges(calls)).toEqual([]);
  });

  it("retries a transient fm claim error during a renewal", () => {
    const { calls, status } = run({
      claim: ["claimed", "!1 coord.json busy", "claimed"],
    });
    expect(status).toBe(0);
    expect(merges(calls)).toHaveLength(1);
  });

  it("stops on a failed required check without merging and releases the claim", () => {
    const { calls, status, stderr } = run({
      [`runs-${H1}`]: [runs("queued"), runs("completed", "failure")],
    });
    expect(status).toBe(1);
    expect(stderr).toContain(`required check ci-gate failed on ${H1}`);
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("treats a cancelled required check as failed", () => {
    const { status } = run({
      [`runs-${H1}`]: [runs("completed", "cancelled")],
    });
    expect(status).toBe(1);
  });

  it("does not count a skipped required check as passed", () => {
    const { calls, status, stderr } = run({
      [`runs-${H1}`]: [runs("completed", "skipped")],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("ci-gate was skipped");
    expect(merges(calls)).toEqual([]);
  });

  it("ignores a passing run from another app", () => {
    const { calls, status, stderr } = run(
      { [`runs-${H1}`]: [runs("completed", "success", 999)] },
      [...ARGS, "--ci-timeout", "0"]
    );
    expect(status).toBe(1);
    expect(stderr).toContain("still pending");
    expect(merges(calls)).toEqual([]);
  });

  it("falls back to commit statuses for a check without a required app", () => {
    const status = (state: string) =>
      JSON.stringify({ statuses: [{ context: "ci-gate", state }] });
    const result = run({
      required: ["ci-gate\\t"],
      [`runs-${H1}`]: [PENDING],
      [`status-${H1}`]: [status("pending"), status("success")],
    });
    expect(result.status).toBe(0);
    expect(merges(result.calls)).toHaveLength(1);
  });

  it("stops when the checks stay pending past --ci-timeout", () => {
    const { calls, status, stderr } = run({ [`runs-${H1}`]: [PENDING] }, [
      ...ARGS,
      "--ci-timeout",
      "0",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain(`still pending on ${H1} after 0 min: ci-gate`);
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("stops when the base has no readable required checks", () => {
    const empty = run({ required: [""] });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("no required checks found");
    const unreadable = run({ required: ["!1 Not Found"] });
    expect(unreadable.status).toBe(1);
    expect(merges(unreadable.calls)).toEqual([]);
  });

  it("stops when the PR head moves while CI runs", () => {
    const { calls, status, stderr } = run({
      [`runs-${H1}`]: [PENDING],
      view: [view(H1), view(H1), view(H2)],
    });
    expect(status).toBe(1);
    expect(stderr).toContain(`PR head moved to ${H2}`);
    expect(merges(calls)).toEqual([]);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("stops when the PR is retargeted while CI runs", () => {
    const { calls, status, stderr } = run({
      [`runs-${H1}`]: [PENDING],
      view: [view(H1), view(H1), `OPEN\\tfalse\\tother\\t${H1}\\tCLEAN`],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("PR base changed");
    expect(merges(calls)).toEqual([]);
  });

  it("stops when the PR changes base or turns draft after the claim", () => {
    const retargeted = run({
      view: [view(H1), `OPEN\\tfalse\\tother\\t${H1}\\tCLEAN`],
    });
    expect(retargeted.status).toBe(1);
    expect(retargeted.stderr).toContain("PR base changed");
    const drafted = run({ view: [view(H1), view(H1, "DRAFT", "true")] });
    expect(drafted.status).toBe(1);
    expect(merges(drafted.calls)).toEqual([]);
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

  it("accepts a new head only as GitHub's verified update merge of head and base", () => {
    for (const identity of [
      `${H1} ${"c".repeat(40)}\\ttrue\\tweb-flow`,
      `${H1} ${B1}\\tfalse\\tweb-flow`,
      `${H1} ${B1}\\ttrue\\tsomeone`,
    ]) {
      const { calls, status, stderr } = run({
        compare: ["1"],
        [`parents-${H2}`]: [identity],
        view: [view(H1), view(H1), view(H2)],
      });
      expect(status).toBe(1);
      expect(stderr).toContain("is not GitHub's update merge");
      expect(merges(calls)).toEqual([]);
    }
    const stuck = run({ compare: ["1"] });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("did not move the PR head");
  });

  it("gives up after five base updates", () => {
    // Every round finds the base moved again; each update is a valid merge.
    const heads = [1, 2, 3, 4, 5, 6].map((digit) => String(digit).repeat(40));
    const responses: Record<string, string[]> = {
      compare: ["1"],
      view: [
        view(H1),
        view(H1),
        ...heads
          .slice(1)
          .flatMap((head) => [view(head), view(head), view(head)]),
      ],
    };
    heads.slice(1).forEach((head, index) => {
      responses[`parents-${head}`] = [updateOf(heads[index] ?? "")];
    });
    const { calls, status, stderr } = run(responses);
    expect(status).toBe(1);
    expect(stderr).toContain("base moved 5 times");
    expect(
      calls.filter((call) => call === "gh pr update-branch 9")
    ).toHaveLength(5);
    expect(merges(calls)).toEqual([]);
  });

  it("retries a transient gh read failure", () => {
    const { calls, status } = run({ compare: ["!1 HTTP 502", "0"] });
    expect(status).toBe(0);
    // The failed read and its retry; no other round needs a compare.
    expect(calls.filter((call) => call.includes("/compare/"))).toHaveLength(2);
  });

  it("refuses a draft or closed PR before claiming", () => {
    for (const row of [
      view(H1, "DRAFT", "true"),
      `CLOSED\\tfalse\\t${BASE}\\t${H1}\\tCLEAN`,
    ]) {
      const { calls, status } = run({ view: [row] });
      expect(status).toBe(1);
      expect(calls.some((call) => call.startsWith("fm claim"))).toBe(false);
    }
  });

  it("stops when gh pr merge fails and the PR is not merged", () => {
    const { calls, status, stderr } = run({
      merge: ["!1 Pull request is not mergeable"],
    });
    expect(status).toBe(1);
    expect(stderr).toContain("gh pr merge failed");
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("verifies the merge when gh pr merge errors but the PR merged", () => {
    const { status, stdout } = run({
      merge: ["!1 timeout"],
      view: [
        view(H1),
        view(H1),
        view(H1),
        `MERGED\\tfalse\\t${BASE}\\t${H1}\\tUNKNOWN`,
      ],
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("merge1");
  });

  it("exits 5 when the merge commit tree differs from the PR head tree", () => {
    const { calls, status, stderr } = run({ "tree-merge1": ["tree2"] });
    expect(status).toBe(5);
    expect(stderr).toContain(`differs from PR head ${H1}`);
    expect(calls.at(-1)).toBe(releaseCall);
  });

  it("exits 5 when the merged PR has no merge commit", () => {
    const { status, stderr } = run({ merged: ["MERGED\\t"] });
    expect(status).toBe(5);
    expect(stderr).toContain("merge commit ''");
  });

  it("releases the claim when terminated while waiting for CI", async () => {
    const { calls, cleanup, env } = setup({ [`runs-${H1}`]: [PENDING] });
    try {
      const child = spawn("bash", [script, ...ARGS], {
        env: { ...env, MERGE_PR_POLL_SECONDS: "30" },
      });
      const exited = once(child, "exit");
      // Keep reading stderr: closing the pipe would kill bash with SIGPIPE instead.
      const waiting = Promise.withResolvers<void>();
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("waiting for required checks")) waiting.resolve();
      });
      await waiting.promise;
      child.kill("SIGTERM");
      const [code] = await exited;
      expect(code).toBe(143);
      expect(calls().at(-1)).toBe(releaseCall);
      expect(merges(calls())).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("serializes two runs on one host with a lock", async () => {
    const { calls, cleanup, env } = setup({});
    try {
      const lock = join(
        env.XDG_RUNTIME_DIR,
        "merge-pr-vertex-research-public-base_main.lock"
      );
      const holder = spawn("flock", [
        "-n",
        "-o",
        lock,
        "-c",
        "echo locked; exec sleep 10",
      ]);
      try {
        await once(holder.stdout, "data");
        const result = spawnSync("bash", [script, ...ARGS], {
          encoding: "utf8",
          env,
        });
        expect(result.status).toBe(4);
        expect(result.stderr).toContain("another merge-pr run holds");
        expect(calls().some((call) => call.startsWith("fm claim"))).toBe(false);
      } finally {
        holder.kill();
      }
    } finally {
      cleanup();
    }
  });

  it("rejects calls without a PR number, card or reviewed head", () => {
    expect(run({}, ["9", "--card", "job-a"]).status).toBe(2);
    expect(run({}, ["--card", "job-a", "--head", H1]).status).toBe(2);
    expect(run({}, ["9", "--card", "job-a", "--head", "abc"]).status).toBe(2);
    expect(run({}, ["9", "--card", "--wait", "1", "--head", H1]).status).toBe(
      2
    );
    expect(run({}, [...ARGS, "--wait", "x"]).status).toBe(2);
    expect(run({}, ["--help"]).status).toBe(0);
  });
});
