"use client";

// What: compact control & summary strip for per-expiry ATM straddle expected move bands (±1σ and
// straddle breakeven) overlaid on /charts and /stock/[symbol] price charts. Research only.
// Used by: components/portal/charts-workspace.tsx, features/stock-detail/stock-chart-panel.tsx.

import {
  type ExpectedMoveBasis,
  type ExpectedMoveLegSource,
  OPTIONS_CHAIN_SOURCE_LABELS,
  type OptionsChainExpiry,
  type OptionsExpectedMoveBand,
  type OptionsExpectedMoveOutput,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import { useId } from "react";

import type { ExpectedMoveHorizonScale } from "../../features/charts/expected-move-overlay.ts";

export type ExpectedMoveLoadState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: OptionsExpectedMoveOutput }>;

export interface ExpectedMoveBarProps {
  readonly enabled: boolean;
  readonly errorRole?: "alert" | "status";
  readonly expiries: readonly OptionsChainExpiry[];
  readonly horizonScale?: ExpectedMoveHorizonScale | null;
  readonly onExpiry: (expiry: string) => void;
  readonly onRetry?: () => void;
  readonly priceDigits: number;
  readonly replayActive?: boolean;
  readonly selectedExpiry: string | null;
  readonly state: ExpectedMoveLoadState;
}

const BASIS_LABELS: Readonly<Record<ExpectedMoveBasis, string>> = {
  atm_iv_model: "ATM IV model (no two-sided quotes)",
  atm_straddle_last: "ATM straddle (last fallback)",
  atm_straddle_mid: "ATM straddle mid",
};

const formatMoney = (value: number, digits: number): string =>
  `$${value.toFixed(digits)}`;

const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const formatLegSources = (
  callSource: ExpectedMoveLegSource,
  putSource: ExpectedMoveLegSource
): string => {
  const callLabel = OPTIONS_CHAIN_SOURCE_LABELS[callSource];
  const putLabel = OPTIONS_CHAIN_SOURCE_LABELS[putSource];
  return callSource === putSource
    ? callLabel
    : `call ${callLabel}, put ${putLabel}`;
};

const horizonNote = (
  scale: ExpectedMoveHorizonScale | null | undefined,
  expiry: string
): string | null => {
  if (scale === "compressed")
    return `Cone width is compressed into the chart right margin; vertical price levels are exact for ${expiry}.`;
  if (scale === "expanded")
    return `Cone width is expanded for readability; vertical price levels are exact for ${expiry}.`;
  return null;
};

const ExpectedMoveMetrics = ({
  band,
  priceDigits,
}: Readonly<{
  band: OptionsExpectedMoveBand;
  priceDigits: number;
}>) => {
  const { straddleLower, straddlePrice, straddleUpper } = band;
  return (
    <dl
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono tabular-nums"
      data-expected-move-status="ready"
    >
      <div className="flex items-baseline gap-1.5">
        <dt className="font-sans text-muted-foreground">±1σ move</dt>
        <dd className="font-semibold text-foreground">
          ±{formatMoney(band.expectedMove, priceDigits)} (±
          {formatPct(band.expectedMovePct)})
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="font-sans text-muted-foreground">Range</dt>
        <dd className="text-foreground">
          {formatMoney(band.lowerBand, priceDigits)} –{" "}
          {formatMoney(band.upperBand, priceDigits)}
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="font-sans text-muted-foreground">ATM</dt>
        <dd className="text-foreground">
          {formatMoney(band.atmStrike, priceDigits)}
        </dd>
      </div>
      {straddlePrice !== null &&
      straddleLower !== null &&
      straddleUpper !== null ? (
        <div className="flex items-baseline gap-1.5">
          <dt className="font-sans text-muted-foreground">Straddle BE</dt>
          <dd className="text-foreground">
            {formatMoney(straddlePrice, priceDigits)} (
            {formatMoney(straddleLower, priceDigits)} –{" "}
            {formatMoney(straddleUpper, priceDigits)})
          </dd>
        </div>
      ) : null}
    </dl>
  );
};

