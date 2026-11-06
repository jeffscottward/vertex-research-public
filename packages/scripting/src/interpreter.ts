// Bar-by-bar evaluator. The whole script runs once per bar; every variable is a per-bar
// history Series (x[n] reads it), `var` values persist across bars, plain `=` re-evaluates,
// and stateful builtins keep state per call site (the AST node id, nested per user-function
// call site). No user text is ever handed to eval/Function; an operation budget bounds work.

import type { Call, Expr, Stmt } from "./ast.ts";
import {
  type CallEnv,
  type RuntimeHost,
  type SignalRequest,
  SOURCES,
  type StrategyPosition,
  truthy,
} from "./builtins.ts";
import { type Compiled, check, type PlotSlot } from "./checker.ts";
import { fail, type Position, START, toScriptError } from "./errors.ts";
import {
  type CompileResult,
  type RunOptions,
  type RunResult,
  SCRIPT_BARS_MAX,
  SCRIPT_OPS_DEFAULT,
  SCRIPT_SIGNALS_MAX,
  SCRIPT_SOURCE_MAX,
  type ScriptBar,
  type ScriptError,
  type ScriptInputSpec,
  type ScriptInputValue,
  type ScriptPlot,
  type ScriptSignal,
} from "./index.ts";
import {
  clip,
  SCRIPT_OPS_CEILING_FACTOR,
  SCRIPT_SIGNAL_TEXT_MAX,
  SCRIPT_STRING_MAX,
  STRING_TOO_LONG,
} from "./limits.ts";
import { parse } from "./parser.ts";
import { Series, Site } from "./series.ts";
import {
  color,
  num,
  type Scalar,
  scalarEquals,
  typeOf,
  type Value,
} from "./values.ts";

type Flow = "normal" | "break" | "continue";

class Ctx {
  readonly series = new Map<number, Series>();
  readonly sites = new Map<number, Site>();
  readonly children = new Map<number, Ctx>();
}

type Scope = Readonly<{ vars: Map<string, Series>; parent: Scope | null }>;
type Env = Readonly<{ ctx: Ctx; scope: Scope; global: Scope }>;

const seriesFor = (map: Map<number, Series>, id: number): Series => {
  let series = map.get(id);
  if (!series) {
    series = new Series();
    map.set(id, series);
  }
  return series;
};

const lookup = (scope: Scope, name: string, at: Position): Series => {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const series = s.vars.get(name);
    if (series) return series;
  }
  return fail(`Undeclared identifier '${name}'`, at);
};

type NumberOp<T> = (a: number, b: number) => T;
const ARITHMETIC: ReadonlyMap<string, NumberOp<number>> = new Map<
  string,
  NumberOp<number>
>([
  ["-", (a, b) => a - b],
  ["*", (a, b) => a * b],
  ["/", (a, b) => a / b],
  ["%", (a, b) => a % b],
  ["+", (a, b) => a + b],
]);
const COMPARE: ReadonlyMap<string, NumberOp<boolean>> = new Map<
  string,
  NumberOp<boolean>
>([
  ["<", (a, b) => a < b],
  ["<=", (a, b) => a <= b],
  [">", (a, b) => a > b],
  [">=", (a, b) => a >= b],
]);

const BUDGET_MESSAGE = "Script stopped: operation budget used";
// options.maxOps as a finite integer in [1, 10 x default]; anything unusable -> default.
// (Computed per call: index.ts constants are not initialized while this module loads.)
export const opsBudget = (maxOps: unknown): number => {
  if (typeof maxOps !== "number" || !Number.isFinite(maxOps)) {
    return SCRIPT_OPS_DEFAULT;
  }
  const ceiling = SCRIPT_OPS_CEILING_FACTOR * SCRIPT_OPS_DEFAULT;
  return Math.min(ceiling, Math.max(1, Math.floor(maxOps)));
};

