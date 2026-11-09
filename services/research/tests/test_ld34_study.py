"""Unit tests of the LD34 reel study helpers (no market data, no Nautilus)."""
from __future__ import annotations

import math
import unittest
from datetime import UTC, datetime

from strategies.ld34 import data, definition, metrics, rules


def ms(text: str) -> float:
    return datetime.fromisoformat(text).replace(tzinfo=UTC).timestamp() * 1000


class DataTest(unittest.TestCase):
    def test_merge_sides_mid_and_spread(self) -> None:
        bid = {1: (99.0, 101.0, 98.0, 100.0, 5.0), 2: (100.0, 102.0, 99.0, 101.0, 1.0), 3: (1.0, 1.0, 1.0, 1.0, 0.0)}
        ask = {1: (99.2, 101.2, 98.2, 100.2, 4.0), 2: (100.2, 102.2, 99.2, 101.2, 2.0)}
        out = data.merge_sides(bid, ask)
        self.assertEqual(out.t, (1.0, 2.0))
        self.assertAlmostEqual(out.c[0], 100.1)
        self.assertAlmostEqual(out.h[1], 102.1)
        self.assertEqual(out.v, (9.0, 3.0))
        self.assertAlmostEqual(out.spread_bps, statistics_median([0.2 / 100.1 * 1e4, 0.2 / 101.1 * 1e4]))
        self.assertEqual(len(out), 2)
        self.assertEqual(set(out.columns()), {"t", "o", "h", "l", "c", "v"})

    def test_merge_sides_needs_two_bars(self) -> None:
        with self.assertRaises(ValueError):
            data.merge_sides({1: (1.0, 1.0, 1.0, 1.0, 0.0)}, {1: (1.0, 1.0, 1.0, 1.0, 0.0)})

    def test_instrument_table(self) -> None:
        self.assertEqual(len(data.INSTRUMENTS), 20)
        for key in data.CORE7:
            self.assertIsNotNone(data.BY_KEY[key].twin)
        self.assertEqual({data.BY_KEY[k].group for k in data.ETF_TWINS}, {"etf-twin"})


def statistics_median(values: list[float]) -> float:
    values = sorted(values)
    mid = len(values) // 2
    return values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2


class DefinitionTest(unittest.TestCase):
    def test_stated_rules(self) -> None:
        d = definition.definition()
        self.assertEqual(len(d["entry"]["any"]), 8)
        self.assertTrue(all(c["op"] == "breaksAbove" and c["oncePerLevel"] for c in d["entry"]["any"]))
        self.assertEqual({c["right"]["timeframe"] for c in d["entry"]["any"]}, {"1d"})
        self.assertEqual(d["stopLoss"], {"kind": "atr", "length": 14, "multiple": 2.0})
        self.assertEqual(d["management"], {"trail": {"activateR": 1.0, "length": 14, "multiple": 2.0}, "breakevenR": 2.0})
        self.assertEqual(d["sizing"]["riskPct"], 1.0)

    def test_variants(self) -> None:
        no_be = definition.definition(definition.Params(breakeven_r=None, once_per_level=False))
        self.assertNotIn("breakevenR", no_be["management"])
        self.assertNotIn("oncePerLevel", no_be["entry"]["any"][0])
        self.assertEqual(definition.with_leverage(definition.BASE, 2).max_leverage, 2)
        self.assertEqual(len(definition.SENSITIVITY), 18)
        self.assertEqual(len(definition.WALK_FORWARD_GRID), 9)
        self.assertIn(definition.BASE, definition.WALK_FORWARD_GRID)
        self.assertIn("stop_multiple=2.0", definition.BASE.label())


