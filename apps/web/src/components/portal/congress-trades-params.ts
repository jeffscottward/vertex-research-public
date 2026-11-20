import type { CongressTradeWindow } from "@darkfactory/api";

export const WINDOWS: readonly CongressTradeWindow[] = [7, 30, 90];
export const DEFAULT_DAYS: CongressTradeWindow = 30;
export const CHAMBERS = ["house", "senate"] as const;
export type CongressChamberFilter = (typeof CHAMBERS)[number] | "";
export const ALL_CHAMBERS: CongressChamberFilter = "";
export const ALL_MEMBERS = "";
export const ALL_TICKERS = "";
// The contract allows member names up to 200 characters.
const MAX_MEMBER_LENGTH = 200;
// The openbb SYMBOL rule: 1 to 16 of A-Z, 0-9, ".", "^", "=", "-".
const TICKER_PATTERN = /^[A-Z0-9.^=-]{1,16}$/u;

export type CongressTradesSettings = Readonly<{
  chamber: CongressChamberFilter;
  days: CongressTradeWindow;
  member: string;
  ticker: string;
}>;

export type ParamValue = string | readonly string[] | undefined;

/** Upper-cases and trims a ticker; returns "" when it does not match the SYMBOL rule. */
export const normalizeTicker = (value: string): string => {
  const ticker = value.trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : ALL_TICKERS;
};

/** Trims a member name; returns "" when it is empty or longer than 200 characters. */
export const normalizeMember = (value: string): string => {
  const member = value.trim();
  return member.length <= MAX_MEMBER_LENGTH ? member : ALL_MEMBERS;
};

/** Reads `?days=&chamber=&ticker=&member=`; anything unknown falls back to the default. */
export const parseCongressTradesParams = (
  params: Readonly<Record<string, ParamValue>>
): CongressTradesSettings => {
  const { chamber, days, member, ticker } = params;
  return {
    chamber: CHAMBERS.find((name) => name === chamber) ?? ALL_CHAMBERS,
    days: WINDOWS.find((span) => String(span) === days) ?? DEFAULT_DAYS,
    member: typeof member === "string" ? normalizeMember(member) : ALL_MEMBERS,
    ticker: typeof ticker === "string" ? normalizeTicker(ticker) : ALL_TICKERS,
  };
};

/** The query string for the settings, without the defaults ("" when all are default). */
export const congressTradesSearch = (
  settings: CongressTradesSettings
): string => {
  const params = new URLSearchParams();
  if (settings.days !== DEFAULT_DAYS) params.set("days", String(settings.days));
  if (settings.chamber !== ALL_CHAMBERS)
    params.set("chamber", settings.chamber);
  if (settings.ticker !== ALL_TICKERS) params.set("ticker", settings.ticker);
  if (settings.member !== ALL_MEMBERS) params.set("member", settings.member);
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
};
