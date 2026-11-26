"""Unit tests for smart-money PR 7 backtest engine, signals, DSR, and study documents.

Synthetic fixtures only (public repository). Pure stdlib + services/research modules.
"""
from __future__ import annotations

import csv
import io
import json
import math
import runpy
import statistics
import sys
import zipfile
from ast import Import, ImportFrom, parse, walk
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from strategies.trend_trio.study import moments
import strategies.smart_money as smart_money_package
from strategies.smart_money import (
    CongressPurchase,
    DailyBar,
    Form4Purchase,
    MarketPremiumRow,
    PortfolioConfig,
    SignalEvent,
    build_signal1_variants,
    build_signal2_variants,
    build_signal3_events,
    compute_study_dsr,
    dedupe_congress_purchases,
    evaluate_verdict,
    normalize_congress_member,
    normalize_security_title,
    parse_sec_form4_zip,
    simulate_event_portfolio,
)
from strategies.smart_money.__main__ import (
    _add_years,
    _congress_coverage_gaps,
    _spy_benchmark_stats,
    _universe_note,
    load_bars_dir,
    load_congress_jsonl,
    load_form4_jsonl,
    load_premium_jsonl,
    run_all_studies,
)
from strategies.smart_money import document as document_module
from strategies.smart_money import engine as engine_module
from strategies.smart_money.__main__ import main as cli_main
from strategies.smart_money.document import (
    MAX_BATCH_BYTES,
    MAX_DOC_BYTES,
    NOTES_MAX_CHARS,
    STUDY_IDS,
    build_study_document,
    make_run_entry,
    write_study_bundle,
)
from strategies.smart_money.engine import (
    PeriodMetrics,
    PortfolioResult,
    TrialRecord,
    _monthly_equity,
    check_point_in_time_liquidity,
    raw_closes_from_splits,
)
from strategies.smart_money.signals import (
    _apply_price_confirmation,
    _clean_ticker,
    _parse_float,
    _parse_sec_date,
    _to_alert_bars,
)


def _make_trading_days(start: date, count: int) -> list[date]:
    days: list[date] = []
    cur = start
    while len(days) < count:
        if cur.weekday() < 5:
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _make_bars(
    days: list[date],
    *,
    start_price: float = 100.0,
    daily_return: float = 0.001,
    volume: float = 2_000_000.0,
    raw_factor: float = 1.0,
) -> list[DailyBar]:
    """Bars whose as-printed close is ``raw_factor`` times the split-restated close."""
    bars: list[DailyBar] = []
    price = start_price
    for d in days:
        op = price
        cl = op * (1.0 + daily_return)
        hi = max(op, cl) * 1.005
        lo = min(op, cl) * 0.995
        bars.append(DailyBar(d, op, hi, lo, cl, cl, volume, cl * raw_factor))
        price = cl
    return bars


def test_normalize_security_title_filters_common_ordinary_only() -> None:
    assert normalize_security_title("Common Stock") == "common"
    assert normalize_security_title("Class A Ordinary Shares") == "ordinary"
    assert normalize_security_title("Preferred Common Equivalent") is None
    assert normalize_security_title("Restricted Stock Units (Common)") is None
    assert normalize_security_title("Common Stock Warrant") is None
    assert normalize_security_title("American Depositary Shares (ADS)") is None
    assert normalize_security_title("") is None
    assert normalize_security_title(None) is None


