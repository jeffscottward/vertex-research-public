"""qc-ports: the NautilusTrader runner matches the pure-Python ledger (1e-6 relative).

Needs nautilus-trader==1.227.0 (requirements-nautilus-linux-py312.lock). Without
it the tests skip, unless VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus CI run), where
a missing engine is a failure. Synthetic books always run; the real-data case
runs only where the qc-ports data folder exists (it is not in the repo).
"""
import dataclasses
import os
import random

import pytest

from strategies.qc_ports import nautilus_runner
from strategies.qc_ports.book import SignalEvent, build_book
from strategies.qc_ports.data import data_root, load_market
from strategies.qc_ports.ledger import run_ledger
from tests.qc_ports_synthetic import market
from tests.test_qc_ports_ledger import D, hand_book

REL_TOL = 1e-6

pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_runner.require()
        return True
    try:
        nautilus_runner.require()
    except nautilus_runner.NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader 1.227.0 not installed")


def _rel(left: float, right: float) -> float:
    return 0.0 if left == right else abs(left - right) / max(abs(left), abs(right), 1e-12)


def assert_parity(trades, dates=None, capital=100_000.0):
    ledger = run_ledger(trades, capital, dates)
    engine = nautilus_runner.run_nautilus(trades, capital, dates)
    assert engine.engine == nautilus_runner.ENGINE_ID
    assert engine.dates == ledger.dates
    assert engine.open_positions == ledger.open_positions
    assert engine.skipped == ledger.skipped
    assert max(_rel(a, b) for a, b in zip(ledger.equity, engine.equity, strict=True)) <= REL_TOL
    assert len(engine.trades) == len(ledger.trades)
    for want, got in zip(ledger.trades, engine.trades, strict=True):
        assert {k: v for k, v in got.items() if k not in ("pnl", "returnOnRisk")} == {
            k: v for k, v in want.items() if k not in ("pnl", "returnOnRisk")}
        assert _rel(want["pnl"], got["pnl"]) <= REL_TOL
    return ledger, engine


@needs_nautilus
def test_hand_book_matches_ledger_and_hand_values():
    ledger, engine = assert_parity(hand_book(), dates=D)
    assert engine.equity == pytest.approx((99_962.0, 100_912.0, 101_766.0, 100_989.12, 99_819.12, 99_819.12),
                                          rel=0, abs=1e-6)
    assert [(t["id"], t["contracts"]) for t in engine.trades] == [(1, 19), (3, 39)]


def _walk(seed: int, size: int, start: float) -> list[float]:
    rng = random.Random(seed)
    closes = [start]
    for _ in range(size - 1):
        closes.append(round(closes[-1] * (1 + rng.gauss(0.0003, 0.012)), 2))
    return closes


@needs_nautilus
@pytest.mark.parametrize(("structure", "extra"), [
    ("callDebitVertical", {"profitTakePct": 50, "exitDte": 7}),
    ("putDebitVertical", {"longDelta": 0.4}),
    ("putCreditVertical", {"profitTakePct": 50, "exitDte": 21}),
    ("callCreditVertical", {"shortDelta": 0.2, "exitDte": 0}),
])
def test_synthetic_books_match(structure, extra):
    size = 320
    markets = {"SPY": market(_walk(7, size, 450.0)), "QQQ": market(_walk(11, size, 380.0), symbol="QQQ",
                                                                   iv=24.0, rate=0.045)}
    rng = random.Random(3)
    events = []
    for symbol in markets:
        index = 0
        while index < size - 2:
            exit_index = index + rng.randint(3, 40) if rng.random() < 0.5 else None
            events.append(SignalEvent(symbol, index, exit_index))
            index += rng.randint(4, 25)
    options = {"structure": structure, "dte": {"target": 45, "min": 21}, "widthSigma": 0.5, "maxLossPct": 2,
               **extra}
    book = build_book(events, options, markets)
    assert len(book.trades) > 20
    ledger, _ = assert_parity(book.trades, dates=markets["SPY"].dates)
    assert max(ledger.open_positions) > 2  # overlapping trades on two symbols
    assert {t["exitReason"] for t in ledger.trades} >= {"signal"}


