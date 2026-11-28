"""Fetch free public data for the alternative exit-rule dry-run study (card stoploss-alt-exit-dryrun).

Writes strictly outside the repository (refuses `--out` inside the git checkout).

Free public sources fetched:
  1. Point-in-time S&P 500 historical constituents (1996-2026):
     `fja05680/sp500` (`S&P 500 Historical Components & Changes (Updated).csv`).
  2. Real historical end-of-day US option quotes (SPY 2008-2025, QQQ 2011-2025, IWM 2008-2025):
     `anahatsingh-ui/options-dataset-hist` (MIT preservation mirror of Philipp D. Dubach's
     `options-dataset-hist`; real bid, ask, mark, IV, delta, volume, OI from 0 DTE through LEAPS).
     Provenance note: the original upstream repository and file host went offline in 2026 and did not
     document its own underlying vendor; this mirror was recovered from Git LFS and verified byte-for-byte.
  3. Daily equity, ETF, and volatility/rate index bars via Yahoo Finance (`yfinance`) covering both current
     S&P 500 constituents and removed-still-trading former S&P 500 constituents.

Usage (outside the repo):
    uv run --no-project --python 3.12 --with yfinance --with duckdb python \
        research/backtests/stoploss-alt-exit/fetch_data.py --out /tmp/stoploss-alt-data
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import UTC, datetime
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
PIT_URL = (
    "https://raw.githubusercontent.com/fja05680/sp500/master/"
    "S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv"
)
OPTIONS_BASE_URL = "https://raw.githubusercontent.com/anahatsingh-ui/options-dataset-hist/main"
OPTIONS_YEARS = {
    "spy": range(2008, 2026),
    "qqq": range(2011, 2026),
    "iwm": range(2008, 2026),
}
ETFS = ("SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE",
        "XLC", "TLT", "IEF", "GLD", "SLV", "USO")
YAHOO_INDEXES = {"VIX": "^VIX", "VXN": "^VXN", "RVX": "^RVX", "VXD": "^VXD", "GVZ": "^GVZ",
                 "OVX": "^OVX", "IRX": "^IRX"}
AGENT = {"User-Agent": "vertex-research/1.0 (public research)"}


def log(msg: str) -> None:
    print(f"{datetime.now(UTC):%H:%M:%SZ} {msg}", file=sys.stderr, flush=True)


def _download(url: str, dest: Path, timeout: int = 60) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=AGENT)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed public https URLs
            data = resp.read()
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(dest)
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log(f"warn: failed {url}: {exc}")
        return False


def fetch_pit(out: Path) -> Path:
    dest = out / "sp500_pit.csv"
    log("fetching point-in-time S&P 500 constituents")
    if not _download(PIT_URL, dest):
        raise RuntimeError(f"failed to download PIT S&P 500 CSV from {PIT_URL}")
    return dest


def pit_symbols(pit_csv: Path, start: str) -> list[str]:
    """Every ticker active in any PIT snapshot on/after `start`, including the latest snapshot <= `start`."""
    rows: list[tuple[str, list[str]]] = []
    with pit_csv.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            d = (row.get("date") or "").strip()
            if not d:
                continue
            toks = [t.strip().upper().replace(".", "-") for t in (row.get("tickers") or "").split(",") if t.strip()]
            if toks:
                rows.append((d, toks))
    rows.sort(key=lambda x: x[0])
    syms: set[str] = set()
    prior: list[str] = []
    for d, toks in rows:
        if d <= start:
            prior = toks
        else:
            syms.update(toks)
    syms.update(prior)
    return sorted(syms)


def fetch_real_options(out: Path, symbols: tuple[str, ...] = ("spy", "qqq", "iwm"),
                       workers: int = 6) -> dict[str, list[str]]:
    opt_root = out / "real-options"
    jobs: list[tuple[str, str, Path]] = []
    for sym in symbols:
        if sym not in OPTIONS_YEARS:
            continue
        jobs.append((sym, f"{OPTIONS_BASE_URL}/{sym}/underlying_prices.parquet",
                     opt_root / sym / "underlying_prices.parquet"))
        for yr in OPTIONS_YEARS[sym]:
            jobs.append((sym, f"{OPTIONS_BASE_URL}/{sym}/options_{yr}.parquet",
                         opt_root / sym / f"options_{yr}.parquet"))
    log(f"fetching {len(jobs)} real-option parquet files for {','.join(s.upper() for s in symbols)}")
    downloaded: dict[str, list[str]] = {s: [] for s in symbols}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_download, url, dest, 120): (sym, dest) for sym, url, dest in jobs}
        for fut in as_completed(futs):
            sym, dest = futs[fut]
            if fut.result():
                downloaded[sym].append(dest.name)
    for sym in downloaded:
        downloaded[sym].sort()
    return downloaded


def _write_bar_csv(dest: Path, rows: list[tuple[str, float, float, float, float, float]]) -> bool:
    if len(rows) < 20:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "open", "high", "low", "close", "adj_close"])
    for r in rows:
        w.writerow(r)
    dest.write_text(buf.getvalue(), encoding="utf-8")
    return True


def fetch_yahoo_bars(out: Path, symbols: list[str], start: str, *, batch_size: int = 50) -> tuple[int, int]:
    """Download daily OHLC + Adj Close bars via yfinance in batches into `<out>/bars/<SYM>.csv`."""
    import yfinance as yf  # lazy import

    bars_dir = out / "bars"
    bars_dir.mkdir(parents=True, exist_ok=True)
    todo = [s for s in symbols if not (bars_dir / f"{s}.csv").exists()]
    log(f"fetching Yahoo daily bars for {len(todo)}/{len(symbols)} symbols (batch={batch_size})")
    ok = len(symbols) - len(todo)
    fail = 0
    for i in range(0, len(todo), batch_size):
        batch = todo[i:i + batch_size]
        log(f"  yahoo batch {i + 1}-{i + len(batch)}/{len(todo)}")
        try:
            df = yf.download(batch, start=start, auto_adjust=False, progress=False, threads=True, group_by="ticker")
        except Exception as exc:
            log(f"  warn: batch failed: {exc}")
            fail += len(batch)
            continue
        if df is None or df.empty:
            fail += len(batch)
            continue
        for sym in batch:
            try:
                sub = df[sym] if sym in df.columns else df
                sub = sub.dropna(subset=["Open", "High", "Low", "Close", "Adj Close"])
                rows: list[tuple[str, float, float, float, float, float]] = []
                for idx, r in sub.iterrows():
                    o, h, lo, c, ac = float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"]), float(r["Adj Close"])
                    if min(o, h, lo, c, ac) <= 0:
                        continue
                    rows.append((idx.strftime("%Y-%m-%d"), round(o, 6), round(h, 6), round(lo, 6), round(c, 6), round(ac, 6)))
                if _write_bar_csv(bars_dir / f"{sym}.csv", rows):
                    ok += 1
                else:
                    fail += 1
            except Exception:
                fail += 1
    return ok, fail


def fetch_yahoo_indexes(out: Path, start: str) -> list[str]:
    import yfinance as yf  # lazy import

    bars_dir = out / "bars"
    bars_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for name, ticker in YAHOO_INDEXES.items():
        dest = bars_dir / f"{name}.csv"
        if dest.exists() and dest.stat().st_size > 0:
            saved.append(name)
            continue
        try:
            df = yf.download(ticker, start=start, auto_adjust=False, progress=False)
            if df is None or df.empty:
                continue
            close_col = df["Close"]
            if hasattr(close_col, "columns"):
                close_col = close_col.iloc[:, 0]
            lines = ["date,close"]
            for idx, val in close_col.dropna().items():
                v = float(val)
                if v == v:
                    lines.append(f"{idx.strftime('%Y-%m-%d')},{v:.6f}")
            if len(lines) > 10:
                dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
                saved.append(name)
        except Exception as exc:
            log(f"warn: index {name} ({ticker}) failed: {exc}")
    return saved


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True, help="Output data directory (must be outside the repo)")
    ap.add_argument("--start", default="1998-01-01", help="Bar history start date")
    ap.add_argument("--pit-start", default="2005-01-01", help="Earliest PIT constituent date to fetch stocks for")
    ap.add_argument("--options-symbols", default="spy,qqq,iwm", help="Comma-separated real-option ETFs to fetch")
    ap.add_argument("--skip-options", action="store_true", help="Skip downloading real-option parquet archives")
    ap.add_argument("--skip-stocks", action="store_true", help="Skip downloading PIT equity bars")
    args = ap.parse_args(argv)

    out = args.out.resolve()
    if out == ROOT or ROOT in out.parents:
        print("error: --out must be outside the repository", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)

    pit_csv = fetch_pit(out)
    opt_files: dict[str, list[str]] = {}
    if not args.skip_options:
        opt_syms = tuple(s.strip().lower() for s in args.options_symbols.split(",") if s.strip())
        opt_files = fetch_real_options(out, opt_syms)

    idx_saved = fetch_yahoo_indexes(out, args.start)
    ok_bars, fail_bars = 0, 0
    if not args.skip_stocks:
        syms = sorted(set(ETFS) | set(pit_symbols(pit_csv, args.pit_start)))
        ok_bars, fail_bars = fetch_yahoo_bars(out, syms, args.start)
    else:
        ok_bars, fail_bars = fetch_yahoo_bars(out, list(ETFS), args.start)

    manifest = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "pitSource": PIT_URL,
        "pitSha256": hashlib.sha256(pit_csv.read_bytes()).hexdigest(),
        "realOptionsSource": f"{OPTIONS_BASE_URL} (MIT mirror of philippdubach/options-dataset-hist)",
        "realOptionsFiles": opt_files,
        "indexesSaved": idx_saved,
        "barsOk": ok_bars,
        "barsFailedOrDelisted": fail_bars,
    }
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"done: {ok_bars} bar files ok, {fail_bars} missing/delisted, {len(idx_saved)} indexes -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