def test_parse_sec_form4_zip_streams_and_counts_joint_filers_once(tmp_path: Path) -> None:
    zip_path = tmp_path / "2024q1_form345.zip"
    sub_rows = [
        {
            "ACCESSION_NUMBER": "0001-24-000001",
            "FILING_DATE": "15-JAN-2024",
            "DOCUMENT_TYPE": "4",
            "ISSUERTRADINGSYMBOL": "ACME",
            "ISSUERCIK": "0000123456",
            "AFF10B5ONE": "0",
        },
        {
            "ACCESSION_NUMBER": "0001-24-000002",
            "FILING_DATE": "16-JAN-2024",
            "DOCUMENT_TYPE": "4/A",  # amendment excluded
            "ISSUERTRADINGSYMBOL": "ACME",
            "ISSUERCIK": "0000123456",
            "AFF10B5ONE": "0",
        },
        {
            "ACCESSION_NUMBER": "0001-24-000003",
            "FILING_DATE": "17-JAN-2024",
            "DOCUMENT_TYPE": "4",
            "ISSUERTRADINGSYMBOL": "ACME",
            "ISSUERCIK": "0000123456",
            "AFF10B5ONE": "1",
        },
    ]
    own_rows = [
        # Two joint filers on same accession -> single canonical owner group
        {"ACCESSION_NUMBER": "0001-24-000001", "RPTOWNERCIK": "0000900002", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
        {"ACCESSION_NUMBER": "0001-24-000001", "RPTOWNERCIK": "0000900001", "RPTOWNER_RELATIONSHIP": "Officer", "RPTOWNER_TITLE": "Chief Executive Officer"},
        {"ACCESSION_NUMBER": "0001-24-000003", "RPTOWNERCIK": "0000900003", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": "Director"},
    ]
    tx_rows = [
        {
            "ACCESSION_NUMBER": "0001-24-000001",
            "TRANS_DATE": "12-JAN-2024",
            "TRANS_CODE": "P",
            "TRANS_SHARES": "2000",
            "TRANS_PRICEPERSHARE": "100.0",
            "SECURITY_TITLE": "Common Stock",
            "SHRS_OWND_FOLLOWING_TRANS": "12000",
        },
        {
            "ACCESSION_NUMBER": "0001-24-000001",
            "TRANS_DATE": "12-JAN-2024",
            "TRANS_CODE": "S",  # sale excluded
            "TRANS_SHARES": "1000",
            "TRANS_PRICEPERSHARE": "100.0",
            "SECURITY_TITLE": "Common Stock",
            "SHRS_OWND_FOLLOWING_TRANS": "11000",
        },
        {
            "ACCESSION_NUMBER": "0001-24-000003",
            "TRANS_DATE": "16-JAN-2024",
            "TRANS_CODE": "P",
            "TRANS_SHARES": "500",
            "TRANS_PRICEPERSHARE": "102.0",
            "SECURITY_TITLE": "Ordinary Shares",
            "SHRS_OWND_FOLLOWING_TRANS": "500",
        },
    ]

    def _tsv(rows: list[dict[str, str]]) -> str:
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue()

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("SUBMISSION.tsv", _tsv(sub_rows))
        zf.writestr("REPORTINGOWNER.tsv", _tsv(own_rows))
        zf.writestr("NONDERIV_TRANS.tsv", _tsv(tx_rows))

    parsed = parse_sec_form4_zip(zip_path)
    assert len(parsed) == 2
    assert parsed[0].owner_group_key == "900001|900002"
    assert parsed[0].holding_before == 10_000.0
    assert parsed[0].is_10b5_1 is False
    assert parsed[1].security == "ordinary"
    assert parsed[1].is_10b5_1 is True


def test_signal1_cluster_price_typo_guard_and_alert_templates_adapter() -> None:
    days = _make_trading_days(date(2024, 1, 2), 90)
    # Rising stock above SMA50 so confirmation-baseline triggers after filing_date.
    bars = {"ACME": _make_bars(days, start_price=50.0, daily_return=0.004, volume=2_000_000.0)}
    f_day1 = days[55]
    f_day2 = days[57]
    f_day3 = days[58]
    ref_close = bars["ACME"][55].close

    purchases = [
        Form4Purchase("acc1", f_day1, days[54], "123", "ACME", "owner1", "Officer CEO", "common", 3000, ref_close, 10000),
        Form4Purchase("acc2", f_day2, days[56], "123", "ACME", "owner2", "Director", "common", 2000, ref_close * 1.01, 5000),
        Form4Purchase("acc3", f_day3, days[57], "123", "ACME", "owner3", "Director", "common", 1000, ref_close * 1.02, 2000),
        # Price typo (> 4x filing close) must be rejected by price-sanity guard:
        Form4Purchase("acc4", f_day3, days[57], "123", "ACME", "owner4", "Director", "common", 10, ref_close * 50.0, 100),
    ]
    variants, diag = build_signal1_variants(purchases, bars)
    assert diag["price_sanity_rejected"] == 1
    assert diag["cleaned_purchases"] == 3
    assert len(variants["cluster-3p-10d"]) == 1
    assert variants["cluster-3p-10d"][0].trigger_day == f_day3
    assert len(variants["cluster-3p-10d-100k"]) == 1
    assert len(variants["confirmation-baseline"]) >= 1
    # Confirmation must occur strictly after filing_date (at least 1 completed session).
    assert variants["confirmation-baseline"][0].trigger_day > f_day1


def test_raw_closes_undo_only_later_splits() -> None:
    days = [date(2021, 7, 19), date(2021, 7, 20), date(2024, 6, 7), date(2024, 6, 10)]
    restated = [18.75, 18.6, 120.0, 121.0]
    splits = [(date(2024, 6, 10), 10.0), (date(2021, 7, 20), 4.0)]  # unordered on purpose
    # Before both splits: x40. On the first ex-day and until the second: x10. On the last ex-day: x1.
    assert raw_closes_from_splits(days, restated, splits) == [750.0, 186.0, 1200.0, 121.0]
    # A 1-for-10 reverse split restates earlier closes upwards; the as-printed close was lower.
    assert raw_closes_from_splits([date(2023, 1, 3)], [50.0], [(date(2023, 6, 1), 0.1)]) == [5.0]
    assert raw_closes_from_splits(days, restated, []) == restated
    with pytest.raises(ValueError, match="same length"):
        raw_closes_from_splits(days, restated[:2], [])
    with pytest.raises(ValueError, match="ratios must be > 0"):
        raw_closes_from_splits(days, restated, [(date(2022, 1, 3), 0.0)])


def test_price_filters_use_the_as_printed_close_not_the_split_restated_close() -> None:
    days = _make_trading_days(date(2024, 1, 2), 90)
    # LATER split 40-for-1 after the window: restated close ~2, as-printed close ~80 -> liquid.
    split_later = _make_bars(days, start_price=2.0, daily_return=0.0, volume=10_000_000.0, raw_factor=40.0)
    # LATER reverse split 1-for-20: restated close ~40, as-printed close ~2 -> below the $5 floor.
    reverse_later = _make_bars(days, start_price=40.0, daily_return=0.0, volume=1_000_000.0, raw_factor=0.05)
    for bars, expected in ((split_later, True), (reverse_later, False)):
        index = {b.day: i for i, b in enumerate(bars)}
        assert check_point_in_time_liquidity(bars, index, days[60]) is expected

    f_day = days[60]
    purchases = [
        # Reported at the as-printed price (~80): kept, although it is 40x the restated close.
        Form4Purchase("acc1", f_day, days[59], "1", "SPLT", "owner1", "Director", "common", 100, 80.0, 0),
        # Reported at the restated price (~2) would be 0.025x the as-printed close: rejected.
        Form4Purchase("acc2", f_day, days[59], "1", "SPLT", "owner2", "Director", "common", 100, 2.0, 0),
        # No bar on or before the filing day, and a ticker without bars: counted apart.
        Form4Purchase("acc3", date(2023, 12, 1), None, "1", "SPLT", "owner3", "Director", "common", 100, 80.0, 0),
        Form4Purchase("acc4", f_day, days[59], "2", "GONE", "owner4", "Director", "common", 100, 10.0, 0),
    ]
    _variants, diag = build_signal1_variants(purchases, {"SPLT": split_later})
    assert diag["cleaned_purchases"] == 1
    assert diag["price_sanity_rejected"] == 1
    assert diag["no_bar_by_filing_day"] == 1
    assert diag["ticker_without_bars"] == 1


def test_congress_normalization_and_first_filing_null_safe_dedupe() -> None:
    assert normalize_congress_member("Hon. Jane A. Doe Jr.") == "jane a doe"
    assert normalize_congress_member("Rep. JANE A DOE") == "jane a doe"

    rows = [
        # Amendment filed later must be dropped in favor of original filing.
        CongressPurchase("senate", "uuid-2", "Sen. John Smith", "self", "NVDA", "purchase", date(2024, 5, 1), date(2024, 5, 20), 50001, 100000, amends=True),
        CongressPurchase("senate", "uuid-1", "John Smith", "self", "NVDA", "purchase", date(2024, 5, 1), date(2024, 5, 10), 50001, 100000, amends=False),
        # Same member + date, different holder (spouse) must NOT collapse.
        CongressPurchase("senate", "uuid-3", "John Smith", "spouse", "NVDA", "purchase", date(2024, 5, 1), date(2024, 5, 10), 15001, 50000, amends=False),
        # Two distinct filings with null transaction_date must NOT collapse (keyed by doc_id).
        CongressPurchase("house", "20010001", "Hon. Alice Roe", None, "MSFT", "purchase", None, date(2024, 6, 1), 1001, 15000),
        CongressPurchase("house", "20010002", "Hon. Alice Roe", None, "MSFT", "purchase", None, date(2024, 6, 5), 1001, 15000),
    ]
    deduped, removed = dedupe_congress_purchases(rows)
    assert removed == 1
    assert len(deduped) == 4
    nvda_self = [r for r in deduped if r.ticker == "NVDA" and r.holder == "self"]
    assert len(nvda_self) == 1
    assert nvda_self[0].filed_on == date(2024, 5, 10)

    variants, _ = build_signal2_variants(rows)
    assert len(variants["all-buys"]) == 4
    assert len(variants["large-50k"]) == 1
    assert len(variants["fast-filed-15d"]) == 2  # self + spouse NVDA (9d delay); null tx_date excluded


def test_signal3_large_bullish_premium_filtering_and_ranking() -> None:
    days = _make_trading_days(date(2025, 10, 1), 30)
    bars = {
        "AAA": _make_bars(days, start_price=100.0, volume=500_000.0),  # $50M/day liquid
        "BBB": _make_bars(days, start_price=100.0, volume=500_000.0),
        "PENNY": _make_bars(days, start_price=2.0, volume=500_000.0),  # < $5 illiquid
    }
    sday = days[25]
    rows = [
        MarketPremiumRow(sday, "AAA", 1_000_000, 100_000, 5, "complete"),  # net 900k, 90.9% bullish
        MarketPremiumRow(sday, "BBB", 600_000, 500_000, 5, "complete"),    # 54.5% bullish < 70% -> excluded
        MarketPremiumRow(sday, "PENNY", 900_000, 50_000, 5, "complete"),   # illiquid -> excluded
        MarketPremiumRow(sday, "AAA", 2_000_000, 0, 10, "partial"),        # non-complete -> excluded
    ]
    events, diag = build_signal3_events(rows, bars)
    assert diag["complete_sessions"] == 1
    assert diag["non_complete_rows_skipped"] == 1
    assert len(events) == 1
    assert events[0].symbol == "AAA"
    assert events[0].trigger_day == sday


def test_portfolio_zero_lookahead_costs_overlap_and_capacity() -> None:
    days = _make_trading_days(date(2024, 1, 2), 40)
    # SPY flat (0% daily), AAA rises +1%/day open-to-close on entry day, flat otherwise.
    spy = [DailyBar(d, 100.0, 101.0, 99.0, 100.0, 100.0, 10_000_000.0, 100.0) for d in days]
    aaa = [DailyBar(d, 100.0, 102.0, 99.0, 101.0, 101.0, 1_000_000.0, 101.0) for d in days]
    # Note: close is 101, open is 100 -> entry day open-to-close is +1.0%, next days close-to-close is 0%.
    events = [
        SignalEvent("AAA", days[20], 500_000.0),
        # Duplicate inside holding window (days[21] entry + 5 days) -> skipped_overlap
        SignalEvent("AAA", days[21], 600_000.0),
    ]
    res = simulate_event_portfolio(
        events,
        {"AAA": aaa},
        spy,
        PortfolioConfig(holding_days=5, max_slots=10, cost_bps=10.0),
    )
    assert res.whole.trades == 1
    assert res.skipped_overlap == 1
    pos = res.positions[0]
    # Trigger on days[20] -> entry strictly next trading day days[21], exit days[25].
    assert pos.entry_day == days[21]
    assert pos.exit_day == days[25]
    # Gross excess = +1% on entry day, 0% next 4 days; net subtracts 10 bps entry and 10 bps exit.
    assert math.isclose(pos.gross_excess_return, 0.01, abs_tol=1e-6)
    assert math.isclose(pos.net_excess_return, (1.0 + 0.009) * (1.0 - 0.001) - 1.0, abs_tol=1e-6)


def test_dsr_uses_per_observation_units_and_verdict_has_no_dead_zone() -> None:
    # Strongly positive synthetic daily OOS returns
    rets = [0.004 if i % 3 != 0 else -0.001 for i in range(520)]
    dsr = compute_study_dsr(rets, [0.15, 0.05, 0.02, -0.01, 0.01, 0.0], n_trials=6)
    assert dsr is not None
    assert dsr.probability > 0.99

    # Signal 3 (N = 1) returns None for DSR and verdict needs-more-data when sessions < 504
    assert compute_study_dsr(rets[:250], [0.05], n_trials=1) is None
    v1, _ = evaluate_verdict(oos_sessions=284, oos_events=80, oos_sharpe=1.2, dsr_probability=None, stress_oos_sharpe=None, n_trials=1)
    assert v1 == "needs-more-data"

    # Full 24m OOS with 50 events (< 100): must be no-edge (zero dead zone!)
    v2, r2 = evaluate_verdict(oos_sessions=504, oos_events=50, oos_sharpe=1.5, dsr_probability=0.99, stress_oos_sharpe=1.2, n_trials=12)
    assert v2 == "no-edge"
    assert "OOS events 50 < 100" in r2

    # Full 24m OOS passing all bars -> edge
    v3, _ = evaluate_verdict(oos_sessions=504, oos_events=120, oos_sharpe=1.2, dsr_probability=0.97, stress_oos_sharpe=0.8, n_trials=12)
    assert v3 == "edge"

    # A missing 20 bps stress result fails closed, whatever the other bars say.
    v5, r5 = evaluate_verdict(oos_sessions=504, oos_events=120, oos_sharpe=1.2, dsr_probability=0.97, stress_oos_sharpe=None, n_trials=12)
    assert v5 == "no-edge"
    assert "was not computed" in r5

    # Fails 20 bps stress test -> no-edge
    v4, r4 = evaluate_verdict(oos_sessions=504, oos_events=120, oos_sharpe=0.3, dsr_probability=0.96, stress_oos_sharpe=-0.05, n_trials=12)
    assert v4 == "no-edge"
    assert "20 bps stress" in r4


def test_end_to_end_cli_emits_three_strict_study_documents(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    bars_dir.mkdir(parents=True)
    out_dir = tmp_path / "out"

    # Generate 2,600 weekdays (~10+ years) for SPY and ACME
    days = _make_trading_days(date(2016, 1, 4), 2650)
    spy_bars = _make_bars(days, start_price=200.0, daily_return=0.0002, volume=50_000_000.0)
    acme_bars = _make_bars(days, start_price=50.0, daily_return=0.0004, volume=2_000_000.0)

    def _write_csv(path: Path, seq: list[DailyBar]) -> None:
        with path.open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["date", "open", "high", "low", "close", "adj_close", "volume", "raw_close"])
            for b in seq:
                w.writerow([b.day.isoformat(), b.open, b.high, b.low, b.close, b.adj_close, b.volume, b.raw_close])

    _write_csv(bars_dir / "SPY.csv", spy_bars)
    _write_csv(bars_dir / "ACME.csv", acme_bars)

    # Write synthetic Form 4, Congress, and Market Premium JSONL files
    form4 = [
        {
            "accession_number": f"acc-{i}",
            "filing_date": days[2200 + i].isoformat(),
            "transaction_date": days[2199 + i].isoformat(),
            "issuer_cik": "12345",
            "ticker": "ACME",
            "owner_group_key": f"own-{i}",
            "role_text": "Director",
            "security": "common",
            "shares": 2000,
            "price": acme_bars[2200 + i].close,
            "holding_before": 5000,
            "is_10b5_1": False,
        }
        for i in range(3)
    ]
    (data_dir / "form4_purchases.jsonl").write_text("\n".join(json.dumps(r) for r in form4) + "\n", encoding="utf-8")

    congress = [
        {
            "chamber": "house",
            "doc_id": "20010001",
            "member": "Hon. Jane Doe",
            "holder": "self",
            "ticker": "ACME",
            "transaction_type": "purchase",
            "transaction_date": days[2350].isoformat(),
            "filed_on": days[2355].isoformat(),
            "amount_low": 50001,
            "amount_high": 100000,
            "amends": False,
        }
    ]
    (data_dir / "congress_trades.jsonl").write_text("\n".join(json.dumps(r) for r in congress) + "\n", encoding="utf-8")

    premium = [
        {
            "session_date": d.isoformat(),
            "ticker": "ACME",
            "bullish_premium": 800_000,
            "bearish_premium": 100_000,
            "trade_count": 5,
            "session_status": "complete",
        }
        for d in days[2540:2600]
    ]
    (data_dir / "market_premium.jsonl").write_text("\n".join(json.dumps(r) for r in premium) + "\n", encoding="utf-8")

    rc = cli_main([
        "--data-dir", str(data_dir),
        "--out-dir", str(out_dir),
        "--ran", "2026-11-23",
        "--commit", "8e1622224",
    ])
    assert rc == 0

    jsonl_lines = (out_dir / "studies.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(jsonl_lines) == 3
    docs = [json.loads(line) for line in jsonl_lines]
    ids = [d["id"] for d in docs]
    assert ids == [
        "insider-purchase-confirmation",
        "smart-money-congress-buys",
        "smart-money-large-bullish-premium",
    ]
    # Signal 3 must be needs-more-data with null OOS metrics
    s3 = docs[2]
    assert s3["verdict"] == "needs-more-data"
    assert s3["forms"][0]["runs"][0]["oosCagr"] is None
    assert s3["forms"][0]["runs"][0]["oosSharpe"] is None
    assert len(s3["equity"]) >= 2

    trials = json.loads((out_dir / "trials.json").read_text(encoding="utf-8"))
    # 12 + 12 + 1 = 25 total trials
    assert len(trials) == 25

    # Also verify run_all_studies rejects missing SPY
    with pytest.raises(ValueError, match="Missing SPY"):
        run_all_studies(data_dir=tmp_path / "empty", out_dir=out_dir, ran=date(2026, 11, 23), commit="8e1622224")


def test_bars_loader_requires_raw_close_and_runner_helpers(tmp_path: Path) -> None:
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    assert load_bars_dir(tmp_path / "absent") == {}
    (bars_dir / "OLD.csv").write_text(
        "date,open,high,low,close,adj_close,volume\n2024-01-02,1,1,1,1,1,1\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="no raw_close column"):
        load_bars_dir(bars_dir)
    (bars_dir / "OLD.csv").write_text(
        "date,open,high,low,close,adj_close,volume,raw_close\n"
        "2024-01-03,2,2,2,2,2,10,80\n"
        "2024-01-02,2,2,2,2,2,10,80\n"
        "not-a-date,2,2,2,2,2,10,80\n"
        "2024-01-04,2,2,2,2,2,10,0\n",
        encoding="utf-8",
    )
    loaded = load_bars_dir(bars_dir)["OLD"]
    assert [b.day for b in loaded] == [date(2024, 1, 2), date(2024, 1, 3)]
    assert loaded[0].raw_close == 80.0

    assert _add_years(date(2025, 10, 16), 2) == date(2027, 10, 16)
    assert _add_years(date(2024, 2, 29), 1) == date(2025, 2, 28)

    assert _universe_note({}, {"SPY": loaded}) == "Daily bars cover 1 tickers (SPY included)."
    note = _universe_note({"universe_requested": 600, "bars_not_found": ["AAA", "BBB"]}, {"SPY": loaded})
    assert "1 of the 600 pre-registered tickers" in note
    assert "no history for 2 of them" in note


def test_frozen_premium_baseline_refuses_a_full_holdout_window(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    bars_dir.mkdir(parents=True)
    days = _make_trading_days(date(2024, 1, 2), 560)
    for name, seq in (
        ("SPY", _make_bars(days, start_price=200.0, volume=50_000_000.0)),
        ("ACME", _make_bars(days, start_price=50.0, volume=2_000_000.0)),
    ):
        with (bars_dir / f"{name}.csv").open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["date", "open", "high", "low", "close", "adj_close", "volume", "raw_close"])
            for b in seq:
                w.writerow([b.day.isoformat(), b.open, b.high, b.low, b.close, b.adj_close, b.volume, b.raw_close])
    premium = [
        {"session_date": d.isoformat(), "ticker": "ACME", "bullish_premium": 800_000, "bearish_premium": 0, "trade_count": 5}
        for d in days[30:540]
    ]
    (data_dir / "market_premium.jsonl").write_text("\n".join(json.dumps(r) for r in premium) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="pre-register the out-of-sample split"):
        run_all_studies(data_dir=data_dir, out_dir=tmp_path / "out", ran=date(2026, 11, 25), commit="8e1622224")


def _write_form4_zip(
    zip_path: Path,
    members: dict[str, list[dict[str, str]]],
) -> None:
    """Write one TSV member per entry; the header is the union of the row keys."""
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name, rows in members.items():
            fieldnames = list(dict.fromkeys(key for row in rows for key in row))
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=fieldnames, delimiter="\t", restval="")
            writer.writeheader()
            writer.writerows(rows)
            zf.writestr(name, buf.getvalue())


def _write_bars_csv(path: Path, bars: list[DailyBar]) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["date", "open", "high", "low", "close", "adj_close", "volume", "raw_close"])
        for b in bars:
            writer.writerow([b.day.isoformat(), b.open, b.high, b.low, b.close, b.adj_close, b.volume, b.raw_close])


def _flat_bars(days: list[date], price: float = 100.0, volume: float = 1_000_000.0) -> list[DailyBar]:
    """Bars with open = high = low = close, so every daily return is exactly zero."""
    return [DailyBar(d, price, price, price, price, price, volume, price) for d in days]


_ZERO_METRICS = PeriodMetrics(0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, None)


def _portfolio_result(**overrides: Any) -> PortfolioResult:
    fields: dict[str, Any] = {
        "first_day": None,
        "last_day": None,
        "daily_days": (),
        "daily_excess_returns": (),
        "oos_days": (),
        "oos_excess_returns": (),
        "whole": _ZERO_METRICS,
        "oos": _ZERO_METRICS,
        "monthly_equity": (),
        "positions": (),
        "skipped_overlap": 0,
        "skipped_capacity": 0,
        "skipped_missing_bars": 0,
        "skipped_illiquid": 0,
        "truncated_exits": 0,
        "skipped_outside_window": 0,
    }
    fields.update(overrides)
    return PortfolioResult(**fields)


def _study_kwargs(result: PortfolioResult, **overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "study_id": "smart-money-congress-buys",
        "title": "Synthetic study",
        "source_label": "Synthetic source",
        "source_url": "https://example.com/source",
        "equity_label": "Excess return over the benchmark",
        "verdict": "no-edge",
        "verdict_reason": "Synthetic reason.",
        "ran": date(2026, 11, 25),
        "commit": "0123456789abcdef",
        "data_hash": "sha256:0123456789abcdef",
        "primary_result": result,
        "form_description": "Synthetic form description.",
        "form_label": "Underlying",
        "runs": [],
        "comparison": [],
        "sensitivity": [],
        "robustness": [],
        "rules": [],
        "gaps": [],
        "notes": "Synthetic notes.",
    }
    kwargs.update(overrides)
    return kwargs


def test_sec_field_parsers_reject_blank_and_malformed_values() -> None:
    assert _parse_sec_date("15-JAN-2024") == date(2024, 1, 15)
    assert _parse_sec_date(" 2024-01-15 ") == date(2024, 1, 15)
    assert _parse_sec_date("01/15/2024") == date(2024, 1, 15)
    assert _parse_sec_date(None) is None
    assert _parse_sec_date("") is None
    assert _parse_sec_date("   ") is None
    assert _parse_sec_date("15.01.2024") is None
    assert _parse_sec_date("31-FEB-2024") is None

    assert _parse_float(" $1,234.50 ") == 1234.5
    assert _parse_float("-3") == -3.0
    assert _parse_float(None) is None
    assert _parse_float("  ") is None
    assert _parse_float("$") is None
    assert _parse_float("twelve") is None
    assert _parse_float("nan") is None
    assert _parse_float("inf") is None
    assert _parse_float("-inf") is None

    assert _clean_ticker(" brk.b ") == "BRK.B"
    assert _clean_ticker("ACME") == "ACME"
    assert _clean_ticker(None) is None
    assert _clean_ticker("") is None
    for placeholder in ("none", "N/A", "na", "--", "-"):
        assert _clean_ticker(placeholder) is None
    assert _clean_ticker("1ACME") is None  # must start with a letter
    assert _clean_ticker("TOOLONGTICKER") is None  # more than 10 characters
    assert _clean_ticker("AC ME") is None

    # A title without the word "common" or "ordinary" is not plain equity.
    assert normalize_security_title("Class A Shares") is None
    assert normalize_security_title("   ") is None
    assert normalize_security_title("  COMMON stock  ") == "common"


def test_parse_sec_form4_zip_needs_all_three_members_and_valid_submissions(tmp_path: Path) -> None:
    sub_ok = {
        "ACCESSION_NUMBER": "A1",
        "FILING_DATE": "15-JAN-2024",
        "DOCUMENT_TYPE": "4",
        "ISSUERTRADINGSYMBOL": "ACME",
        "ISSUERCIK": "0000123456",
    }
    owner = {"ACCESSION_NUMBER": "A1", "RPTOWNERCIK": "0000900001", "RPTOWNER_RELATIONSHIP": "Director"}
    buy = {
        "ACCESSION_NUMBER": "A1",
        "TRANS_CODE": "P",
        "TRANS_SHARES": "100",
        "TRANS_PRICEPERSHARE": "10",
        "SECURITY_TITLE": "Common Stock",
    }

    # The transactions member is missing: nothing can be parsed.
    incomplete = tmp_path / "incomplete.zip"
    _write_form4_zip(incomplete, {"SUBMISSION.tsv": [sub_ok], "REPORTINGOWNER.tsv": [owner]})
    assert parse_sec_form4_zip(incomplete) == []

    # Every submission is unusable (no accession, bad date, placeholder ticker, wrong form type).
    rejected = tmp_path / "rejected.zip"
    _write_form4_zip(
        rejected,
        {
            "SUBMISSION.tsv": [
                {**sub_ok, "ACCESSION_NUMBER": "  "},
                {**sub_ok, "ACCESSION_NUMBER": "A2", "FILING_DATE": "not-a-date"},
                {**sub_ok, "ACCESSION_NUMBER": "A3", "ISSUERTRADINGSYMBOL": "N/A"},
                {**sub_ok, "ACCESSION_NUMBER": "A4", "DOCUMENT_TYPE": "5"},
            ],
            "REPORTINGOWNER.tsv": [owner],
            "NONDERIV_TRANS.tsv": [buy],
        },
    )
    assert parse_sec_form4_zip(rejected) == []

    # Control: the same owner and transaction rows parse once the submission is valid.
    # Member names match without regard to case or directory prefix.
    complete = tmp_path / "complete.zip"
    _write_form4_zip(
        complete,
        {
            "2024q1/submission.tsv": [sub_ok],
            "2024q1/reportingowner.tsv": [owner],
            "2024q1/nonderiv_trans.tsv": [buy],
        },
    )
    parsed = parse_sec_form4_zip(complete)
    assert len(parsed) == 1
    assert parsed[0].accession_number == "A1"
    assert parsed[0].ticker == "ACME"
    assert parsed[0].issuer_cik == "123456"
    assert parsed[0].filing_date == date(2024, 1, 15)


def test_parse_sec_form4_zip_skips_rows_with_missing_fields(tmp_path: Path) -> None:
    def sub(acc: str, **extra: str) -> dict[str, str]:
        row = {
            "ACCESSION_NUMBER": acc,
            "FILING_DATE": "2024-02-01",
            "DOCUMENT_TYPE": "4",
            "ISSUERTRADINGSYMBOL": "acme",
            "ISSUERCIK": "0000000000",
            "AFF10B5ONE": "Yes",
        }
        row.update(extra)
        return row

    def tx(acc: str, **extra: str) -> dict[str, str]:
        row = {
            "ACCESSION_NUMBER": acc,
            "TRANS_DATE": "",
            "TRANS_CODE": "p",
            "TRANS_SHARES": "100",
            "TRANS_PRICEPERSHARE": "$10.00",
            "SECURITY_TITLE": "Common Stock",
            "SHRS_OWND_FOLLOWING_TRANS": "",
        }
        row.update(extra)
        return row

    zip_path = tmp_path / "form345.zip"
    _write_form4_zip(
        zip_path,
        {
            "SUBMISSION.tsv": [sub("A1"), sub("NO-OWNER")],
            "REPORTINGOWNER.tsv": [
                {"ACCESSION_NUMBER": "A1", "RPTOWNERCIK": "0000900001", "RPTOWNER_RELATIONSHIP": "", "RPTOWNER_TITLE": ""},
                # An owner row of a filing that is not a kept Form 4 submission.
                {"ACCESSION_NUMBER": "UNKNOWN", "RPTOWNERCIK": "0000900002", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
                # An owner row without a CIK does not form an owner group.
                {"ACCESSION_NUMBER": "NO-OWNER", "RPTOWNERCIK": "", "RPTOWNER_RELATIONSHIP": "", "RPTOWNER_TITLE": ""},
            ],
            "NONDERIV_TRANS.tsv": [
                tx("UNKNOWN"),  # accession without a kept submission
                tx("A1"),  # kept: blank dates and blank holdings are optional
                tx("A1", SECURITY_TITLE="Stock Option (right to buy)"),  # not plain equity
                tx("A1", TRANS_SHARES=""),  # no share count
                tx("A1", TRANS_PRICEPERSHARE="n/a"),  # no price
                tx("A1", TRANS_SHARES="-5"),  # non-positive share count
                tx("A1", TRANS_PRICEPERSHARE="0"),  # non-positive price
                tx("NO-OWNER"),  # no owner group
                tx("A1", TRANS_SHARES="500", SHRS_OWND_FOLLOWING_TRANS="300", TRANS_DATE="01/30/2024"),
            ],
        },
    )
    parsed = parse_sec_form4_zip(zip_path)
    assert [(p.accession_number, p.shares, p.price) for p in parsed] == [("A1", 100.0, 10.0), ("A1", 500.0, 10.0)]
    first, second = parsed
    assert first.ticker == "ACME"
    assert first.issuer_cik == "0"  # an all-zero CIK keeps one digit
    assert first.owner_group_key == "900001"
    assert first.role_text == ""  # no relationship and no title
    assert first.is_10b5_1 is True
    assert first.transaction_date is None
    assert first.holding_before is None
    assert first.dollar_value == 1000.0
    assert second.transaction_date == date(2024, 1, 30)
    # Holdings after the buy below the bought shares floor at zero instead of going negative.
    assert second.holding_before == 0.0


def test_insider_cluster_cooldown_value_floor_and_10b5_1_exclusion() -> None:
    days = _make_trading_days(date(2024, 1, 2), 90)
    bars = {"ACME": _make_bars(days, start_price=20.0, daily_return=0.0)}

    def buy(acc: str, idx: int, owner: str, shares: float, tx_date: date | None, flagged: bool = False) -> Form4Purchase:
        return Form4Purchase(acc, days[idx], tx_date, "123", "ACME", owner, "Director", "common", shares, 20.0, None, flagged)

    purchases = [
        # First cluster: three owners in three sessions, $6,000 in total, each filed 2 days after the trade.
        buy("a1", 10, "owner1", 100, days[10] - timedelta(days=2)),
        buy("a2", 11, "owner2", 100, days[11] - timedelta(days=2)),
        buy("a3", 12, "owner3", 100, days[12] - timedelta(days=2)),
        # One day after the trigger: inside the 14-day cooldown, so no second event.
        buy("a4", 13, "owner4", 100, days[13] - timedelta(days=2)),
        # Second cluster after the cooldown: $120,000 in total, one owner trades under a 10b5-1 plan.
        buy("b1", 40, "owner5", 2000, None),
        buy("b2", 41, "owner6", 2000, days[41] - timedelta(days=4), flagged=True),
        buy("b3", 42, "owner7", 2000, days[42] + timedelta(days=1)),  # trade date after filing: no delay
    ]
    variants, diag = build_signal1_variants(purchases, bars)

    first = SignalEvent("ACME", days[12], 6_000.0, "cluster-3p", 2)
    second = SignalEvent("ACME", days[42], 120_000.0, "cluster-3p", 4)
    assert variants["cluster-3p-10d"] == [first, second]
    # The $100,000 floor drops the small cluster, also on the day a fourth owner joins it.
    assert variants["cluster-3p-10d-100k"] == [second]
    # Without the 10b5-1 filing the second window has only two owners.
    assert variants["cluster-3p-10d-no-10b5-1"] == [first]
    # A flat price never closes above its 50-day average, so nothing is confirmed.
    assert variants["cluster-3p-10d-confirm"] == []
    assert diag["raw_purchases"] == 7
    assert diag["cleaned_purchases"] == 7
    assert diag["post_2023_10b5_1_flagged"] == 1


def test_signal1_short_price_history_gives_clusters_but_no_confirmation_variants() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    bars = {"TINY": _make_bars(days, start_price=20.0, daily_return=0.002)}
    purchases = [
        Form4Purchase(f"acc{i}", days[20 + i], days[19 + i], "77", "TINY", f"owner{i}", "Director", "common", 100, bars["TINY"][20 + i].close, None)
        for i in range(3)
    ]
    variants, diag = build_signal1_variants(purchases, bars)
    assert diag["cleaned_purchases"] == 3
    assert [e.trigger_day for e in variants["cluster-3p-10d"]] == [days[22]]
    # Fewer than 55 bars: the 50-day average is not usable, so both confirmation variants stay empty.
    assert variants["confirmation-baseline"] == []
    assert variants["cluster-3p-10d-confirm"] == []


def test_signal1_needs_a_printed_close_on_or_before_the_filing_day() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    # The only bar on or before the filing day has no as-printed close: no reference price.
    unprinted = [DailyBar(b.day, b.open, b.high, b.low, b.close, b.adj_close, b.volume, 0.0) for b in _flat_bars(days)]
    purchases = [Form4Purchase("acc1", days[10], days[9], "5", "ZERO", "owner1", "Director", "common", 100, 100.0, None)]
    variants, diag = build_signal1_variants(purchases, {"ZERO": unprinted})
    assert diag["no_bar_by_filing_day"] == 1
    assert diag["cleaned_purchases"] == 0
    assert all(events == [] for events in variants.values())


def test_alert_bar_adapter_drops_invalid_bars_and_widens_the_range() -> None:
    d0 = date(2024, 1, 2)
    bars = [
        DailyBar(d0, 10.0, 9.0, 11.0, 10.5, 10.5, 100.0, 10.5),  # high below close, low above open
        DailyBar(d0 + timedelta(days=1), 0.0, 10.0, 9.0, 10.0, 10.0, 100.0, 10.0),  # no open
        DailyBar(d0 + timedelta(days=2), 10.0, 10.0, 9.0, 0.0, 10.0, 100.0, 10.0),  # no close
        DailyBar(d0 + timedelta(days=3), 10.0, 10.0, 0.0, 10.0, 10.0, 100.0, 10.0),  # no low
        DailyBar(d0 + timedelta(days=4), 10.0, 0.0, 9.0, 10.0, 10.0, 100.0, 10.0),  # no high
        DailyBar(d0 + timedelta(days=5), 10.0, 10.0, 9.0, 10.0, 10.0, -1.0, 10.0),  # negative volume
    ]
    adapted = _to_alert_bars(bars)
    assert len(adapted) == 1
    assert adapted[0].day == d0
    assert (adapted[0].open, adapted[0].high, adapted[0].low, adapted[0].close) == (10.0, 10.5, 10.0, 10.5)


def test_cluster_price_confirmation_needs_a_new_high_since_the_trigger() -> None:
    days = _make_trading_days(date(2024, 1, 2), 80)
    saturday = days[58] + timedelta(days=1)
    assert saturday.weekday() == 5
    # 59 rising closes (63.0 at the end), a spike to 70, two lower closes, then a new high at 71.
    closes = [50.0 * 1.004**i for i in range(59)] + [70.0, 66.0, 67.0, 71.0]
    closes += [71.0 * 1.004 ** (i + 1) for i in range(len(days) - len(closes))]
    acme = [DailyBar(d, c, c, c, c, c, 2_000_000.0, c) for d, c in zip(days, closes, strict=True)]
    # 56 bars of which two are invalid: 54 usable bars are too few for the 50-day average.
    short = _flat_bars(days[:54]) + [
        DailyBar(days[54], 0.0, 100.0, 100.0, 100.0, 100.0, 1_000_000.0, 100.0),
        DailyBar(days[55], 100.0, 100.0, 100.0, 100.0, 100.0, -1.0, 100.0),
    ]
    events = [
        # Trigger on a non-trading day: the reference window starts at the next session (days[59]).
        SignalEvent("ACME", saturday, 9_000.0, "cluster-3p", 2),
        SignalEvent("ACME", days[63], 5_000.0, "cluster-4p", 3),
        SignalEvent("SHORT", days[40], 1.0, "cluster-3p"),
        SignalEvent("EMPTY", days[60], 1.0, "cluster-3p"),
        SignalEvent("NOBARS", days[60], 1.0, "cluster-3p"),
    ]
    confirmed = _apply_price_confirmation(
        events,
        {"ACME": list(reversed(acme)), "SHORT": short, "EMPTY": []},
    )
    assert confirmed == [
        # days[60] and days[61] close above the 50-day average but not above the 70 spike.
        SignalEvent("ACME", days[62], 9_000.0, "cluster-confirm", 2),
        # The second trigger waits for the 14-day alert cooldown: days[72] is the first session after it.
        SignalEvent("ACME", days[72], 5_000.0, "cluster-confirm", 3),
    ]
    assert (days[72] - days[62]).days == 14


def test_congress_dedupe_keeps_the_first_filing_and_drops_non_purchases() -> None:
    tx_day = date(2024, 3, 1)
    rows = [
        CongressPurchase("house", "d1", "Rep. Member Alpha", "self", "ACME", "sale", tx_day, date(2024, 3, 10), 1001, 15000),
        CongressPurchase("house", "d2", "Rep. Member Alpha", "self", "--", "purchase", tx_day, date(2024, 3, 10), 1001, 15000),
        # The original comes first; the later amendment is counted as a duplicate and does not replace it.
        CongressPurchase("House ", "d3", "Rep. Member Alpha", "Self", "acme", "purchase", tx_day, date(2024, 3, 10), 1001, 15000),
        CongressPurchase("house", "d4", "Member Alpha", "self", "ACME", "purchase", tx_day, date(2024, 3, 20), 15001, 50000, amends=True),
        # Same filing day: the original replaces the amendment that was read first.
        CongressPurchase("senate", "d5", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 50001, 100000, amends=True),
        CongressPurchase("senate", "d6", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 15001, 50000),
        # Same filing day, both originals: the first one read stays.
        CongressPurchase("senate", "d7", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 1001, 15000),
    ]
    deduped, removed = dedupe_congress_purchases(rows)
    assert removed == 3
    assert [(r.doc_id, r.chamber, r.ticker, r.amount_low) for r in deduped] == [
        ("d3", "house", "ACME", 1001),
        ("d6", "senate", "ACME", 15001),
    ]


def test_congress_variants_apply_amount_floors_delay_window_and_multi_member_cooldown() -> None:
    rows = [
        CongressPurchase("house", "h1", "Rep. Member Alpha", "self", "ACME", "purchase", date(2024, 2, 20), date(2024, 3, 1), 1001, 15000),
        CongressPurchase("senate", "s1", "Sen. Member Beta", "self", "ACME", "purchase", date(2024, 2, 1), date(2024, 3, 5), 15001, 50000),
        CongressPurchase("house", "h2", "Hon. Member Gamma", "self", "ACME", "purchase", date(2024, 3, 8), date(2024, 3, 10), 50001, 100000),
        # No amount range: below every amount floor, still a fast filing and still a distinct purchase.
        CongressPurchase("house", "h3", "Member Alpha Jr.", "self", "ACME", "purchase", date(2024, 3, 20), date(2024, 3, 25), None, None),
        # One member under two spellings on another ticker: never a multi-member event.
        CongressPurchase("house", "h4", "Rep. Member Alpha", "self", "ZETA", "purchase", date(2024, 3, 1), date(2024, 3, 4), 1001, 15000),
        CongressPurchase("house", "h5", "Hon. Member Alpha", "spouse", "ZETA", "purchase", date(2024, 3, 2), date(2024, 3, 6), 1001, 15000),
        # Filed before the stated trade date: the delay is unknown.
        CongressPurchase("senate", "s2", "Sen. Member Beta", "self", "OMEGA", "purchase", date(2024, 4, 10), date(2024, 4, 1), 1001, 15000),
    ]
    variants, diag = build_signal2_variants(rows)
    assert diag == {"raw_rows": 7, "deduped_purchases": 7, "duplicates_removed": 0}

    assert variants["multi-member-30d"] == [
        # Second member files 4 days after the first one.
        SignalEvent("ACME", date(2024, 3, 5), 1001.0 + 15001.0, "congress-multi-2"),
        # The third member on 2024-03-10 is inside the 14-day cooldown; the next filing day is not.
        SignalEvent("ACME", date(2024, 3, 25), 1001.0 + 15001.0 + 50001.0, "congress-multi-3"),
    ]
    assert [(e.symbol, e.trigger_day, e.rank_value) for e in variants["all-buys"]] == [
        ("ACME", date(2024, 3, 1), 1001.0),
        ("ZETA", date(2024, 3, 4), 1001.0),
        ("ACME", date(2024, 3, 5), 15001.0),
        ("ZETA", date(2024, 3, 6), 1001.0),
        ("ACME", date(2024, 3, 10), 50001.0),
        ("OMEGA", date(2024, 4, 1), 1001.0),
    ]
    assert variants["large-50k"] == [SignalEvent("ACME", date(2024, 3, 10), 50001.0, "congress-50k", 2)]
    assert [(e.symbol, e.trigger_day, e.rank_value, e.delay_days) for e in variants["fast-filed-15d"]] == [
        ("ACME", date(2024, 3, 1), 1001.0, 10),
        ("ZETA", date(2024, 3, 4), 1001.0, 3),
        ("ZETA", date(2024, 3, 6), 1001.0, 4),
        ("ACME", date(2024, 3, 10), 50001.0, 2),
        ("ACME", date(2024, 3, 25), 0.0, 5),
    ]
    assert {e.delay_days for e in variants["all-buys"] if e.symbol == "OMEGA"} == {None}


def test_signal3_drops_small_thin_and_unpriced_rows_and_keeps_top_ten_by_net_premium() -> None:
    days = _make_trading_days(date(2025, 10, 1), 30)
    symbols = [f"T{i:02d}" for i in range(1, 13)]
    bars = {sym: _make_bars(days, start_price=100.0, volume=500_000.0) for sym in (*symbols, "SMALL", "FEWTR")}
    bars["THIN"] = _make_bars(days, start_price=100.0, volume=10.0)  # about $1,000 per day
    sday, next_day = days[25], days[26]
    premium = {sym: 1_000_000.0 + 10_000.0 * i for i, sym in enumerate(symbols)}
    premium["T03"] = premium["T02"]  # tie at the cut-off: the ticker decides
    rows = [MarketPremiumRow(next_day, "T01", 700_000.0, 100_000.0, 3)]  # later session listed first
    rows += [MarketPremiumRow(sday, f" {sym.lower()} ", premium[sym], 0.0, 5) for sym in symbols]
    rows += [
        MarketPremiumRow(sday, "--", 900_000.0, 0.0, 5),  # no usable ticker
        MarketPremiumRow(sday, "SMALL", 499_999.0, 0.0, 5),  # below the $500,000 floor
        MarketPremiumRow(sday, "FEWTR", 900_000.0, 0.0, 2),  # fewer than 3 trades
        MarketPremiumRow(sday, "NOBAR", 900_000.0, 0.0, 5),  # no price history
        MarketPremiumRow(next_day, "NOBAR", 900_000.0, 0.0, 5),
        MarketPremiumRow(sday, "THIN", 900_000.0, 0.0, 5),  # price history below the dollar-volume floor
        # Rows that fail a premium test are not counted as bar problems, with or without bars.
        MarketPremiumRow(sday, "NOBARTOO", 499_999.0, 0.0, 5),
        MarketPremiumRow(sday, "NOBARTOO", 900_000.0, 600_000.0, 5),
        MarketPremiumRow(sday, "NOBARTOO", 900_000.0, 0.0, 2),
        MarketPremiumRow(sday, "THIN", 900_000.0, 0.0, 2),
    ]
    events, diag = build_signal3_events(rows, bars)
    assert diag == {
        "complete_sessions": 2,
        "non_complete_rows_skipped": 0,
        "qualifying_ticker_sessions": 13,
        "premium_rows_without_bars": 2,
        "premium_rows_illiquid": 1,
        "selected_top10_events": 11,
    }
    first_session = [e for e in events if e.trigger_day == sday]
    assert [e.symbol for e in first_session] == ["T12", "T11", "T10", "T09", "T08", "T07", "T06", "T05", "T04", "T02"]
    assert first_session[0] == SignalEvent("T12", sday, 1_110_000.0, "large-bullish-premium", 0)
    # Sessions are emitted in date order; the rank value is bullish minus bearish premium.
    assert events[-1] == SignalEvent("T01", next_day, 600_000.0, "large-bullish-premium", 0)


def test_adjusted_open_scales_with_the_adjustment_factor() -> None:
    d0 = date(2024, 1, 2)
    # Adjusted close is half the close, so the adjusted open is half the open.
    assert DailyBar(d0, 50.0, 51.0, 49.0, 25.0, 12.5, 1.0, 25.0).adj_open == 25.0
    # Without a positive close there is no adjustment factor; the open is returned as it is.
    assert DailyBar(d0, 50.0, 51.0, 49.0, 0.0, 12.5, 1.0, 25.0).adj_open == 50.0


def test_liquidity_uses_the_last_bar_on_or_before_as_of_and_needs_history() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    bars = _flat_bars(days)  # $100 x 1,000,000 shares = $100M per day
    index = {b.day: i for i, b in enumerate(bars)}
    saturday = days[8] + timedelta(days=1)
    assert saturday.weekday() == 5 and saturday not in index

    assert check_point_in_time_liquidity(bars, index, saturday) is True
    # No bar on or before the day: not liquid.
    assert check_point_in_time_liquidity(bars, index, days[0] - timedelta(days=1)) is False
    # The window needs at least 5 bars, or the whole lookback when it is shorter.
    assert check_point_in_time_liquidity(bars, index, days[3]) is False
    assert check_point_in_time_liquidity(bars, index, days[4]) is True
    assert check_point_in_time_liquidity(bars, index, days[1], lookback=2) is True
    assert check_point_in_time_liquidity(bars, index, days[0], lookback=2) is False
    # Thresholds are inclusive lower bounds.
    assert check_point_in_time_liquidity(bars, index, days[20], min_median_dollar_vol=100_000_000.0) is True
    assert check_point_in_time_liquidity(bars, index, days[20], min_median_dollar_vol=100_000_001.0) is False
    assert check_point_in_time_liquidity(bars, index, days[20], min_price=100.01) is False

    # A weekend lookup falls back to Friday and must not look ahead to Monday.
    friday_penny = list(bars)
    friday_penny[8] = DailyBar(days[8], 100.0, 100.0, 100.0, 100.0, 100.0, 1_000_000.0, 1.0)
    assert check_point_in_time_liquidity(friday_penny, index, saturday) is False
    assert check_point_in_time_liquidity(friday_penny, index, days[9]) is True

    # A bar without a positive close is not tradable, whatever its as-printed close says.
    no_close = list(bars)
    no_close[20] = DailyBar(days[20], 100.0, 100.0, 100.0, 0.0, 100.0, 1_000_000.0, 100.0)
    assert check_point_in_time_liquidity(no_close, index, days[20]) is False

    # Bars with negative volume carry no dollar volume at all.
    assert check_point_in_time_liquidity(_flat_bars(days, volume=-1.0), index, days[20]) is False


def test_portfolio_rejects_invalid_config_and_handles_an_empty_benchmark_window() -> None:
    days = _make_trading_days(date(2024, 1, 2), 10)
    spy = _flat_bars(days)
    events = [SignalEvent("AAA", days[3], 1.0)]
    with pytest.raises(ValueError, match="holding_days must be >= 1"):
        simulate_event_portfolio(events, {"AAA": spy}, spy, PortfolioConfig(holding_days=0))
    with pytest.raises(ValueError, match="max_slots must be >= 1"):
        simulate_event_portfolio(events, {"AAA": spy}, spy, PortfolioConfig(holding_days=5, max_slots=0))

    after_last = {"start_day": days[-1] + timedelta(days=1)}
    before_first = {"end_day": days[0] - timedelta(days=1)}
    for window in (after_last, before_first):
        res = simulate_event_portfolio(events, {"AAA": spy}, spy, PortfolioConfig(holding_days=5), **window)
        assert res == _portfolio_result()
    assert simulate_event_portfolio(events, {"AAA": spy}, [], PortfolioConfig(holding_days=5)) == _portfolio_result()

    # start_day and end_day are inclusive bounds on the benchmark sessions.
    res = simulate_event_portfolio([], {}, spy, PortfolioConfig(holding_days=5), start_day=days[2], end_day=days[6])
    assert (res.first_day, res.last_day, res.whole.days) == (days[2], days[6], 5)
    assert res.daily_days == tuple(days[2:7])

    # One session only: no variance, no later session to enter on.
    res = simulate_event_portfolio(
        events, {"AAA": spy}, spy, PortfolioConfig(holding_days=5), start_day=days[3], end_day=days[3], oos_start=days[3]
    )
    assert res.whole == PeriodMetrics(1, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, None)
    assert res.oos == res.whole
    # The entry day is the session after the trigger, which is past the end of the window.
    assert res.skipped_outside_window == 1
    assert res.skipped_missing_bars == 0
    assert res.monthly_equity == ({"month": "2024-01", "value": 0.0, "drawdown": 0.0},)


def test_portfolio_entry_day_comes_from_the_full_calendar_not_from_the_cut_window() -> None:
    days = _make_trading_days(date(2024, 1, 2), 40)
    spy = _flat_bars(days)
    first, last = days[24], days[34]  # the window: a Monday to a Monday, 11 sessions
    saturday = first - timedelta(days=2)
    assert first.weekday() == 0 and saturday.weekday() == 5
    events = [
        SignalEvent("EARLY", days[2], 1.0),  # weeks before the window: its entry day days[3] is long gone
        SignalEvent("EVE", days[23], 1.0),  # last session before the window
        SignalEvent("WEEKEND", saturday, 1.0),  # non-trading day before the window
        SignalEvent("INSIDE", days[28], 1.0),
        SignalEvent("LASTIN", days[33], 1.0),  # entry on the last window session
        SignalEvent("ONEND", last, 1.0),  # entry day days[35] is after the window
        SignalEvent("LASTBAR", days[-1], 1.0),  # no session after the last benchmark bar
        SignalEvent("BEYOND", days[-1] + timedelta(days=30), 1.0),
    ]
    bars = {ev.symbol: _flat_bars(days) for ev in events}
    config = PortfolioConfig(holding_days=3, max_slots=10, require_liquidity=False)

    res = simulate_event_portfolio(events, bars, spy, config, start_day=first, end_day=last)
    assert (res.first_day, res.last_day, res.whole.days) == (first, last, 11)
    entries = {p.symbol: (p.entry_day, p.exit_day, p.truncated) for p in res.positions}
    assert entries == {
        "EVE": (first, days[26], False),
        "WEEKEND": (first, days[26], False),
        "INSIDE": (days[29], days[31], False),
        "LASTIN": (last, last, True),
    }
    # EARLY does not enter late on the first window session.
    assert res.skipped_outside_window == 4
    assert res.skipped_missing_bars == 0

    # Without a window only the triggers on or after the last benchmark bar have no entry day.
    res = simulate_event_portfolio(events, bars, spy, config)
    entries = {p.symbol: p.entry_day for p in res.positions}
    assert entries == {
        "EARLY": days[3],
        "EVE": first,
        "WEEKEND": first,
        "INSIDE": days[29],
        "LASTIN": last,
        "ONEND": days[35],
    }
    assert res.skipped_outside_window == 2
    # A trigger before the first benchmark bar enters on the first session.
    res = simulate_event_portfolio([SignalEvent("EARLY", days[0] - timedelta(days=90), 1.0)], bars, spy, config)
    assert [p.entry_day for p in res.positions] == [days[0]]
    assert res.skipped_outside_window == 0

    # An open start or an open end applies only the other bound.
    res = simulate_event_portfolio(events, bars, spy, config, start_day=first)
    assert sorted(p.symbol for p in res.positions) == ["EVE", "INSIDE", "LASTIN", "ONEND", "WEEKEND"]
    assert res.skipped_outside_window == 3
    res = simulate_event_portfolio(events, bars, spy, config, end_day=last)
    assert sorted(p.symbol for p in res.positions) == ["EARLY", "EVE", "INSIDE", "LASTIN", "WEEKEND"]
    assert res.skipped_outside_window == 3

    # An empty window reports no skip at all.
    res = simulate_event_portfolio(events, bars, spy, config, start_day=days[-1] + timedelta(days=1))
    assert res == _portfolio_result()
    assert res.skipped_outside_window == 0


def test_monthly_equity_keeps_the_last_value_of_each_month() -> None:
    assert _monthly_equity([], []) == ()
    days = [date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1)]
    points = _monthly_equity(days, [0.10, -0.50, 0.0])
    # 1.10 x 0.50 = 0.55: 45% below the start and 50% below the 1.10 peak.
    assert points == (
        {"month": "2024-01", "value": -0.45, "drawdown": -0.5},
        {"month": "2024-02", "value": -0.45, "drawdown": -0.5},
    )
    with pytest.raises(ValueError):
        _monthly_equity(days, [0.10])


def test_portfolio_counts_events_without_tradable_bars_and_illiquid_events() -> None:
    days = _make_trading_days(date(2024, 1, 2), 40)
    spy = _flat_bars(days)
    bars = {
        "AAA": _flat_bars(days),
        "EMPTY": [],
        "LATE": _flat_bars(days[20:]),  # no bar on the entry day days[11]
        "THIN": _flat_bars(days, volume=10.0),  # $1,000 per day
    }
    events = [
        SignalEvent("AAA", days[-1], 1.0),  # no benchmark session after the trigger: outside the window
        SignalEvent("NOBARS", days[10], 1.0),
        SignalEvent("EMPTY", days[10], 1.0),
        SignalEvent("LATE", days[10], 1.0),
        SignalEvent("THIN", days[25], 1.0),
        SignalEvent("AAA", days[25], 1.0),
    ]
    res = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5))
    assert res.skipped_outside_window == 1
    assert res.skipped_missing_bars == 3
    assert res.skipped_illiquid == 1
    assert [p.symbol for p in res.positions] == ["AAA"]
    # Flat prices: the only trade loses exactly the two cost legs, so there is no win and no profit.
    assert res.whole.win_rate == 0.0
    assert res.whole.profit_factor == 0.0

    # The liquidity filter can be switched off or loosened through the config.
    res = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5, require_liquidity=False))
    assert res.skipped_illiquid == 0
    assert sorted(p.symbol for p in res.positions) == ["AAA", "THIN"]
    res = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5, min_median_dollar_vol=1_000.0))
    assert res.skipped_illiquid == 0
    res = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5, min_median_dollar_vol=1_000.01))
    assert res.skipped_illiquid == 1


