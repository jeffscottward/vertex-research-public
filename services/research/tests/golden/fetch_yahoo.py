"""Download the frozen daily-bar fixture for the golden backtest battery.

Not a test and not a runtime dependency. Run it only to rebuild the fixture:

    python3 services/research/tests/golden/fetch_yahoo.py

Source: the public Yahoo Finance chart endpoint (v8, interval 1d), the same free
source that the instant-backtest evidence and the quant-lab research branch use.
No account, key or payment is needed. The output is a frozen copy: a new download
can differ, because Yahoo restates adjusted closes after each dividend. Do not
rebuild the fixture unless the golden reference is also rebuilt.

Writes tests/fixtures/golden/<SYMBOL>-1d.csv and tests/fixtures/golden/manifest.json.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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


def _rows(raw: bytes) -> list[dict[str, str]]:
    chart = json.loads(raw)["chart"]["result"][0]
    zone = ZoneInfo(chart["meta"]["exchangeTimezoneName"])
    quote = chart["indicators"]["quote"][0]
    adjusted = chart["indicators"]["adjclose"][0]["adjclose"]
    rows: list[dict[str, str]] = []
    for index, stamp in enumerate(chart["timestamp"]):
        values = [quote["open"][index], quote["high"][index], quote["low"][index], quote["close"][index]]
        if any(value is None for value in [*values, adjusted[index], quote["volume"][index]]):
            raise SystemExit(f"missing value at {stamp}")
        day = datetime.fromtimestamp(stamp, zone).date().isoformat()
        if not START <= day <= END:
            continue
        rows.append(
            {
                "date": day,
                "open": f"{values[0]:.6f}",
                "high": f"{values[1]:.6f}",
                "low": f"{values[2]:.6f}",
                "close": f"{values[3]:.6f}",
                "adj_close": f"{adjusted[index]:.6f}",
                "volume": str(int(quote["volume"][index])),
            }
        )
    days = [row["date"] for row in rows]
    if days != sorted(set(days)):
        raise SystemExit("dates are not unique and ascending")
    return rows


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    files = {}
    for symbol in SYMBOLS:
        raw = _download(symbol)
        rows = _rows(raw)
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
        }
        print(symbol, len(rows), rows[0]["date"], rows[-1]["date"])
    manifest = {
        "provider": "Yahoo Finance public chart endpoint v8 (query1.finance.yahoo.com), interval 1d",
        "fetchedAt": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "generator": "services/research/tests/golden/fetch_yahoo.py",
        "range": {"start": START, "end": END},
        "fields": {
            "date": "exchange-local trading date (America/New_York)",
            "open, high, low, close": "split-adjusted prices in USD, rounded to 6 decimals",
            "adj_close": "split- and dividend-adjusted close as Yahoo reported it on fetchedAt, rounded to 6 decimals",
            "volume": "shares, split-adjusted",
        },
        "adjustment": "Both backtest paths scale open, high, low and close by adj_close/close (total-return bars).",
        "delay": "End-of-day history only; the newest bar is from 2024-12-31. No live or intraday data.",
        "license": (
            "Yahoo Finance data is for personal, non-commercial use and must not be redistributed. "
            "This copy is a test fixture in a private repository. Do not publish it, copy it to "
            "report pages or ship it in a build."
        ),
        "files": files,
    }
    (TARGET / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
