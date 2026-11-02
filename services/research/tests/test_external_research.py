"""QuantMind and TradingAgents research adapters: research only, typed, no order fields."""
from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest

from agents.external_research import (
    PROMPT_CONTRACTS,
    ExternalResearchError,
    QuantMindKnowledgeAdapter,
    TradingAgentsResearchAdapter,
    extractive_summary,
    redact_context,
    validate_output,
)

SOURCE = {"source_type": "filing", "title": "10-K", "url": "https://example.test/10k"}
REGIME = {"as_of": "2026-10-22T00:00:00Z", "regime_label": "risk-on", "confidence": 0.6,
          "evidence": ["breadth up"], "source_refs": [SOURCE]}
THEME = {"theme_id": "t1", "name": "Grid capex", "summary": "Utilities spend more.",
         "horizon": "quarters", "confidence": 0.7, "catalysts": ["rate cuts"],
         "beneficiaries": ["ETN"], "risks": ["permits"], "source_refs": [SOURCE],
         "created_at": "2026-10-22T00:00:00Z", "updated_at": "2026-10-22T00:00:00Z"}
CANDIDATE = {"ticker": "ETN", "theme_ids": ["t1"], "why_it_fits": "switchgear",
             "discovery_score": 0.8}
BRIEF = {"ticker": "ETN", "themes": ["t1"], "bull_case": "orders", "bear_case": "valuation",
         "key_catalysts": ["earnings"], "key_risks": ["capex cut"],
         "what_would_change_our_mind": ["backlog drop"], "confidence": 0.55,
         "source_refs": [SOURCE]}


class FakeGenerator:
    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.prompts: dict[str, str] = {}

    def generate(self, name: str, prompt: str) -> Any:
        self.prompts[name] = prompt
        return self.answers[name]


def test_contracts_render_schema_rules_and_redacted_context() -> None:
    assert set(PROMPT_CONTRACTS) == {
        "market_regime_analysis", "theme_discovery", "candidate_discovery",
        "bull_bear_research_brief", "trade_setup_debate"}
    prompt = PROMPT_CONTRACTS["theme_discovery"].render(
        {"api_key": "sk-x", "nested": [{"account_id": "U1"}], "day": date(2026, 10, 22)})
    assert '"type": "array"' in prompt
    assert "Do not write order or broker instructions" in prompt
    assert "sk-x" not in prompt and "U1" not in prompt and "2026-10-22" in prompt
    assert "Context:" not in PROMPT_CONTRACTS["market_regime_analysis"].render()


def test_redact_context_handles_models() -> None:
    from agents.external_research import SourceRef
    assert redact_context(SourceRef(source_type="x"))["source_type"] == "x"


def test_adapter_returns_typed_research() -> None:
    gen = FakeGenerator({
        "market_regime_analysis": json.dumps(REGIME),
        "theme_discovery": [THEME],
        "candidate_discovery": [CANDIDATE],
        "bull_bear_research_brief": BRIEF,
        "trade_setup_debate": BRIEF,
    })
    adapter = TradingAgentsResearchAdapter(gen)
    assert adapter.analyze_regime({"note": "x"}).regime_label == "risk-on"
    themes = adapter.discover_themes({})
    assert themes[0].theme_id == "t1"
    assert adapter.discover_candidates({})[0].ticker == "ETN"
    assert adapter.analyze_candidate("ETN", themes).bull_case == "orders"
    assert adapter.debate_setup({"idea": "call spread"}).ticker == "ETN"
    assert '"ticker": "ETN"' in gen.prompts["bull_bear_research_brief"]


