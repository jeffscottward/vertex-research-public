"""Fetch the daily bars of the Core 7 futures and Core 7 ETF twins universes (IBKR first, Yahoo fills gaps).

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/core7/fetch_data.py --out ~/Documents/reports/vertex-core7/data \
      --coverage research/backtests/core7/coverage.json

The universes are defined in packages/shared/src/universes/index.ts (CORE7_MARKETS).

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, the ETFs come from IBKR TRADES (OHLC, volume in shares) joined with
ADJUSTED_LAST (adj_close, about 30 years back) and the futures from IBKR CONTFUT (latest window only:
IBKR keeps expired contracts for about two years; adj_close = close). Yahoo (period max,
auto_adjust=False) fills the dates before IBKR's first date (ETF adj_close rescaled to IBKR's on the
seam date) and everything when IBKR fails or is not configured. coverage.json records the seams,
including the close ratio of both sources on the seam date (a CONTFUT roll basis shows up there).

Output (in --out; not committed, the Yahoo and IBKR terms do not allow redistribution):
* daily/<SYMBOL>.csv: columns date,open,high,low,close,adj_close,volume,source. A missing value is an
  empty field. open/high/low/close are split-adjusted only; adj_close also includes dividends.
  `source` is ibkr or yahoo per row. scripts/research/quantjourney.ts parsePriceCsv reads the first
  six columns.
* import/<SYMBOL>-1d.csv: the same bars in the Vertex importer format (header t,o,h,l,c,v, t in
  epoch milliseconds at UTC midnight of the trading date, ascending), split-adjusted OHLC.
  Rows that the importer would reject are dropped and counted, never repaired.
* import/<SYMBOL>-1d.manifest.json: {symbol, timeframe, source, sourceSha256, normalizedSha256, sources}.
  sourceSha256 is the SHA-256 of daily/<SYMBOL>.csv; normalizedSha256 the SHA-256 of the CSV.
* coverage.json: per-symbol coverage against the SPY trading calendar of the same fetch, and for
  each future the 5 largest close-to-close moves and the 5 largest differences from the ETF
  twin's move on the same day (roll gaps show up in the second list). Counts, dates and percent
  changes only, no prices: the --coverage copy may live in the repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))
import ibkr_history as ih  # noqa: E402

# Order of CORE7_MARKETS in packages/shared/src/universes/index.ts.
FUTURES = ["ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F"]
ETFS = ["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"]
REFERENCE = "SPY"
COLUMNS = ("Open", "High", "Low", "Close", "Adj Close", "Volume")
FIELDS = ("open", "high", "low", "close", "adj_close", "volume")
EXAMPLES = 20
LARGEST_MOVES = 5


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value) -> float | None:
    """A finite float, or None for a missing value."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def fetch(symbol: str):
    """Full daily history; one retry after a pause when Yahoo rate-limits or returns nothing."""
    for attempt in range(2):
        try:
            frame = yf.Ticker(symbol).history(period="max", interval="1d",
                                              auto_adjust=False, actions=False)
            if len(frame) > 0:
                return frame, attempt
            problem = "empty response"
        except Exception as error:  # yfinance raises its own rate-limit error class
            problem = f"{type(error).__name__}: {error}"
        print(f"{symbol}: {problem}; " + ("retrying in 60 s" if attempt == 0 else "giving up"))
        if attempt == 0:
            time.sleep(60)
    raise RuntimeError(f"{symbol}: no data after one retry")


SOURCE_MAX = 300  # validateMarketBars: source is 1 to 300 characters


def source_text(symbol: str, fetched: str, merged: ih.Merged) -> str:
    """The importer manifest's source line (at most about 235 characters; SOURCE_MAX is 300)."""
    future = symbol.endswith("=F")
    parts = []
    for name, info in merged.sources.items():
        span = f"{info['first']}..{info['last']}"
        seam = any(entry["rescaled"] for entry in merged.seams)  # only when the older part was actually scaled
        if name == "ibkr":
            kind = ("CONTFUT front month, all hours" if future
                    else "TRADES OHLC split-adjusted, no dividends; ADJUSTED_LAST adj_close")
            parts.append(f"IBKR {kind} {span}")
        elif future:
            scaled = ", OHLC scaled to IBKR at the seam" if seam else ""
            parts.append(f"{name.capitalize()} yfinance {str(yf.__version__)[:12]} continuous front month, "
                         f"not back-adjusted{scaled} {span}")
        else:
            kind = ("OHLC split-adjusted, no dividends; adj_close scaled to IBKR at the seam" if seam
                    else "OHLC split-adjusted without dividends, adj_close with dividends")
            parts.append(f"{name.capitalize()} yfinance {str(yf.__version__)[:12]} {kind} {span}")
    text = "; ".join(parts) + f"; fetched {fetched}"
    if len(text) > SOURCE_MAX:
        raise ValueError(f"{symbol}: source text longer than {SOURCE_MAX} characters")
    return text


