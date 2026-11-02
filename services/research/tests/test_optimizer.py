"""Deterministic synthetic proofs for the stdlib parameter optimizer."""
import json
import math
import random
import statistics
import unittest

from backtesting.optimizer import (
    MAX_GRID_SIZE, MAX_MARKETS, BooleanParam, ChoiceParam, DecimalParam, EvolutionSettings, IntegerParam, NSGASettings,
    Objective, OptimizerConfig, OptimizerLimitError, ParameterSpace, ValidationConfig, Window, deflated_sharpe_ratio,
    expected_max_sharpe, optimize, pareto_front, probability_of_backtest_overfitting, robust_score,
    split_in_out_of_sample, stitch_metrics, walk_forward_windows,
)

SMOOTH = ParameterSpace((DecimalParam("x", -2.0, 2.0), DecimalParam("y", -2.0, 2.0)))


def smooth(params, window, market):
    return {"value": -((params["x"] - 0.3) ** 2 + (params["y"] + 0.2) ** 2)}


def config(method, metric="value", n=100, **kwargs):
    validation = kwargs.pop("validation", ValidationConfig(n_observations=n))
    objectives = kwargs.pop("objectives", Objective(metric))
    return OptimizerConfig(method, objectives, validation, **kwargs)


class ParameterSpaceTests(unittest.TestCase):
    def test_grid_enumeration_order_and_snapping(self):
        space = ParameterSpace((IntegerParam("n", 2, 7, step=2), DecimalParam("w", 0.0, 0.3, step=0.1),
                                ChoiceParam("mode", ("a", "b")), BooleanParam("flag")))
        self.assertEqual([dim.count for dim in space.dimensions], [3, 4, 2, 2])
        self.assertEqual(space.grid_size(), 48)
        grid = list(space.grid())
        self.assertEqual(len(grid), 48)
        self.assertEqual(grid[0], {"n": 2, "w": 0.0, "mode": "a", "flag": False})
        self.assertEqual(grid[1], {"n": 2, "w": 0.0, "mode": "a", "flag": True})
        self.assertEqual(grid[-1], {"n": 6, "w": 0.3, "mode": "b", "flag": True})
        self.assertEqual(space.dimensions[1].values(), [0.0, 0.1, 0.2, 0.3])
        self.assertEqual(space.snap({"n": 9, "w": 0.149, "mode": "b", "flag": True}),
                         {"n": 6, "w": 0.1, "mode": "b", "flag": True})
        self.assertEqual(space.dimensions[0].snap(-5), 2)
        self.assertEqual(space.dimensions[0].snap(4.9), 4)
        self.assertEqual(DecimalParam("c", 0, 1).snap(1.7), 1.0)
        self.assertEqual(DecimalParam("g", 0, 1, grid_points=5).values(), [0.0, 0.25, 0.5, 0.75, 1.0])
        rng = random.Random(3)
        for _ in range(200):
            space.validate(space.sample(rng))
        self.assertEqual(space.defaults(), {"n": 2, "w": 0.0, "mode": "a", "flag": False})

    def test_dimension_validation(self):
        bad = [lambda: IntegerParam("n", 5, 1), lambda: IntegerParam("n", 0, 5, step=0), lambda: IntegerParam("n", 0, 5, 2, default=3),
               lambda: IntegerParam("n", 0.5, 5), lambda: DecimalParam("d", 0, math.inf), lambda: DecimalParam("d", 0, 1, step=-1),
               lambda: DecimalParam("d", 0, 1, step=0.1, grid_points=3), lambda: ChoiceParam("c", ()),
               lambda: ChoiceParam("c", ("a", "a")), lambda: ChoiceParam("c", ("a",), default="b"), lambda: ChoiceParam("c", "ab"),
               lambda: ParameterSpace((IntegerParam("n", 0, 1), DecimalParam("n", 0, 1))), lambda: IntegerParam(" n", 0, 1)]
        for factory in bad:
            with self.assertRaises((ValueError, TypeError)):
                factory()
        self.assertEqual(ChoiceParam("c", (1, True, 1.0)).count, 3)
        with self.assertRaises(ValueError):
            ParameterSpace((DecimalParam("d", 0, 1),)).grid_size()
        with self.assertRaises(ValueError):
            ParameterSpace((IntegerParam("n", 0, 3),)).validate({"n": 1, "extra": 2})

    def test_grid_cap(self):
        space = ParameterSpace((IntegerParam("a", 1, 101), IntegerParam("b", 1, 100)))
        self.assertGreater(space.grid_size(), MAX_GRID_SIZE)
        with self.assertRaises(OptimizerLimitError):
            list(space.grid())
        with self.assertRaises(OptimizerLimitError):
            optimize(lambda p, w, m: {"value": 0.0}, space, config("grid"))


