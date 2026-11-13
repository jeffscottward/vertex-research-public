"""qc-ports options forms of the QuantJourney order strategies: the fill rules, the bar timing and no look-ahead."""
import dataclasses
import itertools
import random
import re

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


# --------------------------------------------------------------------------- one path per rule
# Every path is made so that the stance changes when a parameter of the rule changes. The comments give
# the order prices on the path; `MUTANTS` names, per rule, the changed parameters that must change the stance.

def walk(closes):
    """Rows from closes: the open is the close before; the high and the low are the open or the close."""
    rows, last = [], closes[0]
    for close in closes:
        rows.append((last, max(last, close), min(last, close), close))
        last = close
    return rows


def held(count, *ranges):
    """The stance of `count` bars that is 1 on the bars first..last of every range."""
    out = [0] * count
    for first, last in ranges:
        out[first:last + 1] = [1] * (last - first + 1)
    return out


RSI_50 = [100.0 + index % 2 for index in range(15)]  # 14 changes of +1 and -1 in turn: RSI(14) is 50 on bar 14
SMA_100 = [100.0] * 50  # SMA(20) = SMA(50) = 100 on bar 49; after it SMA(20) > SMA(50) while the closes sum over 100


def path_o03():
    """RSI 43.3 on bar 15 and 37.9 on bar 16: buy limit 94.56 (96 * 0.985) for the bars 17, 18, 19. It fills on
    bar 19; the sell limit 97.40 (94.56 * 1.03) fills on bar 21. RSI 32.9 on bar 22: buy limit 92.59 for the bars
    23, 24, 25, not reached before bar 26, and no new order because RSI is over 40 again."""
    rows = walk([*RSI_50, 98, 96, 96.5, 97, 97, 97, 97, 94, 96, 97, 98, 98, 98])
    rows[17] = (96, 96.5, 94.8, 96.5)  # over the limit
    rows[19] = (97, 97.5, 94.5, 97)  # the fill; the high of the fill bar is over the target, which is not live yet
    rows[20] = (97, 97.3, 97, 97)  # under the target
    rows[21] = (97, 97.4, 97, 97)  # at the target
    rows[26] = (98, 98, 92.5, 98)  # under the second limit, one bar after it expired
    return rows, held(28, (19, 20))


def path_o04():
    """SMA(50) is near 100.1. Bar 49 closes at 101: buy limit 99.99 for the bars 50 and 51, not reached. Bar 51
    closes under the SMA: no new order, so the low of bar 52 fills nothing. Order of bar 52 (99.99) fills on bar
    54; the sell limit 103.99 fills on bar 56. Order of bar 56 (101.97) fills on bar 57. Bar 58 closes under the
    SMA: market sell. Order of bar 60 (99.99) fills on bar 61, which closes under the SMA: sold again at once."""
    rows = walk([*SMA_100[:49], 101, 101, 100, 101, 102, 102, 102, 103, 103, 99, 99, 101, 99.95, 99.95, 99.95])
    rows[49] = (100, 101, 99.9, 101)  # the signal bar is under its own limit: no fill
    rows[50] = (101, 101, 100.5, 101)
    rows[52] = (100, 101, 99.9, 101)
    rows[54] = (102, 102, 99.9, 102)
    rows[55] = (102, 103.9, 102, 102)
    rows[56] = (102, 104, 102, 103)
    rows[57] = (103, 103, 101.9, 103)
    rows[61] = (101, 101, 99.9, 99.95)
    return rows, held(64, (54, 55), (57, 57))


def path_breakout():
    """Bar 5 closes at 104. Order of bar 21: buy stop 104.21 over the closes 1..20, for the bars 22..26, not
    reached. Order of bar 26: the closes 6..25 are 100, bar 26 itself closes at 100.4: buy stop 100.2 (O07: limit
    100.6). Bar 27 opens at 100.55 and fills there."""
    rows = walk([*[100] * 5, 104, *[100] * 20, 100.4, *[100.55] * 17])
    rows[22] = (100, 103, 100, 100)  # over a stop on the closes 12..21
    rows[23] = (100, 104.1, 100, 100)  # over the close of bar 5, under the stop
    rows[27] = (100.55, 100.58, 100.5, 100.55)  # under a stop on the close of bar 26 (100.6)
    return rows


