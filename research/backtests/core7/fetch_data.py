"""Fetch the public Yahoo daily bars of the Core 7 futures and Core 7 ETF twins universes.

Research only. Network reads of public data; writes local CSV files; places no orders.
Run (rig):
  uv run --no-project --python 3.12 --with yfinance==0.2.66 \
      python research/backtests/core7/fetch_data.py --out ~/Documents/reports/vertex-core7/data \
      --coverage research/backtests/core7/coverage.json

The universes are defined in packages/shared/src/universes/index.ts (CORE7_MARKETS).

Output (in --out; not committed, the Yahoo terms do not allow redistribution):
* daily/<SYMBOL>.csv: every row Yahoo returns (period max, interval 1d, auto_adjust=False),
  columns date,open,high,low,close,adj_close,volume. A missing value is an empty field.
  open/high/low/close are split-adjusted only; adj_close also includes dividends.
  scripts/research/quantjourney.ts parsePriceCsv reads this format.
* import/<SYMBOL>-1d.csv: the same bars in the Vertex importer format (header t,o,h,l,c,v, t in
  epoch milliseconds at UTC midnight of the trading date, ascending), split-adjusted OHLC.
  Rows that the importer would reject are dropped and counted, never repaired.
* import/<SYMBOL>-1d.manifest.json: {symbol, timeframe, source, sourceSha256, normalizedSha256}.
  sourceSha256 is the SHA-256 of daily/<SYMBOL>.csv; normalizedSha256 the SHA-256 of the CSV.
* coverage.json: per-symbol coverage against the SPY trading calendar of the same fetch, and for
  each future the 5 largest close-to-close moves and the 5 largest differences from the ETF
  twin's move on the same day (roll gaps show up in the second list).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from datetime import date, datetime, timezone
from pathlib import Path

import yfinance as yf

# Order of CORE7_MARKETS in packages/shared/src/universes/index.ts.
FUTURES = ["ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F"]
ETFS = ["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"]
REFERENCE = "SPY"
COLUMNS = ("Open", "High", "Low", "Close", "Adj Close", "Volume")
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


def source_text(symbol: str, fetched: str) -> str:
    if symbol.endswith("=F"):
        return (f"Yahoo Finance chart v8 daily via yfinance {yf.__version__}, {symbol} continuous "
                f"front-month future, not back-adjusted (roll dates show price jumps), fetched {fetched}")
    return (f"Yahoo Finance chart v8 daily via yfinance {yf.__version__}, split-adjusted OHLC "
            f"(dividends not included), fetched {fetched}")


def write_raw(frame, path: Path) -> list[tuple[str, list[float | None]]]:
    rows: list[tuple[str, list[float | None]]] = []
    with path.open("w") as fh:
        fh.write("date,open,high,low,close,adj_close,volume\n")
        for ts, row in frame.iterrows():
            values = [number(row[col]) for col in COLUMNS]
            stamp = ts.date().isoformat()
            rows.append((stamp, values))
            fh.write(stamp + "," + ",".join("" if v is None else repr(v) for v in values) + "\n")
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


def write_import(symbol: str, kept, raw_path: Path, out: Path, fetched: str) -> dict:
    csv_path = out / f"{symbol}-1d.csv"
    with csv_path.open("w") as fh:
        fh.write("t,o,h,l,c,v\n")
        for _stamp, t, o, h, low, c, v in kept:
            fh.write(f"{t},{o!r},{h!r},{low!r},{c!r},{v}\n")
    manifest = {
        "symbol": symbol,
        "timeframe": "1d",
        "source": source_text(symbol, fetched),
        "sourceSha256": sha256(raw_path),
        "normalizedSha256": sha256(csv_path),
    }
    (out / f"{symbol}-1d.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def largest_moves(kept) -> list[dict]:
    moves = [
        {"date": kept[i][0], "previousDate": kept[i - 1][0], "previousClose": kept[i - 1][5],
         "close": kept[i][5], "change": kept[i][5] / kept[i - 1][5] - 1}
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
        frame, attempt = fetch(symbol)
        if attempt:
            retries[symbol] = attempt
        raw_path = out / "daily" / f"{symbol}.csv"
        rows = write_raw(frame, raw_path)
        kept, dropped = import_rows(rows)
        manifest = write_import(symbol, kept, raw_path, out / "import", fetched)
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
            "sourceSha256": entry["manifest"]["sourceSha256"],
            "normalizedSha256": entry["manifest"]["normalizedSha256"],
        }
        if symbol.endswith("=F"):
            twin = ETFS[FUTURES.index(symbol)]
            record["twin"] = twin
            record["largestCloseMoves"] = largest_moves(kept)
            record["largestGapsVsTwin"] = largest_twin_gaps(kept, results[twin]["kept"])
        coverage[symbol] = record

    doc = {
        "fetchedAt": fetched_at,
        "source": "Yahoo Finance via yfinance",
        "yfinanceVersion": yf.__version__,
        "request": {"period": "max", "interval": "1d", "auto_adjust": False},
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
