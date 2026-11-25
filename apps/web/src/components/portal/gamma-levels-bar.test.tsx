// @vitest-environment jsdom
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

import type { GammaLevelsOverlay } from "../../features/charts/types.ts";
import {
  GammaLevelsBar,
  type GammaLevelsLoadState,
} from "./gamma-levels-bar.tsx";

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

const render = async (
  props: Readonly<{
    enabled: boolean;
    state: GammaLevelsLoadState;
    priceDigits?: number;
    replayActive?: boolean;
    onRetry?: () => void;
  }>
): Promise<HTMLDivElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <GammaLevelsBar
        enabled={props.enabled}
        priceDigits={props.priceDigits ?? 2}
        replayActive={props.replayActive ?? false}
        state={props.state}
        {...(props.onRetry === undefined ? {} : { onRetry: props.onRetry })}
      />
    )
  );
  return host;
};

const sampleOverlay = (
  overrides: Partial<GammaLevelsOverlay> = {}
): GammaLevelsOverlay => ({
  asOf: "2026-11-25T15:30:00Z",
  basis: 0,
  callWall: 615,
  flip: 602.5,
  kingNode: 615,
  maxPain: 600,
  putWall: 590,
  regime: "positive",
  source: "optionsAnalytics",
  spot: 605,
  symbol: "SPY",
  underlyingTicker: "SPY",
  ...overrides,
});

describe("GammaLevelsBar", () => {
  it("renders nothing when disabled or idle", async () => {
    const disabled = await render({
      enabled: false,
      state: { overlay: sampleOverlay(), type: "ready" },
    });
    expect(disabled.textContent).toBe("");
    const idle = await render({ enabled: true, state: { type: "idle" } });
    expect(idle.textContent).toBe("");
  });

  it("renders replay, loading, forbidden, empty, and error states", async () => {
    const replay = await render({
      enabled: true,
      replayActive: true,
      state: { overlay: sampleOverlay(), type: "ready" },
    });
    expect(replay.textContent).toContain("hidden during bar replay");

    const loading = await render({ enabled: true, state: { type: "loading" } });
    expect(loading.textContent).toContain("Loading gamma levels");

    const forbidden = await render({
      enabled: true,
      state: { type: "forbidden" },
    });
    expect(forbidden.textContent).toContain("Operator access required");

    const empty = await render({
      enabled: true,
      state: { reason: "no GEX stored.", type: "empty" },
    });
    expect(empty.textContent).toContain("Gamma levels: no GEX stored.");

    const onRetry = vi.fn();
    const errored = await render({
      enabled: true,
      onRetry,
      state: { message: "timed out", type: "error" },
    });
    expect(errored.textContent).toContain(
      "Could not load gamma levels: timed out"
    );
    const retryBtn = errored.querySelector("button");
    expect(retryBtn?.textContent).toBe("Retry");
    await act(async () => retryBtn?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    const erroredNoRetry = await render({
      enabled: true,
      state: { message: "unavailable", type: "error" },
    });
    expect(erroredNoRetry.querySelector("button")).toBeNull();
  });

  it("renders all five levels with distances, coincidence badge, missing dash, and flow_gex basis caption", async () => {
    const stock = await render({
      enabled: true,
      state: {
        overlay: sampleOverlay({ maxPain: null }),
        type: "ready",
      },
    });
    expect(stock.textContent).toContain("Gamma flip");
    expect(stock.textContent).toContain("602.50");
    expect(stock.textContent).toContain("Call wall");
    expect(stock.textContent).toContain("615.00");
    expect(stock.textContent).toContain("at call wall");
    expect(stock.textContent).toContain("not computed");
    expect(stock.textContent).toContain("QuantData estimate");

    const futures = await render({
      enabled: true,
      state: {
        overlay: sampleOverlay({
          asOf: "not-a-timestamp",
          basis: -4.5,
          callWall: 6100,
          flip: 5980,
          kingNode: 5900,
          maxPain: 6000,
          putWall: 5900,
          source: "flowGex",
          spot: null,
          symbol: "ES",
          underlyingTicker: "SPX",
        }),
        type: "ready",
      },
    });
    expect(futures.textContent).toContain("Stored flow_gex (SPX -4.50 basis)");
    expect(futures.textContent).toContain("as of not-a-timestamp");
    expect(futures.textContent).toContain("at put wall");

    const futuresPosBasis = await render({
      enabled: true,
      state: {
        overlay: sampleOverlay({
          basis: 8,
          source: "flowGex",
          symbol: "ES",
          underlyingTicker: "SPX",
        }),
        type: "ready",
      },
    });
    expect(futuresPosBasis.textContent).toContain("SPX +8.00 basis");

    const directFlow = await render({
      enabled: true,
      state: {
        overlay: sampleOverlay({
          basis: null,
          source: "flowGex",
          symbol: "SPY",
          underlyingTicker: null,
        }),
        type: "ready",
      },
    });
    expect(directFlow.textContent).toContain("Stored flow_gex (SPY)");
  });
});