const arithmetic = (
  op: string,
  left: Value,
  right: Value,
  at: Position
): Value => {
  if (left === null || right === null) return null;
  if (op === "+" && typeof left === "string" && typeof right === "string") {
    if (left.length + right.length > SCRIPT_STRING_MAX)
      fail(STRING_TOO_LONG, at);
    return left + right;
  }
  const apply = ARITHMETIC.get(op);
  if (!apply || typeof left !== "number" || typeof right !== "number") {
    return fail(
      `Operator '${op}' needs numbers, got ${typeOf(left)} and ${typeOf(right)}`,
      at
    );
  }
  return num(apply(left, right));
};

const applyBinary = (
  op: string,
  left: Value,
  right: Value,
  at: Position
): Value => {
  if (ARITHMETIC.has(op)) return arithmetic(op, left, right, at);
  // Any comparison involving na is false; use na(x) to test for na.
  if (left === null || right === null) return false;
  if (op === "==" || op === "!=") {
    if (Array.isArray(left) || Array.isArray(right)) {
      return fail("Tuples cannot be compared", at);
    }
    const same = scalarEquals(left as Scalar, right as Scalar);
    return op === "==" ? same : !same;
  }
  const compare = COMPARE.get(op);
  if (!compare || typeof left !== "number" || typeof right !== "number") {
    return fail(
      `Operator '${op}' needs numbers, got ${typeOf(left)} and ${typeOf(right)}`,
      at
    );
  }
  return compare(left, right);
};

// Input, declaration and ignored builtins read compiled slots, so their args are not evaluated.
const SKIPS_ARGS: ReadonlySet<string> = new Set([
  "input",
  "declaration",
  "ignored",
]);

interface PlotState {
  color: string;
  slot: PlotSlot;
  values: (number | null)[];
}

type Coerced = Readonly<{ value: ScriptInputValue } | { reason: string }>;

const clampNumber = (
  spec: ScriptInputSpec,
  override: ScriptInputValue
): Coerced => {
  if (typeof override !== "number" || !Number.isFinite(override)) {
    return { reason: "expected a number" };
  }
  let value = spec.kind === "int" ? Math.round(override) : override;
  if (spec.min !== undefined) value = Math.max(spec.min, value);
  if (spec.max !== undefined) value = Math.min(spec.max, value);
  return { value };
};

const COERCE_INPUT: Readonly<
  Record<
    ScriptInputSpec["kind"],
    (spec: ScriptInputSpec, override: ScriptInputValue) => Coerced
  >
> = {
  bool: (_spec, override) =>
    typeof override === "boolean"
      ? { value: override }
      : { reason: "expected true or false" },
  float: clampNumber,
  int: clampNumber,
  source: (_spec, override) =>
    typeof override === "string" && SOURCES.has(override)
      ? { value: override }
      : { reason: "expected a price source such as close" },
  string: (_spec, override) =>
    typeof override === "string"
      ? { value: override }
      : { reason: "expected a string" },
};

// An override replaces the default only when it has the right type (numbers are rounded
// for int and clamped to min/max) and, with options, is one of them.
const resolveInput = (
  spec: ScriptInputSpec,
  override: ScriptInputValue | undefined,
  warn: (message: string) => void
): ScriptInputValue => {
  if (override === undefined) return spec.defval;
  const coerced = COERCE_INPUT[spec.kind](spec, override);
  let reason = "reason" in coerced ? coerced.reason : null;
  if ("value" in coerced) {
    if (!spec.options || spec.options.includes(String(coerced.value))) {
      return coerced.value;
    }
    reason = "not one of the options";
  }
  warn(`Input '${spec.id}' ignored: ${reason}`);
  return spec.defval;
};

