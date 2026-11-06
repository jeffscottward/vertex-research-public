import { describe, expect, it } from "vitest";

import type { Expr, Stmt } from "./ast.ts";
import { ScriptFailure } from "./errors.ts";
import { parse } from "./parser.ts";

const parseError = (source: string) => {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ScriptFailure) {
      return { column: error.column, line: error.line, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a ScriptFailure");
};

const first = (source: string): Stmt => {
  const [stmt] = parse(source).body;
  if (!stmt) throw new Error("expected a statement");
  return stmt;
};

const exprOf = (source: string): Expr => {
  const stmt = first(source);
  if (stmt.kind !== "expr")
    throw new Error(`expected an expression, got ${stmt.kind}`);
  return stmt.expr;
};

describe("parser declarations", () => {
  it("parses typed declarations with qualifiers", () => {
    expect(first("series float x = 1\n")).toMatchObject({
      kind: "decl",
      name: "x",
      persistent: false,
      typeName: "float",
    });
    expect(first("var simple int x = 1\n")).toMatchObject({
      kind: "decl",
      persistent: true,
      typeName: "int",
    });
  });

  it("lets a qualifier word be a plain variable name", () => {
    expect(first("var series = 1\n")).toMatchObject({
      kind: "decl",
      name: "series",
      persistent: true,
      typeName: null,
    });
  });

  it("rejects unsupported declared types", () => {
    expect(parseError("var line l = na\n").message).toBe(
      "not supported in Vertex scripts yet: line"
    );
    expect(parseError("line l = na\n").message).toBe(
      "not supported in Vertex scripts yet: line"
    );
    expect(parseError("array<float> a = na\n").message).toBe(
      "not supported in Vertex scripts yet: array"
    );
  });

  it("allows unsupported type words as ordinary names", () => {
    expect(first("label = 1\n")).toMatchObject({ kind: "decl", name: "label" });
  });

  it("rejects an unknown type word before the name", () => {
    expect(parseError("var foo x = 1\n")).toEqual({
      column: 9,
      line: 1,
      message: "Expected '=' but found 'x'",
    });
  });
});

describe("parser tuples", () => {
  it("falls back to a tuple expression when '[' does not start a declaration", () => {
    expect(exprOf("[1, 2]\n")).toMatchObject({ kind: "tuple" });
    expect(exprOf("[a, 1]\n")).toMatchObject({ kind: "tuple" });
    expect(exprOf("[a + b]\n")).toMatchObject({ kind: "tuple" });
    expect(exprOf("[a, b]\n")).toMatchObject({ kind: "tuple" });
  });
});

describe("parser errors", () => {
  it("requires 'to' in a for loop", () => {
    expect(parseError("for i = 0 do 5\n")).toEqual({
      column: 11,
      line: 1,
      message: "Expected 'to' but found 'do'",
    });
  });

  it("requires a name where one is expected", () => {
    expect(parseError("for 1 = 0 to 2\n    x = 1\n").message).toBe(
      "Expected a loop variable but found '1'"
    );
    expect(parseError("var and = 1\n").message).toBe(
      "Expected a variable name but found 'and'"
    );
  });

  it("requires a new line before a block", () => {
    expect(parseError("if x y\n").message).toBe(
      "Expected a new indented line but found 'y'"
    );
  });

  it("rejects trailing tokens after a statement", () => {
    expect(parseError("x = 1 2\n").message).toBe("Unexpected '2'");
    expect(parseError('x = 1 "s"\n').message).toBe("Unexpected string");
  });

  it("rejects an operator where a value is expected", () => {
    expect(parseError("x = *\n").message).toBe("Unexpected '*'");
    expect(parseError("x = \n").message).toBe("Unexpected end of line");
  });

  it("rejects reserved words used as values", () => {
    expect(parseError("x = and\n").message).toBe("Unexpected 'and'");
  });

  it("requires a name after '.'", () => {
    expect(parseError("x = a.(1)\n").message).toBe(
      "Expected a name after '.' but found '('"
    );
  });

  it("caps deeply nested unary operators", () => {
    expect(parseError(`x = ${"-".repeat(70)}1\n`).message).toBe(
      "Expression is nested too deeply"
    );
  });

  it("parses unary plus and not", () => {
    expect(exprOf("+1\n")).toMatchObject({ kind: "unary", op: "+" });
    expect(exprOf("not a\n")).toMatchObject({ kind: "unary", op: "not" });
  });

  it("parses number literals with their int flag", () => {
    expect(exprOf("2.5\n")).toMatchObject({
      isInt: false,
      kind: "num",
      value: 2.5,
    });
    expect(exprOf("7\n")).toMatchObject({ isInt: true, kind: "num", value: 7 });
  });
});
