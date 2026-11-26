"use client";

// What: React hook that supplies horizontal dealer gamma levels (flip, call wall, put wall,
// max pain, king node) for /charts price charts.
// - US equities (STK / USD): consumes the already-loaded `OptionsAnalyticsPanel` snapshot so no
//   duplicate QuantData request is sent.
// - ES / NQ continuous futures (CONTFUT only): fetches `flow.snapshot` for stored `flow_gex`
//   basis-shifted levels only when the toggle is enabled, with generation-scoped cancellation.
//   The stored basis is the continuous front contract minus the index, so a dated contract
//   (FUT), which trades at a calendar spread to it, gets no levels.
// Display only: research context, never an order or risk input.
// Used by: components/portal/charts-workspace.tsx.

import {
  FLOW_INSTRUMENTS,
  type FlowSymbol,
  type MarketSecType,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  gammaLevelsFromFlowGex,
  gammaLevelsFromOptionsAnalytics,
} from "../../features/charts/gamma-levels-overlay.ts";
import type { GammaLevelsOverlay } from "../../features/charts/types.ts";
import {
  type FlowSnapshotGateway,
  isFlowInstrument,
} from "./flow-events-client.ts";
import type { GammaLevelsLoadState } from "./gamma-levels-bar.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";

export type OptionsAnalyticsReport =
  | Readonly<{ symbol: string; type: "loading" }>
  | Readonly<{ symbol: string; type: "error"; message: string }>
  | Readonly<{ symbol: string; type: "ready"; data: OptionsAnalyticsOutput }>;

export type GammaLevelsEligibility =
  | Readonly<{ kind: "optionsAnalytics"; symbol: string }>
  | Readonly<{ kind: "flowGex"; symbol: FlowSymbol }>
  | null;

export const resolveGammaLevelsEligibility = (
  secType: MarketSecType | null,
  currency: string | null,
  symbol: string | null
): GammaLevelsEligibility => {
  if (secType === null || symbol === null) return null;
  const trimmed = symbol.trim().toUpperCase();
  if (trimmed === "") return null;
  if (secType === "STK" && currency === "USD")
    return { kind: "optionsAnalytics", symbol: trimmed };
  // `flow_gex.basis` is measured on the continuous front contract (flow-collect `gexBasis`).
  if (
    secType === "CONTFUT" &&
    isFlowInstrument(trimmed, secType) &&
    FLOW_INSTRUMENTS[trimmed].kind === "future"
  )
    return { kind: "flowGex", symbol: trimmed };
  return null;
};

export type GammaLevelsView = Readonly<{
  eligible: boolean;
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  state: GammaLevelsLoadState;
  overlay: GammaLevelsOverlay | null;
  onRetry: (() => void) | undefined;
}>;

const IDLE_STATE: GammaLevelsLoadState = Object.freeze({ type: "idle" });

const stateFromAnalytics = (
  report: OptionsAnalyticsReport | null,
  symbol: string
): GammaLevelsLoadState => {
  if (report === null || report.symbol.trim().toUpperCase() !== symbol)
    return { type: "loading" };
  if (report.type === "loading") return { type: "loading" };
  if (report.type === "error")
    return { message: report.message, type: "error" };
  const overlay = gammaLevelsFromOptionsAnalytics(report.data);
  if (overlay === null)
    return {
      reason: report.data.rateLimited
        ? "QuantData rate limit reached; levels return with the next snapshot."
        : "no GEX or max-pain levels computed for this snapshot.",
      type: "empty",
    };
  return { overlay, type: "ready" };
};

export const useGammaLevelsView = ({
  secType,
  currency,
  symbol,
  replayActive,
  analyticsReport,
  flowSnapshot,
}: Readonly<{
  secType: MarketSecType | null;
  currency: string | null;
  symbol: string | null;
  replayActive: boolean;
  analyticsReport: OptionsAnalyticsReport | null;
  flowSnapshot: FlowSnapshotGateway;
}>): GammaLevelsView => {
  const eligibility = resolveGammaLevelsEligibility(secType, currency, symbol);
  const [enabled, setEnabled] = useState(true);
  const [flowState, setFlowState] = useState<
    Readonly<{ symbol: string; state: GammaLevelsLoadState }>
  >({ state: IDLE_STATE, symbol: "" });
  const [retryToken, setRetryToken] = useState(0);
  const generation = useRef(0);

  const flowSymbol =
    eligibility?.kind === "flowGex" ? eligibility.symbol : null;
  const analyticsSymbol =
    eligibility?.kind === "optionsAnalytics" ? eligibility.symbol : null;
  // Memoized so the chart gets the same overlay object until the panel reports again.
  const analyticsState = useMemo(
    () =>
      analyticsSymbol === null
        ? IDLE_STATE
        : stateFromAnalytics(analyticsReport, analyticsSymbol),
    [analyticsReport, analyticsSymbol]
  );

  useEffect(() => {
    const mine = ++generation.current;
    if (!enabled || flowSymbol === null) {
      setFlowState({ state: IDLE_STATE, symbol: "" });
      return () => {
        generation.current += 1;
      };
    }
    setFlowState({ state: { type: "loading" }, symbol: flowSymbol });
    flowSnapshot.snapshot({ minutes: 120, symbol: flowSymbol }).then(
      (snapshot) => {
        if (mine !== generation.current) return;
        if (snapshot.gex === null) {
          setFlowState({
            state: {
              reason: `no stored GEX snapshot yet for ${flowSymbol}.`,
              type: "empty",
            },
            symbol: flowSymbol,
          });
          return;
        }
        const overlay = gammaLevelsFromFlowGex(flowSymbol, snapshot.gex);
        if (overlay === null) {
          setFlowState({
            state: {
              reason:
                snapshot.gex.symbolLevels === null
                  ? `basis not computed for ${flowSymbol} (${snapshot.gex.ticker} levels not shifted).`
                  : `no GEX or max-pain levels computed for ${flowSymbol}.`,
              type: "empty",
            },
            symbol: flowSymbol,
          });
          return;
        }
        setFlowState({
          state: { overlay, type: "ready" },
          symbol: flowSymbol,
        });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        const failure = describeMarketDataFailure(error);
        if (failure.code === "FORBIDDEN") {
          setFlowState({
            state: { type: "forbidden" },
            symbol: flowSymbol,
          });
          return;
        }
        setFlowState({
          state: { message: failure.message, type: "error" },
          symbol: flowSymbol,
        });
      }
    );
    return () => {
      generation.current += 1;
    };
  }, [enabled, flowSnapshot, flowSymbol, retryToken]);

  const onRetry = useCallback(() => {
    setRetryToken((count) => count + 1);
  }, []);

  if (eligibility === null || !enabled) {
    return {
      eligible: eligibility !== null,
      enabled,
      onRetry: undefined,
      overlay: null,
      setEnabled,
      state: IDLE_STATE,
    };
  }

  const state: GammaLevelsLoadState =
    eligibility.kind === "optionsAnalytics"
      ? analyticsState
      : flowState.symbol === eligibility.symbol
        ? flowState.state
        : { type: "loading" };

  const overlay =
    !replayActive && state.type === "ready" ? state.overlay : null;

  return {
    eligible: true,
    enabled,
    onRetry: eligibility.kind === "flowGex" ? onRetry : undefined,
    overlay,
    setEnabled,
    state,
  };
};
