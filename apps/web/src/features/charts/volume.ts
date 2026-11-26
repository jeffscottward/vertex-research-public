import type { BuiltinPaneId } from "./chart-indicators.ts";
import type { ChartStudies, DisplayCandle } from "./types.ts";
import type { VertexStudyId } from "./vertex-studies.ts";

// Some instruments have no volume (forex, stocks in a non-USD currency): their
// bars carry no volume field. The chart then shows "no volume" instead of a
// flat zero row and keeps the studies that need volume off.

// Studies that read volume and draw nothing useful without it.
const VOLUME_STUDY_IDS: readonly VertexStudyId[] = Object.freeze([
  "rvol",
  "vwap",
]);
const VOLUME_PANE_IDS: readonly BuiltinPaneId[] = Object.freeze(["OBV"]);

export const NO_VOLUME_LABEL = "No volume";

// "all": every bar has a volume; "some": only some bars; "none": no bar has one.
// No bars count as "all" (nothing to warn about yet).
export type VolumeCoverage = "all" | "some" | "none";

export const VOLUME_NOTES: Readonly<
  Record<Exclude<VolumeCoverage, "all">, string>
> = Object.freeze({
  none: "No volume for this instrument: the volume pane, VWAP, RVOL and OBV are off, and AlphaTrend uses RSI instead of MFI.",
  some: "Some bars have no volume: VWAP and RVOL are off, and AlphaTrend uses RSI instead of MFI.",
});

// The volume property only when the bar has one (exactOptionalPropertyTypes).
export const volumeField = (volume: number | undefined): { volume?: number } =>
  volume === undefined ? {} : { volume };

// Sum of two volumes; missing when either bar has none.
export const addVolumes = (
  left: number | undefined,
  right: number | undefined
): number | undefined =>
  left === undefined || right === undefined ? undefined : left + right;

export const volumeCoverage = (
  candles: readonly DisplayCandle[]
): VolumeCoverage => {
  const withVolume = candles.filter((bar) => bar.volume !== undefined).length;
  if (withVolume === candles.length) return "all";
  return withVolume === 0 ? "none" : "some";
};

// The studies the chart can draw for this coverage. VWAP, RVOL (and AlphaTrend's
// MFI) need a volume on every bar; the volume pane and OBV need at least one.
export const studiesForVolume = (
  studies: ChartStudies,
  coverage: VolumeCoverage
): ChartStudies => {
  if (coverage === "all") return studies;
  const extra =
    studies.extra === undefined
      ? {}
      : {
          extra: studies.extra.filter((id) => !VOLUME_STUDY_IDS.includes(id)),
        };
  if (coverage === "some") return { ...studies, ...extra };
  return {
    ...studies,
    ...extra,
    ...(studies.panes === undefined
      ? {}
      : {
          panes: studies.panes.filter((id) => !VOLUME_PANE_IDS.includes(id)),
        }),
    volume: false,
  };
};
