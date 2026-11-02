//! Private kernel DTOs, not a second implementation of Vertex public schemas.
//! The caller constructs journal observations only from its fenced local owner.
use crate::{calendar::{CivilDate, ExchangeCalendar, Ns}, decimal::Decimal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum Sleeve { Wheel, Fundamental, Swing, Macro, Quant }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum Side { Buy, Sell }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum AssetKind { Equity, Option }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum OptionRight { Call, Put }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum ExerciseStyle { American, European }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum SettlementKind { Cash, Physical }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionTerms {
    pub right: OptionRight, pub strike: Decimal, pub expiry_date: CivilDate,
    pub expiry_minute: u16, pub expiry_ns: Ns, pub exercise_style: ExerciseStyle,
    pub settlement: SettlementKind, pub settlement_policy_id: String,
    pub settlement_at_ns: Ns, pub exercise_fee_per_contract: Decimal,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualifiedInstrument {
    pub instrument_id: String, pub qualification_id: String, pub metadata_version: String,
    pub corporate_action_version: String, pub exchange: String, pub currency: String,
    pub underlying_id: String, pub kind: AssetKind, pub multiplier: Decimal,
    pub tick_size: Decimal, pub quantity_step: Decimal, pub calendar_id: String,
    pub valid_from_ns: Ns, pub valid_until_ns: Ns, pub option: Option<OptionTerms>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entitlement {
    pub policy_id: String, pub granted: bool, pub checked_at_ns: Ns,
    pub expires_at_ns: Ns, pub provider: String, pub instrument_id: String,
    pub usage: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketQuote {
    pub quote_id: String, pub instrument_id: String, pub provider: String,
    pub currency: String,
    pub snapshot_id: String, pub data_vintage_id: String, pub source_hash: String,
    pub source_at_ns: Ns, pub received_at_ns: Ns, pub executable: bool,
    pub data_kind: String, pub bid: Decimal, pub ask: Decimal,
    pub bid_size: Decimal, pub ask_size: Decimal, pub entitlement: Entitlement,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Greeks {
    pub delta: Decimal, pub gamma: Decimal, pub vega: Decimal,
    pub theta: Decimal, pub rho: Decimal,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GreekObservation {
    pub values: Greeks, pub instrument_id: String, pub provider: String,
    pub model_id: String, pub model_version: String, pub source_hash: String,
    pub quote_id: String, pub underlying_quote_id: String, pub data_vintage_id: String,
    pub observed_at_ns: Ns, pub received_at_ns: Ns,
    /// Exactly this unit, not per-contract numbers accidentally multiplied twice.
    pub unit: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Leg {
    pub intent_hash: String, pub instrument: QualifiedInstrument,
    pub calendar: ExchangeCalendar, pub side: Side, pub quantity: Decimal,
    pub limit_price: Decimal, pub quote: MarketQuote,
    pub underlying_quote: MarketQuote, pub greeks: GreekObservation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactBinding { pub id: String, pub sha256: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CostPolicy {
    pub model_id: String, pub fee_per_unit: Decimal, pub fee_per_leg: Decimal,
    pub slippage_bps: Decimal, pub currency_quantum: Decimal,
    pub latency_model_id: String, pub submission_latency_ns: Ns,
    pub maximum_receive_delay_ns: Ns,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub gross_notional: Decimal, pub maximum_loss: Decimal, pub reserved_cash: Decimal,
    pub absolute_greeks: Greeks, pub per_instrument_notional: Decimal,
    pub per_expiry_notional: Decimal, pub maximum_positions: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ZeroDteGate {
    pub policy_id: String, pub strategy_artifact_id: String, pub review_artifact_id: String,
    pub intraday_dataset_id: String, pub replay_report_id: String,
    pub expiry_scenarios_report_id: String, pub rapid_exit_report_id: String,
    pub partial_leg_report_id: String, pub valid_until_ns: Ns,
    /// References must be resolved/approved by the owner, not accepted from a model.
    pub owner_review_verified: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub policy_id: String, pub version: String, pub account_alias: String,
    pub environment: String, pub currency: String, pub valid_from_ns: Ns,
    pub valid_until_ns: Ns, pub strategy_artifact: ArtifactBinding,
    pub approved_instruments: Vec<ArtifactBinding>, pub approved_calendars: Vec<ArtifactBinding>,
    pub approved_entitlement_policy_ids: Vec<String>, pub approved_greek_model_ids: Vec<String>,
    pub quote_max_age_ns: Ns, pub greek_max_age_ns: Ns, pub journal_max_age_ns: Ns,
    pub entitlement_max_age_ns: Ns, pub maximum_spread_bps: Decimal,
    pub minimum_displayed_quantity: Decimal, pub maximum_participation_bps: Decimal,
    pub costs: CostPolicy, pub portfolio_limits: Limits,
    pub sleeve_limits: BTreeMap<Sleeve, Limits>, pub zero_dte: Option<ZeroDteGate>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GreekRange { pub low: Greeks, pub high: Greeks }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedPosition {
    pub position_id: String, pub sleeve: Sleeve, pub instrument_id: String,
    pub kind: AssetKind, pub underlying_id: String, pub expiry_date: Option<CivilDate>,
    pub quantity: Decimal, pub unit_notional: Decimal, pub unit_greeks: Greeks,
    pub valuation_at_ns: Ns, pub greek_observed_at_ns: Ns, pub source_hash: String,
    pub greek_model_id: String, pub greek_unit: String, pub data_vintage_id: String,
    pub cash_encumbered: Decimal, pub maximum_loss: Decimal,
    pub settled_quantity: Decimal,
    pub covered_shares_encumbered: BTreeMap<String, Decimal>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reservation {
    pub reservation_id: String, pub sleeve: Sleeve, pub cash: Decimal,
    pub strategy_artifact_id: String, pub proposal_hashes: Vec<String>,
    pub maximum_loss: Decimal, pub gross_notional: Decimal,
    pub covered_shares: BTreeMap<String, Decimal>, pub greeks: GreekRange,
    pub instrument_notionals: BTreeMap<String, Decimal>,
    pub expiry_notionals: BTreeMap<String, Decimal>, pub position_slots: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedJournal {
    pub source: String, pub journal_id: String, pub revision: Ns, pub owner_epoch: Ns,
    pub head_hash: String, pub account_alias: String, pub environment: String,
    pub currency: String, pub observed_at_ns: Ns, pub reconciled_at_ns: Ns,
    pub durable: bool, pub continuity_complete: bool, pub fully_reconciled: bool,
    pub unknown_acceptance: bool, pub kill_new_risk: bool,
    /// Settled balance only. Unsettled sale credits and virtual sleeves are excluded.
    pub settled_cash: Decimal, pub positions: Vec<ObservedPosition>,
    pub reservations: Vec<Reservation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KernelRequest {
    pub request_version: String, pub operation: String, pub mode: String,
    pub request_id: String, pub now_ns: Ns, pub account_alias: String,
    pub strategy_artifact_id: String, pub strategy: Value, pub intents: Vec<Value>,
    pub policy: Policy, pub journal: ObservedJournal, pub legs: Vec<Leg>,
    pub dispatch_reservation_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegPlan {
    pub instrument_id: String, pub intent_hash: String, pub quantity: Decimal,
    pub limit_price: Decimal, pub cash_reservation: Decimal, pub cost_reservation: Decimal,
    pub settlement_cash: Decimal, pub settlement_at_ns: Option<Ns>,
    pub maximum_loss: Decimal, pub gross_notional: Decimal,
    pub covered_shares: BTreeMap<String, Decimal>, pub expiry_ns: Option<Ns>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionPlan {
    pub request_id: String, pub account_alias: String, pub mode: String,
    pub strategy_artifact_id: String, pub strategy_hash: String,
    pub policy_id: String, pub policy_hash: String, pub cost_model_id: String,
    pub latency_model_id: String, pub journal_id: String, pub journal_revision: Ns,
    pub journal_head_hash: String, pub owner_epoch: Ns, pub evaluated_at_ns: Ns,
    pub expires_at_ns: Ns, pub reservation: Reservation, pub legs: Vec<LegPlan>,
    pub live_authorization: bool, pub broker_submission_allowed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KernelResponse {
    pub request_version: String, pub status: String, pub plan: Option<AdmissionPlan>,
    pub reasons: Vec<String>, pub live_authorization: bool, pub broker_submission_allowed: bool,
}
