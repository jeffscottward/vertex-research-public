// Semantic pass: resolves every name and call against user scopes and the builtin registry,
// enforces Pine's scope rules, and extracts the declaration, input specs and plot slots.

import type { Arg, Binary, Call, Expr, FuncDef, Program, Stmt } from "./ast.ts";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_VARIABLES,
  type BuiltinFunction,
  type BuiltinVariable,
  CONSTANTS,
  GLOBAL_ONLY,
  type InputKind,
  ignoredWarning,
  PINE_NAMESPACES,
  SOURCES,
} from "./builtins.ts";
import {
  fail,
  type Position,
  ScriptFailure,
  START,
  unsupported,
} from "./errors.ts";
import {
  clip,
  SCRIPT_INPUT_ID_MAX,
  SCRIPT_INPUT_STRING_MAX,
  SCRIPT_INPUTS_MAX,
  SCRIPT_LABEL_MAX,
  SCRIPT_OPTION_MAX,
  SCRIPT_OPTIONS_MAX,
  SCRIPT_PLOTS_MAX,
  SCRIPT_STRING_MAX,
  SCRIPT_TITLE_MAX,
  STRING_TOO_LONG,
} from "./limits.ts";
import type {
  ScriptDeclaration,
  ScriptError,
  ScriptInputSpec,
  ScriptPlotKind,
} from "./types.ts";
import { color, isColor, type Scalar, type Value } from "./values.ts";

export type NameRef =
  | Readonly<{ kind: "user" }>
  | Readonly<{ kind: "variable"; read: BuiltinVariable }>
  | Readonly<{ kind: "constant"; value: Value }>;

export type OrderedArgs = readonly (Expr | undefined)[];

export type ResolvedCall =
  | Readonly<{
      kind: "builtin";
      name: string;
      spec: BuiltinFunction;
      args: OrderedArgs;
    }>
  | Readonly<{ kind: "user"; fn: FuncDef; args: OrderedArgs }>;

export type InputSlot = Readonly<{
  // null: accepted but not user-editable (input.color).
  spec: ScriptInputSpec | null;
  value: Value;
}>;

export type PlotSlot = Readonly<{
  index: number;
  title: string;
  kind: ScriptPlotKind;
  color: string;
  offset: number;
}>;

export type Compiled = Readonly<{
  program: Program;
  declaration: ScriptDeclaration;
  names: ReadonlyMap<number, NameRef>;
  calls: ReadonlyMap<number, ResolvedCall>;
  inputs: ReadonlyMap<number, InputSlot>;
  plots: ReadonlyMap<number, PlotSlot>;
  warnings: readonly string[];
}>;

export type CheckResult =
  | Readonly<{ ok: true; compiled: Compiled }>
  | Readonly<{ ok: false; errors: readonly ScriptError[] }>;

type Binding = Readonly<{
  kind: "var" | "param" | "loop";
  global: boolean;
  // Declared from a price series (close, input.source, ta.sma(...)): never a length.
  price?: boolean;
}>;

class Scope {
  readonly names = new Map<string, Binding>();
  readonly parent: Scope | null;

  constructor(parent: Scope | null) {
    this.parent = parent;
  }

  lookup(name: string): Binding | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }
}

type Where = Readonly<{
  scope: Scope;
  local: boolean;
  inFunction: boolean;
  loops: number;
}>;

const MAX_ERRORS = 20;
const DEFAULT_PLOT_COLOR = "#2962ff";
const DEFAULT_HLINE_COLOR = "#787b86";
// Maps, not object literals: user strings such as "constructor" must not hit a prototype.
const PLOT_STYLES: ReadonlyMap<string, ScriptPlotKind> = new Map([
  ["style_area", "line"],
  ["style_areabr", "line"],
  ["style_circles", "circles"],
  ["style_columns", "histogram"],
  ["style_cross", "circles"],
  ["style_histogram", "histogram"],
  ["style_line", "line"],
  ["style_linebr", "line"],
  ["style_stepline", "line"],
  ["style_stepline_diamond", "line"],
]);
const CONST_ARITHMETIC: ReadonlyMap<string, (a: number, b: number) => number> =
  new Map([
    ["+", (a: number, b: number) => a + b],
    ["-", (a: number, b: number) => a - b],
    ["*", (a: number, b: number) => a * b],
    ["/", (a: number, b: number) => a / b],
  ]);

