"""Unit tests for the vol-sizing research model (no data files, no Nautilus needed).

    python -m pytest research/backtests/volsizing/test_volsizing.py -q
"""
from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import volsizing as vs  # noqa: E402


def test_black_scholes_value_and_delta_strikes():
    s, k, t, sig = 100.0, 105.0, 0.5, 0.2
    call = vs.bs_call(s, k, t, sig)
    assert vs.bs_call(s, k + 5, t, sig) < call < vs.bs_call(s, k - 5, t, sig)
    assert vs.bs_call(s, k, 0.0, sig) == 0.0 and vs.bs_call(110.0, k, 0.0, sig) == 5.0
    assert math.isclose(call, 4.377, abs_tol=0.005)  # hand-computed: d1 = -0.1329, d2 = -0.2743
    k60 = vs.strike_for_delta(500.0, 0.60, 120 / 365, 0.18)
    k30 = vs.strike_for_delta(500.0, 0.30, 120 / 365, 0.18)
    assert k60 < 500 < k30
    assert abs(vs.call_delta(500.0, k60, 120 / 365, 0.18) - 0.60) < 0.01


def test_spread_shape_matches_proposal_model():
    sp = vs.open_spread(500.0, date(2024, 1, 2), 0.18)
    assert sp.expiry == date(2024, 5, 1)
    assert 0 < sp.debit < sp.k2 - sp.k1
    assert 0.25 < sp.delta < 0.35


def test_fixed_risk_and_vol_target_never_exceed_the_gate():
    nlv = 1_000_000.0
    for loss_pc in (150.0, 900.0, 2_500.0, 20_001.0, 25_000.0):
        cap = vs.gate_cap(nlv, loss_pc)
        assert cap * loss_pc <= vs.MAX_LOSS_GATE * nlv
        assert vs.size_fixed_risk(nlv, loss_pc) * loss_pc <= vs.CURRENT_RISK * nlv
        huge = vs.size_vol_target(nlv, loss_pc, tau=5.0, weight=1.0, idm=2.5, forecast=20,
                                  sigma=0.05, s=50.0, delta=0.3)
        assert huge == cap


def test_vol_target_scales_inversely_with_vol():
    kw = dict(tau=0.16, weight=1 / 7, idm=1.5, forecast=10, s=500.0, delta=0.3)
    low = vs.vol_target_contracts(1e6, sigma=0.10, **kw)
    high = vs.vol_target_contracts(1e6, sigma=0.40, **kw)
    assert math.isclose(low / high, 4.0)
    assert vs.vol_target_contracts(1e6, sigma=0.2, **{**kw, "forecast": 0}) == 0


def test_vol_brake_only_shrinks():
    nlv, loss_pc = 1_000_000.0, 1_000.0
    base = vs.size_fixed_risk(nlv, loss_pc)
    assert vs.size_vol_brake(nlv, loss_pc, fast=0.10, slow=0.20) == base
    assert vs.size_vol_brake(nlv, loss_pc, fast=0.40, slow=0.20) == base // 2
    assert vs.size_vol_brake(nlv, loss_pc, fast=math.nan, slow=0.2) == base


def test_buffer_trades_to_the_edge_only_outside_the_band():
    assert vs.buffered(10, 10.5) == 10
    assert vs.buffered(10, 20) == 18
    assert vs.buffered(30, 20) == 22
    assert vs.buffered(0, 0.3) == 0


def test_idm_bounds():
    w = [1 / 7] * 7
    ones = [[1.0] * 7 for _ in range(7)]
    eye = [[1.0 if i == j else 0.0 for j in range(7)] for i in range(7)]
    neg = [[1.0 if i == j else -0.5 for j in range(7)] for i in range(7)]
    assert math.isclose(vs.idm_from_corr(ones, w), 1.0)
    assert vs.idm_from_corr(eye, w) == vs.IDM_CAP  # sqrt(7) = 2.65 is capped at 2.5
    assert vs.idm_from_corr(neg, w) == vs.IDM_CAP  # negative correlations floor at zero


def test_ewma_and_carver_vol_on_constant_returns():
    rets = [math.nan] + [0.01, -0.01] * 200
    fast = vs.ewma_vol(rets, 35)
    assert math.isnan(fast[5])
    assert math.isclose(fast[-1], 0.01 * math.sqrt(252), rel_tol=1e-6)
    blend = vs.carver_vol(rets)
    assert math.isclose(blend[-1], fast[-1], rel_tol=1e-3)


def _market(days: int = 260, vol_after=None, entries=None) -> vs.Market:
    """Synthetic 7-symbol market: SPY drifts up 0.05%/day, the others are flat at 50."""
    from datetime import timedelta

    calendar, d = [], date(2010, 1, 4)
    while len(calendar) < days:
        if d.weekday() < 5:
            calendar.append(d)
        d += timedelta(days=1)
    close = {s: [50.0] * days for s in vs.UNIVERSE}
    close["SPY"] = [400.0 * 1.0005 ** i for i in range(days)]
    flat = {s: [0.2] * days for s in vs.UNIVERSE}
    vol = {s: list(v) for s, v in flat.items()}
    if vol_after is not None:
        at, value = vol_after
        vol["SPY"] = [0.2 if i < at else value for i in range(days)]
    ent = {s: {} for s in vs.UNIVERSE}
    for day_index, exit_index in (entries or [(5, 200)]):
        ent["SPY"][calendar[day_index]] = (close["SPY"][day_index], calendar[exit_index],
                                           close["SPY"][exit_index])
    return vs.Market(tuple(calendar), close, flat, flat, flat, vol, flat, flat, ent, 1.4)


def test_simulate_entry_roll_exit_and_cash():
    m = _market()
    curve, st = vs.simulate(m, "current")
    assert len(curve) == len(m.calendar)
    assert st.entries == 1 and st.skipped == 0
    assert st.rolls == 2  # 195 sessions = ~273 calendar days: rolls at ~90 and ~180 days
    assert len(st.implied_tau) == 1  # recorded on the signal entry only, not on the roll
    assert curve[-1] > vs.CAPITAL  # SPY rose ~10% while long the call spread
    assert st.risk_pct[0] <= vs.CURRENT_RISK + 1e-9
    flat_after = curve[201:]
    assert max(flat_after) - min(flat_after) < 1e-6  # no position after the exit: cash only


def test_simulate_gate_holds_at_entry_roll_and_adds():
    m = _market()
    for variant in ("vt", "vt-buffer"):
        _, st = vs.simulate(m, variant, tau=50.0)  # absurd target: the gate must bind
        assert st.gate_bound == 1 and st.roll_gate_bound == 2
        assert all(r <= vs.MAX_LOSS_GATE + 1e-9 for r in st.risk_pct)


def test_zero_size_resize_frees_the_symbol():
    m = _market(vol_after=(10, 500.0), entries=[(5, 40), (60, 200)])
    _, st = vs.simulate(m, "vt-buffer", tau=0.16)
    assert st.resizes >= 1  # the vol spike cut the target to zero and closed the spread
    assert st.entries == 2  # the second signal was not blocked by an empty position
