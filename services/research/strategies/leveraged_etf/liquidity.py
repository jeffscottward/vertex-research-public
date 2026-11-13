"""Option liquidity of a leveraged fund: measure one Cboe delayed chain, apply the gate, build the universe
document (no network and no data file).

The chain is the JSON of https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json:
`timestamp` (UTC, the time Cboe wrote the file), `symbol`, `data.symbol`, `data.current_price` and
`data.options[]` with `option` (OCC symbol), `bid`, `ask`, `open_interest`.

The feed is delayed by 15 minutes: a file that Cboe wrote at 14:47:36 holds the market of 14:32:36. Evidence:
in the 723 chain files of the run of 2026-11-12 no trade of a fund or of an option is newer than the
timestamp minus 15.0 minutes, and the 5 smallest gaps between the newest trade in a file and its timestamp
are 15.0 to 15.4 minutes.

Only standard contracts count: the OCC root is the fund symbol. After a split Cboe also lists adjusted
contracts (root "SQQQ1"); they deliver a different number of shares, so their strike says nothing about the
distance to the spot price.

The gate answers one question for the 24 to 48 hour window: can a position of 2% of the account trade as
options on this fund. "pass" = yes. "fail" = no, with the reasons. "spread-not-measured" = the quotes of the
chain are not from the regular session of the day of the document; they are stale and wide then, so the
spread is not judged: the chain cannot pass and it does not prove a fail.
"""
from __future__ import annotations

import importlib.util
import re
import statistics
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .universe import ListedFund

SCHEMA = "leveraged-etf-universe-v1"
# 1000 contracts in the band keep a 2%-of-account order small against open interest. A 4% half spread is the
# widest cost class that the qc-ports option model charges (SLV, USO). The median of fewer than 3 quotes is
# one quote or the mean of two: too few to stand for the spread of the fund.
GATE = {"version": 1, "minWindowDays": 5, "maxWindowDays": 21, "bandPct": 10, "minBandOpenInterest": 1000,
        "maxHalfSpreadPct": 4, "minTwoSidedQuotes": 3}
NEAREST_EXPIRIES = 4
SPREAD_STRIKES = 4  # the half spread is read at the 4 strikes nearest to spot: at most 8 contracts
NEW_YORK = ZoneInfo("America/New_York")
QUOTE_DELAY = timedelta(minutes=15)  # the chain holds the market of this long before its timestamp
SESSION_START = time(9, 45)  # New York, 15 minutes after the open; as research/backtests/option-chain/snapshot.py
SESSION_CLOSE = time(16, 0)
EARLY_CLOSE = time(13, 0)
# New York calendar days from the chain to the document. The chain of the last session before a weekend with
# a holiday (Thursday, read on Monday) is 4 days old; an older chain is not the current chain of the fund.
MAX_CHAIN_AGE_DAYS = 4
MAX_CLOCK_SKEW = timedelta(minutes=5)  # a chain may be this much newer than the document (two clocks)
MAX_FUNDS = 2000
REASONS = ("no-listed-options", "no-standard-contract", "stale-chain", "no-window-expiry",
           "open-interest-below-minimum", "no-two-sided-quote", "too-few-two-sided-quotes", "spread-above-maximum",
           "market-closed-at-quote")

_OCC = re.compile(r"^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")


