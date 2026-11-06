// Assistant chart tools: a small table of tools that run inside the assistant turn (they are not MCP
// procedures and change nothing on the server). Each valid call returns a display artifact that the
// portal applies to the chart workstation: Quant drawings, a clear of those drawings, a Vertex script
// for the editor, or a teach walkthrough. Available in Plan and Act mode. Display only: nothing here
// can place or route orders, arm trading or change risk settings.
import {
  type CompileResult,
  compileScript,
  type ScriptError,
} from "@darkfactory/scripting";
import { z } from "zod";

import {
  ASSISTANT_ARTIFACT_DRAWINGS_MAX,
  ASSISTANT_DRAWING_POINTS,
  ASSISTANT_DRAWING_TEXT_MAX,
  ASSISTANT_DRAWING_TOOLS,
  ASSISTANT_SCRIPT_SOURCE_MAX,
  ASSISTANT_SCRIPT_TITLE_MAX,
  ASSISTANT_TEACH_STEP_BODY_MAX,
  ASSISTANT_TEACH_STEP_DRAWINGS_MAX,
  ASSISTANT_TEACH_STEP_TITLE_MAX,
  ASSISTANT_TEACH_STEPS_MAX,
  ASSISTANT_TEACH_TOPIC_MAX,
  type AssistantArtifact,
  AssistantArtifactSchema,
  type AssistantDrawing,
} from "../contracts/assistant.ts";
import { MarketSymbolSchema } from "../contracts/market-data.ts";

/**
 * Most artifact bytes one turn may hand out, measured as Postgres stores them (jsonbTextBytes). The
 * stored trace row is capped at 64 KB; the rest is left for the other trace entries.
 */
export const ASSISTANT_ARTIFACT_BUDGET_BYTES = 24 * 1024;
/** Compile errors listed back to the model, so it can fix the script and call again. */
const CHART_SCRIPT_ERRORS_LISTED = 10;
const ERROR_MESSAGE_MAX = 160;
const ISSUES_LISTED = 5;
// Epoch values below this are almost certainly seconds, not milliseconds (before March 1973).
const EPOCH_MS_MIN = 100_000_000_000;
const EPOCH_MS_MAX = 8_640_000_000_000_000;
// ISO-8601 date or date-time; a date-time without an offset is read as UTC.
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;

export type ChartToolContext = Readonly<{
  /** Short id of the turn; drawing ids are quant-<turnId>-<n>. */
  turnId: string;
  /** The next drawing number in this turn (1, 2, ...), shared by every chart tool call. */
  nextDrawingNumber: () => number;
  /** The symbol of the chart the operator is on (page.chart), the default for a missing symbol. */
  chartSymbol?: string | undefined;
}>;

export type ChartToolOutcome =
  | Readonly<{ text: string }>
  | Readonly<{ text: string; artifact: AssistantArtifact }>
  | Readonly<{ error: string }>;

export type ChartTool = Readonly<{
  name: string;
  description: string;
  /** JSON Schema of the arguments (from the zod input, like the MCP catalogue). */
  parameters: Record<string, unknown>;
  run: (args: unknown, context: ChartToolContext) => ChartToolOutcome;
}>;

const SYMBOL_HELP =
  "Exact chart symbol from the page context (for example a futures local symbol like ESZ6, not the root ES). Leave it out to use the chart the operator is on.";

const PointArgSchema = z
  .object({
    time: z
      .union([z.string().min(1).max(40), z.number().int()])
      .describe(
        "Bar time: ISO-8601 (2026-01-02 or 2026-01-02T14:30:00Z; no offset means UTC) or epoch milliseconds"
      ),
    price: z
      .number()
      .describe("Price level (use real prices from market_bars)"),
  })
  .strict();

