// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import SectorRotationError from "./error.tsx";
import SectorRotationLoading from "./loading.tsx";
import SectorRotationPage, { metadata } from "./page.tsx";

vi.mock(
  "../../../components/portal/sector-rotation-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/sector-rotation-workspace.tsx")
    >()),
    SectorRotationWorkspace: (props: { initial: unknown }) => (
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

describe("sector rotation route files", () => {
  it("renders the workspace with the default settings", async () => {
    const container = await render(
      await SectorRotationPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Sector rotation" });
    expect(
      JSON.parse(
        container
          .querySelector("[data-workspace]")
          ?.getAttribute("data-workspace") ?? "null"
      )
    ).toEqual({ tailLength: 10, timeframe: "weekly", universeId: "sectors" });
  });

  it("passes the URL settings to the workspace", async () => {
    const container = await render(
      await SectorRotationPage({
        searchParams: Promise.resolve({
          tail: "20",
          timeframe: "daily",
          universe: "watchlist",
        }),
      })
    );
    expect(
      JSON.parse(
        container
          .querySelector("[data-workspace]")
          ?.getAttribute("data-workspace") ?? "null"
      )
    ).toEqual({ tailLength: 20, timeframe: "daily", universeId: "watchlist" });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<SectorRotationLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading sector rotation"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<SectorRotationError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Sector rotation unavailable");
  });
});
