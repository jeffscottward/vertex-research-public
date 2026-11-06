// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AcademyThemeScope,
  AcademyThemeToggle,
  useAcademyTheme,
} from "./academy-theme.tsx";
import { LABELS, labelOf } from "./labels.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

const render = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
};

const Probe = ({ onTheme }: { onTheme: (toggle: () => void) => void }) => {
  const { theme, palette, toggle } = useAcademyTheme();
  onTheme(toggle);
  return <span data-probe={theme} data-palette={typeof palette} />;
};

describe("AcademyThemeScope", () => {
  it("defaults to dark, toggles to light and back, and stores the choice", async () => {
    const container = await render(
      <AcademyThemeScope>
        <AcademyThemeToggle />
      </AcademyThemeScope>
    );
    const scope = container.querySelector("[data-academy-theme]");
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(scope?.getAttribute("data-theme")).toBe("default-dark");
    expect(button.getAttribute("aria-label")).toBe(
      "Switch the Academy to light mode"
    );
    expect(button.textContent).toBe("Light mode");
    await act(async () => button.click());
    expect(scope?.getAttribute("data-academy-theme")).toBe("light");
    expect(scope?.getAttribute("data-theme")).toBe("default-light");
    expect(button.getAttribute("aria-label")).toBe(
      "Switch the Academy to dark mode"
    );
    expect(button.textContent).toBe("Dark mode");
    expect(window.localStorage.getItem("vertex-academy-theme")).toBe("light");
    await act(async () => button.click());
    expect(scope?.getAttribute("data-academy-theme")).toBe("dark");
    expect(window.localStorage.getItem("vertex-academy-theme")).toBe("dark");
  });

  it("restores a stored light choice and ignores other stored values", async () => {
    window.localStorage.setItem("vertex-academy-theme", "light");
    const light = await render(
      <AcademyThemeScope>
        <span />
      </AcademyThemeScope>
    );
    expect(
      light.querySelector("[data-academy-theme]")?.getAttribute("data-theme")
    ).toBe("default-light");
    window.localStorage.setItem("vertex-academy-theme", "sepia");
    const other = await render(
      <AcademyThemeScope>
        <span />
      </AcademyThemeScope>
    );
    expect(
      other.querySelector("[data-academy-theme]")?.getAttribute("data-theme")
    ).toBe("default-dark");
  });

  it("defaults to dark and still toggles when storage access throws", async () => {
    const blocked = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Storage is blocked", "SecurityError");
      });
    try {
      const container = await render(
        <AcademyThemeScope>
          <AcademyThemeToggle />
        </AcademyThemeScope>
      );
      const scope = container.querySelector("[data-academy-theme]");
      expect(scope?.getAttribute("data-theme")).toBe("default-dark");
      await act(async () =>
        (container.querySelector("button") as HTMLButtonElement).click()
      );
      expect(scope?.getAttribute("data-theme")).toBe("default-light");
      expect(blocked).toHaveBeenCalled();
    } finally {
      blocked.mockRestore();
    }
  });

  it("keeps the in-memory choice when the stored write fails", async () => {
    const full = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    try {
      const container = await render(
        <AcademyThemeScope>
          <AcademyThemeToggle />
        </AcademyThemeScope>
      );
      await act(async () =>
        (container.querySelector("button") as HTMLButtonElement).click()
      );
      expect(
        container
          .querySelector("[data-academy-theme]")
          ?.getAttribute("data-academy-theme")
      ).toBe("light");
      expect(full).toHaveBeenCalledWith("vertex-academy-theme", "light");
    } finally {
      full.mockRestore();
    }
  });

  it("gives a dark no-op theme outside the scope", async () => {
    let toggle: (() => void) | undefined;
    const container = await render(
      <Probe
        onTheme={(value) => {
          toggle = value;
        }}
      />
    );
    expect(
      container.querySelector("[data-probe]")?.getAttribute("data-probe")
    ).toBe("dark");
    expect(toggle?.()).toBeUndefined();
  });
});

describe("labels", () => {
  it("names known tags and passes unknown values through", () => {
    expect(labelOf("high-vol")).toBe("High volatility");
    expect(labelOf("mystery-tag")).toBe("mystery-tag");
    expect(LABELS.disclaimer).toContain("not historical option fills");
  });
});
