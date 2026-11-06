// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import CongressTradesError from "./error.tsx";
import CongressTradesLoading from "./loading.tsx";
import CongressTradesPage, { metadata } from "./page.tsx";

vi.mock(
  "../../../components/portal/congress-trades-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/congress-trades-workspace.tsx")
    >()),
    CongressTradesWorkspace: (props: { initial: unknown }) => (
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

describe("congress trades route files", () => {
  it("renders the workspace with the default window and all members", async () => {
    const container = await render(
      await CongressTradesPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Congress trades" });
    expect(workspaceProps(container)).toEqual({ days: 30, member: "" });
  });

  it("passes the URL window and member to the workspace", async () => {
    const container = await render(
      await CongressTradesPage({
        searchParams: Promise.resolve({ days: "7", member: "Rick Larsen" }),
      })
    );
    expect(workspaceProps(container)).toEqual({
      days: 7,
      member: "Rick Larsen",
    });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<CongressTradesLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading congress trades"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<CongressTradesError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Congress trades unavailable");
  });
});
