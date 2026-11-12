// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import OrderDraftsError from "./error.tsx";
import OrderDraftsLoading from "./loading.tsx";
import OrderDraftsPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/golive-draft-queue.tsx", () => ({
  GoLiveDraftQueue: () => <div data-queue="" />,
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

const render = async (node: ReactNode): Promise<HTMLElement> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
};

describe("order drafts route", () => {
  it("renders the page header and the draft queue", async () => {
    const container = await render(<OrderDraftsPage />);
    expect(metadata).toEqual({ title: "Order drafts" });
    expect(container.querySelector("h1")?.textContent).toBe("Order drafts");
    expect(container.querySelector("[data-queue]")).not.toBeNull();
  });

  it("names the loading state", async () => {
    const container = await render(<OrderDraftsLoading />);
    const status = container.querySelector("[role='status']");
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toBe("Loading order drafts");
  });

  it("offers a retry when the page fails to render", async () => {
    const reset = vi.fn();
    const container = await render(<OrderDraftsError reset={reset} />);
    expect(container.textContent).toContain("Order drafts unavailable");
    expect(container.textContent).toContain(
      "The order drafts page failed to render. This page sends no orders."
    );
    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => retry?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