class SearchTests(unittest.TestCase):
    def test_grid_finds_exact_optimum(self):
        space = ParameterSpace((IntegerParam("x", 0, 10), DecimalParam("y", 0.0, 1.0, step=0.25), ChoiceParam("mode", ("slow", "fast"))))

        def objective(params, window, market):
            bonus = 1.0 if params["mode"] == "fast" else 0.0
            return {"value": -(params["x"] - 7) ** 2 - (params["y"] - 0.5) ** 2 + bonus}

        result = optimize(objective, space, config("grid"))
        self.assertEqual(len(result.trials), 110)
        self.assertEqual(result.stop_reason, "exhausted")
        self.assertEqual(result.best.params, {"x": 7, "y": 0.5, "mode": "fast"})
        self.assertEqual(result.best.score, 1.0)
        minimized = optimize(lambda p, w, m: {"value": -objective(p, w, m)["value"]}, space,
                             config("grid", objectives=Objective("value", "minimize")))
        self.assertEqual(minimized.best.params, {"x": 7, "y": 0.5, "mode": "fast"})
        self.assertEqual(minimized.best.score, -1.0)

    def test_tpe_and_evolution_converge_and_beat_random(self):
        means = {}
        for method in ("random", "tpe", "evolution"):
            scores = [optimize(smooth, SMOOTH, config(method, seed=seed, max_trials=100)).best.score for seed in range(6)]
            means[method] = statistics.mean(scores)
            if method == "tpe":
                self.assertGreater(min(scores), -0.005)
            if method == "evolution":
                self.assertGreater(min(scores), -0.05)
                self.assertGreater(means[method], -0.02)
        self.assertGreater(means["tpe"], means["random"])
        self.assertGreater(means["evolution"], means["random"])

    def test_tpe_and_evolution_handle_mixed_spaces(self):
        space = ParameterSpace((IntegerParam("n", 1, 20), DecimalParam("w", 0.0, 1.0, step=0.05), ChoiceParam("kind", ("a", "b", "c")),
                                BooleanParam("flag")))

        def objective(params, window, market):
            return {"value": -abs(params["n"] - 13) - abs(params["w"] - 0.35) * 10 + (2 if params["kind"] == "c" else 0)
                    + (1 if params["flag"] else 0)}

        for method in ("tpe", "evolution"):
            result = optimize(objective, space, config(method, seed=1, max_trials=150))
            self.assertAlmostEqual(result.best.score, 3.0, places=12, msg=method)
            self.assertEqual(result.best.params, {"n": 13, "w": 0.35, "kind": "c", "flag": True})
            for trial in result.trials:
                space.validate(trial.params)

    def test_same_seed_identical_results(self):
        for method in ("random", "tpe", "evolution", "pareto"):
            kwargs = {"objectives": (Objective("value"), Objective("other", "minimize"))} if method == "pareto" else {}

            def objective(params, window, market):
                return {"value": smooth(params, window, market)["value"], "other": params["x"] ** 2}

            first = optimize(objective, SMOOTH, config(method, seed=11, max_trials=60, **kwargs)).to_dict(include_timing=False)
            second = optimize(objective, SMOOTH, config(method, seed=11, max_trials=60, **kwargs)).to_dict(include_timing=False)
            other = optimize(objective, SMOOTH, config(method, seed=12, max_trials=60, **kwargs)).to_dict(include_timing=False)
            self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True), method)
            self.assertNotEqual(first["trials"], other["trials"], method)
            self.assertEqual((first["seed"], first["method"], first["config"]["max_trials"]), (11, method, 60))
            self.assertEqual(first["config"]["effective_max_trials"], 60)
            self.assertEqual(first["config"]["validation"]["mode"], "single")


