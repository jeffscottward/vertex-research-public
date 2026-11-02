"""Golden battery, Python side.

- Fixture integrity: the frozen CSVs match manifest.json and golden-reference.json.
- Vertex Python indicator library against the reference checkpoints on SPY and QQQ.
- The independent pandas reference has its own tests in test_golden_pandas_reference.py.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest

from indicators import (
    adx,
    atr,
    bollinger_bands,
    ema,
    lwma,
    macd,
    parabolic_sar,
    rsi,
    sma,
    smma,
    stochastic,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "golden"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())
REFERENCE = json.loads((FIXTURES / "golden-reference.json").read_text())
TOLERANCE = 1e-9
# Documented in docs/indicators.md: the MACD line starts at bar slow-1 and Stochastic %K at bar
# k+s-2, before TA-Lib. Every other series starts on the TA-Lib bar.
EARLY_START = {"macd": 25, "stoch_k": 15}


def within(actual, expected) -> bool:
    if actual is None or expected is None:
        return actual is expected
    return abs(actual - expected) <= TOLERANCE * max(1.0, abs(expected))


def adjusted_columns(symbol: str) -> dict[str, list[float]]:
    with (FIXTURES / f"{symbol}-1d.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    factors = [float(row["adj_close"]) / float(row["close"]) for row in rows]
    return {
        name: [float(row[name]) * factor for row, factor in zip(rows, factors, strict=True)]
        for name in ("open", "high", "low", "close")
    }


@pytest.mark.parametrize("symbol", ["SPY", "QQQ"])
def test_fixture_matches_manifest_and_reference(symbol):
    digest = hashlib.sha256((FIXTURES / f"{symbol}-1d.csv").read_bytes()).hexdigest()
    entry = MANIFEST["files"][symbol]
    assert digest == entry["sha256"] == REFERENCE["fixtures"][symbol]
    assert (entry["first"], entry["last"]) == ("2015-01-02", "2024-12-31")
    assert entry["rows"] == 2516


@pytest.mark.parametrize("symbol", ["SPY", "QQQ"])
def test_python_indicator_library_matches_reference_checkpoints(symbol):
    bars = adjusted_columns(symbol)
    high, low, close = bars["high"], bars["low"], bars["close"]
    bands = bollinger_bands(close, 20, 2)
    lines = macd(close, 12, 26, 9)
    stoch = stochastic(high, low, close, 14, 3, 3)
    trend = adx(high, low, close, 14)
    library = {
        "sma_20": sma(close, 20),
        "sma_50": sma(close, 50),
        "ema_20": ema(close, 20),
        "smma_20": smma(close, 20),
        "lwma_20": lwma(close, 20),
        "rsi_14": rsi(close, 14),
        "atr_14": atr(high, low, close, 14),
        "bollinger_upper": bands.upper,
        "bollinger_middle": bands.middle,
        "bollinger_lower": bands.lower,
        "sar": parabolic_sar(high, low, 0.02, 0.2),
        "macd": lines.macd,
        "macd_signal": lines.signal,
        "macd_histogram": lines.histogram,
        "stoch_k": stoch.k,
        "stoch_d": stoch.d,
        "plus_di": trend.plus_di,
        "minus_di": trend.minus_di,
        "adx": trend.adx,
    }
    checkpoints = REFERENCE["indicatorCheckpoints"][symbol]
    assert set(library) == set(checkpoints["values"])
    for name, series in library.items():
        first = next(index for index, value in enumerate(series) if value is not None)
        assert first == EARLY_START.get(name, checkpoints["firstDefined"][name]), (name, first)
        compared = 0
        for position, bar in enumerate(checkpoints["indexes"]):
            expected = checkpoints["values"][name][position]
            if expected is None:
                continue
            compared += 1
            assert within(series[bar], expected), (name, bar, series[bar], expected)
        assert compared > 40, name


def test_generation_time_parity_covers_every_bar():
    for symbol, rows in REFERENCE["pythonLibraryParity"].items():
        for name, row in rows.items():
            assert row["missingBars"] == 0, (symbol, name)
            assert row["comparedBars"] > 2400, (symbol, name)
            assert row["maxRelDiff"] <= TOLERANCE or row["maxAbsDiff"] <= TOLERANCE, (symbol, name)
