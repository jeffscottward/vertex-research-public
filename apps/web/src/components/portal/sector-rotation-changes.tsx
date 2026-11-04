"use client";

import {
  createApiClient,
  SECTOR_ROTATION_QUADRANTS,
  type SectorRotationQuadrant,
  type SectorRotationSnapshot,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import { useCallback, useEffect, useState } from "react";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

export interface SectorRotationChangesProps {
  readonly load?: () => Promise<SectorRotationSnapshot>;
}

type State =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly data: SectorRotationSnapshot }
  | { readonly type: "forbidden" }
  | { readonly type: "missing" }
  | { readonly type: "error" };

const QUADRANT_LABELS: Record<SectorRotationQuadrant, string> = {
  improving: "Improving",
  lagging: "Lagging",
  leading: "Leading",
  weakening: "Weakening",
};

// Text label is always shown; the color only adds a hint.
const QUADRANT_CHIP: Record<SectorRotationQuadrant, string> = {
  improving: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  lagging: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  leading:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  weakening:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

export const loadBrowserSectorRotationSnapshot =
  (): Promise<SectorRotationSnapshot> =>
    createApiClient({
      baseUrl: window.location.origin,
    }).sectorRotation.snapshot({ timeframe: "daily" });

const Chip = ({ quadrant }: { readonly quadrant: SectorRotationQuadrant }) => (
  <span
    className={`rounded px-1.5 py-0.5 font-medium text-xs ${QUADRANT_CHIP[quadrant]}`}
    data-quadrant={quadrant}
  >
    {QUADRANT_LABELS[quadrant]}
  </span>
);

export const SectorRotationChanges = ({
  load = loadBrowserSectorRotationSnapshot,
}: SectorRotationChangesProps) => {
  const [state, setState] = useState<State>({ type: "loading" });

  const run = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ data: await load(), type: "ready" });
    } catch (error) {
      if (isOperatorAccessDenied(error)) return setState({ type: "forbidden" });
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "NOT_FOUND"
      )
        return setState({ type: "missing" });
      return setState({ type: "error" });
    }
  }, [load]);

  useEffect(() => {
    void run();
  }, [run]);

  if (state.type === "forbidden") return null;

  return (
    <section
      aria-labelledby="sector-rotation-changes-title"
      className="min-h-32 space-y-2 rounded-md border border-border p-4"
    >
      <h2 className="font-medium text-sm" id="sector-rotation-changes-title">
        Sector rotation
      </h2>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading sector rotation…
        </p>
      ) : null}
      {state.type === "missing" ? (
        <p className="text-muted-foreground text-sm">
          Not yet collected. The nightly job fills it after the US close.
        </p>
      ) : null}
      {state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">Could not load sector rotation.</p>
          <Button
            className="min-h-11"
            onClick={() => void run()}
            type="button"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : null}
      {state.type === "ready" ? <Ready data={state.data} /> : null}
    </section>
  );
};

const Ready = ({ data }: { readonly data: SectorRotationSnapshot }) => {
  const since = data.previousDate ?? "the previous session";
  const counts = SECTOR_ROTATION_QUADRANTS.map(
    (quadrant) =>
      `${QUADRANT_LABELS[quadrant]} ${data.sectors.filter((s) => s.quadrant === quadrant).length}`
  ).join(" · ");
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs" data-testid="counts">
        {counts}
      </p>
      {data.changes.length === 0 ? (
        <p className="text-sm">No quadrant changes since {since}.</p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Quadrant changes since {since}
          </p>
          <ul className="space-y-1">
            {data.changes.map((change) => (
              <li
                className="flex flex-wrap items-center gap-1 text-sm"
                key={`${change.symbol}:${change.date}`}
              >
                <span>
                  <span className="font-mono">{change.symbol}</span>
                  {change.name === null ? "" : ` ${change.name}`}:
                </span>
                <Chip quadrant={change.from} />
                <span aria-hidden="true">→</span>
                <span className="sr-only">to</span>
                <Chip quadrant={change.to} />
              </li>
            ))}
          </ul>
        </>
      )}
      <a
        className="inline-flex min-h-11 items-center text-sm underline"
        href="/sector-rotation"
      >
        Open sector rotation
      </a>
    </div>
  );
};
