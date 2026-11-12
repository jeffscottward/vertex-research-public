import { posix } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript-api";
import { required } from "./required.ts";

// Proof for the pure-move split exception of the coverage ratchet (AGENTS.md
// rule 4, ADR-017; owner decision 2026-11-11). A file listed in
// scripts/ci/coverage-baseline.json may be split into new files in its own
// folder when this command prints "Result: PROVED". The base is the merge base
// of HEAD and the target branch unless --base names another commit, and must
// be an ancestor of HEAD. The files after the split are read from HEAD.
//
// 1. Diff: the commits since the base change only the original file, the new
//    files and the baseline. The new files are plain .ts or .tsx files (no
//    test, declaration or route file) whose names no file or folder at the
//    base has, even without the extension. So no other file imports a new
//    file: the new files load through the original file.
// 2. Statements: every top-level statement of the original file is in exactly
//    one file after the split, token for token, with the same syntax tree and
//    in its original order. Comments and layout are not tokens. An `export`
//    may be added to a declaration; imports (rule 4) and the original file's
//    re-exports of the new files (rule 5) are checked on their own. The proof
//    fails closed: it refuses, naming the statement, `export *`, destructuring
//    declarations, exported expressions (`export default <expression>`,
//    `export =`), `import defer` and a `var` declared inside a top-level
//    block or loop (module-scoped, yet no top-level name) in any file of the
//    split. Only statements
//    that run no code at load time move: function declarations, interfaces,
//    type aliases, and `const` or `let` declarations whose initializers are
//    literals, functions, or arrays and objects of those (`as const` and
//    `satisfies` allowed). Classes, `var`, enums, ambient (`declare`)
//    declarations and all other statements stay. Moved code does not name its
//    own file (`import.meta` other than `import.meta.dirname`, `__filename`, `module`,
//    `exports`);
//    what depends only on the folder (`__dirname`, relative `require` and
//    `import()`) keeps its meaning in the same folder. All declarations of one
//    name stay together. The directives (such as "use client") stay the first
//    statements of the original file. A "use server" module and a file with a
//    JSX pragma or a triple-slash reference do not split, and a new file does
//    not add `@ts-nocheck`.
// 3. Names: every identifier that named an import or a top-level declaration
//    of the original file names the same import or declaration after the
//    split, never a global. Code that calls `eval` does not split. A
//    type-only import is not used as a value or exported without `type`, and
//    an import is not assigned; TypeScript comment directives (ts-ignore,
//    ts-expect-error, ts-nocheck) do not hide these errors. Not checked: code
//    that stays and reads a moved `const` or `let` at load time before its
//    declaration. The original throws a ReferenceError at load (temporal dead
//    zone); after the split the import is already initialized, so the split
//    only turns a failing load into a successful one.
// 4. Imports: every imported name is imported under the same name from the
//    same module (relative specifiers resolved from each file's folder) as in
//    the original file, and not as a value where the original imported it as
//    a type; or it is a declaration that the file of the split it is imported
//    from declares and exports, imported under its name, with `type` when it
//    has no value. No aliases, no new module, and no default or namespace
//    import of a file of the split. The modules other than the files of the
//    split load in the same order as before: the new files run nothing, so
//    their place does not count. The import of the automatic JSX runtime is
//    not counted.
// 5. Exports: the original file exports the same names, each resolves to the
//    same declaration, import or re-export, and each name is exported once
//    (merged declarations of one name aside). Its re-exports of the new files
//    name each name, do not rename, and carry `type` exactly for names
//    without a value.
// 6. Coverage: each percentage of a coverage summary matches its counts, and
//    the covered and total lines, branches, functions and statements of the
//    original file equal the sums over the files after the split. The
//    baseline entries of the files after the split are the values the command
//    prints, and every other part of the baseline is unchanged.
//
// The coverage summaries are supplied by the caller; the reviewer reruns the
// command with summaries from their own `bun run verify:coverage` runs.
// Comments are not compared, so the reviewer also checks moved comments that
// tools read (bundler hints such as `@vite-ignore`), and that no code finds a
// new file by a name built at run time (a computed `import()`, a folder read).

export type CoverageSplitProofDependencies = Readonly<{
  /** Output of `git <arguments>`, or undefined when git fails. */
  git: (arguments_: readonly string[]) => Promise<string | undefined>;
  readText: (path: string) => Promise<string>;
  output: (line: string) => void;
  error: (line: string) => void;
}>;

const USAGE =
  "Usage: bun scripts/coverage-split-proof.ts [--base <git ref>] --from <file> --to <new file> [--to <new file>...] --coverage-before <coverage-summary.json> --coverage-after <coverage-summary.json>";

const TARGET_BRANCH = "origin/vertex/rebuild-darkfactory-20260921";
const BASELINE = "scripts/ci/coverage-baseline.json";

// The key order of an entry in scripts/ci/coverage-baseline.json.
const METRICS = ["lines", "branches", "functions", "statements"] as const;
type Metric = (typeof METRICS)[number];
type Counts = Readonly<{ total: number; covered: number; pct: number }>;
type FileCoverage = Readonly<Record<Metric, Counts>>;
type CoverageSummary = Readonly<Record<string, FileCoverage>>;
type Baseline = Readonly<{ files: Readonly<Record<string, unknown>> }>;

