"""Framework benchmark: plan, budget, reuse, retry and recording with fakes (no network, no model)."""
from __future__ import annotations

import io
import json
import threading
from datetime import date
from typing import Any, Callable, Mapping, Sequence

import pytest
from pydantic import ValidationError

from adapters.model_pricing import PriceBook, TokenPrice, parse_price
from agents.framework_bench import (
    EVENTS_MAX, FRAMEWORK_PROVIDERS, Arm, BenchConfig, BudgetLedger, FrameworkBench, PlanError,
    RecordingSink, Task, check_providers,
    load_calendar, main, parse_arm, parse_dates, plan_tasks, run_key, weekly_dates,
)
from agents.framework_types import (
    FrameworkEvent, FrameworkInfo, FrameworkRunRequest, FrameworkRunResult, FrameworkUsage,
    ModelEndpoint, ModelServed, is_local_base_url,
)

HOSTED = "fake:openai:gpt-4o-mini"
LOCAL = "fake:llamacpp:qwen3:30b:http://127.0.0.1:8080/v1"


class FakeRecorder:
    """In-memory agentModelRuns: record is idempotent by runKey and keeps the first run."""

    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.events: dict[str, list[list[Mapping[str, Any]]]] = {}
        self.fail_events = False
        self.count_calls = 0
        self.updates: list[tuple[str, dict[str, Any]]] = []
        self.update_failure: Callable[[str, Mapping[str, Any]], Any] | None = None
        self.lock = threading.Lock()

    def record(self, fields: Mapping[str, Any]) -> Mapping[str, Any]:
        with self.lock:
            key = fields["runKey"]
            if key not in self.runs:
                self.runs[key] = {**fields, "id": f"id-{len(self.runs)}"}
            return dict(self.runs[key])

    def by_id(self, run_id: str) -> dict[str, Any]:
        return next(run for run in self.runs.values() if run["id"] == run_id)

    def update(self, run_id: str, fields: Mapping[str, Any]) -> Mapping[str, Any]:
        with self.lock:
            self.updates.append((run_id, dict(fields)))
            failure = self.update_failure(run_id, fields) if self.update_failure else None
            if isinstance(failure, tuple):  # (error, store anyway): an answer lost after storing
                failure, store = failure
                if store:
                    self.by_id(run_id).update(fields)
            if failure is not None:
                raise failure
            run = self.by_id(run_id)
            run.update(fields)
            return dict(run)

    def append_events(self, run_id: str, events: Sequence[Mapping[str, Any]]) -> None:
        if self.fail_events:
            raise RuntimeError("storage down")
        self.events.setdefault(run_id, []).append(list(events))

    def count_finished(self, filters: Mapping[str, Any],
                       accept: Callable[[Mapping[str, Any]], bool] | None = None) -> int:
        """Server-side list filters, then the caller's check (as VertexRunRecorder does)."""
        def matches(run: Mapping[str, Any]) -> bool:
            return (run.get("status") == "succeeded" and run.get("batch") == filters["batch"]
                    and run["ticker"] in filters["ticker"]
                    and run["decisionDate"] == filters["decisionFrom"] == filters["decisionTo"]
                    and run["framework"] in filters["framework"]
                    and run["provider"] in filters["provider"] and run["model"] in filters["model"]
                    and ("variant" not in filters or run.get("variant") in filters["variant"])
                    and ("flags" not in filters
                         or bool(set(filters["flags"]) & set(run.get("flags") or []))))
        self.count_calls += 1
        return sum(1 for run in self.runs.values()
                   if matches(run) and (accept is None or accept(run)))


class FakeFramework:
    """Scripted framework: `script[(ticker, n)]` is a result or an exception for the nth call."""

    def __init__(self, script: Mapping[tuple[str, int], Any] | None = None, events: int = 3) -> None:
        self.script = dict(script or {})
        self.calls: list[FrameworkRunRequest] = []
        self.events = events
        self.lock = threading.Lock()

    def describe(self) -> FrameworkInfo:
        return FrameworkInfo(name="fake", version="1.0+abc1234", tools_allowed=("get_quote",),
                             tools_excluded=("bash",))

    def run(self, request: FrameworkRunRequest, sink: Any, cancellation: Any) -> FrameworkRunResult:
        with self.lock:
            index = sum(1 for call in self.calls if call.ticker == request.ticker
                        and call.endpoint == request.endpoint)
            self.calls.append(request)
        for seq in range(self.events):
            sink.emit(FrameworkEvent(agent="Analyst", kind="reasoning", title=f"step {seq}",
                                     body="x" * 20_000 if seq == 0 else None, model="m",
                                     input_tokens=10, output_tokens=2))
        outcome = self.script.get((request.ticker, index))
        if isinstance(outcome, Exception):
            raise outcome
        if outcome is not None:
            return outcome
        return FrameworkRunResult(
            rating="overweight", rating_source="stated", entry_price=100.0, horizon="2 weeks",
            usage=FrameworkUsage(input_tokens=1_000_000, output_tokens=100_000, llm_calls=5,
                                 tool_calls=7),
            models_served=(ModelServed(requested=request.endpoint.model, served="served-1"),),
            flags=("not_point_in_time",),
        )


