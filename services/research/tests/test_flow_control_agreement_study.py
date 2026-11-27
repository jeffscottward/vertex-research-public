"""Unit tests for Task 2 agreement continuation study (futures state + options agreement)."""
from __future__ import annotations

import dataclasses
import json
import subprocess
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from strategies.flow_control import agreement_study, data, rules, study
from strategies.flow_control.control import (
    AGREE,
    BALANCED,
    BOTH_BALANCED,
    BUYERS,
    DIVERGE,
    FUTURES_RULES,
    GAP,
    MIXED,
    NO_DATA,
    NOT_COMPARABLE,
    ONE_SIDED,
    SELLERS,
    SESSION_START,
    DriftMinute,
    TapeMinute,
)
from strategies.flow_control.data import Loaded, TickerSession
from strategies.flow_control.rules import BARS, Params
from strategies.flow_control.stability import (
    EXIT_TIME_GATED,
    RawDeepTradeRow,
    RawMinuteRow,
    SessionTapeInput,
)
from strategies.imom.data import is_closed, is_early_close

from .test_flow_control_options import market

NY_TZ = ZoneInfo("America/New_York")


def _ny_utc(day: str, hour: int, minute: int, second: int = 0) -> datetime:
    y, m, d = (int(p) for p in day.split("-"))
    return datetime(y, m, d, hour, minute, second, tzinfo=NY_TZ).astimezone(timezone.utc)


def _full_rth_days(first: str, count: int) -> list[str]:
    out: list[str] = []
    cur = date.fromisoformat(first)
    while len(out) < count:
        if cur.weekday() < 5 and not is_closed(cur) and not is_early_close(cur):
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def _tape_minute(
    minute: int,
    side: int,
    *,
    base: float = 5000.0,
    deep_trades: int = 2,
) -> TapeMinute:
    if side > 0:
        return TapeMinute(
            minute=minute,
            deep_buy=100.0,
            deep_sell=0.0,
            deep_trades=deep_trades,
            delta=50.0,
            volume=500.0,
            vwap=base,
            close=base + 1.0,
        )
    if side < 0:
        return TapeMinute(
            minute=minute,
            deep_buy=0.0,
            deep_sell=100.0,
            deep_trades=deep_trades,
            delta=-50.0,
            volume=500.0,
            vwap=base,
            close=base - 1.0,
        )
    return TapeMinute(
        minute=minute,
        deep_buy=50.0,
        deep_sell=50.0,
        deep_trades=deep_trades,
        delta=0.0,
        volume=500.0,
        vwap=base,
        close=base,
    )


def _session_tape(
    day: str,
    symbol: str,
    side_by_minute,
    *,
    count: int = 390,
    base: float = 5000.0,
) -> SessionTapeInput:
    rows = tuple(
        _tape_minute(m, side_by_minute(m) if callable(side_by_minute) else side_by_minute, base=base)
        for m in range(count)
    )
    return SessionTapeInput(
        day=day,
        symbol=symbol,
        covered_minutes=rows,
        stored_minutes=count,
        last_stored_minute=count - 1,
        streamed_deep_trades=sum(r.deep_trades for r in rows),
        sampled_deep_trades=0,
    )


def _ticker_session(
    ticker: str,
    day: str,
    side_by_minute,
    base: float,
    *,
    price_dir: int | None = None,
) -> TickerSession:
    minutes: list[DriftMinute] = []
    for m in range(390):
        s = side_by_minute(m) if callable(side_by_minute) else side_by_minute
        if s > 0:
            minutes.append(DriftMinute(m, 100.0, 0.0))
        elif s < 0:
            minutes.append(DriftMinute(m, 0.0, 100.0))
        else:
            minutes.append(DriftMinute(m, 50.0, 50.0))
    if price_dir is None:
        first_s = side_by_minute(20) if callable(side_by_minute) else side_by_minute
        price_dir = first_s if first_s != 0 else 1
    price = tuple(base * (1.0 + price_dir * 0.0001 * b) for b in range(BARS))
    return TickerSession(ticker, day, tuple(minutes), price, False, ())


def _synthetic_pair(
    days: list[str],
    *,
    futures_side_fn=None,
    options_side_fn=None,
) -> tuple[dict[tuple[str, str], SessionTapeInput], Loaded]:
    bases = {"SPX": 5000.0, "SPY": 500.0, "QQQ": 450.0, "NDX": 20000.0}
    tape: dict[tuple[str, str], SessionTapeInput] = {}
    sessions: dict[str, dict[str, TickerSession]] = {}
    for idx, day in enumerate(days):
        default_side = 1 if idx % 3 else -1
        f_side = futures_side_fn(idx, day) if futures_side_fn else default_side
        o_side = options_side_fn(idx, day) if options_side_fn else default_side
        tape[(day, "ES")] = _session_tape(day, "ES", f_side, base=5000.0)
        tape[(day, "NQ")] = _session_tape(day, "NQ", f_side, base=20000.0)
        sessions[day] = {
            t: _ticker_session(t, day, o_side, bases[t]) for t in data.TICKERS
        }
    loaded = Loaded(tuple(days), sessions, (), 0, 0, ())
    return tape, loaded


