"""daily-prices job (card vertex-daily-series-refresh): rules of the stored daily prices collector."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import time
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import ROOT

from vertex_openbb.context import ArgumentError, Context
from vertex_openbb.jobs import prices
from vertex_openbb.upstream import Upstream

TODAY = date(2026, 11, 19)
START = date(2026, 11, 5)


def ny(hour: int, minute: int, day: int = 19) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=prices.NEW_YORK)


def bar(day: str, close: float = 100.0, **extra: Any) -> dict[str, Any]:
    return {"date": day, "open": close - 1, "high": close + 2, "low": close - 2, "close": close,
            "adj_close": close, "volume": 1000.0, "source": "ibkr", **extra}


def context(symbols: tuple[str, ...] | None = None, *, now: datetime | None = None, since: date | None = None,
            env: dict[str, str] | None = None) -> Context:
    return Context(job="daily-prices", today=TODAY, up=Upstream(), symbols=symbols, since=since,
                   env=env or {}, now=now or ny(18, 0))


def run(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    return asyncio.run(prices.daily_prices(ctx))


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prices, "load_history", lambda: SimpleNamespace(configured=lambda _env: True))


def test_complete_session_cutoff() -> None:
    assert not prices.complete("2026-11-19", ny(17, 14))
    assert prices.complete("2026-11-19", ny(17, 15))
    assert prices.complete("2026-11-18", ny(0, 30))
    assert not prices.complete("2026-11-20", ny(23, 59))


def test_etf_rows_keep_complete_valid_sessions_only() -> None:
    rows = [
        bar("2026-11-04"),                                   # before the window
        bar("2026-11-17", 600.0, adj_close=598.5),
        bar("2026-11-18", 610.0, volume=float("nan")),
        bar("2026-11-18", 611.0, source="treasury"),
        bar("2026-11-18", 612.0, low=0.0),                   # non-positive price
        bar("2026-11-18", 613.0, adj_close=None),            # no adjusted close
        bar("2026-11-19", 620.0),                            # today, before 17:15
        bar("2026-11-20", 630.0),                            # the session in progress
    ]
    series, bars = prices.price_rows("SPY", rows, START, ny(17, 14))
    assert series == [
        {"adjClose": 598.5, "close": 600.0, "date": "2026-11-17", "high": 602.0, "low": 598.0, "open": 599.0,
         "seriesId": "SPY"},
        {"adjClose": 610.0, "close": 610.0, "date": "2026-11-18", "high": 612.0, "low": 608.0, "open": 609.0,
         "seriesId": "SPY"},
    ]
    assert bars == [
        {"close": 600.0, "date": "2026-11-17", "high": 602.0, "low": 598.0, "open": 599.0, "symbol": "SPY",
         "volume": 1000.0},
        {"close": 610.0, "date": "2026-11-18", "high": 612.0, "low": 608.0, "open": 609.0, "symbol": "SPY",
         "volume": None},
    ]
    later, _ = prices.price_rows("SPY", rows, START, ny(17, 15))
    assert [row["date"] for row in later] == ["2026-11-17", "2026-11-18", "2026-11-19"]


def test_futures_use_close_as_adj_close_and_rates_are_close_only() -> None:
    series, bars = prices.price_rows("ES=F", [bar("2026-11-18", 7000.0, adj_close=1.0)], START, ny(18, 0))
    assert series[0]["adjClose"] == 7000.0 and bars[0]["symbol"] == "ES=F"
    rows = [bar("2026-11-18", 5.05), bar("2026-11-17", 0.0), {"date": "2026-11-16", "close": True}]
    series, bars = prices.price_rows("TNX", rows, START, ny(18, 0))
    assert series == [{"close": 5.05, "date": "2026-11-18", "high": None, "low": None, "open": None,
                       "seriesId": "TNX"}]
    assert bars == []


def chart(**overrides: Any) -> dict[str, Any]:
    quote = {"open": [1.0, None, 3.0], "high": [2.0, 2.0, 4.0], "low": [0.5, 1.0, 2.5], "close": [1.5, 1.5, 3.5],
             "volume": [10, 20, None]}
    result = {"meta": {"exchangeTimezoneName": "America/New_York"},
              # 2026-11-17 00:00, 11-18 00:00 and 11-18 18:00 New York
              "timestamp": [1794891600, 1794978000, 1795042800],
              "indicators": {"quote": [quote], "adjclose": [{"adjclose": [1.4, 1.4, None]}]}}
    result.update(overrides)
    return {"chart": {"result": [result]}}


def test_yahoo_rows_parse_the_chart_document() -> None:
    assert prices.yahoo_rows(chart()) == [
        {"date": "2026-11-17", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "adj_close": 1.4, "volume": 10.0},
        {"date": "2026-11-18", "open": 3.0, "high": 4.0, "low": 2.5, "close": 3.5, "adj_close": 3.5},
    ]
    quote = {"open": [1.0], "high": [2.0], "low": [0.5], "close": [1.5]}
    plain = chart(timestamp=[1794891600], indicators={"quote": [quote]})
    assert prices.yahoo_rows(plain) == [
        {"date": "2026-11-17", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "adj_close": 1.5}]
    assert prices.yahoo_rows(chart(timestamp=None)) == []


def test_fetch_yahoo_builds_the_url(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, float]] = []

    def get(url: str, timeout: float) -> bytes:
        seen.append((url, timeout))
        return b'{"chart": {"result": [{"meta": {"exchangeTimezoneName": "UTC"}, "indicators": {"quote": [{}]}}]}}'

    monkeypatch.setattr(prices, "http_get", get)
    assert prices.fetch_yahoo("ES=F", START, ny(18, 0)) == []
    url, timeout = seen[0]
    assert url.startswith("https://query1.finance.yahoo.com/v8/finance/chart/ES%3DF?period1=1793836800&period2=1795215600&")
    assert url.endswith("&interval=1d&events=div%2Csplits") and timeout == prices.YAHOO_TIMEOUT_S


def test_http_get_sends_the_agent_and_caps_the_body(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def read(self, size: int) -> bytes:
            return b"x" * min(size, 3)

    seen: list[Any] = []

    def urlopen(request: Any, timeout: float) -> Response:
        seen.append((request.full_url, request.get_header("User-agent"), timeout))
        return Response()

    monkeypatch.setattr(prices.urllib.request, "urlopen", urlopen)
    assert prices.http_get("https://example.invalid/a", 7.0) == b"xxx"
    assert seen == [("https://example.invalid/a", prices.AGENT["User-Agent"], 7.0)]


class Sheet:
    def __init__(self, rows: list[list[Any]]) -> None:
        self.rows = rows
        self.nrows = len(rows)

    def cell_value(self, row: int, column: int) -> Any:
        return self.rows[row][column]


def test_shiller_months_and_download(monkeypatch: pytest.MonkeyPatch) -> None:
    import xlrd

    rows = [["Date", "P", "D", "E"], [2026.05, 6000.0, 1.0, 250.0], [2026.1, 6100.0, 1.0, 255.0],
            [2026.13, 1.0, 1.0, 1.0], [2026.06, 0.0, 1.0, 1.0], [2026.07, 6200.0, 1.0, ""]]
    book = SimpleNamespace(sheet_by_name=lambda name: Sheet(rows) if name == "Data" else None)
    monkeypatch.setattr(xlrd, "open_workbook", lambda file_contents: book if file_contents == b"xls" else None)
    assert prices.shiller_months(b"xls") == {"2026-05": [6000.0, 250.0], "2026-10": [6100.0, 255.0]}

    pages = {prices.SHILLER_PAGE: b'<a href="//img1.example.invalid/ie_data.xls?ver=1">data</a>',
             "https://img1.example.invalid/ie_data.xls?ver=1": b"xls"}
    monkeypatch.setattr(prices, "http_get", lambda url, _timeout: pages[url])
    assert prices.fetch_shiller()["2026-05"] == [6000.0, 250.0]
    pages[prices.SHILLER_PAGE] = b'<a href="https://files.example.invalid/ie_data.xls">data</a>'
    pages["https://files.example.invalid/ie_data.xls"] = b"xls"
    assert "2026-10" in prices.fetch_shiller()
    pages[prices.SHILLER_PAGE] = b"<p>moved</p>"
    with pytest.raises(RuntimeError, match="ie_data.xls link not found"):
        prices.fetch_shiller()


def qc_ports_data() -> Any:
    path = ROOT.parent / "research" / "strategies" / "qc_ports" / "data.py"
    spec = importlib.util.spec_from_file_location("qc_ports_data_for_prices_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_ratio_rows_match_qc_ports_and_warn_on_a_missing_month() -> None:
    assert prices.shift_month("2026-03", -6) == "2025-09" and prices.shift_month("2026-11", -6) == "2026-05"
    months = {"2026-05": [6000.0, 250.0]}
    tnx = [{"date": "2026-11-17", "close": 5.0}, {"date": "2026-11-18", "close": 5.05},
           {"date": "2026-12-01", "close": 5.1}]
    warnings: list[str] = []
    rows = prices.ratio_rows(tnx, months, warnings.append)
    expected = qc_ports_data().ey_tnx_ratio({"2026-05": (6000.0, 250.0)}, {row["date"]: row["close"] for row in tnx})
    assert {row["date"]: row["close"] for row in rows} == expected
    assert rows[0] == {"close": 100 * 250.0 / 6000.0 / 5.0, "date": "2026-11-17", "high": None, "low": None,
                       "open": None, "seriesId": "EY_TNX_RATIO"}
    assert warnings == ["EY_TNX_RATIO: the Shiller workbook has no month 2026-06; no row for its dates"]


def test_load_history_reads_the_checkout_and_names_a_missing_file(tmp_path: Path) -> None:
    module = prices.load_history(ROOT)
    assert module.SCHEMA == "vertex-history-bars-v2"
    assert prices.load_history(ROOT) is module
    with pytest.raises(ArgumentError, match=r"daily-prices needs .*research/ibkr_history\.py"):
        prices.load_history(tmp_path / "openbb")


def test_fetch_id_uses_ibkr_first_and_never_the_treasury(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(ROOT)
    history = prices.load_history()
    calls: list[tuple[str, dict[str, str], float]] = []

    def transport(url: str, headers: dict[str, str], timeout: float, _max_bytes: int) -> Any:
        calls.append((url, dict(headers), timeout))
        return history.HttpResponse(429, {}, b'{"error": "pacing_violation", "retry_after_seconds": 600}')

    def no_sleep(_seconds: float) -> None:
        raise AssertionError("a paced reply must not sleep")

    monkeypatch.setattr(history, "urllib_transport", transport)
    monkeypatch.setattr(time, "sleep", no_sleep)
    yahoo: list[str] = []

    def fetch_yahoo(symbol: str, start: date, _now: datetime) -> list[dict[str, Any]]:
        yahoo.append(symbol)
        if symbol == "^IRX":
            raise OSError("yahoo is down")
        return [{"date": "2026-11-18", "open": 9.0, "high": 11.0, "low": 8.0, "close": 10.0, "adj_close": 9.5}]

    monkeypatch.setattr(prices, "fetch_yahoo", fetch_yahoo)
    env = {"VERTEX_HISTORY_URL": "https://history.example.invalid", "VERTEX_DEPLOY_STATUS_TOKEN": "t0ken"}

    got = prices.fetch_id("SPY", START, ny(18, 0), env)
    assert [row["source"] for row in got["rows"]] == ["yahoo"] and "ibkr" in got["errors"]
    assert calls and all(timeout == prices.IBKR_TIMEOUT_S for _url, _headers, timeout in calls)
    assert all("t0ken" not in text for text in got["errors"].values())

    monkeypatch.setenv("VERTEX_HISTORY_URL", "https://history.example.invalid")
    monkeypatch.setenv("VERTEX_DEPLOY_STATUS_TOKEN", "t0ken")
    before = len(calls)
    got = prices.fetch_id("ES=F", START, ny(18, 0), {})
    assert [row["source"] for row in got["rows"]] == ["yahoo"]
    assert "not configured" in got["errors"]["ibkr"] and len(calls) == before

    got = prices.fetch_id("IRX", START, ny(18, 0), env)
    assert got["rows"] == [] and set(got["errors"]) >= {"ibkr", "yahoo"}
    assert yahoo == ["SPY", "ES=F", "^IRX"]
    assert prices._no_treasury("https://example.invalid") == b""


def test_job_emits_series_bars_and_the_ratio(monkeypatch: pytest.MonkeyPatch, configured: None) -> None:
    seen: list[tuple[str, date]] = []

    def fetch_id(series_id: str, start: date, _now: datetime, _env: Any) -> dict[str, Any]:
        seen.append((series_id, start))
        close = {"SPY": 600.0, "ES=F": 7000.0, "TNX": 5.0}[series_id]
        rows = [bar("2026-11-18", close), bar("2026-11-19", close + 1), bar("2026-11-20", close + 2)]
        return {"errors": {}, "rows": rows, "warnings": ["seam 2026-11-01: ibkr/yahoo close ratio 1.0300"]}

    monkeypatch.setattr(prices, "fetch_id", fetch_id)
    monkeypatch.setattr(prices, "fetch_shiller", lambda: {"2026-05": [6000.0, 250.0]})
    ctx = context(("SPY", "ES=F", "TNX"))
    tables = run(ctx)
    assert seen == [("SPY", date(2026, 10, 5)), ("ES=F", date(2026, 10, 5)), ("TNX", date(2026, 10, 5))]
    assert [(row["seriesId"], row["date"]) for row in tables["daily_series"]] == [
        ("SPY", "2026-11-18"), ("SPY", "2026-11-19"), ("ES=F", "2026-11-18"), ("ES=F", "2026-11-19"),
        ("TNX", "2026-11-18"), ("TNX", "2026-11-19"), ("EY_TNX_RATIO", "2026-11-18"), ("EY_TNX_RATIO", "2026-11-19")]
    assert [(row["symbol"], row["date"]) for row in tables["daily_bars"]] == [
        ("SPY", "2026-11-18"), ("SPY", "2026-11-19"), ("ES=F", "2026-11-18"), ("ES=F", "2026-11-19")]
    assert "adjClose" not in tables["daily_series"][4]
    assert (ctx.sources_ok, ctx.sources_failed) == (4, 0)
    assert ctx.warnings == ["SPY: seam 2026-11-01: ibkr/yahoo close ratio 1.0300",
                            "ES=F: seam 2026-11-01: ibkr/yahoo close ratio 1.0300",
                            "TNX: seam 2026-11-01: ibkr/yahoo close ratio 1.0300"]


def test_job_reports_failed_ids_and_keeps_the_others(monkeypatch: pytest.MonkeyPatch, configured: None) -> None:
    def fetch_id(series_id: str, _start: date, _now: datetime, _env: Any) -> dict[str, Any]:
        if series_id == "QQQ":
            raise OSError("boom")
        if series_id == "DIA":
            return {"errors": {"ibkr": "ibkr: PACED", "yahoo": "yahoo: OSError"}, "rows": [], "warnings": []}
        if series_id == "IWM":
            return {"errors": {}, "rows": [bar("2026-11-18", source="treasury")], "warnings": []}
        return {"errors": {}, "rows": [bar("2026-11-18")], "warnings": []}

    def no_shiller() -> None:
        raise AssertionError("the Shiller workbook is read only with TNX rows")

    monkeypatch.setattr(prices, "fetch_id", fetch_id)
    monkeypatch.setattr(prices, "fetch_shiller", no_shiller)
    ctx = context(("SPY", "QQQ", "DIA", "IWM"))
    tables = run(ctx)
    assert [row["seriesId"] for row in tables["daily_series"]] == ["SPY"]
    assert (ctx.sources_ok, ctx.sources_failed) == (1, 3)
    assert any(text.startswith("QQQ: ") for text in ctx.warnings)
    assert "DIA: ibkr: PACED; yahoo: OSError" in ctx.warnings and "IWM: no rows" in ctx.warnings


def test_job_stops_starting_ids_after_the_budget(monkeypatch: pytest.MonkeyPatch, configured: None) -> None:
    ticks = iter([0.0, 1.0, prices.BUDGET_S + 2.0, prices.BUDGET_S + 3.0])
    monkeypatch.setattr(prices, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(prices, "fetch_id", lambda *_args: {"errors": {}, "rows": [bar("2026-11-18")], "warnings": []})
    ctx = context(("SPY", "QQQ", "DIA"))
    tables = run(ctx)
    assert [row["seriesId"] for row in tables["daily_series"]] == ["SPY"]
    assert (ctx.sources_ok, ctx.sources_failed) == (1, 2)
    assert "QQQ: not reached in 120 s; the next run reads it" in ctx.warnings


def test_job_warns_without_ibkr_and_counts_a_shiller_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prices, "load_history", lambda: SimpleNamespace(configured=lambda _env: False))
    monkeypatch.setattr(prices, "fetch_id", lambda *_args: {"errors": {}, "rows": [bar("2026-11-18", 5.0)], "warnings": []})

    def down() -> None:
        raise OSError("shillerdata.com is down")

    monkeypatch.setattr(prices, "fetch_shiller", down)
    ctx = context(("TNX",), now=None)
    ctx.now = None  # the job reads the New York clock itself
    tables = run(ctx)
    assert [row["seriesId"] for row in tables["daily_series"]] == ["TNX"]
    assert ctx.warnings[0].startswith("IBKR history is not configured")
    assert (ctx.sources_ok, ctx.sources_failed) == (1, 1)
    assert any(text.startswith("EY_TNX_RATIO (Shiller workbook): ") for text in ctx.warnings)


def test_job_refuses_unknown_ids_and_an_old_since(configured: None) -> None:
    with pytest.raises(ArgumentError, match="must be price ids, not AAPL, VIX"):
        run(context(("SPY", "AAPL", "VIX")))
    with pytest.raises(ArgumentError, match="at most 120 days back"):
        run(context(("SPY",), since=date(2026, 7, 21)))
    assert prices.PRICE_IDS == prices.ETFS + prices.FUTURES + prices.RATES and len(prices.PRICE_IDS) == 16
