"""Fetch the public data for the QuantConnect-idea ports (docs/specs/strategies/qc-*.md).

Research only. Network reads of free public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
      python research/backtests/qc-ports/fetch_data.py --out ~/Documents/reports/vertex-qc-ports/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set: ETFs from IBKR TRADES joined with ADJUSTED_LAST (adj_close, about 30
years back), futures from IBKR CONTFUT (latest window; adj_close = close), indices from IBKR IND bars
(CBOE; IRX and TNX in percent). Yahoo (auto_adjust=False) fills the dates before IBKR's first date
(ETF adj_close rescaled to IBKR's on the seam date) and everything when IBKR fails or is not configured.
Index fallbacks after Yahoo: the CBOE public history CSV (volatility indices), then the US Treasury par
yield (IRX 3-month, TNX 10-year) only when nothing else reaches the start.

Output (not committed: the IBKR, Yahoo, CBOE and Shiller terms do not allow redistribution):
- <SYMBOL>.csv, header `date,open,high,low,close,adj_close`: daily bars for the Core 7 ETF twins
  (SPY QQQ DIA IWM GLD SLV USO) and futures (ES=F NQ=F YM=F RTY=F GC=F SI=F CL=F).
  `close` is split-adjusted and not dividend-adjusted (the price options strike against);
  `adj_close` also adjusts dividends (total return).
- <INDEX>.csv, header `date,close`: implied-volatility and rate indices VIX VIX3M VXN VXD GVZ OVX IRX
  TNX (Yahoo fallback) and RVX VXSLV (no Yahoo history: IBKR, then the CBOE CSV).
  The headers stay exact (scripts/market-series/import.ts refuses other columns), so the per-row source
  is recorded in SOURCES.json instead: rows per source, failed sources and seams of every file.
- SHILLER.csv, header `month,price,earnings`: Robert Shiller's monthly S&P composite price and trailing
  12-month earnings (shillerdata.com ie_data.xls).
- SHA256SUMS of every file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

ETFS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURES = ("ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F")
YAHOO_INDICES = {"VIX": "^VIX", "VIX3M": "^VIX3M", "VXN": "^VXN", "VXD": "^VXD", "GVZ": "^GVZ",
                 "OVX": "^OVX", "IRX": "^IRX", "TNX": "^TNX"}
CBOE_INDICES = ("RVX", "VXSLV")
CBOE_URL = ih.CBOE_URL  # read by ih.cboe_daily
SHILLER_PAGE = "https://shillerdata.com/"
START = "1990-01-01"
BAR_FIELDS = ("open", "high", "low", "close", "adj_close")
BAR_COLUMNS = ("Open", "High", "Low", "Close", "Adj Close")
AGENT = {"User-Agent": "Mozilla/5.0 (vertex-research; public data)"}


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=AGENT)
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed public https URLs
        return response.read()


def _bars(yf, symbol: str, end: str | None) -> tuple[list[str], dict]:
    def yahoo() -> list[dict]:
        frame = yf.Ticker(symbol).history(start=START, end=end, interval="1d", auto_adjust=False)
        return [{"date": stamp.strftime("%Y-%m-%d"),
                 **{key: float(row[col]) for key, col in zip(BAR_FIELDS, BAR_COLUMNS, strict=True)}}
                for stamp, row in frame.iterrows()]

    merged = ih.merged_daily(symbol, yahoo, start=START, end=end,
                             adjust="none" if symbol.endswith("=F") else "adj_close")
    if not merged.rows:
        raise SystemExit(f"no data for {symbol}")
    rows = ["date,open,high,low,close,adj_close"]
    for row in merged.rows:
        values = [row.get(key, row["close"]) for key in BAR_FIELDS]
        if all(value == value and value > 0 for value in values):  # skip NaN and zero rows
            rows.append(row["date"] + "," + ",".join(f"{float(value):.6f}" for value in values))
    return rows, merged.summary()


def _index(yf, name: str, end: str | None) -> tuple[list[str], dict]:
    def yahoo() -> list[dict]:
        frame = yf.Ticker(YAHOO_INDICES[name]).history(start=START, end=end, interval="1d", auto_adjust=False)
        return [{"date": stamp.strftime("%Y-%m-%d"), "close": float(close)} for stamp, close in frame["Close"].items()]

    merged = ih.index_daily(f"^{name}", yahoo if name in YAHOO_INDICES else None, start=START, end=end, fetch=_get)
    if not merged.rows:
        raise SystemExit(f"no data for {name}")
    rows = ["date,close"]
    rows += [f"{row['date']},{float(row['close']):.6f}" for row in merged.rows
             if row["close"] == row["close"] and row["close"] > 0]
    return rows, merged.summary()


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
    sources: dict[str, dict] = {}
    for symbol in ETFS + FUTURES:
        files[symbol], sources[f"{symbol}.csv"] = _bars(yf, symbol, args.end)
    for name in (*YAHOO_INDICES, *CBOE_INDICES):
        files[name], sources[f"{name}.csv"] = _index(yf, name, args.end)
    files["SHILLER"] = _shiller()
    sums: list[str] = []
    for name, rows in files.items():
        path = out / f"{name}.csv"
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        print(f"{name}: {len(rows) - 1} rows {rows[1].split(',')[0]} .. {rows[-1].split(',')[0]}")
    path = out / "SOURCES.json"
    # No sort_keys: files in fetch order, rows newest source first (read in that order by labels).
    path.write_text(json.dumps(sources, indent=1) + "\n", encoding="utf-8")
    sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
