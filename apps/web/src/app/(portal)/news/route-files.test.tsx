// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import NewsError from "./error.tsx";
import NewsLoading from "./loading.tsx";
import NewsPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/market-news-workspace.tsx", () => ({
  MarketNewsWorkspace: ({ initialDays }: { initialDays?: string }) => (
    <div data-days={initialDays ?? "none"} data-workspace="news" />
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

describe("news monitor route files", () => {
  it("renders the workspace, which owns the header, with ?days= from the request", async () => {
    const container = await render(
      await NewsPage({ searchParams: Promise.resolve({ days: "7" }) })
    );
    expect(metadata).toEqual({ title: "News monitor" });
    expect(
      container.querySelector("[data-workspace]")?.getAttribute("data-days")
    ).toBe("7");
  });

  it("passes no window when ?days= is missing or repeated", async () => {
    for (const days of [undefined, ["1", "7"]]) {
      const container = await render(
        await NewsPage({ searchParams: Promise.resolve({ days }) })
      );
      expect(
        container.querySelector("[data-workspace]")?.getAttribute("data-days")
      ).toBe("none");
    }
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<NewsLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading news monitor"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<NewsError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("News monitor unavailable");
  });
});
