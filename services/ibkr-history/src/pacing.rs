//! A deliberately conservative OWNER policy, not a claim that small-bar IBKR
//! numeric rules apply to minute/daily bars or historical ticks. All same-owner
//! historical users must share this object; the connection's global API scheduler
//! must additionally reserve the request + possible cancel through OwnerAdmission.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::time::{Duration, Instant};

/// Real owner must atomically reserve global API capacity for request + possible
/// cancellation until `latest_send`. No await, no transport/session authority.
/// This is an additional shared-owner prerequisite, not the old cost==1 HTTP gate.
pub trait OwnerAdmission: Send + Sync {
    /// Must fence the expected generation atomically with capacity reservation.
    fn reserve_api_messages(&self, generation: &str, maximum_messages: u32, latest_send: Instant) -> bool;
    fn generation_is_current(&self, generation: &str) -> bool;
}

struct Charge { expires: Instant, contract: String, identical: String, weight: u32 }
struct State { charges: VecDeque<Charge>, active: bool, quarantined: bool }

pub struct SharedHistoryBudget { state: Mutex<State> }
impl SharedHistoryBudget {
    /// Create once per existing owner generation, NEVER once per job/adapter.
    /// Replacing this object to evade an unresolved request is not reconciliation.
    pub fn new_for_owner() -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(State {
            charges: VecDeque::new(), active: false, quarantined: false,
        }) })
    }

    /// Trusted other same-owner history users must reserve through this SAME gate.
    /// Weight is one for bars, two for BID_ASK; callers must use the strict no-retry
    /// SDK path (or separately reserve every attempt), and preserve permit lifetime.
    pub fn reserve(self: &Arc<Self>, contract: &str, identical: &str, weight: u32,
        deadline: Instant) -> Result<Reservation, &'static str> {
        let now = Instant::now();
        if !matches!(weight, 1 | 2) || contract.is_empty() || contract.len() > 128
            || identical.len() != 64 || !identical.bytes().all(|c| c.is_ascii_hexdigit())
            || deadline <= now || deadline > now + Duration::from_secs(60) {
            return Err("invalid-history-reservation");
        }
        let mut state = self.state.lock().map_err(|_| "history-budget-poisoned")?;
        if state.quarantined { return Err("unresolved-history-slot-quarantined"); }
        if state.active { return Err("history-slot-busy"); }
        while state.charges.front().is_some_and(|charge| charge.expires <= now) {
            state.charges.pop_front();
        }
        // Reserve through the whole possible send interval, not just call start.
        // This over-reserves rather than fabricating the actual SDK write timestamp.
        let short_cutoff = now + Duration::from_secs(598);
        if state.charges.iter().map(|c| c.weight).sum::<u32>() + weight > 60
            || state.charges.iter().filter(|c| c.contract == contract && c.expires > short_cutoff)
                .map(|c| c.weight).sum::<u32>() + weight > 5
            || state.charges.iter().any(|c| c.identical == identical
                && c.expires > now + Duration::from_secs(585)) {
            return Err("shared-history-budget-denied");
        }
        state.charges.push_back(Charge { expires: deadline + Duration::from_secs(600),
            contract: contract.into(), identical: identical.into(), weight });
        state.active = true;
        Ok(Reservation { budget: Arc::clone(self), dispatched: false, terminal: false })
    }
}

/// Default drop AFTER dispatch quarantines the owner history slot, including
/// external future cancellation/panic. Only an observed strict terminal releases
/// it. No disconnect/reconnect/reset method is exposed to a research worker.
pub struct Reservation {
    budget: Arc<SharedHistoryBudget>, dispatched: bool, terminal: bool,
}
impl Reservation {
    pub fn dispatched(&mut self) { self.dispatched = true; }
    pub fn terminal(&mut self) { self.terminal = true; }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.budget.state.lock() {
            state.active = false;
            if self.dispatched && !self.terminal { state.quarantined = true; }
        }
    }
}
