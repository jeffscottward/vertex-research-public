import { describe, expect, it } from "vitest";

import type { Stmt } from "./ast.ts";
import { ScriptFailure } from "./errors.ts";
import { compileScript } from "./interpreter.ts";
import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";

const kinds = (source: string) =>
  tokenize(source).tokens.map((t) =>
    t.kind === "op" || t.kind === "ident" ? t.value : t.kind
  );

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ScriptFailure) {
      return { column: error.column, line: error.line, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a ScriptFailure");
};

const errorOf = (source: string) => {
  const result = compileScript(source);
  if (result.ok) throw new Error("expected compile errors");
  return result.errors[0];
};

describe("lexer", () => {
  it("emits logical lines with INDENT/DEDENT blocks", () => {
    expect(kinds("if a\n    b := 1\nc = 2\n")).toEqual([
      "if",
      "a",
      "newline",
      "indent",
      "b",
      ":=",
      "num",
      "newline",
      "dedent",
      "c",
      "=",
      "num",
      "newline",
      "eof",
    ]);
  });

  it("treats tabs as one indent level", () => {
    expect(kinds("if a\n\tb := 1\n")).toContain("indent");
  });

  it("ignores newlines inside brackets and joins non-multiple-of-4 continuation lines", () => {
    expect(kinds("x = f(1,\n  2)\n")).not.toContain("indent");
    expect(
      kinds("x = 1 +\n  2\ny = 3\n").filter((k) => k === "newline")
    ).toHaveLength(2);
  });

  it("skips comments and reads the version annotation", () => {
    expect(tokenize("//@version=6\n// hi\nx = 1 // tail\n").version).toBe(6);
    expect(tokenize("x = 1\n").version).toBeNull();
  });

  it("parses numbers, strings with escapes and colors", () => {
    const tokens = tokenize(
      "a = 1.5e2 + .5 + 3\nb = 'it\\'s'\nc = #FF0000\nd = #00ff0080\n"
    ).tokens;
    const nums = tokens.filter((t) => t.kind === "num");
    expect(nums.map((t) => [t.num, t.isInt])).toEqual([
      [150, false],
      [0.5, false],
      [3, true],
    ]);
    expect(tokens.find((t) => t.kind === "str")?.value).toBe("it's");
    expect(
      tokens.filter((t) => t.kind === "color").map((t) => t.value)
    ).toEqual(["#ff0000", "#00ff00"]);
  });

  it("reports lexer errors with line and column", () => {
    expect(failure(() => tokenize('x = 1\ny = "open'))).toEqual({
      column: 5,
      line: 2,
      message: "Unterminated string",
    });
    expect(failure(() => tokenize("x = 1 @ 2"))).toEqual({
      column: 7,
      line: 1,
      message: "Unexpected character '@'",
    });
    expect(failure(() => tokenize("c = #12"))).toMatchObject({
      column: 5,
      line: 1,
    });
    expect(failure(() => tokenize("//@version=4\n"))).toMatchObject({
      line: 1,
      message: "Only //@version=5 or //@version=6 is supported",
    });
    expect(failure(() => tokenize("if a\n        b = 1\n"))).toEqual({
      column: 9,
      line: 2,
      message: "Unexpected indentation",
    });
  });
});

describe("parser", () => {
  const body = (source: string): readonly Stmt[] => parse(source).body;

  it("builds a typed AST with unique node ids", () => {
    const program = parse(
      'indicator("x")\nvar float a = na\nb = a[1] + 2 * 3\n'
    );
    const [, decl, plain] = program.body;
    expect(decl).toMatchObject({
      kind: "decl",
      name: "a",
      persistent: true,
      typeName: "float",
    });
    expect(plain).toMatchObject({
      kind: "decl",
      value: {
        kind: "binary",
        left: { kind: "history", target: { kind: "name", name: "a" } },
        op: "+",
        right: { kind: "binary", op: "*" },
      },
    });
    expect(program.nodeCount).toBeGreaterThan(8);
  });

  it("follows Pine precedence: ternary < or < and < comparison < arithmetic", () => {
    const [stmt] = body("x = a or b and c > 1 + 2 ? 1 : 0\n");
    expect(stmt).toMatchObject({
      value: {
        cond: {
          op: "or",
          right: { op: "and", right: { op: ">", right: { op: "+" } } },
        },
        kind: "ternary",
      },
    });
  });

  it("parses if / else if / else chains", () => {
    const [stmt] = body(
      "if a\n    x := 1\nelse if b\n    x := 2\nelse\n    x := 3\n"
    );
    expect(stmt).toMatchObject({
      kind: "if",
      otherwise: [{ kind: "if", otherwise: [{ kind: "assign", op: ":=" }] }],
      then: [{ kind: "assign" }],
    });
  });

  it("parses functions, tuples, for loops and named args", () => {
    const stmts = body(
      [
        "f(a, b = 2) => a * b",
        "g(x) =>",
        "    y = x + 1",
        "    [y, y * 2]",
        "[m, s, h] = ta.macd(close, 12, 26, 9)",
        "for i = 0 to 10 by 2",
        "    continue",
        'plot(close, title="c", color=color.red)',
      ].join("\n")
    );
    expect(stmts.map((s) => s.kind)).toEqual([
      "func",
      "func",
      "tupleDecl",
      "for",
      "expr",
    ]);
    expect(stmts[0]).toMatchObject({
      params: [{ name: "a" }, { fallback: { value: 2 }, name: "b" }],
    });
    expect(stmts[1]).toMatchObject({
      body: [{ kind: "decl" }, { expr: { kind: "tuple" }, kind: "expr" }],
    });
    expect(stmts[4]).toMatchObject({
      expr: {
        args: [{ name: null }, { name: "title" }, { name: "color" }],
        callee: "plot",
        kind: "call",
      },
    });
  });

  it("reports parse errors with positions", () => {
    expect(errorOf('indicator("x")\nplot(close\n')).toEqual({
      column: 1,
      line: 3,
      message: "Expected ',' or ')' but found end of line",
    });
    expect(errorOf('indicator("x")\nx = \n')).toEqual({
      column: 5,
      line: 2,
      message: "Unexpected end of line",
    });
    expect(errorOf('indicator("x")\nelse\n    x = 1\n')).toMatchObject({
      column: 1,
      line: 2,
      message: "'else' without a matching 'if'",
    });
    expect(errorOf('indicator("x")\nif close > open\nx = 1\n')).toMatchObject({
      line: 3,
      message: "Expected an indented block (4 spaces or a tab)",
    });
    expect(errorOf('indicator("x")\n    x = 1\n')).toMatchObject({
      column: 5,
      line: 2,
      message: "Unexpected indentation",
    });
    expect(errorOf('indicator("x")\nx = (((1)\n')).toMatchObject({ line: 3 });
  });

  it("rejects pathological nesting without overflowing", () => {
    const deep = `${"(".repeat(500)}1${")".repeat(500)}`;
    expect(errorOf(`indicator("x")\nx = ${deep}\n`)).toMatchObject({
      message: "Expression is nested too deeply",
    });
  });
});
