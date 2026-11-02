"""Vertex driver for one Vibe-Trading analysis. Runs inside Vibe-Trading's own virtual environment.

Adapted from Glassbench (https://github.com/davidalmeida90/glassbench), Copyright 2026 David Arias,
Apache License 2.0, commit 255414b3f38b5def667d3b75faf1dfd7c0d25c9b, file backend/drivers/vt_driver.py.
See NOTICE and licenses/glassbench-APACHE-2.0.txt.
Modified: Vertex event protocol (one JSON object per line with agent, kind, title, a body preview of at
most 2000 characters, model, tokens and served model) and a closing result line; hosted providers
(openai, deepseek, openrouter, anthropic) and any OpenAI-compatible base URL; only the endpoint's key
survives, passed under the variable Vibe-Trading reads; a clone with agent/.env is refused; a denylist
guard on the tool allowlist and an allowlist check on every tool call; --describe reports the raw
registry and each agent's granted tools are reported for the adapter to check; git runs with a
minimal environment; no tool output files; the environment and committee member settings are split
into testable functions.

Vibe-Trading (https://github.com/HKUDS/Vibe-Trading, MIT) is not part of this repository. The setup
script scripts/vibe-trading-setup.sh clones a pinned commit outside the repository. Research only:
the agents get read-only data tools and pure computation tools; no shell, no file access, no
backtests (they run generated code) and no broker, trading, swarm or scheduler tools.

    <vt python> vt_driver.py --ticker NVDA --date 2026-10-28 --provider openai --model gpt-4o-mini \\
        --run-dir /tmp/vertex-vt-xyz --vt-dir ~/Github/tools/vibe-trading [--base-url URL] [--mode single]
    <vt python> vt_driver.py --describe --vt-dir ~/Github/tools/vibe-trading --run-dir /tmp/x

Output lines (stdout, UTF-8):
    {"type": "describe", "package": ..., "commit": ..., "tools": [raw registry names], ...}  (--describe)
    {"type": "version", "package": ..., "commit": ...}
    {"type": "started", "mode": ..., "agents": {agent: [granted tools]}}
    {"type": "tools", "agent": ..., "tools": [tools in that agent's registry]}   (committee, per agent)
    {"type": "event", "agent": ..., "kind": ..., "title": ..., "body": ..., "model": ..., ...}
    {"type": "result", "status": ..., "content": ..., "tokens": [input, output]}   (last line)
    {"type": "failed", "error": ...}                                              (instead of a result)
"""
from __future__ import annotations

import argparse
import contextvars
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

AGENT = "vibe"  # the single agent's lane
PREVIEW_CHARS = 2000
# Read-only data tools plus pure computation (quantlib_call over Vibe-Trading's allowlisted maths
# modules, options_payoff). Every other tool stays out of every registry.
TOOL_ALLOWLIST = (
    "get_market_data", "technical_indicators", "get_fundamentals", "get_financial_statements",
    "get_stock_profile", "get_sector_info", "get_institutional_holdings", "get_sec_filings",
    "get_options_chain", "options_pricing", "options_payoff", "quantlib_call", "get_stock_news",
    "sentiment", "get_macro_series", "prediction_market", "web_search", "read_url", "search_symbol",
    "get_fund_flow", "get_margin_trading", "get_research_reports", "load_skill", "compact",
)
# Never allowed, whatever the allowlist says: shell, files, generated code, memory writes, swarms,
# schedulers and anything that reaches a broker.
TOOL_DENYLIST = (
    "bash", "background_run", "cancel_background", "check_background", "read_file", "write_file",
    "edit_file", "read_document", "read_run_artifact", "backtest", "run_shadow_backtest",
    "factor_analysis", "run_swarm", "scheduled_research", "run_research_autopilot", "remember",
    "save_skill", "delete_skill", "propose_mandate_profiles",
)
DENIED_PREFIXES = ("trading_", "etoro_", "swarm", "schedule")
COMMITTEE_EXTRA_TOOLS = ("quantlib_call", "technical_indicators")
HOSTED_PROVIDERS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
TRACING_PREFIXES = ("LANGSMITH_", "LANGCHAIN_TRACING", "LANGCHAIN_API_KEY", "LANGCHAIN_ENDPOINT",
                    "LANGCHAIN_PROJECT")
