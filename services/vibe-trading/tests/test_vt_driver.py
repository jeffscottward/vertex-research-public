"""Vertex Vibe-Trading driver logic that runs without Vibe-Trading installed.

The tool guard, event shaping, environment stripping, the committee member settings (closing block
request) and the describe output use stand-ins for Vibe-Trading's registry and specs. The smoke test
at the end runs the real driver against a clone and is skipped unless VERTEX_VT_DIR is set.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import subprocess
import sys
import threading
import types
from pathlib import Path
from typing import Any

import pytest

import vt_driver as d

DRIVER = Path(d.__file__)


def args(**fields: Any) -> argparse.Namespace:
    base = d.parse_args(["--vt-dir", "/opt/vt"])
    for name, value in fields.items():
        setattr(base, name, value)
    return base


def lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(text) for text in capsys.readouterr().out.splitlines()]


# Tool guard ---------------------------------------------------------------------------------------

def test_the_allowlist_names_no_denied_tool():
    assert not [name for name in d.TOOL_ALLOWLIST if d.is_denied(name)]
    assert not set(d.COMMITTEE_EXTRA_TOOLS) - set(d.TOOL_ALLOWLIST)
    for name in ("bash", "read_file", "write_file", "backtest", "factor_analysis", "run_swarm",
                 "trading_place_order", "etoro_buy", "swarm_anything", "scheduled_research"):
        assert d.is_denied(name)
    for name in ("get_market_data", "quantlib_call", "options_payoff"):
        assert not d.is_denied(name)


def test_a_denied_tool_in_the_allowlist_stops_the_driver_at_import():
    source = DRIVER.read_text(encoding="utf-8")
    bad = source.replace('"load_skill", "compact",', '"load_skill", "compact", "trading_order",', 1)
    assert bad != source
    with pytest.raises(SystemExit, match="trading_order"):
        exec(compile(bad, str(DRIVER), "exec"), {"__name__": "vt_driver_bad"})  # noqa: S102


class Tool:
    def __init__(self, name: str, result: Any = "ok", error: Exception | None = None) -> None:
        self.name, self.result, self.error, self.calls = name, result, error, []

    def execute(self, **params: Any) -> Any:
        self.calls.append(params)
        if self.error is not None:
            raise self.error
        return self.result


def registry(*tools: Tool) -> Any:
    return types.SimpleNamespace(_tools={tool.name: tool for tool in tools})


def test_restrict_keeps_allowlisted_tools_and_reports_each_call(capsys, monkeypatch):
    market = Tool("get_market_data", {"close": [1, 2]})
    failing = Tool("get_stock_news", error=RuntimeError("feed down"))
    erroring = Tool("sentiment", '{"status": "error", "message": "no data"}')
    compact = Tool("compact")
    reg = registry(market, failing, erroring, compact, Tool("bash"), Tool("write_file"),
                   Tool("trading_place_order"), Tool("unknown_tool"))
    assert d.restrict_and_tap(reg, "bull_advocate") == [
        "compact", "get_market_data", "get_stock_news", "sentiment"]
    assert reg._tools["get_market_data"].execute(symbol="NVDA", run_dir="/tmp/x") == {"close": [1, 2]}
    with pytest.raises(RuntimeError, match="feed down"):
        reg._tools["get_stock_news"].execute(symbol="NVDA")
    reg._tools["sentiment"].execute()
    assert reg._tools["compact"].execute == compact.execute  # not tapped: no output to report
    events = lines(capsys)
    assert [(event["kind"], event["title"]) for event in events] == [
        ("tool_call", "get_market_data"), ("tool_result", "get_market_data: 17 characters"),
        ("tool_call", "get_stock_news"), ("tool_result", "get_stock_news failed"),
        ("tool_call", "sentiment"), ("tool_result", "sentiment: 41 characters"),
        ("flag", "tool_error")]
    assert {event["agent"] for event in events} == {"bull_advocate"}
    assert json.loads(events[0]["body"]) == {"symbol": "NVDA"}  # run_dir is not shown
    assert events[3]["body"] == "feed down" and isinstance(events[3]["durationMs"], int)
    monkeypatch.setattr(d, "is_denied", lambda name: True)
    with pytest.raises(PermissionError, match="not allowed"):
        reg._tools["get_market_data"].execute(symbol="NVDA")


# Event shaping ------------------------------------------------------------------------------------

def test_emit_leaves_out_empty_fields_and_previews_the_body(capsys):
    d.emit("risk_officer", "message", "t" * 400, body="b" * 5000, model="", toolName=None,
           inputTokens=0, durationMs=12)
    d.emit("vibe", "tool_call", "get_market_data", body={"symbol": "NVDA", "note": "naïve"})
    d.emit("vibe", "status", "started", body="")
    first, second, third = lines(capsys)
    assert first == {"type": "event", "agent": "risk_officer", "kind": "message", "title": "t" * 300,
                     "body": "b" * d.PREVIEW_CHARS, "inputTokens": 0, "durationMs": 12}
    assert second["body"] == '{"symbol": "NVDA", "note": "naïve"}'
    assert "body" not in third
    assert d.preview(None) is None and d.preview("") is None


def test_llm_usage_reads_tokens_and_the_served_model():
    message = types.SimpleNamespace(usage_metadata={"input_tokens": 1200, "output_tokens": 300},
                                    response_metadata={"model_name": "qwen3-30b-a3b"})
    response = types.SimpleNamespace(generations=[[types.SimpleNamespace(message=message)]])
    assert d.llm_usage(response) == (1200, 300, "qwen3-30b-a3b")
    bare = types.SimpleNamespace(generations=[[types.SimpleNamespace(message=object())]])
    assert d.llm_usage(bare) == (0, 0, None)
    assert d.llm_usage(types.SimpleNamespace(generations=[])) == (0, 0, None)


# Environment --------------------------------------------------------------------------------------

SECRETS = {"OPENAI_API_KEY": "sk-o", "DEEPSEEK_API_KEY": "sk-d", "ANTHROPIC_API_KEY": "sk-a",
           "OPENROUTER_API_KEY": "sk-r", "LANGSMITH_API_KEY": "ls", "LANGSMITH_TRACING": "true",
           "LANGCHAIN_TRACING_V2": "true", "LANGCHAIN_API_KEY": "lc", "LANGCHAIN_PROJECT": "p",
           "PATH": "/bin"}


def test_hosted_provider_keeps_only_its_own_key(tmp_path):
    env = dict(SECRETS)
    d.prepare_environment(args(provider="deepseek", model="deepseek-chat"), env, tmp_path)
    assert env["DEEPSEEK_API_KEY"] == "sk-d" and env["LANGCHAIN_PROVIDER"] == "deepseek"
    for gone in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LANGSMITH_API_KEY",
                 "LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_API_KEY", "LANGCHAIN_PROJECT"):
        assert gone not in env
    assert env["HOME"] == env["VIBE_TRADING_HOME"] == env["USERPROFILE"] == str(tmp_path)
    assert env["LANGCHAIN_MODEL_NAME"] == "deepseek-chat" and env["LANGCHAIN_MAX_TOKENS"] == "8192"
    assert env["VIBE_TRADING_CONTEXT_WINDOW"] == "1000000"


def test_a_named_key_is_passed_under_the_name_vibe_trading_reads(tmp_path):
    env = {"VERTEX_OPENAI_KEY": "sk-named", "OPENAI_API_KEY": "sk-other"}
    d.prepare_environment(args(provider="openai", api_key_env="VERTEX_OPENAI_KEY"), env, tmp_path)
    assert env["OPENAI_API_KEY"] == "sk-named" and "VERTEX_OPENAI_KEY" not in env
    with pytest.raises(SystemExit, match="VERTEX_OPENAI_KEY is not set"):
        d.prepare_environment(args(provider="openai", api_key_env="VERTEX_OPENAI_KEY"), {}, tmp_path)
    with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY is not set"):
        d.prepare_environment(args(provider="anthropic"), {}, tmp_path)
    with pytest.raises(SystemExit, match="not wired"):
        d.prepare_environment(args(provider="mistral"), {}, tmp_path)


def test_a_local_server_gets_a_placeholder_key_and_one_worker(tmp_path):
    env = dict(SECRETS)
    url = "http://127.0.0.1:8080/v1"
    d.prepare_environment(args(provider="llamacpp", base_url=url), env, tmp_path,
                          probe=lambda base: 32768 if base == url else None)
    assert env["OPENAI_API_KEY"] == "sk-local" and env["OPENAI_BASE_URL"] == url
    assert not {"DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"} & set(env)
    assert (env["LANGCHAIN_PROVIDER"], env["SWARM_MAX_WORKERS"], env["LANGCHAIN_MAX_TOKENS"]) == (
        "openai", "1", "4096")
    assert env["VIBE_TRADING_CONTEXT_WINDOW"] == "32768"
    quiet: dict[str, str] = {"LOCAL_KEY": "k"}
    d.prepare_environment(args(base_url=url, api_key_env="LOCAL_KEY"), quiet, tmp_path,
                          probe=lambda _base: None)
    assert quiet["OPENAI_API_KEY"] == "k" and "LOCAL_KEY" not in quiet
    assert "VIBE_TRADING_CONTEXT_WINDOW" not in quiet


def test_describe_mode_drops_every_model_key(tmp_path):
    env = dict(SECRETS)
    d.prepare_environment(args(), env, tmp_path)
    assert not [name for name in env if name.endswith("_API_KEY")]


def test_setup_refuses_a_clone_with_an_env_file_and_enters_the_run_folder(tmp_path, monkeypatch):
    clone, run_dir = tmp_path / "vt", tmp_path / "run"
    (clone / "agent").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(d.os, "environ", {"OPENAI_API_KEY": "sk-o"})
    monkeypatch.setattr(sys, "path", list(sys.path))
    assert d.setup_env(args(vt_dir=str(clone), run_dir=str(run_dir))) == clone.resolve()
    assert Path.cwd() == run_dir.resolve() and sys.path[0] == str(clone.resolve() / "agent")
    assert d.os.environ["HOME"] == str(run_dir.resolve() / "vt_home")
    assert "OPENAI_API_KEY" not in d.os.environ
    (clone / "agent" / ".env").write_text("BROKER_KEY=x\n", encoding="utf-8")
    with pytest.raises(SystemExit, match=r"agent/\.env"):
        d.setup_env(args(vt_dir=str(clone), run_dir=str(run_dir)))


def test_local_context_window_reads_llama_cpp_props():
    class Props(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            body = json.dumps({"default_generation_settings": {"n_ctx": 65536}}).encode()
            self.send_response(200 if self.path == "/props" else 404)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: Any) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Props)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_address[1]
        assert d.local_context_window(f"http://127.0.0.1:{port}/v1") == 65536
    finally:
        server.shutdown()
    assert d.local_context_window(f"http://127.0.0.1:{port}/v1") is None


def test_vt_version_without_a_package_or_a_clone(tmp_path):
    assert d.vt_version(tmp_path) == ("unknown", "")


def test_vt_version_runs_git_without_the_provider_key(tmp_path, monkeypatch):
    seen: dict[str, Any] = {}

    def run(argv: list[str], **named: Any) -> Any:
        seen.update(named)
        return types.SimpleNamespace(stdout="66eb576\n")

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret")
    assert d.vt_version(tmp_path) == ("unknown", "66eb576")
    assert set(seen["env"]) == {"PATH", "LC_ALL"}


# Committee members ---------------------------------------------------------------------------------

def spec(agent_id: str, **fields: Any) -> Any:
    base: dict[str, Any] = {"system_prompt": "Preset prompt.", "max_iterations": None,
                            "timeout_seconds": 600}
    return types.SimpleNamespace(id=agent_id, **{**base, **fields})


def test_committee_members_get_read_only_tools_and_the_pm_closing_block():
    pm = spec("portfolio_manager", tools=["bash", "read_file", "write_file", "load_skill", "backtest"])
    bull = spec("bull_advocate", tools=["bash", "get_market_data", "factor_analysis",
                                        "technical_indicators", "get_stock_news"])
    d.adapt_agent_spec(pm, 25, local=False)
    d.adapt_agent_spec(bull, 25, local=False)
    assert pm.tools == ["load_skill", "quantlib_call", "technical_indicators"]
    assert bull.tools == ["get_market_data", "technical_indicators", "get_stock_news", "quantlib_call"]
    assert pm.system_prompt == "Preset prompt." + d.NO_SHELL_NOTE + d.PM_NOTE
    assert bull.system_prompt == "Preset prompt." + d.NO_SHELL_NOTE
    assert '"rating": one of "Buy", "Overweight", "Hold", "Underweight", "Sell"' in d.PM_NOTE
    assert "```json" in d.PM_NOTE and "no bash" in d.NO_SHELL_NOTE
    assert (pm.max_iterations, pm.timeout_seconds) == (25, 600)
    local = spec("risk_officer", tools=["options_payoff"], max_iterations=40)
    d.adapt_agent_spec(local, 25, local=True)
    assert (local.max_iterations, local.timeout_seconds) == (10, 3600)


def test_single_agent_prompt_asks_for_the_closing_block():
    prompt = d.PROMPT.format(ticker="NVDA", date="2026-10-28")
    assert prompt.startswith("Analyse NVDA, a US listed stock, as of 2026-10-28.")
    assert prompt.endswith(d.DECISION_BLOCK)


# Describe -----------------------------------------------------------------------------------------

def test_describe_reports_the_raw_registry_and_the_policy(capsys, monkeypatch, tmp_path):
    names = ["bash", "get_market_data", "quantlib_call", "trading_place_order", "write_file",
             "web_search", "alpha_zoo"]
    tools_module = types.ModuleType("src.tools")
    tools_module.build_registry = lambda **_: registry(*(Tool(name) for name in names))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "src", types.ModuleType("src"))
    monkeypatch.setitem(sys.modules, "src.tools", tools_module)
    monkeypatch.setattr(d, "setup_env", lambda _args: tmp_path)
    monkeypatch.setattr(d, "vt_version", lambda _dir: ("0.1.18", "66eb576"))
    assert d.describe(args(describe=True)) == 0
    (line,) = lines(capsys)
    assert line["type"] == "describe" and (line["package"], line["commit"]) == ("0.1.18", "66eb576")
    # Unfiltered: the adapter applies its own copy of the policy to these names.
    assert line["tools"] == sorted(names)
    assert line["allowlist"] == list(d.TOOL_ALLOWLIST)
    assert line["denylist"] == list(d.TOOL_DENYLIST)
    assert line["denied_prefixes"] == ["trading_", "etoro_", "swarm", "schedule"]


def test_parse_args_defaults():
    parsed = d.parse_args(["--vt-dir", "/opt/vt"])
    assert (parsed.mode, parsed.max_iter, parsed.timeout, parsed.describe) == (
        "committee", 25, None, False)


# Real Vibe-Trading --------------------------------------------------------------------------------

@pytest.mark.skipif(not os.environ.get("VERTEX_VT_DIR"),
                    reason="needs a Vibe-Trading clone (scripts/vibe-trading-setup.sh, VERTEX_VT_DIR)")
def test_real_driver_describes_a_read_only_tool_set(tmp_path):
    vt_dir = Path(os.environ["VERTEX_VT_DIR"]).expanduser()
    completed = subprocess.run(
        [str(vt_dir / ".venv" / "bin" / "python"), str(DRIVER), "--describe", "--vt-dir", str(vt_dir),
         "--run-dir", str(tmp_path)],
        capture_output=True, text=True, timeout=180, check=False,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONUTF8": "1"},
    )
    line = json.loads(completed.stdout.splitlines()[-1])
    assert line["type"] == "describe", completed.stderr[-2000:]
    allowed = [name for name in line["tools"] if name in d.TOOL_ALLOWLIST]
    assert allowed and not [name for name in allowed if d.is_denied(name)]
    assert "bash" not in line["tools"]  # shell tools stay out of the registry


# Setup script (only the checks that run before any download) ------------------------------------

SETUP = DRIVER.parents[3] / "scripts" / "vibe-trading-setup.sh"
UPSTREAM = "https://github.com/HKUDS/Vibe-Trading.git"


def clone(tmp_path: Path, origin: str = UPSTREAM) -> Path:
    target = tmp_path / "vibe-trading"
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test"}
    for argv in (["init", "-q", str(target)],
                 ["-C", str(target), "remote", "add", "origin", origin]):
        subprocess.run(["git", *argv], check=True, env=env)
    (target / ".gitignore").write_text(".venv/\nagent/.env\n", encoding="utf-8")
    (target / "agent").mkdir()
    (target / "agent" / "main.py").write_text("print('upstream')\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(target), "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", str(target), "commit", "-qm", "upstream"], check=True, env=env)
    return target


def setup(target: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SETUP), str(target)], capture_output=True, text=True,
                          timeout=60, check=False,
                          env={"PATH": os.environ.get("PATH", ""), "HOME": str(target.parent),
                               "VT_PYTHON": sys.executable})


def test_setup_refuses_a_clone_with_local_changes_before_any_download(tmp_path):
    target = clone(tmp_path)
    (target / "agent" / "main.py").write_text("print('changed')\n", encoding="utf-8")
    changed = setup(target)
    assert changed.returncode == 1 and "has local changes or untracked files" in changed.stderr
    subprocess.run(["git", "-C", str(target), "checkout", "-q", "--", "."], check=True)
    (target / "agent" / "extra.py").write_text("print('injected')\n", encoding="utf-8")
    untracked = setup(target)
    assert untracked.returncode == 1 and "has local changes or untracked files" in untracked.stderr


def test_setup_refuses_another_origin_an_env_file_and_a_plain_folder(tmp_path):
    other = setup(clone(tmp_path / "a", origin="https://example.test/fork.git"))
    assert other.returncode == 1 and f"expected {UPSTREAM}" in other.stderr
    target = clone(tmp_path / "b")
    (target / "agent" / ".env").write_text("BROKER_KEY=x\n", encoding="utf-8")
    env_file = setup(target)
    assert env_file.returncode == 1 and "agent/.env exists" in env_file.stderr
    plain = tmp_path / "plain"
    plain.mkdir()
    assert "is not a git clone" in setup(plain).stderr
