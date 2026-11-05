"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandleCanvas } from "./renderer-host.tsx";
import type {
  CandleRenderer,
  CandleRendererFactory,
  ChartMarker,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";
import { VERTEX_STUDIES } from "./vertex-studies.ts";
import {
  CHART_TYPES,
  type ChartType,
  DRAWING_TOOLS,
  type Drawing,
  type DrawingTool,
  dataWindowRows,
  describeDrawing,
  displayValues,
  drawingsStorageKey,
  isChartType,
  parseDrawings,
  screenshotFileName,
  upsertDrawing,
} from "./workstation.ts";

export type ChartWorkstationProps = Readonly<{
  candles: readonly DisplayCandle[];
  symbol: string;
  label: string;
  pricePrecision: number;
  studies: ChartStudies;
  markers: readonly ChartMarker[];
  factory: CandleRendererFactory;
  captions: Readonly<{ ready: string; loading: string; error: string }>;
  // Injected for tests; defaults to window.localStorage.
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => Date;
}>;

const browserStorage = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const BUTTON =
  "min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted focus-visible:outline-2 aria-pressed:bg-muted aria-pressed:font-semibold";

export const ChartWorkstation = ({
  candles,
  symbol,
  label,
  pricePrecision,
  studies,
  markers,
  factory,
  captions,
  storage = browserStorage(),
  now = () => new Date(),
}: ChartWorkstationProps) => {
  const key = drawingsStorageKey(symbol);
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [drawings, setDrawings] = useState<readonly Drawing[]>(() =>
    parseDrawings(storage?.getItem(key) ?? null)
  );
  const [renderer, setRenderer] = useState<CandleRenderer | null>(null);
  const [hover, setHoverState] = useState<Readonly<{
    timestamp: number;
    values: readonly DisplayCandle[];
    key: string;
  }> | null>(null);
  const [noteText, setNoteText] = useState("");
  const [status, setStatus] = useState("");
  const values = useMemo(
    () => displayValues(candles, chartType),
    [candles, chartType]
  );
  const series = useRef({ key, values });
  series.current = { key, values };
  const setHover = useCallback((timestamp: number | null) => {
    setHoverState(timestamp === null ? null : { ...series.current, timestamp });
  }, []);
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setDrawings(parseDrawings(storage?.getItem(key) ?? null));
    return;
  }, [key, storage]);
  const save = useCallback(
    (next: readonly Drawing[]) => {
      try {
        storage?.setItem(key, JSON.stringify(next));
      } catch {
        setStatus("Drawings could not be saved in this browser.");
      }
      return next;
    },
    [key, storage]
  );
  const onChange = useCallback(
    (drawing: Drawing) =>
      setDrawings((current) => save(upsertDrawing(current, drawing))),
    [save]
  );
  useEffect(() => {
    renderer?.setChartType?.(chartType);
    return;
  }, [renderer, chartType]);
  useEffect(() => {
    renderer?.setDrawings?.(drawings, onChange);
    return;
  }, [renderer, drawings, onChange]);
  useEffect(() => {
    renderer?.onCrosshair?.(setHover);
    return;
  }, [renderer]);
  // A hover belongs to one bar series: a new symbol or new bars start at the latest bar.
  const hoverTimestamp =
    hover !== null && hover.values === values && hover.key === key
      ? hover.timestamp
      : null;
  // The latest bar when nothing is hovered or the hovered time is not in this series.
  const hovered =
    hoverTimestamp === null
      ? -1
      : values.findIndex((bar) => bar.timestamp === hoverTimestamp);
  const index = hovered < 0 ? values.length - 1 : hovered;
  const rows = dataWindowRows(
    values[index],
    index > 0 ? values[index - 1]?.close : undefined,
    pricePrecision
  );
  const startDrawing = (tool: DrawingTool) => {
    if (renderer?.startDrawing === undefined) return;
    renderer.startDrawing(
      tool,
      tool === "text" ? noteText || "Note" : "",
      onChange
    );
    setStatus(
      `Click on the chart to place the ${DRAWING_TOOLS.find((entry) => entry.id === tool)?.label.toLowerCase()}.`
    );
  };
  const remove = (id: string) =>
    setDrawings((current) =>
      save(current.filter((drawing) => drawing.id !== id))
    );
  const screenshot = () => {
    const url = renderer?.snapshot?.() ?? "";
    if (url === "") {
      setStatus("Screenshot is not available yet.");
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = screenshotFileName(label, now());
    link.click();
    setStatus("Screenshot saved as PNG.");
  };
  return (
    <div className="space-y-3" data-chart-workstation="">
      <div
        aria-label="Chart tools"
        className="flex flex-wrap items-center gap-2"
        role="toolbar"
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          Chart type
          <select
            className="min-h-11 rounded-md border border-border bg-background px-2"
            data-chart-type=""
            onChange={(event) => {
              if (isChartType(event.target.value))
                setChartType(event.target.value);
            }}
            value={chartType}
          >
            {CHART_TYPES.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        {DRAWING_TOOLS.map((tool) => (
          <button
            className={BUTTON}
            data-drawing-tool={tool.id}
            disabled={renderer === null}
            key={tool.id}
            onClick={() => startDrawing(tool.id)}
            type="button"
          >
            {tool.label}
          </button>
        ))}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          Note text
          <input
            className="min-h-11 w-32 rounded-md border border-border bg-background px-2"
            maxLength={80}
            onChange={(event) => setNoteText(event.target.value)}
            value={noteText}
          />
        </label>
        <button
          className={BUTTON}
          data-chart-screenshot=""
          disabled={renderer === null}
          onClick={screenshot}
          type="button"
        >
          Screenshot (PNG)
        </button>
      </div>
      <p aria-live="polite" className="min-h-5 text-muted-foreground text-xs">
        {status}
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        {/* KLineCharts sends no crosshair event on leave: reset the data window here (mouse and pen). */}
        <div
          className="min-w-0"
          onPointerLeave={(event) => {
            // A touch lifts with pointerleave while KLineCharts keeps the tapped bar.
            if (event.pointerType !== "touch") setHover(null);
          }}
        >
          <CandleCanvas
            captions={captions}
            factory={factory}
            label={label}
            markers={markers}
            onRenderer={setRenderer}
            pricePrecision={pricePrecision}
            studies={studies}
            values={values}
            volumePrecision={0}
          />
        </div>
        <aside className="space-y-4 text-sm">
          <section aria-labelledby="vx-data-window" data-data-window="">
            <h3 className="font-semibold" id="vx-data-window">
              Data window
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {rows.map((row) => (
                <div className="contents" key={row.label}>
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-right font-mono tabular-nums">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="vx-object-tree" data-object-tree="">
            <h3 className="font-semibold" id="vx-object-tree">
              Object tree
            </h3>
            <ul className="mt-2 space-y-1">
              <li>
                {CHART_TYPES.find((type) => type.id === chartType)?.label}
              </li>
              {[
                studies.volume ? "Volume" : null,
                ...studies.sma.map((period) => `SMA ${period}`),
                ...studies.ema.map((period) => `EMA ${period}`),
                ...(studies.extra ?? []).map((id) => VERTEX_STUDIES[id].label),
                markers.length > 0 ? `Trade markers (${markers.length})` : null,
              ]
                .filter((entry): entry is string => entry !== null)
                .map((entry) => (
                  <li className="text-muted-foreground" key={entry}>
                    {entry}
                  </li>
                ))}
              {drawings.map((drawing) => (
                <li
                  className="flex items-center justify-between gap-2"
                  data-drawing-id={drawing.id}
                  key={drawing.id}
                >
                  <span className="min-w-0 truncate">
                    {describeDrawing(drawing, pricePrecision)}
                  </span>
                  <button
                    aria-label={`Remove ${describeDrawing(drawing, pricePrecision)}`}
                    className={BUTTON}
                    onClick={() => remove(drawing.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
};
