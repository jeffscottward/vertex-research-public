// @vitest-environment jsdom
import {
  type ApiClient,
  type MarketRegimeOutput,
  REGIME_CREDIT_STALE_SECONDS,
  REGIME_DAILY_STALE_SECONDS,
  REGIME_GAMMA_PUSH_STALE_SECONDS,
  REGIME_INDEX_SYMBOLS,
  REGIME_RESEARCH_ONLY_NOTE,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: null as ApiClient | null }));

vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  createApiClient: vi.fn(() => runtime.client as ApiClient),
}));

import {
  MARKET_REGIME_REFRESH_MS,
  MarketRegimeSection,
  type MarketRegimeSectionProps,
} from "./market-regime-section.tsx";

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
  vi.useRealTimers();
});

const mount = async (
  props: MarketRegimeSectionProps = {}
): Promise<{
  container: HTMLElement;
  rerender: (next: MarketRegimeSectionProps) => Promise<void>;
}> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<MarketRegimeSection {...props} />));
  return {
    container,
    rerender: async (next) => {
      await act(async () => root.render(<MarketRegimeSection {...next} />));
    },
  };
};

const sampleRegime = (options?: {
  staleTrend?: boolean;
}): MarketRegimeOutput => {
  const staleTrend = options?.staleTrend === true;
  return {
    etfs: REGIME_INDEX_SYMBOLS.map((symbol) => {
      const isStaleRow = staleTrend && symbol === "IWM";
      const hasGamma = symbol === "SPY" || symbol === "QQQ";
      return {
        breadth90: {
          ageSeconds: 3600,
          armedOn: null,
          asOf: "2026-11-20T21:15:00.000Z",
          detail: "NYSE Breadth-90 IDLE.",
          latestAdvPct: 58,
          latestDate: "2026-11-20",
          latestFinal: true,
          latestKind: "NEUTRAL",
          latestUpPct: 60.2,
          scope: "market_wide",
          sessionsLeft: null,
          signalState: "IDLE",
          source: "breadth90",
          stale: false,
          staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
          state: "idle",
          strict: false,
        },
        credit: {
          ageSeconds: 180_000,
          asOf: "2026-11-20",
          detail: "US HY OAS 3.15% — calm.",
          hyOas: 3.15,
          hyOasBps: 315,
          hyOasChange20dBps: -5,
          hyOasPct1y: 24,
          igOas: 0.92,
          scope: "market_wide",
          source: "openbb_macro:HY_OAS",
          stale: false,
          staleLimitSeconds: REGIME_CREDIT_STALE_SECONDS,
          state: "calm",
        },
        dealerGamma: {
          ageSeconds: hasGamma ? 120 : null,
          asOf: hasGamma ? "2026-11-20T21:00:00.000Z" : null,
          callWall: hasGamma ? 605 : null,
          detail: hasGamma
            ? `${symbol} positive gamma.`
            : `No feed for ${symbol}.`,
          flip: hasGamma ? 580 : null,
          netGex: hasGamma ? 1_000_000 : null,
          oiSession: hasGamma ? "2026-11-20" : null,
          putWall: hasGamma ? 560 : null,
          scope: "etf",
          source: hasGamma ? "market_context_gex" : "none",
          spot: hasGamma ? 590 : null,
          spotVsFlip: hasGamma ? "above" : null,
          stale: false,
          staleLimitSeconds: REGIME_GAMMA_PUSH_STALE_SECONDS,
          state: hasGamma ? "positive" : "not_covered",
          upstreamRegime: hasGamma ? "dampened" : null,
        },
        hasStaleInputs: isStaleRow,
        missingCount: 0,
        mixedDrivers: isStaleRow
          ? [
              "Trend is uptrend but stale inputs block risk-on",
              "Trend input is stale",
            ]
          : [],
        staleCount: isStaleRow ? 1 : 0,
        summary: isStaleRow ? "mixed" : "risk_on",
        symbol,
        trend: {
          ageSeconds: isStaleRow ? 900_000 : 3600,
          asOf: isStaleRow ? "2026-11-10" : "2026-11-20",
          close: 500,
          detail: `${symbol} uptrend.`,
          pctVsSma50: 2.1,
          pctVsSma200: 8.5,
          scope: "etf",
          sessions: 252,
          sma50: 489.7,
          sma50AboveSma200: true,
          sma200: 460.8,
          source: "market_daily_series",
          stale: isStaleRow,
          staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
          state: "uptrend",
        },
        volatility: {
          ageSeconds: 600,
          asOf: "2026-11-20",
          atmIv30d: 0.17,
          detail: "VIX 15.20 (calm).",
          etfVolIndex: 15.2,
          etfVolIndexId:
            symbol === "QQQ"
              ? "VXN"
              : symbol === "SPY"
                ? "VIX"
                : symbol === "IWM"
                  ? "RVX"
                  : "VXD",
          ivPercentile: 30,
          scope: "market_wide",
          source: "openbb_vol_context",
          stale: false,
          staleLimitSeconds: REGIME_DAILY_STALE_SECONDS,
          state: "calm",
          termStructure: "contango",
          vix: 15.2,
          vix3mVix6m: 0.96,
          vix9dVix: 0.91,
          vixVix3m: 0.88,
        },
      };
    }),
    generatedAt: "2026-11-22T18:00:00.000Z",
    overall: {
      missingPillarCount: 0,
      staleEtfs: staleTrend ? ["IWM"] : [],
      stalePillarCount: staleTrend ? 1 : 0,
      summary: staleTrend ? "mixed" : "risk_on",
    },
    researchOnlyNote: REGIME_RESEARCH_ONLY_NOTE,
  };
};

