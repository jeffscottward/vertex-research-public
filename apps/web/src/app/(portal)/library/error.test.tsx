// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import StrategyLibraryError from "./error.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
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

describe("strategy library error boundary", () => {
  it("names the failure time, the cause, the reference and the effect", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-19T14:02:30Z") });
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const reset = vi.fn();
    const container = await render(
      <StrategyLibraryError error={error} reset={reset} />
    );
    expect(container.textContent).toContain(
      "Strategy library failed to render at 14:02 UTC"
    );
    expect(container.textContent).toContain("Reference: abc123.");
    expect(container.textContent).toContain("No data was changed.");
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
