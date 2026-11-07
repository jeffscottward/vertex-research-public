import { describe, expect, it, vi } from "vitest";

import {
  type DailyQuote,
  type DesktopApi,
  DesktopApiError,
  type WatchlistEntry,
} from "./desktop-api.ts";
import { fakeEvery, fakeTray, labels, menuItem } from "./test-fakes.ts";
import {
  createTrayWatchlist,
  rowLabel,
  TRAY_MAX_ROWS,
  TRAY_REFRESH_MS,
  trayMenu,
  trayToolTip,
} from "./tray-watchlist.ts";

const entry = (
  symbol: string,
  zone: [string, string] | null = null
): WatchlistEntry => ({
  buyZoneHigh: zone?.[1] ?? null,
  buyZoneLow: zone?.[0] ?? null,
  symbol,
});

const actions = () => ({
  openWorkspace: vi.fn(),
  quit: vi.fn(),
  refresh: vi.fn(),
  sendTestNotification: vi.fn(),
});

const api = (
  overrides: Partial<DesktopApi> = {}
): DesktopApi & Record<string, unknown> => ({
  alertFires: async () => [],
  dailyQuote: async () => null,
  watchlist: async () => [],
  ...overrides,
});

describe("rowLabel", () => {
  it.each<[WatchlistEntry, DailyQuote | null | "pending", string]>([
    [entry("SPY"), "pending", "SPY  …"],
    [entry("SPY"), null, "SPY  —"],
    [entry("SPY"), { last: 101, previousClose: 100 }, "SPY  101.00  +1.00%"],
    [entry("QQQ"), { last: 99, previousClose: 100 }, "QQQ  99.00  -1.00%"],
    [entry("IWM"), { last: 50, previousClose: null }, "IWM  50.00"],
    [entry("DIA"), { last: 50, previousClose: 0 }, "DIA  50.00"],
    [
      entry("AAPL", ["100", "110"]),
      { last: 105, previousClose: 105 },
      "AAPL  105.00  +0.00%  · in buy zone",
    ],
    [
      entry("AAPL", ["100", "110"]),
      { last: 111, previousClose: 110 },
      "AAPL  111.00  +0.91%",
    ],
    [
      entry("AAPL", ["100", "110"]),
      { last: 99, previousClose: 100 },
      "AAPL  99.00  -1.00%",
    ],
    [
      { buyZoneHigh: null, buyZoneLow: "1", symbol: "X" },
      { last: 5, previousClose: null },
      "X  5.00",
    ],
  ])("%j %j → %s", (row, quote, expected) => {
    expect(rowLabel({ entry: row, quote })).toBe(expected);
  });
});

describe("trayMenu", () => {
  it("shows a loading line and the fixed actions", () => {
    const menu = trayMenu({ type: "loading" }, actions());
    expect(labels(menu)).toEqual([
      "Loading watchlist…",
      "---",
      "Open Watchlist",
      "Open workspace",
      "---",
      "Refresh watchlist",
      "Send test notification",
      "---",
      "Quit Vertex",
    ]);
  });

  it("wires the fixed actions", () => {
    const spies = actions();
    const menu = trayMenu({ type: "loading" }, spies);
    menuItem(menu, "Open Watchlist")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenLastCalledWith("watchlist");
    menuItem(menu, "Journal")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenLastCalledWith("journal");
    menuItem(menu, "Refresh watchlist")?.onClick?.();
    expect(spies.refresh).toHaveBeenCalledOnce();
    menuItem(menu, "Send test notification")?.onClick?.();
    expect(spies.sendTestNotification).toHaveBeenCalledOnce();
    menuItem(menu, "Quit Vertex")?.onClick?.();
    expect(spies.quit).toHaveBeenCalledOnce();
    expect(menuItem(menu, "Nothing")).toBeUndefined();
  });

  it("offers sign-in when signed out and says when unavailable", () => {
    const spies = actions();
    const signedOut = trayMenu({ type: "signed-out" }, spies);
    menuItem(signedOut, "Sign in to Vertex to see your watchlist")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenCalledWith("dashboard");
    expect(labels(trayMenu({ type: "unavailable" }, spies))[0]).toBe(
      "Watchlist unavailable; retrying"
    );
    expect(
      labels(trayMenu({ rows: [], total: 0, type: "ready" }, spies))[0]
    ).toBe("No symbols on your watchlist");
  });

  it("lists rows, opens charts for chartable symbols and the watchlist otherwise", () => {
    const spies = actions();
    const menu = trayMenu(
      {
        rows: [
          { entry: entry("SPY"), quote: null },
          { entry: entry("BF-B"), quote: null },
        ],
        total: 20,
        type: "ready",
      },
      spies
    );
    expect(labels(menu).slice(0, 4)).toEqual([
      "Watchlist (20)",
      "SPY  —",
      "BF-B  —",
      "18 more in Watchlist…",
    ]);
    menuItem(menu, "SPY  —")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenLastCalledWith(
      "charts",
      "/charts?symbol=SPY"
    );
    menuItem(menu, "BF-B  —")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenLastCalledWith("watchlist");
    menuItem(menu, "18 more in Watchlist…")?.onClick?.();
    expect(spies.openWorkspace).toHaveBeenLastCalledWith("watchlist");
  });

  it("puts the symbol count in the tooltip", () => {
    expect(trayToolTip({ type: "loading" })).toBe("Vertex");
    expect(trayToolTip({ rows: [], total: 1, type: "ready" })).toBe(
      "Vertex watchlist: 1 symbol"
    );
    expect(trayToolTip({ rows: [], total: 3, type: "ready" })).toBe(
      "Vertex watchlist: 3 symbols"
    );
  });
});

