// Recursive-descent parser: tokens -> typed AST (ast.ts). Precedence follows the Pine
// reference: ?: < or < and < == != < comparisons < + - < * / % < unary < [] history.

import type {
  Arg,
  AssignOp,
  BinaryOp,
  Expr,
  For,
  FuncDef,
  If,
  Param,
  Program,
  Stmt,
  TupleTarget,
  TypeName,
} from "./ast.ts";
import { fail, type Position, unsupported } from "./errors.ts";
import { type Token, tokenize } from "./lexer.ts";

const UNSUPPORTED_KEYWORDS = new Set([
  "varip",
  "while",
  "switch",
  "method",
  "type",
  "import",
  "export",
  "enum",
]);
const UNSUPPORTED_TYPES = new Set([
  "array",
  "matrix",
  "map",
  "line",
  "label",
  "box",
  "table",
  "linefill",
  "polyline",
]);
const TYPE_NAMES = new Set<string>(["int", "float", "bool", "string", "color"]);
const QUALIFIERS = new Set(["series", "simple", "const"]);
const RESERVED = new Set([
  "and",
  "or",
  "not",
  "if",
  "else",
  "for",
  "var",
  "true",
  "false",
  "break",
  "continue",
]);
const ASSIGN_OPS = new Set<string>([":=", "+=", "-=", "*=", "/=", "%="]);
const EQUALITY = new Set<string>(["==", "!="]);
const COMPARISON = new Set<string>(["<", "<=", ">", ">="]);
const ADDITIVE = new Set<string>(["+", "-"]);
const MULTIPLICATIVE = new Set<string>(["*", "/", "%"]);
const MAX_NESTING = 64;
// Tree height cap: long operator chains (1 + 1 + ... + 1) and x[1][1]... parse in a loop,
// so the bracket-nesting counter never sees them; the evaluator would recurse that deep.
const MAX_EXPR_HEIGHT = 256;

// The lexer ends every logical line with NEWLINE before any DEDENT or EOF, so only
// newline and string labels are reachable today; the rest keep messages readable.
const LABELS: Readonly<Partial<Record<Token["kind"], string>>> = {
  dedent: "indentation",
  eof: "end of script",
  indent: "indentation",
  newline: "end of line",
  str: "string",
};

const describe = (token: Token): string =>
  LABELS[token.kind] ?? `'${token.value}'`;

class Parser {
  private readonly tokens: readonly Token[];
  private index = 0;
  private nextId = 1;
  private depth = 0;
  private readonly heights = new Map<number, number>();

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  get nodeCount(): number {
    return this.nextId;
  }

  private peek(offset = 0): Token {
    const last = this.tokens.length - 1;
    return this.tokens[Math.min(this.index + offset, last)] as Token;
  }

  private next(): Token {
    const token = this.peek();
    this.index = Math.min(this.index + 1, this.tokens.length - 1);
    return token;
  }

