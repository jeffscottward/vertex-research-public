// Vertex scripts: a Pine Script v5/v6 compatible subset, parsed and interpreted here.
// Independent source (not PineTS, which is AGPL-3.0-only). User code is never passed to
// eval/Function: it is tokenized, parsed to an AST and walked bar by bar with an operation
// budget, so a script cannot reach the network, the DOM or storage. Display only: script
// output, including strategy.entry/close signals, is a chart annotation, never a trading input.

export const SCRIPT_SOURCE_MAX = 16_000;
export const SCRIPT_BARS_MAX = 5000;
export const SCRIPT_PLOTS_MAX = 16;
export const SCRIPT_SIGNALS_MAX = 500;
export const SCRIPT_OPS_DEFAULT = 2_000_000;

export type ScriptError = Readonly<{
  line: number; // 1-based
  column: number; // 1-based
  message: string;
}>;

export type ScriptBar = Readonly<{
  timestamp: number; // ms UTC, strictly increasing
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type ScriptInputValue = number | boolean | string;

export type ScriptInputSpec = Readonly<{
  id: string; // stable: the variable name it is assigned to
  title: string;
  kind: "int" | "float" | "bool" | "source" | "string";
  defval: ScriptInputValue;
  min?: number;
  max?: number;
  options?: readonly string[];
}>;

export type ScriptPlotKind = "line" | "histogram" | "circles" | "hline";

export type ScriptPlot = Readonly<{
  id: string; // "plot_0", "plot_1", ... in declaration order
  title: string;
  kind: ScriptPlotKind;
  color: string; // CSS hex "#rrggbb"
  // One value per input bar; null = na (not drawn).
  values: readonly (number | null)[];
}>;

export type ScriptSignal = Readonly<{
  timestamp: number;
  value: number; // price used to place the marker (bar high for abovebar, low for belowbar)
  text: string; // <= 24 chars
  kind: "long" | "short" | "exit" | "shape";
  location: "abovebar" | "belowbar";
}>;

export type ScriptDeclaration = Readonly<{
  kind: "indicator" | "strategy";
  title: string;
  shortTitle: string;
  overlay: boolean;
  inputs: readonly ScriptInputSpec[];
}>;

export type CompileResult =
  | (Readonly<{ ok: true }> & ScriptDeclaration)
  | Readonly<{ ok: false; errors: readonly ScriptError[] }>;

export type RunResult =
  | (Readonly<{
      ok: true;
      plots: readonly ScriptPlot[];
      signals: readonly ScriptSignal[];
      warnings: readonly string[];
    }> &
      ScriptDeclaration)
  | Readonly<{ ok: false; errors: readonly ScriptError[] }>;

export type RunOptions = Readonly<{
  inputs?: Readonly<Record<string, ScriptInputValue>>;
  maxOps?: number;
}>;

export type ScriptTemplateCategory =
  | "trend"
  | "momentum"
  | "volatility"
  | "volume"
  | "strategy";

export type ScriptTemplate = Readonly<{
  id: string;
  title: string;
  category: ScriptTemplateCategory;
  description: string;
  source: string;
}>;

// biome-ignore lint/performance/noBarrelFile: the package root is the public scripting entrypoint.
export { compileScript, runScript } from "./interpreter.ts";
export { SCRIPT_TEMPLATES, scriptTemplate } from "./templates.ts";