def _markets_for(first: str = "2026-10-01", last: str = "2027-03-31"):
    return {
        "SPY": market("SPY", first, last),
        "QQQ": market("QQQ", first, last),
    }


# --- alignment and qualification ----------------------------------------------------------------------------------


def test_align_sessions_qualifies_streamed_tape_and_intersects_net_drift():
    days = _full_rth_days("2026-11-20", 4)
    # day 0: both tape and net drift OK
    # day 1: streamed tape OK, missing from net drift (with skip reason)
    # day 2: ES under-covered (369 < 370) -> disqualified tape day
    # day 3: both OK
    # Plus Black Friday 2026-11-27 (early close) and Thanksgiving 2026-11-26 (closed).
    tape: dict[tuple[str, str], SessionTapeInput] = {
        (days[0], "ES"): _session_tape(days[0], "ES", 1, count=390),
        (days[0], "NQ"): _session_tape(days[0], "NQ", 1, count=390),
        (days[1], "ES"): _session_tape(days[1], "ES", 1, count=375),
        (days[1], "NQ"): _session_tape(days[1], "NQ", 1, count=375),
        (days[2], "ES"): _session_tape(days[2], "ES", 1, count=369),
        (days[2], "NQ"): _session_tape(days[2], "NQ", 1, count=390),
        (days[3], "ES"): _session_tape(days[3], "ES", 1, count=390),
        (days[3], "NQ"): _session_tape(days[3], "NQ", 1, count=390),
        ("2026-11-26", "ES"): _session_tape("2026-11-26", "ES", 1, count=390),
        ("2026-11-26", "NQ"): _session_tape("2026-11-26", "NQ", 1, count=390),
        ("2026-11-27", "ES"): _session_tape("2026-11-27", "ES", 1, count=210),
        ("2026-11-27", "NQ"): _session_tape("2026-11-27", "NQ", 1, count=210),
    }
    bases = {"SPX": 5000.0, "SPY": 500.0, "QQQ": 450.0, "NDX": 20000.0}
    extra_nd_day = _full_rth_days(days[3], 2)[1]
    nd_days = (days[0], days[2], days[3], extra_nd_day)
    nd_sessions = {
        d: {t: _ticker_session(t, d, 1, bases[t]) for t in data.TICKERS}
        for d in nd_days
    }
    loaded = Loaded(
        nd_days,
        nd_sessions,
        ({"day": days[1], "ticker": "SPY", "reason": "thin"},),
        1,
        0,
        (),
    )

    aligned = agreement_study.align_sessions(tape, loaded, from_day="2026-11-20")
    assert aligned.streamed_qualifying_days == (days[0], days[1], days[3])
    assert aligned.usable_days == (days[0], days[3])
    assert aligned.missing_net_drift_days == (
        {"day": days[1], "reasons": ["SPY:thin"]},
    )
    assert aligned.net_drift_only_days == (days[2], extra_nd_day)
    disq = {d.day: d.reason for d in aligned.disqualified_tape_days}
    assert disq == {
        days[2]: "es_under_covered",
        "2026-11-26": "closed",
        "2026-11-27": "early_close",
    }


def test_align_sessions_validates_bounds():
    tape, loaded = _synthetic_pair(_full_rth_days("2026-11-20", 2))
    with pytest.raises(ValueError, match="to_day"):
        agreement_study.align_sessions(tape, loaded, from_day="2026-11-25", to_day="2026-11-20")
    with pytest.raises(ValueError, match="min_covered_minutes"):
        agreement_study.align_sessions(tape, loaded, min_covered_minutes=0)


# --- state & agreement frequencies --------------------------------------------------------------------------------


