import { afterEach, describe, expect, it } from "vitest";

import type { Program, Stmt } from "./ast.ts";
import { BUILTIN_FUNCTIONS, type BuiltinFunction } from "./builtins.ts";
import { check } from "./checker.ts";
import { SCRIPT_STRING_MAX } from "./limits.ts";
import { parse } from "./parser.ts";

const HEADER = 'indicator("t")\n';

const compiled = (source: string) => {
  const result = check(parse(source));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.compiled;
};

const messages = (source: string) => {
  const result = check(parse(source));
  if (result.ok) throw new Error("expected check errors");
  return result.errors.map((error) => error.message);
};

const errorOf = (body: string) => messages(`${HEADER}${body}\n`)[0];

const inputOf = (body: string) => {
  const [spec] = compiled(`${HEADER}${body}\n`).declaration.inputs;
  if (!spec) throw new Error("expected an input");
  return spec;
};

// Test-only builtins registered in the shared registry, removed after each test.
const registry = BUILTIN_FUNCTIONS as Map<string, BuiltinFunction>;
const added: string[] = [];
const register = (name: string, spec: Omit<BuiltinFunction, "impl">) => {
  registry.set(name, { ...spec, impl: () => null });
  added.push(name);
};

afterEach(() => {
  for (const name of added.splice(0)) registry.delete(name);
});

describe("constant folding", () => {
  it("folds string concatenation and number arithmetic", () => {
    expect(compiled('indicator("a" + "b")\n').declaration.title).toBe("ab");
    expect(inputOf("x = input.int(1 + 2)").defval).toBe(3);
    expect(inputOf("x = input.int(5 - 2)").defval).toBe(3);
    expect(inputOf("x = input.int(2 * 3)").defval).toBe(6);
    expect(inputOf("x = input.float(3 / 2)").defval).toBe(1.5);
  });

  it("rejects mixed, unsupported and non-finite arithmetic", () => {
    expect(messages('indicator("a" + 1)\n')[0]).toBe(
      "indicator title must be a constant"
    );
    expect(errorOf('x = input(1 + "a")')).toBe(
      "input default value must be a constant"
    );
    expect(errorOf("x = input.int(5 % 2)")).toBe(
      "input.int default value must be a constant"
    );
    expect(errorOf("x = input.float(1 / 0)")).toBe(
      "input.float default value must be a constant"
    );
  });

  it("rejects concatenations longer than the string limit", () => {
    const half = "a".repeat(SCRIPT_STRING_MAX / 2 + 1);
    expect(messages(`indicator("${half}" + "${half}")\n`)[0]).toMatch(
      /too long/i
    );
  });

  it("folds unary operators", () => {
    expect(inputOf("x = input.int(-3)").defval).toBe(-3);
    expect(inputOf("x = input.float(+2.5)").defval).toBe(2.5);
    expect(inputOf("x = input.int(not 1)").defval).toBe(1);
    expect(
      compiled('indicator("t", overlay=not false)\n').declaration.overlay
    ).toBe(true);
    expect(errorOf('x = input.int(-"a")')).toBe(
      "input.int default value must be a constant"
    );
    expect(errorOf("x = input.int(-[1, 2])")).toBe(
      "input.int default value must be a constant"
    );
  });

  it("rejects non-constant expressions", () => {
    expect(messages('indicator(close > 1 ? "a" : "b")\n')[0]).toBe(
      "indicator title must be a constant"
    );
    expect(messages("indicator(1)\n")[0]).toBe(
      "indicator title must be a string"
    );
    expect(messages('indicator("t", overlay=1)\n')[0]).toBe(
      "indicator overlay must be true or false"
    );
  });

  it("treats na bounds as absent and rejects non-number bounds", () => {
    expect(inputOf("x = input.int(5, minval=na)")).not.toHaveProperty("min");
    expect(errorOf('x = input.int(5, minval="a")')).toBe(
      "minval must be a number"
    );
  });
});

describe("input defaults", () => {
  it("infers the kind of input() from its literal", () => {
    expect(inputOf("x = input(true)").kind).toBe("bool");
    expect(inputOf('x = input("abc")').kind).toBe("string");
    expect(inputOf("x = input(-5)").kind).toBe("int");
    expect(inputOf("x = input(-5.5)").kind).toBe("float");
    expect(inputOf("x = input(+5)").kind).toBe("float");
    expect(errorOf("x = input(na)")).toBe(
      "input() default must be a number, bool or string"
    );
  });

  it("validates typed defaults", () => {
    expect(errorOf("x = input.source(1)")).toBe(
      "input.source default must be a price source such as close"
    );
    expect(errorOf("x = input.int([1, 2])")).toBe(
      "Default value must be a constant"
    );
    expect(errorOf("x = input.color(1)")).toBe(
      "input.color default must be a color"
    );
    expect(errorOf('x = input.int("a")')).toBe(
      "input.int() default must be a number"
    );
    expect(errorOf("x = input.bool(1)")).toBe(
      "input.bool() default must be a bool"
    );
    expect(errorOf("x = input.string(1)")).toBe(
      "input.string() default must be a string"
    );
  });

  it("requires options to be a non-empty list", () => {
    expect(errorOf('x = input.string("a", options=1)')).toBe(
      "options must be a [ ... ] list"
    );
    expect(errorOf('x = input.string("a", options=[])')).toBe(
      "options must be a [ ... ] list"
    );
  });

  it("derives unique ids for unnamed and colliding inputs", () => {
    const { inputs } = compiled(
      `${HEADER}a = input(1)\nplot(input(2))\ninput_1 = input(3)\n`
    ).declaration;
    expect(inputs.map((input) => input.id)).toEqual([
      "a",
      "input_1",
      "input_1_2",
    ]);
  });

  it("falls back to auto kind and requires a default for custom input specs", () => {
    register("zz.input", {
      arity: [0, 2],
      kind: "input",
      params: ["title", "defval"],
    });
    expect(inputOf('x = zz.input("T", 4)')).toMatchObject({
      defval: 4,
      kind: "int",
    });
    expect(errorOf("x = zz.input()")).toBe("zz.input() needs a default value");
  });
});