  private isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "op" && token.value === value;
  }

  private isWord(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "ident" && token.value === value;
  }

  private expectOp(value: string): Token {
    const token = this.peek();
    if (token.kind !== "op" || token.value !== value) {
      fail(`Expected '${value}' but found ${describe(token)}`, token);
    }
    return this.next();
  }

  // Inside (...) or [...] lists: a comma, or the closer ends the list.
  private listSeparator(closer: string): void {
    if (this.isOp(closer)) return;
    if (this.isOp(",")) {
      this.next();
      return;
    }
    fail(
      `Expected ',' or '${closer}' but found ${describe(this.peek())}`,
      this.peek()
    );
  }

  private expectName(what: string): Token {
    const token = this.peek();
    if (token.kind !== "ident" || RESERVED.has(token.value)) {
      fail(`Expected ${what} but found ${describe(token)}`, token);
    }
    return this.next();
  }

  private meta(at: Position): { id: number; line: number; column: number } {
    return { column: at.column, id: this.nextId++, line: at.line };
  }

  // Records a compound node's height and rejects trees deeper than MAX_EXPR_HEIGHT.
  private sized<T extends Expr>(expr: T, children: readonly Expr[]): T {
    let tallest = 0;
    for (const child of children) {
      tallest = Math.max(tallest, this.heights.get(child.id) ?? 1);
    }
    const height = tallest + 1;
    if (height > MAX_EXPR_HEIGHT) {
      fail("Expression is too long; split it into smaller steps", expr);
    }
    this.heights.set(expr.id, height);
    return expr;
  }

  // Statements ------------------------------------------------------------

  program(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek().kind !== "eof") body.push(this.statement());
    return body;
  }

  // Every statement ends at a NEWLINE: the lexer emits one before each DEDENT and EOF.
  private endOfStatement(): void {
    const token = this.peek();
    if (token.kind !== "newline") fail(`Unexpected ${describe(token)}`, token);
    this.next();
  }

  private block(): Stmt[] {
    const opener = this.peek();
    if (opener.kind !== "newline") {
      fail(
        `Expected a new indented line but found ${describe(opener)}`,
        opener
      );
    }
    this.next();
    const indent = this.peek();
    if (indent.kind !== "indent") {
      fail("Expected an indented block (4 spaces or a tab)", indent);
    }
    this.next();
    const body: Stmt[] = [];
    while (this.peek().kind !== "dedent") body.push(this.statement());
    this.next();
    return body;
  }

  private statement(): Stmt {
    const token = this.peek();
    if (token.kind === "indent") fail("Unexpected indentation", token);
    if (token.kind === "ident") {
      const special = this.keywordStatement(token);
      if (special) return special;
    }
    if (this.isOp("[")) {
      const tuple = this.tupleDecl();
      if (tuple) return tuple;
    }
    const expr = this.expression();
    this.endOfStatement();
    return { kind: "expr", ...this.meta(token), expr };
  }

  private keywordStatement(token: Token): Stmt | null {
    const word = token.value;
    if (UNSUPPORTED_KEYWORDS.has(word)) unsupported(word, token);
    if (UNSUPPORTED_TYPES.has(word)) {
      const after = this.peek(1);
      if (
        after.kind === "ident" ||
        (after.kind === "op" && after.value === "<")
      )
        unsupported(word, token);
    }
    if (word === "if") return this.ifStatement();
    if (word === "for") return this.forStatement();
    if (word === "else") fail("'else' without a matching 'if'", token);
    if (word === "break" || word === "continue") {
      this.next();
      this.endOfStatement();
      return { kind: word, ...this.meta(token) };
    }
    if (word === "var" || this.startsTypedDecl()) return this.declaration();
    if (this.isOp("(", 1) && this.isFunctionDef()) return this.functionDef();
    if (this.isOp("=", 1)) return this.declaration();
    const op = this.peek(1);
    if (op.kind === "op" && ASSIGN_OPS.has(op.value)) return this.assignment();
    return null;
  }

  // `float x = ...`, `simple int x = ...`
  private startsTypedDecl(): boolean {
    let offset = 0;
    while (QUALIFIERS.has(this.peek(offset).value)) offset++;
    const type = this.peek(offset);
    const name = this.peek(offset + 1);
    return (
      type.kind === "ident" &&
      TYPE_NAMES.has(type.value) &&
      name.kind === "ident" &&
      this.isOp("=", offset + 2)
    );
  }

  private typePrefix(): TypeName | null {
    while (QUALIFIERS.has(this.peek().value) && this.peek(1).kind === "ident")
      this.next();
    const type = this.peek();
    const after = this.peek(1);
    if (type.kind !== "ident" || after.kind !== "ident") return null;
    if (UNSUPPORTED_TYPES.has(type.value)) unsupported(type.value, type);
    if (!TYPE_NAMES.has(type.value)) return null;
    this.next();
    return type.value as TypeName;
  }

  private declaration(): Stmt {
    const start = this.peek();
    const persistent = this.isWord("var");
    if (persistent) this.next();
    const typeName = this.typePrefix();
    const name = this.expectName("a variable name");
    this.expectOp("=");
    const value = this.expression();
    this.endOfStatement();
    return {
      kind: "decl",
      ...this.meta(start),
      name: name.value,
      persistent,
      typeName,
      value,
    };
  }

  private assignment(): Stmt {
    const name = this.next();
    const op = this.next().value as AssignOp;
    const value = this.expression();
    this.endOfStatement();
    return { kind: "assign", ...this.meta(name), name: name.value, op, value };
  }

  private tupleDecl(): Stmt | null {
    const start = this.index;
    const open = this.next();
    const targets: TupleTarget[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind !== "ident" || RESERVED.has(token.value)) break;
      this.next();
      targets.push({ ...this.meta(token), name: token.value });
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      if (this.isOp("]") && this.isOp("=", 1)) {
        this.next();
        this.next();
        const value = this.expression();
        this.endOfStatement();
        return { kind: "tupleDecl", ...this.meta(open), targets, value };
      }
      break;
    }
    this.index = start;
    return null;
  }

  private ifStatement(): If {
    const start = this.next();
    const cond = this.expression();
    const then = this.block();
    let otherwise: Stmt[] | null = null;
    if (this.isWord("else")) {
      this.next();
      otherwise = this.isWord("if") ? [this.ifStatement()] : this.block();
    }
    return { kind: "if", ...this.meta(start), cond, otherwise, then };
  }

  private forStatement(): For {
    const start = this.next();
    const variable = this.expectName("a loop variable");
    if (this.isWord("in")) unsupported("for...in", this.peek());
    this.expectOp("=");
    const from = this.expression();
    if (!this.isWord("to")) {
      fail(`Expected 'to' but found ${describe(this.peek())}`, this.peek());
    }
    this.next();
    const to = this.expression();
    let step: Expr | null = null;
    if (this.isWord("by")) {
      this.next();
      step = this.expression();
    }
    const body = this.block();
    return {
      kind: "for",
      ...this.meta(start),
      body,
      from,
      step,
      to,
      variable: variable.value,
    };
  }

  private isFunctionDef(): boolean {
    let depth = 0;
    for (let offset = 1; ; offset++) {
      const token = this.peek(offset);
      if (token.kind === "eof" || token.kind === "newline") return false;
      if (token.kind !== "op") continue;
      if (token.value === "(" || token.value === "[") depth++;
      if (token.value === ")" || token.value === "]") depth--;
      if (depth === 0) return this.isOp("=>", offset + 1);
    }
  }

  private functionDef(): FuncDef {
    const name = this.next();
    this.expectOp("(");
    const params: Param[] = [];
    while (!this.isOp(")")) {
      this.typePrefix();
      const param = this.expectName("a parameter name");
      let fallback: Expr | null = null;
      if (this.isOp("=")) {
        this.next();
        fallback = this.expression();
      }
      params.push({
        column: param.column,
        fallback,
        line: param.line,
        name: param.value,
      });
      this.listSeparator(")");
    }
    this.next();
    this.expectOp("=>");
    let body: Stmt[];
    if (this.peek().kind === "newline") {
      body = this.block();
    } else {
      const at = this.peek();
      const expr = this.expression();
      this.endOfStatement();
      body = [{ kind: "expr", ...this.meta(at), expr }];
    }
    return { kind: "func", ...this.meta(name), body, name: name.value, params };
  }

  // Expressions -----------------------------------------------------------

  expression(): Expr {
    this.depth++;
    if (this.depth > MAX_NESTING) {
      fail("Expression is nested too deeply", this.peek());
    }
    try {
      return this.ternary();
    } finally {
      this.depth--;
    }
  }

  private ternary(): Expr {
    const cond = this.binary(0);
    if (!this.isOp("?")) return cond;
    const at = this.next();
    const whenTrue = this.expression();
    this.expectOp(":");
    const whenFalse = this.expression();
    return this.sized(
      { kind: "ternary", ...this.meta(at), cond, whenFalse, whenTrue },
      [cond, whenTrue, whenFalse]
    );
  }

  // Precedence levels, lowest first; each is left-associative.
  private binary(level: number): Expr {
    const matches = LEVELS[level];
    if (!matches) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (!matches(token)) return left;
      this.next();
      const right = this.binary(level + 1);
      left = this.sized(
        {
          kind: "binary",
          ...this.meta(token),
          left,
          op: token.value as BinaryOp,
          right,
        },
        [left, right]
      );
    }
  }

  private unary(): Expr {
    const token = this.peek();
    const isSign =
      token.kind === "op" && (token.value === "-" || token.value === "+");
    if (isSign || this.isWord("not")) {
      this.next();
      this.depth++;
      if (this.depth > MAX_NESTING) {
        fail("Expression is nested too deeply", token);
      }
      try {
        const operand = this.unary();
        const op = token.value as "-" | "+" | "not";
        return this.sized({ kind: "unary", ...this.meta(token), op, operand }, [
          operand,
        ]);
      } finally {
        this.depth--;
      }
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let expr = this.primary();
    while (this.isOp("[")) {
      const at = this.next();
      const offset = this.expression();
      this.expectOp("]");
      expr = this.sized(
        { kind: "history", ...this.meta(at), offset, target: expr },
        [expr, offset]
      );
    }
    return expr;
  }

  private primary(): Expr {
    const token = this.peek();
    switch (token.kind) {
      case "num":
        this.next();
        return {
          kind: "num",
          ...this.meta(token),
          isInt: token.isInt === true,
          value: Number(token.value),
        };
      case "str":
        this.next();
        return { kind: "str", ...this.meta(token), value: token.value };
      case "color":
        this.next();
        return { kind: "color", ...this.meta(token), hex: token.value };
      case "ident":
        return this.word(token);
      case "op":
        return this.bracketed(token);
      default:
        return fail(`Unexpected ${describe(token)}`, token);
    }
  }

  private bracketed(token: Token): Expr {
    if (token.value === "(") {
      this.next();
      const inner = this.expression();
      this.expectOp(")");
      return inner;
    }
    if (token.value === "[") {
      this.next();
      const items: Expr[] = [];
      while (!this.isOp("]")) {
        items.push(this.expression());
        this.listSeparator("]");
      }
      this.next();
      return this.sized({ kind: "tuple", ...this.meta(token), items }, items);
    }
    return fail(`Unexpected ${describe(token)}`, token);
  }

  private word(token: Token): Expr {
    const word = token.value;
    if (word === "true" || word === "false") {
      this.next();
      return { kind: "bool", ...this.meta(token), value: word === "true" };
    }
    if (word === "na" && !this.isOp("(", 1)) {
      this.next();
      return { kind: "na", ...this.meta(token) };
    }
    if (word === "if") unsupported("if expressions", token);
    if (UNSUPPORTED_KEYWORDS.has(word)) unsupported(word, token);
    if (RESERVED.has(word)) fail(`Unexpected '${word}'`, token);
    this.next();
    let name = word;
    while (this.isOp(".")) {
      this.next();
      const part = this.peek();
      if (part.kind !== "ident") {
        fail(`Expected a name after '.' but found ${describe(part)}`, part);
      }
      this.next();
      name += `.${part.value}`;
    }
    if (!this.isOp("(")) return { kind: "name", ...this.meta(token), name };
    const meta = this.meta(token);
    const args = this.args();
    return this.sized(
      { kind: "call", ...meta, args, callee: name },
      args.map((arg) => arg.value)
    );
  }

  private args(): Arg[] {
    this.expectOp("(");
    const args: Arg[] = [];
    while (!this.isOp(")")) {
      const token = this.peek();
      const named = token.kind === "ident" && this.isOp("=", 1);
      if (named) {
        this.next();
        this.next();
      }
      const value = this.expression();
      args.push({
        column: token.column,
        line: token.line,
        name: named ? token.value : null,
        value,
      });
      this.listSeparator(")");
    }
    this.next();
    return args;
  }
}

const opIn =
  (set: ReadonlySet<string>) =>
  (token: Token): boolean =>
    token.kind === "op" && set.has(token.value);

const LEVELS: readonly ((token: Token) => boolean)[] = [
  (token) => token.kind === "ident" && token.value === "or",
  (token) => token.kind === "ident" && token.value === "and",
  opIn(EQUALITY),
  opIn(COMPARISON),
  opIn(ADDITIVE),
  opIn(MULTIPLICATIVE),
];

export const parse = (source: string): Program => {
  const { tokens, version } = tokenize(source);
  const parser = new Parser(tokens);
  const body = parser.program();
  return { body, nodeCount: parser.nodeCount, version };
};