@pytest.mark.parametrize("name, payload, message", [
    ("bull_bear_research_brief", "not json", "not JSON"),
    ("bull_bear_research_brief", {**BRIEF, "limit_price": 2.5}, "order fields"),
    ("candidate_discovery", [{**CANDIDATE, "notes": "x", "x": [{"strike": 100}]}], "order fields"),
    ("theme_discovery", THEME, "must be a list"),
    ("theme_discovery", [{**THEME, "horizon": "years"}], "does not match"),
])
def test_validate_output_rejects_bad_or_order_like_payloads(
        name: Any, payload: Any, message: str) -> None:
    with pytest.raises(ExternalResearchError, match=message):
        validate_output(name, payload)


def test_validate_output_accepts_empty_list() -> None:
    assert validate_output("theme_discovery", []) == []


class FakeQuantMind:
    def fetch(self, source: str) -> tuple[str | None, str, str | None]:
        return None, "# Volatility carry\n\nShort vol earns a premium.\n\nCrashes hurt.", None


def test_quantmind_ingest_search_and_summarize() -> None:
    kb = QuantMindKnowledgeAdapter(FakeQuantMind())
    paper = kb.ingest("arxiv:1234")
    note = kb.ingest_text("Momentum in options.\n\nMomentum fades after earnings.",
                          title="Momentum note", source_url="https://example.test/m")
    assert kb.summarize(paper) == "Short vol earns a premium. Crashes hurt."
    hits = kb.search("momentum earnings", top_k=5)
    assert [h.title for h in hits] == ["Momentum note"]
    assert hits[0].confidence == 1.0 and "earnings" in (hits[0].excerpt or "")
    assert hits[0].raw == {"source_id": note}
    both = kb.search("premium momentum")
    assert {h.title for h in both} == {"Volatility carry", "Momentum note"}
    assert both[0].url in {"arxiv:1234", "https://example.test/m"}
    assert kb.search("", top_k=3) == [] and kb.search("momentum", top_k=0) == []
    assert kb.search("absent") == []


def test_quantmind_errors_and_summary_edges() -> None:
    kb = QuantMindKnowledgeAdapter()
    with pytest.raises(ExternalResearchError, match="no text"):
        kb.ingest_text("   ")
    with pytest.raises(ExternalResearchError, match="No QuantMind client"):
        kb.ingest("x")
    with pytest.raises(ExternalResearchError, match="not ingested"):
        kb.summarize("missing")
    source_id = kb.ingest_text("plain words without a heading")
    assert kb.summarize(source_id) == "plain words without a heading"
    assert extractive_summary("T", "# T") == "T"
    assert extractive_summary("T", "x" * 600).endswith("...")


@pytest.mark.parametrize("payload", [
    {**BRIEF, "source_refs": [{**SOURCE, "raw": {
        "orderType": "LMT", "limitPrice": 2.5, "buy": {"contracts": 10}}}]},
    {**BRIEF, "source_refs": [{**SOURCE, "raw": {"meta": {"Time-In-Force": "GTC"}}}]},
    {**BRIEF, "source_refs": [{**SOURCE, "raw": {"note": [{"SELL_TO_OPEN": "x"}]}}]},
    {**BRIEF, "ＯＲＤＥＲ": "x"},
    {**BRIEF, "TIF": "day"},
])
def test_order_guard_normalises_camel_case_and_nested_keys(payload: Any) -> None:
    with pytest.raises(ExternalResearchError, match="order fields"):
        validate_output("bull_bear_research_brief", payload)


def test_order_guard_checks_tuple_payloads() -> None:
    with pytest.raises(ExternalResearchError, match="order fields"):
        validate_output("candidate_discovery", ({**CANDIDATE, "x": ({"Qty": 1},)},))


@pytest.mark.parametrize("raw", [
    {"meta": {"note": "nested"}},
    {"source_id": 7},
    {"Source ID": "x"},
    {"source_id": "x" * 257},
    {f"k{i}": "v" for i in range(9)},
])
def test_source_ref_raw_is_a_small_flat_string_map(raw: Any) -> None:
    payload = {**BRIEF, "source_refs": [{**SOURCE, "raw": raw}]}
    with pytest.raises(ExternalResearchError, match="does not match"):
        validate_output("bull_bear_research_brief", payload)


