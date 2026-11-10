"""Fetch the public price data used to validate the carousel strategies.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
      python research/backtests/carousel/fetch_data.py --out ~/Documents/reports/vertex-ig-carousel-strategies/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, <SYMBOL>.raw.csv bars come from IBKR TRADES (split-adjusted) and
<SYMBOL>.adj.csv bars from IBKR ADJUSTED_LAST (split and dividend adjusted, about 30 years back). Yahoo
fills the dates before IBKR's first date (adjusted Yahoo prices rescaled to IBKR's on the seam date) and
everything when IBKR fails or is not configured. Cash dividends stay Yahoo only (IBKR history has no
dividend feed), so the Yahoo download still runs and a Yahoo failure still stops the script.

Output:
* <SYMBOL>.raw.csv: daily OHLC, split-adjusted only, with cash dividends (Yahoo auto_adjust=False twin).
* <SYMBOL>.adj.csv: daily OHLC adjusted for splits and dividends (Yahoo auto_adjust=True twin).
  Both have the header date,open,high,low,close,dividend,source (`source`: ibkr or yahoo per row).
* chan/GLD.csv, chan/GDX.csv: date,adj_close from the GLD.xls and GDX.xls files that accompany
  Ernest Chan's *Quantitative Trading* example 3.6 (copy at github.com/egorpe/EPChan-QuantitativeTrading).
* manifest.json: row counts, date ranges and SHA-256 of every file; `sources` (rows per source, failed
  sources, seams) for the price files.
The data is not committed: Yahoo and IBKR terms and the book data licence do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import xlrd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

RAW = ["SPY"]
ADJUSTED = ["SPY", "QQQ", "AAPL", "MSFT", "JPM", "XLE"]
CHAN = "https://raw.githubusercontent.com/egorpe/EPChan-QuantitativeTrading/master/{name}.xls"
START, END = "1993-01-01", "2026-10-29"
PRICES = ("Open", "High", "Low", "Close")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_prices(symbol: str, adjusted: bool, out: Path) -> tuple[Path, dict]:
    frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=adjusted, actions=True)
    yahoo = [{"date": ts.date().isoformat(), **{col.lower(): float(row[col]) for col in PRICES},
              "dividend": float(row["Dividends"])} for ts, row in frame.iterrows()]
    dividends = {row["date"]: row["dividend"] for row in yahoo}
    merged = ih.merged_daily(symbol, lambda: yahoo, start=START, end=END, adjust="ohlc" if adjusted else "none")
    path = out / f"{symbol}.{'adj' if adjusted else 'raw'}.csv"
    with path.open("w") as fh:
        fh.write("date,open,high,low,close,dividend,source\n")
        for row in merged.rows:
            dividend = row["dividend"] if row["source"] == "yahoo" else dividends.get(row["date"], 0.0)
            values = ",".join(repr(float(value)) for value in (*(row[col.lower()] for col in PRICES), dividend))
            fh.write(f"{row['date']},{values},{row['source']}\n")
    print(f"{path.name}: {ih.source_note(merged)}")
    return path, merged.summary()


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
    sources = dict([fetch_prices(s, False, out) for s in RAW] + [fetch_prices(s, True, out) for s in ADJUSTED])
    files = list(sources)
    for name in ("GLD", "GDX"):
        files += [out / "chan" / f"{name}.xls", fetch_chan(name, out / "chan")]
    manifest = {}
    for path in files:
        lines = path.read_text().splitlines()[1:] if path.suffix == ".csv" else []
        days = sorted(line.split(",")[0] for line in lines)
        manifest[str(path.relative_to(out))] = {
            "sha256": sha256(path),
            **({"rows": len(days), "first": days[0], "last": days[-1]} if days else {}),
            **({"sources": sources[path]} if path in sources else {}),
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
