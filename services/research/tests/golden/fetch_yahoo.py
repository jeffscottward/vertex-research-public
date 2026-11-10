"""Download the frozen daily-bar fixture for the golden backtest battery.

Not a test and not a runtime dependency. Run it only to rebuild the fixture:

    python3 services/research/tests/golden/fetch_yahoo.py

Source: IBKR first, Yahoo fills gaps (services/research/ibkr_history.py). With
VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN set, IBKR TRADES daily bars
(split-adjusted OHLC, volume in shares) joined with ADJUSTED_LAST (adj_close); the
public Yahoo Finance chart endpoint (v8, interval 1d) fills the dates before IBKR's
first date (adj_close rescaled to IBKR's on the seam date) and everything when IBKR
fails or is not configured. The output is a frozen copy: a new download can differ,
because both providers restate adjusted closes after each dividend. Do not rebuild
the fixture unless the golden reference is also rebuilt.

Writes tests/fixtures/golden/<SYMBOL>-1d.csv and tests/fixtures/golden/manifest.json.
The CSV header stays exact (scripts/golden-battery/battery.ts refuses other columns),
so the per-source rows and seams go to manifest.json (files.<SYMBOL>.sources);
downloadSha256 is the SHA-256 of the downloaded bytes (IBKR rows as canonical JSON,
then the Yahoo response, whichever were used).
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import sys
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import ibkr_history as ih  # noqa: E402

SYMBOLS = ("SPY", "QQQ")
START = "2015-01-01"
END = "2024-12-31"
URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?period1={start}&period2={end}&interval=1d&events=div%2Csplit&includeAdjustedClose=true"
)
FIELDS = ("date", "open", "high", "low", "close", "adj_close", "volume")
ROOT = Path(__file__).resolve().parents[4]
TARGET = ROOT / "tests" / "fixtures" / "golden"


def _epoch(day: str, *, end: bool = False) -> int:
    moment = datetime.fromisoformat(day).replace(tzinfo=UTC)
    return int(moment.timestamp()) + (86_400 if end else 0)


def _download(symbol: str) -> bytes:
    url = URL.format(symbol=symbol, start=_epoch(START), end=_epoch(END, end=True))
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (vertex golden fixture)"})
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - fixed https URL
        return response.read()


def _rows(raw: bytes) -> list[dict]:
    chart = json.loads(raw)["chart"]["result"][0]
    zone = ZoneInfo(chart["meta"]["exchangeTimezoneName"])
    quote = chart["indicators"]["quote"][0]
    adjusted = chart["indicators"]["adjclose"][0]["adjclose"]
    rows: list[dict] = []
    for index, stamp in enumerate(chart["timestamp"]):
        values = [quote["open"][index], quote["high"][index], quote["low"][index], quote["close"][index]]
        if any(value is None for value in [*values, adjusted[index], quote["volume"][index]]):
            raise SystemExit(f"missing value at {stamp}")
        day = datetime.fromtimestamp(stamp, zone).date().isoformat()
        if not START <= day <= END:
            continue
        rows.append({"date": day, "open": values[0], "high": values[1], "low": values[2], "close": values[3],
                     "adj_close": adjusted[index], "volume": quote["volume"][index]})
    return rows


def _merged(symbol: str) -> tuple[list[dict[str, str]], ih.Merged, bytes]:
    """IBKR first, Yahoo fills gaps; rows formatted for the fixture, the merge and the downloaded bytes."""
    downloads: list[bytes] = []

    def yahoo() -> list[dict]:
        raw = _download(symbol)
        downloads.append(raw)
        return _rows(raw)

    end = (date.fromisoformat(END) + timedelta(days=1)).isoformat()  # END is inclusive
    merged = ih.merged_daily(symbol, yahoo, start=START, end=end, adjust="adj_close")
    ibkr = [row for row in merged.rows if row["source"] == "ibkr"]
    if ibkr:
        downloads.insert(0, json.dumps(ibkr, sort_keys=True, separators=(",", ":")).encode())
    rows: list[dict[str, str]] = []
    for row in merged.rows:
        if row["volume"] is None:
            raise SystemExit(f"{symbol}: missing volume on {row['date']}")
        rows.append({**{key: f"{float(row[key]):.6f}" for key in FIELDS[1:6]},
                     "date": row["date"], "volume": str(int(round(row["volume"])))})
    days = [row["date"] for row in rows]
    if days != sorted(set(days)):
        raise SystemExit("dates are not unique and ascending")
    return rows, merged, b"".join(downloads)


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    files = {}
    for symbol in SYMBOLS:
        rows, merged, raw = _merged(symbol)
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        data = buffer.getvalue().encode()
        name = f"{symbol}-1d.csv"
        (TARGET / name).write_bytes(data)
        files[symbol] = {
            "file": name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "downloadSha256": hashlib.sha256(raw).hexdigest(),
            "rows": len(rows),
            "first": rows[0]["date"],
            "last": rows[-1]["date"],
            "sources": merged.summary(),
        }
        print(symbol, len(rows), rows[0]["date"], rows[-1]["date"], ih.source_note(merged))
    manifest = {
        "provider": "IBKR vertex-history daily (TRADES OHLC and volume, ADJUSTED_LAST adj_close) first; Yahoo "
                    "Finance public chart endpoint v8 (query1.finance.yahoo.com), interval 1d, fills gaps",
        "fetchedAt": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "generator": "services/research/tests/golden/fetch_yahoo.py",
        "range": {"start": START, "end": END},
        "fields": {
            "date": "exchange-local trading date (America/New_York)",
            "open, high, low, close": "split-adjusted prices in USD, rounded to 6 decimals",
            "adj_close": "split- and dividend-adjusted close as IBKR (Yahoo before IBKR's first date, rescaled on "
                         "the seam date) reported it on fetchedAt, rounded to 6 decimals",
            "volume": "shares, split-adjusted",
        },
        "adjustment": "Both backtest paths scale open, high, low and close by adj_close/close (total-return bars).",
        "delay": "End-of-day history only; the newest bar is from 2024-12-31. No live or intraday data.",
        "license": (
            "IBKR and Yahoo Finance data are for personal, non-commercial use and must not be redistributed. "
            "This copy is a test fixture in a private repository. Do not publish it, copy it to "
            "report pages or ship it in a build."
        ),
        "files": files,
    }
    (TARGET / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
