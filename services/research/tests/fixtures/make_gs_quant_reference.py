"""Regenerate gs-quant-reference.json from gs-quant 2.2.4.

Not a test and not a runtime dependency. Run it from services/research in a
virtual environment made from requirements-gsquant-linux-py312.lock:

    python tests/fixtures/make_gs_quant_reference.py
    bunx --bun --no-install biome format --write services/research/tests/fixtures/gs-quant-reference.json

Input: the closes of indicator-reference.json (deterministic synthetic bars, no
market data). Output: gs-quant ``zscores`` and ``volatility`` (simple returns,
annualization factor 252) with a window of 5 and 20 bars. Values over partial
windows are null, as in the Vertex kernels. tests/test_gs_quant.py checks that
this file still equals live gs-quant output.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
WINDOWS = (5, 20)


def reference() -> dict:
    import pandas as pd
    from gs_quant.timeseries import econometrics, statistics
    from gs_quant.timeseries.helper import Window

    closes = json.loads((HERE / "indicator-reference.json").read_text())["bars"]["close"]
    x = pd.Series(closes, index=pd.bdate_range("2024-01-01", periods=len(closes)), dtype=float)

    def masked(series, first: int) -> list[float | None]:
        values = series.reindex(x.index).tolist()
        return [None if index < first or math.isnan(value) else value for index, value in enumerate(values)]

    expected = {}
    for window in WINDOWS:
        expected[f"zscore_{window}"] = masked(statistics.zscores(x, Window(window, 0)), window - 1)
        expected[f"realized_vol_{window}"] = masked(
            econometrics.volatility(x, Window(window, 0), annualization_factor=252), window
        )
    return {
        "source": "closes of indicator-reference.json (synthetic)",
        "generator": "tests/fixtures/make_gs_quant_reference.py with gs-quant 2.2.4",
        "expected": expected,
    }


if __name__ == "__main__":
    (HERE / "gs-quant-reference.json").write_text(json.dumps(reference(), indent=2) + "\n")
