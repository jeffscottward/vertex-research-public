"""Vibe-Trading as an agent framework (AgentFrameworkPort), research only.

Starts services/vibe-trading/driver/vt_driver.py with the Python of the Vibe-Trading clone
(VERTEX_VT_DIR/.venv, set up by scripts/vibe-trading-setup.sh), maps its JSON-line events to the run
event sink and parses the closing JSON block of the answer into the five research ratings.

Adapted from Glassbench (https://github.com/davidalmeida90/glassbench), Copyright 2026 David Arias,
Apache License 2.0, commit 255414b3f38b5def667d3b75faf1dfd7c0d25c9b, file backend/deskapp/vibe.py
(parse_decision, the action mapping, the "(omitted)" rule, the child environment and the
not-point-in-time flag). See NOTICE and licenses/glassbench-APACHE-2.0.txt.
Modified: Vertex ports and types, an allowlisted child environment (only the key the endpoint names;
Glassbench drops known keys instead), a timeout and cancellation watch on the driver, its own
filter of the driver's raw tool registry and a check of each agent's granted tools, the full-width
"（略※）" form of the omitted marker, price parsing, and token totals that take the larger of the
event sum and the swarm's own count.

The child gets no API key other than the one the endpoint names, no Vertex key and no tracing
settings. A rating is a research label: nothing here places, sizes or sends an order.
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from agents.framework_types import (
    FrameworkEvent, FrameworkInfo, FrameworkRunRequest, FrameworkRunResult, FrameworkUsage,
    ModelServed, Rating, RatingSource,
)

VT_DIR_ENV = "VERTEX_VT_DIR"
VT_DRIVER_ENV = "VERTEX_VT_DRIVER"
VT_MODE_ENV = "VERTEX_VT_MODE"  # committee (default) or single
DEFAULT_DRIVER = Path(__file__).resolve().parents[2] / "vibe-trading" / "driver" / "vt_driver.py"
NAME = "vibe_trading"
PACKAGE = "vibe-trading-ai"
BODY_PREVIEW = 2000
DESCRIBE_TIMEOUT_S = 120.0
# The read-only tools a run may use (the driver keeps the same list) and what must never appear.
ALLOWED_TOOLS = frozenset({
    "get_market_data", "technical_indicators", "get_fundamentals", "get_financial_statements",
    "get_stock_profile", "get_sector_info", "get_institutional_holdings", "get_sec_filings",
    "get_options_chain", "options_pricing", "options_payoff", "quantlib_call", "get_stock_news",
    "sentiment", "get_macro_series", "prediction_market", "web_search", "read_url", "search_symbol",
    "get_fund_flow", "get_margin_trading", "get_research_reports", "load_skill", "compact",
})
DENIED_TOOLS = frozenset({
    "bash", "background_run", "cancel_background", "check_background", "read_file", "write_file",
    "edit_file", "read_document", "read_run_artifact", "backtest", "run_shadow_backtest",
    "factor_analysis", "run_swarm", "scheduled_research", "run_research_autopilot", "remember",
    "save_skill", "delete_skill", "propose_mandate_profiles",
})
DENIED_PREFIXES = ("trading_", "etoro_", "swarm", "schedule")
# Hosted providers the driver wires (its HOSTED_PROVIDERS); any other needs an OpenAI-compatible
# base URL.
HOSTED_PROVIDERS = frozenset({"anthropic", "deepseek", "openai", "openrouter"})
# Environment variables the driver may inherit. Everything else (API keys, tokens, the Vertex key,
# tracing settings) is dropped; the endpoint's own key is added back by name.
ENV_ALLOWLIST = frozenset({
    "PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "no_proxy", "SYSTEMROOT",
})
RATING_BY_NAME: Mapping[str, Rating] = {
    "buy": "buy", "overweight": "overweight", "hold": "hold", "underweight": "underweight",
    "sell": "sell",
}
ACTION_RATING: Mapping[str, Rating] = {
    "long": "overweight", "short": "underweight", "wait": "hold", "hedge": "hold",
}
_FENCED = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)
# Vibe-Trading's grounding check replaces a figure it cannot match to the session's tool data with
# "(omitted※)" (or the full-width "（略※）"), also as a bare JSON value: read those as null.
_OMITTED_VALUE = re.compile(r":\s*(?:\(omitted[^)\n]*\)|（略[^）\n]*）)")
_OMITTED = re.compile(r"\(omitted|（略")
_NUMBER = re.compile(r"-?\d[\d,]*\.?\d*")
_SLUG = re.compile(r"[^a-z0-9_-]+")
_KINDS = frozenset({"llm_call", "tool_call", "tool_result", "reasoning", "message", "decision",
                    "status", "flag"})
_FAILED_STATUSES = frozenset({"failed", "cancelled", "error", "timeout", "run_error"})


class FrameworkSetupError(RuntimeError):
    """Vibe-Trading is not installed, or its driver breaks the read-only rules."""


@dataclass(frozen=True)
class Decision:
    rating: Rating | None
    rating_source: RatingSource
    entry: float | None
    stop: float | None
    target: float | None
    horizon: str | None
    numbers_withheld: int


def _price(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        found = _NUMBER.search(str(value))
        if found is None:
            return None
        number = float(found.group(0).replace(",", ""))
    return number if 0 < number < 1e12 else None


def parse_decision(content: str) -> Decision:
    """Reads the last fenced JSON block of the answer.

    The rating must be one of the five tiers (stated). Otherwise the action is mapped: long to
    overweight, short to underweight, wait or hedge to hold (mapped). With neither there is no
    rating (missing), never hold. "(omitted…)" values read as null.
    """
    data: dict[str, Any] = {}
    for raw in reversed(_FENCED.findall(content or "")):
        try:
            data = json.loads(_OMITTED_VALUE.sub(": null", raw))
        except json.JSONDecodeError:
            continue
        break
    stated = str(data.get("rating") or "").strip().lower()
    action = str(data.get("action") or "").strip().lower()
    rating: Rating | None
    source: RatingSource
    if stated in RATING_BY_NAME:
        rating, source = RATING_BY_NAME[stated], "stated"
    elif action in ACTION_RATING:
        rating, source = ACTION_RATING[action], "mapped"
    else:
        rating, source = None, "missing"
    horizon_value = data.get("horizon")
    horizon = None if horizon_value is None else (str(horizon_value).strip()[:64] or None)
    return Decision(
        rating=rating, rating_source=source, entry=_price(data.get("entry")),
        stop=_price(data.get("stop")), target=_price(data.get("target")),
        horizon=horizon,
        numbers_withheld=len(_OMITTED.findall(content or "")),
    )


def child_environment(environ: Mapping[str, str], api_key_env: str | None) -> dict[str, str]:
    """The driver's environment: the allowlisted basics plus the endpoint's own key only."""
    env = {name: value for name, value in environ.items()
           if name in ENV_ALLOWLIST or name.startswith("LC_")}
    if api_key_env and environ.get(api_key_env):
        env[api_key_env] = environ[api_key_env]
    env["PYTHONUTF8"] = "1"
    return env


def outside_policy(names: Sequence[Any]) -> list[str]:
    """The names that leave the read-only tool list (or are not tool names at all)."""
    return sorted(str(name) for name in names
                  if not isinstance(name, str) or name not in ALLOWED_TOOLS
                  or name in DENIED_TOOLS or name.startswith(DENIED_PREFIXES))


def check_granted(agent: str, names: Any) -> None:
    """Refuses tools granted to an agent outside the read-only list (an empty grant is fine)."""
    if not isinstance(names, list):
        raise FrameworkSetupError(f"the driver reports no tool list for {agent}")
    bad = outside_policy(names)
    if bad:
        raise FrameworkSetupError(f"the driver grants {agent} tools outside the read-only list: {bad}")


def _flag(title: str) -> str:
    slug = _SLUG.sub("_", title.strip().lower()).strip("_-")
    return (slug if slug[:1].isalpha() else f"f_{slug}")[:40] or "flag"


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


class VibeTradingFramework:
    """AgentFrameworkPort over the Vibe-Trading driver (one subprocess per run)."""

    def __init__(self, vt_dir: Path, *, python: Path | None = None, driver: Path = DEFAULT_DRIVER,
                 mode: str = "committee", max_iterations: int = 25,
                 environ: Mapping[str, str] | None = None,
                 today: Callable[[], date] = date.today,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if mode not in ("committee", "single"):
            raise ValueError("mode must be committee or single")
        self.vt_dir = Path(vt_dir).expanduser()
        self.python = python or self.vt_dir / ".venv" / "bin" / "python"
        self.driver = driver
        self.mode, self.max_iterations = mode, max_iterations
        self.environ = dict(os.environ if environ is None else environ)
        self.today, self.clock = today, clock
        self._info: FrameworkInfo | None = None

    @classmethod
    def from_env(cls, environ: Mapping[str, str], **kwargs: Any) -> VibeTradingFramework:
        vt_dir = environ.get(VT_DIR_ENV, "")
        if not vt_dir:
            raise FrameworkSetupError(f"set {VT_DIR_ENV} to the Vibe-Trading clone "
                                      "(scripts/vibe-trading-setup.sh)")
        driver = Path(environ[VT_DRIVER_ENV]) if environ.get(VT_DRIVER_ENV) else DEFAULT_DRIVER
        kwargs.setdefault("mode", environ.get(VT_MODE_ENV) or "committee")
        return cls(Path(vt_dir), driver=driver, environ=environ, **kwargs)

    # Port ------------------------------------------------------------------------------------------

    def describe(self) -> FrameworkInfo:
        if self._info is not None:
            return self._info
        if not Path(self.python).exists() or not Path(self.driver).exists():
            raise FrameworkSetupError(f"Vibe-Trading is not installed at {self.vt_dir} "
                                      "(run scripts/vibe-trading-setup.sh)")
        run_dir = tempfile.mkdtemp(prefix="vertex-vt-describe-")
        try:
            completed = subprocess.run(
                [str(self.python), str(self.driver), "--describe", "--vt-dir", str(self.vt_dir),
                 "--run-dir", run_dir],
                capture_output=True, text=True, timeout=DESCRIBE_TIMEOUT_S, check=False,
                env=child_environment(self.environ, None), cwd=run_dir,
            )
        except subprocess.TimeoutExpired:
            raise FrameworkSetupError("the Vibe-Trading driver did not describe itself in time") from None
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)
        try:
            line = next((json.loads(text) for text in completed.stdout.splitlines()[::-1]
                         if text.startswith("{")), {})
        except json.JSONDecodeError:
            raise FrameworkSetupError("the Vibe-Trading driver printed a line that is not JSON") from None
        if not isinstance(line, dict) or line.get("type") != "describe":
            error = line.get("error") if isinstance(line, dict) else None
            raise FrameworkSetupError(f"the Vibe-Trading driver failed to describe itself: "
                                      f"{str(error or completed.returncode)[:300]}")
        names = line.get("tools")
        if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
            raise FrameworkSetupError("the Vibe-Trading driver reports no tool list")
        # The driver's own allowlist must stay inside ours: an edited driver is refused.
        check_granted("the driver allowlist", line.get("allowlist"))
        bad = set(outside_policy(names))
        allowed = [name for name in names if name not in bad]
        if not allowed:
            raise FrameworkSetupError("the Vibe-Trading registry has no tool on the read-only list")
        commit = str(line.get("commit") or "")
        version = f"{PACKAGE} {line.get('package') or 'unknown'}" + (f"+{commit}" if commit else "")
        self._info = FrameworkInfo(name=NAME, version=version[:64], tools_allowed=tuple(allowed),
                                   tools_excluded=tuple(sorted(bad)))
        return self._info

    def run(self, request: FrameworkRunRequest, sink: Any, cancellation: Any) -> FrameworkRunResult:
        self.describe()
        endpoint = request.endpoint
        flags: list[str] = []
        if request.decision_date < self.today():
            # Vibe-Trading has no date input: its prompt carries today's date and its news and web
            # tools return current items.
            flags.append("not_point_in_time")
            sink.emit(FrameworkEvent(agent="vertex", kind="flag", title="not_point_in_time",
                                     body="Vibe-Trading has no date input; its tools return current data."))
        run_dir = tempfile.mkdtemp(prefix="vertex-vt-")
        argv = [str(self.python), str(self.driver), "--ticker", request.ticker,
                "--date", request.decision_date.isoformat(), "--model", endpoint.model,
                "--provider", endpoint.provider, "--run-dir", run_dir, "--vt-dir", str(self.vt_dir),
                "--mode", self.mode, "--max-iter", str(self.max_iterations),
                "--timeout", str(int(request.timeout_s))]
        if endpoint.base_url:
            argv += ["--base-url", endpoint.base_url]
        if endpoint.api_key_env:
            argv += ["--api-key-env", endpoint.api_key_env]
        try:
            return self._drive(argv, run_dir, request, sink, cancellation, flags)
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)

    # Driver ----------------------------------------------------------------------------------------

    def _drive(self, argv: list[str], run_dir: str, request: FrameworkRunRequest, sink: Any,
               cancellation: Any, flags: list[str]) -> FrameworkRunResult:
        started = self.clock()
        deadline = started + request.timeout_s
        usage = {"input": 0, "output": 0, "llm": 0, "tool": 0}
        served: dict[str, None] = {}
        result: dict[str, Any] | None = None
        failure: str | None = None
        log_path = Path(run_dir) / "driver.log"
        with open(log_path, "w", encoding="utf-8") as log:
            process = subprocess.Popen(
                argv, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8", cwd=run_dir,
                env=child_environment(self.environ, request.endpoint.api_key_env),
            )
            lines: queue.Queue[str | None] = queue.Queue()
            reader = threading.Thread(target=_pump, args=(process.stdout, lines), daemon=True)
            reader.start()
            try:
                while True:
                    if cancellation.cancelled():
                        failure = "cancelled by the operator"
                        break
                    if self.clock() > deadline:
                        failure = f"Vibe-Trading did not finish within {request.timeout_s:g} s"
                        flags.append("worker_timeout")
                        break
                    try:
                        raw = lines.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if raw is None:
                        break
                    try:
                        line = json.loads(raw)
                    except json.JSONDecodeError:
                        log.write(raw)
                        continue
                    if not isinstance(line, dict):
                        continue
                    kind = line.get("type")
                    if kind == "event":
                        self._relay(line, sink, usage, served, flags)
                    elif kind in ("started", "tools"):
                        grants = (line.get("agents") if kind == "started"
                                  else {str(line.get("agent") or "vibe"): line.get("tools")})
                        try:
                            self._check_grants(grants, sink)
                        except FrameworkSetupError as error:
                            failure = str(error)[:1500]
                            flags.append("tool_policy")
                            break
                    elif kind == "result":
                        result = line
                    elif kind == "failed":
                        failure = str(line.get("error") or "Vibe-Trading failed")[:1500]
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                reader.join(timeout=5)
        return self._result(result, failure, process.returncode, request, sink, usage, served,
                            flags, int((self.clock() - started) * 1000))

    @staticmethod
    def _check_grants(grants: Any, sink: Any) -> None:
        """Each agent's granted tools must stay on the read-only list; each grant is an event."""
        if not isinstance(grants, dict):
            raise FrameworkSetupError("the driver reports no tool grants")
        for agent, names in grants.items():
            check_granted(str(agent)[:100], names)
            sink.emit(FrameworkEvent(agent=str(agent)[:100] or "vibe", kind="status",
                                     title=f"Tools: {len(names)}",
                                     body=", ".join(names)[:BODY_PREVIEW] or None))

    def _relay(self, line: Mapping[str, Any], sink: Any, usage: dict[str, int],
               served: dict[str, None], flags: list[str]) -> None:
        kind = line.get("kind")
        if kind not in _KINDS:
            return
        title = str(line.get("title") or kind)
        if kind == "flag":
            title = _flag(title)
            flags.append(title)
        if kind == "llm_call":
            usage["llm"] += 1
            usage["input"] += _int(line.get("inputTokens")) or 0
            usage["output"] += _int(line.get("outputTokens")) or 0
            if line.get("servedModel"):
                served[str(line["servedModel"])[:200]] = None
        elif kind == "tool_call":
            usage["tool"] += 1
        body = line.get("body")
        sink.emit(FrameworkEvent(
            agent=str(line.get("agent") or "vibe")[:100], kind=kind, title=title[:300],
            body=None if body is None else str(body)[:BODY_PREVIEW],
            model=str(line["model"])[:200] if line.get("model") else None,
            tool_name=str(line["toolName"])[:100] if line.get("toolName") else None,
            input_tokens=_int(line.get("inputTokens")), output_tokens=_int(line.get("outputTokens")),
            duration_ms=_int(line.get("durationMs")),
        ))

    def _result(self, result: Mapping[str, Any] | None, failure: str | None, code: int | None,
                request: FrameworkRunRequest, sink: Any, usage: dict[str, int],
                served: dict[str, None], flags: list[str], elapsed_ms: int) -> FrameworkRunResult:
        # The swarm's own totals cover calls whose usage the LLM tap could not read.
        reported = result.get("tokens") if result is not None else None
        if (isinstance(reported, list) and len(reported) == 2
                and all(_int(value) is not None for value in reported)):
            usage["input"] = max(usage["input"], reported[0])
            usage["output"] = max(usage["output"], reported[1])
        totals = FrameworkUsage(input_tokens=usage["input"], output_tokens=usage["output"],
                                llm_calls=usage["llm"], tool_calls=usage["tool"], duration_ms=elapsed_ms)
        models = tuple(ModelServed(requested=request.endpoint.model, served=name) for name in served)[:16]

        def failed(error: str) -> FrameworkRunResult:
            return FrameworkRunResult(usage=totals, models_served=models, error=error[:2000],
                                      flags=tuple(dict.fromkeys(flags)))

        if failure is not None:
            return failed(failure)
        if result is None:
            return failed(f"Vibe-Trading exited with code {code} before a result")
        content = str(result.get("content") or "")
        decision = parse_decision(content)
        status = str(result.get("status") or "").lower()
        if decision.rating is None and status in _FAILED_STATUSES:
            return failed(f"Vibe-Trading ended with status {status!r} before a decision")
        if decision.rating is None:
            flags.append("no_rating")
        if decision.numbers_withheld:
            flags.append("numbers_withheld")
        sink.emit(FrameworkEvent(
            agent="decision", kind="decision", title=f"Rating: {decision.rating or 'none'}",
            body=json.dumps({"rating": decision.rating, "ratingSource": decision.rating_source,
                             "entry": decision.entry, "stop": decision.stop,
                             "target": decision.target, "horizon": decision.horizon}),
        ))
        return FrameworkRunResult(
            rating=decision.rating, rating_source=decision.rating_source, entry_price=decision.entry,
            stop_price=decision.stop, target_price=decision.target, horizon=decision.horizon,
            usage=totals, models_served=models, flags=tuple(dict.fromkeys(flags)),
        )


def _pump(stream: Any, lines: queue.Queue[str | None]) -> None:
    try:
        for raw in stream:
            lines.put(raw)
    finally:
        lines.put(None)