def test_portfolio_capacity_ranks_by_value_then_symbol() -> None:
    days = _make_trading_days(date(2024, 1, 2), 40)
    spy = _flat_bars(days)
    bars = {sym: _flat_bars(days) for sym in ("AAA", "BBB", "CCC")}
    events = [
        SignalEvent("BBB", days[20], 5.0),
        SignalEvent("CCC", days[20], 9.0),
        SignalEvent("AAA", days[20], 9.0),
    ]
    one_slot = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5, max_slots=1))
    assert [p.symbol for p in one_slot.positions] == ["AAA"]  # rank tie: alphabetical order
    assert one_slot.skipped_capacity == 2
    assert one_slot.skipped_overlap == 0

    two_slots = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5, max_slots=2))
    assert sorted(p.symbol for p in two_slots.positions) == ["AAA", "CCC"]
    assert two_slots.skipped_capacity == 1
    # Both slots are full on 5 of 40 sessions.
    assert math.isclose(two_slots.whole.exposure, 5 / 40)
    # A slot is free again after the exit: the same symbol can enter on a later trigger.
    later = [*events, SignalEvent("BBB", days[26], 1.0)]
    res = simulate_event_portfolio(later, bars, spy, PortfolioConfig(holding_days=5, max_slots=1))
    assert [(p.symbol, p.entry_day) for p in res.positions] == [("AAA", days[21]), ("BBB", days[27])]


