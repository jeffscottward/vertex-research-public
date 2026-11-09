"""Digests of the research views data.py loads, for the market-series parity check (research only).

Usage: python scripts/market-series/parity.py <data dir>
Prints JSON {view: {count, first, last, sha256}} for
- `<ID>`: data.load_series(ID), date -> close, for the 25 series ids;
- `<SYM>#bars`: data.load_bars(SYM) (date, open, high, low, close, adj_close) for ETFs and futures;
- `<ETF>:TR`: date -> adj_close of data.load_bars(ETF).
Each digest is SHA-256 over the rows in load order: the ASCII date, then every value as a
big-endian IEEE-754 double, so equal digests mean bit-identical values. data.py is loaded from its
file, so the qc_ports package (and its heavier imports) is not needed.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

DATA_PY = Path(__file__).resolve().parents[2] / "services" / "research" / "strategies" / "qc_ports" / "data.py"


def _data_module():
    spec = importlib.util.spec_from_file_location("qc_ports_data", DATA_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve their module by name
    spec.loader.exec_module(module)
    return module


def _digest(rows: list[tuple[str, tuple[float, ...]]]) -> dict:
    sha = hashlib.sha256()
    for date, values in rows:
        sha.update(date.encode("ascii"))
        sha.update(struct.pack(f">{len(values)}d", *values))
    return {
        "count": len(rows),
        "first": rows[0][0] if rows else None,
        "last": rows[-1][0] if rows else None,
        "sha256": sha.hexdigest(),
    }


def main() -> None:
    root = sys.argv[1]
    data = _data_module()
    views: dict[str, dict] = {}
    for series_id in data.SERIES_IDS:
        views[series_id] = _digest([(date, (value,)) for date, value in data.load_series(series_id, root).items()])
    for symbol in data.ETF_SYMBOLS + data.FUTURES:
        bars = data.load_bars(symbol, root)
        views[f"{symbol}#bars"] = _digest(
            [(bars.dates[i], (bars.open[i], bars.high[i], bars.low[i], bars.close[i], bars.adj_close[i]))
             for i in range(len(bars))]
        )
        if symbol in data.ETF_SYMBOLS:
            views[f"{symbol}:TR"] = _digest([(bars.dates[i], (bars.adj_close[i],)) for i in range(len(bars))])
    json.dump(views, sys.stdout, sort_keys=True)


if __name__ == "__main__":
    main()
