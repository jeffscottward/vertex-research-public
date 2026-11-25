// @vitest-environment jsdom
import type * as ApiModule from "@darkfactory/api";
import type { FlowOptionPrints, FlowOptionTicker } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const defaultOptionPrints = vi.fn();

vi.mock("@darkfactory/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("@darkfactory/api");
  return {
    ...actual,
    createApiClient: vi.fn(() => ({
      flow: {
        optionPrints: defaultOptionPrints,
      },
    })),
  };
});

import {
  FlowOptionTapePanel,
  type FlowOptionTapePanelProps,
} from "./flow-option-tape-panel.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  defaultOptionPrints.mockReset();
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const symbolForTicker = (
  ticker: FlowOptionTicker
): FlowOptionPrints["symbol"] => {
  if (ticker === "SPX") return "ES";
  if (ticker === "NDX") return "NQ";
  return ticker;
};

const makeResponse = (
  ticker: FlowOptionTicker,
  overrides: Partial<FlowOptionPrints> = {}
): FlowOptionPrints => ({
  asOf: "2026-11-23T15:30:00.000Z",
  delay:
    ticker === "NVDA"
      ? "Intraday, ~1-2 min cadence (parity staggered, QuantData order-flow/consolidated; market hours 09:30-16:00 ET)."
      : "Intraday, ~1-2 min cadence (parity staggered, QuantData order-flow/consolidated; market hours 09:30-16:15 ET).",
  freshness: {
    ageSeconds: 30,
    lastOkAt: "2026-11-23T15:29:30.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  prints: [
    {
      at: "2026-11-23T15:29:00.000Z",
      consolidation: "sweep",
      contract: `${ticker} 2026-12-18 500 C`,
      expiry: "2026-12-18",
      goldenSweep: true,
      moneyness: "otm",
      opening: true,
      premium: 420_000,
      price: 5.25,
      right: "call",
      sentiment: "bullish",
      side: "above_ask",
      size: 800,
      strike: 500,
      unusual: true,
      volumeOverOi: true,
    },
  ],
  schemaVersion: "flow-option-prints.v1",
  source: "QuantData order-flow/consolidated",
  summary: {
    bearishPremium: 0,
    blocks: 0,
    bullishPremium: 420_000,
    callPremium: 420_000,
    goldenSweeps: 1,
    putPremium: 0,
    sweeps: 1,
    ticker,
    trades: 1,
    unusualCount: 1,
  },
  symbol: symbolForTicker(ticker),
  ticker,
  unreadRanges: 0,
  windowEnd: "2026-11-23T15:30:00.000Z",
  windowMinutes: 60,
  windowStart: "2026-11-23T14:30:00.000Z",
  ...overrides,
});

const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label
  );
  if (!match) throw new Error(`Button "${label}" not found`);
  return match;
};

