"""QuantMind mining over Quant Lab captures: fixture captures only, no network or model."""
import json
from pathlib import Path

import pytest

from agents import quantmind_cli
from agents.external_research import _order_keys
from agents.quantmind_mining import (
    LocalCaptureClient, MineOptions, build_knowledge, capture_sha256, detect, lookback_from_text, mine,
    topic_folder_name, write_outputs,
)
from quantlab import __main__ as quantlab_cli
from quantlab.spec import build_spec, validate

STAMP = "2026-10-20T06:15:00Z"


def cap(ssrn_id, title, abstract, **changes):
    base = {"doi": f"10.2139/ssrn.{ssrn_id}", "ssrn_id": str(ssrn_id), "title": title, "authors": ["A. Author"],
            "year": 2020, "posted": "2020-01-02", "version": "crossref-deposited:2020-01-03T00:00:00Z",
            "abstract": abstract, "url": f"https://doi.org/10.2139/ssrn.{ssrn_id}", "topic": "market timing",
            "captured_at": STAMP, "pdf_status": "metadata_only:no_free_copy", "pdf_sha256": None,
            "pdf_bytes": None, "pdf_path": None, "pdf_source_url": None, "metadata_source": "crossref", "notes": []}
    return {**base, **changes}


SMA = cap(1001, "Market Timing with a Moving Average",
          "We study a 10-month moving average rule for market timing on the stock index. "
          "The rule holds stocks when the price is above the average and cash otherwise. "
          "Market timing lowers the drawdown but transaction costs reduce the gain.")
TSMOM = cap(1002, "Time-Series Momentum and Market Timing",
            "This paper tests 12-month time-series momentum as a market timing rule. "
            "Momentum timing is evaluated out of sample. We find a higher Sharpe ratio for the timing rule.")
CROSS = cap(1003, "Cross-Sectional Momentum in Stocks",
            "We rank stocks by past returns and buy winners and short losers. "
            "Cross-sectional momentum profits survive market timing controls.")
OPTIONS = cap(1004, "Put Ladders for Market Timing",
              "We study put options strategies and market timing of option overlays with implied volatility.")
UNRELATED = cap(1005, "Corporate Bond Liquidity", "Bond dealers hold inventory.")


@pytest.fixture()
def captures(tmp_path):
    folder = tmp_path / "quantlab" / "captures"
    folder.mkdir(parents=True)
    bundle = {"captured_at": STAMP, "captures": [SMA, TSMOM, CROSS]}
    (folder / "search-20261020T061500Z.json").write_text(json.dumps(bundle))
    (folder / "ssrn-1004.json").write_text(json.dumps(OPTIONS))
    (folder / "ssrn-1005.json").write_text(json.dumps(UNRELATED))
    # Same DOI and version captured later: the earlier capture wins.
    (folder / "ssrn-1001.json").write_text(json.dumps({**SMA, "captured_at": "2026-10-27T06:15:00Z"}))
    (folder / "notes.json").write_text(json.dumps({"hello": "world"}))
    (folder / "broken.json").write_text("{not json")
    return folder


def run(folder, **options):
    return mine(LocalCaptureClient(folder), "moving average momentum market timing",
                MineOptions(min_confidence=0.25, **options))


# Client ingest and search

def test_client_loads_dedupes_and_skips_bad_files(captures):
    client = LocalCaptureClient(captures)
    ids = client.sources()
    assert len(ids) == 5
    sma_id = next(i for i in ids if i.startswith("ssrn-1001-"))
    record = client.record(sma_id)
    assert record.capture["captured_at"] == STAMP and record.capture_sha256 == capture_sha256(SMA)
    assert record.capture_file == "search-20261020T061500Z.json"
    assert sorted(s["file"] for s in client.skipped) == ["broken.json", "notes.json"]
    title, text, url = client.fetch(sma_id)
    assert title == SMA["title"] and SMA["abstract"] in text and url == SMA["url"]


def test_knowledge_search_ranks_captured_papers(captures):
    knowledge, by_source, duplicates = build_knowledge(LocalCaptureClient(captures))
    assert duplicates == [] and len(by_source) == 5
    refs = knowledge.search("moving average market timing")
    assert by_source[refs[0].raw["source_id"]].startswith("ssrn-1001-") and refs[0].confidence == 1.0
    assert all(not by_source[r.raw["source_id"]].startswith("ssrn-1005-") for r in refs)


