// @vitest-environment jsdom
import type { OptionsExpectedMoveOutput } from "@darkfactory/api";
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

import { ExpectedMoveBar } from "./expected-move-bar.tsx";

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

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};

const expiries = [
  { date: "2026-11-06", dte: 2 },
  { date: "2026-11-20", dte: 16 },
];

const readyData: OptionsExpectedMoveOutput = {
  band: {
    atmIv: 0.24,
    atmStrike: 600,
    basis: "atm_straddle_mid",
    callPrice: 10.2,
    callQuoteSource: "ibkr",
    expectedMove: 25.6,
    expectedMovePct: 0.0427,
    expiryCloseAt: "2026-11-20T21:00:00.000Z",
    expiryCloseMs: Date.parse("2026-11-20T21:00:00.000Z"),
    lowerBand: 574.4,
    putPrice: 10.23,
    putQuoteSource: "ibkr",
    straddleLower: 579.57,
    straddlePct: 0.0341,
    straddlePrice: 20.43,
    straddleUpper: 620.43,
    upperBand: 625.6,
  },
  currency: "USD",
  dte: 16,
  expiries,
  expiriesSources: ["quantdata", "ibkr", "yahoo"],
  expiry: "2026-11-20",
  notes: ["Research view only."],
  quoteTime: null,
  receivedAt: "2026-11-04T15:00:00.000Z",
  sources: [
    { message: null, source: "quantdata", status: "used" },
    { message: null, source: "ibkr", status: "used" },
    { message: null, source: "yahoo", status: "used" },
  ],
  spot: 600,
  spotSource: "quantdata",
  symbol: "SPY",
  unavailableReason: null,
};

describe("ExpectedMoveBar", () => {
  it("returns null when disabled and renders loading, replay, error, and unavailable states", async () => {
    const off = await mount(
      <ExpectedMoveBar
        enabled={false}
        expiries={expiries}
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry={null}
        state={{ type: "idle" }}
      />
    );
    expect(off.innerHTML).toBe("");

    const loading = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry={null}
        state={{ type: "loading" }}
      />
    );
    expect(loading.textContent).toContain("Loading expected move");
    const select = loading.querySelector<HTMLSelectElement>(
      "[data-expected-move-expiry]"
    );
    expect(select?.disabled).toBe(true);

    const replay = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        onExpiry={vi.fn()}
        priceDigits={2}
        replayActive={true}
        selectedExpiry="2026-11-20"
        state={{ data: readyData, type: "ready" }}
      />
    );
    expect(replay.textContent).toContain("hidden during bar replay");

    const onRetry = vi.fn();
    const errored = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={[]}
        onExpiry={vi.fn()}
        onRetry={onRetry}
        priceDigits={2}
        selectedExpiry={null}
        state={{ message: "Upstream timed out", type: "error" }}
      />
    );
    expect(errored.textContent).toContain("Upstream timed out");
    const retryBtn = errored.querySelector<HTMLButtonElement>("button");
    await act(async () => retryBtn?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    const erroredNoRetry = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={[]}
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry={null}
        state={{ message: "Failed", type: "error" }}
      />
    );
    expect(erroredNoRetry.querySelector("button")).toBeNull();

    const idle = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={[]}
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry={null}
        state={{ type: "idle" }}
      />
    );
    expect(idle.querySelector("[data-expected-move-status]")).toBeNull();

    const unavail = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry="2026-11-06"
        state={{
          data: {
            ...readyData,
            band: null,
            unavailableReason: "Expiry 2026-11-06 has already closed.",
          },
          type: "ready",
        }}
      />
    );
    expect(unavail.textContent).toContain("already closed");
  });

  it("renders quoted straddle, mixed sources, IV-model fallback, horizon notes, and expiry switches", async () => {
    const onExpiry = vi.fn();
    const quoted = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        horizonScale="compressed"
        onExpiry={onExpiry}
        priceDigits={2}
        selectedExpiry={null}
        state={{ data: readyData, type: "ready" }}
      />
    );
    expect(quoted.textContent).toContain("±$25.60");
    expect(quoted.textContent).toContain("$574.40 – $625.60");
    expect(quoted.textContent).toContain("$20.43");
    expect(quoted.textContent).toContain("ATM straddle mid · IBKR");
    expect(quoted.textContent).toContain(
      "compressed into the chart right margin"
    );

    const select = quoted.querySelector<HTMLSelectElement>(
      "[data-expected-move-expiry]"
    )!;
    await act(async () => {
      select.value = "2026-11-06";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onExpiry).toHaveBeenCalledWith("2026-11-06");

    const mixed = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        horizonScale="expanded"
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry="2026-11-20"
        state={{
          data: {
            ...readyData,
            band: {
              ...readyData.band!,
              atmIv: null,
              basis: "atm_straddle_last",
              callQuoteSource: "yahoo",
              putQuoteSource: "ibkr",
            },
          },
          type: "ready",
        }}
      />
    );
    expect(mixed.textContent).toContain("call Yahoo Finance, put IBKR");
    expect(mixed.textContent).toContain("expanded for readability");

    const modelOnly = await mount(
      <ExpectedMoveBar
        enabled={true}
        expiries={expiries}
        horizonScale="exact"
        onExpiry={vi.fn()}
        priceDigits={2}
        selectedExpiry="2026-11-20"
        state={{
          data: {
            ...readyData,
            band: {
              ...readyData.band!,
              basis: "atm_iv_model",
              callPrice: null,
              callQuoteSource: null,
              putPrice: null,
              putQuoteSource: null,
              straddleLower: null,
              straddlePct: null,
              straddlePrice: null,
              straddleUpper: null,
            },
          },
          type: "ready",
        }}
      />
    );
    expect(modelOnly.textContent).toContain("ATM IV model");
    expect(modelOnly.textContent).not.toContain("Straddle BE");
  });
});
