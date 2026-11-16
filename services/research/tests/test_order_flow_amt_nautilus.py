"""Order flow / AMT auction study: NautilusTrader replays the rule module's trades with the same fills.

The rule module's entry flags, stop and target distances and the 15:45 market-on-close flag
(rules.signal_arrays) go through nautilus_backtest.engine.run_signal_backtest over the sessions with a trade,
long and short as separate runs; the options forms are booked by NautilusTrader too. Needs nautilus-trader
1.227.0 (the rig venv); skipped without it unless VERTEX_REQUIRE_NAUTILUS=1. Synthetic data only.
"""
from __future__ import annotations

import os

import pytest

from nautilus_backtest import engine
from strategies.order_flow_amt import rules, study

from .test_order_flow_amt_study import _market, _sessions


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        engine.require()
        return True
    try:
        engine.require()
    except engine.NautilusUnavailable:
        return False
    return True


pytestmark = pytest.mark.skipif(not _installed(), reason="nautilus-trader is not installed")


def test_engine_replays_every_trade_with_the_same_bars_and_prices():
    sessions = _sessions(40)
    trades = rules.trades("SPY", sessions)
    assert trades["A"], "the synthetic sessions must produce rule A trades"
    out = study.nautilus_check({"SPY": sessions}, {"SPY": trades})
    assert out["status"] == "ran" and out["same"] is True
    assert out["booked"] == out["trades"] == sum(len(v) for v in trades.values())


def test_engine_reports_a_changed_trade_as_a_mismatch():
    sessions = _sessions(20)
    trades = rules.trades("SPY", sessions)
    first = trades["A"][0]
    changed = type(first)(**{**first.__dict__, "exit_price": first.exit_price + 1.0})
    out = study.nautilus_check({"SPY": sessions}, {"SPY": {"A": [changed, *trades["A"][1:]], "C": trades["C"]}})
    assert out["same"] is False and out["mismatchCount"] == 1
    assert out["mismatches"][0]["study"][0] == first.day


def test_engine_trades_is_empty_without_trades():
    assert study.engine_trades(_sessions(5), [], 1) == []


def test_run_books_the_options_forms_in_nautilus():
    sessions = {"SPY": _sessions(80), "QQQ": _sessions(80)}
    markets = {s: _market(s, sessions[s]) for s in sessions}
    out = study.run(sessions, markets, {}, nautilus=True)
    assert out["nautilus"]["same"] is True
    assert out["rows"]["0DTE-A"]["nautilusMaxGap"] == pytest.approx(0.0, abs=1e-6)
