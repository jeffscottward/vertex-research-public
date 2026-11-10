"""ibkr_history: vertex-history client, IBKR-first merge and index fallbacks. Fakes only, no network."""
from __future__ import annotations

import importlib.util
import json
import sys
import types
import urllib.error
import urllib.parse
from datetime import UTC, date, datetime
from pathlib import Path

import ibkr_history as ih
import pytest

BASE = "https://history.tailnet.test/vertex-history/v1"
TOKEN = "t" * 40


def stamp(day: str) -> int:
    return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())


def document(days, *, sec_type="STK", currency="USD", close=100.0, volume=7.0, step=1.0) -> bytes:
    bars = [{"t": stamp(day), "o": close + i * step, "h": close + i * step + 1, "l": close + i * step - 1,
             "c": close + i * step, "v": volume} for i, day in enumerate(days)]
    return json.dumps({
        "schema": ih.SCHEMA, "source": "ibkr-gateway", "client_id": 77, "count": len(bars), "bars": bars,
        "request": {"secType": sec_type, "currency": currency, "barSize": "1 day"},
        "contract": {}, "cache": {}, "fetched_at": "2026-11-10T00:00:00Z", "as_of": None,
    }).encode()


def ok(body: bytes) -> ih.HttpResponse:
    return ih.HttpResponse(200, {"content-type": "application/json"}, body)


def failure(status: int, body: dict | None = None, headers: dict | None = None) -> ih.HttpResponse:
    head = {"content-type": "application/json"} if body is not None else {"content-type": "text/plain"}
    return ih.HttpResponse(status, {**head, **(headers or {})}, json.dumps(body).encode() if body else b"oops")


class FakeTransport:
    """Answers each request from `answer(params)` (or a fixed queue) and records the calls."""

    def __init__(self, answer=None, queue=None):
        self.answer, self.queue, self.calls = answer, list(queue or []), []

    def __call__(self, url, headers, timeout, max_bytes):
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        self.calls.append({"url": url, "headers": dict(headers), "timeout": timeout, "max_bytes": max_bytes,
                           "params": params})
        return self.queue.pop(0) if self.queue else self.answer(params)


def client(transport, *, sleeps=None, today=date(2026, 11, 10), **options) -> ih.Client:
    return ih.Client(BASE, TOKEN, transport=transport, sleep=(sleeps.append if sleeps is not None else None)
                     or (lambda s: None), today=lambda: today, **options)


# --- configuration and request building --------------------------------------------------------------------


def test_configured_needs_both_variables():
    assert ih.configured({ih.URL_ENV: BASE, ih.TOKEN_ENV: TOKEN})
    assert not ih.configured({ih.URL_ENV: BASE})
    assert not ih.configured({ih.TOKEN_ENV: TOKEN})
    assert not ih.configured({ih.URL_ENV: " ", ih.TOKEN_ENV: TOKEN})
    with pytest.raises(ih.IbkrHistoryError) as raised:
        ih.Client.from_env({})
    assert raised.value.code == "NOT_CONFIGURED"


def test_request_url_headers_and_defaults():
    fake = FakeTransport(queue=[ok(document(["2026-11-09"]))])
    rows = client(fake).daily_bars("spy", years=5)
    call = fake.calls[0]
    assert call["url"].startswith(BASE + "/bars?")
    assert call["params"] == {"barSize": "1 day", "currency": "USD", "duration": "5 Y", "secType": "STK",
                              "symbol": "SPY", "useRTH": "1", "whatToShow": "TRADES"}
    assert call["headers"] == {"Accept": "application/json", "Authorization": f"Bearer {TOKEN}"}
    assert call["max_bytes"] == ih.MAX_BYTES
    assert rows == [{"date": "2026-11-09", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                     "volume": 700.0, "source": "ibkr"}]


def test_index_request_carries_exchange_and_end_date():
    fake = FakeTransport(queue=[ok(document(["2020-01-02"], sec_type="IND"))])
    client(fake).daily_bars("VIX", sec_type="IND", exchange="cboe", years=30, end_date_time="20200103-23:59:59")
    params = fake.calls[0]["params"]
    assert (params["secType"], params["exchange"], params["endDateTime"], params["duration"]) == (
        "IND", "CBOE", "20200103-23:59:59", "30 Y")