class Runtime implements RuntimeHost {
  readonly bars: readonly ScriptBar[];
  readonly isStrategy: boolean;
  position: StrategyPosition | null = null;
  private readonly compiled: Compiled;
  private readonly maxOps: number;
  private readonly root = new Ctx();
  private readonly plotStates = new Map<number, PlotState>();
  private readonly inputValues = new Map<number, Value>();
  private readonly sourceInputs = new Map<number, (bar: ScriptBar) => number>();
  private readonly signals: ScriptSignal[] = [];
  private readonly warnings = new Set<string>();
  private readonly positions: number[] = [];
  private obvValues: (number | null)[] | null = null;
  private ops = 0;
  private bar = 0;
  private lastValue: Value = null;

  constructor(
    compiled: Compiled,
    bars: readonly ScriptBar[],
    options: RunOptions
  ) {
    this.compiled = compiled;
    this.bars = bars;
    this.isStrategy = compiled.declaration.kind === "strategy";
    this.maxOps = opsBudget(options.maxOps);
    for (const slot of compiled.plots.values()) {
      const values: (number | null)[] = Array.from(
        { length: bars.length },
        () => null
      );
      this.plotStates.set(slot.index, { color: slot.color, slot, values });
    }
    this.resolveInputs(options.inputs ?? {});
  }

  private resolveInputs(
    overrides: Readonly<Record<string, ScriptInputValue>>
  ): void {
    const known = new Set<string>();
    for (const [id, slot] of this.compiled.inputs) {
      if (!slot.spec) {
        this.inputValues.set(id, slot.value);
        continue;
      }
      known.add(slot.spec.id);
      const override = Object.hasOwn(overrides, slot.spec.id)
        ? overrides[slot.spec.id]
        : undefined;
      const value = resolveInput(slot.spec, override, (m) =>
        this.warnings.add(m)
      );
      const source =
        slot.spec.kind === "source" ? SOURCES.get(String(value)) : undefined;
      if (source) this.sourceInputs.set(id, source);
      else this.inputValues.set(id, value);
    }
    for (const key of Object.keys(overrides)) {
      if (!known.has(key)) this.warnings.add(`Unknown input '${key}' ignored`);
    }
  }

  run(): RunResult {
    for (let bar = 0; bar < this.bars.length; bar++) {
      this.bar = bar;
      const global: Scope = { parent: null, vars: new Map() };
      this.block(this.compiled.program.body, {
        ctx: this.root,
        global,
        scope: global,
      });
      this.positions[bar] = this.currentSize();
    }
    const plots: ScriptPlot[] = [...this.plotStates.values()]
      .sort((a, b) => a.slot.index - b.slot.index)
      .map((state) => this.finishPlot(state));
    return {
      ok: true,
      ...this.compiled.declaration,
      plots,
      // Offset markers (plotshape offset=-n) land on earlier bars; keep time order.
      signals: [...this.signals].sort((a, b) => a.timestamp - b.timestamp),
      warnings: [...this.compiled.warnings, ...this.warnings],
    };
  }

  private finishPlot(state: PlotState): ScriptPlot {
    const { slot } = state;
    let values = state.values;
    if (slot.offset !== 0) {
      values = values.map((_, i) => state.values[i - slot.offset] ?? null);
    }
    return {
      color: state.color,
      id: `plot_${slot.index}`,
      kind: slot.kind,
      title: slot.title,
      values,
    };
  }

  // RuntimeHost ----------------------------------------------------------

  plot(nodeId: number, value: number | null, colorHex: string | null): void {
    const slot = this.compiled.plots.get(nodeId);
    const state = slot ? this.plotStates.get(slot.index) : undefined;
    if (!state) return;
    state.values[this.bar] = value;
    if (colorHex) state.color = colorHex;
  }

  signal(request: SignalRequest): void {
    if (this.signals.length >= SCRIPT_SIGNALS_MAX) {
      this.warnings.add(
        `Signals capped at ${SCRIPT_SIGNALS_MAX}; later markers were dropped`
      );
      return;
    }
    const bar = this.bars[this.bar + request.offset];
    if (!bar) return;
    const value =
      request.price ?? (request.location === "abovebar" ? bar.high : bar.low);
    const text = clip(request.text, SCRIPT_SIGNAL_TEXT_MAX);
    if (text !== request.text) {
      this.warnings.add(
        `Marker text shortened to ${SCRIPT_SIGNAL_TEXT_MAX} characters`
      );
    }
    this.signals.push({
      kind: request.kind,
      location: request.location,
      text,
      timestamp: bar.timestamp,
      value,
    });
  }

