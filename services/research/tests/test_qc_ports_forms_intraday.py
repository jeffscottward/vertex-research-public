"""qc-ports intraday forms: the order machine's bracket and stacked stops, the five rules and the registry (synthetic)."""
import dataclasses
import json
import random
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from strategies.qc_ports import forms as fm
from strategies.qc_ports import forms_intraday as fi
from strategies.qc_ports import forms_library as fl
from strategies.qc_ports import intraday as it
from strategies.qc_ports.data import Bars
from strategies.qc_ports.forms_orders import MARKET, Spec, run
from strategies.qc_ports.ledger import run_ledger
from tests.qc_ports_synthetic import bar_times, random_walk_bars, trading_days

ROOT = Path(__file__).resolve().parents[3]
START = "2024-01-02"


def _bars(rows, minutes=30) -> Bars:
    """Bars from (open, high, low, close) rows on `minutes`-minute bar times."""
    keys = bar_times(START, len(rows), minutes)[:len(rows)]
    columns = [tuple(float(row[column]) for row in rows) for column in range(4)]
    return Bars("SPY", keys, *columns, columns[3])


def _closes(values, minutes=30) -> Bars:
    return _bars([(value, value, value, value) for value in values], minutes)


# --------------------------------------------------------------------------- order machine: bracket

# An entry on every 4th bar: the signal bar is index 3 (close 100), so the take profit is 100.6 and the stop 99.6.
BRACKET = Spec("clock", MARKET, ("enter", "bracket"), every=4, bracket=(1.006, 0.996))
FLAT = (100, 100, 100, 100)


def test_the_bracket_rests_from_the_bar_after_the_entry_fill_and_closes_at_the_take_profit():
    rows = [FLAT, FLAT, FLAT, FLAT,
            (100.2, 101, 99, 100.2),  # the entry fills at the open; this bar reaches both prices and closes nothing
            (100.2, 100.5, 99.7, 100.3),  # between the two prices
            (100.3, 100.7, 100.1, 100.6)]  # the high reaches 100.6
    assert run(_bars(rows), BRACKET) == [0, 0, 0, 1, 1, 1, 0]


def test_the_bracket_closes_at_the_stop():
    rows = [FLAT, FLAT, FLAT, FLAT, (100.2, 100.3, 100.1, 100.2), (100.2, 100.3, 99.61, 100.0),
            (100.0, 100.1, 99.5, 99.8)]
    assert run(_bars(rows), BRACKET) == [0, 0, 0, 1, 1, 1, 0]


def test_the_bracket_prices_come_from_the_signal_close_and_not_from_the_fill():
    # The entry fills 3% higher at the open. The take profit stays at 100.6, so the next bar fills it.
    rows = [FLAT, FLAT, FLAT, FLAT, (103, 103.2, 102.9, 103), (103, 103.1, 102.9, 103), (103, 103, 103, 103)]
    assert run(_bars(rows), BRACKET) == [0, 0, 0, 1, 1, 0, 0]


def test_o15_buys_an_rsi_below_30_and_holds_until_its_bracket():
    falling = [100 - step for step in range(15)]  # RSI(14) is 0 on the last bar; its close is 86
    rows = [(value, value, value, value) for value in falling]
    rows += [(86, 86.2, 85.9, 86.1), (86.1, 86.3, 85.9, 86.2)]  # take profit 86.52, stop 85.66: neither is reached
    stance = run(_bars(rows, 5), fi.SPECS["qj/O15"])
    assert stance == [0] * 14 + [1, 1, 1]
    stopped = run(_bars([*rows, (86.2, 86.2, 85.6, 85.7)], 5), fi.SPECS["qj/O15"])
    # The stop closes the position; RSI is still below 30 on that bar, so the rule buys again at once.
    assert stopped == [0] * 14 + [1, 1, 1, 1]
    recovered = run(_bars([*rows, (86.2, 99, 86.2, 99), (99, 99, 99, 99)], 5), fi.SPECS["qj/O15"])
    # The take profit closes it on a bar that lifts RSI over 30: the rule is flat.
    assert recovered == [0] * 14 + [1, 1, 1, 0, 0]


# --------------------------------------------------------------------------- order machine: stacked stops (O16)

def _breakout_rows(count=30, first_high=110.0, lifted=(14, 100.2)):
    """Quiet bars with a high of 100: bar 0 has `first_high`, bar `lifted[0]` the high `lifted[1]`."""
    rows = [(99.5, 100.0, 99.5, 99.5)] * count
    rows[0] = (99.5, first_high, 99.5, 99.5)
    rows[lifted[0]] = (99.5, lifted[1], 99.5, 99.5)
    return rows


