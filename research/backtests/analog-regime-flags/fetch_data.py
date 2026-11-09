"""Fetch the public data for the analog and seasonal regime flag tests.

Research only. Network reads of public data; writes local CSV files; places no orders.
Spec: docs/specs/research/analog-regime-flags.md (rules G1 to G5).
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/analog-regime-flags/fetch_data.py --out ~/Documents/reports/vertex-analog-regime/data

Output:
* <NAME>.csv with the header date,close,adj_close: Yahoo daily bars (auto_adjust=False) of QQQ, SPY,
  ^NDX (NDX.csv), ^GSPC (GSPC.csv) and ^IRX (IRX.csv). `close` is split-adjusted without dividends.
* <SERIES>.csv with the header date,value: FRED fredgraph.csv of WALCL, WDTGAL and RRPONTSYD. A blank
  value (no observation) stays blank.
* manifest.json: row counts, date ranges and SHA-256 of every file.
The data is not committed: Yahoo terms do not allow redistribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import urllib.request
from pathlib import Path

import yfinance as yf

YAHOO = {"QQQ": "QQQ", "SPY": "SPY", "NDX": "^NDX", "GSPC": "^GSPC", "IRX": "^IRX"}
FRED = ("WALCL", "WDTGAL", "RRPONTSYD")
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd=1990-01-01"
# The last bar is 2026-11-06 (Yahoo `end` is exclusive). A fixed end keeps a later fetch comparable.
END = "2026-11-07"
LAST = "2026-11-06"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_yahoo(name: str, symbol: str, out: Path) -> Path:
    frame = yf.Ticker(symbol).history(period="max", end=END, interval="1d", auto_adjust=False, actions=False)
    path = out / f"{name}.csv"
    with path.open("w") as fh:
        fh.write("date,close,adj_close\n")
        for ts, row in frame.iterrows():
            close, adjusted = float(row["Close"]), float(row["Adj Close"])
            if math.isnan(close) or math.isnan(adjusted):
                continue
            fh.write(f"{ts.date().isoformat()},{close!r},{adjusted!r}\n")
    return path


def fetch_fred(series: str, out: Path) -> Path:
    # FRED does not answer every client: the default python-requests agent gets the file.
    request = urllib.request.Request(FRED_CSV.format(series=series),
                                     headers={"User-Agent": "python-requests/2.32.3", "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=45) as response:  # noqa: S310 (fixed https URL)
        lines = response.read().decode().splitlines()
    if not lines or not lines[0].endswith(f",{series}"):
        raise ValueError(f"unexpected fredgraph.csv header for {series}: {lines[:1]!r}")
    path = out / f"{series}.csv"
    with path.open("w") as fh:
        fh.write("date,value\n")
        for line in lines[1:]:
            day, _, value = line.partition(",")
            if day <= LAST:
                fh.write(f"{day},{'' if value in ('', '.') else value}\n")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    files = [fetch_yahoo(name, symbol, out) for name, symbol in YAHOO.items()]
    files += [fetch_fred(series, out) for series in FRED]
    manifest = {}
    for path in files:
        days = [line.split(",")[0] for line in path.read_text().splitlines()[1:]]
        manifest[path.name] = {"sha256": sha256(path), "rows": len(days), "first": days[0], "last": days[-1]}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
