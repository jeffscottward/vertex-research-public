"""Trend Trio: NautilusTrader books the rule module's trades with the same bars and fill prices.

The rule module's entry and exit arrays (rules.signal_arrays, market on close at each session's last bar) go
through nautilus_backtest.engine.run_signal_backtest, long and short as separate runs (study.engine_trades and
study.nautilus_check). On a three-session synthetic 1-minute series every trade must have the same entry bar,
exit bar, entry price and exit price. Needs nautilus-trader 1.227.0 (the rig venv); skipped without it unless
VERTEX_REQUIRE_NAUTILUS=1. Synthetic data only.
"""
from __future__ import annotations

import os

import pytest

from nautilus_backtest import engine
from strategies.trend_trio import rules, study

from .test_trend_trio_study import SHORT, synthetic_minutes


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        engine.require()
        return True
    try:
        engine.require()
    except engine.NautilusUnavailable:
        return False
    return True


pytestmark = [pytest.mark.skipif(not _installed(), reason="nautilus-trader 1.227.0 not installed"),
              pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")]


@pytest.mark.parametrize("params", [rules.Params(), SHORT, rules.Params(signal_minutes=15, st_length=5,
                                                                          sling_fast=8, sling_slow=13)],
                         ids=["P1", "short-lengths", "15-minute"])
def test_engine_entry_exit_bars_and_fills_equal_the_rule_module(params):
    m = synthetic_minutes()
    trades = rules.trades(m, params)
    assert trades, "the synthetic series must trade"
    booked = []
    for side in (1, -1):
        booked += study.engine_trades(m, trades, side, 0, len(m.t))
    booked.sort(key=lambda fill: fill[0])
    assert [(fill[0], fill[1]) for fill in booked] == [(t.entry_bar, t.exit_bar) for t in trades]
    for fill, trade in zip(booked, trades, strict=True):
        assert fill[2] == pytest.approx(trade.entry_price, abs=1e-6)
        assert fill[3] == pytest.approx(trade.exit_price, abs=1e-6)
        assert (fill[4] == "sessionClose") == (trade.exit_reason == "close")


def test_nautilus_check_reports_same_fills_per_year():
    m = synthetic_minutes()
    records = study.trades_payload(m, SHORT)["trades"]
    sides = {record["side"] for record in records}
    assert sides == {1, -1}
    result = study.nautilus_check(m, records)
    assert result["status"] == "ran" and result["engine"] == engine.ENGINE_ID
    assert result["same"] and result["booked"] == result["trades"] == len(records)
    assert result["mismatches"] == []