type Statement = Readonly<{
  node: ts.Statement;
  /** The tokens joined by one space, without an `export` modifier. */
  text: string;
  /** The syntax kinds in tree order: the same tokens can parse differently. */
  shape: string;
  /** The identifiers in tree order, which the shape aligns between files. */
  identifiers: readonly ts.Identifier[];
  /** The top-level names the statement declares. */
  names: readonly string[];
  line: number;
}>;

type ImportBinding = Readonly<{
  /** `default`, `*` or the imported name. */
  imported: string;
  local: string;
  /** The resolved specifier and the import attributes. */
  module: string;
  phase: "type" | "value";
  renamed: boolean;
  line: number;
}>;

type Module = Readonly<{
  path: string;
  /** The text as committed; `file` hides comment directives from the checker. */
  text: string;
  file: ts.SourceFile;
  checker: ts.TypeChecker;
  /** The compared statements: all but imports and re-exports of new files. */
  statements: readonly Statement[];
  imports: readonly ImportBinding[];
  /**
   * The modules the file loads, in order: imports and re-exports that are not
   * type-only (`verbatimModuleSyntax` keeps the rest), deferred ones marked.
   */
  requests: readonly string[];
  /** Type errors that a split can cause and the proof does not see. */
  typeErrors: () => string[];
}>;

/** What each exported name resolves to. */
type Exports = ReadonlyMap<string, string>;

type Pair = Readonly<{ before: Statement; after: Statement; module: Module }>;

/** One split: the original file at the base, and the files after it. */
type Split = Readonly<{
  before: Module;
  /** The original file first, then the new files. */
  after: readonly Module[];
  paths: ReadonlySet<string>;
}>;

const NO_PARTS: ReadonlySet<string> = new Set();

// Names that differ per file in CommonJS (`require.main === module`).
const OWN_FILE_NAMES = new Set(["__filename", "module", "exports"]);

// Names that the test runners, TypeScript or the app router act on: tests,
// declaration files and Next.js / vinext route and metadata files.
const SPECIAL_NAME =
  /(?:\.(?:test|spec|d)\.[cm]?[jt]sx?|^(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|middleware|proxy|instrumentation|instrumentation-client|icon|apple-icon|opengraph-image|twitter-image|sitemap|robots|manifest)\.[cm]?[jt]sx?)$/u;

// Only the names of one file are resolved: no library, no other file. The
// module options are the repo's (tsconfig.base.json).
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  types: [],
  moduleDetection: ts.ModuleDetectionKind.Force,
  module: ts.ModuleKind.ESNext,
  isolatedModules: true,
  verbatimModuleSyntax: true,
};

// A type-only import (1361) or export (1362) used as a value, and an
// assignment to an import (2632): a moved `let` written by code that stays.
const TYPE_ERRORS = new Set([1361, 1362, 2632]);

const MOVABLE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

// `const` and `let`; `var` and `using` stay.
const BINDINGS = new Set<number>([ts.NodeFlags.Const, ts.NodeFlags.Let]);

const SIDE_EFFECT_FREE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
]);

const OBJECT_METHODS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

const IMPORT_DECLARATIONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
]);

// The committed text of each parsed file: the parser sees comment directives
// renamed (parseModule), but tokens are compared as committed. The rename
// keeps every position.
const COMMITTED_TEXT = new WeakMap<ts.SourceFile, string>();

const tokensOf = (node: ts.Node, file: ts.SourceFile): string[] => {
  const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
  return children.length === 0
    ? [
        required(COMMITTED_TEXT.get(file), `text of ${file.fileName}`).slice(
          node.getStart(file),
          node.end
        ),
      ]
    : children.flatMap((child) => tokensOf(child, file));
};

const hasModifier = (statement: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);

const lineOf = (node: ts.Node, file: ts.SourceFile): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/** The top-level names a statement declares; destructuring is refused. */
const declaredNames = (statement: ts.Statement): string[] => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) =>
      declaration.name.getText()
    );
  }
  const { name } = statement as ts.DeclarationStatement;
  if (name !== undefined) return [name.text];
  return hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ? ["default"]
    : [];
};

/** The module an import or re-export loads, with its import attributes. */
const moduleOf = (
  path: string,
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
  file: ts.SourceFile
): string => {
  const { text } = statement.moduleSpecifier as ts.StringLiteral;
  const resolved = text.startsWith(".")
    ? posix.join(posix.dirname(path), text)
    : text;
  return statement.attributes === undefined
    ? resolved
    : `${resolved} ${tokensOf(statement.attributes, file).join(" ")}`;
};

const importBindings = (
  clause: ts.ImportClause,
  module: string,
  line: number
): ImportBinding[] => {
  const binding = (
    imported: string,
    local: string,
    element?: ts.ImportSpecifier
  ): ImportBinding => ({
    imported,
    local,
    module,
    phase:
      element?.isTypeOnly === true ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword
        ? "type"
        : "value",
    renamed: element?.propertyName !== undefined,
    line,
  });
  const { name, namedBindings } = clause;
  const bindings = name === undefined ? [] : [binding("default", name.text)];
  if (namedBindings === undefined) return bindings;
  if (ts.isNamespaceImport(namedBindings)) {
    return [...bindings, binding("*", namedBindings.name.text)];
  }
  return [
    ...bindings,
    ...namedBindings.elements.map((element) =>
      binding(
        (element.propertyName ?? element.name).text,
        element.name.text,
        element
      )
    ),
  ];
};

