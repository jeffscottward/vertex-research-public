use vertex_execution_kernel::{calendar::*, KernelError};

fn instant(date: &str, minute: u16, offset: i32) -> Ns {
    CivilDate::parse(date).unwrap().instant(minute, offset).unwrap()
}
fn calendar(date: &str, offset: i32, close: u16) -> ExchangeCalendar {
    let date = CivilDate::parse(date).unwrap();
    let start = date.instant(0, offset).unwrap();
    ExchangeCalendar {
        calendar_id: "XNYS-fixture".into(), version: "fixture-1".into(), timezone: "America/New_York".into(), tzdb_version: "2026a-fixture".into(),
        intervals: vec![OffsetInterval { start_ns: start, end_ns: Ns(start.0 + DAY_NS), offset_seconds: offset }],
        sessions: vec![Session { date, tradable: true, open_minute: 570, close_minute: close, entry_cutoff_minute: close-15 }],
    }
}

#[test]
fn source_fixed_sixteen_filter_is_replaced_by_explicit_early_close() {
    // evidence-0dte /gates/1, Gamma provider.py:290-320. Synthetic schedule.
    let c = calendar("2026-11-27", -18000, 780);
    assert!(c.entry(instant("2026-11-27",764,-18000)).is_ok());
    assert_eq!(c.entry(instant("2026-11-27",765,-18000)).unwrap_err(), KernelError::SessionClosed);
    assert!(c.entry(instant("2026-11-27",900,-18000)).is_err());
}

#[test]
fn dst_offsets_change_utc_cutoff_without_changing_exchange_wall_time() {
    let winter = calendar("2026-03-06", -18000, 960);
    let summer = calendar("2026-03-09", -14400, 960);
    assert!(winter.entry(instant("2026-03-06",944,-18000)).is_ok());
    assert!(summer.entry(instant("2026-03-09",944,-14400)).is_ok());
    assert_eq!(instant("2026-03-09",945,-14400).0 % DAY_NS, 19*3600*SECOND_NS+45*60*SECOND_NS);
    assert_eq!(instant("2026-03-06",945,-18000).0 % DAY_NS, 20*3600*SECOND_NS+45*60*SECOND_NS);
}

#[test]
fn ambiguous_local_time_requires_unique_timezone_proof() {
    let date = CivilDate::parse("2026-11-01").unwrap();
    let split = instant("2026-11-01",120,-14400);
    let c = ExchangeCalendar {
        calendar_id: "overnight-fixture".into(), version: "1".into(), timezone: "America/New_York".into(), tzdb_version: "fixture".into(),
        intervals: vec![OffsetInterval { start_ns: Ns(split.0-6*3600*SECOND_NS), end_ns: split, offset_seconds: -14400 },
            OffsetInterval { start_ns: split, end_ns: Ns(split.0+24*3600*SECOND_NS), offset_seconds: -18000 }],
        sessions: vec![Session { date, tradable: true, open_minute: 60, entry_cutoff_minute: 90, close_minute: 180 }],
    };
    assert_eq!(c.local_instant(date,90).unwrap_err(), KernelError::CalendarProof);
}

#[test]
fn utc_date_is_not_exchange_date_and_holiday_is_not_empty_portfolio() {
    let mut c = calendar("2026-07-02", -14400, 960);
    let evening = instant("2026-07-02",1260,-14400);
    assert_eq!(c.local_date(evening).unwrap(), CivilDate::parse("2026-07-02").unwrap());
    c.sessions[0].tradable = false;
    assert_eq!(c.entry(instant("2026-07-02",600,-14400)).unwrap_err(), KernelError::SessionClosed);
    assert!(CivilDate::parse("2026-02-29").is_err());
    assert!(CivilDate::parse("2024-02-29").is_ok());
}
