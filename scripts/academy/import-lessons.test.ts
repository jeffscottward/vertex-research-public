import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AcademyCourseImportInput,
  type AcademyCourseImportResult,
  InvalidRepositoryInputError,
} from "@darkfactory/db/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { knowledgeBaseDir } from "./build-sources.ts";
import {
  ACADEMY_IMPORT_USAGE,
  type AcademyContentStore,
  type AcademyImportIo,
  checkCourseContent,
  importAcademyCourses,
  openAcademyContentStore,
  runAcademyImport,
} from "./import-lessons.ts";
import {
  type CourseContent,
  DATABASE_COURSE_CONTENT,
} from "./lessons/index.ts";
import type * as SpecChecks from "./spec-checks.ts";

// Draw faults keyed by lesson slug: authored specs never fail to draw, so tests inject them here.
const faults = vi.hoisted(() => new Set<string>());

vi.mock("./spec-checks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SpecChecks>();
  return {
    sceneErrors: (...args: Parameters<typeof SpecChecks.sceneErrors>) =>
      faults.has(args[0])
        ? [`${args[0]}: scene failed: boom`]
        : actual.sceneErrors(...args),
  };
});

type Spec = Readonly<
  Record<string, unknown> & { slug: string; sourceId: string }
>;
type Source = Readonly<Record<string, unknown> & { sourceId: string }>;

const QFTG = DATABASE_COURSE_CONTENT.quantfinancetogo as CourseContent;
const ALL_SPECS = QFTG.specs as readonly Spec[];
const ALL_SOURCES = QFTG.sources as readonly Source[];
// A small course: the first two lessons and their sources.
const SPECS = ALL_SPECS.slice(0, 2);
const SOURCES = SPECS.map(
  (spec) =>
    ALL_SOURCES.find((source) => source.sourceId === spec.sourceId) as Source
);
const SMALL: Readonly<Partial<Record<"quantfinancetogo", CourseContent>>> = {
  quantfinancetogo: { specs: SPECS, sources: SOURCES },
};
const [FIRST] = SPECS as [Spec, Spec];

const RESULT = (course: string): AcademyCourseImportResult => ({
  course,
  sources: { created: 2, updated: 0, unchanged: 0, deleted: 0 },
  specs: { created: 1, updated: 1, unchanged: 0, deleted: 1 },
});

let stdout: string[];
let stderr: string[];
let home: string;
let opened: string[];
let imported: AcademyCourseImportInput[];
let closed: number;
let importError: unknown;

const io = (env: NodeJS.ProcessEnv = {}): AcademyImportIo => ({
  env,
  stdout: { write: (text: string) => stdout.push(text) > 0 },
  stderr: { write: (text: string) => stderr.push(text) > 0 },
});
const DATABASE = { DATABASE_URL: "postgres://academy.test/vertex" };

const openStore = (databaseUrl: string): AcademyContentStore => {
  opened.push(databaseUrl);
  return {
    close: async () => {
      closed += 1;
    },
    importCourse: async (input) => {
      imported.push(input);
      if (importError !== undefined) throw importError;
      return RESULT(input.course);
    },
  };
};
const run = (
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  content: Readonly<Partial<Record<"quantfinancetogo", CourseContent>>> = SMALL
) => runAcademyImport(args, io(env), { content, home, openStore });

const reelNote = (postId: string) =>
  [
    "---",
    `post_id: "${postId}"`,
    `url: https://www.instagram.com/reel/${postId}/`,
    "published: 2026-10-31",
    "duration: 60",
    "---",
    "",
    "## Transcript",
    "",
    "- [00:00] Part one",
    "",
  ].join("\n");

beforeEach(() => {
  stdout = [];
  stderr = [];
  opened = [];
  imported = [];
  closed = 0;
  importError = undefined;
  home = mkdtempSync(join(tmpdir(), "academy-import-"));
});

afterEach(() => {
  faults.clear();
  rmSync(home, { recursive: true, force: true });
});