const statementOf = (
  statement: ts.Statement,
  file: ts.SourceFile
): Statement => {
  const tokens = tokensOf(statement, file);
  const exportIndex = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ? tokens.indexOf("export")
    : -1;
  const kinds: ts.SyntaxKind[] = [];
  const identifiers: ts.Identifier[] = [];
  const walk = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ExportKeyword) return;
    kinds.push(node.kind);
    if (ts.isIdentifier(node)) identifiers.push(node);
    ts.forEachChild(node, walk);
  };
  walk(statement);
  return {
    node: statement,
    // An empty list (`()`, `{}`) is a leaf with no text.
    text: tokens
      .filter((token, index) => token !== "" && index !== exportIndex)
      .join(" "),
    shape: kinds.join(","),
    identifiers,
    names: declaredNames(statement),
    line: lineOf(statement, file),
  };
};

/** The module a top-level statement loads, if it loads one. */
const requestOf = (
  statement: ts.Statement,
  path: string,
  file: ts.SourceFile
): string | undefined => {
  if (ts.isImportDeclaration(statement)) {
    return statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      ? undefined
      : moduleOf(path, statement, file);
  }
  return ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    !statement.isTypeOnly
    ? moduleOf(path, statement, file)
    : undefined;
};

/**
 * Parses one file and binds its names. Imports with bindings and re-exports
 * of `parts` are not compared statements.
 */
