"""Fetch the public Cboe implied-volatility indices of the Core 7 ETF twins (research only).

    uv run --no-project --python 3.12 --with yfinance==0.2.66 \
        python research/backtests/volsizing/fetch_ivx.py --out ~/Documents/reports/vertex-core7/data

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, IBKR IND daily bars on CBOE; Yahoo (period max) fills the dates before
IBKR's first date and everything when IBKR fails or is not configured; the Cboe published daily CSV
(cdn.cboe.com) fills what is still earlier (it is the only history source for RVX and VXSLV when IBKR
is unavailable, Yahoo has none).

Writes <out>/ivx/<ETF>.csv (date,close,index,source; close in index points, i.e. vol x 100; source
ibkr, yahoo or cboe per row) and <out>/ivx/sources.json (rows per source, failed sources, seams). The
data stays out of the repository (IBKR, Yahoo and Cboe terms do not allow redistribution). Where an
index is missing for a date, volsizing.py falls back to its realized-vol proxy.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

INDEX_OF = {"SPY": "^VIX", "QQQ": "^VXN", "DIA": "^VXD", "IWM": "^RVX", "GLD": "^GVZ",
            "SLV": "^VXSLV", "USO": "^OVX"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    folder = args.out.expanduser() / "ivx"
    folder.mkdir(parents=True, exist_ok=True)
    sources: dict[str, dict] = {}
    for etf, index in INDEX_OF.items():
        def yahoo(index: str = index) -> list[dict]:
            frame = yf.Ticker(index).history(period="max", interval="1d", auto_adjust=False)
            return [{"date": ts.date().isoformat(), "close": float(close)} for ts, close in frame["Close"].items()]

        try:
            merged = ih.index_daily(index, yahoo)
        except Exception as error:  # noqa: BLE001 - every source failed: an empty file, volsizing uses its proxy
            merged = ih.Merged([], errors={"all": f"{type(error).__name__}: {str(error)[:200]}"})
        rows = [(row["date"], float(row["close"]), row["source"]) for row in merged.rows
                if row["close"] == row["close"] and row["close"] > 0]
        with (folder / f"{etf}.csv").open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["date", "close", "index", "source"])
            writer.writerows((d, c, index, source) for d, c, source in rows)
        sources[f"{etf}.csv"] = merged.summary()
        print(etf, index, len(rows), rows[0][0] if rows else "-", rows[-1][0] if rows else "-",
              ih.source_note(merged))
    (folder / "sources.json").write_text(json.dumps(sources, indent=1, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
