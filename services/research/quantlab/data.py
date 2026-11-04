"""Frozen daily bar snapshots.

A snapshot is fetched once, written as CSV and pinned by SHA-256 in a manifest.
Backtests only read snapshots whose hash still matches the manifest, so a rerun
uses exactly the same bytes. Snapshots live under the git-ignored private/ tree
because vendor data terms do not allow redistribution in the repository.
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


def yahoo_daily_csv(symbol: str, start: str, end: str, *, fetch: Fetch = http_fetch) -> bytes:
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
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(COLUMNS)
    for i, stamp in enumerate(result["timestamp"]):
        row = [quote["open"][i], quote["high"][i], quote["low"][i], quote["close"][i], adjusted[i], quote["volume"][i]]
        if any(value is None for value in row[:5]):
            continue  # incomplete bar: never treated as a completed observation
        day = datetime.fromtimestamp(stamp + result["meta"].get("gmtoffset", 0), tz=timezone.utc).date().isoformat()
        writer.writerow([day, *(f"{float(v):.6f}" for v in row[:5]), int(row[5] or 0)])
    return out.getvalue().encode()


def freeze(symbol: str, start: str, end: str, directory: Path, *, fetch: Fetch = http_fetch) -> dict:
    raw = yahoo_daily_csv(symbol, start, end, fetch=fetch)
    digest = hashlib.sha256(raw).hexdigest()
    directory.mkdir(parents=True, exist_ok=True)
    slug = symbol.replace("^", "idx-").lower()
    path = directory / f"{slug}-{start}-{end}-{digest[:12]}.csv"
    path.write_bytes(raw)
    rows = raw.decode().strip().splitlines()[1:]
    manifest = {"symbol": symbol, "source": "Yahoo Finance chart API v8 (daily, split/dividend adjusted close)",
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
