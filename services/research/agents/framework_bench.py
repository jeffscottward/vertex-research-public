"""Benchmark agent frameworks and models on the same tickers and decision dates (research only).

Usage, from services/research:

    python -m agents.framework_bench --batch bench-2026-11 --tickers AAPL,MSFT \\
        --weekly 2026-09-01..2026-09-30 --arm vibe_trading:openai:gpt-4o-mini \\
        --arm vibe_trading:llamacpp:qwen3-30b:http://127.0.0.1:8080/v1 \\
        --reruns 2 --budget-usd 5 --dry-run

Each arm is framework:provider:model[:base_url[#KEY_ENV]]; a base_url points at an OpenAI-compatible
server (llama.cpp llama-server, Ollama /v1), and an https one may name its key variable. Every run is recorded in Vertex (agentModelRuns, purpose
benchmark) through VERTEX_API_URL and VERTEX_AGENT_API_KEY. A finished identical run (same batch,
cell and arm) is reused instead of run again. A failed run is retried once and is never counted as
hold. The budget is a hard stop: a run starts only when spent + in-flight estimates + its own
estimate stay within --budget-usd. --dry-run prints the plan and the estimated cost and calls
nothing. Ratings are research labels; nothing here places, sizes or sends an order.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import sys
import threading
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Mapping, Sequence, TextIO

from pydantic import ValidationError

from .framework_types import (
    LABEL, FrameworkEvent, FrameworkRunRequest, FrameworkRunResult, ModelEndpoint,
)
from .ports import AgentFrameworkPort, RunRecorder

DEFAULT_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "google": "GOOGLE_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
EVENTS_MAX = 5000
EVENT_BATCH = 200
EVENT_SEND_RETRIES = 2  # extra attempts for a batch after a 5xx or transport error
EVENT_RETRY_DELAY_S = 0.5
FLAGS_MAX = 16
MAX_RANGE_DAYS = 3 * 366
RUN_KEY_MAX = 128
_TEXT_LIMITS = {"agent": 100, "title": 300, "body": 16_000, "model": 200, "toolName": 100}

FrameworkFactory = Callable[[Mapping[str, str]], AgentFrameworkPort]


class PlanError(ValueError):
    """A bad command line or plan; the message is safe to print."""


def endpoint_tag(base_url: str | None) -> str | None:
    """Short, stable id of a base URL (8 hex digits of its SHA-256); None without one."""
    return None if base_url is None else hashlib.sha256(base_url.encode()).hexdigest()[:8]


@dataclass(frozen=True)
class Arm:
    framework: str
    endpoint: ModelEndpoint

    @property
    def key(self) -> str:
        """framework:provider:model, plus :u<tag> for a base URL (two servers, two arms)."""
        tag = endpoint_tag(self.endpoint.base_url)
        base = f"{self.framework}:{self.endpoint.provider}:{self.endpoint.model}"
        return base if tag is None else f"{base}:u{tag}"

    @property
    def base_url_flag(self) -> str | None:
        """The flag recorded on runs of an arm with a base URL, so reuse can tell servers apart."""
        tag = endpoint_tag(self.endpoint.base_url)
        return None if tag is None else f"base_url_{tag}"


def parse_arm(text: str) -> Arm:
    """framework:provider:model[:base_url[#KEY_ENV]]; the model may contain ':' (qwen3:30b).

    A base URL gets no key unless `#KEY_ENV` names the variable that holds one, and only an https
    base URL may name one (a key never travels in clear text)."""
    spec, base_url, key_env = text, None, None
    for scheme in (":http://", ":https://"):
        if scheme in text:
            spec, _, rest = text.partition(scheme)
            base_url = scheme[1:] + rest
            break
    if base_url is not None and "#" in base_url:
        base_url, _, key_env = base_url.partition("#")
        if not base_url.startswith("https://"):
            raise PlanError(f"arm {text!r}: a key variable needs an https base URL")
    parts = spec.split(":", 2)
    if len(parts) != 3 or not all(parts):
        raise PlanError(f"arm {text!r} must be framework:provider:model[:base_url[#KEY_ENV]]")
    framework, provider, model = parts
    try:
        endpoint = ModelEndpoint(
            provider=provider, model=model, base_url=base_url,
            api_key_env=key_env if base_url is not None else DEFAULT_KEY_ENV.get(provider),
        )
    except ValidationError as error:
        raise PlanError(f"arm {text!r}: {error.errors()[0]['msg']}") from None
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", framework):
        raise PlanError(f"arm {text!r}: the framework must be a lowercase slug")
    return Arm(framework, endpoint)


def check_providers(arms: Iterable[Arm],
                    supported: Mapping[str, frozenset[str]]) -> None:
    """Refuses a hosted provider that the arm's framework cannot call. An arm with a base URL
    (an OpenAI-compatible server) passes; a framework without an entry accepts any provider."""
    for arm in arms:
        known = supported.get(arm.framework)
        if known is not None and arm.endpoint.base_url is None and arm.endpoint.provider not in known:
            raise PlanError(f"arm {arm.key}: {arm.framework} supports the hosted providers "
                            f"{', '.join(sorted(known))}, or a base URL")


def parse_dates(text: str) -> list[date]:
    try:
        return sorted({date.fromisoformat(part.strip()) for part in text.split(",") if part.strip()})
    except ValueError:
        raise PlanError(f"dates {text!r} must be YYYY-MM-DD, comma separated") from None


def load_calendar(path: str) -> frozenset[date]:
    """Trading days, one YYYY-MM-DD per line ('#' starts a comment)."""
    days: set[date] = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            text = line.split("#", 1)[0].strip()
            if text:
                try:
                    days.add(date.fromisoformat(text))
                except ValueError:
                    raise PlanError(f"calendar line {text!r} is not YYYY-MM-DD") from None
    return frozenset(days)


def weekly_dates(text: str, calendar: frozenset[date] | None = None) -> list[date]:
    """The last trading day of each ISO week in FROM..TO: from the calendar, else Monday-Friday."""
    start_text, sep, end_text = text.partition("..")
    try:
        start, end = date.fromisoformat(start_text), date.fromisoformat(end_text)
    except ValueError:
        raise PlanError(f"weekly range {text!r} must be YYYY-MM-DD..YYYY-MM-DD") from None
    if not sep or start > end or (end - start).days > MAX_RANGE_DAYS:
        raise PlanError(f"weekly range {text!r} must run forward and span at most 3 years")
    last: dict[tuple[int, int], date] = {}
    day = start
    while day <= end:
        trading = day in calendar if calendar is not None else day.weekday() < 5
        if trading:
            year, week, _ = day.isocalendar()
            last[(year, week)] = day
        day += timedelta(days=1)
    return sorted(last.values())


@dataclass(frozen=True)
class Task:
    arm: Arm
    ticker: str
    decision_date: date
    rerun: int


def plan_tasks(arms: Sequence[Arm], tickers: Sequence[str], dates: Sequence[date],
               reruns: int) -> list[Task]:
    """Cell by cell, every arm on a cell before the next cell, so a budget stop leaves whole cells."""
    return [Task(arm, ticker, day, rerun)
            for day in dates for ticker in tickers for rerun in range(reruns) for arm in arms]


def run_key(batch: str, task: Task, variant: str | None, attempt: int) -> str:
    endpoint = task.arm.endpoint
    parts = [batch, task.arm.framework, endpoint.provider, endpoint.model]
    tag = endpoint_tag(endpoint.base_url)
    if tag is not None:
        parts.append(f"u{tag}")
    if variant is not None:
        parts.append(variant)
    parts += [task.ticker, task.decision_date.isoformat(), f"r{task.rerun}"]
    if attempt:
        parts.append(f"retry{attempt}")
    raw = ":".join(parts)
    clean = re.sub(r"[^A-Za-z0-9._:-]", "-", raw)
    if len(clean) > RUN_KEY_MAX:
        clean = clean[:RUN_KEY_MAX - 17] + "-" + hashlib.sha256(raw.encode()).hexdigest()[:16]
    return clean


class BudgetLedger:
    """Hard USD cap: spent + in-flight estimates + the next estimate must stay within the cap."""

    def __init__(self, cap_usd: float) -> None:
        if not cap_usd > 0:
            raise PlanError("--budget-usd must be above 0")
        self.cap = cap_usd
        self.spent = 0.0
        self.in_flight = 0.0
        self._lock = threading.Lock()

    def reserve(self, estimate: float) -> bool:
        with self._lock:
            if self.spent + self.in_flight + estimate > self.cap + 1e-9:
                return False
            self.in_flight += estimate
            return True

    def settle(self, estimate: float, actual: float | None) -> None:
        """Release the estimate and charge the actual cost (the estimate when it is unknown)."""
        with self._lock:
            self.in_flight = max(0.0, self.in_flight - estimate)
            self.spent += estimate if actual is None else actual


def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value[:limit] if value else None


def _retryable(error: Exception) -> bool:
    """A 4xx answer will not change on retry; a 5xx or a transport error (status 0 or none) may."""
    status = getattr(error, "status", None)
    return not (isinstance(status, int) and 400 <= status < 500)


class RecordingSink:
    """Buffers framework events with increasing seqs and appends them in batches of 200.

    Agents may emit from several threads (Vibe-Trading's bull and bear run in parallel). One send
    lock covers taking a batch and sending it, so batches reach the server in seq order; a 5xx or
    transport error retries the identical batch (the server treats an exact retry as a no-op)."""

    def __init__(self, recorder: RunRecorder, run_id: str, *,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self._recorder, self._run_id = recorder, run_id
        self._buffer: list[dict[str, Any]] = []
        self._seq = 0
        self._lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._sleep = sleep
        self.flags: set[str] = set()

    def emit(self, event: FrameworkEvent) -> None:
        with self._lock:
            if self._seq >= EVENTS_MAX:
                self.flags.add("events_truncated")
                return
            row: dict[str, Any] = {"seq": self._seq, "kind": event.kind}
            for name, value in (("agent", event.agent), ("title", event.title),
                                ("body", event.body), ("model", event.model),
                                ("toolName", event.tool_name)):
                text = _clip(value, _TEXT_LIMITS[name])
                if text is not None:
                    row[name] = text
            if "agent" not in row or "title" not in row:
                return
            for name, value in (("inputTokens", event.input_tokens),
                                ("outputTokens", event.output_tokens),
                                ("costUsd", event.cost_usd), ("durationMs", event.duration_ms)):
                if value is not None:
                    row[name] = value
            self._seq += 1
            self._buffer.append(row)
            full = len(self._buffer) >= EVENT_BATCH
        if full:
            self.flush()

    def flush(self) -> None:
        """Sends the buffer in seq order, at most EVENT_BATCH events per call."""
        with self._send_lock:
            while True:
                with self._lock:
                    batch = self._buffer[:EVENT_BATCH]
                    del self._buffer[:EVENT_BATCH]
                if not batch:
                    return
                self._send(batch)

    def _send(self, batch: list[dict[str, Any]]) -> None:
        for attempt in range(EVENT_SEND_RETRIES + 1):
            try:
                self._recorder.append_events(self._run_id, batch)
                return
            except Exception as error:  # noqa: BLE001 - events serve the live view; never stop a run
                if attempt == EVENT_SEND_RETRIES or not _retryable(error):
                    break
                self._sleep(EVENT_RETRY_DELAY_S * (attempt + 1))
        self.flags.add("events_dropped")


@dataclass
class BenchSummary:
    planned: int = 0
    reused: int = 0
    succeeded: int = 0
    failed: int = 0
    retried: int = 0
    busy: int = 0
    skipped_budget: int = 0
    cancelled: int = 0
    spent_usd: float = 0.0
    outcomes: Counter[str] = field(default_factory=Counter)

    def as_dict(self) -> dict[str, Any]:
        return {"planned": self.planned, "reused": self.reused, "succeeded": self.succeeded,
                "failed": self.failed, "retried": self.retried, "busy": self.busy,
                "skippedBudget": self.skipped_budget, "cancelled": self.cancelled,
                "spentUsd": round(self.spent_usd, 6)}


class _Cancel:
    def __init__(self) -> None:
        self.event = threading.Event()

    def cancelled(self) -> bool:
        return self.event.is_set()


@dataclass(frozen=True)
class BenchConfig:
    batch: str
    variant: str | None = None
    analysts: tuple[str, ...] = ()
    timeout_s: float = 1800.0
    parallel: int = 1
    est_input_tokens: int = 300_000
    est_output_tokens: int = 30_000
    unknown_cost_usd: float | None = None
    data_source: str | None = None


class FrameworkBench:
    """Runs a plan against frameworks and records every run (sequential unless parallel > 1)."""

    def __init__(self, frameworks: Mapping[str, AgentFrameworkPort], recorder: RunRecorder,
                 prices: Any, ledger: BudgetLedger, config: BenchConfig, *,
                 clock: Callable[[], float] = time.monotonic, out: TextIO = sys.stdout,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.frameworks, self.recorder, self.prices = frameworks, recorder, prices
        self.ledger, self.config, self.clock, self.out = ledger, config, clock, out
        self.sleep = sleep
        self._lock = threading.Lock()

    # Estimates -------------------------------------------------------------------------------

    def estimate(self, arm: Arm) -> float:
        cost = self.prices.cost(arm.endpoint, self.config.est_input_tokens,
                                self.config.est_output_tokens)
        if cost is not None:
            return cost
        if self.config.unknown_cost_usd is None:
            raise PlanError(f"no price for {arm.endpoint.provider}:{arm.endpoint.model}; "
                            "add --price provider:model=IN/OUT or --unknown-cost-usd")
        return self.config.unknown_cost_usd

    # Plan --------------------------------------------------------------------------------------

    def _reuse_filters(self, task: Task) -> dict[str, Any]:
        endpoint = task.arm.endpoint
        filters: dict[str, Any] = {
            "batch": self.config.batch, "decisionFrom": task.decision_date.isoformat(),
            "decisionTo": task.decision_date.isoformat(), "framework": [task.arm.framework],
            "model": [endpoint.model], "provider": [endpoint.provider], "purpose": ["benchmark"],
            "ticker": [task.ticker],
        }
        if self.config.variant is not None:
            filters["variant"] = [self.config.variant]
        if task.arm.base_url_flag is not None:
            filters["flags"] = [task.arm.base_url_flag]
        return filters

    def _same_arm(self, arm: Arm) -> Callable[[Mapping[str, Any]], bool]:
        """What the list filters cannot say: the same variant (also none) and the same base URL
        (also none), read from the base_url_* flag."""
        wanted = {arm.base_url_flag} - {None}

        def accept(run: Mapping[str, Any]) -> bool:
            flags = run.get("flags") if isinstance(run.get("flags"), list) else []
            servers = {flag for flag in flags if str(flag).startswith("base_url_")}
            return run.get("variant") == self.config.variant and servers == wanted

        return accept

    def _to_run(self, tasks: Sequence[Task], summary: BenchSummary) -> list[Task]:
        """Leaves out reruns that a finished identical run in the batch already covers."""
        finished: dict[tuple[str, str, date], int] = {}
        todo = []
        for task in tasks:
            cell = (task.arm.key, task.ticker, task.decision_date)
            if cell not in finished:
                finished[cell] = self.recorder.count_finished(self._reuse_filters(task),
                                                              self._same_arm(task.arm))
            if task.rerun < finished[cell]:
                summary.reused += 1
                summary.outcomes["reused"] += 1
            else:
                todo.append(task)
        return todo

    def run(self, tasks: Sequence[Task], cancellation: Any) -> BenchSummary:
        summary = BenchSummary(planned=len(tasks))
        for arm in {task.arm for task in tasks}:
            if arm.framework not in self.frameworks:
                raise PlanError(f"framework {arm.framework!r} is not available here "
                                f"(available: {', '.join(sorted(self.frameworks)) or 'none'})")
            try:
                self.frameworks[arm.framework].describe()
            except Exception as error:  # noqa: BLE001 - a framework that cannot start stops the plan
                raise PlanError(f"framework {arm.framework!r} cannot start: {error}") from None
            self.estimate(arm)
        todo = self._to_run(tasks, summary)
        pending: set[Future[None]] = set()
        with ThreadPoolExecutor(max_workers=self.config.parallel) as pool:
            for index, task in enumerate(todo):
                while len(pending) >= self.config.parallel:
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        future.result()
                if cancellation.cancelled():
                    summary.cancelled += len(todo) - index
                    break
                estimate = self.estimate(task.arm)
                if not self.ledger.reserve(estimate):
                    summary.skipped_budget += len(todo) - index
                    self._say(f"budget: stop before {len(todo) - index} runs "
                              f"(spent {self.ledger.spent:.4f} of {self.ledger.cap:.4f} USD)")
                    break
                pending.add(pool.submit(self._execute, task, estimate, summary, cancellation))
            for future in pending:
                future.result()
        summary.spent_usd = self.ledger.spent
        return summary

    # One task ----------------------------------------------------------------------------------

    def _execute(self, task: Task, estimate: float, summary: BenchSummary,
                 cancellation: Any) -> None:
        outcome = self._attempt(task, 0, estimate, cancellation)
        if outcome == "failed" and not cancellation.cancelled():
            if self.ledger.reserve(estimate):
                with self._lock:
                    summary.retried += 1
                outcome = self._attempt(task, 1, estimate, cancellation)
            else:
                self._say(f"budget: no retry for {task.arm.key} {task.ticker} {task.decision_date}")
        with self._lock:
            summary.outcomes[outcome] += 1
            if outcome == "succeeded":
                summary.succeeded += 1
            elif outcome == "reused":
                summary.reused += 1
            elif outcome == "busy":
                summary.busy += 1
            elif outcome == "cancelled":
                summary.cancelled += 1
            else:
                summary.failed += 1

    def _base_flags(self, task: Task, attempt: int) -> list[str]:
        flags = ["memory_off"]
        if task.arm.endpoint.local:
            flags.append("local_model")
        if task.arm.base_url_flag is not None:
            flags.append(task.arm.base_url_flag)
        if task.rerun:
            flags.append("rerun")
        if attempt:
            flags.append("retry")
        return flags

    def _update(self, run_id: str, fields: Mapping[str, Any], *, final: bool) -> bool:
        """Stores an update, again up to EVENT_SEND_RETRIES times after a 5xx or transport error.
        False when it could not be stored; the error is printed, never raised."""
        for attempt in range(EVENT_SEND_RETRIES + 1):
            try:
                self.recorder.update(run_id, fields)
                return True
            except Exception as error:  # noqa: BLE001 - a recorder failure must not stop the bench
                if final and attempt and getattr(error, "code", None) == "CONFLICT":
                    return True  # an earlier try was stored and made the status final
                if attempt == EVENT_SEND_RETRIES or not _retryable(error):
                    self._say(f"recorder: update of run {run_id} failed: {error}")
                    return False
                self.sleep(EVENT_RETRY_DELAY_S * (attempt + 1))
        return False  # pragma: no cover - the loop always returns

    def _attempt(self, task: Task, attempt: int, estimate: float, cancellation: Any) -> str:
        """Records, runs and reports one attempt. Returns its outcome and always settles the
        estimate: a recorder failure counts as a failed run and never stops the bench."""
        settled = False

        def settle(cost: float | None) -> None:
            nonlocal settled
            if not settled:
                settled = True
                self.ledger.settle(estimate, cost)

        cell = f"{task.arm.key} {task.ticker} {task.decision_date} rerun {task.rerun}"
        try:
            framework = self.frameworks[task.arm.framework]
            info = framework.describe()
            endpoint = task.arm.endpoint
            fields: dict[str, Any] = {
                "runKey": run_key(self.config.batch, task, self.config.variant, attempt),
                "framework": info.name, "frameworkVersion": info.version,
                "provider": endpoint.provider, "model": endpoint.model, "ticker": task.ticker,
                "decisionDate": task.decision_date.isoformat(),
                "analysts": list(self.config.analysts), "status": "queued",
                "purpose": "benchmark", "batch": self.config.batch, "memory": False,
                "flags": self._base_flags(task, attempt),
            }
            if self.config.variant is not None:
                fields["variant"] = self.config.variant
            if self.config.data_source is not None:
                fields["dataSource"] = self.config.data_source
            try:
                stored = self.recorder.record(fields)
            except Exception as error:  # noqa: BLE001 - counted as a failed run
                self._say(f"recorder: {cell} not recorded: {error}")
                return "failed"
            if not isinstance(stored, Mapping) or not isinstance(stored.get("id"), str) \
                    or not stored["id"]:
                self._say(f"recorder: {cell} not recorded: the answer has no run id")
                return "failed"
            status = stored.get("status")
            if status != "queued":
                # The key exists already: a finished run is reused, a running one belongs to
                # another bench, and a failed one moves on to the retry key.
                return {"succeeded": "reused", "running": "busy"}.get(str(status), "failed")
            run_id = stored["id"]
            if not self._update(run_id, {"status": "running"}, final=False):
                self._update(run_id, {"status": "failed", "flags": fields["flags"],
                                      "error": "the bench could not mark the run as running"},
                             final=True)
                return "failed"
            sink = RecordingSink(self.recorder, run_id, sleep=self.sleep)
            request = FrameworkRunRequest(
                ticker=task.ticker, decision_date=task.decision_date, endpoint=endpoint,
                analysts=self.config.analysts, variant=self.config.variant,
                timeout_s=self.config.timeout_s,
            )
            started = self.clock()
            try:
                result = framework.run(request, sink, cancellation)
            except Exception as error:  # noqa: BLE001 - a framework crash is a failed run, never hold
                result = FrameworkRunResult(error=f"{type(error).__name__}: {error}"[:2000],
                                            flags=("framework_error",))
            elapsed_ms = int((self.clock() - started) * 1000)
            sink.flush()
            usage = result.usage
            cost = usage.cost_usd
            if cost is None:
                cost = self.prices.cost(endpoint, usage.input_tokens, usage.output_tokens)
            settle(cost)
            if result.error is None:
                status = "succeeded"
            elif cancellation.cancelled():
                status = "cancelled"
            else:
                status = "failed"
            flags = list(dict.fromkeys([*fields["flags"], *result.flags, *sorted(sink.flags),
                                        *(["cost_unknown"] if cost is None else [])]))
            report: dict[str, Any] = {
                "status": status, "rating": result.rating, "ratingSource": result.rating_source,
                "entryPrice": result.entry_price, "stopPrice": result.stop_price,
                "targetPrice": result.target_price, "horizon": result.horizon,
                "inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens,
                "llmCalls": usage.llm_calls, "toolCalls": usage.tool_calls,
                "durationMs": usage.duration_ms if usage.duration_ms is not None else elapsed_ms,
                "modelsServed": [served.model_dump() for served in result.models_served],
                "flags": flags[:FLAGS_MAX], "error": result.error,
            }
            if cost is not None:
                report["costUsd"] = round(cost, 6)
            if not self._update(run_id, report, final=True):
                self._say(f"failed: {cell}: the result could not be stored")
                return "failed"
            self._say(f"{status}: {cell} rating {result.rating or 'none'}")
            return status
        except Exception as error:  # noqa: BLE001 - any other failure is a failed run
            self._say(f"failed: {cell}: {type(error).__name__}: {error}"[:500])
            return "failed"
        finally:
            settle(0.0)

    def _say(self, line: str) -> None:
        with self._lock:
            print(line, file=self.out, flush=True)


# Command line ------------------------------------------------------------------------------------

def _vibe_trading(environ: Mapping[str, str]) -> AgentFrameworkPort:
    """Vibe-Trading (services/vibe-trading); VERTEX_VT_DIR names the clone."""
    from adapters.vibe_trading_framework import FrameworkSetupError, VibeTradingFramework

    try:
        return VibeTradingFramework.from_env(environ)
    except FrameworkSetupError as error:
        raise PlanError(str(error)) from None


# Frameworks this checkout can run, by name; each factory reads its own settings from the environment.
FRAMEWORK_FACTORIES: dict[str, FrameworkFactory] = {"vibe_trading": _vibe_trading}
# Hosted providers each framework can call without a base URL (checked when the arms are parsed).
FRAMEWORK_PROVIDERS: dict[str, frozenset[str]] = {
    # The hosted providers vt_driver.py wires (HOSTED_PROVIDERS); a test keeps the two in step.
    "vibe_trading": frozenset({"anthropic", "deepseek", "openai", "openrouter"}),
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m agents.framework_bench",
                                     description=__doc__.split("\n\n")[0])
    parser.add_argument("--batch", required=True, help="Batch label that groups the runs")
    parser.add_argument("--tickers", required=True, help="Comma separated tickers")
    when = parser.add_mutually_exclusive_group(required=True)
    when.add_argument("--dates", help="Comma separated decision dates YYYY-MM-DD")
    when.add_argument("--weekly", help="FROM..TO: the last trading day of each ISO week")
    parser.add_argument("--calendar", help="File with one trading day per line (for --weekly)")
    parser.add_argument("--arm", action="append", required=True,
                        help="framework:provider:model[:base_url[#KEY_ENV]]; repeat for each arm")
    parser.add_argument("--reruns", type=int, default=1, help="Runs per cell and arm (1-10)")
    parser.add_argument("--budget-usd", type=float, required=True, help="Hard cost cap in USD")
    parser.add_argument("--variant", help="Runtime variant label")
    parser.add_argument("--analysts", default="", help="Comma separated analysts or desks")
    parser.add_argument("--timeout-s", type=float, default=1800.0, help="Timeout per run")
    parser.add_argument("--parallel", type=int, default=1, help="Runs at the same time (1-4)")
    parser.add_argument("--est-input-tokens", type=int, default=300_000)
    parser.add_argument("--est-output-tokens", type=int, default=30_000)
    parser.add_argument("--unknown-cost-usd", type=float,
                        help="Cost estimate per run for a hosted model without a price")
    parser.add_argument("--price", action="append", default=[],
                        help="provider:model=IN/OUT USD per 1M tokens; overrides the table")
    parser.add_argument("--data-source", help="Market data source label to record")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the plan and the estimated cost; call nothing")
    return parser


def _tickers(text: str) -> list[str]:
    tickers = list(dict.fromkeys(part.strip().upper() for part in text.split(",") if part.strip()))
    for ticker in tickers:
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9.=/-]{0,19}", ticker):
            raise PlanError(f"ticker {ticker!r} is not valid")
    if not tickers:
        raise PlanError("--tickers needs at least one ticker")
    return tickers


def _dry_run(bench: FrameworkBench, arms: Sequence[Arm], tasks: Sequence[Task],
             frameworks: Iterable[str], out: TextIO) -> None:
    per_arm = Counter(task.arm for task in tasks)
    total = 0.0
    print(f"Plan: {len(tasks)} runs, budget {bench.ledger.cap:.2f} USD", file=out)
    available = set(frameworks)
    for arm in arms:
        estimate = bench.estimate(arm)
        total += estimate * per_arm[arm]
        note = "" if arm.framework in available else "  (framework not available here)"
        local = " local" if arm.endpoint.local else ""
        print(f"  {arm.key}{local}: {per_arm[arm]} runs x {estimate:.4f} USD = "
              f"{estimate * per_arm[arm]:.4f} USD{note}", file=out)
    print(f"Estimated total: {total:.4f} USD", file=out)
    if total > bench.ledger.cap:
        print("The budget stops the plan early; reruns of a failed run cost extra.", file=out)


def main(argv: Sequence[str] | None = None, *, environ: Mapping[str, str] = os.environ,
         frameworks: Mapping[str, AgentFrameworkPort] | None = None,
         recorder_factory: Callable[[Mapping[str, str]], RunRecorder] | None = None,
         out: TextIO = sys.stdout) -> int:
    from adapters.model_pricing import PriceBook, parse_price
    from adapters.vertex_run_recorder import RecorderError, VertexRunRecorder

    args = _parser().parse_args(argv)
    try:
        if not LABEL.fullmatch(args.batch):
            raise PlanError("--batch must be 1-64 letters, digits, '.', '_', ':' or '-'")
        if args.variant is not None and not LABEL.fullmatch(args.variant):
            raise PlanError("--variant must be 1-64 letters, digits, '.', '_', ':' or '-'")
        if not 1 <= args.reruns <= 10 or not 1 <= args.parallel <= 4:
            raise PlanError("--reruns must be 1-10 and --parallel 1-4")
        try:
            prices = PriceBook(dict(parse_price(text) for text in args.price))
        except ValueError as error:
            raise PlanError(str(error)) from None
        calendar = load_calendar(args.calendar) if args.calendar else None
        dates = parse_dates(args.dates) if args.dates else weekly_dates(args.weekly, calendar)
        if not dates:
            raise PlanError("the plan has no decision dates")
        arms = list(dict.fromkeys(parse_arm(text) for text in args.arm))
        check_providers(arms, FRAMEWORK_PROVIDERS)
        tasks = plan_tasks(arms, _tickers(args.tickers), dates, args.reruns)
        config = BenchConfig(
            batch=args.batch, variant=args.variant,
            analysts=tuple(part.strip() for part in args.analysts.split(",") if part.strip()),
            timeout_s=args.timeout_s, parallel=args.parallel,
            est_input_tokens=args.est_input_tokens, est_output_tokens=args.est_output_tokens,
            unknown_cost_usd=args.unknown_cost_usd, data_source=args.data_source,
        )
        ledger = BudgetLedger(args.budget_usd)
        available = frameworks if frameworks is not None else {}
        if args.dry_run:
            names = set(available) | set(FRAMEWORK_FACTORIES)
            bench = FrameworkBench(available, _NoRecorder(), prices, ledger, config, out=out)
            _dry_run(bench, arms, tasks, names, out)
            return 0
        if frameworks is None:
            available = {arm.framework: FRAMEWORK_FACTORIES[arm.framework](environ)
                         for arm in arms if arm.framework in FRAMEWORK_FACTORIES}
        if recorder_factory is None:
            recorder_factory = VertexRunRecorder.from_env
        recorder = recorder_factory(environ)
        bench = FrameworkBench(available, recorder, prices, ledger, config, out=out)
        cancellation = _Cancel()
        previous = _install_interrupt(cancellation)
        try:
            summary = bench.run(tasks, cancellation)
        finally:
            _restore_interrupt(previous)
    except (PlanError, ValueError, OSError, RecorderError) as error:
        print(f"framework_bench: {error}", file=out)
        return 2
    print(json.dumps(summary.as_dict()), file=out)
    return 0


class _NoRecorder:
    """Dry run: the plan never reaches Vertex."""

    def record(self, fields: Mapping[str, Any]) -> Mapping[str, Any]:  # pragma: no cover
        raise AssertionError("dry run records nothing")

    update = append_events = count_finished = record


def _install_interrupt(cancellation: _Cancel) -> Any:
    """Ctrl-C asks the running framework to stop; the run is reported as cancelled."""
    if threading.current_thread() is not threading.main_thread():
        return None
    return signal.signal(signal.SIGINT, lambda *_: cancellation.event.set())


def _restore_interrupt(previous: Any) -> None:
    if previous is not None:
        signal.signal(signal.SIGINT, previous)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
