// View model for the script panel: pure functions, no React and no engine execution.

import type {
  RunResult,
  ScriptBar,
  ScriptInputSpec,
  ScriptInputValue,
  ScriptTemplate,
  ScriptTemplateCategory,
} from "@darkfactory/scripting";
import type { ScriptInputs } from "./script-sandbox.ts";
import type { ActiveScript, SavedScript } from "./scripts-storage.ts";
import type { DisplayCandle, ScriptLayer } from "./types.ts";

export const NEW_SCRIPT_SOURCE = `//@version=5
indicator("My script", overlay=true)
length = input.int(20, "Length", minval=1)
plot(ta.sma(close, length), "SMA")
`;

export const SOURCE_OPTIONS = Object.freeze([
  "open",
  "high",
  "low",
  "close",
  "hl2",
  "hlc3",
  "ohlc4",
  "volume",
] as const);

const TEMPLATE_CATEGORIES: readonly Readonly<{
  id: ScriptTemplateCategory;
  label: string;
}>[] = Object.freeze([
  { id: "trend", label: "Trend" },
  { id: "momentum", label: "Momentum" },
  { id: "volatility", label: "Volatility" },
  { id: "volume", label: "Volume" },
  { id: "strategy", label: "Strategy signals" },
]);

// A script on the chart: what to run. Its output is kept separately per bar series.
export type AppliedScript = Readonly<{
  id: string;
  title: string;
  source: string;
  // "saved:<id>" or "template:<id>" when it can be restored after a reload; null otherwise.
  ref: string | null;
  inputs: ScriptInputs;
}>;

export type ScriptRun = Readonly<{
  bars: readonly ScriptBar[];
  source: string;
  inputs: ScriptInputs;
  result: RunResult;
}>;

export const toScriptBars = (
  candles: readonly DisplayCandle[]
): readonly ScriptBar[] =>
  candles.map(({ timestamp, open, high, low, close, volume }) => ({
    close,
    high,
    low,
    open,
    timestamp,
    volume,
  }));

// True when the run used exactly these bars, this source and these inputs.
export const isFreshRun = (
  run: ScriptRun | undefined,
  entry: AppliedScript,
  bars: readonly ScriptBar[]
): run is ScriptRun =>
  run !== undefined &&
  run.bars === bars &&
  run.source === entry.source &&
  run.inputs === entry.inputs;

/**
 * Chart layers for the applied scripts, or null while any of them has not yet run on the
 * current bars (the chart keeps its previous layers instead of drawing misaligned values).
 * A script whose run failed draws nothing.
 */
export const scriptLayers = (
  applied: readonly AppliedScript[],
  runs: ReadonlyMap<string, ScriptRun>,
  bars: readonly ScriptBar[]
): readonly ScriptLayer[] | null => {
  const layers: ScriptLayer[] = [];
  for (const entry of applied) {
    const run = runs.get(entry.id);
    if (!isFreshRun(run, entry, bars)) return null;
    if (run.result.ok)
      layers.push({
        id: entry.id,
        overlay: run.result.overlay,
        plots: run.result.plots,
        signals: run.result.signals,
        title: (
          run.result.shortTitle ||
          run.result.title ||
          entry.title ||
          "Script"
        ).slice(0, 80),
      });
  }
  return layers;
};

// Text offset of a 1-based line and column, clamped to the source.
export const caretOffset = (
  source: string,
  line: number,
  column: number
): number => {
  const lines = source.split("\n");
  const row = Math.min(Math.max(1, Math.trunc(line) || 1), lines.length);
  const before = lines
    .slice(0, row - 1)
    .reduce((sum, text) => sum + text.length + 1, 0);
  const end = source.indexOf("\n", before);
  const width = (end < 0 ? source.length : end) - before;
  return before + Math.min(Math.max(0, (Math.trunc(column) || 1) - 1), width);
};

export type TemplateGroup = Readonly<{
  id: ScriptTemplateCategory;
  label: string;
  templates: readonly ScriptTemplate[];
}>;

export const groupTemplates = (
  templates: readonly ScriptTemplate[]
): readonly TemplateGroup[] =>
  TEMPLATE_CATEGORIES.map((category) => ({
    ...category,
    templates: templates.filter(
      (template) => template.category === category.id
    ),
  })).filter((group) => group.templates.length > 0);

// Restorable scripts for the stored refs; refs whose script is gone are dropped.
export const resolveActiveScripts = (
  active: readonly ActiveScript[],
  saved: readonly SavedScript[],
  templates: readonly ScriptTemplate[]
): readonly Omit<AppliedScript, "id">[] =>
  active.flatMap((entry) => {
    const [kind, ...rest] = entry.ref.split(":");
    const id = rest.join(":");
    const script =
      kind === "saved"
        ? saved.find((candidate) => candidate.id === id)
        : templates.find((candidate) => candidate.id === id);
    if (script === undefined) return [];
    return [
      {
        inputs: entry.inputs,
        ref: entry.ref,
        source: script.source,
        title: script.title,
      },
    ];
  });

// The current value for one input: a stored value of the right type, else its default.
export const inputValue = (
  spec: ScriptInputSpec,
  values: ScriptInputs
): ScriptInputValue => {
  const value = Object.hasOwn(values, spec.id) ? values[spec.id] : undefined;
  return value !== undefined && typeof value === typeof spec.defval
    ? value
    : spec.defval;
};

// Parse one control value; null when it is not acceptable for the input (kept unchanged).
export const parseInputValue = (
  spec: ScriptInputSpec,
  raw: string | boolean
): ScriptInputValue | null => {
  if (spec.kind === "bool") return typeof raw === "boolean" ? raw : null;
  if (typeof raw !== "string") return null;
  if (spec.kind === "int" || spec.kind === "float") {
    if (raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    if (spec.kind === "int" && !Number.isInteger(value)) return null;
    if (spec.min !== undefined && value < spec.min) return null;
    if (spec.max !== undefined && value > spec.max) return null;
    return value;
  }
  return raw.slice(0, 200);
};

export const inputOptions = (spec: ScriptInputSpec): readonly string[] =>
  spec.options !== undefined && spec.options.length > 0
    ? spec.options
    : spec.kind === "source"
      ? SOURCE_OPTIONS
      : [];

const count = (value: number, noun: string): string =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

// Status copy for one run of the editor script.
export const describeRun = (result: RunResult, title: string): string => {
  if (!result.ok)
    return `"${title}" did not run: ${count(result.errors.length, "error")}.`;
  const warnings =
    result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
  return `"${title}" is on the chart: ${count(result.plots.length, "plot")}, ${count(result.signals.length, "signal")}.${warnings}`;
};
