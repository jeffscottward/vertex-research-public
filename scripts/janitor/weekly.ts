// Weekly janitor pass. It runs the janitor skill on a fresh worktree of the
// repository default branch and opens a DRAFT PR to that branch. It never
// pushes to the default branch. The default branch comes from the remote,
// never from a hard-coded name: a stale `main` line has unrelated history,
// which made every file look busy (card vertex-ws-branches-unrelated-history).

export interface RunResult {
  status: number;
  stdout: string;
}

export interface RunOptions {
  cwd: string;
  /** Stream the child's output to this process (for the model pass). */
  inherit?: boolean;
}

export type Run = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => RunResult;

export interface Output {
  write: (line: string) => unknown;
}

export interface JanitorDeps {
  now: Date;
  out: Output;
  readFile: (path: string) => string | undefined;
  run: Run;
  writeFile: (path: string, text: string) => void;
}

export interface BusyFiles {
  branches: number;
  files: string[];
  prs: number;
  /** origin/ws/* branches that share no history with the default branch. */
  unrelated: string[];
}

type Mode = "full" | "no-pr" | "dry-run";

const DEFAULT_MODEL = "anthropic/claude-opus-5-5"; // Claude only.
const PR_LIMIT = 1000;
// GitHub rejects PR bodies over 65,536 characters.
const MAX_BODY = 60_000;
/** Path words the skill never touches (trading, risk and config paths). */
export const FORBIDDEN_PATH_WORDS = [
  "order",
  "broker",
  "gate",
  "risk",
  "master-rule",
  "live",
  "crown",
  "config",
] as const;

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** Parse `git ls-remote --symref origin HEAD` output to a branch name. */
export const parseSymrefHead = (stdout: string): string | undefined =>
  /^ref: refs\/heads\/(\S+)\s+HEAD$/mu.exec(stdout)?.[1];

/**
 * The repository default branch. Ask the remote first; fall back to the cached
 * `origin/HEAD` only when the remote cannot answer. Never assume `main`.
 */
export const resolveDefaultBranch = (run: Run, cwd: string): string => {
  const live = run("git", ["ls-remote", "--symref", "origin", "HEAD"], {
    cwd,
  });
  const fromRemote =
    live.status === 0 ? parseSymrefHead(live.stdout) : undefined;
  if (fromRemote !== undefined) return fromRemote;
  const cached = run(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd }
  );
  const fromCache = cached.stdout.trim().replace(/^origin\//u, "");
  if (cached.status === 0 && fromCache.length > 0) return fromCache;
  throw new Error("cannot resolve the default branch of origin");
};

/** Files changed by open PRs to `base` and by origin/ws/* branches. */
export const collectBusyFiles = (
  run: Run,
  cwd: string,
  base: string
): BusyFiles => {
  const files = new Set<string>();
  const unrelated: string[] = [];
  const baseRef = `origin/${base}`;
  const refs = run(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/ws/"],
    { cwd }
  );
  if (refs.status !== 0) throw new Error("cannot list origin/ws/* branches");
  const branches = lines(refs.stdout);
  for (const branch of branches) {
    // `git merge-base` exits 1 only when the refs share no history; other
    // failures must not hide a branch's files.
    const mergeBase = run("git", ["merge-base", baseRef, branch], { cwd });
    if (mergeBase.status === 1) {
      unrelated.push(branch);
      continue;
    }
    const diff =
      mergeBase.status === 0
        ? run(
            "git",
            ["diff", "--name-only", "--no-renames", `${baseRef}...${branch}`],
            { cwd }
          )
        : undefined;
    if (diff?.status !== 0) throw new Error(`cannot list files of ${branch}`);
    for (const file of lines(diff.stdout)) files.add(file);
  }
  const prList = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--base",
      base,
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number",
      "--jq",
      ".[].number",
    ],
    { cwd }
  );
  if (prList.status !== 0) throw new Error("cannot list open PRs");
  const prs = lines(prList.stdout);
  if (prs.length >= PR_LIMIT)
    throw new Error(
      `${PR_LIMIT} or more open PRs; the busy list may be incomplete`
    );
  for (const pr of prs) {
    // The files API also answers for PRs too large for `gh pr diff`; a rename
    // keeps its old path busy too.
    const diff = run(
      "gh",
      [
        "api",
        "--paginate",
        `repos/{owner}/{repo}/pulls/${pr}/files`,
        "--jq",
        ".[] | .filename, (.previous_filename // empty)",
      ],
      { cwd }
    );
    if (diff.status !== 0) throw new Error(`cannot list files of PR #${pr}`);
    for (const file of lines(diff.stdout)) files.add(file);
  }
  return {
    branches: branches.length,
    files: [...files].sort(),
    prs: prs.length,
    unrelated,
  };
};

