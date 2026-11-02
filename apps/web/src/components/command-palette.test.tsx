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
  { label: "Mission control", href: "/dashboard", group: "Workspace" },
  { label: "Backtests", href: "/backtests", group: "Workspace" },
  { label: "Audit", href: "/audit", group: "Records" },
];

const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<CommandPalette items={items} navigate={push} />)
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
    await key(window, { key: "k", ctrlKey: true });
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
