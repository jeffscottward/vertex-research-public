// @vitest-environment jsdom
import type { ApiClient } from "@darkfactory/api";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
  document.body.innerHTML = "";
});

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

  it("shows one tab strip: the monitor's own section tabs are not rendered", async () => {
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
        container
          .querySelector<HTMLButtonElement>("#portfolio-tab-options")
          ?.click();
      });
      expect(container.textContent).toContain("Option positions (");
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
      const tab = container.querySelector<HTMLButtonElement>(
        "#portfolio-tab-projection"
      );
      await act(async () => {
        tab?.click();
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
});