def test_frequencies_cover_all_states_and_agreements_with_exact_conservation():
    # Construct 3 sessions covering:
    # - day 0: sp500 both buyers (agree bullish), nasdaq100 both sellers (agree bearish)
    # - day 1: sp500 futures buyers + options sellers (diverge), nasdaq100 futures balanced + options buyers (one_sided)
    # - day 2: sp500 both balanced (both_balanced), nasdaq100 options mixed (primary buyers, check sellers -> not_comparable)
    days = _full_rth_days("2026-11-20", 3)
    bases = {"SPX": 5000.0, "SPY": 500.0, "QQQ": 450.0, "NDX": 20000.0}
    tape: dict[tuple[str, str], SessionTapeInput] = {
        (days[0], "ES"): _session_tape(days[0], "ES", 1, base=5000.0),
        (days[0], "NQ"): _session_tape(days[0], "NQ", -1, base=20000.0),
        (days[1], "ES"): _session_tape(days[1], "ES", 1, base=5000.0),
        (days[1], "NQ"): _session_tape(days[1], "NQ", 0, base=20000.0),
        (days[2], "ES"): _session_tape(days[2], "ES", 0, base=5000.0),
        (days[2], "NQ"): _session_tape(days[2], "NQ", 1, base=20000.0),
    }
    sessions = {
        days[0]: {
            "SPX": _ticker_session("SPX", days[0], 1, bases["SPX"]),
            "SPY": _ticker_session("SPY", days[0], 1, bases["SPY"]),
            "QQQ": _ticker_session("QQQ", days[0], -1, bases["QQQ"]),
            "NDX": _ticker_session("NDX", days[0], -1, bases["NDX"]),
        },
        days[1]: {
            "SPX": _ticker_session("SPX", days[1], -1, bases["SPX"]),
            "SPY": _ticker_session("SPY", days[1], -1, bases["SPY"]),
            "QQQ": _ticker_session("QQQ", days[1], 1, bases["QQQ"]),
            "NDX": _ticker_session("NDX", days[1], 1, bases["NDX"]),
        },
        days[2]: {
            "SPX": _ticker_session("SPX", days[2], 0, bases["SPX"]),
            "SPY": _ticker_session("SPY", days[2], 0, bases["SPY"]),
            # QQQ buyers + NDX sellers -> options group state is MIXED -> not_comparable
            "QQQ": _ticker_session("QQQ", days[2], 1, bases["QQQ"]),
            "NDX": _ticker_session("NDX", days[2], -1, bases["NDX"]),
        },
    }
    loaded = Loaded(tuple(days), sessions, (), 0, 0, ())
    timelines = agreement_study.build_timelines(days, tape, loaded)
    freqs = agreement_study.summarize_frequencies(timelines)

    for scope_name, expected_min_per_session in (("fullSession", 390), ("entryWindow", 106)):
        scope = freqs[scope_name]
        for key, expected_sessions in (("sp500", 3), ("nasdaq100", 3), ("ALL", 6)):
            agg = scope[key]
            total = expected_sessions * expected_min_per_session
            assert agg["sessions"] == expected_sessions
            assert agg["totalMinutes"] == total
            f_counts = agg["futuresStates"]
            assert sum(f_counts[s] for s in (BUYERS, SELLERS, BALANCED, NO_DATA)) == total
            assert f_counts[SESSION_START] + f_counts[GAP] == f_counts[NO_DATA]
            assert sum(agg["futuresShares"][s] for s in (BUYERS, SELLERS, BALANCED, NO_DATA)) == pytest.approx(1.0, abs=1e-4)

            o_counts = agg["optionsStates"]
            assert sum(o_counts[s] for s in (BUYERS, SELLERS, BALANCED, MIXED, NO_DATA)) == total
            assert sum(agg["optionsShares"][s] for s in (BUYERS, SELLERS, BALANCED, MIXED, NO_DATA)) == pytest.approx(1.0, abs=1e-4)

            a_counts = agg["agreementStates"]
            assert sum(a_counts[s] for s in (AGREE, DIVERGE, ONE_SIDED, BOTH_BALANCED, NOT_COMPARABLE)) == total
            assert a_counts["agreeBullish"] + a_counts["agreeBearish"] == a_counts[AGREE]
            assert sum(agg["agreementShares"][s] for s in (AGREE, DIVERGE, ONE_SIDED, BOTH_BALANCED, NOT_COMPARABLE)) == pytest.approx(1.0, abs=1e-4)

    all_full = freqs["fullSession"]["ALL"]["agreementStates"]
    assert all_full["agreeBullish"] > 0
    assert all_full["agreeBearish"] > 0
    assert all_full[DIVERGE] > 0
    assert all_full[ONE_SIDED] > 0
    assert all_full[BOTH_BALANCED] > 0
    assert all_full[NOT_COMPARABLE] > 0
    assert freqs["fullSession"]["nasdaq100"]["optionsStates"][MIXED] > 0
    assert len(freqs["perSession"]) == 6


# --- continuation trade rules & parity ----------------------------------------------------------------------------


