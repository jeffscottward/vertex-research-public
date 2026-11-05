"use client";

import { IconButton } from "@darkfactory/ui";
import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { NavigationItem } from "../lib/navigation.ts";
import { isTickerQuery, tickerHref } from "../lib/ticker-href.ts";

export type PaletteItem = Readonly<{
  label: string;
  href: string;
  group: string;
}>;

// Case-insensitive match on label, group or path; prefix matches on the label sort first.
export const filterPaletteItems = (
  items: readonly PaletteItem[],
  query: string
): PaletteItem[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  return items
    .filter((item) =>
      `${item.label} ${item.group} ${item.href}`.toLowerCase().includes(needle)
    )
    .sort(
      (left, right) =>
        Number(!left.label.toLowerCase().startsWith(needle)) -
        Number(!right.label.toLowerCase().startsWith(needle))
    );
};

/** Page matches, then "Open <TICKER>" when the query looks like a ticker symbol. */
export const paletteMatches = (
  items: readonly PaletteItem[],
  query: string
): PaletteItem[] => {
  const pages = filterPaletteItems(items, query);
  if (!isTickerQuery(query)) return pages;
  const symbol = query.trim().toUpperCase();
  return [
    ...pages,
    { group: "Ticker", href: tickerHref(symbol), label: `Open ${symbol}` },
  ];
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
};

export const toPaletteItems = (
  groups: readonly Readonly<{
    group: string;
    items: readonly NavigationItem[];
  }>[]
): PaletteItem[] => {
  return groups.flatMap(({ group, items }) =>
    items.map((item) => ({ group, href: item.href, label: item.label }))
  );
};

const assignLocation = (href: string): void => {
  window.location.assign(href);
};

export const CommandPalette = ({
  items,
  navigate = assignLocation,
  trigger = "icon",
}: {
  readonly items: readonly PaletteItem[];
  readonly navigate?: (href: string) => void;
  /** "search": a search box with the Ctrl/Cmd+K hint (icon only below sm). */
  readonly trigger?: "icon" | "search";
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => paletteMatches(items, query), [items, query]);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog === null || dialog.open) return;
    setQuery("");
    setActive(0);
    dialog.showModal();
    return inputRef.current?.focus();
  }, []);

  const close = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const shortcut =
        (event.key === "k" || event.key === "K") &&
        (event.metaKey || event.ctrlKey);
      const slash =
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target);
      if (shortcut || slash) {
        event.preventDefault();
        return open();
      }
      return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const go = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    close();
    return navigate(item.href);
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      return setActive((index) =>
        Math.min(index + 1, Math.max(matches.length - 1, 0))
      );
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      return setActive((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      return go(matches[active]);
    }
    return;
  };

  return (
    <>
      {trigger === "search" ? (
        <>
          <button
            aria-keyshortcuts="Control+K Meta+K /"
            aria-label="Search ticker or page"
            className="hidden min-h-11 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-background px-3 text-muted-foreground text-sm shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:flex"
            data-slot="portal-search"
            onClick={open}
            type="button"
          >
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              Search ticker or page
            </span>
            <kbd className="pointer-events-none rounded border border-border bg-muted px-1.5 font-mono text-[0.7rem]">
              Ctrl/⌘ K
            </kbd>
          </button>
          <IconButton
            aria-keyshortcuts="Control+K Meta+K /"
            aria-label="Search ticker or page"
            className="sm:hidden"
            data-trigger="portal-search-icon"
            onClick={open}
            variant="ghost"
          >
            <Search aria-hidden="true" />
          </IconButton>
        </>
      ) : (
        <IconButton
          aria-keyshortcuts="Control+K Meta+K /"
          aria-label="Jump to a page"
          onClick={open}
          title="Jump to a page (Ctrl+K or /)"
          variant="ghost"
        >
          <Search aria-hidden="true" />
        </IconButton>
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a pointer-only shortcut; keyboard users close the native dialog with Escape. */}
      <dialog
        aria-label="Jump to a page"
        className="m-auto w-full max-w-lg rounded-lg border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
        onClick={(event) => {
          if (event.target === dialogRef.current) return close();
          return;
        }}
        ref={dialogRef}
      >
        <div className="border-border border-b p-3">
          <input
            aria-activedescendant={
              matches[active] === undefined
                ? undefined
                : `palette-item-${active}`
            }
            aria-controls="palette-results"
            aria-expanded="true"
            aria-label="Page name"
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              setQuery(event.target.value);
              return setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search ticker or page"
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </div>
        <div
          className="max-h-80 overflow-y-auto p-1"
          id="palette-results"
          role="listbox"
        >
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground text-sm">
              No matching page.
            </p>
          ) : (
            matches.map((item, index) => {
              return (
                <div
                  aria-selected={index === active}
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-sm ${index === active ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                  data-href={item.href}
                  id={`palette-item-${index}`}
                  key={`${item.group}:${item.href}`}
                  onClick={() => go(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") go(item);
                  }}
                  onMouseMove={() => setActive(index)}
                  role="option"
                  tabIndex={-1}
                >
                  <span className="font-medium text-foreground">
                    {item.label}
                  </span>
                  <span className="text-xs">{item.group}</span>
                </div>
              );
            })
          )}
        </div>
      </dialog>
    </>
  );
};
