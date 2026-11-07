import { DEEP_VALUE_TICKER_PATTERN } from "@darkfactory/api";

export const DEEP_VALUE_ROLE_FILTERS = [
  "all",
  "ours",
  "wish list",
  "re-entry",
  "rotation leader",
  "low-price universe",
] as const;

export const MAX_TOTAL = 16;

export const MAX_FILTER_TEXT = 100;

export type DeepValueFilter = Readonly<{
  role: string;
  text: string;
  hideFlagged: boolean;
  minTotal: number;
}>;

/** Screen settings plus the on-demand ticker; all of them live in the URL. */
export type DeepValueSettings = DeepValueFilter &
  Readonly<{ symbol: string | null }>;

export const DEFAULT_SETTINGS: DeepValueSettings = {
  hideFlagged: false,
  minTotal: 0,
  role: "all",
  symbol: null,
  text: "",
};

export type ParamValue = string | readonly string[] | undefined;

/** Upper-cased ticker for the on-demand score, or null when blank or not a ticker. */
export const normalizeSymbol = (value: string): string | null => {
  const symbol = value.trim().toUpperCase();
  return DEEP_VALUE_TICKER_PATTERN.test(symbol) ? symbol : null;
};

/** Whole-number min score inside 0..MAX_TOTAL; anything not a number becomes 0. */
export const clampMinTotal = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(MAX_TOTAL, Math.max(0, Math.trunc(value)))
    : 0;

/**
 * Reads `?symbol=&show=&min=&hide=1&q=`; anything unknown falls back to the default (no ticker, all
 * names, min score 0, flagged rows shown, no text filter).
 */
export const parseDeepValueParams = (
  params: Readonly<Record<string, ParamValue>>
): DeepValueSettings => {
  const { hide, min, q, show, symbol } = params;
  const minTotal = typeof min === "string" ? Number(min) : Number.NaN;
  return {
    hideFlagged: hide === "1",
    minTotal: clampMinTotal(minTotal),
    role:
      DEEP_VALUE_ROLE_FILTERS.find((entry) => entry === show) ??
      DEFAULT_SETTINGS.role,
    symbol: typeof symbol === "string" ? normalizeSymbol(symbol) : null,
    text:
      typeof q === "string" && q.length <= MAX_FILTER_TEXT
        ? q
        : DEFAULT_SETTINGS.text,
  };
};

/** The query string for the settings, without the defaults ("" when all are default). */
export const deepValueSearch = (settings: DeepValueSettings): string => {
  const params = new URLSearchParams();
  if (settings.symbol !== null) params.set("symbol", settings.symbol);
  if (settings.role !== DEFAULT_SETTINGS.role)
    params.set("show", settings.role);
  if (settings.minTotal !== DEFAULT_SETTINGS.minTotal)
    params.set("min", String(settings.minTotal));
  if (settings.hideFlagged) params.set("hide", "1");
  if (settings.text.trim() !== "") params.set("q", settings.text);
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
};
