"""Vibe-Trading adapter with a fake driver (no Vibe-Trading install, no model, no network)."""
from __future__ import annotations

import importlib.util
import io
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest

import adapters.vibe_trading_framework as vt
from adapters.vibe_trading_framework import (
    FrameworkSetupError, VibeTradingFramework, check_granted, child_environment, outside_policy,
    parse_decision,
)
from agents.framework_bench import FRAMEWORK_FACTORIES, FRAMEWORK_PROVIDERS, PlanError
from agents.framework_bench import main as bench_main
from agents.framework_types import FrameworkEvent, FrameworkRunRequest, ModelEndpoint

FAKE = Path(__file__).parent / "fixtures" / "fake_vt_driver.py"
TODAY = date(2026, 11, 1)


class Sink:
    def __init__(self) -> None:
        self.events: list[FrameworkEvent] = []

    def emit(self, event: FrameworkEvent) -> None:
        self.events.append(event)


class Cancel:
    def __init__(self, after: int | None = None) -> None:
        self.after, self.calls = after, 0

    def cancelled(self) -> bool:
        self.calls += 1
        return self.after is not None and self.calls > self.after


def framework(tmp_path: Path, scenario: str = "good", **kwargs: Any) -> VibeTradingFramework:
    vt_dir = tmp_path / scenario
    vt_dir.mkdir(exist_ok=True)
    environ = {"PATH": os.environ.get("PATH", ""), "OPENAI_API_KEY": "sk-openai-secret",
               "DEEPSEEK_API_KEY": "sk-deepseek-secret", "VERTEX_AGENT_API_KEY": "vx-secret",
               "LANGSMITH_API_KEY": "ls-secret", "LC_ALL": "C.UTF-8", **kwargs.pop("environ", {})}
    return VibeTradingFramework(vt_dir, python=Path(sys.executable), driver=FAKE, environ=environ,
                                today=lambda: TODAY, **kwargs)


def request(model: str, *, day: date = TODAY, timeout_s: float = 60.0,
            base_url: str | None = None) -> FrameworkRunRequest:
    return FrameworkRunRequest(
        ticker="AAPL", decision_date=day, timeout_s=timeout_s,
        endpoint=ModelEndpoint(provider="openai", model=model, base_url=base_url,
                               api_key_env=None if base_url else "OPENAI_API_KEY"))


# Parse rules --------------------------------------------------------------------------------------

def test_parse_reads_the_last_block_and_nulls_omitted_values():
    decision = parse_decision(
        'x ```json\n{"rating": "Sell"}\n``` then ```json\n{"rating": " overweight ", '
        '"entry": "1,234.5", "stop": (omitted※), "target": "（略※）", "horizon": " 2 weeks "}\n```')
    assert decision.rating == "overweight" and decision.rating_source == "stated"
    assert (decision.entry, decision.stop, decision.target) == (1234.5, None, None)
    assert decision.horizon == "2 weeks" and decision.numbers_withheld == 2
    bare = parse_decision('```json\n{"rating": "buy", "target": （略※）}\n```')
    assert (bare.rating, bare.target, bare.numbers_withheld) == ("buy", None, 1)


@pytest.mark.parametrize("action, rating", [
    ("long", "overweight"), ("SHORT", "underweight"), ("wait", "hold"), (" hedge ", "hold")])
def test_parse_maps_the_action_when_the_rating_is_not_a_tier(action, rating):
    decision = parse_decision('```json\n{"rating": "strong buy", "action": "%s"}\n```' % action)
    assert (decision.rating, decision.rating_source) == (rating, "mapped")


def test_parse_without_a_rating_or_action_is_missing_never_hold():
    for content in ("", "no block", '```json\n{"action": "think"}\n```', "```json\n{bad}\n```"):
        decision = parse_decision(content)
        assert (decision.rating, decision.rating_source) == (None, "missing")
    odd = parse_decision('```\n{"rating": "hold", "entry": true, "stop": "n/a", "target": 0, '
                         '"horizon": "' + "y" * 80 + '"}\n```')
    assert (odd.entry, odd.stop, odd.target) == (None, None, None)
    assert odd.horizon == "y" * 64
    assert parse_decision('```json\n{"rating": "hold", "entry": 2e12, "horizon": "  "}\n```').entry is None
    assert parse_decision('```json\n{"rating": "hold", "horizon": "  "}\n```').horizon is None


# Environment and tools ----------------------------------------------------------------------------

