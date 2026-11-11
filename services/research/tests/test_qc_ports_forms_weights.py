"""Tests of the QuantJourney rebalance-policy forms and the 151 4.1 form (synthetic bars, no files)."""
from __future__ import annotations

import math
import random
import re
from datetime import date

import pytest

from strategies import sector_rotation
from strategies.qc_ports import forms
from strategies.qc_ports import forms_weights as fw
from strategies.qc_ports.data import Bars
from strategies.qc_ports.forms import MULTI8, SECTOR9, SECTOR11, Inputs
from tests.qc_ports_synthetic import trading_days

START = "2021-01-04"
KEYS = ("qj/O17 qj/W02 qj/W04 qj/W05 qj/W06 qj/W10 qj/W11 qj/W17 qj/W18 qj/W19 qj/W12 qj/W15 qj/W16 qj/W20 "
        "qj/W21 qj/W22 lib/151-4-1").split()
BY_KEY = {form.key: form for form in fw.FORMS}
DAYS = trading_days(START, 800)


def bars(symbol: str, closes, start: str = START) -> Bars:
    column = tuple(float(value) for value in closes)
    return Bars(symbol, trading_days(start, len(column)), column, column, column, column, column)


def inputs(table) -> Inputs:
    return Inputs({symbol: bars(symbol, closes) for symbol, closes in table.items()}, {})


def growth(count: int, rate: float, first: float = 100.0) -> list[float]:
    return [first * (1 + rate) ** index for index in range(count)]


def steps(count: int, *levels: tuple[int, float], first: float = 100.0) -> list[float]:
    """`first` until the bar of the first step; each step (bar, level) holds from its bar on."""
    out, level = [], first
    for index in range(count):
        level = dict(levels).get(index, level)
        out.append(level)
    return out


def walk(symbol: str, count: int) -> list[float]:
    """A seeded random walk with a drift that changes every 120 bars (so rankings and trends change)."""
    source = random.Random(symbol)
    out, level, drift = [], 100.0, 0.0
    for index in range(count):
        if index % 120 == 0:
            drift = source.uniform(-0.002, 0.003)
        level *= 1 + drift + source.gauss(0, 0.012)
        out.append(level)
    return out


def random_inputs(symbols, count: int = 700) -> Inputs:
    """Random walks; XLC and VNQ start 150 sessions late, so the panel has missing closes."""
    table = {}
    for symbol in symbols:
        late = 150 if symbol in ("XLC", "VNQ") else 0
        table[symbol] = bars(symbol, walk(symbol, count - late), DAYS[late])
    return Inputs(table, {})


def cut(full: Inputs, last_day: str) -> Inputs:
    out = {}
    for symbol, data in full.bars.items():
        size = sum(1 for day in data.dates if day <= last_day)
        out[symbol] = Bars(symbol, *(column[:size] for column in (data.dates, data.open, data.high, data.low,
                                                                   data.close, data.adj_close)))
    return Inputs(out, {})


def changes(sides) -> list[int]:
    return [index for index in range(1, len(sides)) if sides[index] != sides[index - 1]]


def month_end_from(first: int) -> int:
    return next(index for index in range(first, len(DAYS) - 1) if DAYS[index][:7] != DAYS[index + 1][:7])


def held(stance, index: int) -> set[str]:
    return {symbol for symbol, sides in stance.items() if sides[index]}


# --------------------------------------------------------------------------- the list of forms

def test_forms_are_the_seventeen_assigned_forms():
    assert [form.key for form in fw.FORMS] == KEYS
    assert len({form.slug for form in fw.FORMS}) == 17
    for form in fw.FORMS[:10]:
        assert (form.symbols, form.baseline) == (MULTI8, "base/multi8")
    for form in fw.FORMS[10:16]:
        assert (form.symbols, form.baseline) == (SECTOR9, "base/sector9")
    library = fw.FORMS[16]
    assert (library.slug, library.name, library.sleeve, library.symbols, library.baseline) == (
        "151-4-1-sector-momentum-rotation", "Sector momentum rotation (151 Strategies 4.1)", "rotation", SECTOR11,
        "base/sector11")
    assert {form.key: form.sleeve for form in fw.FORMS[:16]} == {
        "qj/O17": "rotation", "qj/W02": "trend", "qj/W04": "rotation", "qj/W05": "trend", "qj/W06": "trend",
        "qj/W10": "trend", "qj/W11": "rotation", "qj/W17": "trend", "qj/W18": "rotation", "qj/W19": "trend",
        "qj/W12": "rotation", "qj/W15": "rotation", "qj/W16": "mean reversion", "qj/W20": "trend",
        "qj/W21": "mean reversion", "qj/W22": "trend"}
    assert BY_KEY["qj/W02"].slug == "quantjourney-w02-monthly-drift-etf"
    assert BY_KEY["qj/W02"].name == "QuantJourney W02: Monthly ETF Trend + Drift"


@pytest.mark.parametrize("key", KEYS)
def test_keeps_is_at_most_two_short_sentences(key):
    sentences = re.split(r"(?<=\.)\s+", BY_KEY[key].keeps)
    assert 1 <= len(sentences) <= 2
    assert all(len(sentence.split()) <= 25 and sentence.endswith(".") for sentence in sentences)


