"""Standard-library tests of odte_quotes.py (fake IBKR source; no network, no broker)."""
from __future__ import annotations

import ast
import csv
import gzip
import sys
import tempfile
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves the script folder off sys.path
import odte_quotes as oq  # noqa: E402

DAY = date(2026, 11, 19)
OPEN = int(datetime(2026, 11, 19, 9, 30, tzinfo=oq.NY).timestamp())


def bar(minute: int, o: float, h: float | None = None, low: float | None = None, c: float | None = None) -> tuple:
    return (OPEN + 60 * minute, o, h if h is not None else o, low if low is not None else o, c if c is not None else o, 0)


class FakeSource:
    def __init__(self, contracts, fail_at: int | None = None, no_data: set | None = None,
                 bars: dict | None = None) -> None:
        self.contracts = contracts
        self.fail_at = fail_at
        self.no_data = no_data or set()
        self.bars = bars or {}  # (right, strike, what) -> bars that replace the default answer
        self.calls: list[str] = []

    def underlying_bars(self, day):
        self.calls.append("SPY")
        # pre-market bar outside the session range must not move low/high
        return [bar(-60, 600.0, 600.0, 600.0), bar(0, 500.2, 500.6, 499.6), bar(389, 501.0, 501.3, 500.9)]

    def option_contracts(self, day):
        self.calls.append("contracts")
        return list(self.contracts)

    def option_bars(self, day, c, what):
        self.calls.append(f"{c.right}{c.strike:g}{what}")
        if self.fail_at is not None and len(self.calls) - 2 == self.fail_at:
            raise oq.IbError("IBKR 162 pacing violation")
        if (c.right, c.strike, what) in self.no_data:
            raise oq.NoData("no data")
        if (c.right, c.strike, what) in self.bars:
            return self.bars[(c.right, c.strike, what)]
        base = 1.0 if what == "BID" else 1.1
        return [bar(0, base), bar(375, base / 2)]


def chain(strikes=range(490, 512), extra=(495.5, 520.0)):
    out = []
    for k in list(strikes) + list(extra):
        for r in "CP":
            out.append(oq.OptionContract(r, float(k), 1000 + int(k * 10) + (r == "P")))
    return out


def flat_run(start: int, minutes: int, price: float) -> list[tuple]:
    """`minutes` consecutive bars from session minute `start` with open = high = low = close = `price`."""
    return [bar(start + m, price) for m in range(minutes)]


def frozen(*contracts: tuple[str, float], minutes: int = 40) -> dict:
    """FakeSource bars: each (right, strike) quotes 1.00 / 1.10 unchanged for `minutes` minutes from 09:30."""
    out = {}
    for right, strike in contracts:
        out[(right, strike, "BID")] = flat_run(0, minutes, 1.0)
        out[(right, strike, "ASK")] = flat_run(0, minutes, 1.1)
    return out


def crossed(*contracts: tuple[str, float], opens: int = 10) -> dict:
    """FakeSource bars: each (right, strike) has `opens` moving bars whose bid open is above the ask open."""
    out = {}
    for right, strike in contracts:
        out[(right, strike, "BID")] = [bar(m, 1.2 + 0.01 * m) for m in range(opens)]
        out[(right, strike, "ASK")] = [bar(m, 1.1 + 0.01 * m) for m in range(opens)]
    return out


def read_gz(path: Path) -> list[list[str]]:
    with gzip.open(path, "rt", newline="") as f:
        return list(csv.reader(f))


class PureTest(unittest.TestCase):
    def test_session_range_uses_0930_to_1600_only(self):
        rng = oq.session_range([bar(-1, 1.0, 900.0, 1.0), bar(0, 5, 6, 4), bar(389, 5, 7, 5), bar(390, 5, 99, 0.5)], DAY)
        self.assertEqual(rng, (4.0, 7.0))
        self.assertIsNone(oq.session_range([bar(-5, 1.0)], DAY))

    def test_select_contracts_whole_dollar_wings_fixed_order(self):
        picked = oq.select_contracts(chain(), 499.6, 501.3)
        strikes = sorted({c.strike for c in picked})
        self.assertEqual(strikes, [float(k) for k in range(493, 509)])  # floor(499.6)-6 .. ceil(501.3)+6
        self.assertEqual(len(picked), 2 * len(strikes))
        self.assertEqual([(c.right, c.strike) for c in picked[:2]], [("C", 500.0), ("P", 500.0)])
        self.assertNotIn(495.5, strikes)

    def test_merge_quotes_blank_missing_side(self):
        rows = oq.merge_quotes([bar(0, 1.0), bar(1, 1.2)], [bar(1, 1.3), bar(2, 1.4)])
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0][5:], ["", "", "", ""])
        self.assertEqual(rows[2][1:5], ["", "", "", ""])
        self.assertEqual(rows[1], [str(OPEN + 60), "1.2", "1.2", "1.2", "1.2", "1.3", "1.3", "1.3", "1.3"])


