// Small hand-made Quant Lab artifacts for unit tests (shaped like services/research/quantlab output).
import type { QuantLabCapture, QuantLabSpec } from "./record-rows.ts";

export const captureFixture: QuantLabCapture = {
  abstract: "x".repeat(5000),
  authors: ["Valeriy Zakamulin"],
  captured_at: "2026-10-18T17:49:32Z",
  doi: "10.2139/ssrn.2242795",
  metadata_source: "crossref",
  pdf_bytes: null,
  pdf_sha256: null,
  pdf_source_url: null,
  pdf_status: "metadata_only:no_free_copy",
  posted: "2013",
  ssrn_id: "2242795",
  title: "The Real-Life Performance of Market Timing",
  topic: "moving average market timing",
  url: "https://doi.org/10.2139/ssrn.2242795",
  version: "crossref-deposited:2026-08-12T16:24:43Z",
  year: 2013,
};

export const specFixture: QuantLabSpec = {
  costs: { commission_bps: 0.5, half_spread_bps: 0.5, slippage_bps: 1 },
  hypothesis: "Holds SPY above its 10-month SMA.",
  id: "zakamulin-2013-sma-timing",
  name: "SMA timing",
  our_reading: { assumptions: [], gaps: [], interpretation: "i" },
  paper: { doi: captureFixture.doi, version: captureFixture.version },
  paper_claims: [{ locator: "abstract", quote: "highly overstated" }],
  signal: { lookback: 10, lookback_unit: "months", type: "price_above_sma" },
  spec_sha256:
    "7eb540a22b9260764eab7001653033ea63d27bbd0ffd25dd7a3a3b58f84a34c3",
  validation: { walk_forward: { lookback_grid: [2, 6, 12] } },
};

export const rawResultFixture = {
  benchmark: {
    label: "Buy and hold SPY",
    points: [
      { equity: 1, t: "2003-10-02" },
      { equity: 1.1, t: "2004-10-01" },
      { equity: 1.2, t: "2005-10-03" },
    ],
  },
  criteria: [
    {
      check: "walk_forward_sharpe_gt_benchmark",
      description: "d",
      passed: true,
    },
    { check: "oos_sharpe_gt_benchmark", description: "d", passed: false },
  ],
  dataSource: "frozen",
  equity: [
    { equity: 1, t: "2003-10-02" },
    { equity: 1.2, t: "2004-10-01" },
    { equity: 0.9, t: "2005-10-03" },
  ],
  folds: [
    {
      label: "WF1 lb=12",
      metrics: { sharpe: 0.9 },
      test_end: "2005-09-30",
      test_start: "2003-10-02",
      train_end: "2003-10-01",
      train_start: "1993-10-01",
    },
  ],
  instruments: "SPY",
  isSplit: {
    in_sample: {
      end: "2009-12-31",
      metrics: { sharpe: 0.64 },
      start: "1993-10-01",
    },
    out_of_sample: {
      end: "2026-10-16",
      metrics: { sharpe: 0.53 },
      start: "2010-01-04",
    },
  },
  metrics: {
    bh_max_drawdown: -0.55,
    bh_sharpe: 0.57,
    wf_cagr: 0.09,
    wf_max_drawdown: -0.24,
    wf_sharpe: 0.63,
  },
  periodEnd: "2026-10-16",
  periodStart: "2003-10-02",
  runConfig: {
    engine: "nautilus-trader-1.227.0",
    fillModel: "bar",
    initialCapital: 1,
    timeframe: "1d",
  },
  specId: specFixture.id,
  specSha256: specFixture.spec_sha256,
  strategy: "SMA timing (walk-forward)",
  trades: [
    {
      commission: 0.0004,
      entry_px: 100,
      entry_t: "2003-10-02",
      exit_px: 90,
      exit_t: "2005-10-03",
      pnl: -0.1,
      qty: 1,
      side: "long",
      symbol: "SPY",
    },
  ],
  verdict: "inconclusive",
};