const parseModule = (
  path: string,
  text: string,
  parts: ReadonlySet<string>
): Module => {
  // Comment directives would hide the type errors the proof looks for; the
  // same-length rename keeps every position.
  const file = ts.createSourceFile(
    `/${path}`,
    text.replace(/@ts-(?=ignore|expect-error|nocheck)/giu, "@ts_"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  COMMITTED_TEXT.set(file, text);
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const program = ts.createProgram({
    rootNames: [file.fileName],
    options: COMPILER_OPTIONS,
    host: { ...host, getSourceFile: () => file },
  });
  const statements: Statement[] = [];
  const imports: ImportBinding[] = [];
  const requests: string[] = [];
  for (const statement of file.statements) {
    const request = requestOf(statement, path, file);
    if (request !== undefined) requests.push(request);
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      imports.push(
        ...importBindings(
          statement.importClause,
          moduleOf(path, statement, file),
          lineOf(statement, file)
        )
      );
    } else if (
      !(
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        parts.has(moduleOf(path, statement, file))
      )
    ) {
      statements.push(statementOf(statement, file));
    }
  }
  const typeErrors = () =>
    program
      .getSemanticDiagnostics(file)
      .filter(({ code }) => TYPE_ERRORS.has(code))
      .map(
        (diagnostic) =>
          `${path}:${file.getLineAndCharacterOfPosition(diagnostic.start as number).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
      );
  return {
    path,
    text,
    file,
    checker: program.getTypeChecker(),
    statements,
    imports,
    requests,
    typeErrors,
  };
};

/**
 * What `identifier` names at the top level of its file, or undefined for
 * anything else (a local, a property, a global). A declaration of a file of
 * the split is named the same whether it is declared or imported.
 */
const bindingOf = (
  module: Module,
  identifier: ts.Identifier,
  paths: ReadonlySet<string>
): string | undefined => {
  const { checker } = module;
  const { parent } = identifier;
  let symbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
    symbol = checker.getShorthandAssignmentValueSymbol(parent);
  } else if (
    ts.isExportSpecifier(parent) &&
    parent.parent.parent.moduleSpecifier === undefined &&
    (parent.propertyName ?? parent.name) === identifier
  ) {
    symbol = checker.getExportSpecifierLocalTargetSymbol(parent);
  } else {
    symbol = checker.getSymbolAtLocation(identifier);
  }
  const declaration = symbol?.declarations?.[0];
  if (declaration === undefined) return undefined;
  if (IMPORT_DECLARATIONS.has(declaration.kind)) {
    const binding = required(
      module.imports.find(({ local }) => local === identifier.text),
      `import of ${identifier.text}`
    );
    return paths.has(binding.module)
      ? `declaration ${binding.imported}`
      : `${binding.imported} from ${binding.module}`;
  }
  const statement = ts.isVariableDeclaration(declaration)
    ? declaration.parent.parent
    : declaration;
  const topLevel =
    ts.isSourceFile(statement.parent) &&
    (statement === declaration || ts.isVariableStatement(statement));
  return topLevel ? `declaration ${identifier.text}` : undefined;
};

const preview = (statement: Statement): string =>
  statement.text.length > 60
    ? `${statement.text.slice(0, 60)}...`
    : statement.text;

/**
 * Matches every compared statement after the split to one statement of the
 * original file, in order within each file.
 */
const matchStatements = (
  split: Split
): Readonly<{ problems: string[]; pairs: Pair[] }> => {
  const { before } = split;
  const problems: string[] = [];
  const pairs: Pair[] = [];
  const used = new Set<number>();
  for (const module of split.after) {
    let last = -1;
    for (const statement of module.statements) {
      const unused = (candidate: Statement, position: number): boolean =>
        !used.has(position) &&
        candidate.text === statement.text &&
        candidate.shape === statement.shape;
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
        problems.push(
          `${module.path}:${statement.line}: statement ${reason}: ${preview(statement)}`
        );
        continue;
      }
      used.add(index);
      last = index;
      pairs.push({
        before: before.statements[index] as Statement,
        after: statement,
        module,
      });
    }
  }
  for (const [index, statement] of before.statements.entries()) {
    if (used.has(index)) continue;
    problems.push(
      `${before.path}:${statement.line}: statement of the original file is missing after the split: ${preview(statement)}`
    );
  }
  return { problems, pairs };
};

/** True when evaluating `expression` runs no code and reads no binding. */
const sideEffectFree = (expression: ts.Expression): boolean => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return sideEffectFree(expression.expression);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every(
      (element) => ts.isOmittedExpression(element) || sideEffectFree(element)
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every((property) => {
      if (
        property.name !== undefined &&
        ts.isComputedPropertyName(property.name)
      ) {
        return false;
      }
      return ts.isPropertyAssignment(property)
        ? sideEffectFree(property.initializer)
        : OBJECT_METHODS.has(property.kind);
    });
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      expression.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(expression.operand)
    );
  }
  return SIDE_EFFECT_FREE.has(expression.kind);
};

/**
 * `import.meta` (but `import.meta.dirname`), `__filename`, `module` or
 * `exports`.
 */
const namesOwnFile = (node: ts.Node): boolean => {
  if (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword
  ) {
    const { parent } = node;
    return !(
      ts.isPropertyAccessExpression(parent) && parent.name.text === "dirname"
    );
  }
  if (ts.isIdentifier(node) && OWN_FILE_NAMES.has(node.text)) return true;
  return (
    ts.forEachChild(node, (child) => namesOwnFile(child) || undefined) === true
  );
};

/** Why a statement may not move into a new file, if it may not. */
const moveProblem = (statement: ts.Statement): string | undefined => {
  if (namesOwnFile(statement)) {
    return "code that names its own file (import.meta, __filename, module, exports)";
  }
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
    return "an ambient declaration (declare), which has no value at run time";
  }
  if (MOVABLE.has(statement.kind)) return undefined;
  if (
    ts.isVariableStatement(statement) &&
    BINDINGS.has(statement.declarationList.flags & ts.NodeFlags.BlockScoped) &&
    statement.declarationList.declarations.every(
      ({ initializer }) =>
        initializer !== undefined && sideEffectFree(initializer)
    )
  ) {
    return undefined;
  }
  return "not a function declaration, a type-only declaration, or a const or let with a side-effect-free initializer";
};

const moveProblems = (pairs: readonly Pair[], split: Split): string[] =>
  pairs.flatMap(({ after, module }) => {
    if (module === split.after[0]) return [];
    const problem = moveProblem(after.node);
    return problem === undefined
      ? []
      : [
          `${module.path}:${after.line}: only declarations that run nothing at load time may move; this is ${problem}: ${preview(after)}`,
        ];
  });

/** Where each top-level name is declared after the split. */
const placements = (split: Split): Map<string, string[]> => {
  const declared = new Map<string, string[]>();
  for (const module of split.after) {
    for (const statement of module.statements) {
      for (const name of statement.names) {
        const paths = declared.get(name) ?? [];
        if (!paths.includes(module.path)) paths.push(module.path);
        declared.set(name, paths);
      }
    }
  }
  return declared;
};

/** What the files after the split declare and export. */
type Index = Readonly<{
  /** The files that declare each top-level name. */
  declared: ReadonlyMap<string, readonly string[]>;
  exports: ReadonlyMap<string, Exports>;
  /** Names declared only by interfaces and type aliases, per file. */
  types: ReadonlyMap<string, ReadonlySet<string>>;
}>;

const splitImportProblem = (
  binding: ImportBinding,
  index: Index
): string | undefined => {
  const { imported, local, module } = binding;
  if (imported !== local || index.declared.get(local)?.[0] !== module) {
    return `imports ${imported} from ${module}, which is not a declaration of that file imported by its name`;
  }
  if (
    (index.exports.get(module) as Exports).get(local) !== `declaration ${local}`
  ) {
    return `imports ${local} from ${module}, which does not export it`;
  }
  if (
    binding.phase !== "type" &&
    (index.types.get(module) as ReadonlySet<string>).has(local)
  ) {
    return `imports ${local} from ${module}, which has no value at run time, without \`type\``;
  }
  return undefined;
};

const importProblem = (
  binding: ImportBinding,
  split: Split,
  index: Index
): string | undefined => {
  const { imported, local, module } = binding;
  if (binding.renamed) {
    return `imports ${imported} as ${local}; aliases are not allowed`;
  }
  if (split.paths.has(module)) return splitImportProblem(binding, index);
  const same = split.before.imports.some(
    (original) =>
      original.module === module &&
      original.imported === imported &&
      original.local === local &&
      (binding.phase === "type" || binding.phase === original.phase)
  );
  return same
    ? undefined
    : `imports ${imported} from ${module} (${binding.phase}), which the original file does not import that way`;
};

const importProblems = (split: Split, index: Index): string[] =>
  split.after.flatMap((module) =>
    module.imports.flatMap((binding) => {
      const problem = importProblem(binding, split, index);
      return problem === undefined
        ? []
        : [`${module.path}:${binding.line}: ${problem}`];
    })
  );

/**
 * The original file loads its modules in source order. After the split the
 * original file and the new files it reaches load theirs depth first; the
 * new files run nothing, so only the order of the other modules counts.
 */
const loadOrderProblems = (split: Split): string[] => {
  const before = [...new Set(split.before.requests)];
  const after: string[] = [];
  const visited = new Set<string>();
  const visit = (module: Module): void => {
    visited.add(module.path);
    for (const request of module.requests) {
      const next = split.after.find(({ path }) => path === request);
      if (next === undefined) {
        if (!after.includes(request)) after.push(request);
      } else if (!visited.has(next.path)) {
        visit(next);
      }
    }
  };
  visit(split.after[0] as Module);
  const list = (modules: readonly string[]): string =>
    modules.length === 0 ? "no module" : modules.join(", ");
  return list(before) === list(after)
    ? []
    : [
        `${split.before.path}: loads ${list(before)} before the split and ${list(after)} after it; what loads and its order stay the same`,
      ];
};

const describeBinding = (binding: string | undefined): string =>
  binding ?? "no import or top-level declaration";

const bindingProblems = (pairs: readonly Pair[], split: Split): string[] =>
  pairs.flatMap(({ before, after, module }) =>
    before.identifiers.flatMap((identifier, index) => {
      if (identifier.text === "eval") {
        return [
          `${module.path}:${after.line}: eval can name anything in its file, so a split cannot follow its names`,
        ];
      }
      const was = bindingOf(split.before, identifier, NO_PARTS);
      const is = bindingOf(
        module,
        after.identifiers[index] as ts.Identifier,
        split.paths
      );
      return was === is
        ? []
        : [
            `${module.path}:${after.line}: ${identifier.text} names ${describeBinding(was)} in the original file and ${describeBinding(is)} after the split`,
          ];
    })
  );

/**
 * True when `node` declares a `var` of its function scope: one that is not
 * inside a nested function, class static block or namespace.
 */
const declaresVar = (node: ts.Node): boolean => {
  if (
    ts.isVariableDeclarationList(node) &&
    (node.flags & ts.NodeFlags.BlockScoped) === 0
  ) {
    return true;
  }
  if (
    ts.isFunctionLike(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isModuleBlock(node)
  ) {
    return false;
  }
  return (
    ts.forEachChild(node, (child) => declaresVar(child) || undefined) === true
  );
};

/** Statements the proof refuses in any file of the split. */
const refusal = (statement: ts.Statement): string | undefined => {
  // Such a `var` is module-scoped, but no name of the statement: code moved
  // away from it would read a global.
  if (!ts.isVariableStatement(statement) && declaresVar(statement)) {
    return "a var declared inside a top-level block or loop";
  }
  if (
    ts.isExportDeclaration(statement) &&
    (statement.exportClause === undefined ||
      ts.isNamespaceExport(statement.exportClause))
  ) {
    return "export *";
  }
  if (ts.isExportAssignment(statement)) {
    return "an exported expression (export default of an expression, export =)";
  }
  if (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      ({ name }) => !ts.isIdentifier(name)
    )
  ) {
    return "a destructuring declaration";
  }
  return ts.isImportDeclaration(statement) &&
    statement.importClause?.phaseModifier === ts.SyntaxKind.DeferKeyword
    ? "import defer"
    : undefined;
};

const refusals = (split: Split): string[] =>
  [split.before, ...split.after].flatMap(({ path, file }) =>
    file.statements.flatMap((statement) => {
      const refused = refusal(statement);
      return refused === undefined
        ? []
        : [
            `${path}:${lineOf(statement, file)}: the proof refuses ${refused}: ${preview(statementOf(statement, file))}`,
          ];
    })
  );

/** The directive prologue: the strings before any other statement. */
const prologue = (module: Module): string => {
  const directives: string[] = [];
  for (const statement of module.file.statements) {
    if (
      !(
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression)
      )
    ) {
      break;
    }
    directives.push(JSON.stringify(statement.expression.text));
  }
  return directives.length === 0 ? "none" : directives.join(", ");
};

