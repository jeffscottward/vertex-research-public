// @vitest-environment jsdom
import type {
  MarketBarsInput,
  MarketBarsOutput,
  PortfolioMonitorOutput,
  WatchlistItemOutput,
} from "@darkfactory/api";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { labBarsOutput } from "../../lab/fixtures/market.ts";
import type { MarketDataGateway } from "./market-data-client.ts";
import type { PortfolioMonitorGateway } from "./portfolio-monitor-client.ts";
import type { JournalSource } from "./trade-journal-client.ts";
import {
  fixturePosition,
  fixtureSnapshot,
} from "./portfolio-monitor-fixture.ts";
import type { WatchlistGateway } from "./watchlist-client.ts";
import { WatchlistWorkspace } from "./watchlist-workspace.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
// Promise.withResolvers is not in this package's TypeScript lib yet.
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const at = new Date("2026-01-02T03:04:05.000Z");
const item = (
  symbol: string,
  overrides: Partial<WatchlistItemOutput> = {}
): WatchlistItemOutput => ({
  buyZoneHigh: null,
  buyZoneLow: null,
  createdAt: at,
  id: `id-${symbol}`,
  note: null,
  symbol,
  updatedAt: at,
  ...overrides,
});

const DAY = 86_400;
/** Closes that move by amplitude * sin(day): same sign of amplitude => correlation +1. */
const wave = (amplitude: number, days = 30): number[] => {
  let price = 100;
  return Array.from({ length: days }, (_, i) => {
    price *= 1 + amplitude * Math.sin(i + 1);
    return price;
  });
};
const barsOutput = (
  input: MarketBarsInput,
  closes: readonly number[]
): MarketBarsOutput => ({
  ...labBarsOutput(input),
  bars: closes.map((c, i) => ({ c, h: c, l: c, o: c, t: (i + 1) * DAY, v: 1 })),
  count: closes.length,
});

const listGateway = (
  list: () => Promise<WatchlistItemOutput[]>
): WatchlistGateway => ({
  add: vi.fn(),
  list: vi.fn(list),
  remove: vi.fn(),
  update: vi.fn(),
});

type Props = Readonly<{
  gateway: WatchlistGateway;
  marketData: MarketDataGateway;
  portfolio?: PortfolioMonitorGateway;
  portfolioSource?: JournalSource;
  strict?: boolean;
  operator?: boolean;
}>;

const mount = async ({ strict = false, operator = true, ...props }: Props) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const tree = <WatchlistWorkspace operator={operator} {...props} />;
  await act(async () => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    await flush();
  });
  return root;
};

const tab = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((node) => node.textContent === name);
  if (found === undefined) throw new Error(`Missing tab ${name}`);
  return found;
};
const panel = (name: string): HTMLElement =>
  document.getElementById(
    tab(name).getAttribute("aria-controls") ?? ""
  ) as HTMLElement;
const open = async (name: string) =>
  act(async () => {
    tab(name).click();
    await flush();
  });
const press = async (key: string) =>
  act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
    );
    await flush();
  });
const click = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
  );
  if (button === undefined) throw new Error(`Missing button ${label}`);
  await act(async () => {
    button.click();
    await flush();
  });
};
const cell = (row: string, column: string) =>
  document.querySelector<HTMLElement>(`[data-cell="${row}:${column}"]`);
const status = (symbol: string, label: string) =>
  document.querySelector<HTMLElement>(
    `[aria-label="${label}"] [data-symbol="${symbol}"]`
  );

