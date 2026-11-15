"""Fetch the daily bars and splits of the funds of the leveraged-ETF short-window study.

Research only. Network reads of free public data (Yahoo); writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 --with pydantic==2.13.4 \
      python research/backtests/leveraged-etf/fetch_data.py \
      --out ~/Documents/reports/vertex-leveraged-etf/data --end <day after the last complete session>
(pydantic is the dependency of services/research that importing the `strategies` package needs.)

Source: the helpers of research/backtests/options-forms/fetch_data.py, loaded from that file and not
copied: the qc-ports `_bars` (IBKR first when VERTEX_HISTORY_URL is set, Yahoo otherwise; this study
was fetched with Yahoo only), `yahoo_splits` and `split_rows`.

Symbols (imported from services/research/strategies/leveraged_etf/pairs.py, not typed here):
- every fund of the pair table: bars and splits;
- every unleveraged ETF of the table: splits only (its bars are the qc-ports files).

Output (not committed: the Yahoo terms do not allow redistribution), flat in --out:
- <FUND>.csv, header `date,open,high,low,close,adj_close`: `close` is split-adjusted and not
  dividend-adjusted, `adj_close` also adjusts dividends (the qc-ports file format).
- <SYMBOL>.splits.csv, header `date,ratio`: the effective date and Yahoo's ratio of every split
  (2.0 for 2-for-1, 0.25 for 1-for-4 reverse). The price that traded on a day = close x the product
  of the ratios of all splits after that day. A split on or after --end is in `close` but not in
  the file: the script prints a warning for it.
- LEVERAGED_ETF_SOURCES.json (rows per source and split count per symbol) and
  LEVERAGED_ETF_SHA256SUMS (sha256 of every file this script wrote).
A symbol that fails stops the script with an error: the study needs every fund of a pair.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FORMS_FETCH = ROOT / "research" / "backtests" / "options-forms" / "fetch_data.py"
SOURCES_NAME = "LEVERAGED_ETF_SOURCES.json"
SUMS_NAME = "LEVERAGED_ETF_SHA256SUMS"


def load_forms_fetch():
    """The options-forms fetch module, loaded from its file (its directory name is not an importable name)."""
    spec = importlib.util.spec_from_file_location("options_forms_fetch_data", FORMS_FETCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def study_symbols() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(funds, unleveraged ETFs) of the pair table."""
    sys.path.insert(0, str(ROOT / "services" / "research"))
    from strategies.leveraged_etf import pairs

    return pairs.fund_symbols(), pairs.underlyings()


def write_sums(out: Path, names: set[str]) -> None:
    lines = [f"{hashlib.sha256((out / name).read_bytes()).hexdigest()}  {name}" for name in sorted(names)]
    (out / SUMS_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="data directory of the study (flat, created)")
    parser.add_argument("--end", default=None, help="exclusive end date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    funds, etfs = study_symbols()

    import yfinance as yf

    forms = load_forms_fetch()
    qc = forms.load_qc_fetch()
    sources: dict[str, dict] = {}
    splits: dict[str, int] = {}
    written: set[str] = set()
    for symbol in (*funds, *etfs):
        split_lines, late = forms.split_rows(forms.yahoo_splits(yf, symbol), qc.START, args.end)
        (out / forms.splits_name(symbol)).write_text("\n".join(split_lines) + "\n", encoding="utf-8")
        written.add(forms.splits_name(symbol))
        splits[symbol] = len(split_lines) - 1
        if late:
            print(f"{symbol}: WARNING {late} split(s) on or after --end are in `close` but not in the splits file")
        if symbol in etfs:
            print(f"{symbol}: {splits[symbol]} splits (bars are the qc-ports files)")
            continue
        rows, summary = qc._bars(yf, symbol, args.end)
        if rows[0] != forms.HEADER or len(rows) < 2:
            raise SystemExit(f"no data for {symbol}")
        (out / f"{symbol}.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        written.add(f"{symbol}.csv")
        sources[f"{symbol}.csv"] = summary
        print(f"{symbol}: {len(rows) - 1} rows {rows[1].split(',')[0]} .. {rows[-1].split(',')[0]}, "
              f"{splits[symbol]} splits")
    manifest = {"files": sources, "splits": splits, "end": args.end}
    (out / SOURCES_NAME).write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    write_sums(out, written | {SOURCES_NAME})
    print(f"wrote {len(written) + 2} files to {out}")


if __name__ == "__main__":
    main()
