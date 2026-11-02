use vertex_contracts::ContractAuthority;
use vertex_execution_kernel::{calendar::Ns, decimal::Decimal, model::KernelRequest, KernelError};

#[test]
fn unavailable_native_bundle_is_not_replaced_by_handwritten_public_validation() {
    assert!(ContractAuthority::from_bundle(b"{}", &"0".repeat(64)).is_err());
    assert_eq!(KernelError::Contract.code(), "public-contract-invalid");
}

#[test]
fn epoch_nanoseconds_and_decimals_never_accept_json_floats() {
    for input in ["0", "1.5", "-1", "\"01\"", "\"-1\"", "\"1e9\"", "\"170141183460469231731687303715884105728\""] {
        assert!(serde_json::from_str::<Ns>(input).is_err());
    }
    assert_eq!(serde_json::from_str::<Ns>("\"1758556800000000001\"").unwrap(),Ns(1758556800000000001));
    assert!(serde_json::from_str::<Decimal>("0.1").is_err());
}

#[test]
fn incomplete_private_requests_do_not_create_policy_or_account_defaults() {
    for payload in ["{}", "{\"request_version\":\"vertex.execution-kernel.v1\",\"operation\":\"evaluate\"}",
        "{\"request_version\":\"vertex.execution-kernel.v1\",\"mode\":\"PAPER-SIMULATION\",\"now_ns\":\"1\",\"portfolioSnapshot\":{}}"] {
        assert!(serde_json::from_str::<KernelRequest>(payload).is_err());
    }
}
