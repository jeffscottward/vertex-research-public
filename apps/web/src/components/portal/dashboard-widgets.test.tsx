// @vitest-environment jsdom
import type {
  ApiClient,
  MarketContextOutput,
  PortfolioMonitorOutput,
  WatchlistItemOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  createBrowserDashboardWidgetsGateway,
  createDashboardWidgetsGateway,
  DASHBOARD_WIDGET_READ_TIMEOUT_MS,
  DashboardWidgets,
  type DashboardWidgetsGateway,
} from "./dashboard-widgets.tsx";
import { WIDGETS_STORAGE_KEY } from "./dashboard-widgets-model.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const item = (symbol: string): WatchlistItemOutput =>
  ({ id: `id-${symbol}`, symbol }) as unknown as WatchlistItemOutput;

const context = (
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-06T12:00:00.000Z",
  gex: null,
  macro: {
    asOf: null,
    events: [
      { date: "2026-11-06", name: "Jobs report", time: "08:30 ET" },
      { date: "2026-11-09", name: "Holiday", time: null },
      { date: "2026-11-01", name: "Past", time: null },
    ],
    regimes: [],
    series: [],
  },
  missing: [],
  news: {
    asOf: null,
    headlines: [
      {
        materiality: null,
        publishedAt: "2026-11-06T11:00:00.000Z",
        publisher: "Wire",
        sentiment: null,
        theme: null,
        title: "Fed holds rates",
        url: "https://example.com/fed",
      },
    ],
    themes: [],
  },
  stale: false,
  ...overrides,
});

const snapshot = {
  executions: [
    { commission: 1, execId: "x30", permId: null, realized: 30 },
    { commission: 1, execId: "x-10", permId: null, realized: -10 },
    { commission: 1, execId: "x0", permId: null, realized: 0 },
  ],
  account: { mode: "live", modeError: null },
  status: { gateway: "live", connected: true },
} as unknown as PortfolioMonitorOutput;

const gatewayWith = (
  overrides: Partial<DashboardWidgetsGateway> = {}
): DashboardWidgetsGateway => ({
  journal: vi.fn(async () => snapshot),
  marketContext: vi.fn(async () => context()),
  watchlist: vi.fn(async () =>
    ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map(item)
  ),
  ...overrides,
});

const NOW = () => new Date(2026, 10, 6, 9, 0);

