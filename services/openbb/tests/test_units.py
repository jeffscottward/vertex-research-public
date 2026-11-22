"""Unit tests: option math, value cleaning, row rules, transforms and the SEC guard."""

from __future__ import annotations

import asyncio
import math
from datetime import date

import pytest

from vertex_openbb import options_math as om
from vertex_openbb import rows, sec_guard, values
from vertex_openbb.jobs import cboe, cftc, finra, sec, series
from vertex_openbb.upstream import blocked_details, classify

AS_OF = date(2026, 11, 6)


def contract(exp: date, strike: float, call: bool, iv: float | None, delta: float, gamma: float, oi: int) -> om.Contract:
    return om.Contract(exp, strike, call, iv, delta, gamma, oi, 10)


def test_constant_maturity_interpolates_variance() -> None:
    got = om.constant_maturity([(20, 0.20), (40, 0.30)])
    want = math.sqrt((0.04 * 20 + (0.09 * 40 - 0.04 * 20) * 0.5) / 30)
    assert got == pytest.approx(want)
    assert om.constant_maturity([(45, 0.25)]) == 0.25  # flat outside the listed range
    assert om.constant_maturity([(0, 0.5), (30, None)]) is None


def test_iv_at_delta_and_atm() -> None:
    exp = date(2026, 12, 4)
    chain = [
        contract(exp, 95, True, 0.30, 0.70, 0.01, 1),
        contract(exp, 100, True, 0.22, 0.50, 0.02, 1),
        contract(exp, 105, True, 0.20, 0.30, 0.01, 1),
        contract(exp, 110, True, 0.18, 0.20, 0.01, 1),
        contract(exp, 100, False, 0.24, -0.50, 0.02, 1),
    ]
    assert om.iv_at_delta(chain, 0.25) == pytest.approx(0.19)
    assert om.iv_at_delta(chain, -0.25) is None
    assert om.atm(chain, 101) == (100, pytest.approx(0.23))


def test_gex_flip_and_walls() -> None:
    exp = date(2026, 11, 20)
    chain = [
        contract(exp, 90, False, 0.3, -0.2, 0.01, 1000),
        contract(exp, 100, True, 0.2, 0.5, 0.02, 500),
        contract(exp, 110, True, 0.2, 0.2, 0.01, 4000),
    ]
    daily, term = om.summarize("SPY", AS_OF, 100.0, chain)
    s2 = 100 * 100 * 100 * 0.01
    assert daily["netGex"] == pytest.approx(round(-0.01 * 1000 * s2 + 0.02 * 500 * s2 + 0.01 * 4000 * s2, 2))
    assert daily["gammaFlip"] == 110.0  # cumulative -10000, 0 (no sign), +40000: flips at 110
    assert daily["callWall"] == 110.0 and daily["putWall"] == 90.0
    assert term[0]["dte"] == 14 and term[0]["callOi"] == 4500 and daily["contracts"] == 3


def test_gamma_flip_none_without_sign_change() -> None:
    assert om.gamma_flip({90.0: -5.0, 100.0: -1.0}, 95) is None
    assert om.gamma_flip({90.0: -5.0, 100.0: 6.0, 120.0: -3.0}, 101) == 100.0


def test_same_day_expiration_is_left_out() -> None:
    today_exp, later = AS_OF, date(2026, 11, 20)
    chain = [
        contract(today_exp, 100, True, 0.9, 0.5, 0.5, 100000),  # huge 0DTE gamma
        contract(today_exp, 100, False, 0.9, -0.5, 0.5, 100000),
        contract(later, 100, True, 0.2, 0.5, 0.02, 500),
        contract(later, 95, False, 0.25, -0.3, 0.01, 800),
    ]
    daily, term = om.summarize("SPY", AS_OF, 100.0, chain)
    assert [t["expiration"] for t in term] == ["2026-11-20"]
    assert daily["contracts"] == 2 and daily["callOi"] == 500 and daily["putOi"] == 800
    s2 = 100 * 100 * 100 * 0.01
    assert daily["netGex"] == pytest.approx(round(0.02 * 500 * s2 - 0.01 * 800 * s2, 2))
    assert daily["callWall"] == 100.0 and daily["putWall"] == 95.0


def test_parse_contracts_skips_non_occ_and_expired() -> None:
    options = [
        {"option": "B1SPY261113C00710000", "iv": 0.2},
        {"option": "SPY261113C00710000", "iv": "NaN", "open_interest": 5.0},
        {"option": "SPY261030P00710000", "iv": 0.2},
    ]
    parsed, skipped = om.parse_contracts(options, AS_OF)
    assert skipped == 1 and len(parsed) == 1 and parsed[0].iv is None and parsed[0].strike == 710.0


def test_values() -> None:
    assert values.num(float("nan")) is None and values.num(float("inf")) is None and values.num(".") is None
    assert values.num(10**400) is None and values.num("1e400") is None and values.count(10**400) is None
    assert values.utf16_len("a\U0001F600\ud800") == 4
    assert values.cut("ab\U0001F600cd", 3) == "ab" and values.cut("abcdef", 4, "…") == "abc…"
    assert values.cut("x" * 100000, 10) == "x" * 10
    assert values.num("1,234.5") == 1234.5 and values.num(True) is None
    assert values.count(12.6) == 13 and values.count(-1) is None
    assert values.iso_date("20261106") == "2026-11-06" and values.iso_date("2026-02-30") is None
    assert values.clock("2:00 p.m.") == "14:00" and values.clock("12:00 a.m.") == "00:00"
    assert values.clock("10:30 AM") == "10:30" and values.clock("noon") is None
    assert values.plain_text("&lt;p&gt;Two-day&lt;br /&gt;meeting&lt;/p&gt;", 100) == "Two-day meeting"


