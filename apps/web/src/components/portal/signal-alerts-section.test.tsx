// @vitest-environment jsdom
import type {
  SignalAlertEvent,
  SignalAlertListOutput,
  SignalAlertRule,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ created: 0 }));
vi.mock("./signal-alerts-client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./signal-alerts-client.ts")>();
  return {
    ...actual,
    createBrowserSignalAlertsGateway: () => {
      browser.created += 1;
      return {
        ...actual.createSignalAlertsGateway({
          priceAlerts: { signals: {} },
        } as never),
        // Never settle: the section stays empty.
        events: () => new Promise(() => undefined),
        list: () => new Promise(() => undefined),
      };
    },
  };
});

import {
  createSignalAlertsGateway,
  describeBackfill,
  type SignalAlertsGateway,
} from "./signal-alerts-client.ts";
import {
  type BrowserNotifier,
  browserNotifier,
  conditionOfForm,
  SignalAlertsSection,
} from "./signal-alerts-section.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const CREATED = new Date("2026-11-02T13:30:00.000Z");
const FIRED = new Date("2026-11-02T15:45:00.000Z");

const rule = (overrides: Partial<SignalAlertRule> = {}): SignalAlertRule => ({
  condition: {
    left: { field: "close", type: "price" },
    operator: "crosses-above",
    right: { minutes: 30, side: "high", type: "opening-range" },
  },
  createdAt: CREATED,
  description: "close crosses above 30m opening range high",
  fireCount: 0,
  frequency: "per-bar-close",
  id: "rule-1",
  kind: "watch",
  lastBarAt: null,
  lastCheckedAt: null,
  lastFiredAt: null,
  name: "NQ 15m: close crosses above 30m opening range high",
  origin: "quant",
  status: "proposed",
  symbol: "NQ",
  timeframe: "15m",
  ...overrides,
});

const event = (
  overrides: Partial<SignalAlertEvent> = {}
): SignalAlertEvent => ({
  barAt: FIRED,
  delivery: "sent",
  firedAt: FIRED,
  id: "event-1",
  kind: "watch",
  name: "NQ watch",
  price: "21050.25",
  ruleId: "rule-1",
  symbol: "NQ",
  ...overrides,
});

const listing = (rules: SignalAlertRule[] = []): SignalAlertListOutput => ({
  notifications: "configured",
  rules,
});

const backfill = {
  bars: 400,
  count: 105,
  days: 77,
  from: CREATED,
  recent: [],
  to: FIRED,
};

const gatewayWith = (overrides: Partial<SignalAlertsGateway> = {}) =>
  ({
    backfill: vi.fn(async () => ({
      backfill,
      description: "SMA(20) crosses above SMA(50)",
    })),
    check: vi.fn(async () => ({
      checked: 1,
      delivery: "sent" as const,
      events: [event()],
      seriesErrors: [],
    })),
    create: vi.fn(async (input) =>
      rule({
        id: "rule-2",
        kind: "alert",
        name: `${input.symbol} alert`,
        status: "active",
      })
    ),
    dismiss: vi.fn(async (id: string) => rule({ id, status: "dismissed" })),
    events: vi.fn(async () => []),
    list: vi.fn(async () => listing()),
    propose: vi.fn(async () => ({
      backfill,
      ok: true as const,
      rule: rule(),
      summary:
        "Watch NQ on 15m bars: alert when close crosses above 30m opening range high on bar close.",
    })),
    remove: vi.fn(async () => undefined),
    start: vi.fn(async (id: string) => rule({ id, status: "active" })),
    ...overrides,
  }) satisfies SignalAlertsGateway;

const notifierWith = (permission: NotificationPermission = "default") => {
  let current: NotificationPermission = permission;
  const shown: string[] = [];
  const notifier: BrowserNotifier = {
    permission: () => current,
    request: async () => {
      current = "granted";
      return current;
    },
    show: (title, body) => {
      shown.push(`${title}|${body}`);
    },
  };
  return { notifier, shown };
};

const mount = async (
  gateway: SignalAlertsGateway,
  notifier: BrowserNotifier,
  pollMs = 0
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <SignalAlertsSection
        gateway={gateway}
        notifier={notifier}
        pollMs={pollMs}
      />
    );
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

