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

  it("serves options analytics with the default flow window", async () => {
    const snapshot = await labOptionsAnalyticsGateway.snapshot({
      symbol: "NVDA",
    });
    expect(snapshot.flow.hours).toBe(24);
    const six = await labOptionsAnalyticsGateway.snapshot({
      flowHours: 6,
      symbol: "NVDA",
    });
    expect(six.flow.hours).toBe(6);
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
});
