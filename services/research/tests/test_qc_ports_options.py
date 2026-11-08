"""qc-ports option model: Black-Scholes against published values, IV and cost model by hand."""
import math

import pytest

from strategies.qc_ports import options as om


@pytest.mark.parametrize(("right", "spot", "strike", "t", "r", "q", "sigma", "expected"), [
    # Hull (Options, Futures and Other Derivatives) BSM worked example: c = 4.76, p = 0.81.
    ("call", 42, 40, 0.5, 0.10, 0.0, 0.2, 4.7594),
    ("put", 42, 40, 0.5, 0.10, 0.0, 0.2, 0.8086),
    # Textbook ATM case: S = K = 100, r = 5%, sigma = 20%, T = 1.
    ("call", 100, 100, 1.0, 0.05, 0.0, 0.2, 10.4506),
    ("put", 100, 100, 1.0, 0.05, 0.0, 0.2, 5.5735),
    # Hull index option worked example: S = 930, K = 900, r = 8%, q = 3%, sigma = 20%, T = 2 months: c = 51.83.
    ("call", 930, 900, 2 / 12, 0.08, 0.03, 0.2, 51.8330),
])
def test_black_scholes_matches_published_values(right, spot, strike, t, r, q, sigma, expected):
    assert om.bs_price(right, spot, strike, t, r, q, sigma) == pytest.approx(expected, abs=5e-5)


def test_put_call_parity_with_dividends():
    spot, strike, t, r, q, sigma = 512.3, 520.0, 0.21, 0.043, 0.015, 0.17
    call = om.bs_price("call", spot, strike, t, r, q, sigma)
    put = om.bs_price("put", spot, strike, t, r, q, sigma)
    assert call - put == pytest.approx(spot * math.exp(-q * t) - strike * math.exp(-r * t), abs=1e-10)


def test_delta_values():
    # N(d1), d1 = (0.05 + 0.02) / 0.2 = 0.35 -> 0.63683
    assert om.bs_delta("call", 100, 100, 1.0, 0.05, 0.0, 0.2) == pytest.approx(0.636831, abs=1e-6)
    assert om.bs_delta("put", 100, 100, 1.0, 0.05, 0.0, 0.2) == pytest.approx(0.636831 - 1, abs=1e-6)
    # Dividend yield scales delta by exp(-qT).
    with_q = om.bs_delta("call", 100, 100, 1.0, 0.05, 0.02, 0.2)
    assert with_q == pytest.approx(math.exp(-0.02) * om.norm_cdf((0.05 - 0.02 + 0.02) / 0.2), abs=1e-12)


def test_expiry_values_are_intrinsic():
    assert om.bs_price("call", 105, 100, 0, 0.05, 0, 0.2) == 5
    assert om.bs_price("put", 105, 100, 0, 0.05, 0, 0.2) == 0
    assert om.bs_price("put", 95, 100, 0, 0.05, 0, 0.2) == 5


@pytest.mark.parametrize("args", [
    (math.nan, 100, 0.1, 0.05, 0, 0.2), (100, 100, math.nan, 0.05, 0, 0.2), (100, 100, -0.01, 0.05, 0, 0.2),
    (100, 100, 0.1, -0.01, 0, 0.2), (100, 100, 0.1, 0.05, -0.01, 0.2), (100, 100, 0.1, 0.05, 0, math.inf),
    (100, 100, 0.1, math.nan, 0, 0.2), (-1, 100, 0.1, 0.05, 0, 0.2), (100, 100, 0.1, 0.05, 0, 0.0),
])
def test_bad_inputs_are_refused(args):
    with pytest.raises(ValueError):
        om.bs_price("call", *args)
    with pytest.raises(ValueError):
        om.bs_delta("put", *args)
    assert om.bs_delta("call", 105, 100, 0, 0, 0, 0.2) == 1.0
    assert om.bs_delta("call", 95, 100, 0, 0, 0, 0.2) == 0.0
    assert om.bs_delta("put", 95, 100, 0, 0, 0, 0.2) == -1.0
    assert om.bs_delta("put", 105, 100, 0, 0, 0, 0.2) == 0.0


@pytest.mark.parametrize(("args", "message"), [
    (("straddle", 100, 100, 1, 0, 0, 0.2), "right"),
    (("call", 0, 100, 1, 0, 0, 0.2), "spot and strike"),
    (("call", 100, -1, 1, 0, 0, 0.2), "spot and strike"),
    (("call", 100, 100, 1, 0, 0, 0), "sigma"),
])
def test_bad_inputs_are_refused(args, message):
    with pytest.raises(ValueError, match=message):
        om.bs_price(*args)
    with pytest.raises(ValueError, match=message):
        om.bs_delta(*args)


def test_atm_iv_factors():
    assert om.atm_iv("VIX", 20) == pytest.approx(0.18)
    assert om.atm_iv("VXN", 30) == pytest.approx(0.27)
    assert om.atm_iv("GVZ", 20) == pytest.approx(0.19)
    assert om.atm_iv("VXSLV", 40) == pytest.approx(0.38)
    with pytest.raises(ValueError, match="ATM factor"):
        om.atm_iv("SPY", 20)
    with pytest.raises(ValueError, match="above 0"):
        om.atm_iv("VIX", 0)


def test_smile_iv():
    atm, t = 0.2, 0.25
    # ATM strike and zero slope keep the ATM vol.
    assert om.smile_iv(atm, 100, 100, t, -0.3) == atm
    assert om.smile_iv(atm, 100, 90, t, 0.0) == atm
    assert om.smile_iv(atm, 100, 90, 0, -0.3) == atm
    # x = ln(0.9) / (0.2 * 0.5) = -1.05361 -> 0.2 * (1 + 0.3 * 1.05361) = 0.263217
    assert om.smile_iv(atm, 100, 90, t, -0.3) == pytest.approx(0.2 * (1 + 0.3 * -math.log(0.9) / 0.1))
    # Clamped at 3 standard units and floored at half the ATM vol.
    assert om.smile_iv(atm, 100, 10, t, -0.3) == pytest.approx(0.2 * 1.9)
    assert om.smile_iv(atm, 100, 1000, t, -0.3) == pytest.approx(0.1)
    with pytest.raises(ValueError, match="ATM IV"):
        om.smile_iv(0, 100, 100, t, 0)


def test_strike_step_and_costs():
    assert om.strike_step(25) == 1.0
    assert om.strike_step(24.99) == 0.5
    # Half-spread = max(0.01, pct * mid); leg cost = 0.65 + 100 * half-spread.
    assert om.half_spread("SPY", 2.5) == pytest.approx(0.025)
    assert om.half_spread("SPY", 0.5) == 0.01
    assert om.half_spread("SLV", 1.0) == pytest.approx(0.04)
    assert om.leg_cost("SPY", 2.5) == pytest.approx(3.15)
    assert om.leg_cost("DIA", 0.2) == pytest.approx(1.65)
    with pytest.raises(ValueError, match="spread model"):
        om.half_spread("TLT", 1.0)
