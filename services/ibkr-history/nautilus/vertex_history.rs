//! Opt-in same-image Vertex history owner. Installed only by the accompanying
//! rc5 source patch, never as a second extension/registry. No raw client escapes.
//! Explicit bootstrap is the ONLY connecting operation. Ordinary Nautilus users
//! are excluded from this process generation before borrowing its registry Arc.
use std::{collections::{HashMap, VecDeque}, sync::Arc};

use ibapi::{client::Client, contracts::Contract};
use nautilus_common::live::get_runtime;
use parking_lot::Mutex;
use pyo3::{exceptions::PyRuntimeError, prelude::*, types::PyBytes};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::{task::JoinHandle, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;
use vertex_ibkr_history::{Capabilities, EquitySemantics, HistoryAdapter, OwnerAdmission,
    OwnerIdentity, QualificationCapture, QualifiedEquity, Request, SharedHistoryBudget};

use crate::common::shared_client::{vertex_history_connect, SharedClientHandle};

const BINDING: &str = "vertex-nautilus-history-owner-v1";
const SDK_PATCH: &str = "vertex-history-strict-v1";
const MAX_PENDING: usize = 8;
fn failure() -> PyErr { PyRuntimeError::new_err("ibkr-history-owner-unavailable") }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:-/".contains(&c))
}

