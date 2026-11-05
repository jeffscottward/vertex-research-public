// @vitest-environment jsdom
import type { JevVerdict, JevVerdictOutput } from "@darkfactory/api";
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
  createBrowserJevVerdictGateway,
  type JevVerdictGateway,
} from "./jev-verdict-client.ts";
import { JevVerdictPanel } from "./jev-verdict-panel.tsx";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW_MS = Date.parse("2026-11-05T15:00:00.000Z");
const now = () => NOW_MS;

const mount = async (element: React.ReactElement): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(element);
  });
  return host;
};

const verdict = (overrides: Partial<JevVerdict> = {}): JevVerdict => ({
  choice: "BULLISH",
  dataAsOf: "2026-11-04",
  decidedAt: "2026-11-05T14:50:00.000Z",
  factors: [{ key: "trend_up", label: "Uptrend", probability: 0.8 }],
  model: "typesafe/jev-test",
  probabilities: { BEARISH: 0.1, BULLISH: 0.75, NEUTRAL: 0.15 },
  reason: "P(BULLISH)=0.75; uptrend 0.80",
  sentFields: ["ticker", "last"],
  stance: "BULLISH",
  ...overrides,
});

const output = (
  overrides: Partial<JevVerdictOutput> = {}
): JevVerdictOutput => ({
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: ["Display only. The verdict never places, changes or cancels orders."],
  refreshed: false,
  staleAfterSeconds: 3600,
  state: "none",
  symbol: "SPY",
  throttled: false,
  verdict: null,
  ...overrides,
});

const gateway = (
  get: JevVerdictGateway["get"],
  refresh: JevVerdictGateway["refresh"] = async () => output()
) => ({ get: vi.fn(get), refresh: vi.fn(refresh) });

const button = (view: HTMLElement): HTMLButtonElement => {
  const found = view.querySelector("button");
  if (found === null) throw new Error("no button");
  return found;
};

const click = async (view: HTMLElement): Promise<void> => {
  await act(async () => {
    button(view).click();
  });
};

