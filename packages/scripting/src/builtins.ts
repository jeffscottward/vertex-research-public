// Builtin registry: every Pine builtin the subset knows is one table row
// (name -> {params, arity, kind, impl}); the evaluator never branches on builtin names.

import { fail, type Position } from "./errors.ts";
import type { Site } from "./series.ts";
import {
  barssince,
  bb,
  type CrossKind,
  cci,
  change,
  cross,
  cum,
  ema,
  extreme,
  fixnan,
  macd,
  pivot,
  rma,
  roc,
  rsi,
  sma,
  stdev,
  stoch,
  sum,
  valuewhen,
  vwma,
  wma,
} from "./ta.ts";
import type { ScriptBar, ScriptInputSpec, ScriptSignal } from "./types.ts";
import {
  type ColorValue,
  color,
  isColor,
  num,
  PALETTE,
  typeOf,
  type Value,
} from "./values.ts";

export type Args = readonly (Value | undefined)[];
export type StrategyDirection = "long" | "short";
export interface StrategyPosition {
  direction: StrategyDirection;
  id: string;
}
export type SignalRequest = Readonly<{
  kind: ScriptSignal["kind"];
  location: ScriptSignal["location"];
  text: string;
  price: number | null;
  // Bars to shift the marker (plotshape offset=-n marks a pivot n bars back).
  offset: number;
}>;

// What builtins may touch: bars, outputs and the display-only strategy position.
export interface RuntimeHost {
  readonly bars: readonly ScriptBar[];
  input: (nodeId: number) => Value;
  readonly isStrategy: boolean;
  obv: (bar: number) => number | null;
  plot: (nodeId: number, value: number | null, colorHex: string | null) => void;
  position: StrategyPosition | null;
  positionSize: (bar: number) => number;
  signal: (request: SignalRequest) => void;
}

export type CallEnv = Readonly<{
  name: string;
  id: number;
  bar: number;
  at: Position;
  host: RuntimeHost;
  site: () => Site;
  // Adds work units to the operation budget (windowed kernels scale with their length).
  charge: (units: number) => void;
}>;

// One budget unit per this many window elements a kernel may scan.
const WINDOW_ELEMENTS_PER_OP = 16;

// input: value comes from the compiled input slot (args are compile-time constants).
// declaration: indicator()/strategy(), read at compile time.
// output: plot/hline/plotshape. ignored: accepted, warned about, does nothing.
export type BuiltinKind =
  | "pure"
  | "stateful"
  | "input"
  | "declaration"
  | "output"
  | "strategy"
  | "ignored";

export type InputKind = ScriptInputSpec["kind"] | "auto" | "color";

export type BuiltinFunction = Readonly<{
  params: readonly string[];
  arity: readonly [min: number, max: number];
  kind: BuiltinKind;
  impl: (args: Args, env: CallEnv) => Value;
  input?: InputKind;
  strategyOnly?: boolean;
  // Argument slots that must be whole-number lengths, given which slots were passed.
  // The checker rejects a price series there (ta.highest(close) forgot its length).
  lengths?: (given: readonly boolean[]) => readonly number[];
}>;

// Kinds Pine allows only in the global scope (not inside if/for/functions).
export const GLOBAL_ONLY: ReadonlySet<BuiltinKind> = new Set([
  "input",
  "declaration",
  "output",
  "ignored",
]);

// Argument coercion -----------------------------------------------------

const numberArg = (
  value: Value | undefined,
  env: CallEnv,
  param: string
): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  return fail(
    `${env.name}: '${param}' must be a number, got ${typeOf(value)}`,
    env.at
  );
};

const lengthArg = (
  value: Value | undefined,
  env: CallEnv,
  param = "length"
): number => {
  const n = numberArg(value, env, param);
  if (n === null || n < 1 || !Number.isInteger(n)) {
    return fail(`${env.name}: '${param}' must be a positive integer`, env.at);
  }
  const length = Math.floor(n);
  env.charge(Math.ceil(length / WINDOW_ELEMENTS_PER_OP));
  return length;
};

