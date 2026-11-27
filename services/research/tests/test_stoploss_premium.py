"""Tests of the stopping-premium study (strategies/stoploss_premium): hand-computed fixtures, no network."""
from __future__ import annotations

import math
from datetime import date, timedelta

import pytest
from strategies.qc_ports.data import Bars
from strategies.stoploss_premium import bars, books, csp, entries, optiontests, portfolio, premium, report, shares
from strategies.stoploss_premium.options import (Leg, Underlying, expiration, leaps_expiry, open_trade,
                                                 strike_for_delta, target_expiry)


def make_series(closes, symbol="TEST", start=date(2020, 1, 2), spread=0.01, lows=None, opens=None):
    """Weekday series; high/low = close +/- spread x close unless lows/opens are given."""
    dates, d = [], start
    while len(dates) < len(closes):
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d += timedelta(days=1)
    lo = lows or [c * (1 - spread) for c in closes]
    op = opens or list(closes)
    hi = [c * (1 + spread) for c in closes]
    return bars.series_from(Bars(symbol, tuple(dates), tuple(op), tuple(hi), tuple(lo), tuple(closes),
                                 tuple(closes)))


def legs(w, o, rf=None, out=None, events=0):
    n = len(w)
    return premium.Legs(tuple(f"d{i:04d}" for i in range(n)), tuple(w), tuple(o), tuple(rf or [0.0] * n),
                        tuple(out or [0.0] * n), events)


# --- premium -----------------------------------------------------------------------------------------

class TestPremium:
    def test_max_drawdown_of_a_fall_and_recovery(self):
        assert premium.max_drawdown([0.1, -0.5, 1.0]) == pytest.approx(-0.5)
        assert premium.max_drawdown([0.01, 0.02]) == 0.0

    def test_compound_drops_the_incomplete_block(self):
        assert premium.compound([0.1, 0.1, -0.5], 2) == pytest.approx([0.21])
        with pytest.raises(ValueError):
            premium.compound([0.1], 0)

    def test_autocorrelation_of_alternating_series_is_negative(self):
        assert premium.autocorrelation([1, -1, 1, -1, 1, -1]) < -0.8
        assert premium.autocorrelation([1, 1]) is None
        assert premium.autocorrelation([2, 2, 2]) is None

    def test_premium_is_the_difference_of_annual_means(self):
        lg = legs([0.001] * 10, [0.002] * 10)
        assert premium.premium(lg) == pytest.approx(-0.001 * 252)

    def test_legs_validate_lengths(self):
        with pytest.raises(ValueError):
            premium.Legs(("a",), (0.0,), (0.0, 0.0), (0.0,), (0.0,), 0)
        with pytest.raises(ValueError):
            premium.Legs((), (), (), (), (), 0)
        with pytest.raises(ValueError):
            legs([0.0], [0.0], events=-1)

    def test_bootstrap_is_reproducible_and_brackets_a_constant(self):
        diff = [0.001] * 50
        lo, hi = premium.block_bootstrap(diff, reps=50)
        assert lo == pytest.approx(0.252) and hi == pytest.approx(0.252)
        assert premium.block_bootstrap([0.001, -0.002, 0.0] * 20, reps=40) == premium.block_bootstrap(
            [0.001, -0.002, 0.0] * 20, reps=40)
        with pytest.raises(ValueError):
            premium.block_bootstrap([])

    def test_summary_implies_the_stopped_return_of_equation_4(self):
        # rule out half the time; dmu = p0 (rf - E[r|stopped]) -> E[r|stopped] = rf - dmu / p0
        w = [0.0001, 0.0001] * 50
        o = [0.0001, 0.0005] * 50
        rf = [0.0001] * 100
        s = premium.summary(legs(w, o, rf, [0.0, 1.0] * 50, 120), 5)
        assert s["p0"] == pytest.approx(0.5)
        assert s["impliedStoppedReturn"] == pytest.approx(0.0005 * 252)
        assert s["condition"]["stepDays"] == 5

    def _s(self, **kw):
        base = {"stopEvents": 200, "premium": 0.01, "interval": [0.001, 0.02], "halves": [0.01, 0.01],
                "mddWith": -0.2, "mddWithout": -0.2}
        base.update(kw)
        return base

    def test_verdicts(self):
        assert premium.verdict(self._s(stopEvents=99), [0.1, 0.1]) == premium.NOT_ENOUGH
        assert premium.verdict(self._s(), [0.01, 0.01]) == premium.ADDS_RETURN
        assert premium.verdict(self._s(), [0.01, -0.01]) == premium.INCONCLUSIVE
        assert premium.verdict(self._s(halves=[0.01, -0.01]), [0.01, 0.01]) == premium.INCONCLUSIVE
        ins = self._s(premium=-0.01, interval=[-0.02, -0.001], mddWith=-0.1)
        assert premium.verdict(ins, [-0.01, -0.01]) == premium.PAID_INSURANCE
        fail = self._s(premium=-0.01, interval=[-0.02, -0.001], mddWith=-0.19)
        assert premium.verdict(fail, [-0.01, -0.01]) == premium.FAIL
        unclear = self._s(premium=-0.01, interval=[-0.02, 0.001], mddWith=-0.19)
        assert premium.verdict(unclear, []) == premium.INCONCLUSIVE

    def test_insurance_cost_per_point_of_drawdown(self):
        assert premium.insurance_cost({"premium": -0.02, "mddWith": -0.3, "mddWithout": -0.5}) == pytest.approx(0.001)
        assert premium.insurance_cost({"premium": -0.02, "mddWith": -0.5, "mddWithout": -0.4}) is None
        assert premium.drawdown_cut({"mddWith": -0.3, "mddWithout": 0.0}) == 0.0


