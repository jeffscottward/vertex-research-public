// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import EnginesError from "./error.tsx";
import EnginesLoading from "./loading.tsx";
import EnginesPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/engines-workspace.tsx", () => ({
  EnginesWorkspace: () => <div data-workspace="engines" />,
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

describe("engines route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<EnginesPage />);
    expect(metadata).toEqual({ title: "Engines" });
    expect(container.querySelector("h1")?.textContent).toBe("Engines");
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<EnginesLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading engines"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<EnginesError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Engines unavailable");
  });
});
