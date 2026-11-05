"""Claude model transport through the OMP subscription (``omp -p``). Research only.

Owner rule: research model calls use Claude through the local OMP login only. No OpenAI or
Codex, no OpenRouter and no per-token ``ANTHROPIC_API_KEY``. This module never reads,
copies or changes the OMP login.

Each call runs one lean, tool-less ``omp`` process (pattern of market-watch-bot
``ops/crowncopy_reader_server.py``):

- ``-p --mode json --no-session`` and every ``--no-*`` flag: no tools, extensions, skills,
  rules, context files, LSP, title or session file;
- an advisor-off config overlay written to a temporary directory, which is also the working
  directory of the process;
- the prompt on stdin, a wall-clock timeout, and a model allow-list.

The answer is the text of the last assistant message of the ``agent_end`` JSON event.
``OmpClaudeGenerator.generate`` implements the ``ResearchGenerator`` protocol of
``agents.external_research``: it parses one JSON value (object or array) from that text,
also inside a fenced ``json`` block. ``complete`` returns the plain text for other callers.
Every failure raises ``ExternalResearchError``. Tests inject ``run`` instead of
``subprocess.run``.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agents.external_research import ExternalResearchError

DEFAULT_MODEL = "anthropic/claude-opus-5-5"
DEFAULT_ALLOWED_MODELS: frozenset[str] = frozenset({DEFAULT_MODEL})
THINKING_LEVELS: frozenset[str] = frozenset({"minimal", "low", "medium", "high", "xhigh", "max"})
DEFAULT_TIMEOUT_S = 600.0
MAX_TIMEOUT_S = 1800.0
# Lean run: the advisor is off in a per-run overlay; the CLI flags turn off everything else.
ADVISOR_OFF_OVERLAY = "advisor:\n  enabled: false\n"
DEFAULT_SYSTEM_PROMPT = (
    "You are a research analyst. You have no tools. Answer with one JSON value only, "
    "exactly matching the output contract in the user message. Research only: never write "
    "order, broker, size, strike, expiry or price-level instructions."
)
_FENCE = re.compile(r"```(?:json|JSON)?[ \t]*\r?\n(.*?)```", re.DOTALL)

Runner = Callable[..., subprocess.CompletedProcess[str]]


def default_omp_path() -> str:
    """``VERTEX_OMP_BIN`` when set, else ``~/.local/bin/omp``."""
    return os.environ.get("VERTEX_OMP_BIN") or str(Path.home() / ".local/bin/omp")


def build_command(omp: str, model: str, thinking: str, system_prompt: str, overlay: str) -> list[str]:
    """Argument vector of one lean, tool-less ``omp -p`` run. The prompt goes on stdin."""
    return [
        omp, "-p", "--mode", "json", "--no-session", "--no-tools", "--no-extensions",
        "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title",
        "--config", overlay, "--model", model, "--thinking", thinking,
        "--system-prompt", system_prompt,
    ]


def final_assistant_message(stdout: str) -> dict[str, Any]:
    """Last assistant message of the last ``agent_end`` event in ``omp --mode json`` output."""
    for line in reversed(stdout.splitlines()):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "agent_end":
            messages = [m for m in event.get("messages") or []
                        if isinstance(m, dict) and m.get("role") == "assistant"]
            if messages:
                return messages[-1]
    raise ExternalResearchError("omp output has no assistant message in an agent_end event.")


def message_text(message: dict[str, Any]) -> str:
    """Joined text parts of one assistant message (thinking parts are left out)."""
    return "".join(str(part.get("text") or "") for part in message.get("content") or []
                   if isinstance(part, dict) and part.get("type") == "text")


def extract_json(text: str) -> Any:
    """Parse one JSON object or array from model text.

    Order: the whole text, then each fenced block (```json or bare ```), then the first
    ``{`` or ``[`` that starts a valid JSON value. Raises ``ExternalResearchError``.
    """
    candidates = [text.strip(), *(block.strip() for block in _FENCE.findall(text))]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, (dict, list)):
            return value
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "{[":
            continue
        try:
            value, _ = decoder.raw_decode(text, index)
        except ValueError:
            continue
        if isinstance(value, (dict, list)):
            return value
    raise ExternalResearchError("Model answer has no JSON object or array.")


@dataclass(frozen=True)
class OmpReply:
    """One completed ``omp`` call. ``model`` and ``provider`` are what OMP reports it served."""

    name: str
    text: str
    requested_model: str
    model: str | None
    provider: str | None
    thinking: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_s: float


def _usage(message: dict[str, Any]) -> tuple[int, int, float]:
    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}

    def count(key: str) -> int:
        value = usage.get(key)
        return value if isinstance(value, int) and value >= 0 else 0

    total = cost.get("total")
    cost_usd = float(total) if isinstance(total, (int, float)) and total >= 0 else 0.0
    # Cached prompt tokens are input tokens too.
    return count("input") + count("cacheRead") + count("cacheWrite"), count("output"), cost_usd


@dataclass
class OmpClaudeGenerator:
    """``ResearchGenerator`` over ``omp -p``. Keeps one ``OmpReply`` per call in ``calls``."""

    model: str = DEFAULT_MODEL
    thinking: str = "medium"
    timeout_s: float = DEFAULT_TIMEOUT_S
    allowed_models: Iterable[str] = DEFAULT_ALLOWED_MODELS
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    omp_path: str | None = None
    run: Runner = subprocess.run
    calls: list[OmpReply] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.allowed_models = frozenset(self.allowed_models)
        if self.model not in self.allowed_models:
            raise ExternalResearchError(f"Model {self.model!r} is not in the allowed model list.")
        if self.thinking not in THINKING_LEVELS:
            raise ExternalResearchError(f"Thinking level {self.thinking!r} is not allowed.")
        if not 0 < self.timeout_s <= MAX_TIMEOUT_S:
            raise ExternalResearchError(f"Timeout must be in (0, {MAX_TIMEOUT_S:g}] seconds.")
        if not self.system_prompt.strip():
            raise ExternalResearchError("System prompt is empty.")
        self.omp_path = self.omp_path or default_omp_path()

    def command(self, overlay: str) -> list[str]:
        return build_command(str(self.omp_path), self.model, self.thinking, self.system_prompt, overlay)

    def complete(self, name: str, prompt: str) -> OmpReply:
        """Run one prompt; return the final assistant text and usage."""
        if not prompt.strip():
            raise ExternalResearchError(f"omp {name}: prompt is empty.")
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="vertex-omp-") as tmp:
            overlay = Path(tmp, "overlay.yml")
            overlay.write_text(ADVISOR_OFF_OVERLAY, encoding="utf-8")
            try:
                proc = self.run(self.command(str(overlay)), input=prompt, capture_output=True,
                                text=True, timeout=self.timeout_s, cwd=tmp, check=False)
            except subprocess.TimeoutExpired as exc:
                raise ExternalResearchError(
                    f"omp {name}: no reply in {self.timeout_s:g} s.") from exc
            except OSError as exc:
                raise ExternalResearchError(f"omp {name}: could not start omp ({exc.strerror}).") from exc
        if proc.returncode != 0:
            tail = (proc.stderr or "")[-300:].strip()
            raise ExternalResearchError(f"omp {name}: exit {proc.returncode}: {tail}")
        message = final_assistant_message(proc.stdout or "")
        stop = message.get("stopReason")
        if stop not in ("stop", None):
            detail = str(message.get("errorMessage") or "")[:200]
            raise ExternalResearchError(f"omp {name}: stop reason {stop}: {detail}")
        text = message_text(message)
        if not text.strip():
            raise ExternalResearchError(f"omp {name}: empty answer.")
        input_tokens, output_tokens, cost_usd = _usage(message)
        reply = OmpReply(
            name=name, text=text, requested_model=self.model,
            model=message.get("model") if isinstance(message.get("model"), str) else None,
            provider=message.get("provider") if isinstance(message.get("provider"), str) else None,
            thinking=self.thinking, input_tokens=input_tokens, output_tokens=output_tokens,
            cost_usd=cost_usd, latency_s=round(time.monotonic() - started, 3),
        )
        self.calls.append(reply)
        return reply

    def generate(self, name: str, prompt: str) -> Any:
        """``ResearchGenerator.generate``: the parsed JSON answer for one rendered prompt."""
        return extract_json(self.complete(name, prompt).text)


__all__: Sequence[str] = [
    "ADVISOR_OFF_OVERLAY", "DEFAULT_ALLOWED_MODELS", "DEFAULT_MODEL", "DEFAULT_SYSTEM_PROMPT",
    "OmpClaudeGenerator", "OmpReply", "THINKING_LEVELS", "build_command", "default_omp_path",
    "extract_json", "final_assistant_message", "message_text",
]