def test_row_rules() -> None:
    ok = {"date": "2026-11-06", "factor": "mom", "frequency": "daily", "value": 0.1}
    assert rows.row_problem("factor_returns", ok) is None
    assert rows.row_problem("factor_returns", {**ok, "value": float("nan")})
    assert rows.row_problem("factor_returns", {**ok, "date": "2026-02-30"})
    assert rows.row_problem("factor_returns", {**ok, "extra": 1})
    kept, problems = rows.validate_rows("factor_returns", [ok, {**ok, "value": 0.2}, {**ok, "value": None}])
    assert kept == [{**ok, "value": 0.2}] and len(problems) == 1


def test_cftc_transform() -> None:
    item = {"date": "2026-11-03", "open_interest_all": 10, "dealer_positions_long_all": 1,
            "dealer_positions_short_all": 2, "dealer_positions_spread_all": 3}
    out = cftc.transform("ES", "13874A", "tff", [item])
    assert out == [{"category": "dealer", "long": 1, "market": "ES", "marketCode": "13874A", "openInterest": 10,
                    "reportDate": "2026-11-03", "reportType": "tff", "short": 2, "spreading": 3}]


def test_regsho_and_fred_parsing() -> None:
    text = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261106|SPY|7.6|1|17.4|B,Q\n20261106|ZZ|1|0|2|Q\n"
    assert finra.parse_regsho(text, {"SPY"}) == [
        {"date": "2026-11-06", "shortExemptVolume": 1, "shortVolume": 8, "symbol": "SPY", "totalVolume": 17}
    ]
    csv_text = "observation_date,T10Y2Y\n2026-11-05,0.5\n2026-11-06,.\n"
    assert [r["value"] for r in series.parse_fred_csv("T10Y2Y", csv_text, "2026-01-01")] == [0.5]


def test_13f_units_follow_the_filing_date_and_prn_has_no_shares() -> None:
    data = [
        {"cusip": "037833100", "issuer": "APPLE INC", "value": 100, "security_type": "SH", "principal_amount": 10,
         "period_ending": "2022-09-30"},
        {"cusip": "037833100", "issuer": "APPLE INC", "value": 50, "security_type": "PRN", "principal_amount": 7,
         "period_ending": "2022-09-30"},
        {"cusip": "912828XX0", "issuer": "UST NOTE", "value": 5, "security_type": "PRN", "principal_amount": 9,
         "period_ending": "2022-09-30"},
    ]
    universe = {"037833100": "AAPL"}
    # Q3-2022 report filed in November 2022: thousands of dollars.
    out = {r["cusip"]: r for r in sec.holdings_rows("1067983", "BERKSHIRE", "2022-09-30", data, universe, "2022-11-14")}
    assert out["037833100"]["value"] == 150000 and out["037833100"]["shares"] == 10 and out["037833100"]["symbol"] == "AAPL"
    assert out["912828XX0"]["shares"] is None and out["912828XX0"]["symbol"] is None
    # Q4-2022 report filed in February 2023: already dollars.
    q4 = [{**data[0], "period_ending": "2022-12-31"}]
    assert sec.holdings_rows("1067983", "BERKSHIRE", "2022-12-31", q4, {}, "2023-02-14")[0]["value"] == 100
    # A filing submitted on 2023-01-02 is still in thousands; on 2023-01-03 in dollars.
    assert sec.holdings_rows("1067983", "B", "2022-12-31", q4, {}, "2023-01-02")[0]["value"] == 100000
    assert sec.holdings_rows("1067983", "B", "2022-12-31", q4, {}, "2023-01-03")[0]["value"] == 100
    # No filing date: periods before 2022-12-31 count as thousands.
    assert sec.holdings_rows("1067983", "B", "2022-09-30", data[:1], {})[0]["value"] == 100000
    assert sec.holdings_rows("1067983", "B", "2022-12-31", q4, {})[0]["value"] == 100


def test_rates_are_percent_rounded() -> None:
    from vertex_openbb.jobs.macro import percent_point

    assert percent_point("EFFR", "2026-11-05", 0.038900000000000004)["value"] == 3.89
    assert percent_point("EFFR", "2026-11-05", "NaN")["value"] is None


def test_classify_and_call_timeout() -> None:
    from vertex_openbb import upstream

    class OpenBBError(Exception):
        pass

    assert upstream.classify(OpenBBError("No Form 4 data was returned for AAPL.")).kind == "empty"
    assert upstream.classify(RuntimeError("no data here")).kind == "error"
    assert upstream.classify(RuntimeError("SEC request failed with HTTP 404: x")).kind == "not_found"

    async def slow() -> None:
        await asyncio.sleep(2)

    with pytest.raises(upstream.UpstreamError) as caught:
        asyncio.run(upstream.Upstream(timeout_s=0.05)._call("k", slow))
    assert "timed out" in caught.value.message


