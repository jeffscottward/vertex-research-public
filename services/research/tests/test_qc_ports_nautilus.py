"""qc-ports: the NautilusTrader runner matches the pure-Python ledger (1e-6 relative).

Needs nautilus-trader==1.227.0 (requirements-nautilus-linux-py312.lock). Without
it the tests skip, unless VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus CI run), where
a missing engine is a failure. Synthetic books always run; the real-data case
runs only where the qc-ports data folder exists (it is not in the repo).
"""
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
                          input=json.dumps(request), capture_output=True, text=True, timeout=600)
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
