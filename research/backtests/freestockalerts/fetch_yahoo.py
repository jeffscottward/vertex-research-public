"""Fetch daily bars and dividends from Yahoo Finance for the alert-template backtests.

Research only. Network read of public price data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/freestockalerts/fetch_yahoo.py --out ~/Documents/reports/vertex-strategies-buildout/data

Output per symbol: <SYMBOL>.csv with columns date,open,high,low,close,adj_close,volume
(OHLC split-adjusted, not dividend-adjusted; adj_close adds dividends) and <SYMBOL>.div.csv with
ex_date,dividend (split-adjusted cash per share). manifest.json records row counts and SHA-256.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import yfinance as yf

from universe import ALL_SYMBOLS

START, END = "2005-01-01", "2026-10-24"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(symbol: str, out: Path) -> dict:
    frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=False, actions=True)
    if frame.empty:
        return {"symbol": symbol, "rows": 0}
    bars = out / f"{symbol}.csv"
    with bars.open("w") as fh:
        fh.write("date,open,high,low,close,adj_close,volume\n")
        for ts, row in frame.iterrows():
            fh.write(f"{ts.date().isoformat()},{row['Open']:.6f},{row['High']:.6f},{row['Low']:.6f},"
                     f"{row['Close']:.6f},{row['Adj Close']:.6f},{int(row['Volume'])}\n")
    divs = out / f"{symbol}.div.csv"
    with divs.open("w") as fh:
        fh.write("ex_date,dividend\n")
        for ts, value in frame["Dividends"].items():
            if value > 0:
                fh.write(f"{ts.date().isoformat()},{value:.6f}\n")
    return {"symbol": symbol, "rows": len(frame), "first": frame.index[0].date().isoformat(),
            "last": frame.index[-1].date().isoformat(), "sha256": sha256(bars), "div_sha256": sha256(divs)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for symbol in ALL_SYMBOLS:
        for attempt in range(3):
            try:
                manifest.append(fetch(symbol, out))
                break
            except Exception as exc:  # network errors: retry twice, then record the failure
                if attempt == 2:
                    manifest.append({"symbol": symbol, "rows": 0, "error": type(exc).__name__})
                time.sleep(2)
    (out / "manifest.json").write_text(json.dumps({"source": "Yahoo Finance via yfinance", "start": START,
                                                   "end": END, "symbols": manifest}, indent=1))
    print(sum(1 for m in manifest if m.get("rows")), "of", len(manifest), "symbols fetched")


if __name__ == "__main__":
    main()
