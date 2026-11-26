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
export const NO_VOLUME_NOTE =
  "No volume for this instrument: the volume pane, VWAP, RVOL and OBV are off, and AlphaTrend uses RSI instead of MFI.";

// The volume property only when the bar has one (exactOptionalPropertyTypes).
export const volumeField = (volume: number | undefined): { volume?: number } =>
  volume === undefined ? {} : { volume };

// Sum of two volumes; missing when either bar has none.
export const addVolumes = (
  left: number | undefined,
  right: number | undefined
): number | undefined =>
  left === undefined || right === undefined ? undefined : left + right;

// False only when there are bars and none of them has a volume.
export const hasVolume = (candles: readonly DisplayCandle[]): boolean =>
  candles.length === 0 || candles.some((bar) => bar.volume !== undefined);

// The same studies without the volume pane and the studies that need volume.
export const withoutVolumeStudies = (studies: ChartStudies): ChartStudies => ({
  ...studies,
  ...(studies.extra === undefined
    ? {}
    : {
        extra: studies.extra.filter((id) => !VOLUME_STUDY_IDS.includes(id)),
      }),
  ...(studies.panes === undefined
    ? {}
    : {
        panes: studies.panes.filter((id) => !VOLUME_PANE_IDS.includes(id)),
      }),
  volume: false,
});