@pytest.mark.parametrize("request_, message", [
    ({"what": "ADJUSTED_LAST", "end_date_time": "20200101-23:59:59"}, "ADJUSTED_LAST takes no endDateTime"),
    ({"what": "ADJUSTED_LAST", "sec_type": "IND", "exchange": "CBOE"}, "ADJUSTED_LAST is for STK"),
    ({"sec_type": "IND", "exchange": "CBOE", "what": "MIDPOINT"}, "IND offers TRADES only"),
    ({"sec_type": "IND"}, "need an exchange"),
    ({"sec_type": "CONTFUT", "exchange": "CME", "end_date_time": "20200101-23:59:59"}, "CONTFUT takes no"),
    ({"years": 31}, "years must be 1 to 30"),
    ({"years": 0}, "years must be 1 to 30"),
    ({"end_date_time": "2020-01-01"}, "endDateTime must be"),
])
def test_rules_refuse_before_any_request(request_, message):
    fake = FakeTransport(answer=lambda params: pytest.fail("no request expected"))
    with pytest.raises(ih.IbkrHistoryError) as raised:
        client(fake).daily_bars("SPY", **request_)
    assert raised.value.code == "BAD_REQUEST" and message in raised.value.message
    assert fake.calls == []


def test_url_must_be_http():
    with pytest.raises(ih.IbkrHistoryError) as raised:
        ih.Client("file:///etc/passwd", TOKEN)
    assert raised.value.code == "NOT_CONFIGURED" and "/etc" not in str(raised.value)


# --- pacing ------------------------------------------------------------------------------------------------


def test_paced_answer_is_retried_after_retry_after_seconds():
    sleeps: list[float] = []
    fake = FakeTransport(queue=[failure(429, {"error": "paced", "retry_after_seconds": 7}),
                                failure(429, {"error": "paced"}, {"retry-after": "3"}),
                                failure(429, {"error": "paced"}),
                                ok(document(["2026-11-09"]))])
    rows = client(fake, sleeps=sleeps).daily_bars("SPY")
    assert len(rows) == 1 and len(fake.calls) == 4
    assert sleeps == [8.0, 4.0, ih.PACED_WAIT_SECONDS]


def test_paced_retries_run_out():
    sleeps: list[float] = []
    fake = FakeTransport(answer=lambda params: failure(429, {"error": "paced", "retry_after_seconds": 1}))
    with pytest.raises(ih.IbkrHistoryError) as raised:
        client(fake, sleeps=sleeps, paced_retries=2).daily_bars("SPY")
    assert raised.value.code == "PACED" and raised.value.retry_after == 1
    assert len(fake.calls) == 3 and sleeps == [2.0, 2.0]


def test_other_failures_are_not_retried():
    sleeps: list[float] = []
    fake = FakeTransport(answer=lambda params: failure(503, {"error": "unavailable"}))
    with pytest.raises(ih.IbkrHistoryError) as raised:
        client(fake, sleeps=sleeps).daily_bars("SPY")
    assert raised.value.code == "UNAVAILABLE" and len(fake.calls) == 1 and sleeps == []


# --- volume ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("sec_type, currency, volume, expected", [
    ("STK", "USD", 7.0, 700.0),      # US stocks: lots of 100 shares
    ("STK", "EUR", 7.0, 7.0),
    ("CONTFUT", "USD", 7.0, 7.0),    # contracts
    ("IND", "USD", None, None),
])
def test_volume_scaling(sec_type, currency, volume, expected):
    rows = ih.parse_document(document(["2026-11-09"], sec_type=sec_type, currency=currency, volume=volume))
    assert rows[0]["volume"] == expected


