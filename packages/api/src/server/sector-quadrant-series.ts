import type { SectorRotationRepository } from "@darkfactory/db/server";

import type { StrategyDefinition } from "../strategy-dsl.ts";
import {
  SectorQuadrantDataError,
  type SectorQuadrantPoint,
  type SectorQuadrantSeries,
  sectorQuadrantKey,
} from "../strategy-dsl-compile.ts";

// Loads the stored sector rotation points that the sector filters of a definition need. Points
// start a little before the first bar, so the first bars can use the last earlier point.

export type SectorQuadrantSource = Pick<SectorRotationRepository, "listPoints">;

/** Days of points loaded before the first bar date (longer than one weekly period). */
const LEAD_DAYS = 31;
const DAY_MS = 86_400_000;

/**
 * Series for every filter of the definition (or campaign config), or undefined when it has none. A missing repository
 * or no stored points throws SectorQuadrantDataError, so a filter never passes silently.
 */
export const loadSectorQuadrants = async (
  source: SectorQuadrantSource | undefined,
  definition: Pick<StrategyDefinition, "filters">,
  firstBarTime: number
): Promise<SectorQuadrantSeries | undefined> => {
  const filters = definition.filters;
  if (filters === undefined) return undefined;
  const fromDate = new Date(firstBarTime - LEAD_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const series: Record<string, readonly SectorQuadrantPoint[]> = {};
  for (const filter of filters) {
    if (source === undefined)
      throw new SectorQuadrantDataError(filter.sector, filter.timeframe);
    const points = await source.listPoints({
      fromDate,
      symbols: [filter.sector],
      timeframe: filter.timeframe,
    });
    if (points.length === 0)
      throw new SectorQuadrantDataError(filter.sector, filter.timeframe);
    series[sectorQuadrantKey(filter)] = points.map((point) => ({
      date: point.date,
      quadrant: point.quadrant,
    }));
  }
  return series;
};
