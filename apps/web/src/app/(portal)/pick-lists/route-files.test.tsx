// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import PickListsError from "./error.tsx";
import PickListsLoading from "./loading.tsx";
import PickListsPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/pick-lists-workspace.tsx", () => ({
  PickListsWorkspace: () => <div data-workspace="pick-lists" />,
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

describe("pick lists route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<PickListsPage />);
    expect(metadata).toEqual({ title: "Pick lists" });
    expect(container.querySelector("h1")?.textContent).toBe("Pick lists");
    expect(
      container.querySelector('[data-workspace="pick-lists"]')
    ).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<PickListsLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading pick lists"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<PickListsError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Pick lists unavailable");
  });
});
