"""Options-side continuation study: the debit vertical form on the existing option model (ledger only, synthetic)."""
from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from strategies.flow_control import options
from strategies.flow_control.rules import Trade
from strategies.imom.data import is_closed, ms_at
from strategies.qc_ports.data import Market

DAY = "2025-06-03"  # Tuesday; the nearest Friday weekly is 2025-06-06


def market(symbol="SPY", first="2025-05-01", last="2025-06-30", iv=18.0, rate=0.04, gap=None) -> Market:
    days, d = [], date.fromisoformat(first)
    while d <= date.fromisoformat(last):
        if d.weekday() < 5 and not is_closed(d) and (gap is None or not gap[0] <= d.isoformat() <= gap[1]):
            days.append(d.isoformat())
        d += timedelta(days=1)
    return Market(symbol, tuple(days), tuple(500.0 for _ in days), tuple(iv for _ in days),
                  tuple(rate for _ in days))


def trade(side=1, day=DAY, entry=500.0, exit_=502.0, entry_bar=20, exit_bar=200) -> Trade:
    return Trade(day, side, entry_bar, exit_bar, entry, exit_, "state", side * (exit_ - entry))


def test_long_trade_prices_a_call_debit_vertical():
    spreads, skipped = options.price_trades("SPY", [trade()], market())
    assert not skipped and len(spreads) == 1
    s = spreads[0]
    assert s.right == "call" and s.long_strike < s.short_strike and s.entry_price > 0
    assert s.event.entry_ms == ms_at(DAY, 570 + 20) and s.entry_spot == 500.0


def test_short_trade_prices_a_put_debit_vertical():
    spreads, _ = options.price_trades("QQQ", [trade(side=-1)], market("QQQ"))
    assert spreads[0].right == "put" and spreads[0].long_strike > spreads[0].short_strike
    assert spreads[0].event.side == "short"


def test_exit_is_priced_at_the_exit_minute():
    up, _ = options.price_trades("SPY", [trade(exit_=505.0)], market())
    down, _ = options.price_trades("SPY", [trade(exit_=495.0)], market())
    assert up[0].exit_ms == ms_at(DAY, 570 + 200) and up[0].exit_spot == 505.0
    assert up[0].exit_price > down[0].exit_price


def test_expiry_is_one_to_five_trading_days():
    for day in ("2025-06-02", "2025-06-03", "2025-06-05", "2025-06-06"):
        spreads, _ = options.price_trades("SPY", [trade(day=day)], market())
        expiry = date.fromisoformat(spreads[0].expiry)
        assert expiry.weekday() in (3, 4)
        gap = sum(1 for k in range(1, (expiry - date.fromisoformat(day)).days + 1)
                  if not is_closed(date.fromisoformat(day) + timedelta(days=k)))
        assert 1 <= gap <= 5


def test_stale_or_missing_iv_is_skipped_with_a_reason():
    _, skipped = options.price_trades("SPY", [trade()], market(gap=("2025-05-20", "2025-06-02")))
    assert skipped == [{"day": DAY, "symbol": "SPY", "reason": "stale IV"}]
    _, skipped = options.price_trades("SPY", [trade()], market(first="2025-06-03"))
    assert skipped[0]["reason"] == "no previous close"


def test_max_loss_is_at_most_two_percent_of_the_account():
    spreads, _ = options.price_trades("SPY", [trade()], market())
    booked = options.book_form(spreads, [DAY], nautilus=False)
    record = booked["result"].trades[0]
    assert record["contracts"] >= 1
    assert record["contracts"] * spreads[0].max_loss <= options.ACCOUNT * options.MAX_LOSS_PCT / 100 + 1e-6
    assert booked["maxGap"] is None


def test_stress_costs_doubles_the_spread_part_only():
    s = options.price_trades("SPY", [trade()], market())[0][0]
    t = options.stress_costs(s)
    assert t.entry_fee == pytest.approx(options.LEG_COMMISSIONS + 2 * (s.entry_fee - options.LEG_COMMISSIONS), abs=0.01)
    assert t.exit_fee == pytest.approx(options.LEG_COMMISSIONS + 2 * (s.exit_fee - options.LEG_COMMISSIONS), abs=0.01)
    assert t.max_loss > s.max_loss and t.entry_price == s.entry_price
    same = options.stress_costs(s, 1.0)
    assert same.entry_fee == pytest.approx(s.entry_fee) and same.max_loss == pytest.approx(s.max_loss, abs=0.011)


def test_session_pnl_from_equity_points():
    points = [("2025-06-02", 100_100.0), ("2025-06-04", 99_900.0)]
    assert options.session_pnl_from_equity(points, ["2025-06-02", "2025-06-03", "2025-06-04"]) == [100.0, 0.0, -200.0]
    assert options.session_pnl_from_equity([], ["2025-06-02"]) == [0.0]


def test_trade_nets_come_from_the_booked_result():
    assert options.trade_nets(SimpleNamespace(trades=({"pnl": 12.5}, {"pnl": -3}))) == [12.5, -3.0]
    spreads, _ = options.price_trades("SPY", [trade(), trade(day="2025-06-04")], market())
    booked = options.book_form(spreads, [DAY, "2025-06-04"], nautilus=False)
    nets = options.trade_nets(booked["result"])
    assert len(nets) == 2
    pnl = options.session_pnl_from_equity(booked["points"], [DAY, "2025-06-04"])
    assert sum(pnl) == pytest.approx(sum(nets), abs=0.05)
