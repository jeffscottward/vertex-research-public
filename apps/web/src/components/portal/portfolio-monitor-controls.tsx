"use client";

import { cn } from "@darkfactory/ui";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// Browser-only preferences (tab, columns, sort, refresh interval). Never account data.
export const readStored = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export const writeStored = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the in-memory value still applies.
    return;
  }
};

// The first render uses the default so server and client markup match.
// The stored value loads in a layout effect (before paint), so there is no visible jump.
// `normalize` must be a stable module function.
export const useStoredState = <T,>(
  key: string,
  normalize: (value: unknown) => T
): readonly [T, (next: T) => void] => {
  const [value, setValue] = useState<T>(() => normalize(undefined));
  useLayoutEffect(() => {
    setValue(normalize(readStored(key)));
    return;
  }, [key, normalize]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      return writeStored(key, next);
    },
    [key]
  );
  return [value, update] as const;
};

export type TabItem<T extends string> = Readonly<{ id: T; label: ReactNode }>;

export interface TabStripProps<T extends string> {
  readonly label: string;
  readonly idPrefix: string;
  readonly tabs: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly className?: string;
}

const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
const panelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

const TAB_CLASS =
  "relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 border-b-2 border-transparent px-2 text-sm font-semibold text-muted-foreground transition-colors duration-base ease-out hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-selected:border-primary aria-selected:text-foreground";

// WAI-ARIA tabs with roving focus: Left/Right/Home/End move the selection.
export const TabStrip = <T extends string>({
  className,
  idPrefix,
  label,
  onChange,
  tabs,
  value,
}: TabStripProps<T>) => {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight"
        ? index >= last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index <= 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const targetTab = target === null ? undefined : tabs[target];
    if (targetTab === undefined) return;
    event.preventDefault();
    const next = targetTab.id;
    onChange(next);
    return refs.current.get(next)?.focus();
  };
  return (
    <div
      aria-label={label}
      className={cn(
        "flex min-h-11 w-full items-end gap-4 overflow-x-auto border-border border-b",
        className
      )}
      onKeyDown={onKeyDown}
      role="tablist"
    >
      {tabs.map((tab) => {
        return (
          <button
            aria-controls={panelId(idPrefix, tab.id)}
            aria-selected={tab.id === value}
            className={TAB_CLASS}
            id={tabId(idPrefix, tab.id)}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            ref={(node) => {
              if (node === null) {
                refs.current.delete(tab.id);
              } else refs.current.set(tab.id, node);
              return;
            }}
            role="tab"
            tabIndex={tab.id === value ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};

export const TabPanel = ({
  children,
  id,
  idPrefix,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly idPrefix: string;
}) => (
  <div
    aria-labelledby={tabId(idPrefix, id)}
    className="pt-4 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    id={panelId(idPrefix, id)}
    role="tabpanel"
    // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanel: the panel is focusable so keyboard users reach its content.
    tabIndex={0}
  >
    {children}
  </div>
);