# --- error mapping -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("response, code, text", [
    (failure(422, {"error": "no_contract", "message": "No security definition", "ibkr_code": 200}),
     "NOT_FOUND", "IBKR 200: No security definition"),
    (failure(502, {"error": "entitlement", "message": "No market data permissions for DU1234567"}),
     "ENTITLEMENT", "No market data permissions for [account]"),
    (failure(504, {"error": "timeout"}), "UNAVAILABLE", "IBKR history service unavailable"),
    (failure(400, {"error": "bad_request", "message": "bad\nduration"}), "BAD_REQUEST", "bad duration"),
    (failure(502, {"error": "upstream", "message": "boom", "ibkr_code": 162}), "UPSTREAM_ERROR", "IBKR 162: boom"),
    (failure(401), "UPSTREAM_ERROR", "History endpoint returned HTTP 401"),
    (failure(503), "UNAVAILABLE", "History endpoint returned HTTP 503"),
    (failure(302), "UPSTREAM_ERROR", "History endpoint returned HTTP 302"),
    (ih.HttpResponse(200, {"content-type": "text/html"}, b"<html>"), "UPSTREAM_ERROR", "unexpected content type"),
    (ok(b"{not json"), "UPSTREAM_ERROR", "not valid JSON"),
    (ok(json.dumps({"schema": "other"}).encode()), "UPSTREAM_ERROR", "schema validation"),
    (ok(document(["2026-11-09"]).replace(b'"count": 1', b'"count": 2')), "UPSTREAM_ERROR", "schema validation"),
])
def test_error_mapping_and_safe_messages(response, code, text):
    fake = FakeTransport(queue=[response])
    with pytest.raises(ih.IbkrHistoryError) as raised:
        client(fake).daily_bars("SPY")
    assert raised.value.code == code and text in raised.value.message
    shown = f"{raised.value} {raised.value!r}"
    assert TOKEN not in shown and "tailnet" not in shown


def test_transport_failures_never_quote_the_host(monkeypatch):
    class Opener:
        def __init__(self, error):
            self.error = error

        def open(self, request, timeout):
            raise self.error

    for error, text in ((urllib.error.URLError("history.tailnet.test refused"), "History request failed"),
                        (urllib.error.URLError(TimeoutError("history.tailnet.test")), "History request timed out"),
                        (ConnectionResetError("history.tailnet.test"), "History request failed")):
        monkeypatch.setattr(ih.urllib.request, "build_opener", lambda *handlers, e=error: Opener(e))
        with pytest.raises(ih.IbkrHistoryError) as raised:
            ih.Client(BASE, TOKEN).daily_bars("SPY")
        assert raised.value.code == "UNAVAILABLE" and raised.value.message == text
        assert raised.value.__cause__ is None and "tailnet" not in str(raised.value)
    assert "tailnet" not in repr(ih.Client(BASE, TOKEN)) and TOKEN not in repr(ih.Client(BASE, TOKEN))


# --- paging ------------------------------------------------------------------------------------------------


def test_paged_walks_end_dated_windows_back_to_start():
    pages = {None: ["2010-01-04", "2026-11-09"], "20100103-23:59:59": ["2004-12-31", "2010-01-01"]}
    fake = FakeTransport(answer=lambda params: ok(document(pages[params.get("endDateTime")])))
    rows = client(fake).paged("SPY", start="2005-01-01")
    assert [row["date"] for row in rows] == ["2004-12-31", "2010-01-01", "2010-01-04", "2026-11-09"]
    assert [call["params"].get("endDateTime") for call in fake.calls] == [None, "20100103-23:59:59"]
    assert [call["params"]["duration"] for call in fake.calls] == ["22 Y", "6 Y"]


def test_paged_stops_on_empty_window_and_at_the_1990_floor():
    fake = FakeTransport(queue=[ok(document(["2000-01-03"])), ok(document([]))])
    assert [row["date"] for row in client(fake).paged("SPY")] == ["2000-01-03"]
    assert len(fake.calls) == 2 and fake.calls[0]["params"]["duration"] == "30 Y"
    fake = FakeTransport(queue=[ok(document(["1990-01-01", "2026-11-09"]))])
    client(fake).paged("SPY", start="1980-01-01")
    assert len(fake.calls) == 1


def test_adjusted_last_and_contfut_get_one_window_without_end_date():
    fake = FakeTransport(answer=lambda params: ok(document(["2000-01-03"])))
    client(fake).paged("SPY", start="1993-01-01", what="ADJUSTED_LAST")
    client(fake).paged("ES", start="1993-01-01", sec_type="CONTFUT", exchange="CME")
    assert len(fake.calls) == 2 and all("endDateTime" not in call["params"] for call in fake.calls)
    assert [call["params"]["duration"] for call in fake.calls] == ["30 Y", "30 Y"]