describe("JevVerdictPanel", () => {
  it("reads the cache on load and asks JEV only on click", async () => {
    const fresh = output({
      refreshed: true,
      state: "fresh",
      verdict: verdict(),
    });
    const fake = gateway(
      async () => output(),
      async () => fresh
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    expect(fake.get).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(fake.refresh).not.toHaveBeenCalled();
    expect(view.querySelector("[data-jev-empty]")?.textContent).toContain(
      "every 30 min"
    );
    expect(button(view).disabled).toBe(false);
    await click(view);
    expect(fake.refresh).toHaveBeenCalledWith({ symbol: "SPY" });
    const text = view.textContent ?? "";
    expect(view.querySelector('[data-stance="BULLISH"]')).not.toBeNull();
    expect(text).toContain("Bullish");
    expect(text).toContain("75%");
    expect(text).toContain("Uptrend80%");
    expect(text).toContain(
      "Decided 2026-11-05 14:50 UTC · model typesafe/jev-test · prices to 2026-11-04"
    );
    expect(text).toContain("ticker, last");
    expect(text).toContain("A verdict older than 60 min is marked stale.");
    expect(view.querySelector("[data-jev-stale]")).toBeNull();
  });

  it("shows stale verdicts, last failures and the throttle wait", async () => {
    const fake = gateway(async () =>
      output({
        lastFailure: {
          at: "2026-11-05T14:55:00.000Z",
          code: "JEV_HTTP",
          message: "JEV request failed (HTTP 500)",
        },
        nextRefreshAt: "2026-11-05T15:20:00.000Z",
        state: "stale",
        verdict: verdict({
          dataAsOf: null,
          factors: [],
          model: null,
          stance: "NEUTRAL",
        }),
      })
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    expect(view.querySelector("[data-jev-stale]")).not.toBeNull();
    expect(
      view.querySelector('[data-failure-code="JEV_HTTP"]')?.textContent
    ).toContain("Last request failed at 2026-11-05 14:55 UTC");
    expect(view.querySelector("[data-jev-next]")?.textContent).toBe(
      "Next refresh after 2026-11-05 15:20 UTC"
    );
    expect(button(view).disabled).toBe(true);
    const decided = view.querySelector("[data-jev-decided-at]")?.textContent;
    expect(decided).toBe("Decided 2026-11-05 14:50 UTC");
    expect(view.querySelector("ul.space-y-1.text-sm")).toBeNull();
  });

  it("enables the button again when the throttle window ends", async () => {
    vi.useFakeTimers();
    let clock = NOW_MS;
    const fake = gateway(async () =>
      output({ nextRefreshAt: "2026-11-05T15:00:01.000Z" })
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={() => clock} symbol="SPY" />
    );
    expect(button(view).disabled).toBe(true);
    clock += 1000;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button(view).disabled).toBe(false);
  });

  it("does not arm a timer past the setTimeout limit", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const fake = gateway(async () =>
      output({ nextRefreshAt: "2027-01-05T15:00:00.000Z" })
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    expect(button(view).disabled).toBe(true);
    expect(
      timer.mock.calls.some(([, delay]) => (delay ?? 0) > 2_147_483_647)
    ).toBe(false);
  });

  it("reports throttled and failed refreshes", async () => {
    let refreshCalls = 0;
    const fake = gateway(
      async () => output(),
      async () => {
        refreshCalls += 1;
        if (refreshCalls === 2)
          throw Object.assign(new Error("JEV verdict is not configured"), {
            code: "NOT_CONFIGURED",
          });
        return output({ nextRefreshAt: null, throttled: refreshCalls === 1 });
      }
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    await click(view);
    expect(view.querySelector("[data-notice-code]")).toBeNull();
    await click(view);
    expect(
      view.querySelector('[data-notice-code="NOT_CONFIGURED"]')?.textContent
    ).toBe("JEV verdict is not configured");
    fake.refresh.mockResolvedValueOnce(
      output({ nextRefreshAt: "2026-11-05T15:30:00.000Z", throttled: true })
    );
    await click(view);
    expect(
      view.querySelector('[data-notice-code="THROTTLED"]')?.textContent
    ).toBe("Refresh limit reached. Next refresh after 2026-11-05 15:30 UTC.");
  });

  it("explains an unconfigured server and disables the button", async () => {
    const fake = gateway(async () => output({ configured: false }));
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    expect(view.querySelector("[data-jev-unconfigured]")).not.toBeNull();
    expect(view.querySelector("[data-jev-empty]")).toBeNull();
    expect(button(view).disabled).toBe(true);
  });

  it("shows a load error with its code", async () => {
    const fake = gateway(async () => {
      throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
    });
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    const alert = view.querySelector('[role="alert"]');
    expect(alert?.getAttribute("data-error-code")).toBe("FORBIDDEN");
    expect(button(view).disabled).toBe(true);
  });

  it("ignores late answers after a symbol change", async () => {
    const pendingGets: {
      resolve: (value: JevVerdictOutput) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const pendingRefreshes: {
      resolve: (value: JevVerdictOutput) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const fake = gateway(
      ({ symbol }) =>
        symbol === "SPY"
          ? new Promise((resolve, reject) => {
              pendingGets.push({ reject, resolve });
            })
          : Promise.resolve(output({ symbol })),
      () =>
        new Promise((resolve, reject) => {
          pendingRefreshes.push({ reject, resolve });
        })
    );
    const view = await mount(
      <JevVerdictPanel gateway={fake} now={now} symbol="SPY" />
    );
    const rerender = async (symbol: string) => {
      await act(async () => {
        root?.render(
          <JevVerdictPanel gateway={fake} now={now} symbol={symbol} />
        );
      });
    };
    await rerender("QQQ");
    await act(async () => {
      pendingGets[0]?.resolve(output({ state: "fresh", verdict: verdict() }));
    });
    expect(view.querySelector("[data-stance]")).toBeNull();
    await rerender("SPY");
    await rerender("QQQ");
    await act(async () => {
      pendingGets[1]?.reject(new Error("late"));
    });
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.textContent).toContain("JEV verdict · QQQ");
    await click(view);
    expect(button(view).textContent).toBe("Asking JEV…");
    await rerender("DIA");
    expect(button(view).textContent).toBe("Ask JEV");
    await act(async () => {
      pendingRefreshes[0]?.resolve(
        output({ state: "fresh", verdict: verdict() })
      );
    });
    expect(view.querySelector("[data-stance]")).toBeNull();
    await click(view);
    await rerender("IWM");
    await act(async () => {
      pendingRefreshes[1]?.reject(new Error("late"));
    });
    expect(view.querySelector("[data-notice-code]")).toBeNull();
    expect(pendingRefreshes).toHaveLength(2);
  });

  it("uses the browser gateway by default", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: output() }));
    const view = await mount(<JevVerdictPanel symbol="SPY" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchSpy).toHaveBeenCalled();
    const browser = createBrowserJevVerdictGateway();
    await browser.get({ symbol: "SPY" }).catch(() => undefined);
    await browser.refresh({ symbol: "SPY" }).catch(() => undefined);
    await browser.refresh({ symbol: "SPY" }).catch(() => undefined);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(view.textContent).toContain("JEV verdict · SPY");
  });
});
