// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@darkfactory/api")>();
  return {
    ...actual,
    createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
      runtime.origins.push(options.baseUrl);
      return runtime.client!;
    }),
  };
});

import {
  createBrowserIbkrMonitorGateway,
  createIbkrMonitorGateway,
} from "./portfolio-monitor-client.ts";
import { fixtureSnapshot } from "./portfolio-monitor-fixture.ts";
import {
  LEGACY_PORTFOLIO_VIEW_STORAGE_KEY,
  migrateLegacyPortfolioView,
  normalizePortfolioView,
  PORTFOLIO_VIEW_STORAGE_KEY,
  PortfolioTabs,
} from "./portfolio-tabs.tsx";
import type { VertexOrdersGateway } from "./vertex-orders-client.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

afterEach(() => {
  runtime.client = null;
  runtime.origins.length = 0;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = "";
});

const tabNamed = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = [
    ...scope.querySelectorAll<HTMLButtonElement>("[role=tab]"),
  ].find((tab) => tab.textContent === name);
  if (found === undefined) throw new Error(`Missing tab ${name}`);
  return found;
};

const withRoot = async (
  run: (container: HTMLDivElement, root: Root) => Promise<void>
) => {
  const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run(container, root);
  } finally {
    await act(async () => root.unmount());
    if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  }
};

const operatorTabs = () => (
  <PortfolioTabs
    gateway={{ snapshot: vi.fn(async () => fixtureSnapshot()) }}
    operator
    projection={<p>projection-marker</p>}
  />
);

