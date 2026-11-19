// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import DeploymentsError from "./error.tsx";

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
      <DeploymentsError error={error} reset={reset} />
    )
  );
  return container;
};

describe("deployments error boundary", () => {
  it("names the failure time and the error reference", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-15T14:02:30Z") });
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const reset = vi.fn();
    const container = await render(error, reset);
    expect(container.textContent).toContain(
      "Deployments failed to render at 14:02 UTC"
    );
    expect(container.textContent).toContain(
      "No service was changed. Reference abc123."
    );
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits the reference when the error has no digest", async () => {
    const container = await render(new Error("boom"));
    expect(container.textContent).not.toContain("Reference");
  });
});