class MetricsTest(unittest.TestCase):
    def test_session_day_starts_17_new_york(self) -> None:
        self.assertEqual(metrics.session_day(ms("2026-01-05T21:59:00")), "2026-01-05")  # 16:59 EST
        self.assertEqual(metrics.session_day(ms("2026-01-05T22:00:00")), "2026-01-06")  # 17:00 EST
        self.assertEqual(metrics.session_day(ms("2026-07-06T14:30:00")), "2026-07-06")  # RTH

    def test_daily_points_and_stats(self) -> None:
        times = [ms(f"2024-01-{d:02d}T15:00:00") for d in range(1, 31)]
        values = [1.0 + 0.01 * i + (0.003 if i % 2 else 0) for i in range(30)]
        points = metrics.daily_points(times + [times[-1] + 1000], values + [values[-1]])
        self.assertEqual(len(points), 30)
        s = metrics.stats(points)
        self.assertGreater(s["cagr"], 0)
        self.assertGreater(s["sharpe"], 0)
        self.assertLessEqual(s["maxDrawdown"], 0)
        self.assertEqual(metrics.stats(points[:2])["sharpe"], 0.0)
        flat = metrics.stats([("2024-01-01", 1.0), ("2024-01-02", 1.0), ("2024-01-03", 1.0)])
        self.assertEqual(flat["sharpe"], 0.0)
        head, tail = metrics.split(points, 0.6)
        self.assertEqual(head[-1], tail[0])
        self.assertEqual(len(head) + len(tail) - 1, len(points))

    def test_drawdowns(self) -> None:
        self.assertAlmostEqual(metrics.max_drawdown([1, 2, 1, 3]), -0.5)
        self.assertEqual(metrics.drawdowns([1, 2, 1]), [0.0, 0.0, -0.5])

    def test_trade_stats(self) -> None:
        s = metrics.trade_stats([{"pnl": 2.0}, {"pnl": -1.0}, {"pnl": 1.0}])
        self.assertEqual(s["trades"], 3)
        self.assertAlmostEqual(s["profitFactor"], 3.0)
        self.assertIsNone(metrics.trade_stats([{"pnl": 1.0}])["profitFactor"])
        self.assertEqual(metrics.trade_stats([])["winRate"], 0.0)

    def test_financing_charges_borrowed_part_only(self) -> None:
        times = [ms("2024-01-02T15:00:00") + i * 86_400_000 for i in range(12)]
        equity = [1.0] * 12
        trades = [{"entryIndex": 1, "exitIndex": 11, "units": 0.03, "entryPrice": 100.0},  # notional 3 -> borrowed 2
                  {"entryIndex": 0, "exitIndex": 2, "units": 0.005, "entryPrice": 100.0}]  # not leveraged
        charges = metrics.financing_factors(trades, times, equity, {"2023-12-29": 5.0})
        self.assertEqual(len(charges), 1)
        (day, fee), = charges.items()
        self.assertAlmostEqual(fee, 2 * 0.065 * 10 / 365)
        adjusted = metrics.apply_charges([(day, 1.0)], charges)
        self.assertAlmostEqual(adjusted[0][1], 1 - fee)
        self.assertEqual(metrics.financing_factors(trades, times, equity, {}), {day: 2 * 0.015 * 10 / 365})

    def test_combine_equal_capital(self) -> None:
        a = [("2024-01-01", 1.0), ("2024-01-02", 1.1), ("2024-01-03", 1.1)]
        b = [("2024-01-02", 2.0), ("2024-01-03", 1.8)]
        out = metrics.combine([a, b])
        self.assertEqual([d for d, _ in out], ["2024-01-02", "2024-01-03"])
        self.assertAlmostEqual(out[-1][1], 1 + (0 + -0.1) / 2)

    def test_walk_forward_picks_best_training_sharpe(self) -> None:
        good, bad = [], []
        v_good = v_bad = 1.0
        start = datetime(2015, 1, 1, tzinfo=UTC)
        for i in range(365 * 6):
            day = datetime.fromtimestamp(start.timestamp() + i * 86400, UTC).date().isoformat()
            v_good *= 1.0005 + (0.001 if i % 2 else -0.001)
            v_bad *= 0.9998 + (0.001 if i % 2 else -0.001)
            good.append((day, v_good))
            bad.append((day, v_bad))
        wf = metrics.walk_forward([bad, good])
        self.assertTrue(wf["picks"])
        self.assertTrue(all(p["pick"] == 1 for p in wf["picks"]))
        self.assertGreater(wf["curve"][-1][1], 1.0)

    def test_monte_carlo_and_dsr(self) -> None:
        mc = metrics.monte_carlo([0.02, -0.01, 0.015, -0.005] * 10, paths=200)
        self.assertEqual(mc["paths"], 200)
        self.assertLessEqual(mc["maxDrawdownP5"], mc["maxDrawdownP50"])
        self.assertEqual(metrics.monte_carlo([0.1])["paths"], 0)
        points = [(f"2024-01-{d:02d}", 1 + 0.001 * d + (0.0005 if d % 3 else 0)) for d in range(1, 29)]
        dsr = metrics.deflated_sharpe(points, 10, [0.05, 0.1, 0.0])
        self.assertTrue(0 <= dsr["probability"] <= 1)
        self.assertEqual(dsr["trials"], 10)
        self.assertTrue(math.isfinite(metrics.deflated_sharpe(points, 1, [0.1])["probability"]))

    def test_monthly(self) -> None:
        out = metrics.monthly([("2024-01-30", 1.0), ("2024-01-31", 0.9), ("2024-02-01", 1.2)])
        self.assertEqual([m["month"] for m in out], ["2024-01", "2024-02"])
        self.assertAlmostEqual(out[0]["drawdown"], -0.1)
        self.assertAlmostEqual(out[1]["value"], 0.2)


