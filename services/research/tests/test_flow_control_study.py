"""Options-side continuation study: ledger, split, trials, statistics, verdict, checks, document, report and runner.

Synthetic data only; the base run has no nautilus-trader, so document tests run the study with nautilus=False and
then store a NautilusTrader check result (the engine check itself is test_flow_control_nautilus.py).
"""
from __future__ import annotations

import importlib.util
import json
import math
from datetime import date, timedelta
from pathlib import Path

import pytest

from strategies.flow_control import data, document, report, rules, study
from strategies.flow_control.control import DriftMinute
from strategies.flow_control.data import Loaded, TickerSession
from strategies.flow_control.rules import BARS, Trade
from strategies.imom.data import is_closed, ms_at

from .test_flow_control_options import market

REPO = Path(__file__).resolve().parents[3]
RUN_PY = REPO / "research" / "backtests" / "flow-control-continuation" / "run.py"
GOLDEN = json.loads((REPO / "packages" / "api" / "src" / "fixtures" / "flow-control-golden.fixture.json").read_text())
NAUTILUS_RAN = {"status": "ran", "engine": "nautilus-trader-1.227.0", "trades": 1, "booked": 1, "same": True,
                "mismatches": [], "optionsMaxGap": 0.0}


def run_module():
    spec = importlib.util.spec_from_file_location("flow_control_run", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trading_days(first: str, n: int) -> list[str]:
    out, d = [], date.fromisoformat(first)
    while len(out) < n:
        if d.weekday() < 5 and not is_closed(d):
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def ticker_session(ticker: str, day: str, side: int, base: float) -> TickerSession:
    call, put = (100.0, 0.0) if side > 0 else (0.0, 100.0)
    minutes = tuple(DriftMinute(m, call, put) for m in range(390))
    price = tuple(base * (1 + side * 0.0001 * b) for b in range(BARS))
    return TickerSession(ticker, day, minutes, price, False, ())


def synthetic_loaded(n: int = 40, first: str = "2025-05-01") -> Loaded:
    days = trading_days(first, n)
    bases = {"SPX": 5000.0, "SPY": 500.0, "QQQ": 450.0, "NDX": 20000.0}
    sessions = {day: {t: ticker_session(t, day, 1 if i % 3 else -1, bases[t]) for t in data.TICKERS}
                for i, day in enumerate(days)}
    return Loaded(tuple(days), sessions, ({"day": "2025-04-30", "ticker": "SPY", "reason": "thin"},), 1, 0, ())


def markets():
    return {"SPY": market("SPY", "2025-04-01", "2025-08-30"), "QQQ": market("QQQ", "2025-04-01", "2025-08-30")}


@pytest.fixture(scope="module")
def results():
    out = study.run(synthetic_loaded(), Path("/nonexistent"), markets=markets(), nautilus=False)
    out["diagnostics"]["nautilus"] = dict(NAUTILUS_RAN)
    out["provenance"] = {"commit": "a" * 40, "dirtyFiles": [], "ran": "2026-11-15", "specSha256": rules.SPEC_SHA256,
                         "seconds": 1}
    return out


# --- ledger and split ---------------------------------------------------------------------------------------------

def test_ledger_arithmetic_for_es_and_nq_at_0_1_2_ticks():
    trade = Trade("2025-06-03", 1, 16, 100, 5000.0, 5010.0, "state", 10.0)
    assert [study.trade_net(trade, "ES", t) for t in (0, 1, 2)] == [495.5, 470.5, 445.5]
    assert [study.trade_net(trade, "NQ", t) for t in (0, 1, 2)] == [195.5, 185.5, 175.5]


def test_session_pnl_counts_sessions_without_trades_as_zero():
    trade = Trade("2025-06-04", -1, 16, 100, 5000.0, 4990.0, "state", 10.0)
    assert study.session_pnl([trade], ["2025-06-03", "2025-06-04"], "ES", 0) == [0.0, 495.5]


def test_split_60_20_20_with_two_gaps_of_five():
    days = trading_days("2025-01-02", 110)
    split = study.split_sessions(days)
    assert len(split.train) == 60 and len(split.validation) == 20 and len(split.test) == 20
    assert days.index(split.validation[0]) == 65 and days.index(split.test[0]) == 90
    assert split.window_choice == ()


def test_split_takes_the_window_choice_sessions_out_of_their_part():
    days = trading_days("2026-06-01", 120)
    split = study.split_sessions(days)
    assert len(split.window_choice) == 13
    assert split.window_choice[0] == "2026-10-28" and split.window_choice[-1] == "2026-11-13"
    assert not set(split.window_choice) & set(split.train + split.validation + split.test)


def test_split_refuses_too_few_sessions():
    with pytest.raises(ValueError):
        study.split_sessions(trading_days("2025-01-02", 29))


def test_out_of_sample_part_is_validation_then_test():
    split = study.split_sessions(trading_days("2025-01-02", 60))
    assert split.out_of_sample == split.validation + split.test


def test_trials_are_five_configurations_times_two_forms(results):
    assert list(study.CONFIGS) == ["C0", "V1", "V2", "V3", "V4"] and study.FORMS == ("F", "O")
    assert len(results["series"]) == study.N_TRIALS == 10
    assert set(results["series"]) == {f"{c}-{f}" for c in study.CONFIGS for f in study.FORMS}


def test_row_capital_and_sources_follow_the_rows_table(results):
    rows = results["rows"]
    assert rows["C0-F"]["capital"] == 200_000 and rows["C0-F"]["instruments"] == ["ES", "NQ"]
    assert rows["C0-F-ES"]["capital"] == 100_000 and set(rows["C0-F"]["ticks"]) == {"0", "1", "2"}
    assert rows["C0-O"]["capital"] == 200_000 and rows["C0-O-SPY"]["capital"] == 100_000
    assert rows["C0-O-stress"]["capital"] == 200_000
    whole = {name: study.stats_of(results, name) for name in ("C0-F", "C0-F-ES", "C0-F-NQ")}
    assert whole["C0-F"]["netUsd"] == pytest.approx(whole["C0-F-ES"]["netUsd"] + whole["C0-F-NQ"]["netUsd"])
    assert whole["C0-F"]["trades"] == whole["C0-F-ES"]["trades"] + whole["C0-F-NQ"]["trades"]
    o = study.stats_of(results, "C0-O")
    assert o["netUsd"] == pytest.approx(study.stats_of(results, "C0-O-SPY")["netUsd"]
                                        + study.stats_of(results, "C0-O-QQQ")["netUsd"])
    assert study.stats_of(results, "C0-O-stress")["netUsd"] < o["netUsd"]
    assert 0 < whole["C0-F"]["timeInMarket"] <= 1


def test_deflated_sharpe_uses_the_ten_trial_series_of_the_out_of_sample_part(results):
    dsr = results["deflatedSharpe"]
    assert dsr["rows"] == 10 and dsr["trials"] == 10
    assert dsr["observations"] == results["split"]["outOfSample"]["sessions"]
    assert all(len(v) == dsr["observations"] for v in results["series"].values())
    bad = study.deflated_sharpe({"C0-F": [1.0]})
    assert bad["probability"] is None and bad["error"]


def test_verdict_needs_more_data_below_100_out_of_sample_trades():
    verdict, reason = study.verdict_of(99, 1000.0, {"probability": 0.99})
    assert verdict == "needs-more-data"
    assert reason == "Needs more data: 99 out-of-sample trades, 100 needed. Options-side rule with modelled fills."


def test_verdict_edge_and_no_edge():
    assert study.verdict_of(100, 10.0, {"probability": 0.95}) == (
        "edge", "Edge: 100 out-of-sample trades, net $10 at 1 tick per side, deflated Sharpe 0.950 (bar 0.95, "
        "N = 10). Options-side rule with modelled fills.")
    assert study.verdict_of(100, -10.0, {"probability": 0.99})[0] == "no-edge"
    assert study.verdict_of(100, 10.0, {"probability": 0.5})[1].startswith("No edge: 100 out-of-sample trades")


def test_verdict_without_a_probability_is_no_edge():
    verdict, reason = study.verdict_of(150, 10.0, {"probability": None, "error": "boom"})
    assert verdict == "no-edge"
    assert reason == ("No edge: deflated Sharpe not computable: boom. 150 out-of-sample trades, net $10 at 1 tick "
                      "per side. Options-side rule with modelled fills.")


# --- checks -------------------------------------------------------------------------------------------------------

def test_two_sided_description_by_hand():
    tickers = {t: ticker_session(t, "2025-06-03", 1, 100.0) for t in data.TICKERS}
    session = study.build_session("ES", "2025-06-03", tickers)
    second = int(ms_at("2025-06-03", 570 + 50) // 1000)
    deep = [{"symbol": "ES", "second_s": second, "side": "buy", "size": 3, "price": 1.0},
            {"symbol": "ES", "second_s": second + 1, "side": "sell", "size": 1, "price": 1.0},
            {"symbol": "ES", "second_s": int(ms_at("2025-06-03", 570 + 2) // 1000), "side": "sell", "size": 5,
             "price": 1.0},
            {"symbol": "NQ", "second_s": second, "side": "buy", "size": 9, "price": 1.0},
            {"symbol": "ES", "second_s": int(ms_at("2025-06-04", 600) // 1000), "side": "buy", "size": 9,
             "price": 1.0}]
    out = study.two_sided_description(deep, [session])
    assert len(out) == 1
    row = out[0]
    assert (row["trades"], row["buyVolume"], row["sellVolume"], row["netVolume"]) == (3, 3.0, 6.0, -3.0)
    assert row["tradeMinutes"] == 1 and row["sameSignMinutes"] == 1  # minute 50 under buyers, net +2
    assert row["controlMinutes"] == BARS - 13


def test_live_rows_check_by_hand_and_not_provided(tmp_path):
    assert study.live_rows_check([], tmp_path) == {"status": "not provided"}
    day = "2025-06-03"
    path = data.bucket_path(tmp_path, "SPY", "total", day)
    path.parent.mkdir(parents=True)
    k0, k1, k2 = (int(ms_at(day, 570 + m)) for m in range(3))
    bucket = {"netCallVolume": 0, "netPutVolume": 0, "stockPrice": 1.0}
    path.write_text(json.dumps({str(k0): {**bucket, "netCallPremium": 10, "netPutPremium": 5},
                                str(k1): {**bucket, "netCallPremium": 10, "netPutPremium": 5}}))
    rows = [{"ticker": "SPY", "part": "total", "minute_ms": k0, "net_call_premium": 10.005, "net_put_premium": 5},
            {"ticker": "SPY", "part": "total", "minute_ms": k1, "net_call_premium": 12, "net_put_premium": 5},
            {"ticker": "SPY", "part": "total", "minute_ms": k2, "net_call_premium": 1, "net_put_premium": 1}]
    out = study.live_rows_check(rows, tmp_path)
    assert out["status"] == "ran" and out["day"] == day
    pair = out["pairs"][0]
    assert (pair["stored"], pair["downloaded"], pair["common"], pair["equal"]) == (3, 2, 2, 1)
    assert pair["maxAbsDiffUsd"] == pytest.approx(2.0) and pair["onlyStored"] == 1 and pair["onlyDownloaded"] == 0


# --- document and report ------------------------------------------------------------------------------------------

def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_strings(item)


def test_run_document_and_report_end_to_end(results):
    doc = document.study_document(results)
    assert set(doc) == {"comparison", "equity", "equityLabel", "forms", "gaps", "id", "kind", "notes", "provenance",
                        "ran", "robustness", "rules", "sensitivity", "source", "spec", "title", "verdict",
                        "verdictReason"}
    assert doc["id"] == "flow-control-continuation" and doc["kind"] == "strategy-backtest"
    assert doc["spec"] == "docs/specs/strategies/flow-control-continuation.md" and (REPO / doc["spec"]).exists()
    assert doc["title"].startswith("Options-side continuation rule (modelled fills)") and len(doc["title"]) <= 200
    assert len(doc["rules"]) == 12 and len(doc["gaps"]) == 6 and len(doc["robustness"]) == 11
    assert len(doc["sensitivity"]) == 9 and len(doc["comparison"]) == 2
    assert all(len(r["item"]) <= 60 and len(r["rule"]) <= 400 for r in doc["rules"])
    assert all(len(r["check"]) <= 80 and len(r["result"]) <= 300 for r in doc["robustness"])
    months = [p["month"] for p in doc["equity"]]
    assert len(months) >= 2 and months == sorted(set(months))
    assert all(-1 <= p["drawdown"] <= 0 and p["value"] >= -1 for p in doc["equity"])
    for form in doc["forms"]:
        assert form["key"] in ("underlying", "options") and 1 <= len(form["runs"]) <= 80
        for run in form["runs"]:
            assert run["from"] <= run["to"] and -1 <= run["maxDrawdown"] <= 0 and 0 <= run["exposure"] <= 1
    assert [len(f["runs"]) for f in doc["forms"]] == [5, 3]
    assert doc["provenance"]["engine"] == "nautilus_trader 1.227.0"
    assert doc["provenance"]["dataHash"].startswith("sha256:")
    assert doc["provenance"]["runId"] == "flow-control-continuation-2026-11-15-aaaaaaaa"
    assert len(json.dumps(doc, separators=(",", ":")).encode()) < 262_144
    page = report.render(results)
    assert page.startswith("<!doctype html>") and "<script" not in page and "http://" not in page
    assert "Options-side continuation rule (modelled fills)" in page and "Walk-forward split" in page
    assert ".json" not in page


def test_rules_item_text_equals_the_fixture_header():
    assert document.RULES_VERSION_ITEM == GOLDEN["studyRulesItem"]
    assert document.RULE_ITEMS[0][:2] == (GOLDEN["studyRulesItem"], GOLDEN["rules"]["version"])
    assert document.RULE_ITEMS[1][1] == GOLDEN["filterProfile"]


def test_document_refuses_each_of_the_four_cases(results):
    cases = [
        (lambda r: r["provenance"].update(dirtyFiles=["x"]),
         "The study ran with uncommitted code; its document names a commit without that code"),
        (lambda r: r["diagnostics"].update(nautilus={"status": "not run", "reason": "disabled"}),
         "The NautilusTrader fill check did not run; the document needs one engine"),
        (lambda r: r["diagnostics"]["nautilus"].update(same=False),
         "The NautilusTrader fill check found different fills; the study has no document"),
        (lambda r: r.update(curve=r["curve"][:1]),
         "The equity curve has fewer than 2 months; the study has no document"),
    ]
    for change, message in cases:
        copy = json.loads(json.dumps(results))
        change(copy)
        with pytest.raises(ValueError) as error:
            document.study_document(copy)
        assert str(error.value) == message


def test_cut_text_has_no_outer_space(results):
    assert document.cut("ab  cd", 3) == "ab"
    doc = document.study_document(results)
    assert all(text == text.strip() for text in _walk_strings(doc))


def test_options_form_is_left_out_without_spreads():
    out = study.run(synthetic_loaded(), Path("/nonexistent"),
                    markets={"SPY": market("SPY", "2024-01-01", "2024-02-01"),
                             "QQQ": market("QQQ", "2024-01-01", "2024-02-01")}, nautilus=False)
    out["diagnostics"]["nautilus"] = dict(NAUTILUS_RAN)
    out["provenance"] = {"commit": "b" * 40, "dirtyFiles": [], "ran": "2026-11-15"}
    assert out["diagnostics"]["optionsSkipped"]["count"] > 0
    doc = document.study_document(out)
    assert [form["key"] for form in doc["forms"]] == ["underlying"]


# --- runner -------------------------------------------------------------------------------------------------------

def _market_root(tmp_path: Path) -> Path:
    root = tmp_path / "market"
    root.mkdir(exist_ok=True)
    for name in ("SPY.csv", "QQQ.csv", "VIX.csv", "VXN.csv", "IRX.csv"):
        (root / name).write_text("date,close\n")
    return root


def _patch_runner(module, monkeypatch, tmp_path, *, nautilus_ran: bool = True):
    monkeypatch.setattr(module, "git_state", lambda: ("c" * 40, []))
    monkeypatch.setattr(module.data, "load_all", lambda root: synthetic_loaded())
    fake = markets()
    monkeypatch.setattr(module.qc_data, "load_market", lambda symbol, root=None: fake[symbol])
    real_run = study.run

    def run(*args, **kwargs):
        kwargs["nautilus"] = False
        out = real_run(*args, **kwargs)
        if nautilus_ran:
            out["diagnostics"]["nautilus"] = dict(NAUTILUS_RAN)
        return out

    monkeypatch.setattr(module.study, "run", run)
    return ["--data", str(tmp_path / "data"), "--market-data", str(_market_root(tmp_path)),
            "--out", str(tmp_path / "out")]


def test_runner_refuses_a_changed_spec_dirty_code_and_an_out_folder_in_the_repository(monkeypatch, tmp_path):
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path)
    monkeypatch.setattr(module.rules, "SPEC_SHA256", "0" * 64)
    assert module.main(args) == 1
    monkeypatch.undo()
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path)
    monkeypatch.setattr(module, "git_state", lambda: ("c" * 40, [" M services/research/x.py"]))
    assert module.main(args) == 1
    assert module.main([*args[:4], "--out", str(REPO / "tmp-out")]) == 1
    assert not (REPO / "tmp-out").exists()


def test_runner_sets_provenance_and_writes_the_four_files(monkeypatch, tmp_path):
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path)
    assert module.main(args) == 0
    out = tmp_path / "out"
    assert {p.name for p in out.iterdir()} == {"data.json", "results.json", "study.json", "index.html"}
    results = json.loads((out / "results.json").read_text())
    prov = results["provenance"]
    assert prov["commit"] == "c" * 40 and prov["dirtyFiles"] == [] and prov["specSha256"] == rules.SPEC_SHA256
    assert len(prov["ran"]) == 10 and isinstance(prov["seconds"], int)
    info = json.loads((out / "data.json").read_text())
    assert set(info) == {"root", "marketRoot", "days", "first", "last", "skipped", "earlyCloseDays",
                         "derivedTotalDays", "files", "marketFiles", "dataHash"}
    assert len(info["marketFiles"]) == 5 and info["dataHash"] == results["data"]["dataHash"]


def test_runner_exit_code_is_1_without_a_study_document(monkeypatch, tmp_path):
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path, nautilus_ran=False)
    assert module.main(args) == 1
    out = tmp_path / "out"
    assert (out / "results.json").exists() and (out / "index.html").exists() and not (out / "study.json").exists()