const countArg = (
  value: Value | undefined,
  env: CallEnv,
  param: string
): number => {
  const n = numberArg(value, env, param);
  if (n === null || n < 0 || !Number.isInteger(n)) {
    return fail(
      `${env.name}: '${param}' must be a non-negative integer`,
      env.at
    );
  }
  return Math.floor(n);
};

// Pine conditions: bools, or numbers (non-zero, not na). na is false.
export const truthy = (value: Value | undefined, at: Position): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return fail(`Expected a condition, got ${typeOf(value)}`, at);
};

const stringArg = (
  value: Value | undefined,
  env: CallEnv,
  param: string
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return fail(`${env.name}: '${param}' must be a string`, env.at);
};

const colorArg = (
  value: Value | undefined,
  env: CallEnv,
  param = "color"
): string | null => {
  if (value === undefined || value === null) return null;
  if (isColor(value)) return value.color;
  return fail(`${env.name}: '${param}' must be a color`, env.at);
};

const boolArg = (value: Value | undefined, env: CallEnv, fallback: boolean) =>
  value === undefined ? fallback : truthy(value, env.at);

const numbers = (args: Args, env: CallEnv): (number | null)[] =>
  args.map((value, i) => numberArg(value, env, `argument ${i + 1}`));

// Pure math helper: na in -> na out, non-finite -> na.
const math1 =
  (op: (x: number) => number) =>
  (args: Args, env: CallEnv): Value => {
    const x = numberArg(args[0], env, "number");
    return x === null ? null : num(op(x));
  };

const variadic =
  (op: (values: number[]) => number) =>
  (args: Args, env: CallEnv): Value => {
    const values = numbers(args, env);
    if (values.some((v) => v === null)) return null;
    return num(op(values as number[]));
  };

// Bars ------------------------------------------------------------------

export const SOURCES: ReadonlyMap<string, (bar: ScriptBar) => number> = new Map(
  Object.entries({
    close: (b: ScriptBar) => b.close,
    high: (b: ScriptBar) => b.high,
    hl2: (b: ScriptBar) => (b.high + b.low) / 2,
    hlc3: (b: ScriptBar) => (b.high + b.low + b.close) / 3,
    hlcc4: (b: ScriptBar) => (b.high + b.low + 2 * b.close) / 4,
    low: (b: ScriptBar) => b.low,
    ohlc4: (b: ScriptBar) => (b.open + b.high + b.low + b.close) / 4,
    open: (b: ScriptBar) => b.open,
    volume: (b: ScriptBar) => b.volume,
  })
);

const trueRange = (
  bars: readonly ScriptBar[],
  bar: number,
  handleNa: boolean
): number | null => {
  const current = bars[bar];
  if (!current) return null;
  const prev = bars[bar - 1];
  if (!prev) return handleNa ? current.high - current.low : null;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - prev.close),
    Math.abs(current.low - prev.close)
  );
};

const barAt = (env: CallEnv): ScriptBar => {
  const bar = env.host.bars[env.bar];
  if (!bar) return fail("No bar data", env.at);
  return bar;
};

// Builtin series variables: value at a bar index (bar >= 0 guaranteed by the caller).
export type BuiltinVariable = (host: RuntimeHost, bar: number) => Value;

const dateField =
  (read: (date: Date) => number) =>
  (host: RuntimeHost, bar: number): Value => {
    const b = host.bars[bar];
    return b ? read(new Date(b.timestamp)) : null;
  };

