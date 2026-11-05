"""AI Hedge Fund persona committee for one ticker over Claude through OMP. Research only.

Runs the investor personas of ``agents.hedgefund_committee`` (Buffett, Munger, Graham, Lynch,
Druckenmiller; adapted from AI Hedge Fund, MIT) in ONE ``OmpClaudeGenerator`` call and
writes two files:

- the dossier (``--out``): one typed view per persona (signal, confidence, reasoning, cited
  metrics, risks, missing evidence), a citation check against the supplied context, the
  committee summary (votes, agreement, net score, mapped five-tier rating), model ids, timing,
  usage and upstream provenance;
- the record payload (``<out stem>.record.json``): an ``agentModelRuns.record`` body with
  framework ``ai_hedge_fund`` (rating ``mapped`` from the committee net score) and the
  ``agentModelRuns.appendEvents`` events. This command sends nothing.

Context files (``--context``, repeatable) are caller-supplied research JSON objects, for
example Financial Datasets CLI output; each goes into the prompt under its file stem.
Account, credential and order-like keys are refused. The output never has order, size,
strike, expiry or price-level fields: the rating is a research label and can never
authorize, create or size a trade.

Usage (from ``services/research``)::

    python -m agents.hedgefund_committee_cli --ticker AAPL --as-of 2026-11-05 \
        --context aapl-company-facts.json --context aapl-financial-metrics.json \
        [--personas buffett,munger,graham,lynch,druckenmiller] [--thinking low] \
        [--out ../../private/research/hedgefund/AAPL-2026-11-05.json]

Without ``--out`` the files go to ``private/research/hedgefund/`` at the repository root
(git-ignored).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from agents.external_research import ExternalResearchError, redact_context
from agents.hedgefund_committee import (
    PERSONAS,
    PROMPT_NAME,
    UPSTREAM_COMMIT,
    UPSTREAM_REPO,
    CommitteeSummary,
    PersonaView,
    citation_check,
    parse_personas,
    run_committee,
    summarize,
)
from agents.omp_claude import (
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_S,
    THINKING_LEVELS,
    OmpClaudeGenerator,
    Runner,
)
from agents.tradingagents_cli import (
    CliError,
    _iso,
    _served,
    _split_model,
    _usage,
    _write_json,
    assert_research_only,
    load_context,
    normalise_ticker,
    record_path_for,
)

FRAMEWORK = "ai_hedge_fund"
# "+" marks a locally adjusted build (agent-model-runs.md): upstream personas, Vertex committee.
FRAMEWORK_VERSION = f"personas+{UPSTREAM_COMMIT[:7]}"
DOSSIER_SCHEMA = "vertex.ai_hedge_fund.committee.v1"
RECORD_SCHEMA = "vertex.agent_model_run.payload.v1"
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT_DIR = REPO_ROOT / "private" / "research" / "hedgefund"
MAX_CONTEXT_FILES = 8
EVENT_BODY_MAX = 16_000
COMMITTEE_AGENT = "AI Hedge Fund committee"
NOTICE = ("Research only. Stylized investor personas (not the actual individuals, not "
          "endorsements); the signals and the mapped rating never authorize, create or size an "
          "order and select no contract, strike, expiry or price level.")
_STEM = re.compile(r"[^a-z0-9_]+")


def load_contexts(paths: Sequence[Path]) -> dict[str, Any]:
    """Each context file under its sanitized file stem; account/secret/order keys refused."""
    if len(paths) > MAX_CONTEXT_FILES:
        raise CliError(f"At most {MAX_CONTEXT_FILES} context files.")
    merged: dict[str, Any] = {}
    for path in paths:
        stem = _STEM.sub("_", path.stem.casefold()).strip("_") or "context"
        if stem in merged:
            raise CliError(f"Two context files share the name {stem!r}.")
        try:
            merged[stem] = load_context(path)
        except CliError as exc:
            raise CliError(f"{path.name}: {exc}") from exc
    return merged


def build_context(ticker: str, as_of: date, caller: Mapping[str, Any]) -> dict[str, Any]:
    context: dict[str, Any] = {
        "ticker": ticker,
        "as_of": as_of.isoformat(),
        "data_note": ("Nothing was fetched for this run. Use only the supplied research context; "
                      "say when evidence is missing instead of inventing it."),
    }
    if caller:
        context["research_context"] = dict(caller)
    return context


def build_dossier(*, ticker: str, as_of: date, run_key: str, context: Mapping[str, Any],
                  persona_ids: Sequence[str], views: Sequence[PersonaView],
                  summary: CommitteeSummary, generator: OmpClaudeGenerator,
                  started_at: datetime, finished_at: datetime) -> dict[str, Any]:
    call = next((c for c in generator.calls if c.name == PROMPT_NAME), None)
    checks = citation_check(views, context)
    return {
        "schema": DOSSIER_SCHEMA,
        "research_only": True,
        "notice": NOTICE,
        "framework": FRAMEWORK,
        "framework_version": FRAMEWORK_VERSION,
        "provenance": {"upstream": UPSTREAM_REPO, "commit": UPSTREAM_COMMIT,
                       "adapted": "persona instructions only; MIT (AI_HEDGE_FUND_LICENSE.txt)"},
        "run_key": run_key,
        "ticker": ticker,
        "as_of": as_of.isoformat(),
        "model": {"transport": "omp -p (OMP subscription)", "requested": generator.model,
                  "served": _served(generator), "thinking": generator.thinking,
                  "calls": len(generator.calls)},
        "started_at": _iso(started_at),
        "finished_at": _iso(finished_at),
        "duration_ms": round((finished_at - started_at).total_seconds() * 1000),
        "model_latency_ms": round(call.latency_s * 1000) if call else None,
        "context": redact_context(context),
        "personas": [{
            "name": PERSONAS[view.persona].name,
            **view.model_dump(mode="json", exclude_none=True),
            "citation_check": checks[view.persona],
        } for view in views],
        "committee": summary.model_dump(mode="json"),
        "usage": _usage(generator),
    }


def build_record_payload(*, ticker: str, as_of: date, run_key: str, generator: OmpClaudeGenerator,
                         persona_ids: Sequence[str], views: Sequence[PersonaView],
                         summary: CommitteeSummary | None, started_at: datetime,
                         finished_at: datetime, caller_context: bool,
                         error: str | None = None) -> dict[str, Any]:
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
        "analysts": [PERSONAS[pid].name for pid in persona_ids][:16],
        "status": "failed" if error else "succeeded",
        "rating": summary.rating if summary and not error else None,
        "ratingSource": "mapped" if summary and not error else "missing",
        "flags": ["research_only", "single_call"],
        "purpose": "live",
        "variant": f"thinking-{generator.thinking}",
        "memory": False,
        "dataSource": "caller_context" if caller_context else "none",
        "inputTokens": usage["input_tokens"],
        "outputTokens": usage["output_tokens"],
        "llmCalls": usage["llm_calls"],
        "toolCalls": 0,
        "costUsd": usage["cost_usd"],
        "durationMs": round((finished_at - started_at).total_seconds() * 1000),
        "startedAt": _iso(started_at),
        "finishedAt": _iso(finished_at),
    }
    if error:
        record["error"] = error[:2000]
    events: list[dict[str, Any]] = []
    for call in generator.calls:
        events.append({
            "seq": len(events), "at": _iso(started_at), "agent": COMMITTEE_AGENT,
            "kind": "llm_call", "title": call.name, "model": call.model or model,
            "inputTokens": call.input_tokens, "outputTokens": call.output_tokens,
            "costUsd": round(call.cost_usd, 6), "durationMs": round(call.latency_s * 1000),
        })
    for view in views:
        name = PERSONAS[view.persona].name
        events.append({
            "seq": len(events), "agent": name, "kind": "message",
            "title": f"{name}: {view.signal} {view.confidence:.2f} (research only)"[:300],
            "body": json.dumps(view.model_dump(mode="json", exclude_none=True),
                               ensure_ascii=False)[:EVENT_BODY_MAX],
        })
    if summary and not error:
        votes = summary.votes
        events.append({
            "seq": len(events), "agent": COMMITTEE_AGENT, "kind": "decision",
            "title": (f"Committee: {votes['bullish']} bullish, {votes['neutral']} neutral, "
                      f"{votes['bearish']} bearish; {summary.rating} (mapped, research only)")[:300],
            "body": json.dumps(summary.model_dump(mode="json"), ensure_ascii=False)[:EVENT_BODY_MAX],
        })
    if error:
        events.append({"seq": len(events), "agent": FRAMEWORK, "kind": "status",
                       "title": "failed", "body": error[:EVENT_BODY_MAX]})
    events.append({"seq": len(events), "agent": FRAMEWORK, "kind": "flag", "title": "research_only"})
    return {"schema": RECORD_SCHEMA, "notice": NOTICE, "record": record,
            "appendEvents": {"runId": "<id from the record response>", "events": events}}


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m agents.hedgefund_committee_cli",
        description="AI Hedge Fund investor-persona committee for one ticker, one model call "
                    "(research only)")
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--as-of", required=True, type=date.fromisoformat, help="YYYY-MM-DD")
    parser.add_argument("--context", type=Path, action="append", default=[],
                        help="research JSON object (repeatable), e.g. Financial Datasets output")
    parser.add_argument("--personas", help=f"comma list from {','.join(PERSONAS)} (default all)")
    parser.add_argument("--out", type=Path, help="dossier path (default private/research/hedgefund/)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--thinking", default="medium", choices=sorted(THINKING_LEVELS))
    parser.add_argument("--timeout-s", type=float, default=DEFAULT_TIMEOUT_S)
    parser.add_argument("--omp", help="omp binary (default VERTEX_OMP_BIN or ~/.local/bin/omp)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None, *, run: Runner | None = None) -> int:
    """Exit 0 on success, 1 when the model call fails (failed record payload written), 2 on bad input."""
    args = parse_args(argv)
    try:
        ticker = normalise_ticker(args.ticker)
        persona_ids = parse_personas(args.personas)
        caller = load_contexts(args.context)
        generator = OmpClaudeGenerator(
            model=args.model, thinking=args.thinking, timeout_s=args.timeout_s,
            omp_path=args.omp, **({"run": run} if run is not None else {}))
    except (CliError, ValueError, ExternalResearchError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    out: Path = args.out or DEFAULT_OUT_DIR / f"{ticker}-{args.as_of.isoformat()}.json"
    record_out = record_path_for(out)
    context = build_context(ticker, args.as_of, caller)
    started_at = datetime.now(UTC)
    safe_ticker = re.sub(r"[^A-Za-z0-9._:-]", "-", ticker)
    run_key = f"aihf-{safe_ticker}-{args.as_of.isoformat()}-{started_at.strftime('%Y%m%dT%H%M%S')}"
    try:
        views = run_committee(generator, ticker, args.as_of.isoformat(), persona_ids, context)
    except ExternalResearchError as exc:
        cause = f" ({exc.__cause__})" if exc.__cause__ else ""
        error = f"{exc}{cause}"
        payload = build_record_payload(
            ticker=ticker, as_of=args.as_of, run_key=run_key, generator=generator,
            persona_ids=persona_ids, views=[], summary=None, started_at=started_at,
            finished_at=datetime.now(UTC), caller_context=bool(caller), error=error)
        assert_research_only(payload, "record payload")
        _write_json(record_out, payload)
        print(f"error: {error}", file=sys.stderr)
        print(json.dumps({"status": "failed", "record_payload": str(record_out)}))
        return 1
    finished_at = datetime.now(UTC)
    summary = summarize(views)
    dossier = build_dossier(ticker=ticker, as_of=args.as_of, run_key=run_key, context=context,
                            persona_ids=persona_ids, views=views, summary=summary,
                            generator=generator, started_at=started_at, finished_at=finished_at)
    payload = build_record_payload(
        ticker=ticker, as_of=args.as_of, run_key=run_key, generator=generator,
        persona_ids=persona_ids, views=views, summary=summary, started_at=started_at,
        finished_at=finished_at, caller_context=bool(caller))
    assert_research_only(dossier, "dossier")
    assert_research_only(payload, "record payload")
    _write_json(out, dossier)
    _write_json(record_out, payload)
    print(json.dumps({
        "status": "succeeded", "run_key": run_key,
        "signals": {v.persona: f"{v.signal} {v.confidence:.2f}" for v in views},
        "committee": {"votes": summary.votes, "agreement": summary.agreement,
                      "net_score": summary.net_score, "rating": summary.rating},
        "duration_ms": dossier["duration_ms"], "usage": dossier["usage"],
        "dossier": str(out), "record_payload": str(record_out),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
