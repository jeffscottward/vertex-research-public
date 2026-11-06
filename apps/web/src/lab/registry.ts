// What: UI lab registry. One entry per portal page: the real workspace rendered with dummy data.
// Used by: apps/web/src/lab/entries/index.ts, apps/web/src/lab/lab-views.tsx, apps/web/src/app/lab/**.
// See: ~/Documents/reports/web/firstmate/vertex-ui-program.md ("Lab (component browser)").
import type { ReactNode } from "react";

export interface LabEntry {
  /** Index heading; one of LAB_GROUP_ORDER. */
  readonly group: string;
  /** URL segment: /lab/<id>. Lowercase words joined by "-". */
  readonly id: string;
  /** Renders the page body. Query params drive props (?symbol=NVDA&interval=1D). */
  readonly render: (params: URLSearchParams) => ReactNode;
  /** The real portal route this entry stands for, e.g. "/charts". */
  readonly route?: string;
  readonly title: string;
}

export type LabGroup = Readonly<{
  group: string;
  entries: readonly LabEntry[];
}>;

/** Index order: the sidebar groups, then linked pages and settings. */
const LAB_GROUP_ORDER: readonly string[] = Object.freeze([
  "Overview",
  "Portfolio",
  "Markets & Research",
  "Strategies & Backtests",
  "Agents & Automation",
  "Data & Ops",
  "Linked pages",
  "Settings",
]);

const LAB_ENTRY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export class LabRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabRegistryError";
  }
}

/** Checks ids, groups and routes once, so a bad entry fails the unit test instead of the page. */
export const defineLabEntries = (
  entries: readonly LabEntry[]
): readonly LabEntry[] => {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const entry of entries) {
    if (!LAB_ENTRY_ID.test(entry.id))
      throw new LabRegistryError(`Invalid lab entry id: ${entry.id}`);
    if (ids.has(entry.id))
      throw new LabRegistryError(`Duplicate lab entry id: ${entry.id}`);
    if (!LAB_GROUP_ORDER.includes(entry.group))
      throw new LabRegistryError(
        `Unknown lab group for ${entry.id}: ${entry.group}`
      );
    if (entry.route !== undefined) {
      if (routes.has(entry.route))
        throw new LabRegistryError(`Duplicate lab route: ${entry.route}`);
      routes.add(entry.route);
    }
    ids.add(entry.id);
  }
  return Object.freeze([...entries]);
};

export const findLabEntry = (
  entries: readonly LabEntry[],
  id: string
): LabEntry | undefined => entries.find((entry) => entry.id === id);

export const findLabEntryForRoute = (
  entries: readonly LabEntry[],
  route: string
): LabEntry | undefined => entries.find((entry) => entry.route === route);

/** Entries by group in LAB_GROUP_ORDER; empty groups are left out; entry order is kept. */
export const groupLabEntries = (
  entries: readonly LabEntry[]
): readonly LabGroup[] =>
  LAB_GROUP_ORDER.map((group) => ({
    entries: entries.filter((entry) => entry.group === group),
    group,
  })).filter((group) => group.entries.length > 0);

/** /lab/<id>, with optional query params (empty values are left out). */
export const labEntryHref = (
  id: string,
  params: Readonly<Record<string, string | undefined>> = {}
): string => {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined && value !== "") query.set(name, value);
  const search = query.toString();
  return `/lab/${encodeURIComponent(id)}${search === "" ? "" : `?${search}`}`;
};
