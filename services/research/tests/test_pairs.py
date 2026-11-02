import json
import math
import random
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from strategies.pairs import (adf_no_constant, engle_granger, half_life, mackinnon_critical_values,
                              mackinnon_p_value, main, ols, pairs_lens, zscore_backtest)


def pair(n=300, seed=5, phi=0.8):
    """Y = 1.5 X + 3 + AR(1) error; X is a random walk. phi = 1 gives no cointegration."""
    rng = random.Random(seed)
    x, y, level, error = [], [], 50.0, 0.0
    for _ in range(n):
        level += rng.gauss(0, 1)
        error = phi * error + rng.gauss(0, 1)
        x.append(level)
        y.append(1.5 * level + 3 + error)
    return y, x


class CointegrationTests(unittest.TestCase):
    # References: statsmodels 0.15.0 tsa.stattools.coint(y, x) (trend "c", autolag "aic").
    def test_engle_granger_matches_statsmodels(self):
        y, x = pair()
        result = engle_granger(y, x)
        self.assertAlmostEqual(result.statistic, -6.333309996095139, places=10)
        self.assertAlmostEqual(result.p_value, 2.9984809515780446e-07, places=15)
        for mine, reference in zip(result.critical_values,
                                   (-3.933443446270176, -3.35664143611369, -3.0586650401002227)):
            self.assertAlmostEqual(mine, reference, places=12)
        self.assertAlmostEqual(result.hedge_ratio, 1.5, delta=0.05)
        self.assertAlmostEqual(result.half_life, 2.564661793645702, places=8)

    def test_random_walk_pair_is_not_cointegrated(self):
        y, x = pair(seed=9, phi=1.0)
        result = engle_granger(y, x)
        self.assertAlmostEqual(result.statistic, -2.1941613918449074, places=10)
        self.assertAlmostEqual(result.p_value, 0.4273763760176372, places=12)

    def test_mackinnon_tails_and_critical_values(self):
        self.assertEqual(mackinnon_p_value(1.0), 1.0)
        self.assertEqual(mackinnon_p_value(-19.0), 0.0)
        # statsmodels mackinnonp(-1.0, "c", N=2) and mackinnonp(-3.5, "c", N=2).
        self.assertAlmostEqual(mackinnon_p_value(-1.0), 0.902847226038779, places=12)
        self.assertAlmostEqual(mackinnon_p_value(-3.5), 0.03239538836017372, places=12)
        self.assertAlmostEqual(mackinnon_critical_values(501)[1], -3.33613 - 6.1101 / 500 - 6.823 / 500 ** 2, places=12)

    def test_adf_fixed_lag_and_errors(self):
        y, x = pair()
        result = adf_no_constant([a - 1.5 * b - 3 for a, b in zip(y, x)], max_lag=2, autolag=False)
        self.assertEqual(result.lags, 2)
        self.assertEqual(result.nobs, 297)
        with self.assertRaises(ValueError):
            adf_no_constant([1.0, 2.0, 3.0])
        with self.assertRaises(ValueError):
            engle_granger([1.0, 2.0], [1.0])
        with self.assertRaises(ValueError):
            ols([1.0], [[1.0], [2.0]])
        with self.assertRaises(ValueError):
            ols([1.0, 2.0, 3.0], [[1.0, 1.0, 1.0], [2.0, 2.0, 2.0]])

    def test_half_life_none_without_reversion(self):
        self.assertIsNone(half_life([1.0, 2.0, 4.0, 8.0, 16.0, 32.0]))


