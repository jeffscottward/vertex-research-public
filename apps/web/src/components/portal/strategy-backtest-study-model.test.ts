import {
  type QcPortStudy,
  QcPortStudySchema,
  type StrategyParamOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import fixture from "../../features/research-studies/fixtures/qc-port-study.json";
import {
  qcPortDefinitionRef,
  qcPortRunHref,
  toQcPortStudyViewModel,
} from "./strategy-backtest-study-model.ts";

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
    expect(model.criteria).toBe(
      "Sharpe above 0.50, deflated Sharpe above 0.90, max drawdown below 25.00%, Sharpe above the baseline run"
    );
    expect(model.provenance).toBe(
      "Code 0123456789ab · nautilus_trader 1.221.0 · data sha256 abababababab · run qc-ports-2026-11-08"
    );
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
      criteria: { ...STUDY.criteria, beatBaseline: false },
      equity: [],
      runs: [{ ...STUDY.runs[0]!, maxDrawdown: 0.25 }],
      verdict: "PASS",
    });
    expect(model.runs[0]?.maxDrawdown).toBe("-25.00%");
    expect(model.criteria).not.toContain("baseline");
    expect(model.gates).toEqual([]);
    expect(model.equity).toEqual([]);
    expect(model.equitySummary).toBe("No monthly equity stored.");
  });
});

// Fixed choice params of a qc-port row (migration 0059).
const choice = (name: string, value: string): StrategyParamOutput => ({
  default: value,
  name,
  options: [value],
  title: name,
  type: "choice",
});
const SHA = "b0742b461b978bd39aff8b32cd8062fcb21fe4ae2bdb60d8cff5cf425deeb3c8";
const PARAMS = [
  choice("definitionId", "qc-asset-class-trend"),
  choice("definitionSha256", SHA),
  choice("runFrom", "1993-10-29"),
  choice("initialCapital", "100000"),
];

describe("qc-port definition link", () => {
  it("reads the stored definition params and builds the Backtest runs link", () => {
    const ref = qcPortDefinitionRef(PARAMS);
    expect(ref).toEqual({
      definitionId: "qc-asset-class-trend",
      initialCapital: 100_000,
      runFrom: "1993-10-29",
      sha256: SHA,
    });
    expect(
      qcPortRunHref(
        ref as NonNullable<typeof ref>,
        "strategy-seed-qc-asset-class-trend"
      )
    ).toBe(
      `/backtest-runs?definition=qc-asset-class-trend&sha=${SHA}&strategy=strategy-seed-qc-asset-class-trend&timeframe=1d&from=1993-10-29&initialCapital=100000&costBps=0`
    );
  });

  it("needs the definition id and SHA-256; run start and capital are optional", () => {
    expect(qcPortDefinitionRef([])).toBeNull();
    expect(qcPortDefinitionRef(PARAMS.slice(0, 1))).toBeNull();
    expect(qcPortDefinitionRef(PARAMS.slice(1))).toBeNull();
    const bare = qcPortDefinitionRef([
      ...PARAMS.slice(0, 2),
      choice("initialCapital", "a lot"),
    ]);
    expect(bare).toEqual({
      definitionId: "qc-asset-class-trend",
      initialCapital: null,
      runFrom: null,
      sha256: SHA,
    });
    expect(qcPortRunHref(bare as NonNullable<typeof bare>, "s-1")).toBe(
      `/backtest-runs?definition=qc-asset-class-trend&sha=${SHA}&strategy=s-1&timeframe=1d&costBps=0`
    );
  });
});