def test_o16_rests_a_new_stop_on_every_flat_bar_and_sells_on_the_8th_bar_after_the_last_order():
    spec = fi.SPECS["qj/O16"]
    bars = _bars(_breakout_rows())
    # Bar 12: stop at 110.11 (bar 0 is in the 12 highs before). Bar 13: a second stop at 100.1 while the
    # first rests. Bar 14 fills the second. The hold counts from bar 13, so the market sell comes on bar 21.
    assert run(bars, spec) == [0] * 14 + [1] * 7 + [0] * 9
    assert sum(run(bars, dataclasses.replace(spec, stack=False))) == 0
    assert run(bars, dataclasses.replace(spec, hold_from="position")) == [0] * 14 + [1] * 8 + [0] * 8


def test_o16_reads_the_highs_of_the_12_bars_before_from_bar_12_on():
    spec = fi.SPECS["qj/O16"]
    quick = _bars(_breakout_rows(first_high=100.0, lifted=(13, 100.5)))
    assert run(quick, spec)[12:15] == [0, 1, 1]  # the stop of bar 12 (100.1) fills on bar 13
    assert run(quick, dataclasses.replace(spec, first_bar=13))[13] == 0
    # A stop over the highest close (99.5) would be 99.6, and bar 13 of the first series (high 100) would fill it.
    series = _bars(_breakout_rows())
    assert run(series, spec)[13] == 0 and run(series, dataclasses.replace(spec, high=False))[13] == 1


def test_o15_and_o16_hold_shares_on_the_same_bars_as_the_upstream_fill_engine():
    """Reference: tests/fixtures/make_quantjourney_orders_reference.py (the fills of the upstream FillEngine under the
    order logic of the two upstream files, on random walks)."""
    reference = json.loads((Path(__file__).parent / "fixtures/qc_ports/quantjourney-orders-reference.json").read_text())
    assert {item["key"] for item in reference["runs"]} == {"qj/O15", "qj/O16"}
    # Stacked O16 stops can fill on one bar, so upstream holds up to 3 shares; a form keeps the stance only.
    assert max(max(item["stance"]) for item in reference["runs"] if item["key"] == "qj/O16") > "1"
    for item in reference["runs"]:
        bars = random_walk_bars(item["seed"], reference["bars"], item["vol"])
        stance = "".join(map(str, run(bars, fi.SPECS[item["key"]])))
        holds = "".join("0" if shares == "0" else "1" for shares in item["stance"])
        assert "1" in stance and stance == holds, (item["key"], item["seed"], item["vol"])


# --------------------------------------------------------------------------- weights rules

def test_w07_is_long_from_an_rsi_below_35_until_an_rsi_above_55():
    closes = [100 - step for step in range(15)] + [92, 98, 104, 104]  # RSI: 0, then about 30, 49, 60
    assert fi.rsi_band(_closes(closes, 15)) == [0] * 14 + [1, 1, 1, 0, 0]


def test_w08_and_w09_are_long_while_the_fast_average_is_above_the_slow_one():
    wave = [100 + step for step in range(40)] + [139 - 2 * step for step in range(1, 41)]
    ema = fi.ema_trend(_closes(wave, 1))
    assert ema[:20] == [0] * 20 and ema[20:40] == [1] * 20 and ema[-1] == 0
    sma = fi.sma_trend(_closes(wave, 60))
    assert sma[:29] == [0] * 29 and sma[29:40] == [1] * 11 and sma[-1] == 0


# --------------------------------------------------------------------------- registry

def test_the_five_intraday_strategies_have_a_form_on_bars_of_their_own_length():
    library = {item["slug"]: item for item in
               json.loads((ROOT / "research/backtests/quantjourney/library.json").read_text())["strategies"]}
    minutes = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}
    assert [item.form.key for item in fi.FORMS] == ["qj/O15", "qj/O16", "qj/W07", "qj/W08", "qj/W09"]
    for item in fi.FORMS:
        entry = library[item.form.slug]
        assert item.form.key == f"qj/{entry['id']}"
        assert item.minutes == minutes[entry["granularity"]]
        assert set(item.form.symbols) <= set(entry["universe"]) == set(fi.ETF3)
        assert item.form.keeps.endswith(".") and item.form.sleeve
    assert [item.form.symbols for item in fi.FORMS if item.source == fi.ONE_MINUTE] == [("SPY",)]
    assert fl.INTRADAY_FORMS is fi.FORMS


