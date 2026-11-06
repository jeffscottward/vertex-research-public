// Tokenizer for the Vertex Pine subset. Produces logical lines: NEWLINE ends a statement,
// INDENT/DEDENT mark 4-space (or tab) blocks, newlines inside () or [] are ignored, and a
// line indented by a non-multiple of 4 spaces continues the previous line (Pine's rule).

import { fail, type Position } from "./errors.ts";
import { SCRIPT_STRING_MAX, STRING_TOO_LONG } from "./limits.ts";

export type TokenKind =
  | "num"
  | "str"
  | "ident"
  | "color"
  | "op"
  | "newline"
  | "indent"
  | "dedent"
  | "eof";

export type Token = Readonly<{
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
  // num tokens only: parsed value and whether it was written without "." or exponent.
  num?: number;
  isInt?: boolean;
}>;

export type LexResult = Readonly<{
  tokens: readonly Token[];
  version: 5 | 6 | null;
}>;

const OPERATORS = [
  ":=",
  "==",
  "!=",
  "<=",
  ">=",
  "=>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "?",
  ":",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
] as const;

const OPENERS = new Set(["(", "["]);
const CLOSERS = new Set([")", "]"]);
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["'", "'"],
  ['"', '"'],
  ["\\", "\\"],
  ["n", "\n"],
  ["t", "\t"],
]);

const INDENT_WIDTH = 4;
const VERSION_PATTERN = /^\/\/\s*@version\s*=\s*(\d+)/;
const NUMBER_PATTERN = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/y;
const COLOR_PATTERN = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/y;

const NUMBER_START = /\d|\.\d/y;

class Lexer {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private column = 1;
  private depth = 0;
  private level = 0;
  private pendingNewline = false;
  // Where the pending NEWLINE's line ended, so "Unexpected end of line" points there.
  private newlineAt: Position = { column: 1, line: 1 };
  private atLineStart = true;
  private version: 5 | 6 | null = null;
  private readonly tokens: Token[] = [];

  constructor(source: string) {
    this.src = source.replace(/\r\n?/g, "\n");
  }

  run(): LexResult {
    while (this.pos < this.src.length) {
      if (this.atLineStart) {
        this.atLineStart = false;
        this.lineStart();
        continue;
      }
      this.scanToken();
    }
    this.finish();
    return { tokens: this.tokens, version: this.version };
  }

  private here(): Position {
    return { column: this.column, line: this.line };
  }

  private push(kind: TokenKind, value: string, at: Position): void {
    this.tokens.push({ column: at.column, kind, line: at.line, value });
  }

