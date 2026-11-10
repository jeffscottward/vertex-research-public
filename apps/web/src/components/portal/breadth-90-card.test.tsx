// @vitest-environment jsdom
import type {
  ApiClient,
  Breadth90Day,
  Breadth90GetOutput,
  Breadth90Status,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  client: null as ApiClient | null,
  origins: [] as string[],
}));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn((options: Readonly<{ baseUrl: string }>) => {
    runtime.origins.push(options.baseUrl);
    return runtime.client as ApiClient;
  }),
}));

import {
  BREADTH90_REFRESH_MS,
  Breadth90Card,
  createBrowserBreadth90Gateway,
} from "./breadth-90-card.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  runtime.client = null;
  runtime.origins.length = 0;
  vi.useRealTimers();
});

const THRESHOLDS = { down80: 20, down90: 10, up80: 80, up90: 90 };

const day = (overrides: Partial<Breadth90Day> = {}): Breadth90Day => ({
  adv: 2400,
  advPct: 82.5,
  date: "2026-11-05",
  decl: 509,
  dvol: 100,
  final: true,
  kind: "UP_80",
  source: "tradingview",
  sourceAsOf: "2026-11-05T21:10:00.000Z",
  updatedAt: "2026-11-05T21:15:00.000Z",
  upPct: 84.2,
  uvol: 900,
  ...overrides,
});

const status = (overrides: Partial<Breadth90Status> = {}): Breadth90Status => ({
  armedOn: "2026-10-28",
  asOf: "2026-11-06T20:00:00.000Z",
  basket: {
    asOf: "2026-11-05",
    reportPath: "reports/dip-basket.md",
    rulesNote: "Scale in over three sessions.",
    summary: "Dip basket: 2 tiers",
    tiers: [
      { id: "core", label: "Core", tickers: ["SPY", "QQQ"], weightPctNlv: 20 },
      { id: "beta", label: "Beta", tickers: [], weightPctNlv: null },
    ],
  },
  sessionsLeft: 23,
  state: "FORMING",
  strict: true,
  ...overrides,
});

const ready = (
  overrides: Partial<Breadth90GetOutput> = {}
): Breadth90GetOutput => ({
  days: [
    day({ advPct: 12, date: "2026-10-28", kind: "DOWN_90", upPct: 8.4 }),
    day(),
    day({
      advPct: null,
      date: "2026-11-06",
      final: false,
      kind: "UP_90",
      source: "wsj",
      sourceAsOf: "11/06/26 3:30 PM",
      upPct: 93.1,
    }),
  ],
  events: [
    {
      advPct: null,
      armedOn: "2026-10-28",
      createdAt: "2026-11-06T20:00:00.000Z",
      date: "2026-11-06",
      grade: "volume-only",
      kind: "FORMING",
      strict: true,
      tier: "volume-only",
      trigger: "UP_90",
      upPct: 93.1,
    },
    {
      advPct: 12,
      armedOn: "2026-10-28",
      createdAt: "2026-10-28T21:15:00.000Z",
      date: "2026-10-28",
      grade: null,
      kind: "ARMED",
      strict: false,
      tier: "standard",
      trigger: null,
      upPct: 8.4,
    },
  ],
  status: status(),
  thresholds: THRESHOLDS,
  ...overrides,
});

const mount = async (get: () => Promise<Breadth90GetOutput>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Breadth90Card gateway={{ get }} />));
  return container;
};

const text = (container: HTMLElement, selector: string) =>
  container.querySelector(selector)?.textContent ?? null;

