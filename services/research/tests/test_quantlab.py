import copy
import hashlib
import json
import socket
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pytest

from quantlab import data, engine, ssrn
from quantlab.backtest import run_spec, trades_from_weights
from quantlab.spec import SpecError, build_spec, spec_sha256, validate

DRAFT = json.loads((Path(__file__).resolve().parents[1] / "quantlab/drafts/zakamulin-2013-sma-timing.json").read_text())
ITEM = {"DOI": "10.2139/ssrn.2242795", "title": ["The Real-Life Performance of Market Timing"],
        "author": [{"given": "Valeriy", "family": "Zakamulin"}], "posted": {"date-parts": [[2013, 3, 29]]},
        "deposited": {"date-time": "2020-01-01T00:00:00Z"}, "abstract": "<jats:p>Out-of-sample &amp; costs.</jats:p>"}


def capture(**changes):
    return {**ssrn.capture_from_crossref(ITEM, topic="t", captured_at="2026-10-18T00:00:00Z").to_dict(), **changes}


def fetcher(routes):
    def fetch(url):
        for prefix, response in routes.items():
            if url.startswith(prefix):
                return response
        raise AssertionError(f"unexpected fetch {url}")
    return fetch


def openalex(*urls):
    body = json.dumps({"results": [{"best_oa_location": None,
                                    "locations": [{"is_oa": True, "pdf_url": u} for u in urls]}]}).encode()
    return ssrn.HttpResponse(200, "application/json", body)


# SSRN capture

def test_crossref_item_maps_identity_version_and_plain_abstract():
    c = capture()
    assert (c["doi"], c["ssrn_id"], c["year"], c["posted"]) == ("10.2139/ssrn.2242795", "2242795", 2013, "2013-03-29")
    assert c["version"] == "crossref-deposited:2020-01-01T00:00:00Z"
    assert c["abstract"] == "Out-of-sample & costs."
    assert c["authors"] == ["Valeriy Zakamulin"]


def test_double_escaped_entities_decode_to_plain_text():
    item = {**ITEM, "title": ["Different Protection:&amp;nbsp;Put Ladder &amp;amp; Trend"],
            "abstract": "<jats:p>Tail&amp;nbsp;risk &amp;amp; costs.</jats:p>"}
    c = ssrn.capture_from_crossref(item, topic="t", captured_at="x").to_dict()
    assert c["title"] == "Different Protection: Put Ladder & Trend"
    assert c["abstract"] == "Tail risk & costs."


def test_non_ssrn_doi_is_rejected():
    with pytest.raises(ValueError):
        ssrn.ssrn_id_from_doi("10.1000/xyz")


def test_no_open_access_copy_is_metadata_only(tmp_path):
    c = ssrn.capture_from_crossref(ITEM, topic="t", captured_at="x")
    out = ssrn.retain_pdf(c, tmp_path, fetch=fetcher({ssrn.OPENALEX: openalex()}))
    assert out.pdf_status == "metadata_only:no_free_copy" and out.pdf_sha256 is None
    assert list(tmp_path.iterdir()) == []


def test_ssrn_hosts_are_never_fetched_and_html_is_not_retained(tmp_path):
    c = ssrn.capture_from_crossref(ITEM, topic="t", captured_at="x")
    fetch = fetcher({ssrn.OPENALEX: openalex("https://papers.ssrn.com/x.pdf", "https://oa.test/a.pdf"),
                     "https://oa.test/": ssrn.HttpResponse(200, "text/html", b"<html>login</html>")})
    out = ssrn.retain_pdf(c, tmp_path, fetch=fetch)
    assert out.pdf_status == "metadata_only:free_copy_unreachable"


def test_free_pdf_is_retained_with_hash(tmp_path):
    body = b"%PDF-1.4 test"
    c = ssrn.capture_from_crossref(ITEM, topic="t", captured_at="x")
    fetch = fetcher({ssrn.OPENALEX: openalex("https://oa.test/a.pdf"),
                     "https://oa.test/": ssrn.HttpResponse(200, "application/pdf", body)})
    out = ssrn.retain_pdf(c, tmp_path, fetch=fetch)
    assert out.pdf_status == "retained" and out.pdf_sha256 == hashlib.sha256(body).hexdigest()
    assert Path(out.pdf_path).read_bytes() == body


# Spec builder

