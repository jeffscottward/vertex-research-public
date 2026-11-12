import { describe, expect, it } from "vitest";

import {
  type CoverageSplitProofDependencies,
  runCoverageSplitProof,
} from "./coverage-split-proof.ts";
import { required } from "./required.ts";

type Counts = readonly [covered: number, total: number];
type Files = Readonly<Record<string, string>>;

const counts = ([covered, total]: Counts, pct: number) => ({
  total,
  covered,
  skipped: 0,
  pct,
});

/** One file of a json-summary report: lines, branches, functions, statements. */
const coverage = (
  lines: Counts,
  branches: Counts,
  functions: Counts,
  statements: Counts,
  pct: readonly [number, number, number, number]
) => ({
  lines: counts(lines, pct[0]),
  branches: counts(branches, pct[1]),
  functions: counts(functions, pct[2]),
  statements: counts(statements, pct[3]),
});

const ORIGINAL = `
import { pair, register } from "./deps.ts";
import "./side-effect.ts";

/** Doubles. */
const helper = (value: number): number => value * 2;

export interface Shape {
  readonly side: number;
}

// A comment is not a token.
export function area(shape: Shape): number {
  return helper(shape.side) ** 2;
}

export const View = () => <b>{area({ side: 1 })}</b>;
export const [, second] = pair;
export const { first, nested: { deep } } = { first: 1, nested: { deep: 2 } };
const local = 1;
export { local as alias };
register(helper);
export { other as renamed } from "./other.ts";
export * from "./third.ts";
export * as space from "./space.ts";
export default class Thing {}
`;

const SPLIT_ORIGIN = `
import { pair, register } from "./deps.ts";
import "./side-effect.ts";
import { helper } from "./part.ts";

export * from "./shape.ts";
export { area } from "./part.ts";
export { View } from "./view.tsx";

export const [, second] = pair;
export const { first, nested: { deep } } = { first: 1, nested: { deep: 2 } };
const local = 1;
export { local as alias };
register(helper);
export { other as renamed } from "./other.ts";
export * from "./third.ts";
export * as space from "./space.ts";
export default class Thing {}
`;

const SPLIT_PART = `
import type { Shape } from "./shape.ts";

// The helper gains an export because the original file still calls it.
export const helper = (value: number): number =>
  value * 2;

export function area(shape: Shape): number {
  return helper(shape.side) ** 2;
}
`;

const SPLIT_SHAPE = `
export interface Shape {
  readonly side: number;
}
`;

const SPLIT_VIEW = `
import { area } from "./part.ts";

export const View = () => <b>{area({ side: 1 })}</b>;
`;

const BEFORE = JSON.stringify({
  total: {},
  "/checkout/src/a.tsx": coverage(
    [6, 10],
    [1, 2],
    [1, 3],
    [6, 10],
    [60, 50, 33.33, 60]
  ),
});

const AFTER = {
  "/checkout/src/a.tsx": coverage(
    [5, 6],
    [1, 2],
    [0, 0],
    [5, 6],
    [83.33, 50, 100, 83.33]
  ),
  "src/part.ts": coverage(
    [1, 3],
    [0, 0],
    [1, 2],
    [1, 3],
    [33.33, 100, 50, 33.33]
  ),
  "/checkout/src/shape.ts": coverage(
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [100, 100, 100, 100]
  ),
  "/checkout/src/view.tsx": coverage(
    [0, 1],
    [0, 0],
    [0, 1],
    [0, 1],
    [0, 100, 0, 0]
  ),
};

const ARGUMENTS = [
  "--base",
  "main",
  "--from",
  "src/a.tsx",
  "--to",
  "src/part.ts",
  "--to",
  "./src/shape.ts",
  "--to",
  "src/view.tsx",
  "--coverage-before",
  "before.json",
  "--coverage-after",
  "after.json",
] as const;

const TREE: Files = {
  "src/a.tsx": SPLIT_ORIGIN,
  "src/part.ts": SPLIT_PART,
  "src/shape.ts": SPLIT_SHAPE,
  "src/view.tsx": SPLIT_VIEW,
  "before.json": BEFORE,
  "after.json": JSON.stringify(AFTER),
};

const BASE: Files = { "src/a.tsx": ORIGINAL };