describe("createTrayWatchlist", () => {
  const setup = (desktopApi: DesktopApi, refreshMs?: number) => {
    const tray = fakeTray();
    const timers = fakeEvery();
    const spies = actions();
    const watchlist = createTrayWatchlist({
      actions: spies,
      api: desktopApi,
      every: timers.every,
      tray,
      ...(refreshMs === undefined ? {} : { refreshMs }),
    });
    return { spies, timers, tray, watchlist };
  };

  it("loads the list, then prices rows one at a time, capped at the row limit", async () => {
    const symbols = Array.from({ length: TRAY_MAX_ROWS + 2 }, (_, i) =>
      entry(`S${i}`)
    );
    const priced: string[] = [];
    const { tray, watchlist, timers } = setup(
      api({
        dailyQuote: async (symbol) => {
          priced.push(symbol);
          if (symbol === "S1") throw new DesktopApiError("unavailable");
          return { last: 10, previousClose: 10 };
        },
        watchlist: async () => symbols,
      })
    );
    watchlist.start();
    expect(labels(tray.menu())[0]).toBe("Loading watchlist…");
    expect(timers.scheduled()).toEqual([TRAY_REFRESH_MS]);
    await watchlist.refresh();
    expect(priced).toHaveLength(TRAY_MAX_ROWS);
    const menu = labels(tray.menu());
    expect(menu[1]).toBe("S0  10.00  +0.00%");
    expect(menu[2]).toBe("S1  —");
    expect(menu).toContain("2 more in Watchlist…");
    expect(tray.toolTip()).toBe(
      `Vertex watchlist: ${TRAY_MAX_ROWS + 2} symbols`
    );
    expect(watchlist.state().type).toBe("ready");
  });

  it("refreshes on start, on its timer and from the menu", async () => {
    const watchlistCall = vi.fn(async () => [entry("SPY")]);
    const { spies, timers, tray, watchlist } = setup(
      api({ watchlist: watchlistCall }),
      1000
    );
    watchlist.start();
    watchlist.start();
    expect(timers.scheduled()).toEqual([1000]);
    expect(watchlistCall).toHaveBeenCalledTimes(2);
    timers.tick();
    expect(watchlistCall).toHaveBeenCalledTimes(3);
    menuItem(tray.menu(), "Refresh watchlist")?.onClick?.();
    expect(watchlistCall).toHaveBeenCalledTimes(4);
    expect(spies.refresh).not.toHaveBeenCalled();
    watchlist.stop();
    watchlist.stop();
    expect(timers.scheduled()).toEqual([]);
  });

  it("lets the newest refresh win over a slower older one", async () => {
    const pending: ((entries: WatchlistEntry[]) => void)[] = [];
    const failures: ((error: Error) => void)[] = [];
    let call = 0;
    const { watchlist } = setup(
      api({
        watchlist: () => {
          call += 1;
          return new Promise((resolve, reject) => {
            if (call === 1) failures.push(reject);
            else pending.push(resolve);
          });
        },
      })
    );
    const older = watchlist.refresh();
    const newer = watchlist.refresh();
    pending[0]?.([entry("SPY")]);
    await newer;
    failures[0]?.(new DesktopApiError("signed-out"));
    await older;
    expect(watchlist.state().type).toBe("ready");
  });

  it("stops pricing rows from a superseded refresh", async () => {
    let release: (() => void) | undefined;
    const priced: string[] = [];
    let lists = 0;
    const { watchlist } = setup(
      api({
        dailyQuote: async (symbol) => {
          priced.push(symbol);
          if (symbol === "OLD")
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { last: 1, previousClose: 1 };
        },
        watchlist: async () => {
          lists += 1;
          return lists === 1 ? [entry("OLD"), entry("OLD2")] : [entry("NEW")];
        },
      })
    );
    const older = watchlist.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    await watchlist.refresh();
    release?.();
    await older;
    expect(priced).toEqual(["OLD", "NEW"]);
    expect(watchlist.state()).toMatchObject({ total: 1, type: "ready" });
  });

  it("ignores a superseded list that arrives late", async () => {
    let resolveOld: ((entries: WatchlistEntry[]) => void) | undefined;
    let lists = 0;
    const { watchlist } = setup(
      api({
        watchlist: () => {
          lists += 1;
          if (lists === 1)
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          return Promise.resolve([entry("NEW")]);
        },
      })
    );
    const older = watchlist.refresh();
    await watchlist.refresh();
    resolveOld?.([entry("A"), entry("B")]);
    await older;
    expect(watchlist.state()).toMatchObject({ total: 1, type: "ready" });
  });

  it("shows signed-out and unavailable states", async () => {
    const signedOut = setup(
      api({
        watchlist: async () => {
          throw new DesktopApiError("signed-out");
        },
      })
    );
    await signedOut.watchlist.refresh();
    expect(signedOut.watchlist.state()).toEqual({ type: "signed-out" });
    const broken = setup(
      api({
        watchlist: async () => {
          throw new Error("boom");
        },
      })
    );
    await broken.watchlist.refresh();
    expect(broken.watchlist.state()).toEqual({ type: "unavailable" });
  });
});
