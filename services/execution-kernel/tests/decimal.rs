use std::str::FromStr;
use vertex_execution_kernel::decimal::Decimal;

fn d(s: &str) -> Decimal { Decimal::from_str(s).unwrap() }

#[test]
fn decimal_is_exact_and_never_rounds_a_risk_reduction() {
    assert_eq!(d("0.1").checked_add(d("0.2")).unwrap(), d("0.3"));
    assert_eq!(d("12.345").ceil_to(d("0.01")).unwrap(), d("12.35"));
    assert_eq!(d("12.34").ceil_to(d("0.01")).unwrap(), d("12.34"));
    assert!(d("0.000000000000000001").checked_mul(d("0.1")).is_err());
    assert!(d("100000000000000000000000000000").checked_mul(d("100000000000000000000000000000")).is_err());
}

#[test]
fn canonical_wire_domain_and_tick_alignment_are_fail_closed() {
    for invalid in ["", "+1", "01", "-0", "1.0", "1e2", "NaN", ".1", "1.", "0.0000000000000000001"] {
        assert!(Decimal::from_str(invalid).is_err(), "accepted {invalid}");
    }
    assert!(d("1.25").is_multiple_of(d("0.05")).unwrap());
    assert!(!d("1.26").is_multiple_of(d("0.05")).unwrap());
    assert!(d("1").is_multiple_of(d("0")).is_err());
    assert!(serde_json::from_str::<Decimal>("1.2").is_err());
    assert_eq!(serde_json::to_string(&d("-0.000000000000000001")).unwrap(), "\"-0.000000000000000001\"");
}

#[test]
fn comparison_does_not_overflow_to_a_smaller_risk() {
    assert!(d("999999999999999999999999999999") > d("0.000000000000000001"));
    assert!(d("-999999999999999999999999999999") < d("-0.000000000000000001"));
    assert_eq!(d("1.25").checked_sub(d("1.25")).unwrap(), Decimal::ZERO);
}
