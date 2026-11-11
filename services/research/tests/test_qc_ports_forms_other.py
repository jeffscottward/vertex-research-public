"""qc-ports options forms of the pairs, the FX and futures twins, the SMA timing, the iron condor and
the leader pullback (synthetic)."""
import math
import random
from datetime import date
from statistics import covariance, fmean, stdev, variance

import pytest

from gamma.engines.bridgingcycles_short_strangle import (DailyObservation, black_scholes_marks,
                                                         simulate_bridgingcycles_short_strangle)
from strategies import alert_templates as at
from strategies.published_rules import pair_spread_backtest
from strategies.qc_ports import book
from strategies.qc_ports import forms as fm
from strategies.qc_ports import forms_other as fo
from strategies.qc_ports import options as om
from strategies.qc_ports.data import Bars, Market
from strategies.qc_ports.ideas import MONTHLY_CALL
from tests.qc_ports_synthetic import VIX_FOR_20, market, trading_days
from tests.test_alert_templates import bars_from, ramp

START = "2024-01-02"
KEYS = ("qj/W13", "qj/W14", "lib/pairs-divergence", "qj/O19", "qj/W23", "qj/W24", "qj/O20", "qj/W25",
        "lib/zakamulin-sma", "lib/short-strangle")
LEADERS = ("AAA", "BBB", "CCC")
BY_KEY = {form.key: form for form in (*fo.FORMS, *fo.leader_forms(LEADERS))}


def _bars(symbol, closes, *, start=START, adj=None, highs=None, lows=None, dates=None) -> Bars:
    close = tuple(float(value) for value in closes)
    return Bars(symbol, tuple(dates) if dates is not None else trading_days(start, len(close)), close,
                tuple(float(value) for value in highs) if highs is not None else close,
                tuple(float(value) for value in lows) if lows is not None else close, close,
                close if adj is None else tuple(float(value) for value in adj))


def _walk(seed, count, *, vol=0.01, drift=0.0, start=100.0) -> list[float]:
    rng = random.Random(seed)
    out, price = [], start
    for _ in range(count):
        price *= math.exp(rng.gauss(drift, vol))
        out.append(price)
    return out


def _inputs(*bars: Bars, iv=None) -> fm.Inputs:
    return fm.Inputs({item.symbol: item for item in bars},
                     {item.symbol: (iv or {}).get(item.symbol, (20.0,) * len(item)) for item in bars})


def _stance(key: str, inputs: fm.Inputs) -> dict[str, list[int]]:
    return fm.stance_of(BY_KEY[key], inputs)


# --------------------------------------------------------------------------- registry

