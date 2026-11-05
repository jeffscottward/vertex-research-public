// @vitest-environment jsdom
import type { AssistantStatusOutput } from "@darkfactory/api";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/engines" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { parseAssistantPanelCookie } from "../../lib/assistant-panel-cookie.ts";
import { portalPageTitle } from "../../lib/portal-page-title.ts";
import type { AssistantGateway } from "./assistant-client.ts";
import {
  ASSISTANT_PANEL_DOCKED_QUERY,
  AssistantPanel,
  AssistantPanelProvider,
  AssistantPanelToggle,
  assistantPageContext,
} from "./assistant-panel.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const OPERATOR_ROUTES = ["/dashboard", "/engines", "/assistant"] as const;
let media: Record<string, boolean> = {};
const mediaListeners = new Set<() => void>();
let root: Root | undefined;
let host: HTMLElement | undefined;

const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: the panel saves its state in this cookie; jsdom has no Cookie Store API.
  document.cookie = "vx.assistantPanel=; Path=/; Max-Age=0";
};
const saveCookie = (value: "open" | "closed") => {
  // biome-ignore lint/suspicious/noDocumentCookie: the panel saves its state in this cookie; jsdom has no Cookie Store API.
  document.cookie = `vx.assistantPanel=${value}; Path=/`;
};
const saved = () => parseAssistantPanelCookie(document.cookie);

beforeEach(() => {
  navigation.pathname = "/engines";
  media = {};
  mediaListeners.clear();
  clearCookie();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      addEventListener: (_type: string, listener: () => void) =>
        mediaListeners.add(listener),
      get matches() {
        return media[query] ?? false;
      },
      removeEventListener: (_type: string, listener: () => void) =>
        mediaListeners.delete(listener),
    }))
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const status = (): AssistantStatusOutput => ({
  configured: true,
  maxSteps: 8,
  model: "test/model",
  usage: {
    day: "2026-01-02",
    inputTokens: 0,
    outputTokens: 0,
    requestLimit: 200,
    requests: 0,
    tokenLimit: 500_000,
  },
});

const fakeGateway = () => {
  const at = new Date("2026-01-02T03:04:05.000Z");
  const thread = { createdAt: at, id: "thread-1", title: "t", updatedAt: at };
  return {
    create: vi.fn(async () => thread),
    decide: vi.fn(),
    get: vi.fn(async () => ({ actions: [], messages: [], thread })),
    list: vi.fn(async () => ({ status: status(), threads: [] })),
    send: vi.fn(() => new Promise(() => undefined)),
  } as unknown as AssistantGateway & {
    send: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
};

const tree = (
  gateway: AssistantGateway,
  routes: readonly string[] = OPERATOR_ROUTES,
  initialOpen?: boolean
) => (
  <AssistantPanelProvider availableRoutes={routes} initialOpen={initialOpen}>
    <AssistantPanelToggle />
    <main>
      <input aria-label="Page field" />
    </main>
    <AssistantPanel gateway={gateway} />
  </AssistantPanelProvider>
);

const render = async (
  gateway: AssistantGateway = fakeGateway(),
  routes?: readonly string[],
  initialOpen?: boolean
) => {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  await act(async () => {
    created.render(tree(gateway, routes, initialOpen));
    return await flush();
  });
  return {
    rerender: async () =>
      await act(async () => {
        created.render(tree(gateway, routes, initialOpen));
        return await flush();
      }),
  };
};

const panel = () =>
  document.querySelector<HTMLElement>('aside[aria-label="Assistant panel"]');
const byLabel = (label: string) =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const chat = () => document.querySelector('[data-variant="panel"]');
const press = async (element: HTMLElement | null) =>
  await act(async () => {
    element?.click();
    return await flush();
  });
const key = async (init: KeyboardEventInit) =>
  await act(async () => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await flush();
    return event;
  });
const pressEscape = async () => await key({ key: "Escape" });
const setDocked = async (docked: boolean) =>
  await act(async () => {
    media[ASSISTANT_PANEL_DOCKED_QUERY] = docked;
    for (const listener of mediaListeners) listener();
    return await flush();
  });

