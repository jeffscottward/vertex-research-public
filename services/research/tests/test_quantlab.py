import copy
import hashlib
import json
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
