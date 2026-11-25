// @vitest-environment jsdom
import type {
  FlowSnapshot,
  MarketSecType,
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

import type { FlowSnapshotGateway } from "./flow-events-client.ts";
import {
  type GammaLevelsView,
  type OptionsAnalyticsReport,
  resolveGammaLevelsEligibility,
  useGammaLevelsView,
} from "./use-gamma-levels.ts";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
};

const optionsData = (hasLevels = true): OptionsAnalyticsOutput =>
  ({
    context: {
      levels: hasLevels
        ? {
            callWall: 615,
            callWallMoves: 1,
            dailyMove: 5,
            flip: 602,
            flipMoves: -0.5,
            kingNode: 615,
            putWall: 590,
            putWallMoves: -2,
          }
        : {
            callWall: null,
            callWallMoves: null,
            dailyMove: null,
            flip: null,
            flipMoves: null,
            kingNode: null,
            putWall: null,
            putWallMoves: null,
          },
      regime: hasLevels ? "positive" : "no_data",
    },
    exposure: { maxPain: hasLevels ? 600 : null },
    receivedAt: "2026-11-25T15:30:00Z",
    spot: 605,
    symbol: "SPY",
  }) as unknown as OptionsAnalyticsOutput;

const flowSnapshotData = (
  overrides: Partial<{ gex: FlowSnapshot["gex"] }> = {}
): FlowSnapshot =>
  ({
    gex:
      "gex" in overrides
        ? overrides.gex
        : {
            at: "2026-11-25T15:30:00Z",
            basis: 10,
            ivRegime: "contango",
            levels: {
              callWall: 6100,
              flip: 5980,
              kingNode: 6100,
              maxPain: 6000,
              putWall: 5900,
            },
            netDex: 1e6,
            regime: "positive",
            spot: 6000,
            symbolLevels: {
              callWall: 6110,
              flip: 5990,
              kingNode: 6110,
              maxPain: 6010,
              putWall: 5910,
            },
            ticker: "SPX",
            totalGex: 1e9,
            zeroDteShare: 0.4,
          },
    symbol: "ES",
  }) as unknown as FlowSnapshot;

interface HarnessProps {
  analyticsReport: OptionsAnalyticsReport | null;
  currency: string | null;
  flowSnapshot: FlowSnapshotGateway;
  replayActive: boolean;
  secType: MarketSecType | null;
  symbol: string | null;
}

