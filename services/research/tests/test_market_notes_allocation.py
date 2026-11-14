"""Allocation scripts with --market-notes: the document gains one context key and no number changes.

The study parts of both scripts are replaced with small fakes (no data, no engine, no network), so
each ``main`` runs to its document. The checks: without the flag the document bytes are the same
and nothing is read; with the flag the notes block is the last key and every other value is equal;
a failed read exits non-zero; and the notes variable is used in one place only.
"""
from __future__ import annotations

import ast
import importlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from market_notes import render
from market_notes.client import MarketNotesError

ALLOCATION = Path(__file__).resolve().parents[3] / "research" / "backtests" / "allocation"
DAYS = [(date(2026, 1, 1) + timedelta(days=index)).isoformat() for index in range(70)]
SEEDS = {"SPY": 1, "QQQ": 2}
NOTE = {
    "id": "mn_1", "asOf": "2026-11-11", "theme": "AI capex is close to a peak", "reviewBy": "2026-12-11", "status": "active",
    "stance": {"direction": "risk-off", "confidence": "medium"}, "ownerMessageUrl": "https://chat.example.com/m/1",
    "source": {"kind": "reel", "url": "https://www.instagram.com/reel/abc/", "author": "Jane Doe"},
    "affected": {"sectors": [], "strategies": ["long index"], "tickers": ["MSFT"]},
    "verification": {"cannotCheck": 0, "checked": False, "contradicted": 0, "supported": 1, "unverified": 1},
    "claims": [{"id": "c1", "status": "supported", "text": "Capex rose.", "evidence": "FD pack", "checkedAt": "2026-11-11T16:00:00Z"},
               {"id": "c2", "status": "unverified", "text": "Free cash flow fell.", "evidence": None, "checkedAt": None}],
}
BLOCK = {
    "role": "research context only; not used in any weight, gate, cap or size", "asOf": "2026-11-11T15:00:00.000Z",
    "notes": [{"asOf": "2026-11-11", "theme": "AI capex is close to a peak", "stance": {"direction": "risk-off", "confidence": "medium"},
               "reviewBy": "2026-12-11",
               "verification": {"cannotCheck": 0, "checked": False, "contradicted": 0, "supported": 1, "unverified": 1},
               "claims": [{"id": "c1", "status": "supported", "text": "Capex rose."},
                          {"id": "c2", "status": "unverified", "text": "Free cash flow fell."}]}],
}


class FakeClient:
    def __init__(self, listing: Any) -> None:
        self.listing, self.calls = listing, []

    def list_notes(self, scope: str = "all", source_url: str | None = None) -> Any:
        self.calls.append((scope, source_url))
        if isinstance(self.listing, Exception):
            raise self.listing
        return self.listing


def test_the_block_holds_the_active_notes_with_every_claim_status():
    client = FakeClient({"asOf": "2026-11-11T15:00:00.000Z", "notes": [NOTE], "today": "2026-11-11"})
    assert render.read_report_block({}, client) == BLOCK
    assert client.calls == [("active", None)]  # expired and retired notes are not report context
    empty = render.report_block({"asOf": "2026-11-11T15:00:00.000Z", "notes": []})
    assert empty == {"role": BLOCK["role"], "asOf": "2026-11-11T15:00:00.000Z", "notes": []}


def test_the_block_leaves_out_a_note_that_is_not_active_even_when_the_answer_holds_one():
    """Defense in depth: the server filters the active scope; the block does not rely on it."""
    stale = {**NOTE, "id": "mn_2", "status": "expired", "theme": "Stale view"}
    retired = {**NOTE, "id": "mn_3", "status": "retired", "theme": "Retired view"}
    listing = {"asOf": "2026-11-11T15:00:00.000Z", "notes": [stale, NOTE, retired], "today": "2026-11-11"}
    assert render.report_block(listing) == BLOCK
    assert render.report_block({**listing, "notes": [stale, retired]})["notes"] == []
    assert [entry["id"] for entry in render.active_only(listing)["notes"]] == ["mn_1"]
    text = render.notes_text(listing, "active")
    assert "1 note, scope active" in text and "Stale view" not in text and "Retired view" not in text
    assert "3 notes, scope all" in render.notes_text(listing, "all")


