// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mountLab, unmountLab } from "../test-support.tsx";
import { COMMAND_PALETTE_LAB_ENTRIES } from "./command-palette.tsx";

beforeAll(() => {
  // jsdom lacks the modal dialog API and ResizeObserver (cmdk sizes its list with it).
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    return this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    return this.removeAttribute("open");
  };
  globalThis.ResizeObserver ??= class {
    observe() {
      return;
    }
    unobserve() {
      return;
    }
    disconnect() {
      return;
    }
  };
});

afterEach(async () => {
  await unmountLab();
});

const [entry] = COMMAND_PALETTE_LAB_ENTRIES;

describe("command palette lab entry", () => {
  it("renders closed with the example links when ?q= is missing", async () => {
    const host = await mountLab(entry?.render(new URLSearchParams()));
    expect(host.querySelector("h1")?.textContent).toBe("Command palette");
    expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(false);
    return expect(
      [...host.querySelectorAll("li a")].map((link) =>
        link.getAttribute("href")
      )
    ).toContain("?q=chart%20NVDA%201D");
  });

  it("opens with ?q= and shows the link a jump would open", async () => {
    const host = await mountLab(
      entry?.render(new URLSearchParams({ q: "chart NVDA 1W" }))
    );
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(input?.value).toBe("chart NVDA 1W");
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        })
      );
    });
    return expect(
      host.querySelector('[data-slot="lab-palette-jump"]')?.textContent
    ).toBe("Would open /charts?symbol=NVDA&interval=1W");
  });
});