# --- contracts and per-kind rows ---------------------------------------------------------------------------


def test_contract_mapping():
    assert ih.contract_for("SPY") == ih.Contract("SPY")
    assert ih.contract_for("BRK-B") == ih.Contract("BRK B")
    assert ih.contract_for("^GSPC") == ih.Contract("SPX", "IND", "CBOE")
    assert ih.contract_for("^NDX") == ih.Contract("NDX", "IND", "NASDAQ")
    assert ih.contract_for("^VXSLV") == ih.Contract("VXSLV", "IND", "CBOE")
    assert ih.contract_for("ES=F") == ih.Contract("ES", "CONTFUT", "CME")
    assert ih.contract_for("GC=F") == ih.Contract("GC", "CONTFUT", "COMEX")
    assert ih.contract_for("EURUSD=X") == ih.Contract("EUR", "CASH", "IDEALPRO", "USD", "MIDPOINT")
    assert ih.contract_for("DX-Y.NYB") is None and ih.contract_for("^XYZ") is None


def test_adj_close_rows_join_trades_and_adjusted_last():
    def answer(params):
        if params["whatToShow"] == "ADJUSTED_LAST":
            return ok(document(["2020-01-02", "2020-01-03"], close=50.0))
        return ok(document(["2020-01-01", "2020-01-02", "2020-01-03"], close=100.0))
    fake = FakeTransport(answer=answer)
    rows = ih.ibkr_rows("SPY", start="2020-01-01", adjust="adj_close", client=client(fake))
    assert [(row["date"], row["close"], row["adj_close"]) for row in rows] == [
        ("2020-01-02", 101.0, 50.0), ("2020-01-03", 102.0, 51.0)]
    assert [call["params"]["whatToShow"] for call in fake.calls][:2] == ["ADJUSTED_LAST", "TRADES"]


def test_futures_use_the_latest_contfut_window_and_yields_come_in_percent():
    fake = FakeTransport(answer=lambda params: ok(document(["2026-11-09"], sec_type="CONTFUT")))
    rows = ih.ibkr_rows("ES=F", client=client(fake))
    assert fake.calls[0]["params"]["duration"] == f"{ih.CONTFUT_YEARS} Y" and rows[0]["adj_close"] == 100.0
    fake = FakeTransport(answer=lambda params: ok(document(["2026-11-09"], sec_type="IND", close=42.5, volume=None)))
    assert ih.ibkr_rows("^TNX", client=client(fake))[0]["close"] == pytest.approx(4.25)
    fake = FakeTransport(answer=lambda params: ok(document(["2026-11-09"], sec_type="IND", close=4.25, volume=None)))
    assert ih.ibkr_rows("^TNX", client=client(fake))[0]["close"] == 4.25


# --- merge seam --------------------------------------------------------------------------------------------


def bar(day: str, close: float, **extra) -> dict:
    return {"date": day, "open": close, "high": close, "low": close, "close": close, "volume": 1, **extra}


def source(name, rows=None, error=None, calls=None):
    def fetch():
        if calls is not None:
            calls.append(name)
        if error is not None:
            raise error
        return rows
    return ih.Source(name, fetch)


def test_ibkr_keeps_its_dates_and_yahoo_fills_before_its_first_date():
    ibkr = [bar("2020-01-03", 10.0), bar("2020-01-06", 11.0)]
    yahoo = [bar("2020-01-01", 1.0), bar("2020-01-02", 2.0), bar("2020-01-03", 3.0), bar("2020-01-06", 4.0),
             bar("2020-01-07", 5.0)]
    merged = ih.merge_sources([source("ibkr", ibkr), source("yahoo", yahoo)])
    assert [(row["date"], row["close"], row["source"]) for row in merged.rows] == [
        ("2020-01-01", 1.0, "yahoo"), ("2020-01-02", 2.0, "yahoo"),
        ("2020-01-03", 10.0, "ibkr"), ("2020-01-06", 11.0, "ibkr")]
    assert merged.sources == {"ibkr": {"rows": 2, "first": "2020-01-03", "last": "2020-01-06"},
                              "yahoo": {"rows": 2, "first": "2020-01-01", "last": "2020-01-02"}}
    assert merged.seams == [{"date": "2020-01-03", "newer": "ibkr", "older": "yahoo", "close_ratio": 10 / 3,
                             "rescaled": {}}]
    assert merged.errors == {}