@needs_nautilus
@pytest.mark.parametrize("structure", ["callCalendar", "putCalendar"])
def test_synthetic_calendar_books_match(structure):
    """Two-expiry trades (book.CALENDARS) are one instrument per spread like a vertical: both engines agree."""
    size = 320
    spy = market(_walk(5, size, 450.0), rate=0.03)
    spy = dataclasses.replace(spy, iv_term=(("VIX3M", tuple(24.0 + (index % 7) for index in range(size))),))
    rng = random.Random(9)
    events, index = [], 0
    while index < size - 2:
        exit_index = index + rng.randint(3, 30) if rng.random() < 0.5 else None
        events.append(SignalEvent("SPY", index, exit_index))
        index += rng.randint(2, 9)
    options = {"structure": structure, "dte": {"target": 30, "min": 21}, "farDte": {"target": 60, "min": 45},
               "maxLossPct": 2, "profitTakePct": 25}
    book = build_book(events, options, {"SPY": spy})
    assert len(book.trades) > 20 and all(trade.far_expiry for trade in book.trades)
    ledger, _ = assert_parity(book.trades, dates=spy.dates)
    assert max(ledger.open_positions) > 2
    assert {t["exitReason"] for t in ledger.trades} >= {"signal", "expiry"}


@needs_nautilus
@pytest.mark.skipif(not (data_root() / "SPY.csv").exists(), reason="qc-ports data folder not present")
def test_real_spy_monthly_call_debit_matches():
    from strategies.qc_ports.__main__ import SMOKE_OPTIONS, monthly_events

    spy = load_market("SPY")
    book = build_book(monthly_events("SPY", spy.dates, "2007-01-01"), SMOKE_OPTIONS, {"SPY": spy})
    dates = tuple(day for day in spy.dates if day >= "2007-01-01")
    ledger, _ = assert_parity(book.trades, dates=dates)
    assert len(ledger.trades) > 200


# --------------------------------------------------------------------------- worker path (options definitions)

def _worker_rows(size=90):
    from tests.qc_ports_synthetic import VIX_FOR_20, trading_days

    dates = list(trading_days("2024-01-02", size))
    closes = [100.0 + 0.2 * k for k in range(size)]
    return {
        "SPY": {"dates": dates, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}},
        "VIX": {"dates": dates, "close": [VIX_FOR_20] * size},
        "IRX": {"dates": dates, "close": [4.0] * size},
    }


