"""Standard-library tests of odte_quotes.py (fake IBKR source; no network, no broker)."""
from __future__ import annotations

import ast
import csv
import gzip
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves the script folder off sys.path
import odte_quotes as oq  # noqa: E402

DAY = date(2026, 11, 19)
OPEN = int(datetime(2026, 11, 19, 9, 30, tzinfo=oq.NY).timestamp())


def bar(minute: int, o: float, h: float | None = None, low: float | None = None, c: float | None = None) -> tuple:
    return (OPEN + 60 * minute, o, h if h is not None else o, low if low is not None else o, c if c is not None else o, 0)


class FakeSource:
    def __init__(self, contracts, fail_at: int | None = None, no_data: set | None = None) -> None:
        self.contracts = contracts
        self.fail_at = fail_at
        self.no_data = no_data or set()
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
        base = 1.0 if what == "BID" else 1.1
        return [bar(0, base), bar(375, base / 2)]


def chain(strikes=range(490, 512), extra=(495.5, 520.0)):
    out = []
    for k in list(strikes) + list(extra):
        for r in "CP":
            out.append(oq.OptionContract(r, float(k), 1000 + int(k * 10) + (r == "P")))
    return out


def read_gz(path: Path) -> list[list[str]]:
    with gzip.open(path, "rt", newline="") as f:
        return list(csv.reader(f))


class PureTest(unittest.TestCase):
    def test_session_range_uses_0930_to_1600_only(self):
        rng = oq.session_range([bar(-1, 1.0, 900.0, 1.0), bar(0, 5, 6, 4), bar(389, 5, 7, 5), bar(390, 5, 99, 0.5)], DAY)
        self.assertEqual(rng, (4.0, 7.0))
        self.assertIsNone(oq.session_range([bar(-5, 1.0)], DAY))

    def test_select_contracts_whole_dollar_wings_nearest_first(self):
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
        self.assertEqual(status["requests"], str(2 + 64))
        manifest = oq.read_manifest(folder)
        self.assertEqual(len(manifest), 32)
        row = manifest["SPY-20261119-C-500.csv.gz"]
        self.assertEqual((row["bid_bars"], row["ask_bars"], row["first_epoch"]), ("2", "2", str(OPEN)))
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
        self.assertIn("collect --day 2026-11-24", self.posts[0])

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