class SpreadBacktestTests(unittest.TestCase):
    def test_trades_round_trips_with_costs_and_next_bar_fills(self):
        y, x = pair(n=400)
        when = [f"2020-01-01" if i == 0 else f"d{i:04d}" for i in range(400)]
        free = zscore_backtest(when, y, x, 1.5, 3.0, 100, lookback=40, cost_bps=0.0)
        costly = zscore_backtest(when, y, x, 1.5, 3.0, 100, lookback=40, cost_bps=10.0)
        self.assertEqual(len(free.equity), 300)
        self.assertGreater(len(free.trades), 5)
        self.assertEqual(len(free.trades), len(costly.trades))
        self.assertTrue(all(trade.commission == 0 for trade in free.trades))
        self.assertTrue(all(trade.commission > 0 for trade in costly.trades))
        self.assertLess(costly.equity[-1][1], free.equity[-1][1])
        net = math.fsum(trade.pnl for trade in costly.trades)
        self.assertAlmostEqual(costly.equity[-1][1] - 100_000, net, places=6)
        # Fills happen on the bar after the signal, never on the first trading bar.
        self.assertNotEqual(costly.trades[0].entry_t, when[100])
        self.assertTrue({trade.side for trade in costly.trades} <= {"long", "short"})

    def test_stop_and_end_exits(self):
        when = [f"d{i:03d}" for i in range(30)]
        x = [10.0] * 30
        y = [1.0 + 0.01 * (i % 2) for i in range(20)] + [1.5, 2.5, 4.0, 6.0, 9.0, 13.0, 18.0, 24.0, 31.0, 39.0]
        run = zscore_backtest(when, y, x, 0.0, 0.0, 10, lookback=10, entry_z=1.5, exit_z=0.1, stop_z=2.5,
                              cost_bps=0.0)
        reasons = [trade.exit_reason for trade in run.trades]
        self.assertIn("stop", reasons)
        flat = zscore_backtest(when, [1.0] * 30, x, 0.0, 0.0, 10, lookback=10)
        self.assertEqual(flat.trades, [])
        drift = [1.0 + 0.001 * i * i for i in range(30)]
        tail = zscore_backtest(when, drift, x, 0.0, 0.0, 10, lookback=10, entry_z=1.2, exit_z=0.1, stop_z=50)
        self.assertEqual(tail.trades[-1].exit_reason, "end")

    def test_no_entry_fills_on_the_last_bar(self):
        when = [f"d{i:03d}" for i in range(22)]
        x = [10.0] * 22
        # Flat spread, then a jump on bar 20: the entry signal fills only on bar 21, the last bar.
        y = [1.0 + 0.01 * (i % 2) for i in range(20)] + [3.0, 3.0]
        run = zscore_backtest(when, y, x, 0.0, 0.0, 10, lookback=10, entry_z=1.5, exit_z=0.1, stop_z=50)
        self.assertEqual(run.trades, [])
        self.assertEqual(run.equity[-1][1], 100_000.0)

    def test_rejects_bad_settings(self):
        when = [f"d{i:03d}" for i in range(30)]
        with self.assertRaises(ValueError):
            zscore_backtest(when, [1.0] * 30, [1.0] * 30, 1.0, 0.0, 10, entry_z=0.5, exit_z=1.0)
        with self.assertRaises(ValueError):
            zscore_backtest(when, [1.0] * 30, [1.0] * 30, 1.0, 0.0, 5, lookback=10)


class LensRecordTests(unittest.TestCase):
    def test_record_matches_the_agent_ops_shape(self):
        y, x = pair(n=400)
        when = [f"2020-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(400)]
        record = pairs_lens(when, y, x, y_label="AAA", x_label="BBB", task_id="task-1",
                            data_source="synthetic", formation=200, lookback=40)
        self.assertEqual(record["periodStart"], when[200])
        self.assertEqual(len(record["equity"]), 200)
        self.assertEqual(record["metrics"]["pair.legs"], "AAA/BBB")
        self.assertLess(record["metrics"]["pair.adf_p"], 0.01)
        self.assertIn("pair.half_life_bars", record["metrics"])
        self.assertLessEqual(len(record["metrics"]), 40)
        self.assertTrue(all(trade["entry_px"] > 0 and trade["qty"] > 0 for trade in record["trades"]))
        self.assertEqual(record["runConfig"]["commissionPercent"], 0.05)
        json.dumps(record, allow_nan=False)
        with self.assertRaises(ValueError):
            pairs_lens(when, y, x[:-1], y_label="A", x_label="B", task_id="t", data_source="s", formation=200)

    def test_cli_reads_two_csv_files(self):
        y, x = pair(n=200)
        when = [f"2020-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(200)]
        with tempfile.TemporaryDirectory() as folder:
            for name, values in (("y.csv", y), ("x.csv", x)):
                Path(folder, name).write_text("date,close\n" + "".join(f"{d},{v}\n" for d, v in zip(when, values)))
            output = StringIO()
            with redirect_stdout(output):
                main(["--y", str(Path(folder, "y.csv")), "--x", str(Path(folder, "x.csv")), "--y-label", "AAA",
                      "--x-label", "BBB", "--task-id", "task-1", "--data-source", "synthetic", "--lookback", "30"])
        record = json.loads(output.getvalue())
        self.assertEqual(record["instruments"], "AAA,BBB")
        self.assertEqual(record["metrics"]["pair.formation_bars"], 100)


if __name__ == "__main__":
    unittest.main()
