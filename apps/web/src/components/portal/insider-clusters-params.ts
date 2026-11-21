import { OPENBB_INSIDER_CLUSTER_DAYS } from "@darkfactory/api";

export type InsiderClusterWindow = (typeof OPENBB_INSIDER_CLUSTER_DAYS)[number];
export const WINDOWS: readonly InsiderClusterWindow[] =
  OPENBB_INSIDER_CLUSTER_DAYS;
export const DEFAULT_DAYS: InsiderClusterWindow = 7;

export type InsiderClustersSettings = Readonly<{ days: InsiderClusterWindow }>;

export type ParamValue = string | readonly string[] | undefined;

/** Reads `?days=`; anything other than 7, 14 or 30 falls back to 7. */
export const parseInsiderClustersParams = (
  params: Readonly<Record<string, ParamValue>>
): InsiderClustersSettings => ({
  days: WINDOWS.find((span) => String(span) === params["days"]) ?? DEFAULT_DAYS,
});
