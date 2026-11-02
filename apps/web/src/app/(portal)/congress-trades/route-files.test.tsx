// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import CongressTradesError from "./error.tsx";
import CongressTradesLoading from "./loading.tsx";
import CongressTradesPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/congress-trades-workspace.tsx", () => ({
  CongressTradesWorkspace: () => <div data-workspace="congress-trades" />,
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

describe("congress trades route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<CongressTradesPage />);
    expect(metadata).toEqual({ title: "Congress trades" });
    expect(container.querySelector("h1")?.textContent).toBe("Congress trades");
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<CongressTradesLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading congress trades"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<CongressTradesError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Congress trades unavailable");
  });
});
