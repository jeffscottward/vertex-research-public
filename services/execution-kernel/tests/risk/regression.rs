//! Authored only. Synthetic policy/journal observations, not market/account data.
//! Sources and intentional 0DTE changes: private/source-provenance-v1.json.
use crate::{calendar::{CivilDate, ExchangeCalendar, Ns, OffsetInterval, Session, DAY_NS}, decimal::Decimal as D, model::*, qualification, risk, KernelError};
use std::collections::BTreeMap;
fn d(s:&str)->D {s.parse().unwrap()}
fn stamp()->Ns {CivilDate::parse("2026-09-22").unwrap().instant(600,-14400).unwrap()}
fn later(delta:i128)->Ns {Ns(stamp().0+delta)}
fn hash()->String {"a".repeat(64)}
fn limits()->Limits {Limits {gross_notional:d("1000000"),maximum_loss:d("1000000"),reserved_cash:d("1000000"),
    absolute_greeks:Greeks {delta:d("1000000"),gamma:d("1000000"),vega:d("1000000"),theta:d("1000000"),rho:d("1000000")},
    per_instrument_notional:d("1000000"),per_expiry_notional:d("1000000"),maximum_positions:100}}
fn policy()->Policy {
    Policy {policy_id:"risk-fixture-1".into(),version:"1.0.0".into(),account_alias:"synthetic-account".into(),environment:"paper".into(),currency:"USD".into(),
        valid_from_ns:later(-1000),valid_until_ns:later(100000),strategy_artifact:ArtifactBinding {id:"strategy-artifact-1".into(),sha256:hash()},
        approved_instruments:vec![ArtifactBinding {id:"stock".into(),sha256:hash()}],approved_calendars:vec![ArtifactBinding {id:"XNYS".into(),sha256:hash()}],
        approved_entitlement_policy_ids:vec!["rights".into()],approved_greek_model_ids:vec!["greeks-v1".into()],quote_max_age_ns:Ns(100),greek_max_age_ns:Ns(100),
        journal_max_age_ns:Ns(100),entitlement_max_age_ns:Ns(100),maximum_spread_bps:d("1000"),minimum_displayed_quantity:d("1"),maximum_participation_bps:d("10000"),
        costs:CostPolicy {model_id:"cost-v1".into(),fee_per_unit:d("0.5"),fee_per_leg:d("0.25"),slippage_bps:d("10"),currency_quantum:d("0.01"),latency_model_id:"latency-v1".into(),submission_latency_ns:Ns(1),maximum_receive_delay_ns:Ns(10)},
        portfolio_limits:limits(),sleeve_limits:[Sleeve::Wheel,Sleeve::Fundamental,Sleeve::Swing,Sleeve::Macro,Sleeve::Quant].into_iter().map(|s|(s,limits())).collect(),zero_dte:None}
}
fn journal()->ObservedJournal {
    ObservedJournal {source:"local-execution-journal".into(),journal_id:"journal-fixture".into(),revision:Ns(1),owner_epoch:Ns(1),head_hash:hash(),account_alias:"synthetic-account".into(),environment:"paper".into(),currency:"USD".into(),observed_at_ns:stamp(),reconciled_at_ns:stamp(),durable:true,continuity_complete:true,fully_reconciled:true,unknown_acceptance:false,kill_new_risk:false,settled_cash:d("1000000"),positions:vec![],reservations:vec![]}
}
fn reservation(id:&str,sleeve:Sleeve)->Reservation {
    let mut r=risk::empty_reservation(id.into(),sleeve);r.strategy_artifact_id="strategy-artifact-1".into();r.proposal_hashes=vec![hash()];r
}
fn market(id:&str)->MarketQuote {
    MarketQuote {quote_id:format!("quote-{id}"),instrument_id:id.into(),provider:"provider-fixture".into(),snapshot_id:"snapshot-fixture".into(),data_vintage_id:"vintage-fixture".into(),source_hash:hash(),source_at_ns:stamp(),received_at_ns:stamp(),executable:true,data_kind:"real".into(),bid:d("2"),ask:d("2.01"),bid_size:d("100"),ask_size:d("100"),
        currency:"USD".into(),
        entitlement:Entitlement {policy_id:"rights".into(),granted:true,checked_at_ns:stamp(),expires_at_ns:later(1000),provider:"provider-fixture".into(),instrument_id:id.into(),usage:"paper-simulation".into()}}
}
fn option(right:OptionRight,side:Side,settlement:SettlementKind)->Leg {
    let date=CivilDate::parse("2026-09-22").unwrap();let start=date.instant(0,-14400).unwrap();
    let mut underlying=market("stock");underlying.bid=d("99");underlying.ask=d("100");
    Leg {intent_hash:hash(),instrument:QualifiedInstrument {instrument_id:"option".into(),qualification_id:"qualification-v1".into(),metadata_version:"metadata-v1".into(),corporate_action_version:"split-v1".into(),exchange:"XNYS".into(),currency:"USD".into(),underlying_id:"stock".into(),kind:AssetKind::Option,multiplier:d("100"),tick_size:d("0.01"),quantity_step:d("1"),calendar_id:"XNYS".into(),valid_from_ns:later(-100),valid_until_ns:later(10000),
        option:Some(OptionTerms {right,strike:d("100"),expiry_date:date,expiry_minute:960,expiry_ns:date.instant(960,-14400).unwrap(),exercise_style:ExerciseStyle::American,settlement,settlement_policy_id:"settlement-v1".into(),settlement_at_ns:Ns(start.0+2*DAY_NS),exercise_fee_per_contract:d("1")})},
        calendar:ExchangeCalendar {calendar_id:"XNYS".into(),version:"calendar-v1".into(),timezone:"America/New_York".into(),tzdb_version:"fixture-2026".into(),intervals:vec![OffsetInterval {start_ns:start,end_ns:Ns(start.0+DAY_NS),offset_seconds:-14400}],sessions:vec![Session {date,tradable:true,open_minute:570,close_minute:960,entry_cutoff_minute:945}]},side,quantity:d("1"),limit_price:d("2"),quote:market("option"),underlying_quote:underlying,
        greeks:GreekObservation {values:Greeks {delta:if right==OptionRight::Call {d("0.5")} else {d("-0.5")},gamma:d("0.1"),vega:d("1"),theta:d("-0.2"),rho:d("0.01")},instrument_id:"option".into(),provider:"provider-fixture".into(),model_id:"greeks-v1".into(),model_version:"1.0.0".into(),source_hash:hash(),quote_id:"quote-option".into(),underlying_quote_id:"quote-stock".into(),data_vintage_id:"vintage-fixture".into(),observed_at_ns:stamp(),received_at_ns:stamp(),unit:"per-underlying-unit".into()}}
}
fn stock_position(sleeve:Sleeve,quantity:&str,settled:&str)->ObservedPosition {
    ObservedPosition {position_id:"position-stock".into(),sleeve,instrument_id:"stock".into(),kind:AssetKind::Equity,underlying_id:"stock".into(),expiry_date:None,quantity:d(quantity),unit_notional:d("100"),unit_greeks:risk::equity_greeks(),valuation_at_ns:stamp(),greek_observed_at_ns:stamp(),source_hash:hash(),greek_model_id:"greeks-v1".into(),greek_unit:"per-position-unit".into(),data_vintage_id:"vintage-fixture".into(),cash_encumbered:D::ZERO,maximum_loss:d("10000"),settled_quantity:d(settled),covered_shares_encumbered:BTreeMap::new()}
}