class Cancel:
    def __init__(self, value: bool = False) -> None:
        self.value = value

    def cancelled(self) -> bool:
        return self.value


def bench(framework: Any, recorder: FakeRecorder, *, cap: float = 100.0, **config: Any):
    out = io.StringIO()
    clock = iter(range(0, 10_000, 2))
    runner = FrameworkBench({"fake": framework}, recorder, PriceBook(), BudgetLedger(cap),
                            BenchConfig(batch="grid-1", **config), clock=lambda: next(clock),
                            out=out)
    return runner, out


def tasks(arms: Sequence[str], tickers: Sequence[str] = ("AAPL",), reruns: int = 1) -> list[Task]:
    return plan_tasks([parse_arm(arm) for arm in arms], list(tickers), [date(2026, 9, 4)], reruns)


# Plan ---------------------------------------------------------------------------------------------

def test_parses_arms_with_colons_in_the_model_and_a_base_url():
    hosted = parse_arm(HOSTED)
    assert hosted.key == "fake:openai:gpt-4o-mini"
    assert hosted.endpoint.api_key_env == "OPENAI_API_KEY"
    assert not hosted.endpoint.local
    local = parse_arm(LOCAL)
    assert local.endpoint.model == "qwen3:30b"
    assert local.endpoint.base_url == "http://127.0.0.1:8080/v1"
    assert local.endpoint.api_key_env is None and local.endpoint.local
    remote = parse_arm("fake:ollama:llama3:https://models.example.com/v1/")
    assert remote.endpoint.base_url == "https://models.example.com/v1"
    assert not remote.endpoint.local
    assert parse_arm("fake:unknownco:m").endpoint.api_key_env is None
    for bad in ("fake:openai", "Fake:openai:m", "fake:Open AI:m", "fake::m",
                "fake:openai:m:http://user:pw@127.0.0.1/v1"):
        with pytest.raises(PlanError):
            parse_arm(bad)


def test_weekly_dates_take_the_last_trading_day_of_each_iso_week(tmp_path):
    assert weekly_dates("2026-08-31..2026-09-16") == [
        date(2026, 9, 4), date(2026, 9, 11), date(2026, 9, 16)]
    calendar = tmp_path / "days.txt"
    calendar.write_text("# NYSE\n2026-08-31\n2026-09-01\n2026-09-03\n\n2026-09-08  # after Labor Day\n")
    days = load_calendar(str(calendar))
    assert weekly_dates("2026-08-31..2026-09-13", days) == [date(2026, 9, 3), date(2026, 9, 8)]
    for bad in ("2026-09-10..2026-09-01", "2026-09-01", "x..y", "2020-01-01..2026-01-01"):
        with pytest.raises(PlanError):
            weekly_dates(bad)
    (tmp_path / "bad.txt").write_text("not a date\n")
    with pytest.raises(PlanError):
        load_calendar(str(tmp_path / "bad.txt"))


def test_dates_tasks_and_run_keys():
    assert parse_dates("2026-09-02, 2026-09-01,2026-09-02,") == [date(2026, 9, 1), date(2026, 9, 2)]
    with pytest.raises(PlanError):
        parse_dates("2026-13-01")
    planned = tasks([HOSTED, LOCAL], ("AAPL", "MSFT"), reruns=2)
    assert len(planned) == 8
    assert [(t.ticker, t.rerun, t.arm.endpoint.provider) for t in planned[:4]] == [
        ("AAPL", 0, "openai"), ("AAPL", 0, "llamacpp"), ("AAPL", 1, "openai"), ("AAPL", 1, "llamacpp")]
    assert run_key("grid-1", planned[0], None, 0) == "grid-1:fake:openai:gpt-4o-mini:AAPL:2026-09-04:r0"
    local_key = run_key("grid-1", planned[1], "no-memory", 1)
    assert local_key.startswith("grid-1:fake:llamacpp:qwen3:30b:u")
    assert local_key.endswith(":no-memory:AAPL:2026-09-04:r0:retry1")
    long_arm = Arm("fake", ModelEndpoint(provider="openai", model="m/" + "x" * 190))
    key = run_key("grid-1", Task(long_arm, "AAPL", date(2026, 9, 4), 0), None, 0)
    assert len(key) == 128 and "/" not in key


