"""qc-ports options forms: stance to spreads, proxy IV model, indicators and the registry (synthetic)."""
import dataclasses
import json
import math
import random
from datetime import date
from pathlib import Path

import pytest

from strategies.qc_ports import data as qd
from strategies.qc_ports import forms as fm
from strategies.qc_ports import forms_library as fl
from strategies.qc_ports import options as om
from strategies.qc_ports.data import Bars
from tests.qc_ports_synthetic import VIX_FOR_20, market, trading_days

ROOT = Path(__file__).resolve().parents[3]
START = "2024-01-02"


def _bars(symbol, closes, *, start=START, adj=None) -> Bars:
    values = tuple(float(close) for close in closes)
    return Bars(symbol, trading_days(start, len(values)), values, values, values, values,
                values if adj is None else tuple(float(value) for value in adj))


def _form(rule, *, symbols=("SPY",), structures=None, entry_only=False) -> fm.Form:
    extra = {} if structures is None else {"structures": structures}
    return fm.Form("t/x", "x", "X", "trend", symbols, rule, None, "Test form.", entry_only=entry_only, **extra)


def _run(sides, closes, *, structures=None, entry_only=False):
    bars = _bars("SPY", closes)
    made = market(closes)
    form = _form(lambda inputs: {"SPY": list(sides)}, structures=structures, entry_only=entry_only)
    return fm.form_trades(form, fm.Inputs({"SPY": bars}, {"SPY": made.iv_index}), {"SPY": made}, start=START)


# --------------------------------------------------------------------------- stance to spreads

def test_a_lasting_long_stance_holds_one_call_spread_after_the_other():
    closes = [100 + 0.2 * day for day in range(200)]
    trades = _run([1] * 200, closes)
    assert {trade.structure for trade in trades} == {"callDebitVertical"}
    assert [trade.trade_id for trade in trades] == list(range(1, len(trades) + 1))
    assert trades[0].entry_index == 1
    assert all(trade.exit_reason == "expiry" for trade in trades[:-1])
    # The next spread opens the bar after the last one closed: its signal bar is the exit bar.
    assert [later.entry_index - earlier.exit_index for earlier, later in zip(trades, trades[1:])] == [1] * (len(trades) - 1)


def test_the_spread_closes_at_the_close_after_the_stance_ends():
    sides = [0] * 5 + [1] * 10 + [0] * 45
    trades = _run(sides, [100.0] * 60)
    assert len(trades) == 1
    assert (trades[0].entry_index, trades[0].exit_index, trades[0].exit_reason) == (6, 16, "signal")


def test_an_entry_only_form_holds_the_spread_after_the_stance_ended():
    sides = [0] * 5 + [1] + [0] * 94 + [1] * 2 + [0] * 18
    trades = _run(sides, [100 + 0.2 * day for day in range(120)], entry_only=True)
    assert [(trade.entry_index, trade.exit_reason) for trade in trades] == [(6, "expiry"), (101, "end")]
    assert trades[0].exit_date == trades[0].expiry


def test_an_entry_only_form_takes_no_second_spread_while_one_is_open():
    sides = [0] * 5 + [1] + [0] * 9 + [1] + [0] * 104
    trades = _run(sides, [100 + 0.2 * day for day in range(120)], entry_only=True)
    assert [trade.entry_index for trade in trades] == [6]


def test_a_short_stance_holds_the_put_spread_and_a_flat_stance_nothing():
    sides = [0] * 5 + [-1] * 10 + [0] * 45
    trades = _run(sides, [100.0] * 60)
    assert [trade.structure for trade in trades] == ["putDebitVertical"]
    assert _run([0] * 60, [100.0] * 60) == ()


def test_a_losing_spread_is_cut_three_days_before_expiry():
    closes = [100.0] * 5 + [100 - 0.3 * day for day in range(115)]
    trades = _run([1] * 120, closes)
    assert trades[0].exit_reason == "ownerLoserCut"
    assert trades[0].exit_date < trades[0].expiry


def test_a_side_can_hold_two_structures_at_once():
    condor = {1: ({"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.16,
                   "widthSigma": 0.5, "maxLossPct": 1},
                  {"structure": "callCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.16,
                   "widthSigma": 0.5, "maxLossPct": 1})}
    trades = _run([1] * 20 + [0] * 60, [100.0] * 80, structures=condor)
    assert [trade.structure for trade in trades] == ["putCreditVertical", "callCreditVertical"]
    assert trades[0].entry_date == trades[1].entry_date


