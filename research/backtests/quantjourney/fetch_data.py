"""Fetch the price data used to re-run the QuantJourney strategy library (IBKR first, Yahoo fills gaps).

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/quantjourney/fetch_data.py --out ~/Documents/reports/vertex-quantsmd/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, the daily files come from IBKR: stocks and ETFs TRADES joined with
ADJUSTED_LAST (adj_close, about 30 years back), forex pairs CASH MIDPOINT on IDEALPRO (adj_close =
close, volume 0), futures CONTFUT (latest window; adj_close = close). Yahoo (auto_adjust=False) fills
the dates before IBKR's first date (adj_close rescaled to IBKR's on the seam date) and everything when
IBKR fails or is not configured. DX-Y.NYB has no IBKR mapping and stays Yahoo. The hourly files stay
Yahoo: IBKR's regular-hours 1 hour bars start on the clock hour after a 09:30-10:00 bar, Yahoo's at
:30, so the two cannot be merged bar for bar.

Output:
* daily/<SYMBOL>.csv: daily bars, columns date,open,high,low,close,adj_close,volume,source.
  open/high/low/close are split-adjusted only; adj_close also includes dividends. `source` is ibkr or
  yahoo per row (scripts/research/quantjourney.ts parsePriceCsv reads the first six columns).
* hourly/<SYMBOL>.csv: Yahoo 60-minute bars for the one intraday window that Yahoo still serves
  (W09, 2026-05-11 to 2026-07-10). Columns timestamp (UTC ISO),open,high,low,close,adj_close,volume.
* manifest.json: row counts, date ranges and SHA-256 of every file; `sources` per daily file (rows per
  source, failed sources, seams).
The data is not committed: the IBKR and Yahoo terms do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

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
FIELDS = ("open", "high", "low", "close", "adj_close", "volume")
COLUMNS = ("Open", "High", "Low", "Close", "Adj Close", "Volume")


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


def manifest_source(files: dict) -> str:
    """The manifest's source line: the old Yahoo label unless IBKR answered for some daily file."""
    if not ih.answered(entry.get("sources") for entry in files.values()):
        return "Yahoo Finance via yfinance 0.2.66"
    return "daily: sources per file, see files.<FILE>.sources; hourly: Yahoo Finance via yfinance 0.2.66"


def fetch_daily(symbol: str, path: Path) -> dict:
    def yahoo() -> list[dict]:
        frame = yf.Ticker(symbol).history(start=DAILY_START, end=DAILY_END, interval="1d",
                                          auto_adjust=False, actions=False)
        return [{"date": ts.date().isoformat(),
                 **{key: float(row[col]) for key, col in zip(FIELDS, COLUMNS, strict=True)}}
                for ts, row in frame.iterrows()]

    contract = ih.contract_for(symbol)
    adjust = "adj_close" if contract is not None and contract.sec_type == "STK" else "none"
    merged = ih.merged_daily(symbol, yahoo, start=DAILY_START, end=DAILY_END, adjust=adjust)
    with path.open("w") as fh:
        fh.write("date,open,high,low,close,adj_close,volume,source\n")
        for row in merged.rows:
            values = [row.get(key) for key in FIELDS]
            values[4] = row.get("adj_close", row["close"])
            values[5] = 0.0 if values[5] is None else values[5]  # IBKR forex and index bars carry no volume
            fh.write(f"{row['date']},{','.join(repr(float(value)) for value in values)},{row['source']}\n")
    print(f"{symbol}: {ih.source_note(merged)}")
    days = [row["date"] for row in merged.rows]
    return {"rows": len(days), "first": days[0] if days else None, "last": days[-1] if days else None,
            "sha256": sha256(path), "sources": merged.summary()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    (args.out / "daily").mkdir(parents=True, exist_ok=True)
    (args.out / "hourly").mkdir(parents=True, exist_ok=True)
    files: dict[str, dict] = {}
    for symbol in DAILY:
        files[f"daily/{symbol}.csv"] = fetch_daily(symbol, args.out / "daily" / f"{symbol}.csv")
    for symbol in HOURLY:
        frame = yf.Ticker(symbol).history(start=HOURLY_START, end=HOURLY_END, interval="60m",
                                          auto_adjust=False, actions=False, prepost=False)
        files[f"hourly/{symbol}.csv"] = write(frame, args.out / "hourly" / f"{symbol}.csv", intraday=True)
    manifest = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": manifest_source(files),
        "daily_window": [DAILY_START, DAILY_END],
        "hourly_window": [HOURLY_START, HOURLY_END],
        "files": files,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v["rows"] for k, v in files.items()}))


if __name__ == "__main__":
    main()
