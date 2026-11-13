// The allocation plan "Funded lower-bar pie" as a seed document for golive_plans
// (scripts/golive/seed-plan.ts validates it with GoLivePlanSeedSchema and writes it).
//
// Sources, value by value:
// - research/backtests/allocation/funded_pie.py: POOL (run key and budget of each sleeve),
//   POSITION_RISK_PCT, OPEN_RISK_CAP_PCT, NAME_RISK_CAP_PCT, and sleeve_definitions (the changed
//   entry rule of the long index sleeve and `top` 1 of the rotation sleeve).
// - services/research/strategies/qc_ports/ideas.py: MONTHLY_CALL and PUT_CREDIT (structure, DTE,
//   anchor delta, width), OIL_ALWAYS (SPY, QQQ), MOMENTUM_TOP2 (CORE7) and SPY_PUT (SPY).
// - maxPositions is NOT in funded_pie.py (its Caps has no position count). 4 follows from the two
//   limits it does set: 4% open risk at 1% per position.
//
// The document is a proposal: the approval fields are null. The seed script sets them from its
// arguments when the owner approves. RECORDS ONLY: a plan row places no order.
import type { GoLivePlanSeed } from "../../../packages/api/src/contracts/golive-drafts.ts";

export const FUNDED_LOWER_BAR_PIE: GoLivePlanSeed = {
  approvalBasis: null,
  approvedBy: null,
  evidenceUrl: null,
  id: "funded-lower-bar-pie",
  limits: {
    maxPositions: 4,
    nameRiskCapPct: 2,
    openRiskCapPct: 4,
    positionRiskPct: 1,
  },
  name: "Funded lower-bar pie",
  ownerMessageUrl: null,
  sleeves: [
    {
      anchorDelta: 0.5,
      budgetPct: 2,
      definitionNote:
        "The definition of oil-predicts-equity/B with an entry rule that is always true: a monthly SPY and QQQ call debit vertical is always held.",
      definitionVariant: "always_on_entry",
      dteMin: 45,
      dteTarget: 60,
      key: "long-index",
      name: "Long index",
      runKey: "oil-predicts-equity/B",
      structure: "callDebitVertical",
      symbols: ["SPY", "QQQ"],
      widthSigma: 1,
    },
    {
      anchorDelta: 0.5,
      budgetPct: 1,
      definitionNote:
        "The definition of momentum-rotation/A holding the top 1 name instead of the top 2: the ETF with the best 12-1 momentum above 0.",
      definitionVariant: "top_1",
      dteMin: 45,
      dteTarget: 60,
      key: "rotation",
      name: "Momentum rotation",
      runKey: "momentum-rotation/A",
      structure: "callDebitVertical",
      symbols: ["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"],
      widthSigma: 1,
    },
    {
      anchorDelta: 0.25,
      budgetPct: 1,
      definitionNote:
        "The definition of regime-put-vrp/A unchanged: SPY put credit verticals, entered only when the volatility-regime gate allows.",
      definitionVariant: "as_studied",
      dteMin: 30,
      dteTarget: 45,
      key: "vol-premium",
      name: "Put credit, gated",
      runKey: "regime-put-vrp/A",
      structure: "putCreditVertical",
      symbols: ["SPY"],
      widthSigma: 0.5,
    },
  ],
  status: "proposed",
};
