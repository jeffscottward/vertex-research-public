// What: CollapsibleSummary (a page summary block the user can fold; the choice is kept in localStorage under vertex.summary.<id>.collapsed) and StickyTabs (a tab bar that sticks under the top bar, syncs its value to ?tab= and keeps the bar in place on switch).
// Used by: tabbed portal pages: page header -> CollapsibleSummary -> StickyTabs -> tab content (portfolio first).
// See: ~/Documents/reports/web/firstmate/vertex-ui-program.md ("Collapsible summary + sticky tabs").
"use client";

import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../utilities.ts";

export const summaryStorageKey = (id: string): string =>
  `vertex.summary.${id}.collapsed`;

const readCollapsed = (id: string): boolean => {
  try {
    return window.localStorage.getItem(summaryStorageKey(id)) === "true";
  } catch {
    return false;
  }
};

const writeCollapsed = (id: string, collapsed: boolean): void => {
  try {
    window.localStorage.setItem(summaryStorageKey(id), String(collapsed));
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this visit.
  }
};

export interface CollapsibleSummaryProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Stable page id; part of the localStorage key. */
  readonly id: string;
  readonly title: ReactNode;
}

/** Starts open on the server, then applies the saved choice after hydration. */
export const CollapsibleSummary = ({
  children,
  className,
  id,
  title,
}: CollapsibleSummaryProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  useEffect(() => setCollapsed(readCollapsed(id)), [id]);
  const toggle = () => {
    const next = !collapsed;
    writeCollapsed(id, next);
    return setCollapsed(next);
  };
  return (
    <section
      className={cn("min-w-0 rounded-xl border bg-card", className)}
      data-collapsed={collapsed}
      data-slot="collapsible-summary"
    >
      <button
        aria-controls={bodyId}
        aria-expanded={!collapsed}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-4 py-2 text-left font-semibold text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={toggle}
        type="button"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 transition-transform",
            collapsed && "-rotate-90"
          )}
        />
      </button>
      <div
        className="border-t px-4 py-4"
        data-slot="collapsible-summary-content"
        hidden={collapsed}
        id={bodyId}
      >
        {children}
      </div>
    </section>
  );
};

export interface StickyTab {
  readonly content: ReactNode;
  readonly label: ReactNode;
  readonly value: string;
}

export interface StickyTabsProps {
  readonly className?: string;
  /** Tab used when ?tab= is absent or unknown; the first tab by default. */
  readonly defaultValue?: string;
  /** Tab from the server request (searchParams), so a ?tab= deep link renders that tab first. */
  readonly initialValue?: string;
  /** Accessible name of the tab list. */
  readonly label: string;
  /** Query parameter that holds the tab; "tab" by default. */
  readonly param?: string;
  readonly tabs: readonly StickyTab[];
}

const tabFromUrl = (
  param: string,
  tabs: readonly StickyTab[],
  fallback: string
): string => {
  const value = new URLSearchParams(window.location.search).get(param);
  return tabs.some((tab) => tab.value === value) && value !== null
    ? value
    : fallback;
};

export const StickyTabs = ({
  className,
  defaultValue,
  initialValue,
  label,
  param = "tab",
  tabs,
}: StickyTabsProps) => {
  const fallback = defaultValue ?? tabs[0]?.value ?? "";
  const [active, setActive] = useState(
    initialValue !== undefined && tabs.some((tab) => tab.value === initialValue)
      ? initialValue
      : fallback
  );
  const barRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ stuck: boolean; top: number } | null>(null);
  const baseId = useId();

  useEffect(() => {
    const sync = () => setActive(tabFromUrl(param, tabs, fallback));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [param, tabs, fallback]);

  // Keep the tab bar where it was on screen. When it was stuck, scroll to its normal
  // (unstuck) place, marked by the element above it, so the new tab starts right under it.
  useLayoutEffect(() => {
    const before = anchor.current;
    anchor.current = null;
    const bar = barRef.current;
    const marker = markerRef.current;
    if (before === null || bar === null || marker === null) return;
    const delta = before.stuck
      ? marker.getBoundingClientRect().top - before.top
      : bar.getBoundingClientRect().top - before.top;
    if (delta !== 0) window.scrollBy(0, delta);
  }, [active]);

  const select = (value: string) => {
    if (value === active) return;
    // Both elements are mounted whenever a tab event fires.
    const bar = (barRef.current as HTMLDivElement).getBoundingClientRect().top;
    const marker = (markerRef.current as HTMLDivElement).getBoundingClientRect()
      .top;
    anchor.current = { stuck: marker < bar - 1, top: bar };
    const url = new URL(window.location.href);
    url.searchParams.set(param, value);
    // A new history entry per tab click, so Back steps through tabs (popstate syncs).
    window.history.pushState(window.history.state, "", url);
    return setActive(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.value === active);
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    select(next.value);
    return document.getElementById(`${baseId}-tab-${next.value}`)?.focus();
  };

  return (
    <div className={cn("min-w-0", className)} data-slot="sticky-tabs">
      <div aria-hidden="true" data-slot="sticky-tabs-marker" ref={markerRef} />
      <div
        aria-label={label}
        className="sticky top-(--header-height) z-10 -mx-1 flex gap-1 overflow-x-auto border-b bg-background/95 px-1 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:top-0"
        data-slot="sticky-tabs-list"
        onKeyDown={onKeyDown}
        ref={barRef}
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
              onClick={() => select(tab.value)}
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
          className={cn("pt-4", tab.value === active && "min-h-dvh")}
          hidden={tab.value !== active}
          id={`${baseId}-panel-${tab.value}`}
          key={tab.value}
          role="tabpanel"
        >
          {tab.value === active ? tab.content : null}
        </div>
      ))}
    </div>
  );
};
