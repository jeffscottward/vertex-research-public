// @vitest-environment jsdom
import type { PortfolioMonitorOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AgentOpsGateway } from "./agent-ops-client.tsx";
import {
  fixtureExecution,
  fixtureOrder,
  fixturePosition,
  fixtureSnapshot,
} from "./portfolio-monitor-fixture.ts";
import type { PortfolioMonitorGateway } from "./portfolio-monitor-client.ts";
import {
  DashboardViews,
  memberDestinations,
} from "./portfolio-monitor-dashboard.tsx";
import { readStored, writeStored } from "./portfolio-monitor-controls.tsx";
import {
  INTERVAL_STORAGE_KEY,
  PortfolioMonitor,
  READ_ONLY_NOTICE,
  SNAPSHOT_RETRY_MS,
  SNAPSHOT_TIMEOUT_MS,
} from "./portfolio-monitor.tsx";
import {
  COLUMNS_STORAGE_KEY,
  localDayKey,
  MONITOR_SECTIONS,
} from "./portfolio-monitor-model.ts";
import { SORT_STORAGE_KEY } from "./portfolio-monitor-tables.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  return;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  } else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  return;
});

// Some Node versions expose an unusable global localStorage under jsdom; use a plain in-memory Storage.
const memory = new Map<string, string>();
const memoryStorage = {
  clear: () => memory.clear(),
  getItem: (name: string) => memory.get(name) ?? null,
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (name: string) => memory.delete(name),
  setItem: (name: string, value: string) => memory.set(name, String(value)),
};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: memoryStorage,
});

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  visibility = "visible";
  vi.useRealTimers();
  vi.restoreAllMocks();
  return;
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  return;
};

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return { container, root };
};

const run = async (action: () => void) => {
  return await act(async () => {
    action();
    return await flush();
  });
};

const gatewayOf = (
  ...results: ReadonlyArray<PortfolioMonitorOutput | Error | object>
): PortfolioMonitorGateway & { snapshot: ReturnType<typeof vi.fn> } => {
  let call = 0;
  const snapshot = vi.fn(async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    if (result instanceof Error || !("readOnly" in result!)) throw result;
    return result as PortfolioMonitorOutput;
  });
  return { snapshot };
};

const find = (selector: string, scope: ParentNode = document): HTMLElement => {
  const found = scope.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
};

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const text = () => document.body.textContent ?? "";
const health = () => find("[data-health]").textContent ?? "";
const visibilityChange = (state: DocumentVisibilityState) => {
  return run(() => {
    visibility = state;
    return document.dispatchEvent(new Event("visibilitychange"));
  });
};

const TRADING_WORDS =
  /\b(buy|sell|place|cancel|modify|transmit|submit|trade|liquidate|flatten|close position|log ?in|sign ?in|2fa|restart)\b/iu;
const ACCOUNT_ID = /\b(?:U|DU|DF|F)\d{4,}\b/u;