# --- bars and portfolio ------------------------------------------------------------------------------

class TestBars:
    def test_series_scales_ohlc_to_total_return_and_keeps_raw_close(self):
        s = bars.series_from(Bars("X", ("2020-01-02", "2020-01-03"), (10.0, 0.0), (11.0, 1.0), (9.0, 1.0),
                                  (10.0, 1.0), (5.0, 1.0)))
        assert s.dates == ("2020-01-02",) and s.close == (5.0,) and s.high == (5.5,) and s.raw_close == (10.0,)

    def test_load_bars_and_index_read_the_qc_ports_format(self, tmp_path):
        (tmp_path / "X.csv").write_text("date,open,high,low,close,adj_close\n2020-01-02,10,11,9,10,5\n")
        (tmp_path / "IRX.csv").write_text("date,close\n2020-01-02,2.52\n")
        assert bars.load_bars(tmp_path / "X.csv").close == (5.0,)
        assert bars.load_index(tmp_path / "IRX.csv") == {"2020-01-02": 2.52}

    def test_series_rejects_bad_dates(self):
        with pytest.raises(ValueError):
            bars.Series("X", ("b", "a"), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1))
        with pytest.raises(ValueError):
            bars.Series("X", ("a",), (1,), (1,), (1,), (1,), ())

    def test_daily_rf_carries_forward(self):
        assert bars.daily_rf({"b": 2.52}, ["a", "b", "c"]) == pytest.approx([0.0, 0.0001, 0.0001])

    def test_atr_and_extremes(self):
        # true range from bar 1 (bar 0 has no previous close): 2, 2 -> the 2-bar mean starts at bar 2
        a = bars.atr([2, 3, 4], [1, 1, 2], [1.5, 2, 3], 2)
        assert a[0] is None and a[1] is None and a[2] == pytest.approx(2.0)
        assert bars.rolling_extreme([3, 1, 2], 2, lowest=True) == [None, None, 1]
        assert bars.rolling_extreme([3, 1, 2], 2, lowest=False, include_today=True) == [None, 3, 2]
        with pytest.raises(ValueError):
            bars.rolling_mean([1], 0)

    def test_zscore_and_month_ends(self):
        z = bars.zscore([1, 1, 1, 1, 0], 5)
        assert z[-1] == pytest.approx((0 - 0.8) / math.sqrt(0.2))
        assert bars.zscore([1, 1, 1], 3)[-1] is None
        assert bars.month_ends(["2020-01-30", "2020-01-31", "2020-02-03", "2020-02-04"]) == {1}

    def test_realized_vol_of_a_constant_drift_is_zero(self):
        rv = bars.realized_vol([100 * 1.01 ** i for i in range(30)], 20)
        assert rv[19] is None and rv[25] == pytest.approx(0.0, abs=1e-12)