def test_spec_binds_paper_and_freezes_hash():
    spec = build_spec(capture(), DRAFT)
    assert spec["paper"]["doi"] == "10.2139/ssrn.2242795" and spec["spec_sha256"] == spec_sha256(spec)
    changed = copy.deepcopy(spec)
    changed["costs"]["slippage_bps"] = 3
    assert spec_sha256(changed) != spec["spec_sha256"]


def test_missing_exit_and_unknown_criterion_are_rejected():
    draft = copy.deepcopy(DRAFT)
    del draft["exit"]
    with pytest.raises(SpecError, match="missing exit"):
        build_spec(capture(), draft)
    draft = copy.deepcopy(DRAFT)
    draft["validation"]["rejection_criteria"] = [{"check": "looks_good"}]
    with pytest.raises(SpecError, match="rejection_criteria"):
        build_spec(capture(), draft)


def test_full_text_claim_without_retained_copy_is_rejected():
    draft = copy.deepcopy(DRAFT)
    draft["paper_claims"].append({"locator": "table", "quote": "Table 3"})
    with pytest.raises(SpecError, match="no full-text copy"):
        build_spec(capture(), draft)


def test_leverage_is_rejected():
    draft = copy.deepcopy(DRAFT)
    draft["sizing"]["weight"] = 2
    assert any("sizing.weight" in e for e in validate({**draft, "spec_version": 1, "paper": {"doi": "10.1", "version": "v"}}))


# Engine

def bars(n=1200, seed=7):
    out, price, day, state = [], 100.0, date(2000, 1, 3), seed
    while len(out) < n:
        if day.weekday() < 5:
            state = (state * 1103515245 + 12345) % 2**31
            change = (state / 2**31 - 0.48) * 0.03
            open_ = price * (1 + change / 3)
            price = price * (1 + change)
            out.append(data.Bar(day.isoformat(), open_, price, price))
        day += timedelta(days=1)
    return out


def sim(b, **kw):
    args = dict(signal_type="price_above_sma", lookback=3, unit="months", rebalance="monthly", execution="next_open",
                weight=1.0, costs=engine.Costs(0.5, 0.5, 1.0))
    args.update(kw)
    return engine.simulate(b, [0.0] * len(b), **args)


def test_no_lookahead_future_prices_do_not_change_past_returns():
    b = bars()
    k = 700
    altered = b[:k] + [data.Bar(x.date, x.open * 3, x.close * 3, x.adj_close * 3) for x in b[k:]]
    a, z = sim(b), sim(altered)
    assert a.returns[:k] == z.returns[:k] and a.weights[:k] == z.weights[:k]


def test_position_changes_only_after_a_month_end_decision():
    b = bars()
    run = sim(b)
    dates = [x.date for x in b]
    for i in range(1, len(b)):
        if run.weights[i] != run.weights[i - 1]:
            assert dates[i - 1][:7] != dates[i][:7], "fill must be on the first session after month end"


def test_costs_reduce_returns_by_traded_notional():
    b = bars()
    free, paid = sim(b, costs=engine.Costs(0, 0, 0)), sim(b)
    assert free.weights == paid.weights
    switches = sum(1 for x, y in zip(paid.weights, paid.weights[1:]) if x != y)
    assert switches > 0
    ratio = 1.0
    for r0, r1 in zip(free.returns, paid.returns):
        ratio *= (1 + r1) / (1 + r0)
    assert ratio == pytest.approx((1 - 2e-4) ** switches, rel=1e-9)


def test_cash_earns_rate_when_out_of_market():
    b = bars(300)
    rf = [0.0001] * len(b)
    run = engine.simulate(b, rf, signal_type="price_above_sma", lookback=400, unit="days", rebalance="daily",
                          execution="next_open", weight=1.0, costs=engine.Costs(0, 0, 0))
    assert all(w == 0 for w in run.weights)
    assert all(r == pytest.approx(0.0001) for r in run.returns[1:])


def test_walk_forward_tests_only_after_training_windows():
    b = bars(3000)
    spec = build_spec(capture(), {**DRAFT, "validation": {**DRAFT["validation"], "walk_forward": {
        "train_years": 3, "test_years": 1, "lookback_grid": [2, 4, 6], "objective": "sharpe"}}})
    wf = engine.walk_forward(b, [0.0] * len(b), spec=spec, costs=engine.Costs(0.5, 0.5, 1), start=b[0].date)
    assert len(wf["folds"]) >= 5
    for fold in wf["folds"]:
        assert fold["train_end"] < fold["test_start"] <= fold["test_end"]
    assert wf["dates"] == sorted(set(wf["dates"]))


