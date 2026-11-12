"""Leveraged-ETF short-window study: the pure parts that need no numpy (pair table, as-traded prices,
synthetic intraday fund price, tracking error). No network and no rig data file: every file is
written to a temporary folder."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from strategies.leveraged_etf import metrics, pairs, prices
from strategies.qc_ports import allocation as al
from strategies.qc_ports.data import IV_INDEX
from strategies.qc_ports.ledger import LedgerResult


class PairTable(unittest.TestCase):
    def test_table_is_the_pre_registered_one(self):
        rows = [(p.underlying, p.long_fund, p.inverse_fund, p.leverage, p.iv_index) for p in pairs.PAIRS]
        self.assertEqual(rows, [
            ("QQQ", "TQQQ", "SQQQ", 3, "VXN"), ("SPY", "UPRO", "SPXU", 3, "VIX"), ("IWM", "TNA", "TZA", 3, "RVX"),
            ("DIA", "UDOW", "SDOW", 3, "VXD"), ("GLD", "UGL", "GLL", 2, "GVZ"), ("SLV", "AGQ", "ZSL", 2, "VXSLV"),
            ("USO", "UCO", "SCO", 2, "OVX")])

    def test_iv_index_is_the_index_the_option_model_reads(self):
        for pair in pairs.PAIRS:
            self.assertEqual(IV_INDEX[pair.underlying], pair.iv_index)

    def test_every_symbol_appears_once(self):
        symbols = [*pairs.underlyings(), *pairs.fund_symbols()]
        self.assertEqual(len(symbols), 21)
        self.assertEqual(len(set(symbols)), 21)

    def test_signed_leverage_is_positive_for_the_long_fund_and_negative_for_the_inverse_fund(self):
        self.assertEqual(pairs.signed_leverage("TQQQ"), 3)
        self.assertEqual(pairs.signed_leverage("SQQQ"), -3)
        self.assertEqual(pairs.signed_leverage("UGL"), 2)
        self.assertEqual(pairs.signed_leverage("SCO"), -2)

    def test_pair_of_fund_refuses_a_symbol_outside_the_table(self):
        self.assertEqual(pairs.pair_of_fund("TZA").underlying, "IWM")
        with self.assertRaises(ValueError):
            pairs.pair_of_fund("QQQ")

    def test_a_pair_refuses_a_multiple_below_two_and_repeated_symbols(self):
        with self.assertRaises(ValueError):
            pairs.Pair("QQQ", "TQQQ", "SQQQ", 1, "VXN")
        with self.assertRaises(ValueError):
            pairs.Pair("QQQ", "TQQQ", "TQQQ", 3, "VXN")


class AsTradedPrices(unittest.TestCase):
    DATES = ("2021-01-19", "2021-01-20", "2021-01-21", "2021-01-22")

    def test_a_later_forward_split_is_undone(self):
        # 2-for-1 effective 2021-01-21: the two closes before it traded at twice the adjusted close.
        traded = prices.as_traded(self.DATES, (90.0, 92.5, 94.0, 95.0), {"2021-01-21": 2.0})
        self.assertEqual(traded, [180.0, 185.0, 94.0, 95.0])

    def test_a_later_reverse_split_is_undone(self):
        traded = prices.as_traded(self.DATES, (100.0, 98.0, 99.0, 97.0), {"2021-01-22": 0.25})
        self.assertEqual(traded, [25.0, 24.5, 24.75, 97.0])

    def test_splits_multiply(self):
        traded = prices.as_traded(self.DATES, (1.0, 2.0, 3.0, 4.0), {"2021-01-20": 2.0, "2021-01-22": 3.0})
        self.assertEqual(traded, [6.0, 6.0, 9.0, 4.0])

    def test_no_split_leaves_the_close(self):
        self.assertEqual(prices.as_traded(self.DATES, (1.5, 2.5, 3.5, 4.5), {}), [1.5, 2.5, 3.5, 4.5])

    def test_columns_of_different_length_are_refused(self):
        with self.assertRaises(ValueError):
            prices.as_traded(self.DATES, (1.0,), {})

    def test_load_fund_reads_the_fetch_files_at_as_traded_prices(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "TQQQ.csv").write_text(
                "date,open,high,low,close,adj_close\n"
                "2021-01-19,90,91,89,90.000000,89\n2021-01-20,92,93,91,92.500000,91\n"
                "2021-01-21,94,95,93,94.000000,93\n")
            (root / "TQQQ.splits.csv").write_text("date,ratio\n2021-01-21,2.0\n")
            fund = prices.load_fund("TQQQ", root)
        self.assertEqual(fund.dates, ("2021-01-19", "2021-01-20", "2021-01-21"))
        self.assertEqual(fund.close, (180.0, 185.0, 94.0))
        self.assertEqual(fund.splits, (("2021-01-21", 2.0),))
        self.assertEqual(fund.close_on("2021-01-20"), 185.0)
        self.assertIsNone(fund.close_on("2021-01-18"))
        self.assertIsNone(fund.close_on("2021-01-23"))

    def test_fund_bars_refuse_bad_columns(self):
        with self.assertRaises(ValueError):
            prices.FundBars("X", ("2021-01-19",), (1.0, 2.0))
        with self.assertRaises(ValueError):
            prices.FundBars("X", ("2021-01-20", "2021-01-19"), (1.0, 2.0))
        with self.assertRaises(ValueError):
            prices.FundBars("X", ("2021-01-19",), (0.0,))

    def test_split_between_is_open_at_the_start_and_closed_at_the_end(self):
        splits = (("2021-01-21", 2.0),)
        self.assertTrue(prices.split_between(splits, "2021-01-20", "2021-01-21"))
        self.assertTrue(prices.split_between(splits, "2021-01-19", "2021-01-25"))
        self.assertFalse(prices.split_between(splits, "2021-01-21", "2021-01-25"))
        self.assertFalse(prices.split_between(splits, "2021-01-15", "2021-01-20"))
        self.assertTrue(prices.split_between({"2021-01-21": 2.0}, "2021-01-20", "2021-01-22"))


class SyntheticIntradayPrice(unittest.TestCase):
    def test_long_fund_moves_leverage_times_the_move_of_the_underlying(self):
        # U +1% since its previous close, 3x fund from 50: 50 * 1.03.
        self.assertAlmostEqual(prices.synthetic_price(50.0, 3, 404.0, 400.0), 51.5, places=12)

    def test_inverse_fund_moves_against_the_underlying(self):
        self.assertAlmostEqual(prices.synthetic_price(20.0, -3, 404.0, 400.0), 19.4, places=12)

    def test_no_move_gives_the_previous_close(self):
        self.assertEqual(prices.synthetic_price(33.3, 2, 100.0, 100.0), 33.3)

    def test_a_move_that_wipes_the_fund_out_has_no_price(self):
        self.assertIsNone(prices.synthetic_price(10.0, 3, 60.0, 100.0))
        self.assertIsNone(prices.synthetic_price(10.0, -3, 140.0, 100.0))

    def test_bad_inputs_are_refused(self):
        with self.assertRaises(ValueError):
            prices.synthetic_price(0.0, 3, 100.0, 100.0)
        with self.assertRaises(ValueError):
            prices.synthetic_price(10.0, 3, float("nan"), 100.0)


class TrackingError(unittest.TestCase):
    def test_a_fund_that_follows_the_formula_has_no_error(self):
        u_dates = ("2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05")
        u_closes = (100.0, 101.0, 99.99, 102.0)
        closes = [50.0]
        for before, after in zip(u_closes, u_closes[1:]):
            closes.append(closes[-1] * (1 + 3 * (after / before - 1)))
        fund = prices.FundBars("F", u_dates, tuple(closes))
        out = prices.tracking_error(fund, 3, u_dates, u_closes)
        self.assertEqual(out["days"], 3)
        self.assertAlmostEqual(out["medianAbsErrorPct"], 0.0, places=9)
        self.assertAlmostEqual(out["p95AbsErrorPct"], 0.0, places=9)
        self.assertEqual((out["from"], out["to"]), ("2024-01-03", "2024-01-05"))

    def test_the_error_is_the_gap_between_synthetic_and_real_close_in_percent(self):
        u_dates = ("2024-01-02", "2024-01-03", "2024-01-04")
        # U +1% then flat. Synthetic closes: 103 (real 102) and 102 (real 100).
        fund = prices.FundBars("F", u_dates, (100.0, 102.0, 100.0))
        out = prices.tracking_error(fund, 3, u_dates, (200.0, 202.0, 202.0))
        self.assertEqual(out["days"], 2)
        self.assertAlmostEqual(out["medianAbsErrorPct"], (103 / 102 - 1 + 0.02) / 2 * 100, places=9)
        self.assertAlmostEqual(out["maxAbsErrorPct"], 2.0, places=9)

    def test_split_days_and_days_without_the_underlying_are_left_out(self):
        u_dates = ("2024-01-02", "2024-01-03", "2024-01-05")
        fund = prices.FundBars("F", ("2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"),
                               (100.0, 50.0, 50.0, 50.0), (("2024-01-03", 2.0),))
        out = prices.tracking_error(fund, 2, u_dates, (10.0, 10.0, 10.0))
        self.assertIsNone(out)

    def test_percentile_interpolates(self):
        self.assertEqual(prices.percentile([1.0, 2.0, 3.0, 4.0], 0.5), 2.5)
        self.assertEqual(prices.percentile([1.0], 0.95), 1.0)
        with self.assertRaises(ValueError):
            prices.percentile([], 0.5)


class Worst48hLoss(unittest.TestCase):
    DATES = ("2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07", "2024-03-08")

    def test_it_is_the_most_negative_change_over_two_consecutive_sessions(self):
        out = metrics.worst_48h_loss(self.DATES, (100.0, 95.0, 96.0, 90.0, 99.0), 100.0)
        # Two-session changes: -5% (100 -> 95), -4% (100 -> 96), -5.26% (95 -> 90), +3.1% (96 -> 99).
        self.assertAlmostEqual(out["pct"], (90.0 / 95.0 - 1) * 100, places=12)
        self.assertEqual((out["from"], out["to"]), ("2024-03-06", "2024-03-07"))

    def test_the_base_is_the_equity_at_the_start_of_the_two_sessions(self):
        # 200 -> 150 -> 150: -25% of 200, not of the capital and not of a later value.
        out = metrics.worst_48h_loss(self.DATES[:4], (200.0, 200.0, 150.0, 150.0), 100.0)
        self.assertAlmostEqual(out["pct"], -25.0, places=12)
        self.assertEqual((out["from"], out["to"]), ("2024-03-05", "2024-03-06"))

    def test_the_first_window_starts_at_the_capital(self):
        out = metrics.worst_48h_loss(self.DATES[:3], (99.0, 97.0, 98.0), 100.0)
        self.assertAlmostEqual(out["pct"], -3.0, places=12)
        self.assertEqual((out["from"], out["to"]), ("2024-03-04", "2024-03-05"))

    def test_a_loss_spread_over_two_sessions_is_larger_than_each_day(self):
        out = metrics.worst_48h_loss(self.DATES[:3], (100.0, 98.0, 96.04), 100.0)
        self.assertAlmostEqual(out["pct"], -3.96, places=9)

    def test_no_negative_change_gives_zero(self):
        out = metrics.worst_48h_loss(self.DATES[:3], (100.0, 101.0, 101.0), 100.0)
        self.assertEqual(out, {"pct": 0.0, "from": None, "to": None})

    def test_fewer_than_two_sessions_have_no_value(self):
        self.assertIsNone(metrics.worst_48h_loss(self.DATES[:1], (99.0,), 100.0))
        self.assertIsNone(metrics.worst_48h_loss((), (), 100.0))

    def test_bad_inputs_are_refused(self):
        with self.assertRaises(ValueError):
            metrics.worst_48h_loss(self.DATES[:2], (100.0,), 100.0)
        with self.assertRaises(ValueError):
            metrics.worst_48h_loss(self.DATES[:2], (100.0, 0.0), 100.0)
        with self.assertRaises(ValueError):
            metrics.worst_48h_loss(self.DATES[:2], (100.0, 99.0), 0.0)
        with self.assertRaises(ValueError):
            metrics.worst_48h_loss(self.DATES[:2], (100.0, float("nan")), 100.0)


def ledger_result(equity, trades=(), skipped=(), capital=100_000.0) -> LedgerResult:
    days = [f"2024-{1 + index // 28:02d}-{1 + index % 28:02d}" for index in range(len(equity))]
    held = tuple(1 if index % 2 else 0 for index in range(len(equity)))
    return LedgerResult(tuple(days), tuple(equity), held, tuple(trades), tuple(skipped), capital=capital)


class RowStats(unittest.TestCase):
    def test_statistics_of_a_small_run(self):
        equity = [100_000.0, 100_400.0, 100_400.0, 100_100.0, 100_700.0, 100_700.0, 100_600.0, 101_000.0, 101_000.0,
                  101_300.0]
        trades = [{"pnl": 400.0, "entryDate": "2024-01-02"}, {"pnl": -300.0, "entryDate": "2024-01-04"},
                  {"pnl": 600.0, "entryDate": "2024-01-05"}, {"pnl": -100.0, "entryDate": "2024-01-07"},
                  {"pnl": 400.0, "entryDate": "2024-01-08"}, {"pnl": 300.0, "entryDate": "2024-01-10"}]
        result = ledger_result(equity, trades, [{"id": 9, "reason": "size"}])
        stats = metrics.row_stats(result, [0.004, -0.003, 0.006, -0.001, 0.004, 0.003], 40, 0.0004)
        self.assertEqual((stats["trades"], stats["refused"], stats["days"]), (6, 1, 10))
        self.assertEqual((stats["firstTrade"], stats["lastTrade"]), ("2024-01-02", "2024-01-10"))
        self.assertAlmostEqual(stats["winRate"], 4 / 6, places=12)
        self.assertAlmostEqual(stats["meanTradePct"], 1.3 / 6, places=12)
        self.assertAlmostEqual(stats["medianTradePct"], 0.35, places=12)
        self.assertAlmostEqual(stats["worstTradePct"], -0.3, places=12)
        self.assertAlmostEqual(stats["profitFactor"], 1700.0 / 400.0, places=12)
        self.assertAlmostEqual(stats["maxDrawdown"], 100_100.0 / 100_400.0 - 1, places=12)
        self.assertAlmostEqual(stats["worst48hLoss"]["pct"], (100_100.0 / 100_400.0 - 1) * 100, places=9)
        self.assertEqual(stats["nTrials"], 40)
        self.assertEqual(stats["sharpe"], al.sharpe(al.daily_returns(equity)))
        self.assertEqual((stats["oosStart"], stats["oosSharpe"]), al.out_of_sample_sharpe(result))
        self.assertEqual(stats["monteCarlo"], al.monte_carlo([t["pnl"] for t in trades], 100_000.0))
        self.assertIsNotNone(stats["deflatedSharpe"])
        self.assertGreater(stats["oosCagr"], 0)
        self.assertEqual(stats["exposure"], 0.5)

    def test_a_run_without_a_trade_has_no_sharpe_and_no_trade_numbers(self):
        stats = metrics.row_stats(ledger_result([100_000.0] * 6), [], 40, 0.0004)
        for name in ("sharpe", "oosSharpe", "deflatedSharpe", "winRate", "meanTradePct", "medianTradePct",
                     "worstTradePct", "profitFactor", "monteCarlo", "firstTrade"):
            self.assertIsNone(stats[name], name)
        self.assertEqual((stats["trades"], stats["maxDrawdown"], stats["worst48hLoss"]["pct"]), (0, 0.0, 0.0))

    def test_daily_sharpe_and_trial_variance(self):
        result = ledger_result([100.0, 101.0, 100.5, 102.0], capital=100.0)
        returns = al.daily_returns(result.equity)
        self.assertAlmostEqual(metrics.daily_sharpe(result), al.sharpe(returns) / 252 ** 0.5, places=15)
        self.assertEqual(metrics.daily_sharpe(ledger_result([100.0, 100.0, 100.0], capital=100.0)), 0.0)
        self.assertAlmostEqual(metrics.trial_variance([0.01, 0.03]), 0.0002, places=15)
        self.assertIsNone(metrics.trial_variance([0.01]))

    def test_monthly_points_are_month_end_returns_with_the_drawdown(self):
        result = LedgerResult(("2024-01-30", "2024-01-31", "2024-02-28", "2024-02-29", "2024-03-01"),
                              (105.0, 110.0, 120.0, 99.0, 132.0), (0,) * 5, (), (), capital=100.0)
        points = metrics.monthly_points(result)
        self.assertEqual([point["month"] for point in points], ["2024-01", "2024-02", "2024-03"])
        self.assertAlmostEqual(points[0]["value"], 0.10, places=12)
        self.assertAlmostEqual(points[1]["value"], -0.01, places=12)
        self.assertAlmostEqual(points[1]["drawdown"], 99.0 / 110.0 - 1, places=12)
        self.assertEqual(points[2]["drawdown"], 0.0)


GOOD = {"trades": 200, "sharpe": 1.2, "oosSharpe": 0.9, "deflatedSharpe": 0.97, "maxDrawdown": -0.10,
        "monteCarlo": {"probabilityOfProfit": 0.95, "drawdownP5": -0.20}}


def lower_bar(stats) -> bool:
    return stats["sharpe"] >= 0.3 and stats["trades"] >= 30


class Verdicts(unittest.TestCase):
    def rows(self, **changes) -> dict:
        base = {form: dict(GOOD) for form in ("etf-option", "etf-vertical", "lev-option", "lev-vertical", "lev-shares")}
        base["etf-option"]["sharpe"] = 0.8
        base["etf-vertical"]["sharpe"] = 1.0
        base["lev-vertical"]["sharpe"] = 0.9
        base["lev-shares"]["sharpe"] = 0.7
        for form, change in changes.items():
            base[form.replace("_", "-")].update(change)
        return {metrics.row_key("s1", "all", "24h", form): stats for form, stats in base.items()}

    def verdict(self, form: str, **changes) -> dict:
        return metrics.verdicts(self.rows(**changes), al.gate_checks, lower_bar)[metrics.row_key("s1", "all", "24h", form)]

    def test_row_key_round_trip(self):
        key = metrics.row_key("session-open-momentum", "calm", "48h", "lev-vertical")
        self.assertEqual(key, "session-open-momentum/calm/48h/lev-vertical")
        self.assertEqual(metrics.split_key(key), ("session-open-momentum", "calm", "48h", "lev-vertical"))
        with self.assertRaises(ValueError):
            metrics.split_key("a/b/c")

    def test_the_baseline_of_the_etf_option_row_is_zero(self):
        verdict = self.verdict("etf-option")
        self.assertEqual(verdict["gate"]["baselineSharpe"], 0.0)
        self.assertTrue(verdict["gate"]["pass"])
        self.assertTrue(verdict["passes"])
        self.assertIsNone(verdict["leverageHelps"])
        self.assertEqual(len(verdict["gate"]["checks"]), 8)

    def test_the_baseline_of_every_other_row_is_the_etf_option_row(self):
        for form in ("etf-vertical", "lev-option", "lev-vertical", "lev-shares"):
            self.assertEqual(self.verdict(form)["gate"]["baselineSharpe"], 0.8, form)
        # lev-shares has Sharpe 0.7: every other check holds, the baseline check fails.
        verdict = self.verdict("lev-shares")
        self.assertEqual(verdict["gate"]["failed"], ["G7 Sharpe above its always-on baseline"])
        self.assertFalse(verdict["passes"])
        self.assertIn("baseline Sharpe 0.80 of etf-option", verdict["gate"]["text"])

    def test_a_row_passes_only_when_every_gate_check_passes(self):
        self.assertTrue(self.verdict("lev-option")["passes"])
        almost = self.verdict("lev-option", lev_option={"deflatedSharpe": 0.9499})
        self.assertFalse(almost["passes"])
        self.assertEqual(almost["gate"]["failed"], ["G5 deflated Sharpe >= 0.95"])
        # The lower bar does not make a row pass.
        self.assertTrue(almost["lowerBar"]["pass"])

    def test_leverage_helps_compares_with_the_unleveraged_twin(self):
        self.assertEqual(self.verdict("lev-option")["leverageHelps"]["twin"], "etf-option")
        self.assertTrue(self.verdict("lev-option")["leverageHelps"]["helps"])  # 1.2 against 0.8
        vertical = self.verdict("lev-vertical")["leverageHelps"]  # 0.9 against 1.0 of etf-vertical
        self.assertEqual((vertical["helps"], vertical["twin"], vertical["sharpe"], vertical["twinSharpe"]),
                         (False, "etf-vertical", 0.9, 1.0))
        self.assertEqual(vertical["text"], "no: Sharpe 0.90 against 1.00 of etf-vertical")
        shares = self.verdict("lev-shares")["leverageHelps"]  # 0.7 against 0.8 of etf-option
        self.assertEqual((shares["helps"], shares["twin"]), (False, "etf-option"))
        self.assertFalse(self.verdict("lev-option", lev_option={"sharpe": 0.8})["leverageHelps"]["helps"])  # equal

    def test_a_row_without_a_sharpe_fails_and_does_not_help(self):
        verdict = self.verdict("lev-option", lev_option={"sharpe": None, "oosSharpe": None, "deflatedSharpe": None,
                                                         "trades": 0, "monteCarlo": None})
        self.assertFalse(verdict["passes"])
        self.assertFalse(verdict["lowerBar"]["pass"])
        self.assertFalse(verdict["leverageHelps"]["helps"])
        self.assertEqual(verdict["leverageHelps"]["text"], "no: Sharpe none against 0.80 of etf-option")
        # A twin without a Sharpe counts as 0.
        twin_missing = self.verdict("lev-vertical", etf_vertical={"sharpe": None})
        self.assertTrue(twin_missing["leverageHelps"]["helps"])

    def test_the_lower_bar_is_the_function_passed_in(self):
        self.assertTrue(self.verdict("etf-option")["lowerBar"]["pass"])
        low = self.verdict("etf-option", etf_option={"sharpe": 0.2})
        self.assertFalse(low["lowerBar"]["pass"])
        self.assertEqual(low["lowerBar"]["text"], "fail: the owner's lower bar does not hold")

    def test_a_missing_baseline_or_twin_row_is_an_error(self):
        rows = self.rows()
        del rows[metrics.row_key("s1", "all", "24h", "etf-option")]
        with self.assertRaises(ValueError):
            metrics.verdicts(rows, al.gate_checks, lower_bar)
        rows = self.rows()
        del rows[metrics.row_key("s1", "all", "24h", "etf-vertical")]
        with self.assertRaises(ValueError):
            metrics.verdicts(rows, al.gate_checks, lower_bar)


if __name__ == "__main__":
    unittest.main()