describe("Portfolio tab", () => {
  it("reads ibkrMonitor.snapshot (never portfolioMonitor) with an empty input", async () => {
    const ibkr = vi.fn(async () => fixtureSnapshot());
    const roundHandles = vi.fn(async () => ({
      checked: 0,
      skippedTrailing: 0,
      flags: [],
    }));
    const other = vi.fn();
    const client = {
      ibkrMonitor: { snapshot: ibkr, roundHandles },
      portfolioMonitor: { snapshot: other },
    } as unknown as ApiClient;
    const gateway = createIbkrMonitorGateway(client);
    const snapshot = await gateway.snapshot();
    expect(snapshot.readOnly).toBe(true);
    expect(ibkr).toHaveBeenCalledWith({});
    expect((await gateway.roundHandles()).checked).toBe(0);
    expect(roundHandles).toHaveBeenCalledWith({});
    expect(other).not.toHaveBeenCalled();
  });

  it("creates the browser ibkr-monitor client lazily, once, on the page origin", async () => {
    const snapshot = vi.fn(async () => fixtureSnapshot());
    const roundHandles = vi.fn(async () => ({
      checked: 0,
      skippedTrailing: 0,
      flags: [],
    }));
    runtime.client = {
      ibkrMonitor: { snapshot, roundHandles },
    } as unknown as ApiClient;
    const gateway = createBrowserIbkrMonitorGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.snapshot();
    await gateway.roundHandles();
    await gateway.snapshot();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(gateway)).toBe(true);
  });

  it("defaults to Positions and maps the v1 values onto the v2 tabs", () => {
    expect(PORTFOLIO_VIEW_STORAGE_KEY).toBe("vertex.portfolio.view.v2");
    expect(LEGACY_PORTFOLIO_VIEW_STORAGE_KEY).toBe("vertex.portfolio.view.v1");
    expect(
      [
        undefined,
        null,
        "ibkr",
        "agents",
        "projection",
        "orders",
        "options",
        "orders-stops",
      ].map(normalizePortfolioView)
    ).toEqual([
      "positions",
      "positions",
      "positions",
      "positions",
      "projection",
      "orders",
      "options",
      "orders-stops",
    ]);
  });

  it("migrates the v1 choice only when no v2 choice is saved", () => {
    expect(migrateLegacyPortfolioView()).toBeNull();
    window.localStorage.setItem(LEGACY_PORTFOLIO_VIEW_STORAGE_KEY, '"ibkr"');
    expect(migrateLegacyPortfolioView()).toBe("positions");
    window.localStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, '"pnl"');
    expect(migrateLegacyPortfolioView()).toBeNull();
  });

  it("restores a v1 projection choice on first load and saves it under v2", async () => {
    const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
    testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.setItem(
      LEGACY_PORTFOLIO_VIEW_STORAGE_KEY,
      '"projection"'
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortfolioTabs
            gateway={{ snapshot: vi.fn(async () => fixtureSnapshot()) }}
            operator
            projection={<p>projection-marker</p>}
          />
        );
      });
      expect(container.textContent).toContain("projection-marker");
      expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
        '"projection"'
      );
    } finally {
      await act(async () => root.unmount());
      if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
      else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it("shows one tab strip with the sections, then the page views", async () => {
    const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
    testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortfolioTabs
            gateway={{ snapshot: vi.fn(async () => fixtureSnapshot()) }}
            operator
            projection={<p>projection-marker</p>}
          />
        );
      });
      expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
      expect(
        [...container.querySelectorAll('[role="tab"]')].map(
          (tab) => tab.textContent
        )
      ).toEqual([
        "Positions",
        "Orders & stops",
        "P&L",
        "Allocation",
        "Options",
        "Projection",
        "Vertex orders",
      ]);
      expect(container.textContent).toContain("Positions (");
      await act(async () => {
        tabNamed(container, "Options").click();
      });
      expect(container.textContent).toContain("Option positions (");
      expect(window.location.search).toBe("?tab=options");
      expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
        '"options"'
      );
    } finally {
      await act(async () => root.unmount());
      if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
      else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it("renders on the server with both tabs, the IBKR view and no network", () => {
    const snapshot = vi.fn(async () => fixtureSnapshot());
    const html = renderToString(
      <PortfolioTabs
        gateway={{ snapshot }}
        operator
        projection={<p>projection-marker</p>}
      />
    );
    expect(html).toContain("Orders &amp; stops");
    expect(html).toContain("Projection");
    expect(html).toContain("Portfolio · IBKR (via ibkr-monitor)");
    expect(html).not.toContain("projection-marker");
    expect(html).not.toMatch(/ibkr-2fa|2FA/);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("renders the ?tab= view from the server request on the first paint", () => {
    const html = renderToString(
      <PortfolioTabs
        gateway={{ snapshot: vi.fn(async () => fixtureSnapshot()) }}
        initialTab="projection"
        operator
        projection={<p>projection-marker</p>}
      />
    );
    expect(html).toContain("projection-marker");
    return expect(html).toMatch(/aria-selected="true"[^>]*>Projection</u);
  });

  it("gives a non-operator the projection only, with no IBKR view or request", () => {
    const snapshot = vi.fn(async () => fixtureSnapshot());
    window.localStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, '"ibkr"');
    const html = renderToString(
      <PortfolioTabs
        gateway={{ snapshot }}
        projection={<p>projection-marker</p>}
      />
    );
    expect(html).toContain("projection-marker");
    expect(html).not.toContain("Orders &amp; stops");
    expect(html).not.toContain('role="tab"');
    return expect(snapshot).not.toHaveBeenCalled();
  });

  it("switches to the projection and remembers the choice", async () => {
    const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
    testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    const snapshot = vi.fn(async () => fixtureSnapshot());
    runtime.client = { ibkrMonitor: { snapshot } } as unknown as ApiClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortfolioTabs operator projection={<p>projection-marker</p>} />
        );
      });
      expect(container.textContent).toContain(
        "Portfolio · IBKR (via ibkr-monitor)"
      );
      await act(async () => {
        tabNamed(container, "Projection").click();
      });
      expect(container.textContent).toContain("projection-marker");
      expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toContain(
        "projection"
      );
    } finally {
      await act(async () => root.unmount());
      if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
      else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it("opens the Orders view with the supplied orders gateway", async () => {
    const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
    testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, '"orders"');
    expect(normalizePortfolioView("orders")).toBe("orders");
    const status = vi.fn(async () => {
      throw new Error("orders-status-called");
    });
    const ordersGateway = { status } as unknown as VertexOrdersGateway;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <PortfolioTabs
            gateway={{ snapshot: vi.fn(async () => fixtureSnapshot()) }}
            operator
            ordersGateway={ordersGateway}
            projection={<p>projection-marker</p>}
          />
        );
      });
      expect(container.textContent).toContain("Orders · options only");
      expect(status).toHaveBeenCalledWith({});
    } finally {
      await act(async () => root.unmount());
      if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
      else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
  it("opens the view named in ?tab= and keeps the saved view on a plain load", async () => {
    window.localStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, '"allocation"');
    window.history.replaceState(null, "", "/portfolio?tab=pnl");
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      expect(tabNamed(container, "P&L").getAttribute("aria-selected")).toBe(
        "true"
      );
      // Opened by the URL: saved for the next plain visit.
      expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
        '"pnl"'
      );
    });
    window.history.replaceState(null, "", "/portfolio");
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      expect(tabNamed(container, "P&L").getAttribute("aria-selected")).toBe(
        "true"
      );
      expect(window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)).toBe(
        '"pnl"'
      );
      expect(window.location.search).toBe("");
    });
  });

  it("ignores an unknown ?tab= value and saves nothing", async () => {
    window.history.replaceState(null, "", "/portfolio?tab=nope");
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      expect(
        tabNamed(container, "Positions").getAttribute("aria-selected")
      ).toBe("true");
      expect(
        window.localStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY)
      ).toBeNull();
    });
  });

  it("orders the page: header, summary, sticky tab bar, then the open view", async () => {
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      const heading = container.querySelector("h1");
      const summary = container.querySelector(
        "[data-slot=collapsible-summary]"
      );
      const bar = container.querySelector("[role=tablist]");
      const panel = container.querySelector("[role=tabpanel]:not([hidden])");
      expect(heading?.textContent).toBe("Portfolio");
      expect(
        summary?.querySelector("[data-stat=netLiquidation]")
      ).not.toBeNull();
      // querySelectorAll returns document order.
      expect([
        ...container.querySelectorAll(
          "h1, [data-slot=collapsible-summary], [role=tablist], [role=tabpanel]:not([hidden])"
        ),
      ]).toEqual([heading, summary, bar, panel]);
      expect(bar?.className).toContain("sticky");
      expect(bar?.getAttribute("aria-label")).toBe("Portfolio views");
      expect(panel?.textContent).toContain("Positions (");
    });
  });

  it("folds the summary and keeps it folded on the next visit", async () => {
    const toggle = (container: HTMLElement) => {
      const button = container.querySelector<HTMLButtonElement>(
        "[data-slot=collapsible-summary] > button"
      );
      if (button === null) throw new Error("Missing summary toggle");
      return button;
    };
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      expect(toggle(container).getAttribute("aria-expanded")).toBe("true");
      expect(toggle(container).textContent).toBe("Summary");
      await act(async () => toggle(container).click());
      expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
      expect(
        window.localStorage.getItem("vertex.summary.portfolio.collapsed")
      ).toBe("true");
      // The tab bar and the open view stay; only the KPI block folds.
      expect(container.querySelector("[role=tablist]")).not.toBeNull();
      expect(
        container
          .querySelector("[data-slot=collapsible-summary-content]")
          ?.hasAttribute("hidden")
      ).toBe(true);
    });
    await withRoot(async (container, root) => {
      await act(async () => root.render(operatorTabs()));
      expect(toggle(container).getAttribute("aria-expanded")).toBe("false");
      await act(async () => toggle(container).click());
      expect(
        window.localStorage.getItem("vertex.summary.portfolio.collapsed")
      ).toBe("false");
    });
  });
});
