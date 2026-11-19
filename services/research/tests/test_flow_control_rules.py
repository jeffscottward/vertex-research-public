"""Options-side continuation study: frozen rule (trend, entry, exit), FOMC list and signal arrays. Synthetic only."""
from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from strategies.flow_control import fomc, rules
from strategies.flow_control.control import DriftMinute
from strategies.flow_control.rules import BARS, TIME_EXIT, Params, Session

DAY = "2025-06-03"
BUY = {m: (100.0, 0.0) for m in range(390)}
SELL = {m: (0.0, 100.0) for m in range(390)}
FLAT = {m: (50.0, 50.0) for m in range(390)}
RISING = [100.0 + 0.01 * b for b in range(BARS)]
FALLING = [100.0 - 0.01 * b for b in range(BARS)]


def _drift(drift: Mapping[int, tuple[float, float]]) -> tuple[DriftMinute, ...]:
    return tuple(DriftMinute(m, c, p) for m, (c, p) in sorted(drift.items()))


def synthetic_session(day: str, drift: Mapping[int, tuple[float, float]], prices: Sequence[float],
                      check: Mapping[int, tuple[float, float]] | None = None) -> Session:
    """One session with the same price for the instrument and the trend; `check` defaults to `drift`."""
    return Session(day, tuple(prices), tuple(prices), _drift(drift), _drift(check if check is not None else drift))


def test_spec_hash_matches_the_frozen_spec():
    assert rules.spec_sha256() == rules.SPEC_SHA256


def test_trend_needs_open_and_lookback():
    price = [100.0] * 40 + [101.0] * (BARS - 40)
    assert rules.trend(price, 45) == 1
    price2 = [100.0] * 10 + [99.0] * 20 + [100.5] * (BARS - 30)
    # Above the open, above 30 minutes earlier (99) -> +1; then equal to the earlier price -> 0.
    assert rules.trend(price2, 35) == 1
    assert rules.trend(price2, 70) == 0
    assert rules.trend(FALLING, 50) == -1


def test_trend_reads_the_primary_ticker_price_and_fills_use_the_instrument_price():
    instrument = [200.0 + 0.02 * b for b in range(BARS)]
    session = Session(DAY, tuple(instrument), tuple(RISING), _drift(BUY), _drift(BUY))
    trade = rules.session_trade(session, Params())
    assert trade is not None and trade.entry_price == instrument[trade.entry_bar]
    flat_trend = Session(DAY, tuple(instrument), tuple([100.0] * BARS), _drift(BUY), _drift(BUY))
    assert rules.session_trade(flat_trend, Params()) is None


def test_trend_before_1000_uses_the_open():
    assert rules.trend(RISING, 16) == 1  # price[max(0, 16 - 30)] is price[0]


def test_long_entry_fills_at_the_next_minute():
    trade = rules.session_trade(synthetic_session(DAY, BUY, RISING), Params())
    assert trade is not None
    assert (trade.side, trade.entry_bar, trade.entry_price) == (1, 16, RISING[16])
    assert (trade.exit_bar, trade.exit_reason) == (TIME_EXIT, "time")
    assert trade.points == pytest.approx(RISING[TIME_EXIT] - RISING[16])


def test_short_entry_is_the_mirror():
    trade = rules.session_trade(synthetic_session(DAY, SELL, FALLING), Params())
    assert trade is not None and (trade.side, trade.entry_bar) == (-1, 16)
    assert trade.points == pytest.approx(FALLING[16] - FALLING[TIME_EXIT])


def test_no_entry_against_the_trend():
    assert rules.session_trade(synthetic_session(DAY, BUY, FALLING), Params()) is None
    assert rules.session_trade(synthetic_session(DAY, SELL, RISING), Params()) is None


def test_no_entry_before_0945_or_after_the_last_entry_minute():
    late = {m: (100.0, 0.0) if m >= 150 else (50.0, 50.0) for m in range(390)}
    assert rules.session_trade(synthetic_session(DAY, late, RISING), Params()) is None
    trade = rules.session_trade(synthetic_session(DAY, late, RISING), Params(entry_last=rules.ENTRY_LAST_LATE))
    assert trade is not None and trade.entry_bar - 1 >= 150
    early = rules.session_trade(synthetic_session(DAY, BUY, RISING), Params())
    assert early is not None and early.entry_bar - 1 == rules.ENTRY_FIRST


