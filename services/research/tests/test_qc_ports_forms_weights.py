"""Tests of the QuantJourney rebalance-policy forms and the 151 4.1 form (synthetic bars, no files)."""
from __future__ import annotations

import random
from datetime import date

import pytest
from tests.qc_ports_synthetic import trading_days

from strategies import sector_rotation
from strategies.qc_ports import forms
from strategies.qc_ports import forms_weights as fw
from strategies.qc_ports.data import Bars
from strategies.qc_ports.forms import MULTI8, SECTOR9, SECTOR11, Inputs

START = "2021-01-04"
KEYS = ("qj/O17 qj/W02 qj/W04 qj/W05 qj/W06 qj/W10 qj/W11 qj/W17 qj/W18 qj/W19 qj/W12 qj/W15 qj/W16 qj/W20 "
        "qj/W21 qj/W22 lib/151-4-1").split()
BY_KEY = {form.key: form for form in fw.FORMS}


def bars(symbol: str, closes, start: str = START) -> Bars:
    column = tuple(float(value) for value in closes)
    return Bars(symbol, trading_days(start, len(column)), column, column, column, column, column)


def inputs(table) -> Inputs:
    return Inputs({symbol: bars(symbol, closes) for symbol, closes in table.items()}, {})


def growth(count: int, rate: float, first: float = 100.0) -> list[float]:
    return [first * (1 + rate) ** index for index in range(count)]


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
    days = trading_days(START, count)
    table = {}
    for symbol in symbols:
        late = 150 if symbol in ("XLC", "VNQ") else 0
        table[symbol] = bars(symbol, walk(symbol, count - late), days[late])
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


def test_gated_forms_say_that_the_gate_reads_the_shares_portfolio():
    for key in ("qj/W10", "qj/W11", "qj/W12"):
        assert "The gate reads the shares portfolio" in BY_KEY[key].keeps
    assert all(form.keeps for form in fw.FORMS)


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
    days = trading_days(START, 800)
    by_bars = [days[index][:7] != days[index + 1][:7] for index in range(len(days) - 1)]
    assert forms.period_ends(days, "month")[:-1] == by_bars
    by_data = sector_rotation.month_ends([date.fromisoformat(day) for day in days])
    assert by_data == [index for index, flag in enumerate(by_bars) if flag]


def test_month_starts_count_the_first_bar():
    assert fw.month_starts(["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02"]) == [True, False, True, False]


# --------------------------------------------------------------------------- calendar rules

RATES = dict(zip(MULTI8, (0.0010, 0.0008, 0.0006, 0.0004, 0.0002, -0.0002, -0.0004, -0.0006)))
SECTOR_RATES = dict(zip(SECTOR9, (0.0008, 0.0006, 0.0004, 0.0002, 0.0001, -0.0001, -0.0002, -0.0004, -0.0006)))


def steady(rates, count: int = 420) -> Inputs:
    return inputs({symbol: growth(count, rate) for symbol, rate in rates.items()})


def test_monthly_rotation_holds_the_top_three_from_the_first_bar_of_a_month():
    data = steady(RATES)
    stance = fw.monthly_rotation(data)
    days = data.bars["SPY"].dates
    first = next(index for index in range(126, len(days)) if days[index][:7] != days[index - 1][:7])
    for symbol in MULTI8:
        held = int(symbol in ("SPY", "EFA", "EEM"))
        assert stance[symbol] == [0] * first + [held] * (len(days) - first)


def test_monthly_trend_starts_at_the_first_month_end_with_both_averages():
    data = steady(RATES)
    stance = fw.monthly_trend(data)
    days = data.bars["SPY"].dates
    first = next(index for index in range(199, len(days) - 1) if days[index][:7] != days[index + 1][:7])
    for symbol, rate in RATES.items():
        assert stance[symbol] == [0] * first + [int(rate > 0)] * (len(days) - first)
    assert fw.vol_target_momentum(data)["EEM"][-1] == 1
    assert BY_KEY["qj/W17"].rule is BY_KEY["qj/W02"].rule


def test_trend_members_change_only_at_month_ends(random_runs):
    full, stance = random_runs["qj/W02"]
    for symbol, sides in stance.items():
        days = full.bars[symbol].dates
        assert changes(sides)
        assert all(days[index][:7] != days[index + 1][:7] for index in changes(sides) if index + 1 < len(days))


def test_dual_momentum_holds_at_most_two_positive_returns_from_a_quarter_end():
    rates = {**dict.fromkeys(MULTI8, -0.0003), "GLD": 0.0005}
    data = steady(rates)
    stance = fw.dual_momentum(data)
    days = data.bars["SPY"].dates
    first = next(index for index in range(252, len(days) - 1)
                 if days[index][5:7] in ("03", "06", "09", "12") and days[index][:7] != days[index + 1][:7])
    assert stance["GLD"] == [0] * first + [1] * (len(days) - first)
    assert all(not any(stance[symbol]) for symbol in MULTI8 if symbol != "GLD")
    top = fw.dual_momentum(steady(RATES))
    assert [symbol for symbol in MULTI8 if top[symbol][-1]] == ["SPY", "EFA"]


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