def test_sec_helpers() -> None:
    assert sec.accession_from_url("https://www.sec.gov/Archives/edgar/data/320193/000114036126042149/form4.xml") == (
        "320193", "0001140361-26-042149")
    assert sec.ftd_period_end("202609a") == date(2026, 9, 15) and sec.ftd_period_end("202612b") == date(2026, 12, 31)
    assert sec.quarter_ends(date(2026, 5, 9), date(2026, 11, 8)) == 2
    picked, notes = sec.pick_filings(
        [
            {"report_type": "13F-HR/A", "report_date": "2026-06-30", "filing_date": "2026-09-02", "complete_submission_url": "https://a"},
            {"report_type": "13F-HR", "report_date": "2026-06-30", "filing_date": "2026-08-14", "complete_submission_url": "https://b"},
            {"report_type": "13F-HR", "report_date": "2026-03-31", "filing_date": "2026-05-15", "complete_submission_url": "https://c"},
        ],
        1,
    )
    assert picked == [("2026-06-30", "https://b", "2026-08-14", None)] and len(notes) == 1
    # Accession: the listing field, else the complete submission file name.
    assert sec.filing_accession({"accession_number": "0001193125-26-352200"}) == "0001193125-26-352200"
    assert sec.filing_accession({"complete_submission_url": "https://www.sec.gov/Archives/edgar/data/1/0001104659-26-097200.txt"}) == "0001104659-26-097200"
    assert sec.validate_accessions([]) == frozenset()
    with pytest.raises(ValueError):
        sec.validate_filers(["12x"])


def test_sec_user_agent() -> None:
    agent = sec_guard.user_agent({"VERTEX_RESEARCH_CONTACT_EMAIL": "a@example.org"})
    assert agent == "vertex-research openbb (personal research; a@example.org)"
    for bad in ({}, {"VERTEX_RESEARCH_CONTACT_EMAIL": "x"}, {"VERTEX_RESEARCH_CONTACT_EMAIL": "a b@c.org"}):
        with pytest.raises(sec_guard.ContactError):
            sec_guard.user_agent(bad)


