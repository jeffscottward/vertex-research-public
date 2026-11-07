import type { CongressTradeWindow } from "@darkfactory/api";

export const WINDOWS: readonly CongressTradeWindow[] = [7, 30, 90];
export const DEFAULT_DAYS: CongressTradeWindow = 30;
export const ALL_MEMBERS = "";
// The contract allows member names up to 200 characters.
const MAX_MEMBER_LENGTH = 200;

export type CongressTradesSettings = Readonly<{
  days: CongressTradeWindow;
  member: string;
}>;

export type ParamValue = string | readonly string[] | undefined;

/** Reads `?days=&member=`; anything unknown falls back to the default (30 days, all members). */
export const parseCongressTradesParams = (
  params: Readonly<Record<string, ParamValue>>
): CongressTradesSettings => {
  const { days, member } = params;
  return {
    days: WINDOWS.find((span) => String(span) === days) ?? DEFAULT_DAYS,
    member:
      typeof member === "string" && member.length <= MAX_MEMBER_LENGTH
        ? member
        : ALL_MEMBERS,
  };
};

/** The query string for the settings, without the defaults ("" when both are default). */
export const congressTradesSearch = (
  settings: CongressTradesSettings
): string => {
  const params = new URLSearchParams();
  if (settings.days !== DEFAULT_DAYS) params.set("days", String(settings.days));
  if (settings.member !== ALL_MEMBERS) params.set("member", settings.member);
  const search = params.toString();
  return search === "" ? "" : `?${search}`;
};
