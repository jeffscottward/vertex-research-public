"""Leveraged-ETF short-window study: the run plan, the results document, the results tables and the
research_studies document builder with its contract check, end to end on tiny synthetic data, and the
pure parts of research/backtests/leveraged-etf/run.py (loaded from its file): the form rows of a run,
the pairs of a run and the rule that marks a run as partial.
No network, no rig data file, no NautilusTrader (the parity test is in test_leveraged_etf_study_forms.py).

CI (scripts/ci/research-python.sh): the base lane has no numpy and no pandas, so this file skips there as a
whole; the Nautilus lane (VERTEX_REQUIRE_NAUTILUS=1) runs every test."""
from __future__ import annotations

import functools
import importlib.util
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
RUN_SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "run.py"


def load_run_script():
    """research/backtests/leveraged-etf/run.py as a module (its folder name is not an importable name).
    Loading it runs no study: `main` is only called when the file is the program."""
    spec = importlib.util.spec_from_file_location("leveraged_etf_run_script", RUN_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run_script = load_run_script()
OWNER = run_script.owner_lower_bar()  # the owner's lower bar as run.py wires it, not a copy
ALL_PAIRS = tuple(pair.underlying for pair in pairs.PAIRS)
LEVELS = {"QQQ": 440.0, "SPY": 500.0, "IWM": 200.0, "DIA": 380.0, "GLD": 190.0, "SLV": 22.0, "USO": 75.0}
EX_DIVIDEND_INDEX = 20  # SPY goes ex 1.50 on this session of the synthetic data


def nyse_days(first: str, count: int) -> tuple[str, ...]:
    out, day = [], date.fromisoformat(first)
    while len(out) < count:
        if not idata.is_closed(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return tuple(out)


DAYS = nyse_days("2024-01-02", 60)


def pair_data(underlying: str, level: float | None = None, first: int = 0) -> forms.PairData:
    """60 sessions: U moves +0.6% and -0.4% in turn; both funds follow the daily-reset formula exactly, on
    U's total return: SPY goes ex 1.50 on session EX_DIVIDEND_INDEX and its funds do not drop with it."""
    pair = pairs.BY_UNDERLYING[underlying]
    closes = [LEVELS[underlying] if level is None else level]
    for index in range(1, len(DAYS)):
        closes.append(closes[-1] * (1.006 if index % 2 else 0.996))
    paid = {DAYS[EX_DIVIDEND_INDEX]: 1.5} if underlying == "SPY" else {}
    long_closes, inverse_closes = [50.0], [20.0]
    for day, before, after in zip(DAYS[1:], closes, closes[1:]):
        move = (after + paid.get(day, 0.0)) / before - 1
        long_closes.append(long_closes[-1] * (1 + pair.leverage * move))
        inverse_closes.append(inverse_closes[-1] * (1 - pair.leverage * move))
    market = Market(underlying, DAYS, tuple(closes), (18.0,) * len(DAYS), (0.05,) * len(DAYS))
    return forms.PairData(pair, market, {}, prices.FundBars(pair.long_fund, DAYS[first:], tuple(long_closes[first:])),
                          prices.FundBars(pair.inverse_fund, DAYS[first:], tuple(inverse_closes[first:])), paid)


def study_data(names: tuple[str, ...] = ALL_PAIRS) -> dict[str, forms.PairData]:
    """The synthetic pairs: SPY's funds start 6 sessions later than the others."""
    return {name: pair_data(name, first=6 if name == "SPY" else 0) for name in names}


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
def run_study(nautilus_flag: bool = True, keys: tuple[str, ...] | None = None, names: tuple[str, ...] = ALL_PAIRS,
              capital: float = runner.CAPITAL, dropped: tuple[str, ...] = ()) -> dict:
    """The whole pipeline of run.py on the synthetic pairs, ledger only (computed once per argument set; the
    tests do not change the result). `nautilus_flag` is what the results document says about parity (the
    parity run itself is tested with the forms): a row with a priced trade gets a gap as if it had been
    booked on NautilusTrader. `names` = the pairs of the run; `dropped` = pairs reported as not loaded."""
    data = study_data(names)
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
            done[key] = runner.run_row(key, taken, data, starts, capital, nautilus=False)
    variance = metrics.trial_variance([metrics.daily_sharpe(done[key]["daily"]) for key in keys])
    stats = {key: metrics.row_stats(done[key]["daily"], done[key]["returns"], runner.N_TRIALS, variance) for key in keys}
    verdicts = metrics.verdicts(stats, al.gate_checks, OWNER.lower_bar)
    rows = []
    for key in keys:
        result = done[key]
        rows.append({**plan[key], "priced": result["priced"], "notPriced": result["notPriced"],
                     "staleDays": result["staleDays"],
                     "nautilusGap": 1e-16 if nautilus_flag and result["priced"] else None,
                     "seconds": result["seconds"], "stats": stats[key], "monthly": metrics.monthly_points(result["daily"]),
                     "verdict": verdicts[key],
                     "perPair": [{"underlying": name, "priced": item["priced"], "start": found[name].start[plan[key]["signal"]],
                                  "stats": metrics.row_stats(item["daily"], item["returns"], runner.N_TRIALS, variance)}
                                 for name, item in result["perPair"].items()]})
    return runner.document(
        rows=rows, found=found, data=data,
        dropped_pairs=[{"underlying": name, "reason": "OSError: no file"} for name in dropped], variance=variance,
        engine="nautilus-trader-1.227.0" if nautilus_flag else runner.engine_name(list(done.values())),
        nautilus=nautilus_flag, capital=capital, gate=al.GATE, lower_bar=OWNER.LOWER_BAR,
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
        data = study_data(("QQQ", "SPY"))
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
        data = study_data(("QQQ", "SPY"))
        found = {name: pair_signals(item) for name, item in data.items()}
        self.assertEqual((found["QQQ"].inputs_from, found["SPY"].inputs_from), (DAYS[0], DAYS[6]))
        self.assertEqual(runner.row_start(found, signals.S1), DAYS[0])
        self.assertEqual(runner.session_days(data, DAYS[6]), list(DAYS[6:]))
        self.assertGreater(min(item.day for item in found["SPY"].signals[signals.S1]["all"]), DAYS[6])

    def test_a_row_is_booked_pooled_and_per_pair(self):
        row = next(row for row in self.results["rows"] if row["key"] == "session-open-momentum/all/24h/lev-option")
        self.assertEqual(row["taken"], row["priced"] + sum(row["notPriced"].values()))
        self.assertEqual(row["stats"]["trades"] + row["stats"]["refused"], row["priced"])
        self.assertEqual([item["underlying"] for item in row["perPair"]], list(ALL_PAIRS))
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
        # All 40 rows, all 7 pairs, 100,000 USD and NautilusTrader booking: the one complete run.
        self.assertEqual((results["schema"], results["complete"], results["partial"], results["capital"]),
                         ("leveraged-etf-short-window-v1", True, [], 100_000.0))
        self.assertEqual(results["trials"]["count"], 40)
        self.assertEqual(len(results["rows"]), 40)
        self.assertEqual([pair["underlying"] for pair in results["pairs"]], list(ALL_PAIRS))
        self.assertEqual(results["pairs"][1]["inputsFrom"], DAYS[6])
        self.assertEqual(results["pairs"][0]["s2SignalsWithoutSession"], 2)
        # The funds follow the formula (on U's total return): no tracking error.
        self.assertEqual([item["fund"] for item in results["trackingError"]], list(pairs.fund_symbols()))
        self.assertTrue(all(item["p95AbsErrorPct"] < 1e-6 for item in results["trackingError"]))
        self.assertTrue(all(item["maxAbsErrorPct"] < 1e-6 for item in results["trackingError"]))
        # SPY's ex-dividend day: the formula without the dividend is 3 x dividend / previous close off.
        by_fund = {item["fund"]: item for item in results["trackingError"]}
        share = 1.5 / pair_data("SPY").market.close[EX_DIVIDEND_INDEX - 1] * 100
        self.assertEqual(by_fund["UPRO"]["exDividend"]["days"], 1)
        self.assertAlmostEqual(by_fund["UPRO"]["exDividend"]["medianErrorPct"], 0.0, places=9)
        self.assertAlmostEqual(by_fund["UPRO"]["exDividend"]["medianErrorNoDividendPct"],
                               -3 * share / (1 + 3 * (0.996 + share / 100 - 1)), places=6)
        self.assertGreater(by_fund["SPXU"]["exDividend"]["medianErrorNoDividendPct"], 0.8)
        self.assertIsNone(by_fund["TQQQ"]["exDividend"])
        for row in results["rows"]:
            self.assertEqual(len(row["verdict"]["gate"]["checks"]), GATE_NAMES)
            self.assertEqual(row["verdict"]["passes"], row["verdict"]["gate"]["pass"])
        self.assertEqual(results["passGate"], [row["key"] for row in results["rows"] if row["verdict"]["passes"]])
        json.dumps(results, allow_nan=False)  # JSON-ready: no NaN, no dataclass

    def test_a_run_with_fewer_rows_is_partial(self):
        partial = run_study(keys=tuple(key for key in runner.row_keys() if key.startswith("session-open-momentum/all/24h/")))
        self.assertEqual((partial["complete"], partial["partial"]), (False, ["5 of 40 form rows"]))
        self.assertIn("This is a PARTIAL run (5 of 40 form rows): a diagnostic, not the study result.",
                      report.results_markdown(partial))

    def test_a_run_on_two_pairs_is_partial_also_with_all_forty_rows(self):
        partial = run_study(names=("QQQ", "SPY"))
        self.assertEqual(len(partial["rows"]), 40)
        self.assertEqual(partial["droppedPairs"], [])
        self.assertEqual((partial["complete"], partial["partial"]), (False, ["2 of 7 pairs (QQQ, SPY)"]))
        self.assertIn("This is a PARTIAL run (2 of 7 pairs (QQQ, SPY)): a diagnostic, not the study result.",
                      report.results_markdown(partial))

    def test_a_dropped_pair_another_capital_or_a_ledger_only_run_is_partial(self):
        dropped = run_study(names=ALL_PAIRS[:-1], dropped=("USO",))
        self.assertEqual(dropped["partial"], ["dropped pairs: USO", "6 of 7 pairs (QQQ, SPY, IWM, DIA, GLD, SLV)"])
        capital = run_study(capital=50_000.0)
        self.assertEqual((capital["complete"], capital["partial"]), (False, ["start capital 50,000 USD, not 100,000"]))
        ledger_only = run_study(nautilus_flag=False)
        self.assertEqual((ledger_only["complete"], ledger_only["partial"]),
                         (False, ["ledger only, no NautilusTrader booking"]))
        for results in (dropped, capital, ledger_only):
            self.assertIn("This is a PARTIAL run (" + "; ".join(results["partial"]) + ")", report.results_markdown(results))

    def test_the_rule_of_a_complete_run(self):
        keys, names = runner.row_keys(), list(ALL_PAIRS)
        self.assertEqual(runner.partial_reasons(keys, names, [], 100_000.0, True), [])
        self.assertEqual(runner.partial_reasons(list(reversed(keys)), list(reversed(names)), [], 100_000, True), [])
        self.assertEqual(runner.partial_reasons(keys[:-1], names, [], 100_000.0, True), ["39 of 40 form rows"])
        self.assertEqual(runner.partial_reasons([*keys, "s3/all/24h/etf-option"], names, [], 100_000.0, True),
                         ["40 of 40 form rows"])  # a row outside the plan is not the study either
        self.assertEqual(runner.partial_reasons([*keys[:-1], keys[0]], names, [], 100_000.0, True), ["39 of 40 form rows"])
        self.assertEqual(runner.partial_reasons(keys, ["QQQ"], [], 100_000.0, True), ["1 of 7 pairs (QQQ)"])
        self.assertEqual(runner.partial_reasons(keys, [], [], 100_000.0, True), ["0 of 7 pairs (none)"])
        self.assertEqual(runner.partial_reasons(keys, names, [{"underlying": "SLV", "reason": "x"}], 100_000.0, True),
                         ["dropped pairs: SLV"])
        self.assertEqual(runner.partial_reasons(keys, names, [], 100_000.01, True),
                         ["start capital 100,000 USD, not 100,000"])
        self.assertEqual(runner.partial_reasons(keys, names, [], None, True), ["no start capital"])
        for flag in (False, None, 0):
            self.assertEqual(runner.partial_reasons(keys, names, [], 100_000.0, flag),
                             ["ledger only, no NautilusTrader booking"])
        self.assertEqual(len(runner.partial_reasons(keys[:3], ["QQQ"], [{"underlying": "SPY"}], 1.0, False)), 5)

    def test_the_engine_name_is_the_engine_that_booked_rows_with_trades(self):
        ledger, engine = "qc-ports-ledger", "nautilus-trader-1.227.0"
        booked = [{"engine": engine, "gap": 1e-12}, {"engine": ledger, "gap": None}, {"engine": engine, "gap": 0.0}]
        # A row without a priced trade is booked in the ledger only: it does not add the ledger to the name.
        self.assertEqual(runner.engine_name(booked), engine)
        self.assertEqual(runner.engine_name([{"engine": ledger, "gap": None}] * 2), ledger)
        empty = run_study(nautilus_flag=False)
        self.assertEqual(empty["engine"], ledger)

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
        self.assertIn("| n/a (n/a vs n/a) |", line)  # the twin row has no trade: no verdict, not a "no"

    def test_the_markdown_has_every_section(self):
        for heading in ("# Leveraged ETF short-window study: results", "## Form rows", "### Failed gate checks per row",
                        "### Signals, skips and refusals per row",
                        "## Data start per pair and signal", "## Tracking error of the synthetic fund price",
                        "## Measured IV ratio (not used by the model)", "## Every row per pair"):
            self.assertIn(heading, self.text)
        self.assertNotIn("PARTIAL run", self.text)
        ledger_only = report.results_markdown(run_study(nautilus_flag=False))
        self.assertIn("did NOT book on NautilusTrader", ledger_only)
        self.assertIn("PARTIAL run (ledger only, no NautilusTrader booking)", ledger_only)

    def test_the_text_says_which_rows_were_booked_on_nautilus(self):
        rows = self.results["rows"]
        booked = sum(1 for row in rows if row["nautilusGap"] is not None)
        self.assertEqual(booked, sum(1 for row in rows if row["priced"]))
        self.assertEqual(booked, 30)  # the 10 S2/calm rows have no signal
        self.assertIn("Every number is the qc-ports ledger's. 30 of 40 form rows have a priced trade: each was also "
                      "booked on NautilusTrader and matches the ledger (relative tolerance 1e-06). 10 form rows have no "
                      "priced trade: there was nothing to book, so they were not run on NautilusTrader.", self.text)
        self.assertNotIn("Every form row was booked", self.text)
        every = json.loads(json.dumps(self.results))
        for row in every["rows"]:
            row["nautilusGap"] = 0.0
        self.assertNotIn("nothing to book", report.results_markdown(every))
        self.assertIn("40 of 40 form rows have a priced trade", report.results_markdown(every))

    def test_the_tracking_error_table_shows_the_ex_dividend_days_before_and_after(self):
        lines = self.text.split("## Tracking error of the synthetic fund price")[1].split("## ")[0].splitlines()
        header = next(line for line in lines if line.startswith("| Fund |"))
        self.assertTrue(header.endswith("| Ex-dividend days | Ex-dividend median, no dividend % | Ex-dividend median, used % |"))
        cells = {line.split("|")[1].strip(): [cell.strip() for cell in line.strip("|").split("|")]
                 for line in lines if line.startswith("| ") and not line.startswith(("| Fund", "| ---"))}
        self.assertEqual(sorted(cells), sorted(pairs.fund_symbols()))
        by_fund = {item["fund"]: item["exDividend"] for item in self.results["trackingError"]}
        # Before (no dividend): the long fund too low, the inverse fund too high. After (used): no error.
        self.assertEqual(cells["UPRO"][-3:-1], ["1", f"{by_fund['UPRO']['medianErrorNoDividendPct']:.3f}"])
        self.assertEqual(cells["SPXU"][-3:-1], ["1", f"{by_fund['SPXU']['medianErrorNoDividendPct']:.3f}"])
        self.assertLess(float(cells["UPRO"][-2]), -0.8)
        self.assertGreater(float(cells["SPXU"][-2]), 0.8)
        self.assertEqual((abs(float(cells["UPRO"][-1])), abs(float(cells["SPXU"][-1]))), (0.0, 0.0))
        self.assertEqual(cells["TQQQ"][-3:], ["0", "n/a", "n/a"])
        self.assertEqual({len(row) for row in cells.values()}, {11})

    def test_the_leverage_helps_count_names_the_rows_without_a_verdict(self):
        unjudged = sum(1 for row in self.results["rows"] if row["verdict"]["leverageHelps"] is not None
                       and row["verdict"]["leverageHelps"]["helps"] is None)
        self.assertEqual(unjudged, 6)  # the lev rows of S2/calm: their twin rows have no trade
        self.assertIn("of 24 (6 without a verdict: the twin row has no booked trade).", self.text)
        self.assertTrue(all("no verdict" not in key for key in self.results["leverageHelps"]))

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
        # The ledger is the result, NautilusTrader the cross-check; the ledger is named once.
        self.assertEqual(doc["provenance"]["engine"], "qc-ports ledger, cross-check nautilus-trader-1.227.0")
        description = doc["forms"][0]["description"]
        self.assertIn("Every number is the qc-ports ledger's; NautilusTrader books the same trades as a cross-check",
                      description)
        self.assertIn("7 pairs pooled", description)
        self.assertNotIn("booked by NautilusTrader", description)

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

    GATE_CHECK = "Allocation gate: at least one lev row passes (the study verdict)"
    BAR_CHECK = "Owner's lower bar, per form row (not part of the verdict)"

    def test_robustness_rows_name_parity_gate_and_tracking_error(self):
        checks = {row["check"]: row for row in self.doc["robustness"]}
        parity = checks["NautilusTrader books every form row with a priced trade like the ledger"]
        self.assertTrue(parity["pass"])
        self.assertIn("30 of 40 rows have a priced trade and were booked on NautilusTrader", parity["result"])
        self.assertIn("10 rows have no priced trade and were not booked there.", parity["result"])
        self.assertIn(self.GATE_CHECK, checks)
        error = checks["Synthetic fund entry price: error of the formula at the close"]
        self.assertIsNone(error["pass"])
        self.assertIn("ETF ex-dividend days: median signed error up to", error["result"])
        self.assertIn("without the dividend, at most 0.00% in size with it (the formula used).", error["result"])
        self.assertIn("0.99 (QQQ)", checks["Measured fund ATM IV / (leverage x ETF ATM IV), one chain read"]["result"])
        self.assertTrue(all(len(row["result"]) <= 300 for row in self.doc["robustness"]))
        self.assertTrue(all(not row["result"].endswith("...") for row in self.doc["robustness"]))  # nothing is cut

    def robustness_with(self, passing: tuple[str, ...], bar: tuple[str, ...] = ()) -> dict:
        """The robustness rows of the results with exactly the rows `passing` passing the gate and the
        rows `bar` passing the owner's lower bar."""
        changed = json.loads(json.dumps(self.results))
        for row in changed["rows"]:
            row["verdict"]["passes"] = row["verdict"]["gate"]["pass"] = row["key"] in passing
            row["verdict"]["lowerBar"]["pass"] = row["key"] in bar
        changed["passGate"] = [row["key"] for row in changed["rows"] if row["verdict"]["passes"]]
        changed["passLowerBar"] = [row["key"] for row in changed["rows"] if row["verdict"]["lowerBar"]["pass"]]
        doc = study.document(changed, "2026-11-11")
        self.assertEqual(study.validate(doc), [])
        return {"verdict": doc["verdict"], **{row["check"]: row for row in doc["robustness"]}}

    def test_one_passing_etf_option_row_is_not_a_pass_of_the_robustness_rows(self):
        etf, lev = "session-open-momentum/all/24h/etf-option", "session-open-momentum/all/48h/lev-shares"
        none = self.robustness_with(())
        self.assertEqual((none["verdict"], none[self.GATE_CHECK]["pass"], none[self.BAR_CHECK]["pass"]),
                         ("no-edge", False, None))
        # 1 of 40 rows passes the gate and the lower bar, and it is an unleveraged row.
        one = self.robustness_with((etf,), bar=(etf,))
        self.assertEqual(one["verdict"], "no-edge")
        self.assertIs(one[self.GATE_CHECK]["pass"], False)
        self.assertEqual(one[self.GATE_CHECK]["result"], "0 of 24 lev rows pass every check; 1 of all 40 rows.")
        self.assertIsNone(one[self.BAR_CHECK]["pass"])  # never a pass or a fail: the count is in the text
        self.assertTrue(one[self.BAR_CHECK]["result"].startswith("1 of 40 rows pass (Sharpe >= 0.3"))
        # A lev row passes: the row and the verdict change together.
        both = self.robustness_with((etf, lev), bar=(etf, lev))
        self.assertEqual((both["verdict"], both[self.GATE_CHECK]["pass"]), ("edge", True))
        self.assertEqual(both[self.GATE_CHECK]["result"], "1 of 24 lev rows pass every check; 2 of all 40 rows.")
        self.assertIsNone(both[self.BAR_CHECK]["pass"])

    def test_a_partial_or_ledger_only_run_gives_no_document(self):
        with self.assertRaisesRegex(ValueError, "This run is partial: the results document says it is not complete"):
            study.document({**self.results, "complete": False}, "2026-11-11")
        with self.assertRaisesRegex(ValueError, "ledger only, no NautilusTrader booking"):
            study.document({**self.results, "nautilusParity": False}, "2026-11-11")
        with self.assertRaisesRegex(ValueError, "start capital 50,000 USD, not 100,000"):
            study.document({**self.results, "capital": 50_000.0}, "2026-11-11")
        with self.assertRaisesRegex(ValueError, "dropped pairs: USO"):
            study.document({**self.results, "droppedPairs": [{"underlying": "USO", "reason": "x"}]}, "2026-11-11")
        with self.assertRaisesRegex(ValueError, "39 of 40 form rows"):
            study.document({**self.results, "rows": self.results["rows"][:-1]}, "2026-11-11")

    def test_every_partial_run_of_the_pipeline_is_refused(self):
        for results, reason in ((run_study(names=("QQQ", "SPY")), r"2 of 7 pairs \(QQQ, SPY\)"),
                                (run_study(nautilus_flag=False), "ledger only"),
                                (run_study(capital=50_000.0), "start capital 50,000 USD"),
                                (run_study(names=ALL_PAIRS[:-1], dropped=("USO",)), "dropped pairs: USO")):
            with self.assertRaisesRegex(ValueError, "The study document needs the complete run .* This run is partial: .*"
                                        + reason):
                study.document(results, "2026-11-11")

    def test_a_complete_flag_alone_is_not_trusted(self):
        # A two-pair results document that claims to be complete (as run.py wrote it before the rule).
        forged = {**run_study(names=("QQQ", "SPY")), "complete": True, "partial": []}
        with self.assertRaisesRegex(ValueError, "2 of 7 pairs"):
            study.document(forged, "2026-11-11")

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
            path.write_text(json.dumps(run_study(names=("QQQ", "SPY"))))
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = cli.main(["study", "--results", str(path), "--ran", "2026-11-11"])
            self.assertEqual((code, out.getvalue()), (1, ""))
            self.assertIn("This run is partial: 2 of 7 pairs (QQQ, SPY)", err.getvalue())

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


class RunScript(unittest.TestCase):
    """The pure parts of research/backtests/leveraged-etf/run.py."""

    BASE = ["--data", "data", "--out", "out.json"]

    def planned(self, *flags: str):
        return run_script.planned(run_script.arguments([*self.BASE, *flags]))

    def test_without_a_pattern_every_form_row_is_wanted(self):
        self.assertEqual(run_script.wanted_rows(None), runner.row_keys())
        self.assertEqual(run_script.wanted_rows([]), runner.row_keys())

    def test_a_pattern_picks_its_rows_and_the_rows_their_verdicts_read(self):
        prefix = "session-open-momentum/all/24h/"
        # lev-vertical: its baseline etf-option and its twin etf-vertical come with it, in report order.
        self.assertEqual(run_script.wanted_rows([prefix + "lev-vertical"]),
                         [prefix + "etf-option", prefix + "etf-vertical", prefix + "lev-vertical"])
        # lev-shares: baseline and twin are both etf-option.
        self.assertEqual(run_script.wanted_rows([prefix + "lev-shares"]), [prefix + "etf-option", prefix + "lev-shares"])
        self.assertEqual(run_script.wanted_rows([prefix + "etf-option"]), [prefix + "etf-option"])
        self.assertEqual(run_script.wanted_rows([prefix + "etf-vertical"]), [prefix + "etf-option", prefix + "etf-vertical"])
        self.assertEqual(run_script.wanted_rows([prefix + "*"]), [key for key in runner.row_keys() if key.startswith(prefix)])
        both = run_script.wanted_rows(["*/calm/48h/lev-option", "volume-spike-breakout/all/24h/etf-option"])
        self.assertEqual(both, ["session-open-momentum/calm/48h/etf-option", "session-open-momentum/calm/48h/lev-option",
                                "volume-spike-breakout/all/24h/etf-option", "volume-spike-breakout/calm/48h/etf-option",
                                "volume-spike-breakout/calm/48h/lev-option"])
        self.assertEqual(run_script.wanted_rows(["*"]), runner.row_keys())

    def test_the_wanted_rows_always_have_a_verdict(self):
        for pattern in ("*/lev-shares", "*/calm/*/lev-vertical", "volume-spike-breakout/*"):
            keys = run_script.wanted_rows([pattern])
            stats = {key: {"trades": 0, "sharpe": None, "oosSharpe": None, "deflatedSharpe": None, "maxDrawdown": 0.0,
                           "monteCarlo": None} for key in keys}
            self.assertEqual(sorted(metrics.verdicts(stats, al.gate_checks, OWNER.lower_bar)), sorted(keys))

    def test_a_pattern_without_a_row_stops_the_run(self):
        with self.assertRaises(SystemExit) as stopped:
            run_script.wanted_rows(["session-open-momentum/all/72h/*"])
        self.assertIn("--only matches no form row", str(stopped.exception))

    def test_the_pairs_of_a_run(self):
        self.assertEqual(run_script.pair_names(None), list(ALL_PAIRS))
        self.assertEqual(run_script.pair_names(" spy, QQQ ,"), ["QQQ", "SPY"])  # table order, any case
        for bad in ("QQQ,TQQQ", ","):
            with self.assertRaises(SystemExit):
                run_script.pair_names(bad)

    def test_the_default_flags_plan_the_complete_run(self):
        keys, names, nautilus, partial = self.planned()
        self.assertEqual((keys, names, nautilus, partial), (runner.row_keys(), list(ALL_PAIRS), True, []))
        self.assertEqual(run_script.arguments(self.BASE).capital, runner.CAPITAL)

    def test_every_diagnostic_flag_plans_a_partial_run(self):
        self.assertEqual(self.planned("--pairs", "QQQ")[1:], (["QQQ"], True, ["1 of 7 pairs (QQQ)"]))
        self.assertEqual(self.planned("--pairs", "QQQ,SPY,IWM,DIA,GLD,SLV")[3], ["6 of 7 pairs (QQQ, SPY, IWM, DIA, GLD, SLV)"])
        self.assertEqual(self.planned("--no-nautilus")[2:], (False, ["ledger only, no NautilusTrader booking"]))
        self.assertEqual(self.planned("--only", "session-open-momentum/all/24h/*")[3], ["5 of 40 form rows"])
        self.assertEqual(self.planned("--capital", "250000")[3], ["start capital 250,000 USD, not 100,000"])
        self.assertEqual(self.planned("--only", "*/lev-shares", "--pairs", "USO", "--no-nautilus", "--capital", "1000")[3],
                         ["16 of 40 form rows", "1 of 7 pairs (USO)", "start capital 1,000 USD, not 100,000",
                          "ledger only, no NautilusTrader booking"])
        # Naming every pair, every row and the default capital is the complete run again.
        self.assertEqual(self.planned("--pairs", ",".join(reversed(ALL_PAIRS)), "--only", "*", "--capital", "100000")[3], [])

    def test_the_lower_bar_is_the_owners_function_of_the_allocation_study(self):
        self.assertEqual(OWNER.LOWER_BAR, {"minSharpe": 0.3, "minOosSharpe": 0.0, "minMonteCarloProfit": 0.8,
                                           "maxDrawdown": -0.25, "minTrades": 30})
        self.assertEqual(Path(OWNER.__file__).name, "funded_pie.py")
        self.assertEqual(self.results_lower_bar(), OWNER.LOWER_BAR)
        good = {"sharpe": 0.3, "oosSharpe": 0.01, "monteCarlo": {"probabilityOfProfit": 0.8}, "maxDrawdown": -0.25,
                "trades": 30}
        self.assertTrue(OWNER.lower_bar(good))
        self.assertFalse(OWNER.lower_bar({**good, "trades": 29}))

    @staticmethod
    def results_lower_bar() -> dict:
        return run_study()["lowerBar"]

    def test_loading_the_script_runs_nothing_and_keeps_the_module_names(self):
        import sys

        self.assertNotIn("funded_pie", sys.modules)
        self.assertTrue(callable(run_script.main))
        self.assertIs(run_script.runner, runner)


if __name__ == "__main__":
    unittest.main()
