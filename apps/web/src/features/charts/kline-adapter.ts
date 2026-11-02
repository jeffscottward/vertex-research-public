import type {
  CandleRendererFactory,
  ChartMarker,
  ChartStudies,
  DisplayCandle,
} from "./types.ts";
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
// This adapter is independent source, not copied from Charan's chart component.
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
    previous = values.map((bar) => Object.freeze({ ...bar }));
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
  return {
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