const variables: Record<string, BuiltinVariable> = {
  bar_index: (_host, bar) => bar,
  "barstate.isconfirmed": () => true,
  "barstate.isfirst": (_host, bar) => bar === 0,
  "barstate.ishistory": () => true,
  "barstate.islast": (host, bar) => bar === host.bars.length - 1,
  "barstate.isnew": () => true,
  "barstate.isrealtime": () => false,
  dayofmonth: dateField((d) => d.getUTCDate()),
  dayofweek: dateField((d) => d.getUTCDay() + 1),
  hour: dateField((d) => d.getUTCHours()),
  last_bar_index: (host) => host.bars.length - 1,
  minute: dateField((d) => d.getUTCMinutes()),
  month: dateField((d) => d.getUTCMonth() + 1),
  "strategy.position_size": (host, bar) => host.positionSize(bar),
  "ta.obv": (host, bar) => host.obv(bar),
  "ta.tr": (host, bar) => trueRange(host.bars, bar, false),
  time: (host, bar) => host.bars[bar]?.timestamp ?? null,
  year: dateField((d) => d.getUTCFullYear()),
};
for (const [name, read] of SOURCES) {
  variables[name] = (host, bar) => {
    const b = host.bars[bar];
    return b ? read(b) : null;
  };
}

export const BUILTIN_VARIABLES: ReadonlyMap<string, BuiltinVariable> = new Map(
  Object.entries(variables)
);

// Constants -------------------------------------------------------------

const constants: Record<string, Value> = {
  "math.e": Math.E,
  "math.phi": (1 + Math.sqrt(5)) / 2,
  "math.pi": Math.PI,
  "strategy.cash": "cash",
  "strategy.commission.cash_per_contract": "cash_per_contract",
  "strategy.commission.cash_per_order": "cash_per_order",
  "strategy.commission.percent": "percent",
  "strategy.fixed": "fixed",
  "strategy.long": "long",
  "strategy.percent_of_equity": "percent_of_equity",
  "strategy.short": "short",
};
for (const [name, hex] of Object.entries(PALETTE)) {
  constants[`color.${name}`] = color(hex);
}
const enumConstants: Record<string, readonly string[]> = {
  currency: ["NONE", "USD", "EUR", "GBP", "JPY"],
  display: ["all", "none", "data_window", "pane", "price_scale", "status_line"],
  format: ["inherit", "price", "volume", "percent", "mintick"],
  hline: ["style_solid", "style_dotted", "style_dashed"],
  location: ["abovebar", "belowbar", "top", "bottom", "absolute"],
  plot: [
    "style_line",
    "style_linebr",
    "style_stepline",
    "style_stepline_diamond",
    "style_histogram",
    "style_columns",
    "style_circles",
    "style_cross",
    "style_area",
    "style_areabr",
  ],
  scale: ["right", "left", "none"],
  shape: [
    "xcross",
    "cross",
    "triangleup",
    "triangledown",
    "flag",
    "circle",
    "arrowup",
    "arrowdown",
    "labelup",
    "labeldown",
    "square",
    "diamond",
  ],
  size: ["auto", "tiny", "small", "normal", "large", "huge"],
};
for (const [namespace, names] of Object.entries(enumConstants)) {
  for (const name of names) constants[`${namespace}.${name}`] = name;
}

export const CONSTANTS: ReadonlyMap<string, Value> = new Map(
  Object.entries(constants)
);

// Outputs ---------------------------------------------------------------

// Map, not an object literal: user strings such as "constructor" must not hit a prototype.
const LOCATIONS: ReadonlyMap<string, ScriptSignal["location"]> = new Map([
  ["abovebar", "abovebar"],
  ["absolute", "abovebar"],
  ["belowbar", "belowbar"],
  ["bottom", "belowbar"],
  ["top", "abovebar"],
]);

const plotValue = (value: Value | undefined, env: CallEnv): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return num(value);
  return fail(
    `${env.name} expects a number series, got ${typeOf(value)}`,
    env.at
  );
};

// Marker when `series` is true (or a non-zero number).
const shapeImpl =
  (textIndex: number, charIndex: number | null) =>
  (args: Args, env: CallEnv): Value => {
    const series = args[0];
    if (!truthy(series, env.at)) return null;
    const where = stringArg(args[3], env, "location") ?? "abovebar";
    const location = LOCATIONS.get(where);
    if (!location)
      return fail(`${env.name}: unknown location '${where}'`, env.at);
    const text =
      stringArg(args[textIndex], env, "text") ??
      (charIndex === null ? null : stringArg(args[charIndex], env, "char")) ??
      "";
    const price =
      where === "absolute" && typeof series === "number" ? series : null;
    const offset = Math.trunc(numberArg(args[5], env, "offset") ?? 0);
    env.host.signal({
      kind: "shape",
      location,
      offset,
      price,
      text,
    });
    return null;
  };

