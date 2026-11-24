// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildDepthLadder } from "../../features/order-flow/depth-ladder.ts";
import { DepthCurveChart } from "./depth-curve-chart.tsx";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = async (node: React.ReactElement): Promise<HTMLDivElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  return host;
};

const unmount = async (): Promise<void> => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
};

afterEach(unmount);

describe("DepthCurveChart", () => {
  it("returns null for an empty ladder", async () => {
    const ladder = buildDepthLadder({ asks: [], bids: [], sizeMultiplier: 1 });
    const container = await mount(
      <DepthCurveChart
        digits={2}
        ladder={ladder}
        minTick={0.01}
        symbol="SPY"
        unit="shares"
      />
    );
    expect(container.querySelector("[data-depth-curve]")).toBeNull();
  });

  it("renders bid/ask step curves, spread band, mid marker, legend, touch titles and balance bar", async () => {
    const ladder = buildDepthLadder({
      asks: [
        { price: 100.02, size: 3, venue: "ARCA" },
        { price: 100.04, size: 5, venue: "NSDQ" },
      ],
      bids: [
        { price: 100, size: 4, venue: "IEX" },
        { price: 99.98, size: 6, venue: "ARCA" },
      ],
      sizeMultiplier: 100,
    });
    const container = await mount(
      <DepthCurveChart
        digits={2}
        ladder={ladder}
        minTick={0.01}
        symbol="SPY"
        unit="shares"
      />
    );

    const svg = container.querySelector("[data-depth-curve-svg]");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toContain("SPY");
    expect(svg?.getAttribute("aria-label")).toContain("1,000 bid shares");
    expect(svg?.getAttribute("aria-label")).toContain("800 ask shares");

    const bidLine = container.querySelector('[data-depth-series="bid-line"]');
    const askLine = container.querySelector('[data-depth-series="ask-line"]');
    expect(bidLine?.getAttribute("stroke-dasharray")).toBeNull();
    expect(askLine?.getAttribute("stroke-dasharray")).toBe("6 3");
    expect(
      container.querySelector('[data-depth-series="bid-area"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-depth-series="ask-area"]')
    ).not.toBeNull();
    expect(container.querySelector("[data-depth-spread]")).not.toBeNull();
    expect(
      container
        .querySelector("[data-depth-mid]")
        ?.getAttribute("data-depth-mid")
    ).toBe("normal");

    const bidDotTitle = container.querySelector(
      '[data-depth-touch="bid"] title'
    )?.textContent;
    const askDotTitle = container.querySelector(
      '[data-depth-touch="ask"] title'
    )?.textContent;
    expect(bidDotTitle).toContain("Best bid 100.00");
    expect(bidDotTitle).toContain("IEX");
    expect(askDotTitle).toContain("Best ask 100.02");
    expect(askDotTitle).toContain("ARCA");

    const balance = container.querySelector("[data-depth-balance]");
    expect(balance?.textContent).toContain("Bid share 56%");
    expect(balance?.textContent).toContain("Ask share 44%");
  });

  it("handles one-sided, locked, crossed, single-exchange and zero-size books cleanly", async () => {
    const bidsOnly = buildDepthLadder({
      asks: [],
      bids: [{ price: 4500, size: 9, venue: null }],
      sizeMultiplier: 1,
    });
    let container = await mount(
      <DepthCurveChart
        digits={2}
        ladder={bidsOnly}
        minTick={0.25}
        symbol="ES"
        unit="contracts"
      />
    );
    expect(
      container.querySelector('[data-depth-series="bid-line"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-depth-series="ask-line"]')
    ).toBeNull();
    expect(container.querySelector("[data-depth-mid]")).toBeNull();
    expect(container.querySelector("[data-depth-spread]")).toBeNull();
    expect(
      container.querySelector('[data-depth-touch="bid"] title')?.textContent
    ).not.toContain("(");
    await unmount();

    const asksOnly = buildDepthLadder({
      asks: [{ price: 4500.25, size: 6, venue: null }],
      bids: [],
      sizeMultiplier: 1,
    });
    container = await mount(
      <DepthCurveChart
        digits={2}
        ladder={asksOnly}
        minTick={0.25}
        symbol="ES"
        unit="contracts"
      />
    );
    expect(
      container.querySelector('[data-depth-series="bid-line"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-depth-series="ask-line"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-depth-touch="ask"] title')?.textContent
    ).toContain("Best ask 4500.25");
    await unmount();

    const zeroSizes = buildDepthLadder({
      asks: [{ price: 100.02, size: 0, venue: null }],
      bids: [{ price: 100.02, size: 0, venue: null }],
      sizeMultiplier: 1,
    });
    container = await mount(
      <DepthCurveChart
        digits={2}
        ladder={zeroSizes}
        minTick={0.01}
        symbol="SPY"
        unit="shares"
      />
    );
    expect(container.querySelector("[data-depth-balance]")).toBeNull();
    expect(
      container.querySelector("[data-depth-zero-size]")?.textContent
    ).toContain("0 shares");
    expect(
      container
        .querySelector("[data-depth-mid]")
        ?.getAttribute("data-depth-mid")
    ).toBe("locked");
  });
});