class TestPortfolio:
    def test_aggregate_averages_active_paths_and_fills_idle_days_with_rf(self):
        a = portfolio.PathReturns(start=0, stop_events=2, days_to_stop=3)
        a.add(0.02, 0.01, 0.5)
        b = portfolio.PathReturns(start=0)
        b.add(0.0, 0.03, 0.0)
        c = portfolio.PathReturns(start=2)
        c.add(0.1, 0.1, 0.0)
        lg = portfolio.aggregate(["a", "b", "c"], [0.001, 0.002, 0.003], [a, b, c])
        assert lg.with_rule == pytest.approx((0.01, 0.002, 0.1))
        assert lg.without == pytest.approx((0.02, 0.002, 0.1))
        assert lg.out == pytest.approx((0.25, 0.0, 0.0)) and lg.stop_events == 2

    def test_value_weighted_book_uses_the_previous_value(self):
        # one trade worth 1 -> 0.1 -> 0.2: the book loses 90%, then doubles (an equal-weight mean of
        # increments per entry unit would wrongly show +10% on day 2)
        p = portfolio.PathReturns(start=0)
        p.add(-0.9, -0.9, 0.0)
        p.add(0.1, 0.1, 0.0)
        lg = portfolio.aggregate(["a", "b"], [0.0, 0.0], [p], value_weighted=True)
        assert lg.without == pytest.approx((-0.9, 1.0))
        assert premium.max_drawdown(lg.without) == pytest.approx(-0.9)

    def test_value_weighted_book_weights_by_value_and_mixes_the_safe_asset(self):
        big = portfolio.PathReturns(start=0)
        big.add(1.0, 1.0, 0.0)   # worth 2 after day a
        big.add(0.2, 0.2, 0.0)   # +10% on day b
        small = portfolio.PathReturns(start=1)
        small.add(-0.5, 0.0, 1.0)
        book = portfolio.aggregate(["a", "b"], [0.001, 0.001], [big, small], value_weighted=True)
        lg = portfolio.with_exposure(book, 0.25)
        assert lg.without[1] == pytest.approx(0.25 * (0.2 / 3) + 0.75 * 0.001)
        assert lg.with_rule[1] == pytest.approx(0.25 * (-0.3 / 3) + 0.75 * 0.001)
        assert lg.out[1] == pytest.approx(0.25 * 1 / 3)
        with pytest.raises(ValueError):
            portfolio.with_exposure(book, 0.0)

    def test_trade_returns(self):
        a = portfolio.PathReturns(start=0)
        a.add(0.5, -0.2, 0.0)
        b = portfolio.PathReturns(start=0)
        b.add(-0.1, 0.1, 0.0)
        r = portfolio.trade_returns([a, b])
        assert r["trades"] == 2 and r["meanDiff"] == pytest.approx(0.25) and r["shareBetter"] == 0.5
        assert portfolio.trade_returns([])["trades"] == 0

    def test_aggregate_errors_and_stop_step(self):
        with pytest.raises(ValueError):
            portfolio.aggregate(["a"], [0.0, 0.0], [])
        with pytest.raises(ValueError):
            portfolio.aggregate(["a"], [0.0], [portfolio.PathReturns(start=0)])
        ps = [portfolio.PathReturns(0, days_to_stop=d) for d in (5, 1, 9)] + [portfolio.PathReturns(0)]
        assert portfolio.stop_step(ps) == 5 and portfolio.stop_step([]) == 21


# --- test A ------------------------------------------------------------------------------------------

# Golden values: outputs of the live market-watch-bot functions at commit 57a1b3b (harness.compute_levels with
# no put-OI levels, stops.new_ladder, leaps.ladder_levels, risk.trade_risk_pct, rotation._pct_rank), computed
# once on 2026-11-27 and copied here; the study cannot import that repository.

