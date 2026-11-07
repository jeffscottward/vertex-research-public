import { describe, expect, it, vi } from "vitest";

import {
  type DesktopPorts,
  MISSING_SITE_MESSAGE,
  startDesktop,
  type WindowFactoryOptions,
} from "./app.ts";
import type { DesktopApi } from "./desktop-api.ts";
import { DesktopApiError } from "./desktop-api.ts";
import type { DesktopNotification, MenuItemModel } from "./ports.ts";
import type { DesktopSettings } from "./settings.ts";
import {
  fakeEvery,
  fakeTray,
  fakeWindowFactory,
  labels,
  memorySettings,
  menuItem,
} from "./test-fakes.ts";

const ORIGIN = "https://vertex.example";

const setup = (
  options: Readonly<{
    env?: Record<string, string>;
    saved?: DesktopSettings;
    api?: Partial<DesktopApi>;
  }> = {}
) => {
  const settings = memorySettings(options.saved);
  const windows = fakeWindowFactory();
  const tray = fakeTray();
  const timers = fakeEvery();
  const shown: DesktopNotification[] = [];
  let factoryOptions: WindowFactoryOptions | undefined;
  let appMenuItems: readonly MenuItemModel[] = [];
  const beforeQuit: (() => void)[] = [];
  const secondInstance: (() => void)[] = [];
  const api: DesktopApi = {
    alertFires: async () => [],
    dailyQuote: async () => null,
    watchlist: async () => [],
    ...options.api,
  };
  const ports: DesktopPorts = {
    api: vi.fn(() => api),
    argv: [],
    createTray: () => tray,
    env: options.env ?? { VERTEX_DESKTOP_URL: `${ORIGIN}/dashboard` },
    every: timers.every,
    fatal: vi.fn(),
    keepRunningWithoutWindows: vi.fn(),
    notify: (notification) => shown.push(notification),
    now: () => new Date("2026-11-06T15:00:00.000Z"),
    onBeforeQuit: (listener) => beforeQuit.push(listener),
    onSecondInstance: (listener) => secondInstance.push(listener),
    quit: vi.fn(),
    setAppMenu: (items) => {
      appMenuItems = items;
    },
    settings,
    windowFactory: (received) => {
      factoryOptions = received;
      return windows.factory;
    },
  };
  const shell = startDesktop(ports);
  return {
    appMenu: () => appMenuItems,
    beforeQuit,
    factoryOptions: () => {
      if (factoryOptions === undefined) throw new Error("no factory");
      return factoryOptions;
    },
    ports,
    secondInstance,
    settings,
    shell,
    shown,
    timers,
    tray,
    windows: windows.windows,
  };
};

describe("startDesktop", () => {
  it("stops with a message when no site is configured", () => {
    const { ports, shell, windows } = setup({ env: {} });
    expect(shell).toBeNull();
    expect(ports.fatal).toHaveBeenCalledWith(MISSING_SITE_MESSAGE);
    expect(ports.quit).toHaveBeenCalledOnce();
    expect(windows).toHaveLength(0);
  });

  it("saves the site, restores windows and starts the tray and notifier", () => {
    const {
      appMenu,
      factoryOptions,
      ports,
      settings,
      shell,
      timers,
      tray,
      windows,
    } = setup();
    expect(shell?.siteOrigin).toBe(ORIGIN);
    expect(settings.current().siteUrl).toBe(ORIGIN);
    expect(ports.api).toHaveBeenCalledWith(ORIGIN);
    expect(factoryOptions().siteOrigin).toBe(ORIGIN);
    expect(windows.map((w) => w.loaded[0])).toEqual([`${ORIGIN}/dashboard`]);
    expect(labels(tray.menu())[0]).toBe("Loading watchlist…");
    expect(timers.scheduled()).toHaveLength(2);
    expect(labels(appMenu())).toContain("Workspaces");
    expect(ports.keepRunningWithoutWindows).toHaveBeenCalledOnce();
  });

  it("uses the saved site when no flag or environment is set", () => {
    const { shell } = setup({
      env: {},
      saved: { bounds: {}, openWorkspaces: [], siteUrl: ORIGIN },
    });
    expect(shell?.siteOrigin).toBe(ORIGIN);
  });

  it("opens workspaces from the app menu and quits from it", () => {
    const { appMenu, ports, shell } = setup();
    menuItem(appMenu(), "Journal")?.onClick?.();
    expect(shell?.windows.openWorkspaces()).toEqual(["dashboard", "journal"]);
    menuItem(appMenu(), "Quit Vertex")?.onClick?.();
    expect(ports.quit).toHaveBeenCalledOnce();
  });

  it("routes same-site new-window links to their workspace window", () => {
    const { factoryOptions, windows } = setup();
    expect(factoryOptions().openInside(`${ORIGIN}/charts?symbol=SPY#x`)).toBe(
      true
    );
    expect(windows[1]?.loaded).toEqual([`${ORIGIN}/charts?symbol=SPY#x`]);
    expect(factoryOptions().openInside(`${ORIGIN}/settings/account`)).toBe(
      false
    );
  });

  it("refreshes the tray after a navigation until the watchlist loads", async () => {
    let signedIn = false;
    const watchlist = vi.fn(async () => {
      if (!signedIn) throw new DesktopApiError("signed-out");
      return [{ buyZoneHigh: null, buyZoneLow: null, symbol: "SPY" }];
    });
    const { factoryOptions, shell } = setup({ api: { watchlist } });
    await shell?.tray.refresh();
    expect(shell?.tray.state().type).toBe("signed-out");
    signedIn = true;
    factoryOptions().onNavigated();
    await shell?.tray.refresh();
    expect(shell?.tray.state().type).toBe("ready");
    const calls = watchlist.mock.calls.length;
    factoryOptions().onNavigated();
    expect(watchlist.mock.calls.length).toBe(calls);
  });

  it("sends the tray's test notification and opens charts from a row", async () => {
    const { shell, shown, tray, windows } = setup({
      api: {
        watchlist: async () => [
          { buyZoneHigh: null, buyZoneLow: null, symbol: "QQQ" },
        ],
      },
    });
    menuItem(tray.menu(), "Send test notification")?.onClick?.();
    expect(shown[0]?.title).toBe("Vertex test notification");
    await shell?.tray.refresh();
    menuItem(tray.menu(), "QQQ  —")?.onClick?.();
    expect(windows.at(-1)?.loaded).toEqual([`${ORIGIN}/charts?symbol=QQQ`]);
    shown[0]?.onClick?.();
    expect(shell?.windows.openWorkspaces()).toContain("price-alerts");
    menuItem(tray.menu(), "Quit Vertex")?.onClick?.();
  });

  it("stops timers and keeps the open list when quitting", () => {
    const { beforeQuit, settings, timers, windows } = setup();
    for (const listener of beforeQuit) listener();
    expect(timers.scheduled()).toEqual([]);
    windows[0]?.close();
    expect(settings.current().openWorkspaces).toEqual(["dashboard"]);
  });

  it("focuses an open window on a second launch, or opens the dashboard", () => {
    const { secondInstance, windows } = setup();
    for (const listener of secondInstance) listener();
    expect(windows[0]?.focusCount).toBe(2);
    windows[0]?.close();
    for (const listener of secondInstance) listener();
    expect(windows).toHaveLength(2);
    expect(windows[1]?.request.workspaceId).toBe("dashboard");
  });
});