def path_o07():
    """Order of bar 21: stop 100.2, limit 100.6, for the bars 22..26. Bar 22 gaps over the limit: the order is
    armed and never fills. Order of bar 26: stop 100.9 (100.7 * 1.002), limit 101.3. Bar 27 opens at 101.2."""
    rows = walk([*[100] * 22, *[100.7] * 5, *[101.2] * 17])
    rows[22] = (100.7, 100.9, 100.65, 100.7)
    rows[26] = (100.7, 100.95, 100.65, 100.7)  # over the next stop, which is not live yet
    rows[27] = (101.2, 101.25, 101.15, 101.2)
    return rows, held(44, (27, 38))


def path_o08():
    """Cross up on bar 50: bought at the open of bar 51 at 110. Stop-limit sell: stop 105.6, limit 105.05, live
    from bar 52; it fills on bar 53. No new entry while SMA(20) stays over SMA(50). Cross down on bar 55, up on
    bar 56: bought at 110 on bar 57, which crosses down again; the rule places the stop first and misses that
    exit. Bar 58 gaps under the limit and crosses up: armed, not filled. Bar 59 crosses down: market sell."""
    rows = walk([*SMA_100, 110, 110, 110, 106, 82, 80, 110, 90, 104, 95, 95, 95])
    rows[51] = (110, 110, 105, 110)  # under the stop on the fill bar: the stop is not live yet
    rows[52] = (110, 110, 105.7, 110)
    rows[53] = (108, 108, 105.5, 106)
    rows[57] = (110, 110, 90, 90)
    rows[58] = (104, 105, 103, 104)
    rows[59] = (95, 96, 94, 95)
    return rows, held(62, (50, 52), (56, 58))


def path_o09():
    """Cross up on bar 50: bought at 110 on bar 51. Trailing stop 4%, live from bar 52: 107.52 under the high
    112, then 115.2 under the high 120 of bar 53 (close 118); it fills on bar 54. Cross down on bar 56, up on bar
    57: bought on bar 58, which crosses down (missed, the stop goes first). Bar 59 crosses up, bar 60 down."""
    rows = walk([*SMA_100, 110, 110, 110, 118, 116, 70, 65, 110, 90, 102, 98.5, 98.5, 98.5])
    rows[52] = (110, 112, 108, 110)
    rows[53] = (116.5, 120, 116, 118)
    rows[54] = (118, 118, 115.1, 116)
    rows[58] = (110, 110, 90, 90)
    rows[59] = (100, 102, 99, 102)  # stop 97.92
    rows[60] = (102, 102, 98.4, 98.5)
    return rows, held(63, (50, 53), (57, 59))


def path_o10():
    """RSI 38.2 on bar 15, 37.1 on bar 16: bought at the open of bar 17. Trailing stop 5%, live from bar 18:
    95 under the high 100; it fills on bar 19 (RSI 41.8: no new entry). RSI 34.2 on bar 20: bought on bar 21,
    where RSI is 66.8 (missed, the stop goes first). RSI 63.4 on bar 22 and 66.2 on bar 23: market sell."""
    rows = walk([*RSI_50, 96, 95.5, 96, 99, 96, 92, 112, 110, 113, 113, 113])
    rows[17] = (95.5, 96, 95, 96)
    rows[18] = (96, 100, 96, 99)
    rows[19] = (99, 99, 94.9, 96)
    return rows, held(26, (16, 18), (20, 22))


def path_o11():
    """Cross up on bar 50: bought at 110 on bar 51, which closes at 120: trail 4.8 and offset 0.6 (4% and 0.5% of
    that close). Stop 117.2 under the high 122, then 125.2 under the high 130. Bar 54 gaps under the limit 124.6:
    armed, not filled; bar 55 comes back to it. Cross down on bar 59, up on bar 60: bought on bar 61, which closes
    at 90 and crosses down (missed): trail 3.6, offset 0.45. Bar 62: stop 101.4. Bar 63 crosses down."""
    rows = walk([*SMA_100, 110, 120, 120, 128, 124, 124, 60, 60, 60, 90, 110, 90, 105, 98, 98, 98])
    rows[52] = (120, 122, 117.3, 120)  # under a stop of 4% of the entry price (117.6)
    rows[53] = (127, 130, 126, 128)
    rows[54] = (124, 124.5, 123, 124)
    rows[55] = (124, 124.7, 124, 124)
    rows[61] = (110, 110, 90, 90)
    rows[62] = (103, 105, 101.5, 105)
    rows[63] = (98, 99, 97, 98)  # under the limit 100.95: armed, not filled
    return rows, held(66, (50, 54), (60, 62))


