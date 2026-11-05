"""TradingAgents per-ticker CLI: fake omp end to end, output files, research-only guards."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agents.external_research import _order_keys
from agents.tradingagents_cli import main

SOURCE = {"source_type": "model_knowledge", "title": "Desk reasoning", "confidence": 0.4}
THEME = {"theme_id": "ai-capex", "name": "AI capex", "summary": "Data center spend.",
         "horizon": "quarters", "confidence": 0.7, "catalysts": ["earnings"],
         "beneficiaries": ["NVDA"], "risks": ["digestion"], "source_refs": [SOURCE],
         "created_at": "2026-11-04T00:00:00Z", "updated_at": "2026-11-04T00:00:00Z"}


def brief(ticker: str = "NVDA", **extra: Any) -> dict[str, Any]:
    return {"ticker": ticker, "themes": ["ai-capex"], "bull_case": "Demand is strong.",
            "bear_case": "Valuation is high.", "key_catalysts": ["earnings"],
            "key_risks": ["export rules"], "what_would_change_our_mind": ["capex cuts"],
            "confidence": 0.6, "source_refs": [SOURCE], **extra}


DESK_MARKERS = {
    "theme-discovery desk": [THEME],
    "bull/bear research desk": brief(),
    "setup debate desk": brief(confidence=0.55),
}


class FakeOmp:
    """Stands in for ``subprocess.run``: answers by desk, as fenced JSON in an agent_end event."""

    def __init__(self, answers: dict[str, Any] | None = None) -> None:
        self.answers = {**DESK_MARKERS, **(answers or {})}
        self.prompts: list[str] = []
        self.argvs: list[list[str]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        prompt = kwargs["input"]
        self.prompts.append(prompt)
        self.argvs.append(argv)
        answer = next(v for marker, v in self.answers.items() if marker in prompt)
        message = {"role": "assistant", "provider": "anthropic", "model": "claude-opus-5-5",
                   "stopReason": "stop",
                   "content": [{"type": "text", "text": f"```json\n{json.dumps(answer)}\n```"}],
                   "usage": {"input": 100, "output": 50, "cost": {"total": 0.01}}}
        stdout = json.dumps({"type": "agent_end", "messages": [message]}) + "\n"
        return subprocess.CompletedProcess(argv, 0, stdout, "")


def run_cli(tmp_path: Path, fake: FakeOmp, *extra: str) -> tuple[int, Path]:
    out = tmp_path / "out" / "NVDA-2026-11-04.json"
    code = main(["--ticker", "nvda", "--as-of", "2026-11-04", "--out", str(out), "--omp", "omp",
                 "--thinking", "low", *extra], run=fake)
    return code, out


def test_end_to_end_writes_dossier_and_record_payload(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake)
    assert code == 0
    dossier = json.loads(out.read_text())
    payload = json.loads((out.parent / "NVDA-2026-11-04.record.json").read_text())

    assert len(fake.prompts) == 2
    assert "bull/bear research desk" in fake.prompts[0] and "2026-11-04" in fake.prompts[0]
    assert "setup debate desk" in fake.prompts[1] and "Demand is strong." in fake.prompts[1]
    assert all(argv[argv.index("--thinking") + 1] == "low" for argv in fake.argvs)

    assert dossier["research_only"] is True and dossier["framework"] == "tradingagents"
    assert dossier["ticker"] == "NVDA" and dossier["as_of"] == "2026-11-04"
    assert [d["prompt_name"] for d in dossier["desks"]] == ["bull_bear_research_brief", "trade_setup_debate"]
    assert dossier["desks"][1]["output"]["confidence"] == 0.55
    assert dossier["desks"][0]["output_model"] == "ResearchBrief"
    assert dossier["model"] == {"transport": "omp -p (OMP subscription)",
                                "requested": "anthropic/claude-opus-5-5",
                                "served": ["claude-opus-5-5"], "thinking": "low"}
    assert dossier["usage"] == {"llm_calls": 2, "input_tokens": 200, "output_tokens": 100, "cost_usd": 0.02}
    assert dossier["source_refs"] == [{"desk": "bull_bear_research_brief", **SOURCE}]

    record = payload["record"]
    assert record["framework"] == "tradingagents" and record["status"] == "succeeded"
    assert (record["provider"], record["model"], record["ticker"], record["decisionDate"]) == (
        "anthropic", "claude-opus-5-5", "NVDA", "2026-11-04")
    assert record["modelsServed"] == [{"requested": "claude-opus-5-5", "served": "claude-opus-5-5"}]
    assert record["analysts"] == ["Bull/Bear Desk", "Setup Debate Desk"]
    assert record["ratingSource"] == "missing" and "rating" not in record
    assert not {"entryPrice", "stopPrice", "targetPrice"} & set(record)
    assert record["flags"] == ["research_only"] and record["variant"] == "thinking-low"
    assert (record["llmCalls"], record["inputTokens"], record["outputTokens"]) == (2, 200, 100)
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", record["runKey"])
    assert record["runKey"] == dossier["run_key"]

    events = payload["appendEvents"]["events"]
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert [e["kind"] for e in events] == ["llm_call", "message", "llm_call", "decision", "flag"]
    assert events[-1]["title"] == "research_only"
    assert all(len(e["title"]) <= 300 and len(e.get("body") or "") <= 16_000 for e in events)
    assert not _order_keys(dossier) and not _order_keys(payload)

    summary = json.loads(capsys.readouterr().out)
    assert summary["status"] == "succeeded" and summary["dossier"] == str(out)


def test_themes_flag_runs_theme_desk_first(tmp_path: Path) -> None:
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake, "--themes")
    assert code == 0
    dossier = json.loads(out.read_text())
    assert [d["prompt_name"] for d in dossier["desks"]] == [
        "theme_discovery", "bull_bear_research_brief", "trade_setup_debate"]
    assert '"ai-capex"' in fake.prompts[1]


def test_caller_context_reaches_desks(tmp_path: Path) -> None:
    ctx = tmp_path / "ctx.json"
    ctx.write_text(json.dumps({"closes": [{"date": "2026-11-03", "close": 201.5}], "note": "local bars"}))
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake, "--context", str(ctx))
    assert code == 0
    assert all("local bars" in prompt for prompt in fake.prompts)
    payload = json.loads(out.with_name("NVDA-2026-11-04.record.json").read_text())
    assert payload["record"]["dataSource"] == "caller_context"


@pytest.mark.parametrize("bad_answer", [
    brief(strike=950),
    brief(source_refs=[{**SOURCE, "raw": {"order_type": "limit"}}]),
    {**brief(), "orderType": "LMT"},
])
def test_order_like_output_is_rejected_and_no_dossier_written(
        tmp_path: Path, bad_answer: dict[str, Any], capsys: pytest.CaptureFixture[str]) -> None:
    code, out = run_cli(tmp_path, FakeOmp({"setup debate desk": bad_answer}))
    assert code == 1
    assert not out.exists()
    payload = json.loads(out.with_name("NVDA-2026-11-04.record.json").read_text())
    assert payload["record"]["status"] == "failed"
    assert "research only" in payload["record"]["error"] or "order" in payload["record"]["error"]
    assert not _order_keys(payload)
    assert "error:" in capsys.readouterr().err


def test_brief_for_another_ticker_fails(tmp_path: Path) -> None:
    code, out = run_cli(tmp_path, FakeOmp({"bull/bear research desk": brief("AMD")}))
    assert code == 1 and not out.exists()


@pytest.mark.parametrize("context", [
    {"account_id": "U123"}, {"nested": [{"api_key": "x"}]}, {"limit_price": 1}, {"positions": []},
    ["not", "an", "object"],
])
def test_account_secret_or_order_context_is_refused_before_any_model_call(
        tmp_path: Path, context: Any) -> None:
    ctx = tmp_path / "ctx.json"
    ctx.write_text(json.dumps(context))
    fake = FakeOmp()
    code, out = run_cli(tmp_path, fake, "--context", str(ctx))
    assert code == 2 and fake.prompts == [] and not out.parent.exists()


def test_bad_ticker_and_disallowed_model_exit_2(tmp_path: Path) -> None:
    fake = FakeOmp()
    assert main(["--ticker", "NV DA", "--as-of", "2026-11-04", "--out", str(tmp_path / "x.json")], run=fake) == 2
    assert main(["--ticker", "NVDA", "--as-of", "2026-11-04", "--model", "openai/gpt-5.2",
                 "--out", str(tmp_path / "x.json")], run=fake) == 2
    assert fake.prompts == []