class TestShares:
    @pytest.mark.parametrize("args, expected", [
        ((100.0, 98.5, 97.0, 94.0, 92.0, 90.0), [98.5, 94.0, 90.0]),
        ((100.0, None, None, None, None, None), [99.0, 92.0, 85.0]),
        ((100.0, None, None, None, 98.9, None), [99.0, 98.01, 97.02]),
        ((212.4, 210.0, 205.3, 198.7, 201.2, 190.4), [210.0, 198.7, 190.4]),
    ])
    def test_compute_levels_matches_the_live_harness(self, args, expected):
        last, today_low, low5, low20, ma50, swing = args
        assert shares.compute_levels(last, today_low=today_low, low5=low5, low20=low20, ma50=ma50,
                                     swing=swing) == pytest.approx(expected)

    @pytest.mark.parametrize("levels, last, atr14, mult, expected", [
        ([99.0, 98.9, 90.0], 100.0, 2.0, 1.0, [97.8, 97.3, 90.0]),
        ([99.0, 94.0, 90.0], 100.0, 3.0, 2.0, [93.7, 92.95, 90.0]),
    ])
    def test_min_atr_matches_the_live_new_ladder(self, levels, last, atr14, mult, expected):
        assert shares.min_atr(levels, last, atr14, mult) == pytest.approx(expected)

    def test_scale_five_and_round_handles(self):
        assert shares.scale_levels([90.0], 100.0, 1.25) == pytest.approx([87.5])
        assert shares.five_levels([10, 8, 6]) == [10, 9.0, 8, 7.0, 6]
        assert shares.adjust_sell(97.33, 2.0) == 97.33 and shares.adjust_sell(105.0, 0.1) == 104.97
        assert shares.adjust_sell(98.5, 0.2) == 98.47  # .50 handle moves 3 cents down
        # rungs 1% apart are kept; a crowded ladder is widened and spaced evenly
        assert shares.spaced_five([100.0, 96.0, 92.0], 100.0) == [100.0, 98.0, 96.0, 94.0, 92.0]
        assert shares.spaced_five([100.0, 99.5, 99.0], 100.0) == pytest.approx([100.0, 99.0, 98.0, 97.0, 96.0], abs=0.011)
        assert shares.compute_levels(100.0, today_low=None, low5=None, low20=None, ma50=None, swing=None) is not None

    def test_swing_low_finds_the_latest_pivot(self):
        assert shares.swing_low([5, 4, 3, 4, 5, 2, 3, 4], 10) == 2
        assert shares.swing_low([5, 4, 3, 4, 5, 2, 3, 4], 2.5) == 2
        assert shares.swing_low([5, 4, 3, 4, 5, 2, 3, 4], 2) is None
        assert shares.swing_low([5, 5, 5, 5, 5], 10) is None

    def test_ladder_path_sells_on_a_fall_and_holds_on_a_rise(self):
        up = make_series([100 + i * 0.1 for i in range(120)])
        p = shares.ladder_path(up, 60, 120, [0.0] * 120, 0)
        assert p.stop_events == 0 and len(p) == 59
        assert sum(p.with_rule) == pytest.approx(sum(p.without), rel=0.01)
        down = make_series([100 + i * 0.1 for i in range(60)] + [106 - 2 * i for i in range(30)])
        q = shares.ladder_path(down, 59, 90, [0.0] * 90, 0)
        assert q.stop_events >= 3 and q.days_to_stop is not None
        assert sum(q.with_rule) > sum(q.without)  # out of the fall
        assert max(q.out) == pytest.approx(1.0, abs=1e-6)

    def test_window_stop_exits_after_a_10pct_month_and_reenters(self):
        closes = [100.0] * 30 + [100 - i for i in range(1, 16)] + [85 + i for i in range(1, 30)]
        s = make_series(closes)
        p = shares.window_stop_path(s, 25, len(closes), [0.0] * len(closes), 0)
        assert p.stop_events == 1 and 1.0 in p.out and p.out[-1] == 0.0


# --- entries -----------------------------------------------------------------------------------------

class TestEntries:
    def test_breakout_and_zdip_entries(self):
        flat = [100 + (i % 3) * 0.2 for i in range(40)]
        s = make_series(flat + [103.0] + [103.0] * 5 + [95.0])
        kinds = {e.kind: e for e in entries.signals(s)}
        assert "acceptance" in kinds and kinds["acceptance"].family == "momentum"
        a = kinds["acceptance"]
        assert a.stop <= a.price - a.atr
        assert "zdip" in kinds and kinds["zdip"].family == "dip"

    def test_reclaim_after_a_break_of_support(self):
        flat = [100 + (i % 2) * 0.5 for i in range(30)]
        closes = flat + [97.0, 99.0, 101.5]
        lows = [c * 0.99 for c in flat] + [96.5, 98.0, 100.0]
        s = make_series(closes, lows=lows)
        es = [e for e in entries.signals(s) if e.kind == "reclaim"]
        assert es and es[0].i == len(closes) - 1

    def test_failed_breakdown(self):
        flat = [100 + (i % 2) * 0.5 for i in range(30)]
        closes = flat + [100.0]
        lows = [c * 0.995 for c in flat] + [98.0]
        s = make_series(closes, lows=lows)
        assert any(e.kind == "failed_breakdown" for e in entries.signals(s))

    def test_floor_stop(self):
        assert entries.floor_stop(100, 99.5, 2.0) == 98.0
        assert entries.floor_stop(100, 90, 2.0) == 90