def test_one_trade_per_session():
    drift = {m: (100.0, 0.0) if m < 60 or m >= 100 else (0.0, 100.0) for m in range(390)}
    session = synthetic_session(DAY, drift, RISING)
    trade = rules.session_trade(session, Params())
    assert trade is not None and trade.exit_reason == "state"
    assert rules.trades([session], Params()) == [trade]


def test_exit_when_the_state_is_lost():
    drift = {m: (100.0, 0.0) if m < 60 else (50.0, 50.0) for m in range(390)}
    trade = rules.session_trade(synthetic_session(DAY, drift, RISING), Params())
    states = rules.group_states(synthetic_session(DAY, drift, RISING), rules.RULES)
    k = next(m for m in range(16, BARS) if states[m] != "buyers")
    assert trade is not None and (trade.exit_reason, trade.exit_bar) == ("state", k + 1)
    assert trade.exit_price == RISING[k + 1]


def test_exit_at_the_hard_stop_before_the_state():
    drift = {m: (100.0, 0.0) if m < 60 else (50.0, 50.0) for m in range(390)}
    price = list(RISING)
    for b in range(40, BARS):
        price[b] = RISING[16] * (1 - 0.005)
    session = Session(DAY, tuple(price), tuple(RISING), _drift(drift), _drift(drift))
    trade = rules.session_trade(session, Params())
    assert trade is not None and (trade.exit_reason, trade.exit_bar) == ("stop", 41)


def test_exit_at_1555():
    trade = rules.session_trade(synthetic_session(DAY, BUY, RISING), Params())
    assert trade is not None and trade.exit_bar == 385 and trade.exit_price == RISING[385]


def test_mixed_or_no_data_group_state_blocks_entry():
    assert rules.session_trade(synthetic_session(DAY, BUY, RISING, check=SELL), Params()) is None
    assert rules.session_trade(synthetic_session(DAY, {}, RISING, check=BUY), Params()) is None
    # A check ticker without data keeps the primary state.
    assert rules.session_trade(synthetic_session(DAY, BUY, RISING, check={}), Params()) is not None


def test_window_variant_changes_only_the_window():
    session = synthetic_session(DAY, BUY, RISING)
    trade15 = rules.session_trade(session, Params(window_minutes=15))
    trade60 = rules.session_trade(session, Params(window_minutes=60))
    assert trade15 is not None and trade60 is not None
    assert Params(window_minutes=15) == Params(15, rules.ENTRY_LAST, True)
    drift = {m: (100.0, 0.0) if m < 60 else (0.0, 0.0) for m in range(390)}
    a = rules.session_trade(synthetic_session(DAY, drift, RISING), Params(window_minutes=15))
    b = rules.session_trade(synthetic_session(DAY, drift, RISING), Params(window_minutes=60))
    assert a is not None and b is not None and a.exit_bar < b.exit_bar


def test_fomc_days_are_skipped_unless_included():
    day = "2025-06-18"
    session = synthetic_session(day, BUY, RISING)
    assert rules.trades([session], Params()) == []
    assert len(rules.trades([session], Params(skip_fomc=False))) == 1


def test_fomc_list_has_16_days_and_rejects_other_years():
    assert len(fomc.FOMC_DECISION_DAYS) == 16
    assert fomc.is_fomc_day("2026-10-28") and not fomc.is_fomc_day("2026-10-27")
    with pytest.raises(ValueError):
        fomc.is_fomc_day("2024-12-18")


def test_signal_arrays_mark_entry_exit_and_close_for_one_side():
    session = synthetic_session(DAY, BUY, RISING)
    trade = rules.Trade(DAY, 1, 16, 41, 1.0, 1.0, "state", 0.0)
    signals, exits, close_at = rules.signal_arrays(session, trade, 1)
    assert len(signals) == BARS and signals[15] == 1 and sum(signals) == 1
    assert exits[40] == 1 and sum(exits) == 1
    assert close_at[TIME_EXIT] == 1 and sum(close_at) == 1
    other = rules.signal_arrays(session, trade, -1)
    assert sum(other[0]) == 0 and sum(other[1]) == 0
    timed = rules.signal_arrays(session, rules.Trade(DAY, 1, 16, TIME_EXIT, 1.0, 1.0, "time", 0.0), 1)
    assert sum(timed[1]) == 0
    assert sum(rules.signal_arrays(session, None, 1)[0]) == 0