def test_options_only_mode_matches_frozen_rules_bit_for_bit():
    days = _full_rth_days("2026-11-20", 10)
    tape, loaded = _synthetic_pair(days)
    sessions = {
        key: [study.build_session(key, day, loaded.sessions[day]) for day in days]
        for key in study.INSTRUMENTS
    }
    for cfg, params in study.CONFIGS.items():
        for key in study.INSTRUMENTS:
            expected = rules.trades(sessions[key], params)
            actual = agreement_study.trades_for_mode(
                key, days, sessions[key], tape, loaded, params, mode="options_only"
            )
            assert actual == expected, f"Mismatch for {cfg} {key}"


def test_agreement_gates_entries_and_exits_when_futures_leaves_control():
    day = "2026-11-20"
    # Case 1: Options buyers + uptrend, futures balanced -> options_only enters, agreement skips.
    tape_bal, loaded_up = _synthetic_pair([day], futures_side_fn=lambda *_: 0, options_side_fn=lambda *_: 1)
    sess_es = [study.build_session("ES", day, loaded_up.sessions[day])]
    opt_trades = agreement_study.trades_for_mode("ES", [day], sess_es, tape_bal, loaded_up, Params(), mode="options_only")
    agr_trades = agreement_study.trades_for_mode("ES", [day], sess_es, tape_bal, loaded_up, Params(), mode="agreement")
    assert len(opt_trades) == 1
    assert len(agr_trades) == 0

    # Case 2: Both buyers at open, then futures turns balanced at minute 40 while options stay buyers.
    # Agreement enters at minute 16 (first eligible m=15 -> entry_bar=16) and exits when futures ratio falls below 0.10.
    def fut_drop(m: int) -> int:
        return 1 if m < 40 else -1

    tape_drop, loaded_drop = _synthetic_pair([day], futures_side_fn=lambda *_: fut_drop, options_side_fn=lambda *_: 1)
    sess_drop = [study.build_session("ES", day, loaded_drop.sessions[day])]
    opt_t = agreement_study.trades_for_mode("ES", [day], sess_drop, tape_drop, loaded_drop, Params(), mode="options_only")
    agr_t = agreement_study.trades_for_mode("ES", [day], sess_drop, tape_drop, loaded_drop, Params(), mode="agreement")
    assert len(opt_t) == 1 and opt_t[0].exit_reason == "time"
    assert len(agr_t) == 1 and agr_t[0].exit_reason == "state"
    assert agr_t[0].entry_bar == 16
    assert agr_t[0].exit_bar < 385


def test_custom_futures_rules_calibration_is_respected_and_recorded():
    # Requiring min_trades=500 prevents futures entry with 2 deep trades/min (window max 60 trades).
    days = _full_rth_days("2026-11-20", 20)
    tape, loaded = _synthetic_pair(days)
    strict_rules = dataclasses.replace(FUTURES_RULES, version="flow-futures-rules.v2-test", min_trades=500)
    res = agreement_study.run_agreement_study(
        days, tape, loaded, futures_rules=strict_rules, markets=None, nautilus=False
    )
    assert res["rules"]["futures"]["version"] == "flow-futures-rules.v2-test"
    assert res["rules"]["futures"]["minTrades"] == 500
    assert res["rows"]["C0-F"]["ticks"]["1"]["whole"]["trades"] == 0
    assert res["modeComparison"]["options_only"]["C0-F"]["ticks"]["1"]["whole"]["trades"] > 0


# --- 20-session and 35-session full study runs --------------------------------------------------------------------


def test_20_sessions_runs_without_split_crash_and_returns_needs_more_data():
    days = _full_rth_days("2026-11-20", 20)
    tape, loaded = _synthetic_pair(days)
    res = agreement_study.run_agreement_study(
        days, tape, loaded, markets=_markets_for(), nautilus=False
    )
    assert res["schema"] == agreement_study.SCHEMA
    assert res["splitStatus"] == "below_min_sessions"
    assert res["verdict"] == "needs-more-data"
    assert "20 streamed sessions" in res["verdictReason"]
    assert "100 out-of-sample trades needed" in res["verdictReason"]
    assert res["deflatedSharpe"]["probability"] is None
    assert res["optionsStatus"] == "ran"

    whole_f = study.stats_of(res, "C0-F", "whole", 1)
    whole_es = study.stats_of(res, "C0-F-ES", "whole", 1)
    whole_nq = study.stats_of(res, "C0-F-NQ", "whole", 1)
    assert whole_f["sessions"] == 20
    assert whole_f["trades"] == whole_es["trades"] + whole_nq["trades"]
    assert whole_f["trades"] > 0
    assert whole_f["netUsd"] == pytest.approx(whole_es["netUsd"] + whole_nq["netUsd"])

    whole_o = study.stats_of(res, "C0-O", "whole")
    whole_o_stress = study.stats_of(res, "C0-O-stress", "whole")
    assert whole_o["trades"] > 0
    assert whole_o_stress["netUsd"] < whole_o["netUsd"]

    # Companion mode comparison present for all three modes.
    assert set(res["modeComparison"]) == {"agreement", "futures_only", "options_only"}
    for mode in ("agreement", "futures_only", "options_only"):
        assert res["modeComparison"][mode]["C0-F"]["ticks"]["1"]["whole"]["trades"] > 0

    # Markdown and dark HTML reports render cleanly with key sections and no scripts.
    md = agreement_study.format_markdown_report(res)
    assert "## Verdict" in md
    assert "needs-more-data" in md
    assert "## State and agreement frequencies" in md
    assert "## Mode comparison" in md
    html = agreement_study.render_html_report(res)
    assert "<!doctype html>" in html
    assert "<script" not in html.lower()
    assert "agree" in html and "diverge" in html


