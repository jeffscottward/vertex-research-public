"""Regenerate tests/fixtures/golden/golden-reference.json.

Not a test and not a runtime dependency. Run it in a throwaway virtual environment
that has pandas, numpy and TA-Lib, for example:

    uv venv -p 3.12 /tmp/golden-ref && uv pip install -p /tmp/golden-ref pandas numpy TA-Lib pydantic==2.13.4 tzdata
    /tmp/golden-ref/bin/python services/research/tests/golden/make_golden_reference.py
    bunx --bun --no-install biome format --write tests/fixtures/golden/golden-reference.json

The output holds:

- the independent pandas backtest results for every golden case;
- the first bar each reference indicator defines (warmup length);
- reference indicator values at fixed checkpoint bars: TA-Lib for SMA, EMA, LWMA,
  RSI, ATR, Bollinger Bands, Parabolic SAR, MACD, Stochastic and ADX; pandas for
  SMMA, which TA-Lib does not provide;
- the largest difference between the Vertex Python indicator library and the
  reference over every bar of both fixtures (evidence at generation time).
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import talib

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # services/research, for the Vertex indicator library

from pandas_reference import RsiReversion, SmaCross, backtest, load_bars  # noqa: E402
from pandas_reference import smma as pandas_smma  # noqa: E402

from indicators import (  # noqa: E402
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

ROOT = HERE.parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "golden"
SYMBOLS = ("SPY", "QQQ")
RULES = (SmaCross(fast=20, slow=50), RsiReversion(period=14, oversold=30, overbought=70))
COSTS = (0, 5)
CHECKPOINT_STEP = 50


def case_id(symbol: str, rule, cost: int) -> str:
    name = (
        f"sma-{rule.fast}-{rule.slow}"
        if isinstance(rule, SmaCross)
        else f"rsi-{rule.period}-{rule.oversold:g}-{rule.overbought:g}"
    )
    return f"{symbol}-{name}-{cost}bps"


def rule_record(rule) -> dict:
    if isinstance(rule, SmaCross):
        return {"kind": rule.kind, "fast": rule.fast, "slow": rule.slow}
    return {"kind": rule.kind, "period": rule.period, "oversold": rule.oversold, "overbought": rule.overbought}


def plain(values) -> list[float | None]:
    return [None if value is None or math.isnan(value) else float(value) for value in values]


def reference_series(bars: pd.DataFrame) -> dict[str, list[float | None]]:
    high = bars["high"].to_numpy()
    low = bars["low"].to_numpy()
    close = bars["close"].to_numpy()
    upper, middle, lower = talib.BBANDS(close, timeperiod=20, nbdevup=2, nbdevdn=2, matype=0)
    line, signal, histogram = talib.MACD(close, fastperiod=12, slowperiod=26, signalperiod=9)
    slow_k, slow_d = talib.STOCH(
        high, low, close, fastk_period=14, slowk_period=3, slowk_matype=0, slowd_period=3, slowd_matype=0
    )
    return {
        "sma_20": plain(talib.SMA(close, 20)),
        "sma_50": plain(talib.SMA(close, 50)),
        "ema_20": plain(talib.EMA(close, 20)),
        "smma_20": plain(pandas_smma(bars["close"], 20)),
        "lwma_20": plain(talib.WMA(close, 20)),
        "rsi_14": plain(talib.RSI(close, 14)),
        "atr_14": plain(talib.ATR(high, low, close, 14)),
        "bollinger_upper": plain(upper),
        "bollinger_middle": plain(middle),
        "bollinger_lower": plain(lower),
        "sar": plain(talib.SAR(high, low, acceleration=0.02, maximum=0.2)),
        "macd": plain(line),
        "macd_signal": plain(signal),
        "macd_histogram": plain(histogram),
        "stoch_k": plain(slow_k),
        "stoch_d": plain(slow_d),
        "plus_di": plain(talib.PLUS_DI(high, low, close, 14)),
        "minus_di": plain(talib.MINUS_DI(high, low, close, 14)),
        "adx": plain(talib.ADX(high, low, close, 14)),
    }


def library_series(bars: pd.DataFrame) -> dict[str, list[float | None]]:
    high = bars["high"].tolist()
    low = bars["low"].tolist()
    close = bars["close"].tolist()
    bands = bollinger_bands(close, 20, 2)
    lines = macd(close, 12, 26, 9)
    stoch = stochastic(high, low, close, 14, 3, 3)
    trend = adx(high, low, close, 14)
    return {
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


def parity(actual: list[float | None], expected: list[float | None]) -> dict:
    """Largest absolute and relative difference over every bar the reference defines."""
    worst_absolute = 0.0
    worst_relative = 0.0
    compared = 0
    missing = 0
    for left, right in zip(actual, expected, strict=True):
        if right is None:
            continue
        if left is None:
            missing += 1
            continue
        compared += 1
        difference = abs(left - right)
        worst_absolute = max(worst_absolute, difference)
        worst_relative = max(worst_relative, difference / max(abs(right), 1e-12))
    return {
        "comparedBars": compared,
        "missingBars": missing,
        "maxAbsDiff": worst_absolute,
        "maxRelDiff": worst_relative,
    }


def main() -> None:
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    cases = []
    checkpoints: dict[str, dict] = {}
    library_parity: dict[str, dict] = {}
    for symbol in SYMBOLS:
        path = FIXTURES / f"{symbol}-1d.csv"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != manifest["files"][symbol]["sha256"]:
            raise SystemExit(f"{path.name} does not match manifest.json")
        bars = load_bars(path)
        for rule in RULES:
            for cost in COSTS:
                result = backtest(bars, rule, cost)
                cases.append(
                    {
                        "id": case_id(symbol, rule, cost),
                        "symbol": symbol,
                        "rule": rule_record(rule),
                        "costBps": cost,
                        **result,
                    }
                )
        reference = reference_series(bars)
        indexes = list(range(0, len(bars), CHECKPOINT_STEP))
        if indexes[-1] != len(bars) - 1:
            indexes.append(len(bars) - 1)
        checkpoints[symbol] = {
            "indexes": indexes,
            "dates": [bars.index[index].date().isoformat() for index in indexes],
            "firstDefined": {
                name: next(index for index, value in enumerate(values) if value is not None)
                for name, values in reference.items()
            },
            "values": {name: [values[index] for index in indexes] for name, values in reference.items()},
        }
        library = library_series(bars)
        library_parity[symbol] = {name: parity(library[name], reference[name]) for name in reference}
    output = {
        "generator": "services/research/tests/golden/make_golden_reference.py",
        "backtestReference": (
            f"services/research/tests/golden/pandas_reference.py (pandas {pd.__version__}, numpy {np.__version__})"
        ),
        "indicatorReference": (
            f"TA-Lib C {talib.__ta_version__.decode().split()[0]} via Python TA-Lib {talib.__version__}; "
            f"smma_20 from pandas {pd.__version__}"
        ),
        "fixtures": {symbol: manifest["files"][symbol]["sha256"] for symbol in SYMBOLS},
        "cases": cases,
        "indicatorCheckpoints": checkpoints,
        "pythonLibraryParity": library_parity,
    }
    target = FIXTURES / "golden-reference.json"
    target.write_text(json.dumps(output, indent=1) + "\n", encoding="utf-8")
    for case in cases:
        stats = case["stats"]
        print(
            case["id"],
            stats["trades"],
            round(stats["finalEquity"], 4),
            round(stats["cagr"], 4),
            round(stats["maxDrawdown"], 4),
            stats["sharpe"],
        )
    for symbol, rows in library_parity.items():
        print(
            symbol,
            "worst rel diff",
            max(row["maxRelDiff"] for row in rows.values()),
            "missing",
            sum(row["missingBars"] for row in rows.values()),
        )


if __name__ == "__main__":
    main()