@pytest.mark.parametrize("listing", [
    {"notes": [NOTE]}, {"asOf": "", "notes": []}, {"asOf": "x", "notes": [{"theme": "no other field"}]},
    {"asOf": "x", "notes": [{**NOTE, "status": None}]},
    {"asOf": "x", "notes": [{**NOTE, "claims": [{"id": "c1"}]}]}, {"asOf": "x", "notes": ["text"]},
    {"asOf": "x", "notes": [{**NOTE, "stance": None}]},
])
def test_a_malformed_answer_is_an_error_not_an_empty_block(listing: Any):
    with pytest.raises(ValueError):
        render.report_block(listing)


def test_reading_needs_the_api_settings():
    with pytest.raises(ValueError, match="VERTEX_API_URL"):
        render.read_report_block({})
    failing = FakeClient(MarketNotesError("list", 503, "STORAGE_ERROR", "Market notes storage unavailable"))
    with pytest.raises(MarketNotesError):
        render.read_report_block({}, failing)


@pytest.fixture(scope="module")
def scripts() -> Any:
    """The two allocation scripts as modules, loaded the way the scripts load each other."""
    names = ("run", "sensitivity", "funded_pie")
    saved_path, saved = list(sys.path), {name: sys.modules.pop(name, None) for name in names}
    sys.path.insert(0, str(ALLOCATION))
    try:
        yield importlib.import_module("run"), importlib.import_module("funded_pie")
    finally:
        sys.path[:] = saved_path
        for name, module in saved.items():
            sys.modules.pop(name, None)
            if module is not None:
                sys.modules[name] = module


class Reader:
    def __init__(self, answer: Any = BLOCK) -> None:
        self.answer, self.calls = answer, 0

    def __call__(self) -> Any:
        self.calls += 1
        if isinstance(self.answer, BaseException):
            raise self.answer
        return json.loads(json.dumps(self.answer))


class Result:
    def __init__(self, seed: int) -> None:
        self.seed, self.dates = seed, DAYS
        self.equity = tuple(100_000.0 + seed * index for index in range(len(DAYS)))
        self.trades = [{"id": f"t{seed}", "pnl": 12.5 * seed, "exitReason": "expiry"}]


def fake_study_parts(monkeypatch: pytest.MonkeyPatch, run: Any) -> None:
    """Replace the study, the engine and the statistics of run.py with small deterministic stand-ins."""
    def candidate(key: str, symbol: str, sleeve: str) -> dict[str, Any]:
        return {"key": key, "slug": key.replace("/", "-"), "name": key, "sleeve": sleeve, "role": "strategy",
                "definition": {"symbol": symbol}, "start": DAYS[0], "baseline": None, "study": None}

    def trades(made: dict[str, Any], dataset: Any, start: str) -> list[Any]:
        return [SimpleNamespace(symbol=made["symbol"], entry_date=DAYS[1], trade_id=made["symbol"], max_loss=100.0)]

    def nautilus_run(priced: list[Any], capital: float, dates: list[str]) -> tuple[Result, float, str]:
        return Result(sum(SEEDS[trade.symbol] for trade in priced)), 1e-9, "nautilus-trader-test"

    def stats(result: Result, priced: Any, capital: float, n_trials: int, trial_variance: float) -> dict[str, Any]:
        return {"sharpe": 0.5 + result.seed / 10, "days": 2520, "cagr": 0.04 * result.seed, "maxDrawdown": -0.05 * result.seed,
                "trades": 40 + result.seed, "nTrials": n_trials, "capital": capital}

    monkeypatch.setattr(run, "study", SimpleNamespace(
        load_study_data=lambda path: SimpleNamespace(dataset=SimpleNamespace(calendar=DAYS), facts=None, manifest={"SPY": "sha"}),
        run_family=lambda data, nautilus, progress: ({}, {}, None),
        daily_sharpe=lambda result: result.equity[-1] / 1_000_000,
        provenance=lambda *args: {"engine": "nautilus-trader-test"}))
    monkeypatch.setattr(run, "qi", SimpleNamespace(family=lambda facts: {}))
    monkeypatch.setattr(run, "al", SimpleNamespace(
        TRADING_DAYS=252, GATE={"minSharpe": 0.5},
        qc_candidates=lambda runs: [candidate("spy/A", "SPY", "trend"), candidate("qqq/A", "QQQ", "mean reversion")],
        owner_rule_trades=trades,
        daily_returns=lambda equity: [after / before - 1 for before, after in zip(equity, equity[1:])],
        sharpe=lambda returns: round(sum(returns) * 100, 9),
        gate_checks=lambda stats, baseline: [{"name": "sharpe", "pass": stats["sharpe"] >= 0.5}],
        correlation=lambda first, second: 0.25,
        equal_risk=lambda names: {name: 1 / len(names) for name in names},
        inverse_volatility=lambda volatility: {name: 0.5 for name in volatility},
        shrunk_sharpe=lambda sharpes, years: {name: 0.5 for name in sharpes},
        Caps=lambda **limits: limits,
        combine=lambda books, risk, caps: SimpleNamespace(
            trades=[trade for book in books.values() for trade in book], refused=[],
            owner={"t1": "spy/A", "t2": "qqq/A", "t3": "spy/A"}),
        window_metrics=lambda result, start, end: {"return": 0.01 * result.seed, "start": start, "end": end}))
    monkeypatch.setattr(run, "qj_candidates", lambda library: [])
    monkeypatch.setattr(run, "nautilus_run", nautilus_run)
    monkeypatch.setattr(run, "run_stats", stats)
    monkeypatch.setattr(run, "returns_by_day", lambda result: {day: 0.001 * result.seed for day in DAYS[1:]})
    monkeypatch.setattr(run, "regime", lambda data: {"SPY": {"close": 600.0}})
    monkeypatch.setattr(run, "open_today", lambda priced, last_day: [])
    monkeypatch.setattr(run, "_open_premium", lambda result, priced: {"averagePct": 1.5, "peakPct": 3.0})


