import type {
  CandleRendererFactory,
  ChartMarker,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";
import {
  type ChartType,
  type Drawing,
  type DrawingPoint,
  type DrawingTool,
  validDrawing,
} from "./workstation.ts";
import {
  VERTEX_STUDIES,
  VERTEX_STUDY_IDS,
  type VertexStudyId,
  indicatorTemplate,
  isVertexStudyId,
  studyPaneId,
} from "./vertex-studies.ts";

const KLINECHARTS_VERSION = "9.8.12" as const;
// API source: https://unpkg.com/klinecharts@9.8.12/dist/index.d.ts
// Library remains Apache-2.0; preserve its bundled LICENSE/NOTICE on distribution.
// This adapter is independent source, not copied from another project's chart component.
const sameBar = (left: DisplayCandle, right: DisplayCandle): boolean => {
  return (
    left.id === right.id &&
    left.timestamp === right.timestamp &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
};

export const validDisplayCandles = (
  values: readonly DisplayCandle[]
): boolean => {
  if (
    values.length > 4096 ||
    new Set(values.map((bar) => bar.id)).size !== values.length
  )
    return false;
  return values.every((bar, index) => {
    return (
      typeof bar.id === "string" &&
      bar.id.length > 0 &&
      bar.id.length <= 160 &&
      Number.isSafeInteger(bar.timestamp) &&
      Math.abs(bar.timestamp) <= 8_640_000_000_000_000 &&
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) =>
          Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000
      ) &&
      bar.low <= bar.open &&
      bar.open <= bar.high &&
      bar.low <= bar.close &&
      bar.close <= bar.high &&
      (index === 0 || (values[index - 1]?.timestamp ?? 0) < bar.timestamp)
    );
  });
};

// Built-in KLineCharts 9.8.12 names: indicators "VOL", "MA", "EMA"; overlay "simpleAnnotation".
export const VOLUME_PANE_ID = "vx_volume_pane" as const;
export const MARKER_GROUP_ID = "vx_markers" as const;
export const DRAWING_GROUP_ID = "vx_drawings" as const;
export const RECTANGLE_OVERLAY = "vxRectangle" as const;
// Built-in KLineCharts 9.8.12 overlay names, plus the registered rectangle.
const DRAWING_OVERLAYS: Readonly<Record<DrawingTool, string>> = Object.freeze({
  fib: "fibonacciLine",
  level: "horizontalStraightLine",
  rectangle: RECTANGLE_OVERLAY,
  text: "simpleAnnotation",
  trend: "segment",
});
type Coordinate = Readonly<{ x: number; y: number }>;
export const rectangleFigures = (
  coordinates: readonly Coordinate[]
): Readonly<{
  type: "polygon";
  attrs: { coordinates: Coordinate[] };
  styles: { style: "stroke_fill" };
}>[] => {
  const [start, end] = coordinates;
  if (start === undefined || end === undefined) return [];
  return [
    {
      attrs: {
        coordinates: [
          start,
          { x: end.x, y: start.y },
          end,
          { x: start.x, y: end.y },
        ],
      },
      styles: { style: "stroke_fill" },
      type: "polygon",
    },
  ];
};
const toolForOverlay = (name: string): DrawingTool | undefined =>
  (Object.keys(DRAWING_OVERLAYS) as DrawingTool[]).find(
    (tool) => DRAWING_OVERLAYS[tool] === name
  );
type OverlayLike = Readonly<{
  id: string;
  name: string;
  points: readonly Readonly<{
    timestamp?: number;
    dataIndex?: number;
    value?: number;
  }>[];
  extendData: unknown;
}>;
const DAY_MS = 86_400_000;
/**
 * Bar time for a chart data index. Past the last bar (KLineCharts gives a dataIndex but
 * no timestamp there) it extends the last bar spacing; one bar uses one day.
 */
export const timestampAtIndex = (
  timestamps: readonly number[],
  index: number
): number | undefined => {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const known = timestamps[index];
  if (known !== undefined) return known;
  const last = timestamps.at(-1);
  if (last === undefined) return undefined;
  return last + (index - (timestamps.length - 1)) * barSpacing(timestamps);
};
const SPACING_BARS = 20;
/**
 * Typical bar spacing: the median gap of the last 20 bars (lower median), so one weekend or
 * holiday gap does not move points after the last bar. Fewer than two bars use one day.
 */