def test_budget_ledger_counts_spent_and_in_flight_estimates():
    ledger = BudgetLedger(1.0)
    assert ledger.reserve(0.4) and ledger.reserve(0.4)
    assert not ledger.reserve(0.4)
    ledger.settle(0.4, 0.1)
    assert ledger.reserve(0.4)
    ledger.settle(0.4, None)
    assert ledger.spent == pytest.approx(0.5) and ledger.in_flight == pytest.approx(0.4)
    with pytest.raises(PlanError):
        BudgetLedger(0)


# Runs ---------------------------------------------------------------------------------------------

def test_records_each_run_with_usage_cost_flags_and_batched_events():
    recorder = FakeRecorder()
    framework = FakeFramework(events=250)
    runner, out = bench(framework, recorder, analysts=("market",), data_source="yfinance")
    summary = runner.run(tasks([HOSTED, LOCAL]), Cancel())
    assert summary.as_dict() == {
        "planned": 2, "reused": 0, "succeeded": 2, "failed": 0, "retried": 0, "busy": 0,
        "skippedBudget": 0, "cancelled": 0, "spentUsd": 0.21}
    hosted = recorder.runs["grid-1:fake:openai:gpt-4o-mini:AAPL:2026-09-04:r0"]
    assert hosted["status"] == "succeeded" and hosted["purpose"] == "benchmark"
    assert hosted["frameworkVersion"] == "1.0+abc1234" and hosted["memory"] is False
    assert hosted["analysts"] == ["market"] and hosted["dataSource"] == "yfinance"
    # 1M input at 0.15 and 100k output at 0.60 per 1M tokens.
    assert hosted["costUsd"] == pytest.approx(0.21)
    assert hosted["flags"] == ["memory_off", "not_point_in_time"]
    assert hosted["rating"] == "overweight" and hosted["ratingSource"] == "stated"
    assert hosted["modelsServed"] == [{"requested": "gpt-4o-mini", "served": "served-1"}]
    assert hosted["durationMs"] == 2000
    local = next(run for run in recorder.runs.values() if run["provider"] == "llamacpp")
    assert local["costUsd"] == 0 and "local_model" in local["flags"]
    batches = recorder.events[hosted["id"]]
    assert [len(batch) for batch in batches] == [200, 50]
    assert [row["seq"] for batch in batches for row in batch] == list(range(250))
    assert len(batches[0][0]["body"]) == 16_000 and "body" not in batches[0][1]
    assert "succeeded: fake:openai:gpt-4o-mini AAPL 2026-09-04 rerun 0 rating overweight" in out.getvalue()
    assert framework.calls[0].memory is False and framework.calls[0].timeout_s == 1800.0


def test_reuses_finished_identical_runs_and_skips_busy_ones():
    recorder = FakeRecorder()
    framework = FakeFramework()
    runner, _ = bench(framework, recorder, variant="no-memory")
    planned = tasks([HOSTED], ("AAPL", "MSFT"), reruns=2)
    # A finished AAPL run under another key covers rerun 0; MSFT r0 is running elsewhere.
    recorder.runs["other"] = {
        "id": "x", "status": "succeeded", "batch": "grid-1", "ticker": "AAPL",
        "decisionDate": "2026-09-04", "framework": "fake", "provider": "openai",
        "model": "gpt-4o-mini", "variant": "no-memory"}
    recorder.record({"runKey": run_key("grid-1", planned[2], "no-memory", 0), "status": "running"})
    recorder.record({"runKey": run_key("grid-1", planned[1], "no-memory", 0),
                     "status": "succeeded"})
    summary = runner.run(planned, Cancel())
    assert summary.reused == 2 and summary.busy == 1 and summary.succeeded == 1
    assert [call.ticker for call in framework.calls] == ["MSFT"]
    assert framework.calls[0].variant == "no-memory"


def test_retries_a_failed_run_once_and_never_counts_it_as_hold():
    recorder = FakeRecorder()
    framework = FakeFramework({
        ("AAPL", 0): RuntimeError("provider timed out"),
        ("MSFT", 0): FrameworkRunResult(error="worker timeout", flags=("worker_timeout",)),
        ("MSFT", 1): FrameworkRunResult(error="worker timeout", flags=("worker_timeout",)),
    })
    runner, _ = bench(framework, recorder)
    summary = runner.run(tasks([HOSTED], ("AAPL", "MSFT")), Cancel())
    assert summary.succeeded == 1 and summary.failed == 1 and summary.retried == 2
    first = recorder.runs["grid-1:fake:openai:gpt-4o-mini:AAPL:2026-09-04:r0"]
    assert first["status"] == "failed" and first["rating"] is None
    assert first["ratingSource"] == "missing"
    assert first["error"] == "RuntimeError: provider timed out"
    assert "framework_error" in first["flags"] and "cost_unknown" not in first["flags"]
    retry = recorder.runs["grid-1:fake:openai:gpt-4o-mini:AAPL:2026-09-04:r0:retry1"]
    assert retry["status"] == "succeeded" and "retry" in retry["flags"]
    msft = [run for run in recorder.runs.values() if run["ticker"] == "MSFT"]
    assert [run["status"] for run in msft] == ["failed", "failed"]
    # A key that failed before moves straight to its retry key.
    again = FakeFramework()
    rerun, _ = bench(again, recorder)
    assert rerun.run(tasks([HOSTED], ("MSFT",)), Cancel()).failed == 1
    assert again.calls == []