/**
 * File-wide settings that do not follow moved code. The directives (such as
 * "use client") stay the first statements of the original file; a
 * "use server" module does not split, because every export of it is a server
 * action and a re-export may not be. JSX pragmas and triple-slash references
 * apply to one file, and `@ts-nocheck` turns type checking off for one.
 */
const directiveProblems = (split: Split): string[] => {
  const { before } = split;
  const [original, ...newFiles] = split.after as [Module, ...Module[]];
  const problems: string[] = [];
  const directives = prologue(before);
  if (directives.includes('"use server"')) {
    problems.push(
      `${before.path} is a "use server" module: its exports are server actions, so its code does not move`
    );
  }
  if (prologue(original) !== directives) {
    problems.push(
      `${original.path}: its directives were ${directives} and are ${prologue(original)} after the split; they stay its first statements`
    );
  }
  const fileWide = [before, ...split.after].find(({ text }) =>
    /@jsx\w*\s|\/\/\/\s*<reference/iu.test(text)
  );
  if (fileWide !== undefined) {
    problems.push(
      `${fileWide.path} has a JSX pragma or a triple-slash reference, which applies only to its own file`
    );
  }
  const nocheck = [
    ...newFiles,
    ...(/@ts-nocheck/iu.test(before.text) ? [] : [original]),
  ].filter(({ text }) => /@ts-nocheck/iu.test(text));
  for (const module of nocheck) {
    problems.push(`${module.path} turns type checking off with @ts-nocheck`);
  }
  return problems;
};

