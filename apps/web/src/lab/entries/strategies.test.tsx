// @vitest-environment jsdom
import {
  AcademyGateOutputSchema,
  AcademyTickersOutputSchema,
  BacktestGetOutputSchema,
  BacktestListOutputSchema,
  OptimizationGetOutputSchema,
  OptimizationListOutputSchema,
  QuantLabListOutputSchema,
  StrategyGetOutputSchema,
  StrategyListOutputSchema,
} from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";
// Test-only deep import (as in backtests-workspace.test.tsx): checks the precomputed JSON.
import { computeBacktestAnalytics } from "../../../../../packages/api/src/backtest-analytics.ts";

vi.mock("../../features/charts/backtest-series.tsx", () => ({
  BacktestSeriesChart: () => <div data-chart="" />,
}));

import {
  LAB_ACADEMY_TICKERS,
  LAB_BACKTEST_ROWS,
  LAB_OPTIMIZATION_ROWS,
  LAB_QUANT_LAB,
  LAB_STRATEGY_ROWS,
  labAcademyGate,
  labBacktestAnalyticsInput,
  labBacktestDetail,
  labOptimizationDetail,
  labStrategyDetail,
} from "../fixtures/strategies.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import {
  labAcademyGateway,
  labAcademyMediaFor,
  STRATEGIES_LAB_ENTRIES,
} from "./strategies.tsx";

afterEach(async () => {
  await unmountLab();
  window.history.replaceState(null, "", "/");
});

const entry = (id: string) => {
  const found = STRATEGIES_LAB_ENTRIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing lab entry ${id}`);
  return found;
};

const mountEntry = async (id: string, query = "") => {
  window.history.replaceState(
    null,
    "",
    `/lab/${id}${query === "" ? "" : `?${query}`}`
  );
  return mountLab(entry(id).render(new URLSearchParams(query)));
};

describe("strategies lab fixtures", () => {
  it("match the API output schemas", () => {
    StrategyListOutputSchema.parse({ strategies: LAB_STRATEGY_ROWS });
    for (const row of LAB_STRATEGY_ROWS)
      StrategyGetOutputSchema.parse(labStrategyDetail(row.id));
    // One fixture is high priority with an external claim; the others carry neither.
    expect(
      LAB_STRATEGY_ROWS.filter(
        (row) => row.priority === "high" && row.externalValidation !== null
      ).map((row) => [row.id, row.tags.includes("research-only")])
    ).toEqual([["s-demo-volume-spike", true]]);
    expect(
      LAB_STRATEGY_ROWS.filter(
        (row) => row.priority === "normal" && row.externalValidation === null
      )
    ).toHaveLength(LAB_STRATEGY_ROWS.length - 1);
    BacktestListOutputSchema.parse({ backtests: LAB_BACKTEST_ROWS });
    for (const row of LAB_BACKTEST_ROWS)
      BacktestGetOutputSchema.parse(labBacktestDetail(row.id));
    OptimizationListOutputSchema.parse({
      optimizations: LAB_OPTIMIZATION_ROWS,
    });
    for (const row of LAB_OPTIMIZATION_ROWS)
      OptimizationGetOutputSchema.parse(labOptimizationDetail(row.id));
    QuantLabListOutputSchema.parse(LAB_QUANT_LAB);
    AcademyTickersOutputSchema.parse(LAB_ACADEMY_TICKERS);
    AcademyGateOutputSchema.parse(
      labAcademyGate({
        allocationPct: 5,
        riskPerTradePct: 1,
        slug: "demo",
        ticker: "SPY",
        tranches: 1,
      })
    );
  });

  it("ship backtest analytics equal to the live computation", () => {
    for (const row of LAB_BACKTEST_ROWS)
      expect(
        labBacktestDetail(row.id).backtest.analytics,
        `${row.id}: regenerate apps/web/src/lab/fixtures/backtest-analytics.json as {id: computeBacktestAnalytics(labBacktestAnalyticsInput(id))} for every LAB_BACKTEST_ROWS id`
      ).toEqual(computeBacktestAnalytics(labBacktestAnalyticsInput(row.id)));
  });

  it("fall back to the first record for unknown ids", () => {
    expect(labStrategyDetail("nope").strategy.name).toBe("Demo momentum v1");
    expect(labBacktestDetail("nope").backtest.strategy).toBe(
      "Demo momentum v1"
    );
    expect(labOptimizationDetail("nope").optimization.strategyName).toBe(
      "Demo momentum v1"
    );
    expect(labAcademyMediaFor("no-such-lesson")).toBeNull();
  });

  it("keeps Academy writes read-only", async () => {
    expect((await labAcademyGateway.tickers()).tickers[0]?.ticker).toBe("SPY");
    const gate = await labAcademyGateway.deployPreview({
      allocationPct: 5,
      riskPerTradePct: 1,
      slug: "demo",
      ticker: "NVDA",
      tranches: 1,
    });
    expect(gate.nlvDetail).toContain("Demo Capital");
  });
});

describe("strategies lab entries", () => {
  it("renders the strategy library list and a ?id= detail", async () => {
    const list = await mountEntry("library");
    expect(list.querySelector("h1")?.textContent).toBe("Strategy library");
    expect(list.textContent).toContain("Demo momentum v1");
    await unmountLab();
    const detail = await mountEntry("library", "id=s-demo-reversion");
    expect(detail.textContent).toContain(
      "Demo mean reversion v2: fictional lab strategy"
    );
  });

  it("renders the Academy gallery and a lesson from ?slug=", async () => {
    const gallery = await mountEntry("academy");
    expect(gallery.querySelector("h1")?.textContent).toContain("Academy");
    await unmountLab();
    const course = await mountEntry("academy-course");
    expect(course.querySelector('[data-academy-gallery="dyr"]')).not.toBeNull();
    await unmountLab();
    const lesson = await mountEntry("academy-lesson");
    expect(lesson.querySelector("h1")?.textContent).not.toBe("");
    await unmountLab();
    const chosen = await mountEntry(
      "academy-lesson",
      "slug=itm-covered-call-otm-put"
    );
    expect(chosen.textContent).toContain("ITM covered call");
  });

  it("renders Strategy reviews with the first scope preselected", async () => {
    const host = await mountEntry("strategies");
    expect(host.querySelector("h1")?.textContent).toBe("Strategy reviews");
    expect(host.textContent).toContain("demo-momentum");
  });

  it("renders backtests, Quant Lab and a ?id= detail", async () => {
    const host = await mountEntry("backtests", "id=bt-demo-breakout");
    expect(host.querySelector("h1")?.textContent).toBe("Backtests");
    expect(host.textContent).toContain("Demo gold carry v1");
    expect(host.textContent).toContain("Demo time-series momentum study");
    expect(
      host.querySelector('[data-backtest-detail="bt-demo-breakout"]')
    ).not.toBeNull();
  });

  it("renders optimizations with a ?id= detail", async () => {
    const host = await mountEntry("optimizations", "id=opt-demo-reversion");
    expect(host.querySelector("h1")?.textContent).toBe("Optimizations");
    expect(host.textContent).toContain("Demo mean reversion v2");
  });
});