class ParetoTests(unittest.TestCase):
    def test_pareto_front_helper(self):
        points = [(1, 5), (2, 4), (2, 6), (0, 9), (3, 1), (3, 1)]
        self.assertEqual(pareto_front(points, ("maximize", "maximize")), [2, 3, 4, 5])
        self.assertEqual(pareto_front(points, ("minimize", "maximize")), [3])
        self.assertEqual(pareto_front(points, ("minimize", "minimize")), [0, 1, 3, 4, 5])

    def test_nsga2_small_exhaustive_front(self):
        space = ParameterSpace((IntegerParam("x", 0, 2), IntegerParam("y", 0, 2)))

        def objective(params, window, market):
            x, y = params["x"], params["y"]
            return {"reward": float(x + y), "cost": float(x + 2 * y)}

        objectives = (Objective("reward"), Objective("cost", "minimize"))
        result = optimize(objective, space, config("pareto", objectives=objectives, seed=5, max_trials=200,
                                                   nsga=NSGASettings(population=10)))
        # Exhaustive truth over all 9 points: only (x, 0) and (2, y) are non-dominated.
        grid = list(space.grid())
        truth = pareto_front([(p["x"] + p["y"], p["x"] + 2 * p["y"]) for p in grid], ("maximize", "minimize"))
        self.assertEqual({(grid[i]["x"], grid[i]["y"]) for i in truth}, {(0, 0), (1, 0), (2, 0), (2, 1), (2, 2)})
        front = [(result.trials[i].params["x"], result.trials[i].params["y"]) for i in result.pareto_front]
        self.assertEqual(sorted(front), [(0, 0), (1, 0), (2, 0), (2, 1), (2, 2)])
        self.assertEqual(len(front), len(set(front)))
        self.assertIsNone(result.best)
        self.assertEqual(result.diagnostics.deflated_sharpe_reason, "not defined for Pareto mode")

    def test_nsga2_continuous_front_is_non_dominated(self):
        space = ParameterSpace((DecimalParam("a", 0.0, 1.0), DecimalParam("b", 0.0, 1.0)))

        def objective(params, window, market):
            f1 = params["a"]
            g = 1 + 9 * params["b"]
            return {"f1": f1, "f2": g * (1 - math.sqrt(f1 / g))}

        objectives = (Objective("f1", "minimize"), Objective("f2", "minimize"))
        result = optimize(objective, space, config("pareto", objectives=objectives, seed=2, max_trials=400))
        front = [result.trials[i] for i in result.pareto_front]
        self.assertGreaterEqual(len(front), 5)
        for member in front:
            for trial in result.trials:
                a, b = trial.objective_values, member.objective_values
                self.assertFalse(a[0] <= b[0] and a[1] <= b[1] and a != b)
        self.assertLess(statistics.mean(t.params["b"] for t in front), 0.1)

    def test_pareto_requires_single_validation_and_two_objectives(self):
        objectives = (Objective("a"), Objective("b"))
        with self.assertRaises(ValueError):
            config("pareto", objectives=objectives, validation=ValidationConfig("is_oos", 100))
        with self.assertRaises(ValueError):
            config("pareto", objectives=(Objective("a"),))
        with self.assertRaises(ValueError):
            config("tpe", objectives=objectives)


