"""OMP Claude transport: lean tool-less command, allow-list, JSON parsing, error mapping."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agents.external_research import ExternalResearchError, TradingAgentsResearchAdapter
from agents.omp_claude import (
    ADVISOR_OFF_OVERLAY,
    DEFAULT_MODEL,
    OmpClaudeGenerator,
    extract_json,
    final_assistant_message,
)


def omp_stdout(text: str, *, stop: str = "stop", model: str = "claude-opus-5-5") -> str:
    message = {"role": "assistant", "content": [{"type": "thinking", "thinking": "{\"no\": 1}"},
                                                {"type": "text", "text": text}],
               "provider": "anthropic", "model": model, "stopReason": stop,
               "usage": {"input": 10, "output": 20, "cacheRead": 5, "cacheWrite": 1,
                         "cost": {"total": 0.25}}}
    events = [{"type": "agent_start"},
              {"type": "message_end", "message": {"role": "assistant", "content": []}},
              {"type": "agent_end", "messages": [{"role": "user", "content": []}, message]}]
    return "not json\n" + "\n".join(json.dumps(e) for e in events) + "\n"


class FakeRun:
    def __init__(self, stdout: str = "", *, returncode: int = 0, stderr: str = "",
                 raises: BaseException | None = None) -> None:
        self.stdout, self.returncode, self.stderr, self.raises = stdout, returncode, stderr, raises
        self.calls: list[dict[str, Any]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        overlay = Path(argv[argv.index("--config") + 1])
        self.calls.append({"argv": argv, "overlay_text": overlay.read_text(encoding="utf-8"),
                           "overlay_in_cwd": overlay.parent == Path(kwargs["cwd"]), **kwargs})
        if self.raises is not None:
            raise self.raises
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, self.stderr)


def test_command_is_lean_tool_less_and_prompt_goes_on_stdin() -> None:
    run = FakeRun(omp_stdout('{"ok": true}'))
    generator = OmpClaudeGenerator(thinking="low", omp_path="/opt/omp", run=run, timeout_s=42)
    assert generator.generate("theme_discovery", "PROMPT TEXT") == {"ok": True}
    call = run.calls[0]
    argv = call["argv"]
    assert argv[:4] == ["/opt/omp", "-p", "--mode", "json"]
    for flag in ("--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules",
                 "--no-context-files", "--no-lsp", "--no-title"):
        assert flag in argv
    assert argv[argv.index("--model") + 1] == DEFAULT_MODEL
    assert argv[argv.index("--thinking") + 1] == "low"
    assert "--system-prompt" in argv
    assert "PROMPT TEXT" not in " ".join(argv)
    assert call["input"] == "PROMPT TEXT" and call["text"] is True and call["timeout"] == 42
    assert call["overlay_text"] == ADVISOR_OFF_OVERLAY and call["overlay_in_cwd"]
    assert not Path(call["cwd"]).exists()  # the temporary directory is removed
    reply = generator.calls[0]
    assert (reply.model, reply.provider, reply.input_tokens, reply.output_tokens, reply.cost_usd) == (
        "claude-opus-5-5", "anthropic", 16, 20, 0.25)


def test_model_allow_list_and_settings_are_checked_before_any_run() -> None:
    run = FakeRun(omp_stdout("{}"))
    with pytest.raises(ExternalResearchError, match="not in the allowed model list"):
        OmpClaudeGenerator(model="openai/gpt-5.2", run=run)
    with pytest.raises(ExternalResearchError, match="Thinking level"):
        OmpClaudeGenerator(thinking="auto", run=run)
    with pytest.raises(ExternalResearchError, match="Timeout"):
        OmpClaudeGenerator(timeout_s=0, run=run)
    assert run.calls == []
    other = OmpClaudeGenerator(model="anthropic/claude-x", allowed_models={"anthropic/claude-x"},
                               omp_path="omp", run=run)
    other.generate("n", "p")
    assert run.calls[0]["argv"][run.calls[0]["argv"].index("--model") + 1] == "anthropic/claude-x"


@pytest.mark.parametrize(("text", "expected"), [
    ('{"a": 1}', {"a": 1}),
    ('[{"a": 1}]', [{"a": 1}]),
    ('Here it is:\n```json\n{"a": 2}\n```\nDone.', {"a": 2}),
    ('```\n[1, 2]\n```', [1, 2]),
    ('Sure. {"a": {"b": [3]}} trailing words', {"a": {"b": [3]}}),
    ('note {not json} then {"a": 4}', {"a": 4}),
])
def test_extract_json_tolerates_fences_and_prose(text: str, expected: Any) -> None:
    assert extract_json(text) == expected


@pytest.mark.parametrize("text", ["no json here", '"just a string"', "42", "```json\n{bad\n```"])
def test_extract_json_rejects_answers_without_object_or_array(text: str) -> None:
    with pytest.raises(ExternalResearchError, match="no JSON"):
        extract_json(text)


def test_final_message_uses_last_agent_end_assistant_text_only() -> None:
    message = final_assistant_message(omp_stdout("answer"))
    assert message["model"] == "claude-opus-5-5"
    with pytest.raises(ExternalResearchError, match="agent_end"):
        final_assistant_message('{"type": "agent_start"}\n')


@pytest.mark.parametrize(("run", "match"), [
    (FakeRun(raises=subprocess.TimeoutExpired(["omp"], 5)), "no reply in"),
    (FakeRun(raises=FileNotFoundError(2, "No such file or directory")), "could not start omp"),
    (FakeRun("", returncode=3, stderr="login expired"), "exit 3: login expired"),
    (FakeRun(omp_stdout("{}", stop="error")), "stop reason error"),
    (FakeRun(omp_stdout("   ")), "empty answer"),
    (FakeRun('{"type": "agent_start"}\n'), "no assistant message"),
    (FakeRun(omp_stdout("I cannot answer.")), "no JSON"),
])
def test_failures_map_to_external_research_error(run: FakeRun, match: str) -> None:
    generator = OmpClaudeGenerator(omp_path="omp", run=run, timeout_s=5)
    with pytest.raises(ExternalResearchError, match=match):
        generator.generate("trade_setup_debate", "prompt")


def test_empty_prompt_is_refused_without_a_run() -> None:
    run = FakeRun(omp_stdout("{}"))
    with pytest.raises(ExternalResearchError, match="prompt is empty"):
        OmpClaudeGenerator(omp_path="omp", run=run).complete("n", "  ")
    assert run.calls == []


def test_generator_plugs_into_tradingagents_adapter_and_order_output_is_rejected() -> None:
    brief = {"ticker": "NVDA", "themes": [], "bull_case": "b", "bear_case": "c",
             "key_catalysts": [], "key_risks": [], "what_would_change_our_mind": [],
             "confidence": 0.5, "source_refs": []}
    adapter = TradingAgentsResearchAdapter(
        OmpClaudeGenerator(omp_path="omp", run=FakeRun(omp_stdout(f"```json\n{json.dumps(brief)}\n```"))))
    assert adapter.analyze_candidate("NVDA", []).bull_case == "b"
    bad = TradingAgentsResearchAdapter(
        OmpClaudeGenerator(omp_path="omp", run=FakeRun(omp_stdout(json.dumps({**brief, "strike": 900})))))
    with pytest.raises(ExternalResearchError, match="order fields"):
        bad.analyze_candidate("NVDA", [])
