//! Inert composition over the SAME linked ibapi client held by a real owner.
//! Does not discover/connect/register/disconnect a broker or construct Nautilus.
use crate::contracts::{self, Anchor, BarSize, BarSource, Capture, Request, RequestKind};
use crate::pacing::{OwnerAdmission, SharedHistoryBudget};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures::StreamExt;
use ibapi::contracts::{Contract, ContractDetails, SecurityType};
use ibapi::market_data::historical::{Bar, BarTimestamp, HistoricalBarUpdate, TickBidAsk};
use ibapi::market_data::{IgnoreSize, TradingHours};
use ibapi::subscriptions::SubscriptionItem;
use ibapi::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use time::OffsetDateTime;
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const LIMITATIONS: &[&str] = &[
    "sdk-decoded-not-wire: original strings and field presence unavailable; SDK may default absent fields",
    "f64-bits preserve SDK-decoded values, not original decimal precision; tick sizes are SDK i32",
    "no OHLC correction, price magnification, rounding, zero-fill, sorting, deduplication or calendar synthesis",
    "provider time and decoded receive order are not old arrival clocks or exchange tie order",
    "source response completion is not complete requested-window/exchange/universe coverage",
    "TRADES split-adjusted not dividend-adjusted; ADJUSTED_LAST split-and-dividend-adjusted retrieval is not PIT",
    "request-scoped notices only; no global account/order/wire observer",
    "capture row/byte/event caps do not bound the upstream SDK protobuf frame/vector allocation",
    "one contract, one logical call, no pagination, no automatic retry; tick same-second overflow retained up to cap",
    "cancellation receipt describes local send only, not broker acknowledgment; uncertain request quarantines owner history slot",
];

#[derive(Clone, Serialize)]
pub struct OwnerIdentity {
    pub generation: String,
    pub endpoint_ref: String,
    /// Trusted same-image owner build/provenance identity, not an endpoint/address.
    pub build_ref: String,
}

/// Supplied by the authorized contract-qualification owner, never by request JSON.
/// Units/magnifier/precision are evidence, not transformations applied here.
#[derive(Clone, Serialize)]
pub struct EquitySemantics {
    pub details_sha256: String,
    pub price_magnifier: i32,
    pub price_precision: u8,
    pub size_unit: String,
    pub volume_unit: String,
    pub timezone: String,
    pub calendar_ref: String,
}

#[derive(Clone, Serialize)]
pub struct QualificationCapture {
    encoding: &'static str,
    original_bytes_base64: String,
    sha256: String,
    observed_unix_ns: String,
    raw_wire: bool,
}
impl QualificationCapture {
    /// Exact bytes produced by the pinned SDK's serde representation, not wire
    /// bytes or a reconstructed old observation. Called at real qualification.
    pub fn observed(bytes: &[u8], observed_unix_ns: i128) -> Result<Self, &'static str> {
        if bytes.is_empty() || bytes.len() > 65_536 || observed_unix_ns <= 0
            || observed_unix_ns > OffsetDateTime::now_utc().unix_timestamp_nanos() {
            return Err("bounded-real-qualification-required");
        }
        Ok(Self { encoding: "ibapi-serde-json", original_bytes_base64: STANDARD.encode(bytes),
            sha256: contracts::sha256(bytes), observed_unix_ns: observed_unix_ns.to_string(), raw_wire: false })
    }
}

