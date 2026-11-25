"use client";

// What: compact legend, status, and source-disclosure strip for horizontal dealer gamma levels
// (gamma flip, call wall, put wall, max pain, king node) overlaid on /charts price charts.
// Display only: research context, never an order or risk input.
// Used by: components/portal/charts-workspace.tsx.

import { Button } from "@darkfactory/ui";

import {
  extractGammaLevelEntries,
  GAMMA_LEVEL_KINDS,
  GAMMA_LEVEL_META,
  type GammaLevelKind,
  type GammaLevelsOverlay,
} from "../../features/charts/gamma-levels-overlay.ts";
import { statusTime, TIME_NOT_REPORTED } from "../status-time.ts";

export type GammaLevelsLoadState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "empty"; reason: string }>
  | Readonly<{ type: "ready"; overlay: GammaLevelsOverlay }>;

export interface GammaLevelsBarProps {
  readonly enabled: boolean;
  readonly onRetry?: (() => void) | undefined;
  readonly priceDigits: number;
  readonly replayActive?: boolean;
  readonly state: GammaLevelsLoadState;
}

const STROKE_VAR_BY_KIND: Readonly<Record<GammaLevelKind, string>> = {
  callWall: "var(--success)",
  flip: "var(--warning)",
  kingNode: "var(--chart-1)",
  maxPain: "var(--info)",
  putWall: "var(--destructive)",
};

const formatDistance = (pct: number): string =>
  `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;

const sourceCaption = (overlay: GammaLevelsOverlay): string => {
  const time = statusTime(overlay.asOf);
  const when = time === TIME_NOT_REPORTED ? overlay.asOf : time;
  if (overlay.source === "flowGex") {
    const basisText =
      overlay.underlyingTicker !== null &&
      overlay.underlyingTicker !== overlay.symbol &&
      overlay.basis !== null
        ? `${overlay.underlyingTicker} ${overlay.basis >= 0 ? "+" : ""}${overlay.basis.toFixed(2)} basis`
        : (overlay.underlyingTicker ?? overlay.symbol);
    return `Stored flow_gex (${basisText}) · as of ${when} · QuantData estimate · research only`;
  }
  return `QuantData estimate · as of ${when} · research only`;
};

const LevelSwatch = ({ kind }: Readonly<{ kind: GammaLevelKind }>) => {
  const meta = GAMMA_LEVEL_META[kind];
  return (
    <svg aria-hidden="true" className="h-2.5 w-5 shrink-0" viewBox="0 0 20 10">
      <line
        stroke={STROKE_VAR_BY_KIND[kind]}
        strokeDasharray={meta.svgDashArray}
        strokeWidth={meta.strokeWidth}
        x1={0}
        x2={20}
        y1={5}
        y2={5}
      />
    </svg>
  );
};

const GammaLevelsMetrics = ({
  overlay,
  priceDigits,
}: Readonly<{
  overlay: GammaLevelsOverlay;
  priceDigits: number;
}>) => {
  const entries = extractGammaLevelEntries(overlay);
  const byKind = new Map(entries.map((entry) => [entry.kind, entry] as const));
  return (
    <div className="space-y-1.5" data-gamma-levels-status="ready">
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 text-xs">
        {GAMMA_LEVEL_KINDS.map((kind) => {
          const meta = GAMMA_LEVEL_META[kind];
          const entry = byKind.get(kind);
          const sharedWall =
            kind === "kingNode" && entry !== undefined
              ? entry.coincidentWith.find(
                  (other) => other === "callWall" || other === "putWall"
                )
              : undefined;
          return (
            <div
              className="flex items-center gap-1.5"
              data-gamma-level={kind}
              key={kind}
              title={meta.meaning}
            >
              <LevelSwatch kind={kind} />
              <dt className="text-muted-foreground">
                <span aria-hidden="true" className="mr-0.5">
                  {meta.glyph}
                </span>
                {meta.label}
              </dt>
              <dd className="font-mono text-foreground tabular-nums">
                {entry === undefined ? (
                  <span className="text-muted-foreground">not computed</span>
                ) : (
                  <>
                    <span className="font-semibold">
                      {entry.price.toFixed(priceDigits)}
                    </span>
                    {entry.distancePct === null ? null : (
                      <span className="ml-1 text-muted-foreground">
                        ({formatDistance(entry.distancePct)})
                      </span>
                    )}
                    {sharedWall === undefined ? null : (
                      <span className="ml-1 text-muted-foreground">
                        · at {GAMMA_LEVEL_META[sharedWall].label.toLowerCase()}
                      </span>
                    )}
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-muted-foreground text-xs" data-gamma-levels-source="">
        {sourceCaption(overlay)}
      </p>
    </div>
  );
};

export const GammaLevelsBar = ({
  enabled,
  onRetry,
  priceDigits,
  replayActive = false,
  state,
}: GammaLevelsBarProps) => {
  if (!enabled || state.type === "idle") return null;
  if (replayActive) {
    return (
      <div
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-gamma-levels-bar=""
      >
        <p
          className="text-muted-foreground"
          data-gamma-levels-status="replay"
          role="status"
        >
          Gamma levels hidden during bar replay.
        </p>
      </div>
    );
  }
  if (state.type === "loading") {
    return (
      <div
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-gamma-levels-bar=""
      >
        <p
          aria-busy="true"
          className="text-muted-foreground"
          data-gamma-levels-status="loading"
        >
          Loading gamma levels…
        </p>
      </div>
    );
  }
  if (state.type === "forbidden") {
    return (
      <div
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-gamma-levels-bar=""
      >
        <p
          className="text-muted-foreground"
          data-gamma-levels-status="forbidden"
          role="status"
        >
          Operator access required to load stored futures gamma levels.
        </p>
      </div>
    );
  }
  if (state.type === "error") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-gamma-levels-bar=""
        data-gamma-levels-status="error"
        role="alert"
      >
        <span className="text-destructive">
          Could not load gamma levels: {state.message}
        </span>
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
  if (state.type === "empty") {
    return (
      <div
        className="rounded-md border border-border bg-card px-3 py-2 text-xs"
        data-gamma-levels-bar=""
      >
        <p
          className="text-muted-foreground"
          data-gamma-levels-status="empty"
          role="status"
        >
          Gamma levels: {state.reason}
        </p>
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-border bg-card px-3 py-2 text-xs"
      data-gamma-levels-bar=""
    >
      <GammaLevelsMetrics overlay={state.overlay} priceDigits={priceDigits} />
    </div>
  );
};
