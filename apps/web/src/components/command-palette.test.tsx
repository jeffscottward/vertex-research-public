// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const push = vi.fn();

import {
  CommandPalette,
  filterPaletteItems,
  type PaletteItem,
  paletteMatches,
} from "./command-palette.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lacks the modal dialog API.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    return this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    return this.removeAttribute("open");
  };
  return;
});
afterAll(() => delete testGlobal.IS_REACT_ACT_ENVIRONMENT);
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  return push.mockReset();
});

const items: PaletteItem[] = [
  { group: "Workspace", href: "/dashboard", label: "Mission control" },
  { group: "Workspace", href: "/backtests", label: "Backtests" },
  { group: "Records", href: "/audit", label: "Audit" },
];

const mount = async (trigger?: "icon" | "search") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <CommandPalette
        items={items}
        navigate={push}
        {...(trigger === undefined ? {} : { trigger })}
      />
    )
  );
  return container;
};

const key = async (target: EventTarget, init: KeyboardEventInit) => {
  return await act(async () => ({
    dispatchEvent: target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    ),
  }));
};

describe("filterPaletteItems", () =>
  it("matches label, group or path and ranks label prefixes first", () => {
    expect(filterPaletteItems(items, "").map((item) => item.href)).toEqual([
      "/dashboard",
      "/backtests",
      "/audit",
    ]);
    expect(filterPaletteItems(items, "rec").map((item) => item.href)).toEqual([
      "/audit",
    ]);
    expect(filterPaletteItems(items, "back").map((item) => item.href)).toEqual([
      "/backtests",
    ]);
    return expect(filterPaletteItems(items, "zzz")).toEqual([]);
  }));

describe("CommandPalette", () => {
  it("opens with / or Ctrl+K, filters, and navigates with arrows and Enter", async () => {
    const container = await mount();
    const dialog = container.querySelector("dialog")!;
    await key(window, { key: "/" });
    expect(dialog.hasAttribute("open")).toBe(true);
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Page name"]'
    )!;
    await key(input, { key: "ArrowDown" });
    expect(
      container
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("data-href")
    ).toBe("/backtests");
    await key(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/backtests");
    expect(dialog.hasAttribute("open")).toBe(false);
    await key(window, { ctrlKey: true, key: "k" });
    return expect(dialog.hasAttribute("open")).toBe(true);
  });

  return it("ignores / while the user is typing in a field", async () => {
    const container = await mount();
    const field = document.createElement("input");
    document.body.append(field);
    await key(field, { key: "/" });
    return expect(container.querySelector("dialog")!.hasAttribute("open")).toBe(
      false
    );
  });
});

describe("paletteMatches", () =>
  it("adds Open <TICKER> after page matches only for ticker-like text", () => {
    expect(paletteMatches(items, "nvda")).toEqual([
      { group: "Ticker", href: "/stock/NVDA", label: "Open NVDA" },
    ]);
    expect(paletteMatches(items, "audit").map((item) => item.href)).toEqual([
      "/audit",
      "/stock/AUDIT",
    ]);
    return expect(paletteMatches(items, "mission control")).toHaveLength(1);
  }));

describe("CommandPalette search trigger", () => {
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    return await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("shows a search box with the shortcut hint and an icon for mobile", async () => {
    const container = await mount("search");
    const box = container.querySelector('[data-slot="portal-search"]');
    expect(box?.textContent).toContain("Search ticker or page");
    expect(box?.querySelector("kbd")?.textContent).toContain("K");
    expect(box?.className.split(" ")).toEqual(
      expect.arrayContaining(["hidden", "sm:flex"])
    );
    return expect(
      container
        .querySelector('[data-trigger="portal-search-icon"]')
        ?.className.split(" ")
    ).toContain("sm:hidden");
  });

  it("opens the palette from the box, offers a ticker and navigates to it", async () => {
    const container = await mount("search");
    const dialog = container.querySelector("dialog")!;
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-slot="portal-search"]')
        ?.click()
    );
    expect(dialog.hasAttribute("open")).toBe(true);
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Page name"]'
    )!;
    expect(input.placeholder).toBe("Search ticker or page");
    await type(input, "nvda");
    expect(
      container.querySelector('[aria-selected="true"]')?.textContent
    ).toContain("Open NVDA");
    await key(input, { key: "Enter" });
    return expect(push).toHaveBeenCalledWith("/stock/NVDA");
  });

  it("opens from the mobile icon and with Cmd+K", async () => {
    const container = await mount("search");
    const dialog = container.querySelector("dialog")!;
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-trigger="portal-search-icon"]')
        ?.click()
    );
    expect(dialog.hasAttribute("open")).toBe(true);
    await act(async () => dialog.close());
    await key(window, { key: "K", metaKey: true });
    return expect(dialog.hasAttribute("open")).toBe(true);
  });
});
