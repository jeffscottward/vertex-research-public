// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import OptimizationsError from "./error.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/optimizations",
  useRouter: () => ({ refresh: vi.fn() }),
}));

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const render = async (error: Error & { digest?: string }, reset = vi.fn()) => {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <OptimizationsError error={error} reset={reset} />
    )
  );
  return container;
};

describe("optimizations error boundary", () => {
  it("names the failure time, the cause and the error reference", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T14:02:30Z") });
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const container = await render(error);
    expect(container.textContent).toContain(
      "Optimizations failed to render at 14:02 UTC"
    );
    expect(container.textContent).toContain(
      "Cause: the server hit an error while rendering. Reference: abc123. No data was changed."
    );
  });

  it("retries the render when Try again is selected", async () => {
    const reset = vi.fn();
    const container = await render(new Error("boom"), reset);
    expect(container.textContent).not.toContain("Reference");
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
