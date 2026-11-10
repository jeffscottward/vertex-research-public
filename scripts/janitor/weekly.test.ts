import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createJanitorDeps } from "./system.ts";

import {
  collectBusyFiles,
  FORBIDDEN_PATH_WORDS,
  findViolations,
  type JanitorDeps,
  janitorPrompt,
  parseSymrefHead,
  type RunResult,
  resolveDefaultBranch,
  runJanitorWeekly,
  stagePass,
} from "./weekly.ts";

const LIVE = "vertex/rebuild-darkfactory-20260921";
const ok = (stdout = ""): RunResult => ({ status: 0, stdout });
const fail: RunResult = { status: 1, stdout: "" };

interface Call {
  cwd: string;
  inherit: boolean;
  line: string;
}

type Answer = RunResult | RunResult[];

/**
 * A fake shell: the first matching prefix answers; unknown commands succeed.
 * A list answers in order and repeats its last entry.
 */
const fakeRun = (answers: Record<string, Answer>) => {
  const calls: Call[] = [];
  const run: JanitorDeps["run"] = (command, args, { cwd, inherit }) => {
    const line = [command, ...args].join(" ");
    calls.push({ cwd, inherit: inherit === true, line });
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    const answer = key === undefined ? ok() : (answers[key] ?? ok());
    if (!Array.isArray(answer)) return answer;
    return (answer.length > 1 ? answer.shift() : answer[0]) ?? ok();
  };
  return { calls, run };
};

const absent: RunResult = { status: 2, stdout: "" };

const healthyRepo: Record<string, Answer> = {
  "gh api --paginate repos/{owner}/{repo}/pulls/86/files": ok(
    "research/master-rules/rule-pack.json\nshared.ts\n"
  ),
  "gh pr list": ok("86\n"),
  "git diff --name-only --no-renames origin/vertex/rebuild-darkfactory-20260921...origin/ws/live-a":
    ok("apps/web/a.ts\nshared.ts\n"),
  "git for-each-ref": ok("origin/ws/live-a\norigin/ws/stale-main\n"),
  "git ls-remote --exit-code --heads origin": absent,
  "git ls-remote --symref origin HEAD": ok(
    `ref: refs/heads/${LIVE}\tHEAD\nabc123\tHEAD\n`
  ),
  "git merge-base origin/vertex/rebuild-darkfactory-20260921 origin/ws/stale-main":
    fail,
};

const deps = (answers: Record<string, Answer>, report?: string) => {
  const { calls, run } = fakeRun(answers);
  const written: Record<string, string> = {};
  const output: string[] = [];
  const value: JanitorDeps = {
    now: new Date("2026-11-01T11:00:00Z"),
    out: { write: (line: string) => output.push(line) },
    readFile: () => report,
    run,
    writeFile: (path, text) => {
      written[path] = text;
    },
  };
  return { calls, deps: value, output, written };
};

const env = { HOME: "/home/u" };
const MAIN = "/home/u/Github/trading/vertex-research-public";
const STAMP = "20261101-1100";
const BRANCH = `ws/janitor-${STAMP}`;
const WT = `/tmp/vertex-research-janitor-${STAMP}`;
const MOVE = "R100\tapps/web/old-name.ts\tapps/web/new-name.ts\n";

describe("default branch", () => {
  it("parses the remote symbolic HEAD", () => {
    expect(parseSymrefHead(`ref: refs/heads/${LIVE}\tHEAD\nx\tHEAD`)).toBe(
      LIVE
    );
    expect(parseSymrefHead("abc\tHEAD")).toBeUndefined();
  });

  it("asks the remote first, so a stale cached origin/HEAD cannot win", () => {
    const { run } = fakeRun({
      ...healthyRepo,
      "git symbolic-ref": ok("origin/main\n"),
    });
    expect(resolveDefaultBranch(run, MAIN)).toBe(LIVE);
  });

  it("falls back to the cached origin/HEAD when the remote is unreachable", () => {
    const { run } = fakeRun({
      "git ls-remote": fail,
      "git symbolic-ref": ok(`origin/${LIVE}\n`),
    });
    expect(resolveDefaultBranch(run, MAIN)).toBe(LIVE);
  });

  it("falls back when the remote answers without a symbolic ref", () => {
    const { run } = fakeRun({
      "git ls-remote": ok("abc\tHEAD\n"),
      "git symbolic-ref": ok(`origin/${LIVE}\n`),
    });
    expect(resolveDefaultBranch(run, MAIN)).toBe(LIVE);
  });

  it("fails instead of assuming main", () => {
    const { run } = fakeRun({
      "git ls-remote": fail,
      "git symbolic-ref": fail,
    });
    expect(() => resolveDefaultBranch(run, MAIN)).toThrow(
      "cannot resolve the default branch"
    );
    const empty = fakeRun({ "git ls-remote": fail, "git symbolic-ref": ok() });
    expect(() => resolveDefaultBranch(empty.run, MAIN)).toThrow(
      "cannot resolve"
    );
  });
});