describe("assistantPageContext", () =>
  it("sends the page only when the contract accepts its path", () => {
    expect(assistantPageContext("/engines")).toEqual({
      path: "/engines",
      title: portalPageTitle("/engines"),
    });
    expect(assistantPageContext("/a b")).toBeUndefined();
    return expect(assistantPageContext("")).toBeUndefined();
  }));

describe("AssistantPanel open state", () => {
  it("renders closed on the server without a saved choice, even on a wide screen", () => {
    media["(min-width: 1440px)"] = true;
    const html = renderToString(tree(fakeGateway()));
    expect(html).toContain('aria-label="Assistant panel"');
    expect(html).toContain("hidden");
    expect(html).toContain('aria-pressed="false"');
    return expect(html).not.toContain('data-variant="panel"');
  });

  it("renders the saved open choice on the server, mounting the chat, and hydrates without a mismatch", async () => {
    const html = renderToString(tree(fakeGateway(), OPERATOR_ROUTES, true));
    expect(html).toContain('data-variant="panel"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="dialog"');
    // The chat starts in its loading state: sending stays off until the thread list arrives.
    expect(html).toMatch(
      /<textarea[^>]*disabled=""[^>]*id="assistant-panel-message"/u
    );
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    await act(async () => {
      root = hydrateRoot(
        host as HTMLElement,
        tree(fakeGateway(), OPERATOR_ROUTES, true)
      );
      return await flush();
    });
    // The next/link test stub forwards prefetch to <a>; only hydration errors matter here.
    expect(
      errors.mock.calls.filter((call) =>
        /hydrat|did not match/iu.test(call.map(String).join(" "))
      )
    ).toEqual([]);
    return expect(panel()?.hidden).toBe(false);
  });

  it("keeps a saved closed choice from the server", async () => {
    await render(fakeGateway(), OPERATOR_ROUTES, false);
    expect(panel()?.hidden).toBe(true);
    return expect(chat()).toBeNull();
  });

  it("starts open from a saved open choice without writing the cookie", async () => {
    await render(fakeGateway(), OPERATOR_ROUTES, true);
    expect(panel()?.hidden).toBe(false);
    expect(chat()).not.toBeNull();
    expect(
      byLabel("Toggle assistant panel")?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(byLabel("Open full assistant")?.getAttribute("href")).toBe(
      "/assistant"
    );
    return expect(saved()).toBeUndefined();
  });

  it("stays closed without a saved choice on any screen and mounts the chat only on first open", async () => {
    media["(min-width: 1280px)"] = true;
    media["(min-width: 1440px)"] = true;
    await render();
    expect(panel()?.hidden).toBe(true);
    expect(chat()).toBeNull();
    expect(saved()).toBeUndefined();
    const fab = byLabel("Open assistant");
    expect(fab?.hidden).toBe(false);
    expect(fab?.getAttribute("aria-expanded")).toBe("false");
    expect(fab?.getAttribute("aria-controls")).toBe("assistant-panel");
    await press(fab);
    expect(panel()?.hidden).toBe(false);
    expect(fab?.hidden).toBe(true);
    expect(saved()).toBe(true);
    return expect(chat()).not.toBeNull();
  });

  it("saves each toggle in the cookie and keeps the chat mounted while closed", async () => {
    const gateway = fakeGateway();
    await render(gateway);
    const toggle = byLabel("Toggle assistant panel");
    expect(toggle?.getAttribute("aria-controls")).toBe("assistant-panel");
    await press(toggle);
    expect(saved()).toBe(true);
    const mounted = chat();
    expect(mounted).not.toBeNull();
    await press(toggle);
    expect(saved()).toBe(false);
    expect(panel()?.hidden).toBe(true);
    expect(chat()).toBe(mounted);
    await press(toggle);
    expect(chat()).toBe(mounted);
    return expect(gateway.list).toHaveBeenCalledOnce();
  });

  it("works without matchMedia (closed, then a modal sheet)", async () => {
    vi.stubGlobal("matchMedia", undefined);
    await render();
    expect(panel()?.hidden).toBe(true);
    await press(byLabel("Open assistant"));
    expect(panel()?.getAttribute("role")).toBe("dialog");
    await pressEscape();
    return expect(panel()?.hidden).toBe(true);
  });

  it("needs its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderToString(<AssistantPanelToggle />)).toThrow(
      "AssistantPanelProvider"
    );
    return expect(() =>
      renderToString(<AssistantPanel gateway={fakeGateway()} />)
    ).toThrow("AssistantPanelProvider");
  });
});