  input(nodeId: number): Value {
    const source = this.sourceInputs.get(nodeId);
    const bar = this.bars[this.bar];
    if (source && bar) return source(bar);
    return this.inputValues.get(nodeId) ?? null;
  }

  obv(bar: number): number | null {
    if (!this.obvValues) {
      const values: (number | null)[] = [];
      let total = 0;
      this.bars.forEach((b, i) => {
        const prev = this.bars[i - 1];
        if (prev) total += Math.sign(b.close - prev.close) * b.volume;
        values.push(total);
      });
      this.obvValues = values;
    }
    return this.obvValues[bar] ?? null;
  }

  positionSize(bar: number): number {
    return bar === this.bar ? this.currentSize() : (this.positions[bar] ?? 0);
  }

  private currentSize(): number {
    if (!this.position) return 0;
    return this.position.direction === "long" ? 1 : -1;
  }

  // Evaluation -----------------------------------------------------------

  private tick(at: Position): void {
    this.ops++;
    if (this.ops > this.maxOps) fail(BUDGET_MESSAGE, at);
  }

  private block(body: readonly Stmt[], env: Env): Flow {
    for (const stmt of body) {
      const flow = this.statement(stmt, env);
      if (flow !== "normal") return flow;
    }
    return "normal";
  }

  private statement(stmt: Stmt, env: Env): Flow {
    this.tick(stmt);
    switch (stmt.kind) {
      case "expr":
        this.lastValue = this.expr(stmt.expr, env);
        return "normal";
      case "decl": {
        const series = seriesFor(env.ctx.series, stmt.id);
        let value: Value;
        if (stmt.persistent && series.initialized) value = series.back(0);
        else {
          value = this.expr(stmt.value, env);
          series.initialized = true;
        }
        series.set(this.bar, value);
        env.scope.vars.set(stmt.name, series);
        this.lastValue = value;
        return "normal";
      }
      case "tupleDecl": {
        const value = this.expr(stmt.value, env);
        const count = stmt.targets.length;
        if (!Array.isArray(value) || value.length !== count) {
          return fail(
            `Expected ${count} values on the right, got ${typeOf(value)}`,
            stmt
          );
        }
        stmt.targets.forEach((target, i) => {
          const series = seriesFor(env.ctx.series, target.id);
          series.set(this.bar, value[i] ?? null);
          env.scope.vars.set(target.name, series);
        });
        this.lastValue = value;
        return "normal";
      }
      case "assign": {
        const series = lookup(env.scope, stmt.name, stmt);
        let value = this.expr(stmt.value, env);
        if (stmt.op !== ":=")
          value = arithmetic(stmt.op.slice(0, 1), series.back(0), value, stmt);
        series.set(this.bar, value);
        this.lastValue = value;
        return "normal";
      }
      case "if": {
        this.lastValue = null;
        const branch = truthy(this.expr(stmt.cond, env), stmt.cond)
          ? stmt.then
          : stmt.otherwise;
        if (!branch) return "normal";
        return this.block(branch, {
          ...env,
          scope: { parent: env.scope, vars: new Map() },
        });
      }
      case "for":
        return this.loop(stmt, env);
      case "func":
        return "normal";
      case "break":
      case "continue":
        return stmt.kind;
    }
  }

