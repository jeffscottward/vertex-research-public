"""Tests for the Chuk (2026, SSRN 7609644) NQ build of the noise-band kernel: 1 MNQ, resting stop.

Spec: docs/specs/strategies/session-open-momentum-nq.md. Warm-up sessions give sigma = 0.001 at every
minute but the last, so with open = previous close = 100 the bands are UB 100.1 and LB 99.9.
"""
from datetime import date, timedelta

import pytest

from strategies.noise_band import (
    Bar,
    FuturesParams,
    Session,
    _levels,
    noise_sigmas,
    run_futures_backtest,
    session_vwap,
)

N = 78  # 5-minute bars, 09:30-16:00
K = 40.0  # index points per unit of bar price
TICK = 0.25 / K


def warm(day: date) -> Session:
    bars = []
    for j in range(N):
        c = 100.0 if j == N - 1 else (100.1 if j % 2 else 99.9)
        bars.append(Bar(5 * j, 100.0, max(100.0, c), min(100.0, c), c, 1.0))
    return Session(day, tuple(bars))


def make_day(closes: dict[int, float], *, lows: dict[int, float] | None = None,
             highs: dict[int, float] | None = None, opens: dict[int, float] | None = None,
             volumes: dict[int, float] | None = None, default: float = 100.0) -> Session:
    """Bar j: close from `closes` (carried forward), open = previous close unless set."""
    lows, highs, opens, volumes = lows or {}, highs or {}, opens or {}, volumes or {}
    bars = []
    prev = 100.0
    c = default
    for j in range(N):
        c = closes.get(j, c)
        o = opens.get(j, prev)
        bars.append(Bar(5 * j, o, highs.get(j, max(o, c)), lows.get(j, min(o, c)), c, volumes.get(j, 1.0)))
        prev = c
    return Session(date(2020, 2, 1), tuple(bars))


def run(session: Session, **kw) -> tuple:
    start = date(2020, 1, 1)
    sessions = [warm(start + timedelta(days=i)) for i in range(14)] + [session]
    res = run_futures_backtest(sessions, [K] * len(sessions), FuturesParams(**kw))
    return res, sessions


def stop_level(sessions: list[Session], j: int, side: int = 1) -> float:
    """The stop set at the close of bar j of the test session (max(UB, VWAP) for a long)."""
    s = sessions[-1]
    sigma = noise_sigmas(sessions, 14)[-1][s.bars[j].minute]
    ub, lb = _levels(sigma, 1.0, 100.0, 100.0)
    vwap = session_vwap(s.bars)[j]
    return max(ub, vwap) if side == 1 else min(lb, vwap)


def test_warm_up_bands() -> None:
    sessions = [warm(date(2020, 1, 1) + timedelta(days=i)) for i in range(15)]
    sigma = noise_sigmas(sessions, 14)[14]
    assert sigma[25] == pytest.approx(0.001)
    assert _levels(sigma[25], 1.0, 100.0, 100.0) == pytest.approx((100.1, 99.9))
    res = run_futures_backtest(sessions, [K] * 15)
    assert [d.day for d in res.days] == [sessions[14].day]  # 14 warm-up sessions
    assert res.trades == []


def test_long_entry_on_decision_bar_held_to_close() -> None:
    # Bar 5 ends 10:00 (a decision bar): close 100.5 > UB 100.1 and > VWAP. Fill at bar 6's open + 1 tick.
    res, _ = run(make_day({5: 100.5, 10: 100.8, 77: 101.0}))
    [t] = res.trades
    assert (t.side, t.entry_minute, t.exit_minute, t.exit_reason) == (1, 30, 390, "close")
    assert t.entry_price == pytest.approx(100.5 + TICK)
    assert t.exit_price == pytest.approx(101.0)
    assert t.points == pytest.approx((101.0 - 100.5 - TICK) * K)
    assert t.usd == pytest.approx(t.points * 2.0 - 2.0)
    assert res.days[0].pnl == pytest.approx(t.usd)
    assert res.days[0].trades == 1


def test_no_entry_off_the_decision_grid_or_before_10() -> None:
    # Bar 4 ends 09:55 and bar 6 ends 10:05: no decision; the move is gone by 10:00 (bar 5).
    res, _ = run(make_day({4: 100.5, 5: 100.0, 6: 100.5, 7: 100.0}))
    assert res.trades == []


def test_vwap_side_filter_blocks_the_entry() -> None:
    # Heavy volume at 101.5 in bar 1 lifts VWAP above the 10:00 close of 100.5 (> UB 100.1).
    res, _ = run(make_day({1: 101.5, 2: 100.0, 5: 100.5}, volumes={1: 1000.0}))
    assert res.trades == []


