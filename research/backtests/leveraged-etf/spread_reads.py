"""Spread runs of the leveraged ETF option gate version 2: the collector (research only, free public data, no
key). It never places orders.

One run reads the Cboe delayed option chain of the funds of its fund list, finds the candidates (the chain
lists the session expiry and has at least 1000 contracts of open interest in the band at that expiry), reads
the Yahoo chain of the session expiry of each candidate, and writes one run folder. The timer makes three
runs per session.

The fund list (`cboeScope` in run.json). "all": every fund of the universe file that has listed options.
"candidates": the candidates of the newest earlier run of the same session day that read every fund
(`candidatesFrom` names it); a run reads them when the store has such a run that was made inside the session,
has ended, and had at most 20% failed Cboe reads. So the first run of a day reads every fund and the later
runs read its candidates: Cboe answers HTTP 429 often, and a read of every fund takes far longer than a read
of the candidates. The build (gate_v2.py, no network) turns the stored runs into
one result per fund. The rule is services/research/strategies/leveraged_etf/spread_gate.py. Design:
docs/specs/research/leveraged-etf-option-gate-v2.md.

  uv run --no-project --python 3.12 --with yfinance==0.2.66 python research/backtests/leveraged-etf/spread_reads.py \
      --store ~/.local/share/vertex/leveraged-etf-spreads \
      --universe ~/.local/share/vertex/leveraged-etf-spreads-universe.json

The universe file is the document of universe.py of this folder; only its fund list is read.

Run folder: <store>/<New York day>/<HHMMSS>Z/ (the UTC time of the start) with
  run.json                the record of the run (schema leveraged-etf-spread-run-v1), written at the start, after
                          the Cboe phase and at the end; a run that is killed leaves it with `finishedAt` null
  cboe/<SYMBOL>.json.gz   the chain as Cboe sent it, for the candidates only
  yahoo/<SYMBOL>.json     the quotes of the session expiry, for the candidates that Yahoo answered
The store is local data; it is not committed. Day folders of more than 45 days before the run are deleted.

A run writes nothing and exits 0 when the clock is outside 09:45 to the close of a NYSE session in New York,
or when the SPY chain of Yahoo has no option trade in the last 45 minutes (the market is closed). When the
SPY chain of Yahoo cannot be read the run reads Cboe only. When the SPY chain of Cboe cannot be read the run
reads no fund: a missing chain file would not mean "no options" then.

A fund that fails is named in run.json with the reason, and the run goes on. The first rate limit of Yahoo
("Too Many Requests") ends all Yahoo requests of the run.

Time budget, from the start of the run: after 2100 seconds no new Cboe request starts (the funds that are left
are "failed" with the error "time-budget"), and after 2400 seconds no new Yahoo request starts (the funds
that are left stay "not-requested"). The run then ends with its record; the unit allows 3000 seconds.

--outside-session skips the clock check and the market check and writes `"outsideSession": true`. It is for a
test of the plumbing; the build never counts such a run.

Exit 0: a complete run, a skipped one, and an incomplete one: `complete` is false in run.json and
`incompleteReasons` says why (the market check was unreadable, the Cboe control failed, more than 20% of the
Cboe reads or of the Yahoo reads failed, Yahoo limited the requests, or a time budget ended). These causes
are outside the host, and a failed unit would get a retry that sends the same requests again. Exit 1: a fault
of the host or of the input: the universe file cannot be read or is refused, the store cannot be written, or
an error that the code did not expect (the last two end the run with a traceback). Exit 2: wrong arguments.
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import re
import shutil
import sys
import time as clock
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "research"))

from strategies.leveraged_etf import liquidity, spread_gate  # noqa: E402


def _load(name: str, path: Path):
    """A script of research/backtests, loaded from its file: the folders are no packages."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


universe = _load("leveraged_etf_universe_fetcher", Path(__file__).resolve().parent / "universe.py")
# in_session and last_trade of the option-chain collector: the same market check.
snapshot = _load("option_chain_snapshot", Path(__file__).resolve().parents[1] / "option-chain" / "snapshot.py")

