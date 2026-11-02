//! Restricted historical acquisition for an explicitly injected, already-owned
//! ibapi 3.3.0 client. Same-image owner patch is source-authored, NOT built/activated.
//!
//! The owner and this library MUST link the exact same patched SDK crate identity.
//! A separately loaded Python Nautilus wheel has an opaque Rust client and its own
//! registry; neither an Arc nor registry state can cross that boundary by assertion.
//! The opt-in nautilus/ source patch owns an exclusive research generation using
//! its existing shared-registry Arc and exposes restricted history/qualification.
//! It supplies a single shared history/API budget, actual qualified details and
//! generation fencing. Host composition starts it once, never connects per job.
//! This does not establish account-wide pacing across external TWS/API clients.
//!
//! Strict response completion means this one request's decoded terminal protocol
//! response was observed without known loss/error. It does not qualify entitlement,
//! storage/derived rights, instrument calendars, market coverage, raw wire fidelity
//! or point-in-time corporate actions. Publication remains a separate authority.
//!
//! Request/output caps cannot stop the pinned SDK from allocating its protobuf
//! frame/decoded vector first; owner process resource containment is still required.
mod adapter;
pub mod contracts;
mod pacing;

pub use adapter::{Capabilities, EquitySemantics, HistoryAdapter, OwnerIdentity, QualificationCapture, QualifiedEquity};
pub use contracts::{Capture, Request};
pub use pacing::{OwnerAdmission, Reservation as HistoryReservation, SharedHistoryBudget};
