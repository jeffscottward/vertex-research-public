// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import SmartMoneyError from "./error.tsx";
import SmartMoneyLoading from "./loading.tsx";
import SmartMoneyPage, { metadata } from "./page.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock(
  "../../../components/portal/smart-money-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/smart-money-workspace.tsx")
    >()),
    SmartMoneyWorkspace: (props: { initial: unknown }) => (
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

describe("smart money route files", () => {
  it("renders the workspace with the default sessions and sort", async () => {
    const container = await render(
      await SmartMoneyPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Smart money" });
    expect(workspaceProps(container)).toEqual({
      sessions: 1,
      sort: "net_bullish",
      ticker: "",
    });
  });

  it("passes the URL sessions, sort and ticker to the workspace", async () => {
    const container = await render(
      await SmartMoneyPage({
        searchParams: Promise.resolve({
          sessions: "20",
          sort: "total",
          ticker: "exwd",
        }),
      })
    );
    expect(workspaceProps(container)).toEqual({
      sessions: 20,
      sort: "total",
      ticker: "EXWD",
    });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<SmartMoneyLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading smart money"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<SmartMoneyError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(
      /Smart money failed to render at \d{2}:\d{2} UTC/
    );
  });
});
