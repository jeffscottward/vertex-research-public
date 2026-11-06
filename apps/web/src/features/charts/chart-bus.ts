// Chart command bus: how the Quant assistant panel reaches the chart workstation.
// Commands are written to browser storage first (so a chart that mounts later still sees
// them), then announced with one window event so a mounted chart reloads. Display only.

import {
  type Drawing,
  drawingsStorageKey,
  parseDrawings,
  validDrawing,
} from "./workstation.ts";

export const QUANT_DRAWING_PREFIX = "quant-";
export const CHART_COMMAND_EVENT = "vx:chart-command";
export const PENDING_SCRIPT_KEY = "vx.charts.script.pending";
const PENDING_SOURCE_MAX = 16_000;
const PENDING_TITLE_MAX = 80;

export const isQuantDrawing = (drawing: Drawing): boolean =>
  drawing.id.startsWith(QUANT_DRAWING_PREFIX);

export type ChartCommand =
  | Readonly<{
      type: "drawings";
      symbol: string;
      // Ids are re-prefixed with QUANT_DRAWING_PREFIX on apply.
      drawings: readonly Drawing[];
      // true: remove Quant's earlier drawings on this symbol first.
      replace: boolean;
    }>
  | Readonly<{ type: "clear_quant"; symbol: string }>
  | Readonly<{ type: "script"; title: string; source: string }>;

export type PendingScript = Readonly<{ title: string; source: string }>;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const quantId = (id: string): string =>
  id.startsWith(QUANT_DRAWING_PREFIX) ? id : `${QUANT_DRAWING_PREFIX}${id}`;

// Pure: the stored drawings after one drawings/clear command.
export const applyDrawingCommand = (
  current: readonly Drawing[],
  command: Extract<ChartCommand, { type: "drawings" | "clear_quant" }>
): readonly Drawing[] => {
  const kept =
    command.type === "clear_quant" || command.replace
      ? current.filter((drawing) => !isQuantDrawing(drawing))
      : current;
  if (command.type === "clear_quant") return kept;
  const added = command.drawings
    .map((drawing) => ({ ...drawing, id: quantId(drawing.id) }))
    .filter(validDrawing);
  const ids = new Set(added.map((drawing) => drawing.id));
  return [...kept.filter((drawing) => !ids.has(drawing.id)), ...added].slice(
    -200
  );
};

export const readPendingScript = (
  store: Store | null = browserStore()
): PendingScript | null => {
  try {
    const raw = store?.getItem(PENDING_SCRIPT_KEY) ?? null;
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { title, source } = parsed as Record<string, unknown>;
    if (typeof title !== "string" || typeof source !== "string") return null;
    if (source.length === 0 || source.length > PENDING_SOURCE_MAX) return null;
    return { source, title: title.slice(0, PENDING_TITLE_MAX) };
  } catch {
    return null;
  }
};

export const clearPendingScript = (store: Store | null = browserStore()) => {
  try {
    store?.removeItem(PENDING_SCRIPT_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
};

// Persist one command, then announce it. Returns false when storage refused it.
export const sendChartCommand = (
  command: ChartCommand,
  store: Store | null = browserStore(),
  target: Pick<EventTarget, "dispatchEvent"> | null = typeof window ===
  "undefined"
    ? null
    : window
): boolean => {
  let saved = true;
  try {
    if (command.type === "script") {
      store?.setItem(
        PENDING_SCRIPT_KEY,
        JSON.stringify({
          source: command.source.slice(0, PENDING_SOURCE_MAX),
          title: command.title.slice(0, PENDING_TITLE_MAX),
        })
      );
    } else {
      const key = drawingsStorageKey(command.symbol);
      const next = applyDrawingCommand(
        parseDrawings(store?.getItem(key) ?? null),
        command
      );
      store?.setItem(key, JSON.stringify(next));
    }
    if (store === null) saved = false;
  } catch {
    saved = false;
  }
  target?.dispatchEvent(
    new CustomEvent<ChartCommand>(CHART_COMMAND_EVENT, { detail: command })
  );
  return saved;
};

export const subscribeChartCommands = (
  listener: (command: ChartCommand) => void,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null =
    typeof window === "undefined" ? null : window
): (() => void) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "object" && detail !== null && "type" in detail)
      listener(detail as ChartCommand);
  };
  target?.addEventListener(CHART_COMMAND_EVENT, handler);
  return () => target?.removeEventListener(CHART_COMMAND_EVENT, handler);
};

// What the chart currently shows, for the assistant's page context. Module state: one chart.
export type ChartContext = Readonly<{
  symbol: string;
  label: string;
  bars: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastClose: number | null;
}>;

let currentChart: ChartContext | null = null;

export const publishChartContext = (context: ChartContext | null): void => {
  currentChart = context;
};

export const currentChartContext = (): ChartContext | null => currentChart;