describe("length arguments", () => {
  it("rejects price-like lengths through unary, ternary and input()", () => {
    const priceError =
      "ta.sma: 'length' must be a whole number, not a price series (missing an argument?)";
    expect(errorOf("x = ta.sma(close, -close)")).toBe(priceError);
    expect(errorOf("c = true\nx = ta.sma(close, c ? close : 5)")).toBe(
      priceError
    );
    expect(errorOf("c = true\nx = ta.sma(close, c ? 5 : close)")).toBe(
      priceError
    );
    expect(
      compiled(`${HEADER}c = true\nx = ta.sma(close, c ? 5 : 6)\n`)
    ).toBeTruthy();
    expect(
      compiled(`${HEADER}c = true\nx = ta.sma(close, not c)\n`)
    ).toBeTruthy();
    expect(compiled(`${HEADER}x = ta.sma(close, input(14))\n`)).toBeTruthy();
    expect(
      compiled(`${HEADER}x = ta.sma(close, input(math.pi))\n`)
    ).toBeTruthy();
  });

  it("skips omitted length slots and names extra slots 'length'", () => {
    register("zz.len", {
      arity: [1, Number.POSITIVE_INFINITY],
      kind: "pure",
      lengths: () => [1, 2],
      params: ["source"],
    });
    expect(compiled(`${HEADER}x = zz.len(close)\n`)).toBeTruthy();
    expect(errorOf("x = zz.len(close, 1, close)")).toBe(
      "zz.len: 'length' must be a whole number, not a price series (missing an argument?)"
    );
  });
});

describe("statement rules", () => {
  it("records at most 20 errors", () => {
    const body = Array.from({ length: 25 }, () => "plot(zzz)").join("\n");
    expect(messages(`${HEADER}${body}\n`)).toHaveLength(20);
  });

  it("rethrows unexpected internal errors", () => {
    const program: Program = {
      body: [{ kind: "decl", name: "x", value: null } as unknown as Stmt],
      nodeCount: 1,
      version: null,
    };
    expect(() => check(program)).toThrow(TypeError);
  });

  it("enforces tuple, loop and scope rules", () => {
    expect(errorOf("[a, b] = 1")).toBe(
      "A tuple declaration needs a function call on the right"
    );
    expect(errorOf("x = [1, 2]")).toBe(
      "A [ ... ] tuple can only be returned from a function"
    );
    expect(errorOf("break")).toBe("'break' is only allowed inside a for loop");
    expect(errorOf('if true\n    indicator("x")')).toBe(
      "'indicator' is only allowed at the top level, not inside if, for or functions"
    );
    expect(errorOf("for i = 0 to 3\n    i := 2")).toBe(
      "Cannot modify loop variable 'i'"
    );
    expect(errorOf('x = indicator("y")')).toBe(
      "indicator() must be its own statement"
    );
  });

  it("enforces function definition rules", () => {
    expect(errorOf("if true\n    f() => 1")).toBe(
      "Functions can only be defined at the top level"
    );
    expect(errorOf("plot(x) => x")).toBe("'plot' is a built-in function");
    expect(errorOf("f() => 1\nf() => 2")).toBe(
      "Function 'f' is already defined"
    );
    expect(errorOf("f(a, a) => a")).toBe("Duplicate parameter 'a'");
  });

  it("rejects a function with an empty body", () => {
    const program = parse(`${HEADER}f() => 1\n`);
    const emptied: Program = {
      ...program,
      body: program.body.map((stmt) =>
        stmt.kind === "func" ? { ...stmt, body: [] } : stmt
      ),
    };
    const result = check(emptied);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((e) => e.message)).toEqual([
      "Function 'f' has an empty body",
    ]);
  });

  it("rejects functions used as values and unknown fields", () => {
    expect(errorOf("x = plot")).toBe("'plot' is a function; call it with ( )");
    expect(errorOf("f() => 1\nx = f")).toBe(
      "'f' is a function; call it with ( )"
    );
    expect(errorOf("x = zzz.bar")).toBe("Undeclared identifier 'zzz.bar'");
  });
});

describe("calls, declarations and plots", () => {
  it("reports arity for variadic builtins", () => {
    expect(errorOf("x = math.max()")).toBe(
      "'math.max' expects at least 1 arguments, got 0"
    );
  });

  it("rejects duplicate named arguments", () => {
    expect(errorOf('plot(close, title="a", title="b")')).toBe(
      "Argument 'title' is given twice"
    );
  });

  it("requires a non-blank title", () => {
    expect(messages('indicator("  ")\n')[0]).toBe("indicator() needs a title");
  });

  it("titles hlines by level", () => {
    const { plots } = compiled(`${HEADER}hline(50)\n`);
    expect([...plots.values()].map((plot) => plot.title)).toEqual(["Level 1"]);
  });
});