def test_raw_factors_are_the_product_of_the_later_split_ratios():
    dates = trading_days(START, 6)
    factors = fm.raw_factors(dates, {dates[2]: 4.0, dates[4]: 0.5})
    assert factors == [2.0, 2.0, 0.5, 0.5, 1.0, 1.0]
    assert fm.raw_factors(dates, {}) == [1.0] * 6
    assert fm.raw_factors(dates, {"2030-01-02": 3.0}) == [3.0] * 6


def test_a_spread_is_priced_at_the_raw_price_of_its_entry_day():
    closes = [30 + 0.01 * day for day in range(140)]
    bars = _bars("SPY", closes)
    made = market(closes)
    form = _form(fm.always_on)
    inputs = fm.Inputs({"SPY": bars}, {"SPY": made.iv_index})
    # A 10-for-1 split on bar 30: the bars before it are split-adjusted from about 300 to about 30.
    factors = fm.raw_factors(bars.dates, {bars.dates[30]: 10.0})
    adjusted = fm.form_trades(form, inputs, {"SPY": made}, start=START)
    raw = fm.form_trades(form, inputs, {"SPY": made}, start=START, factors={"SPY": factors})
    assert adjusted[0].long_strike == pytest.approx(30, abs=1) and raw[0].long_strike == pytest.approx(300, abs=5)
    assert raw[0].entry_price == pytest.approx(10 * adjusted[0].entry_price, rel=0.15)
    # The split falls inside the first spread: it runs to its expiry as without the split.
    assert (raw[0].entry_date, raw[0].exit_date, raw[0].exit_reason) == (
        adjusted[0].entry_date, adjusted[0].exit_date, adjusted[0].exit_reason)
    assert raw[0].exit_index > 30
    # After the split the raw price is the adjusted price.
    assert raw[-1].entry_index > 30 and raw[-1].long_strike == pytest.approx(31, abs=1.5)
    with pytest.raises(ValueError, match="raw factors for 140 bars"):
        fm.form_trades(form, inputs, {"SPY": made}, start=START, factors={"SPY": factors[:-1]})


def test_a_spread_the_strike_grid_or_the_fee_floor_decides_is_not_opened():
    normal = _run([1] * 60, [100.0] * 60)[0]
    assert not fm.degenerate(normal, 100.0)
    assert fm.degenerate(dataclasses.replace(normal, width=1.0), 100.0)
    assert not fm.degenerate(dataclasses.replace(normal, width=1.0), 20.0)
    assert fm.degenerate(dataclasses.replace(normal, premium=0.012), 100.0)
    # At 3.00 the one-sigma width is one 0.50 strike step.
    assert _run([1] * 60, [3.0] * 60) == ()


def test_no_trade_before_the_start_date_or_before_the_first_iv_value():
    closes = [100.0] * 120
    bars = _bars("SPY", closes)
    made = market(closes, ivs=[None] * 30 + [VIX_FOR_20] * 90)
    form = _form(fm.always_on)
    inputs = fm.Inputs({"SPY": bars}, {"SPY": made.iv_index})
    assert fm.form_trades(form, inputs, {"SPY": made}, start=START)[0].entry_index == 31
    late = fm.form_trades(form, inputs, {"SPY": made}, start=bars.dates[50])
    assert late[0].entry_index == 51


def test_a_stance_is_refused_when_it_does_not_fit_the_form():
    bars = _bars("SPY", [100.0] * 10)
    inputs = fm.Inputs({"SPY": bars, "QQQ": bars}, {})
    with pytest.raises(ValueError, match="not a symbol of the form"):
        fm.stance_of(_form(lambda _: {"QQQ": [0] * 10}), inputs)
    with pytest.raises(ValueError, match="stance values for 10 bars"):
        fm.stance_of(_form(lambda _: {"SPY": [0] * 9}), inputs)
    with pytest.raises(ValueError, match="sides without a structure"):
        fm.stance_of(_form(lambda _: {"SPY": [2] * 10}), inputs)
    with pytest.raises(ValueError, match="different dates"):
        fm.form_trades(_form(fm.always_on), fm.Inputs({"SPY": bars}, {}), {"SPY": market([100.0] * 11)}, start=START)