describe("busy files", () => {
  it("skips ws branches with unrelated history instead of marking every file busy", () => {
    const { run } = fakeRun(healthyRepo);
    expect(collectBusyFiles(run, MAIN, LIVE)).toEqual({
      branches: 2,
      files: [
        "apps/web/a.ts",
        "research/master-rules/rule-pack.json",
        "shared.ts",
      ],
      prs: 1,
      unrelated: ["origin/ws/stale-main"],
    });
  });

  it("fails closed when a ws branch cannot be listed or diffed", () => {
    const noRefs = fakeRun({ ...healthyRepo, "git for-each-ref": fail });
    expect(() => collectBusyFiles(noRefs.run, MAIN, LIVE)).toThrow(
      "cannot list origin/ws/* branches"
    );
    const badRef = fakeRun({
      ...healthyRepo,
      "git merge-base origin/vertex/rebuild-darkfactory-20260921 origin/ws/live-a":
        { status: 128, stdout: "" },
    });
    expect(() => collectBusyFiles(badRef.run, MAIN, LIVE)).toThrow(
      "cannot list files of origin/ws/live-a"
    );
    expect(badRef.calls.some((call) => call.line.startsWith("git diff"))).toBe(
      false
    );
    const noDiff = fakeRun({
      ...healthyRepo,
      "git diff --name-only --no-renames origin/vertex/rebuild-darkfactory-20260921...origin/ws/live-a":
        fail,
    });
    expect(() => collectBusyFiles(noDiff.run, MAIN, LIVE)).toThrow(
      "cannot list files of origin/ws/live-a"
    );
  });

  it("keeps the old path of a renamed PR file busy", () => {
    const { calls, run } = fakeRun(healthyRepo);
    collectBusyFiles(run, MAIN, LIVE);
    expect(
      calls.find((call) => call.line.startsWith("gh api"))?.line
    ).toContain(".[] | .filename, (.previous_filename // empty)");
  });

  it("fails closed when the open PR list may be cut off", () => {
    const many = Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(
      "\n"
    );
    const { run } = fakeRun({ ...healthyRepo, "gh pr list": ok(many) });
    expect(() => collectBusyFiles(run, MAIN, LIVE)).toThrow(
      "1000 or more open PRs"
    );
  });

  it("fails closed when open PRs or their files cannot be listed", () => {
    const noList = fakeRun({ ...healthyRepo, "gh pr list": fail });
    expect(() => collectBusyFiles(noList.run, MAIN, LIVE)).toThrow(
      "cannot list open PRs"
    );
    const noDiff = fakeRun({
      ...healthyRepo,
      "gh api --paginate repos/{owner}/{repo}/pulls/86/files": fail,
    });
    expect(() => collectBusyFiles(noDiff.run, MAIN, LIVE)).toThrow(
      "cannot list files of PR #86"
    );
  });
});