def test_retained_text_is_searchable_only_from_papers_folder(tmp_path):
    folder, papers = tmp_path / "captures", tmp_path / "papers"
    folder.mkdir(); papers.mkdir()
    retained = cap(2001, "A Paper", "Short abstract.", pdf_status="retained", pdf_sha256="ab" * 32,
                   pdf_path="/elsewhere/ssrn-2001-abababababab.pdf")
    (folder / "ssrn-2001.json").write_text(json.dumps(retained))
    (papers / "ssrn-2001-abababababab.txt").write_text("Volatility managed portfolios scale exposure.")
    client = LocalCaptureClient(folder)
    record = client.record(client.sources()[0])
    assert record.retained_text and record.retained_text_sha256
    knowledge, _, _ = build_knowledge(client)
    assert knowledge.search("volatility managed")[0].confidence == 1.0


# Mining

def test_mined_drafts_pass_quantlab_spec_validation(captures, tmp_path):
    result = run(captures)
    counts = result["report"]["counts"]
    assert (counts["drafted"], counts["rejected"]) == (2, 2)
    signals = {d["signal"]["type"] for d in result["drafts"].values()}
    assert signals == {"price_above_sma", "momentum"}
    for draft in result["drafts"].values():
        capture = result["captures"][draft["mining"]["capture_id"]]
        spec = build_spec(capture, draft)
        assert validate(spec) == [] and spec["paper"]["doi"] == capture["doi"]
        assert draft["mining"]["capture_sha256"] == capture_sha256(capture)
        assert _order_keys(draft) == set()
        for claim in draft["paper_claims"]:
            assert set(claim) == {"locator", "quote"}
            assert claim["quote"] in (capture["abstract"] if claim["locator"] == "abstract" else capture["title"])
        assert set(draft["our_reading"]) == {"interpretation", "gaps", "assumptions", "deviations"}
        assert draft["universe"]["instruments"] == ["SPY"] and draft["sizing"]["weight"] == 1.0
    sma = next(d for d in result["drafts"].values() if d["signal"]["type"] == "price_above_sma")
    assert (sma["signal"]["lookback"], sma["signal"]["lookback_unit"]) == (10, "months")
    # The quantlab CLI freezes a written draft against its written capture copy.
    out, report = write_outputs(result, tmp_path / "mined")
    row = next(r for r in report["candidates"] if r["status"] == "drafted")
    home = tmp_path / "home"
    import os
    old = os.environ.get("QUANTLAB_HOME")
    os.environ["QUANTLAB_HOME"] = str(home)
    try:
        assert quantlab_cli.main(["spec", "--capture", str(out / row["capture_file"]),
                                  "--draft", str(out / row["draft_file"])]) == 0
    finally:
        os.environ.pop("QUANTLAB_HOME") if old is None else os.environ.__setitem__("QUANTLAB_HOME", old)
    frozen = json.loads(next((home / "specs").iterdir()).read_text())
    assert frozen["spec_sha256"] == row["validated_spec_sha256"]


def test_unsupported_papers_are_rejected_with_reasons(captures):
    rows = {r["doi"]: r for r in run(captures)["report"]["candidates"]}
    assert rows[CROSS["doi"]]["status"] == "rejected"
    assert "cross-sectional" in rows[CROSS["doi"]]["reason"]
    assert rows[OPTIONS["doi"]]["status"] == "rejected"
    assert rows[OPTIONS["doi"]]["reason"].startswith("no supported signal")
    assert UNRELATED["doi"] not in rows


def test_spec_validation_failure_is_a_rejection_not_a_guess(tmp_path):
    folder = tmp_path / "captures"
    folder.mkdir()
    (folder / "ssrn-3001.json").write_text(json.dumps({**SMA, "doi": "10.2139/ssrn.3001", "ssrn_id": "3001",
                                                      "version": ""}))
    result = mine(LocalCaptureClient(folder), "moving average", MineOptions())
    row = result["report"]["candidates"][0]
    assert row["status"] == "rejected" and "paper.version required" in row["reason"]
    assert result["drafts"] == {}


def test_output_is_deterministic(captures, tmp_path):
    first, _ = write_outputs(run(captures), tmp_path / "a")
    second, _ = write_outputs(run(captures), tmp_path / "b")
    files = sorted(p.relative_to(first) for p in first.rglob("*.json"))
    assert files == sorted(p.relative_to(second) for p in second.rglob("*.json")) and len(files) == 5
    assert all((first / f).read_bytes() == (second / f).read_bytes() for f in files)


