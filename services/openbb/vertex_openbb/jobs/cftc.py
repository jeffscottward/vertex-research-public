"""CFTC Commitments of Traders (`cftc/cot`, futures only, positions) -> cot_positions."""

from __future__ import annotations

from typing import Any

from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import count, iso_date

# market, CFTC contract market code, report type (docs/vertex-rebuild/openbb.md).
MARKETS: tuple[tuple[str, str, str], ...] = (
    ("ES", "13874A", "tff"),
    ("NQ", "209742", "tff"),
    ("YM", "124603", "tff"),
    ("RTY", "239742", "tff"),
    ("VX", "1170E1", "tff"),
    ("ZN", "043602", "tff"),
    ("DX", "098662", "tff"),
    ("GC", "088691", "disaggregated"),
    ("SI", "084691", "disaggregated"),
    ("CL", "067651", "disaggregated"),
)
# OpenBB report_type per Vertex report type.
OPENBB_REPORT = {"tff": "financial", "disaggregated": "disaggregated"}
# category -> OpenBB column prefix (columns are <prefix>_long[_all], _short[_all], _spread[_all]).
CATEGORIES: dict[str, tuple[tuple[str, str], ...]] = {
    "tff": (
        ("dealer", "dealer_positions"),
        ("asset_manager", "asset_manager_positions"),
        ("leveraged_funds", "leveraged_funds_positions"),
        ("other_reportables", "other_reportable_positions"),
        ("nonreportable", "non_reportable_positions"),
    ),
    "disaggregated": (
        ("producer_merchant", "producer_merchant_positions"),
        ("swap_dealer", "swap_positions"),
        ("managed_money", "managed_money_positions"),
        ("other_reportables", "other_reportable_positions"),
        ("nonreportable", "non_reportable_positions"),
    ),
}


def _column(item: dict[str, Any], prefix: str, side: str) -> int | None:
    for key in (f"{prefix}_{side}_all", f"{prefix}_{side}"):
        if key in item:
            return count(item.get(key))
    return None


def transform(market: str, code: str, report_type: str, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        report_date = iso_date(item.get("date"))
        open_interest = count(item.get("open_interest_all", item.get("open_interest")))
        for category, prefix in CATEGORIES[report_type]:
            long = _column(item, prefix, "long")
            short = _column(item, prefix, "short")
            if long is None and short is None:
                continue
            rows.append(
                {
                    "category": category,
                    "long": long,
                    "market": market,
                    "marketCode": code,
                    "openInterest": open_interest,
                    "reportDate": report_date,
                    "reportType": report_type,
                    "short": short,
                    "spreading": _column(item, prefix, "spread"),
                }
            )
    return rows


async def cot(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    if ctx.symbols is not None:
        markets = [m for m in MARKETS if m[0] in ctx.symbols]
        unknown = sorted(set(ctx.symbols) - {m[0] for m in MARKETS})
        if unknown:
            raise ArgumentError(f"--symbols for cftc-cot must be COT markets ({', '.join(m[0] for m in MARKETS)})")
    else:
        markets = list(MARKETS)
    start = ctx.start(56)
    rows = ctx.table("cot_positions")
    for market, code, report_type in markets:
        params = {
            "code": code,
            "start_date": start.isoformat(),
            "end_date": ctx.today.isoformat(),
            "report_type": OPENBB_REPORT[report_type],
            "measure": "positions",
            "futures_only": True,
        }
        try:
            data = await ctx.up.fetcher("cftc", "CftcCot", params)
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                ctx.warn(f"cftc {market}: no reports since {start.isoformat()}")
                continue
            ctx.failed(f"cftc {market}", exc)
            continue
        ctx.take(f"cftc {market}", data, lambda m=market, c=code, r=report_type, d=data: transform(m, c, r, d), rows)
    return {"cot_positions": rows}
