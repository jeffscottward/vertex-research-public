// What: `pnpm db:renumber` moves this branch's new Drizzle migrations behind the base branch's
// migrations after `git merge <base>`: next free numbers, strictly newer `when`, renamed SQL,
// snapshot and rollback files, rewritten tag references, re-chained snapshot prevIds, all staged.
// Two branches that each add migration NNNN conflict in meta/_journal.json and meta/NNNN_snapshot.json;
// this resolves both (card vertex-migration-number-race, 2026-11-09).
// Used by: scripts/db-renumber.ts.
// See: CONVENTIONS.md (Migration numbers); packages/db/src/server/migration-journal.test.ts.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import { withoutGitRepositoryEnvironment } from "../lib/git-env.ts";
import { required } from "../lib/required.ts";

const MIGRATIONS = "packages/db/migrations";
export const JOURNAL = `${MIGRATIONS}/meta/_journal.json`;
const ROLLBACKS = "packages/db/rollback";
const TAG = /^\d{4}_[a-z0-9_]+$/u;
const SNAPSHOT = /^\d{4}_snapshot\.json$/u;
const PREV_ID = /"prevId": "[^"]*"/u;

const USAGE = `Usage: pnpm db:renumber [--base <ref>]

Run it after \`git merge <base>\` when both sides added migrations. It keeps the base's migrations
as they are, moves this branch's new ones behind them and stages the result.
--base defaults to MERGE_HEAD during a merge, else to origin/HEAD.`;

const EntrySchema = z.strictObject({
  idx: z.number().int().nonnegative(),
  version: z.string(),
  when: z.number().int(),
  tag: z.string().regex(TAG),
  breakpoints: z.boolean(),
});
const JournalSchema = z.strictObject({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(EntrySchema),
});
const SnapshotSchema = z.object({ id: z.string(), prevId: z.string() });

export type Journal = z.infer<typeof JournalSchema>;
export type Move = Readonly<{ from: string; to: string }>;
export type RenumberPlan = Readonly<{
  journal: Journal;
  moves: readonly Move[];
}>;
export type RenumberIo = Readonly<{
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}>;
type GitResult = Readonly<{ ok: boolean; stdout: string; stderr: string }>;
type Git = Readonly<{
  run: (args: readonly string[]) => GitResult;
  output: (args: readonly string[]) => string;
}>;