def path_o14():
    """Pair of bar 4 (the fifth bar): limit 98, stop 102, for the bars 5..9, not reached. Pair of bar 9 (close
    101): limit 98.98, stop 103.02, for the bars 10..14; the limit fills on bar 14. Market sell on bar 24, the
    tenth bar after it. Pair of bar 29: the stop fills on bar 30; market sell on bar 40."""
    rows = walk([*[100] * 9, *[101] * 34])
    rows[4] = (100, 103, 97, 100)  # the signal bar reaches both legs: no fill
    rows[5] = (100, 101.5, 98.5, 100)
    rows[10] = (101, 102.5, 100, 101)  # over the stop of the expired pair
    rows[14] = (101, 101, 98.98, 101)
    rows[30] = (101, 103.1, 101, 101)
    return rows, held(43, (14, 23), (30, 39))


PATHS = {
    "qj/O03": path_o03(), "qj/O04": path_o04(), "qj/O05": (path_breakout(), held(44, (27, 36))),
    "qj/O07": path_o07(), "qj/O08": path_o08(), "qj/O09": path_o09(), "qj/O10": path_o10(), "qj/O11": path_o11(),
    "qj/O14": path_o14(),
}
MISSED_EXIT = ("enter", "signal_exit", "protect")  # the signal exit before the protective order
NO_EXIT = ("enter", "protect")
MUTANTS = {
    "qj/O03": [("level", 35), ("level", 45), ("limit_pct", 0.98), ("limit_pct", 0.99), ("valid", 2), ("valid", 4),
               ("target", (1.02, 3)), ("target", (1.04, 3))],
    "qj/O04": [("limit_pct", 0.98), ("limit_pct", 0.997), ("valid", 1), ("valid", 3), ("target", (1.03, 5)),
               ("target", (1.05, 5)), ("chain", ("enter", "target", "signal_exit")), ("chain", ("enter", "target"))],
    "qj/O05": [("stop_pct", 1.0), ("stop_pct", 1.01), ("valid", 4), ("valid", 6), ("hold", 9), ("hold", 11)],
    "qj/O07": [("stop_pct", 1.0), ("stop_pct", 1.01), ("cap_pct", 1.002), ("cap_pct", 1.01), ("valid", 4),
               ("valid", 6), ("hold", 11), ("hold", 13)],
    "qj/O08": [("protect", (fo.STOP_LIMIT, 0.97, 0.955)), ("protect", (fo.STOP_LIMIT, 0.957, 0.955)),
               ("protect", (fo.STOP_LIMIT, 0.96, 0.95)), ("chain", MISSED_EXIT), ("chain", NO_EXIT)],
    "qj/O09": [("protect", (fo.TRAIL, 0.03, None)), ("protect", (fo.TRAIL, 0.05, None)), ("chain", MISSED_EXIT),
               ("chain", NO_EXIT)],
    "qj/O10": [("level", 36), ("level", 40), ("exit_level", 60), ("exit_level", 70),
               ("protect", (fo.TRAIL, 0.03, None)), ("protect", (fo.TRAIL, 0.06, None)), ("chain", MISSED_EXIT),
               ("chain", NO_EXIT)],
    "qj/O11": [("protect", (fo.TRAIL_LIMIT, 0.03, 0.005)), ("protect", (fo.TRAIL_LIMIT, 0.05, 0.005)),
               ("protect", (fo.TRAIL_LIMIT, 0.04, 0.001)), ("protect", (fo.TRAIL_LIMIT, 0.04, 0.01)),
               ("chain", MISSED_EXIT), ("chain", NO_EXIT)],
    "qj/O14": [("limit_pct", 0.97), ("limit_pct", 0.99), ("stop_pct", 1.01), ("stop_pct", 1.03), ("valid", 4),
               ("valid", 6), ("hold", 9), ("hold", 11), ("every", 4), ("every", 6)],
}


@pytest.mark.parametrize("key", KEYS)
def test_stance_on_the_path_of_the_rule(key):
    rows, expected = PATHS[key]
    assert fo.run(make_bars(rows), fo.SPECS[key]) == expected


