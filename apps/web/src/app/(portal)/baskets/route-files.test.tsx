// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import BasketsError from "./error.tsx";
import BasketsLoading from "./loading.tsx";
import BasketsPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/baskets-workspace.tsx", () => ({
  BasketsWorkspace: ({ initialBasket }: { initialBasket: string | null }) => (
    <div data-basket={initialBasket ?? "none"} data-workspace="baskets" />
  ),
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

describe("baskets route files", () => {
  it("passes ?basket= (or the legacy ?symbol=) to the workspace", async () => {
    const basketOf = async (
      searchParams: Record<string, string | string[] | undefined>
    ) =>
      (
        await render(
          await BasketsPage({ searchParams: Promise.resolve(searchParams) })
        )
      )
        .querySelector("[data-workspace]")
        ?.getAttribute("data-basket");
    expect(metadata).toEqual({ title: "Baskets" });
    expect(await basketOf({ basket: "id-1" })).toBe("id-1");
    expect(await basketOf({ basket: "TITY", symbol: "OTHER" })).toBe("TITY");
    expect(await basketOf({ symbol: "TITY" })).toBe("TITY");
    expect(await basketOf({ symbol: ["A", "B"] })).toBe("none");
    expect(await basketOf({ basket: ["A", "B"] })).toBe("none");
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<BasketsLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading baskets"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<BasketsError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Baskets unavailable");
  });
});
