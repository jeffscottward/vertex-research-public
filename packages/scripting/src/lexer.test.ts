import { describe, expect, it } from "vitest";

import { ScriptFailure } from "./errors.ts";
import { tokenize } from "./lexer.ts";
import { SCRIPT_STRING_MAX } from "./limits.ts";

const kinds = (source: string) =>
  tokenize(source).tokens.map((t) =>
    t.kind === "op" || t.kind === "ident" ? t.value : t.kind
  );

const lexError = (source: string) => {
  try {
    tokenize(source);
  } catch (error) {
    if (error instanceof ScriptFailure) {
      return { column: error.column, line: error.line, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a ScriptFailure");
};

describe("lexer edge cases", () => {
  it("emits only EOF for an empty or comment-only source", () => {
    expect(kinds("")).toEqual(["eof"]);
    expect(kinds("// just a note")).toEqual(["eof"]);
    expect(kinds("\n\n   \n")).toEqual(["eof"]);
  });

  it("reads //@version from a final comment line without a newline", () => {
    const result = tokenize("x = 1\n//@version=5");
    expect(result.version).toBe(5);
    expect(result.tokens.map((t) => t.kind)).toEqual([
      "ident",
      "op",
      "num",
      "newline",
      "eof",
    ]);
    expect(tokenize("//@version=6").version).toBe(6);
  });

  it("strips trailing comments, including at end of input", () => {
    expect(kinds("x = 1 // trailing")).toEqual([
      "x",
      "=",
      "num",
      "newline",
      "eof",
    ]);
    expect(kinds("x = 1 // trailing\ny = 2")).toEqual([
      "x",
      "=",
      "num",
      "newline",
      "y",
      "=",
      "num",
      "newline",
      "eof",
    ]);
  });

  it("rejects an unsupported //@version", () => {
    expect(lexError("//@version=4\n").message).toMatch(/version=5/);
  });

  it("rejects a first line indented by a non-multiple of 4", () => {
    expect(lexError("  x = 1\n")).toEqual({
      column: 3,
      line: 1,
      message: "Unexpected indentation",
    });
  });

  it("rejects an indent that skips a level", () => {
    expect(lexError("if a\n        b = 1\n").message).toBe(
      "Unexpected indentation"
    );
  });

  it("parses leading-dot numbers, exponents and int detection", () => {
    const [dot, exp, int] = tokenize(".5 1e3 42").tokens;
    expect(dot).toMatchObject({
      isInt: false,
      kind: "num",
      num: 0.5,
      value: ".5",
    });
    expect(exp).toMatchObject({ isInt: false, num: 1000 });
    expect(int).toMatchObject({ isInt: true, num: 42 });
  });

  it("treats a lone '.' as an operator, not a number", () => {
    expect(kinds("a.b")).toEqual(["a", ".", "b", "newline", "eof"]);
  });

  it("rejects numbers that overflow to infinity", () => {
    expect(lexError("x = 1e999\n")).toEqual({
      column: 5,
      line: 1,
      message: "Invalid number",
    });
  });

  it("decodes known escapes and keeps unknown escaped characters", () => {
    const [str] = tokenize("'a\\'b\\\"c\\\\d\\ne\\tf\\qg'").tokens;
    expect(str).toMatchObject({ kind: "str", value: "a'b\"c\\d\ne\tfqg" });
  });

  it("rejects strings ending in a lone backslash or a newline", () => {
    expect(lexError('"abc\\').message).toBe("Unterminated string");
    expect(lexError('"abc\nx"').message).toBe("Unterminated string");
  });

  it("rejects over-long string literals", () => {
    const long = "a".repeat(SCRIPT_STRING_MAX + 1);
    expect(lexError(`x = "${long}"\n`).message).toMatch(/too long/i);
  });

  it("normalizes 6- and 8-digit colors and rejects malformed ones", () => {
    const tokens = tokenize("#AABBCC #11223344").tokens;
    expect(tokens[0]).toMatchObject({ kind: "color", value: "#aabbcc" });
    expect(tokens[1]).toMatchObject({ kind: "color", value: "#112233" });
    expect(lexError("x = #abc\n").message).toMatch(/Invalid color/);
  });

  it("rejects unknown characters", () => {
    expect(lexError("x = 1 @ 2").message).toBe("Unexpected character '@'");
  });

  it("joins lines inside brackets and continuation lines", () => {
    expect(kinds("plot(1,\n2)\n")).toEqual([
      "plot",
      "(",
      "num",
      ",",
      "num",
      ")",
      "newline",
      "eof",
    ]);
    expect(kinds("x = 1 +\n  2\n")).toEqual([
      "x",
      "=",
      "num",
      "+",
      "num",
      "newline",
      "eof",
    ]);
  });

  it("does not go below zero depth on stray closers", () => {
    expect(kinds(")\nx")).toEqual([")", "newline", "x", "newline", "eof"]);
  });

  it("normalizes CRLF and CR line endings", () => {
    expect(kinds("a\r\nb\rc")).toEqual([
      "a",
      "newline",
      "b",
      "newline",
      "c",
      "newline",
      "eof",
    ]);
  });

  it("closes open blocks with DEDENT at the end of input", () => {
    expect(kinds("if a\n    if b\n        c")).toEqual([
      "if",
      "a",
      "newline",
      "indent",
      "if",
      "b",
      "newline",
      "indent",
      "c",
      "newline",
      "dedent",
      "dedent",
      "eof",
    ]);
  });
});
