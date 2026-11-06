// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => navigation);
vi.mock("../../../../features/stock-detail/stock-detail-workspace.tsx", () => ({
  StockDetailWorkspace: ({ symbol }: { symbol: string }) => (
    <div data-workspace={symbol} />
  ),
}));

import StockError from "./error.tsx";
import StockLoading from "./loading.tsx";
import StockPage, { generateMetadata } from "./page.tsx";

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

const params = (symbol: string) => Promise.resolve({ symbol });

describe("stock route files", () => {
  it("renders the breadcrumb, header and workspace for a ticker", async () => {
    const container = await render(await StockPage({ params: params("nvda") }));
    expect(container.querySelector("h1")?.textContent).toBe("NVDA");
    expect(
      container.querySelector('nav[aria-label="Breadcrumb"]')?.textContent
    ).toBe("Charts/NVDA");
    expect(
      container.querySelector('a[href="/charts?symbol=NVDA"]')?.textContent
    ).toBe("Open in Charts");
    expect(container.querySelector("[data-workspace=NVDA]")).not.toBeNull();
    expect(await generateMetadata({ params: params("brk.b") })).toEqual({
      title: "BRK.B · Stock",
    });
    expect(await generateMetadata({ params: params("<x>") })).toEqual({
      title: "Stock",
    });
  });

  it("answers 404 for a value that is not a ticker", async () => {
    await expect(StockPage({ params: params("%3Cscript%3E") })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(navigation.notFound).toHaveBeenCalled();
  });

  it("renders loading and error states", async () => {
    const loading = await render(<StockLoading />);
    expect(loading.textContent).toContain("Loading stock detail");
    const reset = vi.fn();
    const error = await render(<StockError reset={reset} />);
    expect(error.textContent).toContain("Stock detail unavailable");
    await act(async () => error.querySelector("button")?.click());
    expect(reset).toHaveBeenCalled();
  });
});