def test_keeps_names_the_shares_portfolio_and_the_upstream_differences():
    for key in ("qj/W02", "qj/W10", "qj/W11", "qj/W12"):
        assert "simulated shares portfolio" in BY_KEY[key].keeps
    assert "Upstream as written (`dd < 0.15`) is flat on 11 of every 12 bars." in BY_KEY["qj/W10"].keeps
    assert "flat for 11 bars after a 15% drawdown" in BY_KEY["qj/W10"].keeps
    assert "The tracking-error trigger is inactive, as in the upstream run." in BY_KEY["qj/W11"].keeps


@pytest.fixture(scope="module")
def random_runs():
    """form key -> (inputs, checked stance) on random walks."""
    data = {universe: random_inputs(universe) for universe in (MULTI8, SECTOR9, SECTOR11)}
    return {form.key: (data[form.symbols], forms.stance_of(form, data[form.symbols])) for form in fw.FORMS}


@pytest.mark.parametrize("key", KEYS)
def test_stance_is_valid_and_takes_a_side(random_runs, key):
    _, stance = random_runs[key]
    values = {side for sides in stance.values() for side in sides}
    shorts = key in ("qj/W15", "qj/W16")
    assert values == ({-1, 0, 1} if shorts else {0, 1})


# --------------------------------------------------------------------------- no look-ahead

def cut_days(full: Inputs) -> list[str]:
    """Last days of truncated inputs: a month end, a quarter end, a week end and three other days."""
    days = full.bars["SPY" if "SPY" in full.bars else "XLK"].dates
    month_end = next(index for index in range(300, len(days)) if days[index][:7] != days[index + 1][:7])
    quarter_end = next(index for index in range(300, len(days))
                       if days[index][5:7] in ("03", "06", "09", "12") and days[index][:7] != days[index + 1][:7])
    week_end = next(index for index in range(400, len(days)) if date.fromisoformat(days[index]).weekday() == 4)
    return [days[index] for index in (month_end, quarter_end, week_end, 333, 517, 640)]


@pytest.mark.parametrize("key", KEYS)  # monthly, quarterly, weekly and daily rules
def test_rule_on_truncated_inputs_is_the_prefix_of_the_full_stance(random_runs, key):
    full, stance = random_runs[key]
    form = BY_KEY[key]
    for last_day in cut_days(full):
        short = cut(full, last_day)
        part = forms.stance_of(form, short)
        assert set(part) == set(stance)
        for symbol, sides in part.items():
            assert len(sides) == len(short.bars[symbol]) > 0
            assert sides == stance[symbol][:len(sides)], (key, symbol, last_day)


# --------------------------------------------------------------------------- rebalance bars

def test_period_ends_use_the_nyse_rules_and_no_later_bar():
    days = ["2024-03-27", "2024-03-28", "2024-04-01", "2024-05-30", "2024-05-31", "2024-01-04", "2024-01-05"]
    # 2024-03-29 is Good Friday: the 28th ends the week, the month and the quarter.
    assert forms.period_ends(days, "month") == [False, True, False, False, True, False, False]
    assert forms.period_ends(days, "quarter") == [False, True, False, False, False, False, False]
    assert forms.period_ends(days, "week") == [False, True, False, False, True, False, True]
    assert forms.period_ends(days[:2], "month") == [False, True]
    assert forms.next_session(date(2024, 3, 28)) == date(2024, 4, 1)


def test_period_ends_match_the_bars_of_a_full_calendar():
    by_bars = [DAYS[index][:7] != DAYS[index + 1][:7] for index in range(len(DAYS) - 1)]
    assert forms.period_ends(DAYS, "month")[:-1] == by_bars
    by_data = sector_rotation.month_ends([date.fromisoformat(day) for day in DAYS])
    assert by_data == [index for index, flag in enumerate(by_bars) if flag]