def test_an_intraday_form_and_its_baseline_trade_the_same_symbols_from_the_same_bars(monkeypatch):
    forms = fi.study_forms()
    keys = [item.form.key for item in forms]
    assert len(set(keys)) == len(keys) == 7
    by_key = {item.form.key: item for item in forms}
    assert [item.form.rule is fm.always_on for item in forms] == [True, True] + [False] * 5
    for item in fi.FORMS:
        baseline = by_key[item.form.baseline]
        assert (baseline.form.symbols, baseline.source, baseline.minutes) == (item.form.symbols, item.source, 60)
    odd = dataclasses.replace(fi.FORMS[0], source=fi.ONE_MINUTE)
    monkeypatch.setattr(fi, "FORMS", (odd,))
    with pytest.raises(ValueError, match="not those of base/intraday3"):
        fi.study_forms()


# --------------------------------------------------------------------------- no look-ahead, end to end

def _random_inputs(symbols, count, seed, minutes) -> fm.Inputs:
    rng = random.Random(seed)
    keys = bar_times(START, -(-count // it.bars_per_day(minutes)) + 1, minutes)[:count]
    bars, index = {}, {}
    for symbol in sorted(symbols):
        close, opens, highs, lows, closes = 100.0, [], [], [], []
        for _ in range(count):
            open_ = close * (1 + rng.gauss(0, 0.0005))
            close = open_ * (1 + rng.gauss(0, 0.004))
            opens.append(open_)
            closes.append(close)
            highs.append(max(open_, close) * (1 + abs(rng.gauss(0, 0.001))))
            lows.append(min(open_, close) * (1 - abs(rng.gauss(0, 0.001))))
        bars[symbol] = Bars(symbol, keys, tuple(opens), tuple(highs), tuple(lows), tuple(closes), tuple(closes))
        index[symbol] = (18.0,) * count
    return fm.Inputs(bars, index)


@pytest.mark.parametrize("item", fi.study_forms(), ids=lambda item: item.form.key)
def test_no_intraday_rule_reads_a_bar_after_the_bar_of_its_stance(item):
    count = 700
    minutes = 30 if item.minutes == 60 else item.minutes  # the test keys need a bar length that divides a session
    inputs = _random_inputs(item.form.symbols, count, seed=7, minutes=minutes)
    full = fm.stance_of(item.form, inputs)
    assert set(full) == set(item.form.symbols)
    for size in (260, 431, 580, 699):
        cut = fm.Inputs({symbol: Bars(symbol, *(column[:size] for column in (
            bars.dates, bars.open, bars.high, bars.low, bars.close, bars.adj_close))) for symbol, bars in inputs.bars.items()},
                        {symbol: values[:size] for symbol, values in inputs.iv_index.items()})
        for symbol, sides in fm.stance_of(item.form, cut).items():
            assert sides == full[symbol][:size], f"{item.form.key} {symbol} changes with later bars (cut {size})"
    if item.form.rule is not fm.always_on:
        assert any(0 < sum(sides) < count for sides in full.values()), "the rule is never long or never flat"


def test_an_intraday_form_runs_from_minute_sessions_to_daily_closes():
    rng = random.Random(5)
    days = trading_days(START, 30)
    sessions = {}
    for symbol in fi.ETF3:
        price, made = 100.0, []
        for day in days:
            bars = []
            for minute in range(0, 390, 5):
                open_, price = price, price * (1 + rng.gauss(0, 0.0012))
                bars.append(SimpleNamespace(minute=minute, open=open_, high=max(open_, price) + 0.03,
                                            low=min(open_, price) - 0.03, close=price))
            made.append(SimpleNamespace(day=date.fromisoformat(day), bars=bars))
        sessions[symbol] = made
    item = next(found for found in fi.FORMS if found.form.key == "qj/O16")
    level = dict.fromkeys(trading_days("2023-12-26", 40), 18.0)
    rate = dict.fromkeys(level, 4.0)
    bars = {symbol: it.session_bars(symbol, sessions[symbol], 5, item.minutes) for symbol in fi.ETF3}
    markets = {symbol: it.intraday_market(bars[symbol], level, rate) for symbol in fi.ETF3}
    inputs = fm.Inputs(bars, {symbol: markets[symbol].iv_index for symbol in fi.ETF3})
    book = fm.form_book(item.form, inputs, markets, start=START,
                        window_bars=fm.WINDOW_BARS * it.bars_per_day(item.minutes), trim=True)
    assert len(book.trades) > 10 and {trade.symbol for trade in book.trades} == set(fi.ETF3)
    # The stance lasts 7 bars (fill bar to the bar before the market sell); the spread trades one bar later.
    assert {trade.exit_index - trade.entry_index for trade in book.trades if trade.exit_reason == "signal"} == {7}
    assert {trade.exit_reason for trade in book.trades} <= {"signal", "end"}
    result = run_ledger(book.trades, 100_000.0, dates=bars["SPY"].dates)
    by_day = it.daily_result(result)
    assert by_day.dates == days and len(result.dates) == 30 * 13
    assert by_day.equity[-1] == result.equity[-1] and max(by_day.open_positions) >= 1
