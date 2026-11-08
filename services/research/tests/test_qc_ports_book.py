"""qc-ports book: options block, expiry and strike choice, instrument values, sizing and exits.

Synthetic SPY market without skew or dividends, ATM IV 0.2 and r = 0, so every
expected price is plain Black-Scholes with the stated strikes and days.
"""
import math

import pytest

from strategies.qc_ports import book as bk
from strategies.qc_ports import options as om
from tests.qc_ports_synthetic import flat_model, market, trading_days

DEBIT = {"structure": "callDebitVertical", "dte": {"target": 45, "min": 30}, "widthSigma": 0.5, "maxLossPct": 2}
PUT_CREDIT = {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "widthSigma": 0.5,
              "maxLossPct": 2}
DATES = trading_days("2024-01-02", 45)
ENTRY = 1  # signal at bar 0 -> trade at the close of bar 1 (2024-01-03); expiry 2024-02-16 (44 DTE)


def call(spot, strike, days):
    return om.bs_price("call", spot, strike, days / 365, 0, 0, 0.2)


def put(spot, strike, days):
    return om.bs_price("put", spot, strike, days / 365, 0, 0, 0.2)


def fee(*mids):
    return round(sum(0.65 + 100 * max(0.01, 0.01 * mid) for mid in mids), 2)


def run(closes, block, events=(("SPY", 0, None),), **kwargs):
    return bk.build_book(events, block, {"SPY": market(closes, **kwargs)})


@pytest.fixture(autouse=True)
def _flat(monkeypatch):
    flat_model(monkeypatch)


# ---------------------------------------------------------------- options block and sizing

def test_parse_options_defaults_and_fields():
    spec = bk.parse_options(DEBIT)
    assert (spec.right, spec.kind, spec.dte_target, spec.dte_min) == ("call", "debit", 45, 30)
    assert (spec.long_delta, spec.short_delta, spec.profit_take_pct, spec.exit_dte) == (0.5, 0.25, None, None)
    spec = bk.parse_options({**PUT_CREDIT, "shortDelta": 0.3, "profitTakePct": 50, "exitDte": 21, "longDelta": 0.6})
    assert (spec.right, spec.kind, spec.short_delta, spec.profit_take_pct, spec.exit_dte) == (
        "put", "credit", 0.3, 50.0, 21)


@pytest.mark.parametrize(("change", "message"), [
    ({"maxLossPct": 2.5}, "refused"),
    ({"maxLossPct": 0}, "maxLossPct"),
    ({"maxLossPct": "2"}, "maxLossPct"),
    ({"structure": "ironCondor"}, "structure"),
    ({"dte": {"target": 45}}, "dte"),
    ({"dte": {"target": 5, "min": 1}}, "target"),
    ({"dte": {"target": 45, "min": True}}, "min"),
    ({"widthSigma": 4}, "widthSigma"),
    ({"widthSigma": float("nan")}, "widthSigma"),
    ({"profitTakePct": 0}, "profitTakePct"),
    ({"exitDte": 401}, "exitDte"),
    ({"stopLossPct": 5}, "Unknown"),
])
def test_parse_options_refuses_bad_blocks(change, message):
    with pytest.raises(ValueError, match=message):
        bk.parse_options({**DEBIT, **change})


def test_sizing_two_percent_of_equity_over_max_loss():
    # 2% of 100,000 = 2,000; max loss 121.11 per contract -> floor(16.51) = 16.
    assert bk.contracts_for(100_000, 100_000, 2, 121.11, 121.11) == 16
    # 1% -> floor(8.26) = 8.
    assert bk.contracts_for(100_000, 100_000, 1, 121.11, 121.11) == 8
    # Capped by the cash for value + costs: floor(1,000 / 121.11) = 8.
    assert bk.contracts_for(100_000, 1_000, 2, 121.11, 121.11) == 8
    # Max loss above 2% of equity -> 0 contracts.
    assert bk.contracts_for(100_000, 100_000, 2, 2_000.01, 2_000.01) == 0
    assert bk.contracts_for(100_000, 100_000, 2, 0, 0) == 0
    assert bk.contracts_for(-5, 100_000, 2, 100, 100) == 0


@pytest.mark.parametrize("pct", [2.01, 5, 0, -1])
def test_sizing_refuses_more_than_two_percent(pct):
    with pytest.raises(ValueError, match="refused"):
        bk.contracts_for(100_000, 100_000, pct, 100, 100)


# ---------------------------------------------------------------- expiry and strikes

def test_choose_expiry():
    # From 2024-01-03: Jan 19 (16 DTE), Feb 16 (44), Mar 15 (72).
    assert bk.choose_expiry("2024-01-03", 45, 30).isoformat() == "2024-02-16"
    assert bk.choose_expiry("2024-01-03", 70, 30).isoformat() == "2024-03-15"
    assert bk.choose_expiry("2024-01-03", 7, 1).isoformat() == "2024-01-19"
    assert bk.choose_expiry("2024-01-03", 7, 20).isoformat() == "2024-02-16"  # min DTE skips January
    assert bk.choose_expiry("2024-01-03", 30, 1).isoformat() == "2024-01-19"  # tie 14 / 14 -> earlier
    assert bk.choose_expiry("2025-03-20", 30, 25).isoformat() == "2025-04-17"  # Good Friday -> Thursday
    assert bk.choose_expiry("2024-01-03", 400, 400).isoformat() == "2025-02-21"