SCHEMA = "leveraged-etf-spread-run-v1"
USER_AGENT = "Mozilla/5.0 (compatible; vertex-research-leveraged-etf-spreads/1; research, 3 runs per session)"
CONTROL = "SPY"  # has listed options on every day; also the probe of the market check
ATTEMPTS = 3  # Yahoo reads of one fund; the Cboe attempts are inside universe.http_get
RETRY_WAIT = 5  # seconds before the second Yahoo attempt; twice that before the third
MAX_FAILED_SHARE = 0.2  # of the Cboe reads, and of the Yahoo reads of the candidates
# Seconds from the start of the run. After the first no new Cboe request starts, after the second no new Yahoo
# request. The unit allows 3000 seconds: the run budget plus the last request and the writes.
CBOE_BUDGET_SECONDS = 2100
RUN_BUDGET_SECONDS = 2400
TIME_BUDGET = "time-budget"  # `cboe.error` of a fund that was not requested after the Cboe budget
RETENTION_DAYS = 45
MAX_UNIVERSE_AGE_DAYS = 30  # a warning, not a failure
# A rate limit of Yahoo: this text, the HTTP status as a whole number, or the error class of yfinance.
RATE_LIMIT_TEXT = "Too Many Requests"
RATE_LIMIT_CLASS = "YFRateLimitError"
_RATE_LIMIT_STATUS = re.compile(r"\b429\b")
# The error of yfinance for an expiry that Yahoo does not list, with a list of expiries that is not empty.
_EXPIRY_NOT_LISTED = re.compile(r"cannot be found\. Available expirations are: \[\s*[^\]\s]")
_SYMBOL = re.compile(r"[A-Z][A-Z0-9.]{0,9}")  # with fullmatch: a symbol is a file name in the store


def utc_text(stamp: datetime | None) -> str | None:
    return liquidity.utc_text(stamp) if stamp is not None else None


def write_json(path: Path, document: dict) -> None:
    """Writes `<name>.part` and renames it, so a killed run leaves no half file."""
    partial = path.with_name(path.name + ".part")
    partial.write_text(json.dumps(document, indent=1), encoding="utf-8")
    partial.replace(path)


def write_bytes(path: Path, body: bytes) -> None:
    partial = path.with_name(path.name + ".part")
    partial.write_bytes(body)
    partial.replace(path)