pub struct QualifiedEquity { contract: Contract, semantics: EquitySemantics, qualification: QualificationCapture }
impl QualifiedEquity {
    pub fn new(contract: Contract, semantics: EquitySemantics,
        qualification: QualificationCapture) -> Result<Self, &'static str> {
        if contract.security_type != SecurityType::Stock || contract.contract_id <= 0
            || contract.include_expired || !contract.combo_legs.is_empty()
            || !contract.strike.is_finite() || contract.strike != 0.0 || contract.right.is_some()
            || contract.delta_neutral_contract.is_some() || !contract.last_trade_date_or_contract_month.is_empty()
            || contract.last_trade_date.is_some() || !contract.multiplier.is_empty()
            || semantics.details_sha256.len() != 64
            || !semantics.details_sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || semantics.price_magnifier <= 0 || semantics.price_precision > 18
            || semantics.size_unit != "shares"
            || !matches!(semantics.volume_unit.as_str(), "shares" | "lots" | "unqualified")
            || !contracts::identifier(&semantics.timezone) || !contracts::identifier(&semantics.calendar_ref) {
            return Err("qualified-equity-metadata-required");
        }
        if serde_json::to_vec(&contract).map_err(|_| "contract-serialization")?.len() > 8192 {
            return Err("contract-metadata-bound");
        }
        let raw = STANDARD.decode(&qualification.original_bytes_base64).map_err(|_| "qualification-base64")?;
        let details: ContractDetails = serde_json::from_slice(&raw).map_err(|_| "qualification-details")?;
        if qualification.sha256 != semantics.details_sha256 || contracts::sha256(&raw) != qualification.sha256
            || details.contract != contract || details.price_magnifier != semantics.price_magnifier
            || details.time_zone_id != semantics.timezone {
            return Err("qualification-original-binding-mismatch");
        }
        Ok(Self { contract, semantics, qualification })
    }
}

/// Capability switches are trusted owner composition, never request/config booleans.
/// Constructor is inert. Missing binding/owner does not activate this capability.
pub struct Capabilities { pub bars: bool, pub adjusted_last: bool, pub bid_ask_ticks: bool }

