"""Deterministic data pack for the claim checks of one note: quarterly cash flows per ticker.

No model call. Each ticker is one run of the existing Financial Datasets research reader
(``providers.financialdatasets_cli``), so its rules hold here unchanged: the key comes only
from FINANCIAL_DATASETS_API_KEY (else FINANCIALDATASETS_API_KEY), one run makes one request,
there is no retry and no pagination, a 429 records a cooldown, and the rights mode is
"research-only". After a refusal that calls for a wait or a fix (rate limit, access denied,
bad request, payment required, provider or network failure) no further ticker is requested.

Numbers are the vendor's reported values as decimals. A value that the payload does not have
stays missing: it is never read as zero, and a sum over a missing value is missing. Four
quarters that are not in one currency are not added: the pack prints the reason, not a number.
"""
from __future__ import annotations

import io
import json
from collections.abc import Callable, Mapping, Sequence
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from providers import financialdatasets_cli as fd

from .errors import NoteError

SCHEMA = "vertex.research.market-note-evidence.v1"
MAX_TICKERS = 10
DEFAULT_QUARTERS = 8
MAX_QUARTERS = 10  # one page of the statements endpoint; pages are never followed
PAUSE_S = 1.0
# output name, payload key, column title
FIELDS = (
    ("operatingCashFlow", "net_cash_flow_from_operations", "operating CF"),
    ("capitalExpenditure", "capital_expenditure", "capex"),
    ("freeCashFlow", "free_cash_flow", "free CF"),
    ("debtIssuedRepaid", "issuance_or_repayment_of_debt_securities", "debt net"),
    ("equityIssuedRepurchased", "issuance_or_purchase_of_equity_shares", "equity net"),
)
# Two quarter ends in a row are about 91 days apart (a 52/53-week year moves it by some days).
_QUARTER_GAP_DAYS = (80, 101)
LIMITATIONS = (
    "Research only; not a quote, broker record or trading signal.",
    "Values are vendor-reported as of the fetch time, not point-in-time history.",
    "One response per ticker; no pagination, so older quarters are not in the pack.",
    "Signs are the vendor's. Net debt and net equity are issuance (+) less repayment or repurchase (-).",
)


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def _day(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) and len(value) == 10 else None
    except ValueError:
        return None


def quarter_rows(payload: Any, quarters: int) -> list[dict[str, Any]]:
    """The newest ``quarters`` cash-flow rows of a statements payload, newest first."""
    financials = payload.get("financials") if isinstance(payload, dict) else None
    statements = financials.get("cash_flow_statements") if isinstance(financials, dict) else None
    if not isinstance(statements, list):
        raise ValueError("the payload has no cash-flow statements")
    rows = []
    for statement in statements:
        if not isinstance(statement, dict) or _day(statement.get("report_period")) is None:
            raise ValueError("a cash-flow statement has no period end date")
        if statement.get("period") not in (None, "quarterly"):
            raise ValueError("a cash-flow statement is not a quarterly statement")
        row: dict[str, Any] = {
            "periodEnd": statement["report_period"],
            "fiscalPeriod": statement.get("fiscal_period") if isinstance(statement.get("fiscal_period"), str) else None,
            "currency": statement.get("currency") if isinstance(statement.get("currency"), str) else None,
            "filingUrl": statement.get("filing_url") if isinstance(statement.get("filing_url"), str) else None,
        }
        for name, key, _title in FIELDS:
            row[name] = _decimal(statement.get(key))
        rows.append(row)
    rows.sort(key=lambda row: row["periodEnd"], reverse=True)
    if len({row["periodEnd"] for row in rows}) != len(rows):
        raise ValueError("two cash-flow statements have the same period end date")
    if not rows:
        raise ValueError("the payload has no cash-flow statement")
    return rows[:quarters]


