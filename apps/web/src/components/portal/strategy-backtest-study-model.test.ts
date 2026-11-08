import { type QcPortStudy, QcPortStudySchema } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import fixture from "../../features/research-studies/fixtures/qc-port-study.json";
import { toQcPortStudyViewModel } from "./strategy-backtest-study-model.ts";

const STUDY: QcPortStudy = QcPortStudySchema.parse(fixture);

describe("toQcPortStudyViewModel", () => {
  it("maps runs, gates and the equity curve of the stored fixture", () => {
    const model = toQcPortStudyViewModel(STUDY);
    expect(model).toMatchObject({
      notes: STUDY.notes,
      ran: "2026-11-08",
      spec: "docs/specs/strategies/qc-iv-rank-gate.md",
      title: "IV-Rank Gate for Credit Spreads",
      verdict: "FAIL",
    });
    expect(model.runs[0]).toEqual({
      cagr: "3.10%",
      deflatedSharpe: "0.41",
      exposure: "44.00%",
      key: "0:SPY put credit vertical, ungated",
      maxDrawdown: "-14.20%",
      name: "SPY put credit vertical, ungated",
      sharpe: "0.48",
      skipped: "3",
      symbols: "SPY",
      trades: "96",
      winRate: "69.00%",
      worstMonth: "2024-05 -5.10%",
    });
    // A run with no trades has no statistics, and a zero drawdown never shows as -0.00%.
    expect(model.runs[2]).toMatchObject({
      cagr: "—",
      deflatedSharpe: "—",
      maxDrawdown: "0.00%",
      sharpe: "—",
      symbols: "SPY, QQQ, DIA, IWM, GLD, SLV, USO",
      winRate: "—",
      worstMonth: "—",
    });
    expect(model.gates).toEqual([
      {
        gate: "IV rank >= 50",
        host: "qc-regime-put-vrp",
        key: "IV rank >= 50:qc-regime-put-vrp",
        maxDrawdown: "-14.20% → -9.80%",
        sharpe: "0.48 → 0.52",
        trades: "96 → 41",
      },
    ]);
    expect(model.equity).toHaveLength(STUDY.equity.length);
    expect(model.equity[0]).toEqual({ time: "2024-01", value: 0 });
    const last = STUDY.equity.at(-1)!;
    expect(model.equity.at(-1)?.value).toBeCloseTo(
      last.v / STUDY.equity[0]!.v - 1,
      12
    );
    expect(model.equitySummary).toMatch(
      /^Monthly equity 2024-01 to 2025-12: \d+\.\d{2}% since the first month\.$/u
    );
  });

  it("shows a positive stored drawdown as a loss and handles no gates or equity", () => {
    const { gates: _gates, ...rest } = STUDY;
    const model = toQcPortStudyViewModel({
      ...rest,
      equity: [],
      runs: [{ ...STUDY.runs[0]!, maxDrawdown: 0.25 }],
      verdict: "PASS",
    });
    expect(model.runs[0]?.maxDrawdown).toBe("-25.00%");
    expect(model.gates).toEqual([]);
    expect(model.equity).toEqual([]);
    expect(model.equitySummary).toBe("No monthly equity stored.");
  });
});
