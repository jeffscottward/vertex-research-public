"""Rule tests for the sector momentum rotation (151 Trading Strategies 4.1, 4.1.1, 4.1.2)."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from strategies import sector_rotation as sr

UNIVERSE = ("A", "B", "C")


def sessions(n: int, start: date = date(2020, 1, 1)) -> list[date]:
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day)
        day += timedelta(days=1)
    return out


def fixture(n: int = 300) -> tuple[dict, list[date]]:
    days = sessions(n)
    a = [100 * 1.002 ** i for i in range(n)]
    b = [100 * 1.001 ** i if i < n - 45 else 100 * 1.001 ** (n - 45) * 0.99 ** (i - n + 45) for i in range(n)]
    c = [100 * 0.9995 ** i for i in range(n)]
    spy = [100 + 0.05 * i if i < n - 30 else 100 + 0.05 * (n - 30) - 0.5 * (i - n + 30) for i in range(n)]
    tlt = [100 * 1.0005 ** i for i in range(n)]
    prices = {s: dict(zip(days, xs)) for s, xs in zip(("A", "B", "C", "SPY", "TLT"), (a, b, c, spy, tlt))}
    return prices, days


def last_month_end(days: list[date]) -> int:
    return sr.month_ends(days)[-1]


def test_month_ends_skip_an_incomplete_final_month():
    days = sessions(45)  # Jan 1 .. Mar 4 2020
    assert [days[i] for i in sr.month_ends(days)] == [date(2020, 1, 31), date(2020, 2, 28)]


def test_formation_needs_full_history_and_ranks_by_return():
    prices, days = fixture()
    i = last_month_end(days)
    ranks = sr.formation_returns(prices, days, i, UNIVERSE)
    assert sorted(ranks, key=lambda s: -ranks[s]) == ["A", "B", "C"]
    assert ranks["C"] == pytest.approx(0.9995 ** sr.FORMATION - 1)
    assert sr.formation_returns(prices, days, 100, UNIVERSE) == {}


def test_target_weights_for_each_variant():
    prices, days = fixture()
    i = last_month_end(days)
    assert sr.target_weights("base", prices, days, i, UNIVERSE).weights == {"A": 0.5, "B": 0.5}
    # B is falling below its 200-session average: the MA filter leaves its half in cash.
    assert sr.target_weights("ma-filter", prices, days, i, UNIVERSE).weights == {"A": 0.5}
    # SPY is below its 200-session average: dual momentum holds TLT.
    assert sr.target_weights("dual-momentum", prices, days, i, UNIVERSE).weights == {"TLT": 1.0}
    eq = sr.target_weights("equal-weight", prices, days, i, UNIVERSE).weights
    assert eq == pytest.approx({"A": 1 / 3, "B": 1 / 3, "C": 1 / 3})
    assert sr.target_weights("base", prices, days, 100, UNIVERSE) is None
    with pytest.raises(ValueError):
        sr.target_weights("short", prices, days, i, UNIVERSE)


def test_dual_momentum_needs_spy_average_and_holds_top_when_risk_on():
    prices, days = fixture()
    i = last_month_end(days)
    no_spy = {k: v for k, v in prices.items() if k != "SPY"}
    assert sr.target_weights("dual-momentum", no_spy, days, i, UNIVERSE) is None
    rising = dict(prices, SPY={d: 100 + 0.1 * k for k, d in enumerate(days)})
    assert sr.target_weights("dual-momentum", rising, days, i, UNIVERSE).weights == {"A": 0.5, "B": 0.5}


def test_simulate_charges_costs_and_compounds_weighted_returns():
    days = sessions(300)
    prices = {"A": {d: 100 * 1.002 ** k for k, d in enumerate(days)},
              "B": {d: 100 * 1.001 ** k for k, d in enumerate(days)},
              "C": {d: 100.0 for d in days}}
    out = sr.simulate("base", prices, days, UNIVERSE)
    first = out["rebalances"][0]
    assert first.weights == {"A": 0.5, "B": 0.5}
    start_value = out["equity"][0][1]
    assert start_value == pytest.approx(1 - sr.COST_PER_SIDE * 1.0)  # bought 100% of the book
    # Next session: half in A (+0.2%), half in B (+0.1%).
    assert out["equity"][1][1] == pytest.approx(start_value * (1 + 0.5 * 0.002 + 0.5 * 0.001))
    assert out["turnover"] >= 1.0


def test_stats_and_verdict():
    eq = [(date(2020, 1, 1) + timedelta(days=k), 1.0 + 0.001 * k + (0.002 if k % 2 else 0.0)) for k in range(400)]
    s = sr.stats(eq)
    assert s["cagr"] > 0 and s["max_drawdown"] < 0 and s["sharpe"] > 0
    assert sr.stats(eq[:1]) == {"sessions": 1}
    first, second = sr.halves(eq)
    assert first[-1] == second[0]
    good = {"first_half": {"cagr": 0.1, "sharpe": 1.0}, "second_half": {"cagr": 0.1, "sharpe": 1.0},
            "benchmark": {"first_half": {"cagr": 0.05, "sharpe": 0.5}, "second_half": {"cagr": 0.05, "sharpe": 0.5}}}
    assert sr.verdict(good) == "pass"
    good["second_half"]["sharpe"] = 0.4
    assert sr.verdict(good) == "fail"
