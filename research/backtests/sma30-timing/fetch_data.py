"""Fetch the public data for the 30-day moving average timing test.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/sma30-timing/fetch_data.py --out ~/Documents/reports/vertex-30dma/data

Output:
* french_daily.csv: date,mkt_rf,rf in percent per day, from the Kenneth R. French Data Library file
  F-F_Research_Data_Factors_daily_CSV.zip (CRSP value-weighted US market, nominal, total return).
* <SYMBOL>.adj.csv: Yahoo daily open and close adjusted for splits and dividends
  (auto_adjust=True), for SPY, BIL and SHV.
* manifest.json: row counts, date ranges and SHA-256 of every file.
The data is not committed: the French library and Yahoo terms do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import urllib.request
import zipfile
from pathlib import Path

import yfinance as yf

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


def fetch_yahoo(symbol: str, out: Path) -> Path:
    frame = yf.Ticker(symbol).history(start=START, end=END, interval="1d", auto_adjust=True, actions=False)
    path = out / f"{symbol}.adj.csv"
    with path.open("w") as fh:
        fh.write("date,open,close\n")
        for ts, row in frame.iterrows():
            fh.write(f"{ts.date().isoformat()},{float(row['Open'])!r},{float(row['Close'])!r}\n")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    files = fetch_french(out) + [fetch_yahoo(s, out) for s in YAHOO]
    manifest = {}
    for path in files:
        lines = path.read_text().splitlines()[1:] if path.suffix == ".csv" else []
        days = sorted(line.split(",")[0] for line in lines)
        manifest[path.name] = {
            "sha256": sha256(path),
            **({"rows": len(days), "first": days[0], "last": days[-1]} if days else {}),
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
