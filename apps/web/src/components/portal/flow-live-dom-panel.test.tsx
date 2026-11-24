// @vitest-environment jsdom
import {
  buildFlowLiveDom,
  type FlowLiveDom,
  type FlowLiveDomStreamEvent,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  FlowLiveDomPanel,
  type LiveDomStreamGateway,
} from "./flow-live-dom-panel.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];

beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  setVisibility("visible");
  vi.useRealTimers();
});

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
};

const flushMicrotasks = async (steps = 6) => {
  for (let i = 0; i < steps; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const changeSelect = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const makeFrame = (
  over: Partial<Parameters<typeof buildFlowLiveDom>[0]> = {}
): FlowLiveDom =>
  buildFlowLiveDom({
    asks: [
      [6012.5, 52],
      [6012.75, 86],
    ],
    bids: [
      [6012.25, 68],
      [6012.0, 264],
    ],
    capturedAt: "2026-11-24T14:30:00.000Z",
    contract: "ESZ6",
    depthFeed: {
      error: null,
      lastAt: "2026-11-24T14:30:00.000Z",
      state: "live",
    },
    depthUpdates: 120,
    lastTrade: {
      price: 6012.5,
      side: "buy",
      size: 6,
      t: "2026-11-24T14:29:59.000Z",
    },
    minTick: 0.25,
    seq: 150,
    since: null,
    source: "live_stream",
    symbol: "ES",
    tapeFeed: {
      error: null,
      lastAt: "2026-11-24T14:29:59.000Z",
      state: "live",
    },
    tapeSeq: 30,
    volumeByPrice: [
      [6012.5, 240, 60, 0, 18],
      [6012.25, 40, 150, 0, 14],
      [6012.0, 300, 250, 50, 42],
    ],
    volumeSource: "streamed_tape",
    windowSeconds: 900,
    ...over,
  });

const streamOf = (
  events: readonly FlowLiveDomStreamEvent[],
  holdSignal?: AbortSignal
): AsyncIterable<FlowLiveDomStreamEvent> => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      yield event;
    }
    if (holdSignal !== undefined) {
      await new Promise<void>((resolve) => {
        if (holdSignal.aborted) {
          resolve();
          return;
        }
        holdSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  },
});

describe("FlowLiveDomPanel", () => {
  it("streams live frames, shows pulling/stacking deltas, keyboard inspection, lock/recenter, reset, cadence, window, pause, and symbol switch", async () => {
    const f1 = makeFrame({ depthUpdates: 120, seq: 150 });
    const f2 = makeFrame({
      asks: [
        [6012.5, 40],
        [6012.75, 100],
      ],
      bids: [
        [6012.25, 86],
        [6012.0, 264],
      ],
      depthUpdates: 121,
      seq: 151,
    });

    const liveDomStream = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      async (_input, options) =>
        streamOf(
          [
            { frame: f1, type: "frame" },
            { at: "2026-11-24T14:30:01.000Z", seq: 150, type: "heartbeat" },
            { frame: f2, type: "frame" },
          ],
          options?.signal
        )
    );
    const now = vi.fn(() => Date.parse("2026-11-24T14:30:10.000Z"));

    const { container, root } = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream }} now={now} symbol="SPY" />
    );
    await flushMicrotasks();

    expect(container.textContent).toContain("S&P 500");
    expect(container.querySelector("[data-live-dom-table]")).not.toBeNull();
    expect(container.textContent).toContain("+18");
    expect(container.textContent).toContain("-12");
    expect(container.textContent).toContain("POC");
    expect(container.textContent).toContain("LTP");
    expect(container.textContent).toContain("3x");

    const rows = container.querySelectorAll<HTMLTableRowElement>(
      "tr[data-live-dom-row]"
    );
    expect(rows.length).toBe(4);
    await act(async () => rows[0]?.click());
    expect(
      container.querySelector("[data-live-dom-inspection]")?.textContent
    ).toContain("6012.75");

    const press = async (row: HTMLTableRowElement | undefined, key: string) => {
      await act(async () => {
        row?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
        );
      });
    };
    await press(rows[0], "ArrowDown");
    expect(
      container.querySelector("[data-live-dom-inspection]")?.textContent
    ).toContain("6012.50");
    await press(rows[1], "End");
    expect(
      container.querySelector("[data-live-dom-inspection]")?.textContent
    ).toContain("6012.00");
    await press(rows[3], "Home");
    expect(
      container.querySelector("[data-live-dom-inspection]")?.textContent
    ).toContain("6012.75");
    await press(rows[0], "ArrowUp");
    await press(rows[0], "Tab");
    await press(rows[0], "Escape");
    expect(container.querySelector("[data-live-dom-inspection]")).toBeNull();

    const lockBtn = container.querySelector<HTMLButtonElement>(
      "[data-live-dom-lock]"
    )!;
    const recenterBtn = container.querySelector<HTMLButtonElement>(
      "[data-live-dom-recenter]"
    )!;
    await act(async () => lockBtn.click());
    expect(lockBtn.textContent).toContain("Axis locked");
    await act(async () => lockBtn.click());
    expect(lockBtn.textContent).toContain("Lock axis");
    await act(async () => lockBtn.click());
    await act(async () => recenterBtn.click());
    expect(lockBtn.textContent).toContain("Lock axis");

    const resetBtn = container.querySelector<HTMLButtonElement>(
      "[data-live-dom-reset]"
    )!;
    await act(async () => resetBtn.click());
    await flushMicrotasks();
    expect(liveDomStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        since: Math.floor(Date.parse("2026-11-24T14:30:10.000Z") / 1000),
        symbol: "ES",
      }),
      expect.anything()
    );
    await act(async () => resetBtn.click());
    await flushMicrotasks();
    expect(resetBtn.textContent).toContain("Reset vol");

    const cadenceSelect = container.querySelector<HTMLSelectElement>(
      "[data-live-dom-cadence]"
    )!;
    await changeSelect(cadenceSelect, "1000");
    const windowSelect = container.querySelector<HTMLSelectElement>(
      "[data-live-dom-window]"
    )!;
    await changeSelect(windowSelect, "3600");
    await flushMicrotasks();
    expect(liveDomStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cadenceMs: 1000,
        symbol: "ES",
        windowSeconds: 3600,
      }),
      expect.anything()
    );

    const pauseBtn = container.querySelector<HTMLButtonElement>(
      "[data-live-dom-pause]"
    )!;
    await act(async () => pauseBtn.click());
    expect(container.textContent).toContain("Paused");
    await act(async () => pauseBtn.click());
    await flushMicrotasks();
    expect(container.textContent).toContain("Live stream");

    await act(async () =>
      root.render(
        <FlowLiveDomPanel gateway={{ liveDomStream }} now={now} symbol="NQ" />
      )
    );
    await flushMicrotasks();
    expect(liveDomStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: "NQ" }),
      expect.anything()
    );
  });

  it("handles lease_expired reconnects, error backoff, non-Error throws, recorded fallback, hidden tab pause, and abort during stream", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fLive = makeFrame();
    const fFallback = makeFrame({
      asks: [],
      bids: [],
      depthFeed: { error: "HTTP 404", lastAt: null, state: "never" },
      lastTrade: null,
      source: "empty",
      volumeByPrice: [],
      volumeSource: "none",
    });

    const liveDomStream = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      async (_input, options) => {
        callCount += 1;
        if (callCount === 1) {
          return streamOf([
            { frame: fLive, type: "frame" },
            {
              at: "2026-11-24T14:30:20.000Z",
              reason: "lease_expired",
              retryAfterMs: 0,
              type: "reconnect",
            },
          ]);
        }
        if (callCount === 2) {
          throw new Error("gateway reset");
        }
        if (callCount === 3) {
          throw "non-error-failure";
        }
        if (callCount === 4) {
          return streamOf([
            { frame: fFallback, type: "frame" },
            {
              at: "2026-11-24T14:30:25.000Z",
              reason: "recorded_fallback",
              retryAfterMs: 5000,
              type: "reconnect",
            },
          ]);
        }
        return streamOf([], options?.signal);
      }
    );

    const { container } = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream }} symbol="ES" />
    );
    await flushMicrotasks(10);
    expect(callCount).toBe(2);
    expect(container.textContent).toContain("gateway reset");
    // Select a row on fLive so when empty fFallback arrives in call 4, inspectedRow resolves to null
    const liveRow = container.querySelector<HTMLTableRowElement>(
      "tr[data-live-dom-row]"
    );
    await act(async () => liveRow?.click());
    expect(
      container.querySelector("[data-live-dom-inspection]")
    ).not.toBeNull();

    // Advance 1 s error backoff -> call 3 throws non-Error
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await flushMicrotasks(6);
    expect(callCount).toBe(3);
    expect(container.textContent).toContain("Live DOM stream request failed");

    // Advance 2 s backoff -> call 4 returns empty frame + recorded_fallback 5s reconnect wait
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flushMicrotasks(6);
    expect(callCount).toBe(4);
    expect(
      container.querySelector("[data-live-dom-empty]")?.textContent
    ).toContain("No resting L2 quotes or prints");

    // Hide browser tab -> cancels pending 5 s reconnect timer and shows Tab hidden
    await act(async () => {
      setVisibility("hidden");
    });
    expect(container.textContent).toContain("Tab hidden");

    // Show browser tab -> reconnects (call 5)
    await act(async () => {
      setVisibility("visible");
    });
    await flushMicrotasks(6);
    expect(callCount).toBe(5);
  });

  it("ignores rejected stream promises and post-abort events after unmount", async () => {
    const rejectors: Array<(error: Error) => void> = [];
    const liveDomStream = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      () =>
        new Promise((_resolve, reject) => {
          rejectors.push(reject);
        })
    );
    const { container, root } = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream }} symbol="ES" />
    );
    expect(
      container.querySelector("[data-live-dom-empty]")?.textContent
    ).toContain("Connecting to ES live DOM stream");
    await act(async () => root.unmount());
    roots.pop();
    rejectors[0]?.(new Error("aborted after unmount"));
    await flushMicrotasks(2);

    // Also cover abort arriving inside the for-await consumer loop
    const yieldResolvers: Array<() => void> = [];
    const slowStream = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      async () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            yieldResolvers.push(resolve);
          });
          yield { frame: makeFrame(), type: "frame" as const };
        },
      })
    );
    const second = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream: slowStream }} symbol="ES" />
    );
    await flushMicrotasks(2);
    await act(async () => second.root.unmount());
    roots.pop();
    yieldResolvers[0]?.();
    await flushMicrotasks(2);
  });

  it("shows warning banner on upstream_interrupted, stops retrying on terminal auth errors, and renders phase-specific empty states", async () => {
    vi.useFakeTimers();
    let step = 0;
    const fLive = makeFrame();
    const liveDomStream = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      async () => {
        step += 1;
        if (step === 1) {
          return streamOf([
            { frame: fLive, type: "frame" },
            {
              at: "2026-11-24T14:30:10.000Z",
              reason: "upstream_interrupted",
              retryAfterMs: 5000,
              type: "reconnect",
            },
          ]);
        }
        throw Object.assign(new Error("Session expired"), {
          code: "UNAUTHORIZED",
        });
      }
    );

    const { container } = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream }} symbol="ES" />
    );
    await flushMicrotasks(6);
    expect(container.textContent).toContain("Reconnecting");
    expect(container.textContent).toContain("live stream interrupted");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushMicrotasks(6);
    expect(container.textContent).toContain("Sign-in required");
    expect(step).toBe(2);

    // Advancing timers does NOT retry after terminal auth error
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(step).toBe(2);

    // Empty panel states: status 403 auth_error, generic error, and paused with no frame
    const forbidden = vi.fn<LiveDomStreamGateway["liveDomStream"]>(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    });
    const view403 = await mount(
      <FlowLiveDomPanel gateway={{ liveDomStream: forbidden }} symbol="NQ" />
    );
    await flushMicrotasks(4);
    expect(
      view403.container.querySelector("[data-live-dom-empty]")?.textContent
    ).toContain("Sign-in is required");

    const errBeforeFrame = vi.fn<LiveDomStreamGateway["liveDomStream"]>(
      async () => {
        throw Object.assign(new Error("network down"), {
          code: "TIMEOUT",
          status: 503,
        });
      }
    );
    const viewErr = await mount(
      <FlowLiveDomPanel
        gateway={{ liveDomStream: errBeforeFrame }}
        symbol="ES"
      />
    );
    await flushMicrotasks(4);
    expect(
      viewErr.container.querySelector("[data-live-dom-empty]")?.textContent
    ).toContain("has not connected yet");

    const pauseBtn = viewErr.container.querySelector<HTMLButtonElement>(
      "[data-live-dom-pause]"
    )!;
    await act(async () => pauseBtn.click());
    expect(
      viewErr.container.querySelector("[data-live-dom-empty]")?.textContent
    ).toContain("is paused");
  });
});
