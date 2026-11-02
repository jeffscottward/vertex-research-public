import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserSpecsDependencies,
  NO_BROWSER_INPUT,
  runBrowserSpecs,
  SMOKE_SPEC,
  selectBrowserSpecs,
  systemBrowserSpecsDependencies,
} from "./browser-specs.ts";

const always = (): boolean => true;

describe("selectBrowserSpecs", () => {
  it("runs only the smoke spec when nothing changed", () => {
    expect(selectBrowserSpecs([], always)).toEqual({
      mode: "subset",
      specs: [SMOKE_SPEC],
    });
  });

  it("runs only the smoke spec for paths the lane never reads", () => {
    const paths = [
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      ...NO_BROWSER_INPUT.map((prefix) => `${prefix}nested/file.ts`),
    ];
    expect(selectBrowserSpecs(paths, always)).toEqual({
      mode: "subset",
      specs: [SMOKE_SPEC],
    });
  });

  it("adds each changed spec once and skips deleted specs", () => {
    const exists = (path: string): boolean => path !== "tests/e2e/gone.spec.ts";
    expect(
      selectBrowserSpecs(
        [
          "research/macro/notes.md",
          "tests/e2e/todos.spec.ts",
          "tests/e2e/public-accessibility.a11y.spec.ts",
          "tests/e2e/todos.spec.ts",
          "tests/e2e/gone.spec.ts",
          SMOKE_SPEC,
        ],
        exists
      )
    ).toEqual({
      mode: "subset",
      specs: [
        SMOKE_SPEC,
        "tests/e2e/todos.spec.ts",
        "tests/e2e/public-accessibility.a11y.spec.ts",
      ],
    });
  });

  // Fail open: every path outside the lists can change the app or the suite.
  it.each([
    "apps/web/src/app/layout.tsx",
    "apps/operator/package.json",
    "packages/db/migrations/0033_x.sql",
    "design-system/darkfactory/tokens.json",
    "tests/e2e/fixtures.ts",
    "tests/e2e/helpers/database.ts",
    "tests/e2e/global-setup.ts",
    "tests/e2e/nested/x.spec.ts",
    "tests/fixtures/next-navigation.ts",
    "playwright.config.ts",
    "pnpm-lock.yaml",
    "package.json",
    ".github/workflows/ci.yml",
    "scripts/with-test-env.ts",
    "scripts/ci/browser-lane.sh",
    "apps/web/README.md",
    "documents/x.ts",
  ])("runs the full suite when %s changes", (path) => {
    expect(
      selectBrowserSpecs(["docs/a.md", "tests/e2e/todos.spec.ts", path], always)
    ).toEqual({
      mode: "full",
      reason: `${path} can change the app or the browser suite`,
    });
  });

  it("runs the full suite when the smoke spec is missing", () => {
    expect(
      selectBrowserSpecs([SMOKE_SPEC], (path) => path !== SMOKE_SPEC)
    ).toEqual({ mode: "full", reason: `${SMOKE_SPEC} is missing` });
  });

  it("names a smoke spec that exists", () => {
    expect(existsSync(SMOKE_SPEC)).toBe(true);
  });
});

const fakeDependencies = (
  status: number | null,
  stdout: string
): BrowserSpecsDependencies & {
  lines: string[];
  errors: string[];
} => {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    error: (line) => errors.push(line),
    errors,
    exists: always,
    git: vi.fn(() => ({ status, stdout })),
    lines,
    output: (line) => lines.push(line),
  };
};

describe("runBrowserSpecs", () => {
  it.each([
    [[]],
    [["base"]],
    [["base", ""]],
    [["", "head"]],
    [["base", "head", "extra"]],
  ])("rejects the arguments %j", (arguments_) => {
    const dependencies = fakeDependencies(0, "");
    expect(runBrowserSpecs(arguments_, dependencies)).toBe(2);
    expect(dependencies.git).not.toHaveBeenCalled();
    expect(dependencies.lines).toEqual([]);
    expect(dependencies.errors).toEqual([
      "usage: browser-specs <base-revision> <head-revision>",
    ]);
  });

  it("prints the selected specs for a subset", () => {
    const dependencies = fakeDependencies(
      0,
      "research/a.py\ntests/e2e/todos.spec.ts\n"
    );
    expect(runBrowserSpecs(["HEAD^1", "HEAD"], dependencies)).toBe(0);
    expect(dependencies.git).toHaveBeenCalledWith([
      "diff",
      "--name-only",
      "--no-renames",
      "HEAD^1",
      "HEAD",
    ]);
    expect(dependencies.lines).toEqual([
      `${SMOKE_SPEC} tests/e2e/todos.spec.ts`,
    ]);
    expect(dependencies.errors).toEqual([
      "Browser lane: 2 spec(s); no other changed path is a browser input.",
    ]);
  });

  it("prints an empty line for the full suite", () => {
    const dependencies = fakeDependencies(0, "apps/web/src/proxy.ts\n");
    expect(runBrowserSpecs(["base", "head"], dependencies)).toBe(0);
    expect(dependencies.lines).toEqual([""]);
    expect(dependencies.errors).toEqual([
      "Browser lane: full suite. apps/web/src/proxy.ts can change the app or the browser suite.",
    ]);
  });

  it.each([128, null])(
    "runs the full suite when git fails (status %s)",
    (status) => {
      const dependencies = fakeDependencies(status, "docs/a.md\n");
      expect(runBrowserSpecs(["base", "head"], dependencies)).toBe(0);
      expect(dependencies.lines).toEqual([""]);
      expect(dependencies.errors).toEqual([
        `Browser lane: full suite. git diff base head failed (status ${status}).`,
      ]);
    }
  );
});

describe("systemBrowserSpecsDependencies", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  it("reads the changed paths from git and the file system", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browser-specs-test-"));
    directories.push(directory);
    const git = (...arguments_: string[]): string =>
      execFileSync("git", arguments_, { cwd: directory, encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(directory, "README.md"), "a\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    await writeFile(join(directory, "README.md"), "b\n");
    git("commit", "--quiet", "-am", "head");

    const { exists, git: runGit } = systemBrowserSpecsDependencies;
    expect(
      runGit(["-C", directory, "diff", "--name-only", "HEAD^1", "HEAD"])
    ).toEqual({ status: 0, stdout: "README.md\n" });
    expect(
      runGit(["-C", directory, "diff", "missing-base", "HEAD"]).status
    ).not.toBe(0);
    expect(exists(join(directory, "README.md"))).toBe(true);
    expect(exists(join(directory, SMOKE_SPEC))).toBe(false);
  });

  it("writes output to stdout and reasons to stderr", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    systemBrowserSpecsDependencies.output("a b");
    systemBrowserSpecsDependencies.error("why");
    expect(stdout).toHaveBeenCalledWith("a b\n");
    expect(stderr).toHaveBeenCalledWith("why\n");
  });
});
