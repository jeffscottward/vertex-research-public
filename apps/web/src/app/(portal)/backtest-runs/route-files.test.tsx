// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import InstantBacktestError from "./error.tsx";
import InstantBacktestLoading from "./loading.tsx";
import InstantBacktestPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/backtest-runs-workspace.tsx", () => ({
  BacktestRunsWorkspace: ({
    initialRunId,
  }: {
    readonly initialRunId: string | null;
  }) => (
    <div data-run={initialRunId ?? "none"} data-workspace="backtest-runs" />
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

describe("backtest runs route files", () => {
  it("renders the page header and workspace", async () => {
    const container = await render(
      await InstantBacktestPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Backtest runs" });
    expect(container.querySelector("h1")?.textContent).toBe("Backtest runs");
    expect(
      container.querySelector("[data-workspace]")?.getAttribute("data-run")
    ).toBe("none");
  });

  it("opens the run named in ?run= and ignores malformed ids", async () => {
    const linked = await render(
      await InstantBacktestPage({
        searchParams: Promise.resolve({ run: "run-7" }),
      })
    );
    expect(
      linked.querySelector("[data-workspace]")?.getAttribute("data-run")
    ).toBe("run-7");
    for (const run of ["bad id", ["run-7", "run-8"]]) {
      const ignored = await render(
        await InstantBacktestPage({ searchParams: Promise.resolve({ run }) })
      );
      expect(
        ignored.querySelector("[data-workspace]")?.getAttribute("data-run")
      ).toBe("none");
    }
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<InstantBacktestLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading backtest runs"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<InstantBacktestError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Backtest runs unavailable");
  });
});
