import { describe, expect, it } from "vitest";

import type { DesktopSettings } from "./settings.ts";
import { fakeWindowFactory, memorySettings } from "./test-fakes.ts";
import { createWindowManager } from "./window-manager.ts";

const ORIGIN = "https://vertex.example";

const setup = (saved?: DesktopSettings) => {
  const settings = memorySettings(saved);
  const { factory, windows } = fakeWindowFactory();
  const manager = createWindowManager({
    createWindow: factory,
    settings,
    siteOrigin: ORIGIN,
  });
  return { manager, settings, windows };
};

describe("createWindowManager", () => {
  it("opens one window per workspace at its home path", () => {
    const { manager, settings, windows } = setup();
    manager.open("charts");
    manager.open("journal");
    expect(windows.map((w) => w.request.title)).toEqual([
      "Vertex · Charts",
      "Vertex · Journal",
    ]);
    expect(windows[0]?.loaded).toEqual([`${ORIGIN}/charts`]);
    expect(windows[0]?.focusCount).toBe(1);
    expect(manager.openWorkspaces()).toEqual(["charts", "journal"]);
    expect(settings.current().openWorkspaces).toEqual(["charts", "journal"]);
  });

  it("focuses an open workspace instead of opening a second window", () => {
    const { manager, windows } = setup();
    manager.open("charts");
    manager.open("charts");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.loaded).toHaveLength(1);
    expect(windows[0]?.focusCount).toBe(2);
    manager.open("charts", "/charts?symbol=QQQ");
    expect(windows[0]?.loaded.at(-1)).toBe(`${ORIGIN}/charts?symbol=QQQ`);
  });

  it("opens a new window at a requested path", () => {
    const { manager, windows } = setup();
    manager.open("charts", "/charts?symbol=SPY");
    expect(windows[0]?.loaded).toEqual([`${ORIGIN}/charts?symbol=SPY`]);
  });

  it("remembers bounds on close and reuses them", () => {
    const { manager, settings, windows } = setup();
    manager.open("news");
    expect(windows[0]?.request.bounds).toBeUndefined();
    windows[0]?.close();
    expect(manager.openWorkspaces()).toEqual([]);
    expect(settings.current().openWorkspaces).toEqual([]);
    expect(settings.current().bounds.news).toEqual({
      height: 700,
      width: 1000,
      x: 5,
      y: 6,
    });
    manager.open("news");
    expect(windows[1]?.request.bounds).toEqual({
      height: 700,
      width: 1000,
      x: 5,
      y: 6,
    });
  });

  it("keeps the open list while quitting so the next start restores it", () => {
    const { manager, settings, windows } = setup();
    manager.open("charts");
    manager.open("watchlist");
    manager.beginQuit();
    for (const window of windows) window.close();
    expect(settings.current().openWorkspaces).toEqual(["charts", "watchlist"]);
    expect(settings.current().bounds.watchlist).toBeDefined();
  });

  it("restores the saved workspaces, or the dashboard when none", () => {
    const first = setup({
      bounds: {},
      openWorkspaces: ["journal", "calendar"],
    });
    first.manager.restore();
    expect(first.manager.openWorkspaces()).toEqual(["journal", "calendar"]);
    const empty = setup();
    empty.manager.restore();
    expect(empty.manager.openWorkspaces()).toEqual(["dashboard"]);
  });
});