def run_main(monkeypatch: pytest.MonkeyPatch, module: Any, out: Path, *flags: str) -> None:
    argv = {"run": ["run.py", "--data", "data", "--capital", "100000"],
            "funded_pie": ["funded_pie.py", "--data", "data", "--capital", "100000", "--trials", "40",
                           "--trial-variance", "0.001", "--chain", "chain.json"]}[module.__name__]
    monkeypatch.setattr(sys, "argv", [*argv, "--out", str(out), *flags])
    module.main()


def test_run_py_adds_the_notes_and_changes_no_number(scripts: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    run, _pie = scripts
    fake_study_parts(monkeypatch, run)
    reader = Reader()
    monkeypatch.setattr(run, "owner_market_notes", reader)
    run_main(monkeypatch, run, tmp_path / "plain.json")
    assert reader.calls == 0  # without the flag nothing is read
    plain = (tmp_path / "plain.json").read_bytes()
    document = json.loads(plain)
    assert "ownerMarketNotes" not in document and document["eligible"] == ["spy/A", "qqq/A"]
    assert set(document["portfolios"]) == {"equalRisk", "inverseVolatility", "shrunkSharpe"}

    run_main(monkeypatch, run, tmp_path / "notes.json", "--market-notes")
    assert reader.calls == 1
    with_notes = json.loads((tmp_path / "notes.json").read_text())
    assert list(with_notes)[-1] == "ownerMarketNotes" and with_notes["ownerMarketNotes"] == BLOCK
    del with_notes["ownerMarketNotes"]
    # Every other value is the same, to the byte.
    assert json.dumps(with_notes, indent=1).encode() == plain

    run_main(monkeypatch, run, tmp_path / "again.json")
    assert (tmp_path / "again.json").read_bytes() == plain


class FakePool:
    """Stands in for the process pool of funded_pie.py: one canned model result per model."""

    def __init__(self, **options: Any) -> None:
        self.options = options

    def __enter__(self) -> FakePool:
        return self

    def __exit__(self, *error: Any) -> None:
        return None

    def submit(self, function: Any, name: str, *args: Any) -> Any:
        scale = {"study": 1, "measured": 2}[name]
        model = {"stats": {"cagr": 0.03 * scale, "sharpe": 0.4 * scale, "maxDrawdown": -0.08 * scale}, "lowerBar": scale == 1,
                 "arguments": [str(arg) for arg in args]}
        return SimpleNamespace(result=lambda: model)


def test_funded_pie_adds_the_notes_and_changes_no_number(scripts: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    run, pie = scripts
    reader = Reader()
    monkeypatch.setattr(run, "owner_market_notes", reader)
    monkeypatch.setattr(pie, "ProcessPoolExecutor", FakePool)
    run_main(monkeypatch, pie, tmp_path / "plain.json")
    assert reader.calls == 0
    plain = (tmp_path / "plain.json").read_bytes()
    document = json.loads(plain)
    assert list(document) == ["pool", "limits", "lowerBar", "trials", "capital", "models"]
    assert document["models"]["measured"]["stats"]["sharpe"] == 0.8

    run_main(monkeypatch, pie, tmp_path / "notes.json", "--market-notes")
    assert reader.calls == 1
    with_notes = json.loads((tmp_path / "notes.json").read_text())
    assert list(with_notes)[-1] == "ownerMarketNotes" and with_notes.pop("ownerMarketNotes") == BLOCK
    assert json.dumps(with_notes, indent=1).encode() == plain


@pytest.mark.parametrize("script", ["run", "funded_pie"])
def test_a_failed_read_stops_the_run_before_any_work(scripts: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, script: str):
    run, pie = scripts
    module = run if script == "run" else pie
    monkeypatch.setattr(run, "owner_market_notes", Reader(SystemExit("--market-notes: the owner market notes could not be read")))
    worked: list[str] = []
    monkeypatch.setattr(run, "study", SimpleNamespace(load_study_data=lambda path: worked.append("study")))
    monkeypatch.setattr(pie, "ProcessPoolExecutor", lambda **options: worked.append("pool"))
    with pytest.raises(SystemExit) as stopped:
        run_main(monkeypatch, module, tmp_path / "out.json", "--market-notes")
    assert stopped.value.code not in (0, None)
    assert worked == [] and not (tmp_path / "out.json").exists()


def test_the_reader_of_the_scripts_exits_non_zero_without_the_key_in_the_message(scripts: Any, monkeypatch: pytest.MonkeyPatch):
    run, _pie = scripts
    monkeypatch.setattr(render, "read_report_block", lambda: BLOCK)
    assert run.owner_market_notes() == BLOCK
    for error in (MarketNotesError("list", 401, "UNAUTHORIZED", "Authentication required"),
                  ValueError("set VERTEX_API_URL (or VERTEX_ORIGIN) and VERTEX_AGENT_API_KEY to reach the market notes API")):
        def failing(error: Exception = error) -> Any:
            raise error
        monkeypatch.setattr(render, "read_report_block", failing)
        with pytest.raises(SystemExit) as stopped:
            run.owner_market_notes()
        assert isinstance(stopped.value.code, str) and str(error) in stopped.value.code  # a text code exits with status 1
        assert stopped.value.code.startswith("--market-notes: the owner market notes could not be read")


@pytest.mark.parametrize("script", ["run.py", "funded_pie.py"])
def test_the_notes_reach_the_document_and_nothing_else(script: str):
    """The notes variable is set once and used once: as the value of the document key."""
    tree = ast.parse((ALLOCATION / script).read_text(encoding="utf-8"))
    main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main")
    uses = [node for node in ast.walk(main) if isinstance(node, ast.Name) and node.id == "owner_notes"]
    assert sorted(type(node.ctx).__name__ for node in uses) == ["Load", "Load", "Store"]
    guard = next(node for node in ast.walk(main) if isinstance(node, ast.If) and "owner_notes" in ast.unparse(node.test))
    assert ast.unparse(guard) == "if owner_notes is not None:\n    document['ownerMarketNotes'] = owner_notes"
    assigned = next(node for node in ast.walk(main) if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "owner_notes" for target in node.targets))
    assert ast.unparse(assigned.value).endswith("owner_market_notes() if args.market_notes else None")
    # No other function of the script and no study module names the notes.
    others = [node for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == "owner_notes" and node not in uses]
    assert others == []
    flag = next(node for node in ast.walk(main) if isinstance(node, ast.Call) and node.args
                and isinstance(node.args[0], ast.Constant) and node.args[0].value == "--market-notes")
    assert ast.unparse(flag.keywords[0]) == "action='store_true'"  # off by default