def test_render_only_rebuilds_the_page(monkeypatch, tmp_path):
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path)
    assert module.main(args) == 0
    out = tmp_path / "out"
    (out / "index.html").unlink()
    (out / "study.json").unlink()
    assert module.main(["--out", str(out), "--render-only"]) == 0
    assert (out / "index.html").exists() and (out / "study.json").exists()


def test_dry_run_writes_nothing(monkeypatch, tmp_path, capsys):
    module = run_module()
    args = _patch_runner(module, monkeypatch, tmp_path)
    assert module.main([*args, "--dry-run"]) == 0
    assert not (tmp_path / "out").exists()
    assert "sessions 40" in capsys.readouterr().out


def test_capital_curve_and_row_stats_by_hand():
    curve = study.capital_curve(["2025-01-02", "2025-02-03", "2026-01-02"], [100.0, -300.0, 200.0], 1000.0)
    assert curve["maxDrawdown"] == pytest.approx(800 / 1100 - 1)
    assert [m["month"] for m in curve["months"]] == ["2025-01", "2025-02", "2026-01"]
    stats = study.row_stats([10.0, -5.0, 0.0], [10.0, -5.0], ["2025-01-02", "2025-01-03"], 1000.0, 39.0, 1)
    assert stats["trades"] == 3 and stats["winRate"] == pytest.approx(1 / 3) and stats["profitFactor"] == 2.0
    assert stats["timeInMarket"] == pytest.approx(39 / 780) and stats["maxDrawdownUsd"] == 5.0
    assert stats["sharpe"] == pytest.approx(stats["sessionSharpe"] * math.sqrt(252))
    assert study.row_stats([], [], [], 1000.0, 0, 1)["profitFactor"] is None