def test_trades_follow_weight_changes():
    b = bars(10)
    dates = [x.date for x in b]
    weights = [0, 1, 1, 0, 0, 1, 1, 1, 0, 0]
    trades = trades_from_weights(dates, weights, b, engine.Costs(0, 0, 0), "next_open", "SPY")
    assert [(t["entry_t"], t["exit_t"]) for t in trades] == [(dates[1], dates[3]), (dates[5], dates[8])]
    held = trades_from_weights(dates, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1], b, engine.Costs(0, 0, 0), "next_open", "SPY")
    assert len(held) == 1 and held[0]["regime"] == "open at period end" and held[0]["exit_px"] == round(b[-1].adj_close, 4)


def test_run_spec_produces_a_backtests_page_record():
    b = bars(4000)
    spec = build_spec(capture(), {**DRAFT, "validation": {**DRAFT["validation"], "in_sample_end": "2008-12-31",
                                                          "walk_forward": {"train_years": 4, "test_years": 2,
                                                                           "lookback_grid": [3, 6, 10], "objective": "sharpe"}}})
    result = run_spec(spec, b, None, data_label="synthetic")
    assert result["verdict"] in ("promising", "inconclusive", "rejected")
    assert len(result["equity"]) <= 5000 and len(result["benchmark"]["points"]) == len(result["equity"])
    assert result["periodStart"] <= result["periodEnd"] and result["folds"]
    assert set(result["isSplit"]) == {"in_sample", "out_of_sample"}
    # The engine is a runConfig field; the strategy label does not name it.
    assert result["runConfig"]["engine"] == result["engine"] == "stdlib-daily-v1"
    assert result["strategy"].endswith("(walk-forward)")


def test_frozen_snapshot_hash_mismatch_is_rejected(tmp_path):
    path = tmp_path / "x.csv"
    path.write_text("date,open,high,low,close,adj_close,volume\n2020-01-02,1,1,1,1,1,0\n")
    manifest = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    assert len(data.load(manifest)) == 1
    path.write_text("date,open,high,low,close,adj_close,volume\n2020-01-02,2,1,1,1,1,0\n")
    with pytest.raises(ValueError, match="hash mismatch"):
        data.load(manifest)


def test_redirect_to_ssrn_is_not_retained(tmp_path):
    c = ssrn.capture_from_crossref(ITEM, topic="t", captured_at="x")
    fetch = fetcher({ssrn.OPENALEX: openalex("https://oa.test/a.pdf"),
                     "https://oa.test/": ssrn.HttpResponse(200, "application/pdf", b"%PDF-1.4", "https://papers.ssrn.com/x.pdf")})
    assert ssrn.retain_pdf(c, tmp_path, fetch=fetch).pdf_status == "metadata_only:free_copy_unreachable"