def test_sec_guard_sets_agent_rate_and_strips_on_redirect(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.request

    import aiohttp
    import requests

    seen: list[tuple[str, str | None]] = []

    def fake_send(self, request, **kwargs):  # noqa: ANN001, ANN003
        seen.append((request.url, request.headers.get("User-Agent")))

    class Response:
        def __init__(self, status: int, location: str | None) -> None:
            self.status = status
            self.headers = {"Location": location} if location else {}

        def release(self) -> None:
            return None

    async def fake_async(self, method, url, **kwargs):  # noqa: ANN001, ANN003
        seen.append((str(url), (kwargs.get("headers") or {}).get("User-Agent")))
        assert kwargs.get("allow_redirects") is False
        return Response(302, "https://example.com/next") if "sec.gov" in str(url) else Response(200, None)

    monkeypatch.setattr(requests.Session, "send", fake_send)
    monkeypatch.setattr(aiohttp.ClientSession, "_request", fake_async)
    sec_guard.uninstall()
    limiter = sec_guard.install("UA test", rate=1000)
    try:
        requests.Session().get("https://www.sec.gov/x", headers={"User-Agent": "placeholder"})
        requests.Session().get("https://cdn.finra.org/y")
        asyncio.run(aiohttp.ClientSession._request(object(), "GET", "https://data.sec.gov/z", headers={"User-Agent": "p"}))
        assert sec_guard.is_sec_host(b"https://www.sec.gov/a") and not sec_guard.is_sec_host("https://notsec.gov.example.com")
    finally:
        sec_guard.uninstall()
    assert seen[0] == ("https://www.sec.gov/x", "UA test")
    assert seen[1][0] == "https://cdn.finra.org/y" and seen[1][1] != "UA test"
    assert seen[2] == ("https://data.sec.gov/z", "UA test")
    assert seen[3][0] == "https://example.com/next" and seen[3][1] is None
    assert limiter.granted == 2
    slow = sec_guard.RateLimiter(10)
    waits = [slow.reserve() for _ in range(5)]
    assert waits[-1] == pytest.approx(0.4, abs=0.02)


def test_urllib_redirect_hops(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.request

    sec_guard.uninstall()
    sec_guard.install("UA test", rate=1000)
    try:
        opened: list[urllib.request.Request] = []

        class Opener:
            def __init__(self, *handlers: object) -> None:
                self.handler = handlers[0]()  # type: ignore[operator]

            def open(self, req: urllib.request.Request, *args: object) -> str:
                opened.append(req)
                hop = self.handler.redirect_request(req, None, 302, "Found", {}, "https://other.example/x")
                opened.append(hop)
                back = self.handler.redirect_request(hop, None, 302, "Found", {}, "https://www.sec.gov/y")
                opened.append(back)
                return "ok"

        monkeypatch.setattr(urllib.request, "build_opener", Opener)
        assert urllib.request.urlopen("https://www.sec.gov/start") == "ok"
    finally:
        sec_guard.uninstall()
    assert [r.get_header("User-agent") for r in opened] == ["UA test", None, "UA test"]


def test_ftd_links_only_sec_https_and_real_months() -> None:
    page = (
        '<a href="/files/data/other/fails-deliver-data/cnsfails202610a.zip">'
        '<a href="files/data/fails-deliver-data/cnsfails202609b.zip">'
        '<a href="https://evil.example/cnsfails202609a.zip">'
        '<a href="http://www.sec.gov/files/cnsfails202608b.zip">'
        '<a href="/files/data/fails-deliver-data/cnsfails202613a.zip">'
    )
    links, skipped = sec.ftd_links(page)
    assert links == {
        "202610a": "https://www.sec.gov/files/data/other/fails-deliver-data/cnsfails202610a.zip",
        "202609b": "https://www.sec.gov/data-research/sec-markets-data/files/data/fails-deliver-data/cnsfails202609b.zip",
    }
    assert len(skipped) == 3 and sec.ftd_period_end("202613a") is None and sec.ftd_period_end("202600b") is None


def test_row_rules_mirror_the_zod_bounds() -> None:
    assert rows.row_problem("vx_curve", {"asOf": "2026-11-06", "contractMonth": "2026-11", "price": 0})
    assert rows.row_problem("daily_series", {"close": 10**400, "date": "2026-11-05", "high": None, "low": None,
                                             "open": None, "seriesId": "VIX"})
    assert rows.row_problem("daily_series", {"close": 1, "date": "\uff12026-11-05", "high": None, "low": None,
                                             "open": None, "seriesId": "VIX"})


class FakeResponseError(Exception):
    """Shape of aiohttp.ClientResponseError: `status` and `request_info.real_url`."""

    def __init__(self, status: int | None, url: str | None, message: str = "") -> None:
        super().__init__(f"{status}, message={message!r}, url={url!r}")
        self.status = status
        self.request_info = type("RequestInfo", (), {"real_url": url})()


class ContentTypeError(FakeResponseError):
    """Same class name as aiohttp.ContentTypeError (the classifier reads the name)."""


CBOE_URL = "https://CDN-API.cboe.com/api/global/delayed_quotes/options/SPY.json"
HTML = "Attempt to decode JSON with unexpected mimetype: text/html; charset=utf-8"


def test_blocked_details_reads_status_and_host() -> None:
    assert blocked_details(ContentTypeError(403, CBOE_URL, HTML)) == (403, "cdn-api.cboe.com")
    assert blocked_details(FakeResponseError(429, CBOE_URL)) == (429, "cdn-api.cboe.com")
    # A bot check page with HTTP 200 is a block; other statuses without an HTML page are not.
    assert blocked_details(ContentTypeError(200, CBOE_URL, HTML)) == (200, "cdn-api.cboe.com")
    assert blocked_details(ContentTypeError(200, CBOE_URL, "unexpected mimetype: text/plain")) is None
    # An HTML error page of another status (wrong URL, gateway outage) is a plain failure.
    assert blocked_details(ContentTypeError(404, CBOE_URL, HTML)) is None
    assert blocked_details(ContentTypeError(502, CBOE_URL, HTML)) is None
    assert blocked_details(FakeResponseError(500, CBOE_URL)) is None
    assert blocked_details(FakeResponseError(403, None)) is None
    assert blocked_details(FakeResponseError(None, CBOE_URL)) is None
    assert blocked_details(FakeResponseError(True, CBOE_URL)) is None  # type: ignore[arg-type]
    assert blocked_details(ValueError("403")) is None

    class HttpError(Exception):  # shape of requests.HTTPError
        response = type("Response", (), {"status_code": 429, "url": "https://api.finra.org/data?x=1"})()

    assert blocked_details(HttpError("429 Client Error")) == (429, "api.finra.org")


def test_blocked_details_reads_the_real_aiohttp_and_requests_errors() -> None:
    import aiohttp
    import requests
    from multidict import CIMultiDict, CIMultiDictProxy
    from yarl import URL

    info = aiohttp.RequestInfo(URL(CBOE_URL), "GET", CIMultiDictProxy(CIMultiDict()), URL(CBOE_URL))
    refused = aiohttp.ContentTypeError(info, (), status=403, message=HTML)
    assert blocked_details(refused) == (403, "cdn-api.cboe.com")
    assert classify(refused).kind == "blocked"
    assert blocked_details(aiohttp.ClientResponseError(info, (), status=500, message="down")) is None

    response = requests.Response()
    response.status_code = 429
    response.url = "https://api.finra.org/data/group/otcMarket?limit=1"
    limited = requests.HTTPError("429 Client Error: Too Many Requests", response=response)
    assert blocked_details(limited) == (429, "api.finra.org")


def test_plain_http_files_keep_their_own_error_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    import requests

    from vertex_openbb import upstream

    statuses = iter([429, 429, 500, 500, 403, 404, 200])

    def get(url: str, **_kwargs: object) -> requests.Response:
        response = requests.Response()
        response.status_code = next(statuses)
        response.url = url
        response._content = b"\xef\xbb\xbfa,b\n"
        return response

    monkeypatch.setattr(requests, "get", get)
    monkeypatch.setattr(upstream.time, "sleep", lambda _seconds: None)
    url = "https://www.cboe.com/us/futures/market_statistics/settlement/csv?dt=2026-11-19"
    for status in (429, 500):  # after one retry: a plain failure, never `blocked`
        with pytest.raises(upstream.UpstreamError) as failed:
            upstream._get_text(url, {})
        assert (failed.value.kind, failed.value.status) == ("error", None)
        assert failed.value.message == f"HTTP {status} from https://www.cboe.com/us/futures/market_statistics/settlement/csv"
    with pytest.raises(upstream.UpstreamError) as refused:
        upstream._get_text(url, {})
    assert refused.value.kind == "forbidden"
    assert upstream._get_text(url, {}) is None
    assert upstream._get_text(url, {}) == "a,b\n"


def test_classify_marks_a_refused_request_as_blocked() -> None:
    error = classify(ContentTypeError(403, CBOE_URL, HTML))
    assert (error.kind, error.status, error.host) == ("blocked", 403, "cdn-api.cboe.com")
    assert error.message.startswith("ContentTypeError: 403")
    plain = classify(RuntimeError("HTTP 404 for x"))
    assert (plain.kind, plain.status, plain.host) == ("not_found", None, None)
    assert classify(FakeResponseError(500, CBOE_URL)).kind == "error"


def test_recorded_errors_keep_status_and_host() -> None:
    from vertex_openbb.upstream import RecordingUpstream, ReplayUpstream, UpstreamError

    async def refuse() -> None:
        raise ContentTypeError(403, CBOE_URL, HTML)

    recorder = RecordingUpstream()
    with pytest.raises(UpstreamError):
        asyncio.run(recorder._call("helper:x", refuse))
    assert recorder.records[0]["error"]["status"] == 403 and recorder.records[0]["error"]["host"] == "cdn-api.cboe.com"
    with pytest.raises(UpstreamError) as replayed:
        asyncio.run(ReplayUpstream(recorder.records)._call("helper:x", refuse))
    assert (replayed.value.kind, replayed.value.status, replayed.value.host) == ("blocked", 403, "cdn-api.cboe.com")

    async def fail() -> None:
        raise RuntimeError("boom")

    with pytest.raises(UpstreamError):
        asyncio.run(recorder._call("helper:y", fail))
    assert recorder.records[1]["error"] == {"kind": "error", "message": "RuntimeError: boom"}


def test_settlement_rows_keeps_monthly_vx_contracts() -> None:
    text = (
        "Product,Symbol,Expiration Date,Price\r\n"
        "VX,VX/Z6,2026-12-16,22.1837\r\nVX,VX/X6,2026-11-18,23.6945\r\nVX,VX45/X6,2026-11-10,23.9\r\n"
        "VXM,VXM/X6,2026-11-18,23.6945\r\nAMB1,AMB1/X6,2026-11-30,3.9\r\n"
    )
    assert cboe.settlement_rows(date(2026, 11, 6), text) == [
        {"asOf": "2026-11-06", "contractMonth": "2026-11", "price": 23.6945},
        {"asOf": "2026-11-06", "contractMonth": "2026-12", "price": 22.1837},
    ]
    assert cboe.settlement_rows(date(2026, 11, 8), "Product,Symbol,Expiration Date,Price\r\n") == []
    assert cboe.settlement_rows(date(2026, 11, 8), "") == []
    with pytest.raises(ValueError, match="no expiration date for VX/X6"):
        cboe.settlement_rows(date(2026, 11, 6), "Product,Symbol,Expiration Date,Price\nVX,VX/X6,soon,23.7\n")
    # A contract without a settlement price is not a row.
    no_price = "Product,Symbol,Expiration Date,Price\nVX,VX/X6,2026-11-18,\nVX,VX/Z6,2026-12-16,n/a\n"
    assert cboe.settlement_rows(date(2026, 11, 6), no_price) == []
    assert cboe.CFE_FALLBACK_NOTE == "used the CFE settlement file"


def test_curve_rows_drops_outliers_and_handles_edge_cases() -> None:
    day = date(2026, 11, 19)
    # Reproduces 2026-11-19: 2027-08 at 15.9 next to 2027-07 at 24.6 (-35.4%).
    back_outlier = [
        {"date": "2026-11-19", "expiration": "2026-12", "price": 23.2},
        {"date": "2026-11-19", "expiration": "2027-01", "price": 23.6},
        {"date": "2026-11-19", "expiration": "2027-02", "price": 24.0},
        {"date": "2026-11-19", "expiration": "2027-07", "price": 24.6},
        {"date": "2026-11-19", "expiration": "2027-08", "price": 15.9},
    ]
    warnings: list[str] = []
    kept = cboe.curve_rows(day, back_outlier, warn=warnings.append)
    assert [r["contractMonth"] for r in kept] == ["2026-12", "2027-01", "2027-02", "2027-07"]
    assert len(warnings) == 1 and "2027-08" in warnings[0] and "15.9" in warnings[0] and "2027-07" in warnings[0]

    # Interior outlier drops only itself; healthy endpoints remain.
    warnings.clear()
    interior = [
        {"date": "2026-11-19", "expiration": "2027-01", "price": 23.5},
        {"date": "2026-11-19", "expiration": "2027-02", "price": 24.0},
        {"date": "2026-11-19", "expiration": "2027-03", "price": 12.0},
        {"date": "2026-11-19", "expiration": "2027-04", "price": 24.2},
    ]
    kept = cboe.curve_rows(day, interior, warn=warnings.append)
    assert [r["contractMonth"] for r in kept] == ["2027-01", "2027-02", "2027-04"]
    assert len(warnings) == 1 and "2027-03" in warnings[0] and "2027-02" in warnings[0] and "2027-04" in warnings[0]

    # Front-month outlier drops only itself.
    warnings.clear()
    front = [
        {"date": "2026-11-19", "expiration": "2026-12", "price": 10.0},
        {"date": "2026-11-19", "expiration": "2027-01", "price": 23.5},
        {"date": "2026-11-19", "expiration": "2027-02", "price": 23.8},
    ]
    kept = cboe.curve_rows(day, front, warn=warnings.append)
    assert [r["contractMonth"] for r in kept] == ["2027-01", "2027-02"]
    assert len(warnings) == 1 and "2026-12" in warnings[0]

    # Exact 20% boundary is kept without warning.
    warnings.clear()
    boundary = [
        {"date": "2026-11-19", "expiration": "2027-01", "price": 25.0},
        {"date": "2026-11-19", "expiration": "2027-02", "price": 25.0},
        {"date": "2026-11-19", "expiration": "2027-03", "price": 20.0},
    ]
    assert len(cboe.curve_rows(day, boundary, warn=warnings.append)) == 3 and warnings == []

    # Two-contract mismatch warns without dropping either contract.
    warnings.clear()
    two = [
        {"date": "2026-11-19", "expiration": "2026-12", "price": 24.0},
        {"date": "2026-11-19", "expiration": "2027-01", "price": 15.0},
    ]
    assert len(cboe.curve_rows(day, two, warn=warnings.append)) == 2 and len(warnings) == 1

    # Missing/zero/non-finite prices and malformed contract months never crash and pass through for row validation.
    warnings.clear()
    mixed = [
        {"date": "2026-11-19", "expiration": "", "price": 23.0},
        {"date": "2026-11-19", "expiration": "2027-13", "price": 23.0},
        {"date": "2026-11-19", "expiration": "2026-12", "price": None},
        {"date": "2026-11-19", "expiration": "2027-01", "price": 0},
        {"date": "2026-11-19", "expiration": "2027-02", "price": 23.5},
        {"date": "2026-11-19", "expiration": "2027-03", "price": 24.0},
        {"date": "2026-11-19", "expiration": "2027-04", "price": 14.0},
    ]
    kept = cboe.curve_rows(day, mixed, warn=warnings.append)
    assert "2027-04" not in [r["contractMonth"] for r in kept]
    assert {"", "2027-13", "2026-12", "2027-01", "2027-02", "2027-03"} == {r["contractMonth"] for r in kept}
    assert len(warnings) == 1
    # Direct call to filter_curve_outliers passes non-finite prices through without crashing.
    inf_rows = [
        {"asOf": "2026-11-19", "contractMonth": "2026-12", "price": float("inf")},
        {"asOf": "2026-11-19", "contractMonth": "2027-01", "price": 23.5},
    ]
    assert len(cboe.filter_curve_outliers(inf_rows)) == 2
    # CFE settlement_rows also filters outliers when warn is wired.
    warnings.clear()
    cfe_outlier = (
        "Product,Symbol,Expiration Date,Price\r\n"
        "VX,VX/Z6,2026-12-16,23.5\r\n"
        "VX,VX/F7,2027-01-20,24.0\r\n"
        "VX,VX/G7,2027-02-17,14.0\r\n"
    )
    settled = cboe.settlement_rows(day, cfe_outlier, warn=warnings.append)
    assert [r["contractMonth"] for r in settled] == ["2026-12", "2027-01"]
    assert len(warnings) == 1 and "2027-02" in warnings[0]


# --- bsm_delta_gamma and the Yahoo conversion -----------------------------------------------------


def test_bsm_delta_gamma_known_values() -> None:
    # Rate 0.04, exact math.erf; values verified 2026-11-21 (the plan's known-value table).
    delta, gamma = om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, 0, True)
    assert delta == pytest.approx(0.617911, abs=1e-6)
    assert gamma == pytest.approx(0.019069, abs=1e-6)
    put_delta, put_gamma = om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, 0, False)
    assert put_delta == pytest.approx(-0.382089, abs=1e-6)
    assert put_gamma == pytest.approx(gamma, abs=1e-9)  # gamma is equal across sides
    # call delta - put delta = e^(-q*T)
    for q in (0.0, 0.01, 0.05):
        c, _ = om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, q, True)
        p, _ = om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, q, False)
        assert c - p == pytest.approx(math.exp(-q * 1.0), abs=1e-9)
    deep_otm, deep_gamma = om.bsm_delta_gamma(100, 70, 0.08, 0.25, 0.04, 0, False)
    assert deep_otm == pytest.approx(-1.49e-7, abs=1e-9)
    assert deep_gamma == pytest.approx(1.12e-7, abs=1e-9)
    itm, _ = om.bsm_delta_gamma(100, 130, 0.5, 0.3, 0.04, 0.01, True)
    assert itm == pytest.approx(0.143847, abs=1e-6)


