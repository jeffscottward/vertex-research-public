"""Order flow / AMT auction study: the 0DTE and weekly debit vertical forms on the house option model (synthetic)."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from strategies.imom.data import is_closed, ms_at
from strategies.order_flow_amt import options
from strategies.order_flow_amt.rules import Trade
from strategies.qc_ports.data import Market

DAY = "2025-06-03"


def market(symbol="SPY", first="2025-05-01", last="2025-06-30", iv=18.0, rate=0.04) -> Market:
    days, d = [], date.fromisoformat(first)
    while d <= date.fromisoformat(last):
        if d.weekday() < 5 and not is_closed(d):
            days.append(d.isoformat())
        d += timedelta(days=1)
    return Market(symbol, tuple(days), tuple(500.0 for _ in days), tuple(iv for _ in days), tuple(rate for _ in days))


def trade(side=1, day=DAY, entry=500.0, exit_=502.0, target=503.0, symbol="SPY", entry_bar=10, exit_bar=40,
          reason="target") -> Trade:
    return Trade(symbol, day, "A", side, entry_bar - 1, entry_bar, exit_bar, entry, exit_, entry - side * 2.0, target,
                 2.0, abs(target - entry), reason)


def test_zero_dte_strikes_put_the_short_leg_at_the_target():
    assert options.zero_dte_strikes("call", 500.2, 503.4) == (500.0, 503.0, 3.0)
    assert options.zero_dte_strikes("put", 500.2, 497.6) == (500.0, 498.0, 2.0)


def test_zero_dte_short_leg_is_at_least_one_step_out():
    assert options.zero_dte_strikes("call", 500.0, 500.3) == (500.0, 501.0, 1.0)
    assert options.zero_dte_strikes("put", 500.0, 499.8) == (500.0, 499.0, 1.0)


def test_zero_dte_prices_a_same_day_call_vertical_and_its_exit():
    spread = options.zero_dte(trade(), market())
    assert not isinstance(spread, str)
    assert spread.expiry == DAY and spread.right == "call" and spread.short_strike == 503.0
    assert spread.event.entry_ms == ms_at(DAY, 570 + 50) and spread.exit_ms == ms_at(DAY, 570 + 205)
    assert 0 < spread.entry_price < spread.width * 100 and spread.exit_price > spread.entry_price
    assert spread.max_loss > spread.entry_price


def test_zero_dte_short_trade_is_a_put_vertical():
    spread = options.zero_dte(trade(side=-1, exit_=498.0, target=497.0), market())
    assert not isinstance(spread, str) and spread.right == "put" and spread.short_strike == 497.0


def test_zero_dte_needs_daily_expiries_and_a_fresh_iv_row():
    assert options.zero_dte(trade(day="2022-11-25"), market()) == "before daily expiries"
    assert options.zero_dte(trade(day="2025-07-15"), market()) == "stale IV"
    assert options.zero_dte(trade(day="2025-05-01"), market()) == "no previous close"
    gap = Market("SPY", ("2025-06-02",), (500.0,), (None,), (0.04,))
    assert options.zero_dte(trade(), gap) == "no IV"
    gap = Market("SPY", ("2025-06-02",), (500.0,), (18.0,), (None,))
    assert options.zero_dte(trade(), gap) == "no rate"


def test_zero_dte_time_exit_at_1545_is_priced_close_to_intrinsic():
    spread = options.zero_dte(trade(exit_bar=74, exit_=504.0, reason="time"), market())
    assert not isinstance(spread, str)
    assert spread.exit_ms == ms_at(DAY, 570 + 375)
    assert spread.exit_price == pytest.approx(300.0, abs=15.0)  # 3-wide vertical, both legs in the money


def test_weekly_uses_the_intraday_momentum_form():
    spread = options.weekly(trade(), market())
    assert not isinstance(spread, str) and spread.expiry == "2025-06-06"


def test_price_trades_collects_skips_with_reasons():
    spreads, skipped = options.price_trades("0DTE", [trade(), trade(day="2021-06-01")], market())
    assert len(spreads) == 1 and skipped == [{"day": "2021-06-01", "symbol": "SPY", "rule": "A",
                                              "reason": "before daily expiries"}]


def test_weekly_starts_with_the_etf_weeklys():
    assert options.weekly(trade(day="2010-06-03"), market()) == "before weekly expiries"