describe("runAcademyImport", () => {
  it("prints the usage on --help or -h", async () => {
    for (const flag of ["--help", "-h"]) {
      stdout = [];
      expect(await run([flag])).toBe(0);
      expect(stdout).toEqual([`${ACADEMY_IMPORT_USAGE}\n`]);
    }
    expect(ACADEMY_IMPORT_USAGE).toContain(
      "Database courses: quantfinancetogo."
    );
  });

  it("validates the committed course on --dry-run without a database", async () => {
    expect(await runAcademyImport(["--dry-run"], io(), { home })).toBe(0);
    expect(stdout).toEqual([
      `quantfinancetogo: valid, would store ${ALL_SOURCES.length} sources and ${ALL_SPECS.length} lessons\n`,
    ]);
    stdout = [];
    expect(
      await run(["--dry-run", "--prune", "--course", "quantfinancetogo"])
    ).toBe(0);
    expect(stdout).toEqual([
      "quantfinancetogo: valid, would store 2 sources and 2 lessons and prune the rest\n",
    ]);
    expect(opened).toEqual([]);
  }, 30_000);

  it("imports every database course in its own call and closes the store", async () => {
    expect(await run([], DATABASE)).toBe(0);
    expect(opened).toEqual([DATABASE.DATABASE_URL]);
    expect(imported).toEqual([
      {
        course: "quantfinancetogo",
        specs: SPECS,
        sources: SOURCES,
        prune: false,
      },
    ]);
    expect(stdout).toEqual([
      "quantfinancetogo: 2 sources (2 created, 0 updated, 0 unchanged, 0 deleted); 2 lessons (1 created, 1 updated, 0 unchanged, 1 deleted)\n",
    ]);
    expect(closed).toBe(1);
    imported = [];
    expect(
      await run(["--course", "quantfinancetogo", "--prune"], DATABASE)
    ).toBe(0);
    expect(imported[0]?.prune).toBe(true);
  });

  it("reads the sources from a knowledge-base folder with --kb", async () => {
    const kb = join(home, "notes");
    mkdirSync(kb);
    writeFileSync(join(kb, "ig-DKbNote0001.md"), reelNote("DKbNote0001"));
    const sourcesOnly = { quantfinancetogo: { specs: [], sources: SOURCES } };
    expect(
      await run(
        ["--course", "quantfinancetogo", "--kb", kb],
        DATABASE,
        sourcesOnly
      )
    ).toBe(0);
    expect(imported[0]?.sources).toEqual([
      expect.objectContaining({
        course: "quantfinancetogo",
        sourceId: "DKbNote0001",
        transcript: [{ start: 0, text: "Part one" }],
      }),
    ]);

    // "default": the course's folder in ~/Github/knowledge-bases.
    const defaultKb = knowledgeBaseDir("quantfinancetogo", home);
    mkdirSync(defaultKb, { recursive: true });
    writeFileSync(
      join(defaultKb, "ig-DKbDefault1.md"),
      reelNote("DKbDefault1")
    );
    expect(
      await run(
        ["--dry-run", "--kb", "default", "--course", "quantfinancetogo"],
        {},
        sourcesOnly
      )
    ).toBe(0);
    expect(stdout.at(-1)).toBe(
      "quantfinancetogo: valid, would store 1 sources and 0 lessons\n"
    );
  });

  it.each([
    [["--bogus"], "unknown argument --bogus"],
    [["--course"], "--course needs a value"],
    [["--course", "--prune"], "--course needs a value"],
    [["--course", "nope"], 'unknown course "nope"'],
    [
      ["--course", "dyr"],
      "course dyr is stored in @darkfactory/academy, not in Postgres",
    ],
    [["--kb", "default"], "--kb needs --course"],
  ])("rejects %j with exit 2 and the usage", async (args, message) => {
    expect(await run(args, DATABASE)).toBe(2);
    expect(stderr).toEqual([`${message}\n${ACADEMY_IMPORT_USAGE}\n`]);
    expect(opened).toEqual([]);
  });

  it("needs DATABASE_URL unless --dry-run", async () => {
    for (const env of [{}, { DATABASE_URL: "  " }]) {
      stderr = [];
      expect(await run([], env)).toBe(2);
      expect(stderr[0]).toContain(
        "DATABASE_URL is required (or pass --dry-run)"
      );
    }
    expect(opened).toEqual([]);
  });

  it("names a database course without import input", async () => {
    expect(await run(["--dry-run"], {}, {})).toBe(2);
    expect(stderr[0]).toContain(
      "course quantfinancetogo has no import input (scripts/academy/lessons/index.ts)"
    );
  });

  it("refuses invalid content before opening the database", async () => {
    const invalid = {
      quantfinancetogo: {
        specs: [{ ...FIRST, kind: "nope" }],
        sources: SOURCES,
      },
    };
    expect(await run([], DATABASE, invalid)).toBe(2);
    expect(stderr[0]).toContain("academy quantfinancetogo import is invalid");
    stderr = [];
    faults.add(FIRST.slug);
    expect(await run([], DATABASE)).toBe(2);
    expect(stderr).toEqual([
      `Invalid repository input: academy quantfinancetogo lessons do not draw:\n${FIRST.slug}: scene failed: boom\n`,
    ]);
    expect(opened).toEqual([]);
  });

  it("exits 2 on a constraint failure and 1 on any other import failure, closing the store", async () => {
    importError = new InvalidRepositoryInputError("academy content fails x");
    expect(await run([], DATABASE)).toBe(2);
    expect(stderr).toEqual([
      "Invalid repository input: academy content fails x\n",
    ]);
    importError = new Error("connection refused");
    expect(await run([], DATABASE)).toBe(1);
    expect(stderr.at(-1)).toBe("academy import failed: connection refused\n");
    importError = "plain failure";
    expect(await run([], DATABASE)).toBe(1);
    expect(stderr.at(-1)).toBe("academy import failed: plain failure\n");
    expect(closed).toBe(3);
  });
});

