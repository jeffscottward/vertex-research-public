import { OptionsChainSymbolSchema } from "@darkfactory/api";

import {
  type ChartInterval,
  DEFAULT_CHART_INTERVAL,
  parseIntervalParam,
} from "../charts/chart-intervals.ts";

// URL state for /stock/<SYMBOL>?interval=&expiry=&tab=. Missing or invalid values fall back
// to the defaults (1D chart, nearest expiry, chart tab), so every link opens a useful page.

export const STOCK_TABS = ["chart", "options", "analytics"] as const;
export type StockTab = (typeof STOCK_TABS)[number];

export type StockQuery = Readonly<{
  interval: ChartInterval;
  // YYYY-MM-DD; null selects the nearest listed expiry.
  expiry: string | null;
  tab: StockTab;
}>;

const EXPIRY = /^\d{4}-\d{2}-\d{2}$/u;
// A real calendar day: Date.parse rolls 2026-02-31 over to March, so it must read back.
const realDay = (value: string): boolean => {
  const time = EXPIRY.test(value)
    ? Date.parse(`${value}T00:00:00Z`)
    : Number.NaN;
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

export const parseStockQuery = (search: string): StockQuery => {
  const params = new URLSearchParams(search);
  const expiry = params.get("expiry") ?? "";
  const tab = params.get("tab") ?? "";
  return {
    expiry: realDay(expiry) ? expiry : null,
    interval: parseIntervalParam(search),
    tab: (STOCK_TABS as readonly string[]).includes(tab)
      ? (tab as StockTab)
      : "chart",
  };
};

/** Query string for a state; defaults are left out ("" when everything is default). */
export const stockQueryString = (query: StockQuery): string => {
  const params = new URLSearchParams();
  if (query.interval !== DEFAULT_CHART_INTERVAL)
    params.set("interval", query.interval);
  if (query.expiry !== null) params.set("expiry", query.expiry);
  if (query.tab !== "chart") params.set("tab", query.tab);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** Upper-case ticker from a route segment, or null when it is not a ticker. */
export const normalizeStockSymbol = (segment: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const parsed = OptionsChainSymbolSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
};