#[test]
fn unready_positions_are_unknown_not_zero_and_kill_is_independent() {
    let p=policy();
    for flag in 0..7 {
        let mut j=journal();
        match flag {0=>j.fully_reconciled=false,1=>j.durable=false,2=>j.continuity_complete=false,3=>j.unknown_acceptance=true,4=>j.kill_new_risk=true,5=>j.observed_at_ns=later(-101),_=>j.source="PortfolioSnapshot".into()}
        assert!(matches!(risk::Portfolio::observe(&j,&p,stamp()),Err(KernelError::JournalNotReady)));
    }
}
#[test]
fn stale_future_crossed_missing_and_unentitled_quotes_fail_closed() {
    let p=policy();
    for state in 0..8 {
        let mut q=market("option");
        match state {0=>q.source_at_ns=later(-101),1=>q.source_at_ns=later(1),2=>q.ask=d("1"),3=>q.bid_size=D::ZERO,
            4=>q.entitlement.expires_at_ns=stamp(),5=>q.entitlement.granted=false,6=>q.entitlement.usage="research".into(),_=>q.source_hash.clear()}
        assert!(qualification::quote(&q,"option",&p,stamp()).is_err());
    }
    assert!(qualification::quote(&market("option"),"option",&p,stamp()).is_ok());
}
#[test]
fn missing_sleeve_budget_and_unconfigured_latency_are_not_defaults() {
    let mut p=policy();assert!(risk::check_policy(&p,stamp()).is_ok());
    p.sleeve_limits.remove(&Sleeve::Macro);assert_eq!(risk::check_policy(&p,stamp()),Err(KernelError::MissingPolicy));
    let mut value=serde_json::to_value(policy()).unwrap();value["costs"].as_object_mut().unwrap().remove("submission_latency_ns");
    assert!(serde_json::from_value::<Policy>(value).is_err());
}
#[test]
fn physical_call_exercise_reserves_strike_cash_beyond_premium() {
    let p=policy();let mut r=reservation("r",Sleeve::Quant);
    let (plan,_) = risk::reserve_leg(&option(OptionRight::Call,Side::Buy,SettlementKind::Physical),&p,&mut r).unwrap();
    assert_eq!(plan.settlement_cash,d("10000"));assert_eq!(plan.cost_reservation,d("1.95"));assert_eq!(plan.cash_reservation,d("10201.95"));
    let mut j=journal();j.settled_cash=d("500");let mut portfolio=risk::Portfolio::observe(&j,&p,stamp()).unwrap();
    assert_eq!(portfolio.admit(&r,&p),Err(KernelError::CashLimit));
}
#[test]
fn cross_sleeve_cash_cannot_spend_unsettled_sale_proceeds() {
    let p=policy();let mut first=reservation("wheel-r",Sleeve::Wheel);
    risk::reserve_leg(&option(OptionRight::Put,Side::Sell,SettlementKind::Physical),&p,&mut first).unwrap();
    let mut second=reservation("quant-r",Sleeve::Quant);
    risk::reserve_leg(&option(OptionRight::Call,Side::Buy,SettlementKind::Physical),&p,&mut second).unwrap();
    let mut j=journal();j.settled_cash=d("15000");j.reservations.push(first);
    let mut portfolio=risk::Portfolio::observe(&j,&p,stamp()).unwrap();assert_eq!(portfolio.admit(&second,&p),Err(KernelError::CashLimit));
}
#[test]
fn covered_shares_are_settled_and_cannot_be_reused_across_sleeves() {
    let p=policy();let mut call=reservation("call-r",Sleeve::Wheel);
    risk::reserve_leg(&option(OptionRight::Call,Side::Sell,SettlementKind::Physical),&p,&mut call).unwrap();
    let mut put=reservation("put-r",Sleeve::Quant);
    risk::reserve_leg(&option(OptionRight::Put,Side::Buy,SettlementKind::Physical),&p,&mut put).unwrap();
    let mut j=journal();j.positions.push(stock_position(Sleeve::Fundamental,"100","100"));j.reservations.push(call.clone());
    let mut portfolio=risk::Portfolio::observe(&j,&p,stamp()).unwrap();assert_eq!(portfolio.admit(&put,&p),Err(KernelError::CoveredShares));
    j.reservations.clear();j.positions[0].settled_quantity=D::ZERO;
    let mut portfolio=risk::Portfolio::observe(&j,&p,stamp()).unwrap();assert_eq!(portfolio.admit(&call,&p),Err(KernelError::CoveredShares));
}
#[test]
fn worst_partial_legs_are_not_allowed_to_net_zero_greeks() {
    let mut p=policy();p.portfolio_limits.absolute_greeks.delta=d("40");
    let mut r=reservation("spread-r",Sleeve::Quant);
    risk::reserve_leg(&option(OptionRight::Call,Side::Buy,SettlementKind::Cash),&p,&mut r).unwrap();
    let mut short=option(OptionRight::Call,Side::Sell,SettlementKind::Physical);short.instrument.instrument_id="second-option".into();
    risk::reserve_leg(&short,&p,&mut r).unwrap();
    assert_eq!(r.greeks.low.delta,d("-50"));assert_eq!(r.greeks.high.delta,d("50"));
    let mut portfolio=risk::Portfolio::observe(&journal(),&p,stamp()).unwrap();assert_eq!(portfolio.admit(&r,&p),Err(KernelError::GreekLimit));
}
#[test]
fn short_cash_call_is_undefined_risk_even_inside_claimed_spread() {
    let mut r=reservation("r",Sleeve::Quant);
    assert_eq!(risk::reserve_leg(&option(OptionRight::Call,Side::Sell,SettlementKind::Cash),&policy(),&mut r).unwrap_err(),KernelError::UndefinedRisk);
}
#[test]
fn same_day_is_not_an_accepted_strategy_and_never_becomes_a_sixth_sleeve() {
    // Gamma execution.py:24-34 and Charan.py:338-350 keep rejection boundaries.
    // New private paper gate requires explicit exact artifact evidence, not dte=0.
    let mut p=policy();assert_eq!(qualification::zero_dte_gate(&p,"strategy-artifact-1",stamp()),Err(KernelError::ZeroDteGate));
    p.zero_dte=Some(ZeroDteGate {policy_id:"zero-dte-policy".into(),strategy_artifact_id:"strategy-artifact-1".into(),review_artifact_id:"review".into(),intraday_dataset_id:"intraday-options".into(),replay_report_id:"replay".into(),expiry_scenarios_report_id:"expiry".into(),rapid_exit_report_id:"exit".into(),partial_leg_report_id:"partial".into(),valid_until_ns:later(10),owner_review_verified:true});
    assert!(qualification::zero_dte_gate(&p,"strategy-artifact-1",stamp()).is_ok());
    assert!(qualification::zero_dte_gate(&p,"latest-strategy",stamp()).is_err());
    assert!(qualification::zero_dte_gate(&p,"strategy-artifact-1",later(10)).is_err());
    p.zero_dte.as_mut().unwrap().owner_review_verified=false;assert!(qualification::zero_dte_gate(&p,"strategy-artifact-1",stamp()).is_err());
    assert!(serde_json::from_str::<Sleeve>("\"zero-dte\"").is_err());
}
#[test]
fn stale_position_greeks_and_wrong_units_cannot_hide_portfolio_exposure() {
    let mut j=journal();j.positions.push(stock_position(Sleeve::Fundamental,"100","100"));
    j.positions[0].greek_observed_at_ns=later(-101);assert!(risk::Portfolio::observe(&j,&policy(),stamp()).is_err());
    j.positions[0].greek_observed_at_ns=stamp();j.positions[0].greek_unit="per-underlying-unit".into();
    assert!(risk::Portfolio::observe(&j,&policy(),stamp()).is_err());
}
#[test]
fn zero_remaining_time_never_gets_a_one_day_greek_fallback() {
    let leg=option(OptionRight::Call,Side::Buy,SettlementKind::Cash);
    assert_eq!(leg.calendar.entry(leg.instrument.option.as_ref().unwrap().expiry_ns).unwrap_err(),KernelError::SessionClosed);
    let mut r=reservation("r",Sleeve::Quant);let before=risk::reserve_leg(&leg,&policy(),&mut r).unwrap();
    assert_eq!(before.0.expiry_ns,Some(leg.instrument.option.unwrap().expiry_ns));
}

