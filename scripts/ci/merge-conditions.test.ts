import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  evaluateMergeConditions,
  MAX_BASE_MERGES,
  type MergeConditionsDeps,
  runCommand,
  runMergeConditionsCli,
  visibleBody,
} from "./merge-conditions.ts";

// Card vertex-agent-review-enforcement: see scripts/ci/merge-conditions.ts.

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const LINK = "Owner decision: https://discord.com/channels/1/2/3";
const KERNEL = ["services/execution-kernel/src/lib.rs"];

describe("classifyPath", () => {
  it.each([
    ["services/execution-kernel/src/lib.rs", "owner-decision"],
    ["infra/quant-vps/exec-node/systemd/x.service", "owner-decision"],
    ["infra/golive-drafts/x.ts", "owner-decision"],
    ["packages/api/src/server/risk-gate.ts", "owner-decision"],
    ["packages/api/src/server/riskAllocator.ts", "owner-decision"],
    ["apps/web/src/features/arming/page.tsx", "owner-decision"],
    ["services/x/kill-switch.py", "owner-decision"],
    ["services/x/live_orders.py", "owner-decision"],
    ["scripts/vertex-owner-caps.ts", "owner-decision"],
    ["services/execution-kernel/vendor/x.rs", "owner-decision"],
    [".github/workflows/ci.yml", "none"],
    ["AGENTS.md", "none"],
    ["scripts/merge-pr", "none"],
    ["scripts/merge-conditions.ts", "none"],
    ["scripts/deployment.test.ts", "none"],
    ["packages/auth/src/server.ts", "none"],
    ["apps/web/src/app/api/auth/[...all]/route.ts", "none"],
    ["packages/api/src/server/deployment-requests.ts", "none"],
    ["apps/web/src/features/order-flow/view.tsx", "none"],
    ["packages/api/src/server/orders.ts", "none"],
    ["services/ibkr-history/vendor/ibapi-3.3.0/src/orders/x.py", "none"],
    ["packages/academy/src/lessons/specs/a-risk-b.json", "none"],
    ["docs/risk.md", "none"],
    ["docs/testing.md", "none"],
    ["apps/web/src/features/charts/alarm.ts", "none"],
  ])("%s -> %s", (path, cls) => {
    expect(classifyPath(path)).toBe(cls);
  });
});

describe("visibleBody", () => {
  it("drops HTML comments and code fences", () => {
    expect(visibleBody("a\n<!-- x -->\nb\n```\nc\n```\nd\n<!-- open")).toBe(
      "a\n\nb\n\nd\n"
    );
  });
});

describe("evaluateMergeConditions", () => {
  const run = (files: string[], body: string, coveredShas = [HEAD]) =>
    evaluateMergeConditions({ body, coveredShas, files });

  it("passes an empty change with no lines", () => {
    expect(run([], "").ok).toBe(true);
  });

  it("requires an agent review line for any change", () => {
    const r = run(["docs/a.md"], "");
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("Agent review:");
  });

  it("accepts a covered SHA in any line and case, and rejects others", () => {
    const files = ["scripts/ci/x.ts"];
    expect(run(files, `Agent review: ${HEAD}`).ok).toBe(true);
    expect(
      run(files, `Agent review: ${OLD}\nAgent review: ${HEAD.toUpperCase()}`).ok
    ).toBe(true);
    expect(run(files, `Agent review: ${OLD}`, [HEAD, OLD]).ok).toBe(true);
    expect(run(files, `Agent review: ${OLD}`).problems[0]).toContain(
      "is not the head"
    );
    expect(run(files, `<!-- Agent review: ${HEAD} -->`).ok).toBe(false);
  });

  it("requires an owner decision link or a reasoned not-needed line", () => {
    const review = `Agent review: ${HEAD}`;
    const missing = run(KERNEL, review);
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain("Owner decision:");
    expect(missing.ownerDecision).toEqual(KERNEL);
    for (const ok of [
      LINK,
      "Owner decision: https://github.com/o/r/issues/5#issuecomment-9",
      "Owner decision: https://github.com/o/r/issues/5",
      "Owner decision: not needed (log text change only (no limit))",
    ]) {
      expect(run(KERNEL, `${review}\n${ok}`).ok, ok).toBe(true);
    }
    for (const bad of [
      "Owner decision: not needed (short)",
      "Owner decision: https://discord.com/channels/1/2",
      "```\nOwner decision: https://discord.com/channels/1/2/3\n```",
    ]) {
      expect(run(KERNEL, `${review}\n${bad}`).ok, bad).toBe(false);
    }
  });
});

function deps(responses: Record<string, string | Error>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const d: MergeConditionsDeps = {
    run: async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
      if (!hit) throw new Error(`unexpected ${key}`);
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    },
    stderr: { write: (t: string) => err.push(t) },
    stdout: { write: (t: string) => out.push(t) },
  };
  return { calls, d, err, out };
}

const env = {
  BASE_SHA: BASE,
  EVENT: "pull_request",
  HEAD_SHA: HEAD,
  PR_NUMBER: "7",
  REPO: "o/r",
};