def test_ibkr_failure_or_missing_configuration_falls_back_to_all_yahoo(monkeypatch):
    yahoo = [bar("2020-01-02", 2.0), bar("2020-01-03", 3.0)]
    merged = ih.merge_sources([source("ibkr", error=ih.IbkrHistoryError("UNAVAILABLE", "History request failed")),
                               source("yahoo", yahoo)])
    assert [row["source"] for row in merged.rows] == ["yahoo", "yahoo"]
    assert merged.errors == {"ibkr": "UNAVAILABLE: History request failed"}
    monkeypatch.delenv(ih.URL_ENV, raising=False)
    merged = ih.merged_daily("SPY", lambda: yahoo)
    assert [row["close"] for row in merged.rows] == [2.0, 3.0]
    assert merged.errors["ibkr"].startswith("NOT_CONFIGURED")


def test_adjusted_series_rescale_the_yahoo_part_at_the_seam():
    ibkr = [bar("2020-01-03", 20.0, adj_close=18.0)]
    yahoo = [bar("2020-01-02", 9.0, adj_close=8.0), bar("2020-01-03", 10.0, adj_close=9.0)]
    merged = ih.merge_sources([source("ibkr", ibkr), source("yahoo", yahoo)], rescale=ih.ADJUST_RESCALE["adj_close"])
    first = merged.rows[0]
    assert (first["close"], first["adj_close"]) == (9.0, 16.0)  # raw close untouched, adj_close x 2
    merged = ih.merge_sources([source("ibkr", ibkr), source("yahoo", yahoo)], rescale=ih.ADJUST_RESCALE["ohlc"])
    assert merged.rows[0]["close"] == 18.0 and merged.seams[0]["rescaled"] == {"close": 2.0}


def test_covered_start_skips_yahoo_and_rows_are_cut_to_the_window():
    calls: list[str] = []
    merged = ih.merge_sources([source("ibkr", [bar("2019-12-31", 1.0), bar("2020-01-02", 2.0),
                                               bar("2020-02-03", 3.0)], calls=calls),
                               source("yahoo", [bar("2019-01-02", 0.5)], calls=calls)],
                              start="2020-01-01", end="2020-02-01")
    assert calls == ["ibkr"] and [row["date"] for row in merged.rows] == ["2020-01-02"]


def test_yahoo_failure_keeps_ibkr_and_both_failing_raise_the_last_error():
    merged = ih.merge_sources([source("ibkr", [bar("2020-01-02", 2.0)]), source("yahoo", error=ValueError("rate"))],
                              start="2000-01-01")
    assert [row["source"] for row in merged.rows] == ["ibkr"] and merged.errors == {"yahoo": "ValueError: rate"}
    with pytest.raises(ValueError, match="rate"):
        ih.merge_sources([source("ibkr", error=ih.IbkrHistoryError("NOT_FOUND", "x")),
                          source("yahoo", error=ValueError("rate"))])


def test_unexpected_ibkr_errors_are_recorded_by_type_only():
    merged = ih.merge_sources([source("ibkr", error=RuntimeError(f"{BASE} {TOKEN}")),
                               source("yahoo", [bar("2020-01-02", 1.0)])])
    assert merged.errors == {"ibkr": "RuntimeError"}


# --- index fallback order ----------------------------------------------------------------------------------


