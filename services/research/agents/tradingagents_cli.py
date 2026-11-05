"""On-demand TradingAgents research for one ticker over Claude through OMP. Research only.

Runs the TradingAgents bull/bear brief desk and the setup debate desk (and, with
``--themes``, the theme discovery desk first) of ``TradingAgentsResearchAdapter`` with
``OmpClaudeGenerator``. It writes two files:

- the dossier (``--out``): typed desk outputs, prompt names, model ids, timings, usage and
  source references;
- the record payload (``<out stem>.record.json``): an ``agentModelRuns.record`` body with
  framework ``tradingagents`` and the ``agentModelRuns.appendEvents`` events, so the debate
  can be stored in Vertex. This command sends nothing; post the payload with a write key
  (``docs/vertex-rebuild/agent-model-runs.md``).

The context is the ticker and the date, plus an optional caller JSON object
(``--context``). Account, credential and order-like keys in the context are refused. The
output never has order, size, strike, expiry or price-level fields, and the record has no
rating and no levels: it can never authorize, create or size a trade.

Usage (from ``services/research``)::

    python -m agents.tradingagents_cli --ticker NVDA --as-of 2026-11-04 [--context ctx.json] \
        [--out ../../private/research/tradingagents/NVDA-2026-11-04.json] [--thinking low]

Without ``--out`` the files go to ``private/research/tradingagents/`` at the repository root
(git-ignored).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from agents.external_research import (
    PROMPT_CONTRACTS,
    ExternalResearchError,
    PromptName,
    ResearchBrief,
    ThemeThesis,
    TradingAgentsResearchAdapter,
    _order_keys,
    redact_context,
)
from agents.omp_claude import DEFAULT_MODEL, DEFAULT_TIMEOUT_S, THINKING_LEVELS, OmpClaudeGenerator, Runner

FRAMEWORK = "tradingagents"
FRAMEWORK_VERSION = "vertex-adapter-1"
DOSSIER_SCHEMA = "vertex.tradingagents.dossier.v1"
RECORD_SCHEMA = "vertex.agent_model_run.payload.v1"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT_DIR = REPO_ROOT / "private" / "research" / "tradingagents"
MAX_CONTEXT_BYTES = 1_000_000
EVENT_BODY_MAX = 16_000
NOTICE = ("Research only. Advisory desk output; it never authorizes, creates or sizes an order "
          "and selects no contract, strike, expiry or price level.")
DESK_NAMES: dict[PromptName, str] = {
    "theme_discovery": "Theme Desk",
    "bull_bear_research_brief": "Bull/Bear Desk",
    "trade_setup_debate": "Setup Debate Desk",
    "market_regime_analysis": "Regime Desk",
    "candidate_discovery": "Candidate Desk",
}
_TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.=/-]{0,19}$")
_FORBIDDEN_CONTEXT_KEY = re.compile(
    r"(account|api[_-]?key|secret|token|password|passwd|credential|portfolio|position|balance)",
    re.IGNORECASE)


class CliError(ValueError):
    """Bad command-line input; exit code 2."""


@dataclass(frozen=True)
class DeskRun:
    prompt_name: PromptName
    output: Any
    started_at: datetime
    duration_ms: int


def _dump(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, list):
        return [_dump(item) for item in value]
    return value


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _forbidden_keys(value: Any) -> set[str]:
    if isinstance(value, Mapping):
        found = {str(k) for k in value if _FORBIDDEN_CONTEXT_KEY.search(str(k))}
        for item in value.values():
            found |= _forbidden_keys(item)
        return found
    if isinstance(value, list):
        return set().union(*(_forbidden_keys(item) for item in value)) if value else set()
    return set()


def normalise_ticker(raw: str) -> str:
    ticker = raw.strip().upper()
    if not _TICKER.match(ticker):
        raise CliError(f"Ticker {raw!r} is not valid (A-Z, 0-9, '.', '=', '/', '-'; max 20).")
    return ticker


def load_context(path: Path | None) -> dict[str, Any]:
    """Caller research context: one JSON object without account, secret or order keys."""
    if path is None:
        return {}
    raw = path.expanduser().read_bytes()
    if len(raw) > MAX_CONTEXT_BYTES:
        raise CliError(f"Context file is larger than {MAX_CONTEXT_BYTES} bytes.")
    try:
        context = json.loads(raw)
    except ValueError as exc:
        raise CliError("Context file is not JSON.") from exc
    if not isinstance(context, dict):
        raise CliError("Context file must hold one JSON object.")
    refused = _forbidden_keys(context) | _order_keys(context)
    if refused:
        raise CliError(f"Context has account, secret or order-like keys {sorted(refused)}; "
                       "pass research data only (for example rename a price field to close).")
    return context


def build_context(ticker: str, as_of: date, caller: Mapping[str, Any]) -> dict[str, Any]:
    """Minimal non-account context. Nothing here is fetched; the model gets only this."""
    context: dict[str, Any] = {
        "ticker": ticker,
        "as_of": as_of.isoformat(),
        "data_note": ("No market data, filings or news were fetched for this run. Use only the "
                      "supplied context; say when evidence is missing instead of inventing it."),
    }
    if caller:
        context["caller_context"] = dict(caller)
    return context


def _timed(clock: Callable[[], float], name: PromptName, call: Callable[[], Any]) -> DeskRun:
    started_at, t0 = datetime.now(UTC), clock()
    output = call()
    return DeskRun(name, output, started_at, int(round((clock() - t0) * 1000)))


def run_desks(adapter: TradingAgentsResearchAdapter, ticker: str, context: Mapping[str, Any], *,
              with_themes: bool, clock: Callable[[], float] = time.monotonic,
              runs: list[DeskRun] | None = None) -> list[DeskRun]:
    """Theme discovery (optional), then the bull/bear brief, then the setup debate.

    Finished desks are appended to ``runs`` as they finish, so a caller that passes its own
    list keeps them when a later desk fails.
    """
    runs = [] if runs is None else runs
    themes: list[ThemeThesis] = []
    if with_themes:
        runs.append(_timed(clock, "theme_discovery", lambda: adapter.discover_themes(context)))
        themes = runs[-1].output
    runs.append(_timed(clock, "bull_bear_research_brief",
                       lambda: adapter.analyze_candidate(ticker, themes, context=context)))
    brief: ResearchBrief = runs[-1].output
    setup = {
        "ticker": ticker,
        "as_of": context["as_of"],
        "idea": (f"Stress-test the research thesis for {ticker} as of {context['as_of']}: is the "
                 "evidence strong enough to keep researching, and what would change the view?"),
        "bull_bear_brief": brief.model_dump(mode="json", exclude_none=True),
        "context": dict(context),
    }
    runs.append(_timed(clock, "trade_setup_debate", lambda: adapter.debate_setup(setup)))
    debate: ResearchBrief = runs[-1].output
    if debate.ticker.strip().casefold() != ticker.casefold():
        raise ExternalResearchError(
            f"TradingAgents setup debate is for {debate.ticker!r}, not requested {ticker!r}.")
    return runs


def _source_refs(runs: Sequence[DeskRun]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    refs: list[dict[str, Any]] = []
    for run in runs:
        outputs = run.output if isinstance(run.output, list) else [run.output]
        for output in outputs:
            for ref in getattr(output, "source_refs", []):
                dumped = ref.model_dump(mode="json", exclude_none=True)
                key = json.dumps(dumped, sort_keys=True)
                if key not in seen:
                    seen.add(key)
                    refs.append({"desk": run.prompt_name, **dumped})
    return refs


def _usage(generator: OmpClaudeGenerator) -> dict[str, Any]:
    return {
        "llm_calls": len(generator.calls),
        "input_tokens": sum(c.input_tokens for c in generator.calls),
        "output_tokens": sum(c.output_tokens for c in generator.calls),
        "cost_usd": round(sum(c.cost_usd for c in generator.calls), 6),
    }


def _served(generator: OmpClaudeGenerator) -> list[str]:
    return sorted({c.model for c in generator.calls if c.model})


def build_dossier(*, ticker: str, as_of: date, run_key: str, context: Mapping[str, Any],
                  runs: Sequence[DeskRun], generator: OmpClaudeGenerator,
                  started_at: datetime, finished_at: datetime) -> dict[str, Any]:
    by_name = {c.name: c for c in generator.calls}
    desks = []
    for run in runs:
        contract = PROMPT_CONTRACTS[run.prompt_name]
        call = by_name.get(run.prompt_name)
        desks.append({
            "desk": DESK_NAMES[run.prompt_name],
            "prompt_name": run.prompt_name,
            "objective": contract.objective,
            "output_model": contract.output_model.__name__,
            "cardinality": contract.cardinality,
            "started_at": _iso(run.started_at),
            "duration_ms": run.duration_ms,
            "served_model": call.model if call else None,
            "input_tokens": call.input_tokens if call else 0,
            "output_tokens": call.output_tokens if call else 0,
            "output": _dump(run.output),
        })
    return {
        "schema": DOSSIER_SCHEMA,
        "research_only": True,
        "notice": NOTICE,
        "framework": FRAMEWORK,
        "framework_version": FRAMEWORK_VERSION,
        "run_key": run_key,
        "ticker": ticker,
        "as_of": as_of.isoformat(),
        "model": {"transport": "omp -p (OMP subscription)", "requested": generator.model,
                  "served": _served(generator), "thinking": generator.thinking},
        "started_at": _iso(started_at),
        "finished_at": _iso(finished_at),
        "duration_ms": int(round((finished_at - started_at).total_seconds() * 1000)),
        "context": redact_context(context),
        "desks": desks,
        "source_refs": _source_refs(runs),
        "usage": _usage(generator),
    }


def _desk(prompt_name: str) -> str:
    names: Mapping[str, str] = DESK_NAMES
    return names.get(prompt_name, prompt_name)[:64]


def _split_model(model: str) -> tuple[str, str]:
    provider, _, name = model.partition("/")
    return (provider, name) if name else ("anthropic", model)


def build_record_payload(*, ticker: str, as_of: date, run_key: str, generator: OmpClaudeGenerator,
                         runs: Sequence[DeskRun], started_at: datetime, finished_at: datetime,
                         caller_context: bool, error: str | None = None) -> dict[str, Any]:
    """``agentModelRuns.record`` body plus ``appendEvents`` events (runId comes from record)."""
    provider, model = _split_model(generator.model)
    usage = _usage(generator)
    record: dict[str, Any] = {
        "runKey": run_key,
        "framework": FRAMEWORK,
        "frameworkVersion": FRAMEWORK_VERSION,
        "provider": provider,
        "model": model,
        "modelsServed": [{"requested": model, "served": served} for served in _served(generator)][:16],
        "ticker": ticker,
        "decisionDate": as_of.isoformat(),
        "analysts": list(dict.fromkeys(
            [DESK_NAMES[r.prompt_name] for r in runs]
            + [_desk(c.name) for c in generator.calls]))[:16],
        "status": "failed" if error else "succeeded",
        "ratingSource": "missing",
        "flags": ["research_only"],
        "purpose": "live",
        "variant": f"thinking-{generator.thinking}",
        "memory": False,
        "dataSource": "caller_context" if caller_context else "none",
        "inputTokens": usage["input_tokens"],
        "outputTokens": usage["output_tokens"],
        "llmCalls": usage["llm_calls"],
        "toolCalls": 0,
        "costUsd": usage["cost_usd"],
        "durationMs": int(round((finished_at - started_at).total_seconds() * 1000)),
        "startedAt": _iso(started_at),
        "finishedAt": _iso(finished_at),
    }
    if error:
        record["error"] = error[:2000]
    events: list[dict[str, Any]] = []
    by_name = {c.name: c for c in generator.calls}
    for index, run in enumerate(runs):
        desk = DESK_NAMES[run.prompt_name]
        call = by_name.get(run.prompt_name)
        events.append({
            "seq": len(events), "at": _iso(run.started_at), "agent": desk, "kind": "llm_call",
            "title": run.prompt_name, "model": (call.model if call else None) or model,
            "inputTokens": call.input_tokens if call else 0,
            "outputTokens": call.output_tokens if call else 0,
            "costUsd": round(call.cost_usd, 6) if call else 0, "durationMs": run.duration_ms,
        })
        last = index == len(runs) - 1 and not error  # a failed run has no decision
        output = run.output
        if isinstance(output, ResearchBrief):
            title = f"{desk}: confidence {output.confidence:.2f} (research only)"
        else:
            title = f"{desk}: {len(output) if isinstance(output, list) else 1} result(s)"
        events.append({
            "seq": len(events), "agent": desk, "kind": "decision" if last else "message",
            "title": title[:300],
            "body": json.dumps(_dump(output), ensure_ascii=False)[:EVENT_BODY_MAX],
        })
    # A desk whose model call returned but whose output was refused (failed run): keep its call.
    finished = {r.prompt_name for r in runs}
    for call in generator.calls:
        if call.name in finished:
            continue
        events.append({
            "seq": len(events), "agent": _desk(call.name),
            "kind": "llm_call", "title": call.name[:300], "model": call.model or model,
            "inputTokens": call.input_tokens, "outputTokens": call.output_tokens,
            "costUsd": round(call.cost_usd, 6), "durationMs": int(round(call.latency_s * 1000)),
        })
    if error:
        events.append({"seq": len(events), "agent": FRAMEWORK, "kind": "status",
                       "title": "failed", "body": error[:EVENT_BODY_MAX]})
    events.append({"seq": len(events), "agent": FRAMEWORK, "kind": "flag", "title": "research_only"})
    return {"schema": RECORD_SCHEMA, "notice": NOTICE, "record": record,
            "appendEvents": {"runId": "<id from the record response>", "events": events}}


def assert_research_only(document: Any, label: str) -> None:
    """Last guard before a write: no order-like key anywhere in the document."""
    blocked = _order_keys(document)
    if blocked:
        raise ExternalResearchError(f"{label} has order fields {sorted(blocked)}; research only.")


def _write_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def record_path_for(out: Path) -> Path:
    return out.with_name(out.stem + ".record.json")


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m agents.tradingagents_cli",
        description="TradingAgents bull/bear brief and setup debate for one ticker (research only)")
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--as-of", required=True, type=date.fromisoformat, help="YYYY-MM-DD")
    parser.add_argument("--context", type=Path, help="JSON object with research context")
    parser.add_argument("--out", type=Path, help="dossier path (default private/research/tradingagents/)")
    parser.add_argument("--themes", action="store_true", help="run the theme discovery desk first")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--thinking", default="medium", choices=sorted(THINKING_LEVELS))
    parser.add_argument("--timeout-s", type=float, default=DEFAULT_TIMEOUT_S, help="per desk call")
    parser.add_argument("--omp", help="omp binary (default VERTEX_OMP_BIN or ~/.local/bin/omp)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, run: Runner | None = None,
         clock: Callable[[], float] = time.monotonic) -> int:
    """Exit 0 on success, 1 when a desk fails (failed record payload written), 2 on bad input."""
    args = parse_args(argv)
    try:
        ticker = normalise_ticker(args.ticker)
        caller = load_context(args.context)
        generator = OmpClaudeGenerator(
            model=args.model, thinking=args.thinking, timeout_s=args.timeout_s,
            omp_path=args.omp, **({"run": run} if run is not None else {}))
    except (CliError, ExternalResearchError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    out: Path = args.out or DEFAULT_OUT_DIR / f"{ticker}-{args.as_of.isoformat()}.json"
    record_out = record_path_for(out)
    context = build_context(ticker, args.as_of, caller)
    started_at = datetime.now(UTC)
    safe_ticker = re.sub(r"[^A-Za-z0-9._:-]", "-", ticker)
    run_key = f"ta-{safe_ticker}-{args.as_of.isoformat()}-{started_at.strftime('%Y%m%dT%H%M%S')}"
    adapter = TradingAgentsResearchAdapter(generator)
    runs: list[DeskRun] = []
    try:
        run_desks(adapter, ticker, context, with_themes=args.themes, clock=clock, runs=runs)
    except ExternalResearchError as exc:
        cause = f" ({exc.__cause__})" if exc.__cause__ else ""
        error = f"{exc}{cause}"
        payload = build_record_payload(
            ticker=ticker, as_of=args.as_of, run_key=run_key, generator=generator, runs=runs,
            started_at=started_at, finished_at=datetime.now(UTC), caller_context=bool(caller),
            error=error)
        assert_research_only(payload, "record payload")
        _write_json(record_out, payload)
        print(f"error: {error}", file=sys.stderr)
        print(json.dumps({"status": "failed", "record_payload": str(record_out)}))
        return 1
    finished_at = datetime.now(UTC)
    dossier = build_dossier(ticker=ticker, as_of=args.as_of, run_key=run_key, context=context,
                            runs=runs, generator=generator, started_at=started_at,
                            finished_at=finished_at)
    payload = build_record_payload(
        ticker=ticker, as_of=args.as_of, run_key=run_key, generator=generator, runs=runs,
        started_at=started_at, finished_at=finished_at, caller_context=bool(caller))
    assert_research_only(dossier, "dossier")
    assert_research_only(payload, "record payload")
    _write_json(out, dossier)
    _write_json(record_out, payload)
    print(json.dumps({
        "status": "succeeded", "run_key": run_key, "desks": [r.prompt_name for r in runs],
        "duration_ms": dossier["duration_ms"], "usage": dossier["usage"],
        "dossier": str(out), "record_payload": str(record_out),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
