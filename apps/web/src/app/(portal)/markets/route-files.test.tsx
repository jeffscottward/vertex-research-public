// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import MarketsError from "./error.tsx";
import MarketsLoading from "./loading.tsx";
import MarketsPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/market-context-workspace.tsx", () => ({
  MarketContextWorkspace: () => <div data-workspace="markets" />,
}));
vi.mock("../../../components/portal/market-feeds-workspace.tsx", () => ({
  MarketFeedsWorkspace: () => <div data-workspace="market-feeds" />,
}));

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

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

describe("market context route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<MarketsPage />);
    expect(metadata).toEqual({ title: "Market context" });
    expect(container.querySelector("h1")?.textContent).toBe("Market context");
    expect(
      container.querySelector('[data-workspace="markets"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-workspace="market-feeds"]')
    ).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<MarketsLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading market context"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<MarketsError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Market context unavailable");
  });
});