def test_portfolio_truncates_exits_at_series_end_and_delisting() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    spy = _flat_bars(days)
    bars = {
        "GONE": _flat_bars(days[:13]),  # last bar on days[12]
        "FULL": _flat_bars(days),
        "ENDS": _flat_bars(days),
    }
    events = [
        SignalEvent("GONE", days[9], 1.0),  # entry days[10], planned exit days[14]
        SignalEvent("FULL", days[15], 1.0),  # entry days[16], exit days[20]
        SignalEvent("ENDS", days[26], 1.0),  # entry days[27], planned exit after the last session
    ]
    config = PortfolioConfig(holding_days=5, max_slots=10, cost_bps=10.0)
    res = simulate_event_portfolio(events, bars, spy, config, oos_start=days[14])
    by_symbol = {p.symbol: p for p in res.positions}
    assert (by_symbol["GONE"].entry_day, by_symbol["GONE"].exit_day, by_symbol["GONE"].truncated) == (days[10], days[12], True)
    assert (by_symbol["FULL"].entry_day, by_symbol["FULL"].exit_day, by_symbol["FULL"].truncated) == (days[16], days[20], False)
    assert (by_symbol["ENDS"].entry_day, by_symbol["ENDS"].exit_day, by_symbol["ENDS"].truncated) == (days[27], days[29], True)
    assert res.truncated_exits == 2
    # A truncated position still pays both cost legs: entry on its first day, exit on its last day.
    two_legs = (1.0 - 0.001) ** 2 - 1.0
    for pos in res.positions:
        assert pos.gross_excess_return == 0.0
        assert math.isclose(pos.net_excess_return, two_legs, abs_tol=1e-12)

    # Out-of-sample metrics count sessions from oos_start and trades by entry day.
    assert res.oos_days == tuple(days[14:])
    assert res.oos.days == 16
    assert res.oos.trades == 2
    assert len(res.oos_excess_returns) == 16

    # An out-of-sample start after the last session gives an empty period, as does no start at all.
    late = simulate_event_portfolio(events, bars, spy, config, oos_start=days[-1] + timedelta(days=1))
    assert late.oos == _ZERO_METRICS
    assert late.oos_days == () and late.oos_excess_returns == ()
    unset = simulate_event_portfolio(events, bars, spy, config)
    assert unset.oos == _ZERO_METRICS
    assert unset.oos_days == () and unset.oos_excess_returns == ()
    assert unset.whole == res.whole