const ExpectedMoveStatus = ({
  state,
  replayActive,
  priceDigits,
  onRetry,
  errorRole,
}: Readonly<{
  state: ExpectedMoveLoadState;
  replayActive: boolean;
  priceDigits: number;
  onRetry: (() => void) | undefined;
  errorRole: "alert" | "status";
}>) => {
  if (replayActive) {
    return (
      <span
        className="text-muted-foreground"
        data-expected-move-status="replay"
        role="status"
      >
        Expected move cone hidden during bar replay.
      </span>
    );
  }
  if (state.type === "loading") {
    return (
      <span
        aria-busy="true"
        className="text-muted-foreground"
        data-expected-move-status="loading"
      >
        Loading expected move…
      </span>
    );
  }
  if (state.type === "error") {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        data-expected-move-status="error"
        role={errorRole}
      >
        <span className="text-destructive">{state.message}</span>
        {onRetry === undefined ? null : (
          <Button
            className="min-h-11"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (state.type === "ready") {
    if (state.data.band === null) {
      return (
        <span
          className="text-muted-foreground"
          data-expected-move-status="unavailable"
          role="status"
        >
          {state.data.unavailableReason}
        </span>
      );
    }
    return (
      <ExpectedMoveMetrics band={state.data.band} priceDigits={priceDigits} />
    );
  }
  return null;
};

const ExpectedMoveFootnote = ({
  band,
  expiry,
  horizonScale,
}: Readonly<{
  band: OptionsExpectedMoveBand;
  expiry: string;
  horizonScale: ExpectedMoveHorizonScale | null;
}>) => {
  const sourceSuffix =
    band.callQuoteSource === null || band.putQuoteSource === null
      ? ""
      : ` · ${formatLegSources(band.callQuoteSource, band.putQuoteSource)}`;
  const ivSuffix =
    band.atmIv === null ? "" : ` · ATM IV ${formatPct(band.atmIv)}`;
  const note = horizonNote(horizonScale, expiry);
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
      <span>
        Basis: {BASIS_LABELS[band.basis]}
        {sourceSuffix}
        {ivSuffix}
      </span>
      {note === null ? null : <span>{note}</span>}
      <span>Research view only; not a trade signal.</span>
    </p>
  );
};

export const ExpectedMoveBar = ({
  enabled,
  state,
  expiries,
  selectedExpiry,
  onExpiry,
  onRetry,
  priceDigits,
  replayActive = false,
  horizonScale = null,
  errorRole = "alert",
}: ExpectedMoveBarProps) => {
  const selectId = useId();
  if (!enabled) return null;

  const activeExpiry =
    selectedExpiry ??
    (state.type === "ready" ? state.data.expiry : (expiries[0]?.date ?? ""));
  const readyBand =
    !replayActive && state.type === "ready" ? state.data.band : null;

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-card px-3 py-2 text-card-foreground text-xs"
      data-expected-move-bar=""
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium text-foreground">Expected move</span>
        {expiries.length > 0 ? (
          <div className="flex items-center gap-2">
            <label className="text-muted-foreground" htmlFor={selectId}>
              Expiry
            </label>
            <select
              aria-label="Expected move expiry"
              className="min-h-11 rounded-md border border-border bg-background px-2.5 text-foreground text-xs tabular-nums"
              data-expected-move-expiry=""
              disabled={state.type === "loading"}
              id={selectId}
              onChange={(event) => onExpiry(event.target.value)}
              value={activeExpiry}
            >
              {expiries.map((item) => (
                <option key={item.date} value={item.date}>
                  {item.date} ({item.dte} DTE)
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <ExpectedMoveStatus
          errorRole={errorRole}
          onRetry={onRetry}
          priceDigits={priceDigits}
          replayActive={replayActive}
          state={state}
        />
      </div>

      {readyBand !== null && state.type === "ready" ? (
        <ExpectedMoveFootnote
          band={readyBand}
          expiry={state.data.expiry}
          horizonScale={horizonScale}
        />
      ) : null}
    </div>
  );
};
