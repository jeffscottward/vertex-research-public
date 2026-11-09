"use client";

// What: CommandPalette, the Cmd+K / "/" palette (cmdk in a native dialog): jump to a page or a
// ticker, or run a typed command such as "chart NVDA 1W" or "options AAPL 2026-12-19".
// Used by: apps/web/src/components/portal-shell.tsx (top bar search).
// See: apps/web/src/lib/palette-commands.ts (commands, parsing, groups), tests/e2e/portal-topbar.spec.ts.

import { IconButton } from "@darkfactory/ui";
import { Command } from "cmdk";
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
import {
  type PaletteEntry,
  type PaletteItem,
  paletteGroups,
} from "../lib/palette-commands.ts";

export type { PaletteItem } from "../lib/palette-commands.ts";

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

const ROW =
  "flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-muted-foreground text-sm";

// Mounted fresh on each opening, so it starts with an empty query and the first row selected.
const PaletteBody = ({
  items,
  onGo,
}: {
  readonly items: readonly PaletteItem[];
  readonly onGo: (href: string) => void;
}) => {
  const [query, setQuery] = useState("");
  // cmdk's selected row: an entry id.
  const [selected, setSelected] = useState("");
  const groups = useMemo(() => paletteGroups(items, query), [items, query]);

  const choose = (entry: Exclude<PaletteEntry, { kind: "hint" }>) =>
    entry.kind === "go" ? onGo(entry.href) : setQuery(entry.fill);

  // Tab fills in the selected command template; otherwise Tab keeps its usual meaning.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const entry = groups
      .flatMap((group) => group.entries)
      .find((candidate) => candidate.id === selected);
    if (entry?.kind !== "complete") return;
    event.preventDefault();
    return setQuery(entry.fill);
  };

  return (
    <Command
      label="Search ticker, page or command"
      loop
      onKeyDown={onKeyDown}
      onValueChange={setSelected}
      shouldFilter={false}
      value={selected}
      vimBindings={false}
    >
      <div className="border-border border-b p-3">
        <Command.Input
          // The dialog opened on purpose: its input takes focus.
          autoFocus
          className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onValueChange={setQuery}
          placeholder="Search ticker, page or command"
          value={query}
        />
      </div>
      <Command.List className="max-h-80 overflow-y-auto p-1">
        <Command.Empty className="px-3 py-2 text-muted-foreground text-sm">
          No match. Try: chart NVDA 1D, options AAPL 2026-12-19
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[0.7rem] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
            heading={group.heading}
            key={group.heading}
          >
            {group.entries.map((entry) =>
              entry.kind === "hint" ? (
                <Command.Item
                  className={`${ROW} cursor-default`}
                  disabled
                  key={entry.id}
                  value={entry.id}
                >
                  {entry.label}
                </Command.Item>
              ) : (
                <Command.Item
                  className={`${ROW} cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-foreground`}
                  data-href={entry.kind === "go" ? entry.href : undefined}
                  key={entry.id}
                  onSelect={() => choose(entry)}
                  value={entry.id}
                >
                  <span className="truncate font-medium text-foreground">
                    {entry.label}
                  </span>
                  <span className="shrink-0 truncate font-mono text-xs">
                    {entry.kind === "go" ? entry.detail : entry.hint}
                  </span>
                </Command.Item>
              )
            )}
          </Command.Group>
        ))}
      </Command.List>
      <div
        aria-hidden="true"
        className="flex gap-4 border-border border-t px-3 py-2 text-muted-foreground text-xs"
      >
        <span>↵ open</span>
        <span>Tab complete</span>
        <span>Esc close</span>
      </div>
    </Command>
  );
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
  const [isOpen, setIsOpen] = useState(false);
  // Bumped on every opening: a fresh PaletteBody even when the dialog closed without "close".
  const [openings, setOpenings] = useState(0);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog === null || dialog.open) return;
    setIsOpen(true);
    setOpenings((count) => count + 1);
    return dialog.showModal();
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    return dialogRef.current?.close();
  }, []);

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

  const go = (href: string) => {
    close();
    return navigate(href);
  };

  return (
    <>
      {trigger === "search" ? (
        <>
          {/* The visible label names the button; an aria-label would leave the
              visible shortcut out of the name (WCAG 2.5.3 label in name), and
              aria-keyshortcuts announces the shortcut instead. */}
          <button
            aria-keyshortcuts="Control+K Meta+K /"
            className="hidden min-h-11 w-full max-w-sm items-center gap-2 rounded-md border border-border bg-background px-3 text-muted-foreground text-sm shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:flex"
            data-slot="portal-search"
            onClick={open}
            type="button"
          >
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              Search ticker or page
            </span>
            <span aria-hidden="true" className="shrink-0">
              <kbd className="pointer-events-none rounded border border-border bg-muted px-1.5 font-mono text-[0.7rem]">
                Ctrl/⌘ K
              </kbd>
            </span>
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
        // Escape closes the native dialog without close(): keep isOpen in step.
        onClose={() => setIsOpen(false)}
        ref={dialogRef}
      >
        {isOpen ? <PaletteBody items={items} key={openings} onGo={go} /> : null}
      </dialog>
    </>
  );
};