describe("AssistantPanel sheet and column", () => {
  it("is a modal dialog below lg: focus moves in, Tab stays inside, Escape returns focus", async () => {
    await render();
    const fab = byLabel("Open assistant");
    fab?.focus();
    await press(fab);
    const sheet = panel();
    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    expect(sheet?.getAttribute("aria-label")).toBe("Assistant panel");
    const close = byLabel("Close assistant panel");
    expect(document.activeElement).toBe(close);

    const focusable = [
      ...(sheet?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    expect(first).toBe(byLabel("Open full assistant"));
    last?.focus();
    expect((await key({ key: "Tab" })).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect((await key({ key: "Tab", shiftKey: true })).defaultPrevented).toBe(
      true
    );
    expect(document.activeElement).toBe(last);
    close?.focus();
    expect((await key({ key: "Tab" })).defaultPrevented).toBe(false);
    expect((await key({ key: "Tab", shiftKey: true })).defaultPrevented).toBe(
      false
    );
    byLabel("Page field")?.focus();
    await key({ key: "Tab" });
    expect(document.activeElement).toBe(first);
    byLabel("Page field")?.focus();
    await key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect((await key({ key: "a" })).defaultPrevented).toBe(false);

    await pressEscape();
    expect(sheet?.hidden).toBe(true);
    expect(fab?.hidden).toBe(false);
    expect(document.activeElement).toBe(fab);
    return expect(saved()).toBe(false);
  });

  it("opens from the saved cookie at load below lg as a dialog without moving focus", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await render(fakeGateway(), OPERATOR_ROUTES, true);
    expect(panel()?.hidden).toBe(false);
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(panel()?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(field);
    // The trap still applies: Tab from outside goes into the sheet.
    await key({ key: "Tab" });
    return expect(document.activeElement).toBe(byLabel("Open full assistant"));
  });

  it("skips hidden controls in the Tab trap", async () => {
    await render();
    await press(byLabel("Open assistant"));
    const sheet = panel();
    const visibleControls = [
      ...(sheet?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    const first = visibleControls[0];
    const last = visibleControls.at(-1);
    const hidden = document.createElement("div");
    hidden.hidden = true;
    hidden.innerHTML = '<button type="button">Hidden control</button>';
    sheet?.append(hidden);
    last?.focus();
    await key({ key: "Tab" });
    expect(document.activeElement).toBe(first);
    await key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    return hidden.remove();
  });

  it("returns focus to the opener after the close button and the backdrop", async () => {
    await render();
    const fab = byLabel("Open assistant");
    fab?.focus();
    await press(fab);
    await press(byLabel("Close assistant panel"));
    expect(panel()?.hidden).toBe(true);
    expect(document.activeElement).toBe(fab);
    expect(
      document.querySelector("[data-assistant-panel-backdrop]")
    ).toBeNull();
    await press(fab);
    const backdrop = document.querySelector<HTMLElement>(
      "[data-assistant-panel-backdrop]"
    );
    backdrop?.focus();
    await press(backdrop);
    expect(panel()?.hidden).toBe(true);
    return expect(document.activeElement).toBe(fab);
  });

  it("restores focus when nothing was focused, and not when focus moved elsewhere", async () => {
    await render();
    const fab = byLabel("Open assistant");
    fab?.focus();
    await press(fab);
    (document.activeElement as HTMLElement | null)?.blur();
    await press(byLabel("Close assistant panel"));
    expect(document.activeElement).toBe(fab);

    await press(fab);
    const nothing = vi
      .spyOn(document, "activeElement", "get")
      .mockReturnValue(null);
    await press(byLabel("Close assistant panel"));
    nothing.mockRestore();
    expect(document.activeElement).toBe(fab);

    await press(fab);
    const field = byLabel("Page field");
    field?.focus();
    await press(byLabel("Toggle assistant panel"));
    expect(panel()?.hidden).toBe(true);
    return expect(document.activeElement).toBe(field);
  });

  it("restores no focus when the opener was not an HTML element", async () => {
    await render();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("tabindex", "0");
    document.body.append(svg);
    svg.focus();
    await press(byLabel("Open assistant"));
    await press(byLabel("Close assistant panel"));
    expect(panel()?.hidden).toBe(true);
    return expect(document.activeElement).not.toBe(svg);
  });

  it("is a plain complementary column from lg: no dialog, no focus move, Escape ignored", async () => {
    media[ASSISTANT_PANEL_DOCKED_QUERY] = true;
    const field = await render().then(() => byLabel("Page field"));
    field?.focus();
    await press(byLabel("Toggle assistant panel"));
    expect(panel()?.hidden).toBe(false);
    expect(panel()?.hasAttribute("role")).toBe(false);
    expect(panel()?.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(field);
    await pressEscape();
    expect(panel()?.hidden).toBe(false);
    await setDocked(false);
    expect(panel()?.getAttribute("role")).toBe("dialog");
    // Narrowing the window is not an operator open: focus stays put.
    expect(document.activeElement).toBe(field);
    await setDocked(true);
    return expect(panel()?.hasAttribute("role")).toBe(false);
  });

  it("leaves a handled Escape to the thread list", async () => {
    await render(fakeGateway(), OPERATOR_ROUTES, true);
    await press(byLabel("Thread history"));
    expect(document.getElementById("assistant-panel-history")).not.toBeNull();
    await pressEscape();
    expect(document.getElementById("assistant-panel-history")).toBeNull();
    return expect(panel()?.hidden).toBe(false);
  });
});

describe("AssistantPanel pages and routes", () => {
  it("sends the current page as context and keeps the chat across navigation", async () => {
    const gateway = fakeGateway();
    const view = await render(gateway, OPERATOR_ROUTES, true);
    const mounted = chat();
    navigation.pathname = "/dashboard";
    await view.rerender();
    expect(chat()).toBe(mounted);
    await press(
      [...document.querySelectorAll<HTMLElement>("button")].find(
        (node) => node.textContent === "Explain this page"
      ) ?? null
    );
    return expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Explain this page",
        page: { path: "/dashboard", title: portalPageTitle("/dashboard") },
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("sends no page for a path the contract rejects", async () => {
    navigation.pathname = "/a b";
    await render(fakeGateway(), OPERATOR_ROUTES, true);
    return expect(chat()?.textContent).not.toContain("Explain this page");
  });

  it("opens only from the server's saved choice, never from a later client read", async () => {
    saveCookie("open");
    await render();
    return expect(panel()?.hidden).toBe(true);
  });

  it("sends no page without a pathname and uses the browser gateway by default", async () => {
    Reflect.set(navigation, "pathname", null);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("offline"));
    host = document.createElement("div");
    document.body.append(host);
    const created = createRoot(host);
    root = created;
    await act(async () => {
      created.render(
        <AssistantPanelProvider availableRoutes={OPERATOR_ROUTES} initialOpen>
          <AssistantPanel />
        </AssistantPanelProvider>
      );
      return await flush();
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(panel()?.hidden).toBe(false);
    return expect(chat()?.textContent).not.toContain("Explain this page");
  });

  it("is absent on /assistant, and stays hidden there once mounted", async () => {
    navigation.pathname = "/assistant";
    const first = await render(fakeGateway(), OPERATOR_ROUTES, true);
    expect(panel()).toBeNull();
    expect(byLabel("Toggle assistant panel")).toBeNull();
    expect(byLabel("Open assistant")).toBeNull();
    navigation.pathname = "/engines";
    await first.rerender();
    const mounted = chat();
    expect(mounted).not.toBeNull();
    navigation.pathname = "/assistant/thread-1";
    await first.rerender();
    expect(panel()?.hidden).toBe(true);
    expect(panel()?.hasAttribute("role")).toBe(false);
    expect(chat()).toBe(mounted);
    expect(byLabel("Toggle assistant panel")).toBeNull();
    await pressEscape();
    return expect(byLabel("Open assistant")).toBeNull();
  });

  it("is absent for routes without the assistant (non-operators)", async () => {
    await render(fakeGateway(), ["/dashboard"]);
    expect(panel()).toBeNull();
    expect(byLabel("Toggle assistant panel")).toBeNull();
    return expect(byLabel("Open assistant")).toBeNull();
  });
});
