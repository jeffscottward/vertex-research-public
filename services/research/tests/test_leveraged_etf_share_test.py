"""Leveraged-ETF share test (strategies/leveraged_etf/share_test.py, research/backtests/leveraged-etf/share_test.py):
the table, row keys and trial count, baseline and twin rules, the `etf-shares` and `always-long` forms, the
IV-free loader, verdicts with the share-test baseline, the minimum detectable Sharpe and the verdict words.
Tiny synthetic data; no network and no rig data file.

CI: the Nautilus lane (the forms need numpy, as in test_leveraged_etf_study_forms.py)."""
from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

import pytest

if os.environ.get("VERTEX_REQUIRE_NAUTILUS") != "1":
    pytest.importorskip("numpy", reason="the leveraged-ETF forms need numpy (Nautilus lane)")

from strategies.imom import data as idata  # noqa: E402 - after the optional-backend check
from strategies.leveraged_etf import forms, metrics, pairs, prices, runner, share_test as table, signals  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports.data import Market  # noqa: E402

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "share_test.py"
DATES = ("2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01",
         "2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08")
U_CLOSE = (100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 110.0, 99.0, 100.0, 101.0)
LONG_CLOSE = (50.0, 51.0, 52.0, 53.0, 54.0, 55.0, 60.0, 49.0, 50.0, 51.0)
INVERSE_CLOSE = (20.0, 19.6, 19.2, 18.8, 18.4, 18.0, 16.3, 19.6, 19.2, 18.8)
MONDAY = "2024-03-04"
TSLA = table.BY_NAME["TSLA"]


def share_data(pair: pairs.Pair = TSLA.pair) -> forms.PairData:
    market = Market(pair.underlying, DATES, U_CLOSE, (None,) * len(DATES), (None,) * len(DATES))
    return forms.PairData(pair, market, {}, prices.FundBars(pair.long_fund, DATES, LONG_CLOSE),
                          prices.FundBars(pair.inverse_fund, DATES, INVERSE_CLOSE), {})


def signal(side: int, name: str = signals.S1, price: float = 105.0) -> signals.Signal:
    return signals.Signal(name, "TSLA", side, MONDAY, idata.ms_at(MONDAY, 10 * 60 + 30), price)


