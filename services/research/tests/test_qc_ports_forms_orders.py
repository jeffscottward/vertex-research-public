"""qc-ports options forms of the QuantJourney order strategies: the fill rules, the bar timing and no look-ahead."""
import itertools
import random

import pytest

from strategies.qc_ports import forms
from strategies.qc_ports import forms_orders as fo
from strategies.qc_ports.data import Bars

KEYS = ["qj/O03", "qj/O04", "qj/O05", "qj/O07", "qj/O08", "qj/O09", "qj/O10", "qj/O11", "qj/O14"]


def make_bars(rows, symbol="SPY"):
    """Bars from (open, high, low, close) rows; the adjusted close is the close."""
    dates = tuple(f"d{index:05d}" for index in range(len(rows)))
    opens, highs, lows, closes = (tuple(float(row[column]) for row in rows) for column in range(4))
    return Bars(symbol, dates, opens, highs, lows, closes, closes)


def flat(count, level=100.0):
    return [(level, level, level, level)] * count


def prefix(bars, count):
    return Bars(bars.symbol, *(column[:count] for column in (bars.dates, bars.open, bars.high, bars.low, bars.close,
                                                              bars.adj_close)))


def random_bars(seed, count=700, symbol="SPY"):
    """A walk with calm and wild stretches and gaps, so that every rule enters and exits."""
    rng = random.Random(seed)
    rows, close = [], 100.0
    for index in range(count):
        scale = 0.03 if (index // 60) % 2 else 0.008
        drift = 0.002 if (index // 150) % 2 == 0 else -0.002
        open_ = close * (1 + rng.gauss(0, scale / 2))
        close = open_ * (1 + drift + rng.gauss(0, scale))
        high = max(open_, close) * (1 + abs(rng.gauss(0, scale / 2)))
        low = min(open_, close) * (1 - abs(rng.gauss(0, scale / 2)))
        rows.append((open_, high, low, close))
    return make_bars(rows, symbol)


# --------------------------------------------------------------------------- fill rules

@pytest.mark.parametrize(("order", "bar", "price"), [
    (fo.Order(fo.MARKET, True), (101, 105, 99), 101),
    # buy limit: low at or under the limit, at min(open, limit)
    (fo.Order(fo.LIMIT, True, limit=98), (100, 101, 98), 98),
    (fo.Order(fo.LIMIT, True, limit=98), (97, 99, 96), 97),
    (fo.Order(fo.LIMIT, True, limit=98), (100, 101, 98.01), None),
    # sell limit mirrors
    (fo.Order(fo.LIMIT, False, limit=103), (100, 103, 99), 103),
    (fo.Order(fo.LIMIT, False, limit=103), (104, 105, 103.5), 104),
    (fo.Order(fo.LIMIT, False, limit=103), (100, 102.99, 99), None),
    # buy stop: high at or over the stop, at max(open, stop)
    (fo.Order(fo.STOP, True, stop=102), (100, 102, 99), 102),
    (fo.Order(fo.STOP, True, stop=102), (103, 104, 102.5), 103),
    (fo.Order(fo.STOP, True, stop=102), (100, 101.99, 99), None),
    # sell stop mirrors
    (fo.Order(fo.STOP, False, stop=96), (100, 101, 96), 96),
    (fo.Order(fo.STOP, False, stop=96), (95, 97, 94), 95),
    (fo.Order(fo.STOP, False, stop=96), (100, 101, 96.01), None),
    # OCO legs are a limit or a stop
    (fo.Order(fo.OCO, True, limit=98), (100, 101, 97), 98),
    (fo.Order(fo.OCO, True, stop=102), (100, 103, 99), 102),
    # buy stop-limit: stop reached and max(open, stop) within the limit
    (fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102), (100, 101.5, 99), 101),
    (fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102), (101.5, 103, 101.2), 101.5),
    (fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102), (100, 100.9, 99), None),
    # ... a gap over the limit that never comes back does not fill
    (fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102), (103, 104, 102.5), None),
    # ... upstream: a gap over the limit that comes back to it within the bar fills at the limit
    (fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102), (103, 104, 101.9), 102),
    # sell stop-limit mirrors
    (fo.Order(fo.STOP_LIMIT, False, stop=96, limit=95.5), (100, 100, 95.8), 96),
    (fo.Order(fo.STOP_LIMIT, False, stop=96, limit=95.5), (95.7, 95.9, 95), 95.7),
    (fo.Order(fo.STOP_LIMIT, False, stop=96, limit=95.5), (95, 95.4, 94), None),
    (fo.Order(fo.STOP_LIMIT, False, stop=96, limit=95.5), (95, 95.6, 94), 95.5),
])
def test_fill_price_of_one_bar(order, bar, price):
    assert fo.fill_price(order, *map(float, bar)) == price