# --------------------------------------------------------------------------- proxy IV and cost model

def _wave(count, daily_move):
    closes = [100.0]
    for day in range(1, count):
        closes.append(closes[-1] * (1 + daily_move * (1 if day % 2 else -1)))
    return closes


def test_proxy_iv_index_is_the_geometric_mean_of_the_two_estimates():
    calm, wild = _bars("SPY", _wave(100, 0.01)), _bars("XLK", _wave(100, 0.02))
    index = dict.fromkeys(calm.dates, 20.0)
    proxy = fm.proxy_iv_index(wild, calm, index)
    assert min(proxy) == calm.dates[fm.RV_WINDOW]
    day = calm.dates[-1]
    own, base = fm._realized(wild)[day], fm._realized(calm)[day]
    assert own / base == pytest.approx(2.0, rel=1e-3)
    assert proxy[day] == pytest.approx(math.sqrt(20.0 * (own / base) * fm.RV_PREMIUM * own))


def test_proxy_iv_index_holds_the_ratio_in_its_range_and_skips_missing_inputs():
    calm, wild = _bars("SPY", _wave(100, 0.001)), _bars("XLK", _wave(100, 0.02))
    index = dict.fromkeys(calm.dates[:-1], 20.0)
    proxy = fm.proxy_iv_index(wild, calm, index)
    assert calm.dates[-1] not in proxy
    day = calm.dates[-2]
    assert proxy[day] == pytest.approx(math.sqrt(20.0 * fm.RATIO_RANGE[1] * fm.RV_PREMIUM * fm._realized(wild)[day]))
    assert fm.proxy_iv_index(_bars("XLK", [100.0] * 100), calm, index) == {}


def test_dividend_yield_is_the_total_return_drift_over_the_price_drift():
    count = 2 * fm.TRADING_DAYS
    closes = [100.0] * count
    adj = [100.0 * math.exp(0.03 * day / fm.TRADING_DAYS) for day in range(count)]
    assert fm.dividend_yield(_bars("KO", closes, adj=adj)) == pytest.approx(0.03, rel=0.01)
    assert fm.dividend_yield(_bars("KO", closes)) == 0.0
    assert fm.dividend_yield(_bars("KO", closes, adj=[100.0 * math.exp(day / 100) for day in range(count)])) == 0.06


def test_proxy_symbols_are_in_the_tables_only_inside_the_block():
    with fm.proxy_symbols({"XLK": fm.EQUITY}, {"XLK": 0.01}):
        assert qd.IV_INDEX["XLK"] == "XLK:IVX"
        assert om.atm_iv("XLK:IVX", 20.0) == pytest.approx(0.18)
        assert (om.HALF_SPREAD_PCT["XLK"], om.SKEW["XLK"], om.DIVIDEND_YIELD["XLK"]) == (0.03, -0.25, 0.01)
    for table in (qd.IV_INDEX, om.HALF_SPREAD_PCT, om.SKEW, om.DIVIDEND_YIELD):
        assert "XLK" not in table
    assert "XLK:IVX" not in om.ATM_FACTOR


def test_proxy_symbols_refuse_a_symbol_that_has_a_model():
    with pytest.raises(ValueError, match="Already in the symbol tables"):
        with fm.proxy_symbols({"SPY": fm.EQUITY}, {}):
            pass
    assert om.HALF_SPREAD_PCT["SPY"] == 0.01


def test_a_proxy_symbol_is_priced_by_the_option_book():
    closes = [50 + 0.1 * day for day in range(150)]
    bars = _bars("XLK", closes)
    irx = dict.fromkeys(bars.dates, 4.0)
    made = fm.proxy_market(bars, dict.fromkeys(bars.dates[10:], 25.0), irx)
    assert made.iv_index[:10] == (None,) * 10 and made.rate[0] == 0.04
    form = _form(fm.always_on, symbols=("XLK",))
    with fm.proxy_symbols({"XLK": fm.EQUITY}, {"XLK": 0.01}):
        trades = fm.form_trades(form, fm.Inputs({"XLK": bars}, {"XLK": made.iv_index}), {"XLK": made}, start=START)
    assert trades[0].symbol == "XLK" and trades[0].entry_index == 11


