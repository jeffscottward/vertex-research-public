// @vitest-environment jsdom
import type { BacktestGetOutput } from "@darkfactory/api";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// Test-only relative import: analytics run server-side and stay out of the browser bundle.
import {
  type AnalyticsEquityPoint,
  computeBacktestAnalytics,
} from "../../../../../packages/api/src/backtest-analytics.ts";

import {
  formatPValue,
  MultipleTestingPanel,
  PairsLensPanel,
  SignificancePanel,
  VolatilityPanel,
} from "./backtest-quant-panels.tsx";

type Analytics = BacktestGetOutput["backtest"]["analytics"];

const render = (element: ReactElement): HTMLElement => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
};

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2024, 0, 1);
const series = (values: readonly number[]): AnalyticsEquityPoint[] =>
  values.map((equity, index) => ({
    equity,
    t: new Date(START + index * DAY).toISOString(),
  }));

const drifting = series(
  Array.from(
    { length: 120 },
    (_, index) => 100 * 1.002 ** index * (1 + 0.01 * Math.sin(index * 1.3))
  )
);

type Ledger = Readonly<{
  scope: "strategy" | "task";
  key: string;
  total: number;
  others: readonly Readonly<{
    id: string;
    returns: number;
    meanReturn: number | null;
    stdReturn: number | null;
    firstT: string | null;
    lastT: string | null;
  }>[];
}>;

const LEDGER: Ledger = {
  key: "strategy-1",
  others: [
    {
      firstT: "2024-01-01",
      id: "bt-other",
      lastT: "2024-04-29",
      meanReturn: 0.0001,
      returns: 119,
      stdReturn: 0.01,
    },
  ],
  scope: "strategy",
  total: 3,
};

const analyticsFor = (
  equity: AnalyticsEquityPoint[],
  ledger: Ledger | null = LEDGER
): Analytics =>
  computeBacktestAnalytics({ equity, id: "bt-quant", ledger, trades: [] });

describe("formatPValue", () => {
  it("formats small, ordinary and missing p-values", () => {
    expect(formatPValue(0.0004)).toBe("<0.001");
    expect(formatPValue(0.0412)).toBe("0.041");
    expect(formatPValue(null)).toBe("—");
    expect(formatPValue(undefined)).toBe("—");
    return expect(formatPValue(Number.NaN)).toBe("—");
  });
});

describe("SignificancePanel", () => {
  it("shows the t-test and both stationary bootstrap rows", () => {
    const view = render(
      <SignificancePanel analytics={analyticsFor(drifting)} />
    );
    const rows = [...view.querySelectorAll("[data-test-row]")].map((row) =>
      row.getAttribute("data-test-row")
    );
    expect(rows).toEqual([
      "t-test, mean return per period",
      "Stationary bootstrap, mean return per period",
      "Stationary bootstrap, Sharpe (ann.)",
    ]);
    expect(view.textContent).toContain("Two-sided t-test p-value");
    return expect(view.textContent).toContain("1000 resamples");
  });

  it("omits the t-test and the Sharpe row when returns have no spread", () => {
    // Equity doubles every day: every return is exactly 1.
    const view = render(
      <SignificancePanel analytics={analyticsFor(series([1, 2, 4, 8, 16]))} />
    );
    const rows = [...view.querySelectorAll("[data-test-row]")].map((row) =>
      row.getAttribute("data-test-row")
    );
    expect(rows).toEqual(["Stationary bootstrap, mean return per period"]);
    return expect(view.textContent).not.toContain("Two-sided");
  });

  it("marks only p-values below 0.05", () => {
    const flat = series(
      Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 100 : 101))
    );
    const view = render(<SignificancePanel analytics={analyticsFor(flat)} />);
    return expect(
      view.querySelectorAll("[data-test-row] .text-success-foreground")
    ).toHaveLength(0);
  });

  it("shows the t-test alone when no bootstrap result exists", () => {
    const base = analyticsFor(drifting);
    const view = render(
      <SignificancePanel
        analytics={{
          ...base,
          significance: { ...base.significance, stationaryBootstrap: null },
        }}
      />
    );
    return expect(view.querySelectorAll("[data-test-row]")).toHaveLength(1);
  });

  it("explains the minimum input when no test can run", () => {
    const view = render(
      <SignificancePanel analytics={analyticsFor(series([1, 2]))} />
    );
    return expect(view.textContent).toContain(
      "Needs at least three equity returns"
    );
  });
});

