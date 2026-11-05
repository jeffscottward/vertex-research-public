"""Read-only research CLI for Financial Datasets (financialdatasets.ai).

Research use only. This tool reads company facts, financial metrics, financial
statements and daily (end-of-day) price history for one ticker. It has no
order, broker or account path.

Use (from services/research):

    python -m providers.financialdatasets_cli company-facts --ticker AAPL
    python -m providers.financialdatasets_cli financial-metrics --ticker AAPL
    python -m providers.financialdatasets_cli financial-statements --ticker AAPL --period annual --limit 4
    python -m providers.financialdatasets_cli prices --ticker AAPL --days 7 --out private/fd/aapl-prices.json

Rules:
- The API key comes only from the environment: FINANCIAL_DATASETS_API_KEY, else
  FINANCIALDATASETS_API_KEY. The key is sent only in the X-API-KEY request
  header. It is never printed, logged or written.
- FINANCIAL_DATASETS_API_BASE_URL can replace the default HTTPS origin. It must
  be a bare HTTPS origin (no path, query or credentials).
- One run makes at most one HTTP request. There is no retry. After HTTP 429 the
  adapter records a cooldown and the CLI exits with the Retry-After value; the
  caller must wait before the next run.
- Redirects and pagination are not followed. A response that needs another
  page is reported as unavailable, not truncated.
- The only storage is the --out file, which must be inside a folder named
  "private" (git-ignored). Without --out the JSON goes to stdout.
- Rights mode is "research-only". Vendor storage, redistribution and model-use
  rights are unverified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener

from .boundary import Boundary, BoundaryError, epoch_ns
from .client import WindowBudget
from .financialdatasets import DEFAULT_ORIGIN, MAXIMUM_STATEMENT_LIMIT, FinancialDatasets, origin_url, ticker
from .ports import HttpRequest, HttpResponse, ProviderConfig, RightRequest, RightsDecision, Unavailable

KEY_ENV_NAMES = ("FINANCIAL_DATASETS_API_KEY", "FINANCIALDATASETS_API_KEY")
BASE_URL_ENV_NAME = "FINANCIAL_DATASETS_API_BASE_URL"
RIGHTS_MODE = "research-only"
POLICY_ID = "research-only-cli"
RIGHTS_REVISION = "financialdatasets-research-only-cli-v1"
OUTPUT_SCHEMA = "vertex.research.financialdatasets-cli.v1"
MAXIMUM_PRICE_DAYS = 366

# CLI endpoint name -> adapter operation.
ENDPOINTS = {
    "company-facts": "company-facts",
    "financial-metrics": "financial-metrics",
    "financial-statements": "financial-statements",
    "prices": "equity-bars",
}

EXIT_OK, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_GUARD = 0, 2, 3, 4


class UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # never exit from inside the parser
        raise UsageError(message)


class SystemClock:
    def now(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class CanonicalJson:
    """Local codec for capture identity only; no public contract record is made by this CLI."""

    def encode(self, value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")

    def digest(self, value: Any) -> str:
        return hashlib.sha256(self.encode(value)).hexdigest()


class NoContractValidator:
    """This CLI publishes no Vertex contract records, so every record request is refused."""

    def validate(self, contract_name: str, payload: dict[str, Any], schema_version: str = "1.0.0") -> bool:
        return False


class ResearchOnlyRights:
    """Grants short-lived research-only reads of the four CLI operations. Nothing else."""

    def __init__(self, ttl_seconds: int = 900):
        self.ttl = timedelta(seconds=ttl_seconds)

    def decide(self, request: RightRequest) -> RightsDecision:
        checked = datetime.fromisoformat(request.evaluated_at.replace("Z", "+00:00"))
        allowed = (request.scope_id == "financialdatasets" and request.policy_id == POLICY_ID
                   and request.operation in ENDPOINTS.values() and not request.source_ids)
        expires = (checked + self.ttl).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        return RightsDecision(request.scope_id, request.policy_id, request.operation, "granted" if allowed else "denied",
                              request.evaluated_at, expires, RIGHTS_REVISION, request.source_ids,
                              "research-only-local-private-out-file", None if allowed else "outside-research-only-scope")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # urllib then raises HTTPError with the 3xx status; the adapter refuses it


def _retry_after(value: str | None) -> int | None:
    if value is None or not value.strip().isdigit():
        return None
    return min(int(value.strip()), 86_400)


class UrllibTransport:
    """Single-request HTTPS transport. Holds the key privately and never exposes it."""

    def __init__(self, api_key: str, clock: Any, opener: OpenerDirector | Any | None = None):
        self.__api_key = api_key
        self._clock = clock
        self._opener = opener if opener is not None else build_opener(_NoRedirect())
        self.calls = 0
        self.last_status: int | None = None
        self.last_retry_after: int | None = None

    def __repr__(self) -> str:
        return "UrllibTransport(key=<hidden>)"

    def build(self, request: HttpRequest) -> Request:
        url = request.origin + request.path + ("?" + urlencode(request.query) if request.query else "")
        headers = {"X-API-KEY": self.__api_key, "Accept": "application/json", "User-Agent": "vertex-research-fd-cli/1"}
        if request.body is not None:
            headers["Content-Type"] = "application/json"
        return Request(url, data=request.body, method=request.method, headers=headers)

    def request(self, request: HttpRequest) -> HttpResponse:
        prepared = self.build(request)
        self.calls += 1
        limit = request.maximum_response_bytes + 1  # one extra byte lets the boundary reject oversize bodies
        try:
            with self._opener.open(prepared, timeout=request.timeout_ms / 1000) as response:
                status, headers, body = response.status, response.headers, response.read(limit)
        except HTTPError as error:
            status, headers = error.code, error.headers
            try:
                body = error.read(limit) if error.fp is not None else b""
            finally:
                error.close()
        self.last_status = status
        self.last_retry_after = _retry_after(headers.get("Retry-After") if headers is not None else None)
        return HttpResponse(status, body, self._clock.now(), self.last_retry_after)


def api_key(environ: Mapping[str, str]) -> str | None:
    for name in KEY_ENV_NAMES:
        value = (environ.get(name) or "").strip()
        if value:
            return value
    return None


def _parser() -> _Parser:
    parser = _Parser(prog="python -m providers.financialdatasets_cli",
                     description="Read-only research reads from Financial Datasets. No order or broker path.")
    parser.add_argument("endpoint", choices=sorted(ENDPOINTS))
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--period", choices=("annual", "quarterly", "ttm"), default="annual",
                        help="financial-statements only (default annual)")
    parser.add_argument("--limit", type=int, default=4,
                        help=f"financial-statements only: records per statement type, 1-{MAXIMUM_STATEMENT_LIMIT} (default 4)")
    parser.add_argument("--start-date", help="prices only: first day, YYYY-MM-DD (default: end date minus --days + 1)")
    parser.add_argument("--end-date", help="prices only: last day, YYYY-MM-DD (default: today UTC)")
    parser.add_argument("--days", type=int, default=5,
                        help=f"prices only: calendar days in the window when --start-date is absent, 1-{MAXIMUM_PRICE_DAYS} (default 5)")
    parser.add_argument("--rights-mode", choices=(RIGHTS_MODE,), default=RIGHTS_MODE,
                        help="the only mode: research-only reads; storage/redistribution rights are unverified")
    parser.add_argument("--out", help="write the JSON here; the path must be inside a folder named 'private'")
    return parser


def _out_path(value: str | None) -> Path | None:
    if value is None:
        return None
    path = Path(value).expanduser().resolve()
    if "private" not in path.parent.parts:
        raise UsageError("--out must be inside a folder named 'private' (git-ignored vendor data)")
    if path.exists() and not path.is_file():
        raise UsageError("--out must name a file")
    return path


def _price_window(args: argparse.Namespace, today: date) -> tuple[str, str]:
    try:
        end = date.fromisoformat(args.end_date) if args.end_date else today
        if args.start_date:
            start = date.fromisoformat(args.start_date)
        else:
            if not 1 <= args.days <= MAXIMUM_PRICE_DAYS:
                raise UsageError(f"--days must be 1-{MAXIMUM_PRICE_DAYS}")
            start = end - timedelta(days=args.days - 1)
    except ValueError as error:
        raise UsageError("dates must be YYYY-MM-DD") from error
    if start > end or (end - start).days >= MAXIMUM_PRICE_DAYS:
        raise UsageError(f"price window must be 1-{MAXIMUM_PRICE_DAYS} days with start <= end")
    return start.isoformat(), end.isoformat()


def record_count(endpoint: str, records: Any) -> int:
    if endpoint == "prices":
        return len(records)
    if endpoint == "financial-statements":
        statements = records.get("financials") if isinstance(records, dict) else None
        if isinstance(statements, dict):
            return sum(len(rows) for rows in statements.values() if isinstance(rows, list))
        return 0
    return 1 if isinstance(records, dict) and records else 0


def _emit(text: str, key: str | None, stream: TextIO) -> None:
    if key and key in text:
        raise BoundaryError("secret-in-output")
    stream.write(text + "\n")


def main(argv: list[str] | None = None, *, environ: Mapping[str, str] | None = None,
         transport_factory: Callable[[str, Any], Any] | None = None, clock: Any = None,
         stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    environ = os.environ if environ is None else environ
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    clock = SystemClock() if clock is None else clock
    key: str | None = None
    try:
        args = _parser().parse_args(argv)
        symbol = ticker(args.ticker)
        out = _out_path(args.out)
        try:
            origin = origin_url(environ.get(BASE_URL_ENV_NAME) or DEFAULT_ORIGIN)
        except BoundaryError as error:
            raise UsageError(f"{BASE_URL_ENV_NAME} must be a bare https origin") from error
        key = api_key(environ)
        if key is None:
            raise UsageError(f"missing API key: set {KEY_ENV_NAMES[0]} (or {KEY_ENV_NAMES[1]}); no request was made")
        if len(key) > 512 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise UsageError("API key has an invalid format; no request was made")

        operation = ENDPOINTS[args.endpoint]
        options: dict[str, Any] = {}
        if args.endpoint == "financial-statements":
            if not 1 <= args.limit <= MAXIMUM_STATEMENT_LIMIT:
                raise UsageError(f"--limit must be 1-{MAXIMUM_STATEMENT_LIMIT} (one page; pages are not followed)")
            options = {"period": args.period, "limit": args.limit}
        elif args.endpoint == "prices":
            today = datetime.fromtimestamp(epoch_ns(clock.now()) / 1e9, timezone.utc).date()
            start, end = _price_window(args, today)
            options = {"start_date": start, "end_date": end, "interval": "day"}

        transport = (transport_factory or (lambda secret, clk: UrllibTransport(secret, clk)))(key, clock)
        adapter = FinancialDatasets(
            origin=origin,
            config=ProviderConfig("financialdatasets", enabled=True, policy_id=POLICY_ID, timeout_ms=20_000),
            boundary=Boundary(NoContractValidator(), CanonicalJson()), clock=clock, rights=ResearchOnlyRights(),
            transport=transport, budget=WindowBudget(1, 60_000_000_000))
        plan = adapter.request_plan(operation, symbol, **options)
        if isinstance(plan, Unavailable):
            raise UsageError(f"request refused by the adapter: {plan.reason}")
        request = plan.requests[0]
        capture = adapter.client.capture(plan)
        records = capture if isinstance(capture, Unavailable) else adapter.records(capture)
        status = getattr(transport, "last_status", None)
        if isinstance(records, Unavailable):
            result = {"schema": OUTPUT_SCHEMA, "status": "unavailable", "source": "financialdatasets",
                      "endpoint": args.endpoint, "ticker": symbol, "rights_mode": RIGHTS_MODE,
                      "reason": records.reason, "detail": records.detail, "http_status": status,
                      "retry_after_seconds": getattr(transport, "last_retry_after", None) if status == 429 else None,
                      "requests_made": getattr(transport, "calls", None), "automatic_retry": False}
            _emit(json.dumps(result, sort_keys=True), key, stdout)
            return EXIT_UNAVAILABLE

        fetched_ns = epoch_ns(capture.received_at)
        result = {
            "schema": OUTPUT_SCHEMA,
            "status": "ok",
            "research_only": True,
            "source": "financialdatasets",
            "source_reference": capture.source_reference,
            "endpoint": args.endpoint,
            "operation": operation,
            "ticker": symbol,
            "request": {"method": request.method, "origin": request.origin, "path": request.path, "query": dict(request.query)},
            "http_status": status,
            "fetched_at": capture.received_at,
            "age_seconds": round(max(0, epoch_ns(clock.now()) - fetched_ns) / 1e9, 3),
            "raw_sha256": capture.content.digest,
            "rights": {"mode": RIGHTS_MODE, "policy_id": capture.rights.policy_id, "revision": capture.rights.revision,
                       "retention": capture.rights.retention_policy,
                       "vendor_storage_redistribution_model_use": "unverified"},
            "limitations": list(capture.limitations) + [
                "Research only; not a quote, broker record or trading signal.",
                "Prices are end-of-day daily bars only; no intraday or real-time data.",
                "Values are vendor-reported as of fetched_at, not point-in-time history.",
            ],
            "record_count": record_count(args.endpoint, records),
            "payload": records,
        }
        text = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True)
        if key in text:
            raise BoundaryError("secret-in-output")
        if out is None:
            stdout.write(text + "\n")
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
            summary = {key_: result[key_] for key_ in ("status", "source", "endpoint", "ticker", "http_status",
                                                         "fetched_at", "record_count")}
            summary["out"] = str(out)
            _emit(json.dumps(summary, sort_keys=True), key, stdout)
        return EXIT_OK
    except UsageError as error:
        message = str(error)
        stderr.write("financialdatasets_cli: " + (message.replace(key, "<hidden>") if key else message) + "\n")
        return EXIT_USAGE
    except BoundaryError as error:
        stderr.write("financialdatasets_cli: " + ("output blocked: it contained the API key" if str(error) == "secret-in-output"
                                                 else f"refused: {error}") + "\n")
        return EXIT_GUARD if str(error) == "secret-in-output" else EXIT_USAGE
    except Exception as error:  # never show a traceback that could carry request details
        stderr.write(f"financialdatasets_cli: internal error ({type(error).__name__})\n")
        return EXIT_GUARD


if __name__ == "__main__":
    raise SystemExit(main())