def test_size_only_rule_waits_for_the_window_of_a_late_symbol(random_runs):
    full, stance = random_runs["qj/W05"]
    assert stance["VNQ"][62] == 0 and stance["VNQ"][-1] == 1  # VNQ starts 150 sessions late
    assert stance["SPY"][150] == 1
    first = stance["VNQ"].index(1)
    assert first >= 63 and full.bars["VNQ"].dates[first][:7] != full.bars["VNQ"].dates[first + 1][:7]


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


def test_reversal_sides_change_only_at_week_ends(random_runs):
    full, stance = random_runs["qj/W16"]
    days = full.bars["XLB"].dates
    moved = sorted({index for sides in stance.values() for index in changes(sides)})
    assert len(moved) > 20
    for index in moved:
        if index + 1 < len(days):
            weeks = [date.fromisoformat(day).isocalendar()[1] for day in days[index:index + 2]]
            assert weeks[0] != weeks[1]


# --------------------------------------------------------------------------- daily rules

def test_bollinger_reversion_enters_below_the_band_and_leaves_above_the_mean():
    base = [100.0, 101.0] * 15  # mean 100.5, sample deviation about 0.51: lower band about 99.48
    path = base + [99.6, 99.0, 99.2, 100.0, 100.3, 101.0, 97.0]
    data = inputs({symbol: path if symbol == "XLK" else base + [100.0] * 7 for symbol in SECTOR9})
    stance = fw.bollinger_reversion(data)
    # 99.6 is inside the band; 99.0 enters; 99.2, 100.0 and 100.3 stay below the mean (about 100.4);
    # 101.0 leaves; 97.0 is below the band, which the dip has widened to about 98.2.
    assert stance["XLK"] == [0] * 30 + [0, 1, 1, 1, 1, 0, 1]
    assert not any(stance["XLB"])


def test_macd_trend_is_long_in_a_rise_and_flat_in_a_fall():
    path = growth(80, 0.004) + growth(60, -0.004, first=100 * 1.004 ** 79)
    stance = fw.macd_trend(inputs({symbol: path for symbol in SECTOR9}))["XLK"]
    assert stance[0] == 0 and stance[1:80] == [1] * 79
    turn = stance.index(0, 1)
    assert 80 <= turn <= 90 and stance[turn:] == [0] * (140 - turn)


# --------------------------------------------------------------------------- the shares portfolio

def book_of(**columns) -> forms.Panel:
    count = len(next(iter(columns.values())))
    return forms.Panel(trading_days(START, count), {symbol: tuple(values) for symbol, values in columns.items()})


def test_breaker_flattens_after_a_15_percent_drawdown_and_returns_after_the_cooldown():
    prices = [100.0] * 5 + growth(55, -0.02, first=98.0)
    book = book_of(A=prices)
    flags = [True] + [False] * 59
    targets = [{"A": 0.95}] * 60
    rows = fw.shares_book(book, flags, targets, fw.Gates(drawdown=0.15, cooldown=10))
    # Equity = 0.05 cash + 0.95 x price / 100: below 0.85 from price 83.37 (bar 13).
    equity = [0.05 + 0.95 * price / 100 for price in prices]
    breach = next(index for index, value in enumerate(equity) if value < 0.85)
    assert breach == 13
    assert all(row[0] > 0 for row in rows[:breach])
    assert rows[breach:breach + 11] == [[0.0]] * 11
    assert rows[breach + 11] == [pytest.approx(0.95)]
    assert all(row[0] > 0 for row in fw.shares_book(book, flags, targets, fw.Gates()))


def test_breaker_peak_restarts_after_the_cooldown():
    prices = [100.0] * 5 + growth(55, -0.02, first=98.0)
    rows = fw.shares_book(book_of(A=prices), [True] + [False] * 59, [{"A": 0.95}] * 60,
                          fw.Gates(drawdown=0.15, cooldown=10))
    # Back at bar 24 with the peak at that equity: the next 15% takes 9 more bars of -2% at weight 0.95.
    assert rows[24][0] > 0 and rows[32][0] > 0 and rows[33] == [0.0]


def test_turnover_budget_refuses_a_rebalance():
    book = book_of(A=[100.0] * 6)
    targets = [{"A": 0.95}, {}, {"A": 0.95}, {}, {"A": 0.95}, {"A": 0.95}]
    limited = fw.shares_book(book, [True] * 6, targets, fw.Gates(max_turnover=2.0))
    assert [row[0] for row in limited] == pytest.approx([0.95, 0.0, 0.0, 0.0, 0.0, 0.0])
    free = fw.shares_book(book, [True] * 6, targets, fw.Gates())
    assert [row[0] for row in free] == pytest.approx([0.95, 0.0, 0.95, 0.0, 0.95, 0.95])


