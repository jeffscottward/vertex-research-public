"""The pre-registered ZAB study (docs/specs/strategies/zab-intraday-momentum.md): plan, gates, verdict, costs."""
from __future__ import annotations

import dataclasses
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from strategies.imom import runner, zab_study
from strategies.imom.data import IBKR, IBKR_SLIPPAGE_BPS, instrument
from strategies.imom.definition import ZAB, ZAB_1X, ZAB_SENSITIVITY, params_to_json


def row(key: str, *, pass_all: bool = False, oos: float = 0.0, stress: float = 0.0) -> dict:
    return {"key": key, "passAll": pass_all, "outOfSample": {"sharpe": oos}, "stress": {"sharpe": stress}}


class PlanTest(unittest.TestCase):
    def test_pre_registered_constants(self) -> None:
        self.assertEqual(zab_study.MARKETS, ("SPY", "QQQ", "IWM", "DIA"))
        self.assertEqual(zab_study.CONFIRMATION, ("QQQ", "IWM", "DIA"))
        self.assertEqual(zab_study.TRIALS, 80)
        self.assertEqual(zab_study.SLIPPAGE_BPS, 1.0)
        self.assertEqual(len(ZAB_SENSITIVITY), 7)
        self.assertEqual(zab_study.GATE["costStressMultiple"], 2.0)

    def test_configurations_are_the_two_forms_and_seven_changes(self) -> None:
        configs = zab_study.configurations()
        self.assertEqual(len(configs), 8)  # ZAB 1x is a form and a change
        self.assertIn(ZAB, configs)
        self.assertIn(ZAB_1X, configs)

    def test_plan_runs_each_configuration_and_the_cost_stress_once(self) -> None:
        jobs = zab_study.plan(["SPY", "QQQ"])
        per_market = 8 * len(ZAB.sides) + len(ZAB.sides)  # 8 configurations + ZAB at doubled costs
        self.assertEqual(len(jobs), 2 * per_market)
        self.assertEqual(len({(k, str(params_to_json(p)), s, mult) for k, p, s, mult in jobs}), len(jobs))
        stress = [job for job in jobs if job[3] == 2.0]
        self.assertEqual({(k, p) for k, p, _, _ in stress}, {("SPY", ZAB), ("QQQ", ZAB)})

    def test_unknown_or_empty_markets_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            zab_study.run("2026-11-10", ["SPY", "GLD"])
        with self.assertRaises(ValueError):
            zab_study.run("2026-11-10", [])

    def test_every_market_needs_its_own_spread_sample(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "QQQ.csv.gz").write_bytes(b"")
            with self.assertRaises(FileNotFoundError) as caught:
                zab_study.require_inputs(["QQQ"], tmp)
            self.assertIn("QQQ-bidask.csv.gz", str(caught.exception))
            (Path(tmp) / "QQQ-bidask.csv.gz").write_bytes(b"")
            zab_study.require_inputs(["QQQ"], tmp)

    def test_a_spy_spread_fallback_is_refused(self) -> None:
        with unittest.mock.patch.object(zab_study, "ibkr_spread", lambda key, root: (0.4, "SPY fallback")):
            with self.assertRaises(FileNotFoundError):
                zab_study.require_own_spread("IWM", None)
        with unittest.mock.patch.object(zab_study, "ibkr_spread", lambda key, root: (0.4, zab_study.SPREAD_MEASURED)):
            self.assertEqual(zab_study.require_own_spread("IWM", None), 0.4)


class GateTest(unittest.TestCase):
    def test_gate_thresholds(self) -> None:
        ok = zab_study.gates(0.5, 0.95, -0.35, 6 / 7, 0.01)
        self.assertTrue(all(check["pass"] for check in ok))
        bad = zab_study.gates(0.49, 0.949, -0.351, 5 / 7, 0.0)
        self.assertFalse(any(check["pass"] for check in bad))
        self.assertFalse(zab_study.gates(1, 1, None, 1, 1)[2]["pass"])  # no Monte Carlo result fails


class VerdictTest(unittest.TestCase):
    def test_edge_needs_two_confirmation_markets_passing_all_gates(self) -> None:
        rows = [row("SPY", pass_all=True), row("QQQ", pass_all=True), row("IWM", pass_all=True), row("DIA")]
        self.assertEqual(zab_study.verdict(rows)["verdict"], "edge")

    def test_spy_never_counts(self) -> None:
        rows = [row("SPY", pass_all=True, oos=2, stress=2), row("QQQ", pass_all=True, oos=1, stress=1),
                row("IWM"), row("DIA")]
        self.assertEqual(zab_study.verdict(rows)["verdict"], "no edge")

    def test_weak(self) -> None:
        rows = [row("SPY"), row("QQQ", oos=0.2, stress=0.1), row("IWM", oos=0.1, stress=0.3), row("DIA", oos=-1)]
        self.assertEqual(zab_study.verdict(rows)["verdict"], "weak")
        rows[2] = row("IWM", oos=0.1, stress=0.0)
        self.assertEqual(zab_study.verdict(rows)["verdict"], "no edge")

    def test_a_smoke_run_has_no_verdict(self) -> None:
        result = zab_study.verdict([row("SPY", pass_all=True)])
        self.assertEqual(result["verdict"], "incomplete")
        self.assertEqual(result["missing"], ["QQQ", "IWM", "DIA"])


class SlippageTest(unittest.TestCase):
    def test_run_job_applies_the_slippage_override(self) -> None:
        seen = []
        with unittest.mock.patch.object(runner, "load_bars", lambda *a, **k: "bars"), \
                unittest.mock.patch.object(runner, "run_leg", lambda data, item, *rest: seen.append(item) or {}):
            runner.run_job(("QQQ", params_to_json(ZAB), "long", 1.0, None, IBKR, 1.0))
            runner.run_job(("QQQ", params_to_json(ZAB), "long", 1.0, None, IBKR))
        self.assertEqual(seen[0].slippage_bps, 1.0)
        self.assertEqual(seen[1].slippage_bps, IBKR_SLIPPAGE_BPS)
        self.assertEqual(instrument("QQQ", IBKR).slippage_bps, IBKR_SLIPPAGE_BPS)  # the market itself is unchanged

    def test_doubled_costs_double_the_slippage_too(self) -> None:
        item = instrument("QQQ", IBKR)
        profile = runner.cost_profile(dataclasses.replace(item, slippage_bps=1.0), 0.8, 2.0)
        self.assertEqual(profile["slippage"], {"kind": "bps", "bps": 2.0})
        self.assertAlmostEqual(profile["spreadBps"], 1.6)


if __name__ == "__main__":
    unittest.main()