def test_bsm_delta_gamma_domain_and_dividend_clamp() -> None:
    for bad in ((0, 100, 1.0, 0.2), (100, 0, 1.0, 0.2), (100, 100, 0.0, 0.2), (100, 100, 1.0, 0.0),
                (100, 100, -1.0, 0.2), (float("nan"), 100, 1.0, 0.2), (100, 100, 1.0, float("inf"))):
        assert om.bsm_delta_gamma(*bad, 0.04, 0, True) == (None, None)
    # A negative dividend yield clamps to 0 (the TS adapter's rule).
    assert om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, -0.01, True) == om.bsm_delta_gamma(100, 100, 1.0, 0.2, 0.04, 0, True)
    assert om.RISK_FREE_RATE == 0.04


def test_bsm_delta_gamma_matches_the_typescript_black_scholes() -> None:
    # Recorded outputs of packages/api/src/options-chain-greeks.ts blackScholes (bun, 2026-11-21).
    # The TS normalCdf uses the Abramowitz-Stegun erf approximation (error < 1.5e-7), so the
    # cross-language tolerance is 2e-7, not 1e-9.
    import json
    from pathlib import Path

    table = json.loads((Path(__file__).parent / "fixtures" / "inline" / "bsm-ts-parity.json").read_text())
    assert len(table) >= 8
    for case in table:
        delta, gamma = om.bsm_delta_gamma(case["spot"], case["strike"], case["years"], case["volatility"],
                                          case["rate"], case["dividendYield"], case["right"] == "call")
        assert delta == pytest.approx(case["delta"], abs=2e-7), case
        assert gamma == pytest.approx(case["gamma"], abs=2e-7), case


