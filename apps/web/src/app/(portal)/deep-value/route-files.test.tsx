// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import DeepValueError from "./error.tsx";
import DeepValueLoading from "./loading.tsx";
import DeepValuePage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/deep-value-workspace.tsx", () => ({
  DeepValueWorkspace: () => <div data-workspace="deep-value" />,
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

describe("deep value screen route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<DeepValuePage />);
    expect(metadata).toEqual({ title: "Deep value screen" });
    expect(container.querySelector("h1")?.textContent).toBe(
      "Deep value screen"
    );
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<DeepValueLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading deep value screen"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<DeepValueError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Deep value screen unavailable");
  });
});