#[test]
fn dispatch_excludes_only_exact_pending_reserve_and_keeps_fills_and_other_sleeves() {
    let leg=option(OptionRight::Call,Side::Buy,SettlementKind::Cash);
    let mut j=journal();j.positions.push(stock_position(Sleeve::Fundamental,"10","10"));
    j.reservations.push(reservation("current",Sleeve::Quant));
    j.reservations.push(reservation("other",Sleeve::Wheel));j.unknown_acceptance=true;
    let mut request=KernelRequest {request_version:crate::REQUEST_VERSION.into(),operation:"evaluate".into(),mode:"PAPER-SIMULATION".into(),
        request_id:"request".into(),now_ns:stamp(),account_alias:"synthetic-account".into(),strategy_artifact_id:"strategy-artifact-1".into(),
        strategy:serde_json::Value::Null,intents:vec![],policy:policy(),journal:j,legs:vec![leg],dispatch_reservation_key:Some("current".into())};
    let (remaining,key)=crate::journal_for_dispatch(&request,Sleeve::Quant).unwrap();
    assert_eq!(key,"current");assert_eq!(remaining.reservations.len(),1);assert_eq!(remaining.reservations[0].reservation_id,"other");
    assert_eq!(remaining.positions.len(),1);assert!(remaining.unknown_acceptance);
    assert!(matches!(risk::Portfolio::observe(&remaining,&request.policy,stamp()),Err(KernelError::JournalNotReady)));
    request.legs[0].intent_hash="b".repeat(64);
    assert!(matches!(crate::journal_for_dispatch(&request,Sleeve::Quant),Err(KernelError::DispatchBinding)));
    request.legs[0].intent_hash=hash();request.dispatch_reservation_key=Some("other".into());
    assert!(matches!(crate::journal_for_dispatch(&request,Sleeve::Quant),Err(KernelError::DispatchBinding)));
}