def test_source_ref_raw_accepts_bounded_strings() -> None:
    payload = {**BRIEF, "source_refs": [{**SOURCE, "raw": {"source_id": "abc"}}]}
    brief = validate_output("bull_bear_research_brief", payload)
    assert brief.source_refs[0].raw == {"source_id": "abc"}


@pytest.mark.parametrize("text", [
    '{"discovery_score": NaN}', '{"discovery_score": Infinity}',
    '{"liquidity_score": -Infinity}', '{"market_cap": Infinity}',
])
def test_candidate_scores_reject_non_finite_values(text: str) -> None:
    extra = json.loads(text)
    with pytest.raises(ExternalResearchError, match="does not match"):
        validate_output("candidate_discovery", json.dumps([{**CANDIDATE, **extra}]))


def test_render_rejects_unserializable_context() -> None:
    with pytest.raises(ExternalResearchError, match="not JSON-serializable"):
        PROMPT_CONTRACTS["theme_discovery"].render({"x": object()})


class BrokenGenerator:
    def generate(self, name: str, prompt: str) -> Any:
        raise ConnectionError("down")


def test_transport_errors_are_adapter_errors() -> None:
    with pytest.raises(ExternalResearchError, match="transport failed") as info:
        TradingAgentsResearchAdapter(BrokenGenerator()).discover_themes({})
    assert isinstance(info.value.__cause__, ConnectionError)


def test_analyze_candidate_rejects_brief_for_another_ticker() -> None:
    adapter = TradingAgentsResearchAdapter(FakeGenerator({"bull_bear_research_brief": BRIEF}))
    assert adapter.analyze_candidate(" etn ", []).ticker == "ETN"
    other = TradingAgentsResearchAdapter(
        FakeGenerator({"bull_bear_research_brief": {**BRIEF, "ticker": "GEV"}}))
    with pytest.raises(ExternalResearchError, match="not requested 'ETN'"):
        other.analyze_candidate("ETN", [])


class ScriptedQuantMind:
    def __init__(self, result: Any) -> None:
        self.result = result

    def fetch(self, source: str) -> Any:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.mark.parametrize("result, message", [
    (OSError("offline"), "fetch failed"),
    (["T", "text", None], "tuple"),
    (("T", "text"), "tuple"),
    ("abc", "tuple"),
    (("T", "text", 42), "invalid source"),
    ((None, b"text", None), "invalid source"),
    ((7, "text", None), "invalid source"),
])
def test_quantmind_ingest_validates_fetch_before_storing(result: Any, message: str) -> None:
    kb = QuantMindKnowledgeAdapter(ScriptedQuantMind(result))
    with pytest.raises(ExternalResearchError, match=message):
        kb.ingest("arxiv:1")
    assert kb.search("text") == []


def test_quantmind_ingest_uses_fetched_url_and_title() -> None:
    kb = QuantMindKnowledgeAdapter(ScriptedQuantMind(("Paper", "Body text.", "https://x.test")))
    kb.ingest("arxiv:2")
    hit = kb.search("body")[0]
    assert (hit.title, hit.url) == ("Paper", "https://x.test")


def test_summary_keeps_words_whole() -> None:
    assert extractive_summary("Vol", "Volatility carry pays.") == "Volatility carry pays."
    assert extractive_summary("Vol", "Vol carry pays.") == "carry pays."
    long_title = "word " * 120
    summary = extractive_summary(long_title.strip(), "")
    assert summary.endswith("word...") and len(summary) <= 500
    assert extractive_summary("T", "ab " * 300).endswith("ab...")
    spaced = "a" * 496 + " " + "b" * 10
    assert extractive_summary("T", spaced) == "a" * 496 + "..."
    assert extractive_summary("T", " " + "x" * 600) == "x" * 497 + "..."
