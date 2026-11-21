"""Yahoo option chains: the second source of cboe-option-iv while the Cboe path is blocked.

One helper call per symbol (`helper:yahoo:options_chain:<symbol>`): the pinned yfinance client
(the same pin as infra/option-chain/vertex-option-chain-run) reads the quote, every listed
expiration and every contract, and returns a plain JSON payload. The conversion to Contract rows
mirrors options_math.parse_contracts: the Yahoo IV column with a sentinel floor, greeks computed
here (Black-Scholes-Merton, options_math.bsm_delta_gamma), open interest and volume as sent.
Research only: public quotes, no account, no secret, no order.
"""

from __future__ import annotations

import time
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import options_math
from .values import count, num

NEW_YORK = ZoneInfo("America/New_York")
# Yahoo sends IV ~1e-5 as a placeholder (measured 2026-11-21: 12% of the Core 7 contracts). Below
# this floor the IV is treated as missing (the contract stays for OI/volume, greeks stay None).
IV_FLOOR = 0.01
# Pause between expiration requests (courtesy spacing; the full snapshot stays far inside the
# job deadline, see the fallback gate in jobs/cboe.py).
REQUEST_SPACING_S = 0.1
# The quote fields the conversion reads (the payload keeps only these).
QUOTE_FIELDS = ("regularMarketPrice", "regularMarketTime", "trailingAnnualDividendYield")
# The contract fields the conversion reads (yfinance frames carry more; the payload keeps only these).
CONTRACT_FIELDS = ("contractSymbol", "strike", "impliedVolatility", "openInterest", "volume")


def fetch_symbol(symbol: str) -> dict[str, Any]:
    """One symbol's full chain as a plain JSON payload (runs inside ctx.up.helper).

    `t.option_chain()` without a date returns the quote, fills the expiration map and gives the
    first expiration's chain in ONE request; each remaining expiration costs one more request
    (the public `.options` property would discard the first chain and cost one request more).
    An expiration with an empty chain is left out of `chains` (the conversion counts the gap).
    """
    import yfinance as yf

    ticker = yf.Ticker(symbol)
    first = ticker.option_chain()
    expirations = sorted(ticker._expirations)
    quote = {key: (first.underlying or {}).get(key) for key in QUOTE_FIELDS}
    chains: dict[str, dict[str, list[dict[str, Any]]]] = {}

    def rows(frame: Any) -> list[dict[str, Any]]:
        if frame is None:
            return []
        return [
            {key: record.get(key) for key in CONTRACT_FIELDS}
            for record in frame[list(CONTRACT_FIELDS)].to_dict("records")
        ]

    # An empty first chain does not stop the symbol: later expirations can still have contracts.
    # The first expiration is only "already fetched" when its chain came with the list request.
    first_loaded = expirations and not (first.calls is None and first.puts is None)
    if first_loaded:
        chains[expirations[0]] = {"calls": rows(first.calls), "puts": rows(first.puts)}
    for expiration in expirations if not first_loaded else expirations[1:]:
        time.sleep(REQUEST_SPACING_S)
        chain = ticker.option_chain(expiration)
        if chain.calls is None and chain.puts is None:
            continue
        chains[expiration] = {"calls": rows(chain.calls), "puts": rows(chain.puts)}
    if not chains:
        raise ValueError("no option chain returned")
    return {"quote": quote, "expirations": expirations, "chains": chains}


def quote_day(payload: dict[str, Any], today: date) -> date:
    """The New York session date of the quote (`regularMarketTime`, epoch seconds), capped at today.

    A missing or unparseable time raises ValueError: the caller fails the symbol instead of
    silently stamping the run date (a Saturday run must stamp Friday's session).
    """
    ts = num((payload.get("quote") or {}).get("regularMarketTime"))
    if ts is None or ts <= 0:
        raise ValueError("no quote time (regularMarketTime)")
    day = datetime.fromtimestamp(ts, NEW_YORK).date()
    return day if day <= today else today


def contracts_of(payload: dict[str, Any], as_of: date) -> tuple[float, list[options_math.Contract], int, int]:
    """(spot, contracts expiring on/after as_of, rows skipped, expirations without a chain).

    The IV floor drops sentinel values to None (the contract stays for OI/volume, greeks stay
    None), as parse_contracts keeps Cboe rows without a usable IV. Spot must be positive.
    """
    quote = payload.get("quote") or {}
    spot = num(quote.get("regularMarketPrice"))
    if spot is None or spot <= 0:
        raise ValueError("no underlying price")
    dividend = num(quote.get("trailingAnnualDividendYield")) or 0.0
    chains = payload.get("chains") or {}
    listed = payload.get("expirations") or []
    missing = sum(1 for expiration in listed if expiration not in chains)
    contracts: list[options_math.Contract] = []
    skipped = 0
    for expiration, sides in sorted(chains.items()):
        try:
            expiry = date.fromisoformat(expiration)
        except ValueError:
            skipped += len(sides.get("calls") or []) + len(sides.get("puts") or [])
            continue
        if expiry < as_of:
            continue
        years = (expiry - as_of).days / 365
        for is_call, side in ((True, "calls"), (False, "puts")):
            for row in sides.get(side) or []:
                match = options_math.OCC.fullmatch(str(row.get("contractSymbol") or ""))
                if not match:
                    skipped += 1
                    continue
                iv = num(row.get("impliedVolatility"))
                iv = iv if iv is not None and iv >= IV_FLOOR else None
                strike = num(row.get("strike"))
                if strike is None or strike <= 0:
                    skipped += 1
                    continue
                delta, gamma = (
                    options_math.bsm_delta_gamma(spot, strike, years, iv, options_math.RISK_FREE_RATE, dividend, is_call)
                    if iv is not None
                    else (None, None)
                )
                contracts.append(
                    options_math.Contract(
                        expiration=expiry,
                        strike=strike,
                        is_call=is_call,
                        iv=iv,
                        delta=delta,
                        gamma=gamma,
                        open_interest=count(row.get("openInterest")) or 0,
                        volume=count(row.get("volume")) or 0,
                    )
                )
    return spot, contracts, skipped, missing