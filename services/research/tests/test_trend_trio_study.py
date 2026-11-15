"""Trend Trio study driver (strategies/trend_trio/study.py, document.py, report.py): synthetic data only.

Variant list, ledger arithmetic, per-year and drawdown sums, the session filter, the walk-forward pick, seeded
bootstrap and random-entry control, the job files (resume) and an end-to-end assemble -> document -> report run
on a three-session synthetic series. No network, broker or rig data.
"""
from __future__ import annotations

import importlib.util
import json
import math
import random
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from strategies import noise_band_futures_run as nbf
from strategies.trend_trio import document, report, rules, study
from strategies.trend_trio.rules import Params, Trade

DAYS = ("2024-02-28", "2024-02-29", "2024-03-01")
SHORT = Params(st_length=5, uma_length=8, at_length=6, ce_length=10, sling_fast=8, sling_slow=13)


def synthetic_rows(days=DAYS, seed: int = 3, bar_minutes: int = 1) -> list[tuple[int, tuple]]:
    """1-minute bars of whole regular sessions: a noisy wave (three swings a day), prices to 2 decimals."""
    rng = random.Random(seed)
    rows: list[tuple[int, tuple]] = []
    price = 18_000.0
    for day in days:
        start = study._open_ms(date.fromisoformat(day))
        count = 390 // bar_minutes
        for k in range(count):
            drift = 200 * math.sin(2 * math.pi * 3 * k / count) / count * bar_minutes
            o = price
            c = o + drift + rng.gauss(0, 3 * math.sqrt(bar_minutes))
            h, low = max(o, c) + abs(rng.gauss(0, 1)), min(o, c) - abs(rng.gauss(0, 1))
            rows.append((start + k * bar_minutes * study.MINUTE_MS,
                         (round(o, 2), round(h, 2), round(low, 2), round(c, 2), float(rng.randint(5, 50)))))
            price = c
    return rows


def synthetic_minutes(days=DAYS, seed: int = 3) -> rules.Minutes:
    minutes, _ = study.rth_minutes(synthetic_rows(days, seed))
    return minutes


def trade(session: int = 0, points: float = 1.0, side: int = 1) -> Trade:
    return Trade(session, side, 1, 2, 100.0, 100.0 + side * points, "chandelier", points)


# --- variants and jobs ---------------------------------------------------------------------------------

def test_variants_are_the_33_rows_of_the_design_in_order():
    rows = [v.row for v in study.VARIANTS]
    assert len(rows) == 33 == study.N_TRIALS
    assert rows == ["P1", "P2", "P3", *(f"V{n}" for n in range(1, 9)), *(f"S{n}" for n in range(1, 23))]
    assert study.BY_ROW["P1"].params == Params()
    assert study.BY_ROW["P3"].dataset == "b" and study.BY_ROW["P3"].params.signal_minutes == 15
    assert all(v.dataset == "a" for v in study.VARIANTS if v.row != "P3")
    assert study.BY_ROW["V8"].params.full_session and study.BY_ROW["V1"].params.entry == "reentry"


def test_sensitivity_values_are_default_times_0_7_and_1_4():
    stepped = {"uma_smoothing": (1, 3), "entry_end_minute": (370, 385)}
    for label, name, low, high in study.SENSITIVITY:
        default = getattr(Params(), name)
        if name in stepped:
            assert (low, high) == stepped[name], label
            continue
        digits = 0 if isinstance(default, int) else 1
        assert (low, high) == (round(default * 0.7, digits), round(default * 1.4, digits)), label
    assert study.BY_ROW["S1"].params.st_length == 7 and study.BY_ROW["S22"].params.entry_end_minute == 385
    assert study.BY_ROW["S21"].change == "Entry window end 15:40"


def test_jobs_tiers_and_names():
    jobs = study.jobs()
    graded = [job for job in jobs if job.graded]
    assert len(graded) == 33
    assert [job.name for job in jobs if job.tier == 1] == ["P1-a", "P2-a", "P3-b"]
    assert len([job for job in jobs if job.tier == 2]) == 8 and len([job for job in jobs if job.tier == 3]) == 22
    tier4 = [job.name for job in jobs if job.tier == 4]
    assert tier4 == ["LA-a", "BR-a5", "NQ-c", "random-P1-a", "nautilus-P1-a", "nautilus-P2-a", "nautilus-P3-b",
                     "mfi-MFI-a5c"]