fn owner_current(check: &Py<PyAny>) -> bool {
    Python::attach(|py| check.bind(py).call0().and_then(|value| value.extract::<bool>()).unwrap_or(false))
}
async fn invalidated(check: &Py<PyAny>) {
    while owner_current(check) { tokio::time::sleep(Duration::from_millis(20)).await; }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Qualification {
    contract_ref: String,
    contract: Contract,
    // Review covers stable scientific identity, NOT rolling trading_hours.
    expected_stable_sha256: String,
    price_precision: u8,
    volume_unit: String,
    calendar_ref: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    generation: String,
    endpoint_ref: String,
    build_ref: String,
    qualifications: Vec<Qualification>,
    bars: bool,
    adjusted_last: bool,
    bid_ask_ticks: bool,
}

struct ApiState { active: bool, unresolved: bool, charges: VecDeque<(Instant, u32)> }
struct Admission { generation: String, client: Arc<Client>, current: Py<PyAny>, state: Mutex<ApiState> }
impl OwnerAdmission for Admission {
    fn reserve_api_messages(&self, generation: &str, maximum_messages: u32, latest_send: Instant) -> bool {
        // Never hold a native mutex while acquiring the GIL: Python begin/drain
        // also enters this owner. The generation/capacity state itself is atomic.
        if !owner_current(&self.current) { return false; }
        let now = Instant::now();
        let mut state = self.state.lock();
        if !state.active || generation != self.generation || !self.client.is_connected()
            || !(1..=2).contains(&maximum_messages) || latest_send <= now
            || latest_send > now + Duration::from_secs(60) { return false; }
        state.charges.retain(|(until, _)| *until > now);
        // Conservative OWNER policy: reserve at most four possible API messages
        // through the entire send interval + one second. Never a per-job counter.
        if state.charges.iter().map(|(_, n)| n).sum::<u32>() + maximum_messages > 4 { return false; }
        state.charges.push_back((latest_send + Duration::from_secs(1), maximum_messages));
        true
    }
    fn generation_is_current(&self, generation: &str) -> bool {
        if !owner_current(&self.current) { return false; }
        let state = self.state.lock();
        state.active && generation == self.generation && self.client.is_connected()
    }
}

struct Acquisition {
    cancel: CancellationToken,
    join: Option<JoinHandle<()>>,
    // Result survives loss/cancellation of the Python waiter. Acknowledgment is
    // private host composition AFTER a confirmed immutable outcome stage receipt.
    outcome: Arc<Mutex<Option<Result<Vec<u8>, &'static str>>>>,
}
struct Owner {
    _handle: SharedClientHandle,
    admission: Arc<Admission>,
    adapter: Arc<HistoryAdapter>,
    pending: Mutex<HashMap<String, Acquisition>>,
    qualification_bytes: Vec<u8>,
}

#[pyclass(module = "nautilus_trader._libnautilus.interactive_brokers")]
pub(super) struct VertexHistoryOwner { owner: Arc<Owner> }

#[pymethods]
impl VertexHistoryOwner {
    #[staticmethod]
    fn identity() -> (&'static str, &'static str, &'static str, &'static str) {
        (BINDING, "2.0.0rc5", "ibapi=3.3.0", SDK_PATCH)
    }

    /// Host startup only. No Python constructor, ambient discovery or reconnect.
    /// Addresses/client IDs come from trusted host config, NEVER request JSON.
    #[staticmethod]
    fn bootstrap(py: Python<'_>, host: String, port: u16, client_id: i32,
        timeout_seconds: u64, bootstrap_json: Vec<u8>, current: Py<PyAny>) -> PyResult<Self> {
        if host.is_empty() || host.len() > 253 || host.chars().any(char::is_control)
            || port == 0 || client_id < 0 || !(1..=30).contains(&timeout_seconds)
            || bootstrap_json.len() > 262_144 { return Err(failure()); }
        let config: Bootstrap = serde_json::from_slice(&bootstrap_json).map_err(|_| failure())?;
        if !identifier(&config.generation) || !identifier(&config.endpoint_ref) || !identifier(&config.build_ref)
            || config.qualifications.is_empty() || config.qualifications.len() > 16
            || !(config.bars || config.bid_ask_ticks) || (config.adjusted_last && !config.bars) {
            return Err(failure());
        }
        let admission_current = current.clone_ref(py);
        py.detach(move || get_runtime().block_on(async move {
            // Feature-gated registry claim is permanent for this process. Refuse
            // if ordinary use has begun, including a connection still in flight.
            // The existing registry helper, not a second transport, makes the Arc.
            if !owner_current(&current) { return Err(failure()); }
            let handle = tokio::select! {
                result = vertex_history_connect(&host, port, client_id, timeout_seconds) => result.map_err(|_| failure())?,
                _ = invalidated(&current) => return Err(failure()),
            };
            let client = Arc::clone(handle.as_arc());
            let admission = Arc::new(Admission { generation: config.generation.clone(),
                client: Arc::clone(&client), current: admission_current,
                state: Mutex::new(ApiState { active: true, unresolved: false,
                    // Conservatively retain two bootstrap/handshake message units
                    // through one second after the existing SDK connect returns.
                    charges: VecDeque::from([(Instant::now() + Duration::from_secs(1), 2)]) }) });
            let mut equities = HashMap::new();
            let mut evidence = Vec::new();
            for reviewed in config.qualifications {
                if !identifier(&reviewed.contract_ref) || equities.contains_key(&reviewed.contract_ref)
                    || reviewed.expected_stable_sha256.len() != 64 { return Err(failure()); }
                let deadline = Instant::now() + Duration::from_secs(5);
                if !admission.reserve_api_messages(&config.generation, 1, deadline) { return Err(failure()); }
                if !owner_current(&current) { return Err(failure()); }
                let details = tokio::select! {
                    result = tokio::time::timeout_at(deadline, client.contract_details(&reviewed.contract)) =>
                        result.map_err(|_| failure())?.map_err(|_| failure())?,
                    _ = invalidated(&current) => return Err(failure()),
                };
                let observed_unix_ns = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
                if details.len() != 1 { return Err(failure()); }
                let details = &details[0];
                let stable = serde_json::json!({
                    "contract_id": details.contract.contract_id,
                    "security_type": details.contract.security_type,
                    "symbol": details.contract.symbol, "currency": details.contract.currency,
                    "exchange": details.contract.exchange,
                    "primary_exchange": details.contract.primary_exchange,
                    "local_symbol": details.contract.local_symbol,
                    "trading_class": details.contract.trading_class,
                    "min_tick_f64_bits": format!("{:016x}", details.min_tick.to_bits()),
                    "price_magnifier": details.price_magnifier, "timezone": details.time_zone_id,
                });
                // Sorted scientific projection is independent of serde_json's
                // optional preserve_order feature elsewhere in the native image.
                let stable = stable.as_object().ok_or_else(failure)?.iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<std::collections::BTreeMap<_, _>>();
                let stable_hash = digest(&serde_json::to_vec(&stable).map_err(|_| failure())?);
                let raw = serde_json::to_vec(details).map_err(|_| failure())?;
                let hash = digest(&raw);
                if raw.len() > 65_536 || stable_hash != reviewed.expected_stable_sha256
                    || details.contract.contract_id != reviewed.contract.contract_id
                    || !details.min_tick.is_finite() || details.min_tick <= 0.0 { return Err(failure()); }
                let qualified = QualifiedEquity::new(details.contract.clone(), EquitySemantics {
                    details_sha256: hash.clone(), price_magnifier: details.price_magnifier,
                    price_precision: reviewed.price_precision, size_unit: "shares".into(),
                    volume_unit: reviewed.volume_unit, timezone: details.time_zone_id.clone(),
                    calendar_ref: reviewed.calendar_ref,
                }, QualificationCapture::observed(&raw, observed_unix_ns).map_err(|_| failure())?)
                    .map_err(|_| failure())?;
                evidence.push(serde_json::json!({"contract_ref": reviewed.contract_ref,
                    "details_sha256": hash, "decoded_details_utf8": String::from_utf8(raw).map_err(|_| failure())?,
                    "stable_projection": stable, "stable_sha256": stable_hash,
                    "encoding": "ibapi-serde-json-not-original-wire",
                    "acquired_unix_ns": observed_unix_ns.to_string()}));
                equities.insert(reviewed.contract_ref, qualified);
                // Qualification is sequential and bounded. Charges include the
                // whole possible send interval, so do not bypass them with retry.
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline + Duration::from_secs(1)) => {},
                    _ = invalidated(&current) => return Err(failure()),
                }
            }
            let adapter = HistoryAdapter::from_existing_owner(Arc::clone(&client), OwnerIdentity {
                generation: config.generation, endpoint_ref: config.endpoint_ref, build_ref: config.build_ref,
            }, equities, SharedHistoryBudget::new_for_owner(), admission.clone(), Capabilities {
                bars: config.bars, adjusted_last: config.adjusted_last, bid_ask_ticks: config.bid_ask_ticks,
            }).map_err(|_| failure())?;
            Ok(Self { owner: Arc::new(Owner { _handle: handle, admission, adapter: Arc::new(adapter),
                pending: Mutex::new(HashMap::new()), qualification_bytes: serde_json::to_vec(&evidence).map_err(|_| failure())? }) })
        }))
    }

    fn qualification_capture<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, &self.owner.qualification_bytes)
    }

    fn begin(&self, request_json: Vec<u8>) -> PyResult<String> {
        Request::parse(&request_json).map_err(|_| failure())?;
        let key = digest(&request_json);
        let mut pending = self.owner.pending.lock();
        if pending.len() >= MAX_PENDING || pending.contains_key(&key)
            || !self.owner.admission.generation_is_current(&self.owner.admission.generation) { return Err(failure()); }
        let cancel = CancellationToken::new();
        let outcome = Arc::new(Mutex::new(None));
        let worker_cancel = cancel.clone();
        let worker_outcome = Arc::clone(&outcome);
        let adapter = Arc::clone(&self.owner.adapter);
        let admission = Arc::clone(&self.owner.admission);
        let join = get_runtime().spawn(async move {
            let result = adapter.acquire_json(&request_json, worker_cancel).await.map(|capture| capture.bytes().to_vec());
            let unresolved = result.as_ref().map_or(true, |bytes|
                serde_json::from_slice::<serde_json::Value>(bytes).ok()
                    .and_then(|value| value["owner_slot_quarantined"].as_bool()).unwrap_or(true));
            if unresolved {
                let mut state = admission.state.lock();
                state.active = false;
                state.unresolved = true;
            }
            *worker_outcome.lock() = Some(result);
        });
        pending.insert(key.clone(), Acquisition { cancel, join: Some(join), outcome });
        Ok(key)
    }

    fn cancel(&self, request_sha256: &str) -> PyResult<()> {
        let pending = self.owner.pending.lock();
        pending.get(request_sha256).ok_or_else(failure)?.cancel.cancel();
        Ok(())
    }

    fn capture<'py>(&self, py: Python<'py>, request_sha256: &str) -> PyResult<Option<Bound<'py, PyBytes>>> {
        let pending = self.owner.pending.lock();
        let acquisition = pending.get(request_sha256).ok_or_else(failure)?;
        if acquisition.join.as_ref().is_some_and(|join| !join.is_finished()) { return Ok(None); }
        let outcome = acquisition.outcome.lock();
        match outcome.as_ref() {
            Some(Ok(bytes)) => Ok(Some(PyBytes::new(py, bytes))),
            Some(Err(_)) => Err(failure()),
            None if acquisition.join.as_ref().is_some_and(|join| join.is_finished()) => Err(failure()),
            None => Ok(None),
        }
    }

    /// Only host receipt handling calls this, never capture-return alone.
    fn acknowledge(&self, py: Python<'_>, request_sha256: &str, capture_sha256: &str) -> PyResult<()> {
        let join = {
            let mut pending = self.owner.pending.lock();
            let acquisition = pending.get_mut(request_sha256).ok_or_else(failure)?;
            if !acquisition.join.as_ref().is_some_and(|join| join.is_finished()) { return Err(failure()); }
            let matches = acquisition.outcome.lock().as_ref().is_some_and(|result|
                result.as_ref().is_ok_and(|bytes| digest(bytes) == capture_sha256));
            if !matches { return Err(failure()); }
            acquisition.join.take().ok_or_else(failure)?
        };
        py.detach(move || get_runtime().block_on(join)).map_err(|_| failure())?;
        self.owner.pending.lock().remove(request_sha256);
        Ok(())
    }

    /// Stop admission, signal cancellation, JOIN retained futures. Does not
    /// disconnect/reset/reconnect. Nonzero result means undelivered evidence;
    /// host must refuse a clean-drain receipt and require reconciliation.
    fn drain(&self, py: Python<'_>) -> PyResult<usize> {
        self.owner.admission.state.lock().active = false;
        let joins = {
            let mut pending = self.owner.pending.lock();
            pending.values_mut().filter_map(|acquisition| {
                acquisition.cancel.cancel(); acquisition.join.take()
            }).collect::<Vec<_>>()
        };
        py.detach(move || get_runtime().block_on(async move {
            for join in joins { join.await.map_err(|_| failure())?; }
            Ok::<(), PyErr>(())
        }))?;
        Ok(self.owner.pending.lock().len() + usize::from(self.owner.admission.state.lock().unresolved))
    }
}
