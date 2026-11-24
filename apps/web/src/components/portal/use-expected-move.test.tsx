// @vitest-environment jsdom
import type { OptionsExpectedMoveOutput } from "@darkfactory/api";
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

import type { DisplayCandle } from "../../features/charts/types.ts";
import { createFakeOptionsChainGateway } from "../../features/stock-detail/fake-gateways.ts";
import {
  type ExpectedMoveView,
  isExpectedMoveEligible,
  useExpectedMoveView,
} from "./use-expected-move.ts";

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

const DAY_MS = 86_400_000;
const t0 = Date.parse("2026-11-03T20:00:00.000Z");
const candles: DisplayCandle[] = [
  {
    close: 100,
    high: 101,
    id: "b0",
    low: 99,
    open: 100,
    timestamp: t0,
    volume: 1000,
  },
  {
    close: 101,
    high: 102,
    id: "b1",
    low: 100,
    open: 100,
    timestamp: t0 + DAY_MS,
    volume: 1200,
  },
];

describe("isExpectedMoveEligible", () => {
  it("allows only US STK symbols valid in OptionsChainSymbolSchema", () => {
    expect(isExpectedMoveEligible("STK", "USD", "spy")).toBe("SPY");
    expect(isExpectedMoveEligible("FUT", "USD", "ES")).toBeNull();
    expect(isExpectedMoveEligible("STK", "EUR", "SAP")).toBeNull();
    expect(isExpectedMoveEligible("STK", "USD", null)).toBeNull();
    expect(isExpectedMoveEligible("STK", "USD", "1INVALID")).toBeNull();
  });
});

describe("useExpectedMoveView", () => {
  it("loads on toggle, scopes expiry per symbol, handles errors/retry, replay, and stale responses", async () => {
    const fake = createFakeOptionsChainGateway();
    const expectedMove = vi.fn(fake.expectedMove);
    const gateway = { expectedMove };
    let latest!: ExpectedMoveView;
    const renderLog: {
      symbol: string | null;
      stateSymbol: string | null;
      hasCone: boolean;
    }[] = [];

    const Harness = ({
      symbol,
      secType = "STK",
      replayActive = false,
      bars = candles,
    }: Readonly<{
      symbol: string | null;
      secType?: string | null;
      replayActive?: boolean;
      bars?: readonly DisplayCandle[];
    }>) => {
      latest = useExpectedMoveView({
        candles: bars,
        currency: "USD",
        gateway,
        replayActive,
        secType,
        symbol,
      });
      renderLog.push({
        hasCone: latest.cone !== null,
        stateSymbol:
          latest.state.type === "ready" ? latest.state.data.symbol : null,
        symbol,
      });
      return null;
    };

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<Harness symbol="SPY" />));
    expect(latest.eligible).toBe(true);
    expect(latest.enabled).toBe(false);
    expect(latest.cone).toBeNull();
    expect(expectedMove).not.toHaveBeenCalled();

    // Enable -> fetches nearest expiry
    await act(async () => {
      latest.setEnabled(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(expectedMove).toHaveBeenCalledWith({ symbol: "SPY" });
    expect(latest.state.type).toBe("ready");
    expect(latest.cone).not.toBeNull();
    expect(latest.expiries.length).toBeGreaterThan(1);
    expect(latest.horizonScale).toBe("expanded");

    // Pick second expiry -> fetches with expiry
    const secondExpiry = latest.expiries[1]!.date;
    await act(async () => {
      latest.onExpiry(secondExpiry);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(expectedMove).toHaveBeenLastCalledWith({
      expiry: secondExpiry,
      symbol: "SPY",
    });
    expect(latest.selectedExpiry).toBe(secondExpiry);

    // Replay hides cone
    await act(async () =>
      root.render(<Harness replayActive={true} symbol="SPY" />)
    );
    expect(latest.cone).toBeNull();
    expect(latest.horizonScale).toBeNull();

    // Empty candles -> null horizonScale
    await act(async () => root.render(<Harness bars={[]} symbol="SPY" />));
    expect(latest.horizonScale).toBeNull();

    // Switch symbol -> never leaks SPY's state or cone during the QQQ commit
    renderLog.length = 0;
    await act(async () => root.render(<Harness symbol="QQQ" />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      renderLog.some(
        (entry) =>
          entry.symbol === "QQQ" &&
          (entry.stateSymbol === "SPY" ||
            (entry.stateSymbol === null && entry.hasCone))
      )
    ).toBe(false);
    expect(expectedMove).toHaveBeenLastCalledWith({ symbol: "QQQ" });
    expect(latest.selectedExpiry).toBeNull();

    // Switching from ready QQQ directly to ineligible FUT clears cone synchronously
    renderLog.length = 0;
    await act(async () => root.render(<Harness secType="FUT" symbol="ES" />));
    expect(
      renderLog.some(
        (entry) =>
          entry.symbol === "ES" && (entry.stateSymbol !== null || entry.hasCone)
      )
    ).toBe(false);
    await act(async () => root.render(<Harness symbol="QQQ" />));
    await act(async () => {
      await Promise.resolve();
    });
    // Error + retry
    await act(async () => root.render(<Harness symbol="FAIL" />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest.state.type).toBe("error");
    const callsBeforeRetry = expectedMove.mock.calls.length;
    await act(async () => {
      latest.onRetry();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(expectedMove.mock.calls.length).toBe(callsBeforeRetry + 1);

    // Disable cancels in-flight & resets to idle
    let resolveLate!: (value: OptionsExpectedMoveOutput) => void;
    let rejectLate!: (reason?: unknown) => void;
    expectedMove.mockImplementationOnce(
      () =>
        new Promise<OptionsExpectedMoveOutput>((resolve) => {
          resolveLate = resolve;
        })
    );
    await act(async () => root.render(<Harness symbol="NVDA" />));
    await act(async () => {
      latest.setEnabled(false);
    });
    expect(latest.state.type).toBe("idle");
    const sample = await fake.expectedMove({ symbol: "NVDA" });
    await act(async () => {
      resolveLate(sample);
      await Promise.resolve();
    });
    expect(latest.state.type).toBe("idle");

    // Stale rejection ignored too
    expectedMove.mockImplementationOnce(
      () =>
        new Promise<OptionsExpectedMoveOutput>((_resolve, reject) => {
          rejectLate = reject;
        })
    );
    await act(async () => {
      latest.setEnabled(true);
    });
    await act(async () => {
      latest.setEnabled(false);
    });
    await act(async () => {
      rejectLate(new Error("late failure"));
      await Promise.resolve();
    });
    expect(latest.state.type).toBe("idle");

    // Ineligible symbol: onExpiry is a safe no-op
    await act(async () => root.render(<Harness secType="FUT" symbol="ES" />));
    expect(latest.eligible).toBe(false);
    await act(async () => {
      latest.onExpiry("2026-11-20");
    });
    expect(latest.selectedExpiry).toBeNull();
  });
});
