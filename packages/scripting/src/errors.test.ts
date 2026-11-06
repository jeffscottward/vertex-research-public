import { describe, expect, it } from "vitest";

import { fail, ScriptFailure, toScriptError, unsupported } from "./errors.ts";

describe("toScriptError", () => {
  it("keeps the position of a ScriptFailure", () => {
    expect(
      toScriptError(new ScriptFailure("bad", { column: 4, line: 2 }))
    ).toEqual({ column: 4, line: 2, message: "bad" });
  });

  it("maps stack overflows to a nesting message", () => {
    expect(
      toScriptError(new RangeError("Maximum call stack size exceeded"))
    ).toEqual({ column: 1, line: 1, message: "Script is nested too deeply" });
  });

  it("hides any other thrown value behind a generic message", () => {
    expect(toScriptError(new TypeError("x is undefined"))).toEqual({
      column: 1,
      line: 1,
      message: "Internal script error",
    });
    expect(toScriptError("boom")).toEqual({
      column: 1,
      line: 1,
      message: "Internal script error",
    });
  });
});

describe("fail helpers", () => {
  it("throw positioned ScriptFailures", () => {
    const at = { column: 3, line: 7 };
    expect(() => fail("nope", at)).toThrow(ScriptFailure);
    expect(() => unsupported("while", at)).toThrow(
      "not supported in Vertex scripts yet: while"
    );
  });
});
