//! Caller-owned, synchronous, paper-only ABI. No handles, callbacks, disk,
//! clocks, environment discovery or transport. Authority is reconstructed per
//! call to avoid exposing Rust allocation/lifetime ownership across the ABI.
//! Limits are safety ceilings, not a hard RSS/latency proof. OOM/abort/invalid
//! foreign pointers cannot be caught; the embedding host must isolate faults.
#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(panic = "abort")]
compile_error!("vertex-kernel-bridge requires panic=unwind");

use std::{mem, panic::{catch_unwind, AssertUnwindSafe}, ptr, slice, str};
use vertex_contracts::ContractAuthority;

pub const MAX_INPUT_BYTES: usize = 4_194_304;
pub const MAX_OUTPUT_BYTES: usize = 2_000_000;
pub const MAX_BUNDLE_BYTES: usize = 8_388_608;
pub const MAX_IDENTITY_BYTES: usize = 4_096;
const CONTRACT_SOURCE: &str = env!("VERTEX_KERNEL_CONTRACT_SOURCE_SHA256");
const IDENTITY: &str = concat!(
    "{\"abi_version\":1,\"bridge_version\":\"0.1.0\",\"build_id\":\"", env!("VERTEX_KERNEL_BUILD_ID"),
    "\",\"contract_source_sha256\":\"", env!("VERTEX_KERNEL_CONTRACT_SOURCE_SHA256"),
    "\",\"kernel_request_version\":\"vertex.execution-kernel.v1\",\"kernel_source_sha256\":\"", env!("VERTEX_KERNEL_SOURCE_SHA256"),
    "\",\"max_bundle_bytes\":8388608,\"max_input_bytes\":4194304,\"max_output_bytes\":2000000}"
);

#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Ok = 0,
    InvalidArgument = 1,
    InputTooLarge = 2,
    OutputTooSmall = 3,
    AuthorityUnavailable = 4,
    KernelFailure = 5,
    Panic = 6,
    OutputTooLarge = 7,
}

// Arithmetic checks do not establish memory validity. Foreign callers retain
// that obligation. Zero-length regions may have null pointers and are untouched.
fn region(pointer: usize, length: usize) -> Option<(usize, usize)> {
    if length == 0 { return Some((0, 0)); }
    if pointer == 0 || length > isize::MAX as usize { return None; }
    Some((pointer, pointer.checked_add(length)?))
}
fn disjoint(regions: &[(usize, usize)]) -> bool {
    for (index, &(start, end)) in regions.iter().enumerate() {
        if start == end { continue; }
        if regions[index + 1..].iter().any(|&(other, other_end)|
            other != other_end && start < other_end && other < end) { return false; }
    }
    true
}
fn output_regions(output: *mut u8, capacity: usize, written: *mut usize) -> Option<[(usize, usize); 2]> {
    if (written as usize) % mem::align_of::<usize>() != 0 { return None; }
    let regions = [region(output as usize, capacity)?, region(written as usize, mem::size_of::<usize>())?];
    disjoint(&regions).then_some(regions)
}
unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if length == 0 { &[] } else {
        // SAFETY: caller guarantees readable live storage; arithmetic checked by
        // entrypoint; borrow never escapes the synchronous invocation.
        unsafe { slice::from_raw_parts(pointer, length) }
    }
}
unsafe fn copy_result(value: &[u8], output: *mut u8, capacity: usize, written: *mut usize) -> Status {
    // SAFETY: entrypoint checks nonnull/aligned/disjoint length cell; caller owns
    // writable storage. Output is never partially written or NUL-terminated.
    unsafe { ptr::write(written, value.len()); }
    if value.len() > capacity { return Status::OutputTooSmall; }
    if !value.is_empty() {
        // SAFETY: sufficient caller-owned capacity; Rust-produced source does
        // not overlap foreign output; buffers remain live until return.
        unsafe { ptr::copy_nonoverlapping(value.as_ptr(), output, value.len()); }
    }
    Status::Ok
}
fn protect(operation: impl FnOnce() -> Status) -> Status {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or(Status::Panic)
}
fn authority(bundle: &[u8], pin: &[u8]) -> Result<ContractAuthority, Status> {
    if bundle.is_empty() || pin.len() != 64 { return Err(Status::InvalidArgument); }
    let pin = str::from_utf8(pin).map_err(|_| Status::InvalidArgument)?;
    let loaded = ContractAuthority::from_bundle(bundle, pin).map_err(|_| Status::AuthorityUnavailable)?;
    // from_bundle has already bounded, canonicalized and verified this exact
    // immutable bundle, including its internal sourceDigest. Only bind identity;
    // never reimplement or replace any authority schemas/semantic programs.
    let document: serde_json::Value = serde_json::from_slice(bundle).map_err(|_| Status::AuthorityUnavailable)?;
    if document.get("sourceDigest").and_then(|v| v.as_str()) != Some(CONTRACT_SOURCE) {
        return Err(Status::AuthorityUnavailable);
    }
    Ok(loaded)
}