/**
 * Names that have no value at run time: declared only by interfaces, type
 * aliases and ambient (`declare`) declarations.
 */
const typeNames = (module: Module): Set<string> => {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const { node, names } of module.statements) {
    const target =
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      hasModifier(node, ts.SyntaxKind.DeclareKeyword)
        ? types
        : values;
    for (const name of names) target.add(name);
  }
  return new Set([...types].filter((name) => !values.has(name)));
};

type Part = Readonly<{ exports: Exports; types: ReadonlySet<string> }>;

/** One exported name, what it resolves to, and where it is named. */
type ExportEntry = readonly [name: string, target: string, node: ts.Node];

/**
 * The original file's re-export of a new file: by name, no rename, and with
 * `type` exactly for names without a value.
 */
const partExports = (
  module: Module,
  statement: ts.ExportDeclaration,
  clause: ts.NamedExports,
  part: Readonly<{ source: string } & Part>,
  problems: string[]
): ExportEntry[] =>
  clause.elements.flatMap((element): ExportEntry[] => {
    const { source } = part;
    const name = element.name.text;
    const target = part.exports.get(name);
    const typeOnly = statement.isTypeOnly || element.isTypeOnly;
    let problem: string | undefined;
    if (element.propertyName !== undefined) {
      problem = `renames ${element.propertyName.text} of ${source} to ${name}`;
    } else if (target === undefined) {
      problem = `re-exports ${name}, which ${source} does not export`;
    } else if (typeOnly !== part.types.has(name)) {
      problem = typeOnly
        ? `re-exports the value ${name} of ${source} as a type`
        : `re-exports ${name} of ${source}, which has no value at run time, without \`type\``;
    }
    if (problem === undefined) return [[name, target as string, element]];
    problems.push(`${module.path}:${lineOf(element, module.file)}: ${problem}`);
    return [];
  });

/** The exports of an export declaration that does not re-export a new file. */
const declarationExports = (
  module: Module,
  statement: ts.ExportDeclaration,
  clause: ts.NamedExports,
  source: string | undefined,
  paths: ReadonlySet<string>,
  problems: string[]
): ExportEntry[] =>
  clause.elements.map((element) => {
    const local = element.propertyName ?? element.name;
    const binding = module.imports.find(
      ({ local: name }) => name === local.text
    );
    if (
      source === undefined &&
      binding?.phase === "type" &&
      !(statement.isTypeOnly || element.isTypeOnly)
    ) {
      problems.push(
        `${module.path}:${lineOf(element, module.file)}: exports the type-only import ${local.text} without \`type\``
      );
    }
    const target =
      source === undefined
        ? required(
            bindingOf(module, local as ts.Identifier, paths),
            `${module.path}: binding of the export ${local.text}`
          )
        : `${local.text} from ${source}`;
    return [element.name.text, target, element];
  });

const statementExports = (
  module: Module,
  statement: ts.Statement,
  parts: ReadonlyMap<string, Part>,
  paths: ReadonlySet<string>,
  problems: string[]
): ExportEntry[] => {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    // `export *` is refused (refusals) and exports nothing here.
    if (clause === undefined || ts.isNamespaceExport(clause)) return [];
    const source =
      statement.moduleSpecifier === undefined
        ? undefined
        : moduleOf(module.path, statement, module.file);
    const part = source === undefined ? undefined : parts.get(source);
    return part === undefined
      ? declarationExports(module, statement, clause, source, paths, problems)
      : partExports(
          module,
          statement,
          clause,
          { ...part, source: source as string },
          problems
        );
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  const names = declaredNames(statement);
  return hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ? [["default", `declaration ${names[0]}`, statement]]
    : names.map((name) => [name, `declaration ${name}`, statement]);
};

/**
 * The exports of a file. `parts` are the new files whose re-exports by the
 * original file resolve to their declarations.
 */
const exportsOf = (
  module: Module,
  parts: ReadonlyMap<string, Part>,
  paths: ReadonlySet<string>,
  problems: string[]
): Exports => {
  const exports = new Map<string, string>();
  // Per name, whether each export of it is an exported declaration.
  const declarations = new Map<string, boolean[]>();
  for (const statement of module.file.statements) {
    const declaration = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const entries = statementExports(module, statement, parts, paths, problems);
    for (const [name, target] of entries) {
      exports.set(name, target);
      declarations.set(name, [...(declarations.get(name) ?? []), declaration]);
    }
  }
  // Declarations of one name merge (`type X` and `const X`). Any other second
  // export of a name fails at load time or hides one of the two.
  for (const [name, flags] of declarations) {
    if (flags.length > 1 && flags.includes(false)) {
      problems.push(
        `${module.path}: export ${name} is exported more than once`
      );
    }
  }
  return exports;
};

/**
 * Compares the exports of the original file before and after the split, and
 * indexes what the files after the split declare and export.
 */
