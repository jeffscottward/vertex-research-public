// @vitest-environment jsdom
import type {
  GreekHeatmapMetricData,
  GreekHeatmapOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GreekHeatmapPanel } from "./greek-heatmap-panel.tsx";
import {
  createBrowserOptionsAnalyticsGateway,
  type OptionsAnalyticsGateway,
} from "./options-analytics-client.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await act(async () => undefined);
  return { container, root };
};

const metric = (
  overrides: Partial<GreekHeatmapMetricData> = {}
): GreekHeatmapMetricData => ({
  expiryTotals: [1_500_000, -500_000],
  grandTotal: 1_000_000,
  marks: {
    callWall: 610,
    flip: 602.5,
    kingStrike: 610,
    putWall: 595,
  },
  message: null,
  rows: [
    { strike: 610, total: 2_400_000, values: [2_000_000, 400_000] },
    { strike: 605, total: 300_000, values: [300_000, null] },
    { strike: 600, total: -100_000, values: [-50_000, -50_000] },
    { strike: 595, total: -1_600_000, values: [-750_000, -850_000] },
  ],
  status: "ok",
  ...overrides,
});

const fixture = (
  overrides: Partial<GreekHeatmapOutput> = {}
): GreekHeatmapOutput => ({
  expiries: [
    { dte: 1, expiry: "2026-11-23" },
    { dte: 28, expiry: "2026-12-20" },
  ],
  message: null,
  metrics: {
    charm: metric({
      marks: { callWall: 605, flip: null, kingStrike: 605, putWall: 595 },
    }),
    dex: metric({
      marks: { callWall: 610, flip: null, kingStrike: 610, putWall: 595 },
    }),
    gex: metric(),
    vex: metric({
      marks: { callWall: 610, flip: null, kingStrike: 610, putWall: 595 },
    }),
    volumeGex: metric({
      expiryTotals: [900_000, null],
      marks: { callWall: 605, flip: 600, kingStrike: 605, putWall: 595 },
    }),
  },
  notes: ["Research view only. Estimates are not trade signals."],
  rateLimited: false,
  receivedAt: "2026-11-22T15:00:00.000Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: 604.2,
  status: "ok",
  symbol: "SPY",
  ...overrides,
});

const gatewayOf = (
  greekHeatmap: OptionsAnalyticsGateway["greekHeatmap"]
): OptionsAnalyticsGateway => ({
  greekHeatmap,
  snapshot: vi.fn(),
});

