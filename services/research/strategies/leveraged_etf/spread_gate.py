"""Option gate version 2 of a leveraged fund: the rule (no network, no file access, no clock).

Version 1 (liquidity.py) reads one Cboe chain once and judges the nearest expiry 5 to 21 days out. Version 2
measures the expiry that the study trades, in several runs per session and from two sources:

  * An observation is the measure of one source (Cboe or Yahoo) for one fund in one run.
  * A counted read is an observation that counts for a session: its quotes are from the entry hours of the
    session, and it is not the same data as an earlier counted read (see counted_reads).
  * One source judges a session: Cboe with 2 or more counted reads, else Yahoo (see session_result).
  * A spread label needs 2 judged sessions (see fund_label).

Every time is an argument. The module imports the standard library and liquidity.py only, so the build step
runs with plain Python. Design: docs/specs/research/leveraged-etf-option-gate-v2.md.
"""
from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from . import liquidity

REASONS_V2 = ("no-listed-options", "no-standard-contract", "no-chain-in-store", "stale-chain", "no-window-expiry",
              "open-interest-below-minimum", "no-two-sided-quote", "too-few-two-sided-quotes",
              "spread-above-maximum", "fewer-than-2-judged-sessions")
# The numbers that version 1 also has are read from liquidity.py. "Cheap" (a median option price below 1 USD)
# and the cheap band (up to 8%, twice the limit) are reported and decide no label.
GATE_V2 = {
    "version": 2, "minExpirySessions": 3, "entryStart": "10:00", "entryEnd": "15:30",
    "halfDayEndBeforeCloseMinutes": 30,
    "cboeQuoteDelayMinutes": int(liquidity.QUOTE_DELAY.total_seconds() // 60),
    "yahooMarginMinutes": 15, "yahooMaxFundPriceAgeMinutes": 30,
    "bandPct": liquidity.GATE["bandPct"], "minBandOpenInterest": liquidity.GATE["minBandOpenInterest"],
    "spreadStrikes": liquidity.SPREAD_STRIKES, "minTwoSidedQuotes": liquidity.GATE["minTwoSidedQuotes"],
    "maxHalfSpreadPct": liquidity.GATE["maxHalfSpreadPct"], "cheapMaxMidUsd": 1, "cheapBandMaxHalfSpreadPct": 8,
    "minReadsPerSession": 2, "minSessions": 2, "sessionLookback": 5,
    "maxChainAgeDays": liquidity.MAX_CHAIN_AGE_DAYS,
}
ENTRY_START = time.fromisoformat(GATE_V2["entryStart"])  # New York
ENTRY_END = time.fromisoformat(GATE_V2["entryEnd"])
NEW_YORK = liquidity.NEW_YORK


@dataclass(frozen=True)
class CboeObservation:
    run_id: str
    fetched_at: datetime
    file_timestamp: datetime  # UTC, the time Cboe wrote the file; its quotes are 15 minutes older
    spot: float
    has_expiry: bool  # the chain lists the session expiry
    measure: liquidity.ExpiryMeasure | None  # None exactly when has_expiry is false


@dataclass(frozen=True)
class YahooObservation:
    run_id: str
    fetched_at: datetime
    fund_price_time: datetime | None
    spot: float | None
    # (strike, call, bid, ask) of the measured contracts: the identity of the observation.
    quotes: tuple[tuple[float, bool, float, float], ...]
    measure: liquidity.ExpiryMeasure  # its band_open_interest is 0 and is not used


@dataclass(frozen=True)
class Read:
    """A counted read."""
    run_id: str
    source: str  # "cboe" or "yahoo"
    fetched_at: datetime
    quote_time: datetime | None  # Cboe: the file timestamp minus 15 minutes; Yahoo gives no quote time
    two_sided_quotes: int
    half_spread_pct: float | None
    median_mid: float | None


@dataclass(frozen=True)
class SessionResult:
    day: date
    expiry: date
    source: str | None  # the session source; None when no source has a counted read
    reads: tuple[Read, ...]  # the counted reads of the session source
    value_pct: float | None
    limit_pct: float | None
    cheap: bool | None
    in_cheap_band: bool | None
    median_mid: float | None
    result: str  # inside-limit, not-judged, no-two-sided-quote, too-few-two-sided-quotes, spread-above-maximum
    other_source: str | None  # None when the other source has no counted read
    other_counted_reads: int
    other_value_pct: float | None


@dataclass(frozen=True)
class FundFacts:
    """The newest Cboe fact of a fund in the store."""
    file_timestamp: datetime
    fetched_at: datetime
    session_expiry: date  # of the run that read the chain
    has_expiry: bool
    band_open_interest: int | None  # None when the chain does not list the session expiry
    spot: float
    no_standard_contract: bool


def is_session(day: date) -> bool:
    return liquidity.session_close(day) is not None


def session_expiry(day: date) -> date:
    """The expiry that the study trades for an entry on `day`: the first Friday after `day` with at least 3
    sessions after `day` up to and including it; the last open day before a closed Friday.

    The rule of weekly_expiry(day, 3) in strategies/volspike/options.py, on the calendar of liquidity.py. That
    module needs pydantic and numpy at import; a test in the numeric CI lane compares the two rules."""
    probe = day + timedelta(days=1)
    while True:
        if probe.weekday() == 4:
            expiry = probe
            while not is_session(expiry):
                expiry -= timedelta(days=1)
            ahead = sum(1 for n in range(1, (expiry - day).days + 1) if is_session(day + timedelta(days=n)))
            if expiry > day and ahead >= GATE_V2["minExpirySessions"]:
                return expiry
        probe += timedelta(days=1)


def entry_hours(day: date) -> tuple[time, time] | None:
    """Start and end of the entry hours in New York on `day`; None on a day that is no session. On a half day
    the end is 30 minutes before the close."""
    close = liquidity.session_close(day)
    if close is None:
        return None
    if not liquidity.closes_early(day):
        return ENTRY_START, ENTRY_END
    before_close = datetime.combine(day, close) - timedelta(minutes=GATE_V2["halfDayEndBeforeCloseMinutes"])
    return ENTRY_START, before_close.time()


def sessions_back(day: date, count: int) -> list[date]:
    """The last `count` sessions up to and including `day`, newest first."""
    out = []
    while len(out) < count:
        if is_session(day):
            out.append(day)
        day -= timedelta(days=1)
    return out


def cboe_observation(chain: Mapping, symbol: str, expiry: date, run_id: str,
                     fetched_at: datetime) -> CboeObservation | liquidity.NoOptions:
    """The observation of one Cboe chain at `expiry`. NO_STANDARD_CONTRACT when no standard contract expires
    on or after the New York day of the file timestamp.

    Raises ValueError, KeyError or TypeError for a chain that cannot be read, as liquidity.measure does."""
    data = chain["data"]
    own = {chain.get("symbol"), data.get("symbol")} - {None}
    if own != {symbol}:
        raise ValueError(f"the chain is of {', '.join(sorted(map(str, own))) or 'no symbol'}, not of {symbol}")
    file_timestamp = liquidity.quote_time(chain)
    today = file_timestamp.astimezone(NEW_YORK).date()
    contracts = [contract for contract in liquidity.contracts_of(chain, symbol) if contract.expiry >= today]
    if not contracts:
        return liquidity.NO_STANDARD_CONTRACT
    spot = liquidity.spot_of(chain)
    has_expiry = any(contract.expiry == expiry for contract in contracts)
    return CboeObservation(
        run_id=run_id, fetched_at=fetched_at, file_timestamp=file_timestamp, spot=spot, has_expiry=has_expiry,
        measure=liquidity.expiry_measure(contracts, spot, expiry) if has_expiry else None)


def _utc(text) -> datetime | None:
    """"2026-11-16T15:47:02Z" as an aware datetime; None for null."""
    if text is None:
        return None
    return datetime.strptime(str(text), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _positive(value) -> float:
    """A bid, an ask or a price of a stored Yahoo file; 0.0 for null and for a value that is no number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return 0.0
    return float(value)


def yahoo_observation(snapshot: Mapping, run_id: str) -> YahooObservation | None:
    """The observation of one stored Yahoo file (`yahoo/<SYMBOL>.json` of a run). None when every row has a
    bid of 0 or null and an ask of 0 or null: Yahoo sends such rows when it has no quote data.

    The fund price of the measure is `fundPrice`. Without a fund price the nearest strikes are not known: the
    observation then has an empty measure, and counted_reads does not count it."""
    expiry = date.fromisoformat(str(snapshot["expiry"]))
    contracts = [liquidity.Contract(
        expiry=expiry, strike=float(row["strike"]), call=bool(row["call"]), bid=_positive(row.get("bid")),
        ask=_positive(row.get("ask")), open_interest=0) for row in snapshot["rows"]]
    if not any(contract.bid > 0 or contract.ask > 0 for contract in contracts):
        return None
    spot = _positive(snapshot.get("fundPrice"))
    fetched_at = _utc(snapshot["fetchedAt"])
    fund_price_time = _utc(snapshot.get("fundPriceTime"))
    if not spot > 0:
        return YahooObservation(run_id=run_id, fetched_at=fetched_at, fund_price_time=fund_price_time, spot=None,
                                quotes=(), measure=liquidity.ExpiryMeasure(0, 0, None, None))
    # The same strikes as liquidity.expiry_measure reads.
    strikes = sorted({contract.strike for contract in contracts}, key=lambda strike: (abs(strike - spot), strike))
    nearest = set(strikes[:liquidity.SPREAD_STRIKES])
    quotes = sorted((contract.strike, contract.call, contract.bid, contract.ask)
                    for contract in contracts if contract.strike in nearest)
    return YahooObservation(run_id=run_id, fetched_at=fetched_at, fund_price_time=fund_price_time, spot=spot,
                            quotes=tuple(quotes), measure=liquidity.expiry_measure(contracts, spot, expiry))


def _inside(stamp: datetime, session_day: date, start: time, end: time) -> bool:
    """True when `stamp` is on `session_day` in New York, from `start` to `end` (both included)."""
    local = stamp.astimezone(NEW_YORK)
    return local.date() == session_day and start <= local.time().replace(tzinfo=None) <= end


def counted_reads(session_day: date, cboe: Sequence[CboeObservation], yahoo: Sequence[YahooObservation],
                  seen_file_timestamps: frozenset[datetime]) -> tuple[list[Read], list[Read]]:
    """The counted Cboe reads and the counted Yahoo reads of one fund in one session, in time order.

    A Cboe observation counts when the time of its quotes (the file timestamp minus 15 minutes) is inside the
    entry hours of the session day and the file timestamp is new: it is not in `seen_file_timestamps` (the
    runs before this session) and no earlier run of the session had it.

    A Yahoo observation counts when its fetch time is at least 15 minutes after the start of the entry hours
    and not after their end, the fund price time is on the session day and at most 30 minutes before the fetch
    time, and its quotes differ from those of the last counted Yahoo observation of the session."""
    hours = entry_hours(session_day)
    if hours is None:
        return [], []
    start, end = hours
    cboe_reads, yahoo_reads = [], []
    seen = set(seen_file_timestamps)
    for item in sorted(cboe, key=lambda item: item.fetched_at):
        quoted_at = item.file_timestamp - liquidity.QUOTE_DELAY
        if item.measure is None or item.file_timestamp in seen or not _inside(quoted_at, session_day, start, end):
            continue
        seen.add(item.file_timestamp)
        cboe_reads.append(Read(
            run_id=item.run_id, source="cboe", fetched_at=item.fetched_at, quote_time=quoted_at,
            two_sided_quotes=item.measure.two_sided_quotes, half_spread_pct=item.measure.half_spread_pct,
            median_mid=item.measure.median_mid))
    margin = timedelta(minutes=GATE_V2["yahooMarginMinutes"])
    max_age = timedelta(minutes=GATE_V2["yahooMaxFundPriceAgeMinutes"])
    yahoo_start = (datetime.combine(session_day, start) + margin).time()
    last_quotes = None
    for item in sorted(yahoo, key=lambda item: item.fetched_at):
        if item.spot is None or item.fund_price_time is None or item.quotes == last_quotes:
            continue
        if not _inside(item.fetched_at, session_day, yahoo_start, end):
            continue
        if item.fund_price_time.astimezone(NEW_YORK).date() != session_day \
                or item.fetched_at - item.fund_price_time > max_age:
            continue
        last_quotes = item.quotes
        yahoo_reads.append(Read(
            run_id=item.run_id, source="yahoo", fetched_at=item.fetched_at, quote_time=None,
            two_sided_quotes=item.measure.two_sided_quotes, half_spread_pct=item.measure.half_spread_pct,
            median_mid=item.measure.median_mid))
    return cboe_reads, yahoo_reads


def quotable(reads: Sequence[Read]) -> list[Read]:
    """The reads with at least 3 two-sided quotes."""
    return [item for item in reads if item.two_sided_quotes >= GATE_V2["minTwoSidedQuotes"]]


def _value(reads: Sequence[Read]) -> float | None:
    """The median half spread of the quotable reads, rounded to 4 decimals; None without one."""
    spreads = [item.half_spread_pct for item in quotable(reads)]
    return round(statistics.median(spreads), 4) if spreads else None


# The table "Result of a session": the first condition that holds gives the result. Each condition gets the
# counted reads of the session source, the number of them that are quotable, and the value (None with fewer
# than 2 quotable reads).
_SESSION_RULES = (
    (lambda reads, usable, value: len(reads) < GATE_V2["minReadsPerSession"], "not-judged"),
    (lambda reads, usable, value: usable < GATE_V2["minReadsPerSession"]
     and not any(item.two_sided_quotes > 0 for item in reads), "no-two-sided-quote"),
    (lambda reads, usable, value: usable < GATE_V2["minReadsPerSession"], "too-few-two-sided-quotes"),
    (lambda reads, usable, value: value > GATE_V2["maxHalfSpreadPct"], "spread-above-maximum"),
    (lambda reads, usable, value: True, "inside-limit"),
)


def session_result(day: date, expiry: date, cboe_reads: Sequence[Read],
                   yahoo_reads: Sequence[Read]) -> SessionResult:
    """The result of one session of a fund. The session source is Cboe with 2 or more counted Cboe reads,
    else Yahoo; only its counted reads judge the session. The counted reads of the other source are reported
    with the median of their quotable reads. A value equal to the limit is inside the limit."""
    by_source = {"cboe": tuple(cboe_reads), "yahoo": tuple(yahoo_reads)}
    source = "cboe" if len(cboe_reads) >= GATE_V2["minReadsPerSession"] else "yahoo"
    other = "yahoo" if source == "cboe" else "cboe"
    reads, other_reads = by_source[source], by_source[other]
    usable = quotable(reads)
    enough = len(usable) >= GATE_V2["minReadsPerSession"]
    value = _value(reads) if enough else None
    median_mid = round(statistics.median(item.median_mid for item in usable), 4) if enough else None
    cheap = median_mid < GATE_V2["cheapMaxMidUsd"] if enough else None
    result = next(name for condition, name in _SESSION_RULES if condition(reads, len(usable), value))
    return SessionResult(
        day=day, expiry=expiry, source=source if reads or other_reads else None, reads=reads, value_pct=value,
        limit_pct=GATE_V2["maxHalfSpreadPct"] if result != "not-judged" else None, cheap=cheap,
        in_cheap_band=(cheap and GATE_V2["maxHalfSpreadPct"] < value <= GATE_V2["cheapBandMaxHalfSpreadPct"])
        if enough else None,
        median_mid=median_mid, result=result, other_source=other if other_reads else None,
        other_counted_reads=len(other_reads), other_value_pct=_value(other_reads))


def fund_label(listed: bool, universe_reasons: Sequence[str], facts: FundFacts | None,
               sessions: Sequence[SessionResult], build_day: date) -> tuple[str, list[str]]:
    """(label, reasons) of a fund on `build_day`.

    `listed` and `universe_reasons` are what the universe file says. `facts` is the newest Cboe fact of the
    fund in the store. `sessions` are the sessions of the fund, in any order; the 2 newest judged sessions
    among the last 5 NYSE sessions up to `build_day` decide the spread."""
    lookback = sessions_back(build_day, GATE_V2["sessionLookback"])
    if not listed:
        return "fail", list(universe_reasons) or ["no-listed-options"]
    if facts is None or facts.fetched_at.astimezone(NEW_YORK).date() not in lookback:
        return "spread-not-measured", ["no-chain-in-store"]
    if liquidity.chain_age_days(facts.file_timestamp, facts.fetched_at) > GATE_V2["maxChainAgeDays"]:
        return "fail", ["stale-chain"]  # Cboe has no current file of the fund
    if facts.no_standard_contract:
        return "fail", ["no-standard-contract"]
    if not facts.has_expiry:
        return "fail", ["no-window-expiry"]
    if facts.band_open_interest is None or facts.band_open_interest < GATE_V2["minBandOpenInterest"]:
        return "fail", ["open-interest-below-minimum"]
    judged = sorted((item for item in sessions if item.result != "not-judged" and item.day in lookback),
                    key=lambda item: item.day, reverse=True)[:GATE_V2["minSessions"]]
    if len(judged) < GATE_V2["minSessions"]:
        return "spread-not-measured", ["fewer-than-2-judged-sessions"]
    failed = {item.result for item in judged if item.result != "inside-limit"}
    reasons = [reason for reason in REASONS_V2 if reason in failed]
    return ("fail", reasons) if reasons else ("pass", [])