# --------------------------------------------------------------------------- indicators

def test_moving_averages():
    assert fm.sma([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5]
    assert fm.ema([1, 2, 3], 2) == [None, pytest.approx(5 / 3), pytest.approx(23 / 9)]


def test_rsi_is_100_without_a_loss_and_50_for_equal_moves_or_no_move():
    assert fm.rsi([1, 2, 3, 4], 2) == [None, None, 100.0, 100.0]
    assert fm.rsi([5, 5, 5, 5], 2) == [None, None, 50.0, 50.0]
    assert fm.rsi([10, 11, 10, 11, 10], 2)[2] == pytest.approx(50.0)
    assert fm.rsi([10, 11, 10, 11, 10], 2)[3] == pytest.approx(75.0)


def test_rolling_windows_and_changes():
    assert fm.highest([1, 3, 2, 0], 2) == [None, 3, 3, 2]
    assert fm.lowest([1, 3, 2, 0], 2) == [None, 1, 2, 0]
    assert fm.pct_change([100, None, 110, 121], 2) == [None, None, pytest.approx(0.1), None]
    assert fm.rolling_stdev([1, 3, None, 5, 5], 2) == [None, 1.0, None, None, 0.0]


def test_period_ends_are_known_from_the_date_alone():
    dates = ["2024-03-27", "2024-03-28", "2024-04-01", "2024-04-05", "2024-04-30"]
    # 2024-03-29 is Good Friday: the 28th is the last session of its week, month and quarter.
    assert fm.period_ends(dates, "month") == [False, True, False, False, True]
    assert fm.period_ends(dates, "quarter") == [False, True, False, False, False]
    assert fm.period_ends(dates, "week") == [False, True, False, True, False]
    assert fm.period_ends(dates[:2], "month") == [False, True]
    assert fm.next_session(date(2024, 3, 28)) == date(2024, 4, 1)


def test_adjusted_scales_the_bars_to_total_return_prices():
    bars = Bars("KO", ("2024-01-02", "2024-01-03"), (10.0, 20.0), (12.0, 22.0), (8.0, 18.0), (10.0, 20.0), (5.0, 20.0))
    made = fm.adjusted(bars)
    assert (made.open, made.high, made.low, made.close) == ((5.0, 20.0), (6.0, 22.0), (4.0, 18.0), (5.0, 20.0))


def test_a_panel_is_the_union_calendar_and_maps_back_to_each_symbol():
    early, late = _bars("AAA", [1, 2, 3, 4]), _bars("BBB", [7, 8], start=trading_days(START, 3)[2])
    inputs = fm.Inputs({"AAA": early, "BBB": late}, {})
    made = fm.panel(inputs, ("AAA", "BBB"))
    assert made.dates == early.dates
    assert made.close["BBB"] == (None, None, 7.0, 8.0)
    assert fm.from_panel(inputs, made.dates, {"AAA": [0, 1, 1, 0], "BBB": [0, 0, -1, 1]}) == {
        "AAA": [0, 1, 1, 0], "BBB": [-1, 1]}


# --------------------------------------------------------------------------- registry

OTHER_SLUGS = ("151-4-1-sector-momentum-rotation", "long-calendar-spread", "quantlab-zakamulin-2013-sma-timing",
               "pairs-trading-divergence", "bridgingcycles-short-strangle")
# QuantJourney strategies that got their options form in the allocation study (run.py QJ_DAILY).
QJ_WITH_FORM = ("O01", "O02", "O06", "O12", "O13", "O18", "W01", "W03")
LEADERS = ("AAA", "BBB", "CCC")


def test_the_library_list_is_the_quantjourney_strategies_without_a_form_plus_five():
    library = json.loads((ROOT / "research/backtests/quantjourney/library.json").read_text())["strategies"]
    quantjourney = [item["slug"] for item in library if item["id"][0] in "OW" and not item["id"].startswith("WF")
                    and item["id"] not in QJ_WITH_FORM]
    assert len(quantjourney) == 37
    assert sorted(fl.LIBRARY_SLUGS) == sorted([*quantjourney, *OTHER_SLUGS])


def test_every_library_strategy_has_one_form_or_one_reason():
    with_form = [form.slug for form in fl.STRATEGY_FORMS]
    without = [item.slug for item in fl.NOT_RUN]
    assert sorted([*with_form, *without]) == sorted(fl.LIBRARY_SLUGS)
    assert len(with_form) == 36 and len(without) == 6
    assert all(item.reason.endswith(".") for item in fl.NOT_RUN)


def test_study_forms_have_unique_keys_and_a_baseline_on_the_same_universe():
    forms = fl.study_forms(LEADERS)
    keys = [form.key for form in forms]
    assert len(set(keys)) == len(keys) == 36 + 2 + len(fl.BASELINE_UNIVERSES) + 1
    by_key = {form.key: form for form in forms}
    for form in forms:
        assert form.keeps.endswith(".") and form.sleeve
        if form.baseline is not None:
            assert set(by_key[form.baseline].symbols) == set(form.symbols)
            assert by_key[form.baseline].rule is fm.always_on
    assert by_key["leaders/dip"].symbols == LEADERS == by_key[fl.LEADERS_BASELINE].symbols


def test_study_forms_refuse_a_form_whose_universe_is_not_its_baseline_universe(monkeypatch):
    odd = fm.Form("t/odd", "odd", "Odd", "trend", ("SPY", "QQQ"), fm.always_on, "base/spy", "Test form.")
    monkeypatch.setattr(fl, "STRATEGY_FORMS", (odd,))
    with pytest.raises(ValueError, match="not the universe of base/spy"):
        fl.study_forms(LEADERS)
    monkeypatch.setattr(fl, "STRATEGY_FORMS", (fm.Form("t/odd", "odd", "Odd", "trend", ("SPY",), fm.always_on,
                                                         "base/none", "Test form."),))
    with pytest.raises(ValueError, match="No baseline universe"):
        fl.study_forms(LEADERS)


def _random_inputs(symbols, count, seed) -> fm.Inputs:
    """Random-walk bars with a wide range of moves; some symbols start later than the others."""
    rng = random.Random(seed)
    bars, index = {}, {}
    for number, symbol in enumerate(sorted(symbols)):
        size = count - (40 if number % 4 == 3 else 0)
        dates = trading_days(START, count)[count - size:]
        close, opens, highs, lows, closes = 100.0, [], [], [], []
        for _ in range(size):
            open_ = close * (1 + rng.gauss(0, 0.004))
            close = open_ * (1 + rng.gauss(0.0002, 0.02))
            opens.append(open_)
            closes.append(close)
            highs.append(max(open_, close) * (1 + abs(rng.gauss(0, 0.005))))
            lows.append(min(open_, close) * (1 - abs(rng.gauss(0, 0.005))))
        adj = [value * (0.9 + 0.1 * position / size) for position, value in enumerate(closes)]
        bars[symbol] = Bars(symbol, dates, tuple(opens), tuple(highs), tuple(lows), tuple(closes), tuple(adj))
        index[symbol] = tuple(None if position < 5 else 15 + 20 * rng.random() for position in range(size))
    return fm.Inputs(bars, index)


def _cut(inputs: fm.Inputs, last_day: str) -> fm.Inputs:
    bars, index = {}, {}
    for symbol, full in inputs.bars.items():
        size = sum(1 for day in full.dates if day <= last_day)
        bars[symbol] = Bars(symbol, *(column[:size] for column in (full.dates, full.open, full.high, full.low,
                                                                    full.close, full.adj_close)))
        index[symbol] = tuple(inputs.iv_index[symbol][:size])
    return fm.Inputs(bars, index)


@pytest.mark.parametrize("form", fl.study_forms(LEADERS), ids=lambda form: form.key)
def test_no_rule_reads_a_bar_after_the_day_of_its_stance(form):
    count = 700
    inputs = _random_inputs(form.symbols, count, seed=7)
    full = fm.stance_of(form, inputs)
    assert set(full) <= set(form.symbols)
    days = trading_days(START, count)
    for size in (260, 431, 580, 699):
        cut = _cut(inputs, days[size - 1])
        part = fm.stance_of(form, cut)
        for symbol, sides in part.items():
            assert sides == full[symbol][:len(sides)], f"{form.key} {symbol} changes with later bars (cut {size})"