const arityMessage = (
  name: string,
  spec: BuiltinFunction["arity"],
  got: number
) => {
  const [min, max] = spec;
  let expected: string;
  if (max === Number.POSITIVE_INFINITY) expected = `at least ${min}`;
  else if (min === max) expected = `${min}`;
  else expected = `${min} to ${max}`;
  const noun = max === 1 && min === 1 ? "argument" : "arguments";
  return `'${name}' expects ${expected} ${noun}, got ${got}`;
};

const isIntLiteral = (expr: Expr): boolean =>
  (expr.kind === "num" && expr.isInt) ||
  (expr.kind === "unary" && expr.op === "-" && isIntLiteral(expr.operand));

const constBinary = (
  expr: Binary,
  left: Scalar,
  right: Scalar,
  what: string
): Scalar => {
  const { op } = expr;
  if (typeof left === "string" && typeof right === "string" && op === "+") {
    if (left.length + right.length > SCRIPT_STRING_MAX) {
      return fail(STRING_TOO_LONG, expr);
    }
    return left + right;
  }
  if (typeof left !== "number" || typeof right !== "number") {
    return fail(`${what} must be a constant`, expr);
  }
  const value = CONST_ARITHMETIC.get(op)?.(left, right);
  if (value === undefined || !Number.isFinite(value)) {
    return fail(`${what} must be a constant`, expr);
  }
  return value;
};

// Compile-time constant folding for declaration, input and plot-title arguments.
const constEval = (expr: Expr, what: string): Scalar | Scalar[] => {
  const scalar = (e: Expr): Scalar => {
    const value = constEval(e, what);
    if (Array.isArray(value)) return fail(`${what} must be a constant`, e);
    return value as Scalar;
  };
  switch (expr.kind) {
    case "num":
    case "str":
    case "bool":
      return expr.value;
    case "na":
      return null;
    case "color":
      return color(expr.hex);
    case "name": {
      const value = CONSTANTS.get(expr.name);
      if (value === undefined) return fail(`${what} must be a constant`, expr);
      return value as Scalar;
    }
    case "unary": {
      const operand = scalar(expr.operand);
      if (expr.op === "not" && typeof operand === "boolean") return !operand;
      if (typeof operand === "number")
        return expr.op === "-" ? -operand : operand;
      return fail(`${what} must be a constant`, expr);
    }
    case "binary":
      return constBinary(expr, scalar(expr.left), scalar(expr.right), what);
    case "tuple":
      return expr.items.map(scalar);
    default:
      return fail(`${what} must be a constant`, expr);
  }
};

const requireString = (expr: Expr, what: string): string => {
  const value = constEval(expr, what);
  if (typeof value !== "string") return fail(`${what} must be a string`, expr);
  return value;
};

const constString = (expr: Expr | undefined, what: string): string | null =>
  expr ? requireString(expr, what) : null;

const constNumber = (expr: Expr | undefined, what: string): number | null => {
  if (!expr) return null;
  const value = constEval(expr, what);
  if (value === null) return null;
  if (typeof value !== "number") return fail(`${what} must be a number`, expr);
  return value;
};

const constBool = (expr: Expr | undefined, what: string, fallback: boolean) => {
  if (!expr) return fallback;
  const value = constEval(expr, what);
  if (typeof value !== "boolean")
    return fail(`${what} must be true or false`, expr);
  return value;
};