def test_budget_is_a_hard_stop_and_unknown_prices_need_an_estimate():
    recorder = FakeRecorder()
    framework = FakeFramework()
    # The default estimate for gpt-4o-mini is 300k in + 30k out = 0.063 USD.
    runner, out = bench(framework, recorder, cap=0.13)
    summary = runner.run(tasks([HOSTED], ("AAPL", "MSFT", "NVDA")), Cancel())
    assert summary.succeeded == 1 and summary.skipped_budget == 2
    assert "budget: stop before 2 runs" in out.getvalue()
    unknown = "fake:openai:gpt-9"
    with pytest.raises(PlanError, match="no price"):
        bench(FakeFramework(), FakeRecorder())[0].run(tasks([unknown]), Cancel())
    priced, _ = bench(FakeFramework(), recorder := FakeRecorder(), unknown_cost_usd=0.5)
    assert priced.run(tasks([unknown]), Cancel()).spent_usd == pytest.approx(0.5)
    assert "cost_unknown" in next(iter(recorder.runs.values()))["flags"]
    assert "costUsd" not in next(iter(recorder.runs.values()))


def test_no_retry_when_the_budget_is_spent():
    recorder = FakeRecorder()
    # The failed attempt still spent 0.15 USD (1M input tokens), so no retry fits the cap.
    framework = FakeFramework({("AAPL", 0): FrameworkRunResult(
        error="boom", usage=FrameworkUsage(input_tokens=1_000_000))})
    runner, out = bench(framework, recorder, cap=0.07)
    summary = runner.run(tasks([HOSTED]), Cancel())
    assert summary.failed == 1 and summary.retried == 0
    assert "budget: no retry" in out.getvalue()


def test_reported_cost_wins_and_unknown_frameworks_stop_the_plan():
    recorder = FakeRecorder()
    framework = FakeFramework({("AAPL", 0): FrameworkRunResult(
        rating="sell", rating_source="mapped", usage=FrameworkUsage(cost_usd=0.02, duration_ms=5))})
    runner, _ = bench(framework, recorder)
    assert runner.run(tasks([HOSTED]), Cancel()).spent_usd == pytest.approx(0.02)
    run = next(iter(recorder.runs.values()))
    assert run["costUsd"] == 0.02 and run["durationMs"] == 5 and run["ratingSource"] == "mapped"
    with pytest.raises(PlanError, match="not available"):
        runner.run(tasks(["other:openai:gpt-4o-mini"]), Cancel())


def test_cancellation_stops_new_runs_and_marks_the_running_one():
    recorder = FakeRecorder()
    cancel = Cancel()

    class Stopping(FakeFramework):
        def run(self, request, sink, cancellation):
            cancel.value = True
            return FrameworkRunResult(error="cancelled by the operator")

    runner, _ = bench(Stopping(), recorder)
    summary = runner.run(tasks([HOSTED], ("AAPL", "MSFT")), cancel)
    assert summary.cancelled == 2 and summary.retried == 0
    assert next(iter(recorder.runs.values()))["status"] == "cancelled"


def test_parallel_runs_record_every_cell():
    recorder = FakeRecorder()
    runner, _ = bench(FakeFramework(), recorder, parallel=3)
    summary = runner.run(tasks([HOSTED, LOCAL], ("AAPL", "MSFT", "NVDA")), Cancel())
    assert summary.succeeded == 6 and len(recorder.runs) == 6


def test_event_sink_drops_failed_batches_and_caps_events():
    recorder = FakeRecorder()
    recorder.fail_events = True
    sink = RecordingSink(recorder, "id-0", sleep=lambda _s: None)
    sink.emit(FrameworkEvent(agent=" ", kind="message", title="dropped: blank agent"))
    sink.emit(FrameworkEvent(agent="PM", kind="flag", title="numbers_withheld"))
    sink.flush()
    sink.flush()
    assert sink.flags == {"events_dropped"}
    recorder.fail_events = False
    capped = RecordingSink(recorder, "id-1")
    for seq in range(EVENTS_MAX + 1):
        capped.emit(FrameworkEvent(agent="A", kind="status", title=f"s{seq}"))
    capped.flush()
    assert sum(len(batch) for batch in recorder.events["id-1"]) == EVENTS_MAX
    assert capped.flags == {"events_truncated"}


