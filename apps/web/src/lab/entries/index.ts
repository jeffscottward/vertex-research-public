// What: Every UI lab entry, in portal sidebar order. Each page job adds or updates the entries for its pages.
// Used by: apps/web/src/lab/lab-views.tsx.
import { PORTAL_NAVIGATION } from "../../lib/navigation.ts";
import { defineLabEntries, type LabEntry } from "../registry.ts";
import { AUTOMATION_LAB_ENTRIES } from "./automation.tsx";
import { BACKTEST_LAB_LAB_ENTRIES } from "./backtest-lab.tsx";
import { CHARTS_LAB_ENTRIES } from "./charts.tsx";
import { DATA_SETTINGS_LAB_ENTRIES } from "./data-settings.tsx";
import { LENSES_LAB_ENTRIES } from "./lenses.tsx";
import { OVERVIEW_LAB_ENTRIES } from "./overview.tsx";
import { RESEARCH_LAB_ENTRIES } from "./research.tsx";
import { STRATEGIES_LAB_ENTRIES } from "./strategies.tsx";

const ROUTE_ORDER: readonly string[] = PORTAL_NAVIGATION.map(
  (item) => item.href
);

/** Sidebar routes first in sidebar order; other entries keep their listed order after them. */
export const orderLabEntries = (
  entries: readonly LabEntry[]
): readonly LabEntry[] => {
  const rank = (entry: LabEntry): number => {
    const index =
      entry.route === undefined ? -1 : ROUTE_ORDER.indexOf(entry.route);
    return index === -1 ? ROUTE_ORDER.length : index;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        rank(left.entry) - rank(right.entry) || left.index - right.index
    )
    .map(({ entry }) => entry);
};

export const LAB_ENTRIES: readonly LabEntry[] = defineLabEntries(
  orderLabEntries([
    ...OVERVIEW_LAB_ENTRIES,
    ...RESEARCH_LAB_ENTRIES,
    ...CHARTS_LAB_ENTRIES,
    ...LENSES_LAB_ENTRIES,
    ...STRATEGIES_LAB_ENTRIES,
    ...BACKTEST_LAB_LAB_ENTRIES,
    ...AUTOMATION_LAB_ENTRIES,
    ...DATA_SETTINGS_LAB_ENTRIES,
  ])
);