const compareExports = (
  split: Split,
  problems: string[]
): Readonly<{ before: Exports; after: Exports; index: Index }> => {
  const [original, ...newFiles] = split.after as [Module, ...Module[]];
  const parts = new Map<string, Part>(
    newFiles.map((module) => [
      module.path,
      {
        exports: exportsOf(module, new Map(), split.paths, problems),
        types: typeNames(module),
      },
    ])
  );
  const before = exportsOf(split.before, new Map(), NO_PARTS, problems);
  const after = exportsOf(original, parts, split.paths, problems);
  const index: Index = {
    declared: placements(split),
    exports: new Map([
      [original.path, after],
      ...[...parts].map(([path, part]) => [path, part.exports] as const),
    ]),
    types: new Map([
      [original.path, typeNames(original)],
      ...[...parts].map(([path, part]) => [path, part.types] as const),
    ]),
  };
  for (const [name, target] of before) {
    const now = after.get(name);
    if (now === undefined) {
      problems.push(
        `${original.path}: export ${name} is missing after the split`
      );
    } else if (now !== target) {
      problems.push(
        `${original.path}: export ${name} was ${target} and is ${now} after the split`
      );
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) {
      problems.push(`${original.path}: export ${name} is new after the split`);
    }
  }
  return { before, after, index };
};

/** The percentage of istanbul-lib-coverage: two decimals, rounded down. */
const percent = (covered: number, total: number): number =>
  total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;

/** The entry of a json-summary report: the exact path or its one suffix match. */
const measured = (
  summary: CoverageSummary,
  path: string,
  when: "before" | "after"
): FileCoverage => {
  const keys = Object.keys(summary).filter((candidate) =>
    candidate.endsWith(`/${path}`)
  );
  if (summary[path] === undefined && keys.length > 1) {
    throw new Error(
      `${path} matches ${keys.length} files in the coverage summary ${when} the split: ${keys.join(", ")}`
    );
  }
  const key = summary[path] === undefined ? keys[0] : path;
  const where = `${path} in the coverage summary ${when} the split`;
  const coverage = required(
    key === undefined ? undefined : summary[key],
    where
  );
  for (const metric of METRICS) {
    const { covered, total, pct } = coverage[metric];
    if (pct !== percent(covered, total)) {
      throw new Error(`${where}: ${metric} ${covered}/${total} is not ${pct}%`);
    }
  }
  return coverage;
};

/** The baseline entry a file gets, or undefined at 100% on all four. */
const entryOf = (
  coverage: FileCoverage
): Readonly<Record<Metric, number>> | undefined =>
  METRICS.every((metric) => coverage[metric].pct === 100)
    ? undefined
    : (Object.fromEntries(
        METRICS.map((metric) => [metric, coverage[metric].pct])
      ) as Record<Metric, number>);

const printedEntry = (path: string, coverage: FileCoverage): string => {
  const entry = entryOf(coverage);
  if (entry === undefined) {
    return `  ${path}: 100% on all four measures, no entry`;
  }
  const minimums = METRICS.map(
    (metric) => `"${metric}": ${entry[metric]}`
  ).join(", ");
  return `  "${path}": { ${minimums} }`;
};

