import { posix } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript-api";
import { required } from "./required.ts";

// Proof for the pure-move split exception of the coverage ratchet (AGENTS.md
// rule 4, ADR-017; owner decision 2026-11-11). A file listed in
// scripts/ci/coverage-baseline.json may be split into new files in its own
// folder when this command prints "Result: PROVED". The base is the merge base
// of HEAD and the target branch unless --base names another commit. The files
// after the split are read from HEAD.
//
// 1. Diff: the commits since the base change only the original file, the new
//    files and the baseline. The new files do not exist at the base and have
//    plain names: no test, declaration or route file. So no other file
//    imports a new file: the new files load through the original file, before
//    its own statements run.
// 2. Statements: every top-level statement of the original file is in exactly
//    one file after the split, token for token, with the same syntax tree and
//    in its original order. Comments and layout are not tokens. An `export`
//    may be added to a declaration; imports (rule 4) and the original file's
//    re-exports of the new files (rule 5) are checked on their own. Only
//    statements that run no code at load time move: function declarations,
//    interfaces, type aliases, classes without decorators, static blocks,
//    computed member names or static initializers that run code and whose
//    `extends` is a name that is not imported from another file of the
//    split, and `const` declarations whose initializers are literals,
//    functions, or arrays and objects of those (`as const` and `satisfies`
//    allowed). `let` and `var` stay: they may be reassigned. Moved code does
//    not name its own file (`import.meta` other than `import.meta.dirname`,
//    `__filename`); what depends only on the folder (`__dirname`, relative
//    `require` and `import()`) keeps its meaning in the same folder. All
//    declarations of one name stay together. A "use server" module does not
//    split.
// 3. Names: every identifier that named an import or a top-level declaration
//    of the original file names the same import or declaration after the
//    split, never a global. Code that calls `eval` does not split.
// 4. Imports: every imported name is imported under the same name from the
//    same module (relative specifiers resolved from each file's folder) as in
//    the original file, or is a declaration of the original file imported
//    under its name from the file after the split that declares it. No
//    aliases, no default or namespace import of a file of the split, no value
//    or deferred import of a name the original imported otherwise, and no
//    module the original did not load.
// 5. Exports: the original file exports the same names, and each resolves to
//    the same declaration, import or re-export. Its re-exports of the new
//    files do not rename, do not make a value type-only, and `export *` does
//    not re-export a default.
// 6. Coverage: the covered and total lines, branches, functions and statements
//    of the original file equal the sums over the files after the split. The
//    baseline entries of the files after the split are the values the command
//    prints, and every other part of the baseline is unchanged.
//
// The coverage summaries are supplied by the caller; the reviewer reruns the
// command with summaries from their own `bun run verify:coverage` runs.

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
  phase: "type" | "defer" | "value";
  renamed: boolean;
  line: number;
}>;

type Module = Readonly<{
  path: string;
  file: ts.SourceFile;
  checker: ts.TypeChecker;
  /** The compared statements: all but imports and re-exports of new files. */
  statements: readonly Statement[];
  imports: readonly ImportBinding[];
  /** Import statements other than `import type`, with their line. */
  loads: ReadonlyMap<string, number>;
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

// Names that the test runners, TypeScript or the app router act on: tests,
// declaration files and Next.js / vinext route and metadata files.
const SPECIAL_NAME =
  /(?:\.(?:test|spec|d)\.[cm]?[jt]sx?|^(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|middleware|proxy|instrumentation|instrumentation-client|icon|apple-icon|opengraph-image|twitter-image|sitemap|robots|manifest)\.[cm]?[jt]sx?)$/u;

// Only the syntax of one file is resolved: no library, no other file.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  noResolve: true,
  types: [],
  moduleDetection: ts.ModuleDetectionKind.Force,
};

const MOVABLE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

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

const tokensOf = (node: ts.Node, file: ts.SourceFile): string[] => {
  const children = node.getChildren(file).filter((child) => !ts.isJSDoc(child));
  return children.length === 0
    ? [node.getText(file)]
    : children.flatMap((child) => tokensOf(child, file));
};

const hasModifier = (statement: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);

const lineOf = (node: ts.Node, file: ts.SourceFile): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

const bindingNames = (name: ts.BindingName): string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? bindingNames(element.name) : []
      );

