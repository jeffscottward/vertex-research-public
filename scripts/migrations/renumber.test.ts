import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { withoutGitRepositoryEnvironment } from "../lib/git-env.ts";
import {
  formatSnapshot,
  JOURNAL,
  type Journal,
  mergeSnapshots,
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

describe("mergeSnapshots", () => {
  const table = (columns: Readonly<Record<string, string>>) => ({
    columns: Object.fromEntries(
      Object.entries(columns).map(([name, type]) => [name, { name, type }])
    ),
  });
  const start = {
    enums: { color: { values: ["red"] } },
    tables: {
      a: table({ id: "int", note: "text" }),
      old: table({ id: "int" }),
    },
  };

  it("takes the base's added table, column and enum when the branch did not change them", () => {
    const base = {
      enums: { ...start.enums, size: { values: ["s"] } },
      tables: {
        ...start.tables,
        a: table({ extra: "int", id: "int", note: "text" }),
        theirs: table({ id: "int" }),
      },
    };
    expect(mergeSnapshots(start, base, start)).toEqual({
      conflicts: [],
      value: base,
    });
  });

  it("takes the base's altered column in a table from before the branch split", () => {
    const base = {
      ...start,
      tables: { ...start.tables, a: table({ id: "bigint", note: "text" }) },
    };
    const branch = {
      ...start,
      tables: { ...start.tables, mine: table({ id: "int" }) },
    };
    const merged = mergeSnapshots(start, base, branch);
    expect(merged).toEqual({
      conflicts: [],
      value: {
        ...base,
        tables: { ...base.tables, ...branch.tables, a: base.tables.a },
      },
    });
  });

  it("puts the branch's keys first, then the keys that only the base has", () => {
    const merged = mergeSnapshots(
      JSON.parse('{"b":1,"a":1}'),
      JSON.parse('{"c":1,"b":1,"a":1}'),
      JSON.parse('{"b":1,"z":1,"a":1}')
    );
    expect(Object.keys(merged.value as object)).toEqual(["b", "z", "a", "c"]);
  });

  it("keeps the branch's added table and altered column when the base did not change them", () => {
    const base = {
      ...start,
      tables: { ...start.tables, theirs: table({ id: "int" }) },
    };
    const branch = {
      ...start,
      tables: {
        a: table({ id: "int", note: "varchar" }),
        mine: table({ id: "int" }),
        old: start.tables.old,
      },
    };
    const merged = mergeSnapshots(start, base, branch);
    expect(merged.conflicts).toEqual([]);
    expect(Object.keys((merged.value as typeof base).tables).sort()).toEqual([
      "a",
      "mine",
      "old",
      "theirs",
    ]);
    expect((merged.value as typeof branch).tables.a).toEqual(branch.tables.a);
  });

  it("removes a key that one side removed and the other side left unchanged", () => {
    const base = { ...start, tables: { a: start.tables.a } };
    const branch = { tables: start.tables };
    expect(mergeSnapshots(start, base, branch)).toEqual({
      conflicts: [],
      value: { tables: { a: start.tables.a } },
    });
  });

  it("takes a value that both sides changed in the same way", () => {
    const both = { ...start, enums: { color: { values: ["red", "blue"] } } };
    expect(mergeSnapshots(start, { ...both, version: "7" }, both)).toEqual({
      conflicts: [],
      value: { ...both, version: "7" },
    });
  });

  it("keeps the branch value and reports the key path when both sides changed one value", () => {
    const base = {
      enums: { color: { values: ["red", "green"] } },
      tables: { ...start.tables, a: table({ id: "bigint", note: "text" }) },
    };
    const branch = {
      enums: { color: { values: ["red", "blue"] } },
      tables: { ...start.tables, a: table({ id: "uuid", note: "text" }) },
    };
    expect(mergeSnapshots(start, base, branch)).toEqual({
      conflicts: ["enums > color > values", "tables > a > columns > id > type"],
      value: branch,
    });
    expect(mergeSnapshots({ k: {} }, { k: { x: 1 } }, { k: "text" })).toEqual({
      conflicts: ["k"],
      value: { k: "text" },
    });
  });

  it("reports a key that one side removed and the other changed", () => {
    const changed = {
      ...start,
      tables: { ...start.tables, old: table({ id: "bigint" }) },
    };
    const removed = { ...start, tables: { a: start.tables.a } };
    expect(mergeSnapshots(start, removed, changed)).toEqual({
      conflicts: ["tables > old"],
      value: changed,
    });
    expect(mergeSnapshots(start, changed, removed)).toEqual({
      conflicts: ["tables > old"],
      value: removed,
    });
  });

  it("reports a key that both sides added with different content, as one conflict", () => {
    const base = {
      ...start,
      tables: { ...start.tables, fresh: table({ a: "int" }) },
    };
    const branch = {
      ...start,
      tables: { ...start.tables, fresh: table({ b: "int" }) },
    };
    expect(mergeSnapshots(start, base, branch)).toEqual({
      conflicts: ["tables > fresh"],
      value: branch,
    });
  });
});

describe("formatSnapshot", () => {
  it("prints nested objects, empty values and arrays of objects", () => {
    expect(
      formatSnapshot({
        count: 2,
        id: "a",
        ok: true,
        tables: {
          t: { columns: {}, indexes: [], keys: [{ on: ["id"] }, null] },
        },
      })
    ).toBe(
      [
        "{",
        '  "count": 2,',
        '  "id": "a",',
        '  "ok": true,',
        '  "tables": {',
        '    "t": {',
        '      "columns": {},',
        '      "indexes": [],',
        '      "keys": [',
        "        {",
        '          "on": ["id"]',
        "        },",
        "        null",
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
    );
  });

  it("keeps an array of plain values on one line up to 80 columns and breaks a longer one", () => {
    // `  "values": ["…", "b"]` is 80 columns with a 59-character first value.
    const fits = ["x".repeat(59), "b"];
    const line = `  "values": ${JSON.stringify(fits).replace(",", ", ")}`;
    expect(line).toHaveLength(80);
    expect(formatSnapshot({ values: fits })).toBe(`{\n${line}\n}\n`);
    // A following comma is part of the line.
    expect(formatSnapshot({ values: fits, z: 1 })).toBe(
      `{\n  "values": [\n    "${fits[0]}",\n    "b"\n  ],\n  "z": 1\n}\n`
    );
    // One column less leaves room for the comma; one column more does not fit.
    const shorter = [fits[0]?.slice(1), "b"];
    expect(formatSnapshot({ values: shorter, z: 1 })).toBe(
      `{\n  "values": ["${shorter[0]}", "b"],\n  "z": 1\n}\n`
    );
    expect(formatSnapshot({ values: [`${fits[0]}x`, "b"] })).toBe(
      `{\n  "values": [\n    "${fits[0]}x",\n    "b"\n  ]\n}\n`
    );
    // An array inside an array has no key: only the indent counts.
    expect(
      formatSnapshot([
        ["a", "b"],
        [`${"x".repeat(72)}`, "b"],
      ])
    ).toBe(
      `[\n  ["a", "b"],\n  [\n    "${"x".repeat(72)}",\n    "b"\n  ]\n]\n`
    );
  });

  it("reproduces every committed snapshot", () => {
    const meta = join(import.meta.dirname, "../../packages/db/migrations/meta");
    const names = readdirSync(meta).filter((name) =>
      name.endsWith("_snapshot.json")
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = readFileSync(join(meta, name), "utf8");
      expect(formatSnapshot(JSON.parse(text)) === text, name).toBe(true);
    }
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

/** A snapshot with tables; `tables` maps a table name to its one column's type. */
const tablesSnapshot = (
  id: string,
  prevId: string,
  tables: Readonly<Record<string, string>>,
  version = "7"
): string =>
  formatSnapshot({
    dialect: "postgresql",
    id,
    prevId,
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, type]) => [
        `public.${name}`,
        { columns: { id: { name: "id", type } }, name },
      ])
    ),
    version,
  });

const tablesOf = (root: string, path: string): Record<string, unknown> =>
  (JSON.parse(read(root, path)) as { tables: Record<string, unknown> }).tables;

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
    /** Full snapshot texts in place of the id-only ones; `more` adds a snapshot for 0003_more. */
    snapshots?: { b?: string; mine?: string; more?: string; theirs?: string };
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
      [`${META}/0001_snapshot.json`]:
        options.snapshots?.b ?? snapshotFile("B0", "A0"),
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
        : {
            [`${META}/0002_snapshot.json`]:
              options.snapshots?.mine ?? snapshotFile("M0", "B0"),
          }),
      ...(options.snapshots?.more === undefined
        ? {}
        : { [`${META}/0003_snapshot.json`]: options.snapshots.more }),
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
        : {
            [`${META}/0002_snapshot.json`]:
              options.snapshots?.theirs ?? snapshotFile("T0", "B0"),
          }),
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

  it("merges the base's table into the moved snapshot and gives it a new id", () => {
    const root = createRepository({
      snapshots: {
        b: tablesSnapshot("B0", "A0", { b: "int" }),
        mine: tablesSnapshot("M0", "B0", { b: "int", mine: "int" }),
        theirs: tablesSnapshot("T0", "B0", { b: "bigint", theirs: "int" }),
      },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([
      "db:renumber: staged 10 paths (base MERGE_HEAD)",
      "moved 0002_mine -> 0003_mine",
      "moved 0003_more -> 0004_more",
      `merged the base's schema changes into ${META}/0003_snapshot.json`,
      'check the old number: src/mine.test.ts:1: read("migrations/0003_mine.sql"); // migration 0002',
      "conflicts left: README.md",
      'Next: resolve any other conflicts, run `pnpm db:generate` (it must report "No schema changes"), `git commit` (or `git merge --continue`), then run the db tests.',
    ]);
    expect(read(root, `${META}/0002_snapshot.json`)).toBe(
      tablesSnapshot("T0", "B0", { b: "bigint", theirs: "int" })
    );
    const moved = JSON.parse(read(root, `${META}/0003_snapshot.json`)) as {
      id: string;
    };
    expect(moved.id).toMatch(/^[0-9a-f-]{36}$/u);
    // The base's altered column and new table, and the branch's table; the id is new.
    expect(moved).toEqual(
      JSON.parse(
        tablesSnapshot(moved.id, "T0", {
          b: "bigint",
          mine: "int",
          theirs: "int",
        })
      )
    );
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      formatSnapshot(moved)
    );
    expect(Object.keys(moved).slice(0, 2)).toEqual(["id", "prevId"]);

    put(root, { "README.md": "readme main 0003_mine\n" });
    git(root, "add", "README.md");
    expect(run(root).stdout).toEqual([
      "db:renumber: nothing to do; this branch's migrations already follow MERGE_HEAD.",
    ]);
    expect(git(root, "status", "--porcelain", "--", META)).not.toMatch(/^.M/mu);
  });

  it("merges the base's table into each of two branch snapshots and chains them", () => {
    const root = createRepository({
      snapshots: {
        b: tablesSnapshot("B0", "A0", { b: "int" }),
        mine: tablesSnapshot("M0", "B0", { b: "int", mine: "int" }),
        more: tablesSnapshot("R0", "M0", { mine: "int", more: "int" }),
        theirs: tablesSnapshot("T0", "B0", { b: "int", theirs: "int" }),
      },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `merged the base's schema changes into ${META}/0004_snapshot.json`
    );
    const moved = JSON.parse(read(root, `${META}/0003_snapshot.json`)) as {
      id: string;
    };
    const more = JSON.parse(read(root, `${META}/0004_snapshot.json`)) as {
      id: string;
      prevId: string;
    };
    expect(JSON.parse(read(root, `${META}/0003_snapshot.json`))).toMatchObject({
      prevId: "T0",
    });
    expect(more.prevId).toBe(moved.id);
    expect(new Set([moved.id, more.id, "M0", "R0"]).size).toBe(4);
    // 0003_more dropped table b; the base's table arrives in both snapshots.
    expect(Object.keys(tablesOf(root, `${META}/0003_snapshot.json`))).toEqual([
      "public.b",
      "public.mine",
      "public.theirs",
    ]);
    expect(Object.keys(tablesOf(root, `${META}/0004_snapshot.json`))).toEqual([
      "public.mine",
      "public.more",
      "public.theirs",
    ]);
  });

  it("exits 1 and names the key when both sides changed one snapshot value", () => {
    const root = createRepository({
      snapshots: {
        b: tablesSnapshot("B0", "A0", { b: "int" }),
        mine: tablesSnapshot("M0", "B0", { b: "text" }),
        theirs: tablesSnapshot("T0", "B0", { b: "bigint" }),
      },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      `check the snapshot: ${META}/0003_snapshot.json: tables > public.b > columns > id > type changed on both sides; kept this branch's value`,
      'db:renumber: correct the snapshots above by hand (CONVENTIONS.md, Migration numbers), then run pnpm db:generate; it must report "No schema changes".',
    ]);
    expect(result.stdout.at(-1)).toBe("conflicts left: README.md");
    // Nothing else to merge: the branch's text stays, with the new prevId.
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      tablesSnapshot("M0", "T0", { b: "text" })
    );
    // A second run finds the snapshots chained and does not repeat the lines.
    expect(run(root)).toEqual({
      code: 0,
      stderr: [],
      stdout: [
        "db:renumber: nothing to do; this branch's migrations already follow MERGE_HEAD.",
      ],
    });
  });

  it("names each later branch snapshot that was generated from a snapshot to correct", () => {
    const conflicting = createRepository({
      snapshots: {
        b: tablesSnapshot("B0", "A0", { b: "int" }),
        mine: tablesSnapshot("M0", "B0", { b: "text" }),
        more: tablesSnapshot("R0", "M0", { b: "text", more: "int" }),
        theirs: tablesSnapshot("T0", "B0", { b: "bigint" }),
      },
    });
    mergeMain(conflicting);
    expect(run(conflicting).stderr.slice(0, 2)).toEqual([
      `check the snapshot: ${META}/0003_snapshot.json: tables > public.b > columns > id > type changed on both sides; kept this branch's value`,
      `check the snapshot: ${META}/0004_snapshot.json: generated from ${META}/0003_snapshot.json; repeat the correction here`,
    ]);

    const missing = createRepository({
      snapshots: {
        mine: tablesSnapshot("M0", "GONE", { mine: "int" }),
        more: tablesSnapshot("R0", "M0", { mine: "int", more: "int" }),
        theirs: tablesSnapshot("T0", "B0", { theirs: "int" }),
      },
    });
    mergeMain(missing);
    expect(run(missing).stderr.slice(0, 2)).toEqual([
      `check the snapshot: ${META}/0003_snapshot.json: the snapshot with id GONE is not in this checkout; only prevId was updated`,
      `check the snapshot: ${META}/0004_snapshot.json: generated from ${META}/0003_snapshot.json; repeat the correction here`,
    ]);
  });

  it("exits 1 and only re-chains when the start snapshot is not in the checkout", () => {
    const root = createRepository({
      snapshots: {
        mine: tablesSnapshot("M0", "GONE", { mine: "int" }),
        theirs: tablesSnapshot("T0", "B0", { theirs: "int" }),
      },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe(
      `check the snapshot: ${META}/0003_snapshot.json: the snapshot with id GONE is not in this checkout; only prevId was updated`
    );
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      tablesSnapshot("M0", "T0", { mine: "int" })
    );
  });

  it("prints the snapshot check also when a migration file still conflicts", () => {
    const root = createRepository({
      conflictInB: true,
      snapshots: { mine: tablesSnapshot("M0", "GONE", { mine: "int" }) },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      `check the snapshot: ${META}/0003_snapshot.json: the snapshot with id GONE is not in this checkout; only prevId was updated`,
      "db:renumber: migration files that the base also changed still conflict; resolve them by hand, then run db:renumber again.",
    ]);
  });

  it("exits 1 and only re-chains when the snapshot version differs", () => {
    const root = createRepository({
      snapshots: {
        b: tablesSnapshot("B0", "A0", { b: "int" }),
        mine: tablesSnapshot("M0", "B0", { b: "int", mine: "int" }),
        theirs: tablesSnapshot("T0", "B0", { b: "int", theirs: "int" }, "8"),
      },
    });
    mergeMain(root);

    const result = run(root);

    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe(
      `check the snapshot: ${META}/0003_snapshot.json: version or dialect differs from the snapshot before it; only prevId was updated`
    );
    expect(read(root, `${META}/0003_snapshot.json`)).toBe(
      tablesSnapshot("M0", "T0", { b: "int", mine: "int" })
    );
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

  const sharedMessage = (ref: string): string =>
    `db:renumber: 0002_theirs already on ${ref}, so not this branch's own. Run db:renumber on the feature branch after \`git merge <base>\`; when ${ref} is the newer base, pass --base ${ref}.`;

  /** Runs db:renumber, expects exit 1 with `message`, and checks that it changed no file. */
  const expectRefusal = (root: string, argv: string[], message: string) => {
    const before =
      git(root, "status", "--porcelain=v1", "-uall") + git(root, "diff");
    expect(run(root, ...argv)).toEqual({
      code: 1,
      stdout: [],
      stderr: [message],
    });
    expect(
      git(root, "status", "--porcelain=v1", "-uall") + git(root, "diff")
    ).toBe(before);
  };

  it("refuses a --base older than the merged branch instead of renumbering the base's migrations", () => {
    const root = createRepository();
    mergeMain(root);
    expectRefusal(root, ["--base", "main~1"], sharedMessage("MERGE_HEAD"));
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
    expectRefusal(root, [], sharedMessage("main"));
  });

  it("refuses to renumber the base branch's own migrations when run on the base branch", () => {
    const root = createRepository();
    git(root, "update-ref", "refs/remotes/origin/main", "main");
    git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main"
    );
    git(root, "checkout", "-q", "main");
    expect(() => git(root, "merge", "-q", "--no-edit", "feature")).toThrow();
    expectRefusal(root, [], sharedMessage("origin/main"));
  });

  it("refuses to run during a rebase in that worktree only, where the conflict stages are swapped", () => {
    const root = createRepository();
    const linked = join(
      mkdtempSync(join(tmpdir(), "db-renumber-linked-")),
      "w"
    );
    directories.push(dirname(linked));
    git(root, "worktree", "add", "-q", "-b", "feature-2", linked, "feature");
    expect(() => git(linked, "rebase", "-q", "main")).toThrow();
    expect(unmergedPaths(linked)).toContain(JOURNAL);
    expectRefusal(
      linked,
      [],
      "db:renumber: a rebase is in progress. Run `git rebase --abort`, then `git merge <base>` and db:renumber."
    );
    // The main worktree is not rebasing: it gets past the rebase check.
    expect(run(root, "--base", "main").stderr).toEqual([
      "db:renumber: the base migrations 0002_theirs are not in this checkout; merge the base branch first",
    ]);
  });

  const sharedNumberMessage = `db:renumber: two of this branch's migrations share the number of ${META}/0002_snapshot.json; give one of them another number by hand first`;

  it.each([
    ["conflicts with the base's", {}],
    ["is the branch's only", { theirsSnapshot: false }],
  ])(
    "refuses two branch migrations with one number when the snapshot file %s",
    (_, options) => {
      const root = createRepository({ sharedNumber: true, ...options });
      mergeMain(root);
      expectRefusal(root, [], sharedNumberMessage);
    }
  );

  it("refuses two branch migrations with one number when only one of them moves", () => {
    // Against the first commit, 0002_mine keeps its number and only 0002_zz moves.
    const root = createRepository({ sharedNumber: true });
    expectRefusal(root, ["--base", "main~1"], sharedNumberMessage);
  });

  it.each([
    [
      "the base's",
      { mineSnapshot: false },
      [
        snapshotFile("A0", ZERO),
        snapshotFile("B0", "A0"),
        snapshotFile("T0", "B0"),
      ],
    ],
    [
      "missing",
      { mineSnapshot: false, theirsSnapshot: false },
      [snapshotFile("A0", ZERO), snapshotFile("B0", "A0")],
    ],
  ])(
    "renumbers two branch migrations with one number when the snapshot file is %s",
    (_, options, snapshots) => {
      const root = createRepository({ sharedNumber: true, ...options });
      mergeMain(root);
      const result = run(root);
      expect(result.code).toBe(0);
      expect(result.stdout.filter((line) => line.startsWith("moved"))).toEqual([
        "moved 0002_mine -> 0003_mine",
        "moved 0002_zz -> 0004_zz",
        "moved 0003_more -> 0005_more",
      ]);
      expect(
        readJournal(read(root, JOURNAL))?.entries.map((entry) => entry.tag)
      ).toEqual([
        "0000_a",
        "0001_b",
        "0002_theirs",
        "0003_mine",
        "0004_zz",
        "0005_more",
      ]);
      expect(
        ["0003_mine", "0004_zz", "0005_more"].map((tag) =>
          existsSync(join(root, `packages/db/migrations/${tag}.sql`))
        )
      ).toEqual([true, true, true]);
      expect(
        ["0000", "0001", "0002", "0003", "0004", "0005"]
          .map((number) => `${META}/${number}_snapshot.json`)
          .filter((path) => existsSync(join(root, path)))
          .map((path) => read(root, path))
      ).toEqual(snapshots);
      expect(unmergedPaths(root)).toEqual(["README.md"]);
    }
  );

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
