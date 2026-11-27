"""Unit tests for Task 1 streamed-session qualifier and futures state-stability counter."""
from __future__ import annotations

import dataclasses
import json
import subprocess
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from strategies.flow_control.control import (
    BALANCED,
    BUYERS,
    FUTURES_RULES,
    GAP,
    HOLD_DELTA_AGAINST,
    HOLD_FEW_TRADES,
    HOLD_PRICE_AGAINST,
    NO_DATA,
    SELLERS,
    SESSION_START,
    TapeMinute,
)
from strategies.flow_control.stability import (
    EXIT_TIME_GATED,
    PSQL_TIMEOUT_SECONDS,
    READONLY_SESSION_SQL,
    RawDeepTradeRow,
    RawMinuteRow,
    SessionTapeInput,
    build_psql_command,
    build_readonly_sql,
    build_session_inputs,
    classify_session_day,
    evaluate_stability,
    format_markdown_report,
    load_rows_from_psql,
    main,
    ny_session_minute,
    parse_utc_timestamp,
    split_dsn_password,
    summarize_futures_session,
)

NY_TZ = ZoneInfo("America/New_York")


def _ny_utc(day: str, hour: int, minute: int, second: int = 0) -> datetime:
    y, m, d = (int(p) for p in day.split("-"))
    return datetime(y, m, d, hour, minute, second, tzinfo=NY_TZ).astimezone(timezone.utc)


def _full_covered_tape(
    day: str,
    symbol: str,
    count: int = 390,
    *,
    deep_buy: float = 0.0,
    deep_sell: float = 0.0,
    deep_trades: int = 0,
    delta: float = 0.0,
    volume: float = 100.0,
    vwap: float = 5000.0,
    close: float = 5000.0,
) -> SessionTapeInput:
    rows = tuple(
        TapeMinute(
            minute=m,
            deep_buy=deep_buy,
            deep_sell=deep_sell,
            deep_trades=deep_trades,
            delta=delta,
            volume=volume,
            vwap=vwap,
            close=close,
        )
        for m in range(count)
    )
    return SessionTapeInput(
        day=day,
        symbol=symbol,
        covered_minutes=rows,
        stored_minutes=count,
        last_stored_minute=count - 1,
        streamed_deep_trades=deep_trades * count,
        sampled_deep_trades=0,
    )


def test_classify_session_day_holidays_early_closes_and_coverage_boundaries():
    # Regular full RTH day: 370/390 boundary for both ES and NQ.
    assert classify_session_day("2026-11-20", 370, 370) is None
    assert classify_session_day("2026-11-20", 369, 370) == "es_under_covered"
    assert classify_session_day("2026-11-20", 370, 369) == "nq_under_covered"
    assert classify_session_day("2026-11-20", 369, 369) == "both_under_covered"

    # Weekend, Thanksgiving (2026-11-26) and Black Friday early close (2026-11-27).
    assert classify_session_day("2026-11-21", 390, 390) == "closed"
    assert classify_session_day("2026-11-26", 390, 390) == "closed"
    assert classify_session_day("2026-11-27", 390, 390) == "early_close"


