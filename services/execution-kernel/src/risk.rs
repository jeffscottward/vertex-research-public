use crate::{calendar::{fresh, Ns}, decimal::Decimal as D, model::*, qualification::{digest, identifier, nonnegative, positive}, KernelError, Result};
use std::collections::{BTreeMap, BTreeSet};

impl Greeks {
    pub const ZERO: Self=Self {delta:D::ZERO,gamma:D::ZERO,vega:D::ZERO,theta:D::ZERO,rho:D::ZERO};
    fn values(self)->[D;5] {[self.delta,self.gamma,self.vega,self.theta,self.rho]}
    fn from_values(v:[D;5])->Self { Self {delta:v[0],gamma:v[1],vega:v[2],theta:v[3],rho:v[4]} }
    pub fn checked_add(self,other:Self)->Result<Self> {
        let a=self.values();let b=other.values();let mut out=[D::ZERO;5];
        for i in 0..5 {out[i]=a[i].checked_add(b[i])?;} Ok(Self::from_values(out))
    }
    pub fn checked_mul(self,quantity:D)->Result<Self> {
        let mut out=self.values();for v in &mut out {*v=v.checked_mul(quantity)?;} Ok(Self::from_values(out))
    }
}
pub fn equity_greeks()->Greeks {Greeks {delta:D::ONE,..Greeks::ZERO}}
impl GreekRange {
    pub const ZERO: Self=Self {low:Greeks::ZERO,high:Greeks::ZERO};
    /// Every fraction of each independent leg is included. Bounding each signed
    /// dimension by [min(0,full),max(0,full)] is conservative for all 2^N vertices
    /// and all interior partial fills, without exponential enumeration or netting.
    pub fn partial(full:Greeks)->Self {
        let mut low=full.values();let mut high=low;
        for i in 0..5 {low[i]=low[i].min(D::ZERO);high[i]=high[i].max(D::ZERO);}
        Self {low:Greeks::from_values(low),high:Greeks::from_values(high)}
    }
    pub fn checked_add(self,other:Self)->Result<Self> {Ok(Self {low:self.low.checked_add(other.low)?,high:self.high.checked_add(other.high)?})}
    pub fn validate(self)->Result<()> {
        for (low,high) in self.low.values().into_iter().zip(self.high.values()) {if low>high {return Err(KernelError::InvalidObservation);}}
        Ok(())
    }
    fn within(self,limit:Greeks)->Result<()> {
        for ((low,high),limit) in self.low.values().into_iter().zip(self.high.values()).zip(limit.values()) {
            nonnegative(limit)?;
            if low.abs()?>limit || high.abs()?>limit {return Err(KernelError::GreekLimit);}
        }
        Ok(())
    }
}
fn add_map(target:&mut BTreeMap<String,D>,source:&BTreeMap<String,D>)->Result<()> {
    for (id,amount) in source {nonnegative(*amount)?;let value=target.get(id).copied().unwrap_or(D::ZERO).checked_add(*amount)?;target.insert(id.clone(),value);}
    Ok(())
}
fn add_value(target:&mut BTreeMap<String,D>,key:&str,value:D)->Result<()> {
    target.insert(key.to_owned(),target.get(key).copied().unwrap_or(D::ZERO).checked_add(value)?);Ok(())
}
#[derive(Clone, Debug)]
pub(crate) struct Exposure {
    cash:D, loss:D, gross:D, greeks:GreekRange, slots:u32,
    instruments:BTreeMap<String,D>, expiries:BTreeMap<String,D>, shares:BTreeMap<String,D>,
}
impl Exposure {
    fn zero()->Self {Self {cash:D::ZERO,loss:D::ZERO,gross:D::ZERO,greeks:GreekRange::ZERO,slots:0,instruments:BTreeMap::new(),expiries:BTreeMap::new(),shares:BTreeMap::new()}}
    fn reserve(&mut self,r:&Reservation)->Result<()> {
        nonnegative(r.cash)?;nonnegative(r.maximum_loss)?;nonnegative(r.gross_notional)?;r.greeks.validate()?;
        if !identifier(&r.reservation_id) || !identifier(&r.strategy_artifact_id) || r.proposal_hashes.is_empty() ||
            r.proposal_hashes.iter().any(|h|!digest(h)) || r.proposal_hashes.iter().collect::<BTreeSet<_>>().len()!=r.proposal_hashes.len() ||
            r.position_slots<r.instrument_notionals.len() as u32 {return Err(KernelError::InvalidObservation);}
        let sum=r.instrument_notionals.values().try_fold(D::ZERO,|s,v|s.checked_add(*v))?;
        if sum!=r.gross_notional {return Err(KernelError::InvalidObservation);}
        self.cash=self.cash.checked_add(r.cash)?;self.loss=self.loss.checked_add(r.maximum_loss)?;self.gross=self.gross.checked_add(r.gross_notional)?;
        self.greeks=self.greeks.checked_add(r.greeks)?;self.slots=self.slots.checked_add(r.position_slots).ok_or(KernelError::Overflow)?;
        add_map(&mut self.instruments,&r.instrument_notionals)?;add_map(&mut self.expiries,&r.expiry_notionals)?;add_map(&mut self.shares,&r.covered_shares)?;
        Ok(())
    }
    fn position(&mut self,p:&ObservedPosition)->Result<()> {
        let notional=p.quantity.abs()?.checked_mul(p.unit_notional)?;
        let greek=p.unit_greeks.checked_mul(p.quantity)?;
        self.cash=self.cash.checked_add(p.cash_encumbered)?;self.loss=self.loss.checked_add(p.maximum_loss)?;
        self.gross=self.gross.checked_add(notional)?;self.greeks=self.greeks.checked_add(GreekRange {low:greek,high:greek})?;
        self.slots=self.slots.checked_add(1).ok_or(KernelError::Overflow)?;
        add_value(&mut self.instruments,&p.instrument_id,notional)?;
        if let Some(date)=p.expiry_date {add_value(&mut self.expiries,&date.to_string(),notional)?;}
        add_map(&mut self.shares,&p.covered_shares_encumbered)?;
        Ok(())
    }
    fn within(&self,limits:&Limits)->Result<()> {
        if self.cash>limits.reserved_cash {return Err(KernelError::CashLimit);}
        if self.gross>limits.gross_notional || self.loss>limits.maximum_loss || self.slots>limits.maximum_positions ||
            self.instruments.values().any(|n|*n>limits.per_instrument_notional) || self.expiries.values().any(|n|*n>limits.per_expiry_notional) {
            return Err(KernelError::ExposureLimit);
        }
        self.greeks.within(limits.absolute_greeks)
    }
}
fn check_limits(l:&Limits)->Result<()> {
    for d in [l.gross_notional,l.maximum_loss,l.reserved_cash,l.per_instrument_notional,l.per_expiry_notional] {positive(d)?;}
    for g in l.absolute_greeks.values() {nonnegative(g)?;}
    if l.maximum_positions==0 {return Err(KernelError::MissingPolicy);} Ok(())
}
pub(crate) fn check_policy(p:&Policy,now:Ns)->Result<()> {
    if [&p.policy_id,&p.version,&p.account_alias,&p.strategy_artifact.id,&p.costs.model_id,&p.costs.latency_model_id].iter().any(|s|!identifier(s)) ||
        !digest(&p.strategy_artifact.sha256) || p.environment!="paper" || p.currency.len()!=3 || !p.currency.bytes().all(|c|c.is_ascii_uppercase()) ||
        p.valid_from_ns>now || p.valid_until_ns<=now || p.approved_instruments.is_empty() || p.approved_calendars.is_empty() ||
        p.approved_entitlement_policy_ids.is_empty() || p.approved_greek_model_ids.is_empty() {return Err(KernelError::MissingPolicy);}
    for bindings in [&p.approved_instruments,&p.approved_calendars] {
        let mut ids=BTreeSet::new();for b in bindings {if !identifier(&b.id) || !digest(&b.sha256) || !ids.insert(&b.id) {return Err(KernelError::MissingPolicy);}}
    }
    for ids in [&p.approved_entitlement_policy_ids,&p.approved_greek_model_ids] {
        let mut seen=BTreeSet::new();for id in ids {if !identifier(id) || !seen.insert(id) {return Err(KernelError::MissingPolicy);}}
    }
    for n in [p.quote_max_age_ns,p.greek_max_age_ns,p.journal_max_age_ns,p.entitlement_max_age_ns,p.costs.submission_latency_ns,p.costs.maximum_receive_delay_ns] {
        if n.0<0 {return Err(KernelError::MissingPolicy);}
    }
    for d in [p.costs.fee_per_unit,p.costs.fee_per_leg,p.costs.slippage_bps,p.maximum_spread_bps] {nonnegative(d)?;}
    positive(p.costs.currency_quantum)?;positive(p.minimum_displayed_quantity)?;positive(p.maximum_participation_bps)?;
    if p.maximum_participation_bps>D::from_u32(10000) || p.costs.slippage_bps>D::from_u32(10000) {return Err(KernelError::MissingPolicy);}
    check_limits(&p.portfolio_limits)?;
    // Five funded sleeves only. 0DTE is a separately reviewed strategy gate,
    // never a sixth sleeve or a fabricated source of buying power.
    for sleeve in [Sleeve::Wheel,Sleeve::Fundamental,Sleeve::Swing,Sleeve::Macro,Sleeve::Quant] {
        check_limits(p.sleeve_limits.get(&sleeve).ok_or(KernelError::MissingPolicy)?)?;
    }
    Ok(())
}
pub(crate) struct Portfolio {
    total:Exposure, sleeves:BTreeMap<Sleeve,Exposure>, settled_shares:BTreeMap<String,D>, settled_cash:D,
}
impl Portfolio {
    pub(crate) fn observe(j:&ObservedJournal,p:&Policy,now:Ns)->Result<Self> {
        if j.source!="local-execution-journal" || !identifier(&j.journal_id) || !digest(&j.head_hash) || j.owner_epoch.0<=0 || j.revision.0<0 ||
            j.account_alias!=p.account_alias || j.environment!="paper" || j.currency!=p.currency || !j.durable || !j.continuity_complete ||
            !j.fully_reconciled || j.unknown_acceptance || j.kill_new_risk || j.positions.len()>10000 || j.reservations.len()>10000 {
            return Err(KernelError::JournalNotReady);
        }
        fresh(j.observed_at_ns,now,p.journal_max_age_ns).map_err(|_|KernelError::JournalNotReady)?;
        // Source observation precedes locally ingested/reconciled state; neither
        // future reconciliation nor backdated ingestion can establish readiness.
        fresh(j.observed_at_ns,j.reconciled_at_ns,p.journal_max_age_ns).map_err(|_|KernelError::JournalNotReady)?;
        fresh(j.reconciled_at_ns,now,p.journal_max_age_ns).map_err(|_|KernelError::JournalNotReady)?;
        nonnegative(j.settled_cash)?;
        let mut out=Self {total:Exposure::zero(),sleeves:BTreeMap::new(),settled_shares:BTreeMap::new(),settled_cash:j.settled_cash};
        let mut ids=BTreeSet::new();
        for position in &j.positions {
            let q=position.quantity;let settled=position.settled_quantity;
            if !ids.insert(&position.position_id) || [&position.position_id,&position.instrument_id,&position.underlying_id,&position.data_vintage_id]
                .iter().any(|s|!identifier(s)) || q==D::ZERO || settled.abs()?>q.abs()? ||
                (q>D::ZERO && settled<D::ZERO) || (q<D::ZERO && settled>D::ZERO) || !digest(&position.source_hash) ||
                !p.approved_greek_model_ids.contains(&position.greek_model_id) || position.greek_unit!="per-position-unit" ||
                (position.kind==AssetKind::Option)!=position.expiry_date.is_some() {return Err(KernelError::JournalNotReady);}
            fresh(position.valuation_at_ns,now,p.quote_max_age_ns)?;fresh(position.greek_observed_at_ns,now,p.greek_max_age_ns)?;
            positive(position.unit_notional)?;nonnegative(position.cash_encumbered)?;nonnegative(position.maximum_loss)?;
            if position.kind==AssetKind::Equity {
                if position.instrument_id!=position.underlying_id || position.unit_greeks!=equity_greeks() {return Err(KernelError::JournalNotReady);}
                add_value(&mut out.settled_shares,&position.instrument_id,settled)?;
            }
            out.total.position(position)?;out.sleeves.entry(position.sleeve).or_insert_with(Exposure::zero).position(position)?;
        }
        ids.clear();
        for reservation in &j.reservations {
            if !ids.insert(&reservation.reservation_id) {return Err(KernelError::JournalNotReady);}
            out.total.reserve(reservation)?;out.sleeves.entry(reservation.sleeve).or_insert_with(Exposure::zero).reserve(reservation)?;
        }
        out.check(p)?;Ok(out)
    }
    fn check(&self,p:&Policy)->Result<()> {
        self.total.within(&p.portfolio_limits)?;
        for (s,e) in &self.sleeves {e.within(p.sleeve_limits.get(s).ok_or(KernelError::MissingPolicy)?)?;}
        if self.total.cash>self.settled_cash {return Err(KernelError::CashLimit);}
        for (id,reserved) in &self.total.shares {
            if *reserved>self.settled_shares.get(id).copied().unwrap_or(D::ZERO) {return Err(KernelError::CoveredShares);}
        }
        Ok(())
    }
    pub(crate) fn admit(&mut self,r:&Reservation,p:&Policy)->Result<()> {
        self.total.reserve(r)?;self.sleeves.entry(r.sleeve).or_insert_with(Exposure::zero).reserve(r)?;self.check(p)
    }
}

