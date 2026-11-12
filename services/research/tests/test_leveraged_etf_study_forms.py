"""Leveraged-ETF short-window study: signals, expiry rule, fund IV mapping, pricing of the five forms,
sizing and refusals, booking. Tiny synthetic bars; no network and no rig data file.

CI (scripts/ci/research-python.sh): the base lane has no numpy, so this file skips there as a whole (the
forms import the volspike option helpers, which need numpy); the Nautilus lane
(VERTEX_REQUIRE_NAUTILUS=1) runs every test and a missing numpy or engine is an error, not a skip."""
from __future__ import annotations

import math
import os
import unittest
from datetime import date, timedelta

import pytest

if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
    import numpy as np
else:
    np = pytest.importorskip("numpy", reason="the leveraged-ETF forms need numpy (Nautilus lane)")

from strategies import noise_band as nb  # noqa: E402 - after the optional-backend check
from strategies.imom import data as idata  # noqa: E402
from strategies.imom.options import years_to_close  # noqa: E402
from strategies.leveraged_etf import forms, pairs, prices, signals  # noqa: E402
from strategies.qc_ports import options as om  # noqa: E402
from strategies.qc_ports.book import OptionsSpec, choose_strikes, contracts_for, worst_exit_cost  # noqa: E402
from strategies.qc_ports.data import Market  # noqa: E402
from strategies.volspike import rules  # noqa: E402

QQQ = pairs.BY_UNDERLYING["QQQ"]
BARS_PER_SESSION = 78


def _nautilus_installed() -> bool:
    from strategies.qc_ports import nautilus_runner

    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_runner.require()
        return True
    try:
        nautilus_runner.require()
    except nautilus_runner.NautilusUnavailable:
        return False
    return True