def test_build_session_inputs_handles_est_edt_rth_window_coverage_and_deep_trades():
    # EST day (2026-11-20, UTC-5) and EDT day (2026-07-07, UTC-4).
    minute_rows = [
        # Outside RTH (09:29 and 16:00 ET) -> excluded.
        RawMinuteRow("ES", _ny_utc("2026-11-20", 9, 29), 60, 10.0, 100.0, 5000.0, 5001.0),
        RawMinuteRow("ES", _ny_utc("2026-11-20", 16, 0), 60, 10.0, 100.0, 5000.0, 5001.0),
        # Non-futures symbol -> ignored.
        RawMinuteRow("SPY", _ny_utc("2026-11-20", 9, 30), 60, 10.0, 100.0, 500.0, 501.0),
        # Covered minute 0 (covered_seconds=55) and uncovered minute 1 (covered_seconds=54).
        RawMinuteRow("ES", _ny_utc("2026-11-20", 9, 30), 55, 25.0, 300.0, 5000.0, 5002.0),
        RawMinuteRow("ES", _ny_utc("2026-11-20", 9, 31), 54, 15.0, 200.0, 5001.0, 5003.0),
        # EDT check at 09:30 EDT = 13:30 UTC.
        RawMinuteRow("NQ", _ny_utc("2026-07-07", 9, 30), 60, -10.0, 150.0, 20000.0, 19995.0),
    ]
    trade_rows = [
        RawDeepTradeRow("ES", _ny_utc("2026-11-20", 9, 30, 12), "buy", 50.0, "streamed"),
        RawDeepTradeRow("ES", _ny_utc("2026-11-20", 9, 30, 48), "sell", 20.0, "sampled"),
        # Outside RTH -> ignored.
        RawDeepTradeRow("ES", _ny_utc("2026-11-20", 9, 29, 59), "buy", 99.0, "streamed"),
        # Non-futures -> ignored.
        RawDeepTradeRow("SPY", _ny_utc("2026-11-20", 9, 30, 10), "buy", 10.0, "streamed"),
    ]
    sessions = build_session_inputs(minute_rows, trade_rows)

    es = sessions[("2026-11-20", "ES")]
    assert es.stored_minutes == 2
    assert es.last_stored_minute == 1  # uncovered minute 1 advances through, matching flow-control.ts
    assert len(es.covered_minutes) == 1
    assert es.covered_minutes[0] == TapeMinute(
        minute=0,
        deep_buy=50.0,
        deep_sell=20.0,
        deep_trades=2,
        delta=25.0,
        volume=300.0,
        vwap=5000.0,
        close=5002.0,
    )
    assert es.streamed_deep_trades == 1
    assert es.sampled_deep_trades == 1

    nq_edt = sessions[("2026-07-07", "NQ")]
    assert nq_edt.covered_minutes[0].minute == 0
    assert ny_session_minute(parse_utc_timestamp("2026-07-07T13:30:00Z")) == ("2026-07-07", 0)
    assert ny_session_minute(parse_utc_timestamp("2026-11-20T14:30:00Z")) == ("2026-11-20", 0)
    # Naive datetime is treated as UTC consistently with parse_utc_timestamp.
    assert ny_session_minute(datetime(2026, 11, 20, 14, 30, 0)) == ("2026-11-20", 0)

    with pytest.raises(ValueError, match="Unexpected deep trade side"):
        build_session_inputs([], [RawDeepTradeRow("ES", _ny_utc("2026-11-20", 9, 30, 5), "unknown", 10.0)])
    with pytest.raises(ValueError, match="Unexpected deep trade capture"):
        build_session_inputs([], [RawDeepTradeRow("ES", _ny_utc("2026-11-20", 9, 30, 5), "buy", 10.0, "other")])