def test_portfolio_skips_a_missing_bar_inside_the_holding_window() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    spy = _flat_bars(days)
    # No bar on days[22]; the close moves from 100 to 110 across the gap.
    gappy = [
        DailyBar(d, price, price, price, price, price, 1_000_000.0, price)
        for i, d in enumerate(days)
        if i != 22
        for price in (100.0 if i < 23 else 110.0,)
    ]
    res = simulate_event_portfolio(
        [SignalEvent("GAPPY", days[20], 1.0)],
        {"GAPPY": gappy},
        spy,
        PortfolioConfig(holding_days=4, max_slots=10, cost_bps=10.0),
    )
    assert len(res.positions) == 1
    pos = res.positions[0]
    assert (pos.entry_day, pos.exit_day, pos.truncated) == (days[21], days[24], False)
    assert res.truncated_exits == 0
    # The slot stays open on the day without a bar and earns nothing on it.
    assert res.daily_excess_returns[22] == 0.0
    # The next bar is measured against the last available close: +10% on one of 10 slots.
    assert math.isclose(res.daily_excess_returns[23], 0.10 / 10, abs_tol=1e-12)
    assert math.isclose(pos.gross_excess_return, 0.10, abs_tol=1e-12)
    assert math.isclose(pos.net_excess_return, (1.0 - 0.001) * 1.10 * (1.0 - 0.001) - 1.0, abs_tol=1e-12)
    assert res.whole.win_rate == 1.0
    assert res.whole.profit_factor is None  # no losing trade


def test_portfolio_measures_the_benchmark_over_the_same_sessions_as_a_stock_gap() -> None:
    days = _make_trading_days(date(2024, 1, 2), 12)

    def series(closes: dict[int, float], missing: tuple[int, ...] = ()) -> list[DailyBar]:
        """Bars at 100 that step to the given close from the given session on; open = previous close."""
        bars: list[DailyBar] = []
        price = 100.0
        for i, d in enumerate(days):
            close = closes.get(i, price)
            if i not in missing:
                bars.append(DailyBar(d, price, max(price, close), min(price, close), close, close, 1_000_000.0, close))
            price = close
        return bars

    # The benchmark gains 1% on days[7] and 1% on days[8].
    spy_path = {7: 101.0, 8: 102.01}
    spy = series(spy_path)
    config = PortfolioConfig(holding_days=4, max_slots=1, cost_bps=0.0)
    event = [SignalEvent("HALT", days[5], 1.0)]  # entry days[6], exit days[9]

    # The stock follows the benchmark exactly but prints no bar on days[7]: no excess return at all.
    res = simulate_event_portfolio(event, {"HALT": series(spy_path, missing=(7,))}, spy, config)
    pos = res.positions[0]
    assert (pos.entry_day, pos.exit_day, pos.truncated) == (days[6], days[9], False)
    assert res.daily_excess_returns[7] == 0.0  # no bar: nothing is booked on the day itself
    assert math.isclose(res.daily_excess_returns[8], 0.0, abs_tol=1e-12)
    assert math.isclose(pos.gross_excess_return, 0.0, abs_tol=1e-12)
    # Same result as the series without a gap.
    full = simulate_event_portfolio(event, {"HALT": series(spy_path)}, spy, config)
    assert math.isclose(full.positions[0].gross_excess_return, 0.0, abs_tol=1e-12)

    # Two sessions without a bar, then +5% against the last printed close on the exit day.
    # The benchmark leg compounds all three sessions since that close: 1.01 x 1.01 x 1.00.
    res = simulate_event_portfolio(event, {"HALT": series({9: 105.0}, missing=(7, 8))}, spy, config)
    expected = 0.05 - (1.01 * 1.01 - 1.0)
    assert res.daily_excess_returns[7] == 0.0 and res.daily_excess_returns[8] == 0.0
    assert math.isclose(res.daily_excess_returns[9], expected, abs_tol=1e-12)
    assert math.isclose(res.positions[0].gross_excess_return, expected, abs_tol=1e-12)
    assert res.positions[0].truncated is False


def test_portfolio_wipeout_floors_equity_drawdown_and_cagr() -> None:
    days = _make_trading_days(date(2024, 1, 2), 12)
    # On days[6] the benchmark gains 50% from open to close while the stock loses 60%.
    spy = [
        DailyBar(d, 100.0, 100.0, 100.0, 100.0, 100.0, 10_000_000.0, 100.0) if i < 6
        else DailyBar(d, 100.0 if i == 6 else 150.0, 150.0, 100.0, 150.0, 150.0, 10_000_000.0, 150.0)
        for i, d in enumerate(days)
    ]
    stock = [
        DailyBar(d, 100.0, 100.0, 100.0, 100.0, 100.0, 1_000_000.0, 100.0) if i < 6
        else DailyBar(d, 100.0 if i == 6 else 40.0, 100.0, 40.0, 40.0, 40.0, 1_000_000.0, 40.0)
        for i, d in enumerate(days)
    ]
    res = simulate_event_portfolio(
        [SignalEvent("BUST", days[5], 1.0)],
        {"BUST": stock},
        spy,
        PortfolioConfig(holding_days=1, max_slots=1, cost_bps=0.0),
    )
    assert math.isclose(res.daily_excess_returns[6], -1.1, abs_tol=1e-12)
    pos = res.positions[0]
    assert (pos.entry_day, pos.exit_day) == (days[6], days[6])
    # A loss beyond 100% is floored: the position, the equity curve and the CAGR stop at -100%.
    assert pos.gross_excess_return == -1.0
    assert pos.net_excess_return == -1.0
    assert res.whole.cagr == -1.0
    assert res.whole.max_drawdown == -1.0
    assert res.whole.trades == 1
    assert res.whole.win_rate == 0.0
    assert res.whole.profit_factor == 0.0
    assert res.monthly_equity == ({"month": "2024-01", "value": -1.0, "drawdown": -1.0},)


