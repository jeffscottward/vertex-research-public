"""Draft candidates of an allocation plan for one trading day (research only).

No order code, no broker, no network. `generate` reads the qc-ports data set and the option-chain
snapshot store and returns one document in the shape of GoLiveCollectInputSchema
(packages/api/src/contracts/golive-drafts.ts). scripts/golive/collect.ts posts it to
goLiveDrafts.collect, which stores records and sends nothing.

The signal is the backtested signal. Each sleeve of the plan names a study run (ideas.family) and a
definition variant. Its trades come from allocation.owner_rule_trades on the data set and from
allocation.combine with the plan's caps, as model_run of research/backtests/allocation/funded_pie.py
computes them. Nothing here evaluates an entry rule itself.

Timing (book.py `_price_event`: the entry bar is the signal bar + 1; portfolio.leg_trades passes
the signal bar): a signal read at the close of one trading day is entered at the close of the next
trading day. A model entry dated D rests on the close of the trading day before D and is placed at
the close of D. Its draft is shown on D, from data that ends the trading day before D. `generate`
refuses any other data end.

Pending days: the book prices an entry only when the data holds the entry bar and one bar after it
(book.py: "no bar to enter and exit"), and a month end is known only from the first bar of the next
month (portfolio.month_end_indices). Data that ends the day before D holds neither. So the trades
are computed on the data plus two pending bars per ETF, D and the trading day after it, each a
repeat of the ETF's last close (`with_pending_days`). The signal of an entry dated D is read on
real bars only, and its expiry depends on the date D alone. Its strikes come from the last real
close and implied volatility: the tested entry sets them at the close of D, so they are
provisional and the candidate says so in its facts.

Candidates:
- signal_today: a model trade entered on the trading day;
- model_holds_account_does_not: a model trade entered before the trading day and open after the
  last data day (the `openToday` list of funded_pie.py). An entry made on the last data day counts:
  funded_pie.py cannot price it, because its data has no bar after that entry.
A model trade whose expiry is on or before the trading day is no candidate, on either basis: a
spread that expires today is not an entry anyone can take, and GoLiveCollectInputSchema refuses
the whole batch for one such expiry. It is left out and the other candidates stay.

Data gaps: a sleeve reads more than its bars. Its gates and signal inputs read series
(signals.strategy_series_refs), and the options book reads the implied-volatility index of each
symbol (strike width) and the rate (portfolio.market_of). The signal code carries a missing value
forward for some days or drops the entry, without a word: a gap would look like "no signal today".
So `check_series` refuses the run unless every such series has a value dated the last data day
itself (`required_series` lists them per sleeve). An older day matters as much: the model account
is one path from its start, and a hole on any day of it can move a strike or remove a spread. So
`check_history` refuses the run when a series a sleeve reads, the bars of an ETF it trades or the
calendar's bars lack a value on an older day that the data the plan was tested on has a value for
(the holes of that data are pinned in golive/tested_gaps.py; `python -m golive.pin --out` writes it).

Chain snapshots: a candidate names listed strikes. Each model strike moves to the nearest listed
strike of the OLDEST snapshot that holds the chain of the symbol, expiry and side and is not older
than the freshness rule (MAX_AGE_TRADING_DAYS); the quote comes from the NEWEST such snapshot. A
stored snapshot does not change, so every run of a trading day names the same strikes: they are
part of the draft id on the server. A candidate without such a chain, or with a model strike outside
its listed strikes, refuses the run (NoChainError), as does a store or a chain file that cannot be
read (ChainStoreError). The one exception is a rule on dates: an expiry that no snapshot the run may
read can hold (snapshot.py DTE_RANGE) keeps the model strikes, has no quote, and its facts say so
(`price_candidate`).

Output rules: `check_document` refuses a document with a candidate whose strikes are not the right
way round for its structure, whose expiry is not after the trading day, that holds a number that is
not finite, or whose quote does not carry the delayed-snapshot label.

A refusal is a GoLiveError: no document. Zero candidates in a returned document means every check
passed and the model wants nothing.
"""
from __future__ import annotations

import bisect
import copy
import csv
import functools
import importlib.util
import json
import math
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from nautilus_backtest import signals as sig
from strategies.qc_ports import allocation as al
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.book import STRUCTURES, PricedTrade, parse_options
from strategies.qc_ports.calendar import TradingCalendar
from strategies.qc_ports.data import IV_INDEX, Bars

from .tested_gaps import TESTED_GAPS

__all__ = [
    "BUILDERS", "FACT_MAX_CHARS", "FACTS_MAX", "HOLES_SHOWN", "LONG_STRIKE_IS_LOWER", "MAX_AGE_TRADING_DAYS",
    "MODEL_HOLDS", "PIE_SCRIPT", "QUOTE_SOURCE", "RATE_SERIES", "SIGNAL_TODAY", "SNAPSHOT_SCRIPT", "TESTED_GAPS",
    "ChainStoreError", "Gaps", "GoLiveError", "NoChainError", "NotTradingDayError", "Snapshot", "StaleDataError",
    "UnsafeOutputError",
    "bars_name", "build_definition", "chain_quotes", "check_candidate", "check_document", "check_history",
    "check_series", "check_sleeve", "checked_plan", "data_gaps", "filter_facts", "funded_pie", "generate",
    "has_chains", "history_readers", "last_data_day", "model_trades", "pending_days", "price_candidate",
    "required_series", "signal_facts", "snapshots", "stored_dte_range", "strike_input_facts", "with_pending_days",
]

SIGNAL_TODAY = "signal_today"
MODEL_HOLDS = "model_holds_account_does_not"
# The chain snapshots are Yahoo quotes, up to 15 minutes late when fetched. Never a live quote.
QUOTE_SOURCE = "yahoo_delayed_snapshot"
# Freshness rule, one rule for the bars, the series and the chain snapshots: nothing is used that is
# older than the trading day this many trading days before the run's trading day (1: the trading
# day before it). The bars and every series a sleeve reads must have a value dated that day
# (last_data_day, check_series). A chain snapshot must be fetched on that day or later (New York
# date); an older one gives no quote and no listed strike (price_candidate).
MAX_AGE_TRADING_DAYS = 1
NEW_YORK = ZoneInfo("America/New_York")
# The rate series the options book reads (portfolio.market_of).
RATE_SERIES = "IRX"
# structure -> True when the long strike is the lower one. A bull vertical (call debit, put credit)
# buys the lower strike and sells the higher one; a bear vertical (put debit, call credit) buys the
# higher one. The same table as goLiveStrikesFitStructure of the contract.
LONG_STRIKE_IS_LOWER: Mapping[str, bool] = {"callDebitVertical": True, "putCreditVertical": True,
                                            "putDebitVertical": False, "callCreditVertical": False}
