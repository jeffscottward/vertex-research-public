"""Universe of the US-listed leveraged and inverse funds with their option liquidity (research only, free
public data, no key). It never places orders.

Reads the Nasdaq Trader symbol directory (every US-listed security) and keeps the leveraged and inverse
exchange-traded funds and notes: services/research/strategies/leveraged_etf/universe.py reads the signed
multiple and the unleveraged reference from the listed name. Then it reads the Cboe delayed option chain of
every fund and applies the option gate of services/research/strategies/leveraged_etf/liquidity.py. The
universe document (JSON, schema leveraged-etf-universe-v1) goes to stdout, a summary to stderr. This file is
the only one with network I/O. It needs the Python standard library only.

  python3 research/backtests/leveraged-etf/universe.py \
      --save-chains ~/Documents/reports/vertex-leveraged-etf/chains/<UTC stamp> \
      > ~/Documents/reports/vertex-leveraged-etf/universe-<UTC stamp>.json

The gate judges the bid/ask spread only on a chain that Cboe wrote during the option session (a weekday,
09:45 to 16:00 New York). A run outside the session gives "fail" (a reason that does not need live quotes)
or "spread-not-measured" for every fund; no fund can pass then.

No listed options: Cboe answers HTTP 403 with an AccessDenied document for a symbol that has no chain file.
Any other 403 and an HTTP 429 (too many requests) are failures: the request is tried again after a wait.
The run reads the chain of SPY before and after the funds. If SPY is refused, a 403 does not mean "no listed
options" at that moment and the run stops.

Exit 1 and nothing on stdout (never a partial document): the directory or the SPY chain could not be read,
or the chain of a fund could not be read or measured after 3 attempts. With --allow-missing such a fund is
left out of the document and named on stderr, and the run exits 0.

--listing <file> reads a saved nasdaqtraded.txt instead of the network. --save-chains <dir> keeps the chain
JSON of every fund as Cboe sent it, and also the chain of every unleveraged reference (QQQ for TQQQ, NVDA
for NVDL). A reference chain that cannot be read is named on stderr; it does not stop the run. The
directory is local data; it is not committed.
"""
from __future__ import annotations

import argparse
import gzip
import http.client
import json
import sys
import time as clock
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))

from strategies.leveraged_etf import liquidity, universe  # noqa: E402

CHAIN_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
USER_AGENT = "Mozilla/5.0 (compatible; vertex-research-leveraged-etf-universe/1; research, one run per day)"
CONTROL = "SPY"  # has listed options on every day
WORKERS = 4
DELAY = 1.0  # seconds that a worker waits before each request; Cboe answered 429 at 0.25 (run of 2026-11-12)
ATTEMPTS = 3
TIMEOUT = 30
RATE_LIMIT_WAIT = 30  # seconds after an HTTP 429 without a Retry-After header, times the attempt number
MAX_RETRY_AFTER = 120


class NoFile(Exception):
    """The server has no file for this URL (Cboe: the symbol has no listed options)."""


def http_get(url: str) -> bytes:
    """Body of a GET, up to ATTEMPTS tries. NoFile for the 403 AccessDenied reply of the Cboe file store."""
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    for attempt in range(ATTEMPTS):
        try:
            with urlopen(request, timeout=TIMEOUT) as reply:
                body = reply.read()
                return gzip.decompress(body) if reply.headers.get("Content-Encoding") == "gzip" else body
        except HTTPError as error:
            headers = error.headers or {}
            if error.code == 403 and b"<Code>AccessDenied</Code>" in unpacked(error.read(), headers):
                raise NoFile(url) from None
            failure: Exception = error
            wait = rate_limit_wait(headers, attempt) if error.code == 429 else 2 * (attempt + 1)
        except (OSError, EOFError, http.client.HTTPException) as error:  # network, timeout, cut or bad gzip body
            failure = error
            wait = 2 * (attempt + 1)
        if attempt < ATTEMPTS - 1:
            clock.sleep(wait)
    raise failure


def unpacked(body: bytes, headers) -> bytes:
    """An error body as text bytes. Cboe sends the AccessDenied document gzip-packed when gzip was asked for."""
    if headers.get("Content-Encoding") != "gzip":
        return body
    try:
        return gzip.decompress(body)
    except (OSError, EOFError):
        return body


def rate_limit_wait(headers, attempt: int) -> float:
    """Seconds to wait after an HTTP 429: the Retry-After header (at most MAX_RETRY_AFTER), else a fixed step."""
    text = str(headers.get("Retry-After") or "")
    return min(int(text), MAX_RETRY_AFTER) if text.isdigit() else RATE_LIMIT_WAIT * (attempt + 1)


def has_options(body: bytes) -> bool:
    try:
        return bool(json.loads(body)["data"]["options"])
    except (ValueError, KeyError, TypeError):
        return False


def control_reads(fetch, log) -> bool:
    """True when the chain of CONTROL can be read, so a NoFile reply for a fund means "no listed options"."""
    try:
        if has_options(fetch(CHAIN_URL.format(symbol=CONTROL))):
            return True
        log(f"error: the {CONTROL} chain has no options; Cboe sends no usable chains now")
    except NoFile:
        log(f"error: Cboe has no chain file for {CONTROL}; a missing file does not mean 'no listed options' now")
    except Exception as error:  # noqa: BLE001 - urllib and http.client raise many types
        log(f"error: the {CONTROL} chain could not be read: {type(error).__name__}: {error}")
    return False


def save(directory: Path, symbol: str, body: bytes) -> None:
    partial = directory / f"{symbol}.json.part"  # a killed run leaves no half file
    partial.write_bytes(body)
    partial.replace(directory / f"{symbol}.json")


