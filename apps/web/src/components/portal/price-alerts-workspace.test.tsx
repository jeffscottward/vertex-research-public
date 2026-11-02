// @vitest-environment jsdom
import type {
  PriceAlertCheckOutput,
  PriceAlertListOutput,
  PriceAlertRule,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PriceAlertsGateway } from "./price-alerts-client.ts";

const browser = vi.hoisted(() => ({ created: 0 }));
vi.mock("./price-alerts-client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./price-alerts-client.ts")>();
  return {
    ...actual,
    createBrowserPriceAlertsGateway: () => {
      browser.created += 1;
      return {
        check: async () => {
          throw new Error("unused");
        },
        create: async () => {
          throw new Error("unused");
        },
        // Never settles: the page stays in its loading state.
        list: () => new Promise<PriceAlertListOutput>(() => undefined),
        remove: async () => undefined,
      };
    },
  };
});

import {
  describePriceAlertCheck,
  PriceAlertsWorkspace,
} from "./price-alerts-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const CREATED = new Date("2026-10-13T13:00:00.000Z");
const NOW = new Date("2026-10-13T20:05:00.000Z");

const rule = (overrides: Partial<PriceAlertRule> = {}): PriceAlertRule => ({
  createdAt: CREATED,
  id: "rule-1",
  kind: "below",
  level: "54",
  note: null,
  role: "stop",
  state: { lastCheckedAt: null, status: "active" },
  symbol: "BAC",
  ...overrides,
});

const triggered = rule({
  id: "rule-2",
  kind: "above",
  level: "345",
  note: "breakout",
  role: "target",
  state: {
    delivery: "sent",
    status: "triggered",
    triggeredAt: NOW,
    triggerPrice: "348.15",
  },
  symbol: "AAPL",
});

const listing = (
  overrides: Partial<PriceAlertListOutput> = {}
): PriceAlertListOutput => ({
  notifications: "configured",
  rules: [rule(), triggered],
  symbols: ["AAPL", "BAC"],
  ...overrides,
});

const gatewayWith = (
  overrides: Partial<PriceAlertsGateway> = {}
): PriceAlertsGateway & {
  [K in keyof PriceAlertsGateway]: ReturnType<typeof vi.fn>;
} =>
  ({
    check: vi.fn(async () => {
      throw new Error("unused");
    }),
    create: vi.fn(async () => rule({ id: "rule-3" })),
    list: vi.fn(async () => listing()),
    remove: vi.fn(async () => undefined),
    ...overrides,
  }) as never;

const mount = async (gateway: PriceAlertsGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<PriceAlertsWorkspace gateway={gateway} />);
    await flush();
  });
  return container;
};

const labelled = <T extends HTMLElement>(
  container: HTMLElement,
  text: string
) => {
  const label = [...container.querySelectorAll("label")].find(
    (node) => node.textContent === text
  );
  const control = label?.htmlFor
    ? container.querySelector<T>(`[id="${label.htmlFor}"]`)
    : null;
  if (control === null) throw new Error(`Missing control ${text}`);
  return control;
};

const setValue = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    await flush();
  });
};

const click = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
  );
  if (button === undefined) throw new Error(`Missing button ${label}`);
  await act(async () => {
    button.click();
    await flush();
  });
};

const status = (container: HTMLElement) =>
  container.querySelector('[role="status"]')?.textContent ?? "";

describe("describePriceAlertCheck", () => {
  it("summarizes the run, the delivery and the quote errors", () => {
    const result: PriceAlertCheckOutput = {
      checked: 1,
      delivery: "none",
      quoteErrors: [],
      rules: [],
      triggered: [],
    };
    expect(describePriceAlertCheck(result)).toBe(
      "Checked 1 rule · 0 triggered · no notification needed"
    );
    expect(
      describePriceAlertCheck({
        ...result,
        checked: 2,
        delivery: "not-configured",
        quoteErrors: [{ reason: "Yahoo chart returned HTTP 404", symbol: "X" }],
      })
    ).toBe(
      "Checked 2 rules · 0 triggered · notification not configured · no quote for X (Yahoo chart returned HTTP 404)"
    );
  });
});