class VerdictTest(unittest.TestCase):
    @staticmethod
    def _summary(oos: float) -> dict:
        part = {"sharpe": oos, "cagr": 0.01, "maxDrawdown": -0.1}
        return {"full": part, "inSample": part, "outOfSample": part}

    def _checks(self, passes: list[bool]) -> list[dict]:
        return [{"check": f"g{i}", "result": f"r{i}", "pass": p} for i, p in enumerate(passes)]

    def test_pre_registered_rule(self) -> None:
        from strategies.ld34.study import _verdict

        dsr = {"probability": 0.97}
        all_pass = self._checks([True] * 5)
        self.assertEqual(_verdict(self._summary(0.8), dsr, all_pass, self._summary(0.2), 500)[0], "edge")
        self.assertEqual(_verdict(self._summary(0.8), dsr, all_pass, self._summary(-0.2), 500)[0], "needs-more-data")
        # Fewer than 100 trades never reaches edge.
        self.assertEqual(_verdict(self._summary(0.8), dsr, all_pass, self._summary(0.2), 50)[0], "needs-more-data")
        oos_fail = self._checks([False, True, True, True, True])
        self.assertEqual(_verdict(self._summary(-0.1), dsr, oos_fail, self._summary(0.2), 500)[0], "no-edge")
        dsr_fail = self._checks([True, False, True, True, True])
        self.assertEqual(_verdict(self._summary(0.8), {"probability": 0.4}, dsr_fail, self._summary(0.2), 500)[0], "no-edge")
        three = self._checks([True, False, True, True, False])
        verdict, reason = _verdict(self._summary(0.6), {"probability": 0.8}, three, self._summary(-1), 500)
        self.assertEqual(verdict, "needs-more-data")
        self.assertIn("g1: r1; g4: r4", reason)
        two = self._checks([True, False, True, False, False])
        self.assertEqual(_verdict(self._summary(0.6), {"probability": 0.8}, two, self._summary(-1), 500)[0], "no-edge")
        # At most 2 gates is no edge even with few trades.
        self.assertEqual(_verdict(self._summary(0.6), {"probability": 0.8}, two, self._summary(-1), 50)[0], "no-edge")


class StudyHelpersTest(unittest.TestCase):
    def test_exit_day_moves_the_post_close_hour(self) -> None:
        from strategies.ld34.study import _exit_day

        self.assertEqual(_exit_day(ms("2026-01-05T20:00:00")), "2026-01-05")  # 15:00 EST bar ends at the close
        self.assertEqual(_exit_day(ms("2026-01-05T21:00:00")), "2026-01-06")  # 16:00 EST bar ends after it
        self.assertEqual(_exit_day(ms("2026-07-06T20:00:00")), "2026-07-07")  # 16:00 EDT
        self.assertEqual(_exit_day(ms("2026-01-05T22:00:00")), "2026-01-06")  # 17:00 EST: next session

    def test_trade_returns_net_of_financing_inside_window(self) -> None:
        from strategies.ld34.study import _trade_returns

        times = [ms("2024-01-02T15:00:00") + i * 86_400_000 for i in range(12)]
        run = {"times": times, "equity": [1.0] * 12,
               "trades": [{"entryIndex": 1, "exitIndex": 11, "units": 0.03, "entryPrice": 100.0, "pnl": 0.05},
                          {"entryIndex": 0, "exitIndex": 1, "units": 0.005, "entryPrice": 100.0, "pnl": -0.01}]}
        out = _trade_returns(run, {"2023-12-29": 5.0}, "2024-01-01")
        self.assertAlmostEqual(out[0], 0.05 - 2 * 0.065 * 10 / 365)
        self.assertAlmostEqual(out[1], -0.01)
        self.assertEqual(len(_trade_returns(run, {"2023-12-29": 5.0}, "2024-01-03")), 1)

    def test_summary_and_finite_guards(self) -> None:
        from strategies.ld34.study import _finite, _summary

        self.assertEqual(_summary([("2024-01-01", 1.0)])["outOfSample"]["sharpe"], 0.0)
        self.assertEqual(_finite({"a": [1.0, float("nan")], "b": float("inf"), "c": "x"}), {"a": [1.0, 0.0], "b": 0.0, "c": "x"})


class RulesTest(unittest.TestCase):
    def test_lengths_fit_the_study_schema(self) -> None:
        self.assertLessEqual(len(rules.RULES), 30)
        self.assertLessEqual(len(rules.GAPS), 30)
        for row in rules.RULES:
            self.assertLessEqual(len(row["item"]), 60)
            self.assertLessEqual(len(row["rule"]), 400)
            self.assertLessEqual(len(row["source"]), 200)
        for row in rules.GAPS:
            self.assertLessEqual(len(row["gap"]), 300)
            self.assertLessEqual(len(row["choice"]), 400)


if __name__ == "__main__":
    unittest.main()
