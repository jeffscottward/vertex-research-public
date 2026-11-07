"use client";

// What: daily bars for the watchlist analysis tabs. useWatchlistBars fetches one year of daily
// bars per symbol (marketData.bars, a few at a time) once `enabled` turns on, keeps each
// symbol's own loading/ready/failed state and retries one symbol; BarsStatusList shows them.
// Used by: watchlist-workspace.tsx (hook), watchlist-relationships.tsx and watchlist-exposure.tsx.

import type { MarketBarsInput } from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  describeMarketDataFailure,
  type MarketDataGateway,
} from "./market-data-client.ts";
import {
  type DailyClose,
  dailyCloses,
  runWithConcurrency,
} from "./watchlist-analytics.ts";

/** Bars requests in flight at once; the history service paces IBKR itself. */
const BARS_CONCURRENCY = 3;

export type SymbolBarsState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; closes: readonly DailyClose[] }>
  | Readonly<{ type: "error"; code: string; message: string }>;

export type WatchlistBars = Readonly<{
  states: ReadonlyMap<string, SymbolBarsState>;
  retry: (symbol: string) => void;
}>;

/** One year of regular-hours daily trade bars for a US stock (BF-B is sent as BF.B). */
const watchlistBarsInput = (symbol: string): MarketBarsInput => ({
  barSize: "1 day",
  currency: "USD",
  duration: "1 Y",
  exchange: "SMART",
  secType: "STK",
  symbol: symbol.replaceAll("-", "."),
  useRTH: true,
  whatToShow: "TRADES",
});

export const useWatchlistBars = (
  gateway: MarketDataGateway,
  symbols: readonly string[],
  enabled: boolean
): WatchlistBars => {
  const [states, setStates] = useState<ReadonlyMap<string, SymbolBarsState>>(
    () => new Map()
  );
  const requested = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchSymbols = useCallback(
    (list: readonly string[]) => {
      for (const symbol of list) requested.current.add(symbol);
      setStates((previous) => {
        const next = new Map(previous);
        for (const symbol of list) next.set(symbol, { type: "loading" });
        return next;
      });
      return runWithConcurrency(list, BARS_CONCURRENCY, async (symbol) => {
        let result: SymbolBarsState;
        try {
          const data = await gateway.bars(watchlistBarsInput(symbol));
          result = { closes: dailyCloses(data.bars), type: "ready" };
        } catch (error) {
          result = { ...describeMarketDataFailure(error), type: "error" };
        }
        if (mounted.current)
          setStates((previous) => new Map(previous).set(symbol, result));
      });
    },
    [gateway]
  );

  useEffect(() => {
    if (!enabled) return;
    const missing = symbols.filter((symbol) => !requested.current.has(symbol));
    if (missing.length > 0) void fetchSymbols(missing);
  }, [enabled, symbols, fetchSymbols]);

  const retry = useCallback(
    (symbol: string) => void fetchSymbols([symbol]),
    [fetchSymbols]
  );

  return { retry, states };
};

export interface BarsStatusListProps {
  readonly label: string;
  readonly symbols: readonly string[];
  readonly bars: WatchlistBars;
}

/** One line per symbol: loading, days of data, or the failure with a retry button. */
export const BarsStatusList = ({
  label,
  symbols,
  bars,
}: BarsStatusListProps) => (
  <ul aria-label={label} className="flex flex-wrap gap-2 text-xs">
    {symbols.map((symbol) => {
      const state = bars.states.get(symbol) ?? { type: "loading" };
      return (
        <li
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
          data-state={state.type}
          data-symbol={symbol}
          key={symbol}
        >
          <span className="font-medium font-mono">{symbol}</span>
          {state.type === "loading" ? (
            <span aria-busy="true" className="text-muted-foreground">
              Loading bars…
            </span>
          ) : state.type === "ready" ? (
            <span className="text-muted-foreground">
              {state.closes.length} days
            </span>
          ) : (
            <>
              <span className="text-destructive">
                Failed ({state.code}): {state.message}
              </span>
              <Button
                aria-label={`Retry ${symbol} bars`}
                onClick={() => bars.retry(symbol)}
                size="sm"
                type="button"
                variant="secondary"
              >
                <RotateCw aria-hidden="true" className="size-3" />
                Retry
              </Button>
            </>
          )}
        </li>
      );
    })}
  </ul>
);