def nyse_days(first: str, count: int) -> list[str]:
    out, day = [], date.fromisoformat(first)
    while len(out) < count:
        if not idata.is_closed(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def session_bars(days, closes_of) -> idata.SessionBars:
    """5-minute bars 09:30 to 16:00 of each day. `closes_of(day index)` gives the 78 closes; the open of a
    bar is the previous close of the session (100 for the first bar)."""
    cols = {key: [] for key in "tohlcv"}
    for index, day in enumerate(days):
        previous = 100.0
        for k, close in enumerate(closes_of(index)):
            cols["t"].append(idata.ms_at(day, idata.OPEN_MINUTE + 5 * k))
            cols["o"].append(previous)
            cols["h"].append(max(previous, close))
            cols["l"].append(min(previous, close))
            cols["c"].append(close)
            cols["v"].append(1000.0)
            previous = close
    return idata.SessionBars(*(tuple(cols[key]) for key in "tohlcv"), spread_bps=0.0)


QUIET = [100.1] * BARS_PER_SESSION  # every bar closes 0.1% above the open: sigma = 0.001 at every minute


def break_at(level: float, first_bar: int = 8) -> list[float]:
    """A quiet session that moves to `level` from bar `first_bar` (10:10 to 10:15) on."""
    return [100.1] * first_bar + [level] * (BARS_PER_SESSION - first_bar)


class SessionOpenMomentum(unittest.TestCase):
    DAYS = nyse_days("2024-01-02", 18)

    def run_with(self, special: dict[int, list[float]], days=None) -> list[signals.Signal]:
        days = days or self.DAYS
        bars = session_bars(days, lambda index: special.get(index, QUIET))
        return signals.session_open_momentum("QQQ", bars)

    def test_quiet_sessions_give_no_signal(self):
        self.assertEqual(self.run_with({}), [])

    def test_break_above_the_band_is_a_long_signal_at_the_first_decision_bar(self):
        found = self.run_with({15: break_at(100.5)})
        self.assertEqual(len(found), 1)
        item = found[0]
        # The price is above the band from 10:15, the first decision bar after that ends at 10:30.
        self.assertEqual((item.signal, item.underlying, item.side, item.day), (signals.S1, "QQQ", 1, self.DAYS[15]))
        self.assertEqual(item.entry_ms, idata.ms_at(self.DAYS[15], 10 * 60 + 30))
        self.assertEqual(item.price, 100.5)

    def test_break_below_the_band_is_a_short_signal(self):
        found = self.run_with({15: break_at(99.5)})
        self.assertEqual([(item.side, item.price) for item in found], [(-1, 99.5)])

    def test_one_signal_per_session_also_when_the_kernel_enters_again(self):
        # Up at 10:30, down through the stop and below the lower band, then up again: the kernel trades
        # more than once, the study uses the first entry only.
        closes = [100.1] * 8 + [100.5] * 10 + [99.0] * 20 + [101.5] * 40
        bars = session_bars(self.DAYS, lambda index: closes if index == 15 else QUIET)
        sessions, _ = signals.sessions_of(bars)
        kernel = nb.run_futures_backtest(sessions, [1.0] * len(sessions))
        self.assertGreater(sum(1 for trade in kernel.trades if trade.day.isoformat() == self.DAYS[15]), 1)
        found = signals.session_open_momentum("QQQ", bars)
        self.assertEqual([(item.day, item.side) for item in found], [(self.DAYS[15], 1)])

    def test_the_warm_up_sessions_give_no_signal(self):
        self.assertEqual(self.run_with({5: break_at(100.5)}), [])

    def test_a_session_after_a_missing_session_is_not_traded(self):
        days = self.DAYS[:15] + self.DAYS[16:]  # session 15 is missing: session 16 has an old previous close
        found = self.run_with({15: break_at(100.5)}, days)  # index 15 is now the day after the hole
        self.assertEqual(found, [])

    def test_sessions_of_groups_the_bars_by_new_york_day(self):
        bars = session_bars(self.DAYS[:3], lambda index: QUIET)
        sessions, times = signals.sessions_of(bars)
        self.assertEqual([session.day.isoformat() for session in sessions], self.DAYS[:3])
        self.assertEqual([len(session.bars) for session in sessions], [BARS_PER_SESSION] * 3)
        self.assertEqual((sessions[0].bars[0].minute, sessions[0].bars[-1].minute), (0, 385))
        self.assertEqual(times[1][0], idata.ms_at(self.DAYS[1], idata.OPEN_MINUTE))
        self.assertTrue(all(session.tradable for session in sessions))


def spike_minutes(day: str) -> rules.Minutes:
    """1-minute bars 06:00 to 12:30 New York: flat at 100, a volume spike that closes at 101 in the candle
    08:45 to 09:00 (long), flat at 101, then a volume spike that closes at 99 in the candle 10:00 to 10:15
    (short), flat at 99."""
    t, o, h, low, c, v = [], [], [], [], [], []
    price = 100.0
    for minute in range(6 * 60, 12 * 60 + 30):
        volume, close = 1.0, price
        if 8 * 60 + 45 <= minute < 9 * 60:
            volume = 10.0
            close = 101.0 if minute == 8 * 60 + 59 else price
        if 10 * 60 <= minute < 10 * 60 + 15:
            volume = 10.0
            close = 99.0 if minute == 10 * 60 + 14 else price
        t.append(rules.ny_ms(day, minute))
        o.append(price)
        h.append(max(price, close))
        low.append(min(price, close))
        c.append(close)
        v.append(volume)
        price = close
    return rules.Minutes(np.array(t, dtype=np.int64), *(np.array(col, dtype=np.float64) for col in (o, h, low, c, v)))


class VolumeSpikeBreakout(unittest.TestCase):
    DAY = "2024-03-04"
    PARAMS = rules.Params(vol_n=4, k=2, trend=False, skip_weekdays=(), stop_kind="none", time_stop=6)
    WINDOW = (rules.ny_ms("2024-03-03"), rules.ny_ms("2024-03-09"))

    def u_bars(self, day: str) -> idata.SessionBars:
        return session_bars([day], lambda index: [400.0 + k for k in range(BARS_PER_SESSION)])

    def test_a_signal_before_the_open_enters_at_0935_and_a_later_one_at_its_own_time(self):
        found, dropped = signals.volume_spike_breakout("QQQ", spike_minutes(self.DAY), self.u_bars(self.DAY),
                                                       *self.WINDOW, params=self.PARAMS)
        self.assertEqual(dropped, 0)
        self.assertEqual([(item.signal, item.side, item.day) for item in found],
                         [(signals.S2, 1, self.DAY), (signals.S2, -1, self.DAY)])
        # Rule entry 09:00 (before the open): the close of the first U bar, 09:35.
        self.assertEqual((found[0].entry_ms, found[0].price), (idata.ms_at(self.DAY, 9 * 60 + 35), 400.0))
        # Rule entry 10:15: the close of the U bar 10:10 to 10:15.
        self.assertEqual((found[1].entry_ms, found[1].price), (idata.ms_at(self.DAY, 10 * 60 + 15), 408.0))

    def test_a_signal_on_a_day_without_a_session_of_the_etf_is_dropped(self):
        found, dropped = signals.volume_spike_breakout("QQQ", spike_minutes(self.DAY), self.u_bars("2024-03-05"),
                                                       *self.WINDOW, params=self.PARAMS)
        self.assertEqual((found, dropped), ([], 2))

    def test_first_bar_ending_at(self):
        bars = self.u_bars(self.DAY)
        at = lambda minute: signals.first_bar_ending_at(bars.t, bars.c, idata.ms_at(self.DAY, minute))  # noqa: E731
        self.assertEqual(at(8 * 60 + 45), (self.DAY, idata.ms_at(self.DAY, 9 * 60 + 35), 400.0))
        self.assertEqual(at(9 * 60 + 30), (self.DAY, idata.ms_at(self.DAY, 9 * 60 + 35), 400.0))
        self.assertEqual(at(9 * 60 + 35), (self.DAY, idata.ms_at(self.DAY, 9 * 60 + 35), 400.0))
        self.assertEqual(at(12 * 60), (self.DAY, idata.ms_at(self.DAY, 12 * 60), 429.0))
        self.assertIsNone(at(16 * 60 + 1))
        self.assertIsNone(signals.first_bar_ending_at(bars.t, bars.c, idata.ms_at("2024-03-01", 10 * 60)))

    def test_the_dukascopy_index_of_each_pair(self):
        self.assertEqual([signals.source_market(u) for u in pairs.underlyings()],
                         ["NAS100", "US500", "US2000", "US30", "XAUUSD", "XAGUSD", "WTI"])
        with self.assertRaises(ValueError):
            signals.source_market("TQQQ")


class RegimeWindowAndOverlap(unittest.TestCase):
    DATES = ("2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08", "2024-03-11")
    GATE = {"maxVix": 25, "maxTermRatio": 1.0, "trendLength": 3}

    def signal(self, day: str, side: int = 1, minute: int = 630, underlying: str = "QQQ") -> signals.Signal:
        return signals.Signal(signals.S1, underlying, side, day, idata.ms_at(day, minute), 100.0)

    def test_calm_days_need_low_vix_contango_and_a_trend(self):
        closes = (10.0, 11.0, 12.0, 11.0, 9.0, 9.5)
        vix = dict(zip(self.DATES, (15.0, 15.0, 15.0, 26.0, 20.0, 20.0)))
        vix3m = dict(zip(self.DATES, (17.0, 17.0, 17.0, 27.0, 19.0, 21.0)))
        allowed = signals.calm_days(self.DATES, closes, vix, vix3m, self.GATE)
        # No 3-day average yet; above the average; VIX above 25; VIX above VIX3M; below the average.
        self.assertEqual(allowed, [0, 0, 1, 0, 0, -1])

    def test_calm_days_treat_a_missing_value_as_not_calm(self):
        closes = (10.0, 11.0, 12.0, 13.0, 14.0, 15.0)
        vix = dict.fromkeys(self.DATES, 15.0)
        self.assertEqual(signals.calm_days(self.DATES, closes, vix, {}, self.GATE), [0] * 6)

    def test_the_limits_of_the_gate_are_inside_the_calm_regime(self):
        closes = (10.0, 11.0, 12.0, 13.0, 14.0, 15.0)
        allowed = signals.calm_days(self.DATES, closes, dict.fromkeys(self.DATES, 25.0),
                                    dict.fromkeys(self.DATES, 25.0), self.GATE)
        self.assertEqual(allowed, [0, 0, 1, 1, 1, 1])

    def test_in_regime_reads_the_close_before_the_signal_day(self):
        allowed = [0, 1, -1, 0, 1, 1]
        long_wed, short_wed = self.signal("2024-03-06", 1), self.signal("2024-03-06", -1)
        long_thu, short_thu = self.signal("2024-03-07", 1), self.signal("2024-03-07", -1)
        first = self.signal("2024-03-04", 1)
        every = [first, long_wed, short_wed, long_thu, short_thu]
        self.assertEqual(signals.in_regime(every, "all", self.DATES, allowed), every)
        self.assertEqual(signals.in_regime(every, "calm", self.DATES, allowed), [long_wed, short_thu])
        with self.assertRaises(ValueError):
            signals.in_regime(every, "quiet", self.DATES, allowed)

    def test_exit_day_is_the_first_or_second_session_after_the_entry_session(self):
        self.assertEqual(signals.exit_day("2024-03-04", "24h", self.DATES), "2024-03-05")
        self.assertEqual(signals.exit_day("2024-03-04", "48h", self.DATES), "2024-03-06")
        self.assertEqual(signals.exit_day("2024-03-08", "24h", self.DATES), "2024-03-11")  # over the weekend
        self.assertIsNone(signals.exit_day("2024-03-08", "48h", self.DATES))
        self.assertIsNone(signals.exit_day("2024-03-09", "24h", self.DATES))

    def test_take_skips_a_signal_of_the_same_pair_and_direction_while_the_window_is_open(self):
        dates = {"QQQ": self.DATES, "SPY": self.DATES}
        monday, tuesday, wednesday = (self.signal(day) for day in self.DATES[:3])
        short_tuesday = self.signal("2024-03-05", -1)
        other_pair = self.signal("2024-03-05", 1, underlying="SPY")
        taken, counts = signals.take([wednesday, other_pair, short_tuesday, tuesday, monday], "24h", dates)
        # Monday's long leaves at Tuesday's close: Tuesday's long is skipped, Wednesday's is taken.
        self.assertEqual(taken, [monday, short_tuesday, other_pair, wednesday])  # entry order, then pair
        self.assertEqual(counts, {"overlap": 1, "noExit": 0})
        taken, counts = signals.take([monday, tuesday, wednesday], "48h", dates)
        self.assertEqual((taken, counts), ([monday], {"overlap": 2, "noExit": 0}))

    def test_take_counts_a_signal_without_an_exit_session(self):
        last = self.signal("2024-03-11")
        self.assertEqual(signals.take([last], "24h", {"QQQ": self.DATES}), ([], {"overlap": 0, "noExit": 1}))

    def test_a_signal_refuses_a_bad_side_or_price(self):
        with self.assertRaises(ValueError):
            signals.Signal(signals.S1, "QQQ", 0, "2024-03-04", 1.0, 100.0)
        with self.assertRaises(ValueError):
            signals.Signal(signals.S1, "QQQ", 1, "2024-03-04", 1.0, 0.0)


class ExpiryRule(unittest.TestCase):
    def expiry(self, day: str) -> str:
        return forms.vopt.weekly_expiry(day, forms.MIN_EXPIRY_SESSIONS).isoformat()

    def test_first_friday_with_three_sessions_after_the_entry_session(self):
        self.assertEqual(self.expiry("2024-03-04"), "2024-03-08")  # Monday: Tue, Wed, Thu, Fri
        self.assertEqual(self.expiry("2024-03-05"), "2024-03-08")  # Tuesday: Wed, Thu, Fri
        self.assertEqual(self.expiry("2024-03-06"), "2024-03-15")  # Wednesday: only 2 sessions to Friday
        self.assertEqual(self.expiry("2024-03-08"), "2024-03-15")  # Friday

    def test_friday_holiday_uses_the_last_session_of_that_week(self):
        self.assertEqual(self.expiry("2024-03-25"), "2024-03-28")  # Good Friday 2024-03-29: Thursday
        self.assertEqual(self.expiry("2024-03-26"), "2024-04-05")  # only Wed and Thu left that week

    def test_the_48_hour_exit_is_never_on_the_expiry_day(self):
        days = nyse_days("2023-01-03", 520)
        for index, day in enumerate(days[:-2]):
            self.assertLess(days[index + 2], self.expiry(day), day)


class FundIv(unittest.TestCase):
    def test_fund_iv_is_leverage_times_the_iv_of_the_etf_at_the_same_standardized_moneyness(self):
        atm, slope, t = 0.18, -0.25, 5 / 365
        for leverage in (2, 3, -3):
            for x in (-1.5, -0.4, 0.0, 0.7, 2.0):
                u_spot, f_spot = 440.0, 61.0
                u_strike = u_spot * math.exp(x * atm * math.sqrt(t))
                f_strike = f_spot * math.exp(x * abs(leverage) * atm * math.sqrt(t))
                expected = abs(leverage) * om.smile_iv(atm, u_spot, u_strike, t, slope)
                self.assertAlmostEqual(forms.fund_iv(atm, leverage, f_spot, f_strike, t, slope), expected, places=12)

    def test_fund_models_register_the_long_funds_at_four_percent_and_remove_them(self):
        self.assertNotIn("TQQQ", om.HALF_SPREAD_PCT)
        with forms.fund_models():
            for pair in pairs.PAIRS:
                self.assertEqual(om.HALF_SPREAD_PCT[pair.long_fund], 0.04)
                self.assertEqual(om.SKEW[pair.long_fund], om.SKEW[pair.underlying])
                self.assertEqual(om.DIVIDEND_YIELD[pair.long_fund], 0.0)
                self.assertNotIn(pair.inverse_fund, om.HALF_SPREAD_PCT)
            self.assertAlmostEqual(om.leg_cost("TQQQ", 2.0), 0.65 + 100 * 0.08, places=12)
        self.assertNotIn("TQQQ", om.HALF_SPREAD_PCT)

    def test_the_fund_class_is_the_widest_class_of_the_model(self):
        self.assertEqual(forms.FUND_HALF_SPREAD_PCT, max(om.HALF_SPREAD_PCT.values()))


DATES = ("2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01",
         "2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08")
U_CLOSE = (436.0, 437.0, 438.0, 439.0, 440.0, 441.0, 445.0, 450.0, 448.0, 447.0)
VXN = (20.0, 20.0, 20.0, 20.0, 20.0, 21.0, 22.0, 24.0, 24.0, 24.0)
LONG_CLOSE = (58.0, 58.5, 59.0, 59.5, 60.0, 61.0, 62.5, 65.0, 64.0, 63.5)
INVERSE_CLOSE = (10.6, 10.5, 10.3, 10.2, 10.0, 9.9, 9.6, 9.2, 9.3, 9.4)
MONDAY = "2024-03-04"
ENTRY_MS = idata.ms_at(MONDAY, 10 * 60 + 30)
RATE = 0.05


def pair_data(*, iv=VXN, long_splits=(), u_splits=None, long_dates=DATES, long_close=LONG_CLOSE) -> forms.PairData:
    market = Market("QQQ", DATES, U_CLOSE, tuple(iv), (RATE,) * len(DATES))
    return forms.PairData(QQQ, market, u_splits or {}, prices.FundBars("TQQQ", long_dates, long_close, long_splits),
                          prices.FundBars("SQQQ", DATES, INVERSE_CLOSE))


def signal(side: int = 1, price: float = 442.0, day: str = MONDAY) -> signals.Signal:
    return signals.Signal(signals.S1, "QQQ", side, day, idata.ms_at(day, 10 * 60 + 30), price)


SPEC = OptionsSpec("callDebitVertical", dte_target=7, dte_min=3, width_sigma=1.0, max_loss_pct=2.0, long_delta=0.5)


class PriceForms(unittest.TestCase):
    def setUp(self):
        models = forms.fund_models()
        models.__enter__()
        self.addCleanup(models.__exit__, None, None, None)
        self.expiry = date(2024, 3, 8)
        self.t_entry = years_to_close(ENTRY_MS, self.expiry)

    def close_t(self, day: str) -> float:
        return years_to_close(forms.close_ms(day), self.expiry)

    def test_etf_option_is_a_long_call_priced_from_the_previous_close_iv(self):
        trade = forms.price_trade(signal(), "24h", "etf-option", pair_data())
        atm, q, slope = om.atm_iv("VXN", 20.0), om.DIVIDEND_YIELD["QQQ"], om.SKEW["QQQ"]
        strike, _, _ = choose_strikes("call", "debit", 442.0, self.t_entry, RATE, q, atm, slope, SPEC)
        mid = om.bs_price("call", 442.0, strike, self.t_entry, RATE, q, om.smile_iv(atm, 442.0, strike, self.t_entry, slope))
        self.assertEqual((trade.symbol, trade.structure, trade.expiry), ("QQQ", "longCall", "2024-03-08"))
        self.assertEqual((trade.long_strike, trade.short_strike, trade.width), (strike, strike, 0.0))
        self.assertLessEqual(abs(strike - 442.0), 1.0)
        self.assertEqual(trade.entry_price, round(mid * 100, 2))
        self.assertEqual(trade.entry_fee, round(0.65 + 100 * max(0.01, 0.015 * mid), 2))
        self.assertEqual(trade.max_loss, round(trade.entry_price + trade.entry_fee, 2))
        self.assertEqual((trade.entry_spot, trade.iv, trade.rate), (442.0, atm, RATE))
        # Exit: Tuesday's close 445 with Tuesday's VXN 22.
        exit_atm, t = om.atm_iv("VXN", 22.0), self.close_t("2024-03-05")
        exit_mid = om.bs_price("call", 445.0, strike, t, RATE, q, om.smile_iv(exit_atm, 445.0, strike, t, slope))
        self.assertEqual((trade.exit_day, trade.exit_spot), ("2024-03-05", 445.0))
        self.assertEqual(trade.exit_price, round(exit_mid * 100, 2))
        self.assertEqual(trade.exit_fee, round(0.65 + 100 * 0.015 * exit_mid, 2))
        # One mark: Monday's close 441 with Monday's VXN 21.
        mark_atm, t = om.atm_iv("VXN", 21.0), self.close_t(MONDAY)
        mark = om.bs_price("call", 441.0, strike, t, RATE, q, om.smile_iv(mark_atm, 441.0, strike, t, slope))
        self.assertEqual(trade.marks, ((MONDAY, round(mark * 100, 2)),))
        self.assertEqual(trade.stale_days, 0)

    def test_48h_exits_at_the_second_session_and_marks_both_closes_before_it(self):
        trade = forms.price_trade(signal(), "48h", "etf-option", pair_data())
        self.assertEqual((trade.exit_day, trade.exit_spot), ("2024-03-06", 450.0))
        self.assertEqual([day for day, _ in trade.marks], [MONDAY, "2024-03-05"])
        one_day = forms.price_trade(signal(), "24h", "etf-option", pair_data())
        self.assertEqual(trade.marks[1][1], one_day.exit_price)
        self.assertEqual(trade.entry_price, one_day.entry_price)

    def test_short_signal_buys_a_put(self):
        trade = forms.price_trade(signal(-1), "24h", "etf-option", pair_data())
        self.assertEqual(trade.structure, "longPut")
        vertical = forms.price_trade(signal(-1), "24h", "etf-vertical", pair_data())
        self.assertEqual(vertical.structure, "putDebitVertical")
        self.assertLess(vertical.short_strike, vertical.long_strike)

    def test_etf_vertical_sells_the_leg_one_sigma_further_out(self):
        trade = forms.price_trade(signal(), "24h", "etf-vertical", pair_data())
        atm, q, slope = 0.18, om.DIVIDEND_YIELD["QQQ"], om.SKEW["QQQ"]
        long_strike, short_strike, width = choose_strikes("call", "debit", 442.0, self.t_entry, RATE, q, atm, slope, SPEC)
        self.assertEqual((trade.structure, trade.long_strike, trade.short_strike, trade.width),
                         ("callDebitVertical", long_strike, short_strike, width))
        self.assertEqual(width, round(atm * math.sqrt(self.t_entry) * 442.0))
        legs = [om.bs_price("call", 442.0, k, self.t_entry, RATE, q, om.smile_iv(atm, 442.0, k, self.t_entry, slope))
                for k in (long_strike, short_strike)]
        self.assertEqual(trade.entry_price, round((legs[0] - legs[1]) * 100, 2))
        self.assertEqual(trade.entry_fee, round(sum(om.leg_cost("QQQ", leg) for leg in legs), 2))
        self.assertEqual(trade.max_loss, round(trade.entry_price + trade.entry_fee, 2))
        single = forms.price_trade(signal(), "24h", "etf-option", pair_data())
        self.assertLess(trade.entry_price, single.entry_price)

    def test_lev_option_prices_the_long_fund_at_its_synthetic_price_with_leverage_times_the_iv(self):
        trade = forms.price_trade(signal(), "24h", "lev-option", pair_data())
        spot = 60.0 * (1 + 3 * (442.0 / 440.0 - 1))
        atm, slope = 3 * 0.18, om.SKEW["QQQ"]
        strike, _, _ = choose_strikes("call", "debit", spot, self.t_entry, RATE, 0.0, atm, slope, SPEC)
        mid = om.bs_price("call", spot, strike, self.t_entry, RATE, 0.0, om.smile_iv(atm, spot, strike, self.t_entry, slope))
        self.assertEqual((trade.symbol, trade.structure, trade.long_strike), ("TQQQ", "longCall", strike))
        self.assertAlmostEqual(trade.entry_spot, spot, places=12)
        self.assertAlmostEqual(trade.iv, atm, places=12)
        self.assertEqual(trade.entry_price, round(mid * 100, 2))
        self.assertEqual(trade.entry_fee, round(0.65 + 100 * 0.04 * mid, 2))  # the 4% class of a fund
        exit_atm, t = 3 * om.atm_iv("VXN", 22.0), self.close_t("2024-03-05")
        exit_mid = om.bs_price("call", 62.5, strike, t, RATE, 0.0, om.smile_iv(exit_atm, 62.5, strike, t, slope))
        self.assertEqual((trade.exit_spot, trade.exit_price), (62.5, round(exit_mid * 100, 2)))

    def test_lev_option_of_a_short_signal_is_a_put_on_the_long_fund(self):
        trade = forms.price_trade(signal(-1), "24h", "lev-option", pair_data())
        self.assertEqual((trade.symbol, trade.structure), ("TQQQ", "longPut"))

    def test_lev_vertical_is_one_fund_sigma_wide(self):
        trade = forms.price_trade(signal(), "24h", "lev-vertical", pair_data())
        spot = 60.0 * (1 + 3 * (442.0 / 440.0 - 1))
        self.assertEqual((trade.symbol, trade.structure), ("TQQQ", "callDebitVertical"))
        self.assertEqual(trade.width, round(3 * 0.18 * math.sqrt(self.t_entry) * spot))
        self.assertEqual(trade.short_strike, trade.long_strike + trade.width)

    def test_a_fund_option_needs_the_fund_cost_model(self):
        with forms.fm.proxy_symbols({}, {}):
            pass
        om.HALF_SPREAD_PCT.pop("TQQQ")
        try:
            with self.assertRaises((ValueError, KeyError)):
                forms.price_trade(signal(), "24h", "lev-option", pair_data())
        finally:
            om.HALF_SPREAD_PCT["TQQQ"] = forms.FUND_HALF_SPREAD_PCT

    def test_lev_shares_buy_the_long_fund_for_a_long_signal(self):
        trade = forms.price_trade(signal(), "24h", "lev-shares", pair_data())
        entry = round(60.0 * (1 + 3 * (442.0 / 440.0 - 1)), 2)
        self.assertEqual((trade.symbol, trade.structure, trade.expiry), ("TQQQ", "shares", ""))
        self.assertEqual((trade.entry_price, trade.exit_price), (entry, 62.5))
        self.assertAlmostEqual(trade.entry_fee, 0.001 * entry, places=12)
        self.assertAlmostEqual(trade.exit_fee, 0.001 * 62.5, places=12)
        self.assertAlmostEqual(trade.max_loss, entry * 1.001, places=12)
        self.assertEqual(trade.marks, ((MONDAY, 61.0),))

    def test_lev_shares_buy_the_inverse_fund_for_a_short_signal(self):
        trade = forms.price_trade(signal(-1, price=438.0), "48h", "lev-shares", pair_data())
        entry = round(10.0 * (1 - 3 * (438.0 / 440.0 - 1)), 2)
        self.assertEqual((trade.symbol, trade.entry_price, trade.exit_price), ("SQQQ", entry, 9.2))
        self.assertEqual(trade.marks, ((MONDAY, 9.9), ("2024-03-05", 9.6)))

    def test_the_closing_cost_is_capped_at_the_exit_value(self):
        # The fund falls far below the strike: the call is worth cents and is left to expire.
        closes = LONG_CLOSE[:6] + (40.0,) + LONG_CLOSE[7:]
        trade = forms.price_trade(signal(), "24h", "lev-option", pair_data(long_close=closes))
        self.assertLess(trade.exit_price, 1.65)
        self.assertEqual(trade.exit_fee, trade.exit_price)
        vertical = forms.price_trade(signal(), "24h", "lev-vertical", pair_data(long_close=closes))
        self.assertEqual(vertical.exit_fee, vertical.exit_price)

    def test_a_vertical_closes_as_a_package(self):
        # Deep in the money at the exit: both legs are worth a lot, the cost is capped at the worst case.
        closes = LONG_CLOSE[:6] + (90.0,) + LONG_CLOSE[7:]
        trade = forms.price_trade(signal(), "24h", "lev-vertical", pair_data(long_close=closes))
        self.assertEqual(trade.exit_fee, worst_exit_cost("TQQQ", trade.width))
        self.assertAlmostEqual(trade.exit_price, trade.width * 100, delta=5.0)

    def test_a_missing_iv_index_at_a_close_carries_the_last_value(self):
        iv = VXN[:6] + (None,) + VXN[7:]
        trade = forms.price_trade(signal(), "24h", "etf-option", pair_data(iv=iv))
        strike, q, slope = trade.long_strike, om.DIVIDEND_YIELD["QQQ"], om.SKEW["QQQ"]
        atm, t = om.atm_iv("VXN", 21.0), self.close_t("2024-03-05")  # Monday's value, the last one used
        mid = om.bs_price("call", 445.0, strike, t, RATE, q, om.smile_iv(atm, 445.0, strike, t, slope))
        self.assertEqual((trade.exit_price, trade.stale_days), (round(mid * 100, 2), 1))

    def test_reasons_a_signal_is_not_priced(self):
        data = pair_data()
        self.assertEqual(forms.price_trade(signal(day="2024-03-03"), "24h", "etf-option", data),
                         "no daily bar on the entry day")
        self.assertEqual(forms.price_trade(signal(day="2024-02-26"), "24h", "etf-option", data), "no previous close")
        self.assertEqual(forms.price_trade(signal(day="2024-03-08"), "24h", "etf-option", data), "no exit session")
        self.assertEqual(forms.price_trade(signal(day="2024-03-07"), "48h", "etf-option", data), "no exit session")
        self.assertEqual(forms.price_trade(signal(price=600.0), "24h", "etf-option", data),
                         "entry price far from the previous close")
        no_iv = pair_data(iv=VXN[:4] + (None,) + VXN[5:])
        self.assertEqual(forms.price_trade(signal(), "24h", "etf-option", no_iv), "no IV")
        self.assertEqual(forms.price_trade(signal(), "24h", "lev-option", no_iv), "no IV")
        self.assertNotIsInstance(forms.price_trade(signal(), "24h", "lev-shares", no_iv), str)
        with self.assertRaises(ValueError):
            forms.price_trade(signal(), "24h", "etf-shares", data)
        with self.assertRaises(ValueError):
            forms.price_trade(signals.Signal(signals.S1, "SPY", 1, MONDAY, ENTRY_MS, 500.0), "24h", "etf-option", data)

    def test_a_split_of_the_instrument_in_the_window_is_not_priced(self):
        for split_day in (MONDAY, "2024-03-05"):
            data = pair_data(long_splits=((split_day, 2.0),))
            self.assertEqual(forms.price_trade(signal(), "24h", "lev-option", data), "split in the window")
            self.assertEqual(forms.price_trade(signal(), "24h", "lev-shares", data), "split in the window")
            # The split of the long fund does not touch the ETF forms or the inverse fund.
            self.assertNotIsInstance(forms.price_trade(signal(), "24h", "etf-option", data), str)
            self.assertNotIsInstance(forms.price_trade(signal(-1), "24h", "lev-shares", data), str)
        after = pair_data(long_splits=(("2024-03-06", 2.0),))
        self.assertNotIsInstance(forms.price_trade(signal(), "24h", "lev-option", after), str)
        self.assertEqual(forms.price_trade(signal(), "48h", "lev-option", after), "split in the window")
        etf_split = pair_data(u_splits={"2024-03-05": 2.0})
        self.assertEqual(forms.price_trade(signal(), "24h", "etf-vertical", etf_split), "split in the window")
        self.assertNotIsInstance(forms.price_trade(signal(), "24h", "lev-vertical", etf_split), str)

    def test_a_fund_without_a_close_is_not_priced(self):
        data = pair_data(long_dates=DATES[:6] + DATES[7:], long_close=LONG_CLOSE[:6] + LONG_CLOSE[7:])
        self.assertEqual(forms.price_trade(signal(), "24h", "lev-option", data), "no fund close")
        self.assertNotIsInstance(forms.price_trade(signal(), "24h", "etf-option", data), str)

    def test_price_trades_counts_the_reasons(self):
        every = [signal(), signal(day="2024-03-08"), signal(day="2024-03-03")]
        trades, reasons = forms.price_trades(every, "24h", "etf-option", {"QQQ": pair_data()})
        self.assertEqual(len(trades), 1)
        self.assertEqual(reasons, {"no exit session": 1, "no daily bar on the entry day": 1})

    def test_first_day_is_the_first_day_every_input_exists(self):
        self.assertEqual(forms.first_day(pair_data()), "2024-02-26")
        self.assertEqual(forms.first_day(pair_data(iv=(None, None) + VXN[2:])), "2024-02-28")
        late = pair_data(long_dates=DATES[3:], long_close=LONG_CLOSE[3:])
        self.assertEqual(forms.first_day(late), "2024-02-29")


class SizingAndBooking(unittest.TestCase):
    def setUp(self):
        models = forms.fund_models()
        models.__enter__()
        self.addCleanup(models.__exit__, None, None, None)

    def priced(self, form: str, window: str = "24h", side: int = 1) -> forms.WindowTrade:
        return forms.price_trade(signal(side), window, form, pair_data())

    def test_units_are_two_percent_of_equity_over_the_maximum_loss(self):
        for form in forms.FORM_KEYS:
            trade = self.priced(form)
            booked = forms.book([trade], DATES[5:], 100_000.0, nautilus=False)
            record = booked["daily"].trades[0]
            self.assertEqual(record["contracts"], math.floor(2_000.0 / trade.max_loss), form)
            self.assertLessEqual(record["contracts"] * trade.max_loss, 2_000.0, form)
            self.assertGreaterEqual(record["pnl"], -2_000.0, form)

    def test_shares_keep_the_notional_inside_two_percent(self):
        trade = self.priced("lev-shares")
        record = forms.book([trade], DATES[5:], 100_000.0, nautilus=False)["daily"].trades[0]
        self.assertEqual(record["contracts"], math.floor(2_000.0 / (trade.entry_price * 1.001)))
        self.assertLessEqual(record["contracts"] * trade.entry_price, 2_000.0)
        expected = record["contracts"] * (trade.exit_price - trade.entry_price) - round(
            record["contracts"] * trade.entry_fee, 2) - round(record["contracts"] * trade.exit_fee, 2)
        self.assertAlmostEqual(record["pnl"], expected, places=2)

    def test_a_trade_that_costs_more_than_two_percent_is_refused(self):
        trade = self.priced("etf-option")
        capital = trade.max_loss * 50 - 1  # one contract would be just above 2%
        booked = forms.book([trade], DATES[5:], capital, nautilus=False)
        self.assertEqual(booked["daily"].trades, ())
        self.assertEqual([(item["reason"], item["entryDate"]) for item in booked["daily"].skipped], [("size", MONDAY)])
        self.assertEqual(contracts_for(capital, capital, 2.0, trade.max_loss, trade.entry_price + trade.entry_fee), 0)
        enough = forms.book([trade], DATES[5:], trade.max_loss * 50, nautilus=False)
        self.assertEqual(enough["daily"].trades[0]["contracts"], 1)

    def test_the_loss_of_an_option_form_is_never_above_premium_plus_entry_costs(self):
        closes = LONG_CLOSE[:6] + (40.0,) + LONG_CLOSE[7:]
        for form in ("lev-option", "lev-vertical"):
            trade = forms.price_trade(signal(), "24h", form, pair_data(long_close=closes))
            record = forms.book([trade], DATES[5:], 100_000.0, nautilus=False)["daily"].trades[0]
            self.assertAlmostEqual(record["pnl"], -record["contracts"] * trade.max_loss, delta=0.02 * record["contracts"])
            self.assertGreaterEqual(record["pnl"], -2_000.0)

    def test_to_priced_maps_a_window_trade_to_the_book_record(self):
        trade = self.priced("etf-vertical", "48h")
        priced, clock = forms.to_priced([trade], DATES[5:])
        self.assertEqual(len(priced), 1)
        record = priced[0]
        self.assertEqual((record.trade_id, record.symbol, record.structure, record.expiry),
                         (1, "QQQ", "callDebitVertical", "2024-03-08"))
        self.assertEqual((record.max_loss_pct, record.exit_reason, record.max_loss), (2.0, "window", trade.max_loss))
        self.assertEqual(clock.real(record.entry_date), ENTRY_MS)
        self.assertEqual(clock.real(record.exit_date), forms.close_ms("2024-03-06"))
        self.assertEqual([clock.real(key) for key, _ in record.marks],
                         [ENTRY_MS, forms.close_ms(MONDAY), forms.close_ms("2024-03-05"), forms.close_ms("2024-03-06")])
        self.assertEqual([value for _, value in record.marks],
                         [trade.entry_price, trade.marks[0][1], trade.marks[1][1], trade.exit_price])
        # 5 session closes and one entry time.
        self.assertEqual(len(clock.keys()), 6)

    def test_daily_result_is_one_point_per_new_york_day(self):
        trades = [self.priced("etf-option", "48h"), self.priced("lev-shares", "24h", -1)]
        booked = forms.book(trades, DATES[5:], 100_000.0, nautilus=False)
        daily = booked["daily"]
        self.assertEqual(daily.dates, DATES[5:])
        self.assertEqual(daily.open_positions, (2, 1, 0, 0, 0))
        self.assertEqual({record["entryDate"] for record in daily.trades}, {MONDAY})
        self.assertEqual(sorted(record["exitDate"] for record in daily.trades), ["2024-03-05", "2024-03-06"])
        self.assertAlmostEqual(daily.equity[-1], 100_000.0 + sum(record["pnl"] for record in daily.trades), places=6)
        self.assertEqual(len(booked["returns"]), 2)
        self.assertIsNone(booked["gap"])

    @unittest.skipUnless(_nautilus_installed(), "NautilusTrader is not installed")
    def test_nautilus_books_every_form_like_the_ledger(self):
        trades = [self.priced(form, window, side)
                  for form in forms.FORM_KEYS for window in ("24h", "48h") for side in (1, -1)]
        tuesday = signals.Signal(signals.S2, "QQQ", 1, "2024-03-05", idata.ms_at("2024-03-05", 9 * 60 + 35), 443.0)
        trades += [forms.price_trade(tuesday, "24h", form, pair_data()) for form in forms.FORM_KEYS]
        self.assertTrue(all(isinstance(trade, forms.WindowTrade) for trade in trades))
        booked = forms.book(trades, DATES[5:], 100_000.0)
        self.assertLessEqual(booked["gap"], 1e-6)
        self.assertEqual(len(booked["daily"].trades), len(trades))
        self.assertIn("nautilus", booked["engine"])
        ledger_only = forms.book(trades, DATES[5:], 100_000.0, nautilus=False)
        self.assertEqual([round(value, 6) for value in booked["daily"].equity],
                         [round(value, 6) for value in ledger_only["daily"].equity])


if __name__ == "__main__":
    unittest.main()
