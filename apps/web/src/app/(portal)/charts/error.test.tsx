// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import ChartsError from "./error.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/charts",
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
  document.body.replaceChildren();
});

describe("charts error page", () => {
  it("names the failure, its time and the reference, and retries", async () => {
    const reset = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    await act(async () =>
      root.render(<ChartsError error={error} reset={reset} />)
    );
    expect(container.textContent).toMatch(
      /Charts failed to render at \d{2}:\d{2} UTC/
    );
    expect(container.textContent).toContain("Reference: abc123.");
    expect(container.textContent).toContain("No data was changed.");
    await act(async () => container.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