def test_index_fallback_order_ibkr_yahoo_cboe(monkeypatch):
    calls: list[str] = []
    cboe_csv = "DATE,OPEN,HIGH,LOW,CLOSE\n01/02/2004,20,21,19,20.5\n01/05/2004,21,22,20,21.5\n"

    def fetch(url):
        calls.append("cboe")
        assert url == ih.CBOE_URL.format(name="RVX")
        return cboe_csv.encode()

    def yahoo():
        calls.append("yahoo")
        return [bar("2004-01-05", 99.0), bar("2010-01-04", 25.0)]

    def ibkr(symbol, *, start, adjust, client):
        calls.append("ibkr")
        assert (symbol, adjust) == ("^RVX", "none")
        return [bar("2010-01-04", 30.0, adj_close=30.0)]

    monkeypatch.setattr(ih, "ibkr_rows", ibkr)
    merged = ih.index_daily("^RVX", yahoo, fetch=fetch)
    assert calls == ["ibkr", "yahoo", "cboe"]
    assert [(row["date"], row["close"], row["source"]) for row in merged.rows] == [
        ("2004-01-02", 20.5, "cboe"), ("2004-01-05", 99.0, "yahoo"), ("2010-01-04", 30.0, "ibkr")]
    assert merged.rows[0]["adj_close"] == 20.5


def test_treasury_is_consulted_only_when_the_others_leave_the_start_uncovered(monkeypatch):
    calls: list[str] = []
    treasury = ('Date,"1 Mo","3 Mo","10 Yr"\n01/03/2000,5.0,5.3,6.6\n01/04/2000,5.0,,6.5\n')

    def fetch(url):
        calls.append(url.split("daily-treasury-rates.csv/")[1][:4])
        return treasury.encode()

    monkeypatch.setattr(ih, "ibkr_rows", lambda *a, **k: (_ for _ in ()).throw(ih.IbkrHistoryError("ENTITLEMENT", "x")))
    yahoo = [bar("2000-01-04", 6.4)]
    merged = ih.index_daily("^TNX", lambda: yahoo, fetch=fetch)  # open start, Yahoo answered: no Treasury
    assert calls == [] and [row["source"] for row in merged.rows] == ["yahoo"]
    merged = ih.index_daily("^TNX", lambda: yahoo, start="2000-01-01", end="2001-01-01", fetch=fetch)
    assert calls == ["2000", "2001"]
    assert [(row["date"], row["close"], row["source"]) for row in merged.rows] == [
        ("2000-01-03", 6.6, "treasury"), ("2000-01-04", 6.4, "yahoo")]
    calls.clear()
    merged = ih.index_daily("^IRX", lambda: [], start="2000-01-01", end="2000-06-01", fetch=fetch)
    assert calls == ["2000"] and [row["close"] for row in merged.rows] == [5.3]


def test_cboe_single_value_column_layout():
    text = "DATE,VXSLV\n03/16/2011,40.1\n03/17/2011,0\n"
    rows = ih.cboe_daily("VXSLV", fetch=lambda url: text.encode())
    assert [(row["date"], row["open"], row["close"], row["source"]) for row in rows] == [
        ("2011-03-16", 40.1, 40.1, "cboe")]



# --- script wiring (fake yfinance frames, fake IBKR transport) ---------------------------------------------

REPO = Path(__file__).resolve().parents[3]
SCRIPTS = {
    "analog": "research/backtests/analog-regime-flags/fetch_data.py",
    "calendar": "research/backtests/calendar-spread/fetch_data.py",
    "carousel": "research/backtests/carousel/fetch_data.py",
    "core7": "research/backtests/core7/fetch_data.py",
    "freestockalerts": "research/backtests/freestockalerts/fetch_yahoo.py",
    "qc_ports": "research/backtests/qc-ports/fetch_data.py",
    "quantjourney": "research/backtests/quantjourney/fetch_data.py",
    "sma30": "research/backtests/sma30-timing/fetch_data.py",
    "volsizing": "research/backtests/volsizing/fetch_ivx.py",
    "golden": "services/research/tests/golden/fetch_yahoo.py",
}


class FakeSeries:
    def __init__(self, pairs):
        self.pairs = pairs

    def items(self):
        return iter(self.pairs)


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows  # [(datetime, {"Open": ..., ...})]
        self.empty = not rows
        self.index = [ts for ts, _ in rows]

    def __len__(self):
        return len(self.rows)

    def iterrows(self):
        return iter(self.rows)

    def __getitem__(self, column):
        return FakeSeries([(ts, row[column]) for ts, row in self.rows])


