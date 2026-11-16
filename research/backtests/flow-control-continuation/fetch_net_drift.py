"""Resumable download of the QuantData net drift history for the options-side continuation study (research only).

Writes one file per ticker, part and session under --data (outside the repository): the vendor's `data` object.
Reads the key only from the process environment variable QUANTDATA_API_KEY (no .env file, no repository file).
A second run resumes: files that hold data or the empty object are not requested again.

  ~/.cache/vertex-academy-nautilus-venv/bin/python research/backtests/flow-control-continuation/fetch_net_drift.py \
      --data ~/Documents/reports/vertex-flow-control-data --dry-run

Exit codes: 0 when nothing failed or is pending; 1 otherwise (run again to resume); 2 for a missing key, a refused
key or a data folder inside the repository.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.flow_control import data, download  # noqa: E402


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def yesterday() -> str:
    return (datetime.now(ZoneInfo("America/New_York")).date() - timedelta(days=1)).isoformat()


def make_post(key: str) -> Callable[[dict], tuple[int, object, Mapping[str, str]]]:
    url = download.BASE_URL + download.ENDPOINT

    def post(body: dict) -> tuple[int, object, Mapping[str, str]]:
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                         headers={"authorization": f"Bearer {key}",
                                                  "content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=download.REQUEST_TIMEOUT_SECONDS) as response:
                raw = response.read()
                headers = dict(response.headers.items())
                try:
                    return response.status, json.loads(raw), headers
                except ValueError:
                    return response.status, None, headers
        except urllib.error.HTTPError as error:
            return error.code, None, dict(error.headers.items()) if error.headers else {}
        except (urllib.error.URLError, TimeoutError):
            return 0, None, {}

    return post


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--data", type=Path, default=None, help=f"data folder (default {data.DEFAULT_ROOT})")
    parser.add_argument("--to", default=None, help="last session (default: yesterday in New York)")
    parser.add_argument("--from", dest="first", default=download.FIRST_DAY)
    parser.add_argument("--dry-run", action="store_true", help="print the pending count and time; send nothing")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, post_factory=make_post, sleep=time.sleep,
         environ: Mapping[str, str] = os.environ) -> int:
    args = parse_args(argv)
    try:
        root = download.outside_repository(data.data_root(args.data), ROOT)
    except SystemExit as error:
        log(str(error))
        return 2
    items = download.plan(root, args.to or yesterday(), args.first)
    pending = sum(1 for item in items if item[3] == "pending")
    if args.dry_run:
        hours = pending * download.REQUEST_INTERVAL_SECONDS / 3600
        print(f"{pending} pending files of {len(items)}; about {hours:.1f} hours at "
              f"{download.REQUEST_INTERVAL_SECONDS} s per request")
        return 0
    key = environ.get(download.KEY_ENV, "").strip()
    if not key:
        log(f"{download.KEY_ENV} is not set")
        return 2
    try:
        counts = download.fetch_all(items, root, post_factory(key), sleep, log)
    except download.AuthError as error:
        log(f"key refused ({error})")
        return 2
    log(json.dumps(counts))
    return 0 if counts["failed"] == 0 and counts["pending"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
