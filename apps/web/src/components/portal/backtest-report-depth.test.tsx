// @vitest-environment jsdom
import type { BacktestRunReportOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BarReplayControls,
  useBarReplayView,
} from "../../features/charts/bar-replay.tsx";
import {
  Histogram,
  SimulationPanel,
  TradesAnalysisPanel,
} from "./backtest-report-depth.tsx";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

const render = (element: ReactElement): HTMLElement => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
};

const report = (pnls: readonly number[]): BacktestRunReportOutput => ({
  bars: pnls.length,
  equity: [],
  firstT: T0,
  lastT: T0 + pnls.length * DAY,
  metrics: {} as BacktestRunReportOutput["metrics"],
  prices: [],
  seriesSha256: "f".repeat(64),
  trades: pnls.map((pnl, index) => ({
    balanceAfter: 0,
    entryPrice: 100,
    entryT: T0 + index * DAY,
    exitPrice: 100,
    exitReason: pnl > 0 ? "target" : "stop",
    exitT: T0 + (index + 1) * DAY,
    n: index + 1,
    netReturn: pnl / 10_000,
    pnl,
    units: 1,
  })),
  tradesTruncated: false,
});

describe("report depth panels", () => {
  it("shows the trades analysis with groups and histograms", () => {
    const html = render(
      <TradesAnalysisPanel report={report([300, -100, 200, -50])} />
    );
    expect(html.textContent).toContain("Payoff ratio");
    expect(html.textContent).toContain("By exit reason");
    expect(html.querySelectorAll("svg[role=img]")).toHaveLength(2);
    expect(
      render(<TradesAnalysisPanel report={report([])} />).textContent
    ).toBe("No trades.");
  });

  it("shows the Monte Carlo cone, histograms and prop-firm rules", () => {
    const pnls = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? -150 : 200
    );
    const html = render(
      <SimulationPanel capital={10_000} report={report(pnls)} />
    );
    expect(
      html.querySelector("[aria-label^='Monte Carlo cone']")
    ).not.toBeNull();
    expect(html.textContent).toContain("Final P/L across paths");
    expect(html.textContent).toContain("Prop-firm rule simulation");
    expect(html.querySelectorAll("[data-prop-status]")).toHaveLength(4);
    expect(
      render(<SimulationPanel capital={10_000} report={report([1])} />)
        .textContent
    ).toContain("needs at least two trades");
  });

  it("renders an empty histogram as text", () => {
    expect(
      render(<Histogram bins={[]} format={String} label="X" />).textContent
    ).toBe("X: no data.");
  });
});

describe("bar replay", () => {
  afterEach(() => vi.useRealTimers());

  it("starts, plays, steps and exits on the charts page controls", () => {
    vi.useFakeTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const candles = Array.from({ length: 10 }, (_, i) => ({
      close: 1,
      high: 1,
      id: String(i),
      low: 1,
      open: 1,
      timestamp: T0 + i * DAY,
      volume: 0,
    }));
    const markers = [
      { id: "a", text: "a", timestamp: T0 + 2 * DAY, value: 1 },
      { id: "b", text: "b", timestamp: T0 + 8 * DAY, value: 1 },
    ];
    const seen: { candles: number; markers: number }[] = [];
    const Harness = () => {
      const view = useBarReplayView({ candles }, markers);
      seen.push({ candles: view.candles.length, markers: view.markers.length });
      return (
        <BarReplayControls
          dispatch={view.dispatch}
          label={view.label}
          state={view.state}
          total={candles.length}
        />
      );
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Harness />));
    const click = (name: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === name
      );
      if (button === undefined) throw new Error(`no ${name}`);
      act(() => button.click());
    };
    expect(seen.at(-1)).toEqual({ candles: 10, markers: 2 });
    click("Start bar replay");
    expect(seen.at(-1)).toEqual({ candles: 6, markers: 1 });
    click("Step forward");
    expect(seen.at(-1)?.candles).toBe(7);
    click("Play");
    act(() => vi.advanceTimersByTime(5000));
    expect(seen.at(-1)).toEqual({ candles: 10, markers: 2 });
    expect(container.textContent).toContain("Bar 10 of 10");
    click("Step back");
    expect(seen.at(-1)?.candles).toBe(9);
    click("Exit replay");
    expect(container.textContent).toContain("Start bar replay");
    act(() => root.unmount());
  });
});