def health(bid: list[tuple], ask: list[tuple]) -> tuple[int, int]:
    return oq.quote_health(oq.merge_quotes(bid, ask), DAY)


class StaleRuleTest(unittest.TestCase):
    """quote_health and is_stale follow Amendment 2026-11-28 (f)-(g), the rule of FileQuoteBook."""

    def test_flat_run_needs_30_minutes_with_ask_above_ten_cents(self):
        self.assertEqual(health(flat_run(0, 30, 1.0), flat_run(0, 30, 1.1)), (0, 30))
        self.assertEqual(health(flat_run(0, 29, 1.0), flat_run(0, 29, 1.1)), (0, 29))
        self.assertEqual(health(flat_run(0, 40, 0.05), flat_run(0, 40, 0.10)), (0, 0))
        self.assertEqual(health(flat_run(0, 40, 0.05), flat_run(0, 40, 0.11)), (0, 40))
        self.assertTrue(oq.is_stale((0, 30)))
        self.assertFalse(oq.is_stale((9, 29)))

    def test_a_gap_a_blank_side_a_new_pair_or_a_moving_bar_ends_a_run(self):
        bid, gap = flat_run(0, 40, 1.0), flat_run(0, 20, 1.0) + flat_run(21, 19, 1.0)
        self.assertEqual(health(gap, flat_run(0, 20, 1.1) + flat_run(21, 19, 1.1)), (0, 20))  # no bar at minute 20
        self.assertEqual(health(gap, flat_run(0, 40, 1.1)), (0, 20))  # minute 20 has no bid
        self.assertEqual(health(bid, flat_run(0, 15, 1.1) + flat_run(15, 25, 1.2)), (0, 25))  # the ask moved once
        moving = flat_run(0, 20, 1.1) + [bar(20, 1.1, 1.2, 1.1, 1.15)] + flat_run(21, 19, 1.1)
        self.assertEqual(health(bid, moving), (0, 20))  # close != open at minute 20

    def test_only_bars_from_0930_count(self):
        self.assertEqual(health(flat_run(-40, 40, 1.0), flat_run(-40, 40, 1.1)), (0, 0))
        self.assertEqual(health(flat_run(-10, 40, 1.0), flat_run(-10, 40, 1.1)), (0, 30))
        pre = crossed(("C", 1.0), opens=10)
        shifted = [(t - 5 * 60, *rest) for t, *rest in pre[("C", 1.0, "BID")]]
        self.assertEqual(health(shifted, [(t - 5 * 60, *rest) for t, *rest in pre[("C", 1.0, "ASK")]])[0], 5)

    def test_blank_closes_count_as_equal_and_the_last_row_of_a_minute_wins(self):
        def row(m, bid, ask, bid_close="", ask_close=""):
            return [str(OPEN + 60 * m), str(bid), "", "", bid_close, str(ask), "", "", ask_close]

        self.assertEqual(oq.quote_health([row(m, 1.0, 1.1) for m in range(30)], DAY), (0, 30))
        self.assertEqual(oq.quote_health([row(m, 1.0, 1.1, "1.0", "1.2") for m in range(30)], DAY), (0, 0))
        self.assertEqual(oq.quote_health([row(5, 1.2, 1.1), row(5, 1.0, 1.1)], DAY), (0, 1))  # crossed row replaced
        self.assertEqual(oq.quote_health(list(reversed([row(m, 1.0, 1.1) for m in range(30)])), DAY), (0, 30))

    def test_crossed_opens_count_bar_opens_only(self):
        ten = crossed(("C", 1.0), opens=10)
        self.assertEqual(health(ten[("C", 1.0, "BID")], ten[("C", 1.0, "ASK")]), (10, 1))
        self.assertEqual(health([bar(0, 1.0, 1.3, 1.0, 1.25)], [bar(0, 1.1, 1.2, 1.1, 1.2)]), (0, 0))  # close crossed
        self.assertTrue(oq.is_stale((10, 1)))
        self.assertFalse(oq.is_stale((9, 1)))