#[test]
fn each_greek_dimension_and_concentration_is_independently_bounded() {
    let mut r=reservation("r",Sleeve::Quant);let p=policy();
    risk::reserve_leg(&option(OptionRight::Call,Side::Buy,SettlementKind::Cash),&p,&mut r).unwrap();
    for dimension in 0..5 {
        let mut p=policy();let caps=&mut p.portfolio_limits.absolute_greeks;
        match dimension {0=>caps.delta=D::ZERO,1=>caps.gamma=D::ZERO,2=>caps.vega=D::ZERO,3=>caps.theta=D::ZERO,_=>caps.rho=D::ZERO}
        let mut portfolio=risk::Portfolio::observe(&journal(),&p,stamp()).unwrap();
        assert_eq!(portfolio.admit(&r,&p),Err(KernelError::GreekLimit));
    }
    for expiry in [false,true] {
        let mut p=policy();
        if expiry {p.portfolio_limits.per_expiry_notional=d("9999");} else {p.portfolio_limits.per_instrument_notional=d("9999");}
        let mut portfolio=risk::Portfolio::observe(&journal(),&p,stamp()).unwrap();
        assert_eq!(portfolio.admit(&r,&p),Err(KernelError::ExposureLimit));
    }
}

#[test]
fn per_leg_reports_match_pessimistic_aggregate_without_double_adding_costs() {
    let p=policy();let mut r=reservation("r",Sleeve::Quant);
    let (plan,loss)=risk::reserve_leg(&option(OptionRight::Call,Side::Buy,SettlementKind::Physical),&p,&mut r).unwrap();
    assert_eq!(plan.maximum_loss,loss);assert_eq!(plan.maximum_loss,r.maximum_loss);
    assert_eq!(plan.gross_notional,r.gross_notional);assert_eq!(plan.cash_reservation,r.cash);
    assert_eq!(plan.cash_reservation,plan.settlement_cash.checked_add(plan.cost_reservation).unwrap().checked_add(d("200")).unwrap());
}

