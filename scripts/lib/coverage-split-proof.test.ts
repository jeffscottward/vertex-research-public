import { describe, expect, it } from "vitest";

import {
  type CoverageSplitProofDependencies,
  runCoverageSplitProof,
} from "./coverage-split-proof.ts";
import { required } from "./required.ts";

type Counts = readonly [covered: number, total: number];
type Tree = Readonly<Record<string, string | undefined>>;

const BASELINE = "scripts/ci/coverage-baseline.json";
const TARGET = "origin/vertex/rebuild-darkfactory-20260921";

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

const KEPT = `
export const second = 2;
export const first = 1;
const local = 1;
export { local as alias };
const kept = 2;
export { kept };
register(helper);
for (const item of pair) register(item);
export { other as renamed } from "./other.ts";
export default class Thing {}
`;

const ORIGINAL = `
import { pair, register } from "./deps.ts";
import Default, * as all from "lib";
import { type Kind, read } from "lib/kinds";
import type { Options } from "lib/options";
import data from "./data.json" with { type: "json" };
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
export type Unit = Kind;
export const Unit = 1;
const LIMITS = {
  low: -1,
  high: 2n,
  label: \`x\`,
  pattern: /a/u,
  on: true,
  off: false,
  none: null,
  list: [1, , "b"],
  run() {
    return 1;
  },
  get size() {
    return 2;
  },
} as const;
const kinds = (["a", "b"] satisfies readonly string[]);
let seen = 0;
function build(options: Options): number {
  return all.x + data.y + options.w + Default + read() + seen;
}
function folder(): string {
  return import.meta.dirname;
}
function Made() {
  return new.target;
}
function assign(target: { a?: number }) {
  let a: number | undefined;
  ({ a = second } = target);
  return { a, helper };
}
${KEPT}`;

const SPLIT_ORIGIN = `
import { pair, register } from "./deps.ts";
import { helper } from "./part.ts";
import "./side-effect.ts";

export { type Shape } from "./shape.ts";
export { area, Unit } from "./part.ts";
export { View } from "./view.tsx";
${KEPT}`;

const PART_IMPORTS = `
import Default, * as all from "lib";
import { type Kind, read } from "lib/kinds";
import type { Options } from "lib/options";
import data from "./data.json" with { type: "json" };
import type { Shape } from "./shape.ts";
import { second } from "./a.tsx";
`;