def read_chain(fetch, symbol: str, directory: Path | None, measured: bool, delay: float) -> tuple:
    """("measure", OptionsMeasure | None), ("saved", None) or ("failed", text) for one symbol."""
    clock.sleep(delay)
    try:
        body = fetch(CHAIN_URL.format(symbol=symbol))
    except NoFile:
        return ("measure", None) if measured else ("failed", "no chain file (no listed options)")
    except Exception as error:  # noqa: BLE001 - urllib and http.client raise many types
        return "failed", f"{type(error).__name__}: {error}"
    try:
        if directory is not None:
            save(directory, symbol, body)  # the raw chain first: a failed measure must not lose it
        return ("measure", liquidity.measure(json.loads(body))) if measured else ("saved", None)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        return "failed", f"{type(error).__name__}: {error}"


def counts(values) -> str:
    """"key: count" of the values, sorted by key; numbers print without a trailing ".0"."""
    counted = Counter(values)
    return ", ".join(f"{key:g}: {counted[key]}" if isinstance(key, float) else f"{key}: {counted[key]}"
                     for key in sorted(counted)) or "none"


def collect(fetch, now: datetime, listing: str, save_chains: Path | None = None, allow_missing: bool = False,
            out=sys.stdout, log=lambda *parts: print(*parts, file=sys.stderr), delay: float = DELAY) -> int:
    """One run. `fetch(url)` returns the body or raises NoFile. Returns the exit code."""
    rows = universe.parse_listing(listing)
    funds = universe.listed_funds(rows)
    unreadable = universe.unclassified(rows)
    log(f"directory: {len(rows)} rows, {len(funds)} leveraged or inverse products "
        f"({counts(fund.product_type for fund in funds)})")
    log(f"by leverage: {counts(fund.leverage for fund in funds)}")
    log(f"unclassified names (the name signals leverage, no rule reads a multiple): {len(unreadable)}")
    for symbol, name in unreadable:
        log(f"  {symbol}  {name}")
    if not funds:
        log("error: the directory lists no leveraged product; nothing to write")
        return 1
    if not control_reads(fetch, log):
        return 1
    if save_chains is not None:
        save_chains.mkdir(parents=True, exist_ok=True)
    own = {fund.symbol for fund in funds}
    references = sorted({fund.underlying for fund in funds if fund.underlying} - own) if save_chains is not None else []
    jobs = [(fund.symbol, True) for fund in funds] + [(symbol, False) for symbol in references]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(lambda job: read_chain(fetch, job[0], save_chains, job[1], delay), jobs))
    if not control_reads(fetch, log):
        return 1

    measures, failures, reference_failures = {}, [], []
    for (symbol, is_fund), (kind, value) in zip(jobs, results):
        if kind == "failed":
            (failures if is_fund else reference_failures).append((symbol, value))
        elif is_fund:
            measures[symbol] = value
    log(f"fetch failures of funds: {len(failures)}")
    for symbol, reason in failures:
        log(f"  {symbol}  {reason}")
    if reference_failures:
        log(f"reference chains not saved: {len(reference_failures)}")
        for symbol, reason in reference_failures:
            log(f"  {symbol}  {reason}")
    if failures and not allow_missing:
        log("error: the document is not written, because it would be partial (use --allow-missing to leave these funds out)")
        return 1
    try:
        document = liquidity.document(((fund, measures[fund.symbol]) for fund in funds if fund.symbol in measures), now)
    except ValueError as error:
        log(f"error: {error}")
        return 1

    entries = document["funds"]
    listed = [entry for entry in entries if entry["optionsListed"]]
    log(f"funds in the document: {len(entries)}" + (f" ({len(failures)} left out)" if failures else ""))
    log(f"options listed: yes {len(listed)}, no {len(entries) - len(listed)}")
    log(f"by gate label: {counts(entry['optionGate'] for entry in entries)}")
    log(f"by gate reason: {counts(reason for entry in entries for reason in entry['optionGateReasons'])}")
    log(f"chains by session: {counts(entry['options']['session'] for entry in listed)}")
    log(f"chains by UTC day of the quote: {counts(entry['options']['quotedAt'][:10] for entry in listed)}")
    log(f"reference mapped: {sum(entry['underlying'] is not None for entry in entries)}, "
        f"not mapped: {sum(entry['underlying'] is None for entry in entries)}")
    if save_chains is not None:
        saved = sum(kind == "saved" or (kind == "measure" and value is not None) for kind, value in results)
        log(f"chains saved: {saved} in {save_chains}")
    json.dump(document, out, indent=1)
    out.write("\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--listing", type=Path, metavar="FILE", help="a saved nasdaqtraded.txt (default: read it from Nasdaq Trader)")
    parser.add_argument("--save-chains", type=Path, metavar="DIR", help="keep the raw chain JSON files here (local data, not committed)")
    parser.add_argument("--allow-missing", action="store_true", help="leave a fund whose chain cannot be read out of the document")
    args = parser.parse_args()
    try:
        if args.listing is not None:
            listing = args.listing.expanduser().read_text(encoding="utf-8", errors="replace")
        else:
            listing = http_get(universe.LISTING_URL).decode("utf-8", errors="replace")
    except Exception as error:  # noqa: BLE001 - urllib and http.client raise many types
        print(f"error: the symbol directory could not be read: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return collect(http_get, datetime.now(timezone.utc), listing,
                   save_chains=args.save_chains.expanduser() if args.save_chains is not None else None,
                   allow_missing=args.allow_missing)


if __name__ == "__main__":
    sys.exit(main())
