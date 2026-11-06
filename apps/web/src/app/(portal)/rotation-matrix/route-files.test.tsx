// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import RotationMatrixError from "./error.tsx";
import RotationMatrixLoading from "./loading.tsx";
import RotationMatrixPage, { metadata } from "./page.tsx";

vi.mock(
  "../../../components/portal/rotation-matrix-workspace.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../components/portal/rotation-matrix-workspace.tsx")
    >()),
    RotationMatrixWorkspace: (props: { initial: unknown }) => (
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

describe("rotation matrix route files", () => {
  it("renders the workspace with the default period", async () => {
    const container = await render(
      await RotationMatrixPage({ searchParams: Promise.resolve({}) })
    );
    expect(metadata).toEqual({ title: "Rotation matrix" });
    expect(workspaceProps(container)).toEqual({ period: "1M" });
  });

  it("passes the URL period and ignores unknown values", async () => {
    const sixMonths = await render(
      await RotationMatrixPage({
        searchParams: Promise.resolve({ period: "6M" }),
      })
    );
    expect(workspaceProps(sixMonths)).toEqual({ period: "6M" });
    const unknown = await render(
      await RotationMatrixPage({
        searchParams: Promise.resolve({ period: ["1D", "3M"] }),
      })
    );
    expect(workspaceProps(unknown)).toEqual({ period: "1M" });
  });

  it("renders an accessible loading state", async () => {
    const container = await render(<RotationMatrixLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading rotation matrix"
    );
  });

  it("renders a retry action on error", async () => {
    const reset = vi.fn();
    const container = await render(<RotationMatrixError reset={reset} />);
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Rotation matrix unavailable");
  });
});