const DrawingArgSchema = z
  .object({
    tool: z
      .enum(ASSISTANT_DRAWING_TOOLS)
      .describe(
        "level and text take 1 point; trend, rectangle and fib take 2 points"
      ),
    points: z.array(PointArgSchema).min(1).max(2),
    text: z
      .string()
      .max(ASSISTANT_DRAWING_TEXT_MAX)
      .optional()
      .describe("Label (required for text notes)"),
  })
  .strict();

type DrawingArg = z.infer<typeof DrawingArgSchema>;

const ChartDrawInputSchema = z
  .object({
    symbol: MarketSymbolSchema.optional().describe(SYMBOL_HELP),
    replace: z
      .boolean()
      .optional()
      .describe("true: remove your earlier drawings on this symbol first"),
    drawings: z
      .array(DrawingArgSchema)
      .min(1)
      .max(ASSISTANT_ARTIFACT_DRAWINGS_MAX),
  })
  .strict();

const ChartClearInputSchema = z
  .object({ symbol: MarketSymbolSchema.optional().describe(SYMBOL_HELP) })
  .strict();

const ChartScriptInputSchema = z
  .object({
    title: z.string().trim().min(1).max(ASSISTANT_SCRIPT_TITLE_MAX),
    source: z
      .string()
      .min(1)
      .max(ASSISTANT_SCRIPT_SOURCE_MAX)
      .describe(
        'Vertex script source (Pine Script v5 subset), starting with //@version=5 and indicator("...") or strategy("...")'
      ),
  })
  .strict();

const TeachStepsInputSchema = z
  .object({
    symbol: MarketSymbolSchema.optional().describe(
      "Chart symbol the step drawings belong to (exact, from the page context). Leave it out to use the chart the operator is on."
    ),
    topic: z.string().trim().min(1).max(ASSISTANT_TEACH_TOPIC_MAX),
    steps: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(ASSISTANT_TEACH_STEP_TITLE_MAX),
            body: z.string().trim().min(1).max(ASSISTANT_TEACH_STEP_BODY_MAX),
            drawings: z
              .array(DrawingArgSchema)
              .max(ASSISTANT_TEACH_STEP_DRAWINGS_MAX)
              .optional(),
          })
          .strict()
      )
      .min(1)
      .max(ASSISTANT_TEACH_STEPS_MAX),
  })
  .strict();

// Control characters (except line feed and tab) and lone surrogates: Postgres jsonb refuses
// \u0000 and broken UTF-16, and none of them belongs in a label, a walkthrough or a script.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]|\p{Cs}/gu;

/** Text without control characters (line feed and tab stay) or lone surrogates. */
export const cleanText = (text: string): string =>
  text.replace(UNSAFE_TEXT, "");

/** The same value with every string (at any depth) passed through cleanText. */
export const cleanStrings = (value: unknown): unknown => {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanStrings(item)])
    );
  return value;
};

const NO_SYMBOL =
  "Name the chart symbol: no symbol was given and the operator is not on a chart";

// The symbol given, else the chart the operator is on; upper case (the chart's storage key).
const symbolFor = (
  given: string | undefined,
  context: ChartToolContext
): string | null => {
  const symbol = (given ?? context.chartSymbol ?? "").trim().toUpperCase();
  return symbol.length > 0 ? symbol : null;
};

