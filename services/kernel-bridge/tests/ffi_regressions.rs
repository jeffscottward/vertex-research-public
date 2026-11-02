//! Authored, not executed. Final acceptance must supply an independently
//! reviewed real authority fixture; synthetic hash placeholders are not releases.
use super::*;

#[test]
fn identity_has_exact_reviewed_fields_and_no_trailing_nul() {
    let mut output = vec![0xAA; MAX_IDENTITY_BYTES];
    let mut written = 0;
    let status = unsafe { vertex_kernel_bridge_identity_v1(output.as_mut_ptr(), output.len(), &mut written) };
    assert_eq!(status, Status::Ok as i32);
    assert_eq!(&output[..written], IDENTITY.as_bytes());
    assert_eq!(output[written], 0xAA);
    let value: serde_json::Value = serde_json::from_slice(&output[..written]).unwrap();
    assert_eq!(value["build_id"], env!("VERTEX_KERNEL_BUILD_ID"));
    assert_eq!(value["contract_source_sha256"], CONTRACT_SOURCE);
    assert_eq!(value["kernel_source_sha256"], env!("VERTEX_KERNEL_SOURCE_SHA256"));
}

#[test]
fn short_output_reports_exact_length_without_partial_copy() {
    let mut output = [0xCC; 2];
    let mut written = 0;
    let status = unsafe { vertex_kernel_bridge_identity_v1(output.as_mut_ptr(), output.len(), &mut written) };
    assert_eq!(status, Status::OutputTooSmall as i32);
    assert_eq!(written, IDENTITY.len());
    assert_eq!(output, [0xCC; 2]);
    let status = unsafe { vertex_kernel_bridge_identity_v1(ptr::null_mut(), 0, &mut written) };
    assert_eq!(status, Status::OutputTooSmall as i32);
    assert_eq!(written, IDENTITY.len());
}

#[test]
fn null_overlap_alignment_and_arithmetic_fail_before_dereference() {
    let mut written = 0usize;
    assert_eq!(unsafe { vertex_kernel_bridge_identity_v1(ptr::null_mut(), 1, &mut written) }, Status::InvalidArgument as i32);
    assert_eq!(unsafe { vertex_kernel_bridge_identity_v1(ptr::null_mut(), 0, ptr::null_mut()) }, Status::InvalidArgument as i32);
    let same = &mut written as *mut usize;
    assert_eq!(unsafe { vertex_kernel_bridge_identity_v1(same.cast(), mem::size_of::<usize>(), same) }, Status::InvalidArgument as i32);
    assert_eq!(region(usize::MAX - 1, 4), None);
    assert_eq!(region(1, usize::MAX), None);
    assert!(!disjoint(&[(10, 15), (14, 20)]));
    assert!(disjoint(&[(10, 15), (15, 20), (0, 0)]));
    assert!(output_regions(ptr::null_mut(), 0, 1usize as *mut usize).is_none());
}

#[test]
fn oversized_foreign_lengths_never_dereference_input() {
    let status = unsafe { vertex_kernel_bridge_evaluate_v1(
        ptr::null(), 0, ptr::null(), 64, ptr::null(), MAX_INPUT_BYTES + 1,
        ptr::null_mut(), 0, ptr::null_mut(),
    ) };
    assert_eq!(status, Status::InputTooLarge as i32);
    assert_eq!(unsafe { vertex_kernel_bridge_validate_bundle_v1(ptr::null(), MAX_BUNDLE_BYTES + 1, ptr::null(), 64) }, Status::InputTooLarge as i32);
}

#[test]
fn invalid_bundle_never_becomes_permissive_authority() {
    let bundle = b"{}";
    let pin = [b'0'; 64]; // Deliberately invalid test pin, never release identity.
    assert_eq!(unsafe { vertex_kernel_bridge_validate_bundle_v1(bundle.as_ptr(), bundle.len(), pin.as_ptr(), pin.len()) }, Status::AuthorityUnavailable as i32);
    let mut output = [0xEE; 32];
    let mut written = 7;
    assert_eq!(unsafe { vertex_kernel_bridge_evaluate_v1(
        bundle.as_ptr(), bundle.len(), pin.as_ptr(), pin.len(), bundle.as_ptr(), bundle.len(),
        output.as_mut_ptr(), output.len(), &mut written,
    ) }, Status::InvalidArgument as i32); // Explicit same storage, never allocator-dependent.
    // Separately owned arrays remove overlap and expose only authority failure.
    let input = Vec::from(&b"{}"[..]);
    assert_eq!(unsafe { vertex_kernel_bridge_evaluate_v1(
        bundle.as_ptr(), bundle.len(), pin.as_ptr(), pin.len(), input.as_ptr(), input.len(),
        output.as_mut_ptr(), output.len(), &mut written,
    ) }, Status::AuthorityUnavailable as i32);
    assert_eq!(written, 0);
    assert_eq!(output, [0xEE; 32]);
}

#[test]
fn unwinding_is_mapped_to_bounded_status() {
    assert_eq!(protect(|| panic!("synthetic-regression")), Status::Panic);
}

#[test]
fn exact_existing_kernel_parity_with_reviewed_authority() {
    // No generated permissive fixture and no skip: release acceptance supplies
    // the actual frozen bundle and independent reviewed digest explicitly.
    let path = std::env::var("VERTEX_KERNEL_TEST_BUNDLE").expect("reviewed contract fixture required");
    let pin = std::env::var("VERTEX_KERNEL_TEST_BUNDLE_SHA256").expect("independent reviewed fixture pin required");
    let bundle = std::fs::read(path).unwrap();
    let direct = ContractAuthority::from_bundle(&bundle, &pin).unwrap();
    assert_eq!(unsafe { vertex_kernel_bridge_validate_bundle_v1(bundle.as_ptr(), bundle.len(), pin.as_ptr(), pin.len()) }, Status::Ok as i32);
    for input in [&b"{}"[..], &b"not-json"[..], &b"{\"a\":1,\"a\":2}"[..], &b" {}"[..], &b""[..]] {
        let expected = vertex_execution_kernel::evaluate_json(&direct, input).unwrap();
        let mut output = vec![0xCC; MAX_OUTPUT_BYTES];
        let mut written = 0;
        let status = unsafe { vertex_kernel_bridge_evaluate_v1(
            bundle.as_ptr(), bundle.len(), pin.as_ptr(), pin.len(), input.as_ptr(), input.len(),
            output.as_mut_ptr(), output.len(), &mut written,
        ) };
        assert_eq!(status, Status::Ok as i32);
        assert_eq!(&output[..written], expected);
        let envelope: serde_json::Value = serde_json::from_slice(&expected).unwrap();
        assert_eq!(envelope["status"], "rejected");
        assert_eq!(envelope["live_authorization"], false);
        assert_eq!(envelope["broker_submission_allowed"], false);
        assert_eq!(output[written], 0xCC);
    }
}