describe("weekly pass", () => {
  it("names the busy list and the base in the model prompt", () => {
    expect(janitorPrompt("/tmp/busy.txt", LIVE)).toContain(
      `.agents/skills/janitor/SKILL.md and do one janitor pass on this worktree of ${LIVE}`
    );
  });

  it("dry run reports the base and busy files without a worktree", () => {
    const run = deps(healthyRepo);
    expect(runJanitorWeekly(["--dry-run"], env, run.deps)).toBe(0);
    expect(run.output.join("")).toBe(
      `janitor: base ${LIVE}; 3 busy file(s) from 2 ws branch(es) and 1 open PR(s)\n` +
        `janitor: skipped 1 ws branch(es) with no history shared with ${LIVE}: origin/ws/stale-main\n`
    );
    expect(run.written[`${WT}-busy.txt`]).toBe(
      "apps/web/a.ts\nresearch/master-rules/rule-pack.json\nshared.ts\n"
    );
    expect(run.calls.some((call) => call.line.startsWith("git worktree"))).toBe(
      false
    );
    expect(run.calls.at(-1)?.line).toBe(
      `rm -f ${WT}-busy.txt ${WT}-pr-body.md`
    );
  });

  it("prints no skip line when every ws branch shares history", () => {
    const run = deps({
      ...healthyRepo,
      "git for-each-ref": ok("origin/ws/live-a\n"),
    });
    expect(runJanitorWeekly(["--dry-run"], env, run.deps)).toBe(0);
    expect(run.output).toEqual([
      `janitor: base ${LIVE}; 3 busy file(s) from 1 ws branch(es) and 1 open PR(s)\n`,
    ]);
  });

  it("builds the worktree from and opens the draft PR to the default branch, never main", () => {
    const run = deps(
      { ...healthyRepo, "git -c core.quotePath=false diff --cached": ok(MOVE) },
      "- old-name.ts -> new-name.ts: kebab-case\n"
    );
    expect(runJanitorWeekly([], env, run.deps)).toBe(0);
    const lines = run.calls.map((call) => call.line);
    expect(lines).toContain(
      `git worktree add -q -b ${BRANCH} ${WT} origin/${LIVE}`
    );
    const pr = run.calls.find((call) => call.line.startsWith("gh pr create"));
    expect(pr?.line).toContain(`--base ${LIVE} --head ${BRANCH}`);
    expect(pr?.line).toContain(`--body-file ${WT}-pr-body.md`);
    expect(run.written[`${WT}-pr-body.md`]).toBe(
      "- old-name.ts -> new-name.ts: kebab-case"
    );
    expect(
      lines.filter((line) => /origin\/main\b|--base main\b/u.test(line))
    ).toEqual([]);
    const model = run.calls.find((call) => call.line.startsWith("omp"));
    expect(model).toMatchObject({ cwd: WT, inherit: true });
    expect(model?.line).toContain("--model=anthropic/claude-opus-5-5");
    const commit = lines.findIndex((line) => line.startsWith("git commit"));
    const unlink = lines.indexOf(`rm -f ${WT}/node_modules`);
    expect(commit).toBeGreaterThan(-1);
    // The pre-commit hook needs node_modules: unlink only after the commit.
    expect(unlink).toBeGreaterThan(commit);
    expect(lines.slice(-2)).toEqual([
      `git worktree remove --force ${WT}`,
      `git branch -D ${BRANCH}`,
    ]);
  });

  it("stops before the model pass when the branch already exists on origin", () => {
    const run = deps({
      ...healthyRepo,
      "git ls-remote --exit-code --heads origin": ok("x"),
    });
    expect(runJanitorWeekly([], env, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe(
      `janitor: ${BRANCH} already exists on origin or is unknown\n`
    );
    expect(run.calls.some((call) => call.line.startsWith("omp"))).toBe(false);
  });

  it("fails when the model pass made its own commit", () => {
    const run = deps({
      ...healthyRepo,
      "git rev-parse HEAD": [ok("aaa\n"), ok("bbb\n")],
    });
    expect(runJanitorWeekly([], env, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe(
      "janitor: the model pass committed; nothing pushed\n"
    );
  });

  it("blocks a pass that touches a busy, forbidden or deleted path", () => {
    const run = deps({
      ...healthyRepo,
      "git -c core.quotePath=false diff --cached": ok(
        `${MOVE}R090\tshared.ts\tlib/shared.ts\nD\tdocs/old.md\nM\tpackages/api/src/risk-allocator.ts\n`
      ),
    });
    expect(runJanitorWeekly([], env, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe(
      "janitor: rule violations; nothing pushed:\n" +
        "busy file: shared.ts\n" +
        "D not allowed: docs/old.md\n" +
        "forbidden path (risk): packages/api/src/risk-allocator.ts\n"
    );
    expect(run.calls.some((call) => call.line.startsWith("git commit"))).toBe(
      false
    );
  });

  it("lists forbidden path words in violations", () => {
    expect(findViolations("A\tconfig/new.ts\n", new Set<string>())).toEqual([
      "A not allowed: config/new.ts",
      "forbidden path (config): config/new.ts",
    ]);
    expect(FORBIDDEN_PATH_WORDS).toContain("broker");
  });

  it("reports no safe moves when the pass changed nothing", () => {
    const run = deps(healthyRepo);
    expect(
      runJanitorWeekly([], { VERTEX_MAIN_CHECKOUT: "/repo" }, run.deps)
    ).toBe(0);
    expect(run.output.at(-1)).toBe("janitor: no safe moves\n");
    expect(run.calls.some((call) => call.line.startsWith("git commit"))).toBe(
      false
    );
  });

  it("exits 0 with no safe moves from the public checkout, never naming node_modules in git add", () => {
    // Real git exits 1 when an add pathspec names an ignored path, even as an
    // exclude (rig runs 11-01 and 11-08: "janitor: git add failed").
    const run = deps({
      ...healthyRepo,
      "git add -A -- . :!JANITOR-REPORT.md :!node_modules": fail,
    });
    expect(runJanitorWeekly([], env, run.deps)).toBe(0);
    expect(run.output.at(-1)).toBe("janitor: no safe moves\n");
    const lines = run.calls.map((call) => call.line);
    const add = lines.findIndex((line) => line.startsWith("git add"));
    expect(lines[add]).toBe("git add -A -- . :!JANITOR-REPORT.md");
    expect(lines[add + 1]).toBe("git reset -q -- node_modules");
    expect(lines[add + 2]).toContain("diff --cached --name-status");
    expect(run.calls[0]?.cwd).toBe(MAIN);
  });

  it("fails the pass when unstaging node_modules fails", () => {
    const run = deps({ ...healthyRepo, "git reset": fail });
    expect(runJanitorWeekly([], env, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe("janitor: git reset node_modules failed\n");
  });

  it("--no-pr prints the report and does not commit or push", () => {
    const run = deps(
      { ...healthyRepo, "git -c core.quotePath=false diff --cached": ok(MOVE) },
      "  "
    );
    expect(
      runJanitorWeekly(["--no-pr"], { ...env, JANITOR_MODEL: "m" }, run.deps)
    ).toBe(0);
    expect(run.output).toContain(
      `janitor changes:\n${MOVE}janitor report:\nStructure-only janitor pass. See commit.\n`
    );
    expect(run.output.at(-1)).toBe("janitor: --no-pr, changes not committed\n");
    expect(run.calls.some((call) => call.line.startsWith("git push"))).toBe(
      false
    );
    expect(run.calls.some((call) => call.line.includes("--model=m"))).toBe(
      true
    );
  });

  it("returns 1 and removes the worktree when a step fails", () => {
    const run = deps({ ...healthyRepo, omp: fail });
    expect(runJanitorWeekly([], {}, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe("janitor: janitor model pass failed\n");
    expect(run.calls.at(-1)?.line).toBe(`git branch -D ${BRANCH}`);
  });

  it("refuses when the default branch equals the janitor branch", () => {
    const run = deps({
      "git ls-remote": ok(`ref: refs/heads/${BRANCH}\tHEAD\n`),
    });
    expect(runJanitorWeekly([], env, run.deps)).toBe(1);
    expect(run.output).toEqual(["janitor: refusing to work on the base\n"]);
  });

  it("reports a non-Error failure", () => {
    const run = deps(healthyRepo);
    run.deps.writeFile = () => {
      throw "disk full";
    };
    expect(runJanitorWeekly(["--dry-run"], env, run.deps)).toBe(1);
    expect(run.output.at(-1)).toBe("janitor: disk full\n");
  });
});

describe("stagePass against real git", () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-stage-"));
  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const { run } = createJanitorDeps();
  const target = join(root, "deps");
  mkdirSync(target);

  /** A repo like the janitor worktree: a node_modules symlink, one rename. */
  const worktree = (name: string, excludeLine: boolean): string => {
    const wt = join(root, name);
    const git = (...args: string[]) =>
      expect(
        run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: wt })
          .status
      ).toBe(0);
    mkdirSync(wt);
    git("init", "-q");
    // The repo's own .gitignore: `node_modules/` matches directories only.
    writeFileSync(join(wt, ".gitignore"), "node_modules/\n");
    // The rig's shared .git/info/exclude also lists bare `node_modules`.
    if (excludeLine)
      writeFileSync(join(wt, ".git/info/exclude"), "node_modules\n");
    writeFileSync(join(wt, "old-name.ts"), "export const a = 1;\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    symlinkSync(target, join(wt, "node_modules"));
    return wt;
  };

  for (const excludeLine of [true, false]) {
    const label = excludeLine ? "ignored" : "not ignored";
    it(`stages nothing when the pass made no moves (node_modules ${label})`, () => {
      const wt = worktree(`empty-${label.replace(" ", "-")}`, excludeLine);
      expect(stagePass(run, wt)).toBe("");
    });

    it(`stages the rename and never node_modules (node_modules ${label})`, () => {
      const wt = worktree(`move-${label.replace(" ", "-")}`, excludeLine);
      expect(
        run("git", ["mv", "old-name.ts", "new-name.ts"], { cwd: wt }).status
      ).toBe(0);
      writeFileSync(join(wt, "JANITOR-REPORT.md"), "report\n");
      expect(stagePass(run, wt)).toBe("R100\told-name.ts\tnew-name.ts\n");
    });
  }
});
