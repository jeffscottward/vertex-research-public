// @vitest-environment jsdom
import type { ApiClient, MarketVolatilityOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
  createBrowserMarketContextGateway,
  MARKET_CONTEXT_REFRESH_MS,
  MarketContextWorkspace,
} from "./market-context-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
  vi.useRealTimers();
});

const series = (value: number, stale = false) => ({
  value,
  asOf: "2026-10-20",
  change1d: 0.4,
  pct1y: 62,
  stale,
});

const ready = (
  overrides: Partial<MarketVolatilityOutput> = {}
): MarketVolatilityOutput => ({
  vix: series(17.2),
  vixeq: series(24.1),
  vvix: series(95, true),
  spread: null,
  spx: { price: 5800, movePct: -0.35, sessionOpen: true },
  implied: { impliedPct: 1.08, multiple: 0.32, band: "review" },
  sourceErrors: [],
  ...overrides,
});

const mount = async (volatility: () => Promise<MarketVolatilityOutput>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<MarketContextWorkspace gateway={{ volatility }} />)
  );
  return container;
};

describe("Market context", () => {
  it("shows volatility series, the S&P 500 move and the move band", async () => {
    const container = await mount(async () => ready());
    expect(
      container.querySelector('[data-series="VIX"]')?.textContent
    ).toContain("17.20");
    expect(
      container.querySelector('[data-series="VVIX"]')?.textContent
    ).toContain("stale");
    expect(
      container.querySelector('[data-series="VIXEQ − VIX"]')?.textContent
    ).toContain("Unknown");
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "5800.00 (-0.35%)"
    );
    expect(
      container.querySelector('[data-band="review"]')?.textContent
    ).toContain("Review: large move");
    expect(container.querySelector("[data-source-errors]")).toBeNull();
    expect(
      container.querySelector('[role="group"][aria-label="Volatility"]')
        ?.children
    ).toHaveLength(4);
    expect(container.querySelector('[data-series="VIX"] dd')?.textContent).toBe(
      "17.20"
    );
    expect(container.querySelector("#mc-move")?.textContent).toBe(
      "S&P 500 move today"
    );
  });

  it("reports its state to the page and reloads on the refresh signal", async () => {
    const statuses: string[] = [];
    const onStatusChange = (status: string) => {
      statuses.push(status);
    };
    let fail = false;
    const volatility = vi.fn(async () => {
      if (fail) throw { code: "UNAVAILABLE", message: "down" };
      return ready();
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <MarketContextWorkspace
          gateway={{ volatility }}
          onStatusChange={onStatusChange}
        />
      )
    );
    expect(statuses).toEqual(["loading", "ready"]);
    fail = true;
    await act(async () =>
      root.render(
        <MarketContextWorkspace
          gateway={{ volatility }}
          onStatusChange={onStatusChange}
          refreshSignal={1}
        />
      )
    );
    expect(volatility).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("error");
  });

  it("states unknown sections and source errors without inventing values", async () => {
    const container = await mount(async () =>
      ready({
        spx: { price: 5800, movePct: null, sessionOpen: false },
        implied: null,
        sourceErrors: ["Cboe: HTTP 503"],
        vix: { ...series(17.2), change1d: 1.2, pct1y: null },
      })
    );
    expect(container.querySelector("[data-source-errors]")?.textContent).toBe(
      "Cboe: HTTP 503"
    );
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "Session closed"
    );
    expect(container.querySelector("[data-spx]")?.textContent).toContain("—");
    expect(
      container.querySelector('[data-series="VIX"]')?.textContent
    ).toContain("+1.20");
    const none = await mount(async () =>
      ready({
        spx: null,
        implied: { impliedPct: 1, multiple: 1, band: null },
      })
    );
    expect(none.textContent).toContain("S&P 500 quote unknown.");
    const unbanded = await mount(async () =>
      ready({ implied: { impliedPct: 1, multiple: 1, band: null } })
    );
    expect(unbanded.querySelector("[data-band]")).toBeNull();
  });

  it("shows failures with a retry and access-required for non-operators", async () => {
    let fail = true;
    const container = await mount(async () => {
      if (fail) throw { code: "UNAVAILABLE", message: "ibkr-monitor down" };
      return ready();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "UNAVAILABLE: ibkr-monitor down"
    );
    fail = false;
    await act(async () => container.querySelector("button")?.click());
    expect(
      container.querySelector('[data-market-state="ready"]')
    ).not.toBeNull();
    const denied = await mount(async () => {
      throw { code: "FORBIDDEN", status: 403, message: "Forbidden" };
    });
    expect(denied.querySelector("[data-market-state]")).toBeNull();
    expect(denied.textContent).toMatch(/operator/iu);
  });

  it("shows loading first and refreshes once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolveFirst: (value: MarketVolatilityOutput) => void = () => undefined;
    // The web tsconfig lib predates Promise.withResolvers.
    const pending = new Promise<MarketVolatilityOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const volatility = vi.fn(() => pending);
    const container = await mount(volatility);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading market context…"
    );
    await act(async () => resolveFirst(ready()));
    await act(async () => {
      vi.advanceTimersByTime(MARKET_CONTEXT_REFRESH_MS);
    });
    expect(volatility).toHaveBeenCalledTimes(2);
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const volatility = vi.fn(async () => ready());
    runtime.client = { ibkrMonitor: { volatility } } as unknown as ApiClient;
    const gateway = createBrowserMarketContextGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.volatility();
    await gateway.volatility();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(volatility).toHaveBeenCalledWith({});
    expect(Object.isFrozen(gateway)).toBe(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<MarketContextWorkspace />));
    expect(volatility).toHaveBeenCalledTimes(3);
  });
});
