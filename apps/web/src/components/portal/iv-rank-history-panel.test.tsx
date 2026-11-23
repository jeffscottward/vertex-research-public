// @vitest-environment jsdom
import type {
  OpenbbIvHistoryHorizon,
  OpenbbIvHistoryOutput,
  OpenbbIvHistoryPoint,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
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
  type IvHistoryGateway,
  OPENBB_REQUEST_TIMEOUT_MS,
} from "../../features/openbb/gateway.ts";
import { IvRankHistoryPanel } from "./iv-rank-history-panel.tsx";

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
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const renderPanel = async (element: ReactElement): Promise<HTMLDivElement> => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(element);
    await Promise.resolve();
  });
  return host;
};
const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const makePoint = (
  overrides: Partial<OpenbbIvHistoryPoint> & { date: string }
): OpenbbIvHistoryPoint => ({
  high52w: 30,
  iv: 20,
  ivPercentile: 50,
  ivRank: 50,
  low52w: 10,
  ...overrides,
});

const makePayload = (
  overrides: Partial<OpenbbIvHistoryOutput> = {}
): OpenbbIvHistoryOutput => {
  const points = overrides.points ?? [
    makePoint({ date: "2026-01-02", iv: 15, ivPercentile: 18, ivRank: 15 }),
    makePoint({ date: "2026-04-01", iv: 22, ivPercentile: 60, ivRank: null }),
    makePoint({ date: "2026-07-01", iv: 24, ivPercentile: 70, ivRank: 72 }),
    makePoint({ date: "2026-09-01", iv: 25, ivPercentile: 75, ivRank: null }),
    makePoint({ date: "2026-10-15", iv: 27, ivPercentile: 84, ivRank: 86 }),
    makePoint({ date: "2026-11-20", iv: 28, ivPercentile: 88, ivRank: 90 }),
  ];
  return {
    asOf: points.at(-1)?.date ?? null,
    basis: "vol_index_proxy",
    latest: points.at(-1) ?? null,
    minSessions: 252,
    own: {
      asOf: "2026-11-20",
      ivPercentile: null,
      ivRank: null,
      latestValue: 0.21,
      minSessions: 252,
      reason: "Needs 252 sessions with ATM IV (12 stored)",
      sessions: 12,
      windowSessions: 252,
    },
    points,
    proxy: {
      asOf: "2026-11-20",
      index: "VIX",
      ivPercentile: 88,
      ivRank: 90,
      latestValue: 28,
      minSessions: 252,
      reason: null,
      sessions: 252,
      windowSessions: 252,
    },
    proxyIndex: "VIX",
    reason: null,
    requestedSessions: 252,
    symbol: "SPY",
    unit: "vol_points",
    windowSessions: 252,
    ...overrides,
  };
};