const strategyEntry = (args: Args, env: CallEnv): Value => {
  if (!boolArg(args[10], env, true)) return null;
  const id = stringArg(args[0], env, "id") ?? "";
  const direction = args[1];
  if (direction !== "long" && direction !== "short") {
    return fail(
      "strategy.entry: direction must be strategy.long or strategy.short",
      env.at
    );
  }
  const current = env.host.position;
  // Pyramiding is off: a repeat entry in the open direction is ignored.
  if (current && current.direction === direction) return null;
  env.host.position = { direction, id };
  const text = stringArg(args[7], env, "comment") ?? id;
  env.host.signal({
    kind: direction,
    location: direction === "long" ? "belowbar" : "abovebar",
    offset: 0,
    price: null,
    text,
  });
  return null;
};

const closePosition = (env: CallEnv, comment: string | null): void => {
  const current = env.host.position;
  if (!current) return;
  env.host.position = null;
  env.host.signal({
    kind: "exit",
    location: current.direction === "long" ? "abovebar" : "belowbar",
    offset: 0,
    price: null,
    text: comment ?? `Close ${current.id}`,
  });
};

// Table -----------------------------------------------------------------

type Spec = Omit<BuiltinFunction, "arity"> & { min?: number; max?: number };

const define = (spec: Spec): BuiltinFunction => {
  const { min, max, ...rest } = spec;
  const required = min ?? spec.params.length;
  return { ...rest, arity: [required, max ?? spec.params.length] };
};

const LENGTH_PARAMS: ReadonlySet<string> = new Set([
  "length",
  "fastlen",
  "slowlen",
  "siglen",
  "leftbars",
  "rightbars",
]);

const stateful = (
  params: readonly string[],
  impl: BuiltinFunction["impl"],
  min?: number,
  lengths?: BuiltinFunction["lengths"]
): BuiltinFunction => {
  const slots = params.flatMap((p, i) => (LENGTH_PARAMS.has(p) ? [i] : []));
  return define({
    impl,
    kind: "stateful",
    lengths: lengths ?? (() => slots),
    params,
    ...(min === undefined ? {} : { min }),
  });
};

// ta.highest(length) / ta.highest(source, length): the lone argument is the length.
const optionalSourceLength = (given: readonly boolean[]) =>
  given[1] ? [1] : [0];
// ta.pivothigh(leftbars, rightbars) / ta.pivothigh(source, leftbars, rightbars).
const optionalSourcePivot = (given: readonly boolean[]) =>
  given[2] ? [1, 2] : [0, 1];

const pure = (
  params: readonly string[],
  impl: BuiltinFunction["impl"],
  min?: number
): BuiltinFunction =>
  define({ impl, kind: "pure", params, ...(min === undefined ? {} : { min }) });

const src = (args: Args, env: CallEnv, i = 0) =>
  numberArg(args[i], env, "source");

const smoothing =
  (kernel: typeof ema) =>
  (args: Args, env: CallEnv): Value =>
    kernel(env.site(), env.bar, "ma", src(args, env), lengthArg(args[1], env));

// Optional leading source: with it omitted (positionally or by naming only the lengths),
// the default high/low series is used and the remaining slots are the lengths.
const extremeOf =
  (
    pick: (a: number, b: number) => number,
    fallback: (bar: ScriptBar) => number
  ) =>
  (args: Args, env: CallEnv): Value => {
    const hasSource = args[0] !== undefined && args[1] !== undefined;
    const source = hasSource ? src(args, env) : fallback(barAt(env));
    const len = lengthArg(args[1] ?? args[0], env);
    return extreme(env.site(), env.bar, source, len, pick);
  };