const PART_BODY = `
// The helper gains an export because the original file still calls it.
export const helper = (value: number): number =>
  value * 2;

export function area(shape: Shape): number {
  return helper(shape.side) ** 2;
}
export type Unit = Kind;
export const Unit = 1;
const LIMITS = {
  low: -1,
  high: 2n,
  label: \`x\`,
  pattern: /a/u,
  on: true,
  off: false,
  none: null,
  list: [1, , "b"],
  run() {
    return 1;
  },
  get size() {
    return 2;
  },
} as const;
const kinds = (["a", "b"] satisfies readonly string[]);
let seen = 0;
function build(options: Options): number {
  return all.x + data.y + options.w + Default + read() + seen;
}
function folder(): string {
  return import.meta.dirname;
}
function Made() {
  return new.target;
}
function assign(target: { a?: number }) {
  let a: number | undefined;
  ({ a = second } = target);
  return { a, helper };
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

const OTHER_ENTRY = { lines: 1, branches: 2, functions: 3, statements: 4 };

const BASELINE_BEFORE = `{
  "_comment": "ratchet",
  "files": {
    "src/a.tsx": { "lines": 60.0, "branches": 50.0, "functions": 33.33, "statements": 60.0 },
    "src/other.ts": ${JSON.stringify(OTHER_ENTRY)}
  }
}`;

const AFTER_ENTRIES = {
  "src/a.tsx": {
    lines: 83.33,
    branches: 50,
    functions: 100,
    statements: 83.33,
  },
  "src/other.ts": OTHER_ENTRY,
  "src/part.ts": {
    lines: 33.33,
    branches: 100,
    functions: 50,
    statements: 33.33,
  },
  "src/view.tsx": { lines: 0, branches: 100, functions: 0, statements: 0 },
};

const BASELINE_AFTER = JSON.stringify({
  _comment: "ratchet",
  files: AFTER_ENTRIES,
});

const ARGUMENTS = [
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

const CHANGED = [
  "src/a.tsx",
  "src/part.ts",
  "src/shape.ts",
  "src/view.tsx",
  BASELINE,
] as const;

const HEAD: Tree = {
  "src/a.tsx": SPLIT_ORIGIN,
  "src/part.ts": `${PART_IMPORTS}${PART_BODY}`,
  "src/shape.ts": SPLIT_SHAPE,
  "src/view.tsx": SPLIT_VIEW,
  [BASELINE]: BASELINE_AFTER,
};

const BASE: Tree = { "src/a.tsx": ORIGINAL, [BASELINE]: BASELINE_BEFORE };

const FILES: Tree = {
  "before.json": BEFORE,
  "after.json": JSON.stringify(AFTER),
};

type Run = Readonly<{
  head?: Tree;
  base?: Tree;
  files?: Tree;
  arguments_?: readonly string[];
  changed?: readonly string[] | undefined;
  mergeBase?: string | undefined;
  /** Whether the base is an ancestor of HEAD. */
  ancestor?: boolean;
}>;

const prove = async (run: Run = {}) => {
  const head = { ...HEAD, ...run.head };
  const base = { ...BASE, ...run.base };
  const files = { ...FILES, ...run.files };
  const changed = "changed" in run ? run.changed : CHANGED;
  const mergeBase = "mergeBase" in run ? run.mergeBase : "main\n";
  const output: string[] = [];
  const errors: string[] = [];
  const gitCalls: (readonly string[])[] = [];
  const dependencies: CoverageSplitProofDependencies = {
    git: async (gitArguments) => {
      gitCalls.push(gitArguments);
      const [command, object = ""] = gitArguments;
      if (command === "merge-base" && object === "--is-ancestor") {
        return run.ancestor === false ? undefined : "";
      }
      if (command === "merge-base") return mergeBase;
      if (command === "rev-parse") {
        return `${required(gitArguments[2], "ref").replace("^{commit}", "")}\n`;
      }
      if (command === "diff") {
        return changed?.map((path) => `${path}\n`).join("");
      }
      if (command === "ls-tree") {
        const folder = required(gitArguments[4], "folder");
        const children = Object.keys(base)
          .filter((path) => path.startsWith(folder))
          .map((path) => folder + path.slice(folder.length).split("/")[0]);
        return [...new Set(children)].map((path) => `${path}\n`).join("");
      }
      const [ref, path = ""] = object.split(":");
      return (ref === "HEAD" ? head : base)[path];
    },
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
  };
  const code = await runCoverageSplitProof(
    run.arguments_ ?? ARGUMENTS,
    dependencies
  );
  const problems = output
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice("  - ".length));
  return { code, output, errors, gitCalls, problems };
};

const FULL = coverage([0, 0], [0, 0], [0, 0], [0, 0], [100, 100, 100, 100]);
const EMPTY_BASELINE = JSON.stringify({ files: {} });

/** A split of src/a.ts into src/part.ts with no coverage to compare. */
const smallSplit = (original: string, kept: string, moved: string) =>
  prove({
    base: { "src/a.ts": original, [BASELINE]: EMPTY_BASELINE },
    head: {
      "src/a.ts": kept,
      "src/part.ts": moved,
      [BASELINE]: EMPTY_BASELINE,
    },
    files: {
      "small.json": JSON.stringify({ "src/a.ts": FULL, "src/part.ts": FULL }),
    },
    arguments_: [
      "--base=main",
      "--from=src/a.ts",
      "--to=src/part.ts",
      "--coverage-before=small.json",
      "--coverage-after=small.json",
    ],
    changed: ["src/a.ts", "src/part.ts"],
  });

const USAGE = expect.stringMatching(
  /^Usage: bun scripts\/coverage-split-proof\.ts \[--base /u
);

/** `text` with `search` replaced; fails when `search` is not in it. */
const edit = (
  text: string | undefined,
  search: string,
  replacement: string
) => {
  expect(text).toContain(search);
  return (text as string).replace(search, replacement);
};

const part = (search: string, replacement: string): Tree => ({
  "src/part.ts": edit(HEAD["src/part.ts"], search, replacement),
});

const origin = (search: string, replacement: string): Tree => ({
  "src/a.tsx": edit(HEAD["src/a.tsx"], search, replacement),
});

const view = (search: string, replacement: string): Tree => ({
  "src/view.tsx": edit(HEAD["src/view.tsx"], search, replacement),
});

describe("runCoverageSplitProof", () => {
  it("proves a split that only moves declarations and keeps the coverage totals", async () => {
    const result = await prove();

    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([
      "Pure-move split of src/a.tsx into src/part.ts, src/shape.ts, src/view.tsx",
      `Base: main (merge base of HEAD and ${TARGET}); files after the split: HEAD`,
      "Statements: 24 in the original file; 13 in the new files.",
      "Exports of src/a.tsx: 10 before, 10 after.",
      "Coverage, covered/total before and after:",
      "  lines: 6/10 and 6/10",
      "  branches: 1/2 and 1/2",
      "  functions: 1/3 and 1/3",
      "  statements: 6/10 and 6/10",
      `Baseline entries after the split (${BASELINE}):`,
      '  "src/a.tsx": { "lines": 83.33, "branches": 50, "functions": 100, "statements": 83.33 }',
      '  "src/part.ts": { "lines": 33.33, "branches": 100, "functions": 50, "statements": 33.33 }',
      "  src/shape.ts: 100% on all four measures, no entry",
      '  "src/view.tsx": { "lines": 0, "branches": 100, "functions": 0, "statements": 0 }',
      "Result: PROVED",
    ]);
    expect(result.gitCalls).toEqual([
      ["merge-base", "HEAD", TARGET],
      ["rev-parse", "--verify", "main^{commit}"],
      ["diff", "--name-only", "--no-renames", "main..HEAD"],
      ["ls-tree", "--name-only", "main", "--", "src/"],
      ["ls-tree", "--name-only", "main", "--", "src/"],
      ["ls-tree", "--name-only", "main", "--", "src/"],
      ["merge-base", "--is-ancestor", "main", "HEAD"],
      ["show", "HEAD:src/a.tsx"],
      ["show", "HEAD:src/part.ts"],
      ["show", "HEAD:src/shape.ts"],
      ["show", "HEAD:src/view.tsx"],
      ["show", "main:src/a.tsx"],
      ["show", `main:${BASELINE}`],
      ["show", `HEAD:${BASELINE}`],
    ]);
    expect(result.code).toBe(0);
  });

  it("uses the base that --base names and says so", async () => {
    const result = await prove({ arguments_: ["--base=main", ...ARGUMENTS] });

    expect(result.output[1]).toBe(
      `Base: main (--base main; the merge base of HEAD and ${TARGET} is main); files after the split: HEAD`
    );
    expect(result.gitCalls.slice(0, 3)).toEqual([
      ["merge-base", "HEAD", TARGET],
      ["rev-parse", "--verify", "main^{commit}"],
      ["diff", "--name-only", "--no-renames", "main..HEAD"],
    ]);
    expect(result.code).toBe(0);
  });

  it("says when it does not know the merge base beside --base", async () => {
    const result = await prove({
      arguments_: ["--base=main", ...ARGUMENTS],
      mergeBase: undefined,
    });

    expect(result.output[1]).toBe(
      `Base: main (--base main; the merge base of HEAD and ${TARGET} is unknown); files after the split: HEAD`
    );
    expect(result.code).toBe(0);
  });

  it("resolves relative specifiers, so another spelling of the same module is the same import", async () => {
    const result = await prove({
      head: origin('from "./deps.ts"', 'from "../src/deps.ts"'),
    });

    expect(result.problems).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("names every statement that changed, moved out of order or went missing", async () => {
    const result = await prove({
      head: {
        "src/a.tsx": edit(
          edit(
            SPLIT_ORIGIN,
            "export const second = 2;\nexport const first = 1;",
            "export const first = 1;\nexport const second = 2;"
          ),
          "export default class Thing {}\n",
          ""
        ),
        "src/part.ts": edit(
          edit(HEAD["src/part.ts"], "** 2;", "** 3;"),
          "const kinds",
          'export const extra = "a new statement whose text is longer than the sixty characters of a preview";\nconst kinds'
        ),
      },
    });

    expect(result.problems).toEqual([
      "src/a.tsx:11: statement is out of its original order: const second = 2 ;",
      "src/part.ts:13: statement is not in the original file (new or changed code): function area ( shape : Shape ) : number { return helper ( s...",
      'src/part.ts:34: statement is not in the original file (new or changed code): const extra = "a new statement whose text is longer than the...',
      "src/a.tsx:17: statement of the original file is missing after the split: function area ( shape : Shape ) : number { return helper ( s...",
      "src/a.tsx:66: statement of the original file is missing after the split: default class Thing { }",
      "src/a.tsx: export default is missing after the split",
    ]);
    expect(result.code).toBe(1);
  });

  describe("imports", () => {
    it.each([
      [
        "an alias",
        part(
          'import { second } from "./a.tsx";',
          'import { pair as second } from "./deps.ts";'
        ),
        [
          "src/part.ts:7: imports pair as second; aliases are not allowed",
          "src/part.ts:45: second names declaration second in the original file and pair from src/deps.ts after the split",
        ],
      ],
      [
        "the same name from another module",
        part('from "lib/kinds"', 'from "lib/other-kinds"'),
        [
          "src/part.ts:3: imports Kind from lib/other-kinds (type), which the original file does not import that way",
          "src/part.ts:3: imports read from lib/other-kinds (value), which the original file does not import that way",
          'src/a.tsx: loads src/deps.ts, lib, lib/kinds, src/data.json with { type : "json" }, src/side-effect.ts, src/other.ts before the split and src/deps.ts, lib, lib/other-kinds, src/data.json with { type : "json" }, src/side-effect.ts, src/other.ts after it; what loads and its order stay the same',
          "src/part.ts:16: Kind names Kind from lib/kinds in the original file and Kind from lib/other-kinds after the split",
          "src/part.ts:36: read names read from lib/kinds in the original file and read from lib/other-kinds after the split",
        ],
      ],
      [
        "an empty import of a module the original did not load",
        part(
          "import { second }",
          'import {} from "./evil.ts";\nimport { second }'
        ),
        [
          'src/a.tsx: loads src/deps.ts, lib, lib/kinds, src/data.json with { type : "json" }, src/side-effect.ts, src/other.ts before the split and src/deps.ts, lib, lib/kinds, src/data.json with { type : "json" }, src/evil.ts, src/side-effect.ts, src/other.ts after it; what loads and its order stay the same',
        ],
      ],
      [
        "a value import of a name the original imported as a type",
        part("import type { Options }", "import { Options }"),
        [
          "src/part.ts:4: imports Options from lib/options (value), which the original file does not import that way",
          'src/a.tsx: loads src/deps.ts, lib, lib/kinds, src/data.json with { type : "json" }, src/side-effect.ts, src/other.ts before the split and src/deps.ts, lib, lib/kinds, lib/options, src/data.json with { type : "json" }, src/side-effect.ts, src/other.ts after it; what loads and its order stay the same',
        ],
      ],
      [
        "a default import of a new file",
        view("import { area }", "import area"),
        [
          "src/view.tsx:2: imports default from src/part.ts, which is not a declaration of that file imported by its name",
          "src/view.tsx:4: area names declaration area in the original file and declaration default after the split",
        ],
      ],
      [
        "a name from a new file that does not declare it",
        view('"./part.ts"', '"./shape.ts"'),
        [
          "src/view.tsx:2: imports area from src/shape.ts, which is not a declaration of that file imported by its name",
        ],
      ],
    ])("rejects %s", async (_case, head, problems) => {
      const result = await prove({ head });

      expect(result.problems).toEqual(problems);
      expect(result.code).toBe(1);
    });
  });

  describe("loading", () => {
    it.each([
      [
        "changes the order in which modules load",
        'import "./setup.ts";\nimport { read } from "./reader.ts";\nexport function f() {\n  return read();\n}\nexport const g = 1;\n',
        'export { f } from "./part.ts";\nimport "./setup.ts";\nexport const g = 1;\n',
        'import { read } from "./reader.ts";\nexport function f() {\n  return read();\n}\n',
        [
          "src/a.ts: loads src/setup.ts, src/reader.ts before the split and src/reader.ts, src/setup.ts after it; what loads and its order stay the same",
        ],
      ],
      [
        "no longer loads a module",
        'import {} from "./effects.ts";\nexport function f() {\n  return 1;\n}\n',
        'export { f } from "./part.ts";\n',
        "export function f() {\n  return 1;\n}\n",
        [
          "src/a.ts: loads src/effects.ts before the split and no module after it; what loads and its order stay the same",
        ],
      ],
      [
        "imports as a type what the original loaded",
        'import { Foo } from "./m.ts";\nexport function f(x: Foo) {\n  return x;\n}\n',
        'export { f } from "./part.ts";\n',
        'import type { Foo } from "./m.ts";\nexport function f(x: Foo) {\n  return x;\n}\n',
        [
          "src/a.ts: loads src/m.ts before the split and no module after it; what loads and its order stay the same",
        ],
      ],
      [
        "loads a deferred module at once",
        'import defer * as lazy from "./lazy.ts";\nexport function f() {\n  return lazy.x;\n}\n',
        'export { f } from "./part.ts";\n',
        'import defer * as lazy from "./lazy.ts";\nimport {} from "./lazy.ts";\nexport function f() {\n  return lazy.x;\n}\n',
        [
          'src/a.ts:1: the proof refuses import defer: import defer * as lazy from "./lazy.ts" ;',
          'src/part.ts:1: the proof refuses import defer: import defer * as lazy from "./lazy.ts" ;',
        ],
      ],
      [
        "imports a name the new file does not export",
        "function helper() {\n  return 1;\n}\nexport const v = helper;\n",
        'import { helper } from "./part.ts";\nexport const v = helper;\n',
        "function helper() {\n  return 1;\n}\n",
        [
          "src/a.ts:1: imports helper from src/part.ts, which does not export it",
        ],
      ],
      [
        "imports a type of a new file without type",
        "interface T {}\nexport const v: T = {};\n",
        'import { T } from "./part.ts";\nexport const v: T = {};\n',
        "export interface T {}\n",
        [
          "src/a.ts:1: imports T from src/part.ts, which has no value at run time, without `type`",
        ],
      ],
      [
        "uses a type-only import as a value",
        "function f() {\n  return 1;\n}\nexport const g = f();\n",
        'import type { f } from "./part.ts";\nexport const g = f();\n',
        "export function f() {\n  return 1;\n}\n",
        [
          "src/a.ts:2: 'f' cannot be used as a value because it was imported using 'import type'.",
        ],
      ],
      [
        "assigns to a let that is now imported",
        "export let count = 0;\nexport function inc() {\n  count++;\n}\n",
        'export let count = 0;\nexport { inc } from "./part.ts";\n',
        'import { count } from "./a.ts";\nexport function inc() {\n  count++;\n}\n',
        ["src/part.ts:3: Cannot assign to 'count' because it is an import."],
      ],
    ])(
      "rejects a split that %s",
      async (_case, original, kept, moved, problems) => {
        const result = await smallSplit(original, kept, moved);

        expect(result.problems).toEqual(problems);
        expect(result.code).toBe(1);
      }
    );
  });

  describe("names", () => {
    it.each([
      [
        "a kept statement whose import was dropped",
        origin("import { pair, register }", "import { pair }"),
        [
          "src/a.tsx:16: register names register from src/deps.ts in the original file and no import or top-level declaration after the split",
          "src/a.tsx:17: register names register from src/deps.ts in the original file and no import or top-level declaration after the split",
        ],
      ],
      [
        "moved code whose declaration is no longer imported",
        view('import { area } from "./part.ts";\n', ""),
        [
          "src/view.tsx:3: area names declaration area in the original file and no import or top-level declaration after the split",
        ],
      ],
    ])(
      "rejects %s, which would fall through to a global",
      async (_case, head, problems) => {
        const result = await prove({ head });

        expect(result.problems).toEqual(problems);
        expect(result.code).toBe(1);
      }
    );
  });

  describe("exports", () => {
    it.each([
      [
        "a renaming re-export",
        origin("export { area, Unit }", "export { helper as area, Unit }"),
        [
          "src/a.tsx:7: renames helper of src/part.ts to area",
          "src/a.tsx: export area is missing after the split",
        ],
      ],
      [
        "a re-export of a name the new file does not export",
        origin(
          'export { area, Unit } from "./part.ts";\nexport { View } from "./view.tsx";',
          'export { area, Unit, View } from "./part.ts";'
        ),
        [
          "src/a.tsx:7: re-exports View, which src/part.ts does not export",
          "src/a.tsx: export View is missing after the split",
        ],
      ],
      [
        "a type-only re-export of a value",
        origin(
          'export { area, Unit } from "./part.ts";',
          'export { area } from "./part.ts";\nexport type { Unit } from "./part.ts";'
        ),
        [
          "src/a.tsx:8: re-exports the value Unit of src/part.ts as a type",
          "src/a.tsx: export Unit is missing after the split",
        ],
      ],
      [
        "a namespace re-export of a new file",
        origin(
          'export { View } from "./view.tsx";',
          'export * as views from "./view.tsx";'
        ),
        [
          'src/a.tsx:8: the proof refuses export *: export * as views from "./view.tsx" ;',
          "src/a.tsx: export View is missing after the split",
        ],
      ],
      [
        "an export the original file did not have",
        origin("export { area, Unit }", "export { area, Unit, helper }"),
        ["src/a.tsx: export helper is new after the split"],
      ],
    ])("rejects %s", async (_case, head, problems) => {
      const result = await prove({ head });

      expect(result.problems).toEqual(problems);
      expect(result.code).toBe(1);
    });

    it("does not count a default as re-exported by export *", async () => {
      const result = await smallSplit(
        "export default function () {\n  return 1;\n}\n",
        'export * from "./part.ts";\n',
        "export default function () {\n  return 1;\n}\n"
      );

      expect(result.problems).toEqual([
        'src/a.ts:1: the proof refuses export *: export * from "./part.ts" ;',
        "src/a.ts: export default is missing after the split",
      ]);
      expect(result.code).toBe(1);
    });

    it.each([
      [
        "a type-only star re-export of values",
        "export const v = 1;\n",
        'export type * from "./part.ts";\n',
        "export const v = 1;\n",
        [
          'src/a.ts:1: the proof refuses export *: export type * from "./part.ts" ;',
          "src/a.ts: export v is missing after the split",
        ],
      ],
      [
        "a star re-export of a new file beside a star re-export of another module",
        'export * from "./other.ts";\nexport const v = 1;\n',
        'export * from "./other.ts";\nexport * from "./part.ts";\n',
        "export const v = 1;\n",
        [
          'src/a.ts:1: the proof refuses export *: export * from "./other.ts" ;',
          'src/a.ts:1: the proof refuses export *: export * from "./other.ts" ;',
          'src/a.ts:2: the proof refuses export *: export * from "./part.ts" ;',
          "src/a.ts: export v is missing after the split",
        ],
      ],
      [
        "a re-export of a type without type",
        "export interface T {}\n",
        'export { T } from "./part.ts";\n',
        "export interface T {}\n",
        [
          "src/a.ts:1: re-exports T of src/part.ts, which has no value at run time, without `type`",
          "src/a.ts: export T is missing after the split",
        ],
      ],
      [
        "an export of a type-only import without type",
        "const v = 1;\nexport { v };\n",
        'import type { v } from "./part.ts";\nexport { v };\n',
        "export const v = 1;\n",
        ["src/a.ts:2: exports the type-only import v without `type`"],
      ],
    ])("rejects %s", async (_case, original, kept, moved, problems) => {
      const result = await smallSplit(original, kept, moved);

      expect(result.problems).toEqual(problems);
      expect(result.code).toBe(1);
    });

    it("rejects an export that resolves to another declaration", async () => {
      const result = await smallSplit(
        "const local = 1;\nconst alias = 2;\nexport { local as alias };\n",
        'const local = 1;\nexport { local as alias };\nexport * from "./part.ts";\n',
        "export const alias = 2;\n"
      );

      expect(result.problems).toEqual([
        'src/a.ts:3: the proof refuses export *: export * from "./part.ts" ;',
      ]);
      expect(result.code).toBe(1);
    });
  });

  it("rejects an export that names another import", async () => {
    const result = await smallSplit(
      'import { x } from "./m.ts";\nexport { x };\n',
      'import { x } from "./n.ts";\nexport { x };\n',
      ""
    );

    expect(result.problems).toEqual([
      "src/a.ts: export x was x from src/m.ts and is x from src/n.ts after the split",
      "src/a.ts:1: imports x from src/n.ts (value), which the original file does not import that way",
      "src/a.ts: loads src/m.ts before the split and src/n.ts after it; what loads and its order stay the same",
      "src/a.ts:2: x names x from src/m.ts in the original file and x from src/n.ts after the split",
    ]);
    expect(result.code).toBe(1);
  });

  it("rejects a change to any file but the split files and the baseline", async () => {
    const result = await prove({ changed: [...CHANGED, "src/other.ts"] });

    expect(result.problems).toEqual([
      "src/other.ts changed: a split changes only src/a.tsx, src/part.ts, src/shape.ts, src/view.tsx, scripts/ci/coverage-baseline.json",
    ]);
    expect(result.code).toBe(1);
  });

  describe("moved statements", () => {
    it.each([
      [
        "const started = Date.now();",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const started = Date . now ( ) ;",
      ],
      [
        "var legacy = 0;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: var legacy = 0 ;",
      ],
      [
        "declare const ambient: number;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is an ambient declaration (declare), which has no value at run time: declare const ambient : number ;",
      ],
      [
        "const flags = { ...defaults };",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const flags = { ... defaults } ;",
      ],
      [
        "const keyed = { [key]: 1 };",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const keyed = { [ key ] : 1 } ;",
      ],
      [
        "const short = { value };",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const short = { value } ;",
      ],
      [
        "const negated = !0;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const negated = ! 0 ;",
      ],
      [
        "const negative = -offset;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const negative = - offset ;",
      ],
      [
        "const tagged = `a${b}`;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const tagged = `a${ b }` ;",
      ],
      [
        "await using handle = open();",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: await using handle = open ( ) ;",
      ],
      [
        "enum Color {\n  Red,\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: enum Color { Red , }",
      ],
      [
        "class Decorated {\n  @observe value = 1;\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Decorated { @ observe value = 1 ; }",
      ],
      [
        "class Blocked {\n  static {\n    start();\n  }\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Blocked { static { start ( ) ; } }",
      ],
      [
        "class Computed {\n  [key] = 1;\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Computed { [ key ] = 1 ; }",
      ],
      [
        "class Started {\n  static at = Date.now();\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Started { static at = Date . now ( ) ; }",
      ],
      [
        "class Mixed extends mixin(Base) {}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Mixed extends mixin ( Base ) { }",
      ],
      [
        "const where = () => import.meta.url;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is code that names its own file (import.meta, __filename, module, exports): const where = ( ) => import . meta . url ;",
      ],
      [
        "function file() {\n  return __filename;\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is code that names its own file (import.meta, __filename, module, exports): function file ( ) { return __filename ; }",
      ],
      [
        "function isMain() {\n  return require.main === module;\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is code that names its own file (import.meta, __filename, module, exports): function isMain ( ) { return require . main === module ; }",
      ],
      [
        "const alias = other;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: const alias = other ;",
      ],
      [
        "function commonJs() {\n  return exports;\n}",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is code that names its own file (import.meta, __filename, module, exports): function commonJs ( ) { return exports ; }",
      ],
      [
        "declare function native(): number;",
        "src/part.ts:1: only declarations that run nothing at load time may move; this is an ambient declaration (declare), which has no value at run time: declare function native ( ) : number ;",
      ],
    ])("keeps %s in the original file", async (statement, problem) => {
      const result = await smallSplit(`${statement}\n`, "", `${statement}\n`);

      expect(result.problems).toEqual([problem]);
      expect(result.code).toBe(1);
    });

    it.each([
      [
        "const { max = LIMIT } = {} as { max?: number };",
        [
          "src/a.ts:1: the proof refuses a destructuring declaration: const { max = LIMIT } = { } as { max ? : number } ;",
          "src/part.ts:1: the proof refuses a destructuring declaration: const { max = LIMIT } = { } as { max ? : number } ;",
        ],
      ],
      [
        "const { v } = {\n  get v() {\n    return 1;\n  },\n};",
        [
          "src/a.ts:1: the proof refuses a destructuring declaration: const { v } = { get v ( ) { return 1 ; } , } ;",
          "src/part.ts:1: the proof refuses a destructuring declaration: const { v } = { get v ( ) { return 1 ; } , } ;",
        ],
      ],
      [
        "const { [key]: k } = {};",
        [
          "src/a.ts:1: the proof refuses a destructuring declaration: const { [ key ] : k } = { } ;",
          "src/part.ts:1: the proof refuses a destructuring declaration: const { [ key ] : k } = { } ;",
        ],
      ],
    ])(
      "refuses the destructuring declaration %s",
      async (statement, problems) => {
        const result = await smallSplit(`${statement}\n`, "", `${statement}\n`);

        expect(result.problems).toEqual(problems);
        expect(result.code).toBe(1);
      }
    );

    it("keeps a class whose base class is in another file of the split", async () => {
      const result = await smallSplit(
        "export class Plain {}\nclass Sub extends Plain {}\n",
        "export class Plain {}\n",
        'import { Plain } from "./a.ts";\nclass Sub extends Plain {}\n'
      );

      expect(result.problems).toEqual([
        "src/part.ts:2: only declarations that run nothing at load time may move; this is not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer: class Sub extends Plain { }",
      ]);
      expect(result.code).toBe(1);
    });

    it("keeps declarations of one name together", async () => {
      const result = await smallSplit(
        "export type Unit = number;\nexport const Unit = 1;\n",
        'export type Unit = number;\nexport { Unit } from "./part.ts";\n',
        "export const Unit = 1;\n"
      );

      expect(result.problems).toEqual([
        "src/a.ts: export Unit is exported more than once",
        "Unit is declared in src/a.ts and src/part.ts: declarations of one name stay together",
      ]);
      expect(result.code).toBe(1);
    });

    it("does not split a use server module", async () => {
      const result = await smallSplit(
        '"use server";\nexport async function act() {}\n',
        '"use server";\nexport { act } from "./part.ts";\n',
        "export async function act() {}\n"
      );

      expect(result.problems).toEqual([
        'src/a.ts is a "use server" module: its exports are server actions, so its code does not move',
      ]);
      expect(result.code).toBe(1);
    });

    it("moves a let with a side-effect-free initializer", async () => {
      const result = await smallSplit(
        "let seen = 0;\nexport function f() {\n  return seen;\n}\n",
        'export { f } from "./part.ts";\n',
        "let seen = 0;\nexport function f() {\n  return seen;\n}\n"
      );

      expect(result.problems).toEqual([]);
      expect(result.code).toBe(0);
    });

    it("splits a use client module", async () => {
      const result = await smallSplit(
        '"use client";\n"use strict";\nfunction f() {}\n',
        '"use client";\n"use strict";\n',
        "function f() {}\n"
      );

      expect(result.problems).toEqual([]);
      expect(result.code).toBe(0);
    });

    it("does not split code that calls eval", async () => {
      const result = await smallSplit(
        'const secret = 1;\nfunction peek() {\n  return eval("secret");\n}\n',
        "const secret = 1;\n",
        'function peek() {\n  return eval("secret");\n}\n'
      );

      expect(result.problems).toEqual([
        "src/part.ts:1: eval can name anything in its file, so a split cannot follow its names",
      ]);
      expect(result.code).toBe(1);
    });

    it.each([
      [
        "src/sub/part.ts",
        "src/sub/part.ts is not in the folder of src/a.ts: moved code stays in its folder",
      ],
      ...[
        "src/part.test.ts",
        "src/part.spec.tsx",
        "src/part.d.ts",
        "src/part.cts",
        "src/page.tsx",
        "src/route.ts",
        "src/layout.tsx",
      ].map((path) => [
        path,
        `${path} is not a plain .ts or .tsx file: tests, declaration files and route files are special to the tools`,
      ]),
    ])("refuses the new file %s", async (path, problem) => {
      const result = await prove({
        base: { "src/a.ts": "function f() {}\n", [BASELINE]: EMPTY_BASELINE },
        head: {
          "src/a.ts": "",
          [path]: "function f() {}\n",
          [BASELINE]: EMPTY_BASELINE,
        },
        files: {
          "small.json": JSON.stringify({ "src/a.ts": FULL, [path]: FULL }),
        },
        arguments_: [
          "--from=src/a.ts",
          `--to=${path}`,
          "--coverage-before=small.json",
          "--coverage-after=small.json",
        ],
        changed: ["src/a.ts", path],
      });

      expect(result.problems).toEqual([problem]);
      expect(result.code).toBe(1);
    });
  });

  it("refuses a split into a file that exists at the base", async () => {
    const result = await prove({ base: { "src/shape.ts": SPLIT_SHAPE } });

    expect(result.problems).toEqual([
      "src/shape.ts takes the name of src/shape.ts at main: a split moves code into new files with new names",
    ]);
    expect(result.code).toBe(1);
  });

  it("refuses a new file that takes the name of a file at the base", async () => {
    const result = await prove({ base: { "src/part/index.ts": "" } });

    expect(result.problems).toEqual([
      "src/part.ts takes the name of src/part at main: a split moves code into new files with new names",
    ]);
    expect(result.code).toBe(1);
  });

  it("refuses a base that is not an ancestor of HEAD", async () => {
    const result = await prove({ ancestor: false });

    expect(result.problems).toEqual(["main is not an ancestor of HEAD"]);
    expect(result.code).toBe(1);
  });

  it.each([
    [
      "a JSX pragma",
      "/** @jsxImportSource preact */\nfunction f() {}\n",
      "/** @jsxImportSource preact */\n",
      "function f() {}\n",
      [
        "src/a.ts has a JSX pragma or a triple-slash reference, which applies only to its own file",
      ],
    ],
    [
      "a triple-slash reference",
      '/// <reference types="vite/client" />\nfunction f() {}\n',
      '/// <reference types="vite/client" />\n',
      "function f() {}\n",
      [
        "src/a.ts has a JSX pragma or a triple-slash reference, which applies only to its own file",
      ],
    ],
    [
      "a @ts-nocheck in a new file",
      "// @ts-nocheck\nfunction f() {}\n",
      "// @ts-nocheck\n",
      "// @ts-nocheck\nfunction f() {}\n",
      ["src/part.ts turns type checking off with @ts-nocheck"],
    ],
    [
      "a directive that is no longer the first statement",
      '"use client";\nimport { useState } from "react";\nexport function Counter() {\n  return useState;\n}\nexport function helper() {\n  return 1;\n}\n',
      'import { useState } from "react";\nexport { helper } from "./part.ts";\n"use client";\nexport function Counter() {\n  return useState;\n}\n',
      "export function helper() {\n  return 1;\n}\n",
      [
        'src/a.ts: its directives were "use client" and are none after the split; they stay its first statements',
      ],
    ],
    [
      "an assignment to an import behind @ts-expect-error",
      "export let count = 0;\nexport function bump() {\n  count += 1;\n  return count;\n}\n",
      'export let count = 0;\nexport { bump } from "./part.ts";\n',
      'import { count } from "./a.ts";\nexport function bump() {\n  // @ts-expect-error\n  count += 1;\n  return count;\n}\n',
      ["src/part.ts:4: Cannot assign to 'count' because it is an import."],
    ],
    [
      "a second export of a name",
      "function keep() {\n  return 1;\n}\nexport { keep };\n",
      "export function keep() {\n  return 1;\n}\nexport { keep };\n",
      "",
      ["src/a.ts: export keep is exported more than once"],
    ],
    [
      "a value import of an ambient declaration",
      "export declare function native(): number;\nexport function f() {\n  return native();\n}\n",
      'export declare function native(): number;\nexport { f } from "./part.ts";\n',
      'import { native } from "./a.ts";\nexport function f() {\n  return native();\n}\n',
      [
        "src/part.ts:1: imports native from src/a.ts, which has no value at run time, without `type`",
      ],
    ],
    [
      "an upper-case @TS-NOCHECK in a new file",
      "function f() {}\n",
      "",
      "// @TS-NOCHECK\nfunction f() {}\n",
      ["src/part.ts turns type checking off with @ts-nocheck"],
    ],
    [
      "a new @ts-nocheck",
      "function f() {}\n",
      "",
      "// @ts-nocheck\nfunction f() {}\n",
      ["src/part.ts turns type checking off with @ts-nocheck"],
    ],
    [
      'a string changed from "@TS-ignore" to "@ts-ignore"',
      'export const s = "@TS-ignore";\nfunction f() {}\n',
      'export const s = "@ts-ignore";\n',
      "function f() {}\n",
      [
        'src/a.ts:1: statement is not in the original file (new or changed code): const s = "@ts-ignore" ;',
        'src/a.ts:1: statement of the original file is missing after the split: const s = "@TS-ignore" ;',
      ],
    ],
    [
      'a string changed from "@ts-ignore" to "@ts_ignore"',
      'export const s = "@ts-ignore";\nfunction f() {}\n',
      'export const s = "@ts_ignore";\n',
      "function f() {}\n",
      [
        'src/a.ts:1: statement is not in the original file (new or changed code): const s = "@ts_ignore" ;',
        'src/a.ts:1: statement of the original file is missing after the split: const s = "@ts-ignore" ;',
      ],
    ],
    [
      "a string changed from `@ts-nocheck` to `@ts_nocheck`",
      "export const s = `@ts-nocheck`;\nfunction f() {}\n",
      "export const s = `@ts_nocheck`;\n",
      "function f() {}\n",
      [
        "src/a.ts:1: statement is not in the original file (new or changed code): const s = `@ts_nocheck` ;",
        "src/a.ts:1: statement of the original file is missing after the split: const s = `@ts-nocheck` ;",
      ],
    ],
    [
      "a function moved away from the var of if",
      "if (c) {\n  var v = 1;\n}\nfunction f() {\n  return v;\n}\n",
      "if (c) {\n  var v = 1;\n}\n",
      "function f() {\n  return v;\n}\n",
      [
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: if ( c ) { var v = 1 ; }",
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: if ( c ) { var v = 1 ; }",
      ],
    ],
    [
      "a function moved away from the var of try",
      "try {\n  var v = 1;\n} catch {}\nfunction f() {\n  return v;\n}\n",
      "try {\n  var v = 1;\n} catch {}\n",
      "function f() {\n  return v;\n}\n",
      [
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: try { var v = 1 ; } catch { }",
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: try { var v = 1 ; } catch { }",
      ],
    ],
    [
      "a function moved away from the var of for",
      "for (var v = 0; v < 1; v++) {}\nfunction f() {\n  return v;\n}\n",
      "for (var v = 0; v < 1; v++) {}\n",
      "function f() {\n  return v;\n}\n",
      [
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: for ( var v = 0 ; v < 1 ; v ++ ) { }",
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: for ( var v = 0 ; v < 1 ; v ++ ) { }",
      ],
    ],
    [
      "a function moved away from the var of outer:",
      "outer: {\n  var v = 1;\n}\nfunction f() {\n  return v;\n}\n",
      "outer: {\n  var v = 1;\n}\n",
      "function f() {\n  return v;\n}\n",
      [
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: outer : { var v = 1 ; }",
        "src/a.ts:1: the proof refuses a var declared inside a top-level block or loop: outer : { var v = 1 ; }",
      ],
    ],
    [
      "a write of a moved let behind an upper-case @TS-NOCHECK",
      "// @TS-NOCHECK\nexport let x = 1;\nx = 2;\n",
      '// @TS-NOCHECK\nimport { x } from "./part.ts";\nexport { x } from "./part.ts";\nx = 2;\n',
      "export let x = 1;\n",
      ["src/a.ts:4: Cannot assign to 'x' because it is an import."],
    ],
    [
      "code that stays and writes a moved let with x++;",
      "export let x = 1;\nx++;\n",
      'import { x } from "./part.ts";\nexport { x } from "./part.ts";\nx++;\n',
      "export let x = 1;\n",
      ["src/a.ts:3: Cannot assign to 'x' because it is an import."],
    ],
    [
      "code that stays and writes a moved let with for (x of [2]) {}",
      "export let x = 1;\nfor (x of [2]) {}\n",
      'import { x } from "./part.ts";\nexport { x } from "./part.ts";\nfor (x of [2]) {}\n',
      "export let x = 1;\n",
      ["src/a.ts:3: Cannot assign to 'x' because it is an import."],
    ],
    [
      "code that stays and writes a moved let with [x] = [2];",
      "export let x = 1;\n[x] = [2];\n",
      'import { x } from "./part.ts";\nexport { x } from "./part.ts";\n[x] = [2];\n',
      "export let x = 1;\n",
      ["src/a.ts:3: Cannot assign to 'x' because it is an import."],
    ],
    [
      "an upper-case @JSX pragma",
      "/** @JSX h */\nfunction f() {}\n",
      "/** @JSX h */\n",
      "function f() {}\n",
      [
        "src/a.ts has a JSX pragma or a triple-slash reference, which applies only to its own file",
      ],
    ],
  ])("refuses %s", async (_case, original, kept, moved, problems) => {
    const result = await smallSplit(original, kept, moved);

    expect(result.problems).toEqual(problems);
    expect(result.code).toBe(1);
  });

  it("keeps a @ts-nocheck the original file had in the original file", async () => {
    const result = await smallSplit(
      "// @ts-nocheck\nfunction f() {}\n",
      "// @ts-nocheck\n",
      "function f() {}\n"
    );

    expect(result.problems).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("refuses changed coverage totals", async () => {
    const result = await prove({
      files: {
        "after.json": JSON.stringify({
          ...AFTER,
          "src/part.ts": coverage(
            [2, 3],
            [0, 0],
            [1, 2],
            [1, 4],
            [66.66, 100, 50, 25]
          ),
        }),
      },
    });

    expect(result.problems).toEqual([
      "lines: coverage was 6/10 and is 7/10 after the split",
      "statements: coverage was 6/10 and is 6/11 after the split",
      'scripts/ci/coverage-baseline.json: the entry of src/part.ts is {"lines":33.33,"branches":100,"functions":50,"statements":33.33} and must be {"lines":66.66,"branches":100,"functions":50,"statements":25}',
    ]);
    expect(result.code).toBe(1);
  });

  it("takes the exact path of a coverage summary over a suffix match", async () => {
    const result = await prove({
      files: {
        "after.json": JSON.stringify({
          "/elsewhere/src/part.ts": FULL,
          ...AFTER,
        }),
      },
    });

    expect(result.code).toBe(0);
  });

  describe("baseline", () => {
    const baseline = (
      files: Readonly<Record<string, unknown>>,
      comment = "ratchet"
    ) => ({
      [BASELINE]: JSON.stringify({ _comment: comment, files }),
    });

    it.each([
      [
        "another file's entry changed",
        baseline({
          ...AFTER_ENTRIES,
          "src/other.ts": { ...OTHER_ENTRY, lines: 0 },
        }),
        [
          'scripts/ci/coverage-baseline.json: the entry of src/other.ts is {"lines":0,"branches":2,"functions":3,"statements":4} and must be {"lines":1,"branches":2,"functions":3,"statements":4}',
        ],
      ],
      [
        "an entry above the printed values",
        baseline({
          ...AFTER_ENTRIES,
          "src/a.tsx": { ...AFTER_ENTRIES["src/a.tsx"], lines: 90 },
        }),
        [
          'scripts/ci/coverage-baseline.json: the entry of src/a.tsx is {"lines":90,"branches":50,"functions":100,"statements":83.33} and must be {"lines":83.33,"branches":50,"functions":100,"statements":83.33}',
        ],
      ],
      [
        "a missing entry",
        baseline({ ...AFTER_ENTRIES, "src/part.ts": undefined }),
        [
          'scripts/ci/coverage-baseline.json: the entry of src/part.ts is missing and must be {"lines":33.33,"branches":100,"functions":50,"statements":33.33}',
        ],
      ],
      [
        "an entry for a file at 100%",
        baseline({ ...AFTER_ENTRIES, "src/shape.ts": OTHER_ENTRY }),
        [
          'scripts/ci/coverage-baseline.json: the entry of src/shape.ts is {"lines":1,"branches":2,"functions":3,"statements":4} and must be missing',
        ],
      ],
      [
        "a changed comment",
        baseline(AFTER_ENTRIES, "no ratchet"),
        [
          "scripts/ci/coverage-baseline.json: changed outside the entries of the split files",
        ],
      ],
    ])("rejects %s", async (_case, head, problems) => {
      const result = await prove({ head });

      expect(result.problems).toEqual(problems);
      expect(result.code).toBe(1);
    });
  });

  it("refuses an exported expression", async () => {
    const result = await smallSplit(
      "const value = 1;\nexport default value;\n",
      'import { value } from "./part.ts";\nexport default value;\n',
      "export const value = 1;\n"
    );

    expect(result.problems).toEqual([
      "src/a.ts:2: the proof refuses an exported expression (export default of an expression, export =): export default value ;",
      "src/a.ts:2: the proof refuses an exported expression (export default of an expression, export =): export default value ;",
    ]);
    expect(result.code).toBe(1);
  });

  describe("stops", () => {
    it.each([
      ["--from", "--from is unexpectedly missing"],
      ["--to", "--to is unexpectedly missing"],
      ["--coverage-before", "--coverage-before is unexpectedly missing"],
      ["--coverage-after", "--coverage-after is unexpectedly missing"],
    ])("without %s", async (option, message) => {
      const arguments_ = ARGUMENTS.filter(
        (argument, position) =>
          argument !== option && ARGUMENTS[position - 1] !== option
      );

      const result = await prove({ arguments_ });

      expect(result.errors).toEqual([message, USAGE]);
      expect(result.output).toEqual([]);
      expect(result.code).toBe(2);
    });

    it.each([
      [
        "at an unknown option",
        { arguments_: [...ARGUMENTS, "--write"] },
        "Unknown option '--write'",
      ],
      [
        "when git finds no merge base",
        { mergeBase: undefined },
        `the merge base of HEAD and ${TARGET} is unexpectedly missing`,
      ],
      [
        "when git cannot list the changed files",
        { changed: undefined },
        "the files changed between main and HEAD is unexpectedly missing",
      ],
      [
        "when the original file is not at the base",
        { base: { "src/a.tsx": undefined } },
        "src/a.tsx at main is unexpectedly missing",
      ],
      [
        "when a new file is not committed",
        { head: { "src/view.tsx": undefined } },
        "src/view.tsx at HEAD is unexpectedly missing",
      ],
      [
        "when the original file is not in the coverage summary before the split",
        { files: { "before.json": JSON.stringify({ total: {} }) } },
        "src/a.tsx in the coverage summary before the split is unexpectedly missing",
      ],
      [
        "when a new file is not in the coverage summary after the split",
        {
          files: {
            "after.json": JSON.stringify({
              ...AFTER,
              "src/part.ts": undefined,
            }),
          },
        },
        "src/part.ts in the coverage summary after the split is unexpectedly missing",
      ],
      [
        "when a percentage does not match its counts",
        {
          files: {
            "after.json": JSON.stringify({
              ...AFTER,
              "src/part.ts": coverage(
                [1, 3],
                [0, 0],
                [1, 2],
                [1, 3],
                [33.33, 100, 100, 33.33]
              ),
            }),
          },
        },
        "src/part.ts in the coverage summary after the split: functions 1/2 is not 100%",
      ],
      [
        "when only an empty key could match",
        { files: { "before.json": JSON.stringify({ "": FULL }) } },
        "src/a.tsx in the coverage summary before the split is unexpectedly missing",
      ],
      [
        "when a path matches more than one file of a coverage summary",
        {
          files: {
            "after.json": JSON.stringify({
              ...AFTER,
              "/elsewhere/src/view.tsx": FULL,
            }),
          },
        },
        "src/view.tsx matches 2 files in the coverage summary after the split: /checkout/src/view.tsx, /elsewhere/src/view.tsx",
      ],
    ] as const)("%s", async (_case, run: Run, message) => {
      const result = await prove(run);

      expect(result.errors).toEqual([message, USAGE]);
      expect(result.code).toBe(2);
    });
  });
});
