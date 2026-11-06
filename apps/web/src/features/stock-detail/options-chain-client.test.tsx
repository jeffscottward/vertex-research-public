// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../charts/market-chart.tsx", () => ({ MarketBarsChart: () => null }));

import { createBrowserOptionsChainGateway } from "./options-chain-client.ts";
import { StockDetailWorkspace } from "./stock-detail-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
let root: Root | null = null;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  const current = root;
  root = null;
  if (current !== null) await act(async () => current.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("browser options chain gateway", () => {
  it("calls the oRPC procedures on the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: {} }, { status: 503 }));
    const gateway = createBrowserOptionsChainGateway();
    await gateway.expiries({ symbol: "NVDA" }).catch(() => undefined);
    await gateway
      .chain({ expiry: "2026-11-20", symbol: "NVDA" })
      .catch(() => undefined);
    const urls = fetchSpy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input)
    );
    expect(urls.some((url) => url.includes("optionsChain/expiries"))).toBe(
      true
    );
    expect(urls.some((url) => url.includes("optionsChain/chain"))).toBe(true);
  });

  it("is the workspace default, with the browser market data gateway", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: {} }, { status: 503 }));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const current = root;
    await act(async () => {
      current.render(<StockDetailWorkspace symbol="NVDA" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(container.querySelector("[data-stock-detail=NVDA]")).not.toBeNull();
  });
});