describe("watchlist tabs", () => {
  it("switches tabs by click and keyboard and fetches only when a tab opens", async () => {
    const gateway = listGateway(async () => [
      item("AAA", { buyZoneHigh: "12", buyZoneLow: "10", note: "Leader" }),
      item("bf-b", { buyZoneHigh: "20", note: "  " }),
      item("CCC", { buyZoneLow: "5" }),
      item("DDD"),
    ]);
    const marketData: MarketDataGateway = {
      bars: vi.fn(async (input) => barsOutput(input, wave(0.01))),
    };
    const portfolio: PortfolioMonitorGateway = {
      snapshot: vi.fn(async () =>
        fixtureSnapshot({ positions: [fixturePosition({ symbol: "AAA" })] })
      ),
    };
    await mount({ gateway, marketData, portfolio });

    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Watchlist views");
    expect(
      [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
    ).toEqual(["Overview", "Relationships", "Research", "Exposure"]);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(tab("Overview").tabIndex).toBe(0);
    expect(tab("Research").tabIndex).toBe(-1);
    expect(panel("Overview").hidden).toBe(false);
    expect(panel("Overview").getAttribute("aria-labelledby")).toBe(
      tab("Overview").id
    );
    expect(panel("Research").hidden).toBe(true);
    expect(panel("Research").childElementCount).toBe(0);

    await open("Research");
    expect(tab("Research").getAttribute("aria-selected")).toBe("true");
    expect(panel("Overview").hidden).toBe(true);
    // The overview stays mounted while hidden.
    expect(
      panel("Overview").querySelector('tr[data-symbol="AAA"]')
    ).not.toBeNull();
    const cards = panel("Research").querySelectorAll("li[data-symbol]");
    expect([...cards].map((card) => card.getAttribute("data-symbol"))).toEqual([
      "AAA",
      "BF-B",
      "CCC",
      "DDD",
    ]);
    const text = (symbol: string) =>
      panel("Research").querySelector(`li[data-symbol="${symbol}"] dl`)
        ?.textContent;
    expect(text("AAA")).toBe("Buy zone10 – 12NoteLeader");
    expect(text("BF-B")).toBe("Buy zone— – 20NoteNo note");
    expect(text("CCC")).toBe("Buy zone5 – —NoteNo note");
    expect(text("DDD")).toBe("Buy zoneNot setNoteNo note");
    const links = [
      ...panel("Research").querySelectorAll<HTMLAnchorElement>(
        'li[data-symbol="BF-B"] a'
      ),
    ].map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]);
    expect(links).toEqual([
      ["BF-B stock page", "/stock/BF-B"],
      ["BF-B chart", "/charts?symbol=BF-B"],
      ["Market news (for BF-B)", "/news"],
    ]);
    expect(marketData.bars).not.toHaveBeenCalled();
    expect(portfolio.snapshot).not.toHaveBeenCalled();

    tab("Research").focus();
    await press("ArrowRight");
    expect(tab("Exposure").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Exposure"));
    expect(portfolio.snapshot).toHaveBeenCalledTimes(1);
    expect(marketData.bars).toHaveBeenCalledTimes(4);
    expect(vi.mocked(marketData.bars).mock.calls[1]?.[0]).toEqual({
      barSize: "1 day",
      currency: "USD",
      duration: "1 Y",
      exchange: "SMART",
      secType: "STK",
      symbol: "BF.B",
      useRTH: true,
      whatToShow: "TRADES",
    });
    await press("ArrowRight");
    expect(document.activeElement).toBe(tab("Overview"));
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tab("Exposure"));
    await press("Home");
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    await press("End");
    expect(tab("Exposure").getAttribute("aria-selected")).toBe("true");
    await press("a");
    expect(tab("Exposure").getAttribute("aria-selected")).toBe("true");

    expect(panel("Exposure").querySelectorAll("tr[data-arc]")).toHaveLength(1);
    expect(panel("Exposure").textContent).not.toContain("left out");
    await open("Relationships");
    // Bars are shared with Exposure: no second request.
    expect(marketData.bars).toHaveBeenCalledTimes(4);
    await open("Exposure");
    expect(portfolio.snapshot).toHaveBeenCalledTimes(1);
  });

  it("explains the analysis tabs while the list loads, fails or is empty", async () => {
    const pending = deferred<WatchlistItemOutput[]>();
    const marketData: MarketDataGateway = { bars: vi.fn() };
    const portfolio: PortfolioMonitorGateway = { snapshot: vi.fn() };
    await mount({
      gateway: listGateway(() => pending.promise),
      marketData,
      portfolio,
    });
    await open("Research");
    expect(panel("Research").textContent).toBe("Loading watchlist…");
    await act(async () => {
      pending.resolve([]);
      await flush();
    });
    expect(panel("Research").textContent).toBe(
      "No symbols. Add tickers on the Overview tab."
    );
    await open("Relationships");
    expect(marketData.bars).not.toHaveBeenCalled();
    for (const root of roots.splice(0)) await act(async () => root.unmount());

    await mount({
      gateway: listGateway(() => Promise.reject({ code: "STORAGE_ERROR" })),
      marketData,
      portfolio,
    });
    await open("Exposure");
    expect(panel("Exposure").textContent).toBe(
      "Watchlist storage unavailable (503). Retry from the Overview tab."
    );
    expect(portfolio.snapshot).not.toHaveBeenCalled();
  });

  it("reads Exposure positions from the configured journal source by default", async () => {
    const fetchMock = vi.fn(async (_request: Request) => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mount({
        gateway: listGateway(async () => [item("AAA")]),
        marketData: {
          bars: vi.fn(async (input) => barsOutput(input, wave(0.01))),
        },
        portfolioSource: "ibkr-monitor",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      await open("Exposure");
      expect(fetchMock.mock.calls.at(0)?.[0].url).toContain(
        "/ibkrMonitor/snapshot"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("non-operator watchlist", () =>
  it("shows one operator-access message on the analysis tabs and sends no bars or snapshot requests", async () => {
    const gateway = listGateway(async () => [item("AAA"), item("BBB")]);
    const marketData: MarketDataGateway = {
      bars: vi.fn(async (input) => barsOutput(input, wave(0.01))),
    };
    const portfolio: PortfolioMonitorGateway = {
      snapshot: vi.fn(async () => fixtureSnapshot({ positions: [] })),
    };
    await mount({ gateway, marketData, operator: false, portfolio });
    await open("Relationships");
    expect(
      panel("Relationships").querySelectorAll(
        '[data-operator-access="required"]'
      )
    ).toHaveLength(1);
    await open("Exposure");
    expect(
      panel("Exposure").querySelectorAll('[data-operator-access="required"]')
    ).toHaveLength(1);
    expect(marketData.bars).not.toHaveBeenCalled();
    return expect(portfolio.snapshot).not.toHaveBeenCalled();
  }));

describe("relationships tab", () => {
  it("fills the matrix as bars arrive, shows failures and retries a symbol", async () => {
    const calls = new Map<string, Deferred<MarketBarsOutput>[]>();
    const marketData: MarketDataGateway = {
      bars: vi.fn((input) => {
        const next = deferred<MarketBarsOutput>();
        calls.set(input.symbol, [...(calls.get(input.symbol) ?? []), next]);
        return next.promise;
      }),
    };
    const settle = async (symbol: string, closes: readonly number[] | Error) =>
      act(async () => {
        const input = vi
          .mocked(marketData.bars)
          .mock.calls.find(
            ([call]) => call.symbol === symbol
          )?.[0] as MarketBarsInput;
        const call = calls.get(symbol)?.at(-1);
        if (closes instanceof Error) call?.reject(closes);
        else call?.resolve(barsOutput(input, closes));
        await flush();
      });
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    await mount({
      gateway: listGateway(async () => symbols.map((symbol) => item(symbol))),
      marketData,
      portfolio: { snapshot: vi.fn() },
      strict: true,
    });
    await open("Relationships");
    // One request at a time: the history service serialises and paces IBKR itself.
    expect(marketData.bars).toHaveBeenCalledTimes(1);
    const label = "Daily bars by symbol";
    expect(status("AAA", label)?.textContent).toBe("AAALoading bars…");
    expect(panel("Relationships").textContent).toContain(
      "Waiting for daily bars of at least two symbols…"
    );

    await settle("AAA", wave(0.01));
    await settle("BBB", wave(0.02));
    expect(status("AAA", label)?.textContent).toBe("AAA30 days");
    expect(cell("AAA", "BBB")?.textContent).toBe("1.00");
    expect(cell("AAA", "BBB")?.title).toBe("AAA / BBB: 1.00 over 29 days");
    expect(cell("AAA", "BBB")?.style.backgroundColor).toContain("--color-info");
    expect(
      panel("Relationships").querySelector("caption")?.textContent
    ).toContain("partial");

    await settle("CCC", Object.assign(new Error("Pacing"), { code: "PACED" }));
    expect(status("CCC", label)?.textContent).toContain(
      "Failed (PACED): Pacing"
    );
    expect(marketData.bars).toHaveBeenCalledTimes(4);
    await settle("DDD", wave(-0.01));
    await settle("EEE", wave(0.01, 10));
    expect(cell("AAA", "DDD")?.textContent).toBe("-1.00");
    expect(cell("AAA", "EEE")?.textContent).toBe("—");
    expect(cell("AAA", "EEE")?.title).toBe(
      "AAA / EEE: 9 shared days (needs 20 with movement)"
    );

    await click("Retry CCC bars");
    expect(status("CCC", label)?.textContent).toBe("CCCLoading bars…");
    await settle("CCC", wave(0.03));
    expect(cell("CCC", "AAA")?.textContent).toBe("1.00");
    expect(panel("Relationships").querySelector("caption")?.textContent).toBe(
      "Correlation of daily returns between watchlist symbols"
    );
  });

  it("sends no queued bars requests after the page unmounts", async () => {
    const pending = deferred<MarketBarsOutput>();
    const marketData: MarketDataGateway = {
      bars: vi.fn(() => pending.promise),
    };
    const root = await mount({
      gateway: listGateway(async () =>
        ["AAA", "BBB", "CCC"].map((s) => item(s))
      ),
      marketData,
      portfolio: { snapshot: vi.fn() },
    });
    await open("Relationships");
    expect(marketData.bars).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await act(async () => {
      pending.reject(new Error("gone"));
      await flush();
    });
    return expect(marketData.bars).toHaveBeenCalledTimes(1);
  });

  it("does not show withheld positions as an empty portfolio", async () => {
    await mount({
      gateway: listGateway(async () => [item("SA"), item("SB")]),
      marketData: { bars: vi.fn(async () => Promise.reject(new Error("x"))) },
      portfolio: {
        snapshot: vi.fn(async () =>
          fixtureSnapshot({
            positions: [],
            status: { connected: false, gateway: "disconnected" },
          })
        ),
      },
    });
    await open("Exposure");
    expect(panel("Exposure").textContent).toContain(
      "The IBKR gateway is disconnected, so account data is withheld until it reconnects."
    );
    expect(panel("Exposure").textContent).not.toContain(
      "No positions with a market value"
    );
  });

  it("caps the analysis to twelve symbols and needs two with bars", async () => {
    const symbols = Array.from(
      { length: 13 },
      (_, i) => `S${String.fromCharCode(65 + i)}`
    );
    const marketData: MarketDataGateway = {
      bars: vi.fn(async (input) => {
        if (input.symbol === "SA") return barsOutput(input, wave(0.01));
        throw new Error("no data");
      }),
    };
    await mount({
      gateway: listGateway(async () => symbols.map((symbol) => item(symbol))),
      marketData,
      portfolio: {
        snapshot: vi.fn(async () => fixtureSnapshot({ positions: [] })),
      },
    });
    await open("Relationships");
    expect(marketData.bars).toHaveBeenCalledTimes(12);
    expect(panel("Relationships").textContent).toContain(
      "first 12 of 13 symbols"
    );
    expect(panel("Relationships").textContent).toContain(
      "Needs daily bars for at least two symbols."
    );
    expect(status("SB", "Daily bars by symbol")?.textContent).toContain(
      "Failed (ERROR): no data"
    );
    await open("Exposure");
    expect(panel("Exposure").textContent).toContain("first 12 of 13 symbols");
    expect(panel("Exposure").textContent).toContain(
      "No positions with a market value."
    );
  });
});

describe("exposure tab", () => {
  const snapshot = (positions: PortfolioMonitorOutput["positions"]) =>
    fixtureSnapshot({ positions });

  it("draws the sunburst with watchlist symbols marked and the return/drawdown scatter", async () => {
    const marketData: MarketDataGateway = {
      bars: vi.fn(async (input) =>
        barsOutput(input, input.symbol === "BBB" ? [100] : [100, 120, 90, 110])
      ),
    };
    await mount({
      gateway: listGateway(async () => [item("AAA"), item("BBB")]),
      marketData,
      portfolio: {
        snapshot: vi.fn(async () =>
          snapshot([
            fixturePosition({
              marketValue: 6000,
              secType: "STK",
              symbol: "AAA",
            }),
            fixturePosition({
              id: "2",
              marketValue: -2000,
              secType: "STK",
              symbol: "XYZ",
            }),
            fixturePosition({
              id: "3",
              marketValue: 2000,
              secType: "OPT",
              symbol: "AAA",
            }),
            fixturePosition({
              id: "4",
              marketValue: null,
              secType: "STK",
              symbol: "NUL",
            }),
          ])
        ),
      },
    });
    await open("Exposure");
    const sunburst = panel("Exposure").querySelector('svg[role="img"]');
    expect(sunburst?.getAttribute("aria-label")).toBe(
      "Portfolio by security type and symbol: 3 symbols, 2 on the watchlist"
    );
    const titles = [...(sunburst?.querySelectorAll("path > title") ?? [])].map(
      (t) => t.textContent
    );
    expect(titles).toEqual([
      "STK: 8,000 gross, +80.0%",
      "OPT: 2,000 gross, +20.0%",
      "AAA (STK): 6,000 gross, +60.0%, on watchlist",
      "XYZ (STK): 2,000 gross, +20.0%, net short",
      "AAA (OPT): 2,000 gross, +20.0%, on watchlist",
    ]);
    expect(sunburst?.querySelectorAll('[data-watchlist="true"]')).toHaveLength(
      2
    );
    const rows = [...panel("Exposure").querySelectorAll("tr[data-arc]")].map(
      (row) => [...row.children].map((c) => c.textContent)
    );
    expect(rows).toEqual([
      ["STK", "AAA", "6,000", "+60.0%", "On watchlist"],
      ["STK", "XYZshort", "2,000", "+20.0%", "—"],
      ["OPT", "AAA", "2,000", "+20.0%", "On watchlist"],
    ]);
    expect(panel("Exposure").textContent).toContain(
      "1 position without a market value left out."
    );

    const scatter = panel("Exposure").querySelector('[data-point="AAA"] title');
    expect(scatter?.textContent).toBe(
      "AAA: return +10.0%, max drawdown -25.0%"
    );
    expect(panel("Exposure").querySelector('[data-point="BBB"]')).toBeNull();
    const scatterRow = panel("Exposure").querySelector('tr[data-symbol="AAA"]');
    expect([...(scatterRow?.children ?? [])].map((c) => c.textContent)).toEqual(
      ["AAA", "+10.0%", "-25.0%", "4"]
    );
  });

  it("shows empty, forbidden and failed positions and retries", async () => {
    const snapshots = [
      Promise.reject({ code: "FORBIDDEN" }),
      Promise.reject({ code: "UNAVAILABLE", message: "Gateway down" }),
      Promise.resolve(
        snapshot([
          fixturePosition({ marketValue: 0 }),
          fixturePosition({ id: "2", marketValue: null }),
        ])
      ),
    ];
    for (const pending of snapshots) pending.catch(() => undefined);
    const portfolio: PortfolioMonitorGateway = {
      snapshot: vi.fn(
        () => snapshots.shift() as Promise<PortfolioMonitorOutput>
      ),
    };
    await mount({
      gateway: listGateway(async () => [item("AAA")]),
      marketData: { bars: vi.fn(() => Promise.reject(new Error("down"))) },
      portfolio,
    });
    await open("Exposure");
    const alert = () =>
      panel("Exposure").querySelector('[role="alert"]')?.textContent;
    expect(alert()).toBe("Positions need operator access.Retry positions");
    await click("Retry positions");
    expect(alert()).toBe(
      "Positions unavailable (UNAVAILABLE): Gateway downRetry positions"
    );
    await click("Retry positions");
    expect(panel("Exposure").textContent).toContain(
      "No positions with a market value (2 without one)."
    );
    expect(panel("Exposure").textContent).toContain(
      "No symbol has enough daily bars yet."
    );
  });

  it("lists plural skipped positions and ignores replies after unmount", async () => {
    const reply = deferred<PortfolioMonitorOutput>();
    const bars = deferred<MarketBarsOutput>();
    const root = await mount({
      gateway: listGateway(async () => [item("AAA")]),
      marketData: { bars: vi.fn(() => bars.promise) },
      portfolio: { snapshot: vi.fn(() => reply.promise) },
    });
    await open("Exposure");
    expect(panel("Exposure").textContent).toContain("Loading positions…");
    await act(async () => root.unmount());
    roots.splice(0);
    await act(async () => {
      reply.resolve(snapshot([]));
      bars.resolve(barsOutput({ symbol: "AAA" }, [1, 2]));
      await flush();
    });

    await mount({
      gateway: listGateway(async () => [item("AAA")]),
      marketData: { bars: vi.fn(async (input) => barsOutput(input, [1, 2])) },
      portfolio: {
        snapshot: vi.fn(async () =>
          snapshot([
            fixturePosition({ marketValue: 100 }),
            fixturePosition({ id: "2", marketValue: null }),
            fixturePosition({ id: "3", marketValue: null }),
          ])
        ),
      },
    });
    await open("Exposure");
    expect(panel("Exposure").textContent).toContain(
      "2 positions without a market value left out."
    );
  });
});
