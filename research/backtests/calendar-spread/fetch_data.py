"""Fetch the public data for the long calendar spread backtest (docs/specs/strategies/long-calendar-spread.md).

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/calendar-spread/fetch_data.py --out ~/Documents/reports/vertex-calendar-spread/data

Output, one file per symbol: <name>.csv with the header `date,close` (Yahoo daily close, split-adjusted,
not dividend-adjusted: auto_adjust=False). Names: SPY QQQ TQQQ SOXL VIX VIX3M VXN IRX.
For the four ETFs also <name>.splits.csv with the header `date,ratio` (Yahoo split events, e.g. 2 = 2-for-1),
so the backtest can price fixed per-share costs at the traded (unadjusted) price level.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import yfinance as yf

SYMBOLS = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "TQQQ": "TQQQ",
    "SOXL": "SOXL",
    "VIX": "^VIX",
    "VIX3M": "^VIX3M",
    "VXN": "^VXN",
    "IRX": "^IRX",
}
START = "2010-01-01"
ETFS = ("SPY", "QQQ", "TQQQ", "SOXL")

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--end", default=None, help="exclusive end date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    sums: list[str] = []
    for name, symbol in SYMBOLS.items():
        frame = yf.Ticker(symbol).history(start=START, end=args.end, interval="1d", auto_adjust=False)
        if frame.empty:
            raise SystemExit(f"no data for {symbol}")
        lines = ["date,close"]
        for stamp, close in frame["Close"].items():
            if close == close:  # skip NaN
                lines.append(f"{stamp.strftime('%Y-%m-%d')},{float(close):.6f}")
        path = out / f"{name}.csv"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        print(f"{name}: {len(lines) - 1} rows {lines[1][:10]} .. {lines[-1][:10]}")
    for name in ETFS:
        splits = yf.Ticker(name).splits
        rows = ["date,ratio"] + [f"{stamp.strftime('%Y-%m-%d')},{float(ratio):g}" for stamp, ratio in splits.items()]
        path = out / f"{name}.splits.csv"
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        print(f"{name} splits: {', '.join(rows[1:]) or 'none'}")
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