describe("IvRankHistoryPanel", () => {
  it("shows loading state, then renders proxy chart, KPIs, bands, partial notice, and detail table", async () => {
    const deferred = createDeferred<OpenbbIvHistoryOutput>();
    const gateway: IvHistoryGateway = {
      ivHistory: vi.fn(() => deferred.promise),
    };

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={gateway} symbol="SPY" />
    );
    expect(
      container.querySelector('[data-iv-history-state="loading"]')?.textContent
    ).toContain("Loading SPY IV rank history");

    await act(async () => {
      deferred.resolve(makePayload());
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-iv-history-state="ready"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-iv-basis="vol_index_proxy"]')?.textContent
    ).toBe("Proxy: VIX");
    expect(
      container.querySelector('[data-iv-regime="high"]')?.textContent
    ).toBe("High IV (≥ 80)");
    expect(container.querySelector('[data-iv-kpi="rank"]')?.textContent).toBe(
      "90.0"
    );
    expect(
      container.querySelector('[data-iv-kpi="percentile"]')?.textContent
    ).toBe("88.0");
    expect(container.querySelector('[data-iv-band="high"]')).not.toBeNull();
    expect(container.querySelector('[data-iv-band="low"]')).not.toBeNull();
    expect(
      container.querySelectorAll('[data-series="iv-rank"]').length
    ).toBeGreaterThan(0);
    expect(
      container.querySelector('[data-series="iv-percentile"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-dot="iv-rank-isolated"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-iv-partial-notice]")?.textContent
    ).toContain("Showing 6 of 252 requested sessions");
    expect(container.querySelector("[data-iv-caveat]")?.textContent).toContain(
      "Cboe VIX"
    );
    expect(
      container.querySelectorAll("[data-iv-history-table] tbody tr").length
    ).toBe(6);
  });

  it("renders own ATM IV basis, single-point state, and handles null latest ivRank cleanly", async () => {
    const gateway: IvHistoryGateway = {
      ivHistory: vi.fn(async () =>
        makePayload({
          basis: "own_atm_iv",
          points: [
            makePoint({
              date: "2026-11-20",
              high52w: 0.25,
              iv: 0.2,
              ivPercentile: 15,
              ivRank: null,
              low52w: 0.2,
            }),
          ],
          proxy: null,
          proxyIndex: null,
          requestedSessions: 252,
          unit: "decimal",
        })
      ),
    };

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={gateway} headingLevel={3} symbol="SPY" />
    );
    expect(
      container.querySelector('[data-iv-basis="own_atm_iv"]')?.textContent
    ).toBe("Own 30d ATM IV");
    expect(container.querySelector('[data-iv-regime="low"]')?.textContent).toBe(
      "Low IV (≤ 20)"
    );
    expect(container.querySelector('[data-iv-kpi="rank"]')?.textContent).toBe(
      "Flat range"
    );
    expect(
      container.querySelector('[data-iv-kpi="latest-iv"]')?.textContent
    ).toBe("20.0%");
    expect(container.querySelector("[data-iv-single-point]")?.textContent).toBe(
      "1 rolling session available"
    );
    expect(container.querySelector('[data-series="iv-percentile"]')).toBeNull();
    expect(container.querySelector('[data-dot="iv-rank-latest"]')).toBeNull();
    expect(
      container.querySelector('[data-dot="iv-percentile-latest"]')
    ).not.toBeNull();
  });

  it("renders calm unavailable state without error badges for non-Core-7 tickers", async () => {
    const unavailablePayload = makePayload({
      basis: null,
      latest: null,
      own: {
        asOf: null,
        ivPercentile: null,
        ivRank: null,
        latestValue: null,
        minSessions: 252,
        reason: "No ATM IV sessions stored",
        sessions: 0,
        windowSessions: 252,
      },
      points: [],
      proxy: null,
      proxyIndex: null,
      reason: "Own ATM IV: No ATM IV sessions stored",
      symbol: "NVDA",
      unit: null,
    });
    const gateway: IvHistoryGateway = {
      ivHistory: vi.fn(async () => unavailablePayload),
    };

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={gateway} symbol="NVDA" />
    );
    const box = container.querySelector(
      '[data-iv-history-state="unavailable"]'
    );
    expect(box).not.toBeNull();
    expect(box?.getAttribute("role")).toBe("status");
    expect(box?.textContent).toContain("0 / 252 own ATM IV sessions stored");
    expect(box?.textContent).toContain("No ATM IV sessions stored");
    expect(container.querySelector("[data-error-code]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Unavailable payload with null reason
    const noReasonGateway: IvHistoryGateway = {
      ivHistory: vi.fn(async () => ({
        ...unavailablePayload,
        reason: null,
      })),
    };
    act(() => root?.unmount());
    host?.remove();
    const container2 = await renderPanel(
      <IvRankHistoryPanel gateway={noReasonGateway} symbol="NVDA" />
    );
    expect(
      container2.querySelector('[data-iv-history-state="unavailable"]')
    ).not.toBeNull();

    // Defensive caveat fallback when proxyIndex is absent
    const malformedCaveatGateway: IvHistoryGateway = {
      ivHistory: vi.fn(async () =>
        makePayload({
          basis: "vol_index_proxy",
          proxyIndex: null,
        })
      ),
    };
    act(() => root?.unmount());
    host?.remove();
    const container3 = await renderPanel(
      <IvRankHistoryPanel gateway={malformedCaveatGateway} symbol="SPY" />
    );
    expect(container3.querySelector("[data-iv-caveat]")?.textContent).toBe(
      "Research view only, not a trade signal."
    );
  });

  it("switches horizons, toggles series with last-series disabled guard, and switches Core 7 ticker", async () => {
    const full63 = Array.from({ length: 63 }, (_, index) =>
      makePoint({
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        ivPercentile: 40 + (index % 30),
        ivRank: 35 + (index % 30),
      })
    );
    const ivHistory = vi.fn(
      async (symbol: string, sessions: OpenbbIvHistoryHorizon = 252) =>
        makePayload({
          ...(sessions === 63 ? { points: full63 } : {}),
          requestedSessions: sessions,
          symbol,
        })
    );
    const onSymbolChange = vi.fn();

    const container = await renderPanel(
      <IvRankHistoryPanel
        gateway={{ ivHistory }}
        onSymbolChange={onSymbolChange}
        symbol="SPY"
        symbols={["SPY", "QQQ"]}
      />
    );
    expect(ivHistory).toHaveBeenLastCalledWith("SPY", 252);

    // Switch horizon to 3M (63)
    const radio63 = container.querySelector(
      'input[type="radio"][value="63"]'
    ) as HTMLInputElement;
    await act(async () => {
      radio63.click();
      await Promise.resolve();
    });
    expect(ivHistory).toHaveBeenLastCalledWith("SPY", 63);
    expect(container.querySelector("[data-iv-partial-notice]")).toBeNull();

    // Toggle off IV Percentile -> IV Rank button becomes disabled so chart cannot go blank
    const buttons = Array.from(container.querySelectorAll("button"));
    const rankBtn = buttons.find(
      (b) => b.textContent?.trim() === "IV Rank"
    ) as HTMLButtonElement;
    const pctlBtn = buttons.find(
      (b) => b.textContent?.trim() === "IV Percentile"
    ) as HTMLButtonElement;

    await act(async () => {
      pctlBtn.click();
    });
    expect(pctlBtn.getAttribute("aria-pressed")).toBe("false");
    expect(rankBtn.disabled).toBe(true);
    expect(container.querySelector('[data-series="iv-percentile"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-series="iv-rank"]').length
    ).toBeGreaterThan(0);

    // Turn IV Percentile back on, then turn IV Rank off -> IV Percentile becomes disabled
    await act(async () => {
      pctlBtn.click();
    });
    expect(rankBtn.disabled).toBe(false);
    await act(async () => {
      rankBtn.click();
    });
    expect(rankBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pctlBtn.disabled).toBe(true);
    expect(container.querySelector('[data-series="iv-rank"]')).toBeNull();
    expect(
      container.querySelector('[data-series="iv-percentile"]')
    ).not.toBeNull();

    // Switch ticker via Core 7 selector strip
    const qqqBtn = buttons.find(
      (b) => b.textContent?.trim() === "QQQ"
    ) as HTMLButtonElement;
    await act(async () => {
      qqqBtn.click();
    });
    expect(onSymbolChange).toHaveBeenCalledWith("QQQ");
  });

  it("transitions to no-answer after timeout and recovers on Retry", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<OpenbbIvHistoryOutput>();
    let call = 0;
    const gateway: IvHistoryGateway = {
      ivHistory: vi.fn(() => {
        call += 1;
        if (call === 1) return pending.promise;
        return Promise.resolve(makePayload());
      }),
    };

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={gateway} symbol="SPY" />
    );
    await act(async () => {
      vi.advanceTimersByTime(OPENBB_REQUEST_TIMEOUT_MS);
    });
    expect(
      container.querySelector("[data-iv-history-no-answer]")?.textContent
    ).toContain("no answer after 30 s");

    const retryBtn = container.querySelector(
      "[data-iv-history-no-answer] button"
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-iv-history-state="ready"]')
    ).not.toBeNull();
  });

  it("shows error alert on failure and recovers on Retry", async () => {
    let call = 0;
    const gateway: IvHistoryGateway = {
      ivHistory: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("network boom");
        return makePayload();
      }),
    };

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={gateway} symbol="SPY" />
    );
    expect(
      container.querySelector("[data-iv-history-error]")?.textContent
    ).toContain("network boom");

    const retryBtn = container.querySelector(
      "[data-iv-history-error] button"
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-iv-history-state="ready"]')
    ).not.toBeNull();
  });

  it("ignores stale resolutions and stale rejections after symbol changes or unmount", async () => {
    const first = createDeferred<OpenbbIvHistoryOutput>();
    const second = createDeferred<OpenbbIvHistoryOutput>();
    const ivHistory = vi
      .fn<IvHistoryGateway["ivHistory"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValueOnce(makePayload({ symbol: "IWM" }));

    const container = await renderPanel(
      <IvRankHistoryPanel gateway={{ ivHistory }} symbol="SPY" />
    );
    await act(async () => {
      root?.render(<IvRankHistoryPanel gateway={{ ivHistory }} symbol="QQQ" />);
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(<IvRankHistoryPanel gateway={{ ivHistory }} symbol="IWM" />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-iv-history="IWM"]')).not.toBeNull();
    expect(
      container.querySelector('[data-iv-history-state="ready"]')
    ).not.toBeNull();

    // Settle both superseded promises; UI must stay on IWM ready state
    first.resolve(makePayload({ symbol: "SPY" }));
    second.reject(new Error("late failure"));
    await flushMicrotasks();

    expect(
      container.querySelector('[data-iv-history-state="ready"]')
    ).not.toBeNull();
    expect(container.querySelector("[data-iv-history-error]")).toBeNull();
  });

  it("instantiates the default browser gateway when none is supplied", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"));
    try {
      const container = await renderPanel(<IvRankHistoryPanel symbol="SPY" />);
      await flushMicrotasks();
      expect(container.querySelector("[data-iv-history-error]")).not.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