# --- booking -------------------------------------------------------------------------------------------

def test_ledger_arithmetic():
    one = trade(points=1.0)
    assert study.ledger([one], 0) == [20.0 - 4.50]
    # 1 tick per side = $10 per round trip plus $4.50 fees.
    assert study.ledger([one], 1) == [20.0 - 4.50 - 10.0]
    assert study.ledger([one], 2) == [20.0 - 4.50 - 20.0]
    assert study.ledger([trade(points=-2.5, side=-1)], 1) == [-50.0 - 14.50]


def test_session_pnl_counts_sessions_without_trades_as_zero():
    pnl = study.session_pnl([trade(0, 1.0), trade(0, 2.0), trade(2, -1.0)], 4, 0)
    assert pnl == [15.5 + 35.5, 0.0, -24.5, 0.0]


def test_per_year_drawdown_and_full_years_by_hand():
    days = ["2012-12-31", "2013-01-02", "2013-06-03", "2013-12-31", "2014-01-02"]
    pnl = [5.0, 10.0, -30.0, 15.0, -2.0]
    assert study.per_year(days, pnl) == {2012: 5.0, 2013: -5.0, 2014: -2.0}
    # Equity 5, 15, -15, 0, -2: peak 15, trough -15.
    assert study.max_drawdown(pnl) == 30.0
    assert study.full_years(days) == [2013]


def test_time_in_market_and_capital_curve():
    records = [{"entryMinute": 10, "exitMinute": 40}, {"entryMinute": 100, "exitMinute": 390}]
    assert study.time_in_market(records, 780) == pytest.approx(320 / 780)
    curve = study.capital_curve(["2024-01-02", "2024-01-03", "2024-02-01"], [1_000.0, -2_000.0, 500.0])
    assert curve["maxDrawdown"] == pytest.approx(99_000 / 101_000 - 1)
    assert [point["month"] for point in curve["months"]] == ["2024-01", "2024-02"]
    assert curve["months"][-1]["value"] == pytest.approx(-0.005)


# --- data ----------------------------------------------------------------------------------------------

def test_session_filter_early_close_closed_day_and_short_session():
    days = ("2024-07-03", "2024-07-04", "2024-07-05")  # early close, holiday, normal
    rows = synthetic_rows(days)
    short = [row for row in synthetic_rows(("2024-07-08",)) if row[0] < study._open_ms(date(2024, 7, 8)) + 149 * 60_000]
    minutes, info = study.rth_minutes(rows + short)
    assert minutes.day == ["2024-07-03", "2024-07-05"]
    assert minutes.close_minute == [210, 390]
    assert sum(1 for s in minutes.session if s == 0) == 210
    assert info["dropped"] == 1 and info["droppedDays"] == ["2024-07-08"]


def test_aggregate_and_partial_buckets():
    rows = synthetic_rows(DAYS[:1])
    missing = study._open_ms(date.fromisoformat(DAYS[0])) + 31 * 60_000  # 10:01
    minutes, _ = study.rth_minutes([row for row in rows if row[0] != missing])
    assert study.bucket_gaps(minutes, 5) == 1 and study.bucket_gaps(minutes, 15) == 1
    five = study.aggregate_minutes(minutes, 5)
    assert len(five.t) == 78 and five.bar_ms == 5 * study.MINUTE_MS
    assert five.minute[:3] == array_slice([0, 5, 10])
    assert five.o[0] == minutes.o[0] and five.c[0] == minutes.c[4]
    assert five.h[0] == max(minutes.h[:5]) and five.v[0] == sum(minutes.v[:5])


def array_slice(values):
    from array import array
    return array("l", values)


# --- tests and diagnostics -----------------------------------------------------------------------------

