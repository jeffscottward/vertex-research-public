// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import AgentModelBenchmarkPage, { metadata } from "./page.tsx";

vi.mock(
  "../../../../components/portal/agent-model-benchmark-workspace.tsx",
  () => ({
    AgentModelBenchmarkWorkspace: ({
      children,
    }: Readonly<{ children?: ReactNode }>) => (
      <div data-workspace="benchmark">{children}</div>
    ),
  })
);
vi.mock("../../../../components/portal/agent-frameworks-section.tsx", () => ({
  AgentFrameworksSection: () => <div data-section="frameworks" />,
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

describe("model benchmark route", () => {
  it("renders the page header, the workspace and the frameworks", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<AgentModelBenchmarkPage />));
    expect(metadata).toEqual({ title: "Model benchmark" });
    expect(container.querySelector("h1")?.textContent).toBe("Model benchmark");
    expect(
      container.querySelector("[data-workspace] [data-section='frameworks']")
    ).not.toBeNull();
  });
});