def _worker_spec(rows, **rule_extra):
    from strategies.qc_ports import ideas as qi

    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    dates = rows["SPY"]["dates"]
    return {"symbol": "SPY", "timeframe": "1d", "from": dates[0], "to": dates[-1], "initialCapital": 100000,
            "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0, "rule": {"kind": "dsl", "definition": made, **rule_extra}}


@needs_nautilus
def test_run_spec_json_books_the_options_run_in_both_ledgers():
    from strategies.qc_ports import portfolio as pf

    rows = _worker_rows()
    out = pf.run_spec_json(_worker_spec(rows), rows)
    assert out["kind"] == "options" and out["capital"] == 100000.0
    assert out["dates"] == rows["SPY"]["dates"] and len(out["equity"]) == len(out["dates"])
    assert out["trades"] and out["metrics"]["trades"] == len(out["trades"])
    assert out["nautilusGap"] is not None and out["nautilusGap"] <= REL_TOL
    # Each trade carries its max loss per contract, so the API recomputes maxOpenRisk.
    assert all(trade["maxLoss"] > 0 for trade in out["trades"])
    spans = [(t["entryDate"], t["exitDate"], t["contracts"] * t["maxLoss"]) for t in out["trades"]]
    risk = max((sum(a for e, x, a in spans if e <= day < x) / equity
                for day, equity in zip(out["dates"], out["equity"])), default=0.0)
    assert risk == pytest.approx(out["metrics"]["maxOpenRisk"], rel=1e-12)
    import json

    json.dumps(out, allow_nan=False)
    with pytest.raises(ValueError, match="options block"):
        pf.run_spec_json({**_worker_spec(rows), "rule": {"kind": "smaCross", "fast": 5, "slow": 20}}, rows)


@needs_nautilus
def test_batch_cli_routes_options_cases_to_the_options_runner(tmp_path):
    import json
    import subprocess
    import sys
    from pathlib import Path

    rows = _worker_rows()
    bars = {"t": [0.0, 86_400_000.0], "o": [1.0, 1.0], "h": [1.0, 1.0], "l": [1.0, 1.0], "c": [1.0, 1.0]}
    request = {"bars": bars, "series": rows, "cases": [
        {"id": "opt", "spec": _worker_spec(rows)},
        {"id": "no-rows", "spec": _worker_spec(rows)},
    ]}
    research = Path(__file__).resolve().parents[1]
    done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                          input=json.dumps(request), capture_output=True, text=True, timeout=600, check=False)
    assert done.returncode == 0, done.stderr
    results = {item["id"]: item for item in json.loads(done.stdout)["results"]}
    assert results["opt"]["result"]["kind"] == "options"
    missing = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                             input=json.dumps({**request, "series": None}), capture_output=True, text=True,
                             timeout=600)
    assert "needs the daily series rows" in json.loads(missing.stdout)["results"][0]["error"]


@needs_nautilus
def test_batch_cli_passes_series_rows_to_equity_definitions_that_read_series():
    import json
    import subprocess
    import sys
    from datetime import date
    from pathlib import Path

    rows = _worker_rows()
    dates = rows["SPY"]["dates"]
    closes = rows["SPY"]["close"]
    epoch = date(1970, 1, 1)
    t = [float((date.fromisoformat(day) - epoch).days * 86_400_000) for day in dates]
    bars = {"t": t, "o": closes, "h": closes, "l": closes, "c": closes}
    gated = {"name": "vix gate", "version": 1,
             "entry": {"all": [{"left": {"type": "price", "field": "close"}, "op": ">",
                                "right": {"type": "const", "value": 0}}]},
             "filters": [{"type": "series", "series": "$iv", "condition": {
                 "left": {"type": "price", "field": "close"}, "op": "<", "right": {"type": "const", "value": 30}}}]}
    spec = {"symbol": "SPY", "timeframe": "1d", "from": dates[0], "to": dates[-1], "initialCapital": 10000,
            "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0, "rule": {"kind": "dsl", "definition": gated}}
    research = Path(__file__).resolve().parents[1]

    def batch(series):
        done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                              input=json.dumps({"bars": bars, "series": series, "cases": [{"id": "eq", "spec": spec}]}),
                              capture_output=True, text=True, timeout=600)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)["results"][0]

    assert len(batch(rows)["result"]["equity"]) == len(dates)
    assert "STRATEGY_SERIES_FILTERS_UNSUPPORTED" in batch(None)["error"]


def _gated_batch(rows):
    from datetime import date

    dates = rows["SPY"]["dates"]
    closes = rows["SPY"]["close"]
    epoch = date(1970, 1, 1)
    t = [float((date.fromisoformat(day) - epoch).days * 86_400_000) for day in dates]
    bars = {"t": t, "o": closes, "h": closes, "l": closes, "c": closes}
    gated = {"name": "vix gate", "version": 1,
             "entry": {"all": [{"left": {"type": "price", "field": "close"}, "op": ">",
                                "right": {"type": "const", "value": 0}}]},
             "filters": [{"type": "series", "series": "$iv", "condition": {
                 "left": {"type": "price", "field": "close"}, "op": "<", "right": {"type": "const", "value": 30}}}]}

    def spec(first, end):
        return {"symbol": "SPY", "timeframe": "1d", "from": dates[first], "to": dates[end - 1],
                "initialCapital": 10000, "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0,
                "rule": {"kind": "dsl", "definition": gated}}

    cases = [{"id": "early", "slice": [0, 50], "spec": spec(0, 50)},
             {"id": "late", "slice": [20, 90], "spec": spec(20, 90)}]
    return bars, cases


