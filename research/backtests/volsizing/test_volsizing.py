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


def test_black_scholes_put_call_parity_and_delta_strikes():
    s, k, t, sig = 100.0, 105.0, 0.5, 0.2
    call = vs.bs_call(s, k, t, sig)
    put_from_parity = call - s + k * math.exp(-vs.RISK_FREE * t)
    assert put_from_parity > 0
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