const prove = async (
  tree: Files = TREE,
  base: Files = BASE,
  arguments_: readonly string[] = ARGUMENTS
) => {
  const output: string[] = [];
  const errors: string[] = [];
  const gitCalls: (readonly string[])[] = [];
  const dependencies: CoverageSplitProofDependencies = {
    git: async (gitArguments) => {
      gitCalls.push(gitArguments);
      return base[required(gitArguments[1], "object").slice("main:".length)];
    },
    readText: async (path) => required(tree[path], path),
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
  };
  const code = await runCoverageSplitProof(arguments_, dependencies);
  return { code, output, errors, gitCalls };
};

const USAGE = expect.stringMatching(
  /^Usage: bun scripts\/coverage-split-proof\.ts --base /u
);

describe("runCoverageSplitProof", () => {
  it("proves a split that only moves declarations and keeps the coverage totals", async () => {
    const result = await prove();

    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([
      "Pure-move split of src/a.tsx into src/part.ts, src/shape.ts, src/view.tsx (base main)",
      "Statements: 14 in the original file; 4 in the new files.",
      "Exports of src/a.tsx: 11 before, 11 after.",
      "Coverage, covered/total before and after:",
      "  lines: 6/10 and 6/10",
      "  branches: 1/2 and 1/2",
      "  functions: 1/3 and 1/3",
      "  statements: 6/10 and 6/10",
      "Baseline entries after the split (scripts/ci/coverage-baseline.json):",
      '  "src/a.tsx": { "lines": 83.33, "branches": 50, "functions": 100, "statements": 83.33 }',
      '  "src/part.ts": { "lines": 33.33, "branches": 100, "functions": 50, "statements": 33.33 }',
      "  src/shape.ts: 100% on all four measures, no entry",
      '  "src/view.tsx": { "lines": 0, "branches": 100, "functions": 0, "statements": 0 }',
      "Result: PROVED",
    ]);
    expect(result.gitCalls).toEqual([
      ["show", "main:src/a.tsx"],
      ["show", "main:src/part.ts"],
      ["show", "main:src/shape.ts"],
      ["show", "main:src/view.tsx"],
    ]);
    expect(result.code).toBe(0);
  });

  it("names every statement that changed, moved out of order, ran at import time or went missing", async () => {
    const result = await prove({
      ...TREE,
      "src/a.tsx": `
import { pair } from "./deps.ts";
import "./side-effect.ts";

export * from "./shape.ts";
export { area, extra } from "./part.ts";
export { View } from "./view.tsx";
export const { first, nested: { deep } } = { first: 1, nested: { deep: 2 } };
export const [, second] = pair;
const local = 1;
export { local as alias };
export { other as renamed } from "./other.ts";
export * from "./third.ts";
export * as space from "./space.ts";
`,
      "src/part.ts": `
import { register } from "./deps.ts";
import type { Shape } from "./shape.ts";

export function area(shape: Shape): number {
  return helper(shape.side) ** 3;
}
register(helper);
export const extra = "a new statement whose text is longer than the sixty characters of a preview";
`,
    });

    expect(result.output.slice(-11)).toEqual([
      "Problems:",
      "  - src/a.tsx:9: statement is out of its original order: const [ , second ] = pair ;",
      "  - src/part.ts:5: statement is not in the original file (new or changed code): function area ( shape : Shape ) : number { return helper ( s...",
      "  - src/part.ts:8: only declarations may move; this statement runs at import time: register ( helper ) ;",
      '  - src/part.ts:9: statement is not in the original file (new or changed code): const extra = "a new statement whose text is longer than the...',
      "  - src/a.tsx:6: statement of the original file is missing after the split: const helper = ( value : number ) : number => value * 2 ;",
      "  - src/a.tsx:13: statement of the original file is missing after the split: function area ( shape : Shape ) : number { return helper ( s...",
      "  - src/a.tsx:26: statement of the original file is missing after the split: default class Thing { }",
      "  - src/a.tsx: export default is missing after the split",
      "  - src/a.tsx: export extra is new after the split",
      "Result: NOT PROVED (9)",
    ]);
    expect(result.errors).toEqual([]);
    expect(result.code).toBe(1);
  });

  it("refuses a split into a file that exists at the base", async () => {
    const result = await prove(TREE, { ...BASE, "src/shape.ts": SPLIT_SHAPE });

    expect(result.output.slice(-3)).toEqual([
      "Problems:",
      "  - src/shape.ts exists at main: a split moves code into new files only",
      "Result: NOT PROVED (1)",
    ]);
    expect(result.code).toBe(1);
  });

  it("refuses changed coverage totals", async () => {
    const result = await prove({
      ...TREE,
      "after.json": JSON.stringify({
        ...AFTER,
        "src/part.ts": coverage(
          [2, 3],
          [0, 0],
          [1, 2],
          [1, 4],
          [66.67, 100, 50, 25]
        ),
      }),
    });

    expect(result.output.slice(-4)).toEqual([
      "Problems:",
      "  - lines: coverage was 6/10 and is 7/10 after the split",
      "  - statements: coverage was 6/10 and is 6/11 after the split",
      "Result: NOT PROVED (2)",
    ]);
    expect(result.code).toBe(1);
  });

  it("counts a default export assignment as the default export", async () => {
    const full = [100, 100, 100, 100] as const;
    const base = { "src/a.tsx": "const value = 1;\nexport default value;\n" };
    const tree = {
      "src/a.tsx":
        'import { value } from "./part.ts";\nexport default value;\n',
      "src/part.ts": "export const value = 1;\n",
      "before.json": JSON.stringify({
        "src/a.tsx": coverage([1, 1], [0, 0], [0, 0], [1, 1], full),
      }),
      "after.json": JSON.stringify({
        "src/a.tsx": coverage([0, 0], [0, 0], [0, 0], [0, 0], full),
        "src/part.ts": coverage([1, 1], [0, 0], [0, 0], [1, 1], full),
      }),
    };

    const result = await prove(tree, base, [
      "--base=main",
      "--from=src/a.tsx",
      "--to=src/part.ts",
      "--coverage-before=before.json",
      "--coverage-after=after.json",
    ]);

    expect(result.output.slice(0, 3)).toEqual([
      "Pure-move split of src/a.tsx into src/part.ts (base main)",
      "Statements: 2 in the original file; 1 in the new files.",
      "Exports of src/a.tsx: 1 before, 1 after.",
    ]);
    expect(result.output.slice(-3)).toEqual([
      "  src/a.tsx: 100% on all four measures, no entry",
      "  src/part.ts: 100% on all four measures, no entry",
      "Result: PROVED",
    ]);
    expect(result.code).toBe(0);
  });

  it.each([
    ["--base", "--base is unexpectedly missing"],
    ["--from", "--from is unexpectedly missing"],
    ["--to", "--to is unexpectedly missing"],
    ["--coverage-before", "--coverage-before is unexpectedly missing"],
    ["--coverage-after", "--coverage-after is unexpectedly missing"],
  ])("requires %s", async (option, message) => {
    const arguments_ = ARGUMENTS.filter(
      (argument, position) =>
        argument !== option && ARGUMENTS[position - 1] !== option
    );

    const result = await prove(TREE, BASE, arguments_);

    expect(result.errors).toEqual([message, USAGE]);
    expect(result.output).toEqual([]);
    expect(result.code).toBe(2);
  });

  it("rejects an unknown option", async () => {
    const result = await prove(TREE, BASE, [...ARGUMENTS, "--write"]);

    expect(result.errors).toEqual(["Unknown option '--write'", USAGE]);
    expect(result.code).toBe(2);
  });

  it("stops when the original file is not at the base", async () => {
    const result = await prove(TREE, {});

    expect(result.errors).toEqual([
      "src/a.tsx at main is unexpectedly missing",
      USAGE,
    ]);
    expect(result.code).toBe(2);
  });

  it.each([
    [
      "before",
      { "before.json": JSON.stringify({ total: {} }) },
      "src/a.tsx in the coverage summary before the split is unexpectedly missing",
    ],
    [
      "after",
      { "after.json": JSON.stringify({ ...AFTER, "src/part.ts": undefined }) },
      "src/part.ts in the coverage summary after the split is unexpectedly missing",
    ],
  ])(
    "stops when a file is not in the coverage summary %s the split",
    async (_when, files, message) => {
      const result = await prove({ ...TREE, ...files });

      expect(result.errors).toEqual([message, USAGE]);
      expect(result.code).toBe(2);
    }
  );
});