describe("PriceAlertsWorkspace", () => {
  it("lists active and triggered rules with the trigger price and delivery", async () => {
    const container = await mount(gatewayWith());
    expect(container.textContent).toContain("Phone notifications: on");
    expect(container.textContent).toContain("Active (1)");
    expect(container.textContent).toContain("Triggered (1)");
    const active = container.querySelector('[data-rule="rule-1"]');
    expect(active?.textContent).toContain("BAC");
    expect(active?.textContent).toContain("at or below 54");
    expect(active?.textContent).toContain("Last checked never");
    const fired = container.querySelector('[data-rule="rule-2"]');
    expect(fired?.textContent).toContain("breakout");
    expect(fired?.textContent).toContain(
      "Triggered at 348.15 on 2026-10-13 20:05 UTC · Notification sent"
    );
    const symbol = labelled<HTMLSelectElement>(container, "Symbol");
    expect([...symbol.options].map((option) => option.value)).toEqual([
      "AAPL",
      "BAC",
    ]);
    expect(symbol.value).toBe("AAPL");
  });

  it("creates an alert from the selects and the level, and asks for a missing level", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    await click(container, "Create alert");
    expect(status(container)).toBe("Enter a level.");
    expect(gateway.create).not.toHaveBeenCalled();
    await setValue(labelled(container, "Symbol"), "BAC");
    await setValue(labelled(container, "Condition"), "below");
    await setValue(labelled(container, "Role"), "stop");
    await setValue(labelled(container, "Level"), " 53.5 ");
    await setValue(labelled(container, "Note (optional)"), "lunch low");
    await click(container, "Create alert");
    expect(gateway.create).toHaveBeenCalledWith({
      kind: "below",
      level: "53.5",
      note: "lunch low",
      role: "stop",
      symbol: "BAC",
    });
    expect(status(container)).toBe("Alert created for BAC.");
    expect(container.textContent).toContain("Active (2)");
    expect(labelled<HTMLInputElement>(container, "Level").value).toBe("");
  });

  it("shows a server rejection without losing the form", async () => {
    const gateway = gatewayWith({
      create: vi.fn(async () => {
        throw {
          code: "BAD_REQUEST",
          message: "Add the symbol to your watchlist before creating an alert",
        };
      }),
    });
    const container = await mount(gateway);
    await setValue(labelled(container, "Level"), "1");
    await click(container, "Create alert");
    expect(status(container)).toBe(
      "Add the symbol to your watchlist before creating an alert"
    );
    expect(labelled<HTMLInputElement>(container, "Level").value).toBe("1");
  });

  it("checks now and shows the refreshed rules", async () => {
    const after = rule({
      state: {
        delivery: "not-configured",
        status: "triggered",
        triggeredAt: NOW,
        triggerPrice: "53.64",
      },
    });
    const gateway = gatewayWith({
      check: vi.fn(async () => ({
        checked: 1,
        delivery: "not-configured" as const,
        quoteErrors: [],
        rules: [after, triggered],
        triggered: [after],
      })),
    });
    const container = await mount(gateway);
    await click(container, "Check now");
    expect(status(container)).toBe(
      "Checked 1 rule · 1 triggered · notification not configured"
    );
    expect(container.textContent).toContain("Active (0)");
    expect(container.textContent).toContain("No active alerts.");
    expect(
      container.querySelector('[data-rule="rule-1"]')?.textContent
    ).toContain("Triggered at 53.64 on 2026-10-13 20:05 UTC");
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Check now"
    );
    expect(button?.disabled).toBe(true);
  });

  it("removes a rule", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    await click(container, "Remove BAC at or below 54");
    expect(gateway.remove).toHaveBeenCalledWith("rule-1");
    expect(status(container)).toBe("Alert for BAC removed.");
    expect(container.querySelector('[data-rule="rule-1"]')).toBeNull();
    await click(container, "Remove AAPL at or above 345");
    expect(gateway.remove).toHaveBeenLastCalledWith("rule-2");
    expect(container.textContent).toContain("Triggered (0)");
  });

  it("explains an empty watchlist, no triggers and missing notifications", async () => {
    const container = await mount(
      gatewayWith({
        list: vi.fn(async () =>
          listing({
            notifications: "not-configured",
            rules: [
              rule({
                state: { lastCheckedAt: NOW, status: "active" },
              }),
            ],
            symbols: [],
          })
        ),
      })
    );
    expect(container.textContent).toContain("Your watchlist is empty");
    expect(container.querySelector('a[href="/watchlist"]')).not.toBeNull();
    expect(container.textContent).toContain("not configured");
    expect(container.textContent).toContain("No alert has triggered yet.");
    expect(container.textContent).toContain(
      "Last checked 2026-10-13 20:05 UTC"
    );
  });

  it("shows a load failure with a retry", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce({ code: "FORBIDDEN" })
      .mockResolvedValueOnce(listing({ rules: [] }));
    const container = await mount(gatewayWith({ list }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Operator access required."
    );
    await click(container, "Retry");
    expect(container.textContent).toContain("Active (0)");
  });

  it("shows a loading state and creates the browser gateway by default", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    // The web tsconfig lib predates Promise.withResolvers, so the executor form is used.
    let release: (value: PriceAlertListOutput) => void = () => undefined;
    const pending = new Promise<PriceAlertListOutput>((resolve) => {
      release = resolve;
    });
    const gateway = gatewayWith({ list: vi.fn(() => pending) });
    await act(async () => {
      root.render(<PriceAlertsWorkspace gateway={gateway} />);
      await flush();
    });
    expect(container.textContent).toContain("Loading price alerts");
    await act(async () => {
      release(listing());
      await flush();
    });
    expect(container.textContent).toContain("Active (1)");
    const fallback = document.createElement("div");
    document.body.append(fallback);
    const fallbackRoot = createRoot(fallback);
    roots.push(fallbackRoot);
    await act(async () => {
      fallbackRoot.render(<PriceAlertsWorkspace />);
      await flush();
    });
    expect(browser.created).toBe(1);
    expect(fallback.textContent).toContain("Loading price alerts");
  });
});