DECISION_BLOCK = """End your answer with one JSON block in ```json fences``` with exactly these keys:
  "rating": one of "Buy", "Overweight", "Hold", "Underweight", "Sell"
  "action": one of "long", "short", "wait", "hedge"
  "entry", "stop", "target": prices in USD, or null
  "horizon": for example "3 months"
  "confidence": 0 to 100
  "thesis": one sentence"""
PROMPT = """Analyse {ticker}, a US listed stock, as of {date}. Use only information available up to that
date. Research the price action and technical indicators, the fundamentals and latest financial
statements, recent news and sentiment, then take a research stance for the next 1 to 3 months.

""" + DECISION_BLOCK
NO_SHELL_NOTE = """

## Environment for this run (Vertex)
There is no bash, no file access and no backtest tool here. Compute risk and valuation numbers with
the quantlib_call tool, which calls public functions of src.quantlib on data you fetched with the
data tools. If a number cannot be computed that way, say it is unavailable instead of estimating it."""
PM_NOTE = "\n\n## Closing block (Vertex)\n" + DECISION_BLOCK

_LOCK = threading.Lock()
CURRENT_AGENT: contextvars.ContextVar[str] = contextvars.ContextVar("vt_agent", default=AGENT)


def is_denied(name: str) -> bool:
    return name in TOOL_DENYLIST or name.startswith(DENIED_PREFIXES)


# The allowlist must never name a denied tool; checked at import so a bad edit cannot run.
_BAD = [name for name in TOOL_ALLOWLIST if is_denied(name)]
if _BAD:  # pragma: no cover - guarded by a test
    raise SystemExit(f"tool allowlist names denied tools: {_BAD}")


def preview(text: Any) -> str | None:
    if text is None:
        return None
    value = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False, default=str)
    return value[:PREVIEW_CHARS] if value else None


def write_line(line: dict[str, Any], stream: Any = None) -> None:
    out = stream if stream is not None else sys.stdout
    with _LOCK:
        out.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        out.flush()


def emit(agent: str, kind: str, title: str, **fields: Any) -> None:
    """One Vertex event. Empty fields are left out; the body is a preview."""
    line: dict[str, Any] = {"type": "event", "agent": agent, "kind": kind, "title": title[:300]}
    for key, value in fields.items():
        if key == "body":
            value = preview(value)
        if value is not None and value != "":
            line[key] = value
    write_line(line)


def scrub_environment(environ: dict[str, str]) -> None:
    """Removes tracing settings (LangSmith) so no prompt leaves the machine for a tracer."""
    for name in list(environ):
        if name.startswith(TRACING_PREFIXES):
            environ.pop(name)


