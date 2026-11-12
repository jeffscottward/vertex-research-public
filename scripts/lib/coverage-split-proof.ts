import { posix } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript-api";
import { required } from "./required.ts";

// Proof for the pure-move split exception of the coverage ratchet (AGENTS.md
// rule 4; owner decision 2026-11-11). A file listed in
// scripts/ci/coverage-baseline.json may be split into new files when this
// command prints "Result: PROVED":
//
// 1. Statements: every top-level statement of the original file is in exactly
//    one file after the split, token for token and in its original order.
//    Comments and layout are not tokens. Three things may differ: import
//    declarations, an `export` added to a declaration, and re-exports of the
//    new files from the original file. Only declarations may move, so no
//    statement that runs at import time changes its place.
// 2. Exports: the original file exports the same names before and after.
// 3. Coverage: the covered and total lines, branches, functions and statements
//    of the original file equal the sums over the files after the split.
//
// The command also prints the baseline entries of the files after the split.

export type CoverageSplitProofDependencies = Readonly<{
  /** Output of `git <arguments>`, or undefined when git fails. */
  git: (arguments_: readonly string[]) => Promise<string | undefined>;
  readText: (path: string) => Promise<string>;
  output: (line: string) => void;
  error: (line: string) => void;
}>;

const USAGE =
  "Usage: bun scripts/coverage-split-proof.ts --base <git ref> --from <file> --to <new file> [--to <new file>...] --coverage-before <coverage-summary.json> --coverage-after <coverage-summary.json>";

// The key order of an entry in scripts/ci/coverage-baseline.json.
const METRICS = ["lines", "branches", "functions", "statements"] as const;
type Metric = (typeof METRICS)[number];
type Counts = Readonly<{ total: number; covered: number; pct: number }>;
type FileCoverage = Readonly<Record<Metric, Counts>>;
type CoverageSummary = Readonly<Record<string, FileCoverage>>;

type Statement = Readonly<{
  /** The tokens joined by one space, without an `export` modifier. */
  text: string;
  declaration: boolean;
  line: number;
}>;

type Module = Readonly<{
  path: string;
  statements: readonly Statement[];
  exports: readonly string[];
}>;

const NO_PARTS: ReadonlyMap<string, Module> = new Map();

const DECLARATIONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.VariableStatement,
]);

const tokensOf = (node: ts.Node, file: ts.SourceFile): string[] => {
  const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
  return children.length === 0
    ? [node.getText(file)]
    : children.flatMap((child) => tokensOf(child, file));
};

const hasModifier = (statement: ts.Statement, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);

const bindingNames = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? bindingNames(element.name) : []
      );

/** The names a statement exports. A star re-export is named by its source. */
const exportedNames = (
  statement: ts.Statement,
  file: ts.SourceFile
): string[] => {
  if (ts.isExportAssignment(statement)) return ["default"];
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause === undefined) {
      const source = required(statement.moduleSpecifier, "star export source");
      return [`* from ${source.getText(file)}`];
    }
    return ts.isNamedExports(clause)
      ? clause.elements.map((element) => element.name.text)
      : [clause.name.text];
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }
  const { name } = statement as ts.DeclarationStatement;
  return [required(name, "exported declaration name").getText(file)];
};

/** The new file that `statement` re-exports from `path`, if it is one. */
const reexportedPart = (
  statement: ts.Statement,
  path: string,
  parts: ReadonlyMap<string, Module>
): Module | undefined => {
  if (!(ts.isExportDeclaration(statement) && statement.moduleSpecifier)) {
    return undefined;
  }
  const source = (statement.moduleSpecifier as ts.StringLiteral).text;
  return parts.get(posix.join(posix.dirname(path), source));
};

/**
 * The compared statements and the exported names of one file. Import
 * declarations with bindings and re-exports of `parts` are not compared.
 */
const parseModule = (
  path: string,
  text: string,
  parts: ReadonlyMap<string, Module>
): Module => {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const statements: Statement[] = [];
  const exports: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) continue;
    const names = exportedNames(statement, file);
    const part = reexportedPart(statement, path, parts);
    if (part !== undefined) {
      const star =
        (statement as ts.ExportDeclaration).exportClause === undefined;
      exports.push(...(star ? part.exports : names));
      continue;
    }
    exports.push(...names);
    const tokens = tokensOf(statement, file);
    const exportIndex = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ? tokens.indexOf("export")
      : -1;
    statements.push({
      // An empty list (`()`, `{}`) is a leaf with no text.
      text: tokens
        .filter((token, index) => token !== "" && index !== exportIndex)
        .join(" "),
      declaration: DECLARATIONS.has(statement.kind),
      line:
        file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1,
    });
  }
  return { path, statements, exports };
};

const preview = (statement: Statement): string =>
  statement.text.length > 60
    ? `${statement.text.slice(0, 60)}...`
    : statement.text;

/**
 * Matches every statement after the split to one statement of the original
 * file, in order within each file. `files[0]` is the original file after the
 * split; the others are the new files.
 */
const matchStatements = (
  before: Module,
  files: readonly Module[]
): Readonly<{ problems: string[]; moved: number }> => {
  const problems: string[] = [];
  const used = new Set<number>();
  let moved = 0;
  for (const file of files) {
    let last = -1;
    for (const statement of file.statements) {
      const at = `${file.path}:${statement.line}`;
      const unused = (candidate: Statement, position: number): boolean =>
        !used.has(position) && candidate.text === statement.text;
      const index = before.statements.findIndex(
        (candidate, position) => position > last && unused(candidate, position)
      );
      if (index < 0) {
        // An earlier match means the statement only changed its place; it is
        // then not also reported as missing.
        const earlier = before.statements.findIndex(unused);
        used.add(earlier);
        const reason =
          earlier < 0
            ? "is not in the original file (new or changed code)"
            : "is out of its original order";
        problems.push(`${at}: statement ${reason}: ${preview(statement)}`);
        continue;
      }
      used.add(index);
      last = index;
      if (file === files[0]) continue;
      moved += 1;
      if (!statement.declaration) {
        problems.push(
          `${at}: only declarations may move; this statement runs at import time: ${preview(statement)}`
        );
      }
    }
  }
  for (const [index, statement] of before.statements.entries()) {
    if (used.has(index)) continue;
    problems.push(
      `${before.path}:${statement.line}: statement of the original file is missing after the split: ${preview(statement)}`
    );
  }
  return { problems, moved };
};