def test_35_sessions_forms_walk_forward_split_and_computes_10_trial_dsr():
    days = _full_rth_days("2026-10-01", 35)
    tape, loaded = _synthetic_pair(days)
    res = agreement_study.run_agreement_study(
        days, tape, loaded, markets=_markets_for("2026-08-01", "2026-12-31"), nautilus=False
    )
    assert res["splitStatus"] == "full_walk_forward"
    assert res["split"]["outOfSample"]["sessions"] > 0
    assert len(res["series"]) == study.N_TRIALS == 10
    assert res["deflatedSharpe"]["trials"] == 10
    # 35 sessions still yields far fewer than 100 OOS trades -> needs-more-data.
    assert res["verdict"] == "needs-more-data"


def test_fomc_day_skipped_in_c0_and_included_in_v4():
    # 2026-12-09 is a scheduled FOMC decision day inside the 20-session window.
    day = "2026-12-09"
    tape, loaded = _synthetic_pair([day], futures_side_fn=lambda *_: 1, options_side_fn=lambda *_: 1)
    sess_es = [study.build_session("ES", day, loaded.sessions[day])]
    c0 = agreement_study.trades_for_mode("ES", [day], sess_es, tape, loaded, study.CONFIGS["C0"], mode="agreement")
    v4 = agreement_study.trades_for_mode("ES", [day], sess_es, tape, loaded, study.CONFIGS["V4"], mode="agreement")
    assert len(c0) == 0
    assert len(v4) == 1

def test_futures_only_run_when_markets_omitted():
    days = _full_rth_days("2026-11-20", 20)
    tape, loaded = _synthetic_pair(days)
    res = agreement_study.run_agreement_study(
        days, tape, loaded, markets=None, nautilus=False
    )
    assert res["optionsStatus"] == "not_provided"
    assert "C0-F" in res["rows"]
    assert "C0-O" not in res["rows"]
    assert res["verdict"] == "needs-more-data"


# --- CLI behavior & safety ----------------------------------------------------------------------------------------


def _make_raw_rows_for_days(days: list[str]) -> tuple[list[RawMinuteRow], list[RawDeepTradeRow]]:
    minute_rows: list[RawMinuteRow] = []
    trade_rows: list[RawDeepTradeRow] = []
    for day in days:
        for sym, base in (("ES", 5000.0), ("NQ", 20000.0)):
            for m in range(390):
                h, mn = divmod(9 * 60 + 30 + m, 60)
                ts = _ny_utc(day, h, mn, 0)
                minute_rows.append(RawMinuteRow(sym, ts, 60, 50.0, 500.0, base, base + 1.0))
                trade_rows.append(RawDeepTradeRow(sym, ts, "buy", 50.0, "streamed"))
                trade_rows.append(RawDeepTradeRow(sym, ts.replace(second=10), "buy", 50.0, "streamed"))
    return minute_rows, trade_rows


def test_cli_time_gated_exits_3_with_zero_peeking_and_no_writes(tmp_path, monkeypatch, capsys):
    days = _full_rth_days("2026-11-20", 4)
    raw_min, raw_tr = _make_raw_rows_for_days(days)
    _, loaded = _synthetic_pair(days)

    monkeypatch.setattr(agreement_study, "load_rows_from_psql", lambda **_: (raw_min, raw_tr))
    monkeypatch.setattr(agreement_study.data, "load_all", lambda *_a, **_kw: loaded)

    out_dir = tmp_path / "report-out"
    rc = agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path / "net-drift-root"),
        "--out", str(out_dir),
        "--format", "json",
    ])
    assert rc == EXIT_TIME_GATED
    payload = json.loads(capsys.readouterr().out)
    assert payload["readyForTask2"] is False
    assert payload["usableSessionCount"] == 4
    assert payload["minSessions"] == 20
    # Zero peeking before the 20-session gate: no returns, rows, or verdict fields.
    assert "rows" not in payload
    assert "verdict" not in payload
    assert not out_dir.exists()