class FormatTest(unittest.TestCase):
    def test_prices_and_volumes_read_back_exactly(self):
        self.assertEqual(oq.price_text(2.67), "2.67")
        self.assertEqual(oq.price_text(739.905), "739.905")
        self.assertEqual(oq.price_text(1000.125), "1000.125")
        self.assertEqual(oq.price_text(5.0), "5")
        self.assertEqual(oq.volume_text(1234567.0), "1234567")
        self.assertEqual(float(oq.price_text(0.1 + 0.2)), 0.1 + 0.2)

    def test_error_classification(self):
        self.assertEqual(oq.classify_error(162, "HMDS query returned no data: SPY", "C700 BID"), "no_data")
        self.assertEqual(oq.classify_error(162, "Historical Market Data Service error message:API historical "
                                                "data query cancelled", "C700 BID"), "stop")
        self.assertEqual(oq.classify_error(162, "pacing violation", "C700 BID"), "stop")
        self.assertEqual(oq.classify_error(200, "No security definition has been found", oq.OPTION_LOOKUP),
                         "none_listed")
        self.assertEqual(oq.classify_error(200, "No security definition has been found", "C700 BID"), "stop")
        self.assertEqual(oq.classify_error(504, "Not connected", oq.OPTION_LOOKUP), "stop")


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log: list[str] = []
        self.now = lambda: datetime(2026, 11, 19, 21, 30, tzinfo=timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def run_collect(self, source):
        return oq.collect(lambda: source, self.root, DAY, self.log.append, self.now)

    def test_complete_day_files_manifest_status(self):
        src = FakeSource(chain(), no_data={("P", 508.0, "ASK")})
        self.assertEqual(self.run_collect(src), 0)
        folder = self.root / "2026-11-19"
        status = oq.read_status(folder)
        self.assertEqual(status["state"], "complete")
        self.assertEqual(status["contracts"], "32")
        self.assertEqual(status["empty_wings"], "1")
        self.assertEqual(status["stale_in_range"], "0")
        self.assertEqual(status["requests"], str(2 + 64))
        manifest = oq.read_manifest(folder)
        self.assertEqual(len(manifest), 32)
        row = manifest["SPY-20261119-C-500.csv.gz"]
        self.assertEqual((row["bid_bars"], row["ask_bars"], row["first_epoch"]), ("2", "2", str(OPEN)))
        self.assertEqual(oq.file_health(folder / "SPY-20261119-C-500.csv.gz", DAY), (0, 1))
        self.assertEqual(manifest["SPY-20261119-P-508.csv.gz"]["ask_bars"], "0")
        quotes = read_gz(folder / "SPY-20261119-C-500.csv.gz")
        self.assertEqual(quotes[0], oq.QUOTE_FIELDS)
        self.assertEqual(quotes[1][1], "1")
        self.assertEqual(quotes[1][5], "1.1")
        self.assertEqual(len(read_gz(folder / "underlying.csv.gz")), 4)
        self.assertFalse(list(folder.glob("*.tmp")))
        # a second run does nothing
        again = FakeSource(chain())
        self.assertEqual(self.run_collect(again), 0)
        self.assertEqual(again.calls, [])

    def test_ib_error_stops_day_and_next_run_resumes(self):
        first = FakeSource(chain(), fail_at=5)  # 3rd contract's BID
        self.assertEqual(self.run_collect(first), 1)
        folder = self.root / "2026-11-19"
        status = oq.read_status(folder)
        self.assertEqual(status["state"], "partial")
        self.assertIn("pacing violation", status["reason"])
        self.assertEqual(len(oq.read_manifest(folder)), 2)
        self.assertEqual(len(first.calls), 2 + 5)  # stopped at the first error
        second = FakeSource(chain())
        self.assertEqual(self.run_collect(second), 0)
        self.assertEqual(len(second.calls), 2 + 2 * 30)  # the two stored contracts are skipped
        self.assertEqual(oq.read_status(folder)["state"], "complete")

    def test_dropped_bars_inside_range_keep_day_partial_and_retry(self):
        first = FakeSource(chain(), no_data={("C", 501.0, "BID"), ("C", 501.0, "ASK")})
        self.assertEqual(self.run_collect(first), 1)
        status = oq.read_status(self.root / "2026-11-19")
        self.assertEqual(status["state"], "partial")
        self.assertIn("SPY-20261119-C-501.csv.gz", status["reason"])
        second = FakeSource(chain())
        self.assertEqual(self.run_collect(second), 0)
        self.assertEqual(second.calls, ["contracts", "SPY", "C501BID", "C501ASK"])
        self.assertEqual(oq.read_manifest(self.root / "2026-11-19")["SPY-20261119-C-501.csv.gz"]["bid_bars"], "2")

    def test_failed_connection_never_downgrades_a_done_day(self):
        self.assertEqual(self.run_collect(FakeSource(chain())), 0)

        def down():
            raise oq.IbError("gateway handshake timed out")

        self.assertEqual(oq.collect(down, self.root, DAY, self.log.append, self.now), 0)
        self.assertEqual(oq.read_status(self.root / "2026-11-19")["state"], "complete")
        other = date(2026, 11, 18)
        self.assertEqual(oq.collect(down, self.root, other, self.log.append, self.now), 1)
        self.assertIn("handshake", oq.read_status(self.root / "2026-11-18")["reason"])

    def test_today_before_1615_collects_nothing(self):
        src = FakeSource(chain())
        early = lambda: datetime(2026, 11, 19, 16, 10, tzinfo=oq.NY)  # noqa: E731
        self.assertEqual(oq.collect(lambda: src, self.root, DAY, self.log.append, early), 0)
        self.assertEqual(src.calls, [])
        self.assertFalse((self.root / "2026-11-19").exists())
        late = lambda: datetime(2026, 11, 19, 16, 20, tzinfo=oq.NY)  # noqa: E731
        self.assertEqual(oq.collect(lambda: src, self.root, DAY, self.log.append, late), 0)
        self.assertEqual(oq.read_status(self.root / "2026-11-19")["state"], "complete")

    def test_holiday_is_no_expiry(self):
        class Holiday(FakeSource):
            def underlying_bars(self, day):
                self.calls.append("SPY")
                raise oq.NoData("no data")

        src = Holiday([])
        self.assertEqual(self.run_collect(src), 0)
        self.assertEqual(src.calls, ["contracts", "SPY"])
        self.assertEqual(oq.read_status(self.root / "2026-11-19")["state"], "no_expiry")

    def test_no_contracts_on_a_trading_day_is_partial(self):
        self.assertEqual(self.run_collect(FakeSource([])), 1)
        status = oq.read_status(self.root / "2026-11-19")
        self.assertEqual(status["state"], "partial")
        self.assertIn("listed no SPY option", status["reason"])

    def test_error_before_contracts_is_partial(self):
        class Down(FakeSource):
            def option_contracts(self, day):
                raise oq.IbError("no answer")

        self.assertEqual(self.run_collect(Down(chain())), 1)
        self.assertEqual(oq.read_status(self.root / "2026-11-19")["state"], "partial")

    # In-range contracts here: strikes 499..502 (floor(499.6)..ceil(501.3)), calls and puts: 8 contracts, so the
    # stale-session limit (20%) is 2 of them.
    STALE_PAIR = (("C", 500.0), ("P", 500.0))

    def test_frozen_session_stays_partial_and_next_run_asks_again_for_the_frozen_contracts(self):
        first = FakeSource(chain(), bars=frozen(*self.STALE_PAIR))
        self.assertEqual(self.run_collect(first), 1)
        folder = self.root / "2026-11-19"
        status = oq.read_status(folder)
        self.assertEqual(status["state"], "partial")
        self.assertIn("stale session: 2 of 8 contracts", status["reason"])
        self.assertIn("e.g. SPY-20261119-C-500.csv.gz", status["reason"])
        self.assertEqual((status["stale_in_range"], status["low"], status["high"]), ("2", "499.6", "501.3"))
        self.assertEqual(oq.file_health(folder / "SPY-20261119-P-500.csv.gz", DAY), (0, 40))
        second = FakeSource(chain())
        self.assertEqual(self.run_collect(second), 0)
        self.assertEqual(second.calls, ["contracts", "SPY", "C500BID", "C500ASK", "P500BID", "P500ASK"])
        status = oq.read_status(folder)
        self.assertEqual((status["state"], status["stale_in_range"]), ("complete", "0"))
        self.assertEqual(oq.file_health(folder / "SPY-20261119-P-500.csv.gz", DAY), (0, 1))

    def test_crossed_session_stays_partial(self):
        self.assertEqual(self.run_collect(FakeSource(chain(), bars=crossed(*self.STALE_PAIR))), 1)
        status = oq.read_status(self.root / "2026-11-19")
        self.assertIn("stale session: 2 of 8 contracts", status["reason"])
        self.assertEqual(oq.file_health(self.root / "2026-11-19" / "SPY-20261119-C-500.csv.gz", DAY), (10, 1))

    def test_stale_contracts_below_the_limit_leave_the_day_complete(self):
        src = FakeSource(chain(), bars={**frozen(("C", 501.0)), **crossed(("P", 502.0), opens=9),
                                        **frozen(("C", 508.0), ("P", 490.0))})  # 1 in range; 9 crossed; 2 wings
        self.assertEqual(self.run_collect(src), 0)
        status = oq.read_status(self.root / "2026-11-19")
        self.assertEqual((status["state"], status["stale_in_range"]), ("complete", "1"))

    def test_range_bounds_are_floor_low_and_ceil_high(self):
        inside = FakeSource(chain(), bars=frozen(("C", 499.0), ("P", 502.0)))  # floor(499.6) and ceil(501.3)
        self.assertEqual(self.run_collect(inside), 1)
        self.assertIn("stale session: 2 of 8 contracts", oq.read_status(self.root / "2026-11-19")["reason"])
        outside = FakeSource(chain(), bars=frozen(("C", 498.0), ("P", 503.0)))  # wings: not counted
        self.assertEqual(oq.collect(lambda: outside, self.root / "other", DAY, self.log.append, self.now), 0)
        status = oq.read_status(self.root / "other" / "2026-11-19")
        self.assertEqual((status["state"], status["stale_in_range"]), ("complete", "0"))

    def test_a_retry_that_is_still_frozen_replaces_the_file_and_keeps_the_day_partial(self):
        self.assertEqual(self.run_collect(FakeSource(chain(), bars=frozen(*self.STALE_PAIR))), 1)
        again = FakeSource(chain(), bars=frozen(*self.STALE_PAIR, minutes=35))
        self.assertEqual(self.run_collect(again), 1)
        self.assertEqual(again.calls[2:], ["C500BID", "C500ASK", "P500BID", "P500ASK"])
        folder = self.root / "2026-11-19"
        self.assertEqual(oq.file_health(folder / "SPY-20261119-C-500.csv.gz", DAY), (0, 35))
        self.assertEqual(oq.read_manifest(folder)["SPY-20261119-C-500.csv.gz"]["bid_bars"], "35")
        self.assertIn("stale session: 2 of 8 contracts", oq.read_status(folder)["reason"])

    def test_missing_file_of_an_in_range_contract_is_asked_again(self):
        self.assertEqual(self.run_collect(FakeSource(chain())), 0)
        folder = self.root / "2026-11-19"
        oq.write_status(folder, state="partial", reason="test")
        (folder / "SPY-20261119-C-500.csv.gz").unlink()
        again = FakeSource(chain())
        self.assertEqual(self.run_collect(again), 0)
        self.assertEqual(again.calls[2:], ["C500BID", "C500ASK"])

    def test_unreadable_stored_file_is_asked_again(self):
        self.assertEqual(self.run_collect(FakeSource(chain())), 0)
        folder = self.root / "2026-11-19"
        oq.write_status(folder, state="partial", reason="test")
        (folder / "SPY-20261119-C-500.csv.gz").write_bytes(b"cut short")
        again = FakeSource(chain())
        self.assertEqual(self.run_collect(again), 0)
        self.assertEqual(again.calls[2:], ["C500BID", "C500ASK"])
        self.assertEqual(oq.file_health(folder / "SPY-20261119-C-500.csv.gz", DAY), (0, 1))

    def test_in_range_row_without_a_readable_file_keeps_the_day_partial(self):
        self.assertEqual(self.run_collect(FakeSource(chain())), 0)
        folder = self.root / "2026-11-19"
        oq.write_status(folder, state="partial", reason="test")
        (folder / "SPY-20261119-C-500.csv.gz").write_bytes(b"cut short")
        unlisted = [c for c in chain() if (c.right, c.strike) != ("C", 500.0)]  # IBKR no longer lists C 500
        again = FakeSource(unlisted)
        self.assertEqual(self.run_collect(again), 1)
        self.assertEqual(again.calls, ["contracts", "SPY"])
        self.assertIn("1 contracts inside the day's range have no BID or ASK bars or no readable file, "
                      "e.g. SPY-20261119-C-500.csv.gz", oq.read_status(folder)["reason"])
        self.assertIsNone(oq.file_health(folder / "missing.csv.gz", DAY))

    def test_new_answer_without_a_side_keeps_the_stored_frozen_file(self):
        four = (*self.STALE_PAIR, ("C", 501.0), ("P", 501.0))
        self.assertEqual(self.run_collect(FakeSource(chain(), bars=frozen(*four))), 1)
        second = FakeSource(chain(), no_data={("C", 500.0, "ASK")})
        self.assertEqual(self.run_collect(second), 0)  # 1 of 8 still frozen: below the limit
        self.assertEqual(len(second.calls), 2 + 8)
        folder = self.root / "2026-11-19"
        status = oq.read_status(folder)
        self.assertEqual((status["state"], status["stale_in_range"]), ("complete", "1"))
        row = oq.read_manifest(folder)["SPY-20261119-C-500.csv.gz"]
        self.assertEqual(row["ask_bars"], "40")
        self.assertEqual(oq.file_health(folder / "SPY-20261119-C-500.csv.gz", DAY), (0, 40))
        self.assertTrue(any("C-500.csv.gz: no BID or ASK bars on the new request" in line for line in self.log))


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.posts: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def day(self, d: str, state: str) -> None:
        (self.root / d).mkdir()
        oq.write_status(self.root / d, state=state, reason="IBKR 162 x" if state == "partial" else "")

    def test_due_days_weekdays_after_2030(self):
        fri_evening = datetime(2026, 11, 20, 20, 35, tzinfo=oq.NY)
        self.assertEqual(oq.due_days(fri_evening, 7)[-1], date(2026, 11, 20))
        fri_noon = datetime(2026, 11, 20, 12, 0, tzinfo=oq.NY)
        self.assertEqual(oq.due_days(fri_noon, 7)[-1], date(2026, 11, 19))
        monday = datetime(2026, 11, 23, 9, 0, tzinfo=oq.NY)
        self.assertEqual(oq.due_days(monday, 4), [date(2026, 11, 20)])

    def test_missed_days_alert_once(self):
        for d in ("2026-11-16", "2026-11-17", "2026-11-19"):
            self.day(d, "complete")
        self.day("2026-11-18", "no_expiry")
        self.day("2026-11-20", "partial")
        now = datetime(2026, 11, 20, 20, 31, tzinfo=oq.NY)
        post = lambda t: self.posts.append(t) or True  # noqa: E731
        self.assertEqual(oq.check(self.root, now, post, 5, lambda s: None), 0)
        self.assertEqual(len(self.posts), 1)
        self.assertIn("2026-11-20", self.posts[0])
        self.assertIn("IBKR 162 x", self.posts[0])
        self.assertEqual(oq.check(self.root, now, post, 5, lambda s: None), 0)
        self.assertEqual(len(self.posts), 1)  # remembered in alerted.txt

    def test_missing_folder_is_missed_and_failed_post_retries(self):
        now = datetime(2026, 11, 24, 20, 31, tzinfo=oq.NY)
        self.day("2026-11-23", "complete")
        self.assertEqual(oq.check(self.root, now, lambda t: False, 2, lambda s: None), 1)
        self.assertFalse((self.root / "alerted.txt").exists())
        self.assertEqual(oq.check(self.root, now, lambda t: self.posts.append(t) or True, 2, lambda s: None), 0)
        self.assertIn("2026-11-24 (state missing)", self.posts[0])
        self.assertIn("systemctl start vertex-odte-quotes", self.posts[0])
        later = datetime(2026, 11, 25, 20, 31, tzinfo=oq.NY)  # 2026-11-24 is now in the past: lost
        self.day("2026-11-25", "complete")
        (self.root / "alerted.txt").unlink()
        oq.check(self.root, later, lambda t: self.posts.append(t) or True, 3, lambda s: None)
        self.assertIn("2026-11-24", self.posts[-1])
        self.assertIn("collect --day 2026-11-24", self.posts[-1])

    def test_days_before_collection_start_are_never_missed(self):
        now = datetime(2026, 11, 19, 20, 31, tzinfo=oq.NY)
        self.day("2026-11-19", "complete")
        self.assertEqual(oq.due_days(now, 7), [date(2026, 11, 19)])
        self.assertEqual(oq.check(self.root, now, lambda t: self.posts.append(t) or True, 7, lambda s: None), 0)
        self.assertEqual(self.posts, [])

    def test_all_done_is_quiet(self):
        self.day("2026-11-16", "complete")
        now = datetime(2026, 11, 16, 21, 0, tzinfo=oq.NY)
        self.assertEqual(oq.check(self.root, now, lambda t: self.posts.append(t) or True, 1, lambda s: None), 0)
        self.assertEqual(self.posts, [])


class _Bar:
    def __init__(self, epoch, o, h, low, c, v=0):
        self.date, self.open, self.high, self.low, self.close, self.volume = str(epoch), o, h, low, c, v


class _Details:
    def __init__(self, right, strike, con_id):
        self.contract = types.SimpleNamespace(right=right, strike=strike, conId=con_id)


class FakeEClient:
    """Stand-in for ibapi 9.81 EClient: answers through the wrapper callbacks from a per-test script."""

    script: Callable = staticmethod(lambda client, req_id, kind, args: None)
    handshake = True

    def __init__(self, wrapper):
        self.wrapper = wrapper
        self.sent: list = []
        self.disconnected = False

    def connect(self, host, port, client_id):
        self.sent.append(("connect", host, port, client_id))
        if FakeEClient.handshake:
            self.wrapper.nextValidId(1)

    def run(self):
        return None

    def disconnect(self):
        self.disconnected = True

    def reqContractDetails(self, req_id, contract):  # noqa: N802 - ibapi name
        self.sent.append(("details", contract))
        FakeEClient.script(self, req_id, "details", (contract,))

    def reqHistoricalData(self, req_id, contract, end, duration, size, what, rth, fmt, keep, opts):  # noqa: N802
        self.sent.append(("hist", contract, end, duration, size, what, rth, fmt))
        FakeEClient.script(self, req_id, "hist", (contract, what))


class IbSourceTest(unittest.TestCase):
    """IbSource against stub ibapi modules (no network): request fields, error mapping, spacing, timeouts."""

    def setUp(self):
        self.saved = {k: sys.modules.get(k) for k in ("ibapi", "ibapi.client", "ibapi.wrapper", "ibapi.contract")}
        sys.modules["ibapi"] = types.ModuleType("ibapi")
        sys.modules["ibapi.client"] = types.SimpleNamespace(EClient=FakeEClient)
        sys.modules["ibapi.wrapper"] = types.SimpleNamespace(EWrapper=type("EWrapper", (), {}))
        sys.modules["ibapi.contract"] = types.SimpleNamespace(Contract=types.SimpleNamespace)
        FakeEClient.handshake = True
        self.now = [100.0]
        self.sleeps: list[float] = []

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    def source(self, script, timeout=1.0):
        FakeEClient.script = staticmethod(script)

        def sleep(seconds):
            self.sleeps.append(seconds)
            self.now[0] += seconds

        return oq.IbSource("172.18.0.2", 4003, 187, 30.0, timeout=timeout, clock=lambda: self.now[0], sleep=sleep,
                           handshake_timeout=0.2)

    def test_contracts_bars_and_spacing(self):
        def script(client, req_id, kind, args):
            if kind == "details":
                client.wrapper.contractDetails(req_id, _Details("C", 700.0, 11))
                client.wrapper.contractDetails(req_id, _Details("P", 700.0, 12))
                client.wrapper.contractDetailsEnd(req_id)
            else:
                client.wrapper.error(req_id, 2104, "Market data farm connection is OK")  # notice: ignored
                client.wrapper.historicalData(req_id, _Bar(OPEN, 1.0, 1.2, 0.9, 1.1))
                client.wrapper.historicalDataEnd(req_id, "", "")

        src = self.source(script)
        self.assertEqual(src.app.sent[0], ("connect", "172.18.0.2", 4003, 187))
        listed = src.option_contracts(DAY)
        self.assertEqual(listed, [oq.OptionContract("C", 700.0, 11), oq.OptionContract("P", 700.0, 12)])
        details = src.app.sent[1][1]
        self.assertEqual((details.symbol, details.secType, details.lastTradeDateOrContractMonth, details.tradingClass),
                         ("SPY", "OPT", "20261119", "SPY"))
        self.now[0] += 5.0
        bars = src.option_bars(date(2026, 11, 18), listed[0], "BID")
        self.assertEqual(bars, [(OPEN, 1.0, 1.2, 0.9, 1.1, 0)])
        self.assertEqual(self.sleeps, [25.0])  # 30 s between request starts, 5 s already passed
        hist = src.app.sent[2]
        self.assertEqual((hist[1].conId, hist[2], hist[3], hist[4], hist[5], hist[6], hist[7]),
                         (11, "20261118 23:59:59 US/Eastern", "1 D", "1 min", "BID", 1, 2))
        under = src.underlying_bars(datetime.now(oq.NY).date())
        self.assertEqual(len(under), 1)
        self.assertEqual((src.app.sent[3][1].secType, src.app.sent[3][2], src.app.sent[3][5]), ("STK", "", "TRADES"))
        src.close()
        self.assertTrue(src.app.disconnected)

    def test_error_mapping_and_timeout(self):
        replies = {"BID": (162, "HMDS query returned no data: SPY"), "ASK": (162, "Historical data request pacing violation")}

        def script(client, req_id, kind, args):
            if kind == "details":
                client.wrapper.error(req_id, 200, "No security definition has been found for the request")
            elif args[1] in replies:
                client.wrapper.error(req_id, *replies[args[1]])
            # TRADES: no answer at all -> timeout

        src = self.source(script, timeout=0.05)
        self.assertEqual(src.option_contracts(DAY), [])
        c = oq.OptionContract("C", 700.0, 11)
        with self.assertRaises(oq.NoData):
            src.option_bars(DAY, c, "BID")
        with self.assertRaises(oq.IbError) as err:
            src.option_bars(DAY, c, "ASK")
        self.assertIn("pacing violation", str(err.exception))
        with self.assertRaises(oq.IbError) as err:
            src.underlying_bars(DAY)
        self.assertIn("no answer", str(err.exception))

    def test_silent_gateway_fails_the_handshake(self):
        FakeEClient.handshake = False
        with self.assertRaises(oq.IbError) as err:
            self.source(lambda *a: None)
        self.assertIn("handshake timed out", str(err.exception))


class ReadOnlyScanTest(unittest.TestCase):
    """The collector may call only these IB client methods; no order, account, position or streaming API."""

    ALLOWED = {"connect", "disconnect", "run", "reqContractDetails", "reqHistoricalData"}

    def test_only_allowed_ib_calls(self):
        src = Path(oq.__file__).read_text(encoding="utf-8")
        calls = {n.func.attr for n in ast.walk(ast.parse(src))
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                 and isinstance(n.func.value, ast.Attribute) and n.func.value.attr == "app"}
        self.assertTrue(calls <= self.ALLOWED, calls - self.ALLOWED)
        self.assertEqual(calls & {"reqContractDetails", "reqHistoricalData"}, {"reqContractDetails", "reqHistoricalData"})
        for banned in ("placeOrder", "cancelOrder", "reqGlobalCancel", "reqAccount", "reqPositions", "reqMktData",
                       "reqExecutions", "reqOpenOrders", "reqAllOpenOrders", "exerciseOptions"):
            self.assertNotIn(banned, src)

    def test_client_id_is_not_a_used_one(self):
        used = {31, 77, 78, 91, 97, 98, 177, 179, 211, 61, 62} | set(range(41, 51))  # in use on 2026-11-19
        self.assertNotIn(oq.DEFAULT_CLIENT_ID, used)


if __name__ == "__main__":
    unittest.main()