const mountHook = async (initial: HarnessProps) => {
  let latest: GammaLevelsView | null = null;
  const Probe = (props: HarnessProps) => {
    latest = useGammaLevelsView(props);
    return null;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const update = async (props: HarnessProps) => {
    await act(async () => root.render(<Probe {...props} />));
    await flush();
  };
  await update(initial);
  return { get: () => latest as GammaLevelsView, update };
};

describe("resolveGammaLevelsEligibility", () => {
  it("classifies USD equities, supported futures, and ineligible instruments", () => {
    expect(resolveGammaLevelsEligibility(null, "USD", "SPY")).toBeNull();
    expect(resolveGammaLevelsEligibility("STK", "USD", "  ")).toBeNull();
    expect(resolveGammaLevelsEligibility("STK", "EUR", "SAP")).toBeNull();
    expect(resolveGammaLevelsEligibility("STK", "USD", " spy ")).toEqual({
      kind: "optionsAnalytics",
      symbol: "SPY",
    });
    expect(resolveGammaLevelsEligibility("FUT", "USD", "ES")).toEqual({
      kind: "flowGex",
      symbol: "ES",
    });
    expect(resolveGammaLevelsEligibility("CONTFUT", "USD", "NQ")).toEqual({
      kind: "flowGex",
      symbol: "NQ",
    });
    expect(resolveGammaLevelsEligibility("FUT", "USD", "CL")).toBeNull();
  });
});

describe("useGammaLevelsView", () => {
  it("maps OptionsAnalyticsReport states for US stocks without calling flowSnapshot", async () => {
    const flowSnapshot: FlowSnapshotGateway = {
      snapshot: vi.fn(async () => flowSnapshotData()),
    };
    const base: HarnessProps = {
      analyticsReport: null,
      currency: "USD",
      flowSnapshot,
      replayActive: false,
      secType: "STK",
      symbol: "SPY",
    };
    const { get, update } = await mountHook(base);
    expect(get().eligible).toBe(true);
    expect(get().state).toEqual({ type: "loading" });
    expect(flowSnapshot.snapshot).not.toHaveBeenCalled();

    await update({
      ...base,
      analyticsReport: { symbol: "SPY", type: "loading" },
    });
    expect(get().state).toEqual({ type: "loading" });

    await update({
      ...base,
      analyticsReport: {
        message: "rate limited",
        symbol: "SPY",
        type: "error",
      },
    });
    expect(get().state).toEqual({ message: "rate limited", type: "error" });

    await update({
      ...base,
      analyticsReport: {
        data: optionsData(false),
        symbol: "SPY",
        type: "ready",
      },
    });
    expect(get().state.type).toBe("empty");
    expect(get().overlay).toBeNull();

    await update({
      ...base,
      analyticsReport: {
        data: optionsData(true),
        symbol: "SPY",
        type: "ready",
      },
    });
    expect(get().state.type).toBe("ready");
    expect(get().overlay?.kingNode).toBe(615);

    // Replay hides overlay while preserving ready state.
    await update({
      ...base,
      analyticsReport: {
        data: optionsData(true),
        symbol: "SPY",
        type: "ready",
      },
      replayActive: true,
    });
    expect(get().overlay).toBeNull();

    // Toggling off disables overlay and returns idle state.
    await act(async () => get().setEnabled(false));
    expect(get().enabled).toBe(false);
    expect(get().state).toEqual({ type: "idle" });
    expect(get().overlay).toBeNull();

    // Ineligible symbol returns eligible=false.
    await update({ ...base, currency: "EUR", secType: "STK", symbol: "SAP" });
    expect(get().eligible).toBe(false);
  });

  it("loads stored flow_gex for futures, handles empty/no-basis/forbidden/error/retry, and cancels stale replies", async () => {
    let resolveFirst!: (value: FlowSnapshot) => void;
    let rejectSecond!: (error: unknown) => void;
    const firstPromise = new Promise<FlowSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<FlowSnapshot>((_, reject) => {
      rejectSecond = reject;
    });
    const snapshot = vi
      .fn<FlowSnapshotGateway["snapshot"]>()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise)
      .mockResolvedValueOnce(flowSnapshotData())
      .mockResolvedValueOnce(flowSnapshotData({ gex: null }))
      .mockResolvedValueOnce(
        flowSnapshotData({
          gex: {
            ...(flowSnapshotData().gex as NonNullable<FlowSnapshot["gex"]>),
            basis: null,
            symbolLevels: null,
          },
        })
      )
      .mockResolvedValueOnce(
        flowSnapshotData({
          gex: {
            ...(flowSnapshotData().gex as NonNullable<FlowSnapshot["gex"]>),
            symbolLevels: {
              callWall: null,
              flip: null,
              kingNode: null,
              maxPain: null,
              putWall: null,
            },
          },
        })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("forbidden"), { code: "FORBIDDEN" })
      )
      .mockRejectedValueOnce(new Error("boom"));

    const base: HarnessProps = {
      analyticsReport: null,
      currency: "USD",
      flowSnapshot: { snapshot },
      replayActive: false,
      secType: "FUT",
      symbol: "ES",
    };
    const { get, update } = await mountHook(base);
    expect(get().state).toEqual({ type: "loading" });

    // Switch symbol before first request resolves -> stale resolve ignored.
    await update({ ...base, symbol: "NQ" });
    await act(async () => resolveFirst(flowSnapshotData()));
    await flush();
    expect(get().state).toEqual({ type: "loading" });

    // Switch back to ES before second request rejects -> stale reject ignored.
    await update({ ...base, symbol: "ES" });
    await act(async () => rejectSecond(new Error("stale")));
    await flush();
    expect(get().state.type).toBe("ready");
    expect(get().overlay?.callWall).toBe(6110);

    // Retry -> gex: null -> empty state.
    await act(async () => get().onRetry?.());
    await flush();
    expect(get().state.type).toBe("empty");

    // Retry -> basis null -> empty state explaining basis not computed.
    await act(async () => get().onRetry?.());
    await flush();
    expect(get().state.type).toBe("empty");

    // Retry -> basis present, all symbolLevels null -> no-levels message (not basis message).
    await act(async () => get().onRetry?.());
    await flush();
    expect(get().state).toEqual({
      reason: "no GEX or max-pain levels computed for ES.",
      type: "empty",
    });
    // Retry -> forbidden.
    await act(async () => get().onRetry?.());
    await flush();
    expect(get().state).toEqual({ type: "forbidden" });

    // Retry -> error.
    await act(async () => get().onRetry?.());
    await flush();
    expect(get().state.type).toBe("error");
  });
});
