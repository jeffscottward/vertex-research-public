"""Option liquidity of a leveraged fund: measure one Cboe delayed chain, apply the gate, build the universe
document (pure, no I/O).

The chain is the JSON of https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json:
`timestamp` (UTC, the time Cboe wrote the file), `data.current_price`, `data.last_trade_time` (New York time,
the last trade of the fund) and `data.options[]` with `option` (OCC symbol), `bid`, `ask`, `open_interest`.

Only standard contracts count: the OCC root is the fund symbol. After a split Cboe also lists adjusted
contracts (root "SQQQ1"); they deliver a different number of shares, so their strike says nothing about the
distance to the spot price.

The gate answers one question for the 24 to 48 hour window: can a position of 2% of the account trade as
options on this fund. "pass" = yes. "fail" = no, with the reasons. "spread-not-measured" = the chain was read
while the option market was closed; the quotes are stale and wide then, so the spread is not judged: the
chain cannot pass and it does not prove a fail.
"""
from __future__ import annotations

import re
import statistics
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .universe import ListedFund

SCHEMA = "leveraged-etf-universe-v1"
# 1000 contracts in the band keep a 2%-of-account order small against open interest. A 4% half spread is the
# widest cost class that the qc-ports option model charges (SLV, USO).
GATE = {"version": 1, "minWindowDays": 5, "maxWindowDays": 21, "bandPct": 10, "minBandOpenInterest": 1000,
        "maxHalfSpreadPct": 4}
NEAREST_EXPIRIES = 4
SPREAD_STRIKES = 4  # the half spread is read at the 4 strikes nearest to spot
NEW_YORK = ZoneInfo("America/New_York")
SESSION = (time(9, 45), time(16, 0))  # New York; as research/backtests/option-chain/snapshot.py
MAX_TRADE_AGE_MIN = 20  # an older last trade of the fund means a holiday, a half day or a halt
MAX_FUNDS = 2000
REASONS = ("no-listed-options", "no-window-expiry", "open-interest-below-minimum", "no-two-sided-quote",
           "spread-above-maximum", "market-closed-at-quote")

_OCC = re.compile(r"^([A-Z0-9]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$")
_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")


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
    quoted_at: datetime  # UTC
    session: str  # "regular" or "closed"
    spot: float
    nearest_expiries: tuple[str, ...]  # 1..4 ISO dates, ascending
    window_expiry: str | None
    total_open_interest: int
    band_open_interest: int | None  # None exactly when window_expiry is None
    half_spread_pct: float | None


def _number(value) -> float:
    return float(value) if isinstance(value, (int, float)) and value == value else 0.0


def contracts_of(chain: Mapping) -> list[Contract]:
    """The standard contracts of a chain (OCC root = the chain symbol without the dot of a share class)."""
    data = chain["data"]
    root = str(data.get("symbol") or chain.get("symbol") or "").replace(".", "")
    out = []
    for row in data.get("options") or []:
        parsed = _OCC.match(str(row.get("option", "")))
        if not parsed or parsed.group(1) != root:
            continue
        year, month, day = (int(parsed.group(index)) for index in (2, 3, 4))
        out.append(Contract(
            expiry=date(2000 + year, month, day), strike=int(parsed.group(6)) / 1000, call=parsed.group(5) == "C",
            bid=_number(row.get("bid")), ask=_number(row.get("ask")),
            open_interest=int(_number(row.get("open_interest")))))
    return out


def two_sided(contract: Contract) -> bool:
    return contract.bid > 0 and contract.ask > contract.bid


def half_spread_pct(contract: Contract) -> float:
    return 100 * (contract.ask - contract.bid) / 2 / ((contract.bid + contract.ask) / 2)


