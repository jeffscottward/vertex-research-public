// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import InsiderClustersError from "./error.tsx";
import InsiderClustersLoading from "./loading.tsx";
import InsiderClustersPage, { metadata } from "./page.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock(
  "../../../components/portal/insider-clusters-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/insider-clusters-workspace.tsx")
    >()),
    InsiderClustersWorkspace: (props: { initial: unknown }) => (
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

describe("insider clusters route files", () => {
  it("renders the workspace with the default window", async () => {
    const container = await render(
      await InsiderClustersPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Insider cluster buys" });
    expect(workspaceProps(container)).toEqual({ days: 7 });
  });

  it("passes the URL window to the workspace", async () => {
    const container = await render(
      await InsiderClustersPage({
        searchParams: Promise.resolve({ days: "30" }),
      })
    );
    expect(workspaceProps(container)).toEqual({ days: 30 });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<InsiderClustersLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading insider cluster buys"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<InsiderClustersError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(
      /Insider cluster buys failed to render at \d{2}:\d{2} UTC/
    );
  });
});