# --- options -----------------------------------------------------------------------------------------

class TestOptions:
    def test_expiry_helpers(self):
        assert expiration(2026, 11) == date(2026, 11, 20)
        assert expiration(2025, 4) == date(2025, 4, 17)  # Good Friday 2025-04-18: the session before
        assert leaps_expiry(date(2026, 1, 5)) == date(2027, 1, 15)
        assert target_expiry(date(2026, 1, 5), 30, 60, 45) == date(2026, 2, 20)
        assert target_expiry(date(2026, 1, 5), 100, 101, 100) is None

    def _u(self, n=400, drift=0.0005):
        s = make_series([100 * math.exp(drift * i + 0.01 * math.sin(i)) for i in range(n)])
        return Underlying(s)

    def test_strike_for_delta_and_quote(self):
        u = self._u()
        i = 300
        exp = u.dates[i] + timedelta(days=60)
        k = strike_for_delta(u, i, exp, "call", 0.75)
        assert k is not None and k < u.close[i]
        q = u.quote((Leg("call", k, 1),), i, exp)
        assert q is not None and q[0] > u.close[i] - k and q[1] > 0
        assert u.atm(10, 0.1) is None

    def test_open_trade_values_at_intrinsic_on_expiry(self):
        u = self._u()
        exp = expiration(u.dates[340].year, u.dates[340].month)
        if exp < u.dates[340]:
            exp = u.dates[340] + timedelta(days=(4 - u.dates[340].weekday()) % 7 or 7)
        t = open_trade(u, (Leg("call", 100.0, 1),), 300, exp)
        assert t is not None and t.debit > t.mids[0]
        assert t.mids[-1] == pytest.approx(max(0.0, u.close[t.expiry_i] - 100.0))
        assert open_trade(u, (Leg("call", 100.0, 1),), 300, u.dates[-1] + timedelta(days=30)) is None

    @pytest.mark.parametrize("args, expected", [
        ((100.0, 90.0, 3.0), [95.0, 93.75, 92.5, 91.25, 90.0]),
        ((100.0, 97.0, 1.0), [98.5, 98.12, 97.75, 97.37, 97.0]),
        ((250.0, 240.0, 6.5), [243.5, 242.62, 241.75, 240.87, 240.0]),
        ((50.0, 49.5, 2.0), [49.5, 49.5, 49.5, 49.5, 49.5]),
    ])
    def test_ladder_levels_match_the_live_leaps_rule(self, args, expected):
        assert optiontests.ladder_levels(*args) == pytest.approx(expected)
        assert optiontests.LADDER_WEIGHTS == (0.10, 0.15, 0.20, 0.25, 0.30) and optiontests.LAST_CHANCE_DAYS == 2

    def test_rules_on_a_falling_name(self):
        u = Underlying(make_series([100.0] * 80 + [100 - 0.7 * i for i in range(1, 60)]))
        exp = u.dates[-1] - timedelta(days=1)
        t = open_trade(u, (Leg("call", 100.0, 1),), 79, exp)
        assert t is not None
        stop = optiontests.path(t, optiontests.premium_stop_rule(0.5), [0.0] * len(u.close), 0)
        hold = optiontests.path(t, lambda *_: [], [0.0] * len(u.close), 0)
        assert stop.stop_events == 1 and hold.stop_events == 0
        assert sum(stop.with_rule) > sum(stop.without)  # the stop sold before the premium went to 0
        lad = optiontests.path(t, optiontests.ladder_rule([99.0, 97.0, 95.0, 93.0, 91.0]), [0.0] * len(u.close), 0)
        assert lad.stop_events == 5
        loser = optiontests.path(t, optiontests.loser_close_rule(3), [0.0] * len(u.close), 0)
        assert loser.stop_events == 1