def yahoo_payload() -> dict:
    return {
        "quote": {"regularMarketPrice": 100.0, "regularMarketTime": 1795208400, "trailingAnnualDividendYield": 0.01},
        "expirations": ["2026-12-18"],
        "chains": {
            "2026-12-18": {
                "calls": [
                    {"contractSymbol": "SPY261218C00100000", "strike": 100.0, "impliedVolatility": 0.2, "openInterest": 10, "volume": 5},
                    {"contractSymbol": "B1SPY261218C00100000", "strike": 100.0, "impliedVolatility": 0.2, "openInterest": 1, "volume": 1},
                    {"contractSymbol": "SPY261218C00101000", "strike": 101.0, "impliedVolatility": 1e-5, "openInterest": 5000, "volume": 2},
                ],
                "puts": [{"contractSymbol": "SPY261218P00100000", "strike": 100.0, "impliedVolatility": 0.22, "openInterest": 8, "volume": 3}],
            }
        },
    }


def test_yahoo_contracts_of_parses_and_floors_sentinel_iv() -> None:
    from vertex_openbb import yahoo_chains

    as_of = date(2026, 11, 21)
    spot, contracts, skipped, missing = yahoo_chains.contracts_of(yahoo_payload(), as_of)
    assert spot == 100.0 and skipped == 1 and missing == 0
    assert len(contracts) == 3  # the non-OCC row is skipped; the sentinel row stays for OI
    atm_call = next(c for c in contracts if c.is_call and c.strike == 100.0)
    assert atm_call.iv == 0.2 and atm_call.delta is not None and atm_call.gamma is not None
    sentinel = next(c for c in contracts if c.strike == 101.0)
    assert sentinel.iv is None and sentinel.delta is None and sentinel.gamma is None
    assert sentinel.open_interest == 5000  # OI/volume survive the floor
    # The sentinel does not move the ATM mean: strike 100 has both sides, 101 has no usable IV.
    strike, iv = om.atm(contracts, spot)
    assert strike == 100.0 and iv == pytest.approx((0.2 + 0.22) / 2)