const exportProblems = (before: Module, after: Module): string[] => {
  const missing = before.exports.filter(
    (name) => !after.exports.includes(name)
  );
  const added = after.exports.filter((name) => !before.exports.includes(name));
  return [
    ...missing.map(
      (name) => `${after.path}: export ${name} is missing after the split`
    ),
    ...added.map(
      (name) => `${after.path}: export ${name} is new after the split`
    ),
  ];
};

const measured = (
  summary: CoverageSummary,
  path: string,
  when: "before" | "after"
): FileCoverage => {
  const key = Object.keys(summary).find(
    (candidate) => candidate === path || candidate.endsWith(`/${path}`)
  );
  return required(
    key === undefined ? undefined : summary[key],
    `${path} in the coverage summary ${when} the split`
  );
};

const baselineEntry = (path: string, coverage: FileCoverage): string => {
  if (METRICS.every((metric) => coverage[metric].pct === 100)) {
    return `  ${path}: 100% on all four measures, no entry`;
  }
  const minimums = METRICS.map(
    (metric) => `"${metric}": ${coverage[metric].pct}`
  ).join(", ");
  return `  "${path}": { ${minimums} }`;
};

type Options = Readonly<{
  base: string;
  from: string;
  to: readonly string[];
  coverageBefore: string;
  coverageAfter: string;
}>;

const parseOptions = (arguments_: readonly string[]): Options => {
  const { values } = parseArgs({
    args: [...arguments_],
    options: {
      base: { type: "string" },
      from: { type: "string" },
      to: { type: "string", multiple: true },
      "coverage-before": { type: "string" },
      "coverage-after": { type: "string" },
    },
    strict: true,
  });
  return {
    base: required(values.base, "--base"),
    from: posix.normalize(required(values.from, "--from")),
    to: required(values.to, "--to").map((path) => posix.normalize(path)),
    coverageBefore: required(values["coverage-before"], "--coverage-before"),
    coverageAfter: required(values["coverage-after"], "--coverage-after"),
  };
};

const prove = async (
  options: Options,
  dependencies: CoverageSplitProofDependencies
): Promise<number> => {
  const { base, from, to } = options;
  const { git, output, readText } = dependencies;
  const original = required(
    await git(["show", `${base}:${from}`]),
    `${from} at ${base}`
  );
  const problems: string[] = [];
  const parts = new Map<string, Module>();
  for (const path of to) {
    if ((await git(["show", `${base}:${path}`])) !== undefined) {
      problems.push(
        `${path} exists at ${base}: a split moves code into new files only`
      );
    }
    parts.set(path, parseModule(path, await readText(path), NO_PARTS));
  }
  const before = parseModule(from, original, NO_PARTS);
  const after = parseModule(from, await readText(from), parts);
  const files = [after, ...parts.values()];

  output(`Pure-move split of ${from} into ${to.join(", ")} (base ${base})`);
  const matched = matchStatements(before, files);
  problems.push(...matched.problems, ...exportProblems(before, after));
  const total = before.statements.length;
  output(
    `Statements: ${total} in the original file; ${matched.moved} in the new files.`
  );
  output(
    `Exports of ${from}: ${before.exports.length} before, ${after.exports.length} after.`
  );

  const summaryBefore = JSON.parse(
    await readText(options.coverageBefore)
  ) as CoverageSummary;
  const summaryAfter = JSON.parse(
    await readText(options.coverageAfter)
  ) as CoverageSummary;
  const coverageBefore = measured(summaryBefore, from, "before");
  const coverageAfter = files.map((file) =>
    measured(summaryAfter, file.path, "after")
  );
  output("Coverage, covered/total before and after:");
  for (const metric of METRICS) {
    const sum = (field: "covered" | "total"): number =>
      coverageAfter.reduce((value, file) => value + file[metric][field], 0);
    const was = `${coverageBefore[metric].covered}/${coverageBefore[metric].total}`;
    const now = `${sum("covered")}/${sum("total")}`;
    output(`  ${metric}: ${was} and ${now}`);
    if (was !== now) {
      problems.push(
        `${metric}: coverage was ${was} and is ${now} after the split`
      );
    }
  }
  output(
    "Baseline entries after the split (scripts/ci/coverage-baseline.json):"
  );
  for (const [index, file] of files.entries()) {
    output(baselineEntry(file.path, coverageAfter[index] as FileCoverage));
  }

  if (problems.length === 0) {
    output("Result: PROVED");
    return 0;
  }
  output("Problems:");
  for (const problem of problems) output(`  - ${problem}`);
  output(`Result: NOT PROVED (${problems.length})`);
  return 1;
};

/** `bun scripts/coverage-split-proof.ts --base <ref> --from <file> --to <new file>... --coverage-before <json> --coverage-after <json>` */
export const runCoverageSplitProof = async (
  arguments_: readonly string[],
  dependencies: CoverageSplitProofDependencies
): Promise<number> => {
  try {
    return await prove(parseOptions(arguments_), dependencies);
  } catch (error) {
    dependencies.error((error as Error).message);
    dependencies.error(USAGE);
    return 2;
  }
};