def prepare_environment(args: argparse.Namespace, env: dict[str, str], home: Path,
                        probe: Callable[[str], int | None] | None = None) -> None:
    """Vibe-Trading reads its configuration from the environment; this sets it in `env`.

    Only the key the endpoint needs survives, under the name Vibe-Trading reads; tracing settings
    go. `probe` asks a local server for its context size (local_context_window by default)."""
    scrub_environment(env)
    env.update(VIBE_TRADING_HOME=str(home), USERPROFILE=str(home), HOME=str(home), PYTHONUTF8="1",
               LANGCHAIN_MODEL_NAME=args.model or "")
    env.setdefault("LANGCHAIN_MAX_TOKENS", "8192")
    named = args.api_key_env or ""
    key = env.get(named, "") if named else ""
    if named:
        env.pop(named, None)
    if args.base_url:
        # Any OpenAI-compatible server (llama.cpp llama-server, Ollama /v1, LM Studio, vLLM). A local
        # server needs no key; Vibe-Trading insists on one, so a placeholder fills it.
        for name in HOSTED_PROVIDERS.values():
            env.pop(name, None)
        env.update(LANGCHAIN_PROVIDER="openai", OPENAI_BASE_URL=args.base_url,
                   OPENAI_API_KEY=key or "sk-local")
        window = (probe or local_context_window)(args.base_url)
        if window:
            env["VIBE_TRADING_CONTEXT_WINDOW"] = str(window)
        # A local server answers one request at a time: run the workers one after the other and
        # give a long answer time; keep replies shorter so the context window holds the committee.
        env.update(TIMEOUT_SECONDS="1800", SWARM_MAX_WORKERS="1", SWARM_TIMEOUT="10800",
                   LANGCHAIN_MAX_TOKENS="4096")
    elif args.provider in HOSTED_PROVIDERS:
        needed = HOSTED_PROVIDERS[args.provider]
        key = key or env.get(needed, "")
        for name in HOSTED_PROVIDERS.values():
            env.pop(name, None)
        if not key:
            raise SystemExit(f"{named or needed} is not set for provider {args.provider}")
        env[needed] = key
        env["LANGCHAIN_PROVIDER"] = args.provider
        if args.provider == "deepseek":
            # 1M tokens per api-docs.deepseek.com (Glassbench, read 2026-10-28).
            env.setdefault("VIBE_TRADING_CONTEXT_WINDOW", "1000000")
    elif args.provider:
        raise SystemExit(f"provider {args.provider!r} is not wired; use a base URL or one of "
                         f"{', '.join(sorted(HOSTED_PROVIDERS))}")
    else:
        for name in HOSTED_PROVIDERS.values():
            env.pop(name, None)


def setup_env(args: argparse.Namespace) -> Path:
    """Sets the environment before Vibe-Trading's modules load, then enters the run folder."""
    run_dir = Path(args.run_dir).resolve()
    home = run_dir / "vt_home"
    home.mkdir(parents=True, exist_ok=True)
    vt_dir = Path(args.vt_dir).resolve()
    # Vibe-Trading fills unset variables from <clone>/agent/.env (keys, tracing, broker settings).
    if (vt_dir / "agent" / ".env").exists():
        raise SystemExit(f"remove {vt_dir / 'agent' / '.env'}: Vertex passes settings by environment")
    prepare_environment(args, os.environ, home)  # type: ignore[arg-type]
    sys.path.insert(0, str(vt_dir / "agent"))
    os.chdir(run_dir)
    return vt_dir


def local_context_window(base_url: str) -> int | None:
    """The context size a llama.cpp server serves (/props n_ctx); None elsewhere."""
    import urllib.request

    root = base_url.rstrip("/").removesuffix("/v1")
    try:
        with urllib.request.urlopen(f"{root}/props", timeout=3) as response:
            props = json.loads(response.read())
        return int((props.get("default_generation_settings") or {}).get("n_ctx") or 0) or None
    except Exception:  # noqa: BLE001 - any failure means "unknown"
        return None


def vt_version(vt_dir: Path) -> tuple[str, str]:
    """(package version, short commit) of the clone."""
    import importlib.metadata as metadata
    import subprocess

    try:
        package = metadata.version("vibe-trading-ai")
    except metadata.PackageNotFoundError:
        package = "unknown"
    # git needs no key: a minimal environment keeps the provider key out of the child.
    sha = subprocess.run(["git", "-C", str(vt_dir), "rev-parse", "--short", "HEAD"],
                         capture_output=True, text=True, check=False,
                         env={"PATH": os.environ.get("PATH", ""), "LC_ALL": "C"}).stdout.strip()
    return package, sha