def quote_time(chain: Mapping) -> datetime:
    """The chain timestamp ("2026-11-12 01:05:00", UTC without a zone mark) as an aware datetime."""
    return datetime.strptime(str(chain["timestamp"]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def last_trade_time(chain: Mapping) -> datetime | None:
    """Last trade of the fund. Cboe writes it in New York time without a zone mark."""
    text = chain["data"].get("last_trade_time")
    if not text:
        return None
    stamp = datetime.fromisoformat(str(text))
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=NEW_YORK)


def session_of(quoted_at: datetime, last_trade: datetime | None) -> str:
    """"regular" when the chain was written while the US option market traded: a weekday inside SESSION in
    New York, and a trade of the fund in the MAX_TRADE_AGE_MIN minutes before the chain time. Else "closed"."""
    local = quoted_at.astimezone(NEW_YORK)
    if local.weekday() >= 5 or not SESSION[0] <= local.time() < SESSION[1]:
        return "closed"
    if last_trade is None or quoted_at - last_trade > timedelta(minutes=MAX_TRADE_AGE_MIN):
        return "closed"
    return "regular"


def measure(chain: Mapping, today: date | None = None) -> OptionsMeasure | None:
    """Liquidity of one chain. `today` is the quote day; None = the New York day of the chain timestamp.
    None when the chain lists no standard contract that expires on or after the quote day. A chain without
    a timestamp or a positive price raises ValueError: it cannot be measured, and that is not "no options"."""
    quoted_at = quote_time(chain)
    today = today or quoted_at.astimezone(NEW_YORK).date()
    contracts = [contract for contract in contracts_of(chain) if contract.expiry >= today]
    if not contracts:
        return None
    data = chain["data"]
    spot = _number(data.get("current_price")) or _number(data.get("close"))  # no trade yet today: the last close
    if not spot > 0:
        raise ValueError("the chain has no positive price")
    expiries = sorted({contract.expiry for contract in contracts})
    window = next((expiry for expiry in expiries
                   if GATE["minWindowDays"] <= (expiry - today).days <= GATE["maxWindowDays"]), None)
    band = spread = None
    if window is not None:
        rows = [contract for contract in contracts if contract.expiry == window]
        band = sum(contract.open_interest for contract in rows
                   if abs(contract.strike / spot - 1) * 100 <= GATE["bandPct"] + 1e-9)
        strikes = sorted({contract.strike for contract in rows}, key=lambda strike: (abs(strike - spot), strike))
        nearest = set(strikes[:SPREAD_STRIKES])
        spreads = [half_spread_pct(contract) for contract in rows if contract.strike in nearest and two_sided(contract)]
        spread = round(statistics.median(spreads), 4) if spreads else None
    return OptionsMeasure(
        quoted_at=quoted_at, session=session_of(quoted_at, last_trade_time(chain)), spot=spot,
        nearest_expiries=tuple(expiry.isoformat() for expiry in expiries[:NEAREST_EXPIRIES]),
        window_expiry=window.isoformat() if window is not None else None,
        total_open_interest=sum(contract.open_interest for contract in contracts),
        band_open_interest=band, half_spread_pct=spread)


def gate(measured: OptionsMeasure | None) -> tuple[str, list[str]]:
    """(label, reasons) of the option gate; a pure function of the measure and GATE."""
    if measured is None:
        return "fail", ["no-listed-options"]
    reasons = []
    if measured.window_expiry is None:
        reasons.append("no-window-expiry")
    if measured.band_open_interest is not None and measured.band_open_interest < GATE["minBandOpenInterest"]:
        reasons.append("open-interest-below-minimum")
    if measured.session == "regular":
        if measured.half_spread_pct is None:
            reasons.append("no-two-sided-quote")
        elif measured.half_spread_pct > GATE["maxHalfSpreadPct"]:
            reasons.append("spread-above-maximum")
    if reasons:
        return "fail", reasons
    if measured.session == "closed":
        return "spread-not-measured", ["market-closed-at-quote"]
    return "pass", []


def utc_text(stamp: datetime) -> str:
    if stamp.tzinfo is None:
        raise ValueError("a datetime without a time zone cannot be written as UTC")
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plain(number: float) -> int | float:
    return int(number) if float(number).is_integer() else float(number)


def fund_entry(fund: ListedFund, measured: OptionsMeasure | None) -> dict:
    """One Fund object of the document. Raises ValueError when a value is outside the contract."""
    if not _SYMBOL.match(fund.symbol):
        raise ValueError(f"symbol {fund.symbol!r} is outside the document contract")
    if not 1 <= len(fund.name) <= 200 or not 1 <= len(fund.listing_exchange) <= 20:
        raise ValueError(f"{fund.symbol}: name or listing exchange is outside the document contract")
    if fund.product_type not in ("etf", "etn"):
        raise ValueError(f"{fund.symbol}: product type {fund.product_type!r}")
    if fund.leverage in (0, 1) or not -5 <= fund.leverage <= 5:
        raise ValueError(f"{fund.symbol}: leverage {fund.leverage} is outside the document contract")
    label, reasons = gate(measured)
    options = None if measured is None else {
        "quotedAt": utc_text(measured.quoted_at),
        "session": measured.session,
        "spot": measured.spot,
        "nearestExpiries": list(measured.nearest_expiries),
        "windowExpiry": measured.window_expiry,
        "totalOpenInterest": measured.total_open_interest,
        "bandOpenInterest": measured.band_open_interest,
        "halfSpreadPct": measured.half_spread_pct,
    }
    return {
        "symbol": fund.symbol,
        "name": fund.name,
        "productType": fund.product_type,
        "leverage": _plain(fund.leverage),
        "underlying": fund.underlying,
        "listingExchange": fund.listing_exchange,
        "optionsListed": measured is not None,
        "options": options,
        "optionGate": label,
        "optionGateReasons": reasons,
    }


def document(funds: Iterable[tuple[ListedFund, OptionsMeasure | None]], generated_at: datetime) -> dict:
    """The universe document (schema leveraged-etf-universe-v1): funds sorted by symbol, symbols unique.
    Raises ValueError for no fund, more than MAX_FUNDS funds or a symbol that is listed twice."""
    entries = sorted((fund_entry(fund, measured) for fund, measured in funds), key=lambda entry: entry["symbol"])
    symbols = [entry["symbol"] for entry in entries]
    if not 1 <= len(entries) <= MAX_FUNDS:
        raise ValueError(f"the document holds 1 to {MAX_FUNDS} funds, not {len(entries)}")
    if len(set(symbols)) != len(symbols):
        twice = sorted({symbol for symbol in symbols if symbols.count(symbol) > 1})
        raise ValueError(f"symbols listed twice: {', '.join(twice)}")
    return {"schema": SCHEMA, "generatedAt": utc_text(generated_at), "gate": dict(GATE), "funds": entries}