# --- test F ------------------------------------------------------------------------------------------

class TestCsp:
    def _u(self, tail):
        return Underlying(make_series([50.0 + 0.3 * math.sin(i) for i in range(120)] + tail))

    def test_take_profit_on_a_quiet_name(self):
        u = self._u([50.0 + 0.1 * math.sin(i) for i in range(80)])
        days = csp.entry_days(u, 100, 160)
        assert days
        i, e = days[0]
        pos = csp.open_put(u, i, e)
        assert pos is not None and pos.strike < 50
        v, ev = csp.simulate(u, pos, i, [0.0] * len(u.close))
        assert ev == [] and v[-1] > 1.0

    def test_stop_and_roll_on_a_crash(self):
        u = self._u([50.0 - 0.6 * j for j in range(80)])
        i, e = csp.entry_days(u, 100, 160)[0]
        pos = csp.open_put(u, i, e)
        assert pos is not None
        rf = [0.0] * len(u.close)
        base, _ = csp.simulate(u, pos, i, rf)
        stop, ev = csp.simulate(u, pos, i, rf, stop_mult=2.0)
        assert len(ev) == 1 and ev[0] == len(stop) - 1 and stop[-1] > base[-1]
        roll, rev = csp.simulate(u, pos, i, rf, roll=True)
        assert len(rev) >= 1
        p = csp.pair(stop, base, rf, i, 0, ev)
        assert len(p) == max(len(stop), len(base)) and p.stop_events == 1 and p.days_to_stop == ev[0] + 1


# --- tests G and H -----------------------------------------------------------------------------------

class TestBooks:
    def _al(self):
        n = 700
        up = make_series([100 * 1.0008 ** i for i in range(n)], "SPY")
        crash = make_series([100 * 1.001 ** i if i < 500 else 100 * 1.001 ** 500 * 0.995 ** (i - 500) for i in range(n)], "XLK")
        names = {"SPY": up, "XLK": crash}
        return names, books.align(names, list(up.dates))

    def test_trend_book_stop_and_brake(self):
        names, al = self._al()
        rf = [0.0] * len(al.calendar)
        sel = books.trend_selector()
        with_stop = books.atr_book(al, rf, sel, start=260, end=len(al.calendar))
        no_stop = books.atr_book(al, rf, sel, start=260, end=len(al.calendar), stop_atr=None)
        assert with_stop.stop_events >= 1 and no_stop.stop_events == 0
        assert len(with_stop.returns) == len(al.calendar) - 261 == len(with_stop.brake_flags)
        braked = books.atr_book(al, rf, sel, start=260, end=len(al.calendar), brake=(0.0001, 0.0002))
        assert braked.brake_events >= 1 and braked.brake_days >= 1

    @pytest.mark.parametrize("equity, level", [(100.0, 0), (91.0, 0), (90.0, 1), (86.0, 1), (85.0, 2), (80.0, 2)])
    def test_brake_level_matches_the_live_trade_risk(self, equity, level):
        # live trade_risk_pct: 1.0 / 1.0 / 0.5 / 0.5 / 0.0 / 0.0 at these equities against a peak of 100
        assert books.brake_level(equity, 100.0, (0.10, 0.15)) == level

    def test_rank_matches_the_live_rotation(self):
        assert books._rank({"A": 0.1, "B": -0.2, "C": 0.3}) == {"B": 0.0, "A": 0.5, "C": 1.0}

    def test_rotation_selector_ranks_relative_strength(self):
        names, al = self._al()
        pick = books.rotation_selector(hold=1)(al, 300)
        assert list(pick) == ["XLK"]

    def test_ten_month_rule_exits_a_falling_etf(self):
        names, _ = self._al()
        s = names["XLK"]
        p = books.ma_rule_path(s, 1, len(s.dates), [0.0] * len(s.dates), 0)
        assert p.stop_events == 1 and p.out[-1] == 1.0


# --- report ------------------------------------------------------------------------------------------