def test_portfolio_treats_a_zero_adjusted_price_as_a_zero_return() -> None:
    days = _make_trading_days(date(2024, 1, 2), 12)

    def zero_adjusted_on_entry_day(bars: list[DailyBar]) -> list[DailyBar]:
        return [
            DailyBar(b.day, b.open, b.high, b.low, b.close, 0.0, b.volume, b.raw_close) if i == 6 else b
            for i, b in enumerate(bars)
        ]

    stock = zero_adjusted_on_entry_day(_flat_bars(days))
    spy = _flat_bars(days)
    config = PortfolioConfig(holding_days=2, max_slots=1, cost_bps=0.0)
    res = simulate_event_portfolio([SignalEvent("ZADJ", days[5], 1.0)], {"ZADJ": stock}, spy, config)
    pos = res.positions[0]
    assert (pos.entry_day, pos.exit_day) == (days[6], days[7])
    # No adjusted open on the entry day and no previous adjusted close on the next day:
    # both days count as 0% instead of dividing by zero.
    assert res.daily_excess_returns == (0.0,) * len(days)
    assert pos.gross_excess_return == 0.0

    # The same guard on the benchmark side: its open-to-close return on days[6] and its
    # close-to-close return on days[7] are 0%, so a flat stock has no excess return on its two days.
    res = simulate_event_portfolio(
        [SignalEvent("FLAT", days[5], 1.0)], {"FLAT": _flat_bars(days)}, zero_adjusted_on_entry_day(spy), config
    )
    assert res.daily_excess_returns == (0.0,) * len(days)
    assert res.positions[0].gross_excess_return == 0.0


def test_dsr_variance_fallbacks_and_inputs_that_cannot_be_scored() -> None:
    # Mean 0.1% with 1% daily swings: a low per-observation Sharpe, so the probability is not saturated.
    rets = [0.011 if i % 2 == 0 else -0.009 for i in range(120)]
    n_obs = len(rets)
    fallback_variance = 1.0 / (n_obs - 1)

    spread = compute_study_dsr(rets, [0.1, 0.3], n_trials=2)
    assert spread is not None
    assert math.isclose(spread.sharpe_variance, statistics.variance([0.1, 0.3]))
    assert math.isclose(spread.sharpe, statistics.fmean(rets) / statistics.stdev(rets))
    assert (spread.n_trials, spread.n_observations) == (2, n_obs)

    # Fewer than two finite trial Sharpes: the variance falls back to 1 / (observations - 1).
    single = compute_study_dsr(rets, [0.05], n_trials=2)
    assert single is not None and math.isclose(single.sharpe_variance, fallback_variance)
    non_finite = compute_study_dsr(rets, [float("nan"), float("inf"), 0.05], n_trials=3)
    assert non_finite is not None and math.isclose(non_finite.sharpe_variance, fallback_variance)
    # Identical trial Sharpes have zero variance: same fallback.
    identical = compute_study_dsr(rets, [0.1, 0.1, 0.1], n_trials=3)
    assert identical is not None and math.isclose(identical.sharpe_variance, fallback_variance)
    assert 0.0 <= identical.probability <= 1.0
    # More trials raise the expected maximum Sharpe, so the deflated probability falls.
    assert identical.expected_max_sharpe > single.expected_max_sharpe
    assert identical.probability < single.probability

    # Constant returns have no Sharpe ratio; one observation has no variance.
    assert compute_study_dsr([0.01] * 50, [0.1, 0.3], n_trials=2) is None
    assert compute_study_dsr([0.01], [0.1, 0.3], n_trials=2) is None
    # The DSR helper rejects a trial count whose expected maximum Sharpe is not computable
    # (1 - 1/N rounds to 1.0); the study then has no DSR instead of an exception.
    assert compute_study_dsr(rets, [0.1, 0.3], n_trials=10**18) is None


def test_dsr_passes_skew_raw_kurtosis_and_per_observation_units(monkeypatch: pytest.MonkeyPatch) -> None:
    # Small steady gains, frequent small losses and a rare large loss: left-skewed with fat tails.
    rets = [-0.06 if i % 50 == 49 else (-0.002 if i % 4 == 3 else 0.003) for i in range(300)]
    trial_sharpes = [0.02, 0.05, -0.01, 0.08, float("nan")]

    n = len(rets)
    mean = sum(rets) / n
    m2 = sum((x - mean) ** 2 for x in rets) / n
    m3 = sum((x - mean) ** 3 for x in rets) / n
    m4 = sum((x - mean) ** 4 for x in rets) / n
    skew = m3 / m2**1.5
    raw_kurtosis = m4 / m2**2
    sample_std = math.sqrt(sum((x - mean) ** 2 for x in rets) / (n - 1))
    assert skew < -3.0
    assert raw_kurtosis > 20.0  # far from 3 (normal) and from 0 (excess kurtosis of a normal)

    calls: list[dict[str, Any]] = []
    sentinel = object()

    def fake_dsr(**kwargs: Any) -> object:
        calls.append(kwargs)
        return sentinel

    monkeypatch.setattr(engine_module, "deflated_sharpe_ratio", fake_dsr)
    assert compute_study_dsr(rets, trial_sharpes, n_trials=12) is sentinel
    assert len(calls) == 1
    call = calls[0]
    assert sorted(call) == ["kurtosis", "n_observations", "n_trials", "sharpe", "sharpe_variance", "skew"]
    assert call["n_trials"] == 12
    assert call["n_observations"] == n
    # Per-observation Sharpe with the sample standard deviation; not annualized.
    assert math.isclose(call["sharpe"], mean / sample_std, rel_tol=1e-12)
    assert not math.isclose(call["sharpe"], mean / sample_std * math.sqrt(252), rel_tol=1e-3)
    # Variance across the finite trial Sharpes only.
    assert math.isclose(call["sharpe_variance"], statistics.variance([0.02, 0.05, -0.01, 0.08]), rel_tol=1e-12)
    # Skew and raw kurtosis: the same numbers as trend_trio.study.moments, not the excess kurtosis.
    assert math.isclose(call["skew"], skew, rel_tol=1e-9)
    assert math.isclose(call["kurtosis"], raw_kurtosis, rel_tol=1e-9)
    assert (call["skew"], call["kurtosis"]) == moments(rets)
    assert not math.isclose(call["kurtosis"], raw_kurtosis - 3.0, rel_tol=1e-3)


def test_dsr_probability_falls_when_the_same_sharpe_has_a_fat_left_tail() -> None:
    # Two series with the same mean and the same sample standard deviation, hence the same Sharpe.
    symmetric = [0.011 if i % 2 == 0 else -0.009 for i in range(400)]
    mean, std = statistics.fmean(symmetric), statistics.stdev(symmetric)
    raw = [-0.06 if i % 50 == 49 else (-0.002 if i % 4 == 3 else 0.003) for i in range(400)]
    raw_mean, raw_std = statistics.fmean(raw), statistics.stdev(raw)
    skewed = [mean + (x - raw_mean) * std / raw_std for x in raw]
    assert math.isclose(statistics.fmean(skewed), mean, rel_tol=1e-9)
    assert math.isclose(statistics.stdev(skewed), std, rel_tol=1e-9)

    trial_sharpes = [0.0, 0.05]
    plain = compute_study_dsr(symmetric, trial_sharpes, n_trials=2)
    tailed = compute_study_dsr(skewed, trial_sharpes, n_trials=2)
    assert plain is not None and tailed is not None
    assert math.isclose(plain.sharpe, tailed.sharpe, rel_tol=1e-9)
    assert math.isclose(plain.skew, 0.0, abs_tol=1e-9) and math.isclose(plain.kurtosis, 1.0, rel_tol=1e-9)
    assert tailed.skew < -3.0 and tailed.kurtosis > 20.0
    # Negative skew and fat tails widen the Sharpe standard error, so the z-score moves towards 0.
    assert abs(tailed.z) < abs(plain.z)
    assert (tailed.probability - 0.5) * (plain.probability - 0.5) > 0
    assert abs(tailed.probability - 0.5) < abs(plain.probability - 0.5)


def test_package_imports_only_the_standard_library_and_research_packages() -> None:
    package_dir = Path(smart_money_package.__file__).parent
    sources = sorted(package_dir.rglob("*.py"))
    assert {"__init__.py", "__main__.py", "document.py", "engine.py", "signals.py"} <= {p.name for p in sources}

    allowed_roots = set(sys.stdlib_module_names) | {"backtesting", "strategies"}
    forbidden_prefixes = ("vertex_openbb", "requests", "pandas", "numpy", "yfinance", "pdfplumber")
    absolute: dict[str, set[str]] = {}
    relative = 0
    for source in sources:
        for node in walk(parse(source.read_text(encoding="utf-8"), filename=str(source))):
            if isinstance(node, Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ImportFrom) and node.level == 0:
                names = [node.module or ""]
            elif isinstance(node, ImportFrom):
                relative += 1
                continue
            else:
                continue
            absolute.setdefault(source.name, set()).update(names)

    for file_name, names in absolute.items():
        for name in sorted(names):
            assert name.split(".")[0] in allowed_roots, f"{file_name} imports {name}"
            assert not name.startswith(forbidden_prefixes), f"{file_name} imports {name}"
    # The scan saw real imports: the reused research modules and the package's own relative imports.
    assert "backtesting.optimizer" in absolute["engine.py"]
    assert "strategies.trend_trio.study" in absolute["engine.py"]
    assert "strategies" in absolute["signals.py"]
    assert relative >= 5


def test_study_document_rejects_unknown_ids_verdicts_and_oversized_payloads() -> None:
    result = _portfolio_result()
    with pytest.raises(ValueError, match="Unknown smart-money study_id: smart-money-unknown"):
        build_study_document(**_study_kwargs(result, study_id="smart-money-unknown"))
    with pytest.raises(ValueError, match="Invalid verdict: maybe"):
        build_study_document(**_study_kwargs(result, verdict="maybe"))
    with pytest.raises(ValueError, match=f"exceeds {MAX_DOC_BYTES} bytes"):
        build_study_document(**_study_kwargs(result, runs=[{"blob": "x" * MAX_DOC_BYTES}]))
    for study_id in STUDY_IDS:
        doc = build_study_document(**_study_kwargs(result, study_id=study_id))
        assert doc["id"] == study_id
        assert doc["spec"] == f"docs/specs/strategies/{study_id}.md"
        assert doc["provenance"]["runId"] == f"{study_id}-2026-11-25"


def test_study_document_cuts_text_and_clamps_numbers() -> None:
    long_title = "word  " * 100  # 100 words, double spaces
    collapsed = " ".join(["word"] * 100)
    doc = build_study_document(
        **_study_kwargs(
            _portfolio_result(),
            title=long_title,
            commit="c" * 48,
            notes="  Synthetic notes.  ",
            gaps=[("Gap name", "Choice text")],
            rules=[("Item", "Rule text", "Source text")],
            comparison=[{"cagr": float("nan"), "kind": "benchmark", "maxDrawdown": 0.3, "name": "n" * 90, "sharpe": float("inf")}],
            sensitivity=[{"cagr": -7.0, "maxDrawdown": -2.0, "param": "holding", "sharpe": 1.23456789, "trades": -3, "value": 20}],
            robustness=[{"check": "Check", "pass": None, "result": "r" * 400}],
        )
    )
    # Whitespace is collapsed first; a cut text ends with an ellipsis and never exceeds its limit.
    assert doc["title"] == collapsed[:199].rstrip() + "…"
    assert len(doc["title"]) <= 200
    assert doc["equityLabel"] == "Excess return over the benchmark"  # short text is unchanged
    assert doc["provenance"]["commit"] == "c" * 40
    assert doc["notes"] == "Synthetic notes."
    # Notes are cut at the contract limit without an ellipsis; notes at the limit are unchanged.
    assert NOTES_MAX_CHARS == 4_000
    at_limit = "n" * NOTES_MAX_CHARS
    for notes in (at_limit, at_limit + "tail beyond the limit"):
        assert build_study_document(**_study_kwargs(_portfolio_result(), notes=notes))["notes"] == at_limit
    assert doc["gaps"] == [{"choice": "Choice text", "gap": "Gap name"}]
    assert doc["rules"] == [{"item": "Item", "rule": "Rule text", "source": "Source text"}]
    # Non-finite numbers become 0; CAGR floors at -1; drawdown stays in [-1, 0]; trades never go negative.
    assert doc["comparison"] == [
        {"cagr": 0.0, "kind": "benchmark", "maxDrawdown": 0.0, "name": "n" * 79 + "…", "sharpe": 0.0}
    ]
    assert doc["sensitivity"] == [
        {"cagr": -1.0, "maxDrawdown": -1.0, "param": "holding", "sharpe": 1.234568, "trades": 0, "value": "20"}
    ]
    assert doc["robustness"] == [{"check": "Check", "pass": None, "result": "r" * 299 + "…"}]


def test_study_document_equity_always_has_two_months() -> None:
    def equity(result: PortfolioResult, ran: date = date(2026, 11, 25)) -> list[dict[str, Any]]:
        return build_study_document(**_study_kwargs(result, ran=ran))["equity"]

    flat = {"drawdown": 0.0, "value": 0.0}
    # No equity point and no first day: the run date starts the two flat months.
    assert equity(_portfolio_result()) == [{**flat, "month": "2026-11"}, {**flat, "month": "2026-12"}]
    assert equity(_portfolio_result(), date(2026, 12, 5)) == [{**flat, "month": "2026-12"}, {**flat, "month": "2027-01"}]
    # No equity point but a first day: the first day wins over the run date.
    assert equity(_portfolio_result(first_day=date(2024, 5, 6))) == [{**flat, "month": "2024-05"}, {**flat, "month": "2024-06"}]

    # One point: the next month repeats it, across a year end too.
    point = {"month": "2024-12", "value": 0.25, "drawdown": -0.1}
    assert equity(_portfolio_result(monthly_equity=(point,))) == [
        {"drawdown": -0.1, "month": "2024-12", "value": 0.25},
        {"drawdown": -0.1, "month": "2025-01", "value": 0.25},
    ]
    assert [p["month"] for p in equity(_portfolio_result(monthly_equity=({**point, "month": "2024-03"},)))] == ["2024-03", "2024-04"]

    # Two or more points pass through with the schema clamps applied.
    points = ({"month": "2024-01", "value": -3.0, "drawdown": 0.2}, {"month": "2024-02", "value": 0.5, "drawdown": -4.0})
    assert equity(_portfolio_result(monthly_equity=points)) == [
        {"drawdown": 0.0, "month": "2024-01", "value": -1.0},
        {"drawdown": -1.0, "month": "2024-02", "value": 0.5},
    ]


