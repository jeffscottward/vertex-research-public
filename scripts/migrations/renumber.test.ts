import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withoutGitRepositoryEnvironment } from "../lib/git-env.ts";
import {
  JOURNAL,
  type Journal,
  planRenumber,
  RenumberError,
  readJournal,
  runRenumber,
} from "./renumber.ts";

const ZERO = "00000000-0000-0000-0000-000000000000";
const META = "packages/db/migrations/meta";
// Git hooks export GIT_DIR/GIT_INDEX_FILE; the fixture repositories must never inherit them.
const gitEnvironment = withoutGitRepositoryEnvironment(process.env);

const journalOf = (
  entries: ReadonlyArray<readonly [string, number]>
): Journal => ({
  version: "7",
  dialect: "postgresql",
  entries: entries.map(([tag, when], idx) => ({
    idx,
    version: "7",
    when,
    tag,
    breakpoints: true,
  })),
});

describe("planRenumber", () => {
  it("appends the branch's migrations after the base's with the next numbers and newer when values", () => {
    const plan = planRenumber({
      base: journalOf([
        ["0000_a", 100],
        ["0001_b", 200],
        ["0002_c", 300],
      ]),
      ours: journalOf([
        ["0000_a", 100],
        ["0001_b", 200],
        ["0002_mine", 250],
        ["0003_later", 900],
      ]),
      sqlTags: ["0003_later", "0000_a", "0002_mine", "0001_b", "0002_c"],
    });
    expect(plan.moves).toEqual([
      { from: "0002_mine", to: "0003_mine" },
      { from: "0003_later", to: "0004_later" },
    ]);
    expect(plan.journal.entries.slice(3)).toEqual([
      { idx: 3, version: "7", when: 301, tag: "0003_mine", breakpoints: true },
      { idx: 4, version: "7", when: 900, tag: "0004_later", breakpoints: true },
    ]);
  });

  it("keeps a branch whose migrations already follow the base", () => {
    const ours = journalOf([
      ["0000_a", 100],
      ["0001_mine", 500],
    ]);
    const plan = planRenumber({
      base: journalOf([["0000_a", 100]]),
      ours,
      sqlTags: ["0000_a", "0001_mine"],
    });
    expect(plan).toEqual({ journal: ours, own: ["0001_mine"], moves: [] });
  });

  it("orders migrations that share a number by name and fills in entries the branch journal lacks", () => {
    const plan = planRenumber({
      base: journalOf([]),
      ours: undefined,
      sqlTags: ["0001_zeta", "0001_alpha"],
    });
    expect(plan.journal).toEqual(
      journalOf([
        ["0000_alpha", 1],
        ["0001_zeta", 2],
      ])
    );
  });

  it("refuses a checkout that lacks a base migration", () => {
    expect(() =>
      planRenumber({
        base: journalOf([
          ["0000_a", 100],
          ["0001_b", 200],
        ]),
        ours: undefined,
        sqlTags: ["0000_a"],
      })
    ).toThrow(
      new RenumberError(
        "the base migrations 0001_b are not in this checkout; merge the base branch first"
      )
    );
  });

  it("refuses migration files that are not NNNN_snake_case", () => {
    expect(() =>
      planRenumber({
        base: journalOf([]),
        ours: undefined,
        sqlTags: ["notes", "0000_a"],
      })
    ).toThrow("migration file names must be NNNN_snake_case.sql: notes.sql");
  });
});

