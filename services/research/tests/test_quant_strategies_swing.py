"""Unexecuted completed-bar/session studies using synthetic data only."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from strategies.swing import (Bar, RegimeObservation, SessionStudyEvidence, SessionWindow,
                              SwingPolicy, completed_bars, dual_zone_review, momentum,
                              protection_levels, session_breakout, swing_decision)

D = Decimal
START = datetime(2026, 1, 1, 20, tzinfo=timezone.utc)


def daily_bars(instrument="SYNTH", *, flat=False):
    result = []
    for i in range(51):
        close = D("100") if flat else D(100 + i)
        end = START + timedelta(days=i)
        result.append(Bar(instrument, end - timedelta(hours=6), end, end, f"s{i}", close - D("0.2"),
                          close + D("0.1"), close - D("0.5"), close,
                          D("200") if i == 50 else D("100"), True, "synthetic-bars", "raw"))
    return tuple(result)


def policy():
    return SwingPolicy(("risk-on",), 3600, D("0"), D("1.5"), D("0.1"), D("2"), D("2"), D("0.01"))


def snapshot():
    bars = daily_bars()
    return momentum(bars, instrument_id="SYNTH", as_of=bars[-1].end_at,
                    benchmark_bars=daily_bars("BENCH", flat=True), benchmark_id="BENCH")


def test_full_lookbacks_and_matched_benchmark_dates_not_partial_windows():
    result = snapshot()
    assert result.completed_count == 51
    assert result.feature("breakout20") == D("1")
    assert result.feature("breakout50") == D("1")
    assert result.feature("relative-volume") == D("2")
    assert result.feature("relative-strength20") > D("0")
    short = momentum(daily_bars()[:20], instrument_id="SYNTH", as_of=START + timedelta(days=20))
    assert short.feature("breakout20") is None
    assert "requires-21-completed-bars" in short.missing
    misaligned = tuple(replace(row, start_at=row.start_at + timedelta(seconds=1), end_at=row.end_at + timedelta(seconds=1),
                               available_at=row.available_at + timedelta(seconds=1)) for row in daily_bars("BENCH"))
    missing = momentum(daily_bars(), instrument_id="SYNTH", as_of=START + timedelta(days=51), benchmark_bars=misaligned, benchmark_id="BENCH")
    assert missing.feature("relative-strength20") is None


def test_incomplete_unavailable_and_future_bars_are_never_used():
    bars = daily_bars()
    now = bars[-1].end_at
    incomplete = replace(bars[-1], complete=False)
    assert len(completed_bars((*bars[:-1], incomplete), as_of=now, instrument_id="SYNTH")) == 50
    late = replace(bars[-1], available_at=now + timedelta(seconds=1))
    assert momentum((*bars[:-1], late), instrument_id="SYNTH", as_of=now).completed_count == 50
    with pytest.raises(ValueError, match="Duplicate"):
        completed_bars((*bars, bars[-1]), as_of=now, instrument_id="SYNTH")
    with pytest.raises(ValueError, match="adjustment"):
        completed_bars((*bars[:-1], replace(bars[-1], adjustment_basis="split-adjusted")), as_of=now, instrument_id="SYNTH")


def test_swing_proposal_next_bar_and_exit_are_not_protection_orders():
    snap = snapshot()
    regime = RegimeObservation("risk-on", snap.as_of, snap.as_of, "regime", True)
    result = swing_decision(snap, regime, as_of=snap.as_of, policy=policy())
    assert result.status == "proposal"
    assert "next-permitted-bar-only" in result.reasons
    assert result.executable is False
    protection = protection_levels(D("151"), D("0.5"), policy())
    below = replace(snap, features=tuple((key, D("149") if key == "close" else value) for key, value in snap.features))
    assert swing_decision(below, None, as_of=snap.as_of, policy=policy(), held_protection=protection).status == "exit"
    assert protection.active_order is False


def test_regime_unknown_or_stale_and_missing_volume_block_entries():
    snap = snapshot()
    assert swing_decision(snap, None, as_of=snap.as_of, policy=policy()).status == "unavailable"
    regime = RegimeObservation("risk-off", snap.as_of, snap.as_of, "regime", True)
    assert swing_decision(snap, regime, as_of=snap.as_of, policy=policy()).status == "hold"
    future = replace(regime, regime="risk-on", available_at=snap.as_of + timedelta(seconds=1))
    assert swing_decision(snap, future, as_of=snap.as_of, policy=policy()).status == "unavailable"
    bars = daily_bars()
    no_volume = (*bars[:-1], replace(bars[-1], volume=None))
    result = momentum(no_volume, instrument_id="SYNTH", as_of=bars[-1].end_at)
    assert result.feature("relative-volume") is None


def session_fixture():
    open_at = datetime(2026, 1, 2, 14, 30, tzinfo=timezone.utc)
    session = SessionWindow("session", "exchange-calendar", open_at, open_at + timedelta(minutes=10),
                            open_at + timedelta(hours=2), open_at + timedelta(hours=3), 300)
    rows = []
    for i in range(3):
        start = open_at + timedelta(minutes=5 * i)
        end = start + timedelta(minutes=5)
        close = D("102") if i == 2 else D("100")
        rows.append(Bar("EXACT-202603", start, end, end, "session", close, close + D("0.1"), close - D("0.1"),
                        close, D("200") if i == 2 else D("100"), True, "session-source", "raw"))
    evidence = SessionStudyEvidence("native-session-v1", "EXACT-202603", ("a" * 64,), "b" * 64, False, True)
    return session, tuple(rows), evidence


def test_session_range_requires_complete_calendar_bars_exact_contract_and_receipts():
    session, rows, evidence = session_fixture()
    result = session_breakout(rows, session=session, evidence=evidence, as_of=rows[-1].end_at, minimum_relative_volume=D("1.5"))
    assert result.status == "proposal"
    assert "descriptive-contaminated-study" in result.reasons
    assert "not-paper-or-live-approval" in result.reasons
    assert session_breakout(rows[1:], session=session, evidence=evidence, as_of=rows[-1].end_at,
                            minimum_relative_volume=D("1.5")).status == "unavailable"
    assert session_breakout(rows, session=session, evidence=replace(evidence, continuous_contract=True),
                            as_of=rows[-1].end_at, minimum_relative_volume=D("1.5")).status == "unavailable"
    assert session_breakout(rows, session=session, evidence=evidence, as_of=session.entry_cutoff_at,
                            minimum_relative_volume=D("1.5")).status == "hold"


def test_dual_zone_escalation_is_research_only_and_preserves_missing():
    snap = snapshot()
    result = dual_zone_review(snap, prior_close=D("149"), volume_trigger=D("1.5"))
    assert result.status == "review"
    assert "volume-escalation" in result.reasons
    assert result.executable is False
    assert dual_zone_review(snap, prior_close=None, volume_trigger=D("1.5")).status == "unavailable"
