"""Unit tests for smart-money PR 7 backtest engine, signals, DSR, and study documents.

Synthetic fixtures only (public repository). Pure stdlib + services/research modules.
"""
from __future__ import annotations

import csv
import functools
import hashlib
import importlib.util
import inspect
import io
import json
import math
import runpy
import statistics
import sys
import threading
import zipfile
from ast import Import, ImportFrom, parse, walk
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
import strategies.smart_money as smart_money_package
from backtesting.optimizer import DeflatedSharpe, deflated_sharpe_ratio
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
from strategies.smart_money import __main__ as main_module
from strategies.smart_money import document as document_module
from strategies.smart_money import engine as engine_module
from strategies.smart_money.__main__ import (
    POST_HOC_CHECK,
    POST_HOC_GAP_NAME,
    POST_HOC_GAP_NOT_RUN,
    POST_HOC_GAP_RUN,
    POST_HOC_VARIANT,
    GatedStudy,
    PostHocRun,
    RunContext,
    StudyWindow,
    _add_years,
    _congress_coverage_gaps,
    _gate_robustness_rows,
    _hash_files,
    _post_hoc_full_universe,
    _require_events_through,
    _sensitivity_rows,
    _spy_benchmark_stats,
    _universe_note,
    load_bars_dir,
    load_congress_jsonl,
    load_form4_jsonl,
    load_premium_jsonl,
    run_all_studies,
    run_gated_study,
)
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
    count_owner_groups,
    is_option_asset,
)
from strategies.trend_trio.study import moments


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
    deduped, counts = dedupe_congress_purchases(rows)
    assert counts == {"same_filing_lots_merged": 0, "later_filings_dropped": 1, "option_rows_dropped": 0}
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
    (data_dir / "form4_purchases.jsonl").write_text("\n".join(json.dumps(r) for r in [*form4, _IDLE_FORM4_ROW]) + "\n", encoding="utf-8")

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
            "asset_type": "ST",
        }
    ]
    (data_dir / "congress_trades.jsonl").write_text("\n".join(json.dumps(r) for r in [*congress, _IDLE_CONGRESS_ROW]) + "\n", encoding="utf-8")

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

    def run(sessions: int) -> dict[str, Any]:
        premium = [
            {"session_date": d.isoformat(), "ticker": "ACME", "bullish_premium": 800_000, "bearish_premium": 0, "trade_count": 5}
            for d in days[30 : 30 + sessions]
        ]
        _write_event_files(data_dir, premium=premium)
        return run_all_studies(data_dir=data_dir, out_dir=tmp_path / f"out-{sessions}", ran=date(2026, 11, 25), commit="8e1622224")

    with pytest.raises(ValueError, match="pre-register the out-of-sample split"):
        run(510)
    # The guard starts at exactly the holdout length (490 sessions); one session less is still a baseline.
    with pytest.raises(ValueError, match="smart-money-large-bullish-premium: 490 sessions reach the 490-session holdout"):
        run(490)
    assert not (tmp_path / "out-490").exists()
    summary = run(489)["summaries"]["smart-money-large-bullish-premium"]
    assert summary["verdict"] == "needs-more-data"
    assert summary["complete_sessions"] == 489
    assert summary["n_trials"] == 1


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


def _bars_from_closes(days: list[date], closes: list[float], volume: float = 2_000_000.0) -> list[DailyBar]:
    """Bars with open = high = low = close = the given close (no adjustment, no split)."""
    return [DailyBar(d, c, c, c, c, c, volume, c) for d, c in zip(days, closes, strict=True)]


def _growing_bars(days: list[date], rate: float, volume: float = 1_000_000.0) -> list[DailyBar]:
    """Bars from 100: the close is ``rate`` above the open on every session, the open is the previous close."""
    bars: list[DailyBar] = []
    price = 100.0
    for d in days:
        close = price * (1.0 + rate)
        bars.append(DailyBar(d, price, close, price, close, close, volume, close))
        price = close
    return bars


def _hand_returns(sessions: int, trades: list[tuple[int, float]], holding: int, cost_bps: float = 10.0) -> list[float]:
    """Daily portfolio return by hand for ``_growing_bars`` stocks against a flat benchmark.

    Each trade is (entry session, daily rate). It fills one of 10 equal slots for ``holding``
    sessions and pays the cost on its entry day and on its exit day.
    """
    cost = cost_bps / 10_000.0
    out = [0.0] * sessions
    for entry, rate in trades:
        for k in range(holding):
            legs = (k == 0) + (k == holding - 1)
            out[entry + k] += (rate - legs * cost) / 10.0
    return out


def _hand_sharpe(returns: list[float]) -> float:
    """Per-observation Sharpe: mean over sample standard deviation, 0 for a constant series."""
    deviation = statistics.stdev(returns)
    return statistics.fmean(returns) / deviation if deviation > 0 else 0.0


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


# One row per event file that loads but makes no event: a lone purchase in a ticker without bars,
# a sale, and a complete session whose only row is below the premium floor. The Form 4 row and the
# Congress row are dated at the end of their study windows, so the files count as complete.
_IDLE_FORM4_ROW: dict[str, Any] = {
    "accession_number": "idle-1",
    "filing_date": "2026-03-30",
    "issuer_cik": "999",
    "ticker": "IDLE",
    "owner_group_key": "idle",
    "security": "common",
    "shares": 1,
    "price": 1,
}
_IDLE_CONGRESS_ROW: dict[str, Any] = {
    "chamber": "house",
    "doc_id": "idle-1",
    "member": "Member Idle",
    "ticker": "IDLE",
    "transaction_type": "sale",
    "filed_on": "2026-11-20",
    "asset_type": None,
}
_IDLE_PREMIUM_ROW: dict[str, Any] = {
    "session_date": "2020-01-02",
    "ticker": "IDLE",
    "bullish_premium": 1,
    "bearish_premium": 0,
    "trade_count": 1,
}


def _record_calls(monkeypatch: pytest.MonkeyPatch, name: str) -> list[dict[str, Any]]:
    """Record the arguments of every call of a function of the runner module; the function still runs."""
    real = getattr(main_module, name)
    calls: list[dict[str, Any]] = []

    def recorder(*args: Any, **kwargs: Any) -> Any:
        calls.append(dict(inspect.signature(real).bind(*args, **kwargs).arguments))
        return real(*args, **kwargs)

    monkeypatch.setattr(main_module, name, recorder)
    return calls