def test_child_environment_keeps_only_basics_and_the_named_key():
    environ = {"PATH": "/bin", "LC_ALL": "C", "HOME": "/home/x", "OPENAI_API_KEY": "a",
               "DEEPSEEK_API_KEY": "b", "VERTEX_AGENT_API_KEY": "c", "LANGSMITH_API_KEY": "d"}
    assert child_environment(environ, "DEEPSEEK_API_KEY") == {
        "PATH": "/bin", "LC_ALL": "C", "DEEPSEEK_API_KEY": "b", "PYTHONUTF8": "1"}
    assert child_environment(environ, None) == {"PATH": "/bin", "LC_ALL": "C", "PYTHONUTF8": "1"}
    assert "MISSING" not in child_environment(environ, "MISSING")


def test_the_policy_check_refuses_anything_outside_the_read_only_list():
    check_granted("bull_advocate", ["get_market_data", "quantlib_call"])
    check_granted("portfolio_manager", [])
    for bad in (["bash"], ["trading_place_order"], ["get_market_data", "unknown_tool"], [3], None):
        with pytest.raises(FrameworkSetupError):
            check_granted("bull_advocate", bad)
    assert outside_policy(["swarm_run", "get_market_data", "etoro_buy"]) == ["etoro_buy", "swarm_run"]
    assert not vt.ALLOWED_TOOLS & vt.DENIED_TOOLS
    assert not [name for name in vt.ALLOWED_TOOLS if name.startswith(vt.DENIED_PREFIXES)]


def test_describe_filters_the_raw_registry_itself_and_refuses_an_edited_driver(tmp_path, monkeypatch):
    info = framework(tmp_path).describe()
    assert info.name == "vibe_trading"
    assert info.version == "vibe-trading-ai 0.1.18+66eb576"
    assert info.tools_allowed == ("get_market_data", "quantlib_call", "options_payoff",
                                  "get_stock_news")
    assert info.tools_excluded == ("backtest", "bash", "trading_place_order")
    with pytest.raises(FrameworkSetupError, match="driver allowlist tools outside the read-only"):
        framework(tmp_path, "leaky").describe()
    with pytest.raises(FrameworkSetupError, match="no tool on the read-only list"):
        framework(tmp_path, "empty").describe()
    with pytest.raises(FrameworkSetupError, match="reports no tool list"):
        framework(tmp_path, "notools").describe()
    with pytest.raises(FrameworkSetupError, match="not JSON"):
        framework(tmp_path, "badjson").describe()
    with pytest.raises(FrameworkSetupError, match="No module named"):
        framework(tmp_path, "broken").describe()
    monkeypatch.setattr(vt, "DESCRIBE_TIMEOUT_S", 0.5)
    with pytest.raises(FrameworkSetupError, match="in time"):
        framework(tmp_path, "hang").describe()
    missing = VibeTradingFramework(tmp_path / "absent")
    with pytest.raises(FrameworkSetupError, match="not installed"):
        missing.describe()
    assert missing.python == tmp_path / "absent" / ".venv" / "bin" / "python"


def test_from_env_needs_the_clone_and_accepts_a_driver_override(tmp_path):
    with pytest.raises(FrameworkSetupError, match="VERTEX_VT_DIR"):
        VibeTradingFramework.from_env({})
    made = VibeTradingFramework.from_env({"VERTEX_VT_DIR": str(tmp_path),
                                          "VERTEX_VT_DRIVER": str(FAKE)}, mode="single")
    assert made.driver == FAKE and made.mode == "single" and made.vt_dir == tmp_path
    assert VibeTradingFramework.from_env({"VERTEX_VT_DIR": str(tmp_path)}).driver == vt.DEFAULT_DRIVER
    assert vt.DEFAULT_DRIVER.parts[-3:] == ("vibe-trading", "driver", "vt_driver.py")
    assert VibeTradingFramework.from_env({"VERTEX_VT_DIR": str(tmp_path)}).mode == "committee"
    assert VibeTradingFramework.from_env({"VERTEX_VT_DIR": str(tmp_path),
                                          "VERTEX_VT_MODE": "single"}).mode == "single"
    with pytest.raises(ValueError):
        VibeTradingFramework(tmp_path, mode="swarm")


# Runs ---------------------------------------------------------------------------------------------

