// @vitest-environment jsdom
import {
  AutopilotCampaignDetailSchema,
  AutopilotCandidateDetailSchema,
  BacktestComboSchema,
  BacktestRunListOutputSchema,
  BacktestRunReportSchema,
  BacktestSweepOutputSchema,
  ForwardDriftListOutputSchema,
  ForwardDriftMonitorSchema,
  InstantBacktestRunOutputSchema,
  InstantBacktestSeriesListOutputSchema,
  SetupReplayPresetsOutputSchema,
  SetupReplayRunOutputSchema,
} from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/charts/backtest-series.tsx", () => ({
  BacktestSeriesChart: () => <div data-chart="" />,
}));

import { mountLab, unmountLab } from "../test-support.tsx";
import {
  BACKTEST_LAB_LAB_ENTRIES,
  labAutopilotGateway,
  labBacktestRunsGateway,
  labBacktestSweepsGateway,
  labForwardDriftGateway,
  labInstantBacktestGateway,
  labPortfolioCombosGateway,
  labSetupReplayGateway,
} from "./backtest-lab.tsx";

afterEach(async () => {
  await unmountLab();
});

const EXPECTED: Readonly<Record<string, readonly [string, string]>> = {
  autopilot: ["Autopilot", "Demo ES=F daily breeding"],
  "backtest-runs": ["Backtest runs", "Initial deposit"],
  "backtest-sweeps": ["Parameter sweeps", "ES=F"],
  "forward-drift": ["Forward drift", "Paper drawdown is 1.7x"],
  "instant-backtest": ["Instant backtest", "ES=F"],
  "portfolio-combos": ["Portfolio combos", "Demo momentum v1"],
  "setup-replay": ["Setup replay", "Gap up and hold"],
  "strategy-builder": ["Strategy builder", "ES=F"],
};

describe("backtest lab entries", () => {
  it.each(BACKTEST_LAB_LAB_ENTRIES.map((entry) => [entry.id, entry] as const))(
    "renders %s with fake data",
    async (id, entry) => {
      const [title, value] = EXPECTED[id] ?? ["", ""];
      const host = await mountLab(entry.render(new URLSearchParams()));
      expect(host.querySelector("h1")?.textContent).toBe(title);
      expect(entry.title).toBe(title);
      expect(host.textContent).toContain(value);
    }
  );

  it("opens the run named by ?id= or ?run=", async () => {
    const entry = BACKTEST_LAB_LAB_ENTRIES.find(
      (candidate) => candidate.id === "backtest-runs"
    );
    const byId = await mountLab(
      entry?.render(new URLSearchParams("id=lab-run-gc"))
    );
    expect(byId.querySelector('[aria-current="true"]')?.textContent).toContain(
      "GC=F"
    );
    await unmountLab();
    const bad = await mountLab(entry?.render(new URLSearchParams("run=../x")));
    expect(bad.querySelector('[aria-current="true"]')?.textContent).toContain(
      "ES=F"
    );
  });

  it("serves schema-valid fixtures from every gateway", async () => {
    const series = await labInstantBacktestGateway.series();
    InstantBacktestSeriesListOutputSchema.parse(series);
    InstantBacktestRunOutputSchema.parse(
      await labInstantBacktestGateway.run({
        costBps: 2,
        rule: {
          entryLookback: 20,
          exitLookback: 10,
          kind: "breakout",
          trendSma: 200,
        },
        stopLossPct: 0,
        symbol: "NVDA",
        takeProfitPct: 0,
        timeframe: "1d",
      })
    );
    InstantBacktestRunOutputSchema.parse(
      await labInstantBacktestGateway.run({
        costBps: 2,
        rule: { fast: 50, kind: "smaCross", slow: 200 },
        stopLossPct: 0,
        symbol: "ZZZ",
        takeProfitPct: 0,
        timeframe: "1d",
      })
    );
    SetupReplayPresetsOutputSchema.parse(await labSetupReplayGateway.presets());
    SetupReplayRunOutputSchema.parse(
      await labSetupReplayGateway.run({
        maxHoldBars: 10,
        paths: 1000,
        seriesId: "SPY:1d",
        setup: "gapUpHold",
        stop: { kind: "atr", multiple: 1.5 },
        targetR: 2,
      })
    );
    expect((await labSetupReplayGateway.series()).series.length).toBe(
      series.series.length
    );
    const runs = await labBacktestRunsGateway.list();
    BacktestRunListOutputSchema.parse({ runs });
    const missing = await labBacktestRunsGateway.get("missing");
    BacktestRunReportSchema.parse(missing.report);
    expect(await labBacktestRunsGateway.strategies()).toHaveLength(2);
    await expect(
      labBacktestRunsGateway.submit({
        from: "2026-01-01",
        rule: { fast: 5, kind: "smaCross", slow: 20 },
        symbol: "SPY",
        timeframe: "1d",
        to: "2026-02-01",
      })
    ).rejects.toThrow("UI lab");
    const sweep = await labBacktestSweepsGateway.sweep({
      dimensions: [
        { from: 10, param: "fast", step: 10, to: 50 },
        { from: 100, param: "slow", step: 50, to: 300 },
      ],
      from: "2025-01-01",
      rule: { fast: 20, kind: "smaCross", slow: 200 },
      symbol: "ES=F",
      timeframe: "1d",
      to: "2026-01-01",
    });
    expect(BacktestSweepOutputSchema.parse(sweep).cells).toHaveLength(25);
    expect(sweep.metric).toBe("totalReturn");
    const sharpe = await labBacktestSweepsGateway.sweep({
      dimensions: [{ from: 10, param: "fast", step: 5, to: 20 }],
      from: "2025-01-01",
      metric: "sharpe",
      rule: { fast: 20, kind: "smaCross", slow: 200 },
      symbol: "ES=F",
      timeframe: "1d",
      to: "2026-01-01",
    });
    expect(sharpe.metric).toBe("sharpe");
    expect((await labBacktestSweepsGateway.series()).length).toBe(
      series.series.length
    );
    const combo = await labPortfolioCombosGateway.combine({
      deposit: 100_000,
      slots: runs.slice(0, 3).map((run) => ({ runId: run.id, weight: 0.3 })),
    });
    expect(BacktestComboSchema.parse(combo).slots).toHaveLength(3);
    expect((await labPortfolioCombosGateway.list()).length).toBe(runs.length);
    ForwardDriftListOutputSchema.parse(await labForwardDriftGateway.list());
    ForwardDriftMonitorSchema.parse(
      await labForwardDriftGateway.get("lab-monitor-es")
    );
    ForwardDriftMonitorSchema.parse(await labForwardDriftGateway.get("nope"));
    expect((await labForwardDriftGateway.runs()).length).toBe(runs.length);
    const campaigns = await labAutopilotGateway.list();
    AutopilotCampaignDetailSchema.parse(
      await labAutopilotGateway.get(campaigns[1]?.id ?? "")
    );
    AutopilotCampaignDetailSchema.parse(await labAutopilotGateway.get("nope"));
    AutopilotCandidateDetailSchema.parse(
      await labAutopilotGateway.candidate("lab-cand-3")
    );
    AutopilotCandidateDetailSchema.parse(
      await labAutopilotGateway.candidate("nope")
    );
    expect((await labAutopilotGateway.series()).length).toBe(
      series.series.length
    );
  });
});