def restrict_and_tap(registry: Any, agent: str = AGENT) -> list[str]:
    """Keeps only allowlisted tools and reports every call; a call to any other tool is refused.

    The tap sits on each tool object, not on the registry: Vibe-Trading's deferred registry copies the
    tool objects, so a registry-level patch would be bypassed."""
    registry._tools = {name: tool for name, tool in registry._tools.items()
                       if name in TOOL_ALLOWLIST and not is_denied(name)}

    def tap(name: str, execute: Callable[..., Any]) -> Callable[..., Any]:
        def tapped(**params: Any) -> Any:
            if name not in TOOL_ALLOWLIST or is_denied(name):
                raise PermissionError(f"tool {name} is not allowed in a Vertex run")
            shown = {key: value for key, value in params.items() if key != "run_dir"}
            emit(agent, "tool_call", name, toolName=name, body=shown)
            start = time.time()
            try:
                result = execute(**params)
            except Exception as error:
                emit(agent, "tool_result", f"{name} failed", toolName=name, body=str(error),
                     durationMs=int((time.time() - start) * 1000))
                raise
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False,
                                                                     default=str)
            emit(agent, "tool_result", f"{name}: {len(text)} characters", toolName=name, body=text,
                 durationMs=int((time.time() - start) * 1000))
            head = text[:300].lower()
            if head.startswith(("error", '{"error', '{"status": "error')) or '"status": "error"' in head:
                emit(agent, "flag", "tool_error", toolName=name, body=text[:300])
            return result

        return tapped

    for name, tool in registry._tools.items():
        if name != "compact":
            tool.execute = tap(name, tool.execute)
    return sorted(registry._tools)


def llm_usage(response: Any) -> tuple[int, int, str | None]:
    """(input tokens, output tokens, served model) of a LangChain LLMResult; zeros when absent."""
    try:
        message = response.generations[0][0].message
        usage = getattr(message, "usage_metadata", None) or {}
        served = (getattr(message, "response_metadata", None) or {}).get("model_name")
        return (int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0),
                str(served) if served else None)
    except (AttributeError, IndexError, TypeError, ValueError):
        return 0, 0, None


def make_llm_tap(model: str, agent_of: Callable[[], str]) -> Any:
    from langchain_core.callbacks import BaseCallbackHandler

    class LlmTap(BaseCallbackHandler):
        def __init__(self) -> None:
            self._start: dict[str, float] = {}

        def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):  # noqa: ANN001
            self._start[str(run_id)] = time.time()

        def on_llm_end(self, response, *, run_id, **kwargs):  # noqa: ANN001
            tokens_in, tokens_out, served = llm_usage(response)
            start = self._start.pop(str(run_id), time.time())
            emit(agent_of(), "llm_call", f"{model} call", model=model, servedModel=served,
                 inputTokens=tokens_in, outputTokens=tokens_out,
                 durationMs=int((time.time() - start) * 1000))

        def on_llm_error(self, error, *, run_id, **kwargs):  # noqa: ANN001
            self._start.pop(str(run_id), None)
            emit(agent_of(), "status", "LLM call failed", body=str(error)[:500])

    return LlmTap()


def describe(args: argparse.Namespace) -> int:
    vt_dir = setup_env(args)
    from src.tools import build_registry

    # The raw registry: the adapter applies its own copy of the allowlist to these names.
    names = sorted(build_registry(include_shell_tools=False)._tools)
    package, sha = vt_version(vt_dir)
    write_line({
        "type": "describe", "package": package, "commit": sha, "tools": names,
        "allowlist": list(TOOL_ALLOWLIST), "denylist": list(TOOL_DENYLIST),
        "denied_prefixes": list(DENIED_PREFIXES),
    })
    return 0


