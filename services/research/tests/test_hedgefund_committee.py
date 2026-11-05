"""AI Hedge Fund persona committee: fake omp end to end, one call, guards, record payload."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agents.external_research import ExternalResearchError, _order_keys
from agents.hedgefund_committee import (
    PERSONAS,
    PersonaView,
    parse_personas,
    rating_for,
    summarize,
    validate_answer,
)
from agents.hedgefund_committee_cli import FRAMEWORK, main

METRICS = {"payload": {"price_to_earnings_ratio": "38.9", "return_on_equity": "1.18",
                       "revenue_growth": "0.15", "current_ratio": "1.02"},
           "source": "financialdatasets"}
FACTS = {"payload": {"name": "Apple Inc", "sector": "Information Technology"}}
SIGNALS = {"buffett": ("neutral", 0.6), "munger": ("neutral", 0.55), "graham": ("bearish", 0.8),
           "lynch": ("neutral", 0.5), "druckenmiller": ("bullish", 0.6)}


def view(persona: str, signal: str = "neutral", confidence: float = 0.5, **extra: Any) -> dict[str, Any]:
    return {"persona": persona, "signal": signal, "confidence": confidence,
            "reasoning": f"{persona} reads the numbers.",
            "key_metrics": [{"metric": "price_to_earnings_ratio", "value": "38.9",
                             "source": "aapl_financial_metrics"},
                            {"metric": "made_up_metric", "value": 1}],
            "risks": ["valuation"], "missing_evidence": ["multi-year history"], **extra}


def answer(ticker: str = "AAPL", personas: dict[str, tuple[str, float]] | None = None) -> dict[str, Any]:
    chosen = SIGNALS if personas is None else personas
    return {"ticker": ticker, "personas": [view(p, s, c) for p, (s, c) in chosen.items()]}


class FakeOmp:
    """Stands in for ``subprocess.run``: one fenced JSON answer in an agent_end event."""

    def __init__(self, reply: Any | None = None) -> None:
        self.reply = answer() if reply is None else reply
        self.prompts: list[str] = []
        self.argvs: list[list[str]] = []
        self.envs: list[dict[str, str]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.prompts.append(kwargs["input"])
        self.argvs.append(argv)
        self.envs.append(kwargs["env"])
        message = {"role": "assistant", "provider": "anthropic", "model": "claude-opus-5-5",
                   "stopReason": "stop",
                   "content": [{"type": "text", "text": f"```json\n{json.dumps(self.reply)}\n```"}],
                   "usage": {"input": 1000, "output": 400, "cost": {"total": 0.02}}}
        stdout = json.dumps({"type": "agent_end", "messages": [message]}) + "\n"
        return subprocess.CompletedProcess(argv, 0, stdout, "")


def contexts(tmp_path: Path) -> list[str]:
    facts, metrics = tmp_path / "aapl-company-facts.json", tmp_path / "aapl-financial-metrics.json"
    facts.write_text(json.dumps(FACTS))
    metrics.write_text(json.dumps(METRICS))
    return ["--context", str(facts), "--context", str(metrics)]


def run_cli(tmp_path: Path, fake: FakeOmp, *extra: str) -> tuple[int, Path]:
    out = tmp_path / "out" / "AAPL-2026-11-05.json"
    code = main(["--ticker", "aapl", "--as-of", "2026-11-05", "--out", str(out), "--omp", "omp",
                 "--thinking", "low", *extra], run=fake)
    return code, out


def test_end_to_end_one_call_for_all_personas(tmp_path: Path, capsys: pytest.CaptureFixture[str],
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "per-token-key")
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake, *contexts(tmp_path))
    assert code == 0
    assert len(fake.prompts) == 1  # five personas, one model call
    prompt = fake.prompts[0]
    for persona in PERSONAS.values():
        assert f"Persona `{persona.id}`" in prompt
    assert "Margin of safety" in prompt and "Invert, always invert" in prompt
    assert '"price_to_earnings_ratio": "38.9"' in prompt and "aapl_financial_metrics" in prompt
    assert "Treat 2026-11-05 as the present day" in prompt
    assert fake.argvs[0][fake.argvs[0].index("--thinking") + 1] == "low"
    assert "ANTHROPIC_API_KEY" not in fake.envs[0]  # subscription login only

    dossier = json.loads(out.read_text())
    assert dossier["research_only"] is True and dossier["framework"] == FRAMEWORK == "ai_hedge_fund"
    assert dossier["provenance"]["commit"].startswith("29b32f7")
    assert dossier["model"]["calls"] == 1 and dossier["usage"]["llm_calls"] == 1
    assert [p["persona"] for p in dossier["personas"]] == list(SIGNALS)
    graham = dossier["personas"][2]
    assert graham["name"] == "Benjamin Graham" and graham["signal"] == "bearish"
    assert graham["citation_check"] == {"cited": 2, "in_context": 1}
    committee = dossier["committee"]
    assert committee["votes"] == {"bullish": 1, "neutral": 3, "bearish": 1}
    assert committee["majority_signal"] == "neutral" and committee["agreement"] == 0.6
    assert committee["net_score"] == round((0.6 - 0.8) / 5, 4) and committee["rating"] == "hold"
    assert _order_keys(dossier) == set()

    printed = json.loads(capsys.readouterr().out)
    assert printed["status"] == "succeeded" and printed["signals"]["graham"] == "bearish 0.80"


def test_record_payload_shape(tmp_path: Path) -> None:
    code, out = run_cli(tmp_path, FakeOmp(), *contexts(tmp_path))
    assert code == 0
    payload = json.loads((out.parent / "AAPL-2026-11-05.record.json").read_text())
    record = payload["record"]
    assert record["framework"] == "ai_hedge_fund" and record["frameworkVersion"].startswith("personas+")
    assert record["provider"] == "anthropic" and record["model"] == "claude-opus-5-5"
    assert record["ticker"] == "AAPL" and record["decisionDate"] == "2026-11-05"
    assert record["status"] == "succeeded" and record["llmCalls"] == 1
    assert record["rating"] == "hold" and record["ratingSource"] == "mapped"
    assert record["analysts"] == [p.name for p in PERSONAS.values()]
    assert record["flags"] == ["research_only", "single_call"] and record["dataSource"] == "caller_context"
    assert record["variant"] == "thinking-low" and record["inputTokens"] == 1000
    for key in ("entryPrice", "stopPrice", "targetPrice", "horizon"):
        assert key not in record
    events = payload["appendEvents"]["events"]
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert [e["kind"] for e in events] == ["llm_call", *["message"] * 5, "decision", "flag"]
    assert events[3]["title"].startswith("Benjamin Graham: bearish 0.80")
    assert "hold (mapped, research only)" in events[6]["title"]
    assert _order_keys(payload) == set()


def test_persona_selection_keeps_one_call_and_order(tmp_path: Path) -> None:
    fake = FakeOmp(answer(personas={"munger": ("bearish", 0.7), "lynch": ("bullish", 0.9)}))
    code, out = run_cli(tmp_path, fake, "--personas", "lynch, MUNGER")
    assert code == 0 and len(fake.prompts) == 1
    assert "Persona `buffett`" not in fake.prompts[0]
    dossier = json.loads(out.read_text())
    assert [p["persona"] for p in dossier["personas"]] == ["lynch", "munger"]
    assert dossier["committee"]["majority_signal"] == "split"


@pytest.mark.parametrize("raw", ["buffett,soros", "buffett,buffett", " , "])
def test_bad_persona_list_exits_2_before_any_call(tmp_path: Path, raw: str) -> None:
    fake = FakeOmp()
    code, _ = run_cli(tmp_path, fake, "--personas", raw)
    assert code == 2 and fake.prompts == []
    with pytest.raises(ValueError):
        parse_personas(raw)


def test_missing_or_extra_persona_in_answer_fails(tmp_path: Path) -> None:
    partial = answer(personas={"buffett": ("bullish", 0.5)})
    with pytest.raises(ExternalResearchError, match="expected each"):
        validate_answer(partial, "AAPL", ["buffett", "munger"])
    duplicated = {"ticker": "AAPL", "personas": [view("buffett"), view("buffett")]}
    with pytest.raises(ExternalResearchError, match="expected each"):
        validate_answer(duplicated, "AAPL", ["buffett", "munger"])
    with pytest.raises(ExternalResearchError, match="not 'AAPL'"):
        validate_answer(answer("MSFT"), "AAPL", list(SIGNALS))
    bad_confidence = {"ticker": "AAPL", "personas": [view("buffett", confidence=70)]}
    with pytest.raises(ExternalResearchError, match="CommitteeAnswer"):
        validate_answer(bad_confidence, "AAPL", ["buffett"])

    code, out = run_cli(tmp_path, FakeOmp(partial))
    assert code == 1 and not out.exists()
    payload = json.loads((out.parent / "AAPL-2026-11-05.record.json").read_text())
    assert payload["record"]["status"] == "failed" and payload["record"]["rating"] is None
    assert payload["record"]["ratingSource"] == "missing"


@pytest.mark.parametrize("extra", [{"target_price": 250}, {"position_size": 0.1},
                                   {"action": "buy"}, {"order": {"qty": 10}}])
def test_order_like_output_is_rejected(tmp_path: Path, extra: dict[str, Any]) -> None:
    reply = answer()
    reply["personas"][0].update(extra)
    code, out = run_cli(tmp_path, FakeOmp(reply))
    assert code == 1 and not out.exists()
    payload = json.loads((out.parent / "AAPL-2026-11-05.record.json").read_text())
    assert payload["record"]["status"] == "failed" and payload["record"]["llmCalls"] == 1
    assert [e["kind"] for e in payload["appendEvents"]["events"]] == ["llm_call", "status", "flag"]
    assert "research only" in payload["record"]["error"] or "CommitteeAnswer" in payload["record"]["error"]
    assert _order_keys(payload) == set()


@pytest.mark.parametrize("bad", [{"account_id": "x"}, {"api_key": "x"},
                                 {"payload": {"position": 3}}, {"balance": 1},
                                 {"rows": [{"price": 1}]}, {"limit_price": 1}])
def test_account_secret_or_order_context_is_refused_before_any_call(
        tmp_path: Path, bad: dict[str, Any], capsys: pytest.CaptureFixture[str]) -> None:
    ctx = tmp_path / "ctx.json"
    ctx.write_text(json.dumps(bad))
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake, "--context", str(ctx))
    assert code == 2 and fake.prompts == [] and not out.parent.exists()
    assert "ctx.json" in capsys.readouterr().err


def test_context_files_with_same_stem_or_non_object_are_refused(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    for folder in ("a", "b"):
        (tmp_path / folder / "metrics.json").write_text("{}")
    fake = FakeOmp()
    code, _ = run_cli(tmp_path, fake, "--context", str(tmp_path / "a" / "metrics.json"),
                      "--context", str(tmp_path / "b" / "metrics.json"))
    assert code == 2
    (tmp_path / "list.json").write_text("[1]")
    code, _ = run_cli(tmp_path, fake, "--context", str(tmp_path / "list.json"))
    assert code == 2 and fake.prompts == []


@pytest.mark.parametrize(("score", "rating"), [(0.8, "buy"), (0.5, "buy"), (0.3, "overweight"),
                                                (0.2, "overweight"), (0.15, "hold"), (0.0, "hold"),
                                                (-0.75 / 5, "hold"), (-0.2, "underweight"),
                                                (-0.49, "underweight"), (-0.5, "sell"),
                                                (-1.0, "sell")])
def test_rating_mapping(score: float, rating: str) -> None:
    assert rating_for(score) == rating


def test_summary_unanimous_bullish_maps_to_buy() -> None:
    views = [PersonaView.model_validate(view(p, "Bullish", 0.8)) for p in ("buffett", "lynch")]
    summary = summarize(views)
    assert summary.votes["bullish"] == 2 and summary.agreement == 1.0
    assert summary.majority_signal == "bullish" and summary.rating == "buy"
