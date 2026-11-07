// Test fakes for the desktop ports (imported by *.test.ts only).
import type {
  EveryPort,
  MenuItemModel,
  TrayPort,
  WindowFactory,
  WindowRequest,
  WorkspaceWindow,
} from "./ports.ts";
import {
  DEFAULT_SETTINGS,
  type DesktopSettings,
  type SettingsStore,
  type WindowBounds,
} from "./settings.ts";

export const memorySettings = (
  initial: DesktopSettings = DEFAULT_SETTINGS
): SettingsStore & { current: () => DesktopSettings } => {
  let current = initial;
  return {
    current: () => current,
    load: () => current,
    save: (next) => {
      current = next;
    },
  };
};

export type FakeWindow = WorkspaceWindow & {
  request: WindowRequest;
  loaded: string[];
  focusCount: number;
  close: () => void;
};

export const fakeWindowFactory = (
  bounds: WindowBounds = { height: 700, width: 1000, x: 5, y: 6 }
): { factory: WindowFactory; windows: FakeWindow[] } => {
  const windows: FakeWindow[] = [];
  const factory: WindowFactory = (request) => {
    const listeners: (() => void)[] = [];
    const window: FakeWindow = {
      bounds: () => bounds,
      close: () => {
        for (const listener of listeners.splice(0)) listener();
      },
      focus: () => {
        window.focusCount += 1;
      },
      focusCount: 0,
      load: (url) => {
        window.loaded.push(url);
      },
      loaded: [],
      onClose: (listener) => {
        listeners.push(listener);
      },
      request,
    };
    windows.push(window);
    return window;
  };
  return { factory, windows };
};

export const fakeTray = (): TrayPort & {
  menu: () => readonly MenuItemModel[];
  toolTip: () => string;
} => {
  let menu: readonly MenuItemModel[] = [];
  let toolTip = "";
  return {
    menu: () => menu,
    setMenu: (items) => {
      menu = items;
    },
    setToolTip: (text) => {
      toolTip = text;
    },
    toolTip: () => toolTip,
  };
};

/** Collects scheduled tasks; `tick()` runs them all once. */
export const fakeEvery = (): {
  every: EveryPort;
  tick: () => void;
  scheduled: () => readonly number[];
} => {
  const tasks = new Map<number, { ms: number; task: () => void }>();
  let next = 0;
  return {
    every: (ms, task) => {
      const id = next++;
      tasks.set(id, { ms, task });
      return () => {
        tasks.delete(id);
      };
    },
    scheduled: () => [...tasks.values()].map((entry) => entry.ms),
    tick: () => {
      for (const entry of tasks.values()) entry.task();
    },
  };
};

/** The clickable menu item labelled `label`, searching submenus too. */
export const menuItem = (
  items: readonly MenuItemModel[],
  label: string
): Extract<MenuItemModel, { type: "item" }> | undefined => {
  for (const item of items) {
    if (item.type === "item" && item.label === label) return item;
    if (item.type === "submenu") {
      const found = menuItem(item.items, label);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

export const labels = (items: readonly MenuItemModel[]): string[] =>
  items.map((item) =>
    item.type === "separator"
      ? "---"
      : item.type === "role"
        ? `role:${item.role}`
        : item.label
  );