describe("MarketRegimeSection", () => {
  it("renders loading state, then all 4 ETFs with values, sources, and research-only note", async () => {
    let resolve!: (value: MarketRegimeOutput) => void;
    const onStatusChange = vi.fn();
    const onBusyChange = vi.fn();
    const { container } = await mount({
      gateway: {
        get: () =>
          new Promise<MarketRegimeOutput>((res) => {
            resolve = res;
          }),
      },
      onBusyChange,
      onStatusChange,
    });

    expect(
      container.querySelector('[data-regime-state="loading"]')
    ).not.toBeNull();
    expect(onStatusChange).toHaveBeenCalledWith("loading");

    await act(async () => resolve(sampleRegime()));

    expect(
      container.querySelector('[data-regime-state="ready"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-regime-stale="false"]')
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-regime-etf]")).toHaveLength(4);
    expect(container.querySelector("[data-regime-stale-banner]")).toBeNull();
    expect(container.querySelector("[data-regime-mixed-drivers]")).toBeNull();
    // Pillar detail, scope and readable source labels are visible text; raw codes stay in data attributes.
    expect(container.textContent).toContain("NYSE Breadth-90 IDLE.");
    expect(container.textContent).toContain("Market-wide");
    expect(container.textContent).toContain("Daily price series");
    expect(container.textContent).toContain("OpenBB macro (HY OAS)");
    expect(container.textContent).toContain("Market-context GEX");
    expect(container.textContent).toContain("OpenBB volatility");
    expect(container.textContent).not.toContain("market_daily_series");
    expect(container.textContent).not.toContain("openbb_macro");
    expect(container.textContent).not.toContain("market_context_gex");
    expect(container.textContent).not.toContain("openbb_vol_context");
    expect(
      container
        .querySelector('[data-regime-etf="QQQ"] [data-regime-pillar="trend"]')
        ?.getAttribute("data-pillar-source")
    ).toBe("market_daily_series");
    const badges = [...container.querySelectorAll('[data-slot="badge"]')];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.getAttribute("data-plain")).toBe("true");
    }
    expect(
      container.querySelectorAll('[data-regime-etf] th[scope="row"]')
    ).toHaveLength(4);
    expect(container.textContent).toContain(REGIME_RESEARCH_ONLY_NOTE);
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("clearly marks stale inputs as Stale (never as current) and displays mixed drivers", async () => {
    const onStatusChange = vi.fn();
    const { container } = await mount({
      gateway: { get: async () => sampleRegime({ staleTrend: true }) },
      onStatusChange,
    });

    expect(
      container.querySelector('[data-regime-stale="true"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-regime-stale-banner]")?.textContent
    ).toContain("Stale inputs (1)");
    const iwmRow = container.querySelector('[data-regime-etf="IWM"]');
    expect(iwmRow?.getAttribute("data-regime-row-stale")).toBe("true");
    const iwmTrend = iwmRow?.querySelector('[data-regime-pillar="trend"]');
    expect(iwmTrend?.getAttribute("data-regime-stale")).toBe("true");
    expect(
      iwmTrend?.querySelector('[data-pillar-stale="true"]')?.textContent
    ).toContain("Stale");
    expect(
      container.querySelector("[data-regime-mixed-drivers]")?.textContent
    ).toContain("IWM: Trend is uptrend but stale inputs block risk-on");
    expect(onStatusChange).toHaveBeenLastCalledWith("stale");
  });

  it("renders forbidden state for non-operators, error + Retry on initial failure, and preserves last-known-good data on refresh error", async () => {
    const { container: forbidden } = await mount({
      gateway: {
        get: async () => {
          throw { code: "FORBIDDEN", message: "Operator access required" };
        },
      },
    });
    expect(
      forbidden.querySelector('[data-regime-state="forbidden"]')
    ).not.toBeNull();

    let calls = 0;
    const gateway = {
      get: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw { code: "UNAVAILABLE", message: "Backend down" };
        }
        if (calls === 2) {
          return sampleRegime();
        }
        throw { code: "UNAVAILABLE", message: "Transient refresh failure" };
      }),
    };

    const onStatusChange = vi.fn();
    const { container, rerender } = await mount({
      gateway,
      onStatusChange,
      refreshSignal: 0,
    });
    expect(
      container.querySelector('[data-regime-state="error"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Backend down");
    expect(onStatusChange).toHaveBeenLastCalledWith("error");

    // Click Retry -> recovers to ready
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(
      container.querySelector('[data-regime-state="ready"]')
    ).not.toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");

    // Trigger refreshSignal -> fails, keeps previous snapshot on screen with alert, and reports error status to header
    await rerender({ gateway, onStatusChange, refreshSignal: 1 });
    expect(
      container.querySelector('[data-regime-state="ready"]')
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Transient refresh failure"
    );
    expect(onStatusChange).toHaveBeenLastCalledWith("error");
  });

  it("uses browser client by default, polls on interval, and ignores stale out-of-order responses", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers: Array<{
      reject: (error: unknown) => void;
      resolve: (value: MarketRegimeOutput) => void;
    }> = [];
    const get = vi.fn(
      () =>
        new Promise<MarketRegimeOutput>((resolve, reject) => {
          answers.push({ reject, resolve });
        })
    );
    runtime.client = {
      marketRegime: { get },
    } as unknown as ApiClient;

    const { container } = await mount();
    expect(get).toHaveBeenCalledTimes(1);

    // Timer triggers a second request before the first settles
    await act(async () => {
      vi.advanceTimersByTime(MARKET_REGIME_REFRESH_MS);
    });
    expect(get).toHaveBeenCalledTimes(2);

    // Second request settles first with fresh data
    await act(async () => {
      answers[1]?.resolve(sampleRegime());
    });
    expect(
      container.querySelector('[data-regime-stale="false"]')
    ).not.toBeNull();

    // Older request rejects later -> ignored!
    await act(async () => {
      answers[0]?.reject({ code: "UNAVAILABLE", message: "Old error" });
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Trigger a third request and let an older one resolve late -> ignored!
    await act(async () => {
      vi.advanceTimersByTime(MARKET_REGIME_REFRESH_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(MARKET_REGIME_REFRESH_MS);
    });
    expect(get).toHaveBeenCalledTimes(4);
    await act(async () => {
      answers[3]?.resolve(sampleRegime());
    });
    await act(async () => {
      answers[2]?.resolve(sampleRegime({ staleTrend: true }));
    });
    expect(
      container.querySelector('[data-regime-stale="false"]')
    ).not.toBeNull();
  });
});
