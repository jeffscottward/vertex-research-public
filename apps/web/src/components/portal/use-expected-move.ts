"use client";

// What: React hook that loads per-expiry expected move bands for US equity charts on /charts.
// Enforces OptionsChainSymbolSchema validation, symbol-scoped expiry selection, and generation
// cancellation so stale responses never clobber state. Research only.
// Used by: components/portal/charts-workspace.tsx.

import {
  type OptionsChainExpiry,
  OptionsChainSymbolSchema,
} from "@darkfactory/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  barSpacing,
  type ExpectedMoveHorizonScale,
  expectedMoveTargetIndex,
  toExpectedMoveCone,
} from "../../features/charts/expected-move-overlay.ts";
import type {
  DisplayCandle,
  ExpectedMoveCone,
} from "../../features/charts/types.ts";
import type { OptionsChainGateway } from "../../features/stock-detail/options-chain-client.ts";
import type { ExpectedMoveLoadState } from "./expected-move-bar.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";

export type ExpectedMoveView = Readonly<{
  eligible: boolean;
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  state: ExpectedMoveLoadState;
  expiries: readonly OptionsChainExpiry[];
  selectedExpiry: string | null;
  onExpiry: (expiry: string) => void;
  onRetry: () => void;
  cone: ExpectedMoveCone | null;
  horizonScale: ExpectedMoveHorizonScale | null;
}>;

const NO_EXPIRIES: readonly OptionsChainExpiry[] = Object.freeze([]);
const IDLE_STATE: ExpectedMoveLoadState = Object.freeze({ type: "idle" });
const IDLE_ENTRY = Object.freeze({ symbol: "", value: IDLE_STATE });

export const isExpectedMoveEligible = (
  secType: string | null,
  currency: string | null,
  symbol: string | null
): string | null => {
  if (secType !== "STK" || currency !== "USD" || symbol === null) return null;
  const parsed = OptionsChainSymbolSchema.safeParse(symbol);
  return parsed.success ? parsed.data : null;
};

export const useExpectedMoveView = ({
  gateway,
  secType,
  currency,
  symbol,
  candles,
  replayActive,
}: Readonly<{
  gateway: Pick<OptionsChainGateway, "expectedMove">;
  secType: string | null;
  currency: string | null;
  symbol: string | null;
  candles: readonly DisplayCandle[];
  replayActive: boolean;
}>): ExpectedMoveView => {
  const validSymbol = isExpectedMoveEligible(secType, currency, symbol);
  const eligible = validSymbol !== null;
  const [enabled, setEnabledState] = useState(false);
  const [selection, setSelection] = useState<
    Readonly<{ symbol: string; expiry: string | undefined }>
  >({ expiry: undefined, symbol: "" });
  const [attempt, setAttempt] = useState(0);
  const [stateEntry, setStateEntry] =
    useState<Readonly<{ symbol: string; value: ExpectedMoveLoadState }>>(
      IDLE_ENTRY
    );
  const [cachedExpiries, setCachedExpiries] = useState<
    Readonly<{ symbol: string; items: readonly OptionsChainExpiry[] }>
  >({ items: NO_EXPIRIES, symbol: "" });
  const generation = useRef(0);

  const activeExpiry =
    validSymbol !== null && selection.symbol === validSymbol
      ? selection.expiry
      : undefined;

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    if (!next) {
      generation.current += 1;
      setStateEntry(IDLE_ENTRY);
    }
  }, []);

  const onExpiry = useCallback(
    (expiry: string) => {
      if (validSymbol === null) return;
      setSelection({ expiry, symbol: validSymbol });
    },
    [validSymbol]
  );

  const onRetry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    const mine = ++generation.current;
    if (!enabled || validSymbol === null) {
      setStateEntry(IDLE_ENTRY);
      return () => {
        generation.current += 1;
      };
    }
    setStateEntry({ symbol: validSymbol, value: { type: "loading" } });
    const input =
      activeExpiry === undefined
        ? { symbol: validSymbol }
        : { expiry: activeExpiry, symbol: validSymbol };
    gateway.expectedMove(input).then(
      (data) => {
        if (mine !== generation.current) return;
        setCachedExpiries({ items: data.expiries, symbol: validSymbol });
        setStateEntry({ symbol: validSymbol, value: { data, type: "ready" } });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        setStateEntry({
          symbol: validSymbol,
          value: {
            message: describeMarketDataFailure(error).message,
            type: "error",
          },
        });
      }
    );
    return () => {
      generation.current += 1;
    };
  }, [enabled, validSymbol, activeExpiry, attempt, gateway]);

  const state: ExpectedMoveLoadState =
    validSymbol !== null && stateEntry.symbol === validSymbol
      ? stateEntry.value
      : IDLE_STATE;
  const expiries =
    validSymbol !== null && cachedExpiries.symbol === validSymbol
      ? cachedExpiries.items
      : NO_EXPIRIES;

  const rawCone = useMemo(
    () =>
      enabled && !replayActive && state.type === "ready"
        ? toExpectedMoveCone(state.data)
        : null,
    [enabled, replayActive, state]
  );

  const timestamps = useMemo(
    () => candles.map((bar) => bar.timestamp),
    [candles]
  );

  const horizonScale = useMemo(() => {
    if (rawCone === null) return null;
    const target = expectedMoveTargetIndex(
      timestamps,
      rawCone.expiryCloseMs,
      barSpacing(timestamps)
    );
    return target?.horizonScale ?? null;
  }, [rawCone, timestamps]);

  return {
    cone: rawCone,
    eligible,
    enabled,
    expiries,
    horizonScale,
    onExpiry,
    onRetry,
    selectedExpiry: activeExpiry ?? null,
    setEnabled,
    state,
  };
};
