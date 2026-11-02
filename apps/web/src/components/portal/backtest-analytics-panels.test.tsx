// @vitest-environment jsdom
import type { BacktestGetOutput } from "@darkfactory/api";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
// Test-only relative import: the rating replay runs server-side and stays out of the browser bundle.
import { evaluateAgentRatings } from "../../../../../packages/api/src/agent-rating-placebo.ts";

import {
  BACKTEST_TABS,
  backtestTabsFor,
  ordinal,
  PlaceboPanel,
} from "./backtest-analytics-panels.tsx";

type RatingEvaluation = NonNullable<
  BacktestGetOutput["backtest"]["ratingEvaluation"]
>;
type Ready = Extract<RatingEvaluation, { status: "ready" }>;

const render = (element: ReactElement): HTMLElement => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(element);
  return container;
};

const DAY = 86_400_000;
const START = Date.UTC(2024, 0, 1);
const dateAt = (index: number) =>
  new Date(START + index * DAY).toISOString().slice(0, 10);

// 40 daily bars with a gentle wave; four decisions, one of them a failed run.
const readyEvaluation = (): Ready => {
  const close = Array.from(
    { length: 40 },
    (_, index) => 100 + 5 * Math.sin(index / 4) + index / 10
  );
  const evaluation = evaluateAgentRatings({
    bars: {
      t: Float64Array.from(close, (_, index) => START + index * DAY),
      o: Float64Array.from(close),
      c: Float64Array.from(close),
    },
    series: {
      symbol: "SPY",
      timeframe: "1d",
      costBps: 10,
      decisions: [
        { date: dateAt(0), rating: "buy" },
        { date: dateAt(8), rating: "hold" },
        { date: dateAt(16), rating: null },
        { date: dateAt(24), rating: "sell" },
      ],
    },
    seedKey: "bt-panel",
  });
  if (evaluation.status !== "ready") throw new Error("expected ready");
  return evaluation;
};

const chart = vi.fn((points: readonly { t: string; value: number }[]) => (
  <figure data-chart-points={points.length} />
));

describe("placebo panel", () => {
  it("formats ordinals", () => {
    expect(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 50.4, 99.6, 100, 111].map(ordinal)
    ).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "50th",
      "100th",
      "100th",
      "111th",
    ]);
  });

  it("shows the Placebo tab only for a result with a rating series", () => {
    expect(backtestTabsFor(null)).not.toContain("placebo");
    expect(
      backtestTabsFor({ status: "unavailable", reason: "no_bars" })
    ).toEqual(BACKTEST_TABS);
    expect(
      render(<PlaceboPanel equityChart={chart} evaluation={null} />).innerHTML
    ).toBe("");
  });

  it("explains each unavailable reason with the research-only notice", () => {
    const messages = {
      no_bars: "No stored daily bars for this symbol",
      outside_history: "outside the stored price history",
      too_few_decisions: "at least two decisions",
      storage_error: "could not be read",
      bad_bars: "zero, negative or missing price",
      evaluation_error: "The stored result is unchanged.",
    } as const;
    for (const [reason, message] of Object.entries(messages)) {
      const container = render(
        <PlaceboPanel
          equityChart={chart}
          evaluation={{
            status: "unavailable",
            reason: reason as keyof typeof messages,
          }}
        />
      );
      expect(
        container.querySelector(`[data-placebo="${reason}"]`)?.textContent
      ).toContain(message);
      expect(
        container.querySelector("[data-research-notice]")?.textContent
      ).toBe("Research only. Agent ratings never place orders.");
    }
    expect(chart).not.toHaveBeenCalled();
  });

  it("shows the replay, baselines, placebo band and rating stats", () => {
    const evaluation = readyEvaluation();
    const container = render(
      <PlaceboPanel equityChart={chart} evaluation={evaluation} />
    );
    expect(container.querySelector("[data-research-notice]")?.textContent).toBe(
      "Research only. Agent ratings never place orders."
    );
    const summary = container.querySelector("[data-placebo-summary]");
    expect(summary?.textContent).toMatch(
      /^Agents finished at the \d+(st|nd|rd|th) percentile of 24 shuffled-rating placebos \(5th-95th band -?\d+\.\d% to -?\d+\.\d%\)\.$/
    );
    expect(
      summary?.querySelector('[role="img"]')?.getAttribute("aria-label")
    ).toContain("Every distinct ordering");
    expect(
      [...container.querySelectorAll("[data-placebo-strategies] tbody tr")].map(
        (row) => row.getAttribute("data-strategy")
      )
    ).toEqual(["agents_rating", "buy_hold", "placebo_median"]);
    expect(
      container.querySelector('[data-strategy="agents_rating"]')?.textContent
    ).toContain("Agents rating only");
    expect(
      container.querySelector('[data-strategy="placebo_median"]')?.textContent
    ).toContain("—");
    const bandRows = container.querySelectorAll("[data-placebo-band] tbody tr");
    expect(bandRows.length).toBeGreaterThan(0);
    expect(bandRows.length).toBeLessThanOrEqual(5);
    expect([...bandRows].at(-1)?.textContent).toContain(dateAt(39));
    expect(
      [...container.querySelectorAll("[data-rating]")].map((row) =>
        row.getAttribute("data-rating")
      )
    ).toEqual(["buy", "hold", "sell"]);
    expect(
      container.querySelector('[data-rating="hold"]')?.textContent
    ).toContain("—");
    expect(
      container.querySelector("[data-failed-decisions]")?.textContent
    ).toContain("Failed or unrated runs: 1.");
    expect(chart).toHaveBeenLastCalledWith(
      evaluation.strategies[0]?.equity.map((point) => ({
        t: point.t,
        value: point.equity,
      }))
    );
    expect(container.querySelector("[data-chart-points]")).not.toBeNull();
  });

  it("names the seed of drawn placebos and tolerates a missing agents row", () => {
    const evaluation = readyEvaluation();
    const container = render(
      <PlaceboPanel
        equityChart={chart}
        evaluation={{
          ...evaluation,
          strategies: [],
          placebo: { ...evaluation.placebo, exhaustive: false, seed: 42 },
        }}
      />
    );
    expect(
      container
        .querySelector("[data-placebo-summary] [role='img']")
        ?.getAttribute("aria-label")
    ).toContain("seed 42");
    expect(
      container.querySelectorAll("[data-placebo-band] tbody tr")
    ).toHaveLength(0);
    expect(chart).toHaveBeenLastCalledWith([]);
  });
});