def test_choose_strikes_by_hand():
    t = 30 / 365
    spec = bk.parse_options(DEBIT)
    # Call deltas at 30 DTE, S = 100: K=100 0.5114, K=101 0.4424 -> long 100.
    # Width = 0.5 * 0.2 * sqrt(30/365) * 100 = 2.867 -> 3 strikes.
    assert bk.choose_strikes("call", "debit", 100, t, 0, 0, 0.2, 0, spec) == (100.0, 103.0, 3.0)
    # Put deltas: K=100 -0.4886, K=99 -0.4192 -> long 100, short 97.
    assert bk.choose_strikes("put", "debit", 100, t, 0, 0, 0.2, 0, spec) == (100.0, 97.0, 3.0)
    # Put credit, short delta 0.25: K=96 -0.2295, K=97 -0.2878 -> short 96, long 93.
    assert bk.choose_strikes("put", "credit", 100, t, 0, 0, 0.2, 0, spec) == (93.0, 96.0, 3.0)
    # Call credit: K=104 0.2561 -> short 104, long 107.
    assert bk.choose_strikes("call", "credit", 100, t, 0, 0, 0.2, 0, spec) == (107.0, 104.0, 3.0)
    # Width never below one strike step.
    narrow = bk.parse_options({**DEBIT, "widthSigma": 0.1})
    assert bk.choose_strikes("call", "debit", 100, t, 0, 0, 0.2, 0, narrow) == (100.0, 101.0, 1.0)
    # Spot under 25: half-dollar grid. Width = 0.5 * 0.2 * 0.2867 * 20 = 0.573 -> 0.5.
    assert bk.choose_strikes("call", "debit", 20, t, 0, 0, 0.2, 0, spec)[2] == 0.5
    # Far put leg at or below 0 -> no spread; no time -> no spread.
    wide = bk.parse_options({**PUT_CREDIT, "widthSigma": 3, "shortDelta": 0.05})
    assert bk.choose_strikes("put", "credit", 1.0, 1.0, 0, 0, 0.8, 0, wide) is None
    assert bk.choose_strikes("call", "debit", 100, 0, 0, 0, 0.2, 0, spec) is None


def test_instrument_values_debit_and_credit():
    t = 30
    long_mid, short_mid = call(100, 100, t), call(100, 103, t)  # 2.28715, 1.12317
    assert bk.instrument_value("debit", long_mid, short_mid, 3) == 116.40
    p96, p93 = put(100, 96, t), put(100, 93, t)  # 0.78639, 0.27062: liability 0.51577
    assert bk.instrument_value("credit", p93, p96, 3) == 248.42
    # Bounds: worthless debit, credit at max loss, both >= 0.
    assert bk.instrument_value("debit", 0.0, 0.0, 3) == 0
    assert bk.instrument_value("credit", 4.0, 7.0, 3) == 0
    assert bk.instrument_value("credit", 0.0, 0.0, 3) == 300


# ---------------------------------------------------------------- priced trades

def test_debit_trade_held_to_exit_dte():
    book = run([100.0] * 45, {**DEBIT, "exitDte": 7})
    (trade,) = book.trades
    assert (trade.expiry, trade.long_strike, trade.short_strike, trade.width) == ("2024-02-16", 100.0, 103.0, 3.0)
    assert (trade.entry_index, trade.entry_date) == (ENTRY, "2024-01-03")
    entry = (call(100, 100, 44), call(100, 103, 44))
    assert trade.entry_price == round(100 * (entry[0] - entry[1]), 2)
    assert trade.premium == pytest.approx(entry[0] - entry[1])
    assert trade.entry_fee == fee(*entry)
    assert trade.max_loss == round(trade.entry_price + trade.entry_fee, 2)
    # First close with DTE <= 7: Fri 2024-02-09 (7 days to Feb 16).
    assert (trade.exit_date, trade.exit_reason) == ("2024-02-09", "exitDte")
    leave = (call(100, 100, 7), call(100, 103, 7))
    assert trade.exit_price == round(100 * (leave[0] - leave[1]), 2)
    assert trade.exit_fee == fee(*leave)
    assert trade.marks[0] == ("2024-01-03", trade.entry_price)
    assert trade.marks[-1] == ("2024-02-09", trade.exit_price)
    assert [day for day, _ in trade.marks] == list(DATES[ENTRY:28])
    assert book.skipped == ()


