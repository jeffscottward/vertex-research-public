"""Tests for the research-only noise-band intraday momentum kernel (SSRN 4824172)."""
from datetime import date, timedelta
import math

import pytest

from strategies.noise_band import (
    Bar,
    Params,
    Session,
    daily_vol,
    halves,
    is_check_minute,
    max_drawdown,
    metrics,
    metrics_from_returns,
    noise_sigmas,
    run_backtest,
    session_vwap,
    verdict,
)

NO_COST = dict(commission_per_share=0.0, slippage_bps=0.0)


def flat_session(day: date, price: float = 100.0, n: int = 390, move: float = 0.0) -> Session:
    """n bars; close of bar k is price * (1 + move * (k + 1) / n), open of bar k equals the prior close."""
    bars = []
    prev = price
    for k in range(n):
        c = price * (1.0 + move * (k + 1) / n)
        bars.append(Bar(k, prev, max(prev, c), min(prev, c), c, 1000.0))
        prev = c
    return Session(day, tuple(bars))


def days(n: int) -> list[date]:
    start = date(2020, 1, 1)
    return [start + timedelta(days=i) for i in range(n)]


def warmup(n: int = 16, move: float = 0.01) -> list[Session]:
    """Alternating up/down trend days so every minute has sigma > 0 and daily returns vary."""
    out = []
    for i, d in enumerate(days(n)):
        out.append(flat_session(d, 100.0, move=move if i % 2 == 0 else -move))
    return out


def test_check_minutes_are_bars_ending_on_hh00_and_hh30():
    checks = [m for m in range(390) if is_check_minute(m, 30)]
    assert checks[0] == 29  # bar 09:59-10:00
    assert checks[-1] == 389  # bar ending 16:00 (the kernel never acts on the last bar)
    assert len(checks) == 13


def test_sigma_uses_only_previous_sessions():
    ss = [flat_session(d, move=0.01 * (i + 1)) for i, d in enumerate(days(16))]
    sig = noise_sigmas(ss, 14)
    assert 29 not in sig[0]
    assert 29 not in sig[12]  # only 12 observations
    # session 14 averages sessions 0..13 at minute 29: |close/open - 1| = 0.01*(i+1)*30/390
    expected = sum(0.01 * (i + 1) * 30 / 390 for i in range(14)) / 14
    assert sig[14][29] == pytest.approx(expected)
    # session 15 excludes session 0 and includes session 14
    expected15 = sum(0.01 * (i + 1) * 30 / 390 for i in range(1, 15)) / 14
    assert sig[15][29] == pytest.approx(expected15)


def test_vwap_is_cumulative_typical_price():
    bars = (Bar(0, 10, 12, 8, 10, 100), Bar(1, 10, 22, 20, 21, 300))
    v = session_vwap(bars)
    assert v[0] == pytest.approx(10.0)
    assert v[1] == pytest.approx((10 * 100 + 21 * 300) / 400)


def test_daily_vol_has_no_lookahead():
    closes = [100, 101, 99, 102, 1000.0]
    assert daily_vol(closes, 3, 3) is None
    v = daily_vol(closes, 4, 3)
    rets = [101 / 100 - 1, 99 / 101 - 1, 102 / 99 - 1]
    m = sum(rets) / 3
    assert v == pytest.approx(math.sqrt(sum((r - m) ** 2 for r in rets) / 2))


def test_long_entry_at_check_fills_next_open_and_exits_at_close():
    ss = warmup()
    ss.append(flat_session(date(2020, 3, 1), 100.0, move=0.05))  # strong trend up all day
    res = run_backtest(ss, Params(sizing="full", **NO_COST))
    t = [t for t in res.trades if t.day == date(2020, 3, 1)]
    assert len(t) == 1
    assert t[0].side == 1
    assert t[0].entry_minute % 30 == 0  # filled at the open of the bar after a check
    assert t[0].exit_reason == "close"
    assert t[0].exit_price == pytest.approx(105.0)
    assert t[0].gross > 0


def test_vwap_stop_exits_on_reversal_at_check_only():
    ss = warmup()
    # up 3% by bar 199, then down to -3% at the close
    bars = []
    prev = 100.0
    for k in range(390):
        c = 100 * (1 + 0.03 * (k + 1) / 200) if k < 200 else 100 * (1.03 - 0.06 * (k - 199) / 190)
        bars.append(Bar(k, prev, max(prev, c), min(prev, c), c, 1000.0))
        prev = c
    ss.append(Session(date(2020, 3, 1), tuple(bars)))
    res = run_backtest(ss, Params(sizing="full", **NO_COST))
    t = [t for t in res.trades if t.day == date(2020, 3, 1)]
    assert t[0].side == 1 and t[0].exit_reason == "stop"
    assert t[0].exit_minute % 30 == 0
    assert t[-1].side == -1  # later short below the lower band and VWAP
    assert all(x.entry_minute % 30 == 0 for x in t)