/// Returns static build metadata as UTF-8 JSON into caller-owned memory.
///
/// # Safety
/// Nonempty output must denote writable capacity bytes; written must be a live,
/// aligned writable size_t. Regions must not overlap. No region may be accessed
/// concurrently during the call. Pointer validation cannot detect dangling memory.
#[no_mangle]
pub unsafe extern "C" fn vertex_kernel_bridge_identity_v1(
    output: *mut u8, capacity: usize, written: *mut usize,
) -> i32 {
    if capacity > MAX_IDENTITY_BYTES || output_regions(output, capacity, written).is_none() {
        return Status::InvalidArgument as i32;
    }
    // SAFETY: obligations documented above; validated length cell.
    unsafe { ptr::write(written, 0); }
    protect(|| unsafe { copy_result(IDENTITY.as_bytes(), output, capacity, written) }) as i32
}

/// Verifies availability without retaining native allocations.
///
/// # Safety
/// Inputs must denote readable immutable live storage for the complete call.
/// Regions must be disjoint; no ownership crosses this boundary.
#[no_mangle]
pub unsafe extern "C" fn vertex_kernel_bridge_validate_bundle_v1(
    bundle: *const u8, bundle_len: usize, bundle_sha256: *const u8, pin_len: usize,
) -> i32 {
    if bundle_len > MAX_BUNDLE_BYTES { return Status::InputTooLarge as i32; }
    let (Some(b), Some(p)) = (region(bundle as usize, bundle_len), region(bundle_sha256 as usize, pin_len)) else {
        return Status::InvalidArgument as i32;
    };
    if pin_len != 64 || !disjoint(&[b, p]) { return Status::InvalidArgument as i32; }
    protect(|| {
        // SAFETY: checked lengths/ranges and documented foreign storage lifetime.
        match authority(unsafe { bytes(bundle, bundle_len) }, unsafe { bytes(bundle_sha256, pin_len) }) {
            Ok(_) => Status::Ok, Err(status) => status,
        }
    }) as i32
}

/// Calls EXACTLY vertex_execution_kernel::evaluate_json with the pinned native
/// ContractAuthority. A kernel rejection remains a successful JSON response;
/// transport/authority/encoding failures return only bounded status codes.
///
/// # Safety
/// All nonempty inputs must be readable and immutable for the entire call;
/// output must be writable capacity bytes; written must be an aligned writable
/// size_t. ALL regions must be pairwise disjoint and live until return. No other
/// thread may access output/written or mutate inputs during this invocation.
/// The caller initializes written to zero before calling; invalid pointers or
/// bounds leave it untouched. No callback, pointer or allocation is retained.
#[no_mangle]
pub unsafe extern "C" fn vertex_kernel_bridge_evaluate_v1(
    bundle: *const u8, bundle_len: usize, bundle_sha256: *const u8, pin_len: usize,
    input: *const u8, input_len: usize, output: *mut u8, capacity: usize, written: *mut usize,
) -> i32 {
    if bundle_len > MAX_BUNDLE_BYTES || input_len > MAX_INPUT_BYTES { return Status::InputTooLarge as i32; }
    if capacity > MAX_OUTPUT_BYTES || pin_len != 64 { return Status::InvalidArgument as i32; }
    let (Some(b), Some(p), Some(i), Some(o)) = (
        region(bundle as usize, bundle_len), region(bundle_sha256 as usize, pin_len),
        region(input as usize, input_len), output_regions(output, capacity, written),
    ) else { return Status::InvalidArgument as i32; };
    if !disjoint(&[b, p, i, o[0], o[1]]) { return Status::InvalidArgument as i32; }
    // SAFETY: checked aligned/disjoint output length; caller guarantees validity.
    unsafe { ptr::write(written, 0); }
    protect(|| {
        // SAFETY: bounded, disjoint inputs borrow caller storage for this call.
        let loaded = match authority(unsafe { bytes(bundle, bundle_len) }, unsafe { bytes(bundle_sha256, pin_len) }) {
            Ok(loaded) => loaded, Err(status) => return status,
        };
        let value = match vertex_execution_kernel::evaluate_json(&loaded, unsafe { bytes(input, input_len) }) {
            Ok(value) => value, Err(_) => return Status::KernelFailure,
        };
        if value.len() > MAX_OUTPUT_BYTES { return Status::OutputTooLarge; }
        // SAFETY: all output obligations established before borrowing inputs.
        unsafe { copy_result(&value, output, capacity, written) }
    }) as i32
}

#[cfg(test)]
#[path = "../tests/ffi_regressions.rs"]
mod ffi_regressions;
