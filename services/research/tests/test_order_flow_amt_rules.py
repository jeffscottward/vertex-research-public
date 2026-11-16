"""Order flow / AMT auction study: prior-session profile, the two frozen rules and the fill model (synthetic)."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from strategies.noise_band import Bar, Session
from strategies.order_flow_amt import profile, rules
from strategies.order_flow_amt.profile import Levels

LEVELS = Levels(poc=100.0, vah=101.0, val=99.0, bin=0.05)


def bars(prices, volume=1000.0, spread=0.05) -> tuple[Bar, ...]:
    """78 bars; each listed (open, high, low, close) or a close (high/low = close +/- spread); the rest flat."""
    out = []
    for k in range(rules.FULL_BARS):
        p = prices[k] if k < len(prices) else prices[-1]
        if isinstance(p, tuple):
            o, h, low, c = p
        else:
            o, h, low, c = p, p + spread, p - spread, p
        out.append(Bar(5 * k, o, h, low, c, volume))
    return tuple(out)


def session(day: date, prices, volume=1000.0) -> Session:
    return Session(day, bars(prices, volume))


def trading_days(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if not rules.is_closed(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def history(n: int = 16, start: date = date(2025, 2, 3)) -> list[Session]:
    """n flat full sessions on consecutive NYSE trading days (enough for ATR14 at index 15)."""
    return [Session(d, bars([100.0], spread=0.5)) for d in trading_days(start, n)]


# --- profile ------------------------------------------------------------------------------------------------------

def test_value_area_holds_seventy_percent_around_the_poc():
    prof = {10: 5.0, 11: 20.0, 12: 50.0, 13: 15.0, 14: 10.0}
    poc, low, high = profile.value_area(prof)
    assert poc == 12 and (low, high) == (11, 12)
    assert sum(prof[i] for i in range(low, high + 1)) >= 0.7 * sum(prof.values())


def test_value_area_tie_takes_the_upper_bin_and_poc_tie_the_middle():
    assert profile.value_area({1: 10.0, 2: 10.0, 3: 10.0})[0] == 2
    poc, low, high = profile.value_area({1: 1.0, 2: 5.0, 3: 1.0}, pct=0.8)
    assert (poc, low, high) == (2, 2, 3)


def test_volume_spreads_evenly_over_touched_bins():
    prof = profile.volume_profile([Bar(0, 10.0, 10.09, 10.0, 10.05, 300.0)], 0.05)
    assert prof == {200: 150.0, 201: 150.0}
    assert profile.volume_profile([Bar(0, 1, 1, 1, 1, 0.0)], 0.05) == {}


def test_bin_size_uses_atr_then_price():
    assert profile.bin_size(5.0, 400.0) == 0.1
    assert profile.bin_size(None, 400.0) == 0.4
    assert profile.bin_size(None, None) == 0.01
    assert profile.bin_size(0.1, 1.0) == 0.01


def test_atr_needs_fifteen_earlier_sessions_and_uses_true_range():
    start = date(2025, 1, 1)
    days = [session(start + timedelta(days=i), [100.0 + i]) for i in range(16)]
    assert profile.atr14(days, 14) is None
    # each session: high = close + 0.05, low = close - 0.05, prior close 1 lower -> true range 1.05
    assert profile.atr14(days, 15) == pytest.approx(1.05)


def test_session_levels_report_bin_edges_and_poc_middle():
    levels = profile.session_levels([Bar(0, 10.0, 10.04, 10.0, 10.0, 100.0)], 0.05)
    assert levels == Levels(poc=10.03, vah=10.05, val=10.0, bin=0.05)
    assert profile.session_levels([], 0.05) is None
    assert profile.prior_levels([session(date(2025, 1, 2), [100.0])], 0) is None
    assert profile.prior_levels(history(16), 15) is not None and profile.prior_levels(history(16), 14) is None


# --- rule A -------------------------------------------------------------------------------------------------------

def test_failed_auction_below_goes_long_toward_the_poc_after_two_closes_inside():
    b = bars([(99.5, 99.6, 98.5, 98.8), 99.2, 99.4])
    found = rules.failed_auction(b, LEVELS)
    assert found is not None and found.side == 1 and found.bar == 2 and found.rule == "A"
    assert found.stop_distance == pytest.approx(99.4 - (98.5 - 0.01))
    assert found.target_distance == pytest.approx(100.0 - 99.4)


def test_failed_auction_above_goes_short():
    b = bars([(100.5, 101.6, 100.4, 101.3), 100.8, 100.6])
    found = rules.failed_auction(b, LEVELS)
    assert found is not None and found.side == -1 and found.bar == 2
    assert found.stop_distance == pytest.approx(101.6 + 0.01 - 100.6)


def test_failed_auction_needs_every_close_after_the_probe_inside():
    b = bars([(99.5, 99.6, 98.5, 98.8), 98.9, 99.4, 99.5])
    found = rules.failed_auction(b, LEVELS)
    assert found is not None and found.bar == 3  # bar 1 closed outside, so the run starts after it


def test_failed_auction_skips_a_signal_past_the_target():
    b = bars([(99.5, 99.6, 98.5, 98.8), 99.2, 100.2, 100.3, 100.3])
    assert rules.failed_auction(b, LEVELS) is None


def test_failed_auction_later_probe_wins():
    b = bars([(99.5, 99.6, 98.5, 98.8), (99.0, 101.5, 99.0, 100.6), 100.5, 100.4])
    found = rules.failed_auction(b, LEVELS)
    assert found is not None and found.side == -1


def test_no_failed_auction_without_a_probe_or_after_the_entry_window():
    assert rules.failed_auction(bars([100.0]), LEVELS) is None
    late = [100.0] * 66 + [(99.5, 99.6, 98.5, 98.8), 99.2, 99.4]
    assert rules.failed_auction(bars(late), LEVELS) is None


# --- rule C -------------------------------------------------------------------------------------------------------

def test_acceptance_above_needs_six_closes_and_a_developing_poc_above_value():
    b = bars([101.5] * 8, volume=1000.0)
    found = rules.acceptance(b, LEVELS)
    assert found is not None and found.side == 1 and found.bar == 5 and found.rule == "C"
    assert found.target_distance == pytest.approx(103.0 - 101.5)
    assert found.stop_distance == pytest.approx(101.5 - (101.0 - 0.01))


def test_acceptance_below_goes_short():
    found = rules.acceptance(bars([98.5] * 8), LEVELS)
    assert found is not None and found.side == -1 and found.bar == 5


def test_acceptance_waits_for_the_developing_poc():
    heavy_inside = [(100.0, 100.05, 99.95, 100.0)] * 1
    b = list(bars(heavy_inside + [101.5] * 7))
    b[0] = Bar(0, 100.0, 100.05, 99.95, 100.0, 100_000.0)
    assert rules.acceptance(tuple(b), LEVELS) is None


def test_acceptance_skips_a_signal_beyond_its_target():
    assert rules.acceptance(bars([103.5] * 8), LEVELS) is None


# --- fill model ---------------------------------------------------------------------------------------------------

def signal(side=1, bar=2, stop=0.5, target=1.0) -> rules.Signal:
    return rules.Signal("A", side, bar, 100.0, stop, target, "test")


def test_entry_is_the_next_open_and_the_target_fills_at_the_level():
    b = bars([100.0, 100.0, 100.0, (100.1, 100.4, 100.0, 100.3), (100.3, 101.3, 100.2, 101.2)])
    trade = rules.simulate("SPY", "2025-01-02", b, signal())
    assert trade.entry_bar == 3 and trade.entry_price == 100.1
    assert trade.exit_reason == "target" and trade.exit_bar == 4 and trade.exit_price == pytest.approx(101.1)


def test_stop_comes_first_and_a_gap_fills_at_the_open():
    b = bars([100.0, 100.0, 100.0, (100.0, 101.5, 99.4, 101.0)])
    trade = rules.simulate("SPY", "2025-01-02", b, signal())
    assert trade.exit_reason == "stop" and trade.exit_price == pytest.approx(99.5)
    gap = bars([100.0, 100.0, 100.0, (100.0, 100.1, 99.9, 100.0), (99.0, 99.2, 98.8, 99.1)])
    trade = rules.simulate("SPY", "2025-01-02", gap, signal())
    assert trade.exit_reason == "stop" and trade.exit_price == 99.0 and trade.exit_bar == 4


def test_short_target_gap_fills_at_the_open_and_time_exit_at_the_last_close():
    b = bars([100.0, 100.0, 100.0, (100.0, 100.1, 99.9, 100.0), (98.5, 98.6, 98.4, 98.5)])
    trade = rules.simulate("SPY", "2025-01-02", b, signal(side=-1))
    assert trade.exit_reason == "target" and trade.exit_price == 98.5
    flat = bars([100.0])
    trade = rules.simulate("SPY", "2025-01-02", flat, signal(stop=5.0, target=5.0))
    assert trade.exit_reason == "time" and trade.exit_bar == rules.TIME_EXIT


def test_trades_take_the_first_signal_per_rule():
    days = history(16)
    nxt = trading_days(days[-1].day + timedelta(days=1), 1)[0]
    days.append(Session(nxt, bars([(99.5, 99.6, 95.0, 96.0), 100.0, 100.0, (99.5, 99.6, 95.0, 96.0), 100.0, 100.0])))
    out = rules.trades("SPY", days)
    assert set(out) == {"A", "C"} and len(out["A"]) == 1 and out["A"][0].signal_bar == 2
    assert rules.session_signals(days, 0) == {}
    assert rules.trades("SPY", days, first_day="2030-01-01") == {"A": [], "C": []}


def test_signal_arrays_mark_the_signal_bar_and_the_time_exit():
    b = bars([100.0, 100.0, 100.0, 100.0])
    trade = rules.simulate("SPY", "2025-01-02", b, signal(stop=0.5, target=1.0))
    s, st, tg, ca = rules.signal_arrays(trade, 1)
    assert s[2] == 1 and sum(s) == 1 and st[2] == 0.5 and tg[2] == 1.0 and ca[rules.TIME_EXIT] == 1
    s, *_ = rules.signal_arrays(trade, -1)
    assert sum(s) == 0


def test_spec_hash_reads_only_the_part_above_results(tmp_path):
    spec = tmp_path / "spec.md"
    spec.write_text("rule text\n## Results\nnumbers")
    first = rules.spec_sha256(spec)
    spec.write_text("rule text\n## Results\nother numbers")
    assert rules.spec_sha256(spec) == first


def test_no_signal_after_a_half_day_a_gap_without_atr_or_on_an_ex_dividend_day():
    probe = [(99.5, 99.6, 95.0, 96.0), 100.0, 100.0]
    days = history(17)
    full = days[:16] + [Session(days[16].day, bars(probe))]
    assert rules.session_signals(full, 16)
    assert rules.session_signals(full, 16, ex_dates={days[16].day.isoformat()}) == {}
    half = days[:15] + [Session(days[15].day, bars([100.0])[:42]), Session(days[16].day, bars(probe))]
    assert rules.session_signals(half, 16) == {}
    gap = days[:16] + [Session(trading_days(days[16].day + timedelta(days=1), 1)[0], bars(probe))]
    assert rules.session_signals(gap, 16) == {}
    assert rules.session_signals(full[2:], 14) == {}  # ATR14 needs 15 earlier sessions


def test_previous_trading_day_skips_weekends_and_holidays():
    assert rules.previous_trading_day(date(2025, 3, 3)) == date(2025, 2, 28)
    assert rules.previous_trading_day(date(2025, 12, 26)) == date(2025, 12, 24)


def test_one_bar_probing_both_sides_goes_long_like_the_live_job():
    b = bars([(100.0, 101.5, 98.5, 100.0), 100.1, 99.9])
    found = rules.failed_auction(b, LEVELS)
    assert found is not None and found.side == 1


def test_levels_match_the_live_amt_job_on_a_golden_session():
    """Expected values from market-watch-bot market_watch/auction/profile.session_profile (commit 90b750e6,
    2026-11-16) on the same 78 bars with a $0.12 bin."""
    import random

    rng = random.Random(7)
    golden, p = [], 500.0
    for k in range(78):
        o = p
        c = round(p + rng.uniform(-0.6, 0.6), 2)
        h = round(max(o, c) + rng.uniform(0, 0.4), 2)
        low = round(min(o, c) - rng.uniform(0, 0.4), 2)
        golden.append(Bar(5 * k, o, h, low, c, float(rng.randint(1000, 9000))))
        p = c
    assert profile.session_levels(golden, 0.12) == Levels(poc=492.66, vah=495.48, val=491.76, bin=0.12)


def test_the_committed_spec_matches_the_frozen_hash():
    assert rules.spec_sha256() == rules.SPEC_SHA256
