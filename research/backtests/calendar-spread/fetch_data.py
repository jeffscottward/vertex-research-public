"""Fetch the public data for the long calendar spread backtest (docs/specs/strategies/long-calendar-spread.md).

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/calendar-spread/fetch_data.py --out ~/Documents/reports/vertex-calendar-spread/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, the ETFs come from IBKR TRADES daily bars (split-adjusted, no dividends)
and the indices from IBKR IND bars on CBOE (VIX VIX3M VXN; IRX in percent). Yahoo (auto_adjust=False)
fills the dates before IBKR's first date and everything when IBKR fails or is not configured; the Cboe
daily CSV is the next fallback for the volatility indices, the US Treasury 3-month par yield for IRX.
Split events stay Yahoo only (IBKR history has no corporate actions feed).

Output, one file per symbol: <name>.csv with the header `date,close,source` (daily close, split-adjusted,
not dividend-adjusted; `source` is ibkr, yahoo, cboe or treasury per row; scripts/research/calendar-spread.ts
reads the first two columns). Names: SPY QQQ TQQQ SOXL VIX VIX3M VXN IRX.
For the four ETFs also <name>.splits.csv with the header `date,ratio` (Yahoo split events, e.g. 2 = 2-for-1),
so the backtest can price fixed per-share costs at the traded (unadjusted) price level.
SOURCES.json: rows per source, failed sources and seams of every <name>.csv.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

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


def yahoo_rows(symbol: str, end: str | None) -> list[dict]:
    frame = yf.Ticker(symbol).history(start=START, end=end, interval="1d", auto_adjust=False)
    return [{"date": stamp.strftime("%Y-%m-%d"), "close": float(close)}
            for stamp, close in frame["Close"].items() if close == close]  # skip NaN


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--end", default=None, help="exclusive end date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    sums: list[str] = []
    sources: dict[str, dict] = {}
    for name, symbol in SYMBOLS.items():
        merged = ih.merged_daily(symbol, lambda symbol=symbol: yahoo_rows(symbol, args.end),
                                 start=START, end=args.end)
        if not merged.rows:
            raise SystemExit(f"no data for {symbol}")
        lines = ["date,close,source"]
        lines += [f"{row['date']},{float(row['close']):.6f},{row['source']}" for row in merged.rows]
        path = out / f"{name}.csv"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        sources[path.name] = merged.summary()
        print(f"{name}: {len(lines) - 1} rows {lines[1][:10]} .. {lines[-1][:10]} ({ih.source_note(merged)})")
    for name in ETFS:
        splits = yf.Ticker(name).splits
        rows = ["date,ratio"] + [f"{stamp.strftime('%Y-%m-%d')},{float(ratio):g}" for stamp, ratio in splits.items()]
        path = out / f"{name}.splits.csv"
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
        print(f"{name} splits: {', '.join(rows[1:]) or 'none'}")
    path = out / "SOURCES.json"
    # No sort_keys: files in fetch order, rows newest source first (read in that order by labels).
    path.write_text(json.dumps(sources, indent=1) + "\n", encoding="utf-8")
    sums.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
