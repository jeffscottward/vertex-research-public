// @vitest-environment jsdom
import { JevVerdictOutputSchema } from "@darkfactory/api";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/charts/market-chart.tsx", () => ({
  MarketBarsChart: () => <div data-chart="" />,
}));

import { mountLab, unmountLab } from "../test-support.tsx";
import {
  CHARTS_LAB_ENTRIES,
  labJevVerdictGateway,
  labOptionsAnalyticsGateway,
  labOrderFlowNoDepthGateway,
} from "./charts.tsx";

afterEach(async () => {
  await unmountLab();
  window.history.replaceState(null, "", "/");
});

describe("charts lab entry", () => {
  it("renders the charts workspace with fake NVDA bars from ?symbol=", async () => {
    window.history.replaceState(null, "", "/lab/charts?symbol=NVDA");
    const [entry] = CHARTS_LAB_ENTRIES;
    const host = await mountLab(
      entry?.render(new URLSearchParams("symbol=NVDA"))
    );
    expect(host.querySelector("h1")?.textContent).toBe("Charts");
    expect(host.textContent).toContain("NVDA");
    expect(host.textContent).toContain("fake data");
  });

  it("shows the open-interest panel with made-up figures when ES is opened as a future", async () => {
    window.history.replaceState(null, "", "/lab/charts");
    const [entry] = CHARTS_LAB_ENTRIES;
    const host = await mountLab(entry?.render(new URLSearchParams()));
    const pick = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Quick pick"]'
    );
    await act(async () => {
      if (pick !== null) pick.value = "ES (E-mini S&P)";
      pick?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const open = [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Open"
    );
    await act(async () => open?.click());
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-futures-oi="ES"] [data-futures-oi-newest]')
          ?.textContent
      ).toContain("Open interest, ES futures, all contract months")
    );
    expect(host.querySelector('[data-futures-oi="ES"]')?.textContent).toContain(
      "1 loaded trading day after 2026-10-29 has no CME figure yet."
    );
  });

  it("renders every order flow tab from fictional fixtures", async () => {
    window.history.replaceState(null, "", "/lab/charts");
    const [entry] = CHARTS_LAB_ENTRIES;
    const host = await mountLab(entry?.render(new URLSearchParams()));
    await vi.waitFor(() =>
      expect(host.querySelector("[data-order-flow]")).not.toBeNull()
    );
    const load = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Load order flow"
    );
    await act(async () => load?.click());
    const open = async (tab: string, selector: string) => {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(`[data-order-flow-tab="${tab}"]`)
          ?.click()
      );
      await vi.waitFor(() =>
        expect(host.querySelector(selector)).not.toBeNull()
      );
    };
    await open("tape", "[data-time-sales]");
    await open("book", "[data-depth-ladder]");
    expect(host.querySelector("[data-depth-curve-svg]")).not.toBeNull();
    expect(host.querySelector("[data-venue-notice]")?.textContent).toContain(
      "LAB-D"
    );
    await open("footprint", "[data-footprint]");
    await open("delta", "[data-cvd-chart]");
    await open("tpo", "[data-tpo-profile]");
  });

  it("fails the depth snapshot with ENTITLEMENT for ?depth=entitlement", async () => {
    await expect(
      labOrderFlowNoDepthGateway.depth({ symbol: "SPY" })
    ).rejects.toMatchObject({ code: "ENTITLEMENT" });
    const [entry] = CHARTS_LAB_ENTRIES;
    const host = await mountLab(
      entry?.render(new URLSearchParams("depth=entitlement"))
    );
    await vi.waitFor(() =>
      expect(host.querySelector("[data-order-flow]")).not.toBeNull()
    );
    const load = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Load order flow"
    );
    await act(async () => load?.click());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-order-flow-tab="book"]')
        ?.click()
    );
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-error-code="ENTITLEMENT"]')?.textContent
      ).toContain("no L2 market depth permission")
    );
  });

  it("serves options analytics and Greek heatmap with the default flow window", async () => {
    const snapshot = await labOptionsAnalyticsGateway.snapshot({
      symbol: "NVDA",
    });
    expect(snapshot.flow.hours).toBe(24);
    const six = await labOptionsAnalyticsGateway.snapshot({
      flowHours: 6,
      symbol: "NVDA",
    });
    expect(six.flow.hours).toBe(6);
    const heatmap = await labOptionsAnalyticsGateway.greekHeatmap({
      symbol: "NVDA",
    });
    expect(heatmap.status).toBe("ok");
    expect(heatmap.symbol).toBe("NVDA");
    const control = await labOptionsAnalyticsGateway.flowControl?.({
      group: "nasdaq100",
    });
    expect(control?.group).toBe("nasdaq100");
  });

  it("serves an empty JEV verdict and refuses Ask JEV", async () => {
    const verdict = await labJevVerdictGateway.get({ symbol: " nvda " });
    expect(JevVerdictOutputSchema.parse(verdict)).toMatchObject({
      state: "none",
      symbol: "NVDA",
      verdict: null,
    });
    await expect(
      labJevVerdictGateway.refresh({ symbol: "NVDA" })
    ).rejects.toThrow("UI lab");
  });

  it("renders the stock detail with the fake chain from ?symbol=", async () => {
    window.history.replaceState(null, "", "/lab/stock?symbol=nvda");
    const entry = CHARTS_LAB_ENTRIES.find((item) => item.id === "stock");
    const host = await mountLab(
      entry?.render(new URLSearchParams("symbol=nvda"))
    );
    expect(host.querySelector("h1")?.textContent).toBe("NVDA");
    await vi.waitFor(() =>
      expect(
        host.querySelectorAll("[data-chain-layout=split] tbody tr").length
      ).toBeGreaterThan(0)
    );
    expect(host.querySelector("[data-chain-notes]")?.textContent).toContain(
      "DUMMY DATA"
    );
  });

  it("renders IV rank history chart on SPY analytics and unavailable state on NVDA analytics", async () => {
    window.history.replaceState(
      null,
      "",
      "/lab/stock?symbol=SPY&tab=analytics"
    );
    const entry = CHARTS_LAB_ENTRIES.find((item) => item.id === "stock");
    const spyHost = await mountLab(
      entry?.render(new URLSearchParams("symbol=SPY&tab=analytics"))
    );
    await vi.waitFor(() =>
      expect(
        spyHost.querySelector('[data-iv-history-state="ready"]')
      ).not.toBeNull()
    );
    expect(
      spyHost.querySelector('[data-iv-basis="vol_index_proxy"]')?.textContent
    ).toBe("Proxy: VIX");
    await unmountLab();

    window.history.replaceState(
      null,
      "",
      "/lab/stock?symbol=NVDA&tab=analytics"
    );
    const nvdaHost = await mountLab(
      entry?.render(new URLSearchParams("symbol=NVDA&tab=analytics"))
    );
    await vi.waitFor(() =>
      expect(
        nvdaHost.querySelector('[data-iv-history-state="unavailable"]')
      ).not.toBeNull()
    );
    expect(nvdaHost.textContent).toContain(
      "0 / 252 own ATM IV sessions stored"
    );
  });

  it("enables expected move cone in /lab/charts aligned to lab candles", async () => {
    window.history.replaceState(null, "", "/lab/charts");
    const entry = CHARTS_LAB_ENTRIES.find((item) => item.id === "charts");
    const host = await mountLab(entry?.render(new URLSearchParams()));
    await vi.waitFor(() =>
      expect(host.querySelector("[data-expected-move-toggle]")).not.toBeNull()
    );
    const toggle = host.querySelector<HTMLInputElement>(
      "[data-expected-move-toggle]"
    )!;
    await act(async () => {
      toggle.click();
    });
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-expected-move-status="ready"]')
      ).not.toBeNull()
    );
  });
});
