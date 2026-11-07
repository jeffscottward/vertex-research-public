// What: Mission control widget layout (order and hidden set, saved in this browser) and the
// small data picks the compact widgets show.
// Used by: dashboard-widgets.tsx.
import type {
  MacroEvent,
  MarketContextOutput,
  NewsHeadline,
} from "@darkfactory/api";

export const DASHBOARD_WIDGET_IDS = [
  "watchlist",
  "events",
  "journal",
  "market",
] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

export const DASHBOARD_WIDGETS: Readonly<
  Record<DashboardWidgetId, Readonly<{ title: string; operatorOnly: boolean }>>
> = Object.freeze({
  events: { operatorOnly: true, title: "Next economic events" },
  journal: { operatorOnly: true, title: "Journal summary" },
  market: { operatorOnly: true, title: "Market context" },
  watchlist: { operatorOnly: false, title: "Watchlist" },
});

/** Browser-only preference; never account data. */
export const WIDGETS_STORAGE_KEY = "vertex.dashboard.widgets.v1";

export type WidgetLayout = Readonly<{
  order: readonly DashboardWidgetId[];
  hidden: readonly DashboardWidgetId[];
}>;

/** Every widget shown, in the declared order. */
export const DEFAULT_WIDGET_LAYOUT: WidgetLayout = Object.freeze({
  hidden: [],
  order: DASHBOARD_WIDGET_IDS,
});

const isWidgetId = (value: unknown): value is DashboardWidgetId =>
  (DASHBOARD_WIDGET_IDS as readonly unknown[]).includes(value);

const knownIds = (value: unknown): DashboardWidgetId[] =>
  Array.isArray(value) ? [...new Set(value.filter(isWidgetId))] : [];

/**
 * Any stored value becomes a full layout: unknown ids and duplicates drop out, and widgets
 * missing from the saved order (added after it was saved) join the end, shown.
 */
export const normalizeWidgetLayout = (value: unknown): WidgetLayout => {
  if (typeof value !== "object" || value === null) return DEFAULT_WIDGET_LAYOUT;
  const saved = knownIds(Reflect.get(value, "order"));
  return {
    hidden: knownIds(Reflect.get(value, "hidden")),
    order: [
      ...saved,
      ...DASHBOARD_WIDGET_IDS.filter((id) => !saved.includes(id)),
    ],
  };
};

/** Swaps the widget with its neighbour among `among`; a move past either end changes nothing. */
export const moveWidget = (
  layout: WidgetLayout,
  id: DashboardWidgetId,
  offset: -1 | 1,
  among: readonly DashboardWidgetId[] = layout.order
): WidgetLayout => {
  const listed = layout.order.filter((entry) => among.includes(entry));
  const from = listed.indexOf(id);
  const neighbour = listed[from + offset];
  if (from === -1 || neighbour === undefined) return layout;
  const order = layout.order.map((entry) => {
    if (entry === id) return neighbour;
    if (entry === neighbour) return id;
    return entry;
  });
  return { ...layout, order };
};

export const toggleWidget = (
  layout: WidgetLayout,
  id: DashboardWidgetId
): WidgetLayout => ({
  ...layout,
  hidden: layout.hidden.includes(id)
    ? layout.hidden.filter((entry) => entry !== id)
    : [...layout.hidden, id],
});

/** Local calendar date as YYYY-MM-DD. */
export const localIsoDate = (now: Date): string =>
  [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

/** Events on or after `today`, soonest first (untimed events of a day first). */
export const upcomingEvents = (
  events: readonly MacroEvent[],
  today: string,
  limit = 3
): MacroEvent[] =>
  events
    .filter((event) => event.date >= today)
    .sort((left, right) =>
      `${left.date} ${left.time ?? ""}`.localeCompare(
        `${right.date} ${right.time ?? ""}`
      )
    )
    .slice(0, limit);

export type MarketHeadline =
  | Readonly<{ type: "news"; headline: NewsHeadline }>
  | Readonly<{ type: "gex"; label: string }>;

/** Newest macro news headline; the GEX label when there is no news; else null. */
export const marketHeadline = (
  context: MarketContextOutput
): MarketHeadline | null => {
  const newest = [...(context.news?.headlines ?? [])].sort((left, right) =>
    right.publishedAt.localeCompare(left.publishedAt)
  )[0];
  if (newest !== undefined) return { headline: newest, type: "news" };
  const label = context.gex?.label ?? null;
  return label === null ? null : { label, type: "gex" };
};