class NoNetwork:
    def open(self, *args, **kwargs):
        raise AssertionError("the guard must refuse before any connection")


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "http://oa.test/a.pdf",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/a.pdf",
    "https://100.64.0.1/a.pdf",
    "https://[::1]/a.pdf",
    "https://user:pw@oa.test/a.pdf",
    "https://oa.test:8443/a.pdf",
])
def test_http_fetch_refuses_non_public_or_non_https_urls(url, monkeypatch):
    # The pdf_url comes from third-party OpenAlex data, so it is untrusted.
    monkeypatch.setattr(ssrn.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setattr(ssrn, "_OPENER", NoNetwork())
    with pytest.raises(ssrn.UnsafeUrl):
        ssrn.http_fetch(url)


def test_http_fetch_refuses_a_public_name_that_resolves_to_a_private_address(monkeypatch):
    monkeypatch.setattr(ssrn.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.0.0.5", 443))])
    monkeypatch.setattr(ssrn, "_OPENER", NoNetwork())
    with pytest.raises(ssrn.UnsafeUrl):
        ssrn.http_fetch("https://oa.test/a.pdf")


def test_redirects_are_checked_at_every_hop(monkeypatch):
    monkeypatch.setattr(ssrn.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.0.0.5", 443))])
    handler = ssrn._CheckedRedirectHandler()
    with pytest.raises(ssrn.UnsafeUrl):
        handler.redirect_request(None, None, 302, "Found", {}, "http://169.254.169.254/")
    with pytest.raises(ssrn.UnsafeUrl):
        handler.redirect_request(None, None, 302, "Found", {}, "https://internal.test/")


def test_http_fetch_refuses_a_host_that_does_not_resolve(monkeypatch):
    def unresolvable(*args, **kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(ssrn.socket, "getaddrinfo", unresolvable)
    monkeypatch.setattr(ssrn, "_OPENER", NoNetwork())
    with pytest.raises(ssrn.UnsafeUrl, match="does not resolve"):
        ssrn.http_fetch("https://oa.test/a.pdf")


@pytest.mark.parametrize("address", [
    "::ffff:127.0.0.1",  # IPv4-mapped
    "::127.0.0.1",  # IPv4-compatible (global on some Python versions)
    "64:ff9b::a9fe:a9fe",  # NAT64 of 169.254.169.254
    "2002:a00:5::1",  # 6to4 of 10.0.0.5
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # Teredo
])
def test_http_fetch_refuses_ipv6_forms_that_embed_an_ipv4_address(address, monkeypatch):
    monkeypatch.setattr(ssrn.socket, "getaddrinfo", lambda *a, **k: [(10, 1, 6, "", (address, 443, 0, 0))])
    monkeypatch.setattr(ssrn, "_OPENER", NoNetwork())
    with pytest.raises(ssrn.UnsafeUrl):
        ssrn.http_fetch("https://oa.test/a.pdf")


def test_a_safe_redirect_hop_is_followed(monkeypatch):
    monkeypatch.setattr(ssrn.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    original = urllib.request.Request("https://oa.test/a.pdf")
    follow = ssrn._CheckedRedirectHandler().redirect_request(original, None, 302, "Found", {}, "https://oa.test/b.pdf")
    assert follow is not None and follow.full_url == "https://oa.test/b.pdf"


class FakeSocket:
    def __init__(self, peer: str):
        self.peer = peer
        self.closed = False

    def getpeername(self):
        return (self.peer, 443)

    def close(self):
        self.closed = True


@pytest.mark.parametrize("peer", ["127.0.0.1", "169.254.169.254", "100.64.0.1", "fe80::1%eth0", "::ffff:10.0.0.5"])
def test_the_connection_refuses_a_non_public_peer_after_dns_rebinding(peer, monkeypatch):
    # The URL check saw a public address; the connection then reached a private one.
    sock = FakeSocket(peer)

    def connect(self):
        self.sock = sock

    monkeypatch.setattr(ssrn.http.client.HTTPSConnection, "connect", connect)
    connection = ssrn._PublicPeerHTTPSConnection("oa.test", 443)
    with pytest.raises(ssrn.UnsafeUrl, match="non-public"):
        connection.connect()
    assert sock.closed and connection.sock is None


def test_the_connection_keeps_a_public_peer(monkeypatch):
    sock = FakeSocket("93.184.216.34")

    def connect(self):
        self.sock = sock

    monkeypatch.setattr(ssrn.http.client.HTTPSConnection, "connect", connect)
    connection = ssrn._PublicPeerHTTPSConnection("oa.test", 443)
    connection.connect()
    assert connection.sock is sock and not sock.closed


def test_the_opener_uses_no_proxy_and_the_checked_handlers(monkeypatch):
    monkeypatch.setattr(ssrn, "_OPENER", None)
    monkeypatch.setenv("https_proxy", "http://10.0.0.5:3128")
    opener = ssrn._opener()
    assert ssrn._opener() is opener
    kinds = {type(handler) for handler in opener.handlers}
    assert {ssrn._PublicPeerHTTPSHandler, ssrn._CheckedRedirectHandler} <= kinds
    assert all(not handler.proxies for handler in opener.handlers
               if isinstance(handler, urllib.request.ProxyHandler))
    assert urllib.request.HTTPSHandler not in kinds


def test_the_https_handler_opens_with_the_peer_checked_connection(monkeypatch):
    seen = {}

    def do_open(self, connection_class, req, **kwargs):
        seen["class"] = connection_class
        return "response"

    monkeypatch.setattr(ssrn._PublicPeerHTTPSHandler, "do_open", do_open)
    request = urllib.request.Request("https://oa.test/a.pdf")
    assert ssrn._PublicPeerHTTPSHandler().https_open(request) == "response"
    assert seen["class"] is ssrn._PublicPeerHTTPSConnection
