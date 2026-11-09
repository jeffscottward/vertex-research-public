#!/usr/bin/env python3
"""Dukascopy public 1-minute candles (bid + ask, tick volume) for the volume-spike-breakout study.

Research only; the data stays on the rig (not redistributed, not in the repository). Unlike the
market-intraday-momentum fetcher this one keeps the FULL trading session (no session filter): the rule
holds positions overnight and its signal window starts at 08:30 New York, before the cash open.

    python research/backtests/volspike/fetch_data.py [--workers 7] [--allow-missing] [instrument ...]
    python research/backtests/volspike/fetch_data.py --manifest          # only rebuild manifest.json

Output: <root>/m1/<instrument>-<side>.csv.gz, header timestamp,open,high,low,close,volume (UTC ms, bar
open time). Root: VERTEX_VOLSPIKE_DATA_ROOT or ~/Documents/reports/vertex-volume-spike-data.
One month per request; a failed month is retried once; months that still fail are logged and (without
--allow-missing) the target is not written, so the next run fetches only the missing months. Month parts are
kept in <root>/parts until their target exists. Targets are written to a temporary file and renamed; an
existing target is skipped. With --allow-missing a target is written without the failed months and they are
stored next to it in `<target>.missing` (one month per line): every later run reads that file, logs the hole,
lists it in the manifest and exits with 1 until the target is deleted and fetched again. manifest.json holds
rows, first and last bar and the sha256 of every target, the missing months and one data hash over all
targets.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from pathlib import Path

START = date(2018, 1, 1)
END = date(2026, 11, 7)  # exclusive: the last bar is on 2026-11-06
SIDES = ("bid", "ask")
HEADER = ["timestamp", "open", "high", "low", "close", "volume"]
# (Dukascopy id, first day with data when it is after START).
INSTRUMENTS: tuple[tuple[str, date], ...] = (
    ("usatechidxusd", START), ("usa500idxusd", START), ("usa30idxusd", START),
    ("ussc2000idxusd", date(2018, 8, 8)), ("xauusd", START), ("xagusd", START), ("lightcmdusd", START),
)
PACKAGE = "dukascopy-node@1.51.1"
TIMEOUT_S = 900


def data_root() -> Path:
    return Path(os.environ.get("VERTEX_VOLSPIKE_DATA_ROOT",
                               Path.home() / "Documents" / "reports" / "vertex-volume-spike-data"))


def months(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Half-open [from, to) request ranges, one per calendar month, clipped to [start, end)."""
    cur = date(start.year, start.month, 1)
    while cur < end:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        yield max(cur, start), min(nxt, end)
        cur = nxt


def command(inst: str, side: str, start: date, end: date, tmp: str) -> list[str]:
    return ["npx", "-y", PACKAGE, "-i", inst, "-from", start.isoformat(), "-to", end.isoformat(),
            "-t", "m1", "-p", side, "-v", "-f", "csv", "-dir", tmp, "-fn", "x", "-r", "3", "-bs", "10", "-bp", "300"]


def fetch_month(inst: str, side: str, start: date, end: date, cwd: Path) -> list[list[str]] | None:
    """Rows of one month (without the header), or None when the download failed."""
    with tempfile.TemporaryDirectory() as tmp:
        try:
            proc = subprocess.run(command(inst, side, start, end, tmp), cwd=cwd, check=False,
                                  capture_output=True, text=True, timeout=TIMEOUT_S)
        except (subprocess.TimeoutExpired, OSError):
            return None
        path = Path(tmp) / "x.csv"
        if proc.returncode != 0 or "wrong" in proc.stdout or not path.exists():
            return None
        with path.open() as fh:
            rows = list(csv.reader(fh))
    return [r for r in rows[1:] if len(r) == len(HEADER)]


def clean(rows: list[list[str]]) -> list[list[str]]:
    """Sorted by time, one row per timestamp (the first seen wins)."""
    seen: dict[int, list[str]] = {}
    for r in rows:
        seen.setdefault(int(r[0]), r)
    return [seen[t] for t in sorted(seen)]


def write_gz(path: Path, rows: list[list[str]]) -> None:
    """Temporary file, then rename. mtime 0 keeps the bytes (and the sha256) the same for the same rows."""
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        text = "\n".join(",".join(r) for r in [HEADER, *rows]) + "\n"
        gz.write(text.encode())
    tmp.replace(path)


def read_gz(path: Path) -> list[list[str]]:
    with gzip.open(path, "rt", newline="") as fh:
        return list(csv.reader(fh))[1:]


def log(root: Path, text: str) -> None:
    line = f"{datetime.now(UTC).isoformat(timespec='seconds')} {text}"
    print(line, flush=True)
    with (root / "fetch.log").open("a") as fh:
        fh.write(line + "\n")


def assemble(target: Path, parts: list[Path]) -> int:
    """Streams the month parts (each sorted, in month order) into the target; returns the row count.
    Memory stays at one month. A timestamp at or before the last written one is dropped."""
    tmp = target.with_name(target.name + ".tmp")
    rows = 0
    last = -1
    with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        gz.write((",".join(HEADER) + "\n").encode())
        for part in parts:
            keep = [r for r in read_gz(part) if int(r[0]) > last]
            if not keep:
                continue
            gz.write(("\n".join(",".join(r) for r in keep) + "\n").encode())
            last = int(keep[-1][0])
            rows += len(keep)
    tmp.replace(target)
    return rows


