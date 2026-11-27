// @vitest-environment jsdom
import type { ApiClient, MarketVolatilityOutput } from "@darkfactory/api";
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
  createBrowserMarketContextGateway,
  MARKET_CONTEXT_REFRESH_MS,
  MarketContextWorkspace,
  type MarketContextWorkspaceProps,
  sourceErrorFor,
} from "./market-context-workspace.tsx";
import type { MarketSourceStatus } from "./market-source-status.ts";

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

const series = (value: number, stale = false) => ({
  asOf: "2026-10-20",
  change1d: 0.4,
  pct1y: 62,
  stale,
  value,
});

const ready = (
  overrides: Partial<MarketVolatilityOutput> = {}
): MarketVolatilityOutput => ({
  implied: { band: "review", impliedPct: 1.08, multiple: 0.32 },
  sourceErrors: [],
  spread: null,
  spx: {
    movePct: -0.35,
    price: 5800,
    quoteTime: new Date(Date.now() - 2 * 60_000).toISOString(),
    sessionDate: "2026-10-21",
    sessionOpen: true,
  },
  vix: series(17.2),
  vixeq: series(24.1),
  vvix: series(95, true),
  ...overrides,
});

const mount = async (volatility: () => Promise<MarketVolatilityOutput>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<MarketContextWorkspace gateway={{ volatility }} />)
  );
  return container;
};

const renderWorkspace = async (props: MarketContextWorkspaceProps) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const rerender = (next: MarketContextWorkspaceProps) =>
    act(async () => root.render(<MarketContextWorkspace {...next} />));
  await rerender(props);
  return { container, rerender };
};

/** A gateway call per load; the test settles each answer later, in any order.
 * Executor form: the web tsconfig lib predates Promise.withResolvers. */
