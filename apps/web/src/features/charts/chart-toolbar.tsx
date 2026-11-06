"use client";

import { cn } from "@darkfactory/ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  type ChartIndicatorKey,
  type ChartIndicatorOption,
  indicatorSummary,
  OVERLAY_OPTIONS,
  STUDY_OPTIONS,
  toggleIndicator,
} from "./chart-indicators.ts";
import { CHART_INTERVALS, type ChartInterval } from "./chart-intervals.ts";

// Chart controls ported from the CHARAN signal chart: interval picker, Overlay and Study
// menus and a volume pane toggle. Vertex tokens only; no CHARAN colors.

const controlClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-border-strong bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

type MenuProps = Readonly<{
  label: string;
  options: readonly ChartIndicatorOption[];
  selected: readonly ChartIndicatorKey[];
  onToggle: (key: ChartIndicatorKey) => void;
}>;

// Disclosure menu with checkboxes. Escape or a click outside closes it.
const IndicatorMenu = ({ label, options, selected, onToggle }: MenuProps) => {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={root}>
      <button
        aria-controls={listId}
        aria-expanded={open}
        className={controlClass}
        data-chart-menu={label}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="text-muted-foreground">{label}</span>
        <span className="max-w-40 truncate font-medium">
          {indicatorSummary(options, selected)}
        </span>
        <ChevronDown aria-hidden="true" className="size-4" />
      </button>
      {open ? (
        <fieldset
          className="absolute top-full left-0 z-20 mt-1 grid min-w-56 gap-0.5 rounded-md border border-border-strong bg-popover p-1 text-popover-foreground shadow-md"
          id={listId}
        >
          <legend className="sr-only">{label} indicators</legend>
          {options.map((option) => (
            <label
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm hover:bg-muted"
              key={option.key}
            >
              <input
                checked={selected.includes(option.key)}
                className="size-4"
                onChange={() => onToggle(option.key)}
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
};

export type ChartToolbarProps = Readonly<{
  // Null when the shown bars match no interval button (custom settings).
  interval: ChartInterval | null;
  onInterval: (interval: ChartInterval) => void;
  indicators: readonly ChartIndicatorKey[];
  onIndicators: (next: ChartIndicatorKey[]) => void;
  volume: boolean;
  onVolume: (volume: boolean) => void;
  // Extra controls placed after the built-in ones (for example a backtest picker).
  children?: ReactNode;
}>;

export const ChartToolbar = ({
  interval,
  onInterval,
  indicators,
  onIndicators,
  volume,
  onVolume,
  children,
}: ChartToolbarProps) => {
  const toggle = (key: ChartIndicatorKey) =>
    onIndicators(toggleIndicator(indicators, key));
  return (
    <div
      aria-label="Chart controls"
      className="flex flex-wrap items-center gap-2"
      data-chart-toolbar=""
      role="group"
    >
      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="sr-only">Interval</legend>
        {CHART_INTERVALS.map((option) => (
          <button
            aria-pressed={option === interval}
            className={cn(
              controlClass,
              "px-2 font-medium tabular-nums",
              option === interval
                ? "border-foreground bg-muted"
                : "text-muted-foreground"
            )}
            key={option}
            onClick={() => onInterval(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </fieldset>
      <IndicatorMenu
        label="Overlay"
        onToggle={toggle}
        options={OVERLAY_OPTIONS}
        selected={indicators}
      />
      <IndicatorMenu
        label="Study"
        onToggle={toggle}
        options={STUDY_OPTIONS}
        selected={indicators}
      />
      <label className={cn(controlClass, "cursor-pointer")}>
        <input
          checked={volume}
          className="size-4"
          onChange={(event) => onVolume(event.target.checked)}
          type="checkbox"
        />
        Volume
      </label>
      {children}
    </div>
  );
};