# Limits of GoLiveDraftCandidateSchema.signalFacts.
FACTS_MAX = 20
FACT_MAX_CHARS = 200
PIE_SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "allocation" / "funded_pie.py"
# The option-chain snapshot script: its DTE_RANGE says which expiries the chain store keeps (stored_dte_range).
SNAPSHOT_SCRIPT = PIE_SCRIPT.parents[1] / "option-chain" / "snapshot.py"
LIMIT_FIELDS = ("maxPositions", "nameRiskCapPct", "openRiskCapPct", "positionRiskPct")
SLEEVE_FIELDS = ("key", "runKey", "definitionVariant", "budgetPct", "structure", "symbols", "dteTarget", "dteMin",
                 "anchorDelta", "widthSigma")
TIMING_FACT = "Timing: a signal at one close is traded at the close of the next trading day (the tested entry time)."
# Expressions with a name of their own in the facts.
EXPRESSION_LABELS = ((qi.MOMENTUM, "12-1 momentum"),)


class GoLiveError(Exception):
    """The generator gives no document; the message says why (exit code 1)."""


class StaleDataError(GoLiveError):
    """The bars or a series a sleeve reads have no value of the trading day before the requested trading day."""


class ChainStoreError(GoLiveError):
    """The option-chain snapshot store, or one of its files, cannot be read."""


class NoChainError(GoLiveError):
    """A candidate has no listed strikes to name (price_candidate)."""


class UnsafeOutputError(GoLiveError):
    """A candidate breaks an output rule (check_document)."""


class NotTradingDayError(GoLiveError):
    """The requested day is not an NYSE trading day (exit code 3: nothing to collect)."""


# --------------------------------------------------------------------------- plan and definitions

def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def checked_plan(plan: object) -> Mapping:
    """The plan document (GoLivePlanSchema) when it has the fields the generator reads."""
    if not isinstance(plan, Mapping):
        raise GoLiveError("The plan must be a JSON object")
    if not (isinstance(plan.get("id"), str) and plan["id"]):
        raise GoLiveError("The plan needs an id")
    version = plan.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise GoLiveError("The plan needs a version (a positive integer)")
    limits = plan.get("limits")
    if not isinstance(limits, Mapping) or not all(_is_number(limits.get(field)) and limits[field] > 0
                                                  for field in LIMIT_FIELDS):
        raise GoLiveError(f"The plan limits need a positive {', '.join(LIMIT_FIELDS)}")
    if not isinstance(limits["maxPositions"], int):
        raise GoLiveError("The plan limit maxPositions must be an integer")
    sleeves = plan.get("sleeves")
    if not isinstance(sleeves, list) or not sleeves:
        raise GoLiveError("The plan needs at least one sleeve")
    for sleeve in sleeves:
        if not isinstance(sleeve, Mapping) or any(field not in sleeve for field in SLEEVE_FIELDS):
            raise GoLiveError(f"Every sleeve needs {', '.join(SLEEVE_FIELDS)}")
        symbols = sleeve["symbols"]
        if not isinstance(sleeve["key"], str) or not isinstance(symbols, list) or not all(
                isinstance(symbol, str) for symbol in symbols) or not _is_number(sleeve["budgetPct"]):
            raise GoLiveError("Every sleeve needs a text key, a list of symbols and a budgetPct number")
    keys = [sleeve["key"] for sleeve in sleeves]
    if len(set(keys)) != len(keys):
        raise GoLiveError("Sleeve keys must be unique")
    return plan