def trailing_sums(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Sums over each window of four quarters in a row, newest window first.

    A window whose quarter ends are not one quarter apart is left out. A field that one of the
    four quarters lacks has no sum. A window whose quarters are not in one currency has no sum
    at all: its entry holds ``reason`` and no number.
    """
    out = []
    for start in range(len(rows) - 3):
        window = rows[start:start + 4]
        days = [date.fromisoformat(row["periodEnd"]) for row in window]
        gaps = [(newer - older).days for newer, older in zip(days, days[1:])]
        if any(not _QUARTER_GAP_DAYS[0] <= gap <= _QUARTER_GAP_DAYS[1] for gap in gaps):
            continue
        sums: dict[str, Any] = {"periodEnd": window[0]["periodEnd"], "firstPeriodEnd": window[3]["periodEnd"],
                                "reason": None}
        currencies = {row.get("currency") for row in window}
        if len(currencies) > 1:
            named = ", ".join(sorted(currency or "not stated" for currency in currencies))
            sums["reason"] = f"the four quarters are not in one currency ({named})"
        for name, _key, _title in FIELDS:
            values = [row[name] for row in window]
            missing = sums["reason"] is not None or any(value is None for value in values)
            sums[name] = None if missing else sum(values, Decimal(0))
        out.append(sums)
    return out


def _stops_the_pack(status: Any, reason: str) -> bool:
    """True when the next ticker must not be requested: a wait or a fix is needed first."""
    if isinstance(status, int) and not isinstance(status, bool):
        return status in (400, 401, 402, 403, 408, 429) or status >= 500
    return reason in ("rate-limited", "rate-budget-or-cooldown", "transport-unavailable",
                      "provider-access-denied", "disabled", "port-unavailable", "dependency-unavailable")


def fetch_ticker(symbol: str, quarters: int, *, environ: Mapping[str, str],
                 transport_factory: Callable[[str, Any], Any] | None = None, clock: Any = None) -> dict[str, Any]:
    """One request for one ticker through the research reader. Returns an ``ok`` or ``unavailable`` entry."""
    out, err = io.StringIO(), io.StringIO()
    code = fd.main(["financial-statements", "--ticker", symbol, "--period", "quarterly", "--limit", str(quarters),
                    "--rights-mode", fd.RIGHTS_MODE],
                   environ=environ, transport_factory=transport_factory, clock=clock, stdout=out, stderr=err)
    if code not in (fd.EXIT_OK, fd.EXIT_UNAVAILABLE):
        reason = " ".join(err.getvalue().replace("financialdatasets_cli:", "").split())[:300] or "refused"
        return {"ticker": symbol, "status": "unavailable", "reason": reason, "detail": None, "httpStatus": None,
                "retryAfterSeconds": None, "stop": True}
    try:
        result = json.loads(out.getvalue())
    except ValueError:
        return {"ticker": symbol, "status": "unavailable", "reason": "invalid-reader-output", "detail": None,
                "httpStatus": None, "retryAfterSeconds": None, "stop": True}
    if code == fd.EXIT_UNAVAILABLE:
        reason = str(result.get("reason") or "unavailable")
        return {"ticker": symbol, "status": "unavailable", "reason": reason, "detail": result.get("detail"),
                "httpStatus": result.get("http_status"), "retryAfterSeconds": result.get("retry_after_seconds"),
                "stop": _stops_the_pack(result.get("http_status"), reason)}
    try:
        rows = quarter_rows(result.get("payload"), quarters)
    except ValueError as error:
        return {"ticker": symbol, "status": "unavailable", "reason": "invalid-response", "detail": str(error),
                "httpStatus": result.get("http_status"), "retryAfterSeconds": None, "stop": False}
    request = result.get("request") if isinstance(result.get("request"), dict) else {}
    return {"ticker": symbol, "status": "ok", "fetchedAt": result.get("fetched_at"),
            "sourceReference": result.get("source_reference"), "rawSha256": result.get("raw_sha256"),
            "request": {"method": request.get("method"), "origin": request.get("origin"),
                        "path": request.get("path"), "query": request.get("query")},
            "currencies": sorted({row["currency"] or "not stated" for row in rows}),
            "quarters": rows, "trailing4Quarters": trailing_sums(rows), "stop": False}


def build_pack(note: Mapping[str, Any], tickers: Sequence[str], left_out: Sequence[str], quarters: int, *,
               environ: Mapping[str, str], transport_factory: Callable[[str, Any], Any] | None = None,
               clock: Any = None, sleep: Callable[[float], None] | None = None) -> dict[str, Any]:
    """The evidence pack of one note. Raises ``NoteError`` when no request can be made at all."""
    if fd.api_key(environ) is None:
        raise NoteError(f"missing API key: set {fd.KEY_ENV_NAMES[0]} (or {fd.KEY_ENV_NAMES[1]}); "
                        "no request was made")
    entries: list[dict[str, Any]] = []
    stopped: str | None = None
    for index, symbol in enumerate(tickers):
        if stopped is not None:
            entries.append({"ticker": symbol, "status": "not-requested",
                            "reason": f"no request after the refusal for {stopped}"})
            continue
        if index and sleep is not None:
            sleep(PAUSE_S)
        entry = fetch_ticker(symbol, quarters, environ=environ, transport_factory=transport_factory, clock=clock)
        if entry.pop("stop"):
            stopped = symbol
        entries.append(entry)
    return {"schema": SCHEMA, "researchOnly": True, "modelCalls": 0,
            "note": {"id": note.get("id"), "asOf": note.get("asOf"), "theme": note.get("theme")},
            "source": "financialdatasets", "sourceName": "Financial Datasets (financialdatasets.ai)",
            "statement": "cash-flow statements", "period": "quarterly", "quartersAsked": quarters,
            "rightsMode": fd.RIGHTS_MODE, "tickers": entries, "leftOut": list(left_out),
            "limitations": list(LIMITATIONS)}


def complete(pack: Mapping[str, Any]) -> bool:
    """True when every ticker of the pack has its numbers."""
    return all(entry["status"] == "ok" for entry in pack["tickers"])


def _json_default(value: Any) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    raise TypeError(type(value).__name__)


def pack_json(pack: Mapping[str, Any]) -> str:
    """The pack as JSON. Amounts are exact decimal strings."""
    return json.dumps(pack, default=_json_default, ensure_ascii=False, indent=2)


def _millions(value: Decimal | None) -> str:
    return "n/a" if value is None else f"{value / Decimal(1_000_000):,.0f}"


def pack_text(pack: Mapping[str, Any]) -> str:
    """The pack as text: per ticker one table of quarters and one of trailing four-quarter sums."""
    note = pack["note"]
    lines = [
        f"evidence pack for note {note['id']} (as of {note['asOf']}): {note['theme']}",
        f"source: {pack['sourceName']}, {pack['period']} {pack['statement']}; rights mode {pack['rightsMode']}",
        "values: millions, rounded, as the vendor reports them (signs are the vendor's); n/a = not in the payload",
        "debt net and equity net: issuance (+) less repayment or repurchase (-)",
        "no model call; research context only, not a trading signal",
    ]
    if pack["leftOut"]:
        lines.append(f"left out (the pack holds at most {MAX_TICKERS} tickers): {', '.join(pack['leftOut'])}")
    head = f"  {'period end':<11}{'fiscal':<9}" + "".join(f"{title:>14}" for _name, _key, title in FIELDS)
    for entry in pack["tickers"]:
        lines.append("")
        if entry["status"] != "ok":
            detail = f" ({entry['detail']})" if entry.get("detail") else ""
            status = f"; HTTP {entry['httpStatus']}" if entry.get("httpStatus") else ""
            wait = f"; retry after {entry['retryAfterSeconds']} s" if entry.get("retryAfterSeconds") else ""
            label = "not requested" if entry["status"] == "not-requested" else "unavailable"
            lines.append(f"{entry['ticker']}: {label}: {entry['reason']}{detail}{status}{wait}. No numbers.")
            continue
        rows = entry["quarters"]
        money = entry["currencies"]
        lines.append(f"{entry['ticker']}: {len(rows)} quarters, period ends {rows[-1]['periodEnd']} to "
                     f"{rows[0]['periodEnd']}; "
                     + (f"currency {money[0]}" if len(money) == 1 else f"currencies {', '.join(money)} (mixed)")
                     + f"; fetched {entry['fetchedAt']}")
        lines.append(head)
        for row in rows:
            lines.append(f"  {row['periodEnd']:<11}{row['fiscalPeriod'] or '':<9}"
                         + "".join(f"{_millions(row[name]):>14}" for name, _key, _title in FIELDS)
                         + (f"  {row['currency'] or 'not stated'}" if len(money) > 1 else ""))
        if entry["trailing4Quarters"]:
            lines.append("  trailing 4 quarters ending:")
            for sums in entry["trailing4Quarters"]:
                if sums["reason"]:
                    lines.append(f"  {sums['periodEnd']:<11}no sum: {sums['reason']}")
                    continue
                lines.append(f"  {sums['periodEnd']:<11}{'':<9}"
                             + "".join(f"{_millions(sums[name]):>14}" for name, _key, _title in FIELDS))
        else:
            lines.append("  trailing 4 quarters: n/a (fewer than four quarters in a row)")
    return "\n".join(lines)
