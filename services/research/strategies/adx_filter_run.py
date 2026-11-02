"""Run the frozen ADX filter study (docs/specs/research/adx-filter.md) and write a JSON report.

Research only: reads local CSV files, writes a local JSON file, places no orders.

Usage (from services/research):
  python -m strategies.adx_filter_run --data ~/Documents/reports/vertex-adx/data --out results.json
The data folder holds <SYMBOL>.csv (date,open,high,low,close,adj_close,volume) and manifest.json.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import asdict
from pathlib import Path

from strategies.adx_filter import (
    TRADING_DAYS,
    VARIANTS,
    Bars,
    Metrics,
    Trade,
    Variant,
    adjusted_bars,
    deflated_sharpe,
    metrics,
    moments,
    run_symbol,
    sleeve_returns,
    verdict,
)

UNIVERSE = ("SPY", "QQQ", "IWM", "SOXX", "AAPL", "MSFT", "AMZN", "GOOGL", "JPM", "XOM", "JNJ", "PG", "WMT", "HD")
WINDOW_START = "2005-01-03"
WINDOW_END = "2026-10-30"


def load(folder: Path) -> tuple[dict[str, Bars], dict[str, list[str]]]:
    bars: dict[str, Bars] = {}
    dropped: dict[str, list[str]] = {}
    for symbol in UNIVERSE:
        with (folder / f"{symbol}.csv").open(newline="") as handle:
            rows = [row for row in csv.DictReader(handle) if row["date"] <= WINDOW_END]
        bars[symbol], dropped[symbol] = adjusted_bars(rows)
    return bars, dropped


def evaluate(bars: dict[str, Bars], variant: Variant) -> dict:
    """Trades, sleeve returns and portfolio returns of one variant over the window."""
    calendar = sorted({day for series in bars.values() for day in series.dates if day >= WINDOW_START})
    totals = dict.fromkeys(calendar, 0.0)
    trades_by_symbol: dict[str, list[Trade]] = {}
    per_symbol: dict[str, dict] = {}
    for symbol, series in bars.items():
        start = next((index for index, day in enumerate(series.dates) if day >= WINDOW_START), len(series.dates))
        trades = run_symbol(series, variant, start)
        returns = sleeve_returns(series, trades)
        for day, value in zip(series.dates[start:], returns[start:], strict=True):
            totals[day] += value
        trades_by_symbol[symbol] = trades
        own = metrics(returns[start:], len(trades))
        per_symbol[symbol] = {"sharpe": own.sharpe, "trades": own.trades}
    portfolio = [totals[day] / len(bars) for day in calendar]
    return {"calendar": calendar, "portfolio": portfolio, "trades": trades_by_symbol, "per_symbol": per_symbol}


def entry_days(bars: dict[str, Bars], trades: dict[str, list[Trade]]) -> list[str]:
    return [bars[symbol].dates[trade.entry_index] for symbol, items in trades.items() for trade in items]


def halves(calendar: list[str]) -> tuple[slice, slice, str]:
    middle = math.ceil(len(calendar) / 2)
    return slice(0, middle), slice(middle, len(calendar)), calendar[middle]


def summarize(bars: dict[str, Bars], variant: Variant, run: dict) -> dict:
    calendar, portfolio = run["calendar"], run["portfolio"]
    first, second, split = halves(calendar)
    entries = entry_days(bars, run["trades"])
    years = len(calendar) / TRADING_DAYS
    full = metrics(portfolio, len(entries))
    half_metrics = [
        metrics(portfolio[first], sum(day < split for day in entries)),
        metrics(portfolio[second], sum(day >= split for day in entries)),
    ]
    return {
        "strategy": variant.strategy,
        "filter": variant.filter,
        "full": asdict(full),
        "halves": [asdict(item) for item in half_metrics],
        "tradesPerYear": len(entries) / years,
        "perSymbol": run["per_symbol"],
        "exitReasons": _reasons(run["trades"]),
    }


def _reasons(trades: dict[str, list[Trade]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for items in trades.values():
        for trade in items:
            counts[trade.reason] = counts.get(trade.reason, 0) + 1
    return dict(sorted(counts.items()))


def study(bars: dict[str, Bars]) -> dict:
    runs = {variant: evaluate(bars, variant) for variant in VARIANTS}
    rows = {variant: summarize(bars, variant, run) for variant, run in runs.items()}
    stats = {variant: moments(run["portfolio"]) for variant, run in runs.items()}
    daily_sharpes = [stat[0] for stat in stats.values() if stat is not None]
    mean_sharpe = math.fsum(daily_sharpes) / len(daily_sharpes)
    variance = math.fsum((value - mean_sharpe) ** 2 for value in daily_sharpes) / (len(daily_sharpes) - 1)
    for variant, stat in stats.items():
        observations = len(runs[variant]["portfolio"])
        if stat is None:  # no trades or no spread: nothing to deflate
            rows[variant]["deflated"] = None
            continue
        sharpe, skew, kurtosis = stat
        rows[variant]["deflated"] = {
            "dailySharpe": sharpe,
            "skew": skew,
            "kurtosis": kurtosis,
            "observations": observations,
            "probability": deflated_sharpe(sharpe, len(VARIANTS), variance, observations, skew, kurtosis),
        }
    decisions = []
    for variant in VARIANTS:
        if variant.filter == "none":
            continue
        base = rows[Variant(variant.strategy, "none")]
        row = rows[variant]
        decisions.append({
            "strategy": variant.strategy,
            "filter": variant.filter,
            "verdict": verdict(
                [Metrics(**item) for item in base["halves"]],
                [Metrics(**item) for item in row["halves"]],
                row["tradesPerYear"],
                base["tradesPerYear"],
                None if row["deflated"] is None else row["deflated"]["probability"],
            ),
        })
    calendar = runs[VARIANTS[0]]["calendar"]
    _, _, split = halves(calendar)
    return {
        "window": {"start": calendar[0], "end": calendar[-1], "days": len(calendar), "secondHalfStart": split},
        "trials": len(VARIANTS),
        "sharpeVarianceDaily": variance,
        "variants": list(rows.values()),
        "decisions": decisions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    folder = Path(args.data).expanduser()
    bars, dropped = load(folder)
    result = study(bars)
    manifest_path = folder / "manifest.json"
    result["data"] = {
        "manifest": json.loads(manifest_path.read_text()) if manifest_path.exists() else None,
        "droppedBars": {symbol: days for symbol, days in dropped.items() if days},
        "universe": list(UNIVERSE),
    }
    Path(args.out).expanduser().write_text(json.dumps(result, indent=1))
    for decision in result["decisions"]:
        print(decision["strategy"], decision["filter"], decision["verdict"])


if __name__ == "__main__":
    main()