type InputDefault = Readonly<{
  kind: ScriptInputSpec["kind"] | "color";
  defval: Scalar;
}>;

const DEFVAL_TYPE: Readonly<Record<ScriptInputSpec["kind"], string>> = {
  bool: "boolean",
  float: "number",
  int: "number",
  source: "string",
  string: "string",
};

// input(defval): the kind follows the literal (14 -> int, 1.5 -> float).
const autoKind = (defval: Scalar, expr: Expr): ScriptInputSpec["kind"] => {
  if (typeof defval === "boolean") return "bool";
  if (typeof defval === "string") return "string";
  if (typeof defval === "number") return isIntLiteral(expr) ? "int" : "float";
  throw new ScriptFailure(
    "input() default must be a number, bool or string",
    expr
  );
};

const inputDefault = (
  callee: string,
  declared: InputKind,
  expr: Expr
): InputDefault => {
  const sourceName = expr.kind === "name" ? expr.name : "";
  if (
    (declared === "auto" || declared === "source") &&
    SOURCES.has(sourceName)
  ) {
    return { defval: sourceName, kind: "source" };
  }
  if (declared === "source") {
    throw new ScriptFailure(
      "input.source default must be a price source such as close",
      expr
    );
  }
  const value = constEval(expr, `${callee} default value`);
  if (Array.isArray(value)) {
    throw new ScriptFailure("Default value must be a constant", expr);
  }
  const defval = value as Scalar;
  if (declared === "color") {
    if (!isColor(defval)) {
      throw new ScriptFailure("input.color default must be a color", expr);
    }
    return { defval, kind: "color" };
  }
  const kind = declared === "auto" ? autoKind(defval, expr) : declared;
  const expected = DEFVAL_TYPE[kind];
  if (typeof defval !== expected) {
    const noun = expected === "boolean" ? "bool" : expected;
    throw new ScriptFailure(`${callee}() default must be a ${noun}`, expr);
  }
  return { defval, kind };
};

// Options are clipped to SCRIPT_OPTIONS_MAX entries of SCRIPT_OPTION_MAX characters.
const inputOptions = (
  expr: Expr | undefined,
  defval: Scalar,
  defvalExpr: Expr,
  warn: (message: string) => void
): string[] | null => {
  if (!expr) return null;
  const list = constEval(expr, "options");
  if (!Array.isArray(list) || list.length === 0) {
    throw new ScriptFailure("options must be a [ ... ] list", expr);
  }
  let options = (list as Scalar[]).map((item) => String(item));
  if (options.length > SCRIPT_OPTIONS_MAX) {
    warn(`options cut to the first ${SCRIPT_OPTIONS_MAX}`);
    options = options.slice(0, SCRIPT_OPTIONS_MAX);
  }
  if (options.some((option) => option.length > SCRIPT_OPTION_MAX)) {
    warn(`options shortened to ${SCRIPT_OPTION_MAX} characters`);
    options = options.map((option) => clip(option, SCRIPT_OPTION_MAX));
  }
  if (!options.includes(clip(String(defval), SCRIPT_OPTION_MAX))) {
    throw new ScriptFailure(
      "Default value must be one of the options",
      defvalExpr
    );
  }
  return options;
};

// Price-valued calls; the other ta.* results (bools, bar counts) can be lengths.
const NON_PRICE_CALLS: ReadonlySet<string> = new Set([
  "ta.barssince",
  "ta.cross",
  "ta.crossover",
  "ta.crossunder",
]);
const PRICE_VARIABLES: ReadonlySet<string> = new Set(["ta.tr", "ta.obv"]);

