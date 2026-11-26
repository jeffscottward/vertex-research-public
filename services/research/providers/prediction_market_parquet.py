"""DuckDB Parquet reader for Polymarket rows, and calibration from local Parquet files.

Research only. Reads local Parquet files with DuckDB (optional extra
``prediction``; lock requirements-prediction-linux-py312.lock) and streams the
rows to the in-memory calibration of ``providers.prediction_markets``, so both
paths give the same report for the same rows (tests/test_prediction_market_parquet.py).
The files stay on the local disk and outside version control; this module does
not download data, contact a venue, read an account or place orders.
Design: docs/vertex-rebuild/prediction-market-onchain-sample.md.

Command line (prints the report as text)::

    python -m providers.prediction_market_parquet --markets M.parquet --trades T.parquet \
        [--maker-rows-only] [--horizon-blocks N] [--bootstrap DRAWS]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from providers.polymarket_chain import is_maker_order_row
from providers.prediction_markets import (
    CalibrationReport,
    SkippedRows,
    calibration_by_price,
    polymarket_positions,
    polymarket_token_resolution,
    report_from_totals,
)

BATCH_ROWS = 10_000
MARKET_COLUMNS = ("closed", "outcome_prices", "clob_token_ids")
MARKET_KEY_COLUMNS = ("condition_id", "clob_token_ids", "block_number")
TRADE_COLUMNS = ("maker_asset_id", "taker_asset_id", "maker_amount", "taker_amount")
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def iter_parquet_rows(path: str | Path, columns: Sequence[str], batch_rows: int = BATCH_ROWS
                      ) -> Iterator[dict[str, Any]]:
    """Rows of one Parquet file (or DuckDB glob) as dicts of the named columns, in batches.

    Column names must be plain identifiers; the path is passed as a bound
    parameter. ``ValueError`` for a bad column name or batch size.
    """
    if not columns or not all(_IDENTIFIER.match(column) for column in columns):
        raise ValueError("columns must be plain identifiers")
    if batch_rows <= 0:
        raise ValueError("batch_rows must be positive")
    import duckdb  # Optional extra "prediction"; imported only here.

    names = tuple(columns)
    select = ", ".join(f'"{column}"' for column in names)
    with duckdb.connect() as connection:
        cursor = connection.execute(f"SELECT {select} FROM read_parquet(?)", [str(path)])
        while batch := cursor.fetchmany(batch_rows):
            for values in batch:
                yield dict(zip(names, values, strict=True))


@dataclass(frozen=True)
class TokenMarket:
    """The market of one outcome token: its condition id and resolution block."""

    condition_id: str
    resolved_block: int


def token_markets(markets: str | Path) -> dict[str, TokenMarket]:
    """``token id -> TokenMarket`` from the market rows that list two token ids; other rows are left out."""
    found: dict[str, TokenMarket] = {}
    for row in iter_parquet_rows(markets, MARKET_KEY_COLUMNS):
        try:
            tokens = json.loads(row["clob_token_ids"])
            market = TokenMarket(str(row["condition_id"]), int(row["block_number"]))
        except (TypeError, ValueError):
            continue
        if isinstance(tokens, list) and len(tokens) == 2:
            found.update({str(token): market for token in tokens})
    return found


def _trade_token(row: Mapping[str, Any]) -> str:
    """The outcome token of a trade row: the asset that is not collateral (``"0"``)."""
    maker = str(row.get("maker_asset_id"))
    return str(row.get("taker_asset_id")) if maker == "0" else maker


@dataclass
class TradeCounts:
    """Trade rows read and dropped before the join (mutable, filled while rows stream)."""

    read: int = 0
    maker_dropped: int = 0
    horizon_dropped: int = 0


def _trade_rows(trades: str | Path, maker_rows_only: bool, horizon_blocks: int | None,
                markets: Mapping[str, TokenMarket], counts: TradeCounts | None = None) -> Iterator[dict[str, Any]]:
    counts = counts if counts is not None else TradeCounts()
    extra = (("taker",) if maker_rows_only else ()) + (("block_number",) if horizon_blocks is not None else ())
    for row in iter_parquet_rows(trades, TRADE_COLUMNS + extra):
        counts.read += 1
        if maker_rows_only and not is_maker_order_row(row):
            counts.maker_dropped += 1
            continue
        if horizon_blocks is not None:
            market = markets.get(_trade_token(row))
            try:
                wait = None if market is None else market.resolved_block - int(row["block_number"])
            except (TypeError, ValueError):
                wait = None
            if wait is None or not 0 <= wait <= horizon_blocks:
                counts.horizon_dropped += 1
                continue
        yield row


def polymarket_calibration_from_parquet(markets: str | Path, trades: str | Path, maker_rows_only: bool = False,
                                        horizon_blocks: int | None = None, counts: TradeCounts | None = None
                                        ) -> CalibrationReport:
    """Polymarket report from local Parquet files.

    ``maker_rows_only`` leaves out the aggregate taker rows (whose ``taker`` is
    an exchange contract), so each matched trade counts once from the maker
    side. ``horizon_blocks`` keeps only fills whose token resolved within that
    many blocks after the fill block, so every fill had the same time to
    resolve; the market rows then need ``condition_id`` and ``block_number``
    and the trade rows ``block_number``. ``counts`` (when given) receives the
    rows read and the rows each filter dropped.
    """
    token_won = polymarket_token_resolution(iter_parquet_rows(markets, MARKET_COLUMNS))
    keyed = token_markets(markets) if horizon_blocks is not None else {}
    skipped = SkippedRows()
    rows = _trade_rows(trades, maker_rows_only, horizon_blocks, keyed, counts)
    report = calibration_by_price(polymarket_positions(rows, token_won, skipped))
    return replace(report, skipped_rows=skipped.count)


@dataclass(frozen=True)
class Interval:
    low: float | None
    high: float | None


@dataclass(frozen=True)
class Bootstrap:
    """Percentile intervals (2.5 % and 97.5 %) of the scores when whole markets are resampled."""

    conditions: int
    draws: int
    brier: Interval
    log_loss: Interval
    ece: Interval


def _percentiles(values: list[float]) -> Interval:
    if not values:
        return Interval(None, None)
    ordered = sorted(values)
    pick = lambda q: ordered[min(len(ordered) - 1, int(q * len(ordered)))]  # noqa: E731
    return Interval(pick(0.025), pick(0.975))


def condition_bootstrap(markets: str | Path, trades: str | Path, draws: int = 200, seed: int = 0,
                        maker_rows_only: bool = False, horizon_blocks: int | None = None) -> Bootstrap:
    """Resample conditions (markets) with replacement and recompute the scores.

    Fills of one market share one outcome, so they are not independent; the
    interval from resampling markets is wider than one from resampling fills.
    """
    if draws <= 0:
        raise ValueError("draws must be positive")
    token_won = polymarket_token_resolution(iter_parquet_rows(markets, MARKET_COLUMNS))
    keyed = token_markets(markets)
    per_condition: dict[str, Counter[tuple[int, bool]]] = {}
    for row in _trade_rows(trades, maker_rows_only, horizon_blocks, keyed):
        market = keyed.get(_trade_token(row))
        if market is None:
            continue
        for position in polymarket_positions([row], token_won):
            if 1 <= position.price_cents <= 99:
                per_condition.setdefault(market.condition_id, Counter())[(position.price_cents, position.won)] += 1
    counts = list(per_condition.values())
    rng = random.Random(seed)
    scores: dict[str, list[float]] = {"brier": [], "log_loss": [], "ece": []}
    for _ in range(draws if counts else 0):
        totals: dict[int, list[int]] = {}
        for sample in rng.choices(counts, k=len(counts)):
            for (price, won), n in sample.items():
                bucket = totals.setdefault(price, [0, 0])
                bucket[0] += n
                bucket[1] += n if won else 0
        report = report_from_totals({p: (t, w) for p, (t, w) in totals.items()})
        for name in scores:
            value = getattr(report, "brier_score" if name == "brier" else name)
            if value is not None:
                scores[name].append(value)
    return Bootstrap(len(counts), draws, _percentiles(scores["brier"]), _percentiles(scores["log_loss"]),
                     _percentiles(scores["ece"]))


def format_report(report: CalibrationReport, bootstrap: Bootstrap | None = None,
                  counts: TradeCounts | None = None) -> str:
    """Plain-text report: row counts, totals, scores and win rate by 10-cent band."""
    lines: list[str] = []
    if counts is not None:
        joined = (report.total_trades + report.out_of_range_positions) // 2  # two positions per joined row
        not_joined = (counts.read - counts.maker_dropped - counts.horizon_dropped - report.skipped_rows - joined)
        lines += [
            f"trade rows read: {counts.read}",
            f"dropped by the maker-row filter: {counts.maker_dropped}",
            f"dropped by the horizon (no market, or resolved before the fill or later than H): {counts.horizon_dropped}",
            f"not joined to a clear winner (unknown token or split payout): {not_joined}",
            f"joined rows: {joined}",
        ]
    lines += [
        f"positions in 1..99 cents: {report.total_trades}",
        f"positions out of range: {report.out_of_range_positions}",
        f"skipped rows: {report.skipped_rows}",
        f"brier: {report.brier_score}  log loss: {report.log_loss}  ece: {report.ece}",
    ]
    if bootstrap is not None:
        lines.append(f"conditions: {bootstrap.conditions}  bootstrap draws: {bootstrap.draws}")
        for name in ("brier", "log_loss", "ece"):
            interval: Interval = getattr(bootstrap, name)
            lines.append(f"{name} 95% interval (by condition): {interval.low} .. {interval.high}")
    lines.append("band (cents) | positions | win rate %")
    for low in range(1, 100, 10):
        high = min(low + 9, 99)
        band = [b for b in report.buckets if low <= b.price_cents <= high]
        total = sum(b.total_trades for b in band)
        rate = "n/a" if total == 0 else f"{100.0 * sum(b.wins for b in band) / total:.2f}"
        lines.append(f"{low:>2}-{high:<2} | {total} | {rate}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None, out: Callable[[str], object] = print) -> int:
    parser = argparse.ArgumentParser(prog="python -m providers.prediction_market_parquet")
    parser.add_argument("--markets", required=True)
    parser.add_argument("--trades", required=True)
    parser.add_argument("--maker-rows-only", action="store_true")
    parser.add_argument("--horizon-blocks", type=int)
    parser.add_argument("--bootstrap", type=int, default=0, help="draws; 0 = no bootstrap")
    args = parser.parse_args(argv)
    counts = TradeCounts()
    report = polymarket_calibration_from_parquet(args.markets, args.trades, args.maker_rows_only, args.horizon_blocks,
                                                 counts)
    bootstrap = (condition_bootstrap(args.markets, args.trades, args.bootstrap, 0, args.maker_rows_only,
                                     args.horizon_blocks) if args.bootstrap > 0 else None)
    out(format_report(report, bootstrap, counts))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