def test_stop_limit_stays_armed_as_a_limit_order_on_later_bars():
    buy = fo.Order(fo.STOP_LIMIT, True, stop=101, limit=102)
    assert fo.fill_price(buy, 103.0, 104.0, 102.5) is None
    assert buy.armed == 102
    assert fo.fill_price(buy, 100.0, 100.5, 99.0) == 100.0  # under the stop again: fills at the open, as a limit does
    sell = fo.Order(fo.STOP_LIMIT, False, stop=96, limit=95.5)
    assert fo.fill_price(sell, 95.0, 95.4, 94.0) is None
    assert fo.fill_price(sell, 94.0, 95.0, 93.0) is None  # still under the limit
    assert fo.fill_price(sell, 95.0, 96.0, 94.5) == 95.5


def test_trailing_stop_follows_highs_and_reads_the_high_of_the_bar_first():
    order = fo.Order(fo.TRAIL, False, trail_pct=0.1)
    assert fo.fill_price(order, 100.0, 100.0, 95.0) is None  # anchor 100, stop 90
    assert fo.fill_price(order, 100.0, 120.0, 109.0) is None  # anchor 120, stop 108
    assert order.anchor == 120
    assert fo.fill_price(order, 110.0, 110.0, 109.0) is None  # the anchor never falls
    assert fo.fill_price(order, 110.0, 111.0, 107.0) == 108.0
    gap = fo.Order(fo.TRAIL, False, trail_pct=0.1, anchor=120.0)
    assert fo.fill_price(gap, 105.0, 106.0, 104.0) == 105.0  # gap under the stop: at the open
    wide = fo.Order(fo.TRAIL, False, trail_pct=0.1)
    assert fo.fill_price(wide, 100.0, 120.0, 107.0) == 100.0  # high of the same bar sets the stop at 108


def test_trailing_stop_limit_arms_at_the_stop_with_the_limit_below():
    order = fo.Order(fo.TRAIL_LIMIT, False, trail_amount=4.0, offset=0.5, anchor=100.0)
    assert fo.fill_price(order, 99.0, 99.0, 97.0) is None  # stop 96 not reached
    assert fo.fill_price(order, 95.0, 95.2, 94.0) is None  # reached, limit 95.5 not: armed
    assert order.armed == 95.5
    assert fo.fill_price(order, 97.0, 98.0, 96.0) == 97.0  # a limit sell from now on: at max(open, limit)
    same_bar = fo.Order(fo.TRAIL_LIMIT, False, trail_amount=4.0, offset=0.5, anchor=100.0)
    assert fo.fill_price(same_bar, 98.0, 98.0, 95.0) == 96.0  # reference is min(open, stop)
    buy = fo.Order(fo.TRAIL_LIMIT, True, trail_amount=4.0, offset=0.5)
    assert fo.fill_price(buy, 100.0, 102.9, 99.0) is None  # anchor 99 (lows), stop 103 not reached
    assert fo.fill_price(buy, 100.0, 103.0, 99.5) == 103.0  # reached: limit 103.5, reference max(open, stop)
    assert buy.armed == 103.5


# --------------------------------------------------------------------------- bar timing

def test_an_order_is_matched_from_the_bar_after_the_signal_bar():
    """O14 on a flat 100: the pair (98 / 102) is submitted at the close of bar 4 (the fifth bar)."""
    spec = fo.SPECS["qj/O14"]
    rows = flat(30)
    rows[4] = (100, 103, 97, 100)  # the signal bar itself reaches both legs: no fill
    assert fo.run(make_bars(rows), spec) == [0] * 30
    rows[5] = (100, 103, 100, 100)  # the stop leg fills on bar 5
    # the position is first seen on bar 5 (count 6); market sell at the close of count 16 = bar 15
    assert fo.run(make_bars(rows), spec) == [0] * 5 + [1] * 10 + [0] * 15


def test_oco_limit_leg_wins_a_bar_that_reaches_both_and_cancels_the_stop_leg():
    spec = fo.Spec("clock", fo.OCO, ("enter", "target"), limit_pct=0.98, stop_pct=1.02, valid=5, every=5,
                   target=(1.03, 50))
    rows = flat(12)
    rows[5] = (100, 103, 97, 100)  # both legs; entry at 98 (limit) -> target 100.94, at 102 it would be 105.06
    rows[7] = (100, 101, 100, 100)
    assert fo.run(make_bars(rows), spec) == [0] * 5 + [1, 1] + [0] * 5
    rows[5] = (100, 103, 99, 100)  # the stop leg only: entry 102, target 105.06 is not reached
    assert fo.run(make_bars(rows), spec) == [0] * 5 + [1] * 7


def test_entry_order_expires_after_its_bars():
    spec = fo.Spec("clock", fo.LIMIT, ("enter",), limit_pct=0.98, valid=2, every=4)
    rows = flat(12)  # limit 98 submitted at bar 3, matched against bars 4 and 5, next submitted at bar 7
    rows[6] = (100, 100, 97, 100)
    assert fo.run(make_bars(rows), spec) == [0] * 12
    rows[5] = (100, 100, 97, 100)
    assert fo.run(make_bars(rows), spec) == [0] * 5 + [1] * 7


