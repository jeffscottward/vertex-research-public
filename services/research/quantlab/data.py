"""Frozen daily bar snapshots.

A snapshot is fetched once, written as CSV and pinned by SHA-256 in a manifest.
Backtests only read snapshots whose hash still matches the manifest, so a rerun
uses exactly the same bytes. Snapshots live under the git-ignored private/ tree
because vendor data terms do not allow redistribution in the repository.

Source: IBKR first, Yahoo fills gaps (ibkr_history.py). With VERTEX_HISTORY_URL and
VERTEX_DEPLOY_STATUS_TOKEN set, stocks and ETFs come from IBKR TRADES (OHLC, volume in
shares) joined with ADJUSTED_LAST (adj_close, about 30 years back); indices (^IRX,
^GSPC, ...) from IBKR IND bars (adj_close = close; IRX/TNX in percent). The Yahoo chart
API v8 fills the dates before IBKR's first date (adj_close rescaled to IBKR's on the
seam date) and everything when IBKR fails or is not configured. Snapshot CSVs carry a
`source` column (ibkr or yahoo per row); the manifest records rows per source and seams.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import ibkr_history as ih

from .ssrn import Fetch, http_fetch, now_iso

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"
COLUMNS = ("date", "open", "high", "low", "close", "adj_close", "volume")


@dataclass(frozen=True)
class Bar:
    date: str
    open: float
    close: float
    adj_close: float

    @property
    def factor(self) -> float:
        return self.adj_close / self.close

    @property
    def adj_open(self) -> float:
        return self.open * self.factor


def yahoo_daily_rows(symbol: str, start: str, end: str, *, fetch: Fetch = http_fetch) -> list[dict]:
    """Yahoo chart API v8 daily rows (start inclusive, end exclusive); incomplete bars are skipped."""
    def epoch(day: str) -> int:
        return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp())
    query = urllib.parse.urlencode({"period1": epoch(start), "period2": epoch(end), "interval": "1d",
                                    "events": "div,splits", "includeAdjustedClose": "true"})
    response = fetch(f"{YAHOO_CHART}{urllib.parse.quote(symbol)}?{query}")
    if response.status != 200:
        raise RuntimeError(f"yahoo chart {symbol}: HTTP {response.status}")
    result = json.loads(response.body)["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    adjusted = (result["indicators"].get("adjclose") or [{}])[0].get("adjclose") or quote["close"]
    rows = []
    for i, stamp in enumerate(result["timestamp"]):
        row = [quote["open"][i], quote["high"][i], quote["low"][i], quote["close"][i], adjusted[i], quote["volume"][i]]
        if any(value is None for value in row[:5]):
            continue  # incomplete bar: never treated as a completed observation
        day = datetime.fromtimestamp(stamp + result["meta"].get("gmtoffset", 0), tz=timezone.utc).date().isoformat()
        rows.append({"date": day, **{key: float(value) for key, value in zip(COLUMNS[1:6], row[:5], strict=True)},
                     "volume": row[5]})
    return rows


def _csv(rows: list[dict], *, source: bool) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(COLUMNS + (("source",) if source else ()))
    for row in rows:
        values = [row["date"], *(f"{float(row.get(key, row['close'])):.6f}" for key in COLUMNS[1:6]),
                  int(round(row["volume"] or 0))]
        writer.writerow(values + ([row["source"]] if source else []))
    return out.getvalue().encode()


def yahoo_daily_csv(symbol: str, start: str, end: str, *, fetch: Fetch = http_fetch) -> bytes:
    """Yahoo-only snapshot bytes (the pre-IBKR format, no source column)."""
    return _csv(yahoo_daily_rows(symbol, start, end, fetch=fetch), source=False)


def daily_csv(symbol: str, start: str, end: str, *, fetch: Fetch = http_fetch,
              client: ih.Client | None = None) -> tuple[bytes, ih.Merged]:
    """IBKR first, Yahoo fills gaps: snapshot bytes with a source column, and the merge provenance."""
    merged = ih.merged_daily(symbol, lambda: yahoo_daily_rows(symbol, start, end, fetch=fetch),
                             start=start, end=end, adjust="adj_close", client=client)
    return _csv(merged.rows, source=True), merged


def source_label(merged: ih.Merged) -> str:
    names = {"ibkr": "IBKR vertex-history daily (TRADES OHLC, ADJUSTED_LAST adj_close; indices IND)",
             "yahoo": "Yahoo Finance chart API v8 (daily, split/dividend adjusted close)"}
    return "; ".join(f"{names.get(name, name)} {info['first']}..{info['last']}"
                     for name, info in merged.sources.items())


def freeze(symbol: str, start: str, end: str, directory: Path, *, fetch: Fetch = http_fetch,
           client: ih.Client | None = None) -> dict:
    raw, merged = daily_csv(symbol, start, end, fetch=fetch, client=client)
    digest = hashlib.sha256(raw).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    slug = symbol.replace("^", "idx-").lower()
    path = directory / f"{slug}-{start}-{end}-{digest[:12]}.csv"
    path.write_bytes(raw)
    rows = raw.decode().strip().splitlines()[1:]
    manifest = {"symbol": symbol, "source": source_label(merged), "sources": merged.summary(),
                "requested": {"start": start, "end": end}, "fetched_at": now_iso(), "path": str(path),
                "sha256": digest, "rows": len(rows), "first": rows[0].split(",")[0], "last": rows[-1].split(",")[0]}
    path.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def load(manifest: dict) -> list[Bar]:
    raw = Path(manifest["path"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["sha256"]:
        raise ValueError(f"frozen snapshot hash mismatch: {manifest['path']}")
    bars = []
    for row in csv.DictReader(io.StringIO(raw.decode())):
        bars.append(Bar(row["date"], float(row["open"]), float(row["close"]), float(row["adj_close"])))
    dates = [b.date for b in bars]
    if dates != sorted(set(dates)):
        raise ValueError("snapshot dates must be strictly increasing")
    return bars