def test_month_starts_count_the_first_bar():
    assert fw.month_starts(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"]) == [True, False, True, False]


# --------------------------------------------------------------------------- the shares portfolio (engine loop)

def book_of(**columns) -> forms.Panel:
    count = len(next(iter(columns.values())))
    return forms.Panel(trading_days(START, count), {symbol: tuple(values) for symbol, values in columns.items()})


def test_weights_drift_between_rebalances_and_not_on_a_rebalance_bar():
    book = book_of(A=growth(6, 0.01), B=[100.0] * 6)
    targets = [{"A": 0.5, "B": 0.45}] * 6
    drifting = fw.shares_book(book, [True] + [False] * 5, targets)
    assert drifting[0] == pytest.approx([0.5, 0.45])
    assert drifting[1] == pytest.approx([0.505 / 1.005, 0.45 / 1.005])
    assert drifting[5][0] > drifting[4][0] > 0.5
    # Daily partial rebalance: both weights are inside the band, both are kept, and a kept weight does not drift.
    frozen = fw.shares_book(book, [True] * 6, targets, fw.Gates(drift=0.10, partial=True))
    assert all(row == pytest.approx([0.5, 0.45]) for row in frozen)


def test_drift_band_rebalances_between_calendar_bars():
    book = book_of(A=[100.0] * 4, B=[100.0] * 4)
    targets = [{"A": 0.5}, {"A": 0.5}, {"A": 0.46, "B": 0.04}, {"B": 0.5}]
    flags = [True, False, False, False]
    assert fw.shares_book(book, flags, targets, fw.Gates(drift=0.05))[2:] == [[0.5, 0.0], [0.0, 0.5]]
    assert fw.shares_book(book, flags, targets)[3] == [0.5, 0.0]


def test_signal_change_rebalances_without_a_calendar():
    book = book_of(A=[100.0] * 4, B=[100.0] * 4)
    targets = [{}, {"A": 0.5}, {"A": 0.505}, {"B": 0.5}]
    rows = fw.shares_book(book, [False] * 4, targets, fw.Gates(signal_change=0.01))
    assert rows == [[0.0, 0.0], [0.5, 0.0], [0.5, 0.0], [0.0, 0.5]]  # a change of 0.005 is no signal change
    assert fw.shares_book(book, [False] * 4, targets) == [[0.0, 0.0]] * 4


def test_breaker_flattens_the_bar_after_a_15_percent_drawdown_and_returns_after_the_cooldown():
    prices = [100.0] * 5 + growth(55, -0.02, first=98.0)
    book = book_of(A=prices)
    flags = [True] + [False] * 59
    targets = [{"A": 0.95}] * 60
    rows = fw.shares_book(book, flags, targets, fw.Gates(drawdown=0.15, cooldown=10))
    # Equity = 0.05 cash + 0.95 x price / 100: below 0.85 at the close of bar 13, read on bar 14.
    equity = [0.05 + 0.95 * price / 100 for price in prices]
    assert next(index for index, value in enumerate(equity) if value < 0.85) == 13
    assert all(row[0] > 0 for row in rows[:14])
    assert rows[14:25] == [[0.0]] * 11  # the bar of the breaker and 10 cooldown bars
    assert rows[25] == [pytest.approx(0.95)]
    # The peak restarts at the equity of bar 24: 0.05 + 0.95 x 0.98^k is below 0.85 after 9 more bars.
    assert all(row[0] > 0 for row in rows[25:35]) and rows[35] == [0.0]
    assert all(row[0] > 0 for row in fw.shares_book(book, flags, targets))


def test_turnover_budget_refuses_a_rebalance():
    book = book_of(A=[100.0] * 6)
    targets = [{"A": 0.95}, {}, {"A": 0.95}, {}, {"A": 0.95}, {"A": 0.95}]
    limited = fw.shares_book(book, [True] * 6, targets, fw.Gates(max_turnover=2.0))
    assert [row[0] for row in limited] == pytest.approx([0.95, 0.0, 0.0, 0.0, 0.0, 0.0])
    free = fw.shares_book(book, [True] * 6, targets)
    assert [row[0] for row in free] == pytest.approx([0.95, 0.0, 0.95, 0.0, 0.95, 0.95])


def test_partial_rebalance_trades_only_the_symbols_outside_the_band():
    book = book_of(A=[100.0] * 5, B=[100.0] * 5)
    targets = [{"A": 0.5, "B": 0.5}, {"A": 0.45, "B": 0.55}, {"A": 0.05, "B": 0.9}, {"B": 0.95}, {"B": 0.5}]
    rows = fw.shares_book(book, [True] * 5, targets, fw.Gates(drift=0.10, partial=True))
    assert rows[0] == pytest.approx([0.5, 0.5])
    assert rows[1] == pytest.approx([0.5, 0.5])  # both within 10 points: nothing traded
    assert rows[2] == pytest.approx([0.05, 0.9])
    assert rows[3] == pytest.approx([0.05, 0.9])  # A keeps 5 points although its target is 0
    assert rows[4] == pytest.approx([0.05, 0.45])  # B takes the target total less what A keeps
    whole = fw.shares_book(book, [True] * 5, targets)
    assert whole[3] == pytest.approx([0.0, 0.95])


def test_shares_book_does_not_trade_a_symbol_without_a_return():
    book = book_of(A=[100.0, 100.0, None, 100.0], B=[100.0] * 4)
    targets = [{"A": 0.5, "B": 0.45}, {"A": 0.5, "B": 0.45}, {"B": 0.95}, {"B": 0.95}]
    rows = fw.shares_book(book, [True] * 4, targets)
    assert rows[2] == pytest.approx([0.5, 0.45])  # A is kept, B gets the target total less A
    assert rows[3] == pytest.approx([0.0, 0.95])
    late = book_of(A=[None, 100.0, 100.0], B=[100.0] * 3)
    rows = fw.shares_book(late, [True] * 3, [{"A": 0.5, "B": 0.45}] * 3)
    # A has no return on its first bar: B takes the whole target total, A is bought one bar later.
    assert rows == [pytest.approx([0.0, 0.95]), pytest.approx([0.0, 0.95]), pytest.approx([0.5, 0.45])]


# --------------------------------------------------------------------------- trend rules (W02, W10, W17)

RATES = dict(zip(MULTI8, (0.0010, 0.0008, 0.0006, 0.0004, 0.0002, -0.0002, -0.0004, -0.0006)))
SECTOR_RATES = dict(zip(SECTOR9, (0.0008, 0.0006, 0.0004, 0.0002, 0.0001, -0.0001, -0.0002, -0.0004, -0.0006)))
# A rise and then a fall: SMA(50) is above SMA(200) from bar 199 and falls below it in the fall.
TURN = growth(260, 0.002) + growth(160, -0.004, first=100 * 1.002 ** 259 * 0.996)


def steady(rates, count: int = 420) -> Inputs:
    return inputs({symbol: growth(count, rate) for symbol, rate in rates.items()})


def trend_inputs() -> Inputs:
    """SPY and GLD follow TURN; the other six ETFs fall on every bar (never in a trend)."""
    return inputs({symbol: TURN if symbol in ("SPY", "GLD") else growth(420, -0.001) for symbol in MULTI8})


def trend_signal(fast: int = 50, slow: int = 200) -> list[int]:
    quick, base = forms.sma(TURN, fast), forms.sma(TURN, slow)
    return [int(base[index] is not None and quick[index] > base[index]) for index in range(len(TURN))]


def test_monthly_trend_with_drift_band_follows_the_sma_signal_of_each_bar():
    signal = trend_signal()
    cross = signal.index(0, 199)
    assert signal[199:cross] == [1] * (cross - 199) and not any(signal[cross:])
    assert not forms.period_ends(DAYS[:420], "month")[cross]  # the cross is inside a month
    assert trend_signal(fast=40).index(0, 199) != cross != trend_signal(slow=180).index(0, 199)
    stance = fw.monthly_trend_drift(trend_inputs())
    # A change of the members moves a weight by 0.285: outside the 5-point band, so it trades on that bar.
    assert stance["SPY"] == stance["GLD"] == signal
    assert all(not any(stance[symbol]) for symbol in MULTI8 if symbol not in ("SPY", "GLD"))


def test_monthly_trend_with_drift_band_also_rebalances_at_month_ends():
    _, rows = fw.monthly_trend_drift.weights(trend_inputs())
    end = month_end_from(230)
    spy = [row[0] for row in rows]
    # SPY and GLD rise together: their weights drift above 0.285 in the month and return to it at the month end.
    assert spy[end] == pytest.approx(0.285) and spy[end - 1] > 0.29 and spy[end + 1] > 0.285


def test_trend_rules_use_the_averages_of_50_and_200_bars():
    data = inputs({symbol: walk(symbol, 700) for symbol in MULTI8})
    book = forms.panel(data, MULTI8)
    signal = {}
    for symbol in MULTI8:
        quick, base = forms.sma(book.close[symbol], 50), forms.sma(book.close[symbol], 200)
        signal[symbol] = [int(base[index] is not None and quick[index] > base[index]) for index in range(700)]
    assert sum(len(changes(sides)) for sides in signal.values()) > 20
    for rule in (fw.monthly_trend_drift, fw.circuit_breaker_trend, fw.vol_target_trend):
        targets = rule.targets(book)
        assert all([int(symbol in row) for row in targets] == signal[symbol] for symbol in MULTI8)
    assert fw.monthly_trend_drift(data) == signal  # the drift band trades on the bar of every change


def test_vol_target_trend_changes_its_members_only_at_month_ends():
    signal = trend_signal()
    cross = signal.index(0, 199)
    first, last = month_end_from(199), month_end_from(cross)
    stance = fw.vol_target_trend(trend_inputs())
    assert stance["SPY"] == stance["GLD"] == [0] * first + [1] * (last - first) + [0] * (420 - last)
    assert first > 199 and last > cross


def test_trend_caps_are_the_caps_of_the_examples():
    book = forms.panel(trend_inputs(), MULTI8)
    two = {"SPY", "GLD"}  # two active ETFs: 1 / 2 is above each cap
    assert fw.monthly_trend_drift.targets(book)[300] == dict.fromkeys(two, 0.30)
    assert fw.circuit_breaker_trend.targets(book)[300] == dict.fromkeys(two, 0.30)
    assert fw.vol_target_trend.targets(book)[300] == dict.fromkeys(two, 0.34)
    assert fw.monthly_trend_drift.gates == fw.Gates(drift=0.05)
    assert fw.vol_target_trend.gates == fw.Gates()


def test_trend_members_change_only_at_month_ends(random_runs):
    full, stance = random_runs["qj/W17"]
    for symbol, sides in stance.items():
        days = full.bars[symbol].dates
        assert changes(sides)
        assert all(days[index][:7] != days[index + 1][:7] for index in changes(sides) if index + 1 < len(days))


def test_circuit_breaker_is_flat_for_11_bars_after_a_15_percent_drawdown():
    # Five bars of -4%: the equity (95% invested) is 14.4% below its peak after four and 17.6% after five.
    rise = growth(300, 0.002)
    crash = growth(5, -0.04, first=rise[-1] * 0.96)
    data = inputs({symbol: rise + crash + [crash[-1]] * 45 for symbol in MULTI8})
    breaker, trend = fw.circuit_breaker_trend(data), fw.vol_target_trend(data)
    first = month_end_from(199)
    assert trend["SPY"] == [0] * first + [1] * (350 - first)  # SMA(50) stays above SMA(200) to the end
    # The breaker reads the close of bar 304 on bar 305. Flat on bars 305 to 315, back on bar 316.
    expected = [0] * first + [1] * (305 - first) + [0] * 11 + [1] * 34
    assert all(breaker[symbol] == expected for symbol in MULTI8)


# --------------------------------------------------------------------------- momentum rules (O17, W04, W11, W18)

def test_monthly_rotation_holds_the_top_three_from_the_first_bar_of_a_month():
    data = steady(RATES)
    stance = fw.monthly_rotation(data)
    days = data.bars["SPY"].dates
    first = next(index for index in range(126, len(days)) if days[index][:7] != days[index - 1][:7])
    for symbol in MULTI8:
        own = int(symbol in ("SPY", "EFA", "EEM"))
        assert stance[symbol] == [0] * first + [own] * (len(days) - first)


def test_monthly_rotation_ranks_the_126_bar_return_on_the_first_bar_of_the_month():
    first = DAYS.index("2022-02-01")
    data = inputs({
        "SPY": steps(300, (first - 125, 150.0)), "EFA": steps(300, (first - 126, 150.0)),
        "EEM": growth(300, 0.0008), "TLT": growth(300, 0.0006), "IEF": growth(300, 0.0004),
        "GLD": growth(300, -0.0005), "DBC": growth(300, -0.0005), "VNQ": growth(300, -0.0005)})
    stance = fw.monthly_rotation(data)
    # January: SPY and EFA +50%, EEM +11%. February: the rise of EFA is 127 bars back, TLT (+8%) is third.
    assert held(stance, first - 1) == {"SPY", "EFA", "EEM"}
    assert held(stance, first) == held(stance, first + 10) == {"SPY", "EEM", "TLT"}


def test_dual_momentum_holds_at_most_two_positive_returns_from_a_quarter_end():
    rates = {**dict.fromkeys(MULTI8, -0.0003), "GLD": 0.0005}
    data = steady(rates)
    stance = fw.dual_momentum(data)
    days = data.bars["SPY"].dates
    first = next(index for index in range(252, len(days) - 1)
                 if days[index][5:7] in ("03", "06", "09", "12") and days[index][:7] != days[index + 1][:7])
    assert stance["GLD"] == [0] * first + [1] * (len(days) - first)
    assert all(not any(stance[symbol]) for symbol in MULTI8 if symbol != "GLD")
    assert fw.dual_momentum.targets(forms.panel(data, MULTI8))[first] == {"GLD": 0.50}  # 1 / 1 is above the cap
    top = fw.dual_momentum(steady(RATES))
    assert [symbol for symbol in MULTI8 if top[symbol][-1]] == ["SPY", "EFA"]


def test_vol_target_momentum_ranks_126_bar_returns_at_month_ends_and_holds_three_positive_ones():
    end = DAYS.index("2022-01-31")  # a Monday: a month end, not a week end, not a quarter end
    before, early = DAYS.index("2021-12-31"), DAYS.index("2021-08-31")
    assert end - 125 < early < end - 60 < before
    # SPY rises 126 bars before `end` (inside the window) and EFA 127 bars before (outside it).
    data = inputs({
        "SPY": steps(300, (end - 125, 150.0)), "EFA": steps(300, (end - 126, 150.0)),
        "EEM": steps(300, (end - 60, 140.0)), "TLT": steps(300, (end - 60, 130.0)),
        "IEF": steps(300, (end - 60, 120.0)), "GLD": [100.0] * 300, "DBC": [100.0] * 300, "VNQ": [100.0] * 300})
    stance = fw.vol_target_momentum(data)
    assert held(stance, early - 1) == set()  # no return of 126 bars is above 0 before the rises
    assert held(stance, early) == {"SPY", "EFA"}  # only two returns are above 0: no third ETF
    assert held(stance, before) == held(stance, end - 1) == {"SPY", "EFA", "EEM"}
    assert held(stance, end) == held(stance, end + 5) == {"SPY", "EEM", "TLT"}
    targets = fw.vol_target_momentum.targets(forms.panel(data, MULTI8))
    assert targets[early] == {"SPY": 0.40, "EFA": 0.40}  # 1 / 2 is above the 40% cap
    assert targets[end] == pytest.approx({"SPY": 1 / 3, "EEM": 1 / 3, "TLT": 1 / 3})


def test_te_cost_gate_momentum_ranks_126_bar_returns_at_quarter_ends_and_holds_three():
    end, before, month = DAYS.index("2022-03-31"), DAYS.index("2021-12-31"), DAYS.index("2022-01-31")
    start = DAYS.index("2021-09-30")
    assert start == end - 126 and before - 60 > end - 126 and before + 5 < month
    data = inputs({
        "SPY": steps(330, (end - 125, 150.0)), "EFA": steps(330, (end - 126, 150.0)),
        "EEM": steps(330, (before - 60, 105.0)), "TLT": steps(330, (before + 5, 130.0)),
        "IEF": steps(330, (before + 5, 120.0)),
        "GLD": growth(330, -0.001), "DBC": growth(330, -0.001), "VNQ": growth(330, -0.001)})
    stance = fw.te_cost_gate_momentum(data)
    targets = fw.te_cost_gate_momentum.targets(forms.panel(data, MULTI8))
    # First quarter end with 126-bar returns: EFA +50%; the next two are returns of 0 (no filter for returns above 0).
    assert held(stance, start - 1) == set() and held(stance, start) == {"SPY", "EFA", "EEM"}
    assert held(stance, before) == {"SPY", "EFA", "EEM"}
    # At the month end TLT is in the top three, but the rule waits for the quarter end.
    assert set(targets[month]) == {"SPY", "EFA", "TLT"}
    assert held(stance, month) == held(stance, end - 1) == {"SPY", "EFA", "EEM"}
    # Quarter end: SPY +50% (126 bars), TLT +30%, IEF +20%, EEM +5%; the rise of EFA is 127 bars back.
    assert held(stance, end) == held(stance, end + 10) == {"SPY", "TLT", "IEF"}
    assert targets[end] == pytest.approx({"SPY": 1 / 3, "TLT": 1 / 3, "IEF": 1 / 3})
    assert fw.te_cost_gate_momentum.targets(forms.panel(steady({**RATES, "EFA": -0.001, "EEM": -0.001}), MULTI8))[
        200] == pytest.approx({"SPY": 1 / 3, "TLT": 1 / 3, "IEF": 1 / 3})


def test_te_cost_gate_momentum_caps_one_name_at_40_percent():
    data = inputs({"SPY": growth(200, 0.001)})
    rule = fw.EngineRule(("SPY",), fw.te_cost_gate_momentum.targets, fw.te_cost_gate_momentum.schedule)
    assert fw.te_cost_gate_momentum.targets(forms.panel(data, ("SPY",)))[150] == {"SPY": 0.40}
    assert rule(data)["SPY"][-1] == 1


def test_te_cost_gate_momentum_skips_a_rebalance_beyond_the_turnover_budget():
    first, second, third, fourth = (DAYS.index(day) for day in ("2021-09-30", "2021-12-31", "2022-03-31", "2022-06-30"))
    one, two, three = {"SPY", "EFA", "EEM"}, {"TLT", "IEF", "GLD"}, {"SPY", "DBC", "VNQ"}
    table = {
        "SPY": steps(390, (100, 150.0), (200, 100.0), (280, 300.0)),
        **dict.fromkeys(("EFA", "EEM"), steps(390, (100, 150.0), (200, 100.0))),
        **dict.fromkeys(("TLT", "IEF", "GLD"), steps(390, (210, 150.0))),
        **dict.fromkeys(("DBC", "VNQ"), steps(390, (280, 180.0)))}
    data = inputs({symbol: table[symbol] for symbol in MULTI8})
    targets = fw.te_cost_gate_momentum.targets(forms.panel(data, MULTI8))
    assert [set(targets[index]) for index in (first, second, third, fourth)] == [one, two, three, three]
    stance = fw.te_cost_gate_momentum(data)
    assert held(stance, first) == one
    assert held(stance, second) == two  # turnover so far: 0.95 and about 1.9
    # A third full rotation would lift the turnover of the last 252 bars above 4: both later quarter ends are skipped.
    assert held(stance, third) == held(stance, fourth) == held(stance, 389) == two
    free = fw.EngineRule(MULTI8, fw.te_cost_gate_momentum.targets, fw.te_cost_gate_momentum.schedule)
    assert held(free(data), third) == three
    assert fw.te_cost_gate_momentum.gates == fw.Gates(max_turnover=4.0)  # no tracking-error trigger


# --------------------------------------------------------------------------- size-only rules (W05, W19, W20)

def test_size_only_rules_hold_every_symbol_with_a_defined_window():
    data = steady(RATES, 200)
    days = data.bars["SPY"].dates
    for rule, lookback, universe in ((fw.inverse_volatility, 63, MULTI8), (fw.risk_parity, 63, MULTI8)):
        first = next(index for index in range(lookback, len(days) - 1) if days[index][:7] != days[index + 1][:7])
        stance = rule(data)
        assert all(stance[symbol] == [0] * first + [1] * (len(days) - first) for symbol in universe)
    sectors = steady(SECTOR_RATES, 200)
    first = next(index for index in range(126, len(days) - 1) if days[index][:7] != days[index + 1][:7])
    assert all(sides == [0] * first + [1] * (200 - first) for sides in fw.risk_parity_capped(sectors).values())


@pytest.mark.parametrize(("rule", "universe", "lookback"), [
    (fw.inverse_volatility, MULTI8, 63), (fw.risk_parity, MULTI8, 63), (fw.risk_parity_capped, SECTOR9, 126)])
def test_size_only_rule_needs_exactly_its_window_of_daily_returns(rule, universe, lookback):
    end = DAYS.index("2021-12-31")
    following = month_end_from(end + 1)
    table = {symbol: bars(symbol, [100.0] * 300) for symbol in universe}
    ready, short = universe[-1], universe[-2]
    table[ready] = bars(ready, [100.0] * (300 - end + lookback), DAYS[end - lookback])  # `lookback` returns at `end`
    table[short] = bars(short, [100.0] * (300 - end + lookback - 1), DAYS[end - lookback + 1])  # one return less
    stance = rule(Inputs(table, {}))
    assert stance[ready] == [0] * lookback + [1] * (300 - end)
    assert stance[short] == [0] * (lookback - 1 + following - end) + [1] * (300 - following)
    assert stance[universe[0]][end - 1:end + 1] == [1, 1]


def test_size_only_rule_waits_for_the_window_of_a_late_symbol(random_runs):
    full, stance = random_runs["qj/W05"]
    assert stance["VNQ"][62] == 0 and stance["VNQ"][-1] == 1  # VNQ starts 150 sessions late
    assert stance["SPY"][150] == 1
    first = stance["VNQ"].index(1)
    assert first >= 63 and full.bars["VNQ"].dates[first][:7] != full.bars["VNQ"].dates[first + 1][:7]


# --------------------------------------------------------------------------- regime rule (W06)

def test_defensive_rotation_follows_spy_against_its_average():
    spy = growth(260, 0.001) + growth(140, -0.003, first=100 * 1.001 ** 259)
    data = inputs({**{symbol: growth(400, 0.0001) for symbol in MULTI8}, "SPY": spy})
    stance = fw.defensive_rotation(data)
    average = forms.sma(spy, 200)
    for index in range(400):
        risk = 0 if average[index] is None else int(spy[index] > average[index])
        safe = 0 if average[index] is None else 1 - risk
        assert [stance[symbol][index] for symbol in fw.RISK_ON] == [risk] * 5
        assert [stance[symbol][index] for symbol in fw.DEFENSIVE] == [safe] * 3
    assert stance["SPY"][199] == 1 and stance["TLT"][-1] == 1
    assert set(fw.RISK_ON) | set(fw.DEFENSIVE) == set(MULTI8)
    targets = fw.defensive_rotation.targets(forms.panel(data, MULTI8))
    assert targets[198] == {} and targets[199] == dict.fromkeys(fw.RISK_ON, 1 / 5)
    assert targets[-1] == dict.fromkeys(fw.DEFENSIVE, 1 / 3)


def test_defensive_rotation_buys_a_late_etf_at_the_next_change_of_the_regime():
    # SPY: below its average from bar 199, above it in the rise, below it again in the last fall.
    spy = growth(260, -0.001) + growth(60, 0.006, first=77.0) + growth(100, -0.006, first=110.0)
    average = forms.sma(spy, 200)
    regime = [None if level is None else spy[index] > level for index, level in enumerate(average)]
    up = regime.index(True)
    down = regime.index(False, up)
    assert regime[199] is False and 260 < up < down < 400
    table = {symbol: bars(symbol, [100.0] * 420) for symbol in MULTI8}
    table["SPY"] = bars("SPY", spy)
    table["TLT"] = bars("TLT", [100.0] * 180, DAYS[240])  # TLT starts on bar 240, in a defensive regime
    stance = fw.defensive_rotation(Inputs(table, {}))
    assert stance["IEF"] == stance["GLD"] == [0] * 199 + [1] * (up - 199) + [0] * (down - up) + [1] * (420 - down)
    assert stance["TLT"] == [0] * (down - 240) + [1] * (420 - down)  # not bought before the next change
    assert stance["EEM"] == [0] * up + [1] * (down - up) + [0] * (420 - down)


# --------------------------------------------------------------------------- long/short rules (W15, W16)

def test_long_short_momentum_and_reversal_take_opposite_ends():
    data = steady(SECTOR_RATES)
    days = data.bars["XLB"].dates
    momentum, reversal = fw.sector_momentum_long_short(data), fw.sector_reversal_long_short(data)
    ends = [1, 1, 1, 0, 0, 0, -1, -1, -1]
    assert [momentum[symbol][-1] for symbol in SECTOR9] == ends
    assert [reversal[symbol][-1] for symbol in SECTOR9] == [-side for side in ends]
    month_end = next(index for index in range(252, len(days) - 1) if days[index][:7] != days[index + 1][:7])
    assert momentum["XLB"] == [0] * month_end + [1] * (len(days) - month_end)
    week_end = next(index for index in range(21, len(days)) if date.fromisoformat(days[index]).weekday() == 4)
    assert reversal["XLY"] == [0] * week_end + [1] * (len(days) - week_end)


def test_reversal_ranks_the_21_bar_return():
    end = next(index for index in range(100, 200) if date.fromisoformat(DAYS[index]).weekday() == 4)
    following = next(index for index in range(end + 1, 200) if date.fromisoformat(DAYS[index]).weekday() == 4)
    table = {symbol: growth(200, rate) for symbol, rate in SECTOR_RATES.items()}
    table["XLI"] = [value * (1.3 if index >= end - 20 else 1.0) for index, value in enumerate(table["XLI"])]
    stance = fw.sector_reversal_long_short(inputs(table))
    # XLI rose 30% 21 bars before `end`: it is one of the 3 highest returns at `end` and not a week later.
    assert {symbol: stance[symbol][end] for symbol in ("XLB", "XLE", "XLF", "XLI")} == {
        "XLB": -1, "XLE": -1, "XLF": 0, "XLI": -1}
    assert {symbol: stance[symbol][following] for symbol in ("XLB", "XLE", "XLF", "XLI")} == {
        "XLB": -1, "XLE": -1, "XLF": -1, "XLI": 0}


def test_reversal_sides_change_only_at_week_ends(random_runs):
    full, stance = random_runs["qj/W16"]
    days = full.bars["XLB"].dates
    moved = sorted({index for sides in stance.values() for index in changes(sides)})
    assert len(moved) > 20
    for index in moved:
        if index + 1 < len(days):
            weeks = [date.fromisoformat(day).isocalendar()[1] for day in days[index:index + 2]]
            assert weeks[0] != weeks[1]


# --------------------------------------------------------------------------- daily rules (W12, W21, W22)

def test_partial_drift_buys_only_targets_above_the_band_and_keeps_the_weights_inside_it():
    strong = growth(200, 0.003)
    weak = growth(200, 0.002)
    turn = strong[:100] + growth(100, -0.005, first=strong[99] * 0.995)
    data = inputs({symbol: weak if symbol == "XLY" else turn if symbol == "XLK" else strong for symbol in SECTOR9})
    stance = fw.partial_drift(data)
    _, rows = fw.partial_drift.weights(data)
    # Bar 63: eight targets of about 0.11 are more than 10 points above a weight of 0; the target of XLY is 0.07.
    targets = fw.partial_drift.targets(forms.panel(data, SECTOR9))
    assert 0.95 * targets[63]["XLB"] == pytest.approx(0.110, abs=0.001)
    assert 0.95 * targets[63]["XLY"] == pytest.approx(0.071, abs=0.001)
    assert all(stance[symbol][:63] == [0] * 63 and stance[symbol][63] == 1 for symbol in SECTOR9 if symbol != "XLY")
    assert not any(stance["XLY"]) and forms.pct_change(weak, 63)[-1] > 0
    assert rows[63][SECTOR9.index("XLK")] == pytest.approx(0.95 / 8)
    # The seven other weights stay inside the band and are kept as they are (a kept weight does not drift).
    # XLK is the only traded symbol and takes what they leave of the target total, until its target is 0.
    momentum = forms.pct_change(turn, 63)
    sold = next(index for index in range(64, 200) if momentum[index] <= 0)
    assert stance["XLK"] == [0] * 63 + [1] * (sold - 63) + [0] * (200 - sold) and 100 < sold
    assert 0.95 * targets[sold - 1]["XLK"] < 0.95 / 8 - 0.10  # more than 10 points below its weight
    assert rows[sold - 1] == pytest.approx([0.0 if symbol == "XLY" else 0.95 / 8 for symbol in SECTOR9])
    assert rows[199] == pytest.approx([0.0 if symbol in ("XLK", "XLY") else 0.95 / 8 for symbol in SECTOR9])
    assert 0.95 * targets[199]["XLB"] > 0.95 / 8 + 0.004  # a full rebalance would hold more
    assert stance["XLB"] == [0] * 63 + [1] * 137


def test_bollinger_reversion_enters_below_the_band_and_leaves_above_the_mean():
    base = [100.0, 101.0] * 15  # mean 100.5, sample deviation about 0.51: lower band about 99.48
    path = base + [99.6, 99.0, 99.2, 100.0, 100.2, 100.6, 97.0]
    data = inputs({symbol: path if symbol == "XLK" else base + [100.0] * 7 for symbol in SECTOR9})
    stance = fw.bollinger_reversion(data)
    # 99.6 is inside the band; 99.0 enters; 99.2, 100.0 and 100.2 stay below the mean (about 100.3);
    # 100.6 is above the mean (and below the mean plus one deviation, 100.9) and leaves;
    # 97.0 is below the band, which the dip has widened to about 98.2.
    assert stance["XLK"] == [0] * 30 + [0, 1, 1, 1, 1, 0, 1]
    assert not any(stance["XLB"])


def test_macd_trend_is_long_in_a_rise_and_flat_in_a_fall():
    path = growth(80, 0.004) + growth(60, -0.004, first=100 * 1.004 ** 79)
    stance = fw.macd_trend(inputs({symbol: path for symbol in SECTOR9}))["XLK"]
    assert stance[0] == 0 and stance[1:80] == [1] * 79
    turn = stance.index(0, 1)
    assert 80 <= turn <= 90 and stance[turn:] == [0] * (140 - turn)


def test_macd_trend_after_a_step_is_long_until_macd_12_26_falls_below_its_9_bar_average():
    # After a step from 100 to 110 an EMA of span n is 110 - 10 q^(k+1) with q = (n - 1) / (n + 1), k bars after it.
    def macd(k: int, fast: int = 12, slow: int = 26) -> float:
        return 10 * (((slow - 1) / (slow + 1)) ** (k + 1) - ((fast - 1) / (fast + 1)) ** (k + 1))

    line, expected = 0.0, []
    for k in range(60):
        line = 0.2 * macd(k) + 0.8 * line  # the 9-bar EMA: alpha = 2 / 10
        expected.append(int(macd(k) > line))
    assert expected == [1] * 14 + [0] * 46
    stance = fw.macd_trend(inputs({symbol: [100.0] * 40 + [110.0] * 60 for symbol in SECTOR9}))
    assert all(sides == [0] * 40 + expected for sides in stance.values())


def macd_signal(path, fast: int, slow: int, signal: int) -> list[int]:
    """MACD above its signal line, with every EMA started at the first value."""
    def average(values, span):
        out = [values[0]]
        for value in values[1:]:
            out.append(out[-1] + 2 / (span + 1) * (value - out[-1]))
        return out

    macd = [quick - base for quick, base in zip(average(path, fast), average(path, slow))]
    return [int(value > line) for value, line in zip(macd, average(macd, signal))]


def test_macd_trend_uses_the_spans_12_26_and_9():
    path = [100 + 0.05 * index + 10 * math.sin(index / 9) + 3 * math.sin(index / 2.3) for index in range(240)]
    expected = macd_signal(path, 12, 26, 9)
    assert len(changes(expected)) > 8
    for other in ((11, 26, 9), (13, 26, 9), (12, 25, 9), (12, 27, 9), (12, 30, 9), (12, 26, 8), (12, 26, 10)):
        assert macd_signal(path, *other) != expected
    assert fw.macd_trend(inputs({symbol: path for symbol in SECTOR9}))["XLE"] == expected


# --------------------------------------------------------------------------- 151 Strategies 4.1

def test_sector_momentum_holds_the_two_etfs_of_sector_rotation(random_runs):
    full, stance = random_runs["lib/151-4-1"]
    days = full.bars["XLK"].dates
    calendar = [date.fromisoformat(day) for day in days]
    prices = {symbol: dict(zip((date.fromisoformat(day) for day in data.dates), data.adj_close))
              for symbol, data in full.bars.items()}
    own: set[str] = set()
    picks = []
    ends = set(sector_rotation.month_ends(calendar))
    for index in range(len(days)):
        if index in ends:
            decision = sector_rotation.target_weights("base", prices, calendar, index)
            if decision is not None:
                own = set(decision.weights)
                picks.append(tuple(sorted(own)))
        for symbol in SECTOR11:
            dates = full.bars[symbol].dates
            if days[index] in dates:
                assert stance[symbol][dates.index(days[index])] == int(symbol in own), (symbol, days[index])
    assert len(picks) > 15 and len(set(picks)) > 3 and all(len(pick) == 2 for pick in picks)


def test_sector_momentum_ranks_by_the_252_session_return():
    rates = dict(zip(SECTOR11, (0.0001, 0.0009, 0.0002, 0.0003, 0.0007, 0.0001, 0.0002, 0.0003, 0.0001, 0.0002,
                                0.0004)))
    data = steady(rates, 320)
    stance = fw.sector_momentum(data)
    days = data.bars["XLK"].dates
    first = next(index for index in range(252, len(days) - 1) if days[index][:7] != days[index + 1][:7])
    for symbol in SECTOR11:
        assert stance[symbol] == [0] * first + [int(symbol in ("XLE", "XLK"))] * (len(days) - first)