pub struct HistoryAdapter {
    client: Arc<Client>,
    identity: OwnerIdentity,
    contracts: HashMap<String, QualifiedEquity>,
    budget: Arc<SharedHistoryBudget>,
    admission: Arc<dyn OwnerAdmission>,
    enabled: Capabilities,
}
impl HistoryAdapter {
    pub fn from_existing_owner(client: Arc<Client>, identity: OwnerIdentity,
        contracts: HashMap<String, QualifiedEquity>, budget: Arc<SharedHistoryBudget>,
        admission: Arc<dyn OwnerAdmission>, enabled: Capabilities) -> Result<Self, &'static str> {
        if !contracts::identifier(&identity.generation) || !contracts::identifier(&identity.endpoint_ref)
            || !contracts::identifier(&identity.build_ref) || contracts.is_empty() || contracts.len() > 128
            || contracts.keys().any(|key| !contracts::identifier(key)) {
            return Err("invalid-owner-composition");
        }
        Ok(Self { client, identity, contracts, budget, admission, enabled })
    }

    /// Must run/join on the existing owner's runtime. The future must be retained
    /// through cancellation to obtain evidence; externally dropping it quarantines
    /// any dispatched slot and cannot fabricate a result or complete termination.
    pub async fn acquire_json(&self, bytes: &[u8], cancel: CancellationToken) -> Result<Capture, &'static str> {
        let started = Instant::now();
        let started_unix_ns = OffsetDateTime::now_utc().unix_timestamp_nanos().to_string();
        let request = Request::parse(bytes)?;
        let equity = self.contracts.get(&request.contract_ref).ok_or("contract-not-allowlisted")?;
        let mut capture = Envelope::new(request.clone(), bytes, &self.identity, equity)?;
        capture.started = started;
        capture.value["acquisition"]["started_unix_ns"] = json!(started_unix_ns);
        capture.value["sdk"]["negotiated_server_version"] = json!(self.client.server_version());
        let deadline = capture.started + Duration::from_millis(request.limits.timeout_ms as u64);
        // Leave a bounded cancellation-send interval INSIDE the whole-call deadline.
        let acquire_deadline = deadline - Duration::from_millis(250);
        let weight = match request.kind { RequestKind::Bars { .. } => 1, RequestKind::BidAskTicks { .. } => 2 };
        let enabled = match &request.kind {
            RequestKind::Bars { what_to_show, .. } => self.enabled.bars
                && (*what_to_show != BarSource::AdjustedLast || self.enabled.adjusted_last),
            RequestKind::BidAskTicks { .. } => self.enabled.bid_ask_ticks,
        };
        if !enabled { return capture.finish("capability-disabled", false, false); }
        if !self.admission.generation_is_current(&self.identity.generation) || !self.client.is_connected() {
            return capture.finish("existing-owner-unavailable", false, false);
        }
        if cancel.is_cancelled() { return capture.finish("cancelled-before-dispatch", false, false); }
        let now = OffsetDateTime::now_utc().unix_timestamp();
        match &request.kind {
            RequestKind::Bars { end_unix_seconds: Some(end), .. } if *end > now => {
                return capture.finish("future-bar-end-rejected", false, false);
            }
            RequestKind::BidAskTicks { session_end_unix_seconds, .. } if *session_end_unix_seconds > now => {
                return capture.finish("unfinished-tick-session-rejected", false, false);
            }
            _ => {}
        }
        let identical = contracts::sha256(&serde_json::to_vec(&json!({
            "contract_id": equity.contract.contract_id, "kind": request.kind,
        })).map_err(|_| "request-serialization")?);
        let mut reservation = match self.budget.reserve(&equity.contract.contract_id.to_string(), &identical, weight, deadline) {
            Ok(value) => value,
            Err(reason) => return capture.finish(reason, false, false),
        };
        // One request + at most one explicit or drop cancellation send. This must
        // share global capacity with ALL users of the injected connection.
        if !self.admission.reserve_api_messages(&self.identity.generation, 2, deadline) {
            return capture.finish("owner-global-api-budget-denied", false, false);
        }
        capture.value["attempts"] = json!({"logical_calls":1,"internal_count":null,
            "upper_bound":1,"reserved_history_weight":weight,"reserved_api_messages":2,
            "dispatch_outcome":"unknown-until-subscription-created"});
        reservation.dispatched();
        let complete = match request.kind {
            RequestKind::Bars { what_to_show, bar_size, duration_days, end_unix_seconds, use_rth } => {
                let mut builder = self.client.historical_data(&equity.contract, match bar_size {
                    BarSize::Minute => ibapi::market_data::historical::BarSize::Min,
                    BarSize::Day => ibapi::market_data::historical::BarSize::Day,
                }).what_to_show(match what_to_show {
                    BarSource::Trades => ibapi::market_data::historical::WhatToShow::Trades,
                    BarSource::AdjustedLast => ibapi::market_data::historical::WhatToShow::AdjustedLast,
                }).duration(ibapi::market_data::historical::Duration::days(duration_days as i32))
                    .trading_hours(TradingHours::from_use_rth(use_rth));
                if let Some(end) = end_unix_seconds {
                    builder = builder.ending(OffsetDateTime::from_unix_timestamp(end).map_err(|_| "bar-end-invalid")?);
                }
                let created = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => { capture.status = "cancelled-during-dispatch"; None },
                    _ = tokio::time::sleep_until(acquire_deadline) => { capture.status = "deadline-during-dispatch"; None },
                    value = builder.fetch_strict() => Some(value),
                };
                match created {
                    Some(Ok(mut subscription)) => {
                        capture.dispatched(subscription.request_id());
                        loop {
                            if !self.admission.generation_is_current(&self.identity.generation) {
                                capture.status = "owner-generation-changed"; break;
                            }
                            let next = tokio::select! {
                                biased;
                                _ = cancel.cancelled() => { capture.status = "cancelled"; break },
                                _ = tokio::time::sleep_until(acquire_deadline) => { capture.status = "deadline"; break },
                                value = subscription.next() => value,
                            };
                            match next {
                                Some(Ok(SubscriptionItem::Data(HistoricalBarUpdate::Historical(data)))) => {
                                    if !capture.event("bar-data-payload", json!({"sdk_decoded_rows":data.bars.len()})) { break; }
                                    for bar in data.bars {
                                        if Instant::now() >= acquire_deadline || cancel.is_cancelled() {
                                            capture.status = "interrupted-during-capture"; break;
                                        }
                                        capture.data_valid &= valid_bar(&bar, bar_size);
                                        if !capture.row(bar_value(bar)) { break; }
                                    }
                                    if capture.status != "acquiring" { break; }
                                }
                                Some(Ok(SubscriptionItem::Data(HistoricalBarUpdate::End { start, end }))) => {
                                    capture.value["provider_window"] = json!({"start":time_value(start),"end":time_value(end)});
                                    capture.data_valid &= start <= end && contracts::supported_time(start.unix_timestamp())
                                        && contracts::supported_time(end.unix_timestamp());
                                    if !capture.event("historical-data-end", json!({})) { break; }
                                    if subscription.source_response_complete() { capture.status = "source-response-complete"; }
                                    break;
                                }
                                Some(Ok(SubscriptionItem::Data(HistoricalBarUpdate::Update(_)))) => {
                                    capture.status = "unexpected-keep-up-to-date-update"; break;
                                }
                                Some(Ok(SubscriptionItem::Notice(notice))) => {
                                    if !capture.event("notice", json!(notice)) { break; }
                                }
                                Some(Err(error)) => { capture.error(error); break; }
                                None => { capture.status = "missing-terminal-response"; break; }
                            }
                        }
                        let terminal = subscription.source_response_complete();
                        if !terminal {
                            capture.cancel_send(tokio::time::timeout_at(deadline, subscription.cancel_checked()).await);
                        }
                        terminal
                    }
                    Some(Err(error)) => { capture.error(error); false }
                    None => false,
                }
            }
            RequestKind::BidAskTicks { anchor, anchor_unix_seconds, number_of_ticks, use_rth,
                session_start_unix_seconds, session_end_unix_seconds, .. } => {
                let time = OffsetDateTime::from_unix_timestamp(anchor_unix_seconds).map_err(|_| "tick-anchor-invalid")?;
                let builder = self.client.historical_ticks(&equity.contract, number_of_ticks as i32)
                    .trading_hours(TradingHours::from_use_rth(use_rth));
                let builder = match anchor { Anchor::Start => builder.starting(time), Anchor::End => builder.ending(time) };
                let created = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => { capture.status = "cancelled-during-dispatch"; None },
                    _ = tokio::time::sleep_until(acquire_deadline) => { capture.status = "deadline-during-dispatch"; None },
                    value = builder.bid_ask(IgnoreSize::No) => Some(value),
                };
                match created {
                    Some(Ok(subscription)) => match subscription.strict() {
                        Ok(mut subscription) => {
                            capture.dispatched(subscription.request_id());
                            loop {
                                if !self.admission.generation_is_current(&self.identity.generation) {
                                    capture.status = "owner-generation-changed"; break;
                                }
                                let next = tokio::select! {
                                    biased;
                                    _ = cancel.cancelled() => { capture.status = "cancelled"; break },
                                    _ = tokio::time::sleep_until(acquire_deadline) => { capture.status = "deadline"; break },
                                    value = subscription.next() => value,
                                };
                                match next {
                                    Some(Ok(SubscriptionItem::Data(tick))) => {
                                        let seconds = tick.timestamp.unix_timestamp();
                                        capture.data_valid &= seconds >= session_start_unix_seconds
                                            && seconds < session_end_unix_seconds
                                            && match anchor { Anchor::Start => seconds >= anchor_unix_seconds,
                                                Anchor::End => seconds <= anchor_unix_seconds }
                                            && tick.price_bid.is_finite() && tick.price_ask.is_finite()
                                            && tick.size_bid >= 0 && tick.size_ask >= 0;
                                        if !capture.row(tick_value(tick)) { break; }
                                    }
                                    Some(Ok(SubscriptionItem::Notice(notice))) => {
                                        if !capture.event("notice", json!(notice)) { break; }
                                    }
                                    Some(Err(error)) => { capture.error(error); break; }
                                    None => {
                                        if subscription.source_response_complete() {
                                            if capture.event("historical-ticks-done", json!({"batch_boundaries":"sdk-not-exposed"})) {
                                                capture.status = "source-response-complete";
                                            }
                                        } else { capture.status = "missing-terminal-response"; }
                                        break;
                                    }
                                }
                            }
                            let terminal = subscription.source_response_complete();
                            if !terminal {
                                capture.cancel_send(tokio::time::timeout_at(deadline, subscription.cancel_checked()).await);
                            }
                            terminal
                        }
                        Err(error) => { capture.error(error); false }
                    },
                    Some(Err(error)) => { capture.error(error); false }
                    None => false,
                }
            }
        };
        if complete { reservation.terminal(); }
        if !complete && capture.value["cancel_status"] == "not-requested" {
            capture.value["cancel_status"] = json!("no-handle-dispatch-outcome-unknown");
        }
        if Instant::now() >= deadline && capture.status == "source-response-complete" {
            capture.status = "whole-operation-deadline";
        }
        let source_complete = complete && capture.status == "source-response-complete";
        let status = capture.status;
        capture.finish(status, source_complete, !complete)
    }
}

