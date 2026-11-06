// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import DeepValueError from "./error.tsx";
import DeepValueLoading from "./loading.tsx";
import DeepValuePage, { metadata } from "./page.tsx";

vi.mock(
  "../../../components/portal/deep-value-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/deep-value-workspace.tsx")
    >()),
    DeepValueWorkspace: (props: { initial: unknown }) => (
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

describe("deep value screen route files", () => {
  it("renders the workspace with the default settings", async () => {
    const container = await render(
      await DeepValuePage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Deep value screen" });
    expect(workspaceProps(container)).toEqual({
      hideFlagged: false,
      minTotal: 0,
      role: "all",
      symbol: null,
      text: "",
    });
  });

  it("passes the URL ticker and filters to the workspace", async () => {
    const container = await render(
      await DeepValuePage({
        searchParams: Promise.resolve({
          hide: "1",
          min: "4",
          q: "ore",
          show: "ours",
          symbol: "siri",
        }),
      })
    );
    expect(workspaceProps(container)).toEqual({
      hideFlagged: true,
      minTotal: 4,
      role: "ours",
      symbol: "SIRI",
      text: "ore",
    });
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
