"""Options-side continuation study: NautilusTrader books the rule module's trades with the same bars and fills.

The rule module's entry, exit and close arrays (rules.signal_arrays, close at 15:55 in every session) go through
nautilus_backtest.engine.run_signal_backtest over the joined sessions, long and short as separate runs. Needs
nautilus-trader 1.227.0 (the rig venv); skipped without it unless VERTEX_REQUIRE_NAUTILUS=1. Synthetic data only.
"""
from __future__ import annotations

import dataclasses
import os

import pytest

from nautilus_backtest import engine
from strategies.flow_control import options, rules, study
from strategies.flow_control.rules import BARS, Params, Session

from .test_flow_control_options import market, trade
from .test_flow_control_rules import BUY, FALLING, RISING, SELL, _drift, synthetic_session


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

LOST = {m: (100.0, 0.0) if m < 60 else (50.0, 50.0) for m in range(390)}


def _stop_session(day: str) -> Session:
    drift = LOST
    price = list(RISING)
    for b in range(40, BARS):
        price[b] = RISING[16] * 0.995
    return Session(day, tuple(price), tuple(RISING), _drift(drift), _drift(drift))


def _sessions() -> list[Session]:
    return [synthetic_session("2025-06-02", BUY, RISING),       # long, time exit
            synthetic_session("2025-06-03", SELL, FALLING),     # short, time exit
            synthetic_session("2025-06-04", LOST, RISING),      # long, state exit
            _stop_session("2025-06-05"),                        # long, stop exit
            synthetic_session("2025-06-06", {m: (50.0, 50.0) for m in range(390)}, RISING)]  # no trade


def test_engine_entry_exit_bars_and_fills_equal_the_rule_module():
    sessions = _sessions()
    trades = rules.trades(sessions, Params())
    assert sorted(t.exit_reason for t in trades) == ["state", "stop", "time", "time"]
    for side in (1, -1):
        ours = [t for t in trades if t.side == side]
        theirs = study.engine_trades(sessions, ours, side)
        assert [(t.day, t.entry_bar, t.exit_bar) for t in ours] == [x[:3] for x in theirs]
        for t, x in zip(ours, theirs, strict=True):
            assert x[3] == pytest.approx(t.entry_price, abs=1e-6) and x[4] == pytest.approx(t.exit_price, abs=1e-6)


def test_nautilus_check_reports_same_and_maps_indices_back_to_days():
    sessions = _sessions()
    by_key = {"ES": sessions, "NQ": sessions[:2]}
    trades = {key: rules.trades(value, Params()) for key, value in by_key.items()}
    out = study.nautilus_check(by_key, trades)
    assert out["status"] == "ran" and out["engine"] == engine.ENGINE_ID
    assert out["same"] and out["trades"] == out["booked"] == 6 and out["mismatches"] == []
    first = trades["ES"][0]
    wrong = {"ES": [dataclasses.replace(first, entry_price=first.entry_price + 1), *trades["ES"][1:]],
             "NQ": trades["NQ"]}
    bad = study.nautilus_check({"ES": sessions, "NQ": sessions[:2]}, wrong)
    assert not bad["same"] and bad["mismatches"]


def test_option_form_ledger_and_engine_agree():
    m = market()
    spreads, _ = options.price_trades("SPY", [trade(), trade(side=-1, day="2025-06-04")], m)
    booked = options.book_form(spreads, ["2025-06-03", "2025-06-04", "2025-06-05"], nautilus=True)
    assert booked["result"] is booked["nautilus"] and booked["maxGap"] < 0.01
    assert len(options.trade_nets(booked["result"])) == 2