const queued = () => {
  const answers: {
    resolve: (value: MarketVolatilityOutput) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const volatility = vi.fn(
    () =>
      new Promise<MarketVolatilityOutput>((resolve, reject) => {
        answers.push({ reject, resolve });
      })
  );
  return { answers, volatility };
};

const vixValue = (container: HTMLElement) =>
  container.querySelector('[data-series="VIX"] dd')?.textContent;

describe("Market context", () => {
  it("shows volatility series, the S&P 500 move and the move band", async () => {
    const container = await mount(async () => ready());
    expect(
      container.querySelector('[data-series="VIX"]')?.textContent
    ).toContain("17.20");
    expect(
      container.querySelector('[data-series="VVIX"]')?.textContent
    ).toContain("stale");
    expect(
      container.querySelector('[data-series="VIXEQ − VIX"]')?.textContent
    ).toContain("No reading");
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "5800.00 (-0.35%)"
    );
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "VIX-implied move 1.08% · actual ×0.32"
    );
    const bandBadge = container.querySelector('[data-band="review"]');
    expect(bandBadge?.textContent).toContain("Review: large move");
    expect(bandBadge?.getAttribute("data-plain")).toBe("true");
    expect(container.querySelector("[data-source-errors]")).toBeNull();
    expect(
      container.querySelector('[role="group"][aria-label="Volatility"]')
        ?.children
    ).toHaveLength(4);
    expect(container.querySelector('[data-series="VIX"] dd')?.textContent).toBe(
      "17.20"
    );
    expect(container.querySelector("#mc-move")?.textContent).toBe(
      "S&P 500 move today"
    );
  });

  it("reports live, stale and partial data and failures to the page, reloading on the refresh signal", async () => {
    const statuses: MarketSourceStatus[] = [];
    const onStatusChange = (status: MarketSourceStatus) => {
      statuses.push(status);
    };
    let answer = async (): Promise<MarketVolatilityOutput> =>
      ready({ vvix: series(95) });
    const volatility = vi.fn(() => answer());
    const props = { gateway: { volatility }, onStatusChange };
    const { rerender } = await renderWorkspace(props);
    expect(statuses).toEqual(["loading", "ready"]);
    // Any stale series means the numbers on screen are old.
    answer = async () => ready();
    await rerender({ ...props, refreshSignal: 1 });
    expect(statuses.at(-1)).toBe("stale");
    // A failed source means part of the panel is missing.
    answer = async () =>
      ready({ sourceErrors: ["Cboe: HTTP 503"], vvix: series(95) });
    await rerender({ ...props, refreshSignal: 2 });
    expect(statuses.at(-1)).toBe("partial");
    answer = async () => {
      throw { code: "UNAVAILABLE", message: "down" };
    };
    await rerender({ ...props, refreshSignal: 3 });
    expect(volatility).toHaveBeenCalledTimes(4);
    expect(statuses).toEqual(["loading", "ready", "stale", "partial", "error"]);
  });

  it("reports a load in flight from mount, Retry and the timer, and holds Retry meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { answers, volatility } = queued();
    const busy: boolean[] = [];
    const onBusyChange = (value: boolean) => {
      busy.push(value);
    };
    const { container } = await renderWorkspace({
      gateway: { volatility },
      onBusyChange,
    });
    expect(busy).toEqual([true]);
    await act(async () =>
      answers[0]?.reject({ code: "UNAVAILABLE", message: "down" })
    );
    expect(busy).toEqual([true, false]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => container.querySelector("button")?.click());
    expect(volatility).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([true, false, true]);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () =>
      answers[1]?.reject({ code: "UNAVAILABLE", message: "still down" })
    );
    expect(busy).toEqual([true, false, true, false]);
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(MARKET_CONTEXT_REFRESH_MS);
    });
    expect(volatility).toHaveBeenCalledTimes(3);
    expect(busy.at(-1)).toBe(true);
    expect(container.querySelector("button")?.disabled).toBe(true);
    await act(async () => answers[2]?.resolve(ready()));
    expect(busy.at(-1)).toBe(false);
    expect(vixValue(container)).toBe("17.20");
  });

  it("keeps the newest answer when an older load settles last", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { answers, volatility } = queued();
    const statuses: MarketSourceStatus[] = [];
    const busy: boolean[] = [];
    const props: MarketContextWorkspaceProps = {
      gateway: { volatility },
      onBusyChange: (value) => {
        busy.push(value);
      },
      onStatusChange: (status) => {
        statuses.push(status);
      },
    };
    const { container, rerender } = await renderWorkspace(props);
    // The page Refresh lands while the mount load is still out.
    await rerender({ ...props, refreshSignal: 1 });
    expect(volatility).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]?.resolve(ready({ vix: series(20) })));
    expect(vixValue(container)).toBe("20.00");
    expect(busy.at(-1)).toBe(false);
    await act(async () =>
      answers[0]?.resolve(
        ready({ sourceErrors: ["Cboe: HTTP 503"], vix: series(10) })
      )
    );
    expect(vixValue(container)).toBe("20.00");
    expect(container.querySelector("[data-source-errors]")).toBeNull();
    expect(busy.at(-1)).toBe(false);
    // Two timer loads overlap; the older one fails after the newer one answered.
    await act(async () => {
      vi.advanceTimersByTime(MARKET_CONTEXT_REFRESH_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(MARKET_CONTEXT_REFRESH_MS);
    });
    expect(volatility).toHaveBeenCalledTimes(4);
    await act(async () => answers[3]?.resolve(ready({ vix: series(30) })));
    expect(busy.at(-1)).toBe(false);
    await act(async () =>
      answers[2]?.reject({ code: "UNAVAILABLE", message: "late" })
    );
    expect(vixValue(container)).toBe("30.00");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(busy.at(-1)).toBe(false);
    expect(statuses).toEqual(["loading", "stale"]);
  });

  it("names the cause and the response time of a series or quote that is null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T14:05:30.000Z"));
    const card = (container: HTMLElement, label: string) =>
      container.querySelector(`[data-series="${label}"]`)?.textContent;
    // No source error: the response has no reading, and the text says which response.
    const quiet = await mount(async () => ready({ spx: null }));
    expect(card(quiet, "VIXEQ − VIX")).toBe(
      "VIXEQ − VIXNo readingNo reading in the response of 14:05 UTC"
    );
    expect(quiet.querySelector("[data-spx-missing]")?.textContent).toBe(
      "S&P 500 quote: no reading in the response of 14:05 UTC · refreshes every minute"
    );
    // A source error is the cause: each text repeats the error of its own source.
    const failed = await mount(async () =>
      ready({
        sourceErrors: ["Cboe: HTTP 503", "S&P 500: quote request timed out"],
        spx: null,
        vix: null,
      })
    );
    expect(card(failed, "VIX")).toBe(
      "VIXNot receivedNot received from Cboe: HTTP 503"
    );
    expect(card(failed, "VIXEQ − VIX")).toBe(
      "VIXEQ − VIXNot receivedNot received from Cboe: HTTP 503"
    );
    expect(failed.querySelector("[data-spx-missing]")?.textContent).toBe(
      "S&P 500 quote not received: quote request timed out · response of 14:05 UTC · refreshes every minute"
    );
    // The error of one source is not the cause for the other.
    const other = await mount(async () =>
      ready({ sourceErrors: ["S&P 500: HTTP 500"], vix: null })
    );
    expect(card(other, "VIX")).toBe(
      "VIXNo readingNo reading in the response of 14:05 UTC"
    );
  });

  it("reads the error of one source from the display texts", () => {
    const errors = ["Cboe: HTTP 503", "S&P 500:  timed out "];
    expect(sourceErrorFor(errors, "Cboe")).toBe("HTTP 503");
    expect(sourceErrorFor(errors, "S&P 500")).toBe("timed out");
    expect(sourceErrorFor(errors, "Yahoo")).toBeNull();
    expect(sourceErrorFor([], "Cboe")).toBeNull();
    expect(sourceErrorFor(["Cboe: "], "Cboe")).toBe(
      "error text not reported by source"
    );
  });

  it("prints a unit after a number only", async () => {
    const container = await mount(async () =>
      ready({
        implied: { band: null, impliedPct: null, multiple: null },
        spx: {
          movePct: null,
          price: 5800,
          quoteTime: null,
          sessionDate: null,
          sessionOpen: false,
        },
        vix: { ...series(17.2), change1d: null, pct1y: null },
      })
    );
    expect(container.querySelector("[data-spx]")?.textContent).toBe(
      "5800.00 (no prior value)Session closedQuote time not reportedVIX-implied move no reading · actual no reading"
    );
    expect(
      container.querySelector('[data-series="VIX"]')?.textContent
    ).toContain("1d no prior value · 1y pct no reading · as of 2026-10-20");
  });

  it("states missing sections and source errors without inventing values", async () => {
    const container = await mount(async () =>
      ready({
        implied: null,
        sourceErrors: ["Cboe: HTTP 503"],
        spx: {
          movePct: null,
          price: 5800,
          quoteTime: null,
          sessionDate: null,
          sessionOpen: false,
        },
        vix: { ...series(17.2), change1d: 1.2, pct1y: null },
      })
    );
    expect(container.querySelector("[data-source-errors]")?.textContent).toBe(
      "Cboe: HTTP 503"
    );
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "Session closed"
    );
    expect(container.querySelector("[data-spx]")?.textContent).toContain(
      "5800.00 (no prior value)"
    );
    expect(
      container.querySelector('[data-series="VIX"]')?.textContent
    ).toContain("+1.20");
    const none = await mount(async () =>
      ready({
        implied: { band: null, impliedPct: 1, multiple: 1 },
        spx: null,
      })
    );
    expect(none.querySelector("[data-spx-missing]")?.textContent).toMatch(
      /^S&P 500 quote: no reading in the response of \d{2}:\d{2} UTC · refreshes every minute$/u
    );
    const unbanded = await mount(async () =>
      ready({ implied: { band: null, impliedPct: 1, multiple: 1 } })
    );
    expect(unbanded.querySelector("[data-band]")).toBeNull();
  });

  it("shows S&P 500 quote age and marks quotes older than the limit as stale", async () => {
    const now = new Date("2026-11-19T20:00:00.000Z");
    const nowFn = () => now;
    const statuses: MarketSourceStatus[] = [];
    const spxAt = (
      ageMs: number,
      sessionOpen: boolean,
      sessionDate: string | null = "2026-11-19"
    ) => ({
      movePct: -0.35,
      price: 5800,
      quoteTime: new Date(now.getTime() - ageMs).toISOString(),
      sessionDate,
      sessionOpen,
    });

    // Fresh open quote (sub-minute and clock skew clamp to <1m ago).
    const fresh = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({ spx: spxAt(-5000, true), vvix: series(95, false) }),
      },
      now: nowFn,
      onStatusChange: (s) => {
        statuses.push(s);
      },
    });
    expect(
      fresh.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("<1m ago");
    // New York time with its zone label: 20:00:05 UTC is 3:00 PM EST.
    expect(
      fresh.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toMatch(
      /^Quote 11\/19\/26, 3:00\sPM EST \(<1m ago\) · session 2026-11-19$/u
    );
    expect(fresh.container.querySelector("[data-spx-stale]")).toBeNull();
    expect(statuses.at(-1)).toBe("ready");

    // Stale open quote (20m old > 15m limit): shows Stale quote badge and flips status to stale.
    const staleOpen = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({
            spx: spxAt(20 * 60_000, true, null),
            vvix: series(95, false),
          }),
      },
      now: nowFn,
      onStatusChange: (s) => {
        statuses.push(s);
      },
    });
    expect(
      staleOpen.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("20m ago");
    expect(
      staleOpen.container.querySelector("[data-spx-stale]")?.textContent
    ).toContain("Stale quote");
    expect(statuses.at(-1)).toBe("stale");

    // Closed session 5h ago (fresh) vs 5d ago (stale) + unparseable quoteTime + null quoteTime with sessionDate.
    const closedFresh = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({ spx: spxAt(5 * 3_600_000, false), vvix: series(95, false) }),
      },
      now: nowFn,
    });
    expect(
      closedFresh.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("5h ago");
    expect(closedFresh.container.querySelector("[data-spx-stale]")).toBeNull();

    const closedStale = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({ spx: spxAt(5 * 86_400_000, false), vvix: series(95, false) }),
      },
      now: nowFn,
    });
    expect(
      closedStale.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("5d ago");
    expect(
      closedStale.container.querySelector("[data-spx-stale]")?.textContent
    ).toContain("Stale quote");

    const badTime = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({
            spx: {
              movePct: 0,
              price: 5800,
              quoteTime: "not-a-date",
              sessionDate: null,
              sessionOpen: false,
            },
            vvix: series(95, false),
          }),
      },
      now: nowFn,
    });
    expect(
      badTime.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("Quote time unreadable");

    const sessionOnly = await renderWorkspace({
      gateway: {
        volatility: async () =>
          ready({
            spx: {
              movePct: 0,
              price: 5800,
              quoteTime: null,
              sessionDate: "2026-11-19",
              sessionOpen: false,
            },
            vvix: series(95, false),
          }),
      },
      now: nowFn,
    });
    expect(
      sessionOnly.container.querySelector("[data-spx-quote-time]")?.textContent
    ).toContain("Quote time not reported · session 2026-11-19");
  });

  it("shows failures with a retry and access-required for non-operators", async () => {
    let fail = true;
    const container = await mount(async () => {
      if (fail) throw { code: "UNAVAILABLE", message: "ibkr-monitor down" };
      return ready();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "UNAVAILABLE: ibkr-monitor down"
    );
    fail = false;
    await act(async () => container.querySelector("button")?.click());
    expect(
      container.querySelector('[data-market-state="ready"]')
    ).not.toBeNull();
    const denied = await mount(async () => {
      throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
    });
    expect(denied.querySelector("[data-market-state]")).toBeNull();
    expect(denied.textContent).toMatch(/operator/iu);
  });

  it("shows loading first and refreshes once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let resolveFirst: (value: MarketVolatilityOutput) => void = () => undefined;
    // The web tsconfig lib predates Promise.withResolvers.
    const pending = new Promise<MarketVolatilityOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const volatility = vi.fn(() => pending);
    const container = await mount(volatility);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading market context…"
    );
    await act(async () => resolveFirst(ready()));
    await act(async () => {
      vi.advanceTimersByTime(MARKET_CONTEXT_REFRESH_MS);
    });
    expect(volatility).toHaveBeenCalledTimes(2);
  });

  it("creates the browser client lazily, once, on the page origin", async () => {
    const volatility = vi.fn(async () => ready());
    runtime.client = { ibkrMonitor: { volatility } } as unknown as ApiClient;
    const gateway = createBrowserMarketContextGateway();
    expect(runtime.origins).toEqual([]);
    await gateway.volatility();
    await gateway.volatility();
    expect(runtime.origins).toEqual([window.location.origin]);
    expect(volatility).toHaveBeenCalledWith({});
    expect(Object.isFrozen(gateway)).toBe(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<MarketContextWorkspace />));
    expect(volatility).toHaveBeenCalledTimes(3);
  });
});
