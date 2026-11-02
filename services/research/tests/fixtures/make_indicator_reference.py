"""Regenerate indicator-reference.json from TA-Lib.

Not a test and not a runtime dependency. Run it only in a throwaway virtual
environment that has TA-Lib and numpy, for example:

    uv venv /tmp/talib-ref && uv pip install -p /tmp/talib-ref numpy TA-Lib
    /tmp/talib-ref/bin/python services/research/tests/fixtures/make_indicator_reference.py
    bunx --bun --no-install biome format --write services/research/tests/fixtures/indicator-reference.json

The bars are a deterministic synthetic series (no market data, no provider).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import talib

ROWS = 80


def bars() -> dict[str, list[float]]:
    opens: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    closes: list[float] = []
    volumes: list[float] = []
    previous = 100.0
    for index in range(ROWS):
        close = round(100 + 10 * math.sin(index / 5) + 3 * math.cos(index / 1.7) + index * 0.1, 2)
        open_ = round(previous, 2)
        high = round(max(open_, close) + 0.4 + 0.3 * abs(math.sin(index * 1.3)), 2)
        low = round(min(open_, close) - 0.4 - 0.3 * abs(math.cos(index * 0.9)), 2)
        opens.append(open_)
        highs.append(high)
        lows.append(low)
        closes.append(close)
        volumes.append(float(1000 + (index * 37) % 400))
        previous = close
    return {"open": opens, "high": highs, "low": lows, "close": closes, "volume": volumes}


def series(values: np.ndarray) -> list[float | None]:
    return [None if math.isnan(value) else float(value) for value in values]


def main() -> None:
    data = bars()
    high = np.array(data["high"])
    low = np.array(data["low"])
    close = np.array(data["close"])
    upper, middle, lower = talib.BBANDS(close, timeperiod=20, nbdevup=2, nbdevdn=2, matype=0)
    line, signal, histogram = talib.MACD(close, fastperiod=12, slowperiod=26, signalperiod=9)
    slow_k, slow_d = talib.STOCH(
        high, low, close, fastk_period=14, slowk_period=3, slowk_matype=0, slowd_period=3, slowd_matype=0
    )
    reference = {
        "source": f"TA-Lib C {talib.__ta_version__.decode().split()[0]} via Python TA-Lib {talib.__version__}",
        "generator": "services/research/tests/fixtures/make_indicator_reference.py",
        "bars": data,
        "expected": {
            "sma_10": series(talib.SMA(close, 10)),
            "ema_10": series(talib.EMA(close, 10)),
            "lwma_10": series(talib.WMA(close, 10)),
            "rsi_14": series(talib.RSI(close, 14)),
            "true_range": series(talib.TRANGE(high, low, close)),
            "atr_14": series(talib.ATR(high, low, close, 14)),
            "bollinger_20_2": {"upper": series(upper), "middle": series(middle), "lower": series(lower)},
            "sar_002_02": series(talib.SAR(high, low, acceleration=0.02, maximum=0.2)),
            "macd_12_26_9": {"macd": series(line), "signal": series(signal), "histogram": series(histogram)},
            "stochastic_14_3_3": {"k": series(slow_k), "d": series(slow_d)},
            "adx_14": {
                "plus_di": series(talib.PLUS_DI(high, low, close, 14)),
                "minus_di": series(talib.MINUS_DI(high, low, close, 14)),
                "adx": series(talib.ADX(high, low, close, 14)),
            },
        },
    }
    target = Path(__file__).with_name("indicator-reference.json")
    target.write_text(json.dumps(reference, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
