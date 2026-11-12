"""Leveraged-ETF short-window study: the run plan, the results document, the results tables and the
research_studies document builder with its contract check, end to end on tiny synthetic data.
No network, no rig data file, no NautilusTrader (the parity test is in test_leveraged_etf_study_forms.py).

CI (scripts/ci/research-python.sh): the base lane has no numpy and no pandas, so this file skips there as a
whole; the Nautilus lane (VERTEX_REQUIRE_NAUTILUS=1) runs every test."""
from __future__ import annotations

import functools
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from pathlib import Path

import pytest

if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
    import numpy  # noqa: F401
    import pandas  # noqa: F401
else:
    pytest.importorskip("numpy", reason="the leveraged-ETF forms need numpy (Nautilus lane)")
    pytest.importorskip("pandas", reason="the contract mirror of the volspike study needs pandas (Nautilus lane)")

from strategies.imom import data as idata  # noqa: E402 - after the optional-backend check
from strategies.leveraged_etf import __main__ as cli  # noqa: E402
from strategies.leveraged_etf import forms, metrics, pairs, prices, report, runner, signals, study  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports.data import Market  # noqa: E402

GATE_NAMES = 8
LOWER_BAR = {"minSharpe": 0.3, "minOosSharpe": 0.0, "minMonteCarloProfit": 0.8, "maxDrawdown": -0.25, "minTrades": 30}


def lower_bar(stats) -> bool:
    carlo = stats["monteCarlo"] or {}
    return (stats["sharpe"] >= 0.3 and stats["oosSharpe"] > 0 and (carlo.get("probabilityOfProfit") or 0) >= 0.8
            and stats["maxDrawdown"] >= -0.25 and stats["trades"] >= 30)


