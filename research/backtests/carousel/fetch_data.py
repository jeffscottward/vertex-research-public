"""Fetch the public price data used to validate the carousel strategies.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
      python research/backtests/carousel/fetch_data.py --out ~/Documents/reports/vertex-ig-carousel-strategies/data

Output:
* <SYMBOL>.raw.csv: Yahoo daily OHLC, split-adjusted only, with cash dividends (auto_adjust=False).
* <SYMBOL>.adj.csv: Yahoo daily OHLC adjusted for splits and dividends (auto_adjust=True).
* chan/GLD.csv, chan/GDX.csv: date,adj_close from the GLD.xls and GDX.xls files that accompany
  Ernest Chan's *Quantitative Trading* example 3.6 (copy at github.com/egorpe/EPChan-QuantitativeTrading).
* manifest.json: row counts, date ranges and SHA-256 of every file.
The data is not committed: Yahoo terms and the book data licence do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from datetime import datetime
from pathlib import Path

import xlrd
import yfinance as yf

RAW = ["SPY"]
ADJUSTED = ["SPY", "QQQ", "AAPL", "MSFT", "JPM", "XLE"]
CHAN = "https://raw.githubusercontent.com/egorpe/EPChan-QuantitativeTrading/master/{name}.xls"
START, END = "1993-01-01", "2026-10-29"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_yahoo(symbol: str, adjusted: bool, out: Path) -> Path:
    frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=adjusted, actions=True)
    path = out / f"{symbol}.{'adj' if adjusted else 'raw'}.csv"
    with path.open("w") as fh:
        fh.write("date,open,high,low,close,dividend\n")
        for ts, row in frame.iterrows():
            values = ",".join(repr(float(row[col])) for col in ("Open", "High", "Low", "Close", "Dividends"))
            fh.write(f"{ts.date().isoformat()},{values}\n")
    return path


def fetch_chan(name: str, out: Path) -> Path:
    xls = out / f"{name}.xls"
    with urllib.request.urlopen(CHAN.format(name=name), timeout=60) as response:  # noqa: S310 (fixed https URL)
        xls.write_bytes(response.read())
    sheet = xlrd.open_workbook(str(xls)).sheet_by_index(0)
    header = [str(c) for c in sheet.row_values(0)]
    date_col, close_col = header.index("Date"), len(header) - 1  # the reference reads the last column
    path = out / f"{name}.csv"
    with path.open("w") as fh:
        fh.write("date,adj_close\n")
        for r in range(1, sheet.nrows):
            row = sheet.row_values(r)
            cell = row[date_col]
            day = (datetime.strptime(cell.strip(), "%m/%d/%Y").date() if isinstance(cell, str)
                   else xlrd.xldate_as_datetime(cell, sheet.book.datemode).date()).isoformat()
            fh.write(f"{day},{float(row[close_col])!r}\n")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    (out / "chan").mkdir(parents=True, exist_ok=True)
    files = [fetch_yahoo(s, False, out) for s in RAW] + [fetch_yahoo(s, True, out) for s in ADJUSTED]
    for name in ("GLD", "GDX"):
        files += [out / "chan" / f"{name}.xls", fetch_chan(name, out / "chan")]
    manifest = {}
    for path in files:
        lines = path.read_text().splitlines()[1:] if path.suffix == ".csv" else []
        days = sorted(line.split(",")[0] for line in lines)
        manifest[str(path.relative_to(out))] = {
            "sha256": sha256(path),
            **({"rows": len(days), "first": days[0], "last": days[-1]} if days else {}),
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