export const janitorPrompt = (busyPath: string, base: string): string =>
  `Read .agents/skills/janitor/SKILL.md and do one janitor pass on this worktree of ${base}. ` +
  `The busy-file list is ${busyPath}; it was computed against ${base}. Do not commit. Do not push.`;

/**
 * Check the staged pass against the skill rules, independent of the model:
 * only renames (R) and edits (M) are allowed, and no old or new path may be
 * busy or contain a forbidden word. Returns one line per violation.
 */
export const findViolations = (
  nameStatus: string,
  busy: ReadonlySet<string>
): string[] => {
  const violations: string[] = [];
  for (const line of lines(nameStatus)) {
    const [status = "", ...paths] = line.split("\t");
    const kind = status.charAt(0);
    if (kind !== "R" && kind !== "M")
      violations.push(`${status} not allowed: ${paths.join(" -> ")}`);
    for (const path of paths) {
      if (busy.has(path)) violations.push(`busy file: ${path}`);
      const word = FORBIDDEN_PATH_WORDS.find((part) =>
        path.toLowerCase().includes(part)
      );
      if (word !== undefined)
        violations.push(`forbidden path (${word}): ${path}`);
    }
  }
  return violations;
};

const must = (result: RunResult, what: string): RunResult => {
  if (result.status !== 0) throw new Error(`${what} failed`);
  return result;
};

const summary = (base: string, busy: BusyFiles): string => {
  const skipped =
    busy.unrelated.length === 0
      ? ""
      : `janitor: skipped ${busy.unrelated.length} ws branch(es) with no history shared with ${base}: ${busy.unrelated.join(", ")}\n`;
  return (
    `janitor: base ${base}; ${busy.files.length} busy file(s) from ${busy.branches} ws branch(es) and ${busy.prs} open PR(s)\n` +
    skipped
  );
};

const openDraftPr = (
  deps: JanitorDeps,
  wt: string,
  pass: { base: string; branch: string; stamp: string; report: string }
): void => {
  const { run } = deps;
  const title = `chore(janitor): weekly structure pass ${pass.stamp}`;
  const bodyPath = `${wt}-pr-body.md`;
  deps.writeFile(bodyPath, pass.report.slice(0, MAX_BODY));
  must(run("git", ["commit", "-q", "-m", title], { cwd: wt }), "git commit");
  must(
    run("git", ["push", "-q", "-u", "origin", pass.branch], { cwd: wt }),
    "git push"
  );
  must(
    run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        pass.base,
        "--head",
        pass.branch,
        "--title",
        title,
        "--body-file",
        bodyPath,
      ],
      { cwd: wt, inherit: true }
    ),
    "gh pr create"
  );
};