export const barSpacing = (timestamps: readonly number[]): number => {
  const gaps: number[] = [];
  let prior: number | null = null;
  for (const timestamp of timestamps.slice(-(SPACING_BARS + 1))) {
    if (prior !== null) gaps.push(timestamp - prior);
    prior = timestamp;
  }
  const middle = Math.floor((gaps.length - 1) / 2);
  return gaps
    .sort((left, right) => left - right)
    .slice(middle, middle + 1)
    .reduce((_, gap) => gap, DAY_MS);
};
/**
 * Overlay point for a stored drawing point. KLineCharts 9.8.12 snaps every timestamp to
 * the nearest bar, so a point after the last bar is passed as a data index without a time.
 */
export const overlayPoint = (
  point: DrawingPoint,
  timestamps: readonly number[]
): Readonly<{ timestamp?: number; dataIndex?: number; value: number }> => {
  const last = timestamps.at(-1);
  if (last === undefined || point.timestamp <= last) return { ...point };
  return {
    dataIndex:
      timestamps.length -
      1 +
      Math.round((point.timestamp - last) / barSpacing(timestamps)),
    value: point.value,
  };
};
export const drawingFromOverlay = (
  overlay: OverlayLike,
  timestamps: readonly number[] = []
): Drawing | undefined => {
  const tool = toolForOverlay(overlay.name);
  const drawing = {
    id: overlay.id,
    points: overlay.points.map((point) => ({
      timestamp:
        point.timestamp ??
        (point.dataIndex === undefined
          ? undefined
          : timestampAtIndex(timestamps, point.dataIndex)),
      value: point.value,
    })),
    text: typeof overlay.extendData === "string" ? overlay.extendData : "",
    tool,
  };
  return validDrawing(drawing) ? drawing : undefined;
};
const CANDLE_STYLE = Object.freeze({
  area: "Area",
  candles: "CandleSolid",
  "heikin-ashi": "CandleSolid",
  hollow: "CandleUpStroke",
  ohlc: "Ohlc",
} as const satisfies Record<ChartType, string>);
const CANDLE_PANE_ID = "candle_pane";
const MAX_STUDY_PERIODS = 4;
const MAX_CHART_MARKERS = 4096;

const validPeriods = (periods: readonly number[]): boolean => {
  return (
    periods.length <= MAX_STUDY_PERIODS &&
    periods.every(
      (period) => Number.isSafeInteger(period) && period >= 1 && period <= 500
    )
  );
};

const validChartMarkers = (markers: readonly ChartMarker[]): boolean => {
  return (
    markers.length <= MAX_CHART_MARKERS &&
    markers.every((marker) => {
      return (
        typeof marker.id === "string" &&
        marker.id.length > 0 &&
        marker.id.length <= 160 &&
        Number.isSafeInteger(marker.timestamp) &&
        Math.abs(marker.timestamp) <= 8_640_000_000_000_000 &&
        Number.isFinite(marker.value) &&
        marker.value >= 0 &&
        marker.value <= 1_000_000_000_000 &&
        typeof marker.text === "string" &&
        marker.text.length > 0 &&
        marker.text.length <= 40
      );
    })
  );
};