def test_walk_forward_picks_the_best_training_row():
    net = {"P1": {2013: 10.0, 2014: 10.0, 2015: 10.0, 2016: -5.0, 2017: 1.0},
           "V1": {2013: 0.0, 2014: 0.0, 2015: 40.0, 2016: 7.0, 2017: -3.0}}
    wf = study.walk_forward(net, [2013, 2014, 2015, 2016, 2017])
    assert [(f["year"], f["pick"]) for f in wf["folds"]] == [(2016, "V1"), (2017, "V1")]
    assert wf["stitchedNet"] == 4.0
    assert study.walk_forward(net, [2013, 2014])["stitchedNet"] is None


def test_bootstrap_is_reproducible_with_seed_7():
    rng = random.Random(1)
    values = [rng.gauss(0, 1) for _ in range(50)]
    assert nbf.bootstrap_ci(values, 2_000, 7) == nbf.bootstrap_ci(values, 2_000, 7)
    assert nbf.bootstrap_ci(values, 2_000, 7) != nbf.bootstrap_ci(values, 2_000, 8)


def test_random_control_is_reproducible_and_moves_trades_to_other_sessions():
    m = synthetic_minutes()
    records = study.trades_payload(m, SHORT)["trades"]
    assert records
    first = study.random_control(m, records, seed=7, draws=200)
    assert first == study.random_control(m, records, seed=7, draws=200)
    assert first["p95"] != study.random_control(m, records, seed=8, draws=200)["p95"]
    assert first["actual"] == pytest.approx(sum(study.ledger([study.trade_of(r) for r in records], 1)) / len(records))


def test_outcome_first_failing_test_decides():
    tests = [{"id": f"T{n}", "pass": n != 3 and n != 5} for n in range(1, 8)]
    assert study.outcome_of(tests) == ("reconstruction failed", "T3")
    assert study.outcome_of([{"id": "T1", "pass": True}]) == ("reconstruction passed", None)
    assert study.outcome_of([{"id": "T1", "pass": None}]) == ("reconstruction failed", "T1")


# --- jobs, assemble, document, report --------------------------------------------------------------------

MANIFEST = [{"path": "/data/x.csv", "bytes": 3, "sha256": "ab" * 32}]
STAMP = study.stamp_of("a" * 40, MANIFEST)
RUN_PY = Path(__file__).resolve().parents[3] / "research" / "backtests" / "trend-trio" / "run.py"


