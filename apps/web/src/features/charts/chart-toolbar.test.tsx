// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChartIndicatorKey } from "./chart-indicators.ts";
import { ChartToolbar } from "./chart-toolbar.tsx";

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

const mount = async (indicators: readonly ChartIndicatorKey[] = ["MA"]) => {
  const handlers = {
    onIndicators: vi.fn(),
    onInterval: vi.fn(),
    onVolume: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ChartToolbar indicators={indicators} interval="1D" volume {...handlers}>
        <span data-extra="">extra</span>
      </ChartToolbar>
    )
  );
  return { container, handlers };
};

const menu = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`[data-chart-menu="${label}"]`);

describe("ChartToolbar", () => {
  it("picks an interval and toggles volume", async () => {
    const { container, handlers } = await mount();
    const buttons = [...container.querySelectorAll("fieldset button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "1D",
      "1W",
      "1M",
    ]);
    expect(
      buttons
        .find((button) => button.textContent === "1D")
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    await act(async () =>
      (
        buttons.find((button) => button.textContent === "5m") as HTMLElement
      ).click()
    );
    expect(handlers.onInterval).toHaveBeenCalledWith("5m");
    const volume = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Volume"
    );
    await act(async () => volume?.querySelector("input")?.click());
    expect(handlers.onVolume).toHaveBeenCalledWith(false);
    expect(container.querySelector("[data-extra]")).not.toBeNull();
  });

  it("opens a menu, toggles an indicator and closes on Escape or outside click", async () => {
    const { container, handlers } = await mount();
    const overlay = menu(container, "Overlay");
    expect(overlay?.textContent).toContain("MA");
    expect(menu(container, "Study")?.textContent).toContain("None");
    await act(async () => overlay?.click());
    expect(overlay?.getAttribute("aria-expanded")).toBe("true");
    const ema = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "EMA 20"
    );
    await act(async () => ema?.querySelector("input")?.click());
    expect(handlers.onIndicators).toHaveBeenCalledWith(["MA", "EMA"]);
    // A click inside the menu keeps it open.
    await act(async () =>
      ema?.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    );
    expect(overlay?.getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }))
    );
    expect(overlay?.getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(overlay?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => overlay?.click());
    await act(async () =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    );
    expect(overlay?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => overlay?.click());
    await act(async () => overlay?.click());
    expect(overlay?.getAttribute("aria-expanded")).toBe("false");
  });
});
