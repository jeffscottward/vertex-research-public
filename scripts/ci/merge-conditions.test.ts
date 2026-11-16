import { describe, expect, it } from "vitest";
import {
  classifyPath,
  evaluateMergeConditions,
  type MergeConditionInput,
  type MergeConditionsDeps,
  runMergeConditionsCli,
} from "./merge-conditions.ts";

// Card vertex-agent-review-enforcement: see scripts/ci/merge-conditions.ts.

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const LINK = "Owner decision: https://discord.com/channels/1/2/3";

function input(over: Partial<MergeConditionInput>): MergeConditionInput {
  return {
    body: "",
    files: [],
    headParents: [OLD],
    headSha: HEAD,
    isOnBase: () => false,
    ...over,
  };
}

describe("classifyPath", () => {
  it.each([
    ["services/execution-kernel/src/lib.rs", "owner-decision"],
    ["infra/quant-vps/exec-node/systemd/x.service", "owner-decision"],
    ["packages/api/src/server/risk-gate.ts", "owner-decision"],
    ["apps/web/src/features/arming/page.tsx", "owner-decision"],
    ["services/x/kill-switch.py", "owner-decision"],
    ["services/x/live_orders.py", "owner-decision"],
    [".github/workflows/ci.yml", "review"],
    ["scripts/merge-pr", "review"],
    ["packages/auth/src/server.ts", "review"],
    ["apps/web/src/features/order-flow/view.tsx", "review"],
    ["packages/api/src/server/orders.ts", "review"],
    ["services/ibkr-history/vendor/ibapi-3.3.0/src/orders/x.py", "none"],
    ["docs/testing.md", "none"],
    ["apps/web/src/features/charts/alarm.ts", "none"],
    ["scripts/merge-conditions.ts", "review"],
    ["packages/academy/src/lessons/specs/a-risk-b.json", "none"],
    ["docs/risk.md", "none"],
  ])("%s -> %s", (path, cls) => {
    expect(classifyPath(path)).toBe(cls);
  });
});

describe("evaluateMergeConditions", () => {
  it("passes a change with no sensitive path and no lines", () => {
    expect(evaluateMergeConditions(input({ files: ["docs/a.md"] })).ok).toBe(
      true
    );
  });

  it("requires an agent review line for a review path", () => {
    const r = evaluateMergeConditions(
      input({ files: [".github/workflows/ci.yml"] })
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("Agent review:");
  });

  it("accepts the head SHA and rejects another SHA", () => {
    const files = ["scripts/ci/x.ts"];
    expect(
      evaluateMergeConditions(input({ body: `Agent review: ${HEAD}`, files }))
        .ok
    ).toBe(true);
    const r = evaluateMergeConditions(
      input({ body: `Agent review: ${OLD}`, files })
    );
    expect(r.problems[0]).toContain("is not the head");
  });

  it("accepts a reviewed SHA under a base update merge only", () => {
    const files = ["scripts/ci/x.ts"];
    const body = `Agent review: ${OLD}`;
    const merge = {
      headParents: [OLD, BASE],
      isOnBase: (s: string) => s === BASE,
    };
    expect(evaluateMergeConditions(input({ body, files, ...merge })).ok).toBe(
      true
    );
    expect(
      evaluateMergeConditions(
        input({ body, files, ...merge, isOnBase: () => false })
      ).ok
    ).toBe(false);
    expect(
      evaluateMergeConditions(
        input({ body, files, headParents: [BASE, OLD], isOnBase: () => true })
      ).ok
    ).toBe(false);
  });

  it("requires an owner decision link or a reasoned not-needed line", () => {
    const files = ["services/execution-kernel/src/lib.rs"];
    const review = `Agent review: ${HEAD}`;
    const missing = evaluateMergeConditions(input({ body: review, files }));
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain("Owner decision:");
    expect(missing.ownerDecision).toEqual(files);
    expect(
      evaluateMergeConditions(input({ body: `${review}\n${LINK}`, files })).ok
    ).toBe(true);
    expect(
      evaluateMergeConditions(
        input({
          body: `${review}\nOwner decision: https://github.com/o/r/issues/5#issuecomment-9`,
          files,
        })
      ).ok
    ).toBe(true);
    expect(
      evaluateMergeConditions(
        input({
          body: `${review}\nOwner decision: not needed (log text change only, no limit)`,
          files,
        })
      ).ok
    ).toBe(true);
    expect(
      evaluateMergeConditions(
        input({ body: `${review}\nOwner decision: not needed (short)`, files })
      ).ok
    ).toBe(false);
    expect(
      evaluateMergeConditions(
        input({
          body: `${review}\nOwner decision: https://discord.com/channels/1/2`,
          files,
        })
      ).ok
    ).toBe(false);
  });
});

function deps(responses: Record<string, string | Error>) {
  const out: string[] = [];
  const err: string[] = [];
  const d: MergeConditionsDeps = {
    run: async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
      if (!hit) throw new Error(`unexpected ${key}`);
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    },
    stderr: { write: (t: string) => err.push(t) },
    stdout: { write: (t: string) => out.push(t) },
  };
  return { d, err, out };
}

const env = {
  BASE_SHA: BASE,
  DRAFT: "false",
  EVENT: "pull_request",
  HEAD_SHA: HEAD,
  PR_NUMBER: "7",
  REPO: "o/r",
};

describe("runMergeConditionsCli", () => {
  it("skips non pull request and draft runs", async () => {
    const a = deps({});
    expect(await runMergeConditionsCli({ EVENT: "push" }, a.d)).toBe(0);
    expect(await runMergeConditionsCli({}, a.d)).toBe(0);
    expect(await runMergeConditionsCli({ ...env, DRAFT: "true" }, a.d)).toBe(0);
    expect(a.out.join("")).toContain("unknown");
  });

  it("fails without the PR inputs", async () => {
    const a = deps({});
    expect(await runMergeConditionsCli({ EVENT: "pull_request" }, a.d)).toBe(1);
    expect(a.err.join("")).toContain("required");
  });

  it("passes and fails from the live PR body", async () => {
    const files = "services/execution-kernel/src/lib.rs\0docs/x.md\0";
    const base = {
      "git diff": files,
      "git rev-list": `${HEAD} ${OLD} ${BASE}\n`,
      [`git merge-base --is-ancestor ${OLD}`]: new Error("not ancestor"),
      [`git merge-base --is-ancestor ${BASE}`]: "",
    };
    const ok = deps({
      ...base,
      "gh pr view 7": `Agent review: ${OLD}\n${LINK}\n`,
    });
    expect(await runMergeConditionsCli(env, ok.d)).toBe(0);
    expect(ok.out.join("")).toContain(
      "owner-decision: services/execution-kernel/src/lib.rs"
    );
    expect(ok.out.join("")).toContain("passed");

    const bad = deps({ ...base, "gh pr view 7": "no lines" });
    expect(await runMergeConditionsCli(env, bad.d)).toBe(1);
    expect(bad.err.join("")).toContain("rerun the failed jobs");
  });

  it("handles a head with no parent output", async () => {
    const a = deps({
      "gh pr view": "",
      "git diff": "docs/x.md\0",
      "git rev-list": "",
    });
    expect(await runMergeConditionsCli(env, a.d)).toBe(0);
  });
});
