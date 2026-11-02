// @vitest-environment jsdom
import type {
  OptionsAnalyticsInput,
  OptionsAnalyticsOutput,
} from "@darkfactory/api";
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

import {
  createBrowserOptionsAnalyticsGateway,
  type OptionsAnalyticsGateway,
} from "./options-analytics-client.ts";
import { OptionsAnalyticsPanel } from "./options-analytics-panel.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const render = async (
  gateway: OptionsAnalyticsGateway | undefined,
  symbol = "NVDA"
): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(<OptionsAnalyticsPanel gateway={gateway} symbol={symbol} />);
  });
  return host;
};

const fixture = (
  overrides: Partial<OptionsAnalyticsOutput> = {}
): OptionsAnalyticsOutput => ({
  exposure: {
    gexExpiry: "2026-10-23",
    maxPain: 100,
    message: null,
    status: "ok",
    strikes: [
      {
        callOpenInterest: 10,
        gex: -2_500_000,
        putOpenInterest: 500,
        strike: 90,
      },
      { callOpenInterest: 300, gex: 1200, putOpenInterest: 300, strike: 100 },
      { callOpenInterest: 800, gex: null, putOpenInterest: 0, strike: 120 },
      { callOpenInterest: 5, gex: 50, putOpenInterest: 5, strike: 130 },
    ],
    totalGex: 3_400_000_000,
  },
  flow: {
    buckets: [],
    callPremium: 1_000_000,
    events: [
      {
        contract: "NVDA 2026-11-20 110C",
        expiry: "2026-11-20",
        flowType: "sweep",
        premium: 1_000_000,
        right: "call",
        sentiment: "bullish",
        size: 200,
        strike: 110,
        time: "2026-10-22T14:10:00.000Z",
        unusual: true,
      },
      {
        contract: "NVDA 2026-10-23 95P",
        expiry: "2026-10-23",
        flowType: null,
        premium: 250_000,
        right: "put",
        sentiment: "neutral",
        size: 50,
        strike: 95,
        time: "2026-10-22T13:05:00.000Z",
        unusual: false,
      },
    ],
    hours: 24,
    message: null,
    putPremium: 250_000,
    status: "ok",
  },
  notes: ["Research only."],
  rateLimited: false,
  receivedAt: "2026-10-22T15:00:00.000Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: 101,
  symbol: "NVDA",
  volatility: {
    message: null,
    skew: [
      { delta: -40, expiry: "2026-10-23", iv: 0.33, target: -40 },
      { delta: 25, expiry: "2026-10-23", iv: 0.25, target: 25 },
    ],
    status: "ok",
    surface: {
      moneyness: [0.9, 1, 1.1],
      rows: [{ dte: 1, expiry: "2026-10-23", ivs: [0.38, null, 0.25] }],
    },
    termStructure: [
      { atmIv: 0.28, dte: 1, expiry: "2026-10-23" },
      { atmIv: 0.29, dte: 29, expiry: "2026-11-20" },
    ],
  },
  ...overrides,
});