def load_script():
    spec = importlib.util.spec_from_file_location("leveraged_etf_share_test_script", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Table(unittest.TestCase):
    def test_books_and_rows(self):
        self.assertEqual([book.name for book in table.BOOKS], ["SOXX", "TSLA", "NVDA", "TSLA-TSLZ", "NVDA-NVDQ"])
        self.assertEqual(len(table.row_keys(TSLA)), 8)
        self.assertEqual(len(table.row_keys(table.BY_NAME["TSLA-TSLZ"])), 4)
        self.assertEqual(table.N_TRIALS, 40 + 3 * 8 + 2 * 4)
        self.assertIn("TSLA:session-open-momentum/calm/48h/lev-shares", table.row_keys(TSLA))

    def test_the_seven_pair_study_is_unchanged(self):
        self.assertEqual(runner.N_TRIALS, 40)
        self.assertEqual(len(pairs.PAIRS), 7)
        self.assertNotIn("etf-shares", forms.FORM_KEYS)
        self.assertTrue(all(pair.underlying not in ("SOXX", "TSLA", "NVDA") for pair in pairs.PAIRS))
        self.assertEqual(len(idata.IBKR_INSTRUMENTS), 7)

    def test_baseline_and_twin(self):
        lev = "TSLA-TSLZ:session-open-momentum/all/24h/lev-shares"
        etf = "TSLA:session-open-momentum/all/24h/etf-shares"
        control = "TSLA:session-open-momentum/all/24h/always-long"
        self.assertEqual(table.baseline_key(lev), etf)
        self.assertEqual(table.twin_key(lev), etf)
        self.assertEqual(table.baseline_key(etf), control)
        self.assertIsNone(table.twin_key(etf))
        self.assertIsNone(table.baseline_key(control))
        with self.assertRaises(ValueError):
            table.split_book_key("XYZ:session-open-momentum/all/24h/etf-shares")

    def test_funds_and_leverage(self):
        self.assertEqual(table.fund_symbols(), ("SOXL", "SOXS", "TSLL", "TSDD", "NVDL", "NVD", "TSLZ", "NVDQ"))
        self.assertEqual(table.underlyings(), ("SOXX", "TSLA", "NVDA"))
        self.assertEqual(table.signed_leverage("SOXS"), -3)
        self.assertEqual(table.signed_leverage("NVDL"), 2)
        with self.assertRaises(ValueError):
            table.signed_leverage("TQQQ")

    def test_book_validation(self):
        with self.assertRaises(ValueError):
            table.ShareBook("A:B", TSLA.pair, "2024-01-01", (table.ETF_SHARES,), True)
        with self.assertRaises(ValueError):
            table.ShareBook("A", TSLA.pair, "2024-01-01", ("lev-option",), True)

    def test_ibkr_extra_keys(self):
        self.assertEqual(idata.ibkr_files("TSLA")[0].name, "TSLA.csv.gz")


class ShareForms(unittest.TestCase):
    def test_first_day_needs_no_iv(self):
        self.assertEqual(forms.first_day(share_data()), DATES[0])

    def test_long_etf_shares_hold_u(self):
        trade = forms.price_trade(signal(1), "24h", "etf-shares", share_data())
        self.assertEqual((trade.symbol, trade.form, trade.entry_price, trade.exit_price), ("TSLA", "etf-shares", 105.0, 110.0))

    def test_short_etf_shares_hold_a_minus_one_synthetic(self):
        trade = forms.price_trade(signal(-1), "48h", "etf-shares", share_data())
        self.assertEqual(trade.symbol, "TSLA" + forms.INVERSE_SUFFIX)
        # Closes of the window: the entry day (105), then 110 and 99; each value = previous x (1 - U's return).
        tuesday = 105.0 * (1 - (110.0 / 105.0 - 1))
        wednesday = tuesday * (1 - (99.0 / 110.0 - 1))
        self.assertEqual([worth for _, worth in trade.marks], [105.0, round(tuesday, 2)])
        self.assertAlmostEqual(trade.exit_price, round(wednesday, 2))

    def test_inverse_synthetic_at_zero_is_refused(self):
        data = share_data()
        market = Market("TSLA", DATES, U_CLOSE[:5] + (105.0, 220.0, 99.0, 100.0, 101.0), data.market.iv_index,
                        data.market.rate)
        crashed = forms.PairData(data.pair, market, {}, data.long_fund, data.inverse_fund, {})
        self.assertEqual(forms.price_trade(signal(-1), "24h", "etf-shares", crashed), "inverse synthetic at or below 0")

    def test_dividends_count_for_u_trades(self):
        data = share_data()
        paid = forms.PairData(data.pair, data.market, {}, data.long_fund, data.inverse_fund, {"2024-03-05": 1.0})
        long = forms.price_trade(signal(1), "24h", "etf-shares", paid)
        self.assertEqual(long.exit_price, 111.0)
        short = forms.price_trade(signal(-1), "24h", "etf-shares", paid)
        self.assertAlmostEqual(short.exit_price, round(105.0 * (1 - (111.0 / 105.0 - 1)), 2))
        same_day = forms.PairData(data.pair, data.market, {}, data.long_fund, data.inverse_fund, {MONDAY: 1.0})
        self.assertEqual(forms.price_trade(signal(1), "24h", "etf-shares", same_day).exit_price, 110.0)

    def test_u_split_in_the_window_and_entry_gap_are_refused(self):
        data = share_data()
        split = forms.PairData(data.pair, data.market, {"2024-03-05": 2.0}, data.long_fund, data.inverse_fund, {})
        self.assertEqual(forms.price_trade(signal(1), "24h", "etf-shares", split), "split in the window")
        self.assertEqual(forms.price_trade(signal(1, price=200.0), "24h", "etf-shares", data),
                         "entry price far from the previous close")

    def test_cost_rate_is_read_at_pricing_time(self):
        original = forms.SHARE_COST_RATE
        try:
            forms.SHARE_COST_RATE = 0.005
            trade = forms.price_trade(signal(1), "24h", "etf-shares", share_data())
        finally:
            forms.SHARE_COST_RATE = original
        self.assertAlmostEqual(trade.entry_fee, 0.005 * 105.0)

    def test_always_long_ignores_the_side(self):
        trade = forms.price_trade(signal(-1, table.CONTROL_FORM), "24h", "always-long", share_data())
        self.assertEqual((trade.symbol, trade.form), ("TSLA", "always-long"))

    def test_lev_shares_use_the_share_pair(self):
        trade = forms.price_trade(signal(-1), "24h", "lev-shares", share_data())
        self.assertEqual(trade.symbol, "TSDD")

    def test_share_forms_are_refused_for_a_study_pair(self):
        data = share_data(pairs.BY_UNDERLYING["QQQ"])
        with self.assertRaises(ValueError):
            forms.price_trade(signals.Signal(signals.S1, "QQQ", 1, MONDAY, 0.0, 105.0), "24h", "etf-shares", data)

    def test_load_share_pair_reads_one_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            header = "date,open,high,low,close,adj_close"
            for symbol, closes in (("TSLA", U_CLOSE), ("TSLL", LONG_CLOSE), ("TSDD", INVERSE_CLOSE)):
                rows = [f"{day},{c},{c},{c},{c},{c}" for day, c in zip(DATES, closes)]
                (root / f"{symbol}.csv").write_text("\n".join([header, *rows]) + "\n")
                (root / f"{symbol}.splits.csv").write_text("date,ratio\n")
            data = forms.load_share_pair(TSLA.pair, root)
        self.assertEqual(data.market.dates, DATES)
        self.assertEqual(set(data.market.iv_index), {None})
        self.assertEqual(data.long_fund.symbol, "TSLL")


class Verdicts(unittest.TestCase):
    def stats(self, sharpe):
        return {"sharpe": sharpe, "trades": 40, "oosSharpe": 1.0, "deflatedSharpe": 0.99, "maxDrawdown": -0.05,
                "monteCarlo": {"probabilityOfProfit": 0.9, "drawdownP5": -0.1}}

    def test_share_baselines(self):
        lev = "TSLA:session-open-momentum/all/24h/lev-shares"
        etf = "TSLA:session-open-momentum/all/24h/etf-shares"
        control = "TSLA:session-open-momentum/all/24h/always-long"
        rows = {lev: self.stats(1.5), etf: self.stats(1.0), control: self.stats(1.2)}
        out = metrics.verdicts(rows, al.gate_checks, lambda stats: True, baseline_of=table.baseline_key,
                               twin_of=table.twin_key)
        self.assertTrue(out[lev]["passes"])
        self.assertTrue(out[lev]["leverageHelps"]["helps"])
        self.assertEqual(out[lev]["leverageHelps"]["twin"], "etf-shares")
        self.assertFalse(out[etf]["passes"])
        self.assertIn("1.20 of always-long", out[etf]["gate"]["text"])
        self.assertIsNone(out[control]["leverageHelps"])

    def test_missing_baseline_raises(self):
        with self.assertRaises(ValueError):
            metrics.verdicts({"TSLA:session-open-momentum/all/24h/etf-shares": self.stats(1.0)}, al.gate_checks,
                             lambda stats: True, baseline_of=table.baseline_key, twin_of=table.twin_key)


class Script(unittest.TestCase):
    def test_minimum_detectable_sharpe_falls_with_more_days(self):
        script = load_script()
        short, long = script.minimum_detectable_sharpe(660, 72), script.minimum_detectable_sharpe(4100, 72)
        self.assertGreater(short, long)
        self.assertGreater(long, 0)
        self.assertIsNone(script.minimum_detectable_sharpe(2, 72))

    def test_verdict_words(self):
        script = load_script()

        def verdict(failed, passes=False):
            return {"passes": passes, "gate": {"failed": failed}}

        self.assertEqual(script.verdict_word(verdict([], True), 2.0, 3.0), "pass")
        self.assertEqual(script.verdict_word(verdict(["G5 deflated Sharpe >= 0.95"]), 1.0, 2.4), "underpowered")
        self.assertEqual(script.verdict_word(verdict(["G5 deflated Sharpe >= 0.95"]), -0.2, 2.4), "fail")
        self.assertEqual(script.verdict_word(verdict(["G5 deflated Sharpe >= 0.95"]), 2.5, 2.4), "fail")
        self.assertEqual(script.verdict_word(verdict(["G7 max drawdown <= 25%"]), 1.0, 2.4), "fail")
        self.assertEqual(script.verdict_word(verdict(["G5 deflated Sharpe >= 0.95", "G7 Sharpe above its always-on baseline"]),
                                             1.0, 2.4), "fail")

    def test_stricter_takes_the_lower_deflated_sharpe(self):
        script = load_script()
        measured, null = {"deflatedSharpe": 0.97, "sharpe": 1.0}, {"deflatedSharpe": 0.90, "sharpe": 1.0}
        self.assertEqual(script.stricter(measured, null)["deflatedSharpeRule"], "null variance")
        self.assertEqual(script.stricter(null, measured)["deflatedSharpe"], 0.90)
        self.assertIsNone(script.stricter({"deflatedSharpe": None}, null)["deflatedSharpe"])

    def test_instrument_verdicts(self):
        script = load_script()
        rows = [{"book": "SOXX", "control": False, "word": "fail"}, {"book": "SOXX", "control": False, "word": "pass"},
                {"book": "TSLA", "control": False, "word": "underpowered"}, {"book": "TSLA", "control": True, "word": None},
                {"book": "NVDA", "control": False, "word": "fail"}, {"book": "NVDA-NVDQ", "control": False, "word": "pass"}]
        self.assertEqual(script.instrument_verdicts(rows), {"SOXX": "pass", "TSLA": "underpowered", "NVDA": "fail"})

    def test_coverage_check(self):
        script = load_script()
        script.check_coverage("TSLA", "2024-04-02", "2023-06-01", "2026-11-20", "2026-11-20")
        for first in (None, "2024-03-20"):
            with self.assertRaises(SystemExit):
                script.check_coverage("TSLA", "2024-04-02", first)
        with self.assertRaises(SystemExit):
            script.check_coverage("TSLA", "2024-04-02", "2023-06-01", "2026-11-19", "2026-11-20")
        bars = idata.SessionBars((idata.ms_at(MONDAY, idata.OPEN_MINUTE),), (1.0,), (1.0,), (1.0,), (1.0,), (1.0,),
                                 spread_bps=0.0)
        self.assertEqual(script.bars_day(bars, 0), MONDAY)
        self.assertIsNone(script.bars_day(idata.SessionBars((), (), (), (), (), (), spread_bps=0.0), -1))

    def test_pick_books(self):
        script = load_script()
        self.assertEqual(len(script.pick_books(None)), 5)
        self.assertEqual([book.name for book in script.pick_books("NVDA-NVDQ")], ["NVDA", "NVDA-NVDQ"])
        for text in ("XYZ", " , "):
            with self.assertRaises(SystemExit):
                script.pick_books(text)

    def test_tracking_uses_the_share_leverage(self):
        script = load_script()
        found = script.tracking(share_data(), DATES[0])
        self.assertEqual({row["underlying"] for row in found}, {"TSLA"})
        self.assertEqual(script.tracking(share_data(), "2030-01-01"), [])
        seen: set[str] = set()
        first, again = script.tracking(share_data(), DATES[0], seen), script.tracking(share_data(), DATES[0], seen)
        self.assertEqual((len(first), again), (2, []))

    def test_prior_daily_sharpes(self):
        script = load_script()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "results.json"
            path.write_text('{"complete": true, "rows": [' + ",".join(['{"stats": {"sharpe": 1.0}}'] * 40) + "]}")
            sharpes, digest = script.prior_daily_sharpes(path)
            self.assertEqual(len(sharpes), 40)
            self.assertAlmostEqual(sharpes[0], 1 / al.TRADING_DAYS ** 0.5)
            self.assertTrue(digest.startswith("sha256:"))
            path.write_text('{"complete": false, "rows": []}')
            with self.assertRaises(SystemExit):
                script.prior_daily_sharpes(path)

    def test_control_signals_start_at_the_book_start(self):
        script = load_script()
        from strategies.qc_ports.data import Bars

        bars = Bars("TSLA", DATES, U_CLOSE, U_CLOSE, U_CLOSE, U_CLOSE, U_CLOSE)
        found = script.control_signals(share_data(), MONDAY, bars)
        self.assertEqual([item.day for item in found], list(DATES[5:]))
        self.assertTrue(all(item.side == 1 and item.signal == table.CONTROL_FORM for item in found))
        self.assertEqual(found[0].price, 105.0)


class Signals(unittest.TestCase):
    def test_without_s2_no_index_is_read(self):
        data = share_data()
        days = DATES
        bars = idata.SessionBars(*(tuple() for _ in range(6)), spread_bps=0.0)
        original = idata.load_bars
        idata.load_bars = lambda *args, **kwargs: bars
        try:
            found = runner.load_pair_signals(TSLA.pair, data, {}, {}, with_s2=False)
        finally:
            idata.load_bars = original
        self.assertEqual(found.signals[signals.S2], {"all": (), "calm": ()})
        self.assertEqual(found.dropped, 0)
        self.assertEqual(found.last_day, days[-1])


if __name__ == "__main__":
    unittest.main()


class MainSmoke(unittest.TestCase):
    """End to end of the entry point on synthetic files, ledger only, with the intraday loaders stubbed."""

    def run_main(self, *extra: str) -> dict:
        import json
        import types

        script = load_script()
        days = [f"2024-0{m}-{d:02d}" for m in (4, 5) for d in range(1, 29)]
        days = [day for day in days if not idata.is_closed(__import__("datetime").date.fromisoformat(day))]
        folder = Path(tempfile.mkdtemp())
        header = "date,open,high,low,close,adj_close"
        for symbol, base in (("TSLA", 100.0), ("TSLL", 50.0), ("TSDD", 20.0)):
            rows = [f"{day},{base + i % 3},{base + 3},{base - 3},{base + (i % 5) - 2},{base + (i % 5) - 2}"
                    for i, day in enumerate(days)]
            (folder / f"{symbol}.csv").write_text("\n".join([header, *rows]) + "\n")
            (folder / f"{symbol}.splits.csv").write_text("date,ratio\n")
        prior = folder / "prior.json"
        prior.write_text(json.dumps({"complete": True, "rows": [{"stats": {"sharpe": 0.1 * i}} for i in range(40)]}))
        picked = [day for day in days if day >= "2024-04-02"][::2]
        found = {regime: tuple(signals.Signal(signals.S1, "TSLA", 1 if i % 2 else -1, day,
                                              idata.ms_at(day, 10 * 60 + 30), 100.0 + (i % 5) - 2)
                               for i, day in enumerate(picked)) for regime in signals.REGIMES}
        stub = runner.PairSignals("TSLA", days[0], days[-1], {signals.S1: days[0], signals.S2: days[0]},
                                  {signals.S1: found, signals.S2: {r: () for r in signals.REGIMES}}, 0)
        early = idata.ms_at("2024-02-01", idata.OPEN_MINUTE)
        bars = idata.SessionBars((early, idata.ms_at(days[-1], idata.OPEN_MINUTE)), (1.0,) * 2, (1.0,) * 2, (1.0,) * 2,
                                 (1.0,) * 2, (1.0,) * 2, spread_bps=0.0)
        script.runner = types.SimpleNamespace(**{**vars(runner), "load_pair_signals": lambda *a, **k: stub})
        script.idata = types.SimpleNamespace(**{**vars(idata), "load_bars": lambda *a, **k: bars,
                                                "ibkr_files": lambda name: (prior, prior)})
        script.qd = types.SimpleNamespace(**{**vars(script.qd), "load_series": lambda *a, **k: {}})
        script.golive = types.SimpleNamespace(funded_pie=lambda: types.SimpleNamespace(lower_bar=lambda stats: False))
        out = folder / "results.json"
        script.main(["--data", str(folder), "--out", str(out), "--books", "TSLA", "--no-nautilus",
                     "--prior-results", str(prior), *extra])
        return json.loads(out.read_text())

    def test_main_books_rows_and_flags(self):
        document = self.run_main()
        self.assertFalse(document["complete"])
        self.assertTrue(any("ledger only" in reason for reason in document["partial"]))
        self.assertEqual([book["book"] for book in document["books"]], ["TSLA"])
        self.assertEqual(document["books"][0]["start"], "2024-04-02")
        keys = {row["key"] for row in document["rows"]}
        self.assertEqual(len(keys), 12)
        lev = next(row for row in document["rows"] if row["key"] == "TSLA:session-open-momentum/all/24h/lev-shares")
        self.assertEqual(lev["verdict"]["leverageHelps"]["twin"], "etf-shares")
        self.assertIn(document["instrumentVerdicts"]["TSLA"], ("pass", "underpowered", "fail"))
        self.assertTrue((Path(document["provenance"]["data"]) / "results.md").exists())

    def test_main_capital_marks_partial(self):
        document = self.run_main("--capital", "50000")
        self.assertIn("capital 50000.0", document["partial"])


class FetchDataGuard(unittest.TestCase):
    def test_share_test_refuses_the_seven_pair_folder(self):
        import subprocess
        import sys

        folder = Path(tempfile.mkdtemp())
        (folder / "TQQQ.csv").write_text("date\n")
        script = SCRIPT.parent / "fetch_data.py"
        done = subprocess.run([sys.executable, str(script), "--share-test", "--out", str(folder)], capture_output=True,
                              text=True, check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("7-pair data folder", done.stderr + done.stdout)