def _cut(rows, last):
    keep = {series_id: sum(1 for day in row["dates"] if day <= last) for series_id, row in rows.items()}
    return {series_id: {key: list(values)[:keep[series_id]] for key, values in row.items()}
            for series_id, row in rows.items()}


def test_batch_cases_read_the_series_rows_up_to_their_own_last_bar(monkeypatch):
    """A case of a multi-case batch gets the context of the rows cut at its last bar: the same as
    the run alone with its claim rows (cut at its `to`), whatever later rows the batch holds."""
    import nautilus_backtest.__main__ as cli
    from nautilus_backtest.bars import Bars

    seen = {}

    class Result:
        def __init__(self, value):
            self.value = value

        def to_json(self):
            return self.value

    def fake_run_spec(bars, spec):
        context = spec["context"]
        return Result({"bars": len(bars.c), "last": {key: max(values) for key, values in context.items()},
                       "size": {key: len(values) for key, values in context.items()}})

    monkeypatch.setattr(cli, "run_spec", fake_run_spec)
    rows = _worker_rows()
    bars, cases = _gated_batch(rows)
    shared = Bars.from_columns(bars)
    batched = {case["id"]: cli._batch_case(shared, case, rows)["result"] for case in cases}
    for case in cases:
        first, end = case["slice"]
        alone_bars = Bars.from_columns({key: values[first:end] for key, values in bars.items()})
        alone = cli._batch_case(alone_bars, {"id": case["id"], "spec": case["spec"]},
                                _cut(rows, case["spec"]["to"]))["result"]
        seen[case["id"]] = alone
        assert batched[case["id"]] == alone
    assert seen["early"]["last"]["VIX"] == cases[0]["spec"]["to"] < rows["VIX"]["dates"][-1]
    assert seen["late"]["last"]["VIX"] == cases[1]["spec"]["to"]

    # `to` after the last bar (a holiday at the end of the range): a series row between the last
    # bar and `to` is read, as the claim rows (cut at `to`) hold it; nothing after `to` is.
    dates = rows["SPY"]["dates"]
    after = {**cases[0], "spec": {**cases[0]["spec"], "to": dates[51]}}
    result = cli._batch_case(shared, after, rows)["result"]
    assert result["last"]["VIX"] == dates[51] and result["size"]["VIX"] == 52
    assert result == cli._batch_case(shared, after, _cut(rows, dates[51]))["result"]
    # A spec without `to` reads up to its last bar.
    bare = {**cases[0], "spec": {key: value for key, value in cases[0]["spec"].items() if key != "to"}}
    assert cli._batch_case(shared, bare, rows)["result"]["last"]["VIX"] == dates[49]


@needs_nautilus
def test_batch_cli_multi_case_with_series_equals_each_run_alone():
    import json
    import subprocess
    import sys
    from pathlib import Path

    rows = _worker_rows()
    bars, cases = _gated_batch(rows)
    research = Path(__file__).resolve().parents[1]

    def batch(request):
        done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                              input=json.dumps(request), capture_output=True, text=True, timeout=600, check=False)
        assert done.returncode == 0, done.stderr
        return {entry["id"]: entry["result"] for entry in json.loads(done.stdout)["results"]}

    together = batch({"bars": bars, "series": rows, "cases": cases})
    for case in cases:
        first, end = case["slice"]
        alone = batch({"bars": {key: values[first:end] for key, values in bars.items()},
                       "series": _cut(rows, case["spec"]["to"]), "cases": [{"id": case["id"], "spec": case["spec"]}]})
        assert together[case["id"]] == alone[case["id"]]