describe("OptionsAnalyticsPanel", () => {
  it("renders IV, GEX and flow sections for the symbol", async () => {
    const snapshot = vi.fn(async (_input: OptionsAnalyticsInput) => fixture());
    const view = await render({ snapshot });
    expect(snapshot).toHaveBeenCalledWith({ flowHours: 24, symbol: "NVDA" });
    expect(view.textContent).toContain("Options analytics · NVDA");
    expect(view.textContent).toContain("spot 101");
    expect(
      view.querySelectorAll("[data-term-structure] tbody tr")
    ).toHaveLength(2);
    expect(view.querySelector("[data-skew] tbody")?.textContent).toContain(
      "33.0%"
    );
    expect(
      view.querySelector("[data-iv-surface] tbody")?.textContent
    ).toContain("—");
    expect(view.querySelector("[data-total-gex]")?.textContent).toBe("$3.40B");
    expect(view.querySelector("[data-spot-row]")?.textContent).toContain("100");
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "-$2.50M"
    );
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "$1.2K"
    );
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "$50"
    );
    expect(view.querySelector("[data-net-premium]")?.textContent).toBe(
      "$750.0K"
    );
    expect(view.querySelector("[data-flow-table]")?.textContent).toContain(
      "unusual"
    );
    return expect(view.textContent).toContain("Research only.");
  });

  it("puts each skew point under the target column it was chosen for", async () => {
    const base = fixture();
    const snapshot = vi.fn(async () =>
      fixture({
        volatility: {
          ...base.volatility,
          skew: [
            { delta: -17, expiry: "2026-10-23", iv: 0.31, target: -25 },
            { delta: -10, expiry: "2026-10-23", iv: 0.36, target: -10 },
          ],
        },
      })
    );
    const view = await render({ snapshot });
    const cells = [
      ...(view.querySelector("[data-skew] tbody tr")?.querySelectorAll("td") ??
        []),
    ].map((cell) => cell.textContent);
    // Columns: expiry, -40, -25, -10, +10, +25, +40.
    expect(cells.slice(1, 4)).toEqual(["—", "31.0%", "36.0%"]);
  });

  it("changes the flow window, refreshes and drops stale responses", async () => {
    let release: (value: OptionsAnalyticsOutput) => void = () => undefined;
    const snapshot = vi
      .fn<(input: OptionsAnalyticsInput) => Promise<OptionsAnalyticsOutput>>()
      .mockResolvedValueOnce(fixture())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue(fixture({ spot: null }));
    const view = await render({ snapshot });
    const select = view.querySelector("select");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "6";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(snapshot).toHaveBeenLastCalledWith({ flowHours: 6, symbol: "NVDA" });
    expect(view.textContent).toContain("Loading options analytics");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "72";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      release(fixture({ symbol: "STALE" }));
    });
    expect(view.textContent).toContain("spot —");
    await act(async () => {
      view.querySelector("button")?.click();
    });
    expect(snapshot).toHaveBeenCalledTimes(4);
    return expect(view.querySelector("[data-spot-row]")).toBeNull();
  });

  it("shows section messages, rate limits and errors", async () => {
    const empty = fixture({
      rateLimited: true,
      exposure: {
        ...fixture().exposure,
        gexExpiry: null,
        maxPain: null,
        totalGex: null,
      },
      retryAfterSeconds: null,
      volatility: {
        ...fixture().volatility,
        message: "No IV.",
        status: "empty",
      },
    });
    let view = await render({ snapshot: async () => empty });
    expect(view.textContent).toContain("retry in about 60 s");
    expect(view.textContent).toContain("No IV.");
    expect(view.querySelector("[data-term-structure]")).toBeNull();
    expect(view.querySelector("[data-total-gex]")?.textContent).toBe("—");
    act(() => root?.unmount());
    view = await render({
      snapshot: async () => {
        throw Object.assign(new Error("QuantData is not configured"), {
          code: "NOT_CONFIGURED",
        });
      },
    });
    expect(
      view.querySelector("[data-error-code]")?.getAttribute("data-error-code")
    ).toBe("NOT_CONFIGURED");
    act(() => root?.unmount());
    view = await render({
      snapshot: async () =>
        fixture({
          exposure: {
            ...fixture().exposure,
            message: "QuantData openInterest: HTTP 500.",
            status: "unavailable",
          },
        }),
    });
    expect(view.querySelector("[data-gex-table]")).toBeNull();
    act(() => root?.unmount());
    let fail: (error: unknown) => void = () => undefined;
    let calls = 0;
    view = await render({
      snapshot: () => {
        calls += 1;
        return calls === 1
          ? new Promise((_resolve, reject) => {
              fail = reject;
            })
          : Promise.resolve(
              fixture({ retryAfterSeconds: 9, rateLimited: true })
            );
      },
    });
    const select = view.querySelector("select");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      fail(new Error("late"));
    });
    return expect(view.textContent).toContain("retry in about 9 s");
  });

  it("uses the browser gateway by default", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: fixture() }));
    const view = await render(undefined);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchSpy).toHaveBeenCalled();
    const gateway = createBrowserOptionsAnalyticsGateway();
    await gateway.snapshot({ symbol: "SPY" }).catch(() => undefined);
    await gateway.snapshot({ symbol: "SPY" }).catch(() => undefined);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    return expect(view.textContent).toContain("Options analytics");
  });
});
