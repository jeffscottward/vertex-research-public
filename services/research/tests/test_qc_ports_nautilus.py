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