const pr = (body: string, isDraft = false) => JSON.stringify({ body, isDraft });

describe("runMergeConditionsCli", () => {
  it("skips non pull request and live draft runs and reports enforced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "merge-conditions-"));
    const GITHUB_OUTPUT = join(dir, "out");
    const a = deps({ "gh pr view 7": pr("", true) });
    expect(
      await runMergeConditionsCli({ EVENT: "push", GITHUB_OUTPUT }, a.d)
    ).toBe(0);
    expect(await runMergeConditionsCli({}, a.d)).toBe(0);
    expect(await runMergeConditionsCli({ ...env, GITHUB_OUTPUT }, a.d)).toBe(0);
    expect(a.out.join("")).toContain("unknown");
    expect(a.out.join("")).toContain("draft");
    const b = deps({
      "gh pr view 7": "null",
      "git diff": "",
      "git rev-list": "",
    });
    expect(await runMergeConditionsCli({ ...env, GITHUB_OUTPUT }, b.d)).toBe(0);
    expect(await readFile(GITHUB_OUTPUT, "utf8")).toBe(
      "enforced=false\nenforced=false\nenforced=true\n"
    );
    await rm(dir, { force: true, recursive: true });
  });

  it("fails without the PR inputs", async () => {
    const a = deps({});
    expect(await runMergeConditionsCli({ EVENT: "pull_request" }, a.d)).toBe(1);
    expect(a.err.join("")).toContain("required");
  });

  const merge = {
    "git diff": "services/execution-kernel/src/lib.rs\0docs/x.md\0",
    [`git rev-list --parents -n 1 ${HEAD}`]: `${HEAD} ${OLD} ${BASE}\n`,
    [`git rev-list --parents -n 1 ${OLD}`]: `${OLD} ${BASE}\n`,
    [`git merge-base --is-ancestor ${BASE}`]: "",
    "git merge-tree": "tree1\n",
    "git rev-parse": "tree1\n",
  };
  const body = `Agent review: ${OLD}\n${LINK}\n`;

  it("accepts a review under a clean base merge from the live PR body", async () => {
    const ok = deps({ ...merge, "gh pr view 7": pr(body) });
    expect(await runMergeConditionsCli(env, ok.d)).toBe(0);
    expect(ok.out.join("")).toContain(
      "owner-decision: services/execution-kernel/src/lib.rs"
    );
    expect(ok.out.join("")).toContain("passed");

    const bad = deps({ ...merge, "gh pr view 7": pr("no lines") });
    expect(await runMergeConditionsCli(env, bad.d)).toBe(1);
    expect(bad.err.join("")).toContain("rerun the failed jobs");
  });

  it("rejects a review under a conflict-edited, failed or off-base merge", async () => {
    for (const over of [
      { "git rev-parse": "tree2\n" },
      { "git merge-tree": new Error("conflict") },
      { [`git merge-base --is-ancestor ${BASE}`]: new Error("no") },
      { [`git rev-list --parents -n 1 ${HEAD}`]: `${HEAD} ${BASE} ${OLD}\n` },
    ]) {
      const a = deps({
        ...merge,
        [`git merge-base --is-ancestor ${OLD}`]: new Error("no"),
        ...over,
        "gh pr view 7": pr(body),
      });
      expect(await runMergeConditionsCli(env, a.d)).toBe(1);
    }
  });

  it("follows a chain of clean base merges up to the limit", async () => {
    const shas = Array.from({ length: MAX_BASE_MERGES + 2 }, (_, i) =>
      i.toString(16).padStart(40, "f")
    );
    const chain: Record<string, string> = {};
    for (let i = 0; i < shas.length - 1; i++) {
      chain[`git rev-list --parents -n 1 ${shas[i]}`] =
        `${shas[i]} ${shas[i + 1]} ${BASE}\n`;
    }
    const at = (reviewed: string) =>
      deps({
        ...merge,
        ...chain,
        "gh pr view 7": pr(`Agent review: ${reviewed}\n${LINK}`),
      });
    const head = { ...env, HEAD_SHA: "0".padStart(40, "f") };
    expect(
      await runMergeConditionsCli(head, at(shas[MAX_BASE_MERGES]!).d)
    ).toBe(0);
    expect(
      await runMergeConditionsCli(head, at(shas[MAX_BASE_MERGES + 1]!).d)
    ).toBe(1);
  });

  it("handles a head with no parent output", async () => {
    const a = deps({
      "gh pr view": pr(`Agent review: ${HEAD}`),
      "git diff": "docs/x.md\0",
      "git rev-list": "",
    });
    expect(await runMergeConditionsCli(env, a.d)).toBe(0);
  });
});

describe("runCommand", () => {
  it("returns stdout and throws on a nonzero exit", async () => {
    expect(await runCommand("git", ["--version"])).toContain("git version");
    await expect(runCommand("git", ["no-such-command"])).rejects.toThrow();
  });
});
