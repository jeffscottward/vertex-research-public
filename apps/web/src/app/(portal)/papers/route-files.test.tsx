// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import PapersError from "./error.tsx";
import PapersLoading from "./loading.tsx";
import PapersPage, { metadata } from "./page.tsx";

vi.mock("../../../components/portal/papers-workspace.tsx", () => ({
  PapersWorkspace: ({ initialStatus }: { initialStatus: string | null }) => (
    <div data-status={initialStatus ?? "none"} data-workspace="papers" />
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

describe("papers route files", () => {
  it("passes ?status= to the workspace", async () => {
    const statusOf = async (
      searchParams: Record<string, string | string[] | undefined>
    ) =>
      (
        await render(
          await PapersPage({ searchParams: Promise.resolve(searchParams) })
        )
      )
        .querySelector("[data-workspace]")
        ?.getAttribute("data-status");
    expect(metadata).toEqual({ title: "Papers" });
    expect(await statusOf({ status: "implemented" })).toBe("implemented");
    expect(await statusOf({})).toBe("none");
    expect(await statusOf({ status: ["a", "b"] })).toBe("none");
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<PapersLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading papers"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<PapersError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Papers unavailable");
  });
});
