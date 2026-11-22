"use client";

import type { OpenbbMacroOutput } from "@darkfactory/api";
import { useEffect, useRef, useState } from "react";

import {
  FUTURES_OI_SERIES,
  type FuturesOiMarket,
} from "../../features/charts/futures-oi.ts";
import type { OpenbbGateway } from "../../features/openbb/gateway.ts";

export type FuturesOiSeries = OpenbbMacroOutput["series"][number];

export type FuturesOiState =
  // No match, not daily, or checkbox off.
  | Readonly<{ type: "off" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error" }>
  // A null series: no figures are stored.
  | Readonly<{ type: "ready"; series: FuturesOiSeries | null }>;

type Settled = Readonly<{
  key: string;
  state: Extract<FuturesOiState, { type: "error" | "ready" }>;
}>;

const OFF: FuturesOiState = Object.freeze({ type: "off" });
const LOADING: FuturesOiState = Object.freeze({ type: "loading" });

/**
 * Reads the stored open-interest series of one future. A read that returns a series is kept for
 * its market and from-date. A read that fails or returns no series is not kept: the next time the
 * hook is enabled with that input (the checkbox goes off and on, or the input changes and comes
 * back) it reads again. The read starts after the bars of the page are loaded, so it has its own
 * generation counter: it must not cancel the bars load and the bars load must not cancel it.
 */
export const useFuturesOi = ({
  gateway,
  market,
  enabled,
  from,
}: Readonly<{
  gateway: Pick<OpenbbGateway, "macro">;
  market: FuturesOiMarket | null;
  // Daily view and checkbox on.
  enabled: boolean;
  from: string | null;
}>): FuturesOiState => {
  const [settled, setSettled] = useState<Settled | null>(null);
  const generation = useRef(0);
  // The newest read that is in flight or returned a series. The same market and from-date start
  // no second read, so the checkbox can go off and on without a request.
  const requested = useRef<string | null>(null);
  const active = enabled && market !== null && from !== null;
  const key = `${market}|${from}`;

  useEffect(() => {
    if (!enabled || market === null || from === null) return;
    const mine = `${market}|${from}`;
    if (requested.current === mine) return;
    requested.current = mine;
    generation.current += 1;
    const started = generation.current;
    const id = FUTURES_OI_SERIES[market];
    // An earlier failed or empty result of the same input must not show during the new read.
    setSettled((current) => (current?.key === mine ? null : current));
    const settle = (state: Settled["state"]) => {
      if (started !== generation.current) return;
      // Nothing usable was loaded: the next occasion reads again.
      if (state.type === "error" || state.series === null)
        requested.current = null;
      setSettled({ key: mine, state });
    };
    gateway.macro(from, [id]).then(
      (output) =>
        settle({
          series: output.series.find((series) => series.id === id) ?? null,
          type: "ready",
        }),
      () => settle({ type: "error" })
    );
  }, [enabled, from, gateway, market]);

  if (!active) return OFF;
  return settled?.key === key ? settled.state : LOADING;
};
