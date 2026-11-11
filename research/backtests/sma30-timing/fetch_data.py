"""Fetch the public data for the 30-day moving average timing test.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/sma30-timing/fetch_data.py --out ~/Documents/reports/vertex-30dma/data

Output:
* french_daily.csv: date,mkt_rf,rf in percent per day, from the Kenneth R. French Data Library file
  F-F_Research_Data_Factors_daily_CSV.zip (CRSP value-weighted US market, nominal, total return).
* <SYMBOL>.adj.csv: daily open and close adjusted for splits and dividends, for SPY, BIL and SHV, with
  the header date,open,close,source (`source`: ibkr or yahoo per row).
  Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
  VERTEX_DEPLOY_STATUS_TOKEN set, IBKR ADJUSTED_LAST daily bars (split and dividend adjusted, about 30
  years back); Yahoo (auto_adjust=True) fills the dates before IBKR's first date, rescaled to IBKR's
  close on the seam date, and everything when IBKR fails or is not configured.
* manifest.json: row counts, date ranges and SHA-256 of every file; `sources` (rows per source, failed
  sources, seams) for the price files.
The data is not committed: the French library, IBKR and Yahoo terms do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

FRENCH = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_Factors_daily_CSV.zip"
YAHOO = ["SPY", "BIL", "SHV"]
START, END = "1993-01-01", "2026-10-30"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_french(out: Path) -> list[Path]:
    request = urllib.request.Request(FRENCH, headers={"User-Agent": "vertex-research/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 (fixed https URL)
        raw = response.read()
    archive = out / "F-F_Research_Data_Factors_daily_CSV.zip"
    archive.write_bytes(raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        text = zf.read(zf.namelist()[0]).decode("latin-1")
    path = out / "french_daily.csv"
    with path.open("w") as fh:
        fh.write("date,mkt_rf,rf\n")
        for line in text.splitlines():
            cells = [c.strip() for c in line.split(",")]
            if len(cells) >= 5 and len(cells[0]) == 8 and cells[0].isdigit():
                day = f"{cells[0][:4]}-{cells[0][4:6]}-{cells[0][6:]}"
                fh.write(f"{day},{cells[1]},{cells[4]}\n")
    return [archive, path]


def fetch_prices(symbol: str, out: Path) -> tuple[Path, dict]:
    def yahoo() -> list[dict]:
        frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=True, actions=False)
        return [{"date": ts.date().isoformat(), "open": float(row["Open"]), "high": float(row["High"]),
                 "low": float(row["Low"]), "close": float(row["Close"])} for ts, row in frame.iterrows()]

    merged = ih.merged_daily(symbol, yahoo, start=START, end=END, adjust="ohlc")
    path = out / f"{symbol}.adj.csv"
    with path.open("w") as fh:
        fh.write("date,open,close,source\n")
        for row in merged.rows:
            fh.write(f"{row['date']},{float(row['open'])!r},{float(row['close'])!r},{row['source']}\n")
    print(f"{symbol}: {ih.source_note(merged)}")
    return path, merged.summary()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    sources = dict(fetch_prices(s, out) for s in YAHOO)
    files = fetch_french(out) + list(sources)
    manifest = {}
    for path in files:
        lines = path.read_text().splitlines()[1:] if path.suffix == ".csv" else []
        days = sorted(line.split(",")[0] for line in lines)
        manifest[path.name] = {
            "sha256": sha256(path),
            **({"rows": len(days), "first": days[0], "last": days[-1]} if days else {}),
            **({"sources": sources[path]} if path in sources else {}),
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
