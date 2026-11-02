"""Fetch the public Yahoo price data used to re-run the QuantJourney strategy library.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/quantjourney/fetch_data.py --out ~/Documents/reports/vertex-quantsmd/data

Output:
* daily/<SYMBOL>.csv: Yahoo daily bars, columns date,open,high,low,close,adj_close,volume.
  open/high/low/close are split-adjusted only; adj_close also includes dividends (auto_adjust=False).
* hourly/<SYMBOL>.csv: Yahoo 60-minute bars for the one intraday window that Yahoo still serves
  (W09, 2026-05-11 to 2026-07-10). Columns timestamp (UTC ISO),open,high,low,close,adj_close,volume.
* manifest.json: row counts, date ranges and SHA-256 of every file.
The data is not committed: the Yahoo terms do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

# Union of every daily universe and benchmark in research/backtests/quantjourney/library.json.
DAILY = [
    "SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "IEF", "GLD", "DBC", "VNQ",
    "XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY", "KO", "PEP", "EWA", "EWC",
    "EURUSD=X", "GBPUSD=X", "AUDUSD=X", "NZDUSD=X", "DX-Y.NYB",
    "MES=F", "MNQ=F", "CL=F", "GC=F", "ZN=F", "ZC=F",
]
HOURLY = ["SPY", "QQQ", "IWM"]
DAILY_START, DAILY_END = "1999-01-01", "2026-07-16"
HOURLY_START, HOURLY_END = "2026-05-01", "2026-07-15"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(frame, path: Path, *, intraday: bool) -> dict:
    with path.open("w") as fh:
        fh.write(("timestamp" if intraday else "date") + ",open,high,low,close,adj_close,volume\n")
        for ts, row in frame.iterrows():
            stamp = ts.tz_convert("UTC").isoformat() if intraday else ts.date().isoformat()
            values = ",".join(repr(float(row[col])) for col in ("Open", "High", "Low", "Close", "Adj Close", "Volume"))
            fh.write(f"{stamp},{values}\n")
    rows = len(frame)
    first = str(frame.index[0]) if rows else None
    last = str(frame.index[-1]) if rows else None
    return {"rows": rows, "first": first, "last": last, "sha256": sha256(path)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    (args.out / "daily").mkdir(parents=True, exist_ok=True)
    (args.out / "hourly").mkdir(parents=True, exist_ok=True)
    files: dict[str, dict] = {}
    for symbol in DAILY:
        frame = yf.Ticker(symbol).history(start=DAILY_START, end=DAILY_END, interval="1d",
                                          auto_adjust=False, actions=False)
        files[f"daily/{symbol}.csv"] = write(frame, args.out / "daily" / f"{symbol}.csv", intraday=False)
    for symbol in HOURLY:
        frame = yf.Ticker(symbol).history(start=HOURLY_START, end=HOURLY_END, interval="60m",
                                          auto_adjust=False, actions=False, prepost=False)
        files[f"hourly/{symbol}.csv"] = write(frame, args.out / "hourly" / f"{symbol}.csv", intraday=True)
    manifest = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Yahoo Finance via yfinance 0.2.66",
        "daily_window": [DAILY_START, DAILY_END],
        "hourly_window": [HOURLY_START, HOURLY_END],
        "files": files,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v["rows"] for k, v in files.items()}))


if __name__ == "__main__":
    main()