const widget = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-widget="${id}"]`);

const widgetIds = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-widget]")].map((node) =>
    node.getAttribute("data-widget")
  );

const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label || node.textContent === label
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

describe("dashboard widget gateways", () => {
  const fakeClient = () =>
    ({
      ibkrMonitor: { snapshot: vi.fn(async () => snapshot) },
      marketContext: { get: vi.fn(async () => context()) },
      portfolioMonitor: { snapshot: vi.fn(async () => snapshot) },
      watchlist: { list: vi.fn(async () => ({ items: [item("AAA")] })) },
    }) as unknown as ApiClient;

  it("reads the watchlist, market context and the configured snapshot", async () => {
    const client = fakeClient();
    const gateway = createDashboardWidgetsGateway(() => client, "ibkr-monitor");
    await expect(gateway.watchlist()).resolves.toEqual([item("AAA")]);
    await expect(gateway.marketContext()).resolves.toEqual(context());
    await expect(gateway.journal?.()).resolves.toBe(snapshot);
    expect(client.ibkrMonitor.snapshot).toHaveBeenCalledWith({});
    expect(
      createDashboardWidgetsGateway(() => client, null).journal
    ).toBeNull();
  });

  it("creates one browser client on the first request", async () => {
    runtime.client = fakeClient();
    const gateway = createBrowserDashboardWidgetsGateway("portfolio-monitor");
    expect(runtime.origins).toEqual([]);
    await gateway.watchlist();
    await gateway.journal?.();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(runtime.client.portfolioMonitor.snapshot).toHaveBeenCalledWith({});
  });
});

describe("DashboardWidgets", () => {
  it("shows every widget for an operator, with data and links", async () => {
    const container = await render(
      <DashboardWidgets
        gateway={gatewayWith()}
        journalSource="ibkr-monitor"
        now={NOW}
        operator
      />
    );
    expect(container.querySelector("h2")?.textContent).toBe("Widgets");
    expect(widgetIds(container)).toEqual([
      "watchlist",
      "events",
      "journal",
      "market",
    ]);
    const watch = widget(container, "watchlist");
    expect(watch?.textContent).toContain("6symbols");
    expect(watch?.querySelectorAll("li")).toHaveLength(5);
    expect(watch?.querySelector('a[href="/watchlist"]')).not.toBeNull();
    const events = widget(container, "events");
    expect(events?.textContent).toContain("Jobs report2026-11-06 08:30 ET");
    expect(events?.textContent).toContain("Holiday2026-11-09");
    expect(events?.textContent).not.toContain("Past");
    const journal = widget(container, "journal");
    expect(journal?.textContent).toContain("Fills3");
    expect(journal?.textContent).toContain("+$20.00");
    expect(journal?.textContent).toContain("50%");
    expect(journal?.querySelector('a[href="/journal"]')).not.toBeNull();
    const market = widget(container, "market");
    expect(market?.textContent).toContain("Fed holds rates · Wire");
    expect(
      market?.querySelector('a[href="https://example.com/fed"]')
    ).not.toBeNull();
    expect(market?.textContent).not.toContain("Stale");
  });

  it("shows loading lines while requests are pending", async () => {
    const pending = () => new Promise<never>(() => undefined);
    const container = await render(
      <DashboardWidgets
        gateway={gatewayWith({
          journal: pending,
          marketContext: pending,
          watchlist: pending,
        })}
        journalSource="ibkr-monitor"
        now={NOW}
        operator
      />
    );
    expect(widget(container, "watchlist")?.textContent).toContain("Loading…");
    expect(widget(container, "journal")?.textContent).toContain("Loading…");
  });

  it("reads one widget at a time: watchlist, then market context, then the journal", async () => {
    let finishWatchlist: (items: WatchlistItemOutput[]) => void = () =>
      undefined;
    let finishContext: (value: MarketContextOutput) => void = () => undefined;
    const gateway = gatewayWith({
      marketContext: vi.fn(
        () =>
          new Promise<MarketContextOutput>((resolve) => {
            finishContext = resolve;
          })
      ),
      watchlist: vi.fn(
        () =>
          new Promise<WatchlistItemOutput[]>((resolve) => {
            finishWatchlist = resolve;
          })
      ),
    });
    const container = await render(
      <DashboardWidgets
        gateway={gateway}
        journalSource="ibkr-monitor"
        now={NOW}
        operator
      />
    );
    expect(gateway.watchlist).toHaveBeenCalledTimes(1);
    expect(gateway.marketContext).not.toHaveBeenCalled();
    expect(gateway.journal).not.toHaveBeenCalled();
    // A waiting journal read shows as loading, not as "not configured".
    expect(widget(container, "journal")?.textContent).toContain("Loading…");
    await act(async () => finishWatchlist([item("AAA")]));
    expect(gateway.marketContext).toHaveBeenCalledTimes(1);
    expect(gateway.journal).not.toHaveBeenCalled();
    await act(async () => finishContext(context()));
    expect(gateway.journal).toHaveBeenCalledTimes(1);
  });

  it("moves on to the next widget when a read never answers", async () => {
    vi.useFakeTimers();
    try {
      const gateway = gatewayWith({
        watchlist: vi.fn(() => new Promise<never>(() => undefined)),
      });
      const container = await render(
        <DashboardWidgets
          gateway={gateway}
          journalSource="ibkr-monitor"
          now={NOW}
          operator
        />
      );
      expect(gateway.marketContext).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DASHBOARD_WIDGET_READ_TIMEOUT_MS);
      });
      expect(widget(container, "watchlist")?.textContent).not.toContain(
        "Loading…"
      );
      expect(gateway.marketContext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers empty, sparse and failing data", async () => {
    const container = await render(
      <DashboardWidgets
        gateway={gatewayWith({
          journal: async () => Promise.reject({ code: "FORBIDDEN" }),
          marketContext: async () =>
            context({
              gex: {
                asOf: null,
                index: [],
                label: "Dampened",
                oiSession: null,
              },
              macro: null,
              news: null,
              stale: true,
            }),
          watchlist: async () => [],
        })}
        journalSource="ibkr-monitor"
        operator
      />
    );
    expect(widget(container, "watchlist")?.textContent).toContain(
      "No symbols yet."
    );
    expect(widget(container, "events")?.textContent).toContain(
      "Macro data was missing"
    );
    expect(widget(container, "journal")?.textContent).toContain(
      "Operator access required."
    );
    const market = widget(container, "market");
    expect(market?.textContent).toContain("Stale");
    expect(market?.querySelector('[data-headline="gex"]')?.textContent).toBe(
      "Dampened"
    );
  });

  it("covers one symbol, no upcoming events, no headline and upstream failures", async () => {
    const container = await render(
      <DashboardWidgets
        gateway={gatewayWith({
          journal: async () =>
            Promise.reject({ code: "UNAVAILABLE", message: "gateway down" }),
          marketContext: async () =>
            context({
              macro: { asOf: null, events: [], regimes: [], series: [] },
              news: {
                asOf: null,
                headlines: [
                  {
                    materiality: null,
                    publishedAt: "2026-11-06T11:00:00.000Z",
                    publisher: null,
                    sentiment: null,
                    theme: null,
                    title: "No publisher",
                    url: "https://example.com/x",
                  },
                ],
                themes: [],
              },
            }),
          watchlist: async () => [item("AAA")],
        })}
        journalSource="portfolio-monitor"
        now={NOW}
        operator
      />
    );
    expect(widget(container, "watchlist")?.textContent).toContain("1symbol");
    expect(widget(container, "events")?.textContent).toContain(
      "No upcoming events listed."
    );
    expect(widget(container, "journal")?.textContent).toContain(
      "Unavailable (UNAVAILABLE): gateway down"
    );
    expect(widget(container, "market")?.textContent).toContain("No publisher");
    expect(widget(container, "market")?.textContent).not.toContain("·");

    const failing = await render(
      <DashboardWidgets
        gateway={gatewayWith({
          marketContext: async () => context({ news: null }),
          watchlist: async () => Promise.reject({ code: "UNAUTHORIZED" }),
        })}
        journalSource={null}
        operator
      />
    );
    expect(widget(failing, "watchlist")?.textContent).toContain(
      "Session expired"
    );
    expect(widget(failing, "market")?.textContent).toContain(
      "No headline in the last rig push."
    );
  });

  it("does not show withheld fills as zero fills", async () => {
    for (const [withheld, reason] of [
      [
        { account: { mode: null, modeError: "mismatch" } },
        "does not match its configured mode",
      ],
      [
        { status: { gateway: "disconnected", connected: false } },
        "gateway has been disconnected",
      ],
      [
        { status: { gateway: "starting", connected: false } },
        "gateway has been connecting",
      ],
    ] as const) {
      const container = await render(
        <DashboardWidgets
          gateway={gatewayWith({
            journal: vi.fn(
              async () =>
                ({
                  ...snapshot,
                  executions: [],
                  ...withheld,
                }) as unknown as PortfolioMonitorOutput
            ),
          })}
          journalSource="ibkr-monitor"
          now={NOW}
          operator
        />
      );
      const journal = widget(container, "journal")?.textContent ?? "";
      expect(journal).toContain(reason);
      expect(journal).not.toContain("Fills0");
    }
  });

  it("says not configured and sends nothing without a snapshot service", async () => {
    const gateway = gatewayWith({ journal: null });
    const container = await render(
      <DashboardWidgets gateway={gateway} journalSource={null} operator />
    );
    expect(widget(container, "journal")?.textContent).toContain(
      "Not configured"
    );
  });

  it("gives a non-operator only the watchlist and sends no operator request", async () => {
    const gateway = gatewayWith();
    const container = await render(
      <DashboardWidgets
        gateway={gateway}
        journalSource="ibkr-monitor"
        operator={false}
      />
    );
    expect(widgetIds(container)).toEqual(["watchlist"]);
    expect(gateway.marketContext).not.toHaveBeenCalled();
    expect(gateway.journal).not.toHaveBeenCalled();
    await act(async () => button(container, "Customize").click());
    expect(container.querySelectorAll("[data-widget-control]")).toHaveLength(1);
    expect(button(container, "Move Watchlist up").disabled).toBe(true);
    expect(button(container, "Move Watchlist down").disabled).toBe(true);
  });

  it("hides, shows, reorders and resets widgets, saved in localStorage", async () => {
    const gateway = gatewayWith();
    const container = await render(
      <DashboardWidgets
        gateway={gateway}
        journalSource="ibkr-monitor"
        now={NOW}
        operator
      />
    );
    const toggle = button(container, "Customize");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Done");
    expect(button(container, "Move Watchlist up").disabled).toBe(true);
    expect(button(container, "Move Market context down").disabled).toBe(true);

    await act(async () => button(container, "Move Watchlist down").click());
    expect(widgetIds(container)).toEqual([
      "events",
      "watchlist",
      "journal",
      "market",
    ]);
    await act(async () => button(container, "Move Market context up").click());
    expect(widgetIds(container)).toEqual([
      "events",
      "watchlist",
      "market",
      "journal",
    ]);

    const hide = button(container, "Hide Journal summary");
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    await act(async () => hide.click());
    expect(widgetIds(container)).toEqual(["events", "watchlist", "market"]);
    expect(
      button(container, "Show Journal summary").getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      JSON.parse(window.localStorage.getItem(WIDGETS_STORAGE_KEY) ?? "")
    ).toEqual({
      hidden: ["journal"],
      order: ["events", "watchlist", "market", "journal"],
    });

    await act(async () => button(container, "Show Journal summary").click());
    expect(widgetIds(container)).toHaveLength(4);
    await act(async () => button(container, "Reset to default").click());
    expect(widgetIds(container)).toEqual([
      "watchlist",
      "events",
      "journal",
      "market",
    ]);
    await act(async () => button(container, "Done").click());
    expect(container.querySelector("#dashboard-widgets-customize")).toBeNull();
  });

  it("loads the saved layout and explains when everything is hidden", async () => {
    window.localStorage.setItem(
      WIDGETS_STORAGE_KEY,
      JSON.stringify({
        hidden: ["market", "journal", "events", "watchlist"],
        order: ["market", "journal", "events", "watchlist"],
      })
    );
    const gateway = gatewayWith();
    const container = await render(
      <DashboardWidgets
        gateway={gateway}
        journalSource="ibkr-monitor"
        operator
      />
    );
    expect(widgetIds(container)).toEqual([]);
    expect(container.textContent).toContain("All widgets are hidden.");
    await act(async () => button(container, "Customize").click());
    expect(
      [...container.querySelectorAll("[data-widget-control]")].map((node) =>
        node.getAttribute("data-widget-control")
      )
    ).toEqual(["market", "journal", "events", "watchlist"]);
  });

  it("uses the browser API client by default", async () => {
    runtime.client = {
      marketContext: { get: vi.fn(async () => context()) },
      watchlist: { list: vi.fn(async () => ({ items: [item("ZZZ")] })) },
    } as unknown as ApiClient;
    const container = await render(
      <DashboardWidgets journalSource={null} operator />
    );
    expect(widget(container, "watchlist")?.textContent).toContain("ZZZ");
    expect(runtime.origins).toEqual([window.location.origin]);
  });
});
