"""Unit tests: option math, value cleaning, row rules, transforms and the SEC guard."""

from __future__ import annotations

import asyncio
import math
from datetime import date

import pytest

from vertex_openbb import options_math as om
from vertex_openbb import rows, sec_guard, values
from vertex_openbb.jobs import cftc, finra, sec, series

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


def test_13f_values_before_2023_are_thousands_and_prn_has_no_shares() -> None:
    data = [
        {"cusip": "037833100", "issuer": "APPLE INC", "value": 100, "security_type": "SH", "principal_amount": 10,
         "period_ending": "2022-12-31"},
        {"cusip": "037833100", "issuer": "APPLE INC", "value": 50, "security_type": "PRN", "principal_amount": 7,
         "period_ending": "2022-12-31"},
        {"cusip": "912828XX0", "issuer": "UST NOTE", "value": 5, "security_type": "PRN", "principal_amount": 9,
         "period_ending": "2022-12-31"},
    ]
    out = {r["cusip"]: r for r in sec.holdings_rows("1067983", "BERKSHIRE", "2022-12-31", data, {"037833100": "AAPL"})}
    assert out["037833100"]["value"] == 150000 and out["037833100"]["shares"] == 10 and out["037833100"]["symbol"] == "AAPL"
    assert out["912828XX0"]["shares"] is None and out["912828XX0"]["symbol"] is None
    later = sec.holdings_rows("1067983", "BERKSHIRE", "2023-03-31", [{**data[0], "period_ending": "2023-03-31"}], {})
    assert later[0]["value"] == 100


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
    assert picked == [("2026-06-30", "https://b")] and len(notes) == 1
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
