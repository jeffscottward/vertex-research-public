"""qc-ports reference ledger and metrics, checked against hand-computed books."""
import math
from dataclasses import replace
from statistics import NormalDist

import pytest

from backtesting.optimizer import deflated_sharpe_ratio
from strategies.qc_ports.book import PricedTrade
from strategies.qc_ports.ledger import LedgerResult, run_ledger, timeline
from strategies.qc_ports.metrics import max_drawdown, summarize, worst_month

D = ("2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09")


def trade(trade_id, marks, *, entry_fee, exit_fee, reason="signal", max_loss_pct=2.0, symbol="SPY"):
    (entry_date, entry_price), (exit_date, exit_price) = marks[0], marks[-1]
    return PricedTrade(
        trade_id=trade_id, symbol=symbol, structure="callDebitVertical", expiry="2024-02-16", long_strike=100.0,
        short_strike=103.0, width=3.0, entry_index=0, exit_index=len(marks) - 1, entry_date=entry_date,
        exit_date=exit_date, entry_price=entry_price, exit_price=exit_price, entry_fee=entry_fee,
        exit_fee=exit_fee, max_loss=round(entry_price + entry_fee, 2), max_loss_pct=max_loss_pct,
        premium=entry_price / 100, exit_reason=reason, marks=tuple(marks))


def hand_book():
    a = trade(1, [(D[0], 100.0), (D[1], 150.0), (D[2], 200.0)], entry_fee=2.0, exit_fee=3.0)
    c = trade(2, [(D[1], 4999.0), (D[2], 4999.0)], entry_fee=1.0, exit_fee=1.0)
    b = trade(3, [(D[2], 49.92), (D[3], 30.0), (D[4], 0.0)], entry_fee=1.0, exit_fee=0.0, reason="expiry")
    return [a, b, c]


def test_ledger_by_hand():
    result = run_ledger(hand_book(), 100_000, dates=D)
    # D1: A sized floor(2% * 100,000 / 102) = 19; cash 100,000 - 1,900 - 38 = 98,062; equity 99,962.
    # D2: C needs 5,000 a contract > 2% of 100,912 -> skipped; equity 98,062 + 19 * 150 = 100,912.
    # D3: A exits first: cash 98,062 + 3,800 - 57 = 101,805. B sized from that equity:
    #     floor(2,036.10 / 50.92) = 39 (before the exit fee it would be 40); cash 101,805 - 1,946.88 - 39.
    # D4: 99,819.12 + 39 * 30. D5: B expires at 0 without costs.
    assert result.equity == pytest.approx(
        (99_962.0, 100_912.0, 101_766.0, 100_989.12, 99_819.12, 99_819.12), rel=0, abs=1e-9)
    assert result.open_positions == (1, 1, 1, 1, 0, 0)
    assert result.skipped == ({"id": 2, "symbol": "SPY", "entryDate": D[1], "reason": "size"},)
    first, second = result.trades
    assert (first["id"], first["contracts"], first["entryFee"], first["exitFee"], first["pnl"]) == (
        1, 19, 38.0, 57.0, 1805.0)
    assert first["returnOnRisk"] == pytest.approx(1805 / (19 * 102))
    assert (second["id"], second["contracts"], second["entryFee"], second["exitFee"], second["pnl"]) == (
        3, 39, 39.0, 0.0, -1985.88)
    assert second["exitReason"] == "expiry"
    assert result.dates == D and result.capital == 100_000


def test_ledger_timeline_checks():
    book = hand_book()
    assert timeline(book) == D[:5]
    assert run_ledger(book).dates == D[:5]
    with pytest.raises(ValueError, match="outside the run dates"):
        run_ledger(book, dates=D[1:])
    with pytest.raises(ValueError, match="unique"):
        run_ledger([book[0], book[0]])
    with pytest.raises(ValueError, match="capital"):
        run_ledger(book, 0)
    # A malformed trade whose exit date is after the run never closes.
    late = replace(trade(9, [(D[3], 10.0), (D[4], 12.0)], entry_fee=1.0, exit_fee=1.0), exit_date="2024-01-10")
    with pytest.raises(ValueError, match="open after"):
        run_ledger([late])


def test_ledger_never_sizes_above_two_percent():
    refused = trade(1, [(D[0], 10.0), (D[1], 10.0)], entry_fee=0.0, exit_fee=0.0, max_loss_pct=2.5)
    with pytest.raises(ValueError, match="refused"):
        run_ledger([refused])


def _result(equity, dates, open_positions, trades=(), capital=100.0):
    return LedgerResult(tuple(dates), tuple(equity), tuple(open_positions), tuple(trades), (), capital=capital)