describe("signal alert helpers", () => {
  it("words the backfill like LuxAlgo", () => {
    expect(describeBackfill(backfill)).toBe(
      "Would have fired 105 times in the last 77 days."
    );
    expect(describeBackfill({ ...backfill, count: 1, days: 1 })).toBe(
      "Would have fired 1 time in the last 1 day."
    );
    expect(describeBackfill({ ...backfill, bars: 0 })).toBe(
      "No closed bars to backfill yet."
    );
  });

  it("maps each preset to its condition", () => {
    const base = {
      direction: "crosses-below" as const,
      period: "10",
      slowPeriod: "30",
      value: " 4500.5 ",
    };
    expect(conditionOfForm({ ...base, preset: "sma-cross" })).toEqual({
      left: { period: 10, type: "sma" },
      operator: "crosses-below",
      right: { period: 30, type: "sma" },
    });
    expect(conditionOfForm({ ...base, preset: "breakout" }).right).toEqual({
      period: 10,
      type: "highest",
    });
    expect(conditionOfForm({ ...base, preset: "breakdown" })).toMatchObject({
      operator: "crosses-below",
      right: { type: "lowest" },
    });
    expect(conditionOfForm({ ...base, preset: "opening-range" })).toMatchObject(
      {
        operator: "crosses-below",
        right: { minutes: 10, side: "low" },
      }
    );
    expect(
      conditionOfForm({
        ...base,
        direction: "crosses",
        preset: "opening-range",
      })
    ).toMatchObject({ operator: "crosses-above", right: { side: "high" } });
    expect(conditionOfForm({ ...base, preset: "price-level" }).right).toEqual({
      type: "value",
      value: "4500.5",
    });
    expect(
      conditionOfForm({
        ...base,
        period: "x",
        preset: "sma-cross",
        slowPeriod: "",
      })
    ).toMatchObject({ left: { period: 20 }, right: { period: 50 } });
  });

  it("routes the gateway through priceAlerts.signals", async () => {
    const signals = {
      backfill: vi.fn(async () => "backfill"),
      check: vi.fn(async () => "check"),
      create: vi.fn(async () => ({ rule: "created" })),
      dismiss: vi.fn(async () => ({ rule: "dismissed" })),
      events: vi.fn(async () => ({ events: ["e"] })),
      list: vi.fn(async () => "list"),
      propose: vi.fn(async () => "propose"),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ rule: "started" })),
    };
    const gateway = createSignalAlertsGateway({
      priceAlerts: { signals },
    } as never);
    expect(await gateway.create({} as never)).toBe("created");
    expect(await gateway.start("a")).toBe("started");
    expect(await gateway.dismiss("a")).toBe("dismissed");
    expect(await gateway.events(null)).toEqual(["e"]);
    await gateway.events(FIRED);
    expect(signals.events).toHaveBeenLastCalledWith({ since: FIRED });
    await gateway.propose("watch NQ");
    expect(signals.propose).toHaveBeenCalledWith({ text: "watch NQ" });
    await gateway.remove("a");
    await gateway.list();
    await gateway.check();
    await gateway.backfill({} as never);
    expect(signals.remove).toHaveBeenCalledWith({ id: "a" });
  });
});

