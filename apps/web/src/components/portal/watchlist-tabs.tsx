"use client";

// What: the watchlist tab bar (WAI-ARIA tabs, automatic activation). Click, or Arrow Left/Right,
// Home and End on the tab list. A panel mounts the first time its tab opens and then stays
// mounted (hidden), so opening a tab starts its requests once and keeps its data and edits.
// Used by: watchlist-workspace.tsx.

import { cn } from "@darkfactory/ui";
import { type KeyboardEvent, type ReactNode, useId } from "react";

export interface WatchlistTab<V extends string> {
  readonly value: V;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

export interface WatchlistTabsProps<V extends string> {
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly tabs: readonly WatchlistTab<V>[];
  readonly active: V;
  /** Tabs opened so far (including the active one); their panels stay mounted. */
  readonly opened: ReadonlySet<V>;
  readonly onSelect: (value: V) => void;
}

const KEY_STEPS: Readonly<Record<string, "first" | "last" | 1 | -1>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  End: "last",
  Home: "first",
};

export const WatchlistTabs = <V extends string>({
  label,
  tabs,
  active,
  opened,
  onSelect,
}: WatchlistTabsProps<V>) => {
  const baseId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.value === active);
    const target =
      step === "first"
        ? 0
        : step === "last"
          ? tabs.length - 1
          : (index + step + tabs.length) % tabs.length;
    const next = tabs[target] as WatchlistTab<V>;
    onSelect(next.value);
    // The tab buttons are the tab list's children, in tab order.
    (event.currentTarget.children[target] as HTMLElement).focus();
  };

  return (
    <div className="min-w-0" data-slot="watchlist-tabs">
      <div
        aria-label={label}
        className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
        onKeyDown={onKeyDown}
        role="tablist"
      >
        {tabs.map((tab) => {
          const selected = tab.value === active;
          return (
            <button
              aria-controls={`${baseId}-panel-${tab.value}`}
              aria-selected={selected}
              className={cn(
                "-mb-px inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              id={`${baseId}-tab-${tab.value}`}
              key={tab.value}
              onClick={() => onSelect(tab.value)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          aria-labelledby={`${baseId}-tab-${tab.value}`}
          className="pt-4"
          hidden={tab.value !== active}
          id={`${baseId}-panel-${tab.value}`}
          key={tab.value}
          role="tabpanel"
        >
          {tab.value === active || opened.has(tab.value) ? tab.content : null}
        </div>
      ))}
    </div>
  );
};
