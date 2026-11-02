//! Consume the frozen native authority; no copied public schemas live here.
use crate::{calendar::Ns, decimal::Decimal, model::*, KernelError, Result};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeSet, str::FromStr};
use vertex_contracts::ContractAuthority;

pub(crate) fn hash<T: Serialize>(authority: &ContractAuthority, value: &T) -> Result<String> {
    authority.digest(&serde_json::to_value(value).map_err(|_| KernelError::Encoding)?).map_err(|_|KernelError::Contract)
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value.get(key).and_then(Value::as_str).ok_or(KernelError::Contract)
}
fn decimal(value: &Value, key: &str) -> Result<Decimal> { Decimal::from_str(text(value,key)?) }
fn epoch(authority: &ContractAuthority, value: &Value, key: &str) -> Result<Ns> {
    authority.epoch_ns(text(value,key)?).map(Ns).map_err(|_|KernelError::Contract)
}
pub(crate) fn validate(authority: &ContractAuthority, name: &str, value: &Value) -> Result<String> {
    let bytes = authority.encode(value).map_err(|_|KernelError::Contract)?;
    let validated = authority.validate(name,&bytes,"1.0.0").map_err(|_|KernelError::Contract)?;
    Ok(validated.sha256().to_owned())
}
#[derive(Debug)]
pub(crate) struct ProposalBinding {
    pub sleeve: Sleeve, pub strategy_hash: String, pub expires: Ns,
    pub maximum_loss: Decimal, pub maximum_notional: Decimal, pub maximum_positions: u32,
    pub intent_loss_budgets: Vec<Decimal>,
}

pub(crate) fn bind_proposals(authority: &ContractAuthority, request: &KernelRequest) -> Result<ProposalBinding> {
    let strategy_hash = validate(authority,"StrategySpec",&request.strategy)?;
    if strategy_hash!=request.policy.strategy_artifact.sha256 || request.strategy_artifact_id!=request.policy.strategy_artifact.id {
        return Err(KernelError::ArtifactBinding);
    }
    let sleeve: Sleeve = serde_json::from_value(request.strategy.get("sleeve").cloned().ok_or(KernelError::Contract)?)
        .map_err(|_|KernelError::Contract)?;
    let limits = request.strategy.get("riskLimits").ok_or(KernelError::Contract)?;
    let maximum_loss = decimal(limits,"maximumLoss")?;
    let maximum_notional = decimal(limits,"maximumNotional")?;
    let maximum_positions = limits.get("maximumPositions").and_then(Value::as_u64).and_then(|n|u32::try_from(n).ok()).ok_or(KernelError::Contract)?;
    let universe=request.strategy.get("universe").and_then(Value::as_array).ok_or(KernelError::Contract)?;
    let costs=request.strategy.get("costModel").ok_or(KernelError::Contract)?;
    if request.policy.costs.fee_per_unit<decimal(costs,"commissionPerUnit")? ||
        request.policy.costs.slippage_bps<decimal(costs,"slippageBps")?.checked_add(decimal(costs,"spreadBps")?)? ||
        request.policy.maximum_participation_bps>decimal(costs,"maximumParticipationBps")? {
        return Err(KernelError::MissingPolicy);
    }
    if request.intents.len()!=request.legs.len() || request.intents.is_empty() || request.intents.len()>32 { return Err(KernelError::ProposalBinding); }
    let mut seen = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut expires = request.policy.valid_until_ns;
    let mut intent_loss_budgets = Vec::new();
    for (intent,leg) in request.intents.iter().zip(&request.legs) {
        let digest = validate(authority,"TradeIntent",intent)?;
        if !universe.iter().any(|v|v.as_str()==Some(leg.instrument.instrument_id.as_str()) ||
            v.as_str()==Some(leg.instrument.underlying_id.as_str())) { return Err(KernelError::ProposalBinding); }
        if digest!=leg.intent_hash || !seen.insert(text(intent,"intentId")?) || !keys.insert(text(intent,"idempotencyKey")?) ||
            text(intent,"strategyVersion")?!=request.strategy_artifact_id || text(intent,"accountAlias")?!=request.account_alias ||
            text(intent,"environment")?!="paper" || intent.get("proposalOnly").and_then(Value::as_bool)!=Some(true) ||
            intent.get("executionAuthorized").and_then(Value::as_bool)!=Some(false) ||
            text(intent,"instrumentId")?!=leg.instrument.instrument_id ||
            text(intent,"side")?!=match leg.side {Side::Buy=>"buy",Side::Sell=>"sell"} ||
            decimal(intent,"quantity")?!=leg.quantity || text(intent,"orderType")?!="limit" ||
            decimal(intent,"limitPrice")?!=leg.limit_price || decimal(intent,"tickSize")?!=leg.instrument.tick_size ||
            text(intent,"timeInForce")?!="DAY" { return Err(KernelError::ProposalBinding); }
        let expiry = epoch(authority,intent,"expiresAt")?;
        if epoch(authority,intent,"proposedAt")?>request.now_ns || expiry<=request.now_ns { return Err(KernelError::Expired); }
        expires=expires.min(expiry);
        let reference = intent.get("referenceQuote").ok_or(KernelError::Contract)?;
        let source = reference.get("source").ok_or(KernelError::Contract)?;
        let identity = source.get("identity").ok_or(KernelError::Contract)?;
        let rights = source.get("entitlement").ok_or(KernelError::Contract)?;
        if text(reference,"currency")?!=leg.instrument.currency {return Err(KernelError::ProposalBinding);}
        if text(reference,"quoteId")?!=leg.quote.quote_id || decimal(reference,"bid")?!=leg.quote.bid ||
            decimal(reference,"ask")?!=leg.quote.ask || decimal(reference,"bidSize")?!=leg.quote.bid_size ||
            decimal(reference,"askSize")?!=leg.quote.ask_size || epoch(authority,reference,"sourceTimestamp")?!=leg.quote.source_at_ns ||
            epoch(authority,reference,"receivedAt")?!=leg.quote.received_at_ns || text(identity,"provider")?!=leg.quote.provider ||
            text(identity,"snapshotId")?!=leg.quote.snapshot_id || text(identity,"contentHash")?!=leg.quote.source_hash ||
            text(rights,"policyId")?!=leg.quote.entitlement.policy_id || epoch(authority,rights,"checkedAt")?!=leg.quote.entitlement.checked_at_ns ||
            epoch(authority,rights,"expiresAt")?!=leg.quote.entitlement.expires_at_ns { return Err(KernelError::ProposalBinding); }
        intent_loss_budgets.push(decimal(intent,"maxLossBudget")?);
    }
    Ok(ProposalBinding { sleeve, strategy_hash, expires, maximum_loss, maximum_notional, maximum_positions, intent_loss_budgets })
}
