"""Row shapes of every ingest table (mirror of packages/api/src/contracts/openbb.ts).

`row_problem` applies the same rules as the Zod row schemas (strict keys, finite numbers,
non-negative safe-integer counts, real calendar dates, whole-string id patterns, string lengths in
UTF-16 code units). The fetcher drops a row that fails
and reports how many it dropped, so the document it prints always passes the contract.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from datetime import date
from typing import Any

from .values import utf16_len

VOL_INDEX_IDS = (
    "VIX", "VIX1D", "VIX9D", "VIX3M", "VIX6M", "VIX1Y", "VVIX",
    "SKEW", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV",
)
COT_CATEGORIES = (
    "dealer", "asset_manager", "leveraged_funds", "producer_merchant",
    "swap_dealer", "managed_money", "other_reportables", "nonreportable",
)
FACTORS = ("mkt_rf", "smb", "hml", "rmw", "cma", "rf", "mom")

# JavaScript Number.MAX_SAFE_INTEGER: Zod 4 `.int()` accepts only safe integers.
MAX_SAFE_INTEGER = 2**53 - 1
_DATE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$", re.ASCII)
SYMBOL = re.compile(r"^[A-Z0-9.^=-]{1,16}$", re.ASCII)
_ACCESSION = re.compile(r"^\d{10}-\d{2}-\d{6}$", re.ASCII)
_CUSIP = re.compile(r"^[0-9A-Z]{9}$", re.ASCII)
_CIK = re.compile(r"^\d{1,10}$", re.ASCII)
_MACRO_ID = re.compile(r"^[A-Z0-9_]{1,40}$", re.ASCII)
_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$", re.ASCII)
_KIND = re.compile(r"^[a-z0-9_]{1,40}$", re.ASCII)
_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$", re.ASCII)
_MARKET = re.compile(r"^[A-Z0-9]{1,8}$", re.ASCII)
_MARKET_CODE = re.compile(r"^[0-9A-Z]{1,12}$", re.ASCII)


class Field:
    """One column rule: kind plus nullability and options."""

    def __init__(self, kind: str, nullable: bool = False, **options: Any) -> None:
        self.kind = kind
        self.nullable = nullable
        self.options = options

    def check(self, value: Any) -> bool:  # noqa: PLR0911 - one branch per kind
        if value is None:
            return self.nullable
        kind = self.kind
        if kind == "date":
            return isinstance(value, str) and _real_date(value)
        if kind == "finite":
            if not _finite(value):
                return False
            low, high = self.options.get("min"), self.options.get("max")
            if self.options.get("positive") and not value > 0:
                return False
            if self.options.get("nonnegative") and value < 0:
                return False
            return (low is None or value >= low) and (high is None or value <= high)
        if kind == "count":
            return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INTEGER
        if kind == "regex":
            return isinstance(value, str) and bool(self.options["pattern"].fullmatch(value))
        if kind == "enum":
            return value in self.options["values"]
        if kind == "label":
            # Zod: utf16Text(max).trim().min(1): the untrimmed value is at most `max` UTF-16 units
            # and the value trimmed of JavaScript whitespace is not empty.
            return isinstance(value, str) and utf16_len(value) <= self.options["max"] and bool(value.strip(JS_WHITESPACE))
        if kind == "text":
            return isinstance(value, str) and utf16_len(value) <= self.options["max"]
        if kind == "https":
            return isinstance(value, str) and value.startswith("https://") and utf16_len(value) <= 2000
        raise ValueError(f"unknown field kind {kind}")


def _finite(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # int beyond the float range
        return False


def _real_date(value: str) -> bool:
    if not _DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


# Characters JavaScript's String.prototype.trim removes (WhiteSpace + LineTerminator).
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

D = Field("date")
D_NULL = Field("date", nullable=True)
F = Field("finite")
F_NULL = Field("finite", nullable=True)
C = Field("count")
C_NULL = Field("count", nullable=True)
SYM = Field("regex", pattern=SYMBOL)
IV = Field("finite", nullable=True, min=0, max=10)  # decimal IV; 10 = 1,000 %
PRICE = Field("finite", positive=True)


def _label(limit: int, nullable: bool = False) -> Field:
    return Field("label", nullable=nullable, max=limit)


TABLES: dict[str, dict[str, Field]] = {
    "daily_series": {
        "close": F, "date": D, "high": F_NULL, "low": F_NULL, "open": F_NULL,
        "seriesId": Field("enum", values=VOL_INDEX_IDS),
    },
    "vx_curve": {
        "asOf": D, "contractMonth": Field("regex", pattern=_MONTH), "price": PRICE,
    },
    "option_iv_daily": {
        "asOf": D, "atmIv30d": IV, "callIv25d30d": IV, "callOi": C, "callVolume": C,
        "callWall": F_NULL, "contracts": C, "gammaFlip": F_NULL, "netGex": F_NULL,
        "putIv25d30d": IV, "putOi": C, "putVolume": C, "putWall": F_NULL,
        "underlying": SYM, "underlyingPrice": PRICE,
    },
    "option_iv_term": {
        "asOf": D, "atmIv": IV, "atmStrike": F_NULL, "callOi": C, "callVolume": C,
        "dte": C, "expiration": D, "putOi": C, "putVolume": C, "underlying": SYM,
    },
    "cot_positions": {
        "category": Field("enum", values=COT_CATEGORIES), "long": C,
        "market": Field("regex", pattern=_MARKET), "marketCode": Field("regex", pattern=_MARKET_CODE),
        "openInterest": C, "reportDate": D, "reportType": Field("enum", values=("tff", "disaggregated")),
        "short": C, "spreading": C_NULL,
    },
    "macro_points": {
        "date": D, "frequency": _label(20), "name": _label(200),
        "seriesId": Field("regex", pattern=_MACRO_ID), "source": _label(80), "unit": _label(40),
        "value": F,
    },
    "event_calendar": {
        "date": D, "detail": Field("text", nullable=True, max=2000), "eventKey": _label(200),
        "kind": Field("regex", pattern=_KIND), "source": _label(80),
        "time": Field("regex", nullable=True, pattern=_CLOCK), "title": _label(300),
    },
    "finra_otc_weekly": {
        "lastUpdated": D_NULL, "shares": C, "symbol": SYM, "tier": _label(20), "trades": C,
        "venue": Field("enum", values=("ats", "non_ats")), "weekStart": D,
    },
    "short_interest": {
        "avgDailyVolume": C_NULL, "daysToCover": Field("finite", nullable=True, nonnegative=True),
        "previousShortInterest": C_NULL, "settlementDate": D, "shortInterest": C, "symbol": SYM,
    },
    "short_volume_daily": {
        "date": D, "shortExemptVolume": C, "shortVolume": C, "symbol": SYM, "totalVolume": C,
    },
    "sec_filings": {
        "accessionNumber": Field("regex", pattern=_ACCESSION), "cik": Field("regex", pattern=_CIK),
        "description": Field("text", max=2000), "filingDate": D, "formType": _label(20),
        "reportDate": D_NULL, "symbol": SYM, "url": Field("https"),
    },
    "sec_insider_trades": {
        "accessionNumber": Field("regex", pattern=_ACCESSION),
        "acquiredDisposed": Field("enum", nullable=True, values=("A", "D")), "filingDate": D,
        "ownerName": _label(200), "ownerTitle": _label(200, nullable=True), "price": F_NULL,
        "rowNumber": C, "shares": F_NULL, "sharesAfter": F_NULL, "symbol": SYM,
        "transactionCode": _label(10, nullable=True), "transactionDate": D_NULL,
        "url": Field("https", nullable=True),
    },
    "sec_ftd": {
        "cusip": Field("regex", pattern=_CUSIP), "price": F_NULL, "quantity": C,
        "settlementDate": D, "symbol": SYM,
    },
    "sec_13f_holdings": {
        "assetClass": _label(40, nullable=True), "cusip": Field("regex", pattern=_CUSIP),
        "filerCik": Field("regex", pattern=_CIK), "filerName": _label(200), "issuer": _label(200),
        "optionType": Field("enum", values=("put", "call", "")), "periodEnding": D,
        "shares": C_NULL, "symbol": Field("regex", nullable=True, pattern=SYMBOL), "value": F, "weight": F_NULL,
    },
    "factor_returns": {
        "date": D, "factor": Field("enum", values=FACTORS),
        "frequency": Field("enum", values=("daily", "monthly")), "value": F,
    },
}

# Primary keys (docs/vertex-rebuild/openbb.md, migration 0063); rows are de-duplicated on them.
KEYS: dict[str, tuple[str, ...]] = {
    "daily_series": ("seriesId", "date"),
    "vx_curve": ("asOf", "contractMonth"),
    "option_iv_daily": ("asOf", "underlying"),
    "option_iv_term": ("asOf", "underlying", "expiration"),
    "cot_positions": ("reportDate", "marketCode", "category"),
    "macro_points": ("seriesId", "date"),
    "event_calendar": ("source", "eventKey"),
    "finra_otc_weekly": ("weekStart", "symbol", "venue"),
    "short_interest": ("settlementDate", "symbol"),
    "short_volume_daily": ("date", "symbol"),
    "sec_filings": ("accessionNumber", "symbol"),
    "sec_insider_trades": ("accessionNumber", "rowNumber"),
    "sec_ftd": ("settlementDate", "symbol"),
    "sec_13f_holdings": ("filerCik", "periodEnding", "cusip", "optionType"),
    "factor_returns": ("date", "frequency", "factor"),
}


def row_problem(table: str, row: dict[str, Any]) -> str | None:
    """Return why `row` fails the table's row schema, or None when it passes."""
    fields = TABLES[table]
    if set(row) != set(fields):
        extra = sorted(set(row) - set(fields))
        missing = sorted(set(fields) - set(row))
        return f"keys differ (extra {extra}, missing {missing})"
    for name, rule in fields.items():
        if not rule.check(row[name]):
            return f"{name}={row[name]!r}"
    if table == "option_iv_term" and row["expiration"] < row["asOf"]:
        return "expiration before asOf"
    return None


def validate_rows(table: str, rows: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Keep rows that pass the schema, de-duplicate on the primary key (last wins).

    Returns (rows sorted by key, problems of dropped rows).
    """
    keep: dict[tuple[Any, ...], dict[str, Any]] = {}
    problems: list[str] = []
    key_fields = KEYS[table]
    for row in rows:
        problem = row_problem(table, row)
        if problem is not None:
            problems.append(problem)
            continue
        keep[tuple(row[k] for k in key_fields)] = row
    ordered = [keep[k] for k in sorted(keep, key=_sort_key)]
    return ordered, problems


def _sort_key(key: tuple[Any, ...]) -> tuple[tuple[int, int, str], ...]:
    return tuple((0, part, "") if isinstance(part, int) else (1, 0, str(part)) for part in key)