def test_run_maps_events_usage_and_the_stated_rating(tmp_path):
    sink = Sink()
    result = framework(tmp_path).run(request("stated"), sink, Cancel())
    assert result.error is None
    assert (result.rating, result.rating_source) == ("overweight", "stated")
    assert (result.entry_price, result.stop_price, result.target_price) == (190.5, None, 212.0)
    assert result.horizon == "3 months"
    assert result.flags == ("iteration_limit", "numbers_withheld")
    usage = result.usage
    assert (usage.input_tokens, usage.output_tokens, usage.llm_calls, usage.tool_calls) == (2000, 400, 2, 1)
    assert usage.cost_usd is None and usage.duration_ms is not None
    assert [served.served for served in result.models_served] == ["served-a"]
    grants = [(event.agent, event.title, event.body) for event in sink.events
              if event.title.startswith("Tools: ")]
    assert grants == [
        ("bull_advocate", "Tools: 4", "get_market_data, quantlib_call, options_payoff, get_stock_news"),
        ("portfolio_manager", "Tools: 0", None),
        ("bull_advocate", "Tools: 2", "get_market_data, quantlib_call")]
    events = [event for event in sink.events if not event.title.startswith("Tools: ")]
    kinds = [(event.agent, event.kind) for event in events]
    assert kinds == [("bull_advocate", "status"), ("bull_advocate", "llm_call"),
                     ("bull_advocate", "llm_call"), ("bear_advocate", "tool_call"),
                     ("bear_advocate", "tool_result"), ("risk_officer", "flag"),
                     ("vibe", "message"), ("decision", "decision")]
    llm = events[1]
    assert (llm.model, llm.input_tokens, llm.output_tokens, llm.duration_ms) == ("stated", 1200, 300, 900)
    assert events[2].duration_ms is None
    assert events[3].body == '{"symbol": "AAPL"}' and events[3].tool_name == "get_market_data"
    assert len(events[4].body or "") == 2000
    assert events[5].title == "iteration_limit"
    assert '"rating": "overweight"' in (sink.events[-1].body or "")


def test_run_flags_past_dates_mapped_and_missing_ratings(tmp_path):
    sink = Sink()
    mapped = framework(tmp_path).run(request("mapped", day=date(2026, 9, 4)), sink, Cancel())
    assert (mapped.rating, mapped.rating_source) == ("underweight", "mapped")
    assert mapped.flags[0] == "not_point_in_time" and sink.events[0].title == "not_point_in_time"
    assert (mapped.entry_price, mapped.stop_price, mapped.target_price, mapped.horizon) == (
        None, None, None, None)
    # The swarm's totals (5000/900) exceed what the tap saw (2000/400): the larger count wins.
    assert (mapped.usage.input_tokens, mapped.usage.output_tokens, mapped.usage.llm_calls) == (
        5000, 900, 2)
    unrated = framework(tmp_path).run(request("none"), Sink(), Cancel())
    assert unrated.error is None and unrated.rating is None
    assert unrated.rating_source == "missing" and "no_rating" in unrated.flags


def test_run_failures_are_errors_never_hold(tmp_path):
    for model, message in (("failed-status", "status 'failed'"), ("crash", "swarm stopped"),
                           ("exit", "exited with code 3")):
        result = framework(tmp_path).run(request(model), Sink(), Cancel())
        assert result.rating is None and message in (result.error or "")


def test_run_times_out_and_cancels_the_driver(tmp_path):
    timed_out = framework(tmp_path).run(request("slow", timeout_s=0.5), Sink(), Cancel())
    assert "did not finish within 0.5 s" in (timed_out.error or "")
    assert "worker_timeout" in timed_out.flags
    cancelled = framework(tmp_path).run(request("slow"), Sink(), Cancel(after=3))
    assert cancelled.error == "cancelled by the operator"


def test_run_passes_only_the_endpoint_key_to_the_driver(tmp_path):
    sink = Sink()
    hosted = framework(tmp_path, mode="single").run(request("env"), sink, Cancel())
    names = (next(e for e in sink.events if e.title == "environment").body or "").split(",")
    assert "OPENAI_API_KEY" in names and "PYTHONUTF8" in names
    for secret in ("DEEPSEEK_API_KEY", "VERTEX_AGENT_API_KEY", "LANGSMITH_API_KEY", "HOME"):
        assert secret not in names
    assert hosted.rating == "hold"
    local_sink = Sink()
    framework(tmp_path).run(request("env", base_url="http://127.0.0.1:8080/v1"), local_sink, Cancel())
    local_names = (next(e for e in local_sink.events if e.title == "environment").body
                   or "").split(",")
    assert "OPENAI_API_KEY" not in local_names
    decision = local_sink.events[-1]
    assert decision.kind == "decision"


