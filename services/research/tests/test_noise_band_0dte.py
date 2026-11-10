"""Tests for the 0DTE option expression of the noise-band signal (synthetic quotes)."""
from datetime import date

from strategies.noise_band import BacktestResult, Params, Trade
from strategies.noise_band_0dte import OptionParams, last_exit_minute, nearest_strike, price_trade, run_options

D = date(2024, 3, 1)


class Book:
    def __init__(self, quotes, strikes=(495.0, 498.0, 499.0, 500.0, 501.0, 505.0)):
        self.q = quotes
        self.k = sorted(strikes)

    def strikes(self, day):
        return self.k if day == D else []

    def quote(self, day, minute, right, strike):
        return self.q.get((minute, right, strike))


def stock_trade(side=1, entry=30, exit_=120, reason="stop"):
    return Trade(D, side, 100, entry, 500.0, exit_, 501.0, reason, 100.0, 0.7)


def test_nearest_strike_ties_go_out_of_the_money():
    assert nearest_strike([499.0, 500.0, 501.0], 500.4, "C") == 500.0
    assert nearest_strike([499.0, 500.0], 499.5, "C") == 500.0
    assert nearest_strike([499.0, 500.0], 499.5, "P") == 499.0


def test_last_exit_minute_full_and_half_day():
    assert last_exit_minute(390) == 375  # 15:45
    assert last_exit_minute(210) == 195  # 12:45 on a 13:00 close


def test_single_call_buys_ask_sells_bid_and_caps_premium():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (120, "C", 500.0): (2.50, 2.55)})
    t, why = price_trade(book, stock_trade(), 500.2, 501.0, 100_000.0, OptionParams())
    # 2% of 100k = 2,000 -> floor(2000 / 200) = 10 contracts
    assert why == "ok" and t.shares == 10 and t.entry_price == 2.00 and t.exit_price == 2.50
    assert abs(t.gross - 10 * 100 * 0.50) < 1e-9
    assert abs(t.cost - 2 * 10 * 0.65) < 1e-9
    assert t.exit_reason == "stop:C500"


def test_short_signal_uses_put_and_close_exit_uses_1545_quote():
    book = Book({(30, "P", 500.0): (1.00, 1.10), (375, "P", 500.0): (0.0, 0.05), (389, "P", 500.0): (0.9, 0.95)})
    t, _ = price_trade(book, stock_trade(side=-1, exit_=390, reason="close"), 499.8, 499.0, 100_000.0, OptionParams())
    assert t.exit_minute == 375 and t.exit_price == 0.0 and t.gross < 0


def test_half_day_close_exit_uses_1245_quote():
    book = Book({(30, "C", 500.0): (1.00, 1.10), (195, "C", 500.0): (1.40, 1.45), (210, "C", 500.0): (9.0, 9.5)})
    t, _ = price_trade(book, stock_trade(exit_=210, reason="close"), 500.0, 500.5, 100_000.0, OptionParams(), close_minute=210)
    assert t.exit_minute == 195 and t.exit_price == 1.40


def test_skip_reasons_before_entry():
    assert price_trade(Book({}), stock_trade(), 500.0, 500.0, 1e5, OptionParams())[1] == "no_entry_quote"
    book = Book({(30, "C", 500.0): (30.0, 30.5), (120, "C", 500.0): (31.0, 31.5)})
    assert price_trade(book, stock_trade(), 500.0, 500.0, 100_000.0, OptionParams())[1] == "too_expensive_for_cap"


def test_single_missing_exit_quote_counts_as_zero():
    book = Book({(30, "C", 500.0): (1.95, 2.00)})
    t, why = price_trade(book, stock_trade(), 500.0, 498.0, 100_000.0, OptionParams())
    assert why == "ok" and t.exit_price == 0.0 and t.exit_reason.endswith(":exit_quote_missing")


def test_vertical_debit_and_credit():
    book = Book({
        (30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25),
        (120, "C", 500.0): (3.00, 3.05), (120, "C", 505.0): (0.40, 0.45),
    })
    t, _ = price_trade(book, stock_trade(), 500.0, 502.0, 100_000.0, OptionParams(instrument="vertical"))
    assert abs(t.entry_price - 1.80) < 1e-9 and abs(t.exit_price - 2.55) < 1e-9
    assert t.shares == 11  # floor(2000 / 180)
    assert abs(t.cost - 4 * 11 * 0.65) < 1e-9


def test_vertical_missing_short_exit_quote_is_not_skipped():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (30, "C", 505.0): (0.20, 0.25), (120, "C", 500.0): (6.0, 6.1)})
    t, why = price_trade(book, stock_trade(), 500.0, 506.0, 100_000.0, OptionParams(instrument="vertical"))
    # short 505C ask missing -> intrinsic 1.00 + 0.05
    assert why == "ok" and abs(t.exit_price - (6.0 - 1.05)) < 1e-9


def test_run_options_equity_and_counts():
    book = Book({(30, "C", 500.0): (1.95, 2.00), (120, "C", 500.0): (2.95, 3.00)})
    other_day = Trade(date(2024, 2, 29), 1, 100, 30, 500.0, 120, 501.0, "stop", 0.0, 0.0)
    stock = BacktestResult(Params(), [], [stock_trade(), stock_trade(side=-1), other_day])
    prices = {(D, 30): 500.0, (D, 120): 501.0}
    res, counts = run_options(stock, prices, {D: 390, date(2024, 3, 4): 390}, book, [D, date(2024, 3, 4)])
    assert len(res.days) == 2 and len(res.trades) == 1
    assert counts["no_entry_quote"] == 1  # the put has no quote
    assert counts["outside_option_days"] == 1
    assert res.days[0].aum_end > res.days[0].aum_start
    assert res.days[1].ret == 0.0