def test_summarize_futures_session_counts_starts_ends_reversals_and_holds():
    # Window 15 with min_buckets=10 and max_missing_minutes=5 exercises holds, reversal, carry and gap.
    rules = dataclasses.replace(FUTURES_RULES, window_minutes=15)
    rows: list[TapeMinute] = []
    # Minutes 0..8: 1 trade each (9 trades total), ratio +0.6.
    for m in range(9):
        rows.append(TapeMinute(m, 80.0, 20.0, 1, 30.0, 200.0, 5000.0, 5001.0))
    # m=9: 0 trades -> window trades=9 < 10 -> hold few_trades (spell 1, min 1).
    rows.append(TapeMinute(9, 80.0, 20.0, 0, 30.0, 200.0, 5000.0, 5001.0))
    # m=10: trades=12 >= 10, delta sum < 0 -> hold delta_against (spell 1, min 1).
    rows.append(TapeMinute(10, 80.0, 20.0, 3, -500.0, 200.0, 5000.0, 5001.0))
    # m=11..12: delta sum > 0, close < vwap -> hold price_against (spell 1, 2 consecutive minutes).
    rows.append(TapeMinute(11, 80.0, 20.0, 2, 700.0, 200.0, 5000.0, 4999.0))
    rows.append(TapeMinute(12, 80.0, 20.0, 2, 30.0, 200.0, 5000.0, 4999.0))
    # m=13..18: passes all checks -> enters buyers at m=17 (since 13), holds buyers at m=18.
    for m in range(13, 19):
        rows.append(TapeMinute(m, 80.0, 20.0, 2, 30.0, 200.0, 5000.0, 5002.0))
    # m=19..24: massive selling -> exits buyers to balanced at m=19 (ratio <= -0.30, sellRun=1) -> sellers at m=23,24.
    for m in range(19, 25):
        rows.append(TapeMinute(m, 0.0, 2500.0, 5, -2000.0, 300.0, 5000.0, 4990.0))

    # Set last_stored_minute=30 so m=25..29 carry sellers (5 missing), m=30 triggers gap -> ends_to_gap=1.
    tape = SessionTapeInput(
        day="2026-11-20",
        symbol="ES",
        covered_minutes=tuple(rows),
        stored_minutes=31,
        last_stored_minute=30,
        streamed_deep_trades=50,
        sampled_deep_trades=0,
    )
    summary = summarize_futures_session(tape, rules=rules)

    assert summary.folded_steps == 31
    assert summary.session_start_minutes == 9
    assert summary.gap_minutes == 1
    assert summary.no_data_minutes == 10
    assert summary.starts == 2
    assert summary.buyers_starts == 1
    assert summary.sellers_starts == 1
    assert summary.ends == 2
    assert summary.ends_to_balanced == 1
    assert summary.ends_to_gap == 1
    assert summary.direct_flips == 0
    assert summary.reversals == 1
    assert summary.buyers_minutes == 2  # m=17,18
    assert summary.sellers_minutes == 7  # m=23,24 + carried m=25..29
    assert summary.hold_minutes == {
        HOLD_FEW_TRADES: 1,
        HOLD_DELTA_AGAINST: 1,
        HOLD_PRICE_AGAINST: 2,
    }
    assert summary.hold_spells == {
        HOLD_FEW_TRADES: 1,
        HOLD_DELTA_AGAINST: 1,
        HOLD_PRICE_AGAINST: 1,
    }
    assert summary.ratio_reached_balanced_minutes == 12  # m=9..16 (8) + m=19..22 (4)
    # Partial-session JSON shares divide by folded_steps (31) and sum to 1.0.
    shares = summary.to_json()["stateSessionShares"]
    assert sum(shares.values()) == pytest.approx(1.0, abs=1e-5)


def test_direct_flip_counted_when_min_minutes_is_one():
    rules = dataclasses.replace(FUTURES_RULES, window_minutes=10, min_minutes=1)
    rows = [TapeMinute(m, 80.0, 20.0, 2, 30.0, 200.0, 5000.0, 5001.0) for m in range(10)]
    rows.append(TapeMinute(10, 0.0, 5000.0, 20, -5000.0, 500.0, 5000.0, 4990.0))
    tape = SessionTapeInput("2026-11-20", "NQ", tuple(rows), 11, 10, 40, 0)
    summary = summarize_futures_session(tape, rules=rules)
    assert summary.starts == 2
    assert summary.direct_flips == 1
    assert summary.reversals == 1
    assert summary.ends == 0


def test_evaluate_stability_time_gate_and_disqualifications():
    # 4 full RTH sessions (Nov 20, 23, 24, 25) + Thanksgiving closed (Nov 26) + Black Friday early close (Nov 27)
    # + 1 under-covered day (Nov 30 with NQ=360) -> only 4 qualifying (< 5 -> time-gated).
    sessions: dict[tuple[str, str], SessionTapeInput] = {}
    for day in ("2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25"):
        sessions[(day, "ES")] = _full_covered_tape(day, "ES", 390)
        sessions[(day, "NQ")] = _full_covered_tape(day, "NQ", 375)
    sessions[("2026-11-26", "ES")] = _full_covered_tape("2026-11-26", "ES", 390)
    sessions[("2026-11-26", "NQ")] = _full_covered_tape("2026-11-26", "NQ", 390)
    sessions[("2026-11-27", "ES")] = _full_covered_tape("2026-11-27", "ES", 210)
    sessions[("2026-11-27", "NQ")] = _full_covered_tape("2026-11-27", "NQ", 210)
    sessions[("2026-11-30", "ES")] = _full_covered_tape("2026-11-30", "ES", 385)
    sessions[("2026-11-30", "NQ")] = _full_covered_tape("2026-11-30", "NQ", 360)

    report = evaluate_stability(sessions)
    assert report.qualifying_days == ("2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25")
    assert not report.ready_for_task1
    assert not report.ready_for_task2
    assert [(d.day, d.reason) for d in report.disqualified_days] == [
        ("2026-11-26", "closed"),
        ("2026-11-27", "early_close"),
        ("2026-11-30", "nq_under_covered"),
    ]
    assert report.by_symbol["ES"].sessions == 4
    assert report.by_symbol["NQ"].sessions == 4
    assert report.by_symbol["ALL"].sessions == 8

    # Upgrade Nov 30 NQ to 370 -> 5 qualifying -> ready_for_task1 becomes True!
    sessions[("2026-11-30", "NQ")] = _full_covered_tape("2026-11-30", "NQ", 370)
    ready_report = evaluate_stability(sessions)
    assert len(ready_report.qualifying_days) == 5
    assert ready_report.ready_for_task1 is True
    assert ready_report.ready_for_task2 is False

    md = format_markdown_report(ready_report)
    assert "**READY** (5/5 qualifying streamed RTH sessions for Task 1; 5/20 for Task 2)" in md
    assert "Returns / P&L read: **none**" in md
    assert "2026-11-27 | early_close" in md

    payload = ready_report.to_json()
    assert payload["readyForTask1"] is True
    assert payload["qualifyingSessionsCount"] == 5
    assert payload["rules"] == FUTURES_RULES.to_json()


