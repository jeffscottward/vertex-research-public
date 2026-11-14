"""Triple RSI on NautilusTrader: share booking parity with the ledger, the DSL definition compiles to the rule's
bars, and the options form books the same in the qc-ports ledger and NautilusTrader.

Needs nautilus-trader==1.227.0 (requirements-nautilus-linux-py312.lock). Without it the tests skip, unless
VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus CI run), where a missing engine is a failure. Synthetic data only.
"""
import math
import os
import random

import pytest

from nautilus_backtest.engine import run_spec
from nautilus_backtest.signals import compile_strategy
from strategies.qc_ports import forms as fm
from strategies.qc_ports import nautilus_runner
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.data import Bars
from strategies.triple_rsi import dsl, options_form, rules, shares
from strategies.triple_rsi.rules import Params
from tests.qc_ports_synthetic import market, trading_days

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


def _walk(count: int, seed: int, drift: float = 0.0004, vol: float = 0.012) -> list[float]:
    rng = random.Random(seed)
    price, out = 100.0, []
    for _ in range(count):
        price *= math.exp(drift + vol * rng.gauss(0, 1))
        out.append(round(price, 4))
    return out


def _bars(closes: list[float], seed: int = 7) -> Bars:
    rng = random.Random(seed)
    dates = trading_days("2010-01-04", len(closes))
    opens = [round(close * (1 + 0.004 * rng.gauss(0, 1)), 4) for close in closes]
    highs = [max(o, c) * 1.003 for o, c in zip(opens, closes)]
    lows = [min(o, c) * 0.997 for o, c in zip(opens, closes)]
    adjusted = [round(close * (0.9 + 0.1 * index / len(closes)), 4) for index, close in enumerate(closes)]
    return Bars("SPY", dates, tuple(opens), tuple(highs), tuple(lows), tuple(closes), tuple(adjusted))


@needs_nautilus
@pytest.mark.parametrize("execution", rules.EXECUTIONS)
@pytest.mark.parametrize("cost", [0.0, 0.0005])
def test_share_booking_parity(execution, cost):
    bars = _bars(_walk(1500, seed=3))
    entries, exits = rules.signal_bars(bars.close, Params(trend_length=100))
    trades = rules.signal_trades(entries, exits, 120)
    prices = shares.traded_prices(bars, 120, "total")
    plan = shares.fills(trades, execution, len(prices.dates), 120)
    assert len(plan) >= 5
    ledger = shares.run_ledger(prices, plan, cost)
    other = shares.run_nautilus(prices, plan, cost)
    assert shares.parity_gap(ledger, other) <= 1e-9
    assert [(t["entryDate"], t["exitDate"], t["quantity"]) for t in ledger.trades] == [
        (t["entryDate"], t["exitDate"], t["quantity"]) for t in other.trades]
    result, gap = shares.book(prices, plan, cost)
    assert result.equity == ledger.equity and gap <= 1e-9


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_dsl_compiles_to_the_rule(seed):
    bars = _bars(_walk(2500, seed=seed, drift=0.0006))
    dsl_bars = pf.dsl_bars(bars.dates, bars.open, bars.high, bars.low, bars.close)
    for params in (rules.STATED, Params(length=3, entry_below=25.0, exit_above=55.0, trend_length=150)):
        compiled = compile_strategy(dsl_bars, dsl.definition(params))
        entries, exits = rules.signal_bars(bars.close, params)
        assert sum(entries) > 0
        assert list(compiled.signals) == [1 if entry else (-1 if exit_ else 0) for entry, exit_ in zip(entries, exits)]


@needs_nautilus
def test_dsl_engine_trades_the_rule_at_the_next_open():
    bars = _bars(_walk(2500, seed=5, drift=0.0006))
    dsl_bars = pf.dsl_bars(bars.dates, bars.open, bars.high, bars.low, bars.close)
    run = run_spec(dsl_bars, {"rule": {"kind": "dsl", "definition": dsl.definition()}, "costBps": 0,
                              "initialCapital": 100_000.0, "timeframe": "1d"})
    entries, exits = rules.signal_bars(bars.close)
    plan = shares.fills(rules.signal_trades(entries, exits), "nextOpen", len(bars.dates))
    ledger = shares.run_ledger(shares.traded_prices(bars, 0, "price"), plan, 0.0, 100_000.0)
    assert [(bars.dates[t["entryIndex"]], bars.dates[t["exitIndex"]]) for t in run.trades] == [
        (t["entryDate"], t["exitDate"]) for t in ledger.trades]
    assert max(abs(a * 100_000.0 - b) / b for a, b in zip(run.equity, ledger.equity)) < 1e-6


@needs_nautilus
def test_options_form_books_the_same_in_nautilus():
    closes = _walk(600, seed=11, drift=0.0008, vol=0.015)
    synthetic = market(closes, symbol="SPY", start="2015-01-02")
    bars = Bars("SPY", synthetic.dates, tuple(closes), tuple(closes), tuple(closes), tuple(closes), tuple(closes))
    params = Params(trend_length=50)
    variant = options_form.FORMS[0]
    form = options_form.form_of("SPY", variant, params, first=60)
    inputs = fm.Inputs({"SPY": bars}, {"SPY": synthetic.iv_index})
    book = fm.form_book(form, inputs, {"SPY": synthetic}, start=synthetic.dates[60])
    assert len(book.trades) >= 3
    result, gap, engine = options_form.book_options(book.trades, 100_000.0, list(synthetic.dates[60:]))
    assert gap <= 1e-6 and engine.startswith("nautilus-trader-")
    rows = options_form.trade_rows(result)
    assert [row["return"] for row in rows] == [trade["returnOnRisk"] for trade in result.trades]
    assert all(row["holdDays"] >= 1 for row in rows)
