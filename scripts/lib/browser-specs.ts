import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// The browser lane (Playwright, serial) takes about 7 minutes. Many pull requests
// change only research, services, documentation or one spec file. The lane then
// runs the smoke spec plus the changed specs, not the full suite.
//
// The specs reach the app over HTTP and do not import its source, so import-graph
// tools (Playwright --only-changed, turbo affected) would select no spec for an
// app change. This selector uses an explicit list and fails open:
//
// - A changed path that the build, the app or the suite can read runs the full
//   suite. Every path outside the lists below counts as such a path.
// - A changed spec file (tests/e2e/<name>.spec.ts) runs that spec.
// - A path in NO_BROWSER_INPUT changes nothing that the lane builds or reads.
// - A git error runs the full suite.
//
// Push runs on the live line always run the full suite (the CI step runs this
// selector for pull requests only).

export const SMOKE_SPEC = "tests/e2e/smoke.spec.ts";

const SPEC = /^tests\/e2e\/[\w.-]+\.spec\.ts$/u;
const ROOT_DOCUMENT = /^[^/]+\.md$/u;

/**
 * Folders that the web build, the app at run time and the Playwright suite never
 * read. Verified 2026-10-31: no import or file read from apps/web/src,
 * packages/<name>/src, tests/e2e, playwright.config.ts or scripts/with-test-env.ts
 * reaches them. Some sources and migrations name services/ and docs/ paths as
 * data strings, but none reads those files.
 */
export const NO_BROWSER_INPUT = [
  ".agents/",
  ".claude/",
  ".vscode/",
  "docs/",
  "infra/",
  "research/",
  "services/",
  "tests/generator/",
  "tests/integration/",
] as const;

export type BrowserSelection = Readonly<
  | { mode: "full"; reason: string }
  | { mode: "subset"; specs: readonly string[] }
>;

/**
 * The specs to run for these changed paths. `exists` reports whether a spec
 * file is still in the checkout; a deleted spec has nothing to run.
 */
export const selectBrowserSpecs = (
  changedPaths: readonly string[],
  exists: (path: string) => boolean
): BrowserSelection => {
  // Without the smoke spec (deleted or renamed), a subset could be empty.
  if (!exists(SMOKE_SPEC)) {
    return Object.freeze({
      mode: "full",
      reason: `${SMOKE_SPEC} is missing`,
    });
  }
  const specs = new Set<string>([SMOKE_SPEC]);
  for (const path of changedPaths) {
    if (SPEC.test(path)) {
      if (exists(path)) specs.add(path);
    } else if (
      !(
        ROOT_DOCUMENT.test(path) ||
        path === "LICENSE" ||
        NO_BROWSER_INPUT.some((prefix) => path.startsWith(prefix))
      )
    ) {
      return Object.freeze({
        mode: "full",
        reason: `${path} can change the app or the browser suite`,
      });
    }
  }
  return Object.freeze({ mode: "subset", specs: Object.freeze([...specs]) });
};

export type GitResult = Readonly<{ status: number | null; stdout: string }>;

export type BrowserSpecsDependencies = Readonly<{
  git: (arguments_: readonly string[]) => GitResult;
  exists: (path: string) => boolean;
  output: (line: string) => void;
  error: (line: string) => void;
}>;

/**
 * CLI: `browser-specs <base> <head>`. Prints the spec paths for Playwright,
 * separated by spaces, or an empty line for the full suite. The reason goes to
 * stderr. Returns 2 for a usage error, else 0.
 */
export const runBrowserSpecs = (
  arguments_: readonly string[],
  dependencies: BrowserSpecsDependencies
): number => {
  const [base, head] = arguments_;
  if (arguments_.length !== 2 || !base || !head) {
    dependencies.error("usage: browser-specs <base-revision> <head-revision>");
    return 2;
  }
  const diff = dependencies.git([
    "diff",
    "--name-only",
    "--no-renames",
    base,
    head,
  ]);
  const selection: BrowserSelection =
    diff.status === 0
      ? selectBrowserSpecs(
          diff.stdout.split("\n").filter((line) => line !== ""),
          dependencies.exists
        )
      : {
          mode: "full",
          reason: `git diff ${base} ${head} failed (status ${diff.status})`,
        };
  if (selection.mode === "full") {
    dependencies.error(`Browser lane: full suite. ${selection.reason}.`);
    dependencies.output("");
  } else {
    dependencies.error(
      `Browser lane: ${selection.specs.length} spec(s); no other changed path is a browser input.`
    );
    dependencies.output(selection.specs.join(" "));
  }
  return 0;
};

/** Real git and file system, run from the current directory. */
export const systemBrowserSpecsDependencies: BrowserSpecsDependencies =
  Object.freeze({
    error: (line: string) => process.stderr.write(`${line}\n`),
    exists: (path: string) => existsSync(path),
    git: (arguments_: readonly string[]) => {
      const result = spawnSync("git", [...arguments_], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      return { status: result.status, stdout: result.stdout };
    },
    output: (line: string) => process.stdout.write(`${line}\n`),
  });