export class RenumberError extends Error {
  override readonly name = "RenumberError";
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Parses a Drizzle journal; `undefined` when the text is not one. */
export const readJournal = (text: string): Journal | undefined =>
  JournalSchema.safeParse(parseJson(text)).data;

/**
 * Keeps the base journal as a prefix and appends every migration file the base does not know,
 * in their current order, renumbered from the base's length. `when` is the branch's own value
 * when it is already newer than the previous entry, otherwise the previous entry's plus one:
 * Drizzle skips an entry whose `when` is not newer than the last applied one.
 */
export const planRenumber = (
  input: Readonly<{
    base: Journal;
    ours: Journal | undefined;
    sqlTags: readonly string[];
  }>
): RenumberPlan => {
  const files = new Set(input.sqlTags);
  const missing = input.base.entries.filter((entry) => !files.has(entry.tag));
  if (missing.length > 0) {
    throw new RenumberError(
      `the base migrations ${missing.map((entry) => entry.tag).join(", ")} are not in this checkout; merge the base branch first`
    );
  }
  const baseTags = new Set(input.base.entries.map((entry) => entry.tag));
  const own = input.sqlTags
    .filter((tag) => !baseTags.has(tag))
    .sort(
      (left, right) =>
        Number(left.slice(0, 4)) - Number(right.slice(0, 4)) ||
        left.localeCompare(right)
    );
  const invalid = own.filter((tag) => !TAG.test(tag));
  if (invalid.length > 0) {
    throw new RenumberError(
      `migration file names must be NNNN_snake_case.sql: ${invalid.map((tag) => `${tag}.sql`).join(", ")}`
    );
  }
  const ours = new Map(input.ours?.entries.map((entry) => [entry.tag, entry]));
  let when = input.base.entries.at(-1)?.when ?? 0;
  const appended = own.map((from, offset) => {
    const idx = input.base.entries.length + offset;
    const previous = ours.get(from);
    when = Math.max(previous?.when ?? 0, when + 1);
    const entry = {
      idx,
      version: previous?.version ?? input.base.version,
      when,
      tag: `${String(idx).padStart(4, "0")}${from.slice(4)}`,
      breakpoints: previous?.breakpoints ?? true,
    };
    return { from, entry };
  });
  return {
    journal: {
      ...input.base,
      entries: [...input.base.entries, ...appended.map(({ entry }) => entry)],
    },
    moves: appended
      .filter(({ from, entry }) => from !== entry.tag)
      .map(({ from, entry }) => ({ from, to: entry.tag })),
  };
};

const lines = (text: string): string[] => text.split("\n").filter(Boolean);

const createGit = (root: string): Git => {
  const run = (args: readonly string[]): GitResult => {
    // Git hooks export GIT_DIR/GIT_INDEX_FILE; the repository comes from `root` only.
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: withoutGitRepositoryEnvironment(process.env),
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return {
    run,
    output: (args) => {
      const result = run(args);
      if (!result.ok) {
        throw new RenumberError(
          `git ${args.join(" ")} failed: ${result.stderr.trim()}`
        );
      }
      return result.stdout;
    },
  };
};

type Workspace = Readonly<{
  git: Git;
  base: string;
  baseFiles: ReadonlySet<string>;
  unmerged: ReadonlySet<string>;
  absolute: (path: string) => string;
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  stage: (number: 2 | 3, path: string) => string;
  touched: Set<string>;
}>;

const openWorkspace = (git: Git, root: string, base: string): Workspace => {
  const absolute = (path: string): string => join(root, path);
  return {
    git,
    base,
    baseFiles: new Set(
      lines(
        git.output([
          "ls-tree",
          "-r",
          "--name-only",
          base,
          "--",
          `${MIGRATIONS}/meta`,
          ROLLBACKS,
        ])
      )
    ),
    unmerged: new Set(
      lines(git.output(["diff", "--name-only", "--diff-filter=U"]))
    ),
    absolute,
    read: (path) =>
      existsSync(absolute(path))
        ? readFileSync(absolute(path), "utf8")
        : undefined,
    write: (path, text) => {
      writeFileSync(absolute(path), text);
    },
    stage: (number, path) => git.output(["show", `:${number}:${path}`]),
    touched: new Set<string>(),
  };
};

/** Step 1: tag references in tracked files (tests, docs, the branch's own SQL and rollback files). */
const rewriteReferences = (
  workspace: Workspace,
  moves: readonly Move[]
): void => {
  const targets = new Map(moves.map((move) => [move.from, move.to]));
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])(${moves.map((move) => move.from).join("|")})(?![A-Za-z0-9_])`,
    "gu"
  );
  // Without moves `git grep` gets no pattern, fails and lists nothing.
  const listed = workspace.git.run([
    "grep",
    "-l",
    "-I",
    "-F",
    ...moves.flatMap((move) => ["-e", move.from]),
  ]).stdout;
  for (const path of new Set(lines(listed))) {
    const text = readFileSync(workspace.absolute(path), "utf8");
    const next = text.replace(pattern, (tag) =>
      required(targets.get(tag), `new tag for ${tag}`)
    );
    if (path !== JOURNAL && next !== text) {
      workspace.write(path, next);
      // A file that still conflicts gets the new tags but stays unresolved for its owner.
      if (!workspace.unmerged.has(path)) {
        workspace.touched.add(path);
      }
    }
  }
};

/**
 * Step 2: the branch's files move to the new number. When the base added a file under the same path
 * (add/add conflict), the path keeps the base's version and the branch's version moves.
 */
const moveOwnedFiles = (workspace: Workspace, moves: readonly Move[]): void => {
  const moving = moves.flatMap((move) => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      [`${MIGRATIONS}/${move.from}.sql`, `${MIGRATIONS}/${move.to}.sql`],
      [
        `${ROLLBACKS}/${move.from}.down.sql`,
        `${ROLLBACKS}/${move.to}.down.sql`,
      ],
      [
        `${MIGRATIONS}/meta/${move.from.slice(0, 4)}_snapshot.json`,
        `${MIGRATIONS}/meta/${move.to.slice(0, 4)}_snapshot.json`,
      ],
    ];
    return pairs.flatMap(([from, to]) => {
      const conflicted = workspace.unmerged.has(from);
      const text = conflicted
        ? workspace.stage(2, from)
        : workspace.baseFiles.has(from)
          ? undefined
          : workspace.read(from);
      return text === undefined ? [] : [{ from, to, conflicted, text }];
    });
  });
  for (const file of moving) {
    if (file.conflicted) {
      workspace.write(file.from, workspace.stage(3, file.from));
    } else {
      rmSync(workspace.absolute(file.from));
    }
    workspace.touched.add(file.from);
  }
  for (const file of moving) {
    workspace.write(file.to, file.text);
    workspace.touched.add(file.to);
  }
};

/** Step 3: each of the branch's snapshots points at the snapshot before it (drizzle-kit reads this chain). */
const rechainSnapshots = (workspace: Workspace): void => {
  const snapshots = readdirSync(workspace.absolute(`${MIGRATIONS}/meta`))
    .filter((name) => SNAPSHOT.test(name))
    .sort()
    .map((name) => `${MIGRATIONS}/meta/${name}`);
  const ids = snapshots.map((path) => {
    const snapshot = SnapshotSchema.safeParse(
      parseJson(readFileSync(workspace.absolute(path), "utf8"))
    );
    if (!snapshot.success) {
      throw new RenumberError(`${path} has no id/prevId`);
    }
    return snapshot.data;
  });
  snapshots.slice(1).forEach((path, offset) => {
    const previous = required(ids[offset], "previous snapshot").id;
    if (
      !workspace.baseFiles.has(path) &&
      required(ids[offset + 1], "snapshot").prevId !== previous
    ) {
      const text = readFileSync(workspace.absolute(path), "utf8");
      workspace.write(path, text.replace(PREV_ID, `"prevId": "${previous}"`));
      workspace.touched.add(path);
    }
  });
};

/** Prints what changed, lines that still name an old number, and conflicts left; returns the exit code. */
const report = (
  workspace: Workspace,
  moves: readonly Move[],
  io: RenumberIo
): number => {
  io.stdout(
    `db:renumber: staged ${workspace.touched.size} paths (base ${workspace.base})`
  );
  const oldNumbers = new RegExp(
    `\\b(${moves.map((move) => move.from.slice(0, 4)).join("|")})\\b`,
    "u"
  );
  for (const move of moves) {
    io.stdout(`moved ${move.from} -> ${move.to}`);
  }
  for (const path of moves.length === 0 ? [] : [...workspace.touched].sort()) {
    const text = path.endsWith("_snapshot.json")
      ? undefined
      : workspace.read(path);
    text?.split("\n").forEach((line, index) => {
      if (oldNumbers.test(line)) {
        io.stdout(
          `check the old number: ${path}:${index + 1}: ${line.trim().slice(0, 160)}`
        );
      }
    });
  }
  const left = lines(
    workspace.git.output(["diff", "--name-only", "--diff-filter=U"])
  );
  if (left.length > 0) {
    io.stdout(`conflicts left: ${left.join(", ")}`);
  }
  if (
    left.some(
      (path) =>
        path.startsWith(`${MIGRATIONS}/`) || path.startsWith(`${ROLLBACKS}/`)
    )
  ) {
    io.stderr(
      "db:renumber: migration files that the base also changed still conflict; resolve them by hand, then run db:renumber again."
    );
    return 1;
  }
  io.stdout(
    "Next: resolve any other conflicts, `git commit` (or `git merge --continue`), then run the db tests."
  );
  return 0;
};

const renumber = (
  git: Git,
  root: string,
  base: string,
  io: RenumberIo
): number => {
  const baseJournal = readJournal(git.output(["show", `${base}:${JOURNAL}`]));
  if (!baseJournal) {
    throw new RenumberError(`${base}:${JOURNAL} is not a Drizzle journal`);
  }
  const workspace = openWorkspace(git, root, base);
  const oursText = workspace.unmerged.has(JOURNAL)
    ? workspace.stage(2, JOURNAL)
    : workspace.read(JOURNAL);
  const plan = planRenumber({
    base: baseJournal,
    ours: readJournal(oursText ?? ""),
    sqlTags: readdirSync(workspace.absolute(MIGRATIONS))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -".sql".length)),
  });
  rewriteReferences(workspace, plan.moves);
  moveOwnedFiles(workspace, plan.moves);
  rechainSnapshots(workspace);
  // Step 4: the journal is the base's entries, then this branch's.
  const journal = `${JSON.stringify(plan.journal, null, 2)}\n`;
  if (workspace.unmerged.has(JOURNAL) || workspace.read(JOURNAL) !== journal) {
    workspace.write(JOURNAL, journal);
    workspace.touched.add(JOURNAL);
  }
  if (workspace.touched.size === 0) {
    io.stdout(
      `db:renumber: nothing to do; this branch's migrations already follow ${base}.`
    );
    return 0;
  }
  git.output(["add", "-A", "--", ...workspace.touched]);
  return report(workspace, plan.moves, io);
};

export const runRenumber = (
  argv: readonly string[],
  io: RenumberIo
): number => {
  try {
    let options: { base?: string | undefined; help?: boolean | undefined };
    try {
      options = parseArgs({
        args: [...argv],
        options: {
          base: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        strict: true,
        allowPositionals: false,
      }).values;
    } catch (error) {
      throw new RenumberError(`${(error as Error).message}\n${USAGE}`);
    }
    if (options.help === true) {
      io.stdout(USAGE);
      return 0;
    }
    const root = createGit(io.cwd)
      .output(["rev-parse", "--show-toplevel"])
      .trim();
    const git = createGit(root);
    return renumber(git, root, options.base ?? defaultBase(git), io);
  } catch (error) {
    if (error instanceof RenumberError) {
      io.stderr(`db:renumber: ${error.message}`);
      return 1;
    }
    throw error;
  }
};

const defaultBase = (git: Git): string => {
  if (git.run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    return "MERGE_HEAD";
  }
  const origin = git.run(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (!origin.ok) {
    throw new RenumberError(
      "no merge in progress and no origin/HEAD; pass --base <ref>"
    );
  }
  return origin.stdout.trim();
};
