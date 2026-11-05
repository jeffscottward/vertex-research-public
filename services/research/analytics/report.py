"""Core 7 risk analytics report (research only).

Builds one table of rolling risk statistics for the Core 7 futures and their
ETF twins from local daily CSV files, through the SeriesAnalytics port. The
report is display and research data. It creates, routes and simulates no order
and grants no trading authority.

Data: one ``<SYMBOL>.csv`` per member with the columns of
research/backtests/core7/fetch_data.py (date, open, high, low, close,
adj_close, volume). The data is not in the repository (Yahoo terms); the fetch
writes it to ~/Documents/reports/vertex-core7/data/daily on the rig. Rows with
a non-positive price in any of open, high, low, close or adjusted close (CL=F on
2020-04-20 and 2020-04-21) are dropped, as in fetch_data.py.
"""
from __future__ import annotations

import csv
import html
import math
from collections.abc import Sequence
from pathlib import Path

from .ports import SeriesAnalytics

# Same members and order as CORE7_MARKETS in packages/shared/src/universes/index.ts.
CORE7 = (
    ("S&P 500", "ES=F", "SPY"),
    ("Nasdaq-100", "NQ=F", "QQQ"),
    ("Dow 30", "YM=F", "DIA"),
    ("Russell 2000", "RTY=F", "IWM"),
    ("Gold", "GC=F", "GLD"),
    ("Silver", "SI=F", "SLV"),
    ("WTI crude oil", "CL=F", "USO"),
)
FUTURES_BENCHMARK = "ES=F"
ETF_BENCHMARK = "SPY"
SHORT_WINDOW = 20
LONG_WINDOW = 60
ZSCORE_WINDOW = 50
DRAWDOWN_WINDOW = 252
EXP_BETA = 0.94  # RiskMetrics daily decay; gs-quant's default is 0.75
SPARK_POINTS = 252
COLUMNS = (
    ("vol20", "Vol 20d %", "Annualized realized volatility of simple returns, 20 returns."),
    ("vol60", "Vol 60d %", "Annualized realized volatility of simple returns, 60 returns."),
    ("ewvol", "EW vol %", "Exponentially weighted volatility, decay 0.94."),
    ("z50", "Z 50d", "Z-score of the close against the last 50 closes."),
    ("dd1y", "Max DD 1y %", "Worst peak-to-trough fall in the last 252 bars."),
    ("ddall", "Max DD all %", "Worst peak-to-trough fall since the first bar."),
    ("beta60", "Beta 60d", "Beta of daily returns to the benchmark (ES=F for futures, SPY for ETFs)."),
    ("corr60", "Corr 60d", "Correlation of daily returns with the benchmark."),
    ("twin60", "Twin corr 60d", "Correlation of the future with its ETF twin (roll gaps lower it)."),
)


def load_daily_csv(path: Path) -> tuple[list[str], list[float]]:
    """Dates and adjusted closes of one Core 7 CSV, chronological, rows with a non-positive price dropped."""
    dates: list[str] = []
    closes: list[float] = []
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                prices = [float(row[key]) for key in ("open", "high", "low", "close", "adj_close")]
            except (KeyError, TypeError, ValueError):
                continue
            if all(math.isfinite(price) and price > 0 for price in prices):
                dates.append(row["date"][:10])
                closes.append(prices[-1])
    pairs = sorted(dict(zip(dates, closes)).items())
    return [day for day, _ in pairs], [value for _, value in pairs]


def load_core7(directory: Path) -> dict[str, tuple[list[str], list[float]]]:
    """Every Core 7 member that has a CSV in ``directory``."""
    out = {}
    for _, future, twin in CORE7:
        for symbol in (future, twin):
            path = directory / f"{symbol}.csv"
            if path.is_file():
                out[symbol] = load_daily_csv(path)
    return out


def _last(values: Sequence[float | None]) -> float | None:
    for value in reversed(values):
        if value is not None:
            return value
    return None


def _scaled(value: float | None, factor: float) -> float | None:
    return None if value is None else value * factor


def _row(analytics: SeriesAnalytics, symbol: str, series: dict, benchmark: str, twin: str | None) -> dict:
    dates, closes = series[symbol]
    vol20 = analytics.realized_volatility(dates, closes, SHORT_WINDOW)
    row = {
        "symbol": symbol,
        "last_date": dates[-1],
        "last_close": closes[-1],
        "bars": len(dates),
        "vol20": _last(vol20),
        "vol60": _last(analytics.realized_volatility(dates, closes, LONG_WINDOW)),
        "ewvol": _last(analytics.exponential_volatility(dates, closes, EXP_BETA)),
        "z50": _last(analytics.zscore(dates, closes, ZSCORE_WINDOW)),
        "dd1y": _scaled(_last(analytics.max_drawdown(dates, closes, DRAWDOWN_WINDOW)), 100),
        "ddall": _scaled(_last(analytics.max_drawdown(dates, closes, None)), 100),
        "beta60": None,
        "corr60": None,
        "twin60": None,
        "spark": [value for value in vol20[-SPARK_POINTS:]],
    }
    if symbol != benchmark and benchmark in series:
        bench_dates, bench_closes = series[benchmark]
        row["beta60"] = _last(analytics.beta(dates, closes, bench_dates, bench_closes, LONG_WINDOW))
        row["corr60"] = _last(analytics.correlation(dates, closes, bench_dates, bench_closes, LONG_WINDOW))
    if twin is not None and twin in series:
        twin_dates, twin_closes = series[twin]
        row["twin60"] = _last(analytics.correlation(dates, closes, twin_dates, twin_closes, LONG_WINDOW))
    return row


