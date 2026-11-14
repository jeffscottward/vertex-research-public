"""Fetch the daily bars of the extra underlyings of the options-forms study into a qc-ports data directory.

Research only. Network reads of free public data; writes local CSV files; places no orders.
Run (rig), after research/backtests/qc-ports/fetch_data.py has filled the same directory:
  uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 --with pydantic==2.13.4 \
      python research/backtests/options-forms/fetch_data.py --out <dir> --end <date>
(pydantic is the dependency of services/research that importing strategies.qc_ports needs.)

Source: the qc-ports helper `_bars` (research/backtests/qc-ports/fetch_data.py), loaded from its file and
not copied: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py); Yahoo only when
VERTEX_HISTORY_URL is not set.

Symbols (imported, not copied):
- --etfs, default: the ETF keys of PROXY_MODELS in services/research/strategies/qc_ports/forms.py (all
  keys except KO and PEP). An ETF that fails stops the script with an error.
- --stocks, default: SP100 of research/backtests/freestockalerts/universe.py (KO and PEP are in it). A
  stock that fails is listed under `failed` in FORMS_SOURCES.json and the script goes on.
- TERM_INDICES: the IV term indices of services/research/strategies/qc_ports/data.py IV_TERM that the
  qc-ports fetch does not get (Cboe VIX6M, about 182 days), with the qc-ports helper `_index`. For VIX6M
  that is Yahoo `^VIX6M` alone: IBKR has no contract mapping for it and the Cboe CSV list does not hold
  it. One that fails stops the script with an error. `--etfs "" --stocks ""` fetches only them (the other
  files of the directory keep their provenance).

Output (not committed: the Yahoo and IBKR terms do not allow redistribution), flat in --out:
- <SYMBOL>.csv, header `date,open,high,low,close,adj_close`, same meaning as the qc-ports ETF files:
  `close` is split-adjusted and not dividend-adjusted, `adj_close` also adjusts dividends.
- <SYMBOL>.splits.csv, header `date,ratio`: one row per split of `yf.Ticker(symbol).splits`, in date
  order. `date` is the effective date of the split, `ratio` is Yahoo's number (4.0 for a 4-for-1 split,
  0.1 for a 1-for-10 reverse split). Only dates from the START of the qc-ports helper and before --end.
  A symbol without a split has a file with only the header. Yahoo `close` is split-adjusted, so the
  price that traded on a day (raw close) = close x the product of the ratios of all splits after that
  day. Yahoo adjusts for every split up to the fetch day: a split on or after --end is not in the file
  but is in `close`, so the script prints a warning for it.
- <INDEX>.csv, header `date,close`: a term index, same meaning as the qc-ports index files.
- FORMS_SOURCES.json: `files` (per bar file the rows per source, failed sources and seams), `splits`
  (split rows per symbol), `failed` (the stocks without bars or without a split answer, reasons in
  `failed_reasons`) and `skipped` (symbols whose file is a qc-ports file).
- FORMS_SHA256SUMS: sha256 of every file this script wrote, sorted by name.
The qc-ports files and their SHA256SUMS and SOURCES.json are never rewritten: the qc-ports SHA256SUMS of
--out decides. A symbol whose file is listed in it is skipped (Core 7 and other qc-ports files); every
other target file may be written, also the files that an aborted run left. Without a SHA256SUMS in
--out the script stops (run the qc-ports fetch first).
A stock that fails in this run keeps no file of an earlier run of this script.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
QC_FETCH = ROOT / "research" / "backtests" / "qc-ports" / "fetch_data.py"
SOURCES_NAME = "FORMS_SOURCES.json"
SUMS_NAME = "FORMS_SHA256SUMS"
QC_SUMS_NAME = "SHA256SUMS"  # written by the qc-ports fetch: it lists every qc-ports file of the directory
QC_MANIFESTS = (QC_SUMS_NAME, "SOURCES.json")
HEADER = "date,open,high,low,close,adj_close"
SPLITS_HEADER = "date,ratio"
SPLITS_COLUMN = "Stock Splits"  # the name of the series when Yahoo answered (also with no split)
NOT_ETFS = ("KO", "PEP")
# IV term indices of data.IV_TERM that the qc-ports fetch does not get: file name -> Yahoo symbol.
TERM_INDICES = {"VIX6M": "^VIX6M"}


def load_qc_fetch():
    """The qc-ports fetch module, loaded from its file (its directory name is not an importable name)."""
    spec = importlib.util.spec_from_file_location("qc_ports_fetch_data", QC_FETCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_etfs() -> list[str]:
    sys.path.insert(0, str(ROOT / "services" / "research"))
    from strategies.qc_ports.forms import PROXY_MODELS

    return [symbol for symbol in PROXY_MODELS if symbol not in NOT_ETFS]


def default_stocks() -> list[str]:
    sys.path.insert(0, str(ROOT / "research" / "backtests" / "freestockalerts"))
    from universe import SP100

    stocks = list(SP100)
    return stocks + [symbol for symbol in NOT_ETFS if symbol not in stocks]


def symbol_list(value: str) -> list[str]:
    """`A,B C` -> [A, B, C], first occurrence kept."""
    return list(dict.fromkeys(part for part in value.replace(",", " ").split() if part))


def qc_files(out: Path) -> set[str]:
    """Names this script must not write: the qc-ports manifests and every file listed in SHA256SUMS."""
    path = out / QC_SUMS_NAME
    if not path.is_file():
        raise SystemExit(f"{path} is missing: run the qc-ports fetch first")
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {line.split(maxsplit=1)[1].strip().lstrip("*") for line in lines} | set(QC_MANIFESTS)


def may_write(name: str, protected: set[str]) -> bool:
    return name not in protected


def write_sums(out: Path, names: set[str]) -> list[str]:
    lines = [f"{hashlib.sha256((out / name).read_bytes()).hexdigest()}  {name}"
             for name in sorted(names) if (out / name).is_file()]
    (out / SUMS_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return lines


def previous_manifest(out: Path) -> dict:
    path = out / SOURCES_NAME
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def splits_name(symbol: str) -> str:
    return f"{symbol}.splits.csv"


def split_rows(splits: list[tuple[str, float]], start: str, end: str | None) -> tuple[list[str], int]:
    """(file rows with the header, count of splits on or after `end`) from (date, ratio) pairs."""
    kept = sorted((day, ratio) for day, ratio in splits if day >= start and (end is None or day < end))
    late = sum(1 for day, _ in splits if end is not None and day >= end)
    return [SPLITS_HEADER] + [f"{day},{float(ratio)!r}" for day, ratio in kept], late


def yahoo_splits(yf, symbol: str) -> list[tuple[str, float]]:
    """(date, ratio) of every split Yahoo lists. yfinance gives an unnamed empty series when the request failed."""
    series = yf.Ticker(symbol).splits
    if series.name != SPLITS_COLUMN:
        raise SystemExit(f"no split answer for {symbol}")
    return [(stamp.strftime("%Y-%m-%d"), float(ratio)) for stamp, ratio in series.items()]


def discard(out: Path, names: tuple[str, ...], protected: set[str]) -> None:
    """Removes the files of an earlier run of this script (never a qc-ports file)."""
    for name in names:
        if may_write(name, protected):
            (out / name).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path, help="existing qc-ports data directory (flat)")
    parser.add_argument("--end", default=None, help="exclusive end date YYYY-MM-DD (default: today)")
    parser.add_argument("--etfs", type=symbol_list, default=None, help="comma list (default: PROXY_MODELS ETFs)")
    parser.add_argument("--stocks", type=symbol_list, default=None, help="comma list (default: SP100)")
    args = parser.parse_args()
    out: Path = args.out.expanduser()
    if not out.is_dir():
        raise SystemExit(f"{out} is not a directory: run the qc-ports fetch first")
    protected = qc_files(out)
    for name in (SOURCES_NAME, SUMS_NAME):
        if not may_write(name, protected):
            raise SystemExit(f"{out / name} is listed in {QC_SUMS_NAME}")
    etfs = default_etfs() if args.etfs is None else args.etfs
    stocks = [symbol for symbol in (default_stocks() if args.stocks is None else args.stocks) if symbol not in etfs]

    import yfinance as yf

    qc = load_qc_fetch()
    # Files of earlier runs that this run does not fetch again keep their provenance and get a new checksum.
    previous = previous_manifest(out)
    sources: dict[str, dict] = {name: entry for name, entry in previous.get("files", {}).items()
                                if may_write(name, protected) and (out / name).is_file()}
    splits: dict[str, int] = {symbol: count for symbol, count in previous.get("splits", {}).items()
                              if f"{symbol}.csv" in sources and (out / splits_name(symbol)).is_file()}
    written: set[str] = set(sources) | {splits_name(symbol) for symbol in splits}
    failed: dict[str, str] = {}
    skipped: list[str] = []
    for name, ticker in TERM_INDICES.items():
        if not may_write(f"{name}.csv", protected):
            skipped.append(name)
            print(f"{name}: skipped, {name}.csv is a qc-ports file")
            continue
        qc.YAHOO_INDICES.setdefault(name, ticker)  # the helper looks the Yahoo symbol up there
        rows, summary = qc._index(yf, name, args.end)
        (out / f"{name}.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        sources[f"{name}.csv"] = summary
        written.add(f"{name}.csv")
        print(f"{name}: {len(rows) - 1} rows {rows[1].split(',')[0]} .. {rows[-1].split(',')[0]}")
    for symbol in etfs + stocks:
        names = (f"{symbol}.csv", splits_name(symbol))
        if not all(may_write(name, protected) for name in names):
            skipped.append(symbol)
            print(f"{symbol}: skipped, {names[0]} is a qc-ports file")
            continue
        try:
            rows, summary = qc._bars(yf, symbol, args.end)
            if rows[0] != HEADER or len(rows) < 2:
                raise SystemExit(f"no data for {symbol}")
            split_lines, late = split_rows(yahoo_splits(yf, symbol), qc.START, args.end)
        except (Exception, SystemExit) as error:  # noqa: BLE001 - a stock without data must not stop the run
            if symbol in etfs:
                raise SystemExit(f"ETF {symbol} failed: {error}") from error
            # SystemExit carries the helper's own message; other errors are named by class only.
            failed[symbol] = str(error) if isinstance(error, SystemExit) else type(error).__name__
            discard(out, names, protected)
            sources.pop(names[0], None)
            splits.pop(symbol, None)
            written.difference_update(names)
            print(f"{symbol}: FAILED ({failed[symbol]})")
            continue
        for name, lines in zip(names, (rows, split_lines), strict=True):
            (out / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        sources[names[0]] = summary
        splits[symbol] = len(split_lines) - 1
        written.update(names)
        print(f"{symbol}: {len(rows) - 1} rows {rows[1].split(',')[0]} .. {rows[-1].split(',')[0]}, "
              f"{splits[symbol]} splits")
        if late:
            print(f"{symbol}: WARNING {late} split(s) on or after --end are in `close` but not in {names[1]}")
    manifest = {"files": sources, "splits": splits, "failed": sorted(failed), "failed_reasons": failed,
                "skipped": skipped}
    (out / SOURCES_NAME).write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    write_sums(out, written | {SOURCES_NAME})
    print(f"wrote {len(written)} files; failed: {sorted(failed) or 'none'}; skipped: {skipped or 'none'}")


if __name__ == "__main__":
    main()