const baselineProblems = (
  before: Baseline,
  after: Baseline,
  entries: ReadonlyMap<string, FileCoverage>
): string[] => {
  const problems: string[] = [];
  const rest = (baseline: Baseline) =>
    JSON.stringify({ ...baseline, files: 0 });
  if (rest(before) !== rest(after)) {
    problems.push(
      `${BASELINE}: changed outside the entries of the split files`
    );
  }
  const paths = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
    ...entries.keys(),
  ]);
  for (const path of paths) {
    const coverage = entries.get(path);
    const expected =
      coverage === undefined ? before.files[path] : entryOf(coverage);
    const actual = after.files[path];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${BASELINE}: the entry of ${path} is ${JSON.stringify(actual) ?? "missing"} and must be ${JSON.stringify(expected) ?? "missing"}`
      );
    }
  }
  return problems;
};

type Options = Readonly<{
  base: string | undefined;
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
    base: values.base,
    from: posix.normalize(required(values.from, "--from")),
    to: required(values.to, "--to").map((path) => posix.normalize(path)),
    coverageBefore: required(values["coverage-before"], "--coverage-before"),
    coverageAfter: required(values["coverage-after"], "--coverage-after"),
  };
};

/** Changed files, new files that exist at the base, files in another folder. */
const treeProblems = async (
  options: Options,
  base: string,
  git: CoverageSplitProofDependencies["git"]
): Promise<string[]> => {
  const { from, to } = options;
  const allowed = [from, ...to, BASELINE];
  const changed = required(
    await git(["diff", "--name-only", "--no-renames", `${base}..HEAD`]),
    `the files changed between ${base} and HEAD`
  );
  const problems = changed
    .split("\n")
    .filter((path) => path !== "" && !allowed.includes(path))
    .map(
      (path) => `${path} changed: a split changes only ${allowed.join(", ")}`
    );
  for (const path of to) {
    if (posix.dirname(path) !== posix.dirname(from)) {
      problems.push(
        `${path} is not in the folder of ${from}: moved code stays in its folder`
      );
    }
    if (!/\.tsx?$/u.test(path) || SPECIAL_NAME.test(posix.basename(path))) {
      problems.push(
        `${path} is not a plain .ts or .tsx file: tests, declaration files and route files are special to the tools`
      );
    }
    // An extensionless import of `<stem>` would find a new `<stem>.ts`.
    const folder = posix.dirname(path);
    const listing = required(
      await git(["ls-tree", "--name-only", base, "--", `${folder}/`]),
      `the files in ${folder} at ${base}`
    );
    const stem = path.slice(0, path.length - posix.extname(path).length);
    const taken = listing
      .split("\n")
      .filter((entry) => entry === stem || entry.startsWith(`${stem}.`));
    if (taken.length > 0) {
      problems.push(
        `${path} takes the name of ${taken.join(", ")} at ${base}: a split moves code into new files with new names`
      );
    }
  }
  return problems;
};

const prove = async (
  options: Options,
  dependencies: CoverageSplitProofDependencies
): Promise<number> => {
  const { from, to } = options;
  const { git, output, readText } = dependencies;
  const show = async (commit: string, path: string): Promise<string> =>
    required(await git(["show", `${commit}:${path}`]), `${path} at ${commit}`);
  const mergeBase = (await git(["merge-base", "HEAD", TARGET_BRANCH]))?.trim();
  const ref =
    options.base ??
    required(mergeBase, `the merge base of HEAD and ${TARGET_BRANCH}`);
  const base = required(
    await git(["rev-parse", "--verify", `${ref}^{commit}`]),
    `the commit ${ref}`
  ).trim();
  const problems = await treeProblems(options, base, git);
  if (
    (await git(["merge-base", "--is-ancestor", base, "HEAD"])) === undefined
  ) {
    problems.push(`${base} is not an ancestor of HEAD`);
  }
  const paths = new Set([from, ...to]);
  const parts = new Set(to);
  const after: Module[] = [];
  for (const path of paths) {
    after.push(
      parseModule(
        path,
        await show("HEAD", path),
        path === from ? parts : NO_PARTS
      )
    );
  }
  const split: Split = {
    before: parseModule(from, await show(base, from), NO_PARTS),
    after,
    paths,
  };

  output(`Pure-move split of ${from} into ${to.join(", ")}`);
  output(
    `Base: ${base} (${options.base === undefined ? `merge base of HEAD and ${TARGET_BRANCH}` : `--base ${options.base}; the merge base of HEAD and ${TARGET_BRANCH} is ${mergeBase ?? "unknown"}`}); files after the split: HEAD`
  );
  const matched = matchStatements(split);
  problems.push(
    ...refusals(split),
    ...directiveProblems(split),
    ...matched.problems,
    ...moveProblems(matched.pairs, split)
  );
  const exports = compareExports(split, problems);
  for (const [name, files] of exports.index.declared) {
    if (files.length > 1) {
      problems.push(
        `${name} is declared in ${files.join(" and ")}: declarations of one name stay together`
      );
    }
  }
  problems.push(
    ...importProblems(split, exports.index),
    ...loadOrderProblems(split),
    ...bindingProblems(matched.pairs, split),
    ...after.flatMap((module) => module.typeErrors())
  );
  const moved = matched.pairs.filter(
    ({ module }) => module !== after[0]
  ).length;
  output(
    `Statements: ${split.before.statements.length} in the original file; ${moved} in the new files.`
  );
  output(
    `Exports of ${from}: ${exports.before.size} before, ${exports.after.size} after.`
  );

  const summaryBefore = JSON.parse(
    await readText(options.coverageBefore)
  ) as CoverageSummary;
  const summaryAfter = JSON.parse(
    await readText(options.coverageAfter)
  ) as CoverageSummary;
  const coverageBefore = measured(summaryBefore, from, "before");
  const coverageAfter = new Map(
    [...paths].map((path) => [path, measured(summaryAfter, path, "after")])
  );
  output("Coverage, covered/total before and after:");
  for (const metric of METRICS) {
    const sum = (field: "covered" | "total"): number =>
      [...coverageAfter.values()].reduce(
        (value, file) => value + file[metric][field],
        0
      );
    const was = `${coverageBefore[metric].covered}/${coverageBefore[metric].total}`;
    const now = `${sum("covered")}/${sum("total")}`;
    output(`  ${metric}: ${was} and ${now}`);
    if (was !== now) {
      problems.push(
        `${metric}: coverage was ${was} and is ${now} after the split`
      );
    }
  }
  output(`Baseline entries after the split (${BASELINE}):`);
  for (const [path, coverage] of coverageAfter) {
    output(printedEntry(path, coverage));
  }
  const baseline = async (commit: string): Promise<Baseline> =>
    JSON.parse(await show(commit, BASELINE)) as Baseline;
  problems.push(
    ...baselineProblems(
      await baseline(base),
      await baseline("HEAD"),
      coverageAfter
    )
  );

  if (problems.length === 0) {
    output("Result: PROVED");
    return 0;
  }
  output("Problems:");
  for (const problem of problems) output(`  - ${problem}`);
  output(`Result: NOT PROVED (${problems.length})`);
  return 1;
};

/** `bun scripts/coverage-split-proof.ts [--base <ref>] --from <file> --to <new file>... --coverage-before <json> --coverage-after <json>` */
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