pub(crate) fn empty_reservation(id:String,sleeve:Sleeve)->Reservation {
    Reservation {reservation_id:id,sleeve,cash:D::ZERO,maximum_loss:D::ZERO,gross_notional:D::ZERO,
        strategy_artifact_id:String::new(),proposal_hashes:Vec::new(),
        covered_shares:BTreeMap::new(),greeks:GreekRange::ZERO,instrument_notionals:BTreeMap::new(),expiry_notionals:BTreeMap::new(),position_slots:0}
}

/// Conservatively reserve each independent leg, with no spread-netting or
/// expected sale credits. Long exercise is a liability, not a premium-only bet.
pub(crate) fn reserve_leg(leg:&Leg,p:&Policy,total:&mut Reservation)->Result<(LegPlan,D)> {
    let i=&leg.instrument;let quantity=leg.quantity;let units=quantity.checked_mul(i.multiplier)?;
    let notional_price=match &i.option {Some(o)=>leg.underlying_quote.ask.max(o.strike),None=>leg.underlying_quote.ask.max(leg.limit_price)};
    let gross=notional_price.checked_mul(units)?;
    let fee=p.costs.fee_per_unit.checked_mul(quantity)?.checked_add(p.costs.fee_per_leg)?;
    let slippage=leg.limit_price.checked_mul(units)?.checked_mul(p.costs.slippage_bps)?.checked_mul("0.0001".parse::<D>()?)?;
    let mut cost=fee.checked_add(slippage)?;
    let debit=if leg.side==Side::Buy {leg.limit_price.checked_mul(units)?} else {D::ZERO};
    let mut settlement_cash=D::ZERO;
    let mut shares=BTreeMap::new();
    let mut share_risk=D::ZERO;
    let mut settlement_at=None;let mut expiry=None;
    match &i.option {
        None=>if leg.side==Side::Sell {shares.insert(i.instrument_id.clone(),units);share_risk=gross;},
        Some(o)=> {
            settlement_at=Some(o.settlement_at_ns);expiry=Some(o.expiry_ns);
            cost=cost.checked_add(o.exercise_fee_per_contract.checked_mul(quantity)?)?;
            match (o.right,leg.side,o.settlement) {
                (OptionRight::Call,Side::Sell,SettlementKind::Cash)=>return Err(KernelError::UndefinedRisk),
                (OptionRight::Put,Side::Sell,_)=>settlement_cash=o.strike.checked_mul(units)?,
                (OptionRight::Call,Side::Buy,SettlementKind::Physical)=>settlement_cash=o.strike.checked_mul(units)?,
                (OptionRight::Call,Side::Sell,SettlementKind::Physical)|(OptionRight::Put,Side::Buy,SettlementKind::Physical)=> {
                    shares.insert(i.underlying_id.clone(),units);share_risk=gross;
                },
                _=>{},
            }
        },
    }
    cost=cost.ceil_to(p.costs.currency_quantum)?;
    settlement_cash=settlement_cash.ceil_to(p.costs.currency_quantum)?;
    let cash=debit.checked_add(cost)?.checked_add(settlement_cash)?.ceil_to(p.costs.currency_quantum)?;
    let loss=cash.checked_add(share_risk)?;
    let signed_units=if leg.side==Side::Buy {units} else {units.checked_neg()?};
    total.cash=total.cash.checked_add(cash)?;total.maximum_loss=total.maximum_loss.checked_add(loss)?;
    total.gross_notional=total.gross_notional.checked_add(gross)?;
    total.greeks=total.greeks.checked_add(GreekRange::partial(leg.greeks.values.checked_mul(signed_units)?))?;
    total.position_slots=total.position_slots.checked_add(1).ok_or(KernelError::Overflow)?;
    add_map(&mut total.covered_shares,&shares)?;add_value(&mut total.instrument_notionals,&i.instrument_id,gross)?;
    if let Some(o)=&i.option {add_value(&mut total.expiry_notionals,&o.expiry_date.to_string(),gross)?;}
    Ok((LegPlan {instrument_id:i.instrument_id.clone(),intent_hash:leg.intent_hash.clone(),quantity,limit_price:leg.limit_price,
        maximum_loss:loss,gross_notional:gross,
        cash_reservation:cash,cost_reservation:cost,settlement_cash,settlement_at_ns:settlement_at,covered_shares:shares,expiry_ns:expiry},loss))
}