def test_run_sends_the_request_to_the_driver(tmp_path, monkeypatch):
    seen: list[list[str]] = []
    original = vt.subprocess.Popen

    def spy(argv, **kwargs):
        seen.append(list(argv))
        return original(argv, **kwargs)

    monkeypatch.setattr(vt.subprocess, "Popen", spy)
    framework(tmp_path, max_iterations=7).run(
        request("env", base_url="http://127.0.0.1:8080/v1", timeout_s=90), Sink(), Cancel())
    argv = next(args for args in seen if "--ticker" in args)
    for flag, value in (("--ticker", "AAPL"), ("--date", "2026-11-01"), ("--model", "env"),
                        ("--provider", "openai"), ("--mode", "committee"), ("--max-iter", "7"),
                        ("--timeout", "90"), ("--base-url", "http://127.0.0.1:8080/v1")):
        assert argv[argv.index(flag) + 1] == value
    assert "--api-key-env" not in argv


def test_the_bench_registers_vibe_trading(tmp_path):
    factory = FRAMEWORK_FACTORIES["vibe_trading"]
    with pytest.raises(PlanError, match="VERTEX_VT_DIR"):
        factory({})
    made = factory({"VERTEX_VT_DIR": str(tmp_path)})
    assert isinstance(made, VibeTradingFramework) and made.vt_dir == tmp_path
    out = io.StringIO()
    argv = ["--batch", "vt-1", "--tickers", "AAPL", "--dates", "2026-10-30",
            "--arm", "vibe_trading:llamacpp:qwen3:http://127.0.0.1:8080/v1", "--budget-usd", "1"]
    assert bench_main([*argv, "--dry-run"], environ={}, out=out) == 0
    assert "not available here" not in out.getvalue()
    out = io.StringIO()
    assert bench_main(argv, environ={}, out=out) == 2
    assert "set VERTEX_VT_DIR" in out.getvalue()


@pytest.mark.skipif(not os.environ.get("VERTEX_VT_DIR"),
                    reason="needs a Vibe-Trading clone (scripts/vibe-trading-setup.sh, VERTEX_VT_DIR)")
def test_real_driver_describes_a_read_only_tool_set():  # pragma: no cover - needs the clone
    info = VibeTradingFramework.from_env(os.environ).describe()
    assert info.version.startswith("vibe-trading-ai ")
    assert set(info.tools_allowed) <= vt.ALLOWED_TOOLS


def test_the_adapter_and_the_driver_share_one_tool_policy():
    spec = importlib.util.spec_from_file_location("vt_driver_policy", vt.DEFAULT_DRIVER)
    assert spec is not None and spec.loader is not None
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)  # stdlib only at import: no Vibe-Trading needed
    assert set(driver.TOOL_ALLOWLIST) == vt.ALLOWED_TOOLS
    assert set(driver.TOOL_DENYLIST) == vt.DENIED_TOOLS
    assert driver.DENIED_PREFIXES == vt.DENIED_PREFIXES
    assert driver.PREVIEW_CHARS == vt.BODY_PREVIEW


def test_a_grant_outside_the_read_only_list_stops_the_run(tmp_path):
    sink = Sink()
    result = framework(tmp_path).run(request("grant-leak", timeout_s=20), sink, Cancel())
    assert result.rating is None and "tool_policy" in result.flags
    assert "grants risk_officer tools outside the read-only list: ['bash']" in (result.error or "")


def test_the_bench_knows_the_providers_the_driver_wires():
    spec = importlib.util.spec_from_file_location("vt_driver_providers", vt.DEFAULT_DRIVER)
    assert spec is not None and spec.loader is not None
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    assert set(driver.HOSTED_PROVIDERS) == vt.HOSTED_PROVIDERS == FRAMEWORK_PROVIDERS["vibe_trading"]
    out = io.StringIO()
    assert bench_main(["--batch", "vt-1", "--tickers", "AAPL", "--dates", "2026-10-30",
                       "--arm", "vibe_trading:google:gemini-2.5-flash", "--budget-usd", "1",
                       "--dry-run"], environ={}, out=out) == 2
    assert "vibe_trading supports the hosted providers" in out.getvalue()