fn time_value(time: OffsetDateTime) -> Value {
    json!({"unix_ns":time.unix_timestamp_nanos().to_string(),"offset_seconds":time.offset().whole_seconds()})
}
fn bar_value(bar: Bar) -> Value {
    let timestamp = match bar.date {
        BarTimestamp::Date(date) => json!({"kind":"date","sdk_decoded_label":date.to_string()}),
        BarTimestamp::DateTime(time) => json!({"kind":"datetime","value":time_value(time)}),
    };
    json!({"type":"bar","provider_timestamp":timestamp,
        "open_f64_bits":contracts::float_bits(bar.open),"high_f64_bits":contracts::float_bits(bar.high),
        "low_f64_bits":contracts::float_bits(bar.low),"close_f64_bits":contracts::float_bits(bar.close),
        "volume_f64_bits":contracts::float_bits(bar.volume),"wap_f64_bits":contracts::float_bits(bar.wap),
        "trade_count":bar.count})
}
fn valid_bar(bar: &Bar, size: BarSize) -> bool {
    let time_valid = match (size, bar.date) {
        (BarSize::Day, BarTimestamp::Date(date)) => (2000..=2099).contains(&date.year()),
        (BarSize::Minute, BarTimestamp::DateTime(time)) => contracts::supported_time(time.unix_timestamp()),
        _ => false,
    };
    time_valid && [bar.open,bar.high,bar.low,bar.close,bar.volume,bar.wap].iter().all(|n| n.is_finite())
        && bar.low <= bar.open && bar.open <= bar.high && bar.low <= bar.close && bar.close <= bar.high
}
fn tick_value(tick: TickBidAsk) -> Value {
    json!({"type":"bid_ask_tick","provider_timestamp":time_value(tick.timestamp),
        "provider_timestamp_precision":"seconds","bid_f64_bits":contracts::float_bits(tick.price_bid),
        "ask_f64_bits":contracts::float_bits(tick.price_ask),"bid_size_i32":tick.size_bid,"ask_size_i32":tick.size_ask,
        "bid_past_low":tick.tick_attribute_bid_ask.bid_past_low,"ask_past_high":tick.tick_attribute_bid_ask.ask_past_high})
}