@functools.cache
def funded_pie():
    """research/backtests/allocation/funded_pie.py as a module, loaded on first use.

    It is a script outside the package: when loaded it puts two directories on sys.path and imports
    its neighbours `run` and `sensitivity` under those bare names. Both effects are undone here, so
    a long process (pytest) keeps its sys.path and never meets this `run` under that name.
    """
    path, loaded = list(sys.path), set(sys.modules)
    spec = importlib.util.spec_from_file_location("golive_funded_pie", PIE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = path
        for name in set(sys.modules) - loaded:
            if Path(getattr(sys.modules[name], "__file__", None) or "").parent == PIE_SCRIPT.parent:
                del sys.modules[name]
    return module


@functools.cache
def stored_dte_range() -> tuple[int, int]:
    """(fewest, most) calendar days to expiry of the chains a snapshot run stores: DTE_RANGE of
    research/backtests/option-chain/snapshot.py, read from that script itself (it imports the standard
    library only, and nothing is fetched on import)."""
    spec = importlib.util.spec_from_file_location("golive_chain_snapshot", SNAPSHOT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    low, high = module.DTE_RANGE
    if not (isinstance(low, int) and isinstance(high, int) and 0 <= low <= high):
        raise GoLiveError(f"DTE_RANGE of {SNAPSHOT_SCRIPT} is not a range of days: {module.DTE_RANGE!r}")
    return low, high


def _as_studied(run_key: str, runs: Mapping[str, qi.RunSpec], facts: qi.Facts) -> tuple[dict, str]:
    """The study definition unchanged, from the start of its study run."""
    run = runs[run_key]
    return copy.deepcopy(dict(run.definition)), run.start


def _pie_sleeve(studied: str) -> Callable[[str, Mapping[str, qi.RunSpec], qi.Facts], tuple[dict, str]]:
    """The builder of a changed definition: the sleeve funded_pie.sleeve_definitions makes of `studied`."""
    def build(run_key: str, runs: Mapping[str, qi.RunSpec], facts: qi.Facts) -> tuple[dict, str]:
        if run_key != studied:
            raise GoLiveError(f"this variant is tested (funded_pie.sleeve_definitions) for {studied} only, not {run_key}")
        return funded_pie().sleeve_definitions(runs, facts)[studied]

    return build


# definitionVariant -> builder of (definition, start). One builder per value of
# GOLIVE_DEFINITION_VARIANT_VALUES; a value without a builder is refused.
BUILDERS: Mapping[str, Callable[[str, Mapping[str, qi.RunSpec], qi.Facts], tuple[dict, str]]] = {
    "as_studied": _as_studied,
    "always_on_entry": _pie_sleeve("oil-predicts-equity/B"),
    "top_1": _pie_sleeve("momentum-rotation/A"),
}


def build_definition(sleeve: Mapping, runs: Mapping[str, qi.RunSpec], facts: qi.Facts) -> tuple[dict, str]:
    """(definition, start) of one plan sleeve. An unknown variant or run key is an error."""
    key, run_key, variant = sleeve["key"], sleeve["runKey"], sleeve["definitionVariant"]
    builder = BUILDERS.get(variant) if isinstance(variant, str) else None
    if builder is None:
        raise GoLiveError(f"Sleeve {key}: unknown definitionVariant {variant!r} (known: {', '.join(BUILDERS)})")
    if run_key not in runs:
        raise GoLiveError(f"Sleeve {key}: run key {run_key!r} is not a run of ideas.family")
    try:
        return builder(run_key, runs, facts)
    except GoLiveError as error:
        raise GoLiveError(f"Sleeve {key}: {error}") from None


def check_sleeve(sleeve: Mapping, definition: Mapping) -> None:
    """Refuses a sleeve whose stated terms differ from the definition that was tested.

    The candidates always come from the tested definition. A plan record that states another
    structure, symbol list, DTE, anchor delta or width would describe trades that were not tested.
    """
    block = definition.get("portfolio") or {}
    if block.get("legs"):
        raise GoLiveError(f"Sleeve {sleeve['key']}: the definition has more than one leg; a sleeve states one structure")
    spec = parse_options(definition["options"])
    tested = {"structure": spec.structure, "symbols": sorted(block.get("symbols", ())), "dteTarget": spec.dte_target,
              "dteMin": spec.dte_min, "anchorDelta": spec.long_delta if spec.kind == "debit" else spec.short_delta,
              "widthSigma": spec.width_sigma}
    stated = {**{field: sleeve[field] for field in tested}, "symbols": sorted(sleeve["symbols"])}
    differing = [f"{field} {stated[field]!r} (tested: {tested[field]!r})" for field in tested
                 if stated[field] != tested[field]]
    if differing:
        raise GoLiveError(f"Sleeve {sleeve['key']} does not state its tested definition: {'; '.join(differing)}")


# --------------------------------------------------------------------------- days and data

def last_data_day(calendar_days: Sequence[str], trading_day: str) -> str:
    """The last data day, when it is the trading day before `trading_day`; an error otherwise.

    Trading days are the bar dates and, after the last bar, the NYSE rules (calendar.TradingCalendar).
    """
    try:
        day = date.fromisoformat(trading_day)
    except (TypeError, ValueError):
        raise GoLiveError(f"The trading day must be YYYY-MM-DD, not {trading_day!r}") from None
    calendar = TradingCalendar(calendar_days)
    last = calendar.last.isoformat()
    if not calendar.is_trading_day(day):
        raise NotTradingDayError(f"{trading_day} is not an NYSE trading day")
    oldest = day
    for _step in range(MAX_AGE_TRADING_DAYS):
        oldest = calendar.previous_trading_day(oldest)
    needed = oldest.isoformat()
    if last < needed:
        raise StaleDataError(f"The data ends on {last}. Trading day {trading_day} needs data through {needed}: "
                             "no signal is drawn from older data.")
    if last > needed:
        raise StaleDataError(f"The data ends on {last}, at or after trading day {trading_day}. A draft for that day "
                             f"needs data that ends on {needed}.")
    return last


def required_series(definition: Mapping) -> dict[str, list[str]]:
    """Series id -> what the sleeve of `definition` reads it for, in the order of first use.

    Gates and signal inputs: signals.strategy_series_refs, the list the signal code itself gives of
    the series a definition reads (filters, entry and exit conditions, selection score), resolved for
    each symbol of the sleeve. Strike width and rate: portfolio.market_of gives the options book the
    implied-volatility index of the symbol and the rate. An ETF close read as a series (SPY of the
    volatility-regime gate, `<ETF>:TR`) is in the list like any other series.
    """
    refs = sig.strategy_series_refs(definition)
    gates = set(sig.strategy_series_refs({"filters": definition.get("filters") or []}))
    out: dict[str, list[str]] = {}

    def need(series_id: str, use: str) -> None:
        uses = out.setdefault(series_id, [])
        if use not in uses:
            uses.append(use)

    for symbol in dict.fromkeys(leg.symbol for leg in pf.run_legs(definition)):
        for ref in refs:
            series_id = sig.resolve_series(ref, symbol)
            if series_id is not None:
                use = "gate" if ref in gates else "signal input"
                need(series_id, f"{use} of {symbol}" if ref in sig.RELATIVE_TABLES else use)
        need(IV_INDEX[symbol], f"strike-width volatility of {symbol}")
        need(RATE_SERIES, "rate")
    return out


def check_series(sleeves: Sequence[Mapping], made: Mapping[str, tuple[Mapping, str]], data: pf.Dataset,
                 last_day: str, trading_day: str) -> None:
    """Refuses the run unless every series a sleeve reads has a value dated `last_day` itself.

    A value carried forward from an earlier day does not count. Without this check a gap is silent:
    the book carries an implied-volatility index and the rate for up to MAX_FILL_DAYS (data.align)
    and then gives "no IV", "no rate" or a "stale-iv" exit, and a gate without a value of the signal
    day fails. Each of them removes candidates, and the document would say the model wants nothing.
    The message has one line per series: the series, its last date, the date needed and its readers.
    """
    readers: dict[str, list[str]] = {}
    for sleeve in sleeves:
        for series_id, uses in required_series(made[sleeve["key"]][0]).items():
            readers.setdefault(series_id, []).append(f"{sleeve['key']} ({', '.join(uses)})")
    lines = []
    for series_id, read_by in readers.items():
        values = data.series.get(series_id) or {}
        if _is_number(values.get(last_day)):
            continue
        earlier = [day for day, value in values.items() if day < last_day and _is_number(value)]
        last = f"its last value before that day is of {max(earlier)}" if earlier else "it has no value before that day"
        lines.append(f"The {series_id} series has no value of {last_day}: {last}. Trading day {trading_day} needs "
                     f"its value of {last_day}; a value carried forward does not count. Read by: {'; '.join(read_by)}.")
    if lines:
        raise StaleDataError("\n".join(lines))


# --------------------------------------------------------------------------- the history the plan was tested on

# name -> (first day, holes): a series by its id, the bars of an ETF by bars_name. A hole is a run of
# consecutive days of the reference list without a value, as (first day, last day).
Gaps = Mapping[str, tuple[str, tuple[tuple[str, str], ...]]]
# How many holes of one name a refusal names.
HOLES_SHOWN = 5


def bars_name(symbol: str) -> str:
    """The name of the bars of an ETF in a gap list (a series has its own id)."""
    return f"{symbol} bars"


def _holes(have: set[str], reference: Sequence[str], first: str) -> tuple[tuple[str, str], ...]:
    """The runs of consecutive days of `reference` after `first` that are not in `have`."""
    runs: list[list[str]] = []
    open_run = False
    for day in reference:
        if day <= first or day in have:
            open_run = False
        elif open_run:
            runs[-1][1] = day
        else:
            runs.append([day, day])
            open_run = True
    return tuple((start, end) for start, end in runs)


def data_gaps(data: pf.Dataset, names: Sequence[str] | None = None, until: str | None = None) -> dict[str, tuple]:
    """name -> (first day, holes) of the series and the ETF bars of `data` (Gaps).

    A series counts a day when it has a finite value of that day; its reference days are the
    trading days of the calendar (the bars of pf.CALENDAR_SYMBOL). The bars of an ETF count the days
    it has a bar; their reference days are the calendar days and the days on which at least half of
    the ETFs that have started (first bar on or before that day) have a bar. So a bar missing from
    the calendar ETF itself shows, a day that several ETFs lose at once shows, and one ETF with an
    extra bar on a closed day is no hole of the others. A name is checked
    from its first day on. `names`: the names to list (default: every series and every ETF;
    `<ETF>:TR` series are the bars' own). `until`: holes only on days before it. A name without any
    value is left out.
    """
    started = sorted(bars.dates[0] for bars in data.bars.values() if bars.dates)
    having = Counter(day for bars in data.bars.values() for day in bars.dates)
    calendar = list(data.calendar)
    on_calendar = set(calendar)
    bar_days = sorted(day for day, count in having.items()
                      if day in on_calendar or 2 * count >= bisect.bisect_right(started, day))
    if until is not None:
        bar_days, calendar = [day for day in bar_days if day < until], [day for day in calendar if day < until]
    if names is None:
        names = [*(bars_name(symbol) for symbol in sorted(data.bars)),
                 *sorted(name for name in data.series if not name.endswith(":TR"))]
    out: dict[str, tuple] = {}
    for name in names:
        symbol = name.removesuffix(" bars")
        if symbol != name:
            have, reference = set(data.bars[symbol].dates) if symbol in data.bars else set(), bar_days
        else:
            values = data.series.get(name) or {}
            have, reference = {day for day, value in values.items() if _is_number(value)}, calendar
        if have:
            first = min(have)
            out[name] = (first, _holes(have, reference, first))
    return out


def history_readers(sleeves: Sequence[Mapping], made: Mapping[str, tuple[Mapping, str]]) -> dict[str, list[str]]:
    """Name (Gaps) -> the readers of every history a sleeve reads: its series (required_series; an
    `<ETF>:TR` series is that ETF's bars), the bars of its ETFs, and the bars of the calendar."""
    out: dict[str, list[str]] = {bars_name(pf.CALENDAR_SYMBOL): ["the trading calendar"]}
    for sleeve in sleeves:
        definition = made[sleeve["key"]][0]
        for symbol in definition["portfolio"]["symbols"]:
            out.setdefault(bars_name(symbol), []).append(f"{sleeve['key']} (traded)")
        for series_id, uses in required_series(definition).items():
            name = bars_name(series_id.removesuffix(":TR")) if series_id.endswith(":TR") else series_id
            out.setdefault(name, []).append(f"{sleeve['key']} ({', '.join(uses)})")
    return out


def _covered(hole: tuple[str, str], pinned: Sequence[tuple[str, str]]) -> bool:
    return any(start <= hole[0] and hole[1] <= end for start, end in pinned)


def check_history(sleeves: Sequence[Mapping], made: Mapping[str, tuple[Mapping, str]], data: pf.Dataset,
                  last_day: str, trading_day: str, pins: Gaps) -> None:
    """Refuses the run when a history a sleeve reads lacks a value on an older day that the tested data has.

    The model account is one path from its start: each trade rests on the ones before it (a sleeve
    that holds one spread at a time enters only after the last one closed; the caps are shared). A
    hole on any older day changes that path without a word: the signal code and the options book
    carry a missing value forward or drop an entry, so a strike moves or a spread disappears. So
    every series a sleeve reads, the bars of every ETF it trades and the calendar's bars must have
    a value on every day from their first day to the day before `last_day`, except the holes the
    data had when the plan was tested (`pins`: golive/tested_gaps.py). A hole that ends before the
    pinned first day is in days the test never read and does not count. A history that starts later
    than the pinned one has lost days too, and a history that is not pinned cannot be told apart
    from a gap. The last data day itself is the check of check_series (and of `generate` for bars).
    """
    readers = history_readers(sleeves, made)
    found = data_gaps(data, list(readers), until=last_day)
    lines = []
    for name, read_by in readers.items():
        tail = f"Trading day {trading_day} is refused. Read by: {'; '.join(read_by)}."
        pinned = pins.get(name)
        if pinned is None:
            lines.append(f"The {name} history is not pinned (golive/tested_gaps.py): a new gap cannot be told from "
                         f"one the plan was tested with. {tail}")
            continue
        pinned_first, pinned_holes = pinned
        first, holes = found.get(name, (None, ()))
        if first is None or first > pinned_first:
            starts = "has no value" if first is None else f"starts on {first}"
            lines.append(f"The {name} history {starts}; the tested data starts on {pinned_first}. {tail}")
            continue
        # A hole that ends before the tested history starts is in days the test never read.
        new = [hole for hole in holes if hole[1] >= pinned_first and not _covered(hole, pinned_holes)]
        if new:
            shown = ", ".join(start if start == end else f"{start} to {end}" for start, end in new[:HOLES_SHOWN])
            more = f" and {len(new) - HOLES_SHOWN} more" if len(new) > HOLES_SHOWN else ""
            lines.append(f"The {name} history has no value on {shown}{more}: older days the tested data has values "
                         "for. A gap on an older day changes the model's trades or strikes without a word; it must "
                         f"be filled by a refresh, or checked and pinned (python -m golive.pin). {tail}")
    if lines:
        raise StaleDataError("\n".join(lines))


def pending_days(calendar_days: Sequence[str], trading_day: str) -> tuple[str, str]:
    """The trading day and the trading day after it: the two bars the book needs to price its entry."""
    calendar = TradingCalendar(calendar_days)
    following = date.fromisoformat(trading_day) + timedelta(days=1)
    while not calendar.is_trading_day(following):
        following += timedelta(days=1)
    return trading_day, following.isoformat()


def with_pending_days(data: pf.Dataset, days: Sequence[str]) -> pf.Dataset:
    """`data` with one more bar per ETF on each of `days`: open, high, low and close repeat the last close.

    The series (IV indices, rate) get no value: the book carries the last one forward, as on any
    day without a print (data.align, at most MAX_FILL_DAYS).
    """
    bars: dict[str, Bars] = {}
    series = dict(data.series)
    for symbol, bar in data.bars.items():
        added = tuple(day for day in days if bar.dates and day > bar.dates[-1])
        if not added:
            bars[symbol] = bar
            continue
        closes = (bar.close[-1],) * len(added)
        bars[symbol] = Bars(symbol, bar.dates + added, bar.open + closes, bar.high + closes, bar.low + closes,
                            bar.close + closes, bar.adj_close + (bar.adj_close[-1],) * len(added))
        series[f"{symbol}:TR"] = dict(zip(bars[symbol].dates, bars[symbol].adj_close))
    return pf.Dataset(bars, series)


def model_trades(made: Mapping[str, tuple[Mapping, str]], data: pf.Dataset, plan: Mapping) -> al.Combined:
    """The model account of the plan (funded_pie.model_run without its ledger).

    `made`: sleeve key -> (definition, start), in the plan's sleeve order (`combine` is first come,
    first served). Each sleeve trades under the owner exit rule; the account starts on the first day
    every sleeve can run; a position risks positionRiskPct and the caps are the plan limits and the
    sleeve budgets.
    """
    priced = {key: al.owner_rule_trades(definition, data, start=start) for key, (definition, start) in made.items()}
    start = max(start for _definition, start in made.values())
    books = {key: [trade for trade in trades if trade.entry_date >= start] for key, trades in priced.items()}
    limits = plan["limits"]
    caps = al.Caps(open_risk_pct=limits["openRiskCapPct"], name_risk_pct=limits["nameRiskCapPct"],
                   max_positions=limits["maxPositions"], sleeve_of={key: key for key in books},
                   sleeve_risk_pct={sleeve["key"]: sleeve["budgetPct"] for sleeve in plan["sleeves"]})
    return al.combine(books, dict.fromkeys(books, limits["positionRiskPct"]), caps)


# --------------------------------------------------------------------------- signal facts

def _fmt(value: float, spec: str = ".4g") -> str:
    return "no value" if math.isnan(value) else format(value, spec)


def _label(expr: Mapping, fallback: str) -> str:
    return next((label for known, label in EXPRESSION_LABELS if known == expr), fallback)


def _on(series: Mapping[str, Mapping[str, float]], series_id: str, day: str) -> float:
    """The value of a series dated `day` itself (NaN without one)."""
    value = series.get(series_id, {}).get(day)
    return math.nan if value is None else float(value)


def _through(series: Mapping[str, Mapping[str, float]], series_id: str, day: str) -> list[float]:
    """The values of a series dated on or before `day`, in date order."""
    return [value for at, value in sorted(series.get(series_id, {}).items()) if at <= day]


def _latest(series: Mapping[str, Mapping[str, float]], series_id: str, day: str) -> tuple[str, float]:
    """(date, value) of the latest value of a series dated on or before `day`; (day, NaN) without one."""
    return max(((at, value) for at, value in series.get(series_id, {}).items() if at <= day), default=(day, math.nan))


def filter_facts(filter_: Mapping, symbol: str, day: str, series: Mapping[str, Mapping[str, float]]) -> list[str]:
    """The values one entry filter read on the signal day, each with its date.

    volRegime, vixTermStructure and ivRank read the value dated the signal day itself (signals.py
    aligns them exactly); a series filter reads the latest value on or before it.
    """
    kind = filter_.get("type")
    far = _on(series, "VIX3M", day)
    ratio = _fmt(_on(series, "VIX", day) / far if far > 0 else math.nan, ".3f")
    if kind == "volRegime":
        length = filter_["trendLength"]
        closes = _through(series, "SPY", day)
        average = sig.rolling_mean(closes, length)[-1] if closes else math.nan
        return [f"VIX {_fmt(_on(series, 'VIX', day), '.2f')} on {day} (gate: at most {filter_['maxVix']:g}).",
                f"VIX/VIX3M ratio {ratio} on {day} (gate: at most {filter_['maxTermRatio']:g}).",
                f"SPY close {_fmt(_on(series, 'SPY', day), '.2f')}, its {length}-day average {_fmt(average, '.2f')} "
                f"on {day} (gate: close above the average)."]
    if kind == "vixTermStructure":
        return [f"VIX/VIX3M ratio {ratio} on {day} (gate: at most {filter_['maxRatio']:.6g})."]
    if kind == "ivRank":
        values = _through(series, IV_INDEX[symbol], day)
        rank = sig.iv_rank_series(values, filter_["length"])[-1] if values else math.nan
        return [f"IV rank of {IV_INDEX[symbol]} over {filter_['length']} days: {_fmt(rank, '.1f')} on {day} "
                f"(gate: at least {filter_.get('min', 0):g})."]
    series_id = sig.resolve_series(filter_["series"], symbol) if kind == "series" else None
    if series_id is not None:
        at, value = _latest(series, series_id, day)
        condition = filter_["condition"]
        return [f"{series_id} {_fmt(value)} on {at} (gate: {condition['op']} "
                f"{_fmt(float(condition['right'].get('value', math.nan)))})."]
    return [f"Filter {kind}: passed on {day}."]


def _entry_facts(leg: pf.RunLeg, data: pf.Dataset, index: int, day: str) -> list[str]:
    """Both sides of every entry condition of the leg on the signal bar."""
    out = []
    entry = leg.definition.get("entry") or {}
    conditions = [*(entry.get("all") or ()), *(entry.get("any") or ())]
    for number, condition in enumerate(conditions, start=1):
        if condition == qi.ALWAYS:
            if not leg.definition.get("filters"):
                out.append("Entry rule: always on (this sleeve has no entry gate).")
            continue
        left = pf.leg_values(leg, data, condition["left"])[index]
        right = pf.leg_values(leg, data, condition["right"])[index]
        out.append(f"Entry condition {number}: {_label(condition['left'], 'left side')} {_fmt(left)} {condition['op']} "
                   f"{_fmt(right)} on {day}.")
    return out


def _selection_fact(definition: Mapping, data: pf.Dataset, symbol: str, day: str) -> list[str]:
    """Where the member stands among the members with a score in the month of `day` (portfolio `select`)."""
    select = (definition.get("portfolio") or {}).get("select")
    if select is None:
        return []
    scores: dict[str, float] = {}
    for leg in pf.run_legs(definition):
        dates = data.bars[leg.symbol].dates
        values = pf.leg_values(leg, data, select["score"])
        scored = [values[at] for at in range(len(dates)) if dates[at][:7] == day[:7] and not math.isnan(values[at])]
        if scored:
            scores[leg.symbol] = scored[-1]
    if symbol not in scores:
        return []
    rank = 1 + sum(1 for value in scores.values() if value > scores[symbol])
    return [f"Selection: {symbol} ranks {rank} of {len(scores)} members by {_label(select['score'], 'score')} "
            f"({_fmt(scores[symbol])}) in {day[:7]}; the sleeve holds the top {select['top']}."]


def signal_facts(trade: PricedTrade, definition: Mapping, data: pf.Dataset) -> list[str]:
    """The entry date, the timing rule and every value the entry of `trade` was decided on, with dates."""
    leg = next(leg for leg in pf.run_legs(definition) if leg.symbol == trade.symbol)
    index = trade.entry_index - 1
    day = data.bars[trade.symbol].dates[index]
    spec = parse_options(definition["options"])
    dte = (date.fromisoformat(trade.expiry) - date.fromisoformat(trade.entry_date)).days
    out = [f"Model entry date {trade.entry_date}; its signal is the close of {day}.", TIMING_FACT,
           *_entry_facts(leg, data, index, day)]
    for filter_ in leg.definition.get("filters") or ():
        out.extend(filter_facts(filter_, trade.symbol, day, data.series))
    out.extend(_selection_fact(definition, data, trade.symbol, day))
    out.append(f"Model expiry {trade.expiry}: {dte} days after the entry date (target {spec.dte_target}, "
               f"minimum {spec.dte_min}).")
    return out


def strike_input_facts(trade: PricedTrade, data: pf.Dataset) -> list[str]:
    """The implied-volatility index value and the rate that set the strikes of `trade`, each with its own date.

    The book reads both on the entry bar (book._price_event), where data.align has carried the
    latest print forward. The date stated is the date of that print, which can be before the entry
    date. `data`: the data set the trade was priced on. The values are compared with the ones the
    book reads on the entry bar of `data` (portfolio.market_of): when they differ (the bar is not
    the entry date, or the print is too old to be carried) the fact would name a value that was
    not used, and the run is refused.
    """
    market = pf.market_of(data, trade.symbol)
    index_id = IV_INDEX[trade.symbol]
    level_day, level = _latest(data.series, index_id, trade.entry_date)
    rate_day, rate = _latest(data.series, RATE_SERIES, trade.entry_date)
    if (market.dates[trade.entry_index] != trade.entry_date or market.iv_index[trade.entry_index] != level
            or market.rate[trade.entry_index] != rate / 100):
        raise GoLiveError(f"{trade.symbol} entry {trade.entry_date}: the {index_id} and {RATE_SERIES} values dated "
                          f"{level_day} and {rate_day} are not the ones the options book reads on that bar; no document")
    return [f"Strike inputs: {index_id} {level:.2f} of {level_day} (implied volatility), {RATE_SERIES} {rate:.2f} of "
            f"{rate_day} (rate)."]


# --------------------------------------------------------------------------- chain snapshots

@dataclass(frozen=True)
class Snapshot:
    """One run of research/backtests/option-chain/snapshot.py: <store>/<New York day>/<HHMMSS>Z/."""

    path: Path
    as_of: datetime
    # The ETFs the run is done with. snapshot.py lists a symbol here also when its fetch failed.
    symbols: frozenset[str]
    # symbol -> what the run reports for it (summary.json "errors"); a symbol without an entry was measured.
    errors: Mapping[str, str] = field(default_factory=dict)

    @property
    def stamp(self) -> str:
        return self.as_of.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

    @property
    def day(self) -> str:
        """The New York calendar day of the fetch: the day the freshness rule reads."""
        return self.as_of.astimezone(NEW_YORK).date().isoformat()


def _entries(path: Path) -> list[Path]:
    """The entries of a directory of the store, by name; a directory that cannot be listed is a store fault."""
    try:
        return sorted(path.iterdir())
    except OSError as error:
        raise ChainStoreError(f"The chain store cannot be read ({path}: {error.strerror or error}); no document, "
                              "because the strikes of a candidate come from the listed chains") from None


def snapshots(store: Path, now: datetime) -> list[Snapshot]:
    """The stored runs fetched at or before `now`, newest first.

    A store that does not exist or cannot be read, and a summary.json that cannot be read, are
    errors. A run without summary.json (still starting) or with one that is not a snapshot summary
    (damaged) is left out. `symbols` are the ETFs the run is done with.
    """
    out = []
    for day_dir in _entries(Path(store)):
        if not day_dir.is_dir():
            continue
        for run_dir in _entries(day_dir):
            path = run_dir / "summary.json"  # json-data-ignore: option-chain snapshot store on the rig, outside the repo (infra/option-chain writes it); the app never reads it
            try:
                summary = json.loads(path.read_text())
                as_of = datetime.fromisoformat(summary["fetchedAt"])
                symbols = frozenset(summary["symbols"])
                errors = summary.get("errors")
            except (FileNotFoundError, NotADirectoryError):
                continue
            except OSError as error:
                raise ChainStoreError(f"The chain store cannot be read ({path}: {error.strerror or error}); "
                                      "no document") from None
            except (ValueError, KeyError, TypeError, AttributeError):  # JSONDecodeError is a ValueError
                continue
            if as_of.tzinfo is None:
                as_of = as_of.replace(tzinfo=UTC)
            if as_of <= now:
                reported = errors.items() if isinstance(errors, Mapping) else ()
                out.append(Snapshot(run_dir, as_of, symbols, {str(symbol): str(text) for symbol, text in reported}))
    return sorted(out, key=lambda item: item.as_of, reverse=True)


def has_chains(snapshot: Snapshot, symbol: str) -> bool:
    """True when the run stored a chain file of `symbol`. A run that lists the symbol without one failed its fetch."""
    return any(entry.name.startswith(f"{symbol}-") and entry.suffix == ".csv" for entry in _entries(snapshot.path))


def _cell(row: Mapping[str, str], key: str) -> float:
    try:
        return float(row.get(key) or "nan")
    except ValueError:
        return math.nan


def chain_quotes(snapshot: Snapshot, symbol: str, expiry: str, right: str) -> dict[float, tuple[float, float]] | None:
    """strike -> (bid, ask) of one side of one expiry; None when the snapshot has no such chain file.
    A chain file that is there and cannot be read is an error."""
    path = snapshot.path / f"{symbol}-{expiry}-{'calls' if right == 'call' else 'puts'}.csv"
    try:
        with path.open(newline="") as handle:
            rows = [(_cell(row, "strike"), _cell(row, "bid"), _cell(row, "ask")) for row in csv.DictReader(handle)]
    except FileNotFoundError:
        return None
    except (OSError, ValueError, csv.Error) as error:  # UnicodeDecodeError is a ValueError
        raise ChainStoreError(f"The chain file {path} cannot be read ({error}); no document") from None
    return {strike: (bid, ask) for strike, bid, ask in rows if strike > 0}


def _usable(bid: float, ask: float) -> bool:
    return math.isfinite(bid) and math.isfinite(ask) and bid >= 0 and ask > 0 and ask >= bid


def _reported(snapshot: Snapshot, symbol: str) -> str:
    """What the run reports for the symbol, in brackets and cut to fit a fact line ("" without a report)."""
    text = " ".join(snapshot.errors.get(symbol, "").split())
    return f" ({text[:80]})" if text else ""


def _lacks(snapshot: Snapshot, symbol: str, expiry: str, right: str) -> str:
    """What a run that is done with the symbol lacks, when it has no usable chain of the expiry and side."""
    side = "calls" if right == "call" else "puts"
    if not has_chains(snapshot, symbol):
        return f"the {symbol} chain fetch failed in the snapshot of {snapshot.stamp}{_reported(snapshot, symbol)}"
    empty = chain_quotes(snapshot, symbol, expiry, right) is not None
    return (f"the snapshot of {snapshot.stamp} has {'a' if empty else 'no'} {expiry} {side} chain of {symbol}"
            f"{' without a strike' if empty else ''}{_reported(snapshot, symbol)}")


def price_candidate(trade: PricedTrade, runs: Sequence[Snapshot], oldest_day: str,
                    trading_day: str) -> tuple[float, float, dict | None, list[str]]:
    """(long strike, short strike, quote or None, facts) of a model trade: listed strikes, or no document.

    `runs`: newest first. `oldest_day`: the oldest New York day a snapshot may be of (the freshness
    rule, MAX_AGE_TRADING_DAYS; `generate` passes the last data day). A usable chain is the chain
    file of the symbol, expiry and side, with at least one strike, in a snapshot of that day or later
    that is done with the symbol. A newer run that failed the symbol, or lacks that one file, does not
    hide an older one that has it.

    Strikes: each model strike moves to the nearest listed strike (the lower one on a tie) of the
    OLDEST usable chain. A stored chain does not change, so every run of a trading day names the same
    strikes for a model trade (the strikes are part of the draft id on the server), as long as no run
    with an earlier time is added to the store later. The listed steps
    are the exchange's (5 dollars on SPY away from the money), so a listed strike can be several model
    steps away; the leg facts name both. No usable chain, a model strike outside the listed strikes of
    that chain, or both legs on one listed strike, refuse the run (NoChainError): a draft names listed
    contracts only.

    Quote: the bid and ask of those two strikes in the NEWEST usable chain; none when it does not list
    both, or a leg has no usable bid and ask.

    Not stored by design: a snapshot keeps the monthly expiries `stored_dte_range` calendar days after
    its own day (snapshot.py DTE_RANGE). A candidate whose expiry no snapshot the run may read can hold
    (fewer than the least days after `oldest_day`, or more than the most days after `trading_day`)
    keeps the model strikes and has no quote, and its facts say so: a held spread near its expiry, or
    an entry further out than the store reaches. The rule reads dates only, so every run of a trading
    day decides the same way. An expiry that only the trading day's own snapshots hold (the most days
    after `trading_day`, but more after `oldest_day`) is refused until such a snapshot is stored.
    """
    model = (trade.long_strike, trade.short_strike)
    symbol, expiry, right = trade.symbol, trade.expiry, STRUCTURES[trade.structure][0]
    low, high = stored_dte_range()
    days_out = (date.fromisoformat(expiry) - date.fromisoformat(trading_day)).days
    if (date.fromisoformat(expiry) - date.fromisoformat(oldest_day)).days < low or days_out > high:
        return (*model, None, [
            f"Listed strikes not checked: the chain store keeps expiries {low} to {high} days out, and {expiry} is "
            f"{days_out} days after the trading day; no snapshot holds it. These are the model's strikes.",
            "No quote: the chain is not stored."])

    def refuse(why: str) -> NoChainError:
        side = "calls" if right == "call" else "puts"
        return NoChainError(f"No listed strikes for the {expiry} {side} of {symbol} (model strikes {model[0]:g}/"
                            f"{model[1]:g}): {why}. A draft names listed strikes only; no document.")

    done = [run for run in runs if symbol in run.symbols]
    if not done:
        raise refuse(f"the chain store has no snapshot of {symbol}")
    fresh = [run for run in done if run.day >= oldest_day]
    if not fresh:
        raise refuse(f"the newest chain snapshot of {symbol} is of {done[0].day} ({done[0].stamp}), older than "
                     f"{oldest_day}, the oldest day strikes may come from")
    chains = [(run, chain) for run in fresh if (chain := chain_quotes(run, symbol, expiry, right))]
    if not chains:
        older = "" if len(fresh) == 1 else f", and none of the {len(fresh) - 1} older ones since {oldest_day} has it"
        raise refuse(f"{_lacks(fresh[0], symbol, expiry, right)}{older}")
    (newest, quoted), (first, listing) = chains[0], chains[-1]
    facts, listed = [], []
    if newest is not fresh[0]:
        facts.append(f"Newest snapshot not read: {_lacks(fresh[0], symbol, expiry, right)}.")
    lowest, highest = min(listing), max(listing)
    for name, strike in zip(("Long", "Short"), model):
        if not lowest <= strike <= highest:
            raise refuse(f"the {name.lower()} leg {strike:g} is outside the listed strikes {lowest:g} to {highest:g} "
                         f"of the snapshot of {first.stamp}")
        nearest = min(listing, key=lambda item: (abs(item - strike), item))
        facts.append(f"{name} leg: model strike {strike:g} -> listed {nearest:g}.")
        listed.append(nearest)
    if listed[0] == listed[1]:
        raise refuse(f"both legs meet on the listed strike {listed[0]:g} in the snapshot of {first.stamp}")
    if not all(strike in quoted for strike in listed):
        return (*listed, None, [*facts, f"No quote: the chain snapshot of {newest.stamp} does not list both strikes."])
    (long_bid, long_ask), (short_bid, short_ask) = quoted[listed[0]], quoted[listed[1]]
    if not (_usable(long_bid, long_ask) and _usable(short_bid, short_ask)):
        return (*listed, None, [*facts, f"No usable bid and ask for both legs in the chain snapshot of {newest.stamp}: "
                                        "no quote."])
    quote = {"asOf": newest.stamp, "longAsk": long_ask, "longBid": long_bid, "shortAsk": short_ask,
             "shortBid": short_bid, "source": QUOTE_SOURCE}
    return (*listed, quote, [*facts, f"Quote: Yahoo chain snapshot of {newest.stamp}, delayed, not a live quote."])


# --------------------------------------------------------------------------- the document

def _numbers(value: object, path: str):
    """(path, number) of every number in a JSON value."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield from _numbers(item, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            yield from _numbers(item, f"{path}[{index}]")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield path, value


def check_candidate(candidate: Mapping, trading_day: str) -> None:
    """Refuses a candidate that is not safe to show as an order draft.

    The rules: every number is finite; the strikes are positive, different and the right way round
    for the structure (LONG_STRIKE_IS_LOWER: a call debit vertical buys the lower strike, a put
    credit vertical sells the higher one); the expiry is a calendar day after the trading day; a
    quote carries the delayed-snapshot label QUOTE_SOURCE and nothing else (never a live label).
    """
    def refuse(why: str) -> UnsafeOutputError:
        return UnsafeOutputError(f"Unsafe candidate {candidate.get('sleeveKey')} {candidate.get('symbol')}: {why}; "
                                 "no document")

    for path, number in _numbers(candidate, "candidate"):
        if not math.isfinite(number):
            raise refuse(f"{path} is {number}, not a finite number")
    structure, long_strike, short_strike = candidate["structure"], candidate["longStrike"], candidate["shortStrike"]
    if structure not in LONG_STRIKE_IS_LOWER:
        raise refuse(f"unknown structure {structure!r}")
    if not (_is_number(long_strike) and _is_number(short_strike) and long_strike > 0 and short_strike > 0):
        raise refuse(f"the strikes {long_strike!r}/{short_strike!r} must be numbers above 0")
    if long_strike == short_strike:
        raise refuse(f"both legs are on the strike {long_strike:g}")
    if (long_strike < short_strike) != LONG_STRIKE_IS_LOWER[structure]:
        side = "below" if LONG_STRIKE_IS_LOWER[structure] else "above"
        raise refuse(f"a {structure} has its long strike {side} its short strike, not long {long_strike:g} and "
                     f"short {short_strike:g}")
    expiry = candidate["expiry"]
    try:
        expires = datetime.strptime(expiry, "%Y%m%d").date() if isinstance(expiry, str) and len(expiry) == 8 else None
    except ValueError:
        expires = None
    if expires is None or expires <= date.fromisoformat(trading_day):
        raise refuse(f"the expiry {expiry!r} must be a day (YYYYMMDD) after the trading day {trading_day}")
    quote = candidate["quote"]
    if quote is not None and quote.get("source") != QUOTE_SOURCE:
        raise refuse(f"the quote source is {quote.get('source')!r}; this generator reads delayed snapshots only "
                     f"({QUOTE_SOURCE})")


def check_document(document: dict) -> dict:
    """`document` when every candidate passes check_candidate; an UnsafeOutputError otherwise."""
    for candidate in document["candidates"]:
        check_candidate(candidate, document["tradingDay"])
    return document


def _candidate(basis: str, sleeve_key: str, trade: PricedTrade, definition: Mapping, data: pf.Dataset, last_day: str,
               trading_day: str, runs: Sequence[Snapshot]) -> dict:
    facts = [f"Data last day {last_day}.", *signal_facts(trade, definition, data), *strike_input_facts(trade, data)]
    if basis == SIGNAL_TODAY:
        close = data.bars[trade.symbol].close[trade.entry_index - 1]
        facts.append(f"Model strikes {trade.long_strike:g}/{trade.short_strike:g} use the {last_day} close "
                     f"({trade.symbol} {close:.2f}); the tested entry sets them at the {trading_day} close.")
    elif trade.exit_date == trading_day and trade.exit_reason == "signal":
        # A position that expires on the trading day is no candidate (generate), so only a signal closes one here.
        facts.append(f"The model closes this position at the close of {trading_day} (exit signal at the {last_day} "
                     "close).")
    # The freshness rule: the last data day is the oldest day anything may be of.
    long_strike, short_strike, quote, priced = price_candidate(trade, runs, last_day, trading_day)
    facts.extend(priced)
    if len(facts) > FACTS_MAX or any(len(fact) > FACT_MAX_CHARS for fact in facts):
        raise GoLiveError(f"Sleeve {sleeve_key} {trade.symbol}: the facts pass the limit of {FACTS_MAX} lines of "
                          f"{FACT_MAX_CHARS} characters")
    return {"entryBasis": basis, "expiry": trade.expiry.replace("-", ""), "longStrike": long_strike, "quote": quote,
            "shortStrike": short_strike, "signalFacts": facts, "sleeveKey": sleeve_key, "structure": trade.structure,
            "symbol": trade.symbol}


def generate(plan: object, data: pf.Dataset, facts: qi.Facts, chain_store: Path, trading_day: str,
             now: datetime, pins: Gaps | None = None) -> dict:
    """The collect document of `trading_day`: planId, planVersion, tradingDay, generatedAt and candidates.

    `data` and `facts`: study.load_study_data of the qc-ports data directory (its `dataset` and
    `facts`). `now`: an aware datetime; the quotes come from the newest chain snapshot at or before
    it. `pins`: the holes of the tested data (default TESTED_GAPS, golive/tested_gaps.py). Raises
    GoLiveError (no document) when the plan or the day is refused, when the bars or a series a
    sleeve reads have no value of the last data day or of an older day the tested data has one for,
    when the chain store cannot be read, when a candidate has no listed strikes, or when a candidate
    breaks an output rule. Zero candidates is a valid result: every check passed and the model wants
    nothing.
    """
    plan = checked_plan(plan)
    last_day = last_data_day(data.calendar, trading_day)
    runs = qi.family(facts)
    made = {sleeve["key"]: build_definition(sleeve, runs, facts) for sleeve in plan["sleeves"]}
    for sleeve in plan["sleeves"]:
        definition = made[sleeve["key"]][0]
        check_sleeve(sleeve, definition)
        for symbol in definition["portfolio"]["symbols"]:
            if data.bars[symbol].dates[-1] != last_day:
                raise StaleDataError(f"The {symbol} bars end on {data.bars[symbol].dates[-1]}, the data on {last_day}: "
                                     "no signal is drawn from older data.")
    check_series(plan["sleeves"], made, data, last_day, trading_day)
    check_history(plan["sleeves"], made, data, last_day, trading_day, TESTED_GAPS if pins is None else pins)
    stored = snapshots(Path(chain_store), now)
    pending = with_pending_days(data, pending_days(data.calendar, trading_day))
    combined = model_trades(made, pending, plan)
    order = {sleeve["key"]: position for position, sleeve in enumerate(plan["sleeves"])}
    chosen = []
    for trade in combined.trades:
        key = combined.owner[trade.trade_id]
        if trade.expiry <= trading_day:
            continue  # not an entry anyone can take; the contract refuses the whole batch for one such expiry
        if trade.entry_date == trading_day:
            chosen.append((0, order[key], trade.symbol, SIGNAL_TODAY, key, trade))
        elif trade.entry_date <= last_day < trade.exit_date:
            chosen.append((1, order[key], trade.symbol, MODEL_HOLDS, key, trade))
    chosen.sort(key=lambda item: item[:3])
    return check_document({
        "planId": plan["id"], "planVersion": plan["version"], "tradingDay": trading_day,
        "generatedAt": now.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "candidates": [_candidate(basis, key, trade, made[key][0], pending, last_day, trading_day, stored)
                       for _group, _order, _symbol, basis, key, trade in chosen],
    })
