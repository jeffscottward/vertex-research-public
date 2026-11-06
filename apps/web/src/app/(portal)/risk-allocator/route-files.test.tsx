// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import RiskAllocatorError from "./error.tsx";
import RiskAllocatorLoading from "./loading.tsx";
import RiskAllocatorPage, { metadata } from "./page.tsx";

vi.mock(
  "../../../components/portal/risk-allocator-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/risk-allocator-workspace.tsx")
    >()),
    RiskAllocatorWorkspace: (props: { initial: unknown }) => (
      <div data-workspace={JSON.stringify(props.initial)} />
    ),
  })
);

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

const workspaceProps = (container: HTMLElement) =>
  JSON.parse(
    container
      .querySelector("[data-workspace]")
      ?.getAttribute("data-workspace") ?? "null"
  );

describe("risk allocator route files", () => {
  it("renders the workspace without a symbol by default (first watchlist symbol)", async () => {
    const container = await render(
      await RiskAllocatorPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Risk allocator" });
    expect(workspaceProps(container)).toEqual({ symbol: null });
  });

  it("passes the URL symbol to the workspace", async () => {
    const container = await render(
      await RiskAllocatorPage({
        searchParams: Promise.resolve({ symbol: "msft" }),
      })
    );
    expect(workspaceProps(container)).toEqual({ symbol: "MSFT" });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<RiskAllocatorLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading risk allocator"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<RiskAllocatorError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Risk allocator unavailable");
  });
});