def test_debit_profit_take():
    closes = [100.0] * 5 + [104.0] * 40
    (trade,) = run(closes, {**DEBIT, "profitTakePct": 50}).trades
    # Bar 5 (2024-01-09, 38 DTE): 100/103 call spread at S = 104 vs the 44 DTE debit at S = 100.
    value = round(100 * (call(104, 100, 38) - call(104, 103, 38)), 2)
    assert value >= 1.5 * trade.entry_price
    assert (trade.exit_date, trade.exit_reason, trade.exit_price) == ("2024-01-09", "profitTake", value)
    # At +100% the trade stays open until the first close at twice the debit.
    (trade,) = run(closes, {**DEBIT, "profitTakePct": 100}).trades
    assert trade.exit_reason == "profitTake" and trade.exit_date > "2024-01-09"
    assert trade.marks[-1][1] >= 2 * trade.entry_price > trade.marks[-2][1]


def test_credit_profit_take_and_values():
    closes = [100.0] * 5 + [108.0] * 40
    (trade,) = run(closes, {**PUT_CREDIT, "profitTakePct": 50}).trades
    # 44 DTE put deltas: K=96 -0.2668, K=95 -0.2196 -> short 96; width 0.5*0.2*sqrt(44/365)*100 = 3.47 -> 3.
    assert (trade.short_strike, trade.long_strike) == (96.0, 93.0)
    credit = put(100, 96, 44) - put(100, 93, 44)
    assert trade.entry_price == round(100 * (3 - credit), 2)
    assert trade.max_loss == round(trade.entry_price + trade.entry_fee, 2)
    liability = put(108, 96, 38) - put(108, 93, 38)
    assert liability <= 0.5 * credit
    assert (trade.exit_date, trade.exit_reason) == ("2024-01-09", "profitTake")
    assert trade.exit_price == round(100 * (3 - liability), 2)


def test_expiry_settles_at_intrinsic_without_costs():
    closes = [100.0] * 32 + [102.0] * 13  # bar 32 = 2024-02-16 (expiry)
    (trade,) = run(closes, DEBIT).trades
    assert (trade.exit_date, trade.exit_reason, trade.exit_price, trade.exit_fee) == (
        "2024-02-16", "expiry", 200.0, 0.0)
    # A put credit spread with the spot below both strikes ends at 0 = the max loss.
    closes = [100.0] * 32 + [80.0] * 13
    (trade,) = run(closes, PUT_CREDIT).trades
    assert (trade.exit_reason, trade.exit_price) == ("expiry", 0.0)
    assert all(value >= 0 for _, value in trade.marks)


def test_signal_exit_trades_at_the_next_close():
    (trade,) = run([100.0] * 45, DEBIT, events=[bk.SignalEvent("SPY", 0, 3)]).trades
    assert (trade.exit_index, trade.exit_date, trade.exit_reason) == (4, "2024-01-08", "signal")
    with pytest.raises(ValueError, match="after the entry"):
        run([100.0] * 45, DEBIT, events=[("SPY", 3, 3)])
    with pytest.raises(ValueError, match="outside"):
        run([100.0] * 45, DEBIT, events=[("SPY", 45, None)])
    with pytest.raises(ValueError, match="No market"):
        run([100.0] * 45, DEBIT, events=[("QQQ", 0, None)])


def test_end_of_data_closes_open_trades():
    (trade,) = run([100.0] * 20, DEBIT).trades
    assert (trade.exit_date, trade.exit_reason) == (DATES[19], "end")
    assert trade.exit_fee > 0


def test_skips_without_iv_rate_bars_or_time():
    ivs = [22.0, None] + [22.0] * 43
    book = run([100.0] * 45, DEBIT, ivs=ivs)
    assert (book.trades, [s.reason for s in book.skipped]) == ((), ["no IV"])
    book = run([100.0] * 45, DEBIT, rate=None)
    assert [s.reason for s in book.skipped] == ["no rate"]
    book = run([100.0] * 45, DEBIT, events=[("SPY", 43, None)])
    assert [s.reason for s in book.skipped] == ["no bar to enter and exit"]
    book = run([100.0] * 45, {**DEBIT, "exitDte": 44})
    assert [s.reason for s in book.skipped] == ["exitDte at entry"]
    assert book.skipped[0].event == bk.SignalEvent("SPY", 0, None)


def test_open_trade_carries_the_last_iv():
    ivs = [200 / 9] * 3 + [None] * 3 + [200 / 9] * 39
    (trade,) = run([100.0] * 45, {**DEBIT, "exitDte": 7}, ivs=ivs).trades
    assert trade.stale_days == 3
    (plain,) = run([100.0] * 45, {**DEBIT, "exitDte": 7}).trades
    assert trade.marks == plain.marks


def test_trade_ids_follow_accepted_events():
    events = [("SPY", 0, 5), ("SPY", 43, None), ("SPY", 6, None)]
    book = run([100.0] * 45, DEBIT, events=events)
    assert [(t.trade_id, t.entry_index) for t in book.trades] == [(1, 1), (2, 7)]
    assert all(math.isclose(t.max_loss_pct, 2) for t in book.trades)
