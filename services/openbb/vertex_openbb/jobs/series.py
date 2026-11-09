"""Single-source series jobs: OECD CLI, keyless FRED CSV and Fama-French factors."""

from __future__ import annotations

import csv
import io
from datetime import date
from typing import Any

from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import iso_date, rounded
from .macro import point

FRED_SERIES: tuple[tuple[str, str], ...] = (
    ("HY_OAS", "BAMLH0A0HYM2"),
    ("IG_OAS", "BAMLC0A0CM"),
    ("T10Y3M", "T10Y3M"),
    ("T10Y2Y", "T10Y2Y"),
    ("RRP", "RRPONTSYD"),
    ("WALCL", "WALCL"),
    ("DTWEXBGS", "DTWEXBGS"),
    ("ICSA", "ICSA"),
    ("STLFSI4", "STLFSI4"),
)
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={fred_id}&cosd={start}"

# Fama-French datasets (Ken French data library, through OpenBB's famafrench helpers).
FF_DATASETS: tuple[tuple[str, str], ...] = (
    ("daily", "F-F_Research_Data_5_Factors_2x3_daily"),
    ("daily", "F-F_Momentum_Factor_daily"),
    ("monthly", "F-F_Research_Data_5_Factors_2x3"),
    ("monthly", "F-F_Momentum_Factor"),
)
FF_COLUMNS = {"mkt-rf": "mkt_rf", "smb": "smb", "hml": "hml", "rmw": "rmw", "cma": "cma", "rf": "rf", "mom": "mom"}


def _no_symbols(ctx: Context) -> None:
    if ctx.symbols is not None:
        raise ArgumentError(f"{ctx.job} takes no --symbols")


async def oecd_cli(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`economy/composite_leading_indicator` (oecd, United States, amplitude adjusted)."""
    _no_symbols(ctx)
    start = ctx.start(3 * 365)
    params = {"country": "united_states", "start_date": start.isoformat(), "end_date": ctx.today.isoformat()}
    rows = ctx.table("macro_points")
    first = start.isoformat()

    def build(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
        points = [point("OECD_CLI_USA", item.get("date"), item.get("value")) for item in data]
        return [r for r in points if r["value"] is not None and r["date"] and r["date"] >= first]

    try:
        data = await ctx.up.fetcher("oecd", "CompositeLeadingIndicator", params)
        ctx.take("oecd composite_leading_indicator", data, lambda: build(data), rows)
    except UpstreamError as exc:
        if exc.kind == "empty":
            ctx.ok()
            ctx.warn("oecd composite_leading_indicator: no data for the window")
        else:
            ctx.failed("oecd composite_leading_indicator", exc)
    return {"macro_points": rows}


def parse_fred_csv(series_id: str, text: str, first: str) -> list[dict[str, Any]]:
    """FRED fredgraph.csv: header `observation_date,<ID>` (older: `DATE,<ID>`); '.' marks a gap."""
    rows = []
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header or len(header) < 2:
        raise ValueError(f"unexpected fredgraph.csv header: {header!r}")
    for record in reader:
        if len(record) < 2:
            continue
        day = iso_date(record[0])
        row = point(series_id, day, record[1])
        if day and day >= first and row["value"] is not None:
            rows.append(row)
    return rows


async def fred_keyless(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """Keyless FRED observations (fredgraph.csv; OpenBB's fred provider needs an API key)."""
    _no_symbols(ctx)
    start = ctx.start(400)
    rows = ctx.table("macro_points")
    for series_id, fred_id in FRED_SERIES:
        url = FRED_CSV.format(fred_id=fred_id, start=start.isoformat())
        try:
            text = await ctx.up.http_text(url)
        except UpstreamError as exc:
            ctx.failed(f"fred {fred_id}", exc)
            continue
        if text is None:
            ctx.failed(f"fred {fred_id}", UpstreamError("not_found", "fredgraph.csv answered 404"))
            continue
        ctx.take(f"fred {fred_id}", text.splitlines()[1:], lambda t=text, s=series_id: parse_fred_csv(s, t, start.isoformat()), rows)
    return {"macro_points": rows}


def _ff_table(dataset: str, frequency: str) -> list[dict[str, Any]]:
    """Read one Ken French file with OpenBB's famafrench helpers.

    The provider's FamaFrenchFactors fetcher drops the daily tables at this pin (the daily file's
    table is labelled monthly), so the helpers are used directly and the frequency comes from the
    dataset name.
    """
    from openbb_famafrench.utils.helpers import download_file, process_csv_tables, read_csv_file

    tables, description = read_csv_file(download_file(dataset))
    frames, metadata = process_csv_tables(tables, description)
    chosen = None
    for frame, meta in zip(frames, metadata, strict=False):
        label = str(meta.get("frequency", "")).lower()
        if frequency == "daily" or label == "monthly":
            chosen = frame
            break
    if chosen is None:
        return []
    out = []
    for index, values in chosen.iterrows():
        row = {"date": str(index)[:10]}
        row.update({str(k): v for k, v in values.items()})
        out.append(row)
    return out


def factor_rows(frequency: str, table: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in table:
        day = iso_date(item.get("date"))
        if day is None or day < first:
            continue
        if frequency == "monthly":
            day = day[:8] + "01"
        for column, value in item.items():
            factor = FF_COLUMNS.get(column.strip().lower())
            if factor is None:
                continue
            number = rounded(value, 6)
            if number is not None:
                rows.append({"date": day, "factor": factor, "frequency": frequency, "value": number})
    return rows


async def famafrench(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """Daily and monthly Fama-French 5 factors + momentum (percent) -> factor_returns."""
    _no_symbols(ctx)
    start: date = ctx.start(120)
    first = start.isoformat()
    month_first = first[:8] + "01"
    rows = ctx.table("factor_returns")
    for frequency, dataset in FF_DATASETS:
        try:
            table = await ctx.up.helper(f"famafrench:{dataset}:{frequency}", lambda d=dataset, f=frequency: _ff_table(d, f))
        except UpstreamError as exc:
            ctx.failed(f"famafrench {dataset}", exc)
            continue
        if not table:
            ctx.ok()
            ctx.warn(f"famafrench {dataset}: no {frequency} table")
            continue
        cutoff = first if frequency == "daily" else month_first
        ctx.take(f"famafrench {dataset}", table, lambda t=table, f=frequency, c=cutoff: factor_rows(f, t, c), rows)
    return {"factor_returns": rows}