describe("PortfolioMonitor", () => {
  it("renders the header, read-only notice, summary and positions from a snapshot", async () => {
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    expect(gateway.snapshot).toHaveBeenCalledTimes(1);
    expect(health()).toContain("Live");
    expect(find("[data-account-mode]").textContent).toContain(
      "Paper account · read-only"
    );
    expect(find("[data-freshness]").textContent).toMatch(
      /^Data as of \d{2}:\d{2}:\d{2} \(\d+ s ago\) · fetched \d{2}:\d{2}:\d{2}$/u
    );
    expect(find("[role=note]").textContent).toBe(READ_ONLY_NOTICE);
    expect(find("[data-stat=netLiquidation]").textContent).toContain("$20,000");
    expect(find("[data-stat=daily]").textContent).toContain("+$200");
    expect(find("[data-stat=daily]").textContent).toContain(
      "1.01% of start NLV"
    );
    expect(document.querySelectorAll("[data-stat]")).toHaveLength(12);
    expect(
      [...document.querySelectorAll("[data-position-id]")].map((row) =>
        row.getAttribute("data-position-id")
      )
    ).toEqual(["1001", "1002"]);
    expect(find("[data-totals] [data-column=marketValue]").textContent).toBe(
      "$11,000"
    );
    expect(find("[data-totals] [data-column=dailyPnl]").textContent).toBe(
      "+$40"
    );
    expect(document.querySelector("[data-column=costBasis]")).toBeNull();
    expect(find("[data-api-messages] summary").textContent).toBe(
      "API messages (1)"
    );
    return expect(text()).not.toMatch(ACCOUNT_ID);
  });

  it("opens the default section in one sticky tab bar under the summary", async () => {
    const snapshot = fixtureSnapshot({
      positions: [
        fixturePosition(),
        fixturePosition({ id: "2001", symbol: "ALPHA C", secType: "OPT" }),
        fixturePosition({ id: "2002", symbol: "FUT P", secType: " fop " }),
      ],
    });
    const { root } = await mount(
      <PortfolioMonitor gateway={gatewayOf(snapshot)} defaultTab="options" />
    );
    expect(document.querySelectorAll("[role=tablist]")).toHaveLength(1);
    expect(
      [...document.querySelectorAll("[role=tab]")].map((tab) => [
        tab.textContent,
        tab.getAttribute("aria-selected"),
      ])
    ).toEqual([
      ["Positions", "false"],
      ["Orders & stops", "false"],
      ["P&L", "false"],
      ["Allocation", "false"],
      ["Options", "true"],
    ]);
    expect(text()).toContain("Option positions (2)");
    expect(
      [...document.querySelectorAll("[data-position-id]")].map((row) =>
        row.getAttribute("data-position-id")
      )
    ).toEqual(["2001", "2002"]);
    const show = (
      section: "orders-stops" | "pnl" | "allocation" | "positions"
    ) =>
      run(() =>
        root.render(
          <PortfolioMonitor
            gateway={gatewayOf(snapshot)}
            defaultTab={section}
          />
        )
      );
    await show("orders-stops");
    expect(find("#pm-open-orders-title").textContent).toContain("Open orders");
    expect(document.querySelector("[data-ladder='1001']")).not.toBeNull();
    expect(find("#pm-completed-title").textContent).toContain("Completed");
    await show("pnl");
    expect(document.querySelector("[data-bar=ALPHA]")).not.toBeNull();
    expect(document.querySelector("[data-slice]")).toBeNull();
    await show("allocation");
    expect(document.querySelector("[data-slice=ALPHA]")).not.toBeNull();
    expect(document.querySelector("[data-bar]")).toBeNull();
    await show("positions");
    return expect(text()).toContain("Positions (3)");
  });

  it("says no option positions when the gateway is live and none are held", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="options"
      />
    );
    return expect(text()).toContain("No option positions.");
  });

  it("shows a live account badge", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(
          fixtureSnapshot({
            account: {
              mode: "live",
              modeSource: "confirmed",
              modeConfirmedAt: "2026-11-11T05:12:00.000Z",
              modeError: null,
              count: 2,
            },
            messages: [],
          })
        )}
        defaultTab="positions"
      />
    );
    expect(find("[data-account-mode=live]").textContent).toContain(
      "Live account · read-only"
    );
    return expect(document.querySelector("[data-api-messages]")).toBeNull();
  });

  it("sorts by a column and saves the sort", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    const header = find("[data-sort-column=last]");
    await run(() => header.click());
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(readStored(SORT_STORAGE_KEY)).toEqual({ id: "last", dir: -1 });
    expect(find("[data-position-id]").getAttribute("data-position-id")).toBe(
      "1002"
    );
    await run(() => header.click());
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    return expect(
      find("[data-position-id]").getAttribute("data-position-id")
    ).toBe("1001");
  });

  it("shows a sortable Type column for shares and contracts", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    const header = find("[data-sort-column=type]");
    expect(header.textContent).toContain("Type");
    const badge = find("td[data-column=type] [data-holding-tone]");
    expect(badge.textContent).toMatch(/^STK \([LS]\)$/u);
    expect(badge.getAttribute("aria-label")).toMatch(/^(Long|Short) shares$/u);
    await run(() => header.click());
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    return expect(readStored(SORT_STORAGE_KEY)).toEqual({
      dir: -1,
      id: "type",
    });
  });
  it("colors the Type badge for long, short and flat holdings", async () => {
    const snapshot = fixtureSnapshot({
      positions: [
        fixturePosition({ id: "3001", position: 10, secType: "STK" }),
        fixturePosition({ id: "3002", position: -10, secType: "STK" }),
        fixturePosition({ id: "3003", position: 0, secType: "STK" }),
      ],
    });
    await mount(
      <PortfolioMonitor gateway={gatewayOf(snapshot)} defaultTab="positions" />
    );
    const tones = [
      ...document.querySelectorAll("td[data-column=type] [data-holding-tone]"),
    ]
      .map((badge) => badge.getAttribute("data-holding-tone"))
      .sort();
    return expect(tones).toEqual(["flat", "long", "short"]);
  });

  it("hides, moves and resets columns and keeps the layout after a remount", async () => {
    const first = await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    const toggle = button("Columns");
    await run(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((find("#pm-col-symbol") as HTMLInputElement).disabled).toBe(true);
    await run(() => find("#pm-col-last").click());
    expect(document.querySelector("[data-sort-column=last]")).toBeNull();
    expect(readStored(COLUMNS_STORAGE_KEY)).toMatchObject({
      hidden: ["costBasis", "realized", "last"],
    });
    expect(button("Move Symbol up").disabled).toBe(true);
    expect(button("Move Realized P&L down").disabled).toBe(true);
    await run(() => button("Move Type up").click());
    expect(find("thead th").textContent).toBe("Type");
    await run(() => button("Move Type down").click());
    expect(find("thead th").textContent).toBe("Symbol");
    await run(() => first.root.unmount());
    roots.splice(0);
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    expect(document.querySelector("[data-sort-column=last]")).toBeNull();
    await run(() => button("Columns").click());
    await run(() => button("Reset columns").click());
    expect(document.querySelector("[data-sort-column=last]")).not.toBeNull();
    await run(() => find("#pm-col-costBasis").click());
    return expect(
      document.querySelector("[data-sort-column=costBasis]")
    ).not.toBeNull();
  });

  it("repairs a stored column layout that names unknown columns", async () => {
    writeStored(COLUMNS_STORAGE_KEY, {
      order: ["ghost", "last"],
      hidden: ["symbol", "ghost"],
    });
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    const headers = [...document.querySelectorAll("thead th")].map(
      (cell) => cell.textContent
    );
    expect(headers.slice(0, 2)).toEqual(["Last", "Symbol"]);
    return expect(headers).toContain("Cost basis");
  });

  it("shows open orders grouped by symbol with children nested under the parent", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ completed: [] }))}
        defaultTab="orders-stops"
      />
    );
    const rows = [...document.querySelectorAll("[data-order-key]")].map(
      (row) => [
        row.getAttribute("data-order-key"),
        row.getAttribute("data-depth"),
      ]
    );
    expect(rows).toEqual([
      ["7:10:9010", "0"],
      ["7:12:9012", "1"],
      ["7:11:9011", "1"],
    ]);
    expect(find("[data-order-key='7:10:9010']").textContent).toContain(
      "At exchange"
    );
    expect(find("[data-order-key='7:11:9011']").textContent).toContain(
      "Held at IBKR"
    );
    expect(find("[data-order-key='7:12:9012']").textContent).toContain(
      "(trail 5%)"
    );
    expect(
      find("[data-order-key='7:11:9011'] [data-status]").getAttribute("title")
    ).toMatch(/held on IBKR servers/u);
    expect(find("[data-order-key='7:11:9011']").textContent).toContain("OCA");
    expect(find("[aria-label='Child order']")).not.toBeNull();
    return expect(text()).toContain("IBKR simulates stop orders this way");
  });

  it("shows order details: filled quantity, extended hours, references and empty lists", async () => {
    const orders = [
      fixtureOrder({
        key: "7:20:9020",
        filledQty: 10,
        outsideRth: true,
        orderRef: "ref-test",
        stopPrice: 50,
        status: "",
      }),
    ];
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ orders }))}
        defaultTab="orders-stops"
      />
    );
    const row = find("[data-order-key='7:20:9020']");
    expect(row.textContent).toContain("(10 filled)");
    expect(row.textContent).toContain("GTC · ext hours");
    expect(row.textContent).toContain("ref-test");
    return expect(row.textContent).toContain("—");
  });

  it("says no open orders only when the gateway is live", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ orders: [] }))}
        defaultTab="orders-stops"
      />
    );
    return expect(text()).toContain("No open orders.");
  });

  it("shows executions newest first and completed or cancelled orders from today", async () => {
    const today = localDayKey(new Date());
    const snapshot = fixtureSnapshot({
      executions: [
        fixtureExecution({
          execId: "e-old",
          time: "20261009 09:00:00 US/Eastern",
          side: "SLD",
          realized: 12.5,
        }),
        fixtureExecution({
          execId: "e-new",
          time: "20261009 10:00:00 US/Eastern",
        }),
      ],
      completed: [
        fixtureOrder({
          key: "7:30:9030",
          status: "Cancelled",
          completedTime: `${today} 10:15:00 US/Eastern`,
          completedStatus: "Cancelled by test: detail",
        }),
        fixtureOrder({
          key: "7:31:9031",
          status: "Filled",
          completedTime: "",
          completedStatus: "",
        }),
        fixtureOrder({
          key: "7:32:9032",
          status: "Filled",
          completedTime: "20200101 10:00:00 US/Eastern",
        }),
      ],
    });
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf({ ...snapshot, orders: [] })}
        defaultTab="orders-stops"
      />
    );
    expect(
      [...document.querySelectorAll("[data-exec-id]")].map((row) =>
        row.getAttribute("data-exec-id")
      )
    ).toEqual(["e-new", "e-old"]);
    expect(find("[data-exec-id=e-old]").textContent).toContain("+$12.50");
    expect(find("[data-exec-id=e-new] td").textContent).toBe(
      "10:00:00 US/Eastern"
    );
    expect(
      [...document.querySelectorAll("[data-order-key]")].map((row) =>
        row.getAttribute("data-order-key")
      )
    ).toEqual(["7:30:9030", "7:31:9031"]);
    expect(find("[data-order-key='7:30:9030']").textContent).toContain(
      "Cancelled by test · 10:15:00"
    );
    return expect(text()).toContain("Completed / cancelled today (2)");
  });

  it("says no executions today when the gateway is live", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ executions: [] }))}
        defaultTab="orders-stops"
      />
    );
    expect(text()).toContain("No executions today.");
    return expect(text()).toContain("No completed or cancelled orders today.");
  });

  it("draws allocation, P&L bars and stop ladders", async () => {
    const { root } = await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="allocation"
      />
    );
    const show = (section: "pnl" | "orders-stops") =>
      run(() =>
        root.render(
          <PortfolioMonitor
            gateway={gatewayOf(fixtureSnapshot())}
            defaultTab={section}
          />
        )
      );
    expect(
      [...document.querySelectorAll("[data-slice]")].map((slice) =>
        slice.getAttribute("data-slice")
      )
    ).toEqual(["ALPHA", "BRAVO", "Cash / other"]);
    expect(find("[data-allocation-legend]").textContent).toContain(
      "Cash / other"
    );
    expect(find("[data-slice=ALPHA] title").textContent).toBe(
      "ALPHA: $6,000 (30.0%)"
    );
    await show("pnl");
    expect(
      [...document.querySelectorAll("[data-bar]")].map((bar) =>
        bar.getAttribute("data-bar")
      )
    ).toEqual(["ALPHA", "BRAVO"]);
    expect(find("[data-bar=BRAVO] title").textContent).toBe(
      "BRAVO: unrealized -$500, today -$80"
    );
    await show("orders-stops");
    const alpha = find("[data-ladder='1001']");
    expect(alpha.querySelectorAll("[data-mark=stop]")).toHaveLength(2);
    expect(alpha.querySelector("[data-mark=last]")?.getAttribute("title")).toBe(
      "Last 60.00"
    );
    expect(alpha.querySelector("[data-mark=avg]")?.getAttribute("title")).toBe(
      "Average cost 50.00"
    );
    expect(alpha.querySelector("[data-mark=stop]")?.getAttribute("title")).toBe(
      "TRAIL 50 @ 57.00"
    );
    expect(find("[data-ladder-summary]", alpha).textContent).toBe(
      "last 60.00 · 2 rungs · 100/100 covered · nearest stop 5.0% below"
    );
    return expect(
      find("[data-ladder='1002'] [data-no-stops]").textContent
    ).toBe("No stop orders for this position.");
  });

  it("draws ladders without last or average price and empty charts", async () => {
    const positions = [fixturePosition({ last: null, avgPrice: null })];
    const orders = [
      fixtureOrder({
        stopPrice: 40,
        limitPrice: 39,
        remaining: null,
        qty: 100,
      }),
    ];
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ positions, orders }))}
        defaultTab="orders-stops"
      />
    );
    expect(find("[data-ladder-summary]").textContent).toBe(
      "last — · 1 rung · 100/100 covered"
    );
    expect(find("[data-mark=stop]").getAttribute("title")).toBe(
      "STP 100 @ 40.00 limit 39.00"
    );
    expect(document.querySelector("[data-mark=last]")).toBeNull();
    return expect(document.querySelector("[data-mark=avg]")).toBeNull();
  });

  it("shows empty chart states when there are no positions", async () => {
    const snapshot = fixtureSnapshot({
      positions: [],
      summary: { ...fixtureSnapshot().summary, netLiquidation: null },
    });
    const { root } = await mount(
      <PortfolioMonitor gateway={gatewayOf(snapshot)} defaultTab="allocation" />
    );
    expect(text()).toContain("No allocation data.");
    await run(() =>
      root.render(
        <PortfolioMonitor gateway={gatewayOf(snapshot)} defaultTab="pnl" />
      )
    );
    expect(text()).toContain("No positions to chart.");
    await run(() =>
      root.render(
        <PortfolioMonitor
          gateway={gatewayOf(snapshot)}
          defaultTab="orders-stops"
        />
      )
    );
    return expect(text()).toContain(
      "No open positions, so there are no stop ladders."
    );
  });

  it("says no open positions when the gateway is live and the list is empty", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ positions: [] }))}
        defaultTab="positions"
      />
    );
    expect(find("[data-empty]").textContent).toBe("No open positions.");
    // A live empty list keeps its count: zero is a fact here.
    expect(find("#pm-positions-title").textContent).toContain("(0)");
    return expect(document.querySelector("[data-withheld]")).toBeNull();
  });

  it("names the disconnect without a last confirmation when the reader reports no mode", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(
          fixtureSnapshot({
            status: {
              gateway: "disconnected",
              connected: false,
              lastError: null,
              since: null,
            },
            account: {
              mode: null,
              modeSource: null,
              modeConfirmedAt: null,
              modeError: "not-reported",
              count: 0,
            },
          })
        )}
        defaultTab="positions"
      />
    );
    expect(find("[data-banner=disconnected]").textContent).toBe(
      "Gateway disconnected · retrying. Values may be out of date."
    );
    return expect(
      find("[data-account-mode=not-reported]").textContent
    ).toContain("Account mode not reported");
  });

  it("marks values out of date and empty lists withheld when the gateway is disconnected", async () => {
    const snapshot = fixtureSnapshot({
      status: {
        gateway: "disconnected",
        connected: false,
        lastError: "Test gateway error.",
        since: null,
      },
      positions: [],
      orders: [],
      executions: [],
    });
    const { root } = await mount(
      <PortfolioMonitor gateway={gatewayOf(snapshot)} defaultTab="positions" />
    );
    expect(health()).toBe("Status:Gateway disconnected · retrying");
    expect(find("[data-banner=disconnected]").textContent).toMatch(
      /^Gateway disconnected · retrying\. Last confirmed: Paper account \d\d:\d\d \S+\. Test gateway error\. Values may be out of date\.$/
    );
    // The account mode is a configured fact: it stays on the badge during the disconnect.
    expect(find("[data-account-mode=paper]").textContent).toBe(
      "Status:Paper account · read-only"
    );
    expect(find("[data-withheld]").textContent).toBe(
      "Positions withheld. The IBKR gateway has been disconnected, so account data is withheld until it reconnects. The reader retries on its own."
    );
    expect(text()).not.toContain("No open positions");
    expect(text()).not.toMatch(/unknown/i);
    await run(() =>
      root.render(
        <PortfolioMonitor
          gateway={gatewayOf(snapshot)}
          defaultTab="orders-stops"
        />
      )
    );
    const withheld = [...document.querySelectorAll("[data-withheld]")].map(
      (node) => node.textContent ?? ""
    );
    expect(
      withheld.some((line) =>
        line.startsWith(
          "Orders withheld. The IBKR gateway has been disconnected"
        )
      )
    ).toBe(true);
    return expect(
      withheld.some((line) =>
        line.startsWith(
          "Executions withheld. The IBKR gateway has been disconnected"
        )
      )
    ).toBe(true);
  });

  it("shows a starting gateway and a stale snapshot", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(
          fixtureSnapshot({
            status: { gateway: "starting", connected: false, since: null },
            account: {
              mode: "live",
              modeSource: "configured",
              modeConfirmedAt: null,
              modeError: null,
              count: 0,
            },
          })
        )}
        defaultTab="positions"
      />
    );
    expect(health()).toBe("Status:Gateway connecting · retrying");
    expect(find("[data-account-mode=live]").textContent).toBe(
      "Status:Live account · read-only"
    );
    return expect(find("[data-banner=starting]").textContent).toBe(
      "Gateway connecting · retrying. Live account from the gateway configuration; no session has confirmed it yet. Values may be out of date."
    );
  });

  it("shows since when the gateway has been down and keeps the account mode", async () => {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(
          fixtureSnapshot({
            status: { gateway: "disconnected", connected: false, since },
            account: {
              mode: "live",
              modeSource: "configured",
              modeConfirmedAt: since,
              modeError: null,
              count: 0,
            },
          })
        )}
        defaultTab="positions"
      />
    );
    expect(health()).toMatch(
      /^Status:Gateway disconnected since (\w{3} \d{1,2} )?\d\d:\d\d \S+ · retrying$/
    );
    expect(find("[data-account-mode=live]").textContent).toBe(
      "Status:Live account · read-only"
    );
    expect(text()).not.toMatch(/account mode unknown/i);
    return expect(find("[data-banner=disconnected]").textContent).toContain(
      "Last confirmed: Live account"
    );
  });

  it("shows a named account-mode error with its fix instead of a mode", async () => {
    const withError = (
      modeError: "mismatch" | "not-configured" | "not-reported"
    ) =>
      fixtureSnapshot({
        account: {
          mode: null,
          modeSource: null,
          modeConfirmedAt: null,
          modeError,
          count: 0,
        },
        // The API empties the lists on a mismatch and leaves the gateway state as it is.
        ...(modeError === "mismatch" ? { positions: [], orders: [] } : {}),
      });
    const { root } = await mount(
      <PortfolioMonitor
        gateway={gatewayOf(withError("mismatch"))}
        defaultTab="positions"
      />
    );
    expect(find("[data-account-mode=mismatch]").textContent).toBe(
      "Status:Account mode mismatch · data withheld"
    );
    expect(
      find("[data-banner=account-mode-mismatch]").getAttribute("role")
    ).toBe("alert");
    expect(find("[data-health=mode-mismatch]").textContent).toContain(
      "Account data withheld"
    );
    // Withheld lists are not shown as an empty account: no "(0)" count, and the notice names the cause.
    expect(text()).not.toMatch(/No open positions|No open orders/);
    expect(find("[data-withheld]").textContent).toBe(
      "Positions withheld. The IBKR gateway's account list does not match its configured mode (live or paper), so account data is withheld until they agree. The account mode alert on the Portfolio page shows the fix."
    );
    expect(find("#pm-positions-title").textContent).not.toContain("(0)");
    // The charts say the same, not "No positions to chart".
    for (const [tab, what, empty] of [
      ["pnl", "Positions", "No positions to chart."],
      ["allocation", "Allocation", "No allocation data."],
    ] as const) {
      await run(() =>
        root.render(
          <PortfolioMonitor
            gateway={gatewayOf(withError("mismatch"))}
            defaultTab={tab}
          />
        )
      );
      expect(find("[data-withheld]").textContent).toMatch(
        new RegExp(`^${what} withheld\\. The IBKR gateway's account list`)
      );
      expect(text()).not.toContain(empty);
    }
    expect(text()).not.toMatch(/Values may be out of date/);
    await run(() => root.unmount());
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(withError("not-configured"))}
        defaultTab="positions"
      />
    );
    return expect(
      find("[data-banner=account-mode-not-configured]").textContent
    ).toContain("Set IBKR_TRADING_MODE");
  });

  it("shows stale data with its age", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ status: { dataAsOf: old } }))}
        defaultTab="positions"
      />
    );
    expect(health()).toContain("Stale");
    return expect(find("[data-banner=stale]").textContent).toMatch(
      /^The IBKR data is 12\d s old\. Values may be out of date\.$/u
    );
  });

  it("shows stale data with no data time", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot({ status: { dataAsOf: null } }))}
        defaultTab="positions"
      />
    );
    expect(find("[data-banner=stale]").textContent).toMatch(
      /^IBKR sent no data time in the snapshot fetched at \d\d:\d\d:\d\d, so its age cannot be checked\. Values may be out of date\.$/
    );
    return expect(find("[data-freshness]").textContent).toMatch(
      /^Data as of — · fetched /u
    );
  });

  it("keeps the last good data and says so when a refresh keeps failing", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    const gateway = gatewayOf(fixtureSnapshot(), {
      code: "UNAVAILABLE",
      message: "IBKR portfolio service unavailable",
    });
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    // A hidden page sends nothing: iOS aborts fetches of a suspended page.
    await visibilityChange("hidden");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      return await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(1);
    await visibilityChange("visible");
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
    // Inside the grace window the page says "Updating" and keeps the last data.
    expect(health()).toContain("Updating");
    expect(document.querySelector("[data-banner=failure]")).toBeNull();
    expect(find("[data-banner=updating]").textContent).toContain(
      "the page is retrying"
    );
    await act(async () => {
      vi.advanceTimersByTime(SNAPSHOT_RETRY_MS);
      return await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      return await flush();
    });
    expect(health()).toContain("Server unreachable");
    expect(find("[data-banner=failure]").textContent).toMatch(
      /^Cannot load a new snapshot \(UNAVAILABLE: IBKR portfolio service unavailable\)\. Values below are from the last successful update at \d{2}:\d{2}:\d{2}\.$/u
    );
    return expect(find("[data-stat=netLiquidation]").textContent).toContain(
      "$20,000"
    );
  });

  it("hides a transient failure while orders run and recovers on the quick retry", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    // Safari reports an aborted fetch as TypeError "Load failed" (owner screenshot 2026-11-05).
    const gateway = gatewayOf(
      fixtureSnapshot(),
      new TypeError("Load failed"),
      fixtureSnapshot()
    );
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      return await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
    expect(health()).toContain("Updating");
    expect(health()).not.toContain("Server unreachable");
    await act(async () => {
      vi.advanceTimersByTime(SNAPSHOT_RETRY_MS);
      return await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(3);
    expect(health()).toContain("Live");
    return expect(document.querySelector("[data-banner]")).toBeNull();
  });

  it("times out a stuck request, keeps polling and recovers", async () => {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
    // The second request never settles, as if the server were blocked by an order submit.
    const results: Array<() => Promise<PortfolioMonitorOutput>> = [
      async () => fixtureSnapshot(),
      () => new Promise<PortfolioMonitorOutput>(() => undefined),
      async () => fixtureSnapshot(),
    ];
    const snapshot = vi.fn(() => results[snapshot.mock.calls.length - 1]!());
    await mount(
      <PortfolioMonitor gateway={{ snapshot }} defaultTab="positions" />
    );
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      return await flush();
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    // While the request hangs, the poll timer sends nothing more.
    await act(async () => {
      vi.advanceTimersByTime(SNAPSHOT_TIMEOUT_MS - 1);
      return await flush();
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      return await flush();
    });
    expect(health()).toContain("Updating");
    await act(async () => {
      vi.advanceTimersByTime(SNAPSHOT_RETRY_MS);
      return await flush();
    });
    expect(snapshot).toHaveBeenCalledTimes(3);
    return expect(health()).toContain("Live");
  });

  it("shows the not-configured state and retries on request", async () => {
    const gateway = gatewayOf(
      {
        code: "NOT_CONFIGURED",
        message: "Portfolio monitor endpoint not configured",
      },
      fixtureSnapshot()
    );
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    expect(health()).toContain("Not configured");
    const state = find("[data-monitor-state=not-configured]");
    expect(state.getAttribute("role")).toBe("status");
    expect(state.textContent).toContain("IBKR monitor not configured");
    expect(find("[data-failure-code]").textContent).toBe(
      "NOT_CONFIGURED: Portfolio monitor endpoint not configured"
    );
    expect(document.querySelector("[data-stat]")).toBeNull();
    await run(() => button("Retry now").click());
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
    return expect(health()).toContain("Live");
  });

  it("sends no request when the server says the monitor is not configured", async () => {
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(
      <PortfolioMonitor
        configured={false}
        gateway={gateway}
        defaultTab="positions"
      />
    );
    expect(gateway.snapshot).not.toHaveBeenCalled();
    expect(health()).toContain("Not configured");
    expect(find("[data-monitor-state=not-configured]").textContent).toContain(
      "IBKR monitor not configured"
    );
    return expect(find("[data-failure-code]").textContent).toBe(
      "NOT_CONFIGURED: VERTEX_PORTFOLIO_URL is not set on this server"
    );
  });

  it("stops polling after a failure that polling cannot fix", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const gateway = gatewayOf({ code: "FORBIDDEN", message: "Forbidden" });
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      return await flush();
    });
    // Returning to the tab does not ask again either; only "Retry now" does.
    await visibilityChange("visible");
    return expect(gateway.snapshot).toHaveBeenCalledTimes(1);
  });

  it("shows operator access required for a 403", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf({ code: "FORBIDDEN", message: "Forbidden" })}
        defaultTab="positions"
      />
    );
    expect(find("[data-operator-access=required]").textContent).toContain(
      "Operator access required"
    );
    expect(find("[data-monitor-state=forbidden]").textContent).toContain(
      "The IBKR monitor is limited to operators."
    );
    expect(health()).toContain("Operator access required");
    return expect(document.querySelector("[data-stat]")).toBeNull();
  });

  it("shows a load failure with its code when nothing was loaded", async () => {
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(new Error("network down"))}
        defaultTab="positions"
      />
    );
    const state = find("[data-monitor-state=error]");
    expect(state.getAttribute("role")).toBe("alert");
    expect(state.textContent).toContain("Cannot load the IBKR snapshot");
    expect(find("[data-failure-code]").textContent).toBe("ERROR: network down");
    return expect(health()).toContain("Server unreachable");
  });

  it("shows a loading state while the first request is pending and ignores late results", async () => {
    let resolve: (value: PortfolioMonitorOutput) => void = () => undefined;
    const snapshot = vi.fn(
      () =>
        new Promise<PortfolioMonitorOutput>((done) => {
          return (resolve = done);
        })
    );
    const { root } = await mount(
      <PortfolioMonitor gateway={{ snapshot }} defaultTab="positions" />
    );
    expect(find("[data-monitor-state=loading]").getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(health()).toContain("Loading");
    await visibilityChange("visible");
    expect(snapshot).toHaveBeenCalledTimes(1);
    await run(() => root.unmount());
    roots.splice(0);
    await act(async () => {
      resolve(fixtureSnapshot());
      return await flush();
    });
    return expect(document.querySelector("[data-stat]")).toBeNull();
  });

  it("ignores a late failure after unmount", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const snapshot = vi.fn(
      () =>
        new Promise<PortfolioMonitorOutput>((_done, fail) => {
          return (reject = fail);
        })
    );
    const { root } = await mount(
      <PortfolioMonitor gateway={{ snapshot }} defaultTab="positions" />
    );
    await run(() => root.unmount());
    roots.splice(0);
    await act(async () => {
      reject(new Error("late"));
      return await flush();
    });
    return expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("polls on the chosen interval and saves it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const gateway = gatewayOf(fixtureSnapshot());
    await mount(<PortfolioMonitor gateway={gateway} defaultTab="positions" />);
    const select = find("#pm-interval") as HTMLSelectElement;
    expect(select.value).toBe("10");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      return await flush();
    });
    expect(gateway.snapshot).toHaveBeenCalledTimes(2);
    await run(() => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )!.set!.call(select, "5");
      return select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readStored(INTERVAL_STORAGE_KEY)).toBe(5);
    expect(select.value).toBe("5");
    const calls = gateway.snapshot.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(5000);
      return await flush();
    });
    return expect(gateway.snapshot.mock.calls.length).toBe(calls + 1);
  });

  it("restores the saved interval", async () => {
    writeStored(INTERVAL_STORAGE_KEY, 30);
    await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    return expect((find("#pm-interval") as HTMLSelectElement).value).toBe("30");
  });

  return it("has no buttons that act on the account in any section", async () => {
    const { root } = await mount(
      <PortfolioMonitor
        gateway={gatewayOf(fixtureSnapshot())}
        defaultTab="positions"
      />
    );
    const labels = new Set<string>();
    const collect = () => {
      for (const node of document.querySelectorAll(
        "button, [role=button], a"
      )) {
        labels.add(
          `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`.trim()
        );
      }
      return;
    };
    await run(() => button("Columns").click());
    for (const section of MONITOR_SECTIONS) {
      await run(() =>
        root.render(
          <PortfolioMonitor
            gateway={gatewayOf(fixtureSnapshot())}
            defaultTab={section}
          />
        )
      );
      collect();
    }
    expect(labels.size).toBeGreaterThan(5);
    for (const label of labels) {
      expect(label).not.toMatch(TRADING_WORDS);
    }
    return expect(document.querySelector("form")).toBeNull();
  });
});

