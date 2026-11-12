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

`generatedAt` of the document is the time after the last chain was read. The gate judges the bid/ask spread
only when the quotes of a chain are from the regular session of that day: the chain time minus the 15
minutes of the Cboe delay is on a NYSE trading day from 09:45 to the close in New York (13:00 on a half
day), and the chain is of the New York day of `generatedAt`. Any other chain gives "fail" (a reason that
does not need live quotes) or "spread-not-measured". A run after the close still judges the spread of a fund
whose chain Cboe last wrote during the session of the same day.

No listed options: Cboe answers HTTP 403 with an AccessDenied document for a symbol that has no chain file.
Any other 403 and an HTTP 429 (too many requests) are failures: the request is tried again after a wait.
After a 429 every worker waits, not only the worker that got it. The run reads the chain of SPY before and
after the funds. If SPY is refused, a 403 does not mean "no listed options" at that moment and the run
stops.

Exit 1 and nothing on stdout (never a partial document): the directory could not be read or is not the whole
directory, a fund of the directory has a symbol or a name that the document cannot hold (no chain is read
then), the SPY chain could not be read, or the chain of a fund could not be read or measured after 3
attempts. The first fund that fails stops all workers: the run is lost, so no more requests go out.

--listing <file> reads a saved nasdaqtraded.txt instead of the network. --save-chains <dir> keeps the chain
JSON of every fund as Cboe sent it, and also the chain of every unleveraged reference (QQQ for TQQQ, NVDA
for NVDL). A reference chain that cannot be read is named on stderr; it does not stop the run. A complete
run also writes two files there: _listing.txt, the symbol directory that the run read, and then _run.json
with `generatedAt`, the funds of the run, the funds that had no chain file and the name of the listing file.
The directory is local data; it is not committed.