def run_single(args: argparse.Namespace) -> dict[str, Any]:
    import uuid

    from src.agent.loop import AgentLoop
    from src.memory.persistent import PersistentMemory
    from src.providers.chat import ChatLLM
    from src.tools import build_registry

    session = f"vertex-{uuid.uuid4().hex[:8]}"
    memory = PersistentMemory()
    registry = build_registry(persistent_memory=memory, include_shell_tools=False,
                              session_id=session, interactive=False)
    tools = restrict_and_tap(registry)
    llm = ChatLLM(model_name=args.model)
    llm._llm.callbacks = [*(getattr(llm._llm, "callbacks", None) or []),
                          make_llm_tap(args.model, lambda: AGENT)]
    write_line({"type": "started", "mode": "single", "agents": {AGENT: tools}})
    emit(AGENT, "status", "started")
    agent = AgentLoop(registry=registry, llm=llm, max_iterations=args.max_iter,
                      persistent_memory=memory)
    result = agent.run(PROMPT.format(ticker=args.ticker, date=args.date), session_id=session)
    content = str(result.get("content") or "")
    emit(AGENT, "message", "Answer", body=content)
    emit(AGENT, "status", "finished")
    return {"status": result.get("status"), "content": content}


def adapt_agent_spec(spec: Any, max_iter: int, local: bool) -> None:
    """One committee member for a Vertex run: allowlisted tools only (plus the maths tools), the
    no-shell note, the closing block for the portfolio manager, a step cap and, on a local server,
    a longer timeout."""
    spec.tools = [tool for tool in dict.fromkeys([*spec.tools, *COMMITTEE_EXTRA_TOOLS])
                  if tool in TOOL_ALLOWLIST and not is_denied(tool)]
    spec.system_prompt += NO_SHELL_NOTE + (PM_NOTE if spec.id == "portfolio_manager" else "")
    cap = min(max_iter, 10) if local else max_iter
    spec.max_iterations = min(spec.max_iterations or cap, cap)
    if local:
        spec.timeout_seconds = max(spec.timeout_seconds or 0, 3600)