describe("storage helpers", () =>
  it("falls back when storage holds bad JSON or cannot be written", () => {
    window.localStorage.setItem("vertex.test.bad", "{not json");
    expect(readStored("vertex.test.bad")).toBeUndefined();
    expect(readStored("vertex.test.missing")).toBeUndefined();
    vi.spyOn(memoryStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    return expect(() => writeStored("vertex.test.full", 1)).not.toThrow();
  }));

describe("DashboardViews", () => {
  const deniedAgents = (): AgentOpsGateway => {
    const denied = async () => {
      throw { code: "FORBIDDEN", message: "Forbidden" };
    };
    return {
      summary: vi.fn(denied),
      listTasks: vi.fn(denied),
    } as unknown as AgentOpsGateway;
  };

  it("shows the account card above agent work, with no view tabs", async () => {
    const accountGateway = gatewayOf(fixtureSnapshot());
    const agents = deniedAgents();
    await mount(
      <DashboardViews
        account={{ gateway: accountGateway }}
        gateway={agents}
        operator
        summaryState={{ type: "ready" }}
      />
    );
    expect(document.querySelector("[role=tablist]")).toBeNull();
    expect(document.querySelector("[data-portfolio-monitor]")).toBeNull();
    const view = find("[data-dashboard-view=operator]");
    const glance = find("[data-account-glance]", view);
    const agentWork = find("[data-operator-access=required]", view);
    // Card first, agent work below it.
    expect(view.firstElementChild).toBe(glance);
    expect(view.lastElementChild?.contains(agentWork)).toBe(true);
    expect(find("[data-stat=netLiquidation]", glance).textContent).toContain(
      "$20,000"
    );
    expect(accountGateway.snapshot).toHaveBeenCalledOnce();
    return expect(agents.summary).toHaveBeenCalledOnce();
  });

  it("renders the monitor on the server with the browser gateway and without network", () => {
    const html = renderToString(<PortfolioMonitor defaultTab="positions" />);
    expect(html).toContain("Loading IBKR snapshot");
    return expect(html).toContain(READ_ONLY_NOTICE);
  });

  it("renders on the server with the account card and agent work loading", () => {
    const html = renderToString(
      <DashboardViews
        account={{ gateway: gatewayOf(fixtureSnapshot()) }}
        operator
      />
    );
    expect(html).toContain("IBKR account");
    expect(html).toContain("Loading IBKR snapshot");
    expect(html).toContain("Loading agent activity");
    return expect(html).not.toContain('role="tab"');
  });

  return it("gives a non-operator no account card, no operator requests and links to open pages", async () => {
    const agents = deniedAgents();
    const accountGateway = gatewayOf(fixtureSnapshot());
    await mount(
      <DashboardViews
        account={{ gateway: accountGateway }}
        gateway={agents}
        summaryState={{ type: "error" }}
      />
    );
    expect(document.querySelector("[role=tab]")).toBeNull();
    expect(document.querySelector("[data-account-glance]")).toBeNull();
    expect(accountGateway.snapshot).not.toHaveBeenCalled();
    expect(agents.summary).not.toHaveBeenCalled();
    expect(
      find("[data-operator-access=required]").getAttribute(
        "data-operator-feature"
      )
    ).toBe("mission-control");
    expect(find("[data-dashboard-view=member]").textContent).toContain(
      "Workspace session summary unavailable."
    );
    const hrefs = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        "[data-dashboard-view=member] a"
      ),
    ].map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(memberDestinations().map((item) => item.href));
    expect(hrefs).toContain("/research");
    expect(hrefs).not.toContain("/dashboard");
    expect(renderToString(<DashboardViews />)).not.toContain(
      "Workspace session summary unavailable."
    );
    return expect(hrefs).not.toContain("/agents");
  });
});

