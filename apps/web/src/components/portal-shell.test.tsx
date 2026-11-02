// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/research/thread-1" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { DEFAULT_ANONYMOUS_THEME } from "../lib/theme.ts";
import { UiStateProvider } from "../lib/ui-store.tsx";
import { PortalShell, portalPageTitle } from "./portal-shell.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let mobile = false;

beforeEach(() => {
  mobile = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      get matches() {
        return mobile;
      },
      removeEventListener: vi.fn(),
    }))
  );
});

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const renderShell = (availableRoutes?: readonly string[]) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <UiStateProvider initialPreference={DEFAULT_ANONYMOUS_THEME}>
        <PortalShell
          userName="Ada Lovelace"
          {...(availableRoutes === undefined ? {} : { availableRoutes })}
        >
          <p>Body</p>
        </PortalShell>
      </UiStateProvider>
    )
  );
};

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("PortalShell", () => {
  it("titles the page from the most specific navigation entry", () => {
    expect(portalPageTitle("/dashboard")).toBe("Mission control");
    expect(portalPageTitle("/library/abc")).toBe("Strategy library");
    expect(portalPageTitle("/feature-items")).toBe("Vertex Research");
    expect(portalPageTitle("/settings/appearance")).toBe("Appearance");
    return expect(portalPageTitle("/elsewhere")).toBe("Vertex Research");
  });

  it("lets the page title take the free header width on small screens", () => {
    renderShell();
    const title = document.querySelector('[data-slot="portal-page-title"]');
    expect(title?.textContent).toBe("Research");
    expect(title?.className.split(" ")).toEqual(
      expect.arrayContaining(["min-w-0", "flex-1", "truncate"])
    );
    return expect(title?.nextElementSibling?.className.split(" ")).toContain(
      "shrink-0"
    );
  });

  it("collapses the desktop sidebar into icon mode through the UI store", () => {
    renderShell();
    const sidebar = () => document.querySelector('[data-slot="sidebar"]');
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    act(() => button("Toggle sidebar")?.click());
    expect(sidebar()?.getAttribute("data-collapsible")).toBe("icon");
    act(() => button("Toggle sidebar")?.click());
    return expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
  });

  it("opens only the first group and the group of the current page", () => {
    const openGroups = () =>
      Array.from(
        document.querySelectorAll<HTMLDetailsElement>(
          'nav[aria-label="Portal navigation"] details[data-slot="portal-group"]'
        ),
        (group) => [group.querySelector("summary")?.textContent, group.open]
      );
    renderShell();
    expect(openGroups()).toEqual([
      ["Overview", true],
      ["Portfolio", false],
      ["Markets & Research", true],
      ["Strategies & Backtests", false],
      ["Agents & Automation", false],
      ["Data & Ops", false],
    ]);
    act(() => root?.unmount());
    host?.remove();

    const previous = navigation.pathname;
    navigation.pathname = "/connections";
    renderShell();
    expect(openGroups().filter(([, open]) => open)).toEqual([
      ["Overview", true],
      ["Data & Ops", true],
    ]);
    navigation.pathname = previous;
  });

  it("retires session reads when the page is restored from the back/forward cache", () => {
    renderShell();
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true })
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: false })
      );
    });
    expect(
      document.querySelector('[data-slot="portal-page-title"]')?.textContent
    ).toBe("Research");
  });

  it("hides empty groups and shows only exposed lab pages", () => {
    renderShell(["/dashboard", "/backtest-runs"]);
    const nav = () =>
      document.querySelector('nav[aria-label="Portal navigation"]');
    expect(
      Array.from(
        nav()?.querySelectorAll('[data-sidebar="group-label"]') ?? [],
        (label) => label.textContent
      )
    ).toEqual(["Overview", "Strategies & Backtests"]);
    expect(
      Array.from(
        nav()?.querySelectorAll('details[data-slot="backtest-lab"] a') ?? [],
        (link) => link.getAttribute("href")
      )
    ).toEqual(["/backtest-runs"]);
    act(() => root?.unmount());
    host?.remove();

    renderShell([]);
    expect(nav()).toBeNull();
  });

  it("renders the backtest lab in the mobile navigation", () => {
    mobile = true;
    renderShell();
    act(() => button("Open portal navigation")?.click());
    const lab = document.querySelector(
      'nav[aria-label="Mobile portal navigation"] details[data-slot="backtest-lab"]'
    );
    expect(lab?.querySelector("summary")?.textContent).toBe("Backtest lab");
  });

  it("keeps the backtest lab pages under one disclosure that opens on a lab page", () => {
    const lab = () =>
      document.querySelector<HTMLDetailsElement>(
        'nav[aria-label="Portal navigation"] details[data-slot="backtest-lab"]'
      );
    renderShell();
    expect(lab()?.open).toBe(false);
    expect(lab()?.querySelector("summary")?.textContent).toBe("Backtest lab");
    expect(
      Array.from(lab()?.querySelectorAll("a") ?? [], (link) =>
        link.getAttribute("href")
      )
    ).toEqual([
      "/instant-backtest",
      "/setup-replay",
      "/backtest-runs",
      "/backtest-sweeps",
      "/portfolio-combos",
      "/forward-drift",
      "/strategy-builder",
      "/autopilot",
    ]);
    // The lab takes the place of its first page, between Backtests and Optimizations.
    const strategyGroup = Array.from(
      document.querySelectorAll(
        'nav[aria-label="Portal navigation"] > [data-sidebar="group"]'
      )
    ).find(
      (group) =>
        group.querySelector('[data-sidebar="group-label"]')?.textContent ===
        "Strategies & Backtests"
    );
    const entries = Array.from(
      strategyGroup?.querySelectorAll(
        '[data-sidebar="group-content"] > [data-sidebar="menu"] > li'
      ) ?? [],
      (item) => item.querySelector("summary, a")?.textContent
    );
    expect(entries).toEqual([
      "Strategy library",
      "Academy",
      "Strategy reviews",
      "Backtests",
      "Backtest lab",
      "Optimizations",
    ]);
    act(() => root?.unmount());
    host?.remove();

    const previous = navigation.pathname;
    navigation.pathname = "/backtest-runs";
    renderShell();
    expect(lab()?.open).toBe(true);
    expect(
      lab()
        ?.querySelector('a[href="/backtest-runs"]')
        ?.getAttribute("aria-current")
    ).toBe("page");
    act(() => root?.unmount());
    host?.remove();
    navigation.pathname = previous;

    navigation.pathname = "/agents/benchmark";
    renderShell();
    // A nested page marks only its own entry.
    const current = Array.from(
      document.querySelectorAll(
        'nav[aria-label="Portal navigation"] a[aria-current="page"]'
      ),
      (link) => link.getAttribute("href")
    );
    expect(current).toEqual(["/agents/benchmark"]);
    act(() => root?.unmount());
    host?.remove();
    navigation.pathname = previous;

    renderShell(["/dashboard", "/research"]);
    return expect(lab()).toBeNull();
  });

  return it("renders the mobile drawer as a native popover that closes after navigation", () => {
    mobile = true;
    renderShell();
    const trigger = button("Open portal navigation");
    expect(trigger?.getAttribute("popovertarget")).toBe("portal-navigation");
    const drawer = document.getElementById("portal-navigation");
    expect(drawer?.getAttribute("popover")).toBe("auto");
    expect(drawer?.getAttribute("role")).toBe("dialog");
    expect(drawer?.textContent).toContain("Navigation");
    expect(
      drawer?.querySelector('nav[aria-label="Mobile portal navigation"]')
    ).not.toBeNull();
    expect(
      drawer
        ?.querySelector('button[aria-label="Close portal navigation"]')
        ?.getAttribute("popovertarget")
    ).toBe("portal-navigation");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const link = drawer?.querySelector<HTMLAnchorElement>(
      'a[href="/research"]'
    );
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.textContent).toBe("Research, current page");
    link?.addEventListener("click", (event) => event.preventDefault());
    const hidePopover = vi.fn();
    Object.defineProperty(drawer, "hidePopover", {
      configurable: true,
      value: hidePopover,
    });
    act(() => link?.click());
    expect(hidePopover).toHaveBeenCalledOnce();
    Object.defineProperty(drawer, "hidePopover", {
      configurable: true,
      value: undefined,
    });
    expect(() => act(() => link?.click())).not.toThrow();
    return expect(
      document
        .querySelector('[data-slot="sidebar"]')
        ?.getAttribute("data-state")
    ).toBe("expanded");
  });
});