def test_opposite_band_holds_through_vwap_and_reverses():
    ss = warmup()
    bars = []
    prev = 100.0
    for k in range(390):
        c = 100 * (1 + 0.03 * (k + 1) / 200) if k < 200 else 100 * (1.03 - 0.06 * (k - 199) / 190)
        bars.append(Bar(k, prev, max(prev, c), min(prev, c), c, 1000.0))
        prev = c
    ss.append(Session(date(2020, 3, 1), tuple(bars)))
    res = run_backtest(ss, Params(sizing="full", stop="opposite_band", **NO_COST))
    t = [t for t in res.trades if t.day == date(2020, 3, 1)]
    assert [x.side for x in t] == [1, -1]
    assert t[0].exit_reason == "reverse"


def test_no_trade_inside_noise_area():
    ss = warmup()
    ss.append(flat_session(date(2020, 3, 1), 100.0, move=0.0))
    res = run_backtest(ss, Params(sizing="full", **NO_COST))
    assert not [t for t in res.trades if t.day == date(2020, 3, 1)]
    assert res.days[-1].ret == 0.0


def test_gap_widens_band_with_previous_close_minus_dividend():
    # Gap up from 99 to 104, then a 2% drift down. The lower band uses min(open, prev close) = 99,
    # so the drop never leaves the Noise Area. Control: previous close 104 (no gap) -> short.
    today = flat_session(date(2020, 3, 1), 104.0, move=-0.02)
    gap = warmup() + [flat_session(date(2020, 2, 1), 99.0)] + [today]
    control = warmup() + [flat_session(date(2020, 2, 1), 104.0)] + [today]
    p = Params(sizing="full", **NO_COST)
    assert not [t for t in run_backtest(gap, p).trades if t.day == today.day]
    assert [t.side for t in run_backtest(control, p).trades if t.day == today.day][:1] == [-1]
    # a dividend lowers the reference close: the lower band uses min(open, prev_close - div)
    ss2 = warmup()
    down = flat_session(date(2020, 3, 1), 99.0, move=-0.02)
    with_div = Session(down.day, down.bars, dividend=5.0)
    r1 = run_backtest(ss2 + [down], Params(sizing="full", **NO_COST))
    r2 = run_backtest(ss2 + [with_div], Params(sizing="full", **NO_COST))
    n1 = len([t for t in r1.trades if t.day == down.day])
    n2 = len([t for t in r2.trades if t.day == down.day])
    assert n1 >= 1 and n2 == 0


def test_costs_commission_and_bps_slippage_per_side():
    ss = warmup()
    ss.append(flat_session(date(2020, 3, 1), 100.0, move=0.05))
    p = Params(sizing="full", commission_per_share=0.0035, slippage_bps=1.0)
    t = [t for t in run_backtest(ss, p).trades if t.day == date(2020, 3, 1)][0]
    assert t.cost == pytest.approx(2 * t.shares * 0.0035)
    assert t.exit_price == pytest.approx(105.0 * (1 - 1e-4))


def test_vol_target_sizing_caps_leverage_at_four():
    ss = warmup(move=0.0001)  # tiny daily moves -> 0.02/vol is large -> cap
    ss.append(flat_session(date(2020, 3, 1), 100.0, move=0.05))
    res = run_backtest(ss, Params(**NO_COST))
    assert res.days[-1].leverage == 4.0
    t = res.trades[-1]
    assert t.shares == round(100_000 * 4.0 / 100.0)


def test_compounding_aum_and_metrics():
    ss = warmup()
    ss += [flat_session(date(2020, 3, i + 1), 100.0, move=0.05) for i in range(4)]
    res = run_backtest(ss, Params(sizing="full", **NO_COST))
    for a, b in zip(res.days, res.days[1:]):
        assert b.aum_start == pytest.approx(a.aum_end)
    m = metrics(res)
    assert m.days == len(res.days)
    assert m.trades == len(res.trades)


def test_metrics_math():
    m = metrics_from_returns([0.01, -0.01, 0.02, 0.0])
    assert m.total_return == pytest.approx(1.01 * 0.99 * 1.02 - 1)
    assert max_drawdown([1.0, 1.2, 0.9, 1.3]) == pytest.approx(0.25)
    assert m.daily_hit == pytest.approx(2 / 3)


def test_verdict_needs_trades_and_both_halves():
    ss = warmup()
    ss += [flat_session(date(2020, 3, 1) + timedelta(days=i), 100.0, move=0.05) for i in range(10)]
    res = run_backtest(ss, Params(sizing="full", **NO_COST))
    assert verdict(res) == "inconclusive"  # fewer than 300 trades
    first, second = halves(res)
    assert len(first) + len(second) == len(res.days)
    assert verdict(res, min_trades=1, min_sharpe=-1e9) == "pass"
