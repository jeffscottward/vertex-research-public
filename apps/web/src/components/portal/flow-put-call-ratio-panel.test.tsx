// @vitest-environment jsdom
import { type FlowPutCallRatio, PUT_CALL_RATIO_RULES } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { FlowPutCallRatioPanel } from "./flow-put-call-ratio-panel.tsx";

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
  return {
    container,
    rerender: async (next: ReactElement) => {
      await act(async () => root.render(next));
    },
  };
};

const clickTab = async (container: HTMLElement, tab: "session" | "days") => {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-flow-pcr-tab='${tab}']`
  );
  if (button === null) throw new Error(`Missing tab button: ${tab}`);
  await act(async () => {
    button.click();
  });
};

const baseResponse = (
  overrides: Partial<FlowPutCallRatio> = {}
): FlowPutCallRatio => ({
  days: [
    {
      callPremium: 10_000_000,
      callPrints: 80,
      callVolume: 2000,
      incomplete: false,
      premiumRatio: 0.8,
      price: 658.4,
      prints: 150,
      putPremium: 8_000_000,
      putPrints: 70,
      putVolume: 1800,
      session: "2026-11-18",
      volumeRatio: 0.9,
    },
    {
      callPremium: 12_000_000,
      callPrints: 90,
      callVolume: 2400,
      incomplete: true,
      premiumRatio: 1.25,
      price: 660.1,
      prints: 195,
      putPremium: 15_000_000,
      putPrints: 105,
      putVolume: 2880,
      session: "2026-11-19",
      volumeRatio: 1.2,
    },
    {
      callPremium: 11_000_000,
      callPrints: 85,
      callVolume: 2200,
      incomplete: false,
      premiumRatio: 1.1,
      price: 661.5,
      prints: 175,
      putPremium: 12_100_000,
      putPrints: 90,
      putVolume: 2310,
      session: "2026-11-20",
      volumeRatio: 1.05,
    },
  ],
  options: {
    ageSeconds: 30,
    lastOkAt: "2026-11-20T15:00:00.000Z",
    lastStatus: "ok",
    message: "quantdata flow: 20 prints",
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  points: [
    {
      callPremium: 2_000_000,
      callVolume: 400,
      minute: "2026-11-20T14:30:00.000Z",
      premiumRatio: 0.75,
      price: 660.5,
      prints: 10,
      putPremium: 1_500_000,
      putVolume: 360,
      volumeRatio: 0.9,
    },
    {
      callPremium: 4_000_000,
      callVolume: 800,
      minute: "2026-11-20T14:45:00.000Z",
      premiumRatio: 1.4,
      price: 661.5,
      prints: 12,
      putPremium: 5_600_000,
      putVolume: 1040,
      volumeRatio: 1.3,
    },
  ],
  rules: { ...PUT_CALL_RATIO_RULES },
  schemaVersion: "flow-put-call-ratio.v1",
  session: "2026-11-20",
  storedUntil: "2026-11-20T14:45:42.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    callPremium: 4_000_000,
    callPrints: 10,
    callVolume: 800,
    premiumHigh: { minute: "2026-11-20T14:45:00.000Z", ratio: 1.4 },
    premiumLow: { minute: "2026-11-20T14:30:00.000Z", ratio: 0.75 },
    premiumRatio: 1.4,
    prints: 22,
    putPremium: 5_600_000,
    putPrints: 12,
    putVolume: 1040,
    volumeHigh: { minute: "2026-11-20T14:45:00.000Z", ratio: 1.3 },
    volumeLow: { minute: "2026-11-20T14:30:00.000Z", ratio: 0.9 },
    volumeRatio: 1.3,
  },
  unread: null,
  ...overrides,
});

describe("FlowPutCallRatioPanel", () => {
  it("renders the loading state with reserved height", async () => {
    const { container } = await mount(
      <FlowPutCallRatioPanel
        document={null}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(container.textContent).toContain("Put/call ratio · SPY options");
    expect(container.querySelector("[role='status']")?.textContent).toContain(
      "Loading put/call ratio"
    );
    const root = container.querySelector("[data-flow-pcr='SPY']");
    expect(root?.getAttribute("data-flow-pcr-state")).toBe("loading");
    expect(root?.className).toContain("min-h-72");
  });

  it("renders the failure alert and preserves the previous response when present", async () => {
    const failedAt = Date.parse("2026-11-20T15:00:00.000Z");
    const { container, rerender } = await mount(
      <FlowPutCallRatioPanel
        document={null}
        failure={{ code: "STORAGE_ERROR", failedAt, message: "db down" }}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "STORAGE_ERROR: db down"
    );
    expect(
      container
        .querySelector("[data-flow-pcr='ES']")
        ?.getAttribute("data-flow-pcr-state")
    ).toBe("failed");

    await rerender(
      <FlowPutCallRatioPanel
        document={baseResponse({ symbol: "ES", ticker: "SPX" })}
        failure={{ code: "STORAGE_ERROR", failedAt, message: "db down" }}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "db down"
    );
    expect(
      container.querySelector("[data-flow-pcr-chart='session']")
    ).not.toBeNull();
  });

  it("renders the empty state when session is null", async () => {
    const { container } = await mount(
      <FlowPutCallRatioPanel
        document={baseResponse({
          days: [],
          points: [],
          session: null,
          storedUntil: null,
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-pcr-empty]")?.textContent
    ).toContain("No option prints stored for SPY");
  });

  it("renders the session chart with unread shade and switches cleanly between Session and Days views", async () => {
    const { container } = await mount(
      <FlowPutCallRatioPanel
        document={baseResponse({
          unread: {
            from: "2026-11-20T14:35:00.000Z",
            ranges: 1,
            to: "2026-11-20T14:40:00.000Z",
          },
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelector("[data-flow-pcr-view='session']")
    ).not.toBeNull();
    expect(container.querySelector("[data-flow-pcr-unread]")).not.toBeNull();
    expect(container.querySelector("[data-flow-pcr-parity]")).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-line='premium']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-line='volume']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-legend='unread']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-totals]")?.textContent
    ).toContain("Premium P/C 1.40");
    expect(
      container.querySelector("[data-flow-pcr-rule]")?.textContent
    ).toContain("put-call-ratio.v1");

    await clickTab(container, "days");
    expect(
      container.querySelector("[data-flow-pcr-view='days']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-chart='days']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-incomplete='2026-11-19']")
    ).not.toBeNull();
    expect(
      container.querySelectorAll("[data-flow-pcr-marker='premium']")
    ).toHaveLength(3);
    expect(
      container.querySelectorAll("[data-flow-pcr-marker='volume']")
    ).toHaveLength(3);
    expect(
      container.querySelectorAll("[data-flow-pcr-price-marker]")
    ).toHaveLength(3);
    expect(
      container.querySelector("[data-flow-pcr-days-table]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-days-table]")?.textContent
    ).toContain("Incomplete");
    expect(
      container.querySelector("[data-flow-pcr-days-table]")?.textContent
    ).toContain("Stored");

    await clickTab(container, "session");
    expect(
      container.querySelector("[data-flow-pcr-view='session']")
    ).not.toBeNull();
  });

  it("renders honest status messages when points or days have no regular prints or no calls, and handles partial paths and prices", async () => {
    const { container, rerender } = await mount(
      <FlowPutCallRatioPanel
        document={baseResponse({
          days: [],
          points: [],
          storedUntil: null,
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-pcr-no-points]")?.textContent
    ).toContain("No regular-session option print stored for this session.");

    await clickTab(container, "days");
    expect(
      container.querySelector("[data-flow-pcr-no-days]")?.textContent
    ).toContain("No regular-session option print stored in the last 14 days.");
    expect(container.querySelector("[data-flow-pcr-days-table]")).toBeNull();

    // Put-only prints (no calls) in session and in days
    await rerender(
      <FlowPutCallRatioPanel
        document={baseResponse({
          days: [
            {
              ...baseResponse().days[0]!,
              premiumRatio: null,
              price: null,
              volumeRatio: null,
            },
          ],
          points: [
            {
              ...baseResponse().points[0]!,
              premiumRatio: null,
              price: null,
              volumeRatio: null,
            },
          ],
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-pcr-no-days]")?.textContent
    ).toContain("no call prints in the stored sessions");
    await clickTab(container, "session");
    expect(
      container.querySelector("[data-flow-pcr-no-points]")?.textContent
    ).toContain("no call prints in this session");

    // Partial paths: session with volumeRatio null and price null
    await rerender(
      <FlowPutCallRatioPanel
        document={baseResponse({
          days: [
            {
              ...baseResponse().days[0]!,
              incomplete: false,
              premiumRatio: 1.2,
              price: null,
              volumeRatio: null,
            },
          ],
          points: [
            {
              ...baseResponse().points[0]!,
              premiumRatio: 1.2,
              price: null,
              volumeRatio: null,
            },
          ],
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-pcr-line='premium']")
    ).not.toBeNull();
    expect(container.querySelector("[data-flow-pcr-line='volume']")).toBeNull();
    expect(container.querySelector("[data-flow-pcr-line='price']")).toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-legend='unread']")
    ).toBeNull();

    // Session with premiumRatio null, volumeRatio present
    await rerender(
      <FlowPutCallRatioPanel
        document={baseResponse({
          days: [
            {
              ...baseResponse().days[0]!,
              incomplete: false,
              premiumRatio: null,
              price: null,
              volumeRatio: 1.1,
            },
          ],
          points: [
            {
              ...baseResponse().points[0]!,
              premiumRatio: null,
              price: null,
              volumeRatio: 1.1,
            },
          ],
        })}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-pcr-line='premium']")
    ).toBeNull();
    expect(
      container.querySelector("[data-flow-pcr-line='volume']")
    ).not.toBeNull();

    // Days view with single day (null polylines, 1 marker, no incomplete band)
    await clickTab(container, "days");
    expect(
      container.querySelector("[data-flow-pcr-line='premium']")
    ).toBeNull();
    expect(container.querySelector("[data-flow-pcr-line='volume']")).toBeNull();
    expect(
      container.querySelectorAll("[data-flow-pcr-marker='volume']")
    ).toHaveLength(1);
    expect(
      container.querySelector("[data-flow-pcr-legend='unread']")
    ).toBeNull();
  });
});
