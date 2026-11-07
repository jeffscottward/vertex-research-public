import { ROTATION_PERIODS, type RotationPeriod } from "@darkfactory/api";

import { withQuery } from "./backtest-lab-query.ts";

export const DEFAULT_PERIOD: RotationPeriod = "1M";
// Defaults removed from the URL so the default view keeps a clean address.
export const URL_DEFAULTS = { period: DEFAULT_PERIOD } as const;

export type RotationMatrixSettings = Readonly<{ period: RotationPeriod }>;

export type ParamValue = string | readonly string[] | undefined;

/** Reads `?period=`; anything unknown falls back to the default (1M). */
export const parseRotationMatrixParams = (
  params: Readonly<Record<string, ParamValue>>
): RotationMatrixSettings => ({
  period:
    ROTATION_PERIODS.find((key) => key === params["period"]) ?? DEFAULT_PERIOD,
});

/** The query string for the settings, without the default ("" for 1M). */
export const rotationMatrixSearch = (
  settings: RotationMatrixSettings
): string => withQuery("", { period: settings.period }, URL_DEFAULTS);