describe("readJournal", () => {
  it("reads a Drizzle journal and rejects anything else", () => {
    const journal = journalOf([["0000_a", 1]]);
    expect(readJournal(JSON.stringify(journal))).toEqual(journal);
    expect(readJournal("{")).toBeUndefined();
    expect(
      readJournal(JSON.stringify({ ...journal, extra: true }))
    ).toBeUndefined();
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const git = (root: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

const put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const read = (root: string, path: string): string =>
  readFileSync(join(root, path), "utf8");

const commit = (
  root: string,
  files: Readonly<Record<string, string>>,
  message: string
): void => {
  put(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};

const journalFile = (
  entries: ReadonlyArray<readonly [string, number]>
): string => `${JSON.stringify(journalOf(entries), null, 2)}\n`;

const snapshotFile = (id: string, prevId: string): string =>
  `{\n  "id": "${id}",\n  "prevId": "${prevId}",\n  "version": "7"\n}\n`;

const BASE_ENTRIES = [
  ["0000_a", 100],
  ["0001_b", 200],
] as const;

/** main has 0000_a and 0001_b; `feature` adds 0002_mine and 0003_more, main then adds 0002_theirs. */
const createRepository = (
  options: {
    conflictInB?: boolean;
    mineSnapshot?: boolean;
    sharedNumber?: boolean;
    theirsSnapshot?: boolean;
  } = {}
): string => {
  const root = mkdtempSync(join(tmpdir(), "db-renumber-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  commit(
    root,
    {
      "README.md": "readme\n",
      "packages/db/migrations/0000_a.sql": "CREATE TABLE a();\n",
      "packages/db/migrations/0001_b.sql": "CREATE TABLE b();\n",
      [`${META}/0000_snapshot.json`]: snapshotFile("A0", ZERO),
      [`${META}/0001_snapshot.json`]: snapshotFile("B0", "A0"),
      [JOURNAL]: journalFile(BASE_ENTRIES),
      "packages/db/rollback/0001_b.down.sql": "DROP TABLE b;\n",
    },
    "base"
  );
  git(root, "checkout", "-q", "-b", "feature");
  commit(
    root,
    {
      "README.md": "readme 0002_mine\n",
      "packages/db/migrations/0002_mine.sql":
        "-- 0002_mine adds mine\nCREATE TABLE mine();\n",
      "packages/db/migrations/0003_more.sql": "CREATE TABLE more();\n",
      ...(options.conflictInB
        ? { "packages/db/migrations/0001_b.sql": "CREATE TABLE b(x int);\n" }
        : {}),
      ...(options.sharedNumber
        ? { "packages/db/migrations/0002_zz.sql": "CREATE TABLE zz();\n" }
        : {}),
      ...(options.mineSnapshot === false
        ? {}
        : { [`${META}/0002_snapshot.json`]: snapshotFile("M0", "B0") }),
      [JOURNAL]: journalFile([
        ...BASE_ENTRIES,
        ["0002_mine", 300],
        ["0003_more", 400],
      ]),
      "packages/db/rollback/0002_mine.down.sql":
        "-- reverses 0002_mine\nDROP TABLE mine;\n",
      "src/mine.test.ts":
        'read("migrations/0002_mine.sql"); // migration 0002\n',
      "docs/notes.md": "0002_mine_extra is another name\n",
      "assets/blob.bin": "0002_mine\u0000binary\n",
    },
    "feature migrations"
  );
  git(root, "checkout", "-q", "main");
  commit(
    root,
    {
      "README.md": "readme main\n",
      "packages/db/migrations/0002_theirs.sql": "CREATE TABLE theirs();\n",
      ...(options.conflictInB
        ? { "packages/db/migrations/0001_b.sql": "CREATE TABLE b(y int);\n" }
        : {}),
      ...(options.theirsSnapshot === false
        ? {}
        : { [`${META}/0002_snapshot.json`]: snapshotFile("T0", "B0") }),
      [JOURNAL]: journalFile([...BASE_ENTRIES, ["0002_theirs", 350]]),
    },
    "base migration 0002"
  );
  git(root, "checkout", "-q", "feature");
  return root;
};

const mergeMain = (root: string): void => {
  expect(() => git(root, "merge", "-q", "--no-edit", "main")).toThrow();
};

const unmergedPaths = (root: string): string[] =>
  git(root, "diff", "--name-only", "--diff-filter=U")
    .split("\n")
    .filter(Boolean);

const run = (root: string, ...argv: string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runRenumber(argv, {
    cwd: root,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
};

describe("runRenumber", () => {
  it("moves the branch's migrations behind the base's after both added migration 0002", () => {
    const root = createRepository();
    mergeMain(root);
    expect(unmergedPaths(root)).toEqual(
      [JOURNAL, `${META}/0002_snapshot.json`, "README.md"].sort()
    );

    const result = run(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      "db:renumber: staged 10 paths (base MERGE_HEAD)",
      "moved 0002_mine -> 0003_mine",
      "moved 0003_more -> 0004_more",
      'check the old number: src/mine.test.ts:1: read("migrations/0003_mine.sql"); // migration 0002',
      "conflicts left: README.md",
      "Next: resolve any other conflicts, `git commit` (or `git merge --continue`), then run the db tests.",
    ]);
    expect(readJournal(read(root, JOURNAL))).toEqual(
      journalOf([
        ...BASE_ENTRIES,
        ["0002_theirs", 350],
        ["0003_mine", 351],
        ["0004_more", 400],
      ])
    );
    expect(read(root, "packages/db/migrations/0003_mine.sql")).toBe(
      "-- 0003_mine adds mine\nCREATE TABLE mine();\n"
    );
    expect(existsSync(join(root, "packages/db/migrations/0002_mine.sql"))).toBe(
      false
    );
    expect(read(root, "packages/db/migrations/0004_more.sql")).toBe(
      "CREATE TABLE more();\n"
    );
    expect(read(root, "packages/db/rollback/0003_mine.down.sql")).toBe(
      "-- reverses 0003_mine\nDROP TABLE mine;\n"
    );
    expect(read(root, `${META}/0002_snapshot.json`)).toBe(
      snapshotFile("T0", "B0")
    );
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      snapshotFile("M0", "T0")
    );
    expect(read(root, "docs/notes.md")).toBe(
      "0002_mine_extra is another name\n"
    );
    expect(read(root, "assets/blob.bin")).toBe("0002_mine\u0000binary\n");
    // A file that still conflicts gets the new tag but stays unresolved.
    expect(read(root, "README.md")).toContain("readme 0003_mine");
    expect(unmergedPaths(root)).toEqual(["README.md"]);

    put(root, { "README.md": "readme main 0003_mine\n" });
    git(root, "add", "README.md");
    expect(run(root).stdout).toEqual([
      "db:renumber: nothing to do; this branch's migrations already follow MERGE_HEAD.",
    ]);
    git(root, "commit", "-q", "--no-edit");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("checks against origin/HEAD outside a merge and repairs a broken or missing journal", () => {
    const root = createRepository();
    mergeMain(root);
    run(root);
    put(root, { "README.md": "readme\n" });
    git(root, "add", "README.md");
    git(root, "commit", "-q", "--no-edit");
    git(root, "update-ref", "refs/remotes/origin/main", "main");
    git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main"
    );

    expect(run(root).stdout).toEqual([
      "db:renumber: nothing to do; this branch's migrations already follow origin/main.",
    ]);

    put(root, { [JOURNAL]: "{ broken" });
    expect(run(root, "--base", "main")).toEqual({
      code: 0,
      stdout: [
        "db:renumber: staged 1 paths (base main)",
        "Next: resolve any other conflicts, `git commit` (or `git merge --continue`), then run the db tests.",
      ],
      stderr: [],
    });
    // Without the branch's own entries, `when` continues from the base's last entry.
    expect(
      readJournal(read(root, JOURNAL))
        ?.entries.slice(3)
        .map((entry) => entry.when)
    ).toEqual([351, 352]);

    rmSync(join(root, JOURNAL));
    expect(run(root, "--base", "main").code).toBe(0);
    expect(readJournal(read(root, JOURNAL))?.entries).toHaveLength(5);
  });

  it("fails with exit 1 while a migration file the base also changed still conflicts", () => {
    const root = createRepository({ conflictInB: true });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "conflicts left: README.md, packages/db/migrations/0001_b.sql"
    );
    expect(result.stderr).toEqual([
      "db:renumber: migration files that the base also changed still conflict; resolve them by hand, then run db:renumber again.",
    ]);
  });

  it("moves the branch's snapshot when the base's migration has none", () => {
    const root = createRepository({ theirsSnapshot: false });
    mergeMain(root);
    expect(unmergedPaths(root)).toEqual(["README.md", JOURNAL]);

    expect(run(root).code).toBe(0);

    expect(existsSync(join(root, `${META}/0002_snapshot.json`))).toBe(false);
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      snapshotFile("M0", "B0")
    );
  });

  it("leaves the base's snapshot in place when the branch's migration has none", () => {
    const root = createRepository({ mineSnapshot: false });
    mergeMain(root);
    expect(unmergedPaths(root)).toEqual(["README.md", JOURNAL]);

    expect(run(root).code).toBe(0);

    expect(read(root, `${META}/0002_snapshot.json`)).toBe(
      snapshotFile("T0", "B0")
    );
    expect(existsSync(join(root, `${META}/0003_snapshot.json`))).toBe(false);
    expect(existsSync(join(root, "packages/db/migrations/0003_mine.sql"))).toBe(
      true
    );
  });

  it("refuses a branch that has not merged the base yet", () => {
    const root = createRepository();
    expect(run(root, "--base", "main")).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        "db:renumber: the base migrations 0002_theirs are not in this checkout; merge the base branch first",
      ],
    });
  });

  it("asks for --base without a merge or origin/HEAD", () => {
    const root = createRepository();
    expect(run(root).stderr).toEqual([
      "db:renumber: no merge in progress and no origin/HEAD; pass --base <ref>",
    ]);
  });

  it("rejects a base whose journal is not a Drizzle journal", () => {
    const root = createRepository();
    git(root, "checkout", "-q", "-b", "broken", "main");
    commit(root, { [JOURNAL]: "[]\n" }, "broken journal");
    git(root, "checkout", "-q", "feature");
    expect(run(root, "--base", "broken").stderr).toEqual([
      `db:renumber: broken:${JOURNAL} is not a Drizzle journal`,
    ]);
    expect(run(root, "--base", "missing").stderr[0]).toMatch(
      /^db:renumber: git show missing:packages\/db\/migrations\/meta\/_journal\.json failed: /u
    );
  });

  it("rejects a snapshot without ids before it writes anything", () => {
    const root = createRepository();
    mergeMain(root);
    put(root, { [`${META}/0009_snapshot.json`]: "{}\n" });
    expect(run(root).stderr).toEqual([
      `db:renumber: ${META}/0009_snapshot.json has no id/prevId (does it still conflict?)`,
    ]);
    expect(read(root, "src/mine.test.ts")).toContain("0002_mine");
    expect(existsSync(join(root, "packages/db/migrations/0002_mine.sql"))).toBe(
      true
    );
  });

  it("refuses a --base older than the merged branch instead of renumbering the base's migrations", () => {
    const root = createRepository();
    mergeMain(root);
    expect(run(root, "--base", "main~1").stderr).toEqual([
      "db:renumber: 0002_theirs already on MERGE_HEAD, so not this branch's; pass --base MERGE_HEAD",
    ]);
    expect(existsSync(join(root, "packages/db/migrations/0002_mine.sql"))).toBe(
      true
    );
  });

  it("refuses a stale origin/HEAD after the merge commit when the local base branch is newer", () => {
    const root = createRepository();
    mergeMain(root);
    run(root);
    put(root, { "README.md": "readme\n" });
    git(root, "add", "README.md");
    git(root, "commit", "-q", "--no-edit");
    git(root, "update-ref", "refs/remotes/origin/main", "main~1");
    git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main"
    );
    expect(run(root).stderr).toEqual([
      "db:renumber: 0002_theirs already on main, so not this branch's; pass --base main",
    ]);
  });

  it("refuses to run during a rebase, where the conflict stages are swapped", () => {
    const root = createRepository();
    expect(() => git(root, "rebase", "-q", "main")).toThrow();
    expect(unmergedPaths(root)).toContain(JOURNAL);
    expect(run(root)).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        "db:renumber: a rebase is in progress. Run `git rebase --abort`, then `git merge <base>` and db:renumber.",
      ],
    });
    expect(existsSync(join(root, "packages/db/migrations/0002_mine.sql"))).toBe(
      true
    );
  });

  it("refuses two branch migrations that share a number and its snapshot", () => {
    const root = createRepository({ sharedNumber: true });
    mergeMain(root);
    expect(run(root).stderr).toEqual([
      `db:renumber: two of this branch's migrations share ${META}/0002_snapshot.json; give one of them another number by hand first`,
    ]);
  });

  it("ignores GIT_DIR from a Git hook and reports a git that cannot start", () => {
    const root = createRepository();
    const other = createRepository();
    mergeMain(root);
    const saved = {
      GIT_DIR: process.env["GIT_DIR"],
      PATH: process.env["PATH"],
    };
    try {
      process.env["GIT_DIR"] = join(other, ".git");
      expect(run(root).code).toBe(0);
      process.env["PATH"] = join(root, "no-bin");
      expect(run(root).stderr[0]).toMatch(
        /^db:renumber: git rev-parse --show-toplevel did not run: /u
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    expect(existsSync(join(root, "packages/db/migrations/0003_mine.sql"))).toBe(
      true
    );
    expect(git(other, "status", "--porcelain")).toBe("");
  });

  it("lets unexpected file system errors through", () => {
    const root = createRepository();
    mergeMain(root);
    mkdirSync(join(root, `${META}/0009_snapshot.json`));
    expect(() => run(root)).toThrow(/EISDIR/u);
  });

  it("prints usage, rejects unknown arguments and needs a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "db-renumber-outside-"));
    directories.push(outside);
    expect(run(outside, "--help").stdout[0]).toMatch(
      /^Usage: pnpm db:renumber/u
    );
    const unknown = run(outside, "--bogus");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr[0]).toMatch(
      /^db:renumber: Unknown option '--bogus'/u
    );
    expect(run(outside).stderr[0]).toMatch(
      /^db:renumber: git rev-parse --show-toplevel failed: /u
    );
  });
});