  private loop(stmt: Extract<Stmt, { kind: "for" }>, env: Env): Flow {
    const bound = (expr: Expr, what: string): number | null => {
      const value = this.expr(expr, env);
      if (value === null) return null;
      if (typeof value !== "number")
        return fail(`Loop ${what} must be a number`, expr);
      return value;
    };
    const from = bound(stmt.from, "start");
    const to = bound(stmt.to, "end");
    const step = stmt.step ? bound(stmt.step, "step") : 1;
    this.lastValue = null;
    if (from === null || to === null || step === null) return "normal";
    if (step === 0) return fail("Loop step must not be 0", stmt.step ?? stmt);
    const delta = (from <= to ? 1 : -1) * Math.abs(step);
    const counter = seriesFor(env.ctx.series, stmt.id);
    for (let i = from; delta > 0 ? i <= to : i >= to; i += delta) {
      this.tick(stmt);
      counter.set(this.bar, i);
      const vars = new Map([[stmt.variable, counter]]);
      const flow = this.block(stmt.body, {
        ...env,
        scope: { parent: env.scope, vars },
      });
      if (flow === "break") break;
    }
    return "normal";
  }

  private expr(expr: Expr, env: Env): Value {
    this.tick(expr);
    switch (expr.kind) {
      case "num":
      case "str":
      case "bool":
        return expr.value;
      case "na":
        return null;
      case "color":
        return color(expr.hex);
      case "name":
        return this.name(expr, env, 0);
      case "history":
        return this.history(expr, env);
      case "unary":
        return this.unary(expr, env);
      case "binary":
        return this.binary(expr, env);
      case "ternary":
        return truthy(this.expr(expr.cond, env), expr.cond)
          ? this.expr(expr.whenTrue, env)
          : this.expr(expr.whenFalse, env);
      case "tuple":
        return expr.items.map((item) => this.scalar(item, env));
      case "call":
        return this.call(expr, env);
    }
  }

  private unary(expr: Extract<Expr, { kind: "unary" }>, env: Env): Value {
    const value = this.expr(expr.operand, env);
    if (expr.op === "not") return !truthy(value, expr);
    if (value === null) return null;
    if (typeof value !== "number") {
      return fail(
        `Operator '${expr.op}' needs a number, got ${typeOf(value)}`,
        expr
      );
    }
    return expr.op === "-" ? -value : value;
  }

  private binary(expr: Extract<Expr, { kind: "binary" }>, env: Env): Value {
    if (expr.op === "and" || expr.op === "or") {
      // Lazy like Pine v6: the right side runs only when it decides the result.
      const left = truthy(this.expr(expr.left, env), expr.left);
      if (expr.op === "and" ? !left : left) return left;
      return truthy(this.expr(expr.right, env), expr.right);
    }
    const left = this.expr(expr.left, env);
    const right = this.expr(expr.right, env);
    return applyBinary(expr.op, left, right, expr);
  }

  private scalar(item: Expr, env: Env): Scalar {
    const value = this.expr(item, env);
    return Array.isArray(value)
      ? fail("Tuples cannot be nested", item)
      : (value as Scalar);
  }

  // A name `back` bars ago.
  private name(
    expr: Extract<Expr, { kind: "name" }>,
    env: Env,
    back: number
  ): Value {
    const ref = this.compiled.names.get(expr.id);
    if (!ref || ref.kind === "user")
      return lookup(env.scope, expr.name, expr).back(back);
    if (ref.kind === "constant") return ref.value;
    const bar = this.bar - back;
    return bar < 0 ? null : ref.read(this, bar);
  }

  private history(expr: Extract<Expr, { kind: "history" }>, env: Env): Value {
    const offset = this.expr(expr.offset, env);
    if (offset === null) return null;
    if (typeof offset !== "number" || offset < 0) {
      return fail("History offset must be a non-negative number", expr.offset);
    }
    const back = Math.floor(offset);
    if (expr.target.kind === "name") return this.name(expr.target, env, back);
    // Any other expression: record its value per bar at this call site, then look back.
    const value = this.expr(expr.target, env);
    const series = seriesFor(env.ctx.series, expr.id);
    series.set(this.bar, value);
    return series.back(back);
  }