def test_tracking_error_rebalances_before_the_calendar():
    swing = [100.0 * (1.02 if index % 2 else 1.0) for index in range(12)]
    book = book_of(SPY=[100.0] * 12, A=swing)
    targets = [{"A": 0.95}] + [{"SPY": 0.95}] * 11
    flags = [True] + [False] * 11
    gates = fw.Gates(te_threshold=0.06, te_window=5)
    rows = fw.shares_book(book, flags, targets, gates, benchmark="SPY")
    assert all(row[0] == 0 and row[1] > 0 for row in rows[:4])
    assert rows[4] == pytest.approx([0.95, 0.0])
    for quiet in (fw.shares_book(book, flags, targets, fw.Gates(), benchmark="SPY"),
                  fw.shares_book(book, flags, targets, gates)):
        assert all(row[0] == 0 and row[1] > 0 for row in quiet)


def test_partial_rebalance_trades_only_the_drifted_symbols():
    book = book_of(A=[100.0] * 5, B=[100.0] * 5)
    targets = [{"A": 0.5, "B": 0.5}, {"A": 0.45, "B": 0.55}, {"A": 0.05, "B": 0.9}, {"B": 0.95}, {"B": 0.5}]
    rows = fw.shares_book(book, [True] * 5, targets, fw.Gates(partial_drift=0.10))
    assert rows[0] == pytest.approx([0.5, 0.5])
    assert rows[1] == pytest.approx([0.5, 0.5])  # both within 10 points: nothing traded
    assert rows[2] == pytest.approx([0.05, 0.9])
    assert rows[3] == pytest.approx([0.05, 0.9])  # A keeps 5 points although its target is 0
    assert rows[4] == pytest.approx([0.05, 0.45])  # B takes the target total less what A keeps
    whole = fw.shares_book(book, [True] * 5, targets, fw.Gates())
    assert whole[3] == pytest.approx([0.0, 0.95])


def test_shares_book_does_not_trade_a_symbol_without_a_close():
    book = book_of(A=[100.0, 100.0, None, 100.0], B=[100.0] * 4)
    targets = [{"A": 0.5, "B": 0.45}, {"A": 0.5, "B": 0.45}, {"B": 0.95}, {"B": 0.95}]
    rows = fw.shares_book(book, [True] * 4, targets, fw.Gates())
    assert rows[2] == pytest.approx([0.5, 0.45])  # A is kept, B gets the target total less A
    assert rows[3] == pytest.approx([0.0, 0.95])


def test_circuit_breaker_rule_is_flat_in_a_crash_where_the_trend_rule_is_long():
    path = growth(300, 0.001) + growth(8, -0.03, first=100 * 1.001 ** 299 * 0.97) + [100.0] * 30
    data = inputs({symbol: path for symbol in MULTI8})
    breaker, trend = fw.circuit_breaker_trend(data), fw.monthly_trend(data)
    assert breaker["SPY"][:300] == trend["SPY"][:300] and trend["SPY"][299] == 1
    assert trend["SPY"][300:308] == [1] * 8
    flat = breaker["SPY"].index(0, 250)
    assert 302 <= flat <= 307 and breaker["SPY"][flat:flat + 11] == [0] * 11
    assert all(breaker[symbol] == breaker["SPY"] for symbol in MULTI8)


def test_partial_drift_rule_keeps_a_small_position_after_its_momentum_turns():
    rise = growth(140, 0.002)
    fall = rise[:100] + growth(40, -0.004, first=rise[99] * 0.996)
    data = inputs({symbol: fall if symbol == "XLY" else rise for symbol in SECTOR9})
    stance = fw.partial_drift(data)
    # Nine equal positive returns: target 0.95 / 9 each, above the 10-point band from zero, so all are bought.
    assert all(stance[symbol][62] == 0 and stance[symbol][63] == 1 for symbol in SECTOR9)
    momentum = forms.pct_change(fall, 63)
    assert momentum[-1] < 0 and stance["XLY"][-1] == 1  # target 0, held weight within the band
    assert stance["XLK"] == [0] * 63 + [1] * 77


# --------------------------------------------------------------------------- 151 Strategies 4.1

def test_sector_momentum_holds_the_two_etfs_of_sector_rotation(random_runs):
    full, stance = random_runs["lib/151-4-1"]
    days = full.bars["XLK"].dates
    calendar = [date.fromisoformat(day) for day in days]
    prices = {symbol: dict(zip((date.fromisoformat(day) for day in data.dates), data.adj_close))
              for symbol, data in full.bars.items()}
    held: set[str] = set()
    picks = []
    ends = set(sector_rotation.month_ends(calendar))
    for index in range(len(days)):
        if index in ends:
            decision = sector_rotation.target_weights("base", prices, calendar, index)
            if decision is not None:
                held = set(decision.weights)
                picks.append(tuple(sorted(held)))
        for symbol in SECTOR11:
            own = full.bars[symbol].dates
            if days[index] in own:
                assert stance[symbol][own.index(days[index])] == int(symbol in held), (symbol, days[index])
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