def test_market_orders_count_from_their_signal_bar_and_the_trail_uses_highs():
    spec = fo.Spec("clock", fo.MARKET, ("enter", "protect"), protect=(fo.TRAIL, 0.1, None), every=7)
    rows = flat(13, 110.0)  # market buy at the close of bar 6, filled at the open of 7, trail submitted at 7
    rows[8] = (110, 120, 109, 110)  # anchor 120 -> stop 108 (on closes it would stay at 99)
    rows[9] = (110, 110, 107, 110)
    assert fo.run(make_bars(rows), spec) == [0] * 6 + [1, 1, 1] + [0] * 4
    rows[8] = (110, 110, 109, 110)  # without the high the stop stays at 99
    assert fo.run(make_bars(rows), spec) == [0] * 6 + [1] * 7


def test_exit_and_new_entry_never_share_a_bar():
    """After the exit fills on a bar, the entry order of that close is matched from the next bar."""
    spec = fo.Spec("clock", fo.LIMIT, ("enter", "target"), limit_pct=0.99, valid=1, target=(1.01, 1))
    rows = flat(8)
    rows[1] = (100, 100, 99, 100)  # entry 99 (limit of bar 0); target 99.99 submitted at bar 1
    rows[2] = (100, 100, 98.5, 100)  # target fills at the open; the low would also fill a buy limit at 99
    rows[3] = (100, 100, 99, 100)  # the limit of bar 2 fills here
    assert fo.run(make_bars(rows), spec) == [0, 1, 0, 1, 0, 0, 0, 0]


def test_breakout_reads_the_twenty_closes_before_the_bar():
    rows = flat(21) + [(100, 100, 100, 100), (100, 100.3, 100, 100)] + flat(20)
    # first order at bar 21: stop round(100 * 1.002, 2) = 100.2, reached on bar 22; 10 bars later the market sell
    stance = fo.run(make_bars(rows), fo.SPECS["qj/O05"])
    assert stance == [0] * 22 + [1] * 10 + [0] * 11
    # O07: the same stop with the limit at round(100.2 * 1.004, 2) = 100.6. A gap over it does not fill on
    # that bar; the armed order fills as a limit on bar 23 (upstream), and the market sell comes 12 bars later
    rows[22] = (100.7, 100.9, 100.65, 100)
    assert fo.run(make_bars(rows), fo.SPECS["qj/O07"]) == [0] * 23 + [1] * 12 + [0] * 8
    assert fo.run(make_bars(rows), fo.SPECS["qj/O05"]) == stance


# --------------------------------------------------------------------------- forms

def test_forms_are_the_nine_order_strategies_on_core7():
    assert [form.key for form in fo.FORMS] == KEYS == list(fo.SPECS)
    assert len({form.slug for form in fo.FORMS}) == 9
    for form in fo.FORMS:
        assert form.symbols == forms.CORE7
        assert form.baseline == "base/core7"
        assert form.structures is forms.LONG_SHORT or dict(form.structures) == dict(forms.LONG_SHORT)
        assert form.slug.startswith(f"quantjourney-o{form.key[-2:]}-")
    sleeves = {form.key: form.sleeve for form in fo.FORMS}
    assert {key for key, sleeve in sleeves.items() if sleeve == "mean reversion"} == {"qj/O03", "qj/O10"}
    assert {sleeve for key, sleeve in sleeves.items() if key not in ("qj/O03", "qj/O10")} == {"trend"}


def test_every_form_gives_a_long_only_stance_per_symbol():
    bars = {symbol: random_bars(number, 400 + 10 * number, symbol) for number, symbol in enumerate(forms.CORE7)}
    inputs = forms.Inputs(bars, {symbol: [None] * len(bars[symbol]) for symbol in bars})
    for form in fo.FORMS:
        stance = forms.stance_of(form, inputs)
        assert set(stance) == set(forms.CORE7)
        for symbol, sides in stance.items():
            assert set(sides) <= {0, 1}
            assert sides == fo.run(bars[symbol], fo.SPECS[form.key])


@pytest.mark.parametrize("key", KEYS)
def test_rule_enters_and_exits_and_reads_no_later_bar(key):
    bars = random_bars(7)
    full = fo.run(bars, fo.SPECS[key])
    changes = sum(1 for before, after in itertools.pairwise(full) if before != after)
    assert changes >= 6, "the test data must make the rule trade"
    for count in (1, 21, 22, 51, 137, 300, 444, 699):
        assert fo.run(prefix(bars, count), fo.SPECS[key]) == full[:count]


def test_stance_reads_adjusted_prices():
    """A split-like scale of the raw prices with the adjusted close unchanged does not move the stance."""
    bars = random_bars(11, 300)
    scaled = Bars(bars.symbol, bars.dates, *(tuple(value * 2 if index < 150 else value for index, value in
                                                   enumerate(column))
                                             for column in (bars.open, bars.high, bars.low, bars.close)),
                  bars.adj_close)
    for key in KEYS:
        assert fo.run(scaled, fo.SPECS[key]) == fo.run(bars, fo.SPECS[key])
