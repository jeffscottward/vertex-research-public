// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@darkfactory/scripting", () => ({ SCRIPT_TEMPLATES: [] }));

import { ScriptPanel } from "./script-panel.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
});

describe("script panel without a template library", () => {
  it("says so and offers no template to use", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ScriptPanel
          candles={[]}
          onLayers={vi.fn()}
          onOpenChange={vi.fn()}
          open
          runner={{ dispose: vi.fn(), run: vi.fn() }}
          storage={null}
          symbol="SPY"
        />
      )
    );
    const library = host.querySelector("[data-script-library]");
    expect(library?.textContent).toContain("No templates available.");
    expect(
      host.querySelector<HTMLButtonElement>("[data-script-use-template]")
        ?.disabled
    ).toBe(true);
    await act(async () => root.unmount());
    return host.remove();
  });
});