def test_run_entry_clamps_metrics_to_the_schema_ranges() -> None:
    wild = PeriodMetrics(
        days=10,
        trades=3,
        cagr=float("inf"),
        sharpe=float("nan"),
        per_obs_sharpe=0.0,
        max_drawdown=-5.0,
        exposure=1.7,
        win_rate=float("nan"),
        profit_factor=float("inf"),
    )
    oos = PeriodMetrics(5, 1, -9.0, 0.123456789, 0.0, 0.0, 0.0, 0.0, None)
    result = _portfolio_result(whole=wild, oos=oos)
    run = make_run_entry(
        symbol="s" * 50,
        market="m" * 70,
        result=result,
        include_oos=True,
        spy_whole_cagr=-3.0,
        spy_whole_sharpe=float("nan"),
    )
    assert run == {
        "buyHoldCagr": -1.0,
        "buyHoldSharpe": 0.0,
        "cagr": 0.0,
        "exposure": 1.0,
        "from": "2020-01-01",  # placeholder when the result has no sessions
        "market": "m" * 59 + "…",
        "maxDrawdown": -1.0,
        "oosCagr": -1.0,
        "oosSharpe": 0.123457,
        "profitFactor": None,
        "sharpe": 0.0,
        "symbol": "s" * 39 + "…",
        "to": "2020-01-01",
        "trades": 3,
        "winRate": 0.0,
    }

    dated = _portfolio_result(
        first_day=date(2024, 1, 2),
        last_day=date(2024, 6, 28),
        whole=PeriodMetrics(120, 4, 0.1234567, 1.5, 0.09, -0.2, 0.4, 0.75, 2.3456789),
        oos=oos,
    )
    run = make_run_entry(symbol="ACME", market="US equities", result=dated, include_oos=False)
    assert (run["from"], run["to"]) == ("2024-01-02", "2024-06-28")
    assert (run["cagr"], run["sharpe"], run["maxDrawdown"], run["exposure"], run["winRate"]) == (0.123457, 1.5, -0.2, 0.4, 0.75)
    assert run["profitFactor"] == 2.345679
    # Out-of-sample metrics are withheld on request, and the benchmark is optional.
    assert run["oosCagr"] is None and run["oosSharpe"] is None
    assert run["buyHoldCagr"] is None and run["buyHoldSharpe"] is None
    # They are also withheld when the out-of-sample period has no session.
    run = make_run_entry(symbol="ACME", market="US equities", result=_portfolio_result(), include_oos=True)
    assert run["oosCagr"] is None and run["oosSharpe"] is None
    # make_run_entry is the one builder of run entries; the former private twin is gone.
    assert not hasattr(document_module, "_make_run")


def test_write_study_bundle_writes_study_files_bundle_and_rounded_trials(tmp_path: Path) -> None:
    trial = TrialRecord(
        study_id="study-a",
        variant="all-buys",
        holding_days=20,
        cost_bps=10.0,
        is_primary=True,
        oos_events=12,
        oos_days=500,
        oos_per_obs_sharpe=0.123456789,
        oos_annual_sharpe=1.9599999,
        oos_cagr=0.0500004,
        whole_cagr=0.04,
        whole_sharpe=1.1,
        whole_max_drawdown=-0.1234564,
        whole_trades=40,
        whole_win_rate=0.55,
    )
    docs = [{"id": "study-a", "title": "A"}, {"title": "B", "id": "study-b"}]
    out_dir = tmp_path / "nested" / "out"
    jsonl_path, trials_path = write_study_bundle(out_dir, docs, [trial])
    assert (jsonl_path, trials_path) == (out_dir / "studies.jsonl", out_dir / "trials.json")
    # One compact line per document, keys sorted.
    assert jsonl_path.read_text(encoding="utf-8") == '{"id":"study-a","title":"A"}\n{"id":"study-b","title":"B"}\n'
    assert json.loads((out_dir / "study-b.json").read_text(encoding="utf-8")) == docs[1]
    assert json.loads(trials_path.read_text(encoding="utf-8")) == [
        {
            "study_id": "study-a",
            "variant": "all-buys",
            "holding_days": 20,
            "cost_bps": 10.0,
            "is_primary": True,
            "oos_events": 12,
            "oos_days": 500,
            "oos_per_obs_sharpe": 0.123457,
            "oos_annual_sharpe": 1.96,
            "oos_cagr": 0.05,
            "whole_cagr": 0.04,
            "whole_sharpe": 1.1,
            "whole_max_drawdown": -0.123456,
            "whole_trades": 40,
            "whole_win_rate": 0.55,
        }
    ]


def test_write_study_bundle_checks_every_size_limit_before_the_first_write(tmp_path: Path) -> None:
    trial = TrialRecord("study-a", "all-buys", 20, 10.0, True, 12, 500, 0.1, 1.6, 0.05, 0.04, 1.1, -0.1, 40, 0.55)
    small = {"id": "study-a", "title": "A"}
    oversized = {"id": "study-b", "blob": "x" * MAX_DOC_BYTES}

    # The second document is above the per-document limit: the first one, which fits, is not written either.
    too_big = tmp_path / "too-big"
    with pytest.raises(ValueError, match=f"study-b exceeds {MAX_DOC_BYTES} bytes"):
        write_study_bundle(too_big, [small, oversized], [trial])
    assert not too_big.exists()

    # Five documents that each fit, but together exceed the batch limit.
    blob = "x" * 250_000
    assert 5 * len(blob) > MAX_BATCH_BYTES > 4 * len(blob)
    batch = tmp_path / "batch"
    with pytest.raises(ValueError, match=f"study bundle exceeds {MAX_BATCH_BYTES} bytes"):
        write_study_bundle(batch, [{"id": f"study-{i}", "blob": blob} for i in range(5)], [trial])
    assert not batch.exists()

    # An output directory that exists already stays as it was: no <id>.json, no studies.jsonl, no trials.json.
    existing = tmp_path / "existing"
    existing.mkdir()
    (existing / "keep.txt").write_text("kept\n", encoding="utf-8")
    for documents in ([small, oversized], [{"id": f"study-{i}", "blob": blob} for i in range(5)]):
        with pytest.raises(ValueError, match="exceeds"):
            write_study_bundle(existing, documents, [trial])
        assert [p.name for p in existing.iterdir()] == ["keep.txt"]

    # Control: the document that fits is written once the oversized one is left out.
    write_study_bundle(existing, [small], [trial])
    assert sorted(p.name for p in existing.iterdir()) == ["keep.txt", "studies.jsonl", "study-a.json", "trials.json"]


def test_bars_loader_skips_files_without_valid_rows(tmp_path: Path) -> None:
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    header = "date,open,high,low,close,adj_close,volume,raw_close\n"
    # Every row is unusable: zero close, negative volume, text in a number field, zero open, zero adjusted close.
    (bars_dir / "BAD.csv").write_text(
        header
        + "2024-01-02,10,10,10,0,10,100,10\n"
        + "2024-01-03,10,10,10,10,10,-1,10\n"
        + "2024-01-04,10,10,10,ten,10,100,10\n"
        + "2024-01-05,0,10,10,10,10,100,10\n"
        + "2024-01-08,10,10,10,10,0.0,100,10\n",
        encoding="utf-8",
    )
    # A blank adjusted close falls back to the close; the symbol is the upper-case file stem.
    (bars_dir / "good.csv").write_text(header + "2024-01-02,10,11,9,10.5,,100,42\n", encoding="utf-8")
    (bars_dir / "notes.txt").write_text("not a bar file\n", encoding="utf-8")
    loaded = load_bars_dir(bars_dir)
    assert loaded == {"GOOD": [DailyBar(date(2024, 1, 2), 10.0, 11.0, 9.0, 10.5, 10.5, 100.0, 42.0)]}


def test_bars_loader_skips_short_rows_and_non_finite_or_non_positive_values(tmp_path: Path) -> None:
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    columns = ["date", "open", "high", "low", "close", "adj_close", "volume", "raw_close"]
    valid = {"date": "2024-01-02", "open": "10", "high": "11", "low": "9", "close": "10.5", "adj_close": "5.25", "volume": "100", "raw_close": "42"}
    lines = [",".join(columns), ",".join(valid[c] for c in columns)]
    # A row cut short, as an interrupted download leaves it.
    lines.append("2024-01-03,10,10")
    lines.append("2024-01-03")
    # A non-finite value in any numeric column rejects the row.
    for column in columns[1:]:
        for bad in ("inf", "-inf", "nan"):
            lines.append(",".join({**valid, "date": "2024-01-04", column: bad}[c] for c in columns))
    # Every price must be positive, the high and the low included.
    for column in ("open", "high", "low", "close", "adj_close", "raw_close"):
        for bad in ("0", "-1"):
            lines.append(",".join({**valid, "date": "2024-01-05", column: bad}[c] for c in columns))
    lines.append(",".join({**valid, "date": "2024-01-05", "volume": "-1"}[c] for c in columns))
    # Zero volume is a valid bar (a session without trades).
    lines.append(",".join({**valid, "date": "2024-01-08", "volume": "0"}[c] for c in columns))
    (bars_dir / "ACME.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")

    assert load_bars_dir(bars_dir) == {
        "ACME": [
            DailyBar(date(2024, 1, 2), 10.0, 11.0, 9.0, 10.5, 5.25, 100.0, 42.0),
            DailyBar(date(2024, 1, 8), 10.0, 11.0, 9.0, 10.5, 5.25, 0.0, 42.0),
        ]
    }

    # A file that holds only a short row has no usable bar, so the symbol is absent.
    (bars_dir / "CUT.csv").write_text(",".join(columns) + "\n2024-01-03,10,10\n", encoding="utf-8")
    assert sorted(load_bars_dir(bars_dir)) == ["ACME"]


def test_jsonl_loaders_skip_blank_lines_and_default_optional_fields(tmp_path: Path) -> None:
    absent = tmp_path / "absent.jsonl"
    assert load_form4_jsonl(absent) == []
    assert load_congress_jsonl(absent) == []
    assert load_premium_jsonl(absent) == []

    def write_lines(name: str, records: list[dict[str, Any]]) -> Path:
        path = tmp_path / name
        # Blank and whitespace-only lines surround the records.
        path.write_text("\n" + "\n   \n".join(json.dumps(r) for r in records) + "\n\n", encoding="utf-8")
        return path

    form4_path = write_lines(
        "form4.jsonl",
        [
            {
                "accession_number": "acc-1",
                "filing_date": "2024-01-15",
                "transaction_date": "2024-01-12",
                "issuer_cik": 123,
                "ticker": "acme",
                "owner_group_key": "own-1",
                "role_text": "Director",
                "security": "common",
                "shares": 10,
                "price": "20.5",
                "holding_before": 0,
                "is_10b5_1": True,
            },
            {
                "accession_number": "acc-2",
                "filing_date": "2024-01-16",
                "transaction_date": None,
                "issuer_cik": "123",
                "ticker": "ACME",
                "owner_group_key": "own-2",
                "security": "ordinary",
                "shares": 5,
                "price": 21,
            },
        ],
    )
    assert load_form4_jsonl(form4_path) == [
        Form4Purchase("acc-1", date(2024, 1, 15), date(2024, 1, 12), "123", "ACME", "own-1", "Director", "common", 10.0, 20.5, 0.0, True),
        Form4Purchase("acc-2", date(2024, 1, 16), None, "123", "ACME", "own-2", "", "ordinary", 5.0, 21.0, None, False),
    ]

    congress_path = write_lines(
        "congress.jsonl",
        [
            {
                "chamber": "house",
                "doc_id": 20010001,
                "member": "Hon. Member Alpha",
                "holder": "spouse",
                "ticker": "acme",
                "transaction_type": "purchase",
                "transaction_date": "2024-03-01",
                "filed_on": "2024-03-10",
                "amount_low": 0,
                "amount_high": 15000,
                "amends": True,
            },
            {
                "chamber": "senate",
                "doc_id": "uuid-1",
                "member": "Sen. Member Beta",
                "holder": "",
                "ticker": "ZETA",
                "transaction_type": "purchase",
                "filed_on": "2024-03-12",
            },
        ],
    )
    assert load_congress_jsonl(congress_path) == [
        CongressPurchase("house", "20010001", "Hon. Member Alpha", "spouse", "ACME", "purchase", date(2024, 3, 1), date(2024, 3, 10), 0.0, 15000.0, True),
        CongressPurchase("senate", "uuid-1", "Sen. Member Beta", None, "ZETA", "purchase", None, date(2024, 3, 12), None, None, False),
    ]

    premium_path = write_lines(
        "premium.jsonl",
        [
            {"session_date": "2025-10-01", "ticker": "acme", "bullish_premium": 800000, "bearish_premium": "1000.5", "trade_count": 5},
            {"session_date": "2025-10-02", "ticker": "ACME", "bullish_premium": 1, "bearish_premium": 2, "trade_count": 3, "session_status": "partial"},
            {"session_date": "2025-10-03", "ticker": "ACME", "bullish_premium": 1, "bearish_premium": 2, "trade_count": 3, "session_status": ""},
        ],
    )
    assert load_premium_jsonl(premium_path) == [
        MarketPremiumRow(date(2025, 10, 1), "ACME", 800_000.0, 1000.5, 5, "complete"),
        MarketPremiumRow(date(2025, 10, 2), "ACME", 1.0, 2.0, 3, "partial"),
        MarketPremiumRow(date(2025, 10, 3), "ACME", 1.0, 2.0, 3, "complete"),
    ]