describe("round-number flags on open orders", () => {
  const flag = (kind: "stop" | "limit", key: string) => ({
    key,
    kind,
    price: 48.5,
    handle: "48.50 handle",
    side: "below" as const,
    offset: 0.13,
    suggested: 48.37,
  });

  it("flags stop and limit prices as text and polls once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const orders = [
      fixtureOrder({ key: "7:30:9030", stopPrice: 48.5, limitPrice: 48.5 }),
      fixtureOrder({ key: "7:31:9031", stopPrice: 52.1 }),
    ];
    const roundHandles = vi.fn(async () => ({
      checked: 2,
      skippedTrailing: 0,
      flags: [flag("stop", "7:30:9030"), flag("limit", "7:30:9030")],
    }));
    await mount(
      <PortfolioMonitor
        gateway={{ ...gatewayOf(fixtureSnapshot({ orders })), roundHandles }}
        defaultTab="orders-stops"
      />
    );
    const row = find("[data-order-key='7:30:9030']");
    expect(row.querySelector("[data-round-handle='stop']")?.textContent).toBe(
      "round · try 48.37"
    );
    expect(
      row.querySelector("[data-round-handle='limit']")?.getAttribute("title")
    ).toMatch(/no order is changed/u);
    expect(
      find("[data-order-key='7:31:9031']").querySelector("[data-round-handle]")
    ).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      return await flush();
    });
    return expect(roundHandles).toHaveBeenCalledTimes(2);
  });

  it("says when the check fails and never asks outside Orders & stops", async () => {
    const failing = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await mount(
      <PortfolioMonitor
        gateway={{ ...gatewayOf(fixtureSnapshot()), roundHandles: failing }}
        defaultTab="orders-stops"
      />
    );
    expect(find("[data-round-handle-state='unavailable']")).not.toBeNull();
    expect(document.querySelector("[data-round-handle]")).toBeNull();
    const unused = vi.fn();
    await mount(
      <PortfolioMonitor
        gateway={{ ...gatewayOf(fixtureSnapshot()), roundHandles: unused }}
        defaultTab="positions"
      />
    );
    return expect(unused).not.toHaveBeenCalled();
  });

  it("ignores a check that settles after the monitor closes", async () => {
    const settle: Array<() => void> = [];
    const late = (fail: boolean) =>
      vi.fn(
        () =>
          new Promise<{ checked: number; skippedTrailing: number; flags: [] }>(
            (resolve, reject) => {
              settle.push(() =>
                fail
                  ? reject(new Error("late"))
                  : resolve({ checked: 0, skippedTrailing: 0, flags: [] })
              );
            }
          )
      );
    for (const fail of [false, true])
      await mount(
        <PortfolioMonitor
          gateway={{
            ...gatewayOf(fixtureSnapshot()),
            roundHandles: late(fail),
          }}
          defaultTab="orders-stops"
        />
      );
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      for (const done of settle) done();
      return await flush();
    });
    return expect(settle).toHaveLength(2);
  });

  it("hides a flag whose price no longer matches and clears flags after a failed check", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const orders = [fixtureOrder({ key: "7:40:9040", stopPrice: 48.37 })];
    let fail = false;
    const roundHandles = vi.fn(async () => {
      if (fail) throw new Error("unavailable");
      return {
        checked: 1,
        skippedTrailing: 0,
        flags: [flag("stop", "7:40:9040"), flag("limit", "7:41:9041")],
      };
    });
    await mount(
      <PortfolioMonitor
        gateway={{
          ...gatewayOf(
            fixtureSnapshot({
              orders: [
                ...orders,
                fixtureOrder({ key: "7:41:9041", limitPrice: 48.5 }),
              ],
            })
          ),
          roundHandles,
        }}
        defaultTab="orders-stops"
      />
    );
    expect(
      find("[data-order-key='7:40:9040']").querySelector("[data-round-handle]")
    ).toBeNull();
    expect(
      find("[data-order-key='7:41:9041']").querySelector("[data-round-handle]")
    ).not.toBeNull();
    fail = true;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      return await flush();
    });
    expect(document.querySelector("[data-round-handle]")).toBeNull();
    return expect(
      find("[data-round-handle-state='unavailable']")
    ).not.toBeNull();
  });
});