describe("importAcademyCourses", () => {
  it("checks, then imports every database course through the repository", async () => {
    const repository = {
      importCourse: async (input: AcademyCourseImportInput) => {
        imported.push(input);
        return RESULT(input.course);
      },
    };
    await expect(
      importAcademyCourses(repository, { content: SMALL })
    ).resolves.toEqual([RESULT("quantfinancetogo")]);
    expect(imported).toEqual([
      {
        course: "quantfinancetogo",
        specs: SPECS,
        sources: SOURCES,
        prune: false,
      },
    ]);
    await importAcademyCourses(repository, {
      content: SMALL,
      courses: ["quantfinancetogo"],
      prune: true,
    });
    expect(imported[1]?.prune).toBe(true);
    await expect(
      importAcademyCourses(repository, { courses: [] })
    ).resolves.toEqual([]);
  });

  it("imports nothing when a course fails its checks", async () => {
    faults.add(FIRST.slug);
    const importCourse = vi.fn();
    await expect(
      importAcademyCourses({ importCourse }, { content: SMALL })
    ).rejects.toThrow(InvalidRepositoryInputError);
    expect(importCourse).not.toHaveBeenCalled();
  });
});

describe("checkCourseContent", () => {
  it("returns the validated rows", async () => {
    const parsed = await checkCourseContent(
      "quantfinancetogo",
      SMALL.quantfinancetogo as CourseContent
    );
    expect(parsed.specs.map((row) => row.slug)).toEqual(
      SPECS.map((spec) => spec.slug)
    );
  });
});

describe("openAcademyContentStore", () => {
  it("opens a lazy Postgres store and closes it without connecting", async () => {
    const store = openAcademyContentStore(
      "postgres://user:pass@127.0.0.1:1/none"
    );
    expect(typeof store.importCourse).toBe("function");
    await expect(store.close()).resolves.toBeUndefined();
  });
});