def missing_file(target: Path) -> Path:
    return target.with_name(target.name + ".missing")


def recorded_missing(target: Path) -> list[str]:
    """The months a target was written without (ISO first days), from the file next to it."""
    path = missing_file(target)
    return [line.strip() for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def fetch_target(root: Path, inst: str, first: date, side: str, allow_missing: bool) -> list[str]:
    """Builds m1/<inst>-<side>.csv.gz; returns the months that failed (ISO first days). An existing target is
    not fetched again; the months it was written without (--allow-missing) are returned on every run."""
    target = root / "m1" / f"{inst}-{side}.csv.gz"
    if target.exists():
        missing = recorded_missing(target)
        if missing:
            log(root, f"MISSING {inst} {side}: the target lacks {len(missing)} months {missing}; delete it to fetch again")
        return missing
    failed: list[str] = []
    have: list[Path] = []
    for a, b in months(max(first, START), END):
        part = root / "parts" / f"{inst}-{side}-{a.isoformat()}.csv.gz"
        if not part.exists():
            got = fetch_month(inst, side, a, b, root)
            if got is None:
                got = fetch_month(inst, side, a, b, root)
            if got is None:
                failed.append(a.isoformat())
                log(root, f"FAILED {inst} {side} {a.isoformat()}")
                continue
            if not got:
                log(root, f"EMPTY {inst} {side} {a.isoformat()}")
            write_gz(part, clean(got))
        have.append(part)
    if failed and not allow_missing:
        log(root, f"INCOMPLETE {inst} {side}: {len(failed)} months missing, target not written")
        return failed
    if failed:
        # The record of the hole is written BEFORE the target appears: a crash in between cannot hide it.
        tmp = missing_file(target).with_name(missing_file(target).name + ".tmp")
        tmp.write_text("\n".join(failed) + "\n")
        tmp.replace(missing_file(target))
    rows = assemble(target, have)
    if not failed:
        missing_file(target).unlink(missing_ok=True)
    for part in have:
        part.unlink()
    log(root, f"DONE {inst} {side}: {rows} rows" + (f", missing months {failed}" if failed else ""))
    return failed


def fetch_instrument(root: Path, inst: str, first: date, allow_missing: bool) -> dict[str, list[str]]:
    return {f"{inst}-{side}": fetch_target(root, inst, first, side, allow_missing) for side in SIDES}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def combined_hash(hashes: dict[str, str]) -> str:
    """One sha256 over the per-file hashes: lines '<file name> <sha256>' sorted by name."""
    text = "".join(f"{name} {hashes[name]}\n" for name in sorted(hashes))
    return hashlib.sha256(text.encode()).hexdigest()


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).isoformat(timespec="minutes").replace("+00:00", "Z")


def file_summary(path: Path) -> dict:
    rows = 0
    first = last = None
    with gzip.open(path, "rt") as fh:
        next(fh, None)
        for line in fh:
            stamp = int(line[:line.index(",")])
            first = stamp if first is None else first
            last = stamp
            rows += 1
    return {"rows": rows, "firstBar": None if first is None else iso(first),
            "lastBar": None if last is None else iso(last), "bytes": path.stat().st_size, "sha256": sha256_of(path)}


def build_manifest(root: Path, missing: dict[str, list[str]] | None = None) -> dict:
    targets = sorted((root / "m1").glob("*.csv.gz"))
    files = {p.name: file_summary(p) for p in targets}
    recorded = {p.name[:-len(".csv.gz")]: recorded_missing(p) for p in targets}
    missing = {**{k: v for k, v in recorded.items() if v}, **{k: v for k, v in (missing or {}).items() if v}}
    manifest = {
        "source": f"Dukascopy public 1-minute candles via {PACKAGE} (bid and ask, tick volume, full session)",
        "from": START.isoformat(), "toExclusive": END.isoformat(),
        "files": files,
        "missingMonths": {k: v for k, v in (missing or {}).items() if v},
        "dataHash": combined_hash({name: item["sha256"] for name, item in files.items()}),
    }
    tmp = root / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2) + "\n")
    tmp.replace(root / "manifest.json")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("instruments", nargs="*")
    parser.add_argument("--workers", type=int, default=len(INSTRUMENTS))
    parser.add_argument("--allow-missing", action="store_true")
    parser.add_argument("--manifest", action="store_true", help="only rebuild manifest.json from the files")
    args = parser.parse_args(argv)
    root = data_root()
    (root / "m1").mkdir(parents=True, exist_ok=True)
    (root / "parts").mkdir(parents=True, exist_ok=True)
    missing: dict[str, list[str]] = {}
    if not args.manifest:
        chosen = [(inst, first) for inst, first in INSTRUMENTS if not args.instruments or inst in args.instruments]
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            for result in pool.map(lambda item: fetch_instrument(root, item[0], item[1], args.allow_missing), chosen):
                missing.update(result)
    manifest = build_manifest(root, missing)
    for name, item in manifest["files"].items():
        log(root, f"FILE {name}: {item['rows']} rows, {item['firstBar']} to {item['lastBar']}, sha256 {item['sha256']}")
    log(root, f"DATA HASH {manifest['dataHash']}")
    for name, months_ in manifest["missingMonths"].items():
        log(root, f"MISSING {name}: {len(months_)} months {months_}")
    return 1 if manifest["missingMonths"] else 0


if __name__ == "__main__":
    sys.exit(main())
