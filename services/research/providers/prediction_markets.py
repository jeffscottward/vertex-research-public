"""Prediction-market trade data (Kalshi, Polymarket): resolution, positions and calibration.

Port of the calibration logic in Jon-Becker/prediction-market-analysis (MIT,
commit 2d69f7330fdee142d2cf75d901841f9174fdbbd2):

* ``src/analysis/kalshi/win_rate_by_price.py``: taker and maker positions on
  finalized yes/no markets.
* ``src/analysis/polymarket/polymarket_win_rate_by_price.py``: CTF token
  resolution (one outcome price > 0.99 and the other < 0.01), buyer and
  counterparty positions from ``OrderFilled`` amounts, and Brier score, log loss
  and expected calibration error (ECE) at trade time.

Copyright (c) 2026 Jonathan Becker. MIT; see PREDICTION_MARKET_ANALYSIS_LICENSE.txt.
Changes from the original: plain Python over row iterables that the caller
passes in, instead of DuckDB SQL over Parquet files; typed results; prices
outside 1..99 cents are left out for both venues (upstream keeps them in the
Kalshi table and drops them in its chart); legacy FPMM (fixed product market
maker) trades of 2020-2022 are not ported.

Input values are the scalars that a JSON or row reader gives (text, numbers,
booleans, ``None``) and two-item lists for the two Polymarket list fields. A
row with a value that cannot be read is skipped, so a bad scalar does not stop
the run; other value types are outside the contract. A missing join key
(``None`` or NaN) never joins.

Research only. The module reads only the rows that the caller passes in. It does
not download the dataset, contact a venue, read an account, place or simulate
orders, or grant trading authority. Prices are implied probabilities in whole
cents (1..99). Dataset rights: the code is MIT; the pre-collected dataset has no
separate license statement and is not used (see docs/vertex-rebuild/upstream-candidates-20261030.md).

Unit: one trade gives two positions (both sides), so ``total_trades`` (the
upstream column name) counts positions. Each position has weight 1; contract
count and notional are not used. Test status: the same synthetic rows gave the
same buckets and scores as the upstream code at the commit above (differential
run, 2026-11-15). First real-row run: Polymarket fills and resolutions from
public Polygon logs, read through providers.prediction_market_parquet
(docs/vertex-rebuild/prediction-market-onchain-sample.md, Results). Kalshi has no real-row run.
"""
from __future__ import annotations

import json
import math
import numbers
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, replace
from typing import Any

RESOLVED_HIGH = 0.99
RESOLVED_LOW = 0.01
LOG_LOSS_EPSILON = 1e-6
# Errors of one row that cannot be read; such a row is skipped, and no row stops the run.
_ROW_ERRORS = (TypeError, ValueError, OverflowError, RecursionError)


@dataclass(frozen=True)
class Position:
    """One side of one trade: the price paid in cents and whether that side won."""

    price_cents: int
    won: bool


@dataclass
class SkippedRows:
    """Mutable count of trade rows dropped for data-quality reasons (not join misses)."""

    count: int = 0


def _int_or_none(value: Any) -> int | None:
    """A whole number as ``int``: an integer, a float without a fraction or a string of digits.

    ``None`` for every other value (missing, boolean, fractional, not finite,
    unreadable text or another type), so the caller skips and counts the row.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, numbers.Integral):  # int and the integer types of numpy.
        return int(value)
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value == math.floor(value) else None
    if isinstance(value, str):
        text = value.strip()
        digits = text[1:] if text[:1] in ("+", "-") else text
        if not (digits.isascii() and digits.isdigit()):
            return None
        try:
            return int(text)
        except ValueError:  # More digits than the interpreter converts.
            return None
    return None


def _join_key(value: Any) -> str | None:
    """Text of a ticker, asset id or token id; ``None`` for a missing value (``None`` or NaN)."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return str(value)


def _round_half_away(value: float) -> int:
    # DuckDB ROUND rounds half away from zero; Python round() rounds half to even.
    # The fraction is compared with 0.5: floor(value + 0.5) is wrong just below a half.
    whole = math.floor(abs(value))
    rounded = whole + 1 if abs(value) - whole >= 0.5 else whole
    return rounded if value >= 0 else -rounded


def _kalshi_market(row: Mapping[str, Any]) -> tuple[str, str] | None:
    ticker, result = _join_key(row.get("ticker")), row.get("result")
    if ticker is None or row.get("status") != "finalized" or result not in ("yes", "no"):
        return None
    return ticker, result


