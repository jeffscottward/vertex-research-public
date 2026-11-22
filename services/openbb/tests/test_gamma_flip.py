"""Gamma flip = spot sweep of re-priced total dealer GEX (design doc gamma-flip-sources)."""

from __future__ import annotations

from datetime import date

import pytest

from vertex_openbb import options_math as om

AS_OF = date(2026, 11, 19)
EXP = date(2026, 12, 19)


def contract(strike: float, is_call: bool, oi: int, iv: float | None = 0.2, exp: date = EXP) -> om.Contract:
    return om.Contract(exp, strike, is_call, iv, None, 0.01, oi, 0)


# Put-heavy book: total net GEX at spot is negative; call gamma takes over above spot.
BOOK = [contract(95, False, 2000), contract(105, True, 1000)]


def total_gex(contracts: list[om.Contract], spot: float) -> float:
    total = 0.0
    for c in contracts:
        _, gamma = om.bsm_delta_gamma(spot, c.strike, (c.expiration - AS_OF).days / 365, c.iv or 0, om.RISK_FREE_RATE, 0, c.is_call)
        value = (gamma or 0) * c.open_interest * 100 * spot * spot * 0.01
        total += value if c.is_call else -value
    return total


def test_negative_total_gex_gives_a_flip_inside_15_percent() -> None:
    assert total_gex(BOOK, 100.0) < 0
    flip = om.gamma_flip(BOOK, AS_OF, 100.0)
    assert flip is not None and 100.0 < flip < 115.0
    # The flip is a zero of the re-priced profile (linear interpolation over a 0.25% step).
    assert abs(total_gex(BOOK, flip)) < abs(total_gex(BOOK, 100.0)) * 0.05


def test_deep_stray_call_does_not_move_the_flip() -> None:
    stray = [*BOOK, contract(50, True, 50), contract(200, False, 50)]
    assert om.gamma_flip(stray, AS_OF, 100.0) == pytest.approx(om.gamma_flip(BOOK, AS_OF, 100.0), abs=1e-6)


def test_summarize_fills_flip_when_net_gex_is_negative() -> None:
    daily, _ = om.summarize("QQQ", AS_OF, 100.0, BOOK)
    assert daily["netGex"] < 0
    assert daily["gammaFlip"] == pytest.approx(om.gamma_flip(BOOK, AS_OF, 100.0), abs=1e-4)


def test_nearest_crossing_to_spot_wins() -> None:
    # Calls below, puts in the middle, calls above: two crossings; spot sits nearer the upper one.
    book = [contract(88, True, 3000), contract(100, False, 3000), contract(112, True, 3000)]
    upper = om.gamma_flip(book, AS_OF, 104.0)
    lower = om.gamma_flip(book, AS_OF, 96.0)
    assert upper is not None and lower is not None
    assert lower < 100.0 < upper


def test_no_flip_without_sign_change_iv_or_spot() -> None:
    assert om.gamma_flip([contract(100, True, 100)], AS_OF, 100.0) is None
    assert om.gamma_flip([contract(100, True, 100, iv=None), contract(100, False, 100, iv=0.0)], AS_OF, 100.0) is None
    assert om.gamma_flip([contract(100, True, 0)], AS_OF, 100.0) is None
    assert om.gamma_flip([contract(100, True, 100, exp=AS_OF)], AS_OF, 100.0) is None
    assert om.gamma_flip(BOOK, AS_OF, 0.0) is None
    assert om.gamma_flip(BOOK, AS_OF, float("nan")) is None