def test_yahoo_contracts_of_edge_cases() -> None:
    from vertex_openbb import yahoo_chains

    payload = yahoo_payload()
    with pytest.raises(ValueError, match="no underlying price"):
        yahoo_chains.contracts_of({**payload, "quote": {}}, date(2026, 11, 21))
    # An expiration missing from chains is counted, not an error.
    listed = {**payload, "expirations": ["2026-12-18", "2027-01-15"]}
    _, _, _, missing = yahoo_chains.contracts_of(listed, date(2026, 11, 21))
    assert missing == 1
    # Expired contracts are left out; a bad ISO expiration counts its rows as skipped.
    past = {**payload, "chains": {"2026-11-20": payload["chains"]["2026-12-18"], "soon": payload["chains"]["2026-12-18"]}}
    _, contracts, skipped, _ = yahoo_chains.contracts_of(past, date(2026, 11, 21))
    assert contracts == [] and skipped == 4


def test_yahoo_quote_day_converts_epoch_to_new_york_and_caps() -> None:
    from vertex_openbb import yahoo_chains

    payload = yahoo_payload()  # 1795208400 = 2026-11-20 16:00 ET
    assert yahoo_chains.quote_day(payload, date(2026, 11, 21)) == date(2026, 11, 20)
    assert yahoo_chains.quote_day(payload, date(2026, 11, 20)) == date(2026, 11, 20)
    assert yahoo_chains.quote_day(payload, date(2026, 11, 19)) == date(2026, 11, 19)  # cap at today
    for bad in (None, 0, -5, "soon"):
        with pytest.raises(ValueError, match="no quote time"):
            yahoo_chains.quote_day({**payload, "quote": {"regularMarketTime": bad}}, date(2026, 11, 21))


