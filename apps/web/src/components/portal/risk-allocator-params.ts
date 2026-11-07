import { RISK_ALLOCATOR_SYMBOL_PATTERN } from "@darkfactory/api";

export type RiskAllocatorSettings = Readonly<{ symbol: string | null }>;

export type ParamValue = string | readonly string[] | undefined;

/** Reads `?symbol=` (upper-cased); a missing or invalid symbol means "first watchlist symbol". */
export const parseRiskAllocatorParams = (
  params: Readonly<Record<string, ParamValue>>
): RiskAllocatorSettings => {
  const { symbol } = params;
  const text = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  return {
    symbol: RISK_ALLOCATOR_SYMBOL_PATTERN.test(text) ? text : null,
  };
};