def yahoo_rows(frame) -> list[dict]:
    return [{"date": ts.date().isoformat(), **{key: number(row[col]) for key, col in zip(FIELDS, COLUMNS, strict=True)}}
            for ts, row in frame.iterrows()]


def write_raw(merged: ih.Merged, path: Path) -> list[tuple[str, list[float | None]]]:
    rows: list[tuple[str, list[float | None]]] = []
    with path.open("w") as fh:
        fh.write("date,open,high,low,close,adj_close,volume,source\n")
        for row in merged.rows:
            values = [number(row.get(key)) for key in FIELDS]
            rows.append((row["date"], values))
            fh.write(row["date"] + "," + ",".join("" if v is None else repr(v) for v in values)
                     + f",{row['source']}\n")
    return rows


def import_rows(rows):
    """Rows the importer accepts (validateMarketBars in packages/db/src/server/market-bars.ts)."""
    kept: list[tuple[str, int, float, float, float, float, int]] = []
    dropped = {"missingOrNonPositivePrice": 0, "highLowInconsistent": 0,
               "negativeOrMissingVolume": 0, "duplicateOrUnorderedDate": 0}
    previous = -1
    for stamp, (o, h, low, c, _adj, v) in rows:
        prices = (o, h, low, c)
        if any(p is None or p <= 0 for p in prices):
            dropped["missingOrNonPositivePrice"] += 1
            continue
        if not (low <= min(o, c) and h >= max(o, c)):
            dropped["highLowInconsistent"] += 1
            continue
        if v is None or v < 0:
            dropped["negativeOrMissingVolume"] += 1
            continue
        day = date.fromisoformat(stamp)
        t = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)
        if t <= previous:
            dropped["duplicateOrUnorderedDate"] += 1
            continue
        previous = t
        kept.append((stamp, t, o, h, low, c, int(round(v))))
    return kept, dropped