class CallLog:
    """Recorder whose append_events is slow, logs every call and notes overlapping calls."""

    def __init__(self, failures: Sequence[Exception] = ()) -> None:
        self.calls: list[list[int]] = []
        self.attempts = 0
        self.failures = list(failures)
        self.in_flight = 0
        self.overlapped = False
        self.lock = threading.Lock()

    def append_events(self, run_id: str, events: Sequence[Mapping[str, Any]]) -> None:
        with self.lock:
            self.attempts += 1
            self.in_flight += 1
            self.overlapped = self.overlapped or self.in_flight > 1
            failure = self.failures.pop(0) if self.failures else None
        try:
            threading.Event().wait(0.01)
            if failure is not None:
                raise failure
            with self.lock:
                self.calls.append([int(event["seq"]) for event in events])
        finally:
            with self.lock:
                self.in_flight -= 1


class StatusError(RuntimeError):
    def __init__(self, status: int, code: str = "HTTP_ERROR") -> None:
        super().__init__(f"status {status} {code}")
        self.status, self.code = status, code


def test_event_sink_sends_batches_from_two_threads_in_seq_order():
    log = CallLog()
    sink = RecordingSink(log, "id-0", sleep=lambda _s: None)  # type: ignore[arg-type]
    start = threading.Barrier(2)

    def agent(name: str) -> None:
        start.wait()
        for n in range(225):
            sink.emit(FrameworkEvent(agent=name, kind="status", title=f"{name} {n}"))

    threads = [threading.Thread(target=agent, args=(name,)) for name in ("bull", "bear")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    sink.flush()
    seqs = [seq for call in log.calls for seq in call]
    assert seqs == list(range(450))  # strictly increasing within and across calls, none lost
    assert all(0 < len(call) <= 200 for call in log.calls)
    assert not log.overlapped and sink.flags == set()


def test_event_sink_retries_a_batch_after_5xx_and_transport_errors():
    log = CallLog([StatusError(503), StatusError(0)])
    sleeps: list[float] = []
    sink = RecordingSink(log, "id-0", sleep=sleeps.append)  # type: ignore[arg-type]
    for n in range(3):
        sink.emit(FrameworkEvent(agent="A", kind="status", title=f"s{n}"))
    sink.flush()
    assert log.calls == [[0, 1, 2]] and log.attempts == 3
    assert sleeps == [0.5, 1.0] and sink.flags == set()


def test_event_sink_does_not_retry_4xx_and_drops_after_failed_retries():
    conflict = CallLog([StatusError(409)])
    sink = RecordingSink(conflict, "id-0", sleep=lambda _s: None)  # type: ignore[arg-type]
    sink.emit(FrameworkEvent(agent="A", kind="status", title="s0"))
    sink.flush()
    assert conflict.attempts == 1 and conflict.calls == [] and sink.flags == {"events_dropped"}

    down = CallLog([RuntimeError("down")] * 3)
    later = RecordingSink(down, "id-1", sleep=lambda _s: None)  # type: ignore[arg-type]
    later.emit(FrameworkEvent(agent="A", kind="status", title="lost"))
    later.flush()
    assert down.attempts == 3 and later.flags == {"events_dropped"}
    later.emit(FrameworkEvent(agent="A", kind="status", title="kept"))
    later.flush()
    assert down.calls == [[1]]


# Command line -------------------------------------------------------------------------------------

def test_dry_run_prints_the_plan_and_calls_nothing():
    out = io.StringIO()
    code = main(["--batch", "grid-1", "--tickers", "aapl,msft", "--weekly", "2026-08-31..2026-09-11",
                 "--arm", HOSTED, "--arm", LOCAL, "--arm", "other:openai:gpt-4o", "--reruns", "2",
                 "--budget-usd", "0.5", "--dry-run"],
                recorder_factory=lambda env: pytest.fail("dry run must not record"), out=out)
    text = out.getvalue()
    assert code == 0
    assert "Plan: 24 runs, budget 0.50 USD" in text
    assert "fake:openai:gpt-4o-mini: 8 runs x 0.0630 USD = 0.5040 USD  (framework not available here)" in text
    assert "fake:llamacpp:qwen3:30b:u75a5be96 local: 8 runs x 0.0000 USD" in text
    assert "The budget stops the plan early" in text


def test_command_line_runs_records_and_reports_a_summary(tmp_path):
    recorder = FakeRecorder()
    out = io.StringIO()
    calendar = tmp_path / "days.txt"
    calendar.write_text("2026-09-03\n")
    code = main(["--batch", "grid-1", "--tickers", "AAPL", "--weekly", "2026-08-31..2026-09-06",
                 "--calendar", str(calendar), "--arm", "fake:openai:gpt-5-mini",
                 "--price", "openai:gpt-5-mini=0.25/2", "--budget-usd", "1", "--analysts",
                 "market, news", "--variant", "v1"],
                frameworks={"fake": FakeFramework()}, recorder_factory=lambda env: recorder,
                out=out)
    assert code == 0
    summary = json.loads(out.getvalue().strip().splitlines()[-1])
    assert summary["succeeded"] == 1 and summary["spentUsd"] == pytest.approx(0.45)
    run = next(iter(recorder.runs.values()))
    assert run["decisionDate"] == "2026-09-03" and run["analysts"] == ["market", "news"]


@pytest.mark.parametrize("args, message", [
    (["--batch", "bad batch"], "--batch"),
    (["--variant", "bad variant"], "--variant"),
    (["--reruns", "11"], "--reruns"),
    (["--price", "nope"], "provider:model=IN/OUT"),
    (["--tickers", "AA PL"], "ticker"),
    (["--tickers", ","], "at least one"),
    (["--arm", "other:openai:gpt-4o"], "not available"),
])
def test_command_line_rejects_bad_input(args, message):
    base = {"--batch": "grid-1", "--tickers": "AAPL", "--dates": "2026-09-04", "--arm": HOSTED,
            "--budget-usd": "1"}
    for flag, value in zip(args[::2], args[1::2]):
        base[flag] = value
    out = io.StringIO()
    argv = [part for pair in base.items() for part in pair]
    code = main(argv, frameworks={"fake": FakeFramework()},
                recorder_factory=lambda env: FakeRecorder(), out=out)
    assert code == 2 and message in out.getvalue()


def test_command_line_needs_recorder_settings_and_dates():
    out = io.StringIO()
    argv = ["--batch", "grid-1", "--tickers", "AAPL", "--dates", "2026-09-04", "--arm", HOSTED,
            "--budget-usd", "1"]
    assert main(argv, environ={}, frameworks={"fake": FakeFramework()}, out=out) == 2
    assert "VERTEX_API_URL" in out.getvalue()
    out = io.StringIO()
    assert main(["--batch", "g", "--tickers", "AAPL", "--weekly", "2026-09-05..2026-09-06",
                 "--arm", HOSTED, "--budget-usd", "1"], out=out) == 2
    assert "no decision dates" in out.getvalue()
    assert main(argv, environ={}, out=io.StringIO()) == 2


# Types and prices ---------------------------------------------------------------------------------

def test_framework_types_validate_at_the_boundary():
    with pytest.raises(ValidationError):
        FrameworkRunResult(rating="hold")
    with pytest.raises(ValidationError):
        FrameworkRunResult(rating_source="stated")
    with pytest.raises(ValidationError):
        FrameworkRunResult(flags=("Not A Slug",))
    assert FrameworkRunResult(flags=("a", "a", "b")).flags == ("a", "b")
    with pytest.raises(ValidationError):
        ModelEndpoint(provider="openai", model="m", api_key_env="openai_key")
    with pytest.raises(ValidationError):
        ModelEndpoint(provider="openai", model="m", base_url="ftp://host/v1")
    with pytest.raises(ValidationError):
        FrameworkInfo(name="Bad Name", version="1", tools_allowed=(), tools_excluded=())
    endpoint = ModelEndpoint(provider="openai", model="m")
    with pytest.raises(ValidationError):
        FrameworkRunRequest(ticker="AA PL", decision_date=date(2026, 9, 4), endpoint=endpoint)
    with pytest.raises(ValidationError):
        FrameworkRunRequest(ticker="AAPL", decision_date=date(2026, 9, 4), endpoint=endpoint,
                            variant="bad variant")
    with pytest.raises(ValidationError):
        FrameworkRunRequest(ticker="AAPL", decision_date=date(2026, 9, 4), endpoint=endpoint,
                            memory=True)
    assert FrameworkRunRequest(ticker=" aapl ", decision_date=date(2026, 9, 4),
                               endpoint=endpoint).ticker == "AAPL"
    for url, local in (("http://localhost:11434/v1", True), ("http://gpu.localhost/v1", True),
                       ("http://192.168.1.20:8080/v1", True), ("https://api.openai.com/v1", False),
                       ("http://8.8.8.8/v1", False), (None, False)):
        assert is_local_base_url(url) is local


def test_price_book_and_overrides():
    book = PriceBook({("openai", "gpt-5-mini"): TokenPrice(0.25, 2.0)})
    assert book.cost(ModelEndpoint(provider="openai", model="gpt-4o"), 1_000_000, 0) == 2.5
    assert book.cost(ModelEndpoint(provider="openai", model="gpt-5-mini"), 0, 1_000_000) == 2.0
    assert book.cost(ModelEndpoint(provider="openai", model="unknown"), 1, 1) is None
    local = ModelEndpoint(provider="ollama", model="x", base_url="http://127.0.0.1:11434/v1")
    assert book.cost(local, 10**9, 10**9) == 0
    assert parse_price("openai:gpt-5-mini=0.25/2") == (("openai", "gpt-5-mini"), TokenPrice(0.25, 2))
    for bad in ("openai=1/2", "openai:m=1", "openai:m=-1/2", "openai:m=nan/2"):
        with pytest.raises(ValueError):
            parse_price(bad)


# Recorder failures, reuse by variant and server, arm keys -----------------------------------------

def quiet_bench(framework: Any, recorder: FakeRecorder, **config: Any):
    sleeps: list[float] = []
    out = io.StringIO()
    runner = FrameworkBench({"fake": framework}, recorder, PriceBook(), BudgetLedger(100.0),
                            BenchConfig(batch="grid-1", **config), out=out, sleep=sleeps.append)
    return runner, out, sleeps


def test_a_final_update_that_keeps_failing_is_a_failed_run_and_releases_the_budget():
    recorder = FakeRecorder()
    recorder.update_failure = lambda _id, fields: (
        StatusError(503) if fields.get("status") in ("succeeded", "failed") else None)
    runner, out, sleeps = quiet_bench(FakeFramework(), recorder)
    summary = runner.run(tasks([HOSTED]), Cancel())
    assert (summary.failed, summary.retried, summary.succeeded) == (1, 1, 0)
    assert runner.ledger.in_flight == 0 and runner.ledger.spent == pytest.approx(0.42)
    assert sleeps == [0.5, 1.0, 0.5, 1.0]
    assert "the result could not be stored" in out.getvalue()


def test_a_run_that_cannot_start_is_marked_failed_and_costs_nothing():
    recorder = FakeRecorder()
    recorder.update_failure = lambda _id, fields: (
        StatusError(400, "VALIDATION_ERROR") if fields.get("status") == "running" else None)
    framework = FakeFramework()
    runner, out, sleeps = quiet_bench(framework, recorder)
    summary = runner.run(tasks([HOSTED]), Cancel())
    assert summary.failed == 1 and framework.calls == [] and sleeps == []
    assert runner.ledger.in_flight == 0 and runner.ledger.spent == 0
    first = recorder.runs["grid-1:fake:openai:gpt-4o-mini:AAPL:2026-09-04:r0"]
    assert first["status"] == "failed" and "could not mark the run" in first["error"]
    assert "update of run" in out.getvalue()


def test_a_lost_answer_retries_and_a_final_status_conflict_counts_as_stored():
    recorder = FakeRecorder()
    answers = iter([(StatusError(503), True), (StatusError(409, "CONFLICT"), False)])
    recorder.update_failure = lambda _id, fields: (
        next(answers, None) if fields.get("status") == "succeeded" else None)
    runner, _, sleeps = quiet_bench(FakeFramework(), recorder)
    summary = runner.run(tasks([HOSTED]), Cancel())
    assert summary.succeeded == 1 and summary.retried == 0 and sleeps == [0.5]
    assert recorder.by_id("id-0")["status"] == "succeeded"


@pytest.mark.parametrize("record", [
    lambda fields: (_ for _ in ()).throw(StatusError(0, "UNREACHABLE")),
    lambda fields: None,
    lambda fields: {"status": "queued"},
])
def test_a_run_that_cannot_be_recorded_is_failed_and_the_bench_goes_on(record):
    recorder = FakeRecorder()
    recorder.record = record  # type: ignore[method-assign]
    framework = FakeFramework()
    runner, out, _ = quiet_bench(framework, recorder)
    summary = runner.run(tasks([HOSTED], ("AAPL", "MSFT")), Cancel())
    assert summary.failed == 2 and summary.retried == 2 and framework.calls == []
    assert runner.ledger.in_flight == 0 and runner.ledger.spent == 0
    assert "not recorded" in out.getvalue()


def test_an_unexpected_error_after_recording_is_a_failed_run():
    recorder = FakeRecorder()
    runner, out, _ = quiet_bench(FakeFramework(), recorder, timeout_s=-1)
    summary = runner.run(tasks([HOSTED]), Cancel())
    assert summary.failed == 1 and runner.ledger.in_flight == 0
    assert "ValidationError" in out.getvalue()


def test_a_framework_that_cannot_start_stops_the_plan():
    class Broken(FakeFramework):
        def describe(self) -> FrameworkInfo:
            raise RuntimeError("not installed")

    runner, _, _ = quiet_bench(Broken(), FakeRecorder())
    with pytest.raises(PlanError, match="cannot start: not installed"):
        runner.run(tasks([HOSTED]), Cancel())


def test_the_command_reports_recorder_errors_instead_of_a_traceback():
    from adapters.vertex_run_recorder import RecorderError

    class Down(FakeRecorder):
        def count_finished(self, filters: Mapping[str, Any], accept: Any = None) -> int:
            raise RecorderError("list", 503, "STORAGE_ERROR")

    out = io.StringIO()
    code = main(["--batch", "g", "--tickers", "AAPL", "--dates", "2026-09-04", "--arm", HOSTED,
                 "--budget-usd", "1"], frameworks={"fake": FakeFramework()},
                recorder_factory=lambda env: Down(), out=out)
    assert code == 2 and "agentModelRuns.list failed: 503 STORAGE_ERROR" in out.getvalue()


def finished(recorder: FakeRecorder, key: str, **fields: Any) -> None:
    recorder.runs[key] = {
        "id": key, "status": "succeeded", "batch": "grid-1", "ticker": "AAPL",
        "decisionDate": "2026-09-04", "framework": "fake", "provider": "openai",
        "model": "gpt-4o-mini", "variant": None, "flags": ["memory_off"], **fields}


def test_reuse_tells_variants_and_servers_apart():
    recorder = FakeRecorder()
    proxy_a = "fake:openai:gpt-4o-mini:https://a.example.com/v1"
    proxy_b = "fake:openai:gpt-4o-mini:https://b.example.com/v1"
    flag_a = parse_arm(proxy_a).base_url_flag
    finished(recorder, "variant-run", variant="fast")
    finished(recorder, "proxy-a-run", flags=["memory_off", flag_a])
    framework = FakeFramework()
    runner, _, _ = quiet_bench(framework, recorder, unknown_cost_usd=0.01)
    summary = runner.run(tasks([HOSTED, proxy_a, proxy_b]), Cancel())
    # Only proxy A's own run is reused: the variant run and the other server's run do not count.
    assert summary.reused == 1 and summary.succeeded == 2
    assert sorted(call.endpoint.base_url or "hosted" for call in framework.calls) == [
        "hosted", "https://b.example.com/v1"]
    stored_b = next(run for run in recorder.runs.values()
                    if run.get("runKey", "").startswith("grid-1:fake:openai:gpt-4o-mini:u")
                    and run["status"] == "succeeded")
    assert parse_arm(proxy_b).base_url_flag in stored_b["flags"]
    variant_runner, _, _ = quiet_bench(FakeFramework(), recorder, variant="fast")
    assert variant_runner.run(tasks([HOSTED]), Cancel()).reused == 1


def test_arm_keys_name_the_server_and_https_arms_may_name_a_key_variable():
    hosted, proxy_a, proxy_b = (parse_arm(HOSTED),
                                parse_arm("fake:openai:m:https://a.example.com/v1"),
                                parse_arm("fake:openai:m:https://b.example.com/v1#PROXY_KEY"))
    assert hosted.key == "fake:openai:gpt-4o-mini" and hosted.base_url_flag is None
    assert proxy_a.key != proxy_b.key and proxy_a.key.startswith("fake:openai:m:u")
    assert proxy_a.base_url_flag == "base_url_" + proxy_a.key.rsplit(":u", 1)[1]
    assert proxy_a.endpoint.api_key_env is None
    assert proxy_b.endpoint.api_key_env == "PROXY_KEY"
    assert proxy_b.endpoint.base_url == "https://b.example.com/v1"
    with pytest.raises(PlanError, match="needs an https base URL"):
        parse_arm("fake:llamacpp:m:http://127.0.0.1:8080/v1#LOCAL_KEY")
    with pytest.raises(PlanError):
        parse_arm("fake:openai:m:https://a.example.com/v1#lower_case")


def test_providers_are_checked_per_framework(monkeypatch):
    supported = {"fake": frozenset({"openai", "deepseek"})}
    check_providers([parse_arm(HOSTED), parse_arm("fake:llamacpp:m:http://127.0.0.1:8080/v1"),
                     parse_arm("other:google:gemini-2.5-flash")], supported)
    with pytest.raises(PlanError, match="supports the hosted providers deepseek, openai"):
        check_providers([parse_arm("fake:google:gemini-2.5-flash")], supported)
    monkeypatch.setitem(FRAMEWORK_PROVIDERS, "fake", frozenset({"deepseek"}))
    out = io.StringIO()
    assert main(["--batch", "g", "--tickers", "AAPL", "--dates", "2026-09-04", "--arm", HOSTED,
                 "--budget-usd", "1", "--dry-run"], out=out) == 2
    assert "supports the hosted providers deepseek" in out.getvalue()