def test_resting_stop_fills_at_the_previous_bar_level_minus_two_ticks() -> None:
    session = make_day({5: 100.5, 6: 100.6, 7: 100.6, 8: 100.6}, lows={8: 99.0})
    res, sessions = run(session)
    first = res.trades[0]
    assert (first.exit_minute, first.exit_reason) == (40, "stop")
    level = stop_level(sessions, 7)
    assert first.exit_price == pytest.approx(min(100.6, level) - 2 * TICK)


def test_gap_through_the_stop_fills_at_the_open() -> None:
    session = make_day({5: 100.5, 6: 100.6, 7: 99.0}, opens={7: 99.2})
    res, _ = run(session)
    first = res.trades[0]
    assert (first.exit_minute, first.exit_reason) == (35, "stop")
    assert first.exit_price == pytest.approx(99.2 - 2 * TICK)


def test_stop_set_by_a_bar_is_live_only_from_the_next_bar() -> None:
    # Bar 8 lifts VWAP far above its own low with heavy volume at 103; its low (100.8) stays above the
    # stop set at bar 7's close, so it is not stopped. Bar 9 trades through bar 8's level.
    session = make_day({5: 100.5, 6: 100.6, 7: 100.7, 8: 103.0, 9: 102.0},
                       lows={8: 100.8, 9: 101.0}, highs={8: 103.0}, volumes={8: 1000.0})
    res, sessions = run(session)
    first = res.trades[0]
    assert stop_level(sessions, 7) < 100.8 < stop_level(sessions, 8)
    assert (first.exit_minute, first.exit_reason) == (45, "stop")
    assert first.exit_price == pytest.approx(min(103.0, stop_level(sessions, 8)) - 2 * TICK)


def test_re_entry_after_a_stop_on_a_later_decision_bar() -> None:
    # Stopped in bar 8; bar 11 ends 10:30 with close 101.0 above UB and VWAP: a second long.
    session = make_day({5: 100.5, 6: 100.6, 7: 100.6, 8: 100.0, 11: 101.0, 77: 101.2}, lows={8: 99.5})
    res, _ = run(session)
    assert [(t.side, t.entry_minute, t.exit_reason) for t in res.trades] == [(1, 30, "stop"), (1, 60, "close")]
    assert res.days[0].trades == 2


def test_short_mirror_and_stop_slippage_points() -> None:
    session = make_day({5: 99.5, 6: 99.4, 7: 99.4, 8: 99.4}, highs={8: 101.0})
    res, sessions = run(session, stop_slip_points=1.0)
    first = res.trades[0]
    assert (first.side, first.entry_minute, first.exit_minute, first.exit_reason) == (-1, 30, 40, "stop")
    assert first.entry_price == pytest.approx(99.5 - TICK)
    level = stop_level(sessions, 7, side=-1)
    assert first.exit_price == pytest.approx(max(99.4, level) + 2 * TICK + 1.0 / K)


def test_next_open_mode_exits_at_the_open_after_a_close_through_the_level() -> None:
    # The DSL form: bar 8 dips intrabar (no exit) but closes at 100.6; bar 9 closes below the level.
    session = make_day({5: 100.5, 6: 100.6, 7: 100.6, 8: 100.6, 9: 99.95, 10: 100.0}, lows={8: 99.0})
    res, _ = run(session, stop_fill="next_open")
    first = res.trades[0]
    assert (first.exit_minute, first.exit_reason) == (50, "stop")
    assert first.exit_price == pytest.approx(99.95 - 2 * TICK)


def test_entries_every_bar_when_check_every_is_the_bar() -> None:
    # Bar 6 ends 10:05: only a decision bar with check_every = 5; the move is gone by bar 7.
    session = make_day({6: 100.5, 7: 100.0})
    assert run(session)[0].trades == []
    assert run(session, check_every=5)[0].trades[0].entry_minute == 35


def test_stop_can_hit_on_the_entry_fill_bar() -> None:
    # Bar 6 fills the long at its open (100.5) and trades down through the stop set at bar 5's close.
    res, sessions = run(make_day({5: 100.5, 6: 100.4}, lows={6: 99.0}))
    first = res.trades[0]
    assert (first.entry_minute, first.exit_minute, first.exit_reason) == (30, 30, "stop")
    assert first.exit_price == pytest.approx(min(100.5, stop_level(sessions, 5)) - 2 * TICK)


