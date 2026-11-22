import { and, asc, eq, gte, lte } from "drizzle-orm";

import { breadth90Days } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Daily series that strategy definitions read like a stored market daily series but that live in
// another table of this package, read in place so no copy can drift from its source.
// - NYSE_UPVOL_PCT: NYSE up-volume as a percent of up plus down volume (breadth90_days.up_pct),
//   final sessions only. A heavy down-volume day (kind DOWN_80 or DOWN_90) has a value of 20 or
//   less.

/** One value per date, in date order. */
export type VirtualDailyPoint = Readonly<{ date: string; close: number }>;

/** Inclusive ISO date bounds (`YYYY-MM-DD`), already validated by the caller. */
type Range = Readonly<{ from?: string; to?: string }>;

type Loader = (
  database: DatabaseExecutor,
  range: Range
) => Promise<VirtualDailyPoint[]>;

const loadUpVolumePct: Loader = async (database, range) =>
  await database
    .select({ close: breadth90Days.upPct, date: breadth90Days.date })
    .from(breadth90Days)
    .where(
      and(
        eq(breadth90Days.final, true),
        range.from === undefined
          ? undefined
          : gte(breadth90Days.date, range.from),
        range.to === undefined ? undefined : lte(breadth90Days.date, range.to)
      )
    )
    .orderBy(asc(breadth90Days.date));

const LOADERS: ReadonlyMap<string, Loader> = new Map([
  ["NYSE_UPVOL_PCT", loadUpVolumePct],
]);

/** True for an id served from another table rather than market_daily_points. */
export const isVirtualDailySeries = (id: string): boolean => LOADERS.has(id);

/** The points of a virtual series in the range; empty for an id that is not virtual. */
export const loadVirtualDailySeries = async (
  database: DatabaseExecutor,
  id: string,
  range: Range
): Promise<VirtualDailyPoint[]> => {
  const loader = LOADERS.get(id);
  return loader === undefined ? [] : await loader(database, range);
};
