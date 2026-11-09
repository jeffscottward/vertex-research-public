"""Unit tests of the market intraday momentum reel study (synthetic data; no market data, no Nautilus)."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import unittest
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from strategies.imom import bias, data, definition, metrics, options, rules, study
from strategies.qc_ports.data import Market

NY = ZoneInfo("America/New_York")
REPO = Path(__file__).resolve().parents[3]


def ny_ms(day: str, hhmm: str) -> int:
    h, mi = (int(x) for x in hhmm.split(":"))
    return int(datetime.fromisoformat(day).replace(hour=h, minute=mi, tzinfo=NY).timestamp() * 1000)


def minutes_of(day: str, start: str = "09:30", end: str = "16:00", price=lambda i: 100.0 + i * 0.01,
               volume: float = 1.0) -> list[tuple[int, tuple]]:
    first, last = ny_ms(day, start), ny_ms(day, end)
    out = []
    for i, t in enumerate(range(first, last, 60_000)):
        p = price(i)
        out.append((t, (p, p + 0.02, p - 0.02, p + 0.01, volume)))
    return out


def bars_from(rows: list[tuple[str, str, float, float, float, float, float]]) -> data.SessionBars:
    """5-minute bars from (day, bar open HH:MM, o, h, l, c, v)."""
    cols = list(zip(*[(float(ny_ms(d, t)), o, h, low, c, v) for d, t, o, h, low, c, v in rows]))
    return data.SessionBars(*(tuple(c) for c in cols), spread_bps=1.0)


def flat_day(day: str, price: float = 100.0, volume: float = 1.0, until: str = "16:00") -> list[tuple]:
    out = []
    minute = 9 * 60 + 30
    end = int(until[:2]) * 60 + int(until[3:])
    while minute < end:
        out.append((day, f"{minute // 60:02d}:{minute % 60:02d}", price, price, price, price, volume))
        minute += 5
    return out


class DataTest(unittest.TestCase):
    def test_mid_minutes_mid_volume_and_spread(self) -> None:
        bid = {1: (99.0, 101.0, 98.0, 100.0, 5.0), 2: (100.0, 102.0, 99.0, 101.0, 1.0), 3: (1.0, 1.0, 1.0, 1.0, 0.0)}
        ask = {1: (99.2, 101.2, 98.2, 100.2, 4.0), 2: (100.2, 102.2, 99.2, 101.2, 2.0)}
        out, spread = data.mid_minutes(bid, ask)
        self.assertEqual([t for t, _ in out], [1, 2])
        self.assertAlmostEqual(out[0][1][3], 100.1)
        self.assertEqual([bar[4] for _, bar in out], [5.0, 1.0])  # bid volume
        # In-sample spreads only: the cut is at 60 % of the time (t <= 1.6), so only the first bar counts.
        self.assertAlmostEqual(spread, 0.2 / 100.1 * 1e4)
        self.assertAlmostEqual(data.mid_minutes(bid, ask, is_fraction=1.0)[1], (0.2 / 100.1 + 0.2 / 101.1) / 2 * 1e4)
        self.assertEqual(data.mid_minutes({}, {}), ([], 0.0))

    def test_drops_a_session_that_gaps_more_than_30_percent(self) -> None:
        rows = (minutes_of("2024-01-09") + minutes_of("2024-01-10", price=lambda i: 800.0 + i * 0.01)
                + minutes_of("2024-01-11", price=lambda i: 800.0))
        days = {day for day, _ in data.local_times(data.aggregate(sorted(rows)).t)}
        # The split day goes; the next day compares with the split day's close and stays.
        self.assertEqual(days, {"2024-01-09", "2024-01-11"})

    def test_aggregates_to_five_minutes_aligned_to_the_open_in_both_dst_regimes(self) -> None:
        for day in ("2024-01-10", "2024-07-10"):
            bars = data.aggregate(minutes_of(day))
            self.assertEqual(len(bars), 78)
            local = data.local_times(bars.t)
            self.assertEqual(local[0], (day, 570))
            self.assertEqual(local[-1], (day, 955))
            self.assertAlmostEqual(bars.o[0], 100.0)
            self.assertAlmostEqual(bars.c[0], 100.04 + 0.01)
            self.assertAlmostEqual(bars.h[1], 100.09 + 0.02)
            self.assertEqual(bars.v[0], 5.0)

    def test_drops_holidays_closures_and_short_sessions_and_cuts_early_closes(self) -> None:
        rows = (minutes_of("2024-07-03") + minutes_of("2024-07-04") + minutes_of("2024-07-05", end="11:00")
                + minutes_of("2024-07-08") + minutes_of("2025-01-09") + minutes_of("2024-07-06"))
        bars = data.aggregate(sorted(rows))
        days: dict[str, int] = {}
        for day, _ in data.local_times(bars.t):
            days[day] = days.get(day, 0) + 1
        # July 4 holiday, Jan 9 2025 closure, a Saturday and an 18-bar session are dropped; July 3 ends at 13:00.
        self.assertEqual(days, {"2024-07-03": 42, "2024-07-08": 78})

    def test_early_close_rule(self) -> None:
        self.assertTrue(data.is_early_close(date(2024, 11, 29)))
        self.assertTrue(data.is_early_close(date(2024, 12, 24)))
        self.assertTrue(data.is_early_close(date(2025, 7, 3)))
        self.assertFalse(data.is_early_close(date(2026, 7, 3)))  # Friday: the observed holiday
        self.assertFalse(data.is_early_close(date(2021, 12, 24)))
        self.assertFalse(data.is_early_close(date(2024, 11, 22)))
        self.assertTrue(data.is_closed(date(2024, 3, 29)))  # Good Friday

    def test_needs_two_bars_and_instrument_table(self) -> None:
        with self.assertRaises(ValueError):
            data.aggregate(minutes_of("2024-01-06"))
        self.assertEqual(len(data.INSTRUMENTS), 14)
        self.assertEqual(data.BY_KEY["US500"].twin, "SPY")
        self.assertEqual({data.BY_KEY[k].twin for k in data.ETF_TWINS}, set(data.ETF_TWINS))
        self.assertEqual(data.daily_closes(bars_from(flat_day("2024-01-10")[:3])), [("2024-01-10", 100.0)])

    def test_files_cache_and_hash(self) -> None:
        import gzip
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "m1"
            root.mkdir()
            rows = minutes_of("2024-01-10")
            for side in ("bid", "ask"):
                with gzip.open(root / f"spyususd-{side}.csv.gz", "wt") as fh:
                    fh.write("timestamp,open,high,low,close,volume\n")
                    for t, (o, h, low, c, v) in rows:
                        fh.write(f"{t},{o},{h},{low},{c},{v}\n")
            self.assertTrue(data.available("SPY", root))
            self.assertFalse(data.available("QQQ", root))
            first = data.load_bars("SPY", root)
            self.assertTrue((Path(tmp) / "m5-cache" / "spyususd.pkl").exists())
            self.assertEqual(data.load_bars("SPY", root), first)
            self.assertEqual(len(first), 78)
            self.assertTrue(data.data_hash(["SPY"], root).startswith("sha256:"))


class DefinitionTest(unittest.TestCase):
    def test_ghlz_long_is_the_spec_shape(self) -> None:
        d = definition.definition(definition.GHLZ, "long")
        self.assertEqual(d["intraday"], {"timezone": "America/New_York", "open": "09:30", "close": "16:00",
                                         "entryFrom": "15:30", "entryTo": "15:30"})
        self.assertEqual(d["entry"], {"all": [{"left": {"type": "indicator", "name": "sessionReturn",
                                                        "from": "prevClose", "to": "10:00"},
                                               "op": ">", "right": {"type": "const", "value": 0.0}}]})
        self.assertEqual(d["stopLoss"], {"kind": "none"})
        self.assertEqual(d["sizing"], {"mode": "allIn"})
        self.assertNotIn("side", d)
        short = definition.definition(definition.GHLZ, "short")
        self.assertEqual(short["side"], "short")
        self.assertEqual(short["entry"]["all"][0]["op"], "<")

    def test_variants(self) -> None:
        r12 = definition.definition(definition.GHLZ_R1R12, "short")["entry"]["all"]
        self.assertEqual(r12[1]["left"], {"type": "indicator", "name": "sessionReturn", "from": "15:00", "to": "15:30"})
        self.assertEqual(r12[1]["op"], "<")
        thr = definition.definition(replace(definition.GHLZ, threshold=0.001), "short")["entry"]["all"][0]
        self.assertEqual(thr["right"]["value"], -0.001)
        zab = definition.definition(definition.ZAB, "long")
        self.assertEqual(zab["intraday"]["decisionEvery"], 30)
        self.assertEqual(zab["sizing"], {"mode": "volTarget", "targetPct": 2.0, "length": 14, "maxLeverage": 4.0})
        self.assertEqual(zab["exit"]["any"][1]["right"], {"type": "indicator", "name": "vwap"})
        self.assertNotIn("multiple", zab["entry"]["all"][0]["right"])
        zab_short = definition.definition(replace(definition.ZAB, multiple=1.2), "short")
        self.assertEqual(zab_short["entry"]["all"][0]["right"]["band"], "lower")
        self.assertEqual(zab_short["entry"]["all"][0]["right"]["multiple"], 1.2)
        self.assertEqual([c["op"] for c in zab_short["exit"]["any"]], [">", ">"])
        self.assertEqual(definition.definition(definition.ZAB_1X, "long")["sizing"], {"mode": "allIn"})
        b = definition.definition(replace(definition.BIAS, decision="12:00"), "long")
        self.assertEqual(b["intraday"]["entryFrom"], "12:00")
        with self.assertRaises(ValueError):
            definition.definition(definition.GHLZ, "flat")

    def test_grids_and_round_trip(self) -> None:
        self.assertEqual(len(definition.GHLZ_SENSITIVITY), 9)
        self.assertEqual(len(definition.ZAB_SENSITIVITY), 7)
        self.assertEqual(len(definition.BIAS_SENSITIVITY), 4)
        self.assertEqual(len(definition.WALK_FORWARD_GRID), 9)
        self.assertIn(definition.GHLZ, definition.WALK_FORWARD_GRID)
        for _, _, params in definition.STRATEGIES:
            self.assertEqual(definition.params_from_json(definition.params_to_json(params)), params)
            self.assertIn(params.family.lower(), params.label())
        self.assertEqual(len(definition.legs(replace(definition.GHLZ, sides=("long",)))), 1)
        self.assertEqual(set(definition.all_definitions()), {"ghlz", "ghlz-r1r12", "zab", "zab-1x", "bias"})

    def test_study_jobs_are_distinct_legs(self) -> None:
        keys = [item.key for item in data.INSTRUMENTS]
        jobs, configs = study.plan_jobs(keys)
        idents = [study.leg_id(k, p, s, mlt) for k, p, s, mlt in jobs]
        self.assertEqual(len(idents), len(set(idents)))
        # Long-only and short-only GHLZ reuse the base legs; ZAB 1x sensitivity is the zab-1x strategy.
        self.assertEqual(len(configs), 28)
        self.assertEqual(len(jobs), 218)


class BiasTest(unittest.TestCase):
    def _two_days(self) -> data.SessionBars:
        prev = flat_day("2024-01-09", 100.0)
        today = []
        price = 100.5  # gap up 0.5 %
        minute = 9 * 60 + 30
        while minute < 16 * 60:
            t = f"{minute // 60:02d}:{minute % 60:02d}"
            o = price
            price += 0.05
            today.append(("2024-01-10", t, o, price + 0.01, o - 0.01, price, 10.0))
            minute += 5
        return bars_from(prev + today)

    def test_rising_day_votes_long_on_every_factor(self) -> None:
        bars = self._two_days()
        scores = bias.daily_scores(bars, "15:30")
        (k, (day, value, votes)), = [(k, v) for k, v in scores.items() if v[0] == "2024-01-10"]
        self.assertEqual(day, "2024-01-10")
        self.assertEqual(data.local_times([bars.t[k]])[0][1], 15 * 60 + 25)  # the bar closing at 15:30
        self.assertEqual(votes, {name: 1 for name in bias.FACTORS})
        self.assertEqual(value, 100.0)
        long_signal = bias.signals(bars, "15:30", 50, "long", scores)
        self.assertEqual(sum(long_signal), 1)
        self.assertEqual(long_signal[k], 1)
        self.assertEqual(sum(bias.signals(bars, "15:30", 50, "short", scores)), 0)

    def test_first_day_has_neutral_gap_and_value_area(self) -> None:
        bars = self._two_days()
        scores = bias.daily_scores(bars, "15:30")
        first = [v for v in scores.values() if v[0] == "2024-01-09"][0]
        self.assertEqual(first[2]["Gap"], 0)
        self.assertEqual(first[2]["Value Area Shift"], 0)
        self.assertEqual(first[1], 0.0)  # flat day: every factor neutral

    def test_reel_panel_score(self) -> None:
        votes = {"Initial Move": 1, "VWAP": 1, "Daily Candle": 1, "Initial Hour HL": 0, "Session Delta": 1,
                 "Value Area Shift": 1, "ORB": 0, "Gap": -1}
        self.assertEqual(bias.score(votes), 50.0)

    def test_value_area_and_helpers(self) -> None:
        self.assertIsNone(bias.value_area_mid([], []))
        # POC at 101 (volume 50); 70 % of 100 needs 101 + 102 (30) = 80.
        self.assertEqual(bias.value_area_mid([100, 101, 102, 103], [10, 50, 30, 10]), 101.5)
        self.assertEqual(bias.value_area_mid([100, 102], [0, 0]), 101.0)
        self.assertEqual(bias.sign(0.0005, 0.001), 0)
        self.assertEqual(bias.sign(-0.002, 0.001), -1)
        self.assertEqual(bias.above_below(5, 4, 1), 1)
        self.assertEqual(bias.above_below(0, 4, 1), -1)
        self.assertEqual(bias.above_below(2, 4, 1), 0)
        self.assertEqual(bias.hhmm("15:30"), 930)

    def test_missing_decision_bar_gives_no_signal(self) -> None:
        bars = bars_from(flat_day("2024-01-10", until="13:00"))
        self.assertEqual(bias.daily_scores(bars, "15:30"), {})


def spy_market(days: list[str], iv: float = 20.0, rate: float = 0.04) -> Market:
    return Market("SPY", tuple(days), tuple(400.0 for _ in days), tuple(iv for _ in days), tuple(rate for _ in days))


class OptionsTest(unittest.TestCase):
    def test_weekly_expiry(self) -> None:
        self.assertEqual(options.weekly_expiry("2024-01-10"), date(2024, 1, 12))  # Wednesday -> Friday
        self.assertEqual(options.weekly_expiry("2024-01-11"), date(2024, 1, 12))  # Thursday: 1 day left
        self.assertEqual(options.weekly_expiry("2024-01-12"), date(2024, 1, 19))  # Friday -> next Friday
        self.assertEqual(options.weekly_expiry("2024-03-27"), date(2024, 3, 28))  # Good Friday -> Thursday
        self.assertEqual(options.weekly_expiry("2024-03-28"), date(2024, 4, 5))
        t = options.years_to_close(ny_ms("2024-01-10", "15:30"), date(2024, 1, 12))
        self.assertAlmostEqual(t, (2 * 24 + 0.5) / 24 / 365)

    def _etf(self, close_price: float) -> options.EtfClock:
        rows = flat_day("2024-01-10", 400.0)
        rows[-1] = rows[-1][:5] + (close_price, 1.0)
        return options.EtfClock(bars_from(rows))

    def test_call_and_put_verticals(self) -> None:
        market = spy_market(["2024-01-08", "2024-01-09", "2024-01-10"])
        entry = ny_ms("2024-01-10", "15:30")
        up = options.price_event(options.OptionEvent("US500", "SPY", "long", entry), self._etf(404.0), market)
        self.assertIsInstance(up, options.Spread)
        self.assertEqual(up.right, "call")
        self.assertEqual(up.expiry, "2024-01-12")
        self.assertGreater(up.short_strike, up.long_strike)
        self.assertGreater(up.entry_price, 0)
        self.assertLess(up.entry_price, up.width * 100)
        self.assertGreater(up.exit_price, up.entry_price)  # the underlying rose 1 %
        self.assertAlmostEqual(up.max_loss, round(up.entry_price + up.entry_fee + options.worst_exit_cost("SPY", up.width), 2))
        self.assertEqual(up.exit_ms, ny_ms("2024-01-10", "16:00"))
        down = options.price_event(options.OptionEvent("US500", "SPY", "short", entry), self._etf(404.0), market)
        self.assertEqual(down.right, "put")
        self.assertLess(down.short_strike, down.long_strike)
        self.assertLess(down.exit_price, down.entry_price)

    def test_previous_close_iv_and_skips(self) -> None:
        entry = ny_ms("2024-01-10", "15:30")
        event = options.OptionEvent("US500", "SPY", "long", entry)
        base = options.price_event(event, self._etf(400.0), spy_market(["2024-01-09", "2024-01-10"]))
        changed_today = Market("SPY", ("2024-01-09", "2024-01-10"), (400.0, 400.0), (20.0, 80.0), (0.04, 0.04))
        self.assertEqual(options.price_event(event, self._etf(400.0), changed_today), base)  # no look-ahead
        self.assertEqual(options.price_event(event, self._etf(400.0), spy_market(["2024-01-10"])), "no previous close")
        no_iv = Market("SPY", ("2024-01-09", "2024-01-10"), (400.0, 400.0), (None, 20.0), (0.04, 0.04))
        self.assertEqual(options.price_event(event, self._etf(400.0), no_iv), "no IV")
        no_rate = Market("SPY", ("2024-01-09", "2024-01-10"), (400.0, 400.0), (20.0, 20.0), (None, 0.04))
        self.assertEqual(options.price_event(event, self._etf(400.0), no_rate), "no rate")
        old = Market("SPY", ("2024-01-04", "2024-01-11"), (400.0, 400.0), (20.0, 20.0), (0.04, 0.04))
        self.assertEqual(options.price_event(event, self._etf(400.0), old), "stale IV")  # 6 calendar days
        five = Market("SPY", ("2024-01-05", "2024-01-11"), (400.0, 400.0), (20.0, 20.0), (0.04, 0.04))
        self.assertIsInstance(options.price_event(event, self._etf(400.0), five), options.Spread)
        late = options.OptionEvent("US500", "SPY", "long", ny_ms("2024-01-10", "15:32"))
        self.assertEqual(options.price_event(late, self._etf(400.0), spy_market(["2024-01-09"])), "no ETF bar")

    def test_first_per_day_and_ledger_booking(self) -> None:
        market = spy_market(["2024-01-09", "2024-01-10"])
        etf = self._etf(404.0)
        e1 = options.OptionEvent("US500", "SPY", "long", ny_ms("2024-01-10", "15:30"))
        e2 = options.OptionEvent("US500", "SPY", "short", ny_ms("2024-01-10", "15:45"))
        spreads, skipped = options.price_events([e2, e1], {"SPY": etf}, {"SPY": market})
        self.assertEqual(len(spreads), 1)
        self.assertEqual(spreads[0].event, e1)
        self.assertEqual(skipped, [])
        closes = [ny_ms("2024-01-09", "16:00"), ny_ms("2024-01-10", "16:00")]
        booked = options.book(spreads, closes, 100_000.0, nautilus=False)
        ledger = booked["ledger"]
        (record,) = ledger.trades
        s = spreads[0]
        contracts = record["contracts"]
        self.assertEqual(contracts, math.floor(0.02 * 100_000 / s.max_loss))
        self.assertAlmostEqual(record["pnl"], round(contracts * (s.exit_price - s.entry_price)
                                                    - round(contracts * s.entry_fee, 2)
                                                    - round(contracts * s.exit_fee, 2), 2))
        self.assertEqual(booked["points"], [("2024-01-09", 100_000.0), ("2024-01-10", ledger.equity[-1])])
        self.assertAlmostEqual(booked["points"][-1][1] - 100_000.0, record["pnl"], places=6)
        rets = options.spread_returns(ledger, 100_000.0)
        self.assertAlmostEqual(rets[0], record["pnl"] / 100_000.0)

    def test_synthetic_clock(self) -> None:
        clock = options.SyntheticClock((10.0, 20.0, 30.0))
        self.assertEqual(clock.key(20.0), "2000-01-02")
        self.assertEqual(clock.real("2000-01-03"), 30.0)
        self.assertEqual(clock.keys(), ["2000-01-01", "2000-01-02", "2000-01-03"])
        with self.assertRaises(KeyError):
            clock.key(15.0)


def _nautilus_installed() -> bool:
    import os

    from strategies.qc_ports import nautilus_runner

    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_runner.require()
        return True
    try:
        nautilus_runner.require()
    except nautilus_runner.NautilusUnavailable:
        return False
    return True


@unittest.skipUnless(_nautilus_installed(), "nautilus-trader 1.227.0 not installed")
class NautilusBookingTest(unittest.TestCase):
    def test_same_day_spreads_book_in_nautilus_like_the_ledger(self) -> None:
        days = ["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11"]
        rows = []
        for i, day in enumerate(days):
            day_rows = flat_day(day, 400.0 + i)
            day_rows[-1] = day_rows[-1][:5] + (400.0 + i + (2.0 if i % 2 else -3.0), 1.0)
            rows += day_rows
        etf = options.EtfClock(bars_from(rows))
        market = spy_market(days)
        events = [options.OptionEvent("US500", "SPY", "long" if i % 2 else "short", ny_ms(day, "15:30"))
                  for i, day in enumerate(days[1:], start=1)]
        events.append(options.OptionEvent("SPY", "SPY", "long", ny_ms("2024-01-10", "15:45")))
        spreads, skipped = options.price_events(events, {"SPY": etf}, {"SPY": market})
        self.assertEqual((len(spreads), skipped), (4, []))
        closes = [ny_ms(day, "16:00") for day in days]
        booked = options.book(spreads, closes, 100_000.0)
        ledger, naut = booked["ledger"], booked["nautilus"]
        self.assertEqual(len(naut.trades), 4)
        for a, b in zip(ledger.equity, naut.equity):
            self.assertLessEqual(abs(a - b), 1e-6 * max(abs(a), 1.0))
        self.assertEqual([d for d, _ in booked["points"]], days)
        self.assertEqual(booked["points"], booked["ledgerPoints"])
        self.assertEqual(booked["points"][0][1], 100_000.0)
        self.assertEqual(max(naut.open_positions), 2)  # the 15:30 and 15:45 spreads of 2024-01-10 overlap
        self.assertEqual(len(options.spread_returns(naut, 100_000.0)), 4)


class MetricsTest(unittest.TestCase):
    def test_sum_legs(self) -> None:
        long = [("2024-01-01", 1.0), ("2024-01-02", 1.1), ("2024-01-03", 1.1)]
        short = [("2024-01-01", 1.0), ("2024-01-02", 1.0), ("2024-01-03", 0.99)]
        out = metrics.sum_legs([long, short])
        self.assertEqual([d for d, _ in out], ["2024-01-01", "2024-01-02", "2024-01-03"])
        self.assertAlmostEqual(out[1][1], 1.1)
        self.assertAlmostEqual(out[2][1], 1.1 * 0.99)
        self.assertEqual(metrics.sum_legs([]), [])
        self.assertEqual(metrics.sum_legs([long, [("2024-01-02", 1.0)]])[1][1], 1.1)

    def test_series_and_trade_returns(self) -> None:
        pts = [("2024-01-01", 2.0), ("2024-01-02", 1.0), ("2024-01-03", 3.0)]
        self.assertEqual(metrics.rebase(pts)[1], ("2024-01-02", 0.5))
        self.assertEqual(metrics.rebase([]), [])
        self.assertEqual(metrics.drawdown_series(pts), [("2024-01-01", 0.0), ("2024-01-02", -0.5), ("2024-01-03", 0.0)])
        trades = [{"pnl": 0.01, "before": 1.0, "day": "2024-01-02"}, {"pnl": -0.02, "before": 2.0, "day": "2024-02-01"}]
        self.assertEqual(metrics.trade_returns(trades), [0.01, -0.01])
        self.assertEqual(metrics.trade_returns(trades, "2024-02-01"), [-0.01])
        self.assertEqual(len(metrics.trades_between(trades, "2024-01-01", "2024-01-31")), 1)
        self.assertEqual(metrics.window(pts, pts[1:]), pts[1:])
        self.assertEqual(metrics.summary(pts[:1])["outOfSample"]["sharpe"], 0.0)


class VerdictTest(unittest.TestCase):
    @staticmethod
    def _summary(oos: float) -> dict:
        part = {"sharpe": oos, "cagr": 0.01, "maxDrawdown": -0.1}
        return {"full": part, "inSample": part, "outOfSample": part}

    @staticmethod
    def _checks(passes: list[bool]) -> list[dict]:
        return [{"check": f"g{i}", "result": f"r{i}", "pass": p} for i, p in enumerate(passes)]

    def test_pre_registered_rule(self) -> None:
        v = study.verdict_of
        dsr = {"probability": 0.97}
        all_pass = self._checks([True] * 5)
        self.assertEqual(v(self._summary(0.8), dsr, all_pass, self._summary(0.2), 500)[0], "edge")
        self.assertEqual(v(self._summary(0.8), dsr, all_pass, self._summary(-0.2), 500)[0], "needs-more-data")
        self.assertEqual(v(self._summary(0.8), dsr, all_pass, self._summary(0.2), 99)[0], "needs-more-data")
        self.assertEqual(v(self._summary(-0.1), dsr, self._checks([False, True, True, True, True]),
                           self._summary(0.2), 500)[0], "no-edge")
        self.assertEqual(v(self._summary(0.8), {"probability": 0.4}, self._checks([True, False, True, True, True]),
                           self._summary(0.2), 500)[0], "no-edge")
        three = self._checks([True, False, True, True, False])
        verdict, reason = v(self._summary(0.6), {"probability": 0.8}, three, self._summary(-1), 500)
        self.assertEqual(verdict, "needs-more-data")
        self.assertIn("g1: r1; g4: r4", reason)
        two = self._checks([True, False, True, False, False])
        self.assertEqual(v(self._summary(0.6), {"probability": 0.8}, two, self._summary(-1), 50)[0], "no-edge")

    def test_checks_follow_the_gate_thresholds(self) -> None:
        primary = {"full": {"sharpe": 1.0, "cagr": 0.1}, "inSample": {"sharpe": 1.0, "cagr": 0.1},
                   "outOfSample": {"sharpe": 0.5, "cagr": 0.05}}
        checks = study.checks_of(primary, {"probability": 0.95, "trials": 28},
                                 {"maxDrawdownP5": -0.35, "paths": 2000, "lossShare": 0.1}, 0.75, 9,
                                 {"sharpe": 0.01, "cagr": 0.0}, {"sharpe": 0.4}, {"sharpe": 0.5}, primary)
        self.assertEqual([c["pass"] for c in checks], [True, True, True, True, True, None, True])
        self.assertTrue(all(len(c["check"]) <= 80 and len(c["result"]) <= 300 for c in checks))


def synthetic_document(rows: int = 70) -> dict:
    run = {"symbol": "GHLZ US500", "market": "GHLZ: S&P 500 index CFD (ES proxy)", "from": "2012-01-17",
           "to": "2026-11-06", "trades": 3600, "cagr": 0.01, "sharpe": 0.3, "maxDrawdown": -0.2, "profitFactor": 1.05,
           "winRate": 0.51, "exposure": 0.07, "oosSharpe": 0.1, "oosCagr": 0.0, "buyHoldCagr": 0.1,
           "buyHoldSharpe": 0.7}
    primary = [(f"20{12 + i // 12:02d}-{i % 12 + 1:02d}-15", 1.0 + 0.01 * i) for i in range(60)]
    part = {"sharpe": 0.3, "maxDd": -0.2, "cagr": 0.01, "trades": 10}
    detail = {"primary": {"split": {"isFrom": "2012-01-17", "isTo": "2020-12-31", "oosFrom": "2020-12-31",
                                    "oosTo": "2026-11-06"}, "is": part, "oos": part, "full": part,
                          "options": {"trades": 5, "outOfSample": {"sharpe": 0.1}, "ledgerNautilusMaxGap": 0.0}},
              "missingMarkets": []}
    checks = study.checks_of({"full": {"sharpe": 0.3, "cagr": 0.01}, "inSample": {"sharpe": 0.4, "cagr": 0.02},
                              "outOfSample": {"sharpe": 0.1, "cagr": 0.0}}, {"probability": 0.2, "trials": 28},
                             {"maxDrawdownP5": -0.3, "paths": 2000, "lossShare": 0.4}, 0.5, 9,
                             {"sharpe": -0.1, "cagr": -0.01}, {"sharpe": 0.1}, {"sharpe": 0.2},
                             {"full": {"sharpe": 0.1}, "outOfSample": {"sharpe": -0.2}})
    sens = [{"param": "GHLZ signal end", "value": "10:30", "sharpe": 0.1, "cagr": 0.0, "maxDrawdown": -0.1, "trades": 9}]
    comp = [{"name": f"Row {i}", "kind": "strategy", "sharpe": 0.1, "cagr": 0.0, "maxDrawdown": -0.1,
             "source": "this study"} for i in range(40)]
    ld = [{"name": "LD34 portfolio", "kind": "strategy", "sharpe": 0.2, "cagr": 0.01, "maxDrawdown": -0.3,
           "source": "x"}]
    return study.document("2026-11-08", [run] * rows, [dict(run, symbol="GHLZ SPY opt (US500)")] * rows, sens, checks,
                          "no-edge", "Because.", primary, comp, ld,
                          {"commit": "0" * 40, "engine": "nautilus-trader-1.227.0", "dataHash": "sha256:" + "a" * 64,
                           "runId": "imom-2026-11-08"}, detail, {}, ["US500"])


class StudyDocumentTest(unittest.TestCase):
    def test_document_fits_the_schema_limits(self) -> None:
        doc = synthetic_document()
        self.assertEqual(doc["kind"], "strategy-backtest")
        self.assertEqual(doc["id"], "market-intraday-momentum")
        self.assertEqual(doc["spec"], "docs/specs/strategies/market-intraday-momentum.md")
        self.assertTrue((REPO / doc["spec"]).exists())
        self.assertEqual([f["key"] for f in doc["forms"]], ["underlying", "options"])
        self.assertLessEqual(len(doc["comparison"]), 30)
        self.assertEqual(doc["comparison"][-1]["name"], "LD34 portfolio")
        self.assertLessEqual(len(doc["notes"]), 4000)
        self.assertLessEqual(len(doc["robustness"]), 20)
        months = [p["month"] for p in doc["equity"]]
        self.assertEqual(months, sorted(set(months)))
        self.assertEqual(study.finite({"a": [1.0, float("nan")], "b": float("inf")}, log=lambda _: None),
                         {"a": [1.0, 0.0], "b": 0.0})

    def test_document_validates_with_the_import_dry_run(self) -> None:
        bun = shutil.which("bun")
        if bun is None or not (REPO / "node_modules").exists():
            self.skipTest("bun and the workspace node_modules are needed for the schema check")
        doc = json.dumps(study.finite(synthetic_document(), log=lambda _: None), allow_nan=False)
        proc = subprocess.run([bun, "run", "vertex:research-studies:import", "--dry-run"], input=doc, text=True,
                              capture_output=True, cwd=REPO, timeout=300, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertIn('"dryRun":true', proc.stdout)


class RulesTest(unittest.TestCase):
    def test_lengths_fit_the_study_schema(self) -> None:
        self.assertLessEqual(len(rules.RULES), 30)
        self.assertLessEqual(len(rules.GAPS), 30)
        for row in rules.RULES:
            self.assertLessEqual(len(row["item"]), 60)
            self.assertLessEqual(len(row["rule"]), 400)
            self.assertLessEqual(len(row["source"]), 200)
            self.assertEqual(row["rule"], row["rule"].strip())
        for row in rules.GAPS:
            self.assertLessEqual(len(row["gap"]), 300)
            self.assertLessEqual(len(row["choice"]), 400)


if __name__ == "__main__":
    unittest.main()