def _write_event_files(
    data_dir: Path,
    *,
    form4: list[dict[str, Any]] | None = None,
    congress: list[dict[str, Any]] | None = None,
    premium: list[dict[str, Any]] | None = None,
) -> None:
    """Write the three collector event files. The Form 4 and Congress files always end with their
    idle row; the premium file holds its idle row when no rows are given."""
    _write_jsonl(data_dir / "form4_purchases.jsonl", [*(form4 or []), _IDLE_FORM4_ROW])
    _write_jsonl(data_dir / "congress_trades.jsonl", [*(congress or []), _IDLE_CONGRESS_ROW])
    _write_jsonl(data_dir / "market_premium.jsonl", premium if premium is not None else [_IDLE_PREMIUM_ROW])


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
            # AMEND is a complete, valid amendment (Form 4/A): only the original Form 4 counts.
            "SUBMISSION.tsv": [sub("A1"), sub("NO-OWNER"), sub("AMEND", DOCUMENT_TYPE="4/A")],
            "REPORTINGOWNER.tsv": [
                {"ACCESSION_NUMBER": "A1", "RPTOWNERCIK": "0000900001", "RPTOWNER_RELATIONSHIP": "", "RPTOWNER_TITLE": ""},
                # An owner row of a filing that is not a kept Form 4 submission.
                {"ACCESSION_NUMBER": "UNKNOWN", "RPTOWNERCIK": "0000900002", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
                # An owner row without a CIK does not form an owner group.
                {"ACCESSION_NUMBER": "NO-OWNER", "RPTOWNERCIK": "", "RPTOWNER_RELATIONSHIP": "", "RPTOWNER_TITLE": ""},
                {"ACCESSION_NUMBER": "AMEND", "RPTOWNERCIK": "0000900009", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
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
                tx("AMEND", TRANS_SHARES="777"),  # amendment
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

    def buy(acc: str, idx: int, owner: str, shares: float, flagged: bool = False) -> Form4Purchase:
        return Form4Purchase(acc, days[idx], None, "123", "ACME", owner, "Director", "common", shares, 20.0, None, flagged)

    purchases = [
        # First cluster: three owners in three sessions, $6,000 in total.
        buy("a1", 10, "owner1", 100),
        buy("a2", 11, "owner2", 100),
        buy("a3", 12, "owner3", 100),
        # One day after the trigger: inside the 14-day cooldown, so no second event.
        buy("a4", 13, "owner4", 100),
        # Second cluster after the cooldown: $120,000 in total, one owner trades under a 10b5-1 plan.
        buy("b1", 40, "owner5", 2000),
        buy("b2", 41, "owner6", 2000, flagged=True),
        buy("b3", 42, "owner7", 2000),
    ]
    variants, diag = build_signal1_variants(purchases, bars)

    first = SignalEvent("ACME", days[12], 6_000.0)
    second = SignalEvent("ACME", days[42], 120_000.0)
    assert variants["cluster-3p-10d"] == [first, second]
    # The $100,000 floor drops the small cluster, also on the day a fourth owner joins it.
    assert variants["cluster-3p-10d-100k"] == [second]
    # Without the 10b5-1 filing the second window has only two owners.
    assert variants["cluster-3p-10d-no-10b5-1"] == [first]
    # A flat price never closes above its 50-day average, so nothing is confirmed.
    assert variants["cluster-3p-10d-confirm"] == []
    assert variants["cluster-3p-10d-all-issuers"] == [first, second]
    assert sorted(variants) == [
        "cluster-3p-10d",
        "cluster-3p-10d-100k",
        "cluster-3p-10d-all-issuers",
        "cluster-3p-10d-confirm",
        "cluster-3p-10d-no-10b5-1",
        "confirmation-baseline",
    ]
    assert diag == {
        "raw_purchases": 7,
        "cleaned_purchases": 7,
        "ticker_without_bars": 0,
        "no_bar_by_filing_day": 0,
        "price_sanity_rejected": 0,
        "post_2023_10b5_1_flagged": 1,
    }


def test_count_owner_groups_merges_cik_sets_that_share_a_member() -> None:
    assert count_owner_groups([]) == 0
    assert count_owner_groups(["100"]) == 1
    assert count_owner_groups(["100", "200", "300"]) == 3
    assert count_owner_groups(["100", "100", "100"]) == 1
    # A person who files alone and jointly is one group.
    assert count_owner_groups(["100", "100|200"]) == 1
    # Joint filings that share a member chain into one group, in any order.
    assert count_owner_groups(["100|200", "200|300", "300"]) == 1
    assert count_owner_groups(["300", "100|200", "200|300"]) == 1
    assert count_owner_groups(["100|200", "300|400"]) == 2
    # The last key joins two groups that were apart until then.
    assert count_owner_groups(["100|200", "300|400", "500", "200|300"]) == 2
    assert count_owner_groups(iter(["100|200|300", "400"])) == 2

    # A key that repeats after its members were joined through another key must not loop:
    # the union always links group roots. The call runs in a thread so that a loop fails the test.
    counted: list[int] = []
    worker = threading.Thread(
        target=lambda: counted.append(count_owner_groups(["100|200", "200|300", "200|300", "300|100", "400"])),
        daemon=True,
    )
    worker.start()
    worker.join(timeout=10)
    assert not worker.is_alive(), "count_owner_groups did not return"
    assert counted == [2]


def test_insider_cluster_window_is_ten_days_and_cooldown_is_fourteen_days() -> None:
    d0 = date(2024, 3, 1)

    def buy(acc: str, issuer: str, ticker: str, offset: int, owner: str) -> Form4Purchase:
        return Form4Purchase(acc, d0 + timedelta(days=offset), None, issuer, ticker, owner, "Director", "common", 100, 10.0, None)

    purchases = [
        # TEN: the third owner files exactly 10 days after the first one.
        buy("t1", "10", "TEN", 0, "a"),
        buy("t2", "10", "TEN", 5, "b"),
        buy("t3", "10", "TEN", 10, "c"),
        # ELEVEN: 11 days after the first one, so no window holds three owners.
        buy("e1", "11", "ELEVEN", 0, "a"),
        buy("e2", "11", "ELEVEN", 5, "b"),
        buy("e3", "11", "ELEVEN", 11, "c"),
        # COOL: a trigger on day 0, three new owners on day 13 (cooldown), a seventh on day 14.
        buy("c1", "12", "COOL", 0, "a"),
        buy("c2", "12", "COOL", 0, "b"),
        buy("c3", "12", "COOL", 0, "c"),
        buy("c4", "12", "COOL", 13, "d"),
        buy("c5", "12", "COOL", 13, "e"),
        buy("c6", "12", "COOL", 13, "f"),
        buy("c7", "12", "COOL", 14, "g"),
        # JOINT: three filings of one owner group plus one other owner are two groups.
        buy("j1", "13", "JOINT", 0, "1"),
        buy("j2", "13", "JOINT", 1, "1|2"),
        buy("j3", "13", "JOINT", 2, "2|3"),
        buy("j4", "13", "JOINT", 3, "4"),
        # RENAMED: the issuer changes its ticker; the latest filing of the trigger day names it.
        buy("r1", "14", "OLDT", 0, "a"),
        buy("r2", "14", "OLDT", 1, "b"),
        buy("r4", "14", "NEWT", 2, "c"),
        buy("r3", "14", "OLDT", 2, "d"),
    ]
    variants, diag = build_signal1_variants(purchases, {})
    assert variants["cluster-3p-10d-all-issuers"] == [
        SignalEvent("COOL", d0, 3_000.0),
        SignalEvent("NEWT", d0 + timedelta(days=2), 4_000.0),
        SignalEvent("TEN", d0 + timedelta(days=10), 3_000.0),
        # Window of day 14: days 4 to 14, so the four later owners and not the first three.
        SignalEvent("COOL", d0 + timedelta(days=14), 4_000.0),
    ]
    # No ticker has bars, so the tradable variants are empty.
    assert diag["ticker_without_bars"] == len(purchases) == 21
    assert diag["cleaned_purchases"] == 0
    for name in ("confirmation-baseline", "cluster-3p-10d", "cluster-3p-10d-100k", "cluster-3p-10d-confirm", "cluster-3p-10d-no-10b5-1"):
        assert variants[name] == []


def test_form4_price_guard_reads_the_as_printed_close_and_keeps_both_boundaries() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    bars = {
        # A later 40-for-1 split: restated close 2, as-printed close 80.
        "SPLT": _make_bars(days, start_price=2.0, daily_return=0.0, raw_factor=40.0),
        "FLAT": _make_bars(days, start_price=100.0, daily_return=0.0),
    }
    assert bars["SPLT"][20].close == 2.0 and bars["SPLT"][20].raw_close == 80.0
    assert bars["FLAT"][20].raw_close == 100.0

    def cluster(prefix: str, issuer: str, ticker: str, idx: int, shares: float, price: float) -> list[Form4Purchase]:
        return [
            Form4Purchase(f"{prefix}-{n}", days[idx], None, issuer, ticker, f"{prefix}-owner{n}", "Director", "common", shares, price, None)
            for n in range(3)
        ]

    purchases = [
        # Reported at the as-printed price: 1.0x the close of the filing day.
        *cluster("printed", "1", "SPLT", 20, 100, 80.0),
        # Reported at the restated price: 0.025x the as-printed close, although 1.0x the restated one.
        *cluster("restated", "2", "SPLT", 20, 100, 2.0),
        # Against an as-printed close of 100: 4.0x and 0.25x are inside the guard.
        *cluster("high-in", "10", "FLAT", 21, 10, 400.0),
        *cluster("high-out", "11", "FLAT", 22, 10, 400.01),
        *cluster("low-in", "12", "FLAT", 23, 10, 25.0),
        *cluster("low-out", "13", "FLAT", 24, 10, 24.99),
    ]
    variants, diag = build_signal1_variants(purchases, bars)
    # The rank value is the dollar value of the rows that passed, so it shows which rows they are.
    assert variants["cluster-3p-10d"] == [
        SignalEvent("SPLT", days[20], 3 * 100 * 80.0),
        SignalEvent("FLAT", days[21], 3 * 10 * 400.0),
        SignalEvent("FLAT", days[23], 3 * 10 * 25.0),
    ]
    assert diag["raw_purchases"] == 18
    assert diag["cleaned_purchases"] == 9
    assert diag["price_sanity_rejected"] == 9
    # The diagnostic variant runs the cluster rule on every row, rejected or not.
    assert len(variants["cluster-3p-10d-all-issuers"]) == 6


def test_insider_cluster_value_floor_is_inclusive_at_100k() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)
    bars = {sym: _make_bars(days, start_price=100.0, daily_return=0.0) for sym in ("EXACT", "UNDER")}

    def buy(ticker: str, issuer: str, n: int, shares: float) -> Form4Purchase:
        return Form4Purchase(f"{ticker}-{n}", days[20], None, issuer, ticker, f"owner{n}", "Director", "common", shares, 100.0, None)

    purchases = [
        buy("EXACT", "1", 0, 400), buy("EXACT", "1", 1, 300), buy("EXACT", "1", 2, 300),  # $100,000
        buy("UNDER", "2", 0, 400), buy("UNDER", "2", 1, 300), buy("UNDER", "2", 2, 299),  # $99,900
    ]
    variants, _diag = build_signal1_variants(purchases, bars)
    assert variants["cluster-3p-10d"] == [
        SignalEvent("EXACT", days[20], 100_000.0),
        SignalEvent("UNDER", days[20], 99_900.0),
    ]
    assert variants["cluster-3p-10d-100k"] == [SignalEvent("EXACT", days[20], 100_000.0)]


def test_confirmation_baseline_starts_at_the_filing_day_not_the_transaction_day() -> None:
    days = _make_trading_days(date(2024, 1, 2), 90)
    # A steady rise: every close is above the 50-day average and above every earlier close.
    bars = {"ACME": _make_bars(days, start_price=50.0, daily_return=0.004, volume=2_000_000.0)}
    price = bars["ACME"][58].close
    purchases = [
        # Bought on days[50], public on days[58]: $150,000 by a director.
        Form4Purchase("acc1", days[58], days[50], "123", "ACME", "owner1", "Director", "common", 150_000 / price, price, None),
        # Too small for the template (below $100,000), filed one day later.
        Form4Purchase("acc2", days[59], days[57], "123", "ACME", "owner2", "Director", "common", 50_000 / price, price, None),
    ]
    variants, diag = build_signal1_variants(purchases, bars)
    assert diag["cleaned_purchases"] == 2
    (event,) = variants["confirmation-baseline"]
    # The first close above the highest close since the filing day is one session after it.
    # Counting from the transaction day would alert on days[51], before the filing was public.
    assert (event.symbol, event.trigger_day) == ("ACME", days[59])
    # The rank value is the dollar value of all cleaned purchases filed in the 30 days before.
    assert math.isclose(event.rank_value, 200_000.0, rel_tol=1e-12)


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
    acme = _bars_from_closes(days, closes)
    # 56 bars of which two are invalid: 54 usable bars are too few for the 50-day average.
    short = _flat_bars(days[:54]) + [
        DailyBar(days[54], 0.0, 100.0, 100.0, 100.0, 100.0, 1_000_000.0, 100.0),
        DailyBar(days[55], 100.0, 100.0, 100.0, 100.0, 100.0, -1.0, 100.0),
    ]
    events = [
        # Trigger on a non-trading day: the reference window starts at the next session (days[59]).
        SignalEvent("ACME", saturday, 9_000.0),
        SignalEvent("ACME", days[63], 5_000.0),
        SignalEvent("SHORT", days[40], 1.0),
        SignalEvent("EMPTY", days[60], 1.0),
        SignalEvent("NOBARS", days[60], 1.0),
    ]
    confirmed = _apply_price_confirmation(
        events,
        {"ACME": list(reversed(acme)), "SHORT": short, "EMPTY": []},
    )
    assert confirmed == [
        # days[60] and days[61] close above the 50-day average but not above the 70 spike.
        SignalEvent("ACME", days[62], 9_000.0),
        # The second trigger waits for the 14-day alert cooldown: days[72] is the first session after it.
        SignalEvent("ACME", days[72], 5_000.0),
    ]
    assert (days[72] - days[62]).days == 14


def test_cluster_price_confirmation_needs_sma50_a_strictly_higher_close_and_thirty_days() -> None:
    days = _make_trading_days(date(2024, 1, 1), 95)
    trigger = days[60]
    assert days[0].weekday() == 0 and trigger.weekday() == 0  # Mondays
    rising = [100.0 * 1.004**i for i in range(61)]  # up to the trigger day
    top = rising[-1]

    # DIP: 35 closes at 149, 13 at 51, one at 43, the trigger day at 50, 9 at 52, then 101 and 103.
    # The 50 closes that end with 101 sum to 25*149 + 13*51 + 43 + 50 + 9*52 + 101 = 5050: average 101.
    dip = [149.0] * 35 + [51.0] * 13 + [43.0, 50.0] + [52.0] * 9 + [101.0, 103.0]
    dip += [103.0] * (len(days) - len(dip))
    assert dip[49] == 50.0 and dip[59] == 101.0 and sum(dip[10:60]) / 50 == 101.0
    assert sum(dip[11:61]) / 50 == 100.08

    def after_trigger(tail: list[float]) -> list[float]:
        closes = rising + tail
        return closes + [closes[-1]] * (len(days) - len(closes))

    bars = {
        "DIP": _bars_from_closes(days, dip),
        # UP keeps rising: the first later close is already a new high.
        "UP": _bars_from_closes(days, [100.0 * 1.004**i for i in range(len(days))]),
        # PLATEAU repeats the trigger-day close for five sessions, then closes 1% higher.
        "PLATEAU": _bars_from_closes(days, after_trigger([top] * 5 + [top * 1.01])),
        # W30 and W31 stay below the trigger-day close and make a new high 30 or 31 days later.
        "W30": _bars_from_closes(days, after_trigger([top * 0.99] * 21 + [top * 1.05])),
        "W31": _bars_from_closes(days, after_trigger([top * 0.99] * 22 + [top * 1.05])),
    }
    assert (days[82] - trigger).days == 30 and (days[83] - trigger).days == 31
    assert bars["W30"][82].close == top * 1.05 and bars["W31"][83].close == top * 1.05
    assert bars["W31"][82].close == top * 0.99

    events = [
        SignalEvent("DIP", days[49], 5.0),
        SignalEvent("UP", trigger, 4.0),
        SignalEvent("PLATEAU", trigger, 3.0),
        SignalEvent("W30", trigger, 2.0),
        SignalEvent("W31", trigger, 1.0),
    ]
    assert _apply_price_confirmation(events, bars) == [
        # DIP: days[50] (52) is a new high since the trigger but far below the 50-day average;
        # days[59] (101) equals the average, which is not above it; days[60] (103 > 100.08) confirms.
        SignalEvent("DIP", days[60], 5.0),
        # UP: never on the trigger day itself; the next session confirms.
        SignalEvent("UP", days[61], 4.0),
        # PLATEAU: an equal close is not a new high.
        SignalEvent("PLATEAU", days[66], 3.0),
        # W30 confirms on the last day of the window; W31 is one day late and never confirms.
        SignalEvent("W30", days[82], 2.0),
    ]


def test_congress_dedupe_keeps_the_first_filing_and_drops_non_purchases() -> None:
    tx_day = date(2024, 3, 1)
    rows = [
        CongressPurchase("house", "d1", "Rep. Member Alpha", "self", "ACME", "sale", tx_day, date(2024, 3, 10), 1001, 15000),
        CongressPurchase("house", "d2", "Rep. Member Alpha", "self", "--", "purchase", tx_day, date(2024, 3, 10), 1001, 15000),
        # The original comes first; the later amendment is dropped and does not replace it.
        CongressPurchase("House ", "d3", "Rep. Member Alpha", "Self", "acme", "purchase", tx_day, date(2024, 3, 10), 1001, 15000),
        CongressPurchase("house", "d4", "Member Alpha", "self", "ACME", "purchase", tx_day, date(2024, 3, 20), 15001, 50000, amends=True),
        # Same filing day: the original replaces the amendment that was read first.
        CongressPurchase("senate", "d5", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 50001, 100000, amends=True),
        CongressPurchase("senate", "d6", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 15001, 50000),
        # Same filing day, both originals: the lower document id stays.
        CongressPurchase("senate", "d7", "Sen. Member Beta", None, "ACME", "purchase", tx_day, date(2024, 3, 12), 1001, 15000),
        # An earlier filing that is read last still wins: the order of the rows does not matter.
        CongressPurchase("house", "e2", "Member Gamma", "self", "ZETA", "purchase", tx_day, date(2024, 3, 20), 1001, 15000),
        CongressPurchase("house", "e1", "Member Gamma", "self", "ZETA", "purchase", tx_day, date(2024, 3, 15), 15001, 50000),
        CongressPurchase("house", "e0", "Member Gamma", "self", "ZETA", "purchase", tx_day, date(2024, 3, 15), 50001, 100000),
    ]
    deduped, counts = dedupe_congress_purchases(rows)
    assert counts == {"same_filing_lots_merged": 0, "later_filings_dropped": 5, "option_rows_dropped": 0}
    assert [(r.doc_id, r.chamber, r.ticker, r.filed_on, r.amount_low, r.amends) for r in deduped] == [
        ("d3", "house", "ACME", date(2024, 3, 10), 1001, False),
        ("d6", "senate", "ACME", date(2024, 3, 12), 15001, False),
        ("e0", "house", "ZETA", date(2024, 3, 15), 50001, False),
    ]


def test_congress_lots_of_one_filing_are_summed_and_later_filings_do_not_add() -> None:
    tx_day = date(2024, 3, 1)
    filed = date(2024, 3, 10)

    def lot(doc_id: str, ticker: str, low: float | None, high: float | None, *, filed_on: date = filed, amends: bool = False) -> CongressPurchase:
        return CongressPurchase("house", doc_id, "Rep. Member Alpha", "self", ticker, "purchase", tx_day, filed_on, low, high, amends)

    rows = [
        # Three lots of one trade in one filing: the bounds add up; a lot without a range adds nothing.
        lot("L1", "ACME", 25_001, 50_000),
        lot("L1", "ACME", 25_000, 49_999),
        lot("L1", "ACME", None, None),
        # A later amendment of the same trade is another filing: dropped, never added.
        lot("L2", "ACME", 100_001, 250_000, filed_on=date(2024, 3, 25), amends=True),
        # Two lots without a range stay without a range.
        lot("N1", "NORNG", None, None),
        lot("N1", "NORNG", None, None),
        # A lot without a range, then one with a range.
        lot("X1", "MIXD", None, None),
        lot("X1", "MIXD", 1_001, 15_000),
        # A null transaction date is keyed by the filing: its two lots merge, another filing stays apart.
        CongressPurchase("house", "U1", "Rep. Member Alpha", "self", "UNDT", "purchase", None, filed, 1_001, 15_000),
        CongressPurchase("house", "U1", "Rep. Member Alpha", "self", "UNDT", "purchase", None, filed, 1_001, 15_000),
        CongressPurchase("house", "U2", "Rep. Member Alpha", "self", "UNDT", "purchase", None, filed, 1_001, 15_000),
    ]
    deduped, counts = dedupe_congress_purchases(rows)
    assert counts == {"same_filing_lots_merged": 5, "later_filings_dropped": 1, "option_rows_dropped": 0}
    assert [(r.doc_id, r.ticker, r.amount_low, r.amount_high, r.filed_on) for r in deduped] == [
        ("L1", "ACME", 50_001.0, 99_999.0, filed),
        ("X1", "MIXD", 1_001.0, 15_000.0, filed),
        ("N1", "NORNG", None, None, filed),
        ("U1", "UNDT", 2_002.0, 30_000.0, filed),
        ("U2", "UNDT", 1_001, 15_000, filed),
    ]

    variants, diag = build_signal2_variants(rows)
    assert diag == {"raw_rows": 11, "deduped_purchases": 5, "same_filing_lots_merged": 5, "later_filings_dropped": 1, "option_rows_dropped": 0}
    # The summed lower bound reaches the $50,001 floor that neither lot reaches alone.
    assert variants["large-50k"] == [SignalEvent("ACME", filed, 50_001.0)]
    assert variants["all-buys"] == [
        SignalEvent("ACME", filed, 50_001.0),
        SignalEvent("UNDT", filed, 2_002.0),
        SignalEvent("MIXD", filed, 1_001.0),
        SignalEvent("UNDT", filed, 1_001.0),
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
    assert diag == {"raw_rows": 7, "deduped_purchases": 7, "same_filing_lots_merged": 0, "later_filings_dropped": 0, "option_rows_dropped": 0}

    assert variants["multi-member-30d"] == [
        # Second member files 4 days after the first one.
        SignalEvent("ACME", date(2024, 3, 5), 1001.0 + 15001.0),
        # The third member on 2024-03-10 is inside the 14-day cooldown; the next filing day is not.
        SignalEvent("ACME", date(2024, 3, 25), 1001.0 + 15001.0 + 50001.0),
    ]
    assert variants["all-buys"] == [
        SignalEvent("ACME", date(2024, 3, 1), 1001.0),
        SignalEvent("ZETA", date(2024, 3, 4), 1001.0),
        SignalEvent("ACME", date(2024, 3, 5), 15001.0),
        SignalEvent("ZETA", date(2024, 3, 6), 1001.0),
        SignalEvent("ACME", date(2024, 3, 10), 50001.0),
        SignalEvent("OMEGA", date(2024, 4, 1), 1001.0),
    ]
    assert variants["large-50k"] == [SignalEvent("ACME", date(2024, 3, 10), 50001.0)]
    # Delays: 10, 3, 4, 2 and 5 days. The 33-day filing and the filing before its trade date are out.
    assert variants["fast-filed-15d"] == [
        SignalEvent("ACME", date(2024, 3, 1), 1001.0),
        SignalEvent("ZETA", date(2024, 3, 4), 1001.0),
        SignalEvent("ZETA", date(2024, 3, 6), 1001.0),
        SignalEvent("ACME", date(2024, 3, 10), 50001.0),
        SignalEvent("ACME", date(2024, 3, 25), 0.0),
    ]


def test_congress_option_rows_are_dropped_before_lots_and_filings_are_compared() -> None:
    assert [is_option_asset(code) for code in ("OP", " op ", "Stock Option", "Call options", "OPTION")] == [True] * 5
    assert [is_option_asset(code) for code in ("ST", "Stock", "OT", "Corporate Bond", "", None)] == [False] * 6

    tx_day, filed = date(2024, 3, 1), date(2024, 3, 10)

    def row(doc_id: str, ticker: str, asset_type: str | None, low: float, *, filed_on: date = filed) -> CongressPurchase:
        return CongressPurchase("house", doc_id, "Rep. Member Alpha", "self", ticker, "purchase", tx_day, filed_on, low, None, False, asset_type)

    rows = [
        # A stock lot and an option lot of the same trade in one filing: the option lot is not added.
        row("d1", "ACME", "ST", 1_001),
        row("d1", "ACME", "OP", 50_001),
        # An option row in an earlier filing does not take the place of the stock purchase.
        row("d0", "ACME", "Stock Option", 15_001, filed_on=date(2024, 3, 5)),
        # A ticker that has only option rows makes no event at all.
        row("d2", "PUTS", "OP", 100_001),
        # No asset type (older exports) is a stock purchase.
        row("d3", "ZETA", None, 15_001),
        # An option row that is not a purchase, or has no usable ticker, is not counted as dropped option.
        CongressPurchase("house", "d4", "Rep. Member Alpha", "self", "ACME", "sale", tx_day, filed, 1_001, None, False, "OP"),
    ]
    deduped, counts = dedupe_congress_purchases(rows)
    assert counts == {"same_filing_lots_merged": 0, "later_filings_dropped": 0, "option_rows_dropped": 3}
    assert [(r.doc_id, r.ticker, r.amount_low, r.filed_on, r.asset_type) for r in deduped] == [
        ("d1", "ACME", 1_001, filed, "ST"),
        ("d3", "ZETA", 15_001, filed, None),
    ]
    variants, diag = build_signal2_variants(rows)
    assert diag == {"raw_rows": 6, "deduped_purchases": 2, "same_filing_lots_merged": 0, "later_filings_dropped": 0, "option_rows_dropped": 3}
    assert variants["all-buys"] == [SignalEvent("ZETA", filed, 15_001.0), SignalEvent("ACME", filed, 1_001.0)]
    assert variants["large-50k"] == []


def test_event_files_must_reach_the_end_of_the_study_window(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    end = date(2026, 3, 31)
    # Up to 14 days before the window end is complete; later than the window end too.
    assert _require_events_through(end - timedelta(days=14), end, path) is None
    assert _require_events_through(end, end, path) is None
    assert _require_events_through(end + timedelta(days=40), end, path) is None
    with pytest.raises(ValueError) as raised:
        _require_events_through(end - timedelta(days=15), end, path)
    assert str(raised.value) == (
        f"{path} ends on 2026-03-16, more than 14 days before the window end 2026-03-31; "
        "run scripts/smart-money-pr7/fetch_data.py again"
    )

    # The runner checks the newest Form 4 filing against 2026-03-31 and the newest Congress
    # filing against 2026-11-23, whatever the order of the rows.
    data_dir = tmp_path / "data"
    (data_dir / "bars").mkdir(parents=True)
    days = _make_trading_days(date(2024, 1, 2), 60)
    _write_bars_csv(data_dir / "bars" / "SPY.csv", _make_bars(days, start_price=200.0, volume=50_000_000.0))

    def run(form4_newest: str, congress_newest: str) -> dict[str, Any]:
        _write_event_files(data_dir)
        _write_jsonl(data_dir / "form4_purchases.jsonl", [{**_IDLE_FORM4_ROW, "filing_date": form4_newest}, {**_IDLE_FORM4_ROW, "filing_date": "2020-01-02"}])
        _write_jsonl(data_dir / "congress_trades.jsonl", [{**_IDLE_CONGRESS_ROW, "filed_on": congress_newest}, {**_IDLE_CONGRESS_ROW, "filed_on": "2020-01-02"}])
        return run_all_studies(data_dir=data_dir, out_dir=tmp_path / "out", ran=date(2026, 11, 25), commit="0123abc")

    with pytest.raises(ValueError, match="form4_purchases.jsonl ends on 2026-03-16, more than 14 days before the window end 2026-03-31"):
        run("2026-03-16", "2026-11-09")
    with pytest.raises(ValueError, match="congress_trades.jsonl ends on 2026-11-08, more than 14 days before the window end 2026-11-23"):
        run("2026-03-17", "2026-11-08")
    assert not (tmp_path / "out").exists()
    assert sorted(run("2026-03-17", "2026-11-09")["summaries"]) == sorted(STUDY_IDS)


def test_congress_variant_boundaries_are_inclusive() -> None:
    def buy(doc_id: str, member: str, ticker: str, tx: date, filed_on: date, low: float) -> CongressPurchase:
        return CongressPurchase("house", doc_id, member, "self", ticker, "purchase", tx, filed_on, low, None)

    d0 = date(2024, 5, 1)
    rows = [
        # Amount floors: $1,001 and $50,001 are in, one dollar less is out.
        buy("a1", "Member Alpha", "AT1001", d0 - timedelta(days=40), d0, 1_001),
        buy("a2", "Member Alpha", "AT1000", d0 - timedelta(days=40), d0, 1_000),
        buy("a3", "Member Alpha", "AT50001", d0 - timedelta(days=40), d0, 50_001),
        buy("a4", "Member Alpha", "AT50000", d0 - timedelta(days=40), d0, 50_000),
        # Reporting delay: 0 and 15 days are fast, 16 days is not.
        buy("f0", "Member Alpha", "DELAY0", d0, d0, 1_001),
        buy("f15", "Member Alpha", "DELAY15", d0 - timedelta(days=15), d0, 1_001),
        buy("f16", "Member Alpha", "DELAY16", d0 - timedelta(days=16), d0, 1_001),
        # Second member 30 days after the first one: inside the window. 31 days: outside.
        buy("w1", "Member Alpha", "WIN30", d0 - timedelta(days=40), d0, 1_001),
        buy("w2", "Member Beta", "WIN30", d0 - timedelta(days=40), d0 + timedelta(days=30), 15_001),
        buy("w3", "Member Alpha", "WIN31", d0 - timedelta(days=40), d0, 1_001),
        buy("w4", "Member Beta", "WIN31", d0 - timedelta(days=40), d0 + timedelta(days=31), 15_001),
        # A multi-member event, then a third member exactly 14 days later: the cooldown is over.
        buy("c1", "Member Alpha", "COOL14", d0 - timedelta(days=40), d0, 1_001),
        buy("c2", "Member Beta", "COOL14", d0 - timedelta(days=40), d0, 1_001),
        buy("c3", "Member Gamma", "COOL14", d0 - timedelta(days=40), d0 + timedelta(days=13), 1_001),
        buy("c4", "Member Delta", "COOL14", d0 - timedelta(days=40), d0 + timedelta(days=14), 1_001),
    ]
    variants, _diag = build_signal2_variants(rows)
    assert "AT1001" in {e.symbol for e in variants["all-buys"]}
    assert "AT1000" not in {e.symbol for e in variants["all-buys"]}
    assert sorted(e.symbol for e in variants["large-50k"]) == ["AT50001"]
    assert sorted(e.symbol for e in variants["fast-filed-15d"]) == ["DELAY0", "DELAY15"]
    assert variants["multi-member-30d"] == [
        SignalEvent("COOL14", d0, 2_002.0),
        SignalEvent("COOL14", d0 + timedelta(days=14), 4_004.0),
        SignalEvent("WIN30", d0 + timedelta(days=30), 16_002.0),
    ]


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
        # No price history: the row keeps its rank. It is 13th here, and first in the next session.
        MarketPremiumRow(sday, "NOBAR", 900_000.0, 0.0, 5),
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
        "qualifying_ticker_sessions": 15,
        "premium_rows_without_bars": 2,
        "top10_events_without_bars": 1,
        "premium_rows_illiquid": 1,
        "selected_top10_events": 12,
    }
    first_session = [e for e in events if e.trigger_day == sday]
    assert [e.symbol for e in first_session] == ["T12", "T11", "T10", "T09", "T08", "T07", "T06", "T05", "T04", "T02"]
    assert first_session[0] == SignalEvent("T12", sday, 1_110_000.0)
    # Sessions are emitted in date order; the rank value is bullish minus bearish premium.
    assert events[10:] == [SignalEvent("NOBAR", next_day, 900_000.0), SignalEvent("T01", next_day, 600_000.0)]


def test_signal3_ranks_by_net_premium_and_keeps_the_inclusive_floors() -> None:
    days = _make_trading_days(date(2025, 10, 1), 30)
    sday, next_day = days[25], days[26]
    fillers = [f"F{i}" for i in range(1, 10)]
    with_bars = ("HEDGED", "CLEAN", "TAIL", "FLOOR", "SHARE", "BELOW", "UNDER", "TWO", *fillers)
    bars = {sym: _make_bars(days, start_price=100.0, volume=500_000.0) for sym in with_bars}
    bars["EMPTY"] = []  # a ticker that is listed but has no bar is a ticker without bars
    # FRESH and NEWER are new listings. FRESH has its first bar on the session day: it has bars, and
    # one bar is too few for the liquidity test. NEWER has its first bar one session later: on the
    # session day it is a ticker without bars, so it keeps its rank (the last one here).
    bars["FRESH"] = _make_bars(days[26:], start_price=100.0, volume=500_000.0)
    bars["NEWER"] = _make_bars(days[27:], start_price=100.0, volume=500_000.0)
    rows = [
        # Net premium: INDEX 2.4M (no bars), CLEAN 2.0M, HEDGED 1.8M, F9..F1 1.09M..1.01M, TAIL 0.9M.
        # Bullish premium alone would put HEDGED first and TAIL fourth.
        MarketPremiumRow(sday, "HEDGED", 3_000_000.0, 1_200_000.0, 9),
        MarketPremiumRow(sday, "TAIL", 1_500_000.0, 600_000.0, 9),
        MarketPremiumRow(sday, "CLEAN", 2_000_000.0, 0.0, 9),
        MarketPremiumRow(sday, "INDEX", 2_500_000.0, 100_000.0, 9),
        *[MarketPremiumRow(sday, sym, 1_000_000.0 + 10_000.0 * i, 0.0, 9) for i, sym in enumerate(fillers, start=1)],
        # Exactly at the floors: $500,000 bullish premium with 3 trades, and a 70% bullish share.
        MarketPremiumRow(next_day, "FLOOR", 500_000.0, 0.0, 3),
        MarketPremiumRow(next_day, "SHARE", 700_000.0, 300_000.0, 3),
        # Just below them.
        MarketPremiumRow(next_day, "BELOW", 699_999.0, 300_001.0, 3),
        MarketPremiumRow(next_day, "UNDER", 499_999.99, 0.0, 3),
        MarketPremiumRow(next_day, "TWO", 500_000.0, 0.0, 2),
        MarketPremiumRow(next_day, "EMPTY", 600_000.0, 0.0, 3),
        MarketPremiumRow(next_day, "FRESH", 5_000_000.0, 0.0, 9),
        MarketPremiumRow(next_day, "NEWER", 300_000.0 + 200_000.0, 150_000.0, 9),
    ]
    events, diag = build_signal3_events(rows, bars)
    assert events == [
        SignalEvent("INDEX", sday, 2_400_000.0),
        SignalEvent("CLEAN", sday, 2_000_000.0),
        SignalEvent("HEDGED", sday, 1_800_000.0),
        *[SignalEvent(f"F{i}", sday, 1_000_000.0 + 10_000.0 * i) for i in range(9, 2, -1)],
        SignalEvent("EMPTY", next_day, 600_000.0),
        SignalEvent("FLOOR", next_day, 500_000.0),
        SignalEvent("SHARE", next_day, 400_000.0),
        SignalEvent("NEWER", next_day, 350_000.0),
    ]
    # The ticker without bars takes one of the ten places: F2, F1 and TAIL are cut.
    assert len([e for e in events if e.trigger_day == sday]) == 10
    # INDEX, EMPTY and NEWER count in both "without bars" counters; FRESH fails the liquidity test.
    assert diag == {
        "complete_sessions": 2,
        "non_complete_rows_skipped": 0,
        "qualifying_ticker_sessions": 17,
        "premium_rows_without_bars": 3,
        "top10_events_without_bars": 3,
        "premium_rows_illiquid": 1,
        "selected_top10_events": 14,
    }


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


def test_liquidity_reads_the_median_of_exactly_the_last_twenty_dollar_volumes() -> None:
    days = _make_trading_days(date(2024, 1, 2), 30)

    def volume_bars(dollar_volumes: list[float]) -> tuple[list[DailyBar], dict[date, int]]:
        bars = [DailyBar(d, 100.0, 100.0, 100.0, 100.0, 100.0, dv / 100.0, 100.0) for d, dv in zip(days, dollar_volumes)]
        return bars, {b.day: i for i, b in enumerate(bars)}

    # 17 sessions at $1M and 3 at $1,000M: the median is $1M, the mean is about $151M.
    bars, index = volume_bars([1e6] * 17 + [1e9] * 3)
    assert check_point_in_time_liquidity(bars, index, days[19]) is False
    # 9 sessions without a trade and 11 at $20M: the median is $20M, the mean is $11M.
    bars, index = volume_bars([0.0] * 9 + [20e6] * 11)
    assert check_point_in_time_liquidity(bars, index, days[19], min_median_dollar_vol=15e6) is True

    # Sessions 2..21 are the window of session 21: ten at $5M and ten at $15M, median $10M.
    # Session 1 before it and session 22 after it are at $5M; either one would pull the median to $5M.
    bars, index = volume_bars([5e6] * 12 + [15e6] * 10 + [5e6] * 8)
    assert check_point_in_time_liquidity(bars, index, days[21]) is True
    assert check_point_in_time_liquidity(bars, index, days[21], lookback=21) is False

    # Dollar volume is the restated close times the restated volume (both move with a later split).
    # A later 40-for-1 split: restated close 2, as-printed close 80, 2,000,000 restated shares: $4M.
    split = [DailyBar(d, 2.0, 2.0, 2.0, 2.0, 2.0, 2_000_000.0, 80.0) for d in days]
    assert check_point_in_time_liquidity(split, {b.day: i for i, b in enumerate(split)}, days[25]) is False
    assert check_point_in_time_liquidity(split, {b.day: i for i, b in enumerate(split)}, days[25], min_median_dollar_vol=4e6) is True


def test_portfolio_checks_liquidity_as_of_the_trigger_day_not_the_entry_day() -> None:
    days = _make_trading_days(date(2024, 1, 2), 40)
    spy = _flat_bars(days)

    def printed(until_trigger: float, from_entry: float) -> list[DailyBar]:
        """Liquid bars whose as-printed close changes between the trigger day days[25] and the entry day."""
        return [
            DailyBar(d, 100.0, 100.0, 100.0, 100.0, 100.0, 1_000_000.0, until_trigger if i <= 25 else from_entry)
            for i, d in enumerate(days)
        ]

    bars = {"RISES": printed(4.0, 6.0), "FALLS": printed(6.0, 4.0)}
    events = [SignalEvent("RISES", days[25], 1.0), SignalEvent("FALLS", days[25], 1.0)]
    res = simulate_event_portfolio(events, bars, spy, PortfolioConfig(holding_days=5))
    # RISES printed $4 on the trigger day: below the $5 floor when the signal was public.
    # FALLS printed $6 then; its $4 on the entry day was not known yet.
    assert [(p.symbol, p.entry_day) for p in res.positions] == [("FALLS", days[26])]
    assert res.skipped_illiquid == 1


def test_portfolio_metrics_of_a_known_daily_return_series() -> None:
    days = _make_trading_days(date(2024, 1, 2), 8)
    assert (days[0], days[7]) == (date(2024, 1, 2), date(2024, 1, 11))
    # One slot, no cost, flat benchmark. The stock opens at 100 on days[1] and returns
    # +2%, +3%, -1%, -4%, +1% on days[1]..days[5]; it is flat before and after.
    closes = [100.0, 102.0, 105.06, 104.0094, 99.849024, 100.84751424, 100.84751424, 100.84751424]
    opens = [100.0, *closes[:-1]]
    stock = [DailyBar(d, o, max(o, c), min(o, c), c, c, 1_000_000.0, c) for d, o, c in zip(days, opens, closes, strict=True)]
    res = simulate_event_portfolio(
        [SignalEvent("KNOWN", days[0], 1.0)],
        {"KNOWN": stock},
        _flat_bars(days),
        PortfolioConfig(holding_days=5, max_slots=1, cost_bps=0.0, require_liquidity=False),
        oos_start=days[3],
    )
    expected_daily = [0.0, 0.02, 0.03, -0.01, -0.04, 0.01, 0.0, 0.0]
    assert len(res.daily_excess_returns) == 8
    for got, want in zip(res.daily_excess_returns, expected_daily, strict=True):
        assert math.isclose(got, want, abs_tol=1e-12)

    whole = res.whole
    assert (whole.days, whole.trades) == (8, 1)
    # Mean 0.01 / 8 = 0.00125. Sum of squared deviations 0.0031 - 8 * 0.00125^2 = 0.0030875.
    # Sample variance 0.0030875 / 7; 252 sessions per year.
    per_obs = 0.00125 / math.sqrt(0.0030875 / 7)
    assert math.isclose(whole.per_obs_sharpe, per_obs, rel_tol=1e-9)
    assert math.isclose(whole.sharpe, per_obs * math.sqrt(252), rel_tol=1e-9)
    assert math.isclose(whole.sharpe, 0.9448346684, abs_tol=1e-9)
    # Final equity 1.02 * 1.03 * 0.99 * 0.96 * 1.01 = 1.0084751424 over 9 calendar days of 365.25.
    assert math.isclose(whole.cagr, 1.0084751424 ** (365.25 / 9) - 1.0, rel_tol=1e-9)
    assert math.isclose(whole.cagr, 0.4084646375, abs_tol=1e-9)
    # Peak 1.0506 after days[2], trough 1.0506 * 0.99 * 0.96 after days[4].
    assert math.isclose(whole.max_drawdown, 0.99 * 0.96 - 1.0, abs_tol=1e-12)
    assert math.isclose(whole.max_drawdown, -0.0496, abs_tol=1e-12)
    assert math.isclose(whole.exposure, 5 / 8, abs_tol=1e-12)
    assert whole.win_rate == 1.0 and whole.profit_factor is None
    assert math.isclose(res.positions[0].gross_excess_return, 0.0084751424, abs_tol=1e-12)
    assert res.monthly_equity == ({"month": "2024-01", "value": 0.008475, "drawdown": -0.040096},)

    # Out of sample from days[3]: -1%, -4%, +1%, 0, 0 over 6 calendar days.
    oos = res.oos
    assert res.oos_days == tuple(days[3:])
    # The position entered on days[1], before the out-of-sample start: it is not an out-of-sample event.
    assert (oos.days, oos.trades) == (5, 0)
    # Mean -0.04 / 5 = -0.008. Sum of squared deviations 0.0018 - 5 * 0.008^2 = 0.00148.
    oos_per_obs = -0.008 / math.sqrt(0.00148 / 4)
    assert math.isclose(oos.per_obs_sharpe, oos_per_obs, rel_tol=1e-9)
    assert math.isclose(oos.sharpe, oos_per_obs * math.sqrt(252), rel_tol=1e-9)
    assert math.isclose(oos.cagr, (0.99 * 0.96 * 1.01) ** (365.25 / 6) - 1.0, rel_tol=1e-9)
    assert math.isclose(oos.max_drawdown, 0.99 * 0.96 - 1.0, abs_tol=1e-12)
    assert math.isclose(oos.exposure, 3 / 5, abs_tol=1e-12)
    assert oos.win_rate == 0.0 and oos.profit_factor is None

    # A position that enters on the first out-of-sample session is an out-of-sample event.
    on_start = simulate_event_portfolio(
        [SignalEvent("KNOWN", days[0], 1.0)],
        {"KNOWN": stock},
        _flat_bars(days),
        PortfolioConfig(holding_days=5, max_slots=1, cost_bps=0.0, require_liquidity=False),
        oos_start=days[1],
    )
    assert (on_start.oos.days, on_start.oos.trades) == (7, 1)
    assert on_start.oos.win_rate == 1.0


def test_portfolio_returns_use_adjusted_prices_and_open_to_close_on_the_entry_day() -> None:
    days = _make_trading_days(date(2024, 1, 2), 8)

    def bar(i: int, open_: float, close: float, adj_close: float) -> DailyBar:
        return DailyBar(days[i], open_, max(open_, close), min(open_, close), close, adj_close, 1_000_000.0, close)

    # Stock: adjustment factor 0.5 up to days[3], 0.55 from days[4] (a dividend in between).
    # days[3] gaps up from 100 to 110 and closes at 112.2: +2% open to close, +12.2% close to close.
    # days[4] closes at 113.322: +1% on the close, +11.1% on the adjusted close (62.3271 / 56.1).
    stock = [bar(i, 100.0, 100.0, 50.0) for i in range(3)]
    stock += [bar(3, 110.0, 112.2, 56.1), bar(4, 112.2, 113.322, 62.3271)]
    stock += [bar(i, 113.322, 113.322, 62.3271) for i in range(5, 8)]
    # Benchmark: factor 0.95 up to days[3]. days[3] gaps up from 400 to 404 and closes at 408.04:
    # +1% open to close, +2.01% close to close. days[4]: flat close, +1% adjusted close.
    spy = [bar(i, 400.0, 400.0, 380.0) for i in range(3)]
    spy += [bar(3, 404.0, 408.04, 387.638), bar(4, 408.04, 408.04, 391.51438)]
    spy += [bar(i, 408.04, 408.04, 391.51438) for i in range(5, 8)]

    res = simulate_event_portfolio(
        [SignalEvent("DIVD", days[2], 1.0)],
        {"DIVD": stock},
        spy,
        PortfolioConfig(holding_days=2, max_slots=1, cost_bps=0.0, require_liquidity=False),
    )
    pos = res.positions[0]
    assert (pos.entry_day, pos.exit_day) == (days[3], days[4])
    # Entry day: open to close for both legs, 2% - 1%. Next day: adjusted close to adjusted close, 11.1% - 1%.
    assert math.isclose(res.daily_excess_returns[3], 0.02 - 0.01, abs_tol=1e-12)
    assert math.isclose(res.daily_excess_returns[4], 0.111 - 0.01, abs_tol=1e-12)
    assert math.isclose(pos.gross_excess_return, 1.01 * 1.101 - 1.0, abs_tol=1e-12)
    assert [r for i, r in enumerate(res.daily_excess_returns) if i not in (3, 4)] == [0.0] * 6


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
    # Exposure is the filled share of the slots: 2 of 4 slots on 5 of 40 sessions.
    four_slots = simulate_event_portfolio(events[:2], bars, spy, PortfolioConfig(holding_days=5, max_slots=4))
    assert len(four_slots.positions) == 2
    assert math.isclose(four_slots.whole.exposure, (2 / 4) * 5 / 40)
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


def test_verdict_gate_boundaries_are_inclusive_and_nan_fails() -> None:
    at_the_bars: dict[str, Any] = {
        "oos_sessions": 490,
        "oos_events": 100,
        "oos_sharpe": 0.0004,
        "dsr_probability": 0.95,
        "stress_oos_sharpe": 0.0004,
        "n_trials": 12,
    }
    assert evaluate_verdict(**at_the_bars) == (
        "edge",
        "Passed pre-registered gate over 490 OOS sessions: 100 OOS events, OOS excess Sharpe 0.000 at 10 bps/side "
        "(20 bps stress 0.000), DSR 0.950 >= 0.95 (N = 12). Research only.",
    )

    def gate(**changed: Any) -> tuple[str, str]:
        return evaluate_verdict(**{**at_the_bars, **changed})

    def failed(reasons: str, sharpe: str = "0.000", dsr: str = "0.950") -> tuple[str, str]:
        return (
            "no-edge",
            f"Failed pre-registered gate over 490 OOS sessions: {reasons}. "
            f"Primary OOS excess Sharpe {sharpe}, DSR {dsr} (N = 12). Research only.",
        )

    # One step below each bar.
    assert gate(oos_sessions=489) == (
        "needs-more-data",
        "Observed history has 489 OOS sessions (< 490 required for 24-month holdout). "
        "Rule is frozen (N = 12) for forward out-of-sample collection.",
    )
    assert gate(oos_events=99) == failed("OOS events 99 < 100")
    assert gate(oos_sharpe=0.0) == failed("OOS annualized excess Sharpe 0.000 <= 0")
    assert gate(oos_sharpe=-0.25) == failed("OOS annualized excess Sharpe -0.250 <= 0", sharpe="-0.250")
    assert gate(dsr_probability=0.9494) == failed("DSR 0.949 < 0.95 (N = 12)", dsr="0.949")
    assert gate(dsr_probability=None) == failed("DSR 0.000 < 0.95 (N = 12)", dsr="0.000")
    assert gate(stress_oos_sharpe=0.0) == failed("20 bps stress OOS Sharpe 0.000 <= 0")
    assert gate(stress_oos_sharpe=None) == failed("20 bps stress OOS Sharpe was not computed")
    # Well above the bars is still an edge.
    assert gate(oos_sessions=900, oos_events=400, oos_sharpe=2.0, dsr_probability=1.0, stress_oos_sharpe=1.5)[0] == "edge"

    # A NaN input fails its bar instead of slipping through a comparison.
    nan = float("nan")
    assert gate(oos_sharpe=nan) == failed("OOS annualized excess Sharpe nan <= 0", sharpe="nan")
    assert gate(dsr_probability=nan) == failed("DSR nan < 0.95 (N = 12)", dsr="nan")
    assert gate(stress_oos_sharpe=nan) == failed("20 bps stress OOS Sharpe nan <= 0")

    # Every failed bar is named, in a fixed order. A short history comes before all of them.
    assert gate(oos_events=0, oos_sharpe=-1.0, dsr_probability=0.5, stress_oos_sharpe=-2.0) == failed(
        "OOS events 0 < 100; OOS annualized excess Sharpe -1.000 <= 0; DSR 0.500 < 0.95 (N = 12); "
        "20 bps stress OOS Sharpe -2.000 <= 0",
        sharpe="-1.000",
        dsr="0.500",
    )
    assert gate(oos_sessions=0, oos_events=0, oos_sharpe=-1.0, dsr_probability=None, stress_oos_sharpe=None)[0] == "needs-more-data"

    # The bars can be set by the caller; the defaults are 490 sessions, 100 events and 0.95.
    assert gate(oos_sessions=10, oos_events=5, dsr_probability=0.5, min_oos_sessions=10, min_oos_events=5, dsr_pass=0.5)[0] == "edge"
    assert gate(oos_sessions=10, oos_events=5, dsr_probability=0.5, min_oos_sessions=11, min_oos_events=5, dsr_pass=0.5)[0] == "needs-more-data"
    assert gate(oos_sessions=10, oos_events=5, dsr_probability=0.5, min_oos_sessions=10, min_oos_events=6, dsr_pass=0.5)[0] == "no-edge"
    assert gate(oos_sessions=10, oos_events=5, dsr_probability=0.5, min_oos_sessions=10, min_oos_events=5, dsr_pass=0.51)[0] == "no-edge"


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
            robustness=[{"check": "Check", "pass": None, "result": "r" * 300}],
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
    assert doc["robustness"] == [{"check": "Check", "pass": None, "result": "r" * 300}]


def test_study_document_refuses_disclosure_text_over_the_contract_limit() -> None:
    study_id = "smart-money-congress-buys"

    def build(**overrides: Any) -> dict[str, Any]:
        return build_study_document(**_study_kwargs(_portfolio_result(), study_id=study_id, **overrides))

    # Exactly at the limit: unchanged, with no ellipsis.
    doc = build(
        gaps=[("g" * 300, "c" * 400)],
        rules=[("Item", "r" * 400, "Source")],
        robustness=[{"check": "Check", "pass": True, "result": "o" * 300}],
        verdict_reason="v" * 1000,
    )
    assert doc["gaps"] == [{"choice": "c" * 400, "gap": "g" * 300}]
    assert doc["rules"] == [{"item": "Item", "rule": "r" * 400, "source": "Source"}]
    assert doc["robustness"] == [{"check": "Check", "pass": True, "result": "o" * 300}]
    assert doc["verdictReason"] == "v" * 1000

    # Whitespace is collapsed before the length test: 400 characters after it, many more before.
    words = ["abcd", *["ab"] * 132]
    collapsed = " ".join(words)
    spaced = "  " + "   ".join(words) + " \n"
    assert len(collapsed) == 400 and len(spaced) > 600
    assert build(gaps=[("Gap", spaced)])["gaps"] == [{"choice": collapsed, "gap": "Gap"}]
    assert build(verdict_reason="  Two   words \n")["verdictReason"] == "Two words"

    # One character over: the run stops and the message names the study and the field.
    too_long: list[tuple[dict[str, Any], str]] = [
        ({"gaps": [("Gap name", "c" * 401)]}, f"{study_id} gap 'Gap name' text has 401 characters; the study contract allows 400"),
        ({"gaps": [("g" * 301, "Choice")]}, f"{study_id} gap '{'g' * 301}' name has 301 characters; the study contract allows 300"),
        ({"rules": [("Item", "r" * 401, "Source")]}, f"{study_id} rule 'Item' has 401 characters; the study contract allows 400"),
        (
            {"robustness": [{"check": "Check", "pass": None, "result": "o" * 301}]},
            f"{study_id} robustness 'Check' result has 301 characters; the study contract allows 300",
        ),
        ({"verdict_reason": "v" * 1001}, f"{study_id} verdict reason has 1001 characters; the study contract allows 1000"),
        ({"gaps": [("Gap", spaced + " ab")]}, f"{study_id} gap 'Gap' text has 403 characters; the study contract allows 400"),
    ]
    for overrides, message in too_long:
        with pytest.raises(ValueError) as raised:
            build(**overrides)
        assert str(raised.value) == message

    # Labels are still cut with an ellipsis and never stop the run.
    doc = build(title="t" * 201, equity_label="e" * 201, rules=[("i" * 61, "Rule", "s" * 201)])
    assert doc["title"] == "t" * 199 + "…"
    assert doc["equityLabel"] == "e" * 199 + "…"
    assert doc["rules"] == [{"item": "i" * 59 + "…", "rule": "Rule", "source": "s" * 199 + "…"}]


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
    # A missing file and a file without rows stop the run; an empty result is never returned.
    absent = tmp_path / "absent.jsonl"
    blank = tmp_path / "blank.jsonl"
    blank.write_text("\n   \n\n", encoding="utf-8")
    for loader in (load_form4_jsonl, load_congress_jsonl, load_premium_jsonl):
        with pytest.raises(FileNotFoundError, match="absent.jsonl is missing"):
            loader(absent)
        with pytest.raises(ValueError, match="blank.jsonl has no rows"):
            loader(blank)

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
                "asset_type": "OP",
            },
            {
                "chamber": "senate",
                "doc_id": "uuid-1",
                "member": "Sen. Member Beta",
                "holder": "",
                "ticker": "ZETA",
                "transaction_type": "purchase",
                "filed_on": "2024-03-12",
                "asset_type": "",
            },
        ],
    )
    assert load_congress_jsonl(congress_path) == [
        CongressPurchase("house", "20010001", "Hon. Member Alpha", "spouse", "ACME", "purchase", date(2024, 3, 1), date(2024, 3, 10), 0.0, 15000.0, True, "OP"),
        CongressPurchase("senate", "uuid-1", "Sen. Member Beta", None, "ZETA", "purchase", None, date(2024, 3, 12), None, None, False, None),
    ]

    # Every Congress row needs the asset_type key (null is a value): without it an option row
    # would count as a stock purchase.
    keyless = tmp_path / "congress_old.jsonl"
    _write_jsonl(keyless, [{**_IDLE_CONGRESS_ROW, "asset_type": "ST"}, {k: v for k, v in _IDLE_CONGRESS_ROW.items() if k != "asset_type"}])
    with pytest.raises(ValueError) as raised:
        load_congress_jsonl(keyless)
    assert str(raised.value) == f"{keyless} has rows without asset_type; run scripts/smart-money-pr7/fetch_data.py again"
    _write_jsonl(keyless, [{**_IDLE_CONGRESS_ROW, "asset_type": None}])
    assert [row.asset_type for row in load_congress_jsonl(keyless)] == [None]

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


