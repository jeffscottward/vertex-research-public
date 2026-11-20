"""Command line: `python -I -m vertex_openbb <job> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--symbols A,B] [--filers CIK,CIK]`.

stdout: one `openbb-batch.v1` JSON document. stderr: errors and progress. Exit codes: 0 ok (warnings
allowed) or blocked upstream (every source failed because its host refused the request, for example
HTTP 403: the document has empty tables and `blocked` names the host and the HTTP status), 2 bad
arguments or configuration, 3 every upstream source of the job failed for another reason, 1 internal
error. `--warm` imports everything the jobs use and prints `warm: ok <openbb-core version>`.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import traceback
from collections.abc import Awaitable, Callable, Mapping
from datetime import date, datetime, timedelta
from typing import Any, TextIO
from zoneinfo import ZoneInfo

from . import rows as row_rules
from . import sec_guard
from .context import STOCKS, UNIVERSE_ENV, ArgumentError, Context, all_blocked, all_failed, parse_list
from .jobs import cboe, cftc, congress, fed, finra, sec, series, treasury
from .upstream import Upstream

SCHEMA_VERSION = "openbb-batch.v1"
EXIT_OK, EXIT_INTERNAL, EXIT_ARGS, EXIT_UPSTREAM = 0, 1, 2, 3
DEADLINE_ENV = "OPENBB_DEADLINE_S"
DEFAULT_DEADLINE_S = 240.0
NEW_YORK = ZoneInfo("America/New_York")

Job = Callable[[Context], Awaitable[dict[str, list[dict[str, Any]]]]]
JOBS: dict[str, Job] = {
    "cboe-vol-indices": cboe.vol_indices,
    "cboe-vx-curve": cboe.vx_curve,
    "cboe-option-iv": cboe.option_iv,
    "cftc-cot": cftc.cot,
    "fed-rates": fed.rates,
    "fed-regime": fed.regime,
    "fed-events": fed.events,
    "treasury-tga": treasury.tga,
    "oecd-cli": series.oecd_cli,
    "fred-keyless": series.fred_keyless,
    "finra-otc": finra.otc,
    "finra-short-interest": finra.short_interest,
    "finra-short-volume": finra.short_volume,
    "sec-filings": sec.filings,
    "sec-insider": sec.insider,
    "sec-ftd": sec.ftd,
    "sec-13f": sec.form_13f,
    "famafrench": series.famafrench,
    "congress-house": congress.house,
    "congress-senate": congress.senate,
}
# Tables each job prints (always present, possibly empty).
JOB_TABLES: dict[str, tuple[str, ...]] = {
    "cboe-vol-indices": ("daily_series",),
    "cboe-vx-curve": ("vx_curve",),
    "cboe-option-iv": ("option_iv_daily", "option_iv_term"),
    "cftc-cot": ("cot_positions",),
    "fed-rates": ("macro_points",),
    "fed-regime": ("macro_points",),
    "fed-events": ("event_calendar",),
    "treasury-tga": ("macro_points", "event_calendar"),
    "oecd-cli": ("macro_points",),
    "fred-keyless": ("macro_points",),
    "finra-otc": ("finra_otc_weekly",),
    "finra-short-interest": ("short_interest",),
    "finra-short-volume": ("short_volume_daily",),
    "sec-filings": ("sec_filings",),
    "sec-insider": ("sec_insider_trades",),
    "sec-ftd": ("sec_ftd", "cusip_symbols"),
    "sec-13f": ("sec_13f_holdings", "sec_13f_filings"),
    "famafrench": ("factor_returns",),
    # Trades first: the tick stores tables in this order, so trades exist before the ledger counts them.
    "congress-house": ("congress_trades", "congress_filings"),
    "congress-senate": ("congress_trades", "congress_filings"),
}
# Every OpenBB provider fetcher a job calls (checked by --warm).
FETCHERS_USED = (
    ("cboe", "IndexHistorical"), ("cboe", "FuturesCurve"),
    ("cftc", "CftcCot"),
    ("federal_reserve", "FederalFundsRate"), ("federal_reserve", "SOFR"),
    ("federal_reserve", "OvernightBankFundingRate"), ("federal_reserve", "TreasuryRates"),
    ("federal_reserve", "FederalReserveKansasCityFinancialStress"),
    ("federal_reserve", "FederalReserveNewYorkNowcast"), ("federal_reserve", "FederalReserveNewYorkSupplyChain"),
    ("federal_reserve", "FederalReserveNewYorkCorporateDistress"),
    ("federal_reserve", "FederalReserveClevelandInflationNowcast"), ("federal_reserve", "CentralBankHoldings"),
    ("federal_reserve", "FomcDocuments"),
    ("us_treasury", "DailyTreasuryStatement"),
    ("oecd", "CompositeLeadingIndicator"),
    ("finra", "OTCAggregate"), ("finra", "EquityShortInterest"),
    ("sec", "Filings"), ("sec", "CompanyFilings"), ("sec", "InsiderTrading"),
)
PROVIDER_MODULES = (
    "openbb_core.provider.utils.helpers",
    "openbb_cboe.models.options_chains",
    "openbb_cboe.models.index_historical",
    "openbb_cboe.models.futures_curve",
    "openbb_cftc",
    "openbb_famafrench.utils.helpers",
    "openbb_federal_reserve",
    "openbb_federal_reserve.utils.ddp",
    "openbb_federal_reserve.utils.fomc_calendar",
    "openbb_finra",
    "openbb_oecd",
    "openbb_sec",
    "openbb_sec.utils.form4",
    "openbb_sec.utils.helpers",
    "openbb_sec.utils.parse_13f",
    "openbb_sec.models.form_13FHR",
    "openbb_government_us.treasury",
    "pdfplumber",
    "requests",
    "aiohttp",
)


def openbb_version() -> str | None:
    try:
        from importlib.metadata import version

        return version("openbb-core")
    except Exception:  # noqa: BLE001 - metadata missing: version unknown
        return None


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -I -m vertex_openbb",
        description="Fetch public OpenBB data for one Vertex ingest job and print one openbb-batch.v1 JSON document.",
    )
    p.add_argument("job", nargs="?", choices=sorted(JOBS), help="job to run")
    p.add_argument("--since", help="first date (YYYY-MM-DD); default is job specific")
    p.add_argument("--until", help="last date (YYYY-MM-DD) for jobs with a date window; default today")
    p.add_argument("--symbols", help="comma-separated symbols (default: job universe; OPENBB_STOCK_UNIVERSE replaces the stock list)")
    p.add_argument("--filers", help="comma-separated 13F filer CIKs (sec-13f only)")
    p.add_argument("--skip-accessions", help="comma-separated 13F accession numbers already stored (sec-13f only; the tick passes them)")
    p.add_argument("--warm", action="store_true", help="import every module the jobs use, print 'warm: ok <version>' and exit")
    return p


def new_york_today(now: datetime | None = None) -> date:
    return (now or datetime.now(NEW_YORK)).astimezone(NEW_YORK).date()


def _symbols(text: str, source: str) -> tuple[str, ...]:
    values = [v.upper() for v in parse_list(text)]
    bad = [v for v in values if not row_rules.SYMBOL.fullmatch(v)]
    if bad:
        raise ArgumentError(f"{source}: not a symbol: {', '.join(bad[:5])}")
    if not values:
        raise ArgumentError(f"{source} is empty")
    return tuple(dict.fromkeys(values))


# Jobs that send the contact address in their User-Agent (exit 2 without it; scrubbed from output).
CONTACT_JOBS = ("sec-", "congress-")
# Jobs that read `--until`, with their default window in days (the start when --since is absent).
UNTIL_JOBS = {"congress-house": congress.DEFAULT_DAYS, "congress-senate": congress.DEFAULT_DAYS}
SYMBOL_JOBS = {
    "cboe-vol-indices", "cboe-option-iv", "cftc-cot", "finra-otc", "finra-short-interest",
    "finra-short-volume", "sec-filings", "sec-insider", "sec-ftd", "sec-13f",
}


def _day(text: str | None, flag: str, today: date) -> date | None:
    """A YYYY-MM-DD flag value that is not after today (None when the flag is absent)."""
    if text is None:
        return None
    try:
        day = date.fromisoformat(text) if len(text) == 10 else None
    except ValueError:
        day = None
    if day is None:
        raise ArgumentError(f"{flag} must be YYYY-MM-DD, not {text!r}")
    if day > today:
        raise ArgumentError(f"{flag} {text} is after today ({today.isoformat()}, America/New_York)")
    return day


def build_context(args: argparse.Namespace, env: Mapping[str, str], up: Upstream, today: date) -> Context:
    since = _day(args.since, "--since", today)
    until = _day(args.until, "--until", today)
    if until is not None:
        if args.job not in UNTIL_JOBS:
            raise ArgumentError(f"{args.job} takes no --until")
        start = since or (today - timedelta(days=UNTIL_JOBS[args.job]))
        if start > until:
            given = f"--since {args.since}" if since else f"the default start {start.isoformat()}"
            raise ArgumentError(f"{given} is after --until {args.until}")
    symbols = None
    if args.symbols is not None:
        if args.job not in SYMBOL_JOBS:
            raise ArgumentError(f"{args.job} takes no --symbols")
        symbols = _symbols(args.symbols, "--symbols")
    filers = None
    if args.filers is not None:
        if args.job != "sec-13f":
            raise ArgumentError("--filers is only for sec-13f")
        filers = sec.validate_filers(parse_list(args.filers))
    skip = None
    if args.skip_accessions is not None:
        if args.job != "sec-13f":
            raise ArgumentError("--skip-accessions is only for sec-13f")
        skip = sec.validate_accessions(parse_list(args.skip_accessions))
    stocks = STOCKS
    if (env.get(UNIVERSE_ENV) or "").strip():
        stocks = _symbols(env[UNIVERSE_ENV], UNIVERSE_ENV)
    return Context(job=args.job, today=today, up=up, since=since, until=until, symbols=symbols, filers=filers, env=env, stocks=stocks,
                   skip_accessions=skip or frozenset())


def warm(out: TextIO) -> int:
    import importlib

    for name in PROVIDER_MODULES:
        importlib.import_module(name)
    import aiohttp
    import requests

    from .upstream import provider_fetcher

    for provider, model in FETCHERS_USED:
        provider_fetcher(provider, model)
    # sec_guard wraps these private entry points; fail the install if a dependency moved them.
    if not callable(getattr(aiohttp.ClientSession, "_request", None)):
        raise RuntimeError("aiohttp.ClientSession._request is missing; sec_guard cannot set the SEC User-Agent")
    if not callable(getattr(requests.Session, "send", None)):
        raise RuntimeError("requests.Session.send is missing; sec_guard cannot set the SEC User-Agent")
    out.write(f"warm: ok {openbb_version() or 'unknown'}\n")
    return EXIT_OK


def document(ctx: Context, tables: dict[str, list[dict[str, Any]]], version: str | None) -> dict[str, Any]:
    out_tables = []
    for table in JOB_TABLES[ctx.job]:
        kept, problems = row_rules.validate_rows(table, tables.get(table, []))
        if problems:
            ctx.warn(f"{table}: dropped {len(problems)} rows that fail the row schema (first: {problems[0]})")
        out_tables.append({"table": table, "rows": kept})
    if not any(t["rows"] for t in out_tables) and not ctx.nothing_new:
        ctx.warn(f"{ctx.job}: every table is empty")
    doc: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "job": ctx.job,
        "openbbVersion": version,
        "tables": out_tables,
        "warnings": ctx.capped_warnings(),
    }
    if all_blocked(ctx):
        # Every source was refused by its host: the tables are empty and the first host is reported.
        host, status = ctx.blocked[0]
        doc["blocked"] = {"host": host, "httpStatus": status}
    return doc


def run(
    argv: list[str],
    *,
    env: Mapping[str, str] | None = None,
    up: Upstream | None = None,
    today: date | None = None,
    now: datetime | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Run one job; returns the exit code. Tests pass a ReplayUpstream and a fixed `today`."""
    env = os.environ if env is None else env
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    try:
        args = parser().parse_args(argv)
    except SystemExit as exc:  # argparse already printed the usage error on stderr
        return EXIT_OK if exc.code == 0 else EXIT_ARGS
    if args.warm:
        if args.job or args.since or args.until or args.symbols or args.filers or args.skip_accessions is not None:
            stderr.write("vertex_openbb: --warm takes no job or options\n")
            return EXIT_ARGS
        try:
            with contextlib.redirect_stdout(stderr):
                return warm(stdout)
        except Exception as exc:  # noqa: BLE001
            stderr.write(f"vertex_openbb: warm failed: {type(exc).__name__}: {exc}\n")
            return EXIT_INTERNAL
    if not args.job:
        stderr.write("vertex_openbb: a job is required (see --help)\n")
        return EXIT_ARGS

    scrub: tuple[str, ...] = ()
    try:
        if args.job.startswith(CONTACT_JOBS):
            agent = sec_guard.user_agent(env)
            scrub = (env.get(sec_guard.CONTACT_ENV, "").strip(),)
        upstream = up or Upstream(scrub=scrub)
        ctx = build_context(args, env, upstream, today or new_york_today())
        ctx.now = now
    except (ArgumentError, sec_guard.ContactError) as exc:
        stderr.write(f"vertex_openbb: {exc}\n")
        return EXIT_ARGS
    if args.job.startswith("sec-") and up is None:
        sec_guard.install(agent)

    try:
        deadline = _deadline(env)
    except ArgumentError as exc:
        stderr.write(f"vertex_openbb: {exc}\n")
        return EXIT_ARGS

    async def job() -> tuple[dict[str, list[dict[str, Any]]], bool]:
        try:
            return await asyncio.wait_for(JOBS[args.job](ctx), deadline), False
        except TimeoutError:
            return dict(ctx.tables), True

    try:
        with contextlib.redirect_stdout(stderr):  # OpenBB helpers print; keep stdout for the document
            tables, timed_out = asyncio.run(job())
    except ArgumentError as exc:
        stderr.write(f"vertex_openbb: {exc}\n")
        return EXIT_ARGS
    except Exception as exc:  # noqa: BLE001 - report, never print a partial document
        message = traceback.format_exc()
        for secret in scrub:
            if secret:
                message = message.replace(secret, "<redacted>")
        stderr.write(f"vertex_openbb: {args.job} failed: {type(exc).__name__}\n{message}")
        return EXIT_INTERNAL

    if timed_out:
        ctx.warn(f"job deadline of {deadline:g} s ({DEADLINE_ENV}) reached; the document holds only the rows fetched before it")
        if ctx.sources_ok == 0:
            stderr.write(f"vertex_openbb: {args.job}: deadline reached before any source was fetched\n")
            return EXIT_UPSTREAM
    if all_failed(ctx) and not all_blocked(ctx):
        for warning in ctx.warnings:
            stderr.write(f"vertex_openbb: {warning}\n")
        stderr.write(f"vertex_openbb: {args.job}: every upstream source failed\n")
        return EXIT_UPSTREAM

    doc = document(ctx, tables, openbb_version())
    # ASCII escapes: a lone surrogate from an upstream string can never break the stdout encoding.
    text = json.dumps(doc, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    # Check the unescaped form too: ensure_ascii turns a non-ASCII contact into \u escapes.
    plain = json.dumps(doc, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    for secret in scrub:
        if secret and (secret in text or secret in plain):
            stderr.write("vertex_openbb: refusing to print a document that contains the contact address\n")
            return EXIT_INTERNAL
    stdout.write(text + "\n")
    stdout.flush()
    counts = ", ".join(f"{t['table']}={len(t['rows'])}" for t in doc["tables"])
    if "blocked" in doc:
        counts += f"; blocked upstream: HTTP {doc['blocked']['httpStatus']} from {doc['blocked']['host']}"
    stderr.write(f"vertex_openbb: {args.job}: {counts}; {len(doc['warnings'])} warnings\n")
    return EXIT_OK


def _deadline(env: Mapping[str, str]) -> float:
    text = (env.get(DEADLINE_ENV) or "").strip()
    if not text:
        return DEFAULT_DEADLINE_S
    try:
        value = float(text)
    except ValueError:
        value = 0.0
    if not 0 < value <= 86400:
        raise ArgumentError(f"{DEADLINE_ENV} must be seconds between 0 and 86400, not {text!r}")
    return value


def main() -> None:
    sys.exit(run(sys.argv[1:]))