  private advance(count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.src[this.pos] === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.pos++;
    }
  }

  // Measure indentation, skip blank/comment lines, decide continuation vs new statement.
  private lineStart(): void {
    let width = 0;
    let count = 0;
    for (;;) {
      const ch = this.src[this.pos + count];
      if (ch === " ") width += 1;
      else if (ch === "\t") width += INDENT_WIDTH;
      else break;
      count++;
    }
    const rest = this.src.slice(this.pos + count);
    const blank = rest.startsWith("\n") || rest.length === 0;
    if (blank || rest.startsWith("//")) {
      this.advance(count);
      if (!blank) this.comment();
      if (this.src[this.pos] === "\n") {
        this.advance(1);
        this.atLineStart = true;
      }
      return;
    }
    const at: Position = { column: count + 1, line: this.line };
    if (width % INDENT_WIDTH !== 0) {
      if (this.tokens.length === 0) fail("Unexpected indentation", at);
      // Continuation line: the previous logical line keeps going.
      this.pendingNewline = false;
      this.advance(count);
      return;
    }
    const level = width / INDENT_WIDTH;
    if (this.pendingNewline) {
      this.push("newline", "", this.newlineAt);
      this.pendingNewline = false;
    }
    if (level > this.level + 1) fail("Unexpected indentation", at);
    if (level > this.level) this.push("indent", "", at);
    for (let l = this.level; l > level; l--) this.push("dedent", "", at);
    this.level = level;
    this.advance(count);
  }

  private comment(): void {
    const end = this.src.indexOf("\n", this.pos);
    const stop = end === -1 ? this.src.length : end;
    const text = this.src.slice(this.pos, stop);
    const match = VERSION_PATTERN.exec(text);
    if (match) {
      const version = Number(match[1]);
      if (version !== 5 && version !== 6) {
        fail("Only //@version=5 or //@version=6 is supported", this.here());
      }
      this.version = version === 5 ? 5 : 6;
    }
    this.advance(stop - this.pos);
  }

  private scanToken(): void {
    const ch = this.src.charAt(this.pos);
    if (ch === "\n") {
      this.lineBreak();
      return;
    }
    if (ch === " " || ch === "\t") {
      this.advance(1);
      return;
    }
    if (this.src.startsWith("//", this.pos)) {
      this.comment();
      return;
    }
    if (this.match(NUMBER_START)) {
      this.number();
      return;
    }
    if (ch === '"' || ch === "'") {
      this.string(ch);
      return;
    }
    if (ch === "#") {
      this.color();
      return;
    }
    this.wordOrOperator(ch);
  }

  private lineBreak(): void {
    const last = this.tokens.at(-1);
    if (this.depth === 0 && last && last.kind !== "newline") {
      this.pendingNewline = true;
      this.newlineAt = this.here();
    }
    this.advance(1);
    if (this.depth === 0) this.atLineStart = true;
  }

  private match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.pos;
    return pattern.exec(this.src);
  }

  private wordOrOperator(ch: string): void {
    const at = this.here();
    const ident = this.match(IDENT_PATTERN)?.[0];
    if (ident) {
      this.push("ident", ident, at);
      this.advance(ident.length);
      return;
    }
    const op = OPERATORS.find((candidate) =>
      this.src.startsWith(candidate, this.pos)
    );
    if (!op) {
      fail(`Unexpected character '${ch}'`, at);
      return;
    }
    this.push("op", op, at);
    if (OPENERS.has(op)) this.depth++;
    if (CLOSERS.has(op)) this.depth = Math.max(0, this.depth - 1);
    this.advance(op.length);
  }

  private number(): void {
    const at = this.here();
    // scanToken saw a digit (or ".digit"), so the pattern always matches here.
    const text = (this.match(NUMBER_PATTERN) as RegExpExecArray)[0];
    const value = Number(text);
    if (!Number.isFinite(value)) fail("Invalid number", at);
    this.tokens.push({
      column: at.column,
      isInt: !/[.eE]/.test(text),
      kind: "num",
      line: at.line,
      num: value,
      value: text,
    });
    this.advance(text.length);
  }

  private string(quote: string): void {
    const at = this.here();
    let out = "";
    let i = this.pos + 1;
    for (;;) {
      const ch = this.src[i];
      if (ch === undefined || ch === "\n") fail("Unterminated string", at);
      if (ch === quote) break;
      if (ch === "\\") {
        const next = this.src[i + 1] ?? "";
        out += ESCAPES.get(next) ?? next;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    if (out.length > SCRIPT_STRING_MAX) fail(STRING_TOO_LONG, at);
    this.push("str", out, at);
    this.advance(i + 1 - this.pos);
  }

  private color(): void {
    const at = this.here();
    const match = this.match(COLOR_PATTERN);
    if (!match) {
      fail("Invalid color literal; use #rrggbb", at);
      return;
    }
    const hex = match[0].slice(1, 7).toLowerCase();
    this.push("color", `#${hex}`, at);
    this.advance(match[0].length);
  }

  private finish(): void {
    const at = this.here();
    const last = this.tokens.at(-1);
    if (last && last.kind !== "newline") {
      this.push("newline", "", this.pendingNewline ? this.newlineAt : at);
    }
    for (let l = this.level; l > 0; l--) this.push("dedent", "", at);
    this.push("eof", "", at);
  }
}

export const tokenize = (source: string): LexResult => new Lexer(source).run();
