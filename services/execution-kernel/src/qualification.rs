use crate::{authority::hash, calendar::{fresh, Ns}, decimal::Decimal as D, model::*, KernelError, Result};
use vertex_contracts::ContractAuthority;

pub(crate) fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len()<=160 && s.as_bytes()[0].is_ascii_alphanumeric() &&
        s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'_'|b'.'|b':'|b'-'))
}
pub(crate) fn digest(s: &str) -> bool { s.len()==64 && s.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
pub(crate) fn positive(d: D) -> Result<()> { if d>D::ZERO {Ok(())} else {Err(KernelError::MissingPolicy)} }
pub(crate) fn nonnegative(d: D) -> Result<()> { if d>=D::ZERO {Ok(())} else {Err(KernelError::InvalidObservation)} }
pub(crate) fn quote(q: &MarketQuote, id: &str, policy: &Policy, now: Ns) -> Result<()> {
    if q.instrument_id!=id || q.currency!=policy.currency || [&q.quote_id,&q.provider,&q.snapshot_id,&q.data_vintage_id].iter().any(|v|!identifier(v)) ||
        !digest(&q.source_hash) || !q.executable || q.data_kind!="real" || q.bid<=D::ZERO || q.ask<q.bid ||
        q.bid_size<policy.minimum_displayed_quantity || q.ask_size<policy.minimum_displayed_quantity { return Err(KernelError::QuoteQuality); }
    fresh(q.source_at_ns,now,policy.quote_max_age_ns)?;
    fresh(q.received_at_ns,now,policy.quote_max_age_ns)?;
    fresh(q.source_at_ns,q.received_at_ns,policy.costs.maximum_receive_delay_ns)?;
    // Algebraic spread comparison avoids rounded division hiding a violation.
    if q.ask.checked_sub(q.bid)?.checked_mul(D::from_u32(10000))?>q.bid.checked_mul(policy.maximum_spread_bps)? {
        return Err(KernelError::Liquidity);
    }
    let rights=&q.entitlement;
    if !rights.granted || rights.provider!=q.provider || rights.instrument_id!=id || rights.usage!="paper-simulation" ||
        !policy.approved_entitlement_policy_ids.contains(&rights.policy_id) || now>=rights.expires_at_ns {
        return Err(KernelError::Entitlement);
    }
    fresh(rights.checked_at_ns,now,policy.entitlement_max_age_ns).map_err(|_|KernelError::Entitlement)?;
    Ok(())
}

pub(crate) struct QualifiedLeg { pub expires: Ns }
pub(crate) fn qualify(authority: &ContractAuthority, leg: &Leg, request: &KernelRequest) -> Result<QualifiedLeg> {
    let policy=&request.policy;
    let now=request.now_ns;
    let i=&leg.instrument;
    let calendar=&leg.calendar;
    if [&i.instrument_id,&i.qualification_id,&i.metadata_version,&i.corporate_action_version,&i.exchange,&i.underlying_id,&i.calendar_id]
        .iter().any(|s|!identifier(s)) || i.currency!=policy.currency || i.calendar_id!=calendar.calendar_id ||
        i.valid_from_ns>now || now>=i.valid_until_ns { return Err(KernelError::InstrumentMetadata); }
    positive(i.multiplier)?; positive(i.tick_size)?; positive(i.quantity_step)?; positive(leg.quantity)?; positive(leg.limit_price)?;
    if !leg.quantity.is_multiple_of(i.quantity_step)? || !leg.limit_price.is_multiple_of(i.tick_size)? { return Err(KernelError::InstrumentMetadata); }
    if !policy.approved_instruments.iter().any(|b|b.id==i.instrument_id && hash(authority,i).ok().as_deref()==Some(b.sha256.as_str())) ||
        !policy.approved_calendars.iter().any(|b|b.id==calendar.calendar_id && hash(authority,calendar).ok().as_deref()==Some(b.sha256.as_str())) {
        return Err(KernelError::ArtifactBinding);
    }
    let window=calendar.entry(now)?;
    let earliest_arrival=now.checked_add(policy.costs.submission_latency_ns)?;
    calendar.entry(earliest_arrival)?;
    quote(&leg.quote,&i.instrument_id,policy,now)?;
    quote(&leg.underlying_quote,&i.underlying_id,policy,now)?;
    for q in [&leg.quote,&leg.underlying_quote] {
        if earliest_arrival>=q.entitlement.expires_at_ns { return Err(KernelError::Entitlement); }
    }
    // Quote and risk cannot silently switch vintages/models when market closes.
    let g=&leg.greeks;
    if g.instrument_id!=i.instrument_id || g.provider!=leg.quote.provider || !identifier(&g.model_version) ||
        !policy.approved_greek_model_ids.contains(&g.model_id) || !digest(&g.source_hash) ||
        g.quote_id!=leg.quote.quote_id || g.underlying_quote_id!=leg.underlying_quote.quote_id ||
        g.data_vintage_id!=leg.quote.data_vintage_id || g.data_vintage_id!=leg.underlying_quote.data_vintage_id ||
        g.unit!="per-underlying-unit" || g.observed_at_ns<leg.quote.source_at_ns || g.observed_at_ns<leg.underlying_quote.source_at_ns {
        return Err(KernelError::GreekProvenance);
    }
    fresh(g.observed_at_ns,now,policy.greek_max_age_ns).map_err(|_|KernelError::GreekProvenance)?;
    fresh(g.received_at_ns,now,policy.greek_max_age_ns).map_err(|_|KernelError::GreekProvenance)?;
    fresh(g.observed_at_ns,g.received_at_ns,policy.costs.maximum_receive_delay_ns).map_err(|_|KernelError::GreekProvenance)?;
    if g.values.gamma<D::ZERO || g.values.vega<D::ZERO || g.values.delta.abs()?>D::ONE { return Err(KernelError::GreekProvenance); }
    let displayed=match leg.side {Side::Buy=>leg.quote.ask_size,Side::Sell=>leg.quote.bid_size};
    if leg.quantity.checked_mul(D::from_u32(10000))?>displayed.checked_mul(policy.maximum_participation_bps)? {return Err(KernelError::Liquidity);}
    let mut expires=window.cutoff_ns.min(i.valid_until_ns);
    for q in [&leg.quote,&leg.underlying_quote] {
        expires=expires.min(q.source_at_ns.checked_add(policy.quote_max_age_ns)?)
            .min(q.entitlement.expires_at_ns)
            .min(q.entitlement.checked_at_ns.checked_add(policy.entitlement_max_age_ns)?);
    }
    expires=expires.min(g.observed_at_ns.checked_add(policy.greek_max_age_ns)?);
    let _zero_dte=match (i.kind,&i.option) {
        (AssetKind::Equity,None)=> {
            if i.instrument_id!=i.underlying_id || i.multiplier!=D::ONE || g.values!=crate::risk::equity_greeks() {
                return Err(KernelError::InstrumentMetadata);
            }
            false
        },
        (AssetKind::Option,Some(o))=> {
            positive(o.strike)?; nonnegative(o.exercise_fee_per_contract)?;
            if !i.quantity_step.is_integer() || !i.multiplier.is_integer() || !identifier(&o.settlement_policy_id) ||
                o.expiry_date<window.date || o.expiry_ns<=now || o.settlement_at_ns<o.expiry_ns ||
                calendar.local_instant(o.expiry_date,o.expiry_minute)?!=o.expiry_ns || o.expiry_ns<=earliest_arrival {
                return Err(KernelError::Expired);
            }
            if (o.right==OptionRight::Call && g.values.delta<D::ZERO) || (o.right==OptionRight::Put && g.values.delta>D::ZERO) {
                return Err(KernelError::GreekProvenance);
            }
            expires=expires.min(o.expiry_ns);
            let same_day=o.expiry_date==window.date;
            if same_day {
                expires=expires.min(zero_dte_gate(policy,&request.strategy_artifact_id,earliest_arrival)?);
            }
            same_day
        },
        _=>return Err(KernelError::InstrumentMetadata),
    };
    if earliest_arrival>=expires { return Err(KernelError::Expired); }
    Ok(QualifiedLeg {expires})
}

pub(crate) fn zero_dte_gate(policy:&Policy,strategy_artifact_id:&str,arrival:Ns)->Result<Ns> {
    let gate=policy.zero_dte.as_ref().ok_or(KernelError::ZeroDteGate)?;
    if !gate.owner_review_verified || gate.strategy_artifact_id!=strategy_artifact_id || gate.valid_until_ns<=arrival ||
        [&gate.policy_id,&gate.review_artifact_id,&gate.intraday_dataset_id,&gate.replay_report_id,&gate.expiry_scenarios_report_id,&gate.rapid_exit_report_id,&gate.partial_leg_report_id]
        .iter().any(|s|!identifier(s)) { return Err(KernelError::ZeroDteGate); }
    Ok(gate.valid_until_ns)
}