def test_cli_ready_runs_study_and_writes_html_and_markdown(tmp_path, monkeypatch, capsys):
    days = _full_rth_days("2026-11-20", 20)
    raw_min, raw_tr = _make_raw_rows_for_days(days)
    _, loaded = _synthetic_pair(days)

    monkeypatch.setattr(agreement_study, "load_rows_from_psql", lambda **_: (raw_min, raw_tr))
    monkeypatch.setattr(agreement_study.data, "load_all", lambda *_a, **_kw: loaded)

    out_dir = tmp_path / "agreement-out"
    rc = agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path / "net-drift-root"),
        "--out", str(out_dir),
        "--no-nautilus",
        "--format", "markdown",
    ])
    assert rc == 0
    stdout = capsys.readouterr().out
    assert "READY (20/20" in stdout
    assert "needs-more-data" in stdout
    assert (out_dir / "index.html").is_file()
    assert (out_dir / "summary.md").is_file()
    assert "<script" not in (out_dir / "index.html").read_text().lower()


def test_cli_refuses_modified_frozen_spec(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(agreement_study.rules, "spec_sha256", lambda: "0" * 64)
    rc = agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path / "nd"),
    ])
    assert rc == 2
    assert "spec" in capsys.readouterr().err.lower()


def test_cli_validates_inputs_and_catches_transport_errors(tmp_path, monkeypatch, capsys):
    # Missing DSN / ssh-host
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert agreement_study.main(["--data", str(tmp_path)]) == 2
    capsys.readouterr()

    # Inverted date range
    assert agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--from-day", "2026-12-10",
        "--to-day", "2026-11-20",
        "--data", str(tmp_path),
    ]) == 2
    capsys.readouterr()

    # Out directory inside repository is rejected
    repo_root = Path(__file__).resolve().parents[3]
    assert agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path),
        "--out", str(repo_root / "tmp-bad-out"),
    ]) == 2
    capsys.readouterr()

    # Transport error exits 1 cleanly
    def boom(**_kw):
        raise subprocess.TimeoutExpired(cmd=["psql"], timeout=120)

    monkeypatch.setattr(agreement_study, "load_rows_from_psql", boom)
    rc = agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path),
    ])
    assert rc == 1
    assert "Error:" in capsys.readouterr().err


def test_verdict_requires_options_for_10_trial_dsr_and_handles_edge_no_edge():
    # Without option market data, >=100 OOS trades stays needs-more-data (not no-edge).
    v, reason = agreement_study._verdict_for_agreement(
        120, "full_walk_forward", 200, 110, 5000.0, {"probability": None}, options_status="not_provided"
    )
    assert v == "needs-more-data"
    assert "option market data" in reason

    # With all 10 trials, bar is net > 0 and DSR >= 0.95.
    assert agreement_study._verdict_for_agreement(
        120, "full_walk_forward", 200, 100, 10.0, {"probability": 0.95}
    )[0] == "edge"
    assert agreement_study._verdict_for_agreement(
        120, "full_walk_forward", 200, 100, 10.0, {"probability": 0.94}
    )[0] == "no-edge"
    assert agreement_study._verdict_for_agreement(
        120, "full_walk_forward", 200, 100, -10.0, {"probability": 0.99}
    )[0] == "no-edge"


def test_empty_days_skips_nautilus_cleanly_even_if_installed():
    empty_loaded = Loaded((), {}, (), 0, 0, ())
    res = agreement_study.run_agreement_study([], {}, empty_loaded, markets=None, nautilus=True)
    assert res["verdict"] == "needs-more-data"
    assert res["usableSessionCount"] == 0
    assert res["diagnostics"]["nautilus"] == {"status": "not run", "reason": "no sessions"}


def test_markets_with_nautilus_true_falls_back_cleanly_when_unavailable(monkeypatch):
    from nautilus_backtest import engine as nb_engine

    def _unavailable():
        raise nb_engine.NautilusUnavailable("nautilus-trader not installed")

    monkeypatch.setattr(nb_engine, "require", _unavailable)
    days = _full_rth_days("2026-11-20", 20)
    tape, loaded = _synthetic_pair(days)
    res = agreement_study.run_agreement_study(
        days, tape, loaded, markets=_markets_for(), nautilus=True
    )
    assert res["optionsStatus"] == "ran"
    assert res["rows"]["C0-O"]["parts"]["whole"]["trades"] > 0
    assert res["diagnostics"]["nautilus"]["status"] == "not run"
    assert "not installed" in res["diagnostics"]["nautilus"]["reason"]