def test_data_hash_covers_file_names_sizes_and_contents(tmp_path: Path) -> None:
    first, second, missing = tmp_path / "a.jsonl", tmp_path / "b.csv", tmp_path / "missing.csv"
    first.write_bytes(b"alpha\n")
    second.write_bytes(b"beta\n")

    def by_hand(*parts: bytes) -> str:
        return "sha256:" + hashlib.sha256(b"".join(parts)).hexdigest()[:24]

    # Per file, in path order: the name, the size in bytes as text, the bytes.
    expected = by_hand(b"a.jsonl", b"6", b"alpha\n", b"b.csv", b"5", b"beta\n")
    assert _hash_files([first, second]) == expected
    assert _hash_files([second, first]) == expected
    # A path that does not exist adds only its name.
    assert _hash_files([first, missing, second]) == by_hand(b"a.jsonl", b"6", b"alpha\n", b"b.csv", b"5", b"beta\n", b"missing.csv")
    assert _hash_files([]) == by_hand()
    # Same name and size, other bytes: another hash.
    second.write_bytes(b"BETA\n")
    assert _hash_files([first, second]) == by_hand(b"a.jsonl", b"6", b"alpha\n", b"b.csv", b"5", b"BETA\n")
    assert _hash_files([first, second]) != expected


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
    _write_event_files(data_dir)

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
    # 60 sessions and event files without one event: every study is short of the holdout window.
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


