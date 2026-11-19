// Vertex scripts: a Pine Script v5/v6 compatible subset, parsed and interpreted here.
// Independent source (not PineTS, which is AGPL-3.0-only). User code is never passed to
// eval/Function: it is tokenized, parsed to an AST and walked bar by bar with an operation
// budget, so a script cannot reach the network, the DOM or storage. Display only: script
// output, including strategy.entry/close signals, is a chart annotation, never a trading input.

// biome-ignore lint/performance/noBarrelFile: the package root is the public scripting entrypoint.
export { compileScript, runScript } from "./interpreter.ts";
export {
  SCRIPT_BARS_MAX,
  SCRIPT_OPS_DEFAULT,
  SCRIPT_PLOTS_MAX,
  SCRIPT_SIGNALS_MAX,
  SCRIPT_SOURCE_MAX,
} from "./limits.ts";
export { SCRIPT_TEMPLATES, scriptTemplate } from "./templates.ts";
export type {
  CompileResult,
  RunOptions,
  RunResult,
  ScriptBar,
  ScriptDeclaration,
  ScriptError,
  ScriptInputSpec,
  ScriptInputValue,
  ScriptPlot,
  ScriptPlotKind,
  ScriptSignal,
  ScriptTemplate,
  ScriptTemplateCategory,
} from "./types.ts";