#[test]
fn underlying_quotes_cannot_silently_assume_policy_currency() {
    let mut q=market("stock");q.currency="EUR".into();
    assert_eq!(qualification::quote(&q,"stock",&policy(),stamp()),Err(KernelError::QuoteQuality));
    let mut value=serde_json::to_value(market("stock")).unwrap();
    value.as_object_mut().unwrap().remove("currency");
    assert!(serde_json::from_value::<MarketQuote>(value).is_err());
}

#[test]
fn journal_source_observation_precedes_reconciliation_and_both_precede_now() {
    let p=policy();let mut j=journal();
    j.observed_at_ns=later(-50);j.reconciled_at_ns=later(-10);
    assert!(risk::Portfolio::observe(&j,&p,stamp()).is_ok());
    j.reconciled_at_ns=later(-51);
    assert!(matches!(risk::Portfolio::observe(&j,&p,stamp()),Err(KernelError::JournalNotReady)));
    j.reconciled_at_ns=later(1);
    assert!(matches!(risk::Portfolio::observe(&j,&p,stamp()),Err(KernelError::JournalNotReady)));
    j.reconciled_at_ns=stamp();j.observed_at_ns=later(-101);
    assert!(matches!(risk::Portfolio::observe(&j,&p,stamp()),Err(KernelError::JournalNotReady)));
}