def test_forms_are_the_ten_named_forms_on_their_universes():
    assert tuple(form.key for form in fo.FORMS) == KEYS
    rows = {
        "qj/W13": ("quantjourney-w13-pairs-ratio-zscore", "Pairs Trading (Ratio Z-Score)", "relative value",
                   ("KO", "PEP"), None),
        "qj/W14": ("quantjourney-w14-pairs-hedge-ratio", "Pairs Trading (Hedge Ratio)", "relative value",
                   ("EWA", "EWC"), None),
        "lib/pairs-divergence": ("pairs-trading-divergence", "Pairs Trading Divergence", "relative value",
                                 ("GLD", "GDX"), None),
        "qj/O19": ("quantjourney-o19-fx-momentum-lots", "FX Momentum with Standard Lots", "rotation",
                   ("FXE", "FXB", "FXA"), "base/fx3"),
        "qj/W23": ("quantjourney-w23-fx-time-series-momentum", "FX Time-Series Momentum", "rotation",
                   ("FXE", "FXB", "FXA"), "base/fx3"),
        "qj/W24": ("quantjourney-w24-fx-cross-sectional-momentum", "FX Cross-Sectional Momentum", "rotation",
                   ("FXE", "FXB", "FXA"), "base/fx3"),
        "qj/O20": ("quantjourney-o20-futures-donchian-contracts", "Futures Donchian Contracts", "trend",
                   ("SPY", "QQQ", "USO", "GLD"), "base/futures4"),
        "qj/W25": ("quantjourney-w25-continuous-futures-trend", "Continuous Futures Trend Proxy", "trend",
                   ("SPY", "QQQ", "IEF", "USO", "GLD", "CORN"), "base/futures6"),
        "lib/zakamulin-sma": ("quantlab-zakamulin-2013-sma-timing", "SSRN 2242795 10-month SMA timing, SPY vs T-bills",
                              "trend", ("SPY",), "base/spy"),
        "lib/short-strangle": ("bridgingcycles-short-strangle", "BridgingCycles short strangle", "vol premium",
                               ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"), None),
    }
    for form in fo.FORMS:
        assert (form.slug, form.name, form.sleeve, form.symbols, form.baseline) == rows[form.key], form.key
        assert form.keeps.endswith(".") and "  " not in form.keeps
        if form.key != "lib/short-strangle":
            assert form.structures is fm.LONG_SHORT
        assert form.entry_only == (form.key == "lib/short-strangle")
    assert len({form.slug for form in fo.FORMS}) == 10
    assert fm.FX_TWINS == ("FXE", "FXB", "FXA") and fo.FUTURES4 == ("SPY", "QQQ", "USO", "GLD")


def test_every_underlying_has_an_iv_index_or_a_proxy_model():
    for form in fo.FORMS:
        assert set(form.symbols) <= set(fm.CORE7) | set(fm.PROXY_MODELS), form.key


def test_keeps_states_the_adaptations():
    divergence, condor = BY_KEY["lib/pairs-divergence"].keeps, BY_KEY["lib/short-strangle"].keeps
    assert "Adaptation" in divergence and "2006-2007" in divergence and "last 252 bars" in divergence
    assert "Adaptation" in condor and "undefined risk" in condor and "iron condor" in condor
    assert "held to the owner exit rule" in condor and "50% profit take" in condor and "21 DTE exit" in condor
    for key in ("qj/O19", "qj/W23", "qj/W24"):
        assert "NZDUSD is dropped" in BY_KEY[key].keeps


def test_the_condor_is_two_credit_spreads_that_risk_two_percent_together():
    assert fo.CONDOR_PUT == {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.16,
                             "widthSigma": 0.5, "maxLossPct": 1}
    assert fo.CONDOR_CALL == {**fo.CONDOR_PUT, "structure": "callCreditVertical"}
    assert BY_KEY["lib/short-strangle"].structures == {1: (fo.CONDOR_PUT, fo.CONDOR_CALL)}
    specs = [book.parse_options(block) for block in (fo.CONDOR_PUT, fo.CONDOR_CALL)]
    assert sum(spec.max_loss_pct for spec in specs) == 2 == book.MAX_LOSS_PCT_CAP
    assert [book.STRUCTURES[spec.structure] for spec in specs] == [("put", "credit"), ("call", "credit")]


def test_leader_forms_are_two_long_only_entry_only_forms_on_the_given_symbols():
    reclaim, dip = fo.leader_forms(("AAA", "BBB"))
    assert (reclaim.key, dip.key) == ("leaders/reclaim", "leaders/dip")
    assert reclaim.name == "Leader pullback and reclaim (buy the reclaim)"
    assert dip.name == "Leader pullback (buy the dip state)"
    for form in (reclaim, dip):
        assert form.symbols == ("AAA", "BBB") and form.slug == "leader-pullback-and-reclaim"
        assert form.sleeve == "mean reversion" and form.baseline == "base/leaders"
        assert form.structures == {1: (fo.LEADER_CALL,)} and form.entry_only
        assert "risks 0.5% of equity" in form.keeps and "liquidity filter is not applied" in form.keeps
        assert "held to the owner exit rule" in form.keeps
        assert form.keeps.endswith(".")
    assert fo.leader_forms(["ZZZ"])[1].symbols == ("ZZZ",)


def test_a_leader_spread_risks_half_a_percent_and_leaves_the_monthly_call_as_it_is():
    assert fo.LEADER_CALL == {**MONTHLY_CALL, "maxLossPct": 0.5}
    assert fo.LEADER_CALL["dte"] is not MONTHLY_CALL["dte"] and MONTHLY_CALL["maxLossPct"] == 2
    assert book.parse_options(fo.LEADER_CALL).max_loss_pct == 0.5


# --------------------------------------------------------------------------- pairs

def test_band_sides_enter_past_the_entry_and_leave_inside_the_exit_without_a_direct_flip():
    z = [None, 2.0, 2.1, 1.0, 0.5, 0.49, -2.0, -2.5, -0.6, 3.0, 0.4, 2.5, None, -0.3]
    assert fo.band_sides(z) == [0, 0, -1, -1, -1, 0, 0, 1, 1, 1, 0, -1, 0, 0]


def test_divergence_sides_follow_the_book_rule():
    z = [None, 1.9, -2.0, -1.5, -1.01, -1.0, 2.0, 1.01, -2.0, 0.0, 1.5, None, 2.5, None]
    assert fo.divergence_sides(z) == [0, 0, 1, 1, 1, 0, -1, -1, 1, 0, 0, 0, -1, 0]


def test_ratio_z_is_the_sample_z_score_of_the_log_ratio_over_60_bars():
    first, second = _walk(1, 200), _walk(2, 200)
    spread = [math.log(a / b) for a, b in zip(first, second)]
    made = fo.ratio_z(first, second)
    assert made[:59] == [None] * 59
    for index in (59, 60, 133, 199):
        window = spread[index - 59:index + 1]
        assert made[index] == pytest.approx((spread[index] - fmean(window)) / stdev(window), abs=1e-9)
    assert fo.ratio_z([5.0] * 80, [2.0] * 80) == [None] * 80  # no variation, no z-score


def test_hedge_ratio_z_uses_one_rolling_beta_per_bar():
    first, second = _walk(3, 220), _walk(4, 220)
    logs_a, logs_b = [math.log(value) for value in first], [math.log(value) for value in second]

    def spread(index):
        beta = covariance(logs_a[index - 59:index + 1], logs_b[index - 59:index + 1]) / variance(
            logs_b[index - 59:index + 1])
        return logs_a[index] - beta * logs_b[index]

    made = fo.hedge_ratio_z(first, second)
    assert made[:118] == [None] * 118 and made[118] is not None
    for index in (118, 150, 219):
        window = [spread(position) for position in range(index - 59, index + 1)]
        assert made[index] == pytest.approx((window[-1] - fmean(window)) / stdev(window), abs=1e-8)


def test_divergence_z_is_the_book_fit_on_the_last_252_bars():
    first, second = _walk(5, 300, start=60.0), _walk(6, 300, start=40.0)
    made = fo.divergence_z(first, second)
    assert made[:251] == [None] * 251
    for index in (251, 262, 298):
        # The reference fits on its first `train` bars: give it the window and one test bar.
        fit = pair_spread_backtest(first[index - 251:index + 2], second[index - 251:index + 2], train=252)
        expected = (first[index] - fit.hedge_ratio * second[index] - fit.spread_mean) / fit.spread_std
        assert made[index] == pytest.approx(expected, abs=1e-9)


def test_divergence_sides_are_the_positions_of_the_book_rule_on_the_same_z_scores():
    first, second = _walk(3, 600, start=60.0), _walk(4, 600, start=40.0)
    fit = pair_spread_backtest(first, second, train=252)
    z = [(a - fit.hedge_ratio * b - fit.spread_mean) / fit.spread_std for a, b in zip(first, second)]
    assert {1, -1, 0, None} == set(fit.positions)
    assert fo.divergence_sides(z) == [position or 0 for position in fit.positions]  # None: before the first signal


def test_divergence_z_follows_a_hedge_ratio_that_changes():
    rng = random.Random(8)
    second = _walk(7, 900, vol=0.012, start=40.0)
    first = [(2.0 if index < 300 else 3.0) * value + rng.gauss(0, 0.5) for index, value in enumerate(second)]
    fixed = pair_spread_backtest(first, second, train=252)
    late = (first[-1] - fixed.hedge_ratio * second[-1] - fixed.spread_mean) / fixed.spread_std
    assert abs(late) > 20  # the fit of the first year reads the new ratio as a lasting extreme
    rolling = fo.divergence_z(first, second)
    assert all(abs(value) < 4 for value in rolling[300 + 252:])


@pytest.mark.parametrize(("key", "first", "second", "z_of", "sides_of"), [
    ("qj/W13", "KO", "PEP", fo.ratio_z, fo.band_sides),
    ("qj/W14", "EWA", "EWC", fo.hedge_ratio_z, fo.band_sides),
    ("lib/pairs-divergence", "GLD", "GDX", fo.divergence_z, fo.divergence_sides),
])
def test_a_pair_rule_gives_the_first_leg_its_side_and_the_second_leg_the_opposite(key, first, second, z_of, sides_of):
    adj_a, adj_b = _walk(11, 700, vol=0.012), _walk(12, 700, vol=0.012)
    # The traded closes differ from the total-return closes: the rule reads the total-return closes.
    inputs = _inputs(_bars(first, [50.0] * 700, adj=adj_a), _bars(second, [70.0] * 700, adj=adj_b))
    stance = _stance(key, inputs)
    expected = sides_of(z_of(adj_a, adj_b))
    assert stance[first] == expected and stance[second] == [-side for side in expected]
    assert {1, -1, 0} == set(expected)


def test_w13_shorts_the_rich_leg_and_buys_the_cheap_leg():
    ko = [100.0 + 0.1 * (index % 2) for index in range(80)] + [103.0] * 58
    stance = _stance("qj/W13", _inputs(_bars("KO", ko), _bars("PEP", [100.0] * 138)))
    assert stance["KO"][:80] == [0] * 80 and stance["PEP"][:80] == [0] * 80
    assert stance["KO"][80] == -1 and stance["PEP"][80] == 1
    assert stance["KO"][-1] == 0 and stance["PEP"][-1] == 0  # the 60-bar mean has caught up


def test_a_pair_is_read_on_joint_days_and_a_leg_keeps_its_side_on_a_day_the_other_has_no_bar():
    days = trading_days(START, 300)
    ko, pep = _walk(21, 300, vol=0.012), _walk(22, 300, vol=0.012)
    full = _stance("qj/W13", _inputs(_bars("KO", ko), _bars("PEP", pep)))
    missing = next(index for index in range(100, 300) if full["KO"][index - 1] != 0)
    keep = [index for index in range(300) if index != missing]
    kept_days = [days[index] for index in keep]
    short_pep = _bars("PEP", [pep[index] for index in keep], dates=kept_days)
    joint = _stance("qj/W13", _inputs(_bars("KO", [ko[index] for index in keep], dates=kept_days), short_pep))
    stance = _stance("qj/W13", _inputs(_bars("KO", ko), short_pep))
    assert stance["PEP"] == joint["PEP"] and len(stance["KO"]) == 300
    assert [stance["KO"][index] for index in keep] == joint["KO"]
    assert stance["KO"][missing] == stance["KO"][missing - 1] != 0


# --------------------------------------------------------------------------- FX twins

def test_o19_is_long_over_the_close_126_bars_before_and_short_otherwise():
    flat = [100.0] * 127 + [100.0, 101.0, 99.0]
    falling_price = [200.0 - index for index in range(130)]
    rising_total_return = [100.0 + index for index in range(130)]
    stance = _stance("qj/O19", _inputs(_bars("FXE", flat), _bars("FXB", falling_price, adj=rising_total_return),
                                       _bars("FXA", [200.0 - index for index in range(130)])))
    assert stance["FXE"] == [0] * 126 + [-1, -1, 1, -1]  # no change is short, as the source
    assert stance["FXB"] == [0] * 126 + [1] * 4  # the rule reads total-return prices
    assert stance["FXA"] == [0] * 126 + [-1] * 4


def test_w23_is_the_sign_of_the_126_bar_return():
    closes = [100.0] * 127 + [100.0, 101.0, 99.0]
    stance = _stance("qj/W23", _inputs(_bars("FXE", closes)))
    assert stance == {"FXE": [0] * 126 + [0, 0, 1, -1]}


def test_w24_is_long_the_strongest_and_short_the_weakest_of_the_twins():
    up = [100.0 * 1.001 ** index for index in range(100)]
    down = [100.0 * 0.999 ** index for index in range(100)]
    stance = _stance("qj/W24", _inputs(_bars("FXE", [100.0] * 100), _bars("FXB", up), _bars("FXA", down)))
    assert stance["FXB"] == [0] * 63 + [1] * 37
    assert stance["FXA"] == [0] * 63 + [-1] * 37
    assert stance["FXE"] == [0] * 100


def test_w24_ranks_the_twins_that_have_a_return_and_needs_two_of_them():
    days = trading_days(START, 100)
    up = [100.0 * 1.001 ** index for index in range(100)]
    late = _bars("FXA", [100.0 * 1.002 ** index for index in range(90)], dates=days[10:])
    stance = _stance("qj/W24", _inputs(_bars("FXE", [100.0] * 100), _bars("FXB", up), late))
    # Bars 63 to 72: FXA has no 63-bar return yet, so FXB is long and FXE short. Then FXA leads.
    assert stance["FXB"] == [0] * 63 + [1] * 10 + [0] * 27
    assert stance["FXE"] == [0] * 63 + [-1] * 37
    assert stance["FXA"] == [0] * 63 + [1] * 27
    assert _stance("qj/W24", _inputs(_bars("FXB", up))) == {"FXB": [0] * 100}


def test_w24_gives_a_tie_to_the_first_twin_and_the_short_side_when_all_are_equal():
    same = [100.0 * 1.001 ** index for index in range(70)]
    stance = _stance("qj/W24", _inputs(_bars("FXE", same), _bars("FXB", same), _bars("FXA", same)))
    assert stance["FXE"][63:] == [-1] * 7 and stance["FXB"][63:] == [0] * 7 and stance["FXA"][63:] == [0] * 7


# --------------------------------------------------------------------------- futures twins

def test_o20_follows_a_close_past_the_extremes_of_the_55_bars_before():
    closes, highs, lows = [100.0] * 90, [101.0] * 90, [99.0] * 90
    closes[30], highs[30] = 105.0, 106.0  # inside the first 55 bars: no signal
    closes[55], highs[55] = 105.5, 105.8  # under the high of bar 30
    closes[60], highs[60] = 107.0, 108.0  # over the highest high before; its own high does not count
    closes[70] = 100.0
    closes[80], lows[80] = 98.0, 97.0
    stance = _stance("qj/O20", _inputs(_bars("SPY", closes, highs=highs, lows=lows)))
    assert stance == {"SPY": [0] * 60 + [1] * 20 + [-1] * 10}
    assert BY_KEY["qj/O20"].symbols == ("SPY", "QQQ", "USO", "GLD")


def test_o20_reads_total_return_highs_and_lows():
    closes, highs, lows = [100.0] * 60, [101.0] * 60, [99.0] * 60
    closes[57], highs[57] = 101.5, 102.0
    # From bar 56 on the bars are worth 5% more in total-return terms: that breakout is on bar 56.
    adj = [value * (1.0 if index < 56 else 1.05) for index, value in enumerate(closes)]
    plain = _stance("qj/O20", _inputs(_bars("QQQ", closes, highs=highs, lows=lows)))
    scaled = _stance("qj/O20", _inputs(_bars("QQQ", closes, highs=highs, lows=lows, adj=adj)))
    assert plain["QQQ"] == [0] * 57 + [1] * 3
    assert scaled["QQQ"] == [0] * 56 + [1] * 4


def test_w25_is_the_sign_of_the_63_bar_mean_over_the_252_bar_mean():
    rising = [100.0 + 0.1 * index for index in range(300)]
    falling = [200.0 - 0.1 * index for index in range(300)]
    stance = _stance("qj/W25", _inputs(_bars("SPY", rising), _bars("CORN", falling), _bars("IEF", [50.0] * 300)))
    assert stance["SPY"] == [0] * 251 + [1] * 49
    assert stance["CORN"] == [0] * 251 + [-1] * 49
    assert stance["IEF"] == [0] * 300


# --------------------------------------------------------------------------- 10-month SMA timing

def test_sma_timing_decides_at_each_month_end_and_holds_until_the_next():
    days = trading_days(START, 300)
    months = sorted({day[:7] for day in days})
    level = {month: 100.0 for month in months}
    level[months[10]], level[months[11]], level[months[12]], level[months[13]] = 110.0, 90.0, 102.0, 105.0
    adj = [level[day[:7]] for day in days]
    bars = _bars("SPY", [50.0] * 300, adj=adj)
    ends = [index for index, last in enumerate(fm.period_ends(days, "month")) if last]
    stance = _stance("lib/zakamulin-sma", _inputs(bars))["SPY"]
    # 10th month-end: 100 is not above the mean 100. 11th: 110 is above 101. 12th: 90 is under 100.
    # 13th: 102 is above 100.2. 14th: 105 is above 100.7, held to the end of the data (the 15th
    # month is not complete).
    assert len(months) == 15 and len(ends) == 14
    assert stance[:ends[10]] == [0] * ends[10]
    assert stance[ends[10]:ends[11]] == [1] * (ends[11] - ends[10])
    assert stance[ends[11]:ends[12]] == [0] * (ends[12] - ends[11])
    assert stance[ends[12]:] == [1] * (300 - ends[12])


def test_sma_timing_decides_on_the_month_end_bar_without_a_later_bar():
    days = trading_days(START, 600)
    adj = _walk(31, 600, vol=0.02)
    full = fo.sma_timing_sides(_bars("SPY", adj))
    assert {0, 1} == set(full)
    ends = [index for index, last in enumerate(fm.period_ends(days, "month")) if last]
    changes = [end for end in ends if full[end] != full[end - 1]]
    assert len(changes) > 3 and all(full[index] == full[index - 1] for index in range(1, 600) if index not in ends)
    for size in range(200, 601):  # every cut, those that end on a month-end too
        assert fo.sma_timing_sides(_bars("SPY", adj[:size])) == full[:size], size
    for end in changes:  # the stance changes on the month-end bar itself, the last bar of the cut
        assert fo.sma_timing_sides(_bars("SPY", adj[:end + 1]))[-2:] == [full[end - 1], full[end]]
    later = [value * (3.0 if index > 400 else 1.0) for index, value in enumerate(adj)]
    assert fo.sma_timing_sides(_bars("SPY", later))[:401] == full[:401]


# --------------------------------------------------------------------------- iron condor

def _condor_case(symbol, seed, count=700):
    rng = random.Random(seed)
    adj = _walk(seed, count, vol=0.011)
    levels = tuple(None if index < 5 or index % 89 in (40, 41) else 10 + 22 * rng.random() for index in range(count))
    return _bars(symbol, [80.0] * count, adj=adj), levels


@pytest.mark.parametrize(("symbol", "index_id", "factor"), [("SPY", "VIX", 0.9), ("GLD", "GVZ", 0.95)])
def test_the_condor_entry_is_the_entry_rule_of_the_strangle_engine(symbol, index_id, factor):
    bars, levels = _condor_case(symbol, 41)
    assert om.ATM_FACTOR[index_id] == factor
    observations = [DailyObservation(date.fromisoformat(day), close, None if level is None else factor * level / 100)
                    for day, close, level in zip(bars.dates, bars.adj_close, levels)]
    engine = simulate_bridgingcycles_short_strangle(observations, black_scholes_marks())
    expected = [int(signal.eligible) for signal in engine.signals]
    assert fo.vrp_entries(bars, levels, index_id) == expected
    assert _stance("lib/short-strangle", _inputs(bars, iv={symbol: levels})) == {symbol: expected}
    assert 10 < sum(expected) < 200
    assert all(side == 0 for side, level in zip(expected, levels) if level is None)


def test_the_condor_needs_252_premiums_and_a_premium_above_zero():
    calm = [100.0] * 300
    wild = [100.0 * (1.08 if index % 2 else 1.0) for index in range(300)]
    levels = (VIX_FOR_20,) * 300
    # No realized volatility: the premium is the ATM IV on every bar, so it is at its 100th percentile
    # once 252 values exist. The first premium is on bar 21 (21 returns), the 252nd on bar 272.
    assert fo.vrp_entries(_bars("SPY", calm), levels, "VIX") == [0] * 272 + [1] * 28
    assert fo.vrp_entries(_bars("SPY", wild), levels, "VIX") == [0] * 300  # realized volatility over the IV
    gap = (*levels[:100], None, *levels[101:])
    assert fo.vrp_entries(_bars("SPY", calm), gap, "VIX") == [0] * 273 + [1] * 27  # a missing day is no value


def test_the_condor_is_at_or_above_the_90th_percentile_of_its_last_252_premiums():
    bars = _bars("SPY", [100.0] * 300)  # no realized volatility: the premium is 0.9 x level / 100
    levels = [20.0] * 300
    for index in range(100, 125):
        levels[index] = 30.0
    # The last 252 premiums are those of bars 48 to 299. 25 of them are above the last one:
    # 227 / 252 = 90.08% are at or below it.
    assert fo.vrp_entries(bars, levels, "VIX")[-1] == 1
    levels[125] = 30.0  # 26 above: 226 / 252 = 89.7%
    assert fo.vrp_entries(bars, levels, "VIX")[-1] == 0
    assert fo.vrp_entries(bars, levels, "VIX")[125] == 0  # the highest premium so far, but only 105 values


def test_the_condor_opens_both_credit_spreads_at_the_close_after_the_first_entry_bar():
    closes = [100.0] * 400
    bars, made = _bars("SPY", closes), market(closes)
    assert made.dates == bars.dates
    trades = fm.form_trades(BY_KEY["lib/short-strangle"], fm.Inputs({"SPY": bars}, {"SPY": made.iv_index}),
                            {"SPY": made}, start=START)
    first = [trade for trade in trades if trade.entry_index == 273]
    assert [trade.structure for trade in first] == ["putCreditVertical", "callCreditVertical"]
    assert all(trade.max_loss_pct == 1 for trade in trades) and trades[0].entry_index == 273
    put, call = first
    assert put.short_strike < 100 < call.short_strike
    assert put.long_strike < put.short_strike and call.long_strike > call.short_strike


def test_a_condor_stays_open_after_the_one_bar_its_entry_rule_holds():
    closes = [100.0] * 400
    # Every premium is the lowest so far, but the one of bar 300.
    levels = tuple(40.0 if index == 300 else 30.0 - 0.01 * index for index in range(400))
    bars, made = _bars("SPY", closes), market(closes, ivs=levels)
    inputs = fm.Inputs({"SPY": bars}, {"SPY": made.iv_index})
    assert _stance("lib/short-strangle", inputs) == {"SPY": [0] * 300 + [1] + [0] * 99}
    trades = fm.form_trades(BY_KEY["lib/short-strangle"], inputs, {"SPY": made}, start=START)
    assert [(trade.structure, trade.entry_index) for trade in trades] == [("putCreditVertical", 301),
                                                                         ("callCreditVertical", 301)]
    # The stance ends on bar 301. A form that is not entry only would close at the close of bar 302.
    assert all(trade.exit_reason != "signal" and trade.exit_index > 315 for trade in trades)


# --------------------------------------------------------------------------- leader pullback

def _leader_closes() -> list[float]:
    # tests/test_alert_templates.leader_fixture, then 80 quiet sessions: uptrend to about 299, a
    # saw-tooth (down 6, up 4), the reclaim of SMA(50) on bar 431.
    saw, price = [], 299.5
    for number in range(31):
        price += -6.0 if number % 2 == 0 else 4.0
        saw.append(price)
    return ramp(100, 0.5, 400) + saw + [300.0, 301.0] + ramp(301.5, 0.5, 80)


def _as_bars(symbol, daily, *, adj_factor=0.5) -> Bars:
    return Bars(symbol, tuple(bar.day.isoformat() for bar in daily), tuple(bar.open for bar in daily),
                tuple(bar.high for bar in daily), tuple(bar.low for bar in daily), tuple(bar.close for bar in daily),
                tuple(bar.close * adj_factor for bar in daily))


def test_the_reclaim_form_is_long_on_the_bar_of_the_alert_only():
    daily = bars_from(_leader_closes())
    assert [signal.index for signal in at.leader_pullback_and_reclaim(daily)] == [431]
    stance = _stance("leaders/reclaim", _inputs(_as_bars("AAA", daily)))
    assert stance == {"AAA": [0] * 431 + [1] + [0] * (len(daily) - 432)}


def test_the_dip_form_is_long_on_every_bar_in_the_pullback_state():
    daily = bars_from(_leader_closes())
    series = at.prepare(daily)
    state = [int(at.leader_pullback_price(series, index)) for index in range(len(daily))]
    assert 1 < sum(state) < 30 and state.index(1) < 431 and state[431] == 0
    assert _stance("leaders/dip", _inputs(_as_bars("BBB", daily))) == {"BBB": state}


def test_a_leader_spread_opens_after_the_alert_and_stays_open_when_the_stance_ends():
    daily = bars_from(_leader_closes())
    bars = _as_bars("AAA", daily)
    made = Market("AAA", bars.dates, bars.close, (VIX_FOR_20,) * len(bars), (0.0,) * len(bars))
    with fm.proxy_symbols({"AAA": fm.LIQUID_EQUITY}, {}):
        trades = fm.form_trades(BY_KEY["leaders/reclaim"], fm.Inputs({"AAA": bars}, {"AAA": made.iv_index}),
                                {"AAA": made}, start=bars.dates[0])
    assert len(trades) == 1
    trade = trades[0]
    assert (trade.structure, trade.entry_index, trade.max_loss_pct) == ("callDebitVertical", 432, 0.5)
    # The stance ends on bar 432. A form that is not entry only would close at the close of bar 433.
    assert trade.exit_reason != "signal" and trade.exit_index > 450


def test_the_leader_bars_are_unadjusted_and_pass_the_liquidity_filter_without_volume():
    daily = bars_from(_leader_closes())
    without_volume = bars_from(_leader_closes(), volumes=[0.0] * len(daily))
    assert at.leader_pullback_and_reclaim(without_volume) == []  # the filter would refuse a bar without volume
    half, same = _as_bars("AAA", daily, adj_factor=0.5), _as_bars("AAA", daily, adj_factor=1.0)
    assert fo.reclaim_sides(half) == fo.reclaim_sides(same) and fo.dip_sides(half) == fo.dip_sides(same)
    positions, made = fo.daily_bars(half)
    assert positions == list(range(len(daily)))
    assert [(bar.day, bar.open, bar.high, bar.low, bar.close) for bar in made] == [
        (bar.day, bar.open, bar.high, bar.low, bar.close) for bar in daily]
    assert {bar.volume for bar in made} == {fo.ALERT_VOLUME} and fo.ALERT_VOLUME > 2e6


def test_the_leader_bars_widen_high_and_low_and_leave_out_a_row_without_a_price():
    days = trading_days(START, 4)
    bars = Bars("AAA", days, (10.0, 0.0, 12.0, 11.0), (10.5, 11.0, 11.5, 11.2), (9.5, 10.0, 11.9, 10.8),
                (10.2, 10.5, 11.8, 11.0), (10.2, 10.5, 11.8, 11.0))
    positions, made = fo.daily_bars(bars)
    assert positions == [0, 2, 3]  # the open of bar 1 is 0
    assert (made[1].high, made[1].low) == (12.0, 11.8)  # the source high 11.5 and low 11.9 are inside open and close
    assert fo.reclaim_sides(bars) == [0, 0, 0, 0] == fo.dip_sides(bars)


def test_a_leader_rule_gives_a_stance_for_the_symbols_that_have_bars():
    daily = bars_from(_leader_closes())
    stance = _stance("leaders/reclaim", _inputs(_as_bars("CCC", daily), _as_bars("AAA", daily)))
    assert set(stance) == {"AAA", "CCC"} and stance["AAA"] == stance["CCC"]


# --------------------------------------------------------------------------- no look-ahead

COUNT = 700
DAYS = trading_days(START, COUNT)
MONTH_ENDS = [index for index, last in enumerate(fm.period_ends(DAYS, "month")) if last]
# Every form has a stance other than 0 on these random bars, so no check below is empty.
SEED = 5


def _random_inputs(symbols, seed=SEED) -> fm.Inputs:
    """Random-walk bars with an upward drift; every third symbol starts 40 bars later; IV gaps."""
    rng = random.Random(seed)
    bars, index = {}, {}
    for number, symbol in enumerate(symbols):
        size = COUNT - (40 if number % 3 == 2 else 0)
        close, opens, highs, lows, closes = 100.0, [], [], [], []
        for _ in range(size):
            open_ = close * (1 + rng.gauss(0, 0.003))
            close = open_ * (1 + rng.gauss(0.0006, 0.013))
            opens.append(open_)
            closes.append(close)
            highs.append(max(open_, close) * (1 + abs(rng.gauss(0, 0.004))))
            lows.append(min(open_, close) * (1 - abs(rng.gauss(0, 0.004))))
        adj = [value * (0.9 + 0.1 * position / size) for position, value in enumerate(closes)]
        bars[symbol] = Bars(symbol, DAYS[COUNT - size:], tuple(opens), tuple(highs), tuple(lows), tuple(closes),
                            tuple(adj))
        index[symbol] = tuple(None if position < 5 or position % 83 == 60 else 12 + 20 * rng.random()
                              for position in range(size))
    return fm.Inputs(bars, index)


def _cut(inputs: fm.Inputs, last_day: str) -> fm.Inputs:
    bars, index = {}, {}
    for symbol, full in inputs.bars.items():
        size = sum(1 for day in full.dates if day <= last_day)
        bars[symbol] = Bars(symbol, *(column[:size] for column in (full.dates, full.open, full.high, full.low,
                                                                    full.close, full.adj_close)))
        index[symbol] = tuple(inputs.iv_index[symbol][:size])
    return fm.Inputs(bars, index)


def _changed_after(inputs: fm.Inputs, last_day: str, seed: int) -> fm.Inputs:
    """The same calendar; every price and IV level after `last_day` is another one."""
    rng = random.Random(seed)
    bars, index = {}, {}
    for symbol, full in inputs.bars.items():
        size = sum(1 for day in full.dates if day <= last_day)
        factors = [1.0] * size + [math.exp(rng.gauss(0.0, 0.2)) for _ in range(len(full) - size)]
        columns = (tuple(value * factor for value, factor in zip(column, factors))
                   for column in (full.open, full.high, full.low, full.close, full.adj_close))
        bars[symbol] = Bars(symbol, full.dates, *columns)
        index[symbol] = (*inputs.iv_index[symbol][:size], *(5 + 60 * rng.random() for _ in range(len(full) - size)))
    return fm.Inputs(bars, index)


ALL_FORMS = tuple(BY_KEY.values())


def test_the_random_bars_give_every_form_a_stance():
    for form in ALL_FORMS:
        stance = fm.stance_of(form, _random_inputs(form.symbols))
        assert set(stance) == set(form.symbols)
        assert any(side != 0 for sides in stance.values() for side in sides), form.key


@pytest.mark.parametrize("form", ALL_FORMS, ids=lambda form: form.key)
def test_no_rule_reads_a_bar_after_the_day_of_its_stance(form):
    """Pairs, twins, SMA timing, condor and both leader rules: the stance of the first n bars is the
    same with and without the later bars."""
    inputs = _random_inputs(form.symbols)
    full = fm.stance_of(form, inputs)
    # Cuts on any bar, and cuts whose last bar is a month-end.
    sizes = (*range(130, COUNT, 23), 271, 272, 273, 274, COUNT - 1, *(end + 1 for end in MONTH_ENDS[6:]))
    assert len(sizes) > 50
    for size in sizes:
        part = fm.stance_of(form, _cut(inputs, DAYS[size - 1]))
        for symbol, sides in part.items():
            assert sides == full[symbol][:len(sides)], f"{form.key} {symbol} changes with later bars (cut {size})"


@pytest.mark.parametrize("form", ALL_FORMS, ids=lambda form: form.key)
def test_no_rule_reads_a_later_price_or_iv_level(form):
    inputs = _random_inputs(form.symbols)
    full = fm.stance_of(form, inputs)
    differs = 0
    # Month-ends are among the cuts: the calendar stays, so the month-end bar is known.
    for number, size in enumerate((150, 273, 400, 521, 640, *(end + 1 for end in MONTH_ENDS[8:30:3]))):
        changed = fm.stance_of(form, _changed_after(inputs, DAYS[size - 1], seed=number))
        for symbol, sides in changed.items():
            known = sum(1 for day in inputs.bars[symbol].dates if day <= DAYS[size - 1])
            assert sides[:known] == full[symbol][:known], f"{form.key} {symbol} reads a later value (after {size})"
        differs += changed != full
    assert differs > 6, f"{form.key}: the later values must matter"