--chains-from <dir> measures a saved run again and uses no network: it reads _run.json, the listing and the
chain files of a --save-chains folder, and it writes nothing there. Without --listing it reads the listing
that the run kept in the folder; the folder of a run that kept no listing needs --listing. `generatedAt` is
the one of the saved run. The run ends with exit 1 and no document when the listing has a fund whose chain
the saved run did not request (the name rules changed since that run, or --listing names another
directory): the document would be partial, and the import deletes every fund that is not in the document.
A fund of the saved run whose chain file is missing or cannot be measured ends the run too.
"""
from __future__ import annotations

import argparse
import gzip
import http.client
import json
import sys
import threading
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
RUN_FILE = "_run.json"  # in a --save-chains folder; no symbol has this name
LISTING_FILE = "_listing.txt"  # the symbol directory that the run read, in the same folder


class NoFile(Exception):
    """The server has no file for this URL (Cboe: the symbol has no listed options)."""


class Stopped(Exception):
    """The run is lost, because the chain of a fund failed: this request is not sent again."""


class Pace:
    """What all workers share: one stop flag and one back-off. `now` and `sleep` are a clock for the tests."""

    def __init__(self, now=clock.monotonic, sleep=None) -> None:
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._resume = 0.0  # on the `now` clock: no worker sends a request before this time
        self._now = now
        self._sleep = sleep or self._stop.wait  # Event.wait ends at once when the run is stopped

    def stop(self) -> None:
        self._stop.set()

    def back_off(self, seconds: float) -> None:
        """No worker sends a request in the next `seconds`."""
        with self._lock:
            self._resume = max(self._resume, self._now() + seconds)

    def wait(self, seconds: float = 0.0) -> bool:
        """Waits `seconds`, and longer while a back-off lasts. False when the run was stopped: send nothing."""
        until = self._now() + seconds
        while not self._stop.is_set():
            with self._lock:
                until = max(until, self._resume)
            left = until - self._now()
            if left <= 0:
                return True
            self._sleep(left)
        return False


def http_get(url: str, pace: Pace) -> bytes:
    """Body of a GET, up to ATTEMPTS tries. NoFile for the 403 AccessDenied reply of the Cboe file store.
    After an HTTP 429 every worker of `pace` waits. Stopped when the run was stopped between two tries."""
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    for attempt in range(ATTEMPTS):
        wait = 2 * (attempt + 1)
        try:
            with urlopen(request, timeout=TIMEOUT) as reply:
                body = reply.read()
                return gzip.decompress(body) if reply.headers.get("Content-Encoding") == "gzip" else body
        except HTTPError as error:
            headers = error.headers or {}
            if error.code == 403 and b"<Code>AccessDenied</Code>" in unpacked(error.read(), headers):
                raise NoFile(url) from None
            failure: Exception = error
            if error.code == 429:
                wait = rate_limit_wait(headers, attempt)
                pace.back_off(wait)
        except (OSError, EOFError, http.client.HTTPException) as error:  # network, timeout, cut or bad gzip body
            failure = error
        if attempt < ATTEMPTS - 1 and not pace.wait(wait):
            raise Stopped(url) from failure
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


def save(directory: Path, name: str, body: bytes) -> None:
    partial = directory / f"{name}.part"  # a killed run leaves no half file
    partial.write_bytes(body)
    partial.replace(directory / name)


def answer(fetch, symbol: str, directory: Path | None, is_fund: bool) -> tuple:
    """The chain of one symbol: ("measure", OptionsMeasure | NoOptions) for a fund, ("saved", None) for a
    reference, ("failed", text), or ("skipped", None) when the run was stopped before the answer came."""
    try:
        body = fetch(CHAIN_URL.format(symbol=symbol))
    except NoFile:
        return ("measure", liquidity.NOT_LISTED) if is_fund else ("failed", "no chain file (no listed options)")
    except Stopped:
        return "skipped", None
    except Exception as error:  # noqa: BLE001 - urllib and http.client raise many types
        return "failed", f"{type(error).__name__}: {error}"
    try:
        if directory is not None:
            save(directory, f"{symbol}.json", body)  # the raw chain first: a failed measure must not lose it
        return ("measure", liquidity.measure(json.loads(body), symbol)) if is_fund else ("saved", None)
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError, OSError) as error:
        return "failed", f"{type(error).__name__}: {error}"  # OverflowError: an Infinity where a count is read


def read_chain(fetch, symbol: str, directory: Path | None, is_fund: bool, delay: float, pace: Pace) -> tuple:
    """`answer` after the wait of one worker. A fund that fails stops the run for every worker: the document
    is lost then, and each further request would be sent for nothing."""
    if not pace.wait(delay):
        return "skipped", None
    result = answer(fetch, symbol, directory, is_fund)
    if is_fund and result[0] == "failed":
        pace.stop()
    return result


def counts(values) -> str:
    """"key: count" of the values, sorted by key; numbers print without a trailing ".0"."""
    counted = Counter(values)
    return ", ".join(f"{key:g}: {counted[key]}" if isinstance(key, float) else f"{key}: {counted[key]}"
                     for key in sorted(counted)) or "none"


def saved_run(directory: Path) -> tuple:
    """(generatedAt, the fund symbols, fetch, the listing file or None) of the --save-chains folder of a
    complete run. `fetch(url)` returns a saved chain, or raises NoFile for a fund that had no chain file in
    that run. The listing file is None for a run that kept no listing."""
    run = json.loads((directory / RUN_FILE).read_text(encoding="utf-8"))
    generated_at = datetime.strptime(run["generatedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    funds, without = frozenset(run["funds"]), frozenset(run["noChainFile"])
    name = run.get("listing")
    if name is not None and (not isinstance(name, str) or Path(name).name != name):
        raise ValueError(f"the listing {name!r} is not the name of a file in the folder")

    def fetch(url: str) -> bytes:
        symbol = url.rsplit("/", 1)[1].removesuffix(".json")
        if symbol in without:
            raise NoFile(url)
        return (directory / f"{symbol}.json").read_bytes()

    return generated_at, funds, fetch, directory / name if name is not None else None


def collect(fetch, now, rows, save_chains: Path | None = None, saved_funds: frozenset | None = None,
            out=None, log=lambda *parts: print(*parts, file=sys.stderr), delay: float | None = None,
            workers: int = WORKERS, pace: Pace | None = None, listing: str | None = None) -> int:
    """One run. `fetch(url)` returns the body or raises NoFile, `now()` is the UTC time and `rows` are the
    rows of the symbol directory. `saved_funds` are the funds of a saved run (--chains-from): every fund of
    the directory must be one of them, and the control chain is not read. `delay` None = DELAY. `listing`
    is the text of the symbol directory: a complete run keeps it in `save_chains`. Returns the exit code."""
    pace = pace or Pace()
    out = sys.stdout if out is None else out
    delay = DELAY if delay is None else delay
    funds = universe.listed_funds(rows)
    unreadable = universe.unclassified(rows)
    log(f"directory: {len(rows)} rows, {len(funds)} leveraged or inverse products "
        f"({counts(fund.product_type for fund in funds)})")
    log(f"by leverage: {counts(fund.leverage for fund in funds)}")
    log(f"unclassified names (the name signals leverage, the fund is not in the document): {len(unreadable)}")
    for symbol, name, reason in unreadable:
        log(f"  {symbol}  {name}  ({reason})")
    if not funds:
        log("error: the directory lists no leveraged product; nothing to write")
        return 1
    try:
        for fund in funds:
            liquidity.check_fund(fund)  # before any request: the import would refuse the whole document
    except ValueError as error:
        log(f"error: {error}; no chain was read")
        return 1
    if saved_funds is not None:
        not_requested = [fund.symbol for fund in funds if fund.symbol not in saved_funds]
        if not_requested:
            log(f"error: the saved run did not request the chains of {len(not_requested)} funds of this directory; "
                "the document is not written, because it would be partial")
            log(f"  {' '.join(not_requested)}")
            return 1
    live = saved_funds is None
    if live and not control_reads(fetch, log):
        return 1
    if save_chains is not None:
        save_chains.mkdir(parents=True, exist_ok=True)
    own = {fund.symbol for fund in funds}
    references = sorted({fund.underlying for fund in funds if fund.underlying} - own) if save_chains is not None else []
    jobs = [(fund.symbol, True) for fund in funds] + [(symbol, False) for symbol in references]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda job: read_chain(fetch, job[0], save_chains, job[1], delay, pace), jobs))

    measures, failures, reference_failures = {}, [], []
    for (symbol, is_fund), (kind, value) in zip(jobs, results):
        if kind == "failed":
            (failures if is_fund else reference_failures).append((symbol, value))
        elif kind == "measure":
            measures[symbol] = value
    log(f"fetch failures of funds: {len(failures)}")
    for symbol, reason in failures:
        log(f"  {symbol}  {reason}")
    if reference_failures:
        log(f"reference chains not saved: {len(reference_failures)}")
        for symbol, reason in reference_failures:
            log(f"  {symbol}  {reason}")
    if failures:
        log(f"requests not sent after the first failure: {sum(kind == 'skipped' for kind, _ in results)}")
        log("error: the document is not written, because it would be partial")
        return 1
    if live and not control_reads(fetch, log):
        return 1
    try:
        document = liquidity.document(((fund, measures[fund.symbol]) for fund in funds), now())
        text = json.dumps(document, indent=1, allow_nan=False)  # a NaN or an Infinity is not JSON
    except ValueError as error:
        log(f"error: {error}")
        return 1

    entries = document["funds"]
    listed = [entry for entry in entries if entry["optionsListed"]]
    log(f"funds in the document: {len(entries)}")
    log(f"options listed: yes {len(listed)}, no {len(entries) - len(listed)}")
    log(f"by gate label: {counts(entry['optionGate'] for entry in entries)}")
    log(f"by gate reason: {counts(reason for entry in entries for reason in entry['optionGateReasons'])}")
    log(f"chains by session: {counts(entry['options']['session'] for entry in listed)}")
    log(f"chains by UTC day of the quote: {counts(entry['options']['quotedAt'][:10] for entry in listed)}")
    log(f"reference mapped: {sum(entry['underlying'] is not None for entry in entries)}, "
        f"not mapped: {sum(entry['underlying'] is None for entry in entries)}")
    if save_chains is not None:
        run = {"generatedAt": document["generatedAt"], "funds": [entry["symbol"] for entry in entries],
               "noChainFile": sorted(symbol for symbol, value in measures.items() if value is liquidity.NOT_LISTED)}
        written = RUN_FILE
        try:
            if listing is not None:
                written = run["listing"] = LISTING_FILE
                save(save_chains, LISTING_FILE, listing.encode())
                written = RUN_FILE
            save(save_chains, RUN_FILE, (json.dumps(run, indent=1) + "\n").encode())  # last: it marks a complete run
        except OSError as error:
            log(f"error: {save_chains / written} could not be written: {type(error).__name__}: {error}")
            return 1
        saved = sum(kind == "saved" or (kind == "measure" and value is not liquidity.NOT_LISTED) for kind, value in results)
        log(f"chains saved: {saved} in {save_chains}")
    out.write(f"{text}\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--listing", type=Path, metavar="FILE", help="a saved nasdaqtraded.txt (default: read it from Nasdaq Trader)")
    chains = parser.add_mutually_exclusive_group()
    chains.add_argument("--save-chains", type=Path, metavar="DIR", help="keep the raw chain JSON files here (local data, not committed)")
    chains.add_argument("--chains-from", type=Path, metavar="DIR", help="measure the saved run of this --save-chains folder again (no network; needs --listing when the folder holds no listing)")
    args = parser.parse_args()
    pace = Pace()
    listing_file = args.listing.expanduser() if args.listing is not None else None
    saved = None
    if args.chains_from is not None:
        directory = args.chains_from.expanduser()
        try:
            saved = saved_run(directory)
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(f"error: {directory} is not the folder of a complete run: {type(error).__name__}: {error}", file=sys.stderr)
            return 1
        listing_file = listing_file or saved[3]
        if listing_file is None:
            parser.error(f"--chains-from needs --listing: the run of {directory} kept no listing")
    try:
        if listing_file is not None:
            listing = listing_file.read_text(encoding="utf-8", errors="replace")
        else:
            listing = http_get(universe.LISTING_URL, pace).decode("utf-8", errors="replace")
    except Exception as error:  # noqa: BLE001 - urllib and http.client raise many types
        print(f"error: the symbol directory could not be read: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    try:
        rows = universe.parse_listing(listing)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if saved is None:
        return collect(lambda url: http_get(url, pace), lambda: datetime.now(timezone.utc), rows,
                       save_chains=args.save_chains.expanduser() if args.save_chains is not None else None, pace=pace,
                       listing=listing)
    generated_at, saved_funds, fetch, _ = saved
    return collect(fetch, lambda: generated_at, rows, saved_funds=saved_funds, delay=0)


if __name__ == "__main__":
    sys.exit(main())
