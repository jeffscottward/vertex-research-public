// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CollapsibleSummary,
  StickyTabs,
  summaryStorageKey,
} from "./page-sections.tsx";

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const mount = (node: React.ReactNode) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
};

describe("CollapsibleSummary", () => {
  it("toggles, exposes aria-expanded and remembers the choice", () => {
    const host = mount(
      <CollapsibleSummary id="portfolio" title="Summary">
        <p>Body</p>
      </CollapsibleSummary>
    );
    const toggle = host.querySelector("button")!;
    const body = host.querySelector<HTMLElement>(
      '[data-slot="collapsible-summary-content"]'
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    expect(window.localStorage.getItem(summaryStorageKey("portfolio"))).toBe(
      "true"
    );
    act(() => toggle.click());
    expect(body.hidden).toBe(false);
  });

  it("starts collapsed from storage", () => {
    window.localStorage.setItem("vertex.summary.p.collapsed", "true");
    const host = mount(
      <CollapsibleSummary id="p" title="S">
        x
      </CollapsibleSummary>
    );
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const host = mount(
      <CollapsibleSummary id="p" title="S">
        x
      </CollapsibleSummary>
    );
    const toggle = host.querySelector("button")!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

const tabs = [
  { content: <p>Positions body</p>, label: "Positions", value: "positions" },
  { content: <p>Orders body</p>, label: "Orders", value: "orders" },
];

describe("StickyTabs", () => {
  it("reads ?tab=, syncs the URL on switch and keeps the bar in place", () => {
    window.history.replaceState(null, "", "/p?tab=orders");
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    const host = mount(<StickyTabs label="Portfolio views" tabs={tabs} />);
    const list = host.querySelector('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Portfolio views");
    expect(list.className).toContain("sticky");
    const [first, second] = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(second?.getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("Orders body");
    let top = 100;
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(
      () => ({ top }) as DOMRect
    );
    const marker = host.querySelector('[data-slot="sticky-tabs-marker"]')!;
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(
      () => ({ top }) as DOMRect
    );
    act(() => {
      first?.click();
      top = 40;
    });
    expect(window.location.search).toBe("?tab=positions");
    expect(host.textContent).toContain("Positions body");
    expect(scrollBy).toHaveBeenCalledWith(0, -60);
    act(() => first?.click());
    expect(scrollBy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("falls back to the default tab, moves with arrow keys and follows popstate", () => {
    window.history.replaceState(null, "", "/p?view=nope");
    const host = mount(
      <StickyTabs
        defaultValue="orders"
        label="Views"
        param="view"
        tabs={tabs}
      />
    );
    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
    const selected = () =>
      host.querySelector('[aria-selected="true"]')?.textContent;
    expect(selected()).toBe("Orders");
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(selected()).toBe("Positions");
    expect(window.location.search).toBe("?view=positions");
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(selected()).toBe("Orders");
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "a" })
      );
    });
    expect(selected()).toBe("Orders");
    act(() => {
      window.history.replaceState(null, "", "/p?view=positions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(selected()).toBe("Positions");
  });

  it("scrolls a stuck bar back to its normal place so the new tab starts under it", () => {
    const scrollBy = vi.fn();
    vi.stubGlobal("scrollBy", scrollBy);
    const host = mount(<StickyTabs label="Views" tabs={tabs} />);
    const list = host.querySelector('[role="tablist"]')!;
    const marker = host.querySelector('[data-slot="sticky-tabs-marker"]')!;
    // Stuck: the bar sits at 0 while its normal place (the marker) is 500px above.
    let markerTop = -500;
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0 }) as DOMRect
    );
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(
      () => ({ top: markerTop }) as DOMRect
    );
    const second = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    act(() => {
      second?.click();
      markerTop = -300;
    });
    expect(scrollBy).toHaveBeenCalledWith(0, -300);
    const panel = host.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden])'
    );
    expect(panel?.className).toContain("min-h-dvh");
    vi.unstubAllGlobals();
  });

  it("renders the server-provided initial tab first and ignores unknown values", () => {
    const html = renderToStaticMarkup(
      <StickyTabs initialValue="orders" label="V" tabs={tabs} />
    );
    expect(html).toContain("Orders body");
    expect(html).not.toContain("Positions body");
    const fallback = renderToStaticMarkup(
      <StickyTabs initialValue="nope" label="V" tabs={tabs} />
    );
    expect(fallback).toContain("Positions body");
  });

  it("pushes a history entry per tab click so Back returns to the previous tab", () => {
    window.history.replaceState(null, "", "/p");
    const push = vi.spyOn(window.history, "pushState");
    const host = mount(<StickyTabs label="Views" tabs={tabs} />);
    const selected = () =>
      host.querySelector('[aria-selected="true"]')?.textContent;
    act(() =>
      host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click()
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?tab=orders");
    expect(selected()).toBe("Orders");
    act(() => {
      window.history.replaceState(null, "", "/p");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(selected()).toBe("Positions");
  });

  it("renders an empty tab list without errors", () => {
    const host = mount(<StickyTabs label="None" tabs={[]} />);
    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
});