def run_module():
    spec = importlib.util.spec_from_file_location("trend_trio_run", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic_datasets(stamp=STAMP) -> study.Datasets:
    a = synthetic_minutes()
    a5 = study.aggregate_minutes(a, 5)
    return study.Datasets({"a": a, "a5": a5, "b": a5, "c": a5, "a_full": None},
                          {"a": {"sessions": 3}, "a_full": {"status": "not run", "reason": "Q-ETH: test"}}, (),
                          stamp)


def synthetic_info(stamp=STAMP) -> dict:
    return {"datasets": {"a": {"sessions": 3, "spreadMedianPoints": 1.2}, "a_full": {"status": "not run"}},
            "files": MANIFEST, "stamp": dict(stamp)}


def write_nautilus(out_dir, data: study.Datasets, same: dict[str, bool]) -> None:
    """Stored NautilusTrader check files (the engine check itself is test_trend_trio_nautilus.py)."""
    by_name = {job.name: job for job in study.jobs()}
    for row, ok in same.items():
        name = f"nautilus-{row}-{study.BY_ROW[row].dataset}"
        payload = {**study._job_header(by_name[name], data.stamp), "status": "ran",
                   "engine": "nautilus-trader-1.227.0", "same": ok, "trades": 1, "booked": 1}
        (out_dir / f"{name}.json").write_text(json.dumps(payload))


def run_all(out_dir, monkeypatch, data: study.Datasets) -> None:
    for job in fast_jobs(monkeypatch):
        study.run_job(job, out_dir, data)


def fast_jobs(monkeypatch) -> list[study.Job]:
    """The study's jobs with short indicator lengths (so three sessions trade) and 100 random draws."""
    monkeypatch.setattr(study, "DRAWS", 100)
    variants = tuple(replace(v, params=replace(v.params, **{k: getattr(SHORT, k) for k in (
        "st_length", "uma_length", "at_length", "ce_length", "sling_fast", "sling_slow")})) for v in study.VARIANTS)
    monkeypatch.setattr(study, "VARIANTS", variants)
    monkeypatch.setattr(study, "BY_ROW", {v.row: v for v in variants})
    return [job for job in study.jobs() if job.kind != "nautilus"]


def test_run_job_writes_one_file_and_resumes(tmp_path):
    data = synthetic_datasets()
    job = study.Job("trades", "P1", "a", SHORT, 1)
    first = study.run_job(job, tmp_path, data)
    stored = json.loads((tmp_path / "P1-a.json").read_text())
    assert not first["skipped"] and stored["status"] == "ran" and stored["paramsKey"] == SHORT.key()
    assert stored["sessions"] == 3 and stored["trades"]
    assert study.run_job(job, tmp_path, data)["skipped"]
    assert not study.run_job(replace(job, params=replace(SHORT, ce_length=12)), tmp_path, data)["skipped"]
    v8 = study.run_job(study.Job("trades", "V8", "a", replace(SHORT, full_session=True), 2), tmp_path, data)
    assert v8["status"] == "not run"


def test_job_file_of_another_commit_or_data_is_not_reused(tmp_path, monkeypatch):
    data = synthetic_datasets()
    job = study.Job("trades", "P1", "a", SHORT, 1)
    study.run_job(job, tmp_path, data)
    stored = json.loads((tmp_path / "P1-a.json").read_text())
    assert (stored["commit"], stored["dataSha256"]) == (STAMP["commit"], STAMP["dataSha256"])
    assert study.run_job(job, tmp_path, data)["skipped"]
    other_commit = synthetic_datasets(study.stamp_of("b" * 40, MANIFEST))
    assert not study.run_job(job, tmp_path, other_commit)["skipped"]
    other_data = synthetic_datasets(study.stamp_of("b" * 40, [{**MANIFEST[0], "sha256": "cd" * 32}]))
    assert not study.run_job(job, tmp_path, other_data)["skipped"]
    assert study.stamp_of("b" * 40, MANIFEST, (2024, 2024)) != study.stamp_of("b" * 40, MANIFEST)
    # assemble treats a job file of another stamp as missing.
    run_all(tmp_path, monkeypatch, data)
    fresh = study.assemble(tmp_path, synthetic_info())
    assert next(r for r in fresh["rows"] if r["row"] == "P1")["status"] == "ran"
    stale = study.assemble(tmp_path, synthetic_info(study.stamp_of("c" * 40, MANIFEST)))
    assert next(r for r in stale["rows"] if r["row"] == "P1")["status"] == "missing"
    assert stale["trials"]["ran"] == 0
    assert stale["diagnostics"]["randomControl"] is None


def test_assemble_document_and_report_end_to_end(tmp_path, monkeypatch):
    data = synthetic_datasets()
    run_all(tmp_path, monkeypatch, data)
    write_nautilus(tmp_path, data, {"P1": True, "P2": False})  # P3: no file, so "not run"
    results = study.assemble(tmp_path, synthetic_info())
    assert [t["id"] for t in results["tests"]] == [f"T{n}" for n in range(1, 8)]
    assert results["outcome"] == "reconstruction failed"  # three sessions: no full year, no walk-forward
    assert results["decidingTest"] is not None
    assert results["trials"] == {"n": 33, "ran": 32}  # V8 not run (Q-ETH), still counted in N
    assert next(r for r in results["rows"] if r["row"] == "V8")["status"] == "not run"
    p1 = next(r for r in results["rows"] if r["row"] == "P1")
    assert p1["stats"]["1"]["netUsd"] == pytest.approx(p1["stats"]["0"]["netUsd"] - 10 * p1["stats"]["0"]["trades"])
    assert results["diagnostics"]["randomControl"]["draws"] == 100
    json.dumps(results, allow_nan=False)

    results["provenance"] = {"commit": "a" * 40, "dirtyFiles": [], "ran": "2026-11-14"}
    doc = document.study_document(results)
    assert doc["id"] == "trend-trio" and doc["spec"] == "docs/specs/strategies/trend-trio.md"
    assert doc["verdict"] in ("no-edge", "needs-more-data")
    assert doc["provenance"]["engine"] == "nautilus_trader 1.227.0"
    nautilus = "fill prices vs the rule module: P1 same, P2 NOT the same, P3 not run."
    assert nautilus in doc["notes"] and nautilus in doc["forms"][0]["description"]
    check = next(item for item in doc["robustness"] if item["check"].startswith("NautilusTrader"))
    assert check["pass"] is False and "P2 NOT the same" in check["result"]
    assert "P1 (a) net per year" in doc["notes"] and "$100,000" in doc["notes"]
    assert len(doc["equity"]) >= 2 and len(doc["robustness"]) <= 20
    assert all(run["maxDrawdown"] <= 0 and 0 <= run["exposure"] <= 1 for run in doc["forms"][0]["runs"])
    json.dumps(doc, allow_nan=False)
    results["provenance"]["dirtyFiles"] = ["M services/research/x.py"]
    with pytest.raises(ValueError):
        document.study_document(results)

    html = report.render(results)
    assert html.startswith("<!doctype html>") and "http://" not in html and "<script" not in html
    assert "<link" not in html and "src=" not in html
    assert "16 of 16" in html and "rules guessed; this tests a reconstruction" in html.lower()
    for text in ("T1", "T7", "Costs", "Variants", "Options form", "Indicators added", "Limits", "<svg"):
        assert text in html


def test_verdict_mapping():
    def results(outcome: str, trades: int) -> dict:
        return {"outcome": outcome, "rows": [{"row": "P1", "status": "ran", "stats": {"1": {"trades": trades}}}]}
    assert document.verdict_of(results("reconstruction passed", 100)) == "edge"
    assert document.verdict_of(results("reconstruction failed", 100)) == "no-edge"
    assert document.verdict_of(results("reconstruction failed", 5)) == "needs-more-data"


def test_blocked_run_writes_no_study_document(tmp_path, monkeypatch):
    run = run_module()
    data = synthetic_datasets()
    run_all(tmp_path, monkeypatch, data)
    write_nautilus(tmp_path, data, {"P1": True, "P2": True, "P3": True})
    blocked = {"tier": 3, "projectedCoreHours": 9.5, "jobs": ["S1-a"]}
    provenance = {"commit": "a" * 40, "dirtyFiles": [], "ran": "2026-11-14"}
    results = run.finish(tmp_path, synthetic_info(), provenance, False, blocked)
    assert results["outcome"] == "blocked" and results["decidingTest"] is None and results["blocked"] == blocked
    assert not (tmp_path / "study.json").exists()
    assert json.loads((tmp_path / "results.json").read_text())["outcome"] == "blocked"
    assert "blocked" in (tmp_path / "index.html").read_text()
    with pytest.raises(ValueError):
        document.study_document(results)
    done = run.finish(tmp_path, synthetic_info(), provenance, False, None)
    assert done["outcome"] == "reconstruction failed" and (tmp_path / "study.json").exists()


def test_projection_scales_each_job_by_its_own_dataset(tmp_path):
    run = run_module()
    for name in ("P1-a", "P3-b", "NQ-c", "mfi-MFI-a5c"):
        (tmp_path / f"{name}.json").write_text(json.dumps({"seconds": 36.0}))
    pilot = {"datasets": {"a": {"sessions": 10}, "b": {"sessions": 20}, "c": {"sessions": 5}}}
    full = {"datasets": {"a": {"sessions": 100}, "b": {"sessions": 400}, "c": {"sessions": 5}}}
    project = run.pilot_projection(tmp_path, pilot, full)
    jobs = {job.name: job for job in study.jobs()}
    assert project([jobs["P1-a"]]) == pytest.approx(36 * 10 / 3600)
    assert project([jobs["P3-b"]]) == pytest.approx(36 * 20 / 3600)
    assert project([jobs["NQ-c"]]) == pytest.approx(36 / 3600)
    assert project([jobs["mfi-MFI-a5c"], jobs["P1-a"]]) == pytest.approx(2 * 36 * 10 / 3600)
