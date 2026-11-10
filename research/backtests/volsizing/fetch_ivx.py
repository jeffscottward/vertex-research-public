"""Fetch the public Cboe implied-volatility indices of the Core 7 ETF twins (research only).

    uv run --no-project --python 3.12 --with yfinance==0.2.66 \
        python research/backtests/volsizing/fetch_ivx.py --out ~/Documents/reports/vertex-core7/data

Writes <out>/ivx/<ETF>.csv (date,close in index points, i.e. vol x 100). The data stays out of
the repository (Yahoo terms do not allow redistribution). Where an index is missing for a date,
volsizing.py falls back to its realized-vol proxy.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import yfinance as yf

INDEX_OF = {"SPY": "^VIX", "QQQ": "^VXN", "DIA": "^VXD", "IWM": "^RVX", "GLD": "^GVZ",
            "SLV": "^VXSLV", "USO": "^OVX"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    folder = args.out.expanduser() / "ivx"
    folder.mkdir(parents=True, exist_ok=True)
    for etf, index in INDEX_OF.items():
        frame = yf.Ticker(index).history(period="max", interval="1d", auto_adjust=False)
        rows = [(ts.date().isoformat(), float(close)) for ts, close in frame["Close"].items()
                if close == close and close > 0]
        with (folder / f"{etf}.csv").open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["date", "close", "index"])
            writer.writerows((d, c, index) for d, c in rows)
        print(etf, index, len(rows), rows[0][0] if rows else "-", rows[-1][0] if rows else "-")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