def test_detection_and_lookback_rules():
    assert detect("Trend", "We use a 200-day moving average.").signal == "price_above_sma"
    assert lookback_from_text("the 200-day moving average", "price_above_sma")[:2] == (200, "days")
    assert lookback_from_text("twelve-month momentum", "momentum")[:2] == (12, "months")
    assert lookback_from_text("the 200-day moving average", "momentum") is None
    assert detect("Momentum", "Long-short momentum portfolios.").signal is None
    assert detect("Pairs", "Pairs trading with cointegration.").reason.startswith("no supported signal")
    arima = detect("ARIMA and Random Forests", "An autoregressive integrated moving average model of sales.")
    assert arima.signal is None and "model or indicator name" in arima.reason
    assert detect("Trading with Moving Average Convergence Divergence (MACD)", "We tune MACD.").signal is None
    triple = detect("Evaluating Triple Moving Average Strategy Profitability", "Three moving averages.")
    assert triple.signal is None and "several moving averages" in triple.reason
    noted = detect("Market Timing with Moving Averages", "A combination of moving averages is also tested.")
    assert noted.signal == "price_above_sma" and "rules that combine several moving averages" in noted.unsupported


def test_days_lookback_draft_keeps_paper_value_in_grid(tmp_path):
    folder = tmp_path / "captures"
    folder.mkdir()
    paper = cap(4001, "Trend Rules", "A 200-day moving average rule reduces drawdown.")
    (folder / "ssrn-4001.json").write_text(json.dumps(paper))
    draft = next(iter(mine(LocalCaptureClient(folder), "moving average", MineOptions())["drafts"].values()))
    assert draft["signal"] == {"type": "price_above_sma", "lookback": 200, "lookback_unit": "days"}
    assert 200 in draft["validation"]["walk_forward"]["lookback_grid"]


# CLI

def test_cli_mine_writes_report_and_drafts(captures, tmp_path, capsys):
    out = tmp_path / "mined"
    code = quantmind_cli.main(["mine", "--topic", "moving average momentum market timing",
                               "--captures", str(captures), "--out", str(out), "--min-confidence", "0.25"])
    assert code == 0
    summary = json.loads(capsys.readouterr().out)
    assert (summary["drafted"], summary["rejected"]) == (2, 2)
    folder = out / topic_folder_name("moving average momentum market timing")
    assert folder.name.startswith("moving-average-momentum-market-timing-") and len(folder.name) == 46
    assert summary["out"] == str(folder)
    report = json.loads((folder / "report.json").read_text())
    assert len(list((folder / "drafts").glob("*.json"))) == 2 and _order_keys(report) == set()
    # A narrower rerun of the same topic removes drafts that are no longer in its report.
    assert quantmind_cli.main(["mine", "--topic", "moving average momentum market timing", "--top", "1",
                               "--captures", str(captures), "--out", str(out), "--min-confidence", "0.25"]) == 0
    report = json.loads((folder / "report.json").read_text())
    assert len(list((folder / "drafts").glob("*.json"))) == report["counts"]["drafted"] == 1


def test_cli_rejects_missing_captures_and_bad_instrument(tmp_path, captures):
    assert quantmind_cli.main(["mine", "--topic", "x", "--captures", str(tmp_path / "none")]) == 2
    assert quantmind_cli.main(["mine", "--topic", "x", "--captures", str(captures), "--instrument", "spy; rm"]) == 2


def test_cli_search_lists_ranked_captures(captures, capsys):
    assert quantmind_cli.main(["search", "--topic", "moving average", "--captures", str(captures), "--top", "2"]) == 0
    results = json.loads(capsys.readouterr().out)["results"]
    assert results[0]["doi"] == SMA["doi"] and len(results) <= 2


def test_topics_with_the_same_slug_keep_separate_folders(captures, tmp_path):
    client = LocalCaptureClient(captures)
    first, _ = write_outputs(mine(client, "Moving Average", MineOptions()), tmp_path)
    second, _ = write_outputs(mine(client, "moving  average", MineOptions()), tmp_path)
    assert first != second and first.name[:-9] == second.name[:-9] == "moving-average"
    assert list((first / "drafts").glob("*.json")) and list((second / "drafts").glob("*.json"))