/** One pass. Exit code 0 on success or no safe moves, 1 on failure. */
export const runJanitorWeekly = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: JanitorDeps
): number => {
  const { run, out } = deps;
  let mode: Mode = argv.includes("--no-pr") ? "no-pr" : "full";
  if (argv.includes("--dry-run")) mode = "dry-run";
  const main =
    env["VERTEX_MAIN_CHECKOUT"] ??
    `${env["HOME"] ?? ""}/Github/trading/vertex-research`;
  // UTC minute stamp: a rerun on the same day gets its own branch and worktree.
  const stamp = deps.now
    .toISOString()
    .slice(0, 16)
    .replaceAll(/[-:]/gu, "")
    .replace("T", "-");
  const branch = `ws/janitor-${stamp}`;
  const wt = `/tmp/vertex-research-janitor-${stamp}`;
  const busyPath = `${wt}-busy.txt`;
  let worktree = false;
  try {
    const base = resolveDefaultBranch(run, main);
    if (base === branch) throw new Error("refusing to work on the base");
    must(
      run("git", ["fetch", "-q", "--prune", "origin"], { cwd: main }),
      "git fetch"
    );
    const busy = collectBusyFiles(run, main, base);
    out.write(summary(base, busy));
    deps.writeFile(busyPath, `${busy.files.join("\n")}\n`);
    if (mode === "dry-run") return 0;
    // `--exit-code` exits 2 when the branch is absent on origin.
    const remote = run(
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", branch],
      { cwd: main }
    );
    if (remote.status !== 2)
      throw new Error(`${branch} already exists on origin or is unknown`);

    must(
      run(
        "git",
        ["worktree", "add", "-q", "-b", branch, wt, `origin/${base}`],
        {
          cwd: main,
        }
      ),
      "git worktree add"
    );
    worktree = true;
    const start = must(
      run("git", ["rev-parse", "HEAD"], { cwd: wt }),
      "git rev-parse"
    ).stdout;
    must(
      run("ln", ["-s", `${main}/node_modules`, `${wt}/node_modules`], {
        cwd: wt,
      }),
      "node_modules link"
    );
    const model = env["JANITOR_MODEL"] ?? DEFAULT_MODEL;
    must(
      run(
        "omp",
        [
          "-p",
          "--no-session",
          `--model=${model}`,
          janitorPrompt(busyPath, base),
        ],
        { cwd: wt, inherit: true }
      ),
      "janitor model pass"
    );
    const head = must(
      run("git", ["rev-parse", "HEAD"], { cwd: wt }),
      "git rev-parse"
    ).stdout;
    if (head !== start)
      throw new Error("the model pass committed; nothing pushed");
    must(
      run(
        "git",
        ["add", "-A", "--", ".", ":!JANITOR-REPORT.md", ":!node_modules"],
        { cwd: wt }
      ),
      "git add"
    );
    const staged = must(
      run(
        "git",
        // Raw paths: a quoted non-ASCII path would escape the busy check.
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--cached",
          "--name-status",
          "-M",
        ],
        { cwd: wt }
      ),
      "git diff"
    ).stdout;
    if (staged.trim().length === 0) {
      out.write("janitor: no safe moves\n");
      return 0;
    }
    const written = deps.readFile(`${wt}/JANITOR-REPORT.md`)?.trim() ?? "";
    const report =
      written.length > 0 ? written : "Structure-only janitor pass. See commit.";
    out.write(
      `janitor changes:\n${staged.trimEnd()}\njanitor report:\n${report}\n`
    );
    const violations = findViolations(staged, new Set(busy.files));
    if (violations.length > 0) {
      out.write(
        `janitor: rule violations; nothing pushed:\n${violations.join("\n")}\n`
      );
      return 1;
    }
    if (mode === "no-pr") {
      out.write("janitor: --no-pr, changes not committed\n");
      return 0;
    }
    openDraftPr(deps, wt, { base, branch, report, stamp });
    return 0;
  } catch (error) {
    out.write(
      `janitor: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  } finally {
    run("rm", ["-f", busyPath, `${wt}-pr-body.md`], { cwd: main });
    if (worktree) {
      // The node_modules link stays until here: the pre-commit hook (biome via
      // `bunx --no-install`) needs it. `git add` excludes it by pathspec.
      run("rm", ["-f", `${wt}/node_modules`], { cwd: main });
      run("git", ["worktree", "remove", "--force", wt], { cwd: main });
      // Keep a pushed branch; drop the local one of a pass that pushed nothing.
      run("git", ["branch", "-D", branch], { cwd: main });
    }
  }
};