// Conservative static check: true only for expressions that are certainly a price series.
const priceLike = (expr: Expr, scope: Scope): boolean => {
  switch (expr.kind) {
    case "name": {
      const binding = scope.lookup(expr.name);
      if (binding) return binding.price === true;
      return SOURCES.has(expr.name) || PRICE_VARIABLES.has(expr.name);
    }
    case "history":
      return priceLike(expr.target, scope);
    case "unary":
      return expr.op !== "not" && priceLike(expr.operand, scope);
    case "binary":
      return (
        CONST_ARITHMETIC.has(expr.op) &&
        (priceLike(expr.left, scope) || priceLike(expr.right, scope))
      );
    case "ternary":
      return (
        priceLike(expr.whenTrue, scope) || priceLike(expr.whenFalse, scope)
      );
    case "call": {
      if (expr.callee === "input.source") return true;
      if (expr.callee === "input") {
        const first = expr.args[0]?.value;
        return first?.kind === "name" && SOURCES.has(first.name);
      }
      return expr.callee.startsWith("ta.") && !NON_PRICE_CALLS.has(expr.callee);
    }
    default:
      return false;
  }
};

class Checker {
  private readonly program: Program;
  private readonly errors: ScriptError[] = [];
  private readonly names = new Map<number, NameRef>();
  private readonly calls = new Map<number, ResolvedCall>();
  private readonly inputs = new Map<number, InputSlot>();
  private readonly plots = new Map<number, PlotSlot>();
  private readonly functions = new Map<string, FuncDef>();
  private readonly warnings = new Set<string>();
  private readonly inputIds = new Set<string>();
  private readonly isStrategy: boolean;
  private declaration: Omit<ScriptDeclaration, "inputs"> | null = null;
  private defining: string | null = null;
  private plotCount = 0;

  constructor(program: Program) {
    this.program = program;
    this.isStrategy = program.body.some(
      (stmt) =>
        stmt.kind === "expr" &&
        stmt.expr.kind === "call" &&
        stmt.expr.callee === "strategy"
    );
  }

  run(): CheckResult {
    const global = new Scope(null);
    const where: Where = {
      inFunction: false,
      local: false,
      loops: 0,
      scope: global,
    };
    this.block(this.program.body, where, false);
    if (!this.declaration && this.errors.length === 0) {
      this.errors.push({
        ...START,
        message: "Script must declare indicator() or strategy()",
      });
    }
    if (this.errors.length > 0 || !this.declaration) {
      return { errors: this.errors.slice(0, MAX_ERRORS), ok: false };
    }
    const inputs: ScriptInputSpec[] = [];
    for (const slot of this.inputs.values())
      if (slot.spec) inputs.push(slot.spec);
    return {
      compiled: {
        calls: this.calls,
        declaration: { ...this.declaration, inputs },
        inputs: this.inputs,
        names: this.names,
        plots: this.plots,
        program: this.program,
        warnings: [...this.warnings],
      },
      ok: true,
    };
  }

  // Statements: one error per statement is recorded and checking continues.
  private block(
    body: readonly Stmt[],
    where: Where,
    returnsValue: boolean
  ): void {
    for (const [i, stmt] of body.entries()) {
      const tupleOk = returnsValue && i === body.length - 1;
      try {
        this.statement(stmt, where, tupleOk);
      } catch (error) {
        if (!(error instanceof ScriptFailure)) throw error;
        if (this.errors.length < MAX_ERRORS) {
          this.errors.push({
            column: error.column,
            line: error.line,
            message: error.message,
          });
        }
        // Keep the name so later uses do not cascade into "undeclared" errors.
        if (stmt.kind === "decl" && !where.scope.names.has(stmt.name)) {
          this.bind(where, stmt.name, "var", stmt);
        }
      }
    }
  }