struct Envelope {
    value: Value, request: Request, started: Instant, status: &'static str,
    data_valid: bool, content_bytes: usize, rows: usize, events: usize,
}
impl Envelope {
    fn new(request: Request, original: &[u8], owner: &OwnerIdentity, equity: &QualifiedEquity) -> Result<Self, &'static str> {
        let effective = match &request.kind {
            RequestKind::Bars { what_to_show, bar_size, duration_days, end_unix_seconds, use_rth } => json!({
                "type":"bars","what_to_show":what_to_show,"bar_size":bar_size,"duration":format!("{duration_days} D"),
                "end_unix_seconds":end_unix_seconds,"use_rth":use_rth,"format_date":2,"keep_up_to_date":false,
                "adjustment":if *what_to_show == BarSource::Trades {"split-adjusted-not-dividend-adjusted"} else {"split-and-dividend-adjusted"},
                "end_semantics":if end_unix_seconds.is_some() {"explicit-UTC-second"} else {"provider-now-single-request"},
            }),
            RequestKind::BidAskTicks { anchor, anchor_unix_seconds, number_of_ticks, use_rth, .. } => json!({
                "type":"bid_ask_ticks","what_to_show":"BID_ASK","anchor":anchor,"anchor_unix_seconds":anchor_unix_seconds,
                "number_of_ticks":number_of_ticks,"use_rth":use_rth,"ignore_size":false,"pages":1,
            }),
        };
        let value = json!({"schema_version":contracts::SCHEMA_VERSION,"request":request,
            "request_sha256":contracts::sha256(original),"effective_request":effective,
            "owner":owner,"sdk":{"version":contracts::SDK,"extension":"vertex-history-strict-v1",
                "upstream_archive_sha256":"fc5651f11bacdf138a1a910dc075c21e425912ff767e7f3e237b9fe14d9f3f76"},
            "qualified_contract":{"decoded_contract":equity.contract,"semantics":equity.semantics,
                "qualification_capture":equity.qualification},
            "acquisition":{"started_unix_ns":OffsetDateTime::now_utc().unix_timestamp_nanos().to_string()},
            "attempts":{"logical_calls":0,"internal_count":0,"upper_bound":0,"reserved_history_weight":0,"reserved_api_messages":0},
            "status":"not-dispatched","source_response_complete":false,"data_valid":false,
            "capture_complete":false,"market_coverage":"unqualified","point_in_time_adjustments":false,
            "admissible":false,"cancel_status":"not-requested","owner_slot_quarantined":false,
            "provider_window":null,"records":[],"events":[],"limitations":LIMITATIONS});
        let overhead = serde_json::to_vec(&value).map_err(|_| "envelope-serialization")?.len();
        if overhead + 4096 > request.limits.max_bytes as usize { return Err("metadata-exceeds-byte-budget"); }
        Ok(Self { value, request, started: Instant::now(), status: "acquiring", data_valid: true,
            content_bytes: overhead + 4096, rows: 0, events: 0 })
    }
    fn dispatched(&mut self, request_id: i32) {
        self.value["attempts"]["internal_count"] = json!(1);
        self.value["attempts"]["dispatch_outcome"] = json!("subscription-created");
        self.value["attempts"]["sdk_request_id"] = json!(request_id);
    }
    fn row(&mut self, mut row: Value) -> bool {
        row["decoded_receive_ordinal"] = json!(self.rows);
        row["acquired_unix_ns"] = json!(OffsetDateTime::now_utc().unix_timestamp_nanos().to_string());
        if self.rows >= self.request.limits.max_rows as usize { self.status = "row-bound"; return false; }
        if !self.fits(&row) { self.status = "byte-bound"; return false; }
        self.value["records"].as_array_mut().expect("owned envelope records").push(row);
        self.rows += 1;
        true
    }
    fn event(&mut self, kind: &str, detail: Value) -> bool {
        let event = json!({"ordinal":self.events,"kind":kind,"detail":detail,
            "acquired_unix_ns":OffsetDateTime::now_utc().unix_timestamp_nanos().to_string()});
        if self.events >= self.request.limits.max_events as usize { self.status = "event-bound"; return false; }
        if !self.fits(&event) { self.status = "byte-bound"; return false; }
        self.value["events"].as_array_mut().expect("owned envelope events").push(event);
        self.events += 1;
        true
    }
    fn fits(&mut self, value: &Value) -> bool {
        let Ok(bytes) = serde_json::to_vec(value) else { return false; };
        if self.content_bytes + bytes.len() + 1 > self.request.limits.max_bytes as usize { return false; }
        self.content_bytes += bytes.len() + 1;
        true
    }
    fn error(&mut self, error: ibapi::Error) {
        // SDK errors are request-scoped; never attach a whole-connection recorder.
        let retained = self.event("sdk-error", json!({"message":error.to_string()}));
        if retained { self.status = "sdk-error"; }
    }
    fn cancel_send(&mut self, result: Result<Result<(), ibapi::Error>, tokio::time::error::Elapsed>) {
        let status = match result {
            Ok(Ok(())) => "send-completed-not-broker-acknowledged",
            Ok(Err(error)) => { self.event("cancel-send-error", json!({"message":error.to_string()})); "send-failed" },
            Err(_) => "send-outcome-unknown-deadline",
        };
        self.value["cancel_status"] = json!(status);
    }
    fn finish(mut self, status: &str, complete: bool, quarantined: bool) -> Result<Capture, &'static str> {
        self.value["status"] = json!(status);
        self.value["source_response_complete"] = json!(complete);
        self.value["capture_complete"] = json!(complete);
        self.value["data_valid"] = json!(complete && self.data_valid);
        self.value["owner_slot_quarantined"] = json!(quarantined);
        self.value["acquisition"]["finished_unix_ns"] = json!(OffsetDateTime::now_utc().unix_timestamp_nanos().to_string());
        self.value["acquisition"]["elapsed_monotonic_ns"] = json!(self.started.elapsed().as_nanos().to_string());
        // Admission/rights/coverage are a subsequent independent mount. This
        // acquisition library never labels any bytes as a publishable dataset.
        let bytes = serde_json::to_vec(&self.value).map_err(|_| "capture-serialization")?;
        if bytes.len() > self.request.limits.max_bytes as usize { return Err("capture-byte-bound"); }
        Ok(Capture::from_bytes(bytes))
    }
}
