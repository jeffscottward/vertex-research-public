// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import InstantBacktestError from "./error.tsx";
import InstantBacktestLoading from "./loading.tsx";
import InstantBacktestPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/instant-backtest-workspace.tsx", () => ({
  InstantBacktestWorkspace: () => <div data-workspace="instant-backtest" />,
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

describe("instant backtest route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(<InstantBacktestPage />);
    expect(metadata).toEqual({ title: "Instant backtest" });
    expect(container.querySelector("h1")?.textContent).toBe("Instant backtest");
    expect(container.querySelector("[data-workspace]")).not.toBeNull();
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<InstantBacktestLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading instant backtest"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<InstantBacktestError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Instant backtest unavailable");
  });
});