def test_metrics_by_hand():
    dates = ("2024-01-02", "2024-01-31", "2024-02-29", "2025-01-02")
    trades = ({"pnl": 5.0}, {"pnl": -1.0}, {"pnl": 0.0})
    result = _result((100.0, 110.0, 99.0, 121.0), dates, (1, 0, 1, 1), trades)
    stats = summarize(result, n_trials=10, sharpe_variance=0.01)
    assert stats["totalReturn"] == pytest.approx(0.21)
    assert stats["cagr"] == pytest.approx(1.21 ** (365.25 / 366) - 1)
    assert stats["maxDrawdown"] == pytest.approx(-0.1)
    assert (stats["worstMonth"], stats["worstMonthReturn"]) == ("2024-02", pytest.approx(-0.1))
    assert stats["winRate"] == pytest.approx(1 / 3)
    assert stats["exposure"] == 0.75
    assert (stats["trades"], stats["days"], stats["nTrials"]) == (3, 4, 10)
    returns = [0.1, -0.1, 121 / 99 - 1]
    mean = sum(returns) / 3
    std = math.sqrt(sum((x - mean) ** 2 for x in returns) / 2)
    assert stats["sharpe"] == pytest.approx(mean / std * math.sqrt(252))
    m2 = sum((x - mean) ** 2 for x in returns) / 3
    skew = sum((x - mean) ** 3 for x in returns) / 3 / m2 ** 1.5
    kurt = sum((x - mean) ** 4 for x in returns) / 3 / m2 ** 2
    expected = deflated_sharpe_ratio(mean / std, 10, 0.01, 3, skew, kurt)
    assert stats["deflatedSharpe"] == pytest.approx(expected.probability)
    assert stats["expectedMaxSharpe"] == pytest.approx(expected.expected_max_sharpe)
    # One trial: benchmark 0 (probabilistic Sharpe); default variance = estimator variance.
    radicand = 1 - skew * mean / std + (kurt - 1) / 4 * (mean / std) ** 2
    single = summarize(result, n_trials=1)
    assert single["deflatedSharpe"] == pytest.approx(NormalDist().cdf(mean / std * math.sqrt(2) / math.sqrt(radicand)))
    assert single["sharpeVariance"] == pytest.approx(radicand / 2)
    assert single["expectedMaxSharpe"] == 0.0


def test_metrics_edge_cases():
    flat = _result((100.0, 100.0, 100.0), ("2024-01-02", "2024-01-03", "2024-01-04"), (0, 0, 0))
    stats = summarize(flat, n_trials=3)
    assert stats["sharpe"] is None and stats["deflatedSharpe"] is None and stats["winRate"] is None
    assert stats["maxDrawdown"] == 0 and stats["cagr"] == pytest.approx(0.0)
    two = _result((100.0, 101.0), ("2024-01-02", "2024-01-03"), (0, 0))
    assert summarize(two, n_trials=2)["sharpe"] is None
    same_day = _result((100.0, 101.0), ("2024-01-02", "2024-01-02"), (0, 0))
    assert summarize(same_day, n_trials=1)["cagr"] is None
    for bad in (0, 1.5, True):
        with pytest.raises(ValueError, match="n_trials"):
            summarize(flat, n_trials=bad)
    with pytest.raises(ValueError, match="two run days"):
        summarize(_result((100.0,), ("2024-01-02",), (0,)), n_trials=1)
    assert max_drawdown([1.0, 2.0, 1.0, 3.0]) == -0.5
    assert worst_month([], [], 1.0) is None


@pytest.mark.parametrize("options", [
    {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.25, "widthSigma": 0.5,
     "profitTakePct": 50, "exitDte": 21, "maxLossPct": 2},
    {"structure": "callDebitVertical", "dte": {"target": 30, "min": 21}, "longDelta": 0.5, "widthSigma": 1.0,
     "exitDte": 5, "maxLossPct": 2},
])
def test_vol_doubling_crash_never_loses_more_than_two_percent(options):
    from strategies.qc_ports.book import SignalEvent, build_book, worst_exit_cost
    from tests.qc_ports_synthetic import VIX_FOR_20, market

    closes = [100.0] * 5 + [100.0 - 6 * k for k in range(1, 6)] + [70.0] * 40  # -30% in five days
    ivs = [VIX_FOR_20] * 5 + [2 * VIX_FOR_20] * 45  # implied volatility doubles
    spy = market(closes, ivs=ivs, rate=0.04)
    book = build_book([SignalEvent("SPY", 2, None)], options, {"SPY": spy})
    result = run_ledger(book.trades, dates=spy.dates)
    (record,) = result.trades
    (priced,) = book.trades
    assert record["pnl"] < 0
    assert -record["pnl"] <= 0.02 * 100_000
    assert -record["pnl"] <= record["contracts"] * priced.max_loss + 1e-6
    assert priced.exit_fee <= worst_exit_cost("SPY", priced.width)