def test_calibrated_futures_window_minutes_preserved_in_c0_and_matches_timelines():
    # Construct a session where futures is sellers for minutes 0..19 and buyers from minute 20 onward,
    # while options are always buyers and price rises. With window_minutes=15 (calibrated), the 15-min
    # window turns purely buyers by minute 34 and enters by minute 38 (within 09:45-11:30). With
    # window_minutes=30, it enters later; verify C0 uses the calibrated window_minutes=15 (not clobbered to 30).
    day = "2026-11-20"

    def fut_switch(m: int) -> int:
        return -1 if m < 20 else 1

    tape, loaded = _synthetic_pair([day], futures_side_fn=lambda *_: fut_switch, options_side_fn=lambda *_: 1)
    cal_rules = dataclasses.replace(FUTURES_RULES, version="flow-futures-rules.v2-w15", window_minutes=15)
    tl = agreement_study.build_timelines([day], tape, loaded, futures_rules=cal_rules)[0]
    first_agree_in_window = next(
        m for m in range(rules.ENTRY_FIRST, rules.ENTRY_LAST + 1) if tl.effective_agreement_states[m] == BUYERS
    )

    sess_es = [study.build_session("ES", day, loaded.sessions[day])]
    c0_cal = agreement_study.trades_for_mode(
        "ES", [day], sess_es, tape, loaded, study.CONFIGS["C0"], mode="agreement", futures_rules=cal_rules
    )
    c0_default = agreement_study.trades_for_mode(
        "ES", [day], sess_es, tape, loaded, study.CONFIGS["C0"], mode="agreement", futures_rules=FUTURES_RULES
    )
    assert len(c0_cal) == 1 and len(c0_default) == 1
    assert c0_cal[0].entry_bar == first_agree_in_window + 1
    assert c0_cal[0].entry_bar < c0_default[0].entry_bar


def test_short_entry_hard_stop_and_futures_only_and_v1_v2_v3_variants():
    day = "2026-11-20"
    # Short entry + hard stop (>0.40% adverse spike at bar 30) under both agreement and futures_only.
    bases = {"SPX": 5000.0, "SPY": 500.0, "QQQ": 450.0, "NDX": 20000.0}
    tape = {
        (day, "ES"): _session_tape(day, "ES", -1, base=5000.0),
        (day, "NQ"): _session_tape(day, "NQ", -1, base=20000.0),
    }
    # Falling price until bar 29, then +1% jump against short at bar 30 -> triggers 0.40% hard stop.
    spx_prices = tuple(5000.0 * (1.0 - 0.0001 * b) if b < 30 else 5050.0 for b in range(BARS))
    spx_min = tuple(DriftMinute(m, 0.0, 100.0) for m in range(390))
    sessions_map = {
        day: {
            "SPX": TickerSession("SPX", day, spx_min, spx_prices, False, ()),
            "SPY": _ticker_session("SPY", day, -1, bases["SPY"]),
            "QQQ": _ticker_session("QQQ", day, -1, bases["QQQ"]),
            "NDX": _ticker_session("NDX", day, -1, bases["NDX"]),
        }
    }
    loaded = Loaded((day,), sessions_map, (), 0, 0, ())
    sess_es = [study.build_session("ES", day, loaded.sessions[day])]
    for mode in ("agreement", "futures_only"):
        ts = agreement_study.trades_for_mode("ES", [day], sess_es, tape, loaded, Params(), mode=mode)
        assert len(ts) == 1
        assert ts[0].side == -1
        assert ts[0].exit_reason == "stop"
        assert ts[0].exit_bar == 31

    # futures_only enters independently when options are balanced, while agreement skips.
    tape_fo, loaded_fo = _synthetic_pair([day], futures_side_fn=lambda *_: 1, options_side_fn=lambda *_: 0)
    sess_fo = [study.build_session("ES", day, loaded_fo.sessions[day])]
    assert len(agreement_study.trades_for_mode("ES", [day], sess_fo, tape_fo, loaded_fo, Params(), mode="futures_only")) == 1
    assert len(agreement_study.trades_for_mode("ES", [day], sess_fo, tape_fo, loaded_fo, Params(), mode="agreement")) == 0

    # V3 (late entry up to minute 360) captures an entry that only turns bullish at minute 150, while C0 misses it.
    def late_bull(m: int) -> int:
        return 0 if m < 150 else 1

    tape_late, loaded_late = _synthetic_pair([day], futures_side_fn=lambda *_: late_bull, options_side_fn=lambda *_: late_bull)
    sess_late = [study.build_session("ES", day, loaded_late.sessions[day])]
    assert len(agreement_study.trades_for_mode("ES", [day], sess_late, tape_late, loaded_late, study.CONFIGS["C0"], mode="agreement")) == 0
    v3_t = agreement_study.trades_for_mode("ES", [day], sess_late, tape_late, loaded_late, study.CONFIGS["V3"], mode="agreement")
    assert len(v3_t) == 1 and v3_t[0].entry_bar > rules.ENTRY_LAST

    # V1 (window 15) vs V2 (window 60) differ in entry bar when flow flips from sellers to buyers at minute 20.
    def flip20(m: int) -> int:
        return -1 if m < 20 else 1

    tape_v, loaded_v = _synthetic_pair([day], futures_side_fn=lambda *_: flip20, options_side_fn=lambda *_: flip20)
    sess_v = [study.build_session("ES", day, loaded_v.sessions[day])]
    v1_t = agreement_study.trades_for_mode("ES", [day], sess_v, tape_v, loaded_v, study.CONFIGS["V1"], mode="agreement")
    v2_t = agreement_study.trades_for_mode("ES", [day], sess_v, tape_v, loaded_v, study.CONFIGS["V2"], mode="agreement")
    assert len(v1_t) == 1 and len(v2_t) == 1
    assert v1_t[0].entry_bar < v2_t[0].entry_bar