describe("GreekHeatmapPanel", () => {
  it("renders all five tabs, marks, dividers, keyboard navigation and footer totals", async () => {
    const greekHeatmap = vi.fn(async () => fixture());
    const { container } = await mount(
      <GreekHeatmapPanel gateway={gatewayOf(greekHeatmap)} symbol="SPY" />
    );

    expect(greekHeatmap).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(container.textContent).toContain("Spot $604.20 · 2 expiries");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);

    // GEX tab active by default with King, Call wall, Put wall, Spot & Flip dividers.
    expect(
      container.querySelector('[data-heatmap-mark="king"]')?.textContent
    ).toContain("$610.00");
    expect(
      container.querySelector('[data-heatmap-mark="call-wall"]')?.textContent
    ).toContain("$610.00");
    expect(
      container.querySelector('[data-heatmap-mark="put-wall"]')?.textContent
    ).toContain("$595.00");
    expect(
      container.querySelector('[data-heatmap-mark="flip"]')?.textContent
    ).toContain("$602.50");
    expect(
      container.querySelector('[data-heatmap-divider="spot"]')?.textContent
    ).toContain("Spot $604.20");
    expect(
      container.querySelector('[data-heatmap-divider="flip"]')?.textContent
    ).toContain("Gamma flip $602.50");
    expect(container.querySelector('[data-mark-badge="king"]')).not.toBeNull();
    expect(
      container.querySelector('[data-mark-badge="call-wall"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-mark-badge="put-wall"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-heatmap-grand-total]")?.textContent
    ).toBe("+$1.0M");

    // Click Volume-GEX tab: flip lands directly ON strike 600 ("at" badge) and col 2 total is null.
    const volTab = container.querySelector<HTMLButtonElement>(
      '[data-heatmap-tab="volumeGex"]'
    );
    await act(async () => {
      volTab?.click();
    });
    expect(
      container
        .querySelector("[data-greek-heatmap-table]")
        ?.getAttribute("data-metric")
    ).toBe("volumeGex");
    expect(container.querySelector('[data-mark-badge="flip"]')).not.toBeNull();

    // Keyboard navigation on tablist: ArrowRight wraps to gex, ArrowLeft back, Home, End, and ignored key.
    const tablist = container.querySelector<HTMLDivElement>('[role="tablist"]');
    const press = async (key: string) => {
      await act(async () => {
        tablist?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key })
        );
      });
    };
    await press("ArrowRight");
    expect(
      container
        .querySelector('[data-heatmap-tab="gex"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    await press("ArrowRight");
    expect(
      container
        .querySelector('[data-heatmap-tab="vex"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    // VEX tab shows GEX flip reference.
    expect(
      container.querySelector('[data-heatmap-mark="flip"]')?.textContent
    ).toContain("GEX flip (ref.)");
    await press("End");
    expect(
      container
        .querySelector('[data-heatmap-tab="volumeGex"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    await press("Home");
    expect(
      container
        .querySelector('[data-heatmap-tab="gex"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    await press("a");
    expect(
      container
        .querySelector('[data-heatmap-tab="gex"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
  });

  it("renders exact-spot badge, single expiry label, null totals/marks, rate limits and metric failures", async () => {
    const sparse = fixture({
      expiries: [{ dte: 0, expiry: "2026-11-22" }],
      metrics: {
        charm: metric({
          expiryTotals: [null],
          grandTotal: null,
          marks: {
            callWall: null,
            flip: null,
            kingStrike: null,
            putWall: null,
          },
          rows: [{ strike: 600, total: null, values: [null] }],
        }),
        dex: metric({
          expiryTotals: [],
          grandTotal: null,
          marks: {
            callWall: null,
            flip: null,
            kingStrike: null,
            putWall: null,
          },
          message: null,
          rows: [],
          status: "empty",
        }),
        gex: metric({
          expiryTotals: [null],
          grandTotal: null,
          marks: {
            callWall: null,
            flip: null,
            kingStrike: null,
            putWall: null,
          },
          rows: [{ strike: 600, total: null, values: [null] }],
        }),
        vex: metric({
          expiryTotals: [],
          grandTotal: null,
          marks: {
            callWall: null,
            flip: null,
            kingStrike: null,
            putWall: null,
          },
          message: "QuantData heatMap: HTTP 422.",
          rows: [],
          status: "failed",
        }),
        volumeGex: metric({
          expiryTotals: [],
          grandTotal: null,
          marks: {
            callWall: null,
            flip: null,
            kingStrike: null,
            putWall: null,
          },
          message: "No volume today.",
          rows: [],
          status: "empty",
        }),
      },
      rateLimited: true,
      retryAfterSeconds: 45,
      spot: 600,
    });

    const { container, root } = await mount(
      <GreekHeatmapPanel gateway={gatewayOf(async () => sparse)} symbol="QQQ" />
    );
    expect(container.textContent).toContain("Spot $600.00 · 1 expiry");
    expect(container.querySelector('[data-mark-badge="spot"]')).not.toBeNull();
    expect(
      container.querySelector("[data-heatmap-rate-limited]")?.textContent
    ).toContain("retry in 45 s");
    expect(
      container.querySelector('[data-heatmap-mark="king"]')?.textContent
    ).toContain("no exposure");
    expect(
      container.querySelector('[data-heatmap-mark="call-wall"]')?.textContent
    ).toContain("no positive");
    expect(
      container.querySelector('[data-heatmap-mark="put-wall"]')?.textContent
    ).toContain("no negative");
    expect(
      container.querySelector('[data-heatmap-mark="flip"]')?.textContent
    ).toContain("no zero crossing");
    expect(
      container.querySelector("[data-heatmap-grand-total]")?.textContent
    ).toBe("no exposure");

    // Switch to VEX (failed with explicit message) and DEX (empty with null message -> fallback text).
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-heatmap-tab="vex"]')
        ?.click();
    });
    expect(
      container.querySelector("[data-heatmap-metric-status]")?.textContent
    ).toContain("HTTP 422");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-heatmap-tab="dex"]')
        ?.click();
    });
    expect(
      container.querySelector("[data-heatmap-metric-status]")?.textContent
    ).toContain("No Greek exposure rows returned for this metric.");

    // Rate limit with null retryAfterSeconds and null spot.
    await act(async () => {
      root.render(
        <GreekHeatmapPanel
          gateway={gatewayOf(async () =>
            fixture({ rateLimited: true, retryAfterSeconds: null, spot: null })
          )}
          reloadToken={1}
          symbol="QQQ"
        />
      );
    });
    await act(async () => undefined);
    expect(
      container.querySelector("[data-heatmap-rate-limited]")?.textContent
    ).toBe("QuantData rate limit active.");
  });

  it("shows errors with Retry, drops stale responses, and wires the browser gateway", async () => {
    const deferred = () => {
      let resolve: (value: GreekHeatmapOutput) => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      const promise = new Promise<GreekHeatmapOutput>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, reject, resolve };
    };
    const first = deferred();
    const second = deferred();
    let call = 0;
    const greekHeatmap = vi.fn(() => {
      call += 1;
      if (call === 1) return first.promise;
      if (call === 2) return second.promise;
      return Promise.resolve(fixture());
    });

    const { container, root } = await mount(
      <GreekHeatmapPanel gateway={gatewayOf(greekHeatmap)} symbol="SPY" />
    );
    expect(container.querySelector("[data-heatmap-loading]")).not.toBeNull();

    // Change symbol before first rejects -> stale error is ignored.
    await act(async () => {
      root.render(
        <GreekHeatmapPanel gateway={gatewayOf(greekHeatmap)} symbol="NVDA" />
      );
    });
    await act(async () => {
      first.reject(
        Object.assign(new Error("No key"), { code: "NOT_CONFIGURED" })
      );
    });
    expect(container.querySelector("[data-heatmap-error]")).toBeNull();

    // Change symbol again so second resolution is also stale, then let third resolve.
    await act(async () => {
      root.render(
        <GreekHeatmapPanel gateway={gatewayOf(greekHeatmap)} symbol="AAPL" />
      );
    });
    await act(async () => {
      second.resolve(fixture({ symbol: "NVDA" }));
    });
    await act(async () => undefined);
    expect(
      container
        .querySelector("[data-greek-heatmap]")
        ?.getAttribute("data-symbol")
    ).toBe("AAPL");

    // Trigger real error and click Retry.
    let attempt = 0;
    const retryGateway = gatewayOf(async () => {
      attempt += 1;
      if (attempt === 1)
        throw Object.assign(new Error("No QuantData key"), {
          code: "NOT_CONFIGURED",
        });
      return fixture({ symbol: "TSLA" });
    });
    const retryView = await mount(
      <GreekHeatmapPanel gateway={retryGateway} symbol="TSLA" />
    );
    expect(
      retryView.container
        .querySelector("[data-heatmap-error]")
        ?.getAttribute("data-heatmap-error")
    ).toBe("NOT_CONFIGURED");
    await act(async () => {
      retryView.container.querySelector<HTMLButtonElement>("button")?.click();
    });
    // Click the Retry button inside the alert.
    await act(async () => {
      retryView.container
        .querySelector<HTMLButtonElement>('[role="alert"] button')
        ?.click();
    });
    await act(async () => undefined);
    expect(
      retryView.container.querySelector("[data-greek-heatmap-table]")
    ).not.toBeNull();

    // Exercise createBrowserOptionsAnalyticsGateway().greekHeatmap.
    const browser = createBrowserOptionsAnalyticsGateway();
    await browser.greekHeatmap({ symbol: "SPY" }).catch(() => undefined);
  });
});
