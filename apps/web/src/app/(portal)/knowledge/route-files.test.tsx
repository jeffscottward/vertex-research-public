// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import KnowledgeError from "./error.tsx";
import KnowledgeLoading from "./loading.tsx";

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

describe("knowledge chat route files", () => {
  it("renders an accessible loading state and a retry on error", async () => {
    const loading = await render(<KnowledgeLoading />);
    expect(loading.querySelector('[role="status"]')?.textContent).toContain(
      "Loading knowledge chat"
    );
    const reset = vi.fn();
    const failed = await render(<KnowledgeError reset={reset} />);
    await act(async () => failed.querySelector("button")?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(failed.textContent).toContain("Knowledge chat unavailable");
  });
});