def _nyse_holiday_rule():
    """`is_nyse_holiday` of strategies/qc_ports/calendar.py, loaded from its file. `import strategies.qc_ports`
    also imports the study modules of that package, and they need pydantic. The universe fetcher imports this
    module and runs on the Python standard library alone."""
    path = Path(__file__).resolve().parent.parent / "qc_ports" / "calendar.py"
    spec = importlib.util.spec_from_file_location("leveraged_etf_nyse_calendar", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.is_nyse_holiday


is_nyse_holiday = _nyse_holiday_rule()


@dataclass(frozen=True)
class Contract:
    expiry: date
    strike: float
    call: bool
    bid: float
    ask: float
    open_interest: int


@dataclass(frozen=True)
class OptionsMeasure:
    quoted_at: datetime  # UTC, the chain timestamp: the time Cboe wrote the file
    spot: float
    nearest_expiries: tuple[str, ...]  # 1..4 ISO dates, ascending
    window_expiry: str | None
    total_open_interest: int
    band_open_interest: int | None  # None exactly when window_expiry is None
    half_spread_pct: float | None  # None exactly when there is no two-sided quote
    two_sided_quotes: int | None  # the quotes behind half_spread_pct; None exactly when window_expiry is None


@dataclass(frozen=True)
class NoOptions:
    """A fund without option facts, and the gate reason that says why."""
    reason: str


NOT_LISTED = NoOptions("no-listed-options")  # Cboe has no chain file for the fund
# The chain lists no standard contract that expires on or after the quote day.
NO_STANDARD_CONTRACT = NoOptions("no-standard-contract")


def _number(value) -> float:
    return float(value) if isinstance(value, (int, float)) and value == value else 0.0


def contracts_of(chain: Mapping, symbol: str) -> list[Contract]:
    """The standard contracts of the chain of `symbol` (OCC root = the symbol without the dot of a share class).
    Raises ValueError for a standard contract with a negative open interest: the chain cannot be read."""
    root = symbol.replace(".", "")
    out = []
    for row in chain["data"].get("options") or []:
        parsed = _OCC.match(str(row.get("option", "")))
        if not parsed or parsed.group(1) != root:
            continue
        open_interest = _number(row.get("open_interest"))
        if open_interest < 0:
            raise ValueError(f"the contract {row['option']} has a negative open interest")
        year, month, day = (int(parsed.group(index)) for index in (2, 3, 4))
        out.append(Contract(
            expiry=date(2000 + year, month, day), strike=int(parsed.group(6)) / 1000, call=parsed.group(5) == "C",
            bid=_number(row.get("bid")), ask=_number(row.get("ask")), open_interest=int(open_interest)))
    return out


def two_sided(contract: Contract) -> bool:
    return contract.bid > 0 and contract.ask > contract.bid


def half_spread_pct(contract: Contract) -> float:
    return 100 * (contract.ask - contract.bid) / 2 / ((contract.bid + contract.ask) / 2)


def quote_time(chain: Mapping) -> datetime:
    """The chain timestamp ("2026-11-12 01:05:00", UTC without a zone mark) as an aware datetime."""
    return datetime.strptime(str(chain["timestamp"]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def closes_early(day: date) -> bool:
    """NYSE closes at 13:00: 3 July and 24 December on Monday to Thursday, and the Friday after Thanksgiving.
    The rule of is_early_close in strategies/imom/data.py; that module cannot be imported here (see
    _nyse_holiday_rule), and a test compares the two."""
    if (day.month, day.day) in ((7, 3), (12, 24)):
        return day.weekday() <= 3
    return day.month == 11 and day.weekday() == 4 and 23 <= day.day <= 29


def session_close(day: date) -> time | None:
    """End of the regular session in New York on `day`; None on a weekend day and on a NYSE holiday.
    A closure that is not in the holiday rules and a trading halt are not known here."""
    if day.weekday() >= 5 or is_nyse_holiday(day):
        return None
    return EARLY_CLOSE if closes_early(day) else SESSION_CLOSE


def chain_age_days(quoted_at: datetime, generated_at: datetime) -> int:
    """New York calendar days from the chain to the document; 0 = the same New York day."""
    return (generated_at.astimezone(NEW_YORK).date() - quoted_at.astimezone(NEW_YORK).date()).days


def session_of(quoted_at: datetime, generated_at: datetime) -> str:
    """"regular" when the document can judge the quotes of the chain: the time they describe (the chain time
    minus QUOTE_DELAY) is inside the regular session of a NYSE trading day, from SESSION_START to the close in
    New York, and the chain is of the New York day of the document. Else "closed".

    The clock and the exchange calendar decide. The last trade of the fund does not: a fund that did not
    trade in the last minutes still has option quotes."""
    if chain_age_days(quoted_at, generated_at) != 0:
        return "closed"
    described = (quoted_at - QUOTE_DELAY).astimezone(NEW_YORK)
    close = session_close(described.date())
    return "regular" if close is not None and SESSION_START <= described.time() < close else "closed"


def measure(chain: Mapping, symbol: str, today: date | None = None) -> OptionsMeasure | NoOptions:
    """Liquidity of the chain of `symbol`. `today` is the quote day; None = the New York day of the chain
    timestamp. NO_STANDARD_CONTRACT when the chain lists no standard contract that expires on or after the
    quote day.

    Raises ValueError for a chain that cannot be measured: it is the chain of another symbol, or it has no
    timestamp or no positive price. That is a read failure; it is not "no options"."""
    data = chain["data"]
    own = {chain.get("symbol"), data.get("symbol")} - {None}
    if own != {symbol}:
        raise ValueError(f"the chain is of {', '.join(sorted(map(str, own))) or 'no symbol'}, not of {symbol}")
    quoted_at = quote_time(chain)
    today = today or quoted_at.astimezone(NEW_YORK).date()
    contracts = [contract for contract in contracts_of(chain, symbol) if contract.expiry >= today]
    if not contracts:
        return NO_STANDARD_CONTRACT
    spot = _number(data.get("current_price")) or _number(data.get("close"))  # no trade yet today: the last close
    if not spot > 0:
        raise ValueError("the chain has no positive price")
    expiries = sorted({contract.expiry for contract in contracts})
    window = next((expiry for expiry in expiries
                   if GATE["minWindowDays"] <= (expiry - today).days <= GATE["maxWindowDays"]), None)
    band = spread = quotes = None
    if window is not None:
        rows = [contract for contract in contracts if contract.expiry == window]
        band = sum(contract.open_interest for contract in rows
                   if abs(contract.strike / spot - 1) * 100 <= GATE["bandPct"] + 1e-9)
        strikes = sorted({contract.strike for contract in rows}, key=lambda strike: (abs(strike - spot), strike))
        nearest = set(strikes[:SPREAD_STRIKES])
        spreads = [half_spread_pct(contract) for contract in rows if contract.strike in nearest and two_sided(contract)]
        quotes = len(spreads)
        spread = round(statistics.median(spreads), 4) if spreads else None
    return OptionsMeasure(
        quoted_at=quoted_at, spot=spot,
        nearest_expiries=tuple(expiry.isoformat() for expiry in expiries[:NEAREST_EXPIRIES]),
        window_expiry=window.isoformat() if window is not None else None,
        total_open_interest=sum(contract.open_interest for contract in contracts),
        band_open_interest=band, half_spread_pct=spread, two_sided_quotes=quotes)


def gate(measured: OptionsMeasure | NoOptions, generated_at: datetime) -> tuple[str, list[str]]:
    """(label, reasons) of the option gate; a function of the measure, the document time and GATE.

    A chain of more than MAX_CHAIN_AGE_DAYS before the document is not judged at all: it is not the current
    chain of the fund. The spread is judged only in session "regular" (see session_of), and only on
    GATE["minTwoSidedQuotes"] or more two-sided quotes."""
    if isinstance(measured, NoOptions):
        return "fail", [measured.reason]
    if chain_age_days(measured.quoted_at, generated_at) > MAX_CHAIN_AGE_DAYS:
        return "fail", ["stale-chain"]
    session = session_of(measured.quoted_at, generated_at)
    reasons = []
    if measured.window_expiry is None:
        reasons.append("no-window-expiry")
    if measured.band_open_interest is not None and measured.band_open_interest < GATE["minBandOpenInterest"]:
        reasons.append("open-interest-below-minimum")
    if session == "regular":
        if not measured.two_sided_quotes:
            reasons.append("no-two-sided-quote")
        elif measured.two_sided_quotes < GATE["minTwoSidedQuotes"]:
            reasons.append("too-few-two-sided-quotes")
        elif measured.half_spread_pct > GATE["maxHalfSpreadPct"]:
            reasons.append("spread-above-maximum")
    if reasons:
        return "fail", reasons
    if session == "closed":
        return "spread-not-measured", ["market-closed-at-quote"]
    return "pass", []


def utc_text(stamp: datetime) -> str:
    if stamp.tzinfo is None:
        raise ValueError("a datetime without a time zone cannot be written as UTC")
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plain(number: float) -> int | float:
    return int(number) if float(number).is_integer() else float(number)


def check_fund(fund: ListedFund) -> None:
    """Raises ValueError when a value of the fund is outside the document contract. The fetcher calls this
    for every fund before it reads a chain, so a fund that the import would refuse costs no request."""
    if not _SYMBOL.match(fund.symbol):
        raise ValueError(f"symbol {fund.symbol!r} is outside the document contract")
    if not 1 <= len(fund.name) <= 200 or not 1 <= len(fund.listing_exchange) <= 20:
        raise ValueError(f"{fund.symbol}: name or listing exchange is outside the document contract")
    if fund.product_type not in ("etf", "etn"):
        raise ValueError(f"{fund.symbol}: product type {fund.product_type!r}")
    if fund.leverage in (0, 1) or not -5 <= fund.leverage <= 5:
        raise ValueError(f"{fund.symbol}: leverage {fund.leverage} is outside the document contract")


def fund_entry(fund: ListedFund, measured: OptionsMeasure | NoOptions, generated_at: datetime) -> dict:
    """One Fund object of the document. Raises ValueError when a value is outside the contract."""
    check_fund(fund)
    label, reasons = gate(measured, generated_at)
    options = None
    if isinstance(measured, OptionsMeasure):
        if measured.quoted_at - generated_at > MAX_CLOCK_SKEW:
            raise ValueError(f"{fund.symbol}: the chain time {utc_text(measured.quoted_at)} is after the document "
                             f"time {utc_text(generated_at)}")
        options = {
            "quotedAt": utc_text(measured.quoted_at),
            "session": session_of(measured.quoted_at, generated_at),
            "spot": measured.spot,
            "nearestExpiries": list(measured.nearest_expiries),
            "windowExpiry": measured.window_expiry,
            "totalOpenInterest": measured.total_open_interest,
            "bandOpenInterest": measured.band_open_interest,
            "halfSpreadPct": measured.half_spread_pct,
            "twoSidedQuotes": measured.two_sided_quotes,
        }
    return {
        "symbol": fund.symbol,
        "name": fund.name,
        "productType": fund.product_type,
        "leverage": _plain(fund.leverage),
        "underlying": fund.underlying,
        "listingExchange": fund.listing_exchange,
        "optionsListed": options is not None,
        "options": options,
        "optionGate": label,
        "optionGateReasons": reasons,
    }


def document(funds: Iterable[tuple[ListedFund, OptionsMeasure | NoOptions]], generated_at: datetime) -> dict:
    """The universe document (schema leveraged-etf-universe-v1): funds sorted by symbol, symbols unique.
    `generated_at` is the time after the last chain was read; the document holds it in whole seconds, and
    every fund is judged at that time. Raises ValueError for no fund, more than MAX_FUNDS funds, a symbol
    that is listed twice or a chain that is newer than the document."""
    stamp = utc_text(generated_at)
    generated_at = generated_at.replace(microsecond=0)  # the time that a reader of the document sees
    entries = sorted((fund_entry(fund, measured, generated_at) for fund, measured in funds),
                     key=lambda entry: entry["symbol"])
    symbols = [entry["symbol"] for entry in entries]
    if not 1 <= len(entries) <= MAX_FUNDS:
        raise ValueError(f"the document holds 1 to {MAX_FUNDS} funds, not {len(entries)}")
    if len(set(symbols)) != len(symbols):
        twice = sorted({symbol for symbol in symbols if symbols.count(symbol) > 1})
        raise ValueError(f"symbols listed twice: {', '.join(twice)}")
    return {"schema": SCHEMA, "generatedAt": stamp, "gate": dict(GATE), "funds": entries}