export const createKLineRenderer: CandleRendererFactory = async (
  element,
  options
) => {
  if (typeof window === "undefined" || typeof document === "undefined")
    throw new Error("KLineCharts requires a browser mount");
  if (options.signal.aborted) throw new Error("Chart mount was cancelled");
  const library = await import("klinecharts");
  if (options.signal.aborted) throw new Error("Chart mount was cancelled");
  if (library.version() !== KLINECHARTS_VERSION)
    throw new Error("Unexpected KLineCharts version");
  if (
    ![options.pricePrecision, options.volumePrecision].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 12
    )
  )
    throw new RangeError("Display precision must be bounded");
  // Idempotent: re-registering a name replaces the same template.
  library.registerOverlay({
    createPointFigures: ({ coordinates }) => rectangleFigures(coordinates),
    name: RECTANGLE_OVERLAY,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    totalStep: 3,
  });
  for (const id of VERTEX_STUDY_IDS)
    library.registerIndicator(
      indicatorTemplate(VERTEX_STUDIES[id], options.pricePrecision)
    );
  const palette = options.palette;
  const chart = library.init(element, {
    timezone: "UTC",
    locale: "en-US",
    styles: {
      grid: {
        horizontal: { color: palette.grid },
        vertical: { color: palette.grid },
      },
      candle: {
        type: library.CandleType.CandleUpStroke,
        bar: {
          upColor: palette.rising,
          downColor: palette.falling,
          noChangeColor: palette.foreground,
          upBorderColor: palette.rising,
          downBorderColor: palette.falling,
          noChangeBorderColor: palette.foreground,
          upWickColor: palette.rising,
          downWickColor: palette.falling,
          noChangeWickColor: palette.foreground,
        },
        priceMark: { show: false },
      },
      xAxis: { tickText: { color: palette.foreground } },
      yAxis: { tickText: { color: palette.foreground } },
    },
  });
  if (!chart) throw new Error("KLineCharts did not create a chart");
  let disposed = false;
  let previous: readonly DisplayCandle[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    library.dispose(chart);
    previous = [];
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  try {
    chart.setPriceVolumePrecision(
      options.pricePrecision,
      options.volumePrecision
    );
    const interaction = chart.getDom();
    if (interaction) {
      // 9.8.12 creates a positive tabindex and inline outline:none. Keep its
      // documented Shift+zoom/scroll keys while restoring normal focus order.
      interaction.tabIndex = 0;
      interaction.style.removeProperty("outline");
      interaction.setAttribute("role", "group");
      interaction.setAttribute(
        "aria-label",
        "Candlestick interaction. Shift plus Equal or Minus zooms. Shift plus Left or Right scrolls. Exact values are in the following table."
      );
    }
  } catch (error) {
    dispose();
    throw error;
  }
  // Current drawings, kept so points after the last bar can be placed again when bars change.
  let drawn: Readonly<{
    drawings: readonly Drawing[];
    onChange: (drawing: Drawing) => void;
  }> | null = null;
  // Places the drawings again when one of them has a point after `time`.
  const redrawAfter = (time: number) => {
    if (
      drawn?.drawings.some((drawing) =>
        drawing.points.some((point) => point.timestamp > time)
      )
    )
      setDrawings(drawn.drawings, drawn.onChange);
  };
  // Keeps the shown bars. Drawing points after the last bar are data indexes counted from
  // the first bar, so they are placed again when the bar count or the last bar changes.
  const remember = (values: readonly DisplayCandle[], newLast: number) => {
    const oldLast = previous.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY;
    const oldCount = previous.length;
    previous = values.map((bar) => Object.freeze({ ...bar }));
    if (newLast !== oldLast || values.length !== oldCount)
      redrawAfter(Math.min(oldLast, newLast));
  };
  const replace = (values: readonly DisplayCandle[]) => {
    if (disposed) return;
    if (!validDisplayCandles(values))
      throw new TypeError("Invalid display coordinates");
    const sameAt = (bar: DisplayCandle, index: number) => {
      const other = values[index];
      return other !== undefined && sameBar(bar, other);
    };
    if (previous.length === values.length && previous.every(sameAt)) return;
    const last = values.at(-1);
    if (last === undefined) {
      chart.clearData();
      previous = [];
      return;
    }
    const samePrefix =
      values.length === previous.length
        ? previous.slice(0, -1).every(sameAt)
        : values.length === previous.length + 1 && previous.every(sameAt);
    const previousLast = previous.at(-1);
    const tailCompatible =
      previousLast !== undefined &&
      (values.length === previous.length
        ? last.timestamp === previousLast.timestamp
        : last.timestamp > previousLast.timestamp);
    if (samePrefix && tailCompatible) {
      chart.updateData({
        timestamp: last.timestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
      });
    } else {
      chart.applyNewData(
        values.map((bar) => ({
          timestamp: bar.timestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        })),
        false
      );
    }
    remember(values, last.timestamp);
  };
  let volumeShown = false;
  let smaKey = "";
  let emaKey = "";
  const setAverage = (
    name: "MA" | "EMA",
    periods: readonly number[],
    current: string
  ): string => {
    const next = periods.join(",");
    if (next === current) return current;
    if (current !== "") chart.removeIndicator(CANDLE_PANE_ID, name);
    if (periods.length > 0)
      chart.createIndicator({ name, calcParams: [...periods] }, true, {
        id: CANDLE_PANE_ID,
      });
    return next;
  };
  const shownExtra = new Set<VertexStudyId>();
  const setExtra = (wanted: readonly VertexStudyId[]) => {
    for (const id of VERTEX_STUDY_IDS) {
      const study = VERTEX_STUDIES[id];
      const onCandles = study.placement === "candle";
      const paneId = onCandles ? CANDLE_PANE_ID : studyPaneId(id);
      if (wanted.includes(id) && !shownExtra.has(id)) {
        chart.createIndicator(
          { name: study.name, shortName: study.shortName },
          onCandles,
          onCandles ? { id: paneId } : { id: paneId, height: 96 }
        );
        shownExtra.add(id);
      } else if (!wanted.includes(id) && shownExtra.has(id)) {
        chart.removeIndicator(paneId, study.name);
        shownExtra.delete(id);
      }
    }
  };
  const setStudies = (studies: ChartStudies) => {
    const extra = studies.extra ?? [];
    if (!(validPeriods(studies.sma) && validPeriods(studies.ema)))
      throw new RangeError(
        "Study periods must be 1 to 500, at most four per study"
      );
    if (!extra.every(isVertexStudyId))
      throw new RangeError("Unknown Vertex study");
    if (disposed) return;
    if (studies.volume !== volumeShown) {
      if (studies.volume) {
        chart.createIndicator(
          { name: "VOL", shortName: "Volume", calcParams: [] },
          false,
          { id: VOLUME_PANE_ID, height: 96 }
        );
      } else chart.removeIndicator(VOLUME_PANE_ID, "VOL");
      volumeShown = studies.volume;
    }
    smaKey = setAverage("MA", studies.sma, smaKey);
    emaKey = setAverage("EMA", studies.ema, emaKey);
    setExtra(extra);
    return;
  };
  let markerKey = "[]";
  const setMarkers = (markers: readonly ChartMarker[]) => {
    if (!validChartMarkers(markers))
      throw new TypeError("Invalid chart markers");
    if (disposed) return;
    const next = JSON.stringify(
      markers.map((marker) => [marker.timestamp, marker.value, marker.text])
    );
    if (next === markerKey) return;
    chart.removeOverlay({ groupId: MARKER_GROUP_ID });
    if (markers.length > 0) {
      chart.createOverlay(
        markers.map((marker) => ({
          name: "simpleAnnotation",
          groupId: MARKER_GROUP_ID,
          lock: true,
          points: [{ timestamp: marker.timestamp, value: marker.value }],
          extendData: marker.text,
        }))
      );
    }
    markerKey = next;
    return;
  };
  const overlayEvents = (onChange: (drawing: Drawing) => void) => {
    const emit = (event: { overlay: OverlayLike }): boolean => {
      const drawing = drawingFromOverlay(
        event.overlay,
        previous.map((bar) => bar.timestamp)
      );
      if (drawing !== undefined) onChange(drawing);
      // A drawing that cannot be stored must not stay on the chart as if it were saved:
      // a saved one goes back to its stored place, a new one is removed.
      else if (drawn?.drawings.some((saved) => saved.id === event.overlay.id))
        setDrawings(drawn.drawings, drawn.onChange);
      else chart.removeOverlay({ id: event.overlay.id });
      return false;
    };
    return { onDrawEnd: emit, onPressedMoveEnd: emit };
  };
  const setDrawings = (
    drawings: readonly Drawing[],
    onChange: (drawing: Drawing) => void
  ) => {
    if (!drawings.every(validDrawing)) throw new TypeError("Invalid drawings");
    if (disposed) return;
    drawn = { drawings, onChange };
    chart.removeOverlay({ groupId: DRAWING_GROUP_ID });
    if (drawings.length === 0) return;
    const times = previous.map((bar) => bar.timestamp);
    chart.createOverlay(
      drawings.map((drawing) => ({
        extendData: drawing.text,
        groupId: DRAWING_GROUP_ID,
        id: drawing.id,
        name: DRAWING_OVERLAYS[drawing.tool],
        points: drawing.points.map((point) => overlayPoint(point, times)),
        ...overlayEvents(onChange),
      }))
    );
    return;
  };
  const startDrawing = (
    tool: DrawingTool,
    text: string,
    onChange: (drawing: Drawing) => void
  ) => {
    if (disposed) return;
    chart.createOverlay({
      extendData: text.slice(0, 80),
      groupId: DRAWING_GROUP_ID,
      name: DRAWING_OVERLAYS[tool],
      ...overlayEvents(onChange),
    });
    return;
  };
  const setChartType = (type: ChartType) => {
    if (disposed) return;
    chart.setStyles({
      candle: { type: library.CandleType[CANDLE_STYLE[type]] },
    });
    return;
  };
  const onCrosshair = (listener: (timestamp: number | null) => void) => {
    if (disposed) return;
    chart.subscribeAction(library.ActionType.OnCrosshairChange, (data) => {
      const crosshair = data as
        | { kLineData?: { timestamp?: number } }
        | undefined;
      return listener(crosshair?.kLineData?.timestamp ?? null);
    });
    return;
  };
  const snapshot = (): string =>
    disposed ? "" : chart.getConvertPictureUrl(true, "png", palette.background);
  return {
    setChartType,
    setDrawings,
    startDrawing,
    onCrosshair,
    snapshot,
    replace,
    resize: () => {
      if (!disposed) return chart.resize();
      return;
    },
    dispose,
    setStudies,
    setMarkers,
  };
};