  private statement(stmt: Stmt, where: Where, tupleOk: boolean): void {
    switch (stmt.kind) {
      case "expr":
        this.exprStatement(stmt.expr, where, tupleOk);
        return;
      case "decl":
        this.expr(stmt.value, where, false, stmt.name);
        this.bind(
          where,
          stmt.name,
          "var",
          stmt,
          priceLike(stmt.value, where.scope)
        );
        return;
      case "tupleDecl":
        if (stmt.value.kind !== "call") {
          fail(
            "A tuple declaration needs a function call on the right",
            stmt.value
          );
        }
        this.expr(stmt.value, where, false);
        for (const target of stmt.targets)
          this.bind(
            where,
            target.name,
            "var",
            target,
            priceLike(stmt.value, where.scope)
          );
        return;
      case "assign":
        this.assign(stmt.name, stmt.op, stmt, where);
        this.expr(stmt.value, where, false);
        return;
      case "if": {
        this.expr(stmt.cond, where, false);
        const inner = { ...where, local: true };
        this.block(
          stmt.then,
          { ...inner, scope: new Scope(where.scope) },
          false
        );
        if (stmt.otherwise) {
          this.block(
            stmt.otherwise,
            { ...inner, scope: new Scope(where.scope) },
            false
          );
        }
        return;
      }
      case "for": {
        this.expr(stmt.from, where, false);
        this.expr(stmt.to, where, false);
        if (stmt.step) this.expr(stmt.step, where, false);
        const scope = new Scope(where.scope);
        scope.names.set(stmt.variable, { global: false, kind: "loop" });
        this.block(
          stmt.body,
          { ...where, local: true, loops: where.loops + 1, scope },
          false
        );
        return;
      }
      case "func":
        this.functionDef(stmt, where);
        return;
      case "break":
      case "continue":
        if (where.loops === 0)
          fail(`'${stmt.kind}' is only allowed inside a for loop`, stmt);
        return;
    }
  }

  private exprStatement(expr: Expr, where: Where, tupleOk: boolean): void {
    if (
      expr.kind === "call" &&
      BUILTIN_FUNCTIONS.get(expr.callee)?.kind === "declaration"
    ) {
      if (where.local) this.globalOnly(expr.callee, expr);
      this.declare(expr);
      return;
    }
    this.expr(expr, where, tupleOk);
  }

  private bind(
    where: Where,
    name: string,
    kind: Binding["kind"],
    at: Position,
    price = false
  ): void {
    if (where.scope.names.has(name)) fail(`'${name}' is already declared`, at);
    where.scope.names.set(name, { global: !where.local, kind, price });
  }

  private assign(name: string, op: string, at: Position, where: Where): void {
    const binding = where.scope.lookup(name);
    if (!binding)
      fail(`'${name}' must be declared with '=' before '${op}'`, at);
    if (binding?.kind === "param")
      fail(`Cannot modify function parameter '${name}'`, at);
    if (binding?.kind === "loop")
      fail(`Cannot modify loop variable '${name}'`, at);
    if (where.inFunction && binding?.global) {
      fail(`Cannot modify global variable '${name}' inside a function`, at);
    }
  }

  private functionDef(fn: FuncDef, where: Where): void {
    if (where.local) fail("Functions can only be defined at the top level", fn);
    if (BUILTIN_FUNCTIONS.has(fn.name))
      fail(`'${fn.name}' is a built-in function`, fn);
    if (this.functions.has(fn.name))
      fail(`Function '${fn.name}' is already defined`, fn);
    // Functions see the globals declared before them (a snapshot), never later ones.
    const snapshot = new Scope(null);
    for (const [name, binding] of where.scope.names)
      snapshot.names.set(name, binding);
    const scope = new Scope(snapshot);
    for (const param of fn.params) {
      if (scope.names.has(param.name))
        fail(`Duplicate parameter '${param.name}'`, param);
      if (param.fallback) {
        constEval(param.fallback, `Default value of '${param.name}'`);
        // Record the constant names it uses (math.pi, color.red) for the runtime.
        this.expr(param.fallback, { ...where, scope: snapshot }, false);
      }
      scope.names.set(param.name, { global: false, kind: "param" });
    }
    this.defining = fn.name;
    try {
      this.block(
        fn.body,
        { inFunction: true, local: true, loops: 0, scope },
        true
      );
    } finally {
      this.defining = null;
    }
    if (fn.body.length === 0)
      fail(`Function '${fn.name}' has an empty body`, fn);
    this.functions.set(fn.name, fn);
  }

