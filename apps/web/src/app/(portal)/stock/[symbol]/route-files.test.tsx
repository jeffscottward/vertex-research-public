// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/stock/AAPL",
  useRouter: () => ({ refresh: vi.fn() }),
}));

import StockError from "./error.tsx";
import StockLoading from "./loading.tsx";

// The page reads the session through next/headers, which resolves in the node environment
// only: page.test.tsx covers it.

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

describe("stock route files", () => {
  it("renders loading and error states", async () => {
    const loading = await render(<StockLoading />);
    expect(loading.textContent).toContain("Loading stock detail");
    const reset = vi.fn();
    const error = await render(<StockError reset={reset} />);
    expect(error.textContent).toContain("Stock detail failed to render at");
    await act(async () => error.querySelector("button")?.click());
    expect(reset).toHaveBeenCalled();
  });
});
