// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ResearchError from "./error.tsx";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: () => "/research",
  useRouter: () => ({ refresh }),
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

describe("portal error boundary", () => {
  it("names the failure time, the cause and the reference without private details", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-19T14:02:30Z") });
    const error = Object.assign(new Error("secret cause"), {
      digest: "abc123",
    });
    const reset = vi.fn();
    const container = await render(
      <ResearchError error={error} reset={reset} />
    );
    const alert = container.querySelector('section[role="alert"]');
    expect(alert?.getAttribute("aria-label")).toBe("Page error");
    expect(alert?.textContent).toContain(
      "This page failed to render at 14:02 UTC"
    );
    expect(alert?.textContent).toContain(
      "Cause: the server hit an error while rendering. Reference: abc123."
    );
    expect(container.textContent).not.toContain("secret cause");
    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => retry?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard"
    );
  });
});