  // Expressions ----------------------------------------------------------

  private expr(
    expr: Expr,
    where: Where,
    tupleOk: boolean,
    idHint?: string
  ): void {
    switch (expr.kind) {
      case "num":
      case "str":
      case "bool":
      case "na":
      case "color":
        return;
      case "name":
        this.name(expr.name, expr.id, expr, where.scope);
        return;
      case "history":
        this.expr(expr.target, where, false);
        this.expr(expr.offset, where, false);
        return;
      case "unary":
        this.expr(expr.operand, where, false);
        return;
      case "binary":
        this.expr(expr.left, where, false);
        this.expr(expr.right, where, false);
        return;
      case "ternary":
        this.expr(expr.cond, where, false);
        this.expr(expr.whenTrue, where, false);
        this.expr(expr.whenFalse, where, false);
        return;
      case "tuple":
        if (!tupleOk)
          fail("A [ ... ] tuple can only be returned from a function", expr);
        for (const item of expr.items) this.expr(item, where, false);
        return;
      case "call":
        this.call(expr, where, idHint);
        return;
    }
  }

  private name(name: string, id: number, at: Position, scope: Scope): void {
    if (scope.lookup(name)) {
      this.names.set(id, { kind: "user" });
      return;
    }
    const read = BUILTIN_VARIABLES.get(name);
    if (read) {
      this.names.set(id, { kind: "variable", read });
      return;
    }
    const value = CONSTANTS.get(name);
    if (value !== undefined) {
      this.names.set(id, { kind: "constant", value });
      return;
    }
    if (this.functions.has(name) || BUILTIN_FUNCTIONS.has(name)) {
      fail(`'${name}' is a function; call it with ( )`, at);
    }
    this.unknown(name, at, scope, `Undeclared identifier '${name}'`);
  }

  private unknown(
    name: string,
    at: Position,
    scope: Scope,
    message: string
  ): never {
    const dot = name.indexOf(".");
    if (dot !== -1) {
      const root = name.slice(0, dot);
      if (PINE_NAMESPACES.has(root)) unsupported(name, at);
      if (scope.lookup(root)) unsupported("methods and fields", at);
    }
    return fail(message, at);
  }

  private globalOnly(name: string, at: Position): never {
    return fail(
      `'${name}' is only allowed at the top level, not inside if, for or functions`,
      at
    );
  }

  private call(call: Call, where: Where, idHint?: string): void {
    if (call.callee === this.defining)
      fail("Recursive functions are not supported", call);
    const fn = this.functions.get(call.callee);
    if (fn) {
      const params = fn.params.map((p) => p.name);
      const min = fn.params.filter((p) => !p.fallback).length;
      const args = this.order(
        call.callee,
        params,
        [min, params.length],
        call.args,
        call
      );
      for (const arg of call.args) this.expr(arg.value, where, false);
      this.calls.set(call.id, { args, fn, kind: "user" });
      return;
    }
    const spec = BUILTIN_FUNCTIONS.get(call.callee);
    if (!spec) {
      this.unknown(
        call.callee,
        call,
        where.scope,
        `Unknown function '${call.callee}'`
      );
    }
    if (where.local && GLOBAL_ONLY.has(spec.kind))
      this.globalOnly(call.callee, call);
    if (spec.strategyOnly && !this.isStrategy) {
      fail(`'${call.callee}' needs a strategy() declaration`, call);
    }
    const args = this.order(
      call.callee,
      spec.params,
      spec.arity,
      call.args,
      call
    );
    this.calls.set(call.id, { args, kind: "builtin", name: call.callee, spec });
    this.checkLengths(call, spec, args, where.scope);
    switch (spec.kind) {
      case "declaration":
        throw new ScriptFailure(
          `${call.callee}() must be its own statement`,
          call
        );
      case "input":
        this.input(call, spec, args, idHint);
        return;
      case "ignored":
        this.warnings.add(ignoredWarning(call.callee));
        return;
      case "output":
        if (call.callee === "plot" || call.callee === "hline")
          this.plot(call, args);
        break;
      default:
        break;
    }
    for (const arg of call.args) this.expr(arg.value, where, false);
  }