def test_next_open_mode_reverses_on_a_decision_bar_below_the_lower_band() -> None:
    # Long from 10:00; at 10:30 (bar 11) the close is below LB 99.9 and below VWAP: exit and go short at bar 12.
    session = make_day({5: 100.5, 6: 100.6, 11: 99.5, 77: 99.0})
    res, _ = run(session, stop_fill="next_open")
    assert [(t.side, t.entry_minute, t.exit_minute, t.exit_reason) for t in res.trades] == [
        (1, 30, 60, "stop"), (-1, 60, 390, "close")]
    assert res.trades[0].exit_price == pytest.approx(99.5 - 2 * TICK)
    assert res.trades[1].entry_price == pytest.approx(99.5 - TICK)


def test_dividend_lowers_the_band_reference() -> None:
    # 10:00 close 99.6 is below LB 99.9 (short) unless a 0.5 dividend moves the reference to 99.5 (LB 99.4).
    start = date(2020, 1, 1)
    warmup = [warm(start + timedelta(days=i)) for i in range(14)]
    day = make_day({5: 99.6})
    plain = run_futures_backtest([*warmup, day], [K] * 15)
    paid = run_futures_backtest([*warmup, Session(day.day, day.bars, dividend=0.5)], [K] * 15)
    assert [t.side for t in plain.trades][:1] == [-1]
    assert paid.trades == []


def test_half_day_closes_at_its_last_bar() -> None:
    day = make_day({5: 100.5, 41: 100.9})
    half = Session(day.day, day.bars[:42])  # last bar 12:55, the session closes at 13:00
    res, _ = run(half)
    [t] = res.trades
    assert (t.exit_minute, t.exit_reason, t.exit_price) == (210, "close", 100.9)


def test_one_scale_per_session() -> None:
    with pytest.raises(ValueError):
        run_futures_backtest([warm(date(2020, 1, 1))], [])


# --- The DSL form (strategies/imom/definition.py CHUK_NQ) against the kernel's bands and grid ----------

def _bars(sessions: list[Session]):
    """Sessions as DSL bars: 5-minute bars from 09:30 New York (14:30 UTC in January)."""
    from datetime import datetime, timezone

    from nautilus_backtest.bars import Bars

    t: list[float] = []
    cols: dict[str, list[float]] = {"o": [], "h": [], "l": [], "c": [], "v": []}
    for s in sessions:
        base = datetime(s.day.year, s.day.month, s.day.day, 14, 30, tzinfo=timezone.utc).timestamp() * 1000
        for b in s.bars:
            t.append(base + b.minute * 60_000)
            for key, value in zip("ohlcv", (b.open, b.high, b.low, b.close, b.volume)):
                cols[key].append(value)
    return Bars.from_columns({"t": t, **cols})


def test_chuk_definition_is_a_valid_dsl_pair() -> None:
    from nautilus_backtest import signals as sig
    from strategies.imom import definition as d

    long, short = (d.definition(d.CHUK_NQ, side) for side in ("long", "short"))
    for leg in (long, short):
        normalized = sig.normalize_definition(leg)
        assert normalized["intraday"]["decisionEvery"] == 30
        assert normalized["intraday"]["exitEvery"] == 5
        assert normalized["sizing"] == {"mode": "allIn"}
    assert short["side"] == "short" and "side" not in long
    assert [c["op"] for c in long["entry"]["all"]] == [">", ">"]
    assert [c["right"].get("band") for c in short["exit"]["any"]] == ["lower", None]
    assert d.params_from_json(d.params_to_json(d.CHUK_NQ)) == d.CHUK_NQ


def test_chuk_dsl_signals_match_the_kernel_bands_vwap_and_grid() -> None:
    from nautilus_backtest import signals as sig
    from strategies.imom import definition as d

    session = make_day({5: 100.5, 6: 100.6, 7: 100.6, 8: 100.0, 11: 101.0, 20: 99.5, 23: 99.4, 40: 100.3})
    start = date(2020, 1, 1)
    sessions = [warm(start + timedelta(days=i)) for i in range(14)] + [Session(date(2020, 1, 15), session.bars)]
    compiled = sig.compile_strategy(_bars(sessions), d.definition(d.CHUK_NQ, "long"))
    first = 14 * N
    sigma = noise_sigmas(sessions, 14)[14]
    vwaps = session_vwap(session.bars)
    want_entry, want_exit = [], []
    for j, b in enumerate(session.bars[:-1]):
        ub, _ = _levels(sigma[b.minute], 1.0, 100.0, 100.0)
        end = b.minute + 5
        if 30 <= end <= 360 and end % 30 == 0 and b.close > ub and b.close > vwaps[j]:
            want_entry.append(j)
        elif b.close < max(ub, vwaps[j]):
            want_exit.append(j)
    got = list(compiled.signals[first:first + N - 1])
    assert [j for j, v in enumerate(got) if v == 1] == want_entry
    assert [j for j, v in enumerate(got) if v == -1] == want_exit
    assert want_entry and want_exit
