//! Pure deterministic paper-only admission planning. This crate cannot reserve,
//! submit, connect, read clocks, load files, or grant live trading permissions.
//! The sole journal owner must authenticate inputs and atomically CAS the returned
//! journal revision/head/epoch and reserve the plan before simulator dispatch.
#![forbid(unsafe_code)]
pub mod calendar;
pub mod decimal;
pub mod model;
pub mod risk;
mod authority;
mod qualification;

use model::*;
use qualification::identifier;
use std::{collections::BTreeSet, fmt};
use vertex_contracts::ContractAuthority;

pub const REQUEST_VERSION: &str = "vertex.execution-kernel.v1";
pub type Result<T, E = KernelError> = std::result::Result<T, E>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KernelError {
    InvalidDecimal, Overflow, Precision, Encoding, Contract, InvalidRequest,
    MissingPolicy, ArtifactBinding, ProposalBinding, CalendarProof, SessionClosed,
    InstrumentMetadata, Expired, StaleObservation, InvalidObservation, QuoteQuality,
    Liquidity, Entitlement, GreekProvenance, ZeroDteGate, JournalNotReady, CashLimit,
    CoveredShares, GreekLimit, ExposureLimit, UndefinedRisk, DispatchBinding,
}
impl KernelError {
    pub fn code(self)->&'static str {
        match self {
            Self::InvalidDecimal=>"invalid-decimal",Self::Overflow=>"arithmetic-overflow",Self::Precision=>"inexact-arithmetic",
            Self::Encoding=>"encoding-failed",Self::Contract=>"public-contract-invalid",Self::InvalidRequest=>"invalid-kernel-request",
            Self::MissingPolicy=>"missing-or-invalid-policy",Self::ArtifactBinding=>"immutable-artifact-mismatch",Self::ProposalBinding=>"proposal-binding-mismatch",
            Self::CalendarProof=>"calendar-proof-missing",Self::SessionClosed=>"session-closed-or-cutoff",Self::InstrumentMetadata=>"unqualified-instrument",
            Self::Expired=>"expired",Self::StaleObservation=>"stale-or-future-observation",Self::InvalidObservation=>"invalid-observation",
            Self::QuoteQuality=>"quote-quality",Self::Liquidity=>"liquidity-limit",Self::Entitlement=>"entitlement-denied-or-expired",
            Self::GreekProvenance=>"greek-provenance",Self::ZeroDteGate=>"zero-dte-review-gate",Self::JournalNotReady=>"local-journal-not-ready",
            Self::CashLimit=>"cash-limit",Self::CoveredShares=>"covered-shares-unavailable",Self::GreekLimit=>"greek-limit",
            Self::ExposureLimit=>"exposure-limit",Self::UndefinedRisk=>"undefined-settlement-risk",Self::DispatchBinding=>"dispatch-reservation-mismatch",
        }
    }
}
impl fmt::Display for KernelError { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.write_str(self.code())} }
impl std::error::Error for KernelError {}