def fake_yfinance(frames: dict, calls: list | None = None) -> types.ModuleType:
    module = types.ModuleType("yfinance")
    module.__version__ = "fake"

    class Ticker:
        def __init__(self, symbol):
            self.symbol = symbol
            self.splits = FakeSeries([])

        def history(self, **kwargs):
            if calls is not None:
                calls.append((self.symbol, kwargs))
            return FakeFrame(frames.get(self.symbol, []))

    module.Ticker = Ticker
    return module


def yahoo_frame(*days_closes, dividend=0.0):
    return [(datetime.fromisoformat(day), {"Open": close, "High": close + 1, "Low": close - 1, "Close": close,
                                           "Adj Close": close / 2, "Volume": 1000.0, "Dividends": dividend})
            for day, close in days_closes]


def load_script(name: str, monkeypatch, yf=None):
    monkeypatch.setitem(sys.modules, "yfinance", yf or fake_yfinance({}))
    monkeypatch.setitem(sys.modules, "xlrd", types.ModuleType("xlrd"))
    path = REPO / SCRIPTS[name]
    monkeypatch.syspath_prepend(str(path.parent))
    spec = importlib.util.spec_from_file_location(f"fetch_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def use_fake_ibkr(monkeypatch, answer):
    fake = FakeTransport(answer=answer)
    monkeypatch.setattr(ih.Client, "from_env", classmethod(lambda cls, env=None, **kw: client(fake)))
    return fake


def ibkr_spy(params):
    """IBKR from 2020-01-02: TRADES closes 100, 101; ADJUSTED_LAST closes 40, 41."""
    adjusted = params["whatToShow"] == "ADJUSTED_LAST"
    return ok(document(["2020-01-02", "2020-01-03"], close=40.0 if adjusted else 100.0))


@pytest.mark.parametrize("name", sorted(SCRIPTS))
def test_every_fetcher_names_the_ibkr_first_source(name, monkeypatch):
    module = load_script(name, monkeypatch)
    assert "IBKR first, Yahoo fills gaps" in " ".join(module.__doc__.split())
    assert module.ih is ih


def test_qc_ports_bars_keep_the_strict_header_and_record_sources(monkeypatch):
    module = load_script("qc_ports", monkeypatch)
    use_fake_ibkr(monkeypatch, ibkr_spy)
    yf = fake_yfinance({"SPY": yahoo_frame(("2019-12-31", 98.0), ("2020-01-02", 99.0))})
    rows, summary = module._bars(yf, "SPY", None)
    assert rows == ["date,open,high,low,close,adj_close",
                    "2019-12-31,98.000000,99.000000,97.000000,98.000000,39.595960",  # 49 x 40/49.5
                    "2020-01-02,100.000000,101.000000,99.000000,100.000000,40.000000",
                    "2020-01-03,101.000000,102.000000,100.000000,101.000000,41.000000"]
    assert summary["rows"]["ibkr"]["first"] == "2020-01-02" and summary["rows"]["yahoo"]["rows"] == 1


def test_qc_ports_cboe_only_index_without_ibkr(monkeypatch):
    module = load_script("qc_ports", monkeypatch)
    monkeypatch.delenv(ih.URL_ENV, raising=False)
    cboe = b"DATE,OPEN,HIGH,LOW,CLOSE\n01/02/2004,1,1,1,20.5\n01/05/2004,1,1,1,0\n"
    monkeypatch.setattr(module, "_get", lambda url: cboe)
    rows, summary = module._index(fake_yfinance({}), "RVX", "2004-01-03")
    assert rows == ["date,close", "2004-01-02,20.500000"]
    assert summary["errors"]["ibkr"].startswith("NOT_CONFIGURED") and "yahoo" not in summary["errors"]


def test_carousel_adjusted_file_takes_ibkr_bars_and_yahoo_dividends(monkeypatch, tmp_path):
    frames = {"SPY": yahoo_frame(("2019-12-31", 98.0), ("2020-01-02", 99.0), ("2020-01-03", 99.5), dividend=0.0)}
    frames["SPY"][2][1]["Dividends"] = 1.25
    module = load_script("carousel", monkeypatch, fake_yfinance(frames))
    use_fake_ibkr(monkeypatch, ibkr_spy)
    path, summary = module.fetch_prices("SPY", True, tmp_path)
    lines = path.read_text().splitlines()
    assert lines[0] == "date,open,high,low,close,dividend,source"
    assert lines[1].startswith("2019-12-31,") and lines[1].endswith(",yahoo")
    assert lines[3] == "2020-01-03,41.0,42.0,40.0,41.0,1.25,ibkr"
    assert summary["seams"][0]["rescaled"] == {"close": 40.0 / 99.0}


def test_sma30_falls_back_to_yahoo_without_ibkr(monkeypatch, tmp_path):
    module = load_script("sma30", monkeypatch, fake_yfinance({"BIL": yahoo_frame(("2020-01-02", 91.5))}))
    monkeypatch.delenv(ih.URL_ENV, raising=False)
    path, summary = module.fetch_prices("BIL", tmp_path)
    assert path.read_text() == "date,open,close,source\n2020-01-02,91.5,91.5,yahoo\n"
    assert summary["errors"]["ibkr"].startswith("NOT_CONFIGURED")


def test_quantlab_snapshot_merges_ibkr_and_yahoo(monkeypatch, tmp_path):
    from quantlab import data

    chart = {"chart": {"result": [{"meta": {"gmtoffset": -18000},
                                   "timestamp": [stamp("2019-12-31") + 52200, stamp("2020-01-02") + 52200],
                                   "indicators": {"quote": [{"open": [98.0, 99.0], "high": [99.0, 100.0],
                                                             "low": [97.0, 98.0], "close": [98.0, 99.0],
                                                             "volume": [10, 20]}],
                                                  "adjclose": [{"adjclose": [49.0, 49.5]}]}}]}}

    class Response:
        status, body = 200, json.dumps(chart).encode()

    fake = FakeTransport(answer=ibkr_spy)
    manifest = data.freeze("SPY", "2019-12-01", "2020-01-04", tmp_path, fetch=lambda url: Response(),
                           client=client(fake))
    text = Path(manifest["path"]).read_text().splitlines()
    assert text[0] == "date,open,high,low,close,adj_close,volume,source"
    assert text[1] == "2019-12-31,98.000000,99.000000,97.000000,98.000000,39.595960,10,yahoo"
    assert text[2] == "2020-01-02,100.000000,101.000000,99.000000,100.000000,40.000000,700,ibkr"
    assert manifest["source"].startswith("IBKR vertex-history daily")
    assert manifest["sources"]["rows"]["ibkr"]["rows"] == 2
    bars = data.load(manifest)
    assert [bar.adj_close for bar in bars] == [39.59596, 40.0, 41.0]
    assert data.yahoo_daily_csv("SPY", "2019-12-01", "2020-01-04", fetch=lambda url: Response()).startswith(
        b"date,open,high,low,close,adj_close,volume\n2019-12-31,98.000000")


def test_noise_band_daily_keeps_yahoo_dividends_and_new_york_dates(monkeypatch, tmp_path):
    from strategies import noise_band_retest as nbr

    yahoo = json.dumps({"chart": {"result": [{
        "meta": {"symbol": "SPY"},
        "timestamp": [stamp("2019-12-31") + 52200, stamp("2020-01-02") + 52200],
        "indicators": {"quote": [{"open": [1.0, 2.0], "high": [1.0, 2.0], "low": [1.0, 2.0], "close": [321.0, 322.0],
                                  "volume": [5, 6]}], "adjclose": [{"adjclose": [1.0, 2.0]}]},
        "events": {"dividends": {"1": {"date": stamp("2019-12-20") + 52200, "amount": 1.57}}}}]}}).encode()
    monkeypatch.delenv(ih.URL_ENV, raising=False)
    assert nbr.merge_daily(yahoo, "SPY") is yahoo  # without IBKR the Yahoo bytes are saved verbatim
    merged = nbr.merge_daily(yahoo, "SPY", client(FakeTransport(answer=ibkr_spy)))
    path = tmp_path / "SPY.json"
    path.write_bytes(merged)
    closes, divs = nbr.load_daily(str(path))
    assert closes == {date(2019, 12, 31): 321.0, date(2020, 1, 2): 100.0, date(2020, 1, 3): 101.0}
    assert divs == {date(2019, 12, 20): 1.57}
    assert json.loads(merged)["vertex_sources"]["rows"]["yahoo"]["rows"] == 1