def write_import(symbol: str, kept, raw_path: Path, out: Path, fetched: str, merged: ih.Merged) -> dict:
    csv_path = out / f"{symbol}-1d.csv"
    with csv_path.open("w") as fh:
        fh.write("t,o,h,l,c,v\n")
        for _stamp, t, o, h, low, c, v in kept:
            fh.write(f"{t},{o!r},{h!r},{low!r},{c!r},{v}\n")
    manifest = {
        "symbol": symbol,
        "timeframe": "1d",
        "source": source_text(symbol, fetched, merged),
        "sourceSha256": sha256(raw_path),
        "normalizedSha256": sha256(csv_path),
        "sources": merged.summary(),
    }
    (out / f"{symbol}-1d.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def largest_moves(kept) -> list[dict]:
    """Dates and percent changes only: coverage.json may be copied into the repository (--coverage), and
    prices (IBKR or Yahoo) must not land there."""
    moves = [
        {"date": kept[i][0], "previousDate": kept[i - 1][0], "change": kept[i][5] / kept[i - 1][5] - 1}
        for i in range(1, len(kept))
    ]
    moves.sort(key=lambda m: abs(m["change"]), reverse=True)
    return moves[:LARGEST_MOVES]


def largest_twin_gaps(kept, twin_kept) -> list[dict]:
    """Days where the future's close-to-close move differs most from its ETF twin's move.

    Both moves use consecutive dates present in both series, so a roll gap of the continuous
    future shows up as a large difference while a market-wide move does not."""
    twin = {row[0]: row[5] for row in twin_kept}
    common = [row for row in kept if row[0] in twin]
    gaps = []
    for i in range(1, len(common)):
        day, before = common[i][0], common[i - 1][0]
        move = common[i][5] / common[i - 1][5] - 1
        twin_move = twin[day] / twin[before] - 1
        gaps.append({"date": day, "previousDate": before, "change": move,
                     "twinChange": twin_move, "difference": move - twin_move})
    gaps.sort(key=lambda g: abs(g["difference"]), reverse=True)
    return gaps[:LARGEST_MOVES]


def coverage_source(results: dict[str, dict]) -> tuple[str, dict]:
    """coverage.json's source line and request: IBKR is named only when it answered for some symbol."""
    request: dict = {"period": "max", "interval": "1d", "auto_adjust": False}
    if not ih.answered(entry["manifest"]["sources"] for entry in results.values()):
        return "Yahoo Finance via yfinance", request
    request["ibkr"] = "STK TRADES paged + ADJUSTED_LAST 30 Y; CONTFUT 1 day latest window, all hours"
    return "sources per symbol, see symbols.<SYMBOL>.sources", request


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--coverage", type=Path, help="extra path for a copy of coverage.json")
    args = parser.parse_args()
    out = args.out.expanduser()
    (out / "daily").mkdir(parents=True, exist_ok=True)
    (out / "import").mkdir(parents=True, exist_ok=True)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fetched = fetched_at[:10]

    results: dict[str, dict] = {}
    retries: dict[str, int] = {}
    for symbol in [REFERENCE] + [s for s in FUTURES + ETFS if s != REFERENCE]:
        def yahoo(symbol: str = symbol) -> list[dict]:
            frame, attempt = fetch(symbol)
            if attempt:
                retries[symbol] = attempt
            return yahoo_rows(frame)

        merged = ih.merged_daily(symbol, yahoo, adjust="none" if symbol.endswith("=F") else "adj_close")
        raw_path = out / "daily" / f"{symbol}.csv"
        rows = write_raw(merged, raw_path)
        kept, dropped = import_rows(rows)
        manifest = write_import(symbol, kept, raw_path, out / "import", fetched, merged)
        results[symbol] = {"rows": rows, "kept": kept, "dropped": dropped, "manifest": manifest}
        time.sleep(1)

    reference = [row[0] for row in results[REFERENCE]["kept"]]
    coverage: dict[str, dict] = {}
    for symbol in FUTURES + ETFS:
        entry = results[symbol]
        kept = entry["kept"]
        dates = [row[0] for row in kept]
        first, last = dates[0], dates[-1]
        own = set(dates)
        window = [d for d in reference if first <= d <= last]
        window_set = set(window)
        missing = [d for d in window if d not in own]
        extra = [d for d in dates if d not in window_set]
        record = {
            "kind": "future" if symbol.endswith("=F") else "etf",
            "first": first,
            "last": last,
            "rawRows": len(entry["rows"]),
            "rows": len(kept),
            "referenceSessions": len(window),
            "missingSessions": len(missing),
            "missingExamples": missing[:EXAMPLES],
            "extraDates": len(extra),
            "extraExamples": extra[:EXAMPLES],
            "droppedRows": sum(entry["dropped"].values()),
            "droppedByReason": entry["dropped"],
            "source": entry["manifest"]["source"],
            "sources": entry["manifest"]["sources"],
            "sourceSha256": entry["manifest"]["sourceSha256"],
            "normalizedSha256": entry["manifest"]["normalizedSha256"],
        }
        if symbol.endswith("=F"):
            twin = ETFS[FUTURES.index(symbol)]
            record["twin"] = twin
            record["largestCloseMoves"] = largest_moves(kept)
            record["largestGapsVsTwin"] = largest_twin_gaps(kept, results[twin]["kept"])
        coverage[symbol] = record

    source, request = coverage_source(results)
    doc = {
        "fetchedAt": fetched_at,
        "source": source,
        "yfinanceVersion": yf.__version__,
        "request": request,
        "referenceCalendar": f"{REFERENCE} trading dates of the same fetch",
        "script": "research/backtests/core7/fetch_data.py",
        "retries": retries,
        "symbols": coverage,
    }
    text = json.dumps(doc, indent=2) + "\n"
    (out / "coverage.json").write_text(text)
    if args.coverage is not None:
        args.coverage.write_text(text)
    print(json.dumps({s: [c["first"], c["last"], c["rows"], c["missingSessions"], c["extraDates"],
                          c["droppedRows"]] for s, c in coverage.items()}))


if __name__ == "__main__":
    main()
