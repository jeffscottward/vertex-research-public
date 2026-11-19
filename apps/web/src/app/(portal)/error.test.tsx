// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ResearchError from "./error.tsx";

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

describe("portal error boundary", () => {
  it("names the failure time and the reference without private details", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-19T14:02:30Z") });
    const error = Object.assign(new Error("secret cause"), {
      digest: "abc123",
    });
    const reset = vi.fn();
    const container = await render(
      <ResearchError error={error} reset={reset} />
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "This page failed to render at 14:02 UTC"
    );
    expect(container.textContent).toContain(
      "Cause: the server hit an error while rendering. Reference: abc123."
    );
    expect(container.textContent).not.toContain("secret cause");
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard"
    );
  });
});