const declaredNames = (statement: ts.Statement): string[] => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
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
  const phase = (typeOnly: boolean): ImportBinding["phase"] => {
    if (typeOnly || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return "type";
    }
    return clause.phaseModifier === undefined ? "value" : "defer";
  };
  const binding = (
    imported: string,
    local: string,
    element?: ts.ImportSpecifier
  ): ImportBinding => ({
    imported,
    local,
    module,
    phase: phase(element?.isTypeOnly === true),
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

/**
 * Parses one file and binds its names. Imports with bindings and re-exports
 * of `parts` are not compared statements.
 */
const parseModule = (
  path: string,
  text: string,
  parts: ReadonlySet<string>
): Module => {
  const file = ts.createSourceFile(
    `/${path}`,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const checker = ts
    .createProgram({
      rootNames: [file.fileName],
      options: COMPILER_OPTIONS,
      host: { ...host, getSourceFile: () => file },
    })
    .getTypeChecker();
  const statements: Statement[] = [];
  const imports: ImportBinding[] = [];
  const loads = new Map<string, number>();
  for (const statement of file.statements) {
    const line = lineOf(statement, file);
    if (ts.isImportDeclaration(statement)) {
      const module = moduleOf(path, statement, file);
      const clause = statement.importClause;
      if (clause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
        loads.set(module, line);
      }
      if (clause !== undefined) {
        imports.push(...importBindings(clause, module, line));
        continue;
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      parts.has(moduleOf(path, statement, file))
    ) {
      continue;
    }
    statements.push(statementOf(statement, file));
  }
  return { path, file, checker, statements, imports, loads };
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
  let node: ts.Node = declaration;
  while (ts.isBindingElement(node)) node = node.parent.parent;
  const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  const topLevel =
    ts.isSourceFile(statement.parent) &&
    (statement === node || ts.isVariableStatement(statement));
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

/** `import.meta` (but `import.meta.dirname`) or `__filename`. */
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
  if (ts.isIdentifier(node) && node.text === "__filename") return true;
  return (
    ts.forEachChild(node, (child) => namesOwnFile(child) || undefined) === true
  );
};

const hasDecorator = (node: ts.Node): boolean =>
  ts.isDecorator(node) ||
  ts.forEachChild(node, (child) => hasDecorator(child) || undefined) === true;

const classProblem = (
  node: ts.ClassDeclaration,
  module: Module,
  paths: ReadonlySet<string>
): string | undefined => {
  if (hasDecorator(node)) return "a class with decorators";
  const heritage = node.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
  )?.types[0]?.expression;
  if (heritage !== undefined) {
    if (!ts.isIdentifier(heritage)) return "a class that extends an expression";
    const binding = module.imports.find(({ local }) => local === heritage.text);
    if (binding !== undefined && paths.has(binding.module)) {
      return `a class that extends ${heritage.text} of another file of the split, which may load after it`;
    }
  }
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) {
      return "a class with a static block";
    }
    if (member.name !== undefined && ts.isComputedPropertyName(member.name)) {
      return "a class with a computed member name";
    }
    if (
      ts.isPropertyDeclaration(member) &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      member.initializer !== undefined &&
      !sideEffectFree(member.initializer)
    ) {
      return "a class with a static initializer that runs code";
    }
  }
  return undefined;
};

/** Why a statement may not move into a new file, if it may not. */
const moveProblem = (
  statement: ts.Statement,
  module: Module,
  paths: ReadonlySet<string>
): string | undefined => {
  if (namesOwnFile(statement)) {
    return "code that names its own file (import.meta, __filename)";
  }
  if (MOVABLE.has(statement.kind)) return undefined;
  if (ts.isClassDeclaration(statement)) {
    return classProblem(statement, module, paths);
  }
  if (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.BlockScoped) ===
      ts.NodeFlags.Const &&
    statement.declarationList.declarations.every(
      ({ initializer }) =>
        initializer !== undefined && sideEffectFree(initializer)
    )
  ) {
    return undefined;
  }
  return "not a function, class, interface, type alias or side-effect-free const";
};