def run_committee(args: argparse.Namespace) -> dict[str, Any]:
    """Vibe-Trading's investment_committee preset through its own SwarmRuntime, with Vertex hooks."""
    import src.swarm.runtime as runtime
    import src.swarm.worker as worker
    from src.config.accessor import get_env_config
    from src.config.loader import load_swarm_agent_config
    from src.config.paths import get_swarm_runs_dir
    from src.swarm.store import SwarmStore

    local = bool(args.base_url)
    build_run = runtime.build_run_from_preset

    def build_run_for_vertex(name: str, user_vars: dict[str, str]) -> Any:
        run = build_run(name, user_vars)
        for spec in run.agents:
            adapt_agent_spec(spec, args.max_iter, local)
        # The tools each member is granted; each one's registry is reported again once it is built.
        write_line({"type": "started", "mode": "committee", "preset": name,
                    "agents": {spec.id: list(spec.tools) for spec in run.agents}})
        return run

    run_worker = runtime.run_worker

    def run_worker_in_lane(*positional: Any, **named: Any) -> Any:
        token = CURRENT_AGENT.set(named["agent_spec"].id)
        try:
            return run_worker(*positional, **named)
        finally:
            CURRENT_AGENT.reset(token)

    build_registry = worker.build_swarm_registry

    def build_tapped_registry(tool_names: list[str], **named: Any) -> Any:
        registry = build_registry([name for name in tool_names
                                   if name in TOOL_ALLOWLIST and not is_denied(name)], **named)
        agent = CURRENT_AGENT.get()
        write_line({"type": "tools", "agent": agent, "tools": restrict_and_tap(registry, agent)})
        return registry

    chat_class = worker.ChatLLM

    class TappedChatLLM(chat_class):  # type: ignore[misc, valid-type]
        def __init__(self, *positional: Any, **named: Any) -> None:
            super().__init__(*positional, **named)
            self._llm.callbacks = [*(getattr(self._llm, "callbacks", None) or []),
                                   make_llm_tap(args.model, CURRENT_AGENT.get)]

    runtime.build_run_from_preset = build_run_for_vertex
    runtime.run_worker = run_worker_in_lane
    worker.build_swarm_registry = build_tapped_registry
    worker.ChatLLM = TappedChatLLM

    store = SwarmStore(base_dir=get_swarm_runs_dir())
    swarm = runtime.SwarmRuntime(store=store, max_workers=get_env_config().swarm.swarm_max_workers,
                                 agent_config=load_swarm_agent_config())
    done = threading.Event()
    reported: set[str] = set()
    holder: dict[str, Any] = {}

    def report_finished_tasks() -> Any:
        run = store.load_run(holder["id"]) if holder.get("id") else None
        if run is None:
            return None
        for task in run.tasks:
            if task.agent_id in reported or not task.summary:
                continue
            reported.add(task.agent_id)
            emit(task.agent_id, "message", "Report", body=task.summary)
        return run

    def on_swarm(event: Any) -> None:
        kind, agent, data = event.type, event.agent_id, event.data or {}
        if kind == "worker_started" and agent:
            emit(agent, "status", "started")
        elif kind == "worker_completed" and agent:
            emit(agent, "status", "finished")
        elif kind in ("worker_failed", "worker_timeout", "worker_iteration_limit",
                      "worker_token_limit", "worker_incomplete"):
            emit(agent or AGENT, "flag", kind.removeprefix("worker_"),
                 body=str(data.get("error") or data.get("tokens") or ""))
        elif kind == "task_completed":
            report_finished_tasks()
        elif kind in ("run_completed", "run_error"):
            holder["final_status"] = data.get("status") or kind
            done.set()

    run = swarm.start_run("investment_committee", {"target": args.ticker, "market": "US"},
                          live_callback=on_swarm, include_shell_tools=False)
    holder["id"] = run.id
    timeout = args.timeout or (10800 if local else 3600)
    deadline = time.time() + timeout
    while not done.wait(5):
        alive = any(thread.name == f"swarm-{run.id}" and thread.is_alive()
                    for thread in threading.enumerate())
        if not alive and not done.is_set():
            raise RuntimeError("Vibe-Trading's swarm stopped without finishing")
        if time.time() > deadline:
            swarm.cancel_run(run.id)
            emit(AGENT, "flag", "worker_timeout", body=f"committee cancelled after {timeout} s")
            raise RuntimeError(f"Vibe-Trading's committee did not finish within {timeout} s")
    run = report_finished_tasks() or run
    summaries = {task.agent_id: task.summary or "" for task in run.tasks}
    return {"status": holder.get("final_status"), "content": summaries.get("portfolio_manager", ""),
            "tokens": [run.total_input_tokens, run.total_output_tokens]}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker")
    parser.add_argument("--date")
    parser.add_argument("--model", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--api-key-env", default="")
    parser.add_argument("--run-dir", default=".")
    parser.add_argument("--vt-dir", required=True)
    parser.add_argument("--mode", choices=("committee", "single"), default="committee")
    parser.add_argument("--max-iter", type=int, default=25)
    parser.add_argument("--timeout", type=int, default=None)
    parser.add_argument("--describe", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - needs Vibe-Trading
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(argv)
    try:
        if args.describe:
            return describe(args)
        vt_dir = setup_env(args)
        package, sha = vt_version(vt_dir)
        write_line({"type": "version", "package": package, "commit": sha})
        result = run_committee(args) if args.mode == "committee" else run_single(args)
        write_line({"type": "result", **result})
        return 0
    except SystemExit as stop:
        write_line({"type": "failed", "error": str(stop.code)[:1000]})
        return 2
    except Exception as error:  # noqa: BLE001 - reported to the adapter as a failed run
        write_line({"type": "failed", "error": f"{type(error).__name__}: {error}"[:1000]})
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
