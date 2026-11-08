"""Fetch the public data for the QuantConnect-idea ports (docs/specs/strategies/qc-*.md).

Research only. Network reads of free public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
      python research/backtests/qc-ports/fetch_data.py --out ~/Documents/reports/vertex-qc-ports/data

Output (not committed: the Yahoo, CBOE and Shiller terms do not allow redistribution):
- <SYMBOL>.csv, header `date,open,high,low,close,adj_close`: Yahoo daily bars, auto_adjust=False, for the
  Core 7 ETF twins (SPY QQQ DIA IWM GLD SLV USO) and futures (ES=F NQ=F YM=F RTY=F GC=F SI=F CL=F).
  `close` is split-adjusted and not dividend-adjusted (the price options strike against);
  `adj_close` also adjusts dividends (total return).
- <INDEX>.csv, header `date,close`: implied-volatility and rate indices. Yahoo for VIX VIX3M VXN VXD
  GVZ OVX IRX TNX; the CBOE public history CSV for RVX and VXSLV (Yahoo has no history for them).
- SHILLER.csv, header `month,price,earnings`: Robert Shiller's monthly S&P composite price and trailing
  12-month earnings (shillerdata.com ie_data.xls).
- SHA256SUMS of every file.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import re
import urllib.request
from datetime import datetime
from pathlib import Path

ETFS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURES = ("ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F")
YAHOO_INDICES = {"VIX": "^VIX", "VIX3M": "^VIX3M", "VXN": "^VXN", "VXD": "^VXD", "GVZ": "^GVZ",
                 "OVX": "^OVX", "IRX": "^IRX", "TNX": "^TNX"}
CBOE_INDICES = ("RVX", "VXSLV")
CBOE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{name}_History.csv"
SHILLER_PAGE = "https://shillerdata.com/"
START = "1990-01-01"
AGENT = {"User-Agent": "Mozilla/5.0 (vertex-research; public data)"}


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=AGENT)
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed public https URLs
        return response.read()


def _bars(yf, symbol: str, end: str | None) -> list[str]:
    frame = yf.Ticker(symbol).history(start=START, end=end, interval="1d", auto_adjust=False)
    if frame.empty:
        raise SystemExit(f"no data for {symbol}")
    rows = ["date,open,high,low,close,adj_close"]
    for stamp, row in frame.iterrows():
        values = [row["Open"], row["High"], row["Low"], row["Close"], row["Adj Close"]]
        if all(value == value and value > 0 for value in values):  # skip NaN and zero rows
            rows.append(stamp.strftime("%Y-%m-%d") + "," + ",".join(f"{float(value):.6f}" for value in values))
    return rows


def _index_yahoo(yf, symbol: str, end: str | None) -> list[str]:
    frame = yf.Ticker(symbol).history(start=START, end=end, interval="1d", auto_adjust=False)
    if frame.empty:
        raise SystemExit(f"no data for {symbol}")
    rows = ["date,close"]
    for stamp, close in frame["Close"].items():
        if close == close and close > 0:
            rows.append(f"{stamp.strftime('%Y-%m-%d')},{float(close):.6f}")
    return rows


def _index_cboe(name: str, end: str | None) -> list[str]:
    text = _get(CBOE_URL.format(name=name)).decode("utf-8")
    rows = ["date,close"]
    for record in csv.DictReader(io.StringIO(text)):
        day = datetime.strptime(record["DATE"], "%m/%d/%Y").strftime("%Y-%m-%d")
        close = float(record["CLOSE"])
        if close > 0 and (end is None or day < end):
            rows.append(f"{day},{close:.6f}")
    return rows


def _shiller() -> list[str]:
    import xlrd

    page = _get(SHILLER_PAGE).decode("utf-8", "ignore")
    match = re.search(r'href="([^"]*ie_data\.xls[^"]*)"', page)
    if match is None:
        raise SystemExit("ie_data.xls link not found on shillerdata.com")
    url = match.group(1)
    url = "https:" + url if url.startswith("//") else url
    book = xlrd.open_workbook(file_contents=_get(url))
    sheet = book.sheet_by_name("Data")
    rows = ["month,price,earnings"]
    for index in range(sheet.nrows):
        date_cell, price, earnings = sheet.cell_value(index, 0), sheet.cell_value(index, 1), sheet.cell_value(index, 3)
        if not isinstance(date_cell, float) or not isinstance(price, float) or not isinstance(earnings, float):
            continue
        year = int(date_cell)
        month = int(round((date_cell - year) * 100))
        if 1 <= month <= 12 and price > 0 and earnings > 0:
            rows.append(f"{year:04d}-{month:02d},{price:.4f},{earnings:.4f}")
    return rows


def main() -> None:
    import yfinance as yf

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--end", default=None, help="exclusive end date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    files: dict[str, list[str]] = {}
    for symbol in ETFS + FUTURES:
        files[symbol] = _bars(yf, symbol, args.end)
    for name, symbol in YAHOO_INDICES.items():
        files[name] = _index_yahoo(yf, symbol, args.end)
    for name in CBOE_INDICES:
        files[name] = _index_cboe(name, args.end)
    files["SHILLER"] = _shiller()
    sums: list[str] = []
    for name, rows in files.items():
        path = out / f"{name}.csv"
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        print(f"{name}: {len(rows) - 1} rows {rows[1].split(',')[0]} .. {rows[-1].split(',')[0]}")
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