def kalshi_resolution(markets: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """``ticker -> 'yes' | 'no'`` for finalized markets with a yes/no result.

    Other market rows, rows without a ticker and rows with a value that cannot
    be read are left out without a count. Two rows for one ticker give one
    entry (the later row); the upstream SQL join would give the positions of
    each trade once for each market row.
    """
    resolved: dict[str, str] = {}
    for row in markets:
        try:
            entry = _kalshi_market(row)
        except _ROW_ERRORS:
            continue
        if entry is not None:
            resolved[entry[0]] = entry[1]
    return resolved


def _kalshi_pair(trade: Mapping[str, Any], resolution: Mapping[str, str]) -> tuple[Position, ...]:
    """Both positions of one trade; ``()`` for a join miss; ``ValueError`` for a bad row."""
    ticker = _join_key(trade.get("ticker"))
    result = None if ticker is None else resolution.get(ticker)
    if result is None:
        return ()
    side = trade.get("taker_side")
    yes_price, no_price = _int_or_none(trade.get("yes_price")), _int_or_none(trade.get("no_price"))
    if side not in ("yes", "no") or yes_price is None or no_price is None:
        raise ValueError("invalid taker side or price")
    taker_price, maker_price = (yes_price, no_price) if side == "yes" else (no_price, yes_price)
    return Position(taker_price, side == result), Position(maker_price, side != result)


def kalshi_positions(trades: Iterable[Mapping[str, Any]], resolution: Mapping[str, str],
                     skipped: SkippedRows | None = None) -> Iterator[Position]:
    """Taker and maker (counterparty) positions for trades on resolved markets.

    A trade on a market that is not resolved, or without a ticker, is left out
    without a count (the inner join of the upstream SQL). Deviation from
    upstream SQL: a row with a taker side other than yes/no, with a missing,
    fractional or unreadable price, or with another value that cannot be read,
    is skipped and counted in ``skipped`` (when the caller passes it). Upstream
    counts a row with an invalid taker side: with a missing taker side both
    sides are losses, and with another value the taker loses and the maker wins.
    """
    for trade in trades:
        try:
            pair = _kalshi_pair(trade, resolution)
        except _ROW_ERRORS:
            if skipped is not None:
                skipped.count += 1
            continue
        yield from pair


def _json_pair(value: Any) -> list[Any] | None:
    """A two-item list from a JSON string, a list or a tuple; ``None`` for any other value."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, RecursionError):  # json.JSONDecodeError is a ValueError.
            return None
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    return list(value)


def _polymarket_market(row: Mapping[str, Any]) -> dict[str, bool]:
    if row.get("closed") not in (True, 1):  # Equality, so numpy booleans also match.
        return {}
    prices = _json_pair(row.get("outcome_prices"))
    tokens = _json_pair(row.get("clob_token_ids"))
    if prices is None or tokens is None:
        return {}
    p0, p1 = float(prices[0]), float(prices[1])
    if p0 > RESOLVED_HIGH and p1 < RESOLVED_LOW:
        winner = 0
    elif p0 < RESOLVED_LOW and p1 > RESOLVED_HIGH:
        winner = 1
    else:
        return {}
    keys = [_join_key(token) for token in tokens]  # A missing token id never joins a trade.
    return {key: winner == index for index, key in enumerate(keys) if key is not None}


def polymarket_token_resolution(markets: Iterable[Mapping[str, Any]]) -> dict[str, bool]:
    """``CTF token id -> won`` for closed two-outcome markets with a clear winner.

    A market counts as resolved when one outcome price is above 0.99 and the
    other below 0.01. Markets with prices or token ids that cannot be read are
    left out without a count, as upstream does.
    """
    token_won: dict[str, bool] = {}
    for row in markets:
        try:
            token_won.update(_polymarket_market(row))
        except _ROW_ERRORS:
            continue
    return token_won


def _polymarket_pair(trade: Mapping[str, Any], token_won: Mapping[str, bool]) -> tuple[Position, ...]:
    """Both positions of one trade; ``()`` for a join miss; an error of ``_ROW_ERRORS`` for a bad row."""
    maker_amount, taker_amount = _int_or_none(trade.get("maker_amount")), _int_or_none(trade.get("taker_amount"))
    if maker_amount is None or taker_amount is None or maker_amount <= 0 or taker_amount <= 0:
        raise ValueError("invalid amount")
    maker_asset = _join_key(trade.get("maker_asset_id"))
    maker_pays_usdc = maker_asset == "0"
    token = _join_key(trade.get("taker_asset_id")) if maker_pays_usdc else maker_asset
    won = None if token is None else token_won.get(token)
    if won is None:
        return ()
    usdc, tokens = (maker_amount, taker_amount) if maker_pays_usdc else (taker_amount, maker_amount)
    # Multiply before dividing, as upstream SQL does, so half-cent prices round the same way.
    # An amount too large for a 64-bit float raises OverflowError.
    return (Position(_round_half_away(100.0 * usdc / tokens), won),
            Position(_round_half_away(100.0 - 100.0 * usdc / tokens), not won))


def polymarket_positions(trades: Iterable[Mapping[str, Any]], token_won: Mapping[str, bool],
                         skipped: SkippedRows | None = None) -> Iterator[Position]:
    """Buyer and counterparty positions from CTF ``OrderFilled`` rows.

    Asset id ``0`` is USDC. The outcome token is the other asset. The buyer's
    price is ``100 * usdc_amount / token_amount`` rounded half away from zero; the
    counterparty's price is ``100 - 100 * usdc_amount / token_amount``, rounded
    the same way. The two prices sum to 100, except at an exact half cent, where
    they sum to 101 (30.5 gives 31 and 69.5 gives 70), as in the upstream SQL.
    Rows with missing, fractional, unreadable or non-positive amounts are
    dropped (upstream drops the non-positive ones) and counted, before the
    token join. A row with amounts too large for a 64-bit float, or with
    another value that cannot be read, is also counted. A trade on a token that
    is not resolved, or without a token id, is left out without a count. Rows
    are not de-duplicated (as upstream).
    """
    for trade in trades:
        try:
            pair = _polymarket_pair(trade, token_won)
        except _ROW_ERRORS:
            if skipped is not None:
                skipped.count += 1
            continue
        yield from pair


@dataclass(frozen=True)
class PriceBucket:
    price_cents: int
    total_trades: int
    wins: int
    win_rate_pct: float


@dataclass(frozen=True)
class CalibrationReport:
    """Win rate by price and trade-time calibration scores.

    A well-calibrated market has ``win_rate_pct`` near ``price_cents``. Upstream
    notes that a Brier score near 0.17 is expected for a calibrated market with
    trades at all price levels; scores from prices near resolution look lower.
    Scores are ``None`` when no position falls in 1..99 cents: an empty or
    mis-joined input is unavailable, not a perfect score (upstream gives 0.0).
    ``buckets`` holds only the prices that have a position. ``win_rate_pct`` is
    in percent (0..100). The scores are rounded to 4 decimals; the log loss
    clips the probability to ``LOG_LOSS_EPSILON`` from 0 and 1, as upstream.
    """

    buckets: tuple[PriceBucket, ...]
    total_trades: int
    brier_score: float | None
    log_loss: float | None
    ece: float | None
    out_of_range_positions: int = 0
    skipped_rows: int = 0

    @property
    def available(self) -> bool:
        return self.total_trades > 0


def calibration_by_price(positions: Iterable[Position]) -> CalibrationReport:
    """Aggregate positions with prices 1..99 into buckets, Brier, log loss and ECE."""
    totals: dict[int, list[int]] = {}
    out_of_range = 0
    for position in positions:
        if not 1 <= position.price_cents <= 99:
            out_of_range += 1
            continue
        bucket = totals.setdefault(position.price_cents, [0, 0])
        bucket[0] += 1
        bucket[1] += 1 if position.won else 0
    return report_from_totals({price: (total, wins) for price, (total, wins) in totals.items()}, out_of_range)


def report_from_totals(totals: Mapping[int, tuple[int, int]], out_of_range: int = 0) -> CalibrationReport:
    """Report from ``price_cents -> (positions, wins)`` counts of prices 1..99.

    ``calibration_by_price`` counts positions into this form; a resampling
    caller (for example a bootstrap by market) can sum counts and call it directly.
    """
    buckets = tuple(PriceBucket(price, total, wins, 100.0 * wins / total)
                    for price, (total, wins) in sorted(totals.items()) if total > 0)
    total_trades = sum(bucket.total_trades for bucket in buckets)
    if total_trades == 0:
        return CalibrationReport((), 0, None, None, None, out_of_range)
    brier = ece = log_loss = 0.0
    for bucket in buckets:
        p = bucket.price_cents / 100.0
        losses = bucket.total_trades - bucket.wins
        brier += bucket.wins * (p - 1.0) ** 2 + losses * p ** 2
        ece += bucket.total_trades * abs(bucket.win_rate_pct / 100.0 - p)
        clipped = max(min(p, 1.0 - LOG_LOSS_EPSILON), LOG_LOSS_EPSILON)
        log_loss += bucket.wins * -math.log(clipped) + losses * -math.log(1.0 - clipped)
    return CalibrationReport(buckets, total_trades, round(brier / total_trades, 4),
                             round(log_loss / total_trades, 4), round(ece / total_trades, 4), out_of_range)


def kalshi_calibration(markets: Iterable[Mapping[str, Any]], trades: Iterable[Mapping[str, Any]]
                       ) -> CalibrationReport:
    """Calibration report for Kalshi rows, with the skipped-row count.

    ``markets`` is read fully before ``trades``. One map entry is held for each
    resolved market; trades stream through once and positions are not held.
    """
    skipped = SkippedRows()
    report = calibration_by_price(kalshi_positions(trades, kalshi_resolution(markets), skipped))
    return replace(report, skipped_rows=skipped.count)


def polymarket_calibration(markets: Iterable[Mapping[str, Any]], trades: Iterable[Mapping[str, Any]]
                           ) -> CalibrationReport:
    """Calibration report for Polymarket CTF rows, with the skipped-row count.

    ``markets`` is read fully before ``trades``. Two map entries are held for
    each resolved market; trades stream through once and positions are not held.
    """
    skipped = SkippedRows()
    report = calibration_by_price(polymarket_positions(trades, polymarket_token_resolution(markets), skipped))
    return replace(report, skipped_rows=skipped.count)