const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return rest;
};

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// The first few validation issues, one line each, for the model to fix its call.
const issuesText = (error: z.ZodError): string => {
  const listed = error.issues.slice(0, ISSUES_LISTED).map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path.length > 0 ? path : "arguments"}: ${issue.message}`;
  });
  const more = error.issues.length - listed.length;
  return `Invalid arguments: ${listed.join("; ")}${more > 0 ? ` (and ${more} more)` : ""}`;
};

/** Bar time to epoch milliseconds, or null when it is not a usable ISO-8601 time or epoch ms. */
export const parseChartTime = (time: string | number): number | null => {
  if (typeof time === "number") {
    const magnitude = Math.abs(time);
    return Number.isSafeInteger(time) &&
      magnitude >= EPOCH_MS_MIN &&
      magnitude <= EPOCH_MS_MAX
      ? time
      : null;
  }
  const trimmed = time.trim();
  const match = ISO_TIME.exec(trimmed);
  if (match === null) return null;
  const hasTime = trimmed.length > 10;
  const utc = hasTime && match[1] === undefined ? `${trimmed}Z` : trimmed;
  const value = Date.parse(utc.replace(" ", "T"));
  return Number.isFinite(value) ? value : null;
};

// Converts the model's drawings (time/price points) to the chart's shape (timestamp/value) with
// Quant ids. Returns an error text naming the first bad drawing.
const toDrawings = (
  drawings: readonly DrawingArg[],
  context: ChartToolContext,
  where: string
): AssistantDrawing[] | string => {
  const converted: AssistantDrawing[] = [];
  for (const [index, drawing] of drawings.entries()) {
    const label = `${where}[${index}]`;
    const needed = ASSISTANT_DRAWING_POINTS[drawing.tool];
    if (drawing.points.length !== needed)
      return `${label}: a ${drawing.tool} drawing needs ${needed} ${needed === 1 ? "point" : "points"}, got ${drawing.points.length}`;
    const text = (drawing.text ?? "").trim();
    if (drawing.tool === "text" && text.length === 0)
      return `${label}: a text drawing needs text`;
    const points: { timestamp: number; value: number }[] = [];
    for (const [pointIndex, point] of drawing.points.entries()) {
      const timestamp = parseChartTime(point.time);
      if (timestamp === null)
        return `${label}.points[${pointIndex}].time: use ISO-8601 (2026-01-02T14:30:00Z) or epoch milliseconds`;
      points.push({ timestamp, value: point.price });
    }
    converted.push({
      id: `quant-${context.turnId}-${context.nextDrawingNumber()}`,
      points,
      text,
      tool: drawing.tool,
    });
  }
  return converted;
};

// The final shape check: an artifact that the contract would refuse never leaves the runtime.
const checked = (
  text: string,
  artifact: AssistantArtifact
): ChartToolOutcome => {
  const parsed = AssistantArtifactSchema.safeParse(artifact);
  return parsed.success
    ? { artifact: parsed.data, text }
    : { error: issuesText(parsed.error) };
};

const scriptErrorsText = (errors: readonly ScriptError[]): string => {
  const listed = errors
    .slice(0, CHART_SCRIPT_ERRORS_LISTED)
    .map(
      (error) =>
        `- line ${error.line}:${error.column} ${clip(error.message, ERROR_MESSAGE_MAX)}`
    );
  const more = errors.length - listed.length;
  return [
    `The script did not compile (${errors.length} ${errors.length === 1 ? "error" : "errors"}). Fix them and call chart_script again:`,
    ...listed,
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join("\n");
};

const chartDraw: ChartTool = {
  description:
    "Draw on the operator's chart (display only): horizontal levels, trend lines, rectangles, Fibonacci retracements and text notes at real bar times and prices. Get times and prices from market_bars first; never invent prices. Use the exact chart symbol from the page context (or leave symbol out on the chart page). At most 24 drawings per call.",
  name: "chart_draw",
  parameters: jsonSchemaOf(ChartDrawInputSchema),
  run: (args, context) => {
    const parsed = ChartDrawInputSchema.safeParse(args);
    if (!parsed.success) return { error: issuesText(parsed.error) };
    const drawings = toDrawings(parsed.data.drawings, context, "drawings");
    if (typeof drawings === "string") return { error: drawings };
    const symbol = symbolFor(parsed.data.symbol, context);
    if (symbol === null) return { error: NO_SYMBOL };
    return checked(
      `Prepared ${drawings.length} ${drawings.length === 1 ? "drawing" : "drawings"} for ${symbol} (display only). The operator's chart shows them; nothing else changed.`,
      {
        drawings,
        kind: "chart_drawings",
        replace: parsed.data.replace ?? false,
        symbol,
      }
    );
  },
};