describe("MultipleTestingPanel", () => {
  it("shows the deflated Sharpe and Benjamini-Hochberg results for the ledger", () => {
    const view = render(
      <MultipleTestingPanel analytics={analyticsFor(drifting)} />
    );
    expect(
      view.querySelector('[data-multiple-testing="strategy"]')
    ).not.toBeNull();
    expect(view.querySelector('[data-stat="Trials"]')?.textContent).toContain(
      "3"
    );
    expect(
      view.querySelector('[data-stat="Deflated Sharpe"]')?.textContent
    ).toMatch(/%$/);
    return expect(
      view.querySelector('[data-stat="Discoveries (5% FDR)"]')?.textContent
    ).toContain("of 3");
  });

  it("states the reasons when the backtest has no usable returns", () => {
    const view = render(
      <MultipleTestingPanel
        analytics={analyticsFor(series([1, 2]), {
          ...LEDGER,
          scope: "task",
        })}
      />
    );
    expect(view.querySelector('[data-multiple-testing="task"]')).not.toBeNull();
    expect(view.textContent).toContain("Deflated Sharpe: This backtest needs");
    return expect(view.textContent).toContain(
      "Benjamini-Hochberg: This backtest"
    );
  });

  it("explains a missing ledger", () => {
    const view = render(
      <MultipleTestingPanel analytics={analyticsFor(drifting, null)} />
    );
    return expect(view.textContent).toContain("need the trial ledger");
  });
});

describe("VolatilityPanel", () => {
  it("shows the Ljung-Box test and the GARCH forecast", () => {
    const view = render(<VolatilityPanel analytics={analyticsFor(drifting)} />);
    expect(
      view.querySelector('[data-stat="Ljung-Box Q (squared)"]')?.textContent
    ).not.toContain("—");
    expect(
      view.querySelector('[data-stat="21-period vol (ann.)"]')?.textContent
    ).toMatch(/%$/);
    expect(view.textContent).not.toContain("GARCH:");
    return expect(view.textContent).toContain("Research display only");
  });

  it("states why no fit exists and flags a non-converged fit", () => {
    const short = render(
      <VolatilityPanel analytics={analyticsFor(series([1, 2, 3, 5]))} />
    );
    expect(short.textContent).toContain("GARCH: GARCH(1,1) needs at least 50");
    expect(
      short.querySelector('[data-stat="Ljung-Box p"]')?.textContent
    ).toContain("—");
    const base = analyticsFor(drifting);
    const garch = base.volatility.garch!;
    const loose = render(
      <VolatilityPanel
        analytics={{
          ...base,
          volatility: {
            ...base.volatility,
            garch: { ...garch, converged: false },
          },
        }}
      />
    );
    return expect(loose.textContent).toContain("did not converge");
  });
});

describe("PairsLensPanel", () => {
  const metrics = {
    "pair.legs": "EWA/EWC",
    "pair.hedge_ratio": 0.8123,
    "pair.adf_t": -3.9,
    "pair.adf_p": 0.012,
    "pair.crit_5pct": -3.35,
    "pair.half_life_bars": 14.2,
    "pair.entry_z": 2,
    "pair.exit_z": 0.5,
    "pair.stop_z": 4,
    "pair.cost_bps": 5,
    "pair.formation_bars": 1000,
    "pair.lookback": 60,
    "pair.round_trips": 12,
    sharpe: 1.1,
  };

  it("renders nothing without pair metrics", () =>
    expect(
      renderToStaticMarkup(<PairsLensPanel metrics={{ sharpe: 1 }} />)
    ).toBe(""));

  it("shows the cointegration diagnostics and the verdict", () => {
    const view = render(<PairsLensPanel metrics={metrics} />);
    expect(view.textContent).toContain("Pairs lens: EWA/EWC");
    expect(
      view.querySelector('[data-stat="Half-life"]')?.textContent
    ).toContain("14.2 bars");
    expect(
      view.querySelector('[data-stat="Entry / exit / stop z"]')?.textContent
    ).toContain("2 / 0.5 / 4");
    return expect(view.textContent).toContain("Cointegrated at the 5% level");
  });

  it("warns when the pair is not cointegrated or the p-value is missing", () => {
    const weak = render(
      <PairsLensPanel
        metrics={{
          ...metrics,
          "pair.adf_p": 0.4,
          "pair.half_life_bars": "n/a",
          "pair.legs": 3,
        }}
      />
    );
    expect(weak.textContent).toContain("Not cointegrated");
    expect(weak.textContent).toContain("no reversion");
    expect(weak.textContent).not.toContain("Pairs lens:");
    const missing = render(<PairsLensPanel metrics={{ "pair.legs": "A/B" }} />);
    return expect(missing.textContent).toContain(
      "No Engle-Granger p-value reported."
    );
  });
});