def test_spy_benchmark_stats_need_two_bars_in_the_window() -> None:
    d0, d1, d2 = date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4)
    bars = [  # unordered on purpose
        DailyBar(d2, 104.5, 104.5, 104.5, 104.5, 104.5, 1.0, 104.5),
        DailyBar(d0, 100.0, 100.0, 100.0, 100.0, 100.0, 1.0, 100.0),
        DailyBar(d1, 110.0, 110.0, 110.0, 110.0, 110.0, 1.0, 110.0),
    ]
    assert _spy_benchmark_stats(bars, d0, d0) == (0.0, 0.0, 0.0)
    assert _spy_benchmark_stats(bars, date(2025, 1, 1), date(2025, 12, 31)) == (0.0, 0.0, 0.0)
    assert _spy_benchmark_stats([], d0, d2) == (0.0, 0.0, 0.0)

    cagr, sharpe, max_dd = _spy_benchmark_stats(bars, d0, d2)
    rets = [0.10, -0.05]
    assert math.isclose(cagr, 1.045 ** (365.25 / 2) - 1.0, rel_tol=1e-9)
    assert math.isclose(sharpe, statistics.fmean(rets) / statistics.stdev(rets) * math.sqrt(252), rel_tol=1e-9)
    assert math.isclose(max_dd, 104.5 / 110.0 - 1.0, rel_tol=1e-9)

    # Two bars give one return: no standard deviation, so no Sharpe ratio.
    # A one-day span is annualized over one session (1/252 year), not over one calendar day.
    cagr, sharpe, max_dd = _spy_benchmark_stats(bars, d1, d2)
    assert sharpe == 0.0
    assert math.isclose(cagr, max(-1.0, 0.95**252 - 1.0), rel_tol=1e-9)
    assert math.isclose(max_dd, -0.05, rel_tol=1e-9)


def test_module_entry_point_runs_the_cli_and_exits_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    bars_dir.mkdir(parents=True)
    out_dir = tmp_path / "out"
    days = _make_trading_days(date(2024, 1, 2), 60)
    _write_bars_csv(bars_dir / "SPY.csv", _make_bars(days, start_price=200.0, volume=50_000_000.0))

    monkeypatch.setattr(
        sys,
        "argv",
        ["strategies.smart_money", "--data-dir", str(data_dir), "--out-dir", str(out_dir), "--ran", "2026-11-25", "--commit", "0123abc"],
    )
    # runpy executes the file again as __main__; drop the imported copy so that it does not warn about it.
    monkeypatch.delitem(sys.modules, "strategies.smart_money.__main__", raising=False)
    with pytest.raises(SystemExit) as exc_info:
        runpy.run_module("strategies.smart_money", run_name="__main__")
    assert exc_info.value.code == 0

    summary = json.loads(capsys.readouterr().out)
    assert sorted(summary) == sorted(STUDY_IDS)
    # 60 sessions and no signal files: every study is short of the holdout window.
    assert {s["verdict"] for s in summary.values()} == {"needs-more-data"}
    assert json.loads((out_dir / "summary.json").read_text(encoding="utf-8")) == summary
    docs = [json.loads(line) for line in (out_dir / "studies.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [d["id"] for d in docs] == list(STUDY_IDS)
    assert all(d["provenance"]["commit"] == "0123abc" for d in docs)


_LEDGER_FALLBACK_ROW = (
    "Unparsed PTRs excluded",
    "Scanned paper PTRs and PTRs with an unknown layout are excluded; the collector's filing ledger "
    "is not available for this run.",
)
_SYNTHETIC_LEDGER = {
    "house:2022:parsed:": 354,
    "house:2022:unparsed:layout_unknown": 151,
    "house:2022:unparsed:scanned_image": 45,
    "house:2023:parsed:": 400,
    "house:2023:unparsed:layout_unknown": 50,
    "senate:2023:parsed:": 180,
    "senate:2023:unparsed:scanned_image": 20,
    "senate:2024:unparsed:fetch_failed": 7,
    "house:2022:unparsed": 99,  # older 3-part key: not counted
}
_SYNTHETIC_LEDGER_ROWS = [
    (
        "Scanned paper PTRs excluded",
        "Filings 2022–2024: House 45/1000 (4.5%) and Senate 20/207 (9.7%) are scanned paper PTRs that the "
        "parser cannot read.",
    ),
    (
        "House PTRs with an unknown PDF layout excluded",
        "Filings 2022–2024: House 201/1000 (20.1%) electronic PTRs have a PDF layout that house.v1 does not "
        "read; 151 of them were filed in 2022 (27.5% of the House PTRs of that year).",
    ),
    ("Other unparsed PTRs excluded", "Filings 2022–2024: 7 more filings were not parsed."),
]


def test_congress_coverage_gaps_come_from_the_filing_ledger() -> None:
    # No ledger, an empty ledger, a ledger of another type, or only keys in the older shape: one fallback row.
    for meta in (
        {},
        {"congress_ledger": {}},
        {"congress_ledger": "house:2022:parsed:"},
        {"congress_ledger": {"house:2022:unparsed": 5, "house:2022": 7}},
        # The former summary field is not read any more.
        {"congress_scanned_summary": {"house": {"scanned": 45, "total": 1000}}},
    ):
        assert _congress_coverage_gaps(meta) == [_LEDGER_FALLBACK_ROW]

    assert _congress_coverage_gaps({"congress_ledger": _SYNTHETIC_LEDGER}) == _SYNTHETIC_LEDGER_ROWS

    # Only scanned filings are unparsed: one row. A chamber without any filing reads 0/0.
    rows = _congress_coverage_gaps(
        {"congress_ledger": {"house:2022:parsed:": 90, "house:2023:unparsed:scanned_image": 10}}
    )
    assert rows == [
        (
            "Scanned paper PTRs excluded",
            "Filings 2022–2023: House 10/100 (10.0%) and Senate 0/0 are scanned paper PTRs that the "
            "parser cannot read.",
        )
    ]

    # Counts written as text are read as numbers; the year with the most unknown layouts is named.
    rows = _congress_coverage_gaps(
        {
            "congress_ledger": {
                "house:2021:parsed:": "70",
                "house:2021:unparsed:layout_unknown": "10",
                "house:2022:parsed:": "80",
                "house:2022:unparsed:layout_unknown": "40",
            }
        }
    )
    assert [name for name, _text in rows] == [
        "Scanned paper PTRs excluded",
        "House PTRs with an unknown PDF layout excluded",
    ]
    assert "House 0/200 (0.0%) and Senate 0/0" in rows[0][1]
    assert "House 50/200 (25.0%)" in rows[1][1]
    assert "40 of them were filed in 2022 (33.3% of the House PTRs of that year)" in rows[1][1]

    # Other reasons without an unknown layout: the scanned row and the "other" row only.
    rows = _congress_coverage_gaps(
        {"congress_ledger": {"senate:2022:parsed:": 95, "senate:2023:unparsed:fetch_failed": 3, "house:2023:unparsed:no_text": 2}}
    )
    assert [name for name, _text in rows] == ["Scanned paper PTRs excluded", "Other unparsed PTRs excluded"]
    assert rows[1][1] == "Filings 2022–2023: 5 more filings were not parsed."


def test_study_documents_report_window_skips_ledger_gaps_and_premium_bar_diagnostics(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    bars_dir.mkdir(parents=True)
    out_dir = tmp_path / "out"
    days = _make_trading_days(date(2025, 6, 2), 120)
    _write_bars_csv(bars_dir / "SPY.csv", _make_bars(days, start_price=200.0, volume=50_000_000.0))
    _write_bars_csv(bars_dir / "ACME.csv", _make_bars(days, start_price=50.0, volume=2_000_000.0))
    _write_bars_csv(bars_dir / "THIN.csv", _make_bars(days, start_price=50.0, volume=10.0))
    # HALT is liquid up to its last bar on days[62] and has no bar on the next session.
    _write_bars_csv(bars_dir / "HALT.csv", _make_bars(days[:63], start_price=50.0, volume=2_000_000.0))
    (data_dir / "metadata.json").write_text(
        json.dumps({"universe_requested": 600, "bars_not_found": ["GONE1", "GONE2"], "congress_ledger": _SYNTHETIC_LEDGER}),
        encoding="utf-8",
    )

    def congress(doc_id: str, filed_on: date) -> dict[str, Any]:
        return {
            "chamber": "house",
            "doc_id": doc_id,
            "member": "Hon. Member Alpha",
            "holder": "self",
            "ticker": "ACME",
            "transaction_type": "purchase",
            "transaction_date": (filed_on - timedelta(days=5)).isoformat(),
            "filed_on": filed_on.isoformat(),
            "amount_low": 1001,
            "amount_high": 15000,
        }

    # One purchase enters; the one filed on the last benchmark session has no entry day.
    congress_rows = [congress("doc-1", days[50]), congress("doc-2", days[-1])]
    (data_dir / "congress_trades.jsonl").write_text("\n".join(json.dumps(r) for r in congress_rows) + "\n", encoding="utf-8")

    def premium(session: date, ticker: str) -> dict[str, Any]:
        return {"session_date": session.isoformat(), "ticker": ticker, "bullish_premium": 800_000, "bearish_premium": 0, "trade_count": 5}

    # ACME qualifies on 10 sessions; the premium window ends on days[69], the last of them.
    premium_rows = [premium(d, "ACME") for d in days[60:70]]
    premium_rows += [premium(days[60], "NOBAR"), premium(days[61], "NOBAR"), premium(days[60], "THIN"), premium(days[62], "HALT")]
    (data_dir / "market_premium.jsonl").write_text("\n".join(json.dumps(r) for r in premium_rows) + "\n", encoding="utf-8")

    result = run_all_studies(data_dir=data_dir, out_dir=out_dir, ran=date(2026, 11, 25), commit="0123abc")
    docs = {d["id"]: d for d in (json.loads(line) for line in Path(result["studies_jsonl"]).read_text(encoding="utf-8").splitlines())}
    assert sorted(docs) == sorted(STUDY_IDS)

    def robustness(study_id: str, check: str) -> dict[str, Any]:
        (row,) = [r for r in docs[study_id]["robustness"] if r["check"] == check]
        return row

    def gap(study_id: str, name: str) -> str:
        (row,) = [g for g in docs[study_id]["gaps"] if g["gap"] == name]
        return row["choice"]

    # Study 1 has no events at all: every skip counter is zero, the window counter included.
    assert robustness("insider-purchase-confirmation", "Slot Overlap & Capacity Skips") == {
        "check": "Slot Overlap & Capacity Skips",
        "pass": None,
        "result": "skipped_overlap=0, skipped_capacity=0, skipped_illiquid=0, missing_bars=0, outside_window=0",
    }

    # Study 2: the purchase filed on the last session is outside the window, not a missing bar.
    s2 = "smart-money-congress-buys"
    assert robustness(s2, "Deduplication & Capacity Skips")["result"] == (
        "deduped=2 (removed 0 dupes); overlap=0, capacity=0, illiquid=0, missing_bars=0, outside_window=1"
    )
    for name, text in _SYNTHETIC_LEDGER_ROWS:
        assert gap(s2, name) == text
    assert "Unparsed PTRs excluded" not in [g["gap"] for g in docs[s2]["gaps"]]
    assert gap(s2, "Events outside the bar universe").startswith("0 primary events had no bar on the entry day")
    assert result["summaries"][s2]["verdict"] == "needs-more-data"

    # Study 3: 11 top-10 events (10 ACME, 1 HALT).
    # ACME enters after the first session and is held to the window end: 8 overlaps, and the event
    # of the last session has its entry day after the window. HALT has no bar on its entry day.
    s3 = "smart-money-large-bullish-premium"
    assert robustness(s3, "Forward Event Collection Baseline")["result"] == (
        "qualifying_ticker_sessions=11, top10_events=11, entries=1"
    )
    assert robustness(s3, "Slot Overlap, Capacity & Missing-Bar Skips") == {
        "check": "Slot Overlap, Capacity & Missing-Bar Skips",
        "pass": None,
        "result": (
            "events: overlap=8, capacity=0, missing_bars=1, outside_window=1; "
            "ticker-sessions before ranking: without_bars=2, illiquid=1"
        ),
    }
    universe_note = _universe_note({"universe_requested": 600, "bars_not_found": ["GONE1", "GONE2"]}, dict.fromkeys(("SPY", "ACME", "THIN", "HALT"), ()))
    assert "4 of the 600 pre-registered tickers" in universe_note
    assert gap(s3, "Slot capacity") == (
        "The 10 slots stay full for 20 sessions, so 0 of 11 top-10 events were skipped "
        "for capacity and 8 because the ticker was already held."
    )
    assert gap(s3, "Universe cap & survivorship") == universe_note
    assert gap(s2, "Universe cap & survivorship") == universe_note
    assert result["summaries"][s3]["baseline_entries"] == 1

    # Without metadata.json the Congress study falls back to the one generic gap row.
    (data_dir / "metadata.json").unlink()
    result = run_all_studies(data_dir=data_dir, out_dir=tmp_path / "out-no-meta", ran=date(2026, 11, 25), commit="0123abc")
    lines = Path(result["studies_jsonl"]).read_text(encoding="utf-8").splitlines()
    s2_doc = next(d for d in map(json.loads, lines) if d["id"] == s2)
    gaps = {g["gap"]: g["choice"] for g in s2_doc["gaps"]}
    assert gaps[_LEDGER_FALLBACK_ROW[0]] == _LEDGER_FALLBACK_ROW[1]
    assert not any(name in gaps for name, _text in _SYNTHETIC_LEDGER_ROWS)
    assert gaps["Universe cap & survivorship"] == "Daily bars cover 4 tickers (SPY included)."


def test_congress_coverage_gaps_count_every_unparsed_filing_once() -> None:
    # A Senate filing with an unknown layout is in no named row, so it counts as "other".
    rows = dict(
        _congress_coverage_gaps(
            {
                "congress_ledger": {
                    "senate:2022:parsed:": 90,
                    "senate:2022:unparsed:layout_unknown": 7,
                    "senate:2022:unparsed:scanned_image": 3,
                }
            }
        )
    )
    assert rows["Scanned paper PTRs excluded"].startswith("Filings 2022: House 0/0 and Senate 3/100 (3.0%)")
    assert rows["Other unparsed PTRs excluded"] == "Filings 2022: 7 more filings were not parsed."
    assert "House PTRs with an unknown PDF layout excluded" not in rows