const chartClear: ChartTool = {
  description:
    "Remove the drawings you made on the operator's chart for one symbol (the operator's own drawings stay). Display only.",
  name: "chart_clear_drawings",
  parameters: jsonSchemaOf(ChartClearInputSchema),
  run: (args, context) => {
    const parsed = ChartClearInputSchema.safeParse(args);
    if (!parsed.success) return { error: issuesText(parsed.error) };
    const symbol = symbolFor(parsed.data.symbol, context);
    if (symbol === null) return { error: NO_SYMBOL };
    return checked(
      `Prepared a clear of your drawings on ${symbol} (display only).`,
      { kind: "chart_clear", symbol }
    );
  },
};

const chartScript: ChartTool = {
  description:
    "Write an indicator for the chart's script editor in Vertex script (a Pine Script v5 subset: indicator()/strategy(), input.*, ta.*, math.*, plot, plotshape, hline). The script is checked first: compile errors come back with line:column so you can fix and retry. Display only: strategy.entry output is a chart marker, never an order.",
  name: "chart_script",
  parameters: jsonSchemaOf(ChartScriptInputSchema),
  run: (args) => {
    const parsed = ChartScriptInputSchema.safeParse(args);
    if (!parsed.success) return { error: issuesText(parsed.error) };
    let result: CompileResult;
    try {
      result = compileScript(parsed.data.source);
    } catch {
      return { error: "The script check failed; try a simpler script" };
    }
    if (!result.ok) return { error: scriptErrorsText(result.errors) };
    return checked(
      `Compiled "${clip(result.title, ASSISTANT_SCRIPT_TITLE_MAX)}" (${result.kind}, ${result.overlay ? "on the price chart" : "in its own pane"}, ${result.inputs.length} ${result.inputs.length === 1 ? "input" : "inputs"}). The operator can open it in the chart's script editor; it is display only.`,
      {
        kind: "chart_script",
        overlay: result.overlay,
        source: parsed.data.source,
        title: parsed.data.title,
      }
    );
  },
};

const teachSteps: ChartTool = {
  description:
    "Show the operator a step-by-step walkthrough (1 to 12 steps, one idea per step, plain language). Each step may carry up to 4 chart drawings that illustrate it (real times and prices only). Educational only, never trading advice.",
  name: "teach_steps",
  parameters: jsonSchemaOf(TeachStepsInputSchema),
  run: (args, context) => {
    const parsed = TeachStepsInputSchema.safeParse(args);
    if (!parsed.success) return { error: issuesText(parsed.error) };
    const symbol = symbolFor(parsed.data.symbol, context);
    const steps: Extract<
      AssistantArtifact,
      { kind: "teach" }
    >["steps"][number][] = [];
    for (const [index, step] of parsed.data.steps.entries()) {
      if (step.drawings === undefined || step.drawings.length === 0) {
        steps.push({ body: step.body, title: step.title });
        continue;
      }
      const drawings = toDrawings(
        step.drawings,
        context,
        `steps[${index}].drawings`
      );
      if (typeof drawings === "string") return { error: drawings };
      if (symbol === null)
        return {
          error: `steps[${index}].drawings: ${NO_SYMBOL}`,
        };
      steps.push({ body: step.body, drawings, title: step.title });
    }
    return checked(
      `Prepared a ${steps.length}-step walkthrough of "${parsed.data.topic}". The operator sees it as a stepper under your reply; keep your text reply short.`,
      {
        kind: "teach",
        steps,
        topic: parsed.data.topic,
        ...(symbol === null ? {} : { symbol }),
      }
    );
  },
};

export const ASSISTANT_CHART_TOOLS: readonly ChartTool[] = Object.freeze([
  chartDraw,
  chartClear,
  chartScript,
  teachSteps,
]);