def test_report_page_has_one_table_per_test():
    s = premium.summary(legs([0.001, -0.002] * 30, [0.001, -0.001] * 30, events=150), 2)
    v = {"name": "x", "note": "n", "summary": s, "thresholds": [-0.1, -0.2], "verdict": premium.FAIL,
         "insuranceCost": None}
    e = {"name": "crown", "summary": {"stopEvents": 2}, "thresholds": [], "verdict": premium.NOT_ENOUGH}
    html = report.page("T", "<p>i</p>", [{"id": "A", "title": "a", "prices": "real", "variants": [v]},
                                          {"id": "E", "title": "e", "prices": "none", "variants": [e]}],
                       {"A": ["a.png"]}, "")
    assert html.count("<table>") == 2 and "a.png" in html and "class='v fail'" in html
    assert report.pct(None) == "–" and report.num(None) == "–"


def test_report_overview_lists_every_variant():
    s = premium.summary(legs([0.001] * 30, [0.002] * 30, events=150), 2)
    tests = [{"id": "A", "title": "a", "prices": "real", "variants": [{"name": "x", "summary": s, "verdict": premium.FAIL}]},
             {"id": "E", "title": "e", "prices": "none",
              "variants": [{"name": "crown", "summary": {"stopEvents": 2}, "verdict": premium.NOT_ENOUGH}]}]
    html = report.overview(tests, "summary.png")
    assert html.count("<tr>") == 3 and "summary.png" in html and "href='#test-E'" in html
    assert "not enough data" in html and report.overview([], None).count("<img") == 0


def test_comparison_rows_cannot_pass_adds_return():
    s = {"stopEvents": 200, "premium": 0.01, "interval": [0.001, 0.02], "halves": [0.01, 0.01],
         "mddWith": -0.2, "mddWithout": -0.2}
    assert premium.verdict(s, None) == premium.INCONCLUSIVE
    assert premium.verdict(s, [0.01, 0.02]) == premium.ADDS_RETURN


def test_distinct_stop_days_count_episodes_not_rungs():
    a = portfolio.PathReturns(start=0)
    a.stop(1, count=3)  # three rungs on one day
    a.add(0.0, 0.0, 0.0)
    b = portfolio.PathReturns(start=0)
    b.stop(1)  # another name, same calendar day
    b.add(0.0, 0.0, 0.0)
    b.stop(2)
    b.add(0.0, 0.0, 0.0)
    lg = portfolio.aggregate(["a", "b"], [0.0, 0.0], [a, b])
    assert lg.stop_events == 5 and lg.stop_days == 2 and a.days_to_stop == 1


def test_random_control_entries_are_reproducible():
    s = make_series([100 + 5 * math.sin(i / 7) for i in range(200)])
    real = entries.signals(s)
    assert real
    r1 = entries.random_entries(s, real, 11)
    assert r1 == entries.random_entries(s, real, 11) and len(r1) == len(real)
    assert all(e.kind == "random" and e.family == "random" and e.stop <= e.price - e.atr for e in r1)
    assert entries.random_entries(s, [], 11) == []


def test_iv_index_is_carried_at_most_five_sessions_and_spread_scales():
    s = make_series([100.0] * 12, symbol="SPY")
    levels = {s.dates[0]: 20.0}
    u = Underlying(s, levels, etf=True)
    assert u.atm(0, 0.1) == pytest.approx(0.18) and u.atm(5, 0.1) == pytest.approx(0.18) and u.atm(6, 0.1) is None
    half = Underlying(s, levels, etf=True, spread_scale=0.5)
    assert half.half == pytest.approx(u.half / 2)


def test_rate_raises_the_model_call_price():
    s = make_series([100 * math.exp(0.01 * math.sin(i)) for i in range(120)])
    zero, rated = Underlying(s), Underlying(s, rates=[0.05] * 120)
    exp = zero.dates[100] + timedelta(days=365)
    leg = (Leg("call", 90.0, 1),)
    assert rated.quote(leg, 100, exp)[0] > zero.quote(leg, 100, exp)[0]
    assert strike_for_delta(rated, 100, exp, "call", 0.75) >= strike_for_delta(zero, 100, exp, "call", 0.75)


def test_report_marks_headline_rows():
    s = premium.summary(legs([0.001] * 30, [0.002] * 30, events=150), 2)
    v = {"name": "x", "headline": True, "summary": s, "thresholds": [], "verdict": premium.FAIL}
    html = report.page("T", "", [{"id": "A", "title": "a", "prices": "real", "live": True, "variants": [v]}], {}, "")
    assert "★ x" in html and "headline row" in html
