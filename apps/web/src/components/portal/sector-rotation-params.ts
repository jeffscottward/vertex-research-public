import {
  SECTOR_ROTATION_TIMEFRAMES,
  type SectorRotationTimeframe,
} from "@darkfactory/api";

import { withQuery } from "./backtest-lab-query.ts";

export const SECTORS_PRESET_ID = "sectors";

export const TAIL_LENGTHS = [5, 10, 20] as const;
const DEFAULT_TIMEFRAME: SectorRotationTimeframe = "weekly";
const DEFAULT_TAIL_LENGTH = 10;
/** Time between two dates while the map plays. */
export const PLAY_STEP_MS = 400;
export const CUSTOM_ID = "custom";
// Preset ids: "sectors", "watchlist" and "basket:<id>".
const UNIVERSE_ID = /^[\w:-]{1,64}$/u;

export type SectorRotationSettings = Readonly<{
  tailLength: number;
  timeframe: SectorRotationTimeframe;
  universeId: string;
}>;

export type ParamValue = string | readonly string[] | undefined;

/** Reads `?timeframe=&universe=&tail=`; anything unknown falls back to the default. */
export const parseSectorRotationParams = (
  params: Readonly<Record<string, ParamValue>>
): SectorRotationSettings => {
  const { tail, timeframe, universe } = params;
  const tailLength = TAIL_LENGTHS.find((length) => String(length) === tail);
  return {
    tailLength: tailLength ?? DEFAULT_TAIL_LENGTH,
    timeframe:
      SECTOR_ROTATION_TIMEFRAMES.find((key) => key === timeframe) ??
      DEFAULT_TIMEFRAME,
    universeId:
      typeof universe === "string" && UNIVERSE_ID.test(universe)
        ? universe
        : SECTORS_PRESET_ID,
  };
};

// Defaults removed from the URL so the default view keeps a clean address.
export const URL_DEFAULTS = {
  tail: DEFAULT_TAIL_LENGTH,
  timeframe: DEFAULT_TIMEFRAME,
  universe: SECTORS_PRESET_ID,
} as const;

/** The URL parameters this page owns; anything else in the address bar is left alone. */
export const sectorRotationQuery = (settings: SectorRotationSettings) => ({
  tail: settings.tailLength,
  timeframe: settings.timeframe,
  universe: settings.universeId,
});

/** The query string for the settings, without the defaults ("" when all are default). */
export const sectorRotationSearch = (
  settings: SectorRotationSettings
): string => withQuery("", sectorRotationQuery(settings), URL_DEFAULTS);
