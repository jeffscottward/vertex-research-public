"""Fetch daily bars (IBKR first, Yahoo fills gaps) and Yahoo dividends for the alert-template backtests.

Research only. Network read of public price data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/freestockalerts/fetch_yahoo.py --out ~/Documents/reports/vertex-strategies-buildout/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, stock and ETF bars come from IBKR TRADES (volume in shares) joined with
ADJUSTED_LAST (adj_close, about 30 years back; BRK-B is "BRK B"), ^VIX from IBKR IND on CBOE (then
Yahoo, then the Cboe CSV). Yahoo (auto_adjust=False) fills the dates before IBKR's first date
(adj_close rescaled to IBKR's on the seam date) and everything when IBKR fails or is not configured.
Dividends stay Yahoo only (IBKR history has no dividend feed), so the Yahoo download still runs per
symbol and a Yahoo failure is still retried and recorded as before.

Output per symbol: <SYMBOL>.csv with columns date,open,high,low,close,adj_close,volume,source
(OHLC split-adjusted, not dividend-adjusted; adj_close adds dividends; source ibkr, yahoo or cboe per
row) and <SYMBOL>.div.csv with ex_date,dividend (split-adjusted cash per share). manifest.json records
row counts, SHA-256 and `sources` (rows per source, failed sources, seams).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import yfinance as yf

from universe import ALL_SYMBOLS

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

START, END = "2005-01-01", "2026-10-24"
SOURCE = ("IBKR vertex-history first (TRADES + ADJUSTED_LAST, IND), Yahoo Finance via yfinance fills gaps; "
          "dividends Yahoo")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(symbol: str, out: Path) -> dict:
    frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=False, actions=True)
    yahoo = [{"date": ts.date().isoformat(), "open": row["Open"], "high": row["High"], "low": row["Low"],
              "close": row["Close"], "adj_close": row["Adj Close"], "volume": row["Volume"]}
             for ts, row in frame.iterrows()]
    merged = ih.merged_daily(symbol, lambda: yahoo, start=START, end=END, adjust="adj_close")
    if not merged.rows:
        return {"symbol": symbol, "rows": 0, "sources": merged.summary()}
    bars = out / f"{symbol}.csv"
    with bars.open("w") as fh:
        fh.write("date,open,high,low,close,adj_close,volume,source\n")
        for row in merged.rows:
            fh.write(f"{row['date']},{row['open']:.6f},{row['high']:.6f},{row['low']:.6f},"
                     f"{row['close']:.6f},{row.get('adj_close', row['close']):.6f},{int(row['volume'] or 0)},"
                     f"{row['source']}\n")
    divs = out / f"{symbol}.div.csv"
    with divs.open("w") as fh:
        fh.write("ex_date,dividend\n")
        for ts, value in frame["Dividends"].items():
            if value > 0:
                fh.write(f"{ts.date().isoformat()},{value:.6f}\n")
    return {"symbol": symbol, "rows": len(merged.rows), "first": merged.rows[0]["date"],
            "last": merged.rows[-1]["date"], "sha256": sha256(bars), "div_sha256": sha256(divs),
            "sources": merged.summary()}


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
    (out / "manifest.json").write_text(json.dumps({"source": SOURCE, "start": START,
                                                   "end": END, "symbols": manifest}, indent=1))
    print(sum(1 for m in manifest if m.get("rows")), "of", len(manifest), "symbols fetched")


if __name__ == "__main__":
    main()
