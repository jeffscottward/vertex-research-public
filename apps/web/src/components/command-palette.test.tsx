// @vitest-environment jsdom
import { Search } from "lucide-react";
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
  type PaletteItem,
  toPaletteItems,
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
  // cmdk sizes its list with ResizeObserver and scrolls the selected row into view; jsdom has
  // neither.
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
  Element.prototype.scrollIntoView ??= () => undefined;
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

const comboboxIn = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[role="combobox"]')!;

const selectedIn = (container: HTMLElement) =>
  container.querySelector('[role="option"][aria-selected="true"]');

const key = async (target: EventTarget, init: KeyboardEventInit) => {
  return await act(async () => ({
    dispatchEvent: target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    ),
  }));
};

describe("CommandPalette", () => {
  it("opens with / focused on the input and wraps arrows through the rows", async () => {
    const container = await mount();
    const dialog = container.querySelector("dialog")!;
    await key(window, { key: "/" });
    expect(dialog.hasAttribute("open")).toBe(true);
    const input = comboboxIn(container);
    expect(document.activeElement).toBe(input);
    expect(selectedIn(container)?.textContent).toContain("Chart");
    await key(input, { key: "ArrowUp" });
    expect(selectedIn(container)?.getAttribute("data-href")).toBe("/audit");
    await key(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/audit");
    return expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("reopens with Ctrl+K and an empty query", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    await type(comboboxIn(container), "audit");
    await act(async () => container.querySelector("dialog")!.close());
    await key(window, { ctrlKey: true, key: "k" });
    return expect(comboboxIn(container).value).toBe("");
  });

  it("keeps the query when Ctrl+K is pressed while open", async () => {
    const container = await mount();
    await key(window, { ctrlKey: true, key: "k" });
    await type(comboboxIn(container), "audit");
    await key(comboboxIn(container), { ctrlKey: true, key: "k" });
    return expect(comboboxIn(container).value).toBe("audit");
  });

  it("ignores / while the user is typing in a field", async () => {
    const container = await mount();
    const field = document.createElement("input");
    document.body.append(field);
    await key(field, { key: "/" });
    return expect(container.querySelector("dialog")!.hasAttribute("open")).toBe(
      false
    );
  });

  it("runs a typed command with Enter", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    await type(comboboxIn(container), "chart nvda 1w");
    expect(selectedIn(container)?.textContent).toContain("Chart NVDA · 1W");
    await key(comboboxIn(container), { key: "Enter" });
    return expect(push).toHaveBeenCalledWith("/charts?symbol=NVDA&interval=1W");
  });

  it("fills in a command template with Tab and stays open", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    const input = comboboxIn(container);
    await type(input, "ch");
    const tab = await key(input, { key: "Tab" });
    expect(tab.dispatchEvent).toBe(false);
    expect(input.value).toBe("chart ");
    expect(selectedIn(container)?.textContent).toContain(
      "chart <ticker> [interval]"
    );
    expect(push).not.toHaveBeenCalled();
    return expect(container.querySelector("dialog")!.hasAttribute("open")).toBe(
      true
    );
  });

  it("fills in a command template with Enter", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    const input = comboboxIn(container);
    await type(input, "opt");
    await key(input, { key: "Enter" });
    expect(input.value).toBe("options ");
    return expect(push).not.toHaveBeenCalled();
  });

  it("leaves Tab alone when a page is selected", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    const input = comboboxIn(container);
    await type(input, "audit");
    const tab = await key(input, { key: "Tab" });
    expect(tab.dispatchEvent).toBe(true);
    return expect(input.value).toBe("audit");
  });

  it("shows a wrong command as a hint row that cannot be selected", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    const input = comboboxIn(container);
    await type(input, "options AAPL 2026-02-31");
    const hint = container.querySelector('[role="option"]');
    expect(hint?.textContent).toContain('"2026-02-31" is not a date');
    expect(hint?.getAttribute("aria-disabled")).toBe("true");
    expect(selectedIn(container)).toBeNull();
    await key(input, { key: "Enter" });
    await act(async () => (hint as HTMLElement).click());
    return expect(push).not.toHaveBeenCalled();
  });

  it("says what to try when nothing matches", async () => {
    const container = await mount();
    await key(window, { key: "/" });
    await type(comboboxIn(container), "zzzzzzz qqqqqqq");
    return expect(container.querySelector("dialog")?.textContent).toContain(
      "No match. Try: chart NVDA 1D"
    );
  });

  it("closes on a backdrop click and on Escape, but not on a click inside", async () => {
    const container = await mount();
    const dialog = container.querySelector("dialog")!;
    await key(window, { key: "/" });
    await act(async () => comboboxIn(container).click());
    expect(dialog.hasAttribute("open")).toBe(true);
    await act(async () => dialog.click());
    expect(dialog.hasAttribute("open")).toBe(false);
    await key(window, { key: "/" });
    // Escape closes the native dialog itself and fires "close".
    await act(async () => dialog.dispatchEvent(new Event("close")));
    return expect(comboboxIn(container)).toBeNull();
  });
});

describe("CommandPalette search trigger", () => {
  it("shows a search box with the shortcut hint and an icon for mobile", async () => {
    const container = await mount("search");
    const box = container.querySelector('[data-slot="portal-search"]');
    expect(box?.textContent).toContain("Search ticker or page");
    expect(box?.querySelector("kbd")?.textContent).toContain("K");
    // WCAG 2.5.3 label in name: the visible label is the name; the shortcut hint is
    // left out of it (aria-keyshortcuts announces the shortcut).
    expect(box?.hasAttribute("aria-label")).toBe(false);
    expect(box?.querySelector('[aria-hidden="true"] > kbd')?.textContent).toBe(
      "Ctrl/⌘ K"
    );
    expect(box?.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K /");
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
    const input = comboboxIn(container);
    expect(input.placeholder).toBe("Search ticker, page or command");
    await type(input, "nvda");
    expect(selectedIn(container)?.textContent).toContain("Open NVDA");
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

  it("opens from the plain icon trigger", async () => {
    const container = await mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Jump to a page"]')
        ?.click()
    );
    return expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(
      true
    );
  });
});

describe("toPaletteItems", () =>
  it("flattens navigation groups into pages tagged with their group", () =>
    expect(
      toPaletteItems([
        {
          group: "Records",
          items: [{ href: "/audit", icon: Search, label: "Audit" }],
        },
      ])
    ).toEqual([{ group: "Records", href: "/audit", label: "Audit" }])));