def test_readonly_sql_and_psql_commands_and_error_handling(monkeypatch, capsys):
    sql_min = build_readonly_sql("flow_minutes", "2026-11-20", "2026-11-30")
    assert sql_min.startswith("SELECT row_to_json(t) FROM (SELECT symbol, minute, covered_seconds")
    assert "FROM flow_minutes" in sql_min
    assert "2026-11-20" in sql_min and "2026-11-30" in sql_min

    sql_tr = build_readonly_sql("flow_large_trades", "2026-11-20")
    assert "FROM flow_large_trades" in sql_tr

    with pytest.raises(ValueError):
        build_readonly_sql("flow_minutes", "2026-11-20; DROP TABLE flow_minutes")
    with pytest.raises(ValueError):
        build_readonly_sql("unknown_table", "2026-11-20")

    # URI password is stripped from argv and passed via PGPASSWORD env instead.
    redacted, pwd = split_dsn_password("postgres://vertex_research:s3cr%40t@db.local:5432/vertex")
    assert redacted == "postgres://vertex_research@db.local:5432/vertex"
    assert pwd == "s3cr@t"

    local_cmd = build_psql_command(sql_min, dsn="postgres://user:secret@localhost/vertex")
    assert local_cmd[:7] == ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-Atq", "-d", "postgres://user@localhost/vertex"]
    assert local_cmd[7:] == ["-c", READONLY_SESSION_SQL, "-c", sql_min]
    assert "secret" not in " ".join(local_cmd)

    ssh_cmd = build_psql_command(
        sql_min, ssh_host="quantvps", docker_container="vertex-postgres", pg_user="vertex_research", pg_db="vertex"
    )
    assert ssh_cmd[:8] == ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", "quantvps"]
    assert "docker exec vertex-postgres psql -v ON_ERROR_STOP=1" in ssh_cmd[8]
    assert "docker exec -i" not in ssh_cmd[8]
    assert READONLY_SESSION_SQL in ssh_cmd[8]

    # Leading '-' tokens are rejected to prevent flag injection.
    with pytest.raises(ValueError):
        build_psql_command(sql_min, ssh_host="-oProxyCommand=bad")
    with pytest.raises(ValueError):
        build_psql_command(sql_min, ssh_host="quantvps", docker_container="-u0")
    with pytest.raises(ValueError):
        build_psql_command(sql_min, dsn="-f/etc/passwd")

    # Fake subprocess returning one session (time-gated -> CLI returns EXIT_TIME_GATED).
    start = _ny_utc("2026-11-20", 9, 30)
    min_lines = "\n".join(
        json.dumps(
            {
                "symbol": sym,
                "minute": (start + timedelta(minutes=m)).isoformat(),
                "covered_seconds": 60,
                "delta": 10.0,
                "volume": 100.0,
                "vwap": 5000.0,
                "close": 5001.0,
            }
        )
        for sym in ("ES", "NQ")
        for m in range(380)
    )
    trade_line = json.dumps(
        {
            "symbol": "ES",
            "second": (start + timedelta(seconds=15)).isoformat(),
            "side": "buy",
            "size": 50.0,
            "capture": "streamed",
        }
    )
    seen: list[dict] = []

    def fake_run(cmd, capture_output, text, check, stdin=None, env=None, timeout=None):
        seen.append({"cmd": cmd, "stdin": stdin, "env": env, "timeout": timeout})
        out = min_lines if len(seen) % 2 == 1 else trade_line
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    mins, trades = load_rows_from_psql(from_day="2026-11-20", dsn="postgres://user:secret@localhost/vertex")
    assert len(mins) == 760 and len(trades) == 1
    assert seen[0]["stdin"] is subprocess.DEVNULL
    assert seen[0]["timeout"] == PSQL_TIMEOUT_SECONDS
    assert seen[0]["env"]["PGPASSWORD"] == "secret"
    assert "default_transaction_read_only=on" in seen[0]["env"]["PGOPTIONS"]
    assert "secret" not in " ".join(seen[0]["cmd"])

    # Non-canonical ISO date (20261120) normalizes identically in SQL and evaluate_stability.
    rc_gated = main(["--from-day", "20261120", "--dsn", "postgres://localhost/vertex", "--format", "json"])
    assert rc_gated == EXIT_TIME_GATED
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["readyForTask1"] is False
    assert parsed["qualifyingSessionsCount"] == 1

    rc_ready = main(
        ["--from-day", "2026-11-20", "--min-sessions", "1", "--dsn", "postgres://localhost/vertex", "--format", "markdown"]
    )
    assert rc_ready == 0
    assert "**READY** (1/1 qualifying streamed RTH sessions" in capsys.readouterr().out

    # Invalid arguments return exit 2 cleanly without traceback.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["--from-day", "2026-11-20"]) == 2
    assert main(["--from-day", "2026-11-20", "--min-covered", "0", "--dsn", "postgres://localhost/vertex"]) == 2
    assert main(["--from-day", "2026-11-25", "--to-day", "2026-11-20", "--dsn", "postgres://localhost/vertex"]) == 2
    assert main(["--from-day", "2026-11-20", "--min-sessions", "0", "--dsn", "postgres://localhost/vertex"]) == 2

    # SQL error stops loudly in loader and returns exit 1 cleanly in main().
    def fake_fail(cmd, capture_output, text, check, stdin=None, env=None, timeout=None):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="ERROR: permission denied")

    monkeypatch.setattr(subprocess, "run", fake_fail)
    with pytest.raises(RuntimeError, match="permission denied"):
        load_rows_from_psql(from_day="2026-11-20", dsn="postgres://localhost/vertex")
    assert main(["--from-day", "2026-11-20", "--dsn", "postgres://localhost/vertex"]) == 1
    assert "permission denied" in capsys.readouterr().err