def build_report(series: dict[str, tuple[list[str], list[float]]], analytics: SeriesAnalytics) -> dict:
    """Report record: one futures row and one ETF row per Core 7 market that has data."""
    markets = []
    for market, future, twin in CORE7:
        markets.append({
            "market": market,
            "future": _row(analytics, future, series, FUTURES_BENCHMARK, twin) if future in series else None,
            "etf": _row(analytics, twin, series, ETF_BENCHMARK, None) if twin in series else None,
        })
    return {
        "title": "Core 7 risk analytics",
        "engine": analytics.engine_id,
        "windows": {"short": SHORT_WINDOW, "long": LONG_WINDOW, "zscore": ZSCORE_WINDOW,
                    "drawdown": DRAWDOWN_WINDOW, "ew_beta": EXP_BETA},
        "columns": [{"key": key, "label": label, "help": text} for key, label, text in COLUMNS],
        "markets": markets,
        "missing": [symbol for _, future, twin in CORE7 for symbol in (future, twin) if symbol not in series],
    }


def _fmt(value: float | None, digits: int) -> str:
    return "n/a" if value is None else f"{value:,.{digits}f}"


def _spark(values: Sequence[float | None]) -> str:
    points = [(index, value) for index, value in enumerate(values) if value is not None]
    if len(points) < 2:
        return '<span class="muted">n/a</span>'
    low = min(value for _, value in points)
    high = max(value for _, value in points)
    span = (high - low) or 1.0
    width, height = 120, 28
    last = max(len(values) - 1, 1)
    path = " ".join(f"{index * width / last:.1f},{height - 2 - (value - low) * (height - 4) / span:.1f}"
                    for index, value in points)
    label = f"20-day volatility, last {len(values)} bars, range {low:.1f} to {high:.1f} percent"
    return (f'<svg class="spark" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" '
            f'aria-label="{html.escape(label)}"><polyline points="{path}" fill="none" stroke="currentColor" '
            'stroke-width="1.5"/></svg>')


DIGITS = {"vol20": 1, "vol60": 1, "ewvol": 1, "z50": 2, "dd1y": 1, "ddall": 1, "beta60": 2, "corr60": 2, "twin60": 2}

STYLE = """
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1c1c1e;--muted:#5f6368;--line:#d9d9d6;--gold:#9a7b1c;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececec;--muted:#a1a1a6;--line:#2c2c30;--gold:#d4b25a;--card:#1c1c1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Public Sans",system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1,h2{font-family:Manrope,"Public Sans",system-ui,sans-serif;margin:0 0 8px}
h1{font-size:26px}h1 span{color:var(--gold)}h2{font-size:18px;margin:24px 0 8px}
p{margin:0 0 12px;color:var(--muted)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:1040px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-weight:600;font-size:13px;color:var(--muted)}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
tr.market td{background:transparent;font-weight:600;color:var(--gold);text-align:left;border-bottom:0;padding-top:14px}
.spark{color:var(--gold);vertical-align:middle}
.muted{color:var(--muted)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0}
dt{font-weight:600}dd{margin:0;color:var(--muted)}
"""


def render_html(report: dict) -> str:
    """Static, self-contained HTML page for the report (no script, no external request)."""
    columns = report["columns"]
    head = "".join(f'<th scope="col" title="{html.escape(c["help"])}">{html.escape(c["label"])}</th>'
                   for c in columns)
    rows = []
    for market in report["markets"]:
        rows.append(f'<tr class="market"><td colspan="{len(columns) + 4}">{html.escape(market["market"])}</td></tr>')
        for kind in ("future", "etf"):
            row = market[kind]
            if row is None:
                continue
            cells = "".join(f"<td>{_fmt(row[c['key']], DIGITS[c['key']])}</td>" for c in columns)
            rows.append(f'<tr><th scope="row">{html.escape(row["symbol"])}</th><td>{html.escape(row["last_date"])}</td>'
                        f'<td>{_fmt(row["last_close"], 2)}</td>{cells}<td>{_spark(row["spark"])}</td></tr>')
    windows = report["windows"]
    legend = "".join(f"<dt>{html.escape(c['label'])}</dt><dd>{html.escape(c['help'])}</dd>" for c in columns)
    missing = report["missing"]
    missing_note = f"<p>No data for: {html.escape(', '.join(missing))}.</p>" if missing else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(report["title"])} | Vertex research</title><style>{STYLE}</style></head>
<body><main>
<h1>Vertex research: <span>{html.escape(report["title"])}</span></h1>
<p>Rolling risk statistics for the Core 7 futures and their ETF twins, computed offline with
{html.escape(report["engine"])} (gs_quant.timeseries, no Marquee access). Daily adjusted closes from the local
Core 7 data set. Research data only: no order, signal or trading authority.</p>
{missing_note}
<div class="wrap"><table>
<thead><tr><th scope="col">Symbol</th><th scope="col">Last date</th><th scope="col">Last close</th>{head}
<th scope="col">Vol 20d, last {SPARK_POINTS} bars</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table></div>
<h2>Columns</h2><dl>{legend}</dl>
<p>Windows: volatility {windows["short"]} and {windows["long"]} returns, z-score {windows["zscore"]} closes,
drawdown {windows["drawdown"]} bars, exponential decay {windows["ew_beta"]}. Futures are continuous front-month Yahoo
series that are not back-adjusted, so roll gaps count as returns.</p>
</main></body></html>
"""
