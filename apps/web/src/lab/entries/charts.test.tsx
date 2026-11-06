// @vitest-environment jsdom
import { JevVerdictOutputSchema } from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/charts/market-chart.tsx", () => ({
  MarketBarsChart: () => <div data-chart="" />,
}));

import { mountLab, unmountLab } from "../test-support.tsx";
import {
  CHARTS_LAB_ENTRIES,
  labJevVerdictGateway,
  labOptionsAnalyticsGateway,
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
});