const pivotOf =
  (high: boolean) =>
  (args: Args, env: CallEnv): Value => {
    const hasSource = args[0] !== undefined && args[2] !== undefined;
    const shifted = args[2] === undefined;
    const fallback = high ? (b: ScriptBar) => b.high : (b: ScriptBar) => b.low;
    const source = hasSource ? src(args, env) : fallback(barAt(env));
    const left = countArg(shifted ? args[0] : args[1], env, "leftbars");
    const right = countArg(shifted ? args[1] : args[2], env, "rightbars");
    env.charge(Math.ceil((left + right + 1) / WINDOW_ELEMENTS_PER_OP));
    return pivot(env.site(), env.bar, source, left, right, high);
  };

const crossOf =
  (kind: CrossKind) =>
  (args: Args, env: CallEnv): Value =>
    cross(
      env.site(),
      env.bar,
      numberArg(args[0], env, "source1"),
      numberArg(args[1], env, "source2"),
      kind
    );

const inputFn = (
  params: readonly string[],
  input: InputKind
): BuiltinFunction =>
  define({
    impl: (_args, env) => env.host.input(env.id),
    input,
    kind: "input",
    min: 1,
    params,
  });

const INPUT_TAIL = ["tooltip", "inline", "group", "confirm", "display"];
const NUMERIC_INPUT = [
  "defval",
  "title",
  "minval",
  "maxval",
  "step",
  ...INPUT_TAIL,
  "options",
];

const ignored = (params: readonly string[]): BuiltinFunction =>
  define({
    impl: () => null,
    kind: "ignored",
    max: params.length,
    min: 0,
    params,
  });

const DECLARATION_PARAMS = [
  "title",
  "shorttitle",
  "overlay",
  "format",
  "precision",
  "scale",
  "pyramiding",
  "calc_on_order_fills",
  "calc_on_every_tick",
  "max_bars_back",
  "backtest_fill_limits_assumption",
  "default_qty_type",
  "default_qty_value",
  "initial_capital",
  "currency",
  "slippage",
  "commission_type",
  "commission_value",
  "process_orders_on_close",
  "close_entries_rule",
  "margin_long",
  "margin_short",
  "explicit_plot_zorder",
  "max_lines_count",
  "max_labels_count",
  "max_boxes_count",
  "calc_bars_count",
  "risk_free_rate",
  "use_bar_magnifier",
  "fill_orders_on_standard_ohlc",
  "max_polylines_count",
  "timeframe",
  "timeframe_gaps",
  "dynamic_requests",
  "behind_chart",
];

const declaration = (): BuiltinFunction =>
  define({
    impl: () => null,
    kind: "declaration",
    min: 1,
    params: DECLARATION_PARAMS,
  });

const PLOT_PARAMS = [
  "series",
  "title",
  "color",
  "linewidth",
  "style",
  "trackprice",
  "histbase",
  "offset",
  "join",
  "editable",
  "show_last",
  "display",
  "format",
  "precision",
  "force_overlay",
];

const SHAPE_PARAMS = [
  "series",
  "title",
  "style",
  "location",
  "color",
  "offset",
  "text",
  "textcolor",
  "editable",
  "size",
  "show_last",
  "display",
  "format",
  "precision",
  "force_overlay",
];