describe("SignalAlertsSection", () => {
  it("shows Quant's watch card and starts the watch", async () => {
    const gateway = gatewayWith();
    const { notifier } = notifierWith();
    const container = await mount(gateway, notifier);
    await setValue(
      labelled<HTMLInputElement>(container, "Ask Quant to watch"),
      "Watch NQ and wake me when a 15m bar closes above the opening range"
    );
    await click(container, "Suggest a watch");
    const card = container.querySelector(
      '[aria-label="Quant suggests a watch"]'
    );
    expect(card?.textContent).toContain(
      "Would have fired 105 times in the last 77 days."
    );
    expect(status(container)).toBe("Quant suggests a watch.");
    await click(container, "Start watching");
    expect(gateway.start).toHaveBeenCalledWith("rule-1");
    expect(status(container)).toBe("Watching NQ.");
    expect(
      container.querySelector('[aria-label="Quant suggests a watch"]')
    ).toBeNull();
    expect(container.textContent).toContain("Watching");
  });

  it("explains an unparseable request and dismisses a proposal", async () => {
    const gateway = gatewayWith({
      propose: vi.fn(async () => ({
        ok: false as const,
        reason: "Name the level",
      })),
    });
    const container = await mount(gateway, notifierWith().notifier);
    await setValue(
      labelled<HTMLInputElement>(container, "Ask Quant to watch"),
      "watch it"
    );
    await click(container, "Suggest a watch");
    expect(status(container)).toBe(
      "Quant could not turn that into a watch: Name the level"
    );

    const listed = gatewayWith({ list: vi.fn(async () => listing([rule()])) });
    const second = await mount(listed, notifierWith().notifier);
    await click(second, "Dismiss");
    expect(listed.dismiss).toHaveBeenCalledWith("rule-1");
    expect(status(second)).toBe("Watch stopped.");
  });

  it("previews the backfill and creates a strategy alert", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway, notifierWith().notifier);
    await setValue(labelled<HTMLInputElement>(container, "Symbol"), "spy");
    await setValue(labelled<HTMLSelectElement>(container, "Timeframe"), "1h");
    await click(container, "Preview backfill");
    expect(gateway.backfill).toHaveBeenCalledWith({
      condition: {
        left: { period: 20, type: "sma" },
        operator: "crosses-above",
        right: { period: 50, type: "sma" },
      },
      symbol: "SPY",
      timeframe: "1h",
    });
    expect(container.textContent).toContain(
      "SMA(20) crosses above SMA(50): Would have fired 105 times"
    );
    await setValue(labelled<HTMLSelectElement>(container, "Frequency"), "once");
    await click(container, "Create alert");
    expect(gateway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: "once",
        origin: "strategy",
        symbol: "SPY",
      })
    );
    expect(status(container)).toBe("Alert created: SPY alert.");

    await setValue(
      labelled<HTMLSelectElement>(container, "Alert on"),
      "price-level"
    );
    await setValue(labelled<HTMLInputElement>(container, "Value"), "500");
    await click(container, "Create alert");
    expect(gateway.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        condition: expect.objectContaining({
          right: { type: "value", value: "500" },
        }),
        origin: "manual",
      })
    );
  });

  it("checks now, lists fires and removes rules", async () => {
    const active = rule({
      fireCount: 2,
      id: "rule-5",
      kind: "alert",
      lastFiredAt: FIRED,
      status: "active",
    });
    const gateway = gatewayWith({ list: vi.fn(async () => listing([active])) });
    const container = await mount(gateway, notifierWith().notifier);
    expect(container.textContent).toContain(
      "fired 2, last 2026-11-02 15:45 UTC"
    );
    await click(container, "Check now");
    expect(status(container)).toBe("Checked 1; 1 fired.");
    expect(container.textContent).toContain("NQ watch at 21050.25");
    await click(container, "Stop");
    expect(gateway.dismiss).toHaveBeenCalledWith("rule-5");
    await click(container, `Remove ${active.name}`);
    expect(gateway.remove).toHaveBeenCalledWith("rule-5");
    expect(container.textContent).toContain("None yet.");
  });

  it("reports series errors and failures", async () => {
    const gateway = gatewayWith({
      check: vi.fn(async () => ({
        checked: 0,
        delivery: "none" as const,
        events: [],
        seriesErrors: [
          { reason: "x", symbol: "NQ", timeframe: "15m" as const },
        ],
      })),
      create: vi.fn(async () => {
        throw new Error("Signal alert validation failed");
      }),
    });
    const container = await mount(gateway, notifierWith().notifier);
    await click(container, "Check now");
    expect(status(container)).toBe("Checked 0; 0 fired. 1 series unavailable.");
    await click(container, "Create alert");
    expect(status(container)).toBe("Signal alert validation failed");
  });

  it("enables browser notifications and shows new fires from polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const events = vi
      .fn<SignalAlertsGateway["events"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event({ id: "event-9" })]);
    const gateway = gatewayWith({ events });
    const { notifier, shown } = notifierWith();
    const container = await mount(gateway, notifier, 1000);
    await click(container, "Enable browser notifications");
    expect(status(container)).toBe(
      "Browser notifications on while a Vertex tab is open."
    );
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await flush();
    });
    expect(shown).toEqual([
      "Vertex watch fired|NQ watch at 21050.25. Research only, not an instruction to trade.",
    ]);
    expect(container.textContent).toContain("NQ watch at 21050.25");
  });

  it("uses the browser gateway by default", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<SignalAlertsSection pollMs={0} />);
      await flush();
    });
    expect(browser.created).toBe(1);
    expect(container.textContent).toContain("None yet.");
  });

  it("wraps the browser Notification API", async () => {
    expect(browserNotifier.permission()).toBe("unsupported");
    expect(await browserNotifier.request()).toBe("unsupported");
    browserNotifier.show("t", "b");
    const created: Array<{ onclick: unknown; title: string }> = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "denied");
      onclick: unknown = null;
      constructor(title: string) {
        created.push(this as never);
        Object.assign(this, { title });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    try {
      expect(browserNotifier.permission()).toBe("granted");
      expect(await browserNotifier.request()).toBe("denied");
      browserNotifier.show("Vertex", "body");
      expect(created.map((entry) => entry.title)).toEqual(["Vertex"]);
      const [notification] = created;
      if (notification === undefined) throw new Error("no notification");
      (notification.onclick as () => void)();
      expect(focus).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      focus.mockRestore();
    }
  });

  it("polls quietly when nothing fired or notifications are off", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const events = vi
      .fn<SignalAlertsGateway["events"]>()
      .mockResolvedValueOnce([event()])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        event({ id: "event-2", kind: "alert", name: "SPY alert" }),
      ]);
    const gateway = gatewayWith({ events });
    const { notifier, shown } = notifierWith("denied");
    const container = await mount(gateway, notifier, 1000);
    for (let tick = 0; tick < 3; tick += 1)
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await flush();
      });
    expect(events).toHaveBeenLastCalledWith(FIRED);
    expect(shown).toEqual([]);
    expect(container.textContent).toContain("SPY alert at 21050.25");
    const enable = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Enable browser notifications")
    );
    expect(enable?.disabled).toBe(true);
  });

  it("shows alert-kind notifications and reports a refused permission", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const events = vi
      .fn<SignalAlertsGateway["events"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event({ kind: "alert", name: "SPY alert" })]);
    const { notifier, shown } = notifierWith("granted");
    await mount(gatewayWith({ events }), notifier, 1000);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await flush();
    });
    expect(shown[0]).toMatch(/^Vertex signal alert\|SPY alert/u);

    const refusing: BrowserNotifier = {
      permission: () => "default",
      request: async () => "denied",
      show: () => undefined,
    };
    const container = await mount(gatewayWith(), refusing);
    await click(container, "Enable browser notifications");
    expect(status(container)).toBe("Browser notifications are not allowed.");
    const unsupported = await mount(gatewayWith(), {
      ...refusing,
      permission: () => "unsupported",
    });
    expect(unsupported.textContent).toContain("unsupported here");
  });

  it("dismisses the proposal card, starts from the list and notes a missing backfill", async () => {
    const gateway = gatewayWith({
      dismiss: vi.fn(async (id: string) =>
        rule({ id, kind: "alert", status: "dismissed" })
      ),
      list: vi.fn(async () => listing([rule({ id: "rule-7" })])),
      propose: vi.fn(async () => ({
        backfill: null,
        ok: true as const,
        rule: rule(),
        summary: "Watch NQ.",
      })),
    });
    const container = await mount(gateway, notifierWith().notifier);
    await setValue(
      labelled<HTMLInputElement>(container, "Ask Quant to watch"),
      "Watch NQ above 1"
    );
    await click(container, "Suggest a watch");
    expect(container.textContent).toContain(
      "Backfill unavailable (market data)."
    );
    const card = container.querySelector<HTMLElement>(
      '[aria-label="Quant suggests a watch"]'
    );
    const cardDismiss = [...(card?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent?.trim() === "Dismiss"
    );
    await act(async () => {
      cardDismiss?.click();
      await flush();
    });
    expect(status(container)).toBe("Alert stopped.");
    expect(
      container.querySelector('[aria-label="Quant suggests a watch"]')
    ).toBeNull();
    await click(container, "Start watching");
    expect(gateway.start).toHaveBeenCalledWith("rule-7");
  });

  it("switches presets, fields and labels", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway, notifierWith().notifier);
    await setValue(labelled<HTMLInputElement>(container, "Fast SMA"), "5");
    await setValue(labelled<HTMLInputElement>(container, "Slow SMA"), "15");
    await setValue(
      labelled<HTMLSelectElement>(container, "Condition"),
      "crosses"
    );
    await click(container, "Preview backfill");
    expect(gateway.backfill).toHaveBeenLastCalledWith(
      expect.objectContaining({
        condition: {
          left: { period: 5, type: "sma" },
          operator: "crosses",
          right: { period: 15, type: "sma" },
        },
      })
    );
    await setValue(
      labelled<HTMLSelectElement>(container, "Alert on"),
      "breakout"
    );
    expect(() => labelled(container, "Condition")).toThrow();
    await setValue(labelled<HTMLInputElement>(container, "Bars"), "55");
    await setValue(
      labelled<HTMLSelectElement>(container, "Alert on"),
      "opening-range"
    );
    await setValue(
      labelled<HTMLInputElement>(container, "Range minutes"),
      "60"
    );
    await setValue(
      labelled<HTMLSelectElement>(container, "Alert on"),
      "price-level"
    );
    await click(container, "Create alert");
    expect(gateway.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        condition: expect.objectContaining({
          right: { type: "value", value: "0" },
        }),
      })
    );
  });

  it("reports a load failure", async () => {
    const gateway = gatewayWith({
      list: vi.fn(async () => {
        throw new Error("Signal alert storage unavailable");
      }),
    });
    const container = await mount(gateway, notifierWith("denied").notifier);
    expect(status(container)).toBe("Signal alert storage unavailable");
  });
});