def test_yahoo_fetch_symbol_first_empty_chain_continues(monkeypatch: pytest.MonkeyPatch) -> None:
    """The first expiration's empty chain must not stop the symbol; later chains still load."""
    import types
    import pandas as pd
    from vertex_openbb import yahoo_chains

    calls: list[str | None] = []

    class FakeTicker:
        def __init__(self, symbol: str) -> None:
            self._expirations = {"2026-12-18": 1, "2027-01-15": 2}

        def option_chain(self, date: str | None = None):
            calls.append(date)
            if date is None:
                # First request: quote + expirations, but an empty first chain.
                return types.SimpleNamespace(calls=None, puts=None,
                                             underlying={"regularMarketPrice": 100.0, "regularMarketTime": 1795208400,
                                                         "trailingAnnualDividendYield": 0.0})
            if date == "2026-12-18":
                return types.SimpleNamespace(calls=None, puts=None, underlying=None)
            frame = pd.DataFrame([{"contractSymbol": "SPY270115C00100000", "strike": 100.0,
                                   "impliedVolatility": 0.2, "openInterest": 10, "volume": 5}])
            return types.SimpleNamespace(calls=frame, puts=frame, underlying=None)

    monkeypatch.setitem(__import__("sys").modules, "yfinance", types.SimpleNamespace(Ticker=FakeTicker))
    monkeypatch.setattr(yahoo_chains, "REQUEST_SPACING_S", 0)
    payload = yahoo_chains.fetch_symbol("SPY")
    assert calls == [None, "2026-12-18", "2027-01-15"]
    assert payload["expirations"] == ["2026-12-18", "2027-01-15"]
    assert list(payload["chains"]) == ["2027-01-15"]  # the two empty expirations are left out
    assert payload["quote"]["regularMarketPrice"] == 100.0
    _, contracts, _, missing = yahoo_chains.contracts_of(payload, date(2026, 11, 21))
    assert len(contracts) == 2 and missing == 1


def test_yahoo_fetch_symbol_no_chains_at_all_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    import types
    from vertex_openbb import yahoo_chains

    class EmptyTicker:
        def __init__(self, symbol: str) -> None:
            self._expirations = {}

        def option_chain(self, date: str | None = None):
            return types.SimpleNamespace(calls=None, puts=None, underlying={})

    monkeypatch.setitem(__import__("sys").modules, "yfinance", types.SimpleNamespace(Ticker=EmptyTicker))
    with pytest.raises(ValueError, match="no option chain returned"):
        yahoo_chains.fetch_symbol("SPY")


def test_yahoo_fetch_symbol_normal_path_keeps_the_first_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    """The list request's first chain is kept (one request per remaining expiration only)."""
    import types
    import pandas as pd
    from vertex_openbb import yahoo_chains

    calls: list[str | None] = []
    frame = pd.DataFrame([{"contractSymbol": "SPY261218C00100000", "strike": 100.0,
                           "impliedVolatility": 0.2, "openInterest": 10, "volume": 5}])

    class FakeTicker:
        def __init__(self, symbol: str) -> None:
            self._expirations = {"2026-12-18": 1, "2027-01-15": 2}

        def option_chain(self, date: str | None = None):
            calls.append(date)
            if date is None:
                return types.SimpleNamespace(calls=frame, puts=None,
                                             underlying={"regularMarketPrice": 100.0, "regularMarketTime": 1795208400,
                                                         "trailingAnnualDividendYield": 0.0})
            return types.SimpleNamespace(calls=frame, puts=frame, underlying=None)

    monkeypatch.setitem(__import__("sys").modules, "yfinance", types.SimpleNamespace(Ticker=FakeTicker))
    monkeypatch.setattr(yahoo_chains, "REQUEST_SPACING_S", 0)
    payload = yahoo_chains.fetch_symbol("SPY")
    assert calls == [None, "2027-01-15"]  # the first chain came with the list request
    assert payload["chains"]["2026-12-18"]["puts"] == []  # a None side becomes an empty list
    assert len(payload["chains"]["2027-01-15"]["calls"]) == 1


def test_yahoo_contracts_of_skips_rows_without_a_strike() -> None:
    from vertex_openbb import yahoo_chains

    payload = yahoo_payload()
    payload["chains"]["2026-12-18"]["calls"].append(
        {"contractSymbol": "SPY261218C00102000", "strike": None, "impliedVolatility": 0.2, "openInterest": 1, "volume": 1})
    payload["chains"]["2026-12-18"]["calls"].append(
        {"contractSymbol": "SPY261218C00103000", "strike": 0, "impliedVolatility": 0.2, "openInterest": 1, "volume": 1})
    _, contracts, skipped, _ = yahoo_chains.contracts_of(payload, date(2026, 11, 21))
    assert skipped == 3  # the non-OCC row plus the two strike-less rows
    assert len(contracts) == 3


def test_yahoo_quote_day_out_of_range_timestamp_is_a_payload_error() -> None:
    from vertex_openbb import yahoo_chains

    payload = yahoo_payload()
    payload["quote"]["regularMarketTime"] = 1e20  # finite for num(), out of range for fromtimestamp
    with pytest.raises(ValueError, match="out of range"):
        yahoo_chains.quote_day(payload, date(2026, 11, 21))
