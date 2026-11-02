//! Version 1 is SDK-decoded acquisition evidence, not a complete research dataset.
//! No original wire strings, missing-field presence or historical arrival clocks survive
//! ibapi decoding. IEEE754 hex strings preserve all f64 bits, including signed zero/NaN.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const SCHEMA_VERSION: &str = "1.0.0";
pub const MAX_REQUEST_BYTES: usize = 8192;
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
pub const SDK: &str = "ibapi=3.3.0";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema_version: String,
    pub request_id: String,
    pub contract_ref: String,
    pub kind: RequestKind,
    pub limits: Limits,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestKind {
    Bars {
        what_to_show: BarSource,
        bar_size: BarSize,
        duration_days: u16,
        #[serde(deserialize_with = "required_nullable_seconds")]
        end_unix_seconds: Option<i64>,
        use_rth: bool,
    },
    BidAskTicks {
        anchor: Anchor,
        anchor_unix_seconds: i64,
        number_of_ticks: u16,
        use_rth: bool,
        ignore_size: bool,
        session_start_unix_seconds: i64,
        session_end_unix_seconds: i64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BarSource {
    #[serde(rename = "TRADES")]
    Trades,
    #[serde(rename = "ADJUSTED_LAST")]
    AdjustedLast,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BarSize {
    #[serde(rename = "1 min")]
    Minute,
    #[serde(rename = "1 day")]
    Day,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Anchor { Start, End }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    /// Includes local cleanup attempt; not a broker-side cancellation guarantee.
    pub timeout_ms: u32,
    pub max_rows: u32,
    pub max_bytes: u32,
    pub max_events: u16,
}

impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() > MAX_REQUEST_BYTES { return Err("request-byte-bound"); }
        let request: Self = serde_json::from_slice(bytes).map_err(|_| "invalid-request-schema")?;
        if request.schema_version != SCHEMA_VERSION || !identifier(&request.request_id)
            || !identifier(&request.contract_ref) { return Err("invalid-request-identity"); }
        let limits = &request.limits;
        if !(1000..=60_000).contains(&limits.timeout_ms) || !(1..=5000).contains(&limits.max_rows)
            || !(32_768..=MAX_CAPTURE_BYTES as u32).contains(&limits.max_bytes)
            || !(1..=256).contains(&limits.max_events) { return Err("invalid-acquisition-bounds"); }
        match &request.kind {
            RequestKind::Bars { what_to_show, bar_size, duration_days, end_unix_seconds, .. } => {
                let maximum = if *bar_size == BarSize::Minute { 1 } else { 365 };
                if *duration_days == 0 || *duration_days > maximum { return Err("unsupported-bar-span"); }
                match what_to_show {
                    BarSource::Trades if end_unix_seconds.is_none() => return Err("trades-explicit-end-required"),
                    BarSource::AdjustedLast if end_unix_seconds.is_some() => return Err("adjusted-last-end-unsupported"),
                    _ => {}
                }
                if end_unix_seconds.is_some_and(|value| !supported_time(value)) {
                    return Err("unsupported-bar-end");
                }
            }
            RequestKind::BidAskTicks { anchor_unix_seconds, number_of_ticks, ignore_size,
                session_start_unix_seconds, session_end_unix_seconds, .. } => {
                if *ignore_size || !(1..=1000).contains(number_of_ticks)
                    || *session_end_unix_seconds <= *session_start_unix_seconds
                    || session_end_unix_seconds.saturating_sub(*session_start_unix_seconds) > 86_400
                    || !supported_time(*session_start_unix_seconds) || !supported_time(*session_end_unix_seconds)
                    || *anchor_unix_seconds < *session_start_unix_seconds
                    || *anchor_unix_seconds >= *session_end_unix_seconds {
                    return Err("unsupported-tick-request");
                }
            }
        }
        Ok(request)
    }
}

fn required_nullable_seconds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    // Explicit null is meaningful for ADJUSTED_LAST; omitted is not a default.
    Option::<i64>::deserialize(deserializer)
}

pub(crate) fn supported_time(seconds: i64) -> bool {
    // Restricted modern-equity acquisition; epoch sentinel can never be a valid result.
    (946_684_800..=4_102_444_800).contains(&seconds)
}
pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:./".contains(&b))
}
pub(crate) fn sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub(crate) fn float_bits(value: f64) -> String { format!("{:016x}", value.to_bits()) }

/// Exact immutable serialized envelope. There is deliberately no mutable SDK value
/// or public mutable JSON tree behind this interface. Digest covers the exact bytes.
#[derive(Clone, Debug)]
pub struct Capture {
    bytes: Arc<[u8]>,
    digest: String,
}
impl Capture {
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { digest: sha256(&bytes), bytes: bytes.into() }
    }
    pub fn bytes(&self) -> &[u8] { &self.bytes }
    pub fn sha256(&self) -> &str { &self.digest }
}