/// Public Value members are validated only by the frozen native authority. The
/// private request is meaningful only when issued by the authenticated owner;
/// its policy/observed-journal metadata is not a bearer authorization token.
pub fn evaluate(authority:&ContractAuthority, request:&KernelRequest)->Result<AdmissionPlan> {
    if request.request_version!=REQUEST_VERSION || request.operation!="evaluate" || request.mode!="PAPER-SIMULATION" ||
        !identifier(&request.request_id) || !identifier(&request.account_alias) || !identifier(&request.strategy_artifact_id) ||
        request.now_ns.0<0 || request.account_alias!=request.policy.account_alias {return Err(KernelError::InvalidRequest);}
    risk::check_policy(&request.policy,request.now_ns)?;
    let binding=authority::bind_proposals(authority,request)?;
    let (journal,reservation_id)=journal_for_dispatch(request,binding.sleeve)?;
    let mut portfolio=risk::Portfolio::observe(&journal,&request.policy,request.now_ns)?;
    let mut reservation=risk::empty_reservation(reservation_id,binding.sleeve);
    reservation.strategy_artifact_id=request.strategy_artifact_id.clone();
    reservation.proposal_hashes=request.legs.iter().map(|l|l.intent_hash.clone()).collect();
    let mut plans=Vec::new();let mut expiry=binding.expires;
    for (index,leg) in request.legs.iter().enumerate() {
        let qualified=qualification::qualify(authority,leg,request)?;
        expiry=expiry.min(qualified.expires);
        let (plan,loss)=risk::reserve_leg(leg,&request.policy,&mut reservation)?;
        if loss>binding.intent_loss_budgets[index] {return Err(KernelError::ExposureLimit);}
        plans.push(plan);
    }
    if reservation.maximum_loss>binding.maximum_loss || reservation.gross_notional>binding.maximum_notional || reservation.position_slots>binding.maximum_positions {
        return Err(KernelError::ExposureLimit);
    }
    expiry=expiry.min(journal.observed_at_ns.checked_add(request.policy.journal_max_age_ns)?)
        .min(journal.reconciled_at_ns.checked_add(request.policy.journal_max_age_ns)?);
    if request.now_ns.checked_add(request.policy.costs.submission_latency_ns)?>=expiry {return Err(KernelError::Expired);}
    portfolio.admit(&reservation,&request.policy)?;
    Ok(AdmissionPlan {request_id:request.request_id.clone(),account_alias:request.account_alias.clone(),mode:"PAPER-SIMULATION".into(),
        strategy_artifact_id:request.strategy_artifact_id.clone(),strategy_hash:binding.strategy_hash,policy_id:request.policy.policy_id.clone(),
        policy_hash:authority::hash(authority,&request.policy)?,cost_model_id:request.policy.costs.model_id.clone(),latency_model_id:request.policy.costs.latency_model_id.clone(),
        journal_id:journal.journal_id,journal_revision:journal.revision,journal_head_hash:journal.head_hash,owner_epoch:journal.owner_epoch,
        evaluated_at_ns:request.now_ns,expires_at_ns:expiry,reservation,legs:plans,live_authorization:false,broker_submission_allowed:false})
}

/// Bounded canonical JSON adapter. No subprocess, runtime, pyo3, disk or network.
/// Noncanonical input (including duplicate JSON keys) fails before interpretation.
/// Ordinary rejection is a negative envelope; encoding failure returns Err.
pub fn evaluate_json(authority:&ContractAuthority,input:&[u8])->Result<Vec<u8>> {
    let result=(|| {
        if input.len()>4*1024*1024 {return Err(KernelError::InvalidRequest);}
        let raw:serde_json::Value=serde_json::from_slice(input).map_err(|_|KernelError::InvalidRequest)?;
        if authority.encode(&raw).map_err(|_|KernelError::Contract)?!=input {return Err(KernelError::InvalidRequest);}
        let request:KernelRequest=serde_json::from_value(raw).map_err(|_|KernelError::InvalidRequest)?;
        evaluate(authority,&request)
    })();
    let (status,plan,reasons)=match result {
        Ok(plan)=>("admitted",Some(plan),vec!["paper-reservation-plan-only".into()]),
        Err(error)=>("rejected",None,vec![error.code().into()]),
    };
    let response=KernelResponse {request_version:REQUEST_VERSION.into(),status:status.into(),plan,reasons,live_authorization:false,broker_submission_allowed:false};
    authority.encode(&serde_json::to_value(response).map_err(|_|KernelError::Encoding)?).map_err(|_|KernelError::Encoding)
}

fn journal_for_dispatch(request:&KernelRequest,sleeve:Sleeve)->Result<(ObservedJournal,String)> {
    let mut journal=request.journal.clone();
    // Only the exact pending reservation is replaced. Filled positions, unknown
    // acceptance, kill state and all other sleeve liabilities remain untouched.
    let reservation_id=match &request.dispatch_reservation_key {
        Some(key)=> {
            let matches:Vec<_>=journal.reservations.iter().filter(|r|&r.reservation_id==key).collect();
            if matches.len()!=1 {return Err(KernelError::DispatchBinding);}
            let current=matches[0];
            let expected:BTreeSet<_>=request.legs.iter().map(|l|l.intent_hash.as_str()).collect();
            if current.strategy_artifact_id!=request.strategy_artifact_id || current.sleeve!=sleeve ||
                current.proposal_hashes.iter().map(String::as_str).collect::<BTreeSet<_>>()!=expected ||
                current.proposal_hashes.len()!=expected.len() {return Err(KernelError::DispatchBinding);}
            journal.reservations.retain(|r|&r.reservation_id!=key);
            key.clone()
        },
        None=>request.request_id.clone(),
    };
    if journal.reservations.iter().any(|r|r.reservation_id==reservation_id) {return Err(KernelError::DispatchBinding);}
    Ok((journal,reservation_id))
}

#[cfg(test)]
#[path = "../tests/risk/regression.rs"]
mod risk_regressions;