describe("Breadth90Card", () => {
  it("shows the state, today's intraday values, the chart, events and the basket", async () => {
    const container = await mount(async () => ready());
    const section = container.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBe("breadth90-title");
    expect(section?.dataset["breadth90State"]).toBe("FORMING");
    expect(text(container, "h2")).toBe("Breadth-90 signal");
    expect(container.textContent).toContain("High priority");
    expect(text(container, "[data-state-badge]")).toBe("Signal state: FORMING");
    expect(container.querySelector("[data-state-badge]")?.className).toContain(
      "bg-orange-700"
    );
    expect(text(container, "[data-strict]")).toContain("Strict");
    expect(text(container, "[data-armed]")).toBe(
      "Armed on 2026-10-28 · 23 sessions left"
    );
    const latest = text(container, "[data-breadth90-latest]");
    expect(latest).toContain("93.10%");
    expect(latest).toContain("—");
    expect(text(container, "[data-session-kind]")).toBe(
      "Intraday (unfinished session)"
    );
    expect(
      container.querySelectorAll("[data-breadth90-chart] rect")
    ).toHaveLength(3);
    const events = container.querySelectorAll("[data-breadth90-events] li");
    expect(events).toHaveLength(2);
    expect(events[0]?.textContent).toBe(
      "2026-11-06 FORMING up 93.10% · adv — · trigger UP_90 · volume-only · strict · armed 2026-10-28"
    );
    expect(events[1]?.textContent).toBe(
      "2026-10-28 ARMED up 8.40% · adv 12.00% · armed 2026-10-28"
    );
    const basket = text(container, "[data-breadth90-basket]");
    expect(basket).toContain("Dip basket: 2 tiers");
    expect(basket).toContain("Core · 20% NLV · SPY QQQ");
    expect(basket).toContain("Beta");
    expect(container.textContent).toContain("Scale in over three sessions.");
    expect(text(container, "code")).toBe("reports/dip-basket.md");
    expect(text(container, "[data-breadth90-source]")).toContain(
      "Source wsj, as of 11/06/26 3:30 PM. Signal computed 2026-11-06T20:00:00.000Z."
    );
  });

  it.each([
    ["FIRED", "bg-emerald-700"],
    ["ARMED", "bg-amber-300"],
    ["IDLE", "bg-muted"],
  ] as const)("styles the %s badge", async (state, style) => {
    const container = await mount(async () =>
      ready({ status: status({ state }) })
    );
    expect(container.querySelector("[data-state-badge]")?.className).toContain(
      style
    );
  });

  it("labels a closed session and leaves out what is missing", async () => {
    const container = await mount(async () =>
      ready({
        days: [day()],
        events: [],
        status: status({
          armedOn: null,
          basket: {
            asOf: null,
            reportPath: null,
            rulesNote: null,
            summary: null,
            tiers: [],
          },
          sessionsLeft: null,
          state: "IDLE",
          strict: false,
        }),
      })
    );
    expect(text(container, "[data-session-kind]")).toBe("Close");
    expect(container.querySelector("[data-strict]")).toBeNull();
    expect(container.querySelector("[data-armed]")).toBeNull();
    expect(container.textContent).toContain("No events yet.");
    expect(container.textContent).toContain("No dip basket published.");
    expect(container.querySelector("code")).toBeNull();
  });

  it("shows tiers without a summary, armed days without a count and no basket", async () => {
    const tiersOnly = await mount(async () =>
      ready({
        status: status({
          basket: {
            asOf: null,
            reportPath: null,
            rulesNote: null,
            summary: null,
            tiers: [
              { id: "core", label: "Core", tickers: [], weightPctNlv: null },
            ],
          },
          sessionsLeft: null,
        }),
      })
    );
    expect(text(tiersOnly, "[data-breadth90-basket]")).toBe("Core");
    expect(text(tiersOnly, "[data-armed]")).toBe("Armed on 2026-10-28");
    const summaryOnly = await mount(async () =>
      ready({
        status: status({
          basket: {
            asOf: null,
            reportPath: null,
            rulesNote: null,
            summary: "Summary only",
            tiers: [],
          },
        }),
      })
    );
    expect(text(summaryOnly, "[data-breadth90-basket]")).toBe("Summary only");
    const noBasket = await mount(async () =>
      ready({ status: status({ basket: null }) })
    );
    expect(noBasket.textContent).toContain("No dip basket published.");
  });

  it("shows sessions without a status as idle", async () => {
    const container = await mount(async () => ready({ status: null }));
    expect(text(container, "[data-state-badge]")).toBe("Signal state: IDLE");
    expect(text(container, "[data-breadth90-source]")).not.toContain(
      "Signal computed"
    );
  });

  it("shows a status without sessions", async () => {
    const container = await mount(async () =>
      ready({
        days: [],
        events: [
          {
            advPct: 91,
            armedOn: null,
            createdAt: "2026-11-02T21:15:00.000Z",
            date: "2026-11-02",
            grade: "major",
            kind: "THRUST",
            strict: false,
            tier: "major",
            trigger: "UP_90",
            upPct: 91.5,
          },
        ],
      })
    );
    expect(text(container, "[data-breadth90-events] li")).toBe(
      "2026-11-02 THRUST up 91.50% · adv 91.00% · trigger UP_90 · major"
    );
    expect(container.querySelector("[data-breadth90-latest]")).toBeNull();
    expect(container.querySelector("[data-breadth90-chart]")).toBeNull();
    expect(text(container, "[data-breadth90-source]")).toContain(
      "No sessions yet."
    );
  });

  it("shows an empty state before the first push", async () => {
    const container = await mount(async () =>
      ready({ days: [], events: [], status: null })
    );
    expect(text(container, "[data-breadth90-empty]")).toContain(
      "No breadth-90 data yet."
    );
  });

  it("shows loading, then an operator notice on FORBIDDEN", async () => {
    // The web tsconfig lib predates Promise.withResolvers.
    let reject: (error: unknown) => void = () => undefined;
    const container = await mount(
      () =>
        new Promise<Breadth90GetOutput>((_resolve, fail) => {
          reject = fail;
        })
    );
    expect(text(container, '[role="status"]')).toBe(
      "Loading breadth-90 signal…"
    );
    await act(async () => reject({ code: "FORBIDDEN" }));
    expect(text(container, '[role="status"]')).toBe(
      "Operator access required."
    );
  });

  it("shows an error with a retry and refreshes on a timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const get = vi
      .fn<() => Promise<Breadth90GetOutput>>()
      .mockRejectedValueOnce(new Error(" Storage down "))
      .mockRejectedValueOnce({ message: " " })
      .mockRejectedValueOnce(null)
      .mockResolvedValue(ready());
    const container = await mount(get);
    expect(text(container, '[role="alert"]')).toBe(
      "Breadth-90 signal unavailable. Storage down"
    );
    await act(async () => container.querySelector("button")?.click());
    expect(text(container, '[role="alert"]')).toBe(
      "Breadth-90 signal unavailable. Request failed."
    );
    await act(async () => {
      vi.advanceTimersByTime(BREADTH90_REFRESH_MS);
    });
    expect(text(container, '[role="alert"]')).toContain("Request failed.");
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("[data-state-badge]")).not.toBeNull();
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good data and shows an inline error when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const get = vi
      .fn<() => Promise<Breadth90GetOutput>>()
      .mockResolvedValueOnce(ready())
      .mockRejectedValueOnce(new Error("Storage down"))
      .mockResolvedValueOnce(ready({ days: [], events: [], status: null }))
      .mockRejectedValueOnce(null)
      .mockResolvedValue(ready());
    const container = await mount(get);
    const refresh = async () =>
      act(async () => {
        vi.advanceTimersByTime(BREADTH90_REFRESH_MS);
      });
    expect(
      container.querySelector("[data-breadth90-refresh-error]")
    ).toBeNull();
    await refresh();
    expect(text(container, "[data-breadth90-refresh-error]")).toBe(
      "Refresh failed; showing the last loaded data. Storage down"
    );
    expect(text(container, "[data-state-badge]")).toBe("Signal state: FORMING");
    expect(container.textContent).not.toContain("signal unavailable");
    await refresh();
    expect(
      container.querySelector("[data-breadth90-refresh-error]")
    ).toBeNull();
    await refresh();
    expect(text(container, "[data-breadth90-refresh-error]")).toContain(
      "Request failed."
    );
    expect(text(container, "[data-breadth90-empty]")).toContain(
      "No breadth-90 data yet."
    );
    await refresh();
    expect(
      container.querySelector("[data-breadth90-refresh-error]")
    ).toBeNull();
    expect(get).toHaveBeenCalledTimes(5);
  });

  it("shows percentages with two decimals so 89.96 never reads 90", async () => {
    const container = await mount(async () =>
      ready({
        events: ready().events.map((event) => ({
          ...event,
          advPct: 89.96,
          upPct: 89.96,
        })),
      })
    );
    expect(text(container, "[data-breadth90-events]")).toContain(
      "up 89.96% · adv 89.96%"
    );
    expect(container.textContent).not.toContain("90.0%");
  });

  it("creates the browser client once, on first use", async () => {
    const get = vi.fn(async () => ready());
    runtime.client = { breadth90: { get } } as unknown as ApiClient;
    const gateway = createBrowserBreadth90Gateway();
    expect(runtime.origins).toEqual([]);
    await gateway.get();
    await gateway.get();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(get).toHaveBeenCalledWith({});
  });

  it("uses the browser gateway by default", async () => {
    runtime.client = {
      breadth90: {
        get: async () => ready({ days: [], events: [], status: null }),
      },
    } as unknown as ApiClient;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Breadth90Card />));
    expect(container.querySelector("[data-breadth90-empty]")).not.toBeNull();
  });
});