def nyse_days(first: str, count: int) -> tuple[str, ...]:
    out, day = [], date.fromisoformat(first)
    while len(out) < count:
        if not idata.is_closed(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return tuple(out)


DAYS = nyse_days("2024-01-02", 60)


def pair_data(underlying: str, level: float, first: int = 0) -> forms.PairData:
    """60 sessions: U moves +0.6% and -0.4% in turn; both funds follow the daily-reset formula exactly."""
    pair = pairs.BY_UNDERLYING[underlying]
    closes = [level]
    for index in range(1, len(DAYS)):
        closes.append(closes[-1] * (1.006 if index % 2 else 0.996))
    long_closes, inverse_closes = [50.0], [20.0]
    for before, after in zip(closes, closes[1:]):
        long_closes.append(long_closes[-1] * (1 + pair.leverage * (after / before - 1)))
        inverse_closes.append(inverse_closes[-1] * (1 - pair.leverage * (after / before - 1)))
    market = Market(underlying, DAYS, tuple(closes), (18.0,) * len(DAYS), (0.05,) * len(DAYS))
    return forms.PairData(pair, market, {}, prices.FundBars(pair.long_fund, DAYS[first:], tuple(long_closes[first:])),
                          prices.FundBars(pair.inverse_fund, DAYS[first:], tuple(inverse_closes[first:])))


def pair_signals(data: forms.PairData) -> runner.PairSignals:
    """One long S1 signal every session from the 4th on, one S2 signal every 5th session; the calm regime
    keeps the S1 signals of the second half and no S2 signal."""
    market, name = data.market, data.pair.underlying
    first = forms.first_day(data)
    s1, s2 = [], []
    for index in range(3, len(DAYS) - 1):
        day = DAYS[index]
        if day <= first:
            continue
        price = market.close[index - 1] * 1.002
        s1.append(signals.Signal(signals.S1, name, 1, day, idata.ms_at(day, 10 * 60 + 30), price))
        if index % 5 == 0:
            s2.append(signals.Signal(signals.S2, name, -1, day, idata.ms_at(day, 9 * 60 + 35), price))
    found = {signals.S1: {"all": tuple(s1), "calm": tuple(s1[len(s1) // 2:])}, signals.S2: {"all": tuple(s2), "calm": ()}}
    return runner.PairSignals(name, first, DAYS[-1], {signals.S1: first, signals.S2: max(first, runner.S2_FROM)}, found, 2)


@functools.lru_cache(maxsize=None)
def run_study(nautilus_flag: bool = True, keys: tuple[str, ...] | None = None) -> dict:
    """The whole pipeline of run.py on the synthetic pairs, ledger only (computed once per argument set; the
    tests do not change the result). `nautilus_flag` is what the results document says about parity (the
    parity run itself is tested with the forms)."""
    data = {"QQQ": pair_data("QQQ", 440.0), "SPY": pair_data("SPY", 500.0, first=6)}
    found = {name: pair_signals(item) for name, item in data.items()}
    dates = {name: item.market.dates for name, item in data.items()}
    keys = keys or runner.row_keys()
    done, plan = {}, {}
    with forms.fund_models():
        for key in keys:
            signal, regime, window, form = metrics.split_key(key)
            taken, counts = runner.taken_signals(found, signal, regime, window, dates)
            starts = {name: item.start[signal] for name, item in found.items()}
            plan[key] = {"key": key, "signal": signal, "regime": regime, "window": window, "form": form,
                         "signals": sum(len(item.signals[signal][regime]) for item in found.values()),
                         "taken": len(taken), "skipped": counts}
            done[key] = runner.run_row(key, taken, data, starts, nautilus=False)
    variance = metrics.trial_variance([metrics.daily_sharpe(done[key]["daily"]) for key in keys])
    stats = {key: metrics.row_stats(done[key]["daily"], done[key]["returns"], runner.N_TRIALS, variance) for key in keys}
    verdicts = metrics.verdicts(stats, al.gate_checks, lower_bar)
    rows = []
    for key in keys:
        result = done[key]
        rows.append({**plan[key], "priced": result["priced"], "notPriced": result["notPriced"],
                     "staleDays": result["staleDays"], "nautilusGap": 1e-16 if result["priced"] else None,
                     "seconds": result["seconds"], "stats": stats[key], "monthly": metrics.monthly_points(result["daily"]),
                     "verdict": verdicts[key],
                     "perPair": [{"underlying": name, "priced": item["priced"], "start": found[name].start[plan[key]["signal"]],
                                  "stats": metrics.row_stats(item["daily"], item["returns"], runner.N_TRIALS, variance)}
                                 for name, item in result["perPair"].items()]})
    return runner.document(
        rows=rows, found=found, data=data, dropped_pairs=[], variance=variance, engine="nautilus-trader-1.227.0",
        nautilus=nautilus_flag, capital=runner.CAPITAL, gate=al.GATE, lower_bar=LOWER_BAR,
        iv_ratio={"measured": "test", "pairs": {"QQQ": {"longFund": "TQQQ", "inverseFund": "SQQQ", "leverage": 3,
                                                        "rows": [["261120", 9, 0.25, 0.75, 0.99, None]]}}},
        provenance={"commit": "e2606f93" + "0" * 32, "dirty": True, "dataHash": "sha256:" + "ab" * 32},
        wall_seconds=1.0)


class RunPlan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = run_study()

    def test_there_are_forty_form_rows(self):
        keys = runner.row_keys()
        self.assertEqual((len(keys), len(set(keys)), runner.N_TRIALS), (40, 40, 40))
        self.assertEqual(keys[0], "session-open-momentum/all/24h/etf-option")
        self.assertEqual(keys[-1], "volume-spike-breakout/calm/48h/lev-shares")
        self.assertIn(runner.EQUITY_ROW, keys)

    def test_taken_signals_pool_the_pairs_and_apply_the_overlap_rule_per_pair(self):
        data = {"QQQ": pair_data("QQQ", 440.0), "SPY": pair_data("SPY", 500.0, first=6)}
        found = {name: pair_signals(item) for name, item in data.items()}
        dates = {name: item.market.dates for name, item in data.items()}
        taken, counts = runner.taken_signals(found, signals.S1, "all", "24h", dates)
        every = sum(len(item.signals[signals.S1]["all"]) for item in found.values())
        # A long signal every session: with a 24 hour window every second one of a pair is skipped.
        self.assertEqual(len(taken) + counts["overlap"] + counts["noExit"], every)
        self.assertEqual({item.underlying for item in taken}, {"QQQ", "SPY"})
        for name in ("QQQ", "SPY"):
            own = [item.day for item in taken if item.underlying == name]
            self.assertTrue(all(DAYS.index(b) - DAYS.index(a) >= 2 for a, b in zip(own, own[1:])))
        two_day, _ = runner.taken_signals(found, signals.S1, "all", "48h", dates)
        self.assertLess(len(two_day), len(taken))

    def test_a_pooled_book_starts_at_the_earliest_pair_start(self):
        data = {"QQQ": pair_data("QQQ", 440.0), "SPY": pair_data("SPY", 500.0, first=6)}
        found = {name: pair_signals(item) for name, item in data.items()}
        self.assertEqual((found["QQQ"].inputs_from, found["SPY"].inputs_from), (DAYS[0], DAYS[6]))
        self.assertEqual(runner.row_start(found, signals.S1), DAYS[0])
        self.assertEqual(runner.session_days(data, DAYS[6]), list(DAYS[6:]))
        self.assertGreater(min(item.day for item in found["SPY"].signals[signals.S1]["all"]), DAYS[6])

    def test_a_row_is_booked_pooled_and_per_pair(self):
        row = next(row for row in self.results["rows"] if row["key"] == "session-open-momentum/all/24h/lev-option")
        self.assertEqual(row["taken"], row["priced"] + sum(row["notPriced"].values()))
        self.assertEqual(row["stats"]["trades"] + row["stats"]["refused"], row["priced"])
        self.assertEqual([item["underlying"] for item in row["perPair"]], ["QQQ", "SPY"])
        self.assertEqual(sum(item["priced"] for item in row["perPair"]), row["priced"])
        self.assertEqual((row["stats"]["start"], row["perPair"][1]["stats"]["start"]), (DAYS[0], DAYS[6]))
        self.assertEqual(row["stats"]["nTrials"], 40)
        self.assertGreater(row["stats"]["trades"], 0)

    def test_every_form_of_a_row_trades_the_same_signals(self):
        by_key = {row["key"]: row for row in self.results["rows"]}
        for signal in signals.SIGNALS:
            for regime in signals.REGIMES:
                for window in signals.WINDOWS:
                    rows = [by_key[metrics.row_key(signal, regime, window, form)] for form in forms.FORM_KEYS]
                    self.assertEqual(len({(row["signals"], row["taken"], row["skipped"]["overlap"]) for row in rows}), 1)

    def test_the_results_document(self):
        results = self.results
        self.assertEqual((results["schema"], results["complete"], results["capital"]),
                         ("leveraged-etf-short-window-v1", True, 100_000.0))
        self.assertEqual(results["trials"]["count"], 40)
        self.assertEqual(len(results["rows"]), 40)
        self.assertEqual([pair["underlying"] for pair in results["pairs"]], ["QQQ", "SPY"])
        self.assertEqual(results["pairs"][1]["inputsFrom"], DAYS[6])
        self.assertEqual(results["pairs"][0]["s2SignalsWithoutSession"], 2)
        # The funds follow the formula: no tracking error.
        self.assertEqual([item["fund"] for item in results["trackingError"]], ["TQQQ", "SQQQ", "UPRO", "SPXU"])
        self.assertTrue(all(item["p95AbsErrorPct"] < 1e-6 for item in results["trackingError"]))
        for row in results["rows"]:
            self.assertEqual(len(row["verdict"]["gate"]["checks"]), GATE_NAMES)
            self.assertEqual(row["verdict"]["passes"], row["verdict"]["gate"]["pass"])
        self.assertEqual(results["passGate"], [row["key"] for row in results["rows"] if row["verdict"]["passes"]])
        json.dumps(results, allow_nan=False)  # JSON-ready: no NaN, no dataclass

    def test_a_partial_run_is_not_complete(self):
        partial = run_study(keys=tuple(key for key in runner.row_keys() if key.startswith("session-open-momentum/all/24h/")))
        self.assertFalse(partial["complete"])
        self.assertIn("PARTIAL run", report.results_markdown(partial))

    def test_rows_without_a_signal_have_no_trade_and_fail(self):
        rows = [row for row in self.results["rows"] if row["key"].startswith("volume-spike-breakout/calm/")]
        self.assertEqual(len(rows), 10)
        for row in rows:
            self.assertEqual((row["taken"], row["stats"]["trades"], row["stats"]["sharpe"]), (0, 0, None))
            self.assertFalse(row["verdict"]["passes"])
            self.assertFalse(row["verdict"]["lowerBar"]["pass"])


class ResultsTables(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = run_study()
        cls.text = report.results_markdown(cls.results)

    def test_the_verdict_table_has_one_line_per_form_row(self):
        table = report.verdict_table(self.results["rows"]).splitlines()
        self.assertEqual(len(table), 42)
        self.assertTrue(table[0].startswith("| Row | First .. last trade | Trades | Refused | Skipped |"))
        self.assertTrue(table[0].endswith("| worst48hLoss % | gate | lowerBar | leverageHelps |"))
        self.assertTrue(table[2].startswith("| S1/all/24h/etf-option |"))
        self.assertEqual({line.count("|") for line in table}, {len(report.HEADER) + 1})

    def test_a_value_that_does_not_exist_is_printed_as_not_available(self):
        line = next(line for line in report.verdict_table(self.results["rows"]).splitlines()
                    if line.startswith("| S2/calm/24h/lev-option |"))
        self.assertIn("| n/a |", line)
        self.assertIn("| fail (", line)
        self.assertIn("| no (n/a vs n/a) |", line)

    def test_the_markdown_has_every_section(self):
        for heading in ("# Leveraged ETF short-window study: results", "## Form rows", "### Failed gate checks per row",
                        "### Signals, skips and refusals per row",
                        "## Data start per pair and signal", "## Tracking error of the synthetic fund price",
                        "## Measured IV ratio (not used by the model)", "## Every row per pair"):
            self.assertIn(heading, self.text)
        self.assertIn("Every form row was booked on NautilusTrader", self.text)
        self.assertNotIn("PARTIAL run", self.text)
        self.assertIn("did NOT book on NautilusTrader", report.results_markdown(run_study(nautilus_flag=False)))

    def test_the_counts_table_follows_the_signals_of_a_row(self):
        table = report.counts_table(self.results["rows"]).splitlines()
        self.assertEqual(len(table), 42)
        row = next(row for row in self.results["rows"] if row["key"] == "session-open-momentum/all/24h/lev-option")
        cells = [cell.strip() for cell in table[4].strip("|").split("|")]
        self.assertEqual(cells[0], "S1/all/24h/lev-option")
        self.assertEqual([int(cells[i]) for i in (1, 2, 3, 4, 5, 7, 8)],
                         [row["signals"], row["skipped"]["overlap"], row["skipped"]["noExit"], row["taken"], row["priced"],
                          row["stats"]["refused"], row["stats"]["trades"]])
        self.assertEqual(int(cells[1]), int(cells[2]) + int(cells[3]) + int(cells[4]))

    def test_the_compact_table_has_the_report_columns(self):
        table = report.compact_table(self.results["rows"]).splitlines()
        self.assertEqual(table[0], "| key | trades | Sharpe | OOS | DSR | maxDD | worst48hLoss % | gate | lowerBar | "
                                   "leverageHelps |")
        self.assertEqual(len(table), 42)


class StudyDocument(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = run_study()
        cls.doc = study.document(cls.results, "2026-11-11")

    def test_the_document_fits_the_contract(self):
        self.assertEqual(study.validate(self.doc), [])

    def test_identity_and_spec(self):
        doc = self.doc
        self.assertEqual((doc["kind"], doc["id"], doc["ran"]), ("strategy-backtest", "leveraged-etf-short-window", "2026-11-11"))
        self.assertEqual(doc["spec"], "docs/specs/strategies/leveraged-etf-short-window.md")
        self.assertTrue(doc["source"]["url"].startswith("https://"))
        self.assertEqual(doc["provenance"]["runId"], "leveraged-etf-2026-11-11")
        self.assertEqual(doc["provenance"]["engine"], "qc-ports ledger + nautilus-trader-1.227.0 (parity checked)")

    def test_two_forms_hold_the_forty_rows(self):
        forms_ = {form["key"]: form for form in self.doc["forms"]}
        self.assertEqual(sorted(forms_), ["options", "underlying"])
        self.assertLessEqual(len(self.doc["forms"]), 4)
        self.assertEqual((len(forms_["options"]["runs"]), len(forms_["underlying"]["runs"])), (32, 8))
        self.assertEqual({run["symbol"] for run in forms_["underlying"]["runs"]}, {"lev-shares"})
        self.assertEqual({run["symbol"] for run in forms_["options"]["runs"]},
                         {"etf-option", "etf-vertical", "lev-option", "lev-vertical"})
        first = forms_["options"]["runs"][0]
        self.assertEqual((first["symbol"], first["market"]), ("etf-option", "session-open-momentum / all / 24h"))
        row = self.results["rows"][0]["stats"]
        self.assertEqual((first["trades"], first["sharpe"], first["from"], first["to"]),
                         (row["trades"], row["sharpe"], row["start"], row["end"]))

    def test_a_run_without_a_trade_shows_zero_and_null(self):
        run = next(run for run in self.doc["forms"][0]["runs"]
                   if run["market"] == "volume-spike-breakout / calm / 24h" and run["symbol"] == "lev-option")
        self.assertEqual((run["trades"], run["sharpe"], run["winRate"], run["cagr"]), (0, 0.0, 0.0, 0.0))
        self.assertIsNone(run["oosSharpe"])
        self.assertIsNone(run["profitFactor"])

    def test_the_verdict_is_edge_only_when_a_leveraged_row_passes_the_gate(self):
        verdict, reason = study.verdict_of(self.results)
        leveraged_pass = [row for row in self.results["rows"]
                          if row["verdict"]["leverageHelps"] is not None and row["verdict"]["passes"]]
        self.assertEqual(verdict, "edge" if leveraged_pass else "no-edge")
        self.assertEqual((self.doc["verdict"], self.doc["verdictReason"]), (verdict, reason))
        self.assertIn("of 40 form rows pass the allocation gate", reason)
        self.assertLessEqual(len(reason), 1000)
        # An unleveraged row that passes does not make an edge; a leveraged row does.
        changed = json.loads(json.dumps(self.results))
        for row in changed["rows"]:
            row["verdict"]["passes"] = row["key"].endswith("/etf-option")
        changed["passGate"] = [row["key"] for row in changed["rows"] if row["verdict"]["passes"]]
        self.assertEqual(study.verdict_of(changed)[0], "no-edge")
        changed["rows"][2]["verdict"]["passes"] = True  # S1/all/24h/lev-option
        changed["passGate"].append(changed["rows"][2]["key"])
        verdict, reason = study.verdict_of(changed)
        self.assertEqual(verdict, "edge")
        self.assertTrue(reason.startswith("Rows that pass: S1/all/24h/lev-option."))

    def test_the_equity_curve_is_the_row_fixed_before_the_run(self):
        row = next(row for row in self.results["rows"] if row["key"] == runner.EQUITY_ROW)
        self.assertEqual(self.doc["equity"], row["monthly"])
        self.assertGreaterEqual(len(self.doc["equity"]), 2)
        self.assertIn("S1/all/24h/lev-option", self.doc["equityLabel"])

    def test_robustness_rows_name_parity_gate_and_tracking_error(self):
        checks = {row["check"]: row for row in self.doc["robustness"]}
        self.assertTrue(checks["NautilusTrader books every form row like the ledger"]["pass"])
        self.assertIn("Allocation gate, per form row", checks)
        self.assertIsNone(checks["Synthetic fund entry price: error of the formula at the close"]["pass"])
        self.assertIn("0.99 (QQQ)", checks["Measured fund ATM IV / (leverage x ETF ATM IV), one chain read"]["result"])
        self.assertTrue(all(len(row["result"]) <= 300 for row in self.doc["robustness"]))

    def test_a_partial_or_ledger_only_run_gives_no_document(self):
        with self.assertRaises(ValueError):
            study.document({**self.results, "complete": False}, "2026-11-11")
        with self.assertRaises(ValueError):
            study.document({**self.results, "nautilusParity": False}, "2026-11-11")

    def test_the_static_texts_fit_the_contract_limits(self):
        self.assertLessEqual(len(study.RULES), 30)
        self.assertLessEqual(len(study.GAPS), 30)
        for rule in study.RULES:
            self.assertLessEqual(len(rule["item"]), 60, rule["item"])
            self.assertLessEqual(len(rule["rule"]), 400, rule["item"])
            self.assertLessEqual(len(rule["source"]), 200, rule["item"])
        for gap in study.GAPS:
            self.assertLessEqual(len(gap["gap"]), 300)
            self.assertLessEqual(len(gap["choice"]), 400)
        self.assertLessEqual(len(study.TITLE), 200)
        self.assertLessEqual(len(study.SOURCE["label"]), 200)

    def test_the_command_prints_one_document(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "results.json"
            path.write_text(json.dumps(self.results))
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = cli.main(["study", "--results", str(path), "--ran", "2026-11-11"])
            self.assertEqual((code, err.getvalue()), (0, ""))
            printed = out.getvalue().strip().splitlines()
            self.assertEqual(len(printed), 1)
            self.assertEqual(json.loads(printed[0]), self.doc)
            path.write_text(json.dumps({**self.results, "complete": False}))
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = cli.main(["study", "--results", str(path), "--ran", "2026-11-11"])
            self.assertEqual((code, out.getvalue()), (1, ""))
            self.assertIn("No study document", err.getvalue())

    def test_the_tables_command_prints_the_results_tables(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "results.json"
            path.write_text(json.dumps(self.results))
            out = io.StringIO()
            with redirect_stdout(out):
                code = cli.main(["tables", "--results", str(path)])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), report.results_markdown(json.loads(json.dumps(self.results))) + "\n")

    def test_the_command_refuses_a_bad_date(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["study", "--results", "x.json", "--ran", "11/11/2026"])


if __name__ == "__main__":
    unittest.main()