const moveProblems = (pairs: readonly Pair[], split: Split): string[] =>
  pairs.flatMap(({ after, module }) => {
    if (module === split.after[0]) return [];
    const problem = moveProblem(after.node, module, split.paths);
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

const importProblem = (
  binding: ImportBinding,
  split: Split,
  declared: ReadonlyMap<string, readonly string[]>
): string | undefined => {
  const { imported, local, module } = binding;
  if (binding.renamed) {
    return `imports ${imported} as ${local}; aliases are not allowed`;
  }
  if (split.paths.has(module)) {
    return imported === local && declared.get(local)?.[0] === module
      ? undefined
      : `imports ${imported} from ${module}, which is not a declaration of that file imported by its name`;
  }
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

const importProblems = (
  split: Split,
  declared: ReadonlyMap<string, readonly string[]>
): string[] =>
  split.after.flatMap((module) => [
    ...[...module.loads]
      .filter(
        ([loaded]) =>
          !(split.paths.has(loaded) || split.before.loads.has(loaded))
      )
      .map(
        ([loaded, line]) =>
          `${module.path}:${line}: loads ${loaded}, which the original file does not load`
      ),
    ...module.imports.flatMap((binding) => {
      const problem = importProblem(binding, split, declared);
      return problem === undefined
        ? []
        : [`${module.path}:${binding.line}: ${problem}`];
    }),
  ]);

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
 * Every export of a "use server" module is a server action, and a re-export
 * may not be; such a module does not split.
 */
const directiveProblems = (before: Module): string[] => {
  const problems: string[] = [];
  for (const statement of before.file.statements) {
    if (
      !(
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression)
      )
    ) {
      break;
    }
    if (statement.expression.text === "use server") {
      problems.push(
        `${before.path} is a "use server" module: its exports are server actions, so its code does not move`
      );
    }
  }
  return problems;
};

/** Names declared only by interfaces and type aliases. */
const typeNames = (module: Module): Set<string> => {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const { node, names } of module.statements) {
    const target =
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        ? types
        : values;
    for (const name of names) target.add(name);
  }
  return new Set([...types].filter((name) => !values.has(name)));
};

type Part = Readonly<{ exports: Exports; types: ReadonlySet<string> }>;

/** One exported name, what it resolves to, and where. */
type ExportEntry = readonly [name: string, target: string, node: ts.Node];

/** The original file's re-export of a new file: no rename, no namespace. */
const partExports = (
  module: Module,
  statement: ts.ExportDeclaration,
  part: Readonly<{ source: string } & Part>,
  problems: string[]
): ExportEntry[] => {
  const { source } = part;
  const clause = statement.exportClause;
  if (clause !== undefined && ts.isNamespaceExport(clause)) {
    problems.push(
      `${module.path}:${lineOf(statement, module.file)}: re-exports ${source} as a namespace`
    );
    return [];
  }
  // `export *` re-exports every name but `default`.
  const requests =
    clause === undefined
      ? [...part.exports.keys()]
          .filter((name) => name !== "default")
          .map((name) => ({
            name,
            node: statement as ts.Node,
            renamed: undefined,
            typeOnly: statement.isTypeOnly,
          }))
      : clause.elements.map((element) => ({
          name: element.name.text,
          node: element as ts.Node,
          renamed: element.propertyName?.text,
          typeOnly: statement.isTypeOnly || element.isTypeOnly,
        }));
  return requests.flatMap(
    ({ name, node, renamed, typeOnly }): ExportEntry[] => {
      const target = part.exports.get(name);
      let problem: string | undefined;
      if (renamed !== undefined) {
        problem = `renames ${renamed} of ${source} to ${name}`;
      } else if (target === undefined) {
        problem = `re-exports ${name}, which ${source} does not export`;
      } else if (typeOnly && !part.types.has(name)) {
        problem = `re-exports the value ${name} of ${source} as a type`;
      }
      if (problem === undefined) return [[name, target as string, node]];
      problems.push(`${module.path}:${lineOf(node, module.file)}: ${problem}`);
      return [];
    }
  );
};

/** The exports of an export declaration that does not re-export a new file. */
const declarationExports = (
  module: Module,
  statement: ts.ExportDeclaration,
  source: string | undefined,
  paths: ReadonlySet<string>
): ExportEntry[] => {
  const clause = statement.exportClause;
  if (clause === undefined) {
    return [[`* from ${source}`, `* from ${source}`, statement]];
  }
  if (ts.isNamespaceExport(clause)) {
    return [[clause.name.text, `* from ${source}`, statement]];
  }
  return clause.elements.map((element) => {
    const local = element.propertyName ?? element.name;
    const target =
      source === undefined
        ? required(
            bindingOf(module, local as ts.Identifier, paths),
            `${module.path}: binding of the export ${local.text}`
          )
        : `${local.text} from ${source}`;
    return [element.name.text, target, element];
  });
};

const statementExports = (
  module: Module,
  statement: ts.Statement,
  parts: ReadonlyMap<string, Part>,
  paths: ReadonlySet<string>,
  problems: string[]
): ExportEntry[] => {
  if (ts.isExportAssignment(statement)) {
    // The statement itself is compared; `export =` counts as a default.
    return [["default", "the expression of export default", statement]];
  }
  if (ts.isExportDeclaration(statement)) {
    const source =
      statement.moduleSpecifier === undefined
        ? undefined
        : moduleOf(module.path, statement, module.file);
    const part = source === undefined ? undefined : parts.get(source);
    return part === undefined
      ? declarationExports(module, statement, source, paths)
      : partExports(
          module,
          statement,
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
  for (const statement of module.file.statements) {
    const entries = statementExports(module, statement, parts, paths, problems);
    for (const [name, target, node] of entries) {
      const known = exports.get(name);
      if (known !== undefined && known !== target) {
        problems.push(
          `${module.path}:${lineOf(node, module.file)}: export ${name} is both ${known} and ${target}`
        );
      }
      exports.set(name, target);
    }
  }
  return exports;
};

const compareExports = (split: Split, problems: string[]): Exports[] => {
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
  return [before, after];
};

/** The entry of a json-summary report: the exact path or its one suffix match. */
const measured = (
  summary: CoverageSummary,
  path: string,
  when: "before" | "after"
): FileCoverage => {
  const exact = summary[path];
  if (exact !== undefined) return exact;
  const keys = Object.keys(summary).filter((key) => key.endsWith(`/${path}`));
  if (keys.length > 1) {
    throw new Error(
      `${path} matches ${keys.length} files in the coverage summary ${when} the split: ${keys.join(", ")}`
    );
  }
  return required(
    summary[keys[0] ?? ""],
    `${path} in the coverage summary ${when} the split`
  );
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
    if (SPECIAL_NAME.test(posix.basename(path))) {
      problems.push(
        `${path} has a name that tools treat specially (a test, a declaration file, a route file): a new file has a plain name`
      );
    }
    if ((await git(["show", `${base}:${path}`])) !== undefined) {
      problems.push(
        `${path} exists at ${base}: a split moves code into new files only`
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
  const show = async (ref: string, path: string): Promise<string> =>
    required(await git(["show", `${ref}:${path}`]), `${path} at ${ref}`);
  const base =
    options.base ??
    required(
      await git(["merge-base", "HEAD", TARGET_BRANCH]),
      `the merge base of HEAD and ${TARGET_BRANCH}`
    ).trim();
  const problems = await treeProblems(options, base, git);
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
    `Base: ${base} (${options.base === undefined ? `merge base of HEAD and ${TARGET_BRANCH}` : "--base"}); files after the split: HEAD`
  );
  const matched = matchStatements(split);
  const declared = placements(split);
  problems.push(
    ...directiveProblems(split.before),
    ...matched.problems,
    ...moveProblems(matched.pairs, split)
  );
  for (const [name, files] of declared) {
    if (files.length > 1) {
      problems.push(
        `${name} is declared in ${files.join(" and ")}: declarations of one name stay together`
      );
    }
  }
  problems.push(
    ...importProblems(split, declared),
    ...bindingProblems(matched.pairs, split)
  );
  const [exportsBefore, exportsAfter] = compareExports(split, problems) as [
    Exports,
    Exports,
  ];
  const moved = matched.pairs.filter(
    ({ module }) => module !== after[0]
  ).length;
  output(
    `Statements: ${split.before.statements.length} in the original file; ${moved} in the new files.`
  );
  output(
    `Exports of ${from}: ${exportsBefore.size} before, ${exportsAfter.size} after.`
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
  const baseline = async (ref: string): Promise<Baseline> =>
    JSON.parse(await show(ref, BASELINE)) as Baseline;
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