def test_study_documents_report_window_skips_ledger_gaps_and_premium_bar_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    premium_bars_dir = data_dir / "bars_premium"
    bars_dir.mkdir(parents=True)
    premium_bars_dir.mkdir()
    days = _make_trading_days(date(2025, 6, 2), 120)
    assert (days[32], days[60], days[69], days[-1]) == (date(2025, 7, 16), date(2025, 8, 25), date(2025, 9, 5), date(2025, 11, 14))
    acme = _make_bars(days, start_price=50.0, volume=2_000_000.0)
    _write_bars_csv(bars_dir / "SPY.csv", _make_bars(days, start_price=200.0, volume=50_000_000.0))
    _write_bars_csv(bars_dir / "ACME.csv", acme)
    _write_bars_csv(bars_dir / "THIN.csv", _make_bars(days, start_price=50.0, volume=10.0))
    # HALT is liquid up to its last bar on days[62] and has no bar on the next session.
    _write_bars_csv(bars_dir / "HALT.csv", _make_bars(days[:63], start_price=50.0, volume=2_000_000.0))
    # DUP is in both bar directories: liquid in bars/, thin in bars_premium/. The main bars win.
    _write_bars_csv(bars_dir / "DUP.csv", _make_bars(days, start_price=50.0, volume=2_000_000.0))
    _write_bars_csv(premium_bars_dir / "DUP.csv", _make_bars(days, start_price=50.0, volume=10.0))
    # LATE has its first bar on days[67], one session after its premium row.
    _write_bars_csv(bars_dir / "LATE.csv", _make_bars(days[67:], start_price=50.0, volume=2_000_000.0))
    # EXTRA has bars only in bars_premium/ (a premium ticker outside the 600-ticker cap).
    _write_bars_csv(premium_bars_dir / "EXTRA.csv", _make_bars(days, start_price=50.0, volume=2_000_000.0))
    meta = {"universe_requested": 600, "bars_not_found": ["GONE1", "GONE2"], "congress_ledger": _SYNTHETIC_LEDGER}
    (data_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")

    def form4(accession: str, filing: date, ticker: str, issuer: str, owner: str, price: float, **extra: Any) -> dict[str, Any]:
        return {
            "accession_number": accession,
            "filing_date": filing.isoformat(),
            "transaction_date": None,
            "issuer_cik": issuer,
            "ticker": ticker,
            "owner_group_key": owner,
            "role_text": "Ten percent owner",
            "security": "common",
            "shares": 100,
            "price": price,
            **extra,
        }

    # One cluster in a ticker with bars (three owners on days[30]..days[32]; one row is a 10b5-1 trade).
    form4_rows = [
        form4(f"acme-{i}", days[30 + i], "ACME", "1", f"acme-owner-{i}", acme[30 + i].close, is_10b5_1=(i == 1))
        for i in range(3)
    ]
    # Four clusters in a ticker without bars: before the window, in sample, out of sample, after the window.
    for year, month, day in ((2015, 6, 1), (2023, 5, 10), (2025, 8, 4), (2026, 4, 6)):
        form4_rows += [
            form4(f"zzzz-{year}-{i}", date(year, month, day + i), "ZZZZ", "2", f"zzzz-owner-{i}", 10.0) for i in range(3)
        ]

    def congress(doc_id: str, traded: date, filed_on: date, **extra: Any) -> dict[str, Any]:
        return {
            "chamber": "house",
            "doc_id": doc_id,
            "member": "Hon. Member Alpha",
            "holder": "self",
            "ticker": "ACME",
            "transaction_type": "purchase",
            "transaction_date": traded.isoformat(),
            "filed_on": filed_on.isoformat(),
            "amount_low": 1001,
            "amount_high": 15000,
            "asset_type": "ST",
            **extra,
        }

    congress_rows = [
        congress("doc-1", days[45], days[50]),
        # The same trade in a later amendment: dropped.
        congress("doc-4", days[45], days[55], amends=True),
        # Two lots of one trade in one filing: merged.
        congress("doc-3", days[75], days[80]),
        congress("doc-3", days[75], days[80]),
        # Filed on the last benchmark session: no entry day.
        congress("doc-2", days[110], days[-1]),
        # An option purchase (House code OP) is not a stock purchase: dropped before everything else.
        congress("doc-5", days[40], days[44], asset_type="OP"),
    ]

    def premium(session: date, ticker: str, bullish: float = 800_000, **extra: Any) -> dict[str, Any]:
        return {"session_date": session.isoformat(), "ticker": ticker, "bullish_premium": bullish, "bearish_premium": 0, "trade_count": 5, **extra}

    # ACME qualifies on 10 sessions; the premium window ends on days[69], the last complete session.
    premium_rows = [premium(d, "ACME") for d in days[60:70]]
    premium_rows += [
        premium(days[60], "NOBAR", 900_000),
        premium(days[61], "NOBAR", 900_000),
        premium(days[60], "THIN"),
        premium(days[62], "HALT"),
        premium(days[64], "DUP"),
        premium(days[66], "EXTRA"),
        premium(days[66], "LATE"),
        # A complete session of the source on a Saturday (no trading session): its entry day is days[65].
        premium(date(2025, 8, 30), "ACME"),
        premium(days[75], "ACME", session_status="partial"),
    ]
    _write_event_files(data_dir, form4=form4_rows, congress=congress_rows, premium=premium_rows)

    gated_calls = _record_calls(monkeypatch, "run_gated_study")
    simulate_calls = _record_calls(monkeypatch, "simulate_event_portfolio")
    result = run_all_studies(data_dir=data_dir, out_dir=tmp_path / "out", ran=date(2026, 11, 25), commit="0123abc")
    docs = {d["id"]: d for d in (json.loads(line) for line in Path(result["studies_jsonl"]).read_text(encoding="utf-8").splitlines())}
    assert list(docs) == list(STUDY_IDS)
    s1, s2, s3 = STUDY_IDS
    summaries = result["summaries"]

    def robustness(study_id: str, check: str) -> dict[str, Any]:
        (row,) = [r for r in docs[study_id]["robustness"] if r["check"] == check]
        return row

    def gap(study_id: str, name: str) -> str:
        (row,) = [g for g in docs[study_id]["gaps"] if g["gap"] == name]
        return row["choice"]

    def rule(study_id: str, item: str) -> str:
        (row,) = [r for r in docs[study_id]["rules"] if r["item"] == item]
        return row["rule"]

    # ---- pre-registered windows, variants and primary trials ------------------------------------
    s1_window = StudyWindow(start=date(2016, 1, 1), end=date(2026, 3, 31), oos_start=date(2024, 4, 1))
    s2_window = StudyWindow(start=date(2022, 1, 1), end=date(2026, 11, 23), oos_start=date(2024, 11, 23))
    s1_names = ("confirmation-baseline", "cluster-3p-10d", "cluster-3p-10d-100k", "cluster-3p-10d-confirm")
    s2_names = ("all-buys", "large-50k", "fast-filed-15d", "multi-member-30d")
    assert [(c["study_id"], c["window"], tuple(c["variant_names"]), c["primary_variant"]) for c in gated_calls] == [
        (s1, s1_window, s1_names, "cluster-3p-10d"),
        (s2, s2_window, s2_names, "all-buys"),
    ]
    assert all(name in gated_calls[0]["variants"] for name in s1_names)
    assert all(name in gated_calls[1]["variants"] for name in s2_names)

    trials = json.loads(Path(result["trials_json"]).read_text(encoding="utf-8"))
    assert [(t["study_id"], t["variant"], t["holding_days"]) for t in trials] == [
        *[(s1, name, holding) for name in s1_names for holding in (5, 20, 60)],
        *[(s2, name, holding) for name in s2_names for holding in (5, 20, 60)],
        (s3, "top10-500k", 20),
    ]
    assert {t["cost_bps"] for t in trials} == {10.0}
    assert [(t["study_id"], t["variant"], t["holding_days"]) for t in trials if t["is_primary"]] == [
        (s1, "cluster-3p-10d", 20),
        (s2, "all-buys", 20),
        (s3, "top10-500k", 20),
    ]

    # 14 runs per gated study (12 trials and 2 cost stress runs), the 10b5-1 run of study 1, the baseline of study 3.
    assert len(simulate_calls) == 14 + 1 + 14 + 1
    no_plan_run = simulate_calls[14]
    assert no_plan_run["config"] == PortfolioConfig(holding_days=20, cost_bps=10.0)
    assert (no_plan_run["start_day"], no_plan_run["end_day"], no_plan_run["oos_start"]) == (s1_window.start, s1_window.end, s1_window.oos_start)
    assert no_plan_run["events"] == []  # without the 10b5-1 row only two owners are left
    for call in simulate_calls[15:29]:
        assert (call["start_day"], call["end_day"], call["oos_start"]) == (s2_window.start, s2_window.end, s2_window.oos_start)
    premium_run = simulate_calls[29]
    assert premium_run["config"] == PortfolioConfig(holding_days=20, cost_bps=10.0, require_liquidity=True)
    assert (premium_run["start_day"], premium_run["end_day"], premium_run["oos_start"]) == (days[60], days[69], None)
    assert len(premium_run["events"]) == 17
    assert sorted(premium_run["bars_by_symbol"]) == ["ACME", "DUP", "EXTRA", "HALT", "LATE", "SPY", "THIN"]
    assert premium_run["bars_by_symbol"]["DUP"][0].volume == 2_000_000.0

    # ---- study 1 ---------------------------------------------------------------------------------
    short_history = (
        "Observed history has 120 OOS sessions (< 490 required for 24-month holdout). "
        "Rule is frozen (N = 12) for forward out-of-sample collection."
    )
    assert (summaries[s1]["verdict"], summaries[s1]["reason"]) == ("needs-more-data", short_history)
    assert (docs[s1]["verdict"], docs[s1]["verdictReason"]) == ("needs-more-data", short_history)
    assert (summaries[s1]["oos_events"], summaries[s1]["n_trials"]) == (1, 12)
    assert (summaries[s1]["baseline_oos_events"], summaries[s1]["baseline_oos_sharpe"]) == (0, 0.0)
    assert robustness(s1, "OOS Event Count (bar >= 100)") == {
        "check": "OOS Event Count (bar >= 100)",
        "pass": False,
        "result": "1 OOS entries over 120 sessions (2024-04-01..2026-03-31)",
    }
    assert rule(s1, "Verdict Gate") == (
        "OOS >= 24m (2024-04-01..2026-03-31), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N=12."
    )
    assert robustness(s1, "Slot Overlap & Capacity Skips")["result"] == (
        "skipped_overlap=0, skipped_capacity=0, skipped_illiquid=0, missing_bars=0, outside_window=0"
    )
    assert robustness(s1, "Post-2023 Rule 10b5-1 Exclusion Sensitivity")["result"] == (
        "Excluding 1 10b5-1 rows: OOS Sharpe=0.000 (0 OOS events)"
    )
    # Of the four clusters without bars, two are in the window (one in sample, one out of sample).
    assert gap(s1, "Cluster events outside the bar universe") == (
        "1 of 3 cluster events in the window (1 of 2 tickers) remain after the bar universe and the price guard; "
        "out of sample 1 of 2. "
        "The out-of-sample event count therefore also reflects the 600-ticker cap."
    )
    assert gap(s1, "Form 4 rows outside the bar universe") == (
        "13 of 16 code-P Form 4 rows are in tickers without bars and 0 were filed before the first bar of their "
        "ticker; 0 exits were truncated."
    )
    assert gap(s1, "SEC decimal typos / ticker reuse").startswith("Rejected 0 Form 4 rows whose reported price fell outside [0.25x, 4.0x]")
    assert gap(s1, "Share-volume floor of the confirmation baseline").startswith("The template's 1,000,000-share average-volume floor")
    assert docs[s1]["notes"] == (
        "Raw code-P Form 4 purchases loaded: 16; cleaned: 3. "
        "Primary trial (cluster-3p-10d, H=20): whole trades=1, OOS trades=1. "
        "Confirmation baseline (H=20): whole trades=0, OOS trades=0."
    )
    sensitivity = docs[s1]["sensitivity"]
    assert [row["param"] for row in sensitivity] == [f"{name} | H={holding}" for name in s1_names for holding in (5, 20, 60)]
    assert sensitivity[1] == {
        "cagr": 0.0,
        "maxDrawdown": 0.0,
        "param": "confirmation-baseline | H=20",
        "sharpe": 0.0,
        "trades": 0,
        "value": "OOS 0 ev, Sharpe +0.000",
    }
    assert sensitivity[4]["trades"] == 1 and sensitivity[4]["value"].startswith("OOS 1 ev, Sharpe ")
    # Runs: primary, confirmation baseline, $100k floor, price confirmation, 20 bps stress.
    # The three purchases are worth about $15,000, and the rising price confirms the cluster.
    assert [run["trades"] for run in docs[s1]["forms"][0]["runs"]] == [1, 0, 0, 1, 1]

    # ---- study 2 ---------------------------------------------------------------------------------
    assert (summaries[s2]["verdict"], summaries[s2]["reason"]) == ("needs-more-data", short_history)
    assert (summaries[s2]["oos_events"], summaries[s2]["n_trials"]) == (2, 12)
    assert robustness(s2, "OOS Event Count (bar >= 100)")["result"] == "2 OOS entries over 120 sessions (2024-11-23..2026-11-23)"
    assert rule(s2, "Verdict Gate") == (
        "OOS >= 24m (2024-11-23..2026-11-23), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N=12."
    )
    # The purchase filed on the last session is outside the window, not a missing bar.
    assert robustness(s2, "Deduplication & Capacity Skips")["result"] == (
        "trades=3 (dropped 1 option rows, merged 1 same-filing lots, dropped 1 later filings); "
        "overlap=0, capacity=0, illiquid=0, missing_bars=0, outside_window=1"
    )
    assert gap(s2, "Option rows excluded").startswith("1 purchase rows report an option (House OP, Senate Stock Option)")
    for name, text in _SYNTHETIC_LEDGER_ROWS:
        assert gap(s2, name) == text
    assert "Unparsed PTRs excluded" not in [g["gap"] for g in docs[s2]["gaps"]]
    assert gap(s2, "Events outside the bar universe") == (
        "0 primary events had no bar on the entry day (ticker outside the bar universe or not trading); "
        "0 exits were truncated."
    )
    universe_note = _universe_note(meta, dict.fromkeys(("SPY", "ACME", "THIN", "HALT", "DUP", "LATE"), ()))
    assert "6 of the 600 pre-registered tickers" in universe_note
    assert gap(s1, "Universe cap & survivorship") == universe_note
    assert gap(s2, "Universe cap & survivorship") == universe_note
    assert docs[s2]["notes"] == (
        "Raw Congress purchase rows: 7; trades after dropping option rows, merging lots and dropping later filings: 3. "
        "Primary trial (all-buys, H=20): whole trades=2, OOS trades=2."
    )

    # ---- no bars_events/ folder: the post-hoc full-universe check is reported as not run ------------
    not_run = {"check": POST_HOC_CHECK, "pass": None, "result": "Not run: the collector's bars_events folder has no bars."}
    assert POST_HOC_CHECK == "Post-hoc: full event universe (not in the verdict)"
    for study_id in (s1, s2):
        assert robustness(study_id, POST_HOC_CHECK) == not_run
        assert docs[study_id]["robustness"][-1] == not_run
        assert summaries[study_id]["post_hoc_full_universe"] is None
        assert gap(study_id, "Post-hoc full-universe check") == POST_HOC_GAP_NOT_RUN
    assert "post_hoc_full_universe" not in summaries[s3]
    assert POST_HOC_CHECK not in [r["check"] for r in docs[s3]["robustness"]]
    assert "Post-hoc full-universe check" not in [g["gap"] for g in docs[s3]["gaps"]]

    # ---- study 3 ---------------------------------------------------------------------------------
    # 17 top-10 events: 11 ACME (one of a Saturday session), 2 NOBAR, HALT, DUP, EXTRA and LATE.
    # THIN fails the liquidity test. ACME enters after the first session and is held to the window
    # end: 9 overlaps, and the event of the last session has its entry day after the window. NOBAR
    # (twice) and HALT have no bar on the entry day. LATE has a bar on the entry day but none before
    # it, so its liquidity is unknown and it is skipped. DUP and EXTRA enter.
    assert summaries[s3]["verdict"] == docs[s3]["verdict"] == "needs-more-data"
    assert summaries[s3]["reason"].startswith(
        "Insufficient history: 10 trading sessions (11 complete QuantData sessions in the source, 2025-08-25 to "
        "2025-09-05, ~0.4 months < 24-month holdout of 490 sessions). Rule top10-500k (H=20) is frozen at N = 1 with "
        "zero parameter sweep; full evaluation unlocks on 2027-08-25. Descriptive baseline over observed window: "
        "3 entries, excess Sharpe "
    )
    assert (summaries[s3]["complete_sessions"], summaries[s3]["trading_sessions"]) == (11, 10)
    assert (summaries[s3]["baseline_entries"], summaries[s3]["n_trials"]) == (3, 1)
    assert robustness(s3, "24-Month OOS History Requirement (>= 490 sessions)") == {
        "check": "24-Month OOS History Requirement (>= 490 sessions)",
        "pass": False,
        "result": "10 trading sessions (11 complete sessions in the source, 2025-08-25..2025-09-05); unlocks 2027-08-25.",
    }
    assert robustness(s3, "Forward Event Collection Baseline")["result"] == (
        "qualifying_ticker_sessions=17, top10_events=17, entries=3"
    )
    assert robustness(s3, "Slot Overlap, Capacity & Missing-Bar Skips") == {
        "check": "Slot Overlap, Capacity & Missing-Bar Skips",
        "pass": None,
        "result": (
            "events: overlap=9, capacity=0, missing_bars=3, no_bar_before_entry=1, outside_window=1; "
            "ticker-sessions before ranking: without_bars=3, illiquid=1"
        ),
    }
    assert gap(s3, "Top-10 tickers without bars") == (
        "3 of 17 top-10 events are in tickers without a daily bar on or before the session (index options and "
        "tickers Yahoo Finance has no history for). They keep their rank and are not traded."
    )
    assert gap(s3, "Slot capacity") == (
        "The 10 slots stay full for 20 sessions, so 0 of 17 top-10 events were skipped for capacity and 9 because "
        "the ticker was already held."
    )
    assert gap(s3, "History below 2-year holdout") == (
        "QuantData exposes ~1 year of history (2025-08-25..2025-09-05: 10 trading sessions; the source marks 11 "
        "sessions complete, exchange holidays with index rows included). Verdict stays needs-more-data until 2027-08-25."
    )
    assert docs[s3]["notes"] == (
        "Trading sessions: 10; complete sessions in the source: 11 (2025-08-25..2025-09-05). "
        "Rule frozen at N = 1 (top10-500k, H=20); full evaluation unlocks 2027-08-25."
    )
    (s3_run,) = docs[s3]["forms"][0]["runs"]
    assert (s3_run["from"], s3_run["to"], s3_run["trades"]) == ("2025-08-25", "2025-09-05", 3)
    assert s3_run["oosCagr"] is None and s3_run["oosSharpe"] is None
    assert docs[s3]["sensitivity"] == []

    # ---- data hashes: the event file of the study and every bar file it reads ----------------------
    main_bar_paths = sorted(bars_dir.glob("*.csv"))
    premium_bar_paths = sorted(premium_bars_dir.glob("*.csv"))
    assert len(main_bar_paths) == 6 and len(premium_bar_paths) == 2
    assert docs[s1]["provenance"]["dataHash"] == _hash_files([data_dir / "form4_purchases.jsonl", *main_bar_paths])
    assert docs[s2]["provenance"]["dataHash"] == _hash_files([data_dir / "congress_trades.jsonl", *main_bar_paths])
    assert docs[s3]["provenance"]["dataHash"] == _hash_files(
        [data_dir / "market_premium.jsonl", *main_bar_paths, *premium_bar_paths]
    )

    # ---- a second run: no metadata.json, and one changed premium bar file --------------------------
    (data_dir / "metadata.json").unlink()
    _write_bars_csv(premium_bars_dir / "EXTRA.csv", _make_bars(days, start_price=60.0, volume=2_000_000.0))
    result = run_all_studies(data_dir=data_dir, out_dir=tmp_path / "out-no-meta", ran=date(2026, 11, 25), commit="0123abc")
    again = {d["id"]: d for d in (json.loads(line) for line in Path(result["studies_jsonl"]).read_text(encoding="utf-8").splitlines())}
    gaps = {g["gap"]: g["choice"] for g in again[s2]["gaps"]}
    assert gaps[_LEDGER_FALLBACK_ROW[0]] == _LEDGER_FALLBACK_ROW[1]
    assert not any(name in gaps for name, _text in _SYNTHETIC_LEDGER_ROWS)
    assert gaps["Universe cap & survivorship"] == "Daily bars cover 6 tickers (SPY included)."
    # The data hash of a study covers its event file and the bars it reads: only study 3 reads bars_premium/.
    hashes = {study_id: (docs[study_id]["provenance"]["dataHash"], again[study_id]["provenance"]["dataHash"]) for study_id in STUDY_IDS}
    assert all(old.startswith("sha256:") and len(old) == len("sha256:") + 24 for old, _new in hashes.values())
    assert len({old for old, _new in hashes.values()}) == 3
    assert hashes[s1][0] == hashes[s1][1] and hashes[s2][0] == hashes[s2][1]
    assert hashes[s3][0] != hashes[s3][1]


def test_post_hoc_full_universe_run_counts_as_one_more_trial_and_leaves_the_verdict_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    bars_dir = data_dir / "bars"
    event_bars_dir = data_dir / "bars_events"
    bars_dir.mkdir(parents=True)
    days = _make_trading_days(date(2024, 1, 2), 320)
    s1_oos, s2_oos = 64, 234  # first out-of-sample session of study 1 and of study 2
    assert (days[s1_oos], days[s2_oos]) == (date(2024, 4, 1), date(2024, 11, 25))
    acme_rate, zzzz_rate = 0.0005, 0.001
    acme, zzzz = _growing_bars(days, acme_rate, volume=2_000_000.0), _growing_bars(days, zzzz_rate)
    spy = _flat_bars(days, price=400.0, volume=50_000_000.0)
    # The capped universe holds SPY and ACME. ZZZZ has events too, but its bars are outside the cap.
    _write_bars_csv(bars_dir / "SPY.csv", spy)
    _write_bars_csv(bars_dir / "ACME.csv", acme)

    def form4(accession: str, filing: date, ticker: str, issuer: str, owner: str, price: float, shares: float = 10, role: str = "Ten percent owner") -> dict[str, Any]:
        return {
            "accession_number": accession,
            "filing_date": filing.isoformat(),
            "issuer_cik": issuer,
            "ticker": ticker,
            "owner_group_key": owner,
            "role_text": role,
            "security": "common",
            "shares": shares,
            "price": price,
        }

    def cluster(ticker: str, issuer: str, first: int, bars: list[DailyBar]) -> list[dict[str, Any]]:
        """Three owners file on three sessions in a row; the cluster triggers on the third one."""
        return [
            form4(f"{ticker}-{first}-{i}", days[first + i], ticker, issuer, f"{ticker}-owner-{i}", bars[first + i].close)
            for i in range(3)
        ]

    def director_buy(accession: str, filed: int) -> dict[str, Any]:
        """A $150,000 purchase by a director: it counts for the confirmation baseline only."""
        price = acme[filed].close
        return form4(accession, days[filed], "ACME", "1", accession, price, shares=150_000 / price, role="Director")

    def purchase(doc_id: str, ticker: str, filed: int, low: float = 1001) -> dict[str, Any]:
        return {
            "chamber": "house",
            "doc_id": doc_id,
            "member": "Hon. Member Alpha",
            "holder": "self",
            "ticker": ticker,
            "transaction_type": "purchase",
            "transaction_date": (days[filed] - timedelta(days=20)).isoformat(),
            "filed_on": days[filed].isoformat(),
            "amount_low": low,
            "amount_high": None,
            "asset_type": None,
        }

    _write_event_files(
        data_dir,
        form4=[
            # Cluster triggers: ACME on days[22] and on days[64] (the first out-of-sample day),
            # ZZZZ on days[32] and days[152].
            *cluster("ACME", "1", 20, acme),
            *cluster("ACME", "1", 62, acme),
            *cluster("ZZZZ", "2", 30, zzzz),
            *cluster("ZZZZ", "2", 150, zzzz),
            # A cluster in ACME after the study window (it ends on 2026-03-31).
            *[form4(f"late-{i}", date(2026, 4, 6 + i), "ACME", "1", f"late-owner-{i}", acme[-1].close) for i in range(3)],
            # Confirmation-baseline alerts one session after each filing: days[53] and days[201].
            director_buy("director-1", 52),
            director_buy("director-2", 200),
        ],
        congress=[
            purchase("a1", "ACME", 50),
            purchase("a2", "ACME", 150, low=50_001),
            purchase("a3", "ACME", 240),
            purchase("z1", "ZZZZ", 60),
            purchase("z2", "ZZZZ", 250),
        ],
    )
    # Entry sessions (the session after the trigger) and daily rates, per counted variant of each study.
    # Study 1: confirmation baseline, cluster, $100k cluster (none: the clusters are worth about $3,000),
    # confirmed cluster (the rising price confirms the second cluster one session later; the first one
    # has no 50-day average inside its 30 days). Study 2: all buys, large buys, fast filings, multi-member.
    s1_id, s2_id, s3_id = STUDY_IDS
    capped_trades = {
        s1_id: [[(54, acme_rate), (202, acme_rate)], [(23, acme_rate), (65, acme_rate)], [], [(66, acme_rate)]],
        s2_id: [[(51, acme_rate), (151, acme_rate), (241, acme_rate)], [(151, acme_rate)], [], []],
    }
    primary_index = {s1_id: 1, s2_id: 0}
    full_trades = {
        s1_id: [(23, acme_rate), (65, acme_rate), (33, zzzz_rate), (153, zzzz_rate)],
        s2_id: [(51, acme_rate), (151, acme_rate), (241, acme_rate), (61, zzzz_rate), (251, zzzz_rate)],
    }
    oos_from = {s1_id: s1_oos, s2_id: s2_oos}

    def annual(returns: list[float]) -> float:
        return _hand_sharpe(returns) * math.sqrt(252)

    def entered(trades: list[tuple[int, float]], holding: int) -> list[tuple[int, float]]:
        """A ticker that is still held is not entered again (each rate stands for one ticker)."""
        kept: list[tuple[int, float]] = []
        for entry, rate in trades:
            if not any(r == rate and e + holding > entry for e, r in kept):
                kept.append((entry, rate))
        return kept

    # At 60 sessions the ACME cluster of days[64] finds ACME still held since session 23.
    assert entered(capped_trades[s1_id][1], 60) == [(23, acme_rate)]
    assert all(entered(trades, 20) == trades for study in capped_trades.values() for trades in study)

    dsr_calls = _record_calls(monkeypatch, "compute_study_dsr")
    simulate_calls = _record_calls(monkeypatch, "simulate_event_portfolio")

    def run(name: str) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
        dsr_calls.clear()
        simulate_calls.clear()
        result = run_all_studies(data_dir=data_dir, out_dir=tmp_path / name, ran=date(2026, 11, 25), commit="0123abc")
        lines = Path(result["studies_jsonl"]).read_text(encoding="utf-8").splitlines()
        docs = {doc["id"]: doc for doc in map(json.loads, lines)}
        return docs, result["summaries"], json.loads(Path(result["trials_json"]).read_text(encoding="utf-8"))

    def post_hoc_row(doc: dict[str, Any]) -> dict[str, Any]:
        (row,) = [r for r in doc["robustness"] if r["check"] == POST_HOC_CHECK]
        return row

    def post_hoc_gap(doc: dict[str, Any]) -> str:
        (row,) = [g for g in doc["gaps"] if g["gap"] == POST_HOC_GAP_NAME]
        return row["choice"]

    def gated_part(doc: dict[str, Any]) -> dict[str, Any]:
        """The document without the post-hoc row, the post-hoc gap and the data hash."""
        kept = dict(doc)
        kept["robustness"] = [r for r in doc["robustness"] if r["check"] != POST_HOC_CHECK]
        kept["gaps"] = [g for g in doc["gaps"] if g["gap"] != POST_HOC_GAP_NAME]
        kept["provenance"] = {k: v for k, v in doc["provenance"].items() if k != "dataHash"}
        return kept

    not_run = {"check": POST_HOC_CHECK, "pass": None, "result": "Not run: the collector's bars_events folder has no bars."}

    # ---- run 1: no bars_events/ folder -------------------------------------------------------------
    capped_docs, capped_summaries, capped_trials = run("out-capped")
    assert len(dsr_calls) == 2 and len(simulate_calls) == 14 + 1 + 14 + 1
    assert len(capped_trials) == 25
    for study_id, oos_sessions in ((s1_id, 256), (s2_id, 86)):
        summary = capped_summaries[study_id]
        assert post_hoc_row(capped_docs[study_id]) == not_run
        assert post_hoc_gap(capped_docs[study_id]) == POST_HOC_GAP_NOT_RUN
        assert summary["post_hoc_full_universe"] is None
        assert (summary["oos_events"], summary["n_trials"]) == (1, 12)
        assert summary["reason"].startswith(f"Observed history has {oos_sessions} OOS sessions")
        # The gated out-of-sample Sharpe is the one of the capped universe, by hand.
        by_hand = annual(_hand_returns(320, capped_trades[study_id][primary_index[study_id]], 20)[oos_from[study_id] :])
        assert math.isclose(summary["oos_sharpe"], by_hand, abs_tol=1e-4)
    # The two Congress purchases in ZZZZ have no bar in the capped universe.
    assert "missing_bars=2" in next(r for r in capped_docs[s2_id]["robustness"] if r["check"] == "Deduplication & Capacity Skips")["result"]

    # Study 1: the window and the out-of-sample boundary of the cluster coverage text. Two of the
    # three ACME clusters are in the window; the one of 2024-04-01 is the first out-of-sample day.
    (coverage,) = [g["choice"] for g in capped_docs[s1_id]["gaps"] if g["gap"] == "Cluster events outside the bar universe"]
    assert coverage == (
        "2 of 4 cluster events in the window (1 of 2 tickers) remain after the bar universe and the price guard; "
        "out of sample 1 of 2. The out-of-sample event count therefore also reflects the 600-ticker cap."
    )
    # Study 1: the confirmation baseline is reported at 20 sessions, with its out-of-sample events.
    baseline_whole = _hand_returns(320, capped_trades[s1_id][0], 20)
    assert capped_summaries[s1_id]["baseline_oos_events"] == 1
    assert math.isclose(capped_summaries[s1_id]["baseline_oos_sharpe"], annual(baseline_whole[s1_oos:]), abs_tol=1e-4)
    assert "Confirmation baseline (H=20): whole trades=2, OOS trades=1." in capped_docs[s1_id]["notes"]
    baseline_run = capped_docs[s1_id]["forms"][0]["runs"][1]
    assert (baseline_run["symbol"], baseline_run["trades"]) == ("Confirmation Baseline (H=20)", 2)
    assert math.isclose(baseline_run["sharpe"], annual(baseline_whole), abs_tol=1e-5)
    assert math.isclose(baseline_run["oosSharpe"], annual(baseline_whole[s1_oos:]), abs_tol=1e-5)
    assert not math.isclose(annual(baseline_whole), annual(_hand_returns(320, capped_trades[s1_id][0], 5)), rel_tol=0.05)
    baseline_row = capped_docs[s1_id]["comparison"][1]
    assert baseline_row["name"] == "Confirmation baseline (H=20, excess)"
    assert math.isclose(baseline_row["sharpe"], annual(baseline_whole), abs_tol=1e-5)
    # Study 2: the large-purchase run is reported at 20 sessions too.
    large_whole = _hand_returns(320, capped_trades[s2_id][1], 20)
    large_run = capped_docs[s2_id]["forms"][0]["runs"][1]
    assert (large_run["symbol"], large_run["trades"]) == ("Large Buys >= $50k (H=20)", 1)
    assert math.isclose(large_run["sharpe"], annual(large_whole), abs_tol=1e-5)
    assert not math.isclose(annual(large_whole), annual(_hand_returns(320, capped_trades[s2_id][1], 5)), rel_tol=0.05)
    large_row = capped_docs[s2_id]["comparison"][1]
    assert large_row["name"] == "Large >= $50k (H=20, excess)"
    assert math.isclose(large_row["sharpe"], annual(large_whole), abs_tol=1e-5)

    # ---- run 2: a bars_events/ folder without one usable bar is the same as no folder ----------------
    event_bars_dir.mkdir()
    (event_bars_dir / "NOROWS.csv").write_text("date,open,high,low,close,adj_close,volume,raw_close\n", encoding="utf-8")
    assert run("out-empty-folder") == (capped_docs, capped_summaries, capped_trials)
    assert len(dsr_calls) == 2

    # ---- run 3: bars_events/ holds ZZZZ, and a thin copy of ACME that must lose against bars/ACME.csv --
    _write_bars_csv(event_bars_dir / "ZZZZ.csv", zzzz)
    _write_bars_csv(event_bars_dir / "ACME.csv", _flat_bars(days, volume=10.0))
    # The collector's counts of the further tickers go into the row text.
    (data_dir / "metadata.json").write_text(json.dumps({"event_bars_extra_cached": 1, "event_bars_extra_requested": 2}), encoding="utf-8")
    full_docs, full_summaries, full_trials = run("out-full")

    # Nothing of the gated study moves: verdict, reason, events, Sharpe, DSR, N, trials, every document field.
    assert full_docs[s3_id] == capped_docs[s3_id]
    assert full_summaries[s3_id] == capped_summaries[s3_id]
    for study_id in (s1_id, s2_id):
        assert gated_part(full_docs[study_id]) == gated_part(capped_docs[study_id])
        assert {k: v for k, v in full_summaries[study_id].items() if k != "post_hoc_full_universe"} == {
            k: v for k, v in capped_summaries[study_id].items() if k != "post_hoc_full_universe"
        }
        assert full_docs[study_id]["verdict"] == "needs-more-data"
        assert full_summaries[study_id]["n_trials"] == 12
        assert post_hoc_gap(full_docs[study_id]) == POST_HOC_GAP_RUN != POST_HOC_GAP_NOT_RUN
    # The trial log gains one trial per gated study, after its 12 counted trials; it is never the primary.
    assert len(full_trials) == 27
    assert [t for t in full_trials if t["variant"] != POST_HOC_VARIANT] == capped_trials
    assert POST_HOC_VARIANT == "post-hoc-full-universe"
    assert [(i, t["study_id"]) for i, t in enumerate(full_trials) if t["variant"] == POST_HOC_VARIANT] == [(12, s1_id), (25, s2_id)]

    # The post-hoc run: the primary variant at 20 sessions and 10 bps on the bars of both folders.
    assert len(dsr_calls) == 4 and len(simulate_calls) == 14 + 2 + 14 + 1 + 1
    post_hoc_runs = {s1_id: simulate_calls[15], s2_id: simulate_calls[30]}
    # Every other run of studies 1 and 2 still reads the capped universe only.
    for index, call in enumerate(simulate_calls[:30]):
        if index != 15:
            assert sorted(call["bars_by_symbol"]) == ["ACME", "SPY"]
    windows = {
        s1_id: (date(2016, 1, 1), date(2026, 3, 31), date(2024, 4, 1)),
        s2_id: (date(2022, 1, 1), date(2026, 11, 23), date(2024, 11, 23)),
    }
    whole_trades = {s1_id: 4, s2_id: 5}
    for index, study_id in enumerate((s1_id, s2_id)):
        gated_call, post_hoc_call = dsr_calls[2 * index], dsr_calls[2 * index + 1]
        simulated = post_hoc_runs[study_id]
        assert simulated["config"] == PortfolioConfig(holding_days=20, cost_bps=10.0)
        assert (simulated["start_day"], simulated["end_day"], simulated["oos_start"]) == windows[study_id]
        assert sorted(simulated["bars_by_symbol"]) == ["ACME", "SPY", "ZZZZ"]
        assert simulated["bars_by_symbol"]["ACME"][0].volume == 2_000_000.0  # bars/ wins on a duplicate ticker
        in_window = {(e.symbol, e.trigger_day) for e in simulated["events"] if e.trigger_day <= days[-1]}
        assert in_window == {("ACME" if rate == acme_rate else "ZZZZ", days[entry - 1]) for entry, rate in full_trades[study_id]}

        # By hand: 20-session trades, two of them out of sample; 12 counted trials plus this run.
        whole = _hand_returns(320, full_trades[study_id], 20)
        oos = whole[oos_from[study_id] :]
        own_sharpe = _hand_sharpe(oos)
        counted = [
            _hand_sharpe(_hand_returns(320, entered(trades, holding), holding)[oos_from[study_id] :])
            for trades in capped_trades[study_id]
            for holding in (5, 20, 60)
        ]
        assert len(counted) == 12

        assert post_hoc_call["n_trials"] == 13 and gated_call["n_trials"] == 12
        assert len(post_hoc_call["primary_oos_returns"]) == len(oos) == 320 - oos_from[study_id]
        for got, want in zip(post_hoc_call["primary_oos_returns"], oos, strict=True):
            assert math.isclose(got, want, abs_tol=1e-12)
        sharpes = post_hoc_call["all_trial_per_obs_sharpes"]
        assert len(sharpes) == 13 and len(gated_call["all_trial_per_obs_sharpes"]) == 12
        assert sharpes[:12] == list(gated_call["all_trial_per_obs_sharpes"])
        for got, want in zip(sharpes, [*counted, own_sharpe], strict=True):
            assert math.isclose(got, want, rel_tol=1e-6, abs_tol=1e-12)

        skew, raw_kurtosis = moments(oos)
        dsr = deflated_sharpe_ratio(
            sharpe=own_sharpe,
            n_trials=13,
            sharpe_variance=statistics.variance([*counted, own_sharpe]),
            n_observations=len(oos),
            skew=skew,
            kurtosis=raw_kurtosis,
        )
        oos_sharpe, whole_sharpe = annual(oos), annual(whole)
        assert not math.isclose(oos_sharpe, whole_sharpe, rel_tol=0.01)
        assert post_hoc_row(full_docs[study_id]) == {
            "check": POST_HOC_CHECK,
            "pass": None,
            "result": (
                f"Bars for 3 tickers (1 of 2 further tickers have history): 2 OOS events, OOS Sharpe {oos_sharpe:.3f}, "
                f"DSR {dsr.probability:.3f} at N=13; whole-sample trades {whole_trades[study_id]}, Sharpe {whole_sharpe:.3f}. "
                "No 20 bps stress run. A pass here would need a new holdout."
            ),
        }
        assert full_docs[study_id]["robustness"][-1]["check"] == POST_HOC_CHECK
        summary = full_summaries[study_id]["post_hoc_full_universe"]
        assert sorted(summary) == ["dsr", "n_trials", "oos_events", "oos_sharpe", "tickers_with_bars", "whole_sharpe", "whole_trades"]
        assert (summary["tickers_with_bars"], summary["oos_events"], summary["whole_trades"], summary["n_trials"]) == (3, 2, whole_trades[study_id], 13)
        assert math.isclose(summary["oos_sharpe"], oos_sharpe, abs_tol=1e-4)
        assert math.isclose(summary["whole_sharpe"], whole_sharpe, abs_tol=1e-4)
        assert math.isclose(summary["dsr"], dsr.probability, abs_tol=1e-4)
        # The capped study has one out-of-sample event; the post-hoc run has two.
        assert full_summaries[study_id]["oos_events"] == 1
        # Its trial record: events of the out-of-sample period, trades of the whole sample.
        logged = full_trials[12 + 13 * index]
        assert (logged["study_id"], logged["variant"], logged["holding_days"], logged["cost_bps"], logged["is_primary"]) == (
            study_id,
            POST_HOC_VARIANT,
            20,
            10.0,
            False,
        )
        assert (logged["oos_events"], logged["oos_days"], logged["whole_trades"]) == (2, len(oos), whole_trades[study_id])
        assert math.isclose(logged["oos_annual_sharpe"], oos_sharpe, abs_tol=1e-5)

    # The data hash of studies 1 and 2 now covers the event bars too; study 3 does not read them.
    main_paths, event_paths = sorted(bars_dir.glob("*.csv")), sorted(event_bars_dir.glob("*.csv"))
    assert [p.name for p in event_paths] == ["ACME.csv", "NOROWS.csv", "ZZZZ.csv"]
    for study_id, event_file in ((s1_id, "form4_purchases.jsonl"), (s2_id, "congress_trades.jsonl")):
        assert capped_docs[study_id]["provenance"]["dataHash"] == _hash_files([data_dir / event_file, *main_paths])
        assert full_docs[study_id]["provenance"]["dataHash"] == _hash_files([data_dir / event_file, *main_paths, *event_paths])
        assert full_docs[study_id]["provenance"]["dataHash"] != capped_docs[study_id]["provenance"]["dataHash"]

    # ---- direct calls: no event list, and a run without one event ------------------------------------
    window = StudyWindow(start=days[0], end=days[-1], oos_start=days[100])
    idle = simulate_event_portfolio([], {}, spy, PortfolioConfig(holding_days=20), start_day=days[0], end_day=days[-1], oos_start=days[100])
    study = GatedStudy("synthetic-study", window, ("alpha",), {("alpha", 20): idle}, (), idle, idle, idle, None, "needs-more-data", "Synthetic.")
    counted_trial = TrialRecord("synthetic-study", "alpha", 20, 10.0, True, 0, 220, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0)

    def context(full_bars: dict[str, list[DailyBar]] | None, meta: dict[str, Any] | None = None) -> RunContext:
        return RunContext(
            data_dir=data_dir,
            ran=date(2026, 11, 25),
            commit="0123abc",
            bars={"SPY": spy},
            spy_bars=spy,
            bar_paths=(),
            meta=meta or {},
            universe_note="",
            full_bars=full_bars,
            full_bar_paths=(),
        )

    skipped = PostHocRun(not_run, (POST_HOC_GAP_NAME, POST_HOC_GAP_NOT_RUN), None, None)
    assert _post_hoc_full_universe(context(None), study, []) == skipped
    assert _post_hoc_full_universe(context({"SPY": spy, "ZZZZ": zzzz}), study, None) == skipped
    assert skipped.trials_after([counted_trial]) == (counted_trial,)
    # No event: constant returns have no DSR. The study has no counted trial here, so N = 0 + 1.
    # Counts that are not whole numbers are left out of the text.
    for meta in ({}, {"event_bars_extra_cached": "1", "event_bars_extra_requested": 2}, {"event_bars_extra_cached": 1}):
        happened = _post_hoc_full_universe(context({"SPY": spy, "ZZZZ": zzzz}, meta), study, [])
        assert happened.robustness_row == {
            "check": POST_HOC_CHECK,
            "pass": None,
            "result": (
                "Bars for 2 tickers: 0 OOS events, OOS Sharpe 0.000, DSR unavailable at N=1; "
                "whole-sample trades 0, Sharpe 0.000. No 20 bps stress run. A pass here would need a new holdout."
            ),
        }
        assert happened.gap == (POST_HOC_GAP_NAME, POST_HOC_GAP_RUN)
        assert happened.summary == {
            "tickers_with_bars": 2,
            "oos_events": 0,
            "oos_sharpe": 0.0,
            "dsr": None,
            "n_trials": 1,
            "whole_trades": 0,
            "whole_sharpe": 0.0,
        }
        assert happened.trial == TrialRecord("synthetic-study", POST_HOC_VARIANT, 20, 10.0, False, 0, 220, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0)
        assert happened.trials_after([counted_trial]) == (counted_trial, happened.trial)


def test_runner_stops_on_a_missing_event_file_and_on_premium_rows_without_a_complete_session(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    (data_dir / "bars").mkdir(parents=True)
    out_dir = tmp_path / "out"
    days = _make_trading_days(date(2024, 1, 2), 60)
    _write_bars_csv(data_dir / "bars" / "SPY.csv", _make_bars(days, start_price=200.0, volume=50_000_000.0))

    def run() -> dict[str, Any]:
        return run_all_studies(data_dir=data_dir, out_dir=out_dir, ran=date(2026, 11, 25), commit="0123abc")

    # Each event file is required; the studies run in the order insider, Congress, premium.
    for name in ("form4_purchases.jsonl", "congress_trades.jsonl", "market_premium.jsonl"):
        _write_event_files(data_dir)
        (data_dir / name).unlink()
        with pytest.raises(FileNotFoundError, match=f"{name} is missing"):
            run()
        _write_event_files(data_dir)
        (data_dir / name).write_text("\n", encoding="utf-8")
        with pytest.raises(ValueError, match=f"{name} has no rows"):
            run()

    # Premium rows of partial sessions only: there is no session to build the frozen baseline on.
    partial = [{**_IDLE_PREMIUM_ROW, "session_status": "partial"}]
    _write_event_files(data_dir, premium=partial)
    with pytest.raises(ValueError, match="market_premium.jsonl has no complete session"):
        run()
    # A failed run writes nothing.
    assert not out_dir.exists()

    _write_event_files(data_dir)
    summaries = run()["summaries"]
    assert {summary["verdict"] for summary in summaries.values()} == {"needs-more-data"}
    assert sorted(p.name for p in out_dir.iterdir()) == sorted(
        [*(f"{study_id}.json" for study_id in STUDY_IDS), "studies.jsonl", "summary.json", "trials.json"]
    )


def test_gated_study_feeds_the_gate_the_primary_out_of_sample_numbers(monkeypatch: pytest.MonkeyPatch) -> None:
    days = _make_trading_days(date(2021, 1, 4), 720)
    # 700 sessions in the window, the last 500 of them out of sample.
    window = StudyWindow(start=days[10], end=days[709], oos_start=days[210])
    rates = {"SLOW": 0.00015, "FAST": 0.001}

    def growing(rate: float) -> list[DailyBar]:
        """The close is ``rate`` above the open on every session, and the open is the previous close."""
        bars: list[DailyBar] = []
        price = 100.0
        for d in days:
            close = price * (1.0 + rate)
            bars.append(DailyBar(d, price, close, price, close, close, 1_000_000.0, close))
            price = close
        return bars

    bars = {sym: growing(rate) for sym, rate in rates.items()}
    spy = _flat_bars(days, price=400.0, volume=50_000_000.0)
    variants = {
        "alpha": [
            SignalEvent("SLOW", days[3], 1.0),  # entry day before the window
            SignalEvent("SLOW", days[49], 1.0),  # in sample: enters on window session 40
            SignalEvent("SLOW", days[299], 1.0),  # out of sample: enters on window session 290
            SignalEvent("SLOW", days[712], 1.0),  # entry day after the window
        ],
        "beta": [SignalEvent("FAST", days[399], 1.0)],  # out of sample: enters on window session 390
        "gamma": [],
        "uncounted": [SignalEvent("FAST", days[100], 1.0)],  # not a pre-registered variant
    }
    names = ("alpha", "beta", "gamma")
    grid = [(name, holding) for name in names for holding in (5, 20, 60)]
    entries = {"alpha": [(40, rates["SLOW"]), (290, rates["SLOW"])], "beta": [(390, rates["FAST"])], "gamma": []}

    def expected_returns(variant: str, holding: int, cost_bps: float) -> list[float]:
        """Daily portfolio return by hand: one of 10 equal slots earns the stock's daily rate against a
        flat benchmark and pays the cost on the entry day and on the exit day."""
        cost = cost_bps / 10_000.0
        out = [0.0] * 700
        for entry, rate in entries[variant]:
            for k in range(holding):
                legs = (k == 0) + (k == holding - 1)
                out[entry + k] += (rate - legs * cost) / 10.0
        return out

    def per_observation_sharpe(returns: list[float]) -> float:
        deviation = statistics.stdev(returns)
        return statistics.fmean(returns) / deviation if deviation > 0 else 0.0

    simulate_calls = _record_calls(monkeypatch, "simulate_event_portfolio")
    dsr_calls = _record_calls(monkeypatch, "compute_study_dsr")
    gate_calls = _record_calls(monkeypatch, "evaluate_verdict")
    study = run_gated_study(
        study_id="synthetic-study",
        variants=variants,
        variant_names=names,
        primary_variant="alpha",
        bars=bars,
        spy_bars=spy,
        window=window,
    )
    assert isinstance(study, GatedStudy)
    assert (study.study_id, study.window, study.variant_names) == ("synthetic-study", window, names)

    # ---- trials: every counted variant at 5, 20 and 60 sessions and 10 bps; then the two stress runs ----
    assert list(study.results) == grid
    assert [(t.study_id, t.variant, t.holding_days, t.cost_bps, t.is_primary) for t in study.trials] == [
        ("synthetic-study", name, holding, 10.0, (name, holding) == ("alpha", 20)) for name, holding in grid
    ]
    expected_runs = [*[(name, holding, 10.0) for name, holding in grid], ("alpha", 20, 0.0), ("alpha", 20, 20.0)]
    assert len(simulate_calls) == len(expected_runs) == 11
    for call, (name, holding, cost_bps) in zip(simulate_calls, expected_runs, strict=True):
        assert call["events"] is variants[name]
        assert call["bars_by_symbol"] is bars and call["spy_bars"] is spy
        assert call["config"] == PortfolioConfig(holding_days=holding, max_slots=10, cost_bps=cost_bps, require_liquidity=True)
        assert (call["start_day"], call["end_day"], call["oos_start"]) == (days[10], days[709], days[210])

    # ---- the primary trial: alpha at 20 sessions ----------------------------------------------------
    primary = study.primary
    assert primary is study.results[("alpha", 20)]
    assert [(p.entry_day, p.exit_day) for p in primary.positions] == [(days[50], days[69]), (days[300], days[319])]
    assert (primary.whole.days, primary.whole.trades) == (700, 2)
    assert (primary.oos.days, primary.oos.trades) == (500, 1)
    assert primary.skipped_outside_window == 2
    # The trial log takes its event count from the out-of-sample period, not from the whole sample.
    primary_trial = study.trials[1]
    assert (primary_trial.variant, primary_trial.holding_days, primary_trial.is_primary) == ("alpha", 20, True)
    assert (primary_trial.oos_events, primary_trial.oos_days, primary_trial.whole_trades) == (1, 500, 2)
    # Out-of-sample sum of one 20-session trade on one of 10 slots: 20 x 0.015% less two cost legs.
    assert math.isclose(sum(study.stress0.oos_excess_returns), (20 * 0.00015) / 10, abs_tol=1e-12)  # +0.0003
    assert math.isclose(sum(primary.oos_excess_returns), (20 * 0.00015 - 2 * 0.0010) / 10, abs_tol=1e-12)  # +0.0001
    assert math.isclose(sum(study.stress20.oos_excess_returns), (20 * 0.00015 - 2 * 0.0020) / 10, abs_tol=1e-12)  # -0.0001

    oos_at = {cost_bps: expected_returns("alpha", 20, cost_bps)[200:] for cost_bps in (0.0, 10.0, 20.0)}
    sharpe_at = {cost_bps: per_observation_sharpe(returns) * math.sqrt(252) for cost_bps, returns in oos_at.items()}
    assert sharpe_at[0.0] > sharpe_at[10.0] > 0.0 > sharpe_at[20.0]
    assert math.isclose(study.stress0.oos.sharpe, sharpe_at[0.0], rel_tol=1e-6)
    assert math.isclose(primary.oos.sharpe, sharpe_at[10.0], rel_tol=1e-6)
    assert math.isclose(study.stress20.oos.sharpe, sharpe_at[20.0], rel_tol=1e-6)
    whole_sharpe = per_observation_sharpe(expected_returns("alpha", 20, 10.0)) * math.sqrt(252)
    assert math.isclose(primary.whole.sharpe, whole_sharpe, rel_tol=1e-6)
    assert not math.isclose(whole_sharpe, sharpe_at[10.0], rel_tol=0.05)

    # ---- the deflated Sharpe ratio: out-of-sample returns of the primary, per-observation Sharpes of all 9 trials ----
    (dsr_call,) = dsr_calls
    assert len(dsr_call["primary_oos_returns"]) == 500
    for got, want in zip(dsr_call["primary_oos_returns"], oos_at[10.0], strict=True):
        assert math.isclose(got, want, abs_tol=1e-12)
    trial_sharpes = [per_observation_sharpe(expected_returns(name, holding, 10.0)[200:]) for name, holding in grid]
    assert len(dsr_call["all_trial_per_obs_sharpes"]) == 9
    for got, want in zip(dsr_call["all_trial_per_obs_sharpes"], trial_sharpes, strict=True):
        assert math.isclose(got, want, rel_tol=1e-6, abs_tol=1e-12)
    assert trial_sharpes[6:] == [0.0, 0.0, 0.0]  # gamma has no event
    assert dsr_call["n_trials"] == 9
    skew, raw_kurtosis = moments(oos_at[10.0])
    by_hand = deflated_sharpe_ratio(
        sharpe=per_observation_sharpe(oos_at[10.0]),
        n_trials=9,
        sharpe_variance=statistics.variance(trial_sharpes),
        n_observations=500,
        skew=skew,
        kurtosis=raw_kurtosis,
    )
    assert study.dsr is not None
    assert math.isclose(study.dsr.probability, by_hand.probability, rel_tol=1e-6, abs_tol=1e-12)
    assert 0.0 < by_hand.probability < 0.95

    # ---- the gate reads the primary trial out of sample, and the 20 bps run for the cost stress --------
    (gate_call,) = gate_calls
    assert sorted(gate_call) == ["dsr_probability", "n_trials", "oos_events", "oos_sessions", "oos_sharpe", "stress_oos_sharpe"]
    assert (gate_call["oos_sessions"], gate_call["oos_events"], gate_call["n_trials"]) == (500, 1, 9)
    assert math.isclose(gate_call["oos_sharpe"], sharpe_at[10.0], rel_tol=1e-6)
    assert math.isclose(gate_call["stress_oos_sharpe"], sharpe_at[20.0], rel_tol=1e-6)
    assert gate_call["dsr_probability"] == study.dsr.probability
    assert study.verdict == "no-edge"
    assert study.reason == (
        "Failed pre-registered gate over 500 OOS sessions: OOS events 1 < 100; "
        f"DSR {by_hand.probability:.3f} < 0.95 (N = 9); 20 bps stress OOS Sharpe {sharpe_at[20.0]:.3f} <= 0. "
        f"Primary OOS excess Sharpe {sharpe_at[10.0]:.3f}, DSR {by_hand.probability:.3f} (N = 9). Research only."
    )


def test_gate_robustness_rows_restate_the_three_bars() -> None:
    window = StudyWindow(start=date(2016, 1, 1), end=date(2026, 3, 31), oos_start=date(2024, 4, 1))

    def result(oos_trades: int, oos_sharpe: float) -> PortfolioResult:
        return _portfolio_result(oos=PeriodMetrics(500, oos_trades, 0.0, oos_sharpe, 0.0, 0.0, 0.0, 0.0, None))

    def study(dsr: DeflatedSharpe | None, oos_trades: int, stress20_sharpe: float) -> GatedStudy:
        primary = result(oos_trades, 1.0)
        trial = TrialRecord("synthetic-study", "alpha", 20, 10.0, True, oos_trades, 500, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0)
        return GatedStudy(
            study_id="synthetic-study",
            window=window,
            variant_names=("alpha",),
            results={("alpha", 20): primary},
            trials=(trial, trial),
            primary=primary,
            stress0=result(oos_trades, 1.5),
            stress20=result(oos_trades, stress20_sharpe),
            dsr=dsr,
            verdict="no-edge",
            reason="Synthetic.",
        )

    def dsr(probability: float) -> DeflatedSharpe:
        return DeflatedSharpe(0.1, 2, 0.01, 500, 0.0, 3.0, 0.03125, 1.6449, probability)

    # Exactly at the bars: DSR 0.95 and 100 events pass; the 20 bps Sharpe must be above zero.
    assert _gate_robustness_rows(study(dsr(0.95), 100, 0.5)) == [
        {
            "check": "Deflated Sharpe Ratio (N=2, bar >= 0.95)",
            "pass": True,
            "result": "DSR=0.9500, z=1.645, bench=0.0312",
        },
        {
            "check": "OOS Event Count (bar >= 100)",
            "pass": True,
            "result": "100 OOS entries over 500 sessions (2024-04-01..2026-03-31)",
        },
        {
            "check": "Cost Stress (0 / 10 / 20 bps per side)",
            "pass": True,
            "result": "OOS Sharpe: 0bps=1.500, 10bps=1.000, 20bps=0.500",
        },
    ]
    # One step below each bar, and no DSR at all.
    below = _gate_robustness_rows(study(dsr(0.9499), 99, 0.0))
    assert [row["pass"] for row in below] == [False, False, False]
    assert below[0]["result"] == "DSR=0.9499, z=1.645, bench=0.0312"
    assert below[1]["result"] == "99 OOS entries over 500 sessions (2024-04-01..2026-03-31)"
    assert below[2]["result"] == "OOS Sharpe: 0bps=1.500, 10bps=1.000, 20bps=0.000"
    missing = _gate_robustness_rows(study(None, 100, -0.25))
    assert missing[0] == {
        "check": "Deflated Sharpe Ratio (N=2, bar >= 0.95)",
        "pass": False,
        "result": "DSR unavailable (zero variance or insufficient observations)",
    }
    assert [row["pass"] for row in missing] == [False, True, False]


def test_sensitivity_rows_show_whole_sample_metrics_and_the_oos_result_as_text() -> None:
    window = StudyWindow(start=date(2016, 1, 1), end=date(2026, 3, 31), oos_start=date(2024, 4, 1))
    names = ("alpha", "beta")
    results: dict[tuple[str, int], PortfolioResult] = {}
    for v, name in enumerate(names):
        for h, holding in enumerate((5, 20, 60)):
            n = 3 * v + h + 1  # 1..6
            results[(name, holding)] = _portfolio_result(
                whole=PeriodMetrics(700, 10 * n, 0.01 * n, 0.1 * n, 0.0, -0.02 * n, 0.5, 0.5, None),
                oos=PeriodMetrics(500, n, 0.5, -0.25 * n if v else 0.25 * n, 0.0, -0.9, 0.5, 0.5, None),
            )
    primary = results[("alpha", 20)]
    study = GatedStudy("synthetic-study", window, names, results, (), primary, primary, primary, None, "no-edge", "Synthetic.")
    rows = _sensitivity_rows(study)
    assert [row["param"] for row in rows] == ["alpha | H=5", "alpha | H=20", "alpha | H=60", "beta | H=5", "beta | H=20", "beta | H=60"]
    assert rows[1] == {
        "param": "alpha | H=20",
        "value": "OOS 2 ev, Sharpe +0.500",
        "cagr": 0.01 * 2,
        "sharpe": 0.1 * 2,
        "maxDrawdown": -0.02 * 2,
        "trades": 20,
    }
    assert rows[5] == {
        "param": "beta | H=60",
        "value": "OOS 6 ev, Sharpe -1.500",
        "cagr": 0.01 * 6,
        "sharpe": 0.1 * 6,
        "maxDrawdown": -0.02 * 6,
        "trades": 60,
    }


@functools.cache
def _collector() -> Any:
    """The collector script, imported by path (it is not a package). No test calls its network code."""
    script = Path(__file__).resolve().parents[3] / "scripts" / "smart-money-pr7" / "fetch_data.py"
    if not script.is_file():
        pytest.skip(f"collector script not found: {script}")
    spec = importlib.util.spec_from_file_location("smart_money_pr7_fetch_data", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    saved_path = list(sys.path)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)  # the script puts two repository directories on sys.path
    finally:
        sys.path[:] = saved_path
        del sys.modules[spec.name]
    return module


def test_collector_chart_rows_undo_only_later_splits() -> None:
    fetch_data = _collector()

    def stamp(day: int) -> int:
        return int(datetime(2024, 1, day, 14, 30, tzinfo=UTC).timestamp())

    chart = {
        "timestamp": [stamp(2), stamp(3), stamp(4), stamp(5), stamp(8)],
        "indicators": {
            "quote": [
                {
                    "open": [79.0, 81.0, 83.0, 85.0, 87.0],
                    "high": [81.0, 83.0, 85.0, 87.0, 89.0],
                    "low": [78.0, 80.0, 82.0, 84.0, 86.0],
                    "close": [80.0, 82.0, 84.0, 86.0, 88.0],
                    "volume": [1000, 1100, 1200, 1300, 1400],
                }
            ],
            "adjclose": [{"adjclose": [20.0, 20.5, 21.0, 21.5, 22.0]}],
        },
        "events": {
            "splits": {
                # A 4-for-1 split with ex-day 2024-01-03 and a 1-for-8 reverse split with ex-day 2024-01-05.
                "forward": {"date": stamp(3), "numerator": 4, "denominator": 1, "splitRatio": "4:1"},
                "reverse": {"date": stamp(5), "numerator": 1, "denominator": 8, "splitRatio": "1:8"},
                # A split event without a usable ratio is ignored.
                "broken": {"date": stamp(4), "numerator": 3, "denominator": 0},
            }
        },
    }
    # The vendor restates every close for all later splits. As printed:
    # 2024-01-02 is before both splits: 80 x 4 / 8 = 40.
    # 2024-01-03 (ex-day of the 4-for-1) and 2024-01-04 are before the reverse split only: 82 / 8 and 84 / 8.
    # 2024-01-05 (ex-day of the 1-for-8) and 2024-01-08 are after both: unchanged.
    assert fetch_data._chart_rows(chart) == [
        ("2024-01-02", 79.0, 81.0, 78.0, 80.0, 20.0, 1000.0, 40.0),
        ("2024-01-03", 81.0, 83.0, 80.0, 82.0, 20.5, 1100.0, 10.25),
        ("2024-01-04", 83.0, 85.0, 82.0, 84.0, 21.0, 1200.0, 10.5),
        ("2024-01-05", 85.0, 87.0, 84.0, 86.0, 21.5, 1300.0, 86.0),
        ("2024-01-08", 87.0, 89.0, 86.0, 88.0, 22.0, 1400.0, 88.0),
    ]

    # Without split events the as-printed close is the close. Rows with a missing or non-positive
    # price and a second row of the same day are dropped; a missing volume is zero.
    plain = {
        "timestamp": [stamp(2), stamp(3), stamp(3), stamp(4), stamp(5)],
        "indicators": {
            "quote": [
                {
                    "open": [10.0, 11.0, 99.0, None, 0.0],
                    "high": [10.5, 11.5, 99.0, 12.5, 13.5],
                    "low": [9.5, 10.5, 99.0, 11.5, 12.5],
                    "close": [10.0, 11.0, 99.0, 12.0, 13.0],
                    "volume": [500, None, 700, 800, 900],
                }
            ]
        },
    }
    assert fetch_data._chart_rows(plain) == [
        ("2024-01-02", 10.0, 10.5, 9.5, 10.0, 10.0, 500.0, 10.0),
        ("2024-01-03", 11.0, 11.5, 10.5, 11.0, 11.0, 0.0, 11.0),
    ]
    assert fetch_data._chart_rows({}) == []


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


def test_collector_refuses_incomplete_congress_chunks() -> None:
    fetch_data = _collector()
    for complete in ({}, {"warnings": []}, {"warnings": None, "tables": []}):
        assert fetch_data._require_complete_chunk(complete, "congress-house 2023-05-01..2023-05-31") is None
    with pytest.raises(RuntimeError) as raised:
        fetch_data._require_complete_chunk({"blocked": "host refused", "warnings": ["later"]}, "label")
    assert str(raised.value) == "label: blocked upstream (host refused)"
    with pytest.raises(RuntimeError) as raised:
        fetch_data._require_complete_chunk({"warnings": ["download failed: d7", "deadline"]}, "label")
    assert str(raised.value) == "label: 2 warning(s), first: download failed: d7"


def test_collector_chamber_history_checks_every_chunk_and_keys_the_ledger_by_year(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch_data = _collector()
    windows = [("2023-05-01", "2023-05-31"), ("2024-02-01", "2024-02-29")]

    def payload(doc: str, **extra: Any) -> dict[str, Any]:
        return {
            "tables": [
                {
                    "table": "congress_filings",
                    "rows": [
                        {"docId": doc, "status": "parsed", "reason": None, "rowCount": 2, "amends": True},
                        {"docId": f"{doc}-scan", "status": "unparsed", "reason": "scanned_image"},
                    ],
                },
                {
                    "table": "congress_trades",
                    "rows": [
                        {"docId": doc, "rowNumber": 1, "transactionType": "purchase", "ticker": "acme", "assetType": "OP", "member": "Member Alpha", "holder": "self", "transactionDate": "2023-05-02", "filedOn": "2023-05-20", "amountLow": 1001, "amountHigh": 15000},
                        {"docId": doc, "rowNumber": 2, "transactionType": "sale", "ticker": "ACME", "filedOn": "2023-05-20"},
                        {"docId": doc, "rowNumber": 2, "transactionType": "purchase", "ticker": None, "filedOn": "2023-05-20"},
                        # Row 3 of a filing with 2 rows is a leftover of an older parse.
                        {"docId": doc, "rowNumber": 3, "transactionType": "purchase", "ticker": "OLD", "filedOn": "2023-05-20"},
                        # A purchase of a filing that was not parsed.
                        {"docId": f"{doc}-scan", "rowNumber": 1, "transactionType": "purchase", "ticker": "SCAN", "filedOn": "2023-05-20"},
                    ],
                },
            ],
            **extra,
        }

    answers: dict[str, Any] = {"2023-05-01": payload("doc-a"), "2024-02-01": payload("doc-b")}
    commands: list[list[str]] = []

    class Finished:
        def __init__(self, since: str) -> None:
            answer = answers[since]
            self.returncode = answer if isinstance(answer, int) else 0
            self.stdout = "" if isinstance(answer, int) else json.dumps(answer)
            self.stderr = "job failed"

    def fake_run(cmd: list[str], **_kwargs: Any) -> Finished:
        commands.append(cmd)
        return Finished(cmd[cmd.index("--since") + 1])

    monkeypatch.setattr(fetch_data.subprocess, "run", fake_run)
    chunks = tmp_path / "chunks"
    chunks.mkdir()

    purchases, counts = fetch_data._fetch_chamber_history("congress-house", "house", windows, chunks, {})
    assert purchases == [
        {
            "chamber": "house",
            "doc_id": doc,
            "member": "Member Alpha",
            "holder": "self",
            "ticker": "ACME",
            "asset_type": "OP",
            "transaction_type": "purchase",
            "transaction_date": "2023-05-02",
            "filed_on": "2023-05-20",
            "amount_low": 1001,
            "amount_high": 15000,
            "amends": True,
        }
        for doc in ("doc-a", "doc-b")
    ]
    # The ledger year is the year of the month window.
    assert dict(counts) == {
        ("house", "2023", "parsed", ""): 1,
        ("house", "2023", "unparsed", "scanned_image"): 1,
        ("house", "2024", "parsed", ""): 1,
        ("house", "2024", "unparsed", "scanned_image"): 1,
    }
    assert [(cmd[2:4], cmd[4:]) for cmd in commands] == [
        (["vertex_openbb", "congress-house"], ["--since", since, "--until", until]) for since, until in windows
    ]
    cached = [chunks / f"congress-house_{since}_{until}.json" for since, until in windows]
    assert [json.loads(path.read_text(encoding="utf-8")) for path in cached] == [answers["2023-05-01"], answers["2024-02-01"]]

    # A second pass reads the cache and starts no job.
    assert fetch_data._fetch_chamber_history("congress-house", "house", windows, chunks, {}) == (purchases, counts)
    assert len(commands) == 2

    # A cached chunk is checked again: a chunk with a warning is never used.
    cached[1].write_text(json.dumps(payload("doc-b", warnings=["download failed: doc-x"])), encoding="utf-8")
    with pytest.raises(RuntimeError, match=r"congress-house 2024-02-01\.\.2024-02-29 \(cached congress-house_2024-02-01_2024-02-29\.json\): 1 warning"):
        fetch_data._fetch_chamber_history("congress-house", "house", windows, chunks, {})

    # A fresh chunk with a warning or a blocked host stops the run before it is cached.
    for bad in (payload("doc-b", warnings=["deadline reached"]), payload("doc-b", blocked="host refused")):
        cached[1].unlink(missing_ok=True)
        answers["2024-02-01"] = bad
        with pytest.raises(RuntimeError, match=r"congress-house 2024-02-01\.\.2024-02-29: "):
            fetch_data._fetch_chamber_history("congress-house", "house", windows, chunks, {})
        assert not cached[1].exists()
    # A job that exits with an error stops the run too.
    answers["2024-02-01"] = 2
    with pytest.raises(RuntimeError, match="congress-house 2024-02-01..2024-02-29 exited 2: job failed"):
        fetch_data._fetch_chamber_history("congress-house", "house", windows, chunks, {})

    # Tables may also come as one mapping.
    answers["2024-02-01"] = {"tables": {"congress_filings": [{"docId": "doc-c", "status": "parsed", "rowCount": 1}], "congress_trades": []}}
    purchases, counts = fetch_data._fetch_chamber_history("congress-senate", "senate", windows[1:], chunks, {})
    assert purchases == [] and dict(counts) == {("senate", "2024", "parsed", ""): 1}


def test_collector_congress_history_needs_the_2026_export_and_labels_its_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch_data = _collector()
    venv_python = tmp_path / "python"
    venv_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(fetch_data, "OPENBB_VENV_PYTHON", venv_python)
    chamber_calls: list[tuple[str, str, int, tuple[str, str], tuple[str, str]]] = []

    def fake_chamber(job: str, chamber: str, windows: list[tuple[str, str]], _chunks: Path, _env: dict[str, str]) -> tuple[list[dict[str, Any]], Any]:
        chamber_calls.append((job, chamber, len(windows), windows[0], windows[-1]))
        return [{"chamber": chamber, "ticker": "ACME", "filed_on": "2023-05-20"}], {(chamber, "2023", "parsed", ""): 5}

    monkeypatch.setattr(fetch_data, "_fetch_chamber_history", fake_chamber)
    ledger_2026 = [
        {"chamber": "house", "status": "parsed", "reason": "", "cnt": 3},
        {"chamber": "senate", "status": "unparsed", "reason": "scanned_image", "cnt": "2"},
    ]
    export = tmp_path / "congress_2026.json"

    def run(ledger: list[dict[str, Any]]) -> tuple[Path, dict[str, Any]]:
        return fetch_data.fetch_congress_history(tmp_path, "contact@example.com", ledger)

    # Without the 2026 export the history would end in 2025 and still look complete.
    with pytest.raises(RuntimeError, match="the 2026 Congress export is missing"):
        run(ledger_2026)
    export.write_text("[]", encoding="utf-8")
    with pytest.raises(RuntimeError, match="congress_2026.json holds no purchase rows"):
        run(ledger_2026)
    # An export of an older collector has no asset type; a null asset type is a value.
    export.write_text(json.dumps([{"chamber": "house", "ticker": "ZETA", "asset_type": "ST"}, {"chamber": "house", "ticker": "ZETA"}]), encoding="utf-8")
    with pytest.raises(RuntimeError, match="congress_2026.json has rows without asset_type; run --only postgres-congress again"):
        run(ledger_2026)
    export.write_text(json.dumps([{"chamber": "house", "ticker": "ZETA", "filed_on": "2026-02-03", "asset_type": None}]), encoding="utf-8")
    with pytest.raises(RuntimeError, match="the 2026 Congress export is missing"):
        run([])
    assert chamber_calls == [] and not (tmp_path / "congress_trades.jsonl").exists()

    out_path, meta = run(ledger_2026)
    assert out_path == tmp_path / "congress_trades.jsonl"
    assert sorted(chamber_calls) == [
        ("congress-house", "house", 48, ("2022-01-01", "2022-01-31"), ("2025-12-01", "2025-12-31")),
        ("congress-senate", "senate", 48, ("2022-01-01", "2022-01-31"), ("2025-12-01", "2025-12-31")),
    ]
    # The 2026 rows come first, then the House history, then the Senate history.
    assert [json.loads(line) for line in out_path.read_text(encoding="utf-8").splitlines()] == [
        {"chamber": "house", "ticker": "ZETA", "filed_on": "2026-02-03", "asset_type": None},
        {"chamber": "house", "ticker": "ACME", "filed_on": "2023-05-20"},
        {"chamber": "senate", "ticker": "ACME", "filed_on": "2023-05-20"},
    ]
    # The exported ledger is the 2026 ledger; the runner reads the keys as chamber:year:status:reason.
    assert meta == {
        "congress_ledger": {
            "house:2023:parsed:": 5,
            "house:2026:parsed:": 3,
            "senate:2023:parsed:": 5,
            "senate:2026:unparsed:scanned_image": 2,
        }
    }
    assert _congress_coverage_gaps(meta)[0][1].startswith("Filings 2023–2026: House 0/8 (0.0%) and Senate 2/7 (28.6%)")

    monkeypatch.setattr(fetch_data, "OPENBB_VENV_PYTHON", tmp_path / "absent-python")
    with pytest.raises(RuntimeError, match="OpenBB venv python not found"):
        run(ledger_2026)


def test_collector_postgres_exports_stop_on_sql_errors_and_empty_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch_data = _collector()
    seen: list[tuple[list[str], dict[str, Any]]] = []
    stdout = {"text": '{"a": 1}\n\n  {"a": 2}  \n'}

    class Finished:
        def __init__(self) -> None:
            self.stdout = stdout["text"]

    def fake_run(cmd: list[str], **kwargs: Any) -> Finished:
        seen.append((cmd, kwargs))
        return Finished()

    monkeypatch.setattr(fetch_data.subprocess, "run", fake_run)
    assert fetch_data._ssh_psql_jsonl("SELECT 1 AS a", "two rows") == [{"a": 1}, {"a": 2}]
    (cmd, kwargs), = seen
    assert cmd[:2] == ["ssh", "quantvps"]
    # Without ON_ERROR_STOP psql exits 0 after an SQL error; without check=True a failed ssh would pass.
    assert "psql -v ON_ERROR_STOP=1 " in cmd[2]
    assert kwargs["check"] is True
    assert kwargs["input"] == "SELECT row_to_json(t) FROM (SELECT 1 AS a) t;"
    stdout["text"] = "\n \n"
    with pytest.raises(RuntimeError) as raised:
        fetch_data._ssh_psql_jsonl("SELECT 1 AS a", "flow_market_premium complete sessions")
    assert str(raised.value) == "QuantVPS export returned no rows: flow_market_premium complete sessions"

    queries: list[tuple[str, str]] = []
    rows_by_what = {
        "flow_market_premium complete sessions": [{"session_date": "2025-10-16", "ticker": "ACME", "bullish_premium": 600000.0}],
        "2026 Congress purchases": [{"chamber": "house", "doc_id": "d1", "ticker": "ACME", "asset_type": "OP"}],
        "2026 Congress filing ledger": [{"chamber": "house", "status": "parsed", "reason": "", "cnt": 3}],
    }

    def fake_export(sql: str, what: str) -> list[dict[str, Any]]:
        queries.append((what, " ".join(sql.split())))
        return rows_by_what[what]

    monkeypatch.setattr(fetch_data, "_ssh_psql_jsonl", fake_export)
    premium_path = fetch_data.export_market_premium(tmp_path)
    assert premium_path == tmp_path / "market_premium.jsonl"
    assert [json.loads(line) for line in premium_path.read_text(encoding="utf-8").splitlines()] == rows_by_what["flow_market_premium complete sessions"]
    assert "WHERE s.status = 'complete'" in queries[0][1]

    assert fetch_data.export_congress_2026(tmp_path) == {"ledger_2026": rows_by_what["2026 Congress filing ledger"]}
    assert json.loads((tmp_path / "congress_2026.json").read_text(encoding="utf-8")) == rows_by_what["2026 Congress purchases"]
    assert [what for what, _sql in queries] == list(rows_by_what)
    # The export carries the asset type (options are dropped by the runner) and only parsed 2026 purchases.
    assert "t.asset_type AS asset_type" in queries[1][1]
    assert "f.status = 'parsed'" in queries[1][1] and "t.filed_on >= '2026-01-01'" in queries[1][1]
    assert "t.transaction_type = 'purchase'" in queries[1][1]
    assert "filed_on >= '2026-01-01'" in queries[2][1]


def test_collector_bar_steps_fetch_only_tickers_outside_the_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_data = _collector()

    def premium(ticker: str, bullish: float, bearish: float = 0.0, trades: int = 3, **extra: Any) -> dict[str, Any]:
        return {"session_date": "2025-10-16", "ticker": ticker, "bullish_premium": bullish, "bearish_premium": bearish, "trade_count": trades, **extra}

    _write_jsonl(
        tmp_path / "market_premium.jsonl",
        [
            premium("extra", 500_000.0),  # exactly at the floor, lower case
            premium("INCAP", 900_000.0),
            premium("SHARE", 700_000.0, 300_000.0),  # exactly 70% bullish
            premium("SMALL", 499_999.0),
            premium("MIXED", 699_999.0, 300_001.0),
            premium("FEWTR", 900_000.0, trades=2),
            premium("PARTL", 900_000.0, session_status="partial"),
            premium("BAD TICKER", 900_000.0),
            premium("ZERO", 0.0),
        ],
    )
    assert fetch_data._premium_candidate_tickers(tmp_path) == ["EXTRA", "INCAP", "SHARE"]

    # A cluster of three owners in CLUS, one lone purchase in LONE, Congress purchases in CONG and INCAP.
    form4 = [
        {**_IDLE_FORM4_ROW, "accession_number": f"c{i}", "filing_date": f"2024-03-0{i + 1}", "issuer_cik": "7", "ticker": "CLUS", "owner_group_key": f"owner{i}"}
        for i in range(3)
    ]
    _write_jsonl(tmp_path / "form4_purchases.jsonl", [*form4, {**_IDLE_FORM4_ROW, "ticker": "LONE"}])
    _write_jsonl(
        tmp_path / "congress_trades.jsonl",
        [{"ticker": " cong "}, {"ticker": "INCAP"}, {"ticker": "NOT A TICKER"}],
    )
    assert fetch_data._event_tickers(tmp_path) == ["CLUS", "CONG", "INCAP"]

    fetches: list[tuple[list[str], Path, datetime, str]] = []

    def fake_fetch_bars(tickers: list[str], bars_dir: Path, first_day: datetime, label: str) -> tuple[int, list[str]]:
        fetches.append((tickers, bars_dir, first_day, label))
        return len(tickers) - 1, [tickers[-1]]

    monkeypatch.setattr(fetch_data, "_select_universe_tickers", lambda _out_dir: ["SPY", "INCAP"])
    monkeypatch.setattr(fetch_data, "_fetch_bars", fake_fetch_bars)

    # INCAP is in the 600-ticker cap: its bars are in bars/ already and are not fetched again.
    assert fetch_data.fetch_premium_bars(tmp_path) == {
        "premium_tickers_candidates": 3,
        "premium_bars_extra_requested": 2,
        "premium_bars_extra_cached": 1,
        "premium_bars_extra_not_found": ["SHARE"],
    }
    assert fetch_data.fetch_event_bars(tmp_path) == {
        "event_tickers_candidates": 3,
        "event_bars_extra_requested": 2,
        "event_bars_extra_cached": 1,
        "event_bars_extra_not_found": ["CONG"],
    }
    # Premium bars start before the first premium session (2025-10-16) so that 20 sessions of
    # dollar volume exist; event bars start with the main bars.
    assert fetches == [
        (["EXTRA", "SHARE"], tmp_path / "bars_premium", datetime(2025, 6, 1, tzinfo=UTC), "premium-bars"),
        (["CLUS", "CONG"], tmp_path / "bars_events", datetime(2015, 6, 1, tzinfo=UTC), "event-bars"),
    ]


def test_collector_fetch_bars_keeps_the_cache_and_raises_when_a_ticker_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch_data = _collector()
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    header = ",".join(fetch_data.BAR_COLUMNS)
    (bars_dir / "CACHED.csv").write_text(f"{header}\n2024-01-02,1,1,1,1,1,1,1\n", encoding="utf-8")
    (bars_dir / "OLDCOLS.csv").write_text("date,open,high,low,close,adj_close,volume\n2024-01-02,1,1,1,1,1,1\n", encoding="utf-8")
    (bars_dir / "GONE.csv").write_text(f"{header}\n", encoding="utf-8")  # header only: not current
    stamp = int(datetime(2024, 1, 2, 14, 30, tzinfo=UTC).timestamp())
    chart = {"timestamp": [stamp], "indicators": {"quote": [{"open": [10.0], "high": [11.0], "low": [9.0], "close": [10.5], "volume": [100]}]}}
    asked: list[tuple[str, int, int]] = []

    def fake_chart(symbol: str, p1: int, p2: int) -> dict[str, Any] | None:
        asked.append((symbol, p1, p2))
        if symbol == "FAIL":
            raise fetch_data.YahooFetchError("FAIL: HTTP 429 after 4 attempts")
        return None if symbol == "GONE" else chart

    monkeypatch.setattr(fetch_data, "_yahoo_chart", fake_chart)
    monkeypatch.setattr(fetch_data.time, "sleep", lambda _seconds: None)
    first_day = datetime(2015, 6, 1, tzinfo=UTC)

    assert fetch_data._fetch_bars(["CACHED", "OLDCOLS", "GONE"], bars_dir, first_day, "bars") == (2, ["GONE"])
    # A current file is not fetched again; an old layout is; a ticker without history loses its stale file.
    p1, p2 = int(first_day.timestamp()), int(datetime(2026, 11, 25, tzinfo=UTC).timestamp())
    assert asked == [("OLDCOLS", p1, p2), ("GONE", p1, p2)]
    assert (bars_dir / "OLDCOLS.csv").read_text(encoding="utf-8").splitlines() == [header, "2024-01-02,10.0,11.0,9.0,10.5,10.5,100.0,10.5"]
    assert not (bars_dir / "GONE.csv").exists()

    # A ticker that Yahoo did not answer for stops the step: it must not drop out of the universe
    # as "no history". The tickers fetched before and after it stay cached.
    with pytest.raises(fetch_data.YahooFetchError, match="1 tickers failed after retries: FAIL. Run the step again"):
        fetch_data._fetch_bars(["NEW1", "FAIL", "NEW2"], bars_dir, first_day, "bars")
    assert (bars_dir / "NEW1.csv").exists() and (bars_dir / "NEW2.csv").exists()
    assert not (bars_dir / "FAIL.csv").exists()


def test_collector_form4_file_appears_only_after_the_last_quarter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fetch_data = _collector()
    quarters = [(2024, 1), (2024, 2)]
    monkeypatch.setattr(fetch_data, "_sec_quarters", lambda: quarters)
    monkeypatch.setattr(fetch_data.time, "sleep", lambda _seconds: None)
    zips_dir = tmp_path / "sec_zips"
    zips_dir.mkdir()
    for year, quarter in quarters:
        (zips_dir / f"{year}q{quarter}_form345.zip").write_bytes(b"z" * 1000)  # large enough: no download

    def no_download(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a cached quarter must not be downloaded")

    monkeypatch.setattr(fetch_data.urllib.request, "urlopen", no_download)
    rows_by_zip = {
        "2024q1_form345.zip": [
            Form4Purchase("q1-a", date(2024, 1, 15), date(2024, 1, 12), "123", "ACME", "900001|900002", "Director", "common", 100.0, 20.5, 400.0, True),
            Form4Purchase("q1-b", date(2024, 2, 1), None, "123", "ACME", "900003", "", "ordinary", 5.0, 21.0, None),
        ],
        "2024q2_form345.zip": [Form4Purchase("q2-a", date(2024, 4, 2), date(2024, 4, 1), "456", "ZETA", "900004", "Officer", "common", 7.0, 3.0, 0.0)],
    }
    failing: set[str] = {"2024q2_form345.zip"}
    parsed: list[str] = []

    def fake_parse(zip_path: Path) -> list[Form4Purchase]:
        parsed.append(zip_path.name)
        if zip_path.name in failing:
            raise zipfile.BadZipFile("File is not a zip file")
        return rows_by_zip[zip_path.name]

    monkeypatch.setattr(fetch_data, "parse_sec_form4_zip", fake_parse)
    final = tmp_path / "form4_purchases.jsonl"
    final.write_text("old history\n", encoding="utf-8")

    # The second quarter fails: the error goes up, and the file of the last good run is untouched.
    with pytest.raises(zipfile.BadZipFile):
        fetch_data.fetch_sec_form4(tmp_path, "contact@example.com")
    assert parsed == ["2024q1_form345.zip", "2024q2_form345.zip"]
    assert final.read_text(encoding="utf-8") == "old history\n"

    # Every quarter parses: the file holds the rows of both quarters in order, and no partial file is left.
    failing.clear()
    assert fetch_data.fetch_sec_form4(tmp_path, "contact@example.com") == final
    assert [json.loads(line) for line in final.read_text(encoding="utf-8").splitlines()] == [
        {
            "accession_number": "q1-a",
            "filing_date": "2024-01-15",
            "transaction_date": "2024-01-12",
            "issuer_cik": "123",
            "ticker": "ACME",
            "owner_group_key": "900001|900002",
            "role_text": "Director",
            "security": "common",
            "shares": 100.0,
            "price": 20.5,
            "holding_before": 400.0,
            "is_10b5_1": True,
        },
        {
            "accession_number": "q1-b",
            "filing_date": "2024-02-01",
            "transaction_date": None,
            "issuer_cik": "123",
            "ticker": "ACME",
            "owner_group_key": "900003",
            "role_text": "",
            "security": "ordinary",
            "shares": 5.0,
            "price": 21.0,
            "holding_before": None,
            "is_10b5_1": False,
        },
        {
            "accession_number": "q2-a",
            "filing_date": "2024-04-02",
            "transaction_date": "2024-04-01",
            "issuer_cik": "456",
            "ticker": "ZETA",
            "owner_group_key": "900004",
            "role_text": "Officer",
            "security": "common",
            "shares": 7.0,
            "price": 3.0,
            "holding_before": 0.0,
            "is_10b5_1": False,
        },
    ]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["form4_purchases.jsonl", "sec_zips"]
    # The runner's loader reads the file back as the same purchases.
    assert load_form4_jsonl(final) == [*rows_by_zip["2024q1_form345.zip"], *rows_by_zip["2024q2_form345.zip"]]

    # A quarter that is not cached (or is too small to be a real file) is downloaded once and kept.
    requests: list[tuple[str, str | None]] = []

    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def read(self) -> bytes:
            return b"d" * 2000

    def fake_urlopen(request: Any, timeout: float) -> Response:
        requests.append((request.full_url, request.get_header("User-agent")))
        return Response()

    monkeypatch.setattr(fetch_data.urllib.request, "urlopen", fake_urlopen)
    (zips_dir / "2024q2_form345.zip").write_bytes(b"z" * 999)
    fetch_data.fetch_sec_form4(tmp_path, "contact@example.com")
    assert [url for url, _agent in requests] == [fetch_data.SEC_ZIP_URL.format(year=2024, q=2)]
    assert requests[0][1] == fetch_data._sec_user_agent("contact@example.com")
    assert (zips_dir / "2024q2_form345.zip").read_bytes() == b"d" * 2000

    # A download that fails three times stops the run and names the URL; the last good file stays.
    def failing_urlopen(request: Any, timeout: float) -> Response:
        requests.append((request.full_url, None))
        raise fetch_data.urllib.error.URLError("no route")

    monkeypatch.setattr(fetch_data.urllib.request, "urlopen", failing_urlopen)
    (zips_dir / "2024q1_form345.zip").unlink()
    before = final.read_text(encoding="utf-8")
    with pytest.raises(RuntimeError, match="Failed downloading .*2024q1_form345.zip: .*no route"):
        fetch_data.fetch_sec_form4(tmp_path, "contact@example.com")
    assert len(requests) == 1 + 3
    assert final.read_text(encoding="utf-8") == before


def test_collector_main_runs_the_chosen_steps_and_saves_metadata_after_each(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fetch_data = _collector()
    calls: list[tuple[Any, ...]] = []
    meta_path_of: dict[str, Path] = {}

    def saved_keys() -> list[str]:
        """The keys of metadata.json on disk at the moment a step starts."""
        path = meta_path_of["path"]
        return sorted(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else []

    def step(name: str, result: Any) -> Any:
        def fake(*args: Any) -> Any:
            calls.append((name, *args, saved_keys()))
            return result

        return fake

    ledger = [{"chamber": "house", "status": "parsed", "reason": "", "cnt": 3}]
    monkeypatch.setattr(fetch_data, "_load_contact_email", lambda: "contact@example.com")
    monkeypatch.setattr(fetch_data, "fetch_sec_form4", step("sec", None))
    monkeypatch.setattr(fetch_data, "export_market_premium", step("premium-export", None))
    monkeypatch.setattr(fetch_data, "export_congress_2026", step("congress-export", {"ledger_2026": ledger}))
    monkeypatch.setattr(fetch_data, "fetch_congress_history", step("congress", (Path("unused"), {"congress_ledger": {"house:2026:parsed:": 3}})))
    monkeypatch.setattr(fetch_data, "fetch_daily_bars", step("bars", {"universe_requested": 600}))
    monkeypatch.setattr(fetch_data, "fetch_premium_bars", step("premium-bars", {"premium_bars_extra_cached": 4}))
    monkeypatch.setattr(fetch_data, "fetch_event_bars", step("event-bars", {"event_bars_extra_cached": 5}))

    def run(only: str | None, start_meta: dict[str, Any] | None) -> tuple[list[tuple[Any, ...]], dict[str, Any] | None]:
        out_dir = tmp_path / f"run-{len(list(tmp_path.iterdir()))}" / "nested"
        meta_path = out_dir / "metadata.json"
        meta_path_of["path"] = meta_path
        if start_meta is not None:
            out_dir.mkdir(parents=True)
            meta_path.write_text(json.dumps(start_meta), encoding="utf-8")
        calls.clear()
        monkeypatch.setattr(sys, "argv", ["fetch_data.py", "--out-dir", str(out_dir), *(["--only", only] if only else [])])
        assert fetch_data.main() == 0
        assert out_dir.is_dir()
        steps = [(name, *(arg for arg in rest if arg != out_dir)) for name, *rest in calls]
        return steps, json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else None

    email = "contact@example.com"
    old = {"kept": 1}
    # The steps without metadata leave the file alone.
    assert run("sec", None) == ([("sec", email, [])], None)
    # postgres-congress exports the Congress tables only; postgres exports the premium table too.
    assert run("postgres-congress", old) == ([("congress-export", ["kept"])], {"kept": 1, "ledger_2026": ledger})
    assert run("postgres", old) == ([("premium-export", ["kept"]), ("congress-export", ["kept"])], {"kept": 1, "ledger_2026": ledger})
    # congress passes the stored 2026 ledger on and drops the key of an older version of the script.
    stored = {"kept": 1, "ledger_2026": ledger, "congress_scanned_summary": {"house": 1}}
    assert run("congress", stored) == (
        [("congress", email, ledger, ["congress_scanned_summary", "kept", "ledger_2026"])],
        {"kept": 1, "ledger_2026": ledger, "congress_ledger": {"house:2026:parsed:": 3}},
    )
    assert run("bars", old) == ([("bars", ["kept"])], {"kept": 1, "universe_requested": 600})
    assert run("premium-bars", old) == ([("premium-bars", ["kept"])], {"kept": 1, "premium_bars_extra_cached": 4})
    assert run("event-bars", old) == ([("event-bars", ["kept"])], {"kept": 1, "event_bars_extra_cached": 5})

    # Without --only every step runs in order. Each step that returns metadata is saved before the
    # next step starts, so a later failure loses nothing; the ledger of this run reaches the history step.
    steps, meta = run(None, None)
    assert steps == [
        ("sec", email, []),
        ("premium-export", []),
        ("congress-export", []),
        ("congress", email, ledger, ["ledger_2026"]),
        ("bars", ["congress_ledger", "ledger_2026"]),
        ("premium-bars", ["congress_ledger", "ledger_2026", "universe_requested"]),
        ("event-bars", ["congress_ledger", "ledger_2026", "premium_bars_extra_cached", "universe_requested"]),
    ]
    assert meta == {
        "ledger_2026": ledger,
        "congress_ledger": {"house:2026:parsed:": 3},
        "universe_requested": 600,
        "premium_bars_extra_cached": 4,
        "event_bars_extra_cached": 5,
    }
    # Without a stored ledger the history step gets an empty one (and refuses it itself).
    assert run("congress", None)[0] == [("congress", email, [], [])]