def test_stop_limit_breakout_on_the_path_of_the_stop_breakout():
    """O07 on the O05 path: the same entry (the limit 100.6 is over the open of bar 27), 12 bars instead of 10."""
    assert fo.run(make_bars(path_breakout()), fo.SPECS["qj/O07"]) == held(44, (27, 38))
    assert fo.run(make_bars(PATHS["qj/O07"][0]), fo.SPECS["qj/O05"]) == held(44, (22, 31))  # no limit: the gap fills


@pytest.mark.parametrize(("key", "name", "value"), [(key, *change) for key in KEYS for change in MUTANTS[key]])
def test_every_parameter_of_a_rule_moves_the_stance_on_its_path(key, name, value):
    rows, expected = PATHS[key]
    spec = fo.SPECS[key]
    assert getattr(spec, name) != value
    assert fo.run(make_bars(rows), dataclasses.replace(spec, **{name: value})) != expected


@pytest.mark.parametrize("key", ["qj/O03", "qj/O04"])
def test_validity_of_the_take_profit_limit_cannot_be_seen(key):
    """The rule submits the same sell limit again on the bar the old one expires, so the limit is always live."""
    rows, expected = PATHS[key]
    spec = fo.SPECS[key]
    for bars_valid in (1, 2, 9):
        assert fo.run(make_bars(rows), dataclasses.replace(spec, target=(spec.target[0], bars_valid))) == expected


def test_limit_is_priced_from_the_close_of_the_signal_bar_and_fills_from_the_next_bar():
    """O04: bar 49 is the first bar with SMA(50) and closes over it at 102. Limit: round(102 * 0.99, 2) = 100.98."""
    rows = flat(49) + [(100, 104, 99, 102), (102, 102, 100.99, 102), (102, 102, 100.99, 102), (102, 102, 102, 102)]
    spec = fo.SPECS["qj/O04"]
    assert fo.run(make_bars(rows), spec) == [0] * 53  # not on the signal bar (low 99), not one cent over the limit
    rows[50] = (102, 102, 100.98, 102)
    assert fo.run(make_bars(rows), spec) == held(53, (50, 52))  # the first bar after the signal bar, at the limit
    rows[50], rows[51] = rows[51], rows[50]
    assert fo.run(make_bars(rows), spec) == held(53, (51, 52))  # the second and last bar of the order
    rows[51], rows[52] = (102, 102, 101, 101), (101, 102, 100.98, 102)
    assert fo.run(make_bars(rows), spec) == [0] * 53  # bar 52: the order of bar 49 is gone; that of bar 51 is at 99.99


def test_trend_rule_waits_for_fifty_closes():
    """O04: the closes are over a shorter average from bar 40, but SMA(50) starts on bar 49."""
    rows = walk([*[100] * 40, *[101] * 14])
    rows[45] = (101, 101, 99.9, 101)  # under a limit of 99.99, which no order has yet
    rows[50] = (101, 101, 99.9, 101)  # the order of bar 49 fills
    assert fo.run(make_bars(rows), fo.SPECS["qj/O04"]) == held(54, (50, 53))


def test_order_prices_are_rounded_to_cents():
    """O04: 100.3 * 0.99 = 99.297, the limit is 99.3. A low of 99.3 fills it."""
    rows = flat(49) + [(100, 100.3, 100, 100.3), (100.3, 100.3, 99.3, 100.3), (100.3, 100.3, 100.3, 100.3)]
    assert fo.run(make_bars(rows), fo.SPECS["qj/O04"]) == held(52, (50, 51))


# --------------------------------------------------------------------------- parameter boundaries

def test_o03_enters_under_rsi_40_only():
    """RSI is 39.99999999999999 after a close of 96.75 and 40.00000000000003 after the next float. (This RSI is
    never 40.0 itself: 100 / (1 + rs) has no float result of 60.0 here.) Limit: round(96.75 * 0.985, 2) = 95.3."""
    def stance(close):
        rows = walk([*RSI_50, close, close])
        assert forms.rsi([row[3] for row in rows])[15] == pytest.approx(40, abs=1e-12)
        rows[16] = (close, close, 90, close)
        return fo.run(make_bars(rows), fo.SPECS["qj/O03"])

    assert forms.rsi([*RSI_50, 96.75])[15] < 40 < forms.rsi([*RSI_50, 96.75000000000001])[15]
    assert stance(96.75) == held(17, (16, 16))
    assert stance(96.75000000000001) == [0] * 17