describe("FlowOptionTapePanel", () => {
  it("loads SPY by default, renders metrics and prints, and switches tickers, windows, and refresh", async () => {
    const calls: Array<{
      ticker?: FlowOptionTicker;
      windowMinutes?: unknown;
      limit?: unknown;
    }> = [];
    const client: NonNullable<FlowOptionTapePanelProps["client"]> = {
      optionPrints: vi.fn(async (input) => {
        calls.push(input ?? {});
        const nextTicker = input?.ticker ?? "SPY";
        const nextWindow =
          typeof input?.windowMinutes === "number" ? input.windowMinutes : 60;
        return makeResponse(nextTicker, {
          windowMinutes: nextWindow,
        });
      }) as NonNullable<FlowOptionTapePanelProps["client"]>["optionPrints"],
    };

    const container = await render(<FlowOptionTapePanel client={client} />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("SPY 2026-12-18 500 C");
    });

    expect(container.textContent).toContain("Live · 30s");
    expect(container.textContent).toContain(
      "QuantData order-flow/consolidated"
    );
    expect(container.textContent).toContain("0 unread gap ranges");
    expect(button(container, "SPY").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "60m").getAttribute("aria-pressed")).toBe("true");

    await act(async () => button(container, "NVDA").click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("NVDA 2026-12-18 500 C");
    });
    expect(container.textContent).toContain("09:30-16:00 ET");

    await act(async () => button(container, "Session").click());
    await vi.waitFor(() => {
      expect(calls.at(-1)).toEqual({
        limit: 50,
        ticker: "NVDA",
        windowMinutes: 390,
      });
    });

    await act(async () => button(container, "Refresh").click());
    await vi.waitFor(() => {
      expect(calls).toHaveLength(4);
    });
    expect(calls).toEqual([
      { limit: 50, ticker: "SPY", windowMinutes: 60 },
      { limit: 50, ticker: "NVDA", windowMinutes: 60 },
      { limit: 50, ticker: "NVDA", windowMinutes: 390 },
      { limit: 50, ticker: "NVDA", windowMinutes: 390 },
    ]);
  });

  it("renders loading and empty states and uses default createApiClient when no client prop is passed", async () => {
    const pending = deferred<FlowOptionPrints>();
    defaultOptionPrints.mockImplementation(() => pending.promise);

    const container = await render(<FlowOptionTapePanel initialTicker="IWM" />);
    expect(container.textContent).toContain(
      "Loading live option prints for IWM."
    );
    expect(container.textContent).toContain(
      "Live intraday option prints for SPY, SPX, QQQ, NDX, IWM and NVDA."
    );

    await act(async () => {
      pending.resolve(
        makeResponse("IWM", {
          prints: [],
          summary: {
            bearishPremium: 0,
            blocks: 0,
            bullishPremium: 0,
            callPremium: 0,
            goldenSweeps: 0,
            putPremium: 0,
            sweeps: 0,
            ticker: "IWM",
            trades: 0,
            unusualCount: 0,
          },
          unreadRanges: 2,
        })
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "No stored option prints for IWM in this window."
      );
    });
    expect(container.textContent).toContain("2 unread gap ranges catching up");
  });

  it("renders Error and non-Error failures and ignores stale settled/rejected responses", async () => {
    const first = deferred<FlowOptionPrints>();
    const second = deferred<FlowOptionPrints>();
    let callIndex = 0;

    const client: NonNullable<FlowOptionTapePanelProps["client"]> = {
      optionPrints: vi.fn(() => {
        callIndex += 1;
        if (callIndex === 1) return first.promise;
        if (callIndex === 2) return second.promise;
        if (callIndex === 3) {
          return Promise.reject(new Error("QuantData temporarily unavailable"));
        }
        return Promise.reject("unexpected-string-error");
      }) as NonNullable<FlowOptionTapePanelProps["client"]>["optionPrints"],
    };

    const container = await render(<FlowOptionTapePanel client={client} />);
    await act(async () => button(container, "QQQ").click());
    await act(async () => button(container, "IWM").click());

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "QuantData temporarily unavailable"
      );
    });

    // Stale first resolution and stale second rejection must be ignored
    await act(async () => {
      first.resolve(makeResponse("SPY"));
      second.reject(new Error("stale failure"));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "QuantData temporarily unavailable"
    );

    // Non-Error rejection falls back to default message
    await act(async () => button(container, "Refresh").click());
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not load live option prints."
      );
    });
  });

  it("clears stale ticker data on ticker or window change and ignores redundant clicks", async () => {
    const pendingNvda = deferred<FlowOptionPrints>();
    const pendingWindow = deferred<FlowOptionPrints>();
    let call = 0;
    const optionPrints = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(makeResponse("SPY"));
      if (call === 2) return pendingNvda.promise;
      return pendingWindow.promise;
    });
    const client = {
      optionPrints: optionPrints as NonNullable<
        FlowOptionTapePanelProps["client"]
      >["optionPrints"],
    };

    const container = await render(<FlowOptionTapePanel client={client} />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("SPY 2026-12-18 500 C");
    });

    // Clicking the already-active ticker or window is a no-op
    await act(async () => button(container, "SPY").click());
    await act(async () => button(container, "60m").click());
    expect(optionPrints).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("SPY 2026-12-18 500 C");

    // Switching ticker clears SPY data immediately and shows loading state
    await act(async () => button(container, "NVDA").click());
    expect(container.textContent).toContain(
      "Loading live option prints for NVDA."
    );
    expect(container.textContent).not.toContain("SPY 2026-12-18 500 C");

    // If the new ticker fails, previous SPY data stays cleared
    await act(async () => {
      pendingNvda.reject(new Error("NVDA unavailable"));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "NVDA unavailable"
      );
    });
    expect(container.textContent).not.toContain("SPY 2026-12-18 500 C");

    // Switching window clears previous error/data and shows loading state
    await act(async () => button(container, "Session").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      "Loading live option prints for NVDA."
    );
    await act(async () => {
      pendingWindow.resolve(makeResponse("NVDA", { windowMinutes: 390 }));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("NVDA 2026-12-18 500 C");
    });
  });
});