const functions: Record<string, BuiltinFunction> = {
  alert: ignored(["message", "freq"]),
  alertcondition: ignored(["condition", "title", "message"]),
  barcolor: ignored([
    "color",
    "offset",
    "editable",
    "show_last",
    "title",
    "display",
  ]),
  bgcolor: ignored([
    "color",
    "offset",
    "editable",
    "show_last",
    "title",
    "display",
  ]),
  bool: pure(["x"], (a, e) => truthy(a[0], e.at)),

  // Colors: transparency is accepted and dropped (plots are single solid colors).
  "color.new": pure(["color", "transp"], (a, e) => {
    const hex = colorArg(a[0], e);
    return hex === null ? null : color(hex);
  }),
  "color.rgb": pure(
    ["red", "green", "blue", "transp"],
    (a, e): ColorValue | null => {
      const parts = numbers(a.slice(0, 3), e);
      if (parts.some((p) => p === null)) return null;
      const hex = (parts as number[])
        .map((p) =>
          Math.max(0, Math.min(255, Math.round(p)))
            .toString(16)
            .padStart(2, "0")
        )
        .join("");
      return color(`#${hex}`);
    },
    3
  ),
  fill: ignored([
    "hline1",
    "hline2",
    "color",
    "title",
    "editable",
    "fillgaps",
    "display",
  ]),
  fixnan: stateful(["source"], (a, e) => fixnan(e.site(), e.bar, src(a, e))),
  float: pure(["x"], (a, e) => numberArg(a[0], e, "x")),
  hline: define({
    impl: (a, e) => {
      e.host.plot(e.id, plotValue(a[0], e), colorArg(a[2], e));
      return null;
    },
    kind: "output",
    min: 1,
    params: [
      "price",
      "title",
      "color",
      "linestyle",
      "linewidth",
      "editable",
      "display",
    ],
  }),

  // Declarations.
  indicator: declaration(),

  // Inputs.
  input: inputFn(
    ["defval", "title", "tooltip", "inline", "group", "display"],
    "auto"
  ),
  "input.bool": inputFn(["defval", "title", ...INPUT_TAIL], "bool"),
  "input.color": inputFn(["defval", "title", ...INPUT_TAIL], "color"),
  "input.float": inputFn(NUMERIC_INPUT, "float"),
  "input.int": inputFn(NUMERIC_INPUT, "int"),
  "input.source": inputFn(
    ["defval", "title", "tooltip", "inline", "group", "display"],
    "source"
  ),
  "input.string": inputFn(
    ["defval", "title", "options", ...INPUT_TAIL],
    "string"
  ),
  int: pure(["x"], (a, e) => {
    const x = numberArg(a[0], e, "x");
    return x === null ? null : Math.trunc(x);
  }),

  // Math.
  "math.abs": pure(["number"], math1(Math.abs)),
  "math.avg": define({
    impl: variadic((v) => v.reduce((x, y) => x + y, 0) / v.length),
    kind: "pure",
    max: Number.POSITIVE_INFINITY,
    min: 1,
    params: ["number0", "number1"],
  }),
  "math.ceil": pure(["number"], math1(Math.ceil)),
  "math.exp": pure(["number"], math1(Math.exp)),
  "math.floor": pure(["number"], math1(Math.floor)),
  "math.log": pure(["number"], math1(Math.log)),
  "math.log10": pure(["number"], math1(Math.log10)),
  "math.max": define({
    impl: variadic((v) => Math.max(...v)),
    kind: "pure",
    max: Number.POSITIVE_INFINITY,
    min: 1,
    params: ["number0", "number1"],
  }),
  "math.min": define({
    impl: variadic((v) => Math.min(...v)),
    kind: "pure",
    max: Number.POSITIVE_INFINITY,
    min: 1,
    params: ["number0", "number1"],
  }),
  "math.pow": pure(["base", "exponent"], (a, e) => {
    const base = numberArg(a[0], e, "base");
    const exponent = numberArg(a[1], e, "exponent");
    return base === null || exponent === null ? null : num(base ** exponent);
  }),
  "math.round": pure(
    ["number", "precision"],
    (a, e) => {
      const x = numberArg(a[0], e, "number");
      const digits = a[1] === undefined ? 0 : countArg(a[1], e, "precision");
      if (x === null) return null;
      const scale = 10 ** digits;
      return num(Math.round(x * scale) / scale);
    },
    1
  ),
  "math.sign": pure(["number"], math1(Math.sign)),
  "math.sqrt": pure(["number"], math1(Math.sqrt)),
  "math.sum": stateful(["source", "length"], (a, e) =>
    sum(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
  na: pure(["x"], (a) => (a[0] ?? null) === null),

  // na helpers and casts.
  nz: pure(
    ["source", "replacement"],
    (a) => {
      const value = a[0] ?? null;
      return value === null ? (a[1] ?? 0) : value;
    },
    1
  ),

  // Outputs.
  plot: define({
    impl: (a, e) => {
      e.host.plot(e.id, plotValue(a[0], e), colorArg(a[2], e));
      return null;
    },
    kind: "output",
    min: 1,
    params: PLOT_PARAMS,
  }),
  plotchar: define({
    impl: shapeImpl(6, 2),
    kind: "output",
    min: 1,
    params: [
      "series",
      "title",
      "char",
      "location",
      "color",
      "offset",
      "text",
      "textcolor",
      "editable",
      "size",
      "show_last",
      "display",
      "format",
      "precision",
      "force_overlay",
    ],
  }),
  plotshape: define({
    impl: shapeImpl(6, null),
    kind: "output",
    min: 1,
    params: SHAPE_PARAMS,
  }),
  "str.tostring": pure(
    ["value", "format"],
    (a) => {
      const value = a[0] ?? null;
      if (value === null) return "NaN";
      if (isColor(value)) return value.color;
      return Array.isArray(value) ? "" : String(value);
    },
    1
  ),
  strategy: declaration(),
  "strategy.close": define({
    impl: (a, e) => {
      if (!boolArg(a[7], e, true)) return null;
      const id = stringArg(a[0], e, "id");
      if (e.host.position?.id === id)
        closePosition(e, stringArg(a[1], e, "comment"));
      return null;
    },
    kind: "strategy",
    min: 1,
    params: [
      "id",
      "comment",
      "qty",
      "qty_percent",
      "alert_message",
      "immediately",
      "disable_alert",
      "when",
    ],
    strategyOnly: true,
  }),
  "strategy.close_all": define({
    impl: (a, e) => {
      if (boolArg(a[4], e, true))
        closePosition(e, stringArg(a[0], e, "comment"));
      return null;
    },
    kind: "strategy",
    min: 0,
    params: [
      "comment",
      "alert_message",
      "immediately",
      "disable_alert",
      "when",
    ],
    strategyOnly: true,
  }),

  // Strategy orders: display-only markers.
  "strategy.entry": define({
    impl: strategyEntry,
    kind: "strategy",
    min: 2,
    params: [
      "id",
      "direction",
      "qty",
      "limit",
      "stop",
      "oca_name",
      "oca_type",
      "comment",
      "alert_message",
      "disable_alert",
      "when",
    ],
    strategyOnly: true,
  }),
  "ta.atr": stateful(["length"], (a, e) =>
    rma(
      e.site(),
      e.bar,
      "atr",
      trueRange(e.host.bars, e.bar, true),
      lengthArg(a[0], e)
    )
  ),
  "ta.barssince": stateful(["condition"], (a, e) =>
    barssince(e.site(), e.bar, truthy(a[0], e.at))
  ),
  "ta.bb": stateful(["series", "length", "mult"], (a, e) =>
    bb(
      e.site(),
      e.bar,
      src(a, e),
      lengthArg(a[1], e),
      numberArg(a[2], e, "mult") ?? 0
    )
  ),
  "ta.cci": stateful(["source", "length"], (a, e) =>
    cci(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
  "ta.change": stateful(
    ["source", "length"],
    (a, e) =>
      change(
        e.site(),
        e.bar,
        src(a, e),
        a[1] === undefined ? 1 : countArg(a[1], e, "length")
      ),
    1
  ),
  "ta.cross": stateful(["source1", "source2"], crossOf("any")),
  "ta.crossover": stateful(["source1", "source2"], crossOf("over")),
  "ta.crossunder": stateful(["source1", "source2"], crossOf("under")),
  "ta.cum": stateful(["source"], (a, e) => cum(e.site(), e.bar, src(a, e))),
  "ta.ema": stateful(["source", "length"], smoothing(ema)),
  "ta.highest": stateful(
    ["source", "length"],
    extremeOf(Math.max, (b) => b.high),
    1,
    optionalSourceLength
  ),
  "ta.lowest": stateful(
    ["source", "length"],
    extremeOf(Math.min, (b) => b.low),
    1,
    optionalSourceLength
  ),
  "ta.macd": stateful(["source", "fastlen", "slowlen", "siglen"], (a, e) =>
    macd(
      e.site(),
      e.bar,
      src(a, e),
      lengthArg(a[1], e, "fastlen"),
      lengthArg(a[2], e, "slowlen"),
      lengthArg(a[3], e, "siglen")
    )
  ),
  "ta.mom": stateful(["source", "length"], (a, e) =>
    change(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
  "ta.pivothigh": stateful(
    ["source", "leftbars", "rightbars"],
    pivotOf(true),
    2,
    optionalSourcePivot
  ),
  "ta.pivotlow": stateful(
    ["source", "leftbars", "rightbars"],
    pivotOf(false),
    2,
    optionalSourcePivot
  ),
  "ta.rma": stateful(["source", "length"], smoothing(rma)),
  "ta.roc": stateful(["source", "length"], (a, e) =>
    roc(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
  "ta.rsi": stateful(["source", "length"], (a, e) =>
    rsi(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
  // Moving averages and oscillators.
  "ta.sma": stateful(["source", "length"], (a, e) =>
    sma(e.site(), e.bar, "src", src(a, e), lengthArg(a[1], e))
  ),
  "ta.stdev": stateful(
    ["source", "length", "biased"],
    (a, e) => {
      const len = lengthArg(a[1], e);
      const dev = stdev(e.site(), e.bar, src(a, e), len);
      if (dev === null || boolArg(a[2], e, true)) return dev;
      return len > 1 ? dev * Math.sqrt(len / (len - 1)) : null;
    },
    2
  ),
  "ta.stoch": stateful(["source", "high", "low", "length"], (a, e) =>
    stoch(
      e.site(),
      e.bar,
      src(a, e),
      numberArg(a[1], e, "high"),
      numberArg(a[2], e, "low"),
      lengthArg(a[3], e)
    )
  ),
  "ta.tr": pure(
    ["handle_na"],
    (a, e) => trueRange(e.host.bars, e.bar, boolArg(a[0], e, false)),
    0
  ),
  "ta.valuewhen": stateful(["condition", "source", "occurrence"], (a, e) =>
    valuewhen(
      e.site(),
      e.bar,
      truthy(a[0], e.at),
      src(a, e, 1),
      countArg(a[2], e, "occurrence")
    )
  ),
  "ta.vwma": stateful(["source", "length"], (a, e) =>
    vwma(e.site(), e.bar, src(a, e), barAt(e).volume, lengthArg(a[1], e))
  ),
  "ta.wma": stateful(["source", "length"], (a, e) =>
    wma(e.site(), e.bar, src(a, e), lengthArg(a[1], e))
  ),
};

export const BUILTIN_FUNCTIONS: ReadonlyMap<string, BuiltinFunction> = new Map(
  Object.entries(functions)
);

// Namespaces Pine has but this subset does not (or only partly) implement; unknown
// members produce "not supported in Vertex scripts yet: <name>" instead of "unknown".
export const PINE_NAMESPACES: ReadonlySet<string> = new Set([
  "ta",
  "math",
  "input",
  "strategy",
  "color",
  "str",
  "plot",
  "location",
  "shape",
  "size",
  "display",
  "barstate",
  "request",
  "array",
  "matrix",
  "map",
  "table",
  "label",
  "line",
  "box",
  "linefill",
  "polyline",
  "chart",
  "ticker",
  "timeframe",
  "syminfo",
  "session",
  "runtime",
  "log",
  "xloc",
  "yloc",
  "extend",
  "text",
  "font",
  "position",
  "dividends",
  "earnings",
  "splits",
  "currency",
  "format",
  "scale",
  "barmerge",
  "hline",
  "order",
  "adjustment",
  "backadjustment",
  "settlement_as_close",
]);

// Ignored builtins warn once per script.
export const ignoredWarning = (name: string): string =>
  `${name}() is ignored in Vertex scripts`;