def read_universe(path: Path, session_day: date) -> tuple[dict, list[str]]:
    """(the `universe` object of run.json, the symbols with listed options in order) of a universe file.
    Raises ValueError, KeyError, TypeError or OSError when the file cannot be read."""
    document = json.loads(path.read_text(encoding="utf-8"))
    funds = document["funds"]
    symbols = [str(fund["symbol"]) for fund in funds]
    bad = [symbol for symbol in symbols if not _SYMBOL.fullmatch(symbol)]
    if bad or len(set(symbols)) != len(symbols):
        raise ValueError(f"the universe file has a symbol that cannot be stored or is there twice: {bad[:3]}")
    listed = sorted(str(fund["symbol"]) for fund in funds if fund["optionsListed"] is True)
    if len(listed) > liquidity.MAX_FUNDS:  # a bound on the requests of one run
        raise ValueError(f"the universe file has {len(listed)} funds with listed options, more than "
                         f"{liquidity.MAX_FUNDS}")
    generated_at = datetime.strptime(str(document["generatedAt"]), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    age = (session_day - generated_at.astimezone(liquidity.NEW_YORK).date()).days
    return {"path": str(path.resolve()), "generatedAt": utc_text(generated_at), "ageDays": age,
            "funds": len(funds), "fundsWithOptions": len(listed)}, listed


def rate_limited(error: BaseException) -> bool:
    text = str(error)
    return (RATE_LIMIT_TEXT in text or _RATE_LIMIT_STATUS.search(text) is not None
            or any(base.__name__ == RATE_LIMIT_CLASS for base in type(error).__mro__))


def empty_chain(chain) -> bool:
    """True when Yahoo sent no option row for the calls or for the puts: yfinance then gives None or a frame
    without rows. That is a failed read, not a market without quotes."""
    return chain.calls is None or chain.puts is None or len(chain.calls) == 0 or len(chain.puts) == 0


def error_text(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"[:300]


def market_check(ticker_for, expiry_text: str, now, sleep) -> tuple[str, datetime | None, bool]:
    """(state, latest option trade, rate limited) of the SPY chain of Yahoo at the session expiry. State
    "live": an option trade in the last 45 minutes. "closed": the chain was read and has no such trade.
    "unreadable": 3 attempts failed, or Yahoo limited the requests. An empty chain is a failed attempt."""
    for attempt in range(ATTEMPTS):
        try:
            chain = ticker_for(CONTROL).option_chain(expiry_text)
            if empty_chain(chain):
                raise RuntimeError(f"Yahoo sent an empty {CONTROL} chain for {expiry_text}")
            latest = snapshot.last_trade([chain.calls, chain.puts])
            break
        except Exception as error:  # noqa: BLE001 - yfinance raises many types on a throttled or empty reply
            if rate_limited(error):
                return "unreadable", None, True
            if attempt == ATTEMPTS - 1:
                return "unreadable", None, False
            sleep(RETRY_WAIT * (attempt + 1))
    if latest is None or now() - latest > timedelta(minutes=snapshot.MAX_TRADE_AGE_MIN):
        return "closed", latest, False
    return "live", latest, False


def scan_of_the_day(store: Path, session_day: date, listed: list[str]) -> tuple[str, list[str]] | None:
    """(run id, candidates) of the newest earlier run of the session day that read every fund; None without
    one. Such a run has a readable run.json of this schema, was made inside the session, has `cboeScope`
    "all", has ended, read the funds (a failed Cboe control reads none), and at most 20% of its Cboe reads
    failed. Only the candidates that are still funds with listed options of the universe file are returned."""
    day_folder = store / session_day.isoformat()
    if not day_folder.is_dir():
        return None
    for folder in sorted((folder for folder in day_folder.iterdir() if folder.is_dir()), reverse=True):
        try:
            record = json.loads((folder / "run.json").read_text(encoding="utf-8"))
            if (record["schema"] == SCHEMA and record["outsideSession"] is False and record["cboeScope"] == "all"
                    and record["finishedAt"] is not None and record["funds"]
                    and record["counts"]["cboeFailed"] <= MAX_FAILED_SHARE * len(record["funds"])):
                return f"{day_folder.name}/{folder.name}", sorted(set(record["candidates"]) & set(listed))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):  # this run cannot serve
            continue
    return None


def read_cboe(fetch_cboe, symbol: str, delay: float, now, sleep, past_budget=lambda: False) -> tuple:
    """(status, body, error text, fetch time) of the Cboe chain of one fund, after the wait of one worker.
    No request is sent when `past_budget()` is true before or after the wait: status "failed" with the
    error TIME_BUDGET and no fetch time."""
    if past_budget():
        return "failed", None, TIME_BUDGET, None
    sleep(delay)
    if past_budget():  # the wait is longer while the back-off of an HTTP 429 lasts
        return "failed", None, TIME_BUDGET, None
    try:
        body = fetch_cboe(universe.CHAIN_URL.format(symbol=symbol))
    except universe.NoFile:
        return "no-file", None, None, now()
    except Exception as error:  # noqa: BLE001 - one failed fund must not end the run
        return "failed", None, error_text(error), now()
    return "ok", body, None, now()


def cboe_fact(symbol: str, read: tuple, expiry: date, run_id: str) -> tuple[dict, bool]:
    """(the `cboe` object of a fund in run.json, the fund is a candidate) of one Cboe read."""
    status, body, error, fetched_at = read
    fact = {"status": status, "fetchedAt": utc_text(fetched_at), "fileTimestamp": None, "hasExpiry": None,
            "bandOpenInterest": None, "spot": None, "error": error}
    if status != "ok":
        return fact, False
    try:
        chain = json.loads(body)
        seen = spread_gate.cboe_observation(chain, symbol, expiry, run_id, fetched_at)
        fact["fileTimestamp"] = utc_text(liquidity.quote_time(chain))
    except (ValueError, KeyError, TypeError, AttributeError) as error:  # the chain cannot be read: a failure
        return {**fact, "status": "failed", "error": error_text(error)}, False
    if isinstance(seen, liquidity.NoOptions):
        return {**fact, "status": "no-standard-contract", "hasExpiry": False}, False
    band = seen.measure.band_open_interest if seen.has_expiry else None
    fact.update(hasExpiry=seen.has_expiry, bandOpenInterest=band, spot=seen.spot)
    return fact, band is not None and band >= spread_gate.GATE_V2["minBandOpenInterest"]


def store_cboe(out: Path, symbol: str, read: tuple, expiry: date, run_id: str) -> tuple[dict, bool]:
    """`cboe_fact` of one Cboe read; the body of a candidate is stored gzip-compressed."""
    fact, candidate = cboe_fact(symbol, read, expiry, run_id)
    if candidate:
        write_bytes(out / "cboe" / f"{symbol}.json.gz", gzip.compress(read[1], mtime=0))
    return fact, candidate


def records(frame) -> list[dict]:
    """The rows of a chain frame as dicts; works for a pandas DataFrame and for a small fake."""
    return list(frame.to_dict("records")) if frame is not None else []


def _number(value) -> float | None:
    """A float; None for null and for NaN."""
    if value is None or value != value:
        return None
    return float(value)


def _stamp(value) -> str | None:
    """A trade time of Yahoo as UTC text; None for null and for NaT. A time without a zone is UTC."""
    if value is None or value != value:
        return None
    value = value.to_pydatetime() if hasattr(value, "to_pydatetime") else value
    return utc_text(value if value.tzinfo else value.replace(tzinfo=timezone.utc))


def yahoo_snapshot(chain, expiry_text: str, fetched_at: datetime) -> dict:
    """The stored Yahoo file of one fund, from the object that yfinance returns for one expiry."""
    underlying = getattr(chain, "underlying", None) or {}
    price_time = _number(underlying.get("regularMarketTime"))
    rows = [{"strike": float(row["strike"]), "call": call, "bid": _number(row.get("bid")),
             "ask": _number(row.get("ask")), "lastTradeAt": _stamp(row.get("lastTradeDate"))}
            for call, frame in ((True, chain.calls), (False, chain.puts)) for row in records(frame)]
    return {"fetchedAt": utc_text(fetched_at), "expiry": expiry_text,
            "fundPrice": _number(underlying.get("regularMarketPrice")),
            "fundPriceTime": utc_text(datetime.fromtimestamp(price_time, timezone.utc)) if price_time is not None else None,
            "rows": rows}


def read_yahoo(ticker_for, symbol: str, expiry_text: str, run_id: str, now, sleep,
               past_budget=lambda: False) -> tuple:
    """(status, the snapshot or None, error text, fetch time, rate limited, out of time) of the Yahoo chain of
    one fund. Up to 3 attempts. A rate limit and an expiry that Yahoo does not list are not tried again. Any
    other error is a failed attempt, also another ValueError (a reply that is no JSON, an empty list of
    expiries) and an empty chain. No further attempt starts when `past_budget()` is true: the fund is
    "failed" with the last error, and "out of time" is true."""
    failure = None
    for attempt in range(ATTEMPTS):
        if attempt and past_budget():
            return "failed", None, failure, now(), False, True
        try:
            chain = ticker_for(symbol).option_chain(expiry_text)
            if empty_chain(chain):
                raise RuntimeError(f"Yahoo sent an empty chain for {expiry_text}")
            fetched_at = now()
            stored = yahoo_snapshot(chain, expiry_text, fetched_at)
            status = "ok" if spread_gate.yahoo_observation(stored, run_id) is not None else "no-quotes"
            return status, stored, None, fetched_at, False, False
        except Exception as error:  # noqa: BLE001 - yfinance raises many types on a throttled or empty reply
            failure = error_text(error)
            if rate_limited(error):
                return "failed", None, failure, now(), True, False
            if isinstance(error, ValueError) and _EXPIRY_NOT_LISTED.search(str(error)):
                return "no-expiry", None, failure, now(), False, False
            if attempt == ATTEMPTS - 1:
                return "failed", None, failure, now(), False, False
            sleep(RETRY_WAIT * (attempt + 1))
    raise AssertionError("unreachable")


def delete_old_days(store: Path, session_day: date, log=print) -> None:
    """Deletes the day folders of more than RETENTION_DAYS before `session_day`. Only folders whose name is a
    date as the collector writes it (YYYY-MM-DD) are touched."""
    for folder in sorted(store.iterdir()):
        try:
            day = date.fromisoformat(folder.name)
        except ValueError:
            continue
        if folder.name != day.isoformat():  # fromisoformat also reads "20260102"
            continue
        if folder.is_dir() and not folder.is_symlink() and (session_day - day).days > RETENTION_DAYS:
            shutil.rmtree(folder)
            log(f"deleted the runs of {folder.name}: more than {RETENTION_DAYS} days old")


def counts_of(funds: dict, yahoo_rate_limited: bool) -> dict:
    cboe = [fund["cboe"]["status"] for fund in funds.values()]
    yahoo = [fund["yahoo"]["status"] for fund in funds.values() if fund["candidate"]]
    return {"cboeOk": cboe.count("ok") + cboe.count("no-standard-contract"), "cboeNoFile": cboe.count("no-file"),
            "cboeFailed": cboe.count("failed"), "yahooOk": yahoo.count("ok"), "yahooNoExpiry": yahoo.count("no-expiry"),
            "yahooNoQuotes": yahoo.count("no-quotes"), "yahooFailed": yahoo.count("failed"),
            "yahooNotRequested": yahoo.count("not-requested"), "yahooRateLimited": yahoo_rate_limited}


def collect(fetch_cboe, ticker_for, now, sleep, store: Path, universe_path: Path, outside_session: bool = False,
            log=print, workers: int = 4, cboe_delay: float = 1.0, yahoo_delay: float = 1.0) -> int:
    """One run. `fetch_cboe(url)` returns the body of a chain file and raises universe.NoFile for a missing
    one; `ticker_for(symbol)` returns a yfinance-like ticker; `now()` is the UTC clock; `sleep(seconds)`
    waits. Returns the exit code: 0 for a run that is complete, incomplete or skipped, 1 when the universe file
    cannot be read. Raises OSError when the store cannot be written."""
    started = now()

    def past(seconds: float) -> bool:
        return (now() - started).total_seconds() > seconds

    local = started.astimezone(liquidity.NEW_YORK)
    session_day = local.date()
    close = liquidity.session_close(session_day)
    if not outside_session and not (
            snapshot.in_session(started) and close is not None and liquidity.SESSION_START <= local.time() < close):
        log(f"skipped: {local:%a %Y-%m-%d %H:%M} New York is outside {liquidity.SESSION_START:%H:%M} to the close "
            "of a NYSE session")
        return 0
    try:
        universe_fact, symbols = read_universe(universe_path, session_day)
    except (ValueError, KeyError, TypeError, OSError) as error:
        log(f"the universe file {universe_path} cannot be read: {error_text(error)}")
        return 1
    if universe_fact["ageDays"] > MAX_UNIVERSE_AGE_DAYS:
        log(f"warning: the universe file is {universe_fact['ageDays']} days old; renew it to find new funds")
    store.mkdir(parents=True, exist_ok=True)  # a store that cannot be made is a fault, before the first request
    scan = scan_of_the_day(store, session_day, symbols)
    scope, candidates_from = ("all", None) if scan is None else ("candidates", scan[0])
    if scan is not None:
        symbols = scan[1]
    expiry = spread_gate.session_expiry(session_day)
    expiry_text = expiry.isoformat()
    probe = {"symbol": CONTROL, "state": "skipped", "latestOptionTradeAt": None}
    reasons, yahoo_open, yahoo_limited = [], True, False
    if not outside_session:
        state, latest, yahoo_limited = market_check(ticker_for, expiry_text, now, sleep)
        if state == "closed":
            log(f"skipped: no {CONTROL} option trade in the last {snapshot.MAX_TRADE_AGE_MIN} minutes "
                f"(latest {utc_text(latest)}); the market is closed")
            return 0
        probe.update(state=state, latestOptionTradeAt=utc_text(latest))
        if state == "unreadable":
            yahoo_open = False
            reasons.append("market-check-unreadable")
            log(f"the {CONTROL} chain of Yahoo cannot be read: this run reads Cboe only")

    run_id = f"{session_day.isoformat()}/{started:%H%M%S}Z"
    out = store / session_day.isoformat() / f"{started:%H%M%S}Z"
    out.mkdir(parents=True, exist_ok=False)
    funds = {symbol: {"candidate": False,
                      "cboe": {"status": "failed", "fetchedAt": None, "fileTimestamp": None, "hasExpiry": None,
                               "bandOpenInterest": None, "spot": None, "error": "not-requested"},
                      "yahoo": {"status": "not-requested", "fetchedAt": None, "error": None}} for symbol in symbols}
    record = {"schema": SCHEMA, "runId": run_id, "sessionDay": session_day.isoformat(), "sessionExpiry": expiry_text,
              "startedAt": utc_text(started), "finishedAt": None, "outsideSession": outside_session,
              "cboeScope": scope, "candidatesFrom": candidates_from, "universe": universe_fact, "probe": probe,
              "candidates": [], "funds": {},
              "counts": counts_of({}, yahoo_limited), "complete": False, "incompleteReasons": []}

    def finish() -> int:
        if yahoo_limited:
            reasons.append("yahoo-rate-limited")
        record.update(finishedAt=utc_text(now()), counts=counts_of(record["funds"], yahoo_limited),
                      complete=not reasons, incompleteReasons=reasons)
        write_json(out / "run.json", record)
        delete_old_days(store, session_day, log)
        counted = record["counts"]
        log(f"run {run_id} (Cboe scope {scope}): {len(record['candidates'])} candidates of "
            f"{len(record['funds'])} funds, "
            f"Cboe failed {counted['cboeFailed']}, Yahoo ok {counted['yahooOk']}, failed {counted['yahooFailed']}; "
            + ("complete" if not reasons else "not complete: " + ", ".join(reasons)))
        return 0  # also for an incomplete run: its record says so

    write_json(out / "run.json", record)
    try:
        if not universe.has_options(fetch_cboe(universe.CHAIN_URL.format(symbol=CONTROL))):
            raise ValueError(f"the {CONTROL} chain of Cboe lists no option")
    except Exception as error:  # noqa: BLE001 - without the control a missing file does not mean "no options"
        reasons.append(f"cboe-control-failed: {error_text(error)}")
        return finish()

    record["funds"] = funds
    (out / "cboe").mkdir()
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        reads = deque(pool.submit(read_cboe, fetch_cboe, symbol, cboe_delay, now, sleep,
                                  lambda: past(CBOE_BUDGET_SECONDS)) for symbol in symbols)
        for symbol in symbols:
            # popleft: the body of a fund is dropped when the fund is handled, not kept until the run ends.
            funds[symbol]["cboe"], funds[symbol]["candidate"] = store_cboe(
                out, symbol, reads.popleft().result(), expiry, run_id)
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    candidates = [symbol for symbol in symbols if funds[symbol]["candidate"]]
    record["candidates"] = candidates
    record["counts"] = counts_of(funds, yahoo_limited)
    write_json(out / "run.json", record)
    if any(funds[symbol]["cboe"]["error"] == TIME_BUDGET for symbol in symbols):
        reasons.append("cboe-time-budget")
    if record["counts"]["cboeFailed"] > MAX_FAILED_SHARE * len(symbols):
        reasons.append("cboe-failed-above-20-percent")

    (out / "yahoo").mkdir()
    out_of_time = False
    for index, symbol in enumerate(candidates if yahoo_open else []):
        if yahoo_limited or out_of_time:
            break  # the funds that are left keep "not-requested"
        if index:
            sleep(yahoo_delay)
        if past(RUN_BUDGET_SECONDS):
            out_of_time = True
            break
        status, stored, error, fetched_at, yahoo_limited, out_of_time = read_yahoo(
            ticker_for, symbol, expiry_text, run_id, now, sleep, lambda: past(RUN_BUDGET_SECONDS))
        funds[symbol]["yahoo"] = {"status": status, "fetchedAt": utc_text(fetched_at), "error": error}
        if stored is not None:
            write_json(out / "yahoo" / f"{symbol}.json", stored)
    if out_of_time:
        reasons.append("yahoo-time-budget")
    if yahoo_open and counts_of(funds, yahoo_limited)["yahooFailed"] > MAX_FAILED_SHARE * len(candidates):
        reasons.append("yahoo-failed-above-20-percent")
    return finish()


def main(argv=None, fetch_cboe=None, ticker_for=None) -> int:
    parser = argparse.ArgumentParser(description="One spread run of the leveraged ETF option gate version 2.")
    parser.add_argument("--store", type=Path, required=True, help="folder of the run folders")
    parser.add_argument("--universe", type=Path, required=True, help="universe file (the document of universe.py)")
    parser.add_argument("--outside-session", action="store_true",
                        help="skip the clock check and the market check; the build never counts such a run")
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return 0 if stop.code == 0 else 2
    sleep = clock.sleep
    if fetch_cboe is None:
        pace = universe.Pace()
        sleep = pace.wait  # a worker also waits while the back-off of an HTTP 429 lasts
        fetch_cboe = lambda url: universe.http_get(url, pace, user_agent=USER_AGENT)  # noqa: E731
    if ticker_for is None:
        import yfinance  # here, so the module loads without it

        ticker_for = yfinance.Ticker
    return collect(fetch_cboe, ticker_for, lambda: datetime.now(timezone.utc), sleep, args.store, args.universe,
                   outside_session=args.outside_session)


if __name__ == "__main__":
    sys.exit(main())