  private call(expr: Call, env: Env): Value {
    const resolved = this.compiled.calls.get(expr.id);
    if (!resolved) return fail(`Unknown function '${expr.callee}'`, expr);
    const skip =
      resolved.kind === "builtin" && SKIPS_ARGS.has(resolved.spec.kind);
    const args = resolved.args.map((arg) =>
      arg === undefined || skip ? undefined : this.expr(arg, env)
    );
    if (resolved.kind === "builtin") {
      const { spec } = resolved;
      if (spec.kind === "declaration" || spec.kind === "ignored") return null;
      const ctx = env.ctx;
      const callEnv: CallEnv = {
        at: expr,
        bar: this.bar,
        charge: (units) => {
          this.ops += units;
          if (this.ops > this.maxOps) fail(BUDGET_MESSAGE, expr);
        },
        host: this,
        id: expr.id,
        name: resolved.name,
        site: () => {
          let site = ctx.sites.get(expr.id);
          if (!site) {
            site = new Site();
            ctx.sites.set(expr.id, site);
          }
          return site;
        },
      };
      return spec.impl(args, callEnv);
    }
    // User function: its own context per call site, params as history series.
    const { fn } = resolved;
    let child = env.ctx.children.get(expr.id);
    if (!child) {
      child = new Ctx();
      env.ctx.children.set(expr.id, child);
    }
    const vars = new Map<string, Series>();
    fn.params.forEach((param, i) => {
      const fallback = param.fallback ? this.expr(param.fallback, env) : null;
      const series = seriesFor(child.series, -1 - i);
      series.set(
        this.bar,
        args[i] === undefined ? fallback : (args[i] ?? null)
      );
      vars.set(param.name, series);
    });
    this.lastValue = null;
    this.block(fn.body, {
      ctx: child,
      global: env.global,
      scope: { parent: env.global, vars },
    });
    const result = this.lastValue;
    this.lastValue = null;
    return result;
  }
}

// Boundary ---------------------------------------------------------------

const compile = (source: unknown) => {
  if (typeof source !== "string") {
    return {
      errors: [{ ...START, message: "Script source must be text" }],
      ok: false as const,
    };
  }
  if (source.length > SCRIPT_SOURCE_MAX) {
    return {
      errors: [
        {
          ...START,
          message: `Script is too long (max ${SCRIPT_SOURCE_MAX} characters)`,
        },
      ],
      ok: false as const,
    };
  }
  return check(parse(source));
};

const barsError = (bars: unknown): ScriptError | null => {
  const at = START;
  if (!Array.isArray(bars)) return { ...at, message: "Bars must be a list" };
  if (bars.length > SCRIPT_BARS_MAX) {
    return { ...at, message: `Too many bars (max ${SCRIPT_BARS_MAX})` };
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const [i, bar] of (bars as ScriptBar[]).entries()) {
    const fields = [
      bar?.timestamp,
      bar?.open,
      bar?.high,
      bar?.low,
      bar?.close,
      bar?.volume,
    ];
    if (!fields.every((f) => typeof f === "number" && Number.isFinite(f))) {
      return { ...at, message: `Bar ${i} has a missing or non-finite field` };
    }
    if (bar.timestamp <= previous) {
      return {
        ...at,
        message: `Bar ${i} timestamp is not after the previous bar`,
      };
    }
    previous = bar.timestamp;
  }
  return null;
};

export const compileScript = (source: string): CompileResult => {
  try {
    const result = compile(source);
    if (!result.ok) return result;
    return { ok: true, ...result.compiled.declaration };
  } catch (error) {
    return { errors: [toScriptError(error)], ok: false };
  }
};

export const runScript = (
  source: string,
  bars: readonly ScriptBar[],
  options: RunOptions = {}
): RunResult => {
  try {
    const result = compile(source);
    if (!result.ok) return result;
    const invalid = barsError(bars);
    if (invalid) return { errors: [invalid], ok: false };
    return new Runtime(result.compiled, bars, options ?? {}).run();
  } catch (error) {
    return { errors: [toScriptError(error)], ok: false };
  }
};