  // Pine types lengths as int; a price series there means a forgotten argument.
  private checkLengths(
    call: Call,
    spec: BuiltinFunction,
    args: OrderedArgs,
    scope: Scope
  ): void {
    if (!spec.lengths) return;
    const slots = spec.lengths(args.map((arg) => arg !== undefined));
    const shift = slots[0] === 0 && spec.params[0] === "source" ? 1 : 0;
    for (const slot of slots) {
      // Point at where the argument starts, not at an operator inside it.
      const given = call.args.find(
        (candidate) => candidate.value === args[slot]
      );
      if (given && priceLike(given.value, scope)) {
        const param = spec.params[slot + shift] ?? "length";
        fail(
          `${call.callee}: '${param}' must be a whole number, not a price series (missing an argument?)`,
          given
        );
      }
    }
  }

  // Positional then named arguments -> one slot per parameter.
  private order(
    name: string,
    params: readonly string[],
    arity: BuiltinFunction["arity"],
    args: readonly Arg[],
    at: Position
  ): OrderedArgs {
    const positional = args.filter((arg) => arg.name === null).length;
    const out: (Expr | undefined)[] = Array.from(
      { length: Math.max(params.length, positional) },
      () => undefined
    );
    let index = 0;
    let named = false;
    for (const arg of args) {
      if (arg.name === null) {
        if (named) fail("Positional argument after a named argument", arg);
        out[index++] = arg.value;
        continue;
      }
      named = true;
      const slot = params.indexOf(arg.name);
      if (slot === -1)
        fail(`'${name}' has no argument named '${arg.name}'`, arg);
      if (out[slot] !== undefined)
        fail(`Argument '${arg.name}' is given twice`, arg);
      out[slot] = arg.value;
    }
    const [min, max] = arity;
    const missing = out.slice(0, min).some((arg) => arg === undefined);
    if (positional > max || missing)
      fail(arityMessage(name, arity, args.length), at);
    return out;
  }

  private declare(call: Call): void {
    if (this.declaration) {
      fail("Only one indicator() or strategy() declaration is allowed", call);
    }
    const spec = BUILTIN_FUNCTIONS.get(call.callee) as BuiltinFunction;
    const args = this.order(
      call.callee,
      spec.params,
      spec.arity,
      call.args,
      call
    );
    this.calls.set(call.id, { args, kind: "builtin", name: call.callee, spec });
    // arity: declarations require the title argument.
    const rawTitle = requireString(args[0] as Expr, `${call.callee} title`);
    if (rawTitle.trim() === "") fail(`${call.callee}() needs a title`, call);
    const title = this.clipped(rawTitle, SCRIPT_TITLE_MAX, "Script title");
    const shortTitle = this.clipped(
      constString(args[1], `${call.callee} shorttitle`) ?? rawTitle,
      SCRIPT_TITLE_MAX,
      "Script short title"
    );
    const overlay = constBool(args[2], `${call.callee} overlay`, false);
    this.declaration = {
      kind: call.callee === "strategy" ? "strategy" : "indicator",
      overlay,
      shortTitle,
      title,
    };
  }