const chartToolByName = new Map(
  ASSISTANT_CHART_TOOLS.map((tool) => [tool.name, tool])
);

export const isChartTool = (name: string): boolean => chartToolByName.has(name);

/** Runs one chart tool; an unknown name or a throwing tool becomes an error outcome. */
export const runChartTool = (
  name: string,
  args: unknown,
  context: ChartToolContext
): ChartToolOutcome => {
  const tool = chartToolByName.get(name);
  if (tool === undefined)
    return { error: "Tool not available to the assistant" };
  try {
    return tool.run(cleanStrings(args), context);
  } catch {
    return { error: "Chart tool failed" };
  }
};

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

// Postgres prints numbers without exponents: 1.5e-7 is stored as 0.00000015 (longer than in JSON).
const numberBytes = (value: number): number => {
  const text = String(value);
  const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-])(\d+)$/u.exec(text);
  if (exponent === null) return text.length;
  const digits = (exponent[2] ?? "").length + (exponent[3] ?? "").length;
  const power = Number(exponent[5]);
  return (exponent[1] ?? "").length + digits + power + 2;
};

/**
 * Bytes `value` takes in Postgres's jsonb text form (octet_length(jsonb::text)), which the
 * assistant_messages check caps: JSON with ", " and ": " separators, UTF-8 strings, plain numbers.
 * An upper bound for the values the assistant stores.
 */
export const jsonbTextBytes = (value: unknown): number => {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return utf8Bytes(JSON.stringify(value));
  if (typeof value === "number") return numberBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    const items = value.map(jsonbTextBytes);
    return (
      2 +
      items.reduce((sum, size) => sum + size, 0) +
      2 * Math.max(0, items.length - 1)
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined
    );
    const sizes = entries.map(
      ([key, item]) => jsonbTextBytes(key) + 2 + jsonbTextBytes(item)
    );
    return (
      2 +
      sizes.reduce((sum, size) => sum + size, 0) +
      2 * Math.max(0, sizes.length - 1)
    );
  }
  return 4;
};

/** The assistant_messages.tool_calls check: at most 64 entries and 65,536 bytes of jsonb text. */
const TRACE_STORE_MAX_ENTRIES = 64;
// Below the 65,536-byte check, with room for estimate error and the db layer's normalizing.
const TRACE_STORE_MAX_BYTES = 60_000;
export const ARTIFACT_NOT_STORED =
  "Chart output not kept: this reply reached the stored size limit";

type StorableEntry = Readonly<{ error: string | null; artifact?: unknown }>;

/**
 * The trace as it can always be stored: strings cleaned (cleanText), at most 64 entries, and under
 * the byte cap. Artifacts go first, from the end (the entry stays with a note), then whole entries
 * from the end, so a turn's reply is always saved.
 */
export const storableTrace = <Entry extends StorableEntry>(
  trace: readonly Entry[]
): Entry[] => {
  const rows = trace
    .slice(0, TRACE_STORE_MAX_ENTRIES)
    .map((entry) => cleanStrings(entry) as Entry);
  let size = jsonbTextBytes(rows);
  for (
    let index = rows.length - 1;
    index >= 0 && size > TRACE_STORE_MAX_BYTES;
    index -= 1
  ) {
    const row = rows[index];
    if (row?.artifact === undefined) continue;
    const { artifact: _dropped, ...rest } = row;
    rows[index] = { ...rest, error: ARTIFACT_NOT_STORED } as unknown as Entry;
    size = jsonbTextBytes(rows);
  }
  while (rows.length > 0 && size > TRACE_STORE_MAX_BYTES) {
    rows.pop();
    size = jsonbTextBytes(rows);
  }
  return rows;
};

/** A short turn id for drawing ids: the last 8 letters or digits of the given id. */
export const shortTurnId = (id: string): string => {
  const compact = id.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return compact.length > 0
    ? compact.slice(-8)
    : Math.random().toString(36).slice(2, 10);
};