def test_input_validation_and_html_report_variants_and_time_gated_and_bad_out_file(tmp_path, monkeypatch, capsys):
    days = _full_rth_days("2026-10-01", 35)
    tape, loaded = _synthetic_pair(days)
    sess_es = [study.build_session("ES", days[0], loaded.sessions[days[0]])]

    with pytest.raises(ValueError, match="Unsupported instrument"):
        agreement_study.trades_for_mode("AAPL", [days[0]], sess_es, tape, loaded, Params())
    with pytest.raises(ValueError, match="does not match"):
        agreement_study.trades_for_mode("ES", [days[1]], sess_es, tape, loaded, Params())
    with pytest.raises(ValueError, match="strictly ascending and unique"):
        agreement_study.run_agreement_study([days[1], days[0]], tape, loaded, markets=None, nautilus=False)
    with pytest.raises(ValueError, match="strictly ascending and unique"):
        agreement_study.run_agreement_study([days[0], days[0]], tape, loaded, markets=None, nautilus=False)

    # Full 35-session HTML and Markdown reports include variants, out-of-sample, split, Nautilus, and FOMC.
    res35 = agreement_study.run_agreement_study(
        days, tape, loaded, markets=_markets_for("2026-08-01", "2026-12-31"), nautilus=False
    )
    html35 = agreement_study.render_html_report(res35)
    assert "<h2>Agreement variants (1 tick/side)</h2>" in html35
    assert "<h3>Out-of-sample (validation + test)</h3>" in html35
    assert "<h2>Walk-forward split</h2>" in html35
    assert "<h2>NautilusTrader fill check</h2>" in html35
    assert "<h2>FOMC decision days</h2>" in html35
    md35 = agreement_study.format_markdown_report(res35)
    assert "## Out-of-sample variants" in md35
    assert "## Diagnostics" in md35

    # Time-gated HTML report omits Deflated Sharpe and shows clean time-gated status without blank rules.
    aligned = agreement_study.align_sessions(
        {(days[0], "ES"): tape[(days[0], "ES")], (days[0], "NQ"): tape[(days[0], "NQ")]},
        loaded,
        from_day=days[0],
        to_day=days[0],
    )
    gated = agreement_study._time_gated_payload(aligned, min_sessions=15)
    html_gated = agreement_study.render_html_report(gated)
    assert "<h2>Deflated Sharpe</h2>" not in html_gated
    assert "time-gated" in html_gated
    assert "30 min" in html_gated
    md_gated = agreement_study.format_markdown_report(gated)
    assert "15-session time gate" in md_gated

    # CLI catches OSError when --out points to an existing regular file.
    days20 = _full_rth_days("2026-11-20", 20)
    raw_min, raw_tr = _make_raw_rows_for_days(days20)
    _, loaded20 = _synthetic_pair(days20)
    monkeypatch.setattr(agreement_study, "load_rows_from_psql", lambda **_: (raw_min, raw_tr))
    monkeypatch.setattr(agreement_study.data, "load_all", lambda *_a, **_kw: loaded20)
    blocking_file = tmp_path / "not-a-dir"
    blocking_file.write_text("file")
    rc = agreement_study.main([
        "--dsn", "postgresql://ro@localhost/vertex",
        "--data", str(tmp_path / "nd"),
        "--out", str(blocking_file),
        "--no-nautilus",
    ])
    assert rc == 1
    assert "Error:" in capsys.readouterr().err