def test_o10_exits_over_rsi_65_only():
    """The path of O10 up to bar 22 (long, stop placed, RSI 63.4), then one close: RSI exactly 65.0, or 65.6."""
    rows = PATHS["qj/O10"][0][:23]
    for close, rsi_23, expected in ((111.6407605424064, 65.0, held(24, (16, 18), (20, 23))),
                                    (112.3, pytest.approx(65.59, abs=0.01), held(24, (16, 18), (20, 22)))):
        path = [*rows, (110, close, 110, close)]
        assert forms.rsi([row[3] for row in path])[23] == rsi_23
        assert fo.run(make_bars(path), fo.SPECS["qj/O10"]) == expected


def test_o05_stop_is_one_fifth_of_a_percent_over_the_prior_high():
    """Closes of 100: the stop is 100.2. A high of exactly 100.2 fills it, a high one cent under it does not."""
    rows = flat(34)
    rows[22] = (100, 100.2, 100, 100)
    assert fo.run(make_bars(rows), fo.SPECS["qj/O05"]) == held(34, (22, 31))
    rows[22] = (100, 100.19, 100, 100)
    assert fo.run(make_bars(rows), fo.SPECS["qj/O05"]) == [0] * 34


def test_sma_50_starts_on_bar_49():
    """A 49-bar average starts on bar 48. O04: the order of bar 48 would fill on bar 49. O08, O09, O11: the cross
    of bar 48 would be a market buy one bar earlier."""
    rows = walk([*[100] * 40, *[101] * 14])
    rows[49] = (101, 101, 99.9, 101)  # under the limit 99.99 of an order of bar 48
    rows[51] = (101, 101, 99.9, 101)  # the order of bar 49 fills on its second and last bar
    assert fo.run(make_bars(rows), fo.SPECS["qj/O04"]) == held(54, (51, 53))
    cross = make_bars(walk([*[100] * 48, *[110] * 4]))  # the first SMA(50) of bar 49 is under SMA(20)
    for key in ("qj/O08", "qj/O09", "qj/O11"):
        assert fo.run(cross, fo.SPECS[key]) == held(52, (49, 51)), key


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


def test_keeps_is_at_most_two_short_sentences():
    for form in fo.FORMS:
        sentences = re.split(r"(?<=[.])\s+", form.keeps)
        assert len(sentences) == 2, form.key
        assert sentences[0].startswith("Keeps ") and sentences[1] == fo.DROPS
        assert max(len(sentence.split()) for sentence in sentences) <= 25, form.key
    for key in ("qj/O05", "qj/O07"):
        keeps = next(form.keeps for form in fo.FORMS if form.key == key)
        assert "the 20 closes before the signal bar" in keeps


KEEPS_NUMBERS = {  # the numbers of the first sentence of `keeps`, in the order of the text
    "qj/O03": "3 1.5 14 40 3", "qj/O04": "2 1 50 4 50", "qj/O05": "5 0.2 20 10", "qj/O07": "5 0.2 20 0.4 12",
    "qj/O08": "20 50 4 4.5", "qj/O09": "20 50 4", "qj/O10": "14 38 5 14 65", "qj/O11": "20 50 4 0.5",
    "qj/O14": "5 5 2 2 10",
}


def test_numbers_in_keeps_are_the_parameters_of_the_rule(monkeypatch):
    for form in fo.FORMS:
        first = form.keeps.removesuffix(fo.DROPS)
        assert " ".join(re.findall(r"\d+(?:\.\d+)?", first)) == KEEPS_NUMBERS[form.key], form.key
    assert fo.FORMS[0].keeps == ("Keeps the 3-bar buy limit 1.5% under the close when RSI(14) < 40 and the sell limit "
                                 "3% over the entry price. " + fo.DROPS)
    # the text follows the parameters
    changed = dataclasses.replace(fo.SPECS["qj/O05"], stop_pct=1.003, valid=4, hold=9)
    monkeypatch.setitem(fo.SPECS, "qj/O05", changed)
    assert re.findall(r"\d+(?:\.\d+)?", fo._keeps("qj/O05")) == ["4", "0.3", "20", "9"]