def test_evaluate_stability_folds_trailing_outage_through_389_and_shares_sum_to_one():
    # Qualifying session with 375 covered minutes (0..374) where buyers is active at 374,
    # followed by a late-day outage (no rows stored for 375..389).
    sessions = {
        ("2026-11-20", "ES"): _full_covered_tape(
            "2026-11-20",
            "ES",
            375,
            deep_buy=80.0,
            deep_sell=20.0,
            deep_trades=2,
            delta=30.0,
            volume=200.0,
            vwap=5000.0,
            close=5001.0,
        ),
        ("2026-11-20", "NQ"): _full_covered_tape("2026-11-20", "NQ", 390),
    }
    report = evaluate_stability(sessions, min_sessions=1)
    assert report.ready_for_task1 is True
    es = [s for s in report.per_session if s.symbol == "ES"][0]
    # Fold runs through minute 389 (390 steps): m=375..379 carry buyers (5 missing), m=380..389 are gap (10 min).
    assert es.folded_steps == 390
    assert es.starts == 1
    assert es.ends == 1
    assert es.ends_to_gap == 1
    assert es.gap_minutes == 10
    assert sum(es.to_json()["stateSessionShares"].values()) == pytest.approx(1.0, abs=1e-5)
    assert sum(report.by_symbol["ES"].state_shares.values()) == pytest.approx(1.0, abs=1e-6)
    assert sum(report.by_symbol["ALL"].state_shares.values()) == pytest.approx(1.0, abs=1e-6)