  private plot(call: Call, args: OrderedArgs): void {
    if (this.plotCount >= SCRIPT_PLOTS_MAX) {
      fail(`Too many plots (max ${SCRIPT_PLOTS_MAX})`, call);
    }
    const isHline = call.callee === "hline";
    const index = this.plotCount++;
    const title = this.clipped(
      constString(args[1], `${call.callee} title`) ??
        (isHline ? `Level ${index + 1}` : `Plot ${index + 1}`),
      SCRIPT_LABEL_MAX,
      `Title of ${isHline ? "hline" : "plot"} ${index + 1}`
    );
    let kind: ScriptPlotKind = "hline";
    let offset = 0;
    if (!isHline) {
      const style = constString(args[4], "plot style") ?? "style_line";
      kind = PLOT_STYLES.get(style) ?? "line";
      offset = Math.trunc(constNumber(args[7], "plot offset") ?? 0);
    }
    let hex = isHline ? DEFAULT_HLINE_COLOR : DEFAULT_PLOT_COLOR;
    const colorArg = args[2];
    if (colorArg && colorArg.kind !== "call" && colorArg.kind !== "ternary") {
      try {
        const value = constEval(colorArg, "color");
        if (isColor(value)) hex = value.color;
      } catch {
        // Non-constant colors are resolved per bar.
      }
    }
    this.plots.set(call.id, { color: hex, index, kind, offset, title });
  }

  private input(
    call: Call,
    spec: BuiltinFunction,
    args: OrderedArgs,
    idHint: string | undefined
  ): void {
    const arg = (param: string) => args[spec.params.indexOf(param)];
    const defvalExpr = arg("defval");
    if (!defvalExpr) {
      throw new ScriptFailure(`${call.callee}() needs a default value`, call);
    }
    const { kind, defval } = inputDefault(
      call.callee,
      spec.input ?? "auto",
      defvalExpr
    );
    if (kind === "color") {
      this.inputs.set(call.id, { spec: null, value: defval });
      return;
    }
    if (this.inputIds.size >= SCRIPT_INPUTS_MAX) {
      fail(`Too many inputs (max ${SCRIPT_INPUTS_MAX})`, call);
    }
    const id = this.inputId(idHint);
    const warn = (message: string) =>
      this.warnings.add(`Input '${id}': ${message}`);
    const numeric = kind === "int" || kind === "float";
    const min = numeric ? constNumber(arg("minval"), "minval") : null;
    const max = numeric ? constNumber(arg("maxval"), "maxval") : null;
    const options = inputOptions(arg("options"), defval, defvalExpr, warn);
    let value = defval as string | number | boolean;
    if (kind === "int") value = Math.round(value as number);
    if (typeof value === "string") {
      const limit = options ? SCRIPT_OPTION_MAX : SCRIPT_INPUT_STRING_MAX;
      if (value.length > limit)
        warn(`default shortened to ${limit} characters`);
      value = clip(value, limit);
    }
    const rawTitle = constString(arg("title"), "Input title") ?? id;
    if (rawTitle.length > SCRIPT_LABEL_MAX) {
      warn(`title shortened to ${SCRIPT_LABEL_MAX} characters`);
    }
    const inputSpec: ScriptInputSpec = {
      defval: value,
      id,
      kind,
      title: clip(rawTitle, SCRIPT_LABEL_MAX),
      ...(min === null ? {} : { min }),
      ...(max === null ? {} : { max }),
      ...(options === null ? {} : { options }),
    };
    this.inputs.set(call.id, { spec: inputSpec, value: inputSpec.defval });
  }

  // Clip an emitted label, warning once with what was shortened.
  private clipped(text: string, max: number, what: string): string {
    if (text.length > max)
      this.warnings.add(`${what} shortened to ${max} characters`);
    return clip(text, max);
  }

  private inputId(hint: string | undefined): string {
    const base = clip(
      hint ?? `input_${this.inputIds.size}`,
      SCRIPT_INPUT_ID_MAX
    );
    let id = base;
    for (let n = 2; this.inputIds.has(id); n++) id = `${base}_${n}`;
    this.inputIds.add(id);
    return id;
  }
}

export const check = (program: Program): CheckResult =>
  new Checker(program).run();