class ValidationTests(unittest.TestCase):
    def test_is_oos_boundaries(self):
        self.assertEqual(split_in_out_of_sample(100), (Window(0, 70, "in_sample"), Window(70, 100, "out_of_sample")))
        self.assertEqual(split_in_out_of_sample(10, 0.33)[0].end, 3)
        self.assertEqual(split_in_out_of_sample(100, 0.57)[0].end, 57)
        for args in ((1, 0.5), (10, 0.0), (10, 1.0), (10, 0.05)):
            with self.assertRaises(ValueError):
                split_in_out_of_sample(*args)

    def test_is_oos_optimizes_in_sample_and_reports_out_of_sample(self):
        space = ParameterSpace((IntegerParam("x", 0, 9),))
        seen = []

        def objective(params, window, market):
            seen.append(window)
            target = 3 if window.start == 0 else 6
            return {"value": -abs(params["x"] - target)}

        result = optimize(objective, space, config("grid", validation=ValidationConfig("is_oos", 200, top_k=3)))
        self.assertEqual({w for w in seen}, {Window(0, 140, "in_sample"), Window(140, 200, "out_of_sample")})
        self.assertTrue(all(t.window == Window(0, 140, "in_sample") for t in result.trials))
        self.assertEqual(result.best.params, {"x": 3})
        validation = result.validation
        self.assertEqual(validation.selected.params, {"x": 3})
        self.assertEqual((validation.selected.in_sample_score, validation.selected.score, validation.selected.degradation),
                         (0.0, -3.0, -3.0))
        self.assertEqual([r.params["x"] for r in validation.top_k], [3, 2, 4])
        self.assertEqual([r.score for r in validation.top_k], [-3.0, -4.0, -2.0])

    def test_walk_forward_windows(self):
        folds = walk_forward_windows(100, 30, 10)
        self.assertEqual(len(folds), 7)
        for index, (train, test) in enumerate(folds):
            self.assertEqual((train.start, train.end, test.start, test.end),
                             (10 * index, 10 * index + 30, 10 * index + 30, 10 * index + 40))
        for (_, first), (_, second) in zip(folds, folds[1:]):
            self.assertLessEqual(first.end, second.start)
        anchored = walk_forward_windows(100, 30, 10, anchored=True)
        self.assertEqual([(t.start, t.end) for t, _ in anchored][:3], [(0, 30), (0, 40), (0, 50)])
        stepped = walk_forward_windows(100, 30, 10, step=25)
        self.assertEqual([(s.start, s.end) for _, s in stepped], [(30, 40), (55, 65), (80, 90)])
        with self.assertRaises(ValueError):
            walk_forward_windows(100, 30, 10, step=5)
        with self.assertRaises(ValueError):
            walk_forward_windows(30, 30, 10)
        with self.assertRaises(OptimizerLimitError):
            walk_forward_windows(10_000, 10, 10)

    def test_walk_forward_optimizes_per_fold_and_stitches(self):
        space = ParameterSpace((IntegerParam("x", 0, 9),))

        def objective(params, window, market):
            target = (window.end // 20) % 10
            return {"value": -abs(params["x"] - target), "total_return": 0.01 * (5 - abs(params["x"] - target)),
                    "trades": 3.0, "max_drawdown": -0.01 * window.start / 10}

        validation = ValidationConfig("walk_forward", 100, train_length=40, test_length=20)
        result = optimize(objective, space, config("grid", validation=validation))
        folds = result.validation.folds
        self.assertEqual([(f.train.start, f.train.end, f.test.start, f.test.end) for f in folds],
                         [(0, 40, 40, 60), (20, 60, 60, 80), (40, 80, 80, 100)])
        self.assertEqual([f.params["x"] for f in folds], [2, 3, 4])
        self.assertEqual([f.out_of_sample.score for f in folds], [-1.0, -1.0, -1.0])
        self.assertEqual([len(f.trial_indices) for f in folds], [10, 10, 10])
        self.assertEqual([result.trials[f.trial_indices[0]].fold for f in folds], [0, 1, 2])
        stitched = result.validation.stitched["default"]
        self.assertAlmostEqual(stitched["total_return"], 1.04 ** 3 - 1, places=12)
        self.assertEqual((stitched["trades"], stitched["value"], stitched["max_drawdown"]), (9.0, -1.0, -0.08))
        self.assertEqual(result.validation.stitched_score, -1.0)
        self.assertEqual(result.best.params, {"x": 4})
        self.assertEqual(stitch_metrics([(Window(0, 10), {"sharpe": 1.0}), (Window(10, 40), {"sharpe": 2.0})]), {"sharpe": 1.75})


class MarketTests(unittest.TestCase):
    VALUES = {"A": 1.0, "B": 2.0, "C": 4.0}

    def market_objective(self, params, window, market):
        return {"value": self.VALUES[market] * params["s"]}

    def test_multi_market_score_formula(self):
        space = ParameterSpace((ChoiceParam("s", (1.0,)),))
        weights = {"C": 2.0}
        result = optimize(self.market_objective, space, config("grid", markets=("A", "B", "C"), market_weights=weights))
        # weights 1,1,2: mean = 11/4; var = (1.75^2 + 0.75^2 + 2 * 1.25^2) / 4 = 1.6875
        self.assertAlmostEqual(result.best.score, 2.75 - 0.25 * math.sqrt(1.6875), places=14)
        self.assertEqual(result.best.score, robust_score([1.0, 2.0, 4.0], [1, 1, 2]))
        minimized = optimize(self.market_objective, space, config("grid", objectives=Objective("value", "minimize"),
                                                                  markets=("A", "B", "C"), market_weights=weights,
                                                                  dispersion_penalty=0.5))
        self.assertAlmostEqual(minimized.best.score, 2.75 + 0.5 * math.sqrt(1.6875), places=14)

    def test_failed_market_is_dropped_with_flag(self):
        space = ParameterSpace((ChoiceParam("s", (1.0,)),))

        def objective(params, window, market):
            return {"value": math.nan} if market == "B" else {"value": self.VALUES[market]}

        result = optimize(objective, space, config("grid", markets=("A", "B", "C")))
        self.assertEqual(result.best.dropped_markets, ("B",))
        self.assertEqual(result.best.markets[1].reason, "non-finite metric 'value'")
        self.assertEqual(result.best.score, 2.5 - 0.25 * 1.5)
        everything = optimize(lambda p, w, m: {"value": math.inf}, space, config("grid", markets=("A", "B")))
        self.assertIsNone(everything.best)
        self.assertEqual((everything.trials[0].status, everything.trials[0].reason), ("failed", "all markets failed"))

    def test_market_only_ranking(self):
        space = ParameterSpace((IntegerParam("s", 1, 5, default=2),))
        calls = []

        def objective(params, window, market):
            calls.append((dict(params), window, market))
            if market == "D":
                raise RuntimeError("no data")
            return {"value": self.VALUES[market] * params["s"]}

        result = optimize(objective, space, config("market_only", markets=("A", "B", "C", "D")))
        self.assertEqual([c[0] for c in calls], [{"s": 2}] * 4)
        self.assertEqual([(r.rank, r.market, r.value) for r in result.market_ranking],
                         [(1, "C", 8.0), (2, "B", 4.0), (3, "A", 2.0), (None, "D", None)])
        self.assertEqual(result.market_ranking[-1].reason, "error: RuntimeError: no data")
        low = optimize(objective, space, config("market_only", markets=("A", "B", "C"), objectives=Objective("value", "minimize")))
        self.assertEqual([r.market for r in low.market_ranking], ["A", "B", "C"])
        with self.assertRaises(ValueError):
            config("market_only", validation=ValidationConfig("is_oos", 100))

    def test_failed_trials_kept_flagged_and_excluded(self):
        space = ParameterSpace((IntegerParam("x", 0, 9),))

        def objective(params, window, market):
            x = params["x"]
            if x == 9:
                return {"value": math.nan, "trades": 10}
            if x == 8:
                raise ValueError("boom")
            return {"value": float(x), "trades": float(x)}

        result = optimize(objective, space, config("grid", min_trades=3, validation=ValidationConfig("is_oos", 100)))
        statuses = {t.params["x"]: (t.status, t.markets[0].reason) for t in result.trials}
        self.assertEqual(len(result.trials), 10)
        self.assertEqual(statuses[9][0], "failed")
        self.assertEqual(statuses[8][1], "error: ValueError: boom")
        self.assertEqual(statuses[2][1], "trades below minimum 3")
        self.assertEqual(statuses[3], ("ok", None))
        self.assertEqual(result.best.params, {"x": 7})
        self.assertEqual([r.params["x"] for r in result.validation.top_k], [7, 6, 5, 4, 3])
        with self.assertRaises(ValueError):
            optimize(objective, space, config("grid", catch_errors=False))
        payload = json.dumps(result.to_dict(), allow_nan=False)
        self.assertIn('"NaN"', payload)

    def test_market_limit(self):
        with self.assertRaises(OptimizerLimitError):
            config("random", markets=tuple(f"M{i}" for i in range(MAX_MARKETS + 1)))
        config("random", markets=tuple(f"M{i}" for i in range(MAX_MARKETS)))


class DiagnosticsTests(unittest.TestCase):
    def test_deflated_sharpe_matches_published_example(self):
        # Bailey & Lopez de Prado (2014): annual SR 2.5, 5 years daily, 100 trials, V[SR] = 0.5,
        # skew -3, kurtosis 10 -> DSR ~= 0.9004.
        result = deflated_sharpe_ratio(2.5 / math.sqrt(250), 100, 0.5 / 250, 1250, -3.0, 10.0)
        self.assertAlmostEqual(result.probability, 0.9004, places=4)

    def test_deflated_sharpe_hand_computed(self):
        # N = 10: inv(0.9) = 1.2815516, inv(1 - 1/(10e)) = inv(0.9632121) = 1.7892418
        # SR0 = 0.1 * (0.4227843 * 1.2815516 + 0.5772157 * 1.7892418) = 0.1574598
        # z = (0.3 - 0.1574598) * sqrt(99) / sqrt(1 + (3 - 1) / 4 * 0.09) = 1.3873841 -> Phi = 0.917338
        result = deflated_sharpe_ratio(0.3, 10, 0.01, 100)
        self.assertAlmostEqual(result.expected_max_sharpe, 0.1574598, places=7)
        self.assertAlmostEqual(result.z, 1.3873841, places=7)
        self.assertAlmostEqual(result.probability, 0.917338, places=6)
        self.assertEqual(expected_max_sharpe(10, 0.0), 0.0)
        with self.assertRaises(ValueError):
            deflated_sharpe_ratio(0.3, 1, 0.01, 100)

    def test_optimizer_dsr_uses_trial_sharpes(self):
        space = ParameterSpace((IntegerParam("x", 0, 4),))
        sharpes = [0.5, 1.0, 2.0, 1.5, 0.0]
        result = optimize(lambda p, w, m: {"sharpe": sharpes[p["x"]]}, space,
                          config("grid", metric="sharpe", n=252, sharpe_periods_per_year=252))
        per_bar = [value / math.sqrt(252) for value in sharpes]
        expected = deflated_sharpe_ratio(max(per_bar), 5, statistics.variance(per_bar), 252)
        self.assertEqual(result.diagnostics.deflated_sharpe, expected)
        self.assertEqual(result.diagnostics.pbo_reason, "no returns function supplied")

    def test_walk_forward_dsr_counts_every_fold_trial(self):
        space = ParameterSpace((IntegerParam("x", 0, 4),))
        sharpes = [0.5, 1.0, 2.0, 1.5, 0.0]

        def objective(params, window, market):
            return {"sharpe": sharpes[params["x"]] + window.start / 1000}

        validation = ValidationConfig("walk_forward", 100, train_length=40, test_length=20)
        result = optimize(objective, space, config("grid", metric="sharpe", validation=validation,
                                                   sharpe_periods_per_year=252))
        per_bar = [(value + start / 1000) / math.sqrt(252) for start in (0, 20, 40) for value in sharpes]
        expected = deflated_sharpe_ratio((2.0 + 0.04) / math.sqrt(252), 15, statistics.variance(per_bar), 40)
        self.assertIsNone(result.diagnostics.deflated_sharpe_reason)
        self.assertEqual(result.diagnostics.deflated_sharpe.n_trials, 15)
        self.assertAlmostEqual(result.diagnostics.deflated_sharpe.probability, expected.probability, places=12)
        self.assertEqual(result.diagnostics.pbo_reason, "walk-forward PBO is per fold")

    def test_market_only_dsr_counts_markets(self):
        space = ParameterSpace((IntegerParam("s", 1, 5, default=2),))
        values = {"A": 0.5, "B": 1.5, "C": 1.0}
        result = optimize(lambda p, w, m: {"sharpe": values[m]}, space,
                          config("market_only", metric="sharpe", n=252, markets=("A", "B", "C"),
                                 sharpe_periods_per_year=252))
        per_bar = [value / math.sqrt(252) for value in values.values()]
        expected = deflated_sharpe_ratio(1.5 / math.sqrt(252), 3, statistics.variance(per_bar), 252)
        self.assertEqual(result.diagnostics.deflated_sharpe, expected)
        self.assertEqual(result.diagnostics.pbo_reason, "market-only mode has a single parameter set")
        single = optimize(lambda p, w, m: {"sharpe": 1.0}, space,
                          config("market_only", metric="sharpe", markets=("A",)))
        self.assertEqual(single.diagnostics.deflated_sharpe_reason, "needs at least two markets with results")
        missing = optimize(lambda p, w, m: {"other": 1.0}, space,
                           config("market_only", metric="other", markets=("A", "B")))
        self.assertEqual(missing.diagnostics.deflated_sharpe_reason, "metric 'sharpe' missing")

        def failing(params, window, market):
            raise RuntimeError("no data")

        failed = optimize(failing, space, config("market_only", metric="sharpe", markets=("A", "B")))
        self.assertEqual(failed.diagnostics.deflated_sharpe_reason, "no successful market")
        short = optimize(lambda p, w, m: {"sharpe": values[m]}, space,
                         config("market_only", metric="sharpe", n=1, markets=("A", "B")))
        self.assertEqual(short.diagnostics.deflated_sharpe_reason, "needs at least two observations")

    def test_pbo_dominant_and_noise(self):
        rng = random.Random(7)
        noise = [[rng.gauss(0, 0.01) for _ in range(240)] for _ in range(20)]
        dominant = noise + [[0.02 + rng.gauss(0, 0.001) for _ in range(240)]]
        self.assertEqual(probability_of_backtest_overfitting(dominant).pbo, 0.0)
        values = []
        for seed in range(10):
            rng = random.Random(seed)
            values.append(probability_of_backtest_overfitting([[rng.gauss(0, 0.01) for _ in range(240)] for _ in range(40)]).pbo)
        self.assertTrue(0.35 <= statistics.mean(values) <= 0.65, values)
        result = probability_of_backtest_overfitting(noise, n_partitions=4, metric="mean")
        self.assertEqual((result.n_combinations, result.n_periods_used, len(result.logits)), (6, 240, 6))
        for bad in (dict(returns=noise, n_partitions=7), dict(returns=noise[:1]), dict(returns=[[0.0] * 10] * 2, n_partitions=8)):
            with self.assertRaises(ValueError):
                probability_of_backtest_overfitting(**bad)

    def test_optimizer_pbo_with_returns_fn(self):
        space = ParameterSpace((IntegerParam("x", 0, 5),))

        def returns(params, window, market):
            rng = random.Random(params["x"] * 100 + len(market))
            drift = 0.01 if params["x"] == 3 else 0.0
            return [drift + rng.gauss(0, 0.001) for _ in range(window.length)]

        def objective(params, window, market):
            series = returns(params, window, market)
            return {"sharpe": statistics.mean(series) / statistics.stdev(series)}

        result = optimize(objective, space, config("grid", metric="sharpe", n=160, markets=("A", "BB")), returns_fn=returns)
        self.assertEqual(result.diagnostics.pbo.pbo, 0.0)
        self.assertEqual(result.diagnostics.pbo.n_trials, 6)


class LimitTests(unittest.TestCase):
    def test_max_trials_limits(self):
        with self.assertRaises(OptimizerLimitError):
            config("random", max_trials=10_001)
        result = optimize(smooth, SMOOTH, config("random", max_trials=7))
        self.assertEqual((len(result.trials), result.stop_reason), (7, "budget"))
        grid = optimize(lambda p, w, m: {"value": float(p["x"])}, ParameterSpace((IntegerParam("x", 0, 99),)), config("grid", max_trials=5))
        self.assertEqual((len(grid.trials), grid.stop_reason), (5, "budget"))

    def test_time_budget_stops_between_trials(self):
        ticks = iter(range(1000))
        result = optimize(smooth, SMOOTH, config("tpe", max_trials=50, time_budget_seconds=5), clock=lambda: float(next(ticks)))
        # clock: 0 at start, then one read before each trial: 1, 2, 3, 4 run; 5 stops.
        self.assertEqual((len(result.trials), result.stop_reason), (4, "time_budget"))

    def test_progress_callback(self):
        events = []
        result = optimize(smooth, SMOOTH, config("random", max_trials=20), progress=lambda index, best: events.append((index, best)))
        self.assertEqual([index for index, _ in events], list(range(20)))
        scores = [best.score for _, best in events]
        self.assertEqual(scores, sorted(scores))
        self.assertEqual(events[-1][1], result.best)

    def test_result_json_round_trip(self):
        validation = ValidationConfig("walk_forward", 60, train_length=20, test_length=10, anchored=True)
        result = optimize(smooth, SMOOTH, config("evolution", seed=4, max_trials=16, validation=validation))
        data = json.loads(json.dumps(result.to_dict(), allow_nan=False))
        self.assertEqual(data["config"]["validation"]["anchored"], True)
        self.assertEqual(data["config"]["evolution"]["population"], EvolutionSettings().population)
        self.assertEqual(len(data["validation"]["folds"]), 4)
        self.assertIn("elapsed_seconds", data["timing"])
        self.assertNotIn("timing", result.to_dict(include_timing=False))


if __name__ == "__main__":
    unittest.main()
