import {
  SMART_MONEY_SESSION_WINDOWS,
  SMART_MONEY_SORTS,
  type SmartMoneySessionWindow,
  type SmartMoneySort,
  TICKER_SYMBOL_PATTERN,
} from "@darkfactory/api";

export const SESSION_WINDOWS: readonly SmartMoneySessionWindow[] =
  SMART_MONEY_SESSION_WINDOWS;
export const SORTS: readonly SmartMoneySort[] = SMART_MONEY_SORTS;
export const DEFAULT_SESSIONS: SmartMoneySessionWindow = 1;
export const DEFAULT_SORT: SmartMoneySort = "net_bullish";
export const ALL_TICKERS = "";

export type SmartMoneySettings = Readonly<{
  sessions: SmartMoneySessionWindow;
  sort: SmartMoneySort;
  ticker: string;
}>;

export type ParamValue = string | readonly string[] | undefined;

/** Upper-cases and trims a ticker; returns "" when it does not match the symbol rule. */
export const normalizeSmartMoneyTicker = (value: string): string => {
  const ticker = value.trim().toUpperCase();
  return TICKER_SYMBOL_PATTERN.test(ticker) ? ticker : ALL_TICKERS;
};

/** Reads `?sessions=&sort=&ticker=`; anything unknown falls back to the default. */
export const parseSmartMoneyParams = (
  params: Readonly<Record<string, ParamValue>>
): SmartMoneySettings => {
  const { sessions, sort, ticker } = params;
  return {
    sessions:
      SESSION_WINDOWS.find((span) => String(span) === sessions) ??
      DEFAULT_SESSIONS,
    sort: SORTS.find((name) => name === sort) ?? DEFAULT_SORT,
    ticker:
      typeof ticker === "string"
        ? normalizeSmartMoneyTicker(ticker)
        : ALL_TICKERS,
  };
};

/** The query string for the settings, without the defaults ("" when all are default). */
export const smartMoneySearch = (settings: SmartMoneySettings): string => {
  const params = new URLSearchParams();
  if (settings.sessions !== DEFAULT_SESSIONS)
    params.set("sessions", String(settings.sessions));
  if (settings.sort !== DEFAULT_SORT) params.set("sort", settings.sort);
  if (settings.ticker !== ALL_TICKERS) params.set("ticker", settings.ticker);
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
};
